import AppKit
import SwiftUI
import Foundation
import JiuzhangShellCore
@testable import JiuzhangShellUI

final class HistoryWindowFixture: @unchecked Sendable {
  let events: [JSONValue]
  let records: [JSONValue]
  let turns: [JSONValue]
  let dependencies: [String: [JSONValue]]
  let expectedText: String
  var rawLimit = 2_048
  private var incarnation = "fixture"
  func replaceSource() { lock.lock(); defer { lock.unlock() }; incarnation = "replacement" }
  private(set) var reads: [String: Int] = [:]
  private(set) var rawEventsRead = 0
  private var bodies: [String: String] = [:]
  private let lock = NSLock()

  init(rows count: Int, bodyBytes: Int = 0) {
    expectedText = ""
    turns = []
    dependencies = ["tool": [], "status": [], "turn": []]
    let kind = bodyBytes > 0 ? "assistant" : "user"
    events = (0..<count).map { seq in
      Self.event(seq, "\(kind)/message", ["message": .object(["content": .array([.object([
        "type": .string("text"), "text": .string(bodyBytes > 0 ? String(repeating: "x", count: bodyBytes) : "row \(seq)"),
      ])])])])
    }
    records = (0..<count).map { Self.record($0, kind: kind, canonical: $0) }
  }

  init(chunks: Int, closed: Bool = false, endReason: String = "completed") {
    expectedText = (0..<chunks).map { "p\($0 % 10)" }.joined()
    var source: [JSONValue] = [
      Self.event(0, "turn/start", ["turn": .number(1)]),
      Self.event(1, "user/message", ["content": .array([.object(["type": .string("text"), "text": .string("question")])])]),
      Self.event(2, "step/start", ["turn": .number(1), "step": .number(2)]),
    ]
    for index in 0..<chunks {
      source.append(Self.event(index + 3, "assistant/chunk", ["turn": .number(1), "step": .number(2), "chunk": .object([
        "type": .string("text-delta"), "index": .number(0), "text": .string("p\(index % 10)"),
      ])]))
    }
    let canonical = closed ? source.count : nil
    if closed {
      source.append(Self.event(source.count, "assistant/message", ["turn": .number(1), "step": .number(2), "message": .object([
        "content": .array([.object(["type": .string("text"), "text": .string(expectedText)])]),
      ])]))
      source.append(Self.event(source.count, "step/end", ["turn": .number(1), "step": .number(2)]))
      source.append(Self.event(source.count, "turn/end", ["turn": .number(1), "reason": .object(["kind": .string(endReason)])]))
    }
    events = source
    var assistant = Self.record(3, kind: "assistant", canonical: canonical).objectValue!
    assistant["turn"] = .number(1); assistant["step"] = .number(2)
    if closed && endReason == "completed" { assistant["completedTurnEndSeq"] = .number(Double(source.count - 1)) }
    records = [Self.record(1, kind: "user", canonical: 1), .object(assistant)]
    var context: [String: JSONValue] = ["turn": .number(1), "startSeq": .number(0), "usage": .null]
    if closed { context["endSeq"] = .number(Double(source.count - 1)) }
    turns = [.object(context)]
    dependencies = [
      "tool": source.filter { ["turn/start", "turn/end"].contains($0["event"]?["type"]?.stringValue ?? "") },
      "status": source.filter { ["turn/start", "turn/end", "user/message", "assistant/message"].contains($0["event"]?["type"]?.stringValue ?? "") },
      "turn": source.enumerated().filter { index, row in
        row["event"]?["type"] != .string("user/message")
          && (row["event"]?["type"] != .string("assistant/chunk") || index == 3 || index == chunks + 2)
      }.map(\.element),
    ]
  }

  init(renderTurns: Int, tableHistory: Bool = false) {
    expectedText = ""; var source: [JSONValue] = []; var descriptors: [JSONValue] = []; var contexts: [JSONValue] = []
    func push(_ type: String, _ data: [String: JSONValue]) -> Int {
      let seq = source.count; source.append(Self.event(seq, type, data)); return seq
    }
    for turn in 1...renderTurns {
      let start = push("turn/start", ["turn": .number(Double(turn))])
      let user = push("user/message", ["turn": .number(Double(turn)), "content": .array([.object(["type": .string("text"), "text": .string("Synthetic question \(turn)")])])])
      _ = push("step/start", ["turn": .number(Double(turn)), "step": .number(Double(turn))])
      let table = "| 序号 | 内容 | 状态 |\n| --- | --- | --- |\n" + (1...20).map { "| \($0) | Synthetic table row with wrapping content \($0) | 完成 |" }.joined(separator: "\n")
      let text = tableHistory && turn == 2 ? table + "\n\n```swift\nfor value in 1...20 {\n  print(value)\n}\n```" : "Synthetic answer \(turn). **Complete** rendered paragraph.\n\n- First item\n- Second item"
      _ = push("assistant/chunk", ["turn": .number(Double(turn)), "step": .number(Double(turn)), "chunk": .object(["type": .string("text-delta"), "index": .number(0), "text": .string(text)])])
      let answer = push("assistant/message", ["turn": .number(Double(turn)), "step": .number(Double(turn)), "message": .object(["content": .array([.object(["type": .string("text"), "text": .string(text)])])])])
      _ = push("step/end", ["turn": .number(Double(turn)), "step": .number(Double(turn))])
      let end = push("turn/end", ["turn": .number(Double(turn)), "reason": .object(["kind": .string("completed")])])
      for (seq, kind) in [(user, "user"), (answer, "assistant")] {
        var rec = Self.record(seq, kind: kind, canonical: seq).objectValue!
        rec["turn"] = .number(Double(turn)); rec["step"] = .number(Double(turn)); rec["completedTurnEndSeq"] = .number(Double(end))
        descriptors.append(.object(rec))
      }
      contexts.append(.object(["turn": .number(Double(turn)), "startSeq": .number(Double(start)), "endSeq": .number(Double(end)), "usage": .null]))
    }
    events = source; records = descriptors; turns = contexts
    dependencies = [
      "tool": source.filter { ["turn/start", "turn/end"].contains($0["event"]?["type"]?.stringValue ?? "") },
      "status": source.filter { ["turn/start", "turn/end", "user/message", "assistant/message"].contains($0["event"]?["type"]?.stringValue ?? "") },
      "turn": source.filter { $0["event"]?["type"] != .string("user/message") }
    ]
  }

  private static func event(_ seq: Int, _ type: String, _ data: [String: JSONValue]) -> JSONValue {
    .object(["event": .object(["seq": .number(Double(seq)), "type": .string(type), "time": .number(Double(seq * 10)), "data": .object(data)])])
  }

  private static func record(_ seq: Int, kind: String, canonical: Int?) -> JSONValue {
    var value: [String: JSONValue] = ["id": .string("record-\(seq)"), "kind": .string(kind), "state": .string(canonical == nil ? "active" : "complete"),
      "orderSeq": .number(Double(seq)), "time": .number(Double(seq * 10)), "preview": .string("preview \(seq)"), "contentState": .string("complete-at-cut")]
    if let canonical { value["canonicalEventSeq"] = .number(Double(canonical)) }
    return .object(value)
  }

  func response(_ options: JSONValue) throws -> JSONValue {
    lock.lock(); defer { lock.unlock() }
    let current = events.count - 1
    let revision = options["sourceRevision"]?.stringValue ?? "\(incarnation):\(current)"
    guard revision.hasPrefix("\(incarnation):"), let through = Int(revision.dropFirst(incarnation.count + 1)), through <= current else {
      throw ArkAPIError(message: "stale fixture", code: "history-stale-source")
    }
    var result: [String: JSONValue] = ["sourceRevision": .string(revision), "asOfThroughSeq": .number(Double(through))]
    let view = options["view"]?.stringValue ?? "raw"
    result["view"] = .string(view)
    reads[view, default: 0] += 1
    if view == "raw" {
      let before = min(Int(options["beforeSeq"]?.numberValue ?? Double(through + 1)), through + 1)
      let count = min(rawLimit, Int(options["maxEvents"]?.numberValue ?? 2_048))
      let lower = max(0, before - count)
      let rows = Array(events[lower..<before])
      result["events"] = .array(rows); result["hasMore"] = .bool(lower > 0)
      rawEventsRead += rows.count
    } else if view == "semantic" {
      let beforeID = options["beforeRecordId"]?.stringValue
      let before = beforeID.flatMap { id in records.firstIndex { $0["id"] == .string(id) } } ?? records.count
      let count = Int(options["maxRecords"]?.numberValue ?? 50)
      let lower = max(0, before - count)
      result["records"] = .array(Array(records[lower..<before])); result["hasMore"] = .bool(lower > 0)
      if lower > 0 { result["nextBeforeRecordId"] = records[lower]["id"] }
      result["turns"] = .array(turns)
      result["pendingDomains"] = .array([])
      result["dependencyRecords"] = .object(["tool": .string("dependency-tool"), "status": .string("dependency-status"), "turn": .string("dependency-turn")])
    } else {
      let id = options["recordId"]!.stringValue!
      let offset = Int(options["offset"]?.numberValue ?? 0)
      let handle = options["contentReadId"]?.stringValue ?? "read-\(id)"
      if options["close"] == .bool(true) { bodies.removeValue(forKey: handle); return .null }
      if offset == 0 {
        reads[id, default: 0] += 1
        let body: JSONValue
        if id.hasPrefix("dependency-") {
          let domain = String(id.dropFirst(11))
          body = .object(["kind": .string("dependency"), "domain": .string(domain), "sourceRevision": .string(revision), "asOfThroughSeq": .number(Double(through)),
            "completeness": .string("complete"), "missing": .array([]), "chunkCoverage": .string(domain == "turn" ? "timing-boundaries" : "none"),
            "entries": .array(dependencies[domain] ?? []), "turns": .array(turns)])
        } else {
          let record = records.first { $0["id"] == .string(id) }!
          if let seq = record["canonicalEventSeq"]?.numberValue {
            body = .object(["kind": record["kind"]!, "entry": events[Int(seq)]])
          } else {
            body = .object(["kind": .string("assistant-prefix"), "turn": .number(1), "step": .number(2), "content": .array([.object(["type": .string("text"), "text": .string(expectedText)])])])
          }
        }
        bodies[handle] = String(data: try JSONEncoder().encode(body), encoding: .utf8)!
      }
      let text = bodies[handle]!
      let units = Array(text.utf16)
      var end = min(units.count, offset + Int(options["maxCodeUnits"]?.numberValue ?? 16_384))
      if end < units.count && (0xD800...0xDBFF).contains(units[end - 1]) { end -= 1 }
      result["encoding"] = .string("json"); result["recordId"] = .string(id); result["contentReadId"] = .string(handle)
      result["offset"] = .number(Double(offset)); result["nextOffset"] = .number(Double(end))
      result["text"] = .string(String(decoding: units[offset..<end], as: UTF16.self)); result["done"] = .bool(end == units.count)
      if end == units.count { bodies.removeValue(forKey: handle) }
    }
    return .object(result)
  }
}

final class HistoryWindowURLProtocol: URLProtocol, @unchecked Sendable {
  static var fixture = HistoryWindowFixture(rows: 0)
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    do {
      var data = request.httpBody ?? Data()
      if data.isEmpty, let stream = request.httpBodyStream {
        stream.open(); defer { stream.close() }
        var bytes = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable { let n = stream.read(&bytes, maxLength: bytes.count); if n <= 0 { break }; data.append(bytes, count: n) }
      }
      let envelope = try JSONDecoder().decode(JSONValue.self, from: data)
      guard let options = envelope["payload"]?["args"]?["request"] else {
        throw ArkAPIError(message: "History fixture does not implement this unrelated RPC")
      }
      let business: JSONValue
      do { business = .object(["ok": .bool(true), "value": try Self.fixture.response(options)]) }
      catch let error as ArkAPIError { business = .object(["ok": .bool(false), "error": .object(["code": .string(error.code ?? "fixture-error"), "message": .string(error.message)])]) }
      let response: JSONValue = .object(["type": .string("server-response"), "rpcId": envelope["rpcId"]!, "result": .object(["ok": .bool(true), "value": .object(["ok": .bool(true), "value": business])])])
      client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: try JSONEncoder().encode(response)); client?.urlProtocolDidFinishLoading(self)
    } catch { client?.urlProtocol(self, didFailWithError: error) }
  }
  override func stopLoading() {}
}

@MainActor
func runArkHistoryWindowContractChecks() async {
  let configuration = URLSessionConfiguration.ephemeral
  configuration.protocolClasses = [HistoryWindowURLProtocol.self]
  let session = URLSession(configuration: configuration)
  defer { session.invalidateAndCancel() }
  let client = ArkAPIClient(baseURL: URL(string: "http://127.0.0.1:1")!, apiToken: "synthetic-fixture", session: session)
  let address = ArkHistoryAddress.session("fixture")
  do {
    let rows = HistoryWindowFixture(rows: 2_601)
    HistoryWindowURLProtocol.fixture = rows
    let reader = ArkHistoryReadingWindow(client: client, address: address, language: .en)
    var snapshot = try await reader.open()
    var seen = Set(snapshot.records.map(\.orderSequence))
    var pages = 1
    while snapshot.hasOlderHistory {
      let oldAnchor = snapshot.records.first!.id
      snapshot = try await reader.older()
      check(snapshot.records.count <= 400 && snapshot.records.contains { $0.id == oldAnchor }, "older window \(pages) retains its adjacent anchor under 400 records")
      seen.formUnion(snapshot.records.map(\.orderSequence)); pages += 1
    }
    check(seen.count == 2_601 && snapshot.records.first?.orderSequence == 0, "semantic navigation reaches all records beyond the former 2000 cap")
    while snapshot.hasNewerHistory { snapshot = try await reader.newer() }
    check(snapshot.records.last?.orderSequence == 2_600, "newer navigation returns to the fixed-cut newest page")
    check(["tool", "status", "turn"].allSatisfy { rows.reads["dependency-\($0)"] == 1 }, "three same-cut seeds are fetched once across both directions")

    for (reason, expected) in [("interrupted", ArkChatTurnState.interrupted), ("aborted", .aborted), ("error", .failed)] {
      let ended = HistoryWindowFixture(chunks: 3, closed: true, endReason: reason)
      HistoryWindowURLProtocol.fixture = ended
      let endedReader = ArkHistoryReadingWindow(client: client, address: address, language: .en)
      let endedSnapshot = try await endedReader.open()
      check(endedSnapshot.turnTerminalStates[1] == expected && endedSnapshot.completedTurnIDs.isEmpty
        && endedSnapshot.forkableMessageIDs.isEmpty,
        "same-cut history installs \(reason) as terminal without granting completed fork actions")
      endedReader.cancel()
    }

    let dense = HistoryWindowFixture(chunks: 60_010)
    HistoryWindowURLProtocol.fixture = dense
    let activeReader = ArkHistoryReadingWindow(client: client, address: address, language: .en)
    let activeSnapshot = try await activeReader.open(hydrateActive: false)
    let restored = try await ArkHistoryFoldWorker.shared.recover(client: client, address: address, cut: activeSnapshot.cut, checkpoint: nil, seed: activeReader.seed, snapshot: activeSnapshot, language: .en)
    check(restored.fold.messages.messages.last?.text == dense.expectedText && restored.fold.events.count <= 50_000, "cold active recovery preserves all 60010 chunks beyond raw retention")
    let rawReference = dense.events.compactMap { ArkAPIClient.event(fromWire: $0["event"]!) }
    check(restored.fold.turnProjection == ArkChatTurnProjection(events: rawReference), "cold recovery installs exact full-raw timing state from typed seed")
    check(dense.reads["record-3"] == nil, "cold live recovery does not also materialize immutable active body")
    let warmReads = dense.rawEventsRead
    let warm = try await ArkHistoryFoldWorker.shared.recover(client: client, address: address, cut: activeSnapshot.cut, checkpoint: restored.fold, seed: nil, snapshot: nil, language: .en)
    check(warm.fold.messages.messages == restored.fold.messages.messages && dense.rawEventsRead - warmReads == 1, "warm checkpoint at same cut never refolds clipped suffix or replays old chunks")

    do {
      _ = try ArkHistoryReadingSeed.usageFacts(from: activeReader.seed!.turnContexts + activeReader.seed!.turnContexts)
      check(false, "duplicate turn facts are rejected without a trapping dictionary")
    } catch let error as ArkAPIError {
      check(error.code == "invalid-history-response", "duplicate turn facts are rejected without a trapping dictionary")
    }
    dense.replaceSource()
    let replacementHead = try await address.raw(client: client, maximum: 1)
    check(replacementHead.cut.sourceRevision != activeSnapshot.cut.sourceRevision, "replacement fixture admits a fresh head after the former checkpoint was valid")
    do {
      try await address.validateCheckpoint(client: client, cut: activeSnapshot.cut)
      check(false, "warm publication rejects a checkpoint replaced between admission and fresh head")
    } catch let error as ArkAPIError {
      check(error.code == "history-stale-source", "warm publication rejects a checkpoint replaced between admission and fresh head")
    }

    let clipped = HistoryWindowFixture(chunks: 80)
    clipped.rawLimit = 17
    HistoryWindowURLProtocol.fixture = clipped
    let clippedReader = ArkHistoryReadingWindow(client: client, address: address, language: .en)
    let clippedSnapshot = try await clippedReader.open(hydrateActive: false)
    let clippedFold = try await ArkHistoryFoldWorker.shared.recover(client: client, address: address, cut: clippedSnapshot.cut, checkpoint: nil, seed: clippedReader.seed, snapshot: clippedSnapshot, language: .en)
    check(clippedFold.fold.messages.messages.last?.text == clipped.expectedText, "byte-clipped forward replay halves the span without skipping its missing prefix")

    let closed = HistoryWindowFixture(chunks: 60_010, closed: true)
    HistoryWindowURLProtocol.fixture = closed
    let closedReader = ArkHistoryReadingWindow(client: client, address: address, language: .en)
    let closedSnapshot = try await closedReader.open(hydrateActive: false)
    let closedFold = try await ArkHistoryFoldWorker.shared.recover(client: client, address: address, cut: closedSnapshot.cut, checkpoint: nil, seed: closedReader.seed, snapshot: closedSnapshot, language: .en)
    check(closedFold.fold.messages.messages.filter { $0.role == .assistant }.count == 1 && closedFold.fold.messages.messages.last?.text == closed.expectedText, "closed dense turn installs one canonical complete row")
    check(closed.rawEventsRead == 2, "closed dense turn does not replay 60010 historical chunks")
    let historicalTrajectory = ArkTrajectoryProjection.records(from: closedSnapshot)
    let assistantTrajectory = historicalTrajectory.filter { $0.kind == .message }
    check(assistantTrajectory.count == 1 && assistantTrajectory.first?.output == closed.expectedText,
      "trajectory uses complete same-cut canonical body without timing-only chunk replay")
    check(assistantTrajectory.first?.events.map(\.type) == ["assistant/message"],
      "trajectory canonical source is the genuine event, without fabricated chunk or final evidence")

    let statusCut = try ArkHistoryCut(sourceRevision: "status-fixture", throughSequence: 60_010)
    func statusEntry(_ id: Int, _ type: String, _ data: [String: JSONValue]) -> JSONValue {
      .object(["event": .object(["seq": .number(Double(id)), "type": .string(type), "time": .number(Double(id)), "data": .object(data)])])
    }
    let statusEntries = [
      statusEntry(0, "turn/start", ["turn": .number(1)]),
      statusEntry(1, "command/run", ["commandId": .string("early"), "turn": .number(1)]),
      statusEntry(2, "llm/retry", ["turn": .number(1), "retryId": .string("r"), "retry": .number(2), "maxRetries": .number(4), "delayMs": .number(1000)]),
      statusEntry(60_010, "turn/end", ["turn": .number(1), "reason": .object(["kind": .string("completed")])]),
    ]
    let statusContent = try ArkSemanticHistory.content(from: .object([
      "kind": .string("dependency"), "domain": .string("status"), "sourceRevision": .string(statusCut.sourceRevision),
      "asOfThroughSeq": .number(60_010), "completeness": .string("complete"), "missing": .array([]),
      "chunkCoverage": .string("none"), "entries": .array(statusEntries), "turns": .array([]),
    ]), cut: statusCut)
    if case .dependency(let bundle) = statusContent {
      let localized = try ArkHistoryStatusRelocalization.projection(bundle: bundle, through: 60_010, language: .en)
      let reference = ArkChatStatusProjection(events: bundle.entries, language: .en)
      check(localized.statuses == reference.statuses && localized.statuses.count == 2,
        "language change retains completed command and retry facts before the 50000-event ring")
      let done = ArkHistoryEvent(id: 60_011, type: "command/done", time: Date(), data: .object(["commandId": .string("early"), "kind": .string("success")]), view: nil)
      let caught = try ArkHistoryStatusRelocalization.catchingUp(localized, from: 60_010, publishedEvents: [done])
      var full = reference; full.append(done)
      check(caught.statuses == full.statuses, "language change catches up only published contiguous lifecycle events")
      let future = ArkHistoryEvent(id: 60_013, type: "turn/start", time: Date(), data: .object(["turn": .number(2)]), view: nil)
      do {
        _ = try ArkHistoryStatusRelocalization.catchingUp(localized, from: 60_010, publishedEvents: [future])
        check(false, "language change refuses a missing catch-up prefix instead of resetting state")
      } catch let error as ArkAPIError {
        check(error.code == "history-localization-gap", "language change refuses a missing catch-up prefix instead of resetting state")
      }
      let beforeEnd = try ArkHistoryStatusRelocalization.projection(bundle: bundle, through: 60_009, language: .en)
      check(beforeEnd.statuses.allSatisfy { $0.phase == .running }, "language change never installs future status facts beyond the published boundary")
    }
    let beforeLocale = closedReader.snapshot!
    let afterLocale = try await closedReader.relocalize(to: .zh)!
    check(beforeLocale.cut == afterLocale.cut && beforeLocale.records == afterLocale.records && beforeLocale.messages == afterLocale.messages,
      "historical locale change preserves the same cut, reading range and hydrated bodies")

    let large = HistoryWindowFixture(rows: 2, bodyBytes: 3 * 1_024 * 1_024)
    HistoryWindowURLProtocol.fixture = large
    let largeReader = ArkHistoryReadingWindow(client: client, address: address, language: .en)
    let largeSnapshot = try await largeReader.open()
    let previewTrajectory = ArkTrajectoryProjection.records(from: largeSnapshot).filter { $0.isHistoryPreview }
    check(!previewTrajectory.isEmpty && previewTrajectory.allSatisfy { $0.output == nil && $0.input == nil && $0.events.isEmpty },
      "trajectory previews never masquerade as full body or raw event source")
    check(largeReader.ordinaryBodyBytes <= 8 * 1_024 * 1_024 && largeReader.oversizedBodyCount <= 1 && !largeSnapshot.previewMessageIDs.isEmpty, "resident body budget replaces evicted full bodies with explicit previews")
    if let id = largeSnapshot.previewMessageIDs.first {
      let complete = try await largeReader.message(messageID: id)
      check(complete.text.utf8.count == 3 * 1_024 * 1_024, "evicted body remains completely reachable through its immutable locator")
    }
  } catch { check(false, "history window contract completes: \(error)") }
}

// The shared Markdown parent owns the 30-second process deadline. A main-actor
// timeout cannot detect the SwiftUI layout stall this scenario reproduces.
@MainActor
func runArkHistoryTransitionProbeChild() -> Int32 {
  let application = NSApplication.shared
  application.setActivationPolicy(.prohibited)
  let delegate = HistoryTransitionProbeDelegate()
  application.delegate = delegate
  application.run()
  application.delegate = nil
  return delegate.status
}

@MainActor
private final class HistoryTransitionProbeDelegate: NSObject, NSApplicationDelegate {
  private(set) var status: Int32 = 1
  private var beat: Timer?
  private var heartbeat = 0

  func applicationDidFinishLaunching(_ notification: Notification) {
    beat = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated { self?.heartbeat += 1 }
    }
    Task { await run() }
  }

  private func pause(_ seconds: Double) async {
    try? await Task.sleep(nanoseconds: UInt64(seconds * 1e9))
  }

  private func phase(_ name: String) {
    print("ROOT_TRANSITION \(name) heartbeat=\(heartbeat)")
    fflush(stdout)
  }

  private func run() async {
    let suite = "ark-history-transition-\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(suite)
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [HistoryWindowURLProtocol.self]
    let session = URLSession(configuration: configuration)
    let url = URL(string: "http://ark-synthetic-root.invalid")!
    let client = ArkAPIClient(baseURL: url, apiToken: "synthetic", session: session)
    let model = ArkAppModel(client: client,
      interactions: ArkInteractionAPI(baseURL: url, apiToken: "synthetic", session: session),
      eventPump: ArkEventPump(baseURL: url, apiToken: "synthetic"),
      fallbackWikiRoot: root, documentStore: ArkDocumentReferenceStore(rootURL: root), defaults: defaults)
    HistoryWindowURLProtocol.fixture = HistoryWindowFixture(renderTurns: 2, tableHistory: true)
    model.selectedSessionID = "fixture"
    let hosting = NSHostingView(rootView: ArkRootView(model: model,
      workbenchDraftFlushCoordinator: NativeWorkbenchDraftFlushCoordinator()).defaultAppStorage(defaults))
    let window = NSWindow(contentRect: NSRect(x: -20000, y: -20000, width: 1280, height: 840),
      styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
    window.titleVisibility = .hidden
    window.titlebarAppearsTransparent = true
    window.titlebarSeparatorStyle = .none
    window.tabbingMode = .disallowed
    window.isMovableByWindowBackground = false
    let container = NSView()
    window.contentView = container
    hosting.translatesAutoresizingMaskIntoConstraints = false
    container.addSubview(hosting)
    NSLayoutConstraint.activate([
      hosting.leadingAnchor.constraint(equalTo: container.leadingAnchor),
      hosting.trailingAnchor.constraint(equalTo: container.trailingAnchor),
      hosting.topAnchor.constraint(equalTo: container.topAnchor),
      hosting.bottomAnchor.constraint(equalTo: container.bottomAnchor),
    ])
    window.orderBack(nil)
    defer {
      beat?.invalidate()
      window.contentView = nil
      window.close()
      session.invalidateAndCancel()
      defaults.removePersistentDomain(forName: suite)
      try? FileManager.default.removeItem(at: root)
      NSApp.terminate(nil)
    }
    hosting.layoutSubtreeIfNeeded()
    await pause(0.5)
    await model.refreshHistory(resetPaging: true)
    guard model.messages.count == 4 else { phase("FAIL initial history"); return }
    hosting.layoutSubtreeIfNeeded()
    await pause(3)
    hosting.layoutSubtreeIfNeeded()
    func transcriptScroll(_ view: NSView) -> NSScrollView? {
      if let scroll = view as? NSScrollView, scroll.bounds.width > 600, scroll.bounds.height > 200 { return scroll }
      return view.subviews.lazy.compactMap { transcriptScroll($0) }.first
    }
    guard let scroll = transcriptScroll(hosting), let document = scroll.documentView else {
      phase("FAIL transcript scroll"); return
    }
    let target = document.isFlipped ? max(document.bounds.minY, document.bounds.maxY - scroll.documentVisibleRect.height) : document.bounds.minY
    scroll.contentView.scroll(to: NSPoint(x: 0, y: target))
    scroll.reflectScrolledClipView(scroll.contentView)
    await pause(1)
    // Geometry component of workbench collapse, not its browser lifecycle.
    phase("WIDTH_BEGIN")
    window.setContentSize(NSSize(width: 840, height: 840))
    await pause(1)
    window.setContentSize(NSSize(width: 1280, height: 840))
    await pause(1)
    let draft = (1...18).map { "合成第三条草稿 \($0)：验证较长输入在清空后，表格历史与新轮次出现时的布局。" }.joined(separator: "\n")
    model.composerTextDidChange(draft, caret: draft.utf16.count, isComposing: false)
    await pause(1)
    phase("CLEAR_BEGIN")
    model.composerTextDidChange("", caret: 0, isComposing: false)
    HistoryWindowURLProtocol.fixture = HistoryWindowFixture(renderTurns: 3, tableHistory: true)
    await model.refreshHistory(resetPaging: true)
    phase("NEW_TURN_HYDRATED")
    guard model.messages.count == 6 else { phase("FAIL third turn"); return }
    let priorHeartbeat = heartbeat
    await pause(5)
    guard heartbeat - priorHeartbeat >= 4, model.composer.isEmpty else { phase("FAIL responsiveness"); return }
    status = 0
    print("PASS root-transition messages=6")
    fflush(stdout)
    if let path = ProcessInfo.processInfo.environment["ARK_MARKDOWN_PROBE_RESULT"],
      let data = try? JSONSerialization.data(withJSONObject: ["status": "pass", "heartbeats": heartbeat] as [String: Any]) {
      try? data.write(to: URL(fileURLWithPath: path), options: .atomic)
    }
  }
}
