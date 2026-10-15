import Darwin
import Foundation

/// Assigned by the App's actual child/listener ownership, never decoded from a
/// Node payload. The guard has its own PID, launch generation and socket token.
public enum ArkProtectedPeerRole: String, Sendable {
  case backend, guardProcess, offlineProducer
  public func permits(_ operation: ArkProtectedOperation) -> Bool {
    switch operation {
    case .admitProviderRequest, .recordProviderSettlement: return self == .guardProcess
    case .registerProviderDispatch: return self == .backend
    case .resolveSettledUseCost: return self == .backend || self == .offlineProducer
    default: return self == .backend || self == .offlineProducer
    }
  }
}

public struct ArkProtectedCostConfiguration: Sendable {
  public let ledgerPath: URL
  public let initialLedgerHash: String
  public let endpoint: String
  public let provider: String
  public let configuredModel: String
  public let wireModel: String
  public let maximumNewDispatches: Int
  public let maximumNewSettlements: Int
  public let sourceBindingHash: String
  public init(ledgerPath: URL, initialLedgerHash: String, endpoint: String, provider: String,
    configuredModel: String, wireModel: String, maximumNewDispatches: Int, maximumNewSettlements: Int? = nil, sourceBindingHash: String) {
    self.ledgerPath = ledgerPath; self.initialLedgerHash = initialLedgerHash; self.endpoint = endpoint
    self.provider = provider; self.configuredModel = configuredModel; self.wireModel = wireModel
    self.maximumNewDispatches = maximumNewDispatches; self.maximumNewSettlements = maximumNewSettlements ?? maximumNewDispatches
    self.sourceBindingHash = sourceBindingHash
  }
}

/// Independent private evidence owner. It never writes the schema-2 budget ledger
/// and never consumes a trial/use grant. Duplicate/missing attempts remain unknown.
public final class ArkProtectedCostOwner: @unchecked Sendable {
  private let mutationLock = NSLock()
  public typealias Capture = @Sendable (String, String) async throws -> JSONValue
  private let store: ArkProtectedStateStore
  private let configuration: ArkProtectedCostConfiguration
  private let capture: Capture
  private let initialRequestCount: Int

  public init(store: ArkProtectedStateStore, configuration: ArkProtectedCostConfiguration, capture: @escaping Capture) throws {
    self.store = store; self.configuration = configuration; self.capture = capture
    let (bytes, ledger) = try Self.readLedger(configuration.ledgerPath)
    guard ArkProtectedBytes.digest(bytes) == configuration.initialLedgerHash,
      ArkProtectedBytes.hashIsValid(configuration.sourceBindingHash),
      let count = ledger["requestCount"]?.jsonSafeInteger(),
      configuration.maximumNewDispatches >= 0, configuration.maximumNewDispatches <= 32 - count,
      configuration.maximumNewSettlements >= 0, configuration.maximumNewSettlements <= 32 - count else {
      throw ArkProtectedOwnerError.rejected("Cost admission is not bound to the existing budget ledger")
    }
    initialRequestCount = count
  }

  /// Called synchronously by ArkProtectedOwner after its last authorization check.
  /// No suspension separates that check from durable evidence mutation.
  func performImmediate(_ operation: ArkProtectedOperation, payload: JSONValue,
    descriptor: ArkProtectedTrialDescriptor, origin: ArkProtectedPeerRole, prepareArtifact: ((Data) throws -> Void)? = nil) throws -> JSONValue {
    mutationLock.lock(); defer { mutationLock.unlock() }
    guard origin.permits(operation), configuration.sourceBindingHash == descriptor.sourceBindingHash else {
      throw ArkProtectedOwnerError.rejected("Cost evidence peer or source binding differs")
    }
    try descriptor.validate()
    guard let live = descriptor.liveCostAdmission, live.ledgerArtifactHash == configuration.initialLedgerHash,
      live.maximumNewDispatches == configuration.maximumNewDispatches,
      live.maximumNewSettlements == configuration.maximumNewSettlements else {
      throw ArkProtectedOwnerError.rejected("Live cost admission is not bound to the pinned existing ledger and limits")
    }
    switch operation {
    case .registerProviderDispatch: return try register(payload, descriptor: descriptor, prepareArtifact: prepareArtifact)
    case .admitProviderRequest: return try admit(payload, descriptor: descriptor)
    case .recordProviderSettlement: return try settle(payload, descriptor: descriptor, prepareArtifact: prepareArtifact)
    default: throw ArkProtectedOwnerError.rejected("Not a cost evidence operation")
    }
  }

  private func register(_ payload: JSONValue, descriptor: ArkProtectedTrialDescriptor, prepareArtifact: ((Data) throws -> Void)?) throws -> JSONValue {
    let row = try fields(payload, ["schemaVersion", "kind", "sessionId", "endpoint", "provider", "configuredModel", "wireModel", "requestBodyHash", "maxTokens", "capturedRequestHash"])
    guard row["schemaVersion"] == .number(1), row["kind"] == .string("adapter"),
      let session = row["sessionId"]?.stringValue, descriptor.sessionIDs.contains(session),
      row["endpoint"] == .string(configuration.endpoint), row["provider"] == .string(configuration.provider),
      row["configuredModel"] == .string(configuration.configuredModel), row["wireModel"] == .string(configuration.wireModel),
      let tokens = row["maxTokens"]?.jsonSafeInteger(minimum: 1), tokens <= 8192,
      validHash(row["requestBodyHash"]), validHash(row["capturedRequestHash"]) else {
      throw ArkProtectedOwnerError.rejected("Registered trial dispatch differs from its fixed route, bytes, or finite output cap")
    }
    let (_, ledger) = try Self.readLedger(configuration.ledgerPath)
    guard let count = ledger["requestCount"]?.jsonSafeInteger(), count >= initialRequestCount,
      count < 32, store.costEntries.count < configuration.maximumNewDispatches,
      store.costEntries.count < (descriptor.operationLimits["registerProviderDispatch"] ?? 0) else {
      throw ArkProtectedOwnerError.rejected("Registered cost dispatch limit is exhausted")
    }
    let dispatchID = UUID().uuidString
    let record: JSONValue = .object(["schemaVersion": .number(1), "kind": .string("registered-provider-dispatch-v1"),
      "dispatchId": .string(dispatchID), "descriptorHash": .string(descriptor.descriptorHash),
      "sessionIdHash": .string(Self.sessionHash(session)), "capturedRequestHash": row["capturedRequestHash"]!,
      "requestBodyHash": row["requestBodyHash"]!, "maxTokens": .number(Double(tokens)),
      "model": .string(configuration.wireModel), "sourceBindingHash": .string(configuration.sourceBindingHash)])
    let registrationBytes = try ArkProtectedBytes.encode(record)
    try prepareArtifact?(registrationBytes)
    let artifact = try store.putArtifact(registrationBytes)
    let entry: JSONValue = .object(["registration": record, "registrationArtifactHash": .string(artifact), "attempts": .array([])])
    try store.replaceCostEntries(store.costEntries + [entry])
    return .object(["status": .string("registered"), "dispatchId": .string(dispatchID)])
  }

  private func admittedRecord(_ row: [String: JSONValue], descriptor: ArkProtectedTrialDescriptor) throws -> Int {
    guard row["schemaVersion"] == .number(1), let dispatch = row["dispatchId"]?.stringValue,
      let attempt = row["attemptId"]?.stringValue, !attempt.isEmpty, attempt.count <= 160,
      let index = store.costEntries.firstIndex(where: { $0["registration"]?["dispatchId"] == .string(dispatch) }),
      let registration = store.costEntries[index]["registration"]?.objectValue,
      registration["descriptorHash"] == .string(descriptor.descriptorHash),
      ["sessionIdHash", "requestBodyHash", "maxTokens"].allSatisfy({ registration[$0] == row[$0] }) else {
      throw ArkProtectedOwnerError.rejected("Guard ingress does not match an authenticated adapter registration")
    }
    return index
  }

  private func admit(_ payload: JSONValue, descriptor: ArkProtectedTrialDescriptor) throws -> JSONValue {
    let row = try fields(payload, ["schemaVersion", "dispatchId", "attemptId", "sessionIdHash", "requestBodyHash", "maxTokens"])
    let index = try admittedRecord(row, descriptor: descriptor)
    var entries = store.costEntries
    var entry = entries[index].objectValue!
    var attempts = entry["attempts"]?.arrayValue ?? []
    guard !entries.contains(where: { ($0["attempts"]?.arrayValue ?? []).contains(where: { $0["attemptId"] == row["attemptId"] }) }) else {
      throw ArkProtectedOwnerError.rejected("Guard attempt identifier was already observed")
    }
    guard entries.reduce(0, { $0 + ($1["attempts"]?.arrayValue?.count ?? 0) }) < configuration.maximumNewSettlements else {
      throw ArkProtectedOwnerError.rejected("Registered finite guard attempt limit is exhausted")
    }
    // Evidence records observed ingress only. The guard remains the sole budget
    // reserve/settle owner and this method does not reserve any trial signature.
    attempts.append(.object(["attemptId": row["attemptId"]!, "phase": .string("observed")]))
    entry["attempts"] = .array(attempts); entries[index] = .object(entry)
    try store.replaceCostEntries(entries)
    return .object(["status": .string("matched")])
  }

  private func settle(_ payload: JSONValue, descriptor: ArkProtectedTrialDescriptor, prepareArtifact: ((Data) throws -> Void)?) throws -> JSONValue {
    let row = try fields(payload, ["schemaVersion", "dispatchId", "attemptId", "sessionIdHash", "requestBodyHash", "maxTokens",
      "inputTokens", "outputTokens", "upperBoundMicroCny", "responseIdHash", "responseModel", "finishReason", "settledAt"])
    let index = try admittedRecord(row, descriptor: descriptor)
    guard let input = row["inputTokens"]?.jsonSafeInteger(), let output = row["outputTokens"]?.jsonSafeInteger(),
      input + output <= 1_048_576, let maximum = row["maxTokens"]?.jsonSafeInteger(), output <= maximum,
      row["upperBoundMicroCny"] == .number(Double(input * 2 + output * 8)),
      validHash(row["responseIdHash"]), row["responseModel"] == .string(configuration.wireModel),
      let reason = row["finishReason"]?.stringValue, ["stop", "length", "tool_calls"].contains(reason),
      let settled = row["settledAt"]?.stringValue, Self.date(settled) != nil else {
      throw ArkProtectedOwnerError.rejected("Guard settlement lacks complete bounded usage")
    }
    var entries = store.costEntries
    var entry = entries[index].objectValue!
    var attempts = entry["attempts"]!.arrayValue!
    guard let attempt = attempts.firstIndex(where: { $0["attemptId"] == row["attemptId"] }),
      attempts[attempt]["phase"] == .string("observed") else { throw ArkProtectedOwnerError.rejected("Unobserved or duplicate guard settlement") }
    var artifact = row
    artifact["kind"] = .string("settled-provider-attempt-v1")
    artifact["sourceBindingHash"] = .string(configuration.sourceBindingHash)
    let settlementBytes = try ArkProtectedBytes.encode(JSONValue.object(artifact))
    try prepareArtifact?(settlementBytes)
    let artifactHash = try store.putArtifact(settlementBytes)
    attempts[attempt] = .object(["attemptId": row["attemptId"]!, "phase": .string("settled"),
      "settlement": .object(row), "settlementArtifactHash": .string(artifactHash)])
    entry["attempts"] = .array(attempts); entries[index] = .object(entry)
    try store.replaceCostEntries(entries)
    return .object(["status": .string("recorded"), "artifactHash": .string(artifactHash)])
  }

  private func resolveFields(_ payload: JSONValue, descriptor: ArkProtectedTrialDescriptor) throws -> [String: JSONValue] {
    let row = try fields(payload, ["schemaVersion", "operation", "sessionId", "sessionSnapshotHash", "capturedRequestHashes"])
    guard row["schemaVersion"] == .number(1), row["operation"] == .string("resolve-settled-use-cost-v1"),
      let session = row["sessionId"]?.stringValue, descriptor.sessionIDs.contains(session),
      let snapshot = row["sessionSnapshotHash"]?.stringValue, ArkProtectedBytes.hashIsValid(snapshot) else {
      throw ArkProtectedOwnerError.rejected("Cost resolver registration differs")
    }
    return row
  }

  /// Reads independently owned capture only; it cannot mutate or publish evidence.
  func captureForResolution(_ payload: JSONValue, descriptor: ArkProtectedTrialDescriptor) async throws -> JSONValue {
    let row = try resolveFields(payload, descriptor: descriptor)
    return try await capture(row["sessionId"]!.stringValue!, row["sessionSnapshotHash"]!.stringValue!)
  }

  /// Authorization is checked again by the owner after capture completes.
  func resolveCaptured(_ payload: JSONValue, descriptor: ArkProtectedTrialDescriptor, captured: JSONValue, prepareArtifact: ((Data) throws -> Void)? = nil) throws -> JSONValue {
    mutationLock.lock(); defer { mutationLock.unlock() }
    try descriptor.validate()
    guard configuration.sourceBindingHash == descriptor.sourceBindingHash else { throw ArkProtectedOwnerError.rejected("Cost source binding differs") }
    let row = try resolveFields(payload, descriptor: descriptor)
    let session = row["sessionId"]!.stringValue!
    let snapshot = row["sessionSnapshotHash"]!.stringValue!
    guard captured["sessionIdHash"] == .string(Self.sessionHash(session)),
      captured["sessionSnapshotHash"] == .string(snapshot), captured["capturedRequestHashes"] == row["capturedRequestHashes"],
      let requests = captured["capturedRequestHashes"]?.arrayValue, !requests.isEmpty,
      requests.allSatisfy(validHash), Set(requests.compactMap(\.stringValue)).count == requests.count else {
      return unknown("complete persisted turn differs from requested cost coverage")
    }
    let entries = store.costEntries.filter { $0["registration"]?["sessionIdHash"] == captured["sessionIdHash"] }
    guard entries.count == requests.count else { return unknown("missing, pending, extra or retry dispatch attribution") }
    var attempts: [JSONValue] = []
    var total = 0
    for request in requests {
      let matching = entries.filter { $0["registration"]?["capturedRequestHash"] == request }
      guard matching.count == 1, let entry = matching.first, let registration = entry["registration"]?.objectValue,
        let observed = entry["attempts"]?.arrayValue, observed.count == 1,
        let attempt = observed.first, attempt["phase"] == .string("settled"), let settlement = attempt["settlement"]?.objectValue,
        let cost = settlement["upperBoundMicroCny"]?.jsonSafeInteger() else {
        return unknown("missing, duplicate or unsettled dispatch")
      }
      total += cost
      var result = settlement
      result.removeValue(forKey: "schemaVersion"); result.removeValue(forKey: "sessionIdHash")
      result["capturedRequestHash"] = registration["capturedRequestHash"]
      result["registrationArtifactHash"] = entry["registrationArtifactHash"]
      result["settlementArtifactHash"] = attempt["settlementArtifactHash"]
      result["retryOfDispatchId"] = .null; result["retryAttributionArtifactHash"] = .null
      attempts.append(.object(result))
    }
    let artifact: JSONValue = .object(["schemaVersion": .number(1), "kind": .string("settled-use-cost-witness-v1"),
      "sessionIdHash": captured["sessionIdHash"]!, "sessionSnapshotHash": .string(snapshot),
      "capturedRequestHashes": .array(requests), "attempts": .array(attempts), "totalUpperBoundMicrounits": .number(Double(total))])
    let bytes = try ArkProtectedBytes.encode(artifact)
    try prepareArtifact?(bytes)
    let hash = try store.putArtifact(bytes)
    return .object(["status": .string("verified"), "artifactBytesBase64": .string(bytes.base64EncodedString()), "artifactHash": .string(hash)])
  }

  private func fields(_ value: JSONValue, _ expected: Set<String>) throws -> [String: JSONValue] {
    guard let fields = value.objectValue, Set(fields.keys) == expected else { throw ArkProtectedOwnerError.rejected("Unknown or missing cost evidence fields") }
    return fields
  }
  private func validHash(_ value: JSONValue?) -> Bool { value?.stringValue.map(ArkProtectedBytes.hashIsValid) ?? false }
  private func unknown(_ reason: String) -> JSONValue { .object(["status": .string("unknown"), "reason": .string(reason)]) }
  public static func sessionHash(_ session: String) -> String { ArkProtectedBytes.digest(Data(("ark-cost-session-v1\0" + session).utf8)) }
  private static func date(_ text: String) -> Date? {
    let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.date(from: text)
  }
  private static func readLedger(_ path: URL) throws -> (Data, [String: JSONValue]) {
    let file = Darwin.open(path.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
    guard file >= 0 else { throw ArkProtectedOwnerError.rejected("Existing cost ledger is unavailable") }
    defer { Darwin.close(file) }
    var info = stat()
    guard fstat(file, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_nlink == 1,
      info.st_size > 0, info.st_size <= 65536 else { throw ArkProtectedOwnerError.rejected("Existing ledger is unsafe or oversized") }
    let bytes = try FileHandle(fileDescriptor: file, closeOnDealloc: false).readToEnd() ?? Data()
    let ledger = try ArkProtectedBytes.object(bytes, keys: ["schema", "budgetMicroCny", "maxRequests", "requestCount", "settledUpperBoundMicroCny", "pending"])
    guard ledger["schema"] == .number(2), ledger["budgetMicroCny"] == .number(5_000_000), ledger["maxRequests"] == .number(32),
      let count = ledger["requestCount"]?.jsonSafeInteger(), count <= 32,
      let spent = ledger["settledUpperBoundMicroCny"]?.jsonSafeInteger(), spent <= 5_000_000,
      let pending = ledger["pending"]?.arrayValue else { throw ArkProtectedOwnerError.rejected("Existing cost ledger limits differ") }
    var reserved = 0
    for row in pending {
      guard let fields = row.objectValue, Set(fields.keys) == ["id", "reservedMicroCny"],
        fields["id"]?.stringValue?.isEmpty == false, let amount = fields["reservedMicroCny"]?.jsonSafeInteger(),
        amount >= 2_097_158, amount <= 2_146_304, (amount - 2_097_152) % 6 == 0 else {
        throw ArkProtectedOwnerError.rejected("Existing cost pending reservation is invalid")
      }
      reserved += amount
    }
    guard spent + reserved <= 5_000_000 else { throw ArkProtectedOwnerError.rejected("Existing budget is overcommitted") }
    return (bytes, ledger)
  }
}
