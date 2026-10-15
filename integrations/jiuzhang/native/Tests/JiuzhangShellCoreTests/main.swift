import Darwin
import Foundation
import AppKit
import JiuzhangShellCore
import JiuzhangShellUI

if let index = CommandLine.arguments.firstIndex(of: "--protected-review-probe"), CommandLine.arguments.indices.contains(index + 1) {
  Darwin.exit(runArkProtectedReviewProbe(output: URL(fileURLWithPath: CommandLine.arguments[index + 1])))
}

if let index = CommandLine.arguments.firstIndex(of: "--protected-xpc-probe"), CommandLine.arguments.indices.contains(index + 1) {
  Darwin.exit(await runArkProtectedXPCProbe(expectedService: URL(fileURLWithPath: CommandLine.arguments[index + 1])))
}

if let index = CommandLine.arguments.firstIndex(of: "--private-channel-probe"), CommandLine.arguments.indices.contains(index + 1) {
  Darwin.exit(runArkPrivateChannelProbe(CommandLine.arguments[index + 1]))
}

if let helperStatus = NativePTYTerminalChild.exitStatusIfRequested() {
  Darwin._exit(helperStatus)
}
if ProcessInfo.processInfo.environment["ARK_MARKDOWN_RENDER_PROBE_CHILD"] == "transition" {
  Darwin._exit(runArkHistoryTransitionProbeChild())
}
if ProcessInfo.processInfo.environment["ARK_MARKDOWN_RENDER_PROBE_CHILD"] == "1" {
  Darwin._exit(runArkMarkdownHostingProbeChild())
}

if let index = CommandLine.arguments.firstIndex(of: "--protected-observation-probe") {
  Darwin.exit(await runArkProtectedObservationProbe(Array(CommandLine.arguments.dropFirst(index + 1))))
}

if let index = CommandLine.arguments.firstIndex(of: "--protected-evaluator-probe") {
  Darwin.exit(await runArkProtectedEvaluatorProbe(Array(CommandLine.arguments.dropFirst(index + 1))))
}

if let index = CommandLine.arguments.firstIndex(of: "--protected-guard-lifecycle-probe") {
  Darwin.exit(await runArkProtectedGuardLifecycleProbe(Array(CommandLine.arguments.dropFirst(index + 1))))
}

if let index = CommandLine.arguments.firstIndex(of: "--protected-evaluator-cancellation-probe") {
  Darwin.exit(await runArkProtectedEvaluatorCancellationProbe(Array(CommandLine.arguments.dropFirst(index + 1))))
}

if let index = CommandLine.arguments.firstIndex(of: "--protected-runtime-timing-probe") {
  Darwin.exit(runArkProtectedRuntimeTimingProbe(Array(CommandLine.arguments.dropFirst(index + 1))))
}

if CommandLine.arguments.contains("--protected-owner-contracts") {
  await runArkProtectedOwnerContractChecks()
  await runArkProtectedObservationContractChecks()
  runArkProtectedRuntimeFDContractChecks()
  await runArkProtectedCostContractChecks()
  await runArkNativeOwnerChannelContractChecks()
  print("protected-owner-contracts failures=\(failureCount)")
  Darwin.exit(failureCount == 0 ? 0 : 1)
}

if let directory = ProcessInfo.processInfo.environment["ARK_NATIVE_CONTRACT_DIAGNOSTICS_DIR"],
   !directory.isEmpty {
  do {
    guard let executable = Bundle.main.executableURL else {
      throw CocoaError(.fileNoSuchFile)
    }
    let destination = URL(fileURLWithPath: directory, isDirectory: true)
    try FileManager.default.createDirectory(
      at: destination, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700]
    )
    let identity: [String: Any] = [
      "schemaVersion": 1,
      "pid": Int(Darwin.getpid()),
      "executablePath": executable.resolvingSymlinksInPath().path,
      "startedAtUTC": ISO8601DateFormatter().string(from: Date()),
    ]
    let data = try JSONSerialization.data(withJSONObject: identity, options: [.sortedKeys])
    try data.write(to: destination.appendingPathComponent("identity.json"), options: .atomic)
  } catch {
    FileHandle.standardError.write(Data("CONTRACT_DIAGNOSTIC identity-write-error: \(error)\n".utf8))
  }
}

let expectedContractGroups = [
  "inline",
  "backend-recovery",
  "protected-owner",
  "event-pump-lifecycle",
  "domain-api",
  "duplicate-key",
  "interaction-api",
  "composer-sources",
  "chat-scroll",
  "chat-presentation",
  "reasoning-summary",
  "event-channel-recovery",
  "chat-turn-usage",
  "message-batch",
  "semantic-history",
  "history-window",
  "native-extension-registry",
  "subagent-lineage",
  "markdown-gfm",
  "session-search",
  "tool-presentation",
  "produced-files",
  "native-tool-presentation-view",
  "long-task-summary",
  "goal-workflow",
  "wiki-queue",
  "wiki-project-lifecycle",
  "chat-status-localization",
  "context-meter",
  "message-image-store",
  "root-nav-hit-target",
  "event-routing",
  "workbench-shell",
  "native-pty-terminal",
  "pty-resize",
  "native-terminal-session-repair",
  "document-reference",
  "native-code-editor",
  "native-theme",
  "reasoning-effort",
  "shell-parity",
  "trajectory",
  "trajectory-recompute",
  "trajectory-pipeline",
  "chat-refresh",
  "chat-history-reading",
  "injected-cut",
  "settings",
  "provider-recovery-wire",
  "files-tabs",
  "files-race",
  "workbench-draft-journal",
  "native-file-operations",
  "native-git-review",
]
var reachedContractGroups: [String] = []

func recordNativeContractPhase(_ group: String, _ phase: String) {
  let line = "CONTRACT_PHASE group=\(group) phase=\(phase) pid=\(Darwin.getpid()) uptime=\(ProcessInfo.processInfo.systemUptime)\n"
  FileHandle.standardError.write(Data(line.utf8))
}

@MainActor
func runContractGroup(_ name: String, _ body: @MainActor () -> Void) {
  recordNativeContractPhase(name, "STARTED")
  body()
  recordNativeContractPhase(name, "FINISHED")
  reachedContractGroups.append(name)
  print("REACHED: \(name)")
}

@MainActor
func runAsyncContractGroup(_ name: String, _ body: @MainActor () async -> Void) async {
  recordNativeContractPhase(name, "STARTED")
  await body()
  recordNativeContractPhase(name, "FINISHED")
  reachedContractGroups.append(name)
  print("REACHED: \(name)")
}

runContractGroup("inline", runInlineContractChecks)
await runAsyncContractGroup("backend-recovery") {
  failureCount += await runBackendRecoveryContractChecks()
}
await runAsyncContractGroup("protected-owner") {
  await runArkProtectedOwnerContractChecks()
  await runArkProtectedObservationContractChecks()
  runArkProtectedRuntimeFDContractChecks()
  await runArkProtectedCostContractChecks()
  await runArkNativeOwnerChannelContractChecks()
}
await runAsyncContractGroup("event-pump-lifecycle", runArkEventPumpLifecycleContractChecks)
runContractGroup("domain-api", runArkDomainAPIContractChecks)
runContractGroup("duplicate-key", runArkDuplicateKeyContractChecks)
runContractGroup("interaction-api", runArkInteractionAPIContractChecks)
runContractGroup("composer-sources", runArkComposerSourcesContractChecks)
runContractGroup("chat-scroll", runArkChatScrollContractChecks)
runContractGroup("chat-presentation", runArkChatPresentationContractChecks)
runContractGroup("reasoning-summary", runArkReasoningSummaryContractChecks)
runContractGroup("event-channel-recovery", runArkEventChannelRecoveryContractChecks)
runContractGroup("chat-turn-usage", runArkChatTurnUsageContractChecks)
runContractGroup("message-batch", runArkMessageBatchContractChecks)
await runAsyncContractGroup("semantic-history", runArkSemanticHistoryContractChecks)
await runAsyncContractGroup("history-window", runArkHistoryWindowContractChecks)
runContractGroup("native-extension-registry", runArkNativeExtensionRegistryContractChecks)
runContractGroup("subagent-lineage", runArkSubagentLineageContractChecks)
runContractGroup("markdown-gfm", runArkMarkdownGFMContractChecks)
runContractGroup("session-search", runArkSessionSearchContractChecks)
runContractGroup("tool-presentation", runArkToolPresentationContractChecks)
runContractGroup("produced-files", runArkProducedFilesContractChecks)
runContractGroup("native-tool-presentation-view", runNativeToolPresentationViewContractChecks)
runContractGroup("long-task-summary", runArkLongTaskSummaryContractChecks)
runContractGroup("goal-workflow", runArkGoalWorkflowContractChecks)
runContractGroup("wiki-queue", runArkWikiQueueContractChecks)
runContractGroup("wiki-project-lifecycle", runArkWikiProjectLifecycleContractChecks)
runContractGroup("chat-status-localization", runArkChatStatusLocalizationContractChecks)
runContractGroup("context-meter", runArkContextMeterContractChecks)
await runAsyncContractGroup("message-image-store", runArkMessageImageStoreContractChecks)
runContractGroup("root-nav-hit-target", runArkRootNavHitTargetContractChecks)
runContractGroup("event-routing", runArkEventRoutingContractChecks)
await runAsyncContractGroup("workbench-shell", runArkWorkbenchShellContractChecks)
await runAsyncContractGroup("native-pty-terminal", runArkNativePTYTerminalBehaviorContractChecks)
runContractGroup("pty-resize", runArkPTYResizeContractChecks)
runContractGroup("native-terminal-session-repair", runArkTerminalSessionRepairContractChecks)
await runAsyncContractGroup("document-reference", runArkDocumentReferenceContractChecks)
runContractGroup("native-code-editor", runArkNativeCodeEditorContractChecks)
runContractGroup("native-theme", runArkNativeThemeContractChecks)
runContractGroup("reasoning-effort", runArkReasoningEffortContractChecks)
runContractGroup("shell-parity", runArkShellParityContractChecks)
runContractGroup("trajectory") {
  runArkTrajectoryContractChecks()
  runArkTrajectoryScrollContractChecks()
  runArkTrajectoryScrollScenarioChecks()
}
runContractGroup("trajectory-recompute", runArkTrajectoryRecomputeContractChecks)
await runAsyncContractGroup("trajectory-pipeline", runArkTrajectoryPipelineContractChecks)
await runAsyncContractGroup("chat-refresh", runArkChatRefreshContractChecks)
await runAsyncContractGroup("chat-history-reading", runArkChatHistoryReadingContractChecks)
runContractGroup("injected-cut", runArkInjectedCutContractChecks)
runContractGroup("settings", runArkSettingsContractChecks)
await runAsyncContractGroup("provider-recovery-wire", runArkProviderRecoveryContractChecks)
runContractGroup("files-tabs", runArkFilesTabsContractChecks)
await runAsyncContractGroup("files-race", runArkFilesRaceContractChecks)
await runAsyncContractGroup("workbench-draft-journal", runArkWorkbenchDraftJournalContractChecks)
runContractGroup("native-file-operations", runArkNativeFileOperationsContractChecks)
await runAsyncContractGroup("native-git-review", runArkNativeGitReviewContractChecks)

check(
  reachedContractGroups == expectedContractGroups,
  "all \(expectedContractGroups.count) Jiuzhang contract groups execute in order"
)
print(
  "Jiuzhang contract reachability: \(reachedContractGroups.count)/\(expectedContractGroups.count) groups reached"
)

if failureCount != 0 {
  print("\(failureCount) Jiuzhang shell contract checks failed")
  exit(1)
}
print("Jiuzhang shell contract checks passed")
