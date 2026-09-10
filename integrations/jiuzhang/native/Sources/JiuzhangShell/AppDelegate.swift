import AppKit
import JiuzhangShellCore
import JiuzhangShellUI
import SwiftUI

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
  private let backend = BackendProcess()
  private let workbenchDraftFlushCoordinator = NativeWorkbenchDraftFlushCoordinator()
  private let apiToken = "\(UUID().uuidString.lowercased()).\(UUID().uuidString.lowercased())"
  private var window: NSWindow?
  private var loadingView: NSView?
  private var hostingView: NSHostingView<ArkRootView>?
  private var appModel: ArkAppModel?
  private var runtimeRoot: URL?
  private var dataLocations: JiuzhangDataLocations?
  private var failureLabel: NSTextField?
  private var requestedTermination = false
  private var restartCircuitBreaker = BackendRestartCircuitBreaker()
  private let terminationTimeoutSeconds: TimeInterval = 20
  private var terminationID: UUID?
  private var terminationBackendStopStarted = false
  private var terminationReplySent = false
  private var terminationStopWorkItem: DispatchWorkItem?
  private var terminationDeadlineWorkItem: DispatchWorkItem?
  private var currentLanguage = "zh"

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.regular)
    NSWindow.allowsAutomaticWindowTabbing = false
    NSApp.mainMenu = makeJiuzhangMainMenu(
      applicationName: jiuzhangVisibleApplicationName,
      language: ArkLanguagePreference(rawValue: currentLanguage)
    )
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(languageChanged(_:)),
      name: .arkLanguageChanged,
      object: nil
    )
    do {
      dataLocations = try JiuzhangShellContract.launchDataLocations()
    } catch {
      makeWindow()
      showFailure("Ark 数据目录配置无效：\(error.localizedDescription)")
      return
    }
    makeWindow()
    startBackend()
    NSApp.activate(ignoringOtherApps: true)
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    true
  }

  func applicationDidBecomeActive(_ notification: Notification) {
    window?.makeKeyAndOrderFront(nil)
  }

  func applicationShouldHandleReopen(
    _ sender: NSApplication,
    hasVisibleWindows flag: Bool
  ) -> Bool {
    window?.makeKeyAndOrderFront(nil)
    sender.activate(ignoringOtherApps: true)
    return true
  }

  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    guard !requestedTermination else { return .terminateLater }
    guard backend.isRunning || appModel != nil else { return .terminateNow }
    requestedTermination = true
    terminationBackendStopStarted = false
    terminationReplySent = false
    let requestID = UUID()
    terminationID = requestID
    let deadline = Date().addingTimeInterval(terminationTimeoutSeconds)
    armTerminationDeadline(sender: sender, requestID: requestID, deadline: deadline)
    Task {
      if let error = await prepareNativeInterfaceShutdown() {
        guard terminationID == requestID, !terminationReplySent else { return }
        if terminationBackendStopStarted {
          NSLog("Ark termination draft flush failed after the total-deadline path began: %@", error)
          return
        }
        presentDraftFlushFailure(error)
        finishApplicationTermination(
          sender: sender,
          requestID: requestID,
          allow: false
        )
        return
      }
      await shutdownNativeInterface()
      guard terminationID == requestID, !terminationReplySent else { return }
      beginBackendStop(sender: sender, requestID: requestID, deadline: deadline)
    }
    return .terminateLater
  }

  @objc func showArkSettings(_ sender: Any?) {
    NotificationCenter.default.post(name: .arkShowSettings, object: nil)
  }

  @objc private func languageChanged(_ notification: Notification) {
    guard let language = notification.object as? String,
          ArkLanguagePreference.allCases.contains(where: { $0.rawValue == language }),
          language != currentLanguage
    else { return }
    currentLanguage = language
    NSApp.mainMenu = makeJiuzhangMainMenu(
      applicationName: jiuzhangVisibleApplicationName,
      language: ArkLanguagePreference(rawValue: currentLanguage)
    )
  }

  private func makeWindow() {
    let content = ArkWindowContentView()
    let loading = makeLoadingView()
    content.addSubview(loading)
    NSLayoutConstraint.activate([
      loading.centerXAnchor.constraint(equalTo: content.centerXAnchor),
      loading.centerYAnchor.constraint(equalTo: content.centerYAnchor),
    ])
    loadingView = loading

    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1920, height: 1080),
      styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
      backing: .buffered,
      defer: false
    )
    window.title = dataLocations?.isCandidate == true
      ? "\(jiuzhangVisibleApplicationName) — 测试候选"
      : jiuzhangVisibleApplicationName
    // Ark's product shell owns the whole window surface.  Keeping AppKit's
    // title/tab strip visible adds a second navigation row above the original
    // sidebar/header layout (and, on Sequoia, the purple "Ark" tab capsule).
    // Retain the compact transparent titlebar, but keep the three native macOS
    // window controls fully functional.  The content background is draggable
    // so the frameless-looking Ark shell still behaves like a normal desktop
    // application rather than a fixed browser canvas.
    window.titleVisibility = .hidden
    window.titlebarAppearsTransparent = true
    window.titlebarSeparatorStyle = .none
    window.tabbingMode = .disallowed
    window.tabbingIdentifier = ""
    // Window movement is owned only by explicit WindowDragSurface regions.
    // Enabling AppKit's global background drag here makes the first mouse-down
    // on edge controls activate a move session instead of the SwiftUI button.
    window.isMovableByWindowBackground = false
    for kind in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] {
      window.standardWindowButton(kind)?.isHidden = false
      window.standardWindowButton(kind)?.isEnabled = true
    }
    window.collectionBehavior.insert(.fullScreenPrimary)
    window.minSize = NSSize(width: 1100, height: 700)
    window.contentView = content
    window.center()
    window.makeKeyAndOrderFront(nil)
    self.window = window
  }

  private func makeLoadingView() -> NSView {
    let progress = NSProgressIndicator()
    progress.style = .spinning
    progress.controlSize = .large
    progress.startAnimation(nil)

    let status = NSTextField(labelWithString: "Ark 正在启动本机服务…")
    status.font = .systemFont(ofSize: 16, weight: .medium)
    status.textColor = .secondaryLabelColor

    let loading = NSStackView(views: [progress, status])
    loading.orientation = .vertical
    loading.alignment = .centerX
    loading.spacing = 18
    loading.translatesAutoresizingMaskIntoConstraints = false
    loading.identifier = NSUserInterfaceItemIdentifier("loading")
    return loading
  }

  private func startBackend() {
    guard
      let recordedNode = Bundle.main.object(forInfoDictionaryKey: "JiuzhangNodeExecutable") as? String,
      let recordedLauncher = Bundle.main.object(forInfoDictionaryKey: "JiuzhangLauncherPath") as? String,
      let recordedRunner = Bundle.main.object(forInfoDictionaryKey: "JiuzhangRunnerPath") as? String,
      let recordedRuntimeRoot = Bundle.main.object(forInfoDictionaryKey: "JiuzhangRuntimeRoot") as? String
    else {
      showFailure("应用缺少本机运行配置。")
      return
    }
    let node = JiuzhangShellContract.resolveBundlePath(recordedNode)
    let launcher = JiuzhangShellContract.resolveBundlePath(recordedLauncher)
    let runner = JiuzhangShellContract.resolveBundlePath(recordedRunner)
    let runtimeRoot = JiuzhangShellContract.resolveBundlePath(recordedRuntimeRoot)
    guard JiuzhangShellContract.runtimePathsAreUsable(
      nodeExecutable: node,
      launcherPath: launcher,
      runnerPath: runner,
      runtimeRoot: runtimeRoot
    ) else {
      showFailure("应用缺少本机运行配置。")
      return
    }
    self.runtimeRoot = URL(fileURLWithPath: runtimeRoot, isDirectory: true)

    backend.onLine = { [weak self] line in
      guard let self, !self.requestedTermination,
            self.appModel == nil,
            let url = JiuzhangShellContract.readinessURL(from: line)
      else { return }
      self.restartCircuitBreaker.recordReadiness()
      self.showNativeInterface(serviceURL: url)
    }
    backend.onExit = { [weak self] status in
      guard let self, !self.requestedTermination else { return }
      Task { @MainActor [weak self] in
        guard let self, !self.requestedTermination else { return }
        if let error = await self.prepareNativeInterfaceShutdown() {
          self.presentDraftFlushFailure(error)
          return
        }
        await self.shutdownNativeInterface()
        guard !self.requestedTermination else { return }
        guard let backoff = self.restartCircuitBreaker.restartDelayAfterUnexpectedExit() else {
          self.showFailure("本机服务已停止（状态 \(status)）。")
          return
        }
        self.showStarting()
        DispatchQueue.main.asyncAfter(deadline: .now() + backoff) { [weak self] in
          guard let self, !self.requestedTermination else { return }
          self.startBackend()
        }
      }
    }

    do {
      guard let locations = dataLocations else { throw JiuzhangCandidateDataError.invalidConfiguration }
      let home = locations.harnessHome
      let defaultWorkspace = locations.sessionWorkspace
      try FileManager.default.createDirectory(
        at: home,
        withIntermediateDirectories: true,
        attributes: [.posixPermissions: 0o700]
      )
      try FileManager.default.createDirectory(
        at: defaultWorkspace,
        withIntermediateDirectories: true,
        attributes: [.posixPermissions: 0o700]
      )
      if locations.isCandidate {
        try FileManager.default.createDirectory(at: locations.logs, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
      }
      try prepareDefaultKnowledgeProject(locations: locations)
      restartCircuitBreaker.recordLaunch()
      try backend.start(
        executable: node,
        arguments: JiuzhangShellContract.launchArguments(launcherPath: launcher),
        environment: JiuzhangShellContract.childEnvironment(
          base: ProcessInfo.processInfo.environment,
          harnessHome: home,
          apiToken: apiToken,
          dataLocations: locations
        ),
        workingDirectory: defaultWorkspace
      )
    } catch {
      showFailure("Ark 启动失败：\(error.localizedDescription)")
    }
  }

  private func prepareDefaultKnowledgeProject(locations: JiuzhangDataLocations) throws {
    let manager = FileManager.default
    let root = locations.knowledgeRoot
    let wiki = locations.wikiRoot
    for directory in [
      wiki,
      wiki.appendingPathComponent("concepts", isDirectory: true),
      wiki.appendingPathComponent("entities", isDirectory: true),
      wiki.appendingPathComponent("sources", isDirectory: true),
      root.appendingPathComponent("raw/sources", isDirectory: true),
    ] {
      try manager.createDirectory(
        at: directory,
        withIntermediateDirectories: true,
        attributes: [.posixPermissions: 0o700]
      )
    }
    let seeds: [(URL, String)] = [
      (
        wiki.appendingPathComponent("index.md"),
        "# 万相织鉴主知识库\n\n## 实体\n\n## 概念\n\n## 来源\n"
      ),
      (wiki.appendingPathComponent("log.md"), "# 研究日志\n"),
      (root.appendingPathComponent("purpose.md"), "# 项目目的 — wiki\n\n## 核心问题\n\n> 待补充\n"),
      (
        root.appendingPathComponent("schema.md"),
        "# Wiki Schema\n\n| Type | Directory |\n|---|---|\n"
          + "| entity | wiki/entities/ |\n| concept | wiki/concepts/ |\n"
          + "| source | wiki/sources/ |\n"
      ),
    ]
    for (url, text) in seeds where !manager.fileExists(atPath: url.path) {
      try Data(text.utf8).write(to: url, options: [.atomic])
    }
  }

  private func showNativeInterface(serviceURL: URL) {
    guard !requestedTermination, backend.isRunning,
          appModel == nil, hostingView == nil,
          let content = window?.contentView,
          let locations = dataLocations
    else { return }
    failureLabel?.removeFromSuperview()
    failureLabel = nil

    let fallbackWikiRoot = locations.wikiRoot
    let model = ArkAppModel(
      client: ArkAPIClient(baseURL: serviceURL, apiToken: apiToken),
      interactions: ArkInteractionAPI(baseURL: serviceURL, apiToken: apiToken),
      eventPump: ArkEventPump(baseURL: serviceURL, apiToken: apiToken),
      fallbackWikiRoot: fallbackWikiRoot,
      documentStore: ArkDocumentReferenceStore(rootURL: locations.documentReferences)
    )
    let host = ArkHostingView(rootView: ArkRootView(
      model: model,
      workbenchDraftFlushCoordinator: workbenchDraftFlushCoordinator
    ))
    host.translatesAutoresizingMaskIntoConstraints = false
    content.addSubview(host)
    NSLayoutConstraint.activate([
      host.leadingAnchor.constraint(equalTo: content.leadingAnchor),
      host.trailingAnchor.constraint(equalTo: content.trailingAnchor),
      host.topAnchor.constraint(equalTo: content.topAnchor),
      host.bottomAnchor.constraint(equalTo: content.bottomAnchor),
    ])
    loadingView?.isHidden = true
    hostingView = host
    appModel = model
    model.start()
  }

  private func prepareNativeInterfaceShutdown() async -> String? {
    await workbenchDraftFlushCoordinator.flush()
  }

  private func shutdownNativeInterface() async {
    guard let model = appModel else {
      hostingView?.removeFromSuperview()
      hostingView = nil
      return
    }
    await model.shutdown()
    guard appModel === model else { return }
    hostingView?.removeFromSuperview()
    hostingView = nil
    appModel = nil
  }

  private func armTerminationDeadline(
    sender: NSApplication,
    requestID: UUID,
    deadline: Date
  ) {
    let stopDelay = max(
      0,
      deadline.timeIntervalSinceNow - BackendProcess.forceKillGraceSeconds
    )
    let stopWorkItem = DispatchWorkItem { [weak self] in
      guard let self, self.terminationID == requestID, !self.terminationReplySent else { return }
      self.beginBackendStop(
        sender: sender,
        requestID: requestID,
        deadline: deadline.addingTimeInterval(-0.25)
      )
    }
    terminationStopWorkItem = stopWorkItem
    DispatchQueue.main.asyncAfter(deadline: .now() + stopDelay, execute: stopWorkItem)

    let finalWorkItem = DispatchWorkItem { [weak self] in
      guard let self, self.terminationID == requestID, !self.terminationReplySent else { return }
      self.beginBackendStop(sender: sender, requestID: requestID, deadline: Date())
      self.finishApplicationTermination(sender: sender, requestID: requestID, allow: true)
    }
    terminationDeadlineWorkItem = finalWorkItem
    DispatchQueue.main.asyncAfter(
      deadline: .now() + max(0, deadline.timeIntervalSinceNow),
      execute: finalWorkItem
    )
  }

  private func beginBackendStop(
    sender: NSApplication,
    requestID: UUID,
    deadline: Date
  ) {
    guard terminationID == requestID, !terminationReplySent,
          !terminationBackendStopStarted
    else { return }
    terminationBackendStopStarted = true
    backend.stop(deadline: deadline) { [weak self] in
      guard let self else { return }
      self.finishApplicationTermination(sender: sender, requestID: requestID, allow: true)
    }
  }

  private func finishApplicationTermination(
    sender: NSApplication,
    requestID: UUID,
    allow: Bool
  ) {
    guard terminationID == requestID, !terminationReplySent else { return }
    terminationReplySent = true
    terminationStopWorkItem?.cancel()
    terminationDeadlineWorkItem?.cancel()
    terminationStopWorkItem = nil
    terminationDeadlineWorkItem = nil
    if !allow {
      requestedTermination = false
      terminationID = nil
      terminationBackendStopStarted = false
      terminationReplySent = false
    }
    sender.reply(toApplicationShouldTerminate: allow)
  }

  private func presentDraftFlushFailure(_ reason: String) {
    let alert = NSAlert()
    alert.alertStyle = .critical
    alert.messageText = currentLanguage == "en"
      ? "Ark could not save recovery drafts"
      : "Ark 无法保存恢复草稿"
    alert.informativeText = reason
    alert.addButton(withTitle: currentLanguage == "en" ? "OK" : "好")
    if let window, window.isVisible {
      alert.beginSheetModal(for: window)
    } else {
      alert.runModal()
    }
  }

  private func showStarting() {
    failureLabel?.removeFromSuperview()
    failureLabel = nil
    loadingView?.isHidden = false
  }

  private func showFailure(_ message: String) {
    guard let content = window?.contentView else { return }
    loadingView?.isHidden = true
    failureLabel?.removeFromSuperview()

    let label = NSTextField(wrappingLabelWithString: message)
    label.alignment = .center
    label.textColor = .systemRed
    label.font = .systemFont(ofSize: 15, weight: .medium)
    label.translatesAutoresizingMaskIntoConstraints = false
    content.addSubview(label)
    NSLayoutConstraint.activate([
      label.centerXAnchor.constraint(equalTo: content.centerXAnchor),
      label.centerYAnchor.constraint(equalTo: content.centerYAnchor),
      label.widthAnchor.constraint(lessThanOrEqualToConstant: 560),
    ])
    failureLabel = label
  }
}

/// The content host must never opt the whole SwiftUI tree into background
/// dragging. ArkRootView installs one explicit background-only drag surface;
/// foreground controls and gestures therefore keep the mouse-down first.
private final class ArkWindowContentView: NSView {
  override var mouseDownCanMoveWindow: Bool { false }
}

/// Edge controls must respond on the first click even when the Ark window has
/// just become key. Explicit background drag surfaces remain independently
/// responsible for moving the window.
private final class ArkHostingView<Content: View>: NSHostingView<Content> {
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}
