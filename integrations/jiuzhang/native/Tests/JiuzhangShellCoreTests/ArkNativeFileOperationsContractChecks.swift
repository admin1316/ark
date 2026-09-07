import CryptoKit
import Foundation
@testable import JiuzhangShellUI

func runArkNativeFileOperationsContractChecks() {
  let fileManager = FileManager.default
  let home = fileManager.temporaryDirectory
    .appendingPathComponent("ark-file-ops-\(UUID().uuidString)", isDirectory: true)
  let root = home.appendingPathComponent("workspace", isDirectory: true)
  let outside = home.appendingPathComponent("outside", isDirectory: true)
  try? fileManager.createDirectory(at: root, withIntermediateDirectories: true)
  try? fileManager.createDirectory(at: outside, withIntermediateDirectories: true)
  defer { try? fileManager.removeItem(at: home) }

  func setExtendedAttribute(_ name: String, value: Data, at url: URL) -> Bool {
    value.withUnsafeBytes { bytes in
      url.path.withCString { path in
        name.withCString { attribute in
          Darwin.setxattr(path, attribute, bytes.baseAddress, bytes.count, 0, 0) == 0
        }
      }
    }
  }

  func extendedAttribute(_ name: String, at url: URL) -> Data? {
    let length = url.path.withCString { path in
      name.withCString { attribute in
        Darwin.getxattr(path, attribute, nil, 0, 0, 0)
      }
    }
    guard length >= 0 else { return nil }
    var value = Data(count: length)
    let read = value.withUnsafeMutableBytes { bytes in
      url.path.withCString { path in
        name.withCString { attribute in
          Darwin.getxattr(path, attribute, bytes.baseAddress, bytes.count, 0, 0)
        }
      }
    }
    return read == length ? value : nil
  }

  func accessControlList(at url: URL) -> String? {
    guard let list = url.path.withCString({ Darwin.acl_get_file($0, ACL_TYPE_EXTENDED) }) else {
      return nil
    }
    defer { Darwin.acl_free(UnsafeMutableRawPointer(list)) }
    var length: ssize_t = 0
    guard let text = Darwin.acl_to_text(list, &length) else { return nil }
    defer { Darwin.acl_free(UnsafeMutableRawPointer(text)) }
    return String(cString: text)
  }

  guard let access = try? NativeWorkspaceAccess(rootURL: root) else {
    check(false, "native file operations open a confined temporary workspace")
    return
  }

  do {
    let sourceFolder = try access.createFolder(named: "source", in: root)
    let sourceFile = try access.createFile(named: "draft.txt", in: sourceFolder)
    try access.atomicWrite("hello\n", to: sourceFile, expectedText: "")
    let metadata = Data("ark-metadata".utf8)
    let resourceFork = Data("ark-resource-fork".utf8)
    let aclResult = NativeProcessCapture.run(
      executableURL: URL(fileURLWithPath: "/bin/chmod"),
      arguments: ["+a", "everyone allow read", sourceFile.path],
      currentDirectoryURL: root
    )
    let sourceACL = accessControlList(at: sourceFile)
    let metadataInstalled = setExtendedAttribute("com.openai.ark.fixture", value: metadata, at: sourceFile)
      && setExtendedAttribute("com.apple.ResourceFork", value: resourceFork, at: sourceFile)
      && aclResult.exitCode == 0
      && sourceACL != nil
    let duplicate = try access.duplicateItem(sourceFile)
    let renamed = try access.renameItem(duplicate, to: "renamed.txt")
    let destination = try access.createFolder(named: "destination", in: root)
    let moved = try access.moveItem(renamed, to: destination)
    check(
      moved.lastPathComponent == "renamed.txt"
        && (try? access.readUTF8Text(at: moved)) == "hello\n"
        && metadataInstalled
        && extendedAttribute("com.openai.ark.fixture", at: moved) == metadata
        && extendedAttribute("com.apple.ResourceFork", at: moved) == resourceFork
        && accessControlList(at: moved) == sourceACL
        && !fileManager.fileExists(atPath: renamed.path),
      "native file operations preserve xattrs and resource forks through descriptor-safe duplication"
    )
  } catch {
    check(false, "native file operations create/duplicate/rename/move: \(error)")
  }

  do {
    _ = try access.createFolder(named: "destination", in: root)
    check(false, "native file operations reject an existing destination")
  } catch NativeWorkbenchError.itemAlreadyExists {
    check(true, "native file operations reject an existing destination")
  } catch {
    check(false, "native file operations reject an existing destination: \(error)")
  }

  do {
    _ = try access.createFile(named: "../escape.txt", in: root)
    check(false, "native file operations reject path-shaped leaf names")
  } catch NativeWorkbenchError.invalidItemName {
    check(true, "native file operations reject path-shaped leaf names")
  } catch {
    check(false, "native file operations reject path-shaped leaf names: \(error)")
  }

  do {
    _ = try access.createFile(named: "outside.txt", in: outside)
    check(false, "native file operations reject destination directories outside the root")
  } catch NativeWorkbenchError.pathOutsideRoot {
    check(true, "native file operations reject destination directories outside the root")
  } catch {
    check(false, "native file operations reject destination directories outside the root: \(error)")
  }

  do {
    _ = try access.createFile(named: ".DS_Store", in: root)
    _ = try access.createFile(named: ".localized", in: root)
    let ordinary = try access.listDirectory(root, showHiddenNoise: false).map(\.name)
    let explicit = try access.listDirectory(root, showHiddenNoise: true).map(\.name)
    if ordinary.contains(".DS_Store")
      || ordinary.contains(".localized")
      || !explicit.contains(".DS_Store")
      || !explicit.contains(".localized") {
      print("FILE NOISE DIAGNOSTIC ordinary=\(ordinary) explicit=\(explicit)")
    }
    check(
      !ordinary.contains(".DS_Store")
        && !ordinary.contains(".localized")
        && explicit.contains(".DS_Store")
        && explicit.contains(".localized"),
      "native file tree hides system noise by default and reveals it explicitly"
    )
  } catch {
    check(false, "native file hidden-noise behavior: \(error)")
  }

  let outsideFile = outside.appendingPathComponent("outside.txt")
  try? "outside".write(to: outsideFile, atomically: true, encoding: .utf8)
  let link = root.appendingPathComponent("outside-link")
  try? fileManager.createSymbolicLink(at: link, withDestinationURL: outsideFile)
  let listedNames = (try? access.listDirectory(root, showHiddenNoise: true).map(\.name)) ?? []
  check(
    !listedNames.contains("outside-link") && (try? access.readUTF8Text(at: link)) == nil,
    "native file operations neither display nor follow a symlink escape"
  )

  let routedFile = root.appendingPathComponent("routed.txt")
  try? "routed".write(to: routedFile, atomically: true, encoding: .utf8)
  check(
    (try? access.validatedRegularFileURL(routedFile)) == routedFile.standardizedFileURL,
    "native transcript file routing admits an ordinary file under the exact workspace root"
  )
  check(
    (try? access.validatedRegularFileURL(outsideFile)) == nil
      && (try? access.validatedRegularFileURL(link)) == nil
      && (try? access.validatedRegularFileURL(root)) == nil,
    "native transcript file routing rejects outside paths, symlinks, and directories"
  )

  do {
    try access.trashItem(link)
    check(false, "native Trash rejects a symlink swapped into the selected leaf")
  } catch {
    check(
      (try? String(contentsOf: outsideFile, encoding: .utf8)) == "outside",
      "native Trash rejects a symlink swapped into the selected leaf without touching its target"
    )
  }

  let conflictFile = root.appendingPathComponent("conflict.txt")
  try? "disk-v1".write(to: conflictFile, atomically: true, encoding: .utf8)
  try? "disk-v2".write(to: conflictFile, atomically: true, encoding: .utf8)
  do {
    try access.atomicWrite("local", to: conflictFile, expectedText: "disk-v1")
    check(false, "native atomic save rejects an external content mutation")
  } catch NativeWorkbenchError.externalModificationConflict {
    check(
      (try? String(contentsOf: conflictFile, encoding: .utf8)) == "disk-v2",
      "native atomic save rejects an external content mutation without overwriting it"
    )
  } catch {
    check(false, "native atomic save reports its external mutation as a conflict: \(error)")
  }

  let tree = root.appendingPathComponent("tree", isDirectory: true)
  let nested = tree.appendingPathComponent("nested", isDirectory: true)
  try? fileManager.createDirectory(at: nested, withIntermediateDirectories: true)
  try? "payload".write(
    to: nested.appendingPathComponent("payload.txt"),
    atomically: true,
    encoding: .utf8
  )
  do {
    let copiedTree = try access.duplicateItem(tree)
    check(
      (try? access.readUTF8Text(at: copiedTree.appendingPathComponent("nested/payload.txt"))) == "payload",
      "native directory duplication copies recursively through no-follow descriptors"
    )
  } catch {
    check(false, "native descriptor directory duplication succeeds: \(error)")
  }

  let unsafeTree = root.appendingPathComponent("unsafe-tree", isDirectory: true)
  try? fileManager.createDirectory(at: unsafeTree, withIntermediateDirectories: true)
  try? fileManager.createSymbolicLink(
    at: unsafeTree.appendingPathComponent("escape"),
    withDestinationURL: outsideFile
  )
  do {
    _ = try access.duplicateItem(unsafeTree)
    check(false, "native directory duplication rejects nested symlinks")
  } catch {
    check(
      !fileManager.fileExists(atPath: root.appendingPathComponent("unsafe-tree copy").path),
      "native directory duplication rejects nested symlinks and removes its private partial copy"
    )
  }

  func digest(_ value: String) -> String {
    SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
  }
  func installSaveRecoveryFixture(
    directory: URL,
    fileName: String,
    target: String?,
    stagedNew: String?,
    stagedOld: String?
  ) -> NativeSaveTransactionRecord? {
    let record = NativeSaveTransactionRecord(
      fileName: fileName,
      transactionID: UUID().uuidString,
      expectedOldSHA256: digest(stagedOld ?? "old"),
      newSHA256: digest(stagedNew ?? target ?? "new")
    )
    do {
      if let target {
        try target.write(
          to: directory.appendingPathComponent(fileName),
          atomically: false,
          encoding: .utf8
        )
      }
      if let stagedNew {
        try stagedNew.write(
          to: directory.appendingPathComponent(record.newName),
          atomically: false,
          encoding: .utf8
        )
      }
      if let stagedOld {
        try stagedOld.write(
          to: directory.appendingPathComponent(record.oldName),
          atomically: false,
          encoding: .utf8
        )
      }
      try JSONEncoder().encode(record).write(
        to: directory.appendingPathComponent(record.journalName)
      )
      return record
    } catch {
      return nil
    }
  }

  for phase in ["prepared", "claimed", "published", "conflict"] {
    let directory = root.appendingPathComponent("save-recovery-\(phase)", isDirectory: true)
    try? fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
    let record: NativeSaveTransactionRecord?
    switch phase {
    case "prepared":
      record = installSaveRecoveryFixture(
        directory: directory,
        fileName: "document.txt",
        target: "old",
        stagedNew: "new",
        stagedOld: nil
      )
    case "claimed":
      record = installSaveRecoveryFixture(
        directory: directory,
        fileName: "document.txt",
        target: nil,
        stagedNew: "new",
        stagedOld: "old"
      )
    case "published":
      record = installSaveRecoveryFixture(
        directory: directory,
        fileName: "document.txt",
        target: "new",
        stagedNew: nil,
        stagedOld: "old"
      )
    default:
      record = installSaveRecoveryFixture(
        directory: directory,
        fileName: "document.txt",
        target: "external",
        stagedNew: "new",
        stagedOld: "old"
      )
    }
    guard let record else {
      check(false, "native save recovery fixture \(phase) is created")
      continue
    }
    do {
      let unresolved = try access.recoverPendingSaveTransactions(in: directory)
      let target = try? String(
        contentsOf: directory.appendingPathComponent(record.fileName),
        encoding: .utf8
      )
      if phase == "conflict" {
        check(
          unresolved == [record.fileName]
            && target == "external"
            && fileManager.fileExists(atPath: directory.appendingPathComponent(record.newName).path)
            && fileManager.fileExists(atPath: directory.appendingPathComponent(record.oldName).path)
            && fileManager.fileExists(atPath: directory.appendingPathComponent(record.journalName).path),
          "native save recovery preserves an external concurrent version and both recoverable versions"
        )
      } else {
        let expected = phase == "published" ? "new" : "old"
        check(
          unresolved.isEmpty
            && target == expected
            && !fileManager.fileExists(atPath: directory.appendingPathComponent(record.newName).path)
            && !fileManager.fileExists(atPath: directory.appendingPathComponent(record.oldName).path)
            && !fileManager.fileExists(atPath: directory.appendingPathComponent(record.journalName).path),
          "native save recovery resolves the \(phase) crash phase without exposing a partial version"
        )
      }
    } catch {
      check(false, "native save recovery resolves \(phase): \(error)")
    }
  }

  let interruptedJournalDirectory = root.appendingPathComponent(
    "save-recovery-interrupted-journal",
    isDirectory: true
  )
  try? fileManager.createDirectory(at: interruptedJournalDirectory, withIntermediateDirectories: true)
  let interruptedID = UUID().uuidString
  let interruptedJournal = interruptedJournalDirectory.appendingPathComponent(
    NativeSaveTransactionRecord.journalPrefix + interruptedID
  )
  let interruptedNew = interruptedJournalDirectory.appendingPathComponent(
    NativeSaveTransactionRecord.newPrefix + interruptedID
  )
  try? Data("{".utf8).write(to: interruptedJournal)
  try? "unpublished".write(to: interruptedNew, atomically: false, encoding: .utf8)
  do {
    let unresolved = try access.recoverPendingSaveTransactions(in: interruptedJournalDirectory)
    check(
      unresolved.isEmpty
        && !fileManager.fileExists(atPath: interruptedJournal.path)
        && !fileManager.fileExists(atPath: interruptedNew.path),
      "native save recovery cleans a crash-interrupted journal before any original version was claimed"
    )
  } catch {
    check(false, "native save recovery handles an interrupted journal write: \(error)")
  }

  let copyRecoveryDirectory = root.appendingPathComponent("copy-recovery", isDirectory: true)
  try? fileManager.createDirectory(at: copyRecoveryDirectory, withIntermediateDirectories: true)
  let copyTransaction = NativeCopyTransactionRecord(
    sourceName: "source",
    transactionID: UUID().uuidString
  )
  let copyStaging = copyRecoveryDirectory.appendingPathComponent(
    copyTransaction.stagingName,
    isDirectory: true
  )
  try? fileManager.createDirectory(at: copyStaging, withIntermediateDirectories: true)
  try? "partial".write(
    to: copyStaging.appendingPathComponent("partial.txt"),
    atomically: false,
    encoding: .utf8
  )
  try? JSONEncoder().encode(copyTransaction).write(
    to: copyRecoveryDirectory.appendingPathComponent(copyTransaction.journalName)
  )
  do {
    try access.recoverPendingCopyTransactions(in: copyRecoveryDirectory)
    let visible = try access.listDirectory(copyRecoveryDirectory, showHiddenNoise: true)
    check(
      !fileManager.fileExists(atPath: copyStaging.path)
        && !fileManager.fileExists(
          atPath: copyRecoveryDirectory.appendingPathComponent(copyTransaction.journalName).path
        )
        && visible.isEmpty,
      "native directory copy recovery removes a crashed hidden staging tree before it becomes visible"
    )
  } catch {
    check(false, "native directory copy recovery completes: \(error)")
  }
}
