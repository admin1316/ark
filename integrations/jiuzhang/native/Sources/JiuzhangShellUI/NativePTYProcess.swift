import Darwin
import Dispatch
import Foundation

struct NativePTYTermination: Equatable, Sendable {
  let processID: pid_t
  let exitCode: Int32?
  let signal: Int32?
  let forced: Bool
  let sessionDrained: Bool

  var displayStatus: Int32 {
    exitCode ?? signal.map { 128 + $0 } ?? -1
  }
}

enum NativePTYProcessError: LocalizedError {
  case system(operation: String, code: Int32)
  case helperUnavailable
  case helperRejected

  var errorDescription: String? {
    switch self {
    case .system(let operation, let code):
      return "\(operation)：\(String(cString: strerror(code)))"
    case .helperUnavailable:
      return "Terminal 子进程入口不可用"
    case .helperRejected:
      return "Terminal 子进程未能取得受控 PTY"
    }
  }
}

/// Early process mode used only by an authenticated parent Terminal spawn.
/// The helper runs before NSApplication exists, claims fd 0 as its controlling
/// terminal, removes its one-use nonce, and replaces itself with zsh.
public enum NativePTYTerminalChild {
  public static let argument = "--ark-pty-child"
  private static let nonceEnvironmentName = "ARK_INTERNAL_PTY_NONCE"
  private static let readinessDescriptor: Int32 = 3

  public static func exitStatusIfRequested(
    arguments: [String] = CommandLine.arguments,
    environment: [String: String] = ProcessInfo.processInfo.environment
  ) -> Int32? {
    guard arguments.dropFirst().first == argument else { return nil }
    guard arguments.count == 4,
          let inheritedNonce = environment[nonceEnvironmentName],
          arguments[2] == inheritedNonce,
          validNonce(inheritedNonce),
          arguments[3].hasPrefix("/")
    else { return 125 }

    let processID = Darwin.getpid()
    var readinessInfo = stat()
    guard Darwin.getsid(0) == processID,
          Darwin.getpgrp() == processID,
          Darwin.isatty(STDIN_FILENO) == 1,
          Darwin.fstat(readinessDescriptor, &readinessInfo) == 0,
          (readinessInfo.st_mode & S_IFMT) == S_IFIFO
    else { return 126 }
    guard Darwin.login_tty(STDIN_FILENO) == 0,
          Darwin.tcsetpgrp(STDIN_FILENO, processID) == 0,
          Darwin.tcgetpgrp(STDIN_FILENO) == processID,
          arguments[3].withCString({ Darwin.chdir($0) }) == 0
    else { return 126 }

    _ = Darwin.unsetenv(nonceEnvironmentName)
    guard Darwin.fcntl(readinessDescriptor, F_SETFD, FD_CLOEXEC) == 0 else { return 126 }
    var ready: UInt8 = 0xA5
    guard Darwin.write(readinessDescriptor, &ready, 1) == 1 else { return 126 }

    do {
      return try withMutableCStringArray(["/bin/zsh", "-l"]) { shellArguments in
        "/bin/zsh".withCString { shellPath in
          Darwin.execv(shellPath, shellArguments)
          var execError = errno
          _ = withUnsafeBytes(of: &execError) { bytes in
            Darwin.write(readinessDescriptor, bytes.baseAddress, bytes.count)
          }
          _ = Darwin.close(readinessDescriptor)
          return 126
        }
      }
    } catch {
      var execError = Int32(ENOMEM)
      _ = withUnsafeBytes(of: &execError) { bytes in
        Darwin.write(readinessDescriptor, bytes.baseAddress, bytes.count)
      }
      _ = Darwin.close(readinessDescriptor)
      return 126
    }
  }

  static var nonceEnvironmentKey: String { nonceEnvironmentName }
  static var readyDescriptor: Int32 { readinessDescriptor }

  private static func validNonce(_ value: String) -> Bool {
    value.count == 64 && value.unicodeScalars.allSatisfy {
      (48...57).contains($0.value) || (97...102).contains($0.value)
    }
  }
}

private func withMutableCStringArray<Result>(
  _ values: [String],
  _ body: (UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>) throws -> Result
) throws -> Result {
  var pointers: [UnsafeMutablePointer<CChar>?] = []
  pointers.reserveCapacity(values.count + 1)
  for value in values {
    guard let pointer = Darwin.strdup(value) else {
      pointers.compactMap { $0 }.forEach { Darwin.free(UnsafeMutableRawPointer($0)) }
      throw NativePTYProcessError.system(operation: "准备 Terminal 参数", code: ENOMEM)
    }
    pointers.append(pointer)
  }
  pointers.append(nil)
  defer {
    pointers.compactMap { $0 }.forEach { Darwin.free(UnsafeMutableRawPointer($0)) }
  }
  return try pointers.withUnsafeMutableBufferPointer { buffer in
    try body(buffer.baseAddress!)
  }
}

struct NativePTYSpawnedProcess: Sendable {
  let processID: pid_t
  let processGroupID: pid_t
  let sessionID: pid_t
  let masterDescriptor: Int32
}

enum NativePTYProcessSpawner {
  private static let retainedEnvironmentNames = Set([
    "HOME", "PATH", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "SHELL", "USER", "LOGNAME",
  ])

  static func spawn(
    helperExecutable: URL,
    rootURL: URL,
    baseEnvironment: [String: String]
  ) throws -> NativePTYSpawnedProcess {
    guard helperExecutable.isFileURL,
          FileManager.default.isExecutableFile(atPath: helperExecutable.path)
    else { throw NativePTYProcessError.helperUnavailable }

    var terminalEnvironment = baseEnvironment.filter {
      retainedEnvironmentNames.contains($0.key) || $0.key.hasPrefix("LC_")
    }
    terminalEnvironment["TERM"] = "xterm-256color"
    terminalEnvironment["COLORTERM"] = "truecolor"
    terminalEnvironment["CLICOLOR"] = "1"
    let nonce = (
      UUID().uuidString.replacingOccurrences(of: "-", with: "")
        + UUID().uuidString.replacingOccurrences(of: "-", with: "")
    ).lowercased()
    terminalEnvironment[NativePTYTerminalChild.nonceEnvironmentKey] = nonce

    var master: Int32 = -1
    var slave: Int32 = -1
    var size = winsize(ws_row: 30, ws_col: 100, ws_xpixel: 0, ws_ypixel: 0)
    guard Darwin.openpty(&master, &slave, nil, nil, &size) == 0 else {
      throw NativePTYProcessError.system(operation: "创建 Terminal PTY", code: errno)
    }
    var readiness = [Int32](repeating: -1, count: 2)
    guard readiness.withUnsafeMutableBufferPointer({ Darwin.pipe($0.baseAddress!) }) == 0 else {
      let code = errno
      Darwin.close(master)
      Darwin.close(slave)
      throw NativePTYProcessError.system(operation: "创建 Terminal 握手", code: code)
    }
    var keepMaster = false
    defer {
      if !keepMaster, master >= 0 { Darwin.close(master) }
      if slave >= 0 { Darwin.close(slave) }
      if readiness[0] >= 0 { Darwin.close(readiness[0]) }
      if readiness[1] >= 0 { Darwin.close(readiness[1]) }
    }

    var actions: posix_spawn_file_actions_t?
    try requireZero(posix_spawn_file_actions_init(&actions), operation: "初始化 Terminal 文件动作")
    defer { posix_spawn_file_actions_destroy(&actions) }
    for descriptor in [STDIN_FILENO, STDOUT_FILENO, STDERR_FILENO] {
      try requireZero(
        posix_spawn_file_actions_adddup2(&actions, slave, descriptor),
        operation: "映射 Terminal PTY"
      )
    }
    try requireZero(
      posix_spawn_file_actions_adddup2(
        &actions,
        readiness[1],
        NativePTYTerminalChild.readyDescriptor
      ),
      operation: "映射 Terminal 握手"
    )

    var attributes: posix_spawnattr_t?
    try requireZero(posix_spawnattr_init(&attributes), operation: "初始化 Terminal 进程属性")
    defer { posix_spawnattr_destroy(&attributes) }
    var emptyMask = sigset_t()
    sigemptyset(&emptyMask)
    var defaultSignals = sigset_t()
    sigemptyset(&defaultSignals)
    for signal in [SIGHUP, SIGINT, SIGQUIT, SIGTERM, SIGCHLD, SIGPIPE] {
      sigaddset(&defaultSignals, signal)
    }
    try requireZero(
      posix_spawnattr_setsigmask(&attributes, &emptyMask),
      operation: "设置 Terminal 信号掩码"
    )
    try requireZero(
      posix_spawnattr_setsigdefault(&attributes, &defaultSignals),
      operation: "设置 Terminal 默认信号"
    )
    let rawFlags = POSIX_SPAWN_SETSID
      | POSIX_SPAWN_SETSIGMASK
      | POSIX_SPAWN_SETSIGDEF
      | POSIX_SPAWN_CLOEXEC_DEFAULT
    try requireZero(
      posix_spawnattr_setflags(&attributes, Int16(truncatingIfNeeded: rawFlags)),
      operation: "设置 Terminal session 属性"
    )

    let arguments = [helperExecutable.path, NativePTYTerminalChild.argument, nonce, rootURL.path]
    let environment = terminalEnvironment.keys.sorted().map { "\($0)=\(terminalEnvironment[$0]!)" }
    var processID: pid_t = 0
    let spawnResult = try withMutableCStringArray(arguments) { argumentPointers in
      try withMutableCStringArray(environment) { environmentPointers in
        helperExecutable.path.withCString { executablePath in
          Darwin.posix_spawn(
            &processID,
            executablePath,
            &actions,
            &attributes,
            argumentPointers,
            environmentPointers
          )
        }
      }
    }
    try requireZero(spawnResult, operation: "启动 Terminal shell")

    Darwin.close(slave)
    slave = -1
    Darwin.close(readiness[1])
    readiness[1] = -1
    guard helperBecameReady(readiness[0]),
          Darwin.getsid(processID) == processID,
          Darwin.getpgid(processID) == processID,
          Darwin.tcgetpgrp(master) == processID
    else {
      terminateFailedSpawn(processID: processID)
      throw NativePTYProcessError.helperRejected
    }
    Darwin.close(readiness[0])
    readiness[0] = -1
    keepMaster = true
    return NativePTYSpawnedProcess(
      processID: processID,
      processGroupID: processID,
      sessionID: processID,
      masterDescriptor: master
    )
  }

  private static func helperBecameReady(_ descriptor: Int32) -> Bool {
    var pollDescriptor = pollfd(fd: descriptor, events: Int16(POLLIN | POLLHUP), revents: 0)
    guard Darwin.poll(&pollDescriptor, 1, 2_000) > 0 else { return false }
    var byte: UInt8 = 0
    guard Darwin.read(descriptor, &byte, 1) == 1, byte == 0xA5 else { return false }
    pollDescriptor.revents = 0
    guard Darwin.poll(&pollDescriptor, 1, 2_000) > 0 else { return false }
    var execError: Int32 = 0
    return withUnsafeMutableBytes(of: &execError) { bytes in
      Darwin.read(descriptor, bytes.baseAddress, bytes.count) == 0
    }
  }

  private static func terminateFailedSpawn(processID: pid_t) {
    _ = Darwin.kill(-processID, SIGKILL)
    _ = Darwin.kill(processID, SIGKILL)
    var status: Int32 = 0
    while Darwin.waitpid(processID, &status, 0) == -1 && errno == EINTR {}
  }

  private static func requireZero(_ result: Int32, operation: String) throws {
    guard result == 0 else {
      throw NativePTYProcessError.system(operation: operation, code: result)
    }
  }
}

/// Owns exactly the process groups whose session id is the spawned shell pid.
/// Ordinary jobs and `nohup` remain in that session; a command that deliberately
/// calls `setsid` leaves this ownership boundary and is never signalled here.
final class NativePTYProcessOwner: @unchecked Sendable {
  typealias WillShutdown = @MainActor @Sendable () -> Void
  typealias DidTerminate = @MainActor @Sendable (NativePTYTermination) -> Void

  let processID: pid_t
  let processGroupID: pid_t
  let sessionID: pid_t

  private let lock = NSLock()
  private let exitSource: DispatchSourceProcess
  private let willShutdown: WillShutdown
  private let didTerminate: DidTerminate
  private var shutdownTask: Task<NativePTYTermination, Never>?
  private var terminationPublished = false

  init(
    process: NativePTYSpawnedProcess,
    willShutdown: @escaping WillShutdown,
    didTerminate: @escaping DidTerminate
  ) {
    processID = process.processID
    processGroupID = process.processGroupID
    sessionID = process.sessionID
    self.willShutdown = willShutdown
    self.didTerminate = didTerminate
    exitSource = DispatchSource.makeProcessSource(
      identifier: process.processID,
      eventMask: .exit,
      queue: DispatchQueue.global(qos: .utility)
    )
    exitSource.setEventHandler { [weak self] in self?.shutdownDetached() }
  }

  func startMonitoring() {
    exitSource.resume()
  }

  func shutdown() async -> NativePTYTermination {
    let task = sharedShutdownTask()
    let termination = await task.value
    if claimTerminationPublication() { await didTerminate(termination) }
    return termination
  }

  func shutdownDetached() {
    Task { [self] in _ = await shutdown() }
  }

  private func sharedShutdownTask() -> Task<NativePTYTermination, Never> {
    lock.lock()
    defer { lock.unlock() }
    if let shutdownTask { return shutdownTask }
    exitSource.setEventHandler {}
    exitSource.cancel()
    let processID = processID
    let processGroupID = processGroupID
    let sessionID = sessionID
    let willShutdown = willShutdown
    let task = Task {
      await willShutdown()
      return await Task.detached(priority: .utility) {
        Self.terminateAndReap(
          processID: processID,
          processGroupID: processGroupID,
          sessionID: sessionID
        )
      }.value
    }
    shutdownTask = task
    return task
  }

  private func claimTerminationPublication() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    guard !terminationPublished else { return false }
    terminationPublished = true
    return true
  }

  private static func terminateAndReap(
    processID: pid_t,
    processGroupID: pid_t,
    sessionID: pid_t
  ) -> NativePTYTermination {
    signalOwnedSession(
      processID: processID,
      processGroupID: processGroupID,
      sessionID: sessionID,
      signal: SIGHUP
    )
    usleep(150_000)
    signalOwnedSession(
      processID: processID,
      processGroupID: processGroupID,
      sessionID: sessionID,
      signal: SIGTERM
    )
    usleep(250_000)
    signalOwnedSession(
      processID: processID,
      processGroupID: processGroupID,
      sessionID: sessionID,
      signal: SIGKILL
    )

    let drainDeadline = DispatchTime.now().uptimeNanoseconds + 1_000_000_000
    var sessionDrained = false
    repeat {
      let remaining = processIDs(inSession: sessionID).filter { $0 != processID }
      if remaining.isEmpty {
        sessionDrained = true
        break
      }
      usleep(20_000)
    } while DispatchTime.now().uptimeNanoseconds < drainDeadline

    var status: Int32 = 0
    var waited: pid_t
    repeat {
      waited = Darwin.waitpid(processID, &status, 0)
    } while waited == -1 && errno == EINTR
    let decoded = decodeWaitStatus(waited == processID ? status : nil)
    return NativePTYTermination(
      processID: processID,
      exitCode: decoded.exitCode,
      signal: decoded.signal,
      forced: decoded.signal == SIGKILL,
      sessionDrained: sessionDrained
    )
  }

  private static func signalOwnedSession(
    processID: pid_t,
    processGroupID: pid_t,
    sessionID: pid_t,
    signal: Int32
  ) {
    guard sessionID == processID, processGroupID == processID else { return }
    var groups = Set<pid_t>([processGroupID])
    for pid in processIDs(inSession: sessionID) {
      let group = Darwin.getpgid(pid)
      if group > 1 { groups.insert(group) }
    }
    for group in groups where group > 1 {
      _ = Darwin.kill(-group, signal)
    }
  }

  private static func processIDs(inSession sessionID: pid_t) -> [pid_t] {
    let reportedCapacity = Darwin.proc_listallpids(nil, 0)
    guard reportedCapacity > 0 else { return [] }
    var processIDs = [pid_t](
      repeating: 0,
      count: Int(reportedCapacity) + 32
    )
    let count = processIDs.withUnsafeMutableBytes { bytes in
      Darwin.proc_listallpids(bytes.baseAddress, Int32(bytes.count))
    }
    guard count > 0 else { return [] }
    return processIDs.prefix(min(Int(count), processIDs.count)).filter {
      $0 > 1 && Darwin.getsid($0) == sessionID
    }
  }

  private static func decodeWaitStatus(
    _ status: Int32?
  ) -> (exitCode: Int32?, signal: Int32?) {
    guard let status else { return (nil, nil) }
    let terminatingSignal = status & 0x7F
    if terminatingSignal == 0 {
      return ((status >> 8) & 0xFF, nil)
    }
    return (nil, terminatingSignal)
  }
}
