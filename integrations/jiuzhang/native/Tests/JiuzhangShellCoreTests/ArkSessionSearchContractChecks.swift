import Foundation
import JiuzhangShellCore
import JiuzhangShellUI

func runArkSessionSearchContractChecks() {
  let workspace = ArkWorkspace(
    id: "workspace-a",
    path: "/Users/example/DeepSeek-Harness",
    title: "Native Ark",
    sessionIDs: ["recent", "older", "archived"]
  )
  let sessions = [
    ArkSessionSummary(
      id: "older", title: "Release Notes", updatedAt: Date(timeIntervalSince1970: 10),
      running: false, blank: false, cwd: workspace.path, agentPreset: nil,
      permissionPreset: nil, parentSessionID: nil, origin: nil
    ),
    ArkSessionSummary(
      id: "recent", title: "Search Repair", updatedAt: Date(timeIntervalSince1970: 20),
      running: false, blank: false, cwd: workspace.path, agentPreset: nil,
      permissionPreset: nil, parentSessionID: nil, origin: nil
    ),
    ArkSessionSummary(
      id: "archived", title: "Search Archive", updatedAt: Date(timeIntervalSince1970: 30),
      running: false, blank: false, cwd: workspace.path, agentPreset: nil,
      permissionPreset: nil, parentSessionID: nil, origin: nil
    ),
  ]

  let titleHits = ArkSessionSearchResolver.localHits(
    query: "SEARCH",
    sessions: sessions,
    workspaces: [workspace],
    archivedSessionIDs: ["archived"]
  )
  check(
    titleHits.map(\.sessionID) == ["recent"]
      && titleHits.first?.snippet.contains("Native Ark") == true,
    "native session search matches title metadata case-insensitively and excludes archives"
  )

  let workspaceHits = ArkSessionSearchResolver.localHits(
    query: "deepseek-harness",
    sessions: sessions,
    workspaces: [workspace],
    archivedSessionIDs: ["archived"]
  )
  check(
    workspaceHits.map(\.sessionID) == ["recent", "older"],
    "native session search matches workspace paths and preserves recent-first local order"
  )

  let merged = ArkSessionSearchResolver.merge(
    local: workspaceHits,
    remote: [
      ArkSessionSearchHit(sessionID: "older", snippet: "full-text match"),
      ArkSessionSearchHit(sessionID: "remote-only", snippet: "remote content"),
    ]
  )
  check(
    merged.map(\.sessionID) == ["recent", "older", "remote-only"]
      && merged[1].snippet == "full-text match",
    "native session search enriches local rows with full-text snippets and appends remote-only hits once"
  )

  let modelURL = contractNativeRoot.appendingPathComponent(
    "Sources/JiuzhangShellUI/ArkAppModel.swift"
  )
  guard let model = try? String(contentsOf: modelURL, encoding: .utf8) else {
    check(false, "native app model source is readable for session search contracts")
    return
  }
  check(
    model.contains("private var sessionSearchTask: Task<Void, Never>?")
      && model.contains("private var sessionSearchGeneration: UInt64 = 0")
      && model.contains("let local = ArkSessionSearchResolver.localHits(")
      && model.contains("sessionSearchHits = local")
      && model.contains("sessionSearchDidRun = true")
      && model.contains("guard !Task.isCancelled, sessionSearchGeneration == generation else { return }")
      && model.contains("ArkSessionSearchResolver.merge(local: local, remote: remote)")
      && model.contains("sessionSearchRemoteUnavailable = true")
      && model.contains("sessionSearchTask?.cancel()"),
    "native session search publishes local fallback immediately and rejects cancelled or stale remote results"
  )
}
