import Foundation
import JiuzhangShellCore
import JiuzhangShellUI

private func usageEvent(_ id: Int, _ type: String, _ data: JSONValue) -> ArkHistoryEvent {
  ArkHistoryEvent(
    id: id,
    type: type,
    time: Date(timeIntervalSince1970: Double(id)),
    data: data,
    view: nil
  )
}

private func usageSample(
  input: Int,
  output: Int,
  cacheRead: Int? = nil,
  cacheWrite: Int? = nil,
  reasoning: Int? = nil,
  total: Int? = nil
) -> JSONValue {
  var value: [String: JSONValue] = [
    "inputTokens": .number(Double(input)),
    "outputTokens": .number(Double(output)),
  ]
  if let cacheRead { value["cacheReadTokens"] = .number(Double(cacheRead)) }
  if let cacheWrite { value["cacheWriteTokens"] = .number(Double(cacheWrite)) }
  if let reasoning { value["reasoningTokens"] = .number(Double(reasoning)) }
  if let total { value["totalTokens"] = .number(Double(total)) }
  return .object(value)
}

func runArkChatTurnUsageContractChecks() {
  let complete = [
    usageEvent(1, "turn/start", .object(["turn": .number(4)])),
    usageEvent(2, "step/start", .object(["turn": .number(4), "step": .number(1)])),
    usageEvent(3, "assistant/chunk", .object([
      "turn": .number(4),
      "step": .number(1),
      "chunk": .object([
        "type": .string("usage"),
        "usage": usageSample(input: 5, output: 6, cacheRead: 4, cacheWrite: 1, reasoning: 2, total: 16),
      ]),
    ])),
    usageEvent(4, "assistant/message", .object([
      "turn": .number(4),
      "step": .number(1),
      "usage": usageSample(input: 5, output: 6, cacheRead: 4, cacheWrite: 1, reasoning: 2, total: 16),
      "message": .object([
        "source": .object([
          "provider": .string("deepseek"),
          "model": .string("deepseek-chat"),
        ]),
      ]),
    ])),
    usageEvent(5, "step/end", .object(["turn": .number(4), "step": .number(1)])),
    usageEvent(6, "turn/end", .object([
      "turn": .number(4),
      "reason": .object(["kind": .string("completed")]),
    ])),
  ]
  let usage = ArkChatTurnUsageProjection.project(events: complete, turn: 4)
  check(
    usage == ArkChatTurnUsage(
      uncachedInputTokens: 5,
      outputTokens: 6,
      totalTokens: 16,
      cacheReadTokens: 4,
      cacheWriteTokens: 1,
      reasoningTokens: 2,
      routes: [ArkChatTurnUsageRoute(provider: "deepseek", model: "deepseek-chat")]
    ),
    "native completed turns expose exact provider usage and route attribution"
  )

  let retry = [
    usageEvent(10, "turn/start", .object(["turn": .number(5)])),
    usageEvent(11, "step/start", .object(["turn": .number(5), "step": .number(1)])),
    usageEvent(12, "assistant/chunk", .object([
      "turn": .number(5), "step": .number(1),
      "chunk": .object([
        "type": .string("usage"),
        "usage": usageSample(input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3),
      ]),
    ])),
    usageEvent(13, "assistant/chunk", .object([
      "turn": .number(5), "step": .number(1),
      "chunk": .object([
        "type": .string("finish"),
        "reason": .object(["kind": .string("error")]),
      ]),
    ])),
    usageEvent(14, "llm/retry", .object(["turn": .number(5), "step": .number(1)])),
    usageEvent(15, "llm/retry-started", .object(["turn": .number(5), "step": .number(1)])),
    usageEvent(16, "assistant/message", .object([
      "turn": .number(5), "step": .number(1),
      "usage": usageSample(input: 3, output: 4, total: 8),
      "message": .object(["source": .object([
        "provider": .string("deepseek"), "model": .string("deepseek-reasoner"),
      ])]),
    ])),
    usageEvent(17, "step/end", .object(["turn": .number(5), "step": .number(1)])),
    usageEvent(18, "turn/end", .object([
      "turn": .number(5),
      "reason": .object(["kind": .string("completed")]),
    ])),
  ]
  let retryUsage = ArkChatTurnUsageProjection.project(events: retry, turn: 5)
  check(
    retryUsage?.uncachedInputTokens == 4
      && retryUsage?.outputTokens == 6
      && retryUsage?.totalTokens == 11
      && retryUsage?.cacheReadTokens == nil
      && retryUsage?.routes == nil,
    "native usage aggregates retry attempts and omits optional buckets without complete evidence"
  )

  let contradictory = complete.map { event -> ArkHistoryEvent in
    guard event.type == "assistant/message" else { return event }
    var data = event.data.objectValue ?? [:]
    data["usage"] = usageSample(input: 5, output: 6, cacheRead: 4, cacheWrite: 1, total: 17)
    return usageEvent(event.id, event.type, .object(data))
  }
  check(
    ArkChatTurnUsageProjection.project(events: contradictory, turn: 4) == nil,
    "native usage hides contradictory provider totals instead of presenting a false exact disclosure"
  )

  let partial = complete.filter { $0.type != "step/start" && $0.type != "assistant/chunk" }
  check(
    ArkChatTurnUsageProjection.projectAll(events: partial)[4] == nil,
    "native usage does not infer a complete attempt from a final message without step evidence"
  )

  // Every split is a potential publish/cache boundary. The state keeps open
  // attempts, failed retry settlement and strict invalidation across each one.
  for (label, events) in [
    ("complete", complete), ("retry", retry),
    ("contradictory", contradictory), ("missing boundary", partial),
  ] {
    let expected = ArkChatTurnUsageProjection.projectAll(events: events)
    for split in 0...events.count {
      let first = ArkChatTurnUsageProjection.Accumulator(events: Array(events.prefix(split)))
      var restored = first
      restored.append(contentsOf: Array(events.dropFirst(split)))
      check(
        restored.completed == expected,
        "usage checkpoint \(label) split \(split) preserves strict replay admission"
      )
    }
  }

  var finished = ArkChatTurnUsageProjection.Accumulator(events: complete)
  let cachedFinished = finished
  finished.append(usageEvent(7, "assistant/chunk", .object([
    "turn": .number(4), "step": .number(1),
    "chunk": .object(["type": .string("text-delta"), "text": .string("late")]),
  ])))
  check(
    finished.completed[4] == nil && cachedFinished.completed[4] == usage,
    "usage rejects events after the completed turn without mutating a cached value checkpoint"
  )

  let duplicateFinal = Array(complete.prefix(4)) + [complete[3]] + Array(complete.suffix(2))
  let wrongStep = complete.map { event -> ArkHistoryEvent in
    guard event.type == "assistant/chunk" else { return event }
    var data = event.data.objectValue ?? [:]
    data["step"] = .number(99)
    return usageEvent(event.id, event.type, .object(data))
  }
  for (label, events) in [("duplicate final", duplicateFinal), ("wrong step", wrongStep)] {
    var state = ArkChatTurnUsageProjection.Accumulator()
    for event in events { state.append(event) }
    check(state.completed.isEmpty, "incremental usage rejects \(label) instead of double counting")
  }

}
