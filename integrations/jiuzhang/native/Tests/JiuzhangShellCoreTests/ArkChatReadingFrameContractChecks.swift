import Foundation
@testable import JiuzhangShellCore
@testable import JiuzhangShellUI

func runArkChatReadingFrameContractChecks() {
  let id = NativeChatReadingFrames.SourceID(presentationID: 325, textOrdinal: 0)
  let renderID = NativeAssistantMarkdownSourceID(messageID: 325, sourceSlot: 0)
  var frames = NativeChatReadingFrames()
  func record(_ text: String) {
    frames.recordPresentation(
      scope: "session-a", liveSources: [.init(id: id, text: text)], renderIDs: [id: renderID]
    )
  }
  let opening = String(repeating: "读", count: 3_000)
  record(opening)
  frames.suspendFollowing()
  record(opening + String(repeating: "新", count: 11_080))
  check(frames.heldFrames[renderID] == opening,
        "a paused live frame retains already-presented text across the 4096 and 8192 limits")
  frames.returnToLatest()
  record(String(repeating: "新", count: 11_200))
  frames.suspendFollowing()
  let bounded = frames.heldFrames[renderID]
  record(String(repeating: "后", count: 14_080))
  check(bounded == frames.heldFrames[renderID]
      && bounded?.count == ArkStreamingPresentationPolicy.markdownFirstFrameCharacterLimit + 5,
    "holding a sliding suffix keeps its exact bounded frame instead of replacing equal-height text")

  let adopted = NativeAssistantMarkdownSourceID(messageID: 768, sourceSlot: 1)
  frames.recordPresentation(scope: "session-a", liveSources: [], renderIDs: [id: adopted])
  check(frames.heldFrames[adopted] == bounded && frames.heldFrames[renderID] == nil,
        "canonical sequence and reasoning-slot replacement retain the same presentation-owned frame")
  frames.returnToLatest()
  check(frames.heldFrames.isEmpty, "returning to latest releases a frame held through completion")

  frames.suspendFollowing()
  let retryID = NativeChatReadingFrames.SourceID(presentationID: 900, textOrdinal: 0)
  let retryRenderID = NativeAssistantMarkdownSourceID(messageID: 900, sourceSlot: 0)
  frames.recordPresentation(scope: "session-a", liveSources: [.init(id: retryID, text: "retry-first")],
                            renderIDs: [retryID: retryRenderID])
  frames.recordPresentation(scope: "session-a", liveSources: [.init(id: retryID, text: "retry-first-new-tail")],
                            renderIDs: [retryID: retryRenderID])
  check(frames.heldFrames[retryRenderID] == "retry-first" && frames.heldFrames[adopted] == nil,
        "a new source arriving during an existing pause owns its first frame without borrowing the prior message")
  frames.recordPresentation(scope: "session-b", liveSources: [.init(id: retryID, text: "other-session")],
                            renderIDs: [retryID: retryRenderID])
  check(frames.heldFrames.isEmpty, "session identity changes clear reading frames even when event IDs repeat")
  frames.suspendFollowing()
  frames.recordPresentation(scope: "session-b#history:new-cut", liveSources: [], renderIDs: [retryID: retryRenderID])
  check(frames.heldFrames.isEmpty, "changing a fixed history cut releases frames from the previous source")

  var window = ArkChatRenderWindow()
  let rows = (0..<400).map { "row-\($0)" }
  window.suspendLatest(in: rows, limit: 24)
  let retainedRange = window.range(in: rows, limit: 24)
  check(window.range(in: rows + ["completion", "usage"], limit: 24) == retainedRange,
        "a paused render range keeps its first row when terminal metadata appends below it")
  window.returnToLatest()
  check(window.range(in: rows + ["completion", "usage"], limit: 24).upperBound == 402,
        "returning to latest resumes the moving render window")

  var projection = ArkMessageProjection()
  let partial = readingFrameEvent(325, "assistant/chunk", chunk: "first", index: 1)
  projection.append(partial)
  projection.append(readingFrameEvent(326, "assistant/chunk", chunk: "reasoning", index: 0, reasoning: true))
  projection.append(readingFrameEvent(768, "assistant/message", text: "first-final"))
  check(projection.messages.last?.id == 768 && projection.messages.last?.presentationID == 325,
        "the real message reducer preserves live ownership across canonical adoption with a new event sequence")
  projection.append(readingFrameEvent(769, "llm/retry"))
  projection.append(readingFrameEvent(770, "assistant/chunk", chunk: "retry", index: 1))
  check(projection.messages.last?.presentationID == 770,
        "a same-step retry starts a fresh presentation identity in the authoritative assembler")
  var stoppedFrames = NativeChatReadingFrames()
  let stoppedID = NativeChatReadingFrames.SourceID(presentationID: projection.messages.last!.presentationID, textOrdinal: 0)
  let stoppedRenderID = NativeAssistantMarkdownSourceID(messageID: 770, sourceSlot: 0)
  stoppedFrames.recordPresentation(scope: "session-a", liveSources: [.init(id: stoppedID, text: "retry")],
                                   renderIDs: [stoppedID: stoppedRenderID])
  stoppedFrames.suspendFollowing()
  projection.append(readingFrameEvent(771, "assistant/message", text: "retry-cancelled-tail", interrupted: true))
  let cancelledID = NativeAssistantMarkdownSourceID(messageID: projection.messages.last!.id, sourceSlot: 1)
  stoppedFrames.recordPresentation(scope: "session-a", liveSources: [], renderIDs: [stoppedID: cancelledID])
  check(projection.messages.last?.interrupted == true
      && projection.messages.last?.text == "retry-cancelled-tail"
      && stoppedFrames.heldFrames[cancelledID] == "retry",
    "a real interrupted canonical message keeps full cancelled text and the previously shown reading frame")
}

private func readingFrameEvent(
  _ id: Int, _ type: String, text: String? = nil, chunk: String? = nil,
  index: Int = 0, reasoning: Bool = false, interrupted: Bool = false
) -> ArkHistoryEvent {
  var data: [String: JSONValue] = ["turn": .number(1), "step": .number(2)]
  if interrupted { data["interrupted"] = .bool(true) }
  if let text {
    data["message"] = .object([
      "id": .string("synthetic-canonical-message"),
      "content": .array([
        .object(["type": .string("reasoning"), "text": .string("reasoning")]),
        .object(["type": .string("text"), "text": .string(text)]),
      ]),
    ])
  }
  if let chunk {
    data["chunk"] = .object([
      "type": .string(reasoning ? "reasoning-delta" : "text-delta"),
      "index": .number(Double(index)), "text": .string(chunk),
    ])
  }
  return ArkHistoryEvent(id: id, type: type, time: Date(timeIntervalSince1970: Double(id)),
                         data: .object(data), view: nil)
}

@MainActor
func runArkChatReadingFrameFeedContractChecks() async {
  let root = FileManager.default.temporaryDirectory.appendingPathComponent("ark-reader-frame-\(UUID().uuidString)")
  let suite = "ark-reader-frame-\(UUID().uuidString)"
  guard let defaults = UserDefaults(suiteName: suite) else { return }
  let configuration = URLSessionConfiguration.ephemeral
  configuration.protocolClasses = [HistoryWindowURLProtocol.self]
  let transport = URLSession(configuration: configuration)
  let endpoint = URL(string: "http://ark-reader-frame.invalid")!
  let model = ArkAppModel(
    client: ArkAPIClient(baseURL: endpoint, apiToken: "synthetic-contract", session: transport),
    interactions: ArkInteractionAPI(baseURL: endpoint, apiToken: "synthetic-contract", session: transport),
    eventPump: ArkEventPump(baseURL: endpoint, apiToken: "synthetic-contract"),
    fallbackWikiRoot: root, documentStore: ArkDocumentReferenceStore(rootURL: root), defaults: defaults
  )
  defer {
    transport.invalidateAndCancel()
    defaults.removePersistentDomain(forName: suite)
    try? FileManager.default.removeItem(at: root)
  }
  let fixture = HistoryWindowFixture(rows: 1)
  fixture.sessionID = "reader-frame"
  HistoryWindowURLProtocol.fixture = fixture
  model.selectSession(fixture.sessionID, navigateToChat: false)
  guard await readingFrameEventually({ model.historyLoadState == .loaded }) else {
    check(false, "reading frame fixture installs a real active history projection")
    return
  }
  await model.refreshNavigation(refreshWiki: false)
  let feed = ArkChatFeedProbe.Feed(model: model)
  var sequence = fixture.events.count
  func inject(_ type: String, _ data: JSONValue) {
    let event = ArkHistoryEvent(id: sequence, type: type, time: Date(timeIntervalSince1970: Double(sequence)), data: data, view: nil)
    model.consume(ArkEventFrame(channel: .mux, rpcID: "reader-\(sequence)", method: "session/event", payload: .object([
      "sessionId": .string(fixture.sessionID),
      "event": .object(["seq": .number(Double(sequence)), "type": .string(event.type),
                         "time": .number(Double(sequence) * 1_000), "data": event.data]),
    ])))
    sequence += 1
  }
  func delta(_ text: String, index: Int = 1, reasoning: Bool = false) {
    inject("assistant/chunk", .object([
      "turn": .number(1), "step": .number(2),
      "chunk": .object(["type": .string(reasoning ? "reasoning-delta" : "text-delta"),
                         "index": .number(Double(index)), "text": .string(text)]),
    ]))
  }
  inject("turn/start", .object(["turn": .number(1)]))
  inject("step/start", .object(["turn": .number(1), "step": .number(2)]))
  let firstText = String(repeating: "readable-", count: 1_200)
  delta(String(repeating: "readable-", count: 1_200))
  guard await readingFrameEventually({ feed.containsAssistantText(firstText) }) else {
    check(false, "the real feed publishes the initial long live message")
    return
  }
  let sourceID = model.messages.last!.id
  let expectedFrame = ArkStreamingPresentationPolicy.firstFrameText(
    ArkStreamingPresentationPolicy.markdownText(firstText, streaming: true)
  )
  // Mutate the model before the next feed publication, then suspend. The
  // retained frame must belong to the prior snapshot, not this queued delta.
  delta("unpublished-tail")
  feed.followBottom(false)
  let heldPublished = await readingFrameEventually({ feed.heldFrames.values.first == expectedFrame })
  check(heldPublished,
        "a scroll pause captures the last published frame rather than a queued model append")
  let expandedText = firstText + "unpublished-tail" + String(repeating: "tail-", count: 1_000)
  delta(String(repeating: "tail-", count: 1_000))
  delta("new reasoning block", index: 0, reasoning: true)
  let fullTextUpdated = await readingFrameEventually({ feed.containsAssistantText(expandedText) })
  check(fullTextUpdated,
        "full message text continues through the feed while its visible frame is held")
  check(feed.heldFrames[NativeAssistantMarkdownSourceID(messageID: sourceID, sourceSlot: 1)] == expectedFrame,
        "inserting a reasoning block preserves the text source ordinal during a live pause")

  let canonicalID = sequence
  inject("assistant/message", .object([
    "turn": .number(1), "step": .number(2), "message": .object([
      "id": .string("synthetic-final-reader-message"), "content": .array([
        .object(["type": .string("reasoning"), "text": .string("new reasoning block")]),
        .object(["type": .string("text"), "text": .string(expandedText)]),
      ]),
    ]),
  ]))
  inject("turn/end", .object(["turn": .number(1), "reason": .object(["kind": .string("completed")])]))
  fixture.sessionRunning = false
  model.consume(ArkEventFrame(channel: .mux, rpcID: "reader-idle", method: "host/session-status",
                             payload: .object(["sessionId": .string(fixture.sessionID), "running": .bool(false)])))
  let completedWhileHeld = await readingFrameEventually({ !feed.sessionRunning && feed.heldFrames.keys.first?.messageID == canonicalID })
  check(completedWhileHeld,
        "canonical adoption and real Host completion update metadata while retaining the old reading frame")
  check(model.messages.last?.text == expandedText && feed.containsAssistantText(expandedText)
      && feed.heldFrames.values.first == expectedFrame && !feed.hasCanonicalSource(messageID: canonicalID),
    "completion leaves full copyable text intact and delays only the held source's Markdown projection")
  feed.followBottom(true)
  check(feed.heldFrames.values.first == expectedFrame,
        "the retained frame keeps an explicit return-to-latest action available at its physical bottom")
  feed.returnToLatest()
  check(feed.heldFrames.isEmpty && feed.hasCanonicalSource(messageID: canonicalID),
        "returning to latest releases the frame and requests the complete canonical source")
}

@MainActor
private func readingFrameEventually(_ condition: @MainActor () -> Bool) async -> Bool {
  for _ in 0..<600 {
    if condition() { return true }
    try? await Task.sleep(nanoseconds: 10_000_000)
  }
  return condition()
}
