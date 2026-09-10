import Foundation
import JiuzhangShellCore

/// URLSession codec checks only; Loader/storage and process recovery have separate real-owner tests.
private final class ProviderRecoveryURLProtocol: URLProtocol, @unchecked Sendable {
  private static let lock = NSLock()
  private static var requests: [JSONValue] = []
  private static var migrationMode = "user"

  static func useMigration(_ mode: String) {
    lock.lock()
    defer { lock.unlock() }
    migrationMode = mode
  }

  static func reset() {
    lock.lock()
    defer { lock.unlock() }
    requests = []
  }

  static func snapshot() -> [JSONValue] {
    lock.lock()
    defer { lock.unlock() }
    return requests
  }

  override class func canInit(with request: URLRequest) -> Bool {
    request.url?.host == "ark-recovery-contract.invalid"
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
          guard count > 0 else { throw ArkAPIError(message: "fixture request stream failed") }
          data.append(contentsOf: buffer.prefix(count))
        }
      }
      let body = try JSONDecoder().decode(JSONValue.self, from: data)
      Self.lock.lock()
      Self.requests.append(body)
      let migrationMode = Self.migrationMode
      Self.lock.unlock()
      guard let method = body["method"]?.stringValue,
        let rpcID = body["rpcId"]?.stringValue,
        let url = request.url
      else { throw ArkAPIError(message: "fixture request envelope failed") }
      let provider: String
      if method == "llm/providers" {
        guard body["payload"]?["args"]?.objectValue != nil else { throw ArkAPIError(message: "fixture directory args failed") }
        provider = ""
      } else {
        guard let value = body["payload"]?["args"]?["request"]?["provider"]?.stringValue
        else { throw ArkAPIError(message: "fixture request envelope failed") }
        provider = value
      }

      let result: JSONValue
      if method == "llm/providers" {
        var migration: [String: JSONValue] = [
          "code": .string("credential-fields"), "fields": .array([.string("apiKey")]),
        ]
        if migrationMode != "incomplete" {
          let path = migrationMode == "unsafe-path" ? ["__proto__", "apiKey"] : ["apiKey"]
          migration["paths"] = .array([.array(path.map(JSONValue.string))])
          migration["inheritedPaths"] = migrationMode == "inherited" ? .array([.array([.string("apiKey")])]) : .array([])
        }
        if migrationMode == "unknown" { migration["code"] = .string("unknown-code") }
        result = .object(["ok": .bool(true), "value": .object(["providers": .array([.object([
          "provider": .string("openai"), "displayName": .string("OpenAI"), "settingsNs": .string("llm-pi-ai"),
          "settingsPath": .array([.string("providers"), .string("openai")]), "active": .bool(false),
          "migrationRequired": .object(migration),
          "error": migrationMode == "invalid-diagnostic" ? .number(1) : .string("Model configuration needs repair"),
        ])])])])
      } else if method == "llm/providerTransaction" {
        let state = provider == "unknown" ? "restoring" : provider
        result = .object(["ok": .bool(true), "value": .object([
          "state": .string(state), "needsCredential": .bool(state == "prepared"),
          "settingsNs": .string("fixture-settings"), "live": .bool(state == "committed"),
        ])])
      } else if method == "llm/resumeProvider", provider == "needs-credential" {
        result = .object(["ok": .bool(false), "error": .object([
          "code": .string("provider-transaction-needs-credential"),
          "message": .string("credential required"), "details": .object([:]),
        ])])
      } else if method == "llm/resumeProvider" {
        result = .object(["ok": .bool(true), "value": .object([
          "settings": .object([
            "ns": .string("fixture-settings"), "schema": .object([:]),
            "value": .object(["model": .string("restored")]), "applies": .string("live"),
            "secrets": .array([]), "revision": .number(2),
          ]), "live": .object(["accepted": .bool(true)]),
        ])])
      } else if method == "llm/verifyProvider" {
        let requestedModel = body["payload"]?["args"]?["request"]?["model"]?.stringValue ?? ""
        let mode = provider == "wrong-provider" || provider == "wrong-model" ? "metadata-auth" : provider
        result = .object(["ok": .bool(true), "value": .object([
          "provider": .string(provider == "wrong-provider" ? "other" : provider),
          "model": .string(provider == "wrong-model" ? "other" : requestedModel),
          "verified": .bool(mode != "endpoint-catalog"), "mode": .string(mode),
          "classification": .string("reachability-only"),
        ])])
      } else if method == "llm/discoverModels" {
        let capacities: [String: Double] = [
          "overflow": 1e100, "unsafe": 9_007_199_254_740_992,
          "fraction": 1.5, "zero": 0, "negative": -1, "safe": 9_007_199_254_740_991,
        ]
        var model: [String: JSONValue] = ["id": .string("catalog-model")]
        if let capacity = capacities[provider] {
          model["contextWindow"] = .number(capacity)
          model["maxTokens"] = .number(capacity)
        }
        if provider == "wrong-shape" { model["contextWindow"] = .string("not a number") }
        result = .object(["ok": .bool(true), "value": .object([
          "models": .array([.object(model)]),
        ])])
      } else { throw ArkAPIError(message: "fixture route failed") }
      let responseBody: JSONValue = .object([
        "type": .string("server-response"), "rpcId": .string(rpcID),
        "result": .object(["ok": .bool(true), "value": result]),
      ])
      guard let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])
      else { throw ArkAPIError(message: "fixture HTTP response failed") }
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: try JSONEncoder().encode(responseBody))
      client?.urlProtocolDidFinishLoading(self)
    } catch {
      client?.urlProtocol(self, didFailWithError: ArkAPIError(message: "fixture protocol failed"))
    }
  }

  // Replies finish synchronously in startLoading; there is no pending fixture work to cancel.
  override func stopLoading() {}
}

@MainActor
func runArkProviderRecoveryContractChecks() async {
  await runArkModelDirectoryRefreshChecks()
  ProviderRecoveryURLProtocol.reset()
  let configuration = URLSessionConfiguration.ephemeral
  configuration.protocolClasses = [ProviderRecoveryURLProtocol.self]
  let session = URLSession(configuration: configuration)
  defer { session.invalidateAndCancel(); ProviderRecoveryURLProtocol.reset() }
  guard let baseURL = URL(string: "https://ark-recovery-contract.invalid") else {
    check(false, "provider wire fixture URL is valid")
    return
  }
  let client = ArkAPIClient(baseURL: baseURL, apiToken: "fixture-transport-token", session: session)
  let transactionID = "33333333-3333-4333-8333-333333333333"
  do {
    for rawState in ["absent", "prepared", "credential-staged", "settings-applied", "credential-applied", "committed", "rolled-back", "committed-not-live"] {
      let status = try await client.providerTransaction(provider: rawState, transactionID: transactionID)
      check(status.state.rawValue == rawState, "native recovery decodes each retained Host state")
      check(status.transactionID == transactionID, "native recovery status remains bound to the requested transaction")
    }
    do {
      _ = try await client.providerTransaction(provider: "unknown", transactionID: transactionID)
      check(false, "native recovery refuses unknown states")
    } catch { check(true, "native recovery refuses unknown states") }
    let restored = try await client.resumeProvider(provider: "alpha", transactionID: transactionID, credentialValue: "fixture-write-only")
    check(restored.id == "fixture-settings" && restored.revision == 2, "native resume decodes the committed namespace")
    do {
      _ = try await client.resumeProvider(provider: "needs-credential", transactionID: transactionID)
      check(false, "native resume preserves the write-only credential failure")
    } catch let error as ArkAPIError {
      check(error.code == "provider-transaction-needs-credential", "native resume preserves the write-only credential failure")
    }
    let requests = ProviderRecoveryURLProtocol.snapshot()
    check(requests.count == 11, "native recovery sends only the requested query and restore calls")
    check(requests.allSatisfy { $0["payload"]?["args"]?["request"]?["transactionId"]?.stringValue == transactionID },
      "native recovery retains the durable transaction identity independently of RPC ids")
    check(requests.filter { $0["method"]?.stringValue == "llm/providerTransaction" }.allSatisfy {
      $0["payload"]?["args"]?["request"]?["credentialValue"] == nil
    }, "native status query never carries a credential value")
    check(requests.filter { $0["method"]?.stringValue == "llm/resumeProvider" }.allSatisfy {
      $0["payload"]?["args"]?["request"]?["ops"] == nil
        && $0["payload"]?["args"]?["request"]?["expectedRevision"] == nil
    }, "native resume does not reconstruct operations or revisions from UI drafts")
    ProviderRecoveryURLProtocol.reset()
    let builtins = try await client.discoverModels(
      settingsNamespace: "llm-pi-ai", provider: "deepseek", apiKey: "fixture-unused-key"
    )
    _ = try await client.discoverModels(
      settingsNamespace: "llm-pi-ai", provider: "custom", baseURL: "  https://candidate.invalid/v1  ", apiKey: "fixture-one-shot-key"
    )
    let discovery = ProviderRecoveryURLProtocol.snapshot()
    for invalid in ["not a URL", "file:///private/tmp/model", "ftp://fixture.invalid", "https://"] {
      do {
        _ = try await client.discoverModels(settingsNamespace: "llm-pi-ai", provider: "custom", baseURL: invalid, apiKey: "fixture-key")
        check(false, "invalid provider discovery URL must fail before sending the key")
      } catch is ArkAPIError {}
      do {
        _ = try await client.mutateProvider(provider: "custom", namespace: "llm-pi-ai",
          mutations: [.set(path: ["providers", "custom", "baseURL"], value: .string(invalid))], expectedRevision: 0)
        check(false, "invalid provider creation URL must fail before a mutation request")
      } catch is ArkAPIError {}
    }
    check(ProviderRecoveryURLProtocol.snapshot().count == discovery.count, "invalid provider endpoints never reach the transport")
    check(builtins.map(\.id) == ["catalog-model"], "built-in provider models load without a manually supplied URL")
    check(discovery.count == 2 && discovery[0]["payload"]?["args"]?["request"]?["apiKey"] == nil,
      "built-in catalog reads never transmit the unsaved API key")
    check(discovery[1]["payload"]?["args"]?["request"]?["baseURL"]?.stringValue == "https://candidate.invalid/v1"
      && discovery[1]["payload"]?["args"]?["request"]?["apiKey"]?.stringValue == "fixture-one-shot-key",
      "custom discovery binds the one-shot key to an explicit candidate endpoint")
    for provider in ["overflow", "unsafe", "fraction", "zero", "negative", "wrong-shape"] {
      do {
        _ = try await client.discoverModels(settingsNamespace: "llm-pi-ai", provider: provider)
        check(false, "native model capacities reject \(provider) without an integer-conversion trap")
      } catch {
        check(true, "native model capacities reject \(provider) without an integer-conversion trap")
      }
    }
    let largest = try await client.discoverModels(settingsNamespace: "llm-pi-ai", provider: "safe")
    check(largest.first?.contextWindow == 9_007_199_254_740_991 && largest.first?.maxTokens == 9_007_199_254_740_991,
      "native model capacities retain the largest exact JSON integer without an artificial model cap")
    for mode in ["user", "inherited", "incomplete"] {
      ProviderRecoveryURLProtocol.useMigration(mode)
      let providers = try await client.providers()
      check(providers.first?.migrationRequired?.fields == ["apiKey"], "native provider directory retains migration field names")
      check(providers.first?.configurationError == "Model configuration needs repair", "native provider directory retains repair diagnostics")
      check(providers.first?.migrationRequired?.canMigrateUserFields == (mode == "user"),
        "native migration requires explicit user-owned paths and blocks inherited or incomplete metadata")
    }
    for mode in ["unsafe-path", "unknown", "invalid-diagnostic"] {
      ProviderRecoveryURLProtocol.useMigration(mode)
      do {
        _ = try await client.providers()
        check(false, "native migration refuses \(mode) metadata")
      } catch { check(true, "native migration refuses \(mode) metadata") }
    }
    for mode in ["metadata-auth", "minimal-generation", "endpoint-catalog"] {
      let result = try await client.verifyProvider(provider: mode, model: "fixture-model")
      check(result.verified == (mode != "endpoint-catalog"), "connection verification distinguishes authentication proof from reachability")
    }
    for mode in ["wrong-provider", "wrong-model", "unknown-mode"] {
      do {
        _ = try await client.verifyProvider(provider: mode, model: "fixture-model")
        check(false, "connection verification rejects \(mode)")
      } catch { check(true, "connection verification rejects \(mode)") }
    }
  } catch { check(false, "native provider recovery wire checks complete") }
}
