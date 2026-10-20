import Foundation
import Darwin
import JiuzhangShellCore
@testable import JiuzhangShellUI

/// Child writes an acknowledged-on-disk submission, then waits for an ungraceful kill.
func runArkComposerCrashRecoveryChildIfRequested() async -> Int32? {
  let environment = ProcessInfo.processInfo.environment
  guard let mode = environment["ARK_COMPOSER_CRASH_CHILD"],
    let path = environment["ARK_COMPOSER_CRASH_ROOT"] else { return nil }
  let root = URL(fileURLWithPath: path)
  let store = ArkDocumentReferenceStore(rootURL: root)
  do {
    if mode == "write" {
      let reference = try await store.importPastedText("独立进程文档", name: "synthetic.txt")
      var document = ArkComposerDraftDocument(text: "独立进程待确认消息")
      document.prepareSubmission(mode: .steer, timeZone: "Asia/Shanghai")
      let journal = try await store.persistDraftAttachments(
        images: [ArkPromptImage(mediaType: .png, data: Data([4, 5, 6]), name: "synthetic.png")], documents: [reference])
      try await store.persistPendingSubmission(document: document, sessionID: "crash-session", journalIdentifier: journal)
      try await store.persistInflightSubmission(document: document, sessionID: "crash-session", journalIdentifier: journal)
      try await store.persistPendingSubmission(document: ArkComposerDraftDocument(text: "发送期间的新输入"),
        sessionID: "crash-session", journalIdentifier: journal)
      try Data("ready".utf8).write(to: root.appendingPathComponent("ready"), options: [.atomic])
      while true { try await Task.sleep(nanoseconds: 1_000_000_000) }
    }
    guard let restored = try await store.restorePendingSubmission(sessionID: "crash-session"),
      restored.document.text == "发送期间的新输入",
      restored.images.map(\.data) == [Data([4, 5, 6])], restored.documents.count == 1 else { return 2 }
    let inflight = try await store.restoreInflightSubmissions(sessionID: "crash-session")
    guard inflight.count == 1, inflight[0].document.text == "独立进程待确认消息",
      inflight[0].document.submissionMode == .steer, inflight[0].document.submissionTimeZone == "Asia/Shanghai",
      inflight[0].document.submissionID != nil, inflight[0].images.map(\.data) == [Data([4, 5, 6])],
      inflight[0].documents.count == 1 else { return 4 }
    return 0
  } catch { return 3 }
}

func runArkComposerCrashRecoveryContractChecks() async {
  let root = FileManager.default.temporaryDirectory.appendingPathComponent("ark-composer-crash-\(UUID().uuidString)")
  defer { try? FileManager.default.removeItem(at: root) }
  func child(_ mode: String) -> Process {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL
    var environment = [String: String]()
    environment["PATH"] = "/usr/bin:/bin:/usr/sbin:/sbin"
    environment["ARK_COMPOSER_CRASH_CHILD"] = mode
    environment["ARK_COMPOSER_CRASH_ROOT"] = root.path
    process.environment = environment
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    return process
  }
  do {
    let writer = child("write")
    try writer.run()
    var ready = false
    for _ in 0..<500 {
      if FileManager.default.fileExists(atPath: root.appendingPathComponent("ready").path) { ready = true; break }
      if !writer.isRunning { break }
      try await Task.sleep(nanoseconds: 5_000_000)
    }
    check(ready, "independent child reaches durable submission barrier")
    if writer.isRunning { Darwin.kill(writer.processIdentifier, SIGKILL) }
    writer.waitUntilExit()
    guard ready else { return }
    let reader = child("read")
    try reader.run()
    for _ in 0..<500 {
      if !reader.isRunning { break }
      try await Task.sleep(nanoseconds: 5_000_000)
    }
    if reader.isRunning { Darwin.kill(reader.processIdentifier, SIGKILL) }
    reader.waitUntilExit()
    check(reader.terminationReason == .exit && reader.terminationStatus == 0,
      "new independent process restores both newer draft and unconfirmed payload with idempotent metadata and attachments after SIGKILL")
  } catch { check(false, "independent crash recovery fixture completes: \(error)") }
}
