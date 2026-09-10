import Foundation

/// Wire obligations for restoring and permanently deleting archived sessions.
public enum ArkArchiveAPIContract {
  public enum Method {
    public static let workspaceUnarchiveSession = "workspace/unarchiveSession"
    public static let workspaceDeleteArchivedSession = "workspace/deleteArchivedSession"
  }

  /// Build the shared non-empty session request accepted by both archive mutations.
  public static func sessionRequest(sessionID: String) throws -> JSONValue {
    guard !sessionID.isEmpty else {
      throw ArkAPIError(message: "归档会话标识不能为空")
    }
    return .object(["sessionId": .string(sessionID)])
  }

  /// Decode the authoritative archive set returned after one restore.
  public static func unarchivedSessionIDs(from value: JSONValue) throws -> [String] {
    try archivedSessionIDs(from: value, operation: Method.workspaceUnarchiveSession)
  }

  /// Decode the authoritative archive set returned after a committed deletion.
  public static func deletedArchivedSessionIDs(from value: JSONValue) throws -> [String] {
    guard value["deleted"]?.boolValue == true else {
      throw invalidResponse(Method.workspaceDeleteArchivedSession)
    }
    return try archivedSessionIDs(from: value, operation: Method.workspaceDeleteArchivedSession)
  }

  private static func archivedSessionIDs(
    from value: JSONValue,
    operation: String
  ) throws -> [String] {
    guard let values = value["archivedSessionIds"]?.arrayValue else {
      throw invalidResponse(operation)
    }
    return try values.map { value in
      guard let sessionID = value.stringValue, !sessionID.isEmpty else {
        throw invalidResponse(operation)
      }
      return sessionID
    }
  }

  private static func invalidResponse(_ operation: String) -> ArkAPIError {
    ArkAPIError(message: "本机服务返回了无效的 \(operation) 响应")
  }
}

extension ArkAPIClient {
  /// Restore one archived session and return the complete updated archive set.
  @discardableResult
  public func unarchiveSession(sessionID: String) async throws -> [String] {
    let request = try ArkArchiveAPIContract.sessionRequest(sessionID: sessionID)
    guard let fields = request.objectValue else { throw ArkAPIError(message: "归档请求无效") }
    let value = try await remoteDomainRequest(
      method: ArkArchiveAPIContract.Method.workspaceUnarchiveSession,
      request: fields
    )
    return try ArkArchiveAPIContract.unarchivedSessionIDs(from: value)
  }

  /// Permanently delete one archived session tree and return the remaining archive set.
  @discardableResult
  public func deleteArchivedSession(sessionID: String) async throws -> [String] {
    let request = try ArkArchiveAPIContract.sessionRequest(sessionID: sessionID)
    guard let fields = request.objectValue else { throw ArkAPIError(message: "删除请求无效") }
    let value = try await remoteDomainRequest(
      method: ArkArchiveAPIContract.Method.workspaceDeleteArchivedSession,
      request: fields
    )
    return try ArkArchiveAPIContract.deletedArchivedSessionIDs(from: value)
  }
}
