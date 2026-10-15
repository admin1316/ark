import Darwin
import Foundation

/// One App-owned local socket per launcher generation. Its token authenticates
/// the launch only; business admission belongs exclusively to the protected owner.
public final class ArkNativeOwnerChannel: @unchecked Sendable {
  public typealias Handler = @Sendable (ArkProtectedOperation, JSONValue) async throws -> JSONValue
  private let lock = NSLock()
  private let io = DispatchQueue(label: "ark.native-owner.socket", qos: .utility)
  private let directory: URL
  public let socketPath: String
  public let launchToken = UUID().uuidString + UUID().uuidString
  public let generation: UUID
  private var listener: Int32 = -1
  private var peer: Int32 = -1
  private var source: DispatchSourceRead?
  private var peerSource: DispatchSourceRead?
  private var launcherPID: pid_t?
  private var launcherStarted: timeval?
  private var authenticated = false
  private var input = Data()
  private var active: (String, Task<Void, Never>)?
  private var closed = false
  private var closeCompleted = false
  private var closeCompletions: [@Sendable () -> Void] = []
  private let helloProvider: @Sendable () async throws -> JSONValue
  private let handler: Handler
  private let peerRole: ArkProtectedPeerRole
  public var role: ArkProtectedPeerRole { peerRole }

  public init(hello: JSONValue = .object(["version": .number(1), "ok": .bool(true),
    "ownerStatus": .string("disabled"), "authorities": .array([])]),
    helloProvider: (@Sendable () async throws -> JSONValue)? = nil,
    peerRole: ArkProtectedPeerRole = .backend, generation: UUID = UUID(), handler: @escaping Handler) throws {
    self.generation = generation
    self.helloProvider = helloProvider ?? { hello }; self.handler = handler; self.peerRole = peerRole
    directory = URL(fileURLWithPath: "/private/tmp").appendingPathComponent("ark-owner-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    socketPath = directory.appendingPathComponent("owner.sock").path
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    let encoded = Array(socketPath.utf8) + [0]
    guard encoded.count <= MemoryLayout.size(ofValue: address.sun_path) else {
      try? FileManager.default.removeItem(at: directory)
      throw ArkProtectedOwnerError.rejected("Private socket path exceeds AF_UNIX limit")
    }
    withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: encoded) }
    let socket = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
    guard socket >= 0 else { try? FileManager.default.removeItem(at: directory); throw ArkProtectedOwnerError.rejected("Cannot create private socket") }
    listener = socket
    _ = fcntl(socket, F_SETFD, FD_CLOEXEC)
    _ = fcntl(socket, F_SETFL, O_NONBLOCK)
    var noSignal: Int32 = 1
    setsockopt(socket, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout<Int32>.size))
    let bound = withUnsafePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(socket, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
    }
    guard bound == 0, chmod(socketPath, 0o600) == 0, Darwin.listen(socket, 1) == 0 else {
      Darwin.close(socket); listener = -1
      try? FileManager.default.removeItem(at: directory)
      throw ArkProtectedOwnerError.rejected("Cannot bind private owner socket")
    }
    let reader = DispatchSource.makeReadSource(fileDescriptor: socket, queue: io)
    source = reader
    reader.setEventHandler { [weak self] in self?.acceptPeer() }
    reader.resume()
  }

  public var environment: [String: String] {
    ["ARK_NATIVE_OWNER_SOCKET_PATH": socketPath, "ARK_NATIVE_OWNER_LAUNCH_TOKEN": launchToken]
  }

  /// Called synchronously after Process.run. Read handlers wait until this exact
  /// launch is bound. Peer PID is obtained from the kernel, never from JSON.
  public func bindLauncher(_ process: Process) {
    lock.lock(); defer { lock.unlock() }
    launcherPID = process.processIdentifier
    launcherStarted = Self.processInfo(process.processIdentifier)?.kp_proc.p_starttime
  }

  /// Completion proves both socket teardown and the owned handler's settlement.
  /// Cancellation alone never releases the launcher's ownership slot.
  public func close(completion: (@Sendable () -> Void)? = nil) {
    lock.lock()
    if closeCompleted { lock.unlock(); completion?(); return }
    if let completion { closeCompletions.append(completion) }
    guard !closed else { lock.unlock(); return }
    closed = true
    let task = active?.1
    lock.unlock()
    task?.cancel()
    io.async { [self] in
      source?.cancel(); source = nil; peerSource?.cancel(); peerSource = nil
      if peer >= 0 { Darwin.shutdown(peer, SHUT_RDWR); Darwin.close(peer); peer = -1 }
      if listener >= 0 { Darwin.close(listener); listener = -1 }
      try? FileManager.default.removeItem(at: directory)
      Task { [self] in
        await task?.value
        self.io.async { [self] in
          lock.lock()
          active = nil; closeCompleted = true
          let completions = closeCompletions; closeCompletions.removeAll()
          lock.unlock()
          completions.forEach { $0() }
        }
      }
    }
  }

  deinit {
    source?.cancel(); peerSource?.cancel()
    if peer >= 0 { Darwin.close(peer) }
    if listener >= 0 { Darwin.close(listener) }
    try? FileManager.default.removeItem(at: directory)
  }

  private func acceptPeer() {
    guard listener >= 0 else { return }
    let socket = Darwin.accept(listener, nil, nil)
    guard socket >= 0 else { return }
    lock.lock(); let ended = closed; lock.unlock()
    guard !ended, peer < 0 else { Darwin.close(socket); return }
    var pid: pid_t = 0
    var size = socklen_t(MemoryLayout<pid_t>.size)
    guard getsockopt(socket, SOL_LOCAL, LOCAL_PEERPID, &pid, &size) == 0, isOwnedPeer(pid) else {
      Darwin.close(socket); return
    }
    peer = socket
    _ = fcntl(socket, F_SETFD, FD_CLOEXEC)
    _ = fcntl(socket, F_SETFL, O_NONBLOCK)
    var noSignal: Int32 = 1
    setsockopt(socket, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout<Int32>.size))
    let reader = DispatchSource.makeReadSource(fileDescriptor: socket, queue: io)
    peerSource = reader
    reader.setEventHandler { [weak self] in self?.readPeer() }
    reader.resume()
  }

  private func isOwnedPeer(_ pid: pid_t) -> Bool {
    lock.lock(); let parent = launcherPID; let started = launcherStarted; lock.unlock()
    guard let parent, let started, let live = Self.processInfo(parent),
      live.kp_proc.p_starttime.tv_sec == started.tv_sec,
      live.kp_proc.p_starttime.tv_usec == started.tv_usec else { return false }
    // start.mjs owns exactly one direct runner child. Arbitrary descendants such
    // as model tools are excluded even when they inherited the launch token.
    guard let candidate = Self.processInfo(pid), candidate.kp_eproc.e_ucred.cr_uid == getuid() else { return false }
    return pid == parent || (peerRole == .backend && candidate.kp_eproc.e_ppid == parent)
  }

  private static func processInfo(_ pid: pid_t) -> kinfo_proc? {
    var query: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
    var value = kinfo_proc()
    var size = MemoryLayout<kinfo_proc>.size
    let result = query.withUnsafeMutableBufferPointer { sysctl($0.baseAddress, 4, &value, &size, nil, 0) }
    return result == 0 && size == MemoryLayout<kinfo_proc>.size ? value : nil
  }

  private func readPeer() {
    var buffer = [UInt8](repeating: 0, count: 65536)
    while peer >= 0 {
      let count = Darwin.read(peer, &buffer, buffer.count)
      if count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK) { break }
      if count < 0 && errno == EINTR { continue }
      guard count > 0 else { close(); return }
      input.append(contentsOf: buffer.prefix(count))
      guard input.count <= ArkProtectedBytes.maximumFrame + 4 else { close(); return }
      do {
        while input.count >= 4 {
          let length = input.prefix(4).reduce(0) { ($0 << 8) | Int($1) }
          guard length > 0, length <= ArkProtectedBytes.maximumFrame else { throw ArkProtectedOwnerError.rejected("Invalid private frame length") }
          guard input.count >= length + 4 else { break }
          let frame = Data(input.dropFirst(4).prefix(length))
          input.removeFirst(length + 4)
          try receive(frame)
        }
      } catch { close(); return }
    }
  }

  private func receive(_ data: Data) throws {
    if !authenticated {
      let value = try ArkProtectedBytes.object(data, keys: ["version", "operation", "launchToken"])
      guard value["version"] == .number(1), value["operation"] == .string("hello"),
        value["launchToken"] == .string(launchToken) else { throw ArkProtectedOwnerError.rejected("Private launch handshake differs") }
      lock.lock()
      guard active == nil, !closed else { lock.unlock(); throw ArkProtectedOwnerError.rejected("Private bootstrap is already active or closed") }
      let id = "bootstrap"
      let task = Task { [weak self, helloProvider] in
        do {
          let value = try await helloProvider()
          try Task.checkCancellation()
          guard let self else { return }
          if self.peerRole != .guardProcess { _ = try ArkProtectedOwnerPublicBinding.validateHello(ArkProtectedBytes.encode(value)) }
          self.io.async { [self] in
            self.lock.lock()
            let owned = self.active?.0 == id && !self.closed
            if self.active?.0 == id { self.active = nil }
            if owned { self.authenticated = true }
            self.lock.unlock()
            if owned { do { try self.send(value) } catch { self.close() } }
          }
        } catch { self?.close() }
      }
      active = (id, task)
      lock.unlock()
      return
    }
    let value = try JSONDecoder().decode(JSONValue.self, from: data)
    guard value["version"] == .number(1), let id = value["requestId"]?.stringValue,
      !id.isEmpty, id.count <= 200, let operation = value["operation"]?.stringValue,
      let object = value.objectValue else { throw ArkProtectedOwnerError.rejected("Invalid private request") }
    if operation == "cancel" {
      guard Set(object.keys) == ["version", "requestId", "operation"] else { throw ArkProtectedOwnerError.rejected("Invalid cancel fields") }
      lock.lock(); let owned = active; lock.unlock()
      guard owned?.0 == id else { throw ArkProtectedOwnerError.rejected("Cancellation does not own the active request") }
      owned?.1.cancel()
      return // Reply follows handler settlement; cancellation is not completion.
    }
    guard Set(object.keys) == ["version", "requestId", "operation", "payload"],
      let operation = ArkProtectedOperation(rawValue: operation), peerRole.permits(operation), let payload = value["payload"] else {
      throw ArkProtectedOwnerError.rejected("Unknown protected operation")
    }
    lock.lock()
    guard active == nil, !closed else { lock.unlock(); throw ArkProtectedOwnerError.rejected("Only one private request may be active") }
    let task = Task { [weak self, handler] in
      let response: JSONValue
      do {
        let result = try await handler(operation, payload)
        try Task.checkCancellation()
        response = .object(["version": .number(1), "requestId": .string(id), "ok": .bool(true), "result": result])
      } catch {
        response = .object(["version": .number(1), "requestId": .string(id), "ok": .bool(false),
          "error": .object(["code": .string(Task.isCancelled ? "cancelled" : "owner-rejected"), "message": .string(error.localizedDescription)])])
      }
      guard let self else { return }
      self.io.async { [self] in
        self.lock.lock()
        let stillOwned = self.active?.0 == id && !self.closed
        if self.active?.0 == id { self.active = nil }
        self.lock.unlock()
        if stillOwned { do { try self.send(response) } catch { self.close() } }
      }
    }
    active = (id, task)
    lock.unlock()
  }

  private func send(_ value: JSONValue) throws {
    let bytes = try ArkProtectedBytes.encode(value)
    guard bytes.count <= ArkProtectedBytes.maximumFrame, peer >= 0 else { throw ArkProtectedOwnerError.rejected("Private response is oversized or closed") }
    var length = UInt32(bytes.count).bigEndian
    var frame = withUnsafeBytes(of: &length) { Data($0) }
    frame.append(bytes)
    try frame.withUnsafeBytes { buffer in
      var offset = 0
      let deadline = Date().addingTimeInterval(5)
      while offset < buffer.count {
        let count = Darwin.write(peer, buffer.baseAddress!.advanced(by: offset), buffer.count - offset)
        if count < 0 && errno == EINTR { continue }
        if count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK) {
          lock.lock(); let ended = closed; lock.unlock()
          guard !ended, deadline > Date() else { throw ArkProtectedOwnerError.rejected("Private peer response deadline exceeded") }
          var readiness = pollfd(fd: peer, events: Int16(POLLOUT), revents: 0)
          _ = Darwin.poll(&readiness, 1, 50)
          continue
        }
        guard count > 0 else { throw ArkProtectedOwnerError.rejected("Private peer cannot receive its bounded response") }
        offset += count
      }
    }
  }
}
