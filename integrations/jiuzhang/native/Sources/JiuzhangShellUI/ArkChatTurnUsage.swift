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
  private struct RawUsage {
    let inputTokens: Int?
    let outputTokens: Int?
    let cacheReadTokens: Int?
    let cacheWriteTokens: Int?
    let reasoningTokens: Int?
    let totalTokens: Int?
  }

  private struct NormalizedAttempt {
    let inputTokens: Int
    let outputTokens: Int
    let totalTokens: Int
    let cacheReadTokens: Int?
    let cacheWriteTokens: Int?
    let reasoningTokens: Int?
    let route: ArkChatTurnUsageRoute?
  }

  private enum RetrySettlement {
    case message
    case retry
  }

  private enum AttemptState {
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

  /// Fold every complete turn that is represented in the supplied history.
  public static func projectAll(events: [ArkHistoryEvent]) -> [Int: ArkChatTurnUsage] {
    var eventsByTurn: [Int: [ArkHistoryEvent]] = [:]
    for event in events {
      guard let turn = self.turn(in: event) else { continue }
      eventsByTurn[turn, default: []].append(event)
    }

    var result: [Int: ArkChatTurnUsage] = [:]
    for turn in eventsByTurn.keys.sorted() {
      guard let usage = project(events: eventsByTurn[turn] ?? [], turn: turn) else { continue }
      result[turn] = usage
    }
    return result
  }

  /// Fold one turn from raw native history.
  public static func project(events: [ArkHistoryEvent], turn: Int) -> ArkChatTurnUsage? {
    guard turn >= 0 else { return nil }
    let localEvents = events
      .filter { integer($0.data["turn"]) == turn }
      .sorted { $0.id < $1.id }
    guard !localEvents.isEmpty else { return nil }

    var state: AttemptState = .idle
    var attempts: [NormalizedAttempt] = []
    var sawTurnStart = false
    var sawTurnEnd = false
    var invalid = false

    func closeOpen(
      _ candidate: AttemptState,
      route: ArkChatTurnUsageRoute?
    ) -> NormalizedAttempt? {
      guard case .open(_, _, let sample?) = candidate else { return nil }
      return normalize(sample, route: route)
    }

    for event in localEvents {
      if invalid { break }

      if event.type == "turn/start" {
        guard !sawTurnStart, !sawTurnEnd, case .idle = state else {
          invalid = true
          continue
        }
        sawTurnStart = true
        continue
      }

      guard sawTurnStart, !sawTurnEnd else {
        invalid = true
        continue
      }

      if event.type == "turn/end" {
        guard integer(event.data["turn"]) == turn, case .idle = state else {
          invalid = true
          continue
        }
        sawTurnEnd = true
        continue
      }

      switch event.type {
      case "step/start":
        guard integer(event.data["turn"]) == turn,
              let step = integer(event.data["step"]),
              case .idle = state
        else {
          invalid = true
          continue
        }
        state = .open(turn: turn, step: step, sample: nil)

      case "assistant/chunk":
        guard case .open(let stateTurn, let stateStep, let previousSample) = state,
              stateTurn == turn,
              integer(event.data["turn"]) == turn,
              integer(event.data["step"]) == stateStep
        else {
          invalid = true
          continue
        }
        let chunk = event.data["chunk"]
        switch chunk?["type"]?.stringValue {
        case "usage":
          state = .open(
            turn: turn,
            step: stateStep,
            sample: rawUsage(from: chunk?["usage"] ?? .null)
          )
        case "finish":
          let reason = chunk?["reason"]?["kind"]?.stringValue
          guard reason == "error" || reason == "aborted" else { continue }
          guard let normalized = closeOpen(
            .open(turn: turn, step: stateStep, sample: previousSample),
            route: nil
          ) else {
            invalid = true
            continue
          }
          attempts.append(normalized)
          state = .finishClosed(turn: turn, step: stateStep)
        default:
          break
        }

      case "assistant/message":
        guard case .open(let stateTurn, let stateStep, let previousSample) = state,
              stateTurn == turn,
              integer(event.data["turn"]) == turn,
              integer(event.data["step"]) == stateStep
        else {
          invalid = true
          continue
        }
        let candidate: AttemptState
        if event.data["usage"] != nil {
          candidate = .open(
            turn: turn,
            step: stateStep,
            sample: rawUsage(from: event.data["usage"] ?? .null)
          )
        } else {
          candidate = .open(turn: turn, step: stateStep, sample: previousSample)
        }
        guard let normalized = closeOpen(candidate, route: messageRoute(from: event.data)) else {
          invalid = true
          continue
        }
        attempts.append(normalized)
        state = .settled(turn: turn, step: stateStep, by: .message)

      case "llm/retry":
        guard integer(event.data["turn"]) == turn,
              let step = integer(event.data["step"])
        else {
          invalid = true
          continue
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
            continue
          }
          attempts.append(normalized)
          state = .settled(turn: turn, step: step, by: .retry)
        case .finishClosed(let stateTurn, let stateStep):
          guard stateTurn == turn, stateStep == step else {
            invalid = true
            continue
          }
          state = .settled(turn: turn, step: step, by: .retry)
        case .settled, .idle:
          invalid = true
        }

      case "llm/retry-started":
        guard integer(event.data["turn"]) == turn,
              let step = integer(event.data["step"]),
              case .settled(let stateTurn, let stateStep, by: .retry) = state,
              stateTurn == turn,
              stateStep == step
        else {
          invalid = true
          continue
        }
        state = .open(turn: turn, step: step, sample: nil)

      case "step/end":
        guard integer(event.data["turn"]) == turn,
              let step = integer(event.data["step"])
        else {
          invalid = true
          continue
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
            continue
          }
          attempts.append(normalized)
          state = .idle
        case .finishClosed(let stateTurn, let stateStep),
             .settled(let stateTurn, let stateStep, _):
          guard stateTurn == turn, stateStep == step else {
            invalid = true
            continue
          }
          state = .idle
        case .idle:
          invalid = true
        }

      default:
        break
      }
    }

    guard !invalid, sawTurnStart, sawTurnEnd, case .idle = state else { return nil }
    return aggregate(attempts)
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
