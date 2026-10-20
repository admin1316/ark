import Foundation
import Darwin
import JiuzhangShellCore
@testable import JiuzhangShellUI

/// The real AppModel and RPC codecs run against a transport with delayed project replies.
private final class KnowledgeIsolationURLProtocol: URLProtocol, @unchecked Sendable {
  private static let lock = NSLock()
  private static var projectRoots: [String] = []
  private static var requests: [(String, JSONValue)] = []
  private static var held: [KnowledgeIsolationURLProtocol] = []
  private static var holds = Set<String>()
  private static var queueActive = false
  private static var cancellations = 0
  private var envelope: JSONValue = .null
  private var finished = false

  static func configure(_ roots: [String]) {
    lock.lock(); defer { lock.unlock() }
    projectRoots = roots; requests = []; held = []; holds = []; queueActive = false; cancellations = 0
  }
  static func hold(_ method: String) { lock.lock(); holds.insert(method); lock.unlock() }
  static var pending: Int { lock.lock(); defer { lock.unlock() }; return held.count }
  static var cancelledCount: Int { lock.lock(); defer { lock.unlock() }; return cancellations }
  static func activateQueue() { lock.lock(); queueActive = true; lock.unlock() }
  static func captured(_ method: String) -> [JSONValue] {
    lock.lock(); defer { lock.unlock() }; return requests.filter { $0.0 == method }.map(\.1)
  }
  static func release(_ method: String, context: String? = nil, value: JSONValue) {
    lock.lock()
    let items = held.filter {
      $0.envelope["method"]?.stringValue == method
        && (context == nil || $0.envelope["payload"]?["args"]?["request"]?["projectContext"]?.stringValue == context)
    }
    held.removeAll { item in items.contains { $0 === item } }
    holds.remove(method)
    lock.unlock()
    items.forEach { $0.reply(value) }
  }
  override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "ark-knowledge-isolation.invalid" }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    do {
      var data = request.httpBody ?? Data()
      if data.isEmpty, let stream = request.httpBodyStream {
        stream.open(); defer { stream.close() }
        var buffer = [UInt8](repeating: 0, count: 4096)
        while true {
          let count = stream.read(&buffer, maxLength: buffer.count)
          if count == 0 { break }
          guard count > 0 else { throw URLError(.cannotDecodeRawData) }
          data.append(contentsOf: buffer.prefix(count))
        }
      }
      envelope = try JSONDecoder().decode(JSONValue.self, from: data)
      let method = envelope["method"]?.stringValue ?? ""
      let payload = envelope["payload"]?["args"]?["request"] ?? .object([:])
      Self.lock.lock()
      Self.requests.append((method, payload))
      let roots = Self.projectRoots
      let active = Self.queueActive
      if Self.holds.contains(method) { Self.held.append(self); Self.lock.unlock(); return }
      Self.lock.unlock()
      let context = payload["projectContext"]?.stringValue ?? ""
      switch method {
      case "knowledgeWiki/listProjects":
        reply(.object(["current": .string(roots[0]), "currentProjectContext": .string("context-A"),
          "projects": .array(roots.enumerated().map { index, root in
            .object(["path": .string(root), "name": .string(index == 0 ? "A" : "B"),
              "main": .bool(index == 0), "projectContext": .string(index == 0 ? "context-A" : "context-B")])
          })]))
      case "knowledgeWiki/setProject": reply(.object(["current": payload["path"] ?? .null]))
      case "knowledgeWiki/list":
        reply(.array([.object(["path": .string("concepts/shared.md"), "name": .string("shared.md"), "size": .number(12)])]))
      case "knowledgeWiki/graph": reply(.object(["nodes": .array([]), "edges": .array([])]))
      case "knowledgeWiki/projectStatus":
        reply(.object(["searchMode": .string("keyword"), "textConfigured": .bool(false), "visionConfigured": .bool(false), "embeddingConfigured": .bool(false)]))
      case "knowledgeWiki/reviews": reply(.array([]))
      case "knowledgeWiki/pageContent": reply(.object(["content": .string(context == "context-A" ? "A BODY" : "B BODY")]))
      case "knowledgeWiki/ingestQueueStatus": reply(Self.queue(active: active))
      case "knowledgeWiki/deepResearch":
        reply(.object(["findings": .array([]), "sourceCount": .number(0), "warnings": .array([.string("没有可用搜索来源")]),
          "degraded": .bool(true), "errorCode": .string("no-sources")]))
      case "knowledgeWiki/search": reply(.array([]))
      default: fail()
      }
    } catch { fail() }
  }
  override func stopLoading() {
    Self.lock.lock(); defer { Self.lock.unlock() }
    if !finished { finished = true; Self.cancellations += 1 }
    Self.held.removeAll { $0 === self }
  }
  static func queue(active: Bool) -> JSONValue {
    .object(["tasks": active ? .array([.object(["id": .number(1), "input": .string("raw/sources/a.txt"),
      "status": .string("running"), "written": .array([])])]) : .array([]),
      "running": .bool(active), "cancelled": .bool(false)])
  }
  private func reply(_ value: JSONValue) {
    finish(.object(["ok": .bool(true), "value": .object(["ok": .bool(true), "value": value])]))
  }
  private func fail() { finish(.object(["ok": .bool(false), "error": .object(["message": .string("synthetic unavailable")])])) }
  private func finish(_ result: JSONValue) {
    Self.lock.lock(); let deliver = !finished; finished = true; Self.lock.unlock()
    guard deliver, let url = request.url, let rpcID = envelope["rpcId"],
      let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil),
      let data = try? JSONEncoder().encode(JSONValue.object(["type": .string("server-response"), "rpcId": rpcID, "result": result])) else { return }
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: data)
    client?.urlProtocolDidFinishLoading(self)
  }
}

@MainActor
func runArkKnowledgeIsolationContractChecks() async {
  let root = FileManager.default.temporaryDirectory.appendingPathComponent("ark-knowledge-isolation-\(UUID().uuidString)")
  let a = root.appendingPathComponent("A"), b = root.appendingPathComponent("B")
  let suite = "ark-knowledge-isolation-\(UUID().uuidString)"
  guard let defaults = UserDefaults(suiteName: suite) else { check(false, "knowledge private defaults exist"); return }
  let config = URLSessionConfiguration.ephemeral
  config.protocolClasses = [KnowledgeIsolationURLProtocol.self]
  let transport = URLSession(configuration: config)
  defer {
    transport.invalidateAndCancel(); defaults.removePersistentDomain(forName: suite)
    try? FileManager.default.removeItem(at: root)
    KnowledgeIsolationURLProtocol.configure([])
  }
  do {
    for project in [a, b] {
      try FileManager.default.createDirectory(at: project.appendingPathComponent("wiki/concepts"), withIntermediateDirectories: true)
      try Data("UNCHANGED \(project.lastPathComponent)".utf8).write(to: project.appendingPathComponent("wiki/concepts/shared.md"))
    }
    let input = root.appendingPathComponent("source.txt")
    try Data("synthetic source A".utf8).write(to: input)
    KnowledgeIsolationURLProtocol.configure([a.path, b.path])
    let endpoint = URL(string: "http://ark-knowledge-isolation.invalid")!
    let client = ArkAPIClient(baseURL: endpoint, apiToken: "synthetic", session: transport)
    let model = ArkAppModel(client: client,
      interactions: ArkInteractionAPI(baseURL: endpoint, apiToken: "synthetic", session: transport),
      eventPump: ArkEventPump(baseURL: endpoint, apiToken: "synthetic"), fallbackWikiRoot: a.appendingPathComponent("wiki"),
      documentStore: ArkDocumentReferenceStore(rootURL: root.appendingPathComponent("documents")), defaults: defaults)
    await model.loadWiki()
    check(model.selectedKnowledgeProjectPath == a.path && model.selectedWikiPage?.body == "A BODY"
      && model.knowledgeSearchMode == "keyword", "knowledge initial project installs opaque identity and keyword status")
    let scopedMethods = ["knowledgeWiki/list", "knowledgeWiki/graph", "knowledgeWiki/reviews", "knowledgeWiki/projectStatus", "knowledgeWiki/pageContent", "knowledgeWiki/ingestQueueStatus"]
    check(scopedMethods.allSatisfy { method in KnowledgeIsolationURLProtocol.captured(method).allSatisfy { $0["projectContext"] == .string("context-A") } },
      "knowledge read entrypoints carry the captured project identity")

    KnowledgeIsolationURLProtocol.hold("knowledgeWiki/pageContent")
    model.selectWikiPage("concepts/shared")
    _ = await knowledgeIsolationEventually { KnowledgeIsolationURLProtocol.pending == 1 }
    // B must complete while A's old content is outstanding.
    model.selectKnowledgeProject(path: b.path)
    _ = await knowledgeIsolationEventually { KnowledgeIsolationURLProtocol.pending == 2 }
    KnowledgeIsolationURLProtocol.release("knowledgeWiki/pageContent", context: "context-B", value: .object(["content": .string("B delayed body")]))
    _ = await knowledgeIsolationEventually { model.selectedWikiPage?.body == "B delayed body" }
    KnowledgeIsolationURLProtocol.release("knowledgeWiki/pageContent", context: "context-A", value: .object(["content": .string("A OLD LATE BODY")]))
    for _ in 0..<10 { await Task.yield() }
    check(model.selectedKnowledgeProjectPath == b.path && model.selectedWikiPage?.body == "B delayed body",
      "same-ID page content from an old project never overwrites the newly selected project")

    model.selectKnowledgeProject(path: a.path)
    _ = await knowledgeIsolationEventually { model.selectedWikiPage?.body == "A BODY" }
    KnowledgeIsolationURLProtocol.hold("knowledgeWiki/ingestQueueAdd")
    model.importKnowledgeSources([input])
    _ = await knowledgeIsolationEventually { KnowledgeIsolationURLProtocol.pending == 1 }
    model.selectKnowledgeProject(path: b.path)
    _ = await knowledgeIsolationEventually { model.selectedWikiPage?.body == "B BODY" }
    KnowledgeIsolationURLProtocol.release("knowledgeWiki/ingestQueueAdd", value: KnowledgeIsolationURLProtocol.queue(active: false))
    for _ in 0..<10 { await Task.yield() }
    let bBytes = try String(contentsOf: b.appendingPathComponent("wiki/concepts/shared.md"), encoding: .utf8)
    check(KnowledgeIsolationURLProtocol.captured("knowledgeWiki/ingestQueueAdd").last?["projectContext"] == .string("context-A")
      && FileManager.default.fileExists(atPath: a.appendingPathComponent("raw/sources/source.txt").path)
      && !FileManager.default.fileExists(atPath: b.appendingPathComponent("raw/sources/source.txt").path)
      && bBytes == "UNCHANGED B",
      "copy then project switch enqueues into A only and leaves B bytes untouched")

    KnowledgeIsolationURLProtocol.hold("knowledgeWiki/writePage")
    model.selectKnowledgeProject(path: a.path)
    _ = await knowledgeIsolationEventually { model.selectedWikiPage?.body == "A BODY" }
    model.saveKnowledgePage(id: "concepts/shared", content: "A edit", expectedContent: "A BODY")
    _ = await knowledgeIsolationEventually { KnowledgeIsolationURLProtocol.pending == 1 }
    model.selectKnowledgeProject(path: b.path)
    _ = await knowledgeIsolationEventually { model.selectedWikiPage?.body == "B BODY" }
    KnowledgeIsolationURLProtocol.release("knowledgeWiki/writePage", value: .object(["path": .string("concepts/shared.md"), "ok": .bool(false), "conflict": .bool(true)]))
    for _ in 0..<10 { await Task.yield() }
    check(KnowledgeIsolationURLProtocol.captured("knowledgeWiki/writePage").last?["projectContext"] == .string("context-A")
      && model.wikiSaveError == nil && model.wikiSavingPageID == nil && model.selectedWikiPage?.body == "B BODY",
      "late A save conflict cannot mark B's same-ID page failed or busy")

    model.runDeepResearch(topic: "synthetic topic")
    _ = await knowledgeIsolationEventually { model.knowledgeErrorMessage == "没有可用搜索来源" }
    check(model.knowledgeErrorMessage == "没有可用搜索来源", "zero-source research displays its blocking warning instead of a completion toast")
    KnowledgeIsolationURLProtocol.activateQueue()
    model.refreshKnowledgeIngestQueue()
    _ = await knowledgeIsolationEventually { model.wikiIngestQueue.hasActiveTasks }
    KnowledgeIsolationURLProtocol.hold("knowledgeWiki/ingestQueueStatus")
    _ = await knowledgeIsolationEventually { KnowledgeIsolationURLProtocol.pending == 1 }
    await model.shutdown()
    check(KnowledgeIsolationURLProtocol.pending == 0 && KnowledgeIsolationURLProtocol.cancelledCount > 0,
      "shutdown awaits cancellation of an in-flight knowledge polling request")
  } catch { check(false, "knowledge isolation fixture completes: \(error)") }
  await runKnowledgeFallbackBoundsChecks(root: root)
}

@MainActor
private func knowledgeIsolationEventually(_ condition: () -> Bool) async -> Bool {
  for _ in 0..<500 {
    if condition() { return true }
    try? await Task.sleep(nanoseconds: 5_000_000)
  }
  return condition()
}

private func runKnowledgeFallbackBoundsChecks(root: URL) async {
  let wiki = root.appendingPathComponent("bounds"), outside = root.appendingPathComponent("outside.md")
  do {
    try FileManager.default.createDirectory(at: wiki, withIntermediateDirectories: true)
    try Data("private outside".utf8).write(to: outside)
    try FileManager.default.createSymbolicLink(at: wiki.appendingPathComponent("link.md"), withDestinationURL: outside)
    let fifo = wiki.appendingPathComponent("pipe.md")
    check(mkfifo(fifo.path, 0o600) == 0, "knowledge FIFO fixture exists")
    try Data("# 中文资料\n| A | B |".utf8).write(to: wiki.appendingPathComponent("safe.md"))
    let pages = try await Task.detached { try ArkWikiLoader.load(root: wiki).0 }.value
    check(pages.map(\.relativePath) == ["safe.md"], "fallback skips symlinks and special files while reading bounded UTF-8 Markdown")
    try Data(repeating: 65, count: 2 * 1_024 * 1_024 + 1).write(to: wiki.appendingPathComponent("large.md"))
    do { _ = try ArkWikiLoader.load(root: wiki); check(false, "fallback oversized page is rejected") }
    catch { check(true, "fallback oversized page is rejected") }
    let cancelled = Task.detached { try Task.checkCancellation(); return try ArkWikiLoader.load(root: wiki) }
    cancelled.cancel()
    do { _ = try await cancelled.value; check(false, "cancelled fallback never installs pages") }
    catch { check(error is CancellationError, "cancelled fallback reports cancellation before reading") }
  } catch { check(false, "bounded fallback fixture completes: \(error)") }
}
