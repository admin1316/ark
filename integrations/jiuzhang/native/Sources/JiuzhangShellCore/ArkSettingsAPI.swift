import Foundation

public struct ArkProviderView: Identifiable, Equatable, Sendable {
  public let id: String
  public let displayName: String
  public let settingsNamespace: String
  public let settingsPath: [String]
  public let active: Bool
  public let declared: Bool?
}

public struct ArkCredentialView: Equatable, Sendable {
  public let configured: Bool
  public let source: String?
  public let writable: Bool
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
    if let existing = defaults.string(forKey: key), !existing.isEmpty {
      return existing
    }
    let created = UUID().uuidString.lowercased()
    defaults.set(created, forKey: key)
    return created
  }

  public func clear(provider: String) {
    defaults.removeObject(forKey: Self.prefix + provider)
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
    return value["providers"]?.arrayValue?.compactMap { row in
      guard let id = row["provider"]?.stringValue,
        let name = row["displayName"]?.stringValue,
        let namespace = row["settingsNs"]?.stringValue
      else { return nil }
      return ArkProviderView(
        id: id,
        displayName: name,
        settingsNamespace: namespace,
        settingsPath: row["settingsPath"]?.arrayValue?.compactMap(\.stringValue) ?? [],
        active: row["active"]?.boolValue == true,
        declared: row["declared"]?.boolValue
      )
    } ?? []
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
    if let baseURL, !baseURL.isEmpty { payload["baseURL"] = .string(baseURL) }
    if let api, !api.isEmpty { payload["api"] = .string(api) }
    if let apiKey, !apiKey.isEmpty { payload["apiKey"] = .string(apiKey) }
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
        contextWindow: row["contextWindow"]?.numberValue.map(Int.init),
        maxTokens: row["maxTokens"]?.numberValue.map(Int.init)
      )
    }
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
    var payload: [String: JSONValue] = [
      "transactionId": .string(transactionID),
      "provider": .string(provider),
      "settingsNs": .string(namespace),
      "ops": .array(encodedSettingMutations(mutations)),
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
