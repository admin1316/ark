import Darwin
import Foundation
@testable import JiuzhangShellUI

/// Pure-kernel contract checks for Workbench terminal session recovery.
///
/// This file deliberately touches no session class and no view: it exercises
/// the persisted snapshot store, the kernel working-directory sampler, and the
/// bounded automatic-repair policy only.
@MainActor
func runArkTerminalSessionRepairContractChecks() {
  runArkTerminalSessionStoreContractChecks()
  runArkTerminalWorkingDirectoryContractChecks()
  runArkTerminalRepairPolicyContractChecks()
  runArkTerminalSessionRetentionContractChecks()
  print("native-terminal-session-repair: pure-kernel session checks complete")
}

private func runArkTerminalSessionStoreContractChecks() {
  let fileManager = FileManager.default
  let fixture = fileManager.temporaryDirectory
    .appendingPathComponent("ark-terminal-session-\(UUID().uuidString)", isDirectory: true)
  let storage = fixture.appendingPathComponent("terminal-sessions", isDirectory: true)
  defer { try? fileManager.removeItem(at: fixture) }

  let store = NativeTerminalSessionStore(storageDirectoryURL: storage)
  let key = "/Users/example/project|tab-1"
  let snapshot = NativeTerminalSessionSnapshot(
    cwd: "/Users/example/project",
    updatedAt: Date(timeIntervalSince1970: 1_700_000_000.25),
    repairCount: 2
  )

  check(store.load(forKey: key) == nil, "native terminal session store returns nil for an absent session")
  check(
    !fileManager.fileExists(atPath: storage.path),
    "native terminal session store creates no directory before the first save"
  )

  store.save(snapshot, forKey: key)
  check(
    store.load(forKey: key) == snapshot,
    "native terminal session store round-trips cwd, date, and repair count"
  )
  check(
    !String(describing: snapshot).contains("transcript")
      && !String(describing: snapshot).contains("line one"),
    "a session snapshot carries no terminal content to replay"
  )

  let digest = NativeTerminalSessionStore.storageKey(key)
  let recordURL = storage
    .appendingPathComponent(digest, isDirectory: false)
    .appendingPathExtension("json")
  check(
    fileManager.fileExists(atPath: recordURL.path),
    "native terminal session store writes the sha256-named json record"
  )

  var directoryInfo = stat()
  var recordInfo = stat()
  let directoryMode = lstat(storage.path, &directoryInfo) == 0
    ? directoryInfo.st_mode & 0o777 : 0
  let recordMode = lstat(recordURL.path, &recordInfo) == 0
    ? recordInfo.st_mode & 0o777 : 0
  check(
    directoryMode == 0o700 && (directoryMode & 0o077) == 0,
    "native terminal session store keeps its directory at 0700 (observed \(String(directoryMode, radix: 8)))"
  )
  check(
    recordMode == 0o600 && (recordMode & 0o077) == 0,
    "native terminal session store keeps every record at 0600 (observed \(String(recordMode, radix: 8)))"
  )

  let temporaryResidue = (try? fileManager.contentsOfDirectory(atPath: storage.path))?
    .filter { $0.hasSuffix(".tmp") } ?? []
  check(
    temporaryResidue.isEmpty,
    "native terminal session store leaves no temporary file after atomic replacement"
  )

  try? Data("{ this is not json".utf8).write(to: recordURL)
  check(
    store.load(forKey: key) == nil,
    "native terminal session store degrades corrupt json to nil"
  )
  try? Data("{\"cwd\":true,\"updatedAt\":\"x\",\"repairCount\":\"y\"}".utf8)
    .write(to: recordURL)
  check(
    store.load(forKey: key) == nil,
    "native terminal session store degrades a wrong-shaped record to nil"
  )

  store.save(snapshot, forKey: key)
  store.remove(forKey: key)
  check(
    store.load(forKey: key) == nil && !fileManager.fileExists(atPath: recordURL.path),
    "native terminal session store removes a persisted session"
  )
  store.remove(forKey: key)

  check(
    NativeTerminalSessionStore.storageKey("abc")
      == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    "native terminal session store hashes raw keys with SHA-256 lowercase hex"
  )
  check(
    NativeTerminalSessionStore.storageKey(key) == NativeTerminalSessionStore.storageKey(key)
      && NativeTerminalSessionStore.storageKey("a") != NativeTerminalSessionStore.storageKey("b"),
    "native terminal session store keys are stable and collision-free for distinct sessions"
  )
  check(
    NativeTerminalSessionStore.storageKey("project|tab").count == 64,
    "native terminal session store keys are 32-byte digests"
  )

  // 旧记录（还带 transcript 字段）必须继续可读：只取 cwd / repairCount，历史内容绝不回到终端。
  let legacySnapshotJSON = """
  {"cwd":"/Users/example/legacy","transcript":"replayed junk","updatedAt":1700000003,"repairCount":3}
  """
  try? Data(legacySnapshotJSON.utf8).write(to: store.recordURL(forKey: "legacy"))
  if let legacy = store.load(forKey: "legacy") {
    check(
      legacy.cwd == "/Users/example/legacy" && legacy.repairCount == 3,
      "a legacy record still restores its working directory and repair count"
    )
    check(
      !String(describing: legacy).contains("replayed junk"),
      "a legacy record's stored output is dropped, never replayed into a terminal"
    )
  } else {
    check(false, "native terminal session store reads a legacy record written with a transcript field")
  }

  let defaultStorage = NativeTerminalSessionStore.defaultStorageURL()

  runArkBoundedTranscriptContractChecks()
}

private func runArkBoundedTranscriptContractChecks() {
  check(
    NativeTerminalSessionStore.boundedTranscript("abcdef", limitBytes: 3) == "def",
    "bounded transcript keeps the ASCII tail past the byte limit"
  )
  check(
    NativeTerminalSessionStore.boundedTranscript("abcdef", limitBytes: 6) == "abcdef"
      && NativeTerminalSessionStore.boundedTranscript("abcdef", limitBytes: 99) == "abcdef",
    "bounded transcript returns a transcript that already fits unchanged"
  )
  check(
    NativeTerminalSessionStore.boundedTranscript("abcdef", limitBytes: 0) == ""
      && NativeTerminalSessionStore.boundedTranscript("abcdef", limitBytes: -4) == "",
    "bounded transcript returns empty for a non-positive limit"
  )
  check(
    NativeTerminalSessionStore.boundedTranscript("你好世界", limitBytes: 7) == "世界",
    "bounded transcript cuts on a UTF-8 scalar boundary instead of mid-character"
  )
  check(
    NativeTerminalSessionStore.boundedTranscript("你好世界", limitBytes: 12) == "你好世界"
      && NativeTerminalSessionStore.boundedTranscript("你好世界", limitBytes: 13) == "你好世界",
    "bounded transcript keeps multi-byte text exactly at the byte limit"
  )
  check(
    NativeTerminalSessionStore.boundedTranscript("a你好", limitBytes: 4) == "好",
    "bounded transcript drops a partial leading scalar when the limit lands mid-character"
  )
  check(
    NativeTerminalSessionStore.boundedTranscript("你好", limitBytes: 2) == "",
    "bounded transcript yields empty when the limit is smaller than one scalar"
  )

  let mixed = "启动 shell ⏎ 完成\n你好世界 abc"
  let mixedBytes = Array(mixed.utf8)
  var suffixFailures = 0
  var limitFailures = 0
  var identityFailures = 0
  for limit in 0...mixedBytes.count {
    let bounded = NativeTerminalSessionStore.boundedTranscript(mixed, limitBytes: limit)
    let boundedBytes = Array(bounded.utf8)
    if boundedBytes.count > limit { limitFailures += 1 }
    if !mixedBytes.suffix(boundedBytes.count).elementsEqual(boundedBytes) { suffixFailures += 1 }
    if limit >= mixedBytes.count && bounded != mixed { identityFailures += 1 }
  }
  check(
    limitFailures == 0,
    "bounded transcript never exceeds its byte limit across every cut point"
  )
  check(
    suffixFailures == 0,
    "bounded transcript is always a byte suffix of the original across every cut point"
  )
  check(
    identityFailures == 0,
    "bounded transcript preserves a transcript that fits across every cut point"
  )
}

private func runArkTerminalWorkingDirectoryContractChecks() {
  check(
    NativeTerminalWorkingDirectory.currentDirectory(ofPID: 0) == nil
      && NativeTerminalWorkingDirectory.currentDirectory(ofPID: -1) == nil
      && NativeTerminalWorkingDirectory.currentDirectory(ofPID: 999_999) == nil,
    "native terminal working directory returns nil for invalid or absent pids"
  )

  let ownPID = getpid()
  let ownDirectory = FileManager.default.currentDirectoryPath
  let sampledOwn = NativeTerminalWorkingDirectory.currentDirectory(ofPID: ownPID)
  check(
    sampledOwn == ownDirectory
      || sampledOwn == canonicalTerminalDirectoryPath(ownDirectory),
    "native terminal working directory samples the calling process cwd (observed \(sampledOwn ?? "nil"))"
  )

  runArkTerminalChildWorkingDirectoryProbe()

  let fileManager = FileManager.default
  let fixture = fileManager.temporaryDirectory
    .appendingPathComponent("ark-terminal-wd-\(UUID().uuidString)", isDirectory: true)
  defer { try? fileManager.removeItem(at: fixture) }

  let home = fixture.appendingPathComponent("home", isDirectory: true)
  let workspace = fixture.appendingPathComponent("workspace", isDirectory: true)
  let other = fixture.appendingPathComponent("other", isDirectory: true)
  let missingWorkspace = fixture.appendingPathComponent("missing-workspace", isDirectory: true)
  let stale = workspace.appendingPathComponent("moved-away", isDirectory: true)
  let plainFile = fixture.appendingPathComponent("not-a-directory.txt", isDirectory: false)
  for directory in [home, workspace, other] {
    try? fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
  }
  try? Data("file".utf8).write(to: plainFile)

  let existing = NativeTerminalWorkingDirectory.resolve(
    preferred: other.path,
    workspaceRoot: workspace,
    home: home
  )
  check(
    existing.url.path == other.path && existing.repaired == false && existing.missing == nil,
    "native terminal working directory keeps an existing preferred directory verbatim"
  )

  let staleResult = NativeTerminalWorkingDirectory.resolve(
    preferred: stale.path,
    workspaceRoot: workspace,
    home: home
  )
  check(
    staleResult.url.path == workspace.path
      && staleResult.repaired
      && staleResult.missing == stale.path,
    "native terminal working directory falls back to the workspace root for a moved-away cwd"
  )

  let fileResult = NativeTerminalWorkingDirectory.resolve(
    preferred: plainFile.path,
    workspaceRoot: workspace,
    home: home
  )
  check(
    fileResult.url.path == workspace.path
      && fileResult.repaired
      && fileResult.missing == plainFile.path,
    "native terminal working directory treats a non-directory preference as repaired"
  )

  let missingWorkspaceResult = NativeTerminalWorkingDirectory.resolve(
    preferred: stale.path,
    workspaceRoot: missingWorkspace,
    home: home
  )
  check(
    missingWorkspaceResult.url.path == home.path
      && missingWorkspaceResult.repaired
      && missingWorkspaceResult.missing == stale.path,
    "native terminal working directory falls back to home when the workspace root is gone"
  )

  let fresh = NativeTerminalWorkingDirectory.resolve(
    preferred: nil,
    workspaceRoot: workspace,
    home: home
  )
  check(
    fresh.url.path == workspace.path && fresh.repaired == false && fresh.missing == nil,
    "native terminal working directory treats a first run as the normal workspace directory"
  )

  let blank = NativeTerminalWorkingDirectory.resolve(
    preferred: "   ",
    workspaceRoot: workspace,
    home: home
  )
  check(
    blank.url.path == workspace.path && blank.repaired == false && blank.missing == nil,
    "native terminal working directory treats a blank preference as absent"
  )

  let missingWorkspaceFresh = NativeTerminalWorkingDirectory.resolve(
    preferred: nil,
    workspaceRoot: missingWorkspace,
    home: home
  )
  check(
    missingWorkspaceFresh.url.path == home.path
      && missingWorkspaceFresh.repaired == false
      && missingWorkspaceFresh.missing == nil,
    "native terminal working directory falls back to home without flagging a repair on first run"
  )

  let sameWorkspace = NativeTerminalWorkingDirectory.resolve(
    preferred: workspace.path,
    workspaceRoot: workspace,
    home: home
  )
  check(
    sameWorkspace.url.path == workspace.path
      && sameWorkspace.repaired == false
      && sameWorkspace.missing == nil,
    "native terminal working directory keeps a preferred cwd equal to the workspace root"
  )
}

/// Kernel canonical path (resolves the /var -> /private/var style aliases
/// that proc_pidinfo reports) without depending on Foundation symlink rules.
private func canonicalTerminalDirectoryPath(_ path: String) -> String {
  guard let resolved = realpath(path, nil) else { return path }
  defer { free(resolved) }
  return String(cString: resolved)
}

private func runArkTerminalChildWorkingDirectoryProbe() {
  let fileManager = FileManager.default
  let probeRoot = fileManager.temporaryDirectory
    .appendingPathComponent("ark-terminal-cwd-probe-\(UUID().uuidString)", isDirectory: true)
  defer { try? fileManager.removeItem(at: probeRoot) }
  do {
    try fileManager.createDirectory(at: probeRoot, withIntermediateDirectories: true)
    let child = Process()
    child.executableURL = URL(fileURLWithPath: "/bin/sleep")
    child.arguments = ["30"]
    child.currentDirectoryURL = probeRoot
    try child.run()
    let pid = child.processIdentifier
    let expected = canonicalTerminalDirectoryPath(probeRoot.path)
    var observed: String?
    let deadline = Date().addingTimeInterval(8)
    while Date() < deadline {
      observed = NativeTerminalWorkingDirectory.currentDirectory(ofPID: pid)
      if observed == expected { break }
      Thread.sleep(forTimeInterval: 0.1)
    }
    check(
      observed == expected,
      "native terminal working directory samples a live child pid (observed \(observed ?? "nil"), expected \(expected))"
    )
    if child.isRunning { child.terminate() }
    child.waitUntilExit()
  } catch {
    check(false, "native terminal working directory child probe runs: \(error)")
  }
}

private func runArkTerminalRepairPolicyContractChecks() {
  let base = Date(timeIntervalSince1970: 1_000_000)
  var policy = NativeTerminalRepairPolicy()
  check(
    policy.maxAttempts == 3 && policy.window == 15 && policy.delays == [0.5, 1.5, 3],
    "native terminal repair policy defaults to 3 attempts in 15s with 0.5/1.5/3s delays"
  )
  check(!policy.isExhausted && policy.attempts.isEmpty, "native terminal repair policy starts fresh")

  check(
    policy.recordAttempt(at: base) == 0.5
      && policy.recordAttempt(at: base.addingTimeInterval(1)) == 1.5,
    "native terminal repair policy returns the staged delays for the first attempts"
  )
  check(
    policy.attempts.count == 2 && !policy.isExhausted,
    "native terminal repair policy stays available inside the window"
  )
  check(
    policy.recordAttempt(at: base.addingTimeInterval(2)) == 3,
    "native terminal repair policy returns the final delay for the last attempt"
  )
  check(
    policy.isExhausted && policy.attempts.count == 3,
    "native terminal repair policy reports exhaustion after maxAttempts"
  )
  check(
    policy.recordAttempt(at: base.addingTimeInterval(3)) == nil
      && policy.recordAttempt(at: base.addingTimeInterval(4)) == nil,
    "native terminal repair policy refuses a rebuild once exhausted inside the window"
  )
  check(
    policy.attempts.count == 3,
    "native terminal repair policy does not record refused attempts"
  )

  policy.reset()
  check(
    policy.attempts.isEmpty && !policy.isExhausted,
    "native terminal repair policy reset clears the window"
  )

  var expiring = NativeTerminalRepairPolicy()
  _ = expiring.recordAttempt(at: base)
  _ = expiring.recordAttempt(at: base.addingTimeInterval(1))
  _ = expiring.recordAttempt(at: base.addingTimeInterval(2))
  check(expiring.isExhausted, "native terminal repair policy exhausts before its window expires")
  check(
    expiring.recordAttempt(at: base.addingTimeInterval(20)) == 0.5,
    "native terminal repair policy resets the window after 15s of silence"
  )
  check(
    expiring.attempts.count == 1 && !expiring.isExhausted,
    "native terminal repair policy keeps only the fresh attempt after expiry"
  )

  var partial = NativeTerminalRepairPolicy()
  _ = partial.recordAttempt(at: base)
  _ = partial.recordAttempt(at: base.addingTimeInterval(1))
  _ = partial.recordAttempt(at: base.addingTimeInterval(2))
  check(
    partial.recordAttempt(at: base.addingTimeInterval(10)) == nil,
    "native terminal repair policy keeps a fully retained window exhausted"
  )
  check(
    partial.recordAttempt(at: base.addingTimeInterval(16)) == 1.5,
    "native terminal repair policy drops only attempts outside the window"
  )

  var single = NativeTerminalRepairPolicy(maxAttempts: 1, window: 5, delays: [0.1])
  check(
    single.recordAttempt(at: base) == 0.1 && single.isExhausted,
    "native terminal repair policy honors a custom single-attempt budget"
  )
  check(
    single.recordAttempt(at: base.addingTimeInterval(1)) == nil,
    "native terminal repair policy refuses beyond a custom single-attempt budget"
  )
  check(
    single.recordAttempt(at: base.addingTimeInterval(6)) == 0.1,
    "native terminal repair policy reopens a custom window after it expires"
  )
}
/// A4 audit: the snapshot directory has a count ceiling, a TTL, and an active-key guard.
private func runArkTerminalSessionRetentionContractChecks() {
  let fileManager = FileManager.default
  let directory = fileManager.temporaryDirectory
    .appendingPathComponent("ark-terminal-retention-\(UUID().uuidString)", isDirectory: true)
  try? fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
  defer { try? fileManager.removeItem(at: directory) }

  let store = NativeTerminalSessionStore(storageDirectoryURL: directory)
  let now = Date()
  func snapshot(age: TimeInterval) -> NativeTerminalSessionSnapshot {
    NativeTerminalSessionSnapshot(
      cwd: directory.path,
      updatedAt: now.addingTimeInterval(-age),
      repairCount: 0
    )
  }

  store.save(snapshot(age: 40 * 24 * 60 * 60), forKey: "ttl-expired")
  store.save(snapshot(age: 60 * 60), forKey: "recent")
  store.save(snapshot(age: 2 * 24 * 60 * 60), forKey: "stale")
  // maxRecords 1: the recent record fills the budget, so the stale-but-unexpired record goes too.
  let removed = store.prune(now: now, maxRecords: 1)
  check(
    removed == 2
      && store.load(forKey: "recent") != nil
      && store.load(forKey: "stale") == nil
      && store.load(forKey: "ttl-expired") == nil,
    "terminal snapshot prune drops TTL-expired and over-count records while keeping recently used ones"
  )

  store.save(snapshot(age: 40 * 24 * 60 * 60), forKey: "active")
  store.save(snapshot(age: 40 * 24 * 60 * 60), forKey: "inactive")
  _ = store.prune(now: now, activeKeys: ["active"], maxRecords: 0)
  check(
    store.load(forKey: "active") != nil && store.load(forKey: "inactive") == nil,
    "terminal snapshot prune never removes an active session key"
  )

  let corrupt = store.recordURL(forKey: "corrupt")
  try? Data("{not json".utf8).write(to: corrupt)
  _ = store.prune(now: now, maxRecords: 0, ttl: -1)
  check(
    !fileManager.fileExists(atPath: corrupt.path),
    "terminal snapshot prune removes corrupt records once they exceed the TTL"
  )

  check(
    NativeTerminalSessionStore.defaultMaxRecords == 64
      && NativeTerminalSessionStore.defaultRecordTTL == 30 * 24 * 60 * 60
      && NativeTerminalSessionStore.defaultRecentInterval == 24 * 60 * 60,
    "terminal snapshot retention constants stay at 64 records / 30 day TTL / 24 hour recent window"
  )
}
