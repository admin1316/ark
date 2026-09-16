import Foundation
import JiuzhangShellCore
@testable import JiuzhangShellUI

/// Real AppModel tasks and wire codecs with explicitly released transport replies.
private final class ComposerIsolationURLProtocol: URLProtocol, @unchecked Sendable {
  private static let lock = NSLock()
  private static var held: [ComposerIsolationURLProtocol] = []
  private static var calls: [(String, String)] = []
  private var body: JSONValue = .null
  private var stopped = false
  static func reset() { lock.lock(); held = []; calls = []; lock.unlock() }
  static var pendingCount: Int { lock.lock(); defer { lock.unlock() }; return held.count }
  static func callCount(_ method: String, sessionID: String) -> Int {
    lock.lock(); defer { lock.unlock() }
    return calls.filter { $0.0 == method && $0.1 == sessionID }.count
  }
  static var latestCreation: JSONValue? {
    lock.lock(); defer { lock.unlock() }
    return held.last(where: { $0.body["method"]?.stringValue == "session/create" })?.body["payload"]?["args"]?["request"]
  }
  static func releaseCreation(success: Bool) {
    lock.lock()
    let pending = held.filter { $0.body["method"]?.stringValue == "session/create" }
    held.removeAll { $0.body["method"]?.stringValue == "session/create" }
    lock.unlock()
    for item in pending {
      if success {
        item.reply(.object(["sessionId": item.body["payload"]?["args"]?["request"]?["sessionId"] ?? .null]), domain: true)
      } else { item.fail("synthetic creation failure") }
    }
  }
  static func releasePrompt(success: Bool, imageRejection: Bool = false) {
    lock.lock(); let pending = held; held = []; lock.unlock()
    for item in pending {
      if success {
        let invocation = item.body["payload"]?["args"]?["invocationId"] ?? .string("ordinary")
        item.reply(.object(["accepted": .bool(true), "invocationId": invocation,
          "messageId": .string("fixture-message"), "durable": .bool(true), "duplicate": .bool(false)]),
          domain: item.body["method"]?.stringValue == "session/prompt")
      } else {
        item.fail(imageRejection ? "fixture image rejection" : "fixture delayed rejection",
          imageRejection: imageRejection)
      }
    }
  }
  override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "ark-composer-isolation.invalid" }
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
      body = try JSONDecoder().decode(JSONValue.self, from: data)
      let method = body["method"]?.stringValue ?? ""
      let args = body["payload"]?["args"] ?? .null
      let sessionID = args["request"]?["sessionId"]?.stringValue
        ?? args["childSessionId"]?.stringValue ?? args["sessionId"]?.stringValue ?? ""
      Self.lock.lock(); Self.calls.append((method, sessionID))
      if method == "session/prompt" || method == "subagent/prompt" || method == "session/create" {
        Self.held.append(self); Self.lock.unlock(); return
      }
      Self.lock.unlock()
      switch method {
      case "session/models":
        reply(.object(["current": .object(["provider": .string("fixture"), "model": .string("text")]),
          "routable": .bool(true), "groups": .array([.object(["id": .string("fixture"), "name": .string("Fixture"),
          "models": .array([.object(["id": .string("text"), "name": .string("Text")]), .object(["id": .string("vision"), "name": .string("Vision")])])])]), "failures": .array([])]), domain: true)
      case "session/selectModel":
        reply(.object(["selected": .object(["provider": .string("fixture"), "model": .string("vision")])]), domain: true)
      case "llm/providers": reply(.object(["providers": .array([])]))
      case "settings/describe":
        reply(.object(["namespaces": .array([.object(["ns": .string("agent-default-model"), "revision": .number(1),
          "value": .object(["provider": .string("fixture"), "model": .string("vision")])])])]))
      case "workspace/list": reply(.object(["items": .array([]), "archivedSessionIds": .array([])]), domain: true)
      case "session/list": reply(.array([]))
      default: fail("fixture unavailable")
      }
    } catch { fail("fixture malformed request") }
  }
  override func stopLoading() { Self.lock.lock(); stopped = true; Self.lock.unlock() }
  private func reply(_ value: JSONValue, domain: Bool = false) {
    let business: JSONValue = domain ? .object(["ok": .bool(true), "value": value]) : value
    finish(.object(["ok": .bool(true), "value": .object(["ok": .bool(true), "value": business])]))
  }
  private func fail(_ message: String, imageRejection: Bool = false) {
    finish(.object(["ok": .bool(false), "error": .object(["message": .string(message),
      "details": imageRejection ? .object(["reason": .string("MODEL_DOES_NOT_SUPPORT_IMAGES")]) : .object([:])])]))
  }
  private func finish(_ result: JSONValue) {
    Self.lock.lock(); let mayFinish = !stopped; stopped = true; Self.lock.unlock()
    guard mayFinish, let url = request.url, let rpcID = body["rpcId"],
      let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil),
      let data = try? JSONEncoder().encode(JSONValue.object(["type": .string("server-response"), "rpcId": rpcID, "result": result]))
    else { return }
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: data)
    client?.urlProtocolDidFinishLoading(self)
  }
}

@MainActor
func runArkComposerSessionIsolationContractChecks() async {
  let root = FileManager.default.temporaryDirectory.appendingPathComponent("ark-composer-isolation-\(UUID().uuidString)")
  let suite = "ark-composer-isolation-\(UUID().uuidString)"
  guard let defaults = UserDefaults(suiteName: suite) else { check(false, "composer isolated defaults"); return }
  let config = URLSessionConfiguration.ephemeral
  config.protocolClasses = [ComposerIsolationURLProtocol.self]
  let transport = URLSession(configuration: config)
  let endpoint = URL(string: "http://ark-composer-isolation.invalid")!
  let client = ArkAPIClient(baseURL: endpoint, apiToken: "synthetic-contract", session: transport)
  let store = ArkDocumentReferenceStore(rootURL: root)
  let model = ArkAppModel(client: client,
    interactions: ArkInteractionAPI(baseURL: endpoint, apiToken: "synthetic-contract", session: transport),
    eventPump: ArkEventPump(baseURL: endpoint, apiToken: "synthetic-contract"),
    fallbackWikiRoot: root, documentStore: store, defaults: defaults)
  defer {
    transport.invalidateAndCancel(); defaults.removePersistentDomain(forName: suite)
    try? FileManager.default.removeItem(at: root); ComposerIsolationURLProtocol.reset()
  }
  func text(_ value: String) { model.composerTextDidChange(value, caret: (value as NSString).length, isComposing: false) }
  func addImage(_ value: UInt8) { model.addPastedImage(data: Data([value]), mediaType: .png) }
  func addDocument(_ value: String) async {
    let expected = model.pendingDocuments.count + 1
    model.addPastedDocument(String(repeating: value, count: 8_100))
    let imported = await composerIsolationEventually { model.pendingDocuments.count == expected }
    check(imported, "composer synthetic attachment import completes")
  }
  ComposerIsolationURLProtocol.reset()
  await model.loadSettings()
  model.selectSession("A")
  let ready = await composerIsolationEventually { model.composerModelRouteAvailable }
  check(ready && model.defaultModelSelection?.model == "vision", "composer real model route and fallback fixture are ready")
  guard ready else { return }
  text("A original"); addImage(1); await addDocument("A")
  let aDocument = model.pendingDocuments.first!
  model.sendComposer()
  let held = await composerIsolationEventually { ComposerIsolationURLProtocol.pendingCount == 1 }
  check(held, "ordinary composer transport pauses after the captured A submission")
  text("A newer")
  model.selectedSessionID = "B"
  text("B draft"); addImage(2); await addDocument("B")
  let bImages = model.pendingImages, bDocuments = model.pendingDocuments
  ComposerIsolationURLProtocol.releasePrompt(success: false, imageRejection: true)
  let failed = await composerIsolationEventually { !model.composerSubmissionInFlight }
  check(failed && model.composer == "B draft" && model.pendingImages == bImages && model.pendingDocuments == bDocuments,
    "late A rejection never restores A text or attachments into B")
  // Let any erroneously spawned automatic fallback reach the controlled transport.
  for _ in 0..<10 { await Task.yield() }
  check(ComposerIsolationURLProtocol.callCount("session/selectModel", sessionID: "B") == 0
      && ComposerIsolationURLProtocol.callCount("session/prompt", sessionID: "B") == 0,
    "late A image rejection never changes B model or automatically submits B")
  check(model.composerErrorMessage == nil, "late A rejection never publishes a composer error into B")
  model.selectedSessionID = "A"
  check(model.composer == "A original\nA newer", "late A rejection merges into the latest persisted A draft")
  check(model.pendingImages.map(\.data) == [Data([1])] && model.pendingDocuments == [aDocument],
    "failed A attachments remain reachable when returning to A")
  // Release unexpected baseline retry before proceeding, keeping failure deterministic.
  ComposerIsolationURLProtocol.releasePrompt(success: false)
  _ = await composerIsolationEventually { !model.composerSubmissionInFlight }

  model.beginNewConversation()
  let child = ArkSubagentEntry(id: "child-A", kind: "child", mode: "continuable", activity: "inactive", hasChildren: false, label: nil, reason: nil)
  model.installSubagentCatalog(parentSessionID: "parent", entries: [child], parentAvailable: true,
    authoritativeEntries: [child], clearRuntimeHints: false)
  model.selectedSessionID = child.id
  text("child original"); await addDocument("child")
  let childDocument = model.pendingDocuments.first!
  model.sendComposer()
  let childHeld = await composerIsolationEventually { ComposerIsolationURLProtocol.pendingCount == 1 }
  check(childHeld, "subagent composer pauses before its durable receipt")
  model.selectedSessionID = "B2"
  text("B2 newer"); addImage(3); await addDocument("child")
  let b2Images = model.pendingImages, b2Documents = model.pendingDocuments
  ComposerIsolationURLProtocol.releasePrompt(success: true)
  let childDone = await composerIsolationEventually { !model.composerSubmissionInFlight }
  check(childDone && model.composer == "B2 newer" && model.pendingImages == b2Images && model.pendingDocuments == b2Documents,
    "late subagent durable receipt cannot clear B2 text or attachments")
  check(FileManager.default.fileExists(atPath: childDocument.textURL.path),
    "accepted A document cannot remove identical content still referenced by B2")
  model.selectedSessionID = child.id
  check(model.composer.isEmpty && model.pendingDocuments.isEmpty,
    "late subagent durable receipt clears only its own unchanged A submission")

  text("child second"); await addDocument("second")
  let retainedDocument = model.pendingDocuments.first!
  model.sendComposer()
  let secondHeld = await composerIsolationEventually { ComposerIsolationURLProtocol.pendingCount == 1 }
  check(secondHeld, "subagent second submission reaches the controlled transport")
  text("child edited during send"); await addDocument("third")
  let editedDocuments = model.pendingDocuments
  ComposerIsolationURLProtocol.releasePrompt(success: true)
  let editedDone = await composerIsolationEventually { !model.composerSubmissionInFlight }
  check(editedDone && model.composer == "child edited during send" && model.pendingDocuments == editedDocuments,
    "subagent acknowledgement preserves edits and attachment additions made during the send")
  for _ in 0..<10 { await Task.yield() }
  check(FileManager.default.fileExists(atPath: retainedDocument.textURL.path),
    "subagent acknowledgement never deletes a document retained by the newer draft")
  await runComposerDeletedSendChecks(model: model)
  await runComposerAttachmentImportIsolationChecks(model: model, store: store)
  await runComposerCreationNavigationChecks(model: model)
}

@MainActor
private func composerIsolationEventually(_ condition: () -> Bool) async -> Bool {
  for _ in 0..<400 {
    if condition() { return true }
    try? await Task.sleep(nanoseconds: 5_000_000)
  }
  return condition()
}

private actor ComposerImportGate {
  typealias Value = (images: [ArkPromptImage], documents: [ArkPendingDocument])
  private var continuation: CheckedContinuation<Value, Error>?
  private var startWaiters: [CheckedContinuation<Void, Never>] = []
  func load() async throws -> Value {
    try await withCheckedThrowingContinuation { continuation in
      self.continuation = continuation
      let waiters = startWaiters; startWaiters = []
      waiters.forEach { $0.resume() }
    }
  }
  func waitUntilStarted() async {
    if continuation != nil { return }
    await withCheckedContinuation { startWaiters.append($0) }
  }
  func finish(_ result: Result<Value, Error>) {
    let pending = continuation; continuation = nil
    pending?.resume(with: result)
  }
}

@MainActor
private func runComposerAttachmentImportIsolationChecks(model: ArkAppModel, store: ArkDocumentReferenceStore) async {
  let imported: ArkPendingDocument
  do { imported = try await store.importPastedText("deferred synthetic document", name: "deferred.txt") }
  catch { check(false, "deferred import document fixture exists"); return }
  model.selectedSessionID = "import-A"
  let gate = ComposerImportGate()
  let loading = Task { await model.importComposerAttachments(for: "import-A", imageLimits: (2, 32, 64)) {
    try await gate.load()
  } }
  await gate.waitUntilStarted()
  model.selectedSessionID = "import-B"
  model.composerTextDidChange("B while A imports", caret: 17, isComposing: false)
  model.addPastedImage(data: Data([9]), mediaType: .png)
  let bImages = model.pendingImages, bDocuments = model.pendingDocuments
  let image = ArkPromptImage(mediaType: .png, data: Data([8]), name: "deferred.png")
  await gate.finish(.success(([image], [imported])))
  let completed = await loading.value
  check(completed && model.pendingImages == bImages && model.pendingDocuments == bDocuments
      && model.composer == "B while A imports" && model.composerErrorMessage == nil,
    "deferred A image and document import completes without changing B draft or attachments")
  model.selectedSessionID = "import-A"
  check(model.pendingImages == [image] && model.pendingDocuments == [imported],
    "returning to A reveals its deferred imported attachments")

  let failedGate = ComposerImportGate()
  let failing = Task { await model.importComposerAttachments(for: "import-A") { try await failedGate.load() } }
  await failedGate.waitUntilStarted()
  model.selectedSessionID = "import-B"
  model.composerTextDidChange("B newer during failed import", caret: 27, isComposing: false)
  await failedGate.finish(.failure(ArkAPIError(message: "synthetic A import failure")))
  let failed = await failing.value
  check(!failed && model.composerErrorMessage == nil && model.pendingImages == bImages
      && model.composer == "B newer during failed import",
    "deferred A import failure cannot publish an error into B")

  model.selectedSessionID = "import-limit"
  let firstGate = ComposerImportGate(), secondGate = ComposerImportGate()
  let first = Task { await model.importComposerAttachments(for: "import-limit", imageLimits: (1, 32, 32)) { try await firstGate.load() } }
  let second = Task { await model.importComposerAttachments(for: "import-limit", imageLimits: (1, 32, 32)) { try await secondGate.load() } }
  await firstGate.waitUntilStarted(); await secondGate.waitUntilStarted()
  model.selectedSessionID = "import-B"
  await firstGate.finish(.success(([image], [])))
  let firstAccepted = await first.value
  await secondGate.finish(.success(([image], [])))
  let secondAccepted = await second.value
  check(firstAccepted && !secondAccepted && model.composerErrorMessage == nil,
    "concurrent imports recheck the original session limit at completion without erroring B")
  model.selectedSessionID = "import-limit"
  check(model.pendingImages == [image], "concurrent import cannot exceed its owning session attachment budget")

  let deletedGate = ComposerImportGate()
  let deleted = Task { await model.importComposerAttachments(for: "deleted-import", imageLimits: (2, 32, 64)) { try await deletedGate.load() } }
  await deletedGate.waitUntilStarted()
  model.discardComposerAttachments(for: "deleted-import")
  let freshGate = ComposerImportGate()
  let fresh = Task { await model.importComposerAttachments(for: "deleted-import", imageLimits: (2, 32, 64)) { try await freshGate.load() } }
  await freshGate.waitUntilStarted()
  await deletedGate.finish(.success(([image], [])))
  let deletedAccepted = await deleted.value
  let freshImage = ArkPromptImage(mediaType: .png, data: Data([4]), name: "fresh.png")
  await freshGate.finish(.success(([freshImage], [])))
  let freshAccepted = await fresh.value
  model.selectedSessionID = "deleted-import"
  check(!deletedAccepted && freshAccepted && model.pendingImages == [freshImage],
    "deleted import owner cannot revive or clear a newer operation using the same session ID")
}

@MainActor
private func runComposerDeletedSendChecks(model: ArkAppModel) async {
  model.selectSession("deleted-send")
  let ready = await composerIsolationEventually { model.composerModelRouteAvailable }
  check(ready, "deleted-send fixture has a real ordinary model route")
  guard ready else { return }
  model.composerTextDidChange("discarded submission", caret: 20, isComposing: false)
  model.addPastedImage(data: Data([7]), mediaType: .png)
  model.sendComposer()
  let held = await composerIsolationEventually { ComposerIsolationURLProtocol.pendingCount == 1 }
  check(held, "deleted-send transport is held before its response")
  model.discardComposerAttachments(for: "deleted-send")
  model.selectedSessionID = "delete-safe-B"
  model.composerTextDidChange("B survives deletion", caret: 19, isComposing: false)
  model.addPastedImage(data: Data([6]), mediaType: .png)
  let expected = model.pendingImages
  ComposerIsolationURLProtocol.releasePrompt(success: false)
  let done = await composerIsolationEventually { !model.composerSubmissionInFlight }
  check(done && model.composer == "B survives deletion" && model.pendingImages == expected && model.composerErrorMessage == nil,
    "late failure from a deleted send owner never touches B")
  model.selectedSessionID = "deleted-send"
  check(model.composer.isEmpty && model.pendingImages.isEmpty && model.pendingDocuments.isEmpty,
    "late failure never restores the deleted send owner's draft or attachments")
}

@MainActor
private func runComposerCreationNavigationChecks(model: ArkAppModel) async {
  model.selectedSessionID = "create-origin"
  model.nextAgentPresetID = "preset-at-click"
  model.createSession(in: "workspace-at-click")
  model.nextAgentPresetID = "preset-after-click"
  let held = await composerIsolationEventually { ComposerIsolationURLProtocol.latestCreation != nil }
  let creation = ComposerIsolationURLProtocol.latestCreation
  check(held && creation?["workspaceId"]?.stringValue == "workspace-at-click"
      && creation?["agentPreset"]?.stringValue == "preset-at-click"
      && creation?["sessionId"]?.stringValue.flatMap(UUID.init(uuidString:)) != nil,
    "explicit creation captures workspace preset and one request-local UUID before awaiting")
  model.selectedSessionID = "create-new-selection"
  model.selectedTab = .trajectory
  ComposerIsolationURLProtocol.releaseCreation(success: true)
  let done = await composerIsolationEventually { !model.sessionCreationInFlight }
  check(done && model.selectedSessionID == "create-new-selection" && model.selectedTab == .trajectory,
    "late successful session creation cannot steal the newer session or tab navigation")

  model.createSession(in: nil)
  let failedHeld = await composerIsolationEventually { ComposerIsolationURLProtocol.latestCreation != nil }
  check(failedHeld, "failed creation reaches the held transport")
  model.selectedSessionID = "create-after-error"
  let previousError = model.navigationErrorMessage
  ComposerIsolationURLProtocol.releaseCreation(success: false)
  let failedDone = await composerIsolationEventually { !model.sessionCreationInFlight }
  check(failedDone && model.selectedSessionID == "create-after-error" && model.navigationErrorMessage == previousError,
    "late session creation failure cannot overwrite the newer navigation error surface")
}
