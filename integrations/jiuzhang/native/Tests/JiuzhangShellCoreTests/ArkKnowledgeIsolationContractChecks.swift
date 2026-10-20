import Foundation
import Darwin
import JiuzhangShellCore
@testable import JiuzhangShellUI

/// The real AppModel and RPC codecs run against a transport with delayed project replies.
private final class KnowledgeIsolationURLProtocol: URLProtocol, @unchecked Sendable {
  private static let lock = NSLock()
  private static var projectRoots: [String] = []
  private static var requests: [(String, JSONValue)] = []
  private static var requestTimeouts: [(String, TimeInterval)] = []
  private static var researchBudget: JSONValue? = .number(600_000)
  private static var held: [KnowledgeIsolationURLProtocol] = []
  private static var holds = Set<String>()
  private static var queueActive = false
  private static var cancellations = 0
  private var envelope: JSONValue = .null
  private var finished = false

  static func configure(_ roots: [String]) {
    lock.lock(); defer { lock.unlock() }
    projectRoots = roots; requests = []; requestTimeouts = []; held = []; holds = []; queueActive = false; cancellations = 0
    researchBudget = .number(600_000)
  }
  static func hold(_ method: String) { lock.lock(); holds.insert(method); lock.unlock() }
  static var pending: Int { lock.lock(); defer { lock.unlock() }; return held.count }
  static var cancelledCount: Int { lock.lock(); defer { lock.unlock() }; return cancellations }
  static func activateQueue() { lock.lock(); queueActive = true; lock.unlock() }
  static func captured(_ method: String) -> [JSONValue] {
    lock.lock(); defer { lock.unlock() }; return requests.filter { $0.0 == method }.map(\.1)
  }
  static func capturedTimeouts(_ method: String) -> [TimeInterval] {
    lock.lock(); defer { lock.unlock() }; return requestTimeouts.filter { $0.0 == method }.map(\.1)
  }
  static func setResearchBudget(_ value: JSONValue?) { lock.lock(); researchBudget = value; lock.unlock() }
  static func release(_ method: String, context: String? = nil, topic: String? = nil, value: JSONValue) {
    lock.lock()
    let items = held.filter {
      $0.envelope["method"]?.stringValue == method
        && (context == nil || $0.envelope["payload"]?["args"]?["request"]?["projectContext"]?.stringValue == context)
        && (topic == nil || $0.envelope["payload"]?["args"]?["request"]?["topic"]?.stringValue == topic)
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
      Self.requestTimeouts.append((method, request.timeoutInterval))
      let roots = Self.projectRoots
      let active = Self.queueActive
      let budget = Self.researchBudget
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
        var status: [String: JSONValue] = ["searchMode": .string("keyword"), "textConfigured": .bool(false), "visionConfigured": .bool(false), "embeddingConfigured": .bool(false)]
        if let budget { status["researchTimeoutMs"] = budget }
        reply(.object(status))
      case "knowledgeWiki/reviews": reply(.array([]))
      case "knowledgeWiki/pageContent": reply(.object(["content": .string(context == "context-A" ? "A BODY" : "B BODY")]))
      case "knowledgeWiki/ingestQueueStatus": reply(Self.queue(active: active))
      case "knowledgeWiki/deepResearch":
        reply(.object(["findings": .array([]), "sources": .array([]), "sourceCount": .number(0), "warnings": .array([.string("没有可用搜索来源")]),
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
    let feed = NativeWikiFeed(model: model)
    await model.loadWiki()
    check(model.selectedKnowledgeProjectPath == a.path && model.selectedWikiPage?.body == "A BODY"
      && model.knowledgeSearchMode == "keyword", "knowledge initial project installs opaque identity and keyword status")
    let scopedMethods = ["knowledgeWiki/list", "knowledgeWiki/graph", "knowledgeWiki/reviews", "knowledgeWiki/projectStatus", "knowledgeWiki/pageContent", "knowledgeWiki/ingestQueueStatus"]
    check(scopedMethods.allSatisfy { method in KnowledgeIsolationURLProtocol.captured(method).allSatisfy { $0["projectContext"] == .string("context-A") } },
      "knowledge read entrypoints carry the captured project identity")
    check(model.wikiResearchReady && !model.wikiResearchBusy,
      "a valid Host research budget makes the native research owner ready")
    KnowledgeIsolationURLProtocol.setResearchBudget(nil)
    await model.loadWiki()
    let unavailableCount = KnowledgeIsolationURLProtocol.captured("knowledgeWiki/deepResearch").count
    model.runDeepResearch(topic: "missing deadline")
    check(!model.wikiResearchReady && !model.wikiResearchBusy
      && KnowledgeIsolationURLProtocol.captured("knowledgeWiki/deepResearch").count == unavailableCount
      && model.knowledgeErrorMessage?.contains("时限配置缺失或无效") == true,
      "a missing Host deadline blocks research without a network fallback")
    KnowledgeIsolationURLProtocol.setResearchBudget(.number(600_000))
    await model.loadWiki()

    KnowledgeIsolationURLProtocol.hold("knowledgeWiki/search")
    let searchCancellationBaseline = KnowledgeIsolationURLProtocol.cancelledCount
    for index in 0..<8 {
      let query = "synthetic latest \(index)"
      model.searchKnowledge(query)
      let latestOnly = await knowledgeIsolationEventually {
        KnowledgeIsolationURLProtocol.pending == 1
          && KnowledgeIsolationURLProtocol.captured("knowledgeWiki/search").last?["query"] == .string(query)
      }
      check(latestOnly, "repeated knowledge searches keep only the latest transport request active")
    }
    check(KnowledgeIsolationURLProtocol.cancelledCount >= searchCancellationBaseline + 7,
      "superseded knowledge searches cancel transport work rather than only ignoring results")
    model.clearKnowledgeSearch()
    let searchCleared = await knowledgeIsolationEventually { KnowledgeIsolationURLProtocol.pending == 0 }
    check(searchCleared, "clearing a knowledge search cancels its outstanding request")
    model.searchKnowledge("synthetic project switch")
    _ = await knowledgeIsolationEventually { KnowledgeIsolationURLProtocol.pending == 1 }
    model.selectKnowledgeProject(path: b.path)
    let projectSearchCancelled = await knowledgeIsolationEventually {
      KnowledgeIsolationURLProtocol.pending == 0 && model.selectedWikiPage?.body == "B BODY"
    }
    check(projectSearchCancelled, "switching knowledge projects cancels the old project's search")
    KnowledgeIsolationURLProtocol.release("knowledgeWiki/search", value: .array([]))
    model.selectKnowledgeProject(path: a.path)
    _ = await knowledgeIsolationEventually { model.selectedWikiPage?.body == "A BODY" }

    KnowledgeIsolationURLProtocol.hold("knowledgeWiki/pageContent")
    model.selectWikiPage("concepts/shared")
    _ = await knowledgeIsolationEventually { KnowledgeIsolationURLProtocol.pending == 1 }
    let pageCancellationBaseline = KnowledgeIsolationURLProtocol.cancelledCount
    model.selectWikiPage("concepts/shared")
    let pageReadCancelled = await knowledgeIsolationEventually {
      KnowledgeIsolationURLProtocol.pending == 1
        && KnowledgeIsolationURLProtocol.cancelledCount > pageCancellationBaseline
    }
    check(pageReadCancelled, "selecting another knowledge page cancels the previous page read")
    model.selectKnowledgeProject(path: b.path)
    let projectPageCancelled = await knowledgeIsolationEventually {
      KnowledgeIsolationURLProtocol.pending == 1
        && KnowledgeIsolationURLProtocol.captured("knowledgeWiki/pageContent").last?["projectContext"] == .string("context-B")
    }
    check(projectPageCancelled, "switching projects leaves only the new project's page request active")
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

    model.selectKnowledgeProject(path: a.path)
    _ = await knowledgeIsolationEventually { model.selectedWikiPage?.body == "A BODY" }
    let selectedBeforeChooser = model.prepareKnowledgeSourceImport()
    model.selectKnowledgeProject(path: b.path)
    _ = await knowledgeIsolationEventually { model.selectedWikiPage?.body == "B BODY" }
    let chooserInput = root.appendingPathComponent("chooser-source.txt")
    try Data("CHOOSER A".utf8).write(to: chooserInput)
    KnowledgeIsolationURLProtocol.hold("knowledgeWiki/ingestQueueAdd")
    selectedBeforeChooser?([chooserInput])
    _ = await knowledgeIsolationEventually { KnowledgeIsolationURLProtocol.pending == 1 }
    check(KnowledgeIsolationURLProtocol.captured("knowledgeWiki/ingestQueueAdd").last?["projectContext"] == .string("context-A")
      && FileManager.default.fileExists(atPath: a.appendingPathComponent("raw/sources/chooser-source.txt").path)
      && !FileManager.default.fileExists(atPath: b.appendingPathComponent("raw/sources/chooser-source.txt").path),
      "a project switch while choosing files cannot redirect the captured import intent")
    KnowledgeIsolationURLProtocol.release("knowledgeWiki/ingestQueueAdd", value: KnowledgeIsolationURLProtocol.queue(active: false))

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

    KnowledgeIsolationURLProtocol.hold("knowledgeWiki/deepResearch")
    let researchBaseline = KnowledgeIsolationURLProtocol.captured("knowledgeWiki/deepResearch").count
    for _ in 0..<8 { model.runDeepResearch(topic: "synthetic repeated topic") }
    let oneResearch = await knowledgeIsolationEventually { KnowledgeIsolationURLProtocol.pending == 1 }
    check(oneResearch && model.wikiResearchBusy
      && KnowledgeIsolationURLProtocol.captured("knowledgeWiki/deepResearch").count == researchBaseline + 1,
      "Return and button repetition share one native research operation and transport")
    check(KnowledgeIsolationURLProtocol.capturedTimeouts("knowledgeWiki/deepResearch").last == 630
      && KnowledgeIsolationURLProtocol.capturedTimeouts("knowledgeWiki/list").allSatisfy { $0 == 60 },
      "research freezes the Host budget plus grace while ordinary RPC keeps its sixty-second timeout")
    let cancellingResearch = Task { await model.cancelDeepResearch() }
    _ = await knowledgeIsolationEventually { !model.wikiResearchBusy }
    model.runDeepResearch(topic: "synthetic retry topic")
    _ = await knowledgeIsolationEventually {
      KnowledgeIsolationURLProtocol.captured("knowledgeWiki/deepResearch").count == researchBaseline + 2
    }
    await cancellingResearch.value
    check(model.wikiResearchBusy && KnowledgeIsolationURLProtocol.pending == 1,
      "an older cancellation and defer cannot clear the retry's research owner")
    KnowledgeIsolationURLProtocol.release("knowledgeWiki/deepResearch", topic: "synthetic repeated topic", value: .object([
      "findings": .array([]), "sources": .array([]), "sourceCount": .number(0), "warnings": .array([.string("OLD timeout")]),
      "degraded": .bool(true), "errorCode": .string("research-timeout"),
    ]))
    check(model.knowledgeErrorMessage != "OLD timeout", "a cancelled old research response cannot replace retry state")
    KnowledgeIsolationURLProtocol.release("knowledgeWiki/deepResearch", topic: "synthetic retry topic", value: .object([
      "findings": .array([]), "sources": .array([]), "sourceCount": .number(0), "warnings": .array([.string("NEW search configuration failure")]),
      "degraded": .bool(true), "errorCode": .string("web-search-unavailable"),
    ]))
    let retryFinished = await knowledgeIsolationEventually {
      !model.wikiResearchBusy && model.knowledgeErrorMessage == "NEW search configuration failure"
    }
    check(retryFinished, "only the current research publishes its actual failure and releases busy state")

    KnowledgeIsolationURLProtocol.hold("knowledgeWiki/deepResearch")
    model.runDeepResearch(topic: "synthetic project cancellation")
    _ = await knowledgeIsolationEventually { KnowledgeIsolationURLProtocol.pending == 1 }
    model.selectKnowledgeProject(path: a.path)
    let researchProjectCancelled = await knowledgeIsolationEventually {
      KnowledgeIsolationURLProtocol.pending == 0 && !model.wikiResearchBusy && model.selectedWikiPage?.body == "A BODY"
    }
    check(researchProjectCancelled, "project switching cancels and awaits research before installing the new project")
    KnowledgeIsolationURLProtocol.release("knowledgeWiki/deepResearch", value: .null)

    let shortClient = ArkAPIClient(baseURL: endpoint, apiToken: "synthetic", session: transport, researchTimeoutOverride: 0.05)
    KnowledgeIsolationURLProtocol.hold("knowledgeWiki/deepResearch")
    let deadlineStarted = Date()
    do {
      _ = try await shortClient.runDeepResearch(projectContext: "context-A", topic: "synthetic deadline", timeout: 630)
      check(false, "a research absolute deadline rejects an unanswered transport")
    } catch let error as URLError {
      check(error.code == .timedOut && Date().timeIntervalSince(deadlineStarted) < 2,
        "a short injected research deadline throws timeout without waiting the production budget")
    }
    let deadlineStopped = await knowledgeIsolationEventually { KnowledgeIsolationURLProtocol.pending == 0 }
    check(deadlineStopped && KnowledgeIsolationURLProtocol.capturedTimeouts("knowledgeWiki/deepResearch").last == 0.05,
      "absolute deadline cancellation closes its underlying URLSession transport")
    KnowledgeIsolationURLProtocol.release("knowledgeWiki/deepResearch", value: .null)
    _ = try await shortClient.searchKnowledge(projectContext: "context-A", query: "ordinary after timeout")
    check(KnowledgeIsolationURLProtocol.capturedTimeouts("knowledgeWiki/search").last == 60,
      "a research-only constructor override leaves ordinary RPC deadlines unchanged")
    let invalidBaseline = KnowledgeIsolationURLProtocol.captured("knowledgeWiki/deepResearch").count
    for invalid in [0, -1, TimeInterval.nan, TimeInterval.infinity, TimeInterval.greatestFiniteMagnitude] {
      let invalidClient = ArkAPIClient(baseURL: endpoint, apiToken: "synthetic", session: transport, researchTimeoutOverride: invalid)
      do {
        _ = try await invalidClient.runDeepResearch(projectContext: "context-A", topic: "invalid deadline", timeout: 630)
        check(false, "invalid research deadlines fail before transport")
      } catch is ArkAPIError {}
    }
    check(KnowledgeIsolationURLProtocol.captured("knowledgeWiki/deepResearch").count == invalidBaseline,
      "nonpositive and nonfinite constructor deadlines never create a request")

    let researchSuccess = JSONValue.object([
      "findings": .array([.object(["title": .string("Synthetic evidence"),
        "path": .string("_candidates/research/evidence.md"),
        "sourceURLs": .array([.string("https://source.example/synthetic-evidence")])])]),
      "sources": .array([.object(["url": .string("https://source.example/synthetic-evidence"),
        "evidence": .string("search-snippet")])]),
      "sourceCount": .number(1), "warnings": .array([.string("One synthetic search failed")]),
      "degraded": .bool(true),
    ])
    KnowledgeIsolationURLProtocol.hold("knowledgeWiki/deepResearch")
    model.runDeepResearch(topic: "synthetic visible provenance")
    _ = await knowledgeIsolationEventually { KnowledgeIsolationURLProtocol.pending == 1 }
    KnowledgeIsolationURLProtocol.release("knowledgeWiki/deepResearch", value: researchSuccess)
    let provenancePublished = await knowledgeIsolationEventually {
      !model.wikiResearchBusy && feed.researchResult?.findings.count == 1
    }
    check(provenancePublished && model.knowledgeResearchResult == feed.researchResult
      && feed.researchResult?.sources.first?.url == "https://source.example/synthetic-evidence"
      && feed.researchResult?.warnings == ["One synthetic search failed"]
      && model.knowledgeErrorMessage == nil,
      "the actual research response reaches the current-project feed with sources and partial warnings")
    await model.loadWiki()
    check(feed.researchResult?.findings.count == 1,
      "ordinary knowledge refresh retains the completed research provenance")

    KnowledgeIsolationURLProtocol.hold("knowledgeWiki/deepResearch")
    model.runDeepResearch(topic: "synthetic cancelled replacement")
    check(model.knowledgeResearchResult == nil && feed.researchResult == nil,
      "starting a replacement research removes the previous completion before awaiting transport")
    _ = await knowledgeIsolationEventually { KnowledgeIsolationURLProtocol.pending == 1 }
    await model.cancelDeepResearch()
    KnowledgeIsolationURLProtocol.release("knowledgeWiki/deepResearch", value: researchSuccess)
    check(model.knowledgeResearchResult == nil && feed.researchResult == nil && !model.wikiResearchBusy,
      "cancelling research cannot restore the old result or publish its late response")

    KnowledgeIsolationURLProtocol.hold("knowledgeWiki/deepResearch")
    model.runDeepResearch(topic: "synthetic project result")
    _ = await knowledgeIsolationEventually { KnowledgeIsolationURLProtocol.pending == 1 }
    KnowledgeIsolationURLProtocol.release("knowledgeWiki/deepResearch", value: researchSuccess)
    _ = await knowledgeIsolationEventually { !model.wikiResearchBusy && feed.researchResult != nil }
    model.selectKnowledgeProject(path: b.path)
    check(model.knowledgeResearchResult == nil && feed.researchResult == nil,
      "switching projects removes the prior project's research sources synchronously")
    _ = await knowledgeIsolationEventually { model.selectedWikiPage?.body == "B BODY" }

    KnowledgeIsolationURLProtocol.hold("knowledgeWiki/deepResearch")
    model.runDeepResearch(topic: "synthetic no pages")
    _ = await knowledgeIsolationEventually { KnowledgeIsolationURLProtocol.pending == 1 }
    KnowledgeIsolationURLProtocol.release("knowledgeWiki/deepResearch", value: .object([
      "findings": .array([]), "sources": researchSuccess["sources"] ?? .array([]), "sourceCount": .number(1),
      "warnings": .array([.string("No candidate page was written")]), "degraded": .bool(true),
      "errorCode": .string("no-pages"),
    ]))
    _ = await knowledgeIsolationEventually { !model.wikiResearchBusy }
    check(model.knowledgeResearchResult == nil && feed.researchResult == nil
      && model.knowledgeErrorMessage == "No candidate page was written",
      "real sources without a written page display the failure without a success panel")

    model.runDeepResearch(topic: "synthetic topic")
    _ = await knowledgeIsolationEventually { model.knowledgeErrorMessage == "没有可用搜索来源" }
    check(model.knowledgeErrorMessage == "没有可用搜索来源" && model.knowledgeResearchResult == nil && feed.researchResult == nil,
      "zero-source research displays its blocking warning without a completion or source panel")
    KnowledgeIsolationURLProtocol.activateQueue()
    model.refreshKnowledgeIngestQueue()
    _ = await knowledgeIsolationEventually { model.wikiIngestQueue.hasActiveTasks }
    KnowledgeIsolationURLProtocol.hold("knowledgeWiki/ingestQueueStatus")
    _ = await knowledgeIsolationEventually { KnowledgeIsolationURLProtocol.pending == 1 }
    KnowledgeIsolationURLProtocol.hold("knowledgeWiki/deepResearch")
    model.runDeepResearch(topic: "synthetic shutdown")
    _ = await knowledgeIsolationEventually { KnowledgeIsolationURLProtocol.pending == 2 }
    let lateSelection = model.prepareKnowledgeSourceImport()
    let lateInput = root.appendingPathComponent("after-shutdown.txt")
    try Data("LATE CHOOSER".utf8).write(to: lateInput)
    let importsBeforeShutdown = KnowledgeIsolationURLProtocol.captured("knowledgeWiki/ingestQueueAdd").count
    await model.shutdown()
    lateSelection?([lateInput])
    check(KnowledgeIsolationURLProtocol.pending == 0 && KnowledgeIsolationURLProtocol.cancelledCount > 0 && !model.wikiResearchBusy,
      "shutdown awaits polling and research cancellation and invalidates research publication")
    check(KnowledgeIsolationURLProtocol.captured("knowledgeWiki/ingestQueueAdd").count == importsBeforeShutdown
      && !FileManager.default.fileExists(atPath: a.appendingPathComponent("raw/sources/after-shutdown.txt").path)
      && !FileManager.default.fileExists(atPath: b.appendingPathComponent("raw/sources/after-shutdown.txt").path),
      "a chooser response after model shutdown cannot copy or enqueue input")
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
