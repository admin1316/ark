import CryptoKit
import Darwin
import Foundation
@testable import JiuzhangShellCore

@MainActor
func runArkProtectedObservationContractChecks() async {
  let hash = String(repeating: "a", count: 64)
  func rejects(_ title: String, _ body: () throws -> Void) {
    do { try body(); check(false, title) } catch { check(true, title) }
  }
  rejects("observation parser refuses duplicate decoded member names") {
    try ArkProtectedStrictJSON.validate(Data("{\"operation\":1,\"\\u006fperation\":2}".utf8))
  }
  rejects("observation parser refuses trailing JSON") { try ArkProtectedStrictJSON.validate(Data("{}{}".utf8)) }
  rejects("observation parser refuses invalid UTF8") { try ArkProtectedStrictJSON.validate(Data([0xff])) }
  do {
    let data = Data("{\"schemaVersion\":1,\"operation\":\"captureNextCompletedRegisteredSlot\",\"descriptorHash\":\"\(hash)\",\"expectedOwnerRevision\":0}".utf8)
    let parsed = try ArkProtectedObservation.request(data, operation: "captureNextCompletedRegisteredSlot")
    check(parsed.0 == hash && parsed.1 == 0, "capture control carries only descriptor and actual CAS revision")
    rejects("capture control refuses caller-selected subset or slot") {
      var fields = try JSONDecoder().decode(JSONValue.self, from: data).objectValue!; fields["slotIndex"] = .number(0)
      _ = try ArkProtectedObservation.request(ArkProtectedBytes.encode(JSONValue.object(fields)), operation: "captureNextCompletedRegisteredSlot")
    }
    let empty: JSONValue = .object(["hash": .string(ArkProtectedBytes.digest(Data())), "byteLength": .number(0)])
    try ArkProtectedObservationSchema.validate(empty, named: "BlobRef")
    check(true, "actual present zero-byte file reference remains distinct from null")
    rejects("private canonical date refuses an impossible calendar day") {
      try ArkProtectedObservationSchema.validate(.string("2026-02-30T00:00:00.000Z"), named: "Utc")
    }
    rejects("private relative path refuses an empty component") {
      try ArkProtectedObservationSchema.validate(.string("slot//code.ts"), named: "RelativePath")
    }
    rejects("private blob refuses unknown member") {
      try ArkProtectedObservationSchema.validate(.object(["hash": .string(hash), "byteLength": .number(0), "path": .string("/tmp")]), named: "BlobRef")
    }
  } catch { check(false, "observation exact control contracts failed: \(error)") }
  do {
    let root = URL(fileURLWithPath: "/private/tmp/ark-observation-contract-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    defer { try? FileManager.default.removeItem(at: root) }
    let legacy = Data("{\"schemaVersion\":1,\"revision\":17,\"trials\":[],\"costEntries\":[]}".utf8)
    try legacy.write(to: root.appendingPathComponent("owner-state-v1.json")); try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: root.appendingPathComponent("owner-state-v1.json").path)
    var store: ArkProtectedStateStore? = try ArkProtectedStateStore(root: root, observationVersion: true)
    check(store?.revision == 0 && store?.trials.isEmpty == true, "v2 does not migrate or reuse v1 state")
    rejects("v1 and v2 instances share exactly one owner lock") { _ = try ArkProtectedStateStore(root: root) }
    let descriptor = ArkProtectedTrialDescriptor(grantHash: hash, preRegistrationHash: String(repeating: "b", count: 64),
      proposalHash: hash, candidateHash: hash, sourceBindingHash: hash, projectRoot: "/fixture",
      profileIdentity: "fixture", buildIdentity: hash, expiresAt: "2099-01-01T00:00:00.000Z", sessionIDs: ["baseline", "candidate"],
      fixedOracleIDs: ["single-line-v1"], operationLimits: ["sealPromotion": 0, "signKnowledgeUseJournal": 2, "verifyCandidate": 2,
        "evaluateCapturedUse": 2, "finalizeMeasuredTrial": 1, "registerProviderDispatch": 2, "recordProviderSettlement": 2, "resolveSettledUseCost": 2],
      liveCostAdmission: ArkProtectedLiveCostAdmission(admissionHash: hash, ledgerArtifactHash: hash, maximumNewDispatches: 2, maximumNewSettlements: 2))
    var trial = ArkProtectedTrialState(descriptor: descriptor, phase: "registered", reservations: [])
    trial.intentHash = hash; trial.registrationEpoch = 1; trial.inflightEpoch = 0
    trial.orderedSlotEpochs = descriptor.sessionIDs.map { .object(["sessionId": .string($0), "firstDispatchEpoch": .null]) }
    let generation = UUID().uuidString.lowercased()
    trial.collection = .object(["generationId": .string(generation), "phase": .string("collecting"), "nextSlotIndex": .number(0),
      "reservationRevision": .null, "inflightEpoch": .number(1), "orderedCaptures": .array([]), "reason": .null, "failureEvidenceHash": .null])
    try store!.replace([trial])
    let bytes = try Data(contentsOf: root.appendingPathComponent("owner-state-v2.json"))
    try ArkProtectedObservationSchema.validate(JSONDecoder().decode(JSONValue.self, from: bytes), named: "OwnerStateV2")
    let retainedLegacy = try Data(contentsOf: root.appendingPathComponent("owner-state-v1.json"))
    check(retainedLegacy == legacy, "v2 publication preserves v1 exact bytes")
    let value = try JSONDecoder().decode(JSONValue.self, from: bytes)
    check(value["trials"]?.arrayValue?.first?["admissionEpoch"] == .null && value["trials"]?.arrayValue?.first?["freeze"] == .null,
      "v2 null control fields are explicit in exact persisted schema")
    store = nil
    let restarted = try ArkProtectedStateStore(root: root, observationVersion: true)
    check(restarted.revision == 1 && restarted.trials.first?.intentHash == hash, "v2 restart retains original intent and CAS revision")
    rejects("v2 cannot silently move collected cursor without ordered capture") {
      var bad = trial.collection!.objectValue!; bad["nextSlotIndex"] = .number(1); trial.collection = .object(bad)
      try restarted.replace([trial])
    }
    let owner = ArkProtectedOwner(store: restarted, signers: ["evaluator": Curve25519.Signing.PrivateKey()],
      revalidate: { $0 }, evaluate: { _, _, _ in ArkProtectedEvaluation(canonicalBytes: Data("{}".utf8), signatureField: "proof") })
    do { try await owner.register(descriptor); check(false, "v2 refuses legacy completed registration") }
    catch { check(true, "v2 refuses legacy completed registration") }
    let snapshot = await owner.reviewSnapshot()
    let envelope = try JSONDecoder().decode(JSONValue.self, from: snapshot.encode())
    try ArkProtectedObservationSchema.validate(envelope, named: "OwnerReviewSnapshotV2")
    check(envelope["ownerRevision"] == .number(1), "App review exposes current real owner CAS revision")
    do { _ = try await owner.perform(.verifyCandidate, payload: .object(["sessionId": .string("candidate")]), origin: .offlineProducer)
      check(false, "registered v2 cannot sign through producer role")
    } catch { check(true, "registered v2 cannot sign through producer role") }
  } catch { check(false, "observation durable v2 contracts failed: \(error)") }
  do {
    let backend = BackendProcess()
    let channel = try ArkNativeOwnerChannel { _, _ in throw ArkProtectedOwnerError.rejected("Fixture has no authority") }
    let joined: BackendProcessJoinedLaunch? = try await withCheckedThrowingContinuation { continuation in
      backend.onExit = { _ in continuation.resume(returning: backend.joinedReceipt) }
      do { try backend.start(executable: "/usr/bin/true", arguments: [], environment: ["PATH": "/usr/bin:/bin"], workingDirectory: URL(fileURLWithPath: "/private/tmp"), ownerChannel: channel) }
      catch { channel.close(); continuation.resume(throwing: error) }
    }
    check(joined?.exitedNormally == true && joined?.terminationStatus == 0 && joined?.forced == false,
      "actual child receipt is available only after normal reaping and channel settlement")
    check(joined?.channelGeneration == channel.generation && joined?.generation == backend.generation && backend.isRunning == false,
      "actual child receipt retains exact launch and closed channel generation")
    let broker = ArkProtectedOwnerBroker()
    do { _ = try await broker.captureNextCompletedRegisteredSlot(descriptorHash: hash); check(false, "App broker denies absent real finite backend join") }
    catch { check(true, "App broker denies absent real finite backend join") }
    do { _ = try await broker.freezeRegisteredTrial(descriptorHash: hash); check(false, "App broker denies absent real finite guard/allslot joins") }
    catch { check(true, "App broker denies absent real finite guard/allslot joins") }
  } catch { check(false, "actual observation owned child contracts failed: \(error)") }
  check(!ArkProtectedPeerRole.offlineProducer.permits(.registerProviderDispatch) && !ArkProtectedPeerRole.offlineProducer.permits(.recordProviderSettlement),
    "offline producer role cannot dispatch or settle cost")
}
