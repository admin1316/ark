import Foundation
import JiuzhangShellCore

private final class XPCProbeResult: @unchecked Sendable {
  private let lock = NSLock()
  private var continuation: CheckedContinuation<JSONValue, Never>?
  private var result: JSONValue?
  private var dispatched = false
  func businessWasDispatched() { lock.lock(); dispatched = true; lock.unlock() }
  func install(_ value: CheckedContinuation<JSONValue, Never>) {
    lock.lock(); if let result { lock.unlock(); value.resume(returning: result) }
    else { continuation = value; lock.unlock() }
  }
  func finish(_ status: String) {
    lock.lock(); guard result == nil else { lock.unlock(); return }
    let value: JSONValue = .object(["status": .string(status), "businessDispatched": .bool(dispatched)])
    result = value; let pending = continuation; continuation = nil; lock.unlock()
    pending?.resume(returning: value)
  }
}

func runArkProtectedXPCProbe(expectedService: URL) async -> Int32 {
  do {
    let requirement = try ArkProtectedPeerRequirement.requirement(for: expectedService)
    let connection = NSXPCConnection(serviceName: ArkProtectedOwnerBroker.serviceName)
    connection.setCodeSigningRequirement(requirement)
    connection.remoteObjectInterface = NSXPCInterface(with: ArkProtectedOwnerProtocol.self)
    let reply = XPCProbeResult()
    connection.invalidationHandler = { reply.finish("invalidated") }
    connection.interruptionHandler = { reply.finish("interrupted") }
    connection.resume()
    let result = await withCheckedContinuation { continuation in
      reply.install(continuation)
      guard let proxy = connection.remoteObjectProxyWithErrorHandler({ _ in reply.finish("peer-rejected") }) as? ArkProtectedOwnerProtocol else {
        reply.finish("proxy-unavailable"); return
      }
      let nonce = UUID().uuidString + UUID().uuidString
      proxy.handshake(nonce, version: 1) { value, version, _ in
        guard value == nonce, version == 1 else { reply.finish("bad-bootstrap"); return }
        reply.businessWasDispatched()
        proxy.perform("fixture", operation: "verifyCandidate", origin: "backend", payload: Data("{}".utf8)) { data, error in
          reply.finish(data == nil && error != nil ? "authenticated-disabled-owner" : "unexpected-business-result")
        }
      }
      DispatchQueue.global().asyncAfter(deadline: .now() + 5) { reply.finish("timeout") }
    }
    connection.invalidate()
    FileHandle.standardOutput.write(try ArkProtectedBytes.encode(result)); print("")
    return 0
  } catch { print("XPC fixture failed: \(error)"); return 1 }
}
