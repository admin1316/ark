import Foundation
@testable import JiuzhangShellCore
@testable import JiuzhangShellUI

/// Reasoning effort 契约：冷启动 capability 来自权威 llm.models host catalog，
/// canonical model ID 匹配，菜单与回退目录不伪造 effort 选项。
func runArkReasoningEffortContractChecks() {
  let hostGroups = try? ArkDomainAPIContract.hostModels(from: .object([
    "groups": .array([
      .object([
        "id": .string("deepseek-official"),
        "name": .string("DeepSeek"),
        "models": .array([
          .object([
            "id": .string("deepseek-v4-flash"),
            "name": .string("DeepSeek-V4-Flash"),
            "reasoning": .object([
              "efforts": .array([
                .object(["id": .string("low"), "name": .string("Low")]),
                .object(["id": .string("medium"), "name": .string("Medium")]),
                .object(["id": .string("high"), "name": .string("High")]),
              ]),
              "defaultEffort": .string("low"),
            ]),
          ]),
        ]),
      ]),
    ]),
  ]))
  check(
    hostGroups?.first?.models.first?.id == "deepseek-v4-flash"
      && hostGroups?.first?.models.first?.name == "DeepSeek-V4-Flash"
      && hostGroups?.first?.models.first?.reasoning?.efforts.map(\.id)
        == ["low", "medium", "high"]
      && hostGroups?.first?.models.first?.reasoning?.defaultEffort == "low",
    "native llm.models host catalog keeps canonical model ids and full reasoning efforts"
  )

  let sessionCatalog = try? ArkDomainAPIContract.sessionModels(from: .object([
    "current": .object([
      "provider": .string("deepseek-official"),
      "model": .string("deepseek-v4-flash"),
      "reasoningEffort": .string("low"),
    ]),
    "routable": .bool(true),
    "groups": .array([
      .object([
        "id": .string("deepseek-official"),
        "name": .string("DeepSeek"),
        "models": .array([
          .object([
            "id": .string("deepseek-v4-flash"),
            "name": .string("DeepSeek-V4-Flash"),
            "reasoning": .object([
              "efforts": .array([
                .object(["id": .string("low"), "name": .string("Low")]),
              ]),
            ]),
          ]),
        ]),
      ]),
    ]),
    "failures": .array([]),
  ]))
  check(
    sessionCatalog?.groups.first?.models.first?.reasoning?.efforts.count == 1
      && sessionCatalog?.current.reasoningEffort == "low",
    "native session catalog parses reasoning efforts for the live path"
  )

  let bareGroups = try? ArkDomainAPIContract.hostModels(from: .object([
    "groups": .array([
      .object([
        "id": .string("p"),
        "name": .string("P"),
        "models": .array([
          .object(["id": .string("m"), "name": .string("M")]),
        ]),
      ]),
    ]),
  ]))
  check(
    bareGroups?.first?.models.first?.reasoning == nil,
    "native host catalog tolerates models without reasoning metadata instead of fabricating options"
  )

  let model = ArkModelCatalogModel(id: "m", name: "M")
  let unique = ArkModelCatalogModel(id: "unique", name: "Unique")
  let primaryGroups = ArkProviderPresentation.primaryModelGroups([
    ArkModelProviderGroup(id: "openai-codex", name: "Codex", models: [model, unique]),
    ArkModelProviderGroup(id: "openai", name: "OpenAI", models: [model]),
    ArkModelProviderGroup(id: "qwen-token-plan", name: "Plan", models: [model]),
  ])
  check(primaryGroups.map(\.id) == ["openai", "openai-codex"]
    && primaryGroups.flatMap(\.models).map(\.id) == ["m", "unique"],
    "single-brand menus remove duplicate models but retain unique model routes and hide plan-only entries")
  check(ArkProviderPresentation.standardChoices(["qwen-token-plan", "qwen-token-plan-custom"], id: { $0 }) == ["qwen-token-plan-custom"],
    "ordinary provider filtering does not hide a custom gateway based on a name prefix")
  let variants = ["deepseek-official", "deepseek"].map {
    ArkProviderView(id: $0, displayName: "DeepSeek", settingsNamespace: "fixture",
      settingsPath: [$0], active: true)
  }
  let namespace = ArkSettingsNamespace(id: "fixture", schema: .object([:]), value: .object([
    "deepseek-official": .object(["apiKeyEnv": .string("MISSING_REF")]),
    "deepseek": .object(["apiKeyEnv": .string("CONFIGURED_REF")]),
  ]), base: nil, user: nil, secrets: [], applies: "live", revision: 1)
  let ready = ArkAppModel.configuredModelGroups(variants.map {
    ArkModelProviderGroup(id: $0.id, name: $0.displayName, models: [model])
  }, providers: variants, namespaces: [namespace], credentials: [
    "CONFIGURED_REF": ArkCredentialView(configured: true, source: "keychain", writable: true),
  ])
  check(ready.map(\.id) == ["deepseek"] && ArkProviderPresentation.groups(ready, id: { $0.id }, name: { $0.name }).first?.entries.count == 1,
    "a missing-key duplicate is omitted and the configured DeepSeek variant needs no extra route submenu")
  check(ArkAppModel.configuredModelGroups([ArkModelProviderGroup(id: "session-local", name: "Local", models: [model])],
    providers: variants, namespaces: [namespace], credentials: [:]).count == 1,
    "session-local authentication is not constrained by an unrelated Host credential directory")
  let activeGroup = ArkModelProviderGroup(id: "active", name: "Active", models: [model])
  let inactiveGroup = ArkModelProviderGroup(id: "inactive", name: "Inactive", models: [model])
  let activeProvider = ArkProviderView(
    id: "active",
    displayName: "Active",
    settingsNamespace: "active-settings",
    settingsPath: [],
    active: true,
    declared: true
  )
  let inactiveProvider = ArkProviderView(
    id: "inactive",
    displayName: "Inactive",
    settingsNamespace: "inactive-settings",
    settingsPath: [],
    active: false,
    declared: true
  )
  check(
    ArkAppModel.activeComposerGroups(
      [inactiveGroup, activeGroup],
      providers: [inactiveProvider, activeProvider]
    ) == [activeGroup],
    "native composer fallback excludes inactive providers from stale and settings-derived catalogs"
  )
  check(
    ArkAppModel.activeComposerGroups([activeGroup], providers: []).isEmpty,
    "native composer fallback fails closed until current provider activity is known"
  )

  let domainURL = contractNativeRoot.appendingPathComponent(
    "Sources/JiuzhangShellCore/ArkDomainAPI.swift"
  )
  let modelURL = contractNativeRoot.appendingPathComponent(
    "Sources/JiuzhangShellUI/ArkAppModel.swift"
  )
  let rootURL = contractNativeRoot.appendingPathComponent(
    "Sources/JiuzhangShellUI/ArkRootView.swift"
  )
  let l10nURL = contractNativeRoot.appendingPathComponent(
    "Sources/JiuzhangShellUI/ArkL10n.swift"
  )
  guard
    let domainSource = try? String(contentsOf: domainURL, encoding: .utf8),
    let modelSource = try? String(contentsOf: modelURL, encoding: .utf8),
    let rootSource = try? String(contentsOf: rootURL, encoding: .utf8),
    let l10nSource = try? String(contentsOf: l10nURL, encoding: .utf8)
  else {
    check(false, "native model sources are readable for reasoning effort checks")
    return
  }

  check(
    domainSource.contains("\"llm/models\"")
      && domainSource.contains("func hostModels()"),
    "native domain client consumes the authoritative llm.models host catalog"
  )

  let seed = sourceSlice(
    modelSource,
    from: "syncLanguagePreferenceFromSettings()",
    through: "var recoveryErrors"
  )
  check(
    seed?.contains("client.hostModels()") == true
      && seed?.contains("hostModelGroups = groups") == true
      && seed?.contains("generation == settingsLoadGeneration") == true,
    "native settings refresh replaces the Host directory under its current request generation"
  )

  let fallback = sourceSlice(
    modelSource,
    from: "public var composerModelCatalog",
    through: "/// Global configuration choices"
  )
  check(
    fallback?.contains("availableModelGroups") == true
      && fallback?.contains("group.id == selected.provider") == true
      && fallback?.contains("$0.id == selected.model") == true,
    "native new-session choices resolve current Host metadata with canonical ids"
  )

  let menu = sourceSlice(
    rootSource,
    from: "if let catalog = model.composerModelCatalog",
    through: ".accessibilityIdentifier(\"ark.composer.model\")"
  )
  let modelItems = sourceSlice(rootSource,
    from: "private func providerModelItems(",
    through: "private func selectedModelMenuCheckmark(")
  check(
    menu?.contains("ArkProviderPresentation.primaryModelGroups(catalog.groups)") == true
      && menu?.contains("Menu(group.id)") == false
      && menu?.contains("providerModelItems(group)") == true
      && modelItems?.contains("item.reasoning?.efforts") == true
      && modelItems?.contains("ForEach(efforts)") == true
      && modelItems?.contains("model.selectModel(ArkModelSelection(") == true
      && modelItems?.contains("provider: group.id, model: item.id, reasoningEffort: effort.id") == true,
    "native effort submenu reads the resolved composer catalog, not a bare session catalog"
  )
  check(
    modelSource.contains("public var composerModelRouteAvailable: Bool")
      && modelSource.contains("return composerModelCatalog?.routable == true")
      && modelSource.contains("guard composerModelRouteAvailable else")
      && modelSource.contains("public var composerModelLabel: String")
      && modelSource.contains("return ArkL10n.text(.composerModelUnavailable, languagePreference)")
      && rootSource.contains("|| !model.composerModelRouteAvailable")
      && rootSource.contains(".composerChooseAvailableModel")
      && rootSource.contains("ark.composer.model")
      && rootSource.contains("ark.composer.send")
      && l10nSource.contains("当前模型不可用，请先选择其他模型")
      && l10nSource.contains("The current model is unavailable. Choose another model first"),
    "native composer fails closed on the Host routable flag and guides the user to an available model"
  )

  for source in [domainSource, modelSource] {
    for banned in ["\"low\"", "\"medium\"", "\"high\""] {
      check(
        !source.contains(banned),
        "native model layer carries no hardcoded \(banned) capability fabrication"
      )
    }
  }
}

/// 截取 source 中从 start 首次出现到其后的 end 首次出现之间的片段。
private func sourceSlice(
  _ source: String,
  from start: String,
  through end: String
) -> String? {
  guard
    let startRange = source.range(of: start),
    let endRange = source.range(
      of: end,
      range: startRange.lowerBound..<source.endIndex
    )
  else { return nil }
  return String(source[startRange.lowerBound..<endRange.upperBound])
}
