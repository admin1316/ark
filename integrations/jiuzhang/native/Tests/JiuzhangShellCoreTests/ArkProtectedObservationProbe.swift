import CryptoKit
import Darwin
import Foundation
@testable import JiuzhangShellCore

/// Uses fresh ephemeral authorities and source fixture model observations. Real
/// task writes/tests, pinned helper launches, XPC and process joins are separate
/// evidence from provider usage; this probe makes no paid-provider utility claim.
@MainActor
func runArkProtectedObservationProbe(_ arguments: [String]) async -> Int32 {
  let guardProcess = ArkProtectedGuardProcess()
  let backend = BackendProcess()
  backend.onLine = { print("OBSERVATION_TASK: " + $0) }
  var broker: ArkProtectedOwnerBroker?
  var keyPath: String?
  var temporary: URL?
  var preAdmissionNativeCallbacks = 0
  do {
    guard arguments.count == 5, ["none", "zstd"].contains(arguments[4]) else {
      throw ArkProtectedOwnerError.rejected("observation probe needs node, compiled runtime, source repository, output root, encoding")
    }
    let node = URL(fileURLWithPath: arguments[0]), runtime = URL(fileURLWithPath: arguments[1])
    let repository = URL(fileURLWithPath: arguments[2]), output = URL(fileURLWithPath: arguments[3])
    try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let temp = URL(fileURLWithPath: "/private/tmp/ark-observation-native-\(UUID().uuidString)")
    temporary = temp
    try FileManager.default.createDirectory(at: temp, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    let ledger = temp.appendingPathComponent("ledger.json"), guardConfig = temp.appendingPathComponent("guard.json")
    try Data("{\"budgetMicroCny\":5000000,\"maxRequests\":32,\"pending\":[],\"requestCount\":0,\"schema\":2,\"settledUpperBoundMicroCny\":0}".utf8).write(to: ledger)
    try ArkProtectedBytes.encode(JSONValue.object(["schemaVersion": .number(1), "ledgerPath": .string(ledger.path)])).write(to: guardConfig)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: ledger.path)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: guardConfig.path)
    let receipt = runtime.appendingPathComponent(".ark-provenance/pack-receipt.json")
    let manifest = runtime.appendingPathComponent(".ark-provenance/installed-runtime-manifest.json")
    let guardEntry = runtime.appendingPathComponent("protected-helpers/scripts/rust-migration/knowledge-cost-guard-launcher.mjs")
    func pins(_ entry: URL, _ config: URL) throws -> [URL: String] {
      try Dictionary(uniqueKeysWithValues: [node, entry, config, receipt, manifest].map { ($0, ArkProtectedBytes.digest(try Data(contentsOf: $0))) })
    }
    let readyURL: URL = try await withCheckedThrowingContinuation { continuation in
      let ready = ObservationProbeReply<URL>(continuation)
      guardProcess.onLine = { line in
        if let url = URL(string: line), url.host == "127.0.0.1", url.scheme == "http", let port = url.port, port > 0 { ready.finish(.success(url)) }
      }
      guardProcess.onExit = { _ in ready.finish(.failure(ArkProtectedOwnerError.rejected("Guard exited before fixture construction"))) }
      do {
        try guardProcess.start(ArkProtectedGuardLaunch(nodeExecutable: node, helperProgram: guardEntry,
          configuration: guardConfig, workingDirectory: runtime, fileDigests: try pins(guardEntry, guardConfig))) { operation, payload in
          guard let selected = await MainActor.run(body: {
            if broker == nil && operation == .admitProviderRequest { preAdmissionNativeCallbacks += 1 }
            return broker
          }) else { throw ArkProtectedOwnerError.rejected("No source trial admitted") }
          let generation = await MainActor.run { guardProcess.channelGeneration }
          return try await selected.perform(operation, payload: payload, origin: .guardProcess, channelGeneration: generation)
        }
      } catch { ready.finish(.failure(error)) }
      DispatchQueue.main.asyncAfter(deadline: .now() + 10) { ready.finish(.failure(ArkProtectedOwnerError.rejected("Guard ready timeout"))) }
    }
    let originalGuardPID = guardProcess.processIdentifier
    // Actual HTTP refusal occurs before original budget reserve/provider fetch.
    var request = URLRequest(url: readyURL.appendingPathComponent("chat/completions")); request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("Bearer source-fixture-no-provider-key", forHTTPHeaderField: "Authorization")
    request.setValue("pre-admission-source-fixture", forHTTPHeaderField: "x-deepseek-harness-session-id")
    request.setValue("source_pre_admit_probe", forHTTPHeaderField: "x-ark-cost-dispatch-id")
    request.httpBody = Data("{\"model\":\"deepseek-flash\",\"max_tokens\":8192,\"stream\":true,\"stream_options\":{\"include_usage\":true},\"dsh_plugin_packages\":{\"version\":1,\"packages\":[]},\"messages\":[{\"role\":\"user\",\"content\":\"fixture\"}]}".utf8)
    let (_, response) = try await URLSession.shared.data(for: request)
    guard let http = response as? HTTPURLResponse, http.statusCode >= 400, preAdmissionNativeCallbacks == 1,
      try Data(contentsOf: ledger) == Data("{\"budgetMicroCny\":5000000,\"maxRequests\":32,\"pending\":[],\"requestCount\":0,\"schema\":2,\"settledUpperBoundMicroCny\":0}".utf8) else {
      throw ArkProtectedOwnerError.rejected("Pre-admit request changed budget or escaped refusal")
    }
    let generator = BackendProcess()
    generator.onLine = { print("OBSERVATION_FIXTURE_GENERATOR: " + $0) }
    let generated: BackendProcessJoinedLaunch? = try await withCheckedThrowingContinuation { continuation in
      let done = ObservationProbeReply<BackendProcessJoinedLaunch?>(continuation)
      generator.onExit = { _ in done.finish(.success(generator.joinedReceipt)) }
      let env = ["PATH": node.deletingLastPathComponent().path + ":/usr/bin:/bin", "LANG": "en_US.UTF-8",
        "ARK_OBSERVATION_FIXTURE_ROOT": output.path, "ARK_OBSERVATION_COMPILED_RUNTIME_ROOT": runtime.path,
        "ARK_OBSERVATION_COMPACT_TASK_STEPS": "1", "ARK_OBSERVATION_NATIVE_TEST_KEYS": "1",
        "ARK_OBSERVATION_GUARD_ENDPOINT": readyURL.absoluteString, "ARK_OBSERVATION_LEDGER_PATH": ledger.path,
        "ARK_OBSERVATION_GUARD_CONFIG_PATH": guardConfig.path]
      do { try generator.start(executable: node.path, arguments: [repository.appendingPathComponent("node_modules/vitest/vitest.mjs").path,
        "run", "scripts/rust-migration/knowledge-use-producer.spec.ts", "-t", "pre-observation owner lifecycle.*\(arguments[4]) logs"],
        environment: env, workingDirectory: repository) }
      catch { done.finish(.failure(error)) }
    }
    guard generated?.terminationStatus == 0, generated?.exitedNormally == true else { throw ArkProtectedOwnerError.rejected("Source fixture generator failed") }
    let directories = try FileManager.default.contentsOfDirectory(at: output, includingPropertiesForKeys: nil).filter {
      FileManager.default.fileExists(atPath: $0.appendingPathComponent("public-fixture.json").path)
    }
    guard directories.count == 1 else { throw ArkProtectedOwnerError.rejected("Source fixture output must be one fresh retained trial") }
    let publicFile = directories[0].appendingPathComponent("public-fixture.json")
    let fixture = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: publicFile))
    guard fixture["fixtureOnly"] == .bool(true), let initial = fixture["initialSnapshots"]?.arrayValue,
      let completed = fixture["completedSlots"]?.arrayValue, let launchPath = fixture["intentLaunchPath"]?.stringValue,
      let root = fixture["root"]?.stringValue, let secretPath = fixture["testKeyTransferPath"]?.stringValue else {
      throw ArkProtectedOwnerError.rejected("Public fixture lacks source-control inputs")
    }
    keyPath = secretPath
    let signers = try observationProbeKeys(secretPath); keyPath = nil
    for row in initial { try observationProbeCopy(row["initialBlobPath"]!.stringValue!, row["originalPath"]!.stringValue!, root: root) }
    try observationProbeCopy(fixture["initialCodeBlobPath"]!.stringValue!, fixture["codeOriginalPath"]!.stringValue!, root: root)
    let evaluatorEntry = runtime.appendingPathComponent("protected-helpers/scripts/rust-migration/knowledge-use-evaluator.mjs")
    let launchURL = URL(fileURLWithPath: launchPath)
    let evaluator = ArkProtectedEvaluator(configuration: ArkProtectedEvaluatorConfiguration(nodeExecutable: node,
      entryPoint: evaluatorEntry, configuration: launchURL, workingDirectory: runtime, fileDigests: try pins(evaluatorEntry, launchURL),
      sourceBindingHash: fixture["sourceBindingHash"]!.stringValue!))
    let (_, intent) = try evaluator.admissionIntent(); let core = intent["core"]!
    guard core["cost"]?["endpoint"] == .string(readyURL.absoluteString), guardProcess.processIdentifier == originalGuardPID else {
      throw ArkProtectedOwnerError.rejected("Core did not freeze actual already-ready guard")
    }
    let stateRoot = temp.appendingPathComponent("state")
    try FileManager.default.createDirectory(at: stateRoot, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    let store = try ArkProtectedStateStore(root: stateRoot, observationVersion: true)
    let cost = core["cost"]!
    let costOwner = try ArkProtectedCostOwner(store: store, configuration: ArkProtectedCostConfiguration(ledgerPath: ledger,
      initialLedgerHash: cost["initialLedgerBytes"]!["hash"]!.stringValue!, endpoint: readyURL.absoluteString,
      provider: cost["provider"]!.stringValue!, configuredModel: cost["configuredModel"]!.stringValue!, wireModel: cost["wireModel"]!.stringValue!,
      maximumNewDispatches: cost["maximumNewDispatches"]!.jsonSafeInteger()!, maximumNewSettlements: cost["maximumNewSettlements"]!.jsonSafeInteger()!,
      sourceBindingHash: intent["sourceBindingHash"]!.stringValue!)) { session, snapshot in try await evaluator.capturedCostUse(sessionID: session, snapshotHash: snapshot) }
    let owner = ArkProtectedOwner(store: store, signers: signers,
      revalidate: { _ in try await evaluator.intentDescriptor() }, evaluate: { operation, payload, descriptor in try await evaluator.evaluate(operation, payload: payload, descriptor: descriptor) },
      costOwner: costOwner, publicBinding: try evaluator.publicBinding(), observationEvaluator: evaluator)
    let descriptor = try await owner.registerObservationIntent()
    let registered = store.trials.first!
    let generationID = registered.collection!["generationId"]!.stringValue!
    let artifactRoot = core["artifactRoot"]!.stringValue!
    let allocation = URL(fileURLWithPath: artifactRoot).appendingPathComponent("trial-generations/" + generationID + "/native-allocation-control")
    try FileManager.default.createDirectory(at: allocation, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    for index in 0...8192 { _ = FileManager.default.createFile(atPath: allocation.appendingPathComponent("zero-\(index)").path, contents: Data(), attributes: [.posixPermissions: 0o600]) }
    var deep = allocation
    for _ in 0..<33 { deep = deep.appendingPathComponent("d"); try FileManager.default.createDirectory(at: deep, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700]) }
    _ = FileManager.default.createFile(atPath: deep.appendingPathComponent("zero").path, contents: Data(), attributes: [.posixPermissions: 0o600])
    try await owner.prepareNativeObservationArtifact(Data("source-only-allocation-control".utf8), root: artifactRoot, generation: generationID, copyToOwner: false)
    let listener = try ReadyBridgeListener(owner: owner)
    let connected = ArkProtectedOwnerBroker(listenerEndpoint: listener.listener.endpoint, peerRequirement: listener.requirement)
    broker = connected
    try connected.prepareFiniteTrial(descriptor, guardProcess: guardProcess)
    try await connected.admit(descriptor)
    let oldCosts = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: URL(fileURLWithPath: core["artifactRoot"]!.stringValue!).appendingPathComponent(fixture["capturedCostResolutionHash"]!.stringValue!)))
    var captureResponses: [JSONValue] = []
    for (slotIndex, slot) in core["orderedSlots"]!.arrayValue!.enumerated() {
      let captured = completed[slotIndex]
      let witnessHash = oldCosts["orderedSlots"]!.arrayValue![slotIndex]["witnessBytes"]!["hash"]!.stringValue!
      let witness = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: URL(fileURLWithPath: core["artifactRoot"]!.stringValue!).appendingPathComponent(witnessHash)))
      let attempts = witness["attempts"]!.arrayValue!
      let generation = UUID()
      let channel = try ArkNativeOwnerChannel(helloProvider: { try await connected.launchHello() }, generation: generation) { operation, payload in
        let result = try await connected.perform(operation, payload: payload, origin: .backend, channelGeneration: generation)
        if operation == .registerProviderDispatch, let dispatch = result["dispatchId"], let matched = attempts.first(where: { $0["capturedRequestHash"] == payload["capturedRequestHash"] }) {
          let ingress: JSONValue = .object(["schemaVersion": .number(1), "dispatchId": dispatch, "attemptId": .string(UUID().uuidString.lowercased()),
            "sessionIdHash": .string(ArkProtectedCostOwner.sessionHash(slot["sessionId"]!.stringValue!)), "requestBodyHash": matched["requestBodyHash"]!, "maxTokens": matched["maxTokens"]!])
          let guardGeneration = await MainActor.run { guardProcess.channelGeneration }
          _ = try await connected.perform(.admitProviderRequest, payload: ingress, origin: .guardProcess, channelGeneration: guardGeneration)
          var settlement = ingress.objectValue!
          for key in ["inputTokens", "outputTokens", "upperBoundMicroCny", "responseIdHash", "responseModel", "finishReason", "settledAt"] { settlement[key] = matched[key] }
          _ = try await connected.perform(.recordProviderSettlement, payload: .object(settlement), origin: .guardProcess, channelGeneration: guardGeneration)
        }
        return result
      }
      let payloads: JSONValue = .array(attempts.map { attempt in .object(["schemaVersion": .number(1), "kind": .string("adapter"),
        "sessionId": slot["sessionId"]!, "endpoint": .string(readyURL.absoluteString), "provider": cost["provider"]!,
        "configuredModel": cost["configuredModel"]!, "wireModel": cost["wireModel"]!, "requestBodyHash": attempt["requestBodyHash"]!,
        "maxTokens": attempt["maxTokens"]!, "capturedRequestHash": attempt["capturedRequestHash"]!]) })
      let payloadFile = temp.appendingPathComponent("requests-\(slotIndex).json")
      try ArkProtectedBytes.encode(payloads).write(to: payloadFile)
      guard let actualTaskCommand = captured["actualTaskCommand"]?.stringValue, actualTaskCommand.utf8.count <= 2 * 1024 * 1024,
        let actualTaskOutput = captured["actualTaskOutput"]?.stringValue else { throw ArkProtectedOwnerError.rejected("Original actual task command/output missing") }
      let taskFile = temp.appendingPathComponent("task-\(slotIndex).js"), taskOutputFile = temp.appendingPathComponent("task-\(slotIndex).stdout")
      try Data(actualTaskCommand.utf8).write(to: taskFile); try Data(actualTaskOutput.utf8).write(to: taskOutputFile)
      let connector = runtime.appendingPathComponent("protected-helpers/packages/bundle/native-api-app/src/native-owner-channel.mjs")
      let program = "import fs from 'node:fs';import assert from 'node:assert/strict';import {execFileSync} from 'node:child_process';const {connectNativeKnowledgeOwner,nativeKnowledgeOwnerEndpointFromEnvironment}=await import(process.argv[1]);const c=await connectNativeKnowledgeOwner(nativeKnowledgeOwnerEndpointFromEnvironment(process.env));if(c.status!=='ready')throw Error('disabled');for(const p of JSON.parse(fs.readFileSync(process.argv[2],'utf8')))await c.channel.call('registerProviderDispatch',p);const actual=execFileSync(process.execPath,['--eval',fs.readFileSync(process.argv[3],'utf8')],{cwd:process.cwd(),encoding:'utf8',env:{PATH:'/usr/bin:/bin',LANG:'en_US.UTF-8'}});assert.equal(actual,fs.readFileSync(process.argv[4],'utf8'));await c.channel.close();console.log('actual-original-task-write-protected-test-complete');"

      let joined: BackendProcessJoinedLaunch? = try await withCheckedThrowingContinuation { continuation in
        let done = ObservationProbeReply<BackendProcessJoinedLaunch?>(continuation)
        backend.onExit = { _ in done.finish(.success(backend.joinedReceipt)) }
        do {
          try backend.start(executable: node.path, arguments: ["--input-type=module", "--eval", program, connector.absoluteString, payloadFile.path,
            taskFile.path, taskOutputFile.path],
            environment: ["PATH": "/usr/bin:/bin", "LANG": "en_US.UTF-8"], workingDirectory: URL(fileURLWithPath: core["projectRoot"]!.stringValue!), ownerChannel: channel)
          try connected.prepareFiniteSlot(backend)
        } catch { channel.close(); done.finish(.failure(error)) }
      }
      guard joined?.terminationStatus == 0, joined?.exitedNormally == true, joined?.forced == false else { throw ArkProtectedOwnerError.rejected("Actual task process failed") }
      try observationProbeCopy(captured["capturedSnapshotPath"]!.stringValue!, initial[slotIndex]["originalPath"]!.stringValue!, root: root)
      captureResponses.append(try await connected.captureNextCompletedRegisteredSlot(descriptorHash: descriptor.descriptorHash))
    }
    guard guardProcess.processIdentifier == originalGuardPID, guardProcess.readyURL == readyURL else { throw ArkProtectedOwnerError.rejected("Guard identity changed across slots") }
    await withCheckedContinuation { continuation in guardProcess.stop { continuation.resume() } }
    let frozen = try await connected.freezeRegisteredTrial(descriptorHash: descriptor.descriptorHash)
    guard frozen["status"] == .string("frozen"), let completedHash = frozen["completedLaunchHash"]?.stringValue else { throw ArkProtectedOwnerError.rejected("Native final freeze failed") }
    let producerEntry = runtime.appendingPathComponent("protected-helpers/scripts/rust-migration/knowledge-use-producer.mjs")
    let completedURL = URL(fileURLWithPath: core["artifactRoot"]!.stringValue!).appendingPathComponent(completedHash)
    let runner = ArkProtectedFiniteRunner(backend: backend, broker: connected)
    let producerResult = try await runner.runFrozenProducer(ArkProtectedEvaluatorConfiguration(nodeExecutable: node, entryPoint: producerEntry,
      configuration: completedURL, workingDirectory: runtime, fileDigests: try pins(producerEntry, completedURL),
      sourceBindingHash: descriptor.sourceBindingHash), completedLaunchHash: completedHash)
    let finalStateBytes = try Data(contentsOf: stateRoot.appendingPathComponent("owner-state-v2.json"))
    try finalStateBytes.write(to: output.appendingPathComponent("native-owner-state-v2.json"))
    try ArkProtectedBytes.encode(producerResult).write(to: output.appendingPathComponent("original-producer-result.json"))
    let finalState = try JSONDecoder().decode(JSONValue.self, from: finalStateBytes)
    let reservations = finalState["trials"]?.arrayValue?.first?["reservations"]?.arrayValue ?? []
    let expectedSpent = ["resolveSettledUseCost": 2, "verifyCandidate": 2, "signKnowledgeUseJournal": 2,
      "evaluateCapturedUse": 2, "finalizeMeasuredTrial": 1]
    guard reservations.count == expectedSpent.values.reduce(0, +),
      reservations.allSatisfy({ $0["phase"] == .string("spent") }),
      expectedSpent.allSatisfy({ operation, count in reservations.filter({ $0["operation"] == .string(operation) }).count == count }) else {
      throw ArkProtectedOwnerError.rejected("Original producer did not finish both cost/oracle/use/journal arms and finalization")
    }
    let reachedReader = producerResult["status"] == .string("eligible") || producerResult["status"] == .string("ineligible") ||
      (producerResult["status"] == .string("rejected") && producerResult["reason"] == .string("reader-rejected"))
    guard reachedReader else { throw ArkProtectedOwnerError.rejected("Original producer exited before the expected reader result") }
    let result: JSONValue = .object(["schemaVersion": .number(1), "status": .string("pass"), "sourceFixtureOnly": .bool(true),
      "syntheticProviderObservations": .bool(true), "actualTaskWritesTests": .bool(true), "actualXPC": .bool(true),
      "actualGuardReadyBeforeIntent": .bool(true), "preAdmissionHTTPRejected": .bool(true), "preAdmissionNativeCallbacks": .number(Double(preAdmissionNativeCallbacks)), "sameGuardAcrossSlots": .bool(true),
      "nativeCaptureResponses": .array(captureResponses), "nativeFreeze": frozen, "actualOfflineProducerJoined": .bool(true),
      "nativeDerivedDeepZeroLayoutControl": .bool(true), "nativeCostCallbacksSynthetic": .bool(true), "originalProducerReaderResult": producerResult, "utilityMetricsProven": .bool(false)])
    try ArkProtectedBytes.encode(result).write(to: output.appendingPathComponent("native-observation-result.json"))
    try await connected.closeAndWait(); listener.listener.invalidate()
    if let temporary { try? FileManager.default.removeItem(at: temporary) }
    print("NATIVE_OBSERVATION_SOURCE_PROBE pass actual-task-write-test-join XPC guard-ready-before-intent frozen exact-offline-peer utilityMetricsProven=false")
    return 0
  } catch {
    if let keyPath { _ = unlink(keyPath) }
    await withCheckedContinuation { continuation in backend.stop { continuation.resume() } }
    await withCheckedContinuation { continuation in guardProcess.stop { continuation.resume() } }
    try? await broker?.closeAndWait()
    if let temporary { try? FileManager.default.removeItem(at: temporary) }
    print("NATIVE_OBSERVATION_SOURCE_PROBE refused: \(error)")
    return 1
  }
}

private func observationProbeKeys(_ path: String) throws -> [String: Curve25519.Signing.PrivateKey] {
  let parent = URL(fileURLWithPath: path).deletingLastPathComponent()
  var directory = stat()
  guard parent.path.hasPrefix("/private/tmp/ark-observation-test-keys-"), URL(fileURLWithPath: path).lastPathComponent == "ephemeral-test-seeds.json",
    lstat(parent.path, &directory) == 0, directory.st_mode & S_IFMT == S_IFDIR, directory.st_uid == getuid(), directory.st_mode & 0o777 == 0o700 else {
    throw ArkProtectedOwnerError.rejected("Ephemeral source-test key directory is unsafe")
  }
  let file = Darwin.open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
  guard file >= 0 else { throw ArkProtectedOwnerError.rejected("Ephemeral source-test key file absent") }
  defer { Darwin.close(file); _ = unlink(path); _ = rmdir(parent.path) }
  var info = stat()
  guard fstat(file, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_uid == getuid(), info.st_nlink == 1,
    info.st_mode & 0o777 == 0o600, info.st_size > 0, info.st_size <= 1024 else { throw ArkProtectedOwnerError.rejected("Unsafe ephemeral test key input") }
  let bytes = try FileHandle(fileDescriptor: file, closeOnDealloc: false).readToEnd() ?? Data()
  try ArkProtectedStrictJSON.validate(bytes)
  let fields = try ArkProtectedBytes.object(bytes, keys: ["promotion", "journal", "evaluator"])
  var result: [String: Curve25519.Signing.PrivateKey] = [:]
  for role in ArkProtectedOwnerPublicBinding.roles {
    guard let hex = fields[role]?.stringValue, ArkProtectedBytes.hashIsValid(hex) else { throw ArkProtectedOwnerError.rejected("Ephemeral test seed shape differs") }
    let characters = Array(hex); var raw = Data()
    for index in stride(from: 0, to: characters.count, by: 2) {
      guard let byte = UInt8(String(characters[index...index + 1]), radix: 16) else { throw ArkProtectedOwnerError.rejected("Ephemeral test seed encoding differs") }
      raw.append(byte)
    }
    result[role] = try Curve25519.Signing.PrivateKey(rawRepresentation: raw)
  }
  return result
}
private func observationProbeCopy(_ source: String, _ target: String, root: String) throws {
  guard target.hasPrefix(root + "/"), source.hasPrefix(root + "/") else { throw ArkProtectedOwnerError.rejected("Source fixture copy escapes its isolated root") }
  let bytes = try Data(contentsOf: URL(fileURLWithPath: source)); try bytes.write(to: URL(fileURLWithPath: target))
}
private final class ObservationProbeReply<Value>: @unchecked Sendable {
  private let lock = NSLock(); private var continuation: CheckedContinuation<Value, Error>?
  init(_ continuation: CheckedContinuation<Value, Error>) { self.continuation = continuation }
  func finish(_ result: Result<Value, Error>) { lock.lock(); let selected = continuation; continuation = nil; lock.unlock(); selected?.resume(with: result) }
}
