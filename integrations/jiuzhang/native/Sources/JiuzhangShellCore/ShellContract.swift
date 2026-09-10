import Foundation
import Darwin

/// One data-location owner for production defaults and explicitly marked test bundles.
public struct JiuzhangDataLocations: Equatable, Sendable {
  public let root: URL
  public let candidateBundleIdentifier: String?
  public var isCandidate: Bool { candidateBundleIdentifier != nil }
  public var harnessHome: URL { isCandidate ? root : root.appendingPathComponent("Harness", isDirectory: true) }
  public var knowledgeRoot: URL { root.appendingPathComponent("Knowledge", isDirectory: true) }
  public var wikiRoot: URL { knowledgeRoot.appendingPathComponent("wiki", isDirectory: true) }
  public var sessionWorkspace: URL { root.appendingPathComponent("Default Workspace", isDirectory: true) }
  public var workbenchDrafts: URL { root.appendingPathComponent("Workbench Drafts", isDirectory: true) }
  public var documentReferences: URL { root.appendingPathComponent("Document References", isDirectory: true) }
  public var logs: URL { root.appendingPathComponent("logs", isDirectory: true) }
}

public enum JiuzhangCandidateDataError: LocalizedError {
  case invalidConfiguration
  public var errorDescription: String? { "Invalid or non-isolated Ark candidate data configuration." }
}

/// Fixed startup rules for the native Jiuzhang desktop application.
public enum JiuzhangShellContract {
  public static let loopbackHost = "127.0.0.1"

  /// Resolve signed bundle metadata, never ambient candidate environment variables.
  public static func launchDataLocations(
    info: [String: Any] = Bundle.main.infoDictionary ?? [:],
    productionRoot: URL = defaultHarnessHome().deletingLastPathComponent(),
    bundleURL: URL = Bundle.main.bundleURL,
    fileManager: FileManager = .default
  ) throws -> JiuzhangDataLocations {
    if let flag = info["ArkCandidateBuild"], !(flag is Bool) {
      throw JiuzhangCandidateDataError.invalidConfiguration
    }
    guard info["ArkCandidateBuild"] as? Bool == true else {
      if let identifier = info["CFBundleIdentifier"] as? String,
         identifier.hasPrefix("cn.jiuzhangtianmu.industrybrain.candidate.") {
        throw JiuzhangCandidateDataError.invalidConfiguration
      }
      return JiuzhangDataLocations(root: productionRoot, candidateBundleIdentifier: nil)
    }
    guard let raw = info["ArkCandidateDataHome"] as? String,
          raw.hasPrefix("/"), raw == raw.trimmingCharacters(in: .whitespacesAndNewlines),
          raw.rangeOfCharacter(from: .controlCharacters) == nil,
          let identifier = info["CFBundleIdentifier"] as? String,
          identifier.range(of: "^cn\\.jiuzhangtianmu\\.industrybrain\\.candidate\\.[a-z0-9]+$", options: .regularExpression) != nil
    else { throw JiuzhangCandidateDataError.invalidConfiguration }
    let input = URL(fileURLWithPath: raw, isDirectory: true)
    guard let resolved = realpath(raw, nil) else { throw JiuzhangCandidateDataError.invalidConfiguration }
    defer { free(resolved) }
    // Match the POSIX spelling used by Node and the frozen build metadata.
    let root = URL(fileURLWithPath: String(cString: resolved), isDirectory: true)
    guard root.path != "/" else { throw JiuzhangCandidateDataError.invalidConfiguration }
    func physicalURL(_ value: URL) -> URL {
      guard let pointer = realpath(value.path, nil) else { return value.standardizedFileURL }
      defer { free(pointer) }
      return URL(fileURLWithPath: String(cString: pointer), isDirectory: true)
    }
    var protected = [physicalURL(productionRoot)]
    if bundleURL.pathExtension.lowercased() == "app" {
      protected.append(physicalURL(bundleURL))
    }
    if let recorded = info["JiuzhangRuntimeRoot"] as? String {
      let runtime = recorded.hasPrefix("/") ? URL(fileURLWithPath: recorded) : bundleURL.appendingPathComponent(recorded)
      protected.append(physicalURL(runtime))
    }
    guard !protected.contains(where: { item in
      root.path == item.path || root.path.hasPrefix(item.path + "/") || item.path.hasPrefix(root.path + "/")
    }) else { throw JiuzhangCandidateDataError.invalidConfiguration }
    if let attributes = try? fileManager.attributesOfItem(atPath: input.path) {
      guard attributes[.type] as? FileAttributeType == .typeDirectory,
            let owner = attributes[.ownerAccountID] as? NSNumber, owner.uint32Value == getuid(),
            let mode = attributes[.posixPermissions] as? NSNumber, mode.intValue & 0o077 == 0
      else { throw JiuzhangCandidateDataError.invalidConfiguration }
    }
    // An isolated root alone is insufficient when a managed child is a link.
    // Check parents first so a missing leaf cannot hide an aliased ancestor.
    for relative in ["Knowledge", "Knowledge/wiki", "Default Workspace", "Workbench Drafts", "Document References", "logs", "sessions", "storages", "profiles"] {
      let directory = root.appendingPathComponent(relative, isDirectory: true)
      var metadata = stat()
      if lstat(directory.path, &metadata) != 0 {
        guard errno == ENOENT else { throw JiuzhangCandidateDataError.invalidConfiguration }
        continue
      }
      guard metadata.st_mode & S_IFMT == S_IFDIR,
            metadata.st_uid == getuid(), metadata.st_mode & 0o077 == 0
      else { throw JiuzhangCandidateDataError.invalidConfiguration }
    }
    return JiuzhangDataLocations(root: root, candidateBundleIdentifier: identifier)
  }

  /// Return the isolated Harness home used by the desktop product.
  public static func defaultHarnessHome(fileManager: FileManager = .default) -> URL {
    fileManager.homeDirectoryForCurrentUser
      .appendingPathComponent("Library", isDirectory: true)
      .appendingPathComponent("Application Support", isDirectory: true)
      .appendingPathComponent("Ark", isDirectory: true)
      .appendingPathComponent("Harness", isDirectory: true)
  }

  /// Return Ark's product-owned knowledge project.  It deliberately lives
  /// outside the source checkout so the desktop app never treats its own
  /// repository as user knowledge or as a Workspace.
  public static func defaultKnowledgeRoot(fileManager: FileManager = .default) -> URL {
    fileManager.homeDirectoryForCurrentUser
      .appendingPathComponent("Library", isDirectory: true)
      .appendingPathComponent("Application Support", isDirectory: true)
      .appendingPathComponent("Ark", isDirectory: true)
      .appendingPathComponent("Knowledge", isDirectory: true)
  }

  public static func defaultWikiRoot(fileManager: FileManager = .default) -> URL {
    defaultKnowledgeRoot(fileManager: fileManager)
      .appendingPathComponent("wiki", isDirectory: true)
  }

  /// Safe cwd for chats created before the user connects a Workspace.  It is
  /// deliberately separate from the source checkout, the installed app bundle,
  /// runtime payloads, Harness state, and the canonical knowledge project.
  public static func defaultSessionWorkspace(fileManager: FileManager = .default) -> URL {
    fileManager.homeDirectoryForCurrentUser
      .appendingPathComponent("Library", isDirectory: true)
      .appendingPathComponent("Application Support", isDirectory: true)
      .appendingPathComponent("Ark", isDirectory: true)
      .appendingPathComponent("Default Workspace", isDirectory: true)
  }

  /// Reject the installed Ark product itself or product-owned data. The source
  /// checkout remains eligible as an explicit maintenance Workspace.
  public static func protectedWorkspaceReason(
    path: String,
    bundle: Bundle = .main,
    fileManager: FileManager = .default
  ) -> String? {
    let candidate = URL(fileURLWithPath: path, isDirectory: true)
      .standardizedFileURL.resolvingSymlinksInPath().path
    let productData = fileManager.homeDirectoryForCurrentUser
      .appendingPathComponent("Library/Application Support/Ark", isDirectory: true)
      .standardizedFileURL.resolvingSymlinksInPath().path
    let installedBundle = bundle.bundleURL.standardizedFileURL.resolvingSymlinksInPath().path
    let canonicalInstalledBundle = "/Applications/Ark.app"
    var protected: [(String, String)] = [
      (canonicalInstalledBundle, "Ark 应用与内嵌 runtime"),
      (productData, "Ark 产品数据目录"),
    ]
    if bundle.bundleURL.pathExtension.lowercased() == "app",
       installedBundle != canonicalInstalledBundle {
      protected.append((installedBundle, "Ark 应用与内嵌 runtime"))
    }
    for (root, label) in protected {
      if candidate == root
        || candidate.hasPrefix(root + "/")
        || root.hasPrefix(candidate + "/")
      {
        return "不能把\(label)加入工作区"
      }
    }
    return nil
  }

  /// Return the launcher arguments that request an OS-assigned loopback port.
  /// The native client learns the actual origin from the authenticated readiness line,
  /// so Ark has no browser-origin reason to contend for a fixed desktop port.
  /// `--parent-pid` hands the launcher the UI's own pid so it exits its backend
  /// child when the UI disappears (crash or termination), instead of orphaning.
  public static func launchArguments(launcherPath: String) -> [String] {
    [
      launcherPath,
      "--parent-pid", String(ProcessInfo.processInfo.processIdentifier),
      "--port", "0",
    ]
  }

  /// Resolve a recorded path to an absolute path: absolute values pass through,
  /// and "Contents/..." values resolve against the application bundle (the
  /// self-contained layout embedded by build-app.sh).
  public static func resolveBundlePath(_ recorded: String, bundle: Bundle = .main) -> String {
    if recorded.hasPrefix("/") { return recorded }
    return bundle.bundleURL.appendingPathComponent(recorded).path
  }

  /// Return whether the recorded Node, launcher, runner, and runtime paths form a usable source or standalone installation.
  /// - Parameters:
  ///   - nodeExecutable: Absolute Node.js executable selected at build time.
  ///   - launcherPath: Absolute Jiuzhang launcher path recorded in the application bundle.
  ///   - runnerPath: Absolute Native API runner path recorded for startup validation.
  ///   - runtimeRoot: Absolute ordinary directory used as the child working directory.
  ///   - fileManager: File manager used to inspect the recorded paths.
  /// - Returns: `true` when every path exists with the required access and matches one supported runtime layout.
  public static func runtimePathsAreUsable(
    nodeExecutable: String,
    launcherPath: String,
    runnerPath: String,
    runtimeRoot: String,
    fileManager: FileManager = .default
  ) -> Bool {
    guard
      nodeExecutable.hasPrefix("/"),
      launcherPath.hasPrefix("/"),
      runnerPath.hasPrefix("/"),
      runtimeRoot.hasPrefix("/"),
      fileManager.isExecutableFile(atPath: nodeExecutable),
      fileManager.isReadableFile(atPath: launcherPath),
      fileManager.isReadableFile(atPath: runnerPath),
      ordinaryDirectoryExists(atPath: runtimeRoot, fileManager: fileManager)
    else {
      return false
    }

    let root = URL(fileURLWithPath: runtimeRoot, isDirectory: true).standardizedFileURL
    let launcher = URL(fileURLWithPath: launcherPath).standardizedFileURL
    let runner = URL(fileURLWithPath: runnerPath).standardizedFileURL
    let standaloneLayout = (
      launcher == root.appendingPathComponent("start.mjs")
        && runner == root.appendingPathComponent(
          "node_modules/@deepseek-ai/dsh-native-api-runner/lib/bin.js"
        )
    )
    let sourceLayout = (
      launcher == root.appendingPathComponent("integrations/jiuzhang/src/start.mjs")
        && runner == root.appendingPathComponent("packages/boot/native-api-runner/lib/bin.js")
    )
    return standaloneLayout || sourceLayout
  }

  /// Build the child environment without sharing the default `~/.dsh` state.
  /// - Parameters:
  ///   - base: Parent process environment; only the fixed non-secret allowlist is retained.
  ///   - harnessHome: Product-owned data directory.
  ///   - apiToken: Non-empty launch token shared only with the native API client.
  ///   - dataLocations: Validated launch configuration that owns every child data path.
  /// - Returns: The isolated child environment.
  public static func childEnvironment(
    base: [String: String],
    harnessHome: URL,
    apiToken: String,
    dataLocations: JiuzhangDataLocations
  ) -> [String: String] {
    precondition(!apiToken.isEmpty, "Ark API token must not be empty")
    precondition(dataLocations.harnessHome == harnessHome, "Data locations must have one Harness owner")
    let retainedNames = [
      "HOME", "PATH", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "SHELL", "USER", "LOGNAME",
    ]
    var environment = base.filter { retainedNames.contains($0.key) }
    environment["JIUZHANG_DSH_HOME"] = harnessHome.path
    environment["DSH_HOME"] = harnessHome.path
    environment["DSH_PERMISSION_MODE"] = "read-only"
    environment["DSH_TELEMETRY_DISABLED"] = "1"
    environment["DSH_API_TOKEN"] = apiToken
    let knowledgeRoot = dataLocations.knowledgeRoot
    environment["ARK_MAIN_ROOT"] = knowledgeRoot.path
    environment["ARK_WIKI_ROOT"] = dataLocations.wikiRoot.path
    environment["ARK_DEFAULT_WORKSPACE"] = dataLocations.sessionWorkspace.path
    return environment
  }

  /// Parse the internal service readiness line emitted after the API listener binds.
  public static func readinessURL(from line: String) -> URL? {
    let prefix = "dsh native-api: "
    let normalized = line.trimmingCharacters(in: .whitespacesAndNewlines)
    guard normalized.hasPrefix(prefix) else { return nil }

    let rawURL = String(normalized.dropFirst(prefix.count))
    guard
      let components = URLComponents(string: rawURL),
      components.scheme == "http",
      components.host == loopbackHost,
      components.user == nil,
      components.password == nil,
      components.path.isEmpty,
      components.query == nil,
      components.fragment == nil,
      let port = components.port,
      (1...65_535).contains(port),
      let url = components.url
    else {
      return nil
    }
    return url
  }

  private static func ordinaryDirectoryExists(
    atPath path: String,
    fileManager: FileManager
  ) -> Bool {
    guard let attributes = try? fileManager.attributesOfItem(atPath: path) else { return false }
    return attributes[.type] as? FileAttributeType == .typeDirectory
  }
}
