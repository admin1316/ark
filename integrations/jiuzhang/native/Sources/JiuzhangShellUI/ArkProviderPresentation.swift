import Foundation
import JiuzhangShellCore

/// Presentation groups never change a provider's routing or credential identity.
enum ArkProviderPresentation {
  struct Group<Entry>: Identifiable {
    let id: String
    let name: String
    var entries: [Entry]
  }

  private static let families: [(id: String, name: String, routes: [String])] = [
    ("deepseek", "DeepSeek", ["deepseek", "deepseek-official"]),
    ("openai", "OpenAI", ["openai", "openai-codex"]),
    ("google", "Google", ["google", "google-vertex"]),
    ("cloudflare", "Cloudflare", ["cloudflare-ai-gateway", "cloudflare-workers-ai"]),
    ("minimax", "MiniMax", ["minimax", "minimax-cn"]),
    ("moonshot", "Moonshot / Kimi", ["moonshotai", "moonshotai-cn", "kimi-coding"]),
    ("opencode", "OpenCode", ["opencode", "opencode-go"]),
    ("qwen", "千问 / 阿里云百炼", ["bailian-cn", "bailian-intl", "qwen-token-plan", "qwen-token-plan-cn", "qwen-token-plan-individual"]),
    ("xiaomi", "Xiaomi", ["xiaomi", "xiaomi-token-plan-ams", "xiaomi-token-plan-cn", "xiaomi-token-plan-sgp"]),
    ("zai", "Z.ai", ["zai", "zai-coding-cn"]),
  ]

  static func familyID(for providerID: String) -> String {
    if let family = families.first(where: { $0.routes.contains(providerID) }) {
      return "brand/" + family.id
    }
    return "provider/" + providerID
  }

  static func displayName(for providerID: String, fallback: String) -> String {
    families.first { $0.routes.contains(providerID) }?.name ?? fallback
  }

  static func standardChoices<Entry>(_ entries: [Entry], id: (Entry) -> String) -> [Entry] {
    entries.filter { !["qwen-token-plan", "qwen-token-plan-cn", "qwen-token-plan-individual"].contains(id($0)) }
  }

  static func primaryModelGroups(_ entries: [ArkModelProviderGroup]) -> [ArkModelProviderGroup] {
    groups(standardChoices(entries, id: { $0.id }), id: { $0.id }, name: { $0.name })
      .flatMap { family in
        var seen = Set<String>()
        return family.entries.compactMap { group -> ArkModelProviderGroup? in
          let models = group.models.filter { seen.insert($0.id).inserted }
          return models.isEmpty ? nil : ArkModelProviderGroup(id: group.id, name: family.name, models: models)
        }
      }
  }

  static func groups<Entry>(
    _ entries: [Entry], id: (Entry) -> String, name: (Entry) -> String
  ) -> [Group<Entry>] {
    var result: [Group<Entry>] = []
    var positions: [String: Int] = [:]
    for entry in entries {
      let providerID = id(entry)
      let family = families.first { $0.routes.contains(providerID) }
      let groupID = familyID(for: providerID)
      if let index = positions[groupID] {
        result[index].entries.append(entry)
        if let family {
          result[index].entries.sort {
            family.routes.firstIndex(of: id($0))! < family.routes.firstIndex(of: id($1))!
          }
        }
      } else {
        positions[groupID] = result.count
        result.append(Group(id: groupID, name: family?.name ?? name(entry), entries: [entry]))
      }
    }
    return result
  }
}
