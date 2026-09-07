import Foundation

func runArkWikiProjectLifecycleContractChecks() {
  let modelURL = contractNativeRoot.appendingPathComponent("Sources/JiuzhangShellUI/ArkAppModel.swift")
  let rootURL = contractNativeRoot.appendingPathComponent("Sources/JiuzhangShellUI/ArkRootView.swift")
  let l10nURL = contractNativeRoot.appendingPathComponent("Sources/JiuzhangShellUI/ArkL10n.swift")
  let repositoryRoot = contractNativeRoot
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .deletingLastPathComponent()
  let hostURL = repositoryRoot.appendingPathComponent("packages/host/knowledge-wiki/src/index.ts")

  guard
    let model = try? String(contentsOf: modelURL, encoding: .utf8),
    let root = try? String(contentsOf: rootURL, encoding: .utf8),
    let l10n = try? String(contentsOf: l10nURL, encoding: .utf8),
    let host = try? String(contentsOf: hostURL, encoding: .utf8)
  else {
    check(false, "Wiki project lifecycle sources are readable")
    return
  }

  let hostRemoval = wikiLifecycleSlice(
    host,
    from: "@Remote('removeProject')",
    through: "Graph insights:"
  )
  check(
    host.contains("invalid knowledge project registry")
      && host.contains("flag: 'wx'")
      && host.contains("renameSync(temporary, file)")
      && host.contains("known.includes(target) || existsSync(join(target, 'wiki'))") == false,
    "Host project registry fails closed, writes atomically, and rejects stale unregistered selection"
  )
  check(
    hostRemoval?.contains("writeWorkspaces(remaining)") == true
      && hostRemoval?.contains("cancelPendingForRoot(target)") == true
      && hostRemoval?.contains("this.currentRoot = this.mainRoot") == true
      && hostRemoval?.contains("this.projectGeneration += 1") == true
      && hostRemoval?.contains("current: this.currentRoot") == true,
    "Host removal unregisters once, cancels pending work, and returns to the main project"
  )

  let workspaceRemoval = wikiLifecycleSlice(
    model,
    from: "public func removeWorkspace(_ workspaceID: String)",
    through: "private func registerKnowledgeProject"
  )
  let projectRemoval = wikiLifecycleSlice(
    model,
    from: "public func removeKnowledgeProject(path: String)",
    through: "public func importKnowledgeSources"
  )
  check(
    model.contains("private func unregisterKnowledgeProject(path: String) async throws")
      && workspaceRemoval?.contains("try await unregisterKnowledgeProject(path: workspace.path)") == true
      && workspaceRemoval?.contains("method: \"knowledgeWiki/removeProject\"") == false,
    "workspace and independent project removal share one Native unregister helper"
  )
  check(
    projectRemoval?.contains("!project.isMain") == true
      && projectRemoval?.contains("!workspaces.contains") == true
      && projectRemoval?.contains("stopKnowledgeIngestPolling(resetQueue: true)") == true
      && projectRemoval?.contains("selectedKnowledgeProjectPath = nil") == true
      && projectRemoval?.contains("await loadWiki()") == true,
    "Native removal protects main and workspace-owned projects then reloads authoritative state"
  )

  let wikiView = wikiLifecycleSlice(
    root,
    from: "private struct NativeWikiView",
    through: "private struct NativeResearchBar"
  )
  check(
    wikiView?.contains("ark.wiki.project.remove") == true
      && wikiView?.contains("Image(systemName: \"trash\")") == true
      && wikiView?.contains("private var removableKnowledgeProject") == true
      && wikiView?.contains("!project.isMain") == true
      && wikiView?.contains("model.removeKnowledgeProject(path: project.path)") == true
      && wikiView?.contains("wikiRemoveProjectDetail") == true,
    "Native Wiki shows a confirmed remove button only for removable imported projects"
  )
  check(
    l10n.contains("移除知识项目注册？")
      && l10n.contains("Remove Knowledge Project Registration?")
      && l10n.contains("本地文件未删除")
      && l10n.contains("local files untouched"),
    "Wiki project removal copy is localized and states the file-preservation boundary"
  )
}

private func wikiLifecycleSlice(
  _ source: String,
  from start: String,
  through end: String
) -> String? {
  guard
    let startRange = source.range(of: start),
    let endRange = source.range(
      of: end,
      range: startRange.lowerBound..<source.endIndex
    )
  else { return nil }
  return String(source[startRange.lowerBound..<endRange.upperBound])
}
