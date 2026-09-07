import Foundation

/// Optional free-form input advertised by one Host slash command.
public struct ArkComposerCommandInput: Equatable, Sendable {
  public let hint: String
  public let acceptsImages: Bool

  public init(hint: String, acceptsImages: Bool = false) {
    self.hint = hint
    self.acceptsImages = acceptsImages
  }
}

/// Immutable command directory row returned by the addressed session's Agent.
public struct ArkComposerCommand: Identifiable, Equatable, Sendable {
  public let name: String
  public let description: String
  public let input: ArkComposerCommandInput?

  public var id: String { name }

  public init(name: String, description: String, input: ArkComposerCommandInput? = nil) {
    self.name = name
    self.description = description
    self.input = input
  }
}

/// One user-invocable skill resolved from the selected session's project root.
public struct ArkComposerSkill: Identifiable, Equatable, Sendable {
  public let name: String
  public let description: String
  public let whenToUse: String?
  public let modelInvocable: Bool

  public var id: String { name }

  public init(
    name: String,
    description: String,
    whenToUse: String? = nil,
    modelInvocable: Bool
  ) {
    self.name = name
    self.description = description
    self.whenToUse = whenToUse
    self.modelInvocable = modelInvocable
  }
}

/// Path-only completion returned inside the addressed session's cwd fence.
public struct ArkComposerFileCandidate: Identifiable, Equatable, Sendable {
  public enum Kind: String, Equatable, Sendable {
    case file
    case directory
  }

  public let path: String
  public let kind: Kind

  public var id: String { "\(kind.rawValue):\(path)" }

  public init(path: String, kind: Kind) {
    self.path = path
    self.kind = kind
  }
}

/// Metadata-only session candidate carrying its Host-generated canonical mention.
public struct ArkComposerSessionCandidate: Identifiable, Equatable, Sendable {
  public let sessionID: String
  public let label: String
  public let cwd: String?
  public let createdAt: Date
  public let mention: String

  public var id: String { sessionID }

  public init(
    sessionID: String,
    label: String,
    cwd: String? = nil,
    createdAt: Date,
    mention: String
  ) {
    self.sessionID = sessionID
    self.label = label
    self.cwd = cwd
    self.createdAt = createdAt
    self.mention = mention
  }
}

/// Strict wire decoders for the four Host-owned composer sources.
public enum ArkComposerAPIContract {
  public enum Method {
    public static let commandsList = "commands/list"
    public static let fileReferencesList = "fileReferences/list"
    public static let sessionReferenceCandidates = "sessionReferenceResolver/candidates"
    public static let skillList = "skill/list"
  }

  public static func commands(from value: JSONValue) throws -> [ArkComposerCommand] {
    guard let rows = value.arrayValue else { throw invalidResponse("commands/list") }
    return try rows.map { row in
      guard let name = row["name"]?.stringValue,
            !name.isEmpty,
            let description = row["description"]?.stringValue,
            !description.isEmpty
      else { throw invalidResponse("commands/list item") }
      let input: ArkComposerCommandInput?
      if let inputValue = row["input"] {
        guard let hint = inputValue["hint"]?.stringValue, !hint.isEmpty else {
          throw invalidResponse("commands/list input")
        }
        input = ArkComposerCommandInput(
          hint: hint,
          acceptsImages: inputValue["images"]?.boolValue == true
        )
      } else {
        input = nil
      }
      return ArkComposerCommand(name: name, description: description, input: input)
    }
  }

  public static func skills(from value: JSONValue) throws -> [ArkComposerSkill] {
    guard let rows = value["skills"]?.arrayValue else { throw invalidResponse("skill.list") }
    return try rows.map { row in
      guard let name = row["name"]?.stringValue,
            !name.isEmpty,
            let description = row["description"]?.stringValue,
            let modelInvocable = row["modelInvocable"]?.boolValue
      else { throw invalidResponse("skill.list item") }
      return ArkComposerSkill(
        name: name,
        description: description,
        whenToUse: row["whenToUse"]?.stringValue,
        modelInvocable: modelInvocable
      )
    }
  }

  public static func files(from value: JSONValue) throws -> [ArkComposerFileCandidate] {
    guard let rows = value.arrayValue else { throw invalidResponse("fileReferences/list") }
    return try rows.map { row in
      guard let path = row["path"]?.stringValue,
            !path.isEmpty,
            let rawKind = row["kind"]?.stringValue,
            let kind = ArkComposerFileCandidate.Kind(rawValue: rawKind)
      else { throw invalidResponse("fileReferences/list item") }
      return ArkComposerFileCandidate(path: path, kind: kind)
    }
  }

  public static func sessions(from value: JSONValue) throws -> [ArkComposerSessionCandidate] {
    guard let rows = value.arrayValue else {
      throw invalidResponse("sessionReferenceResolver/candidates")
    }
    return try rows.map { row in
      guard let sessionID = row["sessionId"]?.stringValue,
            !sessionID.isEmpty,
            let label = row["label"]?.stringValue,
            !label.isEmpty,
            let createdAt = row["createdAt"]?.numberValue,
            createdAt.isFinite,
            createdAt >= 0,
            let mention = row["mention"]?.stringValue,
            mention.hasPrefix("@[") && mention.contains("](dsh-session:")
      else { throw invalidResponse("sessionReferenceResolver/candidates item") }
      return ArkComposerSessionCandidate(
        sessionID: sessionID,
        label: label,
        cwd: row["cwd"]?.stringValue,
        createdAt: Date(timeIntervalSince1970: createdAt / 1_000),
        mention: mention
      )
    }
  }

  private static func invalidResponse(_ operation: String) -> ArkAPIError {
    ArkAPIError(message: "本机服务返回了无效的 \(operation) 响应")
  }
}

extension ArkAPIClient {
  /// Load the exact command registry visible to one session's Agent.
  public func composerCommands(sessionID: String) async throws -> [ArkComposerCommand] {
    let value = try await remoteCall(
      method: ArkComposerAPIContract.Method.commandsList,
      args: ["agentId": .string(sessionID)]
    )
    return try ArkComposerAPIContract.commands(from: value)
  }

  /// Load user-invocable skills from the project root owned by one session.
  public func composerSkills(sessionID: String) async throws -> [ArkComposerSkill] {
    let value = try await remoteCall(
      method: ArkComposerAPIContract.Method.skillList,
      args: ["agentId": .string(sessionID)]
    )
    return try ArkComposerAPIContract.skills(from: value)
  }

  /// Search root-confined file references for one session and query.
  public func composerFileReferences(
    sessionID: String,
    query: String
  ) async throws -> [ArkComposerFileCandidate] {
    let value = try await remoteCall(
      method: ArkComposerAPIContract.Method.fileReferencesList,
      args: ["agentId": .string(sessionID), "query": .string(query)]
    )
    return try ArkComposerAPIContract.files(from: value)
  }

  /// Search metadata-only cross-session references and retain Host canonical mentions.
  public func composerSessionReferences(
    sessionID: String,
    query: String
  ) async throws -> [ArkComposerSessionCandidate] {
    let value = try await remoteCall(
      method: ArkComposerAPIContract.Method.sessionReferenceCandidates,
      args: ["agentId": .string(sessionID), "query": .string(query)]
    )
    return try ArkComposerAPIContract.sessions(from: value)
  }
}
