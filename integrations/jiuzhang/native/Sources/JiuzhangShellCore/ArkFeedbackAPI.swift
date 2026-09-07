import Foundation

public struct ArkMessageFeedback: Identifiable, Equatable, Sendable {
  public enum Rating: String, Equatable, Sendable {
    case positive
    case negative
  }

  public let messageID: String
  public let rating: Rating
  public let note: String?
  public let version: String

  public var id: String { messageID }
}

/// Decodes the already-unwrapped values returned by ``ArkAPIClient.remoteCall``.
public enum ArkFeedbackAPIContract {
  public static func items(from value: JSONValue) throws -> [ArkMessageFeedback] {
    guard let items = value["items"]?.arrayValue else { throw invalidResponse("list") }
    var seenMessageIDs = Set<String>()
    return try items.map { value in
      let decoded = try item(from: value)
      guard seenMessageIDs.insert(decoded.messageID).inserted else {
        throw invalidResponse("list duplicate messageId")
      }
      return decoded
    }
  }

  public static func item(from value: JSONValue) throws -> ArkMessageFeedback {
    guard let messageID = value["messageId"]?.stringValue,
          let rawRating = value["rating"]?.stringValue,
          let rating = ArkMessageFeedback.Rating(rawValue: rawRating),
          let version = value["version"]?.stringValue
    else { throw invalidResponse("put") }
    return ArkMessageFeedback(
      messageID: messageID,
      rating: rating,
      note: value["note"]?.stringValue,
      version: version
    )
  }

  public static func requireDeleted(from value: JSONValue) throws {
    guard value["absent"]?.boolValue == true else { throw invalidResponse("delete") }
  }

  private static func invalidResponse(_ operation: String) -> ArkAPIError {
    ArkAPIError(message: "本机服务返回了无效的 messageFeedback.\(operation) 响应")
  }
}

extension ArkAPIClient {
  public func listMessageFeedback(sessionID: String) async throws -> [ArkMessageFeedback] {
    let result = try await remoteCall(
      method: "messageFeedback/list",
      args: ["request": .object(["sessionId": .string(sessionID)])]
    )
    return try ArkFeedbackAPIContract.items(from: result)
  }

  public func putMessageFeedback(
    sessionID: String,
    messageID: String,
    rating: ArkMessageFeedback.Rating,
    note: String? = nil,
    ifVersion: String?
  ) async throws -> ArkMessageFeedback {
    var request: [String: JSONValue] = [
      "sessionId": .string(sessionID),
      "messageId": .string(messageID),
      "rating": .string(rating.rawValue),
      "ifVersion": ifVersion.map(JSONValue.string) ?? .null,
    ]
    if let note { request["note"] = .string(note) }
    let result = try await remoteCall(
      method: "messageFeedback/put",
      args: ["request": .object(request)]
    )
    return try ArkFeedbackAPIContract.item(from: result)
  }

  public func deleteMessageFeedback(
    sessionID: String,
    messageID: String,
    ifVersion: String
  ) async throws {
    let result = try await remoteCall(
      method: "messageFeedback/delete",
      args: [
        "request": .object([
          "sessionId": .string(sessionID),
          "messageId": .string(messageID),
          "ifVersion": .string(ifVersion),
        ]),
      ]
    )
    try ArkFeedbackAPIContract.requireDeleted(from: result)
  }
}
