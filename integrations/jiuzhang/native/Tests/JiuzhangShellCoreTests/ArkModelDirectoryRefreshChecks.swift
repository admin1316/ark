import Foundation
@testable import JiuzhangShellCore
@testable import JiuzhangShellUI

/// Only the RPC transport is synthetic; refresh ordering and published state use the real AppModel.
private final class ModelDirectoryURLProtocol: URLProtocol, @unchecked Sendable {
  private static let lock = NSLock()
  private static var catalog: [String: [String]] = [:]
  private static var holdNext = false
  private static var held: (ModelDirectoryURLProtocol, JSONValue)?
  private static var failModels = false

  static func configure(_ value: [String: [String]], hold: Bool = false, fail: Bool = false) {
    lock.lock()
    defer { lock.unlock() }
    catalog = value
    holdNext = hold
    failModels = fail
  }

  static var hasHeldResponse: Bool {
    lock.lock()
    defer { lock.unlock() }
    return held != nil
  }

  static func release() {
    lock.lock()
    let pending = held
    held = nil
    lock.unlock()
    pending?.0.respond(pending!.1)
  }

  override class func canInit(with request: URLRequest) -> Bool {
    request.url?.host == "ark-directory-refresh.invalid"
  }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    do {
      var data = request.httpBody ?? Data()
      if data.isEmpty, let stream = request.httpBodyStream {
        stream.open()
        defer { stream.close() }
        var buffer = [UInt8](repeating: 0, count: 4096)
        while true {
          let count = stream.read(&buffer, maxLength: buffer.count)
          if count == 0 { break }
          guard count > 0 else { throw ArkAPIError(message: "fixture body stream failed") }
          data.append(contentsOf: buffer.prefix(count))
        }
      }
      let body = try JSONDecoder().decode(JSONValue.self, from: data)
      guard let method = body["method"]?.stringValue, let rpcID = body["rpcId"]?.stringValue else {
        throw ArkAPIError(message: "fixture request missing method or id")
      }
      Self.lock.lock()
      let catalog = Self.catalog
      let hold = method == "llm/models" && Self.holdNext
      let fail = method == "llm/models" && Self.failModels
      if hold { Self.holdNext = false }
      Self.lock.unlock()
      let groups: [JSONValue] = catalog.keys.sorted().map { provider in
        .object(["id": .string(provider), "name": .string(provider), "models": .array(catalog[provider]!.map {
          .object(["id": .string($0), "name": .string($0)])
        })])
      }
      let value: JSONValue
      switch method {
      case "llm/providers":
        value = .object(["providers": .array(catalog.keys.sorted().map {
          .object(["provider": .string($0), "displayName": .string($0), "settingsNs": .string("fixture"),
            "settingsPath": .array([.string("providers"), .string($0)]), "active": .bool(true)])
        })])
      case "settings/describe":
        value = .object(["writable": .bool(true), "hasDocument": .bool(true), "namespaces": .array([
          .object(["ns": .string("fixture"), "value": .object([:]), "revision": .number(1), "applies": .string("live")]),
        ])])
      case "llm/models": value = .object(["groups": .array(groups)])
      case "session/models":
        value = .object(["ok": .bool(true), "value": .object(["current": .object(["provider": .string("removed"), "model": .string("old")]),
          "routable": .bool(catalog["removed"]?.contains("old") == true),
          "groups": .array(groups), "failures": .array([])])])
      case "credentials/describe": value = .object(["credentials": .object([:])])
      case "agentPreset/list": value = .object(["presets": .array([]), "authorable": .bool(false)])
      case "pluginInventory/list": value = .object(["entries": .array([])])
      default: value = .object([:])
      }
      let result: JSONValue = fail
        ? .object(["ok": .bool(false), "error": .object(["code": .string("fixture-unavailable"),
            "message": .string("model directory unavailable"), "details": .object([:])])])
        : .object(["ok": .bool(true), "value": value])
      let response: JSONValue = .object(["type": .string("server-response"), "rpcId": .string(rpcID),
        "result": .object(["ok": .bool(true), "value": result])])
      if hold {
        Self.lock.lock()
        Self.held = (self, response)
        Self.lock.unlock()
      } else { respond(response) }
    } catch { client?.urlProtocol(self, didFailWithError: error) }
  }

  private func respond(_ value: JSONValue) {
    do {
      let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil,
        headerFields: ["Content-Type": "application/json"])!
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: try JSONEncoder().encode(value))
      client?.urlProtocolDidFinishLoading(self)
    } catch { client?.urlProtocol(self, didFailWithError: error) }
  }

  override func stopLoading() {
    Self.lock.lock()
    defer { Self.lock.unlock() }
    if Self.held?.0 === self { Self.held = nil }
  }
}

@MainActor
func runArkModelDirectoryRefreshChecks() async {
  let suite = "ark-model-directory-contract-\(UUID().uuidString)"
  let defaults = UserDefaults(suiteName: suite)!
  let configuration = URLSessionConfiguration.ephemeral
  configuration.protocolClasses = [ModelDirectoryURLProtocol.self]
  let session = URLSession(configuration: configuration)
  defer {
    ModelDirectoryURLProtocol.release()
    session.invalidateAndCancel()
    defaults.removePersistentDomain(forName: suite)
  }
  let endpoint = URL(string: "https://ark-directory-refresh.invalid")!
  let model = ArkAppModel(client: ArkAPIClient(baseURL: endpoint, apiToken: "fixture", session: session),
    interactions: ArkInteractionAPI(baseURL: endpoint, apiToken: "fixture"),
    eventPump: ArkEventPump(baseURL: endpoint, apiToken: "fixture"),
    fallbackWikiRoot: URL(fileURLWithPath: "/private/tmp/ark-model-directory-fixture"), defaults: defaults)
  ModelDirectoryURLProtocol.configure(["removed": ["old"], "kept": ["a", "b"]])
  model.selectedSessionID = "history"
  await model.loadSettings()
  check(model.modelCatalog?.groups.count == 2 && model.availableModelGroups.count == 2,
    "Host and selected-session directories initially load through the real AppModel")

  ModelDirectoryURLProtocol.configure(["kept": ["b"]])
  await model.loadSettings()
  check(model.availableModelGroups.map(\.id) == ["kept"]
    && model.availableModelGroups.first?.models.map(\.id) == ["b"],
    "provider deletion and model removal replace the global directory without a restart")
  check(model.modelCatalog?.current.provider == "removed" && model.modelCatalog?.routable == false
    && model.composerModelCatalog?.groups.map(\.id) == ["kept"],
    "historical selection stays intact while deleted choices disappear from the live menu")
  model.selectedSessionID = nil
  check(model.composerModelCatalog?.groups.map(\.id) == ["kept"],
    "new conversations use the refreshed Host directory rather than a session cache")

  ModelDirectoryURLProtocol.configure([:])
  await model.loadSettings()
  check(model.availableModelGroups.isEmpty && model.composerModelCatalog == nil,
    "an empty authoritative directory clears the last provider instead of resurrecting cached choices")

  ModelDirectoryURLProtocol.configure(["late": ["old"]], hold: true)
  let oldLoad = Task { await model.loadSettings() }
  let deadline = Date().addingTimeInterval(5)
  while !ModelDirectoryURLProtocol.hasHeldResponse && Date() < deadline {
    try? await Task.sleep(nanoseconds: 1_000_000)
  }
  check(ModelDirectoryURLProtocol.hasHeldResponse, "the stale catalog response is held at the transport boundary")
  ModelDirectoryURLProtocol.configure(["current": ["new"]])
  await model.loadSettings()
  ModelDirectoryURLProtocol.release()
  await oldLoad.value
  check(model.availableModelGroups.map(\.id) == ["current"] && !model.settingsBusy,
    "a delayed older refresh cannot republish a deleted provider or change the latest busy state")

  ModelDirectoryURLProtocol.configure(["current": ["new"]], fail: true)
  await model.loadSettings()
  check(model.availableModelGroups.isEmpty && model.settingsErrorMessage != nil,
    "directory failure is visible and does not fall back to stale configured model rows")
}
