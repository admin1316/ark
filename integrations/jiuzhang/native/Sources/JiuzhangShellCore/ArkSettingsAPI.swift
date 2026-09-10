import Foundation

public struct ArkProviderView: Identifiable, Equatable, Sendable {
  public let id: String
  public let displayName: String
  public let settingsNamespace: String
  public let settingsPath: [String]
  public let active: Bool
  public let declared: Bool?
  public let migrationRequired: ArkProviderMigration?
  public let configurationError: String?

  public init(id: String, displayName: String, settingsNamespace: String, settingsPath: [String],
              active: Bool, declared: Bool? = nil, migrationRequired: ArkProviderMigration? = nil,
              configurationError: String? = nil) {
    self.id = id
    self.displayName = displayName
    self.settingsNamespace = settingsNamespace
    self.settingsPath = settingsPath
    self.active = active
    self.declared = declared
    self.migrationRequired = migrationRequired
    self.configurationError = configurationError
  }
}

/// The Host names unsafe fields without returning their values or granting writes to deployment configuration.
public struct ArkProviderMigration: Equatable, Sendable {
  public let code: String
  public let fields: [String]
  public let paths: [[String]]?
  public let inheritedPaths: [[String]]?

  public var canMigrateUserFields: Bool {
    guard let paths, !paths.isEmpty, let inheritedPaths else { return false }
    return inheritedPaths.isEmpty
  }
}

public struct ArkCredentialView: Equatable, Sendable {
  public let configured: Bool
  public let source: String?
  public let writable: Bool
}

public struct ArkProviderVerification: Equatable, Sendable {
  public let provider: String
  public let model: String
  public let verified: Bool
  public let mode: String
}

public struct ArkSettingsNamespace: Identifiable, Equatable, Sendable {
  public let id: String
  public let schema: JSONValue
  public let value: JSONValue
  public let base: JSONValue?
  public let user: JSONValue?
  public let secrets: [ArkSettingsSecret]
  public let applies: String
  public let revision: Int
}

public struct ArkSettingsSecret: Equatable, Sendable {
  public let path: [String]
  public let isSet: Bool
}

public struct ArkSettingsSnapshot: Equatable, Sendable {
  public let writable: Bool
  public let hasDocument: Bool
  public let namespaces: [ArkSettingsNamespace]

  public init(writable: Bool, hasDocument: Bool, namespaces: [ArkSettingsNamespace]) {
    self.writable = writable
    self.hasDocument = hasDocument
    self.namespaces = namespaces
  }

  /// Read only the route's declared settings address; absent profiles cannot borrow sibling credentials.
  public static func credentialReference(
    for provider: ArkProviderView, namespaces: [ArkSettingsNamespace]
  ) -> String {
    if let reference = namespaces.first(where: { $0.id == provider.settingsNamespace })?
      .value.value(at: provider.settingsPath)?["apiKeyEnv"]?.stringValue,
      !reference.isEmpty {
      return reference
    }
    return suggestedCredentialReference(for: provider.id, namespaces: namespaces)
  }

  /// Suggestions avoid references already present in settings; the Host remains the write-ownership authority.
  public static func suggestedCredentialReference(
    for providerID: String, namespaces: [ArkSettingsNamespace]
  ) -> String {
    let name = providerID.uppercased().map { character in
      character.isLetter || character.isNumber ? String(character) : "_"
    }.joined() + "_API_KEY"
    let occupied = Set(namespaces.flatMap { $0.value.strings(forKey: "apiKeyEnv") })
    if !occupied.contains(name) { return name }
    var candidate = "ARK_" + name
    var suffix = 2
    while occupied.contains(candidate) {
      candidate = "ARK_" + name + "_" + String(suffix)
      suffix += 1
    }
    return candidate
  }
}

public struct ArkDiscoveredModel: Identifiable, Equatable, Sendable {
  public let id: String
  public let name: String?
  public let contextWindow: Int?
  public let maxTokens: Int?
}

public enum ArkSettingMutation: Equatable, Sendable {
  case set(path: [String], value: JSONValue)
  case unset(path: [String])
}

public enum ArkProviderCredentialMutation: Equatable, Sendable {
  case set(ref: String, value: String)
  case unset(ref: String)
}

public enum ArkProviderTransactionState: String, Equatable, Sendable {
  case absent
  case prepared
  case credentialStaged = "credential-staged"
  case settingsApplied = "settings-applied"
  case credentialApplied = "credential-applied"
  case committed
  case rolledBack = "rolled-back"
  case committedNotLive = "committed-not-live"

  public var isTerminal: Bool {
    switch self {
    case .committed, .rolledBack, .committedNotLive: return true
    case .absent, .prepared, .credentialStaged, .settingsApplied, .credentialApplied: return false
    }
  }
}

public struct ArkProviderTransactionStatus: Equatable, Sendable {
  public let transactionID: String
  public let state: ArkProviderTransactionState
  public let needsCredential: Bool
  public let settingsNamespace: String?
  public let live: Bool?
}

/// One durable idempotency key per Provider while its Host saga is unfinished.
/// The secret and mutation payload never enter UserDefaults.
public final class ArkProviderTransactionRegistry {
  private static let prefix = "ark.native.provider-transaction."
  private let defaults: UserDefaults

  public init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
  }

  public func transactionID(for provider: String) -> String {
    let key = Self.prefix + provider
    if let existing = pendingTransactionID(for: provider) {
      return existing
    }
    let created = UUID().uuidString.lowercased()
    defaults.set(created, forKey: key)
    return created
  }

  /// A read does not allocate a new pending transaction.
  public func pendingTransactionID(for provider: String) -> String? {
    guard let value = defaults.string(forKey: Self.prefix + provider), !value.isEmpty else { return nil }
    return value
  }

  public func clear(provider: String, transactionID: String? = nil) {
    if let transactionID, pendingTransactionID(for: provider) != transactionID { return }
    defaults.removeObject(forKey: Self.prefix + provider)
  }

  /// A late reply cannot clear a newer pending operation, and transient failures retain their identity.
  public func acknowledge(provider: String, transactionID: String, state: ArkProviderTransactionState) {
    guard state.isTerminal else { return }
    clear(provider: provider, transactionID: transactionID)
  }
}

private func encodedSettingMutations(_ mutations: [ArkSettingMutation]) -> [JSONValue] {
  mutations.map { mutation in
    switch mutation {
    case .set(let path, let value):
      return .object([
        "op": .string("set"),
        "path": .array(path.map(JSONValue.string)),
        "value": value,
      ])
    case .unset(let path):
      return .object([
        "op": .string("unset"),
        "path": .array(path.map(JSONValue.string)),
      ])
    }
  }
}

private func decodedSettingsNamespace(_ row: JSONValue) throws -> ArkSettingsNamespace {
  guard let id = row["ns"]?.stringValue,
    let resolved = row["value"],
    let revision = row["revision"]?.numberValue
  else { throw ArkAPIError(message: "设置更新响应无效") }
  return ArkSettingsNamespace(
    id: id,
    schema: row["schema"] ?? .null,
    value: resolved,
    base: row["base"],
    user: row["user"],
    secrets: row["secrets"]?.arrayValue?.compactMap { secret in
      guard let path = secret["path"]?.arrayValue?.compactMap(\.stringValue),
        let isSet = secret["set"]?.boolValue
      else { return nil }
      return ArkSettingsSecret(path: path, isSet: isSet)
    } ?? [],
    applies: row["applies"]?.stringValue ?? "restart",
    revision: Int(revision)
  )
}

extension ArkAPIClient {
  public func providers() async throws -> [ArkProviderView] {
    let value = try await remoteCall(method: "llm/providers")
    return try value["providers"]?.arrayValue?.compactMap { row in
      guard let id = row["provider"]?.stringValue,
        let name = row["displayName"]?.stringValue,
        let namespace = row["settingsNs"]?.stringValue
      else { return nil }
      if let diagnostic = row["error"], diagnostic != .null, diagnostic.stringValue == nil {
        throw ArkAPIError(message: "Provider configuration diagnostic must be text")
      }
      return ArkProviderView(
        id: id,
        displayName: name,
        settingsNamespace: namespace,
        settingsPath: row["settingsPath"]?.arrayValue?.compactMap(\.stringValue) ?? [],
        active: row["active"]?.boolValue == true,
        declared: row["declared"]?.boolValue,
        migrationRequired: try Self.providerMigration(row["migrationRequired"]),
        configurationError: row["error"]?.stringValue
      )
    } ?? []
  }

  private static func providerMigration(_ value: JSONValue?) throws -> ArkProviderMigration? {
    guard let value else { return nil }
    guard let code = value["code"]?.stringValue,
          ["credential-headers", "credential-fields"].contains(code),
          let fields = value["fields"]?.arrayValue,
          fields.allSatisfy({ $0.stringValue?.isEmpty == false })
    else { throw ArkAPIError(message: "Provider 凭据迁移信息无效") }
    func paths(_ value: JSONValue?) throws -> [[String]]? {
      guard let value else { return nil }
      guard let rows = value.arrayValue else { throw ArkAPIError(message: "Provider 凭据迁移路径无效") }
      return try rows.map { row in
        guard let path = row.arrayValue, !path.isEmpty,
              path.allSatisfy({ part in
                guard let name = part.stringValue, !name.isEmpty else { return false }
                return !["__proto__", "prototype", "constructor"].contains(name)
              })
        else { throw ArkAPIError(message: "Provider 凭据迁移路径无效") }
        return path.compactMap(\.stringValue)
      }
    }
    return ArkProviderMigration(code: code, fields: fields.compactMap(\.stringValue),
      paths: try paths(value["paths"]), inheritedPaths: try paths(value["inheritedPaths"]))
  }

  public func settingsSnapshot() async throws -> ArkSettingsSnapshot {
    let value = try await remoteCall(method: "settings/describe")
    let namespaces =
      value["namespaces"]?.arrayValue?.compactMap { row -> ArkSettingsNamespace? in
        guard let id = row["ns"]?.stringValue,
          let resolved = row["value"],
          let revisionValue = row["revision"]?.numberValue
        else { return nil }
        return ArkSettingsNamespace(
          id: id,
          schema: row["schema"] ?? .null,
          value: resolved,
          base: row["base"],
          user: row["user"],
          secrets: row["secrets"]?.arrayValue?.compactMap { secret in
            guard let path = secret["path"]?.arrayValue?.compactMap(\.stringValue),
              let isSet = secret["set"]?.boolValue
            else { return nil }
            return ArkSettingsSecret(path: path, isSet: isSet)
          } ?? [],
          applies: row["applies"]?.stringValue ?? "restart",
          revision: Int(revisionValue)
        )
      } ?? []
    return ArkSettingsSnapshot(
      writable: value["writable"]?.boolValue == true,
      hasDocument: value["hasDocument"]?.boolValue == true,
      namespaces: namespaces
    )
  }

  public func credentialStates(refs: [String]) async throws -> [String: ArkCredentialView] {
    let value = try await remoteCall(
      method: "credentials/describe",
      args: ["refs": .array(refs.map(JSONValue.string))]
    )
    guard let rows = value["credentials"]?.objectValue else { return [:] }
    return rows.reduce(into: [:]) { result, pair in
      result[pair.key] = ArkCredentialView(
        configured: pair.value["configured"]?.boolValue == true,
        source: pair.value["source"]?.stringValue,
        writable: pair.value["writable"]?.boolValue == true
      )
    }
  }

  /// Verify the exact saved route; the Host may generate a minimal probe when metadata cannot prove authentication.
  public func verifyProvider(provider: String, model: String) async throws -> ArkProviderVerification {
    let value = try await remoteRequest(method: "llm/verifyProvider", request: [
      "provider": .string(provider), "model": .string(model),
    ])
    guard value["provider"]?.stringValue == provider, value["model"]?.stringValue == model,
      let verified = value["verified"]?.boolValue, let mode = value["mode"]?.stringValue,
      (verified && ["metadata-auth", "minimal-generation"].contains(mode))
        || (!verified && mode == "endpoint-catalog" && value["classification"]?.stringValue == "reachability-only")
    else { throw ArkAPIError(message: "模型连接验证响应无效") }
    return ArkProviderVerification(provider: provider, model: model, verified: verified, mode: mode)
  }

  public func setCredential(ref: String, value: String) async throws {
    _ = try await remoteCall(
      method: "credentials/set",
      args: ["refName": .string(ref), "value": .string(value)]
    )
  }

  public func unsetCredential(ref: String) async throws {
    _ = try await remoteCall(
      method: "credentials/unset", args: ["refName": .string(ref)])
  }

  public func openSettingsDocument() async throws {
    let value = try await remoteCall(method: "settings/openDocument")
    guard value["opened"]?.boolValue == true else {
      throw ArkAPIError(message: "本机服务没有确认打开设置文档")
    }
  }

  public func discoverModels(
    settingsNamespace: String,
    provider: String? = nil,
    baseURL: String? = nil,
    api: String? = nil,
    apiKey: String? = nil
  ) async throws -> [ArkDiscoveredModel] {
    var payload: [String: JSONValue] = ["settingsNs": .string(settingsNamespace)]
    if let provider, !provider.isEmpty { payload["provider"] = .string(provider) }
    if let baseURL, !baseURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      guard let normalized = ArkHTTPURLInput.normalizedHTTPURL(baseURL) else {
        throw ArkAPIError(message: "Base URL 必须是有效的 HTTP 或 HTTPS 地址")
      }
      payload["baseURL"] = .string(normalized)
    }
    if let api, !api.isEmpty { payload["api"] = .string(api) }
    // Built-in catalog reads need no credential. A one-shot key may only ride
    // with the explicit candidate endpoint that the Host binds it to.
    if payload["baseURL"] != nil, let apiKey, !apiKey.isEmpty {
      payload["apiKey"] = .string(apiKey)
    }
    let value = try await remoteRequest(method: "llm/discoverModels", request: payload)
    guard let rows = value["models"]?.arrayValue else {
      throw ArkAPIError(message: "模型发现响应无效")
    }
    return try rows.map { row in
      guard let id = row["id"]?.stringValue, !id.isEmpty else {
        throw ArkAPIError(message: "模型发现响应包含无效模型")
      }
      return ArkDiscoveredModel(
        id: id,
        name: row["name"]?.stringValue,
        contextWindow: try Self.modelCapacity(row["contextWindow"], field: "contextWindow"),
        maxTokens: try Self.modelCapacity(row["maxTokens"], field: "maxTokens")
      )
    }
  }

  /// Model capacities share JSON's exact integer range; malformed wire values cannot trap Swift conversion.
  private static func modelCapacity(_ value: JSONValue?, field: String) throws -> Int? {
    guard let value else { return nil }
    guard let number = value.numberValue, number > 0, number <= 9_007_199_254_740_991,
          let integer = Int(exactly: number)
    else { throw ArkAPIError(message: "模型目录返回了无效的 \(field)") }
    return integer
  }

  public func mutateSetting(
    namespace: String,
    path: [String],
    value: JSONValue?,
    expectedRevision: Int
  ) async throws -> ArkSettingsNamespace {
    try await mutateSettings(
      namespace: namespace,
      mutations: value.map { [.set(path: path, value: $0)] } ?? [.unset(path: path)],
      expectedRevision: expectedRevision
    )
  }

  public func mutateSettings(
    namespace: String,
    mutations: [ArkSettingMutation],
    expectedRevision: Int
  ) async throws -> ArkSettingsNamespace {
    guard !mutations.isEmpty else { throw ArkAPIError(message: "设置更新不能为空") }
    let row = try await remoteCall(
      method: "settings/mutate",
      args: [
        "ns": .string(namespace),
        "ops": .array(encodedSettingMutations(mutations)),
        "expectedRevision": .number(Double(expectedRevision)),
      ]
    )
    return try decodedSettingsNamespace(row)
  }

  public func mutateProvider(
    provider: String,
    namespace: String,
    mutations: [ArkSettingMutation],
    expectedRevision: Int,
    credential: ArkProviderCredentialMutation? = nil,
    transactionID: String = UUID().uuidString.lowercased()
  ) async throws -> ArkSettingsNamespace {
    guard !mutations.isEmpty || credential != nil else {
      throw ArkAPIError(message: "Provider 更新不能为空")
    }
    let normalizedMutations = try mutations.map { mutation -> ArkSettingMutation in
      guard case .set(let path, let value) = mutation,
        path == ["providers", provider, "baseURL"] || path == ["baseURL"]
      else { return mutation }
      guard let raw = value.stringValue, let normalized = ArkHTTPURLInput.normalizedHTTPURL(raw) else {
        throw ArkAPIError(message: "Base URL 必须是有效的 HTTP 或 HTTPS 地址")
      }
      return .set(path: path, value: .string(normalized))
    }
    var payload: [String: JSONValue] = [
      "transactionId": .string(transactionID),
      "provider": .string(provider),
      "settingsNs": .string(namespace),
      "ops": .array(encodedSettingMutations(normalizedMutations)),
      "expectedRevision": .number(Double(expectedRevision)),
    ]
    if let credential {
      switch credential {
      case .set(let ref, let value):
        payload["credential"] = .object([
          "op": .string("set"),
          "ref": .string(ref),
          "value": .string(value),
        ])
      case .unset(let ref):
        payload["credential"] = .object([
          "op": .string("unset"),
          "ref": .string(ref),
        ])
      }
    }
    let value = try await remoteRequest(method: "llm/mutateProvider", request: payload)
    guard let settings = value["settings"] else {
      throw ArkAPIError(message: "Provider 更新响应无效")
    }
    return try decodedSettingsNamespace(settings)
  }

  public func providerTransaction(provider: String, transactionID: String) async throws -> ArkProviderTransactionStatus {
    let value = try await remoteRequest(method: "llm/providerTransaction", request: [
      "provider": .string(provider), "transactionId": .string(transactionID),
    ])
    guard let rawState = value["state"]?.stringValue,
      let state = ArkProviderTransactionState(rawValue: rawState),
      let needsCredential = value["needsCredential"]?.boolValue
    else { throw ArkAPIError(message: "Provider 恢复状态响应无效") }
    return ArkProviderTransactionStatus(
      transactionID: transactionID, state: state, needsCredential: needsCredential,
      settingsNamespace: value["settingsNs"]?.stringValue, live: value["live"]?.boolValue
    )
  }

  public func resumeProvider(
    provider: String, transactionID: String, credentialValue: String? = nil
  ) async throws -> ArkSettingsNamespace {
    var request: [String: JSONValue] = [
      "provider": .string(provider), "transactionId": .string(transactionID),
    ]
    if let credentialValue { request["credentialValue"] = .string(credentialValue) }
    let value = try await remoteRequest(method: "llm/resumeProvider", request: request)
    guard let settings = value["settings"] else { throw ArkAPIError(message: "Provider 恢复响应无效") }
    return try decodedSettingsNamespace(settings)
  }
}

extension JSONValue {
  public func value(at path: [String]) -> JSONValue? {
    path.reduce(Optional(self)) { current, key in current?[key] }
  }

  public func strings(forKey target: String) -> [String] {
    switch self {
    case .object(let object):
      return object.flatMap { key, value in
        (key == target ? value.stringValue.map { [$0] } ?? [] : []) + value.strings(forKey: target)
      }
    case .array(let values):
      return values.flatMap { $0.strings(forKey: target) }
    default:
      return []
    }
  }
}
