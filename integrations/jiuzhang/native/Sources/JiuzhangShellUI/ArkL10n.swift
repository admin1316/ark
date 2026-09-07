import Foundation

/// UI 壳层文案的纯内存本地化表（O(1) 查表，无文件 I/O）。
///
/// 范围纪律：
/// - 只翻译 UI 壳层文案；用户内容、模型输出、原始 JSON、审计数据永不进表；
/// - 术语白名单（全产品固定，避免漂移）：
///   Session Log / 会话日志 · Raw JSON / 原始 JSON · Token · API ·
///   Plugin / 插件 · Preset / 预设；
/// - JSON/API/Token 等技术术语保留原文，其余中文模式下不得残留英文。
public enum ArkL10n {
  public enum Key: String, CaseIterable, Sendable {
    // 设置页：导航与窗口
    case settingsTitle
    case settingsGeneral
    case settingsModels
    case settingsPlugins
    case settingsPresets
    case settingsOpenConfigFile
    case settingsClose
    case menuAbout
    case menuSettings
    case menuHide
    case menuHideOthers
    case menuShowAll
    case menuQuit
    case menuFile
    case menuEdit
    case menuUndo
    case menuRedo
    case menuCut
    case menuCopy
    case menuPaste
    case menuSelectAll

    // 设置页：General 页头
    case generalTitle
    case generalSubtitle

    // 分组 1：默认预设
    case groupDefaultPresetTitle
    case groupDefaultPresetSubtitle

    // 分组 2：默认权限
    case groupDefaultPermissionTitle
    case groupDefaultPermissionSubtitle
    case permissionFullAccess
    case permissionWorkspaceAccess
    case permissionReadOnly
    case permissionRestricted
    case permissionUnavailable

    // 分组 3：界面语言
    case groupInterfaceLanguageTitle
    case groupInterfaceLanguageSubtitle
    case languageSimplifiedChinese
    case languageEnglish
    case settingsLanguageUnavailable

    // 分组 4：外观
    case groupAppearanceTitle
    case groupAppearanceSubtitle
    case appearanceLight
    case appearanceDark
    case appearanceSystem

    // 分组 5：回车键行为
    case groupEnterKeyTitle
    case groupEnterKeySubtitle
    case groupChatDisplayTitle
    case groupChatDisplaySubtitle
    case enterSendMessage
    case enterInsertNewline
    case enterQueueSend
    case enterInterjectNow

    // 分组 6：运行边界
    case groupRuntimeBoundaryTitle
    case runtimeInterface
    case runtimeBackend
    case runtimeInterfaceValue
    case runtimeBackendValue
    case runtimeSafetyTitle
    case runtimeSafetyDetail

    // 轨迹详情面板
    case tabOverview
    case tabInput
    case tabOutput
    case tabRawJSON
    case fieldState
    case fieldSequence
    case fieldStarted
    case fieldDuration
    case fieldThisRequest
    case fieldInput
    case fieldCached
    case fieldCacheCreated
    case fieldOutput
    case fieldReasoning
    case fieldProvider
    case fieldModel
    case fieldRetry
    case fieldCompaction
    case trajectoryRunning
    case trajectoryCompleted
    case trajectoryError
    case trajectoryPending
    case copyJSON
    case copiedJSON
    case closeDetail
    case trajectoryInputSummary
    case trajectoryOutputSummary
    case trajectoryInputMissing
    case trajectoryOutputMissing
    case trajectoryKindSystem
    case trajectoryKindUser
    case trajectoryKindContext
    case trajectoryKindAssistant
    case trajectoryKindTool
    case trajectoryKindSubtool
    case trajectoryKindCompacted
    case trajectoryViewLabel
    case trajectoryTimeline
    case trajectoryTable
    case trajectoryDurationMode
    case trajectoryUseEqualEvents
    case trajectoryUseActualDuration
    case trajectoryTurns
    case trajectoryCalls
    case trajectorySearchPlaceholder
    case trajectoryShowAll
    case trajectoryTypeCount
    case trajectoryLoadOlderHistory
    case trajectoryLoadingOlder
    case trajectoryLoadOlder
    case trajectoryEmpty
    case trajectoryNoMatches
    case trajectoryColumnEvent
    case trajectoryColumnContent
    case trajectoryCollapsedSession
    case trajectoryRecordsAndCalls
    case trajectoryCollapsedCalls
    case trajectoryTurnWithSummary
    case trajectoryBetweenTurns
    case trajectoryTurn
    case trajectoryStep
    case trajectoryMessage
    case trajectorySession
    case trajectoryTurnStep
    case trajectoryTurnMessage
    case trajectoryExpandCalls
    case trajectoryCollapseCalls
    case trajectorySelected
    case trajectoryMaxRetry
    case trajectoryDelay
    case trajectoryImages

    // 主导航 / 侧边栏 / 会话日志
    case navChat
    case navTrajectory
    case navWiki
    case wikiSwitchWorkspaceHelp
    case wikiPagesCount
    case wikiGraphTitle
    case wikiGraphCounts
    case wikiInteractionHint
    case wikiLayout
    case wikiLayoutType
    case wikiLayoutCommunity
    case wikiLegendConcept
    case wikiLegendMethod
    case wikiLegendOverview
    case wikiLegendEvidence
    case wikiLegendOther
    case wikiInspector
    case wikiDetails
    case wikiDeepResearch
    case wikiResearchPlaceholder
    case wikiStart
    case wikiNewProject
    case wikiSearchPlaceholder
    case wikiSearch
    case wikiImport
    case wikiImportFiles
    case wikiImportURL
    case wikiImportURLTitle
    case wikiImportURLPlaceholder
    case wikiImportURLInvalid
    case wikiNewPage
    case wikiImportHelp
    case wikiCreatePageTitle
    case wikiPageTitlePlaceholder
    case wikiCancel
    case wikiCreate
    case wikiCreateProjectTitle
    case wikiProjectName
    case wikiProjectDirectory
    case wikiProjectCreationDetail
    case wikiRemoveProject
    case wikiRemoveProjectTitle
    case wikiRemoveProjectDetail
    case wikiProjectManagedByWorkspace
    case wikiProjectRemovalFailed
    case wikiChooseProjectDirectory
    case wikiChooseSources
    case wikiResetGraph
    case wikiReview
    case wikiSave
    case wikiEdit
    case wikiResolved
    case wikiResolve
    case wikiBulkIgnore
    case wikiBulkIgnoreConfirmTitle
    case wikiBulkIgnoreConfirmDetail
    case wikiBulkIgnoreConfirm
    case wikiBulkReviewFailed
    case wikiQueueTitle
    case wikiQueueProgress
    case wikiQueueRunning
    case wikiQueueIdle
    case wikiQueueRefresh
    case wikiQueueCancelPending
    case wikiQueueCancelBoundary
    case wikiQueuePending
    case wikiQueueTaskRunning
    case wikiQueueDone
    case wikiQueueError
    case wikiQueueCancelled
    case wikiSaved
    case wikiUnsaved
    case wikiReload
    case wikiDetailEmpty
    case toolDetailTitle
    case toolDetailEmpty
    case brandTitle
    case flatSessions
    case recentFirst
    case sessionSort
    case searchResults
    case searching
    case noMatchingSessions
    case searchSessions
    case expandSidebar
    case collapseWorkspace
    case expandWorkspace
    case renameSession
    case forkSession
    case archiveSession
    case renameWorkspace
    case removeWorkspace
    case showLess
    case showMoreCount
    case renameSessionTitle
    case renameWorkspaceTitle
    case sessionTitleField
    case workspaceNameField
    case commonCancel
    case commonSave
    case removeWorkspaceConfirm
    case removeRegistration
    case removeWorkspaceDataTitle
    case removeWorkspaceDataDetail
    case removeWorkspaceDataAction
    case workspaceDeleteRunning
    case toastWorkspaceRecordsRemoved
    case dropImagesHere
    case pluginsConfiguration
    case pluginsInventory
    case extensionsTitle
    case extensionsSubtitle
    case extensionsRefresh
    case extensionsSearchPlaceholder
    case extensionsEntriesCount
    case extensionsEnabledCount
    case extensionsActiveCount
    case extensionsLoading
    case extensionsEmptyTitle
    case extensionsNoMatchesTitle
    case extensionsEmptyDetail
    case extensionsNoMatchesDetail
    case extensionsConfigEmptyTitle
    case extensionsConfigEmptyDetail
    case extensionUnsaved
    case extensionOverridden
    case extensionPositiveNumber
    case extensionAppliesLive
    case extensionAppliesRestart
    case extensionEditConfiguration
    case extensionDefaultsOverridden
    case extensionDefaultsUsed
    case extensionRestoreDefault
    case extensionDiscardChanges
    case extensionAPIKey
    case extensionKeepSecret
    case extensionEnterSecret
    case extensionInvalidAPIKey
    case extensionDefaultBaseURL
    case extensionPhaseDisabled
    case extensionPhasePending
    case extensionPhaseLoading
    case extensionPhaseActive
    case extensionPhaseFailed
    case extensionPhaseUnloading
    case extensionPhaseUnknown
    case extensionEnabled
    case extensionDisabled
    case extensionCollapseDetails
    case extensionExpandDetails
    case extensionEntryID
    case extensionConfigurationLabel
    case extensionCoreCapability
    case interactionDecisionRequired
    case approvalWaiting
    case approvalEscalation
    case approvalReject
    case approvalAllowOnce
    case questionCustomAnswer
    case questionCancel
    case questionPrevious
    case questionSkip
    case questionNext
    case questionSubmit
    case planReviewHeader
    case planReviewDiscuss
    case planReviewDecline
    case planReviewApprove
    case goalPhaseActive
    case goalPhasePaused
    case goalPhaseBlocked
    case goalRounds
    case goalPause
    case goalResume
    case goalEdit
    case goalClear
    case goalSave
    case goalCancel
    case goalObjective
    case goalUnavailable
    case workflowRun
    case workflowPhaseUnassigned
    case workflowMembers
    case workflowOpenSession
    case workflowMoreMembers
    case workflowCollapse
    case workflowExpand
    case executionRunning
    case executionCompleted
    case executionFailed
    case executionCancelled
    case executionCollapseSteps
    case executionExpandSteps
    case executionMoreSteps
    case imageLoading
    case imageLoadCancelled
    case imageLoadFailed
    case imageRetry
    case imageCancelLoading
    case imageOpenOriginal
    case imageClosePreview
    case toastCustomProviderSaved
    case toastPresetCopied
    case toastPresetDeleted
    case toastSessionRenamed
    case toastSessionArchived
    case toastSessionRestored
    case toastSessionDeletedPermanently
    case toastSessionForked
    case toastStopRequested
    case toastWorkspaceAdded
    case toastWorkspaceRenamed
    case toastWorkspaceRemoved
    case toastAllowedOnce
    case toastDeniedOnce
    case toastAnswerSubmitted
    case toastQuestionCancelled
    case toastKnowledgeProjectCreated
    case toastKnowledgeProjectRemoved
    case toastKnowledgePageCreated
    case toastReviewProcessed
    case toastReviewsProcessed
    case archiveEmpty
    case archiveDeletePermanently
    case archiveCancel
    case archiveDeleteWarningShort
    case archiveRestoreHelp
    case archiveRestoreHint
    case archiveDone
    case archiveSearchPlaceholder
    case archiveHideHint
    case archiveDeleteWarningLong
    case archiveRestore
    case toastCredentialSavedSecure
    case toastSavedProvider
    case toastRemovedProvider
    case toastCredentialRemoved
    case toastPresetPath
    case toastSessionExported
    case toastKnowledgeHits
    case toastKnowledgeImported
    case toastDeepResearchDone
    case newConversation
    case newConversationHeroTitle
    case newConversationAddWorkspace
    case newConversationWorkspaceHelp
    case newConversationPresetUnavailable
    case composerHeroPlaceholder
    case composerPlaceholder
    case composerCommands
    case composerCapabilityMenu
    case composerPlanCommand
    case composerGoalCommand
    case composerCompactCommand
    case composerFeedbackCommand
    case composerPermissionCommand
    case composerFeedbackCommandDetail
    case composerPermissionCommandDetail
    case composerPlanCommandDetail
    case composerGoalCommandDetail
    case composerCompactCommandDetail
    case composerLauncherAddSection
    case composerLauncherTasksSection
    case composerLauncherPluginsSection
    case composerLauncherFiles
    case composerLauncherFilesDetail
    case composerLauncherFilesSearch
    case composerLauncherFilesEmpty
    case composerLauncherSessions
    case composerLauncherSessionsDetail
    case composerLauncherSessionsSearch
    case composerLauncherSessionsEmpty
    case composerLauncherGoalDetail
    case composerLauncherPlanDetail
    case composerLauncherCompactDetail
    case composerSourcesNeedSession
    case composerSourcesCatalogChanged
    case composerSourcesLoading
    case composerSourcesNoMatches
    case composerSourceCommand
    case composerSourceSkill
    case composerSourceUserOnly
    case composerSuggestionSelected
    case composerSkillsGroup
    case composerSkillsCount
    case composerSkillFamilyCount
    case composerOtherSkills
    case composerSourcesBack
    case composerSourceFile
    case composerSourceFolder
    case composerSourceSession
    case composerAttach
    case composerPastedText
    case composerDocumentBounded
    case composerDocumentRemove
    case composerNoModels
    case composerModelUnavailable
    case composerChooseAvailableModel
    case composerStop
    case composerSend
    case relativeNow
    case relativeMinutes
    case relativeHours
    case relativeDays
    case relativeWeeks
    case relativeMonths
    case statsTurnsSteps
    case statsToolCalls
    case statsFirstTokenAverage
    case statsCacheHit
    case statsInputOutput
    case archiveTitle
    case collapseSidebar
    case backToLatest
    case sessionLog
    case sessionExport
    case sessionExporting
    case sessionExportPreparing
    case sessionExportCancel
    case sessionExportSucceeded
    case sessionExportBytes
    case sessionExportDone
    case sessionExportFailed
    case sessionExportClose
    case sessionActivityIdle
    case sessionActivityRunning
    case sessionActivityStopping
    case sessionActivityStopped
    case sessionActivityNeedsDecision
    case sessionActivityFailed
    case sessionActivityTitle
    case pendingInteractionsCount
    case messageCopy
    case messageCopied
    case messageHelpful
    case messageNeedsImprovement
    case messageFeedbackNote
    case messageForkHere
    case messageForkUnavailable
    case messageMetricDuration
    case messageMetricFirstToken
    case chatDisplayTitle
    case chatDisplayAdjust
    case chatDisplayDetail
    case chatFontSize
    case chatFontSizeValue
    case chatAdaptiveWidth
    case chatContentWidth
    case chatCompactProcess
    case chatReceivingReply
    case chatSyncingHistory
    case chatHistoryEmpty
    case chatHistoryFailed
    case chatHistoryRetry
    case chatLoadOlder
    case chatLoadingOlder
    case chatSystemPrompt
    case chatSystemPromptExpand
    case chatSystemPromptCollapse
    case chatUnknownContent
    case chatTurnProcessToolCalls
    case chatTurnProcessMessages
    case chatTurnProcessSubagents
    case chatTurnProcessThought
    case chatTurnProcessSeparator
    case chatTurnProcessTitle
    case chatTurnProcessShowMore
    case chatTurnProcessShowLess
    case chatTurnProcessExpand
    case chatTurnProcessCollapse
    case chatTurnUsageTitle
    case chatTurnUsageCount
    case chatTurnUsageSummary
    case chatTurnUsageProviderModel
    case chatTurnUsageInput
    case chatTurnUsageCacheRead
    case chatTurnUsageCacheWrite
    case chatTurnUsageOutput
    case chatTurnUsageReasoning
    case chatTurnUsageTotal
    case chatTurnNavigationJump
    case toolOpenInFiles
    case toolTodoTitle
    case toolQuestionFallback
    case toolTodoCounts
    case toolDiffFiles
    case toolSearchResults
    case toolExitCode
    case composerSubagentContinuable
    case composerSubagentReadOnly
    case queueCount
    case queuePendingNonText
    case queuePendingMessage
    case queueEdit
    case queueSteer
    case queueRemove
    case queueEditPlaceholder
    case permissionDangerTitle
    case permissionDangerDetail
    case permissionDangerAcknowledgement
    case permissionDangerConfirm
    case stopSession
    case returnToParentSession
    case subagentLineage
    case subagentLineageCount
    case subagentLineageRunningCount
    case subagentLineageLoading
    case subagentLineageLoadFailed
    case subagentLineageRetry
    case subagentLineageRefresh
    case subagentLineageOneShot
    case subagentLineageContinuable
    case subagentLineageRunning
    case subagentLineageInactive
    case subagentLineageParentUnavailable
    case subagentLineageDiagnostic
    case subagentLineageExpand
    case subagentLineageCollapse
    case subagentTranscriptTitle
    case subagentTranscriptOperations
    case subagentTranscriptCompleted
    case subagentTranscriptFailed
    case subagentTranscriptCancelled
    case subagentTranscriptExpand
    case subagentTranscriptCollapse
    case subagentModelSelectionTitle
    case subagentModelSelectionDetail
    case subagentModelSelectionEnabled
    case subagentModelSelectionNoModels
    case subagentModelSelectionProvider
    case subagentModelSelectionModel
    case toastSubagentModelSelectionSaved
    case producedFilesLabel
    case producedFilesOpen
    case producedFilesMore
    case contextUsedPercent
    case contextApproximate
    case contextSystemPrompt
    case contextTools
    case contextMessages
    case contextInjection
    case contextRecall
    case contextFormInstructions
    case contextFormCatalog
    case contextFormSnapshot
    case contextFormNotice
    case contextFormRelay
    case contextFormRecall
    case workbench
    case workbenchCollapse
    case workbenchOpen
    case workbenchResizePanel
    case workbenchReview
    case workbenchTerminal
    case workbenchBrowser
    case workbenchFiles
    case workbenchReviewFilter
    case workbenchReviewNoChanges
    case workbenchReviewSelectChange
    case workbenchOpenFile
    case gitChanges
    case gitHistory
    case gitBranches
    case gitRepository
    case gitCommits
    case gitChangedFiles
    case gitNoChangedFiles
    case gitSelectChangedFile
    case gitExpandAllDiffs
    case gitCollapseAllDiffs
    case gitAllTrackedChanges
    case gitTrackedChangesOnly
    case gitCombinedDiff
    case gitWorkingDiff
    case gitStagedDiff
    case gitStage
    case gitUnstage
    case gitDiscard
    case gitStageAll
    case gitUnstageAll
    case gitCommitPlaceholder
    case gitCommit
    case gitNewBranchPlaceholder
    case gitCreateBranch
    case gitCurrentBranch
    case gitSwitchBranch
    case gitRepositoryRoot
    case gitNotRepository
    case gitNotRepositoryDetail
    case gitInitializeRepository
    case gitRepositoryTracking
    case gitCommitIdentity
    case gitIdentityName
    case gitIdentityEmail
    case gitSaveIdentity
    case gitRemoteConnections
    case gitNoRemote
    case gitRemoteNamePlaceholder
    case gitRemoteURLPlaceholder
    case gitConnectRemote
    case gitUseRemote
    case gitCredentialsSystemManaged
    case gitDiscardTitle
    case gitOperationFailed
    case workbenchNoTabs
    case workbenchChooseRootTitle
    case workbenchChooseRootDetail
    case workbenchChooseRoot
    case workbenchSwitchWorkspaceTitle
    case workbenchSwitchWorkspaceDetail
    case workbenchDiscardAndSwitch
    case workbenchBrowserPlaceholder
    case workbenchBrowserOpen
    case workbenchBrowserOpenExternal
    case workbenchBrowserDetail
    case workbenchBrowserLoading
    case workbenchBrowserUnavailable
    case workbenchBrowserTruncated
    case workbenchBrowserHTTPFailure
    case workbenchBrowserInvalid
    case workbenchBrowserOpenFailed
    case newSession
    case workspaceSection
    case ungroupedSection
    case backToWorkspace
    case groupByWorkspace
    case manualWorkspaceOrder
    case addWorkspace
    case newSessionInWorkspace

    // Files 工作台
    case filesPathPlaceholder
    case filesOpen
    case filesSearchPlaceholder
    case filesRefresh
    case filesShowTree
    case filesHideTree
    case filesResizeTree
    case filesActions
    case filesNewFile
    case filesNewFolder
    case filesRename
    case filesDuplicate
    case filesMove
    case filesTrash
    case filesShowHiddenNoise
    case filesHideHiddenNoise
    case filesRecoveryTitle
    case filesRecoveryDetail
    case filesRecoveryLater
    case filesRecoveryCompare
    case filesRecoveryHideCompare
    case filesRecoveryDiskVersion
    case filesRecoveryDraftVersion
    case filesRecoveryDiscard
    case filesRecoveryRestore
    case filesRecoveryEmpty
    case filesEmptyDir
    case filesRootUnavailable
    case filesUnsaved
    case filesRevert
    case filesSave
    case filesExport
    case filesUTF8Limit
    case filesEmptyEditorTitle
    case filesEmptyEditorDetail
    case filesRefreshFailed
    case filesNotExists
    case filesSelectFile
    case filesReadFailed
    case filesReverted
    case filesSaved
    case filesSaveFailed
    case filesLoaded
    case filesOpenFailed
    case filesCloseDirtyTitle
    case filesCloseDirtyMessage
    case filesCloseDirtyWorkbenchMessage
    case filesCloseTab
    case filesRevealInFinder
    case filesDiscardAll
    case filesCancel
    case filesDiscard
    case filesCloseWorkbench
    case filesOpenTab
    case filesGitTitle
    case filesGitRefresh
    case filesGitLoading
    case filesTerminalTitle
    case filesTerminalStop
    case filesTerminalClear
    case filesTerminalCopy
    case filesTerminalPlaceholder
    case filesTerminalRunning
    case filesTerminalStopping
    case filesTerminalScope
    case filesTerminalStartFailed
    case filesExportSucceeded
    case filesExportFailed
    case filesGitStatusTitle
    case filesGitWorkingDiffTitle
    case filesGitStagedDiffTitle
    case filesGitClean
    case filesNoWorkingDiff
    case filesNoStagedDiff
    case filesNoOutput
    case filesGitRefreshed
    case filesGitRefreshFailed
    case filesTerminalSignalTerminated
    case filesTerminalEnded
    case filesTerminalOutputTitle

    // 通用
    case permissionSwitchedTo

    // 内置预设展示（按稳定 ID 映射；用户自建原样）
    case presetStandardName
    case presetStandardDescription
    case presetCodeName
    case presetCodeDescription
    case presetMinimalName
    case presetMinimalDescription
    case presetCordisName
    case presetCordisDescription
    case presetPageTitle
    case presetPageSubtitle
    case presetBuiltInLabel
    case presetCustomLabel
    case presetCurrentLabel
    case presetLoading
    case presetEmptyTitle
    case presetEmptyDetail
    case presetNoCustom
    case presetNotAuthorable
    case presetCreatorDraft
    case presetLoadFailed
    case presetNoDescription
    case presetCurrentDefault
    case presetSetDefault
    case presetViewReadOnly
    case presetViewContent
    case presetCopy
    case presetOpenFolder
    case presetShowFolder
    case presetDeleteUser
    case presetRefresh
    case presetDeleteConfirm
    case presetDeleteConfirmFallback
    case presetDeleteAction
    case presetCancel
    case presetCopyTitle
    case presetCopyDetail
    case presetCopyIdentifier
    case presetCopyDisplayName
    case presetCopyIdentifierRule
    case presetCopyAction
    case presetReadOnlyLabel
    case presetClose

    // 内置插件设置卡
    case pluginTerminalTitle
    case pluginTerminalDetail
    case pluginAgentLoopTitle
    case pluginAgentLoopDetail
    case pluginWebSearchTitle
    case pluginWebSearchDetail

    // 配置状态
    case statusConfigured
    case statusUnconfigured
    case statusCredentialSaved
    case statusRegistered
    case statusUnavailable

    // 会话状态行（ArkChatStatusProjection 投影文案）
    case statusCommandFallback
    case statusCommandRunning
    case statusCommandDone
    case statusCommandFailed
    case statusCommandStopped
    case statusCompactionTitle
    case statusCompactionDetail
    case statusCompactionExpandSummary
    case statusCompactionSummaryMissing
    case statusRequestContextTitle
    case statusContextTokens
    case statusRetryInProgress
    case statusRetryAfterDelay
    case statusRetryNow
    case statusRetryAttempt
    case statusRetryAttemptOfMax
    case statusRetryDone
    case statusRetryFailed
    case statusRetryCancelled
    case statusReplyFailed
    case statusMaxTokensTitle
    case statusMaxTokensDetail
    case statusReplyStopped
    case statusBlocked
    case statusInterrupted
    case statusAuthRejected
    case statusAuthRejectedHTTP
  }

  private struct Entry: Sendable {
    let zh: String
    let en: String
  }

  private static let table: [Key: Entry] = [
    // 设置页：导航与窗口
    .settingsTitle: Entry(zh: "设置", en: "Settings"),
    .settingsGeneral: Entry(zh: "通用", en: "General"),
    .settingsModels: Entry(zh: "模型", en: "Models"),
    .settingsPlugins: Entry(zh: "扩展能力", en: "Extensions"),
    .settingsPresets: Entry(zh: "预设", en: "Presets"),
    .settingsOpenConfigFile: Entry(zh: "打开配置文件", en: "Open Config File"),
    .settingsClose: Entry(zh: "关闭设置，返回对话", en: "Close Settings and Return to Chat"),
    .menuAbout: Entry(zh: "关于 {0}", en: "About {0}"),
    .menuSettings: Entry(zh: "设置…", en: "Settings…"),
    .menuHide: Entry(zh: "隐藏 {0}", en: "Hide {0}"),
    .menuHideOthers: Entry(zh: "隐藏其他", en: "Hide Others"),
    .menuShowAll: Entry(zh: "全部显示", en: "Show All"),
    .menuQuit: Entry(zh: "退出 {0}", en: "Quit {0}"),
    .menuFile: Entry(zh: "文件", en: "File"),
    .menuEdit: Entry(zh: "编辑", en: "Edit"),
    .menuUndo: Entry(zh: "撤销", en: "Undo"),
    .menuRedo: Entry(zh: "重做", en: "Redo"),
    .menuCut: Entry(zh: "剪切", en: "Cut"),
    .menuCopy: Entry(zh: "复制", en: "Copy"),
    .menuPaste: Entry(zh: "粘贴", en: "Paste"),
    .menuSelectAll: Entry(zh: "全选", en: "Select All"),

    // General 页头
    .generalTitle: Entry(zh: "通用设置", en: "General Settings"),
    .generalSubtitle: Entry(
      zh: "管理新会话默认行为、界面语言与外观设置。",
      en: "Manage defaults for new sessions, interface language, and appearance."),

    // 分组 1：默认预设
    .groupDefaultPresetTitle: Entry(zh: "默认预设", en: "Default Preset"),
    .groupDefaultPresetSubtitle: Entry(
      zh: "为新建会话选择默认预设。运行中的会话不会受影响。",
      en: "Choose the default preset for new sessions. Running sessions are not affected."),

    // 分组 2：默认权限
    .groupDefaultPermissionTitle: Entry(zh: "默认权限", en: "Default Permission"),
    .groupDefaultPermissionSubtitle: Entry(
      zh: "设置新会话默认使用的权限级别。仅影响新会话。",
      en: "Set the default permission level for new sessions. Applies to new sessions only."),
    .permissionFullAccess: Entry(zh: "完全访问", en: "Full Access"),
    .permissionWorkspaceAccess: Entry(zh: "工作区访问", en: "Workspace Access"),
    .permissionReadOnly: Entry(zh: "只读", en: "Read Only"),
    .permissionRestricted: Entry(zh: "受限", en: "Restricted"),
    .permissionUnavailable: Entry(zh: "不可用", en: "Unavailable"),

    // 分组 3：界面语言
    .groupInterfaceLanguageTitle: Entry(zh: "界面语言", en: "Interface Language"),
    .groupInterfaceLanguageSubtitle: Entry(
      zh: "选择应用界面的显示语言。更改后立即生效。",
      en: "Choose the display language for the app interface. Changes apply immediately."),
    .languageSimplifiedChinese: Entry(zh: "简体中文", en: "Simplified Chinese"),
    .languageEnglish: Entry(zh: "English", en: "English"),
    .settingsLanguageUnavailable: Entry(
      zh: "本机服务没有提供可写的语言设置",
      en: "The local service does not provide writable language settings"),

    // 分组 4：外观
    .groupAppearanceTitle: Entry(zh: "外观", en: "Appearance"),
    .groupAppearanceSubtitle: Entry(
      zh: "选择应用外观。支持浅色、深色和跟随系统。",
      en: "Choose how the app looks. Supports Light, Dark, and System."),
    .appearanceLight: Entry(zh: "浅色", en: "Light"),
    .appearanceDark: Entry(zh: "深色", en: "Dark"),
    .appearanceSystem: Entry(zh: "跟随系统", en: "System"),

    // 分组 5：回车键行为
    .groupEnterKeyTitle: Entry(zh: "回车键行为", en: "Enter Key Behavior"),
    .groupEnterKeySubtitle: Entry(
      zh: "选择智能体运行时按下回车键的默认动作；空闲时回车始终发送。",
      en: "Choose the default Enter action while the agent is running; when idle, Enter always sends."),
    .enterSendMessage: Entry(zh: "发送消息", en: "Send Message"),
    .enterInsertNewline: Entry(zh: "插入换行", en: "Insert New Line"),
    .enterQueueSend: Entry(zh: "排队发送", en: "Queue Send"),
    .enterInterjectNow: Entry(zh: "立即插话", en: "Interject Now"),

    .groupChatDisplayTitle: Entry(zh: "会话流显示", en: "Conversation Display"),
    .groupChatDisplaySubtitle: Entry(
      zh: "调整会话正文大小、宽度和已完成回答的流程折叠方式。",
      en: "Adjust conversation text size, width, and completed-answer process folding."),

    // 分组 6：运行边界
    .groupRuntimeBoundaryTitle: Entry(zh: "运行边界", en: "Runtime Boundary"),
    .runtimeInterface: Entry(zh: "界面", en: "Interface"),
    .runtimeBackend: Entry(zh: "后端", en: "Backend"),
    .runtimeInterfaceValue: Entry(zh: "原生 macOS", en: "Native macOS"),
    .runtimeBackendValue: Entry(zh: "本机 API-only", en: "Local API-only"),
    .runtimeSafetyTitle: Entry(zh: "安全说明", en: "Safety Notice"),
    .runtimeSafetyDetail: Entry(
      zh: "DeepSeek Harness 尚未接受独立安全审计。沙箱、审批与权限控制只能降低风险，不能保证完全隔离。请仅运行受信任的工作区，并在使用前复核高风险权限。",
      en: "DeepSeek Harness has not undergone an independent security audit. Sandboxing, approvals, and permission controls reduce risk but do not guarantee complete isolation. Run only trusted workspaces and review high-risk access before use."),

    // 轨迹详情面板
    .tabOverview: Entry(zh: "概览", en: "Overview"),
    .tabInput: Entry(zh: "输入", en: "Input"),
    .tabOutput: Entry(zh: "输出", en: "Output"),
    .tabRawJSON: Entry(zh: "原始 JSON", en: "Raw JSON"),
    .fieldState: Entry(zh: "状态", en: "State"),
    .fieldSequence: Entry(zh: "序列范围", en: "Sequence"),
    .fieldStarted: Entry(zh: "开始时间", en: "Started"),
    .fieldDuration: Entry(zh: "持续时间", en: "Duration"),
    .fieldThisRequest: Entry(zh: "本次请求", en: "This Request"),
    .fieldInput: Entry(zh: "输入", en: "Input"),
    .fieldCached: Entry(zh: "缓存", en: "Cached"),
    .fieldCacheCreated: Entry(zh: "缓存写入", en: "Cache created"),
    .fieldOutput: Entry(zh: "输出", en: "Output"),
    .fieldReasoning: Entry(zh: "推理", en: "Reasoning"),
    .fieldProvider: Entry(zh: "提供商", en: "Provider"),
    .fieldModel: Entry(zh: "模型", en: "Model"),
    .fieldRetry: Entry(zh: "重试", en: "Retry"),
    .fieldCompaction: Entry(zh: "压缩", en: "Compaction"),
    .trajectoryRunning: Entry(zh: "运行中", en: "Running"),
    .trajectoryCompleted: Entry(zh: "已完成", en: "Completed"),
    .trajectoryError: Entry(zh: "错误", en: "Error"),
    .trajectoryPending: Entry(zh: "等待中", en: "Pending"),
    .copyJSON: Entry(zh: "复制 JSON", en: "Copy JSON"),
    .copiedJSON: Entry(zh: "已复制", en: "Copied"),
    .closeDetail: Entry(zh: "关闭详情", en: "Close Details"),
    .trajectoryInputSummary: Entry(zh: "输入摘要", en: "Input Summary"),
    .trajectoryOutputSummary: Entry(zh: "输出摘要", en: "Output Summary"),
    .trajectoryInputMissing: Entry(zh: "输入未记录", en: "Input not recorded"),
    .trajectoryOutputMissing: Entry(zh: "输出未记录", en: "Output not recorded"),
    .trajectoryKindSystem: Entry(zh: "系统", en: "SYSTEM"),
    .trajectoryKindUser: Entry(zh: "用户", en: "USER"),
    .trajectoryKindContext: Entry(zh: "上下文", en: "CONTEXT"),
    .trajectoryKindAssistant: Entry(zh: "助手", en: "ASSISTANT"),
    .trajectoryKindTool: Entry(zh: "工具", en: "TOOL"),
    .trajectoryKindSubtool: Entry(zh: "子工具", en: "SUBTOOL"),
    .trajectoryKindCompacted: Entry(zh: "已压缩", en: "COMPACTED"),
    .trajectoryViewLabel: Entry(zh: "轨迹视图", en: "Trajectory View"),
    .trajectoryTimeline: Entry(zh: "时间线", en: "Timeline"),
    .trajectoryTable: Entry(zh: "表格", en: "Table"),
    .trajectoryDurationMode: Entry(zh: "耗时", en: "Duration"),
    .trajectoryUseEqualEvents: Entry(zh: "使用等宽事件", en: "Use Equal-Width Events"),
    .trajectoryUseActualDuration: Entry(zh: "使用真实耗时", en: "Use Actual Duration"),
    .trajectoryTurns: Entry(zh: "轮次", en: "Turns"),
    .trajectoryCalls: Entry(zh: "调用", en: "Calls"),
    .trajectorySearchPlaceholder: Entry(zh: "搜索轨迹", en: "Search Trajectory"),
    .trajectoryShowAll: Entry(zh: "显示全部", en: "Show All"),
    .trajectoryTypeCount: Entry(zh: "类型 {0}/{1}", en: "Types {0}/{1}"),
    .trajectoryLoadOlderHistory: Entry(zh: "加载更早历史", en: "Load Earlier History"),
    .trajectoryLoadingOlder: Entry(zh: "正在加载更早轨迹…", en: "Loading Earlier Trajectory…"),
    .trajectoryLoadOlder: Entry(zh: "加载更早轨迹", en: "Load Earlier Trajectory"),
    .trajectoryEmpty: Entry(zh: "当前会话还没有轨迹记录", en: "This chat has no trajectory records yet"),
    .trajectoryNoMatches: Entry(zh: "没有匹配的轨迹记录", en: "No matching trajectory records"),
    .trajectoryColumnEvent: Entry(zh: "事件", en: "Event"),
    .trajectoryColumnContent: Entry(zh: "内容", en: "Content"),
    .trajectoryCollapsedSession: Entry(zh: "折叠的会话记录", en: "Collapsed Session Records"),
    .trajectoryRecordsAndCalls: Entry(zh: "{0} 条记录 · {1} 次调用", en: "{0} records · {1} calls"),
    .trajectoryCollapsedCalls: Entry(zh: "{0} 次工具调用已折叠", en: "{0} tool calls collapsed"),
    .trajectoryTurnWithSummary: Entry(zh: "轮次 {0} · {1}", en: "Turn {0} · {1}"),
    .trajectoryBetweenTurns: Entry(zh: "轮次之间", en: "Between Turns"),
    .trajectoryTurn: Entry(zh: "轮次 {0}", en: "Turn {0}"),
    .trajectoryStep: Entry(zh: "步骤 {0}", en: "Step {0}"),
    .trajectoryMessage: Entry(zh: "消息", en: "Message"),
    .trajectorySession: Entry(zh: "会话", en: "Session"),
    .trajectoryTurnStep: Entry(zh: "轮次 {0} · 步骤 {1}", en: "Turn {0} · Step {1}"),
    .trajectoryTurnMessage: Entry(zh: "轮次 {0} · 消息", en: "Turn {0} · Message"),
    .trajectoryExpandCalls: Entry(zh: "展开工具调用", en: "Expand Tool Calls"),
    .trajectoryCollapseCalls: Entry(zh: "折叠工具调用", en: "Collapse Tool Calls"),
    .trajectorySelected: Entry(zh: "已选择", en: "Selected"),
    .trajectoryMaxRetry: Entry(zh: "最多重试 {0}", en: "Max retry {0}"),
    .trajectoryDelay: Entry(zh: "延迟 {0}", en: "Delay {0}"),
    .trajectoryImages: Entry(zh: "图片 {0} 张", en: "{0} trajectory image(s)"),

    // 主导航 / 侧边栏 / 会话日志
    .navChat: Entry(zh: "对话", en: "Chat"),
    .brandTitle: Entry(zh: "九章天幕", en: "Ark"),
    .flatSessions: Entry(zh: "平铺对话", en: "Flat Sessions"),
    .recentFirst: Entry(zh: "最近更新优先", en: "Recent First"),
    .sessionSort: Entry(zh: "会话排序", en: "Sort Sessions"),
    .searchResults: Entry(zh: "搜索结果", en: "Search Results"),
    .searching: Entry(zh: "正在搜索…", en: "Searching…"),
    .noMatchingSessions: Entry(zh: "没有匹配的会话", en: "No matching sessions"),
    .searchSessions: Entry(zh: "搜索会话", en: "Search Sessions"),
    .expandSidebar: Entry(zh: "展开侧边栏", en: "Expand Sidebar"),
    .collapseWorkspace: Entry(zh: "折叠工作区", en: "Collapse Workspace"),
    .expandWorkspace: Entry(zh: "展开工作区", en: "Expand Workspace"),
    .renameSession: Entry(zh: "重命名", en: "Rename"),
    .forkSession: Entry(zh: "分叉会话", en: "Fork Chat"),
    .archiveSession: Entry(zh: "归档", en: "Archive"),
    .renameWorkspace: Entry(zh: "重命名工作区", en: "Rename Workspace"),
    .removeWorkspace: Entry(zh: "移除工作区注册", en: "Remove Workspace Registration"),
    .showLess: Entry(zh: "收起", en: "Show Less"),
    .showMoreCount: Entry(zh: "显示更多（{0}）", en: "Show More ({0})"),
    .renameSessionTitle: Entry(zh: "重命名会话", en: "Rename Chat"),
    .renameWorkspaceTitle: Entry(zh: "重命名工作区", en: "Rename Workspace"),
    .sessionTitleField: Entry(zh: "会话标题", en: "Chat Title"),
    .workspaceNameField: Entry(zh: "工作区名称", en: "Workspace Name"),
    .commonCancel: Entry(zh: "取消", en: "Cancel"),
    .commonSave: Entry(zh: "保存", en: "Save"),
    .removeWorkspaceConfirm: Entry(
      zh: "移除工作区注册？目录和文件不会被删除。",
      en: "Remove this workspace registration? Its folder and files will not be deleted."),
    .removeRegistration: Entry(zh: "移除注册", en: "Remove Registration"),
    .removeWorkspaceDataTitle: Entry(zh: "移除工作区及 Ark 记录？", en: "Remove Workspace and Ark Records?"),
    .removeWorkspaceDataDetail: Entry(
      zh: "将永久删除此工作区的会话记录（包括归档）并注销对应知识项目。目录“{0}”及其中的文件会保留，重新添加时可继续使用。",
      en: "This permanently deletes this workspace's chat records, including archived chats, and unregisters its knowledge project. The folder “{0}” and its files remain available for re-adding."),
    .removeWorkspaceDataAction: Entry(zh: "移除并清理记录", en: "Remove and Delete Records"),
    .workspaceDeleteRunning: Entry(
      zh: "工作区仍有运行中的会话，请先停止后再删除。",
      en: "This workspace still has a running chat. Stop it before deleting the workspace."),
    .toastWorkspaceRecordsRemoved: Entry(
      zh: "工作区、会话与知识项目注册已清理",
      en: "Workspace, chat records, and knowledge-project registration removed"),
    .dropImagesHere: Entry(zh: "松开以添加图片", en: "Release to add images"),
    .pluginsConfiguration: Entry(zh: "扩展配置", en: "Extension Configuration"),
    .pluginsInventory: Entry(zh: "扩展列表", en: "Extension Inventory"),
    .extensionsTitle: Entry(zh: "扩展能力", en: "Extensions"),
    .extensionsSubtitle: Entry(
      zh: "配置和查看本部署已安装的扩展。",
      en: "Configure and inspect the extensions installed in this deployment."),
    .extensionsRefresh: Entry(zh: "刷新扩展清单", en: "Refresh Extensions"),
    .extensionsSearchPlaceholder: Entry(zh: "搜索扩展条目", en: "Search Extensions"),
    .extensionsEntriesCount: Entry(zh: "{0} 个条目", en: "{0} entries"),
    .extensionsEnabledCount: Entry(zh: "{0} 个配置启用", en: "{0} enabled"),
    .extensionsActiveCount: Entry(zh: "{0} 个运行中", en: "{0} active"),
    .extensionsLoading: Entry(zh: "正在读取扩展清单…", en: "Loading extensions…"),
    .extensionsEmptyTitle: Entry(zh: "没有扩展条目", en: "No Extensions"),
    .extensionsNoMatchesTitle: Entry(zh: "没有匹配的扩展", en: "No Matching Extensions"),
    .extensionsEmptyDetail: Entry(zh: "当前没有可用的扩展条目。", en: "No extensions are currently available."),
    .extensionsNoMatchesDetail: Entry(zh: "请尝试其他搜索关键词。", en: "Try another search term."),
    .extensionsConfigEmptyTitle: Entry(zh: "没有可配置扩展", en: "No Configurable Extensions"),
    .extensionsConfigEmptyDetail: Entry(
      zh: "当前没有公布终端、智能体循环或网页搜索设置。",
      en: "No Terminal, Agent Loop, or Web Search settings are currently available."),
    .extensionUnsaved: Entry(zh: "未保存", en: "Unsaved"),
    .extensionOverridden: Entry(zh: "已覆盖", en: "Overridden"),
    .extensionPositiveNumber: Entry(zh: "请输入大于 0 的数字", en: "Enter a number greater than 0"),
    .extensionAppliesLive: Entry(zh: "保存后立即生效。", en: "Changes apply immediately after saving."),
    .extensionAppliesRestart: Entry(zh: "保存后需重新启动才会生效。", en: "Restart Ark after saving to apply changes."),
    .extensionEditConfiguration: Entry(zh: "编辑配置", en: "Edit Configuration"),
    .extensionDefaultsOverridden: Entry(zh: "已覆盖默认设置", en: "Default settings overridden"),
    .extensionDefaultsUsed: Entry(zh: "使用默认设置", en: "Using default settings"),
    .extensionRestoreDefault: Entry(zh: "恢复默认", en: "Restore Defaults"),
    .extensionDiscardChanges: Entry(zh: "放弃修改", en: "Discard Changes"),
    .extensionAPIKey: Entry(zh: "API 密钥", en: "API Key"),
    .extensionKeepSecret: Entry(zh: "留空保持现有密钥", en: "Leave blank to keep the current key"),
    .extensionEnterSecret: Entry(zh: "输入 API 密钥", en: "Enter API Key"),
    .extensionInvalidAPIKey: Entry(zh: "API 密钥格式无效，请重新粘贴。", en: "The API key format is invalid. Paste it again."),
    .extensionDefaultBaseURL: Entry(zh: "留空使用提供方默认地址", en: "Leave blank to use the provider default URL"),
    .extensionPhaseDisabled: Entry(zh: "未启用", en: "Disabled"),
    .extensionPhasePending: Entry(zh: "等待中", en: "Pending"),
    .extensionPhaseLoading: Entry(zh: "加载中", en: "Loading"),
    .extensionPhaseActive: Entry(zh: "运行中", en: "Active"),
    .extensionPhaseFailed: Entry(zh: "失败", en: "Failed"),
    .extensionPhaseUnloading: Entry(zh: "卸载中", en: "Unloading"),
    .extensionPhaseUnknown: Entry(zh: "未观测", en: "Unknown"),
    .extensionEnabled: Entry(zh: "已启用", en: "Enabled"),
    .extensionDisabled: Entry(zh: "已禁用", en: "Disabled"),
    .extensionCollapseDetails: Entry(zh: "收起详情", en: "Collapse Details"),
    .extensionExpandDetails: Entry(zh: "展开详情", en: "Expand Details"),
    .extensionEntryID: Entry(zh: "扩展条目标识", en: "Extension Entry ID"),
    .extensionConfigurationLabel: Entry(zh: "配置", en: "Configuration"),
    .extensionCoreCapability: Entry(zh: "核心扩展", en: "Core Extension"),
    .interactionDecisionRequired: Entry(zh: "需要你决策", en: "Decision required"),
    .approvalWaiting: Entry(zh: "等待批准", en: "Waiting for approval"),
    .approvalEscalation: Entry(zh: "{0} 请求临时许可", en: "{0} requests temporary permission"),
    .approvalReject: Entry(zh: "拒绝", en: "Reject"),
    .approvalAllowOnce: Entry(zh: "仅允许本次", en: "Allow once"),
    .questionCustomAnswer: Entry(zh: "自定义回答（可选）", en: "Custom answer (optional)"),
    .questionCancel: Entry(zh: "取消问题", en: "Cancel questions"),
    .questionPrevious: Entry(zh: "上一步", en: "Previous"),
    .questionSkip: Entry(zh: "跳过", en: "Skip"),
    .questionNext: Entry(zh: "下一步", en: "Next"),
    .questionSubmit: Entry(zh: "提交回答", en: "Submit answers"),
    .planReviewHeader: Entry(zh: "计划待审阅", en: "Plan ready for review"),
    .planReviewDiscuss: Entry(zh: "继续讨论", en: "Discuss"),
    .planReviewDecline: Entry(zh: "继续规划", en: "Keep planning"),
    .planReviewApprove: Entry(zh: "批准计划", en: "Approve plan"),
    .goalPhaseActive: Entry(zh: "目标进行中", en: "Goal active"),
    .goalPhasePaused: Entry(zh: "目标已暂停", en: "Goal paused"),
    .goalPhaseBlocked: Entry(zh: "目标受阻", en: "Goal blocked"),
    .goalRounds: Entry(zh: "{0}/{1} 轮", en: "{0}/{1} rounds"),
    .goalPause: Entry(zh: "暂停目标", en: "Pause goal"),
    .goalResume: Entry(zh: "恢复目标", en: "Resume goal"),
    .goalEdit: Entry(zh: "编辑目标", en: "Edit goal"),
    .goalClear: Entry(zh: "清除目标", en: "Clear goal"),
    .goalSave: Entry(zh: "保存目标", en: "Save goal"),
    .goalCancel: Entry(zh: "取消编辑", en: "Cancel editing"),
    .goalObjective: Entry(zh: "目标内容", en: "Goal objective"),
    .goalUnavailable: Entry(zh: "当前没有可修改的目标", en: "There is no current goal to change"),
    .workflowRun: Entry(zh: "工作流 · {0}", en: "Workflow · {0}"),
    .workflowPhaseUnassigned: Entry(zh: "未分阶段", en: "Unassigned"),
    .workflowMembers: Entry(zh: "{0} 个成员", en: "{0} members"),
    .workflowOpenSession: Entry(zh: "打开子会话", en: "Open child session"),
    .workflowMoreMembers: Entry(zh: "还有 {0} 个成员", en: "{0} more members"),
    .workflowCollapse: Entry(zh: "折叠工作流", en: "Collapse workflow"),
    .workflowExpand: Entry(zh: "展开工作流", en: "Expand workflow"),
    .executionRunning: Entry(zh: "运行中", en: "Running"),
    .executionCompleted: Entry(zh: "完成", en: "Completed"),
    .executionFailed: Entry(zh: "失败", en: "Failed"),
    .executionCancelled: Entry(zh: "已中断", en: "Cancelled"),
    .executionCollapseSteps: Entry(zh: "折叠执行步骤", en: "Collapse execution steps"),
    .executionExpandSteps: Entry(zh: "展开执行步骤", en: "Expand execution steps"),
    .executionMoreSteps: Entry(zh: "还有 {0} 个步骤", en: "{0} more steps"),
    .imageLoading: Entry(zh: "图片加载中…", en: "Loading image…"),
    .imageLoadCancelled: Entry(zh: "图片加载已取消", en: "Image loading cancelled"),
    .imageLoadFailed: Entry(zh: "图片加载失败", en: "Image failed to load"),
    .imageRetry: Entry(zh: "重试", en: "Retry"),
    .imageCancelLoading: Entry(zh: "取消加载", en: "Cancel loading"),
    .imageOpenOriginal: Entry(zh: "查看大图", en: "Open image"),
    .imageClosePreview: Entry(zh: "关闭", en: "Close"),
    .toastCustomProviderSaved: Entry(zh: "自定义 Provider 已保存", en: "Custom provider saved"),
    .toastPresetCopied: Entry(zh: "Agent 预设已复制", en: "Preset copied"),
    .toastPresetDeleted: Entry(zh: "Agent 预设已删除", en: "Preset deleted"),
    .toastSessionRenamed: Entry(zh: "会话已重命名", en: "Session renamed"),
    .toastSessionArchived: Entry(zh: "会话已归档；日志仍保留在本机", en: "Session archived; logs remain on this machine"),
    .toastSessionRestored: Entry(zh: "对话已恢复到原工作区", en: "Conversation restored to its workspace"),
    .toastSessionDeletedPermanently: Entry(zh: "已永久删除本机对话日志", en: "Local conversation logs permanently deleted"),
    .toastSessionForked: Entry(zh: "已创建分叉会话", en: "Forked session created"),
    .toastStopRequested: Entry(zh: "已请求停止当前回复", en: "Stop requested for the current reply"),
    .toastWorkspaceAdded: Entry(zh: "工作区已添加", en: "Workspace added"),
    .toastWorkspaceRenamed: Entry(zh: "工作区已重命名", en: "Workspace renamed"),
    .toastWorkspaceRemoved: Entry(zh: "工作区注册已移除；本地文件未删除", en: "Workspace registration removed; local files untouched"),
    .toastAllowedOnce: Entry(zh: "已允许本次操作", en: "This action was allowed"),
    .toastDeniedOnce: Entry(zh: "已拒绝本次操作", en: "This action was denied"),
    .toastAnswerSubmitted: Entry(zh: "回答已提交", en: "Answer submitted"),
    .toastQuestionCancelled: Entry(zh: "问题已取消", en: "Question cancelled"),
    .toastKnowledgeProjectCreated: Entry(zh: "知识项目已创建", en: "Knowledge project created"),
    .toastKnowledgeProjectRemoved: Entry(zh: "知识项目注册已移除；本地文件未删除", en: "Knowledge-project registration removed; local files untouched"),
    .toastKnowledgePageCreated: Entry(zh: "知识页面已创建", en: "Knowledge page created"),
    .toastReviewProcessed: Entry(zh: "Review 已处理", en: "Review processed"),
    .toastReviewsProcessed: Entry(zh: "已批量处理 {0} 条 Review", en: "Processed {0} reviews"),
    .archiveEmpty: Entry(zh: "没有已归档对话", en: "No archived conversations"),
    .archiveDeletePermanently: Entry(zh: "永久删除本机对话日志", en: "Permanently delete local conversation logs"),
    .archiveCancel: Entry(zh: "取消", en: "Cancel"),
    .archiveDeleteWarningShort: Entry(
      zh: "删除后无法恢复该对话、分叉、子会话、消息和工具历史。仍在运行或被占用时 Ark 会拒绝删除。",
      en: "The conversation, its forks, sub-sessions, messages, and tool history cannot be recovered after deletion. Ark refuses deletion while running or in use."),
    .archiveRestoreHelp: Entry(zh: "恢复对话", en: "Restore conversation"),
    .archiveRestoreHint: Entry(
      zh: "恢复会把对话放回原工作区；永久删除会移除本机日志，无法撤销。",
      en: "Restoring returns the conversation to its workspace; permanent deletion removes local logs and cannot be undone."),
    .archiveDone: Entry(zh: "完成", en: "Done"),
    .archiveSearchPlaceholder: Entry(zh: "搜索已归档对话", en: "Search archived conversations"),
    .archiveHideHint: Entry(
      zh: "归档只会隐藏对话并保留本机日志。",
      en: "Archiving only hides the conversation and keeps local logs."),
    .archiveDeleteWarningLong: Entry(
      zh: "这不是移出归档。删除后 Ark 无法恢复该对话及其本机分叉或子会话、消息和工具历史；仍在运行或被占用时系统会拒绝删除。",
      en: "This does not unarchive. Ark cannot recover the conversation, its forks or sub-sessions, messages, and tool history after deletion; the system refuses deletion while running or in use."),
    .archiveRestore: Entry(zh: "恢复", en: "Restore"),
    .toastCredentialSavedSecure: Entry(zh: "{0} 凭据已保存到安全存储", en: "{0} credential saved to secure storage"),
    .toastSavedProvider: Entry(zh: "已保存 {0}", en: "Saved {0}"),
    .toastRemovedProvider: Entry(zh: "已移除 {0}", en: "Removed {0}"),
    .toastCredentialRemoved: Entry(zh: "{0} 凭据已移除", en: "{0} credential removed"),
    .toastPresetPath: Entry(zh: "预设目录：{0}", en: "Preset directory: {0}"),
    .toastSessionExported: Entry(zh: "会话日志已导出（{0} 字节）", en: "Session log exported ({0} bytes)"),
    .toastKnowledgeHits: Entry(zh: "找到 {0} 条知识结果", en: "Found {0} knowledge results"),
    .toastKnowledgeImported: Entry(zh: "已导入 {0} 个来源，知识队列将在后台处理", en: "Imported {0} sources; the knowledge queue will process them in the background"),
    .toastDeepResearchDone: Entry(zh: "深度研究完成，生成 {0} 条候选结果", en: "Deep research completed with {0} candidate results"),
    .navTrajectory: Entry(zh: "轨迹", en: "Trajectory"),
    .navWiki: Entry(zh: "万相织鉴", en: "Wanxiang"),
    .wikiSwitchWorkspaceHelp: Entry(zh: "切换万相织鉴知识工作区", en: "Switch Wanxiang knowledge workspace"),
    .wikiPagesCount: Entry(zh: "知识库页面（{0}）", en: "Knowledge Pages ({0})"),
    .wikiGraphTitle: Entry(zh: "知识图谱", en: "Knowledge Graph"),
    .wikiGraphCounts: Entry(zh: "{0} 节点 · {1} 连接", en: "{0} nodes · {1} connections"),
    .wikiInteractionHint: Entry(zh: "{0}% · 拖拽平移 · 滚轮缩放 · 点击节点查看", en: "{0}% · Drag to pan · Scroll to zoom · Click a node"),
    .wikiLayout: Entry(zh: "布局", en: "Layout"),
    .wikiLayoutType: Entry(zh: "类型", en: "Type"),
    .wikiLayoutCommunity: Entry(zh: "社区", en: "Community"),
    .wikiLegendConcept: Entry(zh: "概念", en: "Concept"),
    .wikiLegendMethod: Entry(zh: "方法", en: "Method"),
    .wikiLegendOverview: Entry(zh: "概览", en: "Overview"),
    .wikiLegendEvidence: Entry(zh: "证据", en: "Evidence"),
    .wikiLegendOther: Entry(zh: "其他", en: "Other"),
    .wikiInspector: Entry(zh: "检查器", en: "Inspector"),
    .wikiDetails: Entry(zh: "详情", en: "Details"),
    .wikiDeepResearch: Entry(zh: "深度研究", en: "Deep Research"),
    .wikiResearchPlaceholder: Entry(zh: "输入研究主题，如：LLM 记忆注入机制的最新实践", en: "Enter a research topic, such as recent practices for LLM memory injection"),
    .wikiStart: Entry(zh: "开始", en: "Start"),
    .wikiNewProject: Entry(zh: "+ 新建项目", en: "+ New Project"),
    .wikiSearchPlaceholder: Entry(
      zh: "搜索知识库（关键词 + 向量混合检索）…",
      en: "Search knowledge (keyword + vector hybrid)…"),
    .wikiSearch: Entry(zh: "搜索", en: "Search"),
    .wikiImport: Entry(zh: "+ 导入", en: "+ Import"),
    .wikiImportFiles: Entry(zh: "导入本地文件…", en: "Import Local Files…"),
    .wikiImportURL: Entry(zh: "从 URL 导入…", en: "Import from URL…"),
    .wikiImportURLTitle: Entry(zh: "导入网页知识", en: "Import Web Knowledge"),
    .wikiImportURLPlaceholder: Entry(zh: "https://example.com/article", en: "https://example.com/article"),
    .wikiImportURLInvalid: Entry(zh: "请输入有效的 http(s) URL", en: "Enter a valid http(s) URL"),
    .wikiNewPage: Entry(zh: "+ 新建页面", en: "+ New Page"),
    .wikiImportHelp: Entry(
      zh: "导入本地文件到当前项目的 raw/sources 并加入知识处理队列",
      en: "Import local files into this project's raw/sources folder and enqueue them for knowledge processing"),
    .wikiCreatePageTitle: Entry(zh: "新建知识页面", en: "New Knowledge Page"),
    .wikiPageTitlePlaceholder: Entry(zh: "页面标题", en: "Page Title"),
    .wikiCancel: Entry(zh: "取消", en: "Cancel"),
    .wikiCreate: Entry(zh: "创建", en: "Create"),
    .wikiCreateProjectTitle: Entry(zh: "新建知识项目", en: "New Knowledge Project"),
    .wikiProjectName: Entry(zh: "项目名称", en: "Project Name"),
    .wikiProjectDirectory: Entry(zh: "项目目录", en: "Project Directory"),
    .wikiProjectCreationDetail: Entry(
      zh: "Ark 会在这个目录中初始化 wiki、raw、purpose.md 与 schema.md；已有普通文件不会被删除。",
      en: "Ark will initialize wiki, raw, purpose.md, and schema.md in this folder. Existing regular files will not be deleted."),
    .wikiRemoveProject: Entry(zh: "移除知识项目", en: "Remove Knowledge Project"),
    .wikiRemoveProjectTitle: Entry(zh: "移除知识项目注册？", en: "Remove Knowledge Project Registration?"),
    .wikiRemoveProjectDetail: Entry(
      zh: "将从 Ark 中移除“{0}”的知识项目注册并取消尚未开始的摄取任务。目录“{1}”及其中的 Wiki、原始资料和普通文件都会保留。",
      en: "This removes the knowledge-project registration for “{0}” and cancels pending ingestion. The folder “{1}”, including its Wiki, source material, and regular files, remains untouched."),
    .wikiProjectManagedByWorkspace: Entry(
      zh: "此知识项目由工作区管理，请从左侧工作区菜单移除。",
      en: "This knowledge project is managed by a workspace. Remove it from the workspace menu."),
    .wikiProjectRemovalFailed: Entry(
      zh: "知识项目注册未能完整移除。",
      en: "The knowledge-project registration was not fully removed."),
    .wikiChooseProjectDirectory: Entry(zh: "选择项目目录", en: "Choose Project Directory"),
    .wikiChooseSources: Entry(zh: "导入知识来源", en: "Import Knowledge Sources"),
    .wikiResetGraph: Entry(zh: "重置图谱视图", en: "Reset Graph View"),
    .wikiReview: Entry(zh: "审查", en: "Review"),
    .wikiSave: Entry(zh: "保存", en: "Save"),
    .wikiEdit: Entry(zh: "编辑", en: "Edit"),
    .wikiResolved: Entry(zh: "已解决", en: "Resolved"),
    .wikiResolve: Entry(zh: "标记完成", en: "Mark Resolved"),
    .wikiBulkIgnore: Entry(zh: "全部忽略", en: "Ignore All"),
    .wikiBulkIgnoreConfirmTitle: Entry(zh: "忽略全部待审阅项？", en: "Ignore all pending reviews?"),
    .wikiBulkIgnoreConfirmDetail: Entry(
      zh: "这会在当前知识项目中批量标记 {0} 条 Review；知识页面文件不会被删除。",
      en: "This will resolve {0} reviews in the current knowledge project. Knowledge-page files will not be deleted."),
    .wikiBulkIgnoreConfirm: Entry(zh: "确认全部忽略", en: "Ignore All Reviews"),
    .wikiBulkReviewFailed: Entry(zh: "批量处理 Review 失败", en: "Bulk review operation failed"),
    .wikiQueueTitle: Entry(zh: "摄取队列", en: "Ingest Queue"),
    .wikiQueueProgress: Entry(zh: "{0}/{1}", en: "{0}/{1}"),
    .wikiQueueRunning: Entry(zh: "进行中", en: "Running"),
    .wikiQueueIdle: Entry(zh: "空闲", en: "Idle"),
    .wikiQueueRefresh: Entry(zh: "刷新队列", en: "Refresh Queue"),
    .wikiQueueCancelPending: Entry(zh: "取消待处理", en: "Cancel Pending"),
    .wikiQueueCancelBoundary: Entry(
      zh: "当前运行项会安全完成；只取消尚未开始的任务。",
      en: "The running task finishes safely; only tasks not yet started are cancelled."),
    .wikiQueuePending: Entry(zh: "等待中", en: "Pending"),
    .wikiQueueTaskRunning: Entry(zh: "处理中", en: "Processing"),
    .wikiQueueDone: Entry(zh: "完成", en: "Done"),
    .wikiQueueError: Entry(zh: "失败", en: "Failed"),
    .wikiQueueCancelled: Entry(zh: "已取消", en: "Cancelled"),
    .wikiSaved: Entry(zh: "已保存", en: "Saved"),
    .wikiUnsaved: Entry(zh: "未保存", en: "Unsaved"),
    .wikiReload: Entry(zh: "重新载入", en: "Reload"),
    .wikiDetailEmpty: Entry(
      zh: "点击图谱节点或左侧文件查看页面详情",
      en: "Select a graph node or a page on the left to view its details"),
    .toolDetailTitle: Entry(zh: "工具详情", en: "Tool Details"),
    .toolDetailEmpty: Entry(
      zh: "选择工具调用查看参数与结果",
      en: "Select a tool call to inspect its arguments and result"),
    .newConversation: Entry(zh: "新会话", en: "New Conversation"),
    .newConversationHeroTitle: Entry(zh: "所思即行  所创即见", en: "Think It  Bring It to Life"),
    .newConversationAddWorkspace: Entry(zh: "添加工作区", en: "Add Workspace"),
    .newConversationWorkspaceHelp: Entry(
      zh: "选择一个本地文件夹作为工作区",
      en: "Choose a local folder as the workspace"),
    .newConversationPresetUnavailable: Entry(zh: "智能体预设不可用", en: "Agent presets are unavailable"),
    .composerHeroPlaceholder: Entry(
      zh: "描述你想要构建的内容",
      en: "Describe what you want to build"),
    .composerPlaceholder: Entry(zh: "给智能体发消息", en: "Message the agent"),
    .composerCommands: Entry(zh: "命令", en: "Commands"),
    .composerCapabilityMenu: Entry(zh: "添加与能力", en: "Add and Capabilities"),
    .composerPlanCommand: Entry(zh: "计划模式", en: "Plan Mode"),
    .composerGoalCommand: Entry(zh: "目标", en: "Goal"),
    .composerCompactCommand: Entry(zh: "压缩上下文", en: "Compact Context"),
    .composerFeedbackCommand: Entry(zh: "反馈", en: "Feedback"),
    .composerPermissionCommand: Entry(zh: "权限", en: "Permission"),
    .composerFeedbackCommandDetail: Entry(zh: "发送有关此会话的反馈", en: "Record feedback about this session"),
    .composerPermissionCommandDetail: Entry(zh: "切换权限预设（沙盒模式 + 审批策略）", en: "Switch the permission preset (sandbox mode + approval policy)"),
    .composerPlanCommandDetail: Entry(zh: "切换 plan 模式", en: "Toggle plan mode"),
    .composerGoalCommandDetail: Entry(zh: "为长任务设定持续追求的目标", en: "Set or view the goal for a long-running task"),
    .composerCompactCommandDetail: Entry(zh: "压缩更早的会话历史", en: "Compact older conversation history"),
    .composerLauncherAddSection: Entry(zh: "添加", en: "Add"),
    .composerLauncherTasksSection: Entry(zh: "长任务与规划", en: "Long Tasks and Planning"),
    .composerLauncherPluginsSection: Entry(zh: "技能与插件", en: "Skills and Plugins"),
    .composerLauncherFiles: Entry(zh: "文件和文件夹", en: "Files and Folders"),
    .composerLauncherFilesDetail: Entry(
      zh: "引用当前工作区内的文件或目录",
      en: "Reference a file or folder in the current workspace"),
    .composerLauncherFilesSearch: Entry(zh: "搜索文件和文件夹", en: "Search files and folders"),
    .composerLauncherFilesEmpty: Entry(
      zh: "当前工作区没有可引用的文件或文件夹",
      en: "No referenceable files or folders are available in this workspace"),
    .composerLauncherSessions: Entry(zh: "引用 Ark 会话", en: "Reference an Ark Conversation"),
    .composerLauncherSessionsDetail: Entry(
      zh: "把其他会话作为当前任务的上下文",
      en: "Use another conversation as context for this task"),
    .composerLauncherSessionsSearch: Entry(zh: "搜索 Ark 会话", en: "Search Ark conversations"),
    .composerLauncherSessionsEmpty: Entry(
      zh: "没有可引用的其他 Ark 会话",
      en: "No other Ark conversations are available to reference"),
    .composerLauncherGoalDetail: Entry(
      zh: "设置需要持续推进并可暂停、恢复的长任务目标",
      en: "Set a long-running objective that can pause and resume"),
    .composerLauncherPlanDetail: Entry(
      zh: "先制定计划再执行，适合复杂或高风险任务",
      en: "Plan before execution for complex or high-risk work"),
    .composerLauncherCompactDetail: Entry(
      zh: "压缩较长会话，释放可用上下文",
      en: "Compact a long conversation to recover context capacity"),
    .composerSourcesNeedSession: Entry(
      zh: "发送首条消息后即可使用当前会话的命令、技能和引用",
      en: "Send the first message to use this session's commands, skills, and references"),
    .composerSourcesCatalogChanged: Entry(
      zh: "能力目录已经变化，请重新打开添加菜单",
      en: "The capability catalog changed. Reopen the add menu"),
    .composerSourcesLoading: Entry(zh: "正在加载候选…", en: "Loading suggestions…"),
    .composerSourcesNoMatches: Entry(zh: "没有匹配的候选", en: "No matching suggestions"),
    .composerSourceCommand: Entry(zh: "命令", en: "Command"),
    .composerSourceSkill: Entry(zh: "技能", en: "Skill"),
    .composerSourceUserOnly: Entry(zh: "仅限用户", en: "User only"),
    .composerSuggestionSelected: Entry(zh: "已选中", en: "Selected"),
    .composerSkillsGroup: Entry(zh: "技能", en: "Skills"),
    .composerSkillsCount: Entry(zh: "{0} 个可用技能", en: "{0} available skills"),
    .composerSkillFamilyCount: Entry(zh: "{0} 个技能", en: "{0} skills"),
    .composerOtherSkills: Entry(zh: "其他技能", en: "Other Skills"),
    .composerSourcesBack: Entry(zh: "返回添加与能力", en: "Back to add and capabilities"),
    .composerSourceFile: Entry(zh: "文件", en: "File"),
    .composerSourceFolder: Entry(zh: "文件夹", en: "Folder"),
    .composerSourceSession: Entry(zh: "会话", en: "Session"),
    .composerAttach: Entry(zh: "添加附件", en: "Add Attachment"),
    .composerPastedText: Entry(zh: "粘贴的文本", en: "Pasted text"),
    .composerDocumentBounded: Entry(
      zh: "{0} · {1} 字 · 按需引用",
      en: "{0} · {1} chars · bounded context"),
    .composerDocumentRemove: Entry(zh: "移除文档", en: "Remove document"),
    .composerNoModels: Entry(zh: "当前没有可用的模型目录", en: "No model catalog is currently available"),
    .composerModelUnavailable: Entry(zh: "当前模型不可用", en: "Current model unavailable"),
    .composerChooseAvailableModel: Entry(
      zh: "当前模型不可用，请先选择其他模型",
      en: "The current model is unavailable. Choose another model first"),
    .composerStop: Entry(zh: "停止当前回复", en: "Stop Current Response"),
    .composerSend: Entry(zh: "发送（⌘↩）", en: "Send (⌘↩)"),
    .relativeNow: Entry(zh: "刚刚", en: "now"),
    .relativeMinutes: Entry(zh: "{0}分钟", en: "{0}m"),
    .relativeHours: Entry(zh: "{0}小时", en: "{0}h"),
    .relativeDays: Entry(zh: "{0}天", en: "{0}d"),
    .relativeWeeks: Entry(zh: "{0}周", en: "{0}w"),
    .relativeMonths: Entry(zh: "{0}月", en: "{0}mo"),
    .statsTurnsSteps: Entry(zh: "{0} 轮 · {1} 步", en: "{0} turns · {1} steps"),
    .statsToolCalls: Entry(zh: "工具调用 {0}", en: "Tool calls {0}"),
    .statsFirstTokenAverage: Entry(zh: "首 token 平均 {0}", en: "Avg first token {0}"),
    .statsCacheHit: Entry(zh: "缓存命中 {0}%", en: "Cache hit {0}%"),
    .statsInputOutput: Entry(
      zh: "输入 {0} tok · 输出 {1} tok",
      en: "Input {0} tok · Output {1} tok"),
    .archiveTitle: Entry(zh: "对话归档", en: "Archive"),
    .collapseSidebar: Entry(zh: "收起侧边栏", en: "Collapse Sidebar"),
    .backToLatest: Entry(zh: "回到最新消息", en: "Back to Latest"),
    .sessionLog: Entry(zh: "会话日志", en: "Session Log"),
    .sessionExport: Entry(zh: "导出记录", en: "Export record"),
    .sessionExporting: Entry(zh: "正在导出会话记录…", en: "Exporting chat record…"),
    .sessionExportPreparing: Entry(
      zh: "正在预检查并下载包含子会话与附件的 ZIP。",
      en: "Preparing and downloading a ZIP containing child chats and attachments."),
    .sessionExportCancel: Entry(zh: "取消导出", en: "Cancel Export"),
    .sessionExportSucceeded: Entry(zh: "会话记录已导出", en: "Chat record exported"),
    .sessionExportBytes: Entry(
      zh: "已写入 {0} 字节；若目标已存在，已按保存面板确认安全替换。",
      en: "Wrote {0} bytes. If the destination existed, replacement was confirmed in the save panel."),
    .sessionExportDone: Entry(zh: "完成", en: "Done"),
    .sessionExportFailed: Entry(zh: "会话记录导出失败", en: "Chat record export failed"),
    .sessionExportClose: Entry(zh: "关闭", en: "Close"),
    .sessionActivityIdle: Entry(zh: "尚未运行任务", en: "No task has run yet"),
    .sessionActivityRunning: Entry(zh: "任务正常运行中", en: "Task is running"),
    .sessionActivityStopping: Entry(zh: "停止中", en: "Stopping"),
    .sessionActivityStopped: Entry(zh: "已停止", en: "Stopped"),
    .sessionActivityNeedsDecision: Entry(zh: "需要你决策或授权", en: "Decision or approval required"),
    .sessionActivityFailed: Entry(zh: "任务异常停止", en: "Task stopped unexpectedly"),
    .sessionActivityTitle: Entry(zh: "任务状态", en: "Task Status"),
    .pendingInteractionsCount: Entry(zh: "待处理 {0}", en: "{0} pending"),
    .messageCopy: Entry(zh: "复制", en: "Copy"),
    .messageCopied: Entry(zh: "已复制", en: "Copied"),
    .messageHelpful: Entry(zh: "有帮助", en: "Helpful"),
    .messageNeedsImprovement: Entry(zh: "需要改进", en: "Needs Improvement"),
    .messageFeedbackNote: Entry(zh: "补充说明", en: "Add Note"),
    .messageForkHere: Entry(zh: "从此分叉", en: "Fork from Here"),
    .messageForkUnavailable: Entry(
      zh: "仅可从已完成轮次的最后一条消息分支",
      en: "Only the final message of a completed turn can be forked"),
    .messageMetricDuration: Entry(zh: "用时 {0}", en: "Duration {0}"),
    .messageMetricFirstToken: Entry(zh: "首 token {0}", en: "First token {0}"),
    .chatDisplayTitle: Entry(zh: "会话显示", en: "Conversation Display"),
    .chatDisplayAdjust: Entry(zh: "调整会话显示", en: "Adjust Conversation Display"),
    .chatDisplayDetail: Entry(
      zh: "调整正文大小、宽度和已完成回答的流程折叠。",
      en: "Adjust body size, width, and process folding for completed answers."),
    .chatFontSize: Entry(zh: "正文大小", en: "Body Font Size"),
    .chatFontSizeValue: Entry(zh: "字号 {0}", en: "Font {0}"),
    .chatAdaptiveWidth: Entry(zh: "正文自适应宽度", en: "Adaptive Content Width"),
    .chatContentWidth: Entry(zh: "正文宽度", en: "Content Width"),
    .chatCompactProcess: Entry(zh: "紧凑流程", en: "Compact Process"),
    .chatReceivingReply: Entry(zh: "正在接收回复…", en: "Receiving reply…"),
    .chatSyncingHistory: Entry(zh: "正在同步会话历史…", en: "Syncing chat history…"),
    .chatHistoryEmpty: Entry(zh: "此会话没有可显示的消息", en: "This chat has no displayable messages"),
    .chatHistoryFailed: Entry(zh: "会话历史载入失败", en: "Chat history failed to load"),
    .chatHistoryRetry: Entry(zh: "重新载入", en: "Reload"),
    .chatLoadOlder: Entry(zh: "载入更早内容", en: "Load Earlier Content"),
    .chatLoadingOlder: Entry(zh: "正在载入…", en: "Loading…"),
    .chatSystemPrompt: Entry(zh: "系统提示词", en: "System Prompt"),
    .chatSystemPromptExpand: Entry(zh: "展开系统提示词", en: "Expand system prompt"),
    .chatSystemPromptCollapse: Entry(zh: "折叠系统提示词", en: "Collapse system prompt"),
    .chatUnknownContent: Entry(zh: "未知内容 · {0}", en: "Unknown content · {0}"),
    .chatTurnProcessToolCalls: Entry(zh: "工具调用 {0}", en: "Tool calls {0}"),
    .chatTurnProcessMessages: Entry(zh: "中间步骤 {0}", en: "Intermediate steps {0}"),
    .chatTurnProcessSubagents: Entry(zh: "子代理调用 {0}", en: "Subagent calls {0}"),
    .chatTurnProcessThought: Entry(zh: "思考了一段时间", en: "Thought for a while"),
    .chatTurnProcessSeparator: Entry(zh: " · ", en: " · "),
    .chatTurnProcessTitle: Entry(zh: "处理过程", en: "Process"),
    .chatTurnProcessShowMore: Entry(zh: "显示更多", en: "Show More"),
    .chatTurnProcessShowLess: Entry(zh: "收起", en: "Show Less"),
    .chatTurnProcessExpand: Entry(zh: "展开流程内容", en: "Expand process content"),
    .chatTurnProcessCollapse: Entry(zh: "折叠流程内容", en: "Collapse process content"),
    .chatTurnUsageTitle: Entry(zh: "Token 用量", en: "Token usage"),
    .chatTurnUsageCount: Entry(zh: "{0} tok", en: "{0} tok"),
    .chatTurnUsageSummary: Entry(zh: "{0} tok · 缓存命中 {1}%", en: "{0} tok · Cache hit {1}%"),
    .chatTurnUsageProviderModel: Entry(zh: "Provider / model", en: "Provider / model"),
    .chatTurnUsageInput: Entry(zh: "未缓存输入", en: "Uncached input"),
    .chatTurnUsageCacheRead: Entry(zh: "缓存读取", en: "Cached input"),
    .chatTurnUsageCacheWrite: Entry(zh: "缓存写入", en: "Cache write"),
    .chatTurnUsageOutput: Entry(zh: "输出", en: "Output"),
    .chatTurnUsageReasoning: Entry(zh: "推理", en: "reasoning"),
    .chatTurnUsageTotal: Entry(zh: "总计", en: "Total"),
    .chatTurnNavigationJump: Entry(zh: "跳转到轮次 {0}", en: "Jump to turn {0}"),
    .toolOpenInFiles: Entry(zh: "在文件中打开", en: "Open in Files"),
    .toolTodoTitle: Entry(zh: "任务清单", en: "Task List"),
    .toolQuestionFallback: Entry(zh: "需要确认", en: "Confirmation Required"),
    .toolTodoCounts: Entry(
      zh: "{0} 进行中 · {1} 待处理 · {2} 完成",
      en: "{0} running · {1} pending · {2} completed"),
    .toolDiffFiles: Entry(zh: "{0} 个文件", en: "{0} files"),
    .toolSearchResults: Entry(zh: "{0} 个结果", en: "{0} results"),
    .toolExitCode: Entry(zh: "退出 {0}", en: "Exit {0}"),
    .composerSubagentContinuable: Entry(zh: "可继续子代理", en: "Continuable subagent"),
    .composerSubagentReadOnly: Entry(zh: "只读子代理", en: "Read-only subagent"),
    .queueCount: Entry(zh: "{0} 条排队消息", en: "{0} queued messages"),
    .queuePendingNonText: Entry(zh: "待处理的非文本内容", en: "Pending non-text content"),
    .queuePendingMessage: Entry(zh: "待处理消息", en: "Pending message"),
    .queueEdit: Entry(zh: "编辑", en: "Edit"),
    .queueSteer: Entry(zh: "插话", en: "Steer"),
    .queueRemove: Entry(zh: "移除", en: "Remove"),
    .queueEditPlaceholder: Entry(zh: "编辑待发送消息", en: "Edit queued message"),
    .permissionDangerTitle: Entry(zh: "启用完全访问权限", en: "Enable Full Access"),
    .permissionDangerDetail: Entry(
      zh: "此模式允许当前会话访问和修改工作区之外的本机文件。只有在你明确需要并信任当前任务时才启用。",
      en: "This mode lets the current chat access and modify local files outside the workspace. Enable it only when explicitly needed and the task is trusted."),
    .permissionDangerAcknowledgement: Entry(
      zh: "我了解此权限会扩大文件访问范围",
      en: "I understand this expands file access"),
    .permissionDangerConfirm: Entry(zh: "确认启用", en: "Enable Full Access"),
    .stopSession: Entry(zh: "停止", en: "Stop"),
    .returnToParentSession: Entry(zh: "返回父会话", en: "Return to parent"),
    .subagentLineage: Entry(zh: "任务谱系", en: "Task Lineage"),
    .subagentLineageCount: Entry(zh: "{0} 个子任务", en: "{0} subtasks"),
    .subagentLineageRunningCount: Entry(zh: "{0} 个运行中", en: "{0} running"),
    .subagentLineageLoading: Entry(zh: "正在加载任务谱系…", en: "Loading task lineage…"),
    .subagentLineageLoadFailed: Entry(zh: "任务谱系刷新失败", en: "Task lineage refresh failed"),
    .subagentLineageRetry: Entry(zh: "重试", en: "Retry"),
    .subagentLineageRefresh: Entry(zh: "刷新任务谱系", en: "Refresh Task Lineage"),
    .subagentLineageOneShot: Entry(zh: "一次性 · 只读", en: "One-shot · Read only"),
    .subagentLineageContinuable: Entry(zh: "可继续", en: "Continuable"),
    .subagentLineageRunning: Entry(zh: "运行中", en: "Running"),
    .subagentLineageInactive: Entry(zh: "已停止", en: "Inactive"),
    .subagentLineageParentUnavailable: Entry(zh: "父任务不可用", en: "Parent unavailable"),
    .subagentLineageDiagnostic: Entry(zh: "诊断", en: "Diagnostic"),
    .subagentLineageExpand: Entry(zh: "展开 {0}", en: "Expand {0}"),
    .subagentLineageCollapse: Entry(zh: "收起 {0}", en: "Collapse {0}"),
    .subagentTranscriptTitle: Entry(zh: "子代理任务", en: "Subagent Task"),
    .subagentTranscriptOperations: Entry(zh: "{0} 个步骤", en: "{0} steps"),
    .subagentTranscriptCompleted: Entry(zh: "已完成", en: "Completed"),
    .subagentTranscriptFailed: Entry(zh: "失败", en: "Failed"),
    .subagentTranscriptCancelled: Entry(zh: "已停止", en: "Stopped"),
    .subagentTranscriptExpand: Entry(zh: "展开子代理步骤", en: "Expand subagent steps"),
    .subagentTranscriptCollapse: Entry(zh: "收起子代理步骤", en: "Collapse subagent steps"),
    .subagentModelSelectionTitle: Entry(zh: "子代理模型选择", en: "Subagent Model Selection"),
    .subagentModelSelectionDetail: Entry(
      zh: "开启后，已授权的子代理工具可在每个新会话中选择 Provider、模型和推理强度。",
      en: "When enabled, authorized subagent tools can choose a provider, model, and reasoning effort in each new session."),
    .subagentModelSelectionEnabled: Entry(zh: "允许子代理选择模型", en: "Allow subagents to choose models"),
    .subagentModelSelectionNoModels: Entry(zh: "暂无可授权的模型路由", en: "No model routes are available to authorize"),
    .subagentModelSelectionProvider: Entry(zh: "Provider", en: "Provider"),
    .subagentModelSelectionModel: Entry(zh: "模型", en: "Model"),
    .toastSubagentModelSelectionSaved: Entry(zh: "子代理模型授权范围已保存", en: "Subagent model authorization saved"),
    .producedFilesLabel: Entry(zh: "产出文件", en: "Produced files"),
    .producedFilesOpen: Entry(zh: "打开 {0}", en: "Open {0}"),
    .producedFilesMore: Entry(zh: "另有 {0} 个", en: "{0} more"),
    .contextUsedPercent: Entry(zh: "上下文已用 {0}%", en: "{0}% of context used"),
    .contextApproximate: Entry(zh: "约 {0} / {1}", en: "~{0} / {1}"),
    .contextSystemPrompt: Entry(zh: "系统提示词", en: "System prompt"),
    .contextTools: Entry(zh: "工具", en: "Tools"),
    .contextMessages: Entry(zh: "对话消息", en: "Messages"),
    .contextInjection: Entry(zh: "上下文注入", en: "Context injection"),
    .contextRecall: Entry(zh: "上下文召回", en: "Context recall"),
    .contextFormInstructions: Entry(zh: "指令", en: "Instructions"),
    .contextFormCatalog: Entry(zh: "目录", en: "Catalog"),
    .contextFormSnapshot: Entry(zh: "快照", en: "Snapshot"),
    .contextFormNotice: Entry(zh: "通知", en: "Notice"),
    .contextFormRelay: Entry(zh: "转交", en: "Relay"),
    .contextFormRecall: Entry(zh: "召回", en: "Recall"),
    .workbench: Entry(zh: "工作台", en: "Workbench"),
    .workbenchCollapse: Entry(zh: "收起工作台", en: "Collapse Workbench"),
    .workbenchOpen: Entry(zh: "打开工作台", en: "Open Workbench"),
    .workbenchResizePanel: Entry(zh: "调整右侧面板宽度", en: "Resize Right Panel"),
    .workbenchReview: Entry(zh: "审查", en: "Review"),
    .workbenchTerminal: Entry(zh: "终端", en: "Terminal"),
    .workbenchBrowser: Entry(zh: "浏览器", en: "Browser"),
    .workbenchFiles: Entry(zh: "文件", en: "Files"),
    .workbenchReviewFilter: Entry(zh: "筛选变更…", en: "Filter changes…"),
    .workbenchReviewNoChanges: Entry(zh: "没有可审查的变更", en: "No changes to review"),
    .workbenchReviewSelectChange: Entry(zh: "选择一个变更查看差异", en: "Select a change to view its diff"),
    .workbenchOpenFile: Entry(zh: "在文件中打开", en: "Open in Files"),
    .gitChanges: Entry(zh: "变更", en: "Changes"),
    .gitHistory: Entry(zh: "历史", en: "History"),
    .gitBranches: Entry(zh: "分支", en: "Branches"),
    .gitRepository: Entry(zh: "仓库", en: "Repository"),
    .gitCommits: Entry(zh: "提交", en: "Commits"),
    .gitChangedFiles: Entry(zh: "变更文件", en: "Changed Files"),
    .gitNoChangedFiles: Entry(zh: "这个提交没有文件变更", en: "No files changed in this commit"),
    .gitSelectChangedFile: Entry(zh: "选择变更文件查看差异", en: "Select a changed file to view its diff"),
    .gitExpandAllDiffs: Entry(zh: "展开全部差异", en: "Expand All Diffs"),
    .gitCollapseAllDiffs: Entry(zh: "收起全部差异", en: "Collapse All Diffs"),
    .gitAllTrackedChanges: Entry(zh: "全部已跟踪变更", en: "All Tracked Changes"),
    .gitTrackedChangesOnly: Entry(
      zh: "为保持响应速度，全部差异只显示已跟踪文件；未跟踪文件可从右侧单独查看。",
      en: "To stay responsive, All Diffs includes tracked files only; open untracked files individually from the right."),
    .gitCombinedDiff: Entry(zh: "全部", en: "Combined"),
    .gitWorkingDiff: Entry(zh: "未暂存", en: "Working"),
    .gitStagedDiff: Entry(zh: "已暂存", en: "Staged"),
    .gitStage: Entry(zh: "暂存", en: "Stage"),
    .gitUnstage: Entry(zh: "取消暂存", en: "Unstage"),
    .gitDiscard: Entry(zh: "放弃", en: "Discard"),
    .gitStageAll: Entry(zh: "全部暂存", en: "Stage All"),
    .gitUnstageAll: Entry(zh: "全部取消暂存", en: "Unstage All"),
    .gitCommitPlaceholder: Entry(zh: "提交说明", en: "Commit message"),
    .gitCommit: Entry(zh: "提交", en: "Commit"),
    .gitNewBranchPlaceholder: Entry(zh: "新分支名称", en: "New branch name"),
    .gitCreateBranch: Entry(zh: "创建并切换", en: "Create and Switch"),
    .gitCurrentBranch: Entry(zh: "当前", en: "Current"),
    .gitSwitchBranch: Entry(zh: "切换", en: "Switch"),
    .gitRepositoryRoot: Entry(zh: "本地仓库", en: "Local Repository"),
    .gitNotRepository: Entry(zh: "这个文件夹尚未初始化为 Git 仓库", en: "This folder is not a Git repository"),
    .gitNotRepositoryDetail: Entry(
      zh: "初始化只会在当前工作区创建 .git；Ark 不会自动添加远端或上传文件。",
      en: "Initialize creates .git only in this workspace; Ark will not add a remote or upload files automatically."),
    .gitInitializeRepository: Entry(zh: "初始化此文件夹", en: "Initialize This Folder"),
    .gitRepositoryTracking: Entry(zh: "远端跟踪", en: "Remote Tracking"),
    .gitCommitIdentity: Entry(zh: "提交身份", en: "Commit Identity"),
    .gitIdentityName: Entry(zh: "提交者名称", en: "Committer name"),
    .gitIdentityEmail: Entry(zh: "提交者邮箱", en: "Committer email"),
    .gitSaveIdentity: Entry(zh: "保存到此仓库", en: "Save for This Repository"),
    .gitRemoteConnections: Entry(zh: "远端连接", en: "Remote Connections"),
    .gitNoRemote: Entry(zh: "尚未连接远端 Git 仓库", en: "No remote Git repository connected"),
    .gitRemoteNamePlaceholder: Entry(zh: "远端名称，例如 origin", en: "Remote name, e.g. origin"),
    .gitRemoteURLPlaceholder: Entry(zh: "HTTPS 或 SSH 仓库地址", en: "HTTPS or SSH repository URL"),
    .gitConnectRemote: Entry(zh: "连接或更新", en: "Connect or Update"),
    .gitUseRemote: Entry(zh: "编辑", en: "Edit"),
    .gitCredentialsSystemManaged: Entry(
      zh: "凭据由 macOS 钥匙串或 SSH 管理；Ark 不保存密码和访问令牌。",
      en: "Credentials are managed by macOS Keychain or SSH; Ark never stores passwords or access tokens."),
    .gitDiscardTitle: Entry(zh: "放弃这个工作区变更？", en: "Discard this working change?"),
    .gitOperationFailed: Entry(zh: "Git 操作失败", en: "Git operation failed"),
    .workbenchNoTabs: Entry(zh: "点击 + 打开工作台工具", en: "Click + to open a Workbench tool"),
    .workbenchChooseRootTitle: Entry(zh: "选择工作区文件夹", en: "Choose a Workspace Folder"),
    .workbenchChooseRootDetail: Entry(
      zh: "工作台只打开你明确选择的本地目录，不会静默使用默认文件夹。",
      en: "Workbench opens only a local folder you explicitly choose; it never silently uses a default folder."),
    .workbenchChooseRoot: Entry(zh: "选择文件夹", en: "Choose Folder"),
    .workbenchSwitchWorkspaceTitle: Entry(
      zh: "切换工作台文件目录？",
      en: "Switch the Workbench Folder?"),
    .workbenchSwitchWorkspaceDetail: Entry(
      zh: "当前文件中有未保存修改。要从“{0}”切换到“{1}”，请先取消并保存，或明确放弃修改后切换。",
      en: "Files contains unsaved changes. To switch from “{0}” to “{1}”, cancel and save first, or explicitly discard the changes and switch."),
    .workbenchDiscardAndSwitch: Entry(zh: "放弃修改并切换", en: "Discard Changes and Switch"),
    .workbenchBrowserPlaceholder: Entry(zh: "输入网页地址", en: "Enter a web address"),
    .workbenchBrowserOpen: Entry(zh: "内部打开", en: "Open Here"),
    .workbenchBrowserOpenExternal: Entry(zh: "用系统浏览器打开", en: "Open in System Browser"),
    .workbenchBrowserDetail: Entry(
      zh: "通过安全 WebFetch 获取网页，并以原生 Markdown 在 Ark 内阅读；复杂交互可转到系统浏览器。",
      en: "Fetch pages through safe WebFetch and read them as native Markdown in Ark; use the system browser for interactive sites."),
    .workbenchBrowserLoading: Entry(zh: "正在获取并整理网页…", en: "Fetching and preparing the page…"),
    .workbenchBrowserUnavailable: Entry(
      zh: "本机服务尚未提供原生网页阅读能力。",
      en: "The local service does not provide native web reading."),
    .workbenchBrowserTruncated: Entry(zh: "内容已截断", en: "Content truncated"),
    .workbenchBrowserHTTPFailure: Entry(
      zh: "网页返回 HTTP {0}；以下内容可能是错误说明。",
      en: "The page returned HTTP {0}; the content below may be an error response."),
    .workbenchBrowserInvalid: Entry(
      zh: "请输入有效的 HTTP 或 HTTPS 地址。",
      en: "Enter a valid HTTP or HTTPS address."),
    .workbenchBrowserOpenFailed: Entry(
      zh: "无法使用默认浏览器打开该地址。",
      en: "The default browser could not open this address."),
    .newSession: Entry(zh: "新建会话", en: "New Session"),
    .workspaceSection: Entry(zh: "工作区", en: "Workspaces"),
    .ungroupedSection: Entry(zh: "未分组", en: "Ungrouped"),
    .backToWorkspace: Entry(zh: "返回工作区", en: "Back to Workspace"),
    .groupByWorkspace: Entry(zh: "按工作区分组", en: "Group by Workspace"),
    .manualWorkspaceOrder: Entry(zh: "工作区手动顺序", en: "Manual Workspace Order"),
    .addWorkspace: Entry(zh: "添加现有本地工作区", en: "Add Existing Local Workspace"),
    .newSessionInWorkspace: Entry(zh: "在此工作区新建会话", en: "New Session in This Workspace"),

    // Files 工作台
    .filesPathPlaceholder: Entry(
      zh: "输入文件路径（相对工作区或绝对路径），按 Enter 打开",
      en: "Enter a file path (relative to the workspace or absolute) and press Enter to open"),
    .filesOpen: Entry(zh: "打开", en: "Open"),
    .filesSearchPlaceholder: Entry(zh: "按文件名搜索…", en: "Search by file name…"),
    .filesRefresh: Entry(zh: "刷新文件树", en: "Refresh File Tree"),
    .filesShowTree: Entry(zh: "显示文件树", en: "Show File Tree"),
    .filesHideTree: Entry(zh: "隐藏文件树", en: "Hide File Tree"),
    .filesResizeTree: Entry(zh: "拖动调整文件树宽度", en: "Drag to Resize File Tree"),
    .filesActions: Entry(zh: "文件操作", en: "File Actions"),
    .filesNewFile: Entry(zh: "新建文件", en: "New File"),
    .filesNewFolder: Entry(zh: "新建文件夹", en: "New Folder"),
    .filesRename: Entry(zh: "重命名", en: "Rename"),
    .filesDuplicate: Entry(zh: "制作副本", en: "Duplicate"),
    .filesMove: Entry(zh: "移动到文件夹…", en: "Move to Folder…"),
    .filesTrash: Entry(zh: "移到废纸篓", en: "Move to Trash"),
    .filesShowHiddenNoise: Entry(zh: "显示系统隐藏文件", en: "Show System Hidden Files"),
    .filesHideHiddenNoise: Entry(zh: "隐藏系统隐藏文件", en: "Hide System Hidden Files"),
    .filesRecoveryTitle: Entry(zh: "恢复未保存的文件", en: "Recover Unsaved Files"),
    .filesRecoveryDetail: Entry(
      zh: "Ark 在上次异常退出前保存了本地编辑草稿。恢复只打开草稿，不会覆盖磁盘文件。",
      en: "Ark saved local editing drafts before the previous unexpected exit. Restore opens a draft without overwriting the file on disk."),
    .filesRecoveryLater: Entry(zh: "稍后处理", en: "Later"),
    .filesRecoveryCompare: Entry(zh: "比较", en: "Compare"),
    .filesRecoveryHideCompare: Entry(zh: "关闭比较", en: "Hide Comparison"),
    .filesRecoveryDiskVersion: Entry(zh: "上次保存版本", en: "Last Saved Version"),
    .filesRecoveryDraftVersion: Entry(zh: "恢复草稿", en: "Recovery Draft"),
    .filesRecoveryDiscard: Entry(zh: "丢弃草稿", en: "Discard Draft"),
    .filesRecoveryRestore: Entry(zh: "恢复到编辑器", en: "Restore in Editor"),
    .filesRecoveryEmpty: Entry(zh: "没有可恢复的草稿", en: "No recovery drafts"),
    .filesEmptyDir: Entry(zh: "目录为空", en: "Directory is empty"),
    .filesRootUnavailable: Entry(zh: "无法打开工作区", en: "Cannot Open Workspace"),
    .filesUnsaved: Entry(zh: "未保存", en: "Unsaved"),
    .filesRevert: Entry(zh: "还原", en: "Revert"),
    .filesSave: Entry(zh: "保存", en: "Save"),
    .filesExport: Entry(zh: "导出副本", en: "Export"),
    .filesUTF8Limit: Entry(
      zh: "支持 UTF-8 文本文件，单个文件最大 8 MiB。",
      en: "Supports UTF-8 text files up to 8 MiB per file."),
    .filesEmptyEditorTitle: Entry(zh: "打开文件", en: "Open File"),
    .filesEmptyEditorDetail: Entry(
      zh: "从工作区目录树中选择文件",
      en: "Choose a file from the workspace tree"),
    .filesRefreshFailed: Entry(zh: "刷新失败", en: "Refresh failed"),
    .filesNotExists: Entry(zh: "文件不存在", en: "File does not exist"),
    .filesSelectFile: Entry(zh: "请选择目录中的 UTF-8 文本文件", en: "Choose a UTF-8 text file in the directory"),
    .filesReadFailed: Entry(zh: "无法读取", en: "Cannot read"),
    .filesReverted: Entry(zh: "已还原未保存的更改", en: "Unsaved changes reverted"),
    .filesSaved: Entry(zh: "已原子保存", en: "Saved atomically"),
    .filesSaveFailed: Entry(zh: "保存失败", en: "Save failed"),
    .filesLoaded: Entry(zh: "已载入", en: "Loaded"),
    .filesOpenFailed: Entry(zh: "无法打开文件", en: "Cannot open file"),
    .filesCloseDirtyTitle: Entry(zh: "放弃未保存的更改？", en: "Discard Unsaved Changes?"),
    .filesCloseDirtyMessage: Entry(
      zh: "关闭此标签页将丢弃尚未保存的更改。",
      en: "Closing this tab will discard its unsaved changes."),
    .filesCloseDirtyWorkbenchMessage: Entry(
      zh: "关闭工作台将丢弃所有标签页中尚未保存的更改。",
      en: "Closing the workbench will discard unsaved changes in all open tabs."),
    .filesCloseTab: Entry(zh: "关闭标签页", en: "Close Tab"),
    .filesRevealInFinder: Entry(zh: "在访达中显示", en: "Reveal in Finder"),
    .filesDiscardAll: Entry(zh: "放弃全部更改", en: "Discard All Changes"),
    .filesCancel: Entry(zh: "取消", en: "Cancel"),
    .filesDiscard: Entry(zh: "放弃更改", en: "Discard Changes"),
    .filesCloseWorkbench: Entry(zh: "关闭工作台", en: "Close Workbench"),
    .filesOpenTab: Entry(zh: "打开工作台标签", en: "Open Workbench Tab"),
    .filesGitTitle: Entry(zh: "Git 审查", en: "Git Review"),
    .filesGitRefresh: Entry(zh: "刷新", en: "Refresh"),
    .filesGitLoading: Entry(zh: "正在读取 Git 状态…", en: "Reading Git status…"),
    .filesTerminalTitle: Entry(zh: "终端", en: "Terminal"),
    .filesTerminalStop: Entry(zh: "停止", en: "Stop"),
    .filesTerminalClear: Entry(zh: "清空", en: "Clear"),
    .filesTerminalCopy: Entry(zh: "复制", en: "Copy"),
    .filesTerminalPlaceholder: Entry(zh: "输入命令并按回车", en: "Enter a command and press Return"),
    .filesTerminalRunning: Entry(zh: "终端会话运行中", en: "Terminal session running"),
    .filesTerminalStopping: Entry(zh: "正在停止终端会话…", en: "Stopping terminal session…"),
    .filesTerminalScope: Entry(
      zh: "命令工作目录限制为当前工作区根目录",
      en: "Commands run with the working directory limited to the workspace root"),
    .filesTerminalStartFailed: Entry(zh: "终端启动失败", en: "Terminal failed to start"),
    .filesExportSucceeded: Entry(zh: "已导出副本到", en: "Exported a copy to"),
    .filesExportFailed: Entry(zh: "导出失败", en: "Export failed"),
    .filesGitStatusTitle: Entry(zh: "状态", en: "Status"),
    .filesGitWorkingDiffTitle: Entry(zh: "工作区差异", en: "Working Diff"),
    .filesGitStagedDiffTitle: Entry(zh: "暂存区差异", en: "Staged Diff"),
    .filesGitClean: Entry(zh: "工作区干净", en: "Working tree clean"),
    .filesNoWorkingDiff: Entry(zh: "无未暂存差异", en: "No unstaged changes"),
    .filesNoStagedDiff: Entry(zh: "无已暂存差异", en: "No staged changes"),
    .filesNoOutput: Entry(zh: "暂无输出", en: "No output"),
    .filesGitRefreshed: Entry(zh: "Git 状态已刷新", en: "Git status refreshed"),
    .filesGitRefreshFailed: Entry(zh: "Git 状态读取失败（退出码", en: "Git status failed (exit code"),
    .filesTerminalSignalTerminated: Entry(zh: "终端会话被信号终止", en: "Terminal session terminated by signal"),
    .filesTerminalEnded: Entry(zh: "终端会话已结束", en: "Terminal session ended"),
    .filesTerminalOutputTitle: Entry(zh: "输出", en: "Output"),

    // 通用
    .permissionSwitchedTo: Entry(zh: "权限已切换为", en: "Permission switched to"),

    // 内置预设（与 web 客户端 locales 的既有产品术语保持一致；
    // 中文统一使用“智能体 / 预设 / 技能”，PTC/DeepSeek/Code Mode SDK/bash/str_replace_editor 等专有名词保留）
    .presetStandardName: Entry(zh: "标准模式", en: "Standard mode"),
    .presetStandardDescription: Entry(
      zh: "功能完整的编码智能体，支持文件编辑、Shell、文件与网页检索、技能、计划、目标、子代理和工作流。",
      en: "Full coding agent with file editing, shell, file and web search, skills, planning, goals, subagents, and workflows."),
    .presetCodeName: Entry(zh: "PTC 模式", en: "PTC mode"),
    .presetCodeDescription: Entry(
      zh: "具备标准模式的全部能力，并通过 Code Mode SDK 呈现工具，让模型用一个 TypeScript 程序组合多步操作。",
      en: "All Standard mode capabilities, with tools exposed through the Code Mode SDK so the model can combine multi-step operations in one TypeScript program."),
    .presetMinimalName: Entry(zh: "极简模式", en: "Minimal mode"),
    .presetMinimalDescription: Entry(
      zh: "仅提供持久 bash 与 str_replace_editor 的双工具编码智能体。",
      en: "Two-tool coding agent with persistent bash and str_replace_editor."),
    .presetCordisName: Entry(zh: "创造模式", en: "Creator mode"),
    .presetCordisDescription: Entry(
      zh: "用于创建自定义智能体预设：具备标准模式的全部能力，并提供运行时检查、插件实验和预设创作指导。",
      en: "Built for creating custom agent presets, with all Standard mode capabilities plus runtime inspection, plugin experiments, and preset-authoring guidance."),
    .presetPageTitle: Entry(zh: "智能体预设", en: "Agent Presets"),
    .presetPageSubtitle: Entry(
      zh: "预设定义会话所使用的工具、提示词与能力。复制现有预设，或让创造模式协助创建。",
      en: "Presets define the tools, prompts, and capabilities used by a chat. Copy an existing preset or let Creator mode help create one."),
    .presetBuiltInLabel: Entry(zh: "内置", en: "Built-in"),
    .presetCustomLabel: Entry(zh: "用户", en: "Custom"),
    .presetCurrentLabel: Entry(zh: "当前使用", en: "Current"),
    .presetLoading: Entry(zh: "正在读取智能体预设…", en: "Loading agent presets…"),
    .presetEmptyTitle: Entry(zh: "没有智能体预设", en: "No Agent Presets"),
    .presetEmptyDetail: Entry(zh: "本机服务没有报告可管理的智能体预设。", en: "The local service reported no manageable agent presets."),
    .presetNoCustom: Entry(zh: "尚无用户预设。可复制任一可用预设，再在其目录中编辑。", en: "There are no custom presets yet. Copy an available preset, then edit it in its folder."),
    .presetNotAuthorable: Entry(zh: "此运行环境没有可写的用户预设目录。", en: "This runtime has no writable custom preset folder."),
    .presetCreatorDraft: Entry(zh: "用创造模式创作自定义预设", en: "Draft a Custom Preset in Creator Mode"),
    .presetLoadFailed: Entry(zh: "加载失败", en: "Failed to Load"),
    .presetNoDescription: Entry(zh: "暂无描述。", en: "No description."),
    .presetCurrentDefault: Entry(zh: "当前默认预设", en: "Current default preset"),
    .presetSetDefault: Entry(zh: "设为新会话默认预设", en: "Set as the default preset for new chats"),
    .presetViewReadOnly: Entry(zh: "查看只读组合内容", en: "View read-only composition"),
    .presetViewContent: Entry(zh: "查看内容", en: "View Content"),
    .presetCopy: Entry(zh: "复制预设", en: "Copy Preset"),
    .presetOpenFolder: Entry(zh: "打开目录", en: "Open Folder"),
    .presetShowFolder: Entry(zh: "显示目录", en: "Show Folder"),
    .presetDeleteUser: Entry(zh: "删除用户预设", en: "Delete Custom Preset"),
    .presetRefresh: Entry(zh: "刷新智能体预设", en: "Refresh Agent Presets"),
    .presetDeleteConfirm: Entry(
      zh: "删除用户预设“{0}”？已运行会话不会改变。",
      en: "Delete custom preset “{0}”? Existing chats will not change."),
    .presetDeleteConfirmFallback: Entry(zh: "删除用户预设？", en: "Delete Custom Preset?"),
    .presetDeleteAction: Entry(zh: "删除", en: "Delete"),
    .presetCancel: Entry(zh: "取消", en: "Cancel"),
    .presetCopyTitle: Entry(zh: "复制智能体预设", en: "Copy Agent Preset"),
    .presetCopyDetail: Entry(
      zh: "以“{0}”为只读来源创建一个用户预设。组合内容不会在此界面编辑。",
      en: "Create a custom preset from the read-only source “{0}”. Its composition is not edited on this screen."),
    .presetCopyIdentifier: Entry(zh: "新预设标识", en: "New Preset ID"),
    .presetCopyDisplayName: Entry(zh: "显示名称（可选）", en: "Display Name (Optional)"),
    .presetCopyIdentifierRule: Entry(
      zh: "标识须以小写字母或数字开头，只能包含小写字母、数字和连字符，且不能与已有预设重复。",
      en: "The ID must begin with a lowercase letter or number, contain only lowercase letters, numbers, and hyphens, and be unique."),
    .presetCopyAction: Entry(zh: "复制", en: "Copy"),
    .presetReadOnlyLabel: Entry(zh: "只读", en: "Read Only"),
    .presetClose: Entry(zh: "关闭", en: "Close"),

    // 内置插件设置卡
    .pluginTerminalTitle: Entry(zh: "终端", en: "Terminal"),
    .pluginTerminalDetail: Entry(
      zh: "限制智能体运行的每一条命令。",
      en: "Restricts every command the agent runs."),
    .pluginAgentLoopTitle: Entry(zh: "智能体循环", en: "Agent Loop"),
    .pluginAgentLoopDetail: Entry(
      zh: "智能体如何派发工具调用。",
      en: "How the agent dispatches tool calls."),
    .pluginWebSearchTitle: Entry(zh: "网页搜索", en: "Web Search"),
    .pluginWebSearchDetail: Entry(
      zh: "DeepSeek 搜索提供方。",
      en: "DeepSeek search provider."),

    // 配置状态
    .statusConfigured: Entry(zh: "已配置", en: "Configured"),
    .statusUnconfigured: Entry(zh: "未配置", en: "Not configured"),
    .statusCredentialSaved: Entry(zh: "已存凭据", en: "Credential saved"),
    .statusRegistered: Entry(zh: "已注册", en: "Registered"),
    .statusUnavailable: Entry(zh: "不可用", en: "Unavailable"),

    // 会话状态行
    .statusCommandFallback: Entry(zh: "命令", en: "Command"),
    .statusCommandRunning: Entry(zh: "命令运行中", en: "Command running"),
    .statusCommandDone: Entry(zh: "命令完成", en: "Command finished"),
    .statusCommandFailed: Entry(zh: "命令失败", en: "Command failed"),
    .statusCommandStopped: Entry(zh: "命令已随本轮结束", en: "Command ended with the turn"),
    .statusCompactionTitle: Entry(zh: "上下文已压缩", en: "Context compacted"),
    .statusCompactionDetail: Entry(
      zh: "已替换 {0} 项 · 约 {1} tokens",
      en: "Replaced {0} items · about {1} tokens"),
    .statusCompactionExpandSummary: Entry(zh: "展开查看摘要", en: "Expand to view summary"),
    .statusCompactionSummaryMissing: Entry(
      zh: "摘要不在当前历史窗口",
      en: "Summary not in the current history window"),
    .statusRequestContextTitle: Entry(zh: "请求上下文", en: "Request context"),
    .statusContextTokens: Entry(zh: " · {0} tokens", en: " · {0} tokens"),
    .statusRetryInProgress: Entry(
      zh: "正在进行第 {0} 次模型重试",
      en: "Model retry attempt {0} in progress"),
    .statusRetryAfterDelay: Entry(
      zh: "模型请求失败，{0} 后重试 {1}",
      en: "Model request failed, retrying in {0} {1}"),
    .statusRetryNow: Entry(zh: "正在重试模型请求 {0}", en: "Retrying model request {0}"),
    .statusRetryAttempt: Entry(zh: "（第 {0} 次）", en: "(attempt {0})"),
    .statusRetryAttemptOfMax: Entry(zh: "（{0}/{1}）", en: "({0}/{1})"),
    .statusRetryDone: Entry(zh: "模型重试后已完成", en: "Model retry finished"),
    .statusRetryFailed: Entry(zh: "模型重试未成功", en: "Model retry did not succeed"),
    .statusRetryCancelled: Entry(zh: "模型重试已取消", en: "Model retry cancelled"),
    .statusReplyFailed: Entry(zh: "回复失败", en: "Reply failed"),
    .statusMaxTokensTitle: Entry(zh: "回复达到最大输出长度", en: "Reply reached the output limit"),
    .statusMaxTokensDetail: Entry(
      zh: "内容可能已被截断，可以继续提问或新建分叉会话。",
      en: "Content may be truncated; continue asking or start a forked session."),
    .statusReplyStopped: Entry(zh: "回复已停止", en: "Reply stopped"),
    .statusBlocked: Entry(zh: "请求被策略阻止", en: "Request blocked by policy"),
    .statusInterrupted: Entry(zh: "上次运行意外中断", en: "Previous run was interrupted"),
    .statusAuthRejected: Entry(zh: "API 凭据被拒绝", en: "API credential was rejected"),
    .statusAuthRejectedHTTP: Entry(
      zh: "Provider 拒绝了 API 凭据（HTTP {0}）。请确认这是 API 平台密钥且 Provider 基础 URL 匹配。",
      en: "Provider rejected the API credential (HTTP {0}). Check that this is an API-platform key and that the provider base URL matches."),
  ]

  /// O(1) 查表；未知 key 回退 key 原文，保证不崩、不混语言。
  public static func text(_ key: Key, _ language: ArkLanguagePreference) -> String {
    guard let entry = table[key] else { return key.rawValue }
    if language == .zh { return entry.zh }
    if language == .en { return entry.en }
    return ArkLanguageRegistry.translation(for: key.rawValue, language: language) ?? entry.en
  }

  /// Register one value-owned third-party dictionary for the native shell.
  /// The built-in Chinese and English dictionaries remain authoritative.
  @discardableResult
  public static func register(language: ArkLanguageDefinition) -> Bool {
    ArkLanguageRegistry.register(language)
  }

  /// Remove one third-party native language dictionary.
  @discardableResult
  public static func unregisterLanguage(id: String) -> Bool {
    ArkLanguageRegistry.unregister(id: id)
  }

  /// 参数化文案：模板中的 {0} {1} … 依次替换为 arguments。
  /// 动态 Toast 等场景用它，避免中英文片段混合拼接。
  public static func format(
    _ key: Key,
    _ language: ArkLanguagePreference,
    arguments: [String]
  ) -> String {
    var template = text(key, language)
    for (index, argument) in arguments.enumerated() {
      template = template.replacingOccurrences(of: "{" + String(index) + "}", with: argument)
    }
    return template
  }

  /// 按会话权限预设值取本地化标签；未知值回退原值（不翻译非 UI 数据）。
  public static func permissionPresetLabel(_ preset: String, _ language: ArkLanguagePreference) -> String {
    switch preset {
    case "danger-full-access": return text(.permissionFullAccess, language)
    case "workspace-write": return text(.permissionWorkspaceAccess, language)
    case "read-only": return text(.permissionReadOnly, language)
    case "restricted": return text(.permissionRestricted, language)
    default: return preset
    }
  }

  /// 内置预设展示标题：按稳定 ID 映射；用户自建预设回退原名称（不翻译用户数据）。
  public static func presetDisplayTitle(id: String, name: String?, _ language: ArkLanguagePreference) -> String {
    switch id {
    case "standard": return text(.presetStandardName, language)
    case "code": return text(.presetCodeName, language)
    case "minimal": return text(.presetMinimalName, language)
    case "cordis": return text(.presetCordisName, language)
    default: return name ?? id
    }
  }

  /// 内置预设展示描述：按稳定 ID 映射；用户自建预设回退原描述（不翻译用户数据）。
  public static func presetDisplayDescription(id: String, description: String?, _ language: ArkLanguagePreference) -> String {
    switch id {
    case "standard": return text(.presetStandardDescription, language)
    case "code": return text(.presetCodeDescription, language)
    case "minimal": return text(.presetMinimalDescription, language)
    case "cordis": return text(.presetCordisDescription, language)
    default: return description ?? ""
    }
  }
}
