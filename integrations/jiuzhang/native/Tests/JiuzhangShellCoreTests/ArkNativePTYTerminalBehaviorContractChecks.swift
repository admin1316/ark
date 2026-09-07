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
  let ansiParser = NativeANSIText.Parser()
  let pendingANSI = ansiParser.attributed("\u{001B}[32")
  let coloredANSI = ansiParser.attributed("m中")
  check(
    pendingANSI.length == 0
      && coloredANSI.string == "中"
      && coloredANSI.attribute(.foregroundColor, at: 0, effectiveRange: nil) as? NSColor
        == NSColor.systemGreen,
    "native Terminal ANSI parser preserves style state across arbitrary presentation chunks"
  )

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
}
