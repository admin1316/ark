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
}
