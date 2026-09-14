import AppKit
import SwiftUI
import WebKit

/// User-entered addresses may omit HTTPS; navigation requests must already be HTTP(S).
func validatedExternalBrowserURL(_ raw: String) -> URL? {
  let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !text.isEmpty, !text.contains("\0") else { return nil }
  let hostWithPort = text.range(of: #"^[^/?#:\s]+:[0-9]+(?:[/?#]|$)"#, options: .regularExpression) != nil
  let hasScheme = text.range(of: #"^[A-Za-z][A-Za-z0-9+.-]*:"#, options: .regularExpression) != nil
  let normalized = text.hasPrefix("//") ? "https:\(text)" : (hasScheme && !hostWithPort ? text : "https://\(text)")
  guard let url = URL(string: normalized), NativeBrowserNavigationPolicy.allows(url) else { return nil }
  return url
}

enum NativeBrowserNavigationPolicy {
  static func isInternalBlank(_ url: URL) -> Bool {
    // WebKit bridges NSURL, whose opaque URL path differs from Swift URL(string:).
    guard let components = URLComponents(string: url.absoluteString) else { return false }
    return components.scheme?.lowercased() == "about" && ["blank", "srcdoc"].contains(components.path.lowercased())
  }
  static func allows(_ url: URL, isMainFrame: Bool, sourceProtocol: String) -> Bool {
    allows(url) || (!isMainFrame && ["http", "https"].contains(sourceProtocol.lowercased()) && isInternalBlank(url))
  }

  static func allows(_ url: URL) -> Bool {
    guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
          let scheme = components.scheme?.lowercased(),
          ["http", "https"].contains(scheme), components.host?.isEmpty == false,
          components.user == nil, components.password == nil else { return false }
    return true
  }
}

/// One tab owns one isolated WebKit view. Mounting and hiding the SwiftUI surface never reloads it.
@MainActor
final class NativeWorkbenchBrowserSession: NSObject, ObservableObject, WKNavigationDelegate, WKUIDelegate {
  var language: ArkLanguagePreference = .zh
  @Published var address = ""
  @Published private(set) var title = ""
  @Published private(set) var isLoading = false
  @Published private(set) var estimatedProgress = 0.0
  @Published private(set) var canGoBack = false
  @Published private(set) var canGoForward = false
  @Published private(set) var validationMessage: String?
  private(set) var webView: WKWebView?
  private(set) var isDisposed = false
  private var observations: [NSKeyValueObservation] = []
  private var activeNavigation: WKNavigation?
  private var navigationAddress = ""
  private var dialogue: NSAlert?
  private var finishDialogue: ((NSApplication.ModalResponse) -> Void)?

  override init() {
    super.init()
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
    configuration.defaultWebpagePreferences.allowsContentJavaScript = true
    configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
    let view = WKWebView(frame: .zero, configuration: configuration)
    view.allowsBackForwardNavigationGestures = true
    view.navigationDelegate = self
    view.uiDelegate = self
    webView = view
    func observe<Value>(_ keyPath: KeyPath<WKWebView, Value>, updatesAddress: Bool = false) {
      observations.append(view.observe(keyPath, options: [.initial, .new]) { [weak self] observed, _ in
        Task { @MainActor [weak self, weak observed] in
          guard let self, let observed, self.owns(observed) else { return }
          self.refreshState(from: observed)
          if updatesAddress, let url = observed.url, NativeBrowserNavigationPolicy.allows(url) {
            self.updateAddress(url)
          }
        }
      })
    }
    observe(\.isLoading); observe(\.estimatedProgress); observe(\.canGoBack)
    observe(\.canGoForward); observe(\.title); observe(\.url, updatesAddress: true)
  }

  deinit {
    observations.forEach { $0.invalidate() }
    let releasedView = webView
    let releasedDialogue = dialogue
    let finish = finishDialogue
    Task { @MainActor in
      if let alert = releasedDialogue { alert.window.sheetParent?.endSheet(alert.window, returnCode: .cancel) }
      finish?(.cancel)
      releasedView?.stopLoading()
      releasedView?.navigationDelegate = nil
      releasedView?.uiDelegate = nil
      releasedView?.removeFromSuperview()
    }
  }

  private func owns(_ view: WKWebView) -> Bool { !isDisposed && webView === view }

  private func refreshState(from view: WKWebView) {
    isLoading = view.isLoading
    estimatedProgress = view.estimatedProgress
    canGoBack = view.canGoBack; canGoForward = view.canGoForward
    title = view.title ?? view.url?.host ?? ""
  }

  func navigate() {
    guard !isDisposed else { return }
    guard let url = validatedExternalBrowserURL(address) else { rejectNavigation(); return }
    load(URLRequest(url: url), replacingAddress: true)
  }

  private func updateAddress(_ url: URL, replacingEdit: Bool = false) {
    let value = url.absoluteString
    if replacingEdit || address == navigationAddress { address = value }
    navigationAddress = value
  }

  private func load(_ request: URLRequest, replacingAddress: Bool = false) {
    guard !isDisposed, let view = webView else { return }
    guard let url = request.url, NativeBrowserNavigationPolicy.allows(url) else { rejectNavigation(); return }
    validationMessage = nil
    updateAddress(url, replacingEdit: replacingAddress)
    activeNavigation = view.load(request)
  }

  func goBack() {
    guard let view = webView, !isDisposed, view.canGoBack else { return }
    validationMessage = nil; activeNavigation = view.goBack()
  }
  func goForward() {
    guard let view = webView, !isDisposed, view.canGoForward else { return }
    validationMessage = nil; activeNavigation = view.goForward()
  }
  func reload() {
    guard let view = webView, !isDisposed else { return }
    validationMessage = nil
    if view.url == nil { navigate() } else { activeNavigation = view.reload() }
  }
  func cancel() {
    activeNavigation = nil
    webView?.stopLoading()
    isLoading = false
  }

  func dispose() {
    guard !isDisposed else { return }
    isDisposed = true
    cancel()
    if let dialogue { dialogue.window.sheetParent?.endSheet(dialogue.window, returnCode: .cancel) }
    finishDialogue?(.cancel)
    observations.forEach { $0.invalidate() }; observations.removeAll()
    webView?.navigationDelegate = nil; webView?.uiDelegate = nil
    webView?.removeFromSuperview()
    webView = nil
  }

  func openExternally() {
    guard !isDisposed, let url = validatedExternalBrowserURL(address) else { rejectNavigation(); return }
    validationMessage = NSWorkspace.shared.open(url) ? nil : ArkL10n.text(.workbenchBrowserOpenFailed, language)
  }

  private func rejectNavigation() {
    validationMessage = ArkL10n.text(.workbenchBrowserInvalid, language)
  }

  func webView(_ view: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    let isMainFrame = action.targetFrame?.isMainFrame != false
    guard owns(view), let url = action.request.url,
          NativeBrowserNavigationPolicy.allows(url, isMainFrame: isMainFrame, sourceProtocol: action.sourceFrame.securityOrigin.protocol) else {
      if owns(view) {
        if isMainFrame { rejectNavigation() }
        else { validationMessage = ArkL10n.text(.workbenchBrowserBlockedFrame, language) }
      }
      decisionHandler(.cancel); return
    }
    if action.targetFrame == nil {
      decisionHandler(.cancel)
      load(action.request)
      return
    }
    // Redirect policy checks belong to the same navigation. Keep its identity so
    // a later finish or failure is still delivered to the current tab.
    if action.targetFrame?.isMainFrame == true { validationMessage = nil }
    decisionHandler(.allow)
  }

  func webView(_ view: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
    guard owns(view), let url = response.response.url,
          NativeBrowserNavigationPolicy.allows(url) || (!response.isForMainFrame && NativeBrowserNavigationPolicy.isInternalBlank(url)),
          response.canShowMIMEType else {
      if owns(view) { validationMessage = ArkL10n.text(.workbenchBrowserUnsupported, language) }
      decisionHandler(.cancel); return
    }
    if response.isForMainFrame, let http = response.response as? HTTPURLResponse, http.statusCode >= 400 {
      validationMessage = ArkL10n.format(.workbenchBrowserHTTPFailure, language, arguments: [String(http.statusCode)])
    }
    decisionHandler(.allow)
  }

  func webView(_ view: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
    guard owns(view) else { return }
    activeNavigation = navigation
    isLoading = true
  }
  func webView(_ view: WKWebView, didFinish navigation: WKNavigation!) {
    guard owns(view), let navigation, navigation === activeNavigation else { return }
    isLoading = false
    refreshState(from: view)
  }
  private func failed(_ view: WKWebView, navigation: WKNavigation?, error: Error) {
    guard owns(view), let navigation, navigation === activeNavigation else { return }
    activeNavigation = nil; isLoading = false
    let failure = error as NSError
    guard !(failure.domain == NSURLErrorDomain && failure.code == NSURLErrorCancelled) else { return }
    validationMessage = ArkL10n.text(.workbenchBrowserLoadFailed, language) + " " + failure.localizedDescription
  }
  func webView(_ view: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    failed(view, navigation: navigation, error: error)
  }
  func webView(_ view: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    failed(view, navigation: navigation, error: error)
  }
  func webViewWebContentProcessDidTerminate(_ view: WKWebView) {
    guard owns(view) else { return }
    activeNavigation = nil; isLoading = false
    validationMessage = ArkL10n.text(.workbenchBrowserProcessStopped, language)
  }
  func webView(_ view: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
    if owns(view), action.targetFrame == nil { load(action.request) }
    return nil
  }
  func webView(_ view: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
    decisionHandler(.deny)
  }
  func webView(_ view: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
    completionHandler(nil)
  }

  private func presentDialogue(_ message: String, text: String? = nil, buttons: [String], completion: @escaping (NSApplication.ModalResponse, String?) -> Void) {
    guard !isDisposed, let window = webView?.window, dialogue == nil else { completion(.cancel, nil); return }
    let alert = NSAlert()
    alert.messageText = webView?.url?.host ?? ArkL10n.text(.workbenchBrowser, language)
    alert.informativeText = message
    for button in buttons { alert.addButton(withTitle: button) }
    let field = text.map { NSTextField(string: $0) }
    if let field { field.frame = CGRect(x: 0, y: 0, width: 300, height: 24); alert.accessoryView = field }
    var finished = false
    let finish: (NSApplication.ModalResponse) -> Void = { [weak self] response in
      guard !finished else { return }; finished = true
      self?.dialogue = nil; self?.finishDialogue = nil
      completion(response, field?.stringValue)
    }
    dialogue = alert; finishDialogue = finish
    alert.beginSheetModal(for: window, completionHandler: finish)
  }
  func webView(_ view: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
    presentDialogue(message, buttons: [ArkL10n.text(.workbenchBrowserConfirm, language)]) { _, _ in completionHandler() }
  }
  func webView(_ view: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
    presentDialogue(message, buttons: [ArkL10n.text(.workbenchBrowserConfirm, language), ArkL10n.text(.commonCancel, language)]) { response, _ in completionHandler(response == .alertFirstButtonReturn) }
  }
  func webView(_ view: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
    presentDialogue(prompt, text: defaultText ?? "", buttons: [ArkL10n.text(.workbenchBrowserConfirm, language), ArkL10n.text(.commonCancel, language)]) { response, text in completionHandler(response == .alertFirstButtonReturn ? text : nil) }
  }
}

private struct NativeWorkbenchWebSurface: NSViewRepresentable {
  let session: NativeWorkbenchBrowserSession
  func makeNSView(context: Context) -> NSView { NSView() }
  func updateNSView(_ container: NSView, context: Context) {
    guard let webView = session.webView, webView.superview !== container else { return }
    webView.removeFromSuperview()
    webView.frame = container.bounds
    webView.autoresizingMask = [.width, .height]
    container.addSubview(webView)
  }
  static func dismantleNSView(_ container: NSView, coordinator: ()) {
    container.subviews.forEach { $0.removeFromSuperview() }
  }
}

struct NativeWorkbenchBrowserView: View {
  @ObservedObject var session: NativeWorkbenchBrowserSession
  let language: ArkLanguagePreference
  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 8) {
        navigationButton("chevron.left", .workbenchBrowserBack, action: session.goBack).disabled(!session.canGoBack)
        navigationButton("chevron.right", .workbenchBrowserForward, action: session.goForward).disabled(!session.canGoForward)
        navigationButton(session.isLoading ? "xmark" : "arrow.clockwise", session.isLoading ? .workbenchBrowserStop : .workbenchBrowserReload,
          action: session.isLoading ? session.cancel : session.reload)
        TextField(ArkL10n.text(.workbenchBrowserPlaceholder, language), text: $session.address)
          .textFieldStyle(.roundedBorder).onSubmit(session.navigate)
          .accessibilityIdentifier("ark.workbench.browser.address")
        Button(ArkL10n.text(.workbenchBrowserOpen, language), action: session.navigate).buttonStyle(.borderedProminent)
        navigationButton("arrow.up.right.square", .workbenchBrowserOpenExternal, action: session.openExternally)
      }
      .padding(.horizontal, 10).frame(height: 42)
      .background(Color(nsColor: .controlBackgroundColor))
      if session.isLoading { ProgressView(value: session.estimatedProgress).progressViewStyle(.linear) }
      Divider()
      NativeWorkbenchWebSurface(session: session)
        .accessibilityIdentifier("ark.workbench.browser.web-content")
      if let message = session.validationMessage {
        Text(message).font(.system(size: 11)).foregroundStyle(Color.red)
          .frame(maxWidth: .infinity, alignment: .leading).padding(10)
          .background(Color(nsColor: .controlBackgroundColor))
          .accessibilityIdentifier("ark.workbench.browser.error")
      }
    }
    .accessibilityIdentifier("ark.workbench.browser")
    .onAppear { session.language = language }
    .onChange(of: language) { session.language = $0 }
  }
  private func navigationButton(_ icon: String, _ key: ArkL10n.Key, action: @escaping () -> Void) -> some View {
    Button(action: action) { Image(systemName: icon).frame(width: 18, height: 18) }
      .buttonStyle(.bordered).help(ArkL10n.text(key, language))
      .accessibilityLabel(ArkL10n.text(key, language))
  }
}
