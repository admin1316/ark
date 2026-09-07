import Foundation
@testable import JiuzhangShellCore

private func eventLifecycleSourceSlice(
  _ source: String,
  from start: String,
  through end: String
) -> String? {
  guard
    let startRange = source.range(of: start),
    let endRange = source.range(
      of: end,
      range: startRange.upperBound..<source.endIndex
    )
  else { return nil }
  return String(source[startRange.lowerBound..<endRange.lowerBound])
}

private func appearsInOrder(_ source: String, _ values: [String]) -> Bool {
  var lowerBound = source.startIndex
  for value in values {
    guard let range = source.range(of: value, range: lowerBound..<source.endIndex) else {
      return false
    }
    lowerBound = range.upperBound
  }
  return true
}

func runArkEventPumpLifecycleContractChecks() async {
  let validBaseline = try? ArkEventPump.decodeFrame(
    #"{"type":"server-request","rpcId":"baseline-1","method":"stream/baseline","payload":{"type":"stream/baseline","channel":"mux","generation":"g1","phase":"complete","sessionIds":[]}}"#,
    channel: .mux
  )
  check(
    validBaseline?.method == "stream/baseline",
    "native event pump accepts an explicit zero-session baseline completion"
  )
  let validFailure = try? ArkEventPump.decodeFrame(
    #"{"type":"server-request","rpcId":"error-1","method":"stream/error","payload":{"type":"stream/error","channel":"host","error":{"code":"EVENT_QUEUE_OVERFLOW","message":"overflow","details":{}}}}"#,
    channel: .host
  )
  check(
    validFailure?.payload["error"]?["code"]?.stringValue == "EVENT_QUEUE_OVERFLOW",
    "native event pump preserves typed channel-level stream failures"
  )
  do {
    _ = try ArkEventPump.decodeFrame(
      #"{"type":"server-request","rpcId":"fractional","method":"session/subscribed","payload":{"type":"session/subscribed","sessionId":"s","lastSeq":1.5}}"#,
      channel: .mux
    )
    check(false, "native event pump rejects fractional sequence numbers")
  } catch ArkEventPumpError.invalidSequence(method: "session/subscribed") {
    check(true, "native event pump rejects fractional sequence numbers")
  } catch {
    check(false, "native event pump reports the expected invalid-sequence failure")
  }
  do {
    _ = try ArkEventPump.decodeFrame(
      #"{"type":"server-request","rpcId":"wrong-channel","method":"host/session-status","payload":{"type":"host/session-status","sessionId":"s","running":false}}"#,
      channel: .mux
    )
    check(false, "native event pump rejects methods delivered on the wrong channel")
  } catch ArkEventPumpError.unexpectedMethod(channel: .mux, method: "host/session-status") {
    check(true, "native event pump rejects methods delivered on the wrong channel")
  } catch {
    check(false, "native event pump reports the expected wrong-channel failure")
  }

  let baseTime = Date(timeIntervalSince1970: 1_000)
  var rapidBreaker = BackendRestartCircuitBreaker(
    maximumRapidRestarts: 3,
    stableWindow: 30
  )
  var rapidDelays: [TimeInterval?] = []
  for offset in 0..<4 {
    rapidBreaker.recordLaunch()
    rapidBreaker.recordReadiness(at: baseTime.addingTimeInterval(TimeInterval(offset * 2)))
    rapidDelays.append(rapidBreaker.restartDelayAfterUnexpectedExit(
      at: baseTime.addingTimeInterval(TimeInterval(offset * 2 + 1))
    ))
  }
  check(
    rapidDelays[0] == 1
      && rapidDelays[1] == 2
      && rapidDelays[2] == 4
      && rapidDelays[3] == nil,
    "post-readiness rapid crashes trip the rolling backend restart breaker"
  )

  var stableBreaker = BackendRestartCircuitBreaker(
    maximumRapidRestarts: 3,
    stableWindow: 30
  )
  stableBreaker.recordLaunch()
  stableBreaker.recordReadiness(at: baseTime)
  _ = stableBreaker.restartDelayAfterUnexpectedExit(at: baseTime.addingTimeInterval(1))
  stableBreaker.recordLaunch()
  stableBreaker.recordReadiness(at: baseTime.addingTimeInterval(2))
  let stableDelay = stableBreaker.restartDelayAfterUnexpectedExit(
    at: baseTime.addingTimeInterval(33)
  )
  check(
    stableDelay == 1 && stableBreaker.rapidRestartCount == 1,
    "readiness forgives old crashes only after the same backend survives the stable window"
  )

  let stoppedPump = ArkEventPump(
    baseURL: URL(string: "http://127.0.0.1:1")!,
    apiToken: "lifecycle-contract"
  )
  async let firstStop: Void = stoppedPump.stop()
  async let secondStop: Void = stoppedPump.stop()
  _ = await (firstStop, secondStop)
  await stoppedPump.start()
  let stoppedEvent = await stoppedPump.nextEvent()
  check(
    stoppedEvent == nil,
    "native event pump stop is idempotent, terminal, and finishes its stream"
  )

  let activePump = ArkEventPump(
    baseURL: URL(string: "http://127.0.0.1:1")!,
    apiToken: "active-lifecycle-contract"
  )
  await activePump.start()
  await Task.yield()
  async let firstActiveStop: Void = activePump.stop()
  async let secondActiveStop: Void = activePump.stop()
  _ = await (firstActiveStop, secondActiveStop)
  await activePump.start()
  let activeStoppedEvent = await activePump.nextEvent()
  check(
    activeStoppedEvent == nil,
    "active event pump concurrent stop callers reach one terminal stream"
  )

  let mailbox = ArkEventMailbox<Int>(capacity: 2)
  let firstAccepted = await mailbox.send(1)
  let secondAccepted = await mailbox.send(2)
  check(firstAccepted, "bounded mailbox accepts its first event")
  check(secondAccepted, "bounded mailbox accepts up to capacity")
  let thirdSend = Task { await mailbox.send(3) }
  try? await Task.sleep(nanoseconds: 20_000_000)
  let fullCounts = await mailbox.counts()
  check(
    fullCounts.buffered == 2 && fullCounts.waitingProducers == 1,
    "bounded mailbox suspends rather than dropping a producer at capacity"
  )
  let firstEvent = await mailbox.next()
  let thirdAccepted = await thirdSend.value
  check(firstEvent == 1, "bounded mailbox preserves FIFO order")
  check(thirdAccepted, "waiting producer resumes when the consumer frees capacity")
  let secondEvent = await mailbox.next()
  let thirdEvent = await mailbox.next()
  check(secondEvent == 2 && thirdEvent == 3, "bounded mailbox delivers every event")
  await mailbox.finish()
  let finishedEvent = await mailbox.next()
  check(finishedEvent == nil, "bounded mailbox finish wakes and terminates the consumer")

  let pumpURL = contractNativeRoot.appendingPathComponent(
    "Sources/JiuzhangShellCore/ArkEventPump.swift"
  )
  let modelURL = contractNativeRoot.appendingPathComponent(
    "Sources/JiuzhangShellUI/ArkAppModel.swift"
  )
  let delegateURL = contractNativeRoot.appendingPathComponent(
    "Sources/JiuzhangShell/AppDelegate.swift"
  )
  guard
    let pump = try? String(contentsOf: pumpURL, encoding: .utf8),
    let model = try? String(contentsOf: modelURL, encoding: .utf8),
    let delegate = try? String(contentsOf: delegateURL, encoding: .utf8),
    let pumpStop = eventLifecycleSourceSlice(
      pump,
      from: "public func stop() async",
      through: "private func run(channel: ArkEventChannel) async"
    ),
    let modelStart = eventLifecycleSourceSlice(
      model,
      from: "public func start()",
      through: "public func shutdown() async"
    ),
    let modelShutdown = eventLifecycleSourceSlice(
      model,
      from: "public func shutdown() async",
      through: "public func refreshNavigation(refreshWiki: Bool = true) async"
    ),
    let appTermination = eventLifecycleSourceSlice(
      delegate,
      from: "func applicationShouldTerminate(",
      through: "@objc func showArkSettings"
    ),
    let interfacePreparation = eventLifecycleSourceSlice(
      delegate,
      from: "private func prepareNativeInterfaceShutdown() async",
      through: "private func shutdownNativeInterface() async"
    ),
    let interfaceShutdown = eventLifecycleSourceSlice(
      delegate,
      from: "private func shutdownNativeInterface() async",
      through: "private func armTerminationDeadline("
    ),
    let deadlineOwner = eventLifecycleSourceSlice(
      delegate,
      from: "private func armTerminationDeadline(",
      through: "private func presentDraftFlushFailure"
    )
  else {
    check(false, "native event lifecycle sources are readable for shutdown ownership checks")
    return
  }

  let teardownOwnerInstall = pumpStop
    .components(separatedBy: "lifecycle = .stopping")
    .last?
    .components(separatedBy: "let stopTask = Task {")
    .first ?? ""
  check(
    pumpStop.contains("if let stopTask")
      && pumpStop.components(separatedBy: "let stopTask = Task {").count == 2
      && !teardownOwnerInstall.contains("await ")
      && appearsInOrder(pumpStop, [
        "lifecycle = .stopping",
        "socket.cancel(with: .goingAway, reason: nil)",
        "pump.cancel()",
        "let stopTask = Task {",
        "await mailbox.finish()",
        "await pump.value",
        "self.stopTask = stopTask",
        "await stopTask.value",
        "lifecycle = .stopped",
      ]),
    "event pump concurrent stop callers share one socket and pump quiescence operation"
  )
  check(
    modelStart.contains("guard eventLifecycle == .idle else { return }")
      && modelStart.contains("while !Task.isCancelled, let frame = await eventPump.nextEvent()"),
    "app model starts one event consumer and refuses a second lifecycle"
  )
  check(
    pump.contains("publishConnectionState(channel: channel, state: .connecting)")
      && pump.contains("publishConnectionFailure(")
      && pump.contains("EVENT_PROTOCOL_INVALID")
      && pump.contains("EVENT_TRANSPORT_UNAVAILABLE")
      && pump.contains("methodAllowed(method, on: channel)")
      && pump.contains("validateProtocolPayload(payload, method: method, channel: channel)")
      && !pump.contains("One malformed server frame must not interrupt later valid frames")
      && model.contains("eventConnectionStates")
      && model.contains("case \"stream/baseline\":")
      && model.contains("case \"stream/error\":"),
    "event channels expose connecting, baseline-connected, degraded, and strict protocol state"
  )
  check(
    modelShutdown.contains("if let eventShutdownTask")
      && appearsInOrder(modelShutdown, [
        "consumer?.cancel()",
        "await eventPump.stop()",
        "await consumer.value",
        "eventLifecycle = .stopped",
      ]),
    "app model cancels event delivery and awaits pump and consumer quiescence"
  )
  check(
    appearsInOrder(appTermination, [
      "let deadline = Date().addingTimeInterval(terminationTimeoutSeconds)",
      "armTerminationDeadline(sender: sender, requestID: requestID, deadline: deadline)",
      "if let error = await prepareNativeInterfaceShutdown()",
      "if terminationBackendStopStarted",
      "presentDraftFlushFailure(error)",
      "allow: false",
      "await shutdownNativeInterface()",
      "beginBackendStop(sender: sender, requestID: requestID, deadline: deadline)",
    ]),
    "AppKit owns one request-time deadline and only vetoes before irreversible native shutdown"
  )
  check(
    interfacePreparation.contains("await workbenchDraftFlushCoordinator.flush()")
      && !interfacePreparation.contains("model.shutdown")
      && appearsInOrder(interfaceShutdown, [
      "await model.shutdown()",
      "hostingView?.removeFromSuperview()",
      "appModel = nil",
    ])
      && delegate.components(separatedBy: "workbenchDraftFlushCoordinator.flush()").count == 2
      && delegate.components(separatedBy: "appModel = nil").count == 2
      && delegate.contains("await self.shutdownNativeInterface()")
      && delegate.contains("guard let self, !self.requestedTermination,")
      && delegate.contains("guard !requestedTermination, backend.isRunning,"),
    "a failed draft flush has no post-shutdown second flush and cannot return to a half-closed interface"
  )
  check(
    delegate.contains("private let terminationTimeoutSeconds: TimeInterval = 20")
      && deadlineOwner.contains("BackendProcess.forceKillGraceSeconds")
      && deadlineOwner.contains("deadline.addingTimeInterval(-0.25)")
      && deadlineOwner.contains("finishApplicationTermination(sender: sender, requestID: requestID, allow: true)")
      && deadlineOwner.contains("backend.stop(deadline: deadline)")
      && deadlineOwner.contains("sender.reply(toApplicationShouldTerminate: allow)"),
    "the AppKit total deadline reserves the launcher grace and emits one final termination reply"
  )
  check(
    !delegate.contains("restartAttempts = 0")
      && delegate.contains("restartCircuitBreaker.recordReadiness()")
      && delegate.contains("restartCircuitBreaker.restartDelayAfterUnexpectedExit()"),
    "readiness starts a stable-window breaker instead of immediately resetting crash history"
  )
}
