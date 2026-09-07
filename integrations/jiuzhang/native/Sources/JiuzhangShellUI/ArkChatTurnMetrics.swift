import Foundation
import JiuzhangShellCore

public struct ArkChatTurnMetrics: Equatable, Sendable {
  public let runSeconds: Double?
  public let firstTokenSeconds: Double?
  public let tokensPerSecond: Double?

  public init(
    runSeconds: Double?,
    firstTokenSeconds: Double?,
    tokensPerSecond: Double?
  ) {
    self.runSeconds = runSeconds
    self.firstTokenSeconds = firstTokenSeconds
    self.tokensPerSecond = tokensPerSecond
  }

  public static func project(events: [ArkHistoryEvent], turn: Int) -> ArkChatTurnMetrics {
    projectAll(events: events)[turn]
      ?? ArkChatTurnMetrics(runSeconds: nil, firstTokenSeconds: nil, tokensPerSecond: nil)
  }

  /// Fold every turn in one history pass so SwiftUI rows can read O(1) cached metrics.
  public static func projectAll(events: [ArkHistoryEvent]) -> [Int: ArkChatTurnMetrics] {
    ArkChatTurnProjection(events: events).metricsByTurn
  }

}

/// Incremental owner for turn metrics and completed fork points.
///
/// Live chat publishes arrive many times per second. Re-folding the bounded
/// 50,000-event history on every publish made cost grow with the entire
/// conversation. This projection updates only the turn touched by each new
/// event; a full rebuild is reserved for initial history load or retention
/// truncation.
struct ArkChatTurnProjection: Equatable, Sendable {
  private struct Accumulator: Equatable, Sendable {
    var start: Date?
    var end: Date?
    var stepStart: Date?
    var firstChunk: Date?
    var lastChunk: Date?
    var outputTokens = 0
  }

  private var accumulators: [Int: Accumulator] = [:]
  private(set) var metricsByTurn: [Int: ArkChatTurnMetrics] = [:]
  private(set) var completedSequenceByTurn: [Int: Int] = [:]
  private(set) var latestStartedTurn: Int?
  private(set) var latestStartedSequence: Int?

  init(events: [ArkHistoryEvent] = []) {
    append(contentsOf: events)
  }

  mutating func append(contentsOf events: [ArkHistoryEvent]) {
    for event in events { append(event) }
  }

  mutating func preserveLatestStartedBoundary(turn: Int?, sequence: Int?) {
    guard let turn, let sequence,
          sequence >= (latestStartedSequence ?? Int.min)
    else { return }
    latestStartedTurn = turn
    latestStartedSequence = sequence
  }

  mutating func append(_ event: ArkHistoryEvent) {
    guard let number = event.data["turn"]?.numberValue else { return }
    let turn = Int(number)
    guard turn >= 0 else { return }

    var value = accumulators[turn] ?? Accumulator()
    switch event.type {
    case "turn/start":
      value.start = value.start ?? event.time
      if event.id >= (latestStartedSequence ?? Int.min) {
        latestStartedTurn = turn
        latestStartedSequence = event.id
      }
    case "turn/end":
      value.end = event.time
      if event.data["reason"]?["kind"]?.stringValue == "completed" {
        completedSequenceByTurn[turn] = event.id
      } else {
        completedSequenceByTurn.removeValue(forKey: turn)
      }
    case "step/start":
      value.stepStart = value.stepStart ?? event.time
    case "assistant/chunk":
      value.firstChunk = value.firstChunk ?? event.time
      value.lastChunk = event.time
    case "assistant/message":
      value.outputTokens += event.data["usage"]?["outputTokens"]?.numberValue.map(Int.init)
        ?? event.data["usage"]?["output"]?.numberValue.map(Int.init)
        ?? 0
    default:
      break
    }
    accumulators[turn] = value
    metricsByTurn[turn] = metrics(for: value)
  }

  private func metrics(for value: Accumulator) -> ArkChatTurnMetrics {
    let decodeSeconds = duration(value.firstChunk, value.lastChunk)
    let tokensPerSecond: Double? =
      if value.outputTokens > 0, let decodeSeconds, decodeSeconds > 0 {
        Double(value.outputTokens) / decodeSeconds
      } else {
        nil
      }
    return ArkChatTurnMetrics(
      runSeconds: duration(value.start, value.end),
      firstTokenSeconds: duration(value.stepStart, value.firstChunk),
      tokensPerSecond: tokensPerSecond
    )
  }

  private func duration(_ start: Date?, _ end: Date?) -> Double? {
    guard let start, let end else { return nil }
    return max(end.timeIntervalSince(start), 0)
  }
}
