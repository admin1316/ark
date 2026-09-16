import Foundation
import JiuzhangShellCore

private func semanticEntry(_ seq: Int, _ type: String = "assistant/message", data: JSONValue? = nil) -> JSONValue {
  .object(["event": .object([
    "seq": .number(Double(seq)), "type": .string(type), "time": .number(1234),
    "data": data ?? .object(["turn": .number(1), "step": .number(2), "message": .object([
      "id": .string("message-1"), "content": .array([.object(["type": .string("text"), "text": .string("文🙂é")])]),
    ])]),
  ])])
}

private func semanticPageFixture() -> JSONValue {
  .object([
    "view": .string("semantic"), "sourceRevision": .string("source:9"), "asOfThroughSeq": .number(9),
    "records": .array([.object([
      "id": .string("assistant-1"), "kind": .string("assistant"), "state": .string("complete"),
      "orderSeq": .number(1), "time": .number(1234), "turn": .number(1), "step": .number(2),
      "preview": .string("preview"), "contentState": .string("complete-at-cut"),
      "canonicalEventSeq": .number(8), "completedTurnEndSeq": .number(9),
    ])]),
    "turns": .array([.object(["turn": .number(1), "startSeq": .number(0), "endSeq": .number(9), "usage": .null])]),
    "dependencyRecords": .object(["tool": .string("tool-seed"), "status": .string("status-seed"), "turn": .string("turn-seed")]),
    "hasMore": .bool(true), "nextBeforeRecordId": .string("assistant-1"), "pendingDomains": .array([]),
  ])
}

private func replacing(_ value: JSONValue, _ key: String, _ replacement: JSONValue) -> JSONValue {
  var object = value.objectValue!
  object[key] = replacement
  return .object(object)
}

private func semanticRejects(_ action: () throws -> Void) -> Bool {
  do { try action(); return false } catch { return true }
}

private actor SemanticContentFixture {
  enum Fault: Sendable { case none, offset, cut, handle, record, noProgress, decode }
  let text: String
  let fault: Fault
  let blockInitial: Bool
  let blockContinuation: Bool
  var blocked = false
  var continuation: CheckedContinuation<Void, Never>?
  var started = false
  var closes = 0
  var requests: [[String: JSONValue]] = []

  init(fault: Fault = .none, blockInitial: Bool = false, blockContinuation: Bool = false) {
    let content: JSONValue = .object(["kind": .string("assistant"), "entry": semanticEntry(8)])
    text = fault == .decode ? "invalid JSON" : String(data: try! JSONEncoder().encode(content), encoding: .utf8)!
    self.fault = fault
    self.blockInitial = blockInitial
    self.blockContinuation = blockContinuation
  }

  func waitStarted() async { while !started { await Task.yield() } }
  func waitBlocked() async { while !blocked { await Task.yield() } }
  func release() { continuation?.resume(); continuation = nil }

  func request(_ request: [String: JSONValue]) async throws -> JSONValue {
    requests.append(request)
    if request["close"] == .bool(true) {
      // Cleanup must not inherit cancellation from the transfer it is disposing.
      try Task.checkCancellation()
      closes += 1
      return .null
    }
    if !started {
      started = true
      if blockInitial { await withCheckedContinuation { continuation = $0 } }
    }
    let offset = Int(request["offset"]!.numberValue!)
    if blockContinuation && offset > 0 {
      blocked = true
      await withCheckedContinuation { continuation = $0 }
    }
    let maximum = Int(request["maxCodeUnits"]!.numberValue!)
    let units = Array(text.utf16)
    var end = min(offset + maximum, units.count)
    if end < units.count && end > offset && (0xD800...0xDBFF).contains(units[end - 1]) { end -= 1 }
    let fragment = String(decoding: units[offset..<end], as: UTF16.self)
    let corrupt = fault != .none && offset > 0
    return .object([
      "view": .string("content"), "encoding": .string("json"),
      "sourceRevision": .string(corrupt && fault == .cut ? "other:9" : "source:9"),
      "asOfThroughSeq": .number(9), "recordId": .string(corrupt && fault == .record ? "wrong" : "assistant-1"),
      "contentReadId": .string(corrupt && fault == .handle ? "wrong-handle" : "read-1"),
      "offset": .number(Double(offset + (corrupt && fault == .offset ? 1 : 0))),
      "text": .string(corrupt && fault == .noProgress ? "" : fragment),
      "nextOffset": .number(Double(corrupt && fault == .noProgress ? offset : end)),
      "done": .bool(end == units.count),
    ])
  }
}

/// Intercepts only this fixture's URLSession. Real client request/envelope code runs.
private final class SemanticHistoryURLProtocol: URLProtocol, @unchecked Sendable {
  private static let lock = NSLock()
  private static var captured: [JSONValue] = []
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  static func reset() { lock.lock(); defer { lock.unlock() }; captured = [] }
  static func values() -> [JSONValue] { lock.lock(); defer { lock.unlock() }; return captured }
  override func startLoading() {
    do {
      var body = request.httpBody
      if body == nil, let stream = request.httpBodyStream {
        stream.open(); defer { stream.close() }
        var data = Data(); var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
          let count = stream.read(&buffer, maxLength: buffer.count)
          if count <= 0 { break }
          data.append(buffer, count: count)
        }
        body = data
      }
      let envelope = try JSONDecoder().decode(JSONValue.self, from: body ?? Data())
      Self.lock.lock(); Self.captured.append(envelope); Self.lock.unlock()
      let child = envelope["method"] == .string("subagent/history")
      let options = child ? envelope["payload"]?["args"]?["beforeSeq"] : envelope["payload"]?["args"]?["request"]
      let value: JSONValue
      if options?["view"] == .string("raw") {
        value = .object(["view": .string("raw"), "sourceRevision": .string("source:9"), "asOfThroughSeq": .number(9), "events": .array([semanticEntry(8), semanticEntry(9)]), "hasMore": .bool(true)])
      } else if options?["view"] == .string("content") {
        let body: JSONValue = .object(["kind": .string("assistant"), "entry": semanticEntry(8)])
        let text = String(data: try JSONEncoder().encode(body), encoding: .utf8)!
        value = .object(["view": .string("content"), "encoding": .string("json"), "sourceRevision": .string("source:9"), "asOfThroughSeq": .number(9), "recordId": .string("assistant-1"), "contentReadId": .string("wire-read"), "offset": .number(0), "text": .string(text), "nextOffset": .number(Double(text.utf16.count)), "done": .bool(true)])
      } else { value = semanticPageFixture() }
      let business: JSONValue = child ? value : .object(["ok": .bool(true), "value": value])
      let result: JSONValue = .object(["type": .string("server-response"), "rpcId": envelope["rpcId"]!,
        "result": .object(["ok": .bool(true), "value": .object(["ok": .bool(true), "value": business])]),
      ])
      let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: try JSONEncoder().encode(result))
      client?.urlProtocolDidFinishLoading(self)
    } catch { client?.urlProtocol(self, didFailWithError: error) }
  }
  override func stopLoading() {}
}

func runArkSemanticHistoryContractChecks() async {
  await runArkPromptRetryContractChecks()
  do {
    let cut = try ArkHistoryCut(sourceRevision: "source:9", throughSequence: 9)
    let fixture = semanticPageFixture()
    let page = try ArkSemanticHistory.page(from: fixture)
    check(page.cut == cut && page.records.first?.canonicalEventSequence == 8 && page.records.first?.time == Date(timeIntervalSince1970: 1.234), "semantic page keeps fixed cut, stable identity and milliseconds")
    for (name, malformed) in [
      ("raw masquerade", replacing(fixture, "view", .string("raw"))),
      ("parallel raw events", replacing(fixture, "events", .array([]))),
      ("duplicate records", replacing(fixture, "records", .array([fixture["records"]!.arrayValue![0], fixture["records"]!.arrayValue![0]]))),
      ("empty progress", replacing(fixture, "records", .array([]))),
      ("wrong cursor", replacing(fixture, "nextBeforeRecordId", .string("other"))),
      ("future cut", replacing(fixture, "asOfThroughSeq", .number(0))),
      ("unimplemented domains", replacing(fixture, "pendingDomains", .array([.string("workflow")]))),
    ] { check(semanticRejects { _ = try ArkSemanticHistory.page(from: malformed) }, "semantic rejects \(name)") }
    check(semanticRejects { _ = try ArkSemanticHistory.page(from: fixture, expectedCut: ArkHistoryCut(sourceRevision: "other:9", throughSequence: 9)) }, "semantic rejects changed source identity")
    check(semanticRejects { _ = try ArkSemanticHistory.page(from: fixture, expectedCut: cut, beforeRecordID: "later", beforeOrderSequence: 1) }, "older page cannot cross its previous order boundary")
    let canonical = try ArkSemanticHistory.content(from: .object(["kind": .string("assistant"), "entry": semanticEntry(8)]), cut: cut)
    let row = try canonical.message(for: page.records[0])
    check(row?.text == "文🙂é" && row?.messageID == "message-1" && row?.id == 8, "immutable canonical mapping preserves complete content and source identity")
    var prefixDescriptor = fixture["records"]!.arrayValue![0].objectValue!
    prefixDescriptor.removeValue(forKey: "canonicalEventSeq"); prefixDescriptor["state"] = .string("active")
    let prefixPage = try ArkSemanticHistory.page(from: replacing(fixture, "records", .array([.object(prefixDescriptor)])))
    let prefix = try ArkSemanticHistory.content(from: .object(["kind": .string("assistant-prefix"), "turn": .number(1), "step": .number(2), "content": .array([
      .object(["type": .string("reasoning"), "text": .string("thought")]), .object(["type": .string("text"), "text": .string("prefix🙂")]),
    ])]), cut: cut)
    let prefixRow = try prefix.message(for: prefixPage.records[0])
    check(prefixRow?.id == 1 && prefixRow?.text == "prefix🙂" && prefixRow?.reasoning == "thought" && prefixRow?.interrupted == false, "prefix mapping uses immutable blocks without canonical-final identity")
    check(semanticRejects { _ = try prefix.message(for: page.records[0]) }, "prefix cannot impersonate a canonical final")

    let raw: JSONValue = .object(["view": .string("raw"), "sourceRevision": .string("source:9"), "asOfThroughSeq": .number(9), "events": .array([semanticEntry(8), semanticEntry(9)]), "hasMore": .bool(true)])
    let rawPage = try ArkSemanticHistory.rawPage(from: raw, expectedCut: cut)
    check(rawPage.page.events.map(\.id) == [8, 9], "bound raw preserves contiguous range and independent fixed head")
    check(semanticRejects { _ = try ArkSemanticHistory.rawPage(from: replacing(raw, "events", .array([semanticEntry(7), semanticEntry(9)]))) }, "bound raw rejects internal gap")
    check(semanticRejects { _ = try ArkSemanticHistory.rawPage(from: raw, beforeSequence: 9) }, "bound raw rejects events past exclusive before boundary")
    check(semanticRejects { _ = try ArkSemanticHistory.rawPage(from: replacing(raw, "view", .string("semantic"))) }, "bound raw cannot decode a semantic response")
    check(semanticRejects { _ = try ArkSemanticHistory.rawPage(from: raw, beforeSequence: Int.min) }, "bound raw rejects invalid integer before arithmetic")
    check(semanticRejects { _ = try ArkSemanticHistory.rawPage(from: raw, maximumEvents: 1) }, "bound raw still rejects a response exceeding the requested event budget")

    for fault in [SemanticContentFixture.Fault.none, .offset, .cut, .handle, .record, .noProgress, .decode] {
      let server = SemanticContentFixture(fault: fault)
      var succeeded = false
      do {
        let content = try await ArkSemanticHistory.readContent(cut: cut, recordID: "assistant-1", maximumCodeUnits: 7) { try await server.request($0) }
        succeeded = try content.message(for: page.records[0])?.text == "文🙂é"
      } catch {}
      let closeCount = await server.closes
      check(succeeded == (fault == .none), "content transfer \(fault) accepts only exact complete JSON")
      if fault != .none && fault != .decode { check(closeCount == 1, "content transfer \(fault) closes original handle once") }
      if fault == .none || fault == .decode { check(closeCount == 0, "completed transfer \(fault) does not close already-released handle") }
    }
    let late = SemanticContentFixture(blockInitial: true)
    let task = Task { try await ArkSemanticHistory.readContent(cut: cut, recordID: "assistant-1", maximumCodeUnits: 7) { try await late.request($0) } }
    await late.waitStarted(); task.cancel(); await late.release()
    var cancelled = false
    do { _ = try await task.value } catch is CancellationError { cancelled = true } catch {}
    let lateCloses = await late.closes
    check(cancelled && lateCloses == 1, "late initial response after cancellation releases its handle with uncancelled cleanup")

    let mid = SemanticContentFixture(blockContinuation: true)
    let midTask = Task { try await ArkSemanticHistory.readContent(cut: cut, recordID: "assistant-1", maximumCodeUnits: 7) { try await mid.request($0) } }
    await mid.waitBlocked(); midTask.cancel(); await mid.release()
    do { _ = try await midTask.value } catch {}
    let midCloses = await mid.closes
    let midRequests = await mid.requests
    check(midCloses == 1 && midRequests.last?["contentReadId"] == .string("read-1"), "cancelled continuation closes its original handle before returning")

    let dependency: JSONValue = .object([
      "kind": .string("dependency"), "domain": .string("turn"), "sourceRevision": .string("source:9"), "asOfThroughSeq": .number(9),
      "completeness": .string("complete"), "chunkCoverage": .string("timing-boundaries"), "missing": .array([]),
      "entries": .array([semanticEntry(0, "turn/start"), semanticEntry(8), semanticEntry(9, "turn/end")]), "turns": fixture["turns"]!,
    ])
    if case .dependency(let bundle) = try ArkSemanticHistory.content(from: dependency, cut: cut) {
      check(bundle.entries.map(\.id) == [0,8,9] && bundle.turns.first?.usage == nil && bundle.chunkCoverage == .timingBoundaries, "dependency sparse entries stay separate from contiguous raw and unknown usage")
    } else { check(false, "dependency has distinct typed payload") }
    check(semanticRejects { _ = try ArkSemanticHistory.content(from: replacing(dependency, "chunkCoverage", .string("none")), cut: cut) }, "turn dependency cannot silently claim missing timing coverage")
    check(semanticRejects { _ = try ArkSemanticHistory.content(from: replacing(dependency, "entries", .array([semanticEntry(8),semanticEntry(0)])), cut: cut) }, "dependency rejects unsorted evidence")
    var activeTurn = fixture["turns"]!.arrayValue![0].objectValue!
    activeTurn.removeValue(forKey: "endSeq")
    activeTurn["usage"] = .object(["uncachedInputTokens": .number(3), "outputTokens": .number(2), "totalTokens": .number(5)])
    check(semanticRejects { _ = try ArkSemanticHistory.page(from: replacing(fixture, "turns", .array([.object(activeTurn)]))) }, "active turn cannot receive completed exact usage facts")
    activeTurn["endSeq"] = .number(9)
    let exactPage = try ArkSemanticHistory.page(from: replacing(fixture, "turns", .array([.object(activeTurn)])))
    check(exactPage.turns.first?.usage?.totalTokens == 5, "completed exact Host usage remains typed read-only fact")

    SemanticHistoryURLProtocol.reset()
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [SemanticHistoryURLProtocol.self]
    let session = URLSession(configuration: configuration)
    defer { session.invalidateAndCancel() }
    let client = ArkAPIClient(baseURL: URL(string: "http://127.0.0.1:1")!, apiToken: "synthetic-test-token", session: session)
    _ = try await client.semanticHistoryPage(sessionID: "session-1")
    _ = try await client.subagentSemanticHistoryPage(parentSessionID: "parent-1", childSessionID: "child-1", mode: "local")
    _ = try await client.boundHistoryPage(sessionID: "session-1", cut: cut)
    _ = try await client.subagentBoundHistoryPage(parentSessionID: "parent-1", childSessionID: "child-1", mode: "local", cut: cut)
    let directContent = try await client.semanticHistoryContent(sessionID: "session-1", cut: cut, recordID: "assistant-1")
    let childContent = try await client.subagentSemanticHistoryContent(parentSessionID: "parent-1", childSessionID: "child-1", mode: "local", cut: cut, recordID: "assistant-1")
    let directMessage = try directContent.message(for: page.records[0])
    let childMessage = try childContent.message(for: page.records[0])
    check(directMessage == childMessage, "both content entry routes return complete canonical body")
    let wire = SemanticHistoryURLProtocol.values()
    check(wire.count == 6 && wire[0]["payload"]?["args"]?["request"]?["sessionId"] == .string("session-1") && wire[0]["payload"]?["args"]?["request"]?["view"] == .string("semantic"), "session semantic uses existing domain request and double result unwrapping")
    check(wire.count == 6 && wire[1]["payload"]?["args"]?["parentSessionId"] == .string("parent-1") && wire[1]["payload"]?["args"]?["childSessionId"] == .string("child-1") && wire[1]["payload"]?["args"]?["mode"] == .string("local") && wire[1]["payload"]?["args"]?["beforeSeq"]?["view"] == .string("semantic") && wire[1]["payload"]?["args"]?["maxMessages"] == nil, "child semantic preserves parent/mode admission, fourth named option and single result")
    check(wire[2]["payload"]?["args"]?["request"]?["view"] == .string("raw") && wire[2]["payload"]?["args"]?["request"]?["sourceRevision"] == .string("source:9") && wire[3]["payload"]?["args"]?["beforeSeq"]?["view"] == .string("raw"), "bound raw uses explicit view and shared source token on both routes")
    for options in [wire[2]["payload"]?["args"]?["request"], wire[3]["payload"]?["args"]?["beforeSeq"]] {
      check(options?["maxEvents"] == .number(2_048) && options?["maxMessages"] == nil,
            "bound raw transmits event budgets without changing message-count semantics on either route")
    }
    check(wire[4]["payload"]?["args"]?["request"]?["recordId"] == .string("assistant-1") && wire[5]["payload"]?["args"]?["mode"] == .string("local") && wire[5]["payload"]?["args"]?["beforeSeq"]?["recordId"] == .string("assistant-1"), "content transfer retains original session and child mode scope")
  } catch { check(false, "semantic contract fixture completes: \(error)") }
}
