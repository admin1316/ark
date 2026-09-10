import Foundation
import JiuzhangShellCore
import JiuzhangShellUI

/// One raw history event for the status projection.
private func statusEvent(_ id: Int, _ type: String, _ data: JSONValue) -> ArkHistoryEvent {
  ArkHistoryEvent(
    id: id,
    type: type,
    time: Date(timeIntervalSince1970: Double(id)),
    data: data,
    view: nil
  )
}

/// 状态行本地化契约：投影按语言产出固定文案，参数化 key 已登记进 L10n 表。
func runArkChatStatusLocalizationContractChecks() {
  let aborted = statusEvent(
    1, "turn/end",
    .object(["turn": .number(3), "reason": .object(["kind": .string("aborted")])]))
  check(
    ArkChatStatusProjection(events: [aborted]).statuses.first?.title == "回复已停止"
      && ArkChatStatusProjection(events: [aborted], language: .en).statuses.first?.title
        == "Reply stopped",
    "native chat localizes the stopped status row per language"
  )

  let blocked = statusEvent(
    2, "turn/end",
    .object(["turn": .number(4), "reason": .object(["kind": .string("blocked")])]))
  check(
    ArkChatStatusProjection(events: [blocked], language: .en).statuses.first?.title
      == "Request blocked by policy",
    "native chat localizes the policy-blocked status row to English"
  )

  let interrupted = statusEvent(
    3, "turn/end",
    .object(["turn": .number(5), "reason": .object(["kind": .string("interrupted")])]))
  check(
    ArkChatStatusProjection(events: [interrupted], language: .en).statuses.first?.title
      == "Previous run was interrupted",
    "native chat localizes the interrupted status row to English"
  )

  let maxTokens = statusEvent(
    4, "turn/end",
    .object(["turn": .number(6), "reason": .object(["kind": .string("max-tokens")])]))
  let maxRows = ArkChatStatusProjection(events: [maxTokens], language: .en).statuses
  check(
    maxRows.first?.title == "Reply reached the output limit"
      && maxRows.first?.detail
        == "Content may be truncated; continue asking or start a forked session.",
    "native chat localizes the max-tokens status row to English"
  )

  let commandRun = statusEvent(
    5, "command/run",
    .object(["commandId": .string("c-en"), "args": .string("")]))
  check(
    ArkChatStatusProjection(events: [commandRun], language: .en).statuses.first?.title
      == "Command"
      && ArkChatStatusProjection(events: [commandRun], language: .en).statuses.first?.detail
        == "Command running",
    "native chat localizes the unnamed command status fallback to English"
  )

  let commandSettledByTurn = ArkChatStatusProjection(events: [
    statusEvent(
      51, "turn/start",
      .object(["turn": .number(70)])),
    statusEvent(
      52, "command/run",
      .object(["commandId": .string("c-unpaired"), "name": .string("plan")])),
    statusEvent(
      53, "turn/end",
      .object([
        "turn": .number(70),
        "reason": .object(["kind": .string("completed")]),
      ])),
  ]).statuses.first
  check(
    commandSettledByTurn?.phase == .stopped
      && commandSettledByTurn?.detail == "命令已随本轮结束",
    "native chat never leaves an unpaired command row running after the turn ends"
  )

  var crossTurnCommands = ArkChatStatusProjection(events: [
    statusEvent(
      54, "command/run",
      .object([
        "turn": .number(71), "commandId": .string("c-71"), "name": .string("plan"),
      ])),
    statusEvent(
      55, "command/run",
      .object([
        "turn": .number(72), "commandId": .string("c-72"), "name": .string("goal"),
      ])),
  ])
  crossTurnCommands.append(statusEvent(
    56, "turn/end",
    .object([
      "turn": .number(71),
      "reason": .object(["kind": .string("completed")]),
    ])))
  check(
    crossTurnCommands.statuses.first(where: { $0.id == "command-c-71" })?.phase == .stopped
      && crossTurnCommands.statuses.first(where: { $0.id == "command-c-72" })?.phase == .running,
    "native command terminal settlement never crosses turn ownership"
  )
  crossTurnCommands.append(statusEvent(
    57, "turn/end",
    .object(["reason": .object(["kind": .string("completed")])])))
  check(
    crossTurnCommands.statuses.first(where: { $0.id == "command-c-72" })?.phase == .running
      && !crossTurnCommands.statuses.contains(where: { $0.id.hasPrefix("turn-0-") }),
    "native chat ignores a malformed turn boundary without an explicit turn identity"
  )

  let retryEvents = [
    statusEvent(
      6, "llm/retry",
      .object([
        "turn": .number(7), "retryId": .string("r-en"), "retry": .number(0),
        "maxRetries": .number(2), "delayMs": .number(0),
      ])),
    statusEvent(
      7, "turn/end",
      .object(["turn": .number(7), "reason": .object(["kind": .string("completed")])])),
  ]
  check(
    ArkChatStatusProjection(events: retryEvents, language: .en).statuses.first?.title
      == "Model retry finished",
    "native chat localizes the settled retry status row to English"
  )

  let compactionEvents = [
    statusEvent(
      8, "compaction/start",
      .object(["compactionId": .string("cp-en")])),
    statusEvent(
      9, "compaction/summary",
      .object([
        "compactionId": .string("cp-en"),
        "shadowedSeqs": .array([.number(1), .number(2)]),
        "shadowedTokenCount": .number(1200),
      ])),
    statusEvent(
      10, "user/message",
      .object([
        "message": .object([
          "source": .object([
            "kind": .string("plugin"), "plugin": .string("compact"),
            "compactionId": .string("cp-en"),
          ]),
        ]),
      ])),
  ]
  check(
    ArkChatStatusProjection(events: compactionEvents, language: .en).statuses.first?.title
      == "Context compacted",
    "native chat localizes the compaction status title to English"
  )

  check(
    ArkL10n.text(.statusReplyStopped, .zh) == "回复已停止"
      && ArkL10n.text(.statusReplyStopped, .en) == "Reply stopped"
      && ArkL10n.format(.statusCompactionDetail, .zh, arguments: ["3", "1200"])
        == "已替换 3 项 · 约 1200 tokens"
      && ArkL10n.format(.statusCompactionDetail, .en, arguments: ["3", "1200"])
        == "Replaced 3 items · about 1200 tokens"
      && ArkL10n.format(.statusAuthRejectedHTTP, .en, arguments: ["401"])
        == "Provider rejected the API credential (HTTP 401). "
          + "Check that this is an API-platform key and that the provider base URL matches."
      && ArkL10n.text(.statusCommandStopped, .en) == "Command ended with the turn",
    "native chat registers the status copy and parameterized keys in the L10n table"
  )

  let zhCompaction = ArkChatStatusProjection(events: compactionEvents).statuses
  let enCompaction = ArkChatStatusProjection(events: compactionEvents, language: .en).statuses
  check(
    zhCompaction.first?.detail == "已替换 2 项 · 约 1200 tokens"
      && enCompaction.first?.detail == "Replaced 2 items · about 1200 tokens",
    "native chat formats the compaction detail per language"
  )

  let retryDelayEvents = [
    statusEvent(
      11, "llm/retry",
      .object([
        "turn": .number(8), "retryId": .string("r-delay"), "retry": .number(1),
        "maxRetries": .number(3), "delayMs": .number(2500),
      ])),
  ]
  check(
    ArkChatStatusProjection(events: retryDelayEvents).statuses.first?.title
      == "模型请求失败，2.5s 后重试 （1/3）"
      && ArkChatStatusProjection(events: retryDelayEvents, language: .en).statuses.first?.title
        == "Model request failed, retrying in 2.5s (1/3)",
    "native chat formats the delayed retry title per language"
  )

  let retryStartedEvents = [
    statusEvent(
      12, "llm/retry",
      .object(["turn": .number(9), "retryId": .string("r-start"), "retry": .number(1)])),
    statusEvent(
      13, "llm/retry-started",
      .object(["turn": .number(9), "retryId": .string("r-start"), "retry": .number(1)])),
  ]
  check(
    ArkChatStatusProjection(events: retryStartedEvents).statuses.first?.title
      == "正在进行第 1 次模型重试"
      && ArkChatStatusProjection(events: retryStartedEvents, language: .en).statuses.first?.title
        == "Model retry attempt 1 in progress",
    "native chat formats the in-progress retry title per language"
  )

  let authRejected = statusEvent(
    14, "turn/end",
    .object([
      "turn": .number(10),
      "reason": .object([
        "kind": .string("error"),
        "error": .object(["code": .string("AUTH"), "status": .number(401)]),
      ]),
    ]))
  check(
    ArkChatStatusProjection(events: [authRejected]).statuses.first?.detail
      == "Provider 拒绝了 API 凭据（HTTP 401）。请确认这是 API 平台密钥且 Provider 基础 URL 匹配。 · AUTH"
      && ArkChatStatusProjection(events: [authRejected], language: .en).statuses.first?.detail
        == "Provider rejected the API credential (HTTP 401). "
          + "Check that this is an API-platform key and that the provider base URL matches. · AUTH",
    "native chat formats the rejected API credential status per language"
  )

  let modelURL = contractNativeRoot.appendingPathComponent(
    "Sources/JiuzhangShellUI/ArkChatStatusModels.swift"
  )
  guard let model = try? String(contentsOf: modelURL, encoding: .utf8) else {
    check(false, "native chat status model source is readable for contract checks")
    return
  }
  for banned in [
    "命令运行中", "命令完成", "命令失败", "展开查看摘要", "摘要不在当前历史窗口",
    "上下文已压缩", "请求上下文", "正在进行第", "已替换", "后重试", "正在重试模型请求",
    "模型重试后已完成", "模型重试未成功", "模型重试已取消", "回复失败",
    "回复达到最大输出长度", "回复已停止", "请求被策略阻止", "上次运行意外中断",
    "内容可能已被截断", "API credential was rejected", "Provider rejected the API credential",
  ] {
    check(
      !model.contains(banned),
      "native chat status model carries no hardcoded \(banned) copy"
    )
  }
  check(
    model.contains("ArkL10n.")
      && model.contains("language: ArkLanguagePreference"),
    "native chat status model routes status copy through the L10n table"
  )

  check(
    ArkL10n.format(.messageMetricDuration, .zh, arguments: ["1.2s"]) == "用时 1.2s"
      && ArkL10n.format(.messageMetricDuration, .en, arguments: ["1.2s"])
        == "Duration 1.2s"
      && ArkL10n.format(.messageMetricFirstToken, .en, arguments: ["900ms"])
        == "First response 900ms"
      && ArkL10n.format(.messageMetricFirstToken, .zh, arguments: ["900ms"])
        == "首响应 900ms"
      && ArkL10n.text(.sessionActivityFailed, .en) == "Task stopped unexpectedly"
      && ArkL10n.format(.queueCount, .en, arguments: ["2"]) == "2 queued messages",
    "native chat localizes dynamic metrics, activity state, and queue counts"
  )

  let rootURL = contractNativeRoot.appendingPathComponent(
    "Sources/JiuzhangShellUI/ArkRootView.swift"
  )
  let toolURL = contractNativeRoot.appendingPathComponent(
    "Sources/JiuzhangShellUI/NativeToolPresentationView.swift"
  )
  let longTaskURL = contractNativeRoot.appendingPathComponent(
    "Sources/JiuzhangShellUI/NativeLongTaskSummaryView.swift"
  )
  guard
    let root = try? String(contentsOf: rootURL, encoding: .utf8),
    let tool = try? String(contentsOf: toolURL, encoding: .utf8),
    let longTask = try? String(contentsOf: longTaskURL, encoding: .utf8)
  else {
    check(false, "native localized presentation sources are readable")
    return
  }
  check(
    root.contains(".messageMetricDuration")
      && root.contains(".messageMetricFirstToken")
      && root.contains("state.label(model.languagePreference)")
      && root.contains(".queueCount")
      && root.contains(".permissionDangerTitle")
      && root.contains(".accessibilityLabel(ArkL10n.text(.composerAttach")
      && !root.contains("values.append(\"用时")
      && !root.contains("values.append(\"首 token")
      && !root.contains("case .failed: return \"任务异常停止\""),
    "native chat dynamic shell copy cannot bypass the selected language"
  )
  check(
    tool.contains("ArkL10n.text(.toolTodoTitle, language)")
      && tool.contains("ArkL10n.format(")
      && longTask.contains(".executionMoreSteps")
      && !tool.contains("Label(\"任务清单\"")
      && !longTask.contains("Text(\"还有"),
    "native tool and long-task summaries localize dynamic shell copy"
  )
}
