import Foundation
import JiuzhangShellCore

final class OwnerListener: NSObject, NSXPCListenerDelegate {
  private let clientRequirement: String
  init(clientRequirement: String) { self.clientRequirement = clientRequirement }
  func listener(_ listener: NSXPCListener, shouldAcceptNewConnection connection: NSXPCConnection) -> Bool {
    connection.setCodeSigningRequirement(clientRequirement)
    connection.exportedInterface = NSXPCInterface(with: ArkProtectedOwnerProtocol.self)
    // Real authority provisioning is deliberately absent. Test keys/configuration
    // are constructed only under Tests and are never installed in this target.
    let service = ArkProtectedOwnerService()
    connection.exportedObject = service
    connection.invalidationHandler = { service.disconnect() }
    connection.interruptionHandler = { service.disconnect(); connection.invalidate() }
    connection.resume()
    return true
  }
}

let application = Bundle.main.bundleURL.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
guard application.pathExtension == "app",
  let requirement = try? ArkProtectedPeerRequirement.requirement(for: application) else { exit(78) }
let delegate = OwnerListener(clientRequirement: requirement)
let listener = NSXPCListener.service()
listener.delegate = delegate
listener.resume()
