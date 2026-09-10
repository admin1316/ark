import Foundation

func runArkNativeThemeContractChecks() {
  let rootURL = contractNativeRoot.appendingPathComponent(
    "Sources/JiuzhangShellUI/ArkRootView.swift"
  )
  let workbenchURL = contractNativeRoot.appendingPathComponent(
    "Sources/JiuzhangShellUI/NativeWorkbenchView.swift"
  )
  let trajectoryURL = contractNativeRoot.appendingPathComponent(
    "Sources/JiuzhangShellUI/NativeTrajectoryParityView.swift"
  )
  guard
    let root = try? String(contentsOf: rootURL, encoding: .utf8),
    let workbench = try? String(contentsOf: workbenchURL, encoding: .utf8),
    let trajectory = try? String(contentsOf: trajectoryURL, encoding: .utf8)
  else {
    check(false, "native theme sources are readable")
    return
  }

  check(
    workbench.contains("static let raised = Color.primary.opacity(0.06)")
      && workbench.contains("static let selected = Color.accentColor.opacity(0.16)")
      && !workbench.contains("underPageBackgroundColor"),
    "native Workbench chrome uses semantic interaction states in light and dark mode"
  )
  check(
    trajectory.contains("static let raised = Color.primary.opacity(0.06)")
      && trajectory.contains("static let selection = Color.accentColor.opacity(0.18)")
      && !trajectory.contains("underPageBackgroundColor"),
    "native Trajectory toolbar uses the same semantic raised and selected states"
  )

  let settings = nativeThemeSlice(
    root,
    from: "private struct NativeSettingsView",
    through: "private struct NativeGeneralSettings"
  )
  check(
    settings?.contains(".background(ArkPalette.sidebar)") == true
      && settings?.contains(".background(ArkPalette.panel)") == true
      && settings?.contains("cornerRadius: 16") == true,
    "native Settings keeps distinct semantic sidebar and detail surfaces"
  )
  let overlay = nativeThemeSlice(
    root,
    from: "if showSettings {",
    through: "NativeSettingsView("
  )
  check(
    overlay?.contains("colorScheme == .dark ? 0.32 : 0.12") == true
      && overlay?.contains("ultraThinMaterial") == false,
    "native Settings scrim remains restrained and never material-tints the whole application"
  )
}

private func nativeThemeSlice(
  _ source: String,
  from start: String,
  through end: String
) -> String? {
  guard
    let startRange = source.range(of: start),
    let endRange = source.range(
      of: end,
      range: startRange.upperBound..<source.endIndex
    )
  else { return nil }
  return String(source[startRange.lowerBound..<endRange.upperBound])
}
