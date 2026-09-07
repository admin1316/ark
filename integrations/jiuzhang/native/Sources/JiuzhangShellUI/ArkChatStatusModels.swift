import Foundation
import JiuzhangShellCore

/// Typed retry timing retained beside the durable status row. The view owns
/// only the local countdown anchor; identity and lifecycle remain event-owned.
public struct ArkChatRetryPresentation: Equatable, Sendable {
  public enum State: Equatable, Sendable {
    case scheduled
    case started
    case cancelled
  }

  public let id: String
  public let sequence: Int
  public let attempt: Int
  public let maximum: Int?
  public let delayMilliseconds: Double
  public let state: State

  public init(
    id: String,
    sequence: Int,
    attempt: Int,
    maximum: Int?,
    delayMilliseconds: Double,
    state: State
  ) {
    self.id = id
    self.sequence = sequence
    self.attempt = attempt
    self.maximum = maximum
    self.delayMilliseconds = delayMilliseconds
    self.state = state
  }
}

/// A non-message transcript row projected from durable lifecycle events.
public struct ArkChatStatus: Identifiable, Equatable, Sendable {
  public enum Kind: Equatable, Sendable {
    case retry
    case warning
    case error
    case stopped
    case command
    case compaction
    case context
  }

  public enum Phase: Equatable, Sendable {
    case neutral
    case running
    case succeeded
    case failed
    case stopped
  }

  public let id: String
  public let sequence: Int
  public let turn: Int?
  public let kind: Kind
  public let phase: Phase
  public let title: String
  public let detail: String?
  public let body: String?
  public let retry: ArkChatRetryPresentation?

  public init(
    id: String,
    sequence: Int,
    turn: Int? = nil,
    kind: Kind,
    phase: Phase = .neutral,
    title: String,
    detail: String?,
    body: String? = nil,
    retry: ArkChatRetryPresentation? = nil
  ) {
    self.id = id
    self.sequence = sequence
    self.turn = turn
    self.kind = kind
    self.phase = phase
    self.title = title
    self.detail = detail
    self.body = body
    self.retry = retry
  }
}

/// Resolves the session light from durable projections by global sequence.
/// Each projection can be replaced or replayed independently, so array tail
/// order is not a safe cross-projection freshness signal.
enum ArkSessionOutcomeResolver {
  static func latestIsFailure(
    _ outcomes: [(sequence: Int, failed: Bool)]
  ) -> Bool {
    outcomes.max { left, right in
      if left.sequence != right.sequence { return left.sequence < right.sequence }
      // When two projections describe the same durable sequence, retain the
      // failure signal instead of allowing source-array order to hide it.
      return !left.failed && right.failed
    }?.failed == true
  }
}

/// Native chat lifecycle projection. Pairing is identity-based rather than
/// adjacency-based: context may be injected between run/done and compaction
/// events, and paged history can begin with only the closing evidence.
public struct ArkChatStatusProjection: Sendable {
  private struct CompactionRecord: Sendable {
    var sourceCommandID: String?
    var turn: Int?
    var summary: String?
    var shadowedItemCount: Int?
    var shadowedTokenCount: Int?
    var checkpointSequence: Int?
    var error: String?
  }

  private var rows: [String: ArkChatStatus] = [:]
  private var compactions: [String: CompactionRecord] = [:]
  private var commandToCompaction: [String: String] = [:]
  private var retryRowsByTurn: [Int: Set<String>] = [:]
  /// Current durable turn while folding an ordered history/live stream. Some
  /// lifecycle events intentionally omit a repeated turn field; they still
  /// belong to the open turn and must not escape its completed-process card.
  private var activeTurn: Int?
  /// Command ids whose run/done pairs must not render as timeline rows. The
  /// audit events stay in the session log; only the card is suppressed, so a
  /// switch that goes through a host command cannot change the chat's content
  /// height or trigger scroll repositioning.
  private var suppressedCommandIDs: Set<String> = []
  /// The locale the projection bakes into status copy. The model rebuilds
  /// the projection on language switches so existing rows relocalize.
  private let language: ArkLanguagePreference

  public init(
    events: [ArkHistoryEvent] = [],
    language: ArkLanguagePreference = .zh
  ) {
    self.language = language
    reset(events: events)
  }

  public var statuses: [ArkChatStatus] {
    rows.values.sorted {
      $0.sequence == $1.sequence ? $0.id < $1.id : $0.sequence < $1.sequence
    }
  }

  public mutating func reset(events: [ArkHistoryEvent]) {
    rows = [:]
    compactions = [:]
    commandToCompaction = [:]
    retryRowsByTurn = [:]
    activeTurn = nil
    suppressedCommandIDs = []
    for event in events.sorted(by: { $0.id < $1.id }) { append(event) }
  }

  public mutating func append(_ event: ArkHistoryEvent) {
    switch event.type {
    case "turn/start":
      activeTurn = event.data["turn"]?.numberValue.map(Int.init)
    case "command/run":
      appendCommandRun(event)
    case "command/done":
      appendCommandDone(event)
    case "compaction/start":
      updateCompaction(event, stage: .start)
    case "compaction/summary":
      updateCompaction(event, stage: .summary)
    case "compaction/end":
      updateCompaction(event, stage: .end)
    case "user/message":
      appendCompactionCheckpoint(event)
    case "request/context":
      appendRequestContext(event)
    case "llm/retry", "llm/retry-started":
      appendRetry(event)
    case "turn/end":
      appendTurnEnd(event)
      if event.data["turn"]?.numberValue.map(Int.init) == activeTurn {
        activeTurn = nil
      }
    default:
      break
    }
  }

  private mutating func appendCommandRun(_ event: ArkHistoryEvent) {
    guard let commandID = event.data["commandId"]?.stringValue, !commandID.isEmpty else {
      return
    }
    let name = event.data["name"]?.stringValue ?? ArkL10n.text(.statusCommandFallback, language)
    // Permission switches ride the Host-owned /permission command: the audit
    // events belong to the session log, not to the rendered transcript.
    if name == "permission" {
      suppressedCommandIDs.insert(commandID)
      return
    }
    let args = event.data["args"]?.stringValue?
      .trimmingCharacters(in: .whitespacesAndNewlines)
    rows["command-\(commandID)"] = ArkChatStatus(
      id: "command-\(commandID)",
      sequence: event.id,
      turn: turn(for: event),
      kind: .command,
      phase: .running,
      title: name,
      detail: args?.isEmpty == false ? args : ArkL10n.text(.statusCommandRunning, language)
    )
  }

  private mutating func appendCommandDone(_ event: ArkHistoryEvent) {
    guard let commandID = event.data["commandId"]?.stringValue, !commandID.isEmpty else {
      return
    }
    if suppressedCommandIDs.contains(commandID) { return }
    if let compactionID = commandToCompaction[commandID],
      compactions[compactionID]?.checkpointSequence != nil
    {
      emitCompaction(compactionID)
      return
    }

    let rowID = "command-\(commandID)"
    let previous = rows[rowID]
    let succeeded = event.data["kind"]?.stringValue == "success"
    let text = event.data["text"]?.stringValue
    let lines =
      text?.split(separator: "\n", omittingEmptySubsequences: false).map(String.init) ?? []
    let firstLine = lines.first?.trimmingCharacters(in: .whitespacesAndNewlines)
    let body = lines.count > 1 ? text : nil
    rows[rowID] = ArkChatStatus(
      id: rowID,
      sequence: previous?.sequence ?? event.id,
      turn: previous?.turn ?? turn(for: event),
      kind: .command,
      phase: succeeded ? .succeeded : .failed,
      title: previous?.title ?? ArkL10n.text(.statusCommandFallback, language),
      detail: firstLine?.isEmpty == false
        ? firstLine
        : (succeeded
          ? ArkL10n.text(.statusCommandDone, language)
          : ArkL10n.text(.statusCommandFailed, language)),
      body: body
    )
  }

  private enum CompactionStage { case start, summary, end }

  private mutating func updateCompaction(
    _ event: ArkHistoryEvent,
    stage: CompactionStage
  ) {
    guard let compactionID = event.data["compactionId"]?.stringValue,
      !compactionID.isEmpty
    else { return }
    var record = compactions[compactionID] ?? CompactionRecord()
    if let sourceCommandID = event.data["sourceCommandId"]?.stringValue {
      record.sourceCommandID = sourceCommandID
      commandToCompaction[sourceCommandID] = compactionID
    }
    switch stage {
    case .start:
      break
    case .summary:
      record.summary = Self.contentText(event.data["summary"])
      if let seqs = event.data["shadowedSeqs"]?.arrayValue {
        record.shadowedItemCount = seqs.count
      }
      record.shadowedTokenCount = event.data["shadowedTokenCount"]?.numberValue.map(Int.init)
    case .end:
      record.error = event.data["error"]?.stringValue
    }
    compactions[compactionID] = record
    if record.checkpointSequence != nil { emitCompaction(compactionID) }
  }

  private mutating func appendCompactionCheckpoint(_ event: ArkHistoryEvent) {
    let message = event.data["message"] ?? event.data
    guard let source = message["source"],
      source["kind"]?.stringValue == "plugin",
      source["plugin"]?.stringValue == "compact",
      let compactionID = source["compactionId"]?.stringValue,
      !compactionID.isEmpty
    else { return }

    var record = compactions[compactionID] ?? CompactionRecord()
    if let sourceCommandID = source["sourceCommandId"]?.stringValue {
      record.sourceCommandID = sourceCommandID
      commandToCompaction[sourceCommandID] = compactionID
    }
    // The model-facing checkpoint is the only authoritative presentation
    // coordinate. Do not inherit the preceding compaction/start turn: an
    // automatic checkpoint commonly sits between completed turns.
    record.turn = event.data["turn"]?.numberValue.map(Int.init)
      ?? message["turn"]?.numberValue.map(Int.init)
    record.checkpointSequence = event.id
    compactions[compactionID] = record
    emitCompaction(compactionID)
  }

  private mutating func emitCompaction(_ compactionID: String) {
    guard let record = compactions[compactionID],
      let sequence = record.checkpointSequence
    else { return }
    let rowID =
      record.sourceCommandID.map { "command-\($0)" }
      ?? "compaction-\(compactionID)"
    let detail: String
    if let items = record.shadowedItemCount, let tokens = record.shadowedTokenCount {
      detail = ArkL10n.format(
        .statusCompactionDetail, language, arguments: ["\(items)", "\(tokens)"])
    } else if record.summary != nil {
      detail = ArkL10n.text(.statusCompactionExpandSummary, language)
    } else {
      detail = ArkL10n.text(.statusCompactionSummaryMissing, language)
    }
    rows[rowID] = ArkChatStatus(
      id: rowID,
      sequence: sequence,
      turn: record.turn,
      kind: .compaction,
      phase: record.error == nil ? .succeeded : .failed,
      title: record.sourceCommandID == nil
        ? ArkL10n.text(.statusCompactionTitle, language)
        : "compact",
      detail: record.error ?? detail,
      body: record.summary
    )
  }

  private mutating func appendRequestContext(_ event: ArkHistoryEvent) {
    let provider = event.data["provider"]?.stringValue ?? "provider"
    let model = event.data["model"]?.stringValue ?? "model"
    let capacity =
      event.data["contextWindow"]?.numberValue.map {
        ArkL10n.format(.statusContextTokens, language, arguments: ["\(Int($0))"])
      } ?? ""
    rows["request-context-\(event.id)"] = ArkChatStatus(
      id: "request-context-\(event.id)",
      sequence: event.id,
      turn: turn(for: event),
      kind: .context,
      title: ArkL10n.text(.statusRequestContextTitle, language),
      detail: "\(provider) · \(model)\(capacity)",
      body: Self.pretty(event.data)
    )
  }

  private mutating func appendRetry(_ event: ArkHistoryEvent) {
    let turn = turn(for: event)
    guard let retryID = event.data["retryId"]?.stringValue, !retryID.isEmpty else { return }
    let retry = Int(event.data["retry"]?.numberValue ?? 0)
    let rowID = "retry-\(retryID)"
    if let turn { retryRowsByTurn[turn, default: []].insert(rowID) }
    if event.type == "llm/retry-started" {
      guard let previous = rows[rowID] else { return }
      let timing = previous.retry.map {
        ArkChatRetryPresentation(
          id: $0.id,
          sequence: $0.sequence,
          attempt: $0.attempt,
          maximum: $0.maximum,
          delayMilliseconds: $0.delayMilliseconds,
          state: .started
        )
      }
      rows[rowID] = ArkChatStatus(
        id: previous.id,
        sequence: previous.sequence,
        turn: previous.turn,
        kind: .retry,
        phase: .running,
        title: ArkL10n.format(
          .statusRetryInProgress, language, arguments: ["\(retry)"]),
        detail: previous.detail,
        body: previous.body,
        retry: timing
      )
      return
    }

    let maximum = Int(event.data["maxRetries"]?.numberValue ?? 0)
    let delay = event.data["delayMs"]?.numberValue ?? 0
    let message = event.data["failure"]?["message"]?.stringValue
    let suffix = maximum > 0
      ? ArkL10n.format(
        .statusRetryAttemptOfMax, language, arguments: ["\(retry)", "\(maximum)"])
      : ArkL10n.format(.statusRetryAttempt, language, arguments: ["\(retry)"])
    let previous = rows[rowID]
    let timing = ArkChatRetryPresentation(
      id: retryID,
      sequence: event.id,
      attempt: retry,
      maximum: maximum > 0 ? maximum : nil,
      delayMilliseconds: delay,
      state: .scheduled
    )
    rows[rowID] = ArkChatStatus(
      id: rowID,
      sequence: previous?.sequence ?? event.id,
      turn: turn,
      kind: .retry,
      phase: .running,
      title: delay > 0
        ? ArkL10n.format(
          .statusRetryAfterDelay, language, arguments: [formatDelay(delay), suffix])
        : ArkL10n.format(.statusRetryNow, language, arguments: [suffix]),
      detail: message,
      retry: timing
    )
  }

  private mutating func appendTurnEnd(_ event: ArkHistoryEvent) {
    guard let turn = event.data["turn"]?.numberValue.map(Int.init) else { return }
    let reason = event.data["reason"]
    let kind = reason?["kind"]?.stringValue ?? "turn-ended"
    for rowID in rows.keys.sorted() {
      guard let row = rows[rowID],
            row.kind == .command,
            row.phase == .running,
            row.turn == turn
      else { continue }
      rows[rowID] = ArkChatStatus(
        id: row.id,
        sequence: row.sequence,
        turn: row.turn ?? turn,
        kind: .command,
        phase: .stopped,
        title: row.title,
        detail: ArkL10n.text(.statusCommandStopped, language),
        body: row.body
      )
    }
    for retryRowID in (retryRowsByTurn[turn] ?? []).sorted() {
      guard let retry = rows[retryRowID] else { continue }
      let phase: ArkChatStatus.Phase
      let title: String
      switch kind {
      case "completed":
        phase = .succeeded
        title = ArkL10n.text(.statusRetryDone, language)
      case "error":
        phase = .failed
        title = ArkL10n.text(.statusRetryFailed, language)
      default:
        phase = .stopped
        title = ArkL10n.text(.statusRetryCancelled, language)
      }
      rows[retryRowID] = ArkChatStatus(
        id: retry.id,
        sequence: retry.sequence,
        turn: retry.turn,
        kind: .retry,
        phase: phase,
        title: title,
        detail: retry.detail,
        body: retry.body,
        retry: retry.retry.map {
          ArkChatRetryPresentation(
            id: $0.id,
            sequence: $0.sequence,
            attempt: $0.attempt,
            maximum: $0.maximum,
            delayMilliseconds: $0.delayMilliseconds,
            state: kind == "completed" || kind == "error" ? .started : .cancelled
          )
        }
      )
    }
    if kind == "completed" { return }
    let status: ArkChatStatus
    switch kind {
    case "error":
      let failure = reason?["error"] ?? reason ?? .object([:])
      let message = displayFailureMessage(failure)
      let code = failure["code"]?.stringValue
      let detail = [message, code].compactMap { value in
        value?.isEmpty == false ? value : nil
      }.joined(separator: " · ")
      status = ArkChatStatus(
        id: "turn-\(turn)-error",
        sequence: event.id,
        turn: turn,
        kind: .error,
        phase: .failed,
        title: ArkL10n.text(.statusReplyFailed, language),
        detail: detail.isEmpty ? nil : detail
      )
    case "max-tokens":
      status = ArkChatStatus(
        id: "turn-\(turn)-max-tokens",
        sequence: event.id,
        turn: turn,
        kind: .warning,
        phase: .stopped,
        title: ArkL10n.text(.statusMaxTokensTitle, language),
        detail: ArkL10n.text(.statusMaxTokensDetail, language)
      )
    case "aborted":
      status = ArkChatStatus(
        id: "turn-\(turn)-aborted",
        sequence: event.id,
        turn: turn,
        kind: .stopped,
        phase: .stopped,
        title: ArkL10n.text(.statusReplyStopped, language),
        detail: nil
      )
    case "blocked":
      status = ArkChatStatus(
        id: "turn-\(turn)-blocked",
        sequence: event.id,
        turn: turn,
        kind: .warning,
        phase: .failed,
        title: ArkL10n.text(.statusBlocked, language),
        detail: nil
      )
    case "interrupted":
      status = ArkChatStatus(
        id: "turn-\(turn)-interrupted",
        sequence: event.id,
        turn: turn,
        kind: .warning,
        phase: .stopped,
        title: ArkL10n.text(.statusInterrupted, language),
        detail: nil
      )
    default:
      return
    }
    rows[status.id] = status
  }

  private func formatDelay(_ milliseconds: Double) -> String {
    if milliseconds < 1_000 { return "\(Int(milliseconds))ms" }
    return String(format: "%.1fs", milliseconds / 1_000)
  }

  private func turn(for event: ArkHistoryEvent) -> Int? {
    event.data["turn"]?.numberValue.map(Int.init) ?? activeTurn
  }

  private static func contentText(_ value: JSONValue?) -> String? {
    guard let value else { return nil }
    if let text = value.stringValue { return text }
    if let values = value.arrayValue {
      let text = values.compactMap { item -> String? in
        if item["type"]?.stringValue == "text" { return item["text"]?.stringValue }
        return contentText(item)
      }.joined()
      return text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : text
    }
    if let text = value["text"]?.stringValue { return text }
    return nil
  }

  private static func pretty(_ value: JSONValue) -> String {
    guard let data = try? JSONEncoder.chatStatus.encode(value),
      let text = String(data: data, encoding: .utf8)
    else { return String(describing: value) }
    return text
  }

  /// GUI-safe failure copy. AUTH diagnostics are provider-authored and may
  /// echo masked or partially retained credential fragments, so only their
  /// durable status/code may cross into the transcript.
  private func displayFailureMessage(_ failure: JSONValue) -> String? {
    if failure["code"]?.stringValue == "AUTH" {
      if let status = failure["status"]?.numberValue.map(Int.init),
        status == 401 || status == 403
      {
        return ArkL10n.format(
          .statusAuthRejectedHTTP, language, arguments: ["\(status)"])
      }
      return ArkL10n.text(.statusAuthRejected, language)
    }
    return failure["message"]?.stringValue
      ?? (failure.stringValue ?? Self.pretty(failure))
  }
}

extension JSONEncoder {
  fileprivate static var chatStatus: JSONEncoder {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    return encoder
  }
}
