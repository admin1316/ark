import Foundation

public struct ArkAgentPreset: Identifiable, Equatable, Sendable {
  public let id: String
  public let trust: String
  public let isDefault: Bool
  public let name: String?
  public let description: String?
  public let broken: String?
}

public struct ArkAgentPresetRoster: Equatable, Sendable {
  public let presets: [ArkAgentPreset]
  public let authorable: Bool
  public let hasDocument: Bool
}

public struct ArkAgentPresetDocument: Identifiable, Equatable, Sendable {
  public let id: String
  public let trust: String
  public let content: String
  public let name: String?
  public let description: String?
}

public struct ArkPluginInventoryEntry: Identifiable, Equatable, Sendable {
  public let id: String
  public let moduleName: String
  public let enabled: Bool
  public let phase: String?
}

extension ArkAPIClient {
  public func agentPresetRoster() async throws -> ArkAgentPresetRoster {
    let value = try await remoteCall(method: "agentPreset/list")
    return ArkAgentPresetRoster(
      presets: value["presets"]?.arrayValue?.compactMap { row in
        guard let id = row["id"]?.stringValue,
          let trust = row["trust"]?.stringValue
        else { return nil }
        return ArkAgentPreset(
          id: id,
          trust: trust,
          isDefault: row["isDefault"]?.boolValue == true,
          name: row["name"]?.stringValue,
          description: row["description"]?.stringValue,
          broken: row["broken"]?.stringValue
        )
      } ?? [],
      authorable: value["authorable"]?.boolValue == true,
      hasDocument: value["hasDocument"]?.boolValue == true
    )
  }

  public func readAgentPreset(id: String) async throws -> ArkAgentPresetDocument {
    let value = try await remoteCall(
      method: "agentPreset/read", args: ["agentPreset": .string(id)])
    guard let presetID = value["agentPreset"]?.stringValue,
      let trust = value["trust"]?.stringValue,
      let content = value["content"]?.stringValue
    else { throw ArkAPIError(message: "Agent 预设响应无效") }
    return ArkAgentPresetDocument(
      id: presetID,
      trust: trust,
      content: content,
      name: value["name"]?.stringValue,
      description: value["description"]?.stringValue
    )
  }

  public func selectAgentPreset(sessionID: String, presetID: String) async throws {
    _ = try await remoteCall(
      method: "agentPreset/select",
      args: ["agentId": .string(sessionID), "agentPreset": .string(presetID)]
    )
  }

  public func copyAgentPreset(from source: String, to target: String, name: String?) async throws {
    var payload: [String: JSONValue] = ["from": .string(source), "agentPreset": .string(target)]
    if let name, !name.isEmpty { payload["name"] = .string(name) }
    _ = try await remoteCall(method: "agentPreset/copy", args: payload)
  }

  public func openAgentPreset(id: String) async throws -> String? {
    let value = try await remoteCall(
      method: "agentPreset/openDocument", args: ["agentPreset": .string(id)])
    guard let opened = value["opened"]?.boolValue else {
      throw ArkAPIError(message: "Agent 预设打开响应无效")
    }
    return opened ? nil : value["path"]?.stringValue
  }

  public func removeAgentPreset(id: String) async throws {
    _ = try await remoteCall(
      method: "agentPreset/remove", args: ["agentPreset": .string(id)])
  }

  public func pluginInventory() async throws -> [ArkPluginInventoryEntry] {
    let value = try await remoteCall(method: "pluginInventory/list")
    return value["entries"]?.arrayValue?.compactMap { row in
      guard let id = row["entryId"]?.stringValue,
        let module = row["moduleName"]?.stringValue
      else { return nil }
      return ArkPluginInventoryEntry(
        id: id,
        moduleName: module,
        enabled: row["enabled"]?.boolValue == true,
        phase: row["fiberPhase"]?.stringValue
      )
    } ?? []
  }
}
