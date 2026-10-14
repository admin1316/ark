import Darwin
import Foundation
@testable import JiuzhangShellCore

@MainActor
func runArkProtectedRuntimeFDContractChecks() {
  let fm = FileManager.default
  let scratch = URL(fileURLWithPath: "/private/tmp/ark-runtime-fd-contract-\(UUID().uuidString)")
  defer { try? fm.removeItem(at: scratch) }
  func refused(_ title: String, _ body: () throws -> Void) {
    do { try body(); check(false, title) } catch { check(true, title) }
  }
  do {
    let root = scratch.appendingPathComponent("runtime"), provenance = root.appendingPathComponent(".ark-provenance")
    try fm.createDirectory(at: provenance, withIntermediateDirectories: true)
    func write(_ path: String, _ bytes: Data) throws -> String {
      let url = root.appendingPathComponent(path)
      try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
      try bytes.write(to: url)
      return ArkProtectedBytes.digest(bytes)
    }
    let plain = Data("protected fixture bytes".utf8)
    let emptyHash = try write("assets/empty.bin", Data())
    let plainHash = try write("assets/tree/member.bin", plain)
    let packageHash = try write("package.json", Data("{}".utf8))
    let lockHash = try write("pnpm-lock.yaml", Data("fixture-lock".utf8))
    let workspaceHash = try write("pnpm-workspace.yaml", Data("packages: []".utf8))
    let entry = root.appendingPathComponent("protected-helpers/scripts/rust-migration/knowledge-use-evaluator.mjs")
    let entryHash = try write("protected-helpers/scripts/rust-migration/knowledge-use-evaluator.mjs", Data("fixture-not-executed".utf8))
    let base = "node_modules/.pnpm/fixture/node_modules/fixture"
    let dependencyHash = try write(base + "/package.json", Data("{}".utf8))
    let alias = root.appendingPathComponent("node_modules/fixture")
    try fm.createSymbolicLink(atPath: alias.path, withDestinationPath: ".pnpm/fixture/node_modules/fixture")
    let closureHash = try write(".ark-provenance/closure-plan.json", Data("{}".utf8))
    let indexHash = try write(".ark-provenance/package-index.json", Data("{}".utf8))
    let commandHash = try write(".ark-provenance/install-command.json", Data("{}".utf8))
    let manifest: [String: Any] = ["version": 2, "target": "macos-arm64", "rootPackageJsonSha256": packageHash,
      "lockfileSha256": lockHash, "packageCount": 1, "symlinks": [], "requiredFiles": [
        ["path": "protected-helpers/scripts/rust-migration/knowledge-use-evaluator.mjs", "sha256": entryHash],
        ["path": "assets/empty.bin", "sha256": emptyHash], ["path": "assets/tree/member.bin", "sha256": plainHash]],
      "packages": [["locator": base, "contentFiles": [["path": "package.json", "sha256": dependencyHash]],
        "contentLinks": [], "aliases": ["node_modules/fixture"], "manifestSha256": dependencyHash]]]
    let manifestHash = try write(".ark-provenance/installed-runtime-manifest.json", JSONSerialization.data(withJSONObject: manifest, options: [.sortedKeys]))
    let receipt: [String: Any] = ["version": 3, "target": "macos-arm64", "install": ["offline": true, "frozenLockfile": true],
      "installedRuntimeManifestSha256": manifestHash, "runtimeWorkspaceSha256": workspaceHash,
      "runtimePackageJsonSha256": packageHash, "lockfileSha256": lockHash,
      "closurePlanSha256": closureHash, "packageIndexSha256": indexHash, "installCommandSha256": commandHash]
    let receiptHash = try write(".ark-provenance/pack-receipt.json", JSONSerialization.data(withJSONObject: receipt, options: [.sortedKeys]))
    let node = scratch.appendingPathComponent("not-executed-node-sentinel"), config = scratch.appendingPathComponent("config.json")
    try Data("sentinel".utf8).write(to: node); try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: node.path)
    try Data("{}".utf8).write(to: config)
    let pins = [node: ArkProtectedBytes.digest(try Data(contentsOf: node)), entry: entryHash,
      config: ArkProtectedBytes.digest(try Data(contentsOf: config)),
      provenance.appendingPathComponent("pack-receipt.json"): receiptHash,
      provenance.appendingPathComponent("installed-runtime-manifest.json"): manifestHash]
    func validate() throws { try ArkProtectedRuntimePins.validate(root: root, node: node, entry: entry, configuration: config, pins: pins, helper: "knowledge-use-evaluator.mjs") }
    try validate()
    check(true, "descriptor-relative full synthetic inventory accepts actual empty file and exact resolver alias; no executable proof")
    let member = root.appendingPathComponent("assets/tree/member.bin")
    try Data("tampered".utf8).write(to: member)
    refused("full runtime validator still hashes every inventoried member") { try validate() }
    try plain.write(to: member)
    let extra = root.appendingPathComponent("assets/unreviewed.bin")
    try Data().write(to: extra)
    refused("full runtime validator still rejects unreviewed members") { try validate() }
    try fm.removeItem(at: extra)
    let hardlink = scratch.appendingPathComponent("hardlink")
    try fm.linkItem(at: member, to: hardlink)
    refused("descriptor-relative file read rejects a second hardlink") { try validate() }
    try fm.removeItem(at: hardlink)
    let fd = Darwin.open(member.path, O_WRONLY | O_CLOEXEC)
    guard fd >= 0 else { throw ArkProtectedOwnerError.rejected("Sparse size fixture absent") }
    let resized = ftruncate(fd, off_t(128 * 1024 * 1024 + 1)); Darwin.close(fd)
    guard resized == 0 else { throw ArkProtectedOwnerError.rejected("Sparse size fixture failed") }
    refused("descriptor-relative file size is refused before allocating or hashing oversized bytes") { try validate() }
    try plain.write(to: member)
    let parent = member.deletingLastPathComponent()
    let directory = Darwin.open(parent.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    guard directory >= 0 else { throw ArkProtectedOwnerError.rejected("Fixture directory absent") }
    defer { Darwin.close(directory) }
    var observed = stat()
    guard fstatat(directory, "member.bin", &observed, AT_SYMLINK_NOFOLLOW) == 0 else { throw ArkProtectedOwnerError.rejected("Fixture observation absent") }
    let old = parent.appendingPathComponent("saved-member.bin")
    try fm.moveItem(at: member, to: old); try plain.write(to: member)
    refused("same-byte replacement between classification and open is refused by inode binding") {
      _ = try ArkProtectedRuntimePins.readMember(directory, name: "member.bin", expected: observed, hash: plainHash)
    }
    try fm.removeItem(at: member); try fm.moveItem(at: old, to: member)
    guard fstatat(directory, "member.bin", &observed, AT_SYMLINK_NOFOLLOW) == 0 else { throw ArkProtectedOwnerError.rejected("Restored fixture absent") }
    try fm.moveItem(at: member, to: old)
    try fm.createSymbolicLink(at: member, withDestinationURL: old)
    refused("symlink replacement between classification and open is refused even with identical target bytes") {
      _ = try ArkProtectedRuntimePins.readMember(directory, name: "member.bin", expected: observed, hash: plainHash)
    }
    try fm.removeItem(at: member)
    guard mkfifo(member.path, 0o600) == 0 else { throw ArkProtectedOwnerError.rejected("FIFO fixture creation failed") }
    refused("special-file replacement refuses without blocking on an unread FIFO") {
      _ = try ArkProtectedRuntimePins.readMember(directory, name: "member.bin", expected: observed, hash: plainHash)
    }
    refused("direct configuration pin read also refuses FIFO without blocking") { _ = try ArkProtectedRuntimePins.read(member, hash: plainHash) }
    try fm.removeItem(at: member); try fm.moveItem(at: old, to: member)
    try fm.removeItem(at: alias); try fm.createSymbolicLink(at: alias, withDestinationURL: parent)
    refused("exact resolver alias target remains bound after fd optimization") { try validate() }
    try fm.removeItem(at: alias); try fm.createSymbolicLink(atPath: alias.path, withDestinationPath: ".pnpm/fixture/node_modules/fixture")
    let detached = scratch.appendingPathComponent("detached-tree")
    try fm.moveItem(at: parent, to: detached); try fm.createSymbolicLink(at: parent, withDestinationURL: detached)
    refused("directory replacement with a linked identical tree cannot validate the old detached payload") { try validate() }
  } catch { check(false, "runtime fd source controls failed: \(error)") }
}
