import CryptoKit
import Darwin
import Foundation

/// Private IPC vocabulary. None of these operations can create or admit a grant.
public enum ArkProtectedOperation: String, Codable, CaseIterable, Sendable {
  case sealPromotion, signKnowledgeUseJournal, verifyCandidate, evaluateCapturedUse, finalizeMeasuredTrial
  case registerProviderDispatch, admitProviderRequest, recordProviderSettlement, resolveSettledUseCost

  public var role: String {
    switch self {
    case .sealPromotion: return "promotion"
    case .signKnowledgeUseJournal: return "journal"
    default: return "evaluator"
    }
  }
}

public enum ArkProtectedOwnerError: Error, LocalizedError {
  case rejected(String)
  public var errorDescription: String? {
    switch self { case .rejected(let reason): return reason }
  }
}

public enum ArkProtectedBytes {
  public static let maximumFrame = 8 * 1024 * 1024
  public static func digest(_ data: Data) -> String {
    let digits = Array("0123456789abcdef".utf8)
    var bytes = [UInt8](); bytes.reserveCapacity(64)
    for value in SHA256.hash(data: data) {
      bytes.append(digits[Int(value >> 4)]); bytes.append(digits[Int(value & 15)])
    }
    return String(decoding: bytes, as: UTF8.self)
  }
  public static func encode<T: Encodable>(_ value: T) throws -> Data {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return try encoder.encode(value)
  }
  public static func object(_ data: Data, keys: Set<String>) throws -> [String: JSONValue] {
    guard !data.isEmpty, data.count <= maximumFrame,
      let object = try JSONDecoder().decode(JSONValue.self, from: data).objectValue,
      Set(object.keys) == keys
    else { throw ArkProtectedOwnerError.rejected("Invalid private message fields or size") }
    return object
  }
  public static func hashIsValid(_ value: String) -> Bool {
    value.count == 64 && value.allSatisfy { $0.isASCII && ("0"..."9" ~= $0 || "a"..."f" ~= $0) }
  }
}

public struct ArkProtectedLiveCostAdmission: Codable, Equatable, Sendable {
  public let admissionHash: String
  public let ledgerArtifactHash: String
  public let maximumNewDispatches: Int
  public let maximumNewSettlements: Int
  public init(admissionHash: String, ledgerArtifactHash: String, maximumNewDispatches: Int, maximumNewSettlements: Int) {
    self.admissionHash = admissionHash; self.ledgerArtifactHash = ledgerArtifactHash
    self.maximumNewDispatches = maximumNewDispatches; self.maximumNewSettlements = maximumNewSettlements
  }
}

/// Reconstructed only by the protected evaluator from the existing signed grant,
/// preregistration, and frozen trial configuration. This never comes from plan text.
public struct ArkProtectedTrialDescriptor: Codable, Equatable, Sendable, Identifiable {
  public let schemaVersion: Int
  public let grantHash: String
  public let preRegistrationHash: String
  public let proposalHash: String
  public let candidateHash: String
  public let sourceBindingHash: String
  public let projectRoot: String
  public let profileIdentity: String
  public let buildIdentity: String
  public let expiresAt: String
  public let sessionIDs: [String]
  public let fixedOracleIDs: [String]
  public let operationLimits: [String: Int]
  public let liveCostAdmission: ArkProtectedLiveCostAdmission?
  public var id: String { grantHash }
  public var descriptorHash: String { (try? ArkProtectedBytes.digest(ArkProtectedBytes.encode(self))) ?? "" }

  public init(schemaVersion: Int = 1, grantHash: String, preRegistrationHash: String,
    proposalHash: String, candidateHash: String, sourceBindingHash: String, projectRoot: String,
    profileIdentity: String, buildIdentity: String, expiresAt: String, sessionIDs: [String],
    fixedOracleIDs: [String], operationLimits: [String: Int], liveCostAdmission: ArkProtectedLiveCostAdmission? = nil) {
    self.schemaVersion = schemaVersion; self.grantHash = grantHash
    self.preRegistrationHash = preRegistrationHash; self.proposalHash = proposalHash
    self.candidateHash = candidateHash; self.sourceBindingHash = sourceBindingHash
    self.projectRoot = projectRoot; self.profileIdentity = profileIdentity; self.buildIdentity = buildIdentity
    self.expiresAt = expiresAt; self.sessionIDs = sessionIDs; self.fixedOracleIDs = fixedOracleIDs
    self.operationLimits = operationLimits; self.liveCostAdmission = liveCostAdmission
  }

  public func validate(now: Date = Date()) throws {
    let date = ISO8601DateFormatter()
    date.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    guard schemaVersion == 1,
      [grantHash, preRegistrationHash, proposalHash, candidateHash, sourceBindingHash].allSatisfy(ArkProtectedBytes.hashIsValid),
      projectRoot.hasPrefix("/"), !profileIdentity.isEmpty, !buildIdentity.isEmpty,
      let expiry = date.date(from: expiresAt), expiry > now,
      !sessionIDs.isEmpty, Set(sessionIDs).count == sessionIDs.count,
      sessionIDs.allSatisfy({ !$0.isEmpty && $0.count <= 256 }),
      !fixedOracleIDs.isEmpty,
      fixedOracleIDs.allSatisfy({ ["pagination-v1", "invoice-v1", "single-line-v1"].contains($0) }),
      !operationLimits.isEmpty,
      operationLimits.allSatisfy({ ArkProtectedOperation(rawValue: $0.key) != nil && (0...4096).contains($0.value) })
    else { throw ArkProtectedOwnerError.rejected("Registered trial descriptor is invalid or expired") }
    if let live = liveCostAdmission {
      guard ArkProtectedBytes.hashIsValid(live.admissionHash), ArkProtectedBytes.hashIsValid(live.ledgerArtifactHash),
        (1...32).contains(live.maximumNewDispatches), (1...32).contains(live.maximumNewSettlements),
        operationLimits["registerProviderDispatch"] == live.maximumNewDispatches,
        operationLimits["recordProviderSettlement"] == live.maximumNewSettlements else {
        throw ArkProtectedOwnerError.rejected("Live cost admission bounds differ")
      }
    } else if (operationLimits["registerProviderDispatch"] ?? 0) > 0 || (operationLimits["recordProviderSettlement"] ?? 0) > 0 {
      throw ArkProtectedOwnerError.rejected("Live cost admission is not independently registered")
    }
  }
}

public struct ArkProtectedReservation: Codable, Sendable {
  public let requestDigest: String
  public let operation: ArkProtectedOperation
  public var phase: String
}

public struct ArkProtectedTrialState: Codable, Sendable {
  public let descriptor: ArkProtectedTrialDescriptor
  public var phase: String
  public var reservations: [ArkProtectedReservation]
  public var intentHash: String? = nil
  public var registrationEpoch: Int? = nil
  public var admissionEpoch: Int? = nil
  public var inflightEpoch: Int? = nil
  public var orderedSlotEpochs: [JSONValue]? = nil
  public var freeze: JSONValue? = nil
  public var collection: JSONValue? = nil
}

public struct ArkProtectedTrialReview: Codable, Sendable {
  public let descriptor: ArkProtectedTrialDescriptor
  public let phase: String
}

struct ArkProtectedState: Codable {
  var schemaVersion = 1
  var revision = 0
  var trials: [ArkProtectedTrialState] = []
  var costEntries: [JSONValue] = []
}

/// One locked directory and one atomic CAS file. Reserved records survive crashes.
/// No state is opened by the unprovisioned product. Deployment must provide a root
/// inaccessible to the evaluated workload; owner-only mode alone is not isolation.
public final class ArkProtectedStateStore {
  private let directory: Int32
  private let lockFile: Int32
  private var currentDigest: String?
  private var state: ArkProtectedState
  private let stateFilename: String
  public let observationVersion: Bool
  public let rootPath: String

  public init(root: URL, observationVersion: Bool = false) throws {
    self.observationVersion = observationVersion; rootPath = root.path
    stateFilename = observationVersion ? "owner-state-v2.json" : "owner-state-v1.json"
    guard root.isFileURL, root.path.hasPrefix("/") else { throw ArkProtectedOwnerError.rejected("State root must be absolute") }
    var descriptor = Darwin.open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC)
    guard descriptor >= 0 else { throw ArkProtectedOwnerError.rejected("Cannot open state root") }
    for component in root.path.split(separator: "/") {
      let next = Darwin.openat(descriptor, String(component), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
      Darwin.close(descriptor)
      guard next >= 0 else { throw ArkProtectedOwnerError.rejected("Unsafe state directory component: \(component), errno \(errno)") }
      descriptor = next
    }
    var info = stat()
    guard fstat(descriptor, &info) == 0, info.st_uid == getuid(), info.st_mode & 0o077 == 0 else {
      Darwin.close(descriptor); throw ArkProtectedOwnerError.rejected("State directory ownership or mode differs")
    }
    directory = descriptor
    let file = Darwin.openat(descriptor, "owner.lock", O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0o600)
    guard file >= 0 else { Darwin.close(descriptor); throw ArkProtectedOwnerError.rejected("Cannot open owner lock") }
    guard fstat(file, &info) == 0, info.st_uid == getuid(), info.st_nlink == 1,
      info.st_mode & S_IFMT == S_IFREG, info.st_mode & 0o077 == 0, flock(file, LOCK_EX | LOCK_NB) == 0 else {
      Darwin.close(file); Darwin.close(descriptor); throw ArkProtectedOwnerError.rejected("Owner state is locked or unsafe")
    }
    lockFile = file
    do {
      let bytes = try Self.read(directory, filename: stateFilename)
      if let bytes { _ = try ArkProtectedBytes.object(bytes, keys: ["schemaVersion", "revision", "trials", "costEntries"]) }
      currentDigest = bytes.map(ArkProtectedBytes.digest)
      state = try bytes.map { try JSONDecoder().decode(ArkProtectedState.self, from: $0) } ?? ArkProtectedState(schemaVersion: observationVersion ? 2 : 1)
      guard state.schemaVersion == (observationVersion ? 2 : 1), state.revision >= 0, state.trials.count <= 64,
        Set(state.trials.map { $0.descriptor.grantHash }).count == state.trials.count,
        state.trials.allSatisfy({ ["registered", "admitted", "revoked"].contains($0.phase)
          && $0.reservations.count <= 8192 && Set($0.reservations.map(\.requestDigest)).count == $0.reservations.count
          && $0.reservations.allSatisfy({ ["reserved", "spent", "revoked"].contains($0.phase) && ArkProtectedBytes.hashIsValid($0.requestDigest) }) })
      else { throw ArkProtectedOwnerError.rejected("Invalid private owner state") }
      if observationVersion {
        if let bytes { try ArkProtectedStrictJSON.validate(bytes); try ArkProtectedObservationSchema.validate(JSONDecoder().decode(JSONValue.self, from: bytes), named: "OwnerStateV2") }
        try ArkProtectedObservation.validateState(state.trials)
      }
      try Self.validateCostEntries(state.costEntries)
    } catch { Darwin.close(file); Darwin.close(descriptor); throw error }
  }

  deinit { flock(lockFile, LOCK_UN); Darwin.close(lockFile); Darwin.close(directory) }
  public var trials: [ArkProtectedTrialState] { state.trials }
  public var revision: Int { state.revision }

  public var costEntries: [JSONValue] { state.costEntries }

  public func replaceCostEntries(_ entries: [JSONValue]) throws {
    try Self.validateCostEntries(entries)
    var next = state; next.costEntries = entries
    try commit(next)
  }

  private static func validateCostEntries(_ entries: [JSONValue]) throws {
    guard entries.count <= 4096 else { throw ArkProtectedOwnerError.rejected("Cost evidence store is full") }
    var dispatches = Set<String>(); var attempts = Set<String>()
    for entry in entries {
      guard let fields = entry.objectValue, Set(fields.keys) == ["registration", "registrationArtifactHash", "attempts"],
        let registration = fields["registration"]?.objectValue,
        Set(registration.keys) == ["schemaVersion", "kind", "dispatchId", "descriptorHash", "sessionIdHash", "capturedRequestHash", "requestBodyHash", "maxTokens", "model", "sourceBindingHash"],
        registration["schemaVersion"] == .number(1), registration["kind"] == .string("registered-provider-dispatch-v1"),
        let dispatch = registration["dispatchId"]?.stringValue, !dispatch.isEmpty, dispatches.insert(dispatch).inserted,
        let tokens = registration["maxTokens"]?.jsonSafeInteger(minimum: 1), tokens <= 8192,
        registration["model"]?.stringValue?.isEmpty == false,
        ["descriptorHash", "sessionIdHash", "capturedRequestHash", "requestBodyHash", "sourceBindingHash"].allSatisfy({ registration[$0]?.stringValue.map(ArkProtectedBytes.hashIsValid) ?? false }),
        fields["registrationArtifactHash"] == .string(ArkProtectedBytes.digest(try ArkProtectedBytes.encode(JSONValue.object(registration)))),
        let observed = fields["attempts"]?.arrayValue, observed.count <= 32 else {
        throw ArkProtectedOwnerError.rejected("Invalid persisted cost registration")
      }
      for attempt in observed {
        guard let row = attempt.objectValue, let id = row["attemptId"]?.stringValue, !id.isEmpty,
          attempts.insert(id).inserted else { throw ArkProtectedOwnerError.rejected("Invalid persisted cost attempt") }
        if row["phase"] == .string("observed"), Set(row.keys) == ["attemptId", "phase"] { continue }
        guard row["phase"] == .string("settled"), Set(row.keys) == ["attemptId", "phase", "settlement", "settlementArtifactHash"],
          let settlement = row["settlement"]?.objectValue,
          Set(settlement.keys) == ["schemaVersion", "dispatchId", "attemptId", "sessionIdHash", "requestBodyHash", "maxTokens", "inputTokens", "outputTokens", "upperBoundMicroCny", "responseIdHash", "responseModel", "finishReason", "settledAt"],
          settlement["dispatchId"] == .string(dispatch), settlement["attemptId"] == .string(id),
          ["sessionIdHash", "requestBodyHash", "maxTokens"].allSatisfy({ settlement[$0] == registration[$0] }) else {
          throw ArkProtectedOwnerError.rejected("Invalid persisted cost settlement")
        }
        var artifact = settlement; artifact["kind"] = .string("settled-provider-attempt-v1"); artifact["sourceBindingHash"] = registration["sourceBindingHash"]
        guard row["settlementArtifactHash"] == .string(ArkProtectedBytes.digest(try ArkProtectedBytes.encode(JSONValue.object(artifact)))) else {
          throw ArkProtectedOwnerError.rejected("Persisted cost artifact binding differs")
        }
      }
    }
  }

  public func replace(_ trials: [ArkProtectedTrialState]) throws {
    var next = state; next.trials = trials
    try commit(next)
  }

  private func commit(_ selected: ArkProtectedState) throws {
    let trials = selected.trials
    guard trials.count <= 64, state.revision < Int.max,
      try Self.read(directory, filename: stateFilename).map(ArkProtectedBytes.digest) == currentDigest else {
      throw ArkProtectedOwnerError.rejected("Owner state changed outside its serialized owner")
    }
    var next = selected
    next.revision += 1
    if observationVersion { try ArkProtectedObservation.validateState(next.trials) }
    var bytes = try ArkProtectedBytes.encode(next)
    if observationVersion {
      var fields = try JSONDecoder().decode(JSONValue.self, from: bytes).objectValue!
      fields["trials"] = .array(zip(next.trials, fields["trials"]!.arrayValue!).map { trial, value in
        var row = value.objectValue!
        row["admissionEpoch"] = trial.admissionEpoch.map { .number(Double($0)) } ?? .null
        row["freeze"] = trial.freeze ?? .null
        return .object(row)
      })
      bytes = try ArkProtectedBytes.encode(JSONValue.object(fields))
    }
    if observationVersion { try ArkProtectedObservationSchema.validate(JSONDecoder().decode(JSONValue.self, from: bytes), named: "OwnerStateV2") }
    guard bytes.count <= ArkProtectedBytes.maximumFrame else { throw ArkProtectedOwnerError.rejected("Owner state is full") }
    let temporary = ".owner-\(UUID().uuidString)"
    let file = Darwin.openat(directory, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
    guard file >= 0 else { throw ArkProtectedOwnerError.rejected("Cannot reserve atomic state file") }
    defer { Darwin.close(file); unlinkat(directory, temporary, 0) }
    try bytes.withUnsafeBytes { buffer in
      var offset = 0
      while offset < buffer.count {
        let count = Darwin.write(file, buffer.baseAddress!.advanced(by: offset), buffer.count - offset)
        if count < 0 && errno == EINTR { continue }
        guard count > 0 else { throw ArkProtectedOwnerError.rejected("Owner state write failed") }
        offset += count
      }
    }
    guard fsync(file) == 0,
      try Self.read(directory, filename: stateFilename).map(ArkProtectedBytes.digest) == currentDigest,
      renameat(directory, temporary, directory, stateFilename) == 0,
      fsync(directory) == 0 else { throw ArkProtectedOwnerError.rejected("Owner state CAS or durable commit failed") }
    state = next; currentDigest = ArkProtectedBytes.digest(bytes)
  }

  public func putArtifact(_ bytes: Data) throws -> String {
    guard !bytes.isEmpty, bytes.count <= ArkProtectedBytes.maximumFrame else { throw ArkProtectedOwnerError.rejected("Cost artifact exceeds bounds") }
    let hash = ArkProtectedBytes.digest(bytes)
    let file = Darwin.openat(directory, hash, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
    if file < 0 && errno == EEXIST {
      let existing = Darwin.openat(directory, hash, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
      guard existing >= 0 else { throw ArkProtectedOwnerError.rejected("Cost artifact changed type") }
      defer { Darwin.close(existing) }
      var info = stat()
      guard fstat(existing, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_nlink == 1,
        info.st_size == bytes.count, info.st_uid == getuid(), info.st_mode & 0o077 == 0,
        try FileHandle(fileDescriptor: existing, closeOnDealloc: false).readToEnd() == bytes else {
        throw ArkProtectedOwnerError.rejected("Cost artifact collision or replacement")
      }
      return hash
    }
    guard file >= 0 else { throw ArkProtectedOwnerError.rejected("Cost artifact create failed") }
    defer { Darwin.close(file) }
    try FileHandle(fileDescriptor: file, closeOnDealloc: false).write(contentsOf: bytes)
    guard fsync(file) == 0, fsync(directory) == 0 else { throw ArkProtectedOwnerError.rejected("Cost artifact durable write failed") }
    return hash
  }

  private static func read(_ directory: Int32, filename: String) throws -> Data? {
    let file = Darwin.openat(directory, filename, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
    if file < 0 && errno == ENOENT { return nil }
    guard file >= 0 else { throw ArkProtectedOwnerError.rejected("Cannot read private state without following links") }
    defer { Darwin.close(file) }
    var info = stat()
    guard fstat(file, &info) == 0, info.st_mode & S_IFMT == S_IFREG,
      info.st_uid == getuid(), info.st_nlink == 1, info.st_mode & 0o077 == 0,
      info.st_size > 0, info.st_size <= ArkProtectedBytes.maximumFrame else {
      throw ArkProtectedOwnerError.rejected("Unsafe or oversized private state")
    }
    var bytes = Data(count: Int(info.st_size))
    try bytes.withUnsafeMutableBytes { buffer in
      var offset = 0
      while offset < buffer.count {
        let count = Darwin.read(file, buffer.baseAddress!.advanced(by: offset), buffer.count - offset)
        if count < 0 && errno == EINTR { continue }
        guard count > 0 else { throw ArkProtectedOwnerError.rejected("Short private state read") }
        offset += count
      }
    }
    var end = stat()
    guard fstat(file, &end) == 0, end.st_size == info.st_size, end.st_mtimespec.tv_sec == info.st_mtimespec.tv_sec, end.st_mtimespec.tv_nsec == info.st_mtimespec.tv_nsec else {
      throw ArkProtectedOwnerError.rejected("Private state changed while reading")
    }
    return bytes
  }
}

/// The evaluator supplies existing canonical bytes; Swift never reencodes them for signing.
public struct ArkProtectedEvaluation: Sendable {
  public let canonicalBytes: Data
  public let signatureField: String
  public init(canonicalBytes: Data, signatureField: String) {
    self.canonicalBytes = canonicalBytes; self.signatureField = signatureField
  }
}

/// Public registration metadata captured from the evaluator's independently
/// pinned configuration. It contains no keys beyond expected public SPKI bytes.
public struct ArkProtectedOwnerPublicBinding: Sendable {
  public let sourceBindingHash: String
  public let sourceIdentity: JSONValue
  public let artifactRoot: String
  public let projectRoot: String
  public let profileIdentity: String
  public let buildIdentity: String
  public let authorityIDs: [String: String]
  public let expectedPublicKeys: [String: Data]
  public init(sourceBindingHash: String, sourceIdentity: JSONValue, artifactRoot: String,
    projectRoot: String, profileIdentity: String, buildIdentity: String,
    authorityIDs: [String: String], expectedPublicKeys: [String: Data]) {
    self.sourceBindingHash = sourceBindingHash; self.sourceIdentity = sourceIdentity
    self.artifactRoot = artifactRoot; self.projectRoot = projectRoot
    self.profileIdentity = profileIdentity; self.buildIdentity = buildIdentity
    self.authorityIDs = authorityIDs; self.expectedPublicKeys = expectedPublicKeys
  }
  static let roles = ["promotion", "journal", "evaluator"]
  static let spkiPrefix = Data([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00])
  public static let disabledHello: JSONValue = .object(["version": .number(1), "ok": .bool(true),
    "ownerStatus": .string("disabled"), "authorities": .array([])])

  static func validateSourceIdentity(_ value: JSONValue) throws {
    guard let identity = value.objectValue, Set(identity.keys) == ["commit", "sourceDigest", "dirty", "dirtyDigest", "buildDigest"],
      let commit = identity["commit"]?.stringValue, commit.count == 40,
      commit.allSatisfy({ $0.isASCII && ("0"..."9" ~= $0 || "a"..."f" ~= $0) }),
      identity["dirty"] == .bool(true) || identity["dirty"] == .bool(false),
      ["sourceDigest", "dirtyDigest", "buildDigest"].allSatisfy({ identity[$0]?.stringValue.map(ArkProtectedBytes.hashIsValid) == true }) else {
      throw ArkProtectedOwnerError.rejected("Public source identity is malformed")
    }
  }

  /// Validate the existing v1 public hello at the XPC boundary before forwarding.
  public static func validateHello(_ bytes: Data) throws -> JSONValue {
    guard bytes.count <= ArkProtectedBytes.maximumFrame,
      let value = try JSONDecoder().decode(JSONValue.self, from: bytes).objectValue,
      value["version"] == .number(1), value["ok"] == .bool(true) else {
      throw ArkProtectedOwnerError.rejected("Protected owner public metadata is malformed")
    }
    if value["ownerStatus"] == .string("disabled") {
      guard Set(value.keys) == ["version", "ok", "ownerStatus", "authorities"], value["authorities"] == .array([]) else {
        throw ArkProtectedOwnerError.rejected("Disabled owner advertised authority metadata")
      }
      return .object(value)
    }
    guard Set(value.keys) == ["version", "ok", "ownerStatus", "sourceIdentity", "artifactRoot", "authorities"],
      value["ownerStatus"] == .string("ready"), let root = value["artifactRoot"]?.stringValue,
      root.hasPrefix("/"), !root.contains("\0"), let source = value["sourceIdentity"],
      let rows = value["authorities"]?.arrayValue, rows.count == 3 else {
      throw ArkProtectedOwnerError.rejected("Protected owner public identity differs")
    }
    try validateSourceIdentity(source)
    var seen = Set<String>(), binding: String?
    for row in rows {
      guard let item = row.objectValue, Set(item.keys) == ["role", "authorityId", "publicKeySpki", "sourceBindingHash"],
        let role = item["role"]?.stringValue, roles.contains(role), seen.insert(role).inserted,
        let id = item["authorityId"]?.stringValue, !id.isEmpty, id.count <= 256,
        let hash = item["sourceBindingHash"]?.stringValue, ArkProtectedBytes.hashIsValid(hash),
        binding == nil || binding == hash,
        let pem = item["publicKeySpki"]?.stringValue,
        pem.hasPrefix("-----BEGIN PUBLIC KEY-----\n"), pem.hasSuffix("\n-----END PUBLIC KEY-----\n") else {
        throw ArkProtectedOwnerError.rejected("Protected role metadata is malformed")
      }
      let body = pem.replacingOccurrences(of: "-----BEGIN PUBLIC KEY-----", with: "")
        .replacingOccurrences(of: "-----END PUBLIC KEY-----", with: "").components(separatedBy: .whitespacesAndNewlines).joined()
      guard let der = Data(base64Encoded: body), der.count == 44, der.starts(with: spkiPrefix) else {
        throw ArkProtectedOwnerError.rejected("Protected owner requires public Ed25519 SPKI")
      }
      binding = hash
    }
    return .object(value)
  }
}

/// Serialized pre-sign authority, independent of promotion WAL. Only App-local
/// methods admit/revoke; the Node operation method cannot do either.
public actor ArkProtectedOwner {
  public typealias Evaluate = @Sendable (ArkProtectedOperation, JSONValue, ArkProtectedTrialDescriptor) async throws -> ArkProtectedEvaluation
  public typealias Revalidate = @Sendable (ArkProtectedTrialDescriptor) async throws -> ArkProtectedTrialDescriptor
  let store: ArkProtectedStateStore
  private let evaluate: Evaluate
  let revalidate: Revalidate
  private let signers: [String: Curve25519.Signing.PrivateKey]
  let costOwner: ArkProtectedCostOwner?
  let observationEvaluator: ArkProtectedEvaluator?
  var ownedSlotJoins: [String: BackendProcessJoinedLaunch] = [:]
  var ownedGuardJoin: BackendProcessJoinedLaunch?
  var frozenProducerGeneration: UUID?
  var completedEvaluator: ArkProtectedEvaluator?
  var collectingChannelGeneration: UUID?
  var guardChannelGeneration: UUID?
  var observationPreparedArtifacts: [String: [String: Int]] = [:]
  let publicBinding: ArkProtectedOwnerPublicBinding?
  private var nonces: [String: String] = [:]

  public init(store: ArkProtectedStateStore, signers: [String: Curve25519.Signing.PrivateKey],
    revalidate: @escaping Revalidate, evaluate: @escaping Evaluate, costOwner: ArkProtectedCostOwner? = nil,
    publicBinding: ArkProtectedOwnerPublicBinding? = nil, observationEvaluator: ArkProtectedEvaluator? = nil) {
    self.store = store; self.signers = signers; self.revalidate = revalidate; self.evaluate = evaluate; self.costOwner = costOwner
    self.publicBinding = publicBinding; self.observationEvaluator = observationEvaluator
  }

  /// Availability advertises actual public keys, never admission or user intent.
  public func launchHello() throws -> JSONValue { try publicHello(descriptors: store.trials.map(\.descriptor)) }

  func publicHello(descriptors: [ArkProtectedTrialDescriptor]) throws -> JSONValue {
    guard let binding = publicBinding else { return ArkProtectedOwnerPublicBinding.disabledHello }
    guard Set(signers.keys) == Set(ArkProtectedOwnerPublicBinding.roles),
      Set(binding.authorityIDs.keys) == Set(ArkProtectedOwnerPublicBinding.roles),
      binding.authorityIDs["journal"] != binding.authorityIDs["evaluator"],
      binding.expectedPublicKeys["journal"] != nil, binding.expectedPublicKeys["evaluator"] != nil else {
      throw ArkProtectedOwnerError.rejected("Owner signing roles are incomplete")
    }
    guard signers["journal"]!.publicKey.rawRepresentation != signers["evaluator"]!.publicKey.rawRepresentation else {
      throw ArkProtectedOwnerError.rejected("Evaluator and journal signer must use distinct keys")
    }
    var rows = [JSONValue]()
    for role in ArkProtectedOwnerPublicBinding.roles {
      let der = ArkProtectedOwnerPublicBinding.spkiPrefix + signers[role]!.publicKey.rawRepresentation
      if let expected = binding.expectedPublicKeys[role], der != expected {
        throw ArkProtectedOwnerError.rejected("Pinned evaluator key differs from Native signer")
      }
      let pem = "-----BEGIN PUBLIC KEY-----\n" + der.base64EncodedString() + "\n-----END PUBLIC KEY-----\n"
      rows.append(.object(["role": .string(role), "authorityId": .string(binding.authorityIDs[role]!),
        "publicKeySpki": .string(pem), "sourceBindingHash": .string(binding.sourceBindingHash)]))
    }
    guard !descriptors.isEmpty, descriptors.allSatisfy({
      $0.sourceBindingHash == binding.sourceBindingHash && $0.projectRoot == binding.projectRoot
        && $0.profileIdentity == binding.profileIdentity && $0.buildIdentity == binding.buildIdentity
    }) else { throw ArkProtectedOwnerError.rejected("Owner public metadata is not bound to its registered trial") }
    let hello: JSONValue = .object(["version": .number(1), "ok": .bool(true), "ownerStatus": .string("ready"),
      "sourceIdentity": binding.sourceIdentity, "artifactRoot": .string(binding.artifactRoot), "authorities": .array(rows)])
    return try ArkProtectedOwnerPublicBinding.validateHello(ArkProtectedBytes.encode(hello))
  }

  public func register(_ descriptor: ArkProtectedTrialDescriptor) async throws {
    guard !store.observationVersion else { throw ArkProtectedOwnerError.rejected("Observation registration requires an immutable intent") }
    try descriptor.validate()
    if let binding = publicBinding {
      _ = try publicHello(descriptors: [descriptor])
      guard descriptor.sourceBindingHash == binding.sourceBindingHash, descriptor.projectRoot == binding.projectRoot,
        descriptor.profileIdentity == binding.profileIdentity, descriptor.buildIdentity == binding.buildIdentity else {
        throw ArkProtectedOwnerError.rejected("Trial differs from pinned public registration")
      }
    }
    let revision = store.revision
    guard try await revalidate(descriptor) == descriptor, store.revision == revision else { throw ArkProtectedOwnerError.rejected("Registered grant or sources changed") }
    try Task.checkCancellation()
    var trials = store.trials
    if let existing = trials.first(where: { $0.descriptor.id == descriptor.id }) {
      guard existing.descriptor == descriptor else { throw ArkProtectedOwnerError.rejected("Trial registration cannot be replaced") }
      return
    }
    trials.append(ArkProtectedTrialState(descriptor: descriptor, phase: "registered", reservations: []))
    try store.replace(trials)
  }

  public func pendingDescriptors() -> [ArkProtectedTrialReview] {
    store.trials.filter { $0.phase != "revoked" }.map { ArkProtectedTrialReview(descriptor: $0.descriptor, phase: $0.phase) }
  }

  /// A nonce is minted only for the descriptor actually displayed by the App.
  public func prepareConfirmation(descriptorHash: String) throws -> String {
    guard let trial = store.trials.first(where: { $0.descriptor.descriptorHash == descriptorHash }),
      trial.phase == "registered" else { throw ArkProtectedOwnerError.rejected("Trial is unavailable for confirmation") }
    try trial.descriptor.validate()
    let nonce = UUID().uuidString + UUID().uuidString
    nonces[descriptorHash] = nonce
    return nonce
  }

  public func admit(descriptorHash: String, nonce: String) async throws {
    guard nonces.removeValue(forKey: descriptorHash) == nonce else { throw ArkProtectedOwnerError.rejected("Confirmation nonce is absent or spent") }
    guard let initial = store.trials.first(where: { $0.descriptor.descriptorHash == descriptorHash }),
      initial.phase == "registered" else { throw ArkProtectedOwnerError.rejected("Trial is no longer registered") }
    try initial.descriptor.validate()
    let revision = store.revision
    if store.observationVersion { try observationEvaluator?.validateInitialObservationSources() }
    guard try await revalidate(initial.descriptor) == initial.descriptor, store.revision == revision else { throw ArkProtectedOwnerError.rejected("Trial changed since confirmation") }
    try Task.checkCancellation()
    if store.observationVersion { try observationEvaluator?.validateInitialObservationSources() }
    var trials = store.trials
    guard let index = trials.firstIndex(where: { $0.descriptor.descriptorHash == descriptorHash }),
      trials[index].phase == "registered" else { throw ArkProtectedOwnerError.rejected("Trial was revoked during confirmation") }
    trials[index].phase = "admitted"
    if store.observationVersion {
      trials[index].admissionEpoch = store.revision + 1

    }
    try store.replace(trials)
  }

  public func revoke(descriptorHash: String) throws {
    nonces.removeValue(forKey: descriptorHash)
    var trials = store.trials
    guard let index = trials.firstIndex(where: { $0.descriptor.descriptorHash == descriptorHash }) else {
      throw ArkProtectedOwnerError.rejected("Unknown trial")
    }
    if store.observationVersion, var collection = trials[index].collection?.objectValue {
      // I/O uncertainty keeps nullable failure evidence; revocation still denies
      // every future operation and never resets the known capture/reservation set.
      let failureEvidence = try? observationFailureAudit(trials[index])
      collection["phase"] = .string("failed"); collection["reason"] = .string("revoked")
      collection["failureEvidenceHash"] = failureEvidence.map(JSONValue.string) ?? .null
      trials[index].collection = .object(collection)
    }
    trials[index].phase = "revoked"
    for reservation in trials[index].reservations.indices where trials[index].reservations[reservation].phase == "reserved" {
      trials[index].reservations[reservation].phase = "revoked"
    }
    try store.replace(trials)
  }

  public func perform(_ operation: ArkProtectedOperation, payload: JSONValue, origin: ArkProtectedPeerRole = .backend, channelGeneration: UUID? = nil, trustedAppControl: Bool = false) async throws -> JSONValue {
    guard origin.permits(operation) else { throw ArkProtectedOwnerError.rejected("Operation is not permitted for the kernel-authenticated peer role") }
    try Task.checkCancellation()
    let role = operation == .verifyCandidate && payload["schemaVersion"] == .number(2) ? "promotion" : operation.role

    // Resolver rejects ambiguity. The evaluator reopens the exact signed references
    // and validates all operation-specific fields before any signature is released.
    // The adapter also observes ordinary conversations. A session that was never
    // registered has no protected cost participation; revoked registered sessions
    // remain refusals instead of silently escaping the finite admission.
    if operation == .registerProviderDispatch, let session = payload["sessionId"]?.stringValue,
      !store.trials.contains(where: { $0.descriptor.sessionIDs.contains(session) }) {
      return .object(["status": .string("untracked")])
    }
    let eligible = store.trials.filter { trial in
      guard trial.phase == "admitted", (trial.descriptor.operationLimits[operation == .admitProviderRequest ? "recordProviderSettlement" : operation.rawValue] ?? 0) > 0 else { return false }
      if let grant = payload["grantHash"]?.stringValue { return grant == trial.descriptor.grantHash }
      if let session = payload["sessionId"]?.stringValue { return trial.descriptor.sessionIDs.contains(session) }
      if let hash = payload["sessionIdHash"]?.stringValue { return trial.descriptor.sessionIDs.contains { ArkProtectedCostOwner.sessionHash($0) == hash } }
      return true
    }
    guard eligible.count == 1, let trial = eligible.first else { throw ArkProtectedOwnerError.rejected("No unique admitted trial") }
    try trial.descriptor.validate()
    if store.observationVersion {
      let isCost = [.registerProviderDispatch, .admitProviderRequest, .recordProviderSettlement, .resolveSettledUseCost].contains(operation)
      if isCost && !(operation == .resolveSettledUseCost && trial.freeze?["phase"] == .string("frozen")) {
        guard trial.freeze == nil, trial.collection?["phase"] == .string("collecting"),
          let cursor = trial.collection?["nextSlotIndex"]?.jsonSafeInteger(), cursor < trial.descriptor.sessionIDs.count else {
          throw ArkProtectedOwnerError.rejected("Observation phase denies tracked cost mutations")
        }
        guard trustedAppControl || (channelGeneration != nil &&
          channelGeneration == (origin == .guardProcess ? guardChannelGeneration : collectingChannelGeneration)) else {
          throw ArkProtectedOwnerError.rejected("Current owned cost channel differs")
        }
        let currentSession = trial.descriptor.sessionIDs[cursor]
        guard payload["sessionId"] == .string(currentSession) || payload["sessionIdHash"] == .string(ArkProtectedCostOwner.sessionHash(currentSession)) else {
          throw ArkProtectedOwnerError.rejected("Cost request does not belong to the current ordered slot")
        }
      } else {
        guard trial.freeze?["phase"] == .string("frozen"), origin == .offlineProducer,
          (trustedAppControl || (channelGeneration != nil && channelGeneration == frozenProducerGeneration)), completedEvaluator != nil else {
          throw ArkProtectedOwnerError.rejected("Only exact fresh frozen offline producer may sign")
        }
      }
    }
    if operation == .registerProviderDispatch || operation == .admitProviderRequest || operation == .recordProviderSettlement || operation == .resolveSettledUseCost {
      guard let costOwner else { throw ArkProtectedOwnerError.rejected("Independent cost owner is not provisioned") }
      if store.observationVersion, operation == .resolveSettledUseCost, trial.freeze?["phase"] == .string("frozen") {
        return try await resolveFrozenCost(payload, trial: trial, costOwner: costOwner)
      }
      let prepareArtifact: ((Data) throws -> Void)?
      if store.observationVersion, let evaluator = observationEvaluator {
        let (_, intent) = try evaluator.admissionIntent()
        let root = intent["core"]!["artifactRoot"]!.stringValue!, generation = trial.collection!["generationId"]!.stringValue!
        prepareArtifact = { bytes in try self.prepareNativeObservationArtifact(bytes, root: root, generation: generation, copyToOwner: true) }
      } else { prepareArtifact = nil }
      let costRevision = store.revision
      guard try await revalidate(trial.descriptor) == trial.descriptor, store.revision == costRevision else { throw ArkProtectedOwnerError.rejected("Registered cost trial changed") }
      try requireCurrentAdmission(trial.descriptor)
      if operation == .resolveSettledUseCost {
        let captured = try await costOwner.captureForResolution(payload, descriptor: trial.descriptor)
        guard store.revision == costRevision else { throw ArkProtectedOwnerError.rejected("Cost resolution actor fence conflict") }
        try requireCurrentAdmission(trial.descriptor)
        return try costOwner.resolveCaptured(payload, descriptor: trial.descriptor, captured: captured, prepareArtifact: prepareArtifact)
      }
      if store.observationVersion, operation == .registerProviderDispatch {
        var current = store.trials
        let currentIndex = current.firstIndex(where: { $0.descriptor == trial.descriptor })!
        var epochs = current[currentIndex].orderedSlotEpochs!
        let cursor = current[currentIndex].collection!["nextSlotIndex"]!.jsonSafeInteger()!
        var slot = epochs[cursor].objectValue!
        slot["firstDispatchEpoch"] = .number(Double(current[currentIndex].admissionEpoch!))
        epochs[cursor] = .object(slot); current[currentIndex].orderedSlotEpochs = epochs
        try store.replace(current)
      }
      return try costOwner.performImmediate(operation, payload: payload, descriptor: trial.descriptor, origin: origin, prepareArtifact: prepareArtifact)
    }
    guard let key = signers[role] else { throw ArkProtectedOwnerError.rejected("Authority is not provisioned") }
    let requestDigest = ArkProtectedBytes.digest(try ArkProtectedBytes.encode(JSONValue.object([
      "operation": .string(operation.rawValue), "payload": payload,
    ])))
    var trials = store.trials
    let index = trials.firstIndex(where: { $0.descriptor.id == trial.descriptor.id })!
    let reservations = trials[index].reservations
    guard !reservations.contains(where: { $0.requestDigest == requestDigest }),
      reservations.filter({ $0.operation == operation }).count < trial.descriptor.operationLimits[operation.rawValue]!,
      reservations.count < 8192 else { throw ArkProtectedOwnerError.rejected("Request was reserved, spent, revoked, or exceeded its finite limit") }
    trials[index].reservations.append(ArkProtectedReservation(requestDigest: requestDigest, operation: operation, phase: "reserved"))
    try store.replace(trials)
    // No failure path refunds a reservation. Restart preserves uncertainty.
    let signingRevision = store.revision
    let selectedDescriptor: ArkProtectedTrialDescriptor
    if let completedEvaluator { selectedDescriptor = try await completedEvaluator.descriptor() }
    else { selectedDescriptor = try await revalidate(trial.descriptor) }
    guard selectedDescriptor == trial.descriptor, store.revision == signingRevision else { throw ArkProtectedOwnerError.rejected("Registered evidence changed") }
    let result: ArkProtectedEvaluation
    if let completedEvaluator { result = try await completedEvaluator.evaluate(operation, payload: payload, descriptor: trial.descriptor) }
    else { result = try await evaluate(operation, payload, trial.descriptor) }
    guard store.revision == signingRevision else { throw ArkProtectedOwnerError.rejected("Signing actor fence conflict") }
    try Task.checkCancellation()
    try trial.descriptor.validate()
    trials = store.trials
    guard let finalIndex = trials.firstIndex(where: { $0.descriptor.id == trial.descriptor.id }),
      trials[finalIndex].phase == "admitted",
      let reservation = trials[finalIndex].reservations.firstIndex(where: { $0.requestDigest == requestDigest }),
      trials[finalIndex].reservations[reservation].phase == "reserved" else {
      throw ArkProtectedOwnerError.rejected("Trial was revoked while evaluating")
    }
    guard !result.canonicalBytes.isEmpty, result.canonicalBytes.count <= ArkProtectedBytes.maximumFrame,
      var body = try JSONDecoder().decode(JSONValue.self, from: result.canonicalBytes).objectValue,
      ["proof", "evaluatorSignature", "journalSignerSignature", "signature"].contains(result.signatureField), body[result.signatureField] == nil else {
      throw ArkProtectedOwnerError.rejected("Evaluator returned an invalid closed signing result")
    }
    let signature = try key.signature(for: result.canonicalBytes)
    trials[finalIndex].reservations[reservation].phase = "spent"
    try store.replace(trials)
    if operation == .sealPromotion {
      guard let authority = payload["authorityId"] else { throw ArkProtectedOwnerError.rejected("Promotion authority is absent") }
      return .object(["authorityId": authority, "proof": .string(signature.base64EncodedString())])
    }
    if operation == .signKnowledgeUseJournal { return .object(["signature": .string(signature.base64EncodedString())]) }
    body[result.signatureField] = .string(signature.base64EncodedString())
    if operation == .evaluateCapturedUse || operation == .finalizeMeasuredTrial {
      return .object(["artifactBase64": .string(try ArkProtectedBytes.encode(JSONValue.object(body)).base64EncodedString())])
    }
    return .object(body)
  }
  private func requireCurrentAdmission(_ descriptor: ArkProtectedTrialDescriptor) throws {
    try Task.checkCancellation()
    try descriptor.validate()
    guard store.trials.contains(where: { $0.descriptor == descriptor && $0.phase == "admitted" }) else {
      throw ArkProtectedOwnerError.rejected("Trial was revoked while independently validating cost evidence")
    }
  }

}
