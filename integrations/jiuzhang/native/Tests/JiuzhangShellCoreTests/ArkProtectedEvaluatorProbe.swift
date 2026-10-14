import Foundation
import Darwin
import CryptoKit
@testable import JiuzhangShellCore

/// Public-only retained fixture supplied by the TS evaluator tests. No private
/// key is imported by this probe and no product runtime is launched.
func runArkProtectedEvaluatorProbe(_ arguments: [String]) async -> Int32 {
  do {
    let metadataOnly = arguments.count == 6 && arguments[5] == "--public-metadata-only"
    guard arguments.count == 4 || arguments.count == 5 || metadataOnly else { throw ArkProtectedOwnerError.rejected("probe needs node, packaged runtime, config, requests") }
    let node = URL(fileURLWithPath: arguments[0])
    let repo = URL(fileURLWithPath: arguments[1])
    let config = URL(fileURLWithPath: arguments[2])
    let requestFile = URL(fileURLWithPath: arguments[3])
    let entry = repo.appendingPathComponent("protected-helpers/scripts/rust-migration/knowledge-use-evaluator.mjs")
    let manifest = repo.appendingPathComponent(".ark-provenance/installed-runtime-manifest.json")
    let receiptURL = repo.appendingPathComponent(".ark-provenance/pack-receipt.json")
    let data = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: config))
    guard let binding = data["sourceBindingHash"]?.stringValue else { throw ArkProtectedOwnerError.rejected("fixture binding absent") }
    let pins: [URL: String]
    if arguments.count >= 5 {
      let retained = try JSONDecoder().decode([String: String].self,
        from: Data(contentsOf: URL(fileURLWithPath: arguments[4])))
      pins = Dictionary(uniqueKeysWithValues: retained.map { (URL(fileURLWithPath: $0.key), $0.value) })
    } else {
      pins = try Dictionary(uniqueKeysWithValues: [node, entry, config, manifest, receiptURL].map {
        ($0, ArkProtectedBytes.digest(try Data(contentsOf: $0)))
      })
    }
    let evaluator = ArkProtectedEvaluator(configuration: ArkProtectedEvaluatorConfiguration(nodeExecutable: node,
      entryPoint: entry, configuration: config, workingDirectory: repo, fileDigests: pins, sourceBindingHash: binding))
    if metadataOnly {
      try ArkProtectedRuntimePins.validate(root: repo, node: node, entry: entry, configuration: config,
        pins: pins, helper: "knowledge-use-evaluator.mjs")
      let publicBinding = try evaluator.publicBinding()
      let root = URL(fileURLWithPath: "/private/tmp/ark-public-metadata-probe-\(UUID().uuidString)")
      defer { try? FileManager.default.removeItem(at: root) }
      try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
      let store = try ArkProtectedStateStore(root: root)
      let owner = ArkProtectedOwner(store: store, signers: ["evaluator": Curve25519.Signing.PrivateKey(),
        "journal": Curve25519.Signing.PrivateKey(), "promotion": Curve25519.Signing.PrivateKey()],
        revalidate: { $0 }, evaluate: { _, _, _ in throw ArkProtectedOwnerError.rejected("Metadata-only probe must not execute") },
        publicBinding: publicBinding)
      do {
        _ = try await owner.launchHello()
        throw ArkProtectedOwnerError.rejected("Fresh Native keys unexpectedly matched retained producer keys")
      } catch ArkProtectedOwnerError.rejected(let reason) {
        guard reason == "Pinned evaluator key differs from Native signer" else { throw ArkProtectedOwnerError.rejected(reason) }
      }
      print("PUBLIC_METADATA_PROBE closureValidation=pass pinnedPublicMetadata=pass freshNativeKeyMismatch=refused helperLaunches=0 oldGrantRegistrations=0")
      return 0
    }
    let descriptor = try await evaluator.descriptor()
    let requests = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: requestFile))
    guard let request = requests["evaluateCapturedUse"], let cost = requests["describeCapturedCostUse"],
      let session = cost["sessionId"]?.stringValue, let snapshot = cost["sessionSnapshotHash"]?.stringValue else {
      throw ArkProtectedOwnerError.rejected("fixture requests absent")
    }
    let observed = try await evaluator.capturedCostUse(sessionID: session, snapshotHash: snapshot)
    let recipe = try await evaluator.evaluate(.evaluateCapturedUse, payload: request, descriptor: descriptor)
    let unsigned = try JSONDecoder().decode(JSONValue.self, from: recipe.canonicalBytes)
    var schema2Verification: JSONValue = .null
    if let candidate = requests["verifyCandidate"] {
      let candidateRecipe = try await evaluator.evaluate(.verifyCandidate, payload: candidate, descriptor: descriptor)
      guard candidateRecipe.signatureField == "proof" else { throw ArkProtectedOwnerError.rejected("Schema-2 verification signing domain differs") }
      schema2Verification = .object(["status": .string("pass"),
        "privateRequestBytesHash": .string(ArkProtectedBytes.digest(try ArkProtectedBytes.encode(candidate))),
        "canonicalBytesHash": .string(ArkProtectedBytes.digest(candidateRecipe.canonicalBytes)),
        "requestConfidence": candidate["review"]?["confidence"] ?? .null])
    }
    var liveResult: JSONValue = .null
    if let live = descriptor.liveCostAdmission, let fixture = requests["liveCost"], fixture["fixtureOnly"] == .bool(true),
      let ledgerPath = fixture["ledgerPath"]?.stringValue, let rows = fixture["requests"]?.arrayValue {
      let root = URL(fileURLWithPath: "/private/tmp/ark-live-cost-cli-probe-\(UUID().uuidString)")
      try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
      defer { try? FileManager.default.removeItem(at: root) }
      let store = try ArkProtectedStateStore(root: root)
      let ledger = URL(fileURLWithPath: ledgerPath)
      let originalLedger = try Data(contentsOf: ledger)
      let costOwner = try ArkProtectedCostOwner(store: store, configuration: ArkProtectedCostConfiguration(ledgerPath: ledger,
        initialLedgerHash: live.ledgerArtifactHash, endpoint: fixture["endpoint"]!.stringValue!,
        provider: fixture["provider"]!.stringValue!, configuredModel: fixture["configuredModel"]!.stringValue!,
        wireModel: fixture["wireModel"]!.stringValue!, maximumNewDispatches: live.maximumNewDispatches,
        maximumNewSettlements: live.maximumNewSettlements, sourceBindingHash: descriptor.sourceBindingHash)) { session, snapshot in
          try await evaluator.capturedCostUse(sessionID: session, snapshotHash: snapshot)
        }
      let owner = ArkProtectedOwner(store: store, signers: [:], revalidate: { _ in try await evaluator.descriptor() },
        evaluate: { operation, payload, descriptor in try await evaluator.evaluate(operation, payload: payload, descriptor: descriptor) }, costOwner: costOwner)
      try await owner.register(descriptor)
      let nonce = try await owner.prepareConfirmation(descriptorHash: descriptor.descriptorHash)
      try await owner.admit(descriptorHash: descriptor.descriptorHash, nonce: nonce)
      for (index, row) in rows.enumerated() {
        let registered = try await owner.perform(.registerProviderDispatch, payload: row["registerProviderDispatch"]!)
        guard let dispatch = registered["dispatchId"] else { throw ArkProtectedOwnerError.rejected("CLI-derived live dispatch refused") }
        var ingress = row["admitProviderRequest"]!.objectValue!
        ingress["dispatchId"] = dispatch; ingress["attemptId"] = .string("fixture-attempt-\(index)")
        _ = try await owner.perform(.admitProviderRequest, payload: .object(ingress), origin: .guardProcess)
        var settlement = row["recordProviderSettlement"]!.objectValue!
        settlement["dispatchId"] = dispatch; settlement["attemptId"] = ingress["attemptId"]
        _ = try await owner.perform(.recordProviderSettlement, payload: .object(settlement), origin: .guardProcess)
      }
      liveResult = try await owner.perform(.resolveSettledUseCost, payload: .object(["schemaVersion": .number(1),
        "operation": .string("resolve-settled-use-cost-v1"), "sessionId": .string(session), "sessionSnapshotHash": .string(snapshot),
        "capturedRequestHashes": observed["capturedRequestHashes"]!]))
      guard liveResult["status"] == .string("verified"), try Data(contentsOf: ledger) == originalLedger,
        store.trials.first?.reservations.isEmpty == true else { throw ArkProtectedOwnerError.rejected("CLI-derived full cost evidence did not settle") }
      liveResult = .object(["status": .string("verified"), "artifactHash": liveResult["artifactHash"]!,
        "requestCount": .number(Double(rows.count)), "schema2LedgerUnchanged": .bool(true), "fixtureGuardFactsOnly": .bool(true)])
    }
    let receipt: JSONValue = .object(["status": .string("pass"), "descriptorHash": .string(descriptor.descriptorHash),
      "sessionCount": .number(Double(descriptor.sessionIDs.count)), "capturedCostUse": observed,
      "canonicalBytesHash": .string(ArkProtectedBytes.digest(recipe.canonicalBytes)),
      "signatureField": .string(recipe.signatureField), "evaluatorAuthorityId": unsigned["evaluatorAuthorityId"] ?? .null,
      "realAuthorityProvisioned": .bool(false), "liveCost": liveResult, "schema2Verification": schema2Verification])
    FileHandle.standardOutput.write(try ArkProtectedBytes.encode(receipt) + Data([10]))
    return 0
  } catch { print("protected evaluator probe failed: \(error)"); return 1 }
}

/// Exercises the actual packaged guard child and the existing Native stop join.
func runArkProtectedGuardLifecycleProbe(_ arguments: [String]) async -> Int32 {
  let guardProcess = ArkProtectedGuardProcess()
  do {
    guard arguments.count == 4 else { throw ArkProtectedOwnerError.rejected("guard probe needs node, runtime, config, retained pins") }
    let node = URL(fileURLWithPath: arguments[0]), root = URL(fileURLWithPath: arguments[1])
    let config = URL(fileURLWithPath: arguments[2])
    let retained = try JSONDecoder().decode([String: String].self,
      from: Data(contentsOf: URL(fileURLWithPath: arguments[3])))
    let pins = Dictionary(uniqueKeysWithValues: retained.map { (URL(fileURLWithPath: $0.key), $0.value) })
    let program = root.appendingPathComponent("protected-helpers/scripts/rust-migration/knowledge-cost-guard-launcher.mjs")
    var ready = false
    guardProcess.onLine = { line in if line.hasPrefix("http://127.0.0.1:") { ready = true } }
    try guardProcess.start(ArkProtectedGuardLaunch(nodeExecutable: node, helperProgram: program,
      configuration: config, workingDirectory: root, fileDigests: pins)) { _, _ in
      throw ArkProtectedOwnerError.rejected("No provider operation authorized in lifecycle fixture")
    }
    guard let pid = guardProcess.processIdentifier else { throw ArkProtectedOwnerError.rejected("Guard PID absent") }
    let deadline = Date().addingTimeInterval(20)
    while !ready, guardProcess.isRunning, Date() < deadline { try await Task.sleep(nanoseconds: 10_000_000) }
    let didBecomeReady = ready
    await withCheckedContinuation { continuation in
      guardProcess.stop(deadline: Date().addingTimeInterval(5)) { continuation.resume() }
    }
    guard didBecomeReady, !guardProcess.isRunning, Darwin.kill(pid, 0) != 0, errno == ESRCH else {
      throw ArkProtectedOwnerError.rejected("Guard did not become ready and join its PID")
    }
    print("{\"status\":\"pass\",\"guardPID\":\(pid),\"nativeStopJoined\":true,\"providerDispatches\":0}")
    return 0
  } catch {
    if guardProcess.isRunning {
      await withCheckedContinuation { continuation in
        guardProcess.stop(deadline: Date().addingTimeInterval(5)) { continuation.resume() }
      }
    }
    print("packaged guard lifecycle probe failed: \(error)")
    return 1
  }
}

/// Cancels only after the real evaluator child is observable, then checks that
/// the awaited evaluator task returned cancellation and that child PID exited.
func runArkProtectedEvaluatorCancellationProbe(_ arguments: [String]) async -> Int32 {
  do {
    guard arguments.count == 5 else { throw ArkProtectedOwnerError.rejected("cancel probe needs node, runtime, config, requests, retained pins") }
    let node = URL(fileURLWithPath: arguments[0]), root = URL(fileURLWithPath: arguments[1])
    let config = URL(fileURLWithPath: arguments[2])
    let entry = root.appendingPathComponent("protected-helpers/scripts/rust-migration/knowledge-use-evaluator.mjs")
    let retained = try JSONDecoder().decode([String: String].self,
      from: Data(contentsOf: URL(fileURLWithPath: arguments[4])))
    let pins = Dictionary(uniqueKeysWithValues: retained.map { (URL(fileURLWithPath: $0.key), $0.value) })
    let value = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: config))
    guard let binding = value["sourceBindingHash"]?.stringValue else { throw ArkProtectedOwnerError.rejected("Cancellation fixture binding absent") }
    let evaluator = ArkProtectedEvaluator(configuration: ArkProtectedEvaluatorConfiguration(nodeExecutable: node,
      entryPoint: entry, configuration: config, workingDirectory: root, fileDigests: pins, sourceBindingHash: binding))
    let descriptor = try await evaluator.descriptor()
    let requests = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: URL(fileURLWithPath: arguments[3])))
    guard let request = requests["evaluateCapturedUse"] else { throw ArkProtectedOwnerError.rejected("Cancellation fixture request absent") }
    let task = Task { try await evaluator.evaluate(.evaluateCapturedUse, payload: request, descriptor: descriptor) }
    var observed: pid_t?
    let deadline = Date().addingTimeInterval(20)
    while observed == nil, Date() < deadline {
      let process = Process(), output = Pipe()
      process.executableURL = URL(fileURLWithPath: "/bin/ps")
      process.arguments = ["-axo", "pid=,ppid=,command="]
      process.standardOutput = output
      try process.run()
      let bytes = output.fileHandleForReading.readDataToEndOfFile()
      process.waitUntilExit()
      for row in String(decoding: bytes, as: UTF8.self).split(separator: "\n") {
        let columns = row.split(separator: " ", omittingEmptySubsequences: true)
        if columns.count > 3, columns[1] == String(getpid()), columns[2] == node.path,
          columns[3] == entry.path, let pid = Int32(columns[0]) { observed = pid; break }
      }
      if observed == nil { try await Task.sleep(nanoseconds: 10_000_000) }
    }
    task.cancel()
    var cancelled = false
    do { _ = try await task.value } catch is CancellationError { cancelled = true }
    guard let pid = observed, cancelled, Darwin.kill(pid, 0) != 0, errno == ESRCH else {
      throw ArkProtectedOwnerError.rejected("Evaluator cancellation did not join an observed child")
    }
    print("{\"status\":\"pass\",\"evaluatorPID\":\(pid),\"cancellationObserved\":true,\"nativeTaskJoinedPID\":true}")
    return 0
  } catch { print("packaged evaluator cancellation probe failed: \(error)"); return 1 }
}

/// One debug-build measurement, never a percentile or an immutable-cache claim.
func runArkProtectedRuntimeTimingProbe(_ arguments: [String]) -> Int32 {
  do {
    guard arguments.count == 4 else { throw ArkProtectedOwnerError.rejected("timing probe needs node, runtime, guard config, retained pins") }
    let node = URL(fileURLWithPath: arguments[0]), root = URL(fileURLWithPath: arguments[1])
    let config = URL(fileURLWithPath: arguments[2])
    let retained = try JSONDecoder().decode([String: String].self,
      from: Data(contentsOf: URL(fileURLWithPath: arguments[3])))
    let pins = Dictionary(uniqueKeysWithValues: retained.map { (URL(fileURLWithPath: $0.key), $0.value) })
    let entry = root.appendingPathComponent("protected-helpers/scripts/rust-migration/knowledge-cost-guard-launcher.mjs")
    var measurements: [String: Any] = ["build": "SwiftPM debug", "sampleCount": 1]
    let baseline = Date()
    for (url, expected) in pins {
      let fd = Darwin.open(url.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
      guard fd >= 0 else { throw ArkProtectedOwnerError.rejected("Timing pin absent") }
      defer { Darwin.close(fd) }
      var info = stat()
      guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_nlink == 1,
        let bytes = try FileHandle(fileDescriptor: fd, closeOnDealloc: false).readToEnd(),
        ArkProtectedBytes.digest(bytes) == expected else { throw ArkProtectedOwnerError.rejected("Timing pin changed") }
    }
    measurements["fivePinReadHashSeconds"] = Date().timeIntervalSince(baseline)
    let full = Date()
    try ArkProtectedRuntimePins.validate(root: root, node: node, entry: entry,
      configuration: config, pins: pins, helper: "knowledge-cost-guard-launcher.mjs")
    measurements["fullUnchangedValidationSeconds"] = Date().timeIntervalSince(full)
    let manifestBytes = try Data(contentsOf: root.appendingPathComponent(".ark-provenance/installed-runtime-manifest.json"))
    let receiptBytes = try Data(contentsOf: root.appendingPathComponent(".ark-provenance/pack-receipt.json"))
    let decode = Date()
    let manifest = try JSONSerialization.jsonObject(with: manifestBytes) as! [String: Any]
    _ = try JSONSerialization.jsonObject(with: receiptBytes)
    measurements["sameContentJSONParseSeconds"] = Date().timeIntervalSince(decode)
    let derive = Date()
    var paths = [(String, String)]()
    for item in manifest["requiredFiles"] as! [[String: Any]] { paths.append((item["path"] as! String, item["sha256"] as! String)) }
    for package in manifest["packages"] as! [[String: Any]] {
      for item in package["contentFiles"] as! [[String: Any]] {
        paths.append(((package["locator"] as! String) + "/" + (item["path"] as! String), item["sha256"] as! String))
      }
    }
    measurements["filePathProjectionSeconds"] = Date().timeIntervalSince(derive)
    let enumerate = Date()
    var count = 0
    func visit(_ directory: URL) throws {
      for name in try FileManager.default.contentsOfDirectory(atPath: directory.path) {
        let url = directory.appendingPathComponent(name); var info = stat()
        guard lstat(url.path, &info) == 0 else { throw ArkProtectedOwnerError.rejected("Timing member absent") }
        count += 1
        if info.st_mode & S_IFMT == S_IFDIR { try visit(url) }
        else if info.st_mode & S_IFMT == S_IFLNK { _ = url.resolvingSymlinksInPath() }
      }
    }
    try visit(root)
    measurements["directoryEnumerationLstatSeconds"] = Date().timeIntervalSince(enumerate)
    measurements["enumeratedMembers"] = count
    let read = Date()
    let corpus = try paths.map { try Data(contentsOf: root.appendingPathComponent($0.0)) }
    measurements["payloadReadOnlySeconds"] = Date().timeIntervalSince(read)
    measurements["payloadFiles"] = corpus.count
    measurements["payloadBytes"] = corpus.reduce(0) { $0 + $1.count }
    let old = Date()
    let expected = corpus.map { ArkProtectedBytes.digest($0) }
    measurements["payloadCurrentOwnerSHAHexSeconds"] = Date().timeIntervalSince(old)
    let digits = Array("0123456789abcdef".utf8)
    func nibbleDigest(_ data: Data) -> String {
      var bytes = [UInt8](); bytes.reserveCapacity(64)
      for value in SHA256.hash(data: data) { bytes.append(digits[Int(value >> 4)]); bytes.append(digits[Int(value & 15)]) }
      return String(decoding: bytes, as: UTF8.self)
    }
    let proposed = Date()
    let observed = corpus.map { nibbleDigest($0) }
    measurements["payloadSHAAndNibbleHexSeconds"] = Date().timeIntervalSince(proposed)
    let fixtures = [Data(), Data([0, 1, 128, 255]), Data("中文🙂".utf8), Data(repeating: 0xff, count: 4 * 1024 * 1024)]
    func legacyDigest(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    guard expected == observed, zip(corpus, expected).allSatisfy({ legacyDigest($0.0) == $0.1 }),
      fixtures.allSatisfy({ ArkProtectedBytes.digest($0) == legacyDigest($0) }),
      ArkProtectedBytes.digest(Data()) == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      ArkProtectedBytes.digest(Data("abc".utf8)) == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" else {
      throw ArkProtectedOwnerError.rejected("Digest benchmark changed bytes")
    }
    measurements["digestEquality"] = true
    measurements["status"] = "pass"
    print(String(decoding: try JSONSerialization.data(withJSONObject: measurements, options: [.sortedKeys]), as: UTF8.self))
    return 0
  } catch { print("runtime timing probe failed: \(error)"); return 1 }
}
