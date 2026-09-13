import Darwin
import Foundation
import AppKit
import JiuzhangShellCore
import JiuzhangShellUI

if let helperStatus = NativePTYTerminalChild.exitStatusIfRequested() {
  Darwin._exit(helperStatus)
}
if ProcessInfo.processInfo.environment["ARK_MARKDOWN_RENDER_PROBE_CHILD"] == "transition" {
  Darwin._exit(runArkHistoryTransitionProbeChild())
}
if ProcessInfo.processInfo.environment["ARK_MARKDOWN_RENDER_PROBE_CHILD"] == "1" {
  Darwin._exit(runArkMarkdownHostingProbeChild())
}

let expectedContractGroups = [
  "inline",
  "backend-recovery",
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
  "settings",
  "provider-recovery-wire",
  "files-tabs",
  "files-race",
  "workbench-draft-journal",
  "native-file-operations",
  "native-git-review",
]
var reachedContractGroups: [String] = []

@MainActor
func runContractGroup(_ name: String, _ body: @MainActor () -> Void) {
  body()
  reachedContractGroups.append(name)
  print("REACHED: \(name)")
}

@MainActor
func runAsyncContractGroup(_ name: String, _ body: @MainActor () async -> Void) async {
  await body()
  reachedContractGroups.append(name)
  print("REACHED: \(name)")
}

runContractGroup("inline", runInlineContractChecks)
await runAsyncContractGroup("backend-recovery") {
  failureCount += await runBackendRecoveryContractChecks()
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
