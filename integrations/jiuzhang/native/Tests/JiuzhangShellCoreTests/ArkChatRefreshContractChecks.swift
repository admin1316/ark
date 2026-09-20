import Foundation
@testable import JiuzhangShellCore
@testable import JiuzhangShellUI

/// Fixed replay for the transcript refresh.
///
/// Section 1 records where the data actually reaches before any final batch, so a
/// fixture row count is never mistaken for a rendered entry count. The history
/// read is paged (see `ArkHistoryAddress.page`, default `maximum=200`), so the
/// baseline is a bounded window; the long transcript is then built up from
/// legitimate contiguous live events through the real `consume` path.
@MainActor
func runArkChatRefreshContractChecks() async {
  let root = FileManager.default.temporaryDirectory
    .appendingPathComponent("ark-chat-refresh-\(UUID().uuidString)")
  let suite = "ark-chat-refresh-\(UUID().uuidString)"
  guard let defaults = UserDefaults(suiteName: suite) else {
    check(false, "chat refresh isolated defaults")
    return
  }
  let configuration = URLSessionConfiguration.ephemeral
  configuration.protocolClasses = [HistoryWindowURLProtocol.self]
  let transport = URLSession(configuration: configuration)
  let endpoint = URL(string: "http://ark-chat-refresh.invalid")!
  let client = ArkAPIClient(baseURL: endpoint, apiToken: "synthetic-contract", session: transport)
  let store = ArkDocumentReferenceStore(rootURL: root)
  let model = ArkAppModel(
    client: client,
    interactions: ArkInteractionAPI(baseURL: endpoint, apiToken: "synthetic-contract", session: transport),
    eventPump: ArkEventPump(baseURL: endpoint, apiToken: "synthetic-contract"),
    fallbackWikiRoot: root,
    documentStore: store,
    defaults: defaults
  )
  defer {
    transport.invalidateAndCancel()
    defaults.removePersistentDomain(forName: suite)
    try? FileManager.default.removeItem(at: root)
  }

  let historyRows = 700
  let fixture = HistoryWindowFixture(rows: historyRows)
  fixture.sessionID = "chat-refresh"
  HistoryWindowURLProtocol.fixture = fixture
  let sessionID = fixture.sessionID
  model.selectSession(sessionID, navigateToChat: false)
  model.selectedTab = .chat
  let loaded = await arkChatRefreshEventually { model.historyLoadState == .loaded }
  check(loaded, "chat refresh fixture session reaches a loaded history state")
  guard loaded else { return }

  // Populate session state through the production navigation entry point.
  await model.refreshNavigation(refreshWiki: false)
  let workspaceCount = model.workspaces.count
  let summary = model.sessions.first { $0.id == sessionID }
  check(workspaceCount > 0, "workspace/list is received, decoded and installed (workspaces=\(workspaceCount))")
  check(summary != nil, "session/list is received, decoded and installed for the selected session")
  check(summary?.running == true, "the selected session reports running=true (running=\(summary?.running == true))")
  check(model.navigationErrorMessage == nil, "navigation refresh reports no error (\(model.navigationErrorMessage ?? "none"))")
  guard summary?.running == true, model.navigationErrorMessage == nil else { return }

  let feed = ArkChatFeedProbe.Feed(model: model)

  // --- Section 1: where the data actually reaches ---
  let historyMessages = model.messages.count
  let historyEntries = feed.entryCount
  let readingAfterHistory = model.historyReadingSnapshot != nil
  check(
    historyMessages < historyRows,
    "the paged history read installs a bounded window, not all \(historyRows) fixture rows (model.messages=\(historyMessages))"
  )
  check(
    !readingAfterHistory,
    "loading the newest history page does not enter the frozen reading window"
  )

  // --- Section 2: build the long transcript from contiguous live events ---
  var nextSequence = historyRows
  func inject(_ type: String, _ data: JSONValue) {
    defer { nextSequence += 1 }
    model.consume(ArkEventFrame(
      channel: .mux,
      rpcID: "inject-\(nextSequence)",
      method: "session/event",
      payload: .object([
        "sessionId": .string(sessionID),
        "event": .object([
          "seq": .number(Double(nextSequence)),
          "type": .string(type),
          "time": .number(Double(nextSequence) * 1_000),
          "data": data,
        ]),
      ])
    ))
  }
  func assistant(_ text: String, turn: Int) {
    inject("turn/start", .object(["turn": .number(Double(turn))]))
    inject("assistant/message", .object([
      "turn": .number(Double(turn)), "step": .number(Double(turn)),
      "message": .object(["content": .array([.object(["type": .string("text"), "text": .string(text)])])]),
    ]))
    inject("turn/end", .object([
      "turn": .number(Double(turn)), "reason": .object(["kind": .string("completed")]),
    ]))
  }

  // The failed candidate carried 1,200 raw chunks in only 33 merged entries.
  // Classify that exact shape, plus a restored Markdown-heavy transcript,
  // without replaying an intentionally quadratic stream inside this contract.
  check(
    ArkChatFeedProbe.isHeavyWorkload(
      entryCount: 33, eventCount: 1_200, markdownRowCount: 0
    )
      && ArkChatFeedProbe.isHeavyWorkload(
        entryCount: 33, eventCount: 0, markdownRowCount: 1_200
      )
      && !ArkChatFeedProbe.isHeavyWorkload(
        entryCount: 33, eventCount: 600, markdownRowCount: 600
      ),
    "hundreds of folded stream chunks select the heavy cadence before merged entries reach 600"
  )

  var turn = 1
  // Each turn contributes one rendered assistant message, so the bound has to
  // clear the 600 threshold on top of the paged history baseline.
  while turn < 520 {
    assistant("FILLER-\(turn)", turn: turn)
    turn += 1
  }
  // Hypothesis split: first observe whether the feed catches up on its own, with
  // no externally forced refresh. If it stops short, one production schedule on
  // the same model shows whether the coalescing simply dropped the last trigger.
  // Hypothesis discrimination: how much of the injection actually landed, and
  // what the feed installed in response.
  print(
    "[chat-refresh][fill] turns=\(turn - 1) events=\(model.events.count)"
      + " messages=\(model.messages.count) feedEntries=\(feed.entryCount)"
      + " installTail=\([Int](feed.installOrder.suffix(6)))"
  )

  let caughtUp = await arkChatRefreshEventually(attempts: 120) { feed.entryCount > 600 }
  let stalledEntries = feed.entryCount
  if !caughtUp { feed.scheduleRefresh() }
  let afterForced = await arkChatRefreshEventually(attempts: 120) { feed.entryCount > 600 }
  print(
    "[chat-refresh][stall] stalled=\(stalledEntries) afterForced=\(afterForced)"
      + " feedEntries=\(feed.entryCount) events=\(model.events.count)"
      + " messages=\(model.messages.count)"
  )
  let filled = await arkChatRefreshEventually { feed.entryCount > 600 }
  check(
    caughtUp,
    "the feed catches up past 600 rendered entries without a forced refresh (stalled at \(stalledEntries))"
  )
  check(filled, "contiguous live events grow the transcript past 600 rendered entries (entries=\(feed.entryCount))")
  guard filled else { return }

  // Pre-final-batch state, recorded before anything is sent.
  let preMessages = model.messages.count
  let preEntries = feed.entryCount
  let cadence = feed.cadence
  check(model.historyReadingSnapshot == nil, "the final batch starts outside the frozen reading window")
  check(preEntries > 600, "more than 600 entries are installed before the final batch (entries=\(preEntries))")
  check(cadence.running && cadence.heavy,
        "the refresh scheduler is on the running heavy cadence (running=\(cadence.running) heavy=\(cadence.heavy))")
  guard model.historyReadingSnapshot == nil, preEntries > 600, cadence.running, cadence.heavy else { return }

  // --- Enter a wait window that actually uses running/heavy, then send the batch ---
  let preCadence = feed.cadence
  let baseInterval = feed.baseInterval(running: preCadence.running, heavy: preCadence.heavy)
  let backoff = feed.refreshBackoff
  let interval = baseInterval + backoff
  print(
    "[chat-refresh][scheduled] running=\(preCadence.running) heavy=\(preCadence.heavy)"
      + " base=\(baseInterval) backoff=\(backoff) interval=\(interval)"
  )
  feed.scheduleRefresh()
  let finalText = "FINAL-ANSWER-9c41"
  let toolOutput = "FINAL-TOOL-OUTPUT-9c41"
  let finalTurn = turn
  inject("turn/start", .object(["turn": .number(Double(finalTurn))]))
  inject("assistant/message", .object([
    "turn": .number(Double(finalTurn)), "step": .number(Double(finalTurn)),
    "message": .object(["content": .array([.object(["type": .string("text"), "text": .string(finalText)])])]),
  ]))
  inject("tool/call", .object([
    "turn": .number(Double(finalTurn)), "step": .number(Double(finalTurn)),
    "callId": .string("call-9c41"), "name": .string("read_file"),
    "arguments": .object(["path": .string("/tmp/fixture")]),
  ]))
  inject("tool/result", .object([
    "turn": .number(Double(finalTurn)), "step": .number(Double(finalTurn)),
    "callId": .string("call-9c41"), "isError": .bool(false),
    "content": .array([.object(["type": .string("text"), "text": .string(toolOutput)])]),
  ]))
  inject("turn/end", .object([
    "turn": .number(Double(finalTurn)), "reason": .object(["kind": .string("completed")]),
  ]))
  // No further events from here on.

  let installed = await arkChatRefreshEventually {
    feed.containsAssistantText(finalText) && feed.containsToolResult(toolOutput)
  }
  check(
    installed,
    "the final answer and tool result reach the installed Feed snapshot without leaving the page (entries=\(feed.entryCount))"
  )
  check(feed.containsAssistantText(finalText), "the installed snapshot carries the final answer text verbatim")
  check(feed.containsToolResult(toolOutput), "the installed snapshot carries the tool result verbatim")
  check(
    model.turnTerminalStates[finalTurn] == .completed,
    "the model records the injected turn terminal state"
  )
  print(
    "[chat-refresh] historyRows=\(historyRows) historyMessages=\(historyMessages) historyEntries=\(historyEntries)"
      + " preMessages=\(preMessages) preEntries=\(preEntries) running=\(cadence.running) heavy=\(cadence.heavy)"
      + " finalEntries=\(feed.entryCount) installs=\(feed.installOrder.count)"
  )

  // Reproduce the candidate's observed 10.7-second adaptive wait: an actual
  // main-actor stall raises the real scheduler's backoff, then ends before the
  // final event arrives. Completion must not inherit that streaming delay.
  feed.scheduleRefresh()
  try? await Task.sleep(nanoseconds: 50_000_000)
  stallChatRefreshMainActor(seconds: 7.2)
  let backedOff = await arkChatRefreshEventually { feed.refreshBackoff > 5 }
  check(backedOff, "a completed main-thread stall raises the real streaming refresh backoff")
  guard backedOff else { return }
  let observedBackoff = feed.refreshBackoff
  feed.scheduleRefresh()
  fixture.sessionRunning = false
  await model.refreshNavigation(refreshWiki: false)
  check(model.selectedSession?.running == false, "the completion fixture reports an idle session")
  let completionText = "COMPLETED-AFTER-LAYOUT-STALL"
  let completionTurn = finalTurn + 1
  let started = Date()
  inject("turn/start", .object(["turn": .number(Double(completionTurn))]))
  inject("assistant/message", .object([
    "turn": .number(Double(completionTurn)), "step": .number(Double(completionTurn)),
    "message": .object(["content": .array([.object(["type": .string("text"), "text": .string(completionText)])])]),
  ]))
  inject("turn/end", .object([
    "turn": .number(Double(completionTurn)), "reason": .object(["kind": .string("completed")]),
  ]))
  while !feed.containsAssistantText(completionText), Date().timeIntervalSince(started) < 5 {
    try? await Task.sleep(nanoseconds: 10_000_000)
  }
  let elapsed = Date().timeIntervalSince(started)
  print("[chat-refresh][completion-backoff] observed=\(observedBackoff) elapsed=\(elapsed) installed=\(feed.containsAssistantText(completionText))")
  check(feed.containsAssistantText(completionText) && elapsed < 5,
        "an idle completion bypasses stale streaming backoff and publishes its final answer within five seconds")
}

@MainActor
private func stallChatRefreshMainActor(seconds: TimeInterval) {
  Thread.sleep(forTimeInterval: seconds)
}

/// Poll for an observable condition rather than assuming a fixed delay.
@MainActor
private func arkChatRefreshEventually(
  _ condition: @MainActor () -> Bool,
  attempts: Int = 900
) async -> Bool {
  for _ in 0..<attempts {
    if condition() { return true }
    try? await Task.sleep(nanoseconds: 5_000_000)
  }
  return condition()
}

/// History reading: an incoming live event must not yank the surface back to
/// latest, and returning to latest must then pick the pending event up.
@MainActor
func runArkChatHistoryReadingContractChecks() async {
  let root = FileManager.default.temporaryDirectory
    .appendingPathComponent("ark-chat-reading-\(UUID().uuidString)")
  let suite = "ark-chat-reading-\(UUID().uuidString)"
  guard let defaults = UserDefaults(suiteName: suite) else {
    check(false, "chat reading isolated defaults")
    return
  }
  let configuration = URLSessionConfiguration.ephemeral
  configuration.protocolClasses = [HistoryWindowURLProtocol.self]
  let transport = URLSession(configuration: configuration)
  let endpoint = URL(string: "http://ark-chat-reading.invalid")!
  let client = ArkAPIClient(baseURL: endpoint, apiToken: "synthetic-contract", session: transport)
  let store = ArkDocumentReferenceStore(rootURL: root)
  let model = ArkAppModel(
    client: client,
    interactions: ArkInteractionAPI(baseURL: endpoint, apiToken: "synthetic-contract", session: transport),
    eventPump: ArkEventPump(baseURL: endpoint, apiToken: "synthetic-contract"),
    fallbackWikiRoot: root,
    documentStore: store,
    defaults: defaults
  )
  defer {
    transport.invalidateAndCancel()
    defaults.removePersistentDomain(forName: suite)
    try? FileManager.default.removeItem(at: root)
  }

  let fixture = HistoryWindowFixture(rows: 700)
  fixture.sessionID = "chat-reading"
  HistoryWindowURLProtocol.fixture = fixture
  let sessionID = fixture.sessionID
  model.selectSession(sessionID, navigateToChat: false)
  model.selectedTab = .chat
  let loaded = await arkChatRefreshEventually { model.historyLoadState == .loaded }
  check(loaded, "chat reading fixture session reaches a loaded history state")
  guard loaded else { return }
  await model.refreshNavigation(refreshWiki: false)

  let feed = ArkChatFeedProbe.Feed(model: model)

  await model.loadOlderHistory()
  let reading = await arkChatRefreshEventually { model.historyReadingSnapshot != nil }
  check(reading, "loading older history enters the reading window")
  guard reading else { return }

  // A live event arrives while the surface is reading history.
  let liveText = "LIVE-WHILE-READING-4d7f"
  var nextSequence = 700
  func inject(_ type: String, _ data: JSONValue) {
    defer { nextSequence += 1 }
    model.consume(ArkEventFrame(
      channel: .mux,
      rpcID: "reading-\(nextSequence)",
      method: "session/event",
      payload: .object([
        "sessionId": .string(sessionID),
        "event": .object([
          "seq": .number(Double(nextSequence)),
          "type": .string(type),
          "time": .number(Double(nextSequence) * 1_000),
          "data": data,
        ]),
      ])
    ))
  }
  let liveBatch: [(String, JSONValue)] = [
    ("turn/start", .object(["turn": .number(900)])),
    ("assistant/message", .object([
      "turn": .number(900), "step": .number(900),
      "message": .object(["content": .array([.object(["type": .string("text"), "text": .string(liveText)])])]),
    ])),
    ("turn/end", .object([
      "turn": .number(900), "reason": .object(["kind": .string("completed")]),
    ])),
  ]
  for (type, data) in liveBatch {
    inject(type, data)
    // Echo it from later history reads so a reload of latest sees it, the way a
    // real server's history would.
    fixture.recordInjected(.object([
      "seq": .number(Double(nextSequence - 1)),
      "type": .string(type),
      "time": .number(Double(nextSequence - 1) * 1_000),
      "data": data,
    ]))
  }

  // Let the pipeline process it, then confirm the reading surface held.
  _ = await arkChatRefreshEventually(attempts: 160) { model.hasNewerHistory }
  check(
    model.historyReadingSnapshot != nil,
    "reading history is not yanked back to latest by an incoming live event"
  )
  check(
    !feed.containsAssistantText(liveText),
    "the reading window does not render the live event as if the surface were at latest"
  )

  // Return to latest: the pending event must then be installed.
  await model.returnToLatestHistory()
  let restored = await arkChatRefreshEventually {
    model.historyReadingSnapshot == nil && feed.containsAssistantText(liveText)
  }
  check(model.historyReadingSnapshot == nil, "returning to latest leaves the reading window")
  check(restored, "returning to latest installs the event that arrived while reading")
}

/// Cut invariants for events a check appends to the fixture.
///
/// An appended event must not appear to a reader holding the older cut, and the
/// newest cut must advance to the appended tail. The check compares real sequence
/// boundaries rather than array lengths.
@MainActor
func runArkInjectedCutContractChecks() {
  let fixture = HistoryWindowFixture(rows: 100)
  let oldThrough = fixture.latestThrough()
  let oldRevision = fixture.revision(through: oldThrough)
  check(oldThrough == 99, "the fixture starts with 100 rows (through=\(oldThrough))")

  let appended: JSONValue = .object([
    "event": .object([
      "seq": .number(100),
      "type": .string("assistant/message"),
      "time": .number(100_000),
      "data": .object([
        "turn": .number(1), "step": .number(1),
        "message": .object(["content": .array([.object(["type": .string("text"), "text": .string("appended")])])]),
      ]),
    ]),
  ])
  fixture.recordInjected(appended)

  // 1) A reader holding the old cut must not see past it.
  let oldPage = try? fixture.response(.object([
    "view": .string("raw"), "sourceRevision": .string(oldRevision),
  ]))
  let oldSeqs = oldPage?["events"]?.arrayValue?.compactMap { Int($0["event"]?["seq"]?.numberValue ?? -1) } ?? []
  check(
    !oldSeqs.isEmpty && oldSeqs.allSatisfy { $0 <= oldThrough },
    "a read at the old cut returns no sequence past it (max=\(oldSeqs.max() ?? -1), cut=\(oldThrough))"
  )
  check(!oldSeqs.contains(100), "a read at the old cut does not see the appended event")

  // 2) The newest cut advances to the appended tail and can read it.
  let newThrough = fixture.latestThrough()
  check(newThrough == 100, "the newest cut advances to the appended tail (through=\(newThrough))")
  let newPage = try? fixture.response(.object([
    "view": .string("raw"), "sourceRevision": .string(fixture.revision(through: newThrough)),
  ]))
  let newSeqs = newPage?["events"]?.arrayValue?.compactMap { Int($0["event"]?["seq"]?.numberValue ?? -1) } ?? []
  check(newSeqs.contains(100), "a read at the newest cut sees the appended event")
  check(
    newSeqs.sorted() == Array(0...100),
    "the newest read is contiguous through the appended tail (count=\(newSeqs.count))"
  )
}
