import Foundation
import Darwin

/// Native-owned guard launch specification. A reviewed fixed helper program and
/// its exact Node runtime/configuration are pinned before a distinct guard socket
/// is created. Product startup has no such configuration and launches no guard.
public struct ArkProtectedGuardLaunch: Sendable {
  public let nodeExecutable: URL
  public let helperProgram: URL
  public let configuration: URL
  public let workingDirectory: URL
  public let fileDigests: [URL: String]
  public init(nodeExecutable: URL, helperProgram: URL, configuration: URL,
    workingDirectory: URL, fileDigests: [URL: String]) {
    self.nodeExecutable = nodeExecutable; self.helperProgram = helperProgram
    self.configuration = configuration; self.workingDirectory = workingDirectory; self.fileDigests = fileDigests
  }
}

public final class ArkProtectedGuardProcess {
  private let backend = BackendProcess()
  private var lineHandler: ((String) -> Void)?
  public private(set) var readyURL: URL?
  public init() {
    backend.onLine = { [weak self] line in
      if let url = URL(string: line), url.scheme == "http", url.host == "127.0.0.1", let port = url.port, port > 0,
        url.path.isEmpty, url.query == nil, url.fragment == nil { self?.readyURL = url }
      self?.lineHandler?(line)
    }
  }
  public var processIdentifier: pid_t? { backend.processIdentifier }
  public var isRunning: Bool { backend.isRunning }
  public var joinedReceipt: BackendProcessJoinedLaunch? { backend.joinedReceipt }
  public var generation: UUID { backend.generation }
  public var channelGeneration: UUID? { backend.channelGeneration }
  public var onLine: ((String) -> Void)? { get { lineHandler } set { lineHandler = newValue } }
  public var onExit: ((Int32) -> Void)? { get { backend.onExit } set { backend.onExit = newValue } }

  public func start(_ launch: ArkProtectedGuardLaunch, handler: @escaping ArkNativeOwnerChannel.Handler) throws {
    readyURL = nil
    try ArkProtectedRuntimePins.validate(root: launch.workingDirectory,
      node: launch.nodeExecutable, entry: launch.helperProgram,
      configuration: launch.configuration, pins: launch.fileDigests,
      helper: "knowledge-cost-guard-launcher.mjs")
    let channel = try ArkNativeOwnerChannel(hello: .object(["version": .number(1), "ok": .bool(true),
      "ownerStatus": .string("disabled"), "authorities": .array([]), "peerRole": .string("guard"), "costStatus": .string("ready")]),
      peerRole: .guardProcess, handler: { operation, payload in
        // Revalidate at each native-owned dispatch boundary. Persistent changes
        // fail closed; this does not make the long-lived helper immutable.
        try ArkProtectedRuntimePins.validate(root: launch.workingDirectory,
          node: launch.nodeExecutable, entry: launch.helperProgram,
          configuration: launch.configuration, pins: launch.fileDigests,
          helper: "knowledge-cost-guard-launcher.mjs")
        let result = try await handler(operation, payload)
        try ArkProtectedRuntimePins.validate(root: launch.workingDirectory,
          node: launch.nodeExecutable, entry: launch.helperProgram,
          configuration: launch.configuration, pins: launch.fileDigests,
          helper: "knowledge-cost-guard-launcher.mjs")
        return result
      })
    do {
      try backend.start(executable: launch.nodeExecutable.path,
        arguments: [launch.helperProgram.path, launch.configuration.path],
        environment: ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "en_US.UTF-8"],
        workingDirectory: launch.workingDirectory, ownerChannel: channel)
    } catch { channel.close(); throw error }
  }

  /// Completes only after the owned guard helper exits. The helper must drain
  /// startCostGuard.close() on SIGTERM; a forced exit remains a failed operation.
  public func stop(deadline: Date? = nil, completion: @escaping () -> Void) {
    backend.stop(deadline: deadline, completion: completion)
  }
}
