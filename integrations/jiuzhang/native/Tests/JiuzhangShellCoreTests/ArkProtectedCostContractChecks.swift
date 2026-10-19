import Foundation
import JiuzhangShellCore

private actor CostFixtureGate {
  private var armed = false
  private var began = false
  private var continuation: CheckedContinuation<Void, Never>?
  func arm() { armed = true }
  func holdIfArmed() async { if armed { began = true; await withCheckedContinuation { continuation = $0 } } }
  func hasBegun() -> Bool { began }
  func finish() { continuation?.resume(); continuation = nil }
}

@MainActor
func runArkProtectedCostContractChecks() async {
  do {
    let root = URL(fileURLWithPath: "/private/tmp").appendingPathComponent("ark-cost-contract-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    defer { try? FileManager.default.removeItem(at: root) }
    let ledger = Data("{\"schema\":2,\"budgetMicroCny\":5000000,\"maxRequests\":32,\"requestCount\":3,\"settledUpperBoundMicroCny\":100,\"pending\":[]}".utf8)
    let ledgerURL = root.appendingPathComponent("existing-ledger.json")
    try ledger.write(to: ledgerURL)
    let store = try ArkProtectedStateStore(root: root)
    let digest = String(repeating: "a", count: 64)
    let snapshot = String(repeating: "b", count: 64)
    let descriptor = ArkProtectedTrialDescriptor(grantHash: digest, preRegistrationHash: digest, proposalHash: digest,
      candidateHash: digest, sourceBindingHash: digest, projectRoot: root.path, profileIdentity: "fixture", buildIdentity: "fixture",
      expiresAt: "2099-01-01T00:00:00.000Z", sessionIDs: ["registered"], fixedOracleIDs: ["single-line-v1"],
      operationLimits: ["registerProviderDispatch": 2, "recordProviderSettlement": 2, "resolveSettledUseCost": 2],
      liveCostAdmission: ArkProtectedLiveCostAdmission(admissionHash: digest, ledgerArtifactHash: ArkProtectedBytes.digest(ledger),
        maximumNewDispatches: 2, maximumNewSettlements: 2))
    let costOwner = try ArkProtectedCostOwner(store: store, configuration: ArkProtectedCostConfiguration(ledgerPath: ledgerURL,
      initialLedgerHash: ArkProtectedBytes.digest(ledger), endpoint: "http://127.0.0.1:9/chat/completions", provider: "deepseek",
      configuredModel: "fixture-model", wireModel: "fixture-model", maximumNewDispatches: 2, sourceBindingHash: digest)) { session, hash in
        guard session == "registered", hash == snapshot else { throw ArkProtectedOwnerError.rejected("wrong persisted capture") }
        return .object(["sessionIdHash": .string(ArkProtectedCostOwner.sessionHash(session)),
          "sessionSnapshotHash": .string(hash), "capturedRequestHashes": .array([.string(digest)])])
      }
    let owner = ArkProtectedOwner(store: store, signers: [:], revalidate: { $0 }, evaluate: { _, _, _ in
      throw ArkProtectedOwnerError.rejected("Cost fixture cannot sign")
    }, costOwner: costOwner)
    try await owner.register(descriptor)
    let nonce = try await owner.prepareConfirmation(descriptorHash: descriptor.descriptorHash)
    try await owner.admit(descriptorHash: descriptor.descriptorHash, nonce: nonce)
    let registration: JSONValue = .object(["schemaVersion": .number(1), "kind": .string("adapter"), "sessionId": .string("registered"),
      "endpoint": .string("http://127.0.0.1:9/chat/completions"), "provider": .string("deepseek"),
      "configuredModel": .string("fixture-model"), "wireModel": .string("fixture-model"),
      "requestBodyHash": .string(digest), "capturedRequestHash": .string(digest), "maxTokens": .number(8192)])
    var drift = registration.objectValue!
    drift["endpoint"] = .string("https://direct.example/chat/completions")
    do { _ = try await owner.perform(.registerProviderDispatch, payload: .object(drift))
      check(false, "registered route drift is refused instead of escaping as untracked")
    } catch { check(true, "registered route drift is refused instead of escaping as untracked") }
    let registered = try await owner.perform(.registerProviderDispatch, payload: registration, origin: .backend)
    guard let dispatch = registered["dispatchId"]?.stringValue else { throw ArkProtectedOwnerError.rejected("fixture dispatch missing") }
    var ingress: [String: JSONValue] = ["schemaVersion": .number(1), "dispatchId": .string(dispatch), "attemptId": .string("attempt-1"),
      "sessionIdHash": .string(ArkProtectedCostOwner.sessionHash("registered")), "requestBodyHash": .string(digest), "maxTokens": .number(8192)]
    do { _ = try await owner.perform(.admitProviderRequest, payload: .object(ingress), origin: .backend)
      check(false, "backend cannot impersonate a guard by claiming an attempt")
    } catch { check(true, "backend cannot impersonate a guard by claiming an attempt") }
    let admitted = try await owner.perform(.admitProviderRequest, payload: .object(ingress), origin: .guardProcess)
    check(admitted["status"] == .string("matched"), "authenticated guard ingress matches exact adapter bytes/session/output cap")
    let request: JSONValue = .object(["schemaVersion": .number(1), "operation": .string("resolve-settled-use-cost-v1"),
      "sessionId": .string("registered"), "sessionSnapshotHash": .string(snapshot), "capturedRequestHashes": .array([.string(digest)])])
    let pending = try await owner.perform(.resolveSettledUseCost, payload: request, origin: .backend)
    check(pending["status"] == .string("unknown"), "observed ingress without complete settlement remains unknown")
    ingress.merge(["inputTokens": .number(100), "outputTokens": .number(20), "upperBoundMicroCny": .number(360),
      "responseIdHash": .string(digest), "responseModel": .string("fixture-model"), "finishReason": .string("stop"),
      "settledAt": .string("2026-10-13T00:00:00.000Z")]) { _, new in new }
    do { _ = try await owner.perform(.recordProviderSettlement, payload: .object(ingress), origin: .backend)
      check(false, "Node backend cannot forge guard usage settlement")
    } catch { check(true, "Node backend cannot forge guard usage settlement") }
    let settled = try await owner.perform(.recordProviderSettlement, payload: .object(ingress), origin: .guardProcess)
    check(settled["status"] == .string("recorded"), "guard settlement records complete usage at the existing conservative prices")
    let result = try await owner.perform(.resolveSettledUseCost, payload: request, origin: .backend)
    guard let encoded = result["artifactBytesBase64"]?.stringValue, let bytes = Data(base64Encoded: encoded) else {
      throw ArkProtectedOwnerError.rejected("verified cost fixture produced no artifact")
    }
    let witness = try JSONDecoder().decode(JSONValue.self, from: bytes)
    check(result["status"] == .string("verified") && witness["totalUpperBoundMicrounits"] == .number(360)
      && result["artifactHash"] == .string(ArkProtectedBytes.digest(bytes)),
      "cost resolver sums only the complete independently recaptured request set")
    let ledgerAfter = try Data(contentsOf: ledgerURL)
    check(ledgerAfter == ledger, "private evidence never rewrites or resets the schema-2 budget ledger")
    do { _ = try await owner.perform(.recordProviderSettlement, payload: .object(ingress), origin: .guardProcess)
      check(false, "duplicate settlement cannot replace retained evidence")
    } catch { check(true, "duplicate settlement cannot replace retained evidence") }
    _ = try await owner.perform(.registerProviderDispatch, payload: registration, origin: .backend)
    let ambiguous = try await owner.perform(.resolveSettledUseCost, payload: request, origin: .backend)
    check(ambiguous["status"] == .string("unknown"), "extra dispatch or unattributed retry prevents complete cost witness")
    check(store.trials.first?.reservations.isEmpty == true, "cost evidence registration and settlement never consume a trial signature")
    var ordinary = registration.objectValue!
    ordinary["sessionId"] = .string("ordinary-conversation")
    let untracked = try await owner.perform(.registerProviderDispatch, payload: .object(ordinary))
    check(untracked["status"] == .string("untracked"), "full owner allows ordinary unregistered conversations as untracked")
    try await owner.revoke(descriptorHash: descriptor.descriptorHash)
    do { _ = try await owner.perform(.registerProviderDispatch, payload: registration)
      check(false, "revoked registered session cannot escape into untracked dispatch")
    } catch { check(true, "revoked registered session cannot escape into untracked dispatch") }
  } catch { check(false, "protected cost fixture failed: \(error)") }
  for mode in ["revalidation", "capture", "cancel"] {
    do {
      let root = URL(fileURLWithPath: "/private/tmp").appendingPathComponent("ark-cost-race-\(UUID().uuidString)")
      try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
      defer { try? FileManager.default.removeItem(at: root) }
      let store = try ArkProtectedStateStore(root: root)
      let digest = String(repeating: "a", count: 64)
      let ledger = Data("{\"schema\":2,\"budgetMicroCny\":5000000,\"maxRequests\":32,\"requestCount\":0,\"settledUpperBoundMicroCny\":0,\"pending\":[]}".utf8)
      let ledgerURL = root.appendingPathComponent("ledger.json"); try ledger.write(to: ledgerURL)
      let descriptor = ArkProtectedTrialDescriptor(grantHash: digest, preRegistrationHash: digest, proposalHash: digest,
        candidateHash: digest, sourceBindingHash: digest, projectRoot: root.path, profileIdentity: "fixture", buildIdentity: "fixture",
        expiresAt: "2099-01-01T00:00:00.000Z", sessionIDs: ["registered"], fixedOracleIDs: ["single-line-v1"],
        operationLimits: ["registerProviderDispatch": 1, "recordProviderSettlement": 1, "resolveSettledUseCost": 1],
        liveCostAdmission: ArkProtectedLiveCostAdmission(admissionHash: digest, ledgerArtifactHash: ArkProtectedBytes.digest(ledger),
          maximumNewDispatches: 1, maximumNewSettlements: 1))
      let gate = CostFixtureGate()
      let cost = try ArkProtectedCostOwner(store: store, configuration: ArkProtectedCostConfiguration(ledgerPath: ledgerURL,
        initialLedgerHash: ArkProtectedBytes.digest(ledger), endpoint: "http://127.0.0.1:9/chat/completions", provider: "deepseek",
        configuredModel: "fixture", wireModel: "fixture", maximumNewDispatches: 1, sourceBindingHash: digest)) { _, _ in
          await gate.holdIfArmed()
          return .object(["sessionIdHash": .string(ArkProtectedCostOwner.sessionHash("registered")),
            "sessionSnapshotHash": .string(digest), "capturedRequestHashes": .array([.string(digest)])])
        }
      let owner = ArkProtectedOwner(store: store, signers: [:], revalidate: { descriptor in
        if mode != "capture" { await gate.holdIfArmed() }; return descriptor
      }, evaluate: { _, _, _ in throw ArkProtectedOwnerError.rejected("no fixture signing") }, costOwner: cost)
      try await owner.register(descriptor)
      let nonce = try await owner.prepareConfirmation(descriptorHash: descriptor.descriptorHash)
      try await owner.admit(descriptorHash: descriptor.descriptorHash, nonce: nonce)
      await gate.arm()
      let payload: JSONValue = mode == "capture"
        ? .object(["schemaVersion": .number(1), "operation": .string("resolve-settled-use-cost-v1"), "sessionId": .string("registered"),
          "sessionSnapshotHash": .string(digest), "capturedRequestHashes": .array([.string(digest)])])
        : .object(["schemaVersion": .number(1), "kind": .string("adapter"), "sessionId": .string("registered"),
          "endpoint": .string("http://127.0.0.1:9/chat/completions"), "provider": .string("deepseek"),
          "configuredModel": .string("fixture"), "wireModel": .string("fixture"), "requestBodyHash": .string(digest),
          "capturedRequestHash": .string(digest), "maxTokens": .number(8192)])
      let pending = Task { try await owner.perform(mode == "capture" ? .resolveSettledUseCost : .registerProviderDispatch, payload: payload) }
      while !(await gate.hasBegun()) { await Task.yield() }
      if mode == "cancel" { pending.cancel() } else { try await owner.revoke(descriptorHash: descriptor.descriptorHash) }
      await gate.finish()
      do { _ = try await pending.value; check(false, "full owner refuses late cost \(mode) after revoke or cancellation") }
      catch { check(true, "full owner refuses late cost \(mode) after revoke or cancellation") }
      check(store.costEntries.isEmpty, "cost \(mode) cannot mutate evidence after authorization is withdrawn")
    } catch { check(false, "full cost owner \(mode) race fixture failed: \(error)") }
  }
}
