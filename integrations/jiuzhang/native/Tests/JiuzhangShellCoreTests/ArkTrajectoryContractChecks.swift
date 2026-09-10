import Foundation
import JiuzhangShellCore
import JiuzhangShellUI

private func trajectoryEvent(
  _ id: Int,
  _ type: String,
  time: Double,
  _ data: JSONValue,
  view: JSONValue? = nil
) -> ArkHistoryEvent {
  ArkHistoryEvent(
    id: id,
    type: type,
    time: Date(timeIntervalSince1970: time),
    data: data,
    view: view
  )
}

func runArkTrajectoryContractChecks() {
  check(ArkTrajectoryMetrics.toolbarHeight == 32, "trajectory keeps the legacy 32-point toolbar")
  check(ArkTrajectoryMetrics.overviewHeight == 50, "trajectory keeps the legacy 50-point overview")
  check(ArkTrajectoryMetrics.tableHeaderHeight == 30, "trajectory keeps the legacy table header")
  check(ArkTrajectoryMetrics.tableRowHeight == 30, "trajectory keeps the legacy dense row height")
  check(ArkTrajectoryMetrics.eventColumnWidth == 122, "trajectory keeps the legacy event column")
  check(
    ArkTrajectoryMetrics.inspectorMinimumWidth == 300
      && ArkTrajectoryMetrics.inspectorMaximumWidth == 520,
    "trajectory constrains the native resizable inspector"
  )
  check(
    ArkTrajectorySemanticKind.user.label(.zh) == "用户"
      && ArkTrajectorySemanticKind.user.label(.en) == "USER"
      && ArkTrajectorySemanticKind.message.label(.zh) == "助手"
      && ArkTrajectorySemanticKind.message.label(.en) == "ASSISTANT",
    "trajectory role badges follow the single native language preference"
  )
  check(
    ArkTrajectoryUsage(input: 12, output: 4).summary(.zh) == "输入 12 · 输出 4"
      && ArkTrajectoryUsage(input: 12, output: 4).summary(.en) == "Input 12 · Output 4",
    "trajectory usage metadata localizes shell labels without changing token values"
  )

  var events: [ArkHistoryEvent] = [
    trajectoryEvent(10, "turn/start", time: 10, .object(["turn": .number(1)])),
    trajectoryEvent(
      11,
      "step/start",
      time: 11,
      .object(["turn": .number(1), "step": .number(1)])
    ),
    trajectoryEvent(
      12,
      "user/message",
      time: 12,
      .object([
        "id": .string("prompt-1"),
        "role": .string("user"),
        "source": .object(["kind": .string("user")]),
        "content": .array([
          .object(["type": .string("text"), "text": .string("检查轨迹")])
        ]),
      ])
    ),
    trajectoryEvent(
      13,
      "request/header",
      time: 13,
      .object([
        "reason": .string("stable"),
        "header": .object([
          "config": .object([
            "provider": .string("deepseek-official"),
            "model": .string("deepseek-chat"),
          ])
        ]),
      ])
    ),
    trajectoryEvent(
      14,
      "llm/retry",
      time: 14,
      .object([
        "turn": .number(1),
        "step": .number(1),
        "provider": .string("deepseek-official"),
        "retry": .number(1),
        "maxRetries": .number(3),
        "delayMs": .number(500),
        "failure": .object(["message": .string("rate limited")]),
      ])
    ),
  ]

  for index in 0..<300 {
    events.append(trajectoryEvent(
      20 + index,
      "assistant/chunk",
      time: 20 + Double(index) / 100,
      .object([
        "turn": .number(1),
        "step": .number(1),
        "chunk": .object([
          "type": .string("text-delta"),
          "index": .number(0),
          "text": .string(index == 0 ? "流式" : "片段"),
        ]),
      ])
    ))
  }

  events.append(contentsOf: [
    trajectoryEvent(
      400,
      "assistant/message",
      time: 24,
      .object([
        "turn": .number(1),
        "step": .number(1),
        "message": .object([
          "content": .array([
            .object(["type": .string("reasoning"), "text": .string("先检查")]),
            .object(["type": .string("text"), "text": .string("已经完成")]),
            .object([
              "type": .string("image"),
              "attachment": .object(["attachmentId": .string("img-assistant")]),
            ]),
          ])
        ]),
        "usage": .object([
          "inputTokens": .number(120),
          "cacheReadTokens": .number(20),
          "cacheWriteTokens": .number(4),
          "outputTokens": .number(30),
          "reasoningTokens": .number(10),
        ]),
      ])
    ),
    trajectoryEvent(
      401,
      "tool/call",
      time: 25,
      .object([
        "turn": .number(1),
        "step": .number(1),
        "callId": .string("call-1"),
        "name": .string("run_code"),
        "arguments": .string("{\"code\":\"check()\"}"),
      ])
    ),
    trajectoryEvent(
      402,
      "tool/result",
      time: 27,
      .object([
        "turn": .number(1),
        "step": .number(1),
        "message": .object([
          "source": .object(["callId": .string("call-1")]),
          "content": .array([
            .object([
              "type": .string("tool-result"),
              "isError": .bool(false),
              "content": .array([
                .object(["type": .string("text"), "text": .string("ok")]),
                .object([
                  "type": .string("image"),
                  "attachment": .object(["attachmentId": .string("img-tool")]),
                ]),
              ]),
            ])
          ]),
        ]),
      ])
    ),
    trajectoryEvent(
      403,
      "step/end",
      time: 28,
      .object(["turn": .number(1), "step": .number(1)])
    ),
    trajectoryEvent(404, "turn/end", time: 29, .object(["turn": .number(1)])),
  ])

  let projected = ArkTrajectoryProjection.records(from: events)
  check(
    projected.filter { $0.kind == .message }.count == 1,
    "trajectory folds hundreds of assistant chunks into one semantic assistant row"
  )
  check(
    projected.count < 10,
    "trajectory does not expose a raw token-event dump as the ledger"
  )
  let assistant = projected.first { $0.id == "assistant:1:1" }
  check(assistant?.output == "已经完成", "trajectory final assistant message replaces its stream")
  check(assistant?.input == "先检查", "trajectory preserves assistant reasoning in details")
  check(
    assistant?.attachmentIDs == ["img-assistant"],
    "trajectory keeps assistant image references for the native inspector"
  )
  check(
    assistant?.provider == "deepseek-official" && assistant?.model == "deepseek-chat",
    "trajectory carries request provider and model onto the semantic row"
  )
  check(
    assistant?.usage == ArkTrajectoryUsage(
      input: 120,
      cacheRead: 20,
      cacheWrite: 4,
      output: 30,
      reasoning: 10
    ),
    "trajectory carries all token buckets"
  )
  check(
    assistant?.retry?.attempt == 1
      && assistant?.retry?.maximum == 3
      && assistant?.retry?.delayMs == 500,
    "trajectory carries retry attempt, maximum, and delay"
  )
  check(
    assistant?.events.count == 302,
    "trajectory retains the folded raw stream and request header for JSON inspection"
  )
  let tool = projected.first { $0.id == "tool:call-1" }
  check(tool?.output == "ok", "trajectory pairs tool call and result in one row")
  check(
    tool?.attachmentIDs == ["img-tool"],
    "trajectory keeps tool-result image references for the native inspector"
  )
  check(tool?.durationMs == 2_000, "trajectory reports tool wall duration")
  check(tool?.groupTitle == "Step 1", "trajectory groups tool work under its step")

  let withOlderPrefix = ArkTrajectoryProjection.records(from: [
    trajectoryEvent(
      1,
      "user/message",
      time: 1,
      .object([
        "id": .string("older"),
        "source": .object(["kind": .string("user")]),
        "content": .array([
          .object(["type": .string("text"), "text": .string("older")])
        ]),
      ])
    )
  ] + events)
  check(
    withOlderPrefix.first { $0.output == "已经完成" }?.id == assistant?.id,
    "trajectory selection identity is stable after an older-history prepend"
  )

  let compaction = ArkTrajectoryProjection.records(from: [
    trajectoryEvent(
      500,
      "compaction/start",
      time: 30,
      .object(["compactionId": .string("compact-1"), "turn": .null])
    ),
    trajectoryEvent(
      501,
      "compaction/summary",
      time: 33,
      .object([
        "compactionId": .string("compact-1"),
        "summary": .array([
          .object(["type": .string("text"), "text": .string("summary")])
        ]),
        "provider": .string("deepseek-official"),
        "model": .string("deepseek-chat"),
        "shadowedTokenCount": .number(600),
      ])
    ),
    trajectoryEvent(
      502,
      "compaction/end",
      time: 34,
      .object(["compactionId": .string("compact-1"), "turn": .null])
    ),
  ]).first
  check(compaction?.kind == .compacted, "trajectory renders compaction as a semantic row")
  check(
    compaction?.turn == nil
      && compaction?.location(.en) == ArkL10n.text(.trajectoryBetweenTurns, .en)
      && compaction?.location(.zh) == ArkL10n.text(.trajectoryBetweenTurns, .zh),
    "standalone compaction stays between turns"
  )
  check(compaction?.durationMs == 4_000, "compaction duration spans start through end")
  check(compaction?.compaction == "Shadowed 600 tokens", "compaction keeps shadowed token facts")

  var viewport = ArkTrajectoryViewportState()
  viewport.zoom(by: 4, around: 0.5)
  check(viewport.zoom == 4 && viewport.origin == 0.375, "trajectory wheel zoom preserves its anchor")
  viewport.pan(by: 1)
  check(viewport.origin == 0.75, "trajectory pan clamps at the right domain edge")
  viewport.reveal(0.1)
  check(viewport.origin == 0.1, "trajectory selection reveal pans to an offscreen record")
  viewport.zoom(by: 0.0001, around: 0.5)
  check(viewport.zoom == 1 && viewport.origin == 0, "trajectory zoom resets to the full domain")

  let range = ArkTrajectoryTimeRange(start: 0.8, end: 0.2)
  check(range.start == 0.2 && range.end == 0.8, "trajectory normalizes reverse range drags")
  check(range.overlaps(start: 0.7, end: 0.9), "trajectory includes rows overlapping the range")
  check(!range.overlaps(start: 0.81, end: 0.9), "trajectory dims rows outside the range")

  let trajectoryURL = contractNativeRoot.appendingPathComponent(
    "Sources/JiuzhangShellUI/NativeTrajectoryParityView.swift"
  )
  let rootURL = contractNativeRoot.appendingPathComponent(
    "Sources/JiuzhangShellUI/ArkRootView.swift"
  )
  let trajectorySource = (try? String(contentsOf: trajectoryURL, encoding: .utf8)) ?? ""
  let rootSource = (try? String(contentsOf: rootURL, encoding: .utf8)) ?? ""
  check(
    trajectorySource.contains("private final class NativeTrajectoryFeed: ObservableObject")
      && trajectorySource.contains(".throttle(for: .milliseconds(160)")
      && trajectorySource.contains("struct NativeTrajectoryParityView: View, Equatable")
      && trajectorySource.contains("@StateObject private var feed: NativeTrajectoryFeed")
      && !trajectorySource.contains("@ObservedObject var model: ArkAppModel")
      && !trajectorySource.contains(".onChange(of: model.events)"),
    "trajectory isolates live rendering from the 33ms whole-model event stream"
  )
  check(
    rootSource.contains("NativeTrajectoryParityView(model: model).equatable()"),
    "conversation routing preserves the trajectory Equatable render boundary"
  )
  check(
    trajectorySource.contains("mode.title(feed.language)")
      && trajectorySource.contains("ArkL10n.text(.trajectoryDurationMode, feed.language)")
      && trajectorySource.contains(".frame(width: feed.language == .en ? 122 : 94, height: 22)")
      && trajectorySource.contains("ArkL10n.text(.trajectorySearchPlaceholder, feed.language)")
      && trajectorySource.contains("kind.label(feed.language)")
      && trajectorySource.contains("NativeTrajectoryTableHeader(language: feed.language)")
      && trajectorySource.contains("record.kind.label(language)")
      && trajectorySource.contains("record.metadataSummary(language)")
      && trajectorySource.contains("record.location(language)")
      && trajectorySource.contains("NativeMessageImages(model: model, attachmentIDs: record.attachmentIDs)")
      && trajectorySource.contains("nsView.language = language")
      && !trajectorySource.contains("Picker(\"轨迹视图\"")
      && !trajectorySource.contains("TextField(\"搜索轨迹\"")
      && !trajectorySource.contains("let labels = [\"Input\", \"LLM\", \"Tool\"]"),
    "trajectory toolbar, table, badges, metadata, inspector, and AppKit overview share one language source"
  )
}
