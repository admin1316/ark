import Foundation
import JiuzhangShellCore
@testable import JiuzhangShellUI

/// ui-theme 写入闸门的行为契约：single-flight + latest-intent 合并。
func runArkSettingsContractChecks() {
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
    let firstID = firstRegistry.transactionID(for: "deepseek-official")
    let restartedRegistry = ArkProviderTransactionRegistry(defaults: transactionDefaults)
    check(
      restartedRegistry.transactionID(for: "deepseek-official") == firstID,
      "native provider transaction id survives an app-model restart"
    )
    restartedRegistry.clear(provider: "deepseek-official")
    check(
      restartedRegistry.transactionID(for: "deepseek-official") != firstID,
      "native provider transaction id clears only after a terminal outcome"
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
  check(
    providerWrites.allSatisfy { block in
      block?.contains("commitProviderMutation(") == true
        && block?.contains("client.setCredential(") == false
        && block?.contains("client.unsetCredential(") == false
    }
      && model.contains("let updated = try await client.mutateProvider(")
      && model.contains("code != \"provider-transaction-in-doubt\""),
    "every cross-store provider write uses the atomic Host transaction without split credential calls"
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
