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
  private let readinessDeadline = BackendReadinessDeadline()
  private var backendLaunchID: UUID?
  private var backendStartupFailure: String?
  private let terminationTimeoutSeconds: TimeInterval = 20
  private var terminationID: UUID?
  private var terminationBackendStopStarted = false
  private var terminationReplySent = false
  private var terminationDeadlineWorkItem: DispatchWorkItem?
  private var terminationTask: Task<Void, Never>?
  private var terminationActionTask: Task<Void, Never>?
  private var terminationPrompt: NSAlert?
  private var terminationCancellationRequested = false
  private var terminationInterfaceShutdownStarted = false
  private var terminationRetryRequested = false
  private var terminationDraftError: String?
  private var terminationStorageEpoch: Int?
  private var terminationInputMonitor: Any?
  private var backendStorageClient: ArkAPIClient?
  private var currentLanguage = "zh"

  /// Single-instance guard: two copies writing the same session store corrupt session logs
  /// (observed 2026-09-12 with six overlapping launches). A second launch hands focus back to the
  /// running instance and exits before any window, backend, or data write exists.
  private func anotherInstanceIsRunning() -> Bool {
    guard let bundleID = Bundle.main.bundleIdentifier else { return false }
    let current = ProcessInfo.processInfo.processIdentifier
    let others = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID)
      .filter { $0.processIdentifier != current }
    guard let existing = others.first else { return false }
    existing.activate(options: [.activateIgnoringOtherApps])
    return true
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    if anotherInstanceIsRunning() {
      NSApp.terminate(nil)
      DispatchQueue.main.asyncAfter(deadline: .now() + 2) { exit(0) }
      return
    }
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
    if let locations = dataLocations {
      sweepOrphanSessionLocks(harnessHome: locations.harnessHome)
    }
    makeWindow()
    startBackend()
    NSApp.activate(ignoringOtherApps: true)
  }

  /// Reclaim session writer locks left behind by a crashed process. `kill -9` inside the append
  /// critical section was reproduced 8/8 to strand `~locks/<id>.lock`, after which every append to
  /// that session timed out after ~2.1s until an operator deleted the lock. Only locks whose
  /// recorded PID is provably gone *and* that are older than a minute are reclaimed; a live owner
  /// (including EPERM) is never touched, and PID reuse errs on the safe side by keeping the lock.
  private func sweepOrphanSessionLocks(harnessHome: URL) {
    let lockDirectory = harnessHome
      .appendingPathComponent("sessions", isDirectory: true)
      .appendingPathComponent("~locks", isDirectory: true)
    let fileManager = FileManager.default
    guard let entries = try? fileManager.contentsOfDirectory(
      at: lockDirectory,
      includingPropertiesForKeys: [.contentModificationDateKey],
      options: [.skipsSubdirectoryDescendants, .skipsHiddenFiles]
    ) else { return }
    let cutoff = Date().addingTimeInterval(-60)
    var reclaimed = 0
    for entry in entries where entry.pathExtension == "lock" {
      guard let modified = (try? entry.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate,
            modified < cutoff,
            let raw = try? String(contentsOf: entry, encoding: .utf8),
            let owner = pid_t(raw.trimmingCharacters(in: .whitespacesAndNewlines))
      else { continue }
      if kill(owner, 0) == 0 || errno == EPERM { continue }
      if (try? fileManager.removeItem(at: entry)) != nil { reclaimed += 1 }
    }
    if reclaimed > 0 {
      FileHandle.standardError.write(Data("ark: reclaimed \(reclaimed) orphan session writer lock(s)\n".utf8))
    }
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
    readinessDeadline.cancel()
    terminationBackendStopStarted = false
    terminationReplySent = false
    terminationCancellationRequested = false
    terminationInterfaceShutdownStarted = false
    terminationRetryRequested = false
    terminationDraftError = nil
    terminationStorageEpoch = nil
    let requestID = UUID()
    terminationID = requestID
    let deadline = Date().addingTimeInterval(terminationTimeoutSeconds)
    armTerminationDeadline(sender: sender, requestID: requestID, deadline: deadline)
    terminationTask = Task { [weak self] in
      await self?.prepareApplicationTermination(sender: sender, requestID: requestID)
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
    guard !requestedTermination else { return }
    readinessDeadline.cancel()
    let launchID = UUID()
    backendLaunchID = launchID
    backendStorageClient = nil
    backendStartupFailure = nil
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
            self.backendLaunchID == launchID, self.backend.isRunning,
            self.appModel == nil,
            let url = JiuzhangShellContract.readinessURL(from: line),
            self.readinessDeadline.acceptReadiness(launchID: launchID)
      else { return }
      self.restartCircuitBreaker.recordReadiness()
      self.backendStorageClient = ArkAPIClient(baseURL: url, apiToken: self.apiToken)
      self.showNativeInterface(serviceURL: url)
    }
    backend.onExit = { [weak self] status in
      guard let self, !self.requestedTermination, self.backendLaunchID == launchID else { return }
      self.readinessDeadline.cancel()
      Task { @MainActor [weak self] in
        guard let self, !self.requestedTermination, self.backendLaunchID == launchID else { return }
        if let error = await self.prepareNativeInterfaceShutdown() {
          self.presentDraftFlushFailure(error)
          return
        }
        await self.shutdownNativeInterface()
        guard !self.requestedTermination, self.backendLaunchID == launchID else { return }
        guard let backoff = self.restartCircuitBreaker.restartDelayAfterUnexpectedExit() else {
          self.showFailure(self.backendStartupFailure ?? "本机服务已停止（状态 \(status)）。")
          return
        }
        self.showStarting()
        DispatchQueue.main.asyncAfter(deadline: .now() + backoff) { [weak self] in
          guard let self, !self.requestedTermination, self.backendLaunchID == launchID else { return }
          self.startBackend()
        }
      }
    }

    do {
      let readinessTimeout = try JiuzhangShellContract.backendReadinessTimeout()
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
      readinessDeadline.arm(launchID: launchID, timeout: readinessTimeout) { [weak self] in
        guard let self, !self.requestedTermination, self.backendLaunchID == launchID else { return }
        self.backendStartupFailure = "本机服务启动超时（\(readinessTimeout) 秒未就绪），自动重试次数已用尽。"
        // Recovery begins only from this owned process's reaped exit callback.
        self.backend.stop {}
      }
    } catch {
      readinessDeadline.cancel()
      backendLaunchID = nil
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

  private func freezeNativeInterfaceInput() {
    if let editor = window?.firstResponder as? NSTextView, editor.hasMarkedText() {
      editor.unmarkText()
      editor.delegate?.textDidChange?(Notification(name: NSText.didChangeNotification, object: editor))
    }
    window?.makeFirstResponder(nil)
    appModel?.freezeNativeInput()
    workbenchDraftFlushCoordinator.freezeLocalInput()
    func disable(_ view: NSView) {
      if let control = view as? NSControl { control.isEnabled = false }
      if let editor = view as? NSTextView { editor.isEditable = false }
      view.subviews.forEach(disable)
    }
    if let hostingView { disable(hostingView) }
    if terminationInputMonitor == nil {
      terminationInputMonitor = NSEvent.addLocalMonitorForEvents(matching: .any) { [weak self] event in
        guard let window = self?.window, event.window === window else { return event }
        return nil
      }
    }
  }

  private func flushFinalNativeDrafts() async -> String? {
    let composerError = await appModel?.flushFrozenComposerDrafts()
    let workbenchError = await workbenchDraftFlushCoordinator.flush()
    return composerError ?? workbenchError
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
    terminationDeadlineWorkItem?.cancel()
    let item = DispatchWorkItem { [weak self] in
      guard let self, self.terminationID == requestID, !self.terminationReplySent else { return }
      self.presentTerminationChoices(sender: sender, requestID: requestID)
    }
    terminationDeadlineWorkItem = item
    DispatchQueue.main.asyncAfter(
      deadline: .now() + max(0, deadline.timeIntervalSinceNow),
      execute: item
    )
  }

  private func prepareApplicationTermination(sender: NSApplication, requestID: UUID) async {
    let attemptID = requestID.uuidString.lowercased()
    let model = appModel
    let storageClient = backendStorageClient
    // Before readiness no native input has been accepted. A ready Host always needs its barrier,
    // including the short interval in which an old interface is being released after recovery.
    let startupOnly = model == nil && storageClient == nil
    if let model {
      do { try await model.prepareStorageQuit(attemptID: attemptID) }
      catch { /* Poll the same Host attempt; a lost response is not a save acknowledgement. */ }
    } else if let storageClient {
      do {
        let state = try await storageClient.storage(.state())
        terminationStorageEpoch = state.quitEpoch
        _ = try await storageClient.storage(.prepareQuit(attemptID: attemptID, epoch: state.quitEpoch))
      }
      catch { /* The next state observation reconciles a possibly accepted prepare action. */ }
    }
    guard terminationID == requestID, !Task.isCancelled else { return }
    terminationDraftError = await prepareNativeInterfaceShutdown()
    guard terminationID == requestID, !Task.isCancelled else { return }
    if terminationDraftError != nil { presentTerminationChoices(sender: sender, requestID: requestID) }
    while terminationID == requestID && !terminationReplySent && !Task.isCancelled {
      if terminationCancellationRequested {
        do { try await Task.sleep(for: .milliseconds(200)) } catch { return }
        continue
      }
      if terminationRetryRequested {
        terminationRetryRequested = false
        if terminationInterfaceShutdownStarted {
          terminationDraftError = await flushFinalNativeDrafts()
        } else {
          if terminationDraftError != nil { terminationDraftError = await prepareNativeInterfaceShutdown() }
          if let model { model.retryStorageSave() }
          else if let storageClient {
          do {
            if terminationStorageEpoch == nil { terminationStorageEpoch = try await storageClient.storage(.state()).quitEpoch }
            if let epoch = terminationStorageEpoch {
              _ = try await storageClient.storage(.prepareQuit(attemptID: attemptID, epoch: epoch))
            }
          }
          catch { /* Keep waiting for a confirmed Host state or an explicit user choice. */ }
          }
        }
      }
      let safe: Bool
      if let model { safe = model.storagePermitsQuit(attemptID: attemptID) }
      else if let storageClient {
        do {
          let state = try await storageClient.storage(.state())
          safe = terminationStorageEpoch.map { state.permitsQuit(attemptID: attemptID, epoch: $0) } ?? false
        }
        catch { safe = false }
      } else { safe = startupOnly }
      guard terminationID == requestID, !Task.isCancelled else { return }
      if safe && terminationDraftError == nil && !terminationCancellationRequested {
        if !terminationInterfaceShutdownStarted {
          terminationInterfaceShutdownStarted = true
          dismissTerminationPrompt()
          freezeNativeInterfaceInput()
          armTerminationDeadline(sender: sender, requestID: requestID,
            deadline: Date().addingTimeInterval(terminationTimeoutSeconds))
          terminationDraftError = await flushFinalNativeDrafts()
          guard terminationID == requestID, !terminationReplySent, !Task.isCancelled else { return }
          if terminationDraftError != nil {
            presentTerminationChoices(sender: sender, requestID: requestID)
            continue
          }
        }
        await shutdownNativeInterface()
        guard terminationID == requestID, !terminationReplySent, !Task.isCancelled else { return }
        beginBackendStop(sender: sender, requestID: requestID,
          deadline: Date().addingTimeInterval(BackendProcess.forceKillGraceSeconds + 1))
        return
      }
      do { try await Task.sleep(for: .milliseconds(250)) } catch { return }
    }
  }

  private func dismissTerminationPrompt() {
    guard let alert = terminationPrompt else { return }
    terminationPrompt = nil
    if let parent = alert.window.sheetParent { parent.endSheet(alert.window, returnCode: .abort) }
    else { alert.window.orderOut(nil) }
  }

  private func presentTerminationChoices(sender: NSApplication, requestID: UUID) {
    guard terminationID == requestID, !terminationReplySent,
          terminationPrompt == nil, !terminationCancellationRequested else { return }
    let finishingNativeTasks = terminationInterfaceShutdownStarted
    let alert = NSAlert()
    alert.alertStyle = .warning
    alert.messageText = currentLanguage == "en" ? "Ark is waiting for saving to finish" : "Ark 正在等待保存完成"
    alert.informativeText = currentLanguage == "en"
      ? "The save barrier has not been confirmed. Keep waiting and retry saving, cancel quitting, or explicitly force quit. Force quitting may lose unsaved records."
      : "尚未收到完整的保存确认。可以继续等待并重试保存、取消退出，或明确强制退出。强制退出可能丢失尚未保存的记录。"
    if finishingNativeTasks {
      alert.messageText = currentLanguage == "en" ? "Ark is finishing quitting" : "Ark 正在完成退出"
      alert.informativeText = currentLanguage == "en"
        ? "The service has confirmed saving. Ark is finishing local tasks; keep waiting or explicitly force quit. Quitting can no longer be cancelled at this stage. Force quitting may lose unsaved local drafts."
        : "服务已确认保存，Ark 正在完成本机收尾。可以继续等待或明确强制退出。此阶段已无法取消退出；强制退出可能丢失尚未保存的本地草稿。"
    }
    if terminationDraftError != nil {
      alert.informativeText += currentLanguage == "en"
        ? " Recovery drafts also need to be saved; keep waiting to retry their final save."
        : " 恢复草稿也尚未保存成功；继续等待会重试最后版本的保存。"
    }
    alert.addButton(withTitle: finishingNativeTasks && terminationDraftError == nil
      ? (currentLanguage == "en" ? "Keep waiting" : "继续等待")
      : (currentLanguage == "en" ? "Keep waiting and retry" : "继续等待并重试"))
    alert.addButton(withTitle: currentLanguage == "en" ? "Cancel quitting" : "取消退出")
    alert.buttons[1].isEnabled = !finishingNativeTasks
    alert.addButton(withTitle: currentLanguage == "en" ? "Force quit" : "强制退出")
    alert.buttons.last?.hasDestructiveAction = true
    terminationPrompt = alert
    let finish: (NSApplication.ModalResponse) -> Void = { [weak self, weak alert] response in
      guard let self, self.terminationID == requestID, !self.terminationReplySent else { return }
      if self.terminationPrompt === alert { self.terminationPrompt = nil }
      switch response {
      case .alertFirstButtonReturn:
        if !self.terminationInterfaceShutdownStarted || self.terminationDraftError != nil {
          self.terminationRetryRequested = true
        }
        self.armTerminationDeadline(sender: sender, requestID: requestID,
          deadline: Date().addingTimeInterval(self.terminationTimeoutSeconds))
      case .alertSecondButtonReturn:
        if !self.terminationInterfaceShutdownStarted {
          self.cancelApplicationTermination(sender: sender, requestID: requestID)
        }
      case .alertThirdButtonReturn:
        self.terminationInterfaceShutdownStarted = true
        self.terminationTask?.cancel()
        self.terminationDeadlineWorkItem?.cancel()
        self.beginBackendStop(sender: sender, requestID: requestID,
          deadline: Date().addingTimeInterval(BackendProcess.forceKillGraceSeconds + 1))
      default: break
      }
    }
    if let window, window.isVisible { alert.beginSheetModal(for: window, completionHandler: finish) }
    else { finish(alert.runModal()) }
  }

  private func cancelApplicationTermination(sender: NSApplication, requestID: UUID) {
    guard terminationID == requestID, !terminationInterfaceShutdownStarted,
          !terminationCancellationRequested else { return }
    terminationCancellationRequested = true
    terminationActionTask = Task { [weak self] in
      guard let self else { return }
      let attemptID = requestID.uuidString.lowercased()
      do {
        if let model = self.appModel { try await model.cancelStorageQuit(attemptID: attemptID) }
        else if let client = self.backendStorageClient {
          let observed = try await client.storage(.state())
          if observed.quit != nil {
            guard let epoch = self.terminationStorageEpoch else { throw ArkAPIError(message: "退出代次尚未确认") }
            let state = try await client.storage(.cancelQuit(attemptID: attemptID, epoch: epoch))
            guard state.quit == nil else { throw ArkAPIError(message: "取消退出尚未确认") }
          }
        }
        guard self.terminationID == requestID, !Task.isCancelled else { return }
        self.finishApplicationTermination(sender: sender, requestID: requestID, allow: false)
      } catch {
        guard self.terminationID == requestID, !Task.isCancelled else { return }
        self.terminationCancellationRequested = false
        self.presentTerminationChoices(sender: sender, requestID: requestID)
      }
      self.terminationActionTask = nil
    }
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
    terminationDeadlineWorkItem?.cancel()
    terminationDeadlineWorkItem = nil
    terminationTask?.cancel()
    terminationTask = nil
    dismissTerminationPrompt()
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
