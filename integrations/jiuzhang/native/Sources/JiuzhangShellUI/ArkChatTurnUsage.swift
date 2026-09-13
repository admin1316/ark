import Foundation
import JiuzhangShellCore

/// One provider/model route that contributed usage to a completed native turn.
public struct ArkChatTurnUsageRoute: Equatable, Sendable {
  public let provider: String
  public let model: String

  public init(provider: String, model: String) {
    self.provider = provider
    self.model = model
  }
}

/// Exact provider-reported token accounting for one completed turn.
///
/// Optional buckets are intentionally optional: a disclosure is allowed to
/// show them only when every billed attempt supplied that bucket. The native
/// surface therefore never manufactures cache or reasoning numbers from a
/// partial stream.
public struct ArkChatTurnUsage: Equatable, Sendable {
  public let uncachedInputTokens: Int
  public let outputTokens: Int
  public let totalTokens: Int
  public let cacheReadTokens: Int?
  public let cacheWriteTokens: Int?
  public let reasoningTokens: Int?
  public let routes: [ArkChatTurnUsageRoute]?

  public init(
    uncachedInputTokens: Int,
    outputTokens: Int,
    totalTokens: Int,
    cacheReadTokens: Int? = nil,
    cacheWriteTokens: Int? = nil,
    reasoningTokens: Int? = nil,
    routes: [ArkChatTurnUsageRoute]? = nil
  ) {
    self.uncachedInputTokens = uncachedInputTokens
    self.outputTokens = outputTokens
    self.totalTokens = totalTokens
    self.cacheReadTokens = cacheReadTokens
    self.cacheWriteTokens = cacheWriteTokens
    self.reasoningTokens = reasoningTokens
    self.routes = routes
  }
}

/// Replay-aware exact token accounting for native conversation disclosures.
///
/// The fold mirrors the Host's attempt lifecycle. A usage sample by itself is
/// never treated as a complete request; missing boundaries, unsafe values, or
/// contradictory totals make the whole turn unavailable.
public enum ArkChatTurnUsageProjection {
  private struct RawUsage: Sendable {
    let inputTokens: Int?
    let outputTokens: Int?
    let cacheReadTokens: Int?
    let cacheWriteTokens: Int?
    let reasoningTokens: Int?
    let totalTokens: Int?
  }

  private struct NormalizedAttempt: Sendable {
    let inputTokens: Int
    let outputTokens: Int
    let totalTokens: Int
    let cacheReadTokens: Int?
    let cacheWriteTokens: Int?
    let reasoningTokens: Int?
    let route: ArkChatTurnUsageRoute?
  }

  private enum RetrySettlement: Sendable {
    case message
    case retry
  }

  private enum AttemptState: Sendable {
    case idle
    case open(turn: Int, step: Int, sample: RawUsage?)
    case finishClosed(turn: Int, step: Int)
    case settled(turn: Int, step: Int, by: RetrySettlement)
  }

  /// Return the durable turn coordinate carried by an event, when safe.
  /// Keeping this extractor here lets incremental owners touch only turns
  /// affected by a live batch instead of refolding the complete transcript.
  public static func turn(in event: ArkHistoryEvent) -> Int? {
    let value = integer(event.data["turn"])
    return value.flatMap { $0 >= 0 ? $0 : nil }
  }

  /// A value checkpoint of the same strict turn/attempt fold used for replay.
  /// Raw text deltas are validated and discarded; only the open attempt and
  /// normalized usage samples survive raw history eviction or a session cache.
  public struct Accumulator: Sendable {
    private var turns: [Int: TurnState] = [:]
    public private(set) var completed: [Int: ArkChatTurnUsage] = [:]

    public init(events: [ArkHistoryEvent] = []) {
      append(contentsOf: events.sorted { $0.id < $1.id })
    }

    public mutating func append(_ event: ArkHistoryEvent) {
      guard let turn = ArkChatTurnUsageProjection.turn(in: event) else { return }
      turns[turn, default: TurnState(turn: turn)].append(event)
      completed[turn] = turns[turn]?.result
    }

    public mutating func append(contentsOf events: [ArkHistoryEvent]) {
      for event in events { append(event) }
    }
  }

  /// Fold every complete turn that is represented in the supplied history.
  public static func projectAll(events: [ArkHistoryEvent]) -> [Int: ArkChatTurnUsage] {
    Accumulator(events: events).completed
  }

  /// Fold one turn from raw native history using the incremental admission rules.
  public static func project(events: [ArkHistoryEvent], turn: Int) -> ArkChatTurnUsage? {
    guard turn >= 0 else { return nil }
    return Accumulator(events: events.filter { self.turn(in: $0) == turn }).completed[turn]
  }

  private struct TurnState: Sendable {
    let turn: Int
    var state: AttemptState = .idle
    var attempts: [NormalizedAttempt] = []
    var sawTurnStart = false
    var sawTurnEnd = false
    var invalid = false

    init(turn: Int) { self.turn = turn }

    func closeOpen(
      _ candidate: AttemptState,
      route: ArkChatTurnUsageRoute?
    ) -> NormalizedAttempt? {
      guard case .open(_, _, let sample?) = candidate else { return nil }
      return ArkChatTurnUsageProjection.normalize(sample, route: route)
    }

    mutating func append(_ event: ArkHistoryEvent) {
      guard !invalid else { return }

      if event.type == "turn/start" {
        guard !sawTurnStart, !sawTurnEnd, case .idle = state else {
          invalid = true
          return
        }
        sawTurnStart = true
        return
      }

      guard sawTurnStart, !sawTurnEnd else {
        invalid = true
        return
      }

      if event.type == "turn/end" {
        guard ArkChatTurnUsageProjection.integer(event.data["turn"]) == turn, case .idle = state else {
          invalid = true
          return
        }
        sawTurnEnd = true
        return
      }

      switch event.type {
      case "step/start":
        guard ArkChatTurnUsageProjection.integer(event.data["turn"]) == turn,
              let step = ArkChatTurnUsageProjection.integer(event.data["step"]),
              case .idle = state
        else {
          invalid = true
          return
        }
        state = .open(turn: turn, step: step, sample: nil)

      case "assistant/chunk":
        guard case .open(let stateTurn, let stateStep, let previousSample) = state,
              stateTurn == turn,
              ArkChatTurnUsageProjection.integer(event.data["turn"]) == turn,
              ArkChatTurnUsageProjection.integer(event.data["step"]) == stateStep
        else {
          invalid = true
          return
        }
        let chunk = event.data["chunk"]
        switch chunk?["type"]?.stringValue {
        case "usage":
          state = .open(
            turn: turn,
            step: stateStep,
            sample: ArkChatTurnUsageProjection.rawUsage(from: chunk?["usage"] ?? .null)
          )
        case "finish":
          let reason = chunk?["reason"]?["kind"]?.stringValue
          guard reason == "error" || reason == "aborted" else { return }
          guard let normalized = closeOpen(
            .open(turn: turn, step: stateStep, sample: previousSample),
            route: nil
          ) else {
            invalid = true
            return
          }
          attempts.append(normalized)
          state = .finishClosed(turn: turn, step: stateStep)
        default:
          break
        }

      case "assistant/message":
        guard case .open(let stateTurn, let stateStep, let previousSample) = state,
              stateTurn == turn,
              ArkChatTurnUsageProjection.integer(event.data["turn"]) == turn,
              ArkChatTurnUsageProjection.integer(event.data["step"]) == stateStep
        else {
          invalid = true
          return
        }
        let candidate: AttemptState
        if event.data["usage"] != nil {
          candidate = .open(
            turn: turn,
            step: stateStep,
            sample: ArkChatTurnUsageProjection.rawUsage(from: event.data["usage"] ?? .null)
          )
        } else {
          candidate = .open(turn: turn, step: stateStep, sample: previousSample)
        }
        guard let normalized = closeOpen(candidate, route: ArkChatTurnUsageProjection.messageRoute(from: event.data)) else {
          invalid = true
          return
        }
        attempts.append(normalized)
        state = .settled(turn: turn, step: stateStep, by: .message)

      case "llm/retry":
        guard ArkChatTurnUsageProjection.integer(event.data["turn"]) == turn,
              let step = ArkChatTurnUsageProjection.integer(event.data["step"])
        else {
          invalid = true
          return
        }
        switch state {
        case .open(let stateTurn, let stateStep, let sample):
          guard stateTurn == turn, stateStep == step,
                let normalized = closeOpen(
                  .open(turn: turn, step: step, sample: sample),
                  route: nil
                )
          else {
            invalid = true
            return
          }
          attempts.append(normalized)
          state = .settled(turn: turn, step: step, by: .retry)
        case .finishClosed(let stateTurn, let stateStep):
          guard stateTurn == turn, stateStep == step else {
            invalid = true
            return
          }
          state = .settled(turn: turn, step: step, by: .retry)
        case .settled, .idle:
          invalid = true
        }

      case "llm/retry-started":
        guard ArkChatTurnUsageProjection.integer(event.data["turn"]) == turn,
              let step = ArkChatTurnUsageProjection.integer(event.data["step"]),
              case .settled(let stateTurn, let stateStep, by: .retry) = state,
              stateTurn == turn,
              stateStep == step
        else {
          invalid = true
          return
        }
        state = .open(turn: turn, step: step, sample: nil)

      case "step/end":
        guard ArkChatTurnUsageProjection.integer(event.data["turn"]) == turn,
              let step = ArkChatTurnUsageProjection.integer(event.data["step"])
        else {
          invalid = true
          return
        }
        switch state {
        case .open(let stateTurn, let stateStep, let sample):
          guard stateTurn == turn, stateStep == step,
                let normalized = closeOpen(
                  .open(turn: turn, step: step, sample: sample),
                  route: nil
                )
          else {
            invalid = true
            return
          }
          attempts.append(normalized)
          state = .idle
        case .finishClosed(let stateTurn, let stateStep),
             .settled(let stateTurn, let stateStep, _):
          guard stateTurn == turn, stateStep == step else {
            invalid = true
            return
          }
          state = .idle
        case .idle:
          invalid = true
        }

      default:
        break
      }
    }

    var result: ArkChatTurnUsage? {
      guard !invalid, sawTurnStart, sawTurnEnd, case .idle = state else { return nil }
      return ArkChatTurnUsageProjection.aggregate(attempts)
    }
  }

  private static func rawUsage(from value: JSONValue) -> RawUsage {
    RawUsage(
      inputTokens: integer(value["inputTokens"]),
      outputTokens: integer(value["outputTokens"]),
      cacheReadTokens: integer(value["cacheReadTokens"]),
      cacheWriteTokens: integer(value["cacheWriteTokens"]),
      reasoningTokens: integer(value["reasoningTokens"]),
      totalTokens: integer(value["totalTokens"])
    )
  }

  private static func messageRoute(from value: JSONValue) -> ArkChatTurnUsageRoute? {
    let message = value["message"] ?? value
    guard let provider = message["source"]?["provider"]?.stringValue,
          let model = message["source"]?["model"]?.stringValue,
          !provider.isEmpty,
          !model.isEmpty
    else { return nil }
    return ArkChatTurnUsageRoute(provider: provider, model: model)
  }

  private static func normalize(
    _ usage: RawUsage,
    route: ArkChatTurnUsageRoute?
  ) -> NormalizedAttempt? {
    guard let inputTokens = usage.inputTokens,
          let outputTokens = usage.outputTokens
    else { return nil }
    if let reasoningTokens = usage.reasoningTokens, reasoningTokens > outputTokens {
      return nil
    }

    let knownPrompt = safeSum([
      inputTokens,
      usage.cacheReadTokens,
      usage.cacheWriteTokens,
    ].compactMap { $0 })
    guard let knownPrompt else { return nil }

    let exactTotal: Int
    if let totalTokens = usage.totalTokens {
      let (exactPrompt, underflow) = totalTokens.subtractingReportingOverflow(outputTokens)
      guard !underflow, exactPrompt >= 0, exactPrompt >= knownPrompt else { return nil }
      if usage.cacheReadTokens != nil,
         usage.cacheWriteTokens != nil,
         exactPrompt != knownPrompt
      {
        return nil
      }
      exactTotal = totalTokens
    } else {
      guard usage.cacheReadTokens != nil, usage.cacheWriteTokens != nil,
            let derivedTotal = safeSum([knownPrompt, outputTokens])
      else { return nil }
      exactTotal = derivedTotal
    }

    return NormalizedAttempt(
      inputTokens: inputTokens,
      outputTokens: outputTokens,
      totalTokens: exactTotal,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      reasoningTokens: usage.reasoningTokens,
      route: route
    )
  }

  private static func aggregate(_ attempts: [NormalizedAttempt]) -> ArkChatTurnUsage? {
    guard !attempts.isEmpty,
          let inputTokens = safeSum(attempts.map(\.inputTokens)),
          let outputTokens = safeSum(attempts.map(\.outputTokens)),
          let totalTokens = safeSum(attempts.map(\.totalTokens))
    else { return nil }

    let cacheReads = attempts.compactMap(\.cacheReadTokens)
    let cacheWrites = attempts.compactMap(\.cacheWriteTokens)
    let reasonings = attempts.compactMap(\.reasoningTokens)
    let cacheReadTokens = cacheReads.count == attempts.count ? safeSum(cacheReads) : nil
    let cacheWriteTokens = cacheWrites.count == attempts.count ? safeSum(cacheWrites) : nil
    let reasoningTokens = reasonings.count == attempts.count ? safeSum(reasonings) : nil

    let routes: [ArkChatTurnUsageRoute]?
    let attributed = attempts.compactMap(\.route)
    if attributed.count == attempts.count {
      var seen = Set<String>()
      routes = attributed.filter { seen.insert("\($0.provider)\0\($0.model)").inserted }
    } else {
      routes = nil
    }

    return ArkChatTurnUsage(
      uncachedInputTokens: inputTokens,
      outputTokens: outputTokens,
      totalTokens: totalTokens,
      cacheReadTokens: cacheReadTokens,
      cacheWriteTokens: cacheWriteTokens,
      reasoningTokens: reasoningTokens,
      routes: routes
    )
  }

  private static func integer(_ value: JSONValue?) -> Int? {
    guard let number = value?.numberValue,
          number.isFinite,
          number.rounded(.towardZero) == number,
          number >= 0,
          number <= 9_007_199_254_740_991
    else { return nil }
    return Int(number)
  }

  private static func safeSum(_ values: [Int]) -> Int? {
    var total = 0
    for value in values {
      let (next, overflow) = total.addingReportingOverflow(value)
      if overflow { return nil }
      total = next
    }
    return total
  }
}
