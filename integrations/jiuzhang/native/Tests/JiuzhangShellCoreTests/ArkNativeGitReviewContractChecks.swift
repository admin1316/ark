import Darwin
import Foundation
@testable import JiuzhangShellUI

func runArkNativeGitReviewContractChecks() async {
  let fileManager = FileManager.default
  let root = fileManager.temporaryDirectory
    .appendingPathComponent("ark-git-review-\(UUID().uuidString)", isDirectory: true)
  try? fileManager.createDirectory(at: root, withIntermediateDirectories: true)
  defer { try? fileManager.removeItem(at: root) }

  let nonRepositoryRoot = fileManager.temporaryDirectory
    .appendingPathComponent("ark-not-git-\(UUID().uuidString)", isDirectory: true)
  try? fileManager.createDirectory(at: nonRepositoryRoot, withIntermediateDirectories: true)
  defer { try? fileManager.removeItem(at: nonRepositoryRoot) }

  func git(_ arguments: [String]) -> (String, Int32) {
    let process = Process()
    let pipe = Pipe()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
    process.arguments = ["-C", root.path] + arguments
    process.standardOutput = pipe
    process.standardError = pipe
    do {
      try process.run()
      let output = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
      process.waitUntilExit()
      return (output, process.terminationStatus)
    } catch {
      return (error.localizedDescription, -1)
    }
  }

  func waitUntil(
    timeoutNanoseconds: UInt64 = 4_000_000_000,
    _ predicate: @escaping @Sendable @MainActor () -> Bool
  ) async -> Bool {
    let start = DispatchTime.now().uptimeNanoseconds
    while DispatchTime.now().uptimeNanoseconds - start < timeoutNanoseconds {
      if await MainActor.run(body: predicate) { return true }
      try? await Task.sleep(nanoseconds: 20_000_000)
    }
    return await MainActor.run(body: predicate)
  }

  func processIsAlive(_ pid: pid_t) -> Bool {
    guard pid > 1 else { return false }
    if Darwin.kill(pid, 0) == 0 { return true }
    return errno == EPERM
  }

  let preCancelledMarker = root.appendingPathComponent("must-not-launch")
  let preCancelledToken = NativeProcessCancellation()
  preCancelledToken.cancel()
  let preCancelled = NativeProcessCapture.run(
    executableURL: URL(fileURLWithPath: "/bin/sh"),
    arguments: ["-c", "touch must-not-launch"],
    currentDirectoryURL: root,
    cancellation: preCancelledToken
  )
  check(
    preCancelled.stopReason == .cancelled
      && !fileManager.fileExists(atPath: preCancelledMarker.path),
    "native Git runner checks cancellation before posix_spawn"
  )

  let outputCap = 128 * 1024
  let capped = await Task.detached {
    NativeProcessCapture.run(
      executableURL: URL(fileURLWithPath: "/bin/sh"),
      arguments: ["-c", "/bin/dd if=/dev/zero bs=1048576 count=65 2>/dev/null"],
      currentDirectoryURL: root,
      outputByteLimit: outputCap,
      timeoutNanoseconds: 5_000_000_000
    )
  }.value
  check(
    capped.stopReason == .outputLimit
      && capped.exitCode != 0
      && capped.output.utf8.count <= outputCap + 128,
    "native Git runner stops a producer attempting more than 64 MiB at its streaming byte cap"
  )

  let timedOut = await Task.detached {
    NativeProcessCapture.run(
      executableURL: URL(fileURLWithPath: "/bin/sh"),
      arguments: ["-c", "sleep 60 & child=$!; echo $child; wait $child"],
      currentDirectoryURL: root,
      timeoutNanoseconds: 150_000_000
    )
  }.value
  let timedOutChild = timedOut.output
    .split(whereSeparator: { $0.isWhitespace })
    .compactMap { pid_t($0) }
    .first
  if let timedOutChild {
    let deadline = DispatchTime.now().uptimeNanoseconds + 2_000_000_000
    while processIsAlive(timedOutChild), DispatchTime.now().uptimeNanoseconds < deadline {
      try? await Task.sleep(nanoseconds: 20_000_000)
    }
  }
  check(
    timedOut.stopReason == .timedOut
      && timedOutChild != nil
      && timedOutChild.map(processIsAlive) == false,
    "native Git runner times out a hung hook and stops its owned process group"
  )

  let cancellation = NativeProcessCancellation()
  let cancellable = Task.detached {
    NativeProcessCapture.run(
      executableURL: URL(fileURLWithPath: "/bin/sh"),
      arguments: ["-c", "sleep 60"],
      currentDirectoryURL: root,
      timeoutNanoseconds: 5_000_000_000,
      cancellation: cancellation
    )
  }
  try? await Task.sleep(nanoseconds: 50_000_000)
  cancellation.cancel()
  let cancelled = await cancellable.value
  check(
    cancelled.stopReason == .cancelled && cancelled.exitCode != 0,
    "native Git runner cooperatively cancels and reaps only its owned process group"
  )

  let splitFixture = """
  diff --git a/Sources/sample.swift b/Sources/sample.swift
  index 1111111..2222222 100644
  --- a/Sources/sample.swift
  +++ b/Sources/sample.swift
  @@ -3,4 +3,5 @@
   let stable = true
  -let oldValue = 1
  +let newValue = 2
  +let extra = 3
   return stable
  @@ -20,2 +21,2 @@
  -finish(oldValue)
  +finish(newValue)
  """
  let splitDocument = NativeGitDiffDocument(patch: splitFixture)
  check(
    splitDocument.rows.contains {
      $0.oldText == "let oldValue = 1"
        && $0.oldKind == .deletion
        && $0.newText == "let newValue = 2"
        && $0.newKind == .addition
    },
    "native Git split diff aligns replacement rows across old and new panes"
  )
  check(
    splitDocument.rows.contains { $0.oldText.contains("unmodified lines") },
    "native Git split diff represents omitted unchanged ranges as compact hunk rows"
  )
  let splitStats = NativeGitDiffStats(patch: splitFixture)
  check(
    splitStats.additions == 3 && splitStats.deletions == 2,
    "native Git split diff derives its file summary from actual patch lines"
  )

  let nonRepositoryModel = await MainActor.run {
    NativeWorkbenchModel(
      rootURL: nonRepositoryRoot,
      draftJournal: NativeWorkbenchDraftJournal(
        storageURL: nonRepositoryRoot.appendingPathComponent(".ark-test-journal")
      ),
      draftDebounceNanoseconds: 0
    )
  }
  await MainActor.run { nonRepositoryModel.refreshGit() }
  let nonRepositorySettled = await waitUntil { !nonRepositoryModel.gitIsLoading }
  let nonRepositoryIsEmpty = await MainActor.run {
    nonRepositoryModel.gitChanges.isEmpty
      && nonRepositoryModel.selectedGitDiff.isEmpty
      && nonRepositoryModel.gitHistory.isEmpty
      && nonRepositoryModel.gitBranches.isEmpty
  }
  check(
    nonRepositorySettled && nonRepositoryIsEmpty,
    "native Git Review fails closed outside a repository instead of parsing stderr as fake files"
  )
  await MainActor.run { nonRepositoryModel.initializeGitRepository() }
  let repositoryInitialized = await waitUntil {
    !nonRepositoryModel.gitIsLoading && nonRepositoryModel.gitIsRepository
  }
  check(
    repositoryInitialized
      && fileManager.fileExists(atPath: nonRepositoryRoot.appendingPathComponent(".git").path),
    "native Git repository entry initializes only after an explicit user action"
  )

  guard git(["init", "-q"]).1 == 0,
        git(["config", "user.name", "Ark Test"]).1 == 0,
        git(["config", "user.email", "ark-test@example.invalid"]).1 == 0
  else {
    check(false, "native Git fixture initializes")
    return
  }
  let tracked = root.appendingPathComponent("tracked.txt")
  let untracked = root.appendingPathComponent("untracked.txt")
  try? "initial\n".write(to: tracked, atomically: true, encoding: .utf8)
  _ = git(["add", "--", "tracked.txt"])
  guard git(["commit", "-q", "-m", "initial"]).1 == 0 else {
    check(false, "native Git fixture creates an initial commit")
    return
  }
  let initialBranch = git(["branch", "--show-current"]).0
    .trimmingCharacters(in: .whitespacesAndNewlines)
  try? "modified\n".write(to: tracked, atomically: true, encoding: .utf8)
  try? "untracked\n".write(to: untracked, atomically: true, encoding: .utf8)

  let model = await MainActor.run {
    NativeWorkbenchModel(
      rootURL: root,
      draftJournal: NativeWorkbenchDraftJournal(
        storageURL: root.appendingPathComponent(".ark-test-journal")
      ),
      draftDebounceNanoseconds: 0
    )
  }
  await MainActor.run { model.refreshGit() }
  let initialLoaded = await waitUntil {
      !model.gitIsLoading
        && model.gitChanges.contains { $0.path == "tracked.txt" && $0.hasWorkingChange }
        && model.gitChanges.contains { $0.path == "untracked.txt" && $0.isUntracked }
        && !model.gitHistory.isEmpty
        && model.gitBranches.contains { $0.isCurrent }
    }
  check(
    initialLoaded,
    "native Git Review loads working, untracked, history, and branch data"
  )

  await MainActor.run {
    model.gitIdentityNameInput = "Ark Repository User"
    model.gitIdentityEmailInput = "repository@example.invalid"
    model.saveGitRepositoryIdentity()
  }
  let repositoryIdentitySaved = await waitUntil {
    !model.gitIsLoading
      && model.gitRepositoryIdentityName == "Ark Repository User"
      && model.gitRepositoryIdentityEmail == "repository@example.invalid"
  }
  check(
    repositoryIdentitySaved
      && git(["config", "--local", "--get", "user.name"]).0
        .trimmingCharacters(in: .whitespacesAndNewlines) == "Ark Repository User",
    "native Git repository entry saves a repository-local commit identity"
  )

  await MainActor.run {
    model.gitRemoteNameInput = "origin"
    model.gitRemoteURLInput = "https://example.invalid/ark/native-fixture.git"
    model.saveGitRemoteConnection()
  }
  let repositoryRemoteSaved = await waitUntil {
    !model.gitIsLoading
      && model.gitRemotes.contains {
        $0.name == "origin"
          && $0.fetchURL == "https://example.invalid/ark/native-fixture.git"
      }
  }
  check(
    repositoryRemoteSaved,
    "native Git repository entry connects a named remote without performing network activity"
  )
  await MainActor.run {
    model.gitRemoteNameInput = "unsafe"
    model.gitRemoteURLInput = "https://secret@example.invalid/private.git"
    model.saveGitRemoteConnection()
  }
  try? await Task.sleep(nanoseconds: 100_000_000)
  check(
    git(["remote", "get-url", "unsafe"]).1 != 0,
    "native Git repository entry refuses HTTP URLs with embedded credentials"
  )

  await MainActor.run {
    if let trackedChange = model.gitChanges.first(where: { $0.path == "tracked.txt" }) {
      model.selectGitChange(trackedChange)
      model.stageSelectedGitChange()
    }
  }
  let stagedSelected = await waitUntil {
      !model.gitIsLoading
        && model.gitChanges.first(where: { $0.path == "tracked.txt" })?.hasStagedChange == true
    }
  check(
    stagedSelected,
    "native Git Review stages one selected tracked file"
  )

  await MainActor.run { model.unstageSelectedGitChange() }
  let unstagedSelected = await waitUntil {
      !model.gitIsLoading
        && model.gitChanges.first(where: { $0.path == "tracked.txt" })?.hasStagedChange == false
    }
  check(
    unstagedSelected,
    "native Git Review unstages one selected file"
  )

  await MainActor.run {
    model.stageAllGitChanges()
  }
  let stagedAll = await waitUntil { !model.gitIsLoading && model.hasStagedGitChanges }
  check(
    stagedAll,
    "native Git Review stages all working and untracked changes"
  )

  await MainActor.run {
    model.gitCommitMessage = "native review fixture"
    model.commitStagedGitChanges()
  }
  let committed = await waitUntil {
      !model.gitIsLoading
        && model.gitChanges.isEmpty
        && model.gitHistory.first?.subject == "native review fixture"
    }
  check(
    committed,
    "native Git Review commits staged changes and refreshes history"
  )

  let historyFilesLoaded = await waitUntil {
    !model.gitCommitDiffIsLoading
      && model.gitCommitChanges.contains { $0.path == "tracked.txt" }
      && model.gitCommitChanges.contains { $0.path == "untracked.txt" }
      && model.selectedGitCommitPath != nil
      && !model.selectedGitCommitPatch.isEmpty
  }
  check(
    historyFilesLoaded,
    "native Git history loads a directory-ready changed-file list and one selected file diff"
  )
  let firstHistoryPath = await MainActor.run { model.selectedGitCommitPath }
  let firstHistoryPatch = await MainActor.run { model.selectedGitCommitPatch }
  check(
    firstHistoryPath.map { firstHistoryPatch.contains($0) } == true,
    "native Git history patch is scoped to the selected commit file"
  )
  await MainActor.run {
    if let alternate = model.gitCommitChanges.first(where: { $0.path != firstHistoryPath }) {
      model.selectGitCommitChange(alternate)
    }
  }
  let alternateHistoryLoaded = await waitUntil {
    !model.gitCommitDiffIsLoading
      && model.selectedGitCommitPath != firstHistoryPath
      && !model.selectedGitCommitPatch.isEmpty
  }
  let alternateStats = await MainActor.run {
    NativeGitDiffStats(patch: model.selectedGitCommitPatch)
  }
  check(
    alternateHistoryLoaded && alternateStats.additions + alternateStats.deletions > 0,
    "native Git history selects another changed file and reports real per-file line statistics"
  )

  try? "discard me\n".write(to: tracked, atomically: true, encoding: .utf8)
  await MainActor.run { model.refreshGit() }
  _ = await waitUntil {
    !model.gitIsLoading && model.gitChanges.contains { $0.path == "tracked.txt" }
  }
  await MainActor.run {
    if let trackedChange = model.gitChanges.first(where: { $0.path == "tracked.txt" }) {
      model.selectGitChange(trackedChange)
      model.requestDiscardSelectedGitChange()
      model.confirmGitDiscard()
    }
  }
  let discarded = await waitUntil { !model.gitIsLoading && model.gitChanges.isEmpty }
  let discardedDiskText = try? String(contentsOf: tracked, encoding: .utf8)
  check(
    discarded && discardedDiskText == "modified\n",
    "native Git Review confirms and discards one tracked working change"
  )

  await MainActor.run {
    model.gitNewBranchName = "feature/native-review"
    model.createGitBranch()
  }
  let branchCreated = await waitUntil {
      !model.gitIsLoading
        && model.gitBranches.contains { $0.name == "feature/native-review" && $0.isCurrent }
    }
  check(
    branchCreated,
    "native Git Review creates and switches to a validated local branch"
  )
  await MainActor.run {
    if let original = model.gitBranches.first(where: { $0.name == initialBranch }) {
      model.switchGitBranch(original)
    }
  }
  let branchSwitched = await waitUntil {
      !model.gitIsLoading && model.gitBranches.contains { $0.name == initialBranch && $0.isCurrent }
    }
  check(
    branchSwitched,
    "native Git Review switches between local branches"
  )

  check(
    NativeGitChange(statusLine: "UU conflict.txt")?.hasConflict == true,
    "native Git Review classifies conflict status without enabling destructive actions"
  )

  let sourceURL = contractNativeRoot.appendingPathComponent(
    "Sources/JiuzhangShellUI/NativeWorkbenchView.swift"
  )
  guard let source = try? String(contentsOf: sourceURL, encoding: .utf8) else {
    check(false, "native Git Review source is readable")
    return
  }
  let splitDiffURL = contractNativeRoot.appendingPathComponent(
    "Sources/JiuzhangShellUI/NativeGitSideBySideDiffView.swift"
  )
  let splitDiffSource = try? String(contentsOf: splitDiffURL, encoding: .utf8)
  check(
    splitDiffSource?.contains("NSTableView") == true
      && splitDiffSource?.contains("NativeGitSplitDiffCell") == true
      && splitDiffSource?.contains("hasVerticalScroller = true") == true
      && splitDiffSource?.contains("hasHorizontalScroller = true") == true,
    "native Git split diff uses one AppKit table and one synchronized scroll surface"
  )
  let forbiddenMutations = [
    ("reset", "[\"reset\""),
    ("hard reset", "\"--hard\""),
    ("forced operation", "\"--force\""),
    ("push", "[\"push\""),
    ("clean", "[\"clean\""),
    ("kill", "[\"kill\""),
  ]
  for (name, sourceNeedle) in forbiddenMutations {
    check(
      !source.contains(sourceNeedle),
      "native Git Review contains no automatic \(name) operation"
    )
  }
  check(
    source.contains("\"diff-tree\"")
      && source.contains("NativeGitChange.init(historyNameStatusLine:)")
      && source.contains("ark.review.history-files")
      && source.contains("refreshSelectedGitCommitDiff()")
      && source.contains("ark.review.repository")
      && source.contains("saveGitRemoteConnection()")
      && source.contains("saveGitRepositoryIdentity()"),
    "native Git review connects history files and an explicit repository identity and remote entry"
  )
  check(
    source.contains("Darwin.posix_spawn(")
      && source.contains("POSIX_SPAWN_SETPGROUP")
      && source.contains("outputByteLimit")
      && source.contains("timeoutNanoseconds")
      && source.contains("NativeProcessCancellation")
      && source.contains("Darwin.waitpid")
      && source.contains("signalOwnedProcessGroup")
      && source.contains("Git operation cancelled before next step")
      && !source.contains("readDataToEndOfFile()"),
    "native Git review uses one streaming byte-capped, cancellable, timeout-owned process runner"
  )
}
