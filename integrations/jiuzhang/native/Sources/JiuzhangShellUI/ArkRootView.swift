import AppKit
import Combine
import JiuzhangShellCore
import QuartzCore
import SwiftUI
import UniformTypeIdentifiers

struct ArkOpenToolFileActionKey: EnvironmentKey {
  static let defaultValue: (String) -> Void = { _ in }
}

extension EnvironmentValues {
  var arkOpenToolFile: (String) -> Void {
    get { self[ArkOpenToolFileActionKey.self] }
    set { self[ArkOpenToolFileActionKey.self] = newValue }
  }
}

private func arkSessionDisplayTitle(
  _ title: String,
  language: ArkLanguagePreference
) -> String {
  // Host-generated titles are length-limited and may cut the envelope marker
  // before its version suffix. The stable namespace prefix is sufficient for
  // display cleanup while leaving ordinary titles untouched.
  let marker = "[[ARK_DOCUMENT_"
  let visible = title.range(of: marker).map { String(title[..<$0.lowerBound]) } ?? title
  let trimmed = visible.trimmingCharacters(in: .whitespacesAndNewlines)
  return trimmed.isEmpty ? ArkL10n.text(.composerPastedText, language) : trimmed
}

enum ArkPalette {
  static let shell = dynamic(
    "shell",
    light: NSColor(srgbRed: 1, green: 1, blue: 1, alpha: 1),
    dark: NSColor(srgbRed: 21 / 255, green: 21 / 255, blue: 23 / 255, alpha: 1)
  )
  static let panel = dynamic(
    "panel",
    light: NSColor(srgbRed: 1, green: 1, blue: 1, alpha: 1),
    dark: NSColor(srgbRed: 44 / 255, green: 44 / 255, blue: 46 / 255, alpha: 1)
  )
  static let sidebar = dynamic(
    "sidebar",
    light: NSColor(srgbRed: 249 / 255, green: 250 / 255, blue: 251 / 255, alpha: 1),
    dark: NSColor(srgbRed: 27 / 255, green: 27 / 255, blue: 28 / 255, alpha: 1)
  )
  static let raised = dynamic(
    "raised",
    light: NSColor(srgbRed: 241 / 255, green: 243 / 255, blue: 245 / 255, alpha: 1),
    dark: NSColor(srgbRed: 67 / 255, green: 69 / 255, blue: 74 / 255, alpha: 1)
  )
  static let bubble = dynamic(
    "bubble",
    light: NSColor(srgbRed: 237 / 255, green: 243 / 255, blue: 254 / 255, alpha: 1),
    dark: NSColor(srgbRed: 44 / 255, green: 44 / 255, blue: 46 / 255, alpha: 1)
  )
  static let border = dynamic(
    "border",
    light: NSColor(white: 0, alpha: 0.10),
    dark: NSColor(white: 1, alpha: 0.12)
  )
  static let primary = dynamic(
    "primary",
    light: NSColor(srgbRed: 15 / 255, green: 17 / 255, blue: 21 / 255, alpha: 1),
    dark: NSColor(srgbRed: 249 / 255, green: 250 / 255, blue: 251 / 255, alpha: 1)
  )
  static let secondary = dynamic(
    "secondary",
    light: NSColor(srgbRed: 97 / 255, green: 102 / 255, blue: 107 / 255, alpha: 1),
    dark: NSColor(srgbRed: 207 / 255, green: 211 / 255, blue: 214 / 255, alpha: 1)
  )
  static let accent = dynamic(
    "accent",
    light: NSColor(srgbRed: 65 / 255, green: 118 / 255, blue: 230 / 255, alpha: 1),
    dark: NSColor(srgbRed: 103 / 255, green: 158 / 255, blue: 254 / 255, alpha: 1)
  )

  private static func dynamic(
    _ name: String,
    light: NSColor,
    dark: NSColor
  ) -> Color {
    Color(nsColor: NSColor(name: NSColor.Name("Ark.Legacy.\(name)")) { appearance in
      appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light
    })
  }
}

private enum ArkAppearancePreference: String, CaseIterable, Identifiable {
  case light
  case dark
  case system

  var id: String { rawValue }
  var colorScheme: ColorScheme? {
    switch self {
    case .light: return .light
    case .dark: return .dark
    case .system: return nil
    }
  }
}

/// 顶部导航 Tab 的展示名：rawValue 保持内部稳定 ID（含持久化），展示走 ArkL10n。
extension ArkAppModel.Tab {
  func displayName(_ language: ArkLanguagePreference) -> String {
    switch self {
    case .chat: return ArkL10n.text(.navChat, language)
    case .trajectory: return ArkL10n.text(.navTrajectory, language)
    case .wiki: return ArkL10n.text(.navWiki, language)
    }
  }
}

private func arkRelativeTimestamp(
  _ date: Date,
  language: ArkLanguagePreference
) -> String {
  let seconds = max(0, Date().timeIntervalSince(date))
  if seconds < 60 { return ArkL10n.text(.relativeNow, language) }
  let key: ArkL10n.Key
  let value: Int
  if seconds < 3_600 {
    key = .relativeMinutes
    value = Int(seconds / 60)
  } else if seconds < 86_400 {
    key = .relativeHours
    value = Int(seconds / 3_600)
  } else if seconds < 604_800 {
    key = .relativeDays
    value = Int(seconds / 86_400)
  } else if seconds < 2_592_000 {
    key = .relativeWeeks
    value = Int(seconds / 604_800)
  } else {
    key = .relativeMonths
    value = Int(seconds / 2_592_000)
  }
  return ArkL10n.format(key, language, arguments: ["\(value)"])
}

/// Root native macOS interface for Ark.app.
public struct ArkRootView: View {
  @ObservedObject private var model: ArkAppModel
  private let workbenchDraftFlushCoordinator: NativeWorkbenchDraftFlushCoordinator
  @State private var showSettings = false
  /// 背景点击 dismiss 需在面板完整呈现后才武装，避免打开 Settings 的同一次
  /// 点击序列（mouseUp 落在新出现的 overlay 上）立即把它关掉。
  @State private var settingsDismissArmed = false
  @State private var showWorkbench = false
  @State private var workbenchShowsLauncher = true
  @State private var workbenchInitialTool: NativeWorkbenchTabKind = .files
  @State private var workbenchToolRequestRevision = 0
  @State private var workbenchBrowserCancellationRevision = 0
  @State private var workbenchPanelWidth: CGFloat = 760
  @State private var workbenchDragOrigin: CGFloat?
  /// 工作台打开时冻结的根：打开期间不随 workspace/session 切换重建视图，
  /// 避免带 dirty Tabs 的编辑表面被静默销毁。关闭后重新打开才采用新根。
  @State private var workbenchActiveRoot: URL?
  @State private var workbenchActiveRootTitle: String?
  @State private var workbenchHasDirtyFiles = false
  @State private var pendingWorkbenchRoot: WorkbenchRootSelection?
  @State private var toolFileNavigationError: String?
  @AppStorage("ark.sidebar.collapsed") private var sidebarCollapsed = false
  @AppStorage("ark.sidebar.width") private var sidebarWidth = 280.0
  @State private var sidebarDragOrigin: Double?
  @AppStorage("ark.appearance.preference") private var appearanceRaw = ArkAppearancePreference.system.rawValue
  @State private var imageDropTargeted = false
  @Environment(\.colorScheme) private var colorScheme

  private let chatMainAreaMinimumWidth: CGFloat = 520
  private let analysisMainAreaMinimumWidth: CGFloat = 840
  private let workbenchPanelMinimumWidth: CGFloat = 520
  private let workbenchDividerWidth: CGFloat = 8

  private var mainAreaMinimumWidth: CGFloat {
    switch model.selectedTab {
    case .chat: chatMainAreaMinimumWidth
    case .trajectory, .wiki: analysisMainAreaMinimumWidth
    }
  }

  public init(
    model: ArkAppModel,
    workbenchDraftFlushCoordinator: NativeWorkbenchDraftFlushCoordinator
  ) {
    self.model = model
    self.workbenchDraftFlushCoordinator = workbenchDraftFlushCoordinator
  }

  public var body: some View {
    HStack(spacing: 0) {
      NativeSidebar(
        model: model,
        showSettings: $showSettings,
        collapsed: sidebarCollapsed,
        toggleCollapse: { sidebarCollapsed.toggle() }
      )
      .frame(width: sidebarCollapsed ? 56 : sidebarWidth)
      .frame(maxHeight: .infinity)

      ZStack {
        Rectangle().fill(ArkPalette.border).frame(width: 1)
        if !sidebarCollapsed {
          Color.clear
              .contentShape(Rectangle())
              .frame(width: 8)
              .gesture(
                DragGesture(minimumDistance: 0)
                  .onChanged { value in
                    if sidebarDragOrigin == nil { sidebarDragOrigin = sidebarWidth }
                    let origin = sidebarDragOrigin ?? sidebarWidth
                    sidebarWidth = min(420, max(264, origin + value.translation.width))
                  }
                  .onEnded { _ in sidebarDragOrigin = nil }
              )
              .onHover { hovering in
                if hovering { NSCursor.resizeLeftRight.push() }
                else { NSCursor.pop() }
              }
        }
      }
      .frame(width: sidebarCollapsed ? 1 : 8)
      ArkRootSplitLayout(
        showsWorkbench: showWorkbench,
        mainMinimumWidth: mainAreaMinimumWidth,
        workbenchMinimumWidth: workbenchPanelMinimumWidth,
        requestedWorkbenchWidth: workbenchPanelWidth,
        dividerWidth: workbenchDividerWidth
      ) {
        NativeMainArea(model: model)
          .environment(\.arkOpenToolFile, openToolFile)
          .clipped()
          .alert(
            ArkL10n.text(.workbenchOpenFile, model.languagePreference),
            isPresented: Binding(
              get: { toolFileNavigationError != nil },
              set: { if !$0 { toolFileNavigationError = nil } }
            )
          ) {
            Button(ArkL10n.text(.commonCancel, model.languagePreference), role: .cancel) {
              toolFileNavigationError = nil
            }
          } message: {
            Text(toolFileNavigationError ?? "")
          }

        ZStack {
          Rectangle()
            .fill(ArkPalette.border)
            .frame(width: 1)
          RoundedRectangle(cornerRadius: 1.5)
            .fill(ArkPalette.secondary.opacity(0.55))
            .frame(width: 3, height: 42)
          Color.clear
            .contentShape(Rectangle())
            .gesture(
              DragGesture(minimumDistance: 0)
                .onChanged { value in
                  if workbenchDragOrigin == nil {
                    workbenchDragOrigin = workbenchPanelWidth
                  }
                  let origin = workbenchDragOrigin ?? workbenchPanelWidth
                  workbenchPanelWidth = min(
                    1_200,
                    max(workbenchPanelMinimumWidth, origin - value.translation.width)
                  )
                }
                .onEnded { _ in workbenchDragOrigin = nil }
            )
            .onHover { hovering in
              if hovering { NSCursor.resizeLeftRight.push() }
              else { NSCursor.pop() }
            }
        }
        .opacity(showWorkbench ? 1 : 0)
        .allowsHitTesting(showWorkbench)
        .help(ArkL10n.text(.workbenchResizePanel, model.languagePreference))
        .accessibilityIdentifier("ark.workbench.divider")

        Group {
          if workbenchShowsLauncher {
            NativeConversationWorkbenchLauncher(
              language: model.languagePreference,
              select: openWorkbenchTool
            )
          } else {
            workbenchSurface
          }
        }
        .opacity(showWorkbench ? 1 : 0)
        .allowsHitTesting(showWorkbench)
        .accessibilityHidden(!showWorkbench)
        .clipped()
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .overlay(alignment: .topTrailing) {
      if !showSettings {
        HStack(spacing: 6) {
          if hasActiveConversation {
            NativeSessionActionsMenu(model: model)
          }
          NativeFirstMouseIconButton(
            systemName: "sidebar.right",
            help: ArkL10n.text(
              showWorkbench ? .workbenchCollapse : .workbenchOpen,
              model.languagePreference
            ),
            accessibilityIdentifier: "ark.global.workbench-toggle",
            action: toggleWorkbenchPanel
          )
          .frame(width: 30, height: 30)
        }
        .padding(10)
      }
    }
    .onDrop(
      of: [UTType.fileURL.identifier],
      isTargeted: $imageDropTargeted,
      perform: acceptImageDrop
    )
    .allowsHitTesting(!showSettings)
    .accessibilityHidden(showSettings)
    .background(ArkPalette.shell)
    .foregroundStyle(ArkPalette.primary)
    .preferredColorScheme(appearance.colorScheme)
    .environment(\.locale, Locale(identifier: language.localeIdentifier))
    .onReceive(NotificationCenter.default.publisher(for: .arkShowSettings)) { _ in
      showSettings = true
    }
    .onReceive(NotificationCenter.default.publisher(for: .arkBeginNewConversation)) { _ in
      model.beginNewConversation()
    }
    .onReceive(NativeWorkbenchCommandCenter.shared.openTool) { kind in
      openWorkbenchTool(kind)
    }
    .animation(.easeInOut(duration: 0.24), value: sidebarCollapsed)
    .overlay {
      if showSettings {
        GeometryReader { proxy in
          ZStack {
            Rectangle()
              .fill(Color.black.opacity(colorScheme == .dark ? 0.32 : 0.12))
              .ignoresSafeArea()
              .contentShape(Rectangle())
              .onTapGesture {
                if settingsDismissArmed { showSettings = false }
              }

            NativeSettingsView(
              model: model,
              appearance: Binding(
                get: { appearance },
                set: {
                  appearanceRaw = $0.rawValue
                  model.setAppearancePreference($0.rawValue)
                }
              ),
              language: Binding(
                get: { model.languagePreference },
                set: { model.setLanguagePreference($0.rawValue) }
              ),
              onClose: { showSettings = false }
            )
              .environment(\.locale, Locale(identifier: language.localeIdentifier))
              .frame(
                width: min(800, max(640, proxy.size.width - 48)),
                height: min(800, max(600, proxy.size.height - 48))
              )
          }
        }
        .transition(.opacity)
        .zIndex(1_000)
        .onAppear {
          // 面板呈现后的下一个 runloop 才武装背景 dismiss；
          // 打开点击的 mouseUp 不会命中武装后的 tap。
          DispatchQueue.main.async { settingsDismissArmed = true }
        }
        .onDisappear { settingsDismissArmed = false }
      }
    }
    .animation(.easeOut(duration: 0.12), value: showSettings)
    .overlay {
      if imageDropTargeted {
        ZStack {
          RoundedRectangle(cornerRadius: 18)
            .fill(ArkPalette.shell.opacity(0.92))
            .overlay(
              RoundedRectangle(cornerRadius: 18)
                .stroke(ArkPalette.accent, style: StrokeStyle(lineWidth: 2, dash: [8, 6]))
            )
          Label(ArkL10n.text(.dropImagesHere, model.languagePreference), systemImage: "photo.on.rectangle.angled")
            .font(.system(size: 18, weight: .semibold))
            .foregroundStyle(ArkPalette.primary)
        }
        .padding(18)
        .allowsHitTesting(false)
        .zIndex(900)
      }
    }
    .onReceive(model.$settingsSnapshot) { snapshot in
      guard let raw = snapshot?.namespaces
        .first(where: { $0.id == "ui-theme" })?
        .value["preference"]?.stringValue,
        ArkAppearancePreference(rawValue: raw) != nil
      else { return }
      appearanceRaw = raw
    }
    .onAppear { applyApplicationAppearance() }
    .onChange(of: appearanceRaw) { _ in applyApplicationAppearance() }
    .onChange(of: model.selectedWorkspaceID) { _ in
      synchronizeWorkbenchRootWithSelection()
    }
    .onChange(of: model.selectedSessionID) { _ in
      synchronizeWorkbenchRootWithSelection()
    }
    .alert(
      ArkL10n.text(.workbenchSwitchWorkspaceTitle, model.languagePreference),
      isPresented: Binding(
        get: { pendingWorkbenchRoot != nil },
        set: { if !$0 { pendingWorkbenchRoot = nil } }
      )
    ) {
      Button(ArkL10n.text(.commonCancel, model.languagePreference), role: .cancel) {
        pendingWorkbenchRoot = nil
      }
      Button(ArkL10n.text(.workbenchDiscardAndSwitch, model.languagePreference), role: .destructive) {
        if let pendingWorkbenchRoot {
          adoptWorkbenchRoot(pendingWorkbenchRoot)
        }
        pendingWorkbenchRoot = nil
      }
    } message: {
      Text(ArkL10n.format(
        .workbenchSwitchWorkspaceDetail,
        model.languagePreference,
        arguments: [
          workbenchActiveRoot?.path ?? "—",
          pendingWorkbenchRoot?.url.path ?? "—",
        ]
      ))
    }
  }

  @ViewBuilder
  private var workbenchSurface: some View {
    if let rootURL = workbenchActiveRoot ?? workbenchRoot?.url {
      NativeWorkbenchView(
        appModel: model,
        rootURL: rootURL,
        language: model.languagePreference,
        draftFlushCoordinator: workbenchDraftFlushCoordinator,
        initialTool: workbenchInitialTool,
        requestedTool: workbenchInitialTool,
        requestedToolRevision: workbenchToolRequestRevision,
        browserCancellationRevision: workbenchBrowserCancellationRevision
      )
        .onDirtyStateChange { workbenchHasDirtyFiles = $0 }
        .onClose {
          hideWorkbenchPanel()
        }
        .id(rootURL.path)
        .frame(minWidth: 360, idealWidth: 560, maxWidth: .infinity)
    } else {
      NativeWorkbenchRootChooser(
        language: model.languagePreference,
        choose: chooseWorkbenchRoot
      )
        .frame(minWidth: 360, idealWidth: 560, maxWidth: .infinity)
    }
  }

  private func toggleWorkbenchPanel() {
    if !showWorkbench, model.selectedSessionID == nil {
      workbenchShowsLauncher = true
    }
    if !showWorkbench, let selection = workbenchRoot {
      requestWorkbenchRoot(selection)
    }
    if showWorkbench { workbenchBrowserCancellationRevision &+= 1 }
    showWorkbench.toggle()
  }

  private func openWorkbenchTool(_ kind: NativeWorkbenchTabKind) {
    if let selection = workbenchRoot {
      requestWorkbenchRoot(selection)
    }
    workbenchInitialTool = kind
    workbenchToolRequestRevision &+= 1
    workbenchShowsLauncher = false
    showWorkbench = true
  }

  private func hideWorkbenchPanel() {
    workbenchBrowserCancellationRevision &+= 1
    showWorkbench = false
  }

  private func synchronizeWorkbenchRootWithSelection() {
    guard let selection = workbenchRoot else { return }
    requestWorkbenchRoot(selection)
  }

  private func requestWorkbenchRoot(_ selection: WorkbenchRootSelection) {
    let next = selection.url.standardizedFileURL
    switch ArkWorkbenchRootRequestPolicy.decide(
      activeRootPath: workbenchActiveRoot?.standardizedFileURL.path,
      requestedRootPath: next.path,
      hasDirtyFiles: workbenchHasDirtyFiles,
      showsLauncher: workbenchShowsLauncher
    ) {
    case .unchanged:
      return
    case .deferSwitch:
      pendingWorkbenchRoot = WorkbenchRootSelection(url: next, title: selection.title)
    case .adopt:
      adoptWorkbenchRoot(WorkbenchRootSelection(url: next, title: selection.title))
    }
  }

  private func adoptWorkbenchRoot(_ selection: WorkbenchRootSelection) {
    workbenchHasDirtyFiles = false
    workbenchActiveRoot = selection.url.standardizedFileURL
    workbenchActiveRootTitle = selection.title
  }

  private var hasActiveConversation: Bool {
    model.selectedSessionID != nil && model.selectedSession?.blank != true
  }

  private var workbenchRoot: WorkbenchRootSelection? {
    if let workspace = model.selectedWorkspace,
       JiuzhangShellContract.protectedWorkspaceReason(path: workspace.path) == nil {
      return WorkbenchRootSelection(
        url: URL(fileURLWithPath: workspace.path, isDirectory: true),
        title: workspace.title
      )
    }
    if let path = model.selectedSession?.cwd,
       JiuzhangShellContract.protectedWorkspaceReason(path: path) == nil {
      let url = URL(fileURLWithPath: path, isDirectory: true)
      return WorkbenchRootSelection(
        url: url,
        title: url.lastPathComponent.isEmpty ? url.path : url.lastPathComponent
      )
    }
    return nil
  }

  private var toolFileWorkbenchRoot: WorkbenchRootSelection? {
    if let path = model.selectedSession?.cwd,
       JiuzhangShellContract.protectedWorkspaceReason(path: path) == nil {
      let url = URL(fileURLWithPath: path, isDirectory: true)
      return WorkbenchRootSelection(
        url: url,
        title: url.lastPathComponent.isEmpty ? url.path : url.lastPathComponent
      )
    }
    return workbenchRoot
  }

  private func openToolFile(_ rawPath: String) {
    guard let selection = toolFileWorkbenchRoot else {
      toolFileNavigationError = "当前会话没有可用的工作区"
      return
    }
    do {
      let access = try NativeWorkspaceAccess(rootURL: selection.url)
      let trimmed = rawPath.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !trimmed.isEmpty else { throw NativeWorkbenchError.notRegularFile }
      let candidate = trimmed.hasPrefix("/")
        ? URL(fileURLWithPath: trimmed)
        : access.rootURL.appendingPathComponent(trimmed)
      let fileURL = try access.validatedRegularFileURL(candidate)
      let activeRoot = workbenchActiveRoot?
        .standardizedFileURL.resolvingSymlinksInPath()
      let switchingRoot = activeRoot?.path != access.rootURL.path
      if switchingRoot, workbenchHasDirtyFiles, !workbenchShowsLauncher {
        toolFileNavigationError = "工作台有未保存文件；请先保存或关闭后再切换工作区"
        return
      }
      toolFileNavigationError = nil
      if switchingRoot {
        workbenchInitialTool = .files
        adoptWorkbenchRoot(WorkbenchRootSelection(url: access.rootURL, title: selection.title))
      }
      if workbenchShowsLauncher { workbenchInitialTool = .files }
      workbenchShowsLauncher = false
      showWorkbench = true
      model.requestWorkbenchFileOpen(rootURL: access.rootURL, fileURL: fileURL)
    } catch {
      toolFileNavigationError = error.localizedDescription
    }
  }

  private func chooseWorkbenchRoot() {
    let panel = NSOpenPanel()
    panel.canChooseFiles = false
    panel.canChooseDirectories = true
    panel.allowsMultipleSelection = false
    panel.prompt = ArkL10n.text(.workbenchChooseRoot, model.languagePreference)
    guard panel.runModal() == .OK, let url = panel.url else { return }
    let root = url.standardizedFileURL
    adoptWorkbenchRoot(WorkbenchRootSelection(
      url: root,
      title: root.lastPathComponent.isEmpty ? root.path : root.lastPathComponent
    ))
    model.addWorkspace(path: root.path)
  }

  private var appearance: ArkAppearancePreference {
    ArkAppearancePreference(rawValue: appearanceRaw) ?? .dark
  }

  private var language: ArkLanguagePreference {
    model.languagePreference
  }

  private func applyApplicationAppearance() {
    switch appearance {
    case .light:
      NSApp.appearance = NSAppearance(named: .aqua)
    case .dark:
      NSApp.appearance = NSAppearance(named: .darkAqua)
    case .system:
      NSApp.appearance = nil
    }
  }

  private func acceptImageDrop(_ providers: [NSItemProvider]) -> Bool {
    let candidates = providers.enumerated().filter {
      $0.element.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier)
    }
    guard !candidates.isEmpty else { return false }
    let group = DispatchGroup()
    let lock = NSLock()
    var loaded: [(Int, URL)] = []
    for (index, provider) in candidates {
      group.enter()
      provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) { item, _ in
        defer { group.leave() }
        let url: URL?
        if let value = item as? URL { url = value }
        else if let value = item as? NSURL { url = value as URL }
        else if let data = item as? Data { url = URL(dataRepresentation: data, relativeTo: nil) }
        else if let value = item as? String { url = URL(fileURLWithPath: value) }
        else { url = nil }
        guard let url else { return }
        lock.lock()
        loaded.append((index, url))
        lock.unlock()
      }
    }
    group.notify(queue: .main) {
      model.addImageURLs(loaded.sorted { $0.0 < $1.0 }.map(\.1))
    }
    return true
  }
}

/// AppKit-owned drag target behind the SwiftUI tree. It is reached only when
/// no foreground control or gesture wins hit testing. Calling `performDrag`
/// here is required because `mouseDownCanMoveWindow` alone is not propagated
/// through every NSHostingView/NSViewRepresentable nesting level.
struct WindowDragSurface: NSViewRepresentable {
  func makeNSView(context: Context) -> WindowDragSurfaceView {
    WindowDragSurfaceView()
  }

  func updateNSView(_ nsView: WindowDragSurfaceView, context: Context) {}
}

/// AppKit-owned icon button for edge controls that must act on the same click
/// that activates an inactive Ark window. SwiftUI's private button host does
/// not consistently forward `acceptsFirstMouse`, so the native button owns the
/// complete mouse-down/up sequence and never participates in window dragging.
struct NativeFirstMouseIconButton: NSViewRepresentable {
  let systemName: String
  let help: String
  let accessibilityIdentifier: String
  let action: () -> Void

  func makeCoordinator() -> Coordinator {
    Coordinator(action: action)
  }

  func makeNSView(context: Context) -> NativeFirstMouseNSButton {
    let button = NativeFirstMouseNSButton()
    button.isBordered = false
    button.imagePosition = .imageOnly
    button.imageScaling = .scaleProportionallyDown
    button.focusRingType = .none
    button.refusesFirstResponder = true
    button.setButtonType(.momentaryChange)
    button.target = context.coordinator
    button.action = #selector(Coordinator.performAction)
    update(button, coordinator: context.coordinator)
    return button
  }

  func updateNSView(_ button: NativeFirstMouseNSButton, context: Context) {
    update(button, coordinator: context.coordinator)
  }

  private func update(_ button: NativeFirstMouseNSButton, coordinator: Coordinator) {
    coordinator.action = action
    button.image = NSImage(systemSymbolName: systemName, accessibilityDescription: help)
    button.toolTip = help
    button.setAccessibilityLabel(help)
    button.setAccessibilityIdentifier(accessibilityIdentifier)
  }

  final class Coordinator: NSObject {
    var action: () -> Void

    init(action: @escaping () -> Void) {
      self.action = action
    }

    @objc func performAction() {
      action()
    }
  }
}

final class NativeFirstMouseNSButton: NSButton {
  override var mouseDownCanMoveWindow: Bool { false }
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

final class WindowDragSurfaceView: NSView {
  override var mouseDownCanMoveWindow: Bool { true }

  override func hitTest(_ point: NSPoint) -> NSView? {
    guard !isHidden, alphaValue > 0, bounds.contains(point) else { return nil }
    return self
  }

  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

  override func mouseDown(with event: NSEvent) {
    guard event.type == .leftMouseDown, let window else {
      super.mouseDown(with: event)
      return
    }
    window.performDrag(with: event)
  }
}

private struct WorkbenchRootSelection {
  let url: URL
  let title: String
}

enum ArkWorkbenchRootRequestDecision: Equatable {
  case unchanged
  case adopt
  case deferSwitch
}

enum ArkWorkbenchRootRequestPolicy {
  static func decide(
    activeRootPath: String?,
    requestedRootPath: String,
    hasDirtyFiles: Bool,
    showsLauncher: Bool
  ) -> ArkWorkbenchRootRequestDecision {
    if activeRootPath == requestedRootPath { return .unchanged }
    if hasDirtyFiles, !showsLauncher { return .deferSwitch }
    return .adopt
  }
}

/// Deterministic three-column root layout. A root `GeometryReader` used to
/// feed its measured width back into child frames, which could keep
/// GeometryReader/FlexFrame/StackLayout negotiating after a large transcript
/// reflow. Layout receives the parent proposal directly and resolves the same
/// main/divider/workbench widths in one pass.
private struct ArkRootSplitLayout: Layout {
  let showsWorkbench: Bool
  let mainMinimumWidth: CGFloat
  let workbenchMinimumWidth: CGFloat
  let requestedWorkbenchWidth: CGFloat
  let dividerWidth: CGFloat

  func sizeThatFits(
    proposal: ProposedViewSize,
    subviews: Subviews,
    cache: inout ()
  ) -> CGSize {
    CGSize(
      width: proposal.width ?? mainMinimumWidth,
      height: proposal.height ?? 0
    )
  }

  /// The default `Layout.explicitAlignment` implementation derives an answer
  /// by calling `placeSubviews`. At the root split that re-enters measurement
  /// of the whole chat document, including the transcript `LazyVStack`, for an
  /// alignment value none of the three columns exports. Returning no explicit
  /// guide keeps the parent's ordinary alignment fallback and prevents an
  /// idle transcript from becoming an alignment -> placement -> lazy-layout
  /// feedback loop.
  func explicitAlignment(
    of guide: HorizontalAlignment,
    in bounds: CGRect,
    proposal: ProposedViewSize,
    subviews: Subviews,
    cache: inout ()
  ) -> CGFloat? {
    nil
  }

  func explicitAlignment(
    of guide: VerticalAlignment,
    in bounds: CGRect,
    proposal: ProposedViewSize,
    subviews: Subviews,
    cache: inout ()
  ) -> CGFloat? {
    nil
  }

  func placeSubviews(
    in bounds: CGRect,
    proposal: ProposedViewSize,
    subviews: Subviews,
    cache: inout ()
  ) {
    guard subviews.count == 3 else { return }
    let maximumWorkbenchWidth = max(
      0,
      bounds.width - mainMinimumWidth - dividerWidth
    )
    let minimumWorkbenchWidth = min(workbenchMinimumWidth, maximumWorkbenchWidth)
    let workbenchWidth = showsWorkbench
      ? min(maximumWorkbenchWidth, max(minimumWorkbenchWidth, requestedWorkbenchWidth))
      : 0
    let visibleDividerWidth = showsWorkbench ? dividerWidth : 0
    let mainWidth = max(bounds.width - visibleDividerWidth - workbenchWidth, 0)

    subviews[0].place(
      at: CGPoint(x: bounds.minX, y: bounds.minY),
      anchor: .topLeading,
      proposal: ProposedViewSize(width: mainWidth, height: bounds.height)
    )
    subviews[1].place(
      at: CGPoint(x: bounds.minX + mainWidth, y: bounds.minY),
      anchor: .topLeading,
      proposal: ProposedViewSize(width: visibleDividerWidth, height: bounds.height)
    )
    subviews[2].place(
      at: CGPoint(x: bounds.maxX - workbenchWidth, y: bounds.minY),
      anchor: .topLeading,
      proposal: ProposedViewSize(width: workbenchWidth, height: bounds.height)
    )
  }
}

private struct NativeSidebar: View {
  @ObservedObject var model: ArkAppModel
  @Binding var showSettings: Bool
  let collapsed: Bool
  let toggleCollapse: () -> Void
  @State private var searchVisible = false
  @State private var searchQuery = ""
  @State private var renameSessionID: String?
  @State private var renameSessionTitle = ""
  @State private var renameWorkspaceID: String?
  @State private var renameWorkspaceTitle = ""
  @State private var pendingRemoveWorkspaceID: String?
  @State private var showArchiveCenter = false
  @State private var groupSessionsByWorkspace = true
  @State private var sortSessionsByRecent = false
  @State private var hoveredFlatSessionID: String?
  @State private var ungroupedExpanded = true
  @State private var searchDebounceTask: Task<Void, Never>?
  @FocusState private var searchFocused: Bool

  var body: some View {
    VStack(spacing: 0) {
      if collapsed {
        collapsedControls
      } else {
        HStack(spacing: 9) {
          Button(action: model.beginNewConversation) {
            HStack(spacing: 9) {
              Text(ArkL10n.text(.brandTitle, model.languagePreference))
                .font(.system(size: 15, weight: .bold))
                .tracking(1.2)
              Text("ARK")
                .font(.system(size: 7, weight: .bold, design: .monospaced))
                .tracking(1)
                .padding(.top, 2)
            }
            .frame(maxWidth: .infinity, minHeight: 38, alignment: .leading)
            .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .help(ArkL10n.text(.newSession, model.languagePreference))
          Spacer()
          Button(action: toggleCollapse) {
            Image(systemName: "sidebar.left")
              .frame(width: 28, height: 28)
          }
          .buttonStyle(.plain)
          .foregroundStyle(ArkPalette.secondary)
          .help(ArkL10n.text(.collapseSidebar, model.languagePreference))
        }
        .frame(height: 60)
        .padding(.leading, 16)
        .padding(.trailing, 12)
        .padding(.bottom, 8)

        Button(action: model.beginNewConversation) {
          Label(ArkL10n.text(.newConversation, model.languagePreference), systemImage: "plus.message")
            .frame(maxWidth: .infinity)
            .frame(height: 38)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(ArkPalette.raised, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(ArkPalette.border))
        .padding(.horizontal, 14)
        .padding(.bottom, 8)

        HStack(spacing: 4) {
          if showArchiveCenter {
            Text(ArkL10n.text(.archiveTitle, model.languagePreference))
              .font(.system(size: 13, weight: .medium))
              .foregroundStyle(ArkPalette.secondary)
            Spacer()
            Button {
              showArchiveCenter = false
            } label: {
              HStack(spacing: 2) {
                Image(systemName: "archivebox.fill")
                Text("\(model.archivedSessionIDs.count)")
                  .font(.system(size: 10, design: .rounded))
              }
              .foregroundStyle(ArkPalette.accent)
              .frame(height: 28)
            }
            .buttonStyle(.plain)
            .help(ArkL10n.text(.backToWorkspace, model.languagePreference))
          } else if searchVisible {
            HStack(spacing: 4) {
              Button {
                if searchQuery.isEmpty {
                  searchVisible = false
                  model.clearSessionSearch()
                } else {
                  model.searchSessions(searchQuery)
                }
              } label: {
                Image(systemName: "magnifyingglass")
                  .frame(width: 28, height: 28)
              }
              .buttonStyle(.plain)
              TextField("搜索会话", text: $searchQuery)
                .textFieldStyle(.plain)
                .font(.system(size: 13))
                .focused($searchFocused)
                .onSubmit { model.searchSessions(searchQuery) }
                .onChange(of: searchQuery) { value in
                  searchDebounceTask?.cancel()
                  let query = value.trimmingCharacters(in: .whitespacesAndNewlines)
                  guard !query.isEmpty else {
                    model.clearSessionSearch()
                    return
                  }
                  searchDebounceTask = Task {
                    try? await Task.sleep(nanoseconds: 250_000_000)
                    guard !Task.isCancelled else { return }
                    model.searchSessions(query)
                  }
                }
              Button {
                searchQuery = ""
                model.clearSessionSearch()
                searchVisible = false
                searchFocused = false
              } label: {
                Image(systemName: "xmark.circle.fill")
                  .foregroundStyle(ArkPalette.secondary)
                  .frame(width: 24, height: 24)
              }
              .buttonStyle(.plain)
            }
            .padding(.horizontal, 2)
            .frame(height: 30)
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(ArkPalette.border))
          } else {
            Text(ArkL10n.text(.workspaceSection, model.languagePreference))
              .font(.system(size: 13, weight: .medium))
              .foregroundStyle(ArkPalette.secondary)
            Spacer()
            Button {
              searchVisible = true
              DispatchQueue.main.async { searchFocused = true }
            } label: {
              Image(systemName: "magnifyingglass")
                .frame(width: 28, height: 28)
            }
            .buttonStyle(.plain)
            Button {
              showArchiveCenter.toggle()
              searchVisible = false
              searchQuery = ""
              model.clearSessionSearch()
            } label: {
              HStack(spacing: 2) {
                Image(systemName: "archivebox")
                Text("\(model.archivedSessionIDs.count)")
                  .font(.system(size: 10, design: .rounded))
              }
              .frame(height: 28)
            }
            .buttonStyle(.plain)
            .help(ArkL10n.text(.archiveTitle, model.languagePreference))
            .accessibilityIdentifier("ark.archive.open")
            Menu {
              Section("分组") {
                Button {
                  groupSessionsByWorkspace = true
                } label: {
                  Label(ArkL10n.text(.groupByWorkspace, model.languagePreference), systemImage: groupSessionsByWorkspace ? "checkmark" : "circle")
                }
                Button {
                  groupSessionsByWorkspace = false
                } label: {
                  Label(ArkL10n.text(.flatSessions, model.languagePreference), systemImage: groupSessionsByWorkspace ? "circle" : "checkmark")
                }
              }
              Section("排序") {
              Button {
                sortSessionsByRecent = false
              } label: {
                Label(ArkL10n.text(.manualWorkspaceOrder, model.languagePreference), systemImage: sortSessionsByRecent ? "circle" : "checkmark")
              }
              Button {
                sortSessionsByRecent = true
              } label: {
                Label(ArkL10n.text(.recentFirst, model.languagePreference), systemImage: sortSessionsByRecent ? "checkmark" : "circle")
              }
              }
            } label: {
              Image(systemName: "slider.horizontal.3")
                .frame(width: 28, height: 28)
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .help(ArkL10n.text(.sessionSort, model.languagePreference))
            Button(action: chooseWorkspaceDirectory) {
              Image(systemName: "folder.badge.plus")
                .frame(width: 28, height: 28)
            }
            .buttonStyle(.plain)
            .help(ArkL10n.text(.addWorkspace, model.languagePreference))
          }
        }
        .font(.system(size: 14))
        .foregroundStyle(ArkPalette.secondary)
        .padding(.horizontal, 16)
        .frame(height: 36)
        .padding(.bottom, 4)
        if let error = model.navigationErrorMessage, !error.isEmpty {
          NativeSettingsNotice(text: error, color: .red, icon: "exclamationmark.triangle.fill")
            .accessibilityIdentifier("ark.sidebar.error")
            .padding(.horizontal, 12)
            .padding(.bottom, 6)
        }
        ScrollView {
          LazyVStack(spacing: 4) {
            if showArchiveCenter {
              NativeArchiveSidebarView(model: model)
            } else if model.sessionSearchDidRun || model.sessionSearchLoading {
            VStack(alignment: .leading, spacing: 4) {
              Text(ArkL10n.text(.searchResults, model.languagePreference))
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(ArkPalette.secondary)
                .padding(.horizontal, 8)
              if model.sessionSearchLoading {
                HStack(spacing: 7) {
                  ProgressView().controlSize(.small)
                  Text(ArkL10n.text(.searching, model.languagePreference))
                }
                .font(.system(size: 11))
                .foregroundStyle(ArkPalette.secondary)
                .padding(8)
              } else if model.sessionSearchHits.isEmpty {
                Text(ArkL10n.text(.noMatchingSessions, model.languagePreference))
                  .font(.system(size: 11))
                  .foregroundStyle(ArkPalette.secondary)
                  .padding(8)
              }
              ForEach(model.sessionSearchHits.filter { !model.sessionIsArchived($0.sessionID) }) { hit in
                Button {
                  model.selectSession(hit.sessionID)
                } label: {
                  VStack(alignment: .leading, spacing: 3) {
                    Text(sessionTitle(hit.sessionID))
                      .font(.system(size: 12, weight: .medium))
                      .lineLimit(1)
                    Text(hit.snippet)
                      .font(.system(size: 10))
                      .foregroundStyle(ArkPalette.secondary)
                      .lineLimit(2)
                  }
                  .frame(maxWidth: .infinity, alignment: .leading)
                  .padding(8)
                  .background(ArkPalette.raised, in: RoundedRectangle(cornerRadius: 7))
                }
                .buttonStyle(.plain)
              }
            }
            } else if groupSessionsByWorkspace {
              ForEach(model.workspaces) { workspace in
                WorkspaceSection(
                  model: model,
                  workspace: workspace,
                  sortByRecent: sortSessionsByRecent,
                  renameSession: beginRenameSession,
                  archiveSession: model.archiveSession,
                  renameWorkspace: beginRenameWorkspace,
                  removeWorkspace: { pendingRemoveWorkspaceID = $0 }
                )
              }
            } else {
              ForEach(flatSessions) { session in
                flatSessionRow(session)
              }
            }
          if groupSessionsByWorkspace && !showArchiveCenter
            && !model.sessionSearchDidRun && !model.sessionSearchLoading
            && !ungroupedSessions.isEmpty
          {
            VStack(alignment: .leading, spacing: 0) {
              Button {
                withAnimation(.easeInOut(duration: 0.15)) { ungroupedExpanded.toggle() }
              } label: {
                HStack(spacing: 6) {
                  Image(systemName: ungroupedExpanded ? "folder.fill" : "folder")
                    .font(.system(size: 12))
                    .foregroundStyle(ArkPalette.secondary)
                    .frame(width: 16)
                  Text(ArkL10n.text(.ungroupedSection, model.languagePreference))
                    .font(.system(size: 14))
                  Spacer()
                }
                .padding(.horizontal, 8)
                .frame(height: 34)
                .contentShape(Rectangle())
              }
              .buttonStyle(.plain)
              if ungroupedExpanded {
                ForEach(ungroupedSessions) { session in
                  flatSessionRow(session)
                }
              }
            }
          }
        }
          .padding(.horizontal, 12)
        }

        Spacer(minLength: 8)
        Button {
          showSettings = true
        } label: {
          Label(ArkL10n.text(.settingsTitle, model.languagePreference), systemImage: "gearshape")
            .frame(maxWidth: .infinity, alignment: .leading)
            .frame(height: 42)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 14)
        .padding(.bottom, 2)
        .accessibilityIdentifier("ark.settings.open")
      }
    }
    .padding(.top, collapsed ? 0 : 6)
    .background(ArkPalette.sidebar)
    .alert(ArkL10n.text(.renameSessionTitle, model.languagePreference), isPresented: Binding(
      get: { renameSessionID != nil },
      set: { if !$0 { renameSessionID = nil } }
    )) {
      TextField(ArkL10n.text(.sessionTitleField, model.languagePreference), text: $renameSessionTitle)
      Button(ArkL10n.text(.commonCancel, model.languagePreference), role: .cancel) {
        renameSessionID = nil
      }
      Button(ArkL10n.text(.commonSave, model.languagePreference)) {
        if let id = renameSessionID { model.renameSession(id, title: renameSessionTitle) }
        renameSessionID = nil
      }
    }
    .alert(ArkL10n.text(.renameWorkspaceTitle, model.languagePreference), isPresented: Binding(
      get: { renameWorkspaceID != nil },
      set: { if !$0 { renameWorkspaceID = nil } }
    )) {
      TextField(ArkL10n.text(.workspaceNameField, model.languagePreference), text: $renameWorkspaceTitle)
      Button(ArkL10n.text(.commonCancel, model.languagePreference), role: .cancel) {
        renameWorkspaceID = nil
      }
      Button(ArkL10n.text(.commonSave, model.languagePreference)) {
        if let id = renameWorkspaceID { model.renameWorkspace(id, title: renameWorkspaceTitle) }
        renameWorkspaceID = nil
      }
    }
    .confirmationDialog(
      ArkL10n.text(.removeWorkspaceDataTitle, model.languagePreference),
      isPresented: Binding(
        get: { pendingRemoveWorkspaceID != nil },
        set: { if !$0 { pendingRemoveWorkspaceID = nil } }
      ),
      titleVisibility: .visible
    ) {
      Button(ArkL10n.text(.removeWorkspaceDataAction, model.languagePreference), role: .destructive) {
        if let id = pendingRemoveWorkspaceID { model.removeWorkspace(id) }
        pendingRemoveWorkspaceID = nil
      }
      Button(ArkL10n.text(.commonCancel, model.languagePreference), role: .cancel) {
        pendingRemoveWorkspaceID = nil
      }
    } message: {
      Text(ArkL10n.format(
        .removeWorkspaceDataDetail,
        model.languagePreference,
        arguments: [pendingRemoveWorkspacePath]
      ))
    }
  }

  private var collapsedControls: some View {
    VStack(spacing: 0) {
      Button(action: toggleCollapse) {
        Image(nsImage: NSApp.applicationIconImage)
          .resizable()
          .scaledToFit()
          .frame(width: 24, height: 24)
          .clipShape(RoundedRectangle(cornerRadius: 5))
          .frame(width: 36, height: 36)
      }
      .buttonStyle(.plain)
      .help(ArkL10n.text(.expandSidebar, model.languagePreference))
      .padding(.top, 18)
      .padding(.bottom, 12)

      railButton("plus.message", help: ArkL10n.text(.newSession, model.languagePreference), action: model.beginNewConversation)
      railButton("magnifyingglass", help: ArkL10n.text(.searchSessions, model.languagePreference)) {
        toggleCollapse()
        searchVisible = true
        DispatchQueue.main.async { searchFocused = true }
      }
      railButton("folder.badge.plus", help: ArkL10n.text(.newConversationAddWorkspace, model.languagePreference), action: chooseWorkspaceDirectory)
      if let error = model.navigationErrorMessage, !error.isEmpty {
        railButton("exclamationmark.triangle", help: error, action: toggleCollapse)
          .foregroundStyle(Color.red)
          .accessibilityIdentifier("ark.sidebar.error")
      }
      Spacer(minLength: 12)
      ZStack(alignment: .topTrailing) {
        railButton("archivebox", help: ArkL10n.text(.archiveTitle, model.languagePreference)) {
          showArchiveCenter.toggle()
          if collapsed { toggleCollapse() }
        }
        if !model.archivedSessionIDs.isEmpty {
          Text("\(model.archivedSessionIDs.count)")
            .font(.system(size: 8, weight: .bold, design: .rounded))
            .padding(.horizontal, 4)
            .padding(.vertical, 1)
            .background(ArkPalette.accent, in: Capsule())
            .offset(x: 2, y: -1)
        }
      }
      railButton("gearshape", help: ArkL10n.text(.settingsTitle, model.languagePreference)) { showSettings = true }
        .padding(.top, 8)
        .padding(.bottom, -2)
    }
    .frame(maxWidth: .infinity)
  }

  private func railButton(
    _ systemImage: String,
    help: String,
    action: @escaping () -> Void
  ) -> some View {
    Button(action: action) {
      Image(systemName: systemImage)
        .font(.system(size: 16))
        .frame(width: 36, height: 36)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .help(help)
    .padding(.bottom, 12)
  }

  private var ungroupedSessions: [ArkSessionSummary] {
    let grouped = Set(model.workspaces.flatMap(\.sessionIDs))
    return model.sessions.filter {
      !$0.blank && !grouped.contains($0.id) && !model.sessionIsArchived($0.id)
        && model.sessionAppearsAtNavigationRoot($0)
    }
  }

  private var flatSessions: [ArkSessionSummary] {
    let rows = model.sessions.filter {
      !$0.blank && !model.sessionIsArchived($0.id) && model.sessionAppearsAtNavigationRoot($0)
    }
    return sortSessionsByRecent ? rows.sorted { $0.updatedAt > $1.updatedAt } : rows
  }

  @ViewBuilder
  private func flatSessionRow(_ session: ArkSessionSummary) -> some View {
    HStack(spacing: 0) {
      Button {
        model.selectSession(session.id)
      } label: {
        HStack(spacing: 0) {
          if session.running {
            Circle().fill(Color.orange).frame(width: 6, height: 6)
              .frame(width: 16)
          }
          Text(session.blank
            ? ArkL10n.text(.newConversation, model.languagePreference)
            : arkSessionDisplayTitle(session.title, language: model.languagePreference))
            .font(.system(size: 14))
            .lineLimit(1)
          Spacer(minLength: 4)
        }
        .padding(.leading, 8)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      if hoveredFlatSessionID == session.id {
        Menu {
          Button(ArkL10n.text(.renameSession, model.languagePreference)) {
            beginRenameSession(session.id)
          }
          Button(ArkL10n.text(.forkSession, model.languagePreference)) {
            model.forkSession(session.id)
          }
          Button(ArkL10n.text(.archiveSession, model.languagePreference), role: .destructive) {
            model.archiveSession(session.id)
          }
        } label: {
          Image(systemName: "ellipsis")
            .frame(width: 28, height: 28)
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
      } else if !session.blank {
        Text(sidebarRelativeDate(session.updatedAt))
          .font(.system(size: 12))
          .foregroundStyle(ArkPalette.secondary)
          .padding(.trailing, 8)
      }
    }
    .frame(height: 32)
    .background(
      model.selectedSessionID == session.id || hoveredFlatSessionID == session.id
        ? ArkPalette.raised : Color.clear,
      in: RoundedRectangle(cornerRadius: 8)
    )
    .onHover { hoveredFlatSessionID = $0 ? session.id : nil }
    .contextMenu {
      Button(ArkL10n.text(.renameSession, model.languagePreference)) {
        beginRenameSession(session.id)
      }
      Button(ArkL10n.text(.forkSession, model.languagePreference)) {
        model.forkSession(session.id)
      }
      Button(ArkL10n.text(.archiveSession, model.languagePreference), role: .destructive) {
        model.archiveSession(session.id)
      }
    }
  }

  private func sidebarRelativeDate(_ date: Date) -> String {
    arkRelativeTimestamp(date, language: model.languagePreference)
  }

  private func sessionTitle(_ id: String) -> String {
    model.sessions.first(where: { $0.id == id })?.title ?? id
  }

  private func beginRenameSession(_ id: String) {
    renameSessionTitle = sessionTitle(id)
    renameSessionID = id
  }

  private func beginRenameWorkspace(_ id: String) {
    renameWorkspaceTitle = model.workspaces.first(where: { $0.id == id })?.title ?? ""
    renameWorkspaceID = id
  }

  private var pendingRemoveWorkspacePath: String {
    guard let pendingRemoveWorkspaceID else { return "—" }
    return model.workspaces.first(where: { $0.id == pendingRemoveWorkspaceID })?.path ?? "—"
  }

  private func chooseWorkspaceDirectory() {
    presentWorkspaceDirectoryPicker(for: model)
  }
}

private struct WorkspaceSection: View {
  @ObservedObject var model: ArkAppModel
  let workspace: ArkWorkspace
  let sortByRecent: Bool
  let renameSession: (String) -> Void
  let archiveSession: (String) -> Void
  let renameWorkspace: (String) -> Void
  let removeWorkspace: (String) -> Void
  @State private var expanded = true
  @State private var workspaceHovered = false
  @State private var hoveredSessionID: String?
  @State private var showAllSessions = false

  private var workspaceSessions: [ArkSessionSummary] {
    var lookup: [String: ArkSessionSummary] = [:]
    for session in model.sessions where lookup[session.id] == nil {
      lookup[session.id] = session
    }
    let rows: [ArkSessionSummary] = workspace.sessionIDs.compactMap { id in
      guard let session = lookup[id], !session.blank, !model.sessionIsArchived(id),
            model.sessionAppearsAtNavigationRoot(session)
      else { return nil }
      return session
    }
    return sortByRecent ? rows.sorted { $0.updatedAt > $1.updatedAt } : rows
  }

  private var visibleSessions: [ArkSessionSummary] {
    showAllSessions ? workspaceSessions : Array(workspaceSessions.prefix(5))
  }

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 0) {
        Button {
          withAnimation(.easeInOut(duration: 0.15)) { expanded.toggle() }
        } label: {
          Group {
            if workspaceHovered {
              Image(systemName: "chevron.right")
                .rotationEffect(.degrees(expanded ? 90 : 0))
            } else {
              Image(systemName: expanded ? "folder.fill" : "folder")
            }
          }
          .font(.system(size: 12))
          .foregroundStyle(
            expanded && model.selectedWorkspaceID == workspace.id
              ? ArkPalette.accent : ArkPalette.secondary
          )
          .frame(width: 28, height: 34)
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(ArkL10n.text(
          expanded ? .collapseWorkspace : .expandWorkspace,
          model.languagePreference
        ))

        Button {
          model.selectWorkspace(workspace.id)
          if !expanded {
            withAnimation(.easeInOut(duration: 0.15)) { expanded = true }
          }
        } label: {
          HStack(spacing: 6) {
            Text(workspace.title)
              .font(.system(size: 14))
              .lineLimit(1)
            Spacer(minLength: 4)
          }
          .frame(maxWidth: .infinity, minHeight: 34, alignment: .leading)
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("ark.workspace.open.\(workspace.id)")

        if workspaceHovered {
          Menu {
            Button(ArkL10n.text(.renameWorkspace, model.languagePreference)) {
              renameWorkspace(workspace.id)
            }
            Button(ArkL10n.text(.removeWorkspace, model.languagePreference), role: .destructive) {
              removeWorkspace(workspace.id)
            }
          } label: {
            Image(systemName: "ellipsis")
              .frame(width: 24, height: 28)
          }
          .menuStyle(.borderlessButton)
          .menuIndicator(.hidden)
          Button {
            model.createSession(in: workspace.id)
          } label: {
            Image(systemName: "plus")
              .frame(width: 24, height: 28)
          }
          .buttonStyle(.plain)
          .help(ArkL10n.text(.newSessionInWorkspace, model.languagePreference))
        }
      }
      .padding(.trailing, 6)
      .background(
        workspaceHovered ? ArkPalette.raised.opacity(0.7) : Color.clear,
        in: RoundedRectangle(cornerRadius: 8)
      )
      .onHover { workspaceHovered = $0 }
      .onDrag {
        NSItemProvider(object: "ark-workspace:\(workspace.id)" as NSString)
      }
      .onDrop(of: [UTType.plainText], isTargeted: nil, perform: acceptWorkspaceDrop)
      .contextMenu {
        Button(ArkL10n.text(.renameWorkspace, model.languagePreference)) {
          renameWorkspace(workspace.id)
        }
        Button(ArkL10n.text(.removeWorkspace, model.languagePreference), role: .destructive) {
          removeWorkspace(workspace.id)
        }
      }

      if expanded {
        ForEach(visibleSessions) { session in
          HStack(spacing: 0) {
            Button {
              model.selectSession(session.id)
            } label: {
              HStack(spacing: 0) {
                Group {
                  if session.origin == "subagent" {
                    Image(systemName: "arrow.turn.down.right")
                      .font(.system(size: 9))
                  } else if session.running {
                    Circle().fill(Color.orange).frame(width: 6, height: 6)
                  } else {
                    Color.clear.frame(width: 6, height: 6)
                  }
                }
                .foregroundStyle(ArkPalette.secondary)
                .frame(width: 16)
                Text(session.blank
                  ? ArkL10n.text(.newConversation, model.languagePreference)
                  : arkSessionDisplayTitle(session.title, language: model.languagePreference))
                  .font(.system(size: 14))
                  .lineLimit(1)
                  .padding(.leading, 4)
                Spacer(minLength: 4)
              }
              .padding(.leading, 8)
              .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if hoveredSessionID == session.id {
              Menu {
                Button(ArkL10n.text(.renameSession, model.languagePreference)) {
                  renameSession(session.id)
                }
                Button(ArkL10n.text(.forkSession, model.languagePreference)) {
                  model.forkSession(session.id)
                }
                Button(ArkL10n.text(.archiveSession, model.languagePreference), role: .destructive) {
                  archiveSession(session.id)
                }
              } label: {
                Image(systemName: "ellipsis")
                  .frame(width: 28, height: 28)
              }
              .menuStyle(.borderlessButton)
              .menuIndicator(.hidden)
            } else if !session.blank {
              Text(relativeDate(session.updatedAt))
                .font(.system(size: 12))
                .foregroundStyle(ArkPalette.secondary)
                .padding(.trailing, 8)
            }
          }
          .frame(height: 32)
          .background(
            model.selectedSessionID == session.id || hoveredSessionID == session.id
              ? ArkPalette.raised : Color.clear,
            in: RoundedRectangle(cornerRadius: 8)
          )
          .onHover { hovering in hoveredSessionID = hovering ? session.id : nil }
          .onDrag {
            NSItemProvider(
              object: "ark-session:\(workspace.id):\(session.id)" as NSString
            )
          }
          .onDrop(of: [UTType.plainText], isTargeted: nil) { providers in
            acceptSessionDrop(providers, before: session.id)
          }
          .contextMenu {
            Button(ArkL10n.text(.renameSession, model.languagePreference)) {
              renameSession(session.id)
            }
            Button(ArkL10n.text(.forkSession, model.languagePreference)) {
              model.forkSession(session.id)
            }
            Button(ArkL10n.text(.archiveSession, model.languagePreference), role: .destructive) {
              archiveSession(session.id)
            }
          }
        }
        if workspaceSessions.count > 5 {
          Button {
            withAnimation(.easeInOut(duration: 0.15)) { showAllSessions.toggle() }
          } label: {
            Text(
              showAllSessions
                ? ArkL10n.text(.showLess, model.languagePreference)
                : ArkL10n.format(
                    .showMoreCount,
                    model.languagePreference,
                    arguments: ["\(workspaceSessions.count - visibleSessions.count)"]
                  )
            )
            .font(.system(size: 12))
            .foregroundStyle(ArkPalette.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.leading, 28)
            .frame(height: 28)
          }
          .buttonStyle(.plain)
        }
      }
    }
    .onAppear {
      let key = "ark.sidebar.workspace.expanded.\(workspace.id)"
      if UserDefaults.standard.object(forKey: key) != nil {
        expanded = UserDefaults.standard.bool(forKey: key)
      }
    }
    .onChange(of: expanded) { value in
      UserDefaults.standard.set(
        value,
        forKey: "ark.sidebar.workspace.expanded.\(workspace.id)"
      )
    }
  }

  private func relativeDate(_ date: Date) -> String {
    arkRelativeTimestamp(date, language: model.languagePreference)
  }

  private func acceptWorkspaceDrop(_ providers: [NSItemProvider]) -> Bool {
    guard let provider = providers.first(where: { $0.canLoadObject(ofClass: NSString.self) }) else {
      return false
    }
    provider.loadObject(ofClass: NSString.self) { object, _ in
      guard let payload = object as? String,
            payload.hasPrefix("ark-workspace:")
      else { return }
      let draggedID = String(payload.dropFirst("ark-workspace:".count))
      guard !draggedID.isEmpty, draggedID != workspace.id else { return }
      DispatchQueue.main.async {
        model.reorderWorkspace(draggedID, before: workspace.id)
      }
    }
    return true
  }

  private func acceptSessionDrop(
    _ providers: [NSItemProvider],
    before sessionID: String
  ) -> Bool {
    guard let provider = providers.first(where: { $0.canLoadObject(ofClass: NSString.self) }) else {
      return false
    }
    provider.loadObject(ofClass: NSString.self) { object, _ in
      guard let payload = object as? String,
            payload.hasPrefix("ark-session:")
      else { return }
      let parts = payload.split(separator: ":", maxSplits: 2).map(String.init)
      guard parts.count == 3,
            parts[1] == workspace.id,
            parts[2] != sessionID
      else { return }
      DispatchQueue.main.async {
        model.reorderSession(parts[2], in: workspace.id, before: sessionID)
      }
    }
    return true
  }
}

private struct NativeMainArea: View {
  @ObservedObject var model: ArkAppModel
  @StateObject private var chatScrollController = ArkChatScrollController()

  private var showsConversationChrome: Bool {
    model.selectedSessionID != nil && model.selectedSession?.blank != true
  }

  var body: some View {
    VStack(spacing: 0) {
      if showsConversationChrome {
        NativeSessionHeader(model: model)
        Divider().overlay(ArkPalette.border)
      }
      Group {
        if !showsConversationChrome {
          NativeHero(model: model)
        } else {
          switch model.selectedTab {
          case .chat:
            NativeChatView(
              model: model,
              scrollController: chatScrollController
            )
          case .trajectory: NativeTrajectoryParityView(model: model).equatable()
          case .wiki: NativeWikiView(model: model).equatable()
          }
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
      .clipped()
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .background(ArkPalette.shell)
  }
}

private struct NativeSessionHeader: View {
  @ObservedObject var model: ArkAppModel
  @State private var chatPresentationRevision: UInt64 = 0

  private var indicatorState: NativeSessionIndicatorState {
    _ = chatPresentationRevision
    if model.selectedPendingInteractionCount > 0 { return .needsDecision }
    if model.selectedSessionJobPresentations.contains(where: \.isActive) { return .running }
    guard let session = model.selectedSession, !session.blank else { return .idle }
    if session.running { return .running }
    let latestOutcomes: [(sequence: Int, failed: Bool)] = [
      model.toolActivities.max(by: { $0.sequence < $1.sequence }).map {
        ($0.sequence, $0.isError || $0.isInterrupted)
      },
      model.chatStatuses.max(by: { $0.sequence < $1.sequence }).map {
        ($0.sequence, $0.phase == .failed || $0.phase == .stopped)
      },
      model.messages.max(by: { $0.id < $1.id }).map {
        ($0.id, $0.interrupted)
      },
    ].compactMap { $0 }
    return ArkSessionOutcomeResolver.latestIsFailure(latestOutcomes)
      ? .failed
      : .idle
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 7) {
      HStack(spacing: 10) {
        if let parent = model.selectedSessionParent {
          Button {
            model.selectSession(parent.id)
          } label: {
            Image(systemName: "chevron.left")
              .frame(width: 28, height: 28)
              .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .foregroundStyle(ArkPalette.secondary)
          .help(ArkL10n.text(.returnToParentSession, model.languagePreference))
          .accessibilityLabel(ArkL10n.text(.returnToParentSession, model.languagePreference))
          .accessibilityIdentifier("ark.session.return-to-parent")
        }
        Text(model.selectedSession.map {
          arkSessionDisplayTitle($0.title, language: model.languagePreference)
        } ?? ArkL10n.text(.newConversation, model.languagePreference))
          .font(.system(size: 14, weight: .medium))
          .accessibilityIdentifier("ark.session.current.\(model.selectedSessionID ?? "none")")
        NativeSessionActivityIndicator(model: model, state: indicatorState)
        NativeSubagentLineageControl(model: model)
        WindowDragSurface()
          .frame(maxWidth: .infinity, minHeight: 28)
          .accessibilityHidden(true)
        if model.selectedPendingInteractionCount > 0 {
          Text(ArkL10n.format(
            .pendingInteractionsCount,
            model.languagePreference,
            arguments: [String(model.selectedPendingInteractionCount)]
          ))
            .font(.system(size: 11, weight: .semibold))
            .padding(.horizontal, 9)
            .padding(.vertical, 4)
            .background(Color.orange.opacity(0.22), in: Capsule())
            .foregroundStyle(Color.orange)
        }
      }
      HStack(spacing: 10) {
        ForEach(ArkAppModel.Tab.allCases) { tab in
          Button {
            model.userSelectedTab(tab)
          } label: {
            VStack(spacing: 7) {
              Text(tab.displayName(model.languagePreference))
                .lineLimit(1)
                .minimumScaleFactor(0.82)
              Rectangle()
                .fill(model.selectedTab == tab ? ArkPalette.accent : Color.clear)
                .frame(width: 54, height: 2)
            }
            .frame(width: 54, height: 58)
            .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .foregroundStyle(model.selectedTab == tab ? ArkPalette.primary : ArkPalette.secondary)
        }
      }
      .font(.system(size: 12))
    }
    .padding(.leading, 20)
    .padding(.trailing, 28)
    .padding(.top, 12)
    .frame(height: 75)
    .onReceive(model.chatPresentationDidChange) { _ in
      chatPresentationRevision &+= 1
    }
  }
}

private struct NativeSubagentLineageControl: View {
  @ObservedObject var model: ArkAppModel
  @State private var presented = false
  @State private var expanded = Set<String>()

  private var rootSessionID: String? { model.selectedSubagentLineageRootID }
  private var descendantIDs: Set<String> {
    guard let rootSessionID else { return [] }
    return model.knownSubagentDescendantIDs(from: rootSessionID)
  }
  private var runningCount: Int {
    descendantIDs.filter { sessionID in
      if let session = model.sessionSummary(for: sessionID) { return session.running }
      return model.subagentEntriesByID[sessionID]?.activity == "running"
    }.count
  }
  private var visible: Bool {
    guard let rootSessionID else { return false }
    if model.selectedSession?.origin == "subagent" { return true }
    if !descendantIDs.isEmpty { return true }
    return model.subagentCatalogState(for: rootSessionID)?.phase == .failed
  }

  var body: some View {
    Group {
      if visible, let rootSessionID {
        Button {
          presented.toggle()
          if presented { model.refreshSubagentCatalog(parentSessionID: rootSessionID) }
        } label: {
          HStack(spacing: 5) {
            Image(systemName: "arrow.triangle.branch")
            Text(triggerTitle)
              .lineLimit(1)
            Image(systemName: "chevron.down")
              .font(.system(size: 8, weight: .semibold))
          }
          .font(.system(size: 11, weight: .medium))
          .foregroundStyle(ArkPalette.secondary)
          .padding(.horizontal, 7)
          .frame(minHeight: 28)
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("ark.subagent.lineage")
        .popover(isPresented: $presented, arrowEdge: .bottom) {
          NativeSubagentLineageTree(
            model: model,
            rootSessionID: rootSessionID,
            expanded: $expanded,
            dismiss: { presented = false }
          )
        }
      }
    }
    .task(id: model.selectedSessionID) {
      expanded.removeAll()
      model.prepareSelectedSubagentLineage()
    }
  }

  private var triggerTitle: String {
    if model.selectedSession?.origin == "subagent" {
      return model.selectedSubagentEntry?.label
        ?? model.selectedSession.map {
          arkSessionDisplayTitle($0.title, language: model.languagePreference)
        }
        ?? ArkL10n.text(.subagentLineage, model.languagePreference)
    }
    if runningCount > 0 {
      return ArkL10n.format(
        .subagentLineageRunningCount,
        model.languagePreference,
        arguments: [String(runningCount)]
      )
    }
    return ArkL10n.format(
      .subagentLineageCount,
      model.languagePreference,
      arguments: [String(descendantIDs.count)]
    )
  }
}

private struct NativeSubagentLineageTree: View {
  @ObservedObject var model: ArkAppModel
  let rootSessionID: String
  @Binding var expanded: Set<String>
  let dismiss: () -> Void

  private var rows: [ArkSubagentLineageRow] {
    model.subagentLineageRows(rootSessionID: rootSessionID, expanded: expanded)
  }

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 8) {
        Label(
          ArkL10n.text(.subagentLineage, model.languagePreference),
          systemImage: "arrow.triangle.branch"
        )
        .font(.system(size: 12, weight: .semibold))
        Spacer()
        if model.subagentCatalogState(for: rootSessionID)?.parentAvailable == false {
          Text(ArkL10n.text(.subagentLineageParentUnavailable, model.languagePreference))
            .font(.system(size: 10, weight: .medium))
            .foregroundStyle(Color.orange)
        }
        Button {
          model.refreshSubagentCatalog(parentSessionID: rootSessionID)
        } label: {
          Image(systemName: "arrow.clockwise")
            .frame(width: 26, height: 26)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(ArkL10n.text(.subagentLineageRefresh, model.languagePreference))
      }
      .padding(.horizontal, 12)
      .frame(height: 38)

      Divider().overlay(ArkPalette.border)

      ScrollView {
        LazyVStack(spacing: 2) {
          ForEach(rows) { row in
            lineageRow(row)
          }
        }
        .padding(6)
      }
      .frame(minHeight: 80, maxHeight: 390)
    }
    .frame(width: 390)
    .background(ArkPalette.panel)
    .accessibilityIdentifier("ark.subagent.lineage.tree")
  }

  @ViewBuilder
  private func lineageRow(_ row: ArkSubagentLineageRow) -> some View {
    switch row.kind {
    case .loading:
      HStack(spacing: 8) {
        ProgressView().controlSize(.small)
        Text(ArkL10n.text(.subagentLineageLoading, model.languagePreference))
          .foregroundStyle(ArkPalette.secondary)
        Spacer()
      }
      .padding(.leading, CGFloat(max(0, row.depth - 1)) * 18)
      .frame(maxWidth: .infinity, minHeight: 34, alignment: .leading)

    case .failure:
      HStack(spacing: 8) {
        Image(systemName: "exclamationmark.triangle")
          .foregroundStyle(Color.orange)
        VStack(alignment: .leading, spacing: 2) {
          Text(ArkL10n.text(.subagentLineageLoadFailed, model.languagePreference))
          if let message = row.message, !message.isEmpty {
            Text(message).font(.system(size: 10)).foregroundStyle(ArkPalette.secondary).lineLimit(2)
          }
        }
        Spacer()
        Button(ArkL10n.text(.subagentLineageRetry, model.languagePreference)) {
          model.refreshSubagentCatalog(parentSessionID: row.parentSessionID)
        }
        .buttonStyle(.borderless)
      }
      .padding(.leading, CGFloat(max(0, row.depth - 1)) * 18)
      .frame(maxWidth: .infinity, minHeight: 38, alignment: .leading)

    case .diagnostic:
      if let entry = row.entry {
        HStack(spacing: 8) {
          Image(systemName: "exclamationmark.circle.fill")
            .foregroundStyle(Color.red)
          VStack(alignment: .leading, spacing: 2) {
            Text(entry.label ?? entry.id).lineLimit(1)
            Text(entry.reason ?? ArkL10n.text(.subagentLineageDiagnostic, model.languagePreference))
              .font(.system(size: 10))
              .foregroundStyle(ArkPalette.secondary)
              .lineLimit(2)
          }
          Spacer()
        }
        .padding(.leading, CGFloat(max(0, row.depth - 1)) * 18)
        .frame(maxWidth: .infinity, minHeight: 42, alignment: .leading)
      }

    case .child:
      if let entry = row.entry {
        childRow(entry, row: row)
      }
    }
  }

  private func childRow(
    _ entry: ArkSubagentEntry,
    row: ArkSubagentLineageRow
  ) -> some View {
    let title = entry.label
      ?? model.sessionSummary(for: entry.id)?.title
      ?? entry.id
    let isExpanded = expanded.contains(entry.id)
    let isCurrent = model.selectedSessionID == entry.id
    return HStack(spacing: 4) {
      if entry.hasChildren {
        Button {
          if isExpanded {
            expanded.remove(entry.id)
          } else {
            expanded.insert(entry.id)
            model.refreshSubagentCatalog(parentSessionID: entry.id)
          }
        } label: {
          Image(systemName: "chevron.right")
            .font(.system(size: 9, weight: .semibold))
            .rotationEffect(.degrees(isExpanded ? 90 : 0))
            .frame(width: 22, height: 34)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(ArkL10n.format(
          isExpanded ? .subagentLineageCollapse : .subagentLineageExpand,
          model.languagePreference,
          arguments: [title]
        ))
      } else {
        Color.clear.frame(width: 22, height: 34)
      }

      Button {
        guard !row.placeholder else { return }
        model.selectSession(entry.id)
        dismiss()
      } label: {
        HStack(spacing: 8) {
          Circle()
            .fill(entry.activity == "running" ? Color.green : ArkPalette.secondary.opacity(0.65))
            .frame(width: 7, height: 7)
          VStack(alignment: .leading, spacing: 2) {
            Text(title)
              .font(.system(size: 12, weight: isCurrent ? .semibold : .medium))
              .foregroundStyle(isCurrent ? ArkPalette.accent : ArkPalette.primary)
              .lineLimit(1)
            Text(detail(for: entry))
              .font(.system(size: 10))
              .foregroundStyle(ArkPalette.secondary)
              .lineLimit(1)
          }
          Spacer(minLength: 6)
          if row.placeholder { ProgressView().controlSize(.mini) }
          if isCurrent { Image(systemName: "checkmark").foregroundStyle(ArkPalette.accent) }
        }
        .frame(maxWidth: .infinity, minHeight: 38, alignment: .leading)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .disabled(row.placeholder)
      .accessibilityIdentifier("ark.subagent.lineage.row.\(entry.id)")
    }
    .padding(.leading, CGFloat(max(0, row.depth - 1)) * 18)
    .padding(.horizontal, 4)
    .background(isCurrent ? ArkPalette.accent.opacity(0.12) : Color.clear, in: RoundedRectangle(cornerRadius: 7))
  }

  private func detail(for entry: ArkSubagentEntry) -> String {
    let mode = entry.mode == "one-shot"
      ? ArkL10n.text(.subagentLineageOneShot, model.languagePreference)
      : ArkL10n.text(.subagentLineageContinuable, model.languagePreference)
    let activity = entry.activity == "running"
      ? ArkL10n.text(.subagentLineageRunning, model.languagePreference)
      : ArkL10n.text(.subagentLineageInactive, model.languagePreference)
    let availability = model.subagentParentAvailableByID[entry.id] == false
      ? " · \(ArkL10n.text(.subagentLineageParentUnavailable, model.languagePreference))"
      : ""
    return "\(mode) · \(activity)\(availability)"
  }
}

private struct NativeSessionActionsMenu: View {
  @ObservedObject var model: ArkAppModel
  @State private var showRename = false
  @State private var renameTitle = ""
  @State private var showDisplayControls = false
  @AppStorage("ark.native.chat.font-size") private var transcriptFontSize = Double(ChatLayoutMetrics.messageFontSize)
  @AppStorage("ark.native.chat.content-width") private var contentWidth = Double(ChatLayoutMetrics.contentColumnMaxWidth)
  @AppStorage("ark.native.chat.content-width-adaptive") private var contentWidthAdaptive = true
  @AppStorage("ark.native.chat.compact-process") private var compactProcess = true

  var body: some View {
    Menu {
      Button(ArkL10n.text(.renameSession, model.languagePreference)) {
        renameTitle = model.selectedSession.map {
          arkSessionDisplayTitle($0.title, language: model.languagePreference)
        } ?? ""
        showRename = true
      }
      Button(ArkL10n.text(.forkSession, model.languagePreference)) {
        if let id = model.selectedSessionID { model.forkSession(id) }
      }
      Button(ArkL10n.text(.archiveSession, model.languagePreference)) {
        if let id = model.selectedSessionID { model.archiveSession(id) }
      }
      Button(ArkL10n.text(.sessionExport, model.languagePreference)) {
        exportSessionLog()
      }
      Divider()
      Button {
        showDisplayControls = true
      } label: {
        Label(
          ArkL10n.text(.chatDisplayTitle, model.languagePreference),
          systemImage: "textformat.size"
        )
      }
    } label: {
      Image(systemName: "ellipsis.circle")
        .frame(width: 30, height: 30)
        .contentShape(Rectangle())
    }
    .menuStyle(.borderlessButton)
    .accessibilityIdentifier("ark.global.session-actions")
    .popover(isPresented: $showDisplayControls, arrowEdge: .bottom) {
      NativeChatDisplaySettingsPanel(
        language: model.languagePreference,
        fontSize: $transcriptFontSize,
        contentWidth: $contentWidth,
        contentWidthAdaptive: $contentWidthAdaptive,
        compactProcess: $compactProcess
      )
    }
    .alert(ArkL10n.text(.renameSessionTitle, model.languagePreference), isPresented: $showRename) {
      TextField(ArkL10n.text(.sessionTitleField, model.languagePreference), text: $renameTitle)
      Button(ArkL10n.text(.commonCancel, model.languagePreference), role: .cancel) {}
      Button(ArkL10n.text(.commonSave, model.languagePreference)) {
        if let id = model.selectedSessionID { model.renameSession(id, title: renameTitle) }
      }
    }
    .sheet(isPresented: Binding(
      get: { model.sessionExportState != .idle },
      set: { shown in
        if !shown {
          if model.sessionExportState == .exporting { model.cancelSessionExport() }
          else { model.dismissSessionExportState() }
        }
      }
    )) {
      NativeSessionExportPanel(model: model)
    }
  }

  private func exportSessionLog() {
    guard let sessionID = model.selectedSessionID else { return }
    let panel = NSSavePanel()
    panel.nameFieldStringValue = ArkInteractionAPIContract.sessionExportFilename(sessionID: sessionID)
    panel.allowedContentTypes = [.zip]
    panel.prompt = ArkL10n.text(.sessionExport, model.languagePreference)
    guard panel.runModal() == .OK, let url = panel.url else { return }
    model.exportSelectedSession(to: url)
  }
}

enum NativeSessionIndicatorState {
  case idle
  case running
  case needsDecision
  case failed

  var nsColor: NSColor {
    switch self {
    case .idle: return .systemGray
    case .running: return .systemGreen
    case .needsDecision: return .systemYellow
    case .failed: return .systemRed
    }
  }

  func label(_ language: ArkLanguagePreference) -> String {
    switch self {
    case .idle: return ArkL10n.text(.sessionActivityIdle, language)
    case .running: return ArkL10n.text(.sessionActivityRunning, language)
    case .needsDecision: return ArkL10n.text(.sessionActivityNeedsDecision, language)
    case .failed: return ArkL10n.text(.sessionActivityFailed, language)
    }
  }

}

private struct NativeSessionActivityIndicator: View {
  @ObservedObject var model: ArkAppModel
  let state: NativeSessionIndicatorState

  @State private var presented = false
  @State private var hoverGeneration = 0

  private var summary: ArkLongTaskSummary? { model.selectedLongTaskSummary }
  private var jobs: [ArkSessionJobPresentation] { model.selectedSessionJobPresentations }
  private var hasDetails: Bool { summary != nil || !jobs.isEmpty }

  var body: some View {
    NativeSessionStatusLight(
      state: state,
      language: model.languagePreference,
      onHover: hoverChanged
    )
    .frame(width: 24, height: 24)
    .overlay(alignment: .topLeading) {
      if presented {
        NativeSessionActivityPopover(
          summary: summary,
          jobs: jobs,
          language: model.languagePreference
        )
          .offset(x: -8, y: 24)
          .onHover(perform: hoverChanged)
          .transition(.opacity)
          .zIndex(2_000)
      }
    }
    .zIndex(presented ? 2_000 : 0)
    .accessibilityLabel(state.label(model.languagePreference))
    .accessibilityIdentifier("ark.session.activity-indicator")
  }

  private func hoverChanged(_ inside: Bool) {
    hoverGeneration &+= 1
    let generation = hoverGeneration
    if inside {
      if hasDetails { presented = true }
      return
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.28) {
      if hoverGeneration == generation { presented = false }
    }
  }
}

private struct NativeSessionActivityPopover: View {
  let summary: ArkLongTaskSummary?
  let jobs: [ArkSessionJobPresentation]
  let language: ArkLanguagePreference

  private var hasActiveJob: Bool { jobs.contains(where: \.isActive) }

  var body: some View {
    Group {
      if hasActiveJob {
        TimelineView(.periodic(from: .now, by: 1)) { context in
          content(now: context.date)
        }
      } else {
        content(now: Date())
      }
    }
    .frame(width: 360)
    .padding(12)
    .background(ArkPalette.panel, in: RoundedRectangle(cornerRadius: 12))
    .overlay(
      RoundedRectangle(cornerRadius: 12)
        .stroke(ArkPalette.border)
    )
    .shadow(color: Color.black.opacity(0.22), radius: 14, y: 6)
  }

  private func content(now: Date) -> some View {
    VStack(alignment: .leading, spacing: 9) {
      Text(ArkL10n.text(.sessionActivityTitle, language))
        .font(.system(size: 12, weight: .semibold))
      if let summary {
        VStack(alignment: .leading, spacing: 4) {
          Text(summary.title)
            .font(.system(size: 11, weight: .semibold))
            .lineLimit(2)
          if let detail = summary.detail, !detail.isEmpty {
            Text(detail)
              .font(.system(size: 9))
              .foregroundStyle(ArkPalette.secondary)
              .lineLimit(2)
          }
          if summary.totalCount > 0 {
            HStack(spacing: 8) {
              ProgressView(
                value: Double(summary.completedCount),
                total: Double(max(summary.totalCount, 1))
              )
              Text("\(summary.completedCount)/\(summary.totalCount)")
                .font(.system(size: 9, design: .monospaced))
                .foregroundStyle(ArkPalette.secondary)
            }
          }
        }
      }
      if !jobs.isEmpty {
        if summary != nil { Divider() }
        ScrollView {
          VStack(alignment: .leading, spacing: 6) {
            ForEach(jobs.prefix(12)) { job in
              HStack(alignment: .firstTextBaseline, spacing: 7) {
                Circle()
                  .fill(jobColor(job.status))
                  .frame(width: 7, height: 7)
                VStack(alignment: .leading, spacing: 2) {
                  Text(job.label)
                    .font(.system(size: 10, weight: .medium))
                    .lineLimit(1)
                  Text([job.kind, job.detail].compactMap { $0 }.joined(separator: " · "))
                    .font(.system(size: 9))
                    .foregroundStyle(ArkPalette.secondary)
                    .lineLimit(1)
                }
                Spacer(minLength: 8)
                VStack(alignment: .trailing, spacing: 2) {
                  Text(jobLabel(job.status))
                  Text(formatDuration(job.duration(at: now)))
                }
                .font(.system(size: 9, design: .monospaced))
                .foregroundStyle(ArkPalette.secondary)
              }
              .frame(minHeight: 30)
            }
          }
        }
        .frame(maxHeight: 300)
      }
    }
  }

  private func jobLabel(_ status: String) -> String {
    switch status {
    case "running": return ArkL10n.text(.executionRunning, language)
    case "stopping": return ArkL10n.text(.sessionActivityStopping, language)
    case "completed": return ArkL10n.text(.executionCompleted, language)
    case "killed": return ArkL10n.text(.sessionActivityStopped, language)
    default: return ArkL10n.text(.executionFailed, language)
    }
  }

  private func jobColor(_ status: String) -> Color {
    switch status {
    case "running": return .green
    case "stopping", "killed": return .orange
    case "completed": return ArkPalette.secondary
    default: return .red
    }
  }

  private func formatDuration(_ interval: TimeInterval) -> String {
    if interval < 60 { return String(format: "%.0fs", interval) }
    let seconds = Int(interval.rounded())
    if seconds < 3_600 { return "\(seconds / 60)m \(seconds % 60)s" }
    return "\(seconds / 3_600)h \((seconds % 3_600) / 60)m"
  }
}

private struct NativeSessionStatusLight: NSViewRepresentable {
  let state: NativeSessionIndicatorState
  let language: ArkLanguagePreference
  let onHover: (Bool) -> Void

  init(
    state: NativeSessionIndicatorState,
    language: ArkLanguagePreference,
    onHover: @escaping (Bool) -> Void = { _ in }
  ) {
    self.state = state
    self.language = language
    self.onHover = onHover
  }

  func makeNSView(context: Context) -> NativeSessionStatusLightLayerView {
    let view = NativeSessionStatusLightLayerView()
    view.onHover = onHover
    view.update(state, label: state.label(language))
    return view
  }

  func updateNSView(_ view: NativeSessionStatusLightLayerView, context: Context) {
    view.onHover = onHover
    view.update(state, label: state.label(language))
  }

  static func dismantleNSView(
    _ view: NativeSessionStatusLightLayerView,
    coordinator: Void
  ) {
    view.dismantle()
  }
}

final class NativeSessionStatusLightLayerView: NSView {
  private let dot = CAShapeLayer()
  var onHover: ((Bool) -> Void)?

  override var intrinsicContentSize: NSSize { NSSize(width: 24, height: 24) }

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    wantsLayer = true
    layer?.masksToBounds = false
    dot.anchorPoint = CGPoint(x: 0.5, y: 0.5)
    dot.actions = [
      "bounds": NSNull(), "position": NSNull(), "path": NSNull(),
      "fillColor": NSNull(), "shadowColor": NSNull(), "shadowOpacity": NSNull(),
      "shadowRadius": NSNull(), "opacity": NSNull(), "transform": NSNull(),
    ]
    layer?.addSublayer(dot)
  }

  required init?(coder: NSCoder) {
    fatalError("NativeSessionStatusLightLayerView is programmatic")
  }

  override var mouseDownCanMoveWindow: Bool { false }
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

  override func hitTest(_ point: NSPoint) -> NSView? {
    guard !isHidden, alphaValue > 0, bounds.contains(point) else { return nil }
    return self
  }

  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    trackingAreas.forEach(removeTrackingArea)
    addTrackingArea(NSTrackingArea(
      rect: .zero,
      options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
      owner: self,
      userInfo: nil
    ))
  }

  override func mouseEntered(with event: NSEvent) {
    onHover?(true)
  }

  override func mouseExited(with event: NSEvent) {
    onHover?(false)
  }

  override func layout() {
    super.layout()
    let diameter = min(8, bounds.width, bounds.height)
    let dotBounds = CGRect(x: 0, y: 0, width: diameter, height: diameter)
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    dot.bounds = dotBounds
    dot.position = CGPoint(x: bounds.midX, y: bounds.midY)
    dot.path = CGPath(ellipseIn: dot.bounds, transform: nil)
    CATransaction.commit()
  }

  func update(_ state: NativeSessionIndicatorState, label: String) {
    toolTip = label
    setAccessibilityElement(true)
    setAccessibilityRole(.image)
    setAccessibilityLabel(label)
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    let emphasized = state != .idle
    dot.fillColor = state.nsColor.cgColor
    dot.shadowColor = state.nsColor.cgColor
    dot.shadowOpacity = emphasized ? 0.52 : 0.28
    dot.shadowRadius = emphasized ? 4 : 2
    dot.opacity = 1
    dot.transform = CATransform3DIdentity
    CATransaction.commit()
  }

  func dismantle() {
    dot.removeAllAnimations()
    onHover = nil
  }
}

private struct NativeSessionExportPanel: View {
  @ObservedObject var model: ArkAppModel

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      switch model.sessionExportState {
      case .idle:
        EmptyView()
      case .exporting:
        HStack(spacing: 12) {
          ProgressView()
          VStack(alignment: .leading, spacing: 4) {
            Text(ArkL10n.text(.sessionExporting, model.languagePreference))
              .font(.system(size: 14, weight: .semibold))
            Text(ArkL10n.text(.sessionExportPreparing, model.languagePreference))
              .font(.system(size: 11))
              .foregroundStyle(ArkPalette.secondary)
          }
        }
        Button(
          ArkL10n.text(.sessionExportCancel, model.languagePreference),
          role: .cancel,
          action: model.cancelSessionExport
        )
      case .succeeded(let bytes):
        Label(
          ArkL10n.text(.sessionExportSucceeded, model.languagePreference),
          systemImage: "checkmark.circle.fill"
        )
          .font(.system(size: 14, weight: .semibold))
          .foregroundStyle(Color.green)
        Text(ArkL10n.format(
          .sessionExportBytes,
          model.languagePreference,
          arguments: [String(bytes)]
        ))
          .font(.system(size: 12))
          .foregroundStyle(ArkPalette.secondary)
        Button(
          ArkL10n.text(.sessionExportDone, model.languagePreference),
          action: model.dismissSessionExportState
        )
      case .failed(let message):
        Label(
          ArkL10n.text(.sessionExportFailed, model.languagePreference),
          systemImage: "xmark.octagon.fill"
        )
          .font(.system(size: 14, weight: .semibold))
          .foregroundStyle(Color.red)
        Text(message).font(.system(size: 11)).textSelection(.enabled)
        Button(
          ArkL10n.text(.sessionExportClose, model.languagePreference),
          action: model.dismissSessionExportState
        )
      }
    }
    .padding(22)
    .frame(width: 420)
  }
}

private struct NativeHero: View {
  @ObservedObject var model: ArkAppModel
  @Environment(\.locale) private var locale

  private var selectedPresetID: String {
    let requested = model.nextAgentPresetID ?? model.defaultAgentPresetID
    return visiblePresets.contains(where: { $0.id == requested })
      ? (requested ?? "cordis")
      : (visiblePresets.first(where: { $0.id == "cordis" })?.id ?? visiblePresets.first?.id ?? "cordis")
  }

  private var visiblePresets: [ArkAgentPreset] {
    model.agentPresetRoster?.presets.filter { $0.broken == nil } ?? []
  }

  private var selectedPresetLabel: String {
    let preset = model.agentPresetRoster?.presets.first { $0.id == selectedPresetID }
    return localizedPresetName(id: selectedPresetID, name: preset?.name)
  }

  var body: some View {
    GeometryReader { proxy in
      let contentWidth = min(760, max(360, proxy.size.width - 64))
      ZStack(alignment: .topTrailing) {
        VStack(spacing: 12) {
          Spacer()
          VStack(spacing: 22) {
            Image(nsImage: NSApp.applicationIconImage)
              .resizable()
              .scaledToFit()
              .frame(width: 80, height: 80)
            Text(ArkL10n.text(.newConversationHeroTitle, model.languagePreference))
              .font(.system(size: 44, weight: .semibold))
              .tracking(4)
          }
          Spacer()
          HStack(spacing: 8) {
            Button(action: chooseWorkspaceDirectory) {
              Label(
                model.selectedWorkspace?.title
                  ?? ArkL10n.text(.newConversationAddWorkspace, model.languagePreference),
                systemImage: "folder.badge.plus"
              )
                .font(.system(size: 12, weight: .medium))
                .padding(.horizontal, 10)
                .frame(height: 30)
                .background(ArkPalette.raised, in: Capsule())
                .overlay(Capsule().stroke(ArkPalette.border))
            }
            .buttonStyle(.plain)
            .help(ArkL10n.text(.newConversationWorkspaceHelp, model.languagePreference))

            Menu {
              if !visiblePresets.isEmpty {
                ForEach(visiblePresets) { preset in
                  Button {
                    model.selectAgentPresetForCurrentSession(preset.id)
                  } label: {
                    Label(
                      localizedPresetName(id: preset.id, name: preset.name),
                      systemImage: selectedPresetID == preset.id
                        ? "checkmark" : "person.crop.circle"
                    )
                  }
                }
              } else {
                Text(ArkL10n.text(.newConversationPresetUnavailable, model.languagePreference))
              }
            } label: {
              Label(
                selectedPresetLabel,
                systemImage: "point.3.connected.trianglepath.dotted"
              )
              .font(.system(size: 12, weight: .medium))
              .padding(.horizontal, 10)
              .frame(height: 30)
              .background(ArkPalette.raised, in: Capsule())
              .overlay(Capsule().stroke(ArkPalette.border))
            }
            .menuStyle(.borderlessButton)
            Spacer(minLength: 0)
          }
          .frame(width: contentWidth)

          NativeComposer(model: model, hero: true)
            .frame(width: contentWidth)
        }
        .padding(40)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)

      }
    }
  }

  private func chooseWorkspaceDirectory() {
    presentWorkspaceDirectoryPicker(for: model)
  }

  private func localizedPresetName(id: String, name: String?) -> String {
    ArkL10n.presetDisplayTitle(id: id, name: name, model.languagePreference)
  }
}

@MainActor
private func presentWorkspaceDirectoryPicker(for model: ArkAppModel) {
  let panel = NSOpenPanel()
  panel.canChooseFiles = false
  panel.canChooseDirectories = true
  panel.allowsMultipleSelection = false
  panel.prompt = ArkL10n.text(.newConversationAddWorkspace, model.languagePreference)
  guard panel.runModal() == .OK, let url = panel.url else { return }
  model.addWorkspace(path: url.path)
}

/// 聊天列底部固定布局常量：统计栏插槽的真实高度与 Toast 偏移共用同一组数值，
/// 不存在两套数字，字号/padding 改动不会让 Toast 压住统计行。
enum ArkChatLayoutResolver {
  static func transcriptWidth(
    availableWidth: CGFloat,
    preferredWidth: Double,
    adaptive: Bool
  ) -> CGFloat {
    let fitted = max(0, availableWidth - 56)
    let maximum = min(1_200, fitted)
    guard !adaptive else { return maximum }
    return min(maximum, max(520, CGFloat(preferredWidth)))
  }

  static func composerWidth(maximumWidth: CGFloat, transcriptWidth: CGFloat) -> CGFloat {
    min(maximumWidth, transcriptWidth)
  }
}

private enum ChatLayoutMetrics {
  static let contentColumnMaxWidth: CGFloat = 748
  static let composerMaxWidth: CGFloat = 764
  static let entrySpacing: CGFloat = 16
  static let messageFontSize: CGFloat = 16
  static let userBubbleMaxWidth: CGFloat = 525
  static let userBubbleCornerRadius: CGFloat = 22
  static let statsBarHeight: CGFloat = 28
  static let statsBarBottomInset: CGFloat = 8
  static let toastSpacing: CGFloat = 12
}

@MainActor
private struct NativeChatContext: Equatable {
  let sessionID: String?
  let sessionBlank: Bool
  let sessionRunning: Bool
  let hasOlderHistory: Bool
  let loadingOlderHistory: Bool
  let historyLoadState: ArkHistoryLoadState
  let steeringPrompts: [ArkQueuedPrompt]
  let language: ArkLanguagePreference
  let operationMessage: String?
  let feedbackAvailable: Bool
  let feedbackByID: [String: ArkMessageFeedback]
  let turnMetricsByTurn: [Int: ArkChatTurnMetrics]
  let turnUsageByTurn: [Int: ArkChatTurnUsage]
  let completedTurns: Set<Int>
  let forkSequenceByMessageID: [Int: Int]
  let latestAssistantMessageID: Int?

  init(model: ArkAppModel) {
    sessionID = model.selectedSessionID
    sessionBlank = model.selectedSession?.blank == true
    sessionRunning = model.selectedSession?.running == true
    hasOlderHistory = model.hasOlderHistory
    loadingOlderHistory = model.loadingOlderHistory
    historyLoadState = model.historyLoadState
    steeringPrompts = model.queuedPrompts.filter { $0.placement == .steering }
    language = model.languagePreference
    operationMessage = model.operationMessage
    feedbackAvailable = model.messageFeedbackAvailable
    feedbackByID = model.messageFeedbackByID
    turnMetricsByTurn = model.turnMetricsByTurn
    turnUsageByTurn = model.turnUsageByTurn
    completedTurns = model.completedTurnIDs
    latestAssistantMessageID = ArkStreamingPresentationPolicy.liveAssistantMessageID(
      messages: model.messages,
      currentTurn: model.latestStartedTurn,
      turnStartSequence: model.latestStartedTurnSequence,
      sessionRunning: sessionRunning
    )

    var latestAssistantByTurn: [Int: Int] = [:]
    for message in model.messages where message.role == .assistant {
      guard let turn = message.turn else { continue }
      latestAssistantByTurn[turn] = max(latestAssistantByTurn[turn] ?? Int.min, message.id)
    }
    var forkSequences: [Int: Int] = [:]
    for (turn, messageID) in latestAssistantByTurn {
      if let sequence = model.completedTurnSequence(turn) {
        forkSequences[messageID] = sequence
      }
    }
    forkSequenceByMessageID = forkSequences
  }

  func presentation(for message: ArkMessage) -> NativeMessagePresentation {
    NativeMessagePresentation(
      sessionID: sessionID,
      sessionRunning: sessionRunning,
      language: language,
      feedbackAvailable: feedbackAvailable,
      feedback: message.messageID.flatMap { feedbackByID[$0] },
      metrics: message.turn.flatMap { turnMetricsByTurn[$0] },
      forkSequence: forkSequenceByMessageID[message.id],
      isLatestAssistant: message.id == latestAssistantMessageID
    )
  }
}

private struct NativeMessagePresentation: Equatable {
  let sessionID: String?
  let sessionRunning: Bool
  let language: ArkLanguagePreference
  let feedbackAvailable: Bool
  let feedback: ArkMessageFeedback?
  let metrics: ArkChatTurnMetrics?
  let forkSequence: Int?
  let isLatestAssistant: Bool
}

struct NativeAssistantMarkdownSourceID: Hashable, Sendable {
  let messageID: Int
  let sourceSlot: Int

  var renderPath: String {
    "chat.message.\(messageID).source.\(sourceSlot)"
  }
}

struct NativeAssistantMarkdownSource: Equatable, Sendable {
  let id: NativeAssistantMarkdownSourceID
  let source: String

  var messageID: Int { id.messageID }
  var sourceSlot: Int { id.sourceSlot }
}

private enum NativeAssistantMarkdownProjectionPolicy {
  static func sources(
    message: ArkMessage,
    presentation: NativeMessagePresentation
  ) -> [NativeAssistantMarkdownSource] {
    guard message.role == .assistant,
          !ArkStreamingPresentationPolicy.usesStreamingAssistantPresentation(
            role: message.role,
            isLatestAssistant: presentation.isLatestAssistant,
            sessionRunning: presentation.sessionRunning
          )
    else { return [] }

    if message.blocks.isEmpty {
      guard !message.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
        return []
      }
      return [NativeAssistantMarkdownSource(
        id: NativeAssistantMarkdownSourceID(messageID: message.id, sourceSlot: 0),
        source: message.text
      )]
    }

    return message.blocks.enumerated().compactMap { index, block in
      guard case .text(let source) = block,
            !source.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      else { return nil }
      return NativeAssistantMarkdownSource(
        id: NativeAssistantMarkdownSourceID(messageID: message.id, sourceSlot: index),
        source: source
      )
    }
  }
}

struct NativeAssistantMarkdownProjectionRequest: Equatable, Sendable {
  let sessionID: String
  let epoch: UInt64
  let source: NativeAssistantMarkdownSource
  let token: UUID
}

struct NativeAssistantMarkdownProjectionReconcile: Equatable, Sendable {
  let sessionChanged: Bool
  let invalidatedSourceIDs: Set<NativeAssistantMarkdownSourceID>
}

struct NativeAssistantMarkdownProjectionState: Sendable {
  private(set) var sessionID: String?
  private(set) var epoch: UInt64 = 0
  private(set) var requestedSourcesByID: [
    NativeAssistantMarkdownSourceID: NativeAssistantMarkdownSource
  ] = [:]
  private(set) var installedSourceIDs = Set<NativeAssistantMarkdownSourceID>()
  private var requestTokens: [NativeAssistantMarkdownSourceID: UUID] = [:]
  private var readyByID: [NativeAssistantMarkdownSourceID: (
    request: NativeAssistantMarkdownProjectionRequest, blocks: [NativeGFMBlock]
  )] = [:]

  mutating func reconcile(
    sessionID: String?,
    requestedSources nextSources: [NativeAssistantMarkdownSource]
  ) -> NativeAssistantMarkdownProjectionReconcile {
    var nextSourcesByID: [NativeAssistantMarkdownSourceID: NativeAssistantMarkdownSource] = [:]
    for source in nextSources where nextSourcesByID[source.id] == nil {
      nextSourcesByID[source.id] = source
    }
    let sessionChanged = self.sessionID != sessionID
    var invalidatedSourceIDs = Set(requestedSourcesByID.keys).subtracting(nextSourcesByID.keys)
    for (id, source) in nextSourcesByID
    where requestedSourcesByID[id] != nil && requestedSourcesByID[id] != source {
      invalidatedSourceIDs.insert(id)
    }
    if sessionChanged {
      epoch &+= 1
      self.sessionID = sessionID
      invalidatedSourceIDs.formUnion(requestedSourcesByID.keys)
      requestTokens.removeAll()
      readyByID.removeAll()
      installedSourceIDs.removeAll()
    } else {
      for id in invalidatedSourceIDs {
        requestTokens.removeValue(forKey: id)
        readyByID.removeValue(forKey: id)
      }
      installedSourceIDs.subtract(invalidatedSourceIDs)
    }
    requestedSourcesByID = nextSourcesByID
    installedSourceIDs.formIntersection(nextSourcesByID.keys)
    return NativeAssistantMarkdownProjectionReconcile(
      sessionChanged: sessionChanged,
      invalidatedSourceIDs: invalidatedSourceIDs
    )
  }

  mutating func beginRequest(
    for source: NativeAssistantMarkdownSource
  ) -> NativeAssistantMarkdownProjectionRequest? {
    guard let sessionID,
          requestedSourcesByID[source.id] == source,
          !installedSourceIDs.contains(source.id),
          requestTokens[source.id] == nil
    else { return nil }
    let token = UUID()
    requestTokens[source.id] = token
    return NativeAssistantMarkdownProjectionRequest(
      sessionID: sessionID,
      epoch: epoch,
      source: source,
      token: token
    )
  }

  mutating func accept(_ request: NativeAssistantMarkdownProjectionRequest) -> Bool {
    guard sessionID == request.sessionID,
          epoch == request.epoch,
          requestedSourcesByID[request.source.id] == request.source,
          requestTokens[request.source.id] == request.token,
          installedSourceIDs.insert(request.source.id).inserted
    else { return false }
    requestTokens.removeValue(forKey: request.source.id)
    return true
  }

  /// Retain completions until the next presentation batch. Installation still
  /// checks the current session, source and request token when the batch drains.
  mutating func stage(_ blocks: [NativeGFMBlock], for request: NativeAssistantMarkdownProjectionRequest) {
    guard requestTokens[request.source.id] == request.token else { return }
    readyByID[request.source.id] = (request, blocks)
  }

  mutating func takeReadyBlocks() -> [NativeAssistantMarkdownSourceID: [NativeGFMBlock]] {
    let ready = readyByID
    readyByID.removeAll(keepingCapacity: true)
    var installed: [NativeAssistantMarkdownSourceID: [NativeGFMBlock]] = [:]
    for (id, result) in ready where accept(result.request) {
      installed[id] = result.blocks
    }
    return installed
  }

  @discardableResult
  mutating func cancel(_ request: NativeAssistantMarkdownProjectionRequest) -> Bool {
    guard requestTokens[request.source.id] == request.token else { return false }
    requestTokens.removeValue(forKey: request.source.id)
    readyByID.removeValue(forKey: request.source.id)
    return true
  }
}

@MainActor
private struct NativeChatSnapshot {
  let entries: [NativeChatEntry]
  let context: NativeChatContext
  let contentRevision: UInt64
  let markdownBlocksBySourceID: [NativeAssistantMarkdownSourceID: [NativeGFMBlock]]

  init(
    model: ArkAppModel,
    entries: [NativeChatEntry],
    contentRevision: UInt64,
    markdownBlocksBySourceID: [NativeAssistantMarkdownSourceID: [NativeGFMBlock]] = [:]
  ) {
    self.entries = entries
    context = NativeChatContext(model: model)
    self.contentRevision = contentRevision
    self.markdownBlocksBySourceID = markdownBlocksBySourceID
  }

  private init(
    entries: [NativeChatEntry],
    context: NativeChatContext,
    contentRevision: UInt64,
    markdownBlocksBySourceID: [NativeAssistantMarkdownSourceID: [NativeGFMBlock]]
  ) {
    self.entries = entries
    self.context = context
    self.contentRevision = contentRevision
    self.markdownBlocksBySourceID = markdownBlocksBySourceID
  }

  func installing(
    _ blocks: [NativeAssistantMarkdownSourceID: [NativeGFMBlock]]
  ) -> NativeChatSnapshot {
    var projected = markdownBlocksBySourceID
    projected.merge(blocks) { _, new in new }
    return NativeChatSnapshot(
      entries: entries,
      context: context,
      contentRevision: contentRevision &+ 1,
      markdownBlocksBySourceID: projected
    )
  }

  func hasSamePresentation(as other: NativeChatSnapshot) -> Bool {
    entries == other.entries
      && context == other.context
      && contentRevision == other.contentRevision
  }
}

private struct NativeChatSessionFeedState: Equatable {
  let id: String?
  let blank: Bool
  let running: Bool
}

@MainActor
private final class NativeChatTranscriptFeed: ObservableObject {
  @Published private(set) var snapshot: NativeChatSnapshot
  private var cancellables = Set<AnyCancellable>()
  private var markdownProjectionState = NativeAssistantMarkdownProjectionState()
  private var markdownTasks: [NativeAssistantMarkdownSourceID: Task<Void, Never>] = [:]
  private var markdownPublishTask: Task<Void, Never>?

  init(model: ArkAppModel) {
    snapshot = NativeChatSnapshot(
      model: model,
      entries: NativeChatEntry.merge(
        messages: model.messages,
        tools: model.toolActivities,
        statuses: model.chatStatuses,
        producedFiles: model.producedFiles
      ),
      contentRevision: 0
    )

    let triggers: [AnyPublisher<Void, Never>] = [
      model.chatPresentationDidChange.eraseToAnyPublisher(),
      model.$selectedSessionID.removeDuplicates().map { _ in () }.eraseToAnyPublisher(),
      model.$sessions.map { [weak model] sessions in
        let id = model?.selectedSessionID
        let selected = sessions.first { $0.id == id }
        return NativeChatSessionFeedState(
          id: id,
          blank: selected?.blank == true,
          running: selected?.running == true
        )
      }.removeDuplicates().map { _ in () }.eraseToAnyPublisher(),
      model.$hasOlderHistory.removeDuplicates().map { _ in () }.eraseToAnyPublisher(),
      model.$loadingOlderHistory.removeDuplicates().map { _ in () }.eraseToAnyPublisher(),
      model.$historyLoadState.removeDuplicates().map { _ in () }.eraseToAnyPublisher(),
      model.$queuedPrompts.removeDuplicates().map { _ in () }.eraseToAnyPublisher(),
      model.$languagePreference.removeDuplicates().map { _ in () }.eraseToAnyPublisher(),
      model.$operationMessage.removeDuplicates().map { _ in () }.eraseToAnyPublisher(),
      model.$messageFeedbackAvailable.removeDuplicates().map { _ in () }.eraseToAnyPublisher(),
      model.$messageFeedbackByID.removeDuplicates().map { _ in () }.eraseToAnyPublisher(),
    ]
    Publishers.MergeMany(triggers)
    .throttle(for: .milliseconds(100), scheduler: RunLoop.main, latest: true)
    .sink { [weak self, weak model] _ in
      guard let self, let model else { return }
      let entries = NativeChatEntry.merge(
        messages: model.messages,
        tools: model.toolActivities,
        statuses: model.chatStatuses,
        producedFiles: model.producedFiles
      )
      let reconciliation = reconcileMarkdownSources(model: model)
      let retainedMarkdown = reconciliation.sessionChanged
        ? [:]
        : snapshot.markdownBlocksBySourceID.filter {
          self.markdownProjectionState.installedSourceIDs.contains($0.key)
        }
      let projectionRemoved = retainedMarkdown.count != snapshot.markdownBlocksBySourceID.count
      let revision = entries == snapshot.entries && !projectionRemoved
        ? snapshot.contentRevision
        : snapshot.contentRevision &+ 1
      let next = NativeChatSnapshot(
        model: model,
        entries: entries,
        contentRevision: revision,
        markdownBlocksBySourceID: retainedMarkdown
      )
      if !snapshot.hasSamePresentation(as: next) { snapshot = next }
      scheduleMissingMarkdownSources()
    }
    .store(in: &cancellables)

    _ = reconcileMarkdownSources(model: model)
    scheduleMissingMarkdownSources()
  }

  deinit {
    markdownPublishTask?.cancel()
    for task in markdownTasks.values { task.cancel() }
  }

  private func reconcileMarkdownSources(
    model: ArkAppModel
  ) -> NativeAssistantMarkdownProjectionReconcile {
    let context = NativeChatContext(model: model)
    let nextSources = model.messages.flatMap { message in
      NativeAssistantMarkdownProjectionPolicy.sources(
        message: message,
        presentation: context.presentation(for: message)
      )
    }
    let reconciliation = markdownProjectionState.reconcile(
      sessionID: model.selectedSessionID,
      requestedSources: nextSources
    )
    if reconciliation.sessionChanged {
      markdownPublishTask?.cancel()
      markdownPublishTask = nil
      for task in markdownTasks.values { task.cancel() }
      markdownTasks.removeAll()
    } else {
      for id in reconciliation.invalidatedSourceIDs {
        markdownTasks.removeValue(forKey: id)?.cancel()
      }
    }
    return reconciliation
  }

  private func scheduleMissingMarkdownSources() {
    for source in markdownProjectionState.requestedSourcesByID.values
    where snapshot.markdownBlocksBySourceID[source.id] == nil
      && markdownTasks[source.id] == nil
    {
      guard let request = markdownProjectionState.beginRequest(for: source) else { continue }
      markdownTasks[source.id] = Task { [weak self] in
        guard !Task.isCancelled else {
          self?.cancelMarkdownRequest(request)
          return
        }
        let blocks = await NativeGFMParseWorker.shared.blocks(for: source.source)
        guard !Task.isCancelled, let blocks, let self else {
          self?.cancelMarkdownRequest(request)
          return
        }
        markdownProjectionState.stage(blocks, for: request)
        markdownTasks.removeValue(forKey: source.id)
        scheduleMarkdownPublication()
      }
    }
  }

  private func scheduleMarkdownPublication() {
    guard markdownPublishTask == nil else { return }
    markdownPublishTask = Task { [weak self] in
      try? await Task.sleep(nanoseconds: 16_000_000)
      guard !Task.isCancelled, let self else { return }
      markdownPublishTask = nil
      let ready = markdownProjectionState.takeReadyBlocks()
      guard !ready.isEmpty else { return }
      var transaction = Transaction(animation: nil)
      transaction.disablesAnimations = true
      withTransaction(transaction) {
        self.snapshot = self.snapshot.installing(ready)
      }
    }
  }

  private func cancelMarkdownRequest(_ request: NativeAssistantMarkdownProjectionRequest) {
    guard markdownProjectionState.cancel(request) else { return }
    markdownTasks.removeValue(forKey: request.source.id)
  }
}

struct NativeAssistantMarkdownBlockRow: Identifiable, Equatable {
  struct ID: Hashable {
    let sourceID: NativeAssistantMarkdownSourceID
    let blockIndex: Int
  }

  let sourceID: NativeAssistantMarkdownSourceID
  let blockIndex: Int
  let block: NativeGFMBlock

  var id: ID { ID(sourceID: sourceID, blockIndex: blockIndex) }
  var renderPath: String { "\(sourceID.renderPath).block.\(blockIndex)" }
}

enum NativeAssistantProjectedBodyRow: Identifiable, Equatable {
  enum ID: Hashable {
    case pending(NativeAssistantMarkdownSourceID)
    case markdown(NativeAssistantMarkdownBlockRow.ID)
    case companion(messageID: Int, blockIndex: Int)
  }

  case pending(NativeAssistantMarkdownSourceID)
  case markdown(NativeAssistantMarkdownBlockRow)
  case companion(messageID: Int, blockIndex: Int, block: ArkMessageBlock)

  var id: ID {
    switch self {
    case .pending(let sourceID): return .pending(sourceID)
    case .markdown(let row): return .markdown(row.id)
    case .companion(let messageID, let blockIndex, _):
      return .companion(messageID: messageID, blockIndex: blockIndex)
    }
  }

  /// Constant-size, source-free outer identity (R18). Used by
  /// ``NativeChatDisplayEntry.assistantMarkdownRow``.
  var renderKey: String {
    switch self {
    case .pending(let sourceID): return "pending-\(sourceID.messageID)-\(sourceID.sourceSlot)"
    case .markdown(let row):
      return "md-\(row.sourceID.messageID)-\(row.sourceID.sourceSlot)-\(row.blockIndex)"
    case .companion(let messageID, let blockIndex, _):
      return "companion-\(messageID)-\(blockIndex)"
    }
  }
}

enum NativeAssistantMarkdownRowProjection {
  static func rows(
    message: ArkMessage,
    sources: [NativeAssistantMarkdownSource],
    blocksBySourceID: [NativeAssistantMarkdownSourceID: [NativeGFMBlock]]
  ) -> [NativeAssistantProjectedBodyRow] {
    var sourceBySlot: [Int: NativeAssistantMarkdownSource] = [:]
    for source in sources { sourceBySlot[source.sourceSlot] = source }
    var rows: [NativeAssistantProjectedBodyRow] = []
    func appendMarkdownRows(for source: NativeAssistantMarkdownSource) {
      guard let blocks = blocksBySourceID[source.id] else {
        rows.append(.pending(source.id))
        return
      }
      rows.append(contentsOf: blocks.indices.map { blockIndex in
        .markdown(NativeAssistantMarkdownBlockRow(
          sourceID: source.id,
          blockIndex: blockIndex,
          block: blocks[blockIndex]
        ))
      })
    }

    if message.blocks.isEmpty {
      if let source = sourceBySlot[0] { appendMarkdownRows(for: source) }
      return rows
    }
    for (blockIndex, block) in message.blocks.enumerated() {
      if case .text = block, let source = sourceBySlot[blockIndex] {
        appendMarkdownRows(for: source)
      } else {
        rows.append(.companion(
          messageID: message.id,
          blockIndex: blockIndex,
          block: block
        ))
      }
    }
    return rows
  }
}

enum NativeAssistantMarkdownPrefixPolicy {
  static func hasContent(
    hasDocuments: Bool,
    hasLegacyAttachments: Bool,
    hasVisibleLegacyReasoning: Bool
  ) -> Bool {
    hasDocuments || hasLegacyAttachments || hasVisibleLegacyReasoning
  }
}

private struct NativeAssistantMarkdownPrefixRow: Identifiable, Equatable {
  let message: ArkMessage
  let presentation: NativeMessagePresentation
  let hideReasoning: Bool

  var id: String { "assistant-prefix-\(message.id)" }
  var turn: Int? { message.turn }
}

private struct NativeAssistantMarkdownBodyContext: Equatable {
  let turn: Int?
  let producedFilePaths: [String]
  let language: ArkLanguagePreference
  let hideReasoning: Bool
}

private struct NativeAssistantMarkdownBodyDisplayRow: Identifiable, Equatable {
  let context: NativeAssistantMarkdownBodyContext
  let row: NativeAssistantProjectedBodyRow

  var id: String { "assistant-\(row.renderKey)" }
  var turn: Int? { context.turn }
}

private struct NativeAssistantMarkdownSuffixRow: Identifiable, Equatable {
  let message: ArkMessage
  let producedFiles: [ArkProducedFile]
  let presentation: NativeMessagePresentation

  var id: String { "assistant-suffix-\(message.id)" }
  var turn: Int? { message.turn }
}

enum NativeAssistantMarkdownFlatRow: Identifiable, Equatable {
  enum ID: Hashable {
    case prefix(messageID: Int)
    case body(NativeAssistantProjectedBodyRow.ID)
    case suffix(messageID: Int)
  }

  case prefix(messageID: Int)
  case body(NativeAssistantProjectedBodyRow)
  case suffix(messageID: Int)

  var id: ID {
    switch self {
    case .prefix(let messageID): return .prefix(messageID: messageID)
    case .body(let row): return .body(row.id)
    case .suffix(let messageID): return .suffix(messageID: messageID)
    }
  }
}

enum NativeAssistantMarkdownFlatProjection {
  static func rows(
    messageID: Int,
    hasPrefix: Bool,
    bodyRows: [NativeAssistantProjectedBodyRow]
  ) -> [NativeAssistantMarkdownFlatRow] {
    var rows: [NativeAssistantMarkdownFlatRow] = []
    rows.reserveCapacity(bodyRows.count + (hasPrefix ? 2 : 1))
    if hasPrefix { rows.append(.prefix(messageID: messageID)) }
    rows.append(contentsOf: bodyRows.map(NativeAssistantMarkdownFlatRow.body))
    rows.append(.suffix(messageID: messageID))
    return rows
  }
}

private enum NativeChatDisplayEntry: Identifiable, Equatable {
  case process(NativeChatProcess)
  case entry(NativeChatEntry)
  case assistantPrefix(NativeAssistantMarkdownPrefixRow)
  case assistantMarkdownRow(NativeAssistantMarkdownBodyDisplayRow)
  case assistantSuffix(NativeAssistantMarkdownSuffixRow)
  case usage(turn: Int, usage: ArkChatTurnUsage)

  var id: String {
    switch self {
    case .process(let process): return process.id
    case .entry(let entry): return entry.id
    case .assistantPrefix(let row): return row.id
    case .assistantMarkdownRow(let row): return row.id
    case .assistantSuffix(let row): return row.id
    case .usage(let turn, _): return "turn-usage-\(turn)"
    }
  }

  var turn: Int? {
    switch self {
    case .process(let process): return process.turn
    case .entry(let entry): return entry.turn
    case .assistantPrefix(let row): return row.turn
    case .assistantMarkdownRow(let row): return row.turn
    case .assistantSuffix(let row): return row.turn
    case .usage(let turn, _): return turn
    }
  }
}

private struct NativeChatProcess: Identifiable, Equatable {
  let turn: Int
  let generation: String
  let anchorEntryID: String
  let hiddenEntryIDs: Set<String>
  let detailEntries: [NativeChatEntry]
  let reasoningText: String?
  let messageCount: Int
  let toolCallCount: Int
  let subagentCount: Int

  var id: String { "turn-process-\(generation)" }
}

private struct NativeChatTurnNavigationItem: Identifiable, Equatable {
  let turn: Int
  let title: String
  let detail: String
  let completed: Bool
  let interrupted: Bool

  var id: Int { turn }
}

private struct NativeChatBodyProjection {
  let displayEntries: [NativeChatDisplayEntry]
  let turnAnchorByTurn: [Int: String]
  let navigationItems: [NativeChatTurnNavigationItem]
  let finalAnswerByTurn: [Int: String]
}

struct NativeChatProjectionKey: Equatable {
  let contentRevision: UInt64
  let sessionID: String?
  let sessionRunning: Bool
  let language: ArkLanguagePreference
  let feedbackAvailable: Bool
  let feedbackByID: [String: ArkMessageFeedback]
  let turnMetricsByTurn: [Int: ArkChatTurnMetrics]
  let turnUsageByTurn: [Int: ArkChatTurnUsage]
  let completedTurns: Set<Int>
  let forkSequenceByMessageID: [Int: Int]
  let latestAssistantMessageID: Int?
  let compactProcess: Bool
}

/// Memoizes a pure projection without publishing a SwiftUI state mutation.
/// Writing `@State` while `body` is being evaluated re-invalidates the same
/// view graph and can turn a large lazy transcript into a permanent update
/// transaction. This reference cache changes only its own private storage.
@MainActor
final class NativeProjectionMemo<Key: Equatable, Value>: ObservableObject {
  private var cached: (key: Key, value: Value)?

  func value(for key: Key, build: () -> Value) -> Value {
    if let cached, cached.key == key { return cached.value }
    let value = build()
    cached = (key, value)
    return value
  }
}

/// Associates an ordinary user prompt with one durable turn. User messages
/// created immediately before `turn/start` may deliberately omit the repeated
/// turn field, so the nearest prompt inside the previous/current boundaries is
/// the fallback after an explicitly tagged prompt.
enum ArkChatTurnNavigationProjection {
  static func prompt(
    for turn: Int,
    firstTurnSequence: Int,
    after previousTurnSequence: Int?,
    messages: [ArkMessage]
  ) -> ArkMessage? {
    let ordinary = messages.filter {
      $0.role == .user && ($0.sourceKind == nil || $0.sourceKind == "user")
    }
    if let explicit = ordinary.first(where: { $0.turn == turn }) { return explicit }
    let lower = previousTurnSequence ?? Int.min
    return ordinary.last {
      $0.turn == nil && $0.id > lower && $0.id <= firstTurnSequence
    }
  }
}

private struct NativeChatView: View {
  let model: ArkAppModel
  @StateObject private var transcriptFeed: NativeChatTranscriptFeed
  @ObservedObject private var scrollController: ArkChatScrollController
  @AppStorage("ark.native.chat.font-size") private var transcriptFontSize = Double(ChatLayoutMetrics.messageFontSize)
  @AppStorage("ark.native.chat.content-width") private var contentWidth = Double(ChatLayoutMetrics.contentColumnMaxWidth)
  @AppStorage("ark.native.chat.content-width-adaptive") private var contentWidthAdaptive = true
  @AppStorage("ark.native.chat.compact-process") private var compactProcess = true
  @State private var expandedProcessGenerations = Set<String>()

  init(
    model: ArkAppModel,
    scrollController: ArkChatScrollController
  ) {
    self.model = model
    _transcriptFeed = StateObject(wrappedValue: NativeChatTranscriptFeed(model: model))
    _scrollController = ObservedObject(wrappedValue: scrollController)
  }

  private var entries: [NativeChatEntry] { transcriptFeed.snapshot.entries }
  private var context: NativeChatContext { transcriptFeed.snapshot.context }
  private var contentRevision: UInt64 { transcriptFeed.snapshot.contentRevision }
  private var fontSize: CGFloat { min(24, max(12, CGFloat(transcriptFontSize))) }

  /// The projection is O(turns x text), so reuse it across unrelated body
  /// evaluations. The memo is reference-only and does not publish a state
  /// mutation from inside `bodyProjection`.
  @StateObject private var projectionMemo = NativeProjectionMemo<
    NativeChatProjectionKey, NativeChatBodyProjection
  >()

  private var bodyProjection: NativeChatBodyProjection {
    projectionMemo.value(for: NativeChatProjectionKey(
      contentRevision: contentRevision,
      sessionID: context.sessionID,
      sessionRunning: context.sessionRunning,
      language: context.language,
      feedbackAvailable: context.feedbackAvailable,
      feedbackByID: context.feedbackByID,
      turnMetricsByTurn: context.turnMetricsByTurn,
      turnUsageByTurn: context.turnUsageByTurn,
      completedTurns: context.completedTurns,
      forkSequenceByMessageID: context.forkSequenceByMessageID,
      latestAssistantMessageID: context.latestAssistantMessageID,
      compactProcess: compactProcess
    )) {
      computeBodyProjection()
    }
  }

  private func computeBodyProjection() -> NativeChatBodyProjection {
    var finalAnswerByTurn: [Int: String] = [:]
    var entriesByTurn: [Int: [NativeChatEntry]] = [:]
    var entryByID: [String: NativeChatEntry] = [:]
    var firstSequenceByTurn: [Int: Int] = [:]
    var lastSequenceByTurn: [Int: Int] = [:]
    var explicitPromptByTurn: [Int: ArkMessage] = [:]
    var untaggedPrompts: [ArkMessage] = []
    var answerByTurn: [Int: ArkMessage] = [:]

    for entry in entries {
      entryByID[entry.id] = entry
      if let turn = entry.turn {
        entriesByTurn[turn, default: []].append(entry)
        firstSequenceByTurn[turn] = min(firstSequenceByTurn[turn] ?? entry.sequence, entry.sequence)
        lastSequenceByTurn[turn] = max(lastSequenceByTurn[turn] ?? entry.sequence, entry.sequence)
        if entry.isFinalAssistantAnswer, context.completedTurns.contains(turn) {
          finalAnswerByTurn[turn] = entry.id
        }
      }

      guard case .message(let message, _) = entry else { continue }
      if message.role == .user, message.sourceKind == nil || message.sourceKind == "user" {
        if let turn = message.turn {
          if explicitPromptByTurn[turn] == nil { explicitPromptByTurn[turn] = message }
        } else {
          untaggedPrompts.append(message)
        }
      }
      if message.role == .assistant, let turn = message.turn {
        answerByTurn[turn] = message
      }
    }

    var processByTurn: [Int: NativeChatProcess] = [:]
    if compactProcess {
      for (turn, answerID) in finalAnswerByTurn {
        guard let answer = entryByID[answerID]
        else { continue }
        let processEntries = (entriesByTurn[turn] ?? []).filter {
          $0.sequence < answer.sequence && $0.isProcessDetail
        }
        let reasoningText = answer.assistantReasoning
        guard !processEntries.isEmpty || reasoningText != nil else { continue }
        let anchorEntryID = processEntries.first?.id ?? answer.id
        let hiddenIDs = Set(processEntries.map(\.id))
        let messageCount = processEntries.reduce(into: 0) { result, entry in
          if entry.isAssistantMessage { result += 1 }
        }
        let toolCallCount = processEntries.reduce(into: 0) { result, entry in
          if entry.isToolEntry { result += entry.toolCount }
        }
        let subagentCount = processEntries.reduce(into: 0) { result, entry in
          if entry.isSubagentEntry { result += entry.toolCount }
        }
        processByTurn[turn] = NativeChatProcess(
          turn: turn,
          generation: "\(turn)|\(answerID)",
          anchorEntryID: anchorEntryID,
          hiddenEntryIDs: hiddenIDs,
          detailEntries: processEntries,
          reasoningText: reasoningText,
          messageCount: messageCount,
          toolCallCount: toolCallCount,
          subagentCount: subagentCount
        )
      }
    }

    var displayEntries: [NativeChatDisplayEntry] = []
    var turnAnchorByTurn: [Int: String] = [:]
    var navigationTurns = Set<Int>()
    displayEntries.reserveCapacity(entries.count + processByTurn.count + context.turnUsageByTurn.count)
    func appendDisplayEntry(_ item: NativeChatDisplayEntry) {
      displayEntries.append(item)
      guard let turn = item.turn else { return }
      navigationTurns.insert(turn)
      if turnAnchorByTurn[turn] == nil { turnAnchorByTurn[turn] = item.id }
    }

    for entry in entries {
      if let turn = entry.turn, let process = processByTurn[turn] {
        if entry.id == process.anchorEntryID {
          appendDisplayEntry(.process(process))
        }
        if process.hiddenEntryIDs.contains(entry.id) {
          continue
        }
      }
      for projected in projectedDisplayRows(
        entry,
        finalAnswerByTurn: finalAnswerByTurn
      ) {
        appendDisplayEntry(projected)
      }
      if let turn = entry.turn,
         finalAnswerByTurn[turn] == entry.id,
         let usage = context.turnUsageByTurn[turn]
      {
        appendDisplayEntry(.usage(turn: turn, usage: usage))
      }
    }

    var navigationItems: [NativeChatTurnNavigationItem] = []
    navigationItems.reserveCapacity(navigationTurns.count)
    var previousTurnSequence: Int?
    var untaggedPromptIndex = 0
    for turn in navigationTurns.sorted() {
      let lowerSequence = previousTurnSequence ?? Int.min
      let firstSequence = firstSequenceByTurn[turn] ?? Int.max
      var untaggedPrompt: ArkMessage?
      while untaggedPromptIndex < untaggedPrompts.count,
            untaggedPrompts[untaggedPromptIndex].id <= firstSequence
      {
        let candidate = untaggedPrompts[untaggedPromptIndex]
        if candidate.id > lowerSequence { untaggedPrompt = candidate }
        untaggedPromptIndex += 1
      }
      let prompt = explicitPromptByTurn[turn] ?? untaggedPrompt
      let answer = answerByTurn[turn]
      let turnLabel = ArkL10n.format(.trajectoryTurn, context.language, arguments: [String(turn)])
      let title = navigationTitle(prompt?.text, fallback: turnLabel)
      let detail = navigationDetail(
        answer?.text,
        fallback: ArkL10n.text(.trajectoryPending, context.language)
      )
      navigationItems.append(NativeChatTurnNavigationItem(
        turn: turn,
        title: title,
        detail: detail,
        completed: context.completedTurns.contains(turn),
        interrupted: answer?.interrupted == true
      ))
      previousTurnSequence = lastSequenceByTurn[turn] ?? previousTurnSequence
    }

    return NativeChatBodyProjection(
      displayEntries: displayEntries,
      turnAnchorByTurn: turnAnchorByTurn,
      navigationItems: navigationItems,
      finalAnswerByTurn: finalAnswerByTurn
    )
  }

  private func projectedDisplayRows(
    _ entry: NativeChatEntry,
    finalAnswerByTurn: [Int: String]
  ) -> [NativeChatDisplayEntry] {
    guard case .message(let message, let producedFiles) = entry,
          message.role == .assistant
    else { return [.entry(entry)] }
    let presentation = context.presentation(for: message)
    let sources = NativeAssistantMarkdownProjectionPolicy.sources(
      message: message,
      presentation: presentation
    )
    guard !sources.isEmpty else { return [.entry(entry)] }

    let rows = NativeAssistantMarkdownRowProjection.rows(
      message: message,
      sources: sources,
      blocksBySourceID: transcriptFeed.snapshot.markdownBlocksBySourceID
    )
    let hideReasoning = hidesFinalReasoning(
      entry,
      finalAnswerByTurn: finalAnswerByTurn
    )
    let hasPrefix = NativeAssistantMarkdownPrefixPolicy.hasContent(
      hasDocuments: !message.documentReferences.isEmpty,
      hasLegacyAttachments: !message.attachmentIDs.isEmpty && message.blocks.isEmpty,
      hasVisibleLegacyReasoning: message.blocks.isEmpty
        && !hideReasoning
        && !(message.reasoning?.isEmpty ?? true)
    )
    let bodyContext = NativeAssistantMarkdownBodyContext(
      turn: message.turn,
      producedFilePaths: producedFiles.map(\.path),
      language: presentation.language,
      hideReasoning: hideReasoning
    )
    return NativeAssistantMarkdownFlatProjection.rows(
      messageID: message.id,
      hasPrefix: hasPrefix,
      bodyRows: rows
    ).map { row in
      switch row {
      case .prefix:
        return .assistantPrefix(NativeAssistantMarkdownPrefixRow(
          message: message,
          presentation: presentation,
          hideReasoning: hideReasoning
        ))
      case .body(let bodyRow):
        return .assistantMarkdownRow(NativeAssistantMarkdownBodyDisplayRow(
          context: bodyContext,
          row: bodyRow
        ))
      case .suffix:
        return .assistantSuffix(NativeAssistantMarkdownSuffixRow(
          message: message,
          producedFiles: producedFiles,
          presentation: presentation
        ))
      }
    }
  }

  private func navigationTitle(_ text: String?, fallback: String) -> String {
    guard let text else { return fallback }
    let normalized = text
      .split(whereSeparator: \.isWhitespace)
      .map(String.init)
      .joined(separator: " ")
    guard !normalized.isEmpty else { return fallback }
    return normalized.count > 120 ? String(normalized.prefix(119)) + "…" : normalized
  }

  private func navigationDetail(_ text: String?, fallback: String) -> String {
    guard let text else { return fallback }
    let lines = text.components(separatedBy: .newlines).compactMap { raw -> String? in
      var line = raw.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !line.isEmpty else { return nil }
      while line.hasPrefix("#") { line.removeFirst() }
      line = line.trimmingCharacters(in: .whitespaces)
      if line.hasPrefix("- ") || line.hasPrefix("* ") {
        line = "• " + String(line.dropFirst(2))
      }
      return line.isEmpty ? nil : line
    }
    let normalized = lines.prefix(8).joined(separator: "\n")
    guard !normalized.isEmpty else { return fallback }
    return normalized.count > 520 ? String(normalized.prefix(519)) + "…" : normalized
  }

  var body: some View {
    let projection = bodyProjection

    GeometryReader { geometry in
      let transcriptWidth = ArkChatLayoutResolver.transcriptWidth(
        availableWidth: geometry.size.width,
        preferredWidth: contentWidth,
        adaptive: contentWidthAdaptive
      )

      VStack(spacing: 0) {
        ScrollViewReader { proxy in
          ZStack(alignment: .leading) {
            ScrollView {
              if entries.isEmpty {
                VStack(spacing: 10) {
                  if context.sessionBlank, !context.sessionRunning {
                    Image(nsImage: NSApp.applicationIconImage)
                      .resizable()
                      .scaledToFit()
                      .frame(width: 28, height: 28)
                    Text(ArkL10n.text(.newConversation, context.language))
                      .font(.system(size: 14, weight: .medium))
                  } else if context.sessionRunning {
                    ProgressView()
                    Text(ArkL10n.text(.chatReceivingReply, context.language))
                      .font(.system(size: 12))
                      .foregroundStyle(ArkPalette.secondary)
                  } else {
                    switch context.historyLoadState {
                    case .loading:
                      ProgressView()
                      Text(ArkL10n.text(.chatSyncingHistory, context.language))
                        .font(.system(size: 12))
                        .foregroundStyle(ArkPalette.secondary)
                    case .failed(let message):
                      Image(systemName: "exclamationmark.triangle")
                        .foregroundStyle(Color.orange)
                      Text(ArkL10n.text(.chatHistoryFailed, context.language))
                        .font(.system(size: 12, weight: .medium))
                      Text(message)
                        .font(.system(size: 10))
                        .foregroundStyle(ArkPalette.secondary)
                        .lineLimit(3)
                      Button(ArkL10n.text(.chatHistoryRetry, context.language)) {
                        Task { await model.refreshHistory(resetPaging: true) }
                      }
                      .buttonStyle(.borderless)
                      .accessibilityIdentifier("ark.chat.history.retry")
                    case .idle, .loaded:
                      Image(systemName: "bubble.left.and.bubble.right")
                        .foregroundStyle(ArkPalette.secondary)
                      Text(ArkL10n.text(.chatHistoryEmpty, context.language))
                        .font(.system(size: 12))
                        .foregroundStyle(ArkPalette.secondary)
                    }
                  }
                }
                .frame(maxWidth: .infinity)
                .padding(.top, 80)
              } else {
                LazyVStack(alignment: .leading, spacing: ChatLayoutMetrics.entrySpacing) {
                  if context.hasOlderHistory {
                    Button {
                      let anchor = scrollController.capturePrependAnchor()
                      Task {
                        await model.loadOlderHistory()
                        DispatchQueue.main.async {
                          scrollController.contentDidChange()
                          if let anchor { scrollController.restoreAfterPrepend(anchor) }
                        }
                      }
                    } label: {
                      HStack(spacing: 7) {
                        if context.loadingOlderHistory { ProgressView().controlSize(.small) }
                        Text(ArkL10n.text(
                          context.loadingOlderHistory ? .chatLoadingOlder : .chatLoadOlder,
                          context.language
                        ))
                      }
                      .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderless)
                    .disabled(context.loadingOlderHistory)
                  }
                  ForEach(projection.displayEntries) { item in
                    transcriptRow(
                      item,
                      fontSize: fontSize,
                      finalAnswerByTurn: projection.finalAnswerByTurn,
                      scrollID: scrollID(
                        for: item,
                        turnAnchorByTurn: projection.turnAnchorByTurn
                      )
                    )
                  }
                  ForEach(context.steeringPrompts) { item in
                    HStack {
                      Spacer(minLength: 100)
                      Text(item.text ?? ArkL10n.text(.queuePendingNonText, context.language))
                        .font(.system(size: fontSize))
                        .padding(.horizontal, 16)
                        .padding(.vertical, 10)
                        .frame(maxWidth: 525, alignment: .leading)
                        .background(ArkPalette.bubble, in: RoundedRectangle(cornerRadius: 22))
                    }
                    .accessibilityIdentifier("ark.queue.steering.\(item.id)")
                  }
                  Color.clear
                    .frame(height: 1)
                    .id("chat-bottom")
                }
                .frame(maxWidth: transcriptWidth)
                .padding(.horizontal, 28)
                .padding(.vertical, 24)
                .frame(maxWidth: .infinity, alignment: .center)
              }
              ArkChatScrollAttachment(controller: scrollController)
                .frame(width: 0, height: 0)
            }
            .overlay(alignment: .bottomTrailing) {
              if !scrollController.isAtBottom && !entries.isEmpty {
                Button {
                  scrollController.scrollBottom()
                } label: {
                  Image(systemName: "arrow.down")
                    .frame(width: 30, height: 30)
                    .background(ArkPalette.raised, in: Circle())
                    .overlay(Circle().stroke(ArkPalette.border))
                }
                .buttonStyle(.plain)
                .padding(14)
                .help(ArkL10n.text(.backToLatest, context.language))
              }
            }

            if projection.navigationItems.count > 1 {
              NativeChatTurnNavigationRail(
                items: projection.navigationItems,
                language: context.language,
                navigate: { turn in
                  withAnimation(.easeInOut(duration: 0.16)) {
                    proxy.scrollTo("ark.chat.turn.\(turn)", anchor: .center)
                  }
                }
              )
              .padding(.leading, 8)
              .padding(.vertical, 12)
            }
          }
          .onAppear {
            if let sessionID = context.sessionID {
              DispatchQueue.main.async { scrollController.activate(sessionID: sessionID) }
            }
          }
          .onChange(of: context.sessionID) { sessionID in
            expandedProcessGenerations.removeAll()
            guard let sessionID else { return }
            scrollController.beginSessionTransition(to: sessionID)
            DispatchQueue.main.async {
              scrollController.completeSessionTransition()
            }
          }
          .onChange(of: contentRevision) { _ in
            DispatchQueue.main.async { scrollController.contentDidChange() }
          }
        }
        NativeComposer(model: model)
          .frame(maxWidth: ArkChatLayoutResolver.composerWidth(
            maximumWidth: ChatLayoutMetrics.composerMaxWidth,
            transcriptWidth: transcriptWidth
          ))
          .padding(.horizontal, 20)
          .padding(.top, 6)
          .frame(maxWidth: .infinity)
        NativeSessionStatsBar(model: model)
          .frame(height: ChatLayoutMetrics.statsBarHeight)
          .frame(maxWidth: transcriptWidth)
          .padding(.horizontal, 20)
          .padding(.bottom, ChatLayoutMetrics.statsBarBottomInset)
          .frame(maxWidth: .infinity)
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .overlay(alignment: .bottom) {
        // 真 overlay：不参与 VStack 布局、不改变 contentHeight；
        // 固定偏移 = 统计行占用高度 + 间距，出现/消失不触发滚动重定位。
        if let message = context.operationMessage {
          Text(message)
            .font(.system(size: 12, weight: .medium))
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .background(ArkPalette.raised, in: Capsule())
            .offset(y: -(ChatLayoutMetrics.statsBarHeight + ChatLayoutMetrics.statsBarBottomInset + ChatLayoutMetrics.toastSpacing))
            .allowsHitTesting(false)
        }
      }
    }
  }

  @ViewBuilder
  private func transcriptRow(
    _ item: NativeChatDisplayEntry,
    fontSize: CGFloat,
    finalAnswerByTurn: [Int: String],
    scrollID: String
  ) -> some View {
    switch item {
    case .assistantPrefix(let row):
      assistantProjectedPrefix(row, fontSize: fontSize)
        .id(scrollID)
    case .assistantMarkdownRow(let row):
      assistantProjectedBodyRow(row, fontSize: fontSize)
        .id(scrollID)
    case .assistantSuffix(let row):
      assistantProjectedSuffix(row, fontSize: fontSize)
        .id(scrollID)
    default:
      chatRow(
        item,
        fontSize: fontSize,
        finalAnswerByTurn: finalAnswerByTurn
      )
      .id(scrollID)
    }
  }

  @ViewBuilder
  private func chatRow(
    _ item: NativeChatDisplayEntry,
    fontSize: CGFloat,
    finalAnswerByTurn: [Int: String]
  ) -> some View {
    switch item {
    case .process(let process):
      NativeTurnProcessRow(
        process: process,
        language: context.language,
        fontSize: fontSize,
        expanded: expandedProcessGenerations.contains(process.generation),
        toggle: {
          if expandedProcessGenerations.contains(process.generation) {
            expandedProcessGenerations.remove(process.generation)
          } else {
            expandedProcessGenerations.insert(process.generation)
          }
        }
      ) {
        ForEach(process.detailEntries) { entry in
          chatEntryRow(entry, fontSize: fontSize, hideReasoning: false)
        }
      }
    case .usage(let turn, let usage):
      NativeTurnUsageDisclosure(
        turn: turn,
        usage: usage,
        language: context.language,
        fontSize: fontSize
      )
    case .entry(let entry):
      chatEntryRow(
        entry,
        fontSize: fontSize,
        hideReasoning: hidesFinalReasoning(entry, finalAnswerByTurn: finalAnswerByTurn)
      )
    case .assistantPrefix, .assistantMarkdownRow, .assistantSuffix:
      EmptyView()
    }
  }

  @ViewBuilder
  private func assistantProjectedPrefix(
    _ row: NativeAssistantMarkdownPrefixRow,
    fontSize: CGFloat
  ) -> some View {
    let message = row.message
    VStack(alignment: .leading, spacing: 10) {
      if !message.documentReferences.isEmpty {
        NativeMessageDocuments(
          documents: message.documentReferences,
          language: row.presentation.language
        )
      }
      if !message.attachmentIDs.isEmpty, message.blocks.isEmpty {
        NativeMessageImages(model: model, attachmentIDs: message.attachmentIDs)
      }
      if message.blocks.isEmpty,
         !row.hideReasoning,
         let reasoning = message.reasoning,
         !reasoning.isEmpty
      {
        NativeReasoningBlock(
          text: reasoning,
          language: row.presentation.language,
          fontSize: fontSize,
          streaming: false
        )
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  @ViewBuilder
  private func assistantProjectedBodyRow(
    _ displayRow: NativeAssistantMarkdownBodyDisplayRow,
    fontSize: CGFloat
  ) -> some View {
    let row = displayRow.row
    let context = displayRow.context
    switch row {
    case .pending(let sourceID):
      HStack(spacing: 8) {
        ProgressView().controlSize(.small)
        Text(ArkL10n.text(.chatSyncingHistory, context.language))
          .font(.system(size: max(11, fontSize - 3)))
          .foregroundStyle(ArkPalette.secondary)
      }
      .frame(maxWidth: .infinity, minHeight: 28, alignment: .leading)
      .accessibilityIdentifier(
        "ark.chat.message.\(sourceID.messageID).markdown.\(sourceID.sourceSlot).pending"
      )
    case .markdown(let projected):
      NativeGFMBlockView(
        block: projected.block,
        baseFontSize: fontSize,
        path: projected.renderPath
      )
      .nativeMarkdownRoutes(
        producedFilePaths: context.producedFilePaths
      )
      .frame(maxWidth: .infinity, alignment: .leading)
      .fixedSize(horizontal: false, vertical: true)
      .accessibilityIdentifier(
        "ark.chat.message.\(projected.sourceID.messageID).markdown."
          + "\(projected.sourceID.sourceSlot).\(projected.blockIndex)"
      )
    case .companion(_, _, let block):
      NativeMessageBlockView(
        model: model,
        block: block,
        producedFilePaths: context.producedFilePaths,
        streaming: false,
        fontSize: fontSize,
        hideReasoning: context.hideReasoning,
        language: context.language
      )
      .frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  @ViewBuilder
  private func assistantProjectedSuffix(
    _ row: NativeAssistantMarkdownSuffixRow,
    fontSize: CGFloat
  ) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      if row.message.interrupted {
        Text(ArkL10n.text(.executionCancelled, row.presentation.language))
          .font(.system(size: 10, weight: .medium))
          .foregroundStyle(ArkPalette.secondary)
          .padding(.horizontal, 7)
          .padding(.vertical, 2)
          .background(ArkPalette.raised, in: RoundedRectangle(cornerRadius: 6))
      }
      if !row.producedFiles.isEmpty {
        NativeProducedFilesRow(
          files: row.producedFiles,
          language: row.presentation.language
        )
      }
      NativeMessageActions(
        model: model,
        message: row.message,
        presentation: row.presentation,
        actionsVisible: true,
        fontSize: fontSize
      )
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityIdentifier(
      "ark.chat.message.\(row.message.messageID ?? String(row.message.id))"
    )
  }

  @ViewBuilder
  private func chatEntryRow(
    _ entry: NativeChatEntry,
    fontSize: CGFloat,
    hideReasoning: Bool
  ) -> some View {
    switch entry {
    case .message(let message, let producedFiles):
      if message.role == .user,
         let sourceKind = message.sourceKind,
         sourceKind != "user" {
        NativeContextMessageRow(
          message: message,
          language: context.language,
          fontSize: fontSize
        )
      } else if message.role == .system {
        NativeSystemPromptRow(
          message: message,
          language: context.language,
          fontSize: fontSize
        )
      } else {
        NativeMessageRow(
          model: model,
          message: message,
          producedFiles: producedFiles,
          presentation: context.presentation(for: message),
          fontSize: fontSize,
          hideReasoning: hideReasoning
        )
        .equatable()
      }
    case .tool(let activity):
      NativeToolRow(
        activity: activity,
        language: context.language,
        fontSize: fontSize,
        openChildSession: { model.selectSession($0) }
      )
    case .subagent(let group):
      NativeSubagentTaskRow(
        group: group,
        language: context.language,
        fontSize: fontSize
      )
    case .status(let status):
      NativeChatStatusRow(
        status: status,
        language: context.language,
        fontSize: fontSize
      )
    }
  }

  private func hidesFinalReasoning(
    _ entry: NativeChatEntry,
    finalAnswerByTurn: [Int: String]
  ) -> Bool {
    guard compactProcess,
          case .message(let message, _) = entry,
          message.role == .assistant,
          let turn = message.turn,
          finalAnswerByTurn[turn] == entry.id
    else { return false }
    let hasVisibleAnswer = !message.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      || !message.attachmentIDs.isEmpty
      || message.blocks.contains { block in
        switch block {
        case .text(let text): return !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        case .image, .unknown: return true
        case .reasoning: return false
        }
      }
    return hasVisibleAnswer && entry.assistantReasoning != nil
  }

  private func scrollID(
    for item: NativeChatDisplayEntry,
    turnAnchorByTurn: [Int: String]
  ) -> String {
    guard let turn = item.turn, turnAnchorByTurn[turn] == item.id else { return item.id }
    return "ark.chat.turn.\(turn)"
  }
}

/// Stages one continuous display control and emits only a changed normalized
/// value after editing settles.
struct ArkChatDisplaySliderDraft: Equatable {
  let bounds: ClosedRange<Double>
  let quantum: Double
  private(set) var draftValue: Double
  private(set) var persistedValue: Double

  init(persistedValue: Double, bounds: ClosedRange<Double>, quantum: Double) {
    precondition(quantum > 0)
    self.bounds = bounds
    self.quantum = quantum
    let initial = min(bounds.upperBound, max(bounds.lowerBound, persistedValue))
    draftValue = initial
    self.persistedValue = initial
  }

  mutating func updateDraft(_ value: Double) {
    draftValue = min(bounds.upperBound, max(bounds.lowerBound, value))
  }

  @discardableResult
  mutating func finishEditing(commit: (Double) -> Void) -> Bool {
    let normalized = min(
      bounds.upperBound,
      max(bounds.lowerBound, (draftValue / quantum).rounded() * quantum)
    )
    draftValue = normalized
    guard normalized != persistedValue else { return false }
    persistedValue = normalized
    commit(normalized)
    return true
  }

  mutating func synchronizePersistedValue(_ value: Double) {
    let synchronized = min(bounds.upperBound, max(bounds.lowerBound, value))
    persistedValue = synchronized
    draftValue = synchronized
  }
}

/// One native owner for the conversation display preferences. It is presented
/// from the session actions menu so the same controls do not appear both in
/// the transcript chrome and in General settings.
private struct NativeChatDisplaySettingsPanel: View {
  let language: ArkLanguagePreference
  @Binding var fontSize: Double
  @Binding var contentWidth: Double
  @Binding var contentWidthAdaptive: Bool
  @Binding var compactProcess: Bool
  @State private var fontSizeDraft: ArkChatDisplaySliderDraft
  @State private var contentWidthDraft: ArkChatDisplaySliderDraft

  init(
    language: ArkLanguagePreference,
    fontSize: Binding<Double>,
    contentWidth: Binding<Double>,
    contentWidthAdaptive: Binding<Bool>,
    compactProcess: Binding<Bool>
  ) {
    self.language = language
    _fontSize = fontSize
    _contentWidth = contentWidth
    _contentWidthAdaptive = contentWidthAdaptive
    _compactProcess = compactProcess
    _fontSizeDraft = State(initialValue: ArkChatDisplaySliderDraft(
      persistedValue: fontSize.wrappedValue,
      bounds: 12...24,
      quantum: 1
    ))
    _contentWidthDraft = State(initialValue: ArkChatDisplaySliderDraft(
      persistedValue: contentWidth.wrappedValue,
      bounds: 520...1_200,
      quantum: 8
    ))
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      VStack(alignment: .leading, spacing: 3) {
        Text(ArkL10n.text(.chatDisplayTitle, language))
          .font(.system(size: 15, weight: .semibold))
        Text(ArkL10n.text(.chatDisplayDetail, language))
          .font(.system(size: 11))
          .foregroundStyle(ArkPalette.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      .padding(.horizontal, 2)

      displayCard {
        VStack(alignment: .leading, spacing: 8) {
          HStack(spacing: 8) {
            Label(ArkL10n.text(.chatFontSize, language), systemImage: "textformat.size")
              .font(.system(size: 12, weight: .medium))
            Spacer()
            Text("\(Int(fontSizeDraft.draftValue.rounded())) pt")
              .font(.system(size: 11, weight: .medium))
              .monospacedDigit()
              .foregroundStyle(ArkPalette.secondary)
          }
          Slider(
            value: Binding(
              get: { fontSizeDraft.draftValue },
              set: { fontSizeDraft.updateDraft($0) }
            ),
            in: fontSizeDraft.bounds,
            onEditingChanged: finishFontSizeEditing
          )
          .focusable()
          .frame(minHeight: 32)
          .accessibilityLabel(ArkL10n.text(.chatFontSize, language))
          .accessibilityValue("\(Int(fontSizeDraft.draftValue.rounded())) pt")
          .accessibilityAdjustableAction(adjustFontSize)
          .accessibilityIdentifier("ark.chat.font-size")
        }
      }

      displayCard {
        VStack(alignment: .leading, spacing: 8) {
          Toggle(isOn: $contentWidthAdaptive) {
            Label(ArkL10n.text(.chatAdaptiveWidth, language), systemImage: "arrow.left.and.right")
              .font(.system(size: 12, weight: .medium))
          }
          .toggleStyle(.switch)
          .frame(maxWidth: .infinity, minHeight: 36, alignment: .leading)
          .accessibilityIdentifier("ark.chat.content-width-adaptive")

          VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
              Text(ArkL10n.text(.chatContentWidth, language))
                .font(.system(size: 12, weight: .medium))
              Spacer()
              Text("\(Int(contentWidthDraft.draftValue.rounded())) pt")
                .font(.system(size: 11, weight: .medium))
                .monospacedDigit()
                .foregroundStyle(ArkPalette.secondary)
            }
            Slider(
              value: Binding(
                get: { contentWidthDraft.draftValue },
                set: { contentWidthDraft.updateDraft($0) }
              ),
              in: contentWidthDraft.bounds,
              onEditingChanged: finishContentWidthEditing
            )
            .focusable()
            .frame(minHeight: 32)
            .accessibilityLabel(ArkL10n.text(.chatContentWidth, language))
            .accessibilityValue("\(Int(contentWidthDraft.draftValue.rounded())) pt")
            .accessibilityAdjustableAction(adjustContentWidth)
            .accessibilityIdentifier("ark.chat.content-width")
          }
          .disabled(contentWidthAdaptive)
          .opacity(contentWidthAdaptive ? 0.46 : 1)
        }
      }

      displayCard {
        Toggle(isOn: $compactProcess) {
          Label(
            ArkL10n.text(.chatCompactProcess, language),
            systemImage: "rectangle.compress.vertical"
          )
          .font(.system(size: 12, weight: .medium))
        }
        .toggleStyle(.switch)
        .frame(maxWidth: .infinity, minHeight: 36, alignment: .leading)
        .accessibilityIdentifier("ark.chat.compact-process")
      }
    }
    .padding(14)
    .frame(width: 328)
    .background(ArkPalette.panel)
    .accessibilityIdentifier("ark.chat.display-settings-panel")
    .onAppear {
      fontSizeDraft.synchronizePersistedValue(fontSize)
      contentWidthDraft.synchronizePersistedValue(contentWidth)
    }
    .onChange(of: fontSize) { fontSizeDraft.synchronizePersistedValue($0) }
    .onChange(of: contentWidth) { contentWidthDraft.synchronizePersistedValue($0) }
  }

  private func displayCard<Content: View>(
    @ViewBuilder content: () -> Content
  ) -> some View {
    content()
      .padding(12)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(ArkPalette.raised.opacity(0.52), in: RoundedRectangle(cornerRadius: 10))
      .overlay(RoundedRectangle(cornerRadius: 10).stroke(ArkPalette.border))
  }

  private func finishFontSizeEditing(_ editing: Bool) {
    guard !editing else { return }
    fontSizeDraft.finishEditing { fontSize = $0 }
  }

  private func finishContentWidthEditing(_ editing: Bool) {
    guard !editing else { return }
    contentWidthDraft.finishEditing { contentWidth = $0 }
  }

  private func adjustFontSize(_ direction: AccessibilityAdjustmentDirection) {
    guard let delta = adjustmentDelta(direction, quantum: 1) else { return }
    fontSizeDraft.updateDraft(fontSizeDraft.draftValue + delta)
    fontSizeDraft.finishEditing { fontSize = $0 }
  }

  private func adjustContentWidth(_ direction: AccessibilityAdjustmentDirection) {
    guard let delta = adjustmentDelta(direction, quantum: 8) else { return }
    contentWidthDraft.updateDraft(contentWidthDraft.draftValue + delta)
    contentWidthDraft.finishEditing { contentWidth = $0 }
  }

  private func adjustmentDelta(
    _ direction: AccessibilityAdjustmentDirection,
    quantum: Double
  ) -> Double? {
    switch direction {
    case .increment: return quantum
    case .decrement: return -quantum
    @unknown default: return nil
    }
  }
}

private struct NativeChatTurnNavigationRail: View {
  let items: [NativeChatTurnNavigationItem]
  let language: ArkLanguagePreference
  let navigate: (Int) -> Void
  @State private var hoveredTurn: Int?
  @State private var hoverGeneration = 0

  private var hoveredItem: NativeChatTurnNavigationItem? {
    guard let hoveredTurn else { return nil }
    return items.first { $0.turn == hoveredTurn }
  }

  var body: some View {
    ScrollView(.vertical, showsIndicators: false) {
      VStack(alignment: .leading, spacing: 2) {
        ForEach(items) { item in
          Button {
            navigate(item.turn)
          } label: {
            Capsule()
              .fill(hoveredTurn == item.turn ? ArkPalette.accent : markerColor(item))
              .frame(width: hoveredTurn == item.turn ? 22 : 12, height: 2)
              .frame(width: 30, height: 18, alignment: .leading)
              .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .onHover { hoverChanged(item.turn, hovering: $0) }
          .animation(.easeOut(duration: 0.12), value: hoveredTurn)
          .accessibilityLabel(ArkL10n.format(
            .chatTurnNavigationJump,
            language,
            arguments: [String(item.turn)]
          ))
          .accessibilityHint("\(item.title). \(item.detail)")
          .accessibilityValue(stateLabel(item))
          .accessibilityIdentifier("ark.chat.turn-navigation.\(item.turn)")
        }
      }
      .padding(.vertical, 6)
    }
    .frame(width: 30)
    .frame(maxHeight: 320)
    .overlay(alignment: .leading) {
      if let hoveredItem {
        NativeChatTurnNavigationPreview(item: hoveredItem)
          .offset(x: 36)
          .transition(.opacity.combined(with: .scale(scale: 0.98, anchor: .leading)))
          .zIndex(10)
      }
    }
    .accessibilityIdentifier("ark.chat.turn-navigation")
  }

  private func hoverChanged(_ turn: Int, hovering: Bool) {
    hoverGeneration &+= 1
    let generation = hoverGeneration
    if hovering {
      hoveredTurn = turn
      return
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.65) {
      guard hoverGeneration == generation, hoveredTurn == turn else { return }
      hoveredTurn = nil
    }
  }

  private func stateLabel(_ item: NativeChatTurnNavigationItem) -> String {
    if item.interrupted { return ArkL10n.text(.executionCancelled, language) }
    if item.completed { return ArkL10n.text(.executionCompleted, language) }
    return ArkL10n.text(.executionRunning, language)
  }

  private func markerColor(_ item: NativeChatTurnNavigationItem) -> Color {
    if item.interrupted { return Color.orange.opacity(0.78) }
    if !item.completed { return ArkPalette.accent.opacity(0.72) }
    return ArkPalette.secondary.opacity(0.62)
  }
}

private struct NativeChatTurnNavigationPreview: View {
  let item: NativeChatTurnNavigationItem

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(item.title)
        .font(.system(size: 12, weight: .semibold))
        .foregroundStyle(ArkPalette.primary)
        .lineLimit(2)
      Text(item.detail)
        .font(.system(size: 11))
        .foregroundStyle(ArkPalette.secondary)
        .lineLimit(6)
        .fixedSize(horizontal: false, vertical: true)
    }
    .padding(12)
    .frame(width: 320, alignment: .leading)
    .background(ArkPalette.panel, in: RoundedRectangle(cornerRadius: 10))
    .overlay(RoundedRectangle(cornerRadius: 10).stroke(ArkPalette.border))
    .shadow(color: .black.opacity(0.24), radius: 12, y: 5)
    .allowsHitTesting(false)
    .accessibilityHidden(true)
  }
}

private struct NativeTurnProcessRow<Content: View>: View {
  let process: NativeChatProcess
  let language: ArkLanguagePreference
  let fontSize: CGFloat
  let expanded: Bool
  let toggle: () -> Void
  let content: Content

  init(
    process: NativeChatProcess,
    language: ArkLanguagePreference,
    fontSize: CGFloat,
    expanded: Bool,
    toggle: @escaping () -> Void,
    @ViewBuilder content: () -> Content
  ) {
    self.process = process
    self.language = language
    self.fontSize = fontSize
    self.expanded = expanded
    self.toggle = toggle
    self.content = content()
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Text(ArkL10n.text(.chatTurnProcessTitle, language))
          .font(.system(size: max(11, fontSize - 3), weight: .semibold))
          .foregroundStyle(ArkPalette.primary)
        Text(processSummary)
          .font(.system(size: max(10, fontSize - 5)))
          .foregroundStyle(ArkPalette.secondary)
          .lineLimit(1)
        Spacer(minLength: 4)
      }

      if let reasoning = process.reasoningText {
        Text(reasoning)
          .font(.system(size: max(11, fontSize - 3)))
          .foregroundStyle(ArkPalette.secondary)
          .lineLimit(expanded ? nil : 4)
          .fixedSize(horizontal: false, vertical: true)
      }

      if expanded, !process.detailEntries.isEmpty {
        Divider().overlay(ArkPalette.border)
        VStack(alignment: .leading, spacing: ChatLayoutMetrics.entrySpacing) {
          content
        }
      }

      Button(action: toggle) {
        HStack(spacing: 5) {
          Text(ArkL10n.text(
            expanded ? .chatTurnProcessShowLess : .chatTurnProcessShowMore,
            language
          ))
          Image(systemName: expanded ? "chevron.up" : "chevron.down")
            .font(.system(size: 8, weight: .semibold))
        }
        .font(.system(size: max(10, fontSize - 5), weight: .medium))
        .foregroundStyle(ArkPalette.secondary)
        .frame(minHeight: 24)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel(ArkL10n.text(
        expanded ? .chatTurnProcessCollapse : .chatTurnProcessExpand,
        language
      ))
      .accessibilityHint(processSummary)
      .accessibilityIdentifier("ark.chat.turn-process.toggle.\(process.turn)")
    }
    .padding(12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(ArkPalette.raised.opacity(0.58), in: RoundedRectangle(cornerRadius: 12))
    .overlay(RoundedRectangle(cornerRadius: 12).stroke(ArkPalette.border))
    .accessibilityIdentifier("ark.chat.turn-process.\(process.turn)")
  }

  private var processSummary: String {
    var values: [String] = []
    if process.toolCallCount > 0 {
      values.append(ArkL10n.format(.chatTurnProcessToolCalls, language, arguments: [String(process.toolCallCount)]))
    }
    if process.messageCount > 0 {
      values.append(ArkL10n.format(.chatTurnProcessMessages, language, arguments: [String(process.messageCount)]))
    }
    if process.subagentCount > 0 {
      values.append(ArkL10n.format(.chatTurnProcessSubagents, language, arguments: [String(process.subagentCount)]))
    }
    return values.isEmpty
      ? ArkL10n.text(.chatTurnProcessThought, language)
      : values.joined(separator: ArkL10n.text(.chatTurnProcessSeparator, language))
  }
}

private struct NativeTurnUsageDisclosure: View {
  let turn: Int
  let usage: ArkChatTurnUsage
  let language: ArkLanguagePreference
  let fontSize: CGFloat
  @State private var expanded = false

  var body: some View {
    VStack(alignment: .leading, spacing: 5) {
      Button {
        expanded.toggle()
      } label: {
        HStack(spacing: 7) {
          Image(systemName: "chart.bar.xaxis")
            .foregroundStyle(ArkPalette.secondary)
          Text(ArkL10n.text(.chatTurnUsageTitle, language))
            .font(.system(size: max(10, fontSize - 5), weight: .medium))
            .foregroundStyle(ArkPalette.secondary)
          Text("·")
            .foregroundStyle(ArkPalette.secondary)
          Text(summary)
            .font(.system(size: max(10, fontSize - 5), design: .monospaced))
            .foregroundStyle(ArkPalette.secondary)
            .lineLimit(1)
          Spacer(minLength: 4)
          Image(systemName: expanded ? "chevron.down" : "chevron.right")
            .font(.system(size: 9, weight: .semibold))
            .foregroundStyle(ArkPalette.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      if expanded {
        VStack(alignment: .leading, spacing: 4) {
          if let routes = usage.routes, !routes.isEmpty {
            usageRow(.chatTurnUsageProviderModel, routes.map { "\($0.provider)/\($0.model)" }.joined(separator: ", "))
          }
          usageRow(.chatTurnUsageInput, NativeTokenFormat.exact(usage.uncachedInputTokens))
          if let cacheReadTokens = usage.cacheReadTokens {
            usageRow(.chatTurnUsageCacheRead, NativeTokenFormat.exact(cacheReadTokens))
          }
          if let cacheWriteTokens = usage.cacheWriteTokens {
            usageRow(.chatTurnUsageCacheWrite, NativeTokenFormat.exact(cacheWriteTokens))
          }
          usageRow(.chatTurnUsageOutput, outputSummary)
          usageRow(.chatTurnUsageTotal, NativeTokenFormat.exact(usage.totalTokens), emphasized: true)
        }
        .font(.system(size: max(10, fontSize - 5)))
        .padding(.leading, 22)
        .padding(.vertical, 4)
      }
    }
    .padding(.vertical, 3)
    .accessibilityIdentifier("ark.chat.turn-usage.\(turn)")
  }

  private var summary: String {
    let total = NativeTokenFormat.compact(usage.totalTokens)
    guard let cacheRead = usage.cacheReadTokens else {
      return ArkL10n.format(.chatTurnUsageCount, language, arguments: [total])
    }
    let prompt = usage.uncachedInputTokens + cacheRead
      + (usage.cacheWriteTokens ?? 0)
    guard prompt > 0 else {
      return ArkL10n.format(.chatTurnUsageCount, language, arguments: [total])
    }
    let percent = NativeTokenFormat.percent(cacheRead, of: prompt)
    return ArkL10n.format(.chatTurnUsageSummary, language, arguments: [total, percent])
  }

  private var outputSummary: String {
    var value = NativeTokenFormat.exact(usage.outputTokens)
    if let reasoningTokens = usage.reasoningTokens {
      value += " (\(NativeTokenFormat.exact(reasoningTokens)) \(ArkL10n.text(.chatTurnUsageReasoning, language)))"
    }
    return value
  }

  private func usageRow(
    _ key: ArkL10n.Key,
    _ value: String,
    emphasized: Bool = false
  ) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Text(ArkL10n.text(key, language))
        .foregroundStyle(ArkPalette.secondary)
      Spacer(minLength: 8)
      Text(value)
        .fontWeight(emphasized ? .semibold : .regular)
        .foregroundStyle(ArkPalette.primary)
    }
  }
}

private enum NativeTokenFormat {
  static func compact(_ value: Int) -> String {
    if value < 1_000 { return String(value) }
    if value < 1_000_000 { return scaled(Double(value) / 1_000, suffix: "K") }
    return scaled(Double(value) / 1_000_000, suffix: "M")
  }

  static func exact(_ value: Int) -> String { String(value) }

  static func percent(_ value: Int, of denominator: Int) -> String {
    guard denominator > 0 else { return "0" }
    let rounded = (Double(value) / Double(denominator) * 100 * 10).rounded() / 10
    return rounded.rounded() == rounded
      ? String(Int(rounded))
      : String(format: "%.1f", rounded)
  }

  private static func scaled(_ value: Double, suffix: String) -> String {
    let rounded = value >= 100 ? value.rounded() : (value * 10).rounded() / 10
    let text = rounded.rounded() == rounded ? String(Int(rounded)) : String(format: "%.1f", rounded)
    return text + suffix
  }
}

private struct NativeSystemPromptRow: View {
  let message: ArkMessage
  let language: ArkLanguagePreference
  let fontSize: CGFloat
  @State private var expanded = false

  var body: some View {
    VStack(alignment: .leading, spacing: 5) {
      Button {
        expanded.toggle()
      } label: {
        HStack(spacing: 7) {
          Image(systemName: expanded ? "chevron.down" : "doc.text.magnifyingglass")
            .frame(width: 15)
            .foregroundStyle(ArkPalette.secondary)
          Text(ArkL10n.text(.chatSystemPrompt, language))
            .font(.system(size: max(11, fontSize - 3), weight: .medium))
            .foregroundStyle(ArkPalette.secondary)
          Spacer(minLength: 4)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel(ArkL10n.text(
        expanded ? .chatSystemPromptCollapse : .chatSystemPromptExpand,
        language
      ))
      .accessibilityHint(ArkL10n.text(.chatSystemPrompt, language))
      .accessibilityIdentifier("ark.chat.system-prompt.toggle.\(message.id)")
      if expanded {
        NativeMarkdownText(
          text: message.text,
          baseFontSize: max(11, fontSize - 2),
          producedFilePaths: []
        )
        .padding(.leading, 22)
        .padding(.vertical, 4)
      }
    }
    .accessibilityIdentifier("ark.chat.system-prompt.\(message.id)")
  }
}

/// Presentation-only transcript row. Message projection, ordering and actions
/// remain owned by ArkAppModel; this view only establishes the native visual
/// hierarchy used by the compact Ark transcript.
private struct NativeMessageRow: View, Equatable {
  let model: ArkAppModel
  let message: ArkMessage
  let producedFiles: [ArkProducedFile]
  let presentation: NativeMessagePresentation
  let fontSize: CGFloat
  let hideReasoning: Bool

  private var isUser: Bool { message.role == .user }
  private var isStreamingAssistant: Bool {
    ArkStreamingPresentationPolicy.usesStreamingAssistantPresentation(
      role: message.role,
      isLatestAssistant: presentation.isLatestAssistant,
      sessionRunning: presentation.sessionRunning
    )
  }

  static func == (lhs: Self, rhs: Self) -> Bool {
    lhs.message == rhs.message
      && lhs.producedFiles == rhs.producedFiles
      && lhs.presentation == rhs.presentation
      && lhs.fontSize == rhs.fontSize
      && lhs.hideReasoning == rhs.hideReasoning
  }

  var body: some View {
    HStack(alignment: .top, spacing: 0) {
      if isUser { Spacer(minLength: 96) }
      VStack(alignment: isUser ? .trailing : .leading, spacing: 6) {
        VStack(alignment: .leading, spacing: 10) {
          if !message.documentReferences.isEmpty {
            NativeMessageDocuments(
              documents: message.documentReferences,
              language: presentation.language
            )
          }
          if !message.attachmentIDs.isEmpty, message.blocks.isEmpty {
            NativeMessageImages(model: model, attachmentIDs: message.attachmentIDs)
          }
          if message.blocks.isEmpty {
            if !hideReasoning, let reasoning = message.reasoning, !reasoning.isEmpty {
              NativeReasoningBlock(
                text: reasoning,
                language: presentation.language,
                fontSize: fontSize,
                streaming: isStreamingAssistant
              )
            }
            if !message.text.isEmpty {
              if isStreamingAssistant {
                NativeStreamingMarkdownText(
                  text: message.text,
                  baseFontSize: fontSize,
                  producedFilePaths: producedFiles.map(\.path)
                )
              } else {
                NativeMarkdownText(
                  text: message.text,
                  baseFontSize: fontSize,
                  producedFilePaths: producedFiles.map(\.path)
                )
              }
            }
          } else {
            ForEach(Array(message.blocks.enumerated()), id: \.offset) { _, block in
              NativeMessageBlockView(
                model: model,
                block: block,
                producedFilePaths: producedFiles.map(\.path),
                streaming: isStreamingAssistant,
                fontSize: fontSize,
                hideReasoning: hideReasoning,
                language: presentation.language
              )
            }
          }
          if message.role == .assistant, message.interrupted {
            Text(ArkL10n.text(.executionCancelled, presentation.language))
              .font(.system(size: 10, weight: .medium))
              .foregroundStyle(ArkPalette.secondary)
              .padding(.horizontal, 7)
              .padding(.vertical, 2)
              .background(ArkPalette.raised, in: RoundedRectangle(cornerRadius: 6))
          }
        }
        .padding(.horizontal, isUser ? 16 : 0)
        .padding(.vertical, isUser ? 10 : 2)
        .frame(
          maxWidth: isUser ? ChatLayoutMetrics.userBubbleMaxWidth : .infinity,
          alignment: .leading
        )
        .fixedSize(horizontal: false, vertical: true)
        .layoutPriority(1)
        .background(
          isUser ? ArkPalette.bubble : Color.clear,
          in: RoundedRectangle(
            cornerRadius: isUser ? ChatLayoutMetrics.userBubbleCornerRadius : 0
          )
        )

        if !producedFiles.isEmpty {
          NativeProducedFilesRow(
            files: producedFiles,
            language: presentation.language
          )
            .frame(
              maxWidth: isUser ? ChatLayoutMetrics.userBubbleMaxWidth : .infinity,
              alignment: .leading
            )
        }

        NativeMessageActions(
          model: model,
          message: message,
          presentation: presentation,
          actionsVisible: true,
          fontSize: fontSize
        )
        .frame(
          maxWidth: isUser ? ChatLayoutMetrics.userBubbleMaxWidth : .infinity,
          alignment: .leading
        )
      }
      .frame(
        maxWidth: isUser ? ChatLayoutMetrics.userBubbleMaxWidth : .infinity,
        alignment: isUser ? .trailing : .leading
      )
      .contentShape(Rectangle())
      .accessibilityIdentifier("ark.chat.message.\(message.messageID ?? String(message.id))")
    }
  }
}

private struct NativeMessageDocuments: View {
  let documents: [ArkMessageDocumentReference]
  let language: ArkLanguagePreference

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      ForEach(documents) { document in
        HStack(spacing: 9) {
          Image(systemName: "doc.text")
            .font(.system(size: 17))
            .foregroundStyle(ArkPalette.secondary)
          VStack(alignment: .leading, spacing: 2) {
            Text(document.name.isEmpty
              ? ArkL10n.text(.composerPastedText, language)
              : document.name)
              .font(.system(size: 11, weight: .semibold))
              .lineLimit(1)
            Text(ArkL10n.format(
              .composerDocumentBounded,
              language,
              arguments: [
                ByteCountFormatter.string(
                  fromByteCount: Int64(document.sourceBytes),
                  countStyle: .file
                ),
                String(document.extractedCharacters),
              ]
            ))
            .font(.system(size: 9))
            .foregroundStyle(ArkPalette.secondary)
          }
        }
        .padding(.horizontal, 10)
        .frame(width: 224, height: 54, alignment: .leading)
        .background(ArkPalette.raised, in: RoundedRectangle(cornerRadius: 11))
        .overlay(RoundedRectangle(cornerRadius: 11).stroke(ArkPalette.border))
        .accessibilityIdentifier("ark.chat.document.\(document.id)")
      }
    }
  }
}

private struct NativeMessageBlockView: View {
  let model: ArkAppModel
  let block: ArkMessageBlock
  let producedFilePaths: [String]
  let streaming: Bool
  let fontSize: CGFloat
  let hideReasoning: Bool
  let language: ArkLanguagePreference

  var body: some View {
    switch block {
    case .text(let text):
      if streaming {
        NativeStreamingMarkdownText(
          text: text,
          baseFontSize: fontSize,
          producedFilePaths: producedFilePaths
        )
      } else {
        NativeMarkdownText(
          text: text,
          baseFontSize: fontSize,
          producedFilePaths: producedFilePaths
        )
      }
    case .reasoning(let text):
      if !hideReasoning {
        NativeReasoningBlock(
          text: text,
          language: language,
          fontSize: fontSize,
          streaming: streaming
        )
      }
    case .image(let attachmentID):
      NativeMessageImages(model: model, attachmentIDs: [attachmentID])
    case .unknown(let type, let value):
      DisclosureGroup(ArkL10n.format(.chatUnknownContent, language, arguments: [type])) {
        Text(String(describing: value))
          .font(.system(size: 10, design: .monospaced))
          .foregroundStyle(ArkPalette.secondary)
          .padding(.top, 6)
      }
      .font(.system(size: 10, weight: .medium))
      .foregroundStyle(ArkPalette.secondary)
    }
  }
}

private struct NativeReasoningBlock: View {
  let text: String
  let language: ArkLanguagePreference
  let fontSize: CGFloat
  let streaming: Bool

  var body: some View {
    DisclosureGroup(summary) {
      Text(displayText)
        .font(.system(size: max(10, fontSize - 2)))
        .foregroundStyle(ArkPalette.secondary)
        .lineLimit(streaming ? ArkStreamingPresentationPolicy.reasoningLineLimit : nil)
        .padding(.top, 6)
    }
    .font(.system(size: max(10, fontSize - 4), weight: .medium))
    .foregroundStyle(ArkPalette.secondary)
  }

  private var displayText: String {
    ArkStreamingPresentationPolicy.reasoningText(text, streaming: streaming)
  }

  private var summary: String {
    let recent = String(text.suffix(512))
    let first = recent.split(separator: "\n").last(where: { !$0.trimmingCharacters(in: .whitespaces).isEmpty })
      .map(String.init) ?? ArkL10n.text(.chatTurnProcessThought, language)
    return first.count > 64 ? String(first.prefix(63)) + "…" : first
  }
}

private struct NativeContextMessageRow: View {
  let message: ArkMessage
  let language: ArkLanguagePreference
  let fontSize: CGFloat

  private var provenance: ArkContextProvenance {
    ArkContextProvenance.project(source: message.source)
  }

  var body: some View {
    DisclosureGroup {
      contextBody
        .padding(10)
        .frame(maxHeight: 160)
        .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
        .padding(.leading, 22)
        .padding(.top, 4)
    } label: {
      HStack(spacing: 6) {
        Image(systemName: provenance.role == .recall ? "text.book.closed" : "doc.text.magnifyingglass")
        Text(contextTitle)
        if let label = provenance.label ?? message.sourceSummary {
          Circle().fill(ArkPalette.secondary).frame(width: 2, height: 2)
          Text(label).lineLimit(1)
        }
        if let formLabel {
          Circle().fill(ArkPalette.secondary).frame(width: 2, height: 2)
          Text(formLabel).lineLimit(1)
        }
      }
    }
    .font(.system(size: 12, weight: .medium))
    .foregroundStyle(ArkPalette.secondary)
    .padding(.vertical, 2)
    .accessibilityIdentifier("ark.chat.context.\(message.id)")
  }

  private var contextTitle: String {
    ArkL10n.text(
      provenance.role == .recall ? .contextRecall : .contextInjection,
      language
    )
  }

  private var formLabel: String? {
    guard let form = provenance.form else { return nil }
    let key: ArkL10n.Key = switch form {
    case .instructions: .contextFormInstructions
    case .catalog: .contextFormCatalog
    case .snapshot: .contextFormSnapshot
    case .notice: .contextFormNotice
    case .relay: .contextFormRelay
    case .recall: .contextFormRecall
    }
    return ArkL10n.text(key, language)
  }

  @ViewBuilder
  private var contextBody: some View {
    switch provenance.form {
    case .instructions, .notice, .relay, .recall:
      NativeMarkdownDocument(text: message.text, baseFontSize: max(11, fontSize - 2))
        .foregroundStyle(ArkPalette.secondary)
    case .catalog, .snapshot, nil:
      NativeMarkdownDocument(text: message.text, baseFontSize: max(11, fontSize - 2))
        .fontDesign(.monospaced)
        .foregroundStyle(ArkPalette.secondary)
    }
  }
}

private struct NativeProducedFilesRow: View {
  @Environment(\.arkOpenToolFile) private var openToolFile
  let files: [ArkProducedFile]
  let language: ArkLanguagePreference

  private var visibleFiles: ArraySlice<ArkProducedFile> { files.prefix(6) }

  var body: some View {
    HStack(spacing: 6) {
      Label(
        ArkL10n.text(.producedFilesLabel, language),
        systemImage: "doc.badge.plus"
      )
      .font(.system(size: 10, weight: .semibold))
      .foregroundStyle(ArkPalette.secondary)

      ForEach(visibleFiles) { file in
        Button {
          openToolFile(file.path)
        } label: {
          Text(basename(file.path))
            .font(.system(size: 10, weight: .medium))
            .lineLimit(1)
            .truncationMode(.middle)
            .frame(maxWidth: 124)
            .padding(.horizontal, 8)
            .frame(height: 24)
            .background(ArkPalette.raised, in: Capsule())
            .overlay(Capsule().stroke(ArkPalette.border))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .help(file.path)
        .accessibilityLabel(ArkL10n.format(
          .producedFilesOpen,
          language,
          arguments: [file.path]
        ))
        .accessibilityIdentifier("ark.chat.produced-file.\(file.id)")
      }

      if files.count > visibleFiles.count {
        Text(ArkL10n.format(
          .producedFilesMore,
          language,
          arguments: [String(files.count - visibleFiles.count)]
        ))
        .font(.system(size: 10))
        .foregroundStyle(ArkPalette.secondary)
      }
      Spacer(minLength: 0)
    }
    .frame(minHeight: 28)
    .accessibilityIdentifier("ark.chat.produced-files")
  }

  private func basename(_ path: String) -> String {
    let normalized = path.replacingOccurrences(of: "\\", with: "/")
    return normalized.split(separator: "/").last.map(String.init) ?? path
  }
}

enum NativeMessageActionMountPolicy {
  static func shouldMount(actionsVisible: Bool, hasVisibleContent: Bool) -> Bool {
    actionsVisible && hasVisibleContent
  }
}

private struct NativeMessageActions: View {
  let model: ArkAppModel
  let message: ArkMessage
  let presentation: NativeMessagePresentation
  let actionsVisible: Bool
  let fontSize: CGFloat
  @State private var copied = false
  @State private var showFeedbackNote = false
  @State private var feedbackNote = ""

  var body: some View {
    HStack(spacing: 8) {
      if NativeMessageActionMountPolicy.shouldMount(
        actionsVisible: actionsVisible,
        hasVisibleContent: hasVisibleContent
      ) {
        HStack(spacing: 8) {
        Button {
          NSPasteboard.general.clearContents()
          NSPasteboard.general.setString(message.text, forType: .string)
          copied = true
          DispatchQueue.main.asyncAfter(deadline: .now() + 1) { copied = false }
        } label: {
          Image(systemName: copied ? "checkmark" : "doc.on.doc")
            .frame(width: 28, height: 28)
        }
        .buttonStyle(.borderless)
        .disabled(message.text.isEmpty)
        .help(ArkL10n.text(copied ? .messageCopied : .messageCopy, presentation.language))
        if message.role == .assistant,
           presentation.feedbackAvailable,
           let messageID = message.messageID {
          let current = presentation.feedback?.rating
          Button {
            model.setMessageFeedback(messageID: messageID, rating: .positive)
          } label: {
            Image(systemName: current == .positive ? "hand.thumbsup.fill" : "hand.thumbsup")
              .frame(width: 28, height: 28)
          }
          .buttonStyle(.borderless)
          .help(ArkL10n.text(.messageHelpful, presentation.language))
          Button {
            model.setMessageFeedback(messageID: messageID, rating: .negative)
          } label: {
            Image(systemName: current == .negative ? "hand.thumbsdown.fill" : "hand.thumbsdown")
              .frame(width: 28, height: 28)
          }
          .buttonStyle(.borderless)
          .help(ArkL10n.text(.messageNeedsImprovement, presentation.language))
          if current != nil {
            Button {
              feedbackNote = model.feedback(for: messageID)?.note ?? ""
              showFeedbackNote = true
            } label: {
              Image(systemName: "square.and.pencil")
                .frame(width: 28, height: 28)
            }
            .buttonStyle(.borderless)
            .help(ArkL10n.text(.messageFeedbackNote, presentation.language))
            .popover(isPresented: $showFeedbackNote) {
              VStack(alignment: .leading, spacing: 10) {
                Text(ArkL10n.text(.messageFeedbackNote, presentation.language))
                  .font(.system(size: 13, weight: .semibold))
                TextEditor(text: $feedbackNote)
                  .font(.system(size: 12))
                  .frame(width: 300, height: 100)
                  .overlay(RoundedRectangle(cornerRadius: 7).stroke(ArkPalette.border))
                HStack {
                  Spacer()
                  Button(ArkL10n.text(.commonCancel, presentation.language)) {
                    showFeedbackNote = false
                  }
                  Button(ArkL10n.text(.commonSave, presentation.language)) {
                    model.setMessageFeedbackNote(messageID: messageID, note: feedbackNote)
                    showFeedbackNote = false
                  }
                  .buttonStyle(.borderedProminent)
                }
              }
              .padding(14)
            }
          }
        }
        if message.role == .assistant {
          let canFork = presentation.sessionID != nil && presentation.forkSequence != nil
          Button {
            if let sessionID = presentation.sessionID,
               let sequence = presentation.forkSequence {
              model.forkSession(sessionID, atSequence: sequence)
            }
          } label: {
            Image(systemName: "arrow.triangle.branch")
              .frame(width: 28, height: 28)
          }
          .buttonStyle(.borderless)
          .disabled(!canFork)
          .help(ArkL10n.text(
            canFork ? .messageForkHere : .messageForkUnavailable,
            presentation.language
          ))
        }
        }
      }
      Spacer(minLength: 6)
      Text(actionTail)
        .lineLimit(1)
        .help(presentation.language == .zh
          ? "首响应是首个流事件，不保证已出现正文。tok/s 使用提供方报告的输出 Token（可能含思考），按已完成模型流的耗时计算，不含工具执行或重试等待；不是正文出字速度。"
          : "First response measures the first stream event, not necessarily visible text. tok/s uses provider-reported output tokens (possibly including reasoning) over completed model streams, excluding tool execution and retry waits; it is not visible-text speed.")
    }
    .font(.system(size: max(10, fontSize - 5)))
    .foregroundStyle(ArkPalette.secondary)
    .frame(minHeight: 28)
  }

  private var hasVisibleContent: Bool {
    !message.text.isEmpty || !message.blocks.isEmpty || !message.attachmentIDs.isEmpty
      || !message.documentReferences.isEmpty
  }

  private var actionTail: String {
    var values = [message.time.formatted(date: .omitted, time: .shortened)]
    if let metrics = presentation.metrics {
      if let run = metrics.runSeconds {
        values.append(ArkL10n.format(
          .messageMetricDuration,
          presentation.language,
          arguments: [duration(run)]
        ))
      }
      if let first = metrics.firstTokenSeconds {
        values.append(ArkL10n.format(
          .messageMetricFirstToken,
          presentation.language,
          arguments: [duration(first)]
        ))
      }
      if let rate = metrics.tokensPerSecond { values.append(String(format: "%.1f tok/s", rate)) }
    }
    return values.joined(separator: " · ")
  }

  private func duration(_ seconds: Double) -> String {
    seconds < 1 ? "\(Int(seconds * 1_000))ms" : String(format: "%.1fs", seconds)
  }
}

/// Shared native image renderer used by Chat and the Trajectory inspector.
struct NativeMessageImages: View {
  let model: ArkAppModel
  @ObservedObject private var store: ArkMessageImageStore
  let attachmentIDs: [String]
  @State private var selectedAttachmentID: String?

  init(model: ArkAppModel, attachmentIDs: [String]) {
    self.model = model
    self.attachmentIDs = attachmentIDs
    _store = ObservedObject(wrappedValue: model.messageImages)
  }

  var body: some View {
    let single = attachmentIDs.count == 1
    HStack(alignment: .top, spacing: 8) {
      ForEach(Array(attachmentIDs.enumerated()), id: \.offset) { _, attachmentID in
        imageTile(attachmentID, single: single)
          .frame(width: single ? 280 : 72, height: single ? 220 : 72)
        .clipShape(RoundedRectangle(cornerRadius: 9))
        .overlay(RoundedRectangle(cornerRadius: 9).stroke(ArkPalette.border))
      }
    }
    .sheet(isPresented: Binding(
      get: { selectedAttachmentID != nil },
      set: { if !$0 { selectedAttachmentID = nil } }
    )) {
      VStack(spacing: 10) {
        HStack {
          Spacer()
          Button(ArkL10n.text(.imageClosePreview, model.languagePreference)) {
            selectedAttachmentID = nil
          }
        }
        if let id = selectedAttachmentID,
           let data = store.data(for: id),
           let image = NSImage(data: data) {
          Image(nsImage: image)
            .resizable()
            .scaledToFit()
        }
      }
      .padding(14)
      .frame(minWidth: 640, minHeight: 480)
      .background(ArkPalette.panel)
    }
  }

  @ViewBuilder
  private func imageTile(_ attachmentID: String, single: Bool) -> some View {
    switch store.state(for: attachmentID) {
    case .idle:
      loadingTile(attachmentID, cancellable: false)
        .onAppear { store.load(attachmentID) }
    case .loading:
      loadingTile(attachmentID, cancellable: true)
    case .cancelled:
      Button {
        store.retry(attachmentID)
      } label: {
        VStack(spacing: 6) {
          Image(systemName: "pause.circle")
          Text(ArkL10n.text(.imageLoadCancelled, model.languagePreference))
          Text(ArkL10n.text(.imageRetry, model.languagePreference))
            .font(.system(size: 10, weight: .semibold))
        }
        .font(.system(size: single ? 12 : 9))
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(ArkPalette.raised)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityIdentifier("ark.chat.image.retry.\(attachmentID)")
    case .failed(let message):
      Button {
        store.retry(attachmentID)
      } label: {
        VStack(spacing: 6) {
          Image(systemName: "exclamationmark.triangle")
          Text(ArkL10n.text(.imageLoadFailed, model.languagePreference))
          Text(ArkL10n.text(.imageRetry, model.languagePreference))
            .font(.system(size: 10, weight: .semibold))
        }
        .font(.system(size: single ? 12 : 9))
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(ArkPalette.raised)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .help(message)
      .accessibilityIdentifier("ark.chat.image.retry.\(attachmentID)")
    case .loaded:
      if let data = store.data(for: attachmentID), let image = NSImage(data: data) {
        Button {
          selectedAttachmentID = attachmentID
        } label: {
          Image(nsImage: image)
            .resizable()
            .scaledToFit()
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(ArkL10n.text(.imageOpenOriginal, model.languagePreference))
        .accessibilityIdentifier("ark.chat.image.open.\(attachmentID)")
      } else {
        Button {
          store.retry(attachmentID)
        } label: {
          Label(
            ArkL10n.text(.imageRetry, model.languagePreference),
            systemImage: "arrow.clockwise"
          )
          .frame(maxWidth: .infinity, maxHeight: .infinity)
          .background(ArkPalette.raised)
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("ark.chat.image.retry.\(attachmentID)")
      }
    }
  }

  private func loadingTile(_ attachmentID: String, cancellable: Bool) -> some View {
    ZStack {
      ArkPalette.raised
      VStack(spacing: 6) {
        ProgressView().controlSize(.small)
        Text(ArkL10n.text(.imageLoading, model.languagePreference))
          .font(.system(size: 10))
          .foregroundStyle(ArkPalette.secondary)
        if cancellable {
          Button(ArkL10n.text(.imageCancelLoading, model.languagePreference)) {
            store.cancel(attachmentID)
          }
          .buttonStyle(.borderless)
          .controlSize(.small)
          .accessibilityIdentifier("ark.chat.image.cancel.\(attachmentID)")
        }
      }
    }
  }
}

enum ArkChatOrderedMerge {
  static func merge<Element>(
    _ sources: [[Element]],
    precedes: (Element, Element) -> Bool
  ) -> [Element] {
    var indices = Array(repeating: 0, count: sources.count)
    var result: [Element] = []
    result.reserveCapacity(sources.reduce(0) { $0 + $1.count })

    while true {
      var selectedSource: Int?
      for sourceIndex in sources.indices where indices[sourceIndex] < sources[sourceIndex].count {
        guard let current = selectedSource else {
          selectedSource = sourceIndex
          continue
        }
        let candidate = sources[sourceIndex][indices[sourceIndex]]
        let selected = sources[current][indices[current]]
        if precedes(candidate, selected) { selectedSource = sourceIndex }
      }
      guard let selectedSource else { break }
      result.append(sources[selectedSource][indices[selectedSource]])
      indices[selectedSource] += 1
    }
    return result
  }
}

private enum NativeChatEntry: Identifiable, Equatable {
  case message(ArkMessage, producedFiles: [ArkProducedFile])
  case tool(ArkToolActivity)
  case subagent(ArkSubagentTranscriptGroup)
  case status(ArkChatStatus)

  var id: String {
    switch self {
    case .message(let message, _): return "message-\(message.id)"
    case .tool(let activity): return "tool-\(activity.id)"
    case .subagent(let group): return group.id
    case .status(let status): return "status-\(status.id)"
    }
  }

  var sequence: Int {
    switch self {
    case .message(let message, _): return message.id
    case .tool(let activity): return activity.sequence
    case .subagent(let group): return group.sequence
    case .status(let status): return status.sequence
    }
  }

  var turn: Int? {
    switch self {
    case .message(let message, _): return message.turn
    case .tool(let activity): return activity.turn
    case .subagent(let group): return group.turn
    case .status(let status): return status.turn
    }
  }

  var isAssistantMessage: Bool {
    guard case .message(let message, _) = self else { return false }
    return message.role == .assistant
  }

  /// Reasoning carried inside the completed assistant message. The final
  /// answer keeps its visible text while this secondary content moves into the
  /// turn-owned process card.
  var assistantReasoning: String? {
    guard case .message(let message, _) = self, message.role == .assistant else { return nil }
    if let reasoning = message.reasoning?.trimmingCharacters(in: .whitespacesAndNewlines),
      !reasoning.isEmpty
    {
      return reasoning
    }
    let pieces = message.blocks.compactMap { block -> String? in
      guard case .reasoning(let text) = block else { return nil }
      let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
      return trimmed.isEmpty ? nil : trimmed
    }
    return pieces.isEmpty ? nil : pieces.joined(separator: "\n\n")
  }

  var isToolEntry: Bool {
    if case .tool = self { return true }
    return false
  }

  var isSubagentEntry: Bool {
    if case .subagent = self { return true }
    return false
  }

  var toolCount: Int {
    switch self {
    case .tool: return 1
    case .subagent(let group): return max(1, group.activities.count)
    default: return 0
    }
  }

  /// Rows hidden by the completed-turn process disclosure. Errors, stopped
  /// states, user/system messages, and the final answer remain independent.
  var isProcessDetail: Bool {
    switch self {
    case .message:
      return isAssistantMessage
    case .tool, .subagent:
      return true
    case .status(let status):
      guard status.turn != nil else { return false }
      switch status.kind {
      case .command, .retry, .compaction, .context: return true
      case .warning, .error, .stopped: return false
      }
    }
  }

  /// A completed assistant answer must contain visible material and must not
  /// be a tool-call-only assistant block.
  var isFinalAssistantAnswer: Bool {
    guard case .message(let message, _) = self, message.role == .assistant else { return false }
    let containsToolCall = message.blocks.contains { block in
      if case .unknown(let type, _) = block {
        return type.localizedCaseInsensitiveContains("tool-call")
          || type.localizedCaseInsensitiveContains("tool_call")
      }
      return false
    }
    guard !containsToolCall else { return false }
    if !message.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return true }
    if !message.attachmentIDs.isEmpty { return true }
    return message.blocks.contains { block in
      switch block {
      case .image: return true
      case .unknown: return true
      case .text(let text), .reasoning(let text):
        return !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      }
    }
  }

  /// The three projections are already ordered by sequence. Merge them in one
  /// linear pass instead of concatenating and stable-sorting the entire
  /// transcript for every live token publication.
  static func merge(
    messages: [ArkMessage],
    tools: [ArkToolActivity],
    statuses: [ArkChatStatus],
    producedFiles: [ArkProducedFile]
  ) -> [NativeChatEntry] {
    let subagentProjection = ArkSubagentTranscriptProjection.fold(tools)
    let closingAssistantByTurn = Dictionary(
      grouping: messages.filter { $0.role == .assistant && $0.turn != nil },
      by: { $0.turn! }
    ).compactMapValues { rows in rows.map(\.id).max() }
    let sources: [[NativeChatEntry]] = [
      messages.map { message in
        guard message.role == .assistant,
              let turn = message.turn,
              closingAssistantByTurn[turn] == message.id
        else { return .message(message, producedFiles: []) }
        return .message(
          message,
          producedFiles: ArkProducedFilesProjection.files(
            producedFiles,
            turn: turn,
            through: message.id
          )
        )
      },
      subagentProjection.ordinaryTools.map(NativeChatEntry.tool),
      subagentProjection.groups.map(NativeChatEntry.subagent),
      statuses.map(NativeChatEntry.status),
    ]
    return ArkChatOrderedMerge.merge(sources) { candidate, selected in
      candidate.sequence < selected.sequence
        || (candidate.sequence == selected.sequence && candidate.id < selected.id)
    }
  }
}

private struct NativeChatStatusRow: View {
  let status: ArkChatStatus
  let language: ArkLanguagePreference
  let fontSize: CGFloat
  @State private var expanded = false
  @State private var retryDeadline: Date?
  @State private var retrySequence: Int?

  @ViewBuilder
  var body: some View {
    switch status.kind {
    case .command:
      lifecycleCard
    case .retry, .compaction, .context:
      compactDisclosure
    case .warning, .error, .stopped:
      alertCard
    }
  }

  private var alertCard: some View {
    HStack(alignment: .top, spacing: 9) {
      Image(systemName: symbol)
        .foregroundStyle(color)
      VStack(alignment: .leading, spacing: 4) {
        Text(status.title).font(.system(size: max(11, fontSize - 3), weight: .semibold))
        if let detail = status.detail, !detail.isEmpty {
          Text(detail)
            .font(.system(size: max(10, fontSize - 5)))
            .foregroundStyle(ArkPalette.secondary)
        }
      }
      Spacer()
    }
    .padding(.horizontal, 6)
    .padding(.vertical, 5)
    .background(color.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
  }

  private var lifecycleCard: some View {
    VStack(alignment: .leading, spacing: 7) {
      summaryRow
      if expanded, let body = status.body {
        ScrollView(.horizontal) {
          Text(body)
            .font(.system(size: max(10, fontSize - 6), design: .monospaced))
            .fixedSize(horizontal: true, vertical: false)
        }
        .frame(maxHeight: 180)
        .padding(9)
        .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 7))
      }
    }
    .padding(.horizontal, 6)
    .padding(.vertical, 4)
    .background(
      status.phase == .failed ? Color.red.opacity(0.08) : Color.clear,
      in: RoundedRectangle(cornerRadius: 8)
    )
  }

  private var compactDisclosure: some View {
    VStack(alignment: .leading, spacing: 4) {
      summaryRow
      if expanded, let body = status.body {
        Group {
          if status.kind == .compaction {
            NativeMarkdownDocument(text: body, baseFontSize: max(11, fontSize - 2))
          } else {
            Text(body).font(.system(size: max(10, fontSize - 6), design: .monospaced))
          }
        }
        .foregroundStyle(ArkPalette.secondary)
        .padding(.leading, 22)
        .padding(.vertical, 4)
      }
    }
  }

  @ViewBuilder
  private var summaryRow: some View {
    Group {
      if retryCountdownActive {
        TimelineView(.periodic(from: .now, by: 1)) { context in
          summaryButton(title: retryTitle(at: context.date))
        }
      } else {
        summaryButton(title: status.title)
      }
    }
    .onAppear(perform: synchronizeRetryDeadline)
    .onChange(of: status.retry) { _ in synchronizeRetryDeadline() }
  }

  private func summaryButton(title: String) -> some View {
    Button {
      if status.body != nil { expanded.toggle() }
    } label: {
      HStack(spacing: 7) {
        Image(systemName: expanded && status.body != nil ? "chevron.down" : symbol)
          .frame(width: 15)
          .foregroundStyle(color)
        Text(title)
          .font(.system(size: max(11, fontSize - 3), weight: .medium))
          .foregroundStyle(ArkPalette.primary)
          .lineLimit(1)
        if let detail = status.detail, !detail.isEmpty {
          Circle().fill(ArkPalette.secondary).frame(width: 2, height: 2)
          Text(detail)
            .font(.system(size: max(10, fontSize - 5)))
            .foregroundStyle(status.phase == .failed ? Color.red : ArkPalette.secondary)
            .lineLimit(1)
            .truncationMode(.tail)
        }
        Spacer(minLength: 8)
        if let phaseLabel {
          Text(phaseLabel)
            .font(.system(size: max(9, fontSize - 7), weight: .medium))
            .foregroundStyle(color)
        }
      }
      .frame(minHeight: 24)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
  }

  private var retryCountdownScheduled: Bool {
    guard let delayMilliseconds = status.retry?.delayMilliseconds else { return false }
    return status.phase == .running
      && status.retry?.state == .scheduled
      && delayMilliseconds.isFinite
      && delayMilliseconds > 0
  }

  private var retryCountdownActive: Bool {
    retryCountdownScheduled && retryDeadline != nil
  }

  private func synchronizeRetryDeadline() {
    guard retryCountdownScheduled, let retry = status.retry else {
      retryDeadline = nil
      retrySequence = nil
      return
    }
    guard retrySequence != retry.sequence else { return }
    retrySequence = retry.sequence
    let delaySeconds = retry.delayMilliseconds / 1_000
    retryDeadline = Date().addingTimeInterval(delaySeconds)
    let sequence = retry.sequence
    DispatchQueue.main.asyncAfter(deadline: .now() + delaySeconds) {
      guard retrySequence == sequence else { return }
      retryDeadline = nil
    }
  }

  private func retryTitle(at date: Date) -> String {
    guard let retry = status.retry else { return status.title }
    let remaining = max(1, Int(ceil((retryDeadline ?? date).timeIntervalSince(date))))
    let suffix = retry.maximum.map {
      ArkL10n.format(
        .statusRetryAttemptOfMax,
        language,
        arguments: [String(retry.attempt), String($0)]
      )
    } ?? ArkL10n.format(
      .statusRetryAttempt,
      language,
      arguments: [String(retry.attempt)]
    )
    return ArkL10n.format(
      .statusRetryAfterDelay,
      language,
      arguments: ["\(remaining)s", suffix]
    )
  }

  private var symbol: String {
    switch status.kind {
    case .retry: return "arrow.clockwise"
    case .warning: return "exclamationmark.triangle"
    case .error: return "xmark.octagon"
    case .stopped: return "stop.circle"
    case .command: return "command"
    case .compaction: return "rectangle.compress.vertical"
    case .context: return "doc.text.magnifyingglass"
    }
  }

  private var color: Color {
    if status.kind == .error { return .red }
    if status.kind == .warning { return .yellow }
    if status.phase == .failed { return .red }
    if status.phase == .stopped { return .orange }
    switch status.kind {
    case .retry: return .orange
    case .warning: return .yellow
    case .error: return .red
    case .stopped: return ArkPalette.secondary
    case .command: return status.phase == .succeeded ? .green : ArkPalette.accent
    case .compaction, .context: return ArkPalette.secondary
    }
  }

  private var phaseLabel: String? {
    switch status.phase {
    case .neutral: return nil
    case .running: return ArkL10n.text(.executionRunning, language)
    case .succeeded: return ArkL10n.text(.executionCompleted, language)
    case .failed: return ArkL10n.text(.executionFailed, language)
    case .stopped: return ArkL10n.text(.executionCancelled, language)
    }
  }
}

private struct NativeSubagentTaskRow: View {
  let group: ArkSubagentTranscriptGroup
  let language: ArkLanguagePreference
  let fontSize: CGFloat

  @State private var expanded = false
  @State private var hovering = false

  var body: some View {
    VStack(alignment: .leading, spacing: 7) {
      Button {
        expanded.toggle()
      } label: {
        HStack(spacing: 8) {
          Image(systemName: expanded ? "chevron.down" : "point.3.connected.trianglepath.dotted")
            .font(.system(size: max(10, fontSize - 4), weight: .semibold))
            .frame(width: 18)
            .foregroundStyle(phaseColor)
          Text(ArkL10n.text(.subagentTranscriptTitle, language))
            .font(.system(size: max(11, fontSize - 3), weight: .semibold))
          Text(ArkL10n.format(
            .subagentTranscriptOperations,
            language,
            arguments: [String(group.activities.count)]
          ))
          .font(.system(size: 11))
          .foregroundStyle(ArkPalette.secondary)
          Spacer(minLength: 8)
          Label(phaseLabel, systemImage: phaseSymbol)
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(phaseColor)
          if let durationText {
            Text(durationText)
              .font(.system(size: 9, design: .monospaced))
              .foregroundStyle(ArkPalette.secondary)
          }
        }
        .frame(minHeight: 32)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .help(ArkL10n.text(
        expanded ? .subagentTranscriptCollapse : .subagentTranscriptExpand,
        language
      ))

      if expanded {
        VStack(alignment: .leading, spacing: 5) {
          ForEach(Array(group.activities.enumerated()), id: \.element.id) { index, activity in
            HStack(alignment: .firstTextBaseline, spacing: 7) {
              Image(systemName: activitySymbol(activity))
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(activityColor(activity))
                .frame(width: 14)
              Text("\(index + 1)")
                .font(.system(size: 9, design: .monospaced))
                .foregroundStyle(ArkPalette.secondary)
            Text(activitySummary(activity))
                .font(.system(size: max(10, fontSize - 5)))
                .lineLimit(2)
              Spacer(minLength: 8)
            }
            .frame(minHeight: 24)
          }
        }
        .padding(.leading, 24)
        .padding(.bottom, 4)
      }
    }
    .padding(.horizontal, 8)
    .padding(.vertical, 4)
    .background(
      expanded
        ? ArkPalette.accent.opacity(0.08)
        : hovering ? ArkPalette.raised.opacity(0.56) : Color.clear,
      in: RoundedRectangle(cornerRadius: 9)
    )
    .overlay(
      RoundedRectangle(cornerRadius: 9)
        .stroke(group.phase == .failed ? Color.red.opacity(0.48) : ArkPalette.border.opacity(0.55))
    )
    .contentShape(Rectangle())
    .onHover { hovering = $0 }
    .animation(.easeOut(duration: 0.12), value: hovering)
    .animation(.easeOut(duration: 0.12), value: expanded)
    .accessibilityIdentifier("ark.chat.subagent-task.\(group.id)")
  }

  private var phaseLabel: String {
    switch group.phase {
    case .running: return ArkL10n.text(.subagentLineageRunning, language)
    case .succeeded: return ArkL10n.text(.subagentTranscriptCompleted, language)
    case .failed: return ArkL10n.text(.subagentTranscriptFailed, language)
    case .cancelled: return ArkL10n.text(.subagentTranscriptCancelled, language)
    }
  }

  private var phaseSymbol: String {
    switch group.phase {
    case .running: return "circle.dotted"
    case .succeeded: return "checkmark.circle.fill"
    case .failed: return "xmark.octagon.fill"
    case .cancelled: return "stop.circle.fill"
    }
  }

  private var phaseColor: Color {
    switch group.phase {
    case .running: return .accentColor
    case .succeeded: return .green
    case .failed: return .red
    case .cancelled: return .orange
    }
  }

  private var durationText: String? {
    guard let start = group.startedAt, let end = group.finishedAt else { return nil }
    let interval = max(0, end.timeIntervalSince(start))
    return interval < 1
      ? "\(Int((interval * 1_000).rounded()))ms"
      : String(format: "%.1fs", interval)
  }

  private func activitySummary(_ activity: ArkToolActivity) -> String {
    let source = activity.result?.isEmpty == false ? activity.result! : activity.arguments
    let first = source
      .split(separator: "\n", omittingEmptySubsequences: true)
      .first
      .map(String.init) ?? activity.name
    return first.count > 120 ? String(first.prefix(119)) + "…" : first
  }

  private func activitySymbol(_ activity: ArkToolActivity) -> String {
    if activity.isError { return "xmark.octagon.fill" }
    if activity.isInterrupted { return "stop.circle.fill" }
    if activity.execution?.phase == .running { return "circle.dotted" }
    return "checkmark.circle.fill"
  }

  private func activityColor(_ activity: ArkToolActivity) -> Color {
    if activity.isError { return .red }
    if activity.isInterrupted { return .orange }
    if activity.execution?.phase == .running { return .accentColor }
    return .green
  }
}

private struct NativeToolRow: View {
  @Environment(\.arkOpenToolFile) private var openToolFile
  let activity: ArkToolActivity
  let language: ArkLanguagePreference
  let fontSize: CGFloat
  let openChildSession: (String) -> Void
  @State private var expanded: Bool
  @State private var copied = false
  @State private var hovering = false

  init(
    activity: ArkToolActivity,
    language: ArkLanguagePreference,
    fontSize: CGFloat,
    openChildSession: @escaping (String) -> Void
  ) {
    self.activity = activity
    self.language = language
    self.fontSize = fontSize
    self.openChildSession = openChildSession
    _expanded = State(initialValue: ArkWorkflowRunPresentation(activity: activity) != nil)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Button {
        if expandable { expanded.toggle() }
      } label: {
        HStack(spacing: 8) {
          Image(systemName: expanded ? "chevron.down" : leadingSymbol)
            .font(.system(size: 12))
            .frame(width: 18)
            .foregroundStyle(statusColor)
          Text(toolTitle)
            .font(.system(size: max(11, fontSize - 3), weight: .semibold, design: .monospaced))
            .lineLimit(1)
          if !collapsedSummary.isEmpty {
            Circle().fill(ArkPalette.secondary).frame(width: 2, height: 2)
            Text(collapsedSummary)
              .font(.system(size: max(10, fontSize - 4)))
              .foregroundStyle(activity.isError ? Color.red : ArkPalette.secondary)
              .lineLimit(1)
              .truncationMode(.tail)
          }
          Spacer(minLength: 8)
          if activity.execution != nil {
            NativeExecutionInlineStatusView(activity: activity, language: language)
          } else if let statusLabel {
              Text(statusLabel)
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(statusColor)
          }
        }
        .frame(minHeight: 30)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)

      if let location = activity.primaryFileLocation {
        Button {
          openToolFile(location.path)
        } label: {
          HStack(spacing: 6) {
            Image(systemName: "doc.text")
            Text(location.path)
              .lineLimit(1)
              .truncationMode(.middle)
            if let line = location.line {
              Text(":\(line)")
                .foregroundStyle(ArkPalette.secondary)
            }
            Spacer(minLength: 8)
            Label(
              ArkL10n.text(.toolOpenInFiles, language),
              systemImage: "arrow.up.forward.app"
            )
          }
          .font(.system(size: 10, design: .monospaced))
          .foregroundStyle(ArkPalette.secondary)
          .frame(minHeight: 22)
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.leading, 26)
        .accessibilityIdentifier("ark.chat.tool.open-file")
      }

      if expanded {
        VStack(alignment: .leading, spacing: 7) {
          NativeToolPresentationSummary(
            activity: activity,
            language: language,
            openChildSession: openChildSession
          )
          HStack(spacing: 8) {
            if let result = activity.result, !result.isEmpty {
              Button {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(result, forType: .string)
                copied = true
                DispatchQueue.main.asyncAfter(deadline: .now() + 1) { copied = false }
              } label: {
                Label(
                  ArkL10n.text(copied ? .messageCopied : .messageCopy, language),
                  systemImage: copied ? "checkmark" : "doc.on.doc"
                )
              }
              .buttonStyle(.borderless)
            }
            Spacer()
          }
          .font(.system(size: 11))
          .foregroundStyle(ArkPalette.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .frame(maxHeight: 260)
      }
    }
    .padding(.horizontal, 6)
    .padding(.vertical, 4)
    .background(
      expanded
        ? ArkPalette.accent.opacity(0.08)
        : hovering ? ArkPalette.raised.opacity(0.56) : Color.clear,
      in: RoundedRectangle(cornerRadius: 8)
    )
    .overlay(RoundedRectangle(cornerRadius: 10).stroke(
      activity.isError
        ? Color.red.opacity(0.48)
        : activity.isInterrupted ? Color.orange.opacity(0.42) : Color.clear
    ))
    .contentShape(Rectangle())
    .onHover { hovering = $0 }
    .animation(.easeOut(duration: 0.12), value: hovering)
    .animation(.easeOut(duration: 0.12), value: expanded)
  }

  private var expandable: Bool {
    activity.result != nil
      || !activity.arguments.isEmpty
      || activity.callPresentation != nil
      || activity.resultPresentation != nil
      || activity.execution?.steps.isEmpty == false
  }

  private var collapsedSummary: String {
    if let workflow = ArkWorkflowRunPresentation(activity: activity) {
      return ArkL10n.format(
        .workflowMembers,
        language,
        arguments: [String(workflow.memberCount)]
      )
    }
    if let structured = activity.structuredView {
      switch structured {
      case .todo(let list):
        return ArkL10n.format(
          .toolTodoCounts,
          language,
          arguments: [
            String(list.runningCount),
            String(list.pendingCount),
            String(list.completedCount),
          ]
        )
      case .questions(let batch):
        if activity.isError, let result = activity.result { return firstLine(result) }
        return batch.questions.first?.question
          ?? ArkL10n.text(.toolQuestionFallback, language)
      }
    }
    let source = activity.isError
      ? activity.result
      : presentationSummary(activity.callView)
        ?? presentationSummary(activity.resultView)
        ?? activity.result
        ?? activity.arguments
    return source?
      .split(separator: "\n", omittingEmptySubsequences: false)
      .first.map(String.init) ?? ""
  }

  private var toolTitle: String {
    if let workflow = ArkWorkflowRunPresentation(activity: activity) {
      return ArkL10n.format(.workflowRun, language, arguments: [workflow.name])
    }
    if let structured = activity.structuredView {
      switch structured {
      case .todo: return ArkL10n.text(.toolTodoTitle, language)
      case .questions: return ArkL10n.text(.toolQuestionFallback, language)
      }
    }
    return presentationTitle(activity.resultView)
      ?? presentationTitle(activity.callView)
      ?? activity.name
  }

  private var toolSymbol: String {
    if ArkWorkflowRunPresentation(activity: activity) != nil {
      return "point.3.connected.trianglepath.dotted"
    }
    if let structured = activity.structuredView {
      switch structured {
      case .todo: return "checklist"
      case .questions: return "questionmark.bubble"
      }
    }
    switch activity.resultView ?? activity.callView {
    case .terminal: return "terminal"
    case .diff: return "doc.badge.ellipsis"
    case .search: return "magnifyingglass"
    case .read: return "doc.text"
    case .web: return "globe"
    case .generic, nil: return "wrench.and.screwdriver"
    }
  }

  private var leadingSymbol: String {
    activity.isError || activity.isInterrupted ? "circle.fill" : toolSymbol
  }

  private var statusLabel: String? {
    if activity.isInterrupted { return ArkL10n.text(.executionCancelled, language) }
    if activity.result == nil { return ArkL10n.text(.executionRunning, language) }
    if activity.isError { return ArkL10n.text(.executionFailed, language) }
    if let signal = terminalResult?.signal { return signal }
    if let exit = terminalResult?.exitCode, exit != 0 {
      return ArkL10n.format(.toolExitCode, language, arguments: [String(exit)])
    }
    return ArkL10n.text(.executionCompleted, language)
  }

  private var statusColor: Color {
    if activity.isInterrupted { return .orange }
    if activity.result == nil { return ArkPalette.accent }
    if activity.isError || terminalResult?.signal != nil { return .red }
    if let exit = terminalResult?.exitCode, exit != 0 { return .red }
    return ArkPalette.accent
  }

  private var terminalResult: ArkTerminalPresentation? {
    guard case .terminal(let card) = activity.resultView else { return nil }
    return card
  }

  private func presentationTitle(_ presentation: ArkToolPresentation?) -> String? {
    switch presentation {
    case .generic(let card): return card.title
    case .terminal(let card): return card.title
    case .diff(let card): return card.title
    case .search(let card): return card.title
    case .read(let card): return card.title
    case .web(let card): return card.title
    case nil: return nil
    }
  }

  private func presentationSummary(_ presentation: ArkToolPresentation?) -> String? {
    switch presentation {
    case .generic(let card): return card.rawInput ?? card.locations.first?.path
    case .terminal(let card): return card.description ?? card.output
    case .diff(let card):
      return card.diffs.first?.path ?? (card.diffs.isEmpty ? nil : ArkL10n.format(
        .toolDiffFiles,
        language,
        arguments: [String(card.diffs.count)]
      ))
    case .search(let card):
      return card.title ?? ArkL10n.format(
        .toolSearchResults,
        language,
        arguments: [String(card.total)]
      )
    case .read(let card): return card.path
    case .web(let card): return card.answer ?? card.url
    case nil: return nil
    }
  }

  private func firstLine(_ text: String) -> String {
    text.split(separator: "\n", omittingEmptySubsequences: false).first.map(String.init) ?? text
  }
}

private struct NativeContextMeter: View {
  @ObservedObject var model: ArkAppModel
  @State private var presented = false

  private var pressure: ArkContextPressure? {
    ArkContextPressure(projection: model.sessionProjections["contextPressure"])
  }

  private var breakdown: ArkContextBreakdown? {
    ArkContextBreakdown(projection: model.sessionProjections["contextBreakdown"])
  }

  var body: some View {
    if let occupancy = pressure?.occupancy {
      Button {
        presented.toggle()
      } label: {
        ZStack {
          Circle()
            .stroke(ArkPalette.border, lineWidth: 2)
          Circle()
            .trim(from: 0, to: CGFloat(occupancy.percent) / 100)
            .stroke(meterColor(occupancy.percent), style: StrokeStyle(lineWidth: 2, lineCap: .round))
            .rotationEffect(.degrees(-90))
        }
        .frame(width: 18, height: 18)
        .contentShape(Circle())
      }
      .buttonStyle(.plain)
      .help(ArkL10n.format(
        .contextUsedPercent,
        model.languagePreference,
        arguments: [String(occupancy.percent)]
      ))
      .accessibilityLabel(ArkL10n.format(
        .contextUsedPercent,
        model.languagePreference,
        arguments: [String(occupancy.percent)]
      ))
      .accessibilityIdentifier("ark.context.meter")
      .popover(isPresented: $presented, arrowEdge: .top) {
        panel(occupancy)
      }
    }
  }

  private func panel(_ occupancy: ArkContextOccupancy) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .firstTextBaseline) {
        Text(ArkL10n.format(
          .contextUsedPercent,
          model.languagePreference,
          arguments: [String(occupancy.percent)]
        ))
        .font(.system(size: 14, weight: .semibold))
        Spacer(minLength: 20)
        Text(ArkL10n.format(
          .contextApproximate,
          model.languagePreference,
          arguments: [
            ArkTokenFormatting.compact(occupancy.usedTokens),
            ArkTokenFormatting.compact(occupancy.contextWindow),
          ]
        ))
        .font(.system(size: 10, design: .monospaced))
        .foregroundStyle(ArkPalette.secondary)
      }
      ProgressView(value: Double(occupancy.percent), total: 100)
        .tint(meterColor(occupancy.percent))
      if let breakdown {
        Divider()
        contextRow(.contextSystemPrompt, value: breakdown.systemTokens, color: .purple)
        contextRow(.contextTools, value: breakdown.toolsTokens, color: .cyan)
        contextRow(.contextMessages, value: breakdown.messageTokens, color: .blue)
      }
    }
    .padding(14)
    .frame(width: 320)
    .accessibilityIdentifier("ark.context.panel")
  }

  private func contextRow(_ key: ArkL10n.Key, value: Int, color: Color) -> some View {
    HStack(spacing: 8) {
      Circle().fill(color).frame(width: 7, height: 7)
      Text(ArkL10n.text(key, model.languagePreference))
      Spacer()
      Text("~\(ArkTokenFormatting.compact(value))")
        .font(.system(size: 10, design: .monospaced))
        .foregroundStyle(ArkPalette.secondary)
    }
    .font(.system(size: 11))
  }

  private func meterColor(_ percent: Int) -> Color {
    if percent >= 90 { return .red }
    if percent >= 70 { return .orange }
    return ArkPalette.accent
  }
}

enum NativeComposerToolbarFocus: Hashable {
  case sources
  case permission
  case attachment
  case model
  case stop
  case send
}

enum NativeComposerToolbarFocusPolicy {
  static func target(
    for action: NativeComposerFocusAction,
    isSubagent: Bool,
    canStop: Bool,
    canSend: Bool
  ) -> NativeComposerToolbarFocus? {
    guard action != .appKit else { return nil }
    if !isSubagent { return action == .next ? .sources : .model }
    switch action {
    case .next:
      if canStop { return .stop }
      return canSend ? .send : nil
    case .previous:
      if canSend { return .send }
      return canStop ? .stop : nil
    case .appKit:
      return nil
    }
  }
}

private struct NativeComposer: View {
  @ObservedObject var model: ArkAppModel
  var hero = false
  @State private var showDangerConfirmation = false
  @State private var composerHasMarkedText = false
  @State private var composerPanelHeight: CGFloat = 0
  @FocusState private var toolbarFocus: NativeComposerToolbarFocus?

  var body: some View {
    let subagentState = model.selectedSubagentComposerState
    let isSubagent = model.selectedSession?.origin == "subagent"
    let canShowStop = subagentState.canStop(sessionRunning: model.selectedSession?.running == true)
    let canShowSend = subagentState.canSend
      && (model.selectedSession?.running != true || subagentState == .continuable)
    VStack(spacing: 8) {
      if let error = model.composerErrorMessage, !error.isEmpty {
        NativeSettingsNotice(text: error, color: .red, icon: "exclamationmark.triangle.fill")
          .accessibilityIdentifier("ark.composer.error")
          .padding(.horizontal, 8)
      }
      if let interaction = model.selectedPendingInteraction {
        switch interaction {
        case .question(let question):
          if let review = ArkInteractionAPIContract.planReview(from: question) {
            NativePlanReviewPanel(model: model, request: question, review: review)
              .id(question.id)
          } else {
            NativeQuestionPanel(model: model, request: question)
              .id(question.id)
          }
        case .approval(let approval):
          NativeApprovalPanel(model: model, request: approval)
        }
      } else {
        NativeSessionProjectionDock(model: model)
        if model.queuedPrompts.contains(where: { $0.placement == .queued }) {
          NativeQueueDock(model: model, items: model.queuedPrompts)
        }
        if !model.pendingDocuments.isEmpty {
          ScrollView(.horizontal) {
            HStack(spacing: 8) {
              ForEach(Array(model.pendingDocuments.enumerated()), id: \.element.id) { index, document in
                HStack(spacing: 10) {
                  Image(systemName: "doc.text")
                    .font(.system(size: 18))
                    .foregroundStyle(ArkPalette.secondary)
                  VStack(alignment: .leading, spacing: 3) {
                    Text(document.name)
                      .font(.system(size: 11, weight: .semibold))
                      .lineLimit(1)
                    Text(ArkL10n.format(
                      .composerDocumentBounded,
                      model.languagePreference,
                      arguments: [
                        ByteCountFormatter.string(
                          fromByteCount: Int64(document.sourceBytes),
                          countStyle: .file
                        ),
                        String(document.extractedCharacters),
                      ]
                    ))
                    .font(.system(size: 9))
                    .foregroundStyle(ArkPalette.secondary)
                  }
                  Button {
                    model.removePendingDocument(at: index)
                  } label: {
                    Image(systemName: "xmark.circle.fill")
                  }
                  .buttonStyle(.plain)
                  .help(ArkL10n.text(.composerDocumentRemove, model.languagePreference))
                }
                .padding(.horizontal, 10)
                .frame(width: 224, height: 54, alignment: .leading)
                .background(ArkPalette.raised, in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(ArkPalette.border))
                .accessibilityIdentifier("ark.composer.document.\(document.id)")
              }
            }
          }
          .frame(height: 62)
          .padding(.horizontal, 14)
          .padding(.top, 4)
        }
        if !model.pendingImages.isEmpty {
          ScrollView(.horizontal) {
            HStack(spacing: 8) {
              ForEach(Array(model.pendingImages.enumerated()), id: \.offset) { index, image in
                ZStack(alignment: .topTrailing) {
                  Group {
                    if let thumbnail = NSImage(data: image.data) {
                      Image(nsImage: thumbnail)
                        .resizable()
                        .scaledToFill()
                    } else {
                      Image(systemName: "photo")
                    }
                  }
                  .frame(width: 64, height: 64)
                  .clipShape(RoundedRectangle(cornerRadius: 16))
                  .overlay(RoundedRectangle(cornerRadius: 16).stroke(ArkPalette.border))
                  Button {
                    model.removePendingImage(at: index)
                  } label: {
                    Image(systemName: "xmark.circle.fill")
                  }
                  .buttonStyle(.plain)
                  .offset(x: 5, y: -5)
                }
                .help(image.name ?? image.mediaType.rawValue)
              }
            }
          }
          .frame(height: 76)
          .padding(.horizontal, 14)
          .padding(.top, 4)
        }
        if !subagentState.canCompose {
          Label(subagentReadOnlyLabel(subagentState), systemImage: "lock")
            .font(.system(size: 12))
            .foregroundStyle(ArkPalette.secondary)
            .frame(maxWidth: .infinity, minHeight: 64, alignment: .leading)
            .padding(.horizontal, 12)
        } else {
          ZStack(alignment: .topLeading) {
            if model.composer.isEmpty && !composerHasMarkedText {
              Text(ArkL10n.text(
                hero ? .composerHeroPlaceholder : .composerPlaceholder,
                model.languagePreference
              ))
                .font(.system(size: 14))
                .foregroundStyle(ArkPalette.secondary)
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
                .allowsHitTesting(false)
            }
            NativeComposerTextView(
              text: model.composer,
              references: model.composerReferenceOccurrences,
              isComposing: $composerHasMarkedText,
              focusRevision: model.composerFocusRevision,
              requestedCaret: model.composerRequestedCaret,
              textChanged: model.composerTextDidChange,
              selectionChanged: model.composerSelectionDidChange,
              handleMenuKey: model.handleComposerMenuKey,
              moveFocus: { action in
                DispatchQueue.main.async {
                  toolbarFocus = NativeComposerToolbarFocusPolicy.target(
                    for: action,
                    isSubagent: isSubagent,
                    canStop: canShowStop,
                    canSend: canShowSend
                  )
                }
              },
              referenceDeletionRange: model.composerReferenceDeletionRange,
              submit: model.sendComposer,
              submitAlternate: model.sendComposerAlternate,
              pasteImage: { data, type in model.addPastedImage(data: data, mediaType: type) },
              pasteDocument: model.addPastedDocument,
              addAttachmentURLs: model.addAttachmentURLs
            )
          }
          .frame(
            minHeight: hero ? 40 : 68,
            idealHeight: hero ? 40 : 76,
            maxHeight: hero ? 96 : 144
          )
        }
        if model.selectedPendingInteraction == nil {
          HStack {
          if isSubagent {
            Label(
              ArkL10n.text(
                subagentState == .continuable
                  ? .composerSubagentContinuable
                  : .composerSubagentReadOnly,
                model.languagePreference
              ),
              systemImage: "point.3.filled.connected.trianglepath.dotted"
            )
            .font(.system(size: 11))
            .foregroundStyle(ArkPalette.secondary)
            Spacer()
          } else {
            Button(action: model.openComposerSourceLauncher) {
              Image(systemName: "plus")
            }
            .buttonStyle(.borderless)
            .focusable()
            .focused($toolbarFocus, equals: .sources)
            .help(ArkL10n.text(.composerCapabilityMenu, model.languagePreference))
            .accessibilityLabel(ArkL10n.text(.composerCapabilityMenu, model.languagePreference))
            .accessibilityIdentifier("ark.composer.sources")
            Menu {
              Button(ArkL10n.text(.permissionReadOnly, model.languagePreference)) {
                model.setPermissionPreset("read-only")
              }
              Button(ArkL10n.text(.permissionWorkspaceAccess, model.languagePreference)) {
                model.setPermissionPreset("workspace-write")
              }
              Button(ArkL10n.text(.permissionFullAccess, model.languagePreference)) {
                showDangerConfirmation = true
              }
            } label: {
              Label(model.composerPermissionLabel, systemImage: "shield")
                .font(.system(size: 12))
                .foregroundStyle(ArkPalette.secondary)
            }
            .menuStyle(.borderlessButton)
            .focusable()
            .focused($toolbarFocus, equals: .permission)
            .accessibilityIdentifier("ark.composer.permission")
            Button(action: chooseAttachments) { Image(systemName: "paperclip") }
              .buttonStyle(.borderless)
              .focusable()
              .focused($toolbarFocus, equals: .attachment)
              .help(ArkL10n.text(.composerAttach, model.languagePreference))
              .accessibilityLabel(ArkL10n.text(.composerAttach, model.languagePreference))
              .accessibilityIdentifier("ark.composer.attachment")
            Spacer()
            Menu {
              if let catalog = model.composerModelCatalog {
                ForEach(ArkProviderPresentation.groups(ArkProviderPresentation.primaryModelGroups(catalog.groups), id: { $0.id }, name: { $0.name })) { family in
                  Menu {
                    ForEach(family.entries) { group in
                      providerModelItems(group)
                    }
                  } label: {
                    Label {
                      Text(family.name)
                    } icon: {
                      ArkProviderMark(providerID: family.entries.first?.id ?? family.id, label: family.name, size: 16)
                    }
                  }
                }
                if !catalog.failures.isEmpty {
                  Divider()
                  ForEach(catalog.failures) { failure in
                    Text("\(failure.name)：\(failure.message)")
                  }
                }
              } else {
                Text(ArkL10n.text(.composerNoModels, model.languagePreference))
              }
            } label: {
              Text(model.composerModelLabel)
                .font(.system(size: 12))
                .foregroundStyle(ArkPalette.secondary)
                .lineLimit(1)
            }
            .menuStyle(.borderlessButton)
            .focusable()
            .focused($toolbarFocus, equals: .model)
            .accessibilityIdentifier("ark.composer.model")
          }
        NativeContextMeter(model: model)
        if canShowStop {
          Button(action: model.cancelSelectedSession) {
            Image(systemName: "stop.fill")
              .frame(width: 34, height: 34)
              .foregroundStyle(Color.white)
              .background(ArkPalette.accent, in: Circle())
          }
          .buttonStyle(.plain)
          .focusable()
          .focused($toolbarFocus, equals: .stop)
          .help(ArkL10n.text(.composerStop, model.languagePreference))
          .accessibilityLabel(ArkL10n.text(.composerStop, model.languagePreference))
          .accessibilityIdentifier("ark.composer.stop")
        }
        if canShowSend {
          Button(action: model.sendComposer) {
            Image(systemName: "arrow.up")
              .frame(width: 34, height: 34)
              .background(ArkPalette.accent, in: Circle())
          }
          .buttonStyle(.plain)
          .focusable()
          .focused($toolbarFocus, equals: .send)
          .keyboardShortcut(.return, modifiers: [.command])
          .accessibilityIdentifier("ark.composer.send")
          .accessibilityLabel(ArkL10n.text(
            model.composerModelRouteAvailable ? .composerSend : .composerChooseAvailableModel,
            model.languagePreference
          ))
          .disabled(
            model.composer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
              && model.pendingImages.isEmpty
              && model.pendingDocuments.isEmpty
              || model.composerSubmissionInFlight
              || !model.composerModelRouteAvailable
            )
          .help(ArkL10n.text(
            model.composerModelRouteAvailable ? .composerSend : .composerChooseAvailableModel,
            model.languagePreference
          ))
        }
          }
          .padding(.horizontal, 12)
          .padding(.bottom, 10)
        }
      }
    }
    .background(ArkPalette.panel, in: RoundedRectangle(cornerRadius: 22))
    .overlay(
      RoundedRectangle(cornerRadius: 22)
        .stroke(ArkPalette.border, lineWidth: 1)
    )
    .shadow(color: Color.black.opacity(0.14), radius: 10, y: 4)
    .background(
      GeometryReader { proxy in
        Color.clear.preference(key: ComposerPanelHeightKey.self, value: proxy.size.height)
      }
    )
    .onPreferenceChange(ComposerPanelHeightKey.self) { composerPanelHeight = $0 }
    .overlay(alignment: .top) {
      // The launcher must not participate in the composer's measured height.
      // Inserting it into this VStack shrinks the transcript viewport and can
      // drive SwiftUI's LazyVStack into a permanent placement/update loop for
      // a large conversation. Aligning the overlay's bottom above the
      // composer preserves one viewport size while keeping the same launcher
      // owner, data, focus, and accessibility tree. The height ceiling keeps
      // the menu inside the composer panel so the usage footer below it is
      // never covered.
      if model.composerSuggestions.isOpen {
        NativeComposerSuggestionPanel(model: model, maxHeight: max(140, composerPanelHeight - 16))
          .padding(.horizontal, 8)
          .alignmentGuide(.top) { dimensions in
            dimensions[.bottom] + 8
          }
          .transition(.opacity)
          .zIndex(3)
      }
    }
    .sheet(isPresented: $showDangerConfirmation) {
      NativeDangerPermissionConfirmation(
        isPresented: $showDangerConfirmation,
        language: model.languagePreference,
        confirm: { model.setPermissionPreset("danger-full-access") }
      )
    }
  }

  @ViewBuilder
  private func providerModelItems(_ group: ArkModelProviderGroup) -> some View {
    ForEach(group.models) { item in
      if let efforts = item.reasoning?.efforts, !efforts.isEmpty {
        Menu(item.name) {
          ForEach(efforts) { effort in
            Button {
              model.selectModel(ArkModelSelection(provider: group.id, model: item.id, reasoningEffort: effort.id))
            } label: {
              Label(effort.name, systemImage: selectedModelMenuCheckmark(
                provider: group.id, modelID: item.id, effort: effort.id))
            }
          }
        }
      } else {
        Button {
          model.selectModel(ArkModelSelection(provider: group.id, model: item.id))
        } label: {
          Label(item.name, systemImage: selectedModelMenuCheckmark(provider: group.id, modelID: item.id, effort: nil))
        }
      }
    }
  }

  /// 模型菜单选中态：与 effectiveModelSelection（draft 或 session 当前值）一致时打勾。
  private func selectedModelMenuCheckmark(provider: String, modelID: String, effort: String?) -> String {
    guard let current = model.effectiveModelSelection,
          current.provider == provider,
          current.model == modelID,
          current.reasoningEffort == effort
    else { return "" }
    return "checkmark"
  }

  private func subagentReadOnlyLabel(_ state: ArkSubagentComposerState) -> String {
    switch state {
    case .loading: return ArkL10n.text(.subagentLineageLoading, model.languagePreference)
    case .oneShot: return ArkL10n.text(.subagentLineageOneShot, model.languagePreference)
    case .parentUnavailable:
      return ArkL10n.text(.subagentLineageParentUnavailable, model.languagePreference)
    case .regular, .continuable: return ""
    }
  }

  private func chooseAttachments() {
    let panel = NSOpenPanel()
    panel.canChooseFiles = true
    panel.canChooseDirectories = false
    panel.allowsMultipleSelection = true
    panel.allowedContentTypes = [
      .png, .jpeg, .gif, .webP, .plainText,
      UTType(filenameExtension: "md"),
      UTType(filenameExtension: "doc"),
      UTType(filenameExtension: "docx"),
      UTType(filenameExtension: "odt"),
      UTType(filenameExtension: "rtf"),
    ].compactMap { $0 }
    panel.prompt = ArkL10n.text(.composerAttach, model.languagePreference)
    guard panel.runModal() == .OK else { return }
    model.addAttachmentURLs(panel.urls)
  }
}

private struct ComposerPanelHeightKey: PreferenceKey {
  static var defaultValue: CGFloat = 0
  static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

private struct NativeComposerSuggestionPanel: View {
  @ObservedObject var model: ArkAppModel
  /// Height ceiling handed down from the composer panel so the menu never
  /// extends past the composer's own bottom edge (the usage footer stays
  /// visible while the menu is open).
  var maxHeight: CGFloat? = nil

  var body: some View {
    VStack(spacing: 0) {
      if model.composerLauncherHasBackNavigation {
        Button(action: model.showComposerSourceRoot) {
          HStack(spacing: 8) {
            Image(systemName: "chevron.left")
            Text(model.composerLauncherNavigationTitle)
              .font(.system(size: 12, weight: .semibold))
            Spacer()
            Text(ArkL10n.text(.composerSourcesBack, model.languagePreference))
              .font(.system(size: 10))
              .foregroundStyle(ArkPalette.secondary)
          }
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("ark.composer.suggestions.back")
        .padding(.horizontal, 12)
        .frame(height: 34)
      }
      if model.composerLauncherSearchVisible {
        NativeComposerSearchField(
          text: model.composerLauncherQuery,
          placeholder: model.composerLauncherSearchPlaceholder,
          focusRevision: model.composerLauncherFocusRevision,
          textChanged: model.updateComposerLauncherQuery,
          handleMenuKey: { model.handleComposerMenuKey($0, isComposing: false) }
        )
        .accessibilityIdentifier("ark.composer.suggestions.search")
        .padding(.horizontal, 10)
        .frame(height: 34)
        .background(ArkPalette.raised, in: RoundedRectangle(cornerRadius: 8))
        .padding(.horizontal, 8)
        .padding(.bottom, 4)
      }
      if model.composerSuggestions.loading {
        HStack(spacing: 8) {
          ProgressView().controlSize(.small)
          Text(ArkL10n.text(.composerSourcesLoading, model.languagePreference))
            .font(.system(size: 12))
            .foregroundStyle(ArkPalette.secondary)
          Spacer()
        }
        .padding(.horizontal, 12)
        .frame(height: 38)
      } else if model.composerSuggestions.candidates.isEmpty {
        Text(
          model.composerSuggestions.error
            ?? model.composerLauncherEmptyMessage
        )
        .font(.system(size: 12))
        .foregroundStyle(ArkPalette.secondary)
        .frame(maxWidth: .infinity, minHeight: 38, alignment: .leading)
        .padding(.horizontal, 12)
      } else {
        ScrollViewReader { proxy in
          ScrollView {
            LazyVStack(spacing: 2) {
              ForEach(Array(model.composerSuggestions.candidates.enumerated()), id: \.element.id) { index, item in
                if let section = item.section,
                   index == 0 || model.composerSuggestions.candidates[index - 1].section != section
                {
                  Text(sectionTitle(section))
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(ArkPalette.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 10)
                    .padding(.top, index == 0 ? 4 : 8)
                    .padding(.bottom, 2)
                    .accessibilityAddTraits(.isHeader)
                }
                Button {
                  model.chooseComposerSuggestion(item.id)
                } label: {
                  NativeComposerSuggestionRow(
                    item: item,
                    selected: index == model.composerSuggestions.highlightedIndex,
                    language: model.languagePreference
                  )
                }
                .buttonStyle(.plain)
                .id(item.id)
                .accessibilityIdentifier("ark.composer.suggestion.\(item.id)")
                .accessibilityLabel(suggestionAccessibilityLabel(item))
                .accessibilityValue(index == model.composerSuggestions.highlightedIndex
                  ? ArkL10n.text(.composerSuggestionSelected, model.languagePreference)
                  : "")
              }
            }
            .padding(4)
          }
          .frame(height: listHeight)
          .onChange(of: model.composerSuggestions.highlightedIndex) { index in
            guard let index,
                  model.composerSuggestions.candidates.indices.contains(index)
            else { return }
            proxy.scrollTo(model.composerSuggestions.candidates[index].id, anchor: .center)
          }
        }
      }
    }
    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
    .overlay(RoundedRectangle(cornerRadius: 12).stroke(ArkPalette.border))
    .shadow(color: .black.opacity(0.18), radius: 12, y: 5)
    .accessibilityIdentifier("ark.composer.suggestions")
  }

  private var listHeight: CGFloat {
    let sectionCount = Set(model.composerSuggestions.candidates.compactMap(\.section)).count
    let content = max(46, CGFloat(model.composerSuggestions.candidates.count) * 44
      + CGFloat(sectionCount) * 24 + 8)
    guard let maxHeight, maxHeight > 0 else { return min(320, content) }
    // The back-navigation header stacks above the list inside the same
    // panel; deduct it so panel total stays within the composer ceiling.
    let backAllowance: CGFloat = model.composerLauncherHasBackNavigation ? 34 : 0
    return min(320, max(46, maxHeight - backAllowance), content)
  }

  private func sectionTitle(_ section: ArkComposerSuggestionSection) -> String {
    switch section {
    case .add: return ArkL10n.text(.composerLauncherAddSection, model.languagePreference)
    case .tasks: return ArkL10n.text(.composerLauncherTasksSection, model.languagePreference)
    case .plugins: return ArkL10n.text(.composerLauncherPluginsSection, model.languagePreference)
    }
  }

  private func suggestionAccessibilityLabel(_ item: ArkComposerSuggestion) -> String {
    var parts: [String] = []
    if let section = item.section { parts.append(sectionTitle(section)) }
    parts.append(item.title)
    parts.append(composerSuggestionKindLabel(item.kind, language: model.languagePreference))
    if item.userOnly {
      parts.append(ArkL10n.text(.composerSourceUserOnly, model.languagePreference))
    }
    if let detail = item.detail, !detail.isEmpty { parts.append(detail) }
    return parts.joined(separator: model.languagePreference == .zh ? "，" : ", ")
  }

}

private struct NativeComposerSuggestionRow: View {
  let item: ArkComposerSuggestion
  let selected: Bool
  let language: ArkLanguagePreference

  var body: some View {
    HStack(spacing: 9) {
      Image(systemName: icon(for: item))
        .frame(width: 16)
        .foregroundStyle(ArkPalette.secondary)
      VStack(alignment: .leading, spacing: 2) {
        HStack(spacing: 7) {
          Text(item.title)
            .font(.system(size: 13, weight: .medium))
            .foregroundStyle(ArkPalette.primary)
            .lineLimit(1)
          if item.section == nil, item.kind != .skillCollection {
            Text(item.userOnly
              ? "\(composerSuggestionKindLabel(item.kind, language: language)) · \(ArkL10n.text(.composerSourceUserOnly, language))"
              : composerSuggestionKindLabel(item.kind, language: language))
              .font(.system(size: 10, weight: .medium))
              .foregroundStyle(ArkPalette.secondary)
          }
        }
        if let detail = compactDetail {
          Text(detail)
            .font(.system(size: 11))
            .foregroundStyle(ArkPalette.secondary)
            .lineLimit(1)
            .truncationMode(.tail)
        }
      }
      Spacer(minLength: 8)
    }
    .padding(.horizontal, 10)
    .frame(maxWidth: .infinity, minHeight: 42, idealHeight: 42, maxHeight: 42, alignment: .leading)
    .contentShape(Rectangle())
    .background(
      selected ? ArkPalette.accent.opacity(0.16) : Color.clear,
      in: RoundedRectangle(cornerRadius: 8)
    )
  }

  private var compactDetail: String? {
    guard let detail = item.detail, !detail.isEmpty else { return nil }
    let limit = 180
    return detail.count <= limit ? detail : String(detail.prefix(limit)) + "…"
  }

  private func icon(for item: ArkComposerSuggestion) -> String {
    switch item.id {
    case "command:goal": return "scope"
    case "command:plan": return "lightbulb"
    case "command:compact": return "rectangle.compress.vertical"
    default: break
    }
    switch item.kind {
    case .command: return "terminal"
    case .skill: return "sparkles"
    case .skillCollection: return "square.grid.2x2"
    case .fileCollection: return "paperclip"
    case .sessionCollection: return "bubble.left.and.bubble.right"
    case .file: return "doc"
    case .directory: return "folder"
    case .session: return "bubble.left.and.bubble.right"
    }
  }

}

private func composerSuggestionKindLabel(
  _ kind: ArkComposerSuggestionKind,
  language: ArkLanguagePreference
) -> String {
  switch kind {
  case .command: return ArkL10n.text(.composerSourceCommand, language)
  case .skill: return ArkL10n.text(.composerSourceSkill, language)
  case .skillCollection: return ArkL10n.text(.composerSkillsGroup, language)
  case .fileCollection: return ArkL10n.text(.composerSourceFolder, language)
  case .sessionCollection: return ArkL10n.text(.composerSourceSession, language)
  case .file: return ArkL10n.text(.composerSourceFile, language)
  case .directory: return ArkL10n.text(.composerSourceFolder, language)
  case .session: return ArkL10n.text(.composerSourceSession, language)
  }
}

private struct NativeApprovalPanel: View {
  @ObservedObject var model: ArkAppModel
  let request: ArkApprovalRequest
  private var busy: Bool { model.interactionIsResponding(request.id) }
  private var language: ArkLanguagePreference { model.languagePreference }
  private var activity: ArkToolActivity? {
    request.callID.flatMap { callID in model.toolActivities.first { $0.id == callID } }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 8) {
        NativeSessionStatusLight(state: .needsDecision, language: language)
          .frame(width: 8, height: 8)
        Label(ArkL10n.text(.approvalWaiting, language), systemImage: "exclamationmark.shield")
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(Color.orange)
      }
      if let reason = request.reason, !reason.isEmpty {
        NativeMarkdownText(text: reason)
      } else {
        Text(ArkL10n.format(.approvalEscalation, language, arguments: [request.toolName]))
          .font(.system(size: 13, weight: .semibold))
      }
      Text(request.toolName)
        .font(.system(size: 11, weight: .medium, design: .monospaced))
        .foregroundStyle(ArkPalette.secondary)
      if let activity {
        NativeToolPresentationSummary(activity: activity, language: language)
        if !activity.arguments.isEmpty {
          ScrollView(.horizontal) {
            Text(activity.arguments)
              .font(.system(size: 10, design: .monospaced))
              .textSelection(.enabled)
          }
          .frame(maxHeight: 90)
          .padding(8)
          .background(ArkPalette.raised, in: RoundedRectangle(cornerRadius: 8))
        }
      }
      HStack {
        if busy { ProgressView().controlSize(.small) }
        Spacer()
        Button(ArkL10n.text(.approvalReject, language)) {
          model.answerApproval(request, decision: .reject)
        }
          .disabled(busy)
          .accessibilityIdentifier("ark.interaction.approval.reject")
        Button(ArkL10n.text(.approvalAllowOnce, language)) {
          model.answerApproval(request, decision: .allowOnce)
        }
          .buttonStyle(.borderedProminent)
          .disabled(busy)
          .accessibilityIdentifier("ark.interaction.approval.allow-once")
      }
    }
    .padding(14)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("ark.interaction.approval")
  }
}

private struct NativePlanReviewPanel: View {
  @ObservedObject var model: ArkAppModel
  let request: ArkQuestionRequest
  let review: ArkPlanReview
  private var busy: Bool { model.interactionIsResponding(request.id) }
  private var language: ArkLanguagePreference { model.languagePreference }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 8) {
        NativeSessionStatusLight(state: .needsDecision, language: language)
          .frame(width: 8, height: 8)
        Label(ArkL10n.text(.planReviewHeader, language), systemImage: "doc.text.magnifyingglass")
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(Color.orange)
        Spacer()
        if busy { ProgressView().controlSize(.small) }
      }
      Text(review.question)
        .font(.system(size: 13, weight: .semibold))
      ScrollView {
        NativeMarkdownText(text: review.plan)
          .frame(maxWidth: .infinity, alignment: .leading)
          .textSelection(.enabled)
      }
      .frame(maxHeight: 280)
      .padding(10)
      .background(ArkPalette.raised, in: RoundedRectangle(cornerRadius: 9))
      HStack(spacing: 8) {
        Button(ArkL10n.text(.planReviewDiscuss, language)) {
          model.cancelQuestions(request)
        }
        .disabled(busy)
        .accessibilityIdentifier("ark.interaction.plan-review.discuss")
        Spacer()
        if let decline = review.decline {
          Button(ArkL10n.text(.planReviewDecline, language)) {
            answer(decline)
          }
          .disabled(busy)
          .help(decline.description ?? decline.label)
          .accessibilityIdentifier("ark.interaction.plan-review.decline")
        }
        Button(ArkL10n.text(.planReviewApprove, language)) {
          answer(review.approve)
        }
        .buttonStyle(.borderedProminent)
        .disabled(busy)
        .help(review.approve.description ?? review.approve.label)
        .accessibilityIdentifier("ark.interaction.plan-review.approve")
      }
    }
    .padding(14)
    .accessibilityElement(children: .contain)
    .accessibilityLabel(review.question)
    .accessibilityIdentifier("ark.interaction.plan-review")
  }

  private func answer(_ option: ArkQuestionOption) {
    model.answerQuestions(
      request,
      answers: [ArkQuestionAnswer(id: review.questionID, selected: [option.label])]
    )
  }
}

private struct NativeQuestionPanel: View {
  @ObservedObject var model: ArkAppModel
  let request: ArkQuestionRequest
  @State private var selections: [String: Set<String>] = [:]
  @State private var custom: [String: String] = [:]
  @State private var currentIndex = 0
  private var busy: Bool { model.interactionIsResponding(request.id) }
  private var language: ArkLanguagePreference { model.languagePreference }
  private var currentQuestion: ArkQuestion? {
    request.questions.indices.contains(currentIndex) ? request.questions[currentIndex] : nil
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 14) {
        HStack {
          NativeSessionStatusLight(state: .needsDecision, language: language)
            .frame(width: 8, height: 8)
          Label(ArkL10n.text(.interactionDecisionRequired, language), systemImage: "questionmark.bubble")
            .font(.system(size: 13, weight: .semibold))
          Spacer()
          Text("\(min(currentIndex + 1, request.questions.count)) / \(request.questions.count)")
            .font(.system(size: 10, design: .monospaced))
            .foregroundStyle(ArkPalette.secondary)
        }
        if let question = currentQuestion {
          VStack(alignment: .leading, spacing: 8) {
            if let header = question.header {
              Text(header.uppercased())
                .font(.system(size: 9, weight: .bold))
                .foregroundStyle(ArkPalette.secondary)
            }
            Text(question.question)
              .font(.system(size: 13, weight: .semibold))
            if let detail = question.detail {
              NativeMarkdownText(text: detail)
                .foregroundStyle(ArkPalette.secondary)
            }
            ForEach(question.options, id: \.label) { option in
              Button {
                toggle(option.label, for: question)
              } label: {
                HStack(alignment: .top) {
                  Image(systemName: isSelected(option.label, for: question) ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(isSelected(option.label, for: question) ? ArkPalette.accent : ArkPalette.secondary)
                  VStack(alignment: .leading, spacing: 2) {
                    Text(option.label)
                    if let description = option.description {
                      Text(description)
                        .font(.system(size: 10))
                        .foregroundStyle(ArkPalette.secondary)
                    }
                  }
                  Spacer()
                }
                .contentShape(Rectangle())
              }
              .buttonStyle(.plain)
              .disabled(busy)
            }
            TextField(ArkL10n.text(.questionCustomAnswer, language), text: Binding(
              get: { custom[question.id] ?? "" },
              set: { custom[question.id] = $0 }
            ))
            .textFieldStyle(.roundedBorder)
            .disabled(busy)
          }
          .padding(10)
          .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 9))
        }
        HStack {
          Button(ArkL10n.text(.questionCancel, language), role: .destructive) {
            model.cancelQuestions(request)
          }
            .disabled(busy)
            .accessibilityIdentifier("ark.interaction.question.cancel")
          if busy { ProgressView().controlSize(.small) }
          Spacer()
          if currentIndex > 0 {
            Button(ArkL10n.text(.questionPrevious, language)) { currentIndex -= 1 }
              .disabled(busy)
          }
          if currentIndex < request.questions.count - 1 {
            Button(ArkL10n.text(.questionSkip, language)) { skipCurrent() }
              .disabled(busy)
            Button(ArkL10n.text(.questionNext, language)) { advance() }
              .buttonStyle(.borderedProminent)
              .disabled(busy || !currentIsAnswered)
          } else {
            Button(ArkL10n.text(.questionSkip, language)) { skipAndSubmit() }
              .disabled(busy)
            Button(ArkL10n.text(.questionSubmit, language)) { submit() }
              .buttonStyle(.borderedProminent)
              .disabled(busy || !currentIsAnswered)
              .accessibilityIdentifier("ark.interaction.question.submit")
          }
        }
      }
      .padding(14)
    }
    .frame(maxHeight: 360)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("ark.interaction.question")
  }

  private var currentIsAnswered: Bool {
    guard let question = currentQuestion else { return false }
    return !(selections[question.id] ?? []).isEmpty
      || !(custom[question.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  private func isSelected(_ label: String, for question: ArkQuestion) -> Bool {
    selections[question.id]?.contains(label) == true
  }

  private func toggle(_ label: String, for question: ArkQuestion) {
    if question.multiSelect {
      var values = selections[question.id] ?? []
      if values.contains(label) { values.remove(label) } else { values.insert(label) }
      selections[question.id] = values
    } else {
      selections[question.id] = isSelected(label, for: question) ? [] : [label]
      custom[question.id] = ""
    }
  }

  private func submit() {
    let answers = request.questions.map { question in
      let customText = (custom[question.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
      return ArkQuestionAnswer(
        id: question.id,
        selected: question.multiSelect || customText.isEmpty
          ? Array(selections[question.id] ?? []).sorted()
          : [],
        custom: customText.isEmpty ? nil : customText
      )
    }
    model.answerQuestions(request, answers: answers)
  }

  private func advance() {
    currentIndex = min(currentIndex + 1, max(0, request.questions.count - 1))
  }

  private func skipCurrent() {
    if let question = currentQuestion {
      selections[question.id] = []
      custom[question.id] = ""
    }
    advance()
  }

  private func skipAndSubmit() {
    if let question = currentQuestion {
      selections[question.id] = []
      custom[question.id] = ""
    }
    submit()
  }
}

private struct NativeDangerPermissionConfirmation: View {
  @Binding var isPresented: Bool
  let language: ArkLanguagePreference
  let confirm: () -> Void
  @State private var acknowledged = false

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      Label(
        ArkL10n.text(.permissionDangerTitle, language),
        systemImage: "exclamationmark.triangle.fill"
      )
        .font(.system(size: 18, weight: .semibold))
        .foregroundStyle(Color.orange)
      Text(ArkL10n.text(.permissionDangerDetail, language))
        .font(.system(size: 13))
      Toggle(ArkL10n.text(.permissionDangerAcknowledgement, language), isOn: $acknowledged)
      HStack {
        Spacer()
        Button(ArkL10n.text(.commonCancel, language)) { isPresented = false }
        Button(ArkL10n.text(.permissionDangerConfirm, language)) {
          confirm()
          isPresented = false
        }
        .buttonStyle(.borderedProminent)
        .disabled(!acknowledged)
      }
    }
    .padding(24)
    .frame(width: 480)
    .background(ArkPalette.panel)
  }
}

private struct NativeQueueDock: View {
  @ObservedObject var model: ArkAppModel
  let items: [ArkQueuedPrompt]
  @State private var editingItemID: String?
  @State private var editDraft = ""
  @State private var collapsed = true

  private var queued: [ArkQueuedPrompt] {
    items.filter { $0.placement == .queued }
  }

  private var showsRows: Bool {
    queued.count <= 1
      || !collapsed
      || editingItemID != nil
      || queued.contains { model.queueMutationIsRunning($0.id) }
  }

  var body: some View {
    VStack(spacing: 5) {
      if queued.count > 1 {
        Button {
          guard editingItemID == nil else { return }
          collapsed.toggle()
        } label: {
          HStack(spacing: 7) {
            Image(systemName: showsRows ? "chevron.down" : "chevron.right")
              .font(.system(size: 9, weight: .semibold))
            Text(ArkL10n.format(
              .queueCount,
              model.languagePreference,
              arguments: [String(queued.count)]
            ))
              .font(.system(size: 11, weight: .medium))
            Spacer()
          }
          .frame(height: 36)
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(editingItemID != nil)
        .accessibilityIdentifier("ark.queue.toggle")
      }
      if showsRows {
        ScrollView {
          VStack(spacing: 0) {
            ForEach(queued) { item in
              let mutationRunning = model.queueMutationIsRunning(item.id)
              VStack(spacing: 5) {
                HStack(spacing: 8) {
                  Image(systemName: "clock")
                    .foregroundStyle(ArkPalette.secondary)
                  Text(item.text ?? ArkL10n.text(
                    item.hasNonTextContent ? .queuePendingNonText : .queuePendingMessage,
                    model.languagePreference
                  ))
                    .font(.system(size: 10))
                    .lineLimit(1)
                  Spacer()
                  if model.selectedSession?.origin != "subagent",
                     item.text != nil,
                     !item.hasNonTextContent
                  {
                    Button(ArkL10n.text(.queueEdit, model.languagePreference)) {
                      editingItemID = item.id
                      editDraft = item.text ?? ""
                    }
                    .buttonStyle(.borderless)
                    .disabled(mutationRunning)
                    .accessibilityIdentifier("ark.queue.edit.\(item.id)")
                  }
                  if model.selectedSession?.origin != "subagent",
                     model.selectedSession?.running == true
                  {
                    Button(ArkL10n.text(.queueSteer, model.languagePreference)) {
                      model.updateQueuedPrompt(item, mutation: .steer)
                    }
                      .buttonStyle(.borderless)
                      .disabled(mutationRunning)
                      .accessibilityIdentifier("ark.queue.steer.\(item.id)")
                  }
                  if model.selectedSession?.origin != "subagent" {
                    Button {
                      model.updateQueuedPrompt(item, mutation: .remove)
                    } label: {
                      Image(systemName: "xmark")
                    }
                    .buttonStyle(.plain)
                    .disabled(mutationRunning)
                    .accessibilityLabel(ArkL10n.text(.queueRemove, model.languagePreference))
                    .accessibilityIdentifier("ark.queue.remove.\(item.id)")
                  }
                }
                .frame(minHeight: 36)
                if editingItemID == item.id {
                  HStack(spacing: 7) {
                    TextField(
                      ArkL10n.text(.queueEditPlaceholder, model.languagePreference),
                      text: $editDraft
                    )
                      .textFieldStyle(.roundedBorder)
                      .accessibilityIdentifier("ark.queue.editor.\(item.id)")
                    Button(ArkL10n.text(.commonCancel, model.languagePreference)) {
                      editingItemID = nil
                    }
                    .accessibilityIdentifier("ark.queue.cancel.\(item.id)")
                    Button(ArkL10n.text(.commonSave, model.languagePreference)) {
                      model.updateQueuedPrompt(item, mutation: .editText(editDraft))
                      editingItemID = nil
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(editDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .accessibilityIdentifier("ark.queue.save.\(item.id)")
                  }
                  .font(.system(size: 10))
                }
              }
              .accessibilityIdentifier("ark.queue.item.\(item.id)")
            }
          }
        }
        .frame(maxHeight: 180)
      }
    }
    .padding(.horizontal, 8)
    .background(ArkPalette.panel.opacity(0.68), in: RoundedRectangle(cornerRadius: 10))
    .accessibilityIdentifier("ark.queue.dock")
  }
}

private struct NativeSessionStatsBar: View {
  @ObservedObject var model: ArkAppModel

  private var stats: JSONValue? { model.sessionProjections["sessionStats"] }
  private var tokens: JSONValue? { model.sessionProjections["tokenUsage"] }
  private var line: String {
    var groups: [String] = []
    if let steps = int(stats?["steps"]), steps > 0 {
      let turns = int(stats?["turns"]) ?? 0
      groups.append(ArkL10n.format(
        .statsTurnsSteps,
        model.languagePreference,
        arguments: ["\(turns)", "\(steps)"]
      ))

      var durations: [String] = []
      if let llm = number(stats?["llmMs"]), llm > 0 {
        durations.append("LLM \(duration(llm))")
      }
      if let tool = number(stats?["toolMs"]), tool > 0 {
        durations.append(ArkL10n.format(
          .statsToolCalls,
          model.languagePreference,
          arguments: [duration(tool)]
        ))
      }
      if !durations.isEmpty { groups.append(durations.joined(separator: " · ")) }

      var speeds: [String] = []
      if let ttft = number(stats?["ttftMs"]),
         let samples = int(stats?["ttftSteps"]), samples > 0 {
        speeds.append(ArkL10n.format(
          .statsFirstTokenAverage,
          model.languagePreference,
          arguments: [duration(ttft / Double(samples))]
        ))
      }
      if let decode = number(stats?["decodeMs"]), decode > 0,
         let output = number(stats?["decodeTokens"]) {
        speeds.append("\(formatThroughput(output / (decode / 1_000))) tok/s")
      }
      if !speeds.isEmpty { groups.append(speeds.joined(separator: " · ")) }
    }

    if let tokens {
      let uncached = int(tokens["uncachedInputTokens"]) ?? 0
      let cached = int(tokens["cacheReadTokens"]) ?? 0
      let written = int(tokens["cacheWriteTokens"]) ?? 0
      let output = int(tokens["outputTokens"]) ?? 0
      let billedInput = uncached + cached + written
      if billedInput > 0 || output > 0 {
        if let hit = cacheHitPercent(cached: cached, total: billedInput) {
          groups.append(ArkL10n.format(
            .statsCacheHit,
            model.languagePreference,
            arguments: [hit]
          ))
        }
        groups.append(ArkL10n.format(
          .statsInputOutput,
          model.languagePreference,
          arguments: [ArkTokenFormatting.compact(billedInput), ArkTokenFormatting.compact(output)]
        ))
      }
    }
    return groups.joined(separator: " | ")
  }

  var body: some View {
    if !line.isEmpty {
      Text(line)
      .font(.system(size: 9, design: .monospaced))
      .foregroundStyle(ArkPalette.secondary)
      .lineLimit(1)
      .truncationMode(.tail)
      .help(line)
      .padding(.horizontal, 12)
      .padding(.top, 6)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  private func number(_ value: JSONValue?) -> Double? { value?.numberValue }
  private func int(_ value: JSONValue?) -> Int? { value?.numberValue.map(Int.init) }
  private func duration(_ milliseconds: Double) -> String {
    let seconds = milliseconds / 1_000
    if seconds < 60 { return "\(Double((seconds * 10).rounded()) / 10)s" }
    let whole = Int(seconds.rounded())
    return "\(whole / 60)m\(whole % 60)s"
  }

  private func formatThroughput(_ value: Double) -> String {
    value >= 100 ? String(Int(value.rounded())) : String(Double((value * 10).rounded()) / 10)
  }

  private func cacheHitPercent(cached: Int, total: Int) -> String? {
    guard total > 0 else { return nil }
    guard cached < total else { return "100" }
    let percent = Double(cached) / Double(total) * 100
    let integer = Int(percent.rounded())
    if integer < 100 { return String(integer) }
    for places in 1...5 {
      let power = pow(10.0, Double(places))
      let rounded = (percent * power).rounded() / power
      if rounded < 100 {
        return String(format: "%.*f", places, rounded)
      }
    }
    return "99.99999"
  }
}

private struct NativeGoalDock: View {
  @ObservedObject var model: ArkAppModel
  @State private var editing = false
  @State private var draft = ""
  @FocusState private var objectiveFocused: Bool

  private var goal: ArkGoalSnapshot? { model.currentGoal }
  private var language: ArkLanguagePreference { model.languagePreference }

  var body: some View {
    if let goal, goal.phase != .complete {
      VStack(alignment: .leading, spacing: 5) {
        HStack(spacing: 8) {
          Image(systemName: "target")
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(phaseColor(goal.phase))

          if editing {
            TextField(ArkL10n.text(.goalObjective, language), text: $draft)
              .textFieldStyle(.plain)
              .font(.system(size: 11, weight: .medium))
              .focused($objectiveFocused)
              .onSubmit { submitEdit() }
              .accessibilityIdentifier("ark.chat.goal.objective")
          } else {
            Text(phaseLabel(goal.phase))
              .font(.system(size: 10, weight: .semibold))
              .foregroundStyle(phaseColor(goal.phase))
            Text(goal.objective)
              .font(.system(size: 11, weight: .medium))
              .lineLimit(1)
            Spacer(minLength: 6)
            Text(ArkL10n.format(
              .goalRounds,
              language,
              arguments: [String(goal.roundsStarted), String(goal.maxGoalRounds)]
            ))
            .font(.system(size: 9, design: .monospaced))
            .foregroundStyle(ArkPalette.secondary)
          }

          if model.currentGoalMutationIsRunning {
            ProgressView().controlSize(.mini)
          }

          if editing {
            actionButton(
              ArkL10n.text(.goalSave, language),
              systemImage: "checkmark",
              disabled: draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ) { submitEdit() }
            actionButton(ArkL10n.text(.goalCancel, language), systemImage: "xmark") {
              editing = false
            }
          } else {
            if goal.phase == .active {
              actionButton(ArkL10n.text(.goalPause, language), systemImage: "pause.fill") {
                mutate(.pause)
              }
            } else if goal.phase == .paused {
              actionButton(ArkL10n.text(.goalResume, language), systemImage: "play.fill") {
                mutate(.resume)
              }
            }
            actionButton(ArkL10n.text(.goalEdit, language), systemImage: "pencil") {
              draft = goal.objective
              editing = true
              DispatchQueue.main.async { objectiveFocused = true }
            }
            actionButton(ArkL10n.text(.goalClear, language), systemImage: "trash") {
              mutate(.clear)
            }
          }
        }

        if let reason = goal.blockedReason?.message, !reason.isEmpty {
          Text(reason)
            .font(.system(size: 9))
            .foregroundStyle(Color.orange)
            .lineLimit(2)
        }
        if let error = model.goalMutationError, !error.isEmpty {
          Text(error)
            .font(.system(size: 9))
            .foregroundStyle(Color.red)
            .lineLimit(2)
            .accessibilityIdentifier("ark.chat.goal.error")
        }
      }
      .padding(.horizontal, 10)
      .padding(.vertical, 6)
      .background(Color.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 10))
      .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.secondary.opacity(0.16)))
      .accessibilityIdentifier("ark.chat.goal")
      .onChange(of: goal.id) { _ in
        editing = false
        draft = ""
        objectiveFocused = false
      }
    }
  }

  private func phaseLabel(_ phase: ArkGoalPhase) -> String {
    switch phase {
    case .active: return ArkL10n.text(.goalPhaseActive, language)
    case .paused: return ArkL10n.text(.goalPhasePaused, language)
    case .blocked: return ArkL10n.text(.goalPhaseBlocked, language)
    case .complete: return ""
    }
  }

  private func phaseColor(_ phase: ArkGoalPhase) -> Color {
    switch phase {
    case .active: return .accentColor
    case .paused: return .secondary
    case .blocked: return .orange
    case .complete: return .green
    }
  }

  private func actionButton(
    _ label: String,
    systemImage: String,
    disabled: Bool = false,
    action: @escaping () -> Void
  ) -> some View {
    Button(action: action) {
      Image(systemName: systemImage)
        .frame(width: 24, height: 24)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(disabled || model.currentGoalMutationIsRunning)
    .help(label)
    .accessibilityLabel(label)
  }

  private func submitEdit() {
    let objective = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !objective.isEmpty else { return }
    Task {
      if await model.mutateCurrentGoal(.edit(objective: objective)) {
        editing = false
      }
    }
  }

  private func mutate(_ mutation: ArkGoalMutation) {
    Task { _ = await model.mutateCurrentGoal(mutation) }
  }
}

private struct NativeSessionProjectionDock: View {
  @ObservedObject var model: ArkAppModel

  private var plan: JSONValue? { model.sessionProjections["plan"] }
  private var planPending: Bool { plan?["pending"]?.boolValue == true }
  private var visible: Bool {
    (model.currentGoal?.phase != nil && model.currentGoal?.phase != .complete)
      || plan?["active"]?.boolValue == true
      || planPending
      || model.selectedLongTaskSummary != nil
  }

  var body: some View {
    if visible {
      VStack(alignment: .leading, spacing: 7) {
        NativeGoalDock(model: model)
        if let plan, plan["active"]?.boolValue == true || planPending {
          HStack(spacing: 8) {
            Label(
              plan["active"]?.boolValue == true ? "Plan 模式" : "Plan 模式切换中",
              systemImage: "list.bullet.clipboard"
            )
            .font(.system(size: 10, weight: .semibold))
            Spacer()
            Button(plan["active"]?.boolValue == true ? "退出" : "进入") {
              model.runSessionCommand(plan["active"]?.boolValue == true ? "/plan off" : "/plan on")
            }
            .buttonStyle(.borderless)
            .font(.system(size: 10))
            .disabled(planPending)
          }
        }
        if let summary = model.selectedLongTaskSummary {
          NativeLongTaskSummaryView(summary: summary, language: model.languagePreference)
        }
      }
      .padding(.horizontal, 12)
      .padding(.top, 8)
    }
  }

}

private struct NativeMarkdownText: View {
  let text: String
  var baseFontSize: CGFloat = 14
  var producedFilePaths: [String] = []

  var body: some View {
    NativeMarkdownDocument(
      text: text,
      baseFontSize: baseFontSize,
      producedFilePaths: producedFilePaths
    )
      .fixedSize(horizontal: false, vertical: true)
  }
}

/// Streaming Markdown parses only a policy-bounded live window. Final
/// assistant messages still use ``NativeMarkdownText`` and receive the
/// complete canonical rendering from the unchanged session model.
private struct NativeStreamingMarkdownText: View {
  let text: String
  var baseFontSize: CGFloat = 14
  var producedFilePaths: [String] = []

  var body: some View {
    NativeMarkdownDocument(
      text: ArkStreamingPresentationPolicy.markdownText(text, streaming: true),
      baseFontSize: baseFontSize,
      producedFilePaths: producedFilePaths
    )
      .fixedSize(horizontal: false, vertical: true)
  }
}

@MainActor
private final class NativeWikiFeed: ObservableObject {
  @Published private(set) var pages: [ArkWikiPage]
  @Published private(set) var edges: [ArkWikiEdge]
  @Published private(set) var reviews: [ArkWikiReview]
  @Published private(set) var projects: [ArkKnowledgeProject]
  @Published private(set) var selectedProjectPath: String?
  @Published private(set) var savingPageID: String?
  @Published private(set) var saveError: String?
  @Published private(set) var saveRevision: UInt64
  @Published private(set) var ingestQueue: ArkKnowledgeIngestQueue
  @Published private(set) var ingestBusy: Bool
  @Published private(set) var ingestError: String?
  @Published private(set) var reviewBusy: Bool
  @Published private(set) var reviewError: String?
  @Published private(set) var operationError: String?
  @Published private(set) var searchPaths: Set<String>
  @Published private(set) var activeTitle: String
  @Published private(set) var selectedPageID: String?
  @Published private(set) var isThinking: Bool
  @Published private(set) var language: ArkLanguagePreference
  private var cancellables = Set<AnyCancellable>()

  var selectedPage: ArkWikiPage? {
    pages.first { $0.id == selectedPageID }
  }

  init(model: ArkAppModel) {
    pages = model.wikiPages
    edges = model.wikiEdges
    reviews = model.wikiReviews
    projects = model.wikiProjects
    selectedProjectPath = model.selectedKnowledgeProjectPath
    savingPageID = model.wikiSavingPageID
    saveError = model.wikiSaveError
    saveRevision = model.wikiSaveRevision
    ingestQueue = model.wikiIngestQueue
    ingestBusy = model.wikiIngestBusy
    ingestError = model.wikiIngestError
    reviewBusy = model.wikiReviewBusy
    reviewError = model.wikiReviewError
    operationError = model.knowledgeErrorMessage
    searchPaths = model.knowledgeSearchPaths
    activeTitle = model.activeWikiTitle
    selectedPageID = model.selectedWikiPageID
    isThinking = model.selectedSession?.running == true
    language = model.languagePreference

    model.$wikiPages.removeDuplicates()
      .sink { [weak self] in self?.pages = $0 }
      .store(in: &cancellables)
    model.$wikiEdges.removeDuplicates()
      .sink { [weak self] in self?.edges = $0 }
      .store(in: &cancellables)
    model.$wikiReviews.removeDuplicates()
      .sink { [weak self] in self?.reviews = $0 }
      .store(in: &cancellables)
    model.$wikiProjects.removeDuplicates()
      .sink { [weak self] in self?.projects = $0 }
      .store(in: &cancellables)
    model.$selectedKnowledgeProjectPath.removeDuplicates()
      .sink { [weak self] in self?.selectedProjectPath = $0 }
      .store(in: &cancellables)
    model.$wikiSavingPageID.removeDuplicates()
      .sink { [weak self] in self?.savingPageID = $0 }
      .store(in: &cancellables)
    model.$wikiSaveError.removeDuplicates()
      .sink { [weak self] in self?.saveError = $0 }
      .store(in: &cancellables)
    model.$wikiSaveRevision.removeDuplicates()
      .sink { [weak self] in self?.saveRevision = $0 }
      .store(in: &cancellables)
    model.$wikiIngestQueue.removeDuplicates()
      .sink { [weak self] in self?.ingestQueue = $0 }
      .store(in: &cancellables)
    model.$wikiIngestBusy.removeDuplicates()
      .sink { [weak self] in self?.ingestBusy = $0 }
      .store(in: &cancellables)
    model.$wikiIngestError.removeDuplicates()
      .sink { [weak self] in self?.ingestError = $0 }
      .store(in: &cancellables)
    model.$wikiReviewBusy.removeDuplicates()
      .sink { [weak self] in self?.reviewBusy = $0 }
      .store(in: &cancellables)
    model.$wikiReviewError.removeDuplicates()
      .sink { [weak self] in self?.reviewError = $0 }
      .store(in: &cancellables)
    model.$knowledgeErrorMessage.removeDuplicates()
      .sink { [weak self] in self?.operationError = $0 }
      .store(in: &cancellables)
    model.$knowledgeSearchPaths.removeDuplicates()
      .sink { [weak self] in self?.searchPaths = $0 }
      .store(in: &cancellables)
    model.$activeWikiTitle.removeDuplicates()
      .sink { [weak self] in self?.activeTitle = $0 }
      .store(in: &cancellables)
    model.$selectedWikiPageID.removeDuplicates()
      .sink { [weak self] in self?.selectedPageID = $0 }
      .store(in: &cancellables)
    model.$languagePreference.removeDuplicates()
      .sink { [weak self] in self?.language = $0 }
      .store(in: &cancellables)
    model.$sessions
      .combineLatest(model.$selectedSessionID)
      .map { sessions, selectedID in
        sessions.first { $0.id == selectedID }?.running == true
      }
      .removeDuplicates()
      .sink { [weak self] in self?.isThinking = $0 }
      .store(in: &cancellables)
  }
}

private struct NativeWikiView: View, Equatable {
  let model: ArkAppModel
  @StateObject private var feed: NativeWikiFeed
  @State private var search = ""
  @State private var showCreatePage = false
  @State private var showCreateProject = false
  @State private var showImportURL = false
  @State private var importURL = ""
  @State private var pendingRemoveProject: ArkKnowledgeProject?
  @State private var newProjectName = ""
  @State private var newProjectPath = ""
  @State private var newPageTitle = ""
  @State private var newPageBody = ""
  @State private var researchTopic = ""

  /// filteredPages 的缓存：只在 search / wikiPages / knowledgeSearchPaths 变化时重算，
  /// body 只读缓存，避免每次 body 求值对页面正文做大小写折叠查找。
  @State private var filteredPagesCache: [ArkWikiPage] = []

  init(model: ArkAppModel) {
    self.model = model
    _feed = StateObject(wrappedValue: NativeWikiFeed(model: model))
  }

  static func == (lhs: NativeWikiView, rhs: NativeWikiView) -> Bool {
    lhs.model === rhs.model
  }

  private func refreshFilteredPages() {
    let searched = search.isEmpty ? feed.pages : feed.pages.filter {
      $0.title.localizedCaseInsensitiveContains(search)
        || $0.relativePath.localizedCaseInsensitiveContains(search)
        || $0.body.localizedCaseInsensitiveContains(search)
    }
    filteredPagesCache = feed.searchPaths.isEmpty
      ? searched
      : searched.filter { feed.searchPaths.contains($0.relativePath) }
  }

  private var filteredPages: [ArkWikiPage] {
    filteredPagesCache
  }

  /// Keeps search semantics unchanged while lifting the selected page and its
  /// direct graph neighbors to the front of the native knowledge-page list.
  private var prioritizedListPages: [ArkWikiPage] {
    guard let selectedID = feed.selectedPageID else { return filteredPages }
    var neighborIDs = Set<String>()
    for edge in feed.edges where edge.source == selectedID || edge.target == selectedID {
      neighborIDs.insert(edge.source == selectedID ? edge.target : edge.source)
    }
    return filteredPages.enumerated().sorted { left, right in
      func rank(_ page: ArkWikiPage) -> Int {
        if page.id == selectedID { return 0 }
        if neighborIDs.contains(page.id) { return 1 }
        return 2
      }
      let leftRank = rank(left.element)
      let rightRank = rank(right.element)
      return leftRank == rightRank ? left.offset < right.offset : leftRank < rightRank
    }.map(\.element)
  }

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 10) {
        Menu {
          ForEach(feed.projects) { project in
            Button {
              model.selectKnowledgeProject(path: project.path)
            } label: {
              Label(
                project.displayName,
                systemImage: feed.selectedProjectPath == project.path
                  ? "checkmark" : "circle"
              )
            }
          }
        } label: {
          HStack(spacing: 6) {
            Text(localizedWikiTitle)
            Image(systemName: "chevron.down")
              .font(.system(size: 9))
          }
          .padding(.horizontal, 10)
          .frame(height: 30)
          .background(ArkPalette.raised, in: RoundedRectangle(cornerRadius: 7))
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .help(ArkL10n.text(.wikiSwitchWorkspaceHelp, feed.language))
        if let project = removableKnowledgeProject {
          Button {
            pendingRemoveProject = project
          } label: {
            Image(systemName: "trash")
              .frame(width: 30, height: 30)
              .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .foregroundStyle(Color.red)
          .help(ArkL10n.text(.wikiRemoveProject, feed.language))
          .accessibilityIdentifier("ark.wiki.project.remove")
        }
        Button(
          ArkL10n.text(.wikiNewProject, feed.language),
          action: chooseKnowledgeProjectDirectory
        )
          .buttonStyle(.bordered)
          .tint(.green)
        TextField(ArkL10n.text(.wikiSearchPlaceholder, feed.language), text: $search)
          .textFieldStyle(.roundedBorder)
          .onSubmit { model.searchKnowledge(search) }
          .onChange(of: search) { value in
            if value.isEmpty { model.clearKnowledgeSearch() }
          }
        Button(ArkL10n.text(.wikiSearch, feed.language)) {
          model.searchKnowledge(search)
        }
          .buttonStyle(.borderedProminent)
        Menu {
          Button(ArkL10n.text(.wikiImportFiles, feed.language), action: chooseKnowledgeSources)
          Button(ArkL10n.text(.wikiImportURL, feed.language)) {
            showImportURL = true
          }
        } label: {
          Text(ArkL10n.text(.wikiImport, feed.language))
        }
          .menuStyle(.borderlessButton)
          .help(ArkL10n.text(.wikiImportHelp, feed.language))
        Button(ArkL10n.text(.wikiNewPage, feed.language)) {
          showCreatePage = true
        }
      }
      .font(.system(size: 12))
      .padding(.horizontal, 16)
      .frame(height: 52)
      Divider().overlay(ArkPalette.border)
      if let error = feed.operationError, !error.isEmpty {
        NativeSettingsNotice(text: error, color: .red, icon: "exclamationmark.triangle.fill")
          .accessibilityIdentifier("ark.wiki.error")
          .padding(.horizontal, 12)
          .padding(.vertical, 8)
      }

      HStack(spacing: 0) {
        NativeWikiList(
          model: model,
          pages: prioritizedListPages,
          selectedPageID: feed.selectedPageID,
          ingestQueue: feed.ingestQueue,
          ingestBusy: feed.ingestBusy,
          ingestError: feed.ingestError,
          language: feed.language
        )
          .frame(width: 230)
        Divider().overlay(ArkPalette.border)
        VStack(spacing: 0) {
          NativeWikiGraph(
            model: model,
            pages: filteredPages,
            edges: feed.edges,
            selectedPageID: feed.selectedPageID,
            isThinking: feed.isThinking,
            language: feed.language
          )
          .equatable()
          Divider().overlay(ArkPalette.border)
          NativeResearchBar(model: model, topic: $researchTopic, language: feed.language)
        }
        Divider().overlay(ArkPalette.border)
        NativeWikiDetail(
          model: model,
          page: feed.selectedPage,
          reviews: feed.reviews,
          savingPageID: feed.savingPageID,
          saveError: feed.saveError,
          saveRevision: feed.saveRevision,
          reviewBusy: feed.reviewBusy,
          reviewError: feed.reviewError,
          language: feed.language
        )
          .frame(width: 300)
      }
    }
    .onAppear { refreshFilteredPages() }
    .onChange(of: search) { _ in refreshFilteredPages() }
    .onChange(of: feed.pages) { _ in refreshFilteredPages() }
    .onChange(of: feed.searchPaths) { _ in refreshFilteredPages() }
    .sheet(isPresented: $showImportURL) {
      VStack(alignment: .leading, spacing: 14) {
        Text(ArkL10n.text(.wikiImportURLTitle, feed.language))
          .font(.system(size: 18, weight: .semibold))
        TextField(ArkL10n.text(.wikiImportURLPlaceholder, feed.language), text: $importURL)
          .textFieldStyle(.roundedBorder)
          .onSubmit { submitKnowledgeURL() }
          .accessibilityIdentifier("ark.wiki.ingest.url")
        Group {
          if let error = importURLValidationError ?? feed.ingestError, !error.isEmpty {
            Text(error)
              .font(.system(size: 11))
              .foregroundStyle(Color.red)
              .frame(maxWidth: .infinity, alignment: .leading)
              .accessibilityIdentifier("ark.wiki.ingest.url-error")
          } else {
            Color.clear
          }
        }
        .frame(minHeight: 18)
        HStack {
          Spacer()
          Button(ArkL10n.text(.wikiCancel, feed.language), role: .cancel) {
            showImportURL = false
          }
          Button(ArkL10n.text(.wikiImport, feed.language)) {
            submitKnowledgeURL()
          }
          .buttonStyle(.borderedProminent)
          .disabled(ArkHTTPURLInput.normalizedHTTPURL(importURL) == nil || feed.ingestBusy)
        }
      }
      .padding(22)
      .frame(width: 520, height: 210)
      .background(ArkPalette.panel)
    }
    .sheet(isPresented: $showCreatePage) {
      VStack(alignment: .leading, spacing: 14) {
        Text(ArkL10n.text(.wikiCreatePageTitle, feed.language))
          .font(.system(size: 18, weight: .semibold))
        TextField(ArkL10n.text(.wikiPageTitlePlaceholder, feed.language), text: $newPageTitle)
        TextEditor(text: $newPageBody)
          .font(.system(size: 12, design: .monospaced))
          .frame(minHeight: 220)
          .overlay(RoundedRectangle(cornerRadius: 8).stroke(ArkPalette.border))
        HStack {
          Spacer()
          Button(ArkL10n.text(.wikiCancel, feed.language), role: .cancel) {
            showCreatePage = false
          }
          Button(ArkL10n.text(.wikiCreate, feed.language)) {
            model.createKnowledgePage(title: newPageTitle, content: newPageBody)
            newPageTitle = ""
            newPageBody = ""
            showCreatePage = false
          }
          .buttonStyle(.borderedProminent)
          .disabled(newPageTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
      }
      .padding(22)
      .frame(width: 560, height: 390)
      .background(ArkPalette.panel)
    }
    .sheet(isPresented: $showCreateProject) {
      VStack(alignment: .leading, spacing: 14) {
        Text(ArkL10n.text(.wikiCreateProjectTitle, feed.language))
          .font(.system(size: 18, weight: .semibold))
        TextField(ArkL10n.text(.wikiProjectName, feed.language), text: $newProjectName)
        LabeledContent(ArkL10n.text(.wikiProjectDirectory, feed.language)) {
          Text(newProjectPath)
            .font(.system(size: 11, design: .monospaced))
            .lineLimit(2)
            .truncationMode(.middle)
        }
        Text(ArkL10n.text(.wikiProjectCreationDetail, feed.language))
          .font(.system(size: 11))
          .foregroundStyle(ArkPalette.secondary)
        HStack {
          Spacer()
          Button(ArkL10n.text(.wikiCancel, feed.language), role: .cancel) {
            showCreateProject = false
          }
          Button(ArkL10n.text(.wikiCreate, feed.language)) {
            model.createKnowledgeProject(name: newProjectName, path: newProjectPath)
            showCreateProject = false
          }
          .buttonStyle(.borderedProminent)
          .disabled(
            newProjectName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
              || newProjectPath.isEmpty
          )
        }
      }
      .padding(22)
      .frame(width: 520, height: 230)
      .background(ArkPalette.panel)
    }
    .confirmationDialog(
      ArkL10n.text(.wikiRemoveProjectTitle, feed.language),
      isPresented: Binding(
        get: { pendingRemoveProject != nil },
        set: { if !$0 { pendingRemoveProject = nil } }
      ),
      titleVisibility: .visible
    ) {
      Button(ArkL10n.text(.wikiRemoveProject, feed.language), role: .destructive) {
        if let project = pendingRemoveProject {
          model.removeKnowledgeProject(path: project.path)
        }
        pendingRemoveProject = nil
      }
      Button(ArkL10n.text(.wikiCancel, feed.language), role: .cancel) {
        pendingRemoveProject = nil
      }
    } message: {
      if let project = pendingRemoveProject {
        Text(ArkL10n.format(
          .wikiRemoveProjectDetail,
          feed.language,
          arguments: [project.displayName, project.path]
        ))
      }
    }
  }

  private var removableKnowledgeProject: ArkKnowledgeProject? {
    guard
      let selected = feed.selectedProjectPath,
      let project = feed.projects.first(where: { $0.path == selected }),
      !project.isMain
    else { return nil }
    let normalized = URL(fileURLWithPath: project.path).standardizedFileURL.path
    guard !model.workspaces.contains(where: {
      URL(fileURLWithPath: $0.path).standardizedFileURL.path == normalized
    }) else { return nil }
    return project
  }

  private func chooseKnowledgeProjectDirectory() {
    let panel = NSOpenPanel()
    panel.canChooseFiles = false
    panel.canChooseDirectories = true
    panel.allowsMultipleSelection = false
    panel.prompt = ArkL10n.text(.wikiChooseProjectDirectory, feed.language)
    guard panel.runModal() == .OK, let url = panel.url else { return }
    newProjectPath = url.path
    newProjectName = url.lastPathComponent
    showCreateProject = true
  }

  private var localizedWikiTitle: String {
    if feed.activeTitle == "万相织鉴" || feed.activeTitle == "Wanxiang" {
      return ArkL10n.text(.navWiki, feed.language)
    }
    return feed.activeTitle
  }

  private func chooseKnowledgeSources() {
    let panel = NSOpenPanel()
    panel.canChooseFiles = true
    panel.canChooseDirectories = false
    panel.allowsMultipleSelection = true
    panel.prompt = ArkL10n.text(.wikiChooseSources, feed.language)
    guard panel.runModal() == .OK else { return }
    model.importKnowledgeSources(panel.urls)
  }

  private func submitKnowledgeURL() {
    guard let value = ArkHTTPURLInput.normalizedHTTPURL(importURL) else { return }
    if model.importKnowledgeURL(value) {
      importURL = ""
      showImportURL = false
    }
  }

  private var importURLValidationError: String? {
    let value = importURL.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !value.isEmpty, ArkHTTPURLInput.normalizedHTTPURL(value) == nil else { return nil }
    return ArkL10n.text(.wikiImportURLInvalid, feed.language)
  }
}

private struct NativeResearchBar: View {
  let model: ArkAppModel
  @Binding var topic: String
  let language: ArkLanguagePreference

  var body: some View {
    HStack(spacing: 10) {
      Text(ArkL10n.text(.wikiDeepResearch, language))
        .font(.system(size: 12, weight: .medium))
      TextField(ArkL10n.text(.wikiResearchPlaceholder, language), text: $topic)
        .textFieldStyle(.roundedBorder)
        .onSubmit { model.runDeepResearch(topic: topic) }
      Button(ArkL10n.text(.wikiStart, language)) {
        model.runDeepResearch(topic: topic)
      }
        .buttonStyle(.borderedProminent)
        .disabled(topic.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }
    .padding(.horizontal, 12)
    .frame(height: 54)
    .background(ArkPalette.panel)
  }
}

private struct NativeWikiList: View {
  let model: ArkAppModel
  let pages: [ArkWikiPage]
  let selectedPageID: String?
  let ingestQueue: ArkKnowledgeIngestQueue
  let ingestBusy: Bool
  let ingestError: String?
  let language: ArkLanguagePreference

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(ArkL10n.format(
        .wikiPagesCount,
        language,
        arguments: [String(pages.count)]
      ))
        .font(.system(size: 12, weight: .semibold))
        .padding(.horizontal, 12)
        .padding(.top, 12)
      NativeWikiIngestQueueView(
        model: model,
        queue: ingestQueue,
        busy: ingestBusy,
        error: ingestError,
        language: language
      )
      ScrollViewReader { proxy in
        ScrollView {
          LazyVStack(spacing: 6) {
            ForEach(pages) { page in
              Button {
                model.selectWikiPage(page.id)
              } label: {
                VStack(alignment: .leading, spacing: 3) {
                  Text(page.title)
                    .lineLimit(2)
                    .foregroundStyle(ArkPalette.primary)
                  Text("\(page.relativePath) · \(page.byteCount)B")
                    .font(.system(size: 10))
                    .lineLimit(2)
                    .foregroundStyle(ArkPalette.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(9)
                .background(
                  selectedPageID == page.id ? ArkPalette.raised : ArkPalette.shell,
                  in: RoundedRectangle(cornerRadius: 7)
                )
                .overlay(RoundedRectangle(cornerRadius: 7).stroke(ArkPalette.border))
              }
              .buttonStyle(.plain)
              .id(page.id)
            }
          }
          .padding(.horizontal, 8)
        }
        .onChange(of: pages.first?.id) { firstID in
          guard let firstID else { return }
          DispatchQueue.main.async {
            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction) {
              proxy.scrollTo(firstID, anchor: .top)
            }
          }
        }
      }
    }
    .background(ArkPalette.panel)
  }
}

private struct NativeWikiIngestQueueView: View {
  let model: ArkAppModel
  let queue: ArkKnowledgeIngestQueue
  let busy: Bool
  let error: String?
  let language: ArkLanguagePreference

  var body: some View {
    if !queue.tasks.isEmpty || busy || error?.isEmpty == false {
      VStack(alignment: .leading, spacing: 6) {
        HStack(spacing: 6) {
          if queue.running || busy { ProgressView().controlSize(.mini) }
          Text(ArkL10n.text(.wikiQueueTitle, language))
            .font(.system(size: 10, weight: .semibold))
          Text(ArkL10n.format(
            .wikiQueueProgress,
            language,
            arguments: [String(queue.completedCount), String(queue.tasks.count)]
          ))
          .font(.system(size: 9, design: .monospaced))
          .foregroundStyle(ArkPalette.secondary)
          Spacer(minLength: 0)
          Button {
            model.refreshKnowledgeIngestQueue()
          } label: {
            Image(systemName: "arrow.clockwise")
              .frame(width: 22, height: 20)
              .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .disabled(busy)
          .help(ArkL10n.text(.wikiQueueRefresh, language))
          .accessibilityIdentifier("ark.wiki.ingest.refresh")
        }

        ForEach(queue.tasks.suffix(4)) { task in
          HStack(spacing: 6) {
            Image(systemName: statusSymbol(task.status))
              .font(.system(size: 8, weight: .semibold))
              .foregroundStyle(statusColor(task.status))
              .frame(width: 11)
            Text(task.input)
              .font(.system(size: 9, design: .monospaced))
              .lineLimit(1)
              .truncationMode(.middle)
            Spacer(minLength: 4)
            Text(statusLabel(task.status))
              .font(.system(size: 8, weight: .medium))
              .foregroundStyle(statusColor(task.status))
          }
          .help(task.error ?? task.input)
          .accessibilityIdentifier("ark.wiki.ingest.task.\(task.id)")
        }

        if queue.pendingCount > 0 {
          Button(ArkL10n.text(.wikiQueueCancelPending, language)) {
            model.cancelPendingKnowledgeIngests()
          }
          .buttonStyle(.borderless)
          .controlSize(.small)
          .disabled(busy)
          .help(ArkL10n.text(.wikiQueueCancelBoundary, language))
          .accessibilityIdentifier("ark.wiki.ingest.cancel-pending")
        }
        if let error, !error.isEmpty {
          Text(error)
            .font(.system(size: 9))
            .foregroundStyle(Color.red)
            .lineLimit(2)
        }
      }
      .padding(8)
      .background(ArkPalette.shell, in: RoundedRectangle(cornerRadius: 7))
      .overlay(RoundedRectangle(cornerRadius: 7).stroke(ArkPalette.border))
      .padding(.horizontal, 8)
      .accessibilityIdentifier("ark.wiki.ingest.queue")
    }
  }

  private func statusLabel(_ status: ArkKnowledgeIngestStatus) -> String {
    let key: ArkL10n.Key = switch status {
    case .pending: .wikiQueuePending
    case .running: .wikiQueueTaskRunning
    case .done: .wikiQueueDone
    case .error: .wikiQueueError
    case .cancelled: .wikiQueueCancelled
    }
    return ArkL10n.text(key, language)
  }

  private func statusSymbol(_ status: ArkKnowledgeIngestStatus) -> String {
    switch status {
    case .pending: return "clock"
    case .running: return "circle.dotted"
    case .done: return "checkmark.circle.fill"
    case .error: return "xmark.octagon.fill"
    case .cancelled: return "stop.circle.fill"
    }
  }

  private func statusColor(_ status: ArkKnowledgeIngestStatus) -> Color {
    switch status {
    case .pending: return .secondary
    case .running: return .accentColor
    case .done: return .green
    case .error: return .red
    case .cancelled: return .orange
    }
  }
}

private struct NativeWikiGraph: View, Equatable {
  private enum LayoutMode: String, CaseIterable, Identifiable {
    case type = "按类型"
    case community = "按社区"
    var id: String { rawValue }
  }

  let model: ArkAppModel
  let pages: [ArkWikiPage]
  let edges: [ArkWikiEdge]
  let selectedPageID: String?
  let isThinking: Bool
  let language: ArkLanguagePreference
  @State private var layoutMode: LayoutMode = .type
  @StateObject private var viewportController = NativeWikiViewportController()

  static func == (lhs: NativeWikiGraph, rhs: NativeWikiGraph) -> Bool {
    lhs.model === rhs.model
      && lhs.pages == rhs.pages
      && lhs.edges == rhs.edges
      && lhs.selectedPageID == rhs.selectedPageID
      && lhs.isThinking == rhs.isThinking
      && lhs.language == rhs.language
  }

  var body: some View {
    GeometryReader { geometry in
      // 移除 30FPS 持续 tick；positions 仅随正常 SwiftUI body invalidation 重算。
      let positions = nodePositions(size: geometry.size)
      let focus = ArkWikiGraphFocus(
        selectedID: selectedPageID,
        edges: edges
      )
      let pageByID = ArkWikiLoader.firstPageByID(pages)
      let displayPositions = focusedNodePositions(
        base: positions,
        size: geometry.size,
        focus: focus
      )
      let thoughtConnections = edges.compactMap { edge -> NativeWikiThoughtConnection? in
        guard focus.emphasizes(edge),
              let start = displayPositions[edge.source],
              let end = displayPositions[edge.target]
        else { return nil }
        let sourceColor = pageByID[edge.source].map {
          presentationColor($0, emphasis: focus.nodeEmphasis(for: edge.source))
        } ?? Color.white
        let primary = neuralFiberGeometry(
          start: start,
          end: end,
          edgeID: edge.id,
          fiberIndex: 0
        )
        return NativeWikiThoughtConnection(
          id: edge.id,
          start: primary.start,
          control1: primary.control1,
          control2: primary.control2,
          end: primary.end,
          color: NSColor(sourceColor)
        )
      }
      let interactionNodes = pages.compactMap { page -> NativeWikiInteractionNode? in
        guard let point = displayPositions[page.id] else { return nil }
        let emphasis = focus.nodeEmphasis(for: page.id)
        return NativeWikiInteractionNode(
          id: page.id,
          point: point,
          hitRadius: max(18, nodeDiameter(page, emphasis: emphasis) * 0.90)
        )
      }
      let contentRevision: Int = {
        var hasher = Hasher()
        hasher.combine(Int(geometry.size.width.rounded()))
        hasher.combine(Int(geometry.size.height.rounded()))
        hasher.combine(layoutMode.rawValue)
        hasher.combine(selectedPageID)
        hasher.combine(isThinking)
        for page in pages {
          hasher.combine(page.id)
          hasher.combine(page.title)
          hasher.combine(page.category)
          hasher.combine(page.community)
        }
        for edge in edges { hasher.combine(edge.id) }
        return hasher.finalize()
      }()
      NativeWikiInteractionHost(
        contentRevision: contentRevision,
        nodes: interactionNodes,
        viewportController: viewportController,
        onSelect: { id in
          model.selectWikiPage(selectedPageID == id ? nil : id)
        },
        onClear: { model.selectWikiPage(nil) }
      ) {
        ZStack {
          NativeWikiStarfieldBackdrop()
            .allowsHitTesting(false)

        Color.clear
          .allowsHitTesting(false)

        NativeWikiViewportTransform(controller: viewportController) {
          ZStack {
          NativeWikiPulseOverlay(nodes: pages.compactMap { page in
            guard let point = displayPositions[page.id] else { return nil }
            let emphasis = focus.nodeEmphasis(for: page.id)
            let seed = ArkWikiGraphLayout.stableSeed(for: page.id)
            guard emphasis == .selected
              || emphasis == .neighbor
              || seed.isMultiple(of: 7)
            else { return nil }
            return NativeWikiPulseNode(
              id: page.id,
              point: point,
              diameter: nodeDiameter(page, emphasis: emphasis),
              color: NSColor(nodeColor(page)),
              intensity: pulseIntensity(for: emphasis),
              seed: seed
            )
          })
          .allowsHitTesting(false)

          Canvas(rendersAsynchronously: true) { context, _ in
            for page in pages {
              guard let point = displayPositions[page.id] else { continue }
              let emphasis = focus.nodeEmphasis(for: page.id)
              let prominent = emphasis == .selected
                || emphasis == .neighbor
                || ArkWikiGraphLayout.stableSeed(for: page.id).isMultiple(of: 11)
              guard prominent else { continue }
              let color = presentationColor(page, emphasis: emphasis)
              let phase = ArkWikiGraphLayout.phase(for: page.id)
              let count = emphasis == .selected ? 13 : 8
              for index in 0..<count {
                let angle = phase + Double(index) * (Double.pi * 2 / Double(count))
                let length = CGFloat(emphasis == .selected ? 42 : 27)
                  + CGFloat((ArkWikiGraphLayout.stableSeed(for: page.id) >> index) % 13)
                let end = CGPoint(
                  x: point.x + CGFloat(cos(angle)) * length,
                  y: point.y + CGFloat(sin(angle)) * length
                )
                let bend = CGFloat(index.isMultiple(of: 2) ? 1 : -1) * length * 0.14
                var tendril = Path()
                tendril.move(to: point)
                tendril.addQuadCurve(
                  to: end,
                  control: CGPoint(
                    x: (point.x + end.x) / 2 - CGFloat(sin(angle)) * bend,
                    y: (point.y + end.y) / 2 + CGFloat(cos(angle)) * bend
                  )
                )
                context.stroke(
                  tendril,
                  with: .color(color.opacity(emphasis == .selected ? 0.13 : 0.058)),
                  lineWidth: emphasis == .selected ? 0.46 : 0.27
                )
              }
            }

            var edgeContext = context
            edgeContext.blendMode = .screen
            for edge in edges {
              guard let start = displayPositions[edge.source],
                    let end = displayPositions[edge.target]
              else { continue }
              let emphasized = focus.emphasizes(edge)
              let sourceColor = pageByID[edge.source].map {
                presentationColor($0, emphasis: focus.nodeEmphasis(for: edge.source))
              } ?? Color.white
              let targetColor = pageByID[edge.target].map {
                presentationColor($0, emphasis: focus.nodeEmphasis(for: edge.target))
              } ?? Color.white
              let fiberCount = emphasized
                ? 12 + Int(ArkWikiGraphLayout.stableSeed(for: edge.id) % 6)
                : 7
              for fiberIndex in 0..<fiberCount {
                let geometry = neuralFiberGeometry(
                  start: start,
                  end: end,
                  edgeID: edge.id,
                  fiberIndex: fiberIndex
                )
                var fiber = Path()
                fiber.move(to: geometry.start)
                fiber.addCurve(
                  to: geometry.end,
                  control1: geometry.control1,
                  control2: geometry.control2
                )
                let opacity: Double = emphasized
                  ? 0.105 + Double(fiberIndex % 5) * 0.020
                  : (focus.selectedID == nil
                    ? 0.065 + Double(fiberIndex % 4) * 0.008
                    : 0.040 + Double(fiberIndex % 3) * 0.006)
                let width: CGFloat = emphasized
                  ? 0.24 + CGFloat(fiberIndex % 4) * 0.065
                  : 0.21 + CGFloat(fiberIndex % 3) * 0.045
                edgeContext.stroke(
                  fiber,
                  with: .linearGradient(
                    Gradient(colors: [
                      sourceColor.opacity(opacity),
                      targetColor.opacity(opacity * 0.86),
                    ]),
                    startPoint: geometry.start,
                    endPoint: geometry.end
                  ),
                  lineWidth: width
                )
              }
            }
          }
          .allowsHitTesting(false)

          NativeWikiThoughtFlowOverlay(
            connections: thoughtConnections,
            isThinking: isThinking
          )
          .frame(maxWidth: .infinity, maxHeight: .infinity)
          .allowsHitTesting(false)

          ForEach(pages) { page in
            if let point = displayPositions[page.id] {
              let emphasis = focus.nodeEmphasis(for: page.id)
              let diameter = nodeDiameter(page, emphasis: emphasis)
              Button {
                model.selectWikiPage(selectedPageID == page.id ? nil : page.id)
              } label: {
                NativeWikiStarNode(
                  color: presentationColor(page, emphasis: emphasis),
                  diameter: diameter,
                  opacity: nodeOpacity(for: emphasis),
                  coreOpacity: starCoreOpacity(for: emphasis)
                )
                .frame(width: max(24, diameter * 1.42), height: max(24, diameter * 1.42))
                .shadow(
                  color: presentationColor(page, emphasis: emphasis).opacity(shadowOpacity(for: emphasis)),
                  radius: shadowRadius(for: emphasis)
                )
                .contentShape(Circle())
              }
              .buttonStyle(.plain)
              .position(point)
              .zIndex(nodeZIndex(for: emphasis))
              .help(page.title)
              .accessibilityLabel(page.title)
            }
          }
          }
        }
        .animation(
          .spring(response: 0.48, dampingFraction: 0.78, blendDuration: 0.08),
          value: selectedPageID
        )
        .animation(
          .spring(response: 0.52, dampingFraction: 0.82, blendDuration: 0.08),
          value: layoutMode
        )
        }
        .clipped()
      }
      .overlay(alignment: .top) {
        graphToolbar
          .padding(14)
      }
      .overlay(alignment: .bottomLeading) {
        graphLegend
          .padding(14)
          .allowsHitTesting(false)
      }
    }
    .background(
      ZStack {
        Color(red: 0.045, green: 0.052, blue: 0.066)
        RadialGradient(
          colors: [
            Color(red: 0.22, green: 0.18, blue: 0.42).opacity(0.16),
            Color(red: 0.05, green: 0.12, blue: 0.19).opacity(0.08),
            Color.clear,
          ],
          center: .center,
          startRadius: 20,
          endRadius: 620
        )
      }
    )
    .foregroundStyle(Color.white)
    .preferredColorScheme(.dark)
  }

  private var graphToolbar: some View {
    HStack {
      VStack(alignment: .leading, spacing: 3) {
        Label(
          ArkL10n.text(.wikiGraphTitle, language),
          systemImage: "point.3.connected.trianglepath.dotted"
        )
          .font(.system(size: 13, weight: .semibold))
        Text(ArkL10n.format(
          .wikiGraphCounts,
          language,
          arguments: [String(pages.count), String(edges.count)]
        ))
          .font(.system(size: 10))
          .foregroundStyle(Color.white.opacity(0.62))
        NativeWikiInteractionHint(
          controller: viewportController,
          language: language
        )
      }
      Spacer()
      Picker(ArkL10n.text(.wikiLayout, language), selection: $layoutMode) {
        Text(ArkL10n.text(.wikiLayoutType, language)).tag(LayoutMode.type)
        Text(ArkL10n.text(.wikiLayoutCommunity, language)).tag(LayoutMode.community)
      }
      .labelsHidden()
      .pickerStyle(.segmented)
      .frame(width: 126)
      Button {
        viewportController.reset()
        model.selectWikiPage(nil)
      } label: {
        Image(systemName: "arrow.counterclockwise")
          .frame(width: 24, height: 24)
          .contentShape(Rectangle())
      }
      .buttonStyle(.borderless)
      .help(ArkL10n.text(.wikiResetGraph, language))
    }
    .padding(.horizontal, 11)
    .frame(height: 48)
    .background(Color.black.opacity(0.30), in: RoundedRectangle(cornerRadius: 9))
  }

  private var graphLegend: some View {
    HStack(spacing: 10) {
      legend(ArkL10n.text(.wikiLegendConcept, language), spectralPalette[0])
      legend(ArkL10n.text(.wikiLegendMethod, language), spectralPalette[2])
      legend(ArkL10n.text(.wikiLegendOverview, language), spectralPalette[4])
      legend(ArkL10n.text(.wikiLegendEvidence, language), spectralPalette[6])
      legend(ArkL10n.text(.wikiLegendOther, language), spectralPalette[8])
      Spacer()
    }
  }

  private func nodePositions(size: CGSize) -> [String: CGPoint] {
    guard !pages.isEmpty else { return [:] }
    let groups = Dictionary(grouping: pages) { page -> String in
      switch layoutMode {
      case .type:
        return "type:\(page.category.lowercased())"
      case .community:
        return "community:\(page.community.map(String.init) ?? "unassigned")"
      }
    }
    let groupKeys = groups.keys.sorted { left, right in
      if layoutMode == .community {
        let leftValue = Int(left.dropFirst("community:".count)) ?? Int.max
        let rightValue = Int(right.dropFirst("community:".count)) ?? Int.max
        if leftValue != rightValue { return leftValue < rightValue }
      }
      return left < right
    }
    let center = CGPoint(x: size.width / 2, y: size.height / 2)
    let minimumDimension = max(1, min(size.width, size.height))
    let clusterOrbit = groupKeys.count > 1 ? minimumDimension * 0.25 : 0
    let goldenAngle = Double.pi * (3 - sqrt(5))
    var result: [String: CGPoint] = [:]
    for (groupIndex, key) in groupKeys.enumerated() {
      guard let members = groups[key]?.sorted(by: { $0.id < $1.id }) else { continue }
      let clusterAngle = -Double.pi / 2
        + Double(groupIndex) * (Double.pi * 2 / Double(max(1, groupKeys.count)))
      let clusterPhase = ArkWikiGraphLayout.phase(for: key)
      let clusterCenter = CGPoint(
        x: center.x + CGFloat(cos(clusterAngle + clusterPhase * 0.08)) * clusterOrbit,
        y: center.y + CGFloat(sin(clusterAngle + clusterPhase * 0.08)) * clusterOrbit * 0.78
      )
      let localRadius = min(
        max(34, CGFloat(sqrt(Double(members.count))) * 22),
        minimumDimension * 0.15
      )
      for (memberIndex, page) in members.enumerated() {
        let fraction = sqrt(Double(memberIndex + 1) / Double(max(1, members.count)))
        let phase = ArkWikiGraphLayout.phase(for: page.id)
        let angle = Double(memberIndex) * goldenAngle + phase * 0.22
        let radius = localRadius * CGFloat(fraction) * (0.92 + CGFloat(sin(phase)) * 0.08)
        let raw = CGPoint(
          x: clusterCenter.x + CGFloat(cos(angle)) * radius,
          y: clusterCenter.y + CGFloat(sin(angle)) * radius * 0.84
        )
        result[page.id] = CGPoint(
          x: min(max(raw.x, 42), max(42, size.width - 42)),
          y: min(max(raw.y, 82), max(82, size.height - 48))
        )
      }
    }
    return result
  }

  private func focusedNodePositions(
    base: [String: CGPoint],
    size: CGSize,
    focus: ArkWikiGraphFocus
  ) -> [String: CGPoint] {
    guard let selectedID = focus.selectedID, base[selectedID] != nil else { return base }
    let center = CGPoint(x: size.width * 0.52, y: size.height * 0.50)
    let scale = min(size.width / 760, size.height / 620)
    let anchors = [
      CGSize(width: -178, height: -118),
      CGSize(width: 146, height: -126),
      CGSize(width: -226, height: 62),
      CGSize(width: 172, height: 112),
      CGSize(width: -86, height: 184),
      CGSize(width: 238, height: 18),
      CGSize(width: 18, height: -190),
    ]
    let orderedNeighborIDs = focus.neighborIDs.sorted()
    var neighborTargets: [String: CGPoint] = [:]
    for (index, id) in orderedNeighborIDs.enumerated() {
      let anchor = anchors[index % anchors.count]
      let ring = CGFloat(index / anchors.count + 1)
      neighborTargets[id] = CGPoint(
        x: center.x + anchor.width * max(0.68, scale) * ring,
        y: center.y + anchor.height * max(0.68, scale) * ring
      )
    }
    var result: [String: CGPoint] = [:]
    for page in pages where result[page.id] == nil {
      guard let point = base[page.id] else { continue }
      let emphasis = focus.nodeEmphasis(for: page.id)
      let dx = point.x - center.x
      let dy = point.y - center.y
      let distance = max(1, hypot(dx, dy))
      let target: CGPoint
      switch emphasis {
      case .selected:
        target = center
      case .normal:
        target = point
      case .neighbor:
        target = neighborTargets[page.id] ?? point
      case .receded:
        let push = min(18, max(6, distance * 0.045))
        target = CGPoint(
          x: point.x + dx / distance * push,
          y: point.y + dy / distance * push
        )
      }
      result[page.id] = CGPoint(
        x: min(max(24, target.x), max(24, size.width - 24)),
        y: min(max(66, target.y), max(66, size.height - 28))
      )
    }
    return result
  }

  private func neuralFiberGeometry(
    start: CGPoint,
    end: CGPoint,
    edgeID: String,
    fiberIndex: Int
  ) -> (start: CGPoint, control1: CGPoint, control2: CGPoint, end: CGPoint) {
    let dx = end.x - start.x
    let dy = end.y - start.y
    let distance = max(1, hypot(dx, dy))
    let tangent = CGPoint(x: dx / distance, y: dy / distance)
    let normal = CGPoint(x: -tangent.y, y: tangent.x)
    let seed = ArkWikiGraphLayout.stableSeed(for: "\(edgeID)#fiber-\(fiberIndex)")
    let endpointSpread = min(15, max(4, distance * 0.035))
    let bodySpread = min(92, max(24, distance * 0.28))
    let startNormal = stableSignedUnit(seed, salt: 0x18A3) * endpointSpread
    let endNormal = stableSignedUnit(seed, salt: 0x31D7) * endpointSpread
    let startAlong = stableSignedUnit(seed, salt: 0x4F21) * 5
    let endAlong = stableSignedUnit(seed, salt: 0x63B9) * 5
    let firstSpread = stableSignedUnit(seed, salt: 0x7A55) * bodySpread
    let secondSpread = stableSignedUnit(seed, salt: 0x91C3) * bodySpread
    let firstProgress = 0.24 + stableSignedUnit(seed, salt: 0xA73D) * 0.075
    let secondProgress = 0.25 + stableSignedUnit(seed, salt: 0xC149) * 0.075

    let fiberStart = CGPoint(
      x: start.x + normal.x * startNormal + tangent.x * startAlong,
      y: start.y + normal.y * startNormal + tangent.y * startAlong
    )
    let fiberEnd = CGPoint(
      x: end.x + normal.x * endNormal + tangent.x * endAlong,
      y: end.y + normal.y * endNormal + tangent.y * endAlong
    )
    let control1 = CGPoint(
      x: fiberStart.x + tangent.x * distance * firstProgress + normal.x * firstSpread,
      y: fiberStart.y + tangent.y * distance * firstProgress + normal.y * firstSpread
    )
    let control2 = CGPoint(
      x: fiberEnd.x - tangent.x * distance * secondProgress + normal.x * secondSpread,
      y: fiberEnd.y - tangent.y * distance * secondProgress + normal.y * secondSpread
    )
    return (fiberStart, control1, control2, fiberEnd)
  }

  private func stableSignedUnit(_ seed: UInt64, salt: UInt64) -> CGFloat {
    var value = seed ^ (salt &* 0x9E37_79B9_7F4A_7C15)
    value ^= value >> 30
    value &*= 0xBF58_476D_1CE4_E5B9
    value ^= value >> 27
    value &*= 0x94D0_49BB_1331_11EB
    value ^= value >> 31
    return CGFloat(value & 0xFFFF) / CGFloat(0x7FFF) - 1
  }

  private func nodeSize(_ page: ArkWikiPage) -> CGFloat {
    let variation = ArkWikiGraphLayout.sizeVariation(for: page.id)
    let linkedSize = 6 + Double(page.links.count) * 1.15 + Double(variation) * 0.38
    return CGFloat(min(18, max(6, linkedSize)))
  }

  private func nodeScale(for emphasis: ArkWikiGraphNodeEmphasis) -> CGFloat {
    switch emphasis {
    case .selected: return 4.0
    case .neighbor: return 2.6
    case .normal: return 1
    case .receded: return 0.78
    }
  }

  private func nodeDiameter(
    _ page: ArkWikiPage,
    emphasis: ArkWikiGraphNodeEmphasis
  ) -> CGFloat {
    let projected = nodeSize(page) * nodeScale(for: emphasis)
    switch emphasis {
    case .selected: return min(38, max(30, projected))
    case .neighbor: return min(27, max(20, projected))
    case .normal: return projected
    case .receded: return max(4.5, projected)
    }
  }

  private func nodeOpacity(for emphasis: ArkWikiGraphNodeEmphasis) -> Double {
    switch emphasis {
    case .selected: return 1
    case .neighbor: return 0.98
    case .normal: return 0.94
    case .receded: return 0.34
    }
  }

  private func shadowOpacity(for emphasis: ArkWikiGraphNodeEmphasis) -> Double {
    switch emphasis {
    case .selected: return 0.95
    case .neighbor: return 0.70
    case .normal: return 0.42
    case .receded: return 0.14
    }
  }

  private func shadowRadius(for emphasis: ArkWikiGraphNodeEmphasis) -> CGFloat {
    switch emphasis {
    case .selected: return 19
    case .neighbor: return 13
    case .normal: return 8
    case .receded: return 3
    }
  }

  private func pulseIntensity(for emphasis: ArkWikiGraphNodeEmphasis) -> CGFloat {
    switch emphasis {
    case .selected: return 2.1
    case .neighbor: return 1.45
    case .normal: return 0.48
    case .receded: return 0.16
    }
  }

  private func starCoreOpacity(for emphasis: ArkWikiGraphNodeEmphasis) -> Double {
    switch emphasis {
    case .selected: return 0.96
    case .neighbor: return 0.82
    case .normal: return 0.68
    case .receded: return 0.28
    }
  }

  private func nodeZIndex(for emphasis: ArkWikiGraphNodeEmphasis) -> Double {
    switch emphasis {
    case .selected: return 3
    case .neighbor: return 2
    case .normal: return 1
    case .receded: return 0
    }
  }

  private func nodeColor(_ page: ArkWikiPage) -> Color {
    if layoutMode == .community, let community = page.community {
      return spectralPalette[abs(community) % spectralPalette.count]
    }
    let band: [Int] = switch page.category {
    case "concepts": [0, 1, 6]
    case "methodology": [2, 3, 8]
    case "overview": [4, 5, 1]
    case "evidence", "reviews": [6, 9, 0]
    default: Array(spectralPalette.indices)
    }
    let variation = Int(ArkWikiGraphLayout.stableSeed(for: page.id) % UInt64(band.count))
    return spectralPalette[band[variation]]
  }

  private func presentationColor(
    _ page: ArkWikiPage,
    emphasis: ArkWikiGraphNodeEmphasis
  ) -> Color {
    if emphasis == .selected {
      return Color(red: 1.0, green: 0.82, blue: 0.55)
    }
    return nodeColor(page)
  }

  private var spectralPalette: [Color] {
    [
      Color(red: 0.56, green: 0.43, blue: 0.98),
      Color(red: 0.35, green: 0.58, blue: 0.98),
      Color(red: 0.28, green: 0.86, blue: 0.78),
      Color(red: 0.25, green: 0.74, blue: 0.94),
      Color(red: 0.98, green: 0.78, blue: 0.29),
      Color(red: 0.98, green: 0.55, blue: 0.29),
      Color(red: 0.95, green: 0.36, blue: 0.64),
      Color(red: 0.77, green: 0.42, blue: 0.91),
      Color(red: 0.55, green: 0.88, blue: 0.39),
      Color(red: 0.92, green: 0.45, blue: 0.40),
    ]
  }

  private func legend(_ title: String, _ color: Color) -> some View {
    HStack(spacing: 4) {
      Circle().fill(color).frame(width: 8, height: 8)
      Text(title).font(.system(size: 10)).foregroundStyle(Color.white.opacity(0.62))
    }
  }
}

private struct NativeWikiStarNode: View {
  let color: Color
  let diameter: CGFloat
  let opacity: Double
  let coreOpacity: Double

  var body: some View {
    ZStack {
      Circle()
        .fill(
          RadialGradient(
            colors: [
              color.opacity(opacity * 0.30),
              color.opacity(opacity * 0.11),
              Color.clear,
            ],
            center: .center,
            startRadius: 0,
            endRadius: max(7, diameter * 1.10)
          )
        )
        .frame(width: diameter * 2.25, height: diameter * 2.25)

      Circle()
        .fill(
          RadialGradient(
            colors: [
              Color.white.opacity(coreOpacity),
              color.opacity(opacity * 0.96),
              color.opacity(opacity * 0.34),
              Color.clear,
            ],
            center: .center,
            startRadius: 0,
            endRadius: max(4, diameter * 0.62)
          )
        )
        .frame(width: diameter * 1.18, height: diameter * 1.18)

      Circle()
        .fill(Color.white.opacity(coreOpacity))
        .frame(width: max(2.2, diameter * 0.16), height: max(2.2, diameter * 0.16))
    }
    .compositingGroup()
  }
}

private struct NativeWikiStarfieldBackdrop: View {
  private struct DustStar {
    let x: CGFloat
    let y: CGFloat
    let size: CGFloat
    let opacity: Double
    let colorIndex: Int
  }

  private static let neuralBackground: NSImage? = Bundle.main
    .url(forResource: "WikiNeuralBackground", withExtension: "png")
    .flatMap(NSImage.init(contentsOf:))

  private static let dustStars: [DustStar] = (0..<72).map { index in
    DustStar(
      x: unit(index, 0xA17F),
      y: unit(index, 0xC04D),
      size: 0.55 + unit(index, 0x91E3) * 1.55,
      opacity: 0.16 + Double(unit(index, 0x73B9)) * 0.58,
      colorIndex: Int(unit(index, 0xE52B) * 4) % 4
    )
  }

  private static func unit(_ index: Int, _ salt: UInt64) -> CGFloat {
    var value = UInt64(index + 1) &* 0x9E37_79B9_7F4A_7C15
    value ^= salt &* 0xBF58_476D_1CE4_E5B9
    value ^= value >> 30
    value &*= 0xBF58_476D_1CE4_E5B9
    value ^= value >> 27
    value &*= 0x94D0_49BB_1331_11EB
    value ^= value >> 31
    return CGFloat(value & 0xFFFF) / CGFloat(0xFFFF)
  }

  var body: some View {
    GeometryReader { proxy in
      ZStack {
        if let background = Self.neuralBackground {
          Image(nsImage: background)
            .resizable()
            .scaledToFill()
            .frame(width: proxy.size.width, height: proxy.size.height)
            .clipped()
            .opacity(0.94)
        } else {
          LinearGradient(
            colors: [
              Color(red: 0.025, green: 0.034, blue: 0.056),
              Color(red: 0.020, green: 0.027, blue: 0.044),
            ],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
          )
        }

        Color.black.opacity(0.08)

        Canvas { context, size in
          let colors = [
            Color.white,
            Color(red: 0.67, green: 0.80, blue: 1.0),
            Color(red: 1.0, green: 0.86, blue: 0.65),
            Color(red: 0.78, green: 0.70, blue: 1.0),
          ]
          for star in Self.dustStars {
            let rect = CGRect(
              x: star.x * size.width,
              y: star.y * size.height,
              width: star.size,
              height: star.size
            )
            context.fill(
              Path(ellipseIn: rect),
              with: .color(colors[star.colorIndex].opacity(star.opacity))
            )
          }
        }
      }
    }
  }
}

private struct NativeWikiDetail: View {
  let model: ArkAppModel
  let page: ArkWikiPage?
  let reviews: [ArkWikiReview]
  let savingPageID: String?
  let saveError: String?
  let saveRevision: UInt64
  let reviewBusy: Bool
  let reviewError: String?
  let language: ArkLanguagePreference
  @State private var selectedSection = 0
  @State private var editing = false
  @State private var draft = ""
  @State private var baseline = ""
  @State private var showBulkIgnoreConfirmation = false

  private var unresolvedReviews: [ArkWikiReview] { reviews.filter { !$0.resolved } }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack {
        Picker(ArkL10n.text(.wikiInspector, language), selection: $selectedSection) {
          Text(ArkL10n.text(.wikiDetails, language)).tag(0)
          Text("\(ArkL10n.text(.wikiReview, language))（\(reviews.filter { !$0.resolved }.count)）").tag(1)
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .accessibilityLabel(ArkL10n.text(.wikiInspector, language))
        if selectedSection == 0, let page {
          Spacer()
          if savingPageID == page.id {
            ProgressView().controlSize(.small)
          }
          if editing {
            Button(ArkL10n.text(.wikiCancel, language)) {
              draft = baseline
              editing = false
              model.clearWikiSaveError()
            }
            .controlSize(.small)
            Button(ArkL10n.text(.wikiSave, language)) {
              model.saveKnowledgePage(
                id: page.id,
                content: draft,
                expectedContent: baseline
              )
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.small)
            .disabled(draft == baseline || savingPageID != nil)
          } else {
            Button(ArkL10n.text(.wikiEdit, language)) {
              baseline = page.body
              draft = page.body
              editing = true
              model.clearWikiSaveError()
            }
            .controlSize(.small)
            .disabled((page.byteCount > 0 && page.body.isEmpty) || savingPageID != nil)
          }
        }
        if selectedSection == 1 {
          Spacer()
          if reviewBusy { ProgressView().controlSize(.mini) }
          if unresolvedReviews.count > 1 {
            Button(ArkL10n.text(.wikiBulkIgnore, language)) {
              showBulkIgnoreConfirmation = true
            }
            .controlSize(.small)
            .disabled(reviewBusy)
            .accessibilityIdentifier("ark.wiki.review.bulk-ignore")
          }
        }
      }
      .padding(.horizontal, 14)
      .frame(height: 42)
      Divider().overlay(ArkPalette.border)
      if selectedSection == 1 {
        VStack(spacing: 0) {
          if let reviewError, !reviewError.isEmpty {
            Text(reviewError)
              .font(.system(size: 10))
              .foregroundStyle(Color.red)
              .frame(maxWidth: .infinity, alignment: .leading)
              .padding(8)
          }
          ScrollView {
            LazyVStack(spacing: 8) {
            ForEach(reviews) { review in
              VStack(alignment: .leading, spacing: 6) {
                HStack {
                  Text(review.title)
                    .font(.system(size: 12, weight: .semibold))
                  Spacer()
                  Text(review.resolved
                    ? ArkL10n.text(.wikiResolved, language)
                    : review.type)
                    .font(.system(size: 10))
                    .foregroundStyle(review.resolved ? Color.green : ArkPalette.secondary)
                }
                if !review.description.isEmpty {
                  Text(review.description)
                    .font(.system(size: 11))
                    .foregroundStyle(ArkPalette.secondary)
                }
                if !review.affectedPages.isEmpty {
                  Text(review.affectedPages.joined(separator: " · "))
                    .font(.system(size: 9, design: .monospaced))
                    .foregroundStyle(ArkPalette.secondary)
                    .lineLimit(2)
                }
                if !review.resolved {
                  HStack {
                    ForEach(review.actions) { option in
                      Button(option.label) {
                        model.resolveReview(review.id, action: option.action)
                      }
                      .buttonStyle(.bordered)
                      .controlSize(.small)
                      .disabled(reviewBusy)
                    }
                    if review.actions.isEmpty {
                      Button(ArkL10n.text(.wikiResolve, language)) {
                        model.resolveReview(review.id, action: nil)
                      }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                        .disabled(reviewBusy)
                    }
                  }
                }
              }
              .frame(maxWidth: .infinity, alignment: .leading)
              .padding(10)
              .background(ArkPalette.shell, in: RoundedRectangle(cornerRadius: 7))
              .overlay(RoundedRectangle(cornerRadius: 7).stroke(ArkPalette.border))
            }
            }
            .padding(10)
          }
        }
      } else if let page, editing {
        VStack(spacing: 0) {
          HStack(spacing: 8) {
            Image(systemName: "doc.text")
            Text(page.relativePath)
              .font(.system(size: 10, design: .monospaced))
              .lineLimit(1)
            Spacer()
            Text(ArkL10n.text(
              draft == baseline ? .wikiSaved : .wikiUnsaved,
              language
            ))
              .font(.system(size: 10))
              .foregroundStyle(draft == baseline ? ArkPalette.secondary : Color.orange)
          }
          .padding(.horizontal, 12)
          .frame(height: 32)
          Divider().overlay(ArkPalette.border)
          NativeCodeEditorView(
            text: $draft,
            fileURL: URL(fileURLWithPath: page.relativePath),
            isEditable: true
          )
          if let error = saveError {
            HStack(spacing: 8) {
              Image(systemName: "exclamationmark.triangle.fill")
              Text(error).lineLimit(2)
              Spacer()
              Button(ArkL10n.text(.wikiReload, language)) {
                editing = false
                model.clearWikiSaveError()
                model.selectWikiPage(page.id)
              }
              .controlSize(.small)
            }
            .font(.system(size: 11))
            .foregroundStyle(Color.orange)
            .padding(.horizontal, 12)
            .frame(minHeight: 36)
            .background(Color.orange.opacity(0.08))
          }
        }
      } else if let page {
        ScrollView {
          VStack(alignment: .leading, spacing: 12) {
            Text(page.title)
              .font(.system(size: 18, weight: .semibold))
            Text(page.relativePath)
              .font(.system(size: 10, design: .monospaced))
              .foregroundStyle(ArkPalette.secondary)
            Text(page.body)
              .font(.system(size: 12))
              .textSelection(.enabled)
          }
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(14)
        }
      } else {
        Text(ArkL10n.text(.wikiDetailEmpty, language))
          .font(.system(size: 12))
          .foregroundStyle(ArkPalette.secondary)
          .padding(14)
      }
    }
    .background(ArkPalette.panel)
    .onAppear { synchronizeDraft(with: page) }
    .onChange(of: page?.id) { _ in synchronizeDraft(with: page) }
    .onChange(of: page?.body) { _ in
      if !editing { synchronizeDraft(with: page) }
    }
    .onChange(of: saveRevision) { _ in
      guard let page, saveError == nil else { return }
      baseline = draft
      editing = false
      model.selectWikiPage(page.id)
    }
    .confirmationDialog(
      ArkL10n.text(.wikiBulkIgnoreConfirmTitle, language),
      isPresented: $showBulkIgnoreConfirmation,
      titleVisibility: .visible
    ) {
      Button(ArkL10n.text(.wikiBulkIgnoreConfirm, language), role: .destructive) {
        model.resolveReviews(unresolvedReviews.map(\.id), action: "Skip")
      }
      Button(ArkL10n.text(.wikiCancel, language), role: .cancel) {}
    } message: {
      Text(ArkL10n.format(
        .wikiBulkIgnoreConfirmDetail,
        language,
        arguments: [String(unresolvedReviews.count)]
      ))
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
  }

  private func synchronizeDraft(with page: ArkWikiPage?) {
    draft = page?.body ?? ""
    baseline = page?.body ?? ""
    editing = false
    model.clearWikiSaveError()
  }
}

private struct NativeDetailsPlaceholder: View {
  @ObservedObject var model: ArkAppModel
  let close: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack {
        Text(ArkL10n.text(
          model.selectedToolActivity == nil ? .wikiDetails : .toolDetailTitle,
          model.languagePreference
        ))
          .font(.system(size: 12, weight: .semibold))
        Spacer()
        Button(action: close) { Image(systemName: "xmark") }
          .buttonStyle(.borderless)
          .help(ArkL10n.text(.closeDetail, model.languagePreference))
      }
      Divider().overlay(ArkPalette.border)
      if let activity = model.selectedToolActivity {
        NativeToolPresentationDetail(activity: activity)
      } else {
        Text(ArkL10n.text(.toolDetailEmpty, model.languagePreference))
          .font(.system(size: 12))
          .foregroundStyle(ArkPalette.secondary)
      }
      Spacer()
    }
    .padding(14)
    .background(ArkPalette.panel)
  }
}

private struct NativeSettingsView: View {
  /// 设置页：系统管理 selection / hover / keyboard focus 与整行点击。
  private enum SettingsPage: String, CaseIterable, Identifiable {
    case general
    case models
    case plugins
    case presets

    var id: String { rawValue }
    var icon: String {
      switch self {
      case .general: return "gearshape"
      case .models: return "cylinder"
      case .presets: return "person.3"
      case .plugins: return "puzzlepiece.extension"
      }
    }
    func title(_ language: ArkLanguagePreference) -> String {
      switch self {
      case .general: return ArkL10n.text(.settingsGeneral, language)
      case .models: return ArkL10n.text(.settingsModels, language)
      case .plugins: return ArkL10n.text(.settingsPlugins, language)
      case .presets: return ArkL10n.text(.settingsPresets, language)
      }
    }
  }

  @ObservedObject var model: ArkAppModel
  @Binding var appearance: ArkAppearancePreference
  @Binding var language: ArkLanguagePreference
  let onClose: () -> Void
  @State private var page: SettingsPage = .general
  @FocusState private var focusedPage: SettingsPage?

  var body: some View {
    NavigationSplitView {
      VStack(spacing: 4) {
        ForEach(SettingsPage.allCases) { item in
          Button {
            selectSettingsPage(item)
          } label: {
            Label {
              Text(item.title(model.languagePreference))
            } icon: {
              Image(systemName: item.icon)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 10)
            .frame(height: 32)
            .background(
              page == item ? ArkPalette.raised : Color.clear,
              in: RoundedRectangle(cornerRadius: 7)
            )
            .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .focusable()
          .focused($focusedPage, equals: item)
          .accessibilityLabel(item.title(model.languagePreference))
          .accessibilityIdentifier("ark.settings.sidebar.\(item.rawValue)")
          .accessibilityAddTraits(page == item ? [.isSelected] : [])
        }
        Spacer(minLength: 0)
      }
      .padding(8)
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
      .background(ArkPalette.sidebar)
      .navigationSplitViewColumnWidth(min: 180, ideal: 200, max: 220)
      .onMoveCommand(perform: moveSettingsPage)
      .onAppear {
        DispatchQueue.main.async { focusedPage = page }
      }
    } detail: {
      VStack(spacing: 0) {
        HStack(spacing: 12) {
          VStack(alignment: .leading, spacing: 2) {
            Text(page.title(model.languagePreference))
              .font(.system(size: 16, weight: .semibold))
            if page == .general {
              Text(ArkL10n.text(.generalSubtitle, model.languagePreference))
                .font(.system(size: 12))
                .foregroundStyle(ArkPalette.secondary)
                .lineLimit(1)
            }
          }
          Spacer()
          if model.settingsSnapshot?.hasDocument == true {
            Button(ArkL10n.text(.settingsOpenConfigFile, model.languagePreference), action: model.openSettingsDocument)
              .buttonStyle(.bordered)
              .controlSize(.small)
              .disabled(model.settingsBusy)
          }
          Button {
            onClose()
          } label: {
            Image(systemName: "xmark")
              .font(.system(size: 12, weight: .semibold))
              .frame(width: 28, height: 28)
              .contentShape(Circle())
          }
          .buttonStyle(.plain)
          .keyboardShortcut(.cancelAction)
          .help(ArkL10n.text(.settingsClose, model.languagePreference))
          .accessibilityLabel(ArkL10n.text(.settingsClose, model.languagePreference))
          .accessibilityIdentifier("ark.settings.close")
        }
        .padding(.horizontal, 16)
        .frame(height: 54)

        Divider().overlay(ArkPalette.border)
        if let error = model.settingsErrorMessage, !error.isEmpty {
          NativeSettingsNotice(text: error, color: .red, icon: "exclamationmark.triangle.fill")
            .accessibilityIdentifier("ark.settings.error")
            .padding(.horizontal, 16)
            .padding(.top, 12)
        }

        Group {
          switch page {
          case .general: NativeGeneralSettings(model: model, appearance: $appearance)
          case .models: NativeModelsSettings(model: model)
          case .presets: NativeAgentPresetSettings(model: model, onClose: onClose)
          case .plugins: NativePluginSettings(model: model)
          }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
      }
      .background(ArkPalette.panel)
    }
    .background(ArkPalette.panel)
    .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 16, style: .continuous)
        .stroke(ArkPalette.border)
    )
    .shadow(color: .black.opacity(0.20), radius: 20, y: 8)
    .accessibilityIdentifier("ark.settings.window")
    .onExitCommand(perform: onClose)
    .task { await model.loadSettings() }
  }

  private func selectSettingsPage(_ item: SettingsPage) {
    page = item
    focusedPage = item
  }

  private func moveSettingsPage(_ direction: MoveCommandDirection) {
    let pages = SettingsPage.allCases
    let current = focusedPage ?? page
    guard let index = pages.firstIndex(of: current) else { return }
    let offset: Int
    switch direction {
    case .up, .left: offset = -1
    case .down, .right: offset = 1
    default: return
    }
    selectSettingsPage(pages[min(max(index + offset, 0), pages.count - 1)])
  }
}

private struct NativeGeneralSettings: View {
  @ObservedObject var model: ArkAppModel
  @Binding var appearance: ArkAppearancePreference
  @State private var showDangerConfirmation = false

  private var language: ArkLanguagePreference { model.languagePreference }

  private var selectablePresets: [ArkAgentPreset] {
    model.agentPresetRoster?.presets.filter { $0.broken == nil } ?? []
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 0) {
        // 分组 1：默认预设
        settingsGroup(title: .groupDefaultPresetTitle, subtitle: .groupDefaultPresetSubtitle) {
          if selectablePresets.isEmpty {
            Text(ArkL10n.text(.permissionUnavailable, language))
              .foregroundStyle(ArkPalette.secondary)
          } else {
            Picker("", selection: Binding(
              get: { model.defaultAgentPresetID ?? selectablePresets[0].id },
              set: { model.setDefaultAgentPreset($0) }
            )) {
              ForEach(selectablePresets) { preset in
                Text(ArkL10n.presetDisplayTitle(id: preset.id, name: preset.name, language)).tag(preset.id)
              }
            }
            .labelsHidden()
            .pickerStyle(.menu)
            .frame(maxWidth: 220)
          }
        }

        // 分组 2：默认权限
        settingsGroup(title: .groupDefaultPermissionTitle, subtitle: .groupDefaultPermissionSubtitle) {
          Picker("", selection: Binding(
            get: { model.defaultPermissionPreset ?? "read-only" },
            set: { preset in
              if preset == "danger-full-access" {
                showDangerConfirmation = true
              } else {
                model.setDefaultPermissionPreset(preset)
              }
            }
          )) {
            Text(ArkL10n.text(.permissionReadOnly, language)).tag("read-only")
            Text(ArkL10n.text(.permissionWorkspaceAccess, language)).tag("workspace-write")
            Text(ArkL10n.text(.permissionFullAccess, language)).tag("danger-full-access")
          }
          .labelsHidden()
          .pickerStyle(.menu)
          .frame(maxWidth: 190)
          .disabled(model.settingsSnapshot?.writable != true || model.settingsBusy)
        }

        // 分组 3：界面语言
        settingsGroup(title: .groupInterfaceLanguageTitle, subtitle: .groupInterfaceLanguageSubtitle) {
          Picker("", selection: Binding(
            get: { model.languagePreference },
            set: { model.setLanguagePreference($0.rawValue) }
          )) {
            ForEach(ArkLanguagePreference.allCases) { candidate in
              Text(candidate.displayName).tag(candidate)
            }
          }
          .labelsHidden()
          .pickerStyle(.menu)
          .frame(maxWidth: 160)
        }

        // 分组 4：外观
        settingsGroup(title: .groupAppearanceTitle, subtitle: .groupAppearanceSubtitle) {
          HStack(spacing: 8) {
            NativeAppearanceChoice(
              title: ArkL10n.text(.appearanceLight, language),
              icon: "sun.max",
              selected: appearance == .light,
              action: { appearance = .light }
            )
            NativeAppearanceChoice(
              title: ArkL10n.text(.appearanceDark, language),
              icon: "moon",
              selected: appearance == .dark,
              action: { appearance = .dark }
            )
            NativeAppearanceChoice(
              title: ArkL10n.text(.appearanceSystem, language),
              icon: "circle.lefthalf.filled",
              selected: appearance == .system,
              action: { appearance = .system }
            )
          }
        }

        // 分组 5：回车键行为（特殊模式：仅在智能体运行时生效）
        settingsGroup(title: .groupEnterKeyTitle, subtitle: .groupEnterKeySubtitle) {
          Picker("", selection: $model.busyEnterBehavior) {
            Text(ArkL10n.text(.enterQueueSend, language)).tag(ArkPromptDeliveryMode.queue)
            Text(ArkL10n.text(.enterInterjectNow, language)).tag(ArkPromptDeliveryMode.steer)
          }
          .labelsHidden()
          .pickerStyle(.menu)
          .frame(maxWidth: 160)
        }

        // 分组 6：运行边界（只读信息）
        settingsGroup(title: .groupRuntimeBoundaryTitle, subtitle: nil) {
          VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
              Text(ArkL10n.text(.runtimeInterface, language))
                .foregroundStyle(ArkPalette.secondary)
              Text(ArkL10n.text(.runtimeInterfaceValue, language))
            }
            HStack(spacing: 8) {
              Text(ArkL10n.text(.runtimeBackend, language))
                .foregroundStyle(ArkPalette.secondary)
              Text(ArkL10n.text(.runtimeBackendValue, language))
            }
            Divider()
              .padding(.vertical, 4)
            HStack(alignment: .top, spacing: 8) {
              Image(systemName: "exclamationmark.shield")
                .foregroundStyle(.orange)
                .accessibilityHidden(true)
              VStack(alignment: .leading, spacing: 3) {
                Text(ArkL10n.text(.runtimeSafetyTitle, language))
                  .fontWeight(.semibold)
                Text(ArkL10n.text(.runtimeSafetyDetail, language))
                  .foregroundStyle(ArkPalette.secondary)
                  .fixedSize(horizontal: false, vertical: true)
              }
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("ark.settings.runtime-boundary.safety")
          }
          .font(.system(size: 12))
        }
      }
      .padding(.horizontal, 24)
      .padding(.bottom, 24)
    }
    .sheet(isPresented: $showDangerConfirmation) {
      NativeDangerPermissionConfirmation(
        isPresented: $showDangerConfirmation,
        language: language,
        confirm: { model.setDefaultPermissionPreset("danger-full-access") }
      )
    }
  }

  /// 三层结构分组：标题、说明、右对齐控件；底部细分割线，克制的原生留白。
  private func settingsGroup(
    title: ArkL10n.Key,
    subtitle: ArkL10n.Key?,
    @ViewBuilder control: () -> some View
  ) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      Text(ArkL10n.text(title, language))
        .font(.system(size: 13, weight: .semibold))
      if let subtitle {
        Text(ArkL10n.text(subtitle, language))
          .font(.system(size: 11))
          .foregroundStyle(ArkPalette.secondary)
      }
      HStack {
        Spacer()
        control()
      }
      .frame(maxWidth: .infinity)
    }
    .padding(.vertical, 16)
    .overlay(alignment: .bottom) { Divider().overlay(ArkPalette.border) }
  }
}

private struct NativeSettingsPreferenceRow<Control: View>: View {
  let title: String
  var detail: String?
  @ViewBuilder let control: () -> Control

  init(
    title: String,
    detail: String? = nil,
    @ViewBuilder control: @escaping () -> Control
  ) {
    self.title = title
    self.detail = detail
    self.control = control
  }

  var body: some View {
    HStack(alignment: .center, spacing: 20) {
      VStack(alignment: .leading, spacing: 4) {
        Text(title)
          .font(.system(size: 14))
        if let detail {
          Text(detail)
            .font(.system(size: 12))
            .foregroundStyle(ArkPalette.secondary)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      Spacer(minLength: 16)
      control()
    }
    .padding(.vertical, 16)
    .overlay(alignment: .bottom) { Divider().overlay(ArkPalette.border) }
  }
}

private struct NativeAppearanceChoice: View {
  let title: String
  let icon: String
  let selected: Bool
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      Label(title, systemImage: icon)
        .font(.system(size: 11, weight: selected ? .semibold : .regular))
        .foregroundStyle(selected ? ArkPalette.primary : ArkPalette.secondary)
        .frame(maxWidth: .infinity)
        .frame(height: 36)
        .contentShape(Rectangle())
        .background(
          selected ? ArkPalette.raised : Color.clear,
          in: RoundedRectangle(cornerRadius: 9)
        )
        .overlay(
          RoundedRectangle(cornerRadius: 9)
            .stroke(selected ? ArkPalette.accent.opacity(0.75) : ArkPalette.border)
        )
    }
    .buttonStyle(.plain)
    .accessibilityAddTraits(selected ? .isSelected : [])
  }
}

private struct NativeProviderModelDraft: Identifiable, Equatable {
  let id: UUID
  var modelID: String
  var name: String
  var contextWindow: String
  var maxTokens: String

  init(
    id: UUID = UUID(),
    modelID: String = "",
    name: String = "",
    contextWindow: String = "",
    maxTokens: String = ""
  ) {
    self.id = id
    self.modelID = modelID
    self.name = name
    self.contextWindow = contextWindow
    self.maxTokens = maxTokens
  }

  var input: ArkProviderModelInput? {
    let normalizedID = modelID.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !normalizedID.isEmpty else { return nil }
    let contextText = contextWindow.trimmingCharacters(in: .whitespacesAndNewlines)
    let maximumText = maxTokens.trimmingCharacters(in: .whitespacesAndNewlines)
    let context = contextText.isEmpty ? nil : parseModelCapacity(contextText)
    let maximum = maximumText.isEmpty ? nil : parseModelCapacity(maximumText)
    guard (contextText.isEmpty || context != nil),
          (maximumText.isEmpty || maximum != nil)
    else { return nil }
    return ArkProviderModelInput(
      id: normalizedID,
      name: name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        ? nil : name.trimmingCharacters(in: .whitespacesAndNewlines),
      contextWindow: context,
      maxTokens: maximum
    )
  }
}

private func parseModelCapacity(_ raw: String) -> Int? {
  let text = raw.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
  guard !text.isEmpty else { return nil }
  let multiplier: Int
  let digits: Substring
  if text.hasSuffix("K") {
    multiplier = 1_024
    digits = text.dropLast()
  } else if text.hasSuffix("M") {
    multiplier = 1_048_576
    digits = text.dropLast()
  } else {
    multiplier = 1
    digits = Substring(text)
  }
  guard let count = Int(digits), count > 0,
        count <= Int.max / multiplier
  else { return nil }
  return count * multiplier
}

private func normalizedAPIKey(_ raw: String) -> String? {
  if raw.isEmpty { return "" }
  var value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !value.isEmpty else { return nil }
  if value.hasPrefix("export ") {
    value = String(value.dropFirst(7)).trimmingCharacters(in: .whitespacesAndNewlines)
  }
  if let equals = value.firstIndex(of: "=") {
    let name = String(value[..<equals]).trimmingCharacters(in: .whitespacesAndNewlines)
    let assignmentLike = name.range(of: #"^[A-Z][A-Z0-9_]*$"#, options: .regularExpression) != nil
    if assignmentLike {
      guard name == "API_KEY" || name.hasSuffix("_API_KEY") else { return nil }
      value = String(value[value.index(after: equals)...]).trimmingCharacters(in: .whitespacesAndNewlines)
      guard !value.isEmpty, !value.hasPrefix("=") else { return nil }
    }
  }
  if value.count >= 2,
     let first = value.first,
     (first == "\"" || first == "'"),
     value.last == first {
    value = String(value.dropFirst().dropLast()).trimmingCharacters(in: .whitespacesAndNewlines)
  }
  guard !value.isEmpty,
        value.unicodeScalars.allSatisfy({ 0x21...0x7E ~= $0.value })
  else { return nil }
  return value
}

private struct NativeSubagentModelSelectionCard: View {
  @ObservedObject var model: ArkAppModel
  @State private var enabled = false
  @State private var selectedRoutes = Set<String>()
  @State private var didLoad = false

  private var namespace: ArkSettingsNamespace? {
    model.settingsSnapshot?.namespaces.first { $0.id == "subagent-model-selection" }
  }

  private var groups: [ArkModelProviderGroup] {
    model.availableModelGroups
  }

  private var selectedAvailableRoutes: [ArkModelSelection] {
    groups.flatMap { group in
      group.models.compactMap { item in
        selectedRoutes.contains(routeKey(provider: group.id, model: item.id))
          ? ArkModelSelection(provider: group.id, model: item.id) : nil
      }
    }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .firstTextBaseline) {
        VStack(alignment: .leading, spacing: 3) {
          Text(ArkL10n.text(.subagentModelSelectionTitle, model.languagePreference))
            .font(.system(size: 14, weight: .semibold))
          Text(ArkL10n.text(.subagentModelSelectionDetail, model.languagePreference))
            .font(.system(size: 11))
            .foregroundStyle(ArkPalette.secondary)
        }
        Spacer(minLength: 8)
        Toggle(
          ArkL10n.text(.subagentModelSelectionEnabled, model.languagePreference),
          isOn: $enabled
        )
        .toggleStyle(.switch)
        .labelsHidden()
        .accessibilityLabel(ArkL10n.text(.subagentModelSelectionEnabled, model.languagePreference))
      }

      if enabled && groups.isEmpty {
        Text(ArkL10n.text(.subagentModelSelectionNoModels, model.languagePreference))
          .font(.system(size: 11))
          .foregroundStyle(ArkPalette.secondary)
      } else if enabled {
        VStack(alignment: .leading, spacing: 7) {
          ForEach(groups) { group in
            VStack(alignment: .leading, spacing: 4) {
              Text(group.name)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(ArkPalette.secondary)
              ForEach(group.models) { item in
                let key = routeKey(provider: group.id, model: item.id)
                Toggle(isOn: Binding(
                  get: { selectedRoutes.contains(key) },
                  set: { isSelected in
                    if isSelected { selectedRoutes.insert(key) }
                    else { selectedRoutes.remove(key) }
                  }
                )) {
                  HStack(spacing: 6) {
                    Text(item.name)
                    Text(item.id)
                      .font(.system(size: 9, design: .monospaced))
                      .foregroundStyle(ArkPalette.secondary)
                  }
                }
                .toggleStyle(.checkbox)
              }
            }
          }
        }
      }

      HStack {
        Spacer()
        Button(ArkL10n.text(.commonSave, model.languagePreference)) {
          let routes = selectedAvailableRoutes
          Task { _ = await model.saveSubagentModelSelection(enabled: enabled, routes: routes) }
        }
        .buttonStyle(.borderedProminent)
        .disabled(
          model.settingsSnapshot?.writable != true
            || model.settingsBusy
            || (enabled && selectedAvailableRoutes.isEmpty)
        )
      }
    }
    .padding(14)
    .background(ArkPalette.raised.opacity(0.42), in: RoundedRectangle(cornerRadius: 12))
    .overlay(RoundedRectangle(cornerRadius: 12).stroke(ArkPalette.border))
    .onAppear(perform: loadStored)
    .onChange(of: namespace?.revision) { _ in
      if !didLoad { loadStored() }
    }
    .accessibilityIdentifier("ark.settings.subagent-model-selection")
  }

  private func loadStored() {
    guard !didLoad, let namespace else { return }
    enabled = namespace.value["enabled"]?.boolValue == true
    selectedRoutes = Set((namespace.value["allowedModels"]?.arrayValue ?? []).compactMap { row in
      guard let provider = row["provider"]?.stringValue,
            let modelID = row["model"]?.stringValue,
            !provider.isEmpty,
            !modelID.isEmpty
      else { return nil }
      return routeKey(provider: provider, model: modelID)
    })
    didLoad = true
  }

  private func routeKey(provider: String, model: String) -> String {
    "\(provider)\0\(model)"
  }
}

private struct NativeModelsSettings: View {
  @ObservedObject var model: ArkAppModel
  @State private var addingProviderID: String?
  @State private var showCustomProvider = false

  private var providerFamilies: [ArkProviderPresentation.Group<ArkProviderView>] {
    ArkProviderPresentation.groups(ArkProviderPresentation.standardChoices(model.providers, id: { $0.id }), id: { $0.id }, name: { $0.displayName })
  }

  private var visibleFamilies: [ArkProviderPresentation.Group<ArkProviderView>] {
    providerFamilies.filter { family in
      family.entries.contains { providerIsConfigured($0) || addingProviderID == $0.id }
    }
  }

  private var addableProviders: [ArkProviderView] {
    dormantFamilies.compactMap { $0.entries.first }.filter { addingProviderID != $0.id }
  }

  private var dormantFamilies: [ArkProviderPresentation.Group<ArkProviderView>] {
    providerFamilies.filter { family in
      !family.entries.contains(where: providerIsConfigured)
        && family.entries.contains { !$0.settingsNamespace.isEmpty }
    }
  }

  private func selectedProvider(in family: ArkProviderPresentation.Group<ArkProviderView>) -> ArkProviderView? {
    family.entries.first { provider in model.availableModelGroups.contains { $0.id == provider.id } }
      ?? family.entries.first(where: providerIsConfigured)
      ?? family.entries.first
  }

  private var anyUsableProvider: Bool {
    model.providers.contains { provider in
      guard provider.active else { return false }
      let ref = model.credentialReference(for: provider)
      return model.credentialStates[ref]?.configured == true
        || provider.settingsNamespace.isEmpty
    }
  }

  private func providerIsConfigured(_ provider: ArkProviderView) -> Bool {
    guard !provider.settingsNamespace.isEmpty else { return provider.active }
    if provider.settingsPath.isEmpty { return true }
    guard let namespace = model.settingsSnapshot?.namespaces.first(where: { $0.id == provider.settingsNamespace }) else {
      return provider.active
    }
    return namespace.value.value(at: provider.settingsPath) != nil || provider.active
  }

  var body: some View {
    VStack(spacing: 0) {
      HStack {
        VStack(alignment: .leading, spacing: 3) {
          Text("模型").font(.system(size: 16, weight: .medium))
          Text("内置地址、协议和模型目录。填入密钥并选择模型；特殊平台按其要求完成认证。")
            .font(.system(size: 14)).foregroundStyle(ArkPalette.secondary)
        }
        Spacer()
        if model.settingsBusy { ProgressView().controlSize(.small) }
        Button { Task { await model.loadSettings() } } label: { Image(systemName: "arrow.clockwise") }
          .buttonStyle(.borderless)
      }
      .padding(22)
      Divider().overlay(ArkPalette.border)
      ScrollView {
        // Expanding settings cards need stable geometry and draft lifetimes across scrolling.
        VStack(spacing: 12) {
          if model.settingsSnapshot?.namespaces.contains(where: { $0.id == "subagent-model-selection" }) == true {
            NativeSubagentModelSelectionCard(model: model)
          }
          ForEach(visibleFamilies) { family in
            if let provider = selectedProvider(in: family) {
            let addingFamily = addingProviderID.map { ArkProviderPresentation.familyID(for: $0) } == family.id
            VStack(alignment: .leading, spacing: 8) {
              if addingFamily {
                HStack {
                  Text("提供方").font(.system(size: 12, weight: .medium))
                  Picker("提供方", selection: Binding(
                    get: { family.id },
                    set: { id in addingProviderID = dormantFamilies.first { $0.id == id }?.entries.first?.id }
                  )) {
                    ForEach(dormantFamilies) { candidate in
                      Label {
                        Text(candidate.name)
                      } icon: {
                        ArkProviderMark(providerID: candidate.entries.first?.id ?? candidate.id, label: candidate.name, size: 16)
                      }
                      .tag(candidate.id)
                    }
                  }
                  .labelsHidden()
                  .pickerStyle(.menu)
                  Spacer()
                }
                .padding(.horizontal, 14)
                .padding(.top, 10)
              }
              NativeProviderSettingsCard(
                model: model,
                provider: provider,
                startsExpanded: addingFamily || !providerIsConfigured(provider)
                  || (!anyUsableProvider && provider.settingsPath.isEmpty
                    && model.credentialStates[model.credentialReference(for: provider)]?.configured != true),
                onCancel: addingFamily ? {
                  addingProviderID = nil
                } : nil
              )
              .id(provider.id)
            }
            }
          }
          if visibleFamilies.isEmpty, !model.settingsBusy {
            NativeSettingsEmpty(title: "没有 Provider", icon: "cpu", detail: "本机服务没有报告可配置的 Provider。")
          }

          if showCustomProvider {
            NativeCustomProviderEditor(model: model, isPresented: $showCustomProvider)
          }

          HStack(spacing: 10) {
            Button {
              addingProviderID = addableProviders.first?.id
            } label: {
              Label("添加提供方", systemImage: "plus")
                .frame(maxWidth: .infinity)
                .frame(height: 44)
            }
            .buttonStyle(.plain)
            .overlay(
              RoundedRectangle(cornerRadius: 12)
                .stroke(ArkPalette.border, style: StrokeStyle(lineWidth: 1, dash: [5, 4]))
            )
            .disabled(addableProviders.isEmpty || model.settingsSnapshot?.writable != true)

            Button {
              showCustomProvider = true
            } label: {
              Label("添加自定义提供方", systemImage: "plus")
                .frame(maxWidth: .infinity)
                .frame(height: 44)
            }
            .buttonStyle(.plain)
            .overlay(
              RoundedRectangle(cornerRadius: 12)
                .stroke(ArkPalette.border, style: StrokeStyle(lineWidth: 1, dash: [5, 4]))
            )
            .disabled(model.settingsSnapshot?.writable != true)
          }
        }
        .padding(.horizontal, 24)
        .padding(.bottom, 24)
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}

private struct NativeProviderSettingsCard: View {
  @ObservedObject var model: ArkAppModel
  let provider: ArkProviderView
  let onCancel: (() -> Void)?
  @State private var expanded: Bool
  @State private var credentialRef = ""
  @State private var secret = ""
  @State private var confirmProfileRemoval = false
  @State private var displayName = ""
  @State private var baseURL = ""
  @State private var api = "openai-completions"
  @State private var models: [NativeProviderModelDraft] = []
  @State private var advanced = false
  @State private var showDiscoveredModels = false
  @State private var migrateLegacyCredentials = false
  @State private var connectionTest: Task<Void, Never>?
  @State private var connectionStatus: String?

  init(
    model: ArkAppModel,
    provider: ArkProviderView,
    startsExpanded: Bool = false,
    onCancel: (() -> Void)? = nil
  ) {
    self.model = model
    self.provider = provider
    self.onCancel = onCancel
    _expanded = State(initialValue: startsExpanded)
  }

  private var effectiveCredentialRef: String {
    credentialRef.isEmpty ? model.credentialReference(for: provider) : credentialRef
  }

  private var state: ArkCredentialView? { model.credentialStates[effectiveCredentialRef] }

  private var profileRemovable: Bool {
    guard !provider.settingsPath.isEmpty,
          let namespace = model.settingsSnapshot?.namespaces.first(where: { $0.id == provider.settingsNamespace })
    else { return false }
    return namespace.user?.value(at: provider.settingsPath) != nil
      && namespace.base?.value(at: provider.settingsPath) == nil
  }

  private var modelsValid: Bool {
    let inputs = models.compactMap(\.input)
    return inputs.count == models.count && Set(inputs.map(\.id)).count == inputs.count
  }

  private var endpointInvalid: Bool {
    !baseURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      && ArkHTTPURLInput.normalizedHTTPURL(baseURL) == nil
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: 11) {
        Button {
          let opening = !expanded
          expanded = opening
          if opening { loadDraft() }
        } label: {
          HStack(spacing: 11) {
            ArkProviderMark(providerID: provider.id, label: provider.displayName)
            VStack(alignment: .leading, spacing: 2) {
              Text(ArkProviderPresentation.displayName(for: provider.id, fallback: provider.displayName))
                .font(.system(size: 13, weight: .semibold))
            }
            Spacer(minLength: 12)
            Text(statusLabel)
              .font(.system(size: 10, weight: .semibold))
              .foregroundStyle(statusColor)
            Image(systemName: expanded ? "chevron.down" : "chevron.right")
              .font(.system(size: 10, weight: .semibold))
              .foregroundStyle(ArkPalette.secondary)
              .frame(width: 14)
          }
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .frame(maxWidth: .infinity)
        .accessibilityLabel([
          provider.displayName,
          statusLabel,
          ArkL10n.text(
            expanded ? .extensionCollapseDetails : .extensionExpandDetails,
            model.languagePreference
          ),
        ].joined(separator: ", "))
        .accessibilityValue(ArkL10n.text(
          expanded ? .extensionCollapseDetails : .extensionExpandDetails,
          model.languagePreference
        ))
        if profileRemovable {
          Button(role: .destructive) { confirmProfileRemoval = true } label: {
            Image(systemName: "trash")
          }
          .buttonStyle(.borderless)
          .help("删除 Provider")
        }
      }
      .padding(.horizontal, 13)
      .frame(minHeight: 56)
      if let diagnostic = provider.configurationError {
        NativeSettingsNotice(text: diagnostic, color: .orange, icon: "exclamationmark.triangle")
          .padding(.horizontal, 13)
        Button(ArkL10n.text(.settingsOpenConfigFile, model.languagePreference), action: model.openSettingsDocument)
          .padding(.horizontal, 13)
      }
      if let transaction = model.providerTransactionStates[provider.id], transaction.state != .absent {
        VStack(alignment: .leading, spacing: 8) {
          Text("此前的配置保存需要确认：\(transaction.state.rawValue)")
            .font(.system(size: 11, weight: .medium))
          Text("恢复仅处理此前的保存，不会提交下方的新草稿。无法安全续写时会保留现有配置并报告失败。")
            .font(.system(size: 11))
            .foregroundStyle(ArkPalette.secondary)
          if transaction.needsCredential {
            Text("如需补回密钥，请在展开后的 API 密钥框输入此前同一密钥，再点击恢复；密钥不会写入草稿或回执。")
              .font(.system(size: 11))
              .foregroundStyle(ArkPalette.secondary)
          }
          Button(transaction.state.isTerminal ? "确认此前保存结果" : "恢复此前保存") {
            Task {
              let replaySecret = secret.isEmpty ? nil : normalizedAPIKey(secret)
              let restored = await model.restoreProviderConfiguration(
                provider: provider, transactionID: transaction.transactionID, credentialValue: replaySecret
              )
              secret = ""
              if restored { loadDraft() }
            }
          }
          .disabled(model.settingsBusy)
        }
        .padding(14)
        .background(ArkPalette.raised)
      }
      if expanded {
        Divider().overlay(ArkPalette.border)
        VStack(alignment: .leading, spacing: 12) {
          if provider.settingsNamespace.isEmpty {
            NativeSettingsNotice(
              text: "此实时路由没有公布可写的 Provider 设置位置，只能查看注册状态。",
              color: ArkPalette.secondary,
              icon: "lock"
            )
          } else {
            Text("API Key 保存在 macOS Keychain，不写入模型设置文件。")
              .font(.system(size: 10)).foregroundStyle(ArkPalette.secondary)
            SecureField(state?.configured == true ? "已配置；留空保持不变" : "输入 API 密钥", text: $secret)
              .textFieldStyle(.roundedBorder)
              .accessibilityLabel("API 密钥")
            NativeProviderLoginControls(
              controls: ArkProviderLoginRegistry.controls(for: provider.id),
              language: model.languagePreference
            )
            if let migration = provider.migrationRequired {
              NativeSettingsNotice(
                text: "旧凭据字段需要迁移：\(migration.fields.joined(separator: "、"))。字段值不会显示。",
                color: .orange, icon: "exclamationmark.shield"
              )
              if migration.canMigrateUserFields {
                Toggle("移除用户层旧明文字段，并用上方新输入的密钥保存到凭据服务", isOn: $migrateLegacyCredentials)
                  .accessibilityIdentifier("ark.provider.\(provider.id).migrate")
              } else {
                Text("这些字段来自部署配置或缺少安全处理路径，需先修正配置来源；这里不会覆盖部署配置。")
                  .font(.system(size: 10))
                  .foregroundStyle(ArkPalette.secondary)
              }
            }
            if normalizedAPIKey(secret) == nil {
              Text("API 密钥格式无效，请重新粘贴。")
                .font(.system(size: 10))
                .foregroundStyle(Color.red)
            }

            if provider.settingsNamespace == "llm-pi-ai" {
              HStack {
                VStack(alignment: .leading, spacing: 3) {
                  Text("模型").font(.system(size: 12, weight: .medium))
                  Text(models.isEmpty
                    ? (provider.declared == true ? "尚未添加模型" : "使用此提供方的全部内置模型")
                    : "已选择 \(models.count) 个模型")
                    .foregroundStyle(ArkPalette.secondary)
                }
                Spacer()
                Button("选择模型") {
                  model.clearDiscoveredModels()
                  showDiscoveredModels = true
                  model.discoverProviderModels(
                    provider: provider, baseURL: baseURL, api: api,
                    unsavedAPIKey: normalizedAPIKey(secret) ?? ""
                  )
                }
                .disabled(endpointInvalid || model.modelDiscoveryBusy || normalizedAPIKey(secret) == nil)
                .accessibilityIdentifier("ark.provider.\(provider.id).models")
                if !models.isEmpty && provider.declared != true {
                  Button("使用全部内置模型") { models = [] }
                }
              }
            }

            DisclosureGroup(isExpanded: $advanced) {
              VStack(alignment: .leading, spacing: 12) {
                NativeProviderField(title: "凭据引用") {
                  TextField("凭据引用", text: $credentialRef)
                }
                if provider.declared == true {
                  NativeProviderField(title: "显示名称") {
                    TextField(provider.displayName, text: $displayName)
                  }
                  NativeProviderField(title: "API 协议") {
                    Picker("API 协议", selection: $api) {
                      Text("openai-completions").tag("openai-completions")
                      Text("openai-responses").tag("openai-responses")
                      Text("anthropic-messages").tag("anthropic-messages")
                    }
                    .labelsHidden()
                    .pickerStyle(.menu)
                  }
                }
                NativeProviderField(title: "自定义 API 地址（可选）") {
                  TextField("留空使用内置默认地址，无需填写请求路径", text: $baseURL)
                }
                if endpointInvalid {
                  NativeSettingsNotice(text: "请输入包含主机名的 HTTP 或 HTTPS 地址。", color: .red, icon: "exclamationmark.triangle")
                }
                NativeProviderModelEditor(models: $models)
              }
              .padding(.top, 12)
            } label: {
              Text("高级设置：地址、协议与模型覆盖")
                .font(.system(size: 12, weight: .medium))
            }
            .padding(.top, 4)
            .overlay(alignment: .top) { Divider().overlay(ArkPalette.border) }

            if let connectionStatus {
              Text(connectionStatus).font(.system(size: 11)).textSelection(.enabled)
            }
            HStack {
              Button(connectionTest == nil ? "测试连接" : "取消测试") {
                if let connectionTest {
                  connectionTest.cancel()
                  self.connectionTest = nil
                  connectionStatus = "测试已取消"
                } else if let savedModel = model.availableModelGroups.first(where: { $0.id == provider.id })?.models.first {
                  connectionStatus = "正在验证已保存配置：\(savedModel.name)…"
                  connectionTest = Task {
                    defer { if !Task.isCancelled { connectionTest = nil } }
                    do {
                      let result = try await model.verifyProviderConnection(provider: provider.id, model: savedModel.id)
                      guard !Task.isCancelled else { return }
                      connectionStatus = result.verified
                        ? (result.mode == "minimal-generation"
                          ? "模型调用验证通过：\(savedModel.name)"
                          : "密钥验证通过：\(savedModel.name)；生成与额度以实际请求为准")
                        : "地址可达，但未验证密钥与模型权限"
                    } catch {
                      guard !Task.isCancelled else { return }
                      connectionStatus = "连接未通过：\(error.localizedDescription)"
                    }
                  }
                }
              }
              .disabled(connectionTest == nil && (model.settingsBusy || !secret.isEmpty
                || model.availableModelGroups.first(where: { $0.id == provider.id })?.models.isEmpty != false))
              .help("验证已保存配置的首个模型，可能产生少量 Token 用量。修改后请先保存。")
              Spacer()
              Button("取消") {
                loadDraft()
                secret = ""
                expanded = false
                onCancel?()
              }
              Button("保存") {
                Task {
                  guard let normalizedSecret = normalizedAPIKey(secret) else { return }
                  let saved = await model.saveProviderConfiguration(
                    provider: provider,
                    credentialRef: credentialRef,
                    secret: normalizedSecret,
                    displayName: displayName,
                    baseURL: baseURL,
                    api: api,
                    models: models.compactMap(\.input),
                    migrateLegacyCredentials: migrateLegacyCredentials
                  )
                  if saved {
                    secret = ""
                    expanded = false
                    onCancel?()
                  }
                }
              }
              .buttonStyle(.borderedProminent)
              .disabled(endpointInvalid || !modelsValid || normalizedAPIKey(secret) == nil || model.settingsBusy || state?.writable == false)
              .disabled(provider.migrationRequired != nil
                && (provider.migrationRequired?.canMigrateUserFields != true || !migrateLegacyCredentials || secret.isEmpty))
            }
          }
        }
        .font(.system(size: 11))
        .padding(14)
        .onAppear(perform: loadDraft)
      }
    }
    .background(ArkPalette.shell, in: RoundedRectangle(cornerRadius: 12))
    .overlay(RoundedRectangle(cornerRadius: 12).stroke(ArkPalette.border))
    .onDisappear { connectionTest?.cancel(); connectionTest = nil }
    .onChange(of: model.settingsSnapshot?.namespaces.first(where: { $0.id == provider.settingsNamespace })?.revision) { _ in
      connectionTest?.cancel()
      connectionTest = nil
      connectionStatus = nil
    }
    .confirmationDialog("删除 \(provider.displayName)？", isPresented: $confirmProfileRemoval) {
      Button("删除 Provider 和托管凭据", role: .destructive) { model.removeProviderProfile(provider) }
      Button("取消", role: .cancel) {}
    } message: {
      Text("已运行会话不会改变；之后的新会话将不能再选择此 Provider。")
    }
    .sheet(isPresented: $showDiscoveredModels) {
      NativeDiscoveredModelsSheet(
        model: model,
        models: $models,
        isPresented: $showDiscoveredModels
      )
  }
}

/// Render login controls supplied by provider plugins inside the native card.
/// An empty registry snapshot contributes no layout, preserving the ordinary
/// API-key editor for providers without an interactive login flow.
private struct NativeProviderLoginControls: View {
  let controls: [ArkProviderLoginControl]
  let language: ArkLanguagePreference

  var body: some View {
    if !controls.isEmpty {
      VStack(alignment: .leading, spacing: 8) {
        Divider().overlay(ArkPalette.border)
        ForEach(controls) { control in
          VStack(alignment: .leading, spacing: 6) {
            Text(control.title)
              .font(.system(size: 12, weight: .medium))
            if !control.detail.isEmpty {
              Text(control.detail)
                .font(.system(size: 10))
                .foregroundStyle(ArkPalette.secondary)
            }
            HStack(spacing: 8) {
              ForEach(control.methods) { method in
                Button(method.displayName) {
                  control.begin(method.id)
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .accessibilityLabel("\(control.title)：\(method.displayName)")
              }
              Button(ArkL10n.text(.commonCancel, language)) {
                control.cancel()
              }
              .buttonStyle(.plain)
              .foregroundStyle(ArkPalette.secondary)
              .controlSize(.small)
            }
          }
        }
      }
      .padding(.top, 2)
    }
  }
}

private var statusLabel: String {
    if state?.configured == true {
      return ArkL10n.text(.statusCredentialSaved, model.languagePreference)
    }
    return provider.active
      ? ArkL10n.text(.statusRegistered, model.languagePreference)
      : ArkL10n.text(.statusUnavailable, model.languagePreference)
  }

  private var statusColor: Color {
    if state?.configured == true { return ArkPalette.secondary }
    return provider.active ? .orange : ArkPalette.secondary
  }

  private func loadDraft() {
    migrateLegacyCredentials = false
    credentialRef = model.credentialReference(for: provider)
    displayName = provider.displayName
    guard let namespace = model.settingsSnapshot?.namespaces.first(where: { $0.id == provider.settingsNamespace }),
          let profile = namespace.value.value(at: provider.settingsPath)?.objectValue
    else { return }
    baseURL = profile["baseURL"]?.stringValue ?? ""
    api = profile["api"]?.stringValue ?? "openai-completions"
    models = (profile["models"]?.arrayValue ?? []).compactMap { row in
      guard let id = row["id"]?.stringValue else { return nil }
      return NativeProviderModelDraft(
        modelID: id,
        name: row["name"]?.stringValue ?? "",
        contextWindow: capacityText(row["contextWindow"]),
        maxTokens: capacityText(row["maxTokens"])
      )
    }
  }

  private func capacityText(_ value: JSONValue?) -> String {
    guard let number = value?.numberValue else { return "" }
    return Int(exactly: number).map(String.init) ?? String(number)
  }
}

private struct NativeCustomProviderEditor: View {
  @ObservedObject var model: ArkAppModel
  @Binding var isPresented: Bool
  @State private var providerID = ""
  @State private var displayName = ""
  @State private var baseURL = ""
  @State private var api = "openai-completions"
  @State private var models = [NativeProviderModelDraft()]
  @State private var secret = ""
  @State private var showDiscoveredModels = false

  private var modelInputs: [ArkProviderModelInput] {
    models.compactMap(\.input)
  }

  private var valid: Bool {
    providerID.range(of: #"^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$"#, options: .regularExpression) != nil
      && !model.providers.contains(where: { $0.id == providerID })
      && ArkHTTPURLInput.normalizedHTTPURL(baseURL) != nil
      && !modelInputs.isEmpty
      && modelInputs.count == models.count
      && Set(modelInputs.map(\.id)).count == modelInputs.count
      && normalizedAPIKey(secret) != nil
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack {
        Text("自定义提供方")
          .font(.system(size: 16, weight: .medium))
        Spacer()
        Button { isPresented = false } label: { Image(systemName: "xmark") }
          .buttonStyle(.plain)
          .help("关闭自定义提供方编辑器")
      }

      NativeProviderField(title: "Provider ID", hint: "小写标识，在请求中唯一标识该提供方，并用于派生凭据名。") {
        TextField("acme-gateway", text: $providerID)
      }
      if !providerID.isEmpty,
         providerID.range(of: #"^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$"#, options: .regularExpression) == nil {
        Text("需以小写字母开头，之后可用小写字母、数字和短横线。")
          .font(.system(size: 10))
          .foregroundStyle(Color.red)
      } else if model.providers.contains(where: { $0.id == providerID }) {
        Text("已有提供方使用了这个 ID。")
          .font(.system(size: 10))
          .foregroundStyle(Color.red)
      }
      NativeProviderField(title: "显示名称", hint: "可选；留空时使用 Provider ID。") {
        TextField("显示名称", text: $displayName)
      }
      NativeProviderField(title: "API 地址") {
        TextField("https://gateway.example/v1", text: $baseURL)
      }
      if !baseURL.isEmpty,
         ArkHTTPURLInput.normalizedHTTPURL(baseURL) == nil {
        Text("请输入以 http:// 或 https:// 开头的 API 地址。")
          .font(.system(size: 10))
          .foregroundStyle(Color.red)
      }
      NativeProviderField(title: "API 协议") {
        Picker("API 协议", selection: $api) {
          Text("openai-completions").tag("openai-completions")
          Text("openai-responses").tag("openai-responses")
          Text("anthropic-messages").tag("anthropic-messages")
        }
        .labelsHidden()
        .pickerStyle(.menu)
      }
      NativeProviderModelEditor(models: $models)
      Button("获取可用模型") {
        model.clearDiscoveredModels()
        showDiscoveredModels = true
        model.discoverProviderModels(
          provider: nil,
          baseURL: baseURL,
          api: api,
          unsavedAPIKey: normalizedAPIKey(secret) ?? ""
        )
      }
      .disabled(ArkHTTPURLInput.normalizedHTTPURL(baseURL) == nil || model.modelDiscoveryBusy || normalizedAPIKey(secret) == nil)
      NativeProviderField(title: "API 密钥", hint: "可留空以使用 Provider 自己的环境、OAuth 或 ADC 认证。") {
        SecureField("输入 API 密钥", text: $secret)
      }
      if normalizedAPIKey(secret) == nil {
        Text("API 密钥格式无效，请重新粘贴。")
          .font(.system(size: 10))
          .foregroundStyle(Color.red)
      }

      HStack {
        Spacer()
        Button("取消") { isPresented = false }
        Button("保存") {
          Task {
            guard let normalizedSecret = normalizedAPIKey(secret) else { return }
            let saved = await model.addCustomProvider(
              id: providerID,
              displayName: displayName,
              baseURL: baseURL,
              api: api,
              models: modelInputs,
              credentialRef: model.newCredentialReference(for: providerID),
              secret: normalizedSecret
            )
            if saved { isPresented = false }
          }
        }
        .buttonStyle(.borderedProminent)
        .disabled(!valid || model.settingsBusy)
      }
    }
    .padding(16)
    .background(ArkPalette.raised.opacity(0.72), in: RoundedRectangle(cornerRadius: 12))
    .sheet(isPresented: $showDiscoveredModels) {
      NativeDiscoveredModelsSheet(
        model: model,
        models: $models,
        isPresented: $showDiscoveredModels
      )
    }
  }
}

private struct NativeProviderField<Content: View>: View {
  let title: String
  var hint: String?
  @ViewBuilder let content: () -> Content

  init(title: String, hint: String? = nil, @ViewBuilder content: @escaping () -> Content) {
    self.title = title
    self.hint = hint
    self.content = content
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(title).font(.system(size: 12, weight: .medium))
      content().textFieldStyle(.roundedBorder)
      if let hint {
        Text(hint).font(.system(size: 10)).foregroundStyle(ArkPalette.secondary)
      }
    }
  }
}

private struct NativeProviderModelEditor: View {
  @Binding var models: [NativeProviderModelDraft]

  var body: some View {
    VStack(alignment: .leading, spacing: 9) {
      Text("模型目录").font(.system(size: 12, weight: .medium))
      if models.isEmpty {
        Text("未覆盖模型目录，将继承 Provider 默认模型。")
          .font(.system(size: 10))
          .foregroundStyle(ArkPalette.secondary)
          .frame(maxWidth: .infinity)
          .padding(12)
          .overlay(
            RoundedRectangle(cornerRadius: 8)
              .stroke(ArkPalette.border, style: StrokeStyle(lineWidth: 1, dash: [4, 4]))
          )
      }
      ForEach($models) { $draft in
        VStack(spacing: 7) {
          HStack(spacing: 7) {
            TextField("模型 ID", text: $draft.modelID)
            TextField("显示名称（可选）", text: $draft.name)
            Button(role: .destructive) {
              models.removeAll { $0.id == draft.id }
            } label: {
              Image(systemName: "trash")
            }
            .buttonStyle(.borderless)
            .help("删除模型")
          }
          HStack(spacing: 7) {
            TextField("上下文窗口（可选）", text: $draft.contextWindow)
            TextField("最大输出 Token（可选）", text: $draft.maxTokens)
          }
        }
        .textFieldStyle(.roundedBorder)
        .padding(7)
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(ArkPalette.border))
      }
      Button {
        models.append(NativeProviderModelDraft())
      } label: {
        Label("添加模型", systemImage: "plus")
      }
      .controlSize(.small)
    }
  }
}

private struct NativeDiscoveredModelsSheet: View {
  @ObservedObject var model: ArkAppModel
  @Binding var models: [NativeProviderModelDraft]
  @Binding var isPresented: Bool
  @State private var selected = Set<String>()
  @State private var search = ""

  private var filteredModels: [ArkDiscoveredModel] {
    let query = search.trimmingCharacters(in: .whitespacesAndNewlines)
    return model.discoveredModels.filter {
      query.isEmpty || $0.id.localizedCaseInsensitiveContains(query)
        || ($0.name?.localizedCaseInsensitiveContains(query) ?? false)
    }
  }

  private var current: [String] {
    models.map { $0.modelID.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      Text("选择模型").font(.system(size: 18, weight: .semibold))
      Text("目录来自提供方定义，不代表账号已获访问权限。模型能力按各模型保留；采纳后仍需保存。")
        .font(.system(size: 11))
        .foregroundStyle(ArkPalette.secondary)

      TextField("搜索模型名称或 ID", text: $search)
        .textFieldStyle(.roundedBorder)
        .accessibilityIdentifier("ark.provider.models.search")

      if model.modelDiscoveryBusy {
        HStack { ProgressView(); Text("正在读取模型目录…") }
          .frame(maxWidth: .infinity, maxHeight: .infinity)
      } else if let error = model.modelDiscoveryError {
        NativeSettingsNotice(text: error, color: .red, icon: "exclamationmark.triangle")
        Spacer()
      } else {
        List(filteredModels) { candidate in
          Toggle(isOn: Binding(
            get: { selected.contains(candidate.id) },
            set: { enabled in
              if enabled { selected.insert(candidate.id) }
              else { selected.remove(candidate.id) }
            }
          )) {
            VStack(alignment: .leading, spacing: 3) {
              Text(candidate.name ?? candidate.id).font(.system(size: 12, weight: .medium))
              Text([
                candidate.id,
                candidate.contextWindow.map { "context \($0)" },
                candidate.maxTokens.map { "max \($0)" },
              ].compactMap { $0 }.joined(separator: " · "))
                .font(.system(size: 9, design: .monospaced))
                .foregroundStyle(ArkPalette.secondary)
            }
          }
        }
      }

      HStack {
        Button("选择搜索结果") { selected.formUnion(filteredModels.map(\.id)) }
          .disabled(model.modelDiscoveryBusy)
        Button("清空选择") { selected.removeAll() }
        Spacer()
        Button("取消") { isPresented = false }
        Button("采纳所选") {
          let existing = current
          let appended = model.discoveredModels.filter { selected.contains($0.id) && !existing.contains($0.id) }
          models.append(contentsOf: appended.map { candidate in
            NativeProviderModelDraft(
              modelID: candidate.id,
              name: candidate.name ?? "",
              contextWindow: candidate.contextWindow.map(String.init) ?? "",
              maxTokens: candidate.maxTokens.map(String.init) ?? ""
            )
          })
          isPresented = false
        }
        .buttonStyle(.borderedProminent)
        .disabled(selected.isEmpty || model.modelDiscoveryBusy)
      }
    }
    .padding(22)
    .frame(width: 560, height: 520)
    .background(ArkPalette.panel)
    .onAppear {
      let existing = Set(current)
      selected = Set(model.discoveredModels.map(\.id).filter { !existing.contains($0) })
    }
    .onChange(of: model.discoveredModels) { candidates in
      let existing = Set(current)
      selected = Set(candidates.map(\.id).filter { !existing.contains($0) })
    }
    .onDisappear { model.clearDiscoveredModels() }
  }
}

private struct NativeAgentPresetSettings: View {
  @ObservedObject var model: ArkAppModel
  let onClose: () -> Void
  @State private var copySource: ArkAgentPreset?
  @State private var deleteTarget: ArkAgentPreset?

  var body: some View {
    VStack(spacing: 0) {
      HStack {
        VStack(alignment: .leading, spacing: 3) {
          Text(ArkL10n.text(.presetPageTitle, model.languagePreference))
            .font(.system(size: 18, weight: .semibold))
          Text(ArkL10n.text(.presetPageSubtitle, model.languagePreference))
            .font(.system(size: 13))
            .foregroundStyle(ArkPalette.secondary)
        }
        Spacer()
        if model.agentPresetBusy { ProgressView().controlSize(.small) }
        Button {
          Task { await model.loadAgentPresets() }
        } label: {
          Image(systemName: "arrow.clockwise")
        }
        .buttonStyle(.borderless)
        .help(ArkL10n.text(.presetRefresh, model.languagePreference))
      }
      .padding(22)

      Divider().overlay(ArkPalette.border)

      ScrollView {
        VStack(alignment: .leading, spacing: 12) {
          if let error = model.agentPresetError {
            NativeSettingsNotice(text: error, color: .red, icon: "exclamationmark.triangle")
          }

          if let roster = model.agentPresetRoster {
            presetGroup(isUser: false, presets: roster.presets.filter { $0.trust == "system" })
            presetGroup(isUser: true, presets: roster.presets.filter { $0.trust == "user" })
          } else if model.agentPresetBusy {
            HStack(spacing: 8) {
              ProgressView().controlSize(.small)
              Text(ArkL10n.text(.presetLoading, model.languagePreference))
            }
            .frame(maxWidth: .infinity, alignment: .center)
            .padding(.top, 40)
          } else {
            NativeSettingsEmpty(
              title: ArkL10n.text(.presetEmptyTitle, model.languagePreference),
              icon: "person.3",
              detail: ArkL10n.text(.presetEmptyDetail, model.languagePreference)
            )
            .frame(minHeight: 260)
          }
        }
        .padding(.horizontal, 24)
        .padding(.bottom, 24)
      }
    }
    .sheet(item: $copySource) { source in
      NativeAgentPresetCopySheet(model: model, source: source)
    }
    .sheet(item: Binding<ArkAgentPresetDocument?>(
      get: { model.selectedPresetDocument },
      set: { value in if value == nil { model.closeAgentPresetDocument() } }
    )) { document in
      NativeAgentPresetDocumentSheet(
        document: document,
        language: model.languagePreference
      ) {
        model.closeAgentPresetDocument()
      }
    }
    .confirmationDialog(
      deleteTarget.map {
        ArkL10n.format(
          .presetDeleteConfirm,
          model.languagePreference,
          arguments: [presetDisplayName($0)]
        )
      } ?? ArkL10n.text(.presetDeleteConfirmFallback, model.languagePreference),
      isPresented: Binding(
        get: { deleteTarget != nil },
        set: { if !$0 { deleteTarget = nil } }
      )
    ) {
      Button(ArkL10n.text(.presetDeleteAction, model.languagePreference), role: .destructive) {
        if let id = deleteTarget?.id { model.removeAgentPreset(id) }
        deleteTarget = nil
      }
      Button(ArkL10n.text(.presetCancel, model.languagePreference), role: .cancel) {
        deleteTarget = nil
      }
    }
  }

  @ViewBuilder
  private func presetGroup(isUser: Bool, presets: [ArkAgentPreset]) -> some View {
    if !presets.isEmpty || isUser {
      VStack(alignment: .leading, spacing: 9) {
        HStack {
          Text(ArkL10n.text(
            isUser ? .presetCustomLabel : .presetBuiltInLabel,
            model.languagePreference
          ))
          .font(.system(size: 13, weight: .semibold))
          Spacer()
          Text("\(presets.count)")
            .font(.system(size: 10, design: .monospaced))
            .foregroundStyle(ArkPalette.secondary)
        }
        if presets.isEmpty {
          Text(model.agentPresetRoster?.authorable == true
            ? ArkL10n.text(.presetNoCustom, model.languagePreference)
            : ArkL10n.text(.presetNotAuthorable, model.languagePreference))
            .font(.system(size: 11))
            .foregroundStyle(ArkPalette.secondary)
            .padding(.vertical, 8)
        } else {
          LazyVGrid(columns: [GridItem(.adaptive(minimum: 268), spacing: 12)], spacing: 12) {
            ForEach(presets) { preset in
              NativeAgentPresetCard(
                preset: preset,
                selected: model.defaultAgentPresetID == preset.id,
                authorable: model.agentPresetRoster?.authorable == true,
                hasDocument: model.agentPresetRoster?.hasDocument == true,
                busy: model.agentPresetBusy,
                language: model.languagePreference,
                select: { model.setDefaultAgentPreset(preset.id) },
                view: { model.readAgentPreset(preset.id) },
                copy: { copySource = preset },
                open: { model.openAgentPreset(preset.id) },
                remove: { deleteTarget = preset }
              )
            }
          }
        }
        if isUser,
           model.agentPresetRoster?.presets.contains(where: { $0.id == "cordis" && $0.broken == nil }) == true {
          Button {
            model.startCreatorDraft()
            onClose()
          } label: {
            Label(
              ArkL10n.text(.presetCreatorDraft, model.languagePreference),
              systemImage: "plus"
            )
              .frame(maxWidth: .infinity)
              .frame(height: 44)
          }
          .buttonStyle(.plain)
          .overlay(
            RoundedRectangle(cornerRadius: 12)
              .stroke(ArkPalette.border, style: StrokeStyle(lineWidth: 1, dash: [5, 4]))
          )
          .disabled(model.agentPresetRoster?.authorable != true || model.agentPresetBusy)
        }
      }
    }
  }

  private func presetDisplayName(_ preset: ArkAgentPreset) -> String {
    ArkL10n.presetDisplayTitle(
      id: preset.id,
      name: preset.name,
      model.languagePreference
    )
  }
}

private struct NativePluginSettings: View {
  private enum Tab: String, CaseIterable, Identifiable {
    case configuration = "插件配置"
    case inventory = "插件列表"
    var id: String { rawValue }

    func displayName(_ language: ArkLanguagePreference) -> String {
      switch self {
      case .configuration: return ArkL10n.text(.pluginsConfiguration, language)
      case .inventory: return ArkL10n.text(.pluginsInventory, language)
      }
    }
  }

  @ObservedObject var model: ArkAppModel
  @State private var tab: Tab = .configuration
  @State private var query = ""

  private var filteredEntries: [ArkPluginInventoryEntry] {
    let normalized = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard !normalized.isEmpty else { return model.pluginEntries }
    return model.pluginEntries.filter {
      $0.id.lowercased().contains(normalized) || $0.moduleName.lowercased().contains(normalized)
    }
  }

  var body: some View {
    VStack(spacing: 0) {
      HStack {
        VStack(alignment: .leading, spacing: 3) {
          Text(ArkL10n.text(.extensionsTitle, model.languagePreference))
            .font(.system(size: 18, weight: .semibold))
          Text(ArkL10n.text(.extensionsSubtitle, model.languagePreference))
            .font(.system(size: 13))
            .foregroundStyle(ArkPalette.secondary)
        }
        Spacer()
        if model.pluginInventoryBusy || model.pluginSettingsBusy { ProgressView().controlSize(.small) }
        Button {
          Task {
            async let settings: Void = model.loadPluginSettings()
            async let inventory: Void = model.loadPluginInventory()
            _ = await (settings, inventory)
          }
        } label: {
          Image(systemName: "arrow.clockwise")
        }
        .buttonStyle(.borderless)
        .help(ArkL10n.text(.extensionsRefresh, model.languagePreference))
      }
      .padding(22)

      HStack(spacing: 22) {
        ForEach(Tab.allCases) { item in
          Button {
            tab = item
          } label: {
            Text(item.displayName(model.languagePreference))
              .font(.system(size: 13, weight: tab == item ? .medium : .regular))
              .foregroundStyle(tab == item ? ArkPalette.primary : ArkPalette.secondary)
              .padding(.horizontal, 1)
              .padding(.vertical, 8)
              .overlay(alignment: .bottom) {
                if tab == item {
                  Capsule().fill(ArkPalette.primary).frame(height: 2)
                }
              }
          }
          .buttonStyle(.plain)
        }
        Spacer()
      }
      .padding(.horizontal, 24)
      .overlay(alignment: .bottom) { Divider().overlay(ArkPalette.border) }

      ZStack {
        NativePluginConfigurationSettings(model: model)
          .opacity(tab == .configuration ? 1 : 0)
          .allowsHitTesting(tab == .configuration)
          .accessibilityHidden(tab != .configuration)
        inventory
          .opacity(tab == .inventory ? 1 : 0)
          .allowsHitTesting(tab == .inventory)
          .accessibilityHidden(tab != .inventory)
      }
    }
  }

  private var inventory: some View {
    VStack(spacing: 0) {
      VStack(spacing: 12) {
        HStack(spacing: 8) {
          Image(systemName: "magnifyingglass").foregroundStyle(ArkPalette.secondary)
          TextField(ArkL10n.text(.extensionsSearchPlaceholder, model.languagePreference), text: $query)
            .textFieldStyle(.plain)
          if !query.isEmpty {
            Button {
              query = ""
            } label: {
              Image(systemName: "xmark.circle.fill")
            }
            .buttonStyle(.plain)
            .foregroundStyle(ArkPalette.secondary)
          }
        }
        .padding(.horizontal, 11)
        .frame(height: 34)
        .background(ArkPalette.shell, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(ArkPalette.border))

        HStack(spacing: 14) {
          Text(ArkL10n.format(
            .extensionsEntriesCount,
            model.languagePreference,
            arguments: ["\(model.pluginEntries.count)"]
          ))
          Text(ArkL10n.format(
            .extensionsEnabledCount,
            model.languagePreference,
            arguments: ["\(model.pluginEntries.filter { $0.enabled }.count)"]
          ))
          Text(ArkL10n.format(
            .extensionsActiveCount,
            model.languagePreference,
            arguments: ["\(model.pluginEntries.filter { $0.enabled && $0.phase == "active" }.count)"]
          ))
          Spacer()
        }
        .font(.system(size: 10, design: .monospaced))
        .foregroundStyle(ArkPalette.secondary)

        if let error = model.pluginInventoryError {
          NativeSettingsNotice(text: error, color: .red, icon: "exclamationmark.triangle")
        }
      }
      .padding(.horizontal, 20)
      .padding(.top, 16)

      ScrollView {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 240), spacing: 10)], spacing: 10) {
          if filteredEntries.isEmpty, model.pluginInventoryBusy {
            HStack(spacing: 8) {
              ProgressView().controlSize(.small)
              Text(ArkL10n.text(.extensionsLoading, model.languagePreference))
            }
            .padding(.top, 50)
          } else if filteredEntries.isEmpty {
            NativeSettingsEmpty(
              title: query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? ArkL10n.text(.extensionsEmptyTitle, model.languagePreference)
                : ArkL10n.text(.extensionsNoMatchesTitle, model.languagePreference),
              icon: "puzzlepiece.extension",
              detail: query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? ArkL10n.text(.extensionsEmptyDetail, model.languagePreference)
                : ArkL10n.text(.extensionsNoMatchesDetail, model.languagePreference)
            )
            .frame(minHeight: 250)
          } else {
            ForEach(filteredEntries) { entry in
              NativePluginInventoryCard(entry: entry, language: model.languagePreference)
            }
          }
        }
        .padding(.horizontal, 24)
        .padding(.bottom, 24)
      }
    }
  }
}

private struct NativePluginConfigurationSettings: View {
  @ObservedObject var model: ArkAppModel

  var body: some View {
    ScrollView {
      LazyVStack(spacing: 10) {
        if let error = model.pluginSettingsError {
          NativeSettingsNotice(text: error, color: .red, icon: "exclamationmark.triangle")
        }
        if let settings = model.pluginSettingsSnapshot?.shell {
          NativeShellPluginSettingsCard(model: model, settings: settings)
            .id("shell-\(settings.revision)")
        }
        if let settings = model.pluginSettingsSnapshot?.agentLoop {
          NativeAgentLoopPluginSettingsCard(model: model, settings: settings)
            .id("agent-loop-\(settings.revision)")
        }
        if let settings = model.pluginSettingsSnapshot?.webSearchDeepSeek {
          NativeWebSearchPluginSettingsCard(model: model, settings: settings)
            .id("web-search-\(settings.revision)")
        }
        if model.pluginSettingsSnapshot?.shell == nil,
           model.pluginSettingsSnapshot?.agentLoop == nil,
           model.pluginSettingsSnapshot?.webSearchDeepSeek == nil {
          NativeSettingsEmpty(
            title: ArkL10n.text(.extensionsConfigEmptyTitle, model.languagePreference),
            icon: "puzzlepiece.extension",
            detail: ArkL10n.text(.extensionsConfigEmptyDetail, model.languagePreference)
          )
          .frame(minHeight: 260)
        }
      }
      .padding(.horizontal, 24)
      .padding(.top, 14)
      .padding(.bottom, 24)
    }
  }
}

private struct NativePluginEditorCard<Content: View>: View {
  let title: String
  let detail: String
  let overridden: Bool
  let dirty: Bool
  let language: ArkLanguagePreference
  @ViewBuilder let content: () -> Content
  @State private var expanded = false

  init(
    title: String,
    detail: String,
    overridden: Bool,
    dirty: Bool,
    language: ArkLanguagePreference,
    @ViewBuilder content: @escaping () -> Content
  ) {
    self.title = title
    self.detail = detail
    self.overridden = overridden
    self.dirty = dirty
    self.language = language
    self.content = content
  }

  var body: some View {
    VStack(spacing: 0) {
      Button {
        expanded.toggle()
      } label: {
        HStack(spacing: 12) {
          VStack(alignment: .leading, spacing: 3) {
            Text(title).font(.system(size: 15, weight: .semibold))
            Text(detail).font(.system(size: 12)).foregroundStyle(ArkPalette.secondary)
          }
          Spacer()
          if dirty || overridden {
            Text(ArkL10n.text(
              dirty ? .extensionUnsaved : .extensionOverridden,
              language
            ))
              .font(.system(size: 9, weight: .semibold))
              .foregroundStyle(dirty ? Color.orange : ArkPalette.accent)
          }
          Image(systemName: expanded ? "chevron.up" : "chevron.down")
            .foregroundStyle(ArkPalette.secondary)
        }
        .padding(.horizontal, 16)
        .frame(minHeight: 58)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)

      if expanded {
        Divider().overlay(ArkPalette.border)
        content().padding(14)
      }
    }
    .background(ArkPalette.shell, in: RoundedRectangle(cornerRadius: 12))
    .overlay(RoundedRectangle(cornerRadius: 12).stroke(ArkPalette.border))
  }
}

private struct NativePluginTextField: View {
  let title: String
  @Binding var text: String
  let language: ArkLanguagePreference
  var invalid: Bool = false
  var hint: String? = nil

  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      HStack(spacing: 14) {
        Text(title).font(.system(size: 11, weight: .medium))
        Spacer(minLength: 10)
        TextField(title, text: $text)
          .textFieldStyle(.roundedBorder)
          .font(.system(size: 10, design: .monospaced))
          .frame(maxWidth: 260)
          .overlay(
            RoundedRectangle(cornerRadius: 6)
              .stroke(invalid ? Color.red : Color.clear)
          )
      }
      if invalid || hint != nil {
        Text(invalid ? ArkL10n.text(.extensionPositiveNumber, language) : (hint ?? ""))
          .font(.system(size: 10))
          .foregroundStyle(invalid ? Color.red : ArkPalette.secondary)
          .frame(maxWidth: .infinity, alignment: .trailing)
      }
    }
    .padding(.vertical, 4)
  }
}

private struct NativePluginReadOnlyField: View {
  let title: String
  let value: String

  var body: some View {
    HStack(spacing: 14) {
      Text(title).font(.system(size: 11, weight: .medium))
      Spacer(minLength: 10)
      Text(value)
        .font(.system(size: 10, design: .monospaced))
        .foregroundStyle(ArkPalette.secondary)
        .textSelection(.enabled)
        .frame(maxWidth: 260, alignment: .trailing)
    }
    .padding(.vertical, 4)
  }
}

private struct NativePluginSummaryRow: View {
  let key: String
  let value: String

  var body: some View {
    HStack(spacing: 16) {
      Text(key)
        .font(.system(size: 11, weight: .medium))
      Spacer(minLength: 10)
      Text(value)
        .font(.system(size: 10, design: .monospaced))
        .foregroundStyle(ArkPalette.secondary)
        .textSelection(.enabled)
    }
    .padding(.vertical, 5)
  }
}

@ViewBuilder
private func pluginSummaryFooter(
  applies: ArkPluginSettingsApplyMode,
  busy: Bool,
  language: ArkLanguagePreference,
  edit: @escaping () -> Void
) -> some View {
  HStack {
    Text(ArkL10n.text(
      applies == .live ? .extensionAppliesLive : .extensionAppliesRestart,
      language
    ))
      .font(.system(size: 10))
      .foregroundStyle(ArkPalette.secondary)
    Spacer()
    Button(ArkL10n.text(.extensionEditConfiguration, language), action: edit)
      .disabled(busy)
  }
  .padding(.top, 6)
}

private struct NativeShellPluginSettingsCard: View {
  @ObservedObject var model: ArkAppModel
  let settings: ArkShellPluginSettings
  @State private var timeoutMs: String
  @State private var maxTimeoutMs: String
  @State private var maxOutputBytes: String
  @State private var maxSpillBytes: String
  @State private var graceMs: String
  @State private var editing = false

  init(model: ArkAppModel, settings: ArkShellPluginSettings) {
    self.model = model
    self.settings = settings
    _timeoutMs = State(initialValue: pluginNumber(settings.timeoutMs))
    _maxTimeoutMs = State(initialValue: pluginNumber(settings.maxTimeoutMs))
    _maxOutputBytes = State(initialValue: pluginNumber(settings.maxOutputBytes))
    _maxSpillBytes = State(initialValue: pluginNumber(settings.maxSpillBytes))
    _graceMs = State(initialValue: pluginNumber(settings.graceMs))
  }

  private var values: [Double]? {
    [timeoutMs, maxTimeoutMs, maxOutputBytes, maxSpillBytes, graceMs]
      .reduce(into: [Double]?([])) { result, text in
        guard let value = Double(text), value.isFinite, value > 0 else { result = nil; return }
        result?.append(value)
      }
  }

  private var dirty: Bool {
    timeoutMs != pluginNumber(settings.timeoutMs)
      || maxTimeoutMs != pluginNumber(settings.maxTimeoutMs)
      || maxOutputBytes != pluginNumber(settings.maxOutputBytes)
      || maxSpillBytes != pluginNumber(settings.maxSpillBytes)
      || graceMs != pluginNumber(settings.graceMs)
  }

  var body: some View {
    NativePluginEditorCard(
      title: ArkL10n.text(.pluginTerminalTitle, model.languagePreference),
      detail: ArkL10n.text(.pluginTerminalDetail, model.languagePreference),
      overridden: !settings.overriddenFields.isEmpty,
      dirty: dirty,
      language: model.languagePreference
    ) {
      if editing {
        VStack(spacing: 7) {
          NativePluginTextField(title: "graceMs", text: $graceMs, language: model.languagePreference, invalid: !pluginPositive(graceMs))
          NativePluginTextField(title: "maxOutputBytes", text: $maxOutputBytes, language: model.languagePreference, invalid: !pluginPositive(maxOutputBytes))
          NativePluginTextField(title: "maxSpillBytes", text: $maxSpillBytes, language: model.languagePreference, invalid: !pluginPositive(maxSpillBytes))
          NativePluginTextField(title: "maxTimeoutMs", text: $maxTimeoutMs, language: model.languagePreference, invalid: !pluginPositive(maxTimeoutMs))
          NativePluginTextField(title: "timeoutMs", text: $timeoutMs, language: model.languagePreference, invalid: !pluginPositive(timeoutMs))
          pluginFooter(
            busy: model.pluginSettingsBusy,
            overridden: !settings.overriddenFields.isEmpty,
            dirty: dirty,
            valid: values != nil,
            language: model.languagePreference,
            restore: {
              Task { _ = await model.saveShellPluginSettings([
                .unsetTimeoutMs, .unsetMaxTimeoutMs, .unsetMaxOutputBytes, .unsetMaxSpillBytes, .unsetGraceMs,
              ]) }
            },
            discard: {
              reset()
              editing = false
            },
            save: save
          )
        }
      } else {
        VStack(spacing: 2) {
          NativePluginSummaryRow(key: "graceMs", value: pluginNumber(settings.graceMs))
          NativePluginSummaryRow(key: "maxOutputBytes", value: pluginNumber(settings.maxOutputBytes))
          NativePluginSummaryRow(key: "maxSpillBytes", value: pluginNumber(settings.maxSpillBytes))
          NativePluginSummaryRow(key: "maxTimeoutMs", value: pluginNumber(settings.maxTimeoutMs))
          NativePluginSummaryRow(key: "timeoutMs", value: pluginNumber(settings.timeoutMs))
          pluginSummaryFooter(
            applies: settings.applies,
            busy: model.pluginSettingsBusy,
            language: model.languagePreference
          ) {
            editing = true
          }
        }
      }
    }
  }

  private func reset() {
    timeoutMs = pluginNumber(settings.timeoutMs)
    maxTimeoutMs = pluginNumber(settings.maxTimeoutMs)
    maxOutputBytes = pluginNumber(settings.maxOutputBytes)
    maxSpillBytes = pluginNumber(settings.maxSpillBytes)
    graceMs = pluginNumber(settings.graceMs)
  }

  private func save() {
    guard let values else { return }
    Task {
      if await model.saveShellPluginSettings([
        .setTimeoutMs(values[0]), .setMaxTimeoutMs(values[1]), .setMaxOutputBytes(values[2]),
        .setMaxSpillBytes(values[3]), .setGraceMs(values[4]),
      ]) {
        editing = false
      }
    }
  }
}

private struct NativeAgentLoopPluginSettingsCard: View {
  @ObservedObject var model: ArkAppModel
  let settings: ArkAgentLoopPluginSettings
  @State private var parallel: String
  @State private var editing = false

  init(model: ArkAppModel, settings: ArkAgentLoopPluginSettings) {
    self.model = model
    self.settings = settings
    _parallel = State(initialValue: String(settings.maxParallelToolCalls))
  }

  private var value: Int? {
    Int(parallel).flatMap { $0 > 0 ? $0 : nil }
  }

  private var dirty: Bool { parallel != String(settings.maxParallelToolCalls) }

  var body: some View {
    NativePluginEditorCard(
      title: ArkL10n.text(.pluginAgentLoopTitle, model.languagePreference),
      detail: ArkL10n.text(.pluginAgentLoopDetail, model.languagePreference),
      overridden: !settings.overriddenFields.isEmpty,
      dirty: dirty,
      language: model.languagePreference
    ) {
      if editing {
        VStack(spacing: 7) {
          NativePluginTextField(title: "maxParallelToolCalls", text: $parallel, language: model.languagePreference, invalid: value == nil)
          pluginFooter(
            busy: model.pluginSettingsBusy,
            overridden: !settings.overriddenFields.isEmpty,
            dirty: dirty,
            valid: value != nil,
            language: model.languagePreference,
            restore: { Task { _ = await model.saveAgentLoopPluginSettings([.unsetMaxParallelToolCalls]) } },
            discard: {
              parallel = String(settings.maxParallelToolCalls)
              editing = false
            },
            save: {
              guard let value else { return }
              Task {
                if await model.saveAgentLoopPluginSettings([.setMaxParallelToolCalls(value)]) {
                  editing = false
                }
              }
            }
          )
        }
      } else {
        VStack(spacing: 2) {
          NativePluginSummaryRow(key: "maxParallelToolCalls", value: String(settings.maxParallelToolCalls))
          pluginSummaryFooter(
            applies: settings.applies,
            busy: model.pluginSettingsBusy,
            language: model.languagePreference
          ) {
            editing = true
          }
        }
      }
    }
  }
}

private struct NativeWebSearchPluginSettingsCard: View {
  @ObservedObject var model: ArkAppModel
  let settings: ArkWebSearchDeepSeekPluginSettings
  @State private var apiKey = ""
  @State private var baseURL: String
  @State private var maxUses: String
  @State private var editing = false

  init(model: ArkAppModel, settings: ArkWebSearchDeepSeekPluginSettings) {
    self.model = model
    self.settings = settings
    _baseURL = State(initialValue: settings.baseURL ?? "")
    _maxUses = State(initialValue: String(settings.maxUses))
  }

  private var uses: Int? {
    Int(maxUses).flatMap { $0 > 0 ? $0 : nil }
  }

  private var valid: Bool {
    uses != nil && normalizedAPIKey(apiKey) != nil
  }

  private var configured: Bool {
    model.credentialStates[settings.credentialReference]?.configured == true
  }

  private var managedOverrides: Set<String> {
    settings.overriddenFields.intersection(["baseURL", "maxUses"])
  }

  private var dirty: Bool {
    !apiKey.isEmpty || baseURL != (settings.baseURL ?? "") || maxUses != String(settings.maxUses)
  }

  var body: some View {
    NativePluginEditorCard(
      title: ArkL10n.text(.pluginWebSearchTitle, model.languagePreference),
      detail: ArkL10n.text(.pluginWebSearchDetail, model.languagePreference),
      overridden: !managedOverrides.isEmpty,
      dirty: dirty,
      language: model.languagePreference
    ) {
      if editing {
        VStack(spacing: 7) {
          NativePluginReadOnlyField(title: "apiKeyEnv", value: settings.credentialReference)
          HStack(spacing: 14) {
            VStack(alignment: .leading, spacing: 2) {
              Text(ArkL10n.text(.extensionAPIKey, model.languagePreference))
                .font(.system(size: 11, weight: .medium))
              Text(ArkL10n.text(
                configured ? .statusConfigured : .statusUnconfigured,
                model.languagePreference
              ))
                .font(.system(size: 9))
                .foregroundStyle(configured ? Color.green : ArkPalette.secondary)
            }
            Spacer(minLength: 10)
            SecureField(
              ArkL10n.text(
                configured ? .extensionKeepSecret : .extensionEnterSecret,
                model.languagePreference
              ),
              text: $apiKey
            )
              .textFieldStyle(.roundedBorder)
              .frame(maxWidth: 260)
              .disabled(model.credentialStates[settings.credentialReference]?.writable == false)
          }
          .padding(.vertical, 4)
          if normalizedAPIKey(apiKey) == nil {
            Text(ArkL10n.text(.extensionInvalidAPIKey, model.languagePreference))
              .font(.system(size: 10))
              .foregroundStyle(Color.red)
              .frame(maxWidth: .infinity, alignment: .trailing)
          }
          NativePluginTextField(
            title: "baseURL",
            text: $baseURL,
            language: model.languagePreference,
            hint: ArkL10n.text(.extensionDefaultBaseURL, model.languagePreference)
          )
          NativePluginReadOnlyField(title: "model", value: settings.model)
          NativePluginReadOnlyField(title: "apiVersion", value: settings.apiVersion)
          NativePluginReadOnlyField(title: "maxTokens", value: String(settings.maxTokens))
          NativePluginTextField(title: "maxUses", text: $maxUses, language: model.languagePreference, invalid: uses == nil)
          pluginFooter(
            busy: model.pluginSettingsBusy,
            overridden: !managedOverrides.isEmpty,
            dirty: dirty,
            valid: valid,
            language: model.languagePreference,
            restore: {
              Task { _ = await model.saveWebSearchPluginSettings([
                .unsetBaseURL, .unsetMaxUses,
              ]) }
            },
            discard: {
              reset()
              editing = false
            },
            save: save
          )
        }
      } else {
        VStack(spacing: 2) {
          NativePluginSummaryRow(key: "apiKeyEnv", value: settings.credentialReference)
          if let baseURL = settings.baseURL, !baseURL.isEmpty {
            NativePluginSummaryRow(key: "baseURL", value: baseURL)
          }
          NativePluginSummaryRow(key: "model", value: settings.model)
          NativePluginSummaryRow(key: "apiVersion", value: settings.apiVersion)
          NativePluginSummaryRow(key: "maxTokens", value: String(settings.maxTokens))
          NativePluginSummaryRow(key: "maxUses", value: String(settings.maxUses))
          pluginSummaryFooter(
            applies: settings.applies,
            busy: model.pluginSettingsBusy,
            language: model.languagePreference
          ) {
            editing = true
          }
        }
      }
    }
  }

  private func reset() {
    baseURL = settings.baseURL ?? ""
    maxUses = String(settings.maxUses)
    apiKey = ""
  }

  private func save() {
    guard let uses, let normalizedSecret = normalizedAPIKey(apiKey) else { return }
    var edits: [ArkWebSearchDeepSeekPluginSettingsEdit] = [.setMaxUses(uses)]
    edits.append(baseURL.isEmpty ? .unsetBaseURL : .setBaseURL(baseURL))
    Task {
      guard await model.saveWebSearchPluginSettings(edits) else { return }
      if await model.saveCredential(ref: settings.credentialReference, secret: normalizedSecret) {
        apiKey = ""
        editing = false
      }
    }
  }
}

@ViewBuilder
private func pluginFooter(
  busy: Bool,
  overridden: Bool,
  dirty: Bool,
  valid: Bool,
  language: ArkLanguagePreference,
  restore: @escaping () -> Void,
  discard: @escaping () -> Void,
  save: @escaping () -> Void
) -> some View {
  HStack {
    Text(ArkL10n.text(
      overridden ? .extensionDefaultsOverridden : .extensionDefaultsUsed,
      language
    ))
      .font(.system(size: 10))
      .foregroundStyle(ArkPalette.secondary)
    Spacer()
    Button(ArkL10n.text(.extensionRestoreDefault, language), action: restore)
      .disabled(busy || !overridden)
    Button(ArkL10n.text(.extensionDiscardChanges, language), action: discard)
      .disabled(busy || !dirty)
    Button(ArkL10n.text(.commonSave, language), action: save)
      .buttonStyle(.borderedProminent)
      .disabled(busy || !dirty || !valid)
  }
  .padding(.top, 5)
}

private func pluginNumber(_ value: Double) -> String {
  value.rounded(.towardZero) == value ? String(Int(value)) : String(value)
}

private func pluginPositive(_ text: String) -> Bool {
  guard let value = Double(text) else { return false }
  return value.isFinite && value > 0
}

private struct NativeAgentPresetCard: View {
  let preset: ArkAgentPreset
  let selected: Bool
  let authorable: Bool
  let hasDocument: Bool
  let busy: Bool
  let language: ArkLanguagePreference
  let select: () -> Void
  let view: () -> Void
  let copy: () -> Void
  let open: () -> Void
  let remove: () -> Void

  private var displayName: String {
    ArkL10n.presetDisplayTitle(id: preset.id, name: preset.name, language)
  }

  private var descriptionText: String {
    let localized = ArkL10n.presetDisplayDescription(
      id: preset.id,
      description: preset.description,
      language
    )
    return localized.isEmpty ? ArkL10n.text(.presetNoDescription, language) : localized
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Button(action: select) {
        VStack(alignment: .leading, spacing: 8) {
          HStack(spacing: 8) {
            Text(displayName).font(.system(size: 15, weight: .semibold))
            if preset.broken != nil {
              Text(ArkL10n.text(.presetLoadFailed, language))
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(Color.white)
                .padding(.horizontal, 8)
                .padding(.vertical, 2)
                .background(Color.red, in: Capsule())
            }
            Text(ArkL10n.text(
              preset.trust == "user" ? .presetCustomLabel : .presetBuiltInLabel,
              language
            ))
              .font(.system(size: 10, weight: .medium))
              .foregroundStyle(ArkPalette.secondary)
              .padding(.horizontal, 8)
              .padding(.vertical, 2)
              .overlay(Capsule().stroke(ArkPalette.border))
            Spacer(minLength: 8)
            if selected {
              Text(ArkL10n.text(.presetCurrentLabel, language))
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(ArkPalette.panel)
                .padding(.horizontal, 8)
                .padding(.vertical, 2)
                .background(ArkPalette.primary, in: Capsule())
            }
          }
          Text(descriptionText)
            .font(.system(size: 12))
            .foregroundStyle(ArkPalette.secondary)
            .lineLimit(4)
            .frame(minHeight: 42, alignment: .top)
          if let broken = preset.broken {
            Text(broken)
              .font(.system(size: 11))
              .foregroundStyle(Color.red)
              .fixedSize(horizontal: false, vertical: true)
          }
          Text(preset.id)
            .font(.system(size: 10, design: .monospaced))
            .foregroundStyle(ArkPalette.secondary.opacity(0.8))
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .disabled(selected || busy || preset.broken != nil)
      .help(preset.broken ?? ArkL10n.text(
        selected ? .presetCurrentDefault : .presetSetDefault,
        language
      ))
      .accessibilityLabel("\(ArkL10n.text(selected ? .presetCurrentLabel : .presetSetDefault, language))：\(displayName)")

      Divider().overlay(ArkPalette.border)
      HStack(spacing: 10) {
        Spacer()
        if preset.trust == "system" {
          Button(action: view) { Image(systemName: "doc.text.magnifyingglass") }
            .disabled(busy || preset.broken != nil)
            .help(ArkL10n.text(.presetViewReadOnly, language))
            .accessibilityLabel(ArkL10n.text(.presetViewContent, language))
        } else {
          Button(action: open) { Image(systemName: hasDocument ? "folder" : "folder.badge.questionmark") }
            .disabled(busy)
            .help(ArkL10n.text(hasDocument ? .presetOpenFolder : .presetShowFolder, language))
            .accessibilityLabel(ArkL10n.text(hasDocument ? .presetOpenFolder : .presetShowFolder, language))
        }
        Button(action: copy) { Image(systemName: "doc.on.doc") }
          .disabled(busy || !authorable || preset.broken != nil)
          .help(ArkL10n.text(.presetCopy, language))
          .accessibilityLabel(ArkL10n.text(.presetCopy, language))
        if preset.trust == "user" {
          Button(role: .destructive, action: remove) { Image(systemName: "trash") }
            .disabled(busy)
            .help(ArkL10n.text(.presetDeleteUser, language))
            .accessibilityLabel(ArkL10n.text(.presetDeleteUser, language))
        }
      }
      .font(.system(size: 11))
      .buttonStyle(.borderless)
      .padding(.horizontal, 10)
      .frame(height: 40)
    }
    .background(selected ? ArkPalette.raised : ArkPalette.shell, in: RoundedRectangle(cornerRadius: 12))
    .overlay(
      RoundedRectangle(cornerRadius: 12)
        .stroke(preset.broken != nil ? Color.red : (selected ? ArkPalette.primary : ArkPalette.border))
    )
  }
}

private struct NativeAgentPresetCopySheet: View {
  @Environment(\.dismiss) private var dismiss
  @ObservedObject var model: ArkAppModel
  let source: ArkAgentPreset
  @State private var targetID: String
  @State private var displayName: String

  init(model: ArkAppModel, source: ArkAgentPreset) {
    self.model = model
    self.source = source
    _targetID = State(initialValue: "\(source.id)-copy")
    _displayName = State(initialValue: "")
  }

  private var targetIsValid: Bool {
    targetID.range(
      of: #"^[a-z0-9][a-z0-9-]*$"#,
      options: .regularExpression
    ) != nil
      && model.agentPresetRoster?.presets.contains(where: { $0.id == targetID }) != true
  }

  private var sourceDisplayName: String {
    ArkL10n.presetDisplayTitle(
      id: source.id,
      name: source.name,
      model.languagePreference
    )
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      Text(ArkL10n.text(.presetCopyTitle, model.languagePreference))
        .font(.system(size: 20, weight: .semibold))
      Text(ArkL10n.format(
        .presetCopyDetail,
        model.languagePreference,
        arguments: [sourceDisplayName]
      ))
        .font(.system(size: 12))
        .foregroundStyle(ArkPalette.secondary)
      Form {
        TextField(ArkL10n.text(.presetCopyIdentifier, model.languagePreference), text: $targetID)
        TextField(ArkL10n.text(.presetCopyDisplayName, model.languagePreference), text: $displayName)
      }
      .formStyle(.grouped)
      if !targetID.isEmpty, !targetIsValid {
        Text(ArkL10n.text(.presetCopyIdentifierRule, model.languagePreference))
          .font(.system(size: 10))
          .foregroundStyle(Color.red)
      }
      HStack {
        Spacer()
        Button(ArkL10n.text(.presetCancel, model.languagePreference)) { dismiss() }
        Button(ArkL10n.text(.presetCopyAction, model.languagePreference)) {
          model.copyAgentPreset(from: source.id, to: targetID, name: displayName)
          dismiss()
        }
        .buttonStyle(.borderedProminent)
        .disabled(!targetIsValid || model.agentPresetBusy)
      }
    }
    .padding(24)
    .frame(width: 500, height: 310)
    .background(ArkPalette.panel)
  }
}

private struct NativeAgentPresetDocumentSheet: View {
  let document: ArkAgentPresetDocument
  let language: ArkLanguagePreference
  let close: () -> Void

  private var displayName: String {
    ArkL10n.presetDisplayTitle(id: document.id, name: document.name, language)
  }

  private var displayDescription: String {
    ArkL10n.presetDisplayDescription(
      id: document.id,
      description: document.description,
      language
    )
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack {
        VStack(alignment: .leading, spacing: 3) {
          Text(displayName)
            .font(.system(size: 20, weight: .semibold))
          Text("\(document.id) · \(ArkL10n.text(document.trust == "user" ? .presetCustomLabel : .presetBuiltInLabel, language)) · \(ArkL10n.text(.presetReadOnlyLabel, language))")
            .font(.system(size: 10, design: .monospaced))
            .foregroundStyle(ArkPalette.secondary)
        }
        Spacer()
        Button(ArkL10n.text(.presetClose, language), action: close)
      }
      if !displayDescription.isEmpty {
        Text(displayDescription)
          .font(.system(size: 11))
          .foregroundStyle(ArkPalette.secondary)
      }
      Divider().overlay(ArkPalette.border)
      ScrollView {
        Text(document.content)
          .font(.system(size: 11, design: .monospaced))
          .textSelection(.enabled)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(12)
      }
      .background(ArkPalette.shell, in: RoundedRectangle(cornerRadius: 8))
      .overlay(RoundedRectangle(cornerRadius: 8).stroke(ArkPalette.border))
    }
    .padding(22)
    .frame(width: 720, height: 560)
    .background(ArkPalette.panel)
  }
}

private struct NativePluginInventoryCard: View {
  let entry: ArkPluginInventoryEntry
  let language: ArkLanguagePreference
  @State private var expanded = false

  private var shortName: String {
    let unscoped = entry.moduleName.hasPrefix("@")
      ? String(entry.moduleName.dropFirst().split(separator: "/", maxSplits: 1).last ?? Substring(entry.moduleName))
      : entry.moduleName
    return unscoped
      .replacingOccurrences(of: "cordis-plugin-", with: "")
      .replacingOccurrences(of: "dsh-host-", with: "")
      .replacingOccurrences(of: "dsh-client-", with: "")
      .replacingOccurrences(of: "dsh-", with: "")
  }

  private var phaseLabel: String {
    guard entry.enabled else { return ArkL10n.text(.extensionPhaseDisabled, language) }
    switch entry.phase {
    case "pending": return ArkL10n.text(.extensionPhasePending, language)
    case "loading": return ArkL10n.text(.extensionPhaseLoading, language)
    case "active": return ArkL10n.text(.extensionPhaseActive, language)
    case "failed": return ArkL10n.text(.extensionPhaseFailed, language)
    case "unloading": return ArkL10n.text(.extensionPhaseUnloading, language)
    default: return ArkL10n.text(.extensionPhaseUnknown, language)
    }
  }

  private var phaseColor: Color {
    guard entry.enabled else { return ArkPalette.secondary }
    switch entry.phase {
    case "active": return .green
    case "failed": return .red
    case "loading", "pending", "unloading": return .orange
    default: return ArkPalette.secondary
    }
  }

  var body: some View {
    VStack(spacing: 0) {
      Button {
        expanded.toggle()
      } label: {
        HStack(spacing: 11) {
          Circle()
            .fill(phaseColor)
            .frame(width: 8, height: 8)
          Text(shortName)
            .font(.system(size: 13, weight: .semibold))
            .lineLimit(1)
          Spacer(minLength: 8)
          Text(ArkL10n.text(entry.enabled ? .extensionEnabled : .extensionDisabled, language))
            .font(.system(size: 9, weight: .semibold))
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .background(ArkPalette.raised, in: RoundedRectangle(cornerRadius: 5))
          Image(systemName: expanded ? "chevron.up" : "chevron.down")
            .font(.system(size: 9, weight: .semibold))
            .foregroundStyle(ArkPalette.secondary)
        }
        .padding(.horizontal, 13)
        .frame(minHeight: 52)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("\(shortName)，\(phaseLabel)，\(ArkL10n.text(expanded ? .extensionCollapseDetails : .extensionExpandDetails, language))")

      if expanded {
        Divider().overlay(ArkPalette.border)
        VStack(alignment: .leading, spacing: 8) {
          Text(entry.moduleName)
            .font(.system(size: 10, design: .monospaced))
            .textSelection(.enabled)
          LabeledContent(ArkL10n.text(.extensionEntryID, language)) {
            Text(entry.id)
              .font(.system(size: 9, design: .monospaced))
              .textSelection(.enabled)
          }
          LabeledContent(ArkL10n.text(.extensionConfigurationLabel, language)) {
            Text(ArkL10n.text(entry.enabled ? .extensionEnabled : .extensionDisabled, language))
          }
          if entry.enabled {
            LabeledContent(ArkL10n.text(.extensionCoreCapability, language)) {
              Text(phaseLabel).foregroundStyle(phaseColor)
            }
          }
        }
        .font(.system(size: 10))
        .foregroundStyle(ArkPalette.secondary)
        .padding(13)
        .background(ArkPalette.raised.opacity(0.45))
      }
    }
    .background(ArkPalette.shell, in: RoundedRectangle(cornerRadius: 9))
    .overlay(RoundedRectangle(cornerRadius: 9).stroke(ArkPalette.border))
  }
}

private struct NativeSettingsNotice: View {
  let text: String
  let color: Color
  let icon: String

  var body: some View {
    Label(text, systemImage: icon)
      .font(.system(size: 10))
      .foregroundStyle(color)
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(9)
      .background(color.opacity(0.10), in: RoundedRectangle(cornerRadius: 7))
  }
}

private struct NativeSettingsEmpty: View {
  let title: String
  let icon: String
  let detail: String

  var body: some View {
    VStack(spacing: 10) {
      Image(systemName: icon).font(.system(size: 30)).foregroundStyle(ArkPalette.secondary)
      Text(title).font(.system(size: 16, weight: .semibold))
      Text(detail).font(.system(size: 12)).foregroundStyle(ArkPalette.secondary).multilineTextAlignment(.center)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .padding(30)
  }
}
