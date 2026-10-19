import Darwin
import Foundation

/// Consumes the existing pack receipt and installed manifest, with their hashes
/// provisioned by the native caller. This detects persistent payload/resolver
/// changes; it does not establish immutable storage or same-UID key custody.
enum ArkProtectedRuntimePins {
  static func validate(root: URL, node: URL, entry: URL, configuration: URL,
    pins: [URL: String], helper: String) throws {
    let rootPath = root.path
    guard root.isFileURL, physical(root) == rootPath, rootPath != "/", rootPath.hasPrefix("/"),
      entry.path == rootPath + "/protected-helpers/scripts/rust-migration/" + helper,
      pins[node] != nil, pins[entry] != nil, pins[configuration] != nil,
      pins.count <= 1024, FileManager.default.isExecutableFile(atPath: node.path) else { throw rejected("Incomplete packaged helper pins") }
    try ordinaryAncestors(root, directory: true)
    for (url, hash) in pins { _ = try read(url, hash: hash) }
    let provenance = root.appendingPathComponent(".ark-provenance")
    let receiptURL = provenance.appendingPathComponent("pack-receipt.json")
    let manifestURL = provenance.appendingPathComponent("installed-runtime-manifest.json")
    guard let receiptHash = pins[receiptURL], let manifestHash = pins[manifestURL] else {
      throw rejected("Pack receipt and installed manifest must be pinned")
    }
    let receipt = try object(read(receiptURL, hash: receiptHash))
    let manifest = try object(read(manifestURL, hash: manifestHash))
    guard receipt["version"] as? Int == 3, manifest["version"] as? Int == 2,
      receipt["target"] as? String == "macos-arm64", manifest["target"] as? String == "macos-arm64",
      let install = receipt["install"] as? [String: Any], install["offline"] as? Bool == true,
      install["frozenLockfile"] as? Bool == true,
      receipt["installedRuntimeManifestSha256"] as? String == manifestHash else {
      throw rejected("Packaged runtime provenance differs")
    }
    #if !arch(arm64)
    throw rejected("Packaged helper requires macos-arm64")
    #endif
    var files: [String: String] = [:]
    var links: [String: String] = [:]
    func addFile(_ path: String, _ hash: Any?) throws {
      let normalized = try relative(path)
      guard let hash = hash as? String, ArkProtectedBytes.hashIsValid(hash),
        files[normalized] == nil, links[normalized] == nil else { throw rejected("Invalid manifest file inventory") }
      files[normalized] = hash
    }
    try addFile("package.json", manifest["rootPackageJsonSha256"])
    try addFile("pnpm-lock.yaml", manifest["lockfileSha256"])
    try addFile("pnpm-workspace.yaml", receipt["runtimeWorkspaceSha256"])
    guard files["package.json"] == receipt["runtimePackageJsonSha256"] as? String,
      files["pnpm-lock.yaml"] == receipt["lockfileSha256"] as? String,
      let required = manifest["requiredFiles"] as? [[String: Any]],
      let packages = manifest["packages"] as? [[String: Any]],
      manifest["packageCount"] as? Int == packages.count, packages.count > 0,
      packages.count <= 4096, let symlinks = manifest["symlinks"] as? [[String: Any]] else {
      throw rejected("Incomplete installed runtime inventory")
    }
    for item in required {
      guard let path = item["path"] as? String else { throw rejected("Invalid required asset") }
      try addFile(path, item["sha256"])
    }
    guard files[try relative(String(entry.path.dropFirst(rootPath.count + 1)))] == pins[entry] else {
      throw rejected("Protected helper is not a packaged required asset")
    }
    for (filename, key) in [("closure-plan.json", "closurePlanSha256"),
      ("package-index.json", "packageIndexSha256"), ("install-command.json", "installCommandSha256")] {
      try addFile(".ark-provenance/" + filename, receipt[key])
    }
    try addFile(".ark-provenance/installed-runtime-manifest.json", manifestHash)
    try addFile(".ark-provenance/pack-receipt.json", receiptHash)
    for package in packages {
      guard let locator = package["locator"] as? String, locator.hasPrefix("node_modules/"),
        let contents = package["contentFiles"] as? [[String: Any]],
        let contentLinks = package["contentLinks"] as? [[String: Any]],
        let aliases = package["aliases"] as? [String] else { throw rejected("Invalid package payload") }
      let base = try relative(locator)
      for file in contents {
        guard let path = file["path"] as? String else { throw rejected("Invalid package member") }
        try addFile(base + "/" + relative(path), file["sha256"])
      }
      guard files[base + "/package.json"] == package["manifestSha256"] as? String else {
        throw rejected("Package manifest identity differs")
      }
      for link in contentLinks {
        guard let path = link["path"] as? String, let target = link["target"] as? String else {
          throw rejected("Invalid package link")
        }
        links[try relative(base + "/" + relative(path))] = try relative(base + "/" + relative(target))
      }
      for alias in aliases {
        let path = try relative(alias)
        guard path.hasPrefix("node_modules/") else { throw rejected("Package alias outside resolver root") }
        if path != base { links[path] = base }
      }
    }
    for link in symlinks {
      guard let path = link["path"] as? String, let target = link["target"] as? String else {
        throw rejected("Invalid resolver link")
      }
      let pathValue = try relative(path), targetValue = try relative(target)
      guard pathValue.hasPrefix("node_modules/"), files[pathValue] == nil,
        links[pathValue] == nil || links[pathValue] == targetValue else { throw rejected("Conflicting resolver link") }
      links[pathValue] = targetValue
    }
    guard files.count <= 200000, links.count <= 20000 else { throw rejected("Runtime inventory exceeds bounds") }
    // pnpm bookkeeping is not loaded by Node. Every executable, package scope,
    // native asset and alias remains part of the exact manifest inventory.
    let metadata: Set<String> = ["node_modules/.modules.yaml", "node_modules/.pnpm/lock.yaml",
      "node_modules/.pnpm-workspace-state-v1.json"]
    var directories: Set<String> = ["node_modules", "node_modules/.pnpm"]
    for path in Set(files.keys).union(links.keys).union(metadata) {
      var components = path.split(separator: "/").map(String.init)
      components.removeLast()
      while !components.isEmpty {
        directories.insert(components.joined(separator: "/")); components.removeLast()
      }
    }
    var seenFiles = Set<String>(), seenLinks = Set<String>()
    func visit(_ directory: URL, _ prefix: String, descriptor: Int32, parent: Int32?, name: String?) throws {
      try ordinaryAncestors(directory, directory: true)
      var before = stat(), named = stat()
      guard fstat(descriptor, &before) == 0, before.st_mode & S_IFMT == S_IFDIR,
        lstat(directory.path, &named) == 0, sameMember(before, named) else { throw rejected("Runtime directory identity changed") }
      if let parent, let name {
        guard fstatat(parent, name, &named, AT_SYMLINK_NOFOLLOW) == 0, sameMember(before, named) else {
          throw rejected("Runtime directory parent binding changed")
        }
      }
      for name in try FileManager.default.contentsOfDirectory(atPath: directory.path) {
        let path = prefix.isEmpty ? name : prefix + "/" + name
        let url = directory.appendingPathComponent(name)
        var info = stat()
        guard fstatat(descriptor, name, &info, AT_SYMLINK_NOFOLLOW) == 0 else { throw rejected("Runtime member disappeared") }
        switch info.st_mode & S_IFMT {
        case S_IFDIR:
          guard directories.contains(path) else { throw rejected("Unreviewed runtime directory: " + path) }
          let child = Darwin.openat(descriptor, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
          guard child >= 0 else { throw rejected("Runtime directory absent or linked") }
          do {
            defer { Darwin.close(child) }
            try visit(url, path, descriptor: child, parent: descriptor, name: name)
          }
        case S_IFREG:
          if let hash = files[path] { _ = try readMember(descriptor, name: name, expected: info, hash: hash); seenFiles.insert(path) }
          else if metadata.contains(path) {
            guard info.st_nlink == 1, info.st_size >= 0, info.st_size <= 16 * 1024 * 1024 else { throw rejected("Invalid pnpm metadata") }
          } else { throw rejected("Unreviewed runtime file: " + path) }
        case S_IFLNK:
          guard let expected = links[path], physical(url) == rootPath + "/" + expected else {
            throw rejected("Runtime resolver link changed: " + path)
          }
          seenLinks.insert(path)
        default: throw rejected("Special runtime member")
        }
        var after = stat()
        guard fstatat(descriptor, name, &after, AT_SYMLINK_NOFOLLOW) == 0, sameMember(info, after) else {
          throw rejected("Runtime member changed during validation")
        }
      }
      var after = stat()
      guard fstat(descriptor, &after) == 0, sameMember(before, after),
        lstat(directory.path, &named) == 0, sameMember(before, named) else { throw rejected("Runtime directory changed during validation") }
      if let parent, let name {
        guard fstatat(parent, name, &named, AT_SYMLINK_NOFOLLOW) == 0, sameMember(before, named) else {
          throw rejected("Runtime directory parent binding changed")
        }
      }
      try ordinaryAncestors(directory, directory: true)
    }
    let directory = Darwin.open(root.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    guard directory >= 0 else { throw rejected("Runtime root absent or linked") }
    defer { Darwin.close(directory) }
    try visit(root, "", descriptor: directory, parent: nil, name: nil)
    guard physical(root) == rootPath else { throw rejected("Runtime root path changed") }
    guard seenFiles == Set(files.keys), seenLinks == Set(links.keys) else {
      throw rejected("Packaged runtime inventory differs")
    }
  }

  private static func rejected(_ reason: String) -> ArkProtectedOwnerError { .rejected(reason) }
  private static func relative(_ path: String) throws -> String {
    let parts = path.split(separator: "/", omittingEmptySubsequences: false)
    guard !path.isEmpty, !path.contains("\\"), !path.contains("\0"),
      !parts.contains(where: { $0.isEmpty || $0 == "." || $0 == ".." }) else {
      throw rejected("Invalid runtime relative path")
    }
    return path
  }
  private static func physical(_ url: URL) -> String? {
    guard let pointer = realpath(url.path, nil) else { return nil }
    defer { free(pointer) }
    return String(cString: pointer)
  }
  private static func ordinaryAncestors(_ url: URL, directory: Bool = false) throws {
    guard url.isFileURL, url.path.hasPrefix("/"), !url.path.dropFirst().split(separator: "/", omittingEmptySubsequences: false).contains(where: { $0.isEmpty || $0 == "." || $0 == ".." }) else {
      throw rejected("Invalid protected absolute path")
    }
    var cursor = directory ? url : url.deletingLastPathComponent()
    while cursor.path != "/" {
      var info = stat()
      guard lstat(cursor.path, &info) == 0, info.st_mode & S_IFMT == S_IFDIR else {
        throw rejected("Protected path has linked or absent ancestor")
      }
      cursor.deleteLastPathComponent()
    }
  }
  static func read(_ url: URL, hash: String) throws -> Data {
    guard ArkProtectedBytes.hashIsValid(hash) else { throw rejected("Invalid protected digest") }
    try ordinaryAncestors(url)
    let descriptor = Darwin.open(url.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
    guard descriptor >= 0 else { throw rejected("Protected file absent or linked") }
    defer { Darwin.close(descriptor) }
    return try readDescriptor(descriptor, hash: hash)
  }
  static func readMember(_ directory: Int32, name: String, expected: stat, hash: String) throws -> Data {
    let descriptor = Darwin.openat(directory, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
    guard descriptor >= 0 else { throw rejected("Protected file absent or linked") }
    defer { Darwin.close(descriptor) }
    var before = stat()
    guard fstat(descriptor, &before) == 0, sameMember(expected, before) else { throw rejected("Protected file was replaced") }
    let bytes = try readDescriptor(descriptor, hash: hash)
    var after = stat(), named = stat()
    guard fstat(descriptor, &after) == 0, sameMember(before, after),
      fstatat(directory, name, &named, AT_SYMLINK_NOFOLLOW) == 0, sameMember(before, named) else {
      throw rejected("Protected file changed during read")
    }
    return bytes
  }
  private static func sameMember(_ first: stat, _ second: stat) -> Bool {
    first.st_dev == second.st_dev && first.st_ino == second.st_ino && first.st_mode == second.st_mode &&
      first.st_nlink == second.st_nlink && first.st_size == second.st_size &&
      first.st_mtimespec.tv_sec == second.st_mtimespec.tv_sec && first.st_mtimespec.tv_nsec == second.st_mtimespec.tv_nsec &&
      first.st_ctimespec.tv_sec == second.st_ctimespec.tv_sec && first.st_ctimespec.tv_nsec == second.st_ctimespec.tv_nsec
  }
  private static func readDescriptor(_ descriptor: Int32, hash: String) throws -> Data {
    guard ArkProtectedBytes.hashIsValid(hash) else { throw rejected("Invalid protected digest") }
    var info = stat()
    guard fstat(descriptor, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_nlink == 1,
      info.st_size >= 0, info.st_size <= 128 * 1024 * 1024 else { throw rejected("Invalid protected file") }
    let bytes = try FileHandle(fileDescriptor: descriptor, closeOnDealloc: false).readToEnd() ?? Data()
    guard bytes.count == info.st_size, ArkProtectedBytes.digest(bytes) == hash else {
      throw rejected("Protected runtime file changed")
    }
    return bytes
  }
  private static func object(_ bytes: Data) throws -> [String: Any] {
    guard bytes.count <= 32 * 1024 * 1024,
      let value = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else {
      throw rejected("Invalid protected runtime manifest")
    }
    return value
  }
}
