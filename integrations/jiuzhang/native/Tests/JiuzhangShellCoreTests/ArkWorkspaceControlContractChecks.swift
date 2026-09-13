import Foundation
@testable import JiuzhangShellCore
@testable import JiuzhangShellUI

@MainActor
func runArkWorkspaceControlContractChecks() async {
  check(ArkConnectionHealth.primary([.host: .connected, .mux: .degraded]) == .degraded,
    "connection pill exposes failed mux even when host navigation is connected")
  check(ArkConnectionHealth.primary([.host: .degraded, .mux: .connected]) == .degraded,
    "connection pill exposes failed host even when mux is connected")
  check(ArkConnectionHealth.primary([.host: .connected]) == .connecting,
    "connection pill never claims an unobserved channel is healthy")
  check(ArkConnectionHealth.primary([.host: .connected, .mux: .connected]) == .connected,
    "connection pill hides only after both channels have healthy baselines")

  let directory = FileManager.default.temporaryDirectory.appendingPathComponent("ark-open-contract-\(UUID().uuidString)")
    .appendingPathComponent("space ' $(no-command) 中文")
  do {
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory.deletingLastPathComponent()) }
    var captured: [(URL, URL)] = []
    for destination in ArkWorkspaceOpenDestination.allCases {
      try await ArkWorkspaceOpener.open(directory.path, destination: destination) { folder, app in captured.append((folder, app)) }
    }
    check(captured.count == 2 && captured.allSatisfy { $0.0.path == directory.path },
      "workspace opener preserves spaces quotes and shell metacharacters as file URL data")
    check(captured.map { $0.1 } == ArkWorkspaceOpenDestination.allCases.map(\.applicationURL),
      "workspace opener routes Finder and Terminal explicitly without executing a shell")
    let missing = directory.appendingPathComponent("missing").path
    do {
      try await ArkWorkspaceOpener.open(missing, destination: .terminal) { _, _ in check(false, "missing directory must not launch") }
      check(false, "workspace opener rejects unavailable directories")
    } catch ArkWorkspaceOpener.Failure.unavailableDirectory {
      check(true, "workspace opener rejects unavailable directories")
    }
    let file = directory.appendingPathComponent("file")
    try Data().write(to: file)
    do {
      try await ArkWorkspaceOpener.open(file.path, destination: .terminal) { _, _ in check(false, "regular file must not launch") }
      check(false, "workspace opener rejects regular files")
    } catch ArkWorkspaceOpener.Failure.unavailableDirectory {
      check(true, "workspace opener rejects regular files")
    }
    do {
      try await ArkWorkspaceOpener.open(directory.path, destination: .terminal) { _, _ in
        throw NSError(domain: "synthetic-open-failure", code: 17)
      }
      check(false, "terminal launch failure reaches the user-facing failure handler")
    } catch {
      check(ArkWorkspaceOpener.failureMessage(error, language: .zh) == ArkL10n.text(.openInFailed, .zh),
        "terminal launch failure reaches the localized user-facing failure handler")
    }
    var externalURL: URL?
    try ArkWorkspaceOpener.openProducedFile(file) { externalURL = $0; return true }
    check(externalURL == file, "produced file opener passes the validated file URL to the default application")
    do {
      try ArkWorkspaceOpener.openProducedFile(file) { _ in false }
      check(false, "rejected default application launch must surface an error")
    } catch ArkWorkspaceOpener.Failure.launchFailed {
      check(true, "rejected default application launch surfaces an error")
    }
    check(ArkWorkspaceOpener.failureMessage(ArkWorkspaceOpener.Failure.launchFailed, language: .en) == ArkL10n.text(.openInFailed, .en),
      "nil application completion is a launch failure rather than a missing-directory report")
  } catch { check(false, "workspace opener contract failed: \(error)") }
}
