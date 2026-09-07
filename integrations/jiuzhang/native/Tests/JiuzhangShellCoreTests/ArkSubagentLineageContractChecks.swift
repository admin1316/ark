import Foundation
import JiuzhangShellCore
import JiuzhangShellUI

@MainActor
func runArkSubagentLineageContractChecks() {
  let child = ArkSubagentEntry(
    id: "child", kind: "child", mode: "continuable", activity: "running",
    hasChildren: true, label: "实现", reason: nil
  )
  let oneShot = ArkSubagentEntry(
    id: "one-shot", kind: "child", mode: "one-shot", activity: "inactive",
    hasChildren: false, label: "调查", reason: nil
  )
  let diagnostic = ArkSubagentEntry(
    id: "broken", kind: "diagnostic", mode: nil, activity: nil,
    hasChildren: false, label: "失败分支", reason: "missing transport"
  )
  let grandchild = ArkSubagentEntry(
    id: "grandchild", kind: "child", mode: "continuable", activity: "inactive",
    hasChildren: false, label: "补测试", reason: nil
  )
  let rootReady = ArkSubagentCatalogViewState.ready(ArkSubagentCatalog(
    entries: [child, oneShot, diagnostic],
    parentAvailable: true
  ))
  let childReady = ArkSubagentCatalogViewState.ready(ArkSubagentCatalog(
    entries: [grandchild],
    parentAvailable: true
  ))

  let loading = ArkSubagentCatalogViewState.loading(previous: rootReady)
  check(
    loading.phase == .loading && loading.entries == rootReady.entries,
    "native subagent loading preserves the last authoritative catalog"
  )
  let failed = ArkSubagentCatalogViewState.failed(previous: rootReady, message: "offline")
  check(
    failed.phase == .failed && failed.entries == rootReady.entries && failed.error == "offline",
    "native subagent failure preserves stale rows and exposes a retry reason"
  )

  let failedTerminalRows = ArkSubagentLineageProjection.rows(
    rootSessionID: "root",
    catalogs: ["root": failed],
    sessions: [
      session("root", title: "主任务", parent: nil, origin: nil, running: false),
      session("child", title: "实现", parent: "root", origin: "subagent", running: false),
    ],
    cachedEntries: ["child": child],
    expanded: []
  )
  check(
    failedTerminalRows.first(where: { $0.entry?.id == "child" })?.entry?.activity == "inactive",
    "native failed catalog retention cannot resurrect a terminal child as running"
  )

  let sessions = [
    session("root", title: "主任务", parent: nil, origin: nil, running: true),
    session("child", title: "实现", parent: "root", origin: "subagent", running: true),
    session("one-shot", title: "调查", parent: "root", origin: "subagent", running: false),
    session("grandchild", title: "补测试", parent: "child", origin: "subagent", running: false),
  ]
  let catalogs = ["root": rootReady, "child": childReady]
  let rows = ArkSubagentLineageProjection.rows(
    rootSessionID: "root",
    catalogs: catalogs,
    sessions: sessions,
    cachedEntries: ["child": child, "one-shot": oneShot, "grandchild": grandchild],
    expanded: ["child"]
  )
  check(
    rows.contains(where: { $0.entry?.id == "child" && $0.depth == 1 })
      && rows.contains(where: { $0.entry?.id == "grandchild" && $0.depth == 2 })
      && rows.contains(where: { $0.entry?.id == "one-shot" && $0.depth == 1 })
      && rows.contains(where: { $0.kind == .diagnostic && $0.entry?.id == "broken" }),
    "native subagent projection renders parent child grandchild and diagnostic rows"
  )
  check(
    ArkSubagentLineageProjection.knownDescendantIDs(
      rootSessionID: "root",
      catalogs: catalogs,
      sessions: sessions,
      cachedEntries: [:]
    ) == Set(["child", "one-shot", "grandchild"]),
    "native subagent descendant count includes every known lineage level once"
  )

  let staleRunningOneShot = ArkSubagentEntry(
    id: "one-shot", kind: "child", mode: "one-shot", activity: "running",
    hasChildren: false, label: "调查", reason: nil
  )
  let fallback = ArkSubagentLineageProjection.rows(
    rootSessionID: "root",
    catalogs: ["root": .loading(previous: nil)],
    sessions: sessions,
    cachedEntries: ["child": child, "one-shot": staleRunningOneShot],
    expanded: []
  )
  check(
    fallback.filter { $0.kind == .child }.count == 2
      && fallback.filter { $0.kind == .child }.allSatisfy(\.placeholder)
      && fallback.first(where: { $0.entry?.id == "one-shot" })?.entry?.activity == "inactive",
    "native subagent bootstrap keeps summary-backed rows non-navigable and rejects stale running cache"
  )

  let hinted = ArkSubagentLineageProjection.applyingRuntimeHints(
    [ArkSubagentEntry(
      id: "child", kind: "child", mode: "continuable", activity: "inactive",
      hasChildren: false, label: nil, reason: nil
    )],
    activity: ["child": true],
    knownParents: ["child"]
  )
  check(
    hinted.first?.activity == "running" && hinted.first?.hasChildren == true,
    "native subagent live hints survive an older in-flight catalog response"
  )

  let defaultsName = "ark.contract.subagent-terminal.\(UUID().uuidString)"
  let defaults = UserDefaults(suiteName: defaultsName)!
  defer { defaults.removePersistentDomain(forName: defaultsName) }
  func invocation(_ content: String, revision: UInt64) -> String {
    ArkSubagentPromptInvocationIdentity.make(
      parentSessionID: "root",
      childSessionID: "child",
      content: content,
      draftRevision: revision
    )
  }
  let firstInvocation = invocation(
    "continue",
    revision: 1
  )
  let retryInvocation = invocation("continue", revision: 1)
  let changedInvocation = invocation("changed", revision: 2)
  let retainedChangedInvocation = invocation("changed", revision: 2)
  let sameTextNewRevision = invocation("changed", revision: 3)
  check(
    !firstInvocation.isEmpty
      && UUID(uuidString: firstInvocation) != nil
      && firstInvocation == retryInvocation
      && firstInvocation != changedInvocation
      && changedInvocation == retainedChangedInvocation
      && sameTextNewRevision != changedInvocation,
    "native subagent prompt retries keep one stable invocation per exact draft"
  )
  let endpoint = URL(string: "http://127.0.0.1:1/")!
  let model = ArkAppModel(
    client: ArkAPIClient(baseURL: endpoint, apiToken: "contract"),
    interactions: ArkInteractionAPI(baseURL: endpoint, apiToken: "contract"),
    eventPump: ArkEventPump(baseURL: endpoint, apiToken: "contract"),
    fallbackWikiRoot: URL(fileURLWithPath: "/tmp/ark-contract-wiki"),
    defaults: defaults
  )
  model.installSubagentCatalog(
    parentSessionID: "root",
    entries: [child],
    parentAvailable: true,
    authoritativeEntries: [child],
    clearRuntimeHints: false
  )
  model.selectedSessionID = child.id
  check(
    model.selectedSession?.running == true
      && model.selectedSubagentComposerState.canStop(sessionRunning: true),
    "native catalog-only child begins with one synthetic running owner"
  )

  model.consumeSubagentNavigationFrame(ArkEventFrame(
    channel: .host,
    rpcID: "terminal-idle",
    method: "host/session-status",
    payload: .object([
      "sessionId": .string(child.id),
      "running": .bool(false),
    ])
  ))
  let longTask = ArkLongTaskSummary.resolve(
    sessionRunning: model.selectedSession?.running == true,
    pendingInteractionCount: 0,
    toolActivities: [],
    jobs: [],
    goal: nil,
    todos: []
  )
  check(
    model.selectedSession?.running == false
      && longTask == nil
      && !model.selectedSubagentComposerState.canStop(sessionRunning: false),
    "native catalog-only child settles after the Host terminal status"
  )

  model.installSubagentCatalog(
    parentSessionID: "root",
    entries: [child],
    parentAvailable: true,
    authoritativeEntries: [child],
    clearRuntimeHints: false
  )
  model.consumeSubagentNavigationFrame(ArkEventFrame(
    channel: .host,
    rpcID: "terminal-removed",
    method: "host/session-removed",
    payload: .object(["sessionId": .string(child.id)])
  ))
  check(
    model.sessionSummary(for: child.id) == nil
      && model.selectedSession == nil
      && !model.selectedSubagentComposerState.canStop(sessionRunning: false),
    "native removed catalog-only child cannot retain synthetic running ownership"
  )

  let subagentStart = ArkToolActivity(
    id: "subagent-start",
    sequence: 20,
    name: "subagent",
    turn: 4,
    arguments: #"{"action":"start"}"#,
    result: "started child-a",
    rawCall: .object([:]),
    execution: ArkExecutionActivity(
      startedAt: Date(timeIntervalSince1970: 20),
      finishedAt: Date(timeIntervalSince1970: 21),
      phase: .succeeded
    )
  )
  let subagentWait = ArkToolActivity(
    id: "subagent-wait",
    sequence: 22,
    name: "subagent",
    turn: 4,
    arguments: #"{"action":"wait"}"#,
    result: "READY",
    rawCall: .object([:]),
    execution: ArkExecutionActivity(
      startedAt: Date(timeIntervalSince1970: 22),
      finishedAt: Date(timeIntervalSince1970: 24),
      phase: .succeeded
    )
  )
  let semanticPresentation: JSONValue = .object([
    "card": .string("generic"),
    "title": .string("Delegate"),
    "kind": .string("other"),
    "rawInput": .object([
      "semanticKind": .string("subagent"),
      "description": .string("inspect module"),
    ]),
  ])
  let subagentFork = ArkToolActivity(
    id: "subagent-fork",
    sequence: 23,
    name: "subagent_fork",
    turn: 4,
    arguments: #"{"description":"fork"}"#,
    rawCall: .object([:]),
    callPresentation: semanticPresentation
  )
  let configuredSubagent = ArkToolActivity(
    id: "configured-subagent",
    sequence: 24,
    name: "delegate_any_name",
    turn: 4,
    arguments: #"{"description":"custom"}"#,
    rawCall: .object([:]),
    callPresentation: semanticPresentation
  )
  let ordinaryTool = ArkToolActivity(
    id: "read",
    sequence: 25,
    name: "read",
    turn: 4,
    arguments: "README.md",
    rawCall: .object([:])
  )
  let transcript = ArkSubagentTranscriptProjection.fold([
    subagentStart, subagentWait, subagentFork, configuredSubagent, ordinaryTool,
  ])
  check(
    transcript.groups.count == 1
      && transcript.groups.first?.id == "subagent-turn-4"
      && transcript.groups.first?.activities.map(\.id) == [
        "subagent-start", "subagent-wait", "subagent-fork", "configured-subagent",
      ]
      && transcript.groups.first?.phase == .succeeded
      && transcript.ordinaryTools.map(\.id) == ["read"],
    "native transcript folds one turn's subagent calls into one durable task card"
  )

  let rootURL = contractNativeRoot.appendingPathComponent("Sources/JiuzhangShellUI/ArkRootView.swift")
  let modelURL = contractNativeRoot.appendingPathComponent("Sources/JiuzhangShellUI/ArkAppModel.swift")
  let lineageURL = contractNativeRoot.appendingPathComponent("Sources/JiuzhangShellUI/ArkSubagentLineage.swift")
  let subagentAPIURL = contractNativeRoot.appendingPathComponent("Sources/JiuzhangShellCore/ArkSubagentAPI.swift")
  let l10nURL = contractNativeRoot.appendingPathComponent("Sources/JiuzhangShellUI/ArkL10n.swift")
  guard
    let root = try? String(contentsOf: rootURL, encoding: .utf8),
    let model = try? String(contentsOf: modelURL, encoding: .utf8),
    let lineage = try? String(contentsOf: lineageURL, encoding: .utf8),
    let subagentAPI = try? String(contentsOf: subagentAPIURL, encoding: .utf8),
    let l10n = try? String(contentsOf: l10nURL, encoding: .utf8)
  else {
    check(false, "native subagent lineage sources are readable")
    return
  }
  check(
    root.contains("NativeSubagentLineageControl(model: model)")
      && root.contains("ark.subagent.lineage.tree")
      && root.contains("ark.session.current.\\(model.selectedSessionID ?? \"none\")")
      && root.contains("ark.subagent.lineage.row.\\(entry.id)")
      && root.contains(".disabled(row.placeholder)")
      && root.contains("model.refreshSubagentCatalog(parentSessionID: entry.id)")
      && root.contains("model.sessionAppearsAtNavigationRoot(session)")
      && root.contains("NativeSubagentTaskRow")
      && root.contains("ark.chat.subagent-task.\\(group.id)"),
    "native header owns a contextual multilevel lineage tree without duplicate flat descendants"
  )
  check(
    model.contains("let sourceIsSubagent")
      && model.contains("if !sourceIsSubagent")
      && model.contains("commitSubagentComposerSubmission")
      && model.contains("ArkSubagentPromptInvocationIdentity.make")
      && subagentAPI.contains("\"invocationId\": .string(invocationID)")
      && subagentAPI.contains("value[\"durable\"]?.boolValue == true"),
    "native subagent draft clears only after a matching durable idempotent receipt"
  )
  check(
    model.contains("subagentCatalogsByParentID")
      && model.contains("subagentCatalogStaleParents")
      && model.contains("markStaleIfLoading: true")
      && model.contains("catalogSubagentSummariesByID")
      && model.contains("sessionSummary(for: sessionID)")
      && model.contains("catalogSubagentSummariesByID[sessionID] = replacingRunning")
      && model.contains("catalogSubagentSummariesByID.removeValue(forKey: sessionID)")
      && model.contains("let activityChanged = subagentActivityHints[sessionID] != running")
      && model.contains("if activityChanged || catalogChanged"),
    "native model retains catalog-addressed descendants and refreshes only on semantic status changes"
  )
  check(
    lineage.contains("loading(previous: Self?)")
      && lineage.contains("failed(previous: Self?, message: String)")
      && lineage.contains("guard !ancestors.contains(parentSessionID)")
      && lineage.contains("ArkSubagentTranscriptProjection")
      && !lineage.contains("Timer")
      && !lineage.contains("TimelineView"),
    "native lineage projection is stale-safe cycle-safe and has no permanent animation loop"
  )
  check(
    l10n.contains("Task Lineage")
      && l10n.contains("One-shot · Read only")
      && l10n.contains("Parent unavailable")
      && l10n.contains("任务谱系"),
    "native subagent lineage chrome switches through ArkL10n"
  )
}

private func session(
  _ id: String,
  title: String,
  parent: String?,
  origin: String?,
  running: Bool
) -> ArkSessionSummary {
  ArkSessionSummary(
    id: id,
    title: title,
    updatedAt: Date(timeIntervalSince1970: 100),
    running: running,
    blank: false,
    cwd: "/tmp/fixture",
    agentPreset: "standard",
    permissionPreset: "full",
    parentSessionID: parent,
    origin: origin
  )
}
