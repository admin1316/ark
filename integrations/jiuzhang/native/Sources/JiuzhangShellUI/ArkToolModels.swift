import Foundation
import JiuzhangShellCore

/// Durable execution state. Every transition is folded from an explicit
/// history event; presentation code never guesses state from assistant text.
public enum ArkExecutionPhase: String, Equatable, Sendable {
  case running
  case succeeded
  case failed
  case cancelled
}

/// One durable nested execution step. Code-mode sub-dispatches and workflow
/// members share this compact representation while retaining their typed
/// identity and timestamps.
public struct ArkExecutionStep: Identifiable, Equatable, Sendable {
  public let id: String
  public let parentCallID: String?
  public let name: String
  public let label: String?
  public let phaseLabel: String?
  public let childSessionID: String?
  public let startedAt: Date
  public let finishedAt: Date?
  public let phase: ArkExecutionPhase
  public let output: String?

  public init(
    id: String,
    parentCallID: String? = nil,
    name: String,
    label: String? = nil,
    phaseLabel: String? = nil,
    childSessionID: String? = nil,
    startedAt: Date,
    finishedAt: Date? = nil,
    phase: ArkExecutionPhase = .running,
    output: String? = nil
  ) {
    self.id = id
    self.parentCallID = parentCallID
    self.name = name
    self.label = label
    self.phaseLabel = phaseLabel
    self.childSessionID = childSessionID
    self.startedAt = startedAt
    self.finishedAt = finishedAt
    self.phase = phase
    self.output = output
  }

  public func duration(at now: Date = Date()) -> TimeInterval {
    max(0, (finishedAt ?? now).timeIntervalSince(startedAt))
  }
}

/// The durable execution envelope rendered inside a native chat tool row.
public struct ArkExecutionActivity: Equatable, Sendable {
  public let startedAt: Date?
  public let finishedAt: Date?
  public let phase: ArkExecutionPhase
  public let stopReason: String?
  public let steps: [ArkExecutionStep]

  public init(
    startedAt: Date?,
    finishedAt: Date? = nil,
    phase: ArkExecutionPhase = .running,
    stopReason: String? = nil,
    steps: [ArkExecutionStep] = []
  ) {
    self.startedAt = startedAt
    self.finishedAt = finishedAt
    self.phase = phase
    self.stopReason = stopReason
    self.steps = steps
  }

  public var completedStepCount: Int {
    steps.filter { $0.phase != .running }.count
  }

  public var failedStepCount: Int {
    steps.filter { $0.phase == .failed }.count
  }

  public func duration(at now: Date = Date()) -> TimeInterval? {
    startedAt.map { max(0, (finishedAt ?? now).timeIntervalSince($0)) }
  }
}

/// One durable workflow phase in first-seen order. Members retain their
/// child-session identities so the native surface can navigate without
/// inventing a second workflow store.
public struct ArkWorkflowPhaseGroup: Identifiable, Equatable, Sendable {
  public let id: String
  public let title: String?
  public let members: [ArkExecutionStep]
}

/// Semantic native projection of one `tool-workflow/*` event sequence.
public struct ArkWorkflowRunPresentation: Equatable, Sendable {
  public let id: String
  public let name: String
  public let execution: ArkExecutionActivity
  public let phases: [ArkWorkflowPhaseGroup]

  public init?(activity: ArkToolActivity) {
    guard
      activity.id.hasPrefix("workflow:"),
      let execution = activity.execution
    else { return nil }

    var phaseOrder: [String] = []
    var membersByPhase: [String: [ArkExecutionStep]] = [:]
    for member in execution.steps {
      let title = member.phaseLabel?.trimmingCharacters(in: .whitespacesAndNewlines)
      let key = title?.isEmpty == false ? (title ?? "") : ""
      if membersByPhase[key] == nil { phaseOrder.append(key) }
      membersByPhase[key, default: []].append(member)
    }

    id = String(activity.id.dropFirst("workflow:".count))
    name = activity.name
    self.execution = execution
    phases = phaseOrder.map { key in
      ArkWorkflowPhaseGroup(
        id: key.isEmpty ? "unassigned" : key,
        title: key.isEmpty ? nil : key,
        members: membersByPhase[key] ?? []
      )
    }
  }

  public var memberCount: Int { phases.reduce(0) { $0 + $1.members.count } }
}

/// One native tool row, folded from durable tool/execution events.
public struct ArkToolActivity: Identifiable, Equatable, Sendable {
  public let id: String
  public let sequence: Int
  public let name: String
  public let turn: Int?
  public let step: Int?
  public let arguments: String
  public let result: String?
  public let isError: Bool
  public let isInterrupted: Bool
  public let rawCall: JSONValue
  public let rawResult: JSONValue?
  public let callPresentation: JSONValue?
  public let resultPresentation: JSONValue?
  public let execution: ArkExecutionActivity?

  public init(
    id: String,
    sequence: Int,
    name: String,
    turn: Int? = nil,
    step: Int? = nil,
    arguments: String,
    result: String? = nil,
    isError: Bool = false,
    isInterrupted: Bool = false,
    rawCall: JSONValue,
    rawResult: JSONValue? = nil,
    callPresentation: JSONValue? = nil,
    resultPresentation: JSONValue? = nil,
    execution: ArkExecutionActivity? = nil
  ) {
    self.id = id
    self.sequence = sequence
    self.name = name
    self.turn = turn
    self.step = step
    self.arguments = arguments
    self.result = result
    self.isError = isError
    self.isInterrupted = isInterrupted
    self.rawCall = rawCall
    self.rawResult = rawResult
    self.callPresentation = callPresentation
    self.resultPresentation = resultPresentation
    self.execution = execution
  }
}

/// Incremental durable execution folder. Resetting from persisted history and
/// appending the same events live produce the same stable rows.
public struct ArkToolProjection: Sendable {
  private var rows: [ArkToolActivity] = []
  private var indexByCallID: [String: Int] = [:]
  private var indexByWorkflowID: [String: Int] = [:]
  private var activeTurn: Int?

  public init(events: [ArkHistoryEvent] = []) {
    reset(events: events)
  }

  public var activities: [ArkToolActivity] { rows }

  public mutating func reset(events: [ArkHistoryEvent]) {
    rows = []
    indexByCallID = [:]
    indexByWorkflowID = [:]
    activeTurn = nil
    for event in events.sorted(by: { $0.id < $1.id }) { append(event) }
  }

  public mutating func append(_ event: ArkHistoryEvent) {
    switch event.type {
    case "turn/start": activeTurn = event.data["turn"]?.numberValue.map(Int.init)
    case "tool/call": appendToolCall(event)
    case "tool/result": appendToolResult(event)
    case "tool/code-dispatch-start": appendCodeDispatch(event, settled: false)
    case "tool/code-dispatch": appendCodeDispatch(event, settled: true)
    case "tool-workflow/run-start": appendWorkflowStart(event)
    case "tool-workflow/agent-start": appendWorkflowMemberStart(event)
    case "tool-workflow/agent-end": appendWorkflowMemberEnd(event)
    case "tool-workflow/run-end": appendWorkflowEnd(event)
    case "turn/end":
      let terminalTurn = event.data["turn"]?.numberValue.map(Int.init) ?? activeTurn
      appendTurnEnd(event, turn: terminalTurn)
      if terminalTurn == activeTurn { activeTurn = nil }
    default: break
    }
  }

  private mutating func appendToolCall(_ event: ArkHistoryEvent) {
    guard let callID = event.data["callId"]?.stringValue, !callID.isEmpty else { return }
    let existing = indexByCallID[callID].flatMap { rows.indices.contains($0) ? rows[$0] : nil }
    let row = ArkToolActivity(
      id: callID,
      sequence: event.id,
      name: event.data["name"]?.stringValue ?? "tool",
      turn: event.data["turn"]?.numberValue.map(Int.init) ?? existing?.turn ?? activeTurn,
      step: event.data["step"]?.numberValue.map(Int.init) ?? existing?.step,
      arguments: event.data["arguments"]?.stringValue ?? pretty(event.data["arguments"]),
      result: existing?.result,
      isError: existing?.isError ?? false,
      isInterrupted: existing?.isInterrupted ?? false,
      rawCall: event.data,
      rawResult: existing?.rawResult,
      callPresentation: presentation(in: event, expected: "call"),
      resultPresentation: existing?.resultPresentation,
      execution: existing?.execution ?? ArkExecutionActivity(startedAt: event.time)
    )
    upsert(row, callID: callID)
    backfillWorkflowOwner(callID: callID, owner: row)
  }

  private mutating func appendToolResult(_ event: ArkHistoryEvent) {
    guard
      let callID = event.data["message"]?["source"]?["callId"]?.stringValue
        ?? event.data["callId"]?.stringValue,
      !callID.isEmpty
    else { return }
    let result = text(in: event.data) ?? pretty(event.data)
    let interrupted = event.data["error"]?["code"]?.stringValue == "interrupted"
    let isError =
      !interrupted
      && (event.data["message"]?["content"]?.arrayValue?.first?["isError"]?.boolValue == true
        || event.data["isError"]?.boolValue == true
        || event.data["error"] != nil)
    let resultPresentation = presentation(in: event, expected: "result")
    let phase = resultPhase(
      interrupted: interrupted,
      isError: isError,
      resultPresentation: resultPresentation
    )
    if let index = indexByCallID[callID], rows.indices.contains(index) {
      let call = rows[index]
      let execution = ArkExecutionActivity(
        startedAt: call.execution?.startedAt,
        finishedAt: event.time,
        phase: phase,
        stopReason: interrupted ? "interrupted" : nil,
        steps: interrupted
          ? settlingRunningSteps(
            call.execution?.steps ?? [],
            at: event.time,
            as: .cancelled
          )
          : call.execution?.steps ?? []
      )
      rows[index] = ArkToolActivity(
        id: call.id,
        sequence: call.sequence,
        name: call.name,
        turn: call.turn,
        step: call.step,
        arguments: call.arguments,
        result: result,
        isError: isError,
        isInterrupted: interrupted,
        rawCall: call.rawCall,
        rawResult: event.data,
        callPresentation: call.callPresentation,
        resultPresentation: resultPresentation,
        execution: execution
      )
    } else {
      indexByCallID[callID] = rows.count
      rows.append(
        ArkToolActivity(
          id: callID,
          sequence: event.id,
          name: "tool",
          turn: event.data["turn"]?.numberValue.map(Int.init),
          step: event.data["step"]?.numberValue.map(Int.init),
          arguments: "",
          result: result,
          isError: isError,
          isInterrupted: interrupted,
          rawCall: .object([:]),
          rawResult: event.data,
          resultPresentation: resultPresentation,
          execution: ArkExecutionActivity(
            startedAt: nil,
            finishedAt: event.time,
            phase: phase,
            stopReason: interrupted ? "interrupted" : nil
          )
        ))
    }
  }

  private mutating func appendCodeDispatch(_ event: ArkHistoryEvent, settled: Bool) {
    guard
      let rootCallID = event.data["rootCallId"]?.stringValue,
      let parentCallID = event.data["parentCallId"]?.stringValue,
      let subCallID = event.data["subCallId"]?.stringValue,
      !rootCallID.isEmpty,
      !parentCallID.isEmpty,
      !subCallID.isEmpty
    else { return }
    let index = ensureRootCall(rootCallID, event: event)
    guard rows.indices.contains(index) else { return }
    let call = rows[index]
    let previousExecution = call.execution ?? ArkExecutionActivity(startedAt: event.time)
    var steps = previousExecution.steps
    let existingIndex = steps.firstIndex { $0.id == subCallID }
    let previous = existingIndex.map { steps[$0] }
    let isError = settled && event.data["isError"]?.boolValue == true
    let output = settled ? text(in: event.data["content"] ?? .array([])) : nil
    let next = ArkExecutionStep(
      id: subCallID,
      parentCallID: previous?.parentCallID ?? parentCallID,
      name: previous?.name ?? event.data["name"]?.stringValue ?? "tool",
      startedAt: previous?.startedAt ?? event.time,
      finishedAt: settled ? event.time : nil,
      phase: settled ? (isError ? .failed : .succeeded) : .running,
      output: output ?? previous?.output
    )
    if let existingIndex { steps[existingIndex] = next } else { steps.append(next) }
    rows[index] = copying(
      call,
      execution: ArkExecutionActivity(
        startedAt: previousExecution.startedAt,
        finishedAt: previousExecution.finishedAt,
        phase: previousExecution.phase,
        stopReason: previousExecution.stopReason,
        steps: steps
      )
    )
  }

  private mutating func appendWorkflowStart(_ event: ArkHistoryEvent) {
    guard let runID = event.data["runId"]?.stringValue, !runID.isEmpty else { return }
    let rootCallID = event.data["rootCallId"]?.stringValue
    let name = event.data["name"]?.stringValue ?? "Workflow"
    let owner = rootCallID.flatMap { callID in
      indexByCallID[callID].flatMap { rows.indices.contains($0) ? rows[$0] : nil }
    }
    let row = ArkToolActivity(
      id: "workflow:\(runID)",
      sequence: event.id,
      name: name,
      turn: owner?.turn ?? activeTurn,
      step: owner?.step,
      arguments: "",
      rawCall: event.data,
      callPresentation: genericPresentation(title: name, kind: "workflow"),
      execution: ArkExecutionActivity(startedAt: event.time)
    )
    if let index = indexByWorkflowID[runID], rows.indices.contains(index) {
      rows[index] = row
    } else {
      indexByWorkflowID[runID] = rows.count
      rows.append(row)
    }
  }

  private mutating func appendWorkflowMemberStart(_ event: ArkHistoryEvent) {
    guard
      let runID = event.data["runId"]?.stringValue,
      let memberSequence = event.data["seq"]?.numberValue.map(Int.init)
    else { return }
    let index = ensureWorkflow(runID, event: event)
    guard rows.indices.contains(index) else { return }
    let row = rows[index]
    let previousExecution = row.execution ?? ArkExecutionActivity(startedAt: event.time)
    var steps = previousExecution.steps
    let stepID = "\(runID):\(memberSequence)"
    let member = ArkExecutionStep(
      id: stepID,
      name: event.data["label"]?.stringValue ?? "Agent \(memberSequence)",
      label: event.data["label"]?.stringValue,
      phaseLabel: event.data["phase"]?.stringValue,
      childSessionID: event.data["childId"]?.stringValue,
      startedAt: event.time
    )
    if let at = steps.firstIndex(where: { $0.id == stepID }) { steps[at] = member }
    else { steps.append(member) }
    rows[index] = copying(
      row,
      execution: ArkExecutionActivity(
        startedAt: previousExecution.startedAt,
        finishedAt: previousExecution.finishedAt,
        phase: previousExecution.phase,
        stopReason: previousExecution.stopReason,
        steps: steps
      )
    )
  }

  private mutating func appendWorkflowMemberEnd(_ event: ArkHistoryEvent) {
    guard
      let runID = event.data["runId"]?.stringValue,
      let memberSequence = event.data["seq"]?.numberValue.map(Int.init)
    else { return }
    let index = ensureWorkflow(runID, event: event)
    guard rows.indices.contains(index) else { return }
    let row = rows[index]
    let previousExecution = row.execution ?? ArkExecutionActivity(startedAt: event.time)
    var steps = previousExecution.steps
    let stepID = "\(runID):\(memberSequence)"
    let outcome = event.data["outcome"]?.stringValue
    let phase: ArkExecutionPhase = switch outcome {
    case "completed": .succeeded
    case "cancelled": .cancelled
    default: .failed
    }
    if let at = steps.firstIndex(where: { $0.id == stepID }) {
      let previous = steps[at]
      steps[at] = ArkExecutionStep(
        id: previous.id,
        name: previous.name,
        label: previous.label,
        phaseLabel: previous.phaseLabel,
        childSessionID: previous.childSessionID,
        startedAt: previous.startedAt,
        finishedAt: event.time,
        phase: phase,
        output: previous.output
      )
    } else {
      steps.append(ArkExecutionStep(
        id: stepID,
        name: "Agent \(memberSequence)",
        startedAt: event.time,
        finishedAt: event.time,
        phase: phase
      ))
    }
    rows[index] = copying(
      row,
      execution: ArkExecutionActivity(
        startedAt: previousExecution.startedAt,
        finishedAt: previousExecution.finishedAt,
        phase: previousExecution.phase,
        stopReason: previousExecution.stopReason,
        steps: steps
      )
    )
  }

  private mutating func appendWorkflowEnd(_ event: ArkHistoryEvent) {
    guard let runID = event.data["runId"]?.stringValue else { return }
    let index = ensureWorkflow(runID, event: event)
    guard rows.indices.contains(index) else { return }
    let row = rows[index]
    let stopReason = event.data["stopReason"]?.stringValue ?? "error"
    let phase: ArkExecutionPhase = switch stopReason {
    case "completed": .succeeded
    case "cancelled": .cancelled
    default: .failed
    }
    let execution = ArkExecutionActivity(
      startedAt: row.execution?.startedAt,
      finishedAt: event.time,
      phase: phase,
      stopReason: stopReason,
      steps: row.execution?.steps ?? []
    )
    rows[index] = ArkToolActivity(
      id: row.id,
      sequence: row.sequence,
      name: row.name,
      turn: row.turn,
      step: row.step,
      arguments: row.arguments,
      result: stopReason,
      isError: phase == .failed,
      isInterrupted: phase == .cancelled,
      rawCall: row.rawCall,
      rawResult: event.data,
      callPresentation: row.callPresentation,
      resultPresentation: row.resultPresentation,
      execution: execution
    )
  }

  private mutating func appendTurnEnd(_ event: ArkHistoryEvent, turn: Int?) {
    let reason = event.data["reason"]?["kind"]?.stringValue ?? "turn-ended"
    for index in rows.indices {
      let call = rows[index]
      guard call.sequence < event.id,
            call.result == nil,
            call.execution?.phase == .running
      else { continue }
      let ownsTerminal = if let turn {
        call.turn == turn || (call.turn == nil && call.id.hasPrefix("workflow:"))
      } else {
        call.turn == nil
      }
      guard ownsTerminal else { continue }
      let failed = reason == "error" || reason == "failed" || reason == "blocked"
      let phase: ArkExecutionPhase = failed ? .failed : .cancelled
      let interrupted = !failed && reason != "completed"
      rows[index] = ArkToolActivity(
        id: call.id,
        sequence: call.sequence,
        name: call.name,
        turn: call.turn,
        step: call.step,
        arguments: call.arguments,
        result: nil,
        isError: failed,
        isInterrupted: interrupted,
        rawCall: call.rawCall,
        rawResult: call.rawResult,
        callPresentation: call.callPresentation,
        resultPresentation: call.resultPresentation,
        execution: ArkExecutionActivity(
          startedAt: call.execution?.startedAt,
          finishedAt: event.time,
          phase: phase,
          stopReason: reason == "completed" ? "missing-result-at-turn-end" : reason,
          steps: settlingRunningSteps(
            call.execution?.steps ?? [],
            at: event.time,
            as: phase
          )
        )
      )
    }
  }

  private mutating func upsert(_ row: ArkToolActivity, callID: String) {
    if let index = indexByCallID[callID], rows.indices.contains(index) {
      rows[index] = row
    } else {
      indexByCallID[callID] = rows.count
      rows.append(row)
    }
  }

  private mutating func ensureRootCall(_ callID: String, event: ArkHistoryEvent) -> Int {
    if let index = indexByCallID[callID], rows.indices.contains(index) { return index }
    let row = ArkToolActivity(
      id: callID,
      sequence: event.id,
      name: "run_code",
      turn: activeTurn,
      arguments: "",
      rawCall: .object(["callId": .string(callID)]),
      callPresentation: genericPresentation(title: "run_code", kind: "execute"),
      execution: ArkExecutionActivity(startedAt: event.time)
    )
    indexByCallID[callID] = rows.count
    rows.append(row)
    return rows.count - 1
  }

  private mutating func ensureWorkflow(_ runID: String, event: ArkHistoryEvent) -> Int {
    if let index = indexByWorkflowID[runID], rows.indices.contains(index) { return index }
    let row = ArkToolActivity(
      id: "workflow:\(runID)",
      sequence: event.id,
      name: "Workflow",
      turn: activeTurn,
      arguments: "",
      rawCall: .object(["runId": .string(runID)]),
      callPresentation: genericPresentation(title: "Workflow", kind: "workflow"),
      execution: ArkExecutionActivity(startedAt: event.time)
    )
    indexByWorkflowID[runID] = rows.count
    rows.append(row)
    return rows.count - 1
  }

  private mutating func backfillWorkflowOwner(callID: String, owner: ArkToolActivity) {
    for index in rows.indices {
      let workflow = rows[index]
      guard workflow.id.hasPrefix("workflow:"),
            workflow.rawCall["rootCallId"]?.stringValue == callID,
            (workflow.turn == nil || workflow.step == nil)
      else { continue }
      rows[index] = ArkToolActivity(
        id: workflow.id,
        sequence: workflow.sequence,
        name: workflow.name,
        turn: workflow.turn ?? owner.turn,
        step: workflow.step ?? owner.step,
        arguments: workflow.arguments,
        result: workflow.result,
        isError: workflow.isError,
        isInterrupted: workflow.isInterrupted,
        rawCall: workflow.rawCall,
        rawResult: workflow.rawResult,
        callPresentation: workflow.callPresentation,
        resultPresentation: workflow.resultPresentation,
        execution: workflow.execution
      )
    }
  }

  private func copying(
    _ row: ArkToolActivity,
    execution: ArkExecutionActivity
  ) -> ArkToolActivity {
    ArkToolActivity(
      id: row.id,
      sequence: row.sequence,
      name: row.name,
      turn: row.turn,
      step: row.step,
      arguments: row.arguments,
      result: row.result,
      isError: row.isError,
      isInterrupted: row.isInterrupted,
      rawCall: row.rawCall,
      rawResult: row.rawResult,
      callPresentation: row.callPresentation,
      resultPresentation: row.resultPresentation,
      execution: execution
    )
  }

  private func resultPhase(
    interrupted: Bool,
    isError: Bool,
    resultPresentation: JSONValue?
  ) -> ArkExecutionPhase {
    if interrupted { return .cancelled }
    if isError { return .failed }
    if case .terminal(let terminal) = ArkToolPresentation.decode(resultPresentation) {
      if terminal.signal != nil || terminal.exitCode.map({ $0 != 0 }) == true { return .failed }
    }
    return .succeeded
  }

  private func settlingRunningSteps(
    _ steps: [ArkExecutionStep],
    at finishedAt: Date,
    as phase: ArkExecutionPhase
  ) -> [ArkExecutionStep] {
    steps.map { step in
      guard step.phase == .running else { return step }
      return ArkExecutionStep(
        id: step.id,
        parentCallID: step.parentCallID,
        name: step.name,
        label: step.label,
        phaseLabel: step.phaseLabel,
        childSessionID: step.childSessionID,
        startedAt: step.startedAt,
        finishedAt: finishedAt,
        phase: phase,
        output: step.output
      )
    }
  }

  private func genericPresentation(title: String, kind: String) -> JSONValue {
    .object([
      "card": .string("generic"),
      "title": .string(title),
      "kind": .string(kind),
    ])
  }

  private func text(in value: JSONValue) -> String? {
    if let text = value["text"]?.stringValue { return text }
    if let values = value.arrayValue {
      let pieces = values.compactMap { text(in: $0) }
      if !pieces.isEmpty { return pieces.joined(separator: "\n") }
    }
    if let content = value["content"], let text = text(in: content) { return text }
    if let message = value["message"] { return text(in: message) }
    if let result = value["result"] { return text(in: result) }
    return nil
  }

  private func pretty(_ value: JSONValue?) -> String {
    guard let value,
      let data = try? JSONEncoder.pretty.encode(value),
      let text = String(data: data, encoding: .utf8)
    else { return "" }
    return text
  }

  private func presentation(in event: ArkHistoryEvent, expected: String) -> JSONValue? {
    guard event.view?["for"]?.stringValue == expected else { return nil }
    return event.view?["view"]
  }
}

/// One file created or modified successfully by a root tool call in a turn.
/// The result sequence lets a closing assistant message exclude a mutation
/// that settled after that message, matching history replay and live delivery.
public struct ArkProducedFile: Identifiable, Equatable, Sendable {
  public let turn: Int
  public let resultSequence: Int
  public let path: String

  public var id: String { "\(turn):\(path)" }

  public init(turn: Int, resultSequence: Int, path: String) {
    self.turn = turn
    self.resultSequence = resultSequence
    self.path = path
  }
}

/// Durable, model-free produced-file projection. It trusts only a successful
/// tool result and the corresponding call view's mutation intent; assistant
/// prose, reads, deletes, failed calls and nested dispatches produce nothing.
public struct ArkProducedFilesProjection: Sendable {
  private struct Call: Sendable {
    let turn: Int
    let presentation: ArkToolPresentation?
  }

  private var calls: [String: Call] = [:]
  private var rows: [ArkProducedFile] = []

  public init(events: [ArkHistoryEvent] = []) {
    reset(events: events)
  }

  public var files: [ArkProducedFile] { rows }

  public mutating func reset(events: [ArkHistoryEvent]) {
    calls = [:]
    rows = []
    for event in events.sorted(by: { $0.id < $1.id }) { append(event) }
  }

  public mutating func append(_ event: ArkHistoryEvent) {
    switch event.type {
    case "tool/call":
      guard let callID = event.data["callId"]?.stringValue,
            let turn = event.data["turn"]?.numberValue.map(Int.init)
      else { return }
      let view = event.view?["for"]?.stringValue == "call" ? event.view?["view"] : nil
      calls[callID] = Call(turn: turn, presentation: ArkToolPresentation.decode(view))

    case "tool/result":
      guard !resultFailed(event),
            let callID = event.data["message"]?["source"]?["callId"]?.stringValue
              ?? event.data["callId"]?.stringValue,
            let call = calls[callID]
      else { return }
      rows.append(contentsOf: producedPaths(call.presentation).map {
        ArkProducedFile(turn: call.turn, resultSequence: event.id, path: $0)
      })

    default:
      break
    }
  }

  public static func files(
    _ rows: [ArkProducedFile],
    turn: Int,
    through sequence: Int
  ) -> [ArkProducedFile] {
    var seen = Set<String>()
    return rows.filter {
      $0.turn == turn
        && $0.resultSequence <= sequence
        && seen.insert($0.path).inserted
    }
  }

  public static func resolveMention(_ value: String, paths: [String]) -> String? {
    if paths.contains(value) { return value }
    let matches = paths.filter { basename($0) == value }
    return matches.count == 1 ? matches[0] : nil
  }

  public static func mentionURL(for path: String) -> URL? {
    var components = URLComponents()
    components.scheme = "ark-produced-file"
    components.host = "open"
    components.queryItems = [URLQueryItem(name: "path", value: path)]
    return components.url
  }

  public static func mentionPath(from url: URL) -> String? {
    guard url.scheme == "ark-produced-file", url.host == "open" else { return nil }
    return URLComponents(url: url, resolvingAgainstBaseURL: false)?
      .queryItems?.first(where: { $0.name == "path" })?.value
  }

  private func producedPaths(_ presentation: ArkToolPresentation?) -> [String] {
    switch presentation {
    case .diff(let card):
      return card.diffs.map(\.path)
    case .generic(let card) where card.kind == "edit":
      return card.locations.map(\.path)
    default:
      return []
    }
  }

  private func resultFailed(_ event: ArkHistoryEvent) -> Bool {
    event.data["error"] != nil
      || event.data["isError"]?.boolValue == true
      || event.data["message"]?["content"]?.arrayValue?.first?["isError"]?.boolValue == true
  }

  private static func basename(_ path: String) -> String {
    path.replacingOccurrences(of: "\\", with: "/")
      .split(separator: "/").last.map(String.init) ?? path
  }
}

/// One canonical tool presentation card decoded from the `view` envelope a
/// history event carries (the wire `presentCall`/`presentResult` output).
/// The payload vocabulary mirrors `ToolCallView`/`ToolResultView`; a payload
/// without a recognized `card` decodes to nil and the raw fallback covers it.
public enum ArkToolPresentation: Equatable, Sendable {
  case generic(ArkGenericPresentation)
  case terminal(ArkTerminalPresentation)
  case diff(ArkDiffPresentation)
  case search(ArkSearchPresentation)
  case read(ArkReadPresentation)
  case web(ArkWebPresentation)

  /// Decode a canonical `ToolCallView`/`ToolResultView` payload. Unknown or
  /// missing `card` values yield nil; optional fields stay nil when absent.
  public static func decode(_ value: JSONValue?) -> ArkToolPresentation? {
    guard let value else { return nil }
    switch value["card"]?.stringValue {
    case "generic": return .generic(ArkGenericPresentation(view: value))
    case "terminal": return .terminal(ArkTerminalPresentation(view: value))
    case "diff": return .diff(ArkDiffPresentation(view: value))
    case "search": return .search(ArkSearchPresentation(view: value))
    case "read": return .read(ArkReadPresentation(view: value))
    case "web": return .web(ArkWebPresentation(view: value))
    default: return nil
    }
  }
}

public extension ArkToolActivity {
  /// The canonical call card decoded from the raw call view envelope.
  var callView: ArkToolPresentation? { ArkToolPresentation.decode(callPresentation) }
  /// The canonical result card decoded from the raw result view envelope.
  var resultView: ArkToolPresentation? { ArkToolPresentation.decode(resultPresentation) }

  /// Product-owned typed presentation for durable tools whose canonical wire
  /// card is intentionally generic. Decoding is based on the exact tool name
  /// and structured argument JSON; free-form assistant text never determines
  /// task or question state.
  var structuredView: ArkStructuredToolPresentation? {
    ArkStructuredToolPresentation.decode(self)
  }

  /// The first canonical file location this tool can hand to Native Files.
  /// Result cards take precedence over call cards because they carry the
  /// actual files affected after execution settles.
  var primaryFileLocation: ArkFileLocation? {
    for presentation in [resultView, callView].compactMap({ $0 }) {
      switch presentation {
      case .generic(let card):
        if let location = card.locations.first { return location }
      case .diff(let card):
        if let file = card.diffs.first { return ArkFileLocation(path: file.path) }
      case .read(let card):
        if let path = card.path { return ArkFileLocation(path: path, line: card.offset) }
      case .search(let card):
        if let file = card.files.first {
          return ArkFileLocation(path: file.path, line: file.matches.first?.lineNumber)
        }
        if let path = card.paths.first { return ArkFileLocation(path: path) }
      case .terminal, .web:
        break
      }
    }
    return nil
  }
}

public struct ArkTodoItemPresentation: Equatable, Codable, Sendable {
  public let content: String
  public let status: String

  public init(content: String, status: String) {
    self.content = content
    self.status = status
  }

  public init?(projection: JSONValue) {
    guard
      let content = projection["content"]?.stringValue,
      !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
      let status = projection["status"]?.stringValue,
      status == "pending" || status == "in_progress" || status == "completed"
    else { return nil }
    self.init(content: content, status: status)
  }

  public var executionPhase: ArkExecutionPhase {
    status == "completed" ? .succeeded : .running
  }
}

public struct ArkTodoListPresentation: Equatable, Sendable {
  public let items: [ArkTodoItemPresentation]

  public init(items: [ArkTodoItemPresentation]) {
    self.items = items
  }

  public init?(projection: JSONValue) {
    guard let values = projection.arrayValue else { return nil }
    var items: [ArkTodoItemPresentation] = []
    items.reserveCapacity(values.count)
    for value in values {
      guard let item = ArkTodoItemPresentation(projection: value) else { return nil }
      items.append(item)
    }
    self.init(items: items)
  }

  public var pendingCount: Int { items.filter { $0.status == "pending" }.count }
  public var runningCount: Int { items.filter { $0.status == "in_progress" }.count }
  public var completedCount: Int { items.filter { $0.status == "completed" }.count }
}

public struct ArkQuestionOptionPresentation: Equatable, Codable, Sendable {
  public let label: String
  public let description: String?
}

public struct ArkQuestionPromptPresentation: Equatable, Codable, Sendable {
  public let id: String
  public let question: String
  public let header: String?
  public let options: [ArkQuestionOptionPresentation]?
}

public struct ArkQuestionBatchPresentation: Equatable, Sendable {
  public let questions: [ArkQuestionPromptPresentation]
}

public enum ArkStructuredToolPresentation: Equatable, Sendable {
  case todo(ArkTodoListPresentation)
  case questions(ArkQuestionBatchPresentation)

  public static func decode(_ activity: ArkToolActivity) -> ArkStructuredToolPresentation? {
    switch activity.name {
    case "todo_write":
      return decodeTodo(activity).map(Self.todo)
    case "ask_user_question":
      return decodeQuestions(activity).map(Self.questions)
    default:
      return nil
    }
  }

  private struct TodoEnvelope: Decodable {
    let todos: [ArkTodoItemPresentation]
  }

  private struct QuestionEnvelope: Decodable {
    let questions: [ArkQuestionPromptPresentation]
  }

  private static func decodeTodo(_ activity: ArkToolActivity) -> ArkTodoListPresentation? {
    for candidate in inputCandidates(activity) {
      guard let data = candidate.data(using: .utf8) else { continue }
      if let items = try? JSONDecoder().decode([ArkTodoItemPresentation].self, from: data) {
        return ArkTodoListPresentation(items: items)
      }
      if let envelope = try? JSONDecoder().decode(TodoEnvelope.self, from: data) {
        return ArkTodoListPresentation(items: envelope.todos)
      }
    }
    return nil
  }

  private static func decodeQuestions(_ activity: ArkToolActivity) -> ArkQuestionBatchPresentation? {
    for candidate in inputCandidates(activity) {
      guard let data = candidate.data(using: .utf8),
            let envelope = try? JSONDecoder().decode(QuestionEnvelope.self, from: data)
      else { continue }
      return ArkQuestionBatchPresentation(questions: envelope.questions)
    }
    return nil
  }

  private static func inputCandidates(_ activity: ArkToolActivity) -> [String] {
    var values: [String] = []
    if case .generic(let card) = activity.callView, let raw = card.rawInput {
      values.append(raw)
    }
    if !activity.arguments.isEmpty { values.append(activity.arguments) }
    return values
  }
}

/// The default generic card: title, category kind, salient raw input, and
/// follow-along file locations.
public struct ArkGenericPresentation: Equatable, Sendable {
  public let title: String?
  public let kind: String?
  /// The salient raw input: a string as-is, an object as pretty JSON.
  public let rawInput: String?
  public let locations: [ArkFileLocation]

  init(view: JSONValue) {
    title = view["title"]?.stringValue
    kind = view["kind"]?.stringValue
    rawInput = ArkToolPresentation.rawInputString(view["rawInput"])
    locations = view["locations"]?.arrayValue?.compactMap { ArkFileLocation(view: $0) } ?? []
  }
}

/// One file a call reads or modifies, for editor follow-along.
public struct ArkFileLocation: Equatable, Sendable {
  public let path: String
  public let line: Int?

  public init(path: String, line: Int? = nil) {
    self.path = path
    self.line = line
  }

  init?(view: JSONValue) {
    guard let path = view["path"]?.stringValue else { return nil }
    self.path = path
    line = view["line"]?.numberValue.map(Int.init)
  }
}

/// One single-use, root-bound request from a transcript file reference to the
/// existing Native Workbench Files owner.
public struct ArkWorkbenchFileOpenRequest: Identifiable, Equatable, Sendable {
  public let id: UUID
  public let rootPath: String
  public let filePath: String

  public init(id: UUID = UUID(), rootPath: String, filePath: String) {
    self.id = id
    self.rootPath = rootPath
    self.filePath = filePath
  }
}

/// The terminal card: cwd-headed command with live or captured output and an
/// exit-status signal pair.
public struct ArkTerminalPresentation: Equatable, Sendable {
  public let title: String?
  public let description: String?
  public let cwd: String?
  public let output: String?
  public let exitCode: Int?
  public let signal: String?

  init(view: JSONValue) {
    title = view["title"]?.stringValue
    description = view["description"]?.stringValue
    cwd = view["cwd"]?.stringValue
    output = view["output"]?.stringValue
    exitCode = view["exitCode"]?.numberValue.map(Int.init)
    signal = view["signal"]?.stringValue
  }
}

/// One single-file change of a diff card.
public struct ArkFileDiff: Equatable, Sendable {
  public let path: String
  /// Prior content, nil for a new file or an overwrite.
  public let oldText: String?
  public let newText: String?

  init?(view: JSONValue) {
    guard let path = view["path"]?.stringValue else { return nil }
    self.path = path
    oldText = view["oldText"]?.stringValue
    newText = view["newText"]?.stringValue
  }
}

/// The inline-diff card for calls that create or modify files.
public struct ArkDiffPresentation: Equatable, Sendable {
  public let title: String?
  public let diffs: [ArkFileDiff]

  init(view: JSONValue) {
    title = view["title"]?.stringValue
    diffs = view["diffs"]?.arrayValue?.compactMap { ArkFileDiff(view: $0) } ?? []
  }
}

/// One matched line inside a search file group: its file line number and text.
public struct ArkSearchLineMatch: Equatable, Sendable {
  public let lineNumber: Int
  public let line: String

  init?(view: JSONValue) {
    guard
      let lineNumber = view["lineNumber"]?.numberValue.map(Int.init),
      let line = view["line"]?.stringValue
    else { return nil }
    self.lineNumber = lineNumber
    self.line = line
  }
}

/// One file's grouped content matches for a search result, in first-seen order.
public struct ArkSearchFileMatches: Equatable, Sendable {
  public let path: String
  public let matches: [ArkSearchLineMatch]

  init?(view: JSONValue) {
    guard let path = view["path"]?.stringValue else { return nil }
    self.path = path
    matches = view["matches"]?.arrayValue?.compactMap { ArkSearchLineMatch(view: $0) } ?? []
  }
}

/// The completed search card: grouped-by-file matches or a flat path list,
/// both carrying the truncated/total cap signal.
public struct ArkSearchPresentation: Equatable, Sendable {
  /// "matches" or "paths"; anything else renders as grouped matches.
  public let shape: String?
  public let title: String?
  public let paths: [String]
  public let files: [ArkSearchFileMatches]
  public let truncated: Bool
  public let total: Int

  init(view: JSONValue) {
    shape = view["shape"]?.stringValue
    title = view["title"]?.stringValue
    paths = view["paths"]?.arrayValue?.compactMap(\.stringValue) ?? []
    files = view["files"]?.arrayValue?.compactMap { ArkSearchFileMatches(view: $0) } ?? []
    truncated = view["truncated"]?.boolValue ?? false
    total = view["total"]?.numberValue.map(Int.init) ?? 0
  }
}

/// One numbered line of a read window, keeping the file's own numbering.
public struct ArkReadLine: Equatable, Sendable {
  public let number: Int
  public let text: String

  init?(view: JSONValue) {
    guard
      let number = view["number"]?.numberValue.map(Int.init),
      let text = view["text"]?.stringValue
    else { return nil }
    self.number = number
    self.text = text
  }
}

/// The completed file-read card: path, window offset, numbered lines, total
/// count, and a syntax-highlighting language hint.
public struct ArkReadPresentation: Equatable, Sendable {
  public let title: String?
  public let path: String?
  public let offset: Int?
  public let lines: [ArkReadLine]
  public let totalLines: Int?
  public let lang: String?

  init(view: JSONValue) {
    title = view["title"]?.stringValue
    path = view["path"]?.stringValue
    offset = view["offset"]?.numberValue.map(Int.init)
    lines = view["lines"]?.arrayValue?.compactMap { ArkReadLine(view: $0) } ?? []
    totalLines = view["totalLines"]?.numberValue.map(Int.init)
    lang = view["lang"]?.stringValue
  }
}

/// One citeable source of a web search result.
public struct ArkWebSource: Equatable, Sendable {
  public let url: String
  public let title: String?
  public let snippet: String?
  public let publishedAt: String?

  init?(view: JSONValue) {
    guard let url = view["url"]?.stringValue else { return nil }
    self.url = url
    title = view["title"]?.stringValue
    snippet = view["snippet"]?.stringValue
    publishedAt = view["publishedAt"]?.stringValue
  }
}

/// The completed web card: a kind-tagged search sources list or a fetch
/// retrieval summary, both carrying the truncation signal.
public struct ArkWebPresentation: Equatable, Sendable {
  /// "search" or "fetch"; anything else renders as a search result.
  public let kind: String?
  public let title: String?
  public let sources: [ArkWebSource]
  public let answer: String?
  public let url: String?
  public let statusCode: Int?
  public let truncated: Bool

  init(view: JSONValue) {
    kind = view["kind"]?.stringValue
    title = view["title"]?.stringValue
    sources = view["sources"]?.arrayValue?.compactMap { ArkWebSource(view: $0) } ?? []
    answer = view["answer"]?.stringValue
    url = view["url"]?.stringValue
    statusCode = view["statusCode"]?.numberValue.map(Int.init)
    truncated = view["truncated"]?.boolValue ?? false
  }
}

extension ArkToolPresentation {
  /// A raw input as a string, or a non-string value as pretty JSON.
  fileprivate static func rawInputString(_ value: JSONValue?) -> String? {
    if let string = value?.stringValue { return string }
    guard let value,
      let data = try? JSONEncoder.pretty.encode(value),
      let text = String(data: data, encoding: .utf8)
    else { return nil }
    return text
  }
}

extension JSONEncoder {
  fileprivate static var pretty: JSONEncoder {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    return encoder
  }
}
