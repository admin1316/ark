import CryptoKit
import Darwin
import Foundation
@testable import JiuzhangShellCore

private actor OwnerFixtureGate {
  private var began = false
  private var release: CheckedContinuation<Void, Never>?
  func hold() async { began = true; await withCheckedContinuation { release = $0 } }
  func hasBegun() -> Bool { began }
  func finish() { release?.resume(); release = nil }
}

private func protectedFixtureDescriptor(limit: Int = 2, expiresAt: String = "2099-01-01T00:00:00.000Z") -> ArkProtectedTrialDescriptor {
  ArkProtectedTrialDescriptor(grantHash: String(repeating: "a", count: 64),
    preRegistrationHash: String(repeating: "b", count: 64), proposalHash: String(repeating: "c", count: 64),
    candidateHash: String(repeating: "d", count: 64), sourceBindingHash: String(repeating: "e", count: 64),
    projectRoot: "/fixed-fixture", profileIdentity: "fixture-profile", buildIdentity: "fixture-build", expiresAt: expiresAt,
    sessionIDs: ["baseline", "candidate"], fixedOracleIDs: ["single-line-v1"],
    operationLimits: ["sealPromotion": limit, "signKnowledgeUseJournal": limit, "verifyCandidate": limit,
      "evaluateCapturedUse": limit, "finalizeMeasuredTrial": 1])
}

private func protectedFixtureRoot() throws -> URL {
  let root = URL(fileURLWithPath: "/private/tmp").appendingPathComponent("ark-owner-contract-\(UUID().uuidString)")
  try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
  return root
}

private func protectedFixtureBinding(_ descriptor: ArkProtectedTrialDescriptor, key: Curve25519.Signing.PrivateKey, journalKey: Curve25519.Signing.PrivateKey,
  artifactRoot: URL) -> ArkProtectedOwnerPublicBinding {
  let der = ArkProtectedOwnerPublicBinding.spkiPrefix + key.publicKey.rawRepresentation
  return ArkProtectedOwnerPublicBinding(sourceBindingHash: descriptor.sourceBindingHash,
    sourceIdentity: .object(["commit": .string(String(repeating: "a", count: 40)), "sourceDigest": .string(String(repeating: "b", count: 64)),
      "dirty": .bool(true), "dirtyDigest": .string(String(repeating: "c", count: 64)), "buildDigest": .string(String(repeating: "d", count: 64))]),
    artifactRoot: artifactRoot.path, projectRoot: descriptor.projectRoot, profileIdentity: descriptor.profileIdentity,
    buildIdentity: descriptor.buildIdentity, authorityIDs: ["evaluator": "fixture:evaluator", "promotion": "fixture:evaluator", "journal": "fixture:journal"],
    expectedPublicKeys: ["evaluator": der, "journal": ArkProtectedOwnerPublicBinding.spkiPrefix + journalKey.publicKey.rawRepresentation, "promotion": der])
}

private func protectedHandshake(_ service: ArkProtectedOwnerService, nonce: String, version: Int = 1) async -> (String?, Int, Data?) {
  await withCheckedContinuation { continuation in
    service.handshake(nonce, version: version) { continuation.resume(returning: ($0, $1, $2)) }
  }
}

@MainActor
private func ownerRejects(_ title: String, _ body: () async throws -> Void) async {
  do { try await body(); check(false, title) }
  catch { check(true, title) }
}

@MainActor
func runArkProtectedOwnerContractChecks() async {
  do {
    let root = try protectedFixtureRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let store = try ArkProtectedStateStore(root: root)
    let descriptor = protectedFixtureDescriptor()
    let key = Curve25519.Signing.PrivateKey()
    let canonical = Data("{\"kind\":\"test-only-existing-canonical-receipt\",\"value\":7}".utf8)
    let owner = ArkProtectedOwner(store: store, signers: ["evaluator": key, "promotion": key, "journal": key],
      revalidate: { value in value }, evaluate: { operation, _, _ in
        ArkProtectedEvaluation(canonicalBytes: canonical, signatureField: operation == .verifyCandidate ? "proof" : "evaluatorSignature")
      })
    try await owner.register(descriptor)
    let payload: JSONValue = .object(["sessionId": .string("candidate")])
    await ownerRejects("protected owner refuses a registered grant before native confirmation") {
      _ = try await owner.perform(.verifyCandidate, payload: payload)
    }
    let nonce = try await owner.prepareConfirmation(descriptorHash: descriptor.descriptorHash)
    await ownerRejects("wrong confirmation nonce consumes no signing permission") {
      try await owner.admit(descriptorHash: descriptor.descriptorHash, nonce: "forged")
    }
    await ownerRejects("discarded native nonce cannot subsequently be replayed") {
      try await owner.admit(descriptorHash: descriptor.descriptorHash, nonce: nonce)
    }
    let fresh = try await owner.prepareConfirmation(descriptorHash: descriptor.descriptorHash)
    try await owner.admit(descriptorHash: descriptor.descriptorHash, nonce: fresh)
    let result = try await owner.perform(.verifyCandidate, payload: payload)
    let proof = result["proof"]?.stringValue.flatMap { Data(base64Encoded: $0) }
    check(proof.map { key.publicKey.isValidSignature($0, for: canonical) } == true,
      "native owner signs exact evaluator canonical bytes after finite native admission")
    check(store.trials.first?.reservations.first?.phase == "spent", "signature is returned only after durable spent commit")
    await ownerRejects("native owner refuses duplicate completed signing request") { _ = try await owner.perform(.verifyCandidate, payload: payload) }
    await ownerRejects("native owner refuses an unregistered session") {
      _ = try await owner.perform(.verifyCandidate, payload: .object(["sessionId": .string("unregistered")]))
    }
    try await owner.revoke(descriptorHash: descriptor.descriptorHash)
    await ownerRejects("native revocation refuses future signatures") {
      _ = try await owner.perform(.verifyCandidate, payload: .object(["sessionId": .string("baseline")]))
    }
    await ownerRejects("a revoked grant cannot be readmitted") { _ = try await owner.prepareConfirmation(descriptorHash: descriptor.descriptorHash) }
    await ownerRejects("a second owner cannot open the live serialized state") { _ = try ArkProtectedStateStore(root: root) }
    await ownerRejects("expired descriptor is rejected before registration") {
      try await owner.register(protectedFixtureDescriptor(expiresAt: "2000-01-01T00:00:00.000Z"))
    }
  } catch { check(false, "protected owner positive lifecycle failed: \(error)") }

  do {
    let root = try protectedFixtureRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let store = try ArkProtectedStateStore(root: root)
    let descriptor = protectedFixtureDescriptor()
    let gate = OwnerFixtureGate()
    let key = Curve25519.Signing.PrivateKey()
    let owner = ArkProtectedOwner(store: store, signers: ["evaluator": key], revalidate: { $0 }, evaluate: { _, _, _ in
      await gate.hold()
      return ArkProtectedEvaluation(canonicalBytes: Data("{\"result\":\"pass\"}".utf8), signatureField: "proof")
    })
    try await owner.register(descriptor)
    let nonce = try await owner.prepareConfirmation(descriptorHash: descriptor.descriptorHash)
    try await owner.admit(descriptorHash: descriptor.descriptorHash, nonce: nonce)
    let payload: JSONValue = .object(["sessionId": .string("candidate")])
    let pending = Task { try await owner.perform(.verifyCandidate, payload: payload) }
    while !(await gate.hasBegun()) { await Task.yield() }
    check(store.trials.first?.reservations.first?.phase == "reserved", "owner persists reservation before awaiting independent oracle")
    await ownerRejects("concurrent identical request cannot race pre-sign reservation") { _ = try await owner.perform(.verifyCandidate, payload: payload) }
    try await owner.revoke(descriptorHash: descriptor.descriptorHash)
    await gate.finish()
    await ownerRejects("revocation during oracle execution prevents releasing a signature") { _ = try await pending.value }
    check(store.trials.first?.reservations.first?.phase == "revoked", "revoked in-flight reservation remains in durable history")
  } catch { check(false, "protected concurrent revocation failed: \(error)") }

  do {
    let root = try protectedFixtureRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let descriptor = protectedFixtureDescriptor()
    let gate = OwnerFixtureGate()
    let key = Curve25519.Signing.PrivateKey()
    var store: ArkProtectedStateStore? = try ArkProtectedStateStore(root: root)
    var owner: ArkProtectedOwner? = ArkProtectedOwner(store: store!, signers: ["evaluator": key], revalidate: { $0 }, evaluate: { _, _, _ in
      await gate.hold()
      return ArkProtectedEvaluation(canonicalBytes: Data("{\"result\":\"pass\"}".utf8), signatureField: "proof")
    })
    try await owner!.register(descriptor)
    let nonce = try await owner!.prepareConfirmation(descriptorHash: descriptor.descriptorHash)
    try await owner!.admit(descriptorHash: descriptor.descriptorHash, nonce: nonce)
    let activeOwner = owner!
    let pending = Task { try await activeOwner.perform(.verifyCandidate, payload: .object(["sessionId": .string("candidate")])) }
    while !(await gate.hasBegun()) { await Task.yield() }
    pending.cancel(); await gate.finish()
    await ownerRejects("cancelled oracle result cannot be signed") { _ = try await pending.value }
    check(store!.trials.first?.reservations.first?.phase == "reserved", "cancellation leaves uncertain reservation spent against the finite limit")
    // Copy the persisted state into a fresh private root to simulate a new owner
    // without weakening the original owner's process lock.
    let restartRoot = try protectedFixtureRoot()
    defer { try? FileManager.default.removeItem(at: restartRoot) }
    try FileManager.default.copyItem(at: root.appendingPathComponent("owner-state-v1.json"), to: restartRoot.appendingPathComponent("owner-state-v1.json"))
    let restartedStore = try ArkProtectedStateStore(root: restartRoot)
    let restarted = ArkProtectedOwner(store: restartedStore, signers: ["evaluator": key], revalidate: { $0 }, evaluate: { _, _, _ in
      ArkProtectedEvaluation(canonicalBytes: Data("{}".utf8), signatureField: "proof")
    })
    await ownerRejects("restart does not refund or release an uncertain reservation") {
      _ = try await restarted.perform(.verifyCandidate, payload: .object(["sessionId": .string("candidate")]))
    }
    owner = nil; store = nil
  } catch { check(false, "protected cancellation/restart failed: \(error)") }

  do {
    let root = try protectedFixtureRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let store = try ArkProtectedStateStore(root: root)
    let descriptor = protectedFixtureDescriptor()
    let owner = ArkProtectedOwner(store: store, signers: [:], revalidate: { $0 }, evaluate: { _, _, _ in
      throw ArkProtectedOwnerError.rejected("must not execute")
    })
    try await owner.register(descriptor)
    let nonce = try await owner.prepareConfirmation(descriptorHash: descriptor.descriptorHash)
    try await owner.admit(descriptorHash: descriptor.descriptorHash, nonce: nonce)
    await ownerRejects("missing real authority never falls back to a fixture key") { _ = try await owner.perform(.verifyCandidate, payload: .object([:])) }
    let path = root.appendingPathComponent("owner-state-v1.json")
    try Data("{}".utf8).write(to: path)
    await ownerRejects("external owner state mutation fails CAS before further writes") { try await owner.revoke(descriptorHash: descriptor.descriptorHash) }
  } catch { check(false, "protected state CAS failed: \(error)") }

  do {
    let root = try protectedFixtureRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let target = root.appendingPathComponent("foreign.json")
    try Data("{}".utf8).write(to: target)
    try FileManager.default.createSymbolicLink(atPath: root.appendingPathComponent("owner-state-v1.json").path, withDestinationPath: target.path)
    await ownerRejects("owner state refuses a symlink instead of following it") { _ = try ArkProtectedStateStore(root: root) }
  } catch { check(false, "protected no-follow setup failed: \(error)") }

  do {
    let root = try protectedFixtureRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let store = try ArkProtectedStateStore(root: root)
    let descriptor = protectedFixtureDescriptor()
    let gate = OwnerFixtureGate()
    let key = Curve25519.Signing.PrivateKey(), journalKey = Curve25519.Signing.PrivateKey()
    let owner = ArkProtectedOwner(store: store, signers: ["evaluator": key, "journal": journalKey, "promotion": key], revalidate: { $0 }, evaluate: { _, _, _ in
      await gate.hold()
      return ArkProtectedEvaluation(canonicalBytes: Data("{}".utf8), signatureField: "proof")
    }, publicBinding: protectedFixtureBinding(descriptor, key: key, journalKey: journalKey, artifactRoot: root))
    try await owner.register(descriptor)
    let nonce = try await owner.prepareConfirmation(descriptorHash: descriptor.descriptorHash)
    try await owner.admit(descriptorHash: descriptor.descriptorHash, nonce: nonce)
    let service = ArkProtectedOwnerService(owner: owner)
    _ = await protectedHandshake(service, nonce: String(repeating: "s", count: 64))
    var businessSettled = false
    service.perform("owned", operation: "verifyCandidate", origin: "backend", payload: Data("{\"sessionId\":\"candidate\"}".utf8)) { data, _ in
      businessSettled = data == nil
    }
    while !(await gate.hasBegun()) { await Task.yield() }
    var shutdownSettled = false
    service.shutdown { shutdownSettled = true }
    try await Task.sleep(nanoseconds: 30_000_000)
    check(!shutdownSettled, "XPC shutdown waits for the cancelled evaluator instead of acknowledging cancellation alone")
    var lateBusinessRefused = false
    service.perform("after-shutdown", operation: "verifyCandidate", origin: "backend", payload: Data("{}".utf8)) { data, error in
      lateBusinessRefused = data == nil && error != nil
    }
    check(lateBusinessRefused, "closed service refuses a concurrent business registration while shutdown joins its prior task")
    let confirmationRefused = await withCheckedContinuation { continuation in
      service.prepareConfirmation(descriptor.descriptorHash) { nonce, error in continuation.resume(returning: nonce == nil && error != nil) }
    }
    check(confirmationRefused, "closed service refuses confirmation control while shutdown joins")
    await gate.finish()
    let deadline = Date().addingTimeInterval(2)
    while !shutdownSettled && Date() < deadline { await Task.yield() }
    check(shutdownSettled && businessSettled, "XPC shutdown acknowledges only after owned business has settled without a signature")
  } catch { check(false, "XPC shutdown contract failed: \(error)") }

  await runArkProtectedReadyBridgeContractChecks()

  let service = ArkProtectedOwnerService()
  var beforeHandshake = false
  service.perform("pre", operation: "verifyCandidate", origin: "backend", payload: Data("{}".utf8)) { data, _ in beforeHandshake = data == nil }
  check(beforeHandshake, "XPC typed handler refuses business before version/nonce bootstrap")
  let wrong = await protectedHandshake(service, nonce: String(repeating: "n", count: 64), version: 2)
  let wrongVersion = wrong.0 == nil && wrong.1 == 0
  check(wrongVersion, "XPC bootstrap rejects an unsupported protocol version")
  let handshake = await protectedHandshake(service, nonce: String(repeating: "n", count: 64))
  let accepted = handshake.0 == String(repeating: "n", count: 64) && handshake.1 == 1
    && handshake.2.flatMap { try? ArkProtectedOwnerPublicBinding.validateHello($0) } == ArkProtectedOwnerPublicBinding.disabledHello
  check(accepted, "XPC bootstrap echoes only the exact supported nonce/version")
  var disabled = false
  service.perform("disabled", operation: "verifyCandidate", origin: "backend", payload: Data("{}".utf8)) { data, error in disabled = data == nil && error != nil }
  check(disabled, "embedded service with no authority remains explicitly disabled after successful bootstrap")
  check(ArkProtectedOperation(rawValue: "admit") == nil && ArkProtectedOperation(rawValue: "signBytes") == nil,
    "Node closed operation vocabulary exposes neither admission nor arbitrary-byte signing")
}


final class ReadyBridgePeer: NSObject, ArkProtectedOwnerProtocol, @unchecked Sendable {
  let service: ArkProtectedOwnerService
  let delayed: Bool
  let malformed: Bool
  private let lock = NSLock()
  private var pendingHello: (() -> Void)?
  private var handshakeCountValue = 0
  init(owner: ArkProtectedOwner?, delayed: Bool, malformed: Bool) {
    service = ArkProtectedOwnerService(owner: owner); self.delayed = delayed; self.malformed = malformed
  }
  var handshakeCount: Int { lock.withLock { handshakeCountValue } }
  func handshake(_ nonce: String, version: Int, reply: @escaping (String?, Int, Data?) -> Void) {
    lock.withLock { handshakeCountValue += 1 }
    service.handshake(nonce, version: version) { received, version, bytes in
      let settle = { reply(received, version, self.malformed ? Data("{\"ownerStatus\":\"ready\"}".utf8) : bytes) }
      if self.delayed { self.lock.withLock { self.pendingHello = settle } } else { settle() }
    }
  }
  func releaseHello() { let callback = lock.withLock { let value = pendingHello; pendingHello = nil; return value }; callback?() }
  func perform(_ id: String, operation: String, origin: String, payload: Data, reply: @escaping (Data?, String?) -> Void) {
    service.perform(id, operation: operation, origin: origin, payload: payload, reply: reply)
  }
  func shutdown(_ reply: @escaping () -> Void) { service.shutdown(reply) }
  func cancel(_ id: String) { service.cancel(id) }
  func captureNextCompletedRegisteredSlot(_ request: Data, reply: @escaping (Data?, String?) -> Void) { service.captureNextCompletedRegisteredSlot(request, reply: reply) }
  func freezeRegisteredTrial(_ request: Data, reply: @escaping (Data?, String?) -> Void) { service.freezeRegisteredTrial(request, reply: reply) }
  func descriptors(_ reply: @escaping (Data?, String?) -> Void) { service.descriptors(reply) }
  func prepareConfirmation(_ hash: String, reply: @escaping (String?, String?) -> Void) { service.prepareConfirmation(hash, reply: reply) }
  func admit(_ hash: String, nonce: String, reply: @escaping (Bool, String?) -> Void) { service.admit(hash, nonce: nonce, reply: reply) }
  func revoke(_ hash: String, reply: @escaping (Bool, String?) -> Void) { service.revoke(hash, reply: reply) }
}

final class ReadyBridgeListener: NSObject, NSXPCListenerDelegate, @unchecked Sendable {
  let listener = NSXPCListener.anonymous()
  let owner: ArkProtectedOwner?
  let requirement: String
  let delayed: Bool
  let malformed: Bool
  private let lock = NSLock()
  private var peersValue = [ReadyBridgePeer]()
  var peers: [ReadyBridgePeer] { lock.withLock { peersValue } }
  init(owner: ArkProtectedOwner?, delayed: Bool = false, malformed: Bool = false) throws {
    self.owner = owner; self.delayed = delayed; self.malformed = malformed
    requirement = try ArkProtectedPeerRequirement.requirement(for: Bundle.main.executableURL!)
    super.init(); listener.delegate = self; listener.resume()
  }
  func listener(_ listener: NSXPCListener, shouldAcceptNewConnection connection: NSXPCConnection) -> Bool {
    connection.setCodeSigningRequirement(requirement)
    let peer = ReadyBridgePeer(owner: owner, delayed: delayed, malformed: malformed)
    lock.withLock { peersValue.append(peer) }
    connection.exportedInterface = NSXPCInterface(with: ArkProtectedOwnerProtocol.self)
    connection.exportedObject = peer
    connection.invalidationHandler = { peer.service.disconnect() }
    connection.resume(); return true
  }
}

@MainActor
private func runArkProtectedReadyBridgeContractChecks() async {
  do {
    let root = try protectedFixtureRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let key = Curve25519.Signing.PrivateKey(), journalKey = Curve25519.Signing.PrivateKey(), descriptor = protectedFixtureDescriptor()
    let binding = protectedFixtureBinding(descriptor, key: key, journalKey: journalKey, artifactRoot: root)
    let store = try ArkProtectedStateStore(root: root)
    let owner = ArkProtectedOwner(store: store, signers: ["evaluator": key, "promotion": key, "journal": journalKey],
      revalidate: { $0 }, evaluate: { _, payload, _ in
        ArkProtectedEvaluation(canonicalBytes: try ArkProtectedBytes.encode(payload), signatureField: "journalSignerSignature")
      }, publicBinding: binding)
    try await owner.register(descriptor)
    let hello = try await owner.launchHello()
    check(hello["ownerStatus"] == .string("ready") && hello["authorities"]?.arrayValue?.count == 3,
      "ready metadata derives exactly three actual Native public roles and permits legacy role reuse")
    let publicKeyRows = hello["authorities"]!.arrayValue!
    check(publicKeyRows.allSatisfy { row in
      let pem = row["publicKeySpki"]!.stringValue!
      let body = pem.replacingOccurrences(of: "-----BEGIN PUBLIC KEY-----", with: "")
        .replacingOccurrences(of: "-----END PUBLIC KEY-----", with: "").components(separatedBy: .whitespacesAndNewlines).joined()
      return Data(base64Encoded: body)?.dropFirst(12) == (row["role"] == .string("journal") ? journalKey : key).publicKey.rawRepresentation
    },
      "Native public metadata uses public SPKI rather than serializing a private key")
    let config = root.appendingPathComponent("public-config.json")
    let configValue: JSONValue = .object(["schemaVersion": .number(1), "sourceBindingHash": .string(descriptor.sourceBindingHash),
      "authorityId": .string("fixture:evaluator"), "promotionAuthorityId": .string("fixture:evaluator"),
      "journalAuthorityId": .string("fixture:journal"), "evaluatorPublicKeySpki": .string(binding.expectedPublicKeys["evaluator"]!.base64EncodedString()),
      "journalPublicKeySpki": .string(binding.expectedPublicKeys["journal"]!.base64EncodedString()), "artifactRoot": .string(root.path),
      "registrations": .array([.object(["binding": .object(["sourceIdentity": binding.sourceIdentity,
        "projectRoot": .string(descriptor.projectRoot), "profileIdentity": .string(descriptor.profileIdentity), "buildIdentity": .string(descriptor.buildIdentity)])])])])
    let configBytes = try ArkProtectedBytes.encode(configValue)
    try configBytes.write(to: config)
    let metadataEvaluator = ArkProtectedEvaluator(configuration: ArkProtectedEvaluatorConfiguration(nodeExecutable: URL(fileURLWithPath: "/usr/bin/false"),
      entryPoint: URL(fileURLWithPath: "/metadata-only-no-execution"), configuration: config, workingDirectory: root,
      fileDigests: [config: ArkProtectedBytes.digest(configBytes)], sourceBindingHash: descriptor.sourceBindingHash))
    let captured = try metadataEvaluator.publicBinding()
    check(captured.authorityIDs == binding.authorityIDs && captured.sourceIdentity == binding.sourceIdentity,
      "public metadata reader captures the existing pinned config fields without executing a utility or loading keys")
    try (configBytes + Data("\n".utf8)).write(to: config)
    await ownerRejects("metadata reader refuses changed configuration against the original supplied pin") { _ = try metadataEvaluator.publicBinding() }
    try configBytes.write(to: config)
    let listener = try ReadyBridgeListener(owner: owner)
    defer { listener.listener.invalidate() }
    let broker = ArkProtectedOwnerBroker(listenerEndpoint: listener.listener.endpoint, peerRequirement: listener.requirement)
    async let first = broker.launchHello()
    async let second = broker.launchHello()
    let results = try await (first, second)
    check(results.0 == hello && results.1 == hello && listener.peers.count == 1 && listener.peers[0].handshakeCount == 1,
      "concurrent authenticated broker consumers share one bootstrap generation and its exact public identity")
    await ownerRejects("ready public identity never admits a grant by itself") {
      _ = try await broker.perform(.signKnowledgeUseJournal, payload: .object(["sessionId": .string("candidate")]))
    }
    try await broker.admit(descriptor)
    let payload: JSONValue = .object(["sessionId": .string("candidate"), "kind": .string("test-only-identity-bridge")])
    let signed = try await broker.perform(.signKnowledgeUseJournal, payload: payload)
    let canonical = try ArkProtectedBytes.encode(payload)
    check(signed["signature"]?.stringValue.flatMap { Data(base64Encoded: $0) }.map {
      journalKey.publicKey.isValidSignature($0, for: canonical)
    } == true, "actual XPC broker signs exact synthetic canonical bytes only after local finite admission")
    let nodeSource = root.appendingPathComponent("ready-consumer.mjs")
    let repository = contractNativeRoot.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    let channelModule = repository.appendingPathComponent("packages/bundle/native-api-app/src/native-owner-channel.ts").absoluteString
    let providersModule = repository.appendingPathComponent("packages/bundle/native-api-app/src/native-owner-providers.ts").absoluteString
    let moduleLiteral = { (value: String) throws in String(decoding: try JSONEncoder().encode(value), as: UTF8.self) }
    let program = """
      import assert from 'node:assert/strict';
      const { connectNativeKnowledgeOwner, nativeKnowledgeOwnerEndpointFromEnvironment } = await import(\(try moduleLiteral(channelModule)));
      const { createNativeKnowledgeOwnerProviders } = await import(\(try moduleLiteral(providersModule)));
      const connected = await connectNativeKnowledgeOwner(nativeKnowledgeOwnerEndpointFromEnvironment(process.env));
      assert.equal(connected.status, 'ready');
      const providers = createNativeKnowledgeOwnerProviders(connected.channel);
      assert.equal(providers.journalAuthority.authorityId, 'fixture:journal');
      const request = {schemaVersion:1,kind:'knowledge-use-journal-v1',useFactsHash:'f'.repeat(64),journalArtifactHash:'0'.repeat(64),journalSignerAuthorityId:'fixture:journal'};
      const signature = await providers.journalAuthority.signKnowledgeUseJournal(request, new AbortController().signal);
      assert.equal(signature.length, 64);
      await assert.rejects(providers.journalAuthority.signKnowledgeUseJournal(request, new AbortController().signal));
      await connected.channel.close();
      console.log(JSON.stringify({status:'pass',sourceConsumer:true,nativeJournalSignatureVerified:true,duplicateRefused:true,utilityMetricsProven:false}));
      """
    try Data(program.utf8).write(to: nodeSource)
    let channel = try ArkNativeOwnerChannel(helloProvider: { try await broker.launchHello() }) { operation, payload in
      try await broker.perform(operation, payload: payload)
    }
    let process = Process(), stdout = Pipe(), stderr = Pipe()
    let node = ProcessInfo.processInfo.environment["ARK_TEST_NODE_EXECUTABLE"]
      ?? (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":").map { String($0) + "/node" }.first { FileManager.default.isExecutableFile(atPath: $0) }
    guard let node else { throw ArkProtectedOwnerError.rejected("Source consumer fixture requires Node on PATH") }
    process.executableURL = URL(fileURLWithPath: node)
    process.arguments = ["--import", repository.appendingPathComponent("node_modules/tsx/dist/loader.mjs").path, nodeSource.path]
    process.environment = channel.environment.merging(["PATH": "/usr/bin:/bin", "LANG": "en_US.UTF-8",
      "TSX_TSCONFIG_PATH": repository.appendingPathComponent("tsconfig.base.json").path]) { _, new in new }
    process.standardOutput = stdout; process.standardError = stderr
    try process.run(); channel.bindLauncher(process)
    let nodeDeadline = Date().addingTimeInterval(20)
    while process.isRunning && Date() < nodeDeadline { try await Task.sleep(nanoseconds: 10_000_000) }
    if process.isRunning {
      process.terminate()
      let terminationDeadline = Date().addingTimeInterval(2)
      while process.isRunning && Date() < terminationDeadline { try await Task.sleep(nanoseconds: 10_000_000) }
      if process.isRunning { Darwin.kill(process.processIdentifier, SIGKILL) }
    }
    process.waitUntilExit()
    await withCheckedContinuation { continuation in channel.close { continuation.resume() } }
    let output = String(decoding: stdout.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
    let errors = String(decoding: stderr.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
    check(process.terminationStatus == 0 && output.contains("nativeJournalSignatureVerified"),
      "existing Node ready consumer validates the actual Native/XPC journal signature and duplicate refusal")
    print("READY_BRIDGE_NODE status=\(process.terminationStatus) output=\(output) errors=\(errors)")
    try await broker.closeAndWait()
    let reconnected = try await broker.launchHello()
    check(reconnected == hello && listener.peers.count == 2,
      "reconnect joins the old bootstrap and authenticates a fresh generation")
    try await broker.revoke(descriptor)
    await ownerRejects("reconnected owner preserves revocation instead of releasing a fresh grant") {
      _ = try await broker.perform(.signKnowledgeUseJournal, payload: .object(["sessionId": .string("candidate"), "value": .number(2)]))
    }
    try await broker.closeAndWait()

    let delayed = try ReadyBridgeListener(owner: owner, delayed: true)
    defer { delayed.listener.invalidate() }
    let cancelledBroker = ArkProtectedOwnerBroker(listenerEndpoint: delayed.listener.endpoint, peerRequirement: delayed.requirement)
    let pending = Task { try await cancelledBroker.launchHello() }
    let deadline = Date().addingTimeInterval(2)
    while delayed.peers.first?.handshakeCount != 1 && Date() < deadline { try await Task.sleep(nanoseconds: 10_000_000) }
    try await cancelledBroker.closeAndWait()
    await ownerRejects("close cancels and joins an in-flight public bootstrap") { _ = try await pending.value }
    delayed.peers.forEach { $0.releaseHello() }
    try await Task.sleep(nanoseconds: 20_000_000)
    check(delayed.peers.count == 1, "late public metadata cannot establish another generation after close")

    let malformed = try ReadyBridgeListener(owner: owner, malformed: true)
    defer { malformed.listener.invalidate() }
    let invalidBroker = ArkProtectedOwnerBroker(listenerEndpoint: malformed.listener.endpoint, peerRequirement: malformed.requirement)
    await ownerRejects("present malformed XPC metadata fails instead of silently becoming ready") { _ = try await invalidBroker.launchHello() }
    try await invalidBroker.closeAndWait()
    let disabledListener = try ReadyBridgeListener(owner: nil)
    defer { disabledListener.listener.invalidate() }
    let disabledBroker = ArkProtectedOwnerBroker(listenerEndpoint: disabledListener.listener.endpoint, peerRequirement: disabledListener.requirement)
    let disabledHello = try await disabledBroker.launchHello()
    check(disabledHello == ArkProtectedOwnerPublicBinding.disabledHello,
      "actual nil-owner XPC service transports an explicit disabled identity")
    try await disabledBroker.closeAndWait()

    let wrongRoot = try protectedFixtureRoot()
    defer { try? FileManager.default.removeItem(at: wrongRoot) }
    let mismatch = ArkProtectedOwner(store: try ArkProtectedStateStore(root: wrongRoot),
      signers: ["evaluator": Curve25519.Signing.PrivateKey(), "journal": key, "promotion": key],
      revalidate: { $0 }, evaluate: { _, _, _ in ArkProtectedEvaluation(canonicalBytes: Data("{}".utf8), signatureField: "proof") },
      publicBinding: binding)
    await ownerRejects("public binding refuses a signer different from its pinned evaluator key before registration") { try await mismatch.register(descriptor) }
  } catch { check(false, "ready public bridge contract failed: \(error)") }
}
