import Foundation

/// Private App observation controls; existing Node verbs and signed records stay v1.
public enum ArkProtectedObservation {
  static let maximumInteger = 9_007_199_254_740_991
  static func validateState(_ trials: [ArkProtectedTrialState]) throws {
    var intents = Set<String>(), generations = Set<String>()
    for trial in trials {
      guard let intent = trial.intentHash, ArkProtectedBytes.hashIsValid(intent), intents.insert(intent).inserted,
        let registration = trial.registrationEpoch, registration > 0, let epoch = trial.inflightEpoch, epoch >= 0,
        let slots = trial.orderedSlotEpochs, (2...32).contains(slots.count), slots.count % 2 == 0,
        slots.count == trial.descriptor.sessionIDs.count, let collection = trial.collection?.objectValue,
        Set(collection.keys) == ["generationId", "phase", "nextSlotIndex", "reservationRevision", "inflightEpoch", "orderedCaptures", "reason", "failureEvidenceHash"],
        let generation = collection["generationId"]?.stringValue, UUID(uuidString: generation)?.uuidString.lowercased() == generation,
        generations.insert(generation).inserted, let cursor = collection["nextSlotIndex"]?.jsonSafeInteger(minimum: 0), cursor <= slots.count,
        let phase = collection["phase"]?.stringValue, ["collecting", "slot-reserved", "collected", "failed"].contains(phase),
        collection["inflightEpoch"]?.jsonSafeInteger(minimum: 1) != nil,
        let captures = collection["orderedCaptures"]?.arrayValue, captures.count == cursor,
        phase != "collected" || cursor == slots.count,
        phase != "slot-reserved" || collection["reservationRevision"]?.jsonSafeInteger(minimum: 0) != nil,
        (trial.phase != "admitted" || trial.admissionEpoch != nil) else {
        throw ArkProtectedOwnerError.rejected("Invalid private observation state")
      }
      for (index, slot) in slots.enumerated() {
        guard let fields = slot.objectValue, Set(fields.keys) == ["sessionId", "firstDispatchEpoch"],
          fields["sessionId"] == .string(trial.descriptor.sessionIDs[index]),
          fields["firstDispatchEpoch"] == .null || fields["firstDispatchEpoch"] == trial.admissionEpoch.map({ .number(Double($0)) }) else {
          throw ArkProtectedOwnerError.rejected("Observation slot epoch differs")
        }
      }
      for (index, capture) in captures.enumerated() {
        guard let row = capture.objectValue, Set(row.keys) == ["slotIndex", "sessionId", "captureArtifactHash", "captureOutcome"],
          row["slotIndex"] == .number(Double(index)), row["sessionId"] == .string(trial.descriptor.sessionIDs[index]),
          row["captureArtifactHash"]?.stringValue.map(ArkProtectedBytes.hashIsValid) == true,
          ["complete", "incomplete", "cancelled", "invalid-source", "unreadable-source"].contains(row["captureOutcome"]?.stringValue ?? "") else {
          throw ArkProtectedOwnerError.rejected("Observation capture ordering differs")
        }
      }
    }
  }
  public static func request(_ bytes: Data, operation: String) throws -> (String, Int) {
    try ArkProtectedStrictJSON.validate(bytes)
    let value = try ArkProtectedBytes.object(bytes, keys: ["schemaVersion", "operation", "descriptorHash", "expectedOwnerRevision"])
    guard value["schemaVersion"] == .number(1), value["operation"] == .string(operation),
      let hash = value["descriptorHash"]?.stringValue, ArkProtectedBytes.hashIsValid(hash),
      let revision = value["expectedOwnerRevision"]?.jsonSafeInteger(minimum: 0), revision <= maximumInteger else {
      throw ArkProtectedOwnerError.rejected("Invalid observation control request")
    }
    return (hash, revision)
  }
}

/// Reject duplicate member names before Foundation can collapse them.
public enum ArkProtectedStrictJSON {
  public static func validate(_ bytes: Data) throws {
    guard !bytes.isEmpty, bytes.count <= ArkProtectedBytes.maximumFrame,
      let text = String(data: bytes, encoding: .utf8), Data(text.utf8) == bytes else {
      throw ArkProtectedOwnerError.rejected("Private JSON is not bounded UTF8")
    }
    var scanner = Scanner(bytes: Array(bytes)); try scanner.value(depth: 0); scanner.space()
    guard scanner.index == scanner.bytes.count else { throw ArkProtectedOwnerError.rejected("Trailing private JSON bytes") }
    _ = try JSONDecoder().decode(JSONValue.self, from: bytes)
  }
  private struct Scanner {
    let bytes: [UInt8]; var index = 0
    mutating func space() { while index < bytes.count && [9, 10, 13, 32].contains(bytes[index]) { index += 1 } }
    mutating func take(_ byte: UInt8) throws {
      space(); guard index < bytes.count, bytes[index] == byte else { throw ArkProtectedOwnerError.rejected("Invalid private JSON structure") }; index += 1
    }
    mutating func string() throws -> String {
      space(); let start = index; try take(34)
      while index < bytes.count {
        let byte = bytes[index]; index += 1
        if byte == 92 { guard index < bytes.count else { break }; index += 1 }
        else if byte == 34 { return try JSONDecoder().decode(String.self, from: Data(bytes[start..<index])) }
      }
      throw ArkProtectedOwnerError.rejected("Unterminated private JSON string")
    }
    mutating func value(depth: Int) throws {
      guard depth <= 64 else { throw ArkProtectedOwnerError.rejected("Private JSON nesting exceeds limit") }
      space(); guard index < bytes.count else { throw ArkProtectedOwnerError.rejected("Incomplete private JSON") }
      switch bytes[index] {
      case 123:
        index += 1; space(); var keys = Set<String>()
        if index < bytes.count, bytes[index] == 125 { index += 1; return }
        while true {
          let key = try string(); guard keys.insert(key).inserted else { throw ArkProtectedOwnerError.rejected("Duplicate private JSON member") }
          try take(58); try value(depth: depth + 1); space()
          if index < bytes.count, bytes[index] == 125 { index += 1; return }; try take(44)
        }
      case 91:
        index += 1; space()
        if index < bytes.count, bytes[index] == 93 { index += 1; return }
        while true { try value(depth: depth + 1); space(); if index < bytes.count, bytes[index] == 93 { index += 1; return }; try take(44) }
      case 34: _ = try string()
      default:
        let start = index
        while index < bytes.count && ![9, 10, 13, 32, 44, 93, 125].contains(bytes[index]) { index += 1 }
        guard index > start else { throw ArkProtectedOwnerError.rejected("Invalid private JSON primitive") }
      }
    }
  }
}

public struct ArkProtectedOwnerReviewSnapshotV2: Codable, Sendable {
  public let schemaVersion: Int
  public let ownerRevision: Int?
  public let reviews: [ArkProtectedTrialReview]
  public init(ownerRevision: Int?, reviews: [ArkProtectedTrialReview]) {
    schemaVersion = 2; self.ownerRevision = ownerRevision; self.reviews = reviews
  }
  public func encode() throws -> Data {
    var fields: [String: JSONValue] = ["schemaVersion": .number(2), "ownerRevision": ownerRevision.map { .number(Double($0)) } ?? .null]
    fields["reviews"] = try JSONDecoder().decode(JSONValue.self, from: ArkProtectedBytes.encode(reviews))
    return try ArkProtectedBytes.encode(JSONValue.object(fields))
  }
}
