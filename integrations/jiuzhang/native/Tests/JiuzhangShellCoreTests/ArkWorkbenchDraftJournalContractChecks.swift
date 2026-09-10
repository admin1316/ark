import Darwin
import Foundation
@testable import JiuzhangShellUI

func runArkWorkbenchDraftJournalContractChecks() async {
  let fileManager = FileManager.default
  let home = fileManager.temporaryDirectory
    .appendingPathComponent("ark-draft-journal-\(UUID().uuidString)", isDirectory: true)
  let root = home.appendingPathComponent("workspace", isDirectory: true)
  let storage = home.appendingPathComponent("journal", isDirectory: true)
  try? fileManager.createDirectory(at: root, withIntermediateDirectories: true)
  defer { try? fileManager.removeItem(at: home) }

  let firstFile = root.appendingPathComponent("first.swift")
  let secondFile = root.appendingPathComponent("second.swift")
  let thirdFile = root.appendingPathComponent("third.swift")
  try? "one\n".write(to: firstFile, atomically: true, encoding: .utf8)
  try? "two\n".write(to: secondFile, atomically: true, encoding: .utf8)
  try? "three\n".write(to: thirdFile, atomically: true, encoding: .utf8)

  let journal = NativeWorkbenchDraftJournal(
    storageURL: storage,
    maximumRecordBytes: 8_192,
    maximumTotalBytes: 32_768,
    maximumRecords: 2
  )
  let first = NativeWorkbenchDraftRecord(
    workspaceRoot: root.path,
    filePath: firstFile.path,
    savedBaseline: "one\n",
    draftText: "one dirty\n",
    updatedAt: Date(timeIntervalSince1970: 1)
  )
  do {
    try journal.save(first)
    check(true, "native workbench draft journal saves a dirty buffer")
  } catch {
    check(false, "native workbench draft journal saves a dirty buffer: \(error)")
  }

  let firstURL = journal.recordURL(workspaceRoot: root.path, filePath: firstFile.path)
  var directoryInfo = stat()
  var recordInfo = stat()
  let directoryMode = lstat(storage.path, &directoryInfo) == 0
    ? directoryInfo.st_mode & 0o777 : 0
  let recordMode = lstat(firstURL.path, &recordInfo) == 0
    ? recordInfo.st_mode & 0o777 : 0
  check(
    directoryMode == 0o700 && recordMode == 0o600,
    "native workbench draft journal enforces 0700 directory and 0600 records"
  )
  check(
    (try? journal.load(workspaceRoot: root)) == [first],
    "native workbench draft journal reloads the canonical workspace draft"
  )

  let outside = home.appendingPathComponent("outside.swift")
  let escape = NativeWorkbenchDraftRecord(
    workspaceRoot: root.path,
    filePath: outside.path,
    savedBaseline: "",
    draftText: "escape"
  )
  do {
    try journal.save(escape)
    check(false, "native workbench draft journal rejects paths outside the workspace")
  } catch NativeWorkbenchDraftJournalError.pathOutsideWorkspace {
    check(true, "native workbench draft journal rejects paths outside the workspace")
  } catch {
    check(false, "native workbench draft journal rejects paths outside the workspace: \(error)")
  }

  let second = NativeWorkbenchDraftRecord(
    workspaceRoot: root.path,
    filePath: secondFile.path,
    savedBaseline: "two\n",
    draftText: "two dirty\n",
    updatedAt: Date(timeIntervalSince1970: 2)
  )
  let third = NativeWorkbenchDraftRecord(
    workspaceRoot: root.path,
    filePath: thirdFile.path,
    savedBaseline: "three\n",
    draftText: "three dirty\n",
    updatedAt: Date(timeIntervalSince1970: 3)
  )
  try? journal.save(second)
  try? journal.save(third)
  check(
    (try? journal.load(workspaceRoot: root).count) == 2,
    "native workbench draft journal prunes to its bounded record count"
  )
  let temporaryResidue = (try? fileManager.contentsOfDirectory(atPath: storage.path))?
    .filter { $0.hasSuffix(".tmp") } ?? []
  check(
    temporaryResidue.isEmpty,
    "native workbench draft journal leaves no temporary file after atomic replacement"
  )

  var tabs = NativeFileTabsState()
  let recoveredID = tabs.openRecoveredTab(
    url: firstFile,
    savedBaseline: "one\n",
    draftText: "one dirty\n"
  )
  check(
    tabs.tab(withID: recoveredID)?.savedBaseline == "one\n"
      && tabs.tab(withID: recoveredID)?.text == "one dirty\n"
      && tabs.tab(withID: recoveredID)?.isDirty == true,
    "native file tabs mount a recovered draft with its original CAS baseline"
  )

  let raceStorage = home.appendingPathComponent("race-journal", isDirectory: true)
  let raceJournal = NativeWorkbenchDraftJournal(storageURL: raceStorage)
  let writer = NativeWorkbenchDraftWriter(
    journal: raceJournal,
    debounceNanoseconds: 40_000_000
  )
  async let pendingWrite = writer.schedule(first, mutationSequence: 1)
  let clearError = await writer.clear(
    workspaceRoot: root,
    fileURL: firstFile,
    mutationSequence: 2
  )
  _ = await pendingWrite
  check(
    clearError == nil && (try? raceJournal.load(workspaceRoot: root).isEmpty) == true,
    "native workbench draft clear invalidates a pending debounce write"
  )
  let newest = NativeWorkbenchDraftRecord(
    workspaceRoot: root.path,
    filePath: firstFile.path,
    savedBaseline: "one\n",
    draftText: "newest dirty\n",
    updatedAt: Date(timeIntervalSince1970: 4)
  )
  _ = await writer.schedule(newest, mutationSequence: 4)
  let staleClearError = await writer.clear(
    workspaceRoot: root,
    fileURL: firstFile,
    mutationSequence: 3
  )
  check(
    staleClearError == nil && (try? raceJournal.load(workspaceRoot: root)) == [newest],
    "native workbench draft writer ignores a stale clear after a newer save"
  )

  let exitStorage = home.appendingPathComponent("exit-journal", isDirectory: true)
  let exitJournal = NativeWorkbenchDraftJournal(storageURL: exitStorage)
  let exitModel = await MainActor.run {
    NativeWorkbenchModel(
      rootURL: root,
      draftJournal: exitJournal,
      draftDebounceNanoseconds: 80_000_000
    )
  }
  await exitModel.selectFile(firstFile)
  await MainActor.run { exitModel.updateEditorText("last edit before quit\n") }
  let firstFlushError = await exitModel.flushRecoveryDrafts()
  let repeatedFlushError = await exitModel.flushRecoveryDrafts()
  let exitRecords = try? exitJournal.load(workspaceRoot: root)
  check(
    firstFlushError == nil
      && repeatedFlushError == nil
      && exitRecords?.count == 1
      && exitRecords?.first?.draftText == "last edit before quit\n",
    "native workbench termination flush persists the last debounced edit and is repeatable"
  )
  try? await Task.sleep(nanoseconds: 100_000_000)

  let modelStorage = home.appendingPathComponent("model-journal", isDirectory: true)
  let modelJournal = NativeWorkbenchDraftJournal(storageURL: modelStorage)
  try? modelJournal.save(first)
  let recoveryModel = await MainActor.run {
    let model = NativeWorkbenchModel(
      rootURL: root,
      draftJournal: modelJournal,
      draftDebounceNanoseconds: 0
    )
    model.loadIfNeeded()
    return model
  }
  try? await Task.sleep(nanoseconds: 20_000_000)
  let recoveryModelState = await MainActor.run {
    (recoveryModel.recoveryDrafts, recoveryModel.recoverySheetPresented)
  }
  check(
    recoveryModelState.0 == [first] && recoveryModelState.1,
    "native workbench model presents matching workspace drafts on first load"
  )

  let workbenchURL = contractNativeRoot.appendingPathComponent(
    "Sources/JiuzhangShellUI/NativeWorkbenchView.swift"
  )
  let journalURL = contractNativeRoot.appendingPathComponent(
    "Sources/JiuzhangShellUI/NativeWorkbenchDraftJournal.swift"
  )
  guard let workbench = try? String(contentsOf: workbenchURL, encoding: .utf8),
        let journalSource = try? String(contentsOf: journalURL, encoding: .utf8)
  else {
    check(false, "native workbench recovery sources are readable")
    return
  }
  check(
    workbench.contains("NativeWorkbenchRecoverySheet")
      && workbench.contains("set: model.updateEditorText")
      && workbench.contains("scheduleRecoveryDraft(for: tab)")
      && workbench.contains("clearRecoveryDraft(for: active)")
      && workbench.contains("draftFlushCoordinator.register")
      && workbench.contains("await model.flushRecoveryDrafts()")
      && workbench.contains("fileTabs.openRecoveredTab(")
      && workbench.contains("DispatchQueue.main.async { [weak self] in")
      && workbench.contains("recoverySheetPresented = true"),
    "native Files wires edit, save, discard, startup, restore, and compare to the draft journal"
  )
  check(
    journalSource.contains("O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC")
      && journalSource.contains("S_IRUSR | S_IWUSR")
      && journalSource.contains("fsync(descriptor)")
      && journalSource.contains("rename(temporary.path, destination.path)")
      && journalSource.contains("maximumTotalBytes")
      && journalSource.contains("maximumRecords")
      && journalSource.contains("final class NativeWorkbenchDraftFlushCoordinator")
      && journalSource.contains("highestMutationSequence")
      && workbench.contains("nextDraftMutationSequence(for:")
      && workbench.contains("mutationSequence: mutationSequence"),
    "native draft journal uses bounded same-directory atomic durable writes"
  )
}
