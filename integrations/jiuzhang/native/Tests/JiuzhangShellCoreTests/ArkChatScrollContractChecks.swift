import AppKit
import JiuzhangShellCore
@testable import JiuzhangShellUI

private func metricEvent(
  _ id: Int,
  _ type: String,
  turn: Int,
  usage: JSONValue? = nil
) -> ArkHistoryEvent {
  var data: [String: JSONValue] = ["turn": .number(Double(turn))]
  if let usage { data["usage"] = usage }
  return ArkHistoryEvent(
    id: id,
    type: type,
    time: Date(timeIntervalSince1970: Double(id)),
    data: .object(data),
    view: nil
  )
}

private func scrollOffset(_ command: ArkChatScrollCommand) -> Double? {
  guard case .scrollTo(let offset) = command else { return nil }
  return offset
}

private func approximatelyEqual(_ left: Double, _ right: Double, tolerance: Double = 0.5) -> Bool {
  abs(left - right) <= tolerance
}

func runArkChatScrollContractChecks() {
  let attachmentURL = contractNativeRoot.appendingPathComponent(
    "Sources/JiuzhangShellUI/ArkChatScrollAttachment.swift"
  )
  let coordinatorURL = contractNativeRoot.appendingPathComponent(
    "Sources/JiuzhangShellUI/ArkChatScrollCoordinator.swift"
  )
  let rootURL = contractNativeRoot.appendingPathComponent(
    "Sources/JiuzhangShellUI/ArkRootView.swift"
  )
  let modelURL = contractNativeRoot.appendingPathComponent(
    "Sources/JiuzhangShellUI/ArkAppModel.swift"
  )
  let metricsURL = contractNativeRoot.appendingPathComponent(
    "Sources/JiuzhangShellUI/ArkChatTurnMetrics.swift"
  )
  if let attachment = try? String(contentsOf: attachmentURL, encoding: .utf8),
     let coordinator = try? String(contentsOf: coordinatorURL, encoding: .utf8),
     let root = try? String(contentsOf: rootURL, encoding: .utf8),
     let model = try? String(contentsOf: modelURL, encoding: .utf8),
     let metrics = try? String(contentsOf: metricsURL, encoding: .utf8) {
    check(
      attachment.contains("private func setAtBottom(_ value: Bool)")
        && attachment.contains("guard isAtBottom != value else { return }")
        && attachment.contains("self?.setAtBottom(followsBottom)")
        && !attachment.contains("self?.isAtBottom = followsBottom")
        && attachment.contains("override func layout() {\n    super.layout()\n    // `attach(to:)`")
        && attachment.contains("if attachedScrollView == nil { scheduleAttachment() }")
        && !attachment.contains("override func layout() {\n    super.layout()\n    attachIfPossible()")
        && coordinator.contains("guard geometryChanged(metrics) else")
        && coordinator.contains("abs(metrics.offset - logicalOffset) <= 0.5")
        && coordinator.contains("metrics.offset > metrics.maximumOffset + 0.5")
        && coordinator.contains("metrics.distanceFromBottom > followThreshold")
        && !coordinator.contains("NSView.frameDidChangeNotification")
        && !coordinator.contains("postsFrameChangedNotifications = true")
        && coordinator.contains("installScrollWheelMonitor()")
        && coordinator.contains("scrollView.scrollWheel(with: event)")
        && coordinator.contains("let resized = geometryChanged(metrics)")
        && coordinator.contains("stateMachine.viewportDidResize(")
        && coordinator.contains("source: isUserMove ? .user : .programmatic")
        && coordinator.contains("NSScrollView.willStartLiveScrollNotification")
        && coordinator.contains("private func hitsTranscriptScroller")
        && coordinator.contains("private func isTranscriptScrollKey")
        && !coordinator.contains(
          "stateMachine.viewportDidMove(sessionID: sessionID, metrics: metrics, source: .user)"
        )
        && root.contains("@Published private(set) var snapshot: NativeChatSnapshot")
        && root.contains("snapshot.contentRevision &+ 1")
        && root.contains(".onChange(of: contentRevision)")
        && root.contains("ArkChatScrollAttachment(controller: scrollController)"),
      "chat scroll follows semantic transcript revisions without an AppKit frame-to-layout feedback loop"
    )

    let feed = chatSourceSlice(
      root,
      from: "private final class NativeChatTranscriptFeed",
      through: "private struct NativeChatView"
    )
    check(
      feed?.contains("Publishers.MergeMany(triggers)") == true
        && feed?.contains(".throttle(for: .milliseconds(100)") == true
        && feed?.contains("NativeChatSessionFeedState") == true
        && feed?.contains("model.$sessions.map { [weak model] sessions in") == true
        && feed?.contains(".removeDuplicates()") == true
        && feed?.contains("let next = NativeChatSnapshot(") == true
        && feed?.contains("model: model") == true
        && feed?.contains("entries: entries") == true,
      "chat transcript coalesces only semantically changed selected-session inputs into one narrow snapshot"
    )
    check(
      feed?.contains("NativeGFMParseWorker.shared.blocks(for: source.source)") == true
        && feed?.contains("private var markdownProjectionState") == true
        && feed?.contains("let reconciliation = reconcileMarkdownSources(model: model)") == true
        && feed?.contains("reconciliation.sessionChanged\n        ? [:]") == true
        && feed?.contains("markdownProjectionState.beginRequest(for: source)") == true
        && feed?.contains("markdownProjectionState.accept(request)") == true
        && feed?.contains("markdownProjectionState.cancel(request)") == true
        && feed?.contains("for task in markdownTasks.values { task.cancel() }") == true
        && feed?.contains("snapshot.installing(blocks, for: source.id)") == true
        && feed?.contains("transaction.disablesAnimations = true") == true
        && feed?.contains("markdownSessionID") == false
        && feed?.contains("markdownRequestTokens") == false
        && feed?.contains("NativeGFMParser.parse") == false
        && feed?.contains("NativeGFMCache.shared") == false
        && feed?.contains("NativeGFMDocumentModel") == false,
      "chat transcript feed owns one cancellable final-Markdown projection above the outer lazy layout"
    )
    let sourceIDType = chatSourceSlice(
      root,
      from: "struct NativeAssistantMarkdownSourceID: Hashable",
      through: "struct NativeAssistantMarkdownSource: Equatable"
    )
    check(
      sourceIDType?.contains("let messageID: Int") == true
        && sourceIDType?.contains("let sourceSlot: Int") == true
        && sourceIDType?.contains("source: String") == false
        && root.contains("struct NativeAssistantMarkdownSource: Equatable, Sendable")
        && !root.contains("struct NativeAssistantMarkdownSource: Hashable")
        && root.contains("markdownTasks: [NativeAssistantMarkdownSourceID:")
        && root.contains("markdownBlocksBySourceID: [NativeAssistantMarkdownSourceID:"),
      "R20: source payload is excluded from transcript Hashable identity, dictionaries, and tasks"
    )

    let mainArea = chatSourceSlice(
      root,
      from: "private struct NativeMainArea",
      through: "private struct NativeSessionHeader"
    )
    let chatView = chatSourceSlice(
      root,
      from: "private struct NativeChatView",
      through: "private struct NativeMessageRow"
    )
    check(
      mainArea?.contains("@StateObject private var chatScrollController") == true
        && mainArea?.contains("transcriptTextSelectionEnabled") == false
        && mainArea?.contains("NativeChatView(") == true
        && mainArea?.contains("model: model") == true
        && mainArea?.contains("scrollController: chatScrollController") == true
        && mainArea?.contains(".id(model.selectedSessionID)") == false
        && mainArea?.contains("NativeChatView(model: model).equatable()") == false
        && chatView?.contains("@ObservedObject private var scrollController") == true
        && chatView?.contains("transcriptTextSelectionEnabled") == false,
      "chat session replacement preserves one transcript feed and one shared scroll owner without rebuilding the full LazyVStack"
    )
    check(
      chatView?.contains("case .assistantPrefix(let row):") == true
        && chatView?.contains("case .assistantMarkdownRow(let row):") == true
        && chatView?.contains("case .assistantSuffix(let row):") == true
        && chatView?.contains("Section {") == false
        && chatView?.contains("ForEach(section.bodyRows)") == false
        && root.contains("private struct NativeAssistantMarkdownBodyContext: Equatable")
        && !root.contains("NativeAssistantMarkdownSection")
        && chatView?.contains("NativeGFMBlockView(") == true
        && chatView?.contains(".nativeMarkdownRoutes(") == true
        && chatView?.contains("NativeMessageActions(") == true
        && chatView?.components(separatedBy: "NativeMessageActions(").count == 2
        && chatView?.contains("case .pending") == true
        && chatView?.contains("case .companion") == true,
      "R20: completed Markdown rows are direct outer rows with lightweight body context"
    )
    check(
      root.contains("enum NativeAssistantMarkdownPrefixPolicy")
        && root.contains("NativeAssistantMarkdownFlatProjection.rows(")
        && root.contains("if hasPrefix { rows.append(.prefix(messageID: messageID)) }")
        && chatView?.contains("assistantProjectedPrefix(row, fontSize: fontSize)") == true,
      "completed assistant Markdown keeps the prefix-row policy; the prefix renders as an outer row"
    )

    let messageRow = chatSourceSlice(
      root,
      from: "private struct NativeMessageRow",
      through: "private struct NativeMessageDocuments"
    )
    let messageActions = chatSourceSlice(
      root,
      from: "private struct NativeMessageActions",
      through: "struct NativeMessageImages: View"
    )
    check(
      messageRow?.contains("View, Equatable") == true
        && messageRow?.contains("@ObservedObject var model") == false
        && messageRow?.contains("@FocusState private var actionsFocused") == false
        && messageRow?.contains(".focusable()") == false
        && messageRow?.contains("actionsVisible: true") == true
        && messageActions?.contains("@ObservedObject var model") == false
        && messageActions?.contains("model.forkSequence(for: message)") == false
        && messageActions?.contains("presentation.forkSequence") == true,
      "historical chat rows keep actions reachable without one FocusState proxy per message"
    )

    let livePublish = chatSourceSlice(
      model,
      from: "private func scheduleLivePublish()",
      through: "private func scheduleNavigationRefresh()"
    )
    check(
      livePublish?.contains("turnProjection.append(contentsOf: incoming)") == true
        && livePublish?.contains("ArkChatTurnMetrics.projectAll(events: events)") == false
        && livePublish?.contains("event.type == \"turn/end\"") == true
        && livePublish?.contains("var chatPresentationChanged = false") == true
        && livePublish?.contains("if chatPresentationChanged { chatPresentationDidChange.send() }") == true
        && metrics.contains("struct ArkChatTurnProjection: Equatable, Sendable")
        && metrics.contains("metricsByTurn[turn] = metrics(for: value)"),
      "live chat updates metrics incrementally and folds exact usage only when a turn settles"
    )
    check(
      model.contains("public private(set) var messages: [ArkMessage]")
        && model.contains("public private(set) var toolActivities: [ArkToolActivity]")
        && model.contains("public private(set) var producedFiles: [ArkProducedFile]")
        && model.contains("public private(set) var chatStatuses: [ArkChatStatus]")
        && !model.contains("@Published public private(set) var messages: [ArkMessage]")
        && !model.contains("@Published public private(set) var toolActivities: [ArkToolActivity]")
        && model.contains("chatPresentationDidChange.send()"),
      "high-frequency transcript projections use the narrow chat channel instead of global objectWillChange"
    )
  } else {
    check(false, "chat scroll attachment source is readable")
  }

  let sourceID = NativeAssistantMarkdownSourceID(messageID: 701, sourceSlot: 0)
  let sourceA = NativeAssistantMarkdownSource(
    id: sourceID,
    source: "session A final answer"
  )
  let sourceB = NativeAssistantMarkdownSource(
    id: sourceID,
    source: "session B replacement answer"
  )

  var duplicateState = NativeAssistantMarkdownProjectionState()
  _ = duplicateState.reconcile(
    sessionID: "session-duplicate",
    requestedSources: [sourceA, sourceB]
  )
  check(
    duplicateState.requestedSourcesByID[sourceID] == sourceA,
    "duplicate final-Markdown source ids preserve the first payload without trapping"
  )

  var replacementState = NativeAssistantMarkdownProjectionState()
  _ = replacementState.reconcile(sessionID: "session-a", requestedSources: [sourceA])
  let requestA = replacementState.beginRequest(for: sourceA)
  let replacement = replacementState.reconcile(
    sessionID: "session-a",
    requestedSources: [sourceB]
  )
  var replacementRevision: UInt64 = 0
  let staleReplacementAccepted = requestA.map { replacementState.accept($0) } ?? false
  if staleReplacementAccepted { replacementRevision &+= 1 }
  let requestB = replacementState.beginRequest(for: sourceB)
  let replacementAccepted = requestB.map { replacementState.accept($0) } ?? false
  if replacementAccepted { replacementRevision &+= 1 }
  let replacementAcceptedTwice = requestB.map { replacementState.accept($0) } ?? false
  if replacementAcceptedTwice { replacementRevision &+= 1 }
  let unchanged = replacementState.reconcile(
    sessionID: "session-a",
    requestedSources: [sourceB]
  )
  let unchangedRequest = replacementState.beginRequest(for: sourceB)
  check(
    replacement.invalidatedSourceIDs == [sourceID]
      && !staleReplacementAccepted
      && replacementAccepted
      && !replacementAcceptedTwice
      && unchanged.invalidatedSourceIDs.isEmpty
      && unchangedRequest == nil
      && replacementState.installedSourceIDs == [sourceID]
      && replacementRevision == 1,
    "same-ID changed payload rejects A, installs B once, and retains unchanged B"
  )

  var sessionState = NativeAssistantMarkdownProjectionState()
  _ = sessionState.reconcile(sessionID: "session-a", requestedSources: [sourceA])
  let oldSessionRequest = sessionState.beginRequest(for: sourceA)
  let sessionTransition = sessionState.reconcile(
    sessionID: "session-b",
    requestedSources: [sourceA]
  )
  let cachedSourceRequest = sessionState.beginRequest(for: sourceA)
  var sessionRevision: UInt64 = 0
  let oldSessionAccepted = oldSessionRequest.map { sessionState.accept($0) } ?? false
  if oldSessionAccepted { sessionRevision &+= 1 }
  let cachedSourceAccepted = cachedSourceRequest.map { sessionState.accept($0) } ?? false
  if cachedSourceAccepted { sessionRevision &+= 1 }
  let cachedSourceAcceptedTwice = cachedSourceRequest.map { sessionState.accept($0) } ?? false
  if cachedSourceAcceptedTwice { sessionRevision &+= 1 }
  check(
    sessionTransition.sessionChanged
      && sessionTransition.invalidatedSourceIDs == [sourceID]
      && oldSessionRequest?.epoch != cachedSourceRequest?.epoch
      && cachedSourceRequest?.sessionID == "session-b"
      && !oldSessionAccepted
      && cachedSourceAccepted
      && !cachedSourceAcceptedTwice
      && sessionRevision == 1,
    "session transition re-requests an identical cached source and rejects the old epoch"
  )

  var cancelledState = NativeAssistantMarkdownProjectionState()
  _ = cancelledState.reconcile(sessionID: "session-c", requestedSources: [sourceA])
  let cancelledRequest = cancelledState.beginRequest(for: sourceA)
  let cancelled = cancelledRequest.map { cancelledState.cancel($0) } ?? false
  var cancelledRevision: UInt64 = 0
  let acceptedAfterCancellation = cancelledRequest.map { cancelledState.accept($0) } ?? false
  if acceptedAfterCancellation { cancelledRevision &+= 1 }
  check(
    cancelled && !acceptedAfterCancellation && cancelledRevision == 0,
    "cancelled final-Markdown completion cannot install or advance content revision"
  )

  check(
    !NativeAssistantMarkdownPrefixPolicy.hasContent(
      hasDocuments: false,
      hasLegacyAttachments: false,
      hasVisibleLegacyReasoning: false
    )
      && NativeAssistantMarkdownPrefixPolicy.hasContent(
        hasDocuments: true,
        hasLegacyAttachments: false,
        hasVisibleLegacyReasoning: false
      )
      && NativeAssistantMarkdownPrefixPolicy.hasContent(
        hasDocuments: false,
        hasLegacyAttachments: false,
        hasVisibleLegacyReasoning: true
      ),
    "plain final answers omit an empty prefix while document or reasoning prefixes remain"
  )

  var incrementalMetrics = ArkChatTurnProjection(events: [
    metricEvent(10, "turn/start", turn: 1),
    metricEvent(14, "turn/end", turn: 1),
  ])
  let completedFirstTurn = incrementalMetrics.metricsByTurn[1]
  incrementalMetrics.append(contentsOf: [
    metricEvent(20, "turn/start", turn: 2),
    metricEvent(21, "step/start", turn: 2),
    metricEvent(23, "assistant/chunk", turn: 2),
    metricEvent(25, "assistant/chunk", turn: 2),
    metricEvent(
      26,
      "assistant/message",
      turn: 2,
      usage: .object(["outputTokens": .number(20)])
    ),
    metricEvent(30, "turn/end", turn: 2),
  ])
  check(
    incrementalMetrics.metricsByTurn[1] == completedFirstTurn
      && incrementalMetrics.metricsByTurn[2]?.runSeconds == 10
      && incrementalMetrics.metricsByTurn[2]?.firstTokenSeconds == 2
      && incrementalMetrics.metricsByTurn[2]?.tokensPerSecond == 10,
    "incremental turn projection preserves historical metrics while folding only incoming live events"
  )

  check(
    ArkChatNestedScrollRouting.forwardsToTranscript(
      deltaX: 0.5,
      deltaY: 18,
      horizontalRange: 420,
      verticalRange: 0
    ),
    "vertical wheel input over a horizontal-only Markdown scroller continues through the transcript"
  )
  check(
    !ArkChatNestedScrollRouting.forwardsToTranscript(
      deltaX: 18,
      deltaY: 0.5,
      horizontalRange: 420,
      verticalRange: 0
    ),
    "horizontal wheel input remains owned by a nested Markdown scroller"
  )
  check(
    !ArkChatNestedScrollRouting.forwardsToTranscript(
      deltaX: 0,
      deltaY: 18,
      horizontalRange: 420,
      verticalRange: 180
    ),
    "a nested surface with its own vertical range keeps vertical wheel input"
  )

  var machine = ArkChatScrollStateMachine(followThreshold: 44)
  let initial = ArkChatScrollMetrics(contentHeight: 1_000, viewportHeight: 200, offset: 0)
  check(
    machine.activate(sessionID: "session-a", metrics: initial) == .scrollToBottom,
    "chat scroll starts a new session at the bottom"
  )
  machine.viewportDidMove(
    sessionID: "session-a",
    metrics: ArkChatScrollMetrics(contentHeight: 1_000, viewportHeight: 200, offset: 800),
    source: .programmatic
  )

  check(
    machine.contentDidResize(
      sessionID: "session-a",
      metrics: ArkChatScrollMetrics(contentHeight: 1_020, viewportHeight: 200, offset: 800)
    ) == .none,
    "chat scroll batches sub-threshold live growth without an AppKit scroll"
  )

  check(
    machine.contentDidResize(
      sessionID: "session-a",
      metrics: ArkChatScrollMetrics(contentHeight: 1_180, viewportHeight: 200, offset: 800)
    ) == .scrollToBottom,
    "chat scroll follows a stable message id whose content becomes taller"
  )

  var resizeMachine = ArkChatScrollStateMachine(followThreshold: 44)
  _ = resizeMachine.activate(
    sessionID: "resize-bottom",
    metrics: ArkChatScrollMetrics(contentHeight: 1_000, viewportHeight: 200, offset: 800)
  )
  resizeMachine.viewportDidMove(
    sessionID: "resize-bottom",
    metrics: ArkChatScrollMetrics(contentHeight: 1_000, viewportHeight: 200, offset: 800),
    source: .programmatic
  )
  check(
    resizeMachine.viewportDidResize(
      sessionID: "resize-bottom",
      metrics: ArkChatScrollMetrics(contentHeight: 1_000, viewportHeight: 150, offset: 800)
    ) == .scrollToBottom,
    "viewport 200 to 150 keeps a bottom-following session at the new bottom"
  )
  resizeMachine.viewportDidMove(
    sessionID: "resize-bottom",
    metrics: ArkChatScrollMetrics(contentHeight: 1_000, viewportHeight: 150, offset: 850),
    source: .programmatic
  )
  check(
    resizeMachine.viewportDidResize(
      sessionID: "resize-bottom",
      metrics: ArkChatScrollMetrics(contentHeight: 1_000, viewportHeight: 240, offset: 850)
    ) == .scrollToBottom
      && resizeMachine.snapshot(for: "resize-bottom")?.followsBottom == true
      && approximatelyEqual(resizeMachine.snapshot(for: "resize-bottom")?.offset ?? -1, 760),
    "viewport 150 to 240 corrects overscroll without suspending bottom following"
  )

  var anchoredResizeMachine = ArkChatScrollStateMachine(followThreshold: 44)
  _ = anchoredResizeMachine.activate(
    sessionID: "resize-anchor",
    metrics: ArkChatScrollMetrics(contentHeight: 1_000, viewportHeight: 200, offset: 800)
  )
  anchoredResizeMachine.viewportDidMove(
    sessionID: "resize-anchor",
    metrics: ArkChatScrollMetrics(contentHeight: 1_000, viewportHeight: 200, offset: 400),
    source: .user
  )
  let resizePrepend = anchoredResizeMachine.capturePrependAnchor(
    sessionID: "resize-anchor",
    metrics: ArkChatScrollMetrics(contentHeight: 1_000, viewportHeight: 200, offset: 400)
  )
  check(
    anchoredResizeMachine.viewportDidResize(
      sessionID: "resize-anchor",
      metrics: ArkChatScrollMetrics(contentHeight: 1_000, viewportHeight: 150, offset: 400)
    ) == .none
      && anchoredResizeMachine.viewportDidResize(
        sessionID: "resize-anchor",
        metrics: ArkChatScrollMetrics(contentHeight: 1_000, viewportHeight: 240, offset: 400)
      ) == .none
      && anchoredResizeMachine.snapshot(for: "resize-anchor")?.followsBottom == false
      && approximatelyEqual(
        anchoredResizeMachine.snapshot(for: "resize-anchor")?.offset ?? -1,
        400
      ),
    "programmatic viewport 200 to 150 to 240 preserves an away-from-bottom anchor"
  )
  check(
    approximatelyEqual(
      scrollOffset(
        anchoredResizeMachine.completePrepend(
          resizePrepend,
          metrics: ArkChatScrollMetrics(
            contentHeight: 1_300,
            viewportHeight: 240,
            offset: 400
          )
        )) ?? -1,
      700
    ),
    "programmatic resize does not invalidate an in-flight prepend token"
  )

  var overscrollMachine = ArkChatScrollStateMachine(followThreshold: 44)
  _ = overscrollMachine.activate(
    sessionID: "overscroll",
    metrics: ArkChatScrollMetrics(contentHeight: 1_000, viewportHeight: 200, offset: 800)
  )
  overscrollMachine.viewportDidMove(
    sessionID: "overscroll",
    metrics: ArkChatScrollMetrics(contentHeight: 1_000, viewportHeight: 200, offset: 800),
    source: .programmatic
  )
  check(
    overscrollMachine.contentDidResize(
      sessionID: "overscroll",
      metrics: ArkChatScrollMetrics(contentHeight: 900, viewportHeight: 200, offset: 850)
    ) == .scrollToBottom,
    "chat scroll corrects a physical origin beyond the new maximum after final reflow"
  )
  machine.viewportDidMove(
    sessionID: "session-a",
    metrics: ArkChatScrollMetrics(contentHeight: 1_180, viewportHeight: 200, offset: 700),
    source: .user
  )
  check(
    machine.snapshot(for: "session-a")?.followsBottom == false,
    "chat scroll suspends following after the user moves beyond the threshold"
  )
  check(
    machine.contentDidResize(
      sessionID: "session-a",
      metrics: ArkChatScrollMetrics(contentHeight: 1_320, viewportHeight: 200, offset: 700)
    ) == .none,
    "chat scroll does not grab an anchored user when live content grows"
  )

  let anchor = machine.capturePrependAnchor(
    sessionID: "session-a",
    metrics: ArkChatScrollMetrics(contentHeight: 1_320, viewportHeight: 200, offset: 700)
  )
  let prependCommand = machine.completePrepend(
    anchor,
    metrics: ArkChatScrollMetrics(contentHeight: 1_620, viewportHeight: 200, offset: 700)
  )
  check(
    approximatelyEqual(scrollOffset(prependCommand) ?? -1, 1_000),
    "chat scroll preserves the visible anchor across a history prepend"
  )

  let semanticAnchor = machine.capturePrependAnchor(
    sessionID: "session-a",
    metrics: ArkChatScrollMetrics(contentHeight: 1_620, viewportHeight: 200, offset: 1_000),
    visibleAnchor: ArkChatScrollContentAnchor(id: "message-42", documentOffset: 1_028)
  )
  let semanticRestore = machine.completePrepend(
    semanticAnchor,
    metrics: ArkChatScrollMetrics(contentHeight: 1_970, viewportHeight: 200, offset: 1_000),
    resolvedAnchor: ArkChatScrollContentAnchor(id: "message-42", documentOffset: 1_410)
  )
  check(
    approximatelyEqual(scrollOffset(semanticRestore) ?? -1, 1_382),
    "chat scroll prefers a stable semantic row anchor when prepend also reflows content"
  )

  let staleAnchor = machine.capturePrependAnchor(
    sessionID: "session-a",
    metrics: ArkChatScrollMetrics(contentHeight: 1_970, viewportHeight: 200, offset: 1_382)
  )
  machine.viewportDidMove(
    sessionID: "session-a",
    metrics: ArkChatScrollMetrics(contentHeight: 1_970, viewportHeight: 200, offset: 1_200),
    source: .user
  )
  check(
    machine.completePrepend(
      staleAnchor,
      metrics: ArkChatScrollMetrics(contentHeight: 2_070, viewportHeight: 200, offset: 1_200)
    ) == .none,
    "chat scroll does not restore a stale prepend anchor after the user moves"
  )

  check(
    machine.requestBottom(
      sessionID: "session-a",
      metrics: ArkChatScrollMetrics(contentHeight: 2_070, viewportHeight: 200, offset: 1_200)
    ) == .scrollToBottom,
    "chat scroll exposes an explicit return-to-bottom command"
  )
  machine.viewportDidMove(
    sessionID: "session-a",
    metrics: ArkChatScrollMetrics(contentHeight: 2_070, viewportHeight: 200, offset: 1_870),
    source: .programmatic
  )
  check(
    machine.contentDidResize(
      sessionID: "session-a",
      metrics: ArkChatScrollMetrics(contentHeight: 2_150, viewportHeight: 200, offset: 1_870)
    ) == .scrollToBottom,
    "chat scroll resumes live following after returning to the bottom"
  )

  machine.viewportDidMove(
    sessionID: "session-a",
    metrics: ArkChatScrollMetrics(contentHeight: 2_150, viewportHeight: 200, offset: 840),
    source: .user
  )
  check(
    machine.activate(
      sessionID: "session-b",
      metrics: ArkChatScrollMetrics(contentHeight: 700, viewportHeight: 200, offset: 0)
    ) == .scrollToBottom,
    "chat scroll starts a second session at its own bottom"
  )
  machine.viewportDidMove(
    sessionID: "session-b",
    metrics: ArkChatScrollMetrics(contentHeight: 700, viewportHeight: 200, offset: 120),
    source: .user
  )
  let restoredA = machine.activate(
    sessionID: "session-a",
    metrics: ArkChatScrollMetrics(contentHeight: 2_150, viewportHeight: 200, offset: 0)
  )
  let restoredB = machine.activate(
    sessionID: "session-b",
    metrics: ArkChatScrollMetrics(contentHeight: 700, viewportHeight: 200, offset: 0)
  )
  check(
    approximatelyEqual(scrollOffset(restoredA) ?? -1, 840),
    "chat scroll restores session A independently"
  )
  check(
    approximatelyEqual(scrollOffset(restoredB) ?? -1, 120),
    "chat scroll restores session B independently"
  )

  MainActor.assumeIsolated {
    runArkChatScrollAppKitHarnessChecks()
  }
}

private func chatSourceSlice(
  _ source: String,
  from start: String,
  through end: String
) -> String? {
  guard let startRange = source.range(of: start),
        let endRange = source.range(
          of: end,
          range: startRange.upperBound..<source.endIndex
        )
  else { return nil }
  return String(source[startRange.lowerBound..<endRange.lowerBound])
}

@MainActor
private final class FlippedChatDocumentView: NSView {
  override var isFlipped: Bool { true }
}

@MainActor
private final class RecordingChatClipView: NSClipView {
  private(set) var scrollRequestCount = 0

  override func scroll(to newOrigin: NSPoint) {
    scrollRequestCount += 1
    super.scroll(to: newOrigin)
  }
}

@MainActor
private func makeScrollHarness(
  contentHeight: CGFloat,
  flipped: Bool = true
) -> (NSScrollView, NSView, ArkChatScrollCoordinator) {
  let (scrollView, document) = makeRawScrollHarness(
    contentHeight: contentHeight,
    flipped: flipped
  )
  return (
    scrollView, document, ArkChatScrollCoordinator(scrollView: scrollView, followThreshold: 44)
  )
}

@MainActor
private func makeRawScrollHarness(
  contentHeight: CGFloat,
  flipped: Bool = true
) -> (NSScrollView, NSView) {
  let scrollView = NSScrollView(frame: NSRect(x: 0, y: 0, width: 320, height: 200))
  scrollView.borderType = .noBorder
  scrollView.hasHorizontalScroller = false
  scrollView.hasVerticalScroller = false
  scrollView.drawsBackground = false
  let document: NSView =
    flipped
    ? FlippedChatDocumentView(frame: NSRect(x: 0, y: 0, width: 320, height: contentHeight))
    : NSView(frame: NSRect(x: 0, y: 0, width: 320, height: contentHeight))
  scrollView.documentView = document
  scrollView.layoutSubtreeIfNeeded()
  return (scrollView, document)
}

@MainActor
private func setLogicalOffset(_ offset: Double, scrollView: NSScrollView, document: NSView) {
  let visibleHeight = scrollView.documentVisibleRect.height
  let maximum = max(Double(document.bounds.height - visibleHeight), 0)
  let target = min(max(offset, 0), maximum)
  let y =
    document.isFlipped
    ? document.bounds.minY + CGFloat(target)
    : document.bounds.maxY - visibleHeight - CGFloat(target)
  scrollView.contentView.scroll(to: NSPoint(x: 0, y: y))
  scrollView.reflectScrolledClipView(scrollView.contentView)
}

@MainActor
private func setLiveUserLogicalOffset(
  _ offset: Double,
  scrollView: NSScrollView,
  document: NSView
) {
  let center = NotificationCenter.default
  center.post(name: NSScrollView.willStartLiveScrollNotification, object: scrollView)
  setLogicalOffset(offset, scrollView: scrollView, document: document)
  center.post(name: NSScrollView.didLiveScrollNotification, object: scrollView)
  center.post(name: NSScrollView.didEndLiveScrollNotification, object: scrollView)
}

@MainActor
private func resizeViewport(_ height: CGFloat, scrollView: NSScrollView) {
  scrollView.setFrameSize(NSSize(width: scrollView.frame.width, height: height))
  scrollView.layoutSubtreeIfNeeded()
  NotificationCenter.default.post(
    name: NSView.boundsDidChangeNotification,
    object: scrollView.contentView
  )
}

@MainActor
private func runArkChatScrollAppKitHarnessChecks() {
  let (scrollView, document, coordinator) = makeScrollHarness(contentHeight: 1_000)
  defer { coordinator.invalidate() }

  coordinator.activate(sessionID: "appkit-a")
  check(
    approximatelyEqual(coordinator.currentMetrics()?.offset ?? -1, 800),
    "AppKit chat coordinator initially scrolls to the bottom"
  )

  resizeViewport(150, scrollView: scrollView)
  check(
    coordinator.snapshot(for: "appkit-a")?.followsBottom == true
      && approximatelyEqual(coordinator.currentMetrics()?.viewportHeight ?? -1, 150)
      && approximatelyEqual(coordinator.currentMetrics()?.offset ?? -1, 850),
    "AppKit viewport 200 to 150 follows the new bottom without user intent"
  )
  resizeViewport(240, scrollView: scrollView)
  check(
    coordinator.snapshot(for: "appkit-a")?.followsBottom == true
      && approximatelyEqual(coordinator.currentMetrics()?.viewportHeight ?? -1, 240)
      && approximatelyEqual(coordinator.currentMetrics()?.offset ?? -1, 760),
    "AppKit viewport 150 to 240 corrects the bottom without disabling follow"
  )
  resizeViewport(200, scrollView: scrollView)

  document.setFrameSize(NSSize(width: 320, height: 1_180))
  coordinator.contentDidChange()
  check(
    approximatelyEqual(coordinator.currentMetrics()?.offset ?? -1, 980),
    "AppKit chat coordinator follows stable-id content height growth"
  )

  setLiveUserLogicalOffset(640, scrollView: scrollView, document: document)
  check(
    coordinator.snapshot(for: "appkit-a")?.followsBottom == false,
    "AppKit live-scroll notifications classify an offset move as user-driven"
  )
  resizeViewport(150, scrollView: scrollView)
  resizeViewport(240, scrollView: scrollView)
  check(
    coordinator.snapshot(for: "appkit-a")?.followsBottom == false
      && approximatelyEqual(coordinator.currentMetrics()?.offset ?? -1, 640),
    "AppKit programmatic viewport 200 to 150 to 240 preserves the reader anchor"
  )
  resizeViewport(200, scrollView: scrollView)
  document.setFrameSize(NSSize(width: 320, height: 1_320))
  coordinator.contentDidChange()
  check(
    approximatelyEqual(coordinator.currentMetrics()?.offset ?? -1, 640),
    "AppKit chat coordinator does not steal an anchored viewport"
  )

  let prepend = coordinator.capturePrependAnchor()
  document.setFrameSize(NSSize(width: 320, height: 1_620))
  coordinator.contentDidChange()
  if let prepend { coordinator.restoreAfterPrepend(prepend) }
  check(
    approximatelyEqual(coordinator.currentMetrics()?.offset ?? -1, 940),
    "AppKit chat coordinator keeps the pixel anchor after prepend"
  )

  let wheelPrepend = coordinator.capturePrependAnchor()
  coordinator.noteUserScrollInput()
  setLogicalOffset(820, scrollView: scrollView, document: document)
  document.setFrameSize(NSSize(width: 320, height: 1_720))
  coordinator.contentDidChange()
  if let wheelPrepend { coordinator.restoreAfterPrepend(wheelPrepend) }
  check(
    approximatelyEqual(coordinator.currentMetrics()?.offset ?? -1, 820),
    "wheel intent advances user revision and invalidates a stale prepend restore"
  )

  coordinator.scrollToBottom()
  check(
    coordinator.snapshot(for: "appkit-a")?.followsBottom == true
      && approximatelyEqual(coordinator.currentMetrics()?.offset ?? -1, 1_520),
    "AppKit return-to-bottom restores following"
  )
  document.setFrameSize(NSSize(width: 320, height: 1_800))
  coordinator.contentDidChange()
  check(
    approximatelyEqual(coordinator.currentMetrics()?.offset ?? -1, 1_600),
    "AppKit return-to-bottom follows later growth"
  )

  setLiveUserLogicalOffset(760, scrollView: scrollView, document: document)
  coordinator.beginSessionTransition(to: "appkit-b")
  document.setFrameSize(NSSize(width: 320, height: 700))
  coordinator.completeSessionTransition()
  check(
    approximatelyEqual(coordinator.currentMetrics()?.offset ?? -1, 500),
    "AppKit session B starts at its own bottom"
  )
  setLiveUserLogicalOffset(110, scrollView: scrollView, document: document)

  coordinator.beginSessionTransition(to: "appkit-a")
  document.setFrameSize(NSSize(width: 320, height: 1_800))
  coordinator.completeSessionTransition()
  check(
    approximatelyEqual(coordinator.currentMetrics()?.offset ?? -1, 760),
    "AppKit session transition restores session A position"
  )

  coordinator.beginSessionTransition(to: "appkit-b")
  document.setFrameSize(NSSize(width: 320, height: 700))
  coordinator.completeSessionTransition()
  check(
    approximatelyEqual(coordinator.currentMetrics()?.offset ?? -1, 110),
    "AppKit session transition restores session B position"
  )

  let (unflippedScroll, _, unflippedCoordinator) = makeScrollHarness(
    contentHeight: 900,
    flipped: false
  )
  defer { unflippedCoordinator.invalidate() }
  unflippedCoordinator.activate(sessionID: "unflipped")
  check(
    approximatelyEqual(unflippedCoordinator.currentMetrics()?.offset ?? -1, 700),
    "AppKit coordinator normalizes an unflipped document bottom"
  )
  check(
    approximatelyEqual(Double(unflippedScroll.documentVisibleRect.minY), 0),
    "AppKit coordinator maps an unflipped logical bottom to the physical origin"
  )

  let (bridgeScroll, bridgeDocument) = makeRawScrollHarness(contentHeight: 1_000)
  let controller = ArkChatScrollController(followThreshold: 44)
  controller.attach(to: bridgeScroll)
  controller.activate(sessionID: "bridge-session")
  check(
    controller.isAtBottom
      && approximatelyEqual(Double(bridgeScroll.documentVisibleRect.minY), 800),
    "SwiftUI chat scroll controller attaches and activates at the bottom"
  )
  setLiveUserLogicalOffset(420, scrollView: bridgeScroll, document: bridgeDocument)
  check(!controller.isAtBottom, "SwiftUI chat scroll controller publishes reader-away state")

  let bridgeAnchor = controller.capturePrependAnchor(
    visibleAnchor: ArkChatScrollContentAnchor(id: "bridge-row", documentOffset: 450)
  )
  bridgeDocument.setFrameSize(NSSize(width: 320, height: 1_240))
  controller.contentDidChange()
  if let bridgeAnchor {
    controller.restoreAfterPrepend(
      bridgeAnchor,
      resolvedAnchor: ArkChatScrollContentAnchor(id: "bridge-row", documentOffset: 710)
    )
  }
  check(
    approximatelyEqual(Double(bridgeScroll.documentVisibleRect.minY), 680),
    "SwiftUI chat scroll controller exposes semantic prepend restoration"
  )
  controller.scrollBottom()
  check(
    controller.isAtBottom
      && approximatelyEqual(Double(bridgeScroll.documentVisibleRect.minY), 1_040),
    "SwiftUI chat scroll controller exposes return to bottom"
  )

  setLiveUserLogicalOffset(510, scrollView: bridgeScroll, document: bridgeDocument)
  controller.detach(from: bridgeScroll)
  let (reattachedScroll, _) = makeRawScrollHarness(contentHeight: 1_240)
  controller.attach(to: reattachedScroll)
  controller.activate(sessionID: "bridge-session")
  check(
    !controller.isAtBottom
      && approximatelyEqual(Double(reattachedScroll.documentVisibleRect.minY), 510),
    "SwiftUI chat scroll controller retains session state across AppKit reattachment"
  )
  controller.detach(from: reattachedScroll)

  let noOpScroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 320, height: 200))
  let recordingClip = RecordingChatClipView(frame: noOpScroll.contentView.frame)
  noOpScroll.contentView = recordingClip
  noOpScroll.documentView = FlippedChatDocumentView(
    frame: NSRect(x: 0, y: 0, width: 320, height: 1_000)
  )
  noOpScroll.layoutSubtreeIfNeeded()
  let noOpCoordinator = ArkChatScrollCoordinator(scrollView: noOpScroll, followThreshold: 44)
  defer { noOpCoordinator.invalidate() }
  noOpCoordinator.activate(sessionID: "no-op-layout")
  let requestsAfterActivation = recordingClip.scrollRequestCount
  noOpCoordinator.contentDidChange()
  noOpCoordinator.contentDidChange()
  check(
    recordingClip.scrollRequestCount == requestsAfterActivation,
    "AppKit chat coordinator suppresses repeated same-geometry bottom scroll requests"
  )
}
