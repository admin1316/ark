import CryptoKit
import Foundation

public struct ArkSubagentEntry: Identifiable, Equatable, Sendable {
  public let id: String
  public let kind: String
  public let mode: String?
  public let activity: String?
  public let hasChildren: Bool
  public let label: String?
  public let reason: String?

  public init(
    id: String,
    kind: String,
    mode: String?,
    activity: String?,
    hasChildren: Bool,
    label: String?,
    reason: String?
  ) {
    self.id = id
    self.kind = kind
    self.mode = mode
    self.activity = activity
    self.hasChildren = hasChildren
    self.label = label
    self.reason = reason
  }
}

public struct ArkSubagentCatalog: Equatable, Sendable {
  public let entries: [ArkSubagentEntry]
  public let parentAvailable: Bool

  public init(entries: [ArkSubagentEntry], parentAvailable: Bool) {
    self.entries = entries
    self.parentAvailable = parentAvailable
  }
}

public struct ArkSubagentPromptReceipt: Equatable, Sendable {
  public let invocationID: String
  public let messageID: String
  public let duplicate: Bool

  public init(invocationID: String, messageID: String, duplicate: Bool) {
    self.invocationID = invocationID
    self.messageID = messageID
    self.duplicate = duplicate
  }
}

/// Deterministic Native retry identity derived from the already-persisted draft.
/// No second receipt store exists: the child Session inbox/event log remains the
/// sole delivery authority, while an unchanged draft reproduces the same UUID
/// after an Ark relaunch. Clearing/editing the draft advances its revision.
public enum ArkSubagentPromptInvocationIdentity {
  public static func make(
    parentSessionID: String,
    childSessionID: String,
    content: String,
    draftRevision: UInt64
  ) -> String {
    let source = "\(parentSessionID)\u{0}\(childSessionID)\u{0}\(draftRevision)\u{0}\(content)"
    var bytes = Array(SHA256.hash(data: Data(source.utf8)).prefix(16))
    // RFC 4122 variant plus a deterministic v5-shaped version nibble.
    bytes[6] = (bytes[6] & 0x0f) | 0x50
    bytes[8] = (bytes[8] & 0x3f) | 0x80
    let hex = bytes.map { String(format: "%02x", $0) }
    return [
      hex[0...3].joined(),
      hex[4...5].joined(),
      hex[6...7].joined(),
      hex[8...9].joined(),
      hex[10...15].joined(),
    ].joined(separator: "-")
  }
}

extension ArkAPIClient {
  public func subagentCatalog(parentSessionID: String) async throws -> ArkSubagentCatalog {
    let value = try await remoteCall(
      method: "subagent/list",
      args: ["parentSessionId": .string(parentSessionID)]
    )
    guard let rows = value["entries"]?.arrayValue,
          let parentAvailable = value["parentAvailable"]?.boolValue
    else { throw ArkAPIError(message: "子代理目录响应无效") }
    let entries = try rows.map { row -> ArkSubagentEntry in
      guard let id = row["id"]?.stringValue, let kind = row["kind"]?.stringValue else {
        throw ArkAPIError(message: "子代理目录包含无效条目")
      }
      return ArkSubagentEntry(
        id: id,
        kind: kind,
        mode: row["mode"]?.stringValue,
        activity: row["activity"]?.stringValue,
        hasChildren: row["hasChildren"]?.boolValue == true,
        label: row["label"]?.stringValue,
        reason: row["reason"]?.stringValue
      )
    }
    return ArkSubagentCatalog(entries: entries, parentAvailable: parentAvailable)
  }

  public func subagentHistoryPage(
    parentSessionID: String,
    childSessionID: String,
    mode: String,
    beforeSequence: Int? = nil,
    maxMessages: Int = 100
  ) async throws -> ArkHistoryPage {
    var payload: [String: JSONValue] = [
      "parentSessionId": .string(parentSessionID),
      "childSessionId": .string(childSessionID),
      "mode": .string(mode),
      "maxMessages": .number(Double(maxMessages)),
    ]
    if let beforeSequence { payload["beforeSeq"] = .number(Double(beforeSequence)) }
    let value = try await remoteCall(method: "subagent/history", args: payload)
    guard let rows = value["events"]?.arrayValue,
          let hasMore = value["hasMore"]?.boolValue
    else { throw ArkAPIError(message: "子代理历史响应无效") }
    let events = rows.compactMap(Self.historyEvent(from:)).sorted { $0.id < $1.id }
    return ArkHistoryPage(
      events: events,
      hasMore: hasMore,
      beforeSequence: events.map(\.id).min(),
      projections: value["projections"]?["values"]?.objectValue ?? [:]
    )
  }

  public func promptSubagent(
    parentSessionID: String,
    childSessionID: String,
    text: String,
    invocationID: String
  ) async throws -> ArkSubagentPromptReceipt {
    let value = try await remoteCall(
      method: "subagent/prompt",
      args: [
        "agentId": .string(parentSessionID),
        "childSessionId": .string(childSessionID),
        "content": .array([.object(["type": .string("text"), "text": .string(text)])]),
        "invocationId": .string(invocationID),
      ]
    )
    guard value["invocationId"]?.stringValue == invocationID,
          let messageID = value["messageId"]?.stringValue,
          !messageID.isEmpty,
          value["durable"]?.boolValue == true,
          let duplicate = value["duplicate"]?.boolValue
    else { throw ArkAPIError(message: "子代理消息持久化收据无效") }
    return ArkSubagentPromptReceipt(
      invocationID: invocationID,
      messageID: messageID,
      duplicate: duplicate
    )
  }

  public func interruptSubagent(parentSessionID: String, childSessionID: String) async throws {
    let value = try await remoteCall(
      method: "subagent/interrupt",
      args: [
        "parentSessionId": .string(parentSessionID),
        "childSessionId": .string(childSessionID),
      ]
    )
    guard value["accepted"]?.boolValue == true else {
      throw ArkAPIError(message: "子代理中断响应无效")
    }
  }
}
