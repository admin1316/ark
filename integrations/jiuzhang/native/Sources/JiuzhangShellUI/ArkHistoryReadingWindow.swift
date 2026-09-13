import Foundation
import JiuzhangShellCore

/// Immutable presentation of one bounded record range at one source cut.
/// Live event cursors, composer state and workbench ownership stay in ArkAppModel.
public struct ArkHistoryReadingSnapshot: Sendable {
  public let cut: ArkHistoryCut
  public let records: [ArkSemanticHistoryRecord]
  public let messages: [ArkMessage]
  public let previewMessageIDs: Set<Int>
  public let recordByMessageID: [Int: ArkSemanticHistoryRecord]
  public let toolActivities: [ArkToolActivity]
  public let chatStatuses: [ArkChatStatus]
  public let producedFiles: [ArkProducedFile]
  public let turnMetricsByTurn: [Int: ArkChatTurnMetrics]
  public let turnUsageByTurn: [Int: ArkChatTurnUsage]
  public let forkableMessageIDs: Set<Int>
  public let completedTurnIDs: Set<Int>
  public let completedSequenceByTurn: [Int: Int]
  public let turnTerminalStates: [Int: ArkChatTurnState]
  public let latestStartedTurn: Int?
  public let latestStartedTurnSequence: Int?
  /// Metadata evidence only. Timing-boundary chunks are intentionally excluded;
  /// trajectory message bodies must come from `messages` and their descriptors.
  public let trajectoryEvents: [ArkHistoryEvent]
  public let hasOlderHistory: Bool
  public let hasNewerHistory: Bool
}

/// Captures the original authorized route for every page, fragment and cleanup.
/// It has no mutable transport or session state.
enum ArkHistoryAddress: Equatable, Sendable {
  case session(String)
  case child(parent: String, session: String, mode: String)

  func page(client: ArkAPIClient, cut: ArkHistoryCut? = nil, before: Cursor? = nil, maximum: Int = 200) async throws -> ArkSemanticHistoryPage {
    switch self {
    case .session(let session):
      return try await client.semanticHistoryPage(sessionID: session, cut: cut, beforeRecordID: before?.id, beforeOrderSequence: before?.sequence, maximumRecords: maximum)
    case .child(let parent, let session, let mode):
      return try await client.subagentSemanticHistoryPage(parentSessionID: parent, childSessionID: session, mode: mode, cut: cut, beforeRecordID: before?.id, beforeOrderSequence: before?.sequence, maximumRecords: maximum)
    }
  }

  func content(client: ArkAPIClient, cut: ArkHistoryCut, recordID: String) async throws -> ArkSemanticHistoryContent {
    switch self {
    case .session(let session): return try await client.semanticHistoryContent(sessionID: session, cut: cut, recordID: recordID)
    case .child(let parent, let session, let mode):
      return try await client.subagentSemanticHistoryContent(parentSessionID: parent, childSessionID: session, mode: mode, cut: cut, recordID: recordID)
    }
  }

  func raw(client: ArkAPIClient, cut: ArkHistoryCut? = nil, before: Int? = nil, maximum: Int = 2_048) async throws -> ArkBoundHistoryPage {
    switch self {
    case .session(let session): return try await client.boundHistoryPage(sessionID: session, cut: cut, beforeSequence: before, maximumEvents: maximum)
    case .child(let parent, let session, let mode):
      return try await client.subagentBoundHistoryPage(parentSessionID: parent, childSessionID: session, mode: mode, cut: cut, beforeSequence: before, maximumEvents: maximum)
    }
  }

  /// Called after the fresh-cut recovery, immediately before model publication.
  /// A checkpoint admitted before a source replacement must fail this second proof.
  func validateCheckpoint(client: ArkAPIClient, cut: ArkHistoryCut) async throws {
    _ = try await raw(client: client, cut: cut, maximum: 1)
    try Task.checkCancellation()
  }

  struct Cursor: Equatable, Sendable {
    let id: String
    let sequence: Int
  }
}

/// The existing domain reducers are the sole interpretation of sparse seeds.
/// This value is installed once per cut, not rebuilt for every record page.
struct ArkHistoryReadingSeed: Sendable {
  let cut: ArkHistoryCut
  let tools: ArkToolProjection
  var statuses: ArkChatStatusProjection
  let producedFiles: ArkProducedFilesProjection
  let turns: ArkChatTurnProjection
  let usage: [Int: ArkChatTurnUsage]
  let turnContexts: [ArkHistoryTurnContext]
  let trajectoryEvents: [ArkHistoryEvent]
  let lastAssistantIDByTurn: [Int: Int]

  static func usageFacts(from contexts: [ArkHistoryTurnContext]) throws -> [Int: ArkChatTurnUsage] {
    var usageByTurn: [Int: ArkChatTurnUsage] = [:]
    var knownTurns = Set<Int>()
    for context in contexts {
      guard knownTurns.insert(context.turn).inserted else {
        throw ArkAPIError(message: "历史依赖包含重复轮次事实", code: "invalid-history-response")
      }
      guard let value = context.usage else { continue }
      usageByTurn[context.turn] = ArkChatTurnUsage(
        uncachedInputTokens: value.uncachedInputTokens, outputTokens: value.outputTokens, totalTokens: value.totalTokens,
        cacheReadTokens: value.cacheReadTokens, cacheWriteTokens: value.cacheWriteTokens, reasoningTokens: value.reasoningTokens,
        routes: value.routes?.map { ArkChatTurnUsageRoute(provider: $0.provider, model: $0.model) }
      )
    }
    return usageByTurn
  }

  init(tool: ArkHistoryDependencyBundle, status: ArkHistoryDependencyBundle, turn: ArkHistoryDependencyBundle, language: ArkLanguagePreference) throws {
    guard tool.domain == .tool, status.domain == .status, turn.domain == .turn,
          tool.cut == status.cut, tool.cut == turn.cut,
          tool.chunkCoverage == .none, status.chunkCoverage == .none, turn.chunkCoverage == .timingBoundaries,
          tool.turns == turn.turns, status.turns == turn.turns
    else { throw ArkAPIError(message: "历史依赖种子的来源不一致", code: "invalid-history-response") }
    guard [tool, status, turn].allSatisfy({ $0.completeness == .complete && $0.missing.isEmpty }) else {
      throw ArkAPIError(message: "历史依赖证据不完整，尚不能安装完整时间线", code: "history-incomplete-dependency")
    }
    try Task.checkCancellation()
    cut = tool.cut
    tools = ArkToolProjection(events: tool.entries)
    producedFiles = ArkProducedFilesProjection(events: tool.entries)
    try Task.checkCancellation()
    statuses = ArkChatStatusProjection(events: status.entries, language: language)
    turns = ArkChatTurnProjection(events: turn.entries)
    turnContexts = turn.turns
    usage = try Self.usageFacts(from: turn.turns)
    // No assistant chunks enter the trajectory's body reducer. Exact bodies are
    // supplied separately through the semantic record and immutable message.
    var known = Set<Int>()
    trajectoryEvents = (tool.entries + status.entries)
      .filter { $0.type != "assistant/chunk" && known.insert($0.id).inserted }
      .sorted { $0.id < $1.id }
    var lastAssistant: [Int: Int] = [:]
    for event in status.entries where event.type == "assistant/message" {
      if let turn = ArkChatTurnUsageProjection.turn(in: event) { lastAssistant[turn] = event.id }
    }
    lastAssistantIDByTurn = lastAssistant
    try Task.checkCancellation()
  }
}

/// One selected-session history owner. The caller owns navigation tasks and
/// rejects stale model generations; this owner additionally guards its own cut
/// and cancels/awaits each content handle through the shared Core transfer.
@MainActor
final class ArkHistoryReadingWindow {
  static let maximumDescriptors = 400
  static let maximumBodyBytes = 8 * 1_024 * 1_024
  let address: ArkHistoryAddress
  private let client: ArkAPIClient
  private var language: ArkLanguagePreference
  private(set) var seed: ArkHistoryReadingSeed?
  private(set) var snapshot: ArkHistoryReadingSnapshot?
  private struct ResidentPage {
    let cursor: ArkHistoryAddress.Cursor?
    let page: ArkSemanticHistoryPage
  }
  private var pages: [ResidentPage] = []
  private var newerCursors: [ArkHistoryAddress.Cursor?] = []
  private var messages: [String: ArkMessage] = [:]
  private var bodyEvidence: [String: ArkHistoryEvent] = [:]
  private var hiddenMessages = Set<String>()
  private var bodyCharges: [String: Int] = [:]
  private var bodyOrder: [String] = []
  private var generation: UInt64 = 0
  private var transfer: Task<ArkSemanticHistoryContent, Error>?
  private var transferID: UUID?
  private var busy = false
  var ordinaryBodyBytes: Int { bodyCharges.values.filter { $0 <= Self.maximumBodyBytes }.reduce(0, +) }
  var oversizedBodyCount: Int { bodyCharges.values.filter { $0 > Self.maximumBodyBytes }.count }

  init(client: ArkAPIClient, address: ArkHistoryAddress, language: ArkLanguagePreference) {
    self.client = client
    self.address = address
    self.language = language
  }

  func cancel() {
    generation &+= 1
    transfer?.cancel()
  }

  func relocalize(to language: ArkLanguagePreference) async throws -> ArkHistoryReadingSnapshot? {
    self.language = language
    guard let seed else { return snapshot }
    let captured = generation
    let task = Task.detached(priority: .userInitiated) {
      ArkChatStatusProjection(events: seed.trajectoryEvents, language: language)
    }
    let statuses = await withTaskCancellationHandler { await task.value } onCancel: { task.cancel() }
    try check(captured)
    guard self.seed?.cut == seed.cut else { throw CancellationError() }
    self.seed?.statuses = statuses
    return pages.isEmpty ? snapshot : installSnapshot()
  }

  func cachedMessage(recordID: String) -> ArkMessage? { messages[recordID] }

  private func check(_ captured: UInt64) throws {
    try Task.checkCancellation()
    guard captured == generation else { throw CancellationError() }
  }

  private func read(_ recordID: String, cut: ArkHistoryCut) async throws -> ArkSemanticHistoryContent {
    let captured = generation
    guard transfer == nil else { throw ArkAPIError(message: "历史正文正在读取", code: "history-content-busy") }
    let id = UUID()
    let client = client
    let address = address
    let task = Task { try await address.content(client: client, cut: cut, recordID: recordID) }
    transfer = task
    transferID = id
    defer { if transferID == id { transfer = nil; transferID = nil } }
    let content = try await withTaskCancellationHandler {
      try await task.value
    } onCancel: { task.cancel() }
    try check(captured)
    return content
  }

  func open(firstPage: ArkSemanticHistoryPage? = nil, hydrateActive: Bool = true) async throws -> ArkHistoryReadingSnapshot {
    guard !busy else { throw ArkAPIError(message: "历史正在读取", code: "history-read-busy") }
    busy = true
    defer { busy = false }
    let captured = generation
    let page: ArkSemanticHistoryPage
    if let firstPage { page = firstPage } else { page = try await address.page(client: client) }
    var bundles: [ArkHistoryDependencyDomain: ArkHistoryDependencyBundle] = [:]
    for domain in ArkHistoryDependencyDomain.allCases {
      guard let id = page.dependencyRecords[domain],
            case .dependency(let bundle) = try await read(id, cut: page.cut), bundle.domain == domain, bundle.cut == page.cut
      else { throw ArkAPIError(message: "历史依赖种子响应无效", code: "invalid-history-response") }
      bundles[domain] = bundle
    }
    let tool = bundles[.tool]!, status = bundles[.status]!, turn = bundles[.turn]!, language = language
    let fold = Task.detached(priority: .userInitiated) { try ArkHistoryReadingSeed(tool: tool, status: status, turn: turn, language: language) }
    let seed = try await withTaskCancellationHandler { try await fold.value } onCancel: { fold.cancel() }
    try check(captured)
    self.seed = seed
    try await hydrate(page.records, cut: page.cut, hydrateActive: hydrateActive)
    try check(captured)
    pages = [ResidentPage(cursor: nil, page: page)]
    newerCursors = []
    return installSnapshot()
  }

  func older() async throws -> ArkHistoryReadingSnapshot {
    guard !busy, let page = pages.first?.page, let id = page.nextBeforeRecordID, let first = page.records.first else {
      if let snapshot { return snapshot }
      throw ArkAPIError(message: "没有可读取的旧历史")
    }
    busy = true
    defer { busy = false }
    let captured = generation
    let cursor = ArkHistoryAddress.Cursor(id: id, sequence: first.orderSequence)
    let next = try await address.page(client: client, cut: page.cut, before: cursor)
    var candidate = [ResidentPage(cursor: cursor, page: next)] + pages
    let removed = candidate.count > 2 ? candidate.removeLast() : nil
    try await hydrate(candidate.flatMap { $0.page.records }, cut: next.cut)
    try check(captured)
    if let removed { newerCursors.append(removed.cursor) }
    pages = candidate
    return installSnapshot()
  }

  func newer() async throws -> ArkHistoryReadingSnapshot {
    guard !busy, !newerCursors.isEmpty, let page = pages.first?.page else {
      if let snapshot { return snapshot }
      throw ArkAPIError(message: "没有可读取的较新历史")
    }
    busy = true
    defer { busy = false }
    let captured = generation
    let cursor = newerCursors[newerCursors.count - 1]
    let next = try await address.page(client: client, cut: page.cut, before: cursor)
    var candidate = pages + [ResidentPage(cursor: cursor, page: next)]
    if candidate.count > 2 { candidate.removeFirst() }
    try await hydrate(candidate.flatMap { $0.page.records }, cut: next.cut)
    try check(captured)
    newerCursors.removeLast()
    pages = candidate
    return installSnapshot()
  }

  func message(messageID: Int) async throws -> ArkMessage {
    guard let snapshot, let record = snapshot.recordByMessageID[messageID] else {
      throw ArkAPIError(message: "消息已离开当前阅读范围", code: "history-stale-record")
    }
    return try await message(record: record)
  }

  func message(record: ArkSemanticHistoryRecord) async throws -> ArkMessage {
    guard let cut = seed?.cut else { throw ArkAPIError(message: "历史来源尚未载入") }
    if let cached = messages[record.id] { return cached }
    let content = try await read(record.id, cut: cut)
    guard let message = try content.message(for: record) else { throw ArkAPIError(message: "此记录没有可显示的消息正文") }
    retain(message, content: content, for: record.id)
    _ = installSnapshot()
    return message
  }

  private func hydrate(_ records: [ArkSemanticHistoryRecord], cut: ArkHistoryCut, hydrateActive: Bool = true) async throws {
    guard records.count <= Self.maximumDescriptors else { throw ArkAPIError(message: "历史阅读范围超过预算") }
    for record in records where record.kind != .tool && messages[record.id] == nil && (hydrateActive || record.state != .active) {
      try Task.checkCancellation()
      // One resident oversize body is allowed. Release it before another
      // materialization; normal LRU bodies have their independent 8 MiB budget.
      for id in bodyOrder where (bodyCharges[id] ?? 0) > Self.maximumBodyBytes { removeBody(id) }
      let content = try await read(record.id, cut: cut)
      if let message = try content.message(for: record) { retain(message, content: content, for: record.id) }
      else { hiddenMessages.insert(record.id) }
    }
    let resident = Set(records.map(\.id))
    hiddenMessages.formIntersection(resident)
    for id in bodyOrder where !resident.contains(id) { removeBody(id) }
  }

  private func removeBody(_ id: String) {
    messages.removeValue(forKey: id)
    bodyEvidence.removeValue(forKey: id)
    bodyCharges.removeValue(forKey: id)
    bodyOrder.removeAll { $0 == id }
  }

  private func retain(_ message: ArkMessage, content: ArkSemanticHistoryContent, for id: String) {
    let evidence: ArkHistoryEvent?
    switch content { case .user(let event), .assistant(let event): evidence = event; default: evidence = nil }
    // Count duplicated display fields conservatively, including ordered blocks.
    let blockBytes = message.blocks.reduce(0) { count, block in
      switch block {
      case .text(let text), .reasoning(let text), .image(let text): return count + text.utf8.count
      case .unknown(_, let value): return count + ((try? JSONEncoder().encode(value).count) ?? 0)
      }
    }
    let evidenceBytes = evidence.flatMap { try? JSONEncoder().encode($0.data).count } ?? 0
    let bytes = message.text.utf8.count + (message.reasoning?.utf8.count ?? 0) + blockBytes + evidenceBytes
    if bytes > Self.maximumBodyBytes {
      for key in bodyOrder where (bodyCharges[key] ?? 0) > Self.maximumBodyBytes { removeBody(key) }
    }
    messages[id] = message
    bodyEvidence[id] = evidence
    bodyCharges[id] = bytes
    bodyOrder.removeAll { $0 == id }
    bodyOrder.append(id)
    var ordinaryBytes = bodyCharges.values.filter { $0 <= Self.maximumBodyBytes }.reduce(0, +)
    for key in bodyOrder where ordinaryBytes > Self.maximumBodyBytes {
      guard let charge = bodyCharges[key], charge <= Self.maximumBodyBytes else { continue }
      ordinaryBytes -= charge
      removeBody(key)
    }
  }

  private func installSnapshot() -> ArkHistoryReadingSnapshot {
    precondition(!pages.isEmpty && seed != nil)
    let page = pages[0].page, seed = seed!
    let records = pages.flatMap { $0.page.records }
    var rows: [ArkMessage] = []
    var previews = Set<Int>()
    var byID: [Int: ArkSemanticHistoryRecord] = [:]
    for record in records where record.kind != .tool && !hiddenMessages.contains(record.id) {
      let id = record.canonicalEventSequence ?? record.orderSequence
      byID[id] = record
      if let message = messages[record.id] { rows.append(message) }
      else {
        previews.insert(id)
        rows.append(ArkMessage(id: id, role: record.kind == .user ? .user : .assistant, text: record.preview, turn: record.turn, step: record.step, interrupted: record.state != .active && record.state != .complete, time: record.time))
      }
    }
    let lower = records.first?.orderSequence ?? 0
    let upper = pages.last?.cursor.map { $0.sequence - 1 } ?? page.cut.throughSequence
    let visibleTurns = Set(records.compactMap(\.turn))
    let tools = seed.tools.activities.filter { ($0.sequence >= lower && $0.sequence <= upper) }
    let statuses = seed.statuses.statuses.filter { $0.sequence >= lower && $0.sequence <= upper }
    let result = ArkHistoryReadingSnapshot(
      cut: page.cut, records: records, messages: rows, previewMessageIDs: previews, recordByMessageID: byID,
      toolActivities: tools, chatStatuses: statuses,
      producedFiles: seed.producedFiles.files.filter { visibleTurns.contains($0.turn) && $0.resultSequence <= upper },
      turnMetricsByTurn: seed.turns.metricsByTurn.filter { visibleTurns.contains($0.key) },
      turnUsageByTurn: seed.usage.filter { visibleTurns.contains($0.key) },
      forkableMessageIDs: Set(records.compactMap { record in
        guard let turn = record.turn, let canonical = record.canonicalEventSequence,
              record.kind == .assistant, seed.lastAssistantIDByTurn[turn] == canonical,
              seed.turns.completedSequenceByTurn[turn] == record.completedTurnEndSequence,
              record.completedTurnEndSequence != nil, !previews.contains(canonical) else { return nil }
        return canonical
      }),
      completedTurnIDs: Set(seed.turns.completedSequenceByTurn.keys), completedSequenceByTurn: seed.turns.completedSequenceByTurn,
      turnTerminalStates: seed.turns.terminalStateByTurn,
      latestStartedTurn: seed.turns.latestStartedTurn, latestStartedTurnSequence: seed.turns.latestStartedSequence,
      trajectoryEvents: (seed.trajectoryEvents.filter { event in
        guard event.id <= upper else { return false }
        if event.id >= lower { return true }
        // Carry-in lifecycle/request facts establish the same scope as full raw
        // projection; they are evidence, not additional visible message bodies.
        return ["turn/start", "step/start", "request/header", "request/context"].contains(event.type)
          && event.data["turn"]?.numberValue.map { visibleTurns.contains(Int($0)) } == true
      } + records.compactMap { bodyEvidence[$0.id] }).reduce(into: [Int: ArkHistoryEvent]()) { $0[$1.id] = $1 }.values.sorted { $0.id < $1.id },
      hasOlderHistory: page.hasMore, hasNewerHistory: !newerCursors.isEmpty
    )
    snapshot = result
    return result
  }
}

/// Relocalization reuses the status reducer at a verified published boundary.
/// It never consumes pending events or tries to recover missing state from a ring.
enum ArkHistoryStatusRelocalization {
  static func projection(bundle: ArkHistoryDependencyBundle, through: Int, language: ArkLanguagePreference) throws -> ArkChatStatusProjection {
    guard bundle.domain == .status, bundle.completeness == .complete, bundle.missing.isEmpty,
          bundle.chunkCoverage == .none, through <= bundle.cut.throughSequence else {
      throw ArkAPIError(message: "状态本地化缺少完整来源证据", code: "history-incomplete-dependency")
    }
    return ArkChatStatusProjection(events: bundle.entries.filter { $0.id <= through }, language: language)
  }

  static func catchingUp(_ projection: ArkChatStatusProjection, from through: Int, publishedEvents: [ArkHistoryEvent]) throws -> ArkChatStatusProjection {
    var result = projection
    var next = through + 1
    for event in publishedEvents where event.id > through {
      guard event.id == next else { throw ArkAPIError(message: "状态本地化期间历史范围已移动", code: "history-localization-gap") }
      result.append(event)
      next += 1
    }
    return result
  }
}
