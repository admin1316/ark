import Foundation
import JiuzhangShellCore

private func batchMessageEvent(
  _ sequence: Int,
  _ type: String,
  _ extra: [String: JSONValue] = [:]
) -> ArkHistoryEvent {
  var data: [String: JSONValue] = ["turn": .number(1), "step": .number(1)]
  data.merge(extra) { _, value in value }
  return ArkHistoryEvent(
    id: sequence, type: type, time: Date(timeIntervalSince1970: Double(sequence)),
    data: .object(data), view: nil
  )
}

private func batchMessageDelta(
  _ sequence: Int,
  _ text: String,
  kind: String = "text-delta",
  block: Int? = nil,
  step: Int = 1
) -> ArkHistoryEvent {
  var chunk: [String: JSONValue] = ["type": .string(kind), "text": .string(text)]
  if let block { chunk["index"] = .number(Double(block)) }
  return batchMessageEvent(sequence, "assistant/chunk", [
    "step": .number(Double(step)), "chunk": .object(chunk),
  ])
}

func runArkMessageBatchContractChecks() {
  let events = [
    batchMessageDelta(1, "文"),
    batchMessageDelta(2, "🙂"),
    batchMessageDelta(3, "思", kind: "reasoning-delta"),
    batchMessageDelta(4, "考", kind: "reasoning-delta"),
    batchMessageDelta(5, "正文", block: 1),
    batchMessageDelta(6, "替换块类型", kind: "reasoning-delta", block: 1),
    batchMessageDelta(7, "恢复文本", block: 1),
    batchMessageEvent(8, "llm/retry"),
    batchMessageEvent(9, "llm/retry-started"),
    batchMessageDelta(10, "retry "),
    batchMessageDelta(11, "prefix"),
    batchMessageEvent(12, "assistant/message", ["message": .object([
      "content": .array([
        .object(["type": .string("text"), "text": .string("Canonical🙂")]),
        .object(["type": .string("reasoning"), "text": .string("Exact thought")]),
      ]),
    ])]),
    batchMessageDelta(13, "ignored after final"),
    batchMessageDelta(14, "next step", step: 2),
  ]
  var serial = ArkMessageProjection()
  for event in events { serial.append(event) }
  for split in 0...events.count {
    var batch = ArkMessageProjection()
    batch.append(contentsOf: Array(events.prefix(split)))
    batch.append(contentsOf: Array(events.dropFirst(split)))
    check(
      batch.messages == serial.messages,
      "message batch boundary \(split) preserves retry, block order, canonical content and identity"
    )
  }

  let deltas = (0..<60_010).map { batchMessageDelta($0, String($0 % 10)) }
  let dense = ArkMessageProjection(events: deltas)
  check(
    dense.messages.count == 1
      && dense.messages.first?.text == (0..<60_010).map { String($0 % 10) }.joined()
      && dense.messages.first?.id == deltas.first?.id
      && dense.messages.first?.time == deltas.first?.time,
    "dense replay batches keep every character and the first stream identity"
  )
  var finalized = ArkMessageProjection(events: Array(events.prefix(12)))
  check(
    !finalized.append(contentsOf: [events[12]])
      && !finalized.append(contentsOf: [])
      && finalized.messages.count == 1
      && finalized.messages.first?.text == "Canonical🙂",
    "empty and finalized batches do not publish false changes or revive a completed partial"
  )
}
