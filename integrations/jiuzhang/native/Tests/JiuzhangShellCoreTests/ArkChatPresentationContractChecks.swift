import AppKit
import Foundation
@testable import JiuzhangShellCore
@testable import JiuzhangShellUI

private func chatSourceSlice(
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

private func chatEvent(
  _ id: Int,
  _ type: String,
  _ data: JSONValue
) -> ArkHistoryEvent {
  ArkHistoryEvent(
    id: id,
    type: type,
    time: Date(timeIntervalSince1970: Double(id)),
    data: data,
    view: nil
  )
}

private func wireHistoryRow(_ sequence: Double, type: String = "turn/start") -> JSONValue {
  .object([
    "event": .object([
      "seq": .number(sequence),
      "type": .string(type),
      "time": .number(sequence * 1_000),
      "data": .object(["turn": .number(1)]),
    ]),
  ])
}

private func compactCheckpoint(
  id: Int,
  compactionID: String,
  commandID: String? = nil
) -> ArkHistoryEvent {
  var source: [String: JSONValue] = [
    "kind": .string("plugin"),
    "plugin": .string("compact"),
    "compactionId": .string(compactionID),
  ]
  if let commandID { source["sourceCommandId"] = .string(commandID) }
  return chatEvent(
    id, "user/message",
    .object([
      "id": .string("message-\(id)"),
      "content": .array([
        .object([
          "type": .string("text"),
          "text": .string("<context_summary>hidden model checkpoint</context_summary>"),
        ])
      ]),
      "source": .object(source),
    ]))
}

@MainActor
private func runNativeProjectionMemoChecks() {
  func key(
    sessionID: String? = "session-a",
    sessionRunning: Bool = false,
    language: ArkLanguagePreference = .zh,
    feedbackAvailable: Bool = false,
    feedbackByID: [String: ArkMessageFeedback] = [:],
    turnMetricsByTurn: [Int: ArkChatTurnMetrics] = [:],
    turnUsageByTurn: [Int: ArkChatTurnUsage] = [:],
    completedTurns: Set<Int> = [],
    forkSequenceByMessageID: [Int: Int] = [:],
    latestAssistantMessageID: Int? = nil,
    compactProcess: Bool = true
  ) -> NativeChatProjectionKey {
    NativeChatProjectionKey(
      contentRevision: 11,
      sessionID: sessionID,
      sessionRunning: sessionRunning,
      language: language,
      feedbackAvailable: feedbackAvailable,
      feedbackByID: feedbackByID,
      turnMetricsByTurn: turnMetricsByTurn,
      turnUsageByTurn: turnUsageByTurn,
      completedTurns: completedTurns,
      forkSequenceByMessageID: forkSequenceByMessageID,
      latestAssistantMessageID: latestAssistantMessageID,
      compactProcess: compactProcess
    )
  }
  let feedback = try? ArkFeedbackAPIContract.item(from: .object([
    "messageId": .string("message-1"),
    "rating": .string("positive"),
    "version": .string("11111111-1111-4111-8111-111111111111"),
  ]))
  let base = key()
  let variants = [
    key(sessionID: "session-b"),
    key(sessionRunning: true),
    key(language: .en),
    key(feedbackAvailable: true),
    key(feedbackByID: feedback.map { ["message-1": $0] } ?? [:]),
    key(turnMetricsByTurn: [1: ArkChatTurnMetrics(
      runSeconds: 1,
      firstTokenSeconds: 0.2,
      tokensPerSecond: 10
    )]),
    key(turnUsageByTurn: [1: ArkChatTurnUsage(
      uncachedInputTokens: 2,
      outputTokens: 3,
      totalTokens: 5
    )]),
    key(completedTurns: [1]),
    key(forkSequenceByMessageID: [7: 99]),
    key(latestAssistantMessageID: 7),
    key(compactProcess: false),
  ]
  let memo = NativeProjectionMemo<NativeChatProjectionKey, String>()
  var builds = 0
  let first = memo.value(for: base) {
    builds += 1
    return "one"
  }
  let retained = memo.value(for: base) {
    builds += 1
    return "unexpected"
  }
  for variant in variants {
    _ = memo.value(for: variant) {
      builds += 1
      return "changed"
    }
  }
  check(
    first == "one"
      && retained == "one"
      && variants.allSatisfy { $0 != base }
      && builds == variants.count + 1,
    "native projection memo invalidates every context field consumed by body projection"
  )
}

func runArkChatPresentationContractChecks() {
  MainActor.assumeIsolated {
    runNativeProjectionMemoChecks()
  }
  check(
    ArkHistoryLoadState.afterCancellation(hasHistory: false) == .idle
      && ArkHistoryLoadState.afterCancellation(hasHistory: true) == .loaded,
    "native cancelled history refresh cannot leave the empty chat permanently loading"
  )
  check(
    ArkEventSequenceValidator.safeInteger(.number(7)) == 7
      && ArkEventSequenceValidator.safeInteger(.number(-1), minimum: -1) == -1
      && ArkEventSequenceValidator.safeInteger(.number(1.5)) == nil
      && ArkEventSequenceValidator.safeInteger(.number(9_007_199_254_740_992)) == nil,
    "native event sequences accept only finite JSON-safe integers"
  )
  let validWirePage = try? ArkAPIClient.validatedHistoryPage(
    from: .object([
      "events": .array([wireHistoryRow(7), wireHistoryRow(8, type: "turn/end")]),
      "hasMore": .bool(true),
    ]),
    context: "测试历史"
  )
  check(
    validWirePage?.events.map(\.id) == [7, 8]
      && validWirePage?.beforeSequence == 7
      && validWirePage?.hasMore == true,
    "native history exposes its first strict sequence as the next older cursor"
  )
  for invalidRows in [
    [wireHistoryRow(1.5)],
    [wireHistoryRow(9_007_199_254_740_992)],
    [wireHistoryRow(7), wireHistoryRow(7)],
    [wireHistoryRow(7), wireHistoryRow(9)],
    [.object(["event": .object(["seq": .number(7)])])],
  ] {
    check(
      (try? ArkAPIClient.validatedHistoryPage(
        from: .object(["events": .array(invalidRows), "hasMore": .bool(false)]),
        context: "测试历史"
      )) == nil,
      "native history rejects malformed, fractional, unsafe, duplicate, or gapped rows"
    )
  }
  check(
    (try? ArkAPIClient.validatedHistoryPage(
      from: .object(["events": .array([]), "hasMore": .bool(true)]),
      context: "测试历史"
    )) == nil,
    "native history rejects an empty page that claims an older continuation"
  )
  check(
    (try? ArkAPIClient.validatedHistoryPage(
      from: .object(["events": .array([wireHistoryRow(7)]), "hasMore": .bool(false)]),
      context: "测试历史"
    )) == nil,
    "native history rejects a terminal page that silently omits sequence zero"
  )
  let contiguousPage = ArkHistoryPage(
    events: [
      chatEvent(8, "turn/start", .object(["turn": .number(1)])),
      chatEvent(9, "turn/end", .object(["turn": .number(1)])),
    ],
    hasMore: true,
    beforeSequence: 8
  )
  check(
    (try? ArkEventSequenceValidator.validatePage(contiguousPage)) != nil,
    "native history accepts a strictly contiguous page"
  )
  do {
    try ArkEventSequenceValidator.validateReconciled(
      [
        chatEvent(8, "turn/start", .object(["turn": .number(1)])),
        chatEvent(10, "turn/end", .object(["turn": .number(1)])),
      ],
      expectedThrough: 10
    )
    check(false, "native history rejects a sequence gap before publishing it")
  } catch ArkEventSequenceValidationError.gap(expected: 9, actual: 10) {
    check(true, "native history rejects a sequence gap before publishing it")
  } catch {
    check(false, "native history reports the expected sequence-gap failure")
  }
  var catchUp = try? ArkHistoryCatchUpAccumulator(
    retained: [chatEvent(0, "turn/start", .object(["turn": .number(1)]))],
    targetSequence: 50_500
  )
  var catchUpCursor = 50_501
  while catchUp?.complete == false {
    let start = max(1, catchUpCursor - 2_048)
    let pageEvents = (start..<catchUpCursor).map { sequence in
      chatEvent(
        sequence,
        sequence.isMultiple(of: 100) ? "user/message" : "assistant/chunk",
        .object(["turn": .number(1)])
      )
    }
    let page = ArkHistoryPage(
      events: pageEvents,
      hasMore: start > 0,
      beforeSequence: start
    )
    do {
      try catchUp?.consume(page)
      catchUpCursor = catchUp?.nextBeforeSequence ?? 0
    } catch {
      catchUp = nil
    }
  }
  var caughtUpEvents: [ArkHistoryEvent]?
  if let catchUp {
    caughtUpEvents = try? catchUp.mergedPresentation()
  }
  check(
    caughtUpEvents?.count == 50_000
      && caughtUpEvents?.first?.id == 501
      && caughtUpEvents?.last?.id == 50_500
      && (catchUp?.pageCount ?? 0) > 20,
    "native reconnect crosses more than 100 messages and 50k events while retaining a bounded contiguous tail"
  )
  do {
    _ = try ArkEventSequenceValidator.olderCursor(
      for: ArkHistoryPage(
        events: [chatEvent(20, "turn/start", .object(["turn": .number(1)]))],
        hasMore: true,
        beforeSequence: 20
      ),
      requestedBefore: 20
    )
    check(false, "native older-history cursor cannot repeat the same page")
  } catch ArkEventSequenceValidationError.nonAdvancingCursor(requested: 20, returned: 20) {
    check(true, "native older-history cursor cannot repeat the same page")
  } catch {
    check(false, "native older-history reports the expected non-advancing cursor failure")
  }
  let cachedUser = chatEvent(
    70,
    "user/message",
    .object([
      "id": .string("cached-user"),
      "content": .array([.object(["type": .string("text"), "text": .string("cached")])]),
      "source": .object(["kind": .string("user")]),
    ])
  )
  let liveUser = chatEvent(
    71,
    "user/message",
    .object([
      "id": .string("live-user"),
      "content": .array([.object(["type": .string("text"), "text": .string("live")])]),
      "source": .object(["kind": .string("user")]),
    ])
  )
  var cachedProjection = ArkMessageProjection(events: [cachedUser])
  _ = cachedProjection.append(liveUser)
  check(
    cachedProjection.messages.map(\.text) == ["cached", "live"],
    "a live event during delayed or failed history extends the restored projection instead of replacing it"
  )
  check(
    ArkSubagentComposerPolicy.resolve(
      sessionOrigin: "subagent", mode: nil, parentAvailable: nil
    ) == .loading,
    "native chat fails closed while a subagent catalog is loading"
  )
  check(
    ArkSubagentComposerPolicy.resolve(
      sessionOrigin: "subagent", mode: "one-shot", parentAvailable: true
    ) == .oneShot
      && ArkSubagentComposerPolicy.resolve(
        sessionOrigin: "subagent", mode: "continuable", parentAvailable: false
      ) == .parentUnavailable,
    "native chat distinguishes one-shot and offline continuable subagents"
  )

  let metrics = ArkChatTurnMetrics.project(
    events: [
      chatEvent(100, "turn/start", .object(["turn": .number(12)])),
      chatEvent(101, "step/start", .object(["turn": .number(12), "step": .number(1)])),
      chatEvent(
        103, "assistant/chunk",
        .object([
          "turn": .number(12), "step": .number(1),
          "chunk": .object(["type": .string("text-delta"), "text": .string("a")]),
        ])),
      chatEvent(
        105, "assistant/chunk",
        .object([
          "turn": .number(12), "step": .number(1),
          "chunk": .object(["type": .string("text-delta"), "text": .string("b")]),
        ])),
      chatEvent(
        106, "assistant/message",
        .object([
          "turn": .number(12), "step": .number(1),
          "usage": .object(["outputTokens": .number(20)]),
          "message": .object([
            "id": .string("assistant-12"),
            "content": .array([.object(["type": .string("text"), "text": .string("ab")])]),
          ]),
        ])),
      chatEvent(
        110, "turn/end",
        .object([
          "turn": .number(12), "reason": .object(["kind": .string("completed")]),
        ])),
    ], turn: 12)
  check(
    metrics.runSeconds == 10
      && metrics.firstTokenSeconds == 2
      && metrics.tokensPerSecond == 10,
    "native chat derives turn duration, first-token latency, and throughput"
  )
  let projectedMetrics = ArkChatTurnMetrics.projectAll(events: [
    chatEvent(200, "turn/start", .object(["turn": .number(20)])),
    chatEvent(203, "turn/end", .object(["turn": .number(20)])),
    chatEvent(210, "turn/start", .object(["turn": .number(21)])),
    chatEvent(214, "turn/end", .object(["turn": .number(21)])),
  ])
  check(
    projectedMetrics[20]?.runSeconds == 3
      && projectedMetrics[21]?.runSeconds == 4
      && projectedMetrics.count == 2,
    "native chat projects every turn metric in one history pass"
  )
  var measuredStreams = ArkChatTurnProjection()
  func metric(_ time: Int, _ type: String, _ extra: [String: JSONValue] = [:]) -> ArkHistoryEvent {
    chatEvent(time, type, .object(extra.merging(["turn": .number(1)]) { first, _ in first }))
  }
  measuredStreams.append(contentsOf: [
    metric(1, "turn/start"), metric(2, "step/start"),
    metric(3, "assistant/chunk"), metric(5, "assistant/chunk"),
    metric(6, "assistant/message", ["usage": .object(["outputTokens": .number(20)])]),
    metric(100, "step/start"), metric(102, "assistant/chunk"), metric(104, "assistant/chunk"),
    metric(105, "assistant/message", ["usage": .object(["outputTokens": .number(20)])]),
    metric(106, "turn/end"),
  ])
  check(measuredStreams.metricsByTurn[1]?.tokensPerSecond == 10
    && measuredStreams.metricsByTurn[1]?.runSeconds == 105,
    "throughput sums completed stream durations without counting tool gaps")
  measuredStreams.append(contentsOf: [
    metric(110, "step/start"),
    metric(111, "assistant/message", ["usage": .object(["outputTokens": .number(20)])]),
  ])
  check(measuredStreams.metricsByTurn[1]?.tokensPerSecond == nil,
    "missing stream timing cannot borrow a previous call's duration")
  let retriedMetrics = ArkChatTurnMetrics.project(events: [
    metric(1, "turn/start"), metric(2, "step/start"), metric(3, "assistant/chunk"),
    metric(4, "assistant/chunk", ["chunk": .object([
      "type": .string("finish"), "reason": .object(["kind": .string("error")]),
    ])]),
    metric(102, "assistant/chunk"), metric(104, "assistant/chunk"),
    metric(105, "assistant/message", ["usage": .object(["outputTokens": .number(20)])]),
  ], turn: 1)
  check(retriedMetrics.tokensPerSecond == 10,
    "throughput excludes a failed stream and its retry backoff")

  func receipt(_ response: JSONValue?) -> ArkHistoryEvent {
    var source: [String: JSONValue] = [
      "kind": .string("model"), "provider": .string("proxy"), "model": .string("configured-alias"),
    ]
    if let response { source["replayState"] = .object(["response": response]) }
    return chatEvent(7, "assistant/message", .object([
      "turn": .number(1), "message": .object(["source": .object(source)]),
    ]))
  }
  let recordedResponse: JSONValue = .object([
    "kind": .string("pi-ai"), "version": .number(2), "model": .string("adapter-alias"),
    "responseModel": .string("server-version"), "responseId": .string("response-123"),
    "authorization": .string("must-not-display"), "thinkingSignature": .string("private-signature"),
  ])
  let recordedStatus = ArkChatStatusProjection(events: [receipt(recordedResponse)]).statuses.first
  check(recordedStatus?.body?.contains("请求型号：configured-alias") == true
    && recordedStatus?.body?.contains("服务端报告：server-version") == true
    && recordedStatus?.body?.contains("response-123") == true
    && recordedStatus?.body?.contains("must-not-display") == false
    && recordedStatus?.body?.contains("private-signature") == false,
    "invocation receipts distinguish route aliases from server reports and allowlist metadata")
  for response in [nil, .object([
    "kind": .string("pi-ai"), "version": .number(3), "responseModel": .string("unrecognized"),
  ]), .object([
    "kind": .string("pi-ai"), "version": .number(2), "model": .string("not-server-evidence"),
  ])] as [JSONValue?] {
    let body = ArkChatStatusProjection(events: [receipt(response)]).statuses.first?.body
    check(body?.contains("服务端报告：未提供可用的服务端型号记录") == true,
      "missing or unknown replay metadata never fabricates a server-reported model")
  }
  let configStatus = ArkChatStatusProjection(events: [chatEvent(2, "request/header", .object([
    "header": .object([
      "config": .object([
        "provider": .string("proxy"), "model": .string("alias"), "reasoningEffort": .string("max"),
      ]),
      "system": .string("private-system-prompt"),
    ]),
  ]))]).statuses.first
  check(configStatus?.detail == "proxy · alias · max"
    && configStatus?.body?.contains("private-system-prompt") == false,
    "invocation configuration exposes recorded reasoning without dumping the request header")
  check(
    !ArkSessionOutcomeResolver.latestIsFailure([
      (sequence: 10, failed: true),
      (sequence: 11, failed: false),
    ])
      && ArkSessionOutcomeResolver.latestIsFailure([
        (sequence: 12, failed: false),
        (sequence: 12, failed: true),
      ]),
    "native session outcome resolution clears stale red and fails closed on an equal-sequence conflict"
  )

  let rawProcessBody = "Download complete: 4 files"
  let mergeTool = ArkToolActivity(
    id: "read-20",
    sequence: 20,
    name: "read",
    turn: 1,
    arguments: "README.md",
    result: rawProcessBody,
    rawCall: .object([:])
  )
  let orderedSources = (0..<4).map { source in
    stride(from: source, to: 4_000, by: 4).map { $0 }
  }
  var orderedMergeComparisons = 0
  let orderedValues = ArkChatOrderedMerge.merge(orderedSources) { left, right in
    orderedMergeComparisons += 1
    return left < right
  }
  check(
    orderedValues == Array(0..<4_000)
      && orderedMergeComparisons <= orderedSources.count * orderedValues.count,
    "native transcript linearly merges its already ordered projections"
  )
  check(
    mergeTool.result == rawProcessBody
      && ArkL10n.text(.executionCompleted, .zh) == "完成"
      && ArkL10n.text(.executionCompleted, .en) == "Completed",
    "process shell labels localize while provider-authored process content remains verbatim"
  )
  check(
    !NativeMessageActionMountPolicy.shouldMount(
      actionsVisible: false,
      hasVisibleContent: true
    )
      && !NativeMessageActionMountPolicy.shouldMount(
        actionsVisible: true,
        hasVisibleContent: false
      )
      && NativeMessageActionMountPolicy.shouldMount(
        actionsVisible: true,
        hasVisibleContent: true
      ),
    "message actions mount only while hover or keyboard focus makes a real action available"
  )
  check(
    ArkChatLayoutResolver.transcriptWidth(
      availableWidth: 804,
      preferredWidth: 900,
      adaptive: true
    ) == 748
      && ArkChatLayoutResolver.transcriptWidth(
        availableWidth: 1_400,
        preferredWidth: 900,
        adaptive: true
      ) == 1_200
      && ArkChatLayoutResolver.transcriptWidth(
        availableWidth: 1_400,
        preferredWidth: 900,
        adaptive: false
      ) == 900
      && ArkChatLayoutResolver.transcriptWidth(
        availableWidth: 500,
        preferredWidth: 900,
        adaptive: true
      ) == 444
      && ArkChatLayoutResolver.composerWidth(
        maximumWidth: 764,
        transcriptWidth: 1_200
      ) == 764
      && ArkChatLayoutResolver.composerWidth(
        maximumWidth: 764,
        transcriptWidth: 444
      ) == 444,
    "transcript and composer widths preserve the reference baseline while fitting narrow and wide windows"
  )
  check(
    ArkStreamingPresentationPolicy.intervalNanoseconds(eventCount: 1_999) == 100_000_000
      && ArkStreamingPresentationPolicy.intervalNanoseconds(eventCount: 2_000) == 250_000_000
      && ArkStreamingPresentationPolicy.intervalNanoseconds(eventCount: 9_999) == 250_000_000
      && ArkStreamingPresentationPolicy.intervalNanoseconds(eventCount: 10_000) == 500_000_000,
    "live transcript cadence coalesces large restored ledgers without slowing short conversations"
  )
  let unicodeStream = "a👨‍👩‍👧‍👦e\u{301}"
  let boundedUnicodeStream = ArkStreamingPresentationPolicy.markdownText(
    String(repeating: "x", count: ArkStreamingPresentationPolicy.markdownCharacterLimit)
      + unicodeStream,
    streaming: true
  )
  check(
    ArkStreamingPresentationPolicy.reasoningText("abcd", streaming: true) == "abcd"
      && ArkStreamingPresentationPolicy.reasoningText(unicodeStream, streaming: false) == unicodeStream
      && ArkStreamingPresentationPolicy.markdownText(unicodeStream, streaming: false) == unicodeStream
      && boundedUnicodeStream.count
        == ArkStreamingPresentationPolicy.markdownCharacterLimit + 2
      && boundedUnicodeStream.hasSuffix(unicodeStream),
    "streaming policy bounds only live presentation, preserves complete final text, and never splits a multi-scalar grapheme"
  )
  check(
    ArkStreamingPresentationPolicy.usesStreamingAssistantPresentation(
      role: .assistant, isLatestAssistant: true, sessionRunning: true
    )
      && !ArkStreamingPresentationPolicy.usesStreamingAssistantPresentation(
        role: .assistant, isLatestAssistant: false, sessionRunning: true
      )
      && !ArkStreamingPresentationPolicy.usesStreamingAssistantPresentation(
        role: .assistant, isLatestAssistant: true, sessionRunning: false
      )
      && !ArkStreamingPresentationPolicy.usesStreamingAssistantPresentation(
        role: .user, isLatestAssistant: true, sessionRunning: true
      ),
    "only the newest assistant row stays on bounded presentation until Host-owned session liveness becomes terminal"
  )
  let completedAssistant = ArkMessage(
    id: 10, role: .assistant, text: "old", turn: 1,
    time: Date(timeIntervalSince1970: 10)
  )
  let nextPrompt = ArkMessage(
    id: 11, role: .user, text: "next", sourceKind: "user", turn: 2,
    time: Date(timeIntervalSince1970: 11)
  )
  let nextAssistant = ArkMessage(
    id: 12, role: .assistant, text: "new", turn: 2,
    time: Date(timeIntervalSince1970: 12)
  )
  check(
    ArkStreamingPresentationPolicy.liveAssistantMessageID(
      messages: [completedAssistant, nextPrompt],
      currentTurn: 2,
      turnStartSequence: 11,
      sessionRunning: true
    ) == nil
      && ArkStreamingPresentationPolicy.liveAssistantMessageID(
        messages: [completedAssistant, nextPrompt, nextAssistant],
        currentTurn: 2,
        turnStartSequence: 11,
        sessionRunning: true
      ) == 12
      && ArkStreamingPresentationPolicy.liveAssistantMessageID(
        messages: [completedAssistant, nextPrompt, nextAssistant],
        currentTurn: 2,
        turnStartSequence: 11,
        sessionRunning: false
      ) == nil
      && ArkStreamingPresentationPolicy.liveAssistantMessageID(
        messages: [ArkMessage(
          id: 20, role: .assistant, text: "restored", turn: 3,
          time: Date(timeIntervalSince1970: 20)
        )],
        currentTurn: 3,
        turnStartSequence: 19,
        sessionRunning: true
      ) == 20
      && ArkStreamingPresentationPolicy.liveAssistantMessageID(
        messages: [nextAssistant, completedAssistant, nextPrompt],
        currentTurn: 2,
        turnStartSequence: 11,
        sessionRunning: true
      ) == 12
      && ArkStreamingPresentationPolicy.liveAssistantMessageID(
        messages: [ArkMessage(
          id: 21, role: .assistant, text: "untagged",
          time: Date(timeIntervalSince1970: 21)
        )],
        currentTurn: 3,
        turnStartSequence: 19,
        sessionRunning: true
      ) == 21
      && ArkStreamingPresentationPolicy.liveAssistantMessageID(
        messages: [ArkMessage(
          id: 10, role: .assistant, text: "stale same turn", turn: 2,
          time: Date(timeIntervalSince1970: 10)
        )],
        currentTurn: 2,
        turnStartSequence: 11,
        sessionRunning: true
      ) == nil,
    "live assistant selection uses the turn-start boundary across first-token, checkpoint, restored, untagged, and reordered messages"
  )
  var liveTurnBoundary = ArkChatTurnProjection()
  liveTurnBoundary.append(chatEvent(30, "turn/start", .object(["turn": .number(4)])))
  liveTurnBoundary.append(chatEvent(31, "turn/end", .object([
    "turn": .number(4),
    "reason": .object(["kind": .string("completed")]),
  ])))
  var truncatedTurnBoundary = ArkChatTurnProjection()
  truncatedTurnBoundary.preserveLatestStartedBoundary(turn: 4, sequence: 30)
  check(
    liveTurnBoundary.latestStartedTurn == 4
      && liveTurnBoundary.latestStartedSequence == 30
      && truncatedTurnBoundary.latestStartedTurn == 4
      && truncatedTurnBoundary.latestStartedSequence == 30,
    "turn projection retains the latest authoritative run boundary through post-turn checkpointing"
  )

  let appModelURL = contractNativeRoot.appendingPathComponent(
    "Sources/JiuzhangShellUI/ArkAppModel.swift"
  )
  if let appModel = try? String(contentsOf: appModelURL, encoding: .utf8) {
    let subscribed = chatSourceSlice(
      appModel,
      from: "case \"session/subscribed\":",
      through: "case \"session/event\":"
    )
    let sessionEvents = chatSourceSlice(
      appModel,
      from: "case \"session/event\":",
      through: "case \"session/projection\":"
    )
    check(
      appModel.contains("turnMetricsByTurn[turn]")
        && appModel.contains("turnProjection.append(contentsOf: incoming)")
        && !appModel.contains("ArkChatTurnMetrics.projectAll(events: events)")
        && appModel.contains("ArkStreamingPresentationPolicy.intervalNanoseconds(")
        && appModel.contains("eventCount: events.count + pendingLiveEvents.count")
        && appModel.contains("Task.sleep(nanoseconds: intervalNanoseconds)")
        && appModel.contains("previousStartedTurn = turnProjection.latestStartedTurn")
        && appModel.contains("turnProjection.preserveLatestStartedBoundary(")
        && appModel.contains("fold.preserveLatestStartedBoundary(")
        && appModel.contains("public private(set) var events: [ArkHistoryEvent] = []")
        && appModel.contains("public var turnMetricsByTurn:")
        && appModel.contains("if messages != nextMessages")
        && appModel.contains("if toolActivities != nextToolActivities")
        && appModel.contains("if producedFiles != nextProducedFiles")
        && appModel.contains("if chatStatuses != nextChatStatuses")
        && appModel.contains("event.type == \"turn/end\"")
        && appModel.contains("if chatPresentationChanged { chatPresentationDidChange.send() }")
        && appModel.contains("historyLoadState = .loading")
        && appModel.contains("historyLoadState = .loaded")
        && appModel.contains("historyLoadState = .failed(error.localizedDescription)")
        && appModel.contains("if modelLabel != nextLabel")
        && appModel.contains("let resetHistory = self.events.isEmpty")
        && appModel.contains("async let history: Void = self.refreshHistory(resetPaging: resetHistory)")
        && appModel.contains("async let modelLabel: Void = self.refreshModelLabel(for: sessionID)")
        && appModel.contains("async let modelCatalog: Void = self.refreshModelCatalog(for: sessionID)")
        && appModel.contains("_ = await (history, feedback, modelLabel, modelCatalog)")
        && appModel.contains("private struct ArkHistoryFold: Sendable")
        && appModel.contains("Task.detached(priority: .userInitiated)")
        && appModel.contains("historyProjectionGeneration == generation")
        && appModel.contains("fold.appendLive(pendingLiveEvents)")
        && appModel.contains("guard livePublishTask == nil, !historyFoldInFlight")
        && appModel.contains("private struct ArkConversationSurfaceSnapshot")
        && appModel.contains("let events: [ArkHistoryEvent]")
        && appModel.contains("let messageProjection: ArkMessageProjection")
        && appModel.contains("events = snapshot.events")
        && appModel.contains("messageProjection = snapshot.messageProjection")
        && appModel.contains("historyBeforeSequence = snapshot.historyBeforeSequence")
        && appModel.contains("while conversationSurfaceSnapshotOrder.count > 2")
        && appModel.contains("restoreConversationSurface(for: sessionID)")
        && appModel.contains("removeConversationSurfaceSnapshot(for: deletedID)")
        && !appModel.contains("chatFlowRevision")
        && !appModel.contains("@Published public private(set) var events")
        && !appModel.contains("@Published public private(set) var turnMetricsByTurn")
        && !appModel.contains("ArkChatTurnMetrics.project(events: events, turn: turn)"),
      "native live projection adaptively coalesces long ledgers, settles usage at turn end, and wakes SwiftUI only for changed projections"
    )
    check(
      sessionEvents?.contains("reconcileSessionRunning") == false
        && appModel.contains("case \"host/session-status\":")
        && appModel.contains("reconcileSessionRunning(sessionID: sessionID, running: running)"),
      "native session liveness remains Host-status-owned through post-turn checkpointing"
    )
    let refreshHistory = chatSourceSlice(
      appModel,
      from: "public func refreshHistory(resetPaging: Bool = false) async",
      through: "public func loadOlderHistory() async"
    )
    let loadOlderHistory = chatSourceSlice(
      appModel,
      from: "public func loadOlderHistory() async",
      through: "private func loadMessageFeedback(for sessionID: String) async"
    )
    let refreshGenerationRange = refreshHistory?.range(of: "historyProjectionGeneration &+= 1")
    let refreshPageRange = refreshHistory?.range(
      of: "let synchronized = try await synchronizedHistorySource("
    )
    let olderGenerationRange = loadOlderHistory?.range(of: "historyProjectionGeneration &+= 1")
    let olderPageRange = loadOlderHistory?.range(of: "let page = try await historyPage(")
    let olderPauseRange = loadOlderHistory?.range(of: "livePublishTask?.cancel()")
    check(
      refreshHistory?.contains("var chatPresentationChanged = false") == true
        && refreshHistory?.contains("if messages != nextMessages") == true
        && refreshHistory?.contains("if toolActivities != nextTools") == true
        && refreshHistory?.contains("if chatPresentationChanged { chatPresentationDidChange.send() }") == true
        && refreshHistory?.contains("ArkHistoryFoldWorker.shared.fold(") == true
        && refreshHistory?.contains("Task.detached(priority: .userInitiated)") == false
        && refreshHistory?.contains("!Task.isCancelled") == true
        && refreshHistory?.contains("let installedEventIDs = Set(fold.events.map(\\.id))") == true
        && refreshHistory?.contains("pendingLiveEvents.removeAll { installedEventIDs.contains($0.id) }") == true
        && refreshHistory?.contains("pendingLiveEvents.removeAll(keepingCapacity: true)") == false,
      "authoritative history refresh does not republish an unchanged transcript"
    )
    check(
      appModel.contains("let completeTurnProjection = ArkChatTurnProjection(events: ordered)")
        && appModel.contains("turn: completeTurnProjection.latestStartedTurn")
        && appModel.contains("sequence: completeTurnProjection.latestStartedSequence")
        && appModel.contains("private struct ArkHistoryFoldOwner: Equatable")
        && appModel.contains("private actor ArkHistoryFoldWorker")
        && appModel.contains("ArkHistoryFoldWorker.shared.fold(")
        && appModel.contains("private var historyFoldOwner: ArkHistoryFoldOwner?")
        && appModel.contains("private var historyRefreshOwner: ArkHistoryFoldOwner?")
        && appModel.contains("private var olderHistoryLoadOwner: ArkHistoryFoldOwner?")
        && appModel.contains("private var historyFoldInFlight: Bool { historyFoldOwner != nil }")
        && appModel.contains("historyFoldOwner == foldOwner")
        && appModel.contains("if historyFoldOwner == foldOwner")
        && appModel.contains("historyFoldInFlight = true") == false
        && refreshGenerationRange != nil
        && refreshPageRange != nil
        && refreshGenerationRange!.lowerBound < refreshPageRange!.lowerBound
        && refreshHistory?.contains("let requestOwner = ArkHistoryFoldOwner(") == true
        && refreshHistory?.contains("historyRefreshOwner == requestOwner") == true
        && refreshHistory?.contains("historyLoadState == .loading") == true
        && refreshHistory?.contains("historyLoadState = .afterCancellation") == true
        && refreshHistory?.contains("historyFoldOwner = nil") == true
        && loadOlderHistory?.contains("livePublishTask?.cancel()") == true
        && olderGenerationRange != nil
        && olderPageRange != nil
        && olderPauseRange != nil
        && olderGenerationRange!.lowerBound < olderPageRange!.lowerBound
        && olderPageRange!.lowerBound < olderPauseRange!.lowerBound
        && loadOlderHistory?.contains("historyProjectionGeneration &+= 1") == true
        && loadOlderHistory?.contains("let foldOwner = ArkHistoryFoldOwner(") == true
        && loadOlderHistory?.contains("historyFoldOwner == foldOwner") == true
        && loadOlderHistory?.contains("let loadOwner = ArkHistoryFoldOwner(") == true
        && loadOlderHistory?.contains("olderHistoryLoadOwner == loadOwner") == true
        && loadOlderHistory?.contains("historyRefreshOwner = nil") == true
        && loadOlderHistory?.contains("loadingOlderHistory = false") == true
        && loadOlderHistory?.contains("ArkHistoryFoldWorker.shared.fold(") == true
        && loadOlderHistory?.contains("Task.detached(priority: .userInitiated)") == false
        && loadOlderHistory?.contains("fold.preserveLatestStartedBoundary(") == true
        && loadOlderHistory?.contains("let installedEventIDs = Set(fold.events.map(\\.id))") == true
        && loadOlderHistory?.contains("pendingLiveEvents.removeAll { installedEventIDs.contains($0.id) }") == true
        && loadOlderHistory?.contains("historyLoadState = .loaded") == true
        && loadOlderHistory?.contains("turnProjection = ArkChatTurnProjection(events: events)") == false,
      "cold restore and older-page folding preserve the full-history run boundary before bounded event retention"
    )
    let refreshNavigation = chatSourceSlice(
      appModel,
      from: "public func refreshNavigation(refreshWiki: Bool = true) async",
      through: "public func selectSession("
    )
    check(
      refreshNavigation?.contains("if workspaces != nextWorkspaces") == true
        && refreshNavigation?.contains("if sessions != nextSessions") == true
        && refreshNavigation?.contains("busy = true") == false
        && !appModel.contains("@Published public private(set) var busy = false"),
      "navigation refresh publishes only changed rows and owns no unused global busy pulse"
    )
    check(
      subscribed?.contains("let resetHistory = self.events.isEmpty") == true
        && subscribed?.contains("self.refreshHistory(resetPaging: resetHistory)") == true
        && subscribed?.contains("self.refreshSubscribedModelMetadata(for: sessionID)") == true
        && subscribed?.contains("_ = await (history, feedback, modelMetadata)") == true
        && subscribed?.contains("self.refreshHistory(resetPaging: true)") == false,
      "native session resubscribe preserves the transcript and rehydrates its model capability metadata"
    )
    check(
      appModel.contains("@Published public private(set) var eventConnectionStates")
        && appModel.contains("@Published public private(set) var eventConnectionErrors")
        && appModel.contains("case \"stream/state\":")
        && appModel.contains("case \"stream/baseline\":")
        && appModel.contains("eventBaselineGenerationByChannel[frame.channel] == generation")
        && appModel.contains("scheduleNavigationRefresh()")
        && appModel.contains("case \"stream/error\":")
        && appModel.contains("markEventChannelDegraded(frame.channel")
        && appModel.contains("private func synchronizedHistorySource(")
        && appModel.contains("var catchUp = try ArkHistoryCatchUpAccumulator(")
        && appModel.contains("while !catchUp.complete")
        && refreshHistory?.contains("ArkEventSequenceValidator.validateReconciled(") == true
        && loadOlderHistory?.contains("ArkEventSequenceValidator.olderCursor(") == true
        && loadOlderHistory?.contains("ArkEventSequenceValidator.validateReconciled(") == true,
      "native baseline completion reconciles zero-session navigation and exposes protocol or sequence failures"
    )
    let modelHydration = chatSourceSlice(
      appModel,
      from: "private func refreshSubscribedModelMetadata(for sessionID: String) async",
      through: "private func consume(_ frame: ArkEventFrame)"
    )
    check(
      modelHydration?.contains("guard modelMetadataHydrationSessionID != sessionID else { return }") == true
        && modelHydration?.contains("modelMetadataHydrationSessionID = sessionID") == true
        && modelHydration?.contains("async let label: Void = refreshModelLabel(for: sessionID)") == true
        && modelHydration?.contains("async let catalog: Void = refreshModelCatalog(for: sessionID)") == true,
      "native subscribed model hydration is single-flight per session and cannot recurse through subscribed frames"
    )
  } else {
    check(false, "native app model source is readable for turn-metric cache contract")
  }

  let rootURL = contractNativeRoot.appendingPathComponent(
    "Sources/JiuzhangShellUI/ArkRootView.swift"
  )
  if let root = try? String(contentsOf: rootURL, encoding: .utf8) {
    let transcriptFeed = chatSourceSlice(
      root,
      from: "private final class NativeChatTranscriptFeed",
      through: "private struct NativeChatView"
    )
    let chatView = chatSourceSlice(
      root,
      from: "private struct NativeChatView",
      through: "private struct NativeMessageRow"
    )
    let chatEntry = chatSourceSlice(
      root,
      from: "private enum NativeChatEntry",
      through: "private struct NativeChatStatusRow"
    )
    let orderedMerge = chatSourceSlice(
      root,
      from: "enum ArkChatOrderedMerge",
      through: "private enum NativeChatEntry"
    )
    let messageRow = chatSourceSlice(
      root,
      from: "private struct NativeMessageRow",
      through: "private struct NativeMessageBlockView"
    )
    let reasoningBlock = chatSourceSlice(
      root,
      from: "private struct NativeReasoningBlock",
      through: "private struct NativeContextMessageRow"
    )
    let systemPromptRow = chatSourceSlice(
      root,
      from: "private struct NativeSystemPromptRow",
      through: "private struct NativeMessageRow"
    )
    let messageActions = chatSourceSlice(
      root,
      from: "private struct NativeMessageActions",
      through: "struct NativeMessageImages: View"
    )
    let streamingMarkdown = chatSourceSlice(
      root,
      from: "private struct NativeStreamingMarkdownText",
      through: "@MainActor\nprivate final class NativeWikiFeed"
    )
    let statusRow = chatSourceSlice(
      root,
      from: "private struct NativeChatStatusRow",
      through: "private struct NativeSubagentTaskRow"
    )
    let toolRow = chatSourceSlice(
      root,
      from: "private struct NativeToolRow",
      through: "private struct NativeComposer"
    )
    let bubbleRange = messageRow?.range(of: "isUser ? ArkPalette.bubble : Color.clear")
    let actionsRange = messageRow?.range(of: "NativeMessageActions(")

    check(
      chatView?.contains("ChatLayoutMetrics.contentColumnMaxWidth") == true
        && chatView?.contains("NativeLegacyContextBar") == false
        && chatView?.contains("NativeComposer(model: model)") == true
        && chatView?.contains("NativeSessionStatsBar(model: model)") == true
        && chatView?.contains("HSplitView") == false
        && chatView?.contains("NativeDetailsPlaceholder") == false
        && chatView?.contains("detailsVisible") == false,
      "native chat centers transcript controls in one compact column and keeps tool detail inline"
    )
    check(
      transcriptFeed?.contains("model.$historyLoadState.removeDuplicates()") == true
        && chatView?.contains("switch context.historyLoadState") == true
        && chatView?.contains("case .idle, .loaded:") == true
        && chatView?.contains("ark.chat.history.retry") == true
        && chatView?.contains("Task { await model.refreshHistory(resetPaging: true) }") == true,
      "native empty history distinguishes loading loaded-empty and failed states without a permanent spinner"
    )
    check(
      transcriptFeed?.contains("Publishers.MergeMany(triggers)") == true
        && transcriptFeed?.contains(".throttle(for: .milliseconds(100)") == true
        && transcriptFeed?.contains("NativeChatEntry.merge(") == true
        && chatView?.contains("transcriptFeed.snapshot.entries") == true
        && chatView?.contains("model.messages.map(NativeChatEntry.message)") == false
        && chatView?.contains(".sorted {") == false
        && chatEntry?.contains("enum NativeChatEntry: Identifiable, Equatable") == true
        && chatEntry?.contains("ArkChatOrderedMerge.merge(sources)") == true
        && orderedMerge?.contains("result.reserveCapacity(") == true
        && orderedMerge?.contains("while true {") == true,
      "native chat coalesces live projections at a responsive 10Hz and linearly merges ordered entries instead of sorting every body update"
    )
    check(
      chatView?.contains("let projection = bodyProjection") == true
        && root.contains("final class NativeProjectionMemo<Key: Equatable, Value>: ObservableObject")
        && root.contains("struct NativeChatProjectionKey: Equatable")
        && chatView?.contains("@StateObject private var projectionMemo") == true
        && chatView?.contains("sessionRunning: context.sessionRunning") == true
        && chatView?.contains("feedbackByID: context.feedbackByID") == true
        && chatView?.contains("turnMetricsByTurn: context.turnMetricsByTurn") == true
        && chatView?.contains("turnUsageByTurn: context.turnUsageByTurn") == true
        && chatView?.contains("completedTurns: context.completedTurns") == true
        && chatView?.contains("latestAssistantMessageID: context.latestAssistantMessageID") == true
        && chatView?.contains("compactProcess: compactProcess") == true
        && chatView?.contains("@State private var projectionCache") == false
        && chatView?.contains("projectionCache =") == false
        && chatView?.contains("var entriesByTurn: [Int: [NativeChatEntry]]") == true
        && chatView?.contains("var entryByID: [String: NativeChatEntry]") == true
        && chatView?.contains("for (turn, answerID) in finalAnswerByTurn") == true
        && chatView?.contains("(entriesByTurn[turn] ?? []).filter") == true
        && chatView?.contains("for turn in navigationTurns.sorted()") == true
        && chatView?.contains("ForEach(projection.displayEntries)") == true
        && chatView?.contains("turnAnchorByTurn: projection.turnAnchorByTurn") == true
        && chatView?.contains("ForEach(displayEntries)") == false
        && chatView?.contains("entries.first(where:") == false
        && chatView?.contains("let turnEntries = entries.filter") == false,
      "native long conversations derive display entries and turn navigation through one linear body projection"
    )
    check(
      messageRow?.contains("isUser ? ArkPalette.bubble : Color.clear") == true
        && messageRow?.contains("actionsVisible: true") == true
        && messageRow?.contains(".onHover { hovering = $0 }") == false
        && messageRow?.contains("@FocusState private var actionsFocused") == false
        && bubbleRange != nil
        && actionsRange != nil
        && bubbleRange!.lowerBound < actionsRange!.lowerBound
        && messageRow?.contains("ChatLayoutMetrics.userBubbleMaxWidth") == true
        && messageRow?.contains("ChatLayoutMetrics.userBubbleCornerRadius") == true
        && messageRow?.contains(".fixedSize(horizontal: false, vertical: true)") == true
        && messageRow?.contains(".layoutPriority(1)") == true
        && messageRow?.contains("if !isUser { Spacer(minLength: 96) }") == false,
      "native transcript keeps assistant content borderless and places persistent actions outside the restrained user bubble"
    )
    check(
      root.contains("NativeTranscriptTextSelectionModifier") == false
        && chatView?.contains("transcriptTextSelectionEnabled") == false
        && chatView?.contains(".textSelection(.enabled)") == false
        && messageRow?.contains(".textSelection(.enabled)") == false
        && statusRow?.contains(".textSelection(.enabled)") == false,
      "native transcript never installs SelectionOverlay on the long LazyVStack or its message/status rows"
    )
    check(
      messageRow?.contains("ArkStreamingPresentationPolicy.usesStreamingAssistantPresentation(") == true
        && messageRow?.contains("presentation.isLatestAssistant") == true
        && messageRow?.contains("message.messageID == nil") == false
        && root.contains("ArkStreamingPresentationPolicy.liveAssistantMessageID(")
        && root.contains("currentTurn: model.latestStartedTurn")
        && root.contains("turnStartSequence: model.latestStartedTurnSequence")
        && root.contains("isLatestAssistant: message.id == latestAssistantMessageID")
        && messageRow?.contains("NativeStreamingMarkdownText(") == true
        && messageRow?.contains("streaming: isStreamingAssistant") == true
        && streamingMarkdown?.contains("NativeMarkdownDocument(") == true
        && streamingMarkdown?.contains("ArkStreamingPresentationPolicy.markdownText(text, streaming: true)") == true
        && streamingMarkdown?.contains("regions.stable") == false
        && streamingMarkdown?.contains("private func partition") == false
        && reasoningBlock?.contains("ArkStreamingPresentationPolicy.reasoningText") == true
        && reasoningBlock?.contains("ArkStreamingPresentationPolicy.reasoningLineLimit") == true,
      "native streaming chat sends only policy-bounded answer and reasoning inputs into layout before canonical final content"
    )
    check(
      messageActions?.contains("NativeMessageActionMountPolicy.shouldMount(") == true
        && messageActions?.contains(".opacity(actionsVisible && hasVisibleContent") == false
        && messageActions?.contains(".accessibilityHidden(!(actionsVisible && hasVisibleContent))") == false
        && messageActions?.contains("Text(actionTail)") == true
        && messageActions?.contains("presentation.feedbackAvailable") == true
        && messageRow?.contains("@FocusState private var actionsFocused: Bool") == false
        && messageRow?.contains(".focusable()") == false
        && messageRow?.contains(".focused($actionsFocused)") == false
        && messageRow?.contains("actionsVisible: true") == true
        && messageRow?.contains("ark.chat.message.\\(message.messageID ?? String(message.id))") == true,
      "native transcript keeps one visible action strip whose buttons own keyboard and accessibility focus"
    )
    check(
      toolRow?.contains("activity.callView") == true
        && toolRow?.contains("activity.resultView") == true
        && toolRow?.contains("if expanded {") == true
        && toolRow?.contains(".onHover { hovering = $0 }") == true
        && toolRow?.contains("ArkPalette.raised.opacity(0.56)") == true
        && toolRow?.contains("Label(\"Inspect\"") == false
        && toolRow?.contains("callPresentation?[") == false
        && toolRow?.contains("resultPresentation?[") == false,
      "native transcript uses hover-aware typed tool rows and expands canonical presentation inline only on demand"
    )
    check(
      root.contains("static let contentColumnMaxWidth: CGFloat = 748")
        && root.contains("static let composerMaxWidth: CGFloat = 764")
        && root.contains("static let entrySpacing: CGFloat = 16")
        && root.contains("static let messageFontSize: CGFloat = 16")
        && root.contains("ArkChatLayoutResolver.transcriptWidth(")
        && root.contains("ArkChatLayoutResolver.composerWidth(")
        && root.contains(".frame(width: contentWidth)")
        && root.contains(".padding(.bottom, ChatLayoutMetrics.statsBarBottomInset)"),
      "native chat keeps the baseline transcript and a responsive reference-ratio composer"
    )
    check(
      root.contains("private struct NativeChatDisplaySettingsPanel: View")
        && root.contains("NativeChatDisplaySettingsPanel(")
        && root.contains("showDisplayControls = true")
        && !root.contains("private struct NativeChatDisplayToolbar: View")
        && !root.contains("ark.chat.display-toolbar")
        && !root.contains("settingsGroup(title: .groupChatDisplayTitle"),
      "native conversation display preferences have one owner in the session actions menu"
    )
    check(
      root.contains("private struct NativeTurnProcessRow<Content: View>: View")
        && root.contains("process.detailEntries")
        && root.contains("process.reasoningText")
        && root.contains(".chatTurnProcessShowMore")
        && root.contains(".lineLimit(expanded ? nil : 4)")
        && root.contains("hideReasoning: hidesFinalReasoning(entry, finalAnswerByTurn: finalAnswerByTurn)")
        && root.contains("if process.hiddenEntryIDs.contains(entry.id)")
        && !root.contains("if !expandedProcessGenerations.contains(process.generation), process.hiddenEntryIDs.contains(entry.id)")
        && root.contains("ark.chat.turn-process.toggle.\\(process.turn)")
        && root.contains(".accessibilityHint(processSummary)")
        && !root.contains(".accessibilityValue(\n      ArkL10n.text(expanded ? .chatTurnProcessCollapse"),
      "completed-turn metadata and reasoning render inside one bounded show-more process card"
    )
    check(
      systemPromptRow?.contains(".chatSystemPromptExpand") == true
        && systemPromptRow?.contains(".chatSystemPromptCollapse") == true
        && systemPromptRow?.contains(".chatTurnProcessExpand") == false
        && systemPromptRow?.contains(".accessibilityValue(") == false
        && systemPromptRow?.contains("ark.chat.system-prompt.toggle.\\(message.id)") == true,
      "system prompt and answer process expose distinct single-owner AX expansion actions"
    )
    check(
      root.contains("ZStack(alignment: .leading)")
        && root.contains("items: projection.navigationItems")
        && root.contains("private struct NativeChatTurnNavigationPreview: View")
        && root.contains(".frame(width: hoveredTurn == item.turn ? 22 : 12, height: 2)")
        && root.contains(".offset(x: 36)")
        && root.contains(".padding(.leading, 8)")
        && root.contains("var explicitPromptByTurn: [Int: ArkMessage]")
        && root.contains("var untaggedPrompts: [ArkMessage]")
        && root.contains("var untaggedPromptIndex = 0")
        && root.contains("let prompt = explicitPromptByTurn[turn] ?? untaggedPrompt")
        && root.contains("private func navigationTitle(")
        && root.contains("private func navigationDetail(")
        && root.contains(".lineLimit(6)")
        && root.contains(".frame(width: 320, alignment: .leading)")
        && root.contains("hoverGeneration"),
      "native turn navigation uses left-edge markers with question and answer previews"
    )
    check(
      !root.contains(".frame(minWidth: 111, minHeight: 32)")
        && root.contains("NativeFirstMouseIconButton(")
        && root.contains("action: toggleWorkbenchPanel")
        && root.contains("ark.global.workbench-toggle")
        && root.contains("NativeConversationWorkbenchLauncher(")
        && root.contains("exportSessionLog"),
      "native chat drops the Session log capsule and opens its contextual Workbench launcher"
    )
    check(
      root.contains("ark.global.session-actions")
        && !root.contains("ark.session.open-workbench")
        && !root.contains("Label(ArkL10n.text(.workbench, model.languagePreference)")
        && !root.contains("归档这个会话？"),
      "native chat keeps an icon-only Workbench action and archives without confirmation"
    )
    check(
      root.contains(".queueCount")
        && root.contains("model.selectedSession?.origin != \"subagent\""),
      "native chat exposes the collapsed queue count and hides subagent mutations"
    )
    check(
      root.contains("static let userBubbleMaxWidth: CGFloat = 525")
        && root.contains("static let userBubbleCornerRadius: CGFloat = 22")
        && root.contains("baseFontSize: baseFontSize")
        && root.contains(".fixedSize(horizontal: false, vertical: true)")
        && root.contains(".frame(width: 28, height: 28)"),
      "native chat keeps a capped semantic user bubble, readable message type, and 28pt actions"
    )
    check(
      !root.contains("Label(\"待插话\"")
        && root.contains(
          ".background(ArkPalette.bubble, in: RoundedRectangle(cornerRadius: 22))"
        )
        && root.contains("minHeight: hero ? 40 : 68")
        && root.contains("idealHeight: hero ? 40 : 76")
        && root.contains("maxHeight: hero ? 96 : 144")
        && root.contains(".shadow(color: Color.black.opacity(0.14), radius: 10, y: 4)")
        && !root.contains("workspaceUnavailable")
        && !root.contains("请选择工作区"),
      "native chat reuses an undecorated steering bubble and a compact floating phase-bounded composer"
    )
    check(
      root.contains("Button(action: chooseWorkspaceDirectory)")
        && !root.contains("$0.id != \"jiuzhang\"")
        && root.contains("private var workbenchSurface: some View")
        && root.contains("NativeConversationWorkbenchLauncher(")
        && root.contains("showWorkbench.toggle()")
        && !root.contains(".offset(y: -70)")
        && !root.contains("ark.workbench.width"),
      "native new chat anchors its real composer at the bottom and toggles a persistent contextual Workbench side panel"
    )
    check(
      root.contains("NativeSessionActivityIndicator(model: model, state: indicatorState)")
        && root.contains("case idle")
        && root.contains("case running")
        && root.contains("case needsDecision")
        && root.contains("case failed")
        && root.contains(".sessionActivityNeedsDecision"),
      "native chat exposes gray, pulsing green, yellow decision, and red failure session states"
    )
    check(
      statusRow?.contains("TimelineView(.periodic(from: .now, by: 1))") == true
        && statusRow?.contains("status.retry?.state == .scheduled") == true
        && statusRow?.contains("retryCountdownScheduled && retryDeadline != nil") == true
        && statusRow?.contains("synchronizeRetryDeadline") == true
        && statusRow?.contains("DispatchQueue.main.asyncAfter(deadline: .now() + delaySeconds)") == true
        && statusRow?.contains("guard retrySequence == sequence else { return }") == true
        && statusRow?.contains("retryDeadline = nil") == true
        && statusRow?.contains("TimelineView(.periodic(from: .now, by: 0.25))") == false
        && statusRow?.contains("ArkL10n.text(.executionRunning, language)") == true
        && statusRow?.contains("case .running: return \"运行中\"") == false,
      "native retry countdown ticks once per second, expires once, and all lifecycle labels use the selected language"
    )
    check(
      root.contains("let latestOutcomes: [(sequence: Int, failed: Bool)]")
        && root.contains("model.toolActivities.max")
        && root.contains("model.chatStatuses.max")
        && root.contains("model.messages.max")
        && root.contains("ArkSessionOutcomeResolver.latestIsFailure(latestOutcomes)"),
      "native session light resolves the globally latest message/tool/status outcome instead of retaining stale failure red"
    )
    check(
      !root.contains("NativeLegacyContextBar")
        && !root.contains("purpose/schema 上下文")
        && root.contains("Label(model.composerPermissionLabel, systemImage: \"shield\")")
        && root.contains("Image(systemName: \"paperclip\")")
        && root.contains(".statsToolCalls,")
        && root.contains(".statsFirstTokenAverage,")
        && root.contains(".statsCacheHit,")
        && root.contains(".statsInputOutput,")
        && root.contains("arkRelativeTimestamp(date, language: model.languagePreference)")
        && root.contains("uncachedInputTokens")
        && root.contains("groups.joined(separator: \" | \")"),
      "active chat keeps implementation context out of the visible shell while retaining composer controls and run metrics"
    )
    check(
      root.contains("if model.composer.isEmpty && !composerHasMarkedText")
        && root.contains("hero ? .composerHeroPlaceholder : .composerPlaceholder")
        && root.contains("isComposing: $composerHasMarkedText")
        && root.contains("ArkL10n.text(.newConversationAddWorkspace, model.languagePreference)")
        && root.contains("ArkL10n.text(.composerAttach, model.languagePreference)")
        && root.contains("ArkL10n.text(.composerStop, model.languagePreference)")
        && root.contains("? .composerSend : .composerChooseAvailableModel")
        && !root.contains("Text(hero ? \"描述你想要构建的内容\" : \"给智能体发消息\")"),
      "native composer localizes its controls and hides its placeholder throughout IME marked-text composition"
    )
  } else {
    check(false, "native chat source is readable for visual contract checks")
  }

  let markdownURL = contractNativeRoot.appendingPathComponent(
    "Sources/JiuzhangShellUI/NativeMarkdownGFMView.swift"
  )
  if let markdown = try? String(contentsOf: markdownURL, encoding: .utf8) {
    let codeBlock = chatSourceSlice(
      markdown,
      from: "private struct NativeGFMCodeBlock",
      through: "private struct NativeGFMTableView"
    )
    check(
      codeBlock?.contains(".textSelection(.enabled)") == false
        && codeBlock?.contains("NSPasteboard.general.setString(source, forType: .string)") == true
        && codeBlock?.contains("copied = true") == true,
      "chat Markdown code blocks avoid SelectionOverlay while retaining the explicit copy action"
    )
  } else {
    check(false, "native Markdown source is readable for chat selection contract")
  }

  let modelURL = contractNativeRoot.appendingPathComponent(
    "Sources/JiuzhangShellUI/ArkAppModel.swift"
  )
  if let model = try? String(contentsOf: modelURL, encoding: .utf8) {
    check(
      model.contains("public func beginNewConversation()")
        && model.contains("selectedWorkspaceID = nil")
        && !model.contains("if selectedWorkspaceID == nil { selectedWorkspaceID = workspaces.first?.id }"),
      "native new conversation stays ungrouped until the first real submit"
    )
    check(
      model.contains("ArkL10n.permissionPresetLabel(raw, languagePreference)")
        && !model.contains("case \"danger-full-access\": return \"完全访问\""),
      "composer permission labels use the same selected language as Settings"
    )
    check(
      model.contains("try await registerKnowledgeProject(")
        && model.contains("_ = try? await client.deleteWorkspace(workspaceID: workspace.id)")
        && model.contains("selectedKnowledgeProjectPath = workspace.path")
        && model.contains("if !archivedSessionIDs.contains(sessionID)")
        && model.contains("client.archiveSession(sessionID: sessionID)")
        && model.contains("client.deleteArchivedSession(sessionID: sessionID)")
        && model.contains("method: \"knowledgeWiki/removeProject\"")
        && model.contains("client.deleteWorkspace(workspaceID: workspaceID)")
        && !model.contains("trashItem(at:"),
      "workspace lifecycle creates one path-owned Wiki project and removes chats plus Wiki registration while preserving local files"
    )
    let feedbackMutations = chatSourceSlice(
      model,
      from: "public func setMessageFeedback(",
      through: "public func cancelSelectedSession()"
    )
    check(
      model.contains("messageFeedbackAvailable = true")
        && model.contains("messageFeedbackAvailable = false")
        && feedbackMutations?.contains("await loadMessageFeedback(for: sessionID)") == true
        && feedbackMutations?.contains("messageFeedbackAvailable = false") == false
        && feedbackMutations?.contains("errorMessage =") == false,
      "optional message feedback is capability-gated and mutation conflicts reload without disabling a healthy route or using the global error toast"
    )
    check(
      model.contains("private func markTrajectoryProjectionDirty()")
        && model.contains("private func scheduleTrajectoryProjectionIfNeeded()")
        && model.contains("Task.detached(priority: .userInitiated)")
        && model.contains("trajectoryProjectionTask == nil")
        && model.contains("trajectoryProjectionGeneration == generation")
        && model.contains("selectedSessionID == sessionID")
        && !model.contains("trajectoryRecords = ArkTrajectoryProjection.records(from: events)"),
      "native Chat never refolds the full Trajectory ledger on the main thread for every live event"
    )
  } else {
    check(false, "native app model source is readable for ungrouped draft checks")
  }

  let composerURL = contractNativeRoot.appendingPathComponent(
    "Sources/JiuzhangShellUI/NativeComposerTextView.swift"
  )
  if let composer = try? String(contentsOf: composerURL, encoding: .utf8) {
    check(
      composer.contains("@Binding var isComposing: Bool")
        && composer.contains("override func setMarkedText(")
        && composer.contains("onCompositionChanged?(hasMarkedText())")
        && composer.contains("if !editor.hasMarkedText(), editor.string != text")
        && composer.contains("guard !composing else { return }")
        && composer.contains("override func unmarkText()")
        && composer.contains("enum NativeComposerSubmitAction: Equatable")
        && composer.contains("hasMarkedText: composing")
        && composer.contains("case .submitAlternate:")
        && !composer.contains("override func firstRect("),
      "native composer exposes IME state while preserving NSTextView candidate-window geometry and submit guards"
    )
    runNativeComposerIMEBehaviorChecks()
  } else {
    check(false, "native composer text source is readable")
  }

  let workbenchURL = contractNativeRoot.appendingPathComponent(
    "Sources/JiuzhangShellUI/NativeWorkbenchView.swift"
  )
  if let workbench = try? String(contentsOf: workbenchURL, encoding: .utf8) {
    check(
      workbench.contains("NativeWorkbenchTabBar")
        && workbench.contains("NativeFileTabStrip")
        && workbench.contains("ArkL10n.text(.filesPathPlaceholder")
        && workbench.contains(".onSubmit(model.openEnteredPath)")
        && workbench.contains("ArkL10n.text(.filesSearchPlaceholder")
        && workbench.contains("browserWidthFraction: CGFloat = 0.40")
        && workbench.contains("GeometryReader { proxy in")
        && !workbench.contains("HSplitView")
        && workbench.contains("NativeWorkbenchStatus")
        && workbench.contains("func exportSelectedFile()")
        && workbench.contains("NativePTYTerminalView(")
        && workbench.contains("terminalSession(for: activeTab.id)"),
      "native workbench restores Files tabs, path open, searchable tree, responsive split, and persistent terminal"
    )
  } else {
    check(false, "native workbench source is readable for legacy layout checks")
  }

  let trajectoryURL = contractNativeRoot.appendingPathComponent(
    "Sources/JiuzhangShellUI/NativeTrajectoryParityView.swift"
  )
  if let trajectory = try? String(contentsOf: trajectoryURL, encoding: .utf8) {
    check(
      trajectory.contains("readablePayload(")
        && trajectory.contains("record.input ?? ArkL10n.text(.trajectoryInputMissing, language)")
        && trajectory.contains("完整技能清单与原始内容已收纳到“原始 JSON”")
        && trajectory.contains("NativeRawJSONTextView(text: ArkTrajectoryProjection.detailJSON(for: record))"),
      "trajectory input and output summarize long context while raw JSON preserves full evidence"
    )
  } else {
    check(false, "native trajectory source is readable for inspector hierarchy checks")
  }

  if let root = try? String(contentsOf: rootURL, encoding: .utf8) {
    check(
      root.contains("移除 30FPS 持续 tick")
        && !root.contains("TimelineView(.animation(minimumInterval: 1.0 / 30.0))")
        && !root.contains("angularVelocity")
        && !root.contains("节点持续演化")
        && root.contains("nodePositions(size: geometry.size)"),
      "native wiki graph keeps the static orbital node field without a 30FPS layout loop or perpetual-motion residue"
    )
  }

  check(
    ArkChatSubmissionPolicy.shouldSteerWholeQueue(
      draft: "  ", pendingImageCount: 0, sessionRunning: true,
      sessionOrigin: nil, queuedCount: 3
    ),
    "native chat empty alternate submission accelerates the whole running queue"
  )
  check(
    !ArkChatSubmissionPolicy.shouldSteerWholeQueue(
      draft: "next", pendingImageCount: 0, sessionRunning: true,
      sessionOrigin: nil, queuedCount: 3
    )
      && !ArkChatSubmissionPolicy.shouldSteerWholeQueue(
        draft: "", pendingImageCount: 0, sessionRunning: true,
        sessionOrigin: "subagent", queuedCount: 3
      ),
    "native chat queue acceleration refuses a real draft and subagent queues"
  )

  let navigationMessages = [
    ArkMessage(
      id: 1, role: .user, text: "旧问题", sourceKind: "user", turn: 1,
      time: Date(timeIntervalSince1970: 1)
    ),
    ArkMessage(
      id: 3, role: .assistant, text: "旧回答", turn: 1,
      time: Date(timeIntervalSince1970: 3)
    ),
    ArkMessage(
      id: 4, role: .user, text: "你好", sourceKind: "user",
      time: Date(timeIntervalSince1970: 4)
    ),
    ArkMessage(
      id: 6, role: .assistant, text: "你好！", turn: 2,
      time: Date(timeIntervalSince1970: 6)
    ),
  ]
  check(
    ArkChatTurnNavigationProjection.prompt(
      for: 2,
      firstTurnSequence: 5,
      after: 3,
      messages: navigationMessages
    )?.id == 4,
    "turn navigation associates the nearest unscoped user prompt with the following turn"
  )
  check(
    ArkChatTurnNavigationProjection.prompt(
      for: 2,
      firstTurnSequence: 5,
      after: 3,
      messages: navigationMessages + [ArkMessage(
        id: 5, role: .user, text: "显式问题", sourceKind: "user", turn: 2,
        time: Date(timeIntervalSince1970: 5)
      )]
    )?.text == "显式问题",
    "turn navigation prefers an explicitly tagged prompt over its unscoped fallback"
  )

  var projection = ArkChatStatusProjection()
  projection.append(
    chatEvent(0, "turn/start", .object(["turn": .number(1)])))
  projection.append(
    chatEvent(
      1, "command/run",
      .object([
        "commandId": .string("command-1"),
        "name": .string("feedback"),
        "args": .string(" positive"),
        "source": .object(["kind": .string("user")]),
      ])))
  projection.append(
    chatEvent(
      2, "request/context",
      .object([
        "provider": .string("deepseek-official"),
        "model": .string("deepseek-chat"),
        "contextWindow": .number(64_000),
      ])))
  projection.append(
    chatEvent(
      3, "command/done",
      .object([
        "commandId": .string("command-1"),
        "kind": .string("success"),
        "text": .string("Feedback recorded."),
      ])))
  let lifecycle = projection.statuses
  check(lifecycle.map(\.sequence) == [1, 2], "native chat keeps command/context sequence order")
  check(
    lifecycle.first?.id == "command-command-1"
      && lifecycle.first?.phase == .succeeded
      && lifecycle.first?.detail == "Feedback recorded.",
    "native chat pairs command run and done into one stable row"
  )
  check(
    lifecycle.last?.kind == .context
      && lifecycle.last?.turn == 1
      && lifecycle.last?.body?.contains("contextWindow") == true,
    "native chat associates request context with the open turn for process folding"
  )

  var permissionSwitch = ArkChatStatusProjection()
  permissionSwitch.append(
    chatEvent(
      30, "command/run",
      .object([
        "commandId": .string("permission-1"),
        "name": .string("permission"),
        "args": .string(" danger-full-access"),
        "source": .object(["kind": .string("user")]),
      ])))
  permissionSwitch.append(
    chatEvent(
      31, "command/done",
      .object([
        "commandId": .string("permission-1"),
        "kind": .string("success"),
        "text": .string("switched"),
      ])))
  permissionSwitch.append(
    chatEvent(
      32, "command/run",
      .object([
        "commandId": .string("other-1"),
        "name": .string("feedback"),
        "args": .string(" ok"),
        "source": .object(["kind": .string("user")]),
      ])))
  check(
    permissionSwitch.statuses.map(\.id) == ["command-other-1"],
    "native chat suppresses /permission command rows while keeping ordinary commands"
  )

  check(
    ArkAppModel.modelDisplayLabel(
      provider: "deepseek-official", model: "deepseek-v4-pro", reasoningEffort: "low"
    ) == "deepseek-v4-pro · low",
    "native model display label omits the provider prefix"
  )
  check(
    ArkAppModel.modelDisplayLabel(
      provider: "deepseek-official", model: "deepseek-v4-pro", reasoningEffort: nil
    ) == "deepseek-v4-pro",
    "native model display label keeps model only when no effort is set"
  )

  var automatic = ArkChatStatusProjection()
  automatic.append(
    chatEvent(
      10, "compaction/start",
      .object([
        "compactionId": .string("auto-1"), "turn": .number(2),
      ])))
  automatic.append(
    chatEvent(
      11, "compaction/summary",
      .object([
        "compactionId": .string("auto-1"),
        "summary": .array([
          .object(["type": .string("text"), "text": .string("automatic summary")])
        ]),
        "shadowedSeqs": .array([.number(1), .number(2), .number(3)]),
        "shadowedTokenCount": .number(1_200),
      ])))
  automatic.append(compactCheckpoint(id: 12, compactionID: "auto-1"))
  automatic.append(
    chatEvent(
      13, "compaction/end",
      .object([
        "compactionId": .string("auto-1"), "turn": .number(2),
      ])))
  check(
    automatic.statuses == [
      ArkChatStatus(
        id: "compaction-auto-1",
        sequence: 12,
        kind: .compaction,
        phase: .succeeded,
        title: "上下文已压缩",
        detail: "已替换 3 项 · 约 1200 tokens",
        body: "automatic summary"
      )
    ],
    "native chat renders an automatic compaction only at its checkpoint position"
  )

  var manual = ArkChatStatusProjection()
  manual.append(
    chatEvent(
      20, "command/run",
      .object([
        "commandId": .string("manual-command"),
        "name": .string("compact"),
        "source": .object(["kind": .string("user")]),
      ])))
  manual.append(
    chatEvent(
      21, "compaction/start",
      .object([
        "compactionId": .string("manual-1"),
        "sourceCommandId": .string("manual-command"),
        "turn": .null,
      ])))
  manual.append(
    chatEvent(
      22, "compaction/summary",
      .object([
        "compactionId": .string("manual-1"),
        "sourceCommandId": .string("manual-command"),
        "summary": .array([.object(["type": .string("text"), "text": .string("manual summary")])]),
        "shadowedSeqs": .array([.number(4), .number(8)]),
        "shadowedTokenCount": .number(800),
      ])))
  manual.append(
    compactCheckpoint(
      id: 23,
      compactionID: "manual-1",
      commandID: "manual-command"
    ))
  manual.append(
    chatEvent(
      24, "compaction/end",
      .object([
        "compactionId": .string("manual-1"),
        "sourceCommandId": .string("manual-command"),
        "turn": .null,
      ])))
  manual.append(
    chatEvent(
      25, "command/done",
      .object([
        "commandId": .string("manual-command"),
        "kind": .string("success"),
        "text": .string("Compacted."),
      ])))
  check(
    manual.statuses.count == 1
      && manual.statuses.first?.id == "command-manual-command"
      && manual.statuses.first?.kind == .compaction
      && manual.statuses.first?.sequence == 23,
    "native chat folds manual compact into the same stable command identity"
  )

  var messages = ArkMessageProjection()
  check(
    messages.append(compactCheckpoint(id: 30, compactionID: "hidden")) == false
      && messages.messages.isEmpty,
    "native chat never renders the model-facing compaction checkpoint as a message"
  )
  _ = messages.append(
    chatEvent(
      31, "user/message",
      .object([
        "id": .string("context-message"),
        "content": .array([.object(["type": .string("text"), "text": .string("injected")])]),
        "source": .object([
          "kind": .string("plugin"),
          "plugin": .string("instructions"),
          "form": .string("instructions"),
          "summary": .string("AGENTS.md"),
        ]),
      ])))
  check(
    messages.messages.first?.sourceKind == "plugin"
      && messages.messages.first?.sourceForm == "instructions"
      && messages.messages.first?.sourceSummary == "AGENTS.md",
    "native chat preserves non-user context disclosure provenance"
  )
  var interruptedMessage = ArkMessageProjection()
  _ = interruptedMessage.append(
    chatEvent(
      32, "assistant/message",
      .object([
        "turn": .number(4), "step": .number(1), "interrupted": .bool(true),
        "message": .object([
          "content": .array([
            .object([
              "type": .string("text"), "text": .string("visible partial"),
            ])
          ])
        ]),
      ])))
  check(
    interruptedMessage.messages.first?.interrupted == true,
    "native chat preserves an interrupted assistant partial for its stopped badge"
  )

  var tools = ArkToolProjection()
  tools.append(
    chatEvent(
      40, "tool/call",
      .object([
        "turn": .number(7),
        "step": .number(1),
        "callId": .string("call-interrupted"),
        "name": .string("bash"),
        "arguments": .string(#"{"command":"sleep 10"}"#),
      ])))
  tools.append(
    chatEvent(
      41, "turn/end",
      .object([
        "turn": .number(7),
        "reason": .object(["kind": .string("interrupted")]),
      ])))
  check(
    tools.activities.first?.isInterrupted == true
      && tools.activities.first?.result == nil,
    "native chat settles an unpaired tool call as interrupted with its stable id"
  )
  var interruptedResult = ArkToolProjection(events: [
    chatEvent(
      42, "tool/call",
      .object([
        "turn": .number(8), "step": .number(1),
        "callId": .string("call-stopped"), "name": .string("bash"),
        "arguments": .string("{}"),
      ])),
    chatEvent(
      43, "tool/result",
      .object([
        "turn": .number(8), "step": .number(1),
        "callId": .string("call-stopped"),
        "isError": .bool(true),
        "error": .object(["code": .string("interrupted")]),
        "text": .string("operator stopped the tool"),
      ])),
  ])
  check(
    interruptedResult.activities.first?.isInterrupted == true
      && interruptedResult.activities.first?.isError == false,
    "native chat distinguishes structured tool interruption from a failed result"
  )

  var auth = ArkChatStatusProjection()
  auth.append(
    chatEvent(
      50, "turn/end",
      .object([
        "turn": .number(9),
        "reason": .object([
          "kind": .string("error"),
          "error": .object([
            "code": .string("AUTH"),
            "status": .number(401),
            "message": .string("rejected credential sk-secret-fragment"),
          ]),
        ]),
      ])))
  let authDetail = auth.statuses.first?.detail ?? ""
  check(
    authDetail.contains("HTTP 401")
      && authDetail.contains("AUTH")
      && !authDetail.contains("secret-fragment"),
    "native chat never projects provider-authored AUTH credential fragments"
  )

  var retry = ArkChatStatusProjection()
  retry.append(
    chatEvent(
      60, "llm/retry",
      .object([
        "turn": .number(10), "step": .number(1),
        "retryId": .string("retry-10"), "retry": .number(1),
        "maxRetries": .number(2), "delayMs": .number(500),
        "failure": .object(["message": .string("temporary")]),
      ])))
  retry.append(
    chatEvent(
      61, "llm/retry-started",
      .object([
        "turn": .number(10), "step": .number(1),
        "retryId": .string("retry-10"), "retry": .number(1),
      ])))
  retry.append(
    chatEvent(
      62, "turn/end",
      .object([
        "turn": .number(10), "reason": .object(["kind": .string("completed")]),
      ])))
  check(
    retry.statuses.count == 1
      && retry.statuses.first?.phase == .succeeded
      && retry.statuses.first?.sequence == 60,
    "native chat settles a retry chain on the same stable transcript row"
  )

  var scheduledRetry = ArkChatStatusProjection(language: .en)
  scheduledRetry.append(
    chatEvent(
      70, "llm/retry",
      .object([
        "turn": .number(11), "step": .number(1),
        "retryId": .string("retry-countdown"), "retry": .number(2),
        "maxRetries": .number(4), "delayMs": .number(2_500),
        "failure": .object(["message": .string("temporary overload")]),
      ])))
  check(
    scheduledRetry.statuses.first?.id == "retry-retry-countdown"
      && scheduledRetry.statuses.first?.retry == ArkChatRetryPresentation(
        id: "retry-countdown",
        sequence: 70,
        attempt: 2,
        maximum: 4,
        delayMilliseconds: 2_500,
        state: .scheduled
      ),
    "native chat retains typed scheduled retry timing for the live countdown"
  )

  var terminalRetries = ArkChatStatusProjection(language: .en)
  terminalRetries.append(
    chatEvent(
      80, "llm/retry",
      .object([
        "turn": .number(12), "step": .number(1),
        "retryId": .string("provider-a"), "retry": .number(1),
        "maxRetries": .number(2), "delayMs": .number(20),
        "failure": .object(["message": .string("first failure")]),
      ])))
  terminalRetries.append(
    chatEvent(
      81, "llm/retry",
      .object([
        "turn": .number(12), "step": .number(2),
        "retryId": .string("provider-b"), "retry": .number(1),
        "maxRetries": .number(2), "delayMs": .number(20),
        "failure": .object(["message": .string("second failure")]),
      ])))
  terminalRetries.append(
    chatEvent(
      82, "turn/end",
      .object([
        "turn": .number(12),
        "reason": .object([
          "kind": .string("error"),
          "error": .object(["code": .string("SERVER"), "message": .string("terminal")]),
        ]),
      ])))
  check(
    Set(terminalRetries.statuses.map(\.id)) == [
      "retry-provider-a", "retry-provider-b", "turn-12-error",
    ]
      && terminalRetries.statuses.filter { $0.kind == .retry }
        .allSatisfy { $0.phase == .failed }
      && terminalRetries.statuses.first(where: { $0.kind == .error })?.detail
        == "terminal · SERVER",
    "native chat keeps retryId chains distinct and never suppresses the terminal turn error"
  )
}

private func runNativeComposerIMEBehaviorChecks() {
  MainActor.assumeIsolated {
    let editor = ComposerNSTextView(frame: NSRect(x: 0, y: 0, width: 320, height: 90))
    editor.isRichText = false
    editor.string = ""
    var compositionChanges: [Bool] = []
    editor.onCompositionChanged = { compositionChanges.append($0) }
    editor.setMarkedText(
      "拼",
      selectedRange: NSRange(location: 1, length: 0),
      replacementRange: NSRange(location: NSNotFound, length: 0)
    )
    let markedRange = editor.markedRange()
    let markedReturnRoute = NativeComposerSubmitAction.resolve(
      keyCode: 36,
      modifierFlags: [],
      isRepeat: false,
      hasMarkedText: editor.hasMarkedText()
    )

    let window = NSWindow(
      contentRect: NSRect(x: 40, y: 40, width: 360, height: 120),
      styleMask: [.borderless],
      backing: .buffered,
      defer: false
    )
    let scroll = NSScrollView(frame: window.contentView?.bounds ?? .zero)
    scroll.documentView = editor
    window.contentView = scroll
    scroll.layoutSubtreeIfNeeded()
    var actualRange = NSRange(location: NSNotFound, length: 0)
    let candidateRect = editor.firstRect(
      forCharacterRange: markedRange,
      actualRange: &actualRange
    )

    editor.unmarkText()
    check(
      markedRange.location != NSNotFound
        && compositionChanges.first == true
        && compositionChanges.last == false
        && markedReturnRoute == .appKit
        && candidateRect.origin.x.isFinite
        && candidateRect.origin.y.isFinite
        && candidateRect.width.isFinite
        && candidateRect.height.isFinite,
      "AppKit composer keeps marked text active, defers Return, and inherits finite candidate geometry"
    )
    check(
      NativeComposerSubmitAction.resolve(
        keyCode: 36,
        modifierFlags: [],
        isRepeat: false,
        hasMarkedText: false
      ) == .submit
        && NativeComposerSubmitAction.resolve(
          keyCode: 36,
          modifierFlags: .command,
          isRepeat: false,
          hasMarkedText: false
        ) == .submitAlternate
        && NativeComposerSubmitAction.resolve(
          keyCode: 36,
          modifierFlags: .shift,
          isRepeat: false,
          hasMarkedText: false
        ) == .appKit
        && NativeComposerSubmitAction.resolve(
          keyCode: 36,
          modifierFlags: [],
          isRepeat: true,
          hasMarkedText: false
        ) == .appKit,
      "composer submits only an unmarked non-repeated Return and preserves Shift-Return"
    )

    check(
      NativeComposerFocusAction.resolve(
        keyCode: 48,
        modifierFlags: [],
        hasMarkedText: false
      ) == .next
        && NativeComposerFocusAction.resolve(
          keyCode: 48,
          modifierFlags: .shift,
          hasMarkedText: false
        ) == .previous
        && NativeComposerFocusAction.resolve(
          keyCode: 48,
          modifierFlags: [],
          hasMarkedText: true
        ) == .appKit
        && NativeComposerFocusAction.resolve(
          keyCode: 36,
          modifierFlags: [],
          hasMarkedText: false
        ) == .appKit
        && NativeComposerFocusAction.resolve(
          keyCode: 48,
          modifierFlags: .command,
          hasMarkedText: false
        ) == .appKit
        && NativeComposerFocusAction.resolve(
          keyCode: 48,
          modifierFlags: .option,
          hasMarkedText: false
        ) == .appKit
        && NativeComposerFocusAction.resolve(
          keyCode: 48,
          modifierFlags: .control,
          hasMarkedText: false
        ) == .appKit,
      "composer reserves only plain Tab and Shift-Tab for focus while preserving IME and system shortcuts"
    )

    let fallbackEditor = ComposerNSTextView()
    var focusMoves: [NativeComposerFocusAction] = []
    fallbackEditor.onFocusMove = { focusMoves.append($0) }
    func fallbackTab(_ modifiers: NSEvent.ModifierFlags) -> NSEvent? {
      NSEvent.keyEvent(
        with: .keyDown,
        location: .zero,
        modifierFlags: modifiers,
        timestamp: 0,
        windowNumber: 0,
        context: nil,
        characters: "\t",
        charactersIgnoringModifiers: "\t",
        isARepeat: false,
        keyCode: 48
      )
    }
    if let event = fallbackTab([]) { fallbackEditor.keyDown(with: event) }
    if let event = fallbackTab(.shift) { fallbackEditor.keyDown(with: event) }
    check(
      focusMoves == [.next, .previous] && fallbackEditor.string.isEmpty,
      "composer falls back to its SwiftUI focus owner without inserting Tab into the draft"
    )
    check(
      NativeComposerToolbarFocusPolicy.target(
        for: .next, isSubagent: false, canStop: false, canSend: true
      ) == .sources
        && NativeComposerToolbarFocusPolicy.target(
          for: .previous, isSubagent: false, canStop: false, canSend: true
        ) == .model
        && NativeComposerToolbarFocusPolicy.target(
          for: .next, isSubagent: true, canStop: true, canSend: true
        ) == .stop
        && NativeComposerToolbarFocusPolicy.target(
          for: .previous, isSubagent: true, canStop: true, canSend: true
        ) == .send
        && NativeComposerToolbarFocusPolicy.target(
          for: .next, isSubagent: true, canStop: false, canSend: true
        ) == .send
        && NativeComposerToolbarFocusPolicy.target(
          for: .previous, isSubagent: true, canStop: true, canSend: false
        ) == .stop
        && NativeComposerToolbarFocusPolicy.target(
          for: .next, isSubagent: true, canStop: false, canSend: false
        ) == nil,
      "composer focus policy targets only controls visible for normal and subagent sessions"
    )
  }
}
