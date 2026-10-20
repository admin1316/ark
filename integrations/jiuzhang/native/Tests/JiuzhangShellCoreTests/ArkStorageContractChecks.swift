import Foundation
import AppKit
import SwiftUI
import JiuzhangShellCore
@testable import JiuzhangShellUI

private func storageFixture(attemptID: String? = nil, ready: Bool = false, epoch: Int = 0) -> JSONValue {
  .object([
    "write": .object(["phase": .string("healthy"), "events": .number(0), "bytes": .number(0),
      "totalEvents": .number(0), "totalBytes": .number(0), "oldestAt": .null,
      "lastSuccessAt": .null, "waitTimeoutMs": .number(30_000), "errorCode": .null]),
    "retrying": .bool(false),
    "quitEpoch": .number(Double(epoch)),
    "quit": attemptID.map { .object(["attemptId": .string($0), "phase": .string(ready ? "ready" : "saving"),
      "safeToQuit": .bool(ready), "errorCode": .null]) } ?? .null,
  ])
}

private final class StorageContractURLProtocol: URLProtocol, @unchecked Sendable {
  private static let lock = NSLock()
  private static var value = storageFixture()
  private static var epoch = 0
  private static var holdState = false
  private static var held: [(StorageContractURLProtocol, JSONValue, JSONValue)] = []
  private static var requests: [JSONValue] = []
  private static var losePrepareResponse = false
  private static var commandRequests: [JSONValue] = []
  private static var heldCommands: [StorageContractURLProtocol] = []
  private static var commandCancellations = 0
  private static var methods: [String] = []

  static func reset() {
    lock.lock(); defer { lock.unlock() }
    epoch = 0; value = storageFixture(); holdState = false; held = []; requests = []; losePrepareResponse = false
    commandRequests = []; heldCommands = []; commandCancellations = 0
    methods = []
  }
  static func holdNextObservation() { lock.lock(); holdState = true; lock.unlock() }
  static var heldCount: Int { lock.lock(); defer { lock.unlock() }; return held.count }
  static func prepareWithLostResponse() { lock.lock(); losePrepareResponse = true; lock.unlock() }
  static var captured: [JSONValue] { lock.lock(); defer { lock.unlock() }; return requests }
  static var capturedCommands: [JSONValue] { lock.lock(); defer { lock.unlock() }; return commandRequests }
  static var cancelledCommands: Int { lock.lock(); defer { lock.unlock() }; return commandCancellations }
  static var capturedMethods: [String] { lock.lock(); defer { lock.unlock() }; return methods }
  static func releaseCommands() {
    lock.lock(); let items = heldCommands; heldCommands = []; lock.unlock()
    for item in items { item.client?.urlProtocol(item, didFailWithError: URLError(.cancelled)) }
  }
  static func releaseObservations() {
    lock.lock(); let replies = held; held = []; lock.unlock()
    for (item, rpcID, state) in replies { item.reply(rpcID: rpcID, state: state) }
  }
  override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "ark-storage.invalid" }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    do {
      var bytes = request.httpBody ?? Data()
      if bytes.isEmpty, let stream = request.httpBodyStream {
        stream.open(); defer { stream.close() }
        var buffer = [UInt8](repeating: 0, count: 4096)
        while true {
          let count = stream.read(&buffer, maxLength: buffer.count)
          guard count >= 0 else { throw URLError(.cannotDecodeRawData) }
          if count == 0 { break }
          bytes.append(contentsOf: buffer.prefix(count))
        }
      }
      let envelope = try JSONDecoder().decode(JSONValue.self, from: bytes)
      guard let method = envelope["method"]?.stringValue, let rpcID = envelope["rpcId"]
      else { throw URLError(.badServerResponse) }
      Self.lock.lock(); Self.methods.append(method); Self.lock.unlock()
      guard let action = envelope["payload"]?["args"]?["request"] else { throw URLError(.badServerResponse) }
      if method == "session/command" {
        Self.lock.lock(); Self.commandRequests.append(action); Self.heldCommands.append(self); Self.lock.unlock()
        return
      }
      guard method == "session/storage", let kind = action["kind"]?.stringValue else { throw URLError(.badServerResponse) }
      Self.lock.lock()
      Self.requests.append(action)
      if kind == "prepare-quit", action["epoch"] == .number(Double(Self.epoch)) {
        Self.value = storageFixture(attemptID: action["attemptId"]?.stringValue,
          ready: Self.losePrepareResponse, epoch: Self.epoch)
      } else if kind == "cancel-quit", action["epoch"] == .number(Double(Self.epoch)),
                Self.value["quit"]?["attemptId"] == action["attemptId"] {
        Self.epoch += 1; Self.value = storageFixture(epoch: Self.epoch)
      }
      let state = Self.value
      let lose = kind == "prepare-quit" && Self.losePrepareResponse
      if lose { Self.losePrepareResponse = false }
      if kind == "state" && Self.holdState {
        Self.holdState = false; Self.held.append((self, rpcID, state)); Self.lock.unlock(); return
      }
      Self.lock.unlock()
      if lose { throw URLError(.timedOut) }
      reply(rpcID: rpcID, state: state)
    } catch { client?.urlProtocol(self, didFailWithError: error) }
  }
  override func stopLoading() {
    Self.lock.lock()
    Self.held.removeAll { $0.0 === self }
    if Self.heldCommands.contains(where: { $0 === self }) {
      Self.heldCommands.removeAll { $0 === self }; Self.commandCancellations += 1
    }
    Self.lock.unlock()
  }
  private func reply(rpcID: JSONValue, state: JSONValue) {
    guard let url = request.url,
          let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil),
          let bytes = try? JSONEncoder().encode(JSONValue.object([
            "type": .string("server-response"), "rpcId": rpcID,
            "result": .object(["ok": .bool(true), "value": .object(["ok": .bool(true),
              "value": .object(["ok": .bool(true), "value": state])])]),
          ])) else { return }
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: bytes)
    client?.urlProtocolDidFinishLoading(self)
  }
}

@MainActor
func runArkStorageContractChecks() async {
  let ready = storageFixture(attemptID: "quit-A", ready: true)
  check((try? ArkStorageState.decode(ready))?.permitsQuit(attemptID: "quit-A", epoch: 0) == true,
    "storage ready acknowledgement belongs to its exact quit attempt")
  check((try? ArkStorageState.decode(ready))?.permitsQuit(attemptID: "quit-B", epoch: 0) == false,
    "storage ready from an earlier attempt cannot end a later quit")
  let invalidWrites: [(String, JSONValue)] = [
    ("totalEvents", .number(-1)), ("bytes", .number(0.5)), ("totalBytes", .string("0")),
    ("waitTimeoutMs", .number(0)), ("oldestAt", .number(-1)), ("errorCode", .string("private exception text")),
    ("phase", .string("maybe-saved")),
  ]
  for (key, value) in invalidWrites {
    var body = ready.objectValue!, write = body["write"]!.objectValue!
    write[key] = value; body["write"] = .object(write)
    check((try? ArkStorageState.decode(.object(body))) == nil, "storage rejects invalid operational field \(key)")
  }
  var body = ready.objectValue!, write = body["write"]!.objectValue!
  write["totalEvents"] = .number(1); body["write"] = .object(write)
  check((try? ArkStorageState.decode(.object(body))) == nil,
    "storage rejects ready acknowledgements with outstanding events")
  body = ready.objectValue!; var quit = body["quit"]!.objectValue!
  quit["phase"] = .string("saving"); body["quit"] = .object(quit)
  check((try? ArkStorageState.decode(.object(body))) == nil,
    "storage never interprets a saving phase as safe to quit")
  for epoch in [JSONValue.null, .number(-1), .number(0.5), .string("0")] {
    body = ready.objectValue!; body["quitEpoch"] = epoch
    check((try? ArkStorageState.decode(.object(body))) == nil, "storage rejects missing or invalid quit epochs")
  }
  check((try? ArkStorageState.decode(ready))?.permitsQuit(attemptID: "quit-A", epoch: 1) == false,
    "storage ready acknowledgements cannot cross a cancelled epoch")

  StorageContractURLProtocol.reset()
  let config = URLSessionConfiguration.ephemeral
  config.protocolClasses = [StorageContractURLProtocol.self]
  let transport = URLSession(configuration: config)
  let endpoint = URL(string: "http://ark-storage.invalid")!
  let client = ArkAPIClient(baseURL: endpoint, apiToken: "synthetic-storage-only", session: transport)
  let suite = "ark-storage-\(UUID().uuidString)"
  let defaults = UserDefaults(suiteName: suite)!
  let root = FileManager.default.temporaryDirectory.appendingPathComponent(suite)
  let model = ArkAppModel(client: client,
    interactions: ArkInteractionAPI(baseURL: endpoint, apiToken: "synthetic", session: transport),
    eventPump: ArkEventPump(baseURL: endpoint, apiToken: "synthetic"), fallbackWikiRoot: root.appendingPathComponent("wiki"),
    documentStore: ArkDocumentReferenceStore(rootURL: root.appendingPathComponent("documents")), defaults: defaults)
  do {
    StorageContractURLProtocol.prepareWithLostResponse()
    do { try await model.prepareStorageQuit(attemptID: "quit-A") }
    catch { /* Synthetic lost acknowledgement leaves the Host-owned quit operation running. */ }
    check(!model.storagePermitsQuit(attemptID: "quit-A") && model.storageObservationFailed,
      "a prepare transport timeout preserves the interface without pretending the Host is ready")
    let readyDeadline = Date().addingTimeInterval(3)
    while !model.storagePermitsQuit(attemptID: "quit-A") && Date() < readyDeadline {
      try await Task.sleep(for: .milliseconds(20))
    }
    check(model.storagePermitsQuit(attemptID: "quit-A"),
      "the single monitor reconciles a lost prepare response using the same quit identity")
    StorageContractURLProtocol.holdNextObservation()
    let holdDeadline = Date().addingTimeInterval(3)
    while StorageContractURLProtocol.heldCount == 0 && Date() < holdDeadline {
      try await Task.sleep(for: .milliseconds(20))
    }
    check(StorageContractURLProtocol.heldCount == 1, "storage monitor owns at most one held observation")
    try await model.cancelStorageQuit(attemptID: "quit-A")
    StorageContractURLProtocol.releaseObservations()
    try await Task.sleep(for: .milliseconds(40))
    check(model.storageState?.quit == nil && !model.storagePermitsQuit(attemptID: "quit-A"),
      "a late ready observation cannot overwrite confirmed cancel-quit admission reopening")
    let second = try await client.storage(.prepareQuit(attemptID: "quit-B", epoch: 1))
    check(second.quit?.attemptID == "quit-B" && second.quitEpoch == 1,
      "a new quit reads and uses the Host epoch following cancellation")
    _ = try await client.storage(.cancelQuit(attemptID: "quit-B", epoch: 1))
    let stale = try await client.storage(.prepareQuit(attemptID: "quit-A", epoch: 0))
    check(stale.quit == nil && stale.quitEpoch == 2,
      "a prepare request delayed across two cancellations cannot close admission again")
    model.retryStorageSave(); model.retryStorageSave()
    try await Task.sleep(for: .milliseconds(40))
    check(StorageContractURLProtocol.captured.filter { $0["kind"] == .string("retry-save") }.count == 1,
      "repeated save retry clicks share one owned action and never submit another conversation turn")
  } catch { check(false, "storage synthetic transport contract: \(error)") }
  await model.shutdown()
  let observationsAfterShutdown = StorageContractURLProtocol.captured.count
  try? await Task.sleep(for: .milliseconds(40))
  check(StorageContractURLProtocol.captured.count == observationsAfterShutdown,
    "storage shutdown cancels and awaits its monitor before releasing the native model")
  transport.invalidateAndCancel(); defaults.removePersistentDomain(forName: suite)
  try? FileManager.default.removeItem(at: root)
  StorageContractURLProtocol.reset()
  await runStoragePostSafeTransportChecks()
  await runSourceDraftAcknowledgementChecks()
  await runFrozenAttachmentRestoreChecks()
  await runFrozenNativeDraftChecks()
}

private func runSourceDraftAcknowledgementChecks() async {
  for change in ["unchanged", "revision", "body", "images", "documents"] {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("ark-source-draft-cas-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: root) }
    do {
      let store = ArkDocumentReferenceStore(rootURL: root)
      var captured = ArkComposerDraftDocument(text: "synthetic captured source")
      captured.prepareSubmission(mode: .queue, timeZone: "UTC")
      let images = [ArkPromptImage(mediaType: .png, data: Data([31]), name: "original.png")]
      var fields = try JSONSerialization.jsonObject(with: JSONEncoder().encode(captured)) as! [String: Any]
      if change == "revision" { fields["revision"] = NSNumber(value: captured.revision + 1) }
      if change == "body" { fields["text"] = "later source body with the original identity" }
      let current = try JSONDecoder().decode(ArkComposerDraftDocument.self,
        from: JSONSerialization.data(withJSONObject: fields))
      let currentImages = change == "images"
        ? [ArkPromptImage(mediaType: .png, data: Data([32]), name: "later.png")] : images
      let currentDocuments = change == "documents"
        ? [try await store.importPastedText("later source document", name: "later.txt")] : []
      let journal = try await store.persistComposerState(document: current, sessionID: nil,
        images: currentImages, documents: currentDocuments)
      func storedBytes() throws -> [String: Data] {
        var values: [String: Data] = [:]
        for path in try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil) {
          values[path.lastPathComponent] = try Data(contentsOf: path)
        }
        return values
      }
      let before = try storedBytes()
      try await store.acknowledgePendingSubmission(sessionID: nil, submissionID: captured.submissionID,
        matchingDocument: captured, matchingImages: images, matchingDocuments: [])
      let restored = try await store.restorePendingSubmission(sessionID: nil)
      if change == "unchanged" {
        check(restored?.document.text.isEmpty == true && restored?.document.submissionID == nil
          && restored?.images.isEmpty == true && restored?.documents.isEmpty == true,
          "source acknowledgement writes the existing empty pending record for an exact payload")
      } else {
        let after = try storedBytes()
        check(current.submissionID == captured.submissionID && restored?.document == current
          && restored?.images == currentImages && restored?.documents == currentDocuments
          && restored?.journalIdentifier == journal && after == before,
          "source acknowledgement preserves same-identity \(change) changes without writing a partial clear")
      }
    } catch { check(false, "source draft acknowledgement \(change): \(error)") }
  }
}

private final class FrozenAttachmentStoreGate: @unchecked Sendable {
  private let condition = NSCondition()
  private var entered = false
  private var released = false
  var hasEntered: Bool { condition.lock(); defer { condition.unlock() }; return entered }
  func wait() {
    condition.lock(); defer { condition.unlock() }
    entered = true
    while !released { condition.wait() }
  }
  func release() { condition.lock(); released = true; condition.broadcast(); condition.unlock() }
}

private extension ArkDocumentReferenceStore {
  func holdFrozenAttachmentRestore(_ gate: FrozenAttachmentStoreGate) { gate.wait() }
}

@MainActor
private func runFrozenAttachmentRestoreChecks() async {
  let manager = FileManager.default
  for scenario in ["recovered", "edited", "added-image", "stopped", "cancelled"] {
    let root = manager.temporaryDirectory.appendingPathComponent("ark-frozen-attachments-\(UUID().uuidString)")
    let suite = "ark-frozen-attachments-\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defer { defaults.removePersistentDomain(forName: suite); try? manager.removeItem(at: root) }
    StorageContractURLProtocol.reset()
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [StorageContractURLProtocol.self]
    let transport = URLSession(configuration: config)
    defer { transport.invalidateAndCancel() }
    do {
      let documents = root.appendingPathComponent("documents")
      let preserved = root.appendingPathComponent("preserved-documents")
      try manager.createDirectory(at: documents, withIntermediateDirectories: true)
      let seed = ArkDocumentReferenceStore(rootURL: documents)
      let attachment = try await seed.importPastedText("synthetic preserved attachment body", name: "fixture.txt")
      let image = ArkPromptImage(mediaType: .png, data: Data([1, 2, 3]), name: "fixture.png")
      var document = ArkComposerDraftDocument(text: "/permission synthetic-preserved")
      document.prepareSubmission(mode: .queue, timeZone: "Pacific/Auckland", permissionPreset: "read-only")
      let journal = try await seed.persistComposerState(document: document, sessionID: nil,
        images: [image], documents: [attachment])
      _ = try await seed.persistInflightComposerSubmission(document: document, sessionID: nil,
        images: [image], documents: [attachment])
      defaults.set(try JSONEncoder().encode(document), forKey: "ark.native.composer-document.new-session")
      defaults.set(document.text, forKey: "ark.native.composer-draft.new-session")
      defaults.set(journal, forKey: "ark.native.composer-attachments.new-session")
      try manager.moveItem(at: documents, to: preserved)
      let store = ArkDocumentReferenceStore(rootURL: documents)
      let endpoint = URL(string: "http://ark-storage.invalid")!
      let model = ArkAppModel(client: ArkAPIClient(baseURL: endpoint, apiToken: "synthetic", session: transport),
        interactions: ArkInteractionAPI(baseURL: endpoint, apiToken: "synthetic", session: transport),
        eventPump: ArkEventPump(baseURL: endpoint, apiToken: "synthetic"),
        fallbackWikiRoot: root.appendingPathComponent("wiki"), documentStore: store, defaults: defaults)
      let deadline = Date().addingTimeInterval(2)
      while !model.composerAttachmentRestoreFailed && Date() < deadline {
        try await Task.sleep(for: .milliseconds(5))
      }
      check(model.composerAttachmentRestoreFailed && model.composer == document.text
        && model.pendingImages.isEmpty && model.pendingDocuments.isEmpty,
        "cold missing attachments preserve the real draft and expose restoration failure (\(scenario))")
      if scenario == "edited" {
        model.composerTextDidChange("later unsaved text", caret: 18, isComposing: false)
      } else if scenario == "added-image" {
        model.addPastedImage(data: Data([4, 5, 6]), mediaType: .png)
      }
      model.freezeNativeInput()
      let missing = await model.flushFrozenComposerDrafts()
      check(missing != nil && model.composerAttachmentRestoreFailed,
        "a frozen retry cannot acknowledge missing attachments (\(scenario))")
      try manager.moveItem(at: preserved, to: documents)
      if scenario == "recovered" {
        let journalURL = documents.appendingPathComponent("draft-\(journal).json")
        let journalBytes = try Data(contentsOf: journalURL)
        try Data("synthetic damaged journal".utf8).write(to: journalURL)
        let corrupted = await model.flushFrozenComposerDrafts()
        check(corrupted != nil && model.composerAttachmentRestoreFailed && model.pendingImages.isEmpty,
          "a frozen retry validates the restored journal and retains failure for corrupt bytes")
        try journalBytes.write(to: journalURL)
      }
      if scenario == "stopped" || scenario == "cancelled" {
        let gate = FrozenAttachmentStoreGate()
        let holding = Task.detached { await store.holdFrozenAttachmentRestore(gate) }
        while !gate.hasEntered { await Task.yield() }
        var finished = false
        let flushing = Task { let result = await model.flushFrozenComposerDrafts(); finished = true; return result }
        try await Task.sleep(for: .milliseconds(30))
        check(!finished, "the frozen retry waits for its actual store owner before reporting a result (\(scenario))")
        let stopping: Task<Void, Never>?
        if scenario == "stopped" {
          stopping = Task { await model.shutdown() }
          try await Task.sleep(for: .milliseconds(30))
        } else { stopping = nil; flushing.cancel() }
        gate.release()
        await holding.value
        if let stopping { await stopping.value }
        let stoppedResult = await flushing.value
        check(stoppedResult != nil && model.composerAttachmentRestoreFailed
          && model.pendingImages.isEmpty && model.pendingDocuments.isEmpty && model.composer == document.text,
          "stop or caller cancellation suppresses late restoration without acknowledging its draft (\(scenario))")
        if scenario == "cancelled" {
          let resumed = await model.flushFrozenComposerDrafts()
          check(resumed == nil && model.pendingImages == [image] && model.pendingDocuments == [attachment],
            "a later explicit frozen retry can recover after the cancelled observation has settled")
          await model.shutdown()
        }
      } else {
        let retried = await model.flushFrozenComposerDrafts()
        let restored = try await store.restorePendingSubmission(sessionID: nil)
        if scenario == "recovered" {
          check(retried == nil && !model.composerAttachmentRestoreFailed
            && model.composer == document.text && model.pendingImages == [image] && model.pendingDocuments == [attachment],
            "frozen retry restores real image and document payloads after their directory returns")
          check(restored?.document == document && restored?.images == [image] && restored?.documents == [attachment],
            "the final save preserves the uncertain submission identity and frozen delivery metadata")
        } else {
          check(retried != nil && model.composerAttachmentRestoreFailed && restored?.document == document
            && (scenario == "edited" ? model.composer == "later unsaved text" : model.pendingImages.count == 1),
            "frozen restoration rejects a newer draft or new attachment instead of reverting or saving a reduced payload (\(scenario))")
        }
        await model.shutdown()
      }
      let inflight = try await store.restoreInflightSubmissions(sessionID: nil)
      check(inflight.count == 1 && inflight.first?.document == document
        && StorageContractURLProtocol.capturedMethods.isEmpty,
        "final attachment recovery retains the original inflight receipt and performs no RPC (\(scenario))")
    } catch { check(false, "frozen attachment recovery \(scenario): \(error)") }
  }
  for recovery in ["healthy", "frozen", "navigation"] {
    let initiallyMissingJournal = recovery != "healthy"
    let suite = "ark-inflight-only-\(UUID().uuidString)"
    let root = manager.temporaryDirectory.appendingPathComponent(suite)
    let absent = root.appendingPathExtension("absent")
    let defaults = UserDefaults(suiteName: suite)!
    defer {
      defaults.removePersistentDomain(forName: suite)
      try? manager.removeItem(at: root); try? manager.removeItem(at: absent)
    }
    StorageContractURLProtocol.reset()
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [StorageContractURLProtocol.self]
    let transport = URLSession(configuration: config)
    defer { transport.invalidateAndCancel() }
    do {
      let store = ArkDocumentReferenceStore(rootURL: root)
      let image = ArkPromptImage(mediaType: .png, data: Data([7, 8, 9]), name: "inflight-only.png")
      var document = ArkComposerDraftDocument(text: "uncertain inflight without a current draft")
      document.prepareSubmission(mode: .queue, timeZone: "UTC", permissionPreset: "read-only")
      let journal = try await store.persistInflightComposerSubmission(document: document, sessionID: nil,
        images: [image], documents: [])
      let journalURL = root.appendingPathComponent("draft-\(journal).json")
      let withheld = root.appendingPathComponent("withheld-journal")
      if initiallyMissingJournal { try manager.moveItem(at: journalURL, to: withheld) }
      let endpoint = URL(string: "http://ark-storage.invalid")!
      let model = ArkAppModel(client: ArkAPIClient(baseURL: endpoint, apiToken: "synthetic", session: transport),
        interactions: ArkInteractionAPI(baseURL: endpoint, apiToken: "synthetic", session: transport),
        eventPump: ArkEventPump(baseURL: endpoint, apiToken: "synthetic"),
        fallbackWikiRoot: root.appendingPathComponent("wiki"), documentStore: store, defaults: defaults)
      if initiallyMissingJournal {
        let failureDeadline = Date().addingTimeInterval(2)
        while !model.composerAttachmentRestoreFailed && Date() < failureDeadline {
          try await Task.sleep(for: .milliseconds(5))
        }
        check(model.composerAttachmentRestoreFailed,
          "inflight-only cold restoration retains a missing attachment journal as an explicit failure")
        if recovery == "navigation" {
          try manager.moveItem(at: root, to: absent)
          model.selectedSessionID = "unrelated-empty-session"
          model.selectedSessionID = nil
          model.freezeNativeInput()
          let navigated = await model.flushFrozenComposerDrafts()
          check(navigated != nil && model.composerAttachmentRestoreFailed,
            "ordinary restoration after navigation cannot clear an earlier failure with an absent store")
          if manager.fileExists(atPath: root.path) { try manager.removeItem(at: root) }
          try manager.moveItem(at: absent, to: root)
        } else { model.freezeNativeInput() }
        let missing = await model.flushFrozenComposerDrafts()
        check(model.composerAttachmentRestoreFailed && missing != nil,
          "final retry retains an inflight-only attachment failure before filesystem repair")
        try manager.moveItem(at: root, to: absent)
        let noEvidence = await model.flushFrozenComposerDrafts()
        check(noEvidence != nil && model.composerAttachmentRestoreFailed,
          "an absent store cannot clear failed inflight restoration by returning no pending draft or journals")
        if manager.fileExists(atPath: root.path) { try manager.removeItem(at: root) }
        try manager.moveItem(at: absent, to: root)
        try manager.moveItem(at: withheld, to: journalURL)
        let restored = await model.flushFrozenComposerDrafts()
        check(restored == nil && !model.composerAttachmentRestoreFailed
          && model.composer.isEmpty && model.pendingImages.isEmpty,
          "frozen retry validates repaired inflight-only attachments without installing them into the empty active draft")
      }
      let deadline = Date().addingTimeInterval(2)
      while model.composerRecoverableSubmissionCount != 1 && Date() < deadline {
        try await Task.sleep(for: .milliseconds(5))
      }
      check(model.composerRecoverableSubmissionCount == 1 && model.canRestoreUnconfirmedSubmission,
        "cold recovery exposes an inflight-only submission without a pending draft or attachment preference")
      if !initiallyMissingJournal {
        model.restoreUnconfirmedComposerSubmission()
        check(model.composer == document.text && model.pendingImages == [image],
          "explicit inflight-only recovery restores its original text and image payload")
      }
      let inflight = try await store.restoreInflightSubmissions(sessionID: nil)
      check(inflight.count == 1 && inflight.first?.document == document && inflight.first?.images == [image]
        && !StorageContractURLProtocol.capturedMethods.contains(where: { $0 == "session/prompt" || $0 == "session/command" }),
        "inflight-only recovery retains its uncertain identity, metadata and attachment bytes")
      await model.shutdown()
    } catch { check(false, "inflight-only recovery contract: \(error)") }
  }
}

@MainActor
private func runFrozenNativeDraftChecks() async {
  let manager = FileManager.default
  let root = manager.temporaryDirectory.appendingPathComponent("ark-final-drafts-\(UUID().uuidString)")
  let suite = "ark-final-drafts-\(UUID().uuidString)"
  let defaults = UserDefaults(suiteName: suite)!
  defer { defaults.removePersistentDomain(forName: suite); try? manager.removeItem(at: root) }
  do {
    try manager.createDirectory(at: root, withIntermediateDirectories: true)
    let documents = root.appendingPathComponent("documents")
    try manager.createDirectory(at: documents, withIntermediateDirectories: true)
    let store = ArkDocumentReferenceStore(rootURL: documents)
    let endpoint = URL(string: "http://ark-storage.invalid")!
    let model = ArkAppModel(client: ArkAPIClient(baseURL: endpoint, apiToken: "synthetic"),
      interactions: ArkInteractionAPI(baseURL: endpoint, apiToken: "synthetic"),
      eventPump: ArkEventPump(baseURL: endpoint, apiToken: "synthetic"),
      fallbackWikiRoot: root.appendingPathComponent("wiki"), documentStore: store, defaults: defaults)
    model.composerTextDidChange("before Host wait", caret: 16, isComposing: false)
    let initialSaveDeadline = Date().addingTimeInterval(2)
    while (try? await store.restorePendingSubmission(sessionID: nil))?.document.text != "before Host wait"
      && Date() < initialSaveDeadline {
      model.composerTextDidChange("before Host wait", caret: 16, isComposing: false)
      await Task.yield()
    }
    let initialized = try? await store.restorePendingSubmission(sessionID: nil)
    check(initialized?.document.text == "before Host wait",
      "the final-draft fault fixture first confirms a healthy initialized composer journal")
    let previousDocuments = root.appendingPathComponent("previous-documents")
    try manager.moveItem(at: documents, to: previousDocuments)
    try Data("synthetic path obstruction".utf8).write(to: documents)
    model.composerTextDidChange("latest while Host was saving", caret: 28, isComposing: false)
    model.freezeNativeInput()
    let failed = await model.flushFrozenComposerDrafts()
    model.composerTextDidChange("late keyboard callback", caret: 22, isComposing: false)
    model.beginNewConversation()
    model.addPastedImage(data: Data([1]), mediaType: .png)
    check(failed != nil && model.nativeInputFrozen && model.composer == "latest while Host was saving"
      && model.pendingImages.isEmpty,
      "final composer failure retains the last wait-period edit and rejects frozen text, navigation and attachments")
    try manager.removeItem(at: documents)
    try manager.moveItem(at: previousDocuments, to: documents)
    let retried = await model.flushFrozenComposerDrafts()
    let restored = try await store.restorePendingSubmission(sessionID: nil)
    check(retried == nil,
      "the final composer retry confirms saving after filesystem recovery: \(retried ?? "saved")")
    check(restored?.document.text == "latest while Host was saving",
      "the recovered final composer journal contains the latest frozen text: \(restored?.document.text ?? "missing")")
    await model.shutdown()

    let workspace = root.appendingPathComponent("workspace")
    try manager.createDirectory(at: workspace, withIntermediateDirectories: true)
    let file = workspace.appendingPathComponent("synthetic.txt")
    try "baseline".write(to: file, atomically: true, encoding: .utf8)
    let storage = root.appendingPathComponent("workbench-drafts")
    let journal = NativeWorkbenchDraftJournal(storageURL: storage)
    let workbench = NativeWorkbenchModel(rootURL: workspace, draftJournal: journal, draftDebounceNanoseconds: 2_000_000)
    await workbench.selectFile(file)
    workbench.updateEditorText("before waiting")
    _ = await workbench.flushRecoveryDrafts()
    workbench.updateEditorText("last edit while Host was saving")
    let coordinator = NativeWorkbenchDraftFlushCoordinator()
    var entered = false
    var finished = false
    var release: CheckedContinuation<Void, Never>?
    let id = coordinator.register(freeze: { workbench.freezeLocalInput() }) {
      if !entered {
        entered = true
        await withCheckedContinuation { release = $0 }
      }
      if let error = await workbench.flushRecoveryDrafts() { return .failed(error) }
      return .flushed
    }
    coordinator.freezeLocalInput()
    let previous = root.appendingPathComponent("previous-workbench-drafts")
    try manager.moveItem(at: storage, to: previous)
    try Data("synthetic path obstruction".utf8).write(to: storage)
    let saving = Task { let error = await coordinator.flush(); finished = true; return error }
    while !entered { await Task.yield() }
    workbench.updateEditorText("late input after freeze")
    workbench.revertEditor()
    workbench.saveEditor()
    let sourceText = try String(contentsOf: file, encoding: .utf8)
    check(!finished && workbench.localInputFrozen && workbench.activeFileTab?.text == "last edit while Host was saving"
      && sourceText == "baseline",
      "a slow final Workbench barrier keeps the last version frozen and rejects late edits, revert and save actions")
    release?.resume(); release = nil
    let workbenchFailure = await saving.value
    check(workbenchFailure != nil && workbench.activeFileTab?.isDirty == true,
      "a failed final Workbench write preserves its dirty in-memory buffer for waiting or explicit retry")
    try manager.removeItem(at: storage)
    try manager.moveItem(at: previous, to: storage)
    let workbenchRetry = await coordinator.flush()
    let recovered = try journal.load(workspaceRoot: workspace)
    check(workbenchRetry == nil && recovered.first?.draftText == "last edit while Host was saving",
      "successful final Workbench retry persists the wait-period edit before any interface removal")
    var lateOwnerFrozen = false
    let late = coordinator.register(freeze: { lateOwnerFrozen = true }) { .flushed }
    check(lateOwnerFrozen, "an owner mounted after the final freeze cannot reopen local input")
    coordinator.unregister(id); coordinator.unregister(late)
    try? await Task.sleep(for: .milliseconds(15))
    await runFrozenNativeEditorChecks()
  } catch { check(false, "final frozen native drafts contract: \(error)") }
}

@MainActor
private func runFrozenNativeEditorChecks() async {
  var composerChanges = 0
  var submitted = 0
  let composer = NativeComposerTextView(text: "frozen composer", references: [], isComposing: .constant(false),
    focusRevision: 0, requestedCaret: nil, textChanged: { _, _, _ in composerChanges += 1 },
    selectionChanged: { _, _ in }, handleMenuKey: { _, _ in false }, moveFocus: { _ in },
    referenceDeletionRange: { _, _ in nil }, submit: { submitted += 1 }, submitAlternate: { submitted += 1 },
    pasteImage: { _, _ in }, pasteDocument: { _ in }, addAttachmentURLs: { _ in })
  let host = NSHostingView(rootView: VStack {
    composer.frame(height: 80)
    NativeCodeEditorView(text: .constant("frozen file"), fileURL: nil, isEditable: true).frame(height: 80)
  }.disabled(true))
  host.frame = NSRect(x: 0, y: 0, width: 480, height: 200)
  host.layoutSubtreeIfNeeded()
  try? await Task.sleep(for: .milliseconds(20))
  host.layoutSubtreeIfNeeded()
  func editors(_ view: NSView) -> [NSTextView] {
    (view as? NSTextView).map { [$0] } ?? view.subviews.flatMap(editors)
  }
  let mounted = editors(host)
  if let editor = mounted.first(where: { $0 is ComposerNSTextView }) as? ComposerNSTextView,
     let key = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0,
       windowNumber: 0, context: nil, characters: "\r", charactersIgnoringModifiers: "\r", isARepeat: false, keyCode: 36) {
    editor.keyDown(with: key)
    editor.setMarkedText("late IME", selectedRange: NSRange(location: 0, length: 0), replacementRange: NSRange(location: NSNotFound, length: 0))
  }
  check(mounted.count == 2 && mounted.allSatisfy { !$0.isEditable } && composerChanges == 0 && submitted == 0,
    "disabled SwiftUI bridges make actual AppKit editors read-only and reject Return and late IME submission")
}

/// Host readiness and a native response body are separate acknowledgements.
@MainActor
private func runStoragePostSafeTransportChecks() async {
  StorageContractURLProtocol.reset()
  let config = URLSessionConfiguration.ephemeral
  config.protocolClasses = [StorageContractURLProtocol.self]
  let transport = URLSession(configuration: config)
  let endpoint = URL(string: "http://ark-storage.invalid")!
  let client = ArkAPIClient(baseURL: endpoint, apiToken: "synthetic-post-safe", session: transport)
  let suite = "ark-post-safe-\(UUID().uuidString)", sessionID = "post-safe-session"
  let defaults = UserDefaults(suiteName: suite)!
  let root = FileManager.default.temporaryDirectory.appendingPathComponent(suite)
  let store = ArkDocumentReferenceStore(rootURL: root.appendingPathComponent("documents"))
  let model = ArkAppModel(client: client,
    interactions: ArkInteractionAPI(baseURL: endpoint, apiToken: "synthetic", session: transport),
    eventPump: ArkEventPump(baseURL: endpoint, apiToken: "synthetic"), fallbackWikiRoot: root.appendingPathComponent("wiki"),
    documentStore: store, defaults: defaults)
  model.selectedSessionID = sessionID
  model.runSessionCommand("/record post-safe")
  let requestDeadline = Date().addingTimeInterval(3)
  while StorageContractURLProtocol.capturedCommands.isEmpty && Date() < requestDeadline {
    try? await Task.sleep(for: .milliseconds(10))
  }
  let originalID = StorageContractURLProtocol.capturedCommands.first?["invocationId"]?.stringValue
  check(originalID != nil, "post-safe command response remains held after its identity is durably prepared")
  StorageContractURLProtocol.prepareWithLostResponse()
  do { try await model.prepareStorageQuit(attemptID: "post-safe-quit") }
  catch { /* The Host acknowledgement is intentionally lost; its state still reaches ready. */ }
  let readyDeadline = Date().addingTimeInterval(3)
  while !model.storagePermitsQuit(attemptID: "post-safe-quit") && Date() < readyDeadline {
    try? await Task.sleep(for: .milliseconds(10))
  }
  check(model.storagePermitsQuit(attemptID: "post-safe-quit") && StorageContractURLProtocol.cancelledCommands == 0,
    "Host safe acknowledgement does not fabricate the held native command receipt")
  var finished = false
  let stopping = Task { await model.shutdown(); finished = true }
  let stopDeadline = Date().addingTimeInterval(3)
  while (!finished || StorageContractURLProtocol.cancelledCommands == 0) && Date() < stopDeadline {
    try? await Task.sleep(for: .milliseconds(10))
  }
  check(finished && StorageContractURLProtocol.cancelledCommands == 1,
    "post-safe native teardown cancels and settles its actual URLSession response observation")
  if !finished { StorageContractURLProtocol.releaseCommands() }
  await stopping.value
  do {
    let recovered = try await ArkDocumentReferenceStore(rootURL: root.appendingPathComponent("documents"))
      .prepareCommandAction(sessionID: sessionID, line: "/record post-safe")
    check(recovered == originalID && StorageContractURLProtocol.capturedCommands.count == 1,
      "cancelled post-safe observation preserves its original durable journal and never re-executes or acknowledges it")
  } catch { check(false, "post-safe journal recovery: \(error)") }
  transport.invalidateAndCancel(); defaults.removePersistentDomain(forName: suite)
  try? FileManager.default.removeItem(at: root)
  StorageContractURLProtocol.reset()
}
