import Foundation

/// A captured source revision is opaque. Sequence values alone do not identify a source.
public struct ArkHistoryCut: Equatable, Sendable {
  public let sourceRevision: String
  public let throughSequence: Int

  public init(sourceRevision: String, throughSequence: Int) throws {
    guard !sourceRevision.isEmpty,
          ArkAPIClient.safeJSONInteger(.number(Double(throughSequence)), minimum: -1) == throughSequence
    else { throw ArkSemanticHistory.invalid("source cut") }
    self.sourceRevision = sourceRevision
    self.throughSequence = throughSequence
  }
}

public struct ArkSemanticHistoryRecord: Identifiable, Equatable, Sendable {
  public enum Kind: String, Sendable { case user, assistant, tool }
  public enum State: String, Sendable {
    case complete, interrupted, active, unpaired
    case failedPrefix = "failed-prefix"
    case orphanedPrefix = "orphaned-prefix"
  }
  public let id: String
  public let kind: Kind
  public let orderSequence: Int
  public let time: Date
  public let turn: Int?
  public let step: Int?
  public let state: State
  /// Plain, bounded preview; never a source for complete copy or Markdown.
  public let preview: String
  public let canonicalEventSequence: Int?
  public let callEventSequence: Int?
  public let resultEventSequence: Int?
  public let completedTurnEndSequence: Int?
}

/// Host token-meter facts, not a resumable strict usage accumulator.
public struct ArkHistoryTurnUsage: Equatable, Sendable {
  public struct Route: Equatable, Sendable {
    public let provider: String
    public let model: String
  }
  public let uncachedInputTokens: Int
  public let outputTokens: Int
  public let totalTokens: Int
  public let cacheReadTokens: Int?
  public let cacheWriteTokens: Int?
  public let reasoningTokens: Int?
  public let routes: [Route]?
}

public struct ArkHistoryTurnContext: Equatable, Sendable {
  public let turn: Int
  public let startSequence: Int?
  public let endSequence: Int?
  public let usage: ArkHistoryTurnUsage?
}

public enum ArkHistoryDependencyDomain: String, CaseIterable, Sendable {
  case tool, status, turn
}

public struct ArkSemanticHistoryPage: Sendable {
  public let cut: ArkHistoryCut
  public let records: [ArkSemanticHistoryRecord]
  public let turns: [ArkHistoryTurnContext]
  public let dependencyRecords: [ArkHistoryDependencyDomain: String]
  public let hasMore: Bool
  public let nextBeforeRecordID: String?
}

public struct ArkBoundHistoryPage: Sendable {
  public let cut: ArkHistoryCut
  public let page: ArkHistoryPage
}

public struct ArkHistoryDependencyBundle: Sendable {
  public enum Completeness: String, Sendable { case complete, unknown }
  public enum ChunkCoverage: String, Sendable {
    case none
    case timingBoundaries = "timing-boundaries"
  }
  public let domain: ArkHistoryDependencyDomain
  public let cut: ArkHistoryCut
  public let completeness: Completeness
  public let chunkCoverage: ChunkCoverage
  public let missing: [String]
  /// Sparse domain evidence. Never install in the raw cursor or strict usage fold.
  public let entries: [ArkHistoryEvent]
  public let turns: [ArkHistoryTurnContext]
}

public enum ArkSemanticHistoryContent: Sendable {
  case user(ArkHistoryEvent)
  case assistant(ArkHistoryEvent)
  case tool(call: ArkHistoryEvent?, result: ArkHistoryEvent?)
  /// Complete immutable body at the cut; contains no indexed live assembler checkpoint.
  case assistantPrefix(turn: Int?, step: Int?, blocks: [JSONValue])
  case dependency(ArkHistoryDependencyBundle)
}

/// Stateless wire validation and one structured, serial content transfer. The caller
/// owns its task and presentation generation; this introduces no second session owner.
public enum ArkSemanticHistory {
  public typealias ContentRequest = @Sendable ([String: JSONValue]) async throws -> JSONValue

  static func invalid(_ field: String) -> ArkAPIError {
    ArkAPIError(message: "会话语义历史响应无效（\(field)）", code: "invalid-history-response")
  }

  private static func string(_ value: JSONValue?, _ field: String) throws -> String {
    guard let result = value?.stringValue, !result.isEmpty else { throw invalid(field) }
    return result
  }

  private static func integer(_ value: JSONValue?, _ field: String, minimum: Int = 0) throws -> Int {
    guard let result = ArkAPIClient.safeJSONInteger(value, minimum: minimum) else { throw invalid(field) }
    return result
  }

  private static func optionalInteger(_ value: JSONValue?, _ field: String, through: Int? = nil) throws -> Int? {
    guard let value else { return nil }
    let result = try integer(value, field)
    if let through, result > through { throw invalid(field) }
    return result
  }

  private static func cut(_ value: JSONValue, expected: ArkHistoryCut?) throws -> ArkHistoryCut {
    let result = try ArkHistoryCut(
      sourceRevision: string(value["sourceRevision"], "revision"),
      throughSequence: integer(value["asOfThroughSeq"], "through", minimum: -1)
    )
    if let expected, result != expected { throw invalid("changed source cut") }
    return result
  }

  public static func page(
    from value: JSONValue,
    expectedCut: ArkHistoryCut? = nil,
    beforeRecordID: String? = nil,
    beforeOrderSequence: Int? = nil,
    maximumRecords: Int = 50
  ) throws -> ArkSemanticHistoryPage {
    guard (beforeRecordID == nil) == (beforeOrderSequence == nil),
          beforeRecordID == nil || expectedCut != nil,
          (1...200).contains(maximumRecords), value["view"] == .string("semantic"),
          value["events"] == nil, let rows = value["records"]?.arrayValue,
          rows.count <= maximumRecords, let hasMore = value["hasMore"]?.boolValue,
          value["pendingDomains"] == .array([])
    else { throw invalid("semantic page") }
    let sourceCut = try cut(value, expected: expectedCut)
    var identities = Set<String>()
    var previousSequence = -1
    let records = try rows.map { row -> ArkSemanticHistoryRecord in
      let id = try string(row["id"], "record id")
      let order = try integer(row["orderSeq"], "record order")
      guard identities.insert(id).inserted, id != beforeRecordID,
            order > previousSequence, order <= sourceCut.throughSequence,
            beforeOrderSequence == nil || order < beforeOrderSequence!,
            let kind = row["kind"]?.stringValue.flatMap(ArkSemanticHistoryRecord.Kind.init),
            let state = row["state"]?.stringValue.flatMap(ArkSemanticHistoryRecord.State.init),
            let time = row["time"]?.numberValue, time.isFinite,
            row["contentState"] == .string("complete-at-cut"),
            let preview = row["preview"]?.stringValue, preview.utf16.count <= 512
      else { throw invalid("record") }
      previousSequence = order
      let canonical = try optionalInteger(row["canonicalEventSeq"], "canonical", through: sourceCut.throughSequence)
      let call = try optionalInteger(row["callEventSeq"], "call", through: sourceCut.throughSequence)
      let result = try optionalInteger(row["resultEventSeq"], "result", through: sourceCut.throughSequence)
      guard (kind == .tool || (call == nil && result == nil)),
            (kind != .tool || canonical == nil),
            (canonical == nil || canonical! >= order),
            (call == nil || call! >= order), (result == nil || result! >= order)
      else { throw invalid("record locators") }
      switch kind {
      case .user:
        guard state == .complete, canonical == order else { throw invalid("user identity") }
      case .assistant:
        guard (state == .complete || state == .interrupted) == (canonical != nil), state != .unpaired else {
          throw invalid("assistant completeness")
        }
      case .tool:
        guard call != nil || result != nil,
              state == (call != nil && result != nil ? .complete : .unpaired) else { throw invalid("tool completeness") }
      }
      return ArkSemanticHistoryRecord(
        id: id, kind: kind, orderSequence: order, time: Date(timeIntervalSince1970: time / 1000),
        turn: try optionalInteger(row["turn"], "turn"), step: try optionalInteger(row["step"], "step"),
        state: state, preview: preview, canonicalEventSequence: canonical,
        callEventSequence: call, resultEventSequence: result,
        completedTurnEndSequence: try optionalInteger(row["completedTurnEndSeq"], "completed turn", through: sourceCut.throughSequence)
      )
    }
    let next = try value["nextBeforeRecordId"].map { try string($0, "next cursor") }
    guard hasMore ? (!records.isEmpty && next == records.first?.id) : value["nextBeforeRecordId"] == nil
    else { throw invalid("page progress") }
    var dependencies: [ArkHistoryDependencyDomain: String] = [:]
    for domain in ArkHistoryDependencyDomain.allCases {
      dependencies[domain] = try string(value["dependencyRecords"]?[domain.rawValue], "dependency id")
    }
    guard Set(dependencies.values).count == 3 else { throw invalid("dependency identity") }
    return ArkSemanticHistoryPage(
      cut: sourceCut, records: records, turns: try turns(value["turns"], through: sourceCut.throughSequence),
      dependencyRecords: dependencies, hasMore: hasMore, nextBeforeRecordID: next
    )
  }

  public static func rawPage(
    from value: JSONValue,
    expectedCut: ArkHistoryCut? = nil,
    beforeSequence: Int? = nil,
    maximumEvents: Int = 2_048
  ) throws -> ArkBoundHistoryPage {
    guard value["view"] == .string("raw"), value["records"] == nil,
          value["projections"] == nil, (1...2_048).contains(maximumEvents),
          beforeSequence == nil || ArkAPIClient.safeJSONInteger(.number(Double(beforeSequence!))) == beforeSequence
    else { throw invalid("bound raw page") }
    let sourceCut = try cut(value, expected: expectedCut)
    let page = try ArkAPIClient.validatedHistoryPage(from: value, context: "固定原始历史")
    let expectedEnd = min(sourceCut.throughSequence, (beforeSequence ?? (sourceCut.throughSequence + 1)) - 1)
    guard page.events.count <= maximumEvents,
          (expectedEnd < 0 ? page.events.isEmpty : page.events.last?.id == expectedEnd)
    else { throw invalid("bound raw coverage") }
    return ArkBoundHistoryPage(cut: sourceCut, page: page)
  }

  private static func turns(_ value: JSONValue?, through: Int) throws -> [ArkHistoryTurnContext] {
    guard let rows = value?.arrayValue else { throw invalid("turn context") }
    var seen = Set<Int>()
    return try rows.map { row in
      let turn = try integer(row["turn"], "turn")
      let start = try optionalInteger(row["startSeq"], "turn start", through: through)
      let end = try optionalInteger(row["endSeq"], "turn end", through: through)
      guard seen.insert(turn).inserted, start != nil || end != nil,
            start == nil || end == nil || start! <= end!, let rawUsage = row["usage"]
      else { throw invalid("turn context") }
      let usage = rawUsage == .null ? nil : try usage(rawUsage)
      guard end != nil || usage == nil else { throw invalid("active usage") }
      return ArkHistoryTurnContext(turn: turn, startSequence: start, endSequence: end, usage: usage)
    }
  }

  private static func usage(_ value: JSONValue) throws -> ArkHistoryTurnUsage {
    var routes: [ArkHistoryTurnUsage.Route]?
    if let raw = value["routes"] {
      guard let rows = raw.arrayValue else { throw invalid("usage routes") }
      routes = try rows.map { .init(provider: try string($0["provider"], "provider"), model: try string($0["model"], "model")) }
    }
    return ArkHistoryTurnUsage(
      uncachedInputTokens: try integer(value["uncachedInputTokens"], "input usage"),
      outputTokens: try integer(value["outputTokens"], "output usage"),
      totalTokens: try integer(value["totalTokens"], "total usage"),
      cacheReadTokens: try optionalInteger(value["cacheReadTokens"], "cache read"),
      cacheWriteTokens: try optionalInteger(value["cacheWriteTokens"], "cache write"),
      reasoningTokens: try optionalInteger(value["reasoningTokens"], "reasoning usage"), routes: routes
    )
  }

  private static func entry(_ value: JSONValue, through: Int, type: String? = nil) throws -> ArkHistoryEvent {
    guard let event = ArkAPIClient.historyEvent(from: value), event.id <= through,
          type == nil || event.type == type else { throw invalid("content event") }
    return event
  }

  public static func content(from value: JSONValue, cut: ArkHistoryCut) throws -> ArkSemanticHistoryContent {
    switch value["kind"]?.stringValue {
    case "user": return .user(try entry(value["entry"] ?? .null, through: cut.throughSequence, type: "user/message"))
    case "assistant": return .assistant(try entry(value["entry"] ?? .null, through: cut.throughSequence, type: "assistant/message"))
    case "tool":
      let call = try value["call"].map { try entry($0, through: cut.throughSequence, type: "tool/call") }
      let result = try value["result"].map { try entry($0, through: cut.throughSequence, type: "tool/result") }
      guard call != nil || result != nil else { throw invalid("empty tool") }
      return .tool(call: call, result: result)
    case "assistant-prefix":
      guard let blocks = value["content"]?.arrayValue, blocks.allSatisfy({ $0.objectValue != nil && $0["type"]?.stringValue != nil })
      else { throw invalid("prefix blocks") }
      return .assistantPrefix(turn: try optionalInteger(value["turn"], "prefix turn"), step: try optionalInteger(value["step"], "prefix step"), blocks: blocks)
    case "dependency":
      let sourceCut = try self.cut(value, expected: cut)
      guard let domain = value["domain"]?.stringValue.flatMap(ArkHistoryDependencyDomain.init),
            let completeness = value["completeness"]?.stringValue.flatMap(ArkHistoryDependencyBundle.Completeness.init),
            let coverage = value["chunkCoverage"]?.stringValue.flatMap(ArkHistoryDependencyBundle.ChunkCoverage.init),
            coverage == (domain == .turn ? .timingBoundaries : .none),
            let missingValues = value["missing"]?.arrayValue, let rawEntries = value["entries"]?.arrayValue
      else { throw invalid("dependency") }
      let allowed = Set(["parent-call", "dispatch-start", "workflow-start", "workflow-member", "command-start", "compaction-start", "turn-start"])
      let missing = try missingValues.map { try string($0, "missing dependency") }
      guard Set(missing).count == missing.count, Set(missing).isSubset(of: allowed),
            (completeness == .complete) == missing.isEmpty else { throw invalid("dependency completeness") }
      var previous = -1
      let events = try rawEntries.map { raw -> ArkHistoryEvent in
        let event = try entry(raw, through: cut.throughSequence)
        guard event.id > previous else { throw invalid("dependency order") }
        previous = event.id
        return event
      }
      return .dependency(.init(domain: domain, cut: sourceCut, completeness: completeness, chunkCoverage: coverage, missing: missing, entries: events, turns: try turns(value["turns"], through: cut.throughSequence)))
    default: throw invalid("content kind")
    }
  }

  /// One transfer owns one handle locally. The caller cancels/awaits this task on
  /// session changes. Cleanup runs uncancelled and is awaited before returning.
  public static func readContent(
    cut: ArkHistoryCut,
    recordID: String,
    maximumCodeUnits: Int = 16_384,
    request: @escaping ContentRequest
  ) async throws -> ArkSemanticHistoryContent {
    guard !recordID.isEmpty, (2...65_536).contains(maximumCodeUnits) else { throw invalid("content request") }
    var offset = 0
    var handle: String?
    var body = Data()
    func arguments(close: Bool = false) -> [String: JSONValue] {
      var result: [String: JSONValue] = [
        "view": .string("content"), "sourceRevision": .string(cut.sourceRevision),
        "recordId": .string(recordID), "offset": .number(Double(offset)),
        "maxCodeUnits": .number(Double(maximumCodeUnits)),
      ]
      if let handle { result["contentReadId"] = .string(handle) }
      if close { result["close"] = .bool(true) }
      return result
    }
    do {
      while true {
        try Task.checkCancellation()
        let value = try await request(arguments())
        // Capture an initial handle even if cancellation arrived while the server
        // was materializing, so a late successful response is still disposed.
        if handle == nil, let returned = value["contentReadId"]?.stringValue, !returned.isEmpty {
          handle = returned
        }
        try Task.checkCancellation()
        guard value["view"] == .string("content"), value["encoding"] == .string("json"),
              value["recordId"] == .string(recordID), value["contentReadId"]?.stringValue == handle,
              handle != nil, try self.cut(value, expected: cut) == cut,
              try integer(value["offset"], "fragment offset") == offset,
              let text = value["text"]?.stringValue, let done = value["done"]?.boolValue
        else { throw invalid("content fragment identity") }
        let next = try integer(value["nextOffset"], "fragment next offset")
        let units = text.utf16.count
        guard units <= maximumCodeUnits, next == offset + units, done || units > 0 else {
          throw invalid("fragment progress")
        }
        // Swift String is well-formed Unicode; a split surrogate cannot decode
        // into an accepted String. UTF-16 counts, not grapheme counts, advance RPC.
        body.append(contentsOf: text.utf8)
        offset = next
        if done {
          handle = nil // Host has already released this handle.
          try Task.checkCancellation()
          let value = try JSONDecoder().decode(JSONValue.self, from: body)
          return try content(from: value, cut: cut)
        }
      }
    } catch {
      if handle != nil {
        let closeArguments = arguments(close: true)
        _ = await Task.detached { try? await request(closeArguments) }.value
      }
      throw error
    }
  }
}

extension ArkAPIClient {
  public func boundHistoryPage(
    sessionID: String,
    cut: ArkHistoryCut? = nil,
    beforeSequence: Int? = nil,
    maximumEvents: Int = 2_048
  ) async throws -> ArkBoundHistoryPage {
    guard !sessionID.isEmpty, (1...2_048).contains(maximumEvents),
          beforeSequence == nil || Self.safeJSONInteger(.number(Double(beforeSequence!))) == beforeSequence
    else { throw ArkSemanticHistory.invalid("bound raw request") }
    var request: [String: JSONValue] = ["sessionId": .string(sessionID), "view": .string("raw"), "maxEvents": .number(Double(maximumEvents))]
    if let cut { request["sourceRevision"] = .string(cut.sourceRevision) }
    if let beforeSequence { request["beforeSeq"] = .number(Double(beforeSequence)) }
    let value = try await remoteDomainRequest(method: "session/history", request: request)
    try Task.checkCancellation()
    return try ArkSemanticHistory.rawPage(from: value, expectedCut: cut, beforeSequence: beforeSequence, maximumEvents: maximumEvents)
  }

  public func semanticHistoryPage(
    sessionID: String,
    cut: ArkHistoryCut? = nil,
    beforeRecordID: String? = nil,
    beforeOrderSequence: Int? = nil,
    maximumRecords: Int = 50
  ) async throws -> ArkSemanticHistoryPage {
    guard !sessionID.isEmpty, (1...200).contains(maximumRecords),
          (beforeRecordID == nil) == (beforeOrderSequence == nil), beforeRecordID == nil || cut != nil else {
      throw ArkSemanticHistory.invalid("semantic request")
    }
    var request: [String: JSONValue] = ["sessionId": .string(sessionID), "view": .string("semantic"), "maxRecords": .number(Double(maximumRecords))]
    if let cut { request["sourceRevision"] = .string(cut.sourceRevision) }
    if let beforeRecordID { request["beforeRecordId"] = .string(beforeRecordID) }
    let value = try await remoteDomainRequest(method: "session/history", request: request)
    try Task.checkCancellation()
    return try ArkSemanticHistory.page(from: value, expectedCut: cut, beforeRecordID: beforeRecordID, beforeOrderSequence: beforeOrderSequence, maximumRecords: maximumRecords)
  }

  public func semanticHistoryContent(sessionID: String, cut: ArkHistoryCut, recordID: String) async throws -> ArkSemanticHistoryContent {
    guard !sessionID.isEmpty else { throw ArkSemanticHistory.invalid("session identity") }
    return try await ArkSemanticHistory.readContent(cut: cut, recordID: recordID) { request in
      var request = request
      request["sessionId"] = .string(sessionID)
      return try await self.remoteDomainRequest(method: "session/history", request: request)
    }
  }
}

extension ArkSemanticHistoryContent {
  /// Build a read-only row without touching any live partial/finalized state.
  /// Keep descriptor.id as the surrounding row identity and this row's source id
  /// as its canonical locator. Prefix blocks never become a synthetic final event.
  public func message(for record: ArkSemanticHistoryRecord) throws -> ArkMessage? {
    switch self {
    case .user(let event), .assistant(let event):
      guard record.kind.rawValue == (event.type == "user/message" ? "user" : "assistant"),
            record.canonicalEventSequence == event.id else {
        throw ArkSemanticHistory.invalid("canonical record identity")
      }
      return ArkAPIClient.message(fromHistoryEvent: event)
    case .assistantPrefix(let turn, let step, let blocks):
      guard record.kind == .assistant, record.canonicalEventSequence == nil,
            record.turn == turn, record.step == step,
            record.state == .active || record.state == .failedPrefix || record.state == .orphanedPrefix
      else { throw ArkSemanticHistory.invalid("prefix record identity") }
      let value: JSONValue = .object(["content": .array(blocks)])
      return ArkMessage(
        id: record.orderSequence, role: .assistant,
        text: ArkAPIClient.textContent(in: value) ?? "",
        reasoning: ArkAPIClient.reasoningContent(in: value),
        attachmentIDs: ArkAPIClient.imageAttachmentIDs(in: value),
        turn: turn, step: step, interrupted: record.state != .active,
        blocks: ArkAPIClient.messageBlocks(in: value), time: record.time
      )
    default: throw ArkSemanticHistory.invalid("non-message record")
    }
  }
}
