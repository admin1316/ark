import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const integrationRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const nativeRoot = join(integrationRoot, 'native')

test('Native duplicate-key inputs fail or dedupe with domain-specific semantics', async () => {
  const [model, rootView, feedbackApi, apiClient, wikiModels, behaviorContract] = await Promise.all([
    readFile(join(nativeRoot, 'Sources/JiuzhangShellUI/ArkAppModel.swift'), 'utf8'),
    readFile(join(nativeRoot, 'Sources/JiuzhangShellUI/ArkRootView.swift'), 'utf8'),
    readFile(join(nativeRoot, 'Sources/JiuzhangShellCore/ArkFeedbackAPI.swift'), 'utf8'),
    readFile(join(nativeRoot, 'Sources/JiuzhangShellCore/ArkAPIClient.swift'), 'utf8'),
    readFile(join(nativeRoot, 'Sources/JiuzhangShellUI/ArkWikiModels.swift'), 'utf8'),
    readFile(join(nativeRoot, 'Tests/JiuzhangShellCoreTests/ArkDuplicateKeyContractChecks.swift'), 'utf8'),
  ])

  for (const source of [model, rootView]) {
    assert.doesNotMatch(source, /Dictionary\(uniqueKeysWithValues:/)
  }
  assert.match(model, /ArkProviderModelInput\.encodedRows[\s\S]*preserving:/)
  assert.match(model, /firstFeedbackByMessageID\[item\.messageID\] == nil/)
  assert.match(feedbackApi, /seenMessageIDs\.insert\(decoded\.messageID\)[\s\S]*invalidResponse\("list duplicate messageId"\)/)
  assert.match(apiClient, /uniquePreservingFirst[\s\S]*seen\.insert\(\$0\.id\)\.inserted/)
  assert.match(wikiModels, /firstGraphNodeByPath[\s\S]*result\[path\] == nil/)
  assert.match(wikiModels, /uniqueFileRowsByPath[\s\S]*seen\.insert\(path\)\.inserted/)
  assert.match(wikiModels, /uniquePagesByID[\s\S]*seen\.insert\(\$0\.id\)\.inserted/)
  assert.match(behaviorContract, /duplicate message ids as an invalid wire response/)
  assert.match(behaviorContract, /first stored row for duplicate ids/)
  assert.match(behaviorContract, /first node for each nonempty path/)
})

test('Native PTY uses a pre-exec session helper and awaits owned-session teardown', async () => {
  const [main, contractMain, processOwner, terminal, workbench, behaviorContract] = await Promise.all([
    readFile(join(nativeRoot, 'Sources/JiuzhangShell/main.swift'), 'utf8'),
    readFile(join(nativeRoot, 'Tests/JiuzhangShellCoreTests/main.swift'), 'utf8'),
    readFile(join(nativeRoot, 'Sources/JiuzhangShellUI/NativePTYProcess.swift'), 'utf8'),
    readFile(join(nativeRoot, 'Sources/JiuzhangShellUI/NativePTYTerminalView.swift'), 'utf8'),
    readFile(join(nativeRoot, 'Sources/JiuzhangShellUI/NativeWorkbenchView.swift'), 'utf8'),
    readFile(join(nativeRoot, 'Tests/JiuzhangShellCoreTests/ArkNativePTYTerminalBehaviorContractChecks.swift'), 'utf8'),
  ])

  for (const entry of [main, contractMain]) {
    assert.match(entry, /NativePTYTerminalChild\.exitStatusIfRequested\(\)[\s\S]*Darwin\._exit/)
  }
  assert.match(processOwner, /POSIX_SPAWN_SETSID/)
  assert.match(processOwner, /login_tty[\s\S]*tcsetpgrp[\s\S]*tcgetpgrp/)
  assert.match(processOwner, /ARK_INTERNAL_PTY_NONCE[\s\S]*unsetenv/)
  assert.match(processOwner, /retainedEnvironmentNames[\s\S]*baseEnvironment\.filter/)
  assert.match(processOwner, /SIGHUP[\s\S]*SIGTERM[\s\S]*SIGKILL[\s\S]*waitpid/)
  assert.match(processOwner, /getsid\(\$0\) == sessionID/)
  assert.doesNotMatch(terminal, /\bProcess\(\)|process\.run\(\)|setpgid/)
  assert.match(terminal, /func shutdown\(\) async[\s\S]*await processOwner\.shutdown\(\)/)
  assert.match(workbench, /await session\.shutdown\(\)[\s\S]*terminalSessions\.removeValue/)
  assert.match(behaviorContract, /ordinary background child/)
  assert.match(behaviorContract, /nohup child/)
  assert.match(behaviorContract, /deliberately calls setsid/)
  assert.match(behaviorContract, /bounded KILL and reaps/)
})

test('Ark uses a native SwiftUI interface and a dedicated API-only bundle', async () => {
  const [manifest, delegate, shellContract, eventPump, model, rootView, trajectoryView, scrollCoordinator, composerView, archiveSidebar, archiveApi, settingsApi, managementApi, buildApp, english, profileManifest, apiBundle, rawJSONView, l10n, workbenchView, browserView, nativeEntry] = await Promise.all([
    readFile(join(nativeRoot, 'Package.swift'), 'utf8'),
    readFile(join(nativeRoot, 'Sources/JiuzhangShell/AppDelegate.swift'), 'utf8'),
    readFile(join(nativeRoot, 'Sources/JiuzhangShellCore/ShellContract.swift'), 'utf8'),
    readFile(join(nativeRoot, 'Sources/JiuzhangShellCore/ArkEventPump.swift'), 'utf8'),
    readFile(join(nativeRoot, 'Sources/JiuzhangShellUI/ArkAppModel.swift'), 'utf8'),
    readFile(join(nativeRoot, 'Sources/JiuzhangShellUI/ArkRootView.swift'), 'utf8'),
    readFile(join(nativeRoot, 'Sources/JiuzhangShellUI/NativeTrajectoryParityView.swift'), 'utf8'),
    readFile(join(nativeRoot, 'Sources/JiuzhangShellUI/ArkChatScrollCoordinator.swift'), 'utf8'),
    readFile(join(nativeRoot, 'Sources/JiuzhangShellUI/NativeComposerTextView.swift'), 'utf8'),
    readFile(join(nativeRoot, 'Sources/JiuzhangShellUI/NativeArchiveSidebarView.swift'), 'utf8'),
    readFile(join(nativeRoot, 'Sources/JiuzhangShellCore/ArkArchiveAPI.swift'), 'utf8'),
    readFile(join(nativeRoot, 'Sources/JiuzhangShellCore/ArkSettingsAPI.swift'), 'utf8'),
    readFile(join(nativeRoot, 'Sources/JiuzhangShellCore/ArkManagementAPI.swift'), 'utf8'),
    readFile(join(nativeRoot, 'build-app.sh'), 'utf8'),
    readFile(join(nativeRoot, 'Resources/en.lproj/Localizable.strings'), 'utf8'),
    readFile(join(integrationRoot, 'profile/package.json'), 'utf8'),
    readFile(join(integrationRoot, '../../packages/bundle/native-api-app/cordis.patch.yml'), 'utf8'),
    readFile(join(nativeRoot, 'Sources/JiuzhangShellUI/NativeRawJSONTextView.swift'), 'utf8'),
    readFile(join(nativeRoot, 'Sources/JiuzhangShellUI/ArkL10n.swift'), 'utf8'),
    readFile(join(nativeRoot, 'Sources/JiuzhangShellUI/NativeWorkbenchView.swift'), 'utf8'),
    readFile(join(nativeRoot, 'Sources/JiuzhangShellUI/NativeWorkbenchBrowserView.swift'), 'utf8'),
    readFile(join(integrationRoot, '../../packages/boot/native-api-runner/src/index.ts'), 'utf8'),
  ])
  const [mainSource, infoPlist, entitlements] = await Promise.all([
    readFile(join(nativeRoot, 'Sources/JiuzhangShell/main.swift'), 'utf8'),
    readFile(join(nativeRoot, 'Resources/Info.plist'), 'utf8'),
    readFile(join(nativeRoot, 'Resources/ark.entitlements'), 'utf8'),
  ])

  assert.doesNotMatch(manifest, /linkedFramework\("WebKit"\)/)
  assert.doesNotMatch(manifest, /Sparkle/)
  assert.doesNotMatch(mainSource, /Sparkle|SPUStandardUpdaterController/)
  assert.doesNotMatch(infoPlist, /SUFeedURL|SUEnableAutomaticChecks|SUPublicEDKey/)
  assert.doesNotMatch(entitlements, /disable-library-validation/)
  assert.doesNotMatch(buildApp, /Sparkle|generate_appcast|sign_update|SUPublicEDKey/)
  assert.doesNotMatch(delegate, /\bWKWebView\b|import WebKit/)
  for (const nativeShellSource of [model, rootView, trajectoryView, workbenchView]) {
    assert.doesNotMatch(nativeShellSource, /\bWKWebView\b|import WebKit/)
  }
  assert.doesNotMatch(browserView, /import WebKit|WKWebView/)
  assert.match(browserView, /NSWorkspace\.shared\.open/)
  assert.match(browserView, /ark\.workbench\.browser/)
  assert.match(nativeEntry, /watchLiveConfig: false/)
  assert.match(nativeEntry, /ARK_NATIVE_API_PROFILE = 'jiuzhang'/)
  assert.match(delegate, /NSHostingView<ArkRootView>/)
  assert.match(delegate, /NSWindow\.allowsAutomaticWindowTabbing = false/)
  assert.match(delegate, /window\.titleVisibility = \.hidden/)
  assert.match(delegate, /window\.tabbingMode = \.disallowed/)
  assert.match(delegate, /prepareDefaultKnowledgeProject\(locations: locations\)/)
  assert.match(delegate, /let wiki = locations\.wikiRoot/)
  assert.match(delegate, /let root = locations\.knowledgeRoot/)
  assert.match(shellContract, /Application Support[\s\S]*Ark[\s\S]*Knowledge/)
  assert.match(shellContract, /protectedWorkspaceReason[\s\S]*Ark 应用与内嵌 runtime[\s\S]*Ark 产品数据目录/)
  assert.match(model, /ArkEventPump/)
  const pumpStop = eventPump.slice(
    eventPump.indexOf('public func stop() async'),
    eventPump.indexOf('private func run(channel: ArkEventChannel) async'),
  )
  assert.match(pumpStop, /if let stopTask[\s\S]*lifecycle = \.stopping/)
  assert.match(pumpStop, /socket\.cancel[\s\S]*pump\.cancel\(\)[\s\S]*await mailbox\.finish\(\)[\s\S]*await pump\.value/)
  const modelShutdown = model.slice(
    model.indexOf('public func shutdown() async'),
    model.indexOf('public func refreshNavigation(refreshWiki: Bool = true) async'),
  )
  assert.match(modelShutdown, /consumer\?\.cancel\(\)[\s\S]*await eventPump\.stop\(\)[\s\S]*await consumer\.value/)
  const delegateShutdown = delegate.slice(
    delegate.indexOf('private func shutdownNativeInterface() async'),
    delegate.indexOf('private func showStarting()'),
  )
  assert.match(delegateShutdown, /await model\.shutdown\(\)[\s\S]*hostingView\?\.removeFromSuperview\(\)[\s\S]*appModel = nil/)
  assert.match(delegate, /func applicationShouldTerminate[\s\S]*await shutdownNativeInterface\(\)[\s\S]*backend\.stop/)
  assert.match(delegate, /backend\.onExit[\s\S]*await self\.shutdownNativeInterface\(\)[\s\S]*self\.startBackend\(\)/)
  assert.match(delegate, /backend\.onLine[\s\S]*!self\.requestedTermination[\s\S]*showNativeInterface/)
  assert.match(delegate, /private func showNativeInterface[\s\S]*guard !requestedTermination, backend\.isRunning/)
  assert.equal(delegate.match(/appModel = nil/g)?.length, 1)
  assert.doesNotMatch(model, /while !Task\.isCancelled[\s\S]{0,200}refreshHistory/)
  assert.doesNotMatch(model, /pruneColdBlankSessions/)
  assert.match(model, /beginNewConversation\(\)/)
  assert.match(model, /knowledgeWiki\/listProjects/)
  assert.match(model, /selectedKnowledgeProjectPath/)
  assert.match(rootView, /LazyVStack/)
  assert.match(rootView, /NativeTrajectoryParityView/)
  assert.match(trajectoryView, /Turn[\s\S]*Step/)
  assert.match(trajectoryView, /loadOlderHistory/)
  assert.match(scrollCoordinator, /ArkChatScrollStateMachine/)
  assert.match(rootView, /ArkChatScrollAttachment/)
  assert.match(composerView, /event\.isARepeat/)
  assert.match(composerView, /NativeComposerSubmitAction\.resolve/)
  assert.match(composerView, /modifierFlags\.contains\(\.shift\)/)
  assert.match(composerView, /hasMarkedText: composing/)
  assert.match(composerView, /performDragOperation[\s\S]*onAddAttachmentURLs/)
  assert.match(composerView, /ArkDocumentReferenceStore\.longPasteThreshold[\s\S]*onPasteDocument/)
  assert.match(rootView, /UTType\.fileURL[\s\S]*ArkL10n\.text\(\.dropImagesHere/)
  assert.match(rootView, /NativeSettingsView/)
  assert.match(rootView, /\.allowsHitTesting\(!showSettings\)/)
  assert.match(rootView, /\.accessibilityHidden\(showSettings\)/)
  assert.match(rootView, /NativeAgentPresetSettings/)
  assert.match(rootView, /NativePluginSettings/)
  assert.match(rootView, /ark\.settings\.close/)
  assert.match(rootView, /\.keyboardShortcut\(\.cancelAction\)/)
  assert.match(rootView, /fill\(Color\.black\.opacity\(colorScheme == \.dark \? 0\.32 : 0\.12\)\)/)
  assert.doesNotMatch(rootView, /showSettings[\s\S]{0,500}ultraThinMaterial/)
  assert.match(rootView, /Text\(statusLabel\)[\s\S]*expanded \? "chevron\.down" : "chevron\.right"/)
  assert.match(rootView, /@State private var expanded = false[\s\S]*dirty \? \.extensionUnsaved : \.extensionOverridden/)
  assert.match(rootView, /Button\(ArkL10n\.text\(\.extensionDiscardChanges, language\), action: discard\)[\s\S]*disabled\(busy \|\| !dirty\)/)
  assert.match(rootView, /Button\(ArkL10n\.text\(\.commonSave, language\), action: save\)[\s\S]*disabled\(busy \|\| !dirty \|\| !valid\)/)
  assert.match(rootView, /extensionCollapseDetails[\s\S]*extensionExpandDetails[\s\S]*extensionEntryID/)
  assert.match(rootView, /NativeArchiveSidebarView/)
  assert.doesNotMatch(rootView, /\.sheet\(isPresented: \$showArchiveCenter\)/)
  assert.match(rootView, /ark\.sidebar\.collapsed/)
  assert.match(rootView, /sidebarCollapsed \? 56 : sidebarWidth/)
  assert.match(rootView, /groupSessionsByWorkspace/)
  assert.match(rootView, /reorderWorkspace/)
  assert.match(rootView, /reorderSession/)
  assert.match(rootView, /ArkL10n\.text\(\.wikiSwitchWorkspaceHelp/)
  assert.match(l10n, /wikiSwitchWorkspaceHelp[\s\S]*切换万相织鉴知识工作区[\s\S]*Switch Wanxiang knowledge workspace/)
  assert.match(rootView, /showsConversationChrome/)
  assert.match(rootView, /!\$0\.blank/)
  assert.doesNotMatch(rootView, /homeDirectoryForCurrentUser\.appendingPathComponent\("ark"/)
  assert.match(archiveSidebar, /restoreArchivedSession/)
  assert.match(archiveSidebar, /deleteArchivedSessionPermanently/)
  assert.match(archiveApi, /workspace\/unarchiveSession/)
  assert.match(archiveApi, /workspace\/deleteArchivedSession/)
  assert.match(settingsApi, /credentials\/set/)
  assert.match(settingsApi, /settings\/mutate/)
  assert.match(model, /setLanguagePreference/)
  assert.match(model, /setAppearancePreference/)
  assert.match(trajectoryView, /NativeRawJSONTextView\(text: ArkTrajectoryProjection\.detailJSON\(for: record\)\)/)
  assert.match(trajectoryView, /if tab == \.source \{[\s\S]*NativeRawJSONTextView[\s\S]*\} else \{[\s\S]*ScrollView\(\.vertical\)/)
  assert.match(trajectoryView, /case \.source:[\s\S]*EmptyView\(\)/)
  assert.match(rawJSONView, /NSTextView\(usingTextLayoutManager: true\)/)
  assert.doesNotMatch(rawJSONView, /textView\.textStorage\?\.setAttributedString/)
  assert.match(rawJSONView, /textContentStorage\?\.textStorage/)
  assert.match(rawJSONView, /isEditable = false[\s\S]*isSelectable = true[\s\S]*isRichText = false/)
  assert.match(rawJSONView, /newText != coordinator\.lastText[\s\S]*lastText = newText/)
  assert.match(model, /appearanceGate\.intent\(preference\)[\s\S]*guard let first = appearanceGate\.begin\(\)/)
  assert.match(model, /while let next = intent \{[\s\S]*writeAppearancePreference\(next\)[\s\S]*takePending\(\)/)
  assert.match(model, /catch \{[\s\S]*await loadSettings\(\)[\s\S]*settingsErrorMessage = error\.localizedDescription[\s\S]*return false/)
  assert.match(model, /writeAppearancePreference[\s\S]*ui-theme[\s\S]*else \{\s*return true\s*\}/)
  assert.doesNotMatch(rootView, /action: \{ appearance = \.system \}[\s\S]{0,300}?\.disabled\(model\.settingsBusy\)/)
  const obsoleteAppearanceWarning = ['本机服务没有提供可写的', '外观设置'].join('')
  assert.ok(!model.includes(obsoleteAppearanceWarning))
  assert.doesNotMatch(rootView, /model\.errorMessage|Color\.red\.opacity\(0\.82\), in: Capsule\(\)/)
  assert.match(rootView, /@AppStorage\("ark\.appearance\.preference"\)/)
  assert.match(rootView, /ark\.sidebar\.error/)
  assert.match(rootView, /ark\.composer\.error/)
  assert.match(rootView, /ark\.wiki\.error/)
  assert.match(rootView, /ark\.settings\.error/)
  assert.match(model, /setDefaultAgentPreset[\s\S]*namespace\.id[\s\S]*path: \["default"\]/)
  assert.match(rootView, /get: \{ model\.defaultAgentPresetID[\s\S]*set: \{ model\.setDefaultAgentPreset\(\$0\) \}/)
  assert.match(rootView, /NSApp\.appearance/)
  assert.doesNotMatch(rootView, /private enum Section/)
  assert.doesNotMatch(rootView, /@State private var section:/)
  assert.doesNotMatch(rootView, /languageRaw/)
  assert.doesNotMatch(rootView, /Text\("原生运行边界"\)/)
  assert.match(rootView, /private enum SettingsPage[\s\S]*case general[\s\S]*case models[\s\S]*case plugins[\s\S]*case presets/)
  assert.match(rootView, /NavigationSplitView[\s\S]*ForEach\(SettingsPage\.allCases\)[\s\S]*Button \{\s*selectSettingsPage\(item\)/)
  assert.match(rootView, /\.focused\(\$focusedPage, equals: item\)[\s\S]*ark\.settings\.sidebar\.[\s\S]*\.accessibilityAddTraits/)
  assert.match(rootView, /\.onMoveCommand\(perform: moveSettingsPage\)[\s\S]*focusedPage = page/)
  const displayPanelStart = rootView.indexOf('private struct NativeChatDisplaySettingsPanel')
  const displayPanelEnd = rootView.indexOf('private struct NativeChatTurnNavigationRail', displayPanelStart)
  assert.ok(displayPanelStart !== -1 && displayPanelEnd !== -1)
  const displayPanel = rootView.slice(displayPanelStart, displayPanelEnd)
  assert.equal(rootView.split('private struct NativeChatDisplaySettingsPanel: View').length - 1, 1)
  assert.equal(rootView.split('NativeChatDisplaySettingsPanel(').length - 1, 1)
  assert.equal(displayPanel.split('Slider(').length - 1, 2)
  assert.doesNotMatch(displayPanel, /step:/)
  assert.match(displayPanel, /fontSizeDraft\.updateDraft\(\$0\)[\s\S]*onEditingChanged: finishFontSizeEditing/)
  assert.match(displayPanel, /contentWidthDraft\.updateDraft\(\$0\)[\s\S]*onEditingChanged: finishContentWidthEditing/)
  assert.match(displayPanel, /finishEditing \{ fontSize = \$0 \}[\s\S]*finishEditing \{ contentWidth = \$0 \}/)
  assert.match(displayPanel, /\.frame\(width: 328\)[\s\S]*ark\.chat\.display-settings-panel/)
  assert.match(displayPanel, /\.toggleStyle\(\.switch\)[\s\S]*\.disabled\(contentWidthAdaptive\)[\s\S]*\.opacity\(contentWidthAdaptive \? 0\.46 : 1\)/)
  assert.match(displayPanel, /\.accessibilityLabel[\s\S]*\.accessibilityValue[\s\S]*\.accessibilityAdjustableAction/)
  assert.doesNotMatch(displayPanel, /\.animation\(|withAnimation/)
  assert.doesNotMatch(displayPanel, /@AppStorage/)
  assert.match(rootView, /settingsGroup\(title: \.groupDefaultPresetTitle, subtitle: \.groupDefaultPresetSubtitle\)/)
  assert.match(rootView, /settingsGroup\(title: \.groupDefaultPermissionTitle, subtitle: \.groupDefaultPermissionSubtitle\)/)
  assert.match(rootView, /settingsGroup\(title: \.groupInterfaceLanguageTitle, subtitle: \.groupInterfaceLanguageSubtitle\)/)
  assert.match(rootView, /settingsGroup\(title: \.groupAppearanceTitle, subtitle: \.groupAppearanceSubtitle\)/)
  assert.match(rootView, /settingsGroup\(title: \.groupEnterKeyTitle, subtitle: \.groupEnterKeySubtitle\)/)
  assert.match(rootView, /settingsGroup\(title: \.groupRuntimeBoundaryTitle, subtitle: nil\)/)
  assert.match(rootView, /ArkL10n\.text\(\.runtimeInterface, language\)/)
  assert.match(rootView, /ArkL10n\.text\(\.runtimeInterfaceValue, language\)/)
  assert.match(rootView, /ArkL10n\.text\(\.runtimeBackend, language\)/)
  assert.match(rootView, /ArkL10n\.text\(\.runtimeBackendValue, language\)/)
  assert.match(rootView, /Text\(item\.title\(model\.languagePreference\)\)/)
  assert.match(l10n, /public static func text\(/)
  assert.match(l10n, /case sessionLog/)
  assert.match(l10n, /static let table: \[Key: Entry\] = \[/)
  assert.doesNotMatch(l10n, /String\(contentsOf|JSONDecoder|FileManager/)
  assert.ok(model.includes('languageGate = ArkSingleFlightLatestGate()'))
  assert.ok(model.includes('guard let first = languageGate.begin()'))
  assert.ok(model.includes('syncLanguagePreferenceFromSettings()'))
  assert.ok(model.includes('@Published public private(set) var languagePreference'))

  assert.ok(model.includes('private var userHasNavigated = false'))
  assert.ok(model.includes('public func userSelectedTab(_ tab: Tab)'))
  assert.ok(model.includes('selectSession(restoredSession, navigateToChat: false)'))
  assert.ok(model.includes('private func isTaskCancellation(_ error: Error) -> Bool'))

  // cancellation guard 必须先于 Wiki 数据清空，且限定在 loadWiki 函数边界内证明。
  const loadWikiStart = model.indexOf('func loadWiki')
  assert.ok(loadWikiStart !== -1)
  const loadWikiEnd = model.indexOf('private func', loadWikiStart + 1)
  assert.ok(loadWikiEnd !== -1)
  const loadWikiBody = model.slice(loadWikiStart, loadWikiEnd)
  const loadWikiCatch = loadWikiBody.indexOf('} catch {')
  assert.ok(loadWikiCatch !== -1)
  const wikiCancelGuard = loadWikiBody.indexOf('if isTaskCancellation(error) { return }', loadWikiCatch)
  const wikiClear = loadWikiBody.indexOf('wikiPages = []', loadWikiCatch)
  assert.ok(wikiCancelGuard !== -1 && wikiClear !== -1 && wikiCancelGuard < wikiClear)

  // refreshNavigation：cancellation guard 必须先于侧栏内联错误写入；
  // 边界用紧邻的真实下一个声明（selectSession），不做宽泛的下一函数搜索。
  const refreshNavStart = model.indexOf('public func refreshNavigation')
  assert.ok(refreshNavStart !== -1)
  const refreshNavEnd = model.indexOf('\n  public func selectSession', refreshNavStart + 1)
  assert.ok(refreshNavEnd !== -1)
  const refreshNavBody = model.slice(refreshNavStart, refreshNavEnd)
  const refreshNavCatch = refreshNavBody.indexOf('} catch {')
  assert.ok(refreshNavCatch !== -1)
  const refreshNavGuard = refreshNavBody.indexOf('if isTaskCancellation(error) { return }', refreshNavCatch)
  const refreshNavError = refreshNavBody.indexOf('navigationErrorMessage = error.localizedDescription', refreshNavCatch)
  assert.ok(refreshNavGuard !== -1 && refreshNavError !== -1 && refreshNavGuard < refreshNavError)

  // 禁止字符串特判；空吞异常检查仅为辅助格式防回归。
  assert.ok(!model.includes('"已取消"'))
  assert.ok(!model.includes('catch { return }'))

  assert.ok(rootView.includes('model.userSelectedTab(tab)'))
  assert.ok(!rootView.includes('model.selectedTab = tab'))
  assert.ok(rootView.includes('.contentShape(Rectangle())'))

  // 语言切换不得挂在全树 .animation(..., value: model.languagePreference) 或 withAnimation 上
  assert.doesNotMatch(
    rootView,
    /\.animation\([\s\S]{0,240}value:\s*model\.languagePreference/
  )
  assert.doesNotMatch(
    rootView,
    /withAnimation[^\{]*\{[\s\S]{0,180}(?:languagePreference\s*=|setLanguagePreference\()/
  )

  assert.ok(buildApp.includes('Resources/*.lproj'))
  // A2-2b：参数化 Toast 使用 ArkL10n.format；模板含 {0}；禁止动态中文字面量直接入 postResultMessage
  assert.ok(model.includes('ArkL10n.format(.toastCredentialSavedSecure, languagePreference, arguments: [provider.displayName])'))
  assert.ok(model.includes('ArkL10n.format(.toastKnowledgeHits, languagePreference, arguments: [String(hits.count)])'))
  assert.ok(model.includes('ArkL10n.format(.toastSessionExported, languagePreference, arguments: [String(exported.bytes)])'))
  assert.ok(!model.includes('postResultMessage("已保存'))
  assert.ok(!model.includes('postResultMessage("找到'))
  assert.ok(l10n.includes('public static func format('))
  assert.ok(l10n.includes('{0} 凭据已保存到安全存储'))
  assert.ok(l10n.includes('{0} credential saved to secure storage'))
  // A2-1：Tab 展示名双语；导航/侧栏迁移 ArkL10n
  assert.ok(rootView.includes('extension ArkAppModel.Tab'))
  assert.ok(rootView.includes('func displayName(_ language: ArkLanguagePreference)'))
  assert.ok(rootView.includes('Text(tab.displayName(model.languagePreference))'))
  assert.ok(rootView.includes('Text(item.displayName(model.languagePreference))'))
  assert.ok(!rootView.includes('Text(tab.rawValue)'))
  assert.ok(!rootView.includes('Text(LocalizedStringKey(item.rawValue))'))
  assert.ok(rootView.includes('ArkL10n.text(.brandTitle, model.languagePreference)'))
  assert.ok(rootView.includes('ArkL10n.text(.archiveTitle, model.languagePreference)'))
  assert.ok(rootView.includes('ArkL10n.text(.searchResults, model.languagePreference)'))
  // Navigation Performance Repair 契约：Chat 只标 dirty；Trajectory 在后台
  // single-flight 折叠最新事件快照，主线程只安装最终缓存。
  assert.ok(model.includes('private func markTrajectoryProjectionDirty()'))
  assert.ok(model.includes('private func scheduleTrajectoryProjectionIfNeeded()'))
  assert.ok(model.includes('Task.detached(priority: .userInitiated)'))
  assert.ok(model.includes('trajectoryProjectionTask == nil'))
  assert.ok(!model.includes('trajectoryRecords = ArkTrajectoryProjection.records(from: events)'))
  assert.ok(model.includes('@Published public private(set) var trajectoryRecords'))
  assert.ok(trajectoryView.includes('model.trajectoryRecords'))
  assert.ok(!trajectoryView.includes('records(from: model.events)'))
  // New-session choices use the refreshed Host catalog, never historical session rows.
  assert.ok(model.includes('hostModelGroups = groups'))
  assert.ok(model.includes('let groups = availableModelGroups'))
  assert.ok(!model.includes('lastKnownModelGroups'))
  // A1 Issue 2：工作区头行整块可点（满宽 label + contentShape）
  assert.ok(rootView.includes('.frame(maxWidth: .infinity, minHeight: 34, alignment: .leading)'))
  // workbenchRoot teardown closure：禁止 live root identity 直绑（防 destructive recreation）
  assert.ok(!rootView.includes('.id(workbenchRoot.path)'))

  // Files Repair A：固定文案走 ArkL10n，Export 走 NSSavePanel，取消不写任何错误状态
  assert.ok(workbenchView.includes('ArkL10n.text(.filesSave, language)'))
  assert.ok(workbenchView.includes('ArkL10n.text(.filesExport, language)'))
  assert.ok(workbenchView.includes('NSSavePanel()'))
  assert.ok(workbenchView.includes('guard panel.runModal() == .OK, let destination = panel.url else { return }'))
  assert.ok(workbenchView.includes('func exportSelectedFile()'))
  // 禁止第二份语言状态（只锁赋值/声明形式，不锁注释里的单词）
  assert.ok(!workbenchView.includes('model.languagePreference = language'))
  assert.ok(!workbenchView.includes('@Published var languagePreference'))
  assert.ok(!workbenchView.includes('@State var languagePreference'))
  assert.ok(!workbenchView.includes('var languagePreference: ArkLanguagePreference'))
  // Export 只写 SavePanel 返回的 destination，绝不写源文件
  assert.ok(workbenchView.includes('active.text.write(to: destination'))
  assert.ok(!workbenchView.includes('write(to: selectedFileURL'))
  assert.ok(workbenchView.includes('enum NativeWorkbenchStatus'))
  assert.ok(workbenchView.includes('let language: ArkLanguagePreference'))
  assert.match(english, /"设置" = "Settings";/)
  assert.match(managementApi, /agentPreset\/list/)
  assert.match(managementApi, /pluginInventory\/list/)
  assert.doesNotMatch(rootView, /WKWebView|import WebKit/)
  assert.match(profileManifest, /@deepseek-ai\/dsh-native-api-app/)
  assert.doesNotMatch(profileManifest, /@deepseek-ai\/dsh-web-app/)
  assert.match(apiBundle, /apiOnly:\s*true/)
  assert.match(apiBundle, /dsh-host-connection/)
  assert.doesNotMatch(apiBundle, /dsh-host-frontend-static|dsh-client-/)
  assert.match(shellContract, /dsh native-api: /)
})
