@preconcurrency import Foundation
import Security
import Darwin

@objc(ArkProtectedOwnerProtocolV1)
public protocol ArkProtectedOwnerProtocol {
  func handshake(_ nonce: String, version: Int, reply: @escaping (String?, Int, Data?) -> Void)
  func perform(_ requestID: String, operation: String, origin: String, payload: Data, reply: @escaping (Data?, String?) -> Void)
  func shutdown(_ reply: @escaping () -> Void)
  func cancel(_ requestID: String)
  func captureNextCompletedRegisteredSlot(_ request: Data, reply: @escaping (Data?, String?) -> Void)
  func freezeRegisteredTrial(_ request: Data, reply: @escaping (Data?, String?) -> Void)
  func descriptors(_ reply: @escaping (Data?, String?) -> Void)
  func prepareConfirmation(_ descriptorHash: String, reply: @escaping (String?, String?) -> Void)
  func admit(_ descriptorHash: String, nonce: String, reply: @escaping (Bool, String?) -> Void)
  func revoke(_ descriptorHash: String, reply: @escaping (Bool, String?) -> Void)
}

/// Exact code requirement from the sealed embedded binary. This establishes the
/// connection peer, not user intent; intent still needs the local nonce/state.
public enum ArkProtectedPeerRequirement {
  public static func requirement(for bundle: URL) throws -> String {
    var code: SecStaticCode?
    guard SecStaticCodeCreateWithPath(bundle as CFURL, [], &code) == errSecSuccess, let code,
      SecStaticCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSStrictValidate), nil) == errSecSuccess else {
      throw ArkProtectedOwnerError.rejected("Protected peer bundle signature is unavailable")
    }
    var information: CFDictionary?
    guard SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &information) == errSecSuccess,
      let info = information as? [String: Any], let cdhash = info[kSecCodeInfoUnique as String] as? Data,
      !cdhash.isEmpty else { throw ArkProtectedOwnerError.rejected("Protected peer code identity is unavailable") }
    return "cdhash H\"\(cdhash.map { String(format: "%02x", $0) }.joined())\""
  }
}

/// App-local broker. The bootstrap sends only a random nonce/version. No typed
/// business operation is sent until the service passes its code requirement and
/// echoes that nonce. No model API has access to confirmation methods.
@MainActor
public final class ArkProtectedOwnerBroker {
  public static let serviceName = "com.ark.KnowledgeOwner"
  private var connection: NSXPCConnection?
  private var ready = false
  private var generation = UUID()
  private var pending: [UUID: () -> Void] = [:]
  private var finiteDescriptor: ArkProtectedTrialDescriptor?
  private var finiteSlotIndex = 0
  private var finiteBackend: BackendProcess?
  private var finiteBackendGeneration: UUID?
  private var finiteGuard: ArkProtectedGuardProcess?
  private var finiteGuardGeneration: UUID?
  private var finiteGuardPID: pid_t?
  private var finiteCompletedJoins: [BackendProcessJoinedLaunch] = []
  private var finiteProducerChannel: ArkNativeOwnerChannel?
  private var finiteLaunchHash: String?
  private var publicHello = ArkProtectedOwnerPublicBinding.disabledHello
  private var bootstrap: (id: UUID, task: Task<Void, Error>, connection: NSXPCConnection, reply: ArkProtectedXPCReply<Data>)?
  private let listenerEndpoint: NSXPCListenerEndpoint?
  private let fixtureRequirement: String?

  public init() { listenerEndpoint = nil; fixtureRequirement = nil }
  // A concrete local XPC endpoint exercises the same bootstrap in source tests.
  init(listenerEndpoint: NSXPCListenerEndpoint, peerRequirement: String) {
    self.listenerEndpoint = listenerEndpoint; fixtureRequirement = peerRequirement
  }

  public func close() {
    ready = false; generation = UUID(); publicHello = ArkProtectedOwnerPublicBinding.disabledHello
    bootstrap?.task.cancel()
    connection?.invalidate(); connection = nil
    failPending()
  }

  public func closeAndWait() async throws {
    let boot = bootstrap?.task
    guard ready, let connection else { close(); _ = try? await boot?.value; return }
    let reply = ArkProtectedXPCReply<Void>()
    defer { close() }
    guard let proxy = connection.remoteObjectProxyWithErrorHandler({ error in reply.finish(.failure(error)) }) as? ArkProtectedOwnerProtocol else {
      throw ArkProtectedOwnerError.rejected("Protected shutdown proxy unavailable")
    }
    try await withCheckedThrowingContinuation { continuation in
      reply.install(continuation)
      proxy.shutdown { reply.finish(.success(())) }
      DispatchQueue.global().asyncAfter(deadline: .now() + 8) {
        reply.finish(.failure(ArkProtectedOwnerError.rejected("Protected shutdown did not settle within its deadline")))
      }
    }
  }

  private func failPending() {
    let callbacks = Array(pending.values); pending.removeAll()
    callbacks.forEach { $0() }
  }

  private func proxy() async throws -> ArkProtectedOwnerProtocol {
    while !ready {
      try Task.checkCancellation()
      if let current = bootstrap {
        if current.id != generation {
          _ = try? await current.task.value
          if bootstrap?.id == current.id { bootstrap = nil }
          continue
        }
        let task = current.task, reply = current.reply
        try await withTaskCancellationHandler {
          try await task.value
        } onCancel: {
          task.cancel(); reply.finish(.failure(CancellationError()))
        }
        try Task.checkCancellation()
        continue
      }
      let service = Bundle.main.bundleURL.appendingPathComponent("Contents/XPCServices/ArkKnowledgeOwner.xpc")
      let requirement = try fixtureRequirement ?? ArkProtectedPeerRequirement.requirement(for: service)
      let connection = listenerEndpoint.map { NSXPCConnection(listenerEndpoint: $0) }
        ?? NSXPCConnection(serviceName: Self.serviceName)
      connection.setCodeSigningRequirement(requirement)
      connection.remoteObjectInterface = NSXPCInterface(with: ArkProtectedOwnerProtocol.self)
      let identity = UUID(), reply = ArkProtectedXPCReply<Data>()
      generation = identity; self.connection = connection
      connection.invalidationHandler = { [weak self] in Task { @MainActor in
        guard self?.generation == identity else { return }
        self?.ready = false; self?.connection = nil
        self?.publicHello = ArkProtectedOwnerPublicBinding.disabledHello
        self?.bootstrap?.task.cancel(); self?.failPending()
      } }
      connection.interruptionHandler = { connection.invalidate() }
      pending[identity] = { reply.finish(.failure(ArkProtectedOwnerError.rejected("Protected bootstrap connection closed"))) }
      connection.resume()
      let task = Task { @MainActor in
        defer {
          self.pending.removeValue(forKey: identity)
          if self.bootstrap?.id == identity { self.bootstrap = nil }
        }
        do {
        let nonce = UUID().uuidString + UUID().uuidString
        guard let proxy = connection.remoteObjectProxyWithErrorHandler({ error in reply.finish(.failure(error)) }) as? ArkProtectedOwnerProtocol else {
          throw ArkProtectedOwnerError.rejected("Protected owner proxy is unavailable")
        }
        let bytes: Data = try await withCheckedThrowingContinuation { continuation in
          reply.install(continuation)
          proxy.handshake(nonce, version: 1) { received, version, metadata in
            guard received == nonce, version == 1, let metadata else {
              reply.finish(.failure(ArkProtectedOwnerError.rejected("Protected owner bootstrap metadata differs"))); return
            }
            reply.finish(.success(metadata))
          }
          DispatchQueue.global().asyncAfter(deadline: .now() + 5) {
            reply.finish(.failure(ArkProtectedOwnerError.rejected("Protected owner bootstrap timed out")))
          }
        }
        try Task.checkCancellation()
        let hello = try ArkProtectedOwnerPublicBinding.validateHello(bytes)
        guard self.generation == identity, self.connection === connection else {
          throw ArkProtectedOwnerError.rejected("Protected owner generation changed during bootstrap")
        }
        self.publicHello = hello; self.ready = true
        } catch {
          if self.generation == identity, self.connection === connection {
            self.ready = false; self.connection = nil; self.publicHello = ArkProtectedOwnerPublicBinding.disabledHello
          }
          connection.invalidate()
          throw error
        }
      }
      bootstrap = (identity, task, connection, reply)
    }
    try Task.checkCancellation()
    guard let connection,
      let proxy = connection.remoteObjectProxyWithErrorHandler({ _ in }) as? ArkProtectedOwnerProtocol else {
      throw ArkProtectedOwnerError.rejected("Protected owner connection is unavailable")
    }
    return proxy
  }

  public func launchHello() async throws -> JSONValue {
    _ = try await proxy()
    try Task.checkCancellation()
    return publicHello
  }

  private func call<Value>(cancellationID: String? = nil, _ body: (ArkProtectedOwnerProtocol, ArkProtectedXPCReply<Value>) -> Void) async throws -> Value {
    _ = try await proxy()
    guard let connection else { throw ArkProtectedOwnerError.rejected("Protected connection is closed") }
    let id = UUID()
    let reply = ArkProtectedXPCReply<Value>()
    pending[id] = { reply.finish(.failure(ArkProtectedOwnerError.rejected("Protected connection closed before settlement"))) }
    defer { pending.removeValue(forKey: id) }
    guard let proxy = connection.remoteObjectProxyWithErrorHandler({ error in reply.finish(.failure(error)) }) as? ArkProtectedOwnerProtocol else {
      throw ArkProtectedOwnerError.rejected("Protected owner proxy is unavailable")
    }
    try Task.checkCancellation()
    return try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        reply.install(continuation)
        body(proxy, reply)
        DispatchQueue.global().asyncAfter(deadline: .now() + 130) {
          if reply.finish(.failure(ArkProtectedOwnerError.rejected("Protected owner response deadline exceeded"))) { connection.invalidate() }
        }
      }
    } onCancel: {
      if let cancellationID { proxy.cancel(cancellationID) }
    }
  }

  public func perform(_ operation: ArkProtectedOperation, payload: JSONValue, origin: ArkProtectedPeerRole = .backend, channelGeneration: UUID? = nil) async throws -> JSONValue {
    if finiteDescriptor != nil {
      switch origin {
      case .guardProcess:
        guard channelGeneration == finiteGuard?.channelGeneration, finiteGuard?.generation == finiteGuardGeneration,
          finiteGuard?.processIdentifier == finiteGuardPID, finiteGuard?.isRunning == true, finiteLaunchHash == nil else {
          throw ArkProtectedOwnerError.rejected("Finite guard ownership changed")
        }
      case .backend:
        guard channelGeneration == finiteBackend?.channelGeneration, finiteBackend?.generation == finiteBackendGeneration,
          finiteBackend?.isRunning == true, finiteLaunchHash == nil else { throw ArkProtectedOwnerError.rejected("Finite backend ownership changed") }
      case .offlineProducer:
        guard channelGeneration != nil, channelGeneration == finiteProducerChannel?.generation, finiteLaunchHash != nil else {
          throw ArkProtectedOwnerError.rejected("Finite offline producer channel differs")
        }
      }
    }
    let id = UUID().uuidString
    let bytes = try ArkProtectedBytes.encode(payload)
    guard bytes.count <= ArkProtectedBytes.maximumFrame else { throw ArkProtectedOwnerError.rejected("Protected request exceeds limit") }
    let result: Data = try await call(cancellationID: id) { proxy, reply in
      proxy.perform(id, operation: operation.rawValue, origin: origin.rawValue, payload: bytes) { bytes, error in
        if let bytes { reply.finish(.success(bytes)) }
        else { reply.finish(.failure(ArkProtectedOwnerError.rejected(error ?? "Protected owner failed"))) }
      }
    }
    try Task.checkCancellation()
    guard result.count <= ArkProtectedBytes.maximumFrame else { throw ArkProtectedOwnerError.rejected("Protected reply exceeds limit") }
    return try JSONDecoder().decode(JSONValue.self, from: result)
  }

  public func reviewSnapshot() async throws -> ArkProtectedOwnerReviewSnapshotV2 {
    let bytes: Data = try await call { proxy, reply in
      proxy.descriptors { bytes, error in
        if let bytes { reply.finish(.success(bytes)) }
        else { reply.finish(.failure(ArkProtectedOwnerError.rejected(error ?? "Owner descriptors unavailable"))) }
      }
    }
    guard bytes.count <= ArkProtectedBytes.maximumFrame else { throw ArkProtectedOwnerError.rejected("Owner descriptors exceed limit") }
    try ArkProtectedStrictJSON.validate(bytes)
    try ArkProtectedObservationSchema.validate(JSONDecoder().decode(JSONValue.self, from: bytes), named: "OwnerReviewSnapshotV2")
    return try JSONDecoder().decode(ArkProtectedOwnerReviewSnapshotV2.self, from: bytes)
  }

  /// Called only with the actual already-ready owned guard; readiness grants no authority.
  public func prepareFiniteTrial(_ descriptor: ArkProtectedTrialDescriptor, guardProcess: ArkProtectedGuardProcess) throws {
    guard finiteDescriptor == nil, guardProcess.isRunning, guardProcess.processIdentifier != nil, guardProcess.channelGeneration != nil, guardProcess.readyURL != nil else {
      throw ArkProtectedOwnerError.rejected("Finite guard must be an actual ready owned launch")
    }
    try descriptor.validate()
    finiteDescriptor = descriptor; finiteGuard = guardProcess; finiteGuardGeneration = guardProcess.generation
    finiteGuardPID = guardProcess.processIdentifier
  }
  public func prepareFiniteSlot(_ backend: BackendProcess) throws {
    guard let descriptor = finiteDescriptor, finiteBackend == nil, finiteSlotIndex < descriptor.sessionIDs.count,
      backend.isRunning, backend.channelGeneration != nil,
      !finiteCompletedJoins.contains(where: { $0.generation == backend.generation || $0.channelGeneration == backend.channelGeneration }) else {
      throw ArkProtectedOwnerError.rejected("Finite slot requires a fresh owned backend")
    }
    finiteBackend = backend; finiteBackendGeneration = backend.generation
  }
  public func prepareFiniteProducer(_ channel: ArkNativeOwnerChannel, completedLaunchHash: String) throws {
    guard channel.role == .offlineProducer, finiteProducerChannel == nil, finiteLaunchHash == completedLaunchHash,
      !finiteCompletedJoins.contains(where: { $0.channelGeneration == channel.generation }) else {
      throw ArkProtectedOwnerError.rejected("Finite producer requires a fresh exact launch channel")
    }
    finiteProducerChannel = channel
  }

  public func descriptors() async throws -> [ArkProtectedTrialReview] { try await reviewSnapshot().reviews }

  public func captureNextCompletedRegisteredSlot(descriptorHash: String) async throws -> JSONValue {
    guard let descriptor = finiteDescriptor, descriptor.descriptorHash == descriptorHash,
      finiteSlotIndex < descriptor.sessionIDs.count, let backend = finiteBackend, backend.generation == finiteBackendGeneration,
      let receipt = backend.joinedReceipt, receipt.exitedNormally, receipt.terminationStatus == 0, !receipt.forced,
      receipt.channelGeneration != nil, !finiteCompletedJoins.contains(where: { $0.generation == receipt.generation || $0.channelGeneration == receipt.channelGeneration }) else {
      throw ArkProtectedOwnerError.rejected("Finite App slot did not normally reap and settle")
    }
    guard let revision = try await reviewSnapshot().ownerRevision else { throw ArkProtectedOwnerError.rejected("Observation owner is disabled") }
    let bytes = try ArkProtectedBytes.encode(JSONValue.object(["schemaVersion": .number(1), "operation": .string("captureNextCompletedRegisteredSlot"),
      "descriptorHash": .string(descriptorHash), "expectedOwnerRevision": .number(Double(revision))]))
    let result: Data = try await call { proxy, reply in
      proxy.captureNextCompletedRegisteredSlot(bytes) { value, error in
        if let value { reply.finish(.success(value)) } else { reply.finish(.failure(ArkProtectedOwnerError.rejected(error ?? "Capture refused"))) }
      }
    }
    try ArkProtectedStrictJSON.validate(result)
    let value = try JSONDecoder().decode(JSONValue.self, from: result)
    try ArkProtectedObservationSchema.validate(value, named: "CaptureNextResponse")
    guard value["slotIndex"] == .number(Double(finiteSlotIndex)), value["descriptorHash"] == .string(descriptorHash),
      value["status"] == .string("captured") || value["status"] == .string("incomplete") else {
      throw ArkProtectedOwnerError.rejected("Finite App slot capture was not committed")
    }
    finiteCompletedJoins.append(receipt); finiteSlotIndex += 1; finiteBackend = nil; finiteBackendGeneration = nil
    return value
  }
  public func freezeRegisteredTrial(descriptorHash: String) async throws -> JSONValue {
    guard let descriptor = finiteDescriptor, descriptor.descriptorHash == descriptorHash,
      finiteSlotIndex == descriptor.sessionIDs.count, finiteCompletedJoins.count == descriptor.sessionIDs.count,
      finiteBackend == nil, let guardProcess = finiteGuard, guardProcess.generation == finiteGuardGeneration,
      let receipt = guardProcess.joinedReceipt, receipt.processIdentifier == finiteGuardPID,
      receipt.exitedNormally, receipt.terminationStatus == 0, !receipt.forced, finiteLaunchHash == nil else {
      throw ArkProtectedOwnerError.rejected("All finite App children and guard must normally join")
    }
    guard let revision = try await reviewSnapshot().ownerRevision else { throw ArkProtectedOwnerError.rejected("Observation owner is disabled") }
    let bytes = try ArkProtectedBytes.encode(JSONValue.object(["schemaVersion": .number(1), "operation": .string("freezeRegisteredTrial"),
      "descriptorHash": .string(descriptorHash), "expectedOwnerRevision": .number(Double(revision))]))
    let result: Data = try await call { proxy, reply in
      proxy.freezeRegisteredTrial(bytes) { value, error in
        if let value { reply.finish(.success(value)) } else { reply.finish(.failure(ArkProtectedOwnerError.rejected(error ?? "Freeze refused"))) }
      }
    }
    try ArkProtectedStrictJSON.validate(result)
    let value = try JSONDecoder().decode(JSONValue.self, from: result)
    try ArkProtectedObservationSchema.validate(value, named: "FreezeResponse")
    if value["status"] == .string("frozen") { finiteLaunchHash = value["completedLaunchHash"]?.stringValue }
    return value
  }

  public func admit(_ descriptor: ArkProtectedTrialDescriptor) async throws {
    let nonce: String = try await call { proxy, reply in
      proxy.prepareConfirmation(descriptor.descriptorHash) { nonce, error in
        if let nonce { reply.finish(.success(nonce)) }
        else { reply.finish(.failure(ArkProtectedOwnerError.rejected(error ?? "Owner confirmation unavailable"))) }
      }
    }
    try Task.checkCancellation()
    let _: Bool = try await call { proxy, reply in
      proxy.admit(descriptor.descriptorHash, nonce: nonce) { ok, error in
        if ok { reply.finish(.success(true)) }
        else { reply.finish(.failure(ArkProtectedOwnerError.rejected(error ?? "Owner refused trial admission"))) }
      }
    }
  }

  public func revoke(_ descriptor: ArkProtectedTrialDescriptor) async throws {
    let _: Bool = try await call { proxy, reply in
      proxy.revoke(descriptor.descriptorHash) { ok, error in
        if ok { reply.finish(.success(true)) }
        else { reply.finish(.failure(ArkProtectedOwnerError.rejected(error ?? "Owner refused trial revocation"))) }
      }
    }
  }

}

private final class ArkProtectedXPCReply<Value>: @unchecked Sendable {
  private let lock = NSLock()
  private var continuation: CheckedContinuation<Value, Error>?
  private var result: Result<Value, Error>?
  func install(_ value: CheckedContinuation<Value, Error>) {
    lock.lock()
    if let result { lock.unlock(); value.resume(with: result) }
    else { continuation = value; lock.unlock() }
  }
  @discardableResult func finish(_ value: Result<Value, Error>) -> Bool {
    lock.lock()
    guard result == nil else { lock.unlock(); return false }
    result = value; let pending = continuation; continuation = nil
    lock.unlock(); pending?.resume(with: value); return true
  }
}

/// Per-connection service object. The production target supplies no authority;
/// source contracts exercise the same methods with ephemeral test-only owners.
public final class ArkProtectedOwnerService: NSObject, ArkProtectedOwnerProtocol, @unchecked Sendable {
  private let owner: ArkProtectedOwner?
  private let lock = NSLock()
  private enum BootstrapPhase { case fresh, pending, ready, disabled, closed }
  private var bootstrapPhase = BootstrapPhase.fresh
  private var active: (String, Task<Void, Never>)?
  private var cancelledIDs = Set<String>()
  private var controlTasks: [UUID: Task<Void, Never>] = [:]
  public init(owner: ArkProtectedOwner? = nil) { self.owner = owner }

  public func handshake(_ nonce: String, version: Int, reply: @escaping (String?, Int, Data?) -> Void) {
    lock.lock()
    guard bootstrapPhase == .fresh, version == 1, (32...128).contains(nonce.count) else {
      lock.unlock(); reply(nil, 0, nil); return
    }
    bootstrapPhase = .pending
    lock.unlock()
    control(bootstrap: true) {
      do {
        let hello = try await self.owner?.launchHello() ?? ArkProtectedOwnerPublicBinding.disabledHello
        try Task.checkCancellation()
        let bytes = try ArkProtectedBytes.encode(hello)
        let accepted = self.lock.withLock {
          guard self.bootstrapPhase == .pending else { return false }
          self.bootstrapPhase = hello["ownerStatus"] == .string("ready") ? .ready : .disabled; return true
        }
        guard accepted else { reply(nil, 0, nil); return }
        reply(nonce, 1, bytes)
      } catch {
        self.lock.withLock { if self.bootstrapPhase == .pending { self.bootstrapPhase = .closed } }
        reply(nil, 0, nil)
      }
    }
  }

  private func admittedConnection() -> Bool { lock.lock(); defer { lock.unlock() }; return bootstrapPhase == .ready }
  public func disconnect() {
    lock.lock(); bootstrapPhase = .closed; let tasks = Array(controlTasks.values) + (active.map { [$0.1] } ?? []); lock.unlock()
    tasks.forEach { $0.cancel() }
  }

  public func shutdown(_ reply: @escaping () -> Void) {
    lock.lock(); bootstrapPhase = .closed; let tasks = Array(controlTasks.values) + (active.map { [$0.1] } ?? []); lock.unlock()
    tasks.forEach { $0.cancel() }
    Task { for task in tasks { await task.value }; reply() }
  }

  public func perform(_ requestID: String, operation: String, origin: String, payload: Data, reply: @escaping (Data?, String?) -> Void) {
    guard admittedConnection(), let owner, let operation = ArkProtectedOperation(rawValue: operation),
      let origin = ArkProtectedPeerRole(rawValue: origin), origin.permits(operation),
      !requestID.isEmpty, requestID.count <= 200, payload.count <= ArkProtectedBytes.maximumFrame else {
      reply(nil, "Protected authority is disabled or the operation is invalid"); return
    }
    lock.lock()
    guard bootstrapPhase == .ready, active == nil, !cancelledIDs.contains(requestID) else { lock.unlock(); reply(nil, "Protected request is already active or cancelled"); return }
    let task = Task { [weak self] in
      do {
        try Task.checkCancellation()
        let value = try JSONDecoder().decode(JSONValue.self, from: payload)
        try Task.checkCancellation()
        let result = try await owner.perform(operation, payload: value, origin: origin, trustedAppControl: true)
        try Task.checkCancellation()
        let bytes = try ArkProtectedBytes.encode(result)
        self?.clear(requestID)
        reply(bytes, nil)
      } catch { self?.clear(requestID); reply(nil, error.localizedDescription) }
    }
    active = (requestID, task)
    lock.unlock()
  }

  private func clear(_ id: String) { lock.lock(); if active?.0 == id { active = nil }; lock.unlock() }
  public func cancel(_ requestID: String) {
    lock.lock()
    if cancelledIDs.count < 4096 { cancelledIDs.insert(requestID) } else { bootstrapPhase = .closed }
    let task = active?.0 == requestID ? active?.1 : nil
    lock.unlock(); task?.cancel()
  }

  private func control(bootstrap: Bool = false, _ body: @escaping @Sendable () async -> Void) {
    lock.lock()
    let id = UUID()
    let task = Task { [weak self] in
      self?.lock.withLock {}
      await body()
      self?.finishControl(id)
    }
    controlTasks[id] = task
    if bootstrapPhase != .ready && !(bootstrap && bootstrapPhase == .pending) { task.cancel() }
    lock.unlock()
  }
  private func finishControl(_ id: UUID) { lock.lock(); controlTasks.removeValue(forKey: id); lock.unlock() }

  public func descriptors(_ reply: @escaping (Data?, String?) -> Void) {
    if lock.withLock({ bootstrapPhase == .disabled }) {
      reply(try? ArkProtectedOwnerReviewSnapshotV2(ownerRevision: nil, reviews: []).encode(), nil); return
    }
    guard admittedConnection() else { reply(nil, "Handshake required"); return }
    control {
      do { try Task.checkCancellation(); reply(try await self.owner?.reviewSnapshot().encode() ?? ArkProtectedOwnerReviewSnapshotV2(ownerRevision: nil, reviews: []).encode(), nil) }
      catch { reply(nil, error.localizedDescription) }
    }
  }
  public func captureNextCompletedRegisteredSlot(_ request: Data, reply: @escaping (Data?, String?) -> Void) {
    guard admittedConnection(), let owner else { reply(nil, "Protected authority is disabled"); return }
    control {
      do { try Task.checkCancellation(); reply(try await owner.captureNextCompletedRegisteredSlot(request, trustedAppControl: true), nil) }
      catch { reply(nil, error.localizedDescription) }
    }
  }
  public func freezeRegisteredTrial(_ request: Data, reply: @escaping (Data?, String?) -> Void) {
    guard admittedConnection(), let owner else { reply(nil, "Protected authority is disabled"); return }
    control {
      do { try Task.checkCancellation(); reply(try await owner.freezeRegisteredTrial(request, trustedAppControl: true), nil) }
      catch { reply(nil, error.localizedDescription) }
    }
  }
  public func prepareConfirmation(_ descriptorHash: String, reply: @escaping (String?, String?) -> Void) {
    guard admittedConnection(), let owner else { reply(nil, "Protected authority is disabled"); return }
    control { do { try Task.checkCancellation(); reply(try await owner.prepareConfirmation(descriptorHash: descriptorHash), nil) } catch { reply(nil, error.localizedDescription) } }
  }
  public func admit(_ descriptorHash: String, nonce: String, reply: @escaping (Bool, String?) -> Void) {
    guard admittedConnection(), let owner else { reply(false, "Protected authority is disabled"); return }
    control { do { try Task.checkCancellation(); try await owner.admit(descriptorHash: descriptorHash, nonce: nonce); reply(true, nil) } catch { reply(false, error.localizedDescription) } }
  }
  public func revoke(_ descriptorHash: String, reply: @escaping (Bool, String?) -> Void) {
    guard admittedConnection(), let owner else { reply(false, "Protected authority is disabled"); return }
    control { do { try Task.checkCancellation(); try await owner.revoke(descriptorHash: descriptorHash); reply(true, nil) } catch { reply(false, error.localizedDescription) } }
  }
}
