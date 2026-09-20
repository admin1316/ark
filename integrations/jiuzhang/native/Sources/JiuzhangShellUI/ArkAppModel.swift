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

/// One Session's applied-sequence anchor: the highest sequence this client proved it applied
/// contiguously. The mux baseline seats it, every accepted live frame advances it by exactly one,
/// and a reconciliation may only raise it to the installed head. A frame above the anchor is a
/// hole to page in — never a reason to move the anchor or to drop the local tail, because a
/// dropped tail turns one transient miss into a transcript that can never catch up again.
struct ArkSessionEventCursor: Equatable {
  private(set) var applied: Int

  init(applied: Int = -1) {
    self.applied = applied
  }

  /// The sequence the stream must deliver next to stay contiguous.
  var next: Int { applied + 1 }

  enum Observation: Equatable {
    /// The frame continues the applied range.
    case accepted
    /// The frame is already covered by the installed or reconciled range.
    case covered
    /// The frame proves `target` exists while the local tail stops at `next`; (applied, target]
    /// has to be paged in before anything above it may be applied.
    case hole(target: Int)
  }

  @discardableResult
  mutating func observe(_ sequence: Int) -> Observation {
    if sequence == next {
      applied = sequence
      return .accepted
    }
    if sequence > next { return .hole(target: sequence) }
    return .covered
  }

  /// Reseat the anchor on a Host baseline that declares the log length.
  @discardableResult
  mutating func adoptBaseline(_ lastSequence: Int) -> Observation {
    if lastSequence > applied { return .hole(target: lastSequence) }
    applied = max(-1, lastSequence)
    return .covered
  }

  /// A reconciliation installed a contiguous head; the anchor may only move forward.
  mutating func adoptReconciledHead(_ head: Int) {
    applied = max(applied, head)
  }
}

/// Incremental proof that newest-first history pages bridge one retained
/// contiguous tail to the exact sequence advertised by the mux baseline. Only
/// the newest 50k events are retained for presentation; older traversed pages
/// still advance the proof and pagination cursor without growing memory.
struct ArkHistoryCatchUpAccumulator {
  /// One owner for the presentation cap: the live publisher trims against the same number.
  static let maximumPresentationEvents = ArkStreamingPresentationPolicy.presentedEventLimit
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
  /// Longest transcript retained in memory for presentation.
  static let presentedEventLimit = 50_000
  /// Events dropped once {@link presentedEventLimit} is exceeded. Rebuilding the turn projections
  /// over the whole window costs O(limit), so trimming to a lower watermark pays that once per
  /// batch instead of on every publish — at the limit the difference is the main actor being free
  /// to drain the event socket at all.
  static let presentationTrimBatch = 5_000
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

  /// Collapsed "Think" row text: the newest non-empty reasoning line, with inline
  /// Markdown markers removed so the row shows prose rather than `**` punctuation.
  /// The expanded body keeps the complete text, markers included.
  /// @param text - complete reasoning text.
  /// @param fallback - text used when no non-empty line exists.
  /// @returns one bounded summary line.
  static func reasoningSummary(_ text: String, fallback: String) -> String {
    let recent = String(text.suffix(512))
    let line = recent.split(separator: "\n")
      .last(where: { !$0.trimmingCharacters(in: .whitespaces).isEmpty })
      .map(String.init) ?? fallback
    let plain = line.replacingOccurrences(of: "**", with: "")
    return plain.count > 64 ? String(plain.prefix(63)) + "…" : plain
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
struct ArkHistoryFold: Sendable {
  private(set) var events: [ArkHistoryEvent]
  private(set) var turnProjection: ArkChatTurnProjection
  private(set) var turnUsageProjection: ArkChatTurnUsageProjection.Accumulator
  var turnUsageByTurn: [Int: ArkChatTurnUsage] { turnUsageProjection.completed }
  private(set) var messages: ArkMessageProjection
  private(set) var tools: ArkToolProjection
  private(set) var producedFiles: ArkProducedFilesProjection
  private(set) var statuses: ArkChatStatusProjection

  init(events: [ArkHistoryEvent], messages: ArkMessageProjection, tools: ArkToolProjection,
       producedFiles: ArkProducedFilesProjection, statuses: ArkChatStatusProjection,
       turns: ArkChatTurnProjection, usage: ArkChatTurnUsageProjection.Accumulator) {
    self.events = events
    self.messages = messages
    self.tools = tools
    self.producedFiles = producedFiles
    self.statuses = statuses
    turnProjection = turns
    turnUsageProjection = usage
  }

  mutating func installColdSeed(_ seed: ArkHistoryReadingSeed, snapshot: ArkHistoryReadingSnapshot, replayedTurns: Set<Int>) throws {
    tools = seed.tools
    producedFiles = seed.producedFiles
    statuses = seed.statuses
    turnProjection = seed.turns
    let historyRows = snapshot.messages.filter { $0.turn.map { !replayedTurns.contains($0) } ?? true }
    let canonicalIDs = Set(snapshot.records.compactMap(\.canonicalEventSequence))
    try messages.installHistoricalRows(historyRows, canonicalIDs: canonicalIDs)
  }

  init(events source: [ArkHistoryEvent], language: ArkLanguagePreference) {
    var known = Set<Int>()
    let ordered = source
      .filter { known.insert($0.id).inserted }
      .sorted { $0.id < $1.id }
    // Raw retention and semantic state have different lifetimes. A single active
    // answer can span more than the raw ring; fold every verified input before
    // discarding raw events so its text and turn boundaries remain intact.
    events = Array(ordered.suffix(50_000))
    turnProjection = ArkChatTurnProjection(events: ordered)
    turnUsageProjection = ArkChatTurnUsageProjection.Accumulator(events: ordered)
    messages = ArkMessageProjection(events: ordered)
    tools = ArkToolProjection(events: ordered)
    producedFiles = ArkProducedFilesProjection(events: ordered)
    statuses = ArkChatStatusProjection(events: ordered, language: language)
  }

  mutating func appendLive(_ values: [ArkHistoryEvent]) {
    let originalCount = events.count
    for event in values.sorted(by: { $0.id < $1.id }) {
      let through = events.last?.id ?? -1
      guard event.id > through else { continue }
      // A frame beyond a hole stays pending for the existing resync owner. The
      // raw ring's last sequence remains the semantic fold's verified head.
      guard event.id == through + 1 else { break }
      events.append(event)
      turnProjection.append(event)
      turnUsageProjection.append(event)
      tools.append(event)
      producedFiles.append(event)
      statuses.append(event)
    }
    messages.append(contentsOf: Array(events.dropFirst(originalCount)))
    if events.count > 50_000 {
      events.removeFirst(events.count - 50_000)
    }
  }
}

actor ArkHistoryFoldWorker {
  static let shared = ArkHistoryFoldWorker()

  /// Replay forward through a fixed source cut while retaining just one raw
  /// page. A byte-clipped backward response shrinks the proposed forward span;
  /// it never advances over the missing beginning of an active message.
  func recover(client: ArkAPIClient, address: ArkHistoryAddress, cut: ArkHistoryCut,
               checkpoint: ArkHistoryFold?, seed: ArkHistoryReadingSeed?,
               snapshot: ArkHistoryReadingSnapshot?, language: ArkLanguagePreference) async throws -> (fold: ArkHistoryFold, touchedTurns: Set<Int>) {
    guard checkpoint != nil || (seed != nil && snapshot != nil) else {
      throw ArkAPIError(message: "冷历史恢复缺少同源种子", code: "invalid-history-response")
    }
    let activeContexts = seed?.turnContexts.filter { $0.endSequence == nil } ?? []
    let activeRecords = snapshot?.records.filter { $0.state == .active } ?? []
    let activeTurns = Set(activeContexts.map(\.turn) + activeRecords.compactMap(\.turn))
    let coldStart = activeContexts.map { $0.startSequence ?? 0 }.min()
      ?? (activeRecords.isEmpty ? cut.throughSequence + 1 : 0)
    var fold = checkpoint
    var next = checkpoint.map { ($0.events.last?.id ?? -1) + 1 } ?? coldStart
    var span = 2_048
    var touchedTurns = Set<Int>()
    while next <= cut.throughSequence {
      try Task.checkCancellation()
      let end = min(cut.throughSequence, next + span - 1)
      let response = try await address.raw(client: client, cut: cut, before: end + 1, maximum: 2_048)
      guard let first = response.page.events.first?.id else { throw ArkAPIError(message: "固定历史缺少恢复事件", code: "invalid-history-response") }
      if first > next {
        guard span > 1 else { throw ArkAPIError(message: "单条历史事件无法完整读取", code: "invalid-history-response") }
        span = max(1, span / 2)
        continue
      }
      let incoming = response.page.events.filter { $0.id >= next }
      guard incoming.first?.id == next, incoming.last?.id == end else {
        throw ArkAPIError(message: "固定历史恢复范围不连续", code: "invalid-history-response")
      }
      touchedTurns.formUnion(incoming.compactMap { ArkChatTurnUsageProjection.turn(in: $0) })
      if fold == nil { fold = ArkHistoryFold(events: incoming, language: language) }
      else { fold!.appendLive(incoming) }
      guard fold?.events.last?.id == end else { throw ArkAPIError(message: "历史投影未到达已验证水位", code: "invalid-history-response") }
      next = end + 1
      span = min(2_048, span * 2)
    }
    if fold == nil {
      let tail = try await address.raw(client: client, cut: cut, maximum: 1)
      fold = ArkHistoryFold(events: tail.page.events, language: language)
    }
    if checkpoint == nil { try fold!.installColdSeed(seed!, snapshot: snapshot!, replayedTurns: activeTurns) }
    // Prove the source is still the same incarnation after the full replay.
    _ = try await address.raw(client: client, cut: cut, maximum: 1)
    try Task.checkCancellation()
    return (fold!, touchedTurns)
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
  let turnUsageProjection: ArkChatTurnUsageProjection.Accumulator
  let liveHistoryCut: ArkHistoryCut?
  let historicalUsageFacts: [Int: ArkChatTurnUsage]
  let liveHistorySnapshot: ArkHistoryReadingSnapshot?
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
  public private(set) var historyReadingSnapshot: ArkHistoryReadingSnapshot?
  @Published public private(set) var hasNewerHistory = false
  private var historyReader: ArkHistoryReadingWindow?
  private var liveHistoryCut: ArkHistoryCut?
  private var historicalUsageFacts: [Int: ArkChatTurnUsage] = [:]
  private var liveHistorySnapshot: ArkHistoryReadingSnapshot?
  private var liveHistoryRecords: [Int: ArkSemanticHistoryRecord] { liveHistorySnapshot?.recordByMessageID ?? [:] }
  private var liveHistoryRecordsCut: ArkHistoryCut? { liveHistorySnapshot?.cut }
  private var liveHistoryPreviewIDs: Set<Int> {
    guard let snapshot = liveHistorySnapshot else { return [] }
    return snapshot.previewMessageIDs.filter { snapshot.recordByMessageID[$0]?.state != .active }
  }
  public var displayedPreviewMessageIDs: Set<Int> {
    historyReadingSnapshot?.previewMessageIDs ?? liveHistoryPreviewIDs
  }
  private var turnProjection = ArkChatTurnProjection()
  public var turnMetricsByTurn: [Int: ArkChatTurnMetrics] { turnProjection.metricsByTurn }
  public var completedTurnIDs: Set<Int> { Set(turnProjection.completedSequenceByTurn.keys) }
  public var turnTerminalStates: [Int: ArkChatTurnState] { turnProjection.terminalStateByTurn }
  var latestStartedTurn: Int? { turnProjection.latestStartedTurn }
  var latestStartedTurnSequence: Int? { turnProjection.latestStartedSequence }
  private var turnUsageProjection = ArkChatTurnUsageProjection.Accumulator()
  public var turnUsageByTurn: [Int: ArkChatTurnUsage] {
    historicalUsageFacts.merging(turnUsageProjection.completed) { _, live in live }
  }
  /// 轨迹语义记录的模型层缓存：历史更新时 fold 一次，
  /// Tab 切换/视图重建只读缓存，避免每次切换对全量 events 重折。
  @Published public private(set) var trajectoryRecords: [ArkTrajectorySemanticRecord] = []
  /// 当前已安装轨迹记录所属的会话与阅读截点。同一上下文的重算保留现有行，
  /// 只有上下文变化时才清空——否则切换会话会把 A 的账本当 B 显示。
  private var trajectoryContext: ArkTrajectoryContext?
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
      composerErrorMessage = nil
      resetTrajectoryProjectionState(for: ArkTrajectoryContext(sessionID: selectedSessionID, cut: nil))
      persistComposerDraft(for: oldValue)
      switchComposerAttachments(from: oldValue, to: selectedSessionID)
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
  /// One automatic model fallback per user send when the routed model cannot take images.
  private var imageModelFallbackInFlight = false
  @Published public private(set) var navigationErrorMessage: String?
  @Published public private(set) var settingsErrorMessage: String?
  @Published public private(set) var composerErrorMessage: String?
  @Published public private(set) var knowledgeErrorMessage: String?
  @Published public private(set) var eventConnectionStates: [ArkEventChannel: ArkEventConnectionState] = [
    .mux: .connecting,
    .host: .connecting,
  ]
  @Published public private(set) var eventConnectionErrors: [ArkEventChannel: String] = [:]
  @Published public private(set) var isReconnectingEvents = false
  public var primaryEventConnectionState: ArkEventConnectionState {
    ArkConnectionHealth.primary(eventConnectionStates)
  }
  private var eventReconnectTask: Task<Void, Never>?

  /// Reconnect the real downlinks. Only their subsequent baseline can mark them healthy.
  public func reconnectEventsNow() {
    guard eventLifecycle == .running, !isReconnectingEvents else { return }
    isReconnectingEvents = true
    for channel in ArkEventChannel.allCases { setEventConnectionState(channel, state: .connecting) }
    eventReconnectTask = Task { [weak self, eventPump] in
      let restarted = await eventPump.reconnect()
      guard let self else { return }
      isReconnectingEvents = false
      eventReconnectTask = nil
      guard eventLifecycle == .running, !Task.isCancelled else { return }
      if !restarted {
        for channel in ArkEventChannel.allCases {
          markEventChannelDegraded(channel, message: ArkL10n.text(.connectionRecoveryFailed, languagePreference))
        }
      }
    }
  }


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
  /// Applied-sequence anchor per Session, see `ArkSessionEventCursor`. Only this anchor may be
  /// handed to a history read as `expectedThrough`: it is the one value the stream keeps true.
  private var appliedThroughBySessionID: [String: Int] = [:]
  /// Sequence the stream proved exists but the local tail cannot reach yet. A heal pages from the
  /// anchor up to this target, so a hole is bridged instead of truncated away.
  private var resyncTargetBySessionID: [String: Int] = [:]
  private var eventResyncTask: Task<Void, Never>?
  private var eventResyncAttempt = 0
  private var livePublishTask: Task<Void, Never>?
  private var historyProjectionGeneration: UInt64 = 0
  private var historyFoldOwner: ArkHistoryFoldOwner?
  private var historyRefreshOwner: ArkHistoryFoldOwner?
  private var historyFoldInFlight: Bool { historyFoldOwner != nil }
  private var modelMetadataHydrationSessionID: String?
  private var conversationSurfaceSnapshots: [String: ArkConversationSurfaceSnapshot] = [:]
  private var conversationSurfaceSnapshotOrder: [String] = []
  private var navigationRefreshTask: Task<Void, Never>?
  private var sessionSearchTask: Task<Void, Never>?
  private var sessionSearchGeneration: UInt64 = 0
  private var composerDraftDocument = ArkComposerDraftDocument()
  // Only inactive, nonempty attachment drafts live here; the selected draft uses
  // the existing published arrays. Image bytes never enter UserDefaults.
  private var composerAttachmentsBySession: [String: (images: [ArkPromptImage], documents: [ArkPendingDocument])] = [:]
  private var composerSubmittedDocuments: [ArkPendingDocument] = []
  struct ComposerOperationOwner {
    let key: String
    let token: UUID
  }
  private var composerOperations: [String: (token: UUID, count: Int)] = [:]
  private var composerDocumentCleanup: [String: ArkPendingDocument] = [:]
  private var composerDocumentCleanupTask: Task<Void, Never>?
  private var sessionCreationNavigationID: UUID?
  var sessionCreationInFlight: Bool { sessionCreationNavigationID != nil }
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
    eventReconnectTask?.cancel()
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
    (historyReadingSnapshot?.toolActivities ?? toolActivities).first { $0.id == selectedToolActivityID }
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

  private var statusRelocalizationTask: Task<Void, Never>?

  /// Keep the current rows until complete evidence can replace localized copy.
  /// The source read is sparse; it never replays assistant token history.
  private func relocalizeStatusRows() {
    statusRelocalizationTask?.cancel()
    guard let sessionID = selectedSessionID else { return }
    let language = languagePreference
    let generation = historyProjectionGeneration
    statusRelocalizationTask = Task { [weak self] in
      guard let self else { return }
      do {
        if let reader = historyReader {
          let wasReading = historyReadingSnapshot != nil
          let reading = try await reader.relocalize(to: language)
          guard selectedSessionID == sessionID, languagePreference == language,
                historyProjectionGeneration == generation, !Task.isCancelled else { return }
          if wasReading, historyReader === reader, let reading { installReadingSnapshot(reading) }
        }
        let address = try await historyAddress(for: sessionID)
        while !Task.isCancelled {
          guard let checkpointCut = liveHistoryCut else { return }
          let through = events.last?.id ?? -1
          let page = try await address.page(client: client, maximum: 1)
          guard let id = page.dependencyRecords[.status],
                case .dependency(let bundle) = try await address.content(client: client, cut: page.cut, recordID: id)
          else { throw ArkAPIError(message: "状态本地化响应无效", code: "invalid-history-response") }
          let worker = Task.detached(priority: .userInitiated) {
            try ArkHistoryStatusRelocalization.projection(bundle: bundle, through: through, language: language)
          }
          let localized = try await withTaskCancellationHandler { try await worker.value } onCancel: { worker.cancel() }
          try await address.validateCheckpoint(client: client, cut: checkpointCut)
          try Task.checkCancellation()
          guard selectedSessionID == sessionID, languagePreference == language,
                historyProjectionGeneration == generation else { return }
          do {
            let next = try ArkHistoryStatusRelocalization.catchingUp(localized, from: through, publishedEvents: events)
            let transient = chatStatuses.filter { $0.id.hasPrefix("host-agent-error-") || $0.id.hasPrefix("stream-error-") }
            let rows = (next.statuses + transient).sorted { $0.sequence == $1.sequence ? $0.id < $1.id : $0.sequence < $1.sequence }
            statusProjection = next
            if chatStatuses != rows { chatStatuses = rows; chatPresentationDidChange.send() }
            return
          } catch let error as ArkAPIError where error.code == "history-localization-gap" {
            // A burst evicted the catch-up prefix. Capture a fresh boundary;
            // the existing status checkpoint stays installed until proof succeeds.
            continue
          }
        }
      } catch {
        guard selectedSessionID == sessionID, languagePreference == language,
              historyProjectionGeneration == generation, !isTaskCancellation(error) else { return }
        composerErrorMessage = error.localizedDescription
        if (error as? ArkAPIError)?.code == "history-stale-source" { scheduleEventResync(sessionID: sessionID) }
      }
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
    // Opt-in real-usage stall recorder (default off; see ArkMainThreadStallMonitor). The context
    // provider is only called when a stall is actually recorded.
    ArkMainThreadStallMonitor.shared.contextProvider = { [weak self] in
      guard let self else { return "model released" }
      let running = self.sessions.first { $0.id == self.selectedSessionID }?.running == true
      return "session=\(self.selectedSessionID ?? "-") running=\(running)"
        + " messages=\(self.messages.count) tools=\(self.toolActivities.count)"
    }
    ArkMainThreadStallMonitor.shared.startIfEnabled()
    eventTask = Task { [weak self, eventPump] in
      guard !Task.isCancelled else { return }
      await eventPump.start()
      guard !Task.isCancelled else { return }
      // One MainActor turn per delta means one full SwiftUI view-graph
      // transaction per delta. Apply a whole burst per turn instead: order is
      // preserved, no latency is added for slow producers, and a fast stream
      // collapses into a single update.
      while !Task.isCancelled {
        let batch = await eventPump.nextEvents()
        if batch.isEmpty { break }
        guard let self else { break }
        for frame in batch { self.consume(frame) }
        // A hot stream delivers bursts faster than one view-graph transaction
        // can finish. Yielding briefly lets the next bursts coalesce into a
        // single update; a lone interactive frame (approval, question) is far
        // below the threshold and keeps its immediate delivery.
        if batch.count >= 8 { try? await Task.sleep(for: .milliseconds(180)) }
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
        resetHistoryReading()
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
    eventReconnectTask?.cancel()
    statusRelocalizationTask?.cancel()
    historyReader?.cancel()
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
    resetHistoryReading()
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
    // Frames are only applied while a session is displayed, so its anchor is already stale the
    // moment it is switched back to. Drop it: the read below reconciles against the Host's live
    // head, and judging continuity against the old value invented a hole on every switch.
    appliedThroughBySessionID.removeValue(forKey: sessionID)
    resyncTargetBySessionID.removeValue(forKey: sessionID)
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
    modelCatalog = nil
    modelLabel = "未配置模型"
    turnUsageProjection = ArkChatTurnUsageProjection.Accumulator()
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
      turnUsageProjection: turnUsageProjection,
      liveHistoryCut: liveHistoryCut,
      historicalUsageFacts: historicalUsageFacts,
      liveHistorySnapshot: liveHistorySnapshot,
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
    turnUsageProjection = snapshot.turnUsageProjection
    liveHistoryCut = snapshot.liveHistoryCut
    historicalUsageFacts = snapshot.historicalUsageFacts
    liveHistorySnapshot = snapshot.liveHistorySnapshot
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
    clearConversationSurface()
    let abandonedDocuments = pendingDocuments
    selectedWorkspaceID = nil
    selectedTab = .chat
    composerDraftDocument.clear()
    installComposerDraft(composerDraftDocument)
    persistComposerDraft(for: nil)
    pendingImages = []
    pendingDocuments = []
    removeUnreferencedComposerDocuments(abandonedDocuments)
    draftModelSelection = nil
    draftPermissionPreset = nil
    requestComposerFocus(caret: 0)
  }

  private func clearConversationSurface() {
    cacheCurrentConversationSurface()
    composerErrorMessage = nil
    selectedSessionID = nil
    resetHistoryReading()
    events = []
    turnProjection = ArkChatTurnProjection()
    turnUsageProjection = ArkChatTurnUsageProjection.Accumulator()
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
    createNavigableSession(in: selectedWorkspaceID, agentPreset: "cordis", creator: true)
  }

  public func createSession(in workspaceID: String?) {
    createNavigableSession(in: workspaceID, agentPreset: nextAgentPresetID, creator: false)
  }

  private func createNavigableSession(in workspaceID: String?, agentPreset: String?, creator: Bool) {
    // Every explicit click owns a fresh creation ID; only that latest click may navigate.
    let requestID = UUID()
    sessionCreationNavigationID = requestID
    let sourceSessionID = selectedSessionID
    let sourceTab = selectedTab
    let sourceNavigationGeneration = historyProjectionGeneration
    Task {
      defer {
        if sessionCreationNavigationID == requestID { sessionCreationNavigationID = nil }
      }
      let navigationIsCurrent = {
        self.sessionCreationNavigationID == requestID && self.selectedSessionID == sourceSessionID
          && self.selectedTab == sourceTab && self.historyProjectionGeneration == sourceNavigationGeneration
      }
      do {
        let id = try await client.createSession(workspaceID: workspaceID, agentPreset: agentPreset,
          sessionID: requestID.uuidString.lowercased())
        await refreshNavigation(refreshWiki: false)
        guard navigationIsCurrent() else { return }
        selectSession(id)
        if creator { agentPresetError = nil }
      } catch {
        guard navigationIsCurrent() else { return }
        if creator { agentPresetError = error.localizedDescription }
        else { navigationErrorMessage = error.localizedDescription }
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
          resetHistoryReading()
          events = []
          turnProjection = ArkChatTurnProjection()
          turnUsageProjection = ArkChatTurnUsageProjection.Accumulator()
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
          resetHistoryReading()
          events = []
          turnProjection = ArkChatTurnProjection()
          turnUsageProjection = ArkChatTurnUsageProjection.Accumulator()
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
    let cut = sessionID == selectedSessionID ? historyReadingSnapshot?.cut : nil
    Task {
      do {
        let address = try await historyAddress(for: sessionID)
        var parent: String?, mode: String?
        if case .child(let parentID, _, let childMode) = address { parent = parentID; mode = childMode }
        let childID = try await client.forkSession(sessionID: sessionID, atSequence: atSequence,
          sourceRevision: cut?.sourceRevision, expectedParentSessionID: parent, expectedSubagentMode: mode)
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
    guard message.role == .assistant, let turn = message.turn, !displayedPreviewMessageIDs.contains(message.id) else { return nil }
    if let snapshot = historyReadingSnapshot {
      guard snapshot.forkableMessageIDs.contains(message.id) else { return nil }
      return snapshot.recordByMessageID[message.id]?.completedTurnEndSequence
    }
    guard !messages.contains(where: {
      $0.role == .assistant && $0.turn == turn && $0.id > message.id
    }) else { return nil }
    return turnProjection.completedSequenceByTurn[turn]
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
        let registration = try await client.createWorkspace(path: path)
        let workspace = registration.workspace
        do {
          try await registerKnowledgeProject(
            name: workspace.title,
            path: workspace.path
          )
        } catch {
          if registration.created {
            _ = try? await client.deleteWorkspace(workspaceID: workspace.id)
          }
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
  /// current turn. Mutations stay serialized in queue order; continuable
  /// subagent queues take the same treatment as ordinary sessions.
  public func steerAllQueuedPrompts() {
    guard let sessionID = selectedSessionID,
          selectedSession?.running == true
    else { return }
    let queued = queuedPrompts.filter { $0.placement == .queued }
    guard !queued.isEmpty else { return }
    let itemIDs = Set(queued.map(\.id))
    guard queueMutationIDs.isDisjoint(with: itemIDs) else { return }
    queueMutationIDs.formUnion(itemIDs)
    Task {
      defer { queueMutationIDs.subtract(itemIDs) }
      var skipped = 0
      do {
        for item in queued {
          do {
            try await interactions.updateQueue(
              sessionID: sessionID,
              itemID: item.id,
              mutation: .steer
            )
          } catch let error as ArkAPIError where error.code == "steer-unavailable" {
            // That entry already left the steerable window (it is being sent); the queue row shows
            // it. Failing the whole gesture over one entry was the wrong signal.
            skipped += 1
          }
        }
        composerErrorMessage = skipped == 0
          ? nil
          : "已跳过 \(skipped) 条正在发送的队列消息"
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
    _ = composerDraftDocument.ensureSubmissionID()
    persistComposerDraft(for: selectedSessionID)
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
    let sourceWorkspaceID = selectedWorkspaceID
    let sourceNavigationGeneration = historyProjectionGeneration
    let sourceAgentPresetID = nextAgentPresetID
    let pendingModel = draftModelSelection
    let pendingPermission = draftPermissionPreset
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
    composerSubmittedDocuments = documents
    let submissionOwner = beginComposerOperation(for: sourceSessionID ?? capturedDocument.submissionID)
    Task {
      var targetSessionID = sourceSessionID
      var mayReleaseDocuments = !sourceIsSubagent
      defer {
        composerSubmittedDocuments = []
        composerSubmissionInFlight = false
        finishComposerOperation(submissionOwner)
        removeUnreferencedComposerDocuments(documents)
      }
      do {
        await composerDocumentCleanupTask?.value
        guard composerOperationIsCurrent(submissionOwner) else { return }
        let promptText = try await documentStore.contextualizedPrompt(
          baseText: text,
          documents: documents
        )
        guard composerOperationIsCurrent(submissionOwner) else { return }
        let sessionID: String
        if let sourceSessionID { sessionID = sourceSessionID }
        else {
          sessionID = try await client.createSession(
            workspaceID: sourceWorkspaceID,
            agentPreset: sourceAgentPresetID,
            sessionID: capturedDocument.submissionID
          )
          targetSessionID = sessionID
          guard composerOperationIsCurrent(submissionOwner) else { return }
          await refreshNavigation(refreshWiki: false)
          if composerOperationIsCurrent(submissionOwner), selectedSessionID == sourceSessionID,
             historyProjectionGeneration == sourceNavigationGeneration {
            selectSession(sessionID)
          }
          if let pendingModel {
            _ = try await client.selectModel(sessionID: sessionID, selection: pendingModel)
          }
          if let pendingPermission {
            _ = try await client.setPermissionPreset(sessionID: sessionID, preset: pendingPermission)
          }
          if selectedSessionID == sessionID {
            draftModelSelection = nil
            draftPermissionPreset = nil
          }
        }
        guard composerOperationIsCurrent(submissionOwner) else { return }
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
          guard composerOperationIsCurrent(submissionOwner) else { return }
          _ = try await client.promptSubagent(
            parentSessionID: address.parentID,
            childSessionID: sessionID,
            text: promptText,
            invocationID: invocationID
          )
          guard composerOperationIsCurrent(submissionOwner) else { return }
          mayReleaseDocuments = commitSubagentComposerSubmission(
            capturedDocument,
            sourceSessionID: sourceSessionID,
            documents: documents
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
          guard composerOperationIsCurrent(submissionOwner) else { return }
          switch route {
          case .prompt:
            try await interactions.sendPrompt(
              sessionID: sessionID,
              text: promptText,
              images: images,
              mode: deliveryMode,
              submissionID: capturedDocument.submissionID
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
        guard composerOperationIsCurrent(submissionOwner) else { return }
        if selectedSessionID == sessionID { await refreshHistory() }
        await refreshNavigation(refreshWiki: false)
        composerSubmittedDocuments = []
        if mayReleaseDocuments { removeUnreferencedComposerDocuments(documents) }
      } catch {
        guard composerOperationIsCurrent(submissionOwner) else {
          removeUnreferencedComposerDocuments(documents)
          return
        }
        if !sourceIsSubagent {
          restoreComposerSubmission(
            capturedDocument,
            sourceSessionID: sourceSessionID,
            targetSessionID: targetSessionID,
            images: images,
            documents: documents
          )
        }
        guard selectedSessionID == targetSessionID else { return }
        composerErrorMessage = error.localizedDescription
        if !sourceIsSubagent,
           composerDraftDocument == capturedDocument,
           pendingImages == images, pendingDocuments == documents,
           !imageModelFallbackInFlight,
           Self.isImageCapabilityRejection(error),
           let fallback = defaultModelSelection,
           fallback.provider != draftModelSelection?.provider
             || fallback.model != draftModelSelection?.model {
          // A text-only model must not dead-end an image send. The draft and attachments are back
          // in the composer, so switch to the configured default model once and resend the same
          // content instead of leaving the user with a red banner and nothing to do.
          imageModelFallbackInFlight = true
          let fallbackSessionID = targetSessionID
          let fallbackOwner = beginComposerOperation(for: fallbackSessionID)
          Task { [weak self] in
            guard let self else { return }
            defer {
              self.imageModelFallbackInFlight = false
              self.finishComposerOperation(fallbackOwner)
            }
            guard let fallbackSessionID,
                  self.composerOperationIsCurrent(fallbackOwner),
                  self.selectedSessionID == fallbackSessionID,
                  self.composerDraftDocument == capturedDocument,
                  self.pendingImages == images, self.pendingDocuments == documents else { return }
            do {
              let selected = try await self.client.selectModel(
                sessionID: fallbackSessionID,
                selection: fallback
              )
              guard self.composerOperationIsCurrent(fallbackOwner),
                    self.selectedSessionID == fallbackSessionID,
                    self.composerDraftDocument == capturedDocument,
                    self.pendingImages == images, self.pendingDocuments == documents else { return }
              self.modelLabel = Self.modelDisplayLabel(
                provider: selected.provider,
                model: selected.model,
                reasoningEffort: selected.reasoningEffort
              )
              self.draftModelSelection = fallback
              await self.refreshModelCatalog(for: fallbackSessionID)
              guard self.composerOperationIsCurrent(fallbackOwner),
                    self.selectedSessionID == fallbackSessionID,
                    self.composerDraftDocument == capturedDocument,
                    self.pendingImages == images, self.pendingDocuments == documents else { return }
              self.composerErrorMessage = "当前模型不支持图片，已改用 \(fallback.model) 重新发送"
              self.sendComposer(modeOverride: nil)
            } catch {
              if self.composerOperationIsCurrent(fallbackOwner),
                 self.selectedSessionID == fallbackSessionID,
                 self.composerDraftDocument == capturedDocument {
                self.composerErrorMessage = error.localizedDescription
              }
            }
          }
          return
        }
        imageModelFallbackInFlight = false
      }
    }
  }

  /// Whether one prompt rejection is the model's missing image capability.
  nonisolated static func isImageCapabilityRejection(_ error: Error) -> Bool {
    guard let api = error as? ArkAPIError else { return false }
    if api.details?["reason"]?.stringValue == "MODEL_DOES_NOT_SUPPORT_IMAGES" { return true }
    return api.message.contains("does not support image input")
  }

  /// Clear exactly the draft whose subagent invocation just received a durable
  /// receipt. A user edit or session switch that wrote a different document is
  /// never overwritten by the late acknowledgement.
  private func commitSubagentComposerSubmission(
    _ captured: ArkComposerDraftDocument,
    sourceSessionID: String?,
    documents: [ArkPendingDocument]
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
    let submittedIDs = Set(documents.map(\.id))
    if selectedSessionID == sourceSessionID {
      pendingDocuments.removeAll { submittedIDs.contains($0.id) }
    } else {
      let key = Keys.draft(sourceSessionID)
      if var attachments = composerAttachmentsBySession[key] {
        attachments.documents.removeAll { submittedIDs.contains($0.id) }
        storeComposerAttachments(attachments.images, documents: attachments.documents, for: sourceSessionID)
      }
    }
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
    targetSessionID: String?,
    images: [ArkPromptImage],
    documents: [ArkPendingDocument]
  ) {
    let destination = targetSessionID ?? sourceSessionID
    if selectedSessionID == destination {
      let restored = composerDraftDocument.prepending(captured)
      installComposerDraft(restored)
      persistComposerDraft(for: destination)
      pendingImages.insert(contentsOf: images, at: 0)
      let retainedIDs = Set(pendingDocuments.map(\.id))
      pendingDocuments.insert(contentsOf: documents.filter { !retainedIDs.contains($0.id) }, at: 0)
      return
    }
    let latest = Self.loadComposerDraft(defaults: defaults, sessionID: destination)
    persistComposerDraft(latest.prepending(captured), for: destination)
    let attachments = composerAttachmentsBySession[Keys.draft(destination)]
    let retainedDocuments = attachments?.documents ?? []
    let retainedIDs = Set(retainedDocuments.map(\.id))
    storeComposerAttachments(images + (attachments?.images ?? []),
      documents: documents.filter { !retainedIDs.contains($0.id) } + retainedDocuments, for: destination)
  }

  private func storeComposerAttachments(_ images: [ArkPromptImage], documents: [ArkPendingDocument], for sessionID: String?) {
    let key = Keys.draft(sessionID)
    if images.isEmpty && documents.isEmpty { composerAttachmentsBySession.removeValue(forKey: key) }
    else { composerAttachmentsBySession[key] = (images, documents) }
  }

  private func switchComposerAttachments(from oldSessionID: String?, to sessionID: String?) {
    storeComposerAttachments(pendingImages, documents: pendingDocuments, for: oldSessionID)
    let restored = composerAttachmentsBySession.removeValue(forKey: Keys.draft(sessionID))
    pendingImages = restored?.images ?? []
    pendingDocuments = restored?.documents ?? []
  }

  private func beginComposerOperation(for sessionID: String?) -> ComposerOperationOwner {
    let key = Keys.draft(sessionID)
    var value = composerOperations[key] ?? (token: UUID(), count: 0)
    value.count += 1
    composerOperations[key] = value
    return ComposerOperationOwner(key: key, token: value.token)
  }

  private func composerOperationIsCurrent(_ owner: ComposerOperationOwner) -> Bool {
    composerOperations[owner.key]?.token == owner.token
  }

  private func finishComposerOperation(_ owner: ComposerOperationOwner) {
    if var value = composerOperations[owner.key], value.token == owner.token {
      value.count -= 1
      if value.count == 0 { composerOperations.removeValue(forKey: owner.key) }
      else { composerOperations[owner.key] = value }
    }
    flushComposerDocumentCleanup()
  }

  private func removeUnreferencedComposerDocuments(_ documents: [ArkPendingDocument]) {
    for document in documents { composerDocumentCleanup[document.id] = document }
    flushComposerDocumentCleanup()
  }

  private func flushComposerDocumentCleanup() {
    guard composerOperations.isEmpty, composerDocumentCleanupTask == nil,
          !composerDocumentCleanup.isEmpty else { return }
    composerDocumentCleanupTask = Task { [weak self] in
      guard let self else { return }
      defer {
        self.composerDocumentCleanupTask = nil
        self.flushComposerDocumentCleanup()
      }
      guard self.composerOperations.isEmpty else { return }
      let candidates = Array(self.composerDocumentCleanup.values)
      self.composerDocumentCleanup.removeAll()
      let retained = Set((self.pendingDocuments + self.composerSubmittedDocuments
        + self.composerAttachmentsBySession.values.flatMap(\.documents)).map(\.id))
      let unused = candidates.filter { !retained.contains($0.id) }
      if !unused.isEmpty { await self.documentStore.remove(unused) }
    }
  }

  /// Called by the authoritative host/session-deleted event; no permanent tombstones.
  func discardComposerAttachments(for sessionID: String) {
    composerOperations.removeValue(forKey: Keys.draft(sessionID))
    var discarded = composerAttachmentsBySession.removeValue(forKey: Keys.draft(sessionID))?.documents ?? []
    if selectedSessionID == sessionID {
      discarded += pendingDocuments
      pendingImages = []
      pendingDocuments = []
    }
    removeUnreferencedComposerDocuments(discarded)
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
    let sourceSessionID = selectedSessionID
    let owner = beginComposerOperation(for: sourceSessionID)
    Task {
      defer { finishComposerOperation(owner) }
      _ = await importComposerAttachments(for: sourceSessionID, owner: owner,
        imageLimits: (maxCount, maxEach, maxTotal)) {
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
            return ArkPromptImage(mediaType: mediaType,
              data: try Data(contentsOf: url, options: [.mappedIfSafe]), name: url.lastPathComponent)
          }
        }.value
        return (images, [])
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
    let sourceSessionID = selectedSessionID
    let store = documentStore
    let owner = beginComposerOperation(for: sourceSessionID)
    Task {
      defer { finishComposerOperation(owner) }
      _ = await importComposerAttachments(for: sourceSessionID, owner: owner) {
        let document = try await store.importPastedText(text, name: name)
        return ([], [document])
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
    let sourceSessionID = selectedSessionID
    let store = documentStore
    let owner = beginComposerOperation(for: sourceSessionID)
    Task {
      defer { finishComposerOperation(owner) }
      // Keep file selection order and already imported files on partial failure.
      for url in urls {
        let imported = await importComposerAttachments(for: sourceSessionID, owner: owner) {
          let document = try await store.importFile(url)
          return ([], [document])
        }
        if !imported { return }
      }
    }
  }

  /// One asynchronous completion boundary for local attachment imports. The
  /// captured session owns both the data and any visible completion message.
  func importComposerAttachments(
    for sessionID: String?,
    owner suppliedOwner: ComposerOperationOwner? = nil,
    imageLimits: (count: Int, each: Int, total: Int)? = nil,
    load: @Sendable () async throws -> (images: [ArkPromptImage], documents: [ArkPendingDocument])
  ) async -> Bool {
    let owner = suppliedOwner ?? beginComposerOperation(for: sessionID)
    defer { if suppliedOwner == nil { finishComposerOperation(owner) } }
    var importedDocuments: [ArkPendingDocument] = []
    do {
      await composerDocumentCleanupTask?.value
      guard composerOperationIsCurrent(owner) else { return false }
      let loaded = try await load()
      importedDocuments = loaded.documents
      guard composerOperationIsCurrent(owner) else {
        removeUnreferencedComposerDocuments(importedDocuments)
        return false
      }
      let retained = selectedSessionID == sessionID
        ? (images: pendingImages, documents: pendingDocuments)
        : (composerAttachmentsBySession[Keys.draft(sessionID)] ?? (images: [], documents: []))
      if !loaded.images.isEmpty {
        guard let limits = imageLimits else { throw ArkAPIError(message: "图片导入缺少会话大小限制") }
        guard retained.images.count + loaded.images.count <= limits.count else {
          throw ArkAPIError(message: "每条消息最多可添加 \(limits.count) 张图片")
        }
        guard loaded.images.allSatisfy({ !$0.data.isEmpty && $0.data.count <= limits.each }),
          (retained.images + loaded.images).reduce(0, { $0 + $1.data.count }) <= limits.total else {
          throw ArkAPIError(message: "图片大小超过当前限制")
        }
      }
      var documentIDs = Set(retained.documents.map(\.id))
      let addedDocuments = loaded.documents.filter { documentIDs.insert($0.id).inserted }
      guard retained.documents.count + addedDocuments.count <= 8 else {
        throw ArkAPIError(message: "每条消息最多可引用 8 份文档")
      }
      if selectedSessionID == sessionID {
        pendingImages = retained.images + loaded.images
        pendingDocuments = retained.documents + addedDocuments
        composerErrorMessage = nil
      } else {
        storeComposerAttachments(retained.images + loaded.images,
          documents: retained.documents + addedDocuments, for: sessionID)
      }
      return true
    } catch {
      removeUnreferencedComposerDocuments(importedDocuments)
      if composerOperationIsCurrent(owner), selectedSessionID == sessionID {
        composerErrorMessage = error.localizedDescription
      }
      return false
    }
  }

  public func removePendingDocument(at index: Int) {
    guard pendingDocuments.indices.contains(index) else { return }
    let document = pendingDocuments.remove(at: index)
    removeUnreferencedComposerDocuments([document])
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
  public func refreshHistory(resetPaging: Bool = false) async {
    guard let sessionID = selectedSessionID else { return }
    historyProjectionGeneration &+= 1
    let owner = ArkHistoryFoldOwner(sessionID: sessionID, generation: historyProjectionGeneration)
    historyRefreshOwner = owner
    historyFoldOwner = owner
    livePublishTask?.cancel()
    livePublishTask = nil
    historyLoadState = .loading
    var recoveryReader: ArkHistoryReadingWindow?
    defer {
      recoveryReader?.cancel()
      if historyRefreshOwner == owner { historyRefreshOwner = nil }
      if historyFoldOwner == owner {
        historyFoldOwner = nil
        if !pendingLiveEvents.isEmpty { scheduleLivePublish() }
      }
      if selectedSessionID == sessionID, historyProjectionGeneration == owner.generation, historyLoadState == .loading {
        historyLoadState = .afterCancellation(hasHistory: !events.isEmpty)
      }
    }
    do {
      let address = try await historyAddress(for: sessionID)
      var checkpoint: ArkHistoryFold?
      var checkpointCut: ArkHistoryCut?
      var sourceChanged = false
      if !resetPaging, let oldCut = liveHistoryCut {
        do {
          _ = try await address.raw(client: client, cut: oldCut, maximum: 1)
          checkpointCut = oldCut
          checkpoint = ArkHistoryFold(events: events, messages: messageProjection, tools: toolProjection,
            producedFiles: producedFilesProjection, statuses: statusProjection, turns: turnProjection, usage: turnUsageProjection)
        } catch let error as ArkAPIError where error.code == "history-stale-source" {
          sourceChanged = true
        }
      }
      let head = try await address.raw(client: client, maximum: 1)
      if let checkpointHead = checkpoint?.events.last?.id, checkpointHead > head.cut.throughSequence {
        checkpoint = nil
        sourceChanged = true
      }
      try Task.checkCancellation()
      guard selectedSessionID == sessionID, historyProjectionGeneration == owner.generation else { return }
      var seed: ArkHistoryReadingSeed?
      var reading: ArkHistoryReadingSnapshot?
      if checkpoint == nil {
        historyReader?.cancel()
        historyReader = nil
        let reader = ArkHistoryReadingWindow(client: client, address: address, language: languagePreference)
        recoveryReader = reader
        let page = try await address.page(client: client, cut: head.cut)
        reading = try await reader.open(firstPage: page, hydrateActive: false)
        seed = reader.seed
      }
      let recovered = try await ArkHistoryFoldWorker.shared.recover(
        client: client, address: address, cut: head.cut, checkpoint: checkpoint,
        seed: seed, snapshot: reading, language: languagePreference
      )
      // Composer projections are explicitly current, independent of the fixed
      // history cut. Do not feed this legacy one-event response into any fold.
      let projectionBaseline = try await historyPage(sessionID: sessionID, maxMessages: 1)
      // A replacement between the old-cut admission and the fresh head read
      // must not combine the former checkpoint with the latter incarnation.
      if checkpoint != nil, let checkpointCut {
        try await address.validateCheckpoint(client: client, cut: checkpointCut)
      }
      try Task.checkCancellation()
      guard selectedSessionID == sessionID, historyProjectionGeneration == owner.generation,
            historyRefreshOwner == owner, historyFoldOwner == owner else { return }
      let fold = recovered.fold
      guard (fold.events.last?.id ?? -1) == head.cut.throughSequence else {
        throw ArkAPIError(message: "恢复后的实时水位与固定来源不一致", code: "invalid-history-response")
      }
      if sourceChanged {
        // Buffered frames from a replaced incarnation cannot be admitted by
        // coincident sequence numbers. The next bound refresh observes its new tail.
        pendingLiveEvents = []
        appliedThroughBySessionID.removeValue(forKey: sessionID)
        resyncTargetBySessionID.removeValue(forKey: sessionID)
      } else {
        pendingLiveEvents.removeAll { $0.id <= head.cut.throughSequence }
      }
      let previousMessages = messages
      let previousTools = toolActivities
      let previousFiles = producedFiles
      let previousStatuses = chatStatuses
      let previousMetrics = turnMetricsByTurn
      let previousTerminalStates = turnTerminalStates
      let previousUsage = turnUsageByTurn
      let previousPreviewIDs = displayedPreviewMessageIDs
      let previousReadingCut = historyReadingSnapshot?.cut
      let previousHead = events.last?.id
      events = fold.events
      installReconciledHead(sessionID: sessionID, through: head.cut.throughSequence)
      seenEventIDs = Set(events.map(\.id))
      seenEventIDs.formUnion(pendingLiveEvents.map(\.id))
      messageProjection = fold.messages
      if messages != messageProjection.messages { messages = messageProjection.messages }
      toolProjection = fold.tools
      if toolActivities != toolProjection.activities { toolActivities = toolProjection.activities }
      producedFilesProjection = fold.producedFiles
      if producedFiles != producedFilesProjection.files { producedFiles = producedFilesProjection.files }
      statusProjection = fold.statuses
      if chatStatuses != statusProjection.statuses { chatStatuses = statusProjection.statuses }
      turnProjection = fold.turnProjection
      turnUsageProjection = fold.turnUsageProjection
      liveHistoryCut = head.cut
      if let seed, let reading, let reader = recoveryReader {
        historicalUsageFacts = seed.usage
        liveHistorySnapshot = reading
        historyReader = reader
        recoveryReader = nil
        historyReadingSnapshot = nil
        hasNewerHistory = false
        hasOlderHistory = reading.hasOlderHistory
      } else {
        for turn in recovered.touchedTurns { historicalUsageFacts.removeValue(forKey: turn) }
      }
      historyBeforeSequence = events.first?.id
      sessionProjections = projectionBaseline.projections
      historyLoadState = .loaded
      composerErrorMessage = nil
      if seed != nil || previousHead != events.last?.id || previousReadingCut != historyReadingSnapshot?.cut {
        markTrajectoryProjectionDirty()
      }
      synchronizeModelLabelFromEvents()
      if previousMessages != messages || previousTools != toolActivities || previousFiles != producedFiles
          || previousStatuses != chatStatuses || previousMetrics != turnMetricsByTurn || previousUsage != turnUsageByTurn
          || previousTerminalStates != turnTerminalStates
          || previousPreviewIDs != displayedPreviewMessageIDs || previousReadingCut != historyReadingSnapshot?.cut {
        chatPresentationDidChange.send()
      }
      if statusProjection.language != languagePreference { relocalizeStatusRows() }
      if eventConnectionErrors[.mux]?.hasPrefix("会话") == true { setEventConnectionState(.mux, state: .connected) }
      if sourceChanged {
        // One fresh transaction catches events committed while the replaced
        // source was being recovered, without trusting old pending identities.
        Task { [weak self] in
          guard let self, self.selectedSessionID == sessionID else { return }
          await self.refreshHistory()
        }
      }
    } catch {
      guard selectedSessionID == sessionID, historyProjectionGeneration == owner.generation else { return }
      if isTaskCancellation(error) { return }
      historyLoadState = .failed(error.localizedDescription)
      composerErrorMessage = error.localizedDescription
      if (error as? ArkAPIError)?.code == "history-stale-source" {
        liveHistoryCut = nil
        historyReader?.cancel()
        historyReader = nil
        historyReadingSnapshot = nil
        pendingLiveEvents = []
        appliedThroughBySessionID.removeValue(forKey: sessionID)
        resyncTargetBySessionID.removeValue(forKey: sessionID)
        scheduleEventResync(sessionID: sessionID)
      } else if resyncTargetBySessionID[sessionID] != nil {
        scheduleEventResync(sessionID: sessionID)
      }
    }
  }

  public func loadOlderHistory() async {
    await moveHistoryReading(older: true)
  }

  public func loadNewerHistory() async {
    await moveHistoryReading(older: false)
  }

  private func moveHistoryReading(older: Bool) async {
    guard let sessionID = selectedSessionID, !loadingOlderHistory, !historyFoldInFlight else { return }
    loadingOlderHistory = true
    defer { if selectedSessionID == sessionID { loadingOlderHistory = false } }
    do {
      let reader = try await prepareHistoryReader(sessionID: sessionID)
      let snapshot = try await (older ? reader.older() : reader.newer())
      try Task.checkCancellation()
      guard selectedSessionID == sessionID, historyReader === reader else { return }
      installReadingSnapshot(snapshot)
    } catch {
      guard selectedSessionID == sessionID, !isTaskCancellation(error) else { return }
      composerErrorMessage = error.localizedDescription
    }
  }

  public func returnToLatestHistory() async {
    historyReader?.cancel()
    historyReader = nil
    historyReadingSnapshot = nil
    resetTrajectoryProjectionState(for: ArkTrajectoryContext(sessionID: selectedSessionID, cut: nil))
    markTrajectoryProjectionDirty()
    hasNewerHistory = false
    hasOlderHistory = (liveHistoryRecords.values.map(\.orderSequence).min() ?? events.first?.id ?? 0) > 0
    chatPresentationDidChange.send()
    await refreshHistory()
  }

  public func loadHistoryMessageContent(messageID: Int) async throws -> ArkMessage {
    guard let sessionID = selectedSessionID else { throw CancellationError() }
    let historical = historyReadingSnapshot != nil
    let requestedRecord = historyReadingSnapshot?.recordByMessageID[messageID] ?? liveHistoryRecords[messageID]
    guard let requestedRecord else { throw ArkAPIError(message: "消息没有可用的历史定位", code: "history-stale-record") }
    guard let recordCut = historyReadingSnapshot?.cut ?? liveHistoryRecordsCut else { throw ArkAPIError(message: "消息缺少来源版本", code: "history-stale-record") }
    let reader = try await prepareHistoryReader(sessionID: sessionID, requiredCut: recordCut)
    let message = try await reader.message(record: requestedRecord)
    try Task.checkCancellation()
    guard selectedSessionID == sessionID, historyReader === reader else { throw CancellationError() }
    if historical, let snapshot = reader.snapshot {
      installReadingSnapshot(snapshot)
    } else {
      var rows: [ArkMessage] = []
      for (id, record) in liveHistoryRecords where record.state != .active {
        if let cached = reader.cachedMessage(recordID: record.id) { rows.append(cached) }
        else {
          rows.append(ArkMessage(id: id, role: record.kind == .user ? .user : .assistant,
            text: record.preview, turn: record.turn, step: record.step,
            interrupted: record.state != .complete, time: record.time))
        }
      }
      try messageProjection.installHistoricalRows(rows, canonicalIDs: Set(liveHistoryRecords.values.compactMap(\.canonicalEventSequence)))
      messages = messageProjection.messages
      liveHistorySnapshot = reader.snapshot
      markTrajectoryProjectionDirty()
      chatPresentationDidChange.send()
    }
    return message
  }

  private func installReadingSnapshot(_ snapshot: ArkHistoryReadingSnapshot) {
    historyReadingSnapshot = snapshot
    resetTrajectoryProjectionState(for: ArkTrajectoryContext(sessionID: selectedSessionID, cut: snapshot.cut))
    if selectedTab == .trajectory { scheduleTrajectoryProjectionIfNeeded() }
    hasOlderHistory = snapshot.hasOlderHistory
    hasNewerHistory = snapshot.hasNewerHistory
    historyLoadState = .loaded
    composerErrorMessage = nil
    chatPresentationDidChange.send()
  }

  private func prepareHistoryReader(sessionID: String, requiredCut: ArkHistoryCut? = nil) async throws -> ArkHistoryReadingWindow {
    if let historyReader, requiredCut == nil || historyReader.seed?.cut == requiredCut {
      guard historyReader.snapshot != nil else { throw ArkAPIError(message: "历史正在读取", code: "history-read-busy") }
      return historyReader
    }
    historyReader?.cancel()
    let address = try await historyAddress(for: sessionID)
    let reader = ArkHistoryReadingWindow(client: client, address: address, language: languagePreference)
    historyReader = reader
    do {
      let firstPage = try await address.page(client: client, cut: requiredCut)
      _ = try await reader.open(firstPage: firstPage)
      try Task.checkCancellation()
      guard selectedSessionID == sessionID, historyReader === reader else { throw CancellationError() }
      return reader
    } catch {
      reader.cancel()
      if historyReader === reader { historyReader = nil }
      throw error
    }
  }

  private func resetHistoryReading() {
    statusRelocalizationTask?.cancel()
    statusRelocalizationTask = nil
    historyReader?.cancel()
    historyReader = nil
    historyReadingSnapshot = nil
    hasNewerHistory = false
    liveHistoryCut = nil
    historicalUsageFacts = [:]
    liveHistorySnapshot = nil
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

  private func historyAddress(for sessionID: String) async throws -> ArkHistoryAddress {
    guard let address = try await subagentAddress(for: sessionID) else { return .session(sessionID) }
    guard let mode = address.entry.mode else { throw ArkAPIError(message: "子代理会话缺少传输模式") }
    return .child(parent: address.parentID, session: sessionID, mode: mode)
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

  func consume(_ frame: ArkEventFrame) {
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
        if frame.channel == .mux {
          ArkEventChannelDiagnostics.baseline(generation: generation, phase: "begin", sessionCount: 0)
        }
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
      if frame.channel == .mux {
        ArkEventChannelDiagnostics.baseline(
          generation: generation,
          phase: "complete",
          sessionCount: sessionIDs.count
        )
      }
      eventBaselineGenerationByChannel.removeValue(forKey: frame.channel)
      setEventConnectionState(frame.channel, state: .connected)
      if frame.channel == .mux {
        appliedThroughBySessionID = appliedThroughBySessionID.filter {
          sessionIDs.contains($0.key)
        }
        resyncTargetBySessionID = resyncTargetBySessionID.filter {
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
      // The baseline is the Host's log length: a baseline above the local anchor means the stream
      // moved while this client was not applied, and that range is paged in below rather than
      // skipped. A baseline below it means the log itself shrank, so the anchor reseats.
      var baselineCursor = ArkSessionEventCursor(applied: appliedThroughBySessionID[sessionID] ?? -1)
      if case .hole(let target) = baselineCursor.adoptBaseline(lastSequence) {
        resyncTargetBySessionID[sessionID] = max(resyncTargetBySessionID[sessionID] ?? -1, target)
      }
      appliedThroughBySessionID[sessionID] = baselineCursor.applied
      if sessionID == selectedSessionID {
        ArkEventChannelDiagnostics.subscribed(
          session: sessionID,
          baseline: lastSequence,
          anchor: baselineCursor.applied,
          target: resyncTargetBySessionID[sessionID]
        )
      }
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
        // A resubscribe must not discard frames the new baseline still covers: dropping them is
        // what pinned the local tail below the stream and made every later frame look like a gap.
        // Only frames above the Host's own log length stop existing, and they must leave the dedupe
        // set too — the log re-uses those sequence numbers.
        if lastSequence < (events.last?.id ?? -1) {
          liveHistoryCut = nil
          historyReader?.cancel()
          historyReader = nil
          historyReadingSnapshot = nil
        }
        events.removeAll { $0.id > lastSequence }
        pendingLiveEvents.removeAll { $0.id > lastSequence }
        seenEventIDs = Set(events.map(\.id)).union(pendingLiveEvents.map(\.id))
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
      guard let anchor = appliedThroughBySessionID[sessionID] else {
        // No anchor for this Session (just switched to, or never baselined): buffer the frame and
        // let the history read reconcile. Comparing the stream against a number that was never a
        // cursor is what produced the phantom gap on every session switch.
        if seenEventIDs.insert(event.id).inserted {
          pendingLiveEvents.append(event)
        }
        scheduleLivePublish()
        return
      }
      var cursor = ArkSessionEventCursor(applied: anchor)
      switch cursor.observe(event.id) {
      case .covered:
        // Already inside the applied range: history and the stream both deliver it.
        return
      case .hole(let target):
        // A gap means the local range is short, not that this frame is junk. Keep the anchor where
        // the hole starts and page the missing range in: advancing the anchor would pretend the
        // range arrived, and re-pulling with a reset would throw away the tail the stream already
        // delivered — the loop that made one miss repeat forever.
        if resyncTargetBySessionID[sessionID] != nil {
          // A heal is already armed: this frame is the stream's contiguous tail above the hole.
          // Buffer it instead of rejecting it — the heal installs the missing range first and the
          // publish then appends this tail — and raise the target so one heal covers everything.
          // Reporting per frame is what turned a single hole into a frozen banner wall.
          resyncTargetBySessionID[sessionID] = max(resyncTargetBySessionID[sessionID] ?? -1, target)
          if seenEventIDs.insert(event.id).inserted {
            pendingLiveEvents.append(event)
          }
          // The publish pass refuses to append a discontinuous tail and re-arms the heal in the
          // process, so a heal that failed once cannot leave the transcript frozen forever.
          scheduleLivePublish()
          return
        }
        seenEventIDs.remove(event.id)
        resyncTargetBySessionID[sessionID] = target
        ArkEventChannelDiagnostics.gap(session: sessionID, expected: cursor.next, actual: event.id)
        markEventChannelDegraded(
          .mux,
          message: "会话事件序号不连续（应为 \(cursor.next)，实际为 \(event.id)），正在补齐缺失事件"
        )
        scheduleEventResync(sessionID: sessionID)
        return
      case .accepted:
        break
      }
      // The anchor advances for every frame the stream delivers next, and the dedupe set only
      // guards the append: a frame that a reconcile already staged or installed (so it is still in
      // `seenEventIDs`) must not be dropped before the cursor sees it. Dropping it there left the
      // anchor behind the transcript and turned the *next* frame into a hole that never existed.
      appliedThroughBySessionID[sessionID] = cursor.applied
      if event.type == "turn/start" {
        // A run-error card describes the turn that just ended; the next turn starts clean.
        let prefix = "host-agent-error-"
        if chatStatuses.contains(where: { $0.id.hasPrefix(prefix) }) {
          chatStatuses.removeAll { $0.id.hasPrefix(prefix) }
        }
      }
      guard seenEventIDs.insert(event.id).inserted else { return }
      pendingLiveEvents.append(event)
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
        appliedThroughBySessionID.removeValue(forKey: deletedID)
        resyncTargetBySessionID.removeValue(forKey: deletedID)
        removeConversationSurfaceSnapshot(for: deletedID)
        discardComposerAttachments(for: deletedID)
      }
      if let deletedID = frame.payload["sessionId"]?.stringValue,
         selectedSessionID == deletedID {
        selectedSessionID = nil
        resetHistoryReading()
        events = []
        turnProjection = ArkChatTurnProjection()
        turnUsageProjection = ArkChatTurnUsageProjection.Accumulator()
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
      // One card per channel: a failure storm used to stack a fresh card for every rpcID.
      markEventChannelDegraded(frame.channel, message: message)
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
      // A transient downlink card is named after its channel: once the channel is healthy again it
      // describes a state that no longer exists. Leaving it in the transcript is what made a
      // sub-second self-heal look like a permanent conversation failure.
      let prefix = "stream-error-\(channel.rawValue)"
      let kept = chatStatuses.filter { !$0.id.hasPrefix(prefix) }
      if kept.count != chatStatuses.count {
        chatStatuses = kept
        chatPresentationDidChange.send()
      }
    }
  }

  private func markEventChannelDegraded(
    _ channel: ArkEventChannel,
    message: String,
    rpcID: String? = nil
  ) {
    eventConnectionStates[channel] = .degraded
    eventConnectionErrors[channel] = message
    if channel == .mux { composerErrorMessage = message }
    else { navigationErrorMessage = message }
    if selectedSessionID != nil {
      // One banner per channel and cause: the stream keeps re-reporting the same gap until
      // the resync lands, and a fresh id per frame buried the conversation under duplicates.
      appendTransientChatError(
        id: "stream-error-\(channel.rawValue)-\(rpcID ?? "current")",
        message: message
      )
    }
  }

  private func scheduleEventResync(sessionID: String) {
    guard eventResyncTask == nil else { return }
    // Backed off so a persistent failure retries without becoming a request storm.
    let delayNanoseconds = min(
      UInt64(100_000_000) << UInt64(min(eventResyncAttempt, 5)),
      3_200_000_000
    )
    eventResyncAttempt += 1
    eventResyncTask = Task { [weak self] in
      defer { self?.eventResyncTask = nil }
      try? await Task.sleep(nanoseconds: delayNanoseconds)
      guard let self, !Task.isCancelled, self.selectedSessionID == sessionID else { return }
      // The walk keeps the installed tail as its anchor and stops at the reported target, so the
      // page it pulls is exactly the missing range. Resetting the page would discard the tail and
      // move the head backwards below the stream.
      await self.refreshHistory()
    }
  }

  /// Reconciliation is the only gate that may move the anchor, and it may only move it forward.
  private func installReconciledHead(sessionID: String, through: Int) {
    var cursor = ArkSessionEventCursor(applied: appliedThroughBySessionID[sessionID] ?? -1)
    cursor.adoptReconciledHead(through)
    appliedThroughBySessionID[sessionID] = cursor.applied
    if let target = resyncTargetBySessionID[sessionID], cursor.applied >= target {
      resyncTargetBySessionID.removeValue(forKey: sessionID)
      eventResyncAttempt = 0
      ArkEventChannelDiagnostics.reconciled(session: sessionID, head: cursor.applied, target: target)
    }
  }

  private func appendTransientChatError(id: String, message: String) {
    if let index = chatStatuses.firstIndex(where: { $0.id == id }) {
      // Same card, newest cause: the first report must not keep showing an older state after the
      // client has already moved on to healing it.
      if chatStatuses[index].detail != message {
        let existing = chatStatuses[index]
        chatStatuses[index] = ArkChatStatus(
          id: existing.id,
          sequence: existing.sequence,
          kind: existing.kind,
          phase: existing.phase,
          title: existing.title,
          detail: message
        )
        chatPresentationDidChange.send()
      }
      return
    }
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

  private func scheduleLivePublish(continuation: Bool = false) {
    guard livePublishTask == nil, !historyFoldInFlight,
          let publishingSessionID = selectedSessionID
    else { return }
    let intervalNanoseconds = ArkStreamingPresentationPolicy.intervalNanoseconds(
      eventCount: events.count + pendingLiveEvents.count
    )
    livePublishTask = Task { [weak self] in
      if continuation {
        await Task.yield()
      } else {
        try? await Task.sleep(nanoseconds: intervalNanoseconds)
      }
      guard let self, !Task.isCancelled else { return }
      guard selectedSessionID == publishingSessionID else {
        livePublishTask = nil
        return
      }
      let publishStarted = DispatchTime.now().uptimeNanoseconds
      // Bound events processed synchronously after a large backlog. Continuations
      // yield the main actor between batches rather than sleeping through it.
      let incoming = Array(pendingLiveEvents.prefix(4_096))
      var publishCursor = ArkSessionEventCursor(applied: events.last?.id ?? -1)
      let contiguous = incoming.allSatisfy { event in
        if case .accepted = publishCursor.observe(event.id) { return true }
        return false
      }
      if !contiguous {
        // A later frame can be buffered after an earlier contiguous frame and
        // an intervening hole. Validate the entire batch before any reducer is
        // advanced; the existing resync owner installs the missing range first.
        livePublishTask = nil
        if let sessionID = selectedSessionID {
          let candidate = incoming.last?.id
            ?? appliedThroughBySessionID[sessionID]
            ?? publishCursor.applied
          resyncTargetBySessionID[sessionID] = max(
            resyncTargetBySessionID[sessionID] ?? -1,
            candidate
          )
          scheduleEventResync(sessionID: sessionID)
        }
        return
      }
      pendingLiveEvents.removeFirst(incoming.count)
      events.append(contentsOf: incoming)
      var chatPresentationChanged = false
      // All semantic reducers advance at the same published boundary. Frames
      // buffered during a history fold or a gap must not mutate just some of
      // these owners before their contiguous batch is installed.
      messageProjection.append(contentsOf: incoming)
      for event in incoming {
        toolProjection.append(event)
        producedFilesProjection.append(event)
        statusProjection.append(event)
      }
      let touchedTurns = Set(incoming.compactMap { ArkChatTurnUsageProjection.turn(in: $0) })
      let previousMetrics = turnProjection.metricsByTurn
      let previousCompleted = turnProjection.completedSequenceByTurn
      let previousTerminalStates = turnProjection.terminalStateByTurn
      turnProjection.append(contentsOf: incoming)
      if touchedTurns.contains(where: {
        previousMetrics[$0] != self.turnProjection.metricsByTurn[$0]
          || previousCompleted[$0] != self.turnProjection.completedSequenceByTurn[$0]
          || previousTerminalStates[$0] != self.turnProjection.terminalStateByTurn[$0]
      }) {
        chatPresentationChanged = true
      }
      let previousUsage = turnUsageByTurn
      for turn in touchedTurns { historicalUsageFacts.removeValue(forKey: turn) }
      turnUsageProjection.append(contentsOf: incoming)
      if touchedTurns.contains(where: { previousUsage[$0] != self.turnUsageByTurn[$0] }) {
        chatPresentationChanged = true
      }
      if events.count > ArkStreamingPresentationPolicy.presentedEventLimit {
        let watermark = ArkStreamingPresentationPolicy.presentedEventLimit
          - ArkStreamingPresentationPolicy.presentationTrimBatch
        let removed = Array(events.prefix(events.count - watermark))
        events.removeFirst(events.count - watermark)
        for event in removed { seenEventIDs.remove(event.id) }
        historyBeforeSequence = events.first?.id
        if historyReadingSnapshot == nil { hasOlderHistory = true }
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
      let publishMilliseconds = Int(
        (DispatchTime.now().uptimeNanoseconds &- publishStarted) / 1_000_000
      )
      if incoming.count >= 64 || publishMilliseconds >= 200 {
        ArkEventChannelDiagnostics.publish(
          added: incoming.count,
          backlog: pendingLiveEvents.count,
          milliseconds: publishMilliseconds
        )
      }
      livePublishTask = nil
      if !pendingLiveEvents.isEmpty { scheduleLivePublish(continuation: true) }
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

  /// Reset the trajectory projection for a recompute belonging to `next`.
  ///
  /// Rows are kept when `next` names the same session and reading cut as the rows
  /// already installed: loading a second message body inside one reading window is
  /// a same-context recompute, and clearing first would flash the table through an
  /// empty state it never had. Rows are cleared when the context moved, because a
  /// stale ledger would present one session's records as another's.
  /// @param next - session and reading cut the incoming fold belongs to.
  private func resetTrajectoryProjectionState(for next: ArkTrajectoryContext) {
    trajectoryProjectionGeneration &+= 1
    trajectoryProjectionTask?.cancel()
    trajectoryProjectionTask = nil
    trajectoryProjectionDirty = true
    if arkTrajectoryRecomputeDiscardsRecords(current: trajectoryContext, next: next) {
      trajectoryRecords = []
    }
    trajectoryContext = next
  }

  private func markTrajectoryProjectionDirty() {
    // Live tokens cannot invalidate an immutable historical cut.
    guard historyReadingSnapshot == nil else { return }
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
    let readingSnapshot = historyReadingSnapshot
    let liveSnapshot = liveHistorySnapshot
    trajectoryProjectionTask = Task { [weak self] in
      let records = await Task.detached(priority: .userInitiated) {
        if let readingSnapshot { return ArkTrajectoryProjection.records(from: readingSnapshot) }
        return ArkTrajectoryProjection.records(from: snapshot, history: liveSnapshot)
      }.value
      guard let self,
            !Task.isCancelled,
            trajectoryProjectionGeneration == generation,
            selectedSessionID == sessionID
      else { return }
      trajectoryRecords = records
      trajectoryContext = ArkTrajectoryContext(sessionID: sessionID, cut: readingSnapshot?.cut)
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
    guard historyReadingSnapshot == nil else { return }
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
