import Foundation
import Network
import WebKit
@testable import JiuzhangShellUI

@MainActor
func runArkWorkbenchBrowserRuntimeContractChecks() async {
  check(validatedExternalBrowserURL("example.com")?.absoluteString == "https://example.com"
    && validatedExternalBrowserURL("localhost:8080/a")?.absoluteString == "https://localhost:8080/a"
    && validatedExternalBrowserURL("http://127.0.0.1:3080/api") != nil,
    "browser address input admits ordinary HTTP(S) names and explicit host ports")
  check(["file:/tmp/private", "file:///tmp/private", "javascript:alert(1)", "data:text/html,x", "about:blank", "https://user:secret@example.com", "https://user@example.com", ""].allSatisfy { validatedExternalBrowserURL($0) == nil },
    "browser address input rejects non-web schemes and URL credentials")
  let blank = URL(string: "about:blank")!
  check(!NativeBrowserNavigationPolicy.allows(blank)
    && NativeBrowserNavigationPolicy.allows(blank, isMainFrame: false, sourceProtocol: "https")
    && !NativeBrowserNavigationPolicy.allows(blank, isMainFrame: true, sourceProtocol: "https")
    && !NativeBrowserNavigationPolicy.allows(blank, isMainFrame: false, sourceProtocol: "file")
    && NativeBrowserNavigationPolicy.allows(NSURL(string: "about:blank")! as URL, isMainFrame: false, sourceProtocol: "http"),
    "only website-owned subframes may navigate internally to about blank")

  let session = NativeWorkbenchBrowserSession()
  session.language = .en
  guard let view = session.webView else { check(false, "browser session owns a WebKit view"); return }
  defer { session.dispose() }
  check(!view.configuration.websiteDataStore.isPersistent
    && view.configuration.defaultWebpagePreferences.allowsContentJavaScript
    && view.configuration.userContentController.userScripts.isEmpty,
    "browser uses ephemeral website state and ordinary JavaScript without injected scripts")
  session.address = "file:///tmp/private"
  session.navigate()
  check(session.validationMessage != nil && view.url == nil,
    "invalid browser address reports an error before WebKit navigation")
  session.address = "https://editing.example.test/unsubmitted"
  session.webViewWebContentProcessDidTerminate(view)
  check(session.validationMessage != nil && !session.isLoading,
    "web process termination leaves an actionable reload error")

  let fixture: NativeBrowserHTTPFixture
  do { fixture = try await NativeBrowserHTTPFixture.start() }
  catch { check(false, "browser loopback fixture starts: \(error)"); return }
  defer { fixture.stop() }
  let failedRedirect = NativeWorkbenchBrowserSession()
  failedRedirect.language = .en
  failedRedirect.address = fixture.url("/redirect-failure").absoluteString
  failedRedirect.navigate()
  let redirectFailureReported = await browserEventually {
    failedRedirect.validationMessage != nil && !failedRedirect.isLoading
  }
  check(redirectFailureReported, "HTTP redirect followed by connection failure preserves a visible navigation error")
  failedRedirect.dispose()
  session.address = fixture.url("/redirect").absoluteString
  session.navigate()
  let loaded = await browserEventually {
    !session.isLoading && session.title == "Fixture One" && view.url?.path == "/one"
  }
  check(loaded && session.validationMessage == nil, "browser loads a full HTML page after a 302 and 307 redirect chain")
  if loaded {
    do {
      let rendered = try await view.evaluateJavaScript("JSON.stringify({width:document.getElementById('box').getBoundingClientRect().width,image:document.getElementById('picture').naturalWidth,script:document.body.dataset.script})") as? String
      let values = rendered.flatMap { $0.data(using: .utf8) }.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
      check(values?["width"] as? Int == 137 && values?["image"] as? Int == 12 && values?["script"] as? String == "loaded",
        "browser renders stylesheet geometry image resources and external JavaScript")
      session.address = "https://editing.example.test/unsubmitted"
      _ = try await view.evaluateJavaScript("document.title = 'Updated Page Title'")
      _ = await browserEventually { session.title == "Updated Page Title" }
      check(session.address == "https://editing.example.test/unsubmitted",
        "title KVO cannot overwrite an address being edited")
      _ = try await view.evaluateJavaScript("document.getElementById('next').click()")
      let second = await browserEventually { session.title == "Fixture Two" && !session.isLoading }
      check(second && session.webView === view && session.canGoBack,
        "target blank navigation stays in the same retained browser tab")
      check(session.address == "https://editing.example.test/unsubmitted",
        "page navigation and URL observation preserve an unsubmitted address edit")
      session.goBack()
      let back = await browserEventually { view.url?.path == "/one" && !session.isLoading && session.canGoForward }
      check(back && session.canGoForward, "browser back navigation restores the previous page and forward history")
      session.goForward()
      let forward = await browserEventually { session.title == "Fixture Two" && !session.isLoading }
      check(forward, "browser forward navigation uses WebKit history")
      session.reload()
      let reloaded = await browserEventually { !session.isLoading && session.title == "Fixture Two" }
      check(reloaded, "browser reload keeps the same tab and page")
      _ = try await view.evaluateJavaScript("let a=document.createElement('a');a.href='file:///tmp/browser-must-not-read';document.body.appendChild(a);a.click()")
      let stillOnWebPage = try await view.evaluateJavaScript("location.pathname") as? String
      check(view.url?.scheme == "http" && stillOnWebPage == "/two",
        "WebKit blocks website initiated local file navigation without exposing local content")
      _ = try await view.evaluateJavaScript("let b=document.createElement('a');b.href='mailto:browser-fixture@example.test';document.body.appendChild(b);b.click()")
      let rejected = await browserEventually { session.validationMessage != nil }
      check(rejected && view.url?.scheme == "http",
        "delegate received non-web navigation is rejected with visible feedback")
    } catch { check(false, "browser real page interaction failed: \(error)") }
  }
  session.address = fixture.url("/missing").absoluteString
  session.navigate()
  let missing = await browserEventually { session.title == "Fixture Missing" && !session.isLoading }
  check(missing && session.validationMessage?.contains("404") == true,
    "HTTP failure pages remain visible with their status error")
  check(!fixture.sawAuthorization, "ordinary browser requests never receive a Host authorization header")
  session.cancel()
  check(session.webView === view && !session.isDisposed && !session.isLoading,
    "stop cancels loading while retaining the tab view and history")
  session.dispose()
  session.navigate()
  check(session.isDisposed && session.webView == nil && view.navigationDelegate == nil && view.uiDelegate == nil,
    "tab disposal releases WebKit ownership and cannot be revived by late navigation")
}

@MainActor
private func browserEventually(_ condition: () -> Bool) async -> Bool {
  for _ in 0..<120 {
    if condition() { return true }
    try? await Task.sleep(nanoseconds: 25_000_000)
  }
  return condition()
}

private final class NativeBrowserHTTPFixture: @unchecked Sendable {
  private let listener: NWListener
  private let queue = DispatchQueue(label: "ark.browser.http.fixture")
  private let lock = NSLock()
  private var connections: [ObjectIdentifier: NWConnection] = [:]
  private var authorization = false
  private var startCompleted = false
  private(set) var port: UInt16 = 0
  var sawAuthorization: Bool { lock.lock(); defer { lock.unlock() }; return authorization }
  private init() throws {
    let parameters = NWParameters.tcp
    parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
    listener = try NWListener(using: parameters)
  }
  static func start() async throws -> NativeBrowserHTTPFixture {
    let fixture = try NativeBrowserHTTPFixture()
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      fixture.listener.stateUpdateHandler = { state in
        guard !fixture.startCompleted else { return }
        switch state {
        case .ready:
          fixture.startCompleted = true; fixture.port = fixture.listener.port!.rawValue; continuation.resume()
        case .failed(let error): fixture.startCompleted = true; continuation.resume(throwing: error)
        default: break
        }
      }
      fixture.listener.newConnectionHandler = { [weak fixture] connection in
        guard let fixture else { connection.cancel(); return }
        fixture.lock.lock(); fixture.connections[ObjectIdentifier(connection)] = connection; fixture.lock.unlock()
        connection.start(queue: fixture.queue)
        fixture.receive(connection, buffer: Data())
      }
      fixture.listener.start(queue: fixture.queue)
    }
    fixture.listener.stateUpdateHandler = nil
    return fixture
  }
  func url(_ path: String) -> URL { URL(string: "http://127.0.0.1:\(port)\(path)")! }
  private func receive(_ connection: NWConnection, buffer: Data) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 16_384) { [weak self] data, _, complete, error in
      guard let self else { connection.cancel(); return }
      var bytes = buffer; if let data { bytes.append(data) }
      guard bytes.count < 65_536, error == nil else { self.close(connection); return }
      guard let request = String(data: bytes, encoding: .utf8), request.contains("\r\n\r\n") else {
        if complete { self.close(connection) } else { self.receive(connection, buffer: bytes) }
        return
      }
      if request.lowercased().contains("\r\nauthorization:") { self.lock.lock(); self.authorization = true; self.lock.unlock() }
      let path = request.split(separator: " ").dropFirst().first.map(String.init) ?? "/"
      if path == "/abort" { self.close(connection); return }
      let redirectTarget: String?
      switch path {
      case "/redirect": redirectTarget = "/redirect-again"
      case "/redirect-again": redirectTarget = "/one"
      case "/redirect-failure": redirectTarget = "/abort"
      default: redirectTarget = nil
      }
      if let redirectTarget {
        let status = path == "/redirect-again" ? "307 Temporary Redirect" : "302 Found"
        let bytes = Data("HTTP/1.1 \(status)\r\nLocation: \(redirectTarget)\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".utf8)
        connection.send(content: bytes, completion: .contentProcessed { [weak self] _ in self?.close(connection) })
        return
      }
      let type: String, body: String, status: String
      switch path {
      case "/one":
        type = "text/html"; status = "200 OK"
        body = "<html><head><title>Fixture One</title><style>#box{width:137px;height:43px;background:rgb(12,34,56)}</style></head><body><div id='box'>Page</div><img id='picture' src='/image.svg'><iframe src='about:blank'></iframe><a id='next' target='_blank' href='/two'>Next</a><script src='/script.js'></script></body></html>"
      case "/two": type = "text/html"; status = "200 OK"; body = "<html><title>Fixture Two</title><body>Second</body></html>"
      case "/image.svg": type = "image/svg+xml"; status = "200 OK"; body = "<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12'><rect width='12' height='12' fill='red'/></svg>"
      case "/script.js": type = "application/javascript"; status = "200 OK"; body = "document.body.dataset.script='loaded';"
      default: type = "text/html"; status = "404 Not Found"; body = "<html><title>Fixture Missing</title><body>Missing</body></html>"
      }
      let payload = Data(body.utf8)
      var response = Data("HTTP/1.1 \(status)\r\nContent-Type: \(type); charset=utf-8\r\nContent-Length: \(payload.count)\r\nConnection: close\r\n\r\n".utf8)
      response.append(payload)
      connection.send(content: response, completion: .contentProcessed { [weak self] _ in self?.close(connection) })
    }
  }
  private func close(_ connection: NWConnection) {
    connection.cancel(); lock.lock(); connections.removeValue(forKey: ObjectIdentifier(connection)); lock.unlock()
  }
  func stop() {
    listener.cancel(); listener.newConnectionHandler = nil; listener.stateUpdateHandler = nil
    lock.lock(); let active = Array(connections.values); connections.removeAll(); lock.unlock()
    active.forEach { $0.cancel() }
  }
}
