import Foundation
import JiuzhangShellCore
import JiuzhangShellUI

private final class PromptRetryURLProtocol: URLProtocol, @unchecked Sendable {
  private static let lock = NSLock()
  private static var requests: [JSONValue] = []
  private static var lostResponses: Set<String> = []
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  static func reset() {
    lock.lock(); defer { lock.unlock() }
    requests = []; lostResponses = ["session/create", "session/prompt"]
  }
  static func captured() -> [JSONValue] { lock.lock(); defer { lock.unlock() }; return requests }
  override func startLoading() {
    do {
      var body = request.httpBody ?? Data()
      if let stream = request.httpBodyStream {
        stream.open(); defer { stream.close() }
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
          let count = stream.read(&buffer, maxLength: buffer.count)
          if count <= 0 { break }
          body.append(buffer, count: count)
        }
      }
      let envelope = try JSONDecoder().decode(JSONValue.self, from: body)
      let method = envelope["method"]!.stringValue!
      Self.lock.lock()
      Self.requests.append(envelope)
      let lose = Self.lostResponses.remove(method) != nil
      Self.lock.unlock()
      if lose { client?.urlProtocol(self, didFailWithError: URLError(.networkConnectionLost)); return }
      let args = envelope["payload"]?["args"]?["request"]
      let value: JSONValue = method == "session/create"
        ? .object(["sessionId": args?["sessionId"] ?? .string("unexpected")])
        : .object(["accepted": .bool(true)])
      let result: JSONValue = .object([
        "type": .string("server-response"), "rpcId": envelope["rpcId"]!,
        "result": .object(["ok": .bool(true), "value": .object([
          "ok": .bool(true), "value": .object(["ok": .bool(true), "value": value]),
        ])]),
      ])
      let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: try JSONEncoder().encode(result))
      client?.urlProtocolDidFinishLoading(self)
    } catch { client?.urlProtocol(self, didFailWithError: error) }
  }
  override func stopLoading() {}
}

func runArkPromptRetryContractChecks() async {
  do {
    var draft = ArkComposerDraftDocument()
    let base = draft.ensureSubmissionID()
    let restored = try JSONDecoder().decode(ArkComposerDraftDocument.self, from: JSONEncoder().encode(draft))
    check(restored.submissionID == base, "retry identity survives persisted draft decoding")
    draft.clear()
    check(draft.submissionID == nil, "successful image-only clearing retires its previous submission identity")
    let retried = draft.prepending(restored)
    check(retried.submissionID == base, "image-only failure recovery preserves the captured identity")
    let nextBase = draft.ensureSubmissionID()
    check(nextBase != base, "another intentional image-only submission obtains a fresh identity")
    let old = try JSONDecoder().decode(ArkComposerDraftDocument.self,
      from: Data(#"{"text":"old","references":[],"revision":1}"#.utf8))
    check(old.submissionID == nil && old.text == "old", "older saved drafts remain readable without retry metadata")

    PromptRetryURLProtocol.reset()
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [PromptRetryURLProtocol.self]
    let session = URLSession(configuration: configuration)
    defer { session.invalidateAndCancel() }
    let endpoint = URL(string: "https://ark-retry.invalid")!
    let api = ArkInteractionAPI(baseURL: endpoint, apiToken: "synthetic", session: session)
    let client = ArkAPIClient(baseURL: endpoint, apiToken: "synthetic", session: session)
    do {
      _ = try await client.createSession(workspaceID: nil, sessionID: base)
      check(false, "creation response loss is surfaced")
    } catch { check(true, "creation response loss is surfaced") }
    let created = try await client.createSession(workspaceID: nil, sessionID: base)
    check(created == base, "creation retry retains the exact requested session identity")
    let image = ArkPromptImage(mediaType: .png, data: Data([1, 2, 3]))
    do {
      try await api.sendPrompt(sessionID: base, text: "", images: [image], submissionID: base)
      check(false, "prompt response loss is surfaced")
    } catch { check(true, "prompt response loss is surfaced") }
    try await api.sendPrompt(sessionID: base, text: "", images: [image], submissionID: base)
    try await api.sendPrompt(sessionID: base, text: "changed", images: [image], submissionID: base)
    try await api.sendPrompt(sessionID: base, text: "", images: [image], mode: .steer, submissionID: base)
    try await api.sendPrompt(sessionID: base, text: "", images: [image], submissionID: nextBase)
    try await api.sendPrompt(sessionID: base, text: "", images: [ArkPromptImage(mediaType: .png, data: Data([1, 2, 4]))], submissionID: base)
    let wire = PromptRetryURLProtocol.captured()
    let creates = wire.filter { $0["method"] == .string("session/create") }
    check(creates.count == 2 && creates.allSatisfy { $0["payload"]?["args"]?["request"]?["sessionId"] == .string(base) },
          "lost creation response retries transmit one stable session ID")
    let ids = wire.filter { $0["method"] == .string("session/prompt") }
      .compactMap { $0["payload"]?["args"]?["request"]?["invocationId"]?.stringValue }
    check(ids.count == 6 && ids[0] == ids[1] && Set(ids.dropFirst()).count == 5,
          "same uncertain prompt retries reuse identity while content, mode, image bytes and new submissions differ")
  } catch { check(false, "prompt retry contract completes: \(error)") }
}
