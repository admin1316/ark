import AppKit
import Foundation
import QuartzCore
@testable import JiuzhangShellUI

/// 产品壳层契约：Chat 主 header 是纯 Native 产品语义——
/// 呼吸灯与 Workbench 入口保留，runtime/plugin/debug 品牌不得出现在
/// 用户可见壳层；扩展管理使用中性「扩展」产品语义。
/// 内部技术标识（Cordis/Host Loader 等）允许存在于源码非可见逻辑，
/// 只在具体可见 block 内禁止。
func runArkShellParityContractChecks() {
  let rootURL = contractNativeRoot.appendingPathComponent(
    "Sources/JiuzhangShellUI/ArkRootView.swift"
  )
  let workbenchURL = contractNativeRoot.appendingPathComponent(
    "Sources/JiuzhangShellUI/NativeWorkbenchView.swift"
  )
  let trajectoryURL = contractNativeRoot.appendingPathComponent(
    "Sources/JiuzhangShellUI/NativeTrajectoryParityView.swift"
  )
  let l10nURL = contractNativeRoot.appendingPathComponent(
    "Sources/JiuzhangShellUI/ArkL10n.swift"
  )
  guard
    let root = try? String(contentsOf: rootURL, encoding: .utf8),
    let workbench = try? String(contentsOf: workbenchURL, encoding: .utf8),
    let trajectory = try? String(contentsOf: trajectoryURL, encoding: .utf8),
    let l10n = try? String(contentsOf: l10nURL, encoding: .utf8)
  else {
    check(false, "native shell sources are readable for parity checks")
    return
  }

  let header = sourceSlice(
    root,
    from: "private struct NativeSessionHeader: View",
    through: "private struct NativeSubagentLineageControl: View"
  )
  let headerLeadingControls = sourceSlice(
    header ?? "",
    from: "HStack(spacing: 10) {",
    through: "WindowDragSurface()"
  )
  check(
    header != nil
      && header?.contains("NativeSessionActivityIndicator(model: model, state: indicatorState)") == true
      && header?.contains("Label(\"任务 ") == false
      && header?.contains("ark.session.open-workbench") == false
      && header?.contains("exportSessionLog") == false
      && root.contains("private struct NativeSessionActionsMenu")
      && root.contains("ark.global.session-actions")
      && header?.contains("agentPreset") == false
      && header?.contains("子代理") == false
      && header?.contains("NativeSubagentLineageControl(model: model)") == true
      && header?.contains(".sessionLog") == false
      && header?.contains("cancelSelectedSession") == false
      && header?.contains(".frame(minWidth: 111, minHeight: 32)") == false,
    "native chat header keeps the breathing light and contextual lineage while dropping constant stop, preset, subagent, and session-log entries"
  )
  check(
    headerLeadingControls?.contains("if let parent = model.selectedSessionParent") == true
      && headerLeadingControls?.contains("model.selectSession(parent.id)") == true
      && headerLeadingControls?.contains("Image(systemName: \"chevron.left\")") == true
      && headerLeadingControls?.contains(".frame(width: 28, height: 28)") == true
      && headerLeadingControls?.contains(".contentShape(Rectangle())") == true
      && headerLeadingControls?.contains("ark.session.return-to-parent") == true
      && header?.components(separatedBy: "selectedSessionParent").count == 2
      && header?.contains("arrow.turn.up.left") == false,
    "native parent navigation stays once, left of the flexible drag region, with one full icon hit target"
  )

  let composer = sourceSlice(
    root,
    from: "private struct NativeComposer: View",
    through: "private struct NativeSessionStatsBar: View"
  )
  check(
    composer?.contains("Button(action: model.cancelSelectedSession)") == true
      && composer?.contains("Image(systemName: \"stop.fill\")") == true,
    "native composer retains the one task-stop control after the duplicate header control is removed"
  )

  let statusLight = sourceSlice(
    root,
    from: "private struct NativeSessionStatusLight: NSViewRepresentable",
    through: "private struct NativeSessionExportPanel: View"
  )
  let activityIndicator = sourceSlice(
    root,
    from: "private struct NativeSessionActivityIndicator: View",
    through: "private struct NativeSessionActivityPopover: View"
  )
  check(
    statusLight?.contains("NativeSessionStatusLightLayerView") == true
      && statusLight?.contains("let emphasized = state != .idle") == true
      && statusLight?.contains("dot.shadowOpacity = emphasized ? 0.52 : 0.28") == true
      && statusLight?.contains("dot.shadowRadius = emphasized ? 4 : 2") == true
      && statusLight?.contains("CABasicAnimation") == false
      && statusLight?.contains("repeatCount") == false
      && statusLight?.contains("NativeContinuousAnimationGate") == false
      && statusLight?.contains("view.dismantle()") == true
      && statusLight?.contains("dot.removeAllAnimations()") == true
      && activityIndicator?.contains("NativeSessionStatusLight(") == true
      && activityIndicator?.contains("state: state") == true
      && activityIndicator?.contains("language: model.languagePreference") == true
      && activityIndicator?.contains("onHover: hoverChanged") == true
      && activityIndicator?.contains(".overlay(alignment: .topLeading)") == true
      && activityIndicator?.contains(".offset(x: -8, y: 24)") == true
      && activityIndicator?.contains("ark.session.activity-indicator") == true
      && activityIndicator?.contains("deadline: .now() + 0.28") == true
      && statusLight?.contains("override var mouseDownCanMoveWindow: Bool { false }") == true
      && statusLight?.contains("options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect]") == true
      && statusLight?.contains("override func mouseEntered(with event: NSEvent)") == true
      && statusLight?.contains("override func mouseExited(with event: NSEvent)") == true
      && statusLight?.contains("return self") == true
      && statusLight?.contains(".repeatForever(autoreverses: true)") == false,
    "native session light stays static and GPU-backed so running state cannot drive the long transcript layout while AppKit hover still owns task details"
  )
  runNativeSessionLightBehaviorChecks()

  // 旧用户可见 UI literal：全文件禁止。
  for bannedVisibleCopy in [
    "搜索模块或 Loader 条目标识", "插件清单", "插件条目", "插件组装",
    "插件上下文", "没有可配置插件", "Text(\"插件\")",
    "Host Loader 当前没有报告非分组条目。", "当前 Host 没有公布",
  ] {
    check(
      !root.contains(bannedVisibleCopy),
      "native shell shows no legacy \(bannedVisibleCopy) runtime branding"
    )
  }

  // Cordis/Host Loader 等内部标识只在具体可见 block 内禁止。
  let inventory = sourceSlice(
    root,
    from: "private struct NativePluginInventoryCard: View",
    through: "private struct NativeSettingsNotice: View"
  )
  check(
    inventory?.contains("LabeledContent(\"Cordis\")") == false
      && inventory?.contains("LabeledContent(ArkL10n.text(.extensionCoreCapability, language))") == true
      && inventory?.contains("let language: ArkLanguagePreference") == true,
    "native extension inventory does not expose Cordis branding"
  )

  check(
    l10n.contains("扩展能力")
      && l10n.contains("扩展配置")
      && l10n.contains("扩展列表"),
    "native extension management uses neutral product naming in the L10n table"
  )
  let extensionSettings = sourceSlice(
    root,
    from: "private struct NativePluginSettings: View",
    through: "private struct NativeAgentPresetCard: View"
  )
  check(
    extensionSettings?.contains("ArkL10n.text(.extensionsTitle, model.languagePreference)") == true
      && extensionSettings?.contains("ArkL10n.text(.extensionsSubtitle, model.languagePreference)") == true
      && extensionSettings?.contains("ArkL10n.text(.extensionsRefresh, model.languagePreference)") == true
      && extensionSettings?.contains("ArkL10n.text(.extensionsSearchPlaceholder, model.languagePreference)") == true
      && extensionSettings?.contains("dirty ? .extensionUnsaved : .extensionOverridden") == true
      && extensionSettings?.contains("applies == .live ? .extensionAppliesLive : .extensionAppliesRestart") == true
      && extensionSettings?.contains("ArkL10n.text(.extensionRestoreDefault, language)") == true
      && extensionSettings?.contains("NativePluginInventoryCard(entry: entry, language: model.languagePreference)") == true
      && extensionSettings?.contains("Text(\"扩展能力\")") == false
      && extensionSettings?.contains("TextField(\"搜索扩展条目\"") == false
      && extensionSettings?.contains("Loader 条目标识") == false
      && l10n.contains("Configure and inspect the extensions installed in this deployment.")
      && l10n.contains("Default settings overridden")
      && l10n.contains("Extension Entry ID"),
    "native extension settings, editor states, inventory, and accessibility copy switch through ArkL10n"
  )

  check(
    root.contains(".wikiPagesCount")
      && root.contains("ArkL10n.text(.wikiGraphTitle, language)")
      && root.contains(".wikiGraphCounts")
      && root.contains("ArkL10n.text(.wikiLayoutType, language)")
      && root.contains("ArkL10n.text(.wikiLayoutCommunity, language)")
      && root.contains("ArkL10n.text(.wikiInspector, language)")
      && root.contains("ArkL10n.text(.wikiDeepResearch, language)")
      && root.contains("@Published private(set) var language: ArkLanguagePreference")
      && root.contains("model.$languagePreference.removeDuplicates()")
      && root.contains("language: feed.language")
      && root.contains("baseline = page.body")
      && root.contains("draft = page.body")
      && root.contains("Text(page.body)")
      && root.contains("content: draft")
      && ArkL10n.text(.wikiGraphTitle, .zh) == "知识图谱"
      && ArkL10n.text(.wikiGraphTitle, .en) == "Knowledge Graph",
    "native Wiki shell follows the single language preference while preserving knowledge content verbatim"
  )
  check(
    root.contains("ArkL10n.text(.wikiNewProject, feed.language)")
      && root.contains("ArkL10n.text(.wikiSearchPlaceholder, feed.language)")
      && root.contains("ArkL10n.text(.wikiImportHelp, feed.language)")
      && root.contains("ArkL10n.text(.wikiCreatePageTitle, feed.language)")
      && root.contains("ArkL10n.text(.wikiCreateProjectTitle, feed.language)")
      && root.contains("ArkL10n.text(.wikiReview, language)")
      && root.contains(".accessibilityLabel(ArkL10n.text(.wikiInspector, language))")
      && root.contains("ArkL10n.text(.wikiDetailEmpty, language)")
      && root.contains(".frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)")
      && root.contains("ArkL10n.text(.toolDetailEmpty, model.languagePreference)")
      && !root.contains("Button(\"+ 新建项目\"")
      && !root.contains("TextField(\"搜索知识库（关键词 + 向量混合检索）…\"")
      && !root.contains("Text(\"点击图谱节点或左侧文件查看页面详情\"")
      && l10n.contains("Search knowledge (keyword + vector hybrid)…")
      && l10n.contains("New Knowledge Project")
      && l10n.contains("Select a graph node or a page on the left to view its details"),
    "native Wiki creation, import, editing, review, and empty-detail chrome all follow the selected language"
  )

  let presetSettings = sourceSlice(
    root,
    from: "private struct NativeAgentPresetSettings: View",
    through: "private struct NativePluginSettings: View"
  )
  let presetCard = sourceSlice(
    root,
    from: "private struct NativeAgentPresetCard: View",
    through: "private struct NativeAgentPresetCopySheet: View"
  )
  let presetCopySheet = sourceSlice(
    root,
    from: "private struct NativeAgentPresetCopySheet: View",
    through: "private struct NativeAgentPresetDocumentSheet: View"
  )
  let presetDocumentSheet = sourceSlice(
    root,
    from: "private struct NativeAgentPresetDocumentSheet: View",
    through: "private struct NativePluginInventoryCard: View"
  )
  check(
    presetSettings?.contains("ArkL10n.text(.presetPageTitle, model.languagePreference)") == true
      && presetSettings?.contains("ArkL10n.text(.presetPageSubtitle, model.languagePreference)") == true
      && presetSettings?.contains("ArkL10n.text(.presetRefresh, model.languagePreference)") == true
      && presetSettings?.contains("ArkL10n.format(\n          .presetDeleteConfirm") == true
      && presetSettings?.contains("language: model.languagePreference") == true
      && presetCard?.contains("ArkL10n.presetDisplayTitle(id: preset.id, name: preset.name, language)") == true
      && presetCard?.contains("ArkL10n.presetDisplayDescription(") == true
      && presetCopySheet?.contains("ArkL10n.text(.presetCopyTitle, model.languagePreference)") == true
      && presetCopySheet?.contains("ArkL10n.text(.presetCopyIdentifierRule, model.languagePreference)") == true
      && presetDocumentSheet?.contains("ArkL10n.presetDisplayTitle(id: document.id, name: document.name, language)") == true
      && presetDocumentSheet?.contains("ArkL10n.presetDisplayDescription(") == true
      && !root.contains("刷新 Agent 预设")
      && !root.contains("复制 Agent 预设"),
    "native Agent Presets localize built-in metadata and every visible preset-management surface from stable IDs"
  )
  check(
    l10n.contains("case \"standard\": return text(.presetStandardName, language)")
      && l10n.contains("case \"code\": return text(.presetCodeName, language)")
      && l10n.contains("case \"minimal\": return text(.presetMinimalName, language)")
      && l10n.contains("case \"cordis\": return text(.presetCordisName, language)")
      && l10n.contains("default: return name ?? id")
      && l10n.contains("default: return description ?? \"\"")
      && l10n.contains("Standard mode")
      && l10n.contains("Creator mode")
      && l10n.contains("Copy Agent Preset")
      && l10n.contains("Delete custom preset “{0}”"),
    "built-in preset copy is localized by canonical ID while custom names and descriptions remain user-owned data"
  )

  let hero = sourceSlice(
    root,
    from: "private struct NativeHero: View",
    through: "private enum ChatLayoutMetrics"
  )
  check(
    hero?.contains("ArkL10n.text(.newConversationHeroTitle, model.languagePreference)") == true
      && hero?.contains(".frame(width: 80, height: 80)") == true
      && hero?.contains(".font(.system(size: 44, weight: .semibold))") == true
      && hero?.contains(".tracking(4)") == true
      && hero?.contains("NativeComposer(model: model, hero: true)") == true
      && hero?.contains("chooseWorkspaceDirectory") == true
      && hero?.contains("selectAgentPresetForCurrentSession") == true
      && hero?.contains("探索未至之境") == false
      && l10n.contains("所思即行  所创即见")
      && l10n.contains("Think It  Bring It to Life"),
    "native New Conversation hero uses the enlarged Ark mark and localized product prompt without replacing real composer state"
  )

  for source in [root, workbench, trajectory] {
    check(
      !source.contains("WKWebView"),
      "native shell introduces no WKWebView as an Ark product surface"
    )
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

private func runNativeSessionLightBehaviorChecks() {
  MainActor.assumeIsolated {
    let view = NativeSessionStatusLightLayerView(
      frame: NSRect(x: 0, y: 0, width: 24, height: 24)
    )
    var hoverChanges: [Bool] = []
    view.onHover = { hoverChanges.append($0) }
    view.updateTrackingAreas()
    view.update(.running, label: "Running")
    view.layoutSubtreeIfNeeded()

    let mouseEvent = NSEvent.mouseEvent(
      with: .mouseMoved,
      location: .zero,
      modifierFlags: [],
      timestamp: 0,
      windowNumber: 0,
      context: nil,
      eventNumber: 1,
      clickCount: 0,
      pressure: 0
    )
    if let mouseEvent {
      view.mouseEntered(with: mouseEvent)
      view.mouseExited(with: mouseEvent)
    }

    let ownedTrackingAreas = view.trackingAreas.filter {
      ($0.owner as AnyObject?) === view
    }
    let ownsTrackingArea = ownedTrackingAreas.count == 1
      && ownedTrackingAreas[0].options.contains(.mouseEnteredAndExited)
      && ownedTrackingAreas[0].options.contains(.activeAlways)
      && ownedTrackingAreas[0].options.contains(.inVisibleRect)
    let hasShapeLayer = view.layer?.sublayers?.contains { $0 is CAShapeLayer } == true
    let hasNoContinuousAnimation = view.layer?.sublayers?.allSatisfy {
      $0.animationKeys()?.isEmpty != false
    } == true
    check(
      view.wantsLayer && hasShapeLayer && hasNoContinuousAnimation,
      "AppKit session light renders through one static GPU-backed shape layer"
    )
    check(
      ownsTrackingArea,
      "AppKit session light owns exactly one active visible-rect hover tracking area"
    )
    check(
      hoverChanges == [true, false],
      "AppKit session light forwards entered and exited tracking events"
    )
    check(
      view.menu == nil && view.hitTest(NSPoint(x: 12, y: 12)) === view,
      "AppKit session light owns hover hit testing without a duplicate menu"
    )
    view.dismantle()
    check(
      view.layer?.sublayers?.allSatisfy { $0.animationKeys()?.isEmpty != false } == true
        && view.onHover == nil,
      "dismantling the static session light leaves no animation or hover callback"
    )
  }
}
