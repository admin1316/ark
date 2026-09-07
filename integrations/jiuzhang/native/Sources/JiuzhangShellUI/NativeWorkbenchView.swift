import AppKit
import Combine
import CryptoKit
import Darwin
import JiuzhangShellCore
import SwiftUI

@_silgen_name("flock")
private func arkWorkbenchFlock(_ descriptor: Int32, _ operation: Int32) -> Int32

private enum NativeWorkbenchPalette {
  static let background = Color(nsColor: .windowBackgroundColor)
  static let panel = Color(nsColor: .controlBackgroundColor)
  static let raised = Color.primary.opacity(0.06)
  static let selected = Color.accentColor.opacity(0.16)
  static let border = Color(nsColor: .separatorColor).opacity(0.72)
  static let primary = Color.primary
  static let secondary = Color.secondary
  static let accent = Color.accentColor
}

/// A native macOS workbench for files, Git inspection, and a persistent shell.
///
/// File reads and writes are confined to the supplied root. Symbolic links are not
/// displayed or followed, and saves replace the destination atomically inside its
/// already-open parent directory.
public struct NativeWorkbenchView: View {
  @ObservedObject private var appModel: ArkAppModel
  @StateObject private var model: NativeWorkbenchModel
  @State private var draftFlushRegistrationID: UUID?
  private var closeAction: () -> Void = {}
  private var dirtyStateAction: (Bool) -> Void = { _ in }
  private let draftFlushCoordinator: NativeWorkbenchDraftFlushCoordinator
  private let language: ArkLanguagePreference
  private let requestedTool: NativeWorkbenchTabKind?
  private let requestedToolRevision: Int
  private let browserCancellationRevision: Int

  /// Creates a workbench rooted at a local directory.
  ///
  /// - Parameter rootURL: The only directory exposed by the file browser and editor.
  /// - Parameter language: Interface language; every production call site passes
  ///   `language` explicitly (previews/tests pass .zh/.en).
  public init(
    appModel: ArkAppModel,
    rootURL: URL,
    language: ArkLanguagePreference,
    draftFlushCoordinator: NativeWorkbenchDraftFlushCoordinator,
    initialTool: NativeWorkbenchTabKind = .files,
    requestedTool: NativeWorkbenchTabKind? = nil,
    requestedToolRevision: Int = 0,
    browserCancellationRevision: Int = 0
  ) {
    self.appModel = appModel
    self.language = language
    self.draftFlushCoordinator = draftFlushCoordinator
    self.requestedTool = requestedTool
    self.requestedToolRevision = requestedToolRevision
    self.browserCancellationRevision = browserCancellationRevision
    _model = StateObject(wrappedValue: NativeWorkbenchModel(
      rootURL: rootURL,
      initialTool: initialTool,
      webReader: { url in
        try await appModel.workbenchWebRead(url: url)
      }
    ))
  }

  public func onClose(_ action: @escaping () -> Void) -> Self {
    var copy = self
    copy.closeAction = action
    return copy
  }

  public func onDirtyStateChange(_ action: @escaping (Bool) -> Void) -> Self {
    var copy = self
    copy.dirtyStateAction = action
    return copy
  }

  public var body: some View {
    VStack(spacing: 0) {
      NativeWorkbenchTabBar(
        model: model,
        language: language
      )
      .zIndex(20)
      Divider().overlay(NativeWorkbenchPalette.border).zIndex(20)
      if let activeTab = model.toolTabs.activeTab {
        switch activeTab.kind {
        case .review:
          NativeGitInspector(model: model, language: language)
        case .terminal:
          NativePTYTerminalView(
            session: model.terminalSession(for: activeTab.id),
            language: language
          )
        case .browser:
          NativeWorkbenchBrowserView(
            session: model.browserSession(for: activeTab.id),
            language: language
          )
        case .files:
          NativeFilesWorkspace(model: model, language: language)
            .clipped()
        }
      } else {
        VStack(spacing: 10) {
          Image(systemName: "plus.square.dashed")
            .font(.system(size: 26))
          Text(ArkL10n.text(.workbenchNoTabs, language))
            .font(.system(size: 12))
        }
        .foregroundStyle(NativeWorkbenchPalette.secondary)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
      }
    }
    .background(NativeWorkbenchPalette.background)
    .foregroundStyle(NativeWorkbenchPalette.primary)
    .onAppear {
      model.loadIfNeeded()
      dirtyStateAction(model.fileTabs.hasDirtyTabs)
      if draftFlushRegistrationID == nil {
        draftFlushRegistrationID = draftFlushCoordinator.register { [weak model] in
          guard let model else { return .unavailable }
          if let error = await model.flushRecoveryDrafts() { return .failed(error) }
          await model.shutdownTerminalSessions()
          return .flushed
        }
      }
    }
    .onDisappear {
      if let draftFlushRegistrationID {
        draftFlushCoordinator.unregister(draftFlushRegistrationID)
        self.draftFlushRegistrationID = nil
      }
      model.disposeBrowserSessions()
      model.cancelFileOperations()
      model.cancelGitOperations()
      Task { await model.shutdownTerminalSessions() }
    }
    .onChange(of: model.fileTabs.hasDirtyTabs) { hasDirtyTabs in
      dirtyStateAction(hasDirtyTabs)
    }
    .onChange(of: requestedToolRevision) { _ in
      if let requestedTool { model.openTool(requestedTool) }
    }
    .onChange(of: browserCancellationRevision) { _ in
      model.cancelBrowserRequests()
    }
    .onReceive(appModel.$workbenchFileOpenRequest.compactMap { $0 }) { request in
      guard request.rootPath == model.rootURL.standardizedFileURL.path else { return }
      Task {
        await model.selectFile(URL(fileURLWithPath: request.filePath))
        appModel.completeWorkbenchFileOpenRequest(request.id)
      }
    }
    .alert(
      ArkL10n.text(.filesCloseDirtyTitle, language),
      isPresented: Binding(
        get: { model.fileTabs.pendingCloseTabID != nil },
        set: { if !$0 { model.cancelCloseTab() } }
      )
    ) {
      Button(ArkL10n.text(.filesCancel, language), role: .cancel, action: model.cancelCloseTab)
      Button(ArkL10n.text(.filesDiscard, language), role: .destructive, action: model.discardCloseTab)
    } message: {
      Text(ArkL10n.text(.filesCloseDirtyMessage, language))
    }
    .alert(
      ArkL10n.text(.filesCloseDirtyTitle, language),
      isPresented: Binding(
        get: { model.fileTabs.pendingWorkbenchClose },
        set: { if !$0 { model.cancelWorkbenchClose() } }
      )
    ) {
      Button(ArkL10n.text(.filesCancel, language), role: .cancel, action: model.cancelWorkbenchClose)
      Button(ArkL10n.text(.filesDiscardAll, language), role: .destructive) {
        if model.confirmDiscardDirtyClosure() { closeAction() }
      }
    } message: {
      Text(ArkL10n.text(.filesCloseDirtyWorkbenchMessage, language))
    }
    .alert(
      ArkL10n.text(.gitDiscardTitle, language),
      isPresented: Binding(
        get: { model.pendingGitDiscard != nil },
        set: { if !$0 { model.cancelGitDiscard() } }
      )
    ) {
      Button(ArkL10n.text(.filesCancel, language), role: .cancel, action: model.cancelGitDiscard)
      Button(ArkL10n.text(.gitDiscard, language), role: .destructive, action: model.confirmGitDiscard)
    } message: {
      Text(model.pendingGitDiscard?.path ?? "")
    }
    .sheet(
      isPresented: Binding(
        get: { model.recoverySheetPresented },
        set: { if !$0 { model.dismissRecoverySheet() } }
      )
    ) {
      NativeWorkbenchRecoverySheet(model: model, language: language)
    }
  }
}

private struct NativeWorkbenchTabBar: View {
  @ObservedObject var model: NativeWorkbenchModel
  let language: ArkLanguagePreference
  @State private var showToolMenu = false

  var body: some View {
    HStack(spacing: 4) {
      ScrollViewReader { proxy in
        ScrollView(.horizontal, showsIndicators: false) {
          HStack(spacing: 3) {
            ForEach(model.toolTabs.tabs) { tab in
              HStack(spacing: 6) {
                Button {
                  model.activateToolTab(tab.id)
                } label: {
                  Label(tab.title(language), systemImage: tab.systemImage)
                    .font(.system(size: 11, weight: .medium))
                    .lineLimit(1)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                Button {
                  model.requestToolTabClose(tab.id)
                } label: {
                  Image(systemName: "xmark")
                    .font(.system(size: 8, weight: .bold))
                    .frame(width: 16, height: 16)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(ArkL10n.text(.filesCloseTab, language))
              }
              .padding(.horizontal, 9)
              .frame(height: 34)
              .background(
                model.toolTabs.activeTabID == tab.id
                  ? NativeWorkbenchPalette.selected
                  : Color.clear,
                in: RoundedRectangle(cornerRadius: 7)
              )
              .id(tab.id)
            }
            toolMenuTrigger
          }
        }
        .onAppear {
          if let active = model.toolTabs.activeTabID { proxy.scrollTo(active, anchor: .leading) }
        }
        .onChange(of: model.toolTabs.activeTabID) { active in
          if let active { proxy.scrollTo(active, anchor: .leading) }
        }
        .onChange(of: model.toolTabs.tabs.count) { _ in
          if let active = model.toolTabs.activeTabID { proxy.scrollTo(active, anchor: .leading) }
        }
        .frame(minWidth: 120)
        .layoutPriority(1)
      }

      WindowDragSurface()
        .frame(width: 36)
        .frame(maxHeight: .infinity)
        .accessibilityHidden(true)
    }
    .padding(.horizontal, 8)
    .frame(height: 42)
    .background(NativeWorkbenchPalette.panel)
  }

  private var toolMenuTrigger: some View {
    Button {
      showToolMenu.toggle()
    } label: {
      Image(systemName: "plus")
        .frame(width: 30, height: 30)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .help(ArkL10n.text(.filesOpenTab, language))
    .accessibilityIdentifier("ark.workbench.tool-menu")
    .popover(isPresented: $showToolMenu, arrowEdge: .bottom) {
      VStack(spacing: 2) {
        toolMenuButton(.review, shortcutLabel: "⌃⇧G")
        toolMenuButton(.terminal, shortcutLabel: "⌃`")
        toolMenuButton(.browser, shortcutLabel: "⌘T")
        toolMenuButton(.files, shortcutLabel: "⌘P")
      }
      .padding(6)
      .frame(width: 220)
    }
  }

  private func toolMenuButton(
    _ kind: NativeWorkbenchTabKind,
    shortcutLabel: String
  ) -> some View {
    Button {
      model.openTool(kind)
      showToolMenu = false
    } label: {
      HStack(spacing: 10) {
        Label(kind.title(language), systemImage: kind.systemImage)
        Spacer(minLength: 12)
        Text(shortcutLabel)
          .font(.system(size: 10, design: .monospaced))
          .foregroundStyle(NativeWorkbenchPalette.secondary)
      }
      .padding(.horizontal, 8)
      .frame(maxWidth: .infinity, minHeight: 32, alignment: .leading)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityIdentifier("ark.workbench.tool.\(kind.rawValue)")
  }
}

/// Root-selection boundary for Workbench. Ark never invents a visible
/// "Default Workspace" when the conversation has no explicit local root.
struct NativeWorkbenchRootChooser: View {
  let language: ArkLanguagePreference
  let choose: () -> Void

  var body: some View {
    VStack(spacing: 12) {
      Spacer()
      Image(systemName: "folder.badge.plus")
        .font(.system(size: 28, weight: .medium))
        .foregroundStyle(NativeWorkbenchPalette.secondary)
      Text(ArkL10n.text(.workbenchChooseRootTitle, language))
        .font(.system(size: 15, weight: .semibold))
      Text(ArkL10n.text(.workbenchChooseRootDetail, language))
        .font(.system(size: 11))
        .foregroundStyle(NativeWorkbenchPalette.secondary)
        .multilineTextAlignment(.center)
        .frame(maxWidth: 360)
      Button(ArkL10n.text(.workbenchChooseRoot, language), action: choose)
        .buttonStyle(.borderedProminent)
      Spacer()
    }
    .padding(24)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(NativeWorkbenchPalette.background)
  }
}

extension NativeWorkbenchTabKind {
  func title(_ language: ArkLanguagePreference) -> String {
    switch self {
    case .review: return ArkL10n.text(.workbenchReview, language)
    case .terminal: return ArkL10n.text(.workbenchTerminal, language)
    case .browser: return ArkL10n.text(.workbenchBrowser, language)
    case .files: return ArkL10n.text(.workbenchFiles, language)
    }
  }

  var systemImage: String {
    switch self {
    case .review: return "arrow.triangle.branch"
    case .terminal: return "terminal"
    case .browser: return "globe"
    case .files: return "folder"
    }
  }
}

private extension NativeWorkbenchToolTab {
  func title(_ language: ArkLanguagePreference) -> String {
    let base = kind.title(language)
    guard ordinal > 1, kind == .terminal || kind == .browser else { return base }
    return "\(base) \(ordinal)"
  }

  var systemImage: String { kind.systemImage }
}

/// Conversation-owned launcher shown before a concrete Workbench tool opens.
/// The product conversation remains visible in the left split, so the launcher
/// contains only tools with distinct workspace responsibilities.
struct NativeConversationWorkbenchLauncher: View {
  let language: ArkLanguagePreference
  let select: (NativeWorkbenchTabKind) -> Void

  private let tools: [(NativeWorkbenchTabKind, String)] = [
    (.review, "⌃⇧G"),
    (.terminal, "⌃`"),
    (.browser, "⌘T"),
    (.files, "⌘P"),
  ]

  var body: some View {
    VStack(spacing: 7) {
      ForEach(tools, id: \.0.rawValue) { kind, shortcut in
        Button { select(kind) } label: {
          HStack(spacing: 10) {
            Label(kind.title(language), systemImage: kind.systemImage)
            Spacer()
            Text(shortcut)
              .font(.system(size: 10, design: .monospaced))
              .foregroundStyle(NativeWorkbenchPalette.secondary)
              .padding(.horizontal, 7)
              .padding(.vertical, 3)
              .background(NativeWorkbenchPalette.raised, in: Capsule())
          }
          .font(.system(size: 12))
          .padding(.horizontal, 12)
          .frame(maxWidth: .infinity, minHeight: 40, alignment: .leading)
          .contentShape(Rectangle())
          .background(NativeWorkbenchPalette.raised, in: RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("ark.conversation-tool.\(kind.rawValue)")
      }
    }
    .frame(maxWidth: 540)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
    .padding(24)
    .background(NativeWorkbenchPalette.background)
  }
}

private struct NativeFilesWorkspace: View {
  @ObservedObject var model: NativeWorkbenchModel
  let language: ArkLanguagePreference
  @State private var browserVisible = true

  private let browserMinimumWidth: CGFloat = 240
  private let browserMaximumWidth: CGFloat = 360
  private let browserWidthFraction: CGFloat = 0.40
  private let dividerWidth: CGFloat = 1

  var body: some View {
    VStack(spacing: 0) {
      NativeFileBreadcrumbBar(
        model: model,
        language: language,
        treeVisible: $browserVisible
      )
        .zIndex(10)
      Divider().overlay(NativeWorkbenchPalette.border)

      if !model.fileTabs.tabs.isEmpty {
        NativeFileTabStrip(model: model, language: language)
          .zIndex(10)
        Divider().overlay(NativeWorkbenchPalette.border)
      }
      GeometryReader { proxy in
        let resolvedBrowserWidth = min(
          browserMaximumWidth,
          max(browserMinimumWidth, proxy.size.width * browserWidthFraction)
        )

        HStack(spacing: 0) {
          NativeTextEditor(model: model, language: language)
            .frame(
              width: browserVisible
                ? max(0, proxy.size.width - resolvedBrowserWidth - dividerWidth)
                : proxy.size.width
            )

          Rectangle()
            .fill(NativeWorkbenchPalette.border)
          .frame(width: browserVisible ? dividerWidth : 0)
          .opacity(browserVisible ? 1 : 0)
          .allowsHitTesting(false)
          .accessibilityHidden(!browserVisible)

          NativeFileBrowser(model: model, language: language)
            .frame(width: browserVisible ? resolvedBrowserWidth : 0)
            .opacity(browserVisible ? 1 : 0)
            .allowsHitTesting(browserVisible)
            .accessibilityHidden(!browserVisible)
            .clipped()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
      }
    }
  }
}

private struct NativeFileBreadcrumbBar: View {
  @ObservedObject var model: NativeWorkbenchModel
  let language: ArkLanguagePreference
  @Binding var treeVisible: Bool

  var body: some View {
    HStack(spacing: 7) {
      Image(systemName: "folder")
        .foregroundStyle(NativeWorkbenchPalette.secondary)
        .accessibilityHidden(true)
      TextField(
        ArkL10n.text(.filesPathPlaceholder, language),
        text: $model.pathInput
      )
        .textFieldStyle(.plain)
        .font(.system(size: 11, design: .monospaced))
        .lineLimit(1)
        .frame(minWidth: 120, alignment: .leading)
        .layoutPriority(1)
        .onSubmit(model.openEnteredPath)
        .accessibilityIdentifier("ark.files.path-input")
        .help(model.activeBreadcrumb.joined(separator: "/"))
      Button(action: model.openEnteredPath) {
        Image(systemName: "arrow.right.circle")
          .frame(width: 26, height: 26)
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .disabled(model.pathInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      .help(ArkL10n.text(.filesOpen, language))
      .accessibilityIdentifier("ark.files.path-open")
      WindowDragSurface()
        .frame(minWidth: 64, maxWidth: .infinity)
        .frame(maxHeight: .infinity)
        .layoutPriority(0)
        .accessibilityHidden(true)
      Button(action: model.revealSelectedFile) {
        Image(systemName: "folder")
          .frame(width: 26, height: 26)
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .disabled(model.activeFileTab == nil)
      .help(ArkL10n.text(.filesRevealInFinder, language))
      Button(action: model.requestCloseActiveTab) {
        Image(systemName: "xmark")
          .frame(width: 26, height: 26)
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .disabled(model.activeFileTab == nil)
      .help(ArkL10n.text(.filesCloseTab, language))
      .accessibilityIdentifier("ark.files.close-current")
      NativeFirstMouseIconButton(
        systemName: "sidebar.right",
        help: ArkL10n.text(treeVisible ? .filesHideTree : .filesShowTree, language),
        accessibilityIdentifier: "ark.files.tree-visibility",
        action: { treeVisible.toggle() }
      )
      .frame(width: 28, height: 28)
    }
    .padding(.horizontal, 12)
    .frame(height: 38)
    .background(NativeWorkbenchPalette.panel)
  }
}

/// Files 编辑器内部的文件级 Tab 条：与工具导航（Files/Git/Terminal）分离。
private struct NativeFileTabStrip: View {
  @ObservedObject var model: NativeWorkbenchModel
  let language: ArkLanguagePreference

  var body: some View {
    HStack(spacing: 2) {
      ForEach(model.fileTabs.tabs) { tab in
        HStack(spacing: 6) {
          Button {
            model.activateFileTab(tab.id)
          } label: {
            HStack(spacing: 6) {
              Text(tab.url.lastPathComponent)
                .font(.system(size: 11))
              if tab.isDirty {
                Circle().fill(Color.orange).frame(width: 6, height: 6)
              }
            }
            .padding(.horizontal, 8)
            .frame(height: 26)
            .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .background(
            model.fileTabs.activeTabID == tab.id
              ? NativeWorkbenchPalette.raised
              : Color.clear,
            in: RoundedRectangle(cornerRadius: 5)
          )
          Button {
            model.requestCloseTab(id: tab.id)
          } label: {
            Image(systemName: "xmark")
              .font(.system(size: 8, weight: .bold))
              .frame(width: 16, height: 16)
              .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .help(ArkL10n.text(.filesCloseTab, language))
        }
        .padding(.trailing, 4)
      }
      Spacer()
    }
    .padding(.horizontal, 8)
    .frame(height: 32)
    .background(NativeWorkbenchPalette.panel)
  }
}

private struct NativeFileBrowser: View {
  @ObservedObject var model: NativeWorkbenchModel
  let language: ArkLanguagePreference

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 8) {
        NativeWorkbenchSearchField(
          text: $model.fileSearchQuery,
          placeholder: ArkL10n.text(.filesSearchPlaceholder, language)
        )
        .frame(height: 26)
        .onChange(of: model.fileSearchQuery) { query in
          model.scheduleFileSearch(query)
        }
        if model.fileSearchIsLoading {
          ProgressView()
            .controlSize(.small)
        }
        Button(action: model.refreshTree) {
          Image(systemName: "arrow.clockwise")
            .frame(width: 24, height: 24)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(ArkL10n.text(.filesRefresh, language))
        .disabled(!model.rootIsAvailable)
        NativeFileActionsPopover(model: model, language: language)
      }
      .padding(.horizontal, 12)
      .frame(height: 44)
      Divider().overlay(NativeWorkbenchPalette.border)

      if let rootError = model.rootError {
        VStack(alignment: .leading, spacing: 10) {
          Label(ArkL10n.text(.filesRootUnavailable, language), systemImage: "exclamationmark.triangle")
            .font(.system(size: 12, weight: .semibold))
          Text(rootError)
            .font(.system(size: 11))
            .foregroundStyle(NativeWorkbenchPalette.secondary)
            .textSelection(.enabled)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        Spacer()
      } else if let treeLoadError = model.treeLoadError {
        VStack(spacing: 10) {
          Label(
            ArkL10n.text(.filesRefreshFailed, language),
            systemImage: "exclamationmark.triangle"
          )
          .font(.system(size: 12, weight: .semibold))
          Text(treeLoadError)
            .font(.system(size: 11))
            .foregroundStyle(NativeWorkbenchPalette.secondary)
            .multilineTextAlignment(.center)
            .textSelection(.enabled)
          Button(ArkL10n.text(.fieldRetry, language), action: model.refreshTree)
            .buttonStyle(.bordered)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(14)
      } else if model.treeIsLoading {
        ProgressView()
          .controlSize(.small)
          .frame(maxWidth: .infinity, maxHeight: .infinity)
      } else if model.rootNodes.isEmpty {
        VStack(spacing: 8) {
          Image(systemName: "folder")
            .font(.system(size: 22))
          Text(ArkL10n.text(.filesEmptyDir, language))
            .font(.system(size: 12))
        }
        .foregroundStyle(NativeWorkbenchPalette.secondary)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
      } else {
        NativeFileOutlineView(model: model)
          .accessibilityIdentifier("ark.files.outline")
      }
    }
    .background(NativeWorkbenchPalette.panel)
  }
}

private struct NativeFileActionsPopover: View {
  @ObservedObject var model: NativeWorkbenchModel
  let language: ArkLanguagePreference
  @State private var presented = false

  var body: some View {
    Button { presented.toggle() } label: {
      Image(systemName: "ellipsis.circle")
        .frame(width: 24, height: 24)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .help(ArkL10n.text(.filesActions, language))
    .accessibilityIdentifier("ark.files.actions")
    .popover(isPresented: $presented, arrowEdge: .bottom) {
      VStack(spacing: 3) {
        actionButton(
          title: ArkL10n.text(.filesNewFile, language),
          systemImage: "doc.badge.plus"
        ) { model.promptCreateFile(language: language) }
        actionButton(
          title: ArkL10n.text(.filesNewFolder, language),
          systemImage: "folder.badge.plus"
        ) { model.promptCreateFolder(language: language) }
        Divider().padding(.vertical, 2)
        actionButton(
          title: ArkL10n.text(.filesRename, language),
          systemImage: "pencil",
          enabled: model.canMutateSelectedTreeItem
        ) { model.promptRenameSelected(language: language) }
        actionButton(
          title: ArkL10n.text(.filesDuplicate, language),
          systemImage: "doc.on.doc",
          enabled: model.canMutateSelectedTreeItem
        ) { model.duplicateSelectedTreeItem() }
        actionButton(
          title: ArkL10n.text(.filesMove, language),
          systemImage: "folder",
          enabled: model.canMutateSelectedTreeItem
        ) { model.promptMoveSelected(language: language) }
        actionButton(
          title: ArkL10n.text(.filesTrash, language),
          systemImage: "trash",
          enabled: model.canMutateSelectedTreeItem,
          destructive: true
        ) { model.promptTrashSelected(language: language) }
        Divider().padding(.vertical, 2)
        actionButton(
          title: ArkL10n.text(
            model.showHiddenNoise ? .filesHideHiddenNoise : .filesShowHiddenNoise,
            language
          ),
          systemImage: model.showHiddenNoise ? "eye.slash" : "eye"
        ) { model.toggleHiddenNoise() }
      }
      .padding(8)
      .frame(width: 238)
    }
  }

  private func actionButton(
    title: String,
    systemImage: String,
    enabled: Bool = true,
    destructive: Bool = false,
    action: @escaping () -> Void
  ) -> some View {
    Button {
      presented = false
      DispatchQueue.main.async(execute: action)
    } label: {
      Label(title, systemImage: systemImage)
        .font(.system(size: 12))
        .foregroundStyle(destructive ? Color.red : NativeWorkbenchPalette.primary)
        .frame(maxWidth: .infinity, minHeight: 32, alignment: .leading)
        .padding(.horizontal, 8)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(!enabled)
  }
}

private struct NativeTextEditor: View {
  @ObservedObject var model: NativeWorkbenchModel
  let language: ArkLanguagePreference

  var body: some View {
    if model.activeFileTab == nil {
      VStack(spacing: 10) {
        Image(systemName: "folder")
          .font(.system(size: 28, weight: .light))
        Text(ArkL10n.text(.filesEmptyEditorTitle, language))
          .font(.system(size: 15, weight: .medium))
        Text(ArkL10n.text(.filesEmptyEditorDetail, language))
          .font(.system(size: 12))
      }
      .foregroundStyle(NativeWorkbenchPalette.secondary)
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .background(NativeWorkbenchPalette.background)
      .accessibilityIdentifier("ark.files.empty-editor")
    } else {
      loadedEditor
    }
  }

  private var loadedEditor: some View {
    VStack(spacing: 0) {
      HStack(spacing: 10) {
        Image(systemName: "doc.text")
          .foregroundStyle(NativeWorkbenchPalette.secondary)
        Text(model.selectedFileDisplayPath ?? "选择左侧文件开始编辑")
          .font(.system(size: 11, design: .monospaced))
          .lineLimit(1)
          .truncationMode(.middle)
        if model.activeFileTab?.isDirty == true {
          Circle().fill(Color.orange).frame(width: 7, height: 7)
            .help(ArkL10n.text(.filesUnsaved, language))
        }
        Spacer()
        Button(ArkL10n.text(.filesRevert, language), action: model.revertEditor)
          .disabled(model.activeFileTab == nil || model.activeFileTab?.isDirty != true)
        Button(ArkL10n.text(.filesExport, language), action: model.exportSelectedFile)
          .disabled(model.activeFileTab == nil)
        Button(ArkL10n.text(.filesSave, language), action: model.saveEditor)
          .buttonStyle(.borderedProminent)
          .keyboardShortcut("s", modifiers: .command)
          .disabled(
            model.activeFileTab == nil
              || model.activeFileTab?.isDirty != true
              || model.activeFileIsSaving
          )
      }
      .font(.system(size: 11))
      .padding(.horizontal, 14)
      .frame(height: 42)
      .background(NativeWorkbenchPalette.panel)
      Divider().overlay(NativeWorkbenchPalette.border)

      NativeCodeEditorView(text: Binding(
        get: { model.activeFileTab?.text ?? "" },
        set: model.updateEditorText
      ), fileURL: model.activeFileTab?.url, isEditable: true)
        .accessibilityIdentifier("ark.files.code-editor")
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(NativeWorkbenchPalette.background)
        .clipped()

      NativeWorkbenchStatusBar(status: model.editorStatus, language: language)
    }
    .clipped()
  }
}

private struct NativeWorkbenchRecoverySheet: View {
  @ObservedObject var model: NativeWorkbenchModel
  let language: ArkLanguagePreference
  @State private var selectedID: String?
  @State private var comparesDraft = false

  private var selectedRecord: NativeWorkbenchDraftRecord? {
    let id = selectedID ?? model.recoveryDrafts.first?.id
    return model.recoveryDrafts.first { $0.id == id }
  }

  var body: some View {
    VStack(spacing: 0) {
      HStack(alignment: .top, spacing: 12) {
        VStack(alignment: .leading, spacing: 3) {
          Text(ArkL10n.text(.filesRecoveryTitle, language))
            .font(.system(size: 18, weight: .semibold))
          Text(ArkL10n.text(.filesRecoveryDetail, language))
            .font(.system(size: 11))
            .foregroundStyle(NativeWorkbenchPalette.secondary)
        }
        Spacer()
        Button(ArkL10n.text(.filesRecoveryLater, language)) {
          model.dismissRecoverySheet()
        }
        .buttonStyle(.borderless)
      }
      .padding(18)
      Divider().overlay(NativeWorkbenchPalette.border)

      HStack(spacing: 0) {
        ScrollView {
          LazyVStack(spacing: 4) {
            ForEach(model.recoveryDrafts) { record in
              Button {
                selectedID = record.id
                comparesDraft = false
              } label: {
                VStack(alignment: .leading, spacing: 4) {
                  Text(URL(fileURLWithPath: record.filePath).lastPathComponent)
                    .font(.system(size: 12, weight: .medium))
                    .lineLimit(1)
                  Text(record.filePath)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(NativeWorkbenchPalette.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                  Text(record.updatedAt.formatted(date: .abbreviated, time: .shortened))
                    .font(.system(size: 10))
                    .foregroundStyle(NativeWorkbenchPalette.secondary)
                }
                .padding(9)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
                .background(
                  selectedRecord?.id == record.id
                    ? NativeWorkbenchPalette.selected : Color.clear,
                  in: RoundedRectangle(cornerRadius: 7)
                )
              }
              .buttonStyle(.plain)
            }
          }
          .padding(8)
        }
        .frame(width: 250)
        .background(NativeWorkbenchPalette.panel)

        Divider().overlay(NativeWorkbenchPalette.border)

        if let record = selectedRecord {
          VStack(spacing: 0) {
            HStack(spacing: 8) {
              Text(record.filePath)
                .font(.system(size: 11, design: .monospaced))
                .lineLimit(1)
                .truncationMode(.middle)
              Spacer()
              Button(
                ArkL10n.text(
                  comparesDraft ? .filesRecoveryHideCompare : .filesRecoveryCompare,
                  language
                )
              ) {
                comparesDraft.toggle()
              }
              .buttonStyle(.borderless)
            }
            .padding(.horizontal, 12)
            .frame(height: 38)
            Divider().overlay(NativeWorkbenchPalette.border)

            if comparesDraft {
              HStack(spacing: 0) {
                recoveryCodePane(
                  title: ArkL10n.text(.filesRecoveryDiskVersion, language),
                  text: record.savedBaseline,
                  filePath: record.filePath
                )
                Divider().overlay(NativeWorkbenchPalette.border)
                recoveryCodePane(
                  title: ArkL10n.text(.filesRecoveryDraftVersion, language),
                  text: record.draftText,
                  filePath: record.filePath
                )
              }
            } else {
              NativeCodeEditorView(
                text: .constant(record.draftText),
                fileURL: URL(fileURLWithPath: record.filePath),
                isEditable: false
              )
              .frame(maxWidth: .infinity, maxHeight: .infinity)
            }

            Divider().overlay(NativeWorkbenchPalette.border)
            HStack(spacing: 10) {
              Button(ArkL10n.text(.filesRecoveryDiscard, language), role: .destructive) {
                model.discardRecoveryDraft(record)
              }
              Spacer()
              Button(ArkL10n.text(.filesRecoveryRestore, language)) {
                model.restoreRecoveryDraft(record)
              }
              .buttonStyle(.borderedProminent)
            }
            .padding(12)
          }
        } else {
          Text(ArkL10n.text(.filesRecoveryEmpty, language))
            .font(.system(size: 12))
            .foregroundStyle(NativeWorkbenchPalette.secondary)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
      }
    }
    .frame(minWidth: 900, minHeight: 580)
    .background(NativeWorkbenchPalette.background)
    .onAppear { selectedID = model.recoveryDrafts.first?.id }
    .onChange(of: model.recoveryDrafts.map(\.id)) { _ in
      if selectedRecord == nil { selectedID = model.recoveryDrafts.first?.id }
    }
  }

  private func recoveryCodePane(
    title: String,
    text: String,
    filePath: String
  ) -> some View {
    VStack(spacing: 0) {
      Text(title)
        .font(.system(size: 11, weight: .semibold))
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 10)
        .frame(height: 32)
        .background(NativeWorkbenchPalette.panel)
      NativeCodeEditorView(
        text: .constant(text),
        fileURL: URL(fileURLWithPath: filePath),
        isEditable: false
      )
      .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
  }
}

private struct NativeGitInspector: View {
  @ObservedObject var model: NativeWorkbenchModel
  let language: ArkLanguagePreference
  @State private var mode: NativeGitReviewMode = .changes

  private let changeTreeMinimumWidth: CGFloat = 240
  private let changeTreeMaximumWidth: CGFloat = 360
  private let changeTreeWidthFraction: CGFloat = 0.40
  private let dividerWidth: CGFloat = 1

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 10) {
        Label(ArkL10n.text(.filesGitTitle, language), systemImage: "arrow.triangle.branch")
          .font(.system(size: 12, weight: .semibold))
        Text(model.gitBranchLabel)
          .font(.system(size: 10, design: .monospaced))
          .foregroundStyle(NativeWorkbenchPalette.secondary)
          .lineLimit(1)
        Picker("", selection: $mode) {
          Text(ArkL10n.text(.gitChanges, language)).tag(NativeGitReviewMode.changes)
          Text(ArkL10n.text(.gitBranches, language)).tag(NativeGitReviewMode.history)
          Text(ArkL10n.text(.gitRepository, language)).tag(NativeGitReviewMode.repository)
        }
        .pickerStyle(.segmented)
        .frame(width: 260)
        Spacer()
        Text("\(model.gitChanges.count)")
          .font(.system(size: 10, design: .monospaced))
          .foregroundStyle(NativeWorkbenchPalette.secondary)
        if model.gitIsLoading {
          ProgressView().controlSize(.small)
        }
        Button(ArkL10n.text(.filesGitRefresh, language), action: model.refreshGit)
          .disabled(model.gitIsLoading || !model.rootIsAvailable)
      }
      .padding(.horizontal, 14)
      .frame(height: 42)
      .background(NativeWorkbenchPalette.panel)
      Divider().overlay(NativeWorkbenchPalette.border)

      reviewContent
      NativeWorkbenchStatusBar(status: model.gitMessage, language: language)
    }
    .onAppear(perform: model.refreshGitIfNeeded)
    .onChange(of: model.gitIsLoading) { loading in
      if !loading, !model.gitIsRepository { mode = .repository }
    }
  }

  @ViewBuilder
  private var reviewContent: some View {
    switch mode {
    case .changes:
      VStack(spacing: 0) {
        changesContent
        NativeGitCommitBar(model: model, language: language)
      }
    case .history:
      NativeGitHistoryView(model: model, language: language)
    case .repository:
      NativeGitRepositoryView(model: model, language: language)
    }
  }

  private var changesContent: some View {
    GeometryReader { proxy in
        let resolvedTreeWidth = min(
          changeTreeMaximumWidth,
          max(changeTreeMinimumWidth, proxy.size.width * changeTreeWidthFraction)
        )

        HStack(spacing: 0) {
          NativeGitDiffPane(model: model, language: language)
            .frame(
              width: max(0, proxy.size.width - resolvedTreeWidth - dividerWidth)
            )

          Rectangle()
            .fill(NativeWorkbenchPalette.border)
          .frame(width: dividerWidth)
          .allowsHitTesting(false)
          .accessibilityHidden(true)

          NativeGitChangeSidebar(model: model, language: language)
            .frame(width: resolvedTreeWidth)
            .clipped()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
      }
  }
}

private struct NativeGitChangeSidebar: View {
  @ObservedObject var model: NativeWorkbenchModel
  let language: ArkLanguagePreference
  @State private var query = ""

  private var changes: [NativeGitChange] {
    let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !needle.isEmpty else { return model.gitChanges }
    return model.gitChanges.filter { $0.path.localizedCaseInsensitiveContains(needle) }
  }

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 8) {
        NativeWorkbenchSearchField(
          text: $query,
          placeholder: ArkL10n.text(.workbenchReviewFilter, language)
        )
        .frame(height: 26)
      }
      .padding(.horizontal, 10)
      .frame(height: 42)
      Divider().overlay(NativeWorkbenchPalette.border)
      if changes.isEmpty {
        Text(ArkL10n.text(.workbenchReviewNoChanges, language))
          .font(.system(size: 12))
          .foregroundStyle(NativeWorkbenchPalette.secondary)
          .frame(maxWidth: .infinity, maxHeight: .infinity)
      } else {
        NativeGitChangeOutlineView(
          rootURL: model.rootURL,
          changes: changes,
          selectedPath: model.selectedGitPath,
          expandAllDirectories: !query.trimmingCharacters(
            in: .whitespacesAndNewlines
          ).isEmpty,
          showsStateDots: true,
          onSelect: model.selectGitChange
        )
          .accessibilityIdentifier("ark.review.outline")
      }
    }
    .background(NativeWorkbenchPalette.panel)
  }
}

private struct NativeGitDiffPane: View {
  @ObservedObject var model: NativeWorkbenchModel
  let language: ArkLanguagePreference
  @State private var showsAllTrackedDiffs = false

  private var selectedFileURL: URL? {
    guard let path = model.selectedGitPath else { return nil }
    return model.rootURL.appendingPathComponent(path).standardizedFileURL
  }

  private var diffStats: NativeGitDiffStats {
    NativeGitDiffStats(patch: displayedPatch)
  }

  private var allTrackedPatch: String {
    switch model.gitDiffScope {
    case .working:
      return model.gitWorkingDiff
    case .staged:
      return model.gitStagedDiff
    case .combined:
      return [model.gitStagedDiff, model.gitWorkingDiff]
        .filter { !$0.isEmpty }
        .joined(separator: "\n")
    }
  }

  private var displayedPatch: String {
    showsAllTrackedDiffs ? allTrackedPatch : model.selectedGitDiff
  }

  private var displayedFileURL: URL? {
    showsAllTrackedDiffs ? nil : selectedFileURL
  }

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 8) {
        Image(systemName: "doc.text.magnifyingglass")
          .foregroundStyle(NativeWorkbenchPalette.secondary)
        Text(
          showsAllTrackedDiffs
            ? ArkL10n.text(.gitAllTrackedChanges, language)
            : model.selectedGitPath ?? ArkL10n.text(.workbenchReviewSelectChange, language)
        )
          .font(.system(size: 11, design: .monospaced))
          .lineLimit(1)
          .truncationMode(.middle)
        Spacer()
        if model.gitDiffIsLoading { ProgressView().controlSize(.small) }
        if (model.selectedGitPath != nil || showsAllTrackedDiffs), !model.gitDiffIsLoading {
          Text("+\(diffStats.additions)")
            .foregroundStyle(Color.green)
          Text("−\(diffStats.deletions)")
            .foregroundStyle(Color.red)
        }
        Button {
          model.openSelectedGitFile()
        } label: {
          Label(ArkL10n.text(.workbenchOpenFile, language), systemImage: "doc.text")
        }
        .buttonStyle(.borderless)
        .disabled(model.selectedGitPath == nil)
        Button {
          showsAllTrackedDiffs.toggle()
        } label: {
          Image(systemName: showsAllTrackedDiffs ? "rectangle.compress.vertical" : "rectangle.expand.vertical")
        }
        .buttonStyle(.borderless)
        .help(
          ArkL10n.text(
            showsAllTrackedDiffs ? .gitCollapseAllDiffs : .gitExpandAllDiffs,
            language
          )
        )
        .disabled(allTrackedPatch.isEmpty)
      }
      .padding(.horizontal, 12)
      .frame(height: 40)
      .background(NativeWorkbenchPalette.panel)
      HStack(spacing: 8) {
        Picker("", selection: Binding(
          get: { model.gitDiffScope },
          set: model.setGitDiffScope
        )) {
          Text(ArkL10n.text(.gitCombinedDiff, language)).tag(NativeGitDiffScope.combined)
          Text(ArkL10n.text(.gitWorkingDiff, language)).tag(NativeGitDiffScope.working)
          Text(ArkL10n.text(.gitStagedDiff, language)).tag(NativeGitDiffScope.staged)
        }
        .pickerStyle(.segmented)
        .frame(width: 230)
        Spacer()
        Button(ArkL10n.text(.gitStage, language), action: model.stageSelectedGitChange)
          .disabled(
            model.selectedGitChange == nil
              || model.selectedGitChange?.hasConflict == true
              || model.selectedGitChange?.hasWorkingChange != true
          )
        Button(ArkL10n.text(.gitUnstage, language), action: model.unstageSelectedGitChange)
          .disabled(
            model.selectedGitChange?.hasStagedChange != true
              || model.selectedGitChange?.hasConflict == true
          )
        Button(ArkL10n.text(.gitDiscard, language), action: model.requestDiscardSelectedGitChange)
          .foregroundStyle(Color.red)
          .disabled(
            model.selectedGitChange?.hasWorkingChange != true
              || model.selectedGitChange?.hasConflict == true
          )
      }
      .font(.system(size: 10))
      .padding(.horizontal, 10)
      .frame(height: 34)
      .background(NativeWorkbenchPalette.panel)
      Divider().overlay(NativeWorkbenchPalette.border)

      if showsAllTrackedDiffs, model.gitChanges.contains(where: \.isUntracked) {
        Label(
          ArkL10n.text(.gitTrackedChangesOnly, language),
          systemImage: "exclamationmark.circle"
        )
        .font(.system(size: 10))
        .foregroundStyle(Color.orange)
        .padding(.horizontal, 10)
        .frame(maxWidth: .infinity, minHeight: 32, alignment: .leading)
        .background(Color.orange.opacity(0.06))
        Divider().overlay(NativeWorkbenchPalette.border)
      }

      if displayedPatch.isEmpty, !model.gitDiffIsLoading {
        Text(
          model.gitChanges.isEmpty
            ? ArkL10n.text(.workbenchReviewNoChanges, language)
            : ArkL10n.text(.workbenchReviewSelectChange, language)
        )
        .font(.system(size: 12))
        .foregroundStyle(NativeWorkbenchPalette.secondary)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
      } else {
        NativeGitSideBySideDiffView(
          patch: displayedPatch,
          fileURL: displayedFileURL
        )
        .accessibilityIdentifier("ark.review.diff-editor")
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(NativeWorkbenchPalette.background)
        .clipped()
      }
    }
    .background(NativeWorkbenchPalette.background)
  }
}

private struct NativeGitCommitBar: View {
  @ObservedObject var model: NativeWorkbenchModel
  let language: ArkLanguagePreference

  var body: some View {
    HStack(spacing: 8) {
      Button(ArkL10n.text(.gitStageAll, language), action: model.stageAllGitChanges)
        .disabled(model.gitChanges.isEmpty || model.gitIsLoading)
      Button(ArkL10n.text(.gitUnstageAll, language), action: model.unstageAllGitChanges)
        .disabled(!model.hasStagedGitChanges || model.gitIsLoading)
      Divider().frame(height: 20)
      TextField(ArkL10n.text(.gitCommitPlaceholder, language), text: $model.gitCommitMessage)
        .textFieldStyle(.roundedBorder)
        .onSubmit(model.commitStagedGitChanges)
      Button(ArkL10n.text(.gitCommit, language), action: model.commitStagedGitChanges)
        .buttonStyle(.borderedProminent)
        .disabled(
          model.gitCommitMessage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !model.hasStagedGitChanges
            || model.gitIsLoading
        )
    }
    .font(.system(size: 10))
    .padding(.horizontal, 10)
    .frame(height: 42)
    .background(NativeWorkbenchPalette.panel)
  }
}

private struct NativeGitHistoryView: View {
  @ObservedObject var model: NativeWorkbenchModel
  let language: ArkLanguagePreference

  private var selectedFileURL: URL {
    model.rootURL
      .appendingPathComponent(model.selectedGitCommitPath ?? "commit.diff")
      .standardizedFileURL
  }

  private var diffStats: NativeGitDiffStats {
    NativeGitDiffStats(patch: model.selectedGitCommitPatch)
  }

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 8) {
        Menu {
          ForEach(model.gitBranches) { branch in
            Button {
              model.switchGitBranch(branch)
            } label: {
              Label(
                branch.name,
                systemImage: branch.isCurrent ? "checkmark" : "arrow.triangle.branch"
              )
            }
            .disabled(branch.isCurrent || model.fileTabs.hasDirtyTabs || model.gitIsLoading)
          }
        } label: {
          Label(
            model.gitBranches.first(where: \.isCurrent)?.name
              ?? ArkL10n.text(.gitBranches, language),
            systemImage: "arrow.triangle.branch"
          )
        }
        .menuStyle(.borderlessButton)
        TextField(
          ArkL10n.text(.gitNewBranchPlaceholder, language),
          text: $model.gitNewBranchName
        )
        .textFieldStyle(.roundedBorder)
        .frame(maxWidth: 260)
        .onSubmit(model.createGitBranch)
        Button(ArkL10n.text(.gitCreateBranch, language), action: model.createGitBranch)
          .disabled(
            model.gitNewBranchName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
              || model.fileTabs.hasDirtyTabs
              || model.gitIsLoading
          )
        Spacer()
      }
      .padding(.horizontal, 12)
      .frame(height: 42)
      .background(NativeWorkbenchPalette.panel)
      Divider().overlay(NativeWorkbenchPalette.border)

      HStack(spacing: 0) {
      VStack(spacing: 0) {
        ScrollView {
          Text(model.selectedGitCommitDetail)
            .font(.system(size: 11, design: .monospaced))
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(10)
        }
        .frame(maxHeight: 132)
        Divider().overlay(NativeWorkbenchPalette.border)
        HStack(spacing: 8) {
          Image(systemName: "doc.text.magnifyingglass")
            .foregroundStyle(NativeWorkbenchPalette.secondary)
          Text(
            model.selectedGitCommitPath
              ?? ArkL10n.text(.gitSelectChangedFile, language)
          )
          .font(.system(size: 11, design: .monospaced))
          .lineLimit(1)
          .truncationMode(.middle)
          Spacer()
          if model.gitCommitDiffIsLoading {
            ProgressView().controlSize(.small)
          } else if model.selectedGitCommitPath != nil {
            Text("+\(diffStats.additions)")
              .foregroundStyle(Color.green)
            Text("−\(diffStats.deletions)")
              .foregroundStyle(Color.red)
          }
        }
        .padding(.horizontal, 12)
        .frame(height: 40)
        .background(NativeWorkbenchPalette.panel)
        Divider().overlay(NativeWorkbenchPalette.border)
        if model.selectedGitCommitPatch.isEmpty, !model.gitCommitDiffIsLoading {
          Text(ArkL10n.text(.gitSelectChangedFile, language))
            .font(.system(size: 12))
            .foregroundStyle(NativeWorkbenchPalette.secondary)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
          NativeGitSideBySideDiffView(
            patch: model.selectedGitCommitPatch,
            fileURL: selectedFileURL
          )
          .accessibilityIdentifier("ark.review.commit-diff")
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)

      Rectangle()
        .fill(NativeWorkbenchPalette.border)
        .frame(width: 1)
        .allowsHitTesting(false)

      VStack(spacing: 0) {
        HStack {
          Text(ArkL10n.text(.gitCommits, language))
            .font(.system(size: 11, weight: .semibold))
          Spacer()
          Text("\(model.gitHistory.count)")
            .font(.system(size: 10, design: .monospaced))
            .foregroundStyle(NativeWorkbenchPalette.secondary)
        }
        .padding(.horizontal, 10)
        .frame(height: 34)
        ScrollView {
          LazyVStack(spacing: 3) {
            ForEach(model.gitHistory) { commit in
              Button { model.selectGitCommit(commit) } label: {
                VStack(alignment: .leading, spacing: 4) {
                  HStack {
                    Text(commit.shortID)
                      .font(.system(size: 10, weight: .semibold, design: .monospaced))
                      .foregroundStyle(NativeWorkbenchPalette.accent)
                    Spacer()
                    Text(commit.date)
                      .font(.system(size: 9, design: .monospaced))
                      .foregroundStyle(NativeWorkbenchPalette.secondary)
                  }
                  Text(commit.subject)
                    .font(.system(size: 11, weight: .medium))
                    .lineLimit(2)
                  Text(commit.author)
                    .font(.system(size: 10))
                    .foregroundStyle(NativeWorkbenchPalette.secondary)
                }
                .padding(8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
                .background(
                  model.selectedGitCommitID == commit.id
                    ? NativeWorkbenchPalette.selected : Color.clear,
                  in: RoundedRectangle(cornerRadius: 7)
                )
              }
              .buttonStyle(.plain)
            }
          }
          .padding(7)
        }
        .frame(minHeight: 130, maxHeight: 240)
        Divider().overlay(NativeWorkbenchPalette.border)
        HStack {
          Text(ArkL10n.text(.gitChangedFiles, language))
            .font(.system(size: 11, weight: .semibold))
          Spacer()
          Text("\(model.gitCommitChanges.count)")
            .font(.system(size: 10, design: .monospaced))
            .foregroundStyle(NativeWorkbenchPalette.secondary)
        }
        .padding(.horizontal, 10)
        .frame(height: 34)
        if model.gitCommitChanges.isEmpty {
          Text(ArkL10n.text(.gitNoChangedFiles, language))
            .font(.system(size: 11))
            .foregroundStyle(NativeWorkbenchPalette.secondary)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
          NativeGitChangeOutlineView(
            rootURL: model.rootURL,
            changes: model.gitCommitChanges,
            selectedPath: model.selectedGitCommitPath,
            expandAllDirectories: false,
            showsStateDots: false,
            onSelect: model.selectGitCommitChange
          )
          .accessibilityIdentifier("ark.review.history-files")
        }
      }
      .frame(width: 320)
      .background(NativeWorkbenchPalette.panel)
      }
    }
  }
}

private struct NativeGitBranchesView: View {
  @ObservedObject var model: NativeWorkbenchModel
  let language: ArkLanguagePreference

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 8) {
        TextField(ArkL10n.text(.gitNewBranchPlaceholder, language), text: $model.gitNewBranchName)
          .textFieldStyle(.roundedBorder)
          .onSubmit(model.createGitBranch)
        Button(ArkL10n.text(.gitCreateBranch, language), action: model.createGitBranch)
          .buttonStyle(.borderedProminent)
          .disabled(
            model.gitNewBranchName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
              || model.fileTabs.hasDirtyTabs
              || model.gitIsLoading
          )
      }
      .padding(12)
      Divider().overlay(NativeWorkbenchPalette.border)
      ScrollView {
        LazyVStack(spacing: 4) {
          ForEach(model.gitBranches) { branch in
            HStack(spacing: 10) {
              Image(systemName: branch.isCurrent ? "checkmark.circle.fill" : "circle")
                .foregroundStyle(branch.isCurrent ? NativeWorkbenchPalette.accent : NativeWorkbenchPalette.secondary)
              Text(branch.name)
                .font(.system(size: 12, design: .monospaced))
              Spacer()
              if branch.isCurrent {
                Text(ArkL10n.text(.gitCurrentBranch, language))
                  .font(.system(size: 10))
                  .foregroundStyle(NativeWorkbenchPalette.secondary)
              } else {
                Button(ArkL10n.text(.gitSwitchBranch, language)) {
                  model.switchGitBranch(branch)
                }
                .disabled(model.fileTabs.hasDirtyTabs || model.gitIsLoading)
              }
            }
            .padding(.horizontal, 12)
            .frame(maxWidth: .infinity, minHeight: 36)
            .background(
              branch.isCurrent ? NativeWorkbenchPalette.selected : Color.clear,
              in: RoundedRectangle(cornerRadius: 7)
            )
          }
        }
        .padding(10)
      }
    }
    .background(NativeWorkbenchPalette.background)
  }
}

private struct NativeGitRepositoryView: View {
  @ObservedObject var model: NativeWorkbenchModel
  let language: ArkLanguagePreference

  var body: some View {
    if model.gitIsRepository {
      ScrollView {
      VStack(alignment: .leading, spacing: 14) {
        repositorySection(
          title: ArkL10n.text(.gitRepositoryRoot, language),
          systemImage: "externaldrive"
        ) {
          Text(model.rootURL.path)
            .font(.system(size: 11, design: .monospaced))
            .textSelection(.enabled)
        }

        repositorySection(
          title: ArkL10n.text(.gitRepositoryTracking, language),
          systemImage: "arrow.triangle.branch"
        ) {
          LabeledContent(ArkL10n.text(.gitCurrentBranch, language)) {
            Text(model.gitBranches.first(where: \.isCurrent)?.name ?? "—")
              .font(.system(size: 11, design: .monospaced))
          }
          LabeledContent(ArkL10n.text(.gitRepositoryTracking, language)) {
            Text(model.gitUpstreamName.isEmpty ? "—" : model.gitUpstreamName)
              .font(.system(size: 11, design: .monospaced))
          }
          if !model.gitUpstreamName.isEmpty {
            Text("↑ \(model.gitAheadCount)   ↓ \(model.gitBehindCount)")
              .font(.system(size: 11, weight: .semibold, design: .monospaced))
              .foregroundStyle(NativeWorkbenchPalette.secondary)
              .frame(maxWidth: .infinity, alignment: .trailing)
          }
        }

        repositorySection(
          title: ArkL10n.text(.gitCommitIdentity, language),
          systemImage: "person.crop.circle"
        ) {
          TextField(
            ArkL10n.text(.gitIdentityName, language),
            text: $model.gitIdentityNameInput
          )
            .textFieldStyle(.roundedBorder)
          TextField(
            ArkL10n.text(.gitIdentityEmail, language),
            text: $model.gitIdentityEmailInput
          )
            .textFieldStyle(.roundedBorder)
          HStack {
            Text(
              [model.gitRepositoryIdentityName, model.gitRepositoryIdentityEmail]
                .filter { !$0.isEmpty }
                .joined(separator: " · ")
            )
            .font(.system(size: 10))
            .foregroundStyle(NativeWorkbenchPalette.secondary)
            .lineLimit(1)
            Spacer()
            Button(ArkL10n.text(.gitSaveIdentity, language), action: model.saveGitRepositoryIdentity)
              .disabled(
                model.gitIdentityNameInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                  || model.gitIdentityEmailInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                  || model.gitIsLoading
              )
          }
        }

        repositorySection(
          title: ArkL10n.text(.gitRemoteConnections, language),
          systemImage: "network"
        ) {
          if model.gitRemotes.isEmpty {
            Text(ArkL10n.text(.gitNoRemote, language))
              .foregroundStyle(NativeWorkbenchPalette.secondary)
          } else {
            ForEach(model.gitRemotes) { remote in
              HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 3) {
                  Text(remote.name)
                    .font(.system(size: 11, weight: .semibold, design: .monospaced))
                  Text(remote.fetchURL)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(NativeWorkbenchPalette.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                }
                Spacer()
                Button(ArkL10n.text(.gitUseRemote, language)) {
                  model.prepareGitRemote(remote)
                }
              }
              .frame(minHeight: 38)
              if remote.id != model.gitRemotes.last?.id {
                Divider().overlay(NativeWorkbenchPalette.border)
              }
            }
          }
          HStack(spacing: 8) {
            TextField(
              ArkL10n.text(.gitRemoteNamePlaceholder, language),
              text: $model.gitRemoteNameInput
            )
            .textFieldStyle(.roundedBorder)
            .frame(width: 190)
            TextField(
              ArkL10n.text(.gitRemoteURLPlaceholder, language),
              text: $model.gitRemoteURLInput
            )
            .textFieldStyle(.roundedBorder)
            Button(ArkL10n.text(.gitConnectRemote, language), action: model.saveGitRemoteConnection)
              .buttonStyle(.borderedProminent)
              .disabled(
                model.gitRemoteNameInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                  || model.gitRemoteURLInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                  || model.gitIsLoading
              )
          }
          Text(ArkL10n.text(.gitCredentialsSystemManaged, language))
            .font(.system(size: 10))
            .foregroundStyle(NativeWorkbenchPalette.secondary)
        }
      }
      .padding(16)
      .frame(maxWidth: 900)
      .frame(maxWidth: .infinity)
      }
      .background(NativeWorkbenchPalette.background)
      .accessibilityIdentifier("ark.review.repository")
    } else {
      VStack(spacing: 12) {
        Spacer()
        Image(systemName: "arrow.triangle.branch")
          .font(.system(size: 28, weight: .medium))
          .foregroundStyle(NativeWorkbenchPalette.secondary)
        Text(ArkL10n.text(.gitNotRepository, language))
          .font(.system(size: 15, weight: .semibold))
        Text(ArkL10n.text(.gitNotRepositoryDetail, language))
          .font(.system(size: 11))
          .foregroundStyle(NativeWorkbenchPalette.secondary)
          .multilineTextAlignment(.center)
          .frame(maxWidth: 460)
        Text(model.rootURL.path)
          .font(.system(size: 10, design: .monospaced))
          .foregroundStyle(NativeWorkbenchPalette.secondary)
          .textSelection(.enabled)
        Button(
          ArkL10n.text(.gitInitializeRepository, language),
          action: model.initializeGitRepository
        )
        .buttonStyle(.borderedProminent)
        .disabled(model.gitIsLoading)
        Spacer()
      }
      .padding(24)
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .background(NativeWorkbenchPalette.background)
      .accessibilityIdentifier("ark.review.repository-setup")
    }
  }

  private func repositorySection<Content: View>(
    title: String,
    systemImage: String,
    @ViewBuilder content: () -> Content
  ) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      Label(title, systemImage: systemImage)
        .font(.system(size: 12, weight: .semibold))
      content()
    }
    .padding(14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(NativeWorkbenchPalette.panel, in: RoundedRectangle(cornerRadius: 10))
    .overlay(
      RoundedRectangle(cornerRadius: 10)
        .stroke(NativeWorkbenchPalette.border, lineWidth: 1)
    )
  }
}

private struct NativeOutputPanel: View {
  let title: String
  let output: String
  let language: ArkLanguagePreference

  var body: some View {
    VStack(spacing: 0) {
      HStack {
        Text(title)
          .font(.system(size: 11, weight: .semibold))
        Spacer()
        Button {
          let pasteboard = NSPasteboard.general
          pasteboard.clearContents()
          pasteboard.setString(output, forType: .string)
        } label: {
          Label(ArkL10n.text(.filesTerminalCopy, language), systemImage: "doc.on.doc")
        }
        .buttonStyle(.plain)
        .font(.system(size: 10))
        .disabled(output.isEmpty)
      }
      .padding(.horizontal, 12)
      .frame(height: 32)
      .background(NativeWorkbenchPalette.raised)
      Divider().overlay(NativeWorkbenchPalette.border)
      ScrollView([.horizontal, .vertical]) {
        Text(output.isEmpty ? ArkL10n.text(.filesNoOutput, language) : output)
          .font(.system(size: 11, design: .monospaced))
          .foregroundStyle(output.isEmpty ? NativeWorkbenchPalette.secondary : NativeWorkbenchPalette.primary)
          .textSelection(.enabled)
          .fixedSize(horizontal: true, vertical: false)
          .frame(maxWidth: .infinity, alignment: .topLeading)
          .padding(12)
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .background(NativeWorkbenchPalette.background)
    }
  }
}

private struct NativeWorkbenchStatusBar: View {
  let status: NativeWorkbenchStatus
  let language: ArkLanguagePreference

  private var message: String {
    switch status {
    case .selectFile: return ArkL10n.text(.filesSelectFile, language)
    case .refreshFailed(let reason): return ArkL10n.text(.filesRefreshFailed, language) + "：" + reason
    case .fileNotExists(let path): return ArkL10n.text(.filesNotExists, language) + "：" + path
    case .directorySelected: return ArkL10n.text(.filesSelectFile, language)
    case .readFailed(let name, let reason): return ArkL10n.text(.filesReadFailed, language) + " " + name + "：" + reason
    case .reverted: return ArkL10n.text(.filesReverted, language)
    case .saved(let time): return ArkL10n.text(.filesSaved, language) + " · " + time
    case .saveFailed(let reason): return ArkL10n.text(.filesSaveFailed, language) + "：" + reason
    case .loaded(let path): return ArkL10n.text(.filesLoaded, language) + " " + path
    case .openFailed(let reason): return ArkL10n.text(.filesOpenFailed, language) + "：" + reason
    case .exportSucceeded(let name): return ArkL10n.text(.filesExportSucceeded, language) + " " + name
    case .exportFailed(let reason): return ArkL10n.text(.filesExportFailed, language) + "：" + reason
    case .gitLoading: return ArkL10n.text(.filesGitLoading, language)
    case .gitRefreshed: return ArkL10n.text(.filesGitRefreshed, language)
    case .gitRefreshFailed(let code): return ArkL10n.text(.filesGitRefreshFailed, language) + "（" + code + "）"
    case .gitOperationSucceeded(let message): return message
    case .gitOperationFailed(let reason): return ArkL10n.text(.gitOperationFailed, language) + ": " + reason
    }
  }

  var body: some View {
    HStack {
      Text(message)
        .font(.system(size: 10))
        .foregroundStyle(NativeWorkbenchPalette.secondary)
        .lineLimit(1)
      Spacer()
    }
    .padding(.horizontal, 12)
    .frame(height: 26)
    .background(NativeWorkbenchPalette.panel)
  }
}

final class NativeFileNode: ObservableObject, Identifiable {
  let id: String
  let name: String
  let url: URL
  let isDirectory: Bool
  @Published var children: [NativeFileNode]?
  @Published var isExpanded = false
  @Published var isLoadingChildren = false

  var canonicalPath: String { NativeFileTabState.canonicalPath(for: url) }

  init(name: String, url: URL, isDirectory: Bool) {
    id = url.path
    self.name = name
    self.url = url
    self.isDirectory = isDirectory
  }

  var systemImage: String {
    switch url.pathExtension.lowercased() {
    case "swift": return "swift"
    case "md", "txt": return "doc.plaintext"
    case "json", "yaml", "yml", "toml": return "curlybraces"
    case "png", "jpg", "jpeg", "gif", "webp": return "photo"
    default: return "doc"
    }
  }
}

/// 工作台语义状态：Model 只存语义，View 用注入的 language 做 ArkL10n 渲染。
enum NativeWorkbenchStatus: Equatable {
  case selectFile
  case refreshFailed(String)
  case fileNotExists(String)
  case directorySelected
  case readFailed(name: String, reason: String)
  case reverted
  case saved(String)
  case saveFailed(String)
  case loaded(String)
  case openFailed(String)
  case exportSucceeded(String)
  case exportFailed(String)
  case gitLoading
  case gitRefreshed
  case gitRefreshFailed(String)
  case gitOperationSucceeded(String)
  case gitOperationFailed(String)
}

struct NativeGitChange: Identifiable, Equatable {
  let code: String
  let path: String

  var id: String { path }
  var hasStagedChange: Bool { code.first.map { $0 != " " && $0 != "?" } ?? false }
  var hasWorkingChange: Bool { code.last.map { $0 != " " } ?? false }
  var isUntracked: Bool { code == "??" }
  var hasConflict: Bool {
    let conflictCodes: Set<String> = ["DD", "AU", "UD", "UA", "DU", "AA", "UU"]
    return conflictCodes.contains(code)
  }

  init?(statusLine: Substring) {
    guard statusLine.count >= 4 else { return nil }
    let code = String(statusLine.prefix(2))
    guard code != "##" else { return nil }
    var path = String(statusLine.dropFirst(3))
    if let rename = path.range(of: " -> ") {
      path = String(path[rename.upperBound...])
    }
    path = path.trimmingCharacters(in: CharacterSet(charactersIn: "\""))
    guard !path.isEmpty else { return nil }
    self.code = code
    self.path = path
  }

  init?(historyNameStatusLine: Substring) {
    let fields = historyNameStatusLine.split(
      separator: "\t",
      omittingEmptySubsequences: false
    )
    guard fields.count >= 2,
          let status = fields.first,
          let statusCode = status.first
    else { return nil }
    let path = String(fields.last ?? "")
      .trimmingCharacters(in: CharacterSet(charactersIn: "\""))
    guard !path.isEmpty else { return nil }
    self.code = String(statusCode) + " "
    self.path = path
  }
}

struct NativeGitDiffStats: Equatable {
  let additions: Int
  let deletions: Int

  init(patch: String) {
    var additions = 0
    var deletions = 0
    patch.enumerateLines { line, _ in
      if line.hasPrefix("+") && !line.hasPrefix("+++") {
        additions += 1
      } else if line.hasPrefix("-") && !line.hasPrefix("---") {
        deletions += 1
      }
    }
    self.additions = additions
    self.deletions = deletions
  }
}

enum NativeGitDiffScope: String, CaseIterable, Identifiable {
  case combined
  case working
  case staged

  var id: String { rawValue }
}

enum NativeGitReviewMode: String, CaseIterable, Identifiable {
  case changes
  case history
  case repository

  var id: String { rawValue }
}

struct NativeGitRemote: Identifiable, Equatable {
  let name: String
  let fetchURL: String
  let pushURL: String
  let hasEmbeddedHTTPCredentials: Bool

  var id: String { name }

  init(name: String, fetchURL: String, pushURL: String) {
    self.name = name
    let fetch = Self.redactedHTTPURL(fetchURL)
    let push = Self.redactedHTTPURL(pushURL)
    self.fetchURL = fetch.url
    self.pushURL = push.url
    hasEmbeddedHTTPCredentials = fetch.redacted || push.redacted
  }

  private static func redactedHTTPURL(_ raw: String) -> (url: String, redacted: Bool) {
    guard var components = URLComponents(string: raw),
          ["http", "https"].contains(components.scheme?.lowercased() ?? ""),
          components.user != nil || components.password != nil
    else { return (raw, false) }
    components.user = nil
    components.password = nil
    return (components.string ?? "", true)
  }
}

struct NativeGitCommit: Identifiable, Equatable {
  let id: String
  let shortID: String
  let author: String
  let date: String
  let subject: String

  init?(line: Substring) {
    let fields = line.split(separator: "\t", maxSplits: 4, omittingEmptySubsequences: false)
    guard fields.count == 5, !fields[0].isEmpty else { return nil }
    id = String(fields[0])
    shortID = String(fields[1])
    author = String(fields[2])
    date = String(fields[3])
    subject = String(fields[4])
  }
}

struct NativeGitBranch: Identifiable, Equatable {
  let name: String
  let isCurrent: Bool

  var id: String { name }

  init?(line: Substring) {
    let fields = line.split(separator: "\t", maxSplits: 1, omittingEmptySubsequences: false)
    guard fields.count == 2, !fields[1].isEmpty else { return nil }
    isCurrent = fields[0] == "*"
    name = String(fields[1])
  }
}

/// Files 工作台模型。fileReader 注入点仅用于行为测试的可控延迟读取；
/// 生产路径使用 NativeWorkspaceAccess 的真实读取。
@MainActor
final class NativeWorkbenchModel: ObservableObject {
  typealias WebReader = (URL) async throws -> ArkWorkbenchWebDocument

  private let injectedFileReader: ((URL) async throws -> String)?
  private let injectedWebReader: WebReader?
  let rootURL: URL
  let rootError: String?

  @Published fileprivate var toolTabs = NativeWorkbenchTabsState()
  @Published fileprivate var pendingDirtyToolCloseID: String?
  @Published var rootNodes: [NativeFileNode] = []
  @Published var fileTreeRevision = 0
  @Published private(set) var treeIsLoading = false
  @Published private(set) var treeLoadError: String?
  @Published var fileSearchQuery = ""
  @Published private(set) var fileSearchIsLoading = false
  @Published private var fileSearchResults: [NativeFileNode]?
  @Published private(set) var selectedTreeURL: URL?
  @Published private(set) var selectedTreeIsDirectory = false
  @Published private(set) var fileMutationIsRunning = false
  @Published private(set) var savingFileTabIDs = Set<UUID>()
  @Published private(set) var showHiddenNoise = false
  @Published var pathInput = ""
  @Published var fileTabs = NativeFileTabsState()
  @Published fileprivate var editorStatus: NativeWorkbenchStatus = .selectFile
  @Published var gitStatus = ""
  @Published var gitIsRepository = false
  @Published var gitWorkingDiff = ""
  @Published var gitStagedDiff = ""
  @Published var selectedGitPath: String?
  @Published var selectedGitDiff = ""
  @Published var gitDiffIsLoading = false
  @Published var gitDiffScope: NativeGitDiffScope = .combined
  @Published var gitCommitMessage = ""
  @Published var gitHistory: [NativeGitCommit] = []
  @Published var selectedGitCommitID: String?
  @Published var selectedGitCommitDetail = ""
  @Published var gitCommitChanges: [NativeGitChange] = []
  @Published var selectedGitCommitPath: String?
  @Published var selectedGitCommitPatch = ""
  @Published var gitCommitDiffIsLoading = false
  @Published var gitBranches: [NativeGitBranch] = []
  @Published var gitNewBranchName = ""
  @Published var gitRemotes: [NativeGitRemote] = []
  @Published var gitRepositoryIdentityName = ""
  @Published var gitRepositoryIdentityEmail = ""
  @Published var gitIdentityNameInput = ""
  @Published var gitIdentityEmailInput = ""
  @Published var gitRemoteNameInput = "origin"
  @Published var gitRemoteURLInput = ""
  @Published var gitUpstreamName = ""
  @Published var gitAheadCount = 0
  @Published var gitBehindCount = 0
  @Published var pendingGitDiscard: NativeGitChange?
  @Published var gitMessage: NativeWorkbenchStatus = .gitRefreshed
  @Published var gitIsLoading = false
  @Published var recoveryDrafts: [NativeWorkbenchDraftRecord] = []
  @Published var recoverySheetPresented = false

  private let access: NativeWorkspaceAccess?
  private let draftJournal: NativeWorkbenchDraftJournal
  private let draftWriter: NativeWorkbenchDraftWriter
  private var draftMutationSequenceByID: [String: UInt64] = [:]
  private var didLoad = false
  private var treeRefreshGeneration = 0
  private var fileSelectionGeneration = 0
  private var didLoadGit = false
  private var gitSuccessAfterRefresh: String?
  private var selectLatestGitCommitAfterRefresh = false
  private var fileSearchGeneration = 0
  private var fileSearchTask: Task<Void, Never>?
  private var fileMutationGeneration = 0
  private var fileMutationTask: Task<Void, Never>?
  private var saveGenerationByTabID: [UUID: Int] = [:]
  private var saveTasks: [UUID: Task<Void, Never>] = [:]
  private var gitRefreshCancellation: NativeProcessCancellation?
  private var gitDiffCancellation: NativeProcessCancellation?
  private var gitCommitCancellation: NativeProcessCancellation?
  private var gitCommitDiffCancellation: NativeProcessCancellation?
  private var gitOperationCancellation: NativeProcessCancellation?
  private var browserSessions: [String: NativeWorkbenchBrowserSession] = [:]
  private var terminalSessions: [String: NativePTYTerminalSession] = [:]
  private var terminalShutdownIDs = Set<String>()

  init(
    rootURL: URL,
    initialTool: NativeWorkbenchTabKind = .files,
    fileReader: ((URL) async throws -> String)? = nil,
    webReader: WebReader? = nil,
    draftJournal: NativeWorkbenchDraftJournal? = nil,
    draftDebounceNanoseconds: UInt64 = 350_000_000
  ) {
    toolTabs = NativeWorkbenchTabsState(initial: initialTool)
    self.injectedFileReader = fileReader
    injectedWebReader = webReader
    let resolvedDraftJournal = draftJournal ?? NativeWorkbenchDraftJournal()
    self.draftJournal = resolvedDraftJournal
    draftWriter = NativeWorkbenchDraftWriter(
      journal: resolvedDraftJournal,
      debounceNanoseconds: draftDebounceNanoseconds
    )
    do {
      let access = try NativeWorkspaceAccess(rootURL: rootURL)
      self.access = access
      self.rootURL = access.rootURL
      rootError = nil
    } catch {
      access = nil
      self.rootURL = rootURL.standardizedFileURL
      rootError = error.localizedDescription
    }
    pathInput = self.rootURL.path
  }

  var rootIsAvailable: Bool { access != nil }
  var canMutateSelectedTreeItem: Bool {
    guard let selectedTreeURL else { return false }
    return !fileMutationIsRunning
      && selectedTreeURL.standardizedFileURL.path != rootURL.standardizedFileURL.path
  }
  var activeFileTab: NativeFileTabState? { fileTabs.activeTab }
  var activeFileIsSaving: Bool {
    fileTabs.activeTabID.map(savingFileTabIDs.contains) ?? false
  }
  var selectedFileDisplayPath: String? {
    guard let url = fileTabs.activeTab?.url, let access else { return nil }
    return access.displayPath(for: url)
  }
  var activeBreadcrumb: [String] {
    let rootName = rootURL.lastPathComponent.isEmpty ? rootURL.path : rootURL.lastPathComponent
    guard let path = selectedFileDisplayPath, path != "." else { return [rootName] }
    return [rootName] + path.split(separator: "/").map(String.init)
  }
  var gitChanges: [NativeGitChange] {
    gitStatus.split(separator: "\n", omittingEmptySubsequences: true)
      .compactMap(NativeGitChange.init(statusLine:))
  }
  var selectedGitChange: NativeGitChange? {
    guard let selectedGitPath else { return nil }
    return gitChanges.first { $0.path == selectedGitPath }
  }
  var hasStagedGitChanges: Bool { gitChanges.contains { $0.hasStagedChange } }
  fileprivate var gitBranchLabel: String {
    guard let first = gitStatus.split(separator: "\n", omittingEmptySubsequences: true).first,
          first.hasPrefix("## ")
    else { return rootURL.lastPathComponent }
    return String(first.dropFirst(3))
  }

  var filteredRootNodes: [NativeFileNode] {
    let query = fileSearchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !query.isEmpty else { return rootNodes }
    guard let root = rootNodes.first else { return [] }
    if let fileSearchResults {
      let filteredRoot = NativeFileNode(name: root.name, url: root.url, isDirectory: true)
      filteredRoot.children = fileSearchResults
      filteredRoot.isExpanded = true
      return [filteredRoot]
    }
    let filteredRoot = NativeFileNode(name: root.name, url: root.url, isDirectory: true)
    filteredRoot.children = root.children?.compactMap { filteredNode($0, query: query) }
    filteredRoot.isExpanded = true
    return [filteredRoot]
  }



  func loadIfNeeded() {
    guard !didLoad else { return }
    didLoad = true
    refreshTree()
    loadRecoveryDrafts()
  }

  func updateEditorText(_ newValue: String) {
    guard let activeID = fileTabs.activeTabID else { return }
    fileTabs.updateText(id: activeID, text: newValue)
    guard let tab = fileTabs.tab(withID: activeID) else { return }
    if tab.isDirty {
      scheduleRecoveryDraft(for: tab)
    } else {
      clearRecoveryDraft(for: tab)
    }
  }

  /// File-tab activation owns every shared Files projection. Callers never
  /// mutate the tab state directly, so Review opens and tab clicks also update
  /// the path field, tree selection, and active Workbench tool together.
  func activateFileTab(_ id: UUID) {
    guard let tab = fileTabs.tab(withID: id) else { return }
    fileTabs.activate(id: id)
    pathInput = access?.displayPath(for: tab.url) ?? tab.url.path
    selectedTreeURL = tab.url
    selectedTreeIsDirectory = false
    openTool(.files)
  }

  /// Persist the latest in-memory dirty buffers without waiting for the normal
  /// debounce. The journal serializes concurrent debounce writes under its
  /// lock and replaces deterministic owner-only records atomically.
  func flushRecoveryDrafts() async -> String? {
    let writes = fileTabs.tabs.filter(\.isDirty).map { tab in
      let record = recoveryDraftRecord(for: tab)
      return (record, nextDraftMutationSequence(for: record.id))
    }
    guard !writes.isEmpty else { return nil }
    var firstError: String?
    for (record, mutationSequence) in writes {
      if let error = await draftWriter.writeImmediately(
        record,
        mutationSequence: mutationSequence
      ), firstError == nil {
        firstError = error
      }
    }
    return firstError
  }

  func restoreRecoveryDraft(_ record: NativeWorkbenchDraftRecord) {
    let url = URL(fileURLWithPath: record.filePath)
    guard FileManager.default.fileExists(atPath: url.path) else {
      editorStatus = .fileNotExists(url.lastPathComponent)
      return
    }
    let restoredID = fileTabs.openRecoveredTab(
      url: url,
      savedBaseline: record.savedBaseline,
      draftText: record.draftText
    )
    activateFileTab(restoredID)
    recoverySheetPresented = false
  }

  func discardRecoveryDraft(_ record: NativeWorkbenchDraftRecord) {
    let fileURL = URL(fileURLWithPath: record.filePath)
    let mutationSequence = nextDraftMutationSequence(for: record.id)
    Task { [weak self] in
      guard let self else { return }
      if let error = await draftWriter.clear(
        workspaceRoot: rootURL,
        fileURL: fileURL,
        mutationSequence: mutationSequence
      ) {
        editorStatus = .saveFailed(error)
        return
      }
      recoveryDrafts.removeAll { $0.id == record.id }
      if recoveryDrafts.isEmpty { recoverySheetPresented = false }
    }
  }

  func dismissRecoverySheet() {
    recoverySheetPresented = false
  }

  private func loadRecoveryDrafts() {
    do {
      recoveryDrafts = try draftJournal.load(workspaceRoot: rootURL)
      recoverySheetPresented = false
      guard !recoveryDrafts.isEmpty else { return }
      // `onAppear` runs during the hosting transaction. Present on the next
      // main runloop turn, after Workbench belongs to a window, so AppKit does
      // not discard the initial recovery sheet request.
      DispatchQueue.main.async { [weak self] in
        guard let self, !recoveryDrafts.isEmpty else { return }
        recoverySheetPresented = true
      }
    } catch {
      editorStatus = .saveFailed(error.localizedDescription)
    }
  }

  private func scheduleRecoveryDraft(for tab: NativeFileTabState) {
    let record = recoveryDraftRecord(for: tab)
    let mutationSequence = nextDraftMutationSequence(for: record.id)
    Task { [weak self] in
      guard let self else { return }
      if let error = await draftWriter.schedule(record, mutationSequence: mutationSequence) {
        editorStatus = .saveFailed(error)
      }
    }
  }

  private func recoveryDraftRecord(for tab: NativeFileTabState) -> NativeWorkbenchDraftRecord {
    NativeWorkbenchDraftRecord(
      workspaceRoot: rootURL.path,
      filePath: tab.canonicalPath,
      savedBaseline: tab.savedBaseline,
      draftText: tab.text
    )
  }

  private func clearRecoveryDraft(for tab: NativeFileTabState) {
    let record = recoveryDraftRecord(for: tab)
    let mutationSequence = nextDraftMutationSequence(for: record.id)
    Task { [weak self] in
      guard let self else { return }
      if let error = await draftWriter.clear(
        workspaceRoot: rootURL,
        fileURL: tab.url,
        mutationSequence: mutationSequence
      ) {
        editorStatus = .saveFailed(error)
      }
      recoveryDrafts.removeAll { $0.filePath == tab.canonicalPath }
    }
  }

  private func nextDraftMutationSequence(for recordID: String) -> UInt64 {
    let sequence = (draftMutationSequenceByID[recordID] ?? 0) &+ 1
    draftMutationSequenceByID[recordID] = sequence
    return sequence
  }

  func refreshTree() {
    guard access != nil else { return }
    treeRefreshGeneration &+= 1
    let generation = treeRefreshGeneration
    treeIsLoading = true
    treeLoadError = nil
    Task { [weak self] in
      guard let self else { return }
      await refreshTreeFromOwner(generation: generation)
      let query = fileSearchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
      if !query.isEmpty { scheduleFileSearch(query) }
    }
  }

  func selectTreeNode(_ node: NativeFileNode) {
    selectedTreeURL = node.url
    selectedTreeIsDirectory = node.isDirectory
  }

  func toggleHiddenNoise() {
    showHiddenNoise.toggle()
    refreshTree()
  }

  func promptCreateFile(language: ArkLanguagePreference) {
    guard let access else { return }
    let targetDirectory = mutationDirectoryURL
    guard let name = requestName(
            title: language == .en ? "New File" : "新建文件",
            message: language == .en ? "Enter a file name." : "输入文件名。",
            defaultValue: "untitled.txt",
            language: language
          ) else { return }
    do {
      let url = try access.createFile(named: name, in: targetDirectory)
      refreshTree()
      Task { await selectFile(url) }
    } catch {
      editorStatus = .saveFailed(error.localizedDescription)
    }
  }

  func promptCreateFolder(language: ArkLanguagePreference) {
    guard let access else { return }
    let targetDirectory = mutationDirectoryURL
    guard let name = requestName(
            title: language == .en ? "New Folder" : "新建文件夹",
            message: language == .en ? "Enter a folder name." : "输入文件夹名称。",
            defaultValue: language == .en ? "New Folder" : "新建文件夹",
            language: language
          ) else { return }
    do {
      selectedTreeURL = try access.createFolder(named: name, in: targetDirectory)
      selectedTreeIsDirectory = true
      refreshTree()
    } catch {
      editorStatus = .saveFailed(error.localizedDescription)
    }
  }

  func promptRenameSelected(language: ArkLanguagePreference) {
    guard let access, let selectedTreeURL, canMutateSelectedTreeItem else { return }
    guard !hasOpenTab(atOrBelow: selectedTreeURL) else {
      editorStatus = .saveFailed(closeOpenItemMessage(language))
      return
    }
    guard let name = requestName(
      title: language == .en ? "Rename" : "重命名",
      message: language == .en ? "Enter a new name." : "输入新名称。",
      defaultValue: selectedTreeURL.lastPathComponent,
      language: language
    ) else { return }
    do {
      self.selectedTreeURL = try access.renameItem(selectedTreeURL, to: name)
      refreshTree()
    } catch {
      editorStatus = .saveFailed(error.localizedDescription)
    }
  }

  func duplicateSelectedTreeItem() {
    guard access != nil,
          let selectedTreeURL,
          canMutateSelectedTreeItem,
          fileMutationTask == nil
    else { return }
    fileMutationGeneration &+= 1
    let generation = fileMutationGeneration
    let rootURL = rootURL
    let sourceIdentity = NativeFileTabState.canonicalPath(for: selectedTreeURL)
    let sourceWasDirectory = selectedTreeIsDirectory
    fileMutationIsRunning = true
    let worker = Task.detached(priority: .userInitiated) {
      let workerAccess = try NativeWorkspaceAccess(rootURL: rootURL)
      return try workerAccess.duplicateItem(selectedTreeURL)
    }
    fileMutationTask = Task { @MainActor [weak self] in
      let result: Result<URL, Error>
      do {
        result = .success(try await withTaskCancellationHandler {
          try await worker.value
        } onCancel: {
          worker.cancel()
        })
      } catch {
        result = .failure(error)
      }
      guard let self, self.fileMutationGeneration == generation else { return }
      self.fileMutationTask = nil
      self.fileMutationIsRunning = false
      switch result {
      case .success(let duplicate):
        if self.selectedTreeURL.map(NativeFileTabState.canonicalPath(for:)) == sourceIdentity {
          self.selectedTreeURL = duplicate
          self.selectedTreeIsDirectory = sourceWasDirectory
        }
        self.refreshTree()
      case .failure(let error):
        guard !(error is CancellationError) else { return }
        self.editorStatus = .saveFailed(error.localizedDescription)
      }
    }
  }

  func promptMoveSelected(language: ArkLanguagePreference) {
    guard let access, let selectedTreeURL, canMutateSelectedTreeItem else { return }
    guard !hasOpenTab(atOrBelow: selectedTreeURL) else {
      editorStatus = .saveFailed(closeOpenItemMessage(language))
      return
    }
    let panel = NSOpenPanel()
    panel.canChooseFiles = false
    panel.canChooseDirectories = true
    panel.allowsMultipleSelection = false
    panel.directoryURL = rootURL
    panel.prompt = language == .en ? "Move" : "移动"
    guard panel.runModal() == .OK, let directory = panel.url else { return }
    do {
      self.selectedTreeURL = try access.moveItem(selectedTreeURL, to: directory)
      refreshTree()
    } catch {
      editorStatus = .saveFailed(error.localizedDescription)
    }
  }

  func promptTrashSelected(language: ArkLanguagePreference) {
    guard access != nil, let selectedTreeURL, canMutateSelectedTreeItem else { return }
    guard !hasOpenTab(atOrBelow: selectedTreeURL) else {
      editorStatus = .saveFailed(closeOpenItemMessage(language))
      return
    }
    let alert = NSAlert()
    alert.alertStyle = .warning
    alert.messageText = language == .en ? "Move to Trash?" : "移到废纸篓？"
    alert.informativeText = selectedTreeURL.lastPathComponent
    alert.addButton(withTitle: language == .en ? "Move to Trash" : "移到废纸篓")
    alert.addButton(withTitle: language == .en ? "Cancel" : "取消")
    guard alert.runModal() == .alertFirstButtonReturn else { return }
    startTrashMutation(selectedTreeURL) { model in
      model.selectedTreeURL = nil
      model.selectedTreeIsDirectory = false
      model.refreshTree()
    }
  }

  private func startTrashMutation(
    _ targetURL: URL,
    onSuccess: @escaping @MainActor (NativeWorkbenchModel) -> Void,
    onFailure: (@MainActor (NativeWorkbenchModel, Error) -> Void)? = nil
  ) {
    guard access != nil, fileMutationTask == nil else { return }
    fileMutationGeneration &+= 1
    let generation = fileMutationGeneration
    let rootURL = rootURL
    fileMutationIsRunning = true
    let worker = Task.detached(priority: .userInitiated) {
      let workerAccess = try NativeWorkspaceAccess(rootURL: rootURL)
      try workerAccess.trashItem(targetURL)
    }
    fileMutationTask = Task { @MainActor [weak self] in
      let result: Result<Void, Error>
      do {
        result = .success(try await withTaskCancellationHandler {
          try await worker.value
        } onCancel: {
          worker.cancel()
        })
      } catch {
        result = .failure(error)
      }
      guard let self, self.fileMutationGeneration == generation else { return }
      self.fileMutationTask = nil
      self.fileMutationIsRunning = false
      switch result {
      case .success:
        onSuccess(self)
      case .failure(let error):
        guard !(error is CancellationError) else { return }
        if let onFailure {
          onFailure(self, error)
        } else {
          self.editorStatus = .saveFailed(error.localizedDescription)
        }
      }
    }
  }

  private var mutationDirectoryURL: URL {
    guard let selectedTreeURL else { return rootURL }
    return selectedTreeIsDirectory ? selectedTreeURL : selectedTreeURL.deletingLastPathComponent()
  }

  private func hasOpenTab(atOrBelow url: URL) -> Bool {
    let path = NativeFileTabState.canonicalPath(for: url)
    let prefix = path + "/"
    return fileTabs.tabs.contains { $0.canonicalPath == path || $0.canonicalPath.hasPrefix(prefix) }
  }

  private func closeOpenItemMessage(_ language: ArkLanguagePreference) -> String {
    language == .en
      ? "Close open files inside this item before changing it."
      : "请先关闭此项目内已打开的文件"
  }

  private func requestName(
    title: String,
    message: String,
    defaultValue: String,
    language: ArkLanguagePreference
  ) -> String? {
    let alert = NSAlert()
    alert.messageText = title
    alert.informativeText = message
    let field = NSTextField(string: defaultValue)
    field.frame = NSRect(x: 0, y: 0, width: 320, height: 24)
    alert.accessoryView = field
    alert.addButton(withTitle: language == .en ? "OK" : "确定")
    alert.addButton(withTitle: language == .en ? "Cancel" : "取消")
    guard alert.runModal() == .alertFirstButtonReturn else { return nil }
    let value = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    return value.isEmpty ? nil : value
  }

  func scheduleFileSearch(_ rawQuery: String) {
    fileSearchTask?.cancel()
    fileSearchTask = nil
    fileSearchGeneration &+= 1
    let generation = fileSearchGeneration
    let query = rawQuery.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !query.isEmpty else {
      fileSearchResults = nil
      fileSearchIsLoading = false
      fileTreeRevision &+= 1
      return
    }

    fileSearchResults = []
    fileSearchIsLoading = true
    fileTreeRevision &+= 1
    let rootURL = rootURL
    fileSearchTask = Task { @MainActor [weak self] in
      let result: Result<[URL], Error>
      do {
        try await Task.sleep(nanoseconds: 160_000_000)
        let worker = Task.detached(priority: .userInitiated) {
          let searchAccess = try NativeWorkspaceAccess(rootURL: rootURL)
          return try searchAccess.searchFileNames(matching: query)
        }
        result = .success(try await withTaskCancellationHandler {
          try await worker.value
        } onCancel: {
          worker.cancel()
        })
      } catch {
        result = .failure(error)
      }
      guard let self, self.fileSearchGeneration == generation else { return }
      self.fileSearchTask = nil
      switch result {
      case .success(let urls):
        self.fileSearchResults = urls.map { url in
          NativeFileNode(
            name: self.access?.displayPath(for: url) ?? url.lastPathComponent,
            url: url,
            isDirectory: false
          )
        }
      case .failure(let error):
        if !(error is CancellationError) {
          self.fileSearchResults = []
          self.editorStatus = .refreshFailed(error.localizedDescription)
        }
      }
      self.fileSearchIsLoading = false
      self.fileTreeRevision &+= 1
    }
  }

  func openEnteredPath() {
    let raw = pathInput.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !raw.isEmpty else { return }
    let target = raw.hasPrefix("/")
      ? URL(fileURLWithPath: raw)
      : rootURL.appendingPathComponent(raw)
    var isDirectory: ObjCBool = false
    guard FileManager.default.fileExists(atPath: target.path, isDirectory: &isDirectory) else {
      editorStatus = .fileNotExists(raw)
      return
    }
    if isDirectory.boolValue {
      editorStatus = .directorySelected
      return
    }
    Task { await self.selectFile(target) }
  }

  func loadChildren(of node: NativeFileNode) {
    guard node.isDirectory,
          node.children == nil,
          !node.isLoadingChildren
    else { return }
    node.isLoadingChildren = true
    Task {
      defer { node.isLoadingChildren = false }
      do {
        node.children = try await directoryNodes(at: node.url)
      } catch {
        node.children = []
        editorStatus = .readFailed(name: node.name, reason: error.localizedDescription)
      }
      fileTreeRevision &+= 1
    }
  }

  /// 点击文件：已打开（含 dirty）只激活，不重新读盘；未打开才读。
  /// 读期间的双击竞争由 openFile 的 post-await dedupe 收敛。
  func selectFile(_ url: URL) async {
    fileSelectionGeneration &+= 1
    let selectionGeneration = fileSelectionGeneration
    let canonical = NativeFileTabState.canonicalPath(for: url)
    if let index = fileTabs.indexOf(canonicalPath: canonical) {
      let existing = fileTabs.tabs[index]
      activateFileTab(existing.id)
      guard !existing.isDirty else { return }
      do {
        let currentText = try await readFileText(url)
        if currentText != existing.savedBaseline {
          fileTabs.replaceCleanTabFromDisk(id: existing.id, text: currentText)
          if selectionGeneration == fileSelectionGeneration {
            editorStatus = .loaded(access?.displayPath(for: url) ?? url.path)
          }
        }
      } catch {
        if selectionGeneration == fileSelectionGeneration {
          editorStatus = .openFailed(error.localizedDescription)
        }
      }
      return
    }
    await openFile(url, selectionGeneration: selectionGeneration)
  }

  /// 原生「导出副本」：NSSavePanel 选择目标位置，导出当前编辑内容；
  /// 用户取消面板属正常取消（不设任何错误状态），源文件不被修改。
  func exportSelectedFile() {
    guard let active = fileTabs.activeTab else { return }
    let panel = NSSavePanel()
    panel.nameFieldStringValue = active.url.lastPathComponent
    panel.canCreateDirectories = true
    guard panel.runModal() == .OK, let destination = panel.url else { return }
    do {
      try active.text.write(to: destination, atomically: true, encoding: .utf8)
      editorStatus = .exportSucceeded(destination.lastPathComponent)
    } catch {
      editorStatus = .exportFailed(error.localizedDescription)
    }
  }

  func revertEditor() {
    guard let activeID = fileTabs.activeTabID,
          let active = fileTabs.tab(withID: activeID)
    else { return }
    fileTabs.revert(id: activeID)
    clearRecoveryDraft(for: active)
    editorStatus = .reverted
  }

  func saveEditor() {
    guard let active = fileTabs.activeTab,
          access != nil,
          !savingFileTabIDs.contains(active.id)
    else { return }
    let savedID = active.id
    let savedText = active.text
    let expectedText = active.savedBaseline
    let savedURL = active.url
    let rootURL = rootURL
    let generation = (saveGenerationByTabID[savedID] ?? 0) &+ 1
    saveGenerationByTabID[savedID] = generation
    savingFileTabIDs.insert(savedID)
    let worker = Task.detached(priority: .userInitiated) {
      let workerAccess = try NativeWorkspaceAccess(rootURL: rootURL)
      try workerAccess.atomicWrite(savedText, to: savedURL, expectedText: expectedText)
    }
    saveTasks[savedID] = Task { @MainActor [weak self] in
      let result: Result<Void, Error>
      do {
        result = .success(try await withTaskCancellationHandler {
          try await worker.value
        } onCancel: {
          worker.cancel()
        })
      } catch {
        result = .failure(error)
      }
      guard let self, self.saveGenerationByTabID[savedID] == generation else { return }
      self.saveTasks[savedID] = nil
      self.saveGenerationByTabID[savedID] = nil
      self.savingFileTabIDs.remove(savedID)
      switch result {
      case .success:
        self.fileTabs.markSaved(id: savedID, text: savedText)
        if let current = self.fileTabs.tab(withID: savedID) {
          if current.text == savedText {
            self.clearRecoveryDraft(for: current)
          } else {
            self.scheduleRecoveryDraft(for: current)
          }
        }
        self.editorStatus = .saved(Date().formatted(date: .omitted, time: .standard))
      case .failure(let error):
        guard !(error is CancellationError) else { return }
        self.editorStatus = .saveFailed(error.localizedDescription)
      }
    }
  }

  /// 单 Tab 关闭：clean 立即关；dirty 记 pending 由视图弹确认。
  func requestCloseTab(id: UUID) {
    fileTabs.requestClose(id: id)
  }

  func requestCloseActiveTab() {
    guard let id = fileTabs.activeTabID else { return }
    requestCloseTab(id: id)
  }

  func revealSelectedFile() {
    guard let url = activeFileTab?.url else { return }
    NSWorkspace.shared.activateFileViewerSelecting([url])
  }

  func cancelCloseTab() {
    fileTabs.cancelClose()
  }

  func discardCloseTab() {
    let discarded = fileTabs.pendingCloseTabID.flatMap { fileTabs.tab(withID: $0) }
    fileTabs.discardClose()
    if let discarded { clearRecoveryDraft(for: discarded) }
  }

  /// 工作台级破坏性关闭守卫。
  func requestWorkbenchClose() -> Bool {
    pendingDirtyToolCloseID = nil
    return fileTabs.requestWorkbenchClose()
  }

  func cancelWorkbenchClose() {
    pendingDirtyToolCloseID = nil
    fileTabs.cancelWorkbenchClose()
  }

  /// Returns true when the whole Workbench should close; false when only the
  /// pending Files tool tab was discarded.
  func confirmDiscardDirtyClosure() -> Bool {
    let pendingToolID = pendingDirtyToolCloseID
    let discardedTabs = fileTabs.tabs.filter(\.isDirty)
    fileTabs.confirmDiscardWorkbenchClose()
    discardedTabs.forEach(clearRecoveryDraft)
    pendingDirtyToolCloseID = nil
    guard let pendingToolID else { return true }
    toolTabs.close(pendingToolID)
    return false
  }

  func openTool(_ kind: NativeWorkbenchTabKind) {
    toolTabs.open(kind)
  }

  func activateToolTab(_ id: String) {
    toolTabs.activate(id)
  }

  func requestToolTabClose(_ id: String) {
    guard let tab = toolTabs.tabs.first(where: { $0.id == id }) else { return }
    if tab.kind == .files, fileTabs.hasDirtyTabs {
      pendingDirtyToolCloseID = id
      _ = fileTabs.requestWorkbenchClose()
      return
    }
    if tab.kind == .browser {
      browserSessions.removeValue(forKey: id)?.cancel()
    }
    if tab.kind == .terminal {
      guard !terminalShutdownIDs.contains(id) else { return }
      guard let session = terminalSessions[id] else {
        toolTabs.close(id)
        return
      }
      terminalShutdownIDs.insert(id)
      Task { [weak self, session] in
        _ = await session.shutdown()
        guard let self else { return }
        if terminalSessions[id].map({ $0 === session }) == true {
          terminalSessions.removeValue(forKey: id)
        }
        terminalShutdownIDs.remove(id)
        toolTabs.close(id)
      }
      return
    }
    toolTabs.close(id)
  }

  func shutdownTerminalSessions() async {
    let sessions = Array(terminalSessions.values)
    for session in sessions {
      _ = await session.shutdown()
    }
    terminalSessions.removeAll()
    terminalShutdownIDs.removeAll()
  }

  func cancelBrowserRequests() {
    for session in browserSessions.values { session.cancel() }
  }

  func cancelFileOperations() {
    fileSearchTask?.cancel()
    fileMutationTask?.cancel()
    for task in saveTasks.values { task.cancel() }
  }

  func disposeBrowserSessions() {
    cancelBrowserRequests()
    browserSessions.removeAll()
  }

  func browserSession(for tabID: String) -> NativeWorkbenchBrowserSession {
    if let existing = browserSessions[tabID] { return existing }
    let session = NativeWorkbenchBrowserSession(reader: injectedWebReader)
    browserSessions[tabID] = session
    return session
  }

  func terminalSession(for tabID: String) -> NativePTYTerminalSession {
    if let existing = terminalSessions[tabID] { return existing }
    let session = NativePTYTerminalSession(rootURL: rootURL)
    terminalSessions[tabID] = session
    return session
  }

  func refreshGitIfNeeded() {
    guard !didLoadGit else { return }
    refreshGit()
  }

  func refreshGit() {
    guard !gitIsLoading, let access else { return }
    gitRefreshCancellation?.cancel()
    let cancellation = NativeProcessCancellation()
    gitRefreshCancellation = cancellation
    didLoadGit = true
    gitIsLoading = true
    gitMessage = .gitLoading
    let rootURL = access.rootURL
    DispatchQueue.global(qos: .userInitiated).async {
      let prefix = ["--no-pager", "-c", "core.quotepath=false", "-C", rootURL.path]
      let status = NativeProcessCapture.run(
        executableURL: URL(fileURLWithPath: "/usr/bin/git"),
        arguments: prefix + ["status", "--short", "--branch", "--untracked-files=all"],
        currentDirectoryURL: rootURL,
        cancellation: cancellation
      )
      guard status.exitCode == 0 else {
        DispatchQueue.main.async { [weak self] in
          guard let self, self.gitRefreshCancellation === cancellation else { return }
          self.gitRefreshCancellation = nil
          self.gitStatus = ""
          self.gitIsRepository = false
          self.gitWorkingDiff = ""
          self.gitStagedDiff = ""
          self.selectedGitPath = nil
          self.selectedGitDiff = ""
          self.gitDiffIsLoading = false
          self.gitHistory = []
          self.selectedGitCommitID = nil
          self.selectedGitCommitDetail = ""
          self.gitCommitChanges = []
          self.selectedGitCommitPath = nil
          self.selectedGitCommitPatch = ""
          self.gitCommitDiffIsLoading = false
          self.gitBranches = []
          self.gitRemotes = []
          self.gitUpstreamName = ""
          self.gitAheadCount = 0
          self.gitBehindCount = 0
          self.gitMessage = .gitRefreshFailed(String(status.exitCode))
          self.gitSuccessAfterRefresh = nil
          self.selectLatestGitCommitAfterRefresh = false
          self.gitIsLoading = false
        }
        return
      }
      let working = NativeProcessCapture.run(
        executableURL: URL(fileURLWithPath: "/usr/bin/git"),
        arguments: prefix + ["diff", "--no-ext-diff", "--color=never", "--"],
        currentDirectoryURL: rootURL,
        cancellation: cancellation
      )
      let staged = NativeProcessCapture.run(
        executableURL: URL(fileURLWithPath: "/usr/bin/git"),
        arguments: prefix + ["diff", "--cached", "--no-ext-diff", "--color=never", "--"],
        currentDirectoryURL: rootURL,
        cancellation: cancellation
      )
      let branches = NativeProcessCapture.run(
        executableURL: URL(fileURLWithPath: "/usr/bin/git"),
        arguments: prefix + [
          "for-each-ref",
          "--format=%(HEAD)%09%(refname:short)",
          "refs/heads",
        ],
        currentDirectoryURL: rootURL,
        cancellation: cancellation
      )
      let history = NativeProcessCapture.run(
        executableURL: URL(fileURLWithPath: "/usr/bin/git"),
        arguments: prefix + [
          "log",
          "-n", "100",
          "--date=iso-strict",
          "--format=%H%x09%h%x09%an%x09%ad%x09%s",
        ],
        currentDirectoryURL: rootURL,
        cancellation: cancellation
      )
      if let failure = [working, staged, branches, history].first(where: { $0.stopReason != nil }) {
        DispatchQueue.main.async { [weak self] in
          guard let self, self.gitRefreshCancellation === cancellation else { return }
          self.gitRefreshCancellation = nil
          self.gitIsLoading = false
          self.gitMessage = .gitRefreshFailed(
            failure.output.trimmingCharacters(in: .whitespacesAndNewlines)
          )
        }
        return
      }
      let identityName = NativeProcessCapture.run(
        executableURL: URL(fileURLWithPath: "/usr/bin/git"),
        arguments: prefix + ["config", "--get", "user.name"],
        currentDirectoryURL: rootURL,
        cancellation: cancellation
      )
      let identityEmail = NativeProcessCapture.run(
        executableURL: URL(fileURLWithPath: "/usr/bin/git"),
        arguments: prefix + ["config", "--get", "user.email"],
        currentDirectoryURL: rootURL,
        cancellation: cancellation
      )
      let upstream = NativeProcessCapture.run(
        executableURL: URL(fileURLWithPath: "/usr/bin/git"),
        arguments: prefix + [
          "rev-parse",
          "--abbrev-ref",
          "--symbolic-full-name",
          "@{upstream}",
        ],
        currentDirectoryURL: rootURL,
        cancellation: cancellation
      )
      let aheadBehind = upstream.exitCode == 0
        ? NativeProcessCapture.run(
          executableURL: URL(fileURLWithPath: "/usr/bin/git"),
          arguments: prefix + [
            "rev-list",
            "--left-right",
            "--count",
            "HEAD...@{upstream}",
          ],
          currentDirectoryURL: rootURL,
          cancellation: cancellation
        )
        : NativeProcessCapture(output: "", exitCode: upstream.exitCode)
      let remoteNames = NativeProcessCapture.run(
        executableURL: URL(fileURLWithPath: "/usr/bin/git"),
        arguments: prefix + ["remote"],
        currentDirectoryURL: rootURL,
        cancellation: cancellation
      )
      let remotes = remoteNames.output
        .split(separator: "\n", omittingEmptySubsequences: true)
        .map(String.init)
        .filter { !$0.isEmpty && !$0.hasPrefix("-") }
        .map { name in
          let fetch = NativeProcessCapture.run(
            executableURL: URL(fileURLWithPath: "/usr/bin/git"),
            arguments: prefix + ["remote", "get-url", "--", name],
            currentDirectoryURL: rootURL,
            cancellation: cancellation
          )
          let push = NativeProcessCapture.run(
            executableURL: URL(fileURLWithPath: "/usr/bin/git"),
            arguments: prefix + ["remote", "get-url", "--push", "--", name],
            currentDirectoryURL: rootURL,
            cancellation: cancellation
          )
          return NativeGitRemote(
            name: name,
            fetchURL: fetch.output.trimmingCharacters(in: .whitespacesAndNewlines),
            pushURL: push.output.trimmingCharacters(in: .whitespacesAndNewlines)
          )
        }
      DispatchQueue.main.async { [weak self] in
        guard let self, self.gitRefreshCancellation === cancellation else { return }
        self.gitRefreshCancellation = nil
        self.gitIsRepository = true
        self.gitStatus = status.output
        self.gitWorkingDiff = working.output
        self.gitStagedDiff = staged.output
        self.gitBranches = branches.output
          .split(separator: "\n", omittingEmptySubsequences: true)
          .compactMap(NativeGitBranch.init(line:))
        self.gitHistory = history.output
          .split(separator: "\n", omittingEmptySubsequences: true)
          .compactMap(NativeGitCommit.init(line:))
        self.gitRepositoryIdentityName = identityName.output
          .trimmingCharacters(in: .whitespacesAndNewlines)
        self.gitRepositoryIdentityEmail = identityEmail.output
          .trimmingCharacters(in: .whitespacesAndNewlines)
        if self.gitIdentityNameInput.isEmpty {
          self.gitIdentityNameInput = self.gitRepositoryIdentityName
        }
        if self.gitIdentityEmailInput.isEmpty {
          self.gitIdentityEmailInput = self.gitRepositoryIdentityEmail
        }
        self.gitUpstreamName = upstream.exitCode == 0
          ? upstream.output.trimmingCharacters(in: .whitespacesAndNewlines)
          : ""
        let counts = aheadBehind.output
          .split(whereSeparator: { $0.isWhitespace })
          .compactMap { Int($0) }
        self.gitAheadCount = counts.first ?? 0
        self.gitBehindCount = counts.dropFirst().first ?? 0
        self.gitRemotes = remotes
        if self.gitRemoteURLInput.isEmpty,
           let preferred = remotes.first(where: { $0.name == self.gitRemoteNameInput })
              ?? remotes.first,
           !preferred.hasEmbeddedHTTPCredentials {
          self.gitRemoteNameInput = preferred.name
          self.gitRemoteURLInput = preferred.fetchURL
        }
        self.gitMessage = self.gitSuccessAfterRefresh.map(NativeWorkbenchStatus.gitOperationSucceeded)
          ?? .gitRefreshed
        self.gitSuccessAfterRefresh = nil
        self.gitIsLoading = false
        let selectedStillExists = self.selectedGitPath.map { path in
          self.gitChanges.contains { $0.path == path }
        } ?? false
        if !selectedStillExists { self.selectedGitPath = self.gitChanges.first?.path }
        if self.selectLatestGitCommitAfterRefresh {
          self.selectedGitCommitID = self.gitHistory.first?.id
          self.selectedGitCommitPath = nil
          self.selectedGitCommitPatch = ""
          self.selectLatestGitCommitAfterRefresh = false
        } else {
          let selectedCommitExists = self.selectedGitCommitID.map { selectedID in
            self.gitHistory.contains { $0.id == selectedID }
          } ?? false
          if !selectedCommitExists { self.selectedGitCommitID = self.gitHistory.first?.id }
        }
        self.refreshSelectedGitDiff()
        self.refreshSelectedGitCommit()
      }
    }
  }

  func selectGitChange(_ change: NativeGitChange) {
    guard selectedGitPath != change.path || selectedGitDiff.isEmpty else { return }
    selectedGitPath = change.path
    refreshSelectedGitDiff()
  }

  func setGitDiffScope(_ scope: NativeGitDiffScope) {
    guard gitDiffScope != scope else { return }
    gitDiffScope = scope
    refreshSelectedGitDiff()
  }

  func stageSelectedGitChange() {
    guard let change = selectedGitChange, !change.hasConflict else { return }
    performGitOperation(
      arguments: ["add", "--", change.path],
      success: "Staged \(change.path)"
    )
  }

  func unstageSelectedGitChange() {
    guard let change = selectedGitChange, change.hasStagedChange, !change.hasConflict else { return }
    performGitOperation(
      arguments: ["restore", "--staged", "--", change.path],
      success: "Unstaged \(change.path)"
    )
  }

  func stageAllGitChanges() {
    performGitOperation(arguments: ["add", "-A", "--", "."], success: "Staged all changes")
  }

  func unstageAllGitChanges() {
    performGitOperation(
      arguments: ["restore", "--staged", "--", "."],
      success: "Unstaged all changes"
    )
  }

  func commitStagedGitChanges() {
    let message = gitCommitMessage.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !message.isEmpty, hasStagedGitChanges, !gitIsLoading else { return }
    if performGitOperation(
      arguments: ["commit", "-m", message],
      success: "Commit created",
      selectsLatestCommitAfterRefresh: true
    ) {
      gitCommitMessage = ""
    }
  }

  func requestDiscardSelectedGitChange() {
    guard let change = selectedGitChange,
          change.hasWorkingChange,
          !change.hasConflict
    else { return }
    let target = rootURL.appendingPathComponent(change.path).standardizedFileURL
    let canonical = NativeFileTabState.canonicalPath(for: target)
    guard !fileTabs.tabs.contains(where: { $0.canonicalPath == canonical && $0.isDirty }) else {
      gitMessage = .gitOperationFailed("Close or save the dirty Files tab first.")
      return
    }
    pendingGitDiscard = change
  }

  func cancelGitDiscard() {
    pendingGitDiscard = nil
  }

  func confirmGitDiscard() {
    guard let change = pendingGitDiscard else { return }
    guard !fileMutationIsRunning else {
      pendingGitDiscard = nil
      gitMessage = .gitOperationFailed("Wait for the current Files operation to finish.")
      return
    }
    pendingGitDiscard = nil
    if change.isUntracked {
      let target = rootURL.appendingPathComponent(change.path)
      startTrashMutation(target) { model in
        model.gitSuccessAfterRefresh = "Moved \(change.path) to Trash"
        model.refreshTree()
        model.didLoadGit = false
        model.refreshGit()
      } onFailure: { model, error in
        model.gitMessage = .gitOperationFailed(error.localizedDescription)
      }
      return
    }
    performGitOperation(
      arguments: ["restore", "--worktree", "--", change.path],
      success: "Discarded working change in \(change.path)"
    )
  }

  func selectGitCommit(_ commit: NativeGitCommit) {
    guard selectedGitCommitID != commit.id || selectedGitCommitDetail.isEmpty else { return }
    selectedGitCommitID = commit.id
    refreshSelectedGitCommit()
  }

  func selectGitCommitChange(_ change: NativeGitChange) {
    guard selectedGitCommitPath != change.path || selectedGitCommitPatch.isEmpty else { return }
    selectedGitCommitPath = change.path
    refreshSelectedGitCommitDiff()
  }

  func createGitBranch() {
    let name = gitNewBranchName.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !gitIsLoading else { return }
    guard !name.isEmpty,
          !name.hasPrefix("-"),
          !fileTabs.hasDirtyTabs
    else {
      gitMessage = .gitOperationFailed("Close or save dirty Files tabs before switching branches.")
      return
    }
    if performGitOperation(
      arguments: ["switch", "-c", name],
      success: "Created and switched to \(name)",
      resetsFileTabs: true
    ) {
      gitNewBranchName = ""
    }
  }

  func switchGitBranch(_ branch: NativeGitBranch) {
    guard !branch.isCurrent, !branch.name.hasPrefix("-"), !fileTabs.hasDirtyTabs else { return }
    performGitOperation(
      arguments: ["switch", "--", branch.name],
      success: "Switched to \(branch.name)",
      resetsFileTabs: true
    )
  }

  /// Clear Files tabs after a worktree-changing Git operation only when the
  /// user-visible editor state is still the clean snapshot captured at launch.
  /// A tab opened, selected, or edited while Git runs belongs to the user and
  /// must survive the operation's asynchronous success callback.
  @discardableResult
  func resetFileTabsAfterGitOperation(startedWith snapshot: NativeFileTabsState) -> Bool {
    guard !snapshot.hasDirtyTabs, !fileTabs.hasDirtyTabs, fileTabs == snapshot else { return false }
    fileTabs = NativeFileTabsState()
    return true
  }

  func prepareGitRemote(_ remote: NativeGitRemote) {
    gitRemoteNameInput = remote.name
    gitRemoteURLInput = remote.hasEmbeddedHTTPCredentials ? "" : remote.fetchURL
  }

  func initializeGitRepository() {
    guard !gitIsRepository else { return }
    performGitOperation(
      arguments: ["init"],
      success: "Git repository initialized"
    )
  }

  func saveGitRepositoryIdentity() {
    let name = gitIdentityNameInput.trimmingCharacters(in: .whitespacesAndNewlines)
    let email = gitIdentityEmailInput.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !name.isEmpty,
          !email.isEmpty,
          email.contains("@"),
          !name.contains("\n"),
          !name.contains("\r"),
          !email.contains("\n"),
          !email.contains("\r")
    else {
      gitMessage = .gitOperationFailed("Enter a valid repository name and email.")
      return
    }
    performGitOperationSequence(
      operations: [
        ["config", "--local", "user.name", name],
        ["config", "--local", "user.email", email],
      ],
      success: "Repository commit identity updated"
    )
  }

  func saveGitRemoteConnection() {
    let name = gitRemoteNameInput.trimmingCharacters(in: .whitespacesAndNewlines)
    let rawURL = gitRemoteURLInput.trimmingCharacters(in: .whitespacesAndNewlines)
    guard name.range(
      of: #"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$"#,
      options: .regularExpression
    ) != nil,
      let remoteURL = validatedGitRemoteURL(rawURL)
    else {
      gitMessage = .gitOperationFailed(
        "Use a valid remote name and an HTTPS or SSH URL without embedded credentials."
      )
      return
    }
    let operation = gitRemotes.contains(where: { $0.name == name })
      ? ["remote", "set-url", "--", name, remoteURL]
      : ["remote", "add", "--", name, remoteURL]
    performGitOperation(
      arguments: operation,
      success: "Remote \(name) connected"
    )
  }

  private func validatedGitRemoteURL(_ raw: String) -> String? {
    guard !raw.isEmpty,
          raw.utf8.count <= 4096,
          !raw.hasPrefix("-"),
          !raw.contains("\n"),
          !raw.contains("\r")
    else { return nil }
    if let components = URLComponents(string: raw),
       let scheme = components.scheme?.lowercased(),
       ["https", "http", "ssh"].contains(scheme) {
      guard components.host?.isEmpty == false else { return nil }
      if ["https", "http"].contains(scheme),
         components.user != nil || components.password != nil {
        return nil
      }
      guard components.password == nil else { return nil }
      return raw
    }
    if raw.range(
      of: #"^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:.+$"#,
      options: .regularExpression
    ) != nil {
      return raw
    }
    return nil
  }

  fileprivate func openSelectedGitFile() {
    guard let path = selectedGitPath else { return }
    let url = rootURL.appendingPathComponent(path).standardizedFileURL
    Task { await selectFile(url) }
  }

  private func refreshSelectedGitDiff() {
    gitDiffCancellation?.cancel()
    gitDiffCancellation = nil
    guard let access, let path = selectedGitPath else {
      selectedGitDiff = ""
      gitDiffIsLoading = false
      return
    }
    let cancellation = NativeProcessCancellation()
    gitDiffCancellation = cancellation
    gitDiffIsLoading = true
    let rootURL = access.rootURL
    let scope = gitDiffScope
    DispatchQueue.global(qos: .userInitiated).async {
      let prefix = ["--no-pager", "-c", "core.quotepath=false", "-C", rootURL.path]
      let staged = NativeProcessCapture.run(
        executableURL: URL(fileURLWithPath: "/usr/bin/git"),
        arguments: prefix + ["diff", "--cached", "--no-ext-diff", "--color=never", "--", path],
        currentDirectoryURL: rootURL,
        cancellation: cancellation
      )
      let working = NativeProcessCapture.run(
        executableURL: URL(fileURLWithPath: "/usr/bin/git"),
        arguments: prefix + ["diff", "--no-ext-diff", "--color=never", "--", path],
        currentDirectoryURL: rootURL,
        cancellation: cancellation
      )
      var sections: [String] = []
      if let failure = [staged, working].first(where: { $0.stopReason != nil }) {
        DispatchQueue.main.async { [weak self] in
          guard let self,
                self.gitDiffCancellation === cancellation,
                self.selectedGitPath == path,
                self.gitDiffScope == scope
          else { return }
          self.gitDiffCancellation = nil
          self.selectedGitDiff = ""
          self.gitDiffIsLoading = false
          self.gitMessage = .gitOperationFailed(
            failure.output.trimmingCharacters(in: .whitespacesAndNewlines)
          )
        }
        return
      }
      if scope != .working, !staged.output.isEmpty { sections.append(staged.output) }
      if scope != .staged, !working.output.isEmpty { sections.append(working.output) }
      if scope != .staged, sections.isEmpty {
        let target = rootURL.appendingPathComponent(path).standardizedFileURL
        let untracked = NativeProcessCapture.run(
          executableURL: URL(fileURLWithPath: "/usr/bin/git"),
          arguments: prefix + ["diff", "--no-index", "--color=never", "--", "/dev/null", target.path],
          currentDirectoryURL: rootURL,
          cancellation: cancellation
        )
        if untracked.stopReason != nil {
          DispatchQueue.main.async { [weak self] in
            guard let self,
                  self.gitDiffCancellation === cancellation,
                  self.selectedGitPath == path,
                  self.gitDiffScope == scope
            else { return }
            self.gitDiffCancellation = nil
            self.selectedGitDiff = ""
            self.gitDiffIsLoading = false
            self.gitMessage = .gitOperationFailed(
              untracked.output.trimmingCharacters(in: .whitespacesAndNewlines)
            )
          }
          return
        }
        if !untracked.output.isEmpty { sections.append(untracked.output) }
      }
      DispatchQueue.main.async { [weak self] in
        guard let self,
              self.gitDiffCancellation === cancellation,
              self.selectedGitPath == path,
              self.gitDiffScope == scope
        else { return }
        self.gitDiffCancellation = nil
        self.selectedGitDiff = sections.joined(separator: "\n")
        self.gitDiffIsLoading = false
      }
    }
  }

  private func refreshSelectedGitCommit() {
    gitCommitCancellation?.cancel()
    gitCommitCancellation = nil
    guard let access, let commitID = selectedGitCommitID else {
      selectedGitCommitDetail = ""
      gitCommitChanges = []
      selectedGitCommitPath = nil
      selectedGitCommitPatch = ""
      gitCommitDiffIsLoading = false
      return
    }
    let cancellation = NativeProcessCancellation()
    gitCommitCancellation = cancellation
    selectedGitCommitDetail = ""
    gitCommitChanges = []
    selectedGitCommitPatch = ""
    gitCommitDiffIsLoading = true
    let rootURL = access.rootURL
    DispatchQueue.global(qos: .userInitiated).async {
      let prefix = ["--no-pager", "-c", "core.quotepath=false", "-C", rootURL.path]
      let detail = NativeProcessCapture.run(
        executableURL: URL(fileURLWithPath: "/usr/bin/git"),
        arguments: prefix + ["show", "--no-ext-diff", "--color=never", "--stat", "--format=fuller", commitID],
        currentDirectoryURL: rootURL,
        cancellation: cancellation
      )
      let changedFiles = NativeProcessCapture.run(
        executableURL: URL(fileURLWithPath: "/usr/bin/git"),
        arguments: prefix + [
          "diff-tree",
          "--root",
          "--no-commit-id",
          "--name-status",
          "-r",
          "-M",
          commitID,
        ],
        currentDirectoryURL: rootURL,
        cancellation: cancellation
      )
      DispatchQueue.main.async { [weak self] in
        guard let self,
              self.gitCommitCancellation === cancellation,
              self.selectedGitCommitID == commitID
        else { return }
        self.gitCommitCancellation = nil
        guard detail.exitCode == 0, changedFiles.exitCode == 0 else {
          let failure = detail.exitCode == 0 ? changedFiles : detail
          let reason = failure.output.trimmingCharacters(in: .whitespacesAndNewlines)
          self.selectedGitCommitDetail = ""
          self.gitCommitChanges = []
          self.selectedGitCommitPath = nil
          self.selectedGitCommitPatch = ""
          self.gitCommitDiffIsLoading = false
          self.gitMessage = .gitOperationFailed(
            reason.isEmpty ? "git exited \(failure.exitCode)" : reason
          )
          return
        }
        self.selectedGitCommitDetail = detail.output
        self.gitCommitChanges = changedFiles.output
          .split(separator: "\n", omittingEmptySubsequences: true)
          .compactMap(NativeGitChange.init(historyNameStatusLine:))
        let selectedFileExists = self.selectedGitCommitPath.map { selectedPath in
          self.gitCommitChanges.contains { $0.path == selectedPath }
        } ?? false
        if !selectedFileExists {
          self.selectedGitCommitPath = self.gitCommitChanges.first?.path
        }
        self.refreshSelectedGitCommitDiff()
      }
    }
  }

  private func refreshSelectedGitCommitDiff() {
    gitCommitDiffCancellation?.cancel()
    gitCommitDiffCancellation = nil
    guard let access,
          let commitID = selectedGitCommitID,
          let path = selectedGitCommitPath
    else {
      selectedGitCommitPatch = ""
      gitCommitDiffIsLoading = false
      return
    }
    let cancellation = NativeProcessCancellation()
    gitCommitDiffCancellation = cancellation
    gitCommitDiffIsLoading = true
    let rootURL = access.rootURL
    DispatchQueue.global(qos: .userInitiated).async {
      let prefix = ["--no-pager", "-c", "core.quotepath=false", "-C", rootURL.path]
      let patch = NativeProcessCapture.run(
        executableURL: URL(fileURLWithPath: "/usr/bin/git"),
        arguments: prefix + [
          "show",
          "--no-ext-diff",
          "--color=never",
          "--format=",
          "--patch",
          commitID,
          "--",
          path,
        ],
        currentDirectoryURL: rootURL,
        cancellation: cancellation
      )
      DispatchQueue.main.async { [weak self] in
        guard let self,
              self.gitCommitDiffCancellation === cancellation,
              self.selectedGitCommitID == commitID,
              self.selectedGitCommitPath == path
        else { return }
        self.gitCommitDiffCancellation = nil
        if patch.exitCode == 0 {
          self.selectedGitCommitPatch = patch.output
        } else {
          self.selectedGitCommitPatch = ""
          let reason = patch.output.trimmingCharacters(in: .whitespacesAndNewlines)
          self.gitMessage = .gitOperationFailed(
            reason.isEmpty ? "git exited \(patch.exitCode)" : reason
          )
        }
        self.gitCommitDiffIsLoading = false
      }
    }
  }

  @discardableResult
  private func performGitOperation(
    arguments: [String],
    success: String,
    resetsFileTabs: Bool = false,
    selectsLatestCommitAfterRefresh: Bool = false
  ) -> Bool {
    performGitOperationSequence(
      operations: [arguments],
      success: success,
      resetsFileTabs: resetsFileTabs,
      selectsLatestCommitAfterRefresh: selectsLatestCommitAfterRefresh
    )
  }

  @discardableResult
  private func performGitOperationSequence(
    operations: [[String]],
    success: String,
    resetsFileTabs: Bool = false,
    selectsLatestCommitAfterRefresh: Bool = false
  ) -> Bool {
    guard !gitIsLoading, let access else { return false }
    if resetsFileTabs, fileTabs.hasDirtyTabs {
      gitMessage = .gitOperationFailed("Close or save dirty Files tabs first.")
      return false
    }
    gitIsLoading = true
    gitMessage = .gitLoading
    gitOperationCancellation?.cancel()
    let cancellation = NativeProcessCancellation()
    gitOperationCancellation = cancellation
    let rootURL = access.rootURL
    let fileTabsAtStart = resetsFileTabs ? fileTabs : nil
    DispatchQueue.global(qos: .userInitiated).async {
      let prefix = ["--no-pager", "-c", "core.quotepath=false", "-C", rootURL.path]
      var result = NativeProcessCapture(output: "", exitCode: 0)
      for arguments in operations {
        guard !cancellation.isCancelled else {
          result = NativeProcessCapture(
            output: "… Git operation cancelled before next step …\n",
            exitCode: -1,
            stopReason: .cancelled
          )
          break
        }
        result = NativeProcessCapture.run(
          executableURL: URL(fileURLWithPath: "/usr/bin/git"),
          arguments: prefix + arguments,
          currentDirectoryURL: rootURL,
          timeoutNanoseconds: 60_000_000_000,
          cancellation: cancellation
        )
        if result.exitCode != 0 { break }
      }
      DispatchQueue.main.async { [weak self] in
        guard let self, self.gitOperationCancellation === cancellation else { return }
        self.gitOperationCancellation = nil
        self.gitIsLoading = false
        guard result.exitCode == 0 else {
          let reason = result.output.trimmingCharacters(in: .whitespacesAndNewlines)
          self.gitMessage = .gitOperationFailed(reason.isEmpty ? "git exited \(result.exitCode)" : reason)
          return
        }
        var successMessage = success
        if let fileTabsAtStart {
          if !self.resetFileTabsAfterGitOperation(startedWith: fileTabsAtStart) {
            successMessage += ". Files tabs changed during the operation and were preserved."
          }
          self.refreshTree()
        }
        if selectsLatestCommitAfterRefresh {
          self.selectLatestGitCommitAfterRefresh = true
        }
        self.gitSuccessAfterRefresh = successMessage
        self.didLoadGit = false
        self.refreshGit()
      }
    }
    return true
  }

  func cancelGitOperations() {
    gitRefreshCancellation?.cancel()
    gitDiffCancellation?.cancel()
    gitCommitCancellation?.cancel()
    gitCommitDiffCancellation?.cancel()
    gitOperationCancellation?.cancel()
    gitRefreshCancellation = nil
    gitDiffCancellation = nil
    gitCommitCancellation = nil
    gitCommitDiffCancellation = nil
    gitOperationCancellation = nil
    gitIsLoading = false
    gitDiffIsLoading = false
    gitCommitDiffIsLoading = false
    didLoadGit = false
  }

  private func refreshTreeFromOwner(generation: Int) async {
    do {
      let root = NativeFileNode(
        name: rootURL.lastPathComponent.isEmpty ? rootURL.path : rootURL.lastPathComponent,
        url: rootURL,
        isDirectory: true
      )
      root.children = try await directoryNodes(at: rootURL)
      root.isExpanded = true
      guard generation == treeRefreshGeneration else { return }
      rootNodes = [root]
      fileTreeRevision &+= 1
      treeIsLoading = false
      treeLoadError = nil
    } catch {
      guard generation == treeRefreshGeneration else { return }
      treeIsLoading = false
      treeLoadError = error.localizedDescription
      editorStatus = .refreshFailed(error.localizedDescription)
    }
  }

  private func directoryNodes(at directory: URL) async throws -> [NativeFileNode] {
    guard access != nil else { return [] }
    let rootURL = rootURL
    let showHiddenNoise = showHiddenNoise
    let worker = Task.detached(priority: .userInitiated) {
      let access = try NativeWorkspaceAccess(rootURL: rootURL)
      return try access.listDirectory(directory, showHiddenNoise: showHiddenNoise)
    }
    let entries = try await withTaskCancellationHandler {
      try await worker.value
    } onCancel: {
      worker.cancel()
    }
    try Task.checkCancellation()
    return entries.map(NativeFileNode.init)
  }

  private func filteredNode(_ node: NativeFileNode, query: String) -> NativeFileNode? {
    let nameMatches = node.name.localizedCaseInsensitiveContains(query)
    guard node.isDirectory else { return nameMatches ? node : nil }
    let matchingChildren = node.children?.compactMap { filteredNode($0, query: query) } ?? []
    guard nameMatches || !matchingChildren.isEmpty else { return nil }
    if nameMatches { return node }
    let copy = NativeFileNode(name: node.name, url: node.url, isDirectory: true)
    copy.children = matchingChildren
    copy.isExpanded = true
    return copy
  }

  private func openFile(_ url: URL, selectionGeneration: Int) async {
    let canonical = NativeFileTabState.canonicalPath(for: url)
    // pre-await dedupe
    if let existing = fileTabs.tabs.first(where: { $0.canonicalPath == canonical }) {
      if selectionGeneration == fileSelectionGeneration {
        activateFileTab(existing.id)
      }
      return
    }
    do {
      let text = try await readFileText(url)
      let isLatestSelection = selectionGeneration == fileSelectionGeneration
      // post-await dedupe：读期间另一任务可能已创建同路径 Tab
      if let index = fileTabs.indexOf(canonicalPath: canonical) {
        if isLatestSelection { activateFileTab(fileTabs.tabs[index].id) }
      } else {
        let openedID = fileTabs.openTab(url: url, text: text, activate: false)
        if isLatestSelection { activateFileTab(openedID) }
      }
      if isLatestSelection {
        editorStatus = .loaded(access?.displayPath(for: url) ?? url.path)
      }
    } catch {
      if selectionGeneration == fileSelectionGeneration {
        editorStatus = .openFailed(error.localizedDescription)
      }
    }
  }

  private func readFileText(_ url: URL) async throws -> String {
    if let injectedFileReader { return try await injectedFileReader(url) }
    guard access != nil else { throw NativeWorkbenchError.notRegularFile }
    let rootURL = rootURL
    let worker = Task.detached(priority: .userInitiated) {
      let access = try NativeWorkspaceAccess(rootURL: rootURL)
      return try access.readUTF8Text(at: url)
    }
    return try await withTaskCancellationHandler {
      try await worker.value
    } onCancel: {
      worker.cancel()
    }
  }
}

struct NativeDirectoryEntry: Sendable {
  let name: String
  let url: URL
  let isDirectory: Bool
}

struct NativeSaveTransactionRecord: Codable, Equatable, Sendable {
  static let journalPrefix = ".ark-save-journal-"
  static let newPrefix = ".ark-save-new-"
  static let oldPrefix = ".ark-save-old-"

  let version: Int
  let fileName: String
  let newName: String
  let oldName: String
  let expectedOldSHA256: String
  let newSHA256: String

  init(
    fileName: String,
    transactionID: String,
    expectedOldSHA256: String,
    newSHA256: String
  ) {
    version = 1
    self.fileName = fileName
    newName = Self.newPrefix + transactionID
    oldName = Self.oldPrefix + transactionID
    self.expectedOldSHA256 = expectedOldSHA256
    self.newSHA256 = newSHA256
  }

  var journalName: String {
    let suffix = newName.dropFirst(Self.newPrefix.count)
    return Self.journalPrefix + suffix
  }
}

struct NativeCopyTransactionRecord: Codable, Equatable, Sendable {
  static let journalPrefix = ".ark-copy-journal-"
  static let stagingPrefix = ".ark-copy-staging-"

  let version: Int
  let sourceName: String
  let stagingName: String

  init(sourceName: String, transactionID: String) {
    version = 1
    self.sourceName = sourceName
    stagingName = Self.stagingPrefix + transactionID
  }

  var journalName: String {
    let suffix = stagingName.dropFirst(Self.stagingPrefix.count)
    return Self.journalPrefix + suffix
  }
}

private extension NativeFileNode {
  convenience init(_ entry: NativeDirectoryEntry) {
    self.init(name: entry.name, url: entry.url, isDirectory: entry.isDirectory)
  }
}

final class NativeWorkspaceAccess {
  static let maximumTextFileSize = 8 * 1024 * 1024
  private static let searchResultLimit = 250
  private static let searchVisitLimit = 40_000
  private static let ignoredSearchDirectories: Set<String> = [
    ".git", ".build", ".dsh-build", ".pnpm-store", "node_modules",
  ]

  let rootURL: URL
  private let rootDescriptor: Int32

  init(rootURL: URL) throws {
    guard rootURL.isFileURL else {
      throw NativeWorkbenchError.invalidRoot("工作区必须是本地文件目录")
    }
    let canonicalRoot = rootURL.standardizedFileURL.resolvingSymlinksInPath()
    var isDirectory: ObjCBool = false
    guard FileManager.default.fileExists(atPath: canonicalRoot.path, isDirectory: &isDirectory), isDirectory.boolValue else {
      throw NativeWorkbenchError.invalidRoot("目录不存在：\(canonicalRoot.path)")
    }
    let descriptor = Darwin.open(canonicalRoot.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    guard descriptor >= 0 else {
      throw NativeWorkbenchError.posix(operation: "打开工作区", code: errno)
    }
    self.rootURL = canonicalRoot
    rootDescriptor = descriptor
  }

  deinit {
    Darwin.close(rootDescriptor)
  }

  func displayPath(for url: URL) -> String {
    guard let components = try? relativeComponents(for: url), !components.isEmpty else { return "." }
    return components.joined(separator: "/")
  }

  /// Resolve a transcript/tool location through the same descriptor-confined
  /// path chain that the editor uses. Every directory component and the leaf
  /// are opened with O_NOFOLLOW, so a symlink cannot become an editor handoff.
  func validatedRegularFileURL(_ url: URL) throws -> URL {
    let components = try relativeComponents(for: url)
    guard !components.isEmpty else { throw NativeWorkbenchError.notRegularFile }
    let descriptor = try openFile(components, flags: O_RDONLY)
    defer { Darwin.close(descriptor) }
    var fileInfo = stat()
    guard Darwin.fstat(descriptor, &fileInfo) == 0 else {
      throw NativeWorkbenchError.posix(operation: "读取文件信息", code: errno)
    }
    guard (fileInfo.st_mode & S_IFMT) == S_IFREG else {
      throw NativeWorkbenchError.notRegularFile
    }
    guard fileInfo.st_size <= Self.maximumTextFileSize else {
      throw NativeWorkbenchError.fileTooLarge
    }
    return components.reduce(rootURL) { partial, component in
      partial.appendingPathComponent(component)
    }.standardizedFileURL
  }

  func createFile(named rawName: String, in directoryURL: URL) throws -> URL {
    let name = try validatedLeafName(rawName)
    let directoryDescriptor = try openDirectory(relativeComponents(for: directoryURL))
    defer { Darwin.close(directoryDescriptor) }
    let descriptor = Darwin.openat(
      directoryDescriptor,
      name,
      O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,
      mode_t(0o600)
    )
    guard descriptor >= 0 else {
      if errno == EEXIST { throw NativeWorkbenchError.itemAlreadyExists }
      throw NativeWorkbenchError.posix(operation: "新建文件", code: errno)
    }
    guard Darwin.fsync(descriptor) == 0 else {
      let code = errno
      Darwin.close(descriptor)
      throw NativeWorkbenchError.posix(operation: "同步新文件", code: code)
    }
    Darwin.close(descriptor)
    guard Darwin.fsync(directoryDescriptor) == 0 else {
      throw NativeWorkbenchError.posix(operation: "同步工作区目录", code: errno)
    }
    return directoryURL.appendingPathComponent(name).standardizedFileURL
  }

  func createFolder(named rawName: String, in directoryURL: URL) throws -> URL {
    let name = try validatedLeafName(rawName)
    let directoryDescriptor = try openDirectory(relativeComponents(for: directoryURL))
    defer { Darwin.close(directoryDescriptor) }
    guard Darwin.mkdirat(directoryDescriptor, name, mode_t(0o700)) == 0 else {
      if errno == EEXIST { throw NativeWorkbenchError.itemAlreadyExists }
      throw NativeWorkbenchError.posix(operation: "新建文件夹", code: errno)
    }
    guard Darwin.fsync(directoryDescriptor) == 0 else {
      throw NativeWorkbenchError.posix(operation: "同步工作区目录", code: errno)
    }
    return directoryURL.appendingPathComponent(name, isDirectory: true).standardizedFileURL
  }

  func renameItem(_ sourceURL: URL, to rawName: String) throws -> URL {
    let components = try relativeComponents(for: sourceURL)
    guard let oldName = components.last else { throw NativeWorkbenchError.pathOutsideRoot }
    let newName = try validatedLeafName(rawName)
    let parentURL = sourceURL.deletingLastPathComponent()
    let parentDescriptor = try openDirectory(Array(components.dropLast()))
    defer { Darwin.close(parentDescriptor) }
    try requireOrdinaryItem(named: oldName, in: parentDescriptor)
    let result = oldName.withCString { oldPointer in
      newName.withCString { newPointer in
        Darwin.renameatx_np(
          parentDescriptor,
          oldPointer,
          parentDescriptor,
          newPointer,
          UInt32(RENAME_EXCL)
        )
      }
    }
    guard result == 0 else {
      if errno == EEXIST { throw NativeWorkbenchError.itemAlreadyExists }
      throw NativeWorkbenchError.posix(operation: "重命名", code: errno)
    }
    guard Darwin.fsync(parentDescriptor) == 0 else {
      throw NativeWorkbenchError.posix(operation: "同步工作区目录", code: errno)
    }
    return parentURL.appendingPathComponent(newName).standardizedFileURL
  }

  func moveItem(_ sourceURL: URL, to directoryURL: URL) throws -> URL {
    let sourceComponents = try relativeComponents(for: sourceURL)
    guard let name = sourceComponents.last else { throw NativeWorkbenchError.pathOutsideRoot }
    let destinationComponents = try relativeComponents(for: directoryURL)
    let sourcePath = sourceURL.standardizedFileURL.path
    let destinationPath = directoryURL.standardizedFileURL.path
    guard destinationPath != sourcePath, !destinationPath.hasPrefix(sourcePath + "/") else {
      throw NativeWorkbenchError.pathOutsideRoot
    }
    let sourceParent = try openDirectory(Array(sourceComponents.dropLast()))
    defer { Darwin.close(sourceParent) }
    let destination = try openDirectory(destinationComponents)
    defer { Darwin.close(destination) }
    try requireOrdinaryItem(named: name, in: sourceParent)
    let result = name.withCString { pointer in
      Darwin.renameatx_np(sourceParent, pointer, destination, pointer, UInt32(RENAME_EXCL))
    }
    guard result == 0 else {
      if errno == EEXIST { throw NativeWorkbenchError.itemAlreadyExists }
      throw NativeWorkbenchError.posix(operation: "移动", code: errno)
    }
    guard Darwin.fsync(sourceParent) == 0, Darwin.fsync(destination) == 0 else {
      throw NativeWorkbenchError.posix(operation: "同步工作区目录", code: errno)
    }
    return directoryURL.appendingPathComponent(name).standardizedFileURL
  }

  func duplicateItem(_ sourceURL: URL) throws -> URL {
    try Task.checkCancellation()
    let components = try relativeComponents(for: sourceURL)
    guard !components.isEmpty else { throw NativeWorkbenchError.pathOutsideRoot }
    guard let sourceName = components.last else { throw NativeWorkbenchError.pathOutsideRoot }
    let parentURL = sourceURL.deletingLastPathComponent()
    let parentDescriptor = try openDirectory(Array(components.dropLast()))
    defer { Darwin.close(parentDescriptor) }
    try recoverCopyTransactions(in: parentDescriptor)
    let source = try openOrdinaryItem(named: sourceName, in: parentDescriptor)
    defer { Darwin.close(source.descriptor) }
    let transaction = NativeCopyTransactionRecord(
      sourceName: sourceName,
      transactionID: UUID().uuidString
    )
    let journalDescriptor = Darwin.openat(
      parentDescriptor,
      transaction.journalName,
      O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,
      mode_t(0o600)
    )
    guard journalDescriptor >= 0 else {
      throw NativeWorkbenchError.posix(operation: "创建复制恢复日志", code: errno)
    }
    var journalExists = true
    var stagingExists = false
    defer {
      unlockFile(journalDescriptor)
      Darwin.close(journalDescriptor)
      if stagingExists { try? removeOwnedItem(named: transaction.stagingName, in: parentDescriptor) }
      if journalExists { Darwin.unlinkat(parentDescriptor, transaction.journalName, 0) }
    }
    guard tryExclusiveFileLock(journalDescriptor) else {
      throw NativeWorkbenchError.posix(operation: "锁定复制恢复日志", code: errno)
    }
    try writeAll(
      JSONEncoder().encode(transaction),
      to: journalDescriptor,
      operation: "写入复制恢复日志"
    )
    guard Darwin.fsync(journalDescriptor) == 0,
          Darwin.fsync(parentDescriptor) == 0
    else { throw NativeWorkbenchError.posix(operation: "同步复制恢复日志", code: errno) }
    try duplicateOpenedItem(
      sourceDescriptor: source.descriptor,
      sourceInfo: source.info,
      destinationName: transaction.stagingName,
      parentDescriptor: parentDescriptor
    )
    stagingExists = true

    let ext = sourceURL.pathExtension
    let stem = ext.isEmpty ? sourceName : String(sourceName.dropLast(ext.count + 1))
    for index in 1...999 {
      try Task.checkCancellation()
      let suffix = index == 1 ? " copy" : " copy \(index)"
      let candidateName = ext.isEmpty ? stem + suffix : stem + suffix + "." + ext
      let candidate = parentURL.appendingPathComponent(candidateName)
      let publishResult = transaction.stagingName.withCString { stagingPointer in
        candidateName.withCString { candidatePointer in
          Darwin.renameatx_np(
            parentDescriptor,
            stagingPointer,
            parentDescriptor,
            candidatePointer,
            UInt32(RENAME_EXCL)
          )
        }
      }
      if publishResult == 0 {
        stagingExists = false
        guard Darwin.fsync(parentDescriptor) == 0 else {
          throw NativeWorkbenchError.posix(operation: "同步复制发布", code: errno)
        }
        guard Darwin.unlinkat(parentDescriptor, transaction.journalName, 0) == 0 else {
          throw NativeWorkbenchError.posix(operation: "完成复制恢复日志", code: errno)
        }
        journalExists = false
        guard Darwin.fsync(parentDescriptor) == 0 else {
          throw NativeWorkbenchError.posix(operation: "同步复制完成状态", code: errno)
        }
        return candidate.standardizedFileURL
      }
      if errno == EEXIST { continue }
      throw NativeWorkbenchError.posix(operation: "发布复制项目", code: errno)
    }
    throw NativeWorkbenchError.itemAlreadyExists
  }

  func trashItem(_ url: URL) throws {
    try Task.checkCancellation()
    let components = try relativeComponents(for: url)
    guard !components.isEmpty, let name = components.last else {
      throw NativeWorkbenchError.pathOutsideRoot
    }
    let parentDescriptor = try openDirectory(Array(components.dropLast()))
    defer { Darwin.close(parentDescriptor) }
    let source = try openOrdinaryItem(named: name, in: parentDescriptor)
    Darwin.close(source.descriptor)

    let stagingName = ".ark-trash-\(UUID().uuidString)"
    let claimResult = name.withCString { sourcePointer in
      stagingName.withCString { stagingPointer in
        Darwin.renameatx_np(
          parentDescriptor,
          sourcePointer,
          parentDescriptor,
          stagingPointer,
          UInt32(RENAME_EXCL)
        )
      }
    }
    guard claimResult == 0 else {
      throw NativeWorkbenchError.posix(operation: "锁定待移除项目", code: errno)
    }

    var claimed = true
    do {
      var claimedInfo = stat()
      guard Darwin.fstatat(
        parentDescriptor,
        stagingName,
        &claimedInfo,
        AT_SYMLINK_NOFOLLOW
      ) == 0,
        sameIdentity(source.info, claimedInfo)
      else { throw NativeWorkbenchError.externalModificationConflict }

      let trashDescriptor = try openTrashDirectory(forDevice: claimedInfo.st_dev)
      defer { Darwin.close(trashDescriptor) }
      for index in 1...999 {
        try Task.checkCancellation()
        let destinationName = index == 1 ? name : "\(name) \(index)"
        let result = stagingName.withCString { sourcePointer in
          destinationName.withCString { destinationPointer in
            Darwin.renameatx_np(
              parentDescriptor,
              sourcePointer,
              trashDescriptor,
              destinationPointer,
              UInt32(RENAME_EXCL)
            )
          }
        }
        if result == 0 {
          if Darwin.fsync(parentDescriptor) != 0 || Darwin.fsync(trashDescriptor) != 0 {
            let syncError = errno
            let restoreResult = destinationName.withCString { destinationPointer in
              name.withCString { sourcePointer in
                Darwin.renameatx_np(
                  trashDescriptor,
                  destinationPointer,
                  parentDescriptor,
                  sourcePointer,
                  UInt32(RENAME_EXCL)
                )
              }
            }
            if restoreResult != 0 {
              claimed = false
              throw NativeWorkbenchError.posix(operation: "恢复未同步的废纸篓移动", code: errno)
            }
            claimed = false
            throw NativeWorkbenchError.posix(operation: "同步废纸篓移动", code: syncError)
          }
          claimed = false
          return
        }
        if errno == EEXIST { continue }
        throw NativeWorkbenchError.posix(operation: "移到废纸篓", code: errno)
      }
      throw NativeWorkbenchError.itemAlreadyExists
    } catch {
      if claimed {
        let restoreResult = stagingName.withCString { stagingPointer in
          name.withCString { sourcePointer in
            Darwin.renameatx_np(
              parentDescriptor,
              stagingPointer,
              parentDescriptor,
              sourcePointer,
              UInt32(RENAME_EXCL)
            )
          }
        }
        guard restoreResult == 0 else {
          throw NativeWorkbenchError.posix(operation: "恢复未完成的废纸篓移动", code: errno)
        }
      }
      throw error
    }
  }

  func listDirectory(
    _ directoryURL: URL,
    showHiddenNoise: Bool = false
  ) throws -> [NativeDirectoryEntry] {
    try Task.checkCancellation()
    let descriptor = try openDirectory(relativeComponents(for: directoryURL))
    _ = try recoverSaveTransactions(in: descriptor)
    try recoverCopyTransactions(in: descriptor)
    guard let directory = Darwin.fdopendir(descriptor) else {
      let code = errno
      Darwin.close(descriptor)
      throw NativeWorkbenchError.posix(operation: "读取目录", code: code)
    }
    defer { Darwin.closedir(directory) }

    var entries: [NativeDirectoryEntry] = []
    while let entry = Darwin.readdir(directory) {
      try Task.checkCancellation()
      let name = withUnsafePointer(to: &entry.pointee.d_name) { namePointer in
        namePointer.withMemoryRebound(to: CChar.self, capacity: Int(MAXNAMLEN) + 1) {
          String(validatingUTF8: $0)
        }
      }
      guard let name, name != ".", name != ".." else { continue }
      if name.hasPrefix(NativeSaveTransactionRecord.journalPrefix)
        || name.hasPrefix(NativeSaveTransactionRecord.newPrefix)
        || name.hasPrefix(NativeSaveTransactionRecord.oldPrefix)
        || name.hasPrefix(".ark-copy-")
        || name.hasPrefix(".ark-trash-") {
        continue
      }
      if !showHiddenNoise && (name == ".DS_Store" || name == ".localized") { continue }

      var fileInfo = stat()
      guard Darwin.fstatat(descriptor, name, &fileInfo, AT_SYMLINK_NOFOLLOW) == 0 else { continue }
      let fileType = fileInfo.st_mode & S_IFMT
      let isDirectory = fileType == S_IFDIR
      guard isDirectory || fileType == S_IFREG else { continue }
      let url = directoryURL.appendingPathComponent(name, isDirectory: isDirectory).standardizedFileURL
      _ = try relativeComponents(for: url)
      entries.append(NativeDirectoryEntry(name: name, url: url, isDirectory: isDirectory))
    }
    return entries
    .sorted { left, right in
      if left.isDirectory != right.isDirectory { return left.isDirectory }
      return left.name.localizedStandardCompare(right.name) == .orderedAscending
    }
  }

  func searchFileNames(matching query: String) throws -> [URL] {
    try Task.checkCancellation()
    let needle = query.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
    guard !needle.isEmpty else { return [] }
    var directories = [rootURL]
    var directoryIndex = 0
    var visited = 0
    var matches: [URL] = []

    while directoryIndex < directories.count,
          visited < Self.searchVisitLimit,
          matches.count < Self.searchResultLimit {
      try Task.checkCancellation()
      let directory = directories[directoryIndex]
      directoryIndex += 1
      for entry in try listDirectory(directory) {
        try Task.checkCancellation()
        visited += 1
        if visited > Self.searchVisitLimit { break }
        if entry.isDirectory {
          if shouldSearchDirectory(entry.name) { directories.append(entry.url) }
          continue
        }
        guard entry.name != ".DS_Store", entry.name != ".localized" else { continue }
        let relativePath = displayPath(for: entry.url)
          .folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
        if relativePath.contains(needle) {
          matches.append(entry.url)
          if matches.count >= Self.searchResultLimit { break }
        }
      }
    }
    return matches.sorted {
      displayPath(for: $0).localizedStandardCompare(displayPath(for: $1)) == .orderedAscending
    }
  }

  private func shouldSearchDirectory(_ name: String) -> Bool {
    guard !Self.ignoredSearchDirectories.contains(name) else { return false }
    return !name.hasPrefix(".tmp-swift-module-cache")
      && !name.hasPrefix(".tmp-recording-")
      && !name.hasPrefix(".venv")
  }

  private func duplicateOpenedItem(
    sourceDescriptor: Int32,
    sourceInfo: stat,
    destinationName: String,
    parentDescriptor: Int32
  ) throws {
    let type = sourceInfo.st_mode & S_IFMT
    if type == S_IFREG {
      let destination = Darwin.openat(
        parentDescriptor,
        destinationName,
        O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,
        mode_t(sourceInfo.st_mode & 0o777)
      )
      guard destination >= 0 else {
        if errno == EEXIST { throw NativeWorkbenchError.itemAlreadyExists }
        throw NativeWorkbenchError.posix(operation: "创建复制文件", code: errno)
      }
      var keepDestination = false
      defer {
        Darwin.close(destination)
        if !keepDestination { Darwin.unlinkat(parentDescriptor, destinationName, 0) }
      }
      guard Darwin.lseek(sourceDescriptor, 0, SEEK_SET) >= 0 else {
        throw NativeWorkbenchError.posix(operation: "定位复制来源", code: errno)
      }
      guard Darwin.fcopyfile(sourceDescriptor, destination, nil, copyfile_flags_t(COPYFILE_ALL)) == 0 else {
        throw NativeWorkbenchError.posix(operation: "复制文件数据与元数据", code: errno)
      }
      guard Darwin.fchmod(destination, mode_t(sourceInfo.st_mode & 0o777)) == 0,
            Darwin.fsync(destination) == 0,
            Darwin.fsync(parentDescriptor) == 0
      else { throw NativeWorkbenchError.posix(operation: "同步复制文件", code: errno) }
      keepDestination = true
      return
    }

    guard type == S_IFDIR else { throw NativeWorkbenchError.notRegularFile }
    guard Darwin.mkdirat(parentDescriptor, destinationName, mode_t(0o700)) == 0 else {
      if errno == EEXIST { throw NativeWorkbenchError.itemAlreadyExists }
      throw NativeWorkbenchError.posix(operation: "创建复制目录", code: errno)
    }
    var keepDestination = false
    defer {
      if !keepDestination {
        try? removeOwnedItem(named: destinationName, in: parentDescriptor)
      }
    }
    let destinationDescriptor = Darwin.openat(
      parentDescriptor,
      destinationName,
      O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
    )
    guard destinationDescriptor >= 0 else {
      throw NativeWorkbenchError.posix(operation: "打开复制目录", code: errno)
    }
    defer { Darwin.close(destinationDescriptor) }
    try copyDirectoryContents(from: sourceDescriptor, to: destinationDescriptor)
    let metadataFlags = copyfile_flags_t(COPYFILE_ACL | COPYFILE_XATTR | COPYFILE_STAT)
    guard Darwin.fcopyfile(sourceDescriptor, destinationDescriptor, nil, metadataFlags) == 0,
          Darwin.fchmod(destinationDescriptor, mode_t(sourceInfo.st_mode & 0o777)) == 0,
          Darwin.fsync(destinationDescriptor) == 0,
          Darwin.fsync(parentDescriptor) == 0
    else { throw NativeWorkbenchError.posix(operation: "同步复制目录", code: errno) }
    keepDestination = true
  }

  private func copyDirectoryContents(from sourceDescriptor: Int32, to destinationDescriptor: Int32) throws {
    let streamDescriptor = Darwin.dup(sourceDescriptor)
    guard streamDescriptor >= 0, let directory = Darwin.fdopendir(streamDescriptor) else {
      if streamDescriptor >= 0 { Darwin.close(streamDescriptor) }
      throw NativeWorkbenchError.posix(operation: "遍历复制目录", code: errno)
    }
    defer { Darwin.closedir(directory) }
    while let entry = Darwin.readdir(directory) {
      try Task.checkCancellation()
      let name = withUnsafePointer(to: &entry.pointee.d_name) { namePointer in
        namePointer.withMemoryRebound(to: CChar.self, capacity: Int(MAXNAMLEN) + 1) {
          String(validatingUTF8: $0)
        }
      }
      guard let name, name != ".", name != ".." else { continue }
      let child = try openOrdinaryItem(named: name, in: sourceDescriptor)
      defer { Darwin.close(child.descriptor) }
      try duplicateOpenedItem(
        sourceDescriptor: child.descriptor,
        sourceInfo: child.info,
        destinationName: name,
        parentDescriptor: destinationDescriptor
      )
    }
  }

  private func removeOwnedItem(named name: String, in parentDescriptor: Int32) throws {
    var info = stat()
    guard Darwin.fstatat(parentDescriptor, name, &info, AT_SYMLINK_NOFOLLOW) == 0 else {
      if errno == ENOENT { return }
      throw NativeWorkbenchError.posix(operation: "检查未完成复制", code: errno)
    }
    if (info.st_mode & S_IFMT) == S_IFDIR {
      let descriptor = Darwin.openat(
        parentDescriptor,
        name,
        O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
      )
      guard descriptor >= 0 else {
        throw NativeWorkbenchError.posix(operation: "打开未完成复制", code: errno)
      }
      let streamDescriptor = Darwin.dup(descriptor)
      guard streamDescriptor >= 0, let directory = Darwin.fdopendir(streamDescriptor) else {
        if streamDescriptor >= 0 { Darwin.close(streamDescriptor) }
        Darwin.close(descriptor)
        throw NativeWorkbenchError.posix(operation: "遍历未完成复制", code: errno)
      }
      defer {
        Darwin.closedir(directory)
        Darwin.close(descriptor)
      }
      while let entry = Darwin.readdir(directory) {
        let childName = withUnsafePointer(to: &entry.pointee.d_name) { namePointer in
          namePointer.withMemoryRebound(to: CChar.self, capacity: Int(MAXNAMLEN) + 1) {
            String(validatingUTF8: $0)
          }
        }
        if let childName, childName != ".", childName != ".." {
          try removeOwnedItem(named: childName, in: descriptor)
        }
      }
      guard Darwin.unlinkat(parentDescriptor, name, AT_REMOVEDIR) == 0 else {
        throw NativeWorkbenchError.posix(operation: "移除未完成复制目录", code: errno)
      }
      return
    }
    guard Darwin.unlinkat(parentDescriptor, name, 0) == 0 else {
      throw NativeWorkbenchError.posix(operation: "移除未完成复制文件", code: errno)
    }
  }

  private func openOrdinaryItem(named name: String, in parentDescriptor: Int32) throws
    -> (descriptor: Int32, info: stat) {
    var before = stat()
    guard Darwin.fstatat(parentDescriptor, name, &before, AT_SYMLINK_NOFOLLOW) == 0 else {
      throw NativeWorkbenchError.posix(operation: "读取项目", code: errno)
    }
    let type = before.st_mode & S_IFMT
    guard type == S_IFREG || type == S_IFDIR else {
      throw NativeWorkbenchError.notRegularFile
    }
    let flags = O_RDONLY | O_NOFOLLOW | O_CLOEXEC | (type == S_IFDIR ? O_DIRECTORY : 0)
    let descriptor = Darwin.openat(parentDescriptor, name, flags)
    guard descriptor >= 0 else {
      throw NativeWorkbenchError.posix(operation: "打开项目", code: errno)
    }
    var after = stat()
    guard Darwin.fstat(descriptor, &after) == 0 else {
      let code = errno
      Darwin.close(descriptor)
      throw NativeWorkbenchError.posix(operation: "确认项目身份", code: code)
    }
    guard sameIdentity(before, after) else {
      Darwin.close(descriptor)
      throw NativeWorkbenchError.externalModificationConflict
    }
    return (descriptor, after)
  }

  private func openTrashDirectory(forDevice device: dev_t) throws -> Int32 {
    let trashURL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(
      ".Trash",
      isDirectory: true
    )
    let descriptor = Darwin.open(
      trashURL.path,
      O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
    )
    guard descriptor >= 0 else {
      throw NativeWorkbenchError.posix(operation: "打开废纸篓", code: errno)
    }
    var info = stat()
    guard Darwin.fstat(descriptor, &info) == 0,
          (info.st_mode & S_IFMT) == S_IFDIR,
          info.st_uid == Darwin.geteuid(),
          info.st_dev == device
    else {
      Darwin.close(descriptor)
      throw NativeWorkbenchError.trashUnavailable
    }
    return descriptor
  }

  private func sameIdentity(_ left: stat, _ right: stat) -> Bool {
    left.st_dev == right.st_dev && left.st_ino == right.st_ino
  }

  func readUTF8Text(at url: URL) throws -> String {
    let components = try relativeComponents(for: url)
    guard let fileName = components.last else { throw NativeWorkbenchError.notRegularFile }
    let parentDescriptor = try openDirectory(Array(components.dropLast()))
    defer { Darwin.close(parentDescriptor) }
    let unresolved = try recoverSaveTransactions(in: parentDescriptor)
    guard unresolved.isEmpty else {
      throw NativeWorkbenchError.saveRecoveryRequired(fileName)
    }
    let descriptor = Darwin.openat(parentDescriptor, fileName, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
    guard descriptor >= 0 else {
      throw NativeWorkbenchError.posix(operation: "打开文件", code: errno)
    }
    var fileInfo = stat()
    guard fstat(descriptor, &fileInfo) == 0 else {
      let code = errno
      Darwin.close(descriptor)
      throw NativeWorkbenchError.posix(operation: "读取文件信息", code: code)
    }
    guard (fileInfo.st_mode & S_IFMT) == S_IFREG else {
      Darwin.close(descriptor)
      throw NativeWorkbenchError.notRegularFile
    }
    guard fileInfo.st_size <= Self.maximumTextFileSize else {
      Darwin.close(descriptor)
      throw NativeWorkbenchError.fileTooLarge
    }

    defer { Darwin.close(descriptor) }
    let data = try readData(from: descriptor, limit: Self.maximumTextFileSize)
    guard !data.contains(0), let text = String(data: data, encoding: .utf8) else {
      throw NativeWorkbenchError.notUTF8Text
    }
    return text
  }

  func atomicWrite(_ text: String, to url: URL, expectedText: String) throws {
    try Task.checkCancellation()
    let components = try relativeComponents(for: url)
    guard let fileName = components.last, !fileName.isEmpty else {
      throw NativeWorkbenchError.notRegularFile
    }
    let parentDescriptor = try openDirectory(Array(components.dropLast()))
    defer { Darwin.close(parentDescriptor) }
    let unresolved = try recoverSaveTransactions(in: parentDescriptor)
    guard unresolved.isEmpty else {
      throw NativeWorkbenchError.saveRecoveryRequired(fileName)
    }

    let existingDescriptor = Darwin.openat(parentDescriptor, fileName, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
    guard existingDescriptor >= 0 else {
      throw NativeWorkbenchError.posix(operation: "打开待保存文件", code: errno)
    }
    var existingInfo = stat()
    let statResult = fstat(existingDescriptor, &existingInfo)
    let statError = errno
    guard statResult == 0 else {
      Darwin.close(existingDescriptor)
      throw NativeWorkbenchError.posix(operation: "读取待保存文件信息", code: statError)
    }
    guard (existingInfo.st_mode & S_IFMT) == S_IFREG else {
      Darwin.close(existingDescriptor)
      throw NativeWorkbenchError.notRegularFile
    }
    guard existingInfo.st_size <= Self.maximumTextFileSize else {
      Darwin.close(existingDescriptor)
      throw NativeWorkbenchError.externalModificationConflict
    }
    let existingData = try readData(from: existingDescriptor, limit: Self.maximumTextFileSize)
    Darwin.close(existingDescriptor)
    guard String(data: existingData, encoding: .utf8) == expectedText else {
      throw NativeWorkbenchError.externalModificationConflict
    }
    try Task.checkCancellation()

    let data = Data(text.utf8)
    guard data.count <= Self.maximumTextFileSize else { throw NativeWorkbenchError.fileTooLarge }
    let transaction = NativeSaveTransactionRecord(
      fileName: fileName,
      transactionID: UUID().uuidString,
      expectedOldSHA256: sha256(existingData),
      newSHA256: sha256(data)
    )
    let journalData = try JSONEncoder().encode(transaction)
    let journalDescriptor = Darwin.openat(
      parentDescriptor,
      transaction.journalName,
      O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,
      mode_t(0o600)
    )
    guard journalDescriptor >= 0 else {
      throw NativeWorkbenchError.posix(operation: "创建保存恢复日志", code: errno)
    }
    var journalExists = true
    var preserveRecovery = false
    defer {
      unlockFile(journalDescriptor)
      Darwin.close(journalDescriptor)
      if journalExists, !preserveRecovery {
        Darwin.unlinkat(parentDescriptor, transaction.journalName, 0)
      }
    }
    guard tryExclusiveFileLock(journalDescriptor) else {
      throw NativeWorkbenchError.posix(operation: "锁定保存恢复日志", code: errno)
    }
    try writeAll(journalData, to: journalDescriptor, operation: "写入保存恢复日志")
    guard Darwin.fsync(journalDescriptor) == 0,
          Darwin.fsync(parentDescriptor) == 0
    else { throw NativeWorkbenchError.posix(operation: "同步保存恢复日志", code: errno) }

    let permissions = mode_t(existingInfo.st_mode & 0o777)
    let newDescriptor = Darwin.openat(
      parentDescriptor,
      transaction.newName,
      O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,
      permissions
    )
    guard newDescriptor >= 0 else {
      throw NativeWorkbenchError.posix(operation: "创建原子保存临时文件", code: errno)
    }

    var newIsOpen = true
    var newExists = true
    var oldExists = false
    var published = false
    defer {
      if newIsOpen { Darwin.close(newDescriptor) }
      if !preserveRecovery {
        if newExists { Darwin.unlinkat(parentDescriptor, transaction.newName, 0) }
        if oldExists { Darwin.unlinkat(parentDescriptor, transaction.oldName, 0) }
      }
    }

    try writeAll(data, to: newDescriptor, operation: "写入临时文件")
    guard Darwin.fchmod(newDescriptor, permissions) == 0,
          Darwin.fsync(newDescriptor) == 0
    else {
      throw NativeWorkbenchError.posix(operation: "同步临时文件", code: errno)
    }
    try Task.checkCancellation()
    guard Darwin.close(newDescriptor) == 0 else {
      newIsOpen = false
      throw NativeWorkbenchError.posix(operation: "关闭临时文件", code: errno)
    }
    newIsOpen = false
    guard Darwin.fsync(parentDescriptor) == 0 else {
      throw NativeWorkbenchError.posix(operation: "同步保存准备状态", code: errno)
    }

    let claimResult = fileName.withCString { filePointer in
      transaction.oldName.withCString { oldPointer in
        Darwin.renameatx_np(
          parentDescriptor,
          filePointer,
          parentDescriptor,
          oldPointer,
          UInt32(RENAME_EXCL)
        )
      }
    }
    guard claimResult == 0 else {
      if errno == ENOENT { throw NativeWorkbenchError.externalModificationConflict }
      throw NativeWorkbenchError.posix(operation: "锁定待保存文件版本", code: errno)
    }
    oldExists = true
    guard Darwin.fsync(parentDescriptor) == 0 else {
      preserveRecovery = true
      throw NativeWorkbenchError.saveRecoveryRequired(fileName)
    }

    do {
      let claimedDescriptor = Darwin.openat(
        parentDescriptor,
        transaction.oldName,
        O_RDONLY | O_NOFOLLOW | O_CLOEXEC
      )
      guard claimedDescriptor >= 0 else {
        throw NativeWorkbenchError.externalModificationConflict
      }
      var claimedInfo = stat()
      let claimedStat = Darwin.fstat(claimedDescriptor, &claimedInfo)
      let claimedData = try readData(from: claimedDescriptor, limit: Self.maximumTextFileSize)
      Darwin.close(claimedDescriptor)
      guard claimedStat == 0,
            sameIdentity(existingInfo, claimedInfo),
            sha256(claimedData) == transaction.expectedOldSHA256,
            claimedData == existingData
      else { throw NativeWorkbenchError.externalModificationConflict }

      try Task.checkCancellation()
      let publishResult = transaction.newName.withCString { newPointer in
        fileName.withCString { filePointer in
          Darwin.renameatx_np(
            parentDescriptor,
            newPointer,
            parentDescriptor,
            filePointer,
            UInt32(RENAME_EXCL)
          )
        }
      }
      guard publishResult == 0 else {
        if errno == EEXIST {
          preserveRecovery = true
          throw NativeWorkbenchError.externalModificationConflict
        }
        preserveRecovery = true
        throw NativeWorkbenchError.saveRecoveryRequired(fileName)
      }
      newExists = false
      published = true
      guard Darwin.fsync(parentDescriptor) == 0 else {
        preserveRecovery = true
        throw NativeWorkbenchError.saveRecoveryRequired(fileName)
      }
      guard Darwin.unlinkat(parentDescriptor, transaction.oldName, 0) == 0 else {
        preserveRecovery = true
        throw NativeWorkbenchError.saveRecoveryRequired(fileName)
      }
      oldExists = false
      guard Darwin.unlinkat(parentDescriptor, transaction.journalName, 0) == 0 else {
        preserveRecovery = true
        throw NativeWorkbenchError.saveRecoveryRequired(fileName)
      }
      journalExists = false
      guard Darwin.fsync(parentDescriptor) == 0 else {
        throw NativeWorkbenchError.posix(operation: "同步工作区目录", code: errno)
      }
    } catch {
      if published {
        preserveRecovery = true
        throw error
      }
      var targetInfo = stat()
      let targetExists = Darwin.fstatat(
        parentDescriptor,
        fileName,
        &targetInfo,
        AT_SYMLINK_NOFOLLOW
      ) == 0
      guard !targetExists else {
        preserveRecovery = true
        throw error
      }
      let rollbackResult = transaction.oldName.withCString { oldPointer in
        fileName.withCString { filePointer in
          Darwin.renameatx_np(
            parentDescriptor,
            oldPointer,
            parentDescriptor,
            filePointer,
            UInt32(RENAME_EXCL)
          )
        }
      }
      guard rollbackResult == 0 else {
        preserveRecovery = true
        throw NativeWorkbenchError.posix(operation: "恢复并发保存冲突", code: errno)
      }
      oldExists = false
      guard Darwin.fsync(parentDescriptor) == 0 else {
        preserveRecovery = true
        throw NativeWorkbenchError.saveRecoveryRequired(fileName)
      }
      throw error
    }
  }

  func recoverPendingSaveTransactions(in directoryURL: URL) throws -> Set<String> {
    let descriptor = try openDirectory(relativeComponents(for: directoryURL))
    defer { Darwin.close(descriptor) }
    return try recoverSaveTransactions(in: descriptor)
  }

  func recoverPendingCopyTransactions(in directoryURL: URL) throws {
    let descriptor = try openDirectory(relativeComponents(for: directoryURL))
    defer { Darwin.close(descriptor) }
    try recoverCopyTransactions(in: descriptor)
  }

  private func recoverCopyTransactions(in directoryDescriptor: Int32) throws {
    let streamDescriptor = Darwin.openat(
      directoryDescriptor,
      ".",
      O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
    )
    guard streamDescriptor >= 0, let directory = Darwin.fdopendir(streamDescriptor) else {
      if streamDescriptor >= 0 { Darwin.close(streamDescriptor) }
      throw NativeWorkbenchError.posix(operation: "扫描复制恢复日志", code: errno)
    }
    var journalNames: [String] = []
    while let entry = Darwin.readdir(directory) {
      let name = withUnsafePointer(to: &entry.pointee.d_name) { namePointer in
        namePointer.withMemoryRebound(to: CChar.self, capacity: Int(MAXNAMLEN) + 1) {
          String(validatingUTF8: $0)
        }
      }
      if let name, name.hasPrefix(NativeCopyTransactionRecord.journalPrefix) {
        journalNames.append(name)
      }
    }
    Darwin.closedir(directory)

    for journalName in journalNames {
      let journalDescriptor = Darwin.openat(
        directoryDescriptor,
        journalName,
        O_RDWR | O_NOFOLLOW | O_CLOEXEC
      )
      guard journalDescriptor >= 0 else {
        if errno == ENOENT { continue }
        throw NativeWorkbenchError.posix(operation: "打开复制恢复日志", code: errno)
      }
      guard tryExclusiveFileLock(journalDescriptor) else {
        let lockError = errno
        Darwin.close(journalDescriptor)
        if lockError == EACCES || lockError == EAGAIN { continue }
        throw NativeWorkbenchError.posix(operation: "锁定复制恢复日志", code: lockError)
      }
      do {
        let data = try readData(from: journalDescriptor, limit: 16 * 1024)
        let transaction = try JSONDecoder().decode(NativeCopyTransactionRecord.self, from: data)
        guard transaction.version == 1,
              transaction.journalName == journalName,
              transaction.stagingName.hasPrefix(NativeCopyTransactionRecord.stagingPrefix),
              (try? validatedLeafName(transaction.sourceName)) == transaction.sourceName,
              (try? validatedLeafName(transaction.stagingName)) == transaction.stagingName
        else { throw NativeWorkbenchError.copyRecoveryRequired(journalName) }
        try removeOwnedItem(named: transaction.stagingName, in: directoryDescriptor)
        guard Darwin.unlinkat(directoryDescriptor, journalName, 0) == 0,
              Darwin.fsync(directoryDescriptor) == 0
        else { throw NativeWorkbenchError.posix(operation: "完成复制恢复", code: errno) }
      } catch {
        unlockFile(journalDescriptor)
        Darwin.close(journalDescriptor)
        throw error
      }
      unlockFile(journalDescriptor)
      Darwin.close(journalDescriptor)
    }
  }

  private func recoverSaveTransactions(in directoryDescriptor: Int32) throws -> Set<String> {
    let streamDescriptor = Darwin.openat(
      directoryDescriptor,
      ".",
      O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
    )
    guard streamDescriptor >= 0, let directory = Darwin.fdopendir(streamDescriptor) else {
      if streamDescriptor >= 0 { Darwin.close(streamDescriptor) }
      throw NativeWorkbenchError.posix(operation: "扫描保存恢复日志", code: errno)
    }
    var journalNames: [String] = []
    while let entry = Darwin.readdir(directory) {
      let name = withUnsafePointer(to: &entry.pointee.d_name) { namePointer in
        namePointer.withMemoryRebound(to: CChar.self, capacity: Int(MAXNAMLEN) + 1) {
          String(validatingUTF8: $0)
        }
      }
      if let name, name.hasPrefix(NativeSaveTransactionRecord.journalPrefix) {
        journalNames.append(name)
      }
    }
    Darwin.closedir(directory)

    var unresolved = Set<String>()
    for journalName in journalNames {
      if let fileName = try recoverSaveTransaction(
        journalName: journalName,
        directoryDescriptor: directoryDescriptor
      ) {
        unresolved.insert(fileName)
      }
    }
    return unresolved
  }

  private func recoverSaveTransaction(
    journalName: String,
    directoryDescriptor: Int32
  ) throws -> String? {
    let journalDescriptor = Darwin.openat(
      directoryDescriptor,
      journalName,
      O_RDWR | O_NOFOLLOW | O_CLOEXEC
    )
    guard journalDescriptor >= 0 else {
      if errno == ENOENT { return nil }
      throw NativeWorkbenchError.posix(operation: "打开保存恢复日志", code: errno)
    }
    defer { Darwin.close(journalDescriptor) }
    guard tryExclusiveFileLock(journalDescriptor) else {
      if errno == EACCES || errno == EAGAIN { return journalName }
      throw NativeWorkbenchError.posix(operation: "锁定保存恢复日志", code: errno)
    }
    defer { unlockFile(journalDescriptor) }
    let journalData = try readData(from: journalDescriptor, limit: 16 * 1024)
    let transaction: NativeSaveTransactionRecord
    do {
      transaction = try JSONDecoder().decode(NativeSaveTransactionRecord.self, from: journalData)
    } catch {
      let suffix = journalName.dropFirst(NativeSaveTransactionRecord.journalPrefix.count)
      let derivedNewName = NativeSaveTransactionRecord.newPrefix + suffix
      let derivedOldName = NativeSaveTransactionRecord.oldPrefix + suffix
      guard ordinaryFileInfo(named: derivedOldName, in: directoryDescriptor) == .missing else {
        throw NativeWorkbenchError.saveRecoveryRequired(journalName)
      }
      let newState = ordinaryFileInfo(named: derivedNewName, in: directoryDescriptor)
      guard newState != .invalid else {
        throw NativeWorkbenchError.saveRecoveryRequired(journalName)
      }
      if newState == .file {
        guard Darwin.unlinkat(directoryDescriptor, derivedNewName, 0) == 0 else {
          throw NativeWorkbenchError.saveRecoveryRequired(journalName)
        }
      }
      try finishRecoveredTransaction(journalName, in: directoryDescriptor)
      return nil
    }
    guard transaction.version == 1,
          transaction.journalName == journalName,
          transaction.newName.hasPrefix(NativeSaveTransactionRecord.newPrefix),
          transaction.oldName.hasPrefix(NativeSaveTransactionRecord.oldPrefix),
          (try? validatedLeafName(transaction.fileName)) == transaction.fileName,
          (try? validatedLeafName(transaction.newName)) == transaction.newName,
          (try? validatedLeafName(transaction.oldName)) == transaction.oldName
    else { throw NativeWorkbenchError.saveRecoveryRequired(transaction.fileName) }

    let target = ordinaryFileInfo(named: transaction.fileName, in: directoryDescriptor)
    let new = ordinaryFileInfo(named: transaction.newName, in: directoryDescriptor)
    let old = ordinaryFileInfo(named: transaction.oldName, in: directoryDescriptor)
    if [target, new, old].contains(where: { $0 == .invalid }) {
      return transaction.fileName
    }

    switch (target, new, old) {
    case (.file, .missing, .file):
      guard try sha256OfFile(named: transaction.fileName, in: directoryDescriptor)
        == transaction.newSHA256
      else { return transaction.fileName }
      guard Darwin.unlinkat(directoryDescriptor, transaction.oldName, 0) == 0 else {
        return transaction.fileName
      }
      try finishRecoveredTransaction(journalName, in: directoryDescriptor)
      return nil
    case (.missing, .file, .file):
      let restored = transaction.oldName.withCString { oldPointer in
        transaction.fileName.withCString { filePointer in
          Darwin.renameatx_np(
            directoryDescriptor,
            oldPointer,
            directoryDescriptor,
            filePointer,
            UInt32(RENAME_EXCL)
          )
        }
      }
      guard restored == 0,
            Darwin.unlinkat(directoryDescriptor, transaction.newName, 0) == 0
      else { return transaction.fileName }
      try finishRecoveredTransaction(journalName, in: directoryDescriptor)
      return nil
    case (.file, .file, .missing):
      guard Darwin.unlinkat(directoryDescriptor, transaction.newName, 0) == 0 else {
        return transaction.fileName
      }
      try finishRecoveredTransaction(journalName, in: directoryDescriptor)
      return nil
    case (.file, .missing, .missing):
      try finishRecoveredTransaction(journalName, in: directoryDescriptor)
      return nil
    case (.missing, .missing, .file):
      let restored = transaction.oldName.withCString { oldPointer in
        transaction.fileName.withCString { filePointer in
          Darwin.renameatx_np(
            directoryDescriptor,
            oldPointer,
            directoryDescriptor,
            filePointer,
            UInt32(RENAME_EXCL)
          )
        }
      }
      guard restored == 0 else { return transaction.fileName }
      try finishRecoveredTransaction(journalName, in: directoryDescriptor)
      return nil
    case (.missing, .missing, .missing):
      try finishRecoveredTransaction(journalName, in: directoryDescriptor)
      return nil
    default:
      return transaction.fileName
    }
  }

  private enum RecoveryEntry: Equatable {
    case file
    case invalid
    case missing
  }

  private func ordinaryFileInfo(named name: String, in directoryDescriptor: Int32) -> RecoveryEntry {
    var info = stat()
    guard Darwin.fstatat(directoryDescriptor, name, &info, AT_SYMLINK_NOFOLLOW) == 0 else {
      return errno == ENOENT ? .missing : .invalid
    }
    return (info.st_mode & S_IFMT) == S_IFREG ? .file : .invalid
  }

  private func finishRecoveredTransaction(
    _ journalName: String,
    in directoryDescriptor: Int32
  ) throws {
    guard Darwin.unlinkat(directoryDescriptor, journalName, 0) == 0,
          Darwin.fsync(directoryDescriptor) == 0
    else { throw NativeWorkbenchError.posix(operation: "完成保存恢复", code: errno) }
  }

  private func sha256OfFile(named name: String, in directoryDescriptor: Int32) throws -> String {
    let descriptor = Darwin.openat(
      directoryDescriptor,
      name,
      O_RDONLY | O_NOFOLLOW | O_CLOEXEC
    )
    guard descriptor >= 0 else {
      throw NativeWorkbenchError.posix(operation: "打开保存恢复文件", code: errno)
    }
    defer { Darwin.close(descriptor) }
    return sha256(try readData(from: descriptor, limit: Self.maximumTextFileSize))
  }

  private func readData(from descriptor: Int32, limit: Int) throws -> Data {
    guard Darwin.lseek(descriptor, 0, SEEK_SET) >= 0 else {
      throw NativeWorkbenchError.posix(operation: "定位文件", code: errno)
    }
    var output = Data()
    var buffer = [UInt8](repeating: 0, count: 64 * 1024)
    while true {
      try Task.checkCancellation()
      let count = Darwin.read(descriptor, &buffer, buffer.count)
      if count == 0 { return output }
      guard count > 0 else {
        if errno == EINTR { continue }
        throw NativeWorkbenchError.posix(operation: "读取文件", code: errno)
      }
      guard output.count <= limit - count else { throw NativeWorkbenchError.fileTooLarge }
      output.append(contentsOf: buffer.prefix(count))
    }
  }

  private func writeAll(_ data: Data, to descriptor: Int32, operation: String) throws {
    try data.withUnsafeBytes { rawBuffer in
      guard let baseAddress = rawBuffer.baseAddress else { return }
      var offset = 0
      while offset < rawBuffer.count {
        let count = Darwin.write(
          descriptor,
          baseAddress.advanced(by: offset),
          rawBuffer.count - offset
        )
        guard count > 0 else {
          if count < 0, errno == EINTR { continue }
          throw NativeWorkbenchError.posix(
            operation: operation,
            code: count == 0 ? EIO : errno
          )
        }
        offset += count
      }
    }
  }

  private func tryExclusiveFileLock(_ descriptor: Int32) -> Bool {
    arkWorkbenchFlock(descriptor, LOCK_EX | LOCK_NB) == 0
  }

  private func unlockFile(_ descriptor: Int32) {
    _ = arkWorkbenchFlock(descriptor, LOCK_UN)
  }

  private func sha256(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  }

  private func relativeComponents(for url: URL) throws -> [String] {
    guard url.isFileURL, !url.pathComponents.contains("..") else {
      throw NativeWorkbenchError.pathOutsideRoot
    }
    let candidateComponents = url.standardizedFileURL.pathComponents
    let rootComponents = rootURL.pathComponents
    guard candidateComponents.count >= rootComponents.count,
          Array(candidateComponents.prefix(rootComponents.count)) == rootComponents
    else {
      throw NativeWorkbenchError.pathOutsideRoot
    }
    let relative = Array(candidateComponents.dropFirst(rootComponents.count))
    guard relative.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." && !$0.contains("/") }) else {
      throw NativeWorkbenchError.pathOutsideRoot
    }
    return relative
  }

  private func validatedLeafName(_ rawName: String) throws -> String {
    let name = rawName.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !name.isEmpty,
          name != ".", name != "..",
          !name.contains("/"), !name.contains("\0"),
          name.utf8.count <= Int(NAME_MAX)
    else { throw NativeWorkbenchError.invalidItemName }
    return name
  }

  private func requireOrdinaryItem(named name: String, in directoryDescriptor: Int32) throws {
    var info = stat()
    guard Darwin.fstatat(directoryDescriptor, name, &info, AT_SYMLINK_NOFOLLOW) == 0 else {
      throw NativeWorkbenchError.posix(operation: "读取项目", code: errno)
    }
    let type = info.st_mode & S_IFMT
    guard type == S_IFREG || type == S_IFDIR else {
      throw NativeWorkbenchError.notRegularFile
    }
  }

  private func openDirectory(_ components: [String]) throws -> Int32 {
    var descriptor = Darwin.openat(
      rootDescriptor,
      ".",
      O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
    )
    guard descriptor >= 0 else {
      throw NativeWorkbenchError.posix(operation: "打开工作区句柄", code: errno)
    }
    for component in components {
      let next = Darwin.openat(descriptor, component, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
      let code = errno
      Darwin.close(descriptor)
      guard next >= 0 else {
        throw NativeWorkbenchError.posix(operation: "打开目录 \(component)", code: code)
      }
      descriptor = next
    }
    return descriptor
  }

  private func openFile(_ components: [String], flags: Int32) throws -> Int32 {
    guard let fileName = components.last else { throw NativeWorkbenchError.notRegularFile }
    let parentDescriptor = try openDirectory(Array(components.dropLast()))
    defer { Darwin.close(parentDescriptor) }
    let descriptor = Darwin.openat(parentDescriptor, fileName, flags | O_NOFOLLOW | O_CLOEXEC)
    guard descriptor >= 0 else {
      throw NativeWorkbenchError.posix(operation: "打开文件", code: errno)
    }
    return descriptor
  }
}

enum NativeWorkbenchError: LocalizedError {
  case invalidRoot(String)
  case pathOutsideRoot
  case notRegularFile
  case fileTooLarge
  case notUTF8Text
  case externalModificationConflict
  case saveRecoveryRequired(String)
  case copyRecoveryRequired(String)
  case trashUnavailable
  case invalidItemName
  case itemAlreadyExists
  case posix(operation: String, code: Int32)

  var errorDescription: String? {
    switch self {
    case let .invalidRoot(message): return message
    case .pathOutsideRoot: return "拒绝访问工作区根目录之外的路径"
    case .notRegularFile: return "所选项目不是普通文件"
    case .fileTooLarge: return "文件超过 8 MiB 编辑上限"
    case .notUTF8Text: return "仅支持 UTF-8 文本文件"
    case .externalModificationConflict: return "文件已被其他程序修改；请重新打开并比较后再保存"
    case .saveRecoveryRequired(let name): return "检测到未完成的安全保存：\(name)；原版本已保留，请重试恢复"
    case .copyRecoveryRequired(let name): return "检测到无法自动恢复的复制事务：\(name)"
    case .trashUnavailable: return "该工作区与当前用户废纸篓不在同一磁盘，已安全保留原项目"
    case .invalidItemName: return "文件名无效"
    case .itemAlreadyExists: return "目标位置已存在同名项目"
    case let .posix(operation, code):
      return "\(operation)失败：\(String(cString: strerror(code)))"
    }
  }
}

enum NativeProcessStopReason: String, Equatable, Sendable {
  case cancelled
  case outputLimit
  case timedOut
}

final class NativeProcessCancellation: @unchecked Sendable {
  private let lock = NSLock()
  private var cancelled = false

  func cancel() {
    lock.lock()
    cancelled = true
    lock.unlock()
  }

  var isCancelled: Bool {
    lock.lock()
    defer { lock.unlock() }
    return cancelled
  }
}

struct NativeProcessCapture: Equatable, Sendable {
  let output: String
  let exitCode: Int32
  let stopReason: NativeProcessStopReason?

  init(output: String, exitCode: Int32, stopReason: NativeProcessStopReason? = nil) {
    self.output = output
    self.exitCode = exitCode
    self.stopReason = stopReason
  }

  static func run(
    executableURL: URL,
    arguments: [String],
    currentDirectoryURL: URL,
    outputByteLimit: Int = 2 * 1024 * 1024,
    timeoutNanoseconds: UInt64 = 30_000_000_000,
    cancellation: NativeProcessCancellation? = nil
  ) -> NativeProcessCapture {
    if cancellation?.isCancelled == true {
      return NativeProcessCapture(
        output: "… Git operation cancelled before launch …\n",
        exitCode: -1,
        stopReason: .cancelled
      )
    }
    guard executableURL.isFileURL,
          executableURL.path.hasPrefix("/"),
          currentDirectoryURL.isFileURL,
          currentDirectoryURL.path.hasPrefix("/"),
          outputByteLimit > 0,
          timeoutNanoseconds > 0
    else { return NativeProcessCapture(output: "invalid process request", exitCode: -1) }

    var descriptors = [Int32](repeating: -1, count: 2)
    guard descriptors.withUnsafeMutableBufferPointer({ Darwin.pipe($0.baseAddress!) }) == 0 else {
      return failure("create Git output pipe", errno)
    }
    let readDescriptor = descriptors[0]
    let writeDescriptor = descriptors[1]
    defer { if descriptors[0] >= 0 { Darwin.close(descriptors[0]) } }
    defer { if descriptors[1] >= 0 { Darwin.close(descriptors[1]) } }
    let readFlags = Darwin.fcntl(readDescriptor, F_GETFL)
    guard readFlags >= 0,
          Darwin.fcntl(readDescriptor, F_SETFL, readFlags | O_NONBLOCK) == 0,
          Darwin.fcntl(readDescriptor, F_SETFD, FD_CLOEXEC) == 0,
          Darwin.fcntl(writeDescriptor, F_SETFD, FD_CLOEXEC) == 0
    else { return failure("configure Git output pipe", errno) }

    var actions: posix_spawn_file_actions_t?
    var actionResult = Darwin.posix_spawn_file_actions_init(&actions)
    guard actionResult == 0 else { return failure("initialize Git file actions", actionResult) }
    defer { Darwin.posix_spawn_file_actions_destroy(&actions) }
    actionResult = Darwin.posix_spawn_file_actions_adddup2(&actions, writeDescriptor, STDOUT_FILENO)
    guard actionResult == 0 else { return failure("map Git stdout", actionResult) }
    actionResult = Darwin.posix_spawn_file_actions_adddup2(&actions, writeDescriptor, STDERR_FILENO)
    guard actionResult == 0 else { return failure("map Git stderr", actionResult) }
    actionResult = Darwin.posix_spawn_file_actions_addclose(&actions, readDescriptor)
    guard actionResult == 0 else { return failure("close Git read side", actionResult) }
    actionResult = Darwin.posix_spawn_file_actions_addclose(&actions, writeDescriptor)
    guard actionResult == 0 else { return failure("close Git write side", actionResult) }
    actionResult = currentDirectoryURL.path.withCString {
      Darwin.posix_spawn_file_actions_addchdir_np(&actions, $0)
    }
    guard actionResult == 0 else { return failure("set Git working directory", actionResult) }

    var attributes: posix_spawnattr_t?
    var attributeResult = Darwin.posix_spawnattr_init(&attributes)
    guard attributeResult == 0 else { return failure("initialize Git process attributes", attributeResult) }
    defer { Darwin.posix_spawnattr_destroy(&attributes) }
    var emptyMask = sigset_t()
    Darwin.sigemptyset(&emptyMask)
    var defaultSignals = sigset_t()
    Darwin.sigemptyset(&defaultSignals)
    for signal in [SIGINT, SIGQUIT, SIGTERM, SIGCHLD, SIGPIPE] {
      Darwin.sigaddset(&defaultSignals, signal)
    }
    attributeResult = Darwin.posix_spawnattr_setsigmask(&attributes, &emptyMask)
    guard attributeResult == 0 else { return failure("set Git signal mask", attributeResult) }
    attributeResult = Darwin.posix_spawnattr_setsigdefault(&attributes, &defaultSignals)
    guard attributeResult == 0 else { return failure("set Git default signals", attributeResult) }
    attributeResult = Darwin.posix_spawnattr_setpgroup(&attributes, 0)
    guard attributeResult == 0 else { return failure("set Git process group", attributeResult) }
    let spawnFlags = POSIX_SPAWN_SETPGROUP
      | POSIX_SPAWN_SETSIGMASK
      | POSIX_SPAWN_SETSIGDEF
      | POSIX_SPAWN_CLOEXEC_DEFAULT
    attributeResult = Darwin.posix_spawnattr_setflags(
      &attributes,
      Int16(truncatingIfNeeded: spawnFlags)
    )
    guard attributeResult == 0 else { return failure("set Git spawn flags", attributeResult) }

    var environment = ProcessInfo.processInfo.environment
    environment["GIT_TERMINAL_PROMPT"] = "0"
    environment["GIT_PAGER"] = "cat"
    environment["GIT_EDITOR"] = "true"
    environment["GIT_SEQUENCE_EDITOR"] = "true"
    let environmentValues = environment.keys.sorted().map { "\($0)=\(environment[$0]!)" }
    let argumentValues = [executableURL.path] + arguments
    var processID: pid_t = 0
    let spawnResult: Int32
    if cancellation?.isCancelled == true {
      return NativeProcessCapture(
        output: "… Git operation cancelled before launch …\n",
        exitCode: -1,
        stopReason: .cancelled
      )
    }
    do {
      spawnResult = try withNativeProcessCStringArray(argumentValues) { argumentPointers in
        try withNativeProcessCStringArray(environmentValues) { environmentPointers in
          executableURL.path.withCString { executablePath in
            Darwin.posix_spawn(
              &processID,
              executablePath,
              &actions,
              &attributes,
              argumentPointers,
              environmentPointers
            )
          }
        }
      }
    } catch {
      return NativeProcessCapture(output: error.localizedDescription, exitCode: -1)
    }
    guard spawnResult == 0, processID > 1 else {
      return failure("start Git process", spawnResult)
    }
    Darwin.close(writeDescriptor)
    descriptors[1] = -1

    let startedAt = DispatchTime.now().uptimeNanoseconds
    let deadline = startedAt &+ timeoutNanoseconds
    var output = Data()
    output.reserveCapacity(min(outputByteLimit, 256 * 1024))
    var stopReason: NativeProcessStopReason?
    var terminationRequestedAt: UInt64?
    var sentKill = false
    var childStatus: Int32 = 0
    var childReaped = false
    var pipeClosed = false
    var cleanupRequestedAt: UInt64?
    var pollDescriptor = pollfd(
      fd: readDescriptor,
      events: Int16(POLLIN | POLLHUP | POLLERR),
      revents: 0
    )
    var buffer = [UInt8](repeating: 0, count: 64 * 1024)

    while !childReaped || !pipeClosed {
      let now = DispatchTime.now().uptimeNanoseconds
      if stopReason == nil {
        if cancellation?.isCancelled == true {
          stopReason = .cancelled
        } else if now >= deadline {
          stopReason = .timedOut
        }
      }
      if stopReason != nil, terminationRequestedAt == nil {
        signalOwnedProcessGroup(processID, signal: SIGTERM)
        terminationRequestedAt = now
      } else if let terminationRequestedAt,
                !sentKill,
                now &- terminationRequestedAt >= 500_000_000 {
        signalOwnedProcessGroup(processID, signal: SIGKILL)
        sentKill = true
      }

      if !childReaped {
        let waited = Darwin.waitpid(processID, &childStatus, WNOHANG)
        if waited == processID || (waited == -1 && errno == ECHILD) {
          childReaped = true
        } else if waited == -1 && errno != EINTR {
          stopReason = stopReason ?? .cancelled
          signalOwnedProcessGroup(processID, signal: SIGKILL)
          childReaped = true
        }
      }

      if childReaped, cleanupRequestedAt == nil, processGroupExists(processID) {
        signalOwnedProcessGroup(processID, signal: SIGTERM)
        cleanupRequestedAt = now
      } else if let cleanupRequestedAt,
                now &- cleanupRequestedAt >= 500_000_000,
                processGroupExists(processID) {
        signalOwnedProcessGroup(processID, signal: SIGKILL)
      }

      pollDescriptor.revents = 0
      let polled = Darwin.poll(&pollDescriptor, 1, 20)
      if polled > 0 {
        while true {
          let count = buffer.withUnsafeMutableBytes { bytes in
            Darwin.read(readDescriptor, bytes.baseAddress, bytes.count)
          }
          if count > 0 {
            let retained = min(count, max(0, outputByteLimit - output.count))
            if retained > 0 { output.append(contentsOf: buffer.prefix(retained)) }
            if retained < count, stopReason == nil {
              stopReason = .outputLimit
            }
            continue
          }
          if count == 0 {
            pipeClosed = true
          } else if errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR {
            pipeClosed = true
          }
          break
        }
      } else if polled < 0, errno != EINTR {
        pipeClosed = true
      }

      if childReaped,
         !processGroupExists(processID),
         !pipeClosed,
         (pollDescriptor.revents & Int16(POLLHUP | POLLERR)) != 0 {
        pipeClosed = true
      }
      if sentKill, childReaped, now &- (terminationRequestedAt ?? now) >= 2_000_000_000 {
        pipeClosed = true
      }
    }

    Darwin.close(readDescriptor)
    descriptors[0] = -1
    if processGroupExists(processID) {
      signalOwnedProcessGroup(processID, signal: SIGKILL)
    }
    var rendered = String(decoding: output, as: UTF8.self)
    if let stopReason {
      let reason: String
      switch stopReason {
      case .cancelled: reason = "Git operation cancelled"
      case .outputLimit: reason = "Git output exceeded \(outputByteLimit) bytes"
      case .timedOut: reason = "Git operation timed out"
      }
      rendered += "\n… \(reason) …\n"
      return NativeProcessCapture(output: rendered, exitCode: -1, stopReason: stopReason)
    }
    return NativeProcessCapture(
      output: rendered,
      exitCode: decodeExitStatus(childStatus),
      stopReason: nil
    )
  }

  private static func decodeExitStatus(_ status: Int32) -> Int32 {
    let signal = status & 0x7F
    return signal == 0 ? ((status >> 8) & 0xFF) : 128 + signal
  }

  private static func processGroupExists(_ processGroupID: pid_t) -> Bool {
    guard processGroupID > 1 else { return false }
    if Darwin.kill(-processGroupID, 0) == 0 { return true }
    return errno == EPERM
  }

  private static func signalOwnedProcessGroup(_ processGroupID: pid_t, signal: Int32) {
    guard processGroupID > 1, processGroupExists(processGroupID) else { return }
    _ = Darwin.kill(-processGroupID, signal)
  }

  private static func failure(_ operation: String, _ code: Int32) -> NativeProcessCapture {
    NativeProcessCapture(
      output: "\(operation): \(String(cString: strerror(code)))",
      exitCode: -1
    )
  }
}

private func withNativeProcessCStringArray<Result>(
  _ values: [String],
  _ body: (UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>) throws -> Result
) throws -> Result {
  var pointers: [UnsafeMutablePointer<CChar>?] = []
  pointers.reserveCapacity(values.count + 1)
  for value in values {
    guard let pointer = Darwin.strdup(value) else {
      pointers.compactMap { $0 }.forEach { Darwin.free(UnsafeMutableRawPointer($0)) }
      throw NativeWorkbenchError.posix(operation: "准备进程参数", code: ENOMEM)
    }
    pointers.append(pointer)
  }
  pointers.append(nil)
  defer {
    pointers.compactMap { $0 }.forEach { Darwin.free(UnsafeMutableRawPointer($0)) }
  }
  return try pointers.withUnsafeMutableBufferPointer { buffer in
    try body(buffer.baseAddress!)
  }
}
