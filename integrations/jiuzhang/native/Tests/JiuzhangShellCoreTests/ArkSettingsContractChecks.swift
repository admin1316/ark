import Foundation
@testable import JiuzhangShellCore
@testable import JiuzhangShellUI

/// ui-theme 写入闸门的行为契约：single-flight + latest-intent 合并。
func runArkSettingsContractChecks() {
  func namespace(_ id: String, _ value: JSONValue) -> ArkSettingsNamespace {
    ArkSettingsNamespace(id: id, schema: .object([:]), value: value, base: nil, user: nil,
      secrets: [], applies: "live", revision: 1)
  }
  func route(_ id: String) -> ArkProviderView {
    ArkProviderView(id: id, displayName: id, settingsNamespace: "llm-pi-ai",
      settingsPath: ["providers", id], active: false)
  }
  let stored = [
    namespace("llm-deepseek", .object(["apiKeyEnv": .string("DEEPSEEK_API_KEY")])),
    namespace("llm-pi-ai", .object(["providers": .object([
      "openai": .object(["apiKeyEnv": .string("SAVED_OPENAI_REFERENCE")]),
      "empty": .object(["metadata": .object(["apiKeyEnv": .string("NESTED_NOT_A_CREDENTIAL")])]),
    ])])),
  ]
  check(ArkSettingsSnapshot.credentialReference(for: route("deepseek"), namespaces: stored) == "ARK_DEEPSEEK_API_KEY",
    "an absent DeepSeek route neither borrows a sibling reference nor collides with the official route")
  check(ArkSettingsSnapshot.credentialReference(for: route("openai"), namespaces: stored) == "SAVED_OPENAI_REFERENCE",
    "existing explicit route references remain unchanged")
  check(ArkSettingsSnapshot.credentialReference(for: route("empty"), namespaces: stored) == "EMPTY_API_KEY",
    "credential lookup does not descend into nested profile metadata")
  let official = ArkProviderView(id: "deepseek-official", displayName: "DeepSeek", settingsNamespace: "llm-deepseek",
    settingsPath: [], active: true)
  check(ArkSettingsSnapshot.credentialReference(for: official, namespaces: stored) == "DEEPSEEK_API_KEY",
    "a root-scoped provider retains its own configured reference")
  let collision = stored + [namespace("custom", .object(["apiKeyEnv": .string("ARK_DEEPSEEK_API_KEY")]))]
  check(ArkSettingsSnapshot.credentialReference(for: route("deepseek"), namespaces: collision) == "ARK_DEEPSEEK_API_KEY_2",
    "a custom reference cannot collide with the suggested alternate reference")
  check(ArkSettingsSnapshot.credentialReference(for: route("fresh-provider"), namespaces: []) == "FRESH_PROVIDER_API_KEY",
    "an unloaded settings namespace yields a route-specific draft reference")
  let catalogRoutes = [
    "amazon-bedrock", "ant-ling", "anthropic", "azure-openai-responses", "baseten", "cerebras",
    "cloudflare-ai-gateway", "cloudflare-workers-ai", "deepseek", "fireworks", "github-copilot",
    "google", "google-vertex", "groq", "huggingface", "kimi-coding", "minimax", "minimax-cn",
    "mistral", "moonshotai", "moonshotai-cn", "nvidia", "openai", "openai-codex", "opencode",
    "opencode-go", "openrouter", "qwen-token-plan", "qwen-token-plan-cn", "qwen-token-plan-individual",
    "together", "vercel-ai-gateway", "xai", "xiaomi", "xiaomi-token-plan-ams", "xiaomi-token-plan-cn",
    "xiaomi-token-plan-sgp", "zai", "zai-coding-cn",
  ]
  let references = catalogRoutes.map { ArkSettingsSnapshot.credentialReference(for: route($0), namespaces: stored) }
  check(Set(references).count == catalogRoutes.count,
    "all installed catalog routes resolve independent draft references in a partially configured namespace")
  check(zip(catalogRoutes, references).allSatisfy { id, ref in
    id == "openai" || ref != "SAVED_OPENAI_REFERENCE"
  }, "new catalog routes cannot inherit the already configured OpenAI reference")
  let providerRows = ["openai", "openai-codex", "minimax", "minimax-cn", "moonshotai", "moonshot", "custom-proxy"]
  let families = ArkProviderPresentation.groups(providerRows, id: { $0 }, name: { $0 })
  check(families.count == 5, "same-brand providers share a presentation group without swallowing custom routes")
  check(families[0].entries == ["openai", "openai-codex"]
    && families[1].entries == ["minimax", "minimax-cn"],
    "provider variants retain their independent routing identities and source order")
  check(ArkProviderPresentation.familyID(for: "moonshotai") != ArkProviderPresentation.familyID(for: "moonshot"),
    "a custom route named like a brand cannot impersonate that brand group")
  check(families.flatMap(\.entries) == providerRows, "provider grouping does not remove supported routes")

  var fontDraft = ArkChatDisplaySliderDraft(
    persistedValue: 16,
    bounds: 12...24,
    quantum: 1
  )
  var fontAppStorageCommitCount = 0
  var committedFontSize = 16.0
  for value in [16.2, 17.1, 17.8] { fontDraft.updateDraft(value) }
  check(
    fontAppStorageCommitCount == 0 && fontDraft.draftValue == 17.8,
    "chat font drag updates only panel-local draft state"
  )
  check(
    fontDraft.finishEditing {
      fontAppStorageCommitCount += 1
      committedFontSize = $0
    }
      && fontAppStorageCommitCount == 1
      && committedFontSize == 18
      && fontDraft.persistedValue == 18,
    "chat font drag commits once at editing end and normalizes to one point"
  )
  check(
    !fontDraft.finishEditing {
      fontAppStorageCommitCount += 1
      committedFontSize = $0
    }
      && fontAppStorageCommitCount == 1,
    "chat font repeated editing-end callbacks do not persist twice"
  )
  fontDraft.updateDraft(18.4)
  check(
    !fontDraft.finishEditing {
      fontAppStorageCommitCount += 1
      committedFontSize = $0
    }
      && fontAppStorageCommitCount == 1,
    "chat font separate drags in the same normalized bucket do not persist again"
  )
  for value in [18.8, 19.2, 19.6] { fontDraft.updateDraft(value) }
  check(
    fontAppStorageCommitCount == 1
      && fontDraft.finishEditing {
        fontAppStorageCommitCount += 1
        committedFontSize = $0
      }
      && fontAppStorageCommitCount == 2
      && committedFontSize == 20,
    "chat font consecutive changed drags each persist exactly once at their end"
  )

  var widthDraft = ArkChatDisplaySliderDraft(
    persistedValue: 780,
    bounds: 520...1_200,
    quantum: 8
  )
  var widthAppStorageCommitCount = 0
  var committedContentWidth = 780.0
  for value in [781.0, 787.0, 789.0] { widthDraft.updateDraft(value) }
  check(
    widthAppStorageCommitCount == 0,
    "chat width drag performs zero persisted writes before editing ends"
  )
  check(
    widthDraft.finishEditing {
      widthAppStorageCommitCount += 1
      committedContentWidth = $0
    }
      && widthAppStorageCommitCount == 1
      && committedContentWidth == 792,
    "chat width drag commits once and normalizes to eight points"
  )
  widthDraft.updateDraft(791)
  check(
    !widthDraft.finishEditing {
      widthAppStorageCommitCount += 1
      committedContentWidth = $0
    }
      && widthAppStorageCommitCount == 1,
    "chat width consecutive drags do not repeat the same persisted value"
  )

  // 快速两次切换 dark → light：只允许一个在飞写，第二个意图合并进 pending。
  var gate = ArkSingleFlightLatestGate()
  check(gate.begin() == nil, "settings gate starts idle with no intent")
  gate.intent("dark")
  check(gate.begin() == "dark", "settings gate begins with the first intent")
  check(gate.begin() == nil, "settings gate refuses a second begin while in flight")
  gate.intent("light")
  gate.intent("light")
  check(gate.takePending() == "light", "settings gate drains the coalesced latest intent")
  check(gate.takePending() == nil, "settings gate pending is empty after drain")
  gate.finish()
  check(gate.begin() == nil, "settings gate is idle after finish without a new intent")

  // 快速多次 light → dark → system → dark → light：最终只剩最后一个意图生效。
  var rapid = ArkSingleFlightLatestGate()
  rapid.intent("light")
  check(rapid.begin() == "light", "settings gate takes the first rapid intent")
  for value in ["dark", "system", "dark", "light"] { rapid.intent(value) }
  check(rapid.takePending() == "light", "settings gate coalesces rapid intents to the last one")
  check(rapid.takePending() == nil, "settings gate leaves no surplus intent after the last")
  rapid.finish()
  check(!rapid.inFlight, "settings gate returns to idle after finish")

  // 写失败后：在飞标志可以复位，后续新意图能重新起飞（不进入死锁）。
  var failed = ArkSingleFlightLatestGate()
  failed.intent("dark")
  check(failed.begin() == "dark", "settings gate begins a failing write")
  failed.finish()
  failed.intent("light")
  check(failed.begin() == "light", "settings gate restarts after a failed write finishes")

  let suite = "ark-provider-transaction-\(UUID().uuidString)"
  if let transactionDefaults = UserDefaults(suiteName: suite) {
    defer { transactionDefaults.removePersistentDomain(forName: suite) }
    let firstRegistry = ArkProviderTransactionRegistry(defaults: transactionDefaults)
    check(
      firstRegistry.pendingTransactionID(for: "deepseek-official") == nil,
      "reading provider recovery state does not create a transaction"
    )
    let firstID = firstRegistry.transactionID(for: "deepseek-official")
    let restartedRegistry = ArkProviderTransactionRegistry(defaults: transactionDefaults)
    check(
      restartedRegistry.transactionID(for: "deepseek-official") == firstID,
      "native provider transaction id survives an app-model restart"
    )
    for state: ArkProviderTransactionState in [.absent, .prepared, .credentialStaged, .settingsApplied, .credentialApplied] {
      restartedRegistry.acknowledge(provider: "deepseek-official", transactionID: firstID, state: state)
      check(
        restartedRegistry.pendingTransactionID(for: "deepseek-official") == firstID,
        "nonterminal provider status retains pending identity"
      )
    }
    restartedRegistry.acknowledge(provider: "deepseek-official", transactionID: firstID, state: .committed)
    let nextID = restartedRegistry.transactionID(for: "deepseek-official")
    check(
      nextID != firstID,
      "native provider transaction id clears only after a terminal outcome"
    )
    restartedRegistry.acknowledge(provider: "deepseek-official", transactionID: firstID, state: .committed)
    check(
      restartedRegistry.pendingTransactionID(for: "deepseek-official") == nextID,
      "late provider completion cannot clear a newer transaction"
    )
    restartedRegistry.acknowledge(provider: "deepseek-official", transactionID: nextID, state: .rolledBack)
    check(
      restartedRegistry.pendingTransactionID(for: "deepseek-official") == nil,
      "verified rollback releases the native pending identity"
    )
  } else {
    check(false, "native provider transaction registry fixture is available")
  }

  let coreURL = contractNativeRoot.appendingPathComponent(
    "Sources/JiuzhangShellCore/ArkSettingsAPI.swift"
  )
  let modelURL = contractNativeRoot.appendingPathComponent(
    "Sources/JiuzhangShellUI/ArkAppModel.swift"
  )
  let rootViewURL = contractNativeRoot.appendingPathComponent(
    "Sources/JiuzhangShellUI/ArkRootView.swift"
  )
  guard
    let core = try? String(contentsOf: coreURL, encoding: .utf8),
    let model = try? String(contentsOf: modelURL, encoding: .utf8),
    let rootView = try? String(contentsOf: rootViewURL, encoding: .utf8)
  else {
    check(false, "native settings sources are readable")
    return
  }
  check(
    core.contains("public func mutateProvider(")
      && core.contains("method: \"llm/mutateProvider\"")
      && core.contains("\"transactionId\"")
      && core.contains("ArkProviderCredentialMutation")
      && core.contains("public final class ArkProviderTransactionRegistry"),
    "native provider configuration exposes one idempotent Host transaction"
  )
  let settingsDocumentOpener = settingsSourceSlice(
    core,
    from: "public func openSettingsDocument()",
    through: "public func discoverModels("
  )
  let legacySettingsDocumentMethod = "settings" + ".openDocument"
  check(
    settingsDocumentOpener?.contains("try await remoteCall(method: \"settings/openDocument\")") == true
      && settingsDocumentOpener?.contains(legacySettingsDocumentMethod) == false
      && settingsDocumentOpener?.contains("args:") == false
      && settingsDocumentOpener?.contains("guard value[\"opened\"]?.boolValue == true") == true
      && settingsDocumentOpener?.contains("本机服务没有确认打开设置文档") == true,
    "native settings document opener uses one strict no-path Remote and keeps an unavailable result visible"
  )

  let providerWrites = [
    settingsSourceSlice(model, from: "public func saveProviderCredential", through: "public func saveProviderConfiguration"),
    settingsSourceSlice(model, from: "public func saveProviderConfiguration", through: "public func removeProviderProfile"),
    settingsSourceSlice(model, from: "public func removeProviderProfile", through: "public func discoverProviderModels"),
    settingsSourceSlice(model, from: "public func addCustomProvider", through: "public func openSettingsDocument"),
  ]
  let providerLayout = settingsSourceSlice(rootView, from: "private struct NativeModelsSettings:",
    through: "private struct NativeProviderSettingsCard:")
  check(providerLayout?.contains("VStack(spacing: 12)") == true
    && providerLayout?.contains("LazyVStack") == false,
    "expandable provider cards retain eager layout ownership; live scrolling acceptance remains separate")
  check(
    providerWrites.allSatisfy { block in
      block?.contains("commitProviderMutation(") == true
        && block?.contains("client.setCredential(") == false
        && block?.contains("client.unsetCredential(") == false
    }
      && model.contains("let updated = try await client.mutateProvider(")
      && model.contains("providerTransactions.acknowledge(")
      && model.contains("try? await client.providerTransaction("),
    "every cross-store provider write uses the atomic Host transaction without split credential calls"
  )
  check(
    core.contains("method: \"llm/providerTransaction\"")
      && core.contains("method: \"llm/resumeProvider\"")
      && model.contains("public func restoreProviderConfiguration(")
      && rootView.contains("model.restoreProviderConfiguration(")
      && rootView.contains("transactionID: transaction.transactionID"),
    "native Settings exposes explicit recovery through the existing provider transaction owner"
  )

  let appearanceWrite = settingsSourceSlice(
    model,
    from: "private func writeAppearancePreference",
    through: "private var languageGate"
  )
  let obsoleteAppearanceWarning = "本机服务没有提供可写的" + "外观设置"
  check(
    appearanceWrite?.contains("snapshot.namespaces.first(where: { $0.id == \"ui-theme\" })") == true
      && appearanceWrite?.contains("else {\n      return true\n    }") == true
      && appearanceWrite?.contains(obsoleteAppearanceWarning) == false,
    "native appearance remains local-only when ui-theme persistence is unavailable"
  )
  check(
    !model.contains("errorMessage")
      && model.contains("settingsErrorMessage")
      && model.contains("composerErrorMessage")
      && model.contains("navigationErrorMessage")
      && model.contains("knowledgeErrorMessage"),
    "native errors have context owners instead of one global error state"
  )
  check(
    !rootView.contains("model.errorMessage")
      && !rootView.contains("Color.red.opacity(0.82), in: Capsule()")
      && rootView.contains("@AppStorage(\"ark.appearance.preference\")")
      && !model.contains(obsoleteAppearanceWarning),
    "native root has no global red error capsule or obsolete appearance warning"
  )
  let safetyZH = ArkL10n.text(.runtimeSafetyDetail, .zh)
  let safetyEN = ArkL10n.text(.runtimeSafetyDetail, .en)
  check(
    safetyZH.contains("尚未接受独立安全审计")
      && safetyZH.contains("不能保证完全隔离")
      && safetyEN.contains("has not undergone an independent security audit")
      && safetyEN.contains("do not guarantee complete isolation")
      && rootView.contains("ark.settings.runtime-boundary.safety")
      && rootView.contains("ArkL10n.text(.runtimeSafetyDetail, language)")
      && rootView.contains(".accessibilityElement(children: .combine)"),
    "native runtime boundary presents the paired safety disclosure as one accessible settings element"
  )
  let settingsView = settingsSourceSlice(
    rootView,
    from: "private struct NativeSettingsView",
    through: "private struct NativeGeneralSettings"
  )
  check(
    settingsView?.contains("Button {\n            selectSettingsPage(item)") == true
      && settingsView?.contains(".focusable()") == true
      && settingsView?.contains(".focused($focusedPage, equals: item)") == true
      && settingsView?.contains(".accessibilityIdentifier(\"ark.settings.sidebar.\\(item.rawValue)\")") == true
      && settingsView?.contains(".accessibilityAddTraits(page == item ? [.isSelected] : [])") == true
      && settingsView?.contains(".onMoveCommand(perform: moveSettingsPage)") == true
      && settingsView?.contains("focusedPage = page") == true,
    "native settings rows expose AX Press, selected state, initial focus, and ordered keyboard movement"
  )
  check(
    rootView.contains("ark.settings.error")
      && rootView.contains("ark.composer.error")
      && rootView.contains("ark.sidebar.error")
      && rootView.contains("ark.wiki.error")
      && rootView.contains("toolFileNavigationError != nil"),
    "native settings, composer, navigation, wiki, and workbench retain contextual error presentation"
  )

  let displayPanel = settingsSourceSlice(
    rootView,
    from: "private struct NativeChatDisplaySettingsPanel",
    through: "private struct NativeChatTurnNavigationRail"
  )
  let displayOwnerCount = rootView.components(
    separatedBy: "private struct NativeChatDisplaySettingsPanel: View"
  ).count - 1
  let displayCallCount = rootView.components(
    separatedBy: "NativeChatDisplaySettingsPanel("
  ).count - 1
  check(
    displayOwnerCount == 1
      && displayCallCount == 1
      && rootView.contains("showDisplayControls = true")
      && !rootView.contains("settingsGroup(title: .groupChatDisplayTitle"),
    "conversation display controls keep one owner in the session actions popover"
  )
  check(
    displayPanel?.components(separatedBy: "Slider(").count == 3
      && displayPanel?.contains("step:") == false
      && displayPanel?.contains("fontSizeDraft.updateDraft($0)") == true
      && displayPanel?.contains("contentWidthDraft.updateDraft($0)") == true
      && displayPanel?.contains("onEditingChanged: finishFontSizeEditing") == true
      && displayPanel?.contains("onEditingChanged: finishContentWidthEditing") == true
      && displayPanel?.contains("fontSizeDraft.finishEditing { fontSize = $0 }") == true
      && displayPanel?.contains("contentWidthDraft.finishEditing { contentWidth = $0 }") == true
      && displayPanel?.contains("@AppStorage") == false,
    "conversation sliders update local drafts continuously and persist only on editing end"
  )
  check(
    displayPanel?.contains(".frame(width: 328)") == true
      && displayPanel?.contains("displayCard {") == true
      && displayPanel?.contains("ArkPalette.raised.opacity(0.52)") == true
      && displayPanel?.contains("fontSizeDraft.draftValue.rounded()") == true
      && displayPanel?.contains("contentWidthDraft.draftValue.rounded()") == true
      && displayPanel?.contains(".monospacedDigit()") == true
      && displayPanel?.contains(".toggleStyle(.switch)") == true
      && displayPanel?.contains(".disabled(contentWidthAdaptive)") == true
      && displayPanel?.contains(".opacity(contentWidthAdaptive ? 0.46 : 1)") == true,
    "conversation display panel keeps stable raised groups and de-emphasizes adaptive width"
  )
  check(
    displayPanel?.contains(".accessibilityLabel(ArkL10n.text(.chatFontSize, language))") == true
      && displayPanel?.contains(".accessibilityLabel(ArkL10n.text(.chatContentWidth, language))") == true
      && displayPanel?.contains(".accessibilityValue(") == true
      && displayPanel?.contains(".accessibilityAdjustableAction(adjustFontSize)") == true
      && displayPanel?.contains(".accessibilityAdjustableAction(adjustContentWidth)") == true
      && displayPanel?.contains(".focusable()") == true
      && displayPanel?.contains(".frame(minHeight: 32)") == true
      && displayPanel?.contains(".frame(maxWidth: .infinity, minHeight: 36") == true
      && displayPanel?.contains(".animation(") == false
      && displayPanel?.contains("withAnimation") == false,
    "conversation controls retain keyboard, VoiceOver, hit-target, and reduced-motion-safe semantics"
  )
}

private func settingsSourceSlice(
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
  return String(source[startRange.lowerBound..<endRange.lowerBound])
}
