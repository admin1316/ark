import Foundation

public enum ArkPluginSettingsApplyMode: String, Equatable, Sendable {
  case live
  case restart
}

public struct ArkShellPluginSettings: Equatable, Sendable {
  public let timeoutMs: Double
  public let maxTimeoutMs: Double
  public let maxOutputBytes: Double
  public let maxSpillBytes: Double
  public let graceMs: Double
  public let overriddenFields: Set<String>
  public let applies: ArkPluginSettingsApplyMode
  public let revision: Int
}

public struct ArkAgentLoopPluginSettings: Equatable, Sendable {
  public let maxParallelToolCalls: Int
  public let overriddenFields: Set<String>
  public let applies: ArkPluginSettingsApplyMode
  public let revision: Int
}

public struct ArkWebSearchDeepSeekPluginSettings: Equatable, Sendable {
  public let credentialReference: String
  public let baseURL: String?
  public let model: String
  public let apiVersion: String
  public let maxTokens: Int
  public let maxUses: Int
  public let overriddenFields: Set<String>
  public let applies: ArkPluginSettingsApplyMode
  public let revision: Int
}

public struct ArkPluginSettingsSnapshot: Equatable, Sendable {
  public let writable: Bool
  public let hasDocument: Bool
  public let shell: ArkShellPluginSettings?
  public let agentLoop: ArkAgentLoopPluginSettings?
  public let webSearchDeepSeek: ArkWebSearchDeepSeekPluginSettings?

  public init(
    writable: Bool,
    hasDocument: Bool,
    shell: ArkShellPluginSettings?,
    agentLoop: ArkAgentLoopPluginSettings?,
    webSearchDeepSeek: ArkWebSearchDeepSeekPluginSettings?
  ) {
    self.writable = writable
    self.hasDocument = hasDocument
    self.shell = shell
    self.agentLoop = agentLoop
    self.webSearchDeepSeek = webSearchDeepSeek
  }
}

public enum ArkShellPluginSettingsEdit: Equatable, Sendable {
  case setTimeoutMs(Double)
  case unsetTimeoutMs
  case setMaxTimeoutMs(Double)
  case unsetMaxTimeoutMs
  case setMaxOutputBytes(Double)
  case unsetMaxOutputBytes
  case setMaxSpillBytes(Double)
  case unsetMaxSpillBytes
  case setGraceMs(Double)
  case unsetGraceMs
}

public enum ArkAgentLoopPluginSettingsEdit: Equatable, Sendable {
  case setMaxParallelToolCalls(Int)
  case unsetMaxParallelToolCalls
}

public enum ArkWebSearchDeepSeekPluginSettingsEdit: Equatable, Sendable {
  case setCredentialReference(String)
  case unsetCredentialReference
  case setBaseURL(String)
  case unsetBaseURL
  case setModel(String)
  case unsetModel
  case setAPIVersion(String)
  case unsetAPIVersion
  case setMaxTokens(Int)
  case unsetMaxTokens
  case setMaxUses(Int)
  case unsetMaxUses
}

/// Strict native contracts for the three plugin-settings cards Ark exposes.
public enum ArkPluginSettingsAPIContract {
  public enum Method {
    public static let describe = "settings/describe"
    public static let mutate = "settings/mutate"
  }

  public enum Namespace: String, Sendable {
    case shell
    case agentLoop = "agent-loop"
    case webSearchDeepSeek = "web-search-deepseek"
  }

  private struct NamespaceRow {
    let value: [String: JSONValue]
    let overriddenFields: Set<String>
    let applies: ArkPluginSettingsApplyMode
    let revision: Int
  }

  private struct FieldOperation {
    let path: String
    let value: JSONValue?
  }

  /// Decode the redacted settings directory without exposing any secret value.
  public static func snapshot(from value: JSONValue) throws -> ArkPluginSettingsSnapshot {
    guard let writable = value["writable"]?.boolValue,
      let hasDocument = value["hasDocument"]?.boolValue,
      let namespaces = value["namespaces"]?.arrayValue
    else { throw invalidResponse(Method.describe) }

    var shell: ArkShellPluginSettings?
    var agentLoop: ArkAgentLoopPluginSettings?
    var webSearch: ArkWebSearchDeepSeekPluginSettings?
    for value in namespaces {
      guard let namespace = value["ns"]?.stringValue, !namespace.isEmpty else {
        throw invalidResponse(Method.describe)
      }
      switch Namespace(rawValue: namespace) {
      case .shell:
        guard shell == nil else { throw invalidResponse(Method.describe) }
        shell = try shellSettings(from: value, operation: Method.describe)
      case .agentLoop:
        guard agentLoop == nil else { throw invalidResponse(Method.describe) }
        agentLoop = try agentLoopSettings(from: value, operation: Method.describe)
      case .webSearchDeepSeek:
        guard webSearch == nil else { throw invalidResponse(Method.describe) }
        webSearch = try webSearchSettings(from: value, operation: Method.describe)
      case nil:
        continue
      }
    }
    return ArkPluginSettingsSnapshot(
      writable: writable,
      hasDocument: hasDocument,
      shell: shell,
      agentLoop: agentLoop,
      webSearchDeepSeek: webSearch
    )
  }

  public static func shellMutationPayload(
    edit: ArkShellPluginSettingsEdit,
    expectedRevision: Int
  ) throws -> JSONValue {
    try shellMutationPayload(edits: [edit], expectedRevision: expectedRevision)
  }

  public static func shellMutationPayload(
    edits: [ArkShellPluginSettingsEdit],
    expectedRevision: Int
  ) throws -> JSONValue {
    return try mutationPayload(
      namespace: .shell,
      operations: try edits.map(shellOperation),
      expectedRevision: expectedRevision
    )
  }

  public static func agentLoopMutationPayload(
    edit: ArkAgentLoopPluginSettingsEdit,
    expectedRevision: Int
  ) throws -> JSONValue {
    try agentLoopMutationPayload(edits: [edit], expectedRevision: expectedRevision)
  }

  public static func agentLoopMutationPayload(
    edits: [ArkAgentLoopPluginSettingsEdit],
    expectedRevision: Int
  ) throws -> JSONValue {
    return try mutationPayload(
      namespace: .agentLoop,
      operations: try edits.map(agentLoopOperation),
      expectedRevision: expectedRevision
    )
  }

  public static func webSearchMutationPayload(
    edit: ArkWebSearchDeepSeekPluginSettingsEdit,
    expectedRevision: Int
  ) throws -> JSONValue {
    try webSearchMutationPayload(edits: [edit], expectedRevision: expectedRevision)
  }

  public static func webSearchMutationPayload(
    edits: [ArkWebSearchDeepSeekPluginSettingsEdit],
    expectedRevision: Int
  ) throws -> JSONValue {
    return try mutationPayload(
      namespace: .webSearchDeepSeek,
      operations: try edits.map(webSearchOperation),
      expectedRevision: expectedRevision
    )
  }

  private static func shellOperation(_ edit: ArkShellPluginSettingsEdit) throws -> FieldOperation {
    switch edit {
    case .setTimeoutMs(let value):
      return FieldOperation(
        path: "timeoutMs", value: .number(try positive(value, field: "timeoutMs")))
    case .unsetTimeoutMs:
      return FieldOperation(path: "timeoutMs", value: nil)
    case .setMaxTimeoutMs(let value):
      return FieldOperation(
        path: "maxTimeoutMs",
        value: .number(try positive(value, field: "maxTimeoutMs"))
      )
    case .unsetMaxTimeoutMs:
      return FieldOperation(path: "maxTimeoutMs", value: nil)
    case .setMaxOutputBytes(let value):
      return FieldOperation(
        path: "maxOutputBytes",
        value: .number(try positive(value, field: "maxOutputBytes"))
      )
    case .unsetMaxOutputBytes:
      return FieldOperation(path: "maxOutputBytes", value: nil)
    case .setMaxSpillBytes(let value):
      return FieldOperation(
        path: "maxSpillBytes",
        value: .number(try positive(value, field: "maxSpillBytes"))
      )
    case .unsetMaxSpillBytes:
      return FieldOperation(path: "maxSpillBytes", value: nil)
    case .setGraceMs(let value):
      return FieldOperation(path: "graceMs", value: .number(try positive(value, field: "graceMs")))
    case .unsetGraceMs:
      return FieldOperation(path: "graceMs", value: nil)
    }
  }

  private static func agentLoopOperation(
    _ edit: ArkAgentLoopPluginSettingsEdit
  ) throws -> FieldOperation {
    switch edit {
    case .setMaxParallelToolCalls(let value):
      return FieldOperation(
        path: "maxParallelToolCalls",
        value: .number(Double(try positiveInteger(value, field: "maxParallelToolCalls")))
      )
    case .unsetMaxParallelToolCalls:
      return FieldOperation(path: "maxParallelToolCalls", value: nil)
    }
  }

  private static func webSearchOperation(
    _ edit: ArkWebSearchDeepSeekPluginSettingsEdit
  ) throws -> FieldOperation {
    switch edit {
    case .setCredentialReference(let reference):
      guard isCredentialReference(reference) else {
        throw ArkAPIError(message: "凭据引用必须是有效的环境变量名称")
      }
      return FieldOperation(path: "apiKeyEnv", value: .string(reference))
    case .unsetCredentialReference:
      return FieldOperation(path: "apiKeyEnv", value: nil)
    case .setBaseURL(let value):
      return FieldOperation(path: "baseURL", value: .string(value))
    case .unsetBaseURL:
      return FieldOperation(path: "baseURL", value: nil)
    case .setModel(let value):
      return FieldOperation(path: "model", value: .string(try nonempty(value, field: "model")))
    case .unsetModel:
      return FieldOperation(path: "model", value: nil)
    case .setAPIVersion(let value):
      return FieldOperation(
        path: "apiVersion",
        value: .string(try nonempty(value, field: "apiVersion"))
      )
    case .unsetAPIVersion:
      return FieldOperation(path: "apiVersion", value: nil)
    case .setMaxTokens(let value):
      return FieldOperation(
        path: "maxTokens",
        value: .number(Double(try positiveInteger(value, field: "maxTokens")))
      )
    case .unsetMaxTokens:
      return FieldOperation(path: "maxTokens", value: nil)
    case .setMaxUses(let value):
      return FieldOperation(
        path: "maxUses",
        value: .number(Double(try positiveInteger(value, field: "maxUses")))
      )
    case .unsetMaxUses:
      return FieldOperation(path: "maxUses", value: nil)
    }
  }

  public static func shellMutationResult(from value: JSONValue) throws -> ArkShellPluginSettings {
    try shellSettings(from: value, operation: Method.mutate)
  }

  public static func agentLoopMutationResult(from value: JSONValue) throws
    -> ArkAgentLoopPluginSettings
  {
    try agentLoopSettings(from: value, operation: Method.mutate)
  }

  public static func webSearchMutationResult(
    from value: JSONValue
  ) throws -> ArkWebSearchDeepSeekPluginSettings {
    try webSearchSettings(from: value, operation: Method.mutate)
  }

  private static func shellSettings(
    from value: JSONValue,
    operation: String
  ) throws -> ArkShellPluginSettings {
    let row = try namespaceRow(from: value, namespace: .shell, operation: operation)
    guard let timeoutMs = row.value["timeoutMs"]?.numberValue,
      let maxTimeoutMs = row.value["maxTimeoutMs"]?.numberValue,
      let maxOutputBytes = row.value["maxOutputBytes"]?.numberValue,
      let maxSpillBytes = row.value["maxSpillBytes"]?.numberValue,
      let graceMs = row.value["graceMs"]?.numberValue
    else { throw invalidResponse(operation) }
    return ArkShellPluginSettings(
      timeoutMs: try positive(timeoutMs, field: "timeoutMs"),
      maxTimeoutMs: try positive(maxTimeoutMs, field: "maxTimeoutMs"),
      maxOutputBytes: try positive(maxOutputBytes, field: "maxOutputBytes"),
      maxSpillBytes: try positive(maxSpillBytes, field: "maxSpillBytes"),
      graceMs: try positive(graceMs, field: "graceMs"),
      overriddenFields: row.overriddenFields.intersection([
        "timeoutMs", "maxTimeoutMs", "maxOutputBytes", "maxSpillBytes", "graceMs",
      ]),
      applies: row.applies,
      revision: row.revision
    )
  }

  private static func agentLoopSettings(
    from value: JSONValue,
    operation: String
  ) throws -> ArkAgentLoopPluginSettings {
    let row = try namespaceRow(from: value, namespace: .agentLoop, operation: operation)
    guard let raw = row.value["maxParallelToolCalls"]?.numberValue,
      let maxParallelToolCalls = positiveInteger(raw)
    else { throw invalidResponse(operation) }
    return ArkAgentLoopPluginSettings(
      maxParallelToolCalls: maxParallelToolCalls,
      overriddenFields: row.overriddenFields.intersection(["maxParallelToolCalls"]),
      applies: row.applies,
      revision: row.revision
    )
  }

  private static func webSearchSettings(
    from value: JSONValue,
    operation: String
  ) throws -> ArkWebSearchDeepSeekPluginSettings {
    let row = try namespaceRow(from: value, namespace: .webSearchDeepSeek, operation: operation)
    guard row.value["apiKey"] == nil,
      let credentialReference = row.value["apiKeyEnv"]?.stringValue,
      isCredentialReference(credentialReference),
      let model = row.value["model"]?.stringValue,
      !model.isEmpty,
      let apiVersion = row.value["apiVersion"]?.stringValue,
      !apiVersion.isEmpty,
      let rawMaxTokens = row.value["maxTokens"]?.numberValue,
      let maxTokens = positiveInteger(rawMaxTokens),
      let rawMaxUses = row.value["maxUses"]?.numberValue,
      let maxUses = positiveInteger(rawMaxUses)
    else { throw invalidResponse(operation) }
    let baseURL: String?
    if let rawBaseURL = row.value["baseURL"] {
      guard let parsed = rawBaseURL.stringValue else { throw invalidResponse(operation) }
      baseURL = parsed
    } else {
      baseURL = nil
    }
    return ArkWebSearchDeepSeekPluginSettings(
      credentialReference: credentialReference,
      baseURL: baseURL,
      model: model,
      apiVersion: apiVersion,
      maxTokens: maxTokens,
      maxUses: maxUses,
      overriddenFields: row.overriddenFields.intersection([
        "apiKeyEnv", "baseURL", "model", "apiVersion", "maxTokens", "maxUses",
      ]),
      applies: row.applies,
      revision: row.revision
    )
  }

  private static func namespaceRow(
    from value: JSONValue,
    namespace: Namespace,
    operation: String
  ) throws -> NamespaceRow {
    guard value["ns"]?.stringValue == namespace.rawValue,
      value["schema"] != nil,
      let resolved = value["value"]?.objectValue,
      let rawApplies = value["applies"]?.stringValue,
      let applies = ArkPluginSettingsApplyMode(rawValue: rawApplies),
      let rawRevision = value["revision"]?.numberValue,
      let revision = nonnegativeInteger(rawRevision),
      let secrets = value["secrets"]?.arrayValue
    else { throw invalidResponse(operation) }
    for secret in secrets {
      guard let path = secret["path"]?.arrayValue,
        path.allSatisfy({ $0.stringValue != nil }),
        secret["set"]?.boolValue != nil
      else { throw invalidResponse(operation) }
    }
    let user: [String: JSONValue]
    if let rawUser = value["user"] {
      guard let parsed = rawUser.objectValue else { throw invalidResponse(operation) }
      user = parsed
    } else {
      user = [:]
    }
    if namespace == .webSearchDeepSeek, user["apiKey"] != nil {
      throw invalidResponse(operation)
    }
    return NamespaceRow(
      value: resolved,
      overriddenFields: Set(user.keys),
      applies: applies,
      revision: revision
    )
  }

  private static func mutationPayload(
    namespace: Namespace,
    operations: [FieldOperation],
    expectedRevision: Int
  ) throws -> JSONValue {
    guard expectedRevision >= 0, expectedRevision <= 9_007_199_254_740_991 else {
      throw ArkAPIError(message: "设置版本必须是安全的非负整数")
    }
    guard !operations.isEmpty, Set(operations.map(\.path)).count == operations.count else {
      throw ArkAPIError(message: "插件设置更新必须包含互不重复的字段")
    }
    let edits = operations.map { operation -> JSONValue in
      operation.value.map { value in
        .object([
          "op": .string("set"),
          "path": .array([.string(operation.path)]),
          "value": value,
        ])
      }
        ?? .object([
          "op": .string("unset"),
          "path": .array([.string(operation.path)]),
        ])
    }
    return .object([
      "ns": .string(namespace.rawValue),
      "ops": .array(edits),
      "expectedRevision": .number(Double(expectedRevision)),
    ])
  }

  private static func nonempty(_ value: String, field: String) throws -> String {
    guard !value.isEmpty else { throw ArkAPIError(message: "\(field) 不能为空") }
    return value
  }

  private static func positive(_ value: Double, field: String) throws -> Double {
    guard value.isFinite, value > 0 else {
      throw ArkAPIError(message: "\(field) 必须是正数")
    }
    return value
  }

  private static func positiveInteger(_ value: Int, field: String) throws -> Int {
    guard value > 0, value <= 9_007_199_254_740_991 else {
      throw ArkAPIError(message: "\(field) 必须是安全的正整数")
    }
    return value
  }

  private static func positiveInteger(_ value: Double) -> Int? {
    guard value.isFinite,
      value > 0,
      value.rounded(.towardZero) == value,
      value <= 9_007_199_254_740_991
    else { return nil }
    return Int(value)
  }

  private static func nonnegativeInteger(_ value: Double) -> Int? {
    guard value.isFinite,
      value >= 0,
      value.rounded(.towardZero) == value,
      value <= 9_007_199_254_740_991
    else { return nil }
    return Int(value)
  }

  private static func isCredentialReference(_ value: String) -> Bool {
    value.range(
      of: #"^[A-Za-z_][A-Za-z0-9_]*$"#,
      options: .regularExpression
    ) != nil
  }

  private static func invalidResponse(_ operation: String) -> ArkAPIError {
    ArkAPIError(message: "本机服务返回了无效的 \(operation) 插件设置响应")
  }
}

extension ArkAPIClient {
  public func pluginSettings() async throws -> ArkPluginSettingsSnapshot {
    try ArkPluginSettingsAPIContract.snapshot(
      from: try await remoteCall(method: ArkPluginSettingsAPIContract.Method.describe)
    )
  }

  public func mutateShellPluginSettings(
    _ edit: ArkShellPluginSettingsEdit,
    expectedRevision: Int
  ) async throws -> ArkShellPluginSettings {
    try await mutateShellPluginSettings([edit], expectedRevision: expectedRevision)
  }

  public func mutateShellPluginSettings(
    _ edits: [ArkShellPluginSettingsEdit],
    expectedRevision: Int
  ) async throws -> ArkShellPluginSettings {
    let payload = try ArkPluginSettingsAPIContract.shellMutationPayload(
      edits: edits,
      expectedRevision: expectedRevision
    )
    guard let args = payload.objectValue else { throw ArkAPIError(message: "Shell 设置请求无效") }
    let value = try await remoteCall(
      method: ArkPluginSettingsAPIContract.Method.mutate,
      args: args
    )
    return try ArkPluginSettingsAPIContract.shellMutationResult(from: value)
  }

  public func mutateAgentLoopPluginSettings(
    _ edit: ArkAgentLoopPluginSettingsEdit,
    expectedRevision: Int
  ) async throws -> ArkAgentLoopPluginSettings {
    try await mutateAgentLoopPluginSettings([edit], expectedRevision: expectedRevision)
  }

  public func mutateAgentLoopPluginSettings(
    _ edits: [ArkAgentLoopPluginSettingsEdit],
    expectedRevision: Int
  ) async throws -> ArkAgentLoopPluginSettings {
    let payload = try ArkPluginSettingsAPIContract.agentLoopMutationPayload(
      edits: edits,
      expectedRevision: expectedRevision
    )
    guard let args = payload.objectValue else { throw ArkAPIError(message: "Agent Loop 设置请求无效") }
    let value = try await remoteCall(
      method: ArkPluginSettingsAPIContract.Method.mutate,
      args: args
    )
    return try ArkPluginSettingsAPIContract.agentLoopMutationResult(from: value)
  }

  public func mutateWebSearchDeepSeekPluginSettings(
    _ edit: ArkWebSearchDeepSeekPluginSettingsEdit,
    expectedRevision: Int
  ) async throws -> ArkWebSearchDeepSeekPluginSettings {
    try await mutateWebSearchDeepSeekPluginSettings([edit], expectedRevision: expectedRevision)
  }

  public func mutateWebSearchDeepSeekPluginSettings(
    _ edits: [ArkWebSearchDeepSeekPluginSettingsEdit],
    expectedRevision: Int
  ) async throws -> ArkWebSearchDeepSeekPluginSettings {
    let payload = try ArkPluginSettingsAPIContract.webSearchMutationPayload(
      edits: edits,
      expectedRevision: expectedRevision
    )
    guard let args = payload.objectValue else { throw ArkAPIError(message: "Web Search 设置请求无效") }
    let value = try await remoteCall(
      method: ArkPluginSettingsAPIContract.Method.mutate,
      args: args
    )
    return try ArkPluginSettingsAPIContract.webSearchMutationResult(from: value)
  }
}
