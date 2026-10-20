import Foundation
import JiuzhangShellCore
@testable import JiuzhangShellUI

/// Delays the real AppModel's settings CAS while concurrent knowledge requests read the published route.
private final class KnowledgeConnectionSaveURLProtocol: URLProtocol, @unchecked Sendable {
  private static let lock = NSLock()
  private static var values: [String: String] = [:]
  private static var revision = 1
  private static var credentials: [String: String] = [:]
  private static var writes: [(String, String)] = []
  private static var calls: [(String, JSONValue)] = []
  private static var held: KnowledgeConnectionSaveURLProtocol?
  private static var deliveries: [(String, String)] = []
  private var envelope: JSONValue = .null
  private var finished = false

  static func reset(_ initial: [String: String]) {
    lock.lock(); defer { lock.unlock() }
    values = initial; revision = 1; credentials = ["SYNTHETIC_OLD_REFERENCE": "synthetic-provider-A-key"]
    writes = []; calls = []; held = nil; deliveries = []
  }
  static var pending: Bool { lock.lock(); defer { lock.unlock() }; return held != nil }
  static var credentialWrites: [(String, String)] { lock.lock(); defer { lock.unlock() }; return writes }
  static var published: [String: String] { lock.lock(); defer { lock.unlock() }; return values }
  static var storedCredentials: [String: String] { lock.lock(); defer { lock.unlock() }; return credentials }
  static var received: [(String, String)] { lock.lock(); defer { lock.unlock() }; return deliveries }
  static var publicRequests: [JSONValue] {
    lock.lock(); defer { lock.unlock() }
    return calls.filter { $0.0 != "credentials/set" }.map(\.1)
  }
  static func release(commit: Bool, loseResponse: Bool = false) {
    lock.lock()
    guard let item = held else { lock.unlock(); return }
    held = nil
    let args = item.envelope["payload"]?["args"] ?? .null
    let accepted = commit && args["expectedRevision"]?.numberValue == Double(revision)
    if accepted {
      for op in args["ops"]?.arrayValue ?? [] {
        if let key = op["path"]?.arrayValue?.first?.stringValue, let value = op["value"]?.stringValue {
          values[key] = value
        }
      }
      revision += 1
    }
    let row = namespace()
    lock.unlock()
    if loseResponse { item.loseResponse() }
    else if accepted { item.reply(row) }
    else { item.fail("synthetic-provider-B-key: synthetic CAS rejection") }
  }
  private static func namespace() -> JSONValue {
    .object(["ns": .string("knowledge-wiki"), "revision": .number(Double(revision)),
      "value": .object(values.mapValues(JSONValue.string))])
  }
  override class func canInit(with request: URLRequest) -> Bool {
    request.url?.host == "ark-knowledge-connection-save.invalid"
  }
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
      let args = envelope["payload"]?["args"] ?? .null
      Self.lock.lock()
      Self.calls.append((method, args))
      switch method {
      case "credentials/set":
        if let ref = args["refName"]?.stringValue, let value = args["value"]?.stringValue {
          Self.credentials[ref] = value; Self.writes.append((ref, value))
        }
        Self.lock.unlock(); reply(.object([:])); return
      case "settings/mutate":
        Self.held = self; Self.lock.unlock(); return
      case "settings/describe":
        let row = Self.namespace()
        Self.lock.unlock()
        reply(.object(["writable": .bool(true), "hasDocument": .bool(true), "namespaces": .array([row])]))
      case "knowledgeWiki/search":
        let endpoint = Self.values["embeddingBaseUrl"] ?? ""
        let ref = Self.values["embeddingCredential"] ?? ""
        Self.deliveries.append((endpoint, Self.credentials[ref] ?? ""))
        Self.lock.unlock()
        reply(.object(["ok": .bool(true), "value": .array([])]))
      default:
        Self.lock.unlock()
        switch method {
        case "llm/providers": reply(.object(["providers": .array([])]))
        case "llm/models": reply(.object(["groups": .array([])]))
        case "credentials/describe": reply(.object(["credentials": .object([:])]))
        default: fail("synthetic unavailable")
        }
      }
    } catch { fail("synthetic malformed request") }
  }
  override func stopLoading() { Self.lock.lock(); finished = true; Self.lock.unlock() }
  private func reply(_ value: JSONValue) {
    finish(.object(["ok": .bool(true), "value": .object(["ok": .bool(true), "value": value])]))
  }
  private func fail(_ message: String) {
    finish(.object(["ok": .bool(false), "error": .object(["message": .string(message)])]))
  }
  private func loseResponse() {
    Self.lock.lock(); let deliver = !finished; finished = true; Self.lock.unlock()
    if deliver { client?.urlProtocol(self, didFailWithError: URLError(.networkConnectionLost)) }
  }
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
func runArkKnowledgeConnectionSaveContractChecks() async {
  let initial = ["textProvider": "", "textModel": "", "visionProvider": "", "visionModel": "",
    "embeddingProvider": "provider-A", "embeddingBaseUrl": "https://provider-A.invalid/v1",
    "embeddingModel": "embedding-A", "embeddingCredential": "SYNTHETIC_OLD_REFERENCE"]
  var next = initial
  next["embeddingProvider"] = "provider-B"; next["embeddingBaseUrl"] = "https://provider-B.invalid/v1"
  next["embeddingModel"] = "embedding-B"
  var freshReferences = Set<String>()
  for (commit, loseResponse) in [(false, false), (true, false), (false, true), (true, true)] {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("ark-knowledge-save-\(UUID().uuidString)")
    let suite = "ark-knowledge-save-\(UUID().uuidString)"
    guard let defaults = UserDefaults(suiteName: suite) else { check(false, "knowledge save private defaults exist"); return }
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [KnowledgeConnectionSaveURLProtocol.self]
    let session = URLSession(configuration: config)
    let endpoint = URL(string: "http://ark-knowledge-connection-save.invalid")!
    let client = ArkAPIClient(baseURL: endpoint, apiToken: "synthetic", session: session)
    let model = ArkAppModel(client: client,
      interactions: ArkInteractionAPI(baseURL: endpoint, apiToken: "synthetic", session: session),
      eventPump: ArkEventPump(baseURL: endpoint, apiToken: "synthetic"), fallbackWikiRoot: root,
      documentStore: ArkDocumentReferenceStore(rootURL: root.appendingPathComponent("documents")), defaults: defaults)
    KnowledgeConnectionSaveURLProtocol.reset(initial)
    await model.loadSettings()
    var incomplete = next; incomplete["embeddingModel"] = ""
    let invalid = await model.saveKnowledgeConnections(incomplete, expectedRevision: 1, embeddingSecret: "synthetic-provider-B-key")
    check(!invalid && KnowledgeConnectionSaveURLProtocol.credentialWrites.isEmpty,
      "incomplete embedding route is rejected before any credential write")
    let savedFields = next
    let save = Task { await model.saveKnowledgeConnections(savedFields, expectedRevision: 1, embeddingSecret: "synthetic-provider-B-key") }
    let deadline = Date(timeIntervalSinceNow: 3)
    while !KnowledgeConnectionSaveURLProtocol.pending && Date() < deadline {
      try? await Task.sleep(nanoseconds: 5_000_000)
    }
    check(KnowledgeConnectionSaveURLProtocol.pending && model.settingsBusy,
      "real AppModel holds one save owner while route CAS is delayed")
    let writes = KnowledgeConnectionSaveURLProtocol.credentialWrites
    let newRef = writes.first?.0 ?? ""
    check(writes.count == 1 && newRef.hasPrefix("ARK_KNOWLEDGE_EMBEDDING_") && freshReferences.insert(newRef).inserted,
      "every new embedding secret gets a fresh independent credential reference")
    let duplicate = await model.saveKnowledgeConnections(savedFields, expectedRevision: 1, embeddingSecret: "synthetic-other-key")
    check(!duplicate && KnowledgeConnectionSaveURLProtocol.credentialWrites.count == 1,
      "a concurrent save cannot overwrite the pending connection credential")
    _ = try? await client.searchKnowledge(projectContext: "synthetic-context", query: "during CAS")
    check(KnowledgeConnectionSaveURLProtocol.published == initial
      && KnowledgeConnectionSaveURLProtocol.received.last?.1 == "synthetic-provider-A-key"
      && KnowledgeConnectionSaveURLProtocol.storedCredentials["SYNTHETIC_OLD_REFERENCE"] == "synthetic-provider-A-key",
      "concurrent knowledge request keeps endpoint A and key A until complete route publication")
    KnowledgeConnectionSaveURLProtocol.release(commit: commit, loseResponse: loseResponse)
    let result = await save.value
    check(result == (commit && !loseResponse) && !model.settingsBusy,
      "save reports CAS receipt independently of commit and always releases its busy owner")
    _ = try? await client.searchKnowledge(projectContext: "synthetic-context", query: "after CAS")
    let published = KnowledgeConnectionSaveURLProtocol.published
    check(published["embeddingCredential"] == (commit ? newRef : "SYNTHETIC_OLD_REFERENCE")
      && KnowledgeConnectionSaveURLProtocol.storedCredentials["SYNTHETIC_OLD_REFERENCE"] == "synthetic-provider-A-key"
      && KnowledgeConnectionSaveURLProtocol.storedCredentials[newRef] == "synthetic-provider-B-key",
      "CAS success switches to the fresh reference; rejection or response loss never overwrites or deletes either credential")
    check(KnowledgeConnectionSaveURLProtocol.received.count == 2 && KnowledgeConnectionSaveURLProtocol.received.allSatisfy { endpoint, key in
      endpoint == initial["embeddingBaseUrl"] ? key == "synthetic-provider-A-key" : key == "synthetic-provider-B-key"
    }, "wrong-service credential deliveries remain zero before and after route CAS")
    check(model.settingsSnapshot?.namespaces.first(where: { $0.id == "knowledge-wiki" })?.value["embeddingCredential"]?.stringValue
      == published["embeddingCredential"], "unknown commit outcome reloads the authoritative public route without deleting its key")
    let publicBytes = KnowledgeConnectionSaveURLProtocol.publicRequests.compactMap { try? JSONEncoder().encode($0) }
    check(publicBytes.allSatisfy { !String(decoding: $0, as: UTF8.self).contains("synthetic-provider-B-key") }
      && model.settingsErrorMessage?.contains("synthetic-provider-B-key") != true,
      "raw credential never enters route settings or error presentation, including hostile CAS errors")
    await model.shutdown()
    session.invalidateAndCancel(); defaults.removePersistentDomain(forName: suite)
    try? FileManager.default.removeItem(at: root)
  }
  KnowledgeConnectionSaveURLProtocol.reset([:])
}
