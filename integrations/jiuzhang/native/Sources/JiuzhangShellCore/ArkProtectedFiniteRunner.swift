import Darwin
import Foundation

/// Reviewed App inputs, never supplied by a model or a Node operation.
public struct ArkProtectedFiniteBackendLaunch {
  public let executable: String
  public let arguments: [String]
  public let environment: [String: String]
  public let workingDirectory: URL
  public let apiToken: String
  public init(executable: String, arguments: [String], environment: [String: String], workingDirectory: URL, apiToken: String) {
    self.executable = executable; self.arguments = arguments; self.environment = environment
    self.workingDirectory = workingDirectory; self.apiToken = apiToken
  }
}

/// Default inactive. One ready guard survives the ordered slots. Actual retained
/// session bytes, not HTTP acknowledgements, decide capture eligibility in XPC.
@MainActor
public final class ArkProtectedFiniteRunner {
  public let guardProcess = ArkProtectedGuardProcess()
  public private(set) var guardURL: URL?
  private let backend: BackendProcess
  private let broker: ArkProtectedOwnerBroker
  private var guardPID: pid_t?
  private var guardGeneration: UUID?
  private var running = false
  public var intentionalSlotStop: ((UUID?) -> Void)?

  public init(backend: BackendProcess, broker: ArkProtectedOwnerBroker) { self.backend = backend; self.broker = broker }

  /// Bootstrap uses the existing guard hello and port0. Until XPC admission its
  /// admitProviderRequest refusal occurs before budget reserve and provider fetch.
  public func startGuard(_ launch: ArkProtectedGuardLaunch) async throws -> URL {
    guard !running, guardURL == nil, !backend.isRunning else { throw ArkProtectedOwnerError.rejected("Finite bootstrap is already active") }
    let result: URL
    do {
    result = try await withCheckedThrowingContinuation { continuation in
      let reply = FiniteReadyReply<URL>(continuation)
      guardProcess.onLine = { line in
        guard let url = URL(string: line), url.scheme == "http", url.host == "127.0.0.1", let port = url.port, port > 0,
          url.path.isEmpty, url.query == nil, url.fragment == nil else { return }
        reply.finish(.success(url))
      }
      guardProcess.onExit = { _ in reply.finish(.failure(ArkProtectedOwnerError.rejected("Guard exited before readiness"))) }
      do {
        try guardProcess.start(launch) { [broker, guardProcess] operation, payload in
          let generation = await MainActor.run { guardProcess.channelGeneration }
          return try await broker.perform(operation, payload: payload, origin: .guardProcess, channelGeneration: generation)
        }
      } catch { reply.finish(.failure(error)) }
      DispatchQueue.main.asyncAfter(deadline: .now() + 10) { reply.finish(.failure(ArkProtectedOwnerError.rejected("Guard readiness deadline exceeded"))) }
    }
    } catch {
      await withCheckedContinuation { continuation in guardProcess.stop { continuation.resume() } }
      throw error
    }
    guard guardProcess.isRunning, let pid = guardProcess.processIdentifier else { throw ArkProtectedOwnerError.rejected("Ready guard is no longer owned") }
    do { try Task.checkCancellation() }
    catch { await withCheckedContinuation { continuation in guardProcess.stop { continuation.resume() } }; throw error }
    guardURL = result; guardPID = pid; guardGeneration = guardProcess.generation
    return result
  }

  /// Signed intent provisioning follows actual guard readiness. This method takes
  /// the already pinned public intent; no production keys/config are synthesized.
  public func runRegisteredTrial(descriptor: ArkProtectedTrialDescriptor, evaluator: ArkProtectedEvaluator,
    launches: [ArkProtectedFiniteBackendLaunch]) async throws -> JSONValue {
    guard !running, let guardURL, guardProcess.isRunning, guardProcess.processIdentifier == guardPID,
      guardProcess.generation == guardGeneration else { throw ArkProtectedOwnerError.rejected("Finite guard ownership changed") }
    running = true
    let previousLineHandler = backend.onLine
    defer { running = false; intentionalSlotStop?(nil); backend.onLine = previousLineHandler }
    do {
    let (_, intent) = try evaluator.admissionIntent()
    guard let core = intent["core"], let slots = core["orderedSlots"]?.arrayValue,
      slots.count == launches.count, slots.map({ $0["sessionId"]?.stringValue }) == descriptor.sessionIDs.map(Optional.some),
      core["cost"]?["endpoint"] == .string(guardURL.absoluteString),
      launches.allSatisfy({ $0.workingDirectory.path == descriptor.projectRoot }),
      try await evaluator.intentDescriptor() == descriptor else {
      throw ArkProtectedOwnerError.rejected("Finite launch does not match reviewed intent and actual guard URL")
    }
    try broker.prepareFiniteTrial(descriptor, guardProcess: guardProcess)
    try await broker.admit(descriptor)
    for (slotIndex, slot) in slots.enumerated() {
      try Task.checkCancellation()
      guard guardProcess.isRunning, guardProcess.processIdentifier == guardPID, guardProcess.generation == guardGeneration else {
        throw ArkProtectedOwnerError.rejected("Finite guard changed between slots")
      }
      if slotIndex > 0 { try restoreInitialCode(core: core, slot: slot) }
      let launch = launches[slotIndex]
      let generation = UUID()
      let channel = try ArkNativeOwnerChannel(helloProvider: { [broker] in try await broker.launchHello() }, generation: generation) { [broker] operation, payload in
        try await broker.perform(operation, payload: payload, origin: .backend, channelGeneration: generation)
      }
      let url: URL = try await withCheckedThrowingContinuation { continuation in
        let ready = FiniteReadyReply<URL>(continuation)
        backend.onLine = { line in
          if let url = JiuzhangShellContract.readinessURL(from: line) { ready.finish(.success(url)) }
        }
        do {
          try backend.start(executable: launch.executable, arguments: launch.arguments, environment: launch.environment,
            workingDirectory: launch.workingDirectory, ownerChannel: channel)
          intentionalSlotStop?(backend.generation)
          try broker.prepareFiniteSlot(backend)
        } catch { channel.close(); ready.finish(.failure(error)) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 10) { ready.finish(.failure(ArkProtectedOwnerError.rejected("Backend readiness deadline exceeded"))) }
      }
      let sessionID = slot["sessionId"]!.stringValue!
      let taskRef = core["originalTaskUtf8Bytes"]!
      let task = try readBlob(taskRef, root: core["artifactRoot"]!.stringValue!)
      guard let text = String(data: task, encoding: .utf8), !text.isEmpty else { throw ArkProtectedOwnerError.rejected("Original task is not UTF8") }
      let api = ArkAPIClient(baseURL: url, apiToken: launch.apiToken)
      let interactions = ArkInteractionAPI(baseURL: url, apiToken: launch.apiToken)
      // Receipt means accepted only. Completion needs the target raw turn and
      // actual agent idle hint; the helper later verifies durable provenance.
      try await interactions.sendPrompt(sessionID: sessionID, text: text)
      let deadline = Date().addingTimeInterval(120)
      var complete = false
      while Date() < deadline {
        try Task.checkCancellation()
        let page = try await api.remoteDomainRequest(method: "session/history", request: ["sessionId": .string(sessionID), "view": .string("raw"), "maxMessages": .number(1000)])
        let ended = page["events"]?.arrayValue?.contains(where: {
          $0["event"]?["type"] == .string("turn/end") && $0["event"]?["data"]?["turn"] == slot["turn"]
        }) == true
        let idle = try await api.sessions().first(where: { $0.id == sessionID })?.running == false
        if ended && idle { complete = true; break }
        try await Task.sleep(nanoseconds: 50_000_000)
      }
      guard complete else { throw ArkProtectedOwnerError.rejected("Target task did not complete within its fixed deadline") }
      intentionalSlotStop?(backend.generation)
      await withCheckedContinuation { continuation in backend.stop { continuation.resume() } }
      let captured = try await broker.captureNextCompletedRegisteredSlot(descriptorHash: descriptor.descriptorHash)
      guard captured["status"] == .string("captured") else { throw ArkProtectedOwnerError.rejected("Completed slot durable capture remains incomplete") }
      intentionalSlotStop?(nil)
    }
    await withCheckedContinuation { continuation in guardProcess.stop { continuation.resume() } }
    return try await broker.freezeRegisteredTrial(descriptorHash: descriptor.descriptorHash)
    } catch {
      intentionalSlotStop?(backend.generation)
      await withCheckedContinuation { continuation in backend.stop { continuation.resume() } }
      await withCheckedContinuation { continuation in guardProcess.stop { continuation.resume() } }
      try? await broker.revoke(descriptor)
      throw error
    }
  }

  /// Launches the original offline producer directly; arbitrary descendants are
  /// excluded by its dedicated channel's kernel PID check.
  public func runFrozenProducer(_ launch: ArkProtectedEvaluatorConfiguration, completedLaunchHash: String) async throws -> JSONValue {
    guard !running, !backend.isRunning, !guardProcess.isRunning else { throw ArkProtectedOwnerError.rejected("Frozen producer requires joined model/guard children") }
    guard launch.nodeArguments.isEmpty, launch.sourceTSConfig == nil,
      launch.fileDigests[launch.configuration] == completedLaunchHash else { throw ArkProtectedOwnerError.rejected("Offline producer launch is not the frozen compiled entry") }
    try ArkProtectedRuntimePins.validate(root: launch.workingDirectory, node: launch.nodeExecutable, entry: launch.entryPoint,
      configuration: launch.configuration, pins: launch.fileDigests, helper: "knowledge-use-producer.mjs")
    let launchBytes = try ArkProtectedRuntimePins.read(launch.configuration, hash: completedLaunchHash)
    try ArkProtectedStrictJSON.validate(launchBytes)
    try ArkProtectedObservationSchema.validate(JSONDecoder().decode(JSONValue.self, from: launchBytes), named: "CompletedEvaluationLaunch")
    let generation = UUID()
    let channel = try ArkNativeOwnerChannel(helloProvider: { [broker] in try await broker.launchHello() },
      peerRole: .offlineProducer, generation: generation) { [broker] operation, payload in
        try ArkProtectedRuntimePins.validate(root: launch.workingDirectory, node: launch.nodeExecutable, entry: launch.entryPoint,
          configuration: launch.configuration, pins: launch.fileDigests, helper: "knowledge-use-producer.mjs")
        let value = try await broker.perform(operation, payload: payload, origin: .offlineProducer, channelGeneration: generation)
        try ArkProtectedRuntimePins.validate(root: launch.workingDirectory, node: launch.nodeExecutable, entry: launch.entryPoint,
          configuration: launch.configuration, pins: launch.fileDigests, helper: "knowledge-use-producer.mjs")
        return value
      }
    try broker.prepareFiniteProducer(channel, completedLaunchHash: completedLaunchHash)
    intentionalSlotStop?(nil)
    let previousExitHandler = backend.onExit, previousLineHandler = backend.onLine
    var resultLines: [String] = [], outputBytes = 0
    backend.onLine = { line in
      outputBytes += line.utf8.count
      if outputBytes <= ArkProtectedBytes.maximumFrame { resultLines.append(line) }
    }
    defer { backend.onExit = previousExitHandler; backend.onLine = previousLineHandler }
    do {
      try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
        let done = FiniteReadyReply<Void>(continuation)
        backend.onExit = { [backend] _ in
          guard let receipt = backend.joinedReceipt, receipt.channelGeneration == generation,
            receipt.exitedNormally, receipt.terminationStatus == 0, !receipt.forced else {
            done.finish(.failure(ArkProtectedOwnerError.rejected("Offline producer failed or did not normally join"))); return
          }
          done.finish(.success(()))
        }
        do {
          try backend.start(executable: launch.nodeExecutable.path, arguments: [launch.entryPoint.path, launch.configuration.path],
            environment: ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "en_US.UTF-8"],
            workingDirectory: launch.workingDirectory, ownerChannel: channel)
        } catch { channel.close(); done.finish(.failure(error)) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 125) { [backend] in
          guard backend.channelGeneration == generation else { return }
          backend.stop { done.finish(.failure(ArkProtectedOwnerError.rejected("Offline producer exceeded existing native deadline"))) }
        }
      }
      } onCancel: { [backend] in Task { @MainActor in backend.stop {} } }
      try Task.checkCancellation()
      guard outputBytes <= ArkProtectedBytes.maximumFrame, resultLines.count == 1 else {
        throw ArkProtectedOwnerError.rejected("Original producer did not return one bounded complete result")
      }
      let bytes = Data(resultLines[0].utf8); try ArkProtectedStrictJSON.validate(bytes)
      let value = try JSONDecoder().decode(JSONValue.self, from: bytes)
      guard let fields = value.objectValue, let status = fields["status"]?.stringValue,
        ["eligible", "ineligible", "rejected", "unknown"].contains(status),
        let hashes = fields["orderedUseReceiptHashes"]?.arrayValue, hashes.allSatisfy({ $0.stringValue.map(ArkProtectedBytes.hashIsValid) == true }),
        Set(hashes.compactMap(\.stringValue)).count == hashes.count else { throw ArkProtectedOwnerError.rejected("Original producer result shape differs") }
      if status == "unknown" {
        guard Set(fields.keys) == ["status", "reason", "orderedUseReceiptHashes"], hashes.isEmpty,
          ["no-unique-settled-cost-witness", "evaluator-owner-mismatch"].contains(fields["reason"]?.stringValue ?? "") else {
          throw ArkProtectedOwnerError.rejected("Original unknown producer result differs")
        }
      } else {
        guard fields["trialHash"]?.stringValue.map(ArkProtectedBytes.hashIsValid) == true,
          Set(fields.keys) == (status == "eligible" ? Set(["status", "trialHash", "orderedUseReceiptHashes"]) : Set(["status", "trialHash", "reason", "orderedUseReceiptHashes"])) else {
          throw ArkProtectedOwnerError.rejected("Original measured producer result differs")
        }
      }
      return value
    } catch {
      await withCheckedContinuation { continuation in backend.stop { continuation.resume() } }
      throw error
    }
  }

  private func readBlob(_ ref: JSONValue, root: String) throws -> Data {
    guard let hash = ref["hash"]?.stringValue, let count = ref["byteLength"]?.jsonSafeInteger(), count <= 2 * 1024 * 1024 else {
      throw ArkProtectedOwnerError.rejected("Finite original task/code reference differs")
    }
    let bytes = try ArkProtectedRuntimePins.read(URL(fileURLWithPath: root).appendingPathComponent(hash), hash: hash)
    guard bytes.count == count else { throw ArkProtectedOwnerError.rejected("Finite original blob length differs") }
    return bytes
  }
  private func restoreInitialCode(core: JSONValue, slot: JSONValue) throws {
    guard slot["taskDefinition"]?["kind"] == .string("pagination-v1") else { return }
    let task = slot["taskDefinition"]!
    let code = try readBlob(task["initialCodeBytes"]!, root: core["artifactRoot"]!.stringValue!)
    let path = task["codePath"]!.stringValue!
    let root = URL(fileURLWithPath: core["projectRoot"]!.stringValue!)
    let original = root.appendingPathComponent(path)
    var directory = Darwin.open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC)
    guard directory >= 0 else { throw ArkProtectedOwnerError.rejected("Cannot open initial code root") }
    defer { Darwin.close(directory) }
    let components = original.path.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
    guard !components.isEmpty, components.allSatisfy({ $0 != "." && $0 != ".." && !$0.contains("\\") && !$0.contains("\0") }) else {
      throw ArkProtectedOwnerError.rejected("Initial code path escapes declared root")
    }
    for component in components.dropLast() {
      let next = openat(directory, component, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
      guard next >= 0 else { throw ArkProtectedOwnerError.rejected("Initial code ancestor changed type") }
      Darwin.close(directory); directory = next
    }
    let file = openat(directory, components.last!, O_WRONLY | O_NOFOLLOW | O_CLOEXEC)
    guard file >= 0 else { throw ArkProtectedOwnerError.rejected("Initial code target changed type") }
    defer { Darwin.close(file) }
    var info = stat()
    guard fstat(file, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_nlink == 1, info.st_uid == getuid() else {
      throw ArkProtectedOwnerError.rejected("Initial code target is not an ordinary owned file")
    }
    guard ftruncate(file, 0) == 0 else { throw ArkProtectedOwnerError.rejected("Initial code reset failed") }
    try FileHandle(fileDescriptor: file, closeOnDealloc: false).write(contentsOf: code)
    guard fsync(file) == 0 else { throw ArkProtectedOwnerError.rejected("Initial code reset did not commit") }
  }
}

private final class FiniteReadyReply<Value>: @unchecked Sendable {
  private let lock = NSLock()
  private var continuation: CheckedContinuation<Value, Error>?
  init(_ continuation: CheckedContinuation<Value, Error>) { self.continuation = continuation }
  func finish(_ result: Result<Value, Error>) {
    lock.lock(); let selected = continuation; continuation = nil; lock.unlock(); selected?.resume(with: result)
  }
}
