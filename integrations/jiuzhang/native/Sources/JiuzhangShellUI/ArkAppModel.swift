import Combine
import Foundation
import JiuzhangShellCore

public struct ArkProviderModelInput: Equatable, Sendable {
  public let id: String
  public let name: String?
  public let contextWindow: Int?
  public let maxTokens: Int?

  public init(id: String, name: String? = nil, contextWindow: Int? = nil, maxTokens: Int? = nil) {
    self.id = id
    self.name = name
    self.contextWindow = contextWindow
    self.maxTokens = maxTokens
  }

  /// Encode the edited rows in the user's current order while preserving
  /// unknown fields from the first stored row for each model identity.
  public static func encodedRows(
    _ inputs: [ArkProviderModelInput],
    preserving existingRows: [JSONValue]
  ) -> [JSONValue] {
    var firstExistingRowByID: [String: JSONValue] = [:]
    for row in existingRows {
      guard let id = row["id"]?.stringValue,
            !id.isEmpty,
            firstExistingRowByID[id] == nil
      else { continue }
      firstExistingRowByID[id] = row
    }
    var seenInputIDs = Set<String>()
    return inputs.filter { seenInputIDs.insert($0.id).inserted }.map { input in
      var row = firstExistingRowByID[input.id]?.objectValue ?? [:]
      row["id"] = .string(input.id)
      if let name = input.name, !name.isEmpty { row["name"] = .string(name) }
      else { row.removeValue(forKey: "name") }
      if let context = input.contextWindow { row["contextWindow"] = .number(Double(context)) }
      else { row.removeValue(forKey: "contextWindow") }
      if let maxTokens = input.maxTokens { row["maxTokens"] = .number(Double(maxTokens)) }
      else { row.removeValue(forKey: "maxTokens") }
      return .object(row)
    }
  }
}

public enum ArkPendingInteraction: Sendable {
  case approval(ArkApprovalRequest)
  case question(ArkQuestionRequest)
}

public enum ArkHistoryLoadState: Equatable, Sendable {
  case idle
  case loading
  case loaded
  case failed(String)

  public static func afterCancellation(hasHistory: Bool) -> Self {
    hasHistory ? .loaded : .idle
  }
}

enum ArkEventSequenceValidationError: LocalizedError, Equatable {
  case invalidPageOrder
  case gap(expected: Int, actual: Int)
  case incomplete(expected: Int, actual: Int?)
  case nonAdvancingCursor(requested: Int, returned: Int?)
  case catchUpLimitExceeded

  var errorDescription: String? {
    switch self {
    case .invalidPageOrder:
      return "会话历史包含重复或倒序事件，正在等待重新同步"
    case .gap(let expected, let actual):
      return "会话事件序号不连续（应为 \(expected)，实际为 \(actual)），正在等待重新同步"
    case .incomplete(let expected, let actual):
      let current = actual.map(String.init) ?? "空"
      return "会话历史尚未同步到 \(expected)（当前为 \(current)）"
    case .nonAdvancingCursor(let requested, let returned):
      let current = returned.map(String.init) ?? "空"
      return "会话历史游标没有继续向前（请求 \(requested)，返回 \(current)）"
    case .catchUpLimitExceeded:
      return "会话历史补齐页数超过安全上限，请重新连接后再试"
    }
  }
}

enum ArkEventSequenceValidator {
  static func safeInteger(_ value: JSONValue?, minimum: Int = 0) -> Int? {
    guard let number = value?.numberValue,
          number.isFinite,
          number.rounded(.towardZero) == number,
          abs(number) <= 9_007_199_254_740_991,
          number >= Double(minimum),
          number >= Double(Int.min),
          number <= Double(Int.max)
    else { return nil }
    return Int(number)
  }

  static func validatePage(_ page: ArkHistoryPage) throws {
    var previous: Int?
    for event in page.events {
      if let previous {
        guard event.id > previous else {
          throw ArkEventSequenceValidationError.invalidPageOrder
        }
        guard event.id == previous + 1 else {
          throw ArkEventSequenceValidationError.gap(expected: previous + 1, actual: event.id)
        }
      }
      previous = event.id
    }
    if page.hasMore && page.events.isEmpty {
      throw ArkEventSequenceValidationError.incomplete(expected: 0, actual: nil)
    }
    if page.hasMore && page.beforeSequence != page.events.first?.id {
      throw ArkEventSequenceValidationError.invalidPageOrder
    }
    if !page.hasMore, let first = page.events.first?.id, first != 0 {
      throw ArkEventSequenceValidationError.gap(expected: 0, actual: first)
    }
  }

  static func olderCursor(
    for page: ArkHistoryPage,
    requestedBefore: Int
  ) throws -> Int? {
    try validatePage(page)
    let next: Int?
    if page.hasMore {
      guard let candidate = page.beforeSequence, candidate < requestedBefore else {
        throw ArkEventSequenceValidationError.nonAdvancingCursor(
          requested: requestedBefore,
          returned: page.beforeSequence
        )
      }
      next = candidate
    } else {
      next = nil
    }
    guard let last = page.events.last?.id else {
      guard requestedBefore == 0 else {
        throw ArkEventSequenceValidationError.incomplete(
          expected: requestedBefore - 1,
          actual: nil
        )
      }
      return nil
    }
    guard last == requestedBefore - 1 else {
      throw ArkEventSequenceValidationError.gap(
        expected: requestedBefore - 1,
        actual: last
      )
    }
    return next
  }

  static func validateReconciled(
    _ events: [ArkHistoryEvent],
    expectedThrough: Int?
  ) throws {
    var previous: Int?
    for event in events.sorted(by: { $0.id < $1.id }) {
      if let previous {
        guard event.id > previous else {
          throw ArkEventSequenceValidationError.invalidPageOrder
        }
        guard event.id == previous + 1 else {
          throw ArkEventSequenceValidationError.gap(expected: previous + 1, actual: event.id)
        }
      }
      previous = event.id
    }
    if let expectedThrough, expectedThrough >= 0,
       (previous ?? -1) < expectedThrough {
      throw ArkEventSequenceValidationError.incomplete(
        expected: expectedThrough,
        actual: previous
      )
    }
  }

  static func uniqueSorted(_ events: [ArkHistoryEvent]) -> [ArkHistoryEvent] {
    var seen = Set<Int>()
    return events
      .sorted { $0.id < $1.id }
      .filter { seen.insert($0.id).inserted }
  }
}

/// Incremental proof that newest-first history pages bridge one retained
/// contiguous tail to the exact sequence advertised by the mux baseline. Only
/// the newest 50k events are retained for presentation; older traversed pages
/// still advance the proof and pagination cursor without growing memory.
struct ArkHistoryCatchUpAccumulator {
  static let maximumPresentationEvents = 50_000
  static let maximumPages = 4_096

  let anchorSequence: Int
  let targetSequence: Int
  private let retained: [ArkHistoryEvent]
  private(set) var nextBeforeSequence: Int?
  private(set) var expectedPageEnd: Int
  private(set) var presentationEvents: [ArkHistoryEvent] = []
  private(set) var pageCount = 0
  private(set) var complete = false

  init(retained: [ArkHistoryEvent], targetSequence: Int) throws {
    let ordered = ArkEventSequenceValidator.uniqueSorted(retained)
    try ArkEventSequenceValidator.validateReconciled(ordered, expectedThrough: ordered.last?.id)
    anchorSequence = ordered.last?.id ?? -1
    guard targetSequence >= anchorSequence else {
      throw ArkEventSequenceValidationError.incomplete(
        expected: anchorSequence,
        actual: targetSequence
      )
    }
    self.targetSequence = targetSequence
    self.retained = ordered
    expectedPageEnd = targetSequence
    nextBeforeSequence = targetSequence < 9_007_199_254_740_991
      ? targetSequence + 1
      : nil
    complete = targetSequence == anchorSequence
  }

  mutating func consume(_ page: ArkHistoryPage) throws {
    guard !complete else { return }
    pageCount += 1
    guard pageCount <= Self.maximumPages else {
      throw ArkEventSequenceValidationError.catchUpLimitExceeded
    }
    try ArkEventSequenceValidator.validatePage(page)
    guard let first = page.events.first?.id,
          let last = page.events.last?.id
    else {
      throw ArkEventSequenceValidationError.incomplete(
        expected: expectedPageEnd,
        actual: nil
      )
    }
    guard last == expectedPageEnd else {
      throw ArkEventSequenceValidationError.gap(expected: expectedPageEnd, actual: last)
    }
    if let requested = nextBeforeSequence, first >= requested {
      throw ArkEventSequenceValidationError.nonAdvancingCursor(
        requested: requested,
        returned: first
      )
    }

    let additions = page.events.filter {
      $0.id > anchorSequence && $0.id <= targetSequence
    }
    presentationEvents = Array(
      (additions + presentationEvents).suffix(Self.maximumPresentationEvents)
    )
    if first <= anchorSequence + 1 {
      complete = true
      nextBeforeSequence = nil
      return
    }
    guard page.hasMore else {
      throw ArkEventSequenceValidationError.incomplete(
        expected: anchorSequence + 1,
        actual: first
      )
    }
    guard page.beforeSequence == first else {
      throw ArkEventSequenceValidationError.invalidPageOrder
    }
    let next = first
    expectedPageEnd = next - 1
    nextBeforeSequence = next
  }

  func mergedPresentation() throws -> [ArkHistoryEvent] {
    guard complete else {
      throw ArkEventSequenceValidationError.incomplete(
        expected: targetSequence,
        actual: presentationEvents.last?.id
      )
    }
    let merged = Array(
      ArkEventSequenceValidator.uniqueSorted(retained + presentationEvents)
        .suffix(Self.maximumPresentationEvents)
    )
    try ArkEventSequenceValidator.validateReconciled(
      merged,
      expectedThrough: targetSequence
    )
    return merged
  }
}

/// Single policy owner for native live transcript work. It bounds only the
/// transient presentation and publication cadence; durable events and final
/// assistant content always remain complete in the model/session log.
enum ArkStreamingPresentationPolicy {
  static let shortPublishIntervalNanoseconds: UInt64 = 100_000_000
  static let mediumPublishIntervalNanoseconds: UInt64 = 250_000_000
  static let longPublishIntervalNanoseconds: UInt64 = 500_000_000
  static let mediumLedgerEventCount = 2_000
  static let longLedgerEventCount = 10_000
  static let reasoningCharacterLimit = 4_096
  static let reasoningLineLimit = 12
  static let markdownCharacterLimit = 8_192
  static let markdownFirstFrameCharacterLimit = 4_096

  static func intervalNanoseconds(eventCount: Int) -> UInt64 {
    if eventCount >= longLedgerEventCount { return longPublishIntervalNanoseconds }
    if eventCount >= mediumLedgerEventCount { return mediumPublishIntervalNanoseconds }
    return shortPublishIntervalNanoseconds
  }

  static func reasoningText(_ text: String, streaming: Bool) -> String {
    streaming ? boundedSuffix(text, maximumCharacters: reasoningCharacterLimit) : text
  }

  static func markdownText(_ text: String, streaming: Bool) -> String {
    streaming ? boundedSuffix(text, maximumCharacters: markdownCharacterLimit) : text
  }

  static func firstFrameText(_ text: String) -> String {
    boundedPrefix(text, maximumCharacters: markdownFirstFrameCharacterLimit)
  }

  static func usesStreamingAssistantPresentation(
    role: ArkMessage.Role,
    isLatestAssistant: Bool,
    sessionRunning: Bool
  ) -> Bool {
    role == .assistant && isLatestAssistant && sessionRunning
  }

  static func liveAssistantMessageID(
    messages: [ArkMessage],
    currentTurn: Int?,
    turnStartSequence: Int?,
    sessionRunning: Bool
  ) -> Int? {
    guard sessionRunning, let currentTurn else { return nil }
    return messages.filter { message in
      guard message.role == .assistant else { return false }
      let afterBoundary = turnStartSequence.map { message.id > $0 } ?? true
      if message.turn == currentTurn { return afterBoundary }
      return message.turn == nil && afterBoundary
    }.max(by: { $0.id < $1.id })?.id
  }

  private static func boundedSuffix(_ text: String, maximumCharacters: Int) -> String {
    let visible = text.suffix(maximumCharacters)
    guard visible.startIndex != text.startIndex else { return text }
    return "…\n" + visible
  }

  private static func boundedPrefix(_ text: String, maximumCharacters: Int) -> String {
    let visible = text.prefix(maximumCharacters)
    guard visible.endIndex != text.endIndex else { return text }
    return visible + "\n\n…"
  }
}

public struct ArkKnowledgeProject: Identifiable, Equatable, Sendable {
  public let path: String
  public let name: String
  public let isMain: Bool

  public var id: String { path }
  public var displayName: String { isMain ? "万相织鉴" : name }
}

private struct ArkComposerCatalogSnapshot: Sendable {
  var commands: [ArkComposerCommand] = []
  var skills: [ArkComposerSkill] = []
  var commandsLoaded = false
  var skillsLoaded = false
  var commandError: String?
  var skillError: String?
}

private struct ArkComposerCatalogLoad<Value: Sendable>: Sendable {
  let value: Value?
  let error: String?
}

private struct ArkHistoryFoldOwner: Equatable {
  let sessionID: String
  let generation: UInt64
}

/// Pure history fold built away from the main actor. Session switching only
/// installs the completed snapshot, so sorting and four projection rebuilds
/// never block AppKit input or the first visible frame.
private struct ArkHistoryFold: Sendable {
  private(set) var events: [ArkHistoryEvent]
  private(set) var turnProjection: ArkChatTurnProjection
  private(set) var turnUsageByTurn: [Int: ArkChatTurnUsage]
  private(set) var messages: ArkMessageProjection
  private(set) var tools: ArkToolProjection
  private(set) var producedFiles: ArkProducedFilesProjection
  private(set) var statuses: ArkChatStatusProjection
  private let language: ArkLanguagePreference

  init(events source: [ArkHistoryEvent], language: ArkLanguagePreference) {
    var known = Set<Int>()
    let ordered = source
      .filter { known.insert($0.id).inserted }
      .sorted { $0.id < $1.id }
    let completeTurnProjection = ArkChatTurnProjection(events: ordered)
    events = Array(ordered.suffix(50_000))
    turnProjection = ArkChatTurnProjection(events: events)
    turnProjection.preserveLatestStartedBoundary(
      turn: completeTurnProjection.latestStartedTurn,
      sequence: completeTurnProjection.latestStartedSequence
    )
    turnUsageByTurn = ArkChatTurnUsageProjection.projectAll(events: events)
    messages = ArkMessageProjection(events: events)
    tools = ArkToolProjection(events: events)
    producedFiles = ArkProducedFilesProjection(events: events)
    statuses = ArkChatStatusProjection(events: events, language: language)
    self.language = language
  }

  mutating func preserveLatestStartedBoundary(turn: Int?, sequence: Int?) {
    turnProjection.preserveLatestStartedBoundary(turn: turn, sequence: sequence)
  }

  mutating func appendLive(_ values: [ArkHistoryEvent]) {
    var known = Set(events.map(\.id))
    var completedTurns = Set<Int>()
    for event in values.sorted(by: { $0.id < $1.id }) where known.insert(event.id).inserted {
      events.append(event)
      turnProjection.append(event)
      if event.type == "turn/end",
         let turn = ArkChatTurnUsageProjection.turn(in: event) {
        completedTurns.insert(turn)
      }
      _ = messages.append(event)
      tools.append(event)
      producedFiles.append(event)
      statuses.append(event)
    }
    if events.count > 50_000 {
      let preservedTurn = turnProjection.latestStartedTurn
      let preservedSequence = turnProjection.latestStartedSequence
      self = ArkHistoryFold(events: Array(events.suffix(50_000)), language: language)
      preserveLatestStartedBoundary(turn: preservedTurn, sequence: preservedSequence)
    } else {
      for turn in completedTurns {
        let usage = ArkChatTurnUsageProjection.project(events: events, turn: turn)
        if let usage { turnUsageByTurn[turn] = usage }
        else { turnUsageByTurn.removeValue(forKey: turn) }
      }
    }
  }
}

private actor ArkHistoryFoldWorker {
  static let shared = ArkHistoryFoldWorker()

  func fold(events: [ArkHistoryEvent], language: ArkLanguagePreference) -> ArkHistoryFold? {
    guard !Task.isCancelled else { return nil }
    let fold = ArkHistoryFold(events: events, language: language)
    guard !Task.isCancelled else { return nil }
    return fold
  }
}

/// Bounded in-memory presentation snapshot for fast session round-trips.
/// Durable history and live ownership remain with Host; this cache contains
/// only already-rendered Native projections and is always refreshed after use.
private struct ArkConversationSurfaceSnapshot {
  let events: [ArkHistoryEvent]
  let messageProjection: ArkMessageProjection
  let toolProjection: ArkToolProjection
  let producedFilesProjection: ArkProducedFilesProjection
  let statusProjection: ArkChatStatusProjection
  let historyBeforeSequence: Int?
  let hasOlderHistory: Bool
  let messages: [ArkMessage]
  let toolActivities: [ArkToolActivity]
  let producedFiles: [ArkProducedFile]
  let chatStatuses: [ArkChatStatus]
  let turnProjection: ArkChatTurnProjection
  let turnUsageByTurn: [Int: ArkChatTurnUsage]
  let feedback: [String: ArkMessageFeedback]
  let feedbackAvailable: Bool
  let sessionProjections: [String: JSONValue]
  let modelLabel: String
}

@MainActor
public final class ArkAppModel: ObservableObject {
  public enum Tab: String, CaseIterable, Identifiable {
    case chat = "对话"
    case trajectory = "轨迹"
    case wiki = "万相织鉴"

    public var id: String { rawValue }
  }

  @Published public private(set) var workspaces: [ArkWorkspace] = []
  @Published public private(set) var sessions: [ArkSessionSummary] = []
  @Published public private(set) var archivedSessionIDs = Set<String>()
  public private(set) var events: [ArkHistoryEvent] = []
  public private(set) var messages: [ArkMessage] = []
  @Published public private(set) var wikiPages: [ArkWikiPage] = []
  @Published public private(set) var wikiEdges: [ArkWikiEdge] = []
  @Published public private(set) var wikiReviews: [ArkWikiReview] = []
  @Published public private(set) var wikiProjects: [ArkKnowledgeProject] = []
  @Published public private(set) var selectedKnowledgeProjectPath: String?
  @Published public private(set) var wikiSavingPageID: String?
  @Published public private(set) var wikiSaveError: String?
  @Published public private(set) var wikiSaveRevision: UInt64 = 0
  @Published public private(set) var wikiIngestQueue = ArkKnowledgeIngestQueue(
    tasks: [],
    running: false,
    cancelled: false
  )
  @Published public private(set) var wikiIngestBusy = false
  @Published public private(set) var wikiIngestError: String?
  @Published public private(set) var wikiReviewBusy = false
  @Published public private(set) var wikiReviewError: String?
  @Published public private(set) var sessionSearchHits: [ArkSessionSearchHit] = []
  @Published public private(set) var sessionSearchDidRun = false
  @Published public private(set) var sessionSearchLoading = false
  @Published public private(set) var sessionSearchRemoteUnavailable = false
  @Published public private(set) var knowledgeSearchPaths: Set<String> = []
  @Published public private(set) var modelCatalog: ArkSessionModels?
  @Published private var hostModelGroups: [ArkModelProviderGroup] = []
  private var settingsLoadGeneration: UInt64 = 0
  private var modelCatalogLoadGeneration: UInt64 = 0
  @Published public private(set) var draftModelSelection: ArkModelSelection?
  @Published public private(set) var draftPermissionPreset: String?
  @Published public private(set) var approvals: [ArkApprovalRequest] = []
  @Published public private(set) var questions: [ArkQuestionRequest] = []
  @Published public private(set) var pendingInteractionOrder: [String] = []
  @Published public private(set) var queuedPrompts: [ArkQueuedPrompt] = []
  @Published public private(set) var queueMutationIDs = Set<String>()
  @Published public private(set) var sessionExportState: ArkSessionExportState = .idle
  @Published public private(set) var pendingImages: [ArkPromptImage] = []
  @Published public private(set) var pendingDocuments: [ArkPendingDocument] = []
  public private(set) var toolActivities: [ArkToolActivity] = []
  public private(set) var producedFiles: [ArkProducedFile] = []
  public let messageImages: ArkMessageImageStore
  let chatPresentationDidChange = PassthroughSubject<Void, Never>()
  @Published public private(set) var hasOlderHistory = false
  @Published public private(set) var loadingOlderHistory = false
  @Published public private(set) var historyLoadState: ArkHistoryLoadState = .idle
  private var turnProjection = ArkChatTurnProjection()
  public var turnMetricsByTurn: [Int: ArkChatTurnMetrics] { turnProjection.metricsByTurn }
  public var completedTurnIDs: Set<Int> { Set(turnProjection.completedSequenceByTurn.keys) }
  var latestStartedTurn: Int? { turnProjection.latestStartedTurn }
  var latestStartedTurnSequence: Int? { turnProjection.latestStartedSequence }
  public private(set) var turnUsageByTurn: [Int: ArkChatTurnUsage] = [:]
  /// 轨迹语义记录的模型层缓存：历史更新时 fold 一次，
  /// Tab 切换/视图重建只读缓存，避免每次切换对全量 events 重折。
  @Published public private(set) var trajectoryRecords: [ArkTrajectorySemanticRecord] = []
  public private(set) var chatStatuses: [ArkChatStatus] = []
  @Published public private(set) var respondingInteractionIDs = Set<String>()
  @Published public private(set) var messageFeedbackByID: [String: ArkMessageFeedback] = [:]
  @Published public private(set) var messageFeedbackAvailable = false
  @Published public private(set) var sessionProjections: [String: JSONValue] = [:]
  @Published public private(set) var goalMutationSessionID: String?
  @Published public private(set) var goalMutationError: String?
  @Published public private(set) var sessionJobs: [JSONValue] = []
  @Published public private(set) var workbenchFileOpenRequest: ArkWorkbenchFileOpenRequest?
  @Published public private(set) var providers: [ArkProviderView] = []
  @Published public private(set) var settingsSnapshot: ArkSettingsSnapshot?
  @Published public private(set) var credentialStates: [String: ArkCredentialView] = [:]
  @Published public private(set) var providerTransactionStates: [String: ArkProviderTransactionStatus] = [:]
  @Published public private(set) var settingsBusy = false
  @Published public private(set) var agentPresetRoster: ArkAgentPresetRoster?
  @Published public private(set) var selectedPresetDocument: ArkAgentPresetDocument?
  @Published public private(set) var agentPresetBusy = false
  @Published public private(set) var agentPresetError: String?
  @Published public private(set) var pluginEntries: [ArkPluginInventoryEntry] = []
  @Published public private(set) var pluginInventoryBusy = false
  @Published public private(set) var pluginInventoryError: String?
  @Published public private(set) var pluginSettingsSnapshot: ArkPluginSettingsSnapshot?
  @Published public private(set) var pluginSettingsBusy = false
  @Published public private(set) var pluginSettingsError: String?
  @Published public private(set) var archiveMutationIDs = Set<String>()
  @Published public private(set) var discoveredModels: [ArkDiscoveredModel] = []
  @Published public private(set) var modelDiscoveryBusy = false
  @Published public private(set) var modelDiscoveryError: String?
  @Published public private(set) var subagentEntriesByID: [String: ArkSubagentEntry] = [:]
  @Published public private(set) var subagentParentAvailableByID: [String: Bool] = [:]
  @Published public private(set) var subagentCatalogsByParentID: [String: ArkSubagentCatalogViewState] = [:]
  @Published public var nextAgentPresetID: String? {
    didSet { persist(nextAgentPresetID, key: Keys.nextAgentPreset) }
  }
  @Published public var busyEnterBehavior: ArkPromptDeliveryMode {
    didSet { defaults.set(busyEnterBehavior.rawValue, forKey: Keys.busyEnterBehavior) }
  }
  @Published public var selectedToolActivityID: String?
  @Published public private(set) var activeWikiTitle = "万相织鉴"
  @Published public private(set) var modelLabel = "未配置模型"
  @Published public private(set) var pendingInteractionCount = 0
  @Published public private(set) var operationMessage: String?
  private var operationMessageClearTask: Task<Void, Never>?
  /// 界面语言（UI 壳层文案的语言，独立于模型回答语言）。
  @Published public private(set) var languagePreference: ArkLanguagePreference = .zh
  @Published public var selectedWorkspaceID: String? { didSet { persist(selectedWorkspaceID, key: Keys.workspace) } }
  @Published public var selectedSessionID: String? {
    didSet {
      persist(selectedSessionID, key: Keys.session)
      guard oldValue != selectedSessionID else { return }
      goalMutationError = nil
      resetTrajectoryProjectionState()
      persistComposerDraft(for: oldValue)
      installComposerDraft(Self.loadComposerDraft(defaults: defaults, sessionID: selectedSessionID))
      invalidateComposerSuggestions()
      prewarmComposerCatalog(for: selectedSessionID)
    }
  }
  @Published public var selectedWikiPageID: String? { didSet { persist(selectedWikiPageID, key: Keys.wikiPage) } }
  @Published public var selectedTab: Tab {
    didSet {
      defaults.set(selectedTab.rawValue, forKey: Keys.tab)
      if selectedTab == .trajectory { scheduleTrajectoryProjectionIfNeeded() }
    }
  }
  /// 用户是否已显式导航：启动恢复逻辑不得覆盖用户先行的 Tab 选择。
  private var userHasNavigated = false

  /// 用户显式切换主导航 Tab（与启动恢复的程序化赋值区分开）。
  public func userSelectedTab(_ tab: Tab) {
    userHasNavigated = true
    selectedTab = tab
  }

  /// Load one public page for the browser-free Native Workbench reader.
  public func workbenchWebRead(url: URL) async throws -> ArkWorkbenchWebDocument {
    try await client.workbenchWebRead(url: url.absoluteString)
  }

  /// 生命周期取消（页面/会话切换导致的任务取消）不算用户错误。
  private func isTaskCancellation(_ error: Error) -> Bool {
    if error is CancellationError { return true }
    let nsError = error as NSError
    return nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled
  }
  @Published public private(set) var composer: String
  @Published public private(set) var composerFocusRevision = 0
  @Published public private(set) var composerRequestedCaret: Int?
  @Published public private(set) var composerSuggestions = ArkComposerSuggestionMenu.closed
  @Published public private(set) var composerLauncherPage: ArkComposerLauncherPage = .root
  @Published public private(set) var composerLauncherQuery = ""
  @Published public private(set) var composerLauncherFocusRevision = 0
  @Published public private(set) var composerSubmissionInFlight = false
  @Published public private(set) var navigationErrorMessage: String?
  @Published public private(set) var settingsErrorMessage: String?
  @Published public private(set) var composerErrorMessage: String?
  @Published public private(set) var knowledgeErrorMessage: String?
  @Published public private(set) var eventConnectionStates: [ArkEventChannel: ArkEventConnectionState] = [
    .mux: .connecting,
    .host: .connecting,
  ]
  @Published public private(set) var eventConnectionErrors: [ArkEventChannel: String] = [:]

  private let client: ArkAPIClient
  private let interactions: ArkInteractionAPI
  private let eventPump: ArkEventPump
  private let documentStore: ArkDocumentReferenceStore
  private let fallbackWikiRoot: URL
  private let defaults: UserDefaults
  private let providerTransactions: ArkProviderTransactionRegistry

  private enum EventLifecycle {
    case idle
    case running
    case stopping
    case stopped
  }

  private var historyTask: Task<Void, Never>?
  private var eventTask: Task<Void, Never>?
  private var eventLifecycle = EventLifecycle.idle
  private var eventShutdownTask: Task<Void, Never>?
  private var eventBaselineGenerationByChannel: [ArkEventChannel: String] = [:]
  private var subscribedLastSequenceBySessionID: [String: Int] = [:]
  private var eventResyncTask: Task<Void, Never>?
  private var livePublishTask: Task<Void, Never>?
  private var historyProjectionGeneration: UInt64 = 0
  private var historyFoldOwner: ArkHistoryFoldOwner?
  private var historyRefreshOwner: ArkHistoryFoldOwner?
  private var olderHistoryLoadOwner: ArkHistoryFoldOwner?
  private var historyFoldInFlight: Bool { historyFoldOwner != nil }
  private var modelMetadataHydrationSessionID: String?
  private var conversationSurfaceSnapshots: [String: ArkConversationSurfaceSnapshot] = [:]
  private var conversationSurfaceSnapshotOrder: [String] = []
  private var navigationRefreshTask: Task<Void, Never>?
  private var sessionSearchTask: Task<Void, Never>?
  private var sessionSearchGeneration: UInt64 = 0
  private var composerDraftDocument = ArkComposerDraftDocument()
  private var composerSuggestionTask: Task<Void, Never>?
  private var composerCatalogPrewarmTask: Task<Void, Never>?
  private var modelDiscoveryTask: Task<Void, Never>?
  private var composerSuggestionGeneration: UInt64 = 0
  private var composerCatalogs: [String: ArkComposerCatalogSnapshot] = [:]
  private var composerMenuWasLaunched = false
  private var subagentCatalogTasks: [String: Task<Void, Never>] = [:]
  private var subagentCatalogStaleParents = Set<String>()
  private var subagentActivityHints: [String: Bool] = [:]
  private var subagentKnownParents = Set<String>()
  private var subagentParentAvailabilityOverrides: [String: Bool] = [:]
  private var catalogSubagentSummariesByID: [String: ArkSessionSummary] = [:]
  private var trajectoryProjectionTask: Task<Void, Never>?
  private var trajectoryProjectionDirty = true
  private var trajectoryProjectionGeneration = 0
  private var wikiTask: Task<Void, Never>?
  private var wikiIngestPollingTask: Task<Void, Never>?
  private var wikiIngestPollingGeneration = 0
  private var sessionExportTask: Task<Void, Never>?
  private var goalMutationToken: UUID?
  private var pendingLiveEvents: [ArkHistoryEvent] = []
  private var seenEventIDs = Set<Int>()
  private var messageProjection = ArkMessageProjection()
  private var toolProjection = ArkToolProjection()
  private var producedFilesProjection = ArkProducedFilesProjection()
  private var statusProjection = ArkChatStatusProjection()
  private var historyBeforeSequence: Int?
  private var startupRestoredSessionID: String?
  private var startupRestoredTab: Tab = .chat

  private enum Keys {
    static let workspace = "ark.native.selected-workspace"
    static let session = "ark.native.selected-session"
    static let wikiPage = "ark.native.selected-wiki-page"
    static let tab = "ark.native.selected-tab"
    static func draft(_ sessionID: String?) -> String {
      "ark.native.composer-draft.\(sessionID ?? "new-session")"
    }
    static func draftDocument(_ sessionID: String?) -> String {
      "ark.native.composer-document.\(sessionID ?? "new-session")"
    }
    static let nextAgentPreset = "ark.native.next-agent-preset"
    static let busyEnterBehavior = "ark.native.busy-enter-behavior"
    static let language = "ark.native.language"
  }

  public init(
    client: ArkAPIClient,
    interactions: ArkInteractionAPI,
    eventPump: ArkEventPump,
    fallbackWikiRoot: URL,
    documentStore: ArkDocumentReferenceStore = ArkDocumentReferenceStore(),
    defaults: UserDefaults = .standard
  ) {
    self.client = client
    self.interactions = interactions
    self.eventPump = eventPump
    self.documentStore = documentStore
    messageImages = ArkMessageImageStore { sessionID, attachmentID in
      try await interactions.readImage(sessionID: sessionID, attachmentID: attachmentID).data
    }
    self.fallbackWikiRoot = fallbackWikiRoot
    self.defaults = defaults
    providerTransactions = ArkProviderTransactionRegistry(defaults: defaults)
    let restoredLanguage = ArkLanguagePreference(rawValue: defaults.string(forKey: Keys.language) ?? "zh")
    if ArkLanguagePreference.allCases.contains(restoredLanguage) {
      languagePreference = restoredLanguage
    }
    let restoredComposer = Self.loadComposerDraft(defaults: defaults, sessionID: nil)
    let restoredSessionID = defaults.string(forKey: Keys.session)
    startupRestoredSessionID = restoredSessionID
    startupRestoredTab = defaults.string(forKey: Keys.tab).flatMap(Tab.init(rawValue:)) ?? .chat
    selectedWorkspaceID = defaults.string(forKey: Keys.workspace)
    selectedSessionID = nil
    selectedWikiPageID = defaults.string(forKey: Keys.wikiPage)
    selectedTab = .chat
    composerDraftDocument = restoredComposer
    composer = restoredComposer.text
    nextAgentPresetID = defaults.string(forKey: Keys.nextAgentPreset)
    busyEnterBehavior = defaults.string(forKey: Keys.busyEnterBehavior)
      .flatMap(ArkPromptDeliveryMode.init(rawValue:)) ?? .queue
  }

  public var highlightedComposerSuggestion: ArkComposerSuggestion? {
    guard let index = composerSuggestions.highlightedIndex,
          composerSuggestions.candidates.indices.contains(index)
    else { return nil }
    return composerSuggestions.candidates[index]
  }

  public var composerReferenceOccurrences: [ArkComposerReferenceOccurrence] {
    composerDraftDocument.references
  }

  public var composerLauncherHasBackNavigation: Bool {
    composerLauncherPage != .root
  }

  public var composerLauncherSearchVisible: Bool {
    composerLauncherPage == .files || composerLauncherPage == .sessions
  }

  public var composerLauncherSearchPlaceholder: String {
    switch composerLauncherPage {
    case .files: return ArkL10n.text(.composerLauncherFilesSearch, languagePreference)
    case .sessions: return ArkL10n.text(.composerLauncherSessionsSearch, languagePreference)
    default: return ArkL10n.text(.composerSourcesNoMatches, languagePreference)
    }
  }

  public var composerLauncherEmptyMessage: String {
    switch composerLauncherPage {
    case .files: return ArkL10n.text(.composerLauncherFilesEmpty, languagePreference)
    case .sessions: return ArkL10n.text(.composerLauncherSessionsEmpty, languagePreference)
    default: return ArkL10n.text(.composerSourcesNoMatches, languagePreference)
    }
  }

  public var composerLauncherNavigationTitle: String {
    switch composerLauncherPage {
    case .root:
      return ArkL10n.text(.composerCapabilityMenu, languagePreference)
    case .skills:
      return ArkL10n.text(.composerSkillsGroup, languagePreference)
    case .files:
      return ArkL10n.text(.composerLauncherFiles, languagePreference)
    case .sessions:
      return ArkL10n.text(.composerLauncherSessions, languagePreference)
    case .skillFamily(let familyKey):
      guard let sessionID = selectedSessionID,
            let snapshot = composerCatalogs[sessionID],
            let family = composerSkillFamilies(snapshot).first(where: { $0.id == familyKey })
      else { return ArkL10n.text(.composerSkillsGroup, languagePreference) }
      return family.title
    }
  }

  public var composerCommandHint: String? {
    guard let sessionID = selectedSessionID,
          let snapshot = composerCatalogs[sessionID],
          snapshot.commandsLoaded
    else { return nil }
    let leading = composer.trimmingCharacters(in: .whitespacesAndNewlines)
    guard leading.hasPrefix("/"),
          let command = snapshot.commands.first(where: { leading == "/\($0.name) " }),
          let hint = command.input?.hint
    else { return nil }
    return hint
  }

  /// The AppKit editor's single draft-write path. Reference ranges reconcile
  /// before the new value is published or persisted.
  public func composerTextDidChange(
    _ value: String,
    caret: Int,
    isComposing: Bool
  ) {
    composerErrorMessage = nil
    composerMenuWasLaunched = false
    composerLauncherPage = .root
    composerLauncherQuery = ""
    composerDraftDocument.replaceText(value)
    composer = composerDraftDocument.text
    persistComposerDraft(for: selectedSessionID)
    trackComposerSuggestions(caret: caret, isComposing: isComposing)
  }

  public func composerSelectionDidChange(caret: Int, isComposing: Bool) {
    if composerMenuWasLaunched, composerSuggestions.isOpen { return }
    trackComposerSuggestions(caret: caret, isComposing: isComposing)
  }

  public func composerReferenceDeletionRange(caret: Int, backward: Bool) -> NSRange? {
    composerDraftDocument.deletionRange(caret: caret, backward: backward)
  }

  /// Open the sectioned plus launcher from the same Host command, Skill, file,
  /// and session sources used by typed `/` and `@`; no second catalog exists.
  public func openComposerSourceLauncher() {
    guard selectedSessionID != nil else {
      composerErrorMessage = ArkL10n.text(.composerSourcesNeedSession, languagePreference)
      return
    }
    let end = (composer as NSString).length
    let hit = ArkComposerTriggerHit(
      trigger: .slash,
      query: "",
      quoted: false,
      position: composer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? .leading : .inline,
      range: NSRange(location: end, length: 0),
      draftRevision: composerDraftDocument.revision
    )
    composerMenuWasLaunched = true
    composerLauncherPage = .root
    composerLauncherQuery = ""
    scheduleComposerSuggestions(for: hit)
  }

  @discardableResult
  public func handleComposerMenuKey(_ key: ArkComposerMenuKey, isComposing: Bool) -> Bool {
    guard !isComposing, composerSuggestions.isOpen else { return false }
    switch key {
    case .up:
      composerSuggestions.move(-1)
      return true
    case .down:
      composerSuggestions.move(1)
      return true
    case .escape:
      invalidateComposerSuggestions()
      return true
    case .enter:
      guard let suggestion = highlightedComposerSuggestion else { return false }
      chooseComposerSuggestion(suggestion.id)
      return true
    }
  }

  public func chooseComposerSuggestion(_ id: String) {
    guard let hit = composerSuggestions.hit,
          let suggestion = composerSuggestions.candidates.first(where: { $0.id == id }),
          hit.draftRevision == composerDraftDocument.revision
    else { return }
    composerSuggestionTask?.cancel()

    if suggestion.kind == .fileCollection {
      openComposerReferenceCollection(.files, hit: hit)
      return
    }
    if suggestion.kind == .sessionCollection {
      openComposerReferenceCollection(.sessions, hit: hit)
      return
    }
    if suggestion.id == "skill-collection" {
      guard let sessionID = selectedSessionID,
            let snapshot = composerCatalogs[sessionID]
      else { return }
      composerLauncherPage = .skills
      composerLauncherQuery = ""
      composerMenuWasLaunched = true
      _ = composerSuggestions.publish(
        generation: composerSuggestions.generation,
        candidates: composerSkillCollectionRows(snapshot)
      )
      return
    }
    if suggestion.kind == .skillCollection,
       suggestion.id.hasPrefix("skill-family:")
    {
      guard let sessionID = selectedSessionID,
            let snapshot = composerCatalogs[sessionID]
      else { return }
      let key = String(suggestion.id.dropFirst("skill-family:".count))
      guard let family = composerSkillFamilies(snapshot).first(where: { $0.id == key }) else { return }
      composerLauncherPage = .skillFamily(key)
      composerLauncherQuery = ""
      composerMenuWasLaunched = true
      _ = composerSuggestions.publish(
        generation: composerSuggestions.generation,
        candidates: ArkComposerSuggestionBuilder.skillsOnly(family.skills)
      )
      return
    }

    composerMenuWasLaunched = false
    composerLauncherPage = .root
    composerLauncherQuery = ""

    if let command = suggestion.command, command.input == nil {
      let previous = composerDraftDocument
      guard composerDraftDocument.replacePlainText(
        in: hit.range,
        with: "",
        expectedRevision: hit.draftRevision
      ) else { return }
      installComposerDraft(composerDraftDocument)
      persistComposerDraft(for: selectedSessionID)
      let resultingRevision = composerDraftDocument.revision
      invalidateComposerSuggestions()
      executeBareComposerCommand(
        command,
        previousDocument: previous,
        resultingRevision: resultingRevision
      )
      return
    }

    var desiredCaret = hit.range.location
    if let canonical = suggestion.canonicalReference,
       let appearance = suggestion.appearance
    {
      guard composerDraftDocument.insertReference(
        in: hit.range,
        displayText: suggestion.replacement,
        canonicalReference: canonical,
        source: "reference",
        label: suggestion.title,
        appearance: appearance,
        expectedRevision: hit.draftRevision
      ) else { return }
      if let occurrence = composerDraftDocument.references.first(where: {
        $0.offset == hit.range.location && $0.canonicalReference == canonical
      }) {
        desiredCaret = occurrence.offset + occurrence.length
        let source = composerDraftDocument.text as NSString
        if desiredCaret < source.length,
           source.substring(with: NSRange(location: desiredCaret, length: 1)) == " " {
          desiredCaret += 1
        }
      }
    } else {
      var replacement = suggestion.replacement
      if hit.range.length == 0,
         hit.range.location > 0,
         let previous = (composer as NSString).substring(
          with: NSRange(location: hit.range.location - 1, length: 1)
         ).first,
         !previous.isWhitespace
      {
        replacement = " " + replacement
      }
      guard composerDraftDocument.replacePlainText(
        in: hit.range,
        with: replacement,
        expectedRevision: hit.draftRevision
      ) else { return }
      desiredCaret = hit.range.location + (replacement as NSString).length
    }
    installComposerDraft(composerDraftDocument)
    persistComposerDraft(for: selectedSessionID)

    if suggestion.keepsMenuOpen {
      trackComposerSuggestions(caret: desiredCaret, isComposing: false)
    } else {
      invalidateComposerSuggestions()
    }
    requestComposerFocus(caret: desiredCaret)
  }

  /// Localized composer menu text for the built-in commands, keyed by the
  /// backend command name; unmapped commands keep their backend strings.
  private func localizedComposerCommands() -> [String: (title: String, detail: String)] {
    [
      "compact": (
        ArkL10n.text(.composerCompactCommand, languagePreference),
        ArkL10n.text(.composerCompactCommandDetail, languagePreference)
      ),
      "feedback": (
        ArkL10n.text(.composerFeedbackCommand, languagePreference),
        ArkL10n.text(.composerFeedbackCommandDetail, languagePreference)
      ),
      "goal": (
        ArkL10n.text(.composerGoalCommand, languagePreference),
        ArkL10n.text(.composerGoalCommandDetail, languagePreference)
      ),
      "permission": (
        ArkL10n.text(.composerPermissionCommand, languagePreference),
        ArkL10n.text(.composerPermissionCommandDetail, languagePreference)
      ),
      "plan": (
        ArkL10n.text(.composerPlanCommand, languagePreference),
        ArkL10n.text(.composerPlanCommandDetail, languagePreference)
      ),
    ]
  }

  public func showComposerSourceRoot() {
    guard composerLauncherPage != .root,
          let sessionID = selectedSessionID
    else { return }
    composerSuggestionTask?.cancel()
    composerSuggestionTask = nil
    guard let hit = composerSuggestions.hit else {
      invalidateComposerSuggestions()
      return
    }
    guard let snapshot = composerCatalogs[sessionID] else {
      invalidateComposerSuggestions()
      composerErrorMessage = ArkL10n.text(.composerSourcesCatalogChanged, languagePreference)
      return
    }
    composerSuggestionGeneration &+= 1
    let generation = composerSuggestionGeneration
    composerSuggestions.begin(generation: generation, hit: hit)
    composerMenuWasLaunched = true
    composerLauncherQuery = ""
    if case .skillFamily = composerLauncherPage {
      composerLauncherPage = .skills
      _ = composerSuggestions.publish(
        generation: generation,
        candidates: composerSkillCollectionRows(snapshot)
      )
      return
    }
    composerLauncherPage = .root
    _ = composerSuggestions.publish(
      generation: generation,
      candidates: composerCapabilityLauncherRows(
        snapshot,
        position: composerSuggestions.hit?.position ?? .leading
      )
    )
  }

  private func openComposerReferenceCollection(
    _ page: ArkComposerLauncherPage,
    hit: ArkComposerTriggerHit
  ) {
    guard selectedSessionID != nil,
          page == .files || page == .sessions
    else { return }
    composerLauncherPage = page
    composerLauncherQuery = ""
    composerLauncherFocusRevision &+= 1
    composerMenuWasLaunched = true
    scheduleComposerReferenceCollection(page, hit: hit, query: "")
  }

  public func updateComposerLauncherQuery(_ query: String) {
    guard composerLauncherPage == .files || composerLauncherPage == .sessions,
          let hit = composerSuggestions.hit
    else { return }
    composerLauncherQuery = query
    scheduleComposerReferenceCollection(composerLauncherPage, hit: hit, query: query)
  }

  private func scheduleComposerReferenceCollection(
    _ page: ArkComposerLauncherPage,
    hit: ArkComposerTriggerHit,
    query: String
  ) {
    composerSuggestionTask?.cancel()
    composerSuggestionGeneration &+= 1
    let generation = composerSuggestionGeneration
    guard let sessionID = selectedSessionID else { return }
    composerSuggestions.begin(generation: generation, hit: hit)
    composerSuggestionTask = Task { [weak self] in
      guard let self else { return }
      if !query.isEmpty {
        try? await Task.sleep(nanoseconds: 70_000_000)
        guard !Task.isCancelled else { return }
      }
      let rows: [ArkComposerSuggestion]
      let error: String?
      switch page {
      case .files:
        let load = await loadComposerFiles(sessionID: sessionID, query: query)
        rows = ArkComposerSuggestionBuilder.references(
          files: load.value ?? [],
          sessions: [],
          query: query,
          preserveQuote: false
        )
        error = load.error
      case .sessions:
        let load = await loadComposerSessions(sessionID: sessionID, query: query)
        rows = ArkComposerSuggestionBuilder.references(
          files: [],
          sessions: load.value ?? [],
          query: query,
          preserveQuote: false
        )
        error = load.error
      default:
        return
      }
      guard !Task.isCancelled,
            selectedSessionID == sessionID,
            composerDraftDocument.revision == hit.draftRevision,
            composerLauncherPage == page,
            composerLauncherQuery == query
      else { return }
      _ = composerSuggestions.publish(
        generation: generation,
        candidates: rows,
        error: rows.isEmpty ? error : nil
      )
    }
  }

  private func trackComposerSuggestions(caret: Int, isComposing: Bool) {
    guard !isComposing else {
      invalidateComposerSuggestions()
      return
    }
    guard let hit = ArkComposerTriggerDetector.detect(
      text: composerDraftDocument.text,
      caret: caret,
      revision: composerDraftDocument.revision
    ) else {
      invalidateComposerSuggestions()
      return
    }
    if composerSuggestions.hit == hit { return }
    scheduleComposerSuggestions(for: hit)
  }

  private func scheduleComposerSuggestions(for hit: ArkComposerTriggerHit) {
    composerSuggestionTask?.cancel()
    composerSuggestionGeneration &+= 1
    let generation = composerSuggestionGeneration
    let launched = composerMenuWasLaunched
    let launcherPage = composerLauncherPage
    composerSuggestions.begin(generation: generation, hit: hit)
    guard let sessionID = selectedSessionID else {
      _ = composerSuggestions.publish(
        generation: generation,
        candidates: [],
        error: ArkL10n.text(.composerSourcesNeedSession, languagePreference)
      )
      return
    }
    composerSuggestionTask = Task { [weak self] in
      guard let self else { return }
      if hit.trigger == .slash {
        let snapshot = await refreshComposerCatalog(sessionID: sessionID)
        guard !Task.isCancelled,
              selectedSessionID == sessionID,
              composerDraftDocument.revision == hit.draftRevision
        else { return }
        let rows: [ArkComposerSuggestion]
        switch launcherPage {
        case .skillFamily(let familyKey):
          if let family = composerSkillFamilies(snapshot).first(where: { $0.id == familyKey }) {
            rows = ArkComposerSuggestionBuilder.skillsOnly(family.skills)
          } else {
            rows = composerSkillCollectionRows(snapshot)
          }
        case .skills:
          rows = composerSkillCollectionRows(snapshot)
        case .root, .files, .sessions:
          if launched, hit.query.isEmpty {
            rows = composerCapabilityLauncherRows(snapshot, position: hit.position)
          } else if hit.query.isEmpty {
            let uniqueSkillCount = ArkComposerSuggestionBuilder
              .deduplicatedSkills(snapshot.skills).count
            rows = ArkComposerSuggestionBuilder.groupedSlash(
              commands: snapshot.commands,
              skills: snapshot.skills,
              skillsTitle: ArkL10n.text(.composerSkillsGroup, languagePreference),
              skillsDetail: ArkL10n.format(
                .composerSkillsCount,
                languagePreference,
                arguments: [String(uniqueSkillCount)]
              ),
              localizedCommands: localizedComposerCommands()
            )
          } else {
            rows = ArkComposerSuggestionBuilder.slash(
              commands: snapshot.commands,
              skills: snapshot.skills,
              query: hit.query,
              position: hit.position,
              localizedCommands: localizedComposerCommands()
            )
          }
        }
        let errors = [snapshot.commandError, snapshot.skillError].compactMap { $0 }
        _ = composerSuggestions.publish(
          generation: generation,
          candidates: rows,
          error: rows.isEmpty && !errors.isEmpty ? errors.joined(separator: "\n") : nil
        )
        return
      }

      try? await Task.sleep(nanoseconds: 70_000_000)
      guard !Task.isCancelled else { return }
      async let fileLoad = loadComposerFiles(sessionID: sessionID, query: hit.query)
      async let sessionLoad = hit.quoted
        ? ArkComposerCatalogLoad<[ArkComposerSessionCandidate]>(value: [], error: nil)
        : loadComposerSessions(sessionID: sessionID, query: hit.query)
      let (files, sessions) = await (fileLoad, sessionLoad)
      guard !Task.isCancelled,
            selectedSessionID == sessionID,
            composerDraftDocument.revision == hit.draftRevision
      else { return }
      let rows = ArkComposerSuggestionBuilder.references(
        files: files.value ?? [],
        sessions: sessions.value ?? [],
        query: hit.query,
        preserveQuote: hit.quoted
      )
      let errors = [files.error, sessions.error].compactMap { $0 }
      _ = composerSuggestions.publish(
        generation: generation,
        candidates: rows,
        error: rows.isEmpty && !errors.isEmpty ? errors.joined(separator: "\n") : nil
      )
    }
  }

  private func prewarmComposerCatalog(for sessionID: String?) {
    composerCatalogPrewarmTask?.cancel()
    guard let sessionID else { return }
    composerCatalogPrewarmTask = Task { [weak self] in
      guard let self else { return }
      _ = await refreshComposerCatalog(sessionID: sessionID)
    }
  }

  private func refreshComposerCatalog(
    sessionID: String,
    force: Bool = false
  ) async -> ArkComposerCatalogSnapshot {
    let existing = composerCatalogs[sessionID] ?? ArkComposerCatalogSnapshot()
    if !force, existing.commandsLoaded, existing.skillsLoaded { return existing }
    var next = existing
    let needsCommands = force || !existing.commandsLoaded
    let needsSkills = force || !existing.skillsLoaded
    if needsCommands, needsSkills {
      async let commandLoad = loadComposerCommands(sessionID: sessionID)
      async let skillLoad = loadComposerSkills(sessionID: sessionID)
      let (commands, skills) = await (commandLoad, skillLoad)
      applyComposerCommandLoad(commands, to: &next)
      applyComposerSkillLoad(skills, to: &next)
    } else if needsCommands {
      applyComposerCommandLoad(await loadComposerCommands(sessionID: sessionID), to: &next)
    } else if needsSkills {
      applyComposerSkillLoad(await loadComposerSkills(sessionID: sessionID), to: &next)
    }
    composerCatalogs[sessionID] = next
    return next
  }

  private func applyComposerCommandLoad(
    _ load: ArkComposerCatalogLoad<[ArkComposerCommand]>,
    to snapshot: inout ArkComposerCatalogSnapshot
  ) {
    if let value = load.value {
      snapshot.commands = value
      snapshot.commandsLoaded = true
      snapshot.commandError = nil
    } else {
      snapshot.commandError = load.error
    }
  }

  private func applyComposerSkillLoad(
    _ load: ArkComposerCatalogLoad<[ArkComposerSkill]>,
    to snapshot: inout ArkComposerCatalogSnapshot
  ) {
    if let value = load.value {
      snapshot.skills = value
      snapshot.skillsLoaded = true
      snapshot.skillError = nil
    } else {
      snapshot.skillError = load.error
    }
  }

  private func loadComposerCommands(
    sessionID: String
  ) async -> ArkComposerCatalogLoad<[ArkComposerCommand]> {
    do {
      return ArkComposerCatalogLoad(value: try await client.composerCommands(sessionID: sessionID), error: nil)
    } catch {
      return ArkComposerCatalogLoad(value: nil, error: error.localizedDescription)
    }
  }

  private func loadComposerSkills(
    sessionID: String
  ) async -> ArkComposerCatalogLoad<[ArkComposerSkill]> {
    do {
      return ArkComposerCatalogLoad(value: try await client.composerSkills(sessionID: sessionID), error: nil)
    } catch {
      return ArkComposerCatalogLoad(value: nil, error: error.localizedDescription)
    }
  }

  private func loadComposerFiles(
    sessionID: String,
    query: String
  ) async -> ArkComposerCatalogLoad<[ArkComposerFileCandidate]> {
    do {
      return ArkComposerCatalogLoad(
        value: try await client.composerFileReferences(sessionID: sessionID, query: query),
        error: nil
      )
    } catch {
      return ArkComposerCatalogLoad(value: nil, error: error.localizedDescription)
    }
  }

  private func loadComposerSessions(
    sessionID: String,
    query: String
  ) async -> ArkComposerCatalogLoad<[ArkComposerSessionCandidate]> {
    do {
      return ArkComposerCatalogLoad(
        value: try await client.composerSessionReferences(sessionID: sessionID, query: query),
        error: nil
      )
    } catch {
      return ArkComposerCatalogLoad(value: nil, error: error.localizedDescription)
    }
  }

  private func executeBareComposerCommand(
    _ command: ArkComposerCommand,
    previousDocument: ArkComposerDraftDocument,
    resultingRevision: UInt64
  ) {
    guard let sessionID = selectedSessionID else { return }
    Task {
      do {
        guard let execution = try await client.executeCommand(
          sessionID: sessionID,
          line: "/\(command.name)"
        ) else {
          throw ArkAPIError(message: "命令目录已经变化，请重试")
        }
        guard execution.result == .success else {
          throw ArkAPIError(message: execution.text ?? "/\(command.name) 执行失败")
        }
        await refreshHistory()
        composerErrorMessage = nil
      } catch {
        if selectedSessionID == sessionID, composerDraftDocument.revision == resultingRevision {
          installComposerDraft(previousDocument)
          persistComposerDraft(for: sessionID)
        }
        composerErrorMessage = error.localizedDescription
      }
    }
  }

  private func invalidateComposerSuggestions() {
    composerSuggestionTask?.cancel()
    composerSuggestionTask = nil
    composerMenuWasLaunched = false
    composerLauncherPage = .root
    composerLauncherQuery = ""
    composerSuggestions.close()
  }

  private func invalidateComposerCatalog(for sessionID: String? = nil) {
    if let sessionID { composerCatalogs.removeValue(forKey: sessionID) }
    else { composerCatalogs.removeAll() }
    invalidateComposerSuggestions()
    prewarmComposerCatalog(for: selectedSessionID)
  }

  private func composerSkillFamilies(
    _ snapshot: ArkComposerCatalogSnapshot
  ) -> [ArkComposerSkillFamily] {
    ArkComposerSuggestionBuilder.skillFamilies(
      snapshot.skills,
      otherTitle: ArkL10n.text(.composerOtherSkills, languagePreference)
    )
  }

  private func composerCapabilityLauncherRows(
    _ snapshot: ArkComposerCatalogSnapshot,
    position: ArkComposerTriggerPosition
  ) -> [ArkComposerSuggestion] {
    ArkComposerSuggestionBuilder.capabilityLauncher(
      commands: snapshot.commands,
      skills: snapshot.skills,
      filesTitle: ArkL10n.text(.composerLauncherFiles, languagePreference),
      filesDetail: ArkL10n.text(.composerLauncherFilesDetail, languagePreference),
      sessionsTitle: ArkL10n.text(.composerLauncherSessions, languagePreference),
      sessionsDetail: ArkL10n.text(.composerLauncherSessionsDetail, languagePreference),
      skillsTitle: ArkL10n.text(.composerLauncherPluginsSection, languagePreference),
      skillsDetail: ArkL10n.format(
        .composerSkillsCount,
        languagePreference,
        arguments: [String(ArkComposerSuggestionBuilder.deduplicatedSkills(snapshot.skills).count)]
      ),
      commandTitles: [
        "goal": ArkL10n.text(.composerGoalCommand, languagePreference),
        "plan": ArkL10n.text(.composerPlanCommand, languagePreference),
        "compact": ArkL10n.text(.composerCompactCommand, languagePreference),
      ],
      commandDetails: [
        "goal": ArkL10n.text(.composerLauncherGoalDetail, languagePreference),
        "plan": ArkL10n.text(.composerLauncherPlanDetail, languagePreference),
        "compact": ArkL10n.text(.composerLauncherCompactDetail, languagePreference),
      ],
      position: position
    )
  }

  private func composerSkillCollectionRows(
    _ snapshot: ArkComposerCatalogSnapshot
  ) -> [ArkComposerSuggestion] {
    ArkComposerSuggestionBuilder.skillCollectionRows(
      snapshot.skills,
      otherTitle: ArkL10n.text(.composerOtherSkills, languagePreference)
    ) { count in
      ArkL10n.format(
          .composerSkillFamilyCount,
          languagePreference,
          arguments: [String(count)]
      )
    }
  }

  private func installComposerDraft(_ document: ArkComposerDraftDocument) {
    composerDraftDocument = document
    composer = document.text
  }

  private func requestComposerFocus(caret: Int?) {
    composerRequestedCaret = caret
    composerFocusRevision &+= 1
  }

  private func persistComposerDraft(for sessionID: String?) {
    persistComposerDraft(composerDraftDocument, for: sessionID)
  }

  private func persistComposerDraft(
    _ document: ArkComposerDraftDocument,
    for sessionID: String?
  ) {
    if let data = try? JSONEncoder().encode(document) {
      defaults.set(data, forKey: Keys.draftDocument(sessionID))
    }
    let legacy = (try? document.serializedText()) ?? document.text
    defaults.set(legacy, forKey: Keys.draft(sessionID))
  }

  private static func loadComposerDraft(
    defaults: UserDefaults,
    sessionID: String?
  ) -> ArkComposerDraftDocument {
    if let data = defaults.data(forKey: Keys.draftDocument(sessionID)),
       let document = try? JSONDecoder().decode(ArkComposerDraftDocument.self, from: data)
    {
      return document
    }
    return ArkComposerDraftDocument(text: defaults.string(forKey: Keys.draft(sessionID)) ?? "")
  }

  deinit {
    historyTask?.cancel()
    eventTask?.cancel()
    eventResyncTask?.cancel()
    livePublishTask?.cancel()
    navigationRefreshTask?.cancel()
    sessionSearchTask?.cancel()
    composerSuggestionTask?.cancel()
    composerCatalogPrewarmTask?.cancel()
    for task in subagentCatalogTasks.values { task.cancel() }
    modelDiscoveryTask?.cancel()
    wikiTask?.cancel()
    wikiIngestPollingTask?.cancel()
    sessionExportTask?.cancel()
  }

  public var selectedSession: ArkSessionSummary? {
    selectedSessionID.flatMap { sessionSummary(for: $0) }
  }

  public var currentGoal: ArkGoalSnapshot? {
    ArkGoalSnapshot(projection: sessionProjections["goal"])
  }

  public var currentGoalMutationIsRunning: Bool {
    goalMutationSessionID == selectedSessionID
  }

  public func sessionSummary(for sessionID: String) -> ArkSessionSummary? {
    sessions.first { $0.id == sessionID } ?? catalogSubagentSummariesByID[sessionID]
  }

  /// Descendants live in the contextual lineage tree. Only a detached child
  /// whose parent is unavailable remains at the navigation root as a recovery
  /// entry, so the same subagent is never rendered twice.
  public func sessionAppearsAtNavigationRoot(_ session: ArkSessionSummary) -> Bool {
    guard session.origin == "subagent", let parentID = session.parentSessionID else { return true }
    guard sessionSummary(for: parentID) != nil else { return true }
    return archivedSessionIDs.contains(parentID)
  }

  private var allKnownSessionSummaries: [ArkSessionSummary] {
    sessions + catalogSubagentSummariesByID.values.filter { synthetic in
      !sessions.contains(where: { $0.id == synthetic.id })
    }
  }

  public func requestWorkbenchFileOpen(rootURL: URL, fileURL: URL) {
    workbenchFileOpenRequest = ArkWorkbenchFileOpenRequest(
      rootPath: rootURL.standardizedFileURL.path,
      filePath: fileURL.standardizedFileURL.path
    )
  }

  public func completeWorkbenchFileOpenRequest(_ id: UUID) {
    guard workbenchFileOpenRequest?.id == id else { return }
    workbenchFileOpenRequest = nil
  }

  public var selectedWorkspace: ArkWorkspace? {
    workspaces.first { $0.id == selectedWorkspaceID }
  }

  public var selectedSessionChildren: [ArkSessionSummary] {
    guard let selectedSessionID else { return [] }
    return allKnownSessionSummaries
      .filter { $0.parentSessionID == selectedSessionID && $0.origin == "subagent" }
      .sorted { $0.updatedAt > $1.updatedAt }
  }

  public var selectedSessionParent: ArkSessionSummary? {
    guard let parentID = selectedSession?.parentSessionID else { return nil }
    return sessionSummary(for: parentID)
  }

  public var selectedSubagentLineageRootID: String? {
    guard let selectedSession else { return nil }
    if selectedSession.origin == "subagent", let parentID = selectedSession.parentSessionID {
      return parentID
    }
    return selectedSession.id
  }

  public func subagentCatalogState(for parentSessionID: String) -> ArkSubagentCatalogViewState? {
    subagentCatalogsByParentID[parentSessionID]
  }

  public func subagentLineageRows(
    rootSessionID: String,
    expanded: Set<String>
  ) -> [ArkSubagentLineageRow] {
    ArkSubagentLineageProjection.rows(
      rootSessionID: rootSessionID,
      catalogs: subagentCatalogsByParentID,
      sessions: allKnownSessionSummaries,
      cachedEntries: subagentEntriesByID,
      expanded: expanded
    )
  }

  public func knownSubagentDescendantIDs(from rootSessionID: String) -> Set<String> {
    ArkSubagentLineageProjection.knownDescendantIDs(
      rootSessionID: rootSessionID,
      catalogs: subagentCatalogsByParentID,
      sessions: allKnownSessionSummaries,
      cachedEntries: subagentEntriesByID
    )
  }

  public func prepareSelectedSubagentLineage() {
    guard let rootSessionID = selectedSubagentLineageRootID else { return }
    guard subagentCatalogsByParentID[rootSessionID] == nil else { return }
    refreshSubagentCatalog(parentSessionID: rootSessionID)
  }

  public func refreshSubagentCatalog(
    parentSessionID: String,
    markStaleIfLoading: Bool = false
  ) {
    guard !parentSessionID.isEmpty else { return }
    if subagentCatalogTasks[parentSessionID] != nil {
      if markStaleIfLoading { subagentCatalogStaleParents.insert(parentSessionID) }
      return
    }

    let previous = subagentCatalogsByParentID[parentSessionID]
    subagentCatalogsByParentID[parentSessionID] = .loading(previous: previous)
    let task = Task { [weak self] in
      guard let self else { return }
      defer {
        self.subagentCatalogTasks[parentSessionID] = nil
        if self.subagentCatalogStaleParents.remove(parentSessionID) != nil {
          self.refreshSubagentCatalog(parentSessionID: parentSessionID)
        }
      }
      do {
        let catalog = try await self.client.subagentCatalog(parentSessionID: parentSessionID)
        guard !Task.isCancelled else { return }
        let entries = ArkSubagentLineageProjection.applyingRuntimeHints(
          catalog.entries,
          activity: self.subagentActivityHints,
          knownParents: self.subagentKnownParents
        )
        let parentAvailable = self.subagentParentAvailabilityOverrides[parentSessionID]
          ?? catalog.parentAvailable
        let hasTrailingRefresh = self.subagentCatalogStaleParents.contains(parentSessionID)
        self.installSubagentCatalog(
          parentSessionID: parentSessionID,
          entries: entries,
          parentAvailable: parentAvailable,
          authoritativeEntries: catalog.entries,
          clearRuntimeHints: !hasTrailingRefresh
        )
      } catch {
        if !self.isTaskCancellation(error) {
          self.subagentCatalogsByParentID[parentSessionID] = .failed(
            previous: self.subagentCatalogsByParentID[parentSessionID],
            message: error.localizedDescription
          )
        }
      }
    }
    subagentCatalogTasks[parentSessionID] = task
  }

  public var selectedSubagentEntry: ArkSubagentEntry? {
    selectedSessionID.flatMap { subagentEntriesByID[$0] }
  }

  public var selectedSubagentComposerState: ArkSubagentComposerState {
    ArkSubagentComposerPolicy.resolve(
      sessionOrigin: selectedSession?.origin,
      mode: selectedSubagentEntry?.mode,
      parentAvailable: selectedSessionID.flatMap { subagentParentAvailableByID[$0] }
    )
  }

  public var selectedWikiPage: ArkWikiPage? {
    wikiPages.first { $0.id == selectedWikiPageID }
  }

  public var selectedApproval: ArkApprovalRequest? {
    approvals.first { $0.sessionID == selectedSessionID }
  }

  public var selectedQuestionRequest: ArkQuestionRequest? {
    questions.first { $0.sessionID == selectedSessionID }
  }

  public var selectedPendingInteraction: ArkPendingInteraction? {
    for id in pendingInteractionOrder {
      if let request = approvals.first(where: { $0.id == id && $0.sessionID == selectedSessionID }) {
        return .approval(request)
      }
      if let request = questions.first(where: { $0.id == id && $0.sessionID == selectedSessionID }) {
        return .question(request)
      }
    }
    return nil
  }

  public var selectedPendingInteractionCount: Int {
    guard let selectedSessionID else { return 0 }
    return approvals.lazy.filter { $0.sessionID == selectedSessionID }.count
      + questions.lazy.filter { $0.sessionID == selectedSessionID }.count
  }

  public var selectedToolActivity: ArkToolActivity? {
    toolActivities.first { $0.id == selectedToolActivityID }
  }

  public func sessionIsArchived(_ sessionID: String) -> Bool {
    archivedSessionIDs.contains(sessionID)
  }

  public func archiveMutationIsRunning(_ sessionID: String) -> Bool {
    archiveMutationIDs.contains(sessionID)
  }

  public func interactionIsResponding(_ requestID: String) -> Bool {
    respondingInteractionIDs.contains(requestID)
  }

  public func feedback(for messageID: String?) -> ArkMessageFeedback? {
    messageID.flatMap { messageFeedbackByID[$0] }
  }

  public func turnMetrics(for message: ArkMessage) -> ArkChatTurnMetrics? {
    guard message.role == .assistant, let turn = message.turn else { return nil }
    return turnMetricsByTurn[turn]
  }

  func completedTurnSequence(_ turn: Int) -> Int? {
    turnProjection.completedSequenceByTurn[turn]
  }

  public func credentialReference(for provider: ArkProviderView) -> String {
    ArkSettingsSnapshot.credentialReference(for: provider, namespaces: settingsSnapshot?.namespaces ?? [])
  }

  public func newCredentialReference(for providerID: String) -> String {
    ArkSettingsSnapshot.suggestedCredentialReference(for: providerID, namespaces: settingsSnapshot?.namespaces ?? [])
  }

  public func verifyProviderConnection(provider: String, model: String) async throws -> ArkProviderVerification {
    let generation = settingsLoadGeneration
    let result = try await client.verifyProvider(provider: provider, model: model)
    guard generation == settingsLoadGeneration else { throw ArkAPIError(message: "配置已变化，请重新测试连接") }
    return result
  }

  public var defaultPermissionPreset: String? {
    settingsSnapshot?.namespaces
      .first(where: { $0.id == "permission" })?
      .value["defaultPreset"]?.stringValue
  }

  public var defaultModelSelection: ArkModelSelection? {
    guard let value = settingsSnapshot?.namespaces
      .first(where: { $0.id == "agent-default-model" })?.value,
      let provider = value["provider"]?.stringValue,
      let model = value["model"]?.stringValue,
      !provider.isEmpty,
      !model.isEmpty
    else { return nil }
    return ArkModelSelection(
      provider: provider,
      model: model,
      reasoningEffort: value["reasoningEffort"]?.stringValue
    )
  }

  /// The composer remains fully configurable before a durable Session exists.
  /// Its model directory is derived from the same provider/settings snapshot
  /// that backs Settings, so entering New Chat never needs a placeholder log.
  nonisolated static func activeComposerGroups(
    _ groups: [ArkModelProviderGroup],
    providers: [ArkProviderView]
  ) -> [ArkModelProviderGroup] {
    let activeProviderIDs = Set(providers.lazy.filter(\.active).map(\.id))
    return groups.filter { activeProviderIDs.contains($0.id) }
  }

  public var composerModelCatalog: ArkSessionModels? {
    if selectedSessionID != nil {
      guard let modelCatalog else { return nil }
      let groups = configuredModelGroups(modelCatalog.groups)
      return ArkSessionModels(current: modelCatalog.current,
        routable: modelCatalog.routable && groups.contains { group in
          group.id == modelCatalog.current.provider && group.models.contains { $0.id == modelCatalog.current.model }
        }, groups: groups, failures: modelCatalog.failures)
    }
    let groups = availableModelGroups
    guard !groups.isEmpty else { return nil }
    let selected = draftModelSelection
      ?? defaultModelSelection
      ?? ArkModelSelection(provider: groups[0].id, model: groups[0].models[0].id)
    let routable = groups.contains { group in
      group.id == selected.provider && group.models.contains { $0.id == selected.model }
    }
    return ArkSessionModels(current: selected, routable: routable, groups: groups, failures: [])
  }

  /// Global configuration choices never borrow a historical session's model directory.
  public var availableModelGroups: [ArkModelProviderGroup] {
    ArkProviderPresentation.primaryModelGroups(
      configuredModelGroups(Self.activeComposerGroups(hostModelGroups, providers: providers)))
  }

  private func configuredModelGroups(_ groups: [ArkModelProviderGroup]) -> [ArkModelProviderGroup] {
    Self.configuredModelGroups(groups, providers: providers,
      namespaces: settingsSnapshot?.namespaces ?? [], credentials: credentialStates)
  }

  nonisolated static func configuredModelGroups(
    _ groups: [ArkModelProviderGroup], providers: [ArkProviderView],
    namespaces: [ArkSettingsNamespace], credentials: [String: ArkCredentialView]
  ) -> [ArkModelProviderGroup] {
    groups.filter { group in
      // Session-local providers can exist outside the Host's configurable directory.
      guard let provider = providers.first(where: { $0.id == group.id }) else { return true }
      guard provider.active else { return false }
      guard let reference = namespaces.first(where: { $0.id == provider.settingsNamespace })?
        .value.value(at: provider.settingsPath)?["apiKeyEnv"]?.stringValue, !reference.isEmpty
      else { return true }
      return credentials[reference]?.configured == true
    }
  }

  /// 当前生效的模型选择：无会话时读 New Session draft，否则读 session 当前值。
  /// Composer 选择器的选中态（checkmark）以此为准。
  public var effectiveModelSelection: ArkModelSelection? {
    if selectedSessionID != nil { return modelCatalog?.current }
    return draftModelSelection ?? defaultModelSelection
  }

  /// The Host is authoritative for whether the selected root-session route
  /// can currently run. Continuable subagents route through their parent and
  /// are admitted by their own typed continuation contract instead.
  public var composerModelRouteAvailable: Bool {
    if selectedSession?.origin == "subagent" { return true }
    return composerModelCatalog?.routable == true
  }

  public var composerModelLabel: String {
    guard composerModelRouteAvailable else {
      return ArkL10n.text(.composerModelUnavailable, languagePreference)
    }
    if selectedSessionID != nil { return modelLabel }
    guard let selected = draftModelSelection ?? defaultModelSelection else { return "未配置模型" }
    return Self.modelDisplayLabel(
      provider: selected.provider,
      model: selected.model,
      reasoningEffort: selected.reasoningEffort
    )
  }

  /// 模型展示标签：只含 `model · effort`，不含 provider 前缀。
  /// 仅影响 presentation；provider identity、路由 key、API 参数、
  /// 持久化选择与 session log 均不受影响。
  public nonisolated static func modelDisplayLabel(
    provider: String,
    model: String,
    reasoningEffort: String?
  ) -> String {
    [model, reasoningEffort].compactMap { $0 }.joined(separator: " · ")
  }

  public var composerPermissionLabel: String {
    let raw = selectedSession?.permissionPreset
      ?? draftPermissionPreset
      ?? defaultPermissionPreset
      ?? ArkL10n.text(.permissionUnavailable, languagePreference)
    return ArkL10n.permissionPresetLabel(raw, languagePreference)
  }

  public var defaultAgentPresetID: String? {
    settingsSnapshot?.namespaces
      .first(where: { $0.id == "agent-presets" })?
      .value["default"]?.stringValue
      ?? agentPresetRoster?.presets.first(where: \.isDefault)?.id
  }

  public func loadSettings() async {
    settingsLoadGeneration &+= 1
    let generation = settingsLoadGeneration
    settingsBusy = true
    hostModelGroups = []
    modelCatalog = nil
    defer { if generation == settingsLoadGeneration { settingsBusy = false } }
    do {
      async let providerRows = client.providers()
      async let snapshot = client.settingsSnapshot()
      let loadedProviders = try await providerRows
      let loadedSnapshot = try await snapshot
      guard generation == settingsLoadGeneration else { return }
      let refs = Array(Set(loadedProviders.map { provider in
        ArkSettingsSnapshot.credentialReference(for: provider, namespaces: loadedSnapshot.namespaces)
      }))
      providers = loadedProviders
      settingsSnapshot = loadedSnapshot
      // authoritative locale 一旦到达就立即 hydrate，
      // 不依赖后续 credential/network 请求成功。
      syncLanguagePreferenceFromSettings()

      let groups = try await client.hostModels()
      guard generation == settingsLoadGeneration else { return }
      let credentials = try await client.credentialStates(refs: refs)
      guard generation == settingsLoadGeneration else { return }
      credentialStates = credentials
      hostModelGroups = groups
      if let sessionID = selectedSessionID { await refreshModelCatalog(for: sessionID) }
      guard generation == settingsLoadGeneration else { return }
      var recoveryErrors: [String] = []
      providerTransactionStates = [:]
      for provider in loadedProviders {
        do { try await refreshProviderTransaction(provider: provider.id) }
        catch { recoveryErrors.append("\(provider.displayName)：\(error.localizedDescription)") }
        guard generation == settingsLoadGeneration else { return }
      }
      settingsErrorMessage = recoveryErrors.isEmpty ? nil : recoveryErrors.joined(separator: "\n")
    } catch {
      guard generation == settingsLoadGeneration else { return }
      settingsErrorMessage = error.localizedDescription
    }
    guard generation == settingsLoadGeneration else { return }
    await loadAgentPresets()
    await loadPluginSettings()
    await loadPluginInventory()
  }

  public func loadAgentPresets() async {
    guard !agentPresetBusy else { return }
    agentPresetBusy = true
    defer { agentPresetBusy = false }
    do {
      installAgentPresetRoster(try await client.agentPresetRoster())
      agentPresetError = nil
    } catch {
      agentPresetError = error.localizedDescription
    }
  }

  public func loadPluginInventory() async {
    guard !pluginInventoryBusy else { return }
    pluginInventoryBusy = true
    defer { pluginInventoryBusy = false }
    do {
      pluginEntries = try await client.pluginInventory()
      pluginInventoryError = nil
    } catch {
      pluginInventoryError = error.localizedDescription
    }
  }

  public func loadPluginSettings() async {
    guard !pluginSettingsBusy else { return }
    pluginSettingsBusy = true
    defer { pluginSettingsBusy = false }
    do {
      pluginSettingsSnapshot = try await client.pluginSettings()
      pluginSettingsError = nil
    } catch {
      pluginSettingsError = error.localizedDescription
    }
  }

  public func saveShellPluginSettings(_ edits: [ArkShellPluginSettingsEdit]) async -> Bool {
    guard let current = pluginSettingsSnapshot?.shell else { return false }
    pluginSettingsBusy = true
    defer { pluginSettingsBusy = false }
    do {
      let updated = try await client.mutateShellPluginSettings(edits, expectedRevision: current.revision)
      if let snapshot = pluginSettingsSnapshot {
        pluginSettingsSnapshot = ArkPluginSettingsSnapshot(
          writable: snapshot.writable,
          hasDocument: snapshot.hasDocument,
          shell: updated,
          agentLoop: snapshot.agentLoop,
          webSearchDeepSeek: snapshot.webSearchDeepSeek
        )
      }
      pluginSettingsError = nil
      return true
    } catch {
      pluginSettingsSnapshot = try? await client.pluginSettings()
      pluginSettingsError = error.localizedDescription
      return false
    }
  }

  public func saveAgentLoopPluginSettings(_ edits: [ArkAgentLoopPluginSettingsEdit]) async -> Bool {
    guard let current = pluginSettingsSnapshot?.agentLoop else { return false }
    pluginSettingsBusy = true
    defer { pluginSettingsBusy = false }
    do {
      let updated = try await client.mutateAgentLoopPluginSettings(edits, expectedRevision: current.revision)
      if let snapshot = pluginSettingsSnapshot {
        pluginSettingsSnapshot = ArkPluginSettingsSnapshot(
          writable: snapshot.writable,
          hasDocument: snapshot.hasDocument,
          shell: snapshot.shell,
          agentLoop: updated,
          webSearchDeepSeek: snapshot.webSearchDeepSeek
        )
      }
      pluginSettingsError = nil
      return true
    } catch {
      pluginSettingsSnapshot = try? await client.pluginSettings()
      pluginSettingsError = error.localizedDescription
      return false
    }
  }

  public func saveWebSearchPluginSettings(
    _ edits: [ArkWebSearchDeepSeekPluginSettingsEdit]
  ) async -> Bool {
    guard let current = pluginSettingsSnapshot?.webSearchDeepSeek else { return false }
    pluginSettingsBusy = true
    defer { pluginSettingsBusy = false }
    do {
      let updated = try await client.mutateWebSearchDeepSeekPluginSettings(
        edits,
        expectedRevision: current.revision
      )
      if let snapshot = pluginSettingsSnapshot {
        pluginSettingsSnapshot = ArkPluginSettingsSnapshot(
          writable: snapshot.writable,
          hasDocument: snapshot.hasDocument,
          shell: snapshot.shell,
          agentLoop: snapshot.agentLoop,
          webSearchDeepSeek: updated
        )
      }
      pluginSettingsError = nil
      return true
    } catch {
      pluginSettingsSnapshot = try? await client.pluginSettings()
      pluginSettingsError = error.localizedDescription
      return false
    }
  }

  public func saveCredential(ref: String, secret: String) async -> Bool {
    guard !secret.isEmpty else { return true }
    do {
      try await client.setCredential(ref: ref, value: secret)
      let refreshed = try await client.credentialStates(refs: [ref])
      if let state = refreshed[ref] { credentialStates[ref] = state }
      settingsErrorMessage = nil
      return true
    } catch {
      settingsErrorMessage = error.localizedDescription
      return false
    }
  }

  /// Persist the Host-owned allowlist used by model-selectable subagent tools.
  /// The setting is sampled into each new session's durable policy by Host, so
  /// changing it never mutates an already running child definition.
  public func saveSubagentModelSelection(
    enabled: Bool,
    routes: [ArkModelSelection]
  ) async -> Bool {
    guard let snapshot = settingsSnapshot,
          snapshot.writable,
          let namespace = snapshot.namespaces.first(where: { $0.id == "subagent-model-selection" })
    else {
      settingsErrorMessage = "子代理模型选择设置当前不可写"
      return false
    }
    let unique = routes.reduce(into: [String: ArkModelSelection]()) { result, route in
      let key = "\(route.provider)\0\(route.model)"
      if result[key] == nil, !route.provider.isEmpty, !route.model.isEmpty {
        result[key] = ArkModelSelection(provider: route.provider, model: route.model)
      }
    }.values.sorted {
      if $0.provider != $1.provider { return $0.provider < $1.provider }
      return $0.model < $1.model
    }
    guard !enabled || !unique.isEmpty else {
      settingsErrorMessage = "启用子代理模型选择至少需要一个允许的模型"
      return false
    }
    settingsBusy = true
    defer { settingsBusy = false }
    do {
      let updated = try await client.mutateSettings(
        namespace: namespace.id,
        mutations: [
          .set(path: ["enabled"], value: .bool(enabled)),
          .set(path: ["allowedModels"], value: .array(unique.map { route in
            .object([
              "provider": .string(route.provider),
              "model": .string(route.model),
            ])
          })),
        ],
        expectedRevision: namespace.revision
      )
      settingsSnapshot = ArkSettingsSnapshot(
        writable: snapshot.writable,
        hasDocument: snapshot.hasDocument,
        namespaces: snapshot.namespaces.map { $0.id == updated.id ? updated : $0 }
      )
      settingsErrorMessage = nil
      postResultMessage(ArkL10n.text(.toastSubagentModelSelectionSaved, languagePreference))
      return true
    } catch {
      await loadSettings()
      settingsErrorMessage = error.localizedDescription
      return false
    }
  }

  private func commitProviderMutation(
    provider: String,
    namespace: String,
    mutations: [ArkSettingMutation],
    expectedRevision: Int,
    credential: ArkProviderCredentialMutation?
  ) async throws -> ArkSettingsNamespace {
    let transactionID = providerTransactions.transactionID(for: provider)
    do {
      let updated = try await client.mutateProvider(
        provider: provider,
        namespace: namespace,
        mutations: mutations,
        expectedRevision: expectedRevision,
        credential: credential,
        transactionID: transactionID
      )
      providerTransactions.clear(provider: provider, transactionID: transactionID)
      if providerTransactionStates[provider]?.transactionID == transactionID {
        providerTransactionStates.removeValue(forKey: provider)
      }
      return updated
    } catch {
      // A transport error cannot establish whether the durable claim completed.
      if let status = try? await client.providerTransaction(provider: provider, transactionID: transactionID) {
        providerTransactions.acknowledge(provider: provider, transactionID: transactionID, state: status.state)
        if providerTransactions.pendingTransactionID(for: provider) == transactionID {
          providerTransactionStates[provider] = status
        } else if providerTransactionStates[provider]?.transactionID == transactionID {
          providerTransactionStates.removeValue(forKey: provider)
        }
      }
      throw error
    }
  }

  private func refreshProviderTransaction(provider: String) async throws {
    let generation = settingsLoadGeneration
    guard let transactionID = providerTransactions.pendingTransactionID(for: provider) else {
      providerTransactionStates.removeValue(forKey: provider)
      return
    }
    let status = try await client.providerTransaction(provider: provider, transactionID: transactionID)
    guard generation == settingsLoadGeneration else { return }
    guard providerTransactions.pendingTransactionID(for: provider) == transactionID else { return }
    providerTransactionStates[provider] = status
  }

  /// Resume only after the user selects the pending operation; loading Settings is read-only.
  public func restoreProviderConfiguration(
    provider: ArkProviderView, transactionID: String, credentialValue: String? = nil
  ) async -> Bool {
    guard !settingsBusy else { return false }
    guard providerTransactions.pendingTransactionID(for: provider.id) == transactionID else {
      await loadSettings()
      settingsErrorMessage = "恢复状态已变化，请查看刷新后的结果。"
      return false
    }
    settingsBusy = true
    defer { settingsBusy = false }
    do {
      _ = try await client.resumeProvider(
        provider: provider.id, transactionID: transactionID, credentialValue: credentialValue
      )
      providerTransactions.clear(provider: provider.id, transactionID: transactionID)
      if providerTransactionStates[provider.id]?.transactionID == transactionID {
        providerTransactionStates.removeValue(forKey: provider.id)
      }
      await loadSettings()
      postResultMessage("此前的 Provider 配置保存已恢复。")
      return true
    } catch {
      if let status = try? await client.providerTransaction(provider: provider.id, transactionID: transactionID) {
        providerTransactions.acknowledge(provider: provider.id, transactionID: transactionID, state: status.state)
      }
      await loadSettings()
      settingsErrorMessage = error.localizedDescription
      return false
    }
  }

  public func saveProviderCredential(provider: ArkProviderView, ref: String, secret: String) {
    let normalizedRef = ref.trimmingCharacters(in: .whitespacesAndNewlines)
    guard normalizedRef.range(of: #"^[A-Za-z_][A-Za-z0-9_]*$"#, options: .regularExpression) != nil else {
      settingsErrorMessage = "凭据引用必须是大写字母、数字或下划线组成的环境变量名称"
      return
    }
    guard !secret.isEmpty else { settingsErrorMessage = "API Key 不能为空"; return }
    Task {
      settingsBusy = true
      defer { settingsBusy = false }
      do {
        guard let snapshot = settingsSnapshot,
              let namespace = snapshot.namespaces.first(where: { $0.id == provider.settingsNamespace })
        else { throw ArkAPIError(message: "Provider 设置尚未载入") }
        let mutations: [ArkSettingMutation] = [
          .set(path: provider.settingsPath + ["apiKeyEnv"], value: .string(normalizedRef)),
        ]
        let updated = try await commitProviderMutation(
          provider: provider.id,
          namespace: namespace.id,
          mutations: mutations,
          expectedRevision: namespace.revision,
          credential: .set(ref: normalizedRef, value: secret)
        )
        settingsSnapshot = ArkSettingsSnapshot(
          writable: snapshot.writable,
          hasDocument: snapshot.hasDocument,
          namespaces: snapshot.namespaces.map { $0.id == updated.id ? updated : $0 }
        )
        await loadSettings()
        postResultMessage(ArkL10n.format(.toastCredentialSavedSecure, languagePreference, arguments: [provider.displayName]))
        settingsErrorMessage = nil
      } catch {
        settingsErrorMessage = error.localizedDescription
      }
    }
  }

  public func saveProviderConfiguration(
    provider: ArkProviderView,
    credentialRef: String,
    secret: String,
    displayName: String,
    baseURL: String,
    api: String,
    models: [ArkProviderModelInput],
    migrateLegacyCredentials: Bool = false
  ) async -> Bool {
    let ref = credentialRef.trimmingCharacters(in: .whitespacesAndNewlines)
    guard ref.range(of: #"^[A-Za-z_][A-Za-z0-9_]*$"#, options: .regularExpression) != nil else {
      settingsErrorMessage = "凭据引用格式无效"
      return false
    }
    guard let snapshot = settingsSnapshot,
          snapshot.writable,
          let namespace = snapshot.namespaces.first(where: { $0.id == provider.settingsNamespace })
    else {
      settingsErrorMessage = "Provider 设置当前不可写"
      return false
    }
    if let migration = provider.migrationRequired,
       !migration.canMigrateUserFields || !migrateLegacyCredentials || secret.isEmpty {
      settingsErrorMessage = migration.canMigrateUserFields
        ? "请明确选择迁移旧凭据字段并重新输入密钥。"
        : "旧凭据来自部署配置或缺少安全迁移路径，请先修正其配置来源。"
      return false
    }
    settingsBusy = true
    defer { settingsBusy = false }
    do {
      let currentProfile = namespace.value.value(at: provider.settingsPath)?.objectValue ?? [:]
      var mutations: [ArkSettingMutation] = []
      let path = provider.settingsPath
      if migrateLegacyCredentials, let paths = provider.migrationRequired?.paths {
        mutations.append(contentsOf: paths.map { .unset(path: path + $0) })
      }
      if !secret.isEmpty {
        mutations.append(.set(path: path + ["apiKeyEnv"], value: .string(ref)))
      }
      let name = displayName.trimmingCharacters(in: .whitespacesAndNewlines)
      if provider.declared == true {
        mutations.append(name.isEmpty
          ? .unset(path: path + ["displayName"])
          : .set(path: path + ["displayName"], value: .string(name)))
      }
      let endpoint = baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
      mutations.append(endpoint.isEmpty
        ? .unset(path: path + ["baseURL"])
        : .set(path: path + ["baseURL"], value: .string(endpoint)))
      if !api.isEmpty, provider.declared == true {
        mutations.append(.set(path: path + ["api"], value: .string(api)))
      }
      if !models.isEmpty {
        let rows = ArkProviderModelInput.encodedRows(
          models,
          preserving: currentProfile["models"]?.arrayValue ?? []
        )
        mutations.append(.set(path: path + ["models"], value: .array(rows)))
      } else if provider.settingsNamespace == "llm-pi-ai", provider.declared != true {
        mutations.append(.set(path: path + ["models"], value: .array([])))
      } else {
        mutations.append(.unset(path: path + ["models"]))
      }
      let updated = try await commitProviderMutation(
        provider: provider.id,
        namespace: namespace.id,
        mutations: mutations,
        expectedRevision: namespace.revision,
        credential: secret.isEmpty ? nil : .set(ref: ref, value: secret)
      )
      settingsSnapshot = ArkSettingsSnapshot(
        writable: snapshot.writable,
        hasDocument: snapshot.hasDocument,
        namespaces: snapshot.namespaces.map { $0.id == updated.id ? updated : $0 }
      )
      await loadSettings()
      postResultMessage(ArkL10n.format(.toastSavedProvider, languagePreference, arguments: [provider.displayName]))
      settingsErrorMessage = nil
      return true
    } catch {
      await loadSettings()
      settingsErrorMessage = error.localizedDescription
      return false
    }
  }

  public func removeProviderProfile(_ provider: ArkProviderView) {
    guard !provider.settingsPath.isEmpty,
          let snapshot = settingsSnapshot,
          snapshot.writable,
          let namespace = snapshot.namespaces.first(where: { $0.id == provider.settingsNamespace }),
          namespace.user?.value(at: provider.settingsPath) != nil,
          namespace.base?.value(at: provider.settingsPath) == nil
    else {
      settingsErrorMessage = "此 Provider 不能从设置页面移除"
      return
    }
    Task {
      settingsBusy = true
      defer { settingsBusy = false }
      do {
        let ref = credentialReference(for: provider)
        let managedRef = suggestedCredentialReference(for: provider.id)
        let credential: ArkProviderCredentialMutation? =
          ref == managedRef
            && credentialStates[ref]?.configured == true
            && credentialStates[ref]?.writable == true
          ? .unset(ref: ref)
          : nil
        _ = try await commitProviderMutation(
          provider: provider.id,
          namespace: namespace.id,
          mutations: [.unset(path: provider.settingsPath)],
          expectedRevision: namespace.revision,
          credential: credential
        )
        await loadSettings()
        postResultMessage(ArkL10n.format(.toastRemovedProvider, languagePreference, arguments: [provider.displayName]))
        settingsErrorMessage = nil
      } catch {
        await loadSettings()
        settingsErrorMessage = error.localizedDescription
      }
    }
  }

  public func discoverProviderModels(
    provider: ArkProviderView?,
    baseURL: String,
    api: String,
    unsavedAPIKey: String
  ) {
    modelDiscoveryTask?.cancel()
    modelDiscoveryBusy = true
    modelDiscoveryError = nil
    let client = client
    modelDiscoveryTask = Task { [weak self] in
      do {
        let candidates = try await client.discoverModels(
          settingsNamespace: provider?.settingsNamespace ?? "llm-pi-ai",
          provider: provider?.id,
          baseURL: baseURL.trimmingCharacters(in: .whitespacesAndNewlines),
          api: api,
          apiKey: unsavedAPIKey
        )
        guard !Task.isCancelled, let self else { return }
        self.discoveredModels = candidates
        self.modelDiscoveryBusy = false
        self.modelDiscoveryTask = nil
      } catch {
        guard !Task.isCancelled, let self else { return }
        self.discoveredModels = []
        self.modelDiscoveryError = error.localizedDescription
        self.modelDiscoveryBusy = false
        self.modelDiscoveryTask = nil
      }
    }
  }

  public func clearDiscoveredModels() {
    modelDiscoveryTask?.cancel()
    modelDiscoveryTask = nil
    modelDiscoveryBusy = false
    discoveredModels = []
    modelDiscoveryError = nil
  }

  public func removeProviderCredential(provider: ArkProviderView) {
    let ref = credentialReference(for: provider)
    Task {
      settingsBusy = true
      defer { settingsBusy = false }
      do {
        try await client.unsetCredential(ref: ref)
        await loadSettings()
        postResultMessage(ArkL10n.format(.toastCredentialRemoved, languagePreference, arguments: [provider.displayName]))
        settingsErrorMessage = nil
      } catch {
        settingsErrorMessage = error.localizedDescription
      }
    }
  }

  public func addCustomProvider(
    id: String,
    displayName: String,
    baseURL: String,
    api: String,
    models: [ArkProviderModelInput],
    credentialRef: String,
    secret: String
  ) async -> Bool {
    let providerID = id.trimmingCharacters(in: .whitespacesAndNewlines)
    let name = displayName.trimmingCharacters(in: .whitespacesAndNewlines)
    let endpoint = baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
    let modelIDs = models.map { $0.id.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
    let ref = credentialRef.trimmingCharacters(in: .whitespacesAndNewlines)
    guard providerID.range(of: #"^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$"#, options: .regularExpression) != nil else {
      settingsErrorMessage = "Provider ID 必须是小写字母、数字和连字符组成的标识"
      return false
    }
    guard !providers.contains(where: { $0.id == providerID }) else {
      settingsErrorMessage = "已有 Provider 使用这个 ID"
      return false
    }
    let endpointScheme = URL(string: endpoint)?.scheme?.lowercased()
    guard ["http", "https"].contains(endpointScheme ?? ""), !modelIDs.isEmpty,
          Set(modelIDs).count == modelIDs.count,
          models.allSatisfy({ ($0.contextWindow ?? 1) > 0 && ($0.maxTokens ?? 1) > 0 })
    else {
      settingsErrorMessage = "有效的 API 地址和至少一个模型不能为空"
      return false
    }
    guard ref.range(of: #"^[A-Za-z_][A-Za-z0-9_]*$"#, options: .regularExpression) != nil else {
      settingsErrorMessage = "凭据引用格式无效"
      return false
    }
    guard let snapshot = settingsSnapshot,
          snapshot.writable,
          let namespace = snapshot.namespaces.first(where: { $0.id == "llm-pi-ai" })
    else {
      settingsErrorMessage = "本机服务没有提供可写的自定义 Provider 设置"
      return false
    }
    settingsBusy = true
    defer { settingsBusy = false }
    do {
      var profile: [String: JSONValue] = [
        "baseURL": .string(endpoint),
        "api": .string(api),
        "models": .array(models.map { input in
          var row: [String: JSONValue] = ["id": .string(input.id)]
          if let name = input.name, !name.isEmpty { row["name"] = .string(name) }
          if let context = input.contextWindow { row["contextWindow"] = .number(Double(context)) }
          if let maxTokens = input.maxTokens { row["maxTokens"] = .number(Double(maxTokens)) }
          return .object(row)
        }),
      ]
      if !name.isEmpty { profile["displayName"] = .string(name) }
      if !secret.isEmpty { profile["apiKeyEnv"] = .string(ref) }
      let updated = try await commitProviderMutation(
        provider: providerID,
        namespace: namespace.id,
        mutations: [.set(path: ["providers", providerID], value: .object(profile))],
        expectedRevision: namespace.revision,
        credential: secret.isEmpty ? nil : .set(ref: ref, value: secret)
      )
      settingsSnapshot = ArkSettingsSnapshot(
        writable: snapshot.writable,
        hasDocument: snapshot.hasDocument,
        namespaces: snapshot.namespaces.map { $0.id == updated.id ? updated : $0 }
      )
      await loadSettings()
      postResultMessage(ArkL10n.text(.toastCustomProviderSaved, languagePreference))
      settingsErrorMessage = nil
      return true
    } catch {
      await loadSettings()
      settingsErrorMessage = error.localizedDescription
      return false
    }
  }

  public func openSettingsDocument() {
    Task {
      do { try await client.openSettingsDocument() }
      catch { settingsErrorMessage = error.localizedDescription }
    }
  }

  public func setDefaultPermissionPreset(_ preset: String) {
    guard let snapshot = settingsSnapshot,
          snapshot.writable,
          let namespace = snapshot.namespaces.first(where: { $0.id == "permission" })
    else {
      settingsErrorMessage = "本机服务没有提供可写的默认权限设置"
      return
    }
    Task {
      settingsBusy = true
      defer { settingsBusy = false }
      do {
        let updated = try await client.mutateSetting(
          namespace: namespace.id,
          path: ["defaultPreset"],
          value: .string(preset),
          expectedRevision: namespace.revision
        )
        settingsSnapshot = ArkSettingsSnapshot(
          writable: snapshot.writable,
          hasDocument: snapshot.hasDocument,
          namespaces: snapshot.namespaces.map { $0.id == updated.id ? updated : $0 }
        )
        settingsErrorMessage = nil
      } catch {
        await loadSettings()
        settingsErrorMessage = error.localizedDescription
      }
    }
  }

  /// Persist the preset used by sessions created after this change.
  /// This Settings action deliberately does not mutate the currently selected
  /// session, including a blank session that is already open.
  public func setDefaultAgentPreset(_ preset: String) {
    guard agentPresetRoster?.presets.contains(where: { $0.id == preset && $0.broken == nil }) == true,
          let snapshot = settingsSnapshot,
          snapshot.writable,
          let namespace = snapshot.namespaces.first(where: { $0.id == "agent-presets" })
    else {
      agentPresetError = "本机服务没有提供可写的默认 Agent 预设设置"
      return
    }
    Task {
      agentPresetBusy = true
      defer { agentPresetBusy = false }
      do {
        let updated = try await client.mutateSetting(
          namespace: namespace.id,
          path: ["default"],
          value: .string(preset),
          expectedRevision: namespace.revision
        )
        settingsSnapshot = ArkSettingsSnapshot(
          writable: snapshot.writable,
          hasDocument: snapshot.hasDocument,
          namespaces: snapshot.namespaces.map { $0.id == updated.id ? updated : $0 }
        )
        nextAgentPresetID = preset
        installAgentPresetRoster(try await client.agentPresetRoster())
        agentPresetError = nil
      } catch {
        await loadSettings()
        agentPresetError = error.localizedDescription
      }
    }
  }

  private var appearanceGate = ArkSingleFlightLatestGate()

  /// 外观偏好写入：single-flight + latest-intent 合并。
  /// 写入在飞时新意图只覆盖 pending，绝不并发提交第二个 ui-theme mutation；
  /// 每个意图用当时快照的最新 revision 提交；任一真实失败即停止（不自动重试）。
  public func setAppearancePreference(_ preference: String) {
    guard ["light", "dark", "system"].contains(preference) else { return }
    appearanceGate.intent(preference)
    guard let first = appearanceGate.begin() else { return }
    Task { [weak self] in
      guard let self else { return }
      var intent: String? = first
      while let next = intent {
        guard await self.writeAppearancePreference(next) else { break }
        intent = self.appearanceGate.takePending()
      }
      self.appearanceGate.finish()
    }
  }

  /// 单次 ui-theme 写：本地外观不依赖 Host；仅在可写 namespace 存在时持久化。
  private func writeAppearancePreference(_ preference: String) async -> Bool {
    guard let snapshot = settingsSnapshot,
          snapshot.writable,
          let namespace = snapshot.namespaces.first(where: { $0.id == "ui-theme" })
    else {
      return true
    }
    guard namespace.value["preference"]?.stringValue != preference else { return true }
    settingsBusy = true
    defer { settingsBusy = false }
    do {
      let updated = try await client.mutateSetting(
        namespace: namespace.id,
        path: ["preference"],
        value: .string(preference),
        expectedRevision: namespace.revision
      )
      settingsSnapshot = ArkSettingsSnapshot(
        writable: snapshot.writable,
        hasDocument: snapshot.hasDocument,
        namespaces: snapshot.namespaces.map { $0.id == updated.id ? updated : $0 }
      )
      settingsErrorMessage = nil
      return true
    } catch {
      await loadSettings()
      settingsErrorMessage = error.localizedDescription
      return false
    }
  }

  private var languageGate = ArkSingleFlightLatestGate()

  /// 界面语言切换：本地乐观即时生效 + single-flight/latest-intent 持久化。
  /// 每次真正 mutate 前读取最新 settingsSnapshot/locale revision；
  /// 写入失败回正到 authoritative locale。不影响模型回答语言。
  public func setLanguagePreference(_ preference: String) {
    guard ArkLanguagePreference.allCases.contains(where: { $0.rawValue == preference }) else { return }
    // 乐观更新：UI 立即切换，不等待写回。通知仅供 AppKit 非 SwiftUI 消费者（主菜单）。
    let selected = ArkLanguagePreference(rawValue: preference)
    guard ArkLanguagePreference.allCases.contains(selected), selected != languagePreference else { return }
    languagePreference = selected
    relocalizeStatusRows()
    defaults.set(selected.rawValue, forKey: Keys.language)
    NotificationCenter.default.post(name: .arkLanguageChanged, object: selected.rawValue)
    Task { [weak self] in await self?.loadWiki(refreshIngestQueue: false) }
    languageGate.intent(preference)
    guard let first = languageGate.begin() else { return }
    Task { [weak self] in
      guard let self else { return }
      var intent: String? = first
      while let next = intent {
        guard await self.writeLanguagePreference(next) else { break }
        intent = self.languageGate.takePending()
      }
      self.languageGate.finish()
    }
  }

  /// 单次 locale 写：使用调用时刻快照的最新 revision；失败返回 false 并回正语言状态。
  private func writeLanguagePreference(_ preference: String) async -> Bool {
    guard let snapshot = settingsSnapshot,
          snapshot.writable,
          let namespace = snapshot.namespaces.first(where: { $0.id == "locale" })
    else {
      // Native-only deployments may deliberately omit the Host locale plugin.
      // The language registry and this non-secret preference still make a
      // compiled extension language usable without a Web/settings service.
      defaults.set(preference, forKey: Keys.language)
      return true
    }
    guard namespace.value["preference"]?.stringValue != preference else { return true }
    settingsBusy = true
    defer { settingsBusy = false }
    do {
      let updated = try await client.mutateSetting(
        namespace: namespace.id,
        path: ["preference"],
        value: .string(preference),
        expectedRevision: namespace.revision
      )
      settingsSnapshot = ArkSettingsSnapshot(
        writable: snapshot.writable,
        hasDocument: snapshot.hasDocument,
        namespaces: snapshot.namespaces.map { $0.id == updated.id ? updated : $0 }
      )
      defaults.set(preference, forKey: Keys.language)
      settingsErrorMessage = nil
      return true
    } catch {
      await loadSettings()
      syncLanguagePreferenceFromSettings()
      settingsErrorMessage = error.localizedDescription
      return false
    }
  }

  /// 以 authoritative locale namespace 为准回正界面语言。
  private func syncLanguagePreferenceFromSettings() {
    let raw = settingsSnapshot?.namespaces
      .first(where: { $0.id == "locale" })?
      .value["preference"]?.stringValue
      ?? defaults.string(forKey: Keys.language)
      ?? "zh"
    guard ArkLanguagePreference.allCases.contains(where: { $0.rawValue == raw }) else { return }
    let preference = ArkLanguagePreference(rawValue: raw)
    defaults.set(preference.rawValue, forKey: Keys.language)
    guard preference != languagePreference else { return }
    languagePreference = preference
    relocalizeStatusRows()
    NotificationCenter.default.post(name: .arkLanguageChanged, object: preference.rawValue)
    Task { [weak self] in await self?.loadWiki(refreshIngestQueue: false) }
  }

  /// 语言切换时按新语言重建状态行投影，保留本地瞬态错误行。
  private func relocalizeStatusRows() {
    var known = Set<Int>()
    let merged = (events + pendingLiveEvents)
      .filter { known.insert($0.id).inserted }
      .sorted { $0.id < $1.id }
    let transient = chatStatuses.filter {
      $0.id.hasPrefix("host-agent-error-") || $0.id.hasPrefix("stream-error-")
    }
    statusProjection = ArkChatStatusProjection(events: merged, language: languagePreference)
    chatStatuses = statusProjection.statuses + transient
    chatStatuses.sort {
      $0.sequence == $1.sequence ? $0.id < $1.id : $0.sequence < $1.sequence
    }
  }

  private func suggestedCredentialReference(for providerID: String) -> String {
    providerID.uppercased().map { character in
      character.isLetter || character.isNumber ? String(character) : "_"
    }.joined() + "_API_KEY"
  }

  private func installAgentPresetRoster(_ roster: ArkAgentPresetRoster) {
    agentPresetRoster = roster
    let selectable = roster.presets.filter { $0.broken == nil }
    if let nextAgentPresetID, selectable.contains(where: { $0.id == nextAgentPresetID }) { return }
    nextAgentPresetID = selectable.first(where: { $0.id == "cordis" })?.id
      ?? selectable.first(where: \.isDefault)?.id
      ?? selectable.first?.id
  }

  public func readAgentPreset(_ id: String) {
    Task {
      agentPresetBusy = true
      defer { agentPresetBusy = false }
      do {
        selectedPresetDocument = try await client.readAgentPreset(id: id)
        agentPresetError = nil
      } catch {
        agentPresetError = error.localizedDescription
      }
    }
  }

  public func closeAgentPresetDocument() {
    selectedPresetDocument = nil
  }

  public func selectAgentPresetForCurrentSession(_ id: String) {
    nextAgentPresetID = id
    guard let sessionID = selectedSessionID, selectedSession?.blank == true else {
      return
    }
    Task {
      agentPresetBusy = true
      defer { agentPresetBusy = false }
      do {
        try await client.selectAgentPreset(sessionID: sessionID, presetID: id)
        await refreshNavigation(refreshWiki: false)
        agentPresetError = nil
      } catch { agentPresetError = error.localizedDescription }
    }
  }

  public func copyAgentPreset(from source: String, to target: String, name: String) {
    let normalizedTarget = target.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !normalizedTarget.isEmpty else {
      agentPresetError = "新预设标识不能为空"
      return
    }
    Task {
      agentPresetBusy = true
      defer { agentPresetBusy = false }
      do {
        try await client.copyAgentPreset(
          from: source,
          to: normalizedTarget,
          name: name.trimmingCharacters(in: .whitespacesAndNewlines)
        )
        installAgentPresetRoster(try await client.agentPresetRoster())
        agentPresetError = nil
        postResultMessage(ArkL10n.text(.toastPresetCopied, languagePreference))
      } catch { agentPresetError = error.localizedDescription }
    }
  }

  public func openAgentPreset(_ id: String) {
    Task {
      agentPresetBusy = true
      defer { agentPresetBusy = false }
      do {
        let path = try await client.openAgentPreset(id: id)
        agentPresetError = nil
        if let path { postResultMessage(ArkL10n.format(.toastPresetPath, languagePreference, arguments: [path])) }
      } catch { agentPresetError = error.localizedDescription }
    }
  }

  public func removeAgentPreset(_ id: String) {
    Task {
      agentPresetBusy = true
      defer { agentPresetBusy = false }
      do {
        try await client.removeAgentPreset(id: id)
        if nextAgentPresetID == id { nextAgentPresetID = nil }
        if selectedPresetDocument?.id == id { selectedPresetDocument = nil }
        installAgentPresetRoster(try await client.agentPresetRoster())
        agentPresetError = nil
        postResultMessage(ArkL10n.text(.toastPresetDeleted, languagePreference))
      } catch { agentPresetError = error.localizedDescription }
    }
  }

  public func start() {
    guard eventLifecycle == .idle else { return }
    eventLifecycle = .running
    eventTask = Task { [weak self, eventPump] in
      guard !Task.isCancelled else { return }
      await eventPump.start()
      guard !Task.isCancelled else { return }
      while !Task.isCancelled, let frame = await eventPump.nextEvent() {
        guard let self else { break }
        self.consume(frame)
      }
    }
    Task {
      let restoredSession = startupRestoredSessionID
      let restoredTab = startupRestoredTab
      startupRestoredSessionID = nil
      startupRestoredTab = .chat
      async let navigation: Void = refreshNavigation()
      async let settings: Void = loadSettings()
      _ = await (navigation, settings)
      if let restoredSession,
         sessions.contains(where: { $0.id == restoredSession && !$0.blank }) {
        // 程序化恢复不得导航：用户已先行选 Tab 时保持不动。
        selectSession(restoredSession, navigateToChat: false)
        if !userHasNavigated {
          selectedTab = restoredTab
        }
      } else {
        selectedSessionID = nil
        if !userHasNavigated {
          selectedTab = .chat
        }
        installComposerDraft(Self.loadComposerDraft(defaults: defaults, sessionID: nil))
        defaults.removeObject(forKey: Keys.session)
      }
    }
  }

  /// Stop event delivery and await both WebSocket pumps before the owner releases this model.
  public func shutdown() async {
    let discovery = modelDiscoveryTask
    clearDiscoveredModels()
    if let discovery { await discovery.value }
    if let eventShutdownTask {
      await eventShutdownTask.value
      return
    }
    guard eventLifecycle != .stopped else { return }
    eventLifecycle = .stopping
    let consumer = eventTask
    eventTask = nil
    consumer?.cancel()
    eventResyncTask?.cancel()
    eventResyncTask = nil
    let eventPump = eventPump
    let eventShutdownTask = Task {
      await eventPump.stop()
      if let consumer { await consumer.value }
    }
    self.eventShutdownTask = eventShutdownTask
    await eventShutdownTask.value
    eventLifecycle = .stopped
    self.eventShutdownTask = nil
  }

  public func refreshNavigation(refreshWiki: Bool = true) async {
    do {
      async let workspaceSnapshot = client.workspaceList()
      async let sessionRows = client.sessions()
      let snapshot = try await workspaceSnapshot
      let protected = snapshot.items.filter {
        JiuzhangShellContract.protectedWorkspaceReason(path: $0.path) != nil
      }
      for workspace in protected {
        _ = try? await client.deleteWorkspace(workspaceID: workspace.id)
      }
      let nextWorkspaces = snapshot.items.filter { workspace in
        !protected.contains(where: { $0.id == workspace.id })
      }
      let nextSessions = try await sessionRows
      if workspaces != nextWorkspaces { workspaces = nextWorkspaces }
      if archivedSessionIDs != snapshot.archivedSessionIDs {
        archivedSessionIDs = snapshot.archivedSessionIDs
      }
      if sessions != nextSessions { sessions = nextSessions }
      if let selectedWorkspaceID,
         !workspaces.contains(where: { $0.id == selectedWorkspaceID }) {
        self.selectedWorkspaceID = nil
        defaults.removeObject(forKey: Keys.workspace)
      }
      if refreshWiki { await loadWiki() }
      // 受保护目录的工作区注册清理是后台自动维护：成功完全静默，失败走 navigationErrorMessage。
      if eventConnectionStates[.host] != .degraded { navigationErrorMessage = nil }
    } catch {
      // 导航刷新被更新的刷新取消是正常生命周期，不是用户错误。
      if isTaskCancellation(error) { return }
      navigationErrorMessage = error.localizedDescription
    }
  }

  /// 选中会话并恢复其对话表面。用户从侧栏点选时导航到对话页；
  /// 启动恢复等程序化路径可传 `navigateToChat: false` 避免覆盖用户已选的 Tab。
  public func selectSession(_ sessionID: String, navigateToChat: Bool = true) {
    navigationErrorMessage = nil
    cacheCurrentConversationSurface()
    let previousWorkspaceID = selectedWorkspaceID
    if let owner = workspaces.first(where: { $0.sessionIDs.contains(sessionID) }) {
      selectedWorkspaceID = owner.id
    } else if let cwd = sessionSummary(for: sessionID)?.cwd {
      let normalized = URL(fileURLWithPath: cwd, isDirectory: true).standardizedFileURL.path
      let owner = workspaces
        .filter { normalized == $0.path || normalized.hasPrefix($0.path + "/") }
        .max { $0.path.count < $1.path.count }
      selectedWorkspaceID = owner?.id
    } else {
      selectedWorkspaceID = nil
    }
    if selectedWorkspaceID != previousWorkspaceID {
      wikiTask?.cancel()
      wikiTask = Task { [weak self] in await self?.loadWiki() }
    }
    selectedSessionID = sessionID
    messageImages.configure(sessionID: sessionID)
    prepareSelectedSubagentLineage()
    if navigateToChat {
      selectedTab = .chat
    }
    events = []
    turnProjection = ArkChatTurnProjection()
    messages = []
    toolActivities = []
    producedFiles = []
    chatStatuses = []
    selectedToolActivityID = nil
    messageFeedbackByID = [:]
    messageFeedbackAvailable = false
    sessionProjections = [:]
    sessionJobs = []
    queuedPrompts = []
    queueMutationIDs = []
    hasOlderHistory = false
    loadingOlderHistory = false
    historyLoadState = .loading
    historyBeforeSequence = nil
    pendingLiveEvents = []
    seenEventIDs = []
    messageProjection.reset(events: [])
    toolProjection.reset(events: [])
    producedFilesProjection.reset(events: [])
    statusProjection.reset(events: [])
    livePublishTask?.cancel()
    livePublishTask = nil
    historyTask?.cancel()
    eventResyncTask?.cancel()
    eventResyncTask = nil
    historyProjectionGeneration &+= 1
    historyFoldOwner = nil
    historyRefreshOwner = nil
    olderHistoryLoadOwner = nil
    modelCatalog = nil
    modelLabel = "未配置模型"
    turnUsageByTurn = [:]
    restoreConversationSurface(for: sessionID)
    chatPresentationDidChange.send()
    historyTask = Task { [weak self] in
      guard let self else { return }
      let resetHistory = self.events.isEmpty
      async let history: Void = self.refreshHistory(resetPaging: resetHistory)
      async let feedback: Void = self.loadMessageFeedback(for: sessionID)
      async let modelLabel: Void = self.refreshModelLabel(for: sessionID)
      async let modelCatalog: Void = self.refreshModelCatalog(for: sessionID)
      if self.selectedSession?.origin == "subagent" {
        _ = try? await self.subagentAddress(for: sessionID)
      }
      _ = await (history, feedback, modelLabel, modelCatalog)
    }
  }

  private func cacheCurrentConversationSurface() {
    guard let sessionID = selectedSessionID,
          !events.isEmpty || !messages.isEmpty || !toolActivities.isEmpty || !chatStatuses.isEmpty
    else { return }
    conversationSurfaceSnapshots[sessionID] = ArkConversationSurfaceSnapshot(
      events: events,
      messageProjection: messageProjection,
      toolProjection: toolProjection,
      producedFilesProjection: producedFilesProjection,
      statusProjection: statusProjection,
      historyBeforeSequence: historyBeforeSequence,
      hasOlderHistory: hasOlderHistory,
      messages: messages,
      toolActivities: toolActivities,
      producedFiles: producedFiles,
      chatStatuses: chatStatuses,
      turnProjection: turnProjection,
      turnUsageByTurn: turnUsageByTurn,
      feedback: messageFeedbackByID,
      feedbackAvailable: messageFeedbackAvailable,
      sessionProjections: sessionProjections,
      modelLabel: modelLabel
    )
    conversationSurfaceSnapshotOrder.removeAll { $0 == sessionID }
    conversationSurfaceSnapshotOrder.append(sessionID)
    while conversationSurfaceSnapshotOrder.count > 2 {
      let evicted = conversationSurfaceSnapshotOrder.removeFirst()
      conversationSurfaceSnapshots.removeValue(forKey: evicted)
    }
  }

  private func restoreConversationSurface(for sessionID: String) {
    guard let snapshot = conversationSurfaceSnapshots[sessionID] else { return }
    events = snapshot.events
    pendingLiveEvents = []
    seenEventIDs = Set(snapshot.events.map(\.id))
    messageProjection = snapshot.messageProjection
    toolProjection = snapshot.toolProjection
    producedFilesProjection = snapshot.producedFilesProjection
    statusProjection = snapshot.statusProjection
    historyBeforeSequence = snapshot.historyBeforeSequence
    hasOlderHistory = snapshot.hasOlderHistory
    messages = snapshot.messages
    toolActivities = snapshot.toolActivities
    producedFiles = snapshot.producedFiles
    chatStatuses = snapshot.chatStatuses
    turnProjection = snapshot.turnProjection
    turnUsageByTurn = snapshot.turnUsageByTurn
    messageFeedbackByID = snapshot.feedback
    messageFeedbackAvailable = snapshot.feedbackAvailable
    sessionProjections = snapshot.sessionProjections
    modelLabel = snapshot.modelLabel
    historyLoadState = .loaded
    conversationSurfaceSnapshotOrder.removeAll { $0 == sessionID }
    conversationSurfaceSnapshotOrder.append(sessionID)
  }

  private func removeConversationSurfaceSnapshot(for sessionID: String) {
    conversationSurfaceSnapshots.removeValue(forKey: sessionID)
    conversationSurfaceSnapshotOrder.removeAll { $0 == sessionID }
  }

  public func selectWorkspace(_ workspaceID: String) {
    navigationErrorMessage = nil
    selectedWorkspaceID = workspaceID
    if let workspace = workspaces.first(where: { $0.id == workspaceID }) {
      selectedKnowledgeProjectPath = workspace.path
    }
    clearConversationSurface()
    wikiTask?.cancel()
    wikiTask = Task { [weak self] in await self?.loadWiki() }
  }

  /// Enter the resident new-conversation hero without creating a durable
  /// blank Session.  The first real submit owns session creation.
  public func beginNewConversation() {
    let abandonedDocuments = pendingDocuments
    clearConversationSurface()
    selectedWorkspaceID = nil
    selectedTab = .chat
    composerDraftDocument.clear()
    installComposerDraft(composerDraftDocument)
    persistComposerDraft(for: nil)
    pendingImages = []
    pendingDocuments = []
    Task { await documentStore.remove(abandonedDocuments) }
    draftModelSelection = nil
    draftPermissionPreset = nil
    requestComposerFocus(caret: 0)
  }

  private func clearConversationSurface() {
    cacheCurrentConversationSurface()
    selectedSessionID = nil
    events = []
    turnProjection = ArkChatTurnProjection()
    turnUsageByTurn = [:]
    messages = []
    toolActivities = []
    producedFiles = []
    chatStatuses = []
    selectedToolActivityID = nil
    messageImages.configure(sessionID: nil)
    messageFeedbackByID = [:]
    messageFeedbackAvailable = false
    sessionProjections = [:]
    sessionJobs = []
    pendingLiveEvents = []
    seenEventIDs = []
    messageProjection.reset(events: [])
    toolProjection.reset(events: [])
    producedFilesProjection.reset(events: [])
    statusProjection.reset(events: [])
    livePublishTask?.cancel()
    livePublishTask = nil
    queuedPrompts = []
    queueMutationIDs = []
    hasOlderHistory = false
    loadingOlderHistory = false
    historyLoadState = .idle
    historyBeforeSequence = nil
    historyTask?.cancel()
    historyProjectionGeneration &+= 1
    historyFoldOwner = nil
    historyRefreshOwner = nil
    olderHistoryLoadOwner = nil
    modelCatalog = nil
    modelLabel = "未配置模型"
    chatPresentationDidChange.send()
  }

  public func createSession() {
    createSession(in: selectedWorkspaceID)
  }

  /// Stage Creator mode only for the new authoring session, matching the old
  /// Settings affordance without changing the persisted default preset.
  public func startCreatorDraft() {
    guard agentPresetRoster?.authorable == true,
          agentPresetRoster?.presets.contains(where: { $0.id == "cordis" && $0.broken == nil }) == true
    else {
      agentPresetError = "创造模式当前不可用"
      return
    }
    Task {
      do {
        let id = try await client.createSession(
          workspaceID: selectedWorkspaceID,
          agentPreset: "cordis"
        )
        await refreshNavigation(refreshWiki: false)
        selectSession(id)
        agentPresetError = nil
      } catch {
        agentPresetError = error.localizedDescription
      }
    }
  }

  public func createSession(in workspaceID: String?) {
    Task {
      do {
        let id = try await client.createSession(
          workspaceID: workspaceID,
          agentPreset: nextAgentPresetID
        )
        await refreshNavigation(refreshWiki: false)
        selectSession(id)
      } catch {
        navigationErrorMessage = error.localizedDescription
      }
    }
  }

  public func searchSessions(_ query: String) {
    let normalized = query.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !normalized.isEmpty else {
      clearSessionSearch()
      return
    }

    sessionSearchTask?.cancel()
    sessionSearchGeneration &+= 1
    let generation = sessionSearchGeneration
    let local = ArkSessionSearchResolver.localHits(
      query: normalized,
      sessions: sessions,
      workspaces: workspaces,
      archivedSessionIDs: archivedSessionIDs
    )
    sessionSearchHits = local
    sessionSearchDidRun = true
    sessionSearchLoading = true
    sessionSearchRemoteUnavailable = false

    sessionSearchTask = Task { [weak self] in
      guard let self else { return }
      do {
        let remote = try await client.searchSessions(query: normalized).items
          .filter { !self.archivedSessionIDs.contains($0.sessionID) }
        guard !Task.isCancelled, sessionSearchGeneration == generation else { return }
        sessionSearchHits = ArkSessionSearchResolver.merge(local: local, remote: remote)
        sessionSearchLoading = false
        sessionSearchRemoteUnavailable = false
      } catch {
        guard !Task.isCancelled, sessionSearchGeneration == generation else { return }
        sessionSearchHits = local
        sessionSearchLoading = false
        sessionSearchRemoteUnavailable = true
      }
    }
  }

  public func clearSessionSearch() {
    sessionSearchTask?.cancel()
    sessionSearchTask = nil
    sessionSearchGeneration &+= 1
    sessionSearchHits = []
    sessionSearchDidRun = false
    sessionSearchLoading = false
    sessionSearchRemoteUnavailable = false
  }

  public func renameSession(_ sessionID: String, title: String) {
    let normalized = title.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !normalized.isEmpty else { return }
    Task {
      do {
        _ = try await client.renameSession(sessionID: sessionID, title: normalized)
        await refreshNavigation(refreshWiki: false)
        postResultMessage(ArkL10n.text(.toastSessionRenamed, languagePreference))
        navigationErrorMessage = nil
      } catch {
        navigationErrorMessage = error.localizedDescription
      }
    }
  }

  public func archiveSession(_ sessionID: String) {
    guard !archiveMutationIDs.contains(sessionID) else { return }
    Task {
      archiveMutationIDs.insert(sessionID)
      defer { archiveMutationIDs.remove(sessionID) }
      do {
        archivedSessionIDs = Set(try await client.archiveSession(sessionID: sessionID))
        if selectedSessionID == sessionID {
          selectedSessionID = nil
          events = []
          turnProjection = ArkChatTurnProjection()
          turnUsageByTurn = [:]
          messages = []
          messageImages.configure(sessionID: nil)
          chatPresentationDidChange.send()
        }
        await refreshNavigation(refreshWiki: false)
        postResultMessage(ArkL10n.text(.toastSessionArchived, languagePreference))
        navigationErrorMessage = nil
      } catch {
        navigationErrorMessage = error.localizedDescription
      }
    }
  }

  public func restoreArchivedSession(_ sessionID: String) {
    guard archivedSessionIDs.contains(sessionID), !archiveMutationIDs.contains(sessionID) else { return }
    Task {
      archiveMutationIDs.insert(sessionID)
      defer { archiveMutationIDs.remove(sessionID) }
      do {
        archivedSessionIDs = Set(try await client.unarchiveSession(sessionID: sessionID))
        await refreshNavigation(refreshWiki: false)
        postResultMessage(ArkL10n.text(.toastSessionRestored, languagePreference))
        navigationErrorMessage = nil
      } catch {
        navigationErrorMessage = error.localizedDescription
      }
    }
  }

  public func deleteArchivedSessionPermanently(_ sessionID: String) {
    guard archivedSessionIDs.contains(sessionID), !archiveMutationIDs.contains(sessionID) else { return }
    Task {
      archiveMutationIDs.insert(sessionID)
      defer { archiveMutationIDs.remove(sessionID) }
      do {
        archivedSessionIDs = Set(try await client.deleteArchivedSession(sessionID: sessionID))
        if selectedSessionID == sessionID {
          selectedSessionID = nil
          events = []
          turnProjection = ArkChatTurnProjection()
          turnUsageByTurn = [:]
          messages = []
          toolActivities = []
          producedFiles = []
          chatStatuses = []
          messageImages.configure(sessionID: nil)
          chatPresentationDidChange.send()
        }
        await refreshNavigation(refreshWiki: false)
        postResultMessage(ArkL10n.text(.toastSessionDeletedPermanently, languagePreference))
        navigationErrorMessage = nil
      } catch {
        navigationErrorMessage = error.localizedDescription
      }
    }
  }

  public func forkSession(_ sessionID: String, atSequence: Int? = nil) {
    Task {
      do {
        let childID = try await client.forkSession(sessionID: sessionID, atSequence: atSequence)
        await refreshNavigation(refreshWiki: false)
        selectSession(childID)
        postResultMessage(ArkL10n.text(.toastSessionForked, languagePreference))
        navigationErrorMessage = nil
      } catch {
        navigationErrorMessage = error.localizedDescription
      }
    }
  }

  public func forkSequence(for message: ArkMessage) -> Int? {
    guard message.role == .assistant, let turn = message.turn else { return nil }
    guard !messages.contains(where: {
      $0.role == .assistant && $0.turn == turn && $0.id > message.id
    }) else { return nil }
    return events.first { event in
      event.id >= message.id
        && event.type == "turn/end"
        && Int(event.data["turn"]?.numberValue ?? -1) == turn
        && event.data["reason"]?["kind"]?.stringValue == "completed"
    }?.id
  }

  public func forkAtMessage(_ message: ArkMessage) {
    guard let sessionID = selectedSessionID, let sequence = forkSequence(for: message) else { return }
    forkSession(sessionID, atSequence: sequence)
  }

  public func setMessageFeedback(
    messageID: String,
    rating: ArkMessageFeedback.Rating
  ) {
    guard let sessionID = selectedSessionID else { return }
    Task {
      do {
        if let current = messageFeedbackByID[messageID], current.rating == rating {
          try await client.deleteMessageFeedback(
            sessionID: sessionID,
            messageID: messageID,
            ifVersion: current.version
          )
          guard selectedSessionID == sessionID else { return }
          messageFeedbackByID.removeValue(forKey: messageID)
        } else {
          let item = try await client.putMessageFeedback(
            sessionID: sessionID,
            messageID: messageID,
            rating: rating,
            ifVersion: messageFeedbackByID[messageID]?.version
          )
          guard selectedSessionID == sessionID else { return }
          messageFeedbackByID[messageID] = item
        }
      } catch {
        await loadMessageFeedback(for: sessionID)
      }
    }
  }

  public func setMessageFeedbackNote(messageID: String, note: String) {
    guard let sessionID = selectedSessionID,
          let current = messageFeedbackByID[messageID]
    else { return }
    let normalized = note.trimmingCharacters(in: .whitespacesAndNewlines)
    Task {
      do {
        let item = try await client.putMessageFeedback(
          sessionID: sessionID,
          messageID: messageID,
          rating: current.rating,
          note: normalized.isEmpty ? nil : normalized,
          ifVersion: current.version
        )
        guard selectedSessionID == sessionID else { return }
        messageFeedbackByID[messageID] = item
      } catch {
        await loadMessageFeedback(for: sessionID)
      }
    }
  }

  public func cancelSelectedSession() {
    guard let sessionID = selectedSessionID else { return }
    Task {
      do {
        if let address = try await subagentAddress(for: sessionID), address.entry.mode == "continuable" {
          try await client.interruptSubagent(
            parentSessionID: address.parentID,
            childSessionID: sessionID
          )
        } else {
          try await client.cancelSession(sessionID: sessionID)
        }
        postResultMessage(ArkL10n.text(.toastStopRequested, languagePreference))
        composerErrorMessage = nil
      } catch {
        composerErrorMessage = error.localizedDescription
      }
    }
  }

  public func addWorkspace(path: String) {
    if let reason = JiuzhangShellContract.protectedWorkspaceReason(path: path) {
      navigationErrorMessage = reason
      return
    }
    Task {
      do {
        let workspace = try await client.createWorkspace(path: path)
        do {
          try await registerKnowledgeProject(
            name: workspace.title,
            path: workspace.path
          )
        } catch {
          _ = try? await client.deleteWorkspace(workspaceID: workspace.id)
          throw error
        }
        await refreshNavigation()
        selectWorkspace(workspace.id)
        postResultMessage(ArkL10n.text(.toastWorkspaceAdded, languagePreference))
        navigationErrorMessage = nil
      } catch {
        navigationErrorMessage = error.localizedDescription
      }
    }
  }

  public func renameWorkspace(_ workspaceID: String, title: String) {
    let normalized = title.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !normalized.isEmpty else { return }
    Task {
      do {
        _ = try await client.renameWorkspace(workspaceID: workspaceID, title: normalized)
        await refreshNavigation()
        postResultMessage(ArkL10n.text(.toastWorkspaceRenamed, languagePreference))
        navigationErrorMessage = nil
      } catch {
        navigationErrorMessage = error.localizedDescription
      }
    }
  }

  public func removeWorkspace(_ workspaceID: String) {
    guard let workspace = workspaces.first(where: { $0.id == workspaceID }) else { return }
    let sessionIDs = Set(workspace.sessionIDs)
    guard !sessions.contains(where: { sessionIDs.contains($0.id) && $0.running }) else {
      navigationErrorMessage = ArkL10n.text(.workspaceDeleteRunning, languagePreference)
      return
    }
    Task {
      do {
        for sessionID in workspace.sessionIDs {
          if !archivedSessionIDs.contains(sessionID) {
            _ = try await client.archiveSession(sessionID: sessionID)
          }
          _ = try await client.deleteArchivedSession(sessionID: sessionID)
        }
        try await unregisterKnowledgeProject(path: workspace.path)
        _ = try await client.deleteWorkspace(workspaceID: workspaceID)
        if selectedWorkspaceID == workspaceID { selectedWorkspaceID = nil }
        if selectedSessionID.map(sessionIDs.contains) == true {
          clearConversationSurface()
        }
        if selectedKnowledgeProjectPath == workspace.path {
          stopKnowledgeIngestPolling(resetQueue: true)
          selectedKnowledgeProjectPath = nil
        }
        await refreshNavigation()
        postResultMessage(ArkL10n.text(.toastWorkspaceRecordsRemoved, languagePreference))
        navigationErrorMessage = nil
      } catch {
        navigationErrorMessage = error.localizedDescription
      }
    }
  }

  private func registerKnowledgeProject(name: String, path: String) async throws {
    let value = try await client.remoteCall(
      method: "knowledgeWiki/createProject",
      args: [
        "request": .object([
          "name": .string(name),
          "path": .string(path),
        ]),
      ]
    )
    if let message = value["error"]?.stringValue, !message.isEmpty {
      throw ArkAPIError(message: message)
    }
  }

  private func unregisterKnowledgeProject(path: String) async throws {
    let value = try await client.remoteCall(
      method: "knowledgeWiki/removeProject",
      args: ["request": .object(["path": .string(path)])]
    )
    let normalized = URL(fileURLWithPath: path).standardizedFileURL.path
    let remainsRegistered = (value["projects"]?.arrayValue ?? []).contains { row in
      guard let candidate = row["path"]?.stringValue else { return false }
      return URL(fileURLWithPath: candidate).standardizedFileURL.path == normalized
    }
    guard !remainsRegistered else {
      throw ArkAPIError(message: ArkL10n.text(.wikiProjectRemovalFailed, languagePreference))
    }
  }

  public func reorderWorkspace(_ workspaceID: String, before beforeWorkspaceID: String?) {
    Task {
      do {
        _ = try await client.moveWorkspace(
          workspaceID: workspaceID,
          beforeWorkspaceID: beforeWorkspaceID
        )
        await refreshNavigation(refreshWiki: false)
        navigationErrorMessage = nil
      } catch {
        navigationErrorMessage = error.localizedDescription
      }
    }
  }

  public func reorderSession(
    _ sessionID: String,
    in workspaceID: String,
    before beforeSessionID: String?
  ) {
    Task {
      do {
        _ = try await client.moveSession(
          sessionID: sessionID,
          inWorkspaceID: workspaceID,
          beforeSessionID: beforeSessionID
        )
        await refreshNavigation(refreshWiki: false)
        navigationErrorMessage = nil
      } catch {
        navigationErrorMessage = error.localizedDescription
      }
    }
  }

  public func sendComposer() {
    sendComposer(modeOverride: nil)
  }

  public func sendComposerAlternate() {
    if pendingDocuments.isEmpty,
       ArkChatSubmissionPolicy.shouldSteerWholeQueue(
      draft: composer,
      pendingImageCount: pendingImages.count,
      sessionRunning: selectedSession?.running == true,
      sessionOrigin: selectedSession?.origin,
      queuedCount: queuedPrompts.filter { $0.placement == .queued }.count
    ) {
      steerAllQueuedPrompts()
      return
    }
    let alternate: ArkPromptDeliveryMode = busyEnterBehavior == .queue ? .steer : .queue
    sendComposer(modeOverride: alternate)
  }

  /// Empty-draft Command+Enter accelerates the complete FIFO queue into the
  /// current turn. Mutations stay serialized in queue order and remain
  /// unavailable for subagent-owned queues.
  public func steerAllQueuedPrompts() {
    guard let sessionID = selectedSessionID,
          selectedSession?.running == true,
          selectedSession?.origin != "subagent"
    else { return }
    let queued = queuedPrompts.filter { $0.placement == .queued }
    guard !queued.isEmpty else { return }
    let itemIDs = Set(queued.map(\.id))
    guard queueMutationIDs.isDisjoint(with: itemIDs) else { return }
    queueMutationIDs.formUnion(itemIDs)
    Task {
      defer { queueMutationIDs.subtract(itemIDs) }
      do {
        for item in queued {
          try await interactions.updateQueue(
            sessionID: sessionID,
            itemID: item.id,
            mutation: .steer
          )
        }
        composerErrorMessage = nil
      } catch {
        composerErrorMessage = error.localizedDescription
      }
    }
  }

  private func sendComposer(modeOverride: ArkPromptDeliveryMode?) {
    guard !composerSubmissionInFlight else { return }
    guard composerModelRouteAvailable else {
      composerErrorMessage = ArkL10n.text(.composerChooseAvailableModel, languagePreference)
      return
    }
    let capturedDocument = composerDraftDocument
    let text: String
    do {
      text = try capturedDocument.serializedText()
        .trimmingCharacters(in: .whitespacesAndNewlines)
    } catch {
      composerErrorMessage = error.localizedDescription
      return
    }
    guard !text.isEmpty || !pendingImages.isEmpty || !pendingDocuments.isEmpty else { return }
    let images = pendingImages
    let documents = pendingDocuments
    let sourceSessionID = selectedSessionID
    let sourceSessionWasRunning = selectedSession?.running == true
    let sourceIsSubagent = selectedSession?.origin == "subagent" || selectedSubagentEntry != nil
    // A subagent prompt is not accepted until its caller-stable invocation has
    // reached the child Session log. Keep the visible and persisted draft intact
    // across that await so an app/Host failure cannot turn an uncertain outcome
    // into silent data loss. Ordinary session submission retains its established
    // eager-clear behavior.
    if !sourceIsSubagent {
      composerDraftDocument.clear()
      installComposerDraft(composerDraftDocument)
      persistComposerDraft(for: sourceSessionID)
      pendingImages = []
      pendingDocuments = []
    }
    invalidateComposerSuggestions()
    composerSubmissionInFlight = true
    Task {
      var targetSessionID = sourceSessionID
      defer { composerSubmissionInFlight = false }
      do {
        let promptText = try await documentStore.contextualizedPrompt(
          baseText: text,
          documents: documents
        )
        let sessionID: String
        if let sourceSessionID { sessionID = sourceSessionID }
        else {
          let pendingModel = draftModelSelection
          let pendingPermission = draftPermissionPreset
          sessionID = try await client.createSession(
            workspaceID: selectedWorkspaceID,
            agentPreset: nextAgentPresetID
          )
          targetSessionID = sessionID
          await refreshNavigation(refreshWiki: false)
          selectSession(sessionID)
          if let pendingModel {
            _ = try await client.selectModel(sessionID: sessionID, selection: pendingModel)
          }
          if let pendingPermission {
            _ = try await client.setPermissionPreset(sessionID: sessionID, preset: pendingPermission)
          }
          draftModelSelection = nil
          draftPermissionPreset = nil
        }
        if sourceIsSubagent {
          guard let address = try await subagentAddress(for: sessionID) else {
            throw ArkAPIError(message: "子代理地址尚未同步，请稍后重试")
          }
          guard address.entry.mode == "continuable" else {
            throw ArkAPIError(message: "一次性子代理只能查看，不能继续发送消息")
          }
          guard images.isEmpty else {
            throw ArkAPIError(message: "子代理继续对话当前只接受文本消息")
          }
          let invocationID = ArkSubagentPromptInvocationIdentity.make(
            parentSessionID: address.parentID,
            childSessionID: sessionID,
            content: promptText,
            draftRevision: capturedDocument.revision
          )
          _ = try await client.promptSubagent(
            parentSessionID: address.parentID,
            childSessionID: sessionID,
            text: promptText,
            invocationID: invocationID
          )
          _ = commitSubagentComposerSubmission(
            capturedDocument,
            sourceSessionID: sourceSessionID
          )
        } else {
          let deliveryMode: ArkPromptDeliveryMode = sourceSessionWasRunning
            ? (modeOverride ?? busyEnterBehavior)
            : .queue
          let route: ArkComposerSubmissionRoute
          if text.hasPrefix("/") {
            let commands = try await composerCommandsForSubmission(sessionID: sessionID)
            route = try ArkComposerSubmissionRoute.resolve(
              text: text,
              imageCount: images.count,
              commands: commands
            )
          } else {
            route = .prompt
          }
          switch route {
          case .prompt:
            try await interactions.sendPrompt(
              sessionID: sessionID,
              text: promptText,
              images: images,
              mode: deliveryMode
            )
          case .command(let command):
            guard documents.isEmpty else {
              throw ArkAPIError(message: "/\(command.name) 暂不接受文档引用")
            }
            guard let execution = try await client.executeCommand(
              sessionID: sessionID,
              line: text,
              images: images
            ) else {
              throw ArkAPIError(message: "命令目录已经变化，请重试")
            }
            guard execution.result == .success else {
              throw ArkAPIError(message: execution.text ?? "/\(command.name) 执行失败")
            }
          }
        }
        await refreshHistory()
        await refreshNavigation(refreshWiki: false)
        await documentStore.remove(documents)
        composerErrorMessage = nil
      } catch {
        if !sourceIsSubagent {
          restoreComposerSubmission(
            capturedDocument,
            sourceSessionID: sourceSessionID,
            targetSessionID: targetSessionID
          )
          if pendingImages.isEmpty { pendingImages = images }
          else { pendingImages.insert(contentsOf: images, at: 0) }
          if pendingDocuments.isEmpty { pendingDocuments = documents }
          else { pendingDocuments.insert(contentsOf: documents, at: 0) }
        }
        composerErrorMessage = error.localizedDescription
      }
    }
  }

  /// Clear exactly the draft whose subagent invocation just received a durable
  /// receipt. A user edit or session switch that wrote a different document is
  /// never overwritten by the late acknowledgement.
  private func commitSubagentComposerSubmission(
    _ captured: ArkComposerDraftDocument,
    sourceSessionID: String?
  ) -> Bool {
    guard let sourceSessionID else { return false }
    var empty = captured
    empty.clear()
    if selectedSessionID == sourceSessionID {
      guard composerDraftDocument == captured else { return false }
      installComposerDraft(empty)
      persistComposerDraft(for: sourceSessionID)
    } else {
      guard Self.loadComposerDraft(defaults: defaults, sessionID: sourceSessionID) == captured else {
        return false
      }
      persistComposerDraft(empty, for: sourceSessionID)
    }
    pendingImages = []
    pendingDocuments = []
    return true
  }

  private func composerCommandsForSubmission(
    sessionID: String
  ) async throws -> [ArkComposerCommand] {
    if let cached = composerCatalogs[sessionID], cached.commandsLoaded {
      return cached.commands
    }
    let loaded = await loadComposerCommands(sessionID: sessionID)
    guard let commands = loaded.value else {
      throw ArkAPIError(message: loaded.error ?? "命令目录加载失败")
    }
    var snapshot = composerCatalogs[sessionID] ?? ArkComposerCatalogSnapshot()
    snapshot.commands = commands
    snapshot.commandsLoaded = true
    snapshot.commandError = nil
    composerCatalogs[sessionID] = snapshot
    return commands
  }

  private func restoreComposerSubmission(
    _ captured: ArkComposerDraftDocument,
    sourceSessionID: String?,
    targetSessionID: String?
  ) {
    let destination = targetSessionID ?? sourceSessionID
    if selectedSessionID == destination {
      let restored = composerDraftDocument.prepending(captured)
      installComposerDraft(restored)
      persistComposerDraft(for: destination)
      return
    }
    persistComposerDraft(captured, for: destination)
  }

  public func addPastedImage(data: Data, mediaType: ArkImageMediaType) {
    let limits = sessionProjections["imageLimits"]
    let maxCount = Int(limits?["maxImagesPerMessage"]?.numberValue ?? 20)
    let maxEach = min(Int(limits?["maxImageBytes"]?.numberValue ?? Double(5 * 1024 * 1024)), 5 * 1024 * 1024)
    let maxTotal = min(Int(limits?["maxMessageImageBytes"]?.numberValue ?? Double(100 * 1024 * 1024)), 100 * 1024 * 1024)
    guard pendingImages.count < maxCount else {
      composerErrorMessage = "每条消息最多可添加 \(maxCount) 张图片"
      return
    }
    guard !data.isEmpty, data.count <= maxEach else {
      composerErrorMessage = "粘贴图片超过当前单张大小限制"
      return
    }
    guard pendingImages.reduce(0, { $0 + $1.data.count }) + data.count <= maxTotal else {
      composerErrorMessage = "图片总大小超过当前限制"
      return
    }
    pendingImages.append(ArkPromptImage(mediaType: mediaType, data: data, name: "粘贴的图片"))
    composerErrorMessage = nil
  }

  public func addImageURLs(_ urls: [URL]) {
    let limits = sessionProjections["imageLimits"]
    let maxCount = Int(limits?["maxImagesPerMessage"]?.numberValue ?? 20)
    let maxEach = min(Int(limits?["maxImageBytes"]?.numberValue ?? Double(5 * 1024 * 1024)), 5 * 1024 * 1024)
    let maxTotal = min(Int(limits?["maxMessageImageBytes"]?.numberValue ?? Double(100 * 1024 * 1024)), 100 * 1024 * 1024)
    guard pendingImages.count + urls.count <= maxCount else {
      composerErrorMessage = "每条消息最多可添加 \(maxCount) 张图片"
      return
    }
    let retainedBytes = pendingImages.reduce(0) { $0 + $1.data.count }
    Task {
      do {
        let images = try await Task.detached(priority: .userInitiated) {
          try urls.map { url -> ArkPromptImage in
            let values = try url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
            guard values.isRegularFile == true else {
              throw ArkAPIError(message: "只能附加普通图片文件")
            }
            guard let size = values.fileSize, size > 0, size <= maxEach else {
              throw ArkAPIError(message: "单张图片超过当前 \(maxEach) 字节限制")
            }
            let mediaType: ArkImageMediaType
            switch url.pathExtension.lowercased() {
            case "png": mediaType = .png
            case "jpg", "jpeg": mediaType = .jpeg
            case "webp": mediaType = .webp
            case "gif": mediaType = .gif
            default: throw ArkAPIError(message: "仅支持 PNG、JPEG、WebP 或 GIF 图片")
            }
            return ArkPromptImage(
              mediaType: mediaType,
              data: try Data(contentsOf: url, options: [.mappedIfSafe]),
              name: url.lastPathComponent
            )
          }
        }.value
        guard retainedBytes + images.reduce(0, { $0 + $1.data.count }) <= maxTotal else {
          throw ArkAPIError(message: "图片总大小超过当前 \(maxTotal) 字节限制")
        }
        pendingImages.append(contentsOf: images)
        composerErrorMessage = nil
      } catch {
        composerErrorMessage = error.localizedDescription
      }
    }
  }

  public func removePendingImage(at index: Int) {
    guard pendingImages.indices.contains(index) else { return }
    pendingImages.remove(at: index)
  }

  public func addPastedDocument(_ text: String) {
    guard text.utf8.count >= ArkDocumentReferenceStore.longPasteThreshold else { return }
    guard pendingDocuments.count < 8 else {
      composerErrorMessage = "每条消息最多可引用 8 份文档"
      return
    }
    let name = ArkL10n.text(.composerPastedText, languagePreference)
    Task {
      do {
        let document = try await documentStore.importPastedText(text, name: name)
        if !pendingDocuments.contains(where: { $0.id == document.id }) {
          pendingDocuments.append(document)
        }
        composerErrorMessage = nil
      } catch {
        composerErrorMessage = error.localizedDescription
      }
    }
  }

  public func addAttachmentURLs(_ urls: [URL]) {
    let imageExtensions = Set(["png", "jpg", "jpeg", "webp", "gif"])
    let imageURLs = urls.filter { imageExtensions.contains($0.pathExtension.lowercased()) }
    let documentURLs = urls.filter { !imageExtensions.contains($0.pathExtension.lowercased()) }
    if !imageURLs.isEmpty { addImageURLs(imageURLs) }
    if !documentURLs.isEmpty { addDocumentURLs(documentURLs) }
  }

  public func addDocumentURLs(_ urls: [URL]) {
    guard pendingDocuments.count + urls.count <= 8 else {
      composerErrorMessage = "每条消息最多可引用 8 份文档"
      return
    }
    Task {
      do {
        for url in urls {
          let document = try await documentStore.importFile(url)
          if !pendingDocuments.contains(where: { $0.id == document.id }) {
            pendingDocuments.append(document)
          }
        }
        composerErrorMessage = nil
      } catch {
        composerErrorMessage = error.localizedDescription
      }
    }
  }

  public func removePendingDocument(at index: Int) {
    guard pendingDocuments.indices.contains(index) else { return }
    let document = pendingDocuments.remove(at: index)
    Task { await documentStore.remove([document]) }
  }

  public func answerApproval(_ request: ArkApprovalRequest, decision: ArkApprovalDecision) {
    guard respondingInteractionIDs.insert(request.id).inserted else { return }
    Task {
      defer { respondingInteractionIDs.remove(request.id) }
      do {
        try await interactions.answerApproval(request, decision: decision)
        postResultMessage(decision == .allowOnce ? ArkL10n.text(.toastAllowedOnce, languagePreference) : ArkL10n.text(.toastDeniedOnce, languagePreference))
        composerErrorMessage = nil
      } catch {
        composerErrorMessage = error.localizedDescription
      }
    }
  }

  public func answerQuestions(_ request: ArkQuestionRequest, answers: [ArkQuestionAnswer]) {
    guard respondingInteractionIDs.insert(request.id).inserted else { return }
    Task {
      defer { respondingInteractionIDs.remove(request.id) }
      do {
        try await interactions.answerQuestions(request, answers: answers)
        postResultMessage(ArkL10n.text(.toastAnswerSubmitted, languagePreference))
        composerErrorMessage = nil
      } catch {
        composerErrorMessage = error.localizedDescription
      }
    }
  }

  public func cancelQuestions(_ request: ArkQuestionRequest) {
    guard respondingInteractionIDs.insert(request.id).inserted else { return }
    Task {
      defer { respondingInteractionIDs.remove(request.id) }
      do {
        try await interactions.cancelQuestions(request)
        postResultMessage(ArkL10n.text(.toastQuestionCancelled, languagePreference))
        composerErrorMessage = nil
      } catch {
        composerErrorMessage = error.localizedDescription
      }
    }
  }

  public func updateQueuedPrompt(_ item: ArkQueuedPrompt, mutation: ArkQueueMutation) {
    guard let sessionID = selectedSessionID else { return }
    guard queueMutationIDs.insert(item.id).inserted else { return }
    Task {
      defer { queueMutationIDs.remove(item.id) }
      do {
        try await interactions.updateQueue(sessionID: sessionID, itemID: item.id, mutation: mutation)
        composerErrorMessage = nil
      } catch {
        composerErrorMessage = error.localizedDescription
      }
    }
  }

  public func queueMutationIsRunning(_ itemID: String) -> Bool {
    queueMutationIDs.contains(itemID)
  }

  public func exportSelectedSession(to destinationURL: URL) {
    guard let sessionID = selectedSessionID else { return }
    sessionExportTask?.cancel()
    sessionExportState = .exporting
    sessionExportTask = Task {
      do {
        let exported = try await interactions.exportSession(sessionID: sessionID, to: destinationURL)
        try Task.checkCancellation()
        sessionExportState = .succeeded(bytes: exported.bytes)
        postResultMessage(ArkL10n.format(.toastSessionExported, languagePreference, arguments: [String(exported.bytes)]))
        composerErrorMessage = nil
      } catch is CancellationError {
        sessionExportState = .idle
      } catch {
        sessionExportState = .failed(message: error.localizedDescription)
        composerErrorMessage = error.localizedDescription
      }
      sessionExportTask = nil
    }
  }

  public func cancelSessionExport() {
    sessionExportTask?.cancel()
    sessionExportTask = nil
    sessionExportState = .idle
  }

  public func dismissSessionExportState() {
    guard sessionExportState != .exporting else { return }
    sessionExportState = .idle
  }

  public func selectModel(_ selection: ArkModelSelection) {
    guard let sessionID = selectedSessionID else {
      selectDefaultModel(selection)
      return
    }
    Task {
      do {
        let selected = try await client.selectModel(sessionID: sessionID, selection: selection)
        guard selectedSessionID == sessionID else { return }
        modelLabel = Self.modelDisplayLabel(
          provider: selected.provider,
          model: selected.model,
          reasoningEffort: selected.reasoningEffort
        )
        await refreshModelCatalog(for: sessionID)
        composerErrorMessage = nil
      } catch {
        composerErrorMessage = error.localizedDescription
      }
    }
  }

  public func setPermissionPreset(_ preset: String) {
    guard let sessionID = selectedSessionID else {
      draftPermissionPreset = preset
      setDefaultPermissionPreset(preset)
      return
    }
    Task {
      do {
        _ = try await client.setPermissionPreset(sessionID: sessionID, preset: preset)
        await refreshNavigation(refreshWiki: false)
        // 权限选择器本身原地显示当前状态，不再弹 Toast，
        // 切换不产生任何瞬态 UI，也不触碰布局与滚动。
        composerErrorMessage = nil
      } catch {
        composerErrorMessage = error.localizedDescription
      }
    }
  }

  private func selectDefaultModel(_ selection: ArkModelSelection) {
    draftModelSelection = selection
    guard let snapshot = settingsSnapshot,
          snapshot.writable,
          let namespace = snapshot.namespaces.first(where: { $0.id == "agent-default-model" })
    else {
      composerErrorMessage = "本机服务没有提供可写的新会话模型设置"
      return
    }
    Task {
      settingsBusy = true
      defer { settingsBusy = false }
      do {
        var mutations: [ArkSettingMutation] = [
          .set(path: ["provider"], value: .string(selection.provider)),
          .set(path: ["model"], value: .string(selection.model)),
        ]
        if let effort = selection.reasoningEffort {
          mutations.append(.set(path: ["reasoningEffort"], value: .string(effort)))
        } else {
          mutations.append(.unset(path: ["reasoningEffort"]))
        }
        let updated = try await client.mutateSettings(
          namespace: namespace.id,
          mutations: mutations,
          expectedRevision: namespace.revision
        )
        settingsSnapshot = ArkSettingsSnapshot(
          writable: snapshot.writable,
          hasDocument: snapshot.hasDocument,
          namespaces: snapshot.namespaces.map { $0.id == updated.id ? updated : $0 }
        )
        composerErrorMessage = nil
      } catch {
        await loadSettings()
        draftModelSelection = nil
        composerErrorMessage = error.localizedDescription
      }
    }
  }

  public func runSessionCommand(_ line: String) {
    guard let sessionID = selectedSessionID else { return }
    Task {
      do {
        _ = try await client.executeCommand(sessionID: sessionID, line: line)
        composerErrorMessage = nil
      } catch {
        composerErrorMessage = error.localizedDescription
      }
    }
  }

  /// Apply one Host-owned goal mutation against the exact projected revision.
  /// The Host CAS is authoritative; the committed projection event updates UI.
  @discardableResult
  public func mutateCurrentGoal(_ mutation: ArkGoalMutation) async -> Bool {
    guard goalMutationToken == nil else { return false }
    guard
      let sessionID = selectedSessionID,
      let goal = currentGoal,
      let request = mutation.request(sessionID: sessionID, goal: goal)
    else {
      goalMutationError = ArkL10n.text(.goalUnavailable, languagePreference)
      return false
    }

    let token = UUID()
    goalMutationToken = token
    goalMutationSessionID = sessionID
    goalMutationError = nil
    defer {
      if goalMutationToken == token {
        goalMutationToken = nil
        goalMutationSessionID = nil
      }
    }

    do {
      _ = try await client.remoteCall(method: request.method, args: request.args)
      return true
    } catch {
      if selectedSessionID == sessionID {
        goalMutationError = error.localizedDescription
      }
      return false
    }
  }

  /// Read enough bounded pages to prove that the selected Session's retained
  /// contiguous tail reaches the exact mux baseline. Traversed pages are
  /// newest-first, while only the bounded presentation suffix is retained.
  private func synchronizedHistorySource(
    sessionID: String,
    retained: [ArkHistoryEvent],
    expectedThrough: Int?
  ) async throws -> (events: [ArkHistoryEvent], newestPage: ArkHistoryPage) {
    let initialBefore: Int?
    if let expectedThrough {
      if expectedThrough < 0 { initialBefore = 0 }
      else if expectedThrough < 9_007_199_254_740_991 {
        initialBefore = expectedThrough + 1
      } else {
        initialBefore = nil
      }
    } else {
      initialBefore = nil
    }
    let newestPage = try await historyPage(
      sessionID: sessionID,
      beforeSequence: initialBefore,
      maxMessages: 2_048
    )
    try ArkEventSequenceValidator.validatePage(newestPage)
    if let expectedThrough {
      if expectedThrough < 0 {
        guard newestPage.events.isEmpty else {
          throw ArkEventSequenceValidationError.incomplete(
            expected: expectedThrough,
            actual: newestPage.events.last?.id
          )
        }
      } else {
        guard newestPage.events.last?.id == expectedThrough else {
          throw ArkEventSequenceValidationError.incomplete(
            expected: expectedThrough,
            actual: newestPage.events.last?.id
          )
        }
      }
    }
    guard let target = expectedThrough ?? newestPage.events.last?.id else {
      guard retained.isEmpty else {
        throw ArkEventSequenceValidationError.incomplete(
          expected: retained.last?.id ?? 0,
          actual: nil
        )
      }
      return ([], newestPage)
    }
    guard let anchor = retained.last?.id else {
      try ArkEventSequenceValidator.validateReconciled(
        newestPage.events,
        expectedThrough: target
      )
      return (newestPage.events, newestPage)
    }
    guard target >= anchor else {
      throw ArkEventSequenceValidationError.incomplete(
        expected: anchor,
        actual: target
      )
    }
    guard target > anchor else {
      let merged = Array(
        ArkEventSequenceValidator.uniqueSorted(retained + newestPage.events)
          .suffix(ArkHistoryCatchUpAccumulator.maximumPresentationEvents)
      )
      try ArkEventSequenceValidator.validateReconciled(merged, expectedThrough: target)
      return (merged, newestPage)
    }

    var catchUp = try ArkHistoryCatchUpAccumulator(
      retained: retained,
      targetSequence: target
    )
    var page = newestPage
    while !catchUp.complete {
      try catchUp.consume(page)
      guard !catchUp.complete else { break }
      guard let before = catchUp.nextBeforeSequence else {
        throw ArkEventSequenceValidationError.incomplete(
          expected: catchUp.expectedPageEnd,
          actual: nil
        )
      }
      try Task.checkCancellation()
      page = try await historyPage(
        sessionID: sessionID,
        beforeSequence: before,
        maxMessages: 2_048
      )
    }
    return (try catchUp.mergedPresentation(), newestPage)
  }

  public func refreshHistory(resetPaging: Bool = false) async {
    guard let requestedSessionID = selectedSessionID else { return }
    historyProjectionGeneration &+= 1
    let generation = historyProjectionGeneration
    let requestOwner = ArkHistoryFoldOwner(
      sessionID: requestedSessionID,
      generation: generation
    )
    historyFoldOwner = nil
    historyRefreshOwner = requestOwner
    olderHistoryLoadOwner = nil
    loadingOlderHistory = false
    if !pendingLiveEvents.isEmpty { scheduleLivePublish() }
    historyLoadState = .loading
    defer {
      if historyRefreshOwner == requestOwner {
        historyRefreshOwner = nil
        if historyProjectionGeneration == generation,
           historyLoadState == .loading {
          historyLoadState = .afterCancellation(hasHistory: !events.isEmpty)
        }
      }
    }
    do {
      let retained = resetPaging ? [] : events
      let synchronized = try await synchronizedHistorySource(
        sessionID: requestedSessionID,
        retained: retained,
        expectedThrough: subscribedLastSequenceBySessionID[requestedSessionID]
      )
      let page = synchronized.newestPage
      guard selectedSessionID == requestedSessionID,
            historyProjectionGeneration == generation,
            historyRefreshOwner == requestOwner,
            !Task.isCancelled
      else { return }
      livePublishTask?.cancel()
      livePublishTask = nil
      let source = ArkEventSequenceValidator.uniqueSorted(
        synchronized.events + pendingLiveEvents
      )
      try ArkEventSequenceValidator.validateReconciled(
        source,
        expectedThrough: subscribedLastSequenceBySessionID[requestedSessionID]
      )
      let foldOwner = ArkHistoryFoldOwner(
        sessionID: requestedSessionID,
        generation: generation
      )
      historyFoldOwner = foldOwner
      defer {
        if historyFoldOwner == foldOwner {
          historyFoldOwner = nil
          if !pendingLiveEvents.isEmpty { scheduleLivePublish() }
        }
      }
      let language = languagePreference
      let preservedTurn = turnProjection.latestStartedTurn
      let preservedTurnSequence = turnProjection.latestStartedSequence
      guard var fold = await ArkHistoryFoldWorker.shared.fold(
        events: source,
        language: language
      ) else { return }
      guard selectedSessionID == requestedSessionID,
            historyProjectionGeneration == generation,
            historyRefreshOwner == requestOwner,
            historyFoldOwner == foldOwner,
            !Task.isCancelled
      else { return }
      fold.appendLive(pendingLiveEvents)
      fold.preserveLatestStartedBoundary(
        turn: preservedTurn,
        sequence: preservedTurnSequence
      )
      let installedEventIDs = Set(fold.events.map(\.id))
      pendingLiveEvents.removeAll { installedEventIDs.contains($0.id) }
      events = fold.events
      var chatPresentationChanged = false
      if turnProjection != fold.turnProjection {
        turnProjection = fold.turnProjection
        chatPresentationChanged = true
      }
      if turnUsageByTurn != fold.turnUsageByTurn {
        turnUsageByTurn = fold.turnUsageByTurn
        chatPresentationChanged = true
      }
      markTrajectoryProjectionDirty()
      synchronizeModelLabelFromEvents()
      seenEventIDs = Set(events.map(\.id))
      messageProjection = fold.messages
      let nextMessages = messageProjection.messages
      if messages != nextMessages {
        messages = nextMessages
        chatPresentationChanged = true
      }
      toolProjection = fold.tools
      let nextTools = toolProjection.activities
      if toolActivities != nextTools {
        toolActivities = nextTools
        chatPresentationChanged = true
      }
      producedFilesProjection = fold.producedFiles
      let nextProducedFiles = producedFilesProjection.files
      if producedFiles != nextProducedFiles {
        producedFiles = nextProducedFiles
        chatPresentationChanged = true
      }
      statusProjection = fold.statuses
      let nextStatuses = statusProjection.statuses
      if chatStatuses != nextStatuses {
        chatStatuses = nextStatuses
        chatPresentationChanged = true
      }
      if resetPaging || retained.isEmpty || historyBeforeSequence == nil {
        historyBeforeSequence = page.beforeSequence
        hasOlderHistory = page.hasMore
      }
      if !page.projections.isEmpty { sessionProjections = page.projections }
      historyLoadState = .loaded
      if chatPresentationChanged { chatPresentationDidChange.send() }
      composerErrorMessage = nil
      if eventConnectionErrors[.mux]?.hasPrefix("会话") == true {
        setEventConnectionState(.mux, state: .connected)
      }
    } catch {
      // 会话/页面切换取消的生命周期任务不是用户错误。
      if isTaskCancellation(error) {
        if selectedSessionID == requestedSessionID,
           historyProjectionGeneration == generation {
          historyLoadState = .afterCancellation(hasHistory: !events.isEmpty)
        }
        return
      }
      if selectedSessionID == requestedSessionID,
         historyProjectionGeneration == generation {
        historyLoadState = .failed(error.localizedDescription)
        composerErrorMessage = error.localizedDescription
        if error is ArkEventSequenceValidationError {
          markEventChannelDegraded(.mux, message: error.localizedDescription)
        }
      }
    }
  }

  public func loadOlderHistory() async {
    guard let sessionID = selectedSessionID,
          hasOlderHistory,
          !loadingOlderHistory,
          let before = historyBeforeSequence
    else { return }
    historyProjectionGeneration &+= 1
    let generation = historyProjectionGeneration
    historyFoldOwner = nil
    if historyRefreshOwner != nil {
      historyRefreshOwner = nil
      if historyLoadState == .loading {
        historyLoadState = .afterCancellation(hasHistory: !events.isEmpty)
      }
    }
    if !pendingLiveEvents.isEmpty { scheduleLivePublish() }
    let loadOwner = ArkHistoryFoldOwner(sessionID: sessionID, generation: generation)
    olderHistoryLoadOwner = loadOwner
    loadingOlderHistory = true
    defer {
      if olderHistoryLoadOwner == loadOwner {
        olderHistoryLoadOwner = nil
        loadingOlderHistory = false
      }
    }
    do {
      let page = try await historyPage(
        sessionID: sessionID,
        beforeSequence: before
      )
      guard selectedSessionID == sessionID,
            historyProjectionGeneration == generation,
            olderHistoryLoadOwner == loadOwner,
            !Task.isCancelled
      else { return }
      _ = try ArkEventSequenceValidator.olderCursor(
        for: page,
        requestedBefore: before
      )
      livePublishTask?.cancel()
      livePublishTask = nil
      let foldOwner = ArkHistoryFoldOwner(
        sessionID: sessionID,
        generation: generation
      )
      historyFoldOwner = foldOwner
      defer {
        if historyFoldOwner == foldOwner {
          historyFoldOwner = nil
          if !pendingLiveEvents.isEmpty { scheduleLivePublish() }
        }
      }
      let pageTouchesPresentation = page.events.isEmpty
        || events.isEmpty
        || (page.events.last?.id).map { last in
          guard let first = events.first?.id else { return true }
          return last == first - 1 || last >= first
        } == true
      let merged = ArkEventSequenceValidator.uniqueSorted(
        (pageTouchesPresentation ? page.events : []) + events + pendingLiveEvents
      )
      try ArkEventSequenceValidator.validateReconciled(
        merged,
        expectedThrough: subscribedLastSequenceBySessionID[sessionID]
      )
      let language = languagePreference
      let preservedTurn = turnProjection.latestStartedTurn
      let preservedTurnSequence = turnProjection.latestStartedSequence
      guard var fold = await ArkHistoryFoldWorker.shared.fold(
        events: merged,
        language: language
      ) else { return }
      guard selectedSessionID == sessionID,
            historyProjectionGeneration == generation,
            historyFoldOwner == foldOwner,
            olderHistoryLoadOwner == loadOwner,
            !Task.isCancelled
      else { return }
      fold.appendLive(pendingLiveEvents)
      fold.preserveLatestStartedBoundary(
        turn: preservedTurn,
        sequence: preservedTurnSequence
      )
      let installedEventIDs = Set(fold.events.map(\.id))
      pendingLiveEvents.removeAll { installedEventIDs.contains($0.id) }
      events = fold.events
      turnProjection = fold.turnProjection
      turnUsageByTurn = fold.turnUsageByTurn
      markTrajectoryProjectionDirty()
      synchronizeModelLabelFromEvents()
      seenEventIDs = Set(events.map(\.id))
      messageProjection = fold.messages
      messages = messageProjection.messages
      toolProjection = fold.tools
      toolActivities = toolProjection.activities
      producedFilesProjection = fold.producedFiles
      producedFiles = producedFilesProjection.files
      statusProjection = fold.statuses
      chatStatuses = statusProjection.statuses
      historyBeforeSequence = page.beforeSequence
      hasOlderHistory = page.hasMore
      historyLoadState = .loaded
      chatPresentationDidChange.send()
      composerErrorMessage = nil
    } catch {
      if isTaskCancellation(error) {
        if selectedSessionID == sessionID,
           historyProjectionGeneration == generation {
          historyLoadState = .afterCancellation(hasHistory: !events.isEmpty)
        }
        return
      }
      if selectedSessionID == sessionID,
         historyProjectionGeneration == generation {
        historyLoadState = .afterCancellation(hasHistory: !events.isEmpty)
        composerErrorMessage = error.localizedDescription
        if error is ArkEventSequenceValidationError {
          markEventChannelDegraded(.mux, message: error.localizedDescription)
        }
      }
    }
  }

  private func loadMessageFeedback(for sessionID: String) async {
    do {
      let items = try await client.listMessageFeedback(sessionID: sessionID)
      guard selectedSessionID == sessionID else { return }
      var firstFeedbackByMessageID: [String: ArkMessageFeedback] = [:]
      for item in items where firstFeedbackByMessageID[item.messageID] == nil {
        firstFeedbackByMessageID[item.messageID] = item
      }
      messageFeedbackByID = firstFeedbackByMessageID
      messageFeedbackAvailable = true
    } catch {
      guard selectedSessionID == sessionID else { return }
      messageFeedbackByID = [:]
      messageFeedbackAvailable = false
    }
  }

  package func installSubagentCatalog(
    parentSessionID: String,
    entries: [ArkSubagentEntry],
    parentAvailable: Bool,
    authoritativeEntries: [ArkSubagentEntry],
    clearRuntimeHints: Bool
  ) {
    subagentCatalogsByParentID[parentSessionID] = .ready(ArkSubagentCatalog(
      entries: entries,
      parentAvailable: parentAvailable
    ))
    if entries.contains(where: { $0.kind == "child" }) {
      subagentKnownParents.insert(parentSessionID)
    }

    let parent = sessionSummary(for: parentSessionID)
    for entry in entries where entry.kind == "child" {
      subagentEntriesByID[entry.id] = entry
      subagentParentAvailableByID[entry.id] = parentAvailable
      let existing = sessionSummary(for: entry.id)
      catalogSubagentSummariesByID[entry.id] = ArkSessionSummary(
        id: entry.id,
        title: entry.label?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
          ? entry.label!
          : existing?.title ?? entry.id,
        updatedAt: existing?.updatedAt ?? parent?.updatedAt ?? .distantPast,
        running: entry.activity == "running",
        blank: false,
        cwd: existing?.cwd ?? parent?.cwd,
        agentPreset: existing?.agentPreset ?? parent?.agentPreset,
        permissionPreset: existing?.permissionPreset ?? parent?.permissionPreset,
        parentSessionID: parentSessionID,
        origin: "subagent"
      )
    }

    guard clearRuntimeHints else { return }
    subagentParentAvailabilityOverrides.removeValue(forKey: parentSessionID)
    for entry in authoritativeEntries where entry.kind == "child" {
      subagentActivityHints.removeValue(forKey: entry.id)
      if entry.hasChildren { subagentKnownParents.insert(entry.id) }
      else { subagentKnownParents.remove(entry.id) }
    }
  }

  /// Host session status is the lifecycle authority across post-turn
  /// checkpointing. Apply its push immediately so the composer, transcript,
  /// header and sidebar do not wait on a later navigation fetch.
  private func reconcileSessionRunning(sessionID: String, running: Bool) {
    if let index = sessions.firstIndex(where: { $0.id == sessionID }),
       sessions[index].running != running {
      sessions[index] = replacingRunning(in: sessions[index], with: running)
    }
    if let synthetic = catalogSubagentSummariesByID[sessionID],
       synthetic.running != running {
      catalogSubagentSummariesByID[sessionID] = replacingRunning(in: synthetic, with: running)
    }
  }

  private func replacingRunning(
    in session: ArkSessionSummary,
    with running: Bool
  ) -> ArkSessionSummary {
    ArkSessionSummary(
      id: session.id,
      title: session.title,
      updatedAt: session.updatedAt,
      running: running,
      blank: session.blank,
      cwd: session.cwd,
      agentPreset: session.agentPreset,
      permissionPreset: session.permissionPreset,
      parentSessionID: session.parentSessionID,
      origin: session.origin
    )
  }

  @discardableResult
  private func updateSubagentCatalogEntry(
    sessionID: String,
    running: Bool? = nil,
    hasChildren: Bool? = nil
  ) -> Bool {
    var anyChanged = false
    for parentID in Array(subagentCatalogsByParentID.keys) {
      guard var state = subagentCatalogsByParentID[parentID] else { continue }
      var changed = false
      state.entries = state.entries.map { entry in
        guard entry.id == sessionID else { return entry }
        let nextActivity = running.map { $0 ? "running" : "inactive" } ?? entry.activity
        let nextHasChildren = hasChildren ?? entry.hasChildren
        guard nextActivity != entry.activity || nextHasChildren != entry.hasChildren else {
          return entry
        }
        changed = true
        return ArkSubagentEntry(
          id: entry.id,
          kind: entry.kind,
          mode: entry.mode,
          activity: nextActivity,
          hasChildren: nextHasChildren,
          label: entry.label,
          reason: entry.reason
        )
      }
      if changed {
        anyChanged = true
        subagentCatalogsByParentID[parentID] = state
      }
    }
    if let running, var entry = subagentEntriesByID[sessionID] {
      let nextActivity = running ? "running" : "inactive"
      let nextHasChildren = hasChildren ?? entry.hasChildren
      guard nextActivity != entry.activity || nextHasChildren != entry.hasChildren else {
        return anyChanged
      }
      entry = ArkSubagentEntry(
        id: entry.id,
        kind: entry.kind,
        mode: entry.mode,
        activity: nextActivity,
        hasChildren: nextHasChildren,
        label: entry.label,
        reason: entry.reason
      )
      subagentEntriesByID[sessionID] = entry
      anyChanged = true
    }
    return anyChanged
  }

  package func consumeSubagentNavigationFrame(_ frame: ArkEventFrame) {
    let sessionID = frame.payload["sessionId"]?.stringValue
    switch frame.method {
    case "host/session-added":
      guard frame.payload["origin"]?.stringValue == "subagent",
            let sessionID,
            let parentID = frame.payload["parentSessionId"]?.stringValue
      else { return }
      subagentKnownParents.insert(parentID)
      if let running = frame.payload["running"]?.boolValue {
        subagentActivityHints[sessionID] = running
      }
      updateSubagentCatalogEntry(sessionID: parentID, hasChildren: true)
      refreshSubagentCatalog(parentSessionID: parentID, markStaleIfLoading: true)

    case "host/session-status":
      guard let sessionID, let running = frame.payload["running"]?.boolValue else { return }
      reconcileSessionRunning(sessionID: sessionID, running: running)
      let activityChanged = subagentActivityHints[sessionID] != running
      subagentActivityHints[sessionID] = running
      let catalogChanged = updateSubagentCatalogEntry(sessionID: sessionID, running: running)
      if activityChanged || catalogChanged,
         let parentID = sessionSummary(for: sessionID)?.parentSessionID {
        refreshSubagentCatalog(parentSessionID: parentID, markStaleIfLoading: true)
      }

    case "host/session-removed":
      guard let sessionID else { return }
      let parentID = sessionSummary(for: sessionID)?.parentSessionID
      reconcileSessionRunning(sessionID: sessionID, running: false)
      subagentActivityHints[sessionID] = false
      updateSubagentCatalogEntry(sessionID: sessionID, running: false)
      catalogSubagentSummariesByID.removeValue(forKey: sessionID)
      if var owned = subagentCatalogsByParentID[sessionID] {
        owned.parentAvailable = false
        subagentCatalogsByParentID[sessionID] = owned
        subagentParentAvailabilityOverrides[sessionID] = false
        for entry in owned.entries where entry.kind == "child" {
          subagentParentAvailableByID[entry.id] = false
        }
      }
      if let parentID {
        refreshSubagentCatalog(parentSessionID: parentID, markStaleIfLoading: true)
      }

    default:
      break
    }
  }

  private func subagentAddress(
    for sessionID: String
  ) async throws -> (parentID: String, entry: ArkSubagentEntry)? {
    guard let session = sessionSummary(for: sessionID),
          session.origin == "subagent",
          let parentID = session.parentSessionID
    else { return nil }
    if let cached = subagentEntriesByID[sessionID] { return (parentID, cached) }
    let catalog = try await client.subagentCatalog(parentSessionID: parentID)
    let entries = ArkSubagentLineageProjection.applyingRuntimeHints(
      catalog.entries,
      activity: subagentActivityHints,
      knownParents: subagentKnownParents
    )
    installSubagentCatalog(
      parentSessionID: parentID,
      entries: entries,
      parentAvailable: subagentParentAvailabilityOverrides[parentID] ?? catalog.parentAvailable,
      authoritativeEntries: catalog.entries,
      clearRuntimeHints: true
    )
    guard let entry = subagentEntriesByID[sessionID], entry.kind == "child" else {
      throw ArkAPIError(message: "子代理会话当前不可读取")
    }
    return (parentID, entry)
  }

  private func historyPage(
    sessionID: String,
    beforeSequence: Int? = nil,
    maxMessages: Int = 100
  ) async throws -> ArkHistoryPage {
    guard let address = try await subagentAddress(for: sessionID) else {
      return try await client.historyPage(
        sessionID: sessionID,
        beforeSequence: beforeSequence,
        maxMessages: maxMessages
      )
    }
    guard let mode = address.entry.mode else {
      throw ArkAPIError(message: "子代理会话缺少传输模式")
    }
    return try await client.subagentHistoryPage(
      parentSessionID: address.parentID,
      childSessionID: sessionID,
      mode: mode,
      beforeSequence: beforeSequence,
      maxMessages: maxMessages
    )
  }

  public func selectWikiPage(_ id: String?) {
    selectedWikiPageID = id
    guard let id else { return }
    Task { await loadWikiPageContent(id: id) }
  }

  public func searchKnowledge(_ query: String) {
    let normalized = query.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !normalized.isEmpty else {
      knowledgeSearchPaths = []
      return
    }
    Task {
      do {
        let hits = try await client.searchKnowledge(query: normalized, topK: 50)
        knowledgeSearchPaths = Set(hits.map(\.path))
        if let first = wikiPages.first(where: { knowledgeSearchPaths.contains($0.relativePath) }) {
          selectWikiPage(first.id)
        }
        postResultMessage(ArkL10n.format(.toastKnowledgeHits, languagePreference, arguments: [String(hits.count)]))
        knowledgeErrorMessage = nil
      } catch {
        knowledgeErrorMessage = error.localizedDescription
      }
    }
  }

  public func clearKnowledgeSearch() {
    knowledgeSearchPaths = []
  }

  public func selectKnowledgeProject(path: String) {
    guard wikiProjects.contains(where: { $0.path == path }) else { return }
    knowledgeErrorMessage = nil
    stopKnowledgeIngestPolling(resetQueue: true)
    selectedKnowledgeProjectPath = path
    wikiTask?.cancel()
    wikiTask = Task { [weak self] in await self?.loadWiki() }
  }

  public func createKnowledgeProject(name: String, path: String) {
    let normalizedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
    let normalizedPath = path.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !normalizedName.isEmpty, !normalizedPath.isEmpty else { return }
    Task {
      do {
        let value = try await client.remoteCall(
          method: "knowledgeWiki/createProject",
          args: [
            "request": .object([
              "name": .string(normalizedName),
              "path": .string(normalizedPath),
            ]),
          ]
        )
        if let message = value["error"]?.stringValue, !message.isEmpty {
          throw ArkAPIError(message: message)
        }
        _ = try await client.remoteCall(
          method: "knowledgeWiki/setProject",
          args: ["request": .object(["path": .string(normalizedPath)])]
        )
        stopKnowledgeIngestPolling(resetQueue: true)
        selectedKnowledgeProjectPath = normalizedPath
        await loadWiki()
        postResultMessage(ArkL10n.text(.toastKnowledgeProjectCreated, languagePreference))
        knowledgeErrorMessage = nil
      } catch {
        knowledgeErrorMessage = error.localizedDescription
      }
    }
  }

  public func removeKnowledgeProject(path: String) {
    let normalized = URL(fileURLWithPath: path).standardizedFileURL.path
    guard let project = wikiProjects.first(where: {
      URL(fileURLWithPath: $0.path).standardizedFileURL.path == normalized
    }), !project.isMain else { return }
    guard !workspaces.contains(where: {
      URL(fileURLWithPath: $0.path).standardizedFileURL.path == normalized
    }) else {
      knowledgeErrorMessage = ArkL10n.text(.wikiProjectManagedByWorkspace, languagePreference)
      return
    }
    Task {
      do {
        try await unregisterKnowledgeProject(path: project.path)
        if selectedKnowledgeProjectPath.map({
          URL(fileURLWithPath: $0).standardizedFileURL.path == normalized
        }) == true {
          stopKnowledgeIngestPolling(resetQueue: true)
          selectedKnowledgeProjectPath = nil
        }
        wikiTask?.cancel()
        wikiTask = nil
        await loadWiki()
        postResultMessage(ArkL10n.text(.toastKnowledgeProjectRemoved, languagePreference))
        knowledgeErrorMessage = nil
      } catch {
        knowledgeErrorMessage = error.localizedDescription
      }
    }
  }

  public func importKnowledgeSources(_ urls: [URL]) {
    guard !urls.isEmpty else { return }
    let projectRoot = URL(
      fileURLWithPath: selectedKnowledgeProjectPath
        ?? fallbackWikiRoot.deletingLastPathComponent().path,
      isDirectory: true
    )
    Task {
      do {
        let inputs = try await Task.detached(priority: .userInitiated) {
          let manager = FileManager.default
          let sourceRoot = projectRoot.appendingPathComponent("raw/sources", isDirectory: true)
          try manager.createDirectory(at: sourceRoot, withIntermediateDirectories: true)
          return try urls.map { url -> String in
            let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
            guard values.isRegularFile == true, values.isSymbolicLink != true else {
              throw ArkAPIError(message: "知识导入仅支持普通文件")
            }
            guard (values.fileSize ?? 0) <= 100 * 1024 * 1024 else {
              throw ArkAPIError(message: "单个知识来源文件不能超过 100 MB")
            }
            let rawName = url.lastPathComponent.replacingOccurrences(of: "/", with: "_")
            let stem = URL(fileURLWithPath: rawName).deletingPathExtension().lastPathComponent
            let suffix = URL(fileURLWithPath: rawName).pathExtension
            var destination = sourceRoot.appendingPathComponent(rawName)
            if manager.fileExists(atPath: destination.path) {
              let unique = "\(stem)-\(UUID().uuidString.lowercased())"
                + (suffix.isEmpty ? "" : ".\(suffix)")
              destination = sourceRoot.appendingPathComponent(unique)
            }
            try manager.copyItem(at: url, to: destination)
            return "raw/sources/\(destination.lastPathComponent)"
          }
        }.value
        let queue = try await client.enqueueKnowledgeIngest(inputs: inputs)
        installKnowledgeIngestQueue(queue)
        postResultMessage(ArkL10n.format(.toastKnowledgeImported, languagePreference, arguments: [String(inputs.count)]))
        knowledgeErrorMessage = nil
      } catch {
        knowledgeErrorMessage = error.localizedDescription
      }
    }
  }

  @discardableResult
  public func importKnowledgeURL(_ rawValue: String) -> Bool {
    guard let normalized = ArkHTTPURLInput.normalizedHTTPURL(rawValue) else {
      wikiIngestError = ArkL10n.text(.wikiImportURLInvalid, languagePreference)
      return false
    }
    guard !wikiIngestBusy else { return false }
    wikiIngestBusy = true
    wikiIngestError = nil
    Task {
      defer { wikiIngestBusy = false }
      do {
        let queue = try await client.enqueueKnowledgeIngest(inputs: [normalized])
        installKnowledgeIngestQueue(queue)
        postResultMessage(ArkL10n.format(
          .toastKnowledgeImported,
          languagePreference,
          arguments: ["1"]
        ))
        knowledgeErrorMessage = nil
      } catch {
        wikiIngestError = error.localizedDescription
      }
    }
    return true
  }

  public func refreshKnowledgeIngestQueue() {
    guard !wikiIngestBusy else { return }
    wikiIngestBusy = true
    Task {
      defer { wikiIngestBusy = false }
      do {
        installKnowledgeIngestQueue(try await client.knowledgeIngestQueueStatus())
        wikiIngestError = nil
      } catch {
        wikiIngestError = error.localizedDescription
      }
    }
  }

  /// Cancel every pending ingest. The Host does not expose authority to kill
  /// the currently running task, so the UI states that boundary explicitly.
  public func cancelPendingKnowledgeIngests() {
    guard !wikiIngestBusy, wikiIngestQueue.pendingCount > 0 else { return }
    wikiIngestBusy = true
    wikiIngestError = nil
    Task {
      defer { wikiIngestBusy = false }
      do {
        installKnowledgeIngestQueue(try await client.cancelPendingKnowledgeIngests())
        knowledgeErrorMessage = nil
      } catch {
        wikiIngestError = error.localizedDescription
      }
    }
  }

  private func installKnowledgeIngestQueue(_ queue: ArkKnowledgeIngestQueue) {
    wikiIngestQueue = queue
    if queue.hasActiveTasks {
      startKnowledgeIngestPolling()
    } else {
      stopKnowledgeIngestPolling(resetQueue: false)
    }
  }

  private func startKnowledgeIngestPolling() {
    guard wikiIngestPollingTask == nil else { return }
    wikiIngestPollingGeneration += 1
    let generation = wikiIngestPollingGeneration
    let projectPath = selectedKnowledgeProjectPath
    wikiIngestPollingTask = Task { [weak self] in
      guard let self else { return }
      defer {
        if wikiIngestPollingGeneration == generation { wikiIngestPollingTask = nil }
      }
      var delay: UInt64 = 1
      while !Task.isCancelled {
        do {
          try await Task.sleep(nanoseconds: delay * 1_000_000_000)
        } catch {
          if !isTaskCancellation(error) { wikiIngestError = error.localizedDescription }
          break
        }
        guard
          wikiIngestPollingGeneration == generation,
          selectedKnowledgeProjectPath == projectPath
        else { return }
        do {
          let snapshot = try await client.knowledgeIngestQueueStatus()
          guard wikiIngestPollingGeneration == generation else { return }
          wikiIngestQueue = snapshot
          wikiIngestError = nil
          if !snapshot.hasActiveTasks {
            await loadWiki(refreshIngestQueue: false)
            return
          }
          delay = min(delay * 2, 5)
        } catch {
          if isTaskCancellation(error) { return }
          wikiIngestError = error.localizedDescription
          delay = 5
        }
      }
    }
  }

  private func stopKnowledgeIngestPolling(resetQueue: Bool) {
    wikiIngestPollingGeneration += 1
    wikiIngestPollingTask?.cancel()
    wikiIngestPollingTask = nil
    if resetQueue {
      wikiIngestQueue = ArkKnowledgeIngestQueue(tasks: [], running: false, cancelled: false)
      wikiIngestError = nil
    }
  }

  public func createKnowledgePage(title: String, content: String) {
    let normalized = title.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !normalized.isEmpty else { return }
    Task {
      do {
        let result = try await client.createKnowledgePage(
          title: normalized,
          content: content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : content
        )
        guard result.succeeded else {
          throw ArkAPIError(message: result.error ?? "知识页面创建失败")
        }
        await loadWiki()
        if let page = wikiPages.first(where: { $0.relativePath == result.path }) {
          selectWikiPage(page.id)
        }
        postResultMessage(ArkL10n.text(.toastKnowledgePageCreated, languagePreference))
        knowledgeErrorMessage = nil
      } catch {
        knowledgeErrorMessage = error.localizedDescription
      }
    }
  }

  public func clearWikiSaveError() {
    wikiSaveError = nil
  }

  public func saveKnowledgePage(
    id: String,
    content: String,
    expectedContent: String
  ) {
    guard wikiSavingPageID == nil,
          let page = wikiPages.first(where: { $0.id == id })
    else { return }
    wikiSavingPageID = id
    wikiSaveError = nil
    Task { [weak self] in
      guard let self else { return }
      defer {
        if self.wikiSavingPageID == id { self.wikiSavingPageID = nil }
      }
      do {
        let result = try await self.client.writeKnowledgePage(
          path: page.relativePath,
          content: content,
          expectedContent: expectedContent
        )
        guard result.succeeded else {
          self.wikiSaveError = result.conflict
            ? "页面已在磁盘上被修改，请重新载入后再保存。"
            : (result.error ?? "知识页面保存失败")
          return
        }
        await self.loadWiki()
        if self.selectedWikiPageID == id {
          await self.loadWikiPageContent(id: id)
        }
        self.wikiSaveRevision &+= 1
        self.postResultMessage("知识页面已保存")
        self.knowledgeErrorMessage = nil
      } catch {
        let message = error.localizedDescription
        self.wikiSaveError = message.contains("page changed on disk")
          ? "页面已在磁盘上被修改，请重新载入后再保存。"
          : message
      }
    }
  }

  public func runDeepResearch(topic: String) {
    let normalized = topic.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !normalized.isEmpty else { return }
    Task {
      do {
        let findings = try await client.runDeepResearch(topic: normalized)
        await loadWiki()
        postResultMessage(ArkL10n.format(.toastDeepResearchDone, languagePreference, arguments: [String(findings.count)]))
        knowledgeErrorMessage = nil
      } catch {
        knowledgeErrorMessage = error.localizedDescription
      }
    }
  }

  public func resolveReview(_ reviewID: String, action: String?) {
    guard !wikiReviewBusy else { return }
    wikiReviewBusy = true
    wikiReviewError = nil
    Task {
      defer { wikiReviewBusy = false }
      do {
        guard try await client.resolveKnowledgeReview(reviewID: reviewID, action: action) else {
          throw ArkAPIError(message: "Review 未被本机知识服务接受")
        }
        await loadWiki()
        postResultMessage(ArkL10n.text(.toastReviewProcessed, languagePreference))
        knowledgeErrorMessage = nil
      } catch {
        wikiReviewError = error.localizedDescription
      }
    }
  }

  public func resolveReviews(_ reviewIDs: [String], action: String? = "Skip") {
    let ids = Array(Set(reviewIDs)).filter { !$0.isEmpty }
    guard !ids.isEmpty, !wikiReviewBusy else { return }
    wikiReviewBusy = true
    wikiReviewError = nil
    Task {
      defer { wikiReviewBusy = false }
      do {
        let count = try await client.resolveKnowledgeReviews(reviewIDs: ids, action: action)
        guard count > 0 else {
          throw ArkAPIError(message: ArkL10n.text(.wikiBulkReviewFailed, languagePreference))
        }
        await loadWiki()
        postResultMessage(ArkL10n.format(
          .toastReviewsProcessed,
          languagePreference,
          arguments: [String(count)]
        ))
        knowledgeErrorMessage = nil
      } catch {
        wikiReviewError = error.localizedDescription
      }
    }
  }

  private func loadWiki(refreshIngestQueue: Bool = true) async {
    let requestedLanguage = languagePreference
    var root = fallbackWikiRoot
    do {
      let projectValue = try await client.remoteCall(method: "knowledgeWiki/listProjects")
      var projects = (projectValue["projects"]?.arrayValue ?? []).compactMap { value -> ArkKnowledgeProject? in
        guard let path = value["path"]?.stringValue, !path.isEmpty else { return nil }
        return ArkKnowledgeProject(
          path: path,
          name: value["name"]?.stringValue ?? URL(fileURLWithPath: path).lastPathComponent,
          isMain: value["main"]?.boolValue == true
        )
      }
      let fallbackPath = fallbackWikiRoot.deletingLastPathComponent().path
      if !projects.contains(where: \.isMain) {
        projects.insert(ArkKnowledgeProject(path: fallbackPath, name: "万相织鉴", isMain: true), at: 0)
      }
      let main = projects.first(where: \.isMain) ?? projects[0]
      let requestedPath = selectedKnowledgeProjectPath
      let project = projects.first(where: { $0.path == requestedPath }) ?? main
      wikiProjects = projects
      selectedKnowledgeProjectPath = project.path
      activeWikiTitle = project.displayName
      root = project.isMain
        ? fallbackWikiRoot
        : URL(fileURLWithPath: project.path, isDirectory: true)
          .appendingPathComponent("wiki", isDirectory: true)
      _ = try await client.remoteCall(
        method: "knowledgeWiki/setProject",
        args: ["request": .object(["path": .string(project.path)])]
      )
      async let listValue = client.remoteCall(method: "knowledgeWiki/list")
      async let graphValue = client.remoteCall(method: "knowledgeWiki/graph")
      async let reviewValue = client.remoteCall(
        method: "knowledgeWiki/reviews",
        args: ["request": .object(["status": .string("all"), "limit": .number(200)])]
      )
      let (list, graph, reviews) = try await (listValue, graphValue, reviewValue)
      guard selectedKnowledgeProjectPath == project.path,
            languagePreference == requestedLanguage
      else { return }
      let nodesByPath = ArkWikiLoader.firstGraphNodeByPath(
        graph["nodes"]?.arrayValue ?? []
      )
      let fileRows = ArkWikiLoader.localizedFileRows(
        flattenWikiEntries(list),
        language: requestedLanguage
      )
      var pathToID: [String: String] = [:]
      for row in fileRows {
        guard let path = row["path"]?.stringValue, !path.isEmpty else { continue }
        pathToID[path] = nodesByPath[path]?["id"]?.stringValue
          ?? String(path.dropLast(path.hasSuffix(".md") ? 3 : 0))
      }
      let loadedPages: [ArkWikiPage] = fileRows.compactMap { row -> ArkWikiPage? in
        guard let path = row["path"]?.stringValue, !path.isEmpty else { return nil }
        let node = nodesByPath[path]
        let id = pathToID[path] ?? path
        let title = node?["label"]?.stringValue
          ?? ArkWikiLoader.fallbackTitle(path: path, name: row["name"]?.stringValue)
        let category = node?["type"]?.stringValue ?? path.split(separator: "/").first.map(String.init) ?? "other"
        return ArkWikiPage(
          id: id,
          title: title,
          relativePath: path,
          category: category,
          community: node?["community"]?.numberValue.map(Int.init),
          body: "",
          links: [],
          byteCount: Int(row["size"]?.numberValue ?? 0)
        )
      }
      wikiPages = ArkWikiLoader.uniquePagesByID(loadedPages)
      let loadedEdges: [ArkWikiEdge] = (graph["edges"]?.arrayValue ?? []).compactMap { edge in
        guard let source = edge["source"]?.stringValue, let target = edge["target"]?.stringValue else { return nil }
        return ArkWikiEdge(source: source, target: target)
      }
      wikiEdges = ArkWikiLoader.visibleEdges(loadedEdges, pages: wikiPages)
      wikiReviews = (reviews.arrayValue ?? []).compactMap { review in
        guard let id = review["id"]?.stringValue,
              let title = review["title"]?.stringValue,
              let type = review["type"]?.stringValue
        else { return nil }
        return ArkWikiReview(
          id: id,
          title: title,
          type: type,
          description: review["description"]?.stringValue ?? "",
          affectedPages: review["affectedPages"]?.arrayValue?.compactMap(\.stringValue) ?? [],
          actions: (review["options"]?.arrayValue ?? []).compactMap { option in
            guard let action = option["action"]?.stringValue,
                  let label = option["label"]?.stringValue
            else { return nil }
            return ArkWikiReviewAction(action: action, label: label)
          },
          resolved: review["resolved"]?.boolValue ?? false
        )
      }
      if refreshIngestQueue,
         let queue = try? await client.knowledgeIngestQueueStatus()
      {
        installKnowledgeIngestQueue(queue)
      }
      if wikiPages.isEmpty {
        let fallback = try ArkWikiLoader.load(root: root)
        wikiPages = ArkWikiLoader.localizedPages(fallback.0, language: requestedLanguage)
        wikiEdges = ArkWikiLoader.visibleEdges(fallback.1, pages: wikiPages)
      }
      if selectedWikiPageID == nil
        || !wikiPages.contains(where: { $0.id == selectedWikiPageID }) {
        selectedWikiPageID = wikiPages.first?.id
      }
      if let selectedWikiPageID { await loadWikiPageContent(id: selectedWikiPageID) }
    } catch {
      do {
        guard languagePreference == requestedLanguage else { return }
        let fallback = try ArkWikiLoader.load(root: root)
        wikiPages = ArkWikiLoader.localizedPages(fallback.0, language: requestedLanguage)
        wikiEdges = ArkWikiLoader.visibleEdges(fallback.1, pages: wikiPages)
        wikiReviews = []
        if selectedWikiPageID == nil
          || !wikiPages.contains(where: { $0.id == selectedWikiPageID }) {
          selectedWikiPageID = wikiPages.first?.id
        }
      } catch {
        // 页面切换导致的正常取消：保持现有数据，不清空、不报错。
        if isTaskCancellation(error) { return }

        wikiPages = []
        wikiEdges = []
        wikiReviews = []
        knowledgeErrorMessage = error.localizedDescription
      }
    }
  }

  private func loadWikiPageContent(id: String) async {
    guard let index = wikiPages.firstIndex(where: { $0.id == id }) else { return }
    let page = wikiPages[index]
    do {
      let value = try await client.remoteCall(
        method: "knowledgeWiki/pageContent",
        args: ["request": .object(["path": .string(page.relativePath)])]
      )
      guard selectedWikiPageID == id,
            let currentIndex = wikiPages.firstIndex(where: { $0.id == id })
      else { return }
      let content = value["content"]?.stringValue ?? ""
      wikiPages[currentIndex] = ArkWikiPage(
        id: page.id,
        title: page.title,
        relativePath: page.relativePath,
        category: page.category,
        community: page.community,
        body: content,
        links: page.links,
        byteCount: page.byteCount
      )
    } catch {
      // The file-backed fallback already carries content; keep it unchanged.
    }
  }

  private func flattenWikiEntries(_ value: JSONValue) -> [JSONValue] {
    let rows = value.arrayValue ?? value["items"]?.arrayValue ?? []
    return rows.flatMap { row -> [JSONValue] in
      let children = row["children"]?.arrayValue ?? []
      let current = row["isDir"]?.boolValue == true ? [] : [row]
      return current + children.flatMap { flattenWikiEntries(.array([$0])) }
    }
  }

  private func refreshModelLabel(for sessionID: String) async {
    do {
      let label = try await client.modelLabel(sessionID: sessionID)
      guard selectedSessionID == sessionID else { return }
      modelLabel = label
    } catch {
      guard selectedSessionID == sessionID else { return }
      modelLabel = "未配置模型"
    }
  }

  private func refreshModelCatalog(for sessionID: String) async {
    modelCatalogLoadGeneration &+= 1
    let requestGeneration = modelCatalogLoadGeneration
    let settingsGeneration = settingsLoadGeneration
    do {
      let catalog = try await client.sessionModels(sessionID: sessionID)
      guard selectedSessionID == sessionID, requestGeneration == modelCatalogLoadGeneration,
        settingsGeneration == settingsLoadGeneration else { return }
      modelCatalog = catalog
    } catch {
      guard selectedSessionID == sessionID, requestGeneration == modelCatalogLoadGeneration,
        settingsGeneration == settingsLoadGeneration else { return }
      modelCatalog = nil
    }
  }

  /// `session.models` can itself coincide with another subscribed frame.
  /// Coalesce those frames per selected session so capability recovery cannot
  /// recursively start another model metadata request and invalidate the
  /// entire transcript without end.
  private func refreshSubscribedModelMetadata(for sessionID: String) async {
    guard modelMetadataHydrationSessionID != sessionID else { return }
    modelMetadataHydrationSessionID = sessionID
    defer {
      if modelMetadataHydrationSessionID == sessionID {
        modelMetadataHydrationSessionID = nil
      }
    }
    async let label: Void = refreshModelLabel(for: sessionID)
    async let catalog: Void = refreshModelCatalog(for: sessionID)
    _ = await (label, catalog)
  }

  private func consume(_ frame: ArkEventFrame) {
    switch frame.method {
    case "stream/state":
      guard frame.payload["channel"]?.stringValue == frame.channel.rawValue,
            let rawState = frame.payload["state"]?.stringValue,
            let state = ArkEventConnectionState(rawValue: rawState)
      else {
        markEventChannelDegraded(frame.channel, message: "事件连接返回了无效状态")
        return
      }
      setEventConnectionState(frame.channel, state: state)
    case "stream/baseline":
      guard frame.payload["channel"]?.stringValue == frame.channel.rawValue,
            let generation = frame.payload["generation"]?.stringValue,
            !generation.isEmpty,
            let phase = frame.payload["phase"]?.stringValue
      else {
        markEventChannelDegraded(frame.channel, message: "事件连接基线无效")
        return
      }
      if phase == "begin" {
        eventBaselineGenerationByChannel[frame.channel] = generation
        setEventConnectionState(frame.channel, state: .connecting)
        return
      }
      guard phase == "complete",
            eventBaselineGenerationByChannel[frame.channel] == generation,
            let rawSessionIDs = frame.payload["sessionIds"]?.arrayValue
      else {
        markEventChannelDegraded(frame.channel, message: "事件连接基线未完整结束")
        return
      }
      var sessionIDs = Set<String>()
      for value in rawSessionIDs {
        guard let sessionID = value.stringValue, !sessionID.isEmpty else {
          markEventChannelDegraded(frame.channel, message: "事件连接基线包含无效会话")
          return
        }
        sessionIDs.insert(sessionID)
      }
      eventBaselineGenerationByChannel.removeValue(forKey: frame.channel)
      setEventConnectionState(frame.channel, state: .connected)
      if frame.channel == .mux {
        subscribedLastSequenceBySessionID = subscribedLastSequenceBySessionID.filter {
          sessionIDs.contains($0.key)
        }
        let staleInteractionIDs = approvals
          .filter { !sessionIDs.contains($0.sessionID) }
          .map(\.id)
          + questions.filter { !sessionIDs.contains($0.sessionID) }.map(\.id)
        approvals.removeAll { !sessionIDs.contains($0.sessionID) }
        questions.removeAll { !sessionIDs.contains($0.sessionID) }
        respondingInteractionIDs.subtract(staleInteractionIDs)
        pendingInteractionOrder.removeAll { staleInteractionIDs.contains($0) }
        pendingInteractionCount = approvals.count + questions.count
      } else {
        scheduleNavigationRefresh()
      }
    case "session/subscribed":
      guard let sessionID = frame.payload["sessionId"]?.stringValue,
            let lastSequence = ArkEventSequenceValidator.safeInteger(
              frame.payload["lastSeq"],
              minimum: -1
            )
      else {
        markEventChannelDegraded(.mux, message: "会话订阅包含无效事件序号")
        return
      }
      subscribedLastSequenceBySessionID[sessionID] = lastSequence
      composerCatalogs.removeValue(forKey: sessionID)
      if sessionID == selectedSessionID { prewarmComposerCatalog(for: sessionID) }
      let staleInteractionIDs = approvals.filter { $0.sessionID == sessionID }.map(\.id)
        + questions.filter { $0.sessionID == sessionID }.map(\.id)
      respondingInteractionIDs.subtract(staleInteractionIDs)
      approvals.removeAll { $0.sessionID == sessionID }
      questions.removeAll { $0.sessionID == sessionID }
      pendingInteractionOrder.removeAll { staleInteractionIDs.contains($0) }
      pendingInteractionCount = approvals.count + questions.count
      if sessionID == selectedSessionID {
        queuedPrompts = []
        queueMutationIDs = []
        sessionJobs = []
        sessionProjections = [:]
        livePublishTask?.cancel()
        livePublishTask = nil
        pendingLiveEvents = []
        events.removeAll { $0.id > lastSequence }
        seenEventIDs = Set(events.map(\.id))
        historyTask?.cancel()
        historyTask = Task { [weak self] in
          guard let self else { return }
          // A running session can resubscribe before its newest turn is
          // durable in history. Preserve the already-rendered transcript in
          // that case; only an empty, first-time surface may replace itself
          // from an authoritative page.
          let resetHistory = self.events.isEmpty
          async let history: Void = self.refreshHistory(resetPaging: resetHistory)
          async let feedback: Void = self.loadMessageFeedback(for: sessionID)
          async let modelMetadata: Void = self.refreshSubscribedModelMetadata(for: sessionID)
          _ = await (history, feedback, modelMetadata)
        }
      }
    case "session/event":
      guard let sessionID = frame.payload["sessionId"]?.stringValue,
            sessionID == selectedSessionID,
            let wireEvent = frame.payload["event"],
            let wireSequence = ArkEventSequenceValidator.safeInteger(wireEvent["seq"]),
            let event = ArkAPIClient.event(fromWire: wireEvent, view: frame.payload["view"]),
            event.id == wireSequence
      else {
        if frame.payload["sessionId"]?.stringValue == selectedSessionID {
          markEventChannelDegraded(.mux, message: "会话事件包含无效事件序号")
        }
        return
      }
      guard seenEventIDs.insert(event.id).inserted else { return }
      let latestKnownSequence = max(
        events.last?.id ?? -1,
        pendingLiveEvents.last?.id ?? -1
      )
      if latestKnownSequence >= 0, event.id != latestKnownSequence + 1 {
        seenEventIDs.remove(event.id)
        subscribedLastSequenceBySessionID[sessionID] = max(
          subscribedLastSequenceBySessionID[sessionID] ?? -1,
          event.id
        )
        markEventChannelDegraded(
          .mux,
          message: "会话事件序号不连续（应为 \(latestKnownSequence + 1)，实际为 \(event.id)）"
        )
        scheduleEventResync(sessionID: sessionID)
        return
      }
      pendingLiveEvents.append(event)
      _ = messageProjection.append(event)
      toolProjection.append(event)
      producedFilesProjection.append(event)
      statusProjection.append(event)
      scheduleLivePublish()
    case "session/projection":
      guard frame.payload["sessionId"]?.stringValue == selectedSessionID else { return }
      let key = frame.payload["key"]?.stringValue
      if let key, let value = frame.payload["value"] { sessionProjections[key] = value }
      if key == "permissions" || key == "title" {
        scheduleNavigationRefresh()
      }
    case "approval/requested":
      if let request = ArkInteractionAPIContract.approvalRequest(from: frame),
         !approvals.contains(where: { $0.id == request.id }) {
        approvals.append(request)
        pendingInteractionOrder.append(request.id)
      }
      pendingInteractionCount = approvals.count + questions.count
    case "question/requested":
      if let request = ArkInteractionAPIContract.questionRequest(from: frame),
         !questions.contains(where: { $0.id == request.id }) {
        questions.append(request)
        pendingInteractionOrder.append(request.id)
      }
      pendingInteractionCount = approvals.count + questions.count
    case "approval/resolved":
      if let approvalID = frame.payload["approvalId"]?.stringValue {
        for request in approvals where request.approvalID == approvalID {
          respondingInteractionIDs.remove(request.id)
        }
        approvals.removeAll { $0.approvalID == approvalID }
        pendingInteractionOrder.removeAll { requestID in
          !approvals.contains(where: { $0.id == requestID })
            && !questions.contains(where: { $0.id == requestID })
        }
      }
      pendingInteractionCount = approvals.count + questions.count
    case "question/resolved":
      let rpcID = frame.payload["questionRpcId"]?.stringValue ?? frame.rpcID
      respondingInteractionIDs.remove(rpcID)
      questions.removeAll { $0.rpcID == rpcID }
      pendingInteractionOrder.removeAll { requestID in
        !approvals.contains(where: { $0.id == requestID })
          && !questions.contains(where: { $0.id == requestID })
      }
      pendingInteractionCount = approvals.count + questions.count
    case "session/queue":
      if let snapshot = ArkInteractionAPIContract.queueSnapshot(from: frame),
         snapshot.sessionID == selectedSessionID {
        queuedPrompts = snapshot.items
      }
    case "session/jobs":
      guard frame.payload["sessionId"]?.stringValue == selectedSessionID else { return }
      sessionJobs = frame.payload["jobs"]?.arrayValue ?? []
    case "host/agent-error":
      guard frame.payload["sessionId"]?.stringValue == selectedSessionID else { return }
      appendTransientChatError(
        id: "host-agent-error-\(frame.rpcID)",
        message: frame.payload["message"]?.stringValue ?? "当前会话发生运行错误"
      )
    case "host/session-added", "host/session-removed", "host/session-status",
         "host/workspace-changed", "host/workspace-removed", "host/workspace-order-changed",
         "host/archived-sessions-changed":
      consumeSubagentNavigationFrame(frame)
      scheduleNavigationRefresh()
    case "host/session-deleted":
      if let values = frame.payload["archivedSessionIds"]?.arrayValue {
        archivedSessionIDs = Set(values.compactMap(\.stringValue))
      }
      if let deletedID = frame.payload["sessionId"]?.stringValue {
        subscribedLastSequenceBySessionID.removeValue(forKey: deletedID)
        removeConversationSurfaceSnapshot(for: deletedID)
      }
      if let deletedID = frame.payload["sessionId"]?.stringValue,
         selectedSessionID == deletedID {
        selectedSessionID = nil
        events = []
        turnProjection = ArkChatTurnProjection()
        turnUsageByTurn = [:]
        messages = []
        toolActivities = []
        producedFiles = []
        chatStatuses = []
        selectedToolActivityID = nil
        messageImages.configure(sessionID: nil)
        chatPresentationDidChange.send()
      }
      scheduleNavigationRefresh()
    case "host/remote-event":
      let event = frame.payload["event"]?.stringValue
      if event == "settings/document-updated" {
        Task { [weak self] in await self?.loadSettings() }
      }
      if event == "commands/change" {
        invalidateComposerCatalog()
      } else if event == "agent-preset/selected" {
        invalidateComposerCatalog(for: selectedSessionID)
      }
    case "stream/error":
      let message = frame.payload["error"]?["message"]?.stringValue ?? "事件连接发生错误"
      markEventChannelDegraded(frame.channel, message: message, rpcID: frame.rpcID)
    default:
      break
    }
  }

  private func setEventConnectionState(
    _ channel: ArkEventChannel,
    state: ArkEventConnectionState
  ) {
    if eventConnectionStates[channel] != state { eventConnectionStates[channel] = state }
    if state == .connected {
      let previousError = eventConnectionErrors.removeValue(forKey: channel)
      if channel == .mux, composerErrorMessage == previousError {
        composerErrorMessage = nil
      } else if channel == .host, navigationErrorMessage == previousError {
        navigationErrorMessage = nil
      }
    }
  }

  private func markEventChannelDegraded(
    _ channel: ArkEventChannel,
    message: String,
    rpcID: String = UUID().uuidString
  ) {
    eventConnectionStates[channel] = .degraded
    eventConnectionErrors[channel] = message
    if channel == .mux { composerErrorMessage = message }
    else { navigationErrorMessage = message }
    if selectedSessionID != nil {
      appendTransientChatError(
        id: "stream-error-\(channel.rawValue)-\(rpcID)",
        message: message
      )
    }
  }

  private func scheduleEventResync(sessionID: String) {
    guard eventResyncTask == nil else { return }
    eventResyncTask = Task { [weak self] in
      defer { self?.eventResyncTask = nil }
      try? await Task.sleep(nanoseconds: 100_000_000)
      guard let self, !Task.isCancelled, self.selectedSessionID == sessionID else { return }
      await self.refreshHistory(resetPaging: false)
    }
  }

  private func appendTransientChatError(id: String, message: String) {
    guard !chatStatuses.contains(where: { $0.id == id }) else { return }
    let sequence = max(events.last?.id ?? -1, chatStatuses.map(\.sequence).max() ?? -1) + 1
    chatStatuses.append(ArkChatStatus(
      id: id,
      sequence: sequence,
      kind: .error,
      phase: .failed,
      title: "会话连接错误",
      detail: message
    ))
    chatStatuses.sort {
      $0.sequence == $1.sequence ? $0.id < $1.id : $0.sequence < $1.sequence
    }
    chatPresentationDidChange.send()
  }

  private func scheduleLivePublish() {
    guard livePublishTask == nil, !historyFoldInFlight else { return }
    let intervalNanoseconds = ArkStreamingPresentationPolicy.intervalNanoseconds(
      eventCount: events.count + pendingLiveEvents.count
    )
    livePublishTask = Task { [weak self] in
      try? await Task.sleep(nanoseconds: intervalNanoseconds)
      guard let self, !Task.isCancelled else { return }
      let incoming = pendingLiveEvents
      pendingLiveEvents.removeAll(keepingCapacity: true)
      events.append(contentsOf: incoming)
      var chatPresentationChanged = false
      var rebuiltTurnProjection = false
      if events.count > 50_000 {
        let previousMetrics = turnProjection.metricsByTurn
        let previousCompleted = turnProjection.completedSequenceByTurn
        let previousStartedTurn = turnProjection.latestStartedTurn
        let previousStartedSequence = turnProjection.latestStartedSequence
        let previousUsage = turnUsageByTurn
        let removed = Array(events.prefix(events.count - 50_000))
        events.removeFirst(events.count - 50_000)
        for event in removed { seenEventIDs.remove(event.id) }
        historyBeforeSequence = events.first?.id
        hasOlderHistory = true
        turnProjection = ArkChatTurnProjection(events: events)
        turnProjection.preserveLatestStartedBoundary(
          turn: previousStartedTurn,
          sequence: previousStartedSequence
        )
        turnUsageByTurn = ArkChatTurnUsageProjection.projectAll(events: events)
        chatPresentationChanged = previousMetrics != turnProjection.metricsByTurn
          || previousCompleted != turnProjection.completedSequenceByTurn
          || previousUsage != turnUsageByTurn
        rebuiltTurnProjection = true
      }
      if !rebuiltTurnProjection {
        let touchedTurns = Set(incoming.compactMap { ArkChatTurnUsageProjection.turn(in: $0) })
        let previousMetrics = turnProjection.metricsByTurn
        let previousCompleted = turnProjection.completedSequenceByTurn
        turnProjection.append(contentsOf: incoming)
        if touchedTurns.contains(where: {
          previousMetrics[$0] != self.turnProjection.metricsByTurn[$0]
            || previousCompleted[$0] != self.turnProjection.completedSequenceByTurn[$0]
        }) {
          chatPresentationChanged = true
        }
        let completedTurns = Set(incoming.compactMap { event in
          event.type == "turn/end" ? ArkChatTurnUsageProjection.turn(in: event) : nil
        })
        for turn in completedTurns {
          let usage = ArkChatTurnUsageProjection.project(events: events, turn: turn)
          if turnUsageByTurn[turn] != usage { chatPresentationChanged = true }
          if let usage { turnUsageByTurn[turn] = usage }
          else { turnUsageByTurn.removeValue(forKey: turn) }
        }
      }
      markTrajectoryProjectionDirty()
      synchronizeModelLabelFromEvents()
      let nextMessages = messageProjection.messages
      if messages != nextMessages {
        messages = nextMessages
        chatPresentationChanged = true
      }
      let nextToolActivities = toolProjection.activities
      if toolActivities != nextToolActivities {
        toolActivities = nextToolActivities
        chatPresentationChanged = true
      }
      let nextProducedFiles = producedFilesProjection.files
      if producedFiles != nextProducedFiles {
        producedFiles = nextProducedFiles
        chatPresentationChanged = true
      }
      let nextChatStatuses = statusProjection.statuses
      if chatStatuses != nextChatStatuses {
        chatStatuses = nextChatStatuses
        chatPresentationChanged = true
      }
      if chatPresentationChanged { chatPresentationDidChange.send() }
      livePublishTask = nil
      if !pendingLiveEvents.isEmpty { scheduleLivePublish() }
    }
  }

  private func scheduleNavigationRefresh() {
    navigationRefreshTask?.cancel()
    navigationRefreshTask = Task { [weak self] in
      try? await Task.sleep(nanoseconds: 120_000_000)
      guard let self, !Task.isCancelled else { return }
      await refreshNavigation(refreshWiki: false)
      navigationRefreshTask = nil
    }
  }

  private func resetTrajectoryProjectionState() {
    trajectoryProjectionGeneration &+= 1
    trajectoryProjectionTask?.cancel()
    trajectoryProjectionTask = nil
    trajectoryProjectionDirty = true
    trajectoryRecords = []
  }

  private func markTrajectoryProjectionDirty() {
    trajectoryProjectionDirty = true
    if selectedTab == .trajectory { scheduleTrajectoryProjectionIfNeeded() }
  }

  /// Trajectory is an alternate presentation of the same durable events. A
  /// Chat token must never synchronously refold the entire ledger: coalesce
  /// snapshots and perform the pure fold off-main, then install only the newest
  /// selected-session result.
  private func scheduleTrajectoryProjectionIfNeeded() {
    guard selectedTab == .trajectory,
          trajectoryProjectionDirty,
          trajectoryProjectionTask == nil
    else { return }
    trajectoryProjectionDirty = false
    trajectoryProjectionGeneration &+= 1
    let generation = trajectoryProjectionGeneration
    let sessionID = selectedSessionID
    let snapshot = events
    trajectoryProjectionTask = Task { [weak self] in
      let records = await Task.detached(priority: .userInitiated) {
        ArkTrajectoryProjection.records(from: snapshot)
      }.value
      guard let self,
            !Task.isCancelled,
            trajectoryProjectionGeneration == generation,
            selectedSessionID == sessionID
      else { return }
      trajectoryRecords = records
      trajectoryProjectionTask = nil
      if trajectoryProjectionDirty, selectedTab == .trajectory {
        scheduleTrajectoryProjectionIfNeeded()
      }
    }
  }

  /// `session.models` can briefly report no current route while a restored
  /// session is being rehydrated.  Durable request/context records are the
  /// authoritative route actually used, so keep the composer label aligned
  /// with the last semantic request instead of showing a false
  /// "未配置模型" state.
  private func synchronizeModelLabelFromEvents() {
    guard let route = trajectoryRecords.reversed().first(where: {
      $0.provider?.isEmpty == false && $0.model?.isEmpty == false
    }),
    let provider = route.provider,
    let model = route.model
    else { return }
    let effort = defaultModelSelection.flatMap { selection in
      selection.provider == provider && selection.model == model ? selection.reasoningEffort : nil
    }
    let nextLabel = Self.modelDisplayLabel(
      provider: provider,
      model: model,
      reasoningEffort: effort
    )
    if modelLabel != nextLabel { modelLabel = nextLabel }
  }

  /// B 类用户操作的结果提示（成功/中性结果：允许、拒绝、取消等）：
  /// 2.5 秒后自动消失，连续调用只保留最后一条。
  /// A 类状态选择器（权限/模型/Agent 预设等）不得调用——它们完全静默、原地更新。
  /// 后台自动维护动作不得调用——它们成功静默、失败进入所属界面的内联错误状态。
  private func postResultMessage(_ message: String) {
    operationMessageClearTask?.cancel()
    operationMessage = message
    let posted = message
    operationMessageClearTask = Task { [weak self] in
      try? await Task.sleep(nanoseconds: 2_500_000_000)
      guard !Task.isCancelled else { return }
      await MainActor.run {
        if self?.operationMessage == posted { self?.operationMessage = nil }
      }
    }
  }

  private func persist(_ value: String?, key: String) {
    if let value { defaults.set(value, forKey: key) }
    else { defaults.removeObject(forKey: key) }
  }
}
