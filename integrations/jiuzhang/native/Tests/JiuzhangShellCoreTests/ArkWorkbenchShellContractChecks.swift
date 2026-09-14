import Foundation
import JiuzhangShellCore
@testable import JiuzhangShellUI

@MainActor
func runArkWorkbenchShellContractChecks() async {
  check(
    ArkWorkbenchRootRequestPolicy.decide(
      activeRootPath: "/workspace/a",
      requestedRootPath: "/workspace/b",
      hasDirtyFiles: true,
      showsLauncher: false
    ) == .deferSwitch
      && ArkWorkbenchRootRequestPolicy.decide(
        activeRootPath: "/workspace/a",
        requestedRootPath: "/workspace/a",
        hasDirtyFiles: true,
        showsLauncher: false
      ) == .unchanged
      && ArkWorkbenchRootRequestPolicy.decide(
        activeRootPath: "/workspace/a",
        requestedRootPath: "/workspace/b",
        hasDirtyFiles: false,
        showsLauncher: false
      ) == .adopt
      && ArkWorkbenchRootRequestPolicy.decide(
        activeRootPath: nil,
        requestedRootPath: "/workspace/b",
        hasDirtyFiles: true,
        showsLauncher: true
      ) == .adopt,
    "native Workbench defers only a dirty visible root switch while preserving same-root and launcher transitions"
  )
  let initialTerminal = NativeWorkbenchTabsState(initial: .terminal)
  let initialBrowser = NativeWorkbenchTabsState(initial: .browser)
  check(
    initialTerminal.tabs.map(\.id) == ["terminal:1"]
      && initialBrowser.tabs.map(\.id) == ["browser:1"],
    "a newly mounted Workbench consumes its initial non-singleton tool exactly once"
  )
  let rootURL = contractNativeRoot.appendingPathComponent(
    "Sources/JiuzhangShellUI/ArkRootView.swift"
  )
  let workbenchURL = contractNativeRoot.appendingPathComponent(
    "Sources/JiuzhangShellUI/NativeWorkbenchView.swift"
  )
  let outlineURL = contractNativeRoot.appendingPathComponent(
    "Sources/JiuzhangShellUI/NativeFileOutlineView.swift"
  )
  let gitOutlineURL = contractNativeRoot.appendingPathComponent(
    "Sources/JiuzhangShellUI/NativeGitChangeOutlineView.swift"
  )
  let browserURL = contractNativeRoot.appendingPathComponent(
    "Sources/JiuzhangShellUI/NativeWorkbenchBrowserView.swift"
  )
  let terminalURL = contractNativeRoot.appendingPathComponent(
    "Sources/JiuzhangShellUI/NativePTYTerminalView.swift"
  )
  let terminalProcessURL = contractNativeRoot.appendingPathComponent(
    "Sources/JiuzhangShellUI/NativePTYProcess.swift"
  )
  guard
    let root = try? String(contentsOf: rootURL, encoding: .utf8),
    let workbench = try? String(contentsOf: workbenchURL, encoding: .utf8),
    let outline = try? String(contentsOf: outlineURL, encoding: .utf8),
    let gitOutline = try? String(contentsOf: gitOutlineURL, encoding: .utf8),
    let browser = try? String(contentsOf: browserURL, encoding: .utf8),
    let terminal = try? String(contentsOf: terminalURL, encoding: .utf8),
    let terminalProcess = try? String(contentsOf: terminalProcessURL, encoding: .utf8)
  else {
    check(false, "native workbench shell sources are readable")
    return
  }

  let rootPolicy = workbenchShellSlice(
    root,
    from: "private var workbenchRoot: WorkbenchRootSelection?",
    through: "private func chooseWorkbenchRoot()"
  )
  check(
    rootPolicy?.contains("model.selectedWorkspace") == true
      && rootPolicy?.contains("model.selectedSession?.cwd") == true
      && rootPolicy?.contains("return nil") == true
      && rootPolicy?.contains("defaultSessionWorkspace") == false,
    "native workbench uses explicit workspace/session roots and never invents Default Workspace"
  )
  check(
    root.contains("NativeWorkbenchRootChooser(")
      && root.contains("appModel: model")
      && !root.contains("model.focusChatComposer()"),
    "native root wires explicit folder selection without creating a second chat surface"
  )
  check(
    root.contains(".environment(\\.arkOpenToolFile, openToolFile)")
      && root.contains("private func openToolFile(_ rawPath: String)")
      && root.contains("access.validatedRegularFileURL(candidate)")
      && root.contains("workbenchHasDirtyFiles")
      && root.contains("model.requestWorkbenchFileOpen(rootURL: access.rootURL, fileURL: fileURL)")
      && root.contains("ark.chat.tool.open-file")
      && workbench.contains(".onReceive(appModel.$workbenchFileOpenRequest.compactMap { $0 })")
      && workbench.contains("request.rootPath == model.rootURL.standardizedFileURL.path")
      && workbench.contains("appModel.completeWorkbenchFileOpenRequest(request.id)")
      && workbench.contains("func validatedRegularFileURL(_ url: URL) throws -> URL")
      && workbench.contains("let descriptor = try openFile(components, flags: O_RDONLY | O_NONBLOCK)"),
    "native tool file references route through one root-confined Files owner and fail closed across dirty roots"
  )
  let workbenchChrome = workbenchShellSlice(
    workbench,
    from: "public var body: some View",
    through: ".onChange(of: model.fileTabs.hasDirtyTabs)"
  )
  let loadedEditor = workbenchShellSlice(
    workbench,
    from: "private var loadedEditor: some View",
    through: "private struct NativeGitInspector"
  )
  check(
    workbenchChrome?.contains("NativeWorkbenchTabBar(") == true
      && workbenchChrome?.contains(".zIndex(20)") == true
      && workbenchChrome?.contains("NativeFilesWorkspace(model: model, language: language)") == true
      && workbenchChrome?.contains(".clipped()") == true
      && loadedEditor?.contains(".accessibilityIdentifier(\"ark.files.code-editor\")") == true
      && loadedEditor?.contains(".background(NativeWorkbenchPalette.background)") == true
      && loadedEditor?.contains(".clipped()") == true,
    "native TextKit editor is clipped below a higher-z Workbench and Files chrome"
  )
  let rootWorkbenchDispatch = workbenchShellSlice(
    root,
    from: "ArkRootSplitLayout(",
    through: ".accessibilityHidden(!showWorkbench)"
  )
  let rootSplitLayout = workbenchShellSlice(
    root,
    from: "private struct ArkRootSplitLayout: Layout",
    through: "private struct NativeSidebar"
  )
  check(
    rootWorkbenchDispatch?.contains("NativeMainArea(model: model)") == true
      && rootWorkbenchDispatch?.contains("transcriptTextSelectionEnabled") == false
      && rootWorkbenchDispatch?.contains("NativeConversationWorkbenchLauncher(") == true
      && rootWorkbenchDispatch?.contains("workbenchShowsLauncher") == true
      && rootWorkbenchDispatch?.contains("workbenchSurface") == true
      && rootWorkbenchDispatch?.contains("mainAreaMinimumWidth") == true
      && root.contains("chatMainAreaMinimumWidth: CGFloat = 520")
      && root.contains("analysisMainAreaMinimumWidth: CGFloat = 840")
      && root.contains("case .trajectory, .wiki: analysisMainAreaMinimumWidth")
      && rootWorkbenchDispatch?.contains("workbenchPanelMinimumWidth") == true
      && rootWorkbenchDispatch?.contains("max(workbenchPanelMinimumWidth, origin - value.translation.width)") == true
      && rootWorkbenchDispatch?.contains("ark.workbench.divider") == true
      && rootSplitLayout?.contains("bounds.width - mainMinimumWidth - dividerWidth") == true
      && rootSplitLayout?.contains("min(maximumWorkbenchWidth, max(minimumWorkbenchWidth, requestedWorkbenchWidth))") == true
      && rootSplitLayout?.contains("subviews[0].place(") == true
      && rootSplitLayout?.contains("subviews[2].place(") == true
      && root.contains("GeometryReader { proxy in\n        let workbenchMaximumWidth") == false
      && root.contains("private var workbenchSurface: some View")
      && root.contains("requestWorkbenchRoot(selection)")
      && root.contains("pendingWorkbenchRoot")
      && root.contains("ArkWorkbenchRootRequestPolicy.decide(")
      && root.contains("case .deferSwitch:")
      && root.contains("case .adopt:")
      && root.contains(".onDirtyStateChange { workbenchHasDirtyFiles = $0 }")
      && root.contains(".onChange(of: model.selectedWorkspaceID)")
      && root.contains(".onChange(of: model.selectedSessionID)")
      && root.contains("workbenchShowsLauncher = true"),
    "native conversation and right panel use a bounded divider and switch canonical roots without discarding dirty Files tabs"
  )
  check(
    rootSplitLayout?.contains("of guide: HorizontalAlignment") == true
      && rootSplitLayout?.contains("of guide: VerticalAlignment") == true
      && rootSplitLayout?.components(separatedBy: ") -> CGFloat? {\n    nil\n  }").count == 3,
    "native root split rejects default explicit-alignment re-entry into transcript lazy placement"
  )
  check(
    workbench.contains("private var dirtyStateAction: (Bool) -> Void")
      && workbench.contains("public func onDirtyStateChange")
      && workbench.contains("dirtyStateAction(model.fileTabs.hasDirtyTabs)")
      && workbench.contains(".onChange(of: model.fileTabs.hasDirtyTabs)"),
    "native Workbench reports dirty ownership before its parent can replace the root model"
  )
  check(
    root.contains("NativeFirstMouseIconButton(")
      && root.contains("accessibilityIdentifier: \"ark.global.workbench-toggle\"")
      && root.contains("action: toggleWorkbenchPanel")
      && root.contains("NativeSessionActionsMenu(model: model)")
      && !root.contains("ark.hero.open-workbench")
      && !root.contains("ark.session.open-workbench"),
    "native root owns one global rightmost Workbench toggle beside the reusable session actions menu"
  )
  check(
    workbench.contains("struct NativeWorkbenchRootChooser")
      && workbench.contains("NativeWorkbenchRootChooser")
      && !workbench.contains("ark.conversation-tool.toggle"),
    "native workbench content delegates all side-panel visibility to the single global toggle"
  )
  let conversationLauncher = workbenchShellSlice(
    workbench,
    from: "struct NativeConversationWorkbenchLauncher",
    through: "private struct NativeFilesWorkspace"
  )
  check(
    conversationLauncher?.contains("(.review, \"⌃⇧G\")") == true
      && conversationLauncher?.contains("(.terminal, \"⌃`\")") == true
      && conversationLauncher?.contains("(.browser, \"⌘T\")") == true
      && conversationLauncher?.contains("(.files, \"⌘P\")") == true
      && conversationLauncher?.contains("sidebar.right") == false,
    "native conversation launcher owns four contextual tools without duplicating chat or the global visibility toggle"
  )

  let tabBar = workbenchShellSlice(
    workbench,
    from: "private struct NativeWorkbenchTabBar",
    through: "struct NativeWorkbenchRootChooser"
  )
  let compactTabBar = tabBar?.filter { !$0.isWhitespace }
  for kind in [
    ".review", ".terminal", ".browser", ".files",
  ] {
    check(
      compactTabBar?.contains("toolMenuButton(\(kind),shortcutLabel:") == true,
      "native workbench plus menu includes \(kind)"
    )
  }
  check(
    NativeWorkbenchTabKind.allCases.map(\.rawValue)
      == ["review", "terminal", "browser", "files"],
    "native Workbench exposes exactly the four product-owned tool kinds"
  )
  check(
    tabBar?.contains("showToolMenu.toggle()") == true
      && tabBar?.contains("toolMenuTrigger") == true
      && tabBar?.contains(".popover(isPresented: $showToolMenu") == true
      && tabBar?.contains("showToolMenu = false") == true
      && tabBar?.contains(".contentShape(Rectangle())") == true
      && tabBar?.contains("WindowDragSurface()") == true
      && tabBar?.contains(".keyboardShortcut(") == false
      && root.contains(".onReceive(NativeWorkbenchCommandCenter.shared.openTool) { kind in")
      && root.contains("openWorkbenchTool(kind)")
      && root.contains("workbenchToolRequestRevision &+= 1")
      && root.contains("requestedToolRevision: workbenchToolRequestRevision")
      && root.contains(".id(rootURL.path)")
      && !root.contains(".id(\"\\(rootURL.path)::\\(workbenchInitialTool.rawValue)\")")
      && workbench.contains(".onChange(of: requestedToolRevision)")
      && workbench.contains("model.openTool(requestedTool)")
      && !workbench.contains("if requestedToolRevision > 0")
      && !workbench.contains("NativeWorkbenchCommandCenter.shared.openTool")
      && !workbench.contains("NativeWorkbenchLauncher"),
    "native root reveals one persistent Workbench and routes tool commands without changing its root identity"
  )
  check(
    tabBar?.contains("Image(systemName: \"sidebar.right\")") == false,
    "native Workbench tab bar never duplicates the root-owned right-side panel toggle"
  )
  check(
    tabBar?.contains("Text(rootTitle)") == false
      && workbench.contains("private let rootTitle") == false,
    "native Workbench shows the workspace name only in its breadcrumb, never twice in the tool bar"
  )

  check(
    browser.contains("import WebKit") && browser.contains("NSViewRepresentable")
      && browser.contains("configuration.websiteDataStore = .nonPersistent()")
      && browser.contains("configuration.defaultWebpagePreferences.allowsContentJavaScript = true")
      && browser.contains("NSWorkspace.shared.open(url)")
      && !browser.contains("NativeMarkdownDocument(") && !browser.contains("loadFileURL")
      && !browser.contains("addScriptMessageHandler") && !browser.contains("HostToken")
      && !browser.contains(".onDisappear(perform: session.cancel)"),
    "native Browser contains the website-only WebKit exception without Host bridge or Markdown replacement"
  )
  check(
    validatedExternalBrowserURL("example.com")?.absoluteString == "https://example.com"
      && validatedExternalBrowserURL(" https://example.com/path ")?.absoluteString
        == "https://example.com/path"
      && validatedExternalBrowserURL("http://127.0.0.1:3080/api")?.host == "127.0.0.1"
      && validatedExternalBrowserURL("https://user:secret@example.com") == nil
      && validatedExternalBrowserURL("javascript:alert(1)") == nil
      && validatedExternalBrowserURL("file:///tmp/private") == nil
      && validatedExternalBrowserURL("") == nil,
    "native Browser URL policy accepts only credential-free HTTP(S) destinations"
  )
  check(
    ArkL10n.text(.workbenchBrowserOpen, .en) == "Open Here"
      && !browser.contains("workbenchBrowserDetail")
      && !browser.contains("hasCommittedPage")
      && !browser.contains("Image(systemName: \"globe\")"),
    "website content has no Ark instructional overlay before or after navigation"
  )
  check(
    workbench.contains("case .files:")
      && workbench.contains("NativeFilesWorkspace(model: model")
      && workbench.contains("case .review:")
      && workbench.contains("NativeGitInspector(model: model")
      && workbench.contains("case .terminal:")
      && workbench.contains("NativePTYTerminalView(")
      && workbench.contains("terminalSession(for: activeTab.id)"),
    "native multi-tab shell preserves Files, Git review, and Terminal capability owners"
  )
  check(
    !workbench.contains("WKWebView") && !workbench.contains("WebView("),
    "native workbench shell contains no embedded web interface"
  )
  check(
    terminalProcess.contains("Darwin.openpty")
      && terminalProcess.contains("POSIX_SPAWN_SETSID")
      && terminalProcess.contains("login_tty")
      && terminalProcess.contains("tcsetpgrp")
      && terminalProcess.contains("tcgetpgrp")
      && terminalProcess.contains("TERM\"] = \"xterm-256color\"")
      && terminal.contains("sendControlC()")
      && terminal.contains("TIOCSWINSZ")
      && terminal.contains("NativeTerminalOutputInbox")
      && terminal.contains("private let byteLimit: Int")
      && terminal.contains("trimToLimit()")
      && terminal.contains("droppedBytes")
      && terminal.contains("pendingUTF8")
      && terminal.contains("expectedUTF8Length")
      && terminal.contains("pendingANSI")
      && terminal.contains("safeUTF8PrefixLength")
      && terminal.contains("resetsANSIState")
      && terminal.contains("publishIntervalNanoseconds")
      // The visible surface is SwiftTerm; the hand-rolled renderer is gone.
      && terminal.contains("import SwiftTerm")
      && terminal.contains("TerminalView(frame:")
      && terminal.contains("view.terminalDelegate =")
      && terminal.contains("view.feed(byteArray:")
      && terminal.contains("func send(source: TerminalView, data: ArraySlice<UInt8>)")
      && terminal.contains("func sizeChanged(source: TerminalView, newCols: Int, newRows: Int)")
      && terminal.contains("session?.send(bytes: data)")
      && terminalProcess.contains("SIGHUP")
      && terminalProcess.contains("SIGTERM")
      && terminalProcess.contains("SIGKILL")
      && terminalProcess.contains("waitpid")
      && terminal.contains("await processOwner.shutdown()")
      && !terminal.contains("NativeANSIText")
      && !terminal.contains("Process()")
      && !terminal.contains("Pipe()"),
    "native Terminal is a session-owned PTY with bounded output, process-tree teardown, and no pipe-based shell"
  )
  let files = workbenchShellSlice(
    workbench,
    from: "private struct NativeFilesWorkspace",
    through: "private struct NativeGitInspector"
  )
  let filesLayout = workbenchShellSlice(
    workbench,
    from: "private struct NativeFilesWorkspace",
    through: "private struct NativeFileBreadcrumbBar"
  )
  let breadcrumb = workbenchShellSlice(
    workbench,
    from: "private struct NativeFileBreadcrumbBar",
    through: "private struct NativeFileTabStrip"
  )
  check(
    filesLayout?.contains("NativeFileBreadcrumbBar(") == true
      && filesLayout?.contains("treeVisible: $browserVisible") == true
      && files?.contains("NativeFileOutlineView(model: model)") == true
      && files?.contains("requestCloseActiveTab") == true
      && files?.contains("revealSelectedFile") == true
      && files?.contains("if !model.fileTabs.tabs.isEmpty") == true
      && filesLayout?.contains("browserMinimumWidth: CGFloat = 240") == true
      && filesLayout?.contains("browserMaximumWidth: CGFloat = 360") == true
      && filesLayout?.contains("browserWidthFraction: CGFloat = 0.40") == true
      && filesLayout?.contains("proxy.size.width * browserWidthFraction") == true
      && filesLayout?.contains("max(browserMinimumWidth, proxy.size.width * browserWidthFraction)") == true
      && filesLayout?.contains("ark.files.tree-divider") == false
      && filesLayout?.contains(".frame(width: browserVisible ? resolvedBrowserWidth : 0)") == true
      && filesLayout?.contains(".accessibilityHidden(!browserVisible)") == true
      && filesLayout?.contains("if browserVisible {") == false
      && filesLayout?.contains("browserVisible = true") == true
      && breadcrumb?.contains("treeVisible.toggle()") == true
      && breadcrumb?.contains("accessibilityIdentifier: \"ark.files.tree-visibility\"") == true
      && breadcrumb?.contains(".buttonStyle(.borderless)") == false
      && filesLayout?.contains("HSplitView") == false
      && files?.contains("DisclosureGroup") == false,
    "native Files owns breadcrumb and one fixed responsive AppKit outline tree without a draggable divider"
  )
  if let files,
     let breadcrumbIndex = files.range(of: "NativeFileBreadcrumbBar(")?.lowerBound,
     let tabIndex = files.range(of: "NativeFileTabStrip(model: model")?.lowerBound,
     let splitIndex = files.range(of: "GeometryReader { proxy in")?.lowerBound {
    check(
      breadcrumbIndex < tabIndex && tabIndex < splitIndex,
      "native Files keeps breadcrumb above file tabs and places editor/tree content below both"
    )
  } else {
    check(false, "native Files breadcrumb, tab strip, and editor/tree hierarchy is present")
  }
  check(
    breadcrumb?.contains("WindowDragSurface()") == true
      && breadcrumb?.contains("ArkL10n.text(.filesPathPlaceholder, language)") == true
      && breadcrumb?.contains("text: $model.pathInput") == true
      && breadcrumb?.contains(".onSubmit(model.openEnteredPath)") == true
      && breadcrumb?.contains("Button(action: model.openEnteredPath)") == true
      && breadcrumb?.contains("ark.files.path-input") == true
      && breadcrumb?.contains("ark.files.path-open") == true
      && breadcrumb?.contains("Button(action: model.revealSelectedFile)") == true
      && breadcrumb?.contains("Button(action: model.requestCloseActiveTab)") == true,
    "native Files keeps an accessible path-open field and controls beside a dedicated window-drag surface"
  )
  check(
    outline.contains("NSOutlineView")
      && outline.contains("NSSearchField")
      && outline.contains("outline.rowSizeStyle = .custom")
      && outline.contains("outline.rowHeight = 28")
      && outline.contains("outline.indentationPerLevel = 18")
      && outline.contains(".systemFont(ofSize: 13, weight: .semibold)")
      && outline.contains("backgroundColor = .windowBackgroundColor")
      && outline.contains("outlineViewSelectionDidChange")
      && outline.contains("guard !node.isDirectory else { return }")
      && outline.contains("Task { await model.selectFile(node.url) }")
      && outline.contains("NativeClickableOutlineView")
      && outline.contains("override func mouseDown(with event: NSEvent)")
      && outline.contains("frameOfOutlineCell(atRow: clickedRow)")
      && outline.contains("guard event.clickCount == 1")
      && outline.contains("handleRowClick(_ row: Int, wasSelected: Bool, in outlineView: NSOutlineView)")
      && outline.contains("let wasSelected = clickedRow >= 0 && selectedRow == clickedRow")
      && outline.contains("else if wasSelected")
      && outline.contains("Task { await model.selectFile(node.url) }")
      && outline.contains("outlineView.collapseItem(node)")
      && outline.contains("outlineView.expandItem(node)")
      && outline.contains("scrollView.autohidesScrollers = true"),
    "native Files uses reusable AppKit rows, full-row directory disclosure, fixed search, and single-click file open"
  )
  check(
    workbench.contains("model.scheduleFileSearch(query)")
      && workbench.contains("func searchFileNames(matching query: String)")
      && workbench.contains("searchResultLimit = 250")
      && workbench.contains("searchVisitLimit = 40_000")
      && workbench.contains("ignoredSearchDirectories")
      && workbench.contains("node_modules")
      && workbench.contains(".tmp-swift-module-cache")
      && workbench.contains("await refreshTreeFromOwner(generation: generation)")
      && workbench.contains("if !query.isEmpty { scheduleFileSearch(query) }")
      && workbench.contains("fileSearchTask?.cancel()")
      && workbench.contains("Task.checkCancellation()")
      && workbench.contains("Task.detached(priority: .userInitiated)"),
    "native Files search traverses off-main with fixed budgets, cooperative cancellation, and one effective task"
  )
  check(
    workbench.contains("@Published private(set) var treeIsLoading = false")
      && workbench.contains("@Published private(set) var treeLoadError: String?")
      && workbench.contains("treeRefreshGeneration &+= 1")
      && workbench.contains("guard generation == treeRefreshGeneration else { return }")
      && workbench.contains("else if let treeLoadError = model.treeLoadError")
      && workbench.contains("else if model.treeIsLoading")
      && workbench.contains("Button(ArkL10n.text(.fieldRetry, language), action: model.refreshTree)"),
    "native Files distinguishes loading, RPC failure, and a genuinely empty directory while rejecting stale refreshes"
  )
  check(
    workbench.contains("atomicWrite(_ text: String, to url: URL, expectedText: String)")
      && workbench.contains("String(data: existingData, encoding: .utf8) == expectedText")
      && workbench.contains("NativeSaveTransactionRecord")
      && workbench.contains("saveRecoveryRequired")
      && workbench.contains("sha256(claimedData) == transaction.expectedOldSHA256")
      && workbench.contains("transaction.newName.withCString")
      && workbench.contains("transaction.oldName.withCString")
      && !workbench.contains("UInt32(RENAME_SWAP)")
      && workbench.contains("恢复并发保存冲突")
      && workbench.contains("externalModificationConflict")
      && workbench.contains("replaceCleanTabFromDisk")
      && workbench.contains("guard !existing.isDirty else { return }"),
    "native Files refreshes only clean tabs and rejects saves after external content or identity drift"
  )
  let fileActions = workbenchShellSlice(
    workbench,
    from: "private struct NativeFileActionsPopover",
    through: "private struct NativeTextEditor"
  )
  check(
    workbench.contains("ark.files.actions")
      && workbench.contains("promptCreateFile(language:")
      && workbench.contains("promptCreateFolder(language:")
      && workbench.contains("promptRenameSelected(language:")
      && workbench.contains("duplicateSelectedTreeItem()")
      && workbench.contains("promptMoveSelected(language:")
      && workbench.contains("promptTrashSelected(language:")
      && workbench.contains("createFile(named rawName: String")
      && workbench.contains("createFolder(named rawName: String")
      && workbench.contains("renameatx_np(")
      && workbench.contains("UInt32(RENAME_EXCL)")
      && workbench.contains("openTrashDirectory(forDevice:")
      && workbench.contains("stagingName = \".ark-trash-")
      && workbench.contains("NativeCopyTransactionRecord")
      && workbench.contains("stagingPrefix = \".ark-copy-staging-")
      && workbench.contains("Darwin.fcopyfile")
      && workbench.contains("COPYFILE_ACL | COPYFILE_XATTR | COPYFILE_STAT")
      && !workbench.contains("FileManager.default.trashItem")
      && !workbench.contains("FileManager.default.copyItem")
      && workbench.contains("validatedLeafName")
      && workbench.contains("AT_SYMLINK_NOFOLLOW")
      && workbench.contains("hasOpenTab(atOrBelow:")
      && workbench.contains("showHiddenNoise")
      && workbench.components(separatedBy: "let targetDirectory = mutationDirectoryURL").count == 3
      && workbench.contains("createFile(named: name, in: targetDirectory)")
      && workbench.contains("createFolder(named: name, in: targetDirectory)")
      && fileActions?.contains(".popover(isPresented: $presented") == true
      && fileActions?.contains("minHeight: 32") == true
      && fileActions?.contains("DispatchQueue.main.async(execute: action)") == true
      && fileActions?.contains("Menu {") == false,
    "native Files exposes reliable anchored full-row create/rename/duplicate/move/Trash and hidden-noise actions"
  )
  let outlineExpansion = workbenchShellSlice(
    outline,
    from: "func outlineView(_ outlineView: NSOutlineView, shouldExpandItem item: Any) -> Bool",
    through: "func outlineViewItemDidExpand"
  )
  check(
    outlineExpansion?.contains("if node.children != nil { return true }") == true
      && outlineExpansion?.contains("model.loadChildren(of: node)") == true
      && outlineExpansion?.contains("return false") == true
      && outlineExpansion?.contains("outlineView.expandItem(node)") == false
      && outlineExpansion?.contains("reloadItem(node") == false
      && workbench.contains("node.isLoadingChildren = true")
      && workbench.contains("defer { node.isLoadingChildren = false }")
      && workbench.contains("!node.isLoadingChildren"),
    "native Files child loading is single-flight and never re-enters AppKit expansion from shouldExpandItem"
  )
  check(
    outline.contains("@MainActor\n  final class Coordinator"),
    "native Files AppKit coordinator shares the Workbench main-actor ownership boundary"
  )
  check(
    !workbench.contains("appModel.workbenchTree(")
      && !workbench.contains("appModel.workbenchFile(")
      && workbench.contains("let worker = Task.detached(priority: .userInitiated)")
      && workbench.contains("let access = try NativeWorkspaceAccess(rootURL: rootURL)")
      && workbench.contains("return try access.listDirectory(directory, showHiddenNoise: showHiddenNoise)")
      && workbench.contains("return try access.readUTF8Text(at: url)")
      && !workbench.contains("webReader: { url in")
      && !workbench.contains("appModel.workbenchWebRead(url: url)")
      && workbench.contains(".onChange(of: browserCancellationRevision)")
      && workbench.contains("model.cancelBrowserRequests()")
      && workbench.contains("browserSessions.removeValue(forKey: id)?.dispose()")
      && root.contains("workbenchBrowserCancellationRevision &+= 1")
      && root.contains("browserCancellationRevision: workbenchBrowserCancellationRevision"),
    "native Workbench keeps Files in its descriptor owner and website browsing independent of Host"
  )
  check(
    workbench.contains("@MainActor\nfinal class NativeWorkbenchModel"),
    "native Workbench publishes tree, tab, and editor state only from the main actor"
  )

  let review = workbenchShellSlice(
    workbench,
    from: "private struct NativeGitInspector",
    through: "private struct NativeOutputPanel"
  )
  check(
    review?.contains("NativeGitDiffPane(model: model") == true
      && review?.contains("NativeGitChangeSidebar(model: model") == true
      && review?.contains("NativeGitChangeOutlineView(") == true
      && review?.contains("expandAllDirectories: !query.trimmingCharacters(") == true
      && review?.contains("NativeWorkbenchSearchField(") == true
      && review?.contains("NativeGitSideBySideDiffView(") == true
      && review?.contains("NativeGitDiffStats(patch:") == true
      && review?.contains("ark.review.diff-editor") == true
      && review?.contains("ark.review.history-files") == true
      && review?.contains("onSelect: model.selectGitCommitChange") == true
      && review?.contains("NativeGitDiffStats(patch: model.selectedGitCommitPatch)") == true
      && review?.contains("NativeGitRepositoryView(model: model") == true
      && review?.contains("ark.review.repository") == true
      && review?.contains("gitCredentialsSystemManaged") == true
      && review?.contains("ark.review.repository-setup") == true
      && review?.contains("action: model.initializeGitRepository") == true
      && review?.contains("changeTreeMinimumWidth: CGFloat = 240") == true
      && review?.contains("changeTreeMaximumWidth: CGFloat = 360") == true
      && review?.contains("changeTreeWidthFraction: CGFloat = 0.40") == true
      && review?.contains("max(changeTreeMinimumWidth, proxy.size.width * changeTreeWidthFraction)") == true
      && review?.contains("ark.review.tree-divider") == false
      && review?.contains("DragGesture") == false
      && review?.contains("HSplitView") == false
      && review?.contains("model.openSelectedGitFile()") == true,
    "native Review shares the Files source-list and TextKit code presentation with a fixed responsive tree"
  )
  check(
    gitOutline.contains("NSOutlineView")
      && gitOutline.contains("outline.style = .sourceList")
      && gitOutline.contains("outline.rowHeight = 28")
      && gitOutline.contains("outline.indentationPerLevel = 18")
      && gitOutline.contains("NativeGitChangeNode.tree")
      && gitOutline.contains("if expandAllDirectories || expandedDirectories.contains")
      && gitOutline.contains("onSelect(change)")
      && gitOutline.contains("let selectedPath: String?")
      && gitOutline.contains("let onSelect: (NativeGitChange) -> Void")
      && gitOutline.contains("scrollView.autohidesScrollers = true")
      && gitOutline.contains("case \"swift\": return .systemOrange")
      && gitOutline.contains("case \"md\", \"markdown\": return .systemGreen"),
    "native Review changed-file tree uses the same AppKit geometry, interaction, and file colors as Files"
  )
  check(
    workbench.contains("arguments: prefix + [\"diff\", \"--cached\"")
      && workbench.contains("arguments: prefix + [\"diff\", \"--no-ext-diff\"")
      && workbench.contains("selectedGitPath == path"),
    "native Review obtains per-file staged and working diffs with stale-selection protection"
  )
  let selectFile = workbenchShellSlice(
    workbench,
    from: "func selectFile(_ url: URL) async",
    through: "func exportSelectedFile()"
  )
  let activateFileTab = workbenchShellSlice(
    workbench,
    from: "func activateFileTab(_ id: UUID)",
    through: "func flushRecoveryDrafts() async"
  )
  check(
    selectFile?.contains("activateFileTab(existing.id)") == true
      && activateFileTab?.contains("fileTabs.activate(id: id)") == true
      && activateFileTab?.contains("pathInput = access?.displayPath(for: tab.url) ?? tab.url.path") == true
      && activateFileTab?.contains("selectedTreeURL = tab.url") == true
      && activateFileTab?.contains("openTool(.files)") == true,
    "opening an already-loaded Review file activates Files instead of remaining on Review"
  )

  var tabs = NativeWorkbenchTabsState()
  check(
    tabs.tabs.map(\.kind) == [.files] && tabs.activeTab?.kind == .files,
    "native workbench starts with one Files tab"
  )
  let reviewID = tabs.open(.review)
  check(
    tabs.open(.review) == reviewID
      && tabs.tabs.filter { $0.kind == .review }.count == 1,
    "native Review tab is a focusable singleton"
  )
  let terminal1 = tabs.open(.terminal)
  let terminal2 = tabs.open(.terminal)
  check(
    terminal1 != terminal2
      && tabs.tabs.filter { $0.kind == .terminal }.map(\.ordinal) == [1, 2],
    "native Terminal menu creates independent tab identities"
  )
  let browser1 = tabs.open(.browser)
  let browser2 = tabs.open(.browser)
  check(
    browser1 != browser2
      && tabs.tabs.filter { $0.kind == .browser }.count == 2,
    "native Browser menu creates independent tab identities"
  )
  tabs.activate(terminal1)
  tabs.close(terminal1)
  check(
    tabs.activeTabID != terminal1 && !tabs.tabs.contains { $0.id == terminal1 },
    "native tool tab close selects a surviving neighbor"
  )

  await runArkWorkbenchBrowserRuntimeContractChecks()
  let modelCancellation = NativeWorkbenchModel(rootURL: contractNativeRoot)
  let first = modelCancellation.browserSession(for: "browser:contract")
  let second = modelCancellation.browserSession(for: "browser:other")
  let retainedView = first.webView
  first.address = "https://unsent.example.test"
  modelCancellation.cancelBrowserRequests()
  check(modelCancellation.browserSession(for: "browser:contract") === first
      && modelCancellation.browserSession(for: "browser:other") === second
      && first.webView === retainedView && !first.isDisposed,
    "hiding Workbench stops requests without discarding per-tab WebKit ownership")
  modelCancellation.disposeBrowserSessions()
  check(first.isDisposed && second.isDisposed && first.webView == nil
      && modelCancellation.browserSession(for: "browser:contract") !== first,
    "true Workbench disposal closes all website sessions")
  modelCancellation.disposeBrowserSessions()

  let operationRoot = FileManager.default.temporaryDirectory.appendingPathComponent(
    "ark-workbench-operation-\(UUID().uuidString)",
    isDirectory: true
  )
  try? FileManager.default.createDirectory(at: operationRoot, withIntermediateDirectories: true)
  defer { try? FileManager.default.removeItem(at: operationRoot) }
  let savedFile = operationRoot.appendingPathComponent("saved.txt")
  let otherFile = operationRoot.appendingPathComponent("other.txt")
  try? "base".write(to: savedFile, atomically: true, encoding: .utf8)
  try? "other".write(to: otherFile, atomically: true, encoding: .utf8)
  let operationModel = NativeWorkbenchModel(
    rootURL: operationRoot,
    draftJournal: NativeWorkbenchDraftJournal(
      storageURL: operationRoot.appendingPathComponent(".ark-operation-journal")
    ),
    draftDebounceNanoseconds: 0
  )
  await operationModel.selectFile(savedFile)
  let firstSavedValue = String(repeating: "a", count: 4 * 1024 * 1024)
  let laterEdit = firstSavedValue + "later"
  operationModel.updateEditorText(firstSavedValue)
  operationModel.saveEditor()
  let saveReturnedBeforeIO = operationModel.activeFileIsSaving
  operationModel.updateEditorText(laterEdit)
  for _ in 0..<500 where operationModel.activeFileIsSaving {
    try? await Task.sleep(nanoseconds: 10_000_000)
  }
  let savedDiskValue = try? String(contentsOf: savedFile, encoding: .utf8)
  check(
    saveReturnedBeforeIO
      && !operationModel.activeFileIsSaving
      && savedDiskValue == firstSavedValue
      && operationModel.activeFileTab?.text == laterEdit
      && operationModel.activeFileTab?.savedBaseline == firstSavedValue
      && operationModel.activeFileTab?.isDirty == true,
    "native Files saves off MainActor and fences completion to the captured tab while retaining later edits"
  )

  let sourceFolder = operationRoot.appendingPathComponent("source", isDirectory: true)
  try? FileManager.default.createDirectory(at: sourceFolder, withIntermediateDirectories: true)
  for index in 0..<256 {
    try? Data(repeating: UInt8(index % 251), count: 4 * 1024).write(
      to: sourceFolder.appendingPathComponent("item-\(index).bin")
    )
  }
  let sourceNode = NativeFileNode(name: "source", url: sourceFolder, isDirectory: true)
  let otherNode = NativeFileNode(name: "other.txt", url: otherFile, isDirectory: false)
  operationModel.selectTreeNode(sourceNode)
  operationModel.duplicateSelectedTreeItem()
  let duplicateReturnedBeforeIO = operationModel.fileMutationIsRunning
  operationModel.selectTreeNode(otherNode)
  for _ in 0..<500 where operationModel.fileMutationIsRunning {
    try? await Task.sleep(nanoseconds: 10_000_000)
  }
  check(
    duplicateReturnedBeforeIO
      && !operationModel.fileMutationIsRunning
      && FileManager.default.fileExists(
        atPath: operationRoot.appendingPathComponent("source copy/item-255.bin").path
      )
      && operationModel.selectedTreeURL == otherFile,
    "native Files duplicates large directories off MainActor without stealing a newer selection"
  )

  for index in 256..<2_256 {
    try? Data([UInt8(index % 251)]).write(
      to: sourceFolder.appendingPathComponent("item-\(index).bin")
    )
  }
  let cancellingCopy = Task.detached {
    let access = try NativeWorkspaceAccess(rootURL: operationRoot)
    return try access.duplicateItem(sourceFolder)
  }
  var observedHiddenCopyStaging = false
  for _ in 0..<500 {
    let names = (try? FileManager.default.contentsOfDirectory(atPath: operationRoot.path)) ?? []
    if names.contains(where: { $0.hasPrefix(NativeCopyTransactionRecord.stagingPrefix) }) {
      observedHiddenCopyStaging = true
      break
    }
    try? await Task.sleep(nanoseconds: 1_000_000)
  }
  cancellingCopy.cancel()
  let copyCancelled: Bool
  do {
    _ = try await cancellingCopy.value
    copyCancelled = false
  } catch is CancellationError {
    copyCancelled = true
  } catch {
    copyCancelled = false
  }
  let postCancelNames = (try? FileManager.default.contentsOfDirectory(atPath: operationRoot.path)) ?? []
  check(
    observedHiddenCopyStaging
      && copyCancelled
      && !postCancelNames.contains("source copy 2")
      && !postCancelNames.contains(where: { $0.hasPrefix(".ark-copy-") }),
    "native Files cancellation removes hidden copy staging without publishing a half-copy"
  )

  operationModel.refreshTree()
  for _ in 0..<200 where operationModel.treeIsLoading {
    try? await Task.sleep(nanoseconds: 10_000_000)
  }
  operationModel.fileSearchQuery = "saved"
  operationModel.scheduleFileSearch("saved")
  operationModel.fileSearchQuery = "other"
  operationModel.scheduleFileSearch("other")
  for _ in 0..<200 where operationModel.fileSearchIsLoading {
    try? await Task.sleep(nanoseconds: 10_000_000)
  }
  let effectiveSearchNames = operationModel.filteredRootNodes.first?.children?.map(\.name) ?? []
  check(
    !operationModel.fileSearchIsLoading
      && effectiveSearchNames.contains(where: { $0.localizedCaseInsensitiveContains("other") })
      && !effectiveSearchNames.contains(where: { $0.localizedCaseInsensitiveContains("saved") }),
    "native Files keeps only the newest effective filename scan"
  )

  let cancelledSearch = Task.detached {
    let access = try NativeWorkspaceAccess(rootURL: operationRoot)
    return try access.searchFileNames(matching: "item")
  }
  cancelledSearch.cancel()
  let searchCancelled: Bool
  do {
    _ = try await cancelledSearch.value
    searchCancelled = false
  } catch is CancellationError {
    searchCancelled = true
  } catch {
    searchCancelled = false
  }
  check(
    searchCancelled,
    "native Files filename traversal observes cooperative task cancellation"
  )
}

private func workbenchShellSlice(
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
