import Darwin
import Foundation

/// Executable/config/source pins are provisioned outside the evaluated project.
/// No production pin or signing key is shipped in this source-only integration.
public struct ArkProtectedEvaluatorConfiguration: Sendable {
  public let nodeExecutable: URL
  public let entryPoint: URL
  public let configuration: URL
  public let workingDirectory: URL
  public let fileDigests: [URL: String]
  public let sourceBindingHash: String
  public let nodeArguments: [String]
  public let sourceTSConfig: URL?
  public init(nodeExecutable: URL, entryPoint: URL, configuration: URL, workingDirectory: URL,
    fileDigests: [URL: String], sourceBindingHash: String, nodeArguments: [String] = [], sourceTSConfig: URL? = nil) {
    self.nodeExecutable = nodeExecutable; self.entryPoint = entryPoint
    self.configuration = configuration; self.workingDirectory = workingDirectory
    self.fileDigests = fileDigests; self.sourceBindingHash = sourceBindingHash; self.nodeArguments = nodeArguments; self.sourceTSConfig = sourceTSConfig
  }
}

/// Launches the fixed keyless oracle in a separate owned process. It receives
/// references and fixed configuration, never key material or caller file paths.
public final class ArkProtectedEvaluator: @unchecked Sendable {
  private let configuration: ArkProtectedEvaluatorConfiguration
  public init(configuration: ArkProtectedEvaluatorConfiguration) { self.configuration = configuration }

  /// Reads only the already-pinned public registration, not a key or deployment configuration.
  public func publicBinding() throws -> ArkProtectedOwnerPublicBinding {
    guard let pin = configuration.fileDigests[configuration.configuration] else {
      throw ArkProtectedOwnerError.rejected("Public evaluator configuration is not pinned")
    }
    let bytes = try ArkProtectedRuntimePins.read(configuration.configuration, hash: pin)
    let initial = try JSONDecoder().decode(JSONValue.self, from: bytes)
    if initial["kind"] == .string("fixed-trial-intent-helper-launch-v1") {
      let (_, intent) = try admissionIntent()
      let core = intent["core"]!, authorities = core["authorities"]!
      let source = core["sourceIdentity"]!
      try ArkProtectedOwnerPublicBinding.validateSourceIdentity(source)
      var ids: [String: String] = [:], keys: [String: Data] = [:]
      for role in ArkProtectedOwnerPublicBinding.roles {
        guard let id = authorities[role]?["authorityId"]?.stringValue,
          let base64 = authorities[role]?["publicKeySpkiBase64"]?.stringValue,
          let der = Data(base64Encoded: base64), der.base64EncodedString() == base64,
          der.count == 44, der.starts(with: ArkProtectedOwnerPublicBinding.spkiPrefix) else {
          throw ArkProtectedOwnerError.rejected("Intent public authority differs")
        }
        ids[role] = id; keys[role] = der
      }
      guard keys["journal"] != keys["evaluator"], ids["journal"] != ids["evaluator"],
        authorities["costAuthorityId"] == .string(ids["evaluator"]!) else {
        throw ArkProtectedOwnerError.rejected("Intent native cost and signing authority relation differs")
      }
      return ArkProtectedOwnerPublicBinding(sourceBindingHash: configuration.sourceBindingHash, sourceIdentity: source,
        artifactRoot: core["artifactRoot"]!.stringValue!, projectRoot: core["projectRoot"]!.stringValue!,
        profileIdentity: core["profileIdentity"]!.stringValue!, buildIdentity: core["buildIdentity"]!.stringValue!, authorityIDs: ids, expectedPublicKeys: keys)
    }
    guard bytes.count <= ArkProtectedBytes.maximumFrame,
      let config = try JSONDecoder().decode(JSONValue.self, from: bytes).objectValue,
      config["schemaVersion"] == .number(1), config["sourceBindingHash"] == .string(configuration.sourceBindingHash),
      let artifactRoot = config["artifactRoot"]?.stringValue,
      let registrations = config["registrations"]?.arrayValue, !registrations.isEmpty, registrations.count <= 256,
      let first = registrations[0]["binding"]?.objectValue,
      let source = first["sourceIdentity"], let project = first["projectRoot"]?.stringValue,
      let profile = first["profileIdentity"]?.stringValue, let build = first["buildIdentity"]?.stringValue,
      registrations.allSatisfy({ row in
        row["binding"]?["sourceIdentity"] == source && row["binding"]?["projectRoot"] == .string(project)
          && row["binding"]?["profileIdentity"] == .string(profile) && row["binding"]?["buildIdentity"] == .string(build)
      }), let evaluator = config["authorityId"]?.stringValue,
      let journal = config["journalAuthorityId"]?.stringValue, let promotion = config["promotionAuthorityId"]?.stringValue,
      evaluator != journal,
      let evaluatorSpki = config["evaluatorPublicKeySpki"]?.stringValue.flatMap({ Data(base64Encoded: $0) }),
      let journalSpki = config["journalPublicKeySpki"]?.stringValue.flatMap({ Data(base64Encoded: $0) }) else {
      throw ArkProtectedOwnerError.rejected("Pinned public evaluator registration is malformed")
    }
    guard evaluatorSpki != journalSpki, ArkProtectedBytes.hashIsValid(configuration.sourceBindingHash),
      [artifactRoot, project].allSatisfy({ $0.hasPrefix("/") && !$0.contains("\0") }),
      !profile.isEmpty, !build.isEmpty,
      [evaluator, journal, promotion].allSatisfy({ !$0.isEmpty && $0.count <= 256 }),
      [evaluatorSpki, journalSpki].allSatisfy({ $0.count == 44 && $0.starts(with: ArkProtectedOwnerPublicBinding.spkiPrefix) }) else {
      throw ArkProtectedOwnerError.rejected("Pinned evaluator public identity has invalid fields or keys")
    }
    try ArkProtectedOwnerPublicBinding.validateSourceIdentity(source)
    var expected = ["evaluator": evaluatorSpki, "journal": journalSpki]
    if promotion == evaluator { expected["promotion"] = evaluatorSpki }
    else if promotion == journal { expected["promotion"] = journalSpki }
    return ArkProtectedOwnerPublicBinding(sourceBindingHash: configuration.sourceBindingHash,
      sourceIdentity: source, artifactRoot: artifactRoot, projectRoot: project,
      profileIdentity: profile, buildIdentity: build,
      authorityIDs: ["promotion": promotion, "journal": journal, "evaluator": evaluator], expectedPublicKeys: expected)
  }

  /// The pinned bootstrap is a separately tagged intent launch, never a completed config.
  public func admissionIntent() throws -> (String, JSONValue) {
    guard let pin = configuration.fileDigests[configuration.configuration] else {
      throw ArkProtectedOwnerError.rejected("Intent launch is not pinned")
    }
    let bytes = try ArkProtectedRuntimePins.read(configuration.configuration, hash: pin)
    try ArkProtectedStrictJSON.validate(bytes)
    let launch = try ArkProtectedBytes.object(bytes, keys: ["schemaVersion", "kind", "intentHash", "artifactRoot", "sourceBindingHash"])
    guard launch["schemaVersion"] == .number(1), launch["kind"] == .string("fixed-trial-intent-helper-launch-v1"),
      launch["sourceBindingHash"] == .string(configuration.sourceBindingHash),
      let hash = launch["intentHash"]?.stringValue, ArkProtectedBytes.hashIsValid(hash),
      let root = launch["artifactRoot"]?.stringValue else { throw ArkProtectedOwnerError.rejected("Intent launch differs") }
    let intentBytes = try ArkProtectedRuntimePins.read(URL(fileURLWithPath: root).appendingPathComponent(hash), hash: hash)
    try ArkProtectedStrictJSON.validate(intentBytes)
    let intent = try ArkProtectedBytes.object(intentBytes, keys: ["schemaVersion", "kind", "core", "sourceBindingHash", "liveCostAdmissionBytes"])
    guard intent["schemaVersion"] == .number(1), intent["kind"] == .string("fixed-trial-admission-intent-v1"),
      intent["sourceBindingHash"] == .string(configuration.sourceBindingHash), intent["core"]?["artifactRoot"] == .string(root) else {
      throw ArkProtectedOwnerError.rejected("Intent root or binding differs")
    }
    try ArkProtectedObservationSchema.validate(.object(intent), named: "Intent")
    return (hash, .object(intent))
  }

  public func completedEvaluator(launchHash: String, artifactRoot: String) throws -> ArkProtectedEvaluator {
    guard ArkProtectedBytes.hashIsValid(launchHash) else { throw ArkProtectedOwnerError.rejected("Completed launch hash differs") }
    let path = URL(fileURLWithPath: artifactRoot).appendingPathComponent(launchHash)
    _ = try ArkProtectedRuntimePins.read(path, hash: launchHash)
    var pins = configuration.fileDigests; pins[path] = launchHash
    return ArkProtectedEvaluator(configuration: ArkProtectedEvaluatorConfiguration(nodeExecutable: configuration.nodeExecutable,
      entryPoint: configuration.entryPoint, configuration: path, workingDirectory: configuration.workingDirectory,
      fileDigests: pins, sourceBindingHash: configuration.sourceBindingHash))
  }

  public func completedLaunchHash() throws -> String {
    guard let pin = configuration.fileDigests[configuration.configuration] else { throw ArkProtectedOwnerError.rejected("Completed launch unpinned") }
    let bytes = try ArkProtectedRuntimePins.read(configuration.configuration, hash: pin)
    try ArkProtectedStrictJSON.validate(bytes)
    try ArkProtectedObservationSchema.validate(JSONDecoder().decode(JSONValue.self, from: bytes), named: "CompletedEvaluationLaunch")
    return ArkProtectedBytes.digest(bytes)
  }

  /// Register/admit require the exact pre-observation physical sources. Later
  /// describe calls permit append-only logs and task code changes by design.
  public func validateInitialObservationSources() throws {
    let (_, intent) = try admissionIntent()
    let core = intent["core"]!
    for slot in core["orderedSlots"]!.arrayValue! {
      let snapshot = core["sessionRoot"]!.stringValue! + "/" + slot["snapshotRelativePath"]!.stringValue!
      let ref = slot["startFence"]!["originalInitialSnapshotBytes"]!
      let bytes = try ArkProtectedRuntimePins.read(URL(fileURLWithPath: snapshot), hash: ref["hash"]!.stringValue!)
      guard bytes.count == ref["byteLength"]!.jsonSafeInteger() else { throw ArkProtectedOwnerError.rejected("Initial physical session bytes differ") }
      if slot["taskDefinition"]?["kind"] == .string("pagination-v1") {
        let task = slot["taskDefinition"]!
        let ref = task["initialCodeBytes"]!
        let path = core["projectRoot"]!.stringValue! + "/" + task["codePath"]!.stringValue!
        let bytes = try ArkProtectedRuntimePins.read(URL(fileURLWithPath: path), hash: ref["hash"]!.stringValue!)
        guard bytes.count == ref["byteLength"]!.jsonSafeInteger() else { throw ArkProtectedOwnerError.rejected("Initial task code bytes differ") }
      }
    }
  }

  public func observation(_ request: JSONValue) async throws -> Data {
    var bytes = try await run(request)
    // The fixed CLI emits one JSON line. Its LF is transport framing, not
    // part of the canonical content-addressed capture artifact.
    if bytes.last == 0x0a { bytes.removeLast() }
    try ArkProtectedStrictJSON.validate(bytes)
    return bytes
  }

  public func intentDescriptor() async throws -> ArkProtectedTrialDescriptor {
    let (hash, _) = try admissionIntent()
    let bytes = try await observation(.object(["schemaVersion": .number(1), "operation": .string("describeAdmissionIntentV1")]))
    let fields = try ArkProtectedBytes.object(bytes, keys: ["schemaVersion", "kind", "intentHash", "sourceBindingHash", "descriptor"])
    guard fields["schemaVersion"] == .number(1), fields["kind"] == .string("fixed-trial-admission-description-v1"),
      fields["intentHash"] == .string(hash), fields["sourceBindingHash"] == .string(configuration.sourceBindingHash),
      let value = fields["descriptor"] else { throw ArkProtectedOwnerError.rejected("Intent helper description differs") }
    let descriptor = try JSONDecoder().decode(ArkProtectedTrialDescriptor.self, from: ArkProtectedBytes.encode(value))
    try descriptor.validate()
    return descriptor
  }

  public func descriptor() async throws -> ArkProtectedTrialDescriptor {
    let bytes = try await run(.object(["schemaVersion": .number(1), "operation": .string("describeRegisteredTrial")]))
    let descriptor = try JSONDecoder().decode(ArkProtectedTrialDescriptor.self, from: bytes)
    try descriptor.validate()
    guard descriptor.sourceBindingHash == configuration.sourceBindingHash else { throw ArkProtectedOwnerError.rejected("Descriptor source binding differs") }
    return descriptor
  }

  public func evaluate(_ operation: ArkProtectedOperation, payload: JSONValue,
    descriptor: ArkProtectedTrialDescriptor) async throws -> ArkProtectedEvaluation {
    let request: JSONValue = operation == .sealPromotion
      ? .object(["operation": .string("sealPromotion"), "request": payload]) : payload
    // Binding covers the exact UTF-8 transport bytes. Recanonicalizing across
    // Swift and JavaScript changes legal floating-point spellings. Signature
    // bytes below remain the legacy TypeScript encoder output unchanged.
    let bytes = try await run(request)
    let value = try ArkProtectedBytes.object(bytes, keys: ["schemaVersion", "role", "signatureField", "canonicalBytes", "sealBinding"])
    let expectedRole = operation == .verifyCandidate && payload["schemaVersion"] == .number(2) ? "promotion" : operation.role
    guard value["schemaVersion"] == .number(1), value["role"] == .string(expectedRole),
      let raw = value["canonicalBytes"]?.stringValue, let canonical = Data(base64Encoded: raw), canonical.base64EncodedString() == raw,
      let signatureField = value["signatureField"]?.stringValue,
      let binding = value["sealBinding"]?.objectValue, Set(binding.keys) == ["operation", "requestHash", "sourceBindingHash"],
      binding["operation"] == .string(operation.rawValue),
      binding["sourceBindingHash"] == .string(descriptor.sourceBindingHash),
      binding["requestHash"] == .string(ArkProtectedBytes.digest(try ArkProtectedBytes.encode(request))) else {
      throw ArkProtectedOwnerError.rejected("Protected evaluator recipe binding differs")
    }
    let expectedField: String
    switch operation {
    case .sealPromotion: expectedField = "proof"
    case .signKnowledgeUseJournal: expectedField = "journalSignerSignature"
    case .verifyCandidate: expectedField = "proof"
    case .evaluateCapturedUse, .finalizeMeasuredTrial: expectedField = "evaluatorSignature"
    default: throw ArkProtectedOwnerError.rejected("Cost evidence is not a signing recipe")
    }
    guard signatureField == expectedField else { throw ArkProtectedOwnerError.rejected("Wrong signing domain") }
    return ArkProtectedEvaluation(canonicalBytes: canonical, signatureField: signatureField)
  }

  public func capturedCostUse(sessionID: String, snapshotHash: String) async throws -> JSONValue {
    let bytes = try await run(.object(["schemaVersion": .number(1), "operation": .string("describeCapturedCostUse"),
      "sessionId": .string(sessionID), "sessionSnapshotHash": .string(snapshotHash)]))
    return try JSONDecoder().decode(JSONValue.self, from: bytes)
  }

  private func validatePins() throws {
    guard configuration.nodeArguments.isEmpty, configuration.sourceTSConfig == nil,
      ArkProtectedBytes.hashIsValid(configuration.sourceBindingHash) else {
      throw ArkProtectedOwnerError.rejected("Protected evaluator requires a compiled packaged helper")
    }
    try ArkProtectedRuntimePins.validate(root: configuration.workingDirectory,
      node: configuration.nodeExecutable, entry: configuration.entryPoint,
      configuration: configuration.configuration, pins: configuration.fileDigests,
      helper: "knowledge-use-evaluator.mjs")
  }

  private func run(_ payload: JSONValue) async throws -> Data {
    try validatePins()
    try Task.checkCancellation()
    let input = try ArkProtectedBytes.encode(payload)
    guard input.count <= ArkProtectedBytes.maximumFrame else { throw ArkProtectedOwnerError.rejected("Evaluator request exceeds limit") }
    let owned = ArkProtectedEvaluatorProcess()
    let result = try await withTaskCancellationHandler {
      try await owned.run(configuration: configuration, input: input)
    } onCancel: { owned.cancel() }
    try Task.checkCancellation()
    try validatePins()
    return result
  }
}

private final class ArkProtectedEvaluatorProcess: @unchecked Sendable {
  private let lock = NSLock()
  private let process = Process()
  private let stdout = Pipe()
  private let stderr = Pipe()
  private let stdin = Pipe()
  private var output = Data()
  private var failure: String?
  private var cancelled = false
  private var started = false
  private var hardKill: DispatchWorkItem?
  private var deadline: DispatchWorkItem?

  func cancel() {
    lock.lock(); cancelled = true; let running = started && process.isRunning; lock.unlock()
    if running { terminate() }
  }

  private func terminate() {
    lock.lock()
    guard process.isRunning else { lock.unlock(); return }
    let pid = process.processIdentifier
    if hardKill == nil {
      let kill = DispatchWorkItem { [weak self] in
        guard let self else { return }
        self.lock.lock(); let running = self.process.isRunning; self.lock.unlock()
        if running { Darwin.kill(pid, SIGKILL) }
      }
      hardKill = kill
      DispatchQueue.global().asyncAfter(deadline: .now() + 3, execute: kill)
    }
    lock.unlock()
    process.terminate()
  }

  func run(configuration: ArkProtectedEvaluatorConfiguration, input: Data) async throws -> Data {
    try await withCheckedThrowingContinuation { continuation in
      process.executableURL = configuration.nodeExecutable
      process.arguments = configuration.nodeArguments + [configuration.entryPoint.path, configuration.configuration.path]
      process.currentDirectoryURL = configuration.workingDirectory
      process.environment = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "en_US.UTF-8"]
      if let tsconfig = configuration.sourceTSConfig { process.environment?["TSX_TSCONFIG_PATH"] = tsconfig.path }
      process.standardInput = stdin; process.standardOutput = stdout; process.standardError = stderr
      stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
        guard let self else { return }
        let bytes = handle.availableData
        self.lock.lock()
        if self.output.count + bytes.count > ArkProtectedBytes.maximumFrame {
          self.failure = "Evaluator output exceeds limit"
        } else { self.output.append(bytes) }
        let failed = self.failure != nil
        self.lock.unlock()
        if failed { self.terminate() }
      }
      // Drain stderr without retaining project text, credentials, or unbounded diagnostics.
      stderr.fileHandleForReading.readabilityHandler = { handle in _ = handle.availableData }
      process.terminationHandler = { [self] exited in
        stdout.fileHandleForReading.readabilityHandler = nil
        stderr.fileHandleForReading.readabilityHandler = nil
        let remainder = stdout.fileHandleForReading.readDataToEndOfFile()
        lock.lock()
        output.append(remainder)
        let result = output; let error = failure; let wasCancelled = cancelled
        deadline?.cancel(); hardKill?.cancel()
        lock.unlock()
        try? stdout.fileHandleForReading.close(); try? stderr.fileHandleForReading.close()
        try? stdin.fileHandleForWriting.close()
        if wasCancelled { continuation.resume(throwing: CancellationError()) }
        else if let error { continuation.resume(throwing: ArkProtectedOwnerError.rejected(error)) }
        else if exited.terminationReason != .exit || exited.terminationStatus != 0 || result.count > ArkProtectedBytes.maximumFrame {
          continuation.resume(throwing: ArkProtectedOwnerError.rejected("Owned evaluator failed: status \(exited.terminationStatus), reason \(exited.terminationReason.rawValue), bytes \(result.count)"))
        } else { continuation.resume(returning: result) }
      }
      do {
        lock.lock()
        if cancelled { lock.unlock(); throw CancellationError() }
        do { try process.run() } catch { lock.unlock(); throw error }
        started = true
        lock.unlock()
        let timer = DispatchWorkItem { [weak self] in
          guard let self else { return }
          self.lock.lock(); self.failure = "Evaluator deadline exceeded"; self.lock.unlock()
          self.terminate()
        }
        lock.lock(); deadline = timer; lock.unlock()
        DispatchQueue.global().asyncAfter(deadline: .now() + 125, execute: timer)
        DispatchQueue.global().async { [self] in
          do { try stdin.fileHandleForWriting.write(contentsOf: input); try stdin.fileHandleForWriting.close() }
          catch { lock.lock(); failure = "Evaluator input pipe failed"; lock.unlock(); terminate() }
        }
      } catch {
        stdout.fileHandleForReading.readabilityHandler = nil
        stderr.fileHandleForReading.readabilityHandler = nil
        continuation.resume(throwing: error)
      }
    }
  }
}
