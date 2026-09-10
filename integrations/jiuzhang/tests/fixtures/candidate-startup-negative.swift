import Foundation
import Darwin

@main
enum CandidateStartupNegativeChecks {
  static func main() throws {
    let root = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
    let production = root.appendingPathComponent("production-like", isDirectory: true)
    let candidate = root.appendingPathComponent("home", isDirectory: true)
    let productionID = "cn.jiuzhangtianmu.industrybrain"
    let candidateID = productionID + ".candidate.regression"
    let valid: [String: Any] = [
      "CFBundleIdentifier": candidateID,
      "ArkCandidateBuild": true,
      "ArkCandidateDataHome": candidate.path,
    ]
    func resolve(_ info: [String: Any]) throws -> JiuzhangDataLocations {
      try JiuzhangShellContract.launchDataLocations(info: info, productionRoot: production)
    }
    func reject(_ info: [String: Any], _ label: String) throws {
      do {
        _ = try resolve(info)
      } catch JiuzhangCandidateDataError.invalidConfiguration {
        print("PASS: \(label)")
        return
      }
      print("FAIL: accepted \(label)")
      exit(1)
    }
    for identifier in [candidateID, productionID + ".candidate."] {
      for flag: Any? in [nil, false, "true"] {
        var invalid = valid
        invalid["CFBundleIdentifier"] = identifier
        invalid["ArkCandidateBuild"] = flag
        try reject(invalid, "candidate identifier \(identifier) with flag \(String(describing: flag))")
      }
    }
    let good = try resolve(valid)
    guard good.isCandidate && good.harnessHome.path == candidate.path else { exit(1) }
    let manager = FileManager.default
    try manager.createDirectory(at: production, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    for relative in ["Knowledge", "Knowledge/wiki", "Default Workspace", "Workbench Drafts", "Document References", "logs", "sessions", "storages", "profiles"] {
      let isolated = root.appendingPathComponent(UUID().uuidString, isDirectory: true)
      let child = isolated.appendingPathComponent(relative, isDirectory: true)
      try manager.createDirectory(at: child.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
      try manager.createSymbolicLink(at: child, withDestinationURL: production)
      var linked = valid
      linked["ArkCandidateDataHome"] = isolated.path
      try reject(linked, "managed child aliases production-like storage: \(relative)")
    }
    for flag: Any? in [nil, false] {
      var info: [String: Any] = ["CFBundleIdentifier": productionID]
      info["ArkCandidateBuild"] = flag
      let actual = try resolve(info)
      guard !actual.isCandidate && actual.harnessHome == production.appendingPathComponent("Harness", isDirectory: true) else { exit(1) }
    }
    print("CANDIDATE_MARKER_REGRESSION_PASS")
  }
}
