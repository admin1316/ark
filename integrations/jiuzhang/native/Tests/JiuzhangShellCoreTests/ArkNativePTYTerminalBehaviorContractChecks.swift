import AppKit
import Darwin
import Foundation
@testable import JiuzhangShellUI

private func waitForTerminal(
  timeout: TimeInterval = 5,
  _ predicate: @escaping @MainActor @Sendable () -> Bool
) async -> Bool {
  let deadline = Date().addingTimeInterval(timeout)
  while Date() < deadline {
    if await MainActor.run(body: predicate) { return true }
    try? await Task.sleep(nanoseconds: 25_000_000)
  }
  return await MainActor.run(body: predicate)
}

private func capturedPID(after marker: String, in output: String) -> pid_t? {
  var cursor = output.startIndex
  while let markerRange = output.range(of: marker, range: cursor..<output.endIndex) {
    let suffix = output[markerRange.upperBound...]
    let digits = suffix.prefix(while: { $0.isNumber })
    if let value = Int32(digits) { return value }
    cursor = markerRange.upperBound
  }
  return nil
}

private func capturedAbsolutePath(after marker: String, in output: String) -> String? {
  var cursor = output.startIndex
  while let markerRange = output.range(of: marker, range: cursor..<output.endIndex) {
    let suffix = output[markerRange.upperBound...]
    if suffix.first == "/" {
      let path = suffix.prefix { !$0.isNewline && $0 != "\u{1B}" }
      if !path.isEmpty { return String(path) }
    }
    cursor = markerRange.upperBound
  }
  return nil
}

private func canonicalTerminalPath(_ rawPath: String) -> String? {
  var storage = [CChar](repeating: 0, count: Int(PATH_MAX))
  return storage.withUnsafeMutableBufferPointer { resolved in
    rawPath.withCString { path in
      guard Darwin.realpath(path, resolved.baseAddress) != nil else { return nil }
      return String(cString: resolved.baseAddress!)
    }
  }
}

private func sameFileSystemItem(_ left: String, _ right: String) -> Bool {
  guard let canonicalLeft = canonicalTerminalPath(left),
        let canonicalRight = canonicalTerminalPath(right)
  else { return false }
  return canonicalLeft == canonicalRight
}

private struct NativePTYTestProcessIdentity {
  let pid: pid_t
  let startSeconds: UInt64
  let startMicroseconds: UInt64
  let executablePath: String
  let processGroupID: pid_t
  let sessionID: pid_t
}

private func captureTestProcessIdentity(_ pid: pid_t) -> NativePTYTestProcessIdentity? {
  guard pid > 1 else { return nil }
  var info = proc_bsdinfo()
  let infoSize = MemoryLayout<proc_bsdinfo>.size
  guard Darwin.proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, Int32(infoSize)) == infoSize else {
    return nil
  }
  var path = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
  guard Darwin.proc_pidpath(pid, &path, UInt32(path.count)) > 0 else { return nil }
  return NativePTYTestProcessIdentity(
    pid: pid,
    startSeconds: info.pbi_start_tvsec,
    startMicroseconds: info.pbi_start_tvusec,
    executablePath: String(cString: path),
    processGroupID: Darwin.getpgid(pid),
    sessionID: Darwin.getsid(pid)
  )
}

private func testProcessMatches(_ identity: NativePTYTestProcessIdentity) -> Bool {
  guard let current = captureTestProcessIdentity(identity.pid) else { return false }
  return current.startSeconds == identity.startSeconds
    && current.startMicroseconds == identity.startMicroseconds
    && current.executablePath == identity.executablePath
    && current.processGroupID == identity.processGroupID
    && current.sessionID == identity.sessionID
}

private func terminateExactTestProcess(_ identity: NativePTYTestProcessIdentity) {
  guard testProcessMatches(identity) else { return }
  if identity.processGroupID == identity.pid, identity.sessionID == identity.pid {
    _ = Darwin.kill(-identity.processGroupID, SIGKILL)
  } else {
    _ = Darwin.kill(identity.pid, SIGKILL)
  }
}

private func terminalEnvironment(home: URL) -> [String: String] {
  [
    "HOME": home.path,
    "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
    "SHELL": "/bin/zsh",
    "LANG": "C.UTF-8",
    "ARK_TEST_TOKEN": "must-not-reach-terminal",
  ]
}

private func terminalSession(root: URL) async -> NativePTYTerminalSession {
  await MainActor.run {
    NativePTYTerminalSession(rootURL: root, baseEnvironment: terminalEnvironment(home: root))
  }
}

func runArkNativePTYTerminalBehaviorContractChecks() async {
  let boundedInbox = NativeTerminalOutputInbox(byteLimit: 128)
  let firstSchedule = boundedInbox.enqueue(Data(repeating: 0x61, count: 96))
  let repeatedSchedule = boundedInbox.enqueue(Data(repeating: 0x62, count: 96))
  let boundedBytes = boundedInbox.bufferedByteCount
  let boundedBatch = boundedInbox.drain()
  check(
    firstSchedule
      && !repeatedSchedule
      && boundedBytes == 128
      && boundedBatch.text.utf8.count == 128
      && boundedBatch.droppedBytes == 64
      && boundedBatch.resetsANSIState
      && boundedInbox.bufferedByteCount == 0,
    "native Terminal bounds pending bytes before main-actor publication and schedules one drain"
  )

  let unicodeInbox = NativeTerminalOutputInbox(byteLimit: 128)
  let unicodeBytes = Data("中文🙂".utf8)
  let unicodeFirst = unicodeInbox.enqueue(unicodeBytes.prefix(1))
  let unicodeSecond = unicodeInbox.enqueue(unicodeBytes.dropFirst(1).prefix(4))
  let unicodeThird = unicodeInbox.enqueue(unicodeBytes.dropFirst(5))
  let unicodeBatch = unicodeInbox.drain()
  check(
    !unicodeFirst
      && unicodeSecond
      && !unicodeThird
      && unicodeBatch.text == "中文🙂"
      && !unicodeBatch.text.contains("\u{FFFD}"),
    "native Terminal incrementally decodes split Chinese and emoji UTF-8 without replacement"
  )

  let ansiInbox = NativeTerminalOutputInbox(byteLimit: 128)
  check(
    !ansiInbox.enqueue(Data("\u{001B}[3".utf8))
      && ansiInbox.drain().text.isEmpty
      && ansiInbox.enqueue(Data("1m红\u{001B}[0m".utf8)),
    "native Terminal retains an incomplete ANSI sequence until a later chunk completes it"
  )
  let ansiBatch = ansiInbox.drain()
  check(
    ansiBatch.text == "\u{001B}[31m红\u{001B}[0m",
    "native Terminal publishes only complete split ANSI sequences"
  )
  // SwiftTerm owns escape-sequence interpretation now; the session transcript remains a raw
  // byte tap, so parser-level assertions moved upstream to the engine's own suite.

  let overflowInbox = NativeTerminalOutputInbox(byteLimit: 18)
  _ = overflowInbox.enqueue(Data("\u{001B}[31m你好🙂世界\u{001B}[0m".utf8))
  let overflowBatch = overflowInbox.drain()
  check(
    overflowBatch.droppedBytes > 0
      && overflowBatch.resetsANSIState
      && !overflowBatch.text.contains("\u{FFFD}")
      && String(data: Data(overflowBatch.text.utf8), encoding: .utf8) == overflowBatch.text,
    "native Terminal overflow drops only complete UTF-8 and ANSI tokens and requests a parser reset"
  )

  check(
    NativePTYTerminalChild.exitStatusIfRequested(
      arguments: ["Ark"],
      environment: [:]
    ) == nil
      && NativePTYTerminalChild.exitStatusIfRequested(
        arguments: ["Ark", NativePTYTerminalChild.argument, "invalid", "/private/tmp"],
        environment: [:]
      ) == 125,
    "native PTY helper mode ignores ordinary launches and rejects unauthenticated arguments"
  )

  let root = FileManager.default.temporaryDirectory
    .appendingPathComponent("ark-native-pty-\(UUID().uuidString)", isDirectory: true)
  do {
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
  } catch {
    check(false, "native PTY behavior fixture can be created")
    return
  }
  defer { try? FileManager.default.removeItem(at: root) }

  let session = await terminalSession(root: root)
  await MainActor.run {
    session.startIfNeeded()
    session.resize(columns: 132, rows: 43)
    session.sendCommand(
      "printf '__ARK_PTY_READY__\\n'; printf '__ARK_PWD__%s\\n' \"$PWD\"; "
        + "printf '__ARK_SIZE__'; stty size; "
        + "if env | grep -q 'ARK_TEST_TOKEN\\|ARK_INTERNAL_PTY_NONCE'; "
        + "then printf '__ARK_SECRET_LEAK__\\n'; else printf '__ARK_SECRET_SCRUBBED__\\n'; fi"
    )
  }
  let initialReady = await waitForTerminal {
    let reportedPath = capturedAbsolutePath(after: "__ARK_PWD__", in: session.output)
    return session.output.contains("__ARK_PTY_READY__")
      && reportedPath.map { sameFileSystemItem($0, root.path) } == true
      && session.output.contains("__ARK_SIZE__43 132")
      && session.output.contains("__ARK_SECRET_SCRUBBED__")
  }
  let shellPID = await MainActor.run { session.processIdentifier }
  let processGroupID = await MainActor.run { session.processGroupIdentifier }
  let processSessionID = await MainActor.run { session.processSessionIdentifier }
  if !initialReady {
    let diagnostic = await MainActor.run {
      let error = session.errorMessage ?? "nil"
      let pid = session.processIdentifier.map(String.init) ?? "nil"
      let processGroup = session.processGroupIdentifier.map(String.init) ?? "nil"
      let processSession = session.processSessionIdentifier.map(String.init) ?? "nil"
      let reportedPath = capturedAbsolutePath(after: "__ARK_PWD__", in: session.output)
      return "error=\(error) running=\(session.isRunning) pid=\(pid) "
        + "pgid=\(processGroup) sid=\(processSession) "
        + "root=\(String(reflecting: root.path)) "
        + "reported=\(String(reflecting: reportedPath)) "
        + "canonicalRoot=\(String(reflecting: canonicalTerminalPath(root.path))) "
        + "canonicalReported=\(String(reflecting: reportedPath.flatMap(canonicalTerminalPath))) "
        + "outputTail=\(String(reflecting: String(session.output.suffix(2_000))))"
    }
    print("PTY DIAGNOSTIC initial: \(diagnostic)")
  }
  check(initialReady, "native Terminal owns a controlling PTY with cwd, resize, and scrubbed environment")
  check(
    shellPID != nil && shellPID == processGroupID && shellPID == processSessionID,
    "native Terminal helper starts as one verified session and process-group leader"
  )

  await MainActor.run { session.sendCommand("sleep 20") }
  try? await Task.sleep(nanoseconds: 100_000_000)
  await MainActor.run {
    session.sendControlC()
    session.sendCommand(
      "printf '__ARK_AFTER_CTRL_C__\\n'; "
        + "sleep 30 & printf '__ARK_CHILD_PID__%s\\n' $!; "
        + "nohup sleep 30 >/dev/null 2>&1 & printf '__ARK_NOHUP_PID__%s\\n' $!"
    )
  }
  let childReady = await waitForTerminal {
    session.output.contains("__ARK_AFTER_CTRL_C__")
      && capturedPID(after: "__ARK_CHILD_PID__", in: session.output) != nil
      && capturedPID(after: "__ARK_NOHUP_PID__", in: session.output) != nil
  }
  let childPID = await MainActor.run {
    capturedPID(after: "__ARK_CHILD_PID__", in: session.output)
  }
  let nohupPID = await MainActor.run {
    capturedPID(after: "__ARK_NOHUP_PID__", in: session.output)
  }
  let childIdentity = childPID.flatMap(captureTestProcessIdentity)
  let nohupIdentity = nohupPID.flatMap(captureTestProcessIdentity)
  if !childReady {
    let outputTail = await MainActor.run { String(reflecting: String(session.output.suffix(2_000))) }
    print("PTY DIAGNOSTIC children: outputTail=\(outputTail)")
  }
  check(childReady && childPID != nil && nohupPID != nil, "native Terminal creates owned background fixtures")

  async let firstStop = session.shutdown()
  async let repeatedStop = session.shutdown()
  let (firstTermination, repeatedTermination) = await (firstStop, repeatedStop)
  check(firstTermination == repeatedTermination, "native Terminal repeat stop awaits one teardown result")
  check(firstTermination?.sessionDrained == true, "native Terminal drains every process group in its owned session")
  if let shellPID {
    check(captureTestProcessIdentity(shellPID) == nil, "native Terminal waitpid reaps its owned shell")
  }
  if let childIdentity {
    check(!testProcessMatches(childIdentity), "native Terminal stops an ordinary background child")
    terminateExactTestProcess(childIdentity)
  }
  if let nohupIdentity {
    check(!testProcessMatches(nohupIdentity), "native Terminal stops a nohup child that remains in its owned session")
    terminateExactTestProcess(nohupIdentity)
  }

  let natural = await terminalSession(root: root)
  await MainActor.run {
    natural.startIfNeeded()
    natural.sendCommand("exit 7")
  }
  let naturalFinished = await waitForTerminal { natural.termination != nil }
  let naturalTermination = await MainActor.run { natural.termination }
  check(
    naturalFinished
      && naturalTermination?.exitCode == 7
      && naturalTermination?.signal == nil
      && naturalTermination?.sessionDrained == true,
    "native Terminal natural exit is normalized and reaped"
  )

  let forced = await terminalSession(root: root)
  await MainActor.run {
    forced.startIfNeeded()
    forced.sendCommand("trap '' HUP TERM; printf '__ARK_FORCE_READY__\\n'; while :; do sleep 1; done")
  }
  let forceReady = await waitForTerminal { forced.output.contains("__ARK_FORCE_READY__") }
  let forcedTermination = await forced.shutdown()
  check(
    forceReady
      && forcedTermination?.forced == true
      && forcedTermination?.signal == SIGKILL
      && forcedTermination?.sessionDrained == true,
    "native Terminal escalates a signal-resistant shell to bounded KILL and reaps it"
  )

  let detached = await terminalSession(root: root)
  await MainActor.run {
    detached.startIfNeeded()
    detached.sendCommand(
      "/usr/bin/python3 -c 'import os,time; p=os.fork(); "
        + "os._exit(0) if p else None; os.setsid(); "
        + "print(\"__ARK_DETACHED_PID__\"+str(os.getpid()),flush=True); time.sleep(30)' &"
    )
  }
  let detachedReady = await waitForTerminal {
    capturedPID(after: "__ARK_DETACHED_PID__", in: detached.output) != nil
  }
  let detachedPID = await MainActor.run {
    capturedPID(after: "__ARK_DETACHED_PID__", in: detached.output)
  }
  let detachedIdentity = detachedPID.flatMap(captureTestProcessIdentity)
  let detachedShellSession = await MainActor.run { detached.processSessionIdentifier }
  let escapedSession = detachedPID.map { Darwin.getsid($0) }
  _ = await detached.shutdown()
  if !detachedReady {
    let diagnostic = await MainActor.run {
      let error = detached.errorMessage ?? "nil"
      return "error=\(error) "
        + "outputTail=\(String(reflecting: String(detached.output.suffix(2_000))))"
    }
    print("PTY DIAGNOSTIC detached: \(diagnostic)")
  }
  check(
    detachedReady
      && detachedPID != nil
      && escapedSession != detachedShellSession
      && detachedIdentity.map(testProcessMatches) == true,
    "a child that deliberately calls setsid is outside the Terminal-owned session boundary"
  )
  if let detachedIdentity { terminateExactTestProcess(detachedIdentity) }

  let workbenchURL = contractNativeRoot.appendingPathComponent(
    "Sources/JiuzhangShellUI/NativeWorkbenchView.swift"
  )
  if let workbench = try? String(contentsOf: workbenchURL, encoding: .utf8),
     let closeStart = workbench.range(of: "func requestToolTabClose(_ id: String)"),
     let closeEnd = workbench.range(
       of: "func shutdownTerminalSessions() async",
       range: closeStart.upperBound..<workbench.endIndex
     )
  {
    let closeBlock = String(workbench[closeStart.lowerBound..<closeEnd.lowerBound])
    let shutdownIndex = closeBlock.range(of: "await session.shutdown()")?.lowerBound
    let removeIndex = closeBlock.range(of: "terminalSessions.removeValue")?.lowerBound
    check(
      shutdownIndex != nil && removeIndex != nil && shutdownIndex! < removeIndex!,
      "Workbench tab close retains its Terminal owner until async reap completes"
    )
    check(
      workbench.contains("await model.shutdownTerminalSessions()")
        && workbench.contains("Task { await model.shutdownTerminalSessions() }"),
      "Workbench teardown awaits Terminal sessions and keeps a deinit fallback"
    )
  } else {
    check(false, "native Workbench source is readable for Terminal close ownership")
  }

  // MARK: - Session recovery / repair (cwd reuse, automatic rebuild; no content is ever replayed)

  let recoveryRoot = FileManager.default.temporaryDirectory
    .appendingPathComponent("ark-terminal-recovery-\(UUID().uuidString)", isDirectory: true)
  let recoveryStoreDirectory = FileManager.default.temporaryDirectory
    .appendingPathComponent("ark-terminal-store-\(UUID().uuidString)", isDirectory: true)
  try? FileManager.default.createDirectory(at: recoveryRoot, withIntermediateDirectories: true)
  try? FileManager.default.createDirectory(at: recoveryStoreDirectory, withIntermediateDirectories: true)
  defer {
    try? FileManager.default.removeItem(at: recoveryRoot)
    try? FileManager.default.removeItem(at: recoveryStoreDirectory)
  }

  // 1) cwd 复用 + 绝不回放内容：旧记录（含 transcript 字段）只恢复工作目录，surface 装好后必须是空的。
  let restoredWorkingDirectory = recoveryRoot
    .appendingPathComponent("restored-cwd", isDirectory: true)
  try? FileManager.default.createDirectory(at: restoredWorkingDirectory, withIntermediateDirectories: true)
  let restoreKey = "restore|\(UUID().uuidString)"
  let restoreStore = NativeTerminalSessionStore(storageDirectoryURL: recoveryStoreDirectory)
  // A record written by an older build: it still carries a transcript tail that must never reach a terminal.
  try? Data(
    """
    {"cwd":"\(restoredWorkingDirectory.path)","transcript":"__ARK_RESTORED_TRANSCRIPT__","updatedAt":1700000000,"repairCount":2}
    """.utf8
  ).write(to: restoreStore.recordURL(forKey: restoreKey))
  let restoredSession = await MainActor.run {
    NativePTYTerminalSession(
      rootURL: recoveryRoot,
      sessionKey: restoreKey,
      store: restoreStore,
      baseEnvironment: terminalEnvironment(home: recoveryRoot)
    )
  }
  let restoredSurfaceText = await MainActor.run {
    restoredSession.terminalSurface().surfaceText()
  }
  check(
    restoredSurfaceText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
    "a restored session starts on a blank screen: no persisted output is ever replayed into the emulator"
  )
  await MainActor.run {
    restoredSession.startIfNeeded()
    restoredSession.sendCommand("printf '__ARK_RESTORED_PWD__%s\\n' \"$PWD\"")
  }
  let restoredWorkingDirectoryReused = await waitForTerminal(timeout: 8) {
    capturedAbsolutePath(after: "__ARK_RESTORED_PWD__", in: restoredSession.output)
      .map { sameFileSystemItem($0, restoredWorkingDirectory.path) } == true
  }
  check(
    restoredWorkingDirectoryReused,
    "restored session starts its shell in the persisted working directory"
  )
  _ = await restoredSession.shutdown()

  // 2) 非主动退出 → NativeTerminalRepairPolicy 自动重建，并提示退出码与重启。
  let repairKey = "repair|\(UUID().uuidString)"
  let repairStore = NativeTerminalSessionStore(storageDirectoryURL: recoveryStoreDirectory)
  let repairSession = await MainActor.run {
    NativePTYTerminalSession(
      rootURL: recoveryRoot,
      sessionKey: repairKey,
      store: repairStore,
      baseEnvironment: terminalEnvironment(home: recoveryRoot)
    )
  }
  await MainActor.run { repairSession.startIfNeeded() }
  let originalShellPID = await MainActor.run { repairSession.processIdentifier }
  await MainActor.run { repairSession.sendCommand("exit 5") }
  let rebuilt = await waitForTerminal(timeout: 15) {
    repairSession.isRunning
      && repairSession.processIdentifier != nil
      && repairSession.processIdentifier != originalShellPID
  }
  let repairNotices = await MainActor.run {
    repairSession.output.contains(ArkL10n.text(.filesTerminalShellExited, .zh))
      && repairSession.output.contains(ArkL10n.text(.filesTerminalRestarting, .zh))
  }
  let persistedRepair = repairStore.load(forKey: repairKey) != nil
  check(
    rebuilt && repairNotices && persistedRepair,
    "an unexpected shell exit is rebuilt automatically with exit-code and restart notices"
  )
  _ = await repairSession.shutdown()

  // 3) 重建预算耗尽 → 停止并提示 ⌘R，不再自动重建。
  let exhaustionKey = "exhaust|\(UUID().uuidString)"
  let exhaustionStore = NativeTerminalSessionStore(storageDirectoryURL: recoveryStoreDirectory)
  let exhaustionSession = await MainActor.run {
    NativePTYTerminalSession(
      rootURL: recoveryRoot,
      sessionKey: exhaustionKey,
      store: exhaustionStore,
      baseEnvironment: terminalEnvironment(home: recoveryRoot)
    )
  }
  await MainActor.run { exhaustionSession.startIfNeeded() }
  var requestedExits = 0
  let exhaustionDeadline = Date().addingTimeInterval(40)
  while requestedExits < 4, Date() < exhaustionDeadline {
    guard await waitForTerminal(timeout: 10, { exhaustionSession.isRunning }) else { break }
    await MainActor.run { exhaustionSession.sendCommand("exit 4") }
    requestedExits += 1
    _ = await waitForTerminal(timeout: 10) { !exhaustionSession.isRunning }
  }
  let stoppedNotice = await waitForTerminal(timeout: 10) {
    exhaustionSession.output.contains(ArkL10n.text(.filesTerminalStopped, .zh))
  }
  let staysStopped = await MainActor.run { !exhaustionSession.isRunning }
  check(
    stoppedNotice && staysStopped,
    "an exhausted repair budget stops the session with the restart notice instead of rebuilding"
  )
  _ = await exhaustionSession.shutdown()

  // MARK: - A 组审计修复：Task 生命周期 / 重建硬上限 / surface 回放 / 本地化退出行

  // 1) 关标签/退出：2s cwd 采样与待重建 Task 必须取消。
  let tasksRoot = FileManager.default.temporaryDirectory
    .appendingPathComponent("ark-terminal-tasks-\(UUID().uuidString)", isDirectory: true)
  try? FileManager.default.createDirectory(at: tasksRoot, withIntermediateDirectories: true)
  let tasksSession = await MainActor.run {
    NativePTYTerminalSession(rootURL: tasksRoot, baseEnvironment: terminalEnvironment(home: tasksRoot))
  }
  await MainActor.run { tasksSession.startIfNeeded() }
  let samplingWhileRunning = await MainActor.run { tasksSession.isSamplingWorkingDirectory }
  let localizedExitText = await MainActor.run { tasksSession.exitStatusText(7) }
  check(
    localizedExitText.contains(ArkL10n.text(.filesTerminalShellExited, .zh))
      && localizedExitText.contains("7"),
    "the thin exit-status row reuses the localized shell-exited copy"
  )
  await MainActor.run { tasksSession.sendCommand("exit 9") }
  let tasksSessionStopped = await waitForTerminal(timeout: 10) { !tasksSession.isRunning }
  let tasksCancelled = await MainActor.run {
    !tasksSession.isSamplingWorkingDirectory && !tasksSession.hasPendingAutomaticRepair
  }
  check(
    samplingWhileRunning && tasksSessionStopped && tasksCancelled,
    "terminal teardown cancels the 2s cwd sampler and leaves no pending repair task"
  )
  _ = await tasksSession.shutdown()
  try? FileManager.default.removeItem(at: tasksRoot)

  // 2) 生命周期硬上限：limit=1 时第二次自然退出必须停止；只有手动重启才重置。
  let ceilingRoot = FileManager.default.temporaryDirectory
    .appendingPathComponent("ark-terminal-ceiling-\(UUID().uuidString)", isDirectory: true)
  let ceilingStoreDirectory = FileManager.default.temporaryDirectory
    .appendingPathComponent("ark-terminal-ceiling-store-\(UUID().uuidString)", isDirectory: true)
  try? FileManager.default.createDirectory(at: ceilingRoot, withIntermediateDirectories: true)
  try? FileManager.default.createDirectory(at: ceilingStoreDirectory, withIntermediateDirectories: true)
  let ceilingStore = NativeTerminalSessionStore(storageDirectoryURL: ceilingStoreDirectory)
  let ceilingSession = await MainActor.run {
    NativePTYTerminalSession(
      rootURL: ceilingRoot,
      sessionKey: "ceiling|\(UUID().uuidString)",
      store: ceilingStore,
      baseEnvironment: terminalEnvironment(home: ceilingRoot)
    )
  }
  await MainActor.run {
    ceilingSession.lifetimeAutomaticRepairLimit = 1
    ceilingSession.startIfNeeded()
  }
  await MainActor.run { ceilingSession.sendCommand("exit 6") }
  let firstCeilingRebuild = await waitForTerminal(timeout: 12) {
    ceilingSession.isRunning && ceilingSession.lifetimeAutomaticRepairCountSnapshot == 1
  }
  await MainActor.run { ceilingSession.sendCommand("exit 6") }
  let stoppedAtCeiling = await waitForTerminal(timeout: 12) {
    !ceilingSession.isRunning
      && ceilingSession.output.contains(ArkL10n.text(.filesTerminalStopped, .zh))
  }
  let ceilingAttempts = await MainActor.run { ceilingSession.lifetimeAutomaticRepairCountSnapshot }
  check(
    firstCeilingRebuild && stoppedAtCeiling && ceilingAttempts == 1,
    "automatic repair stops at the per-session lifetime ceiling and keeps the stopped notice"
  )
  await MainActor.run { ceilingSession.restartSession() }
  let manualCeilingReset = await waitForTerminal(timeout: 12) {
    ceilingSession.isRunning && ceilingSession.lifetimeAutomaticRepairCountSnapshot == 0
  }
  check(manualCeilingReset, "a manual restart clears the automatic-repair lifetime ceiling")
  _ = await ceilingSession.shutdown()
  try? FileManager.default.removeItem(at: ceilingRoot)
  try? FileManager.default.removeItem(at: ceilingStoreDirectory)

  // 3) 标签切换（终端 → 文件 → 终端）只能重挂载同一个 SwiftTerm 实例，不得用文字转写重建：
  //    2026-09-12 用户报告「打开了一下文件，再点回来终端花屏」。用同一份字节流对照一个全程在线的
  //    控制组，证明切回后的缓冲区逐字节一致，且不再出现「会话已恢复」通知。
  let retentionRoot = FileManager.default.temporaryDirectory
    .appendingPathComponent("ark-terminal-surface-retention-\(UUID().uuidString)", isDirectory: true)
  try? FileManager.default.createDirectory(at: retentionRoot, withIntermediateDirectories: true)
  let retentionSession = await MainActor.run {
    NativePTYTerminalSession(
      rootURL: retentionRoot,
      baseEnvironment: terminalEnvironment(home: retentionRoot)
    )
  }
  let controlSession = await MainActor.run {
    NativePTYTerminalSession(
      rootURL: retentionRoot,
      baseEnvironment: terminalEnvironment(home: retentionRoot)
    )
  }
  // 全屏程序自己的重绘：备用屏、光标定位、回车重画、颜色 —— 正是文字转写复原不了的部分。
  let firstChunk = Array(
    ("\u{001B}[?1049h\u{001B}[2J\u{001B}[H\u{001B}[1mARK_PANEL_ONE\u{001B}[0m\r\n"
      + "\u{001B}[3;10Hspinner |\r\u{001B}[3;10Hspinner /\r\u{001B}[3;10Hspinner -").utf8
  )
  // Stay on the alternate screen: a full-screen program owns it, and leaving it would swap the
  // buffer the assertions read.
  let secondChunk = Array(
    ("\u{001B}[3;10Hspinner \\u{001B}[0m\r\n"
      + "\u{001B}[5;1Hwhile-away-line").utf8
  )
  let retentionSurface = await MainActor.run { retentionSession.terminalSurface() }
  let controlSurface = await MainActor.run { controlSession.terminalSurface() }
  let retentionContainerA = await MainActor.run {
    NSView(frame: NSRect(x: 0, y: 0, width: 720, height: 420))
  }
  await MainActor.run {
    retentionSurface.install(in: retentionContainerA)
    controlSurface.install(in: NSView(frame: NSRect(x: 0, y: 0, width: 720, height: 420)))
    retentionSession.onOutput?(firstChunk)
    controlSession.onOutput?(firstChunk)
  }
  let beforeSwitchLanded = await waitForTerminal(timeout: 5) {
    retentionSurface.surfaceText().contains("ARK_PANEL_ONE")
      && controlSurface.surfaceText().contains("ARK_PANEL_ONE")
  }
  // 切到文件标签：surface 从视图树摘掉，但模拟器必须继续吃 PTY 输出。
  await MainActor.run {
    retentionSurface.uninstall(from: retentionContainerA)
    retentionSession.onOutput?(secondChunk)
    controlSession.onOutput?(secondChunk)
  }
  let whileAwayLanded = await waitForTerminal(timeout: 5) {
    retentionSurface.surfaceText().contains("while-away-line")
      && controlSurface.surfaceText().contains("while-away-line")
  }
  // 点回终端标签：重挂载同一个实例，缓冲区与控制组逐字节一致。
  let (sameSurface, retentionText, controlText) = await MainActor.run {
    retentionSurface.install(in: NSView(frame: NSRect(x: 0, y: 0, width: 720, height: 420)))
    return (
      retentionSession.terminalSurface() === retentionSurface,
      retentionSurface.surfaceText(),
      controlSurface.surfaceText()
    )
  }
  check(beforeSwitchLanded, "the session surface shows output before the tab switch")
  check(
    whileAwayLanded,
    "the hidden session surface keeps consuming output while another tab is in front"
  )
  check(sameSurface, "the tab round trip reuses the one session-owned terminal surface")
  if retentionText != controlText {
    print("RETENTION host=[\(retentionText)]")
    print("RETENTION control=[\(controlText)]")
  }
  check(
    retentionText == controlText,
    "a re-installed surface matches a never-detached control byte for byte"
  )

  // 3c) 队列必须有界：主线程被一次事务占住时，PTY 仍在生产；旧实现无上限（审计 P1-6）。
  //     这里在无 run loop 的测试里直接灌入远超上限的字节，drain 不会消费，正好验证裁剪。
  let floodSurface = controlSurface
  let floodChunk = [UInt8](repeating: 0x41, count: 1024 * 1024)
  for _ in 0..<12 { floodSurface.enqueue(floodChunk) }
  check(
    floodSurface.queuedByteCount <= floodSurface.pendingByteLimit + 64,
    "the terminal feed queue stays bounded under a flood (\(floodSurface.queuedByteCount) bytes)"
  )
  // 3c2) PTY→主线程交接必须成批且有界：旧实现每个 read chunk 一个 MainActor Task（各持 raw），
  //      洪泛 + 主线程繁忙 = 无界队列（审计 P1-6 残留路径）。
  let handoffSourceURL = contractNativeRoot.appendingPathComponent(
    "Sources/JiuzhangShellUI/NativePTYTerminalView.swift"
  )
  if let handoffSource = try? String(contentsOf: handoffSourceURL, encoding: .utf8) {
    check(
      handoffSource.contains("self?.rawHandoff.append(Array(data))")
        && handoffSource.contains("NativeTerminalRawHandoff(limit: 8 * 1024 * 1024)")
        && handoffSource.contains("NativeTerminalFlushGate()")
        && !handoffSource.contains("self.onOutput?(raw)"),
      "the PTY read handler hands bytes off in one bounded burst instead of one Task per chunk"
    )
  } else {
    check(false, "terminal source is readable for the hand-off contract")
  }

  // 3b) 隐藏期间的真实 PTY 输出同样必须落进同一个 surface（切回来既不是空白也不是旧画面）。
  let hiddenRoot = FileManager.default.temporaryDirectory
    .appendingPathComponent("ark-terminal-hidden-\(UUID().uuidString)", isDirectory: true)
  try? FileManager.default.createDirectory(at: hiddenRoot, withIntermediateDirectories: true)
  let hiddenSession = await MainActor.run {
    NativePTYTerminalSession(
      rootURL: hiddenRoot,
      baseEnvironment: terminalEnvironment(home: hiddenRoot)
    )
  }
  let hiddenSurface = await MainActor.run { hiddenSession.terminalSurface() }
  let hiddenContainer = await MainActor.run {
    NSView(frame: NSRect(x: 0, y: 0, width: 720, height: 420))
  }
  await MainActor.run {
    hiddenSurface.install(in: hiddenContainer)
    hiddenSession.startIfNeeded()
    hiddenSession.sendCommand("printf '__ARK_HIDDEN_BEFORE__\\n'")
  }
  let hiddenBefore = await waitForTerminal(timeout: 8) {
    hiddenSurface.surfaceText().contains("__ARK_HIDDEN_BEFORE__")
  }
  await MainActor.run {
    hiddenSurface.uninstall(from: hiddenContainer)
    hiddenSession.sendCommand("printf '__ARK_HIDDEN_AFTER__\\n'")
  }
  let hiddenAfter = await waitForTerminal(timeout: 8) {
    hiddenSurface.surfaceText().contains("__ARK_HIDDEN_AFTER__")
  }
  let hiddenText = await MainActor.run {
    hiddenSurface.install(in: NSView(frame: NSRect(x: 0, y: 0, width: 720, height: 420)))
    return hiddenSurface.surfaceText()
  }
  check(
    hiddenBefore && hiddenAfter
      && hiddenText.contains("__ARK_HIDDEN_BEFORE__")
      && hiddenText.contains("__ARK_HIDDEN_AFTER__"),
    "live PTY output keeps landing in the hidden surface and survives the return"
  )

  // 3b2) 洪泛下交接缓冲必须有界，且尾部输出仍能到达 surface。
  // DIAGNOSTIC (temporary): sample the hand-off buffer while the flood drains so a
  // failure carries peak/final counters and elapsed time instead of one sample.
  await MainActor.run {
    hiddenSession.sendCommand("yes flood-line | head -c 20000000; echo __ARK_FLOOD_DONE__")
  }
  let floodStartedAt = Date()
  var floodTailLanded = false
  var floodSamples = 0
  var peakHandoffBytes = 0
  while Date().timeIntervalSince(floodStartedAt) < 30 {
    if await waitForTerminal(timeout: 1) { hiddenSurface.surfaceText().contains("__ARK_FLOOD_DONE__") } {
      floodTailLanded = true
      break
    }
    let observed = await MainActor.run { hiddenSession.pendingRawHandoffBytes }
    if observed > peakHandoffBytes { peakHandoffBytes = observed }
    floodSamples += 1
  }
  let handoffBound = await MainActor.run { hiddenSession.pendingRawHandoffBytes }
  if handoffBound > peakHandoffBytes { peakHandoffBytes = handoffBound }
  let floodElapsedMs = Int(Date().timeIntervalSince(floodStartedAt) * 1_000)
  let floodSurfaceChars = await MainActor.run { hiddenSurface.surfaceText().count }
  print("[pty-flood-trace] bytes_requested=20000000 write_calls=1 samples=\(floodSamples) peak_handoff=\(peakHandoffBytes) final_handoff=\(handoffBound) tail_seen=\(floodTailLanded) surface_chars=\(floodSurfaceChars) elapsed_ms=\(floodElapsedMs)")
  check(
    floodTailLanded && handoffBound <= 8 * 1024 * 1024 + 65_536,
    "a 20 MB PTY flood stays bounded in the hand-off buffer (\(handoffBound) bytes) and still reaches the tail"
  )
  _ = await hiddenSession.shutdown()
  try? FileManager.default.removeItem(at: hiddenRoot)
  _ = await retentionSession.shutdown()
  _ = await controlSession.shutdown()
  try? FileManager.default.removeItem(at: retentionRoot)

  // 4) A7：⌘R 只在终端拥有键盘焦点时生效（窗口级隐藏 Button shortcut 会在聊天框误触发）。
  let terminalSourceURL = contractNativeRoot.appendingPathComponent(
    "Sources/JiuzhangShellUI/NativePTYTerminalView.swift"
  )
  if let terminalSource = try? String(contentsOf: terminalSourceURL, encoding: .utf8) {
    check(
      !terminalSource.contains(".keyboardShortcut(\"r\"")
        && terminalSource.contains("NSEvent.addLocalMonitorForEvents(matching: .keyDown)")
        && terminalSource.contains("NSEvent.removeMonitor")
        && terminalSource.contains("isTerminalFocused")
        && terminalSource.contains("!event.isARepeat")
        && terminalSource.contains("charactersIgnoringModifiers?.lowercased() == \"r\""),
      "Command-R is a view-scoped local event monitor with teardown, not a window-level shortcut"
    )
    check(
      terminalSource.contains("ArkL10n.text(.filesTerminalDrainTimeout, language)")
        && !terminalSource.contains("Terminal session 未能在时限内完全退出"),
      "the drain-timeout error row is localized through ArkL10n with no hardcoded copy"
    )
    check(
      terminalSource.contains("private func focusIfNothingIsEditing()")
        && terminalSource.contains("textView.isEditable")
        && terminalSource.contains("window.firstResponder is NSTextField")
        && terminalSource.contains("DispatchQueue.main.async { [weak self] in self?.focusIfNothingIsEditing() }"),
      "a re-installed terminal takes the keyboard only when no text editor owns it"
    )
    check(
      // C2: a rejected second Command-R must report itself instead of silently doing nothing.
      !terminalSource.contains("guard !restartInFlight else { return }")
        && terminalSource.contains("guard !restartInFlight else {")
        && terminalSource.contains("emitTranscriptLine(ArkL10n.text(.filesTerminalRestarting, language))"),
      "Command-R during an in-flight restart tells the operator instead of silently ignoring the key"
    )
  } else {
    check(false, "terminal source is readable for the Command-R scope contract")
  }

  // 6) 终端内容只能来自 PTY：旧的"转写净化 + 回放"链路必须整体消失，否则任何一次恢复都会把历史
  //    文本伪造成屏幕内容（用户 2026-09-12 看到的碎片 + "已恢复上次会话输出"就是这样来的）。
  if let terminalSource = try? String(contentsOf: terminalSourceURL, encoding: .utf8) {
    check(
      !terminalSource.contains("NativeTerminalTranscriptSanitizer")
        && !terminalSource.contains("playbackBytes")
        && !terminalSource.contains("transcript:")
        && !terminalSource.contains("filesTerminalSessionRestored"),
      "no transcript sanitizer or playback path survives: the PTY is the only author of terminal content"
    )
    check(
      terminalSource.contains("private(set) var output = \"\"")
        && !terminalSource.contains("@Published private(set) var output"),
      "the diagnostic transcript is not published, so heavy output does not invalidate the view"
    )
  } else {
    check(false, "terminal source is readable for the single-writer contract")
  }
}
