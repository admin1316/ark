import Foundation

/// 主导航命中区源码级契约：整块视觉区域必须是 hit target，
/// 不允许 text-only 点击。每个入口锁在自身局部 block 内断言
/// frame/contentShape，避免全文件 contains 的假阳性。
func runArkRootNavHitTargetContractChecks() {
  let rootURL = contractNativeRoot.appendingPathComponent(
    "Sources/JiuzhangShellUI/ArkRootView.swift"
  )
  guard let source = try? String(contentsOf: rootURL, encoding: .utf8) else {
    check(false, "native root view source is readable for hit-target checks")
    return
  }

  let hero = sourceSlice(
    source,
    from: "Button(action: model.beginNewConversation) {",
    through: ".help(ArkL10n.text(.newSession, model.languagePreference))"
  )
  check(
    hero?.contains(".frame(maxWidth: .infinity, minHeight: 38, alignment: .leading)") == true
      && hero?.contains(".contentShape(Rectangle())") == true,
    "native sidebar hero brand row carries a full-width hit frame and content shape"
  )

  let newConversation = sourceSlice(
    source,
    from: "Label(ArkL10n.text(.newConversation, model.languagePreference), systemImage: \"plus.message\")",
    through: ".buttonStyle(.plain)"
  )
  check(
    newConversation?.contains(".frame(maxWidth: .infinity)") == true
      && newConversation?.contains(".frame(height: 38)") == true
      && newConversation?.contains(".contentShape(Rectangle())") == true,
    "native new-conversation button keeps its full-width hit target"
  )

  let tabs = sourceSlice(
    source,
    from: "ForEach(ArkAppModel.Tab.allCases)",
    through: ".buttonStyle(.plain)"
  )
  check(
    tabs?.contains(".frame(width: 54, height: 58)") == true
      && tabs?.contains(".contentShape(Rectangle())") == true,
    "native chat trajectory and wiki tab rows keep fixed full-cell hit frames"
  )

  let workbench = sourceSlice(
    source,
    from: "NativeFirstMouseIconButton(",
    through: ".frame(width: 30, height: 30)"
  )
  check(
    workbench?.contains("systemName: \"sidebar.right\"") == true
      && workbench?.contains(".frame(width: 30, height: 30)") == true
      && workbench?.contains("accessibilityIdentifier: \"ark.global.workbench-toggle\"") == true
      && workbench?.contains("action: toggleWorkbenchPanel") == true,
    "native workbench header toggle is one first-mouse AppKit icon target"
  )

  let workspace = sourceSlice(
    source,
    from: "private struct WorkspaceSection",
    through: "private struct NativeSessionHeader"
  )
  check(
    workspace?.contains("withAnimation(.easeInOut(duration: 0.15)) { expanded.toggle() }") == true
      && workspace?.contains("model.selectWorkspace(workspace.id)") == true
      && workspace?.contains(".accessibilityIdentifier(\"ark.workspace.open.\\(workspace.id)\")") == true
      && workspace?.contains(".frame(maxWidth: .infinity, minHeight: 34, alignment: .leading)") == true
      && workspace?.contains(".contentShape(Rectangle())") == true,
    "native workspace disclosure is separate while the full title row opens its workspace on one click"
  )
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
