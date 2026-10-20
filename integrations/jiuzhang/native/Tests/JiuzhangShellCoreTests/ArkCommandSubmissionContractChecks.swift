import Foundation
import JiuzhangShellCore
@testable import JiuzhangShellUI

private struct NativeCommandRequest: Sendable {
  let sessionID: String
  let line: String
  let images: [ArkPromptImage]
  let invocationID: String
}

private actor NativeCommandReceiptGate {
  private var requests: [NativeCommandRequest] = []
  private var pending: CheckedContinuation<ArkCommandOutcome, Error>?

  func execute(_ request: NativeCommandRequest) async throws -> ArkCommandOutcome {
    requests.append(request)
    return try await withCheckedThrowingContinuation { pending = $0 }
  }

  func requestCount() -> Int { requests.count }
  func latest() -> NativeCommandRequest? { requests.last }
  func finish(_ outcome: ArkCommandOutcome) { let value = pending; pending = nil; value?.resume(returning: outcome) }
}

@MainActor
func runArkCommandSubmissionContractChecks() async {
  func verify(_ condition: Bool, _ message: String) { check(condition, message) }
  let root = FileManager.default.temporaryDirectory.appendingPathComponent("ark-command-owner-\(UUID().uuidString)")
  defer { try? FileManager.default.removeItem(at: root) }
  let store = ArkDocumentReferenceStore(rootURL: root)
  let gate = NativeCommandReceiptGate()
  func owner(_ store: ArkDocumentReferenceStore) -> ArkCommandSubmissionOwner {
    ArkCommandSubmissionOwner(documentStore: store) { sessionID, line, images, invocationID in
      try await gate.execute(NativeCommandRequest(sessionID: sessionID, line: line,
        images: images, invocationID: invocationID))
    }
  }
  func waitForRequests(_ count: Int) async -> Bool {
    for _ in 0..<400 {
      if await gate.requestCount() == count { return true }
      try? await Task.sleep(nanoseconds: 5_000_000)
    }
    return await gate.requestCount() == count
  }
  let firstOwner = owner(store)
  let first = Task { try await firstOwner.submitAction(sessionID: "synthetic-session", line: "/record once") }
  verify(await waitForRequests(1), "native command reaches transport after journal preparation")
  guard let initial = await gate.latest() else { return }
  do {
    let restoredStore = ArkDocumentReferenceStore(rootURL: root)
    let durableID = try await restoredStore.prepareCommandAction(sessionID: "synthetic-session", line: "/record once")
    let recoveredDrafts = try await restoredStore.restoreInflightSubmissions(sessionID: "synthetic-session")
    check(durableID == initial.invocationID && recoveredDrafts.isEmpty,
      "menu command identity is already durable before transport and cannot replace a composer draft")
  } catch { check(false, "native command journal restores before reply: \(error)") }
  await gate.finish(.running(commandID: "synthetic-command"))
  if case .success = await first.result { check(false, "running receipt cannot be accepted as completion") }
  else { check(true, "running receipt preserves the command submission") }
  await firstOwner.stop()

  let restarted = owner(ArkDocumentReferenceStore(rootURL: root))
  let retry = Task { try await restarted.submitAction(sessionID: "synthetic-session", line: "/record once") }
  verify(await waitForRequests(2), "restarted native command owner can query the durable pending invocation")
  verify(await gate.latest()?.invocationID == initial.invocationID,
    "running retry after native owner recreation uses the original invocation identity")
  await gate.finish(.unknown(commandID: "synthetic-command", reason: .interrupted))
  if case .success = await retry.result { check(false, "unknown receipt cannot be accepted as completion") }
  else { check(true, "unknown receipt preserves the command submission") }
  let complete = Task { try await restarted.submitAction(sessionID: "synthetic-session", line: "/record once") }
  verify(await waitForRequests(3), "unknown native command retries query its receipt")
  verify(await gate.latest()?.invocationID == initial.invocationID,
    "unknown native retry never mints a replacement invocation identity")
  await gate.finish(.completed(ArkCommandExecution(id: "synthetic-command", result: .success)))
  do {
    let receipt = try await complete.value
    let beforeAcknowledgement = try await store.prepareCommandAction(sessionID: "synthetic-session", line: "/record once")
    check(beforeAcknowledgement == initial.invocationID, "terminal transport reply retains identity until native acknowledgement")
    try await restarted.acknowledgeAction(receipt)
    let next = try await store.prepareCommandAction(sessionID: "synthetic-session", line: "/record once")
    check(next != initial.invocationID, "a later explicit action may use a new identity after acknowledgement")
    try await store.removeInflightSubmission(next)
  } catch { check(false, "native command completion retires its exact journal: \(error)") }

  let failedAction = Task { try await restarted.submitAction(sessionID: "synthetic-session", line: "/record terminal-error") }
  verify(await waitForRequests(4), "native action observes a completed error as a terminal receipt")
  let failedID = await gate.latest()?.invocationID
  await gate.finish(.completed(ArkCommandExecution(id: "synthetic-failed-command", result: .error,
    text: "synthetic confirmed error")))
  do {
    let receipt = try await failedAction.value
    check(receipt.execution.result == .error && receipt.execution.text == "synthetic confirmed error",
      "native action preserves the complete error result until the UI acknowledges it")
    let beforeAcknowledgement = try await store.prepareCommandAction(sessionID: "synthetic-session", line: "/record terminal-error")
    check(beforeAcknowledgement == failedID, "unacknowledged completed error retains the same action identity")
    try await restarted.acknowledgeAction(receipt)
    let newIntent = try await store.prepareCommandAction(sessionID: "synthetic-session", line: "/record terminal-error")
    check(newIntent != failedID, "an explicitly new action after an acknowledged error may use a new identity")
    try await store.removeInflightSubmission(newIntent)
  } catch { check(false, "native completed-error acknowledgement completes: \(error)") }

  var captured = ArkComposerDraftDocument(text: "/record captured")
  captured.prepareSubmission(mode: .queue, timeZone: "UTC")
  let image = ArkPromptImage(mediaType: .png, data: Data([7]), name: "synthetic.png")
  guard let capturedID = captured.submissionID else { return }
  do {
    _ = try await store.persistInflightComposerSubmission(document: captured,
      sessionID: "synthetic-session", images: [image], documents: [])
    let firstCaptured = Task { try await restarted.submitCaptured(sessionID: "synthetic-session",
      line: captured.text, images: [image], invocationID: capturedID) }
    verify(await waitForRequests(5), "captured command reaches the shared native owner")
    let duplicate = Task { try await restarted.submitCaptured(sessionID: "synthetic-session",
      line: captured.text, images: [image], invocationID: capturedID) }
    for _ in 0..<10 { await Task.yield() }
    let capturedRequestCount = await gate.requestCount()
    let capturedRequest = await gate.latest()
    check(capturedRequestCount == 5 && capturedRequest?.invocationID == capturedID,
      "concurrent native retry shares one transport and preserves the captured composer identity")
    do {
      _ = try await restarted.submitCaptured(sessionID: "synthetic-session", line: "/record changed",
        images: [image], invocationID: capturedID)
      check(false, "native owner rejects changed input under an active command identity")
    } catch { check(true, "native owner rejects changed input under an active command identity") }
    firstCaptured.cancel()
    var stopped = false
    let stopping = Task { await restarted.stop(); stopped = true }
    for _ in 0..<10 { await Task.yield() }
    check(!stopped, "native command shutdown waits for owned transport after caller cancellation")
    await gate.finish(.completed(ArkCommandExecution(id: "synthetic-captured", result: .success)))
    _ = await firstCaptured.result
    _ = await duplicate.result
    await stopping.value
    let retained = try await store.restoreInflightSubmissions(sessionID: "synthetic-session")
    check(stopped && retained.count == 1 && retained[0].document.submissionID == capturedID,
      "shared command owner leaves captured draft acknowledgement to the composer")
    do {
      _ = try await restarted.submitAction(sessionID: "synthetic-session", line: "/record after-stop")
      check(false, "stopped native owner rejects new command admission")
    } catch { check(true, "stopped native owner rejects new command admission") }
  } catch { check(false, "captured command owner contract completes: \(error)") }
  await runNativeInflightCapacityChecks(root: root.appendingPathComponent("capacity"))
}

private func runNativeInflightCapacityChecks(root: URL) async {
  let store = ArkDocumentReferenceStore(rootURL: root)
  do {
    let journal = try await store.persistDraftAttachments(images: [], documents: [])
    var identifiers: [String] = []
    for index in 0..<128 {
      var document = ArkComposerDraftDocument(text: "synthetic pending \(index)")
      identifiers.append(document.ensureSubmissionID())
      try await store.persistInflightSubmission(document: document,
        sessionID: "capacity-session", journalIdentifier: journal)
    }
    var overflow = ArkComposerDraftDocument(text: "synthetic overflow")
    let overflowID = overflow.ensureSubmissionID()
    do {
      try await store.persistInflightSubmission(document: overflow,
        sessionID: "capacity-session", journalIdentifier: journal)
      check(false, "native inflight admission rejects overflow before creating an unrecoverable journal")
    } catch { check(true, "native inflight admission rejects overflow before creating an unrecoverable journal") }
    let full = try await store.restoreInflightSubmissions(sessionID: "capacity-session")
    check(full.count == 128 && !full.contains { $0.document.submissionID == overflowID },
      "native inflight rejection leaves all existing pending payloads recoverable within the limit")
    try await store.removeInflightSubmission(identifiers[0])
    try await store.persistInflightSubmission(document: overflow,
      sessionID: "capacity-session", journalIdentifier: journal)
    let resumed = try await store.restoreInflightSubmissions(sessionID: "capacity-session")
    check(resumed.count == 128 && resumed.contains { $0.document.submissionID == overflowID },
      "native inflight admission resumes after one exact submission retires")
  } catch { check(false, "native inflight capacity contract completes: \(error)") }
}
