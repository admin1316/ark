import Foundation
import JiuzhangShellCore
import JiuzhangShellUI

func runArkInteractionAPIContractChecks() {
  let baseURL = URL(string: "http://127.0.0.1:3080")!
  check(
    ArkInteractionAPIContract.respondURL(baseURL: baseURL).absoluteString
      == "http://127.0.0.1:3080/api/respond",
    "native interaction responses use the Host response carrier"
  )
  let exportURL = try? ArkInteractionAPIContract.sessionExportURL(
    baseURL: baseURL,
    sessionID: "session/one",
    includeDescendants: true
  )
  check(
    exportURL?.path == "/api/session/export",
    "native session export uses the final Host-owned slash endpoint"
  )
  check(
    exportURL?.path != "/api/session.export",
    "native session export does not use the retired dot download carrier"
  )
  check(
    URLComponents(url: exportURL!, resolvingAgainstBaseURL: false)?
      .queryItems?.first(where: { $0.name == "sessionId" })?.value == "session/one",
    "native session export percent-encodes the session id as a query value"
  )
  check(
    URLComponents(url: exportURL!, resolvingAgainstBaseURL: false)?
      .queryItems?.first(where: { $0.name == "includeDescendants" })?.value == "true",
    "native session export requests descendant logs explicitly"
  )
  check(
    ArkInteractionAPIContract.sessionExportFilename(sessionID: "session/one")
      == "dsh-session-session_one.zip",
    "native session export filename matches Host sanitization"
  )

  let approvalFrame = ArkEventFrame(
    channel: .mux,
    rpcID: "approval-rpc",
    method: "approval/requested",
    payload: .object([
      "type": .string("approval/requested"),
      "sessionId": .string("session-1"),
      "approvalId": .string("approval-1"),
      "toolName": .string("bash"),
      "callId": .string("call-1"),
      "reason": .string("需要写入工作区"),
    ])
  )
  let approval = ArkInteractionAPIContract.approvalRequest(from: approvalFrame)
  check(approval?.toolName == "bash", "native approval parser preserves the tool name")
  check(approval?.reason == "需要写入工作区", "native approval parser preserves the reason")
  if let approval {
    let body = ArkInteractionAPIContract.approvalResponseBody(
      request: approval,
      decision: .allowOnce
    )
    check(body["type"]?.stringValue == "client-response", "native approval answer is a client response")
    check(body["rpcId"]?.stringValue == "approval-rpc", "native approval answer echoes the server rpc id")
    check(
      body["result"]?["value"]?["approvalId"]?.stringValue == "approval-1",
      "native approval answer preserves the audit correlation id"
    )
    check(
      body["result"]?["value"]?["outcome"]?.stringValue == "allowed-once",
      "native approval answer uses the client-admitted grant vocabulary"
    )
  }

  let questionFrame = ArkEventFrame(
    channel: .mux,
    rpcID: "question-rpc",
    method: "question/requested",
    payload: .object([
      "type": .string("question/requested"),
      "sessionId": .string("session-1"),
      "questions": .array([
        .object([
          "id": .string("plan"),
          "question": .string("是否执行？"),
          "detail": .string("# 计划"),
          "options": .array([
            .object(["label": .string("确认执行"), "description": .string("开始修改")]),
            .object(["label": .string("拒绝")]),
          ]),
          "intent": .object([
            "kind": .string("plan-review"),
            "approve": .string("确认执行"),
          ]),
        ]),
      ]),
    ])
  )
  let question = ArkInteractionAPIContract.questionRequest(from: questionFrame)
  check(question?.questions.first?.detail == "# 计划", "native question parser preserves detail markdown")
  check(question?.questions.first?.options.count == 2, "native question parser preserves every offered option")
  check(
    question?.questions.first?.intent == .planReview(approveLabel: "确认执行"),
    "native question parser preserves plan-review intent"
  )
  if let question {
    let review = ArkInteractionAPIContract.planReview(from: question)
    check(review?.questionID == "plan", "native plan review preserves the correlated question id")
    check(review?.plan == "# 计划", "native plan review preserves the markdown plan body")
    check(review?.approve.label == "确认执行", "native plan review identifies approval by intent label")
    check(review?.decline?.label == "拒绝", "native plan review preserves the optional decline label")
    let answer = try? ArkInteractionAPIContract.questionResponseBody(
      request: question,
      answers: [ArkQuestionAnswer(id: "plan", selected: ["确认执行"])]
    )
    check(answer?["rpcId"]?.stringValue == "question-rpc", "native question answer echoes the server rpc id")
    check(
      answer?["result"]?["value"]?["answer"]?["answers"]?.arrayValue?.first?["selected"]?
        .arrayValue?.first?.stringValue == "确认执行",
      "native question answer preserves the selected label verbatim"
    )
    let cancellation = ArkInteractionAPIContract.questionCancellationBody(request: question)
    check(
      cancellation["result"]?["error"]?["code"]?.stringValue == "cancelled",
      "native question cancellation uses the Host-admitted error code"
    )
    do {
      _ = try ArkInteractionAPIContract.questionResponseBody(
        request: question,
        answers: [ArkQuestionAnswer(id: "plan", selected: ["不存在"])]
      )
      check(false, "native question answers reject labels the Host did not offer")
    } catch {
      check(true, "native question answers reject labels the Host did not offer")
    }

    let multiSelect = ArkQuestionRequest(
      rpcID: question.rpcID,
      sessionID: question.sessionID,
      questions: question.questions.map { value in
        ArkQuestion(
          id: value.id,
          question: value.question,
          detail: value.detail,
          header: value.header,
          options: value.options,
          multiSelect: true,
          intent: value.intent
        )
      }
    )
    check(
      ArkInteractionAPIContract.planReview(from: multiSelect) == nil,
      "native plan review leaves multi-select requests to the generic question flow"
    )

    let ternary = ArkQuestionRequest(
      rpcID: question.rpcID,
      sessionID: question.sessionID,
      questions: [ArkQuestion(
        id: "plan",
        question: "是否执行？",
        detail: "# 计划",
        options: [
          ArkQuestionOption(label: "确认执行"),
          ArkQuestionOption(label: "拒绝"),
          ArkQuestionOption(label: "稍后"),
        ],
        intent: .planReview(approveLabel: "确认执行")
      )]
    )
    check(
      ArkInteractionAPIContract.planReview(from: ternary) == nil,
      "native plan review leaves three-way decisions fully answerable in the generic flow"
    )
  }

  let queueFrame = ArkEventFrame(
    channel: .mux,
    rpcID: "queue-rpc",
    method: "session/queue",
    payload: .object([
      "type": .string("session/queue"),
      "sessionId": .string("session-1"),
      "items": .array([
        .object([
          "id": .string("message-1"),
          "placement": .string("queued"),
          "message": .object([
            "content": .array([
              .object(["type": .string("text"), "text": .string("稍后执行")]),
            ]),
          ]),
        ]),
      ]),
    ])
  )
  let queue = ArkInteractionAPIContract.queueSnapshot(from: queueFrame)
  check(queue?.items.first?.text == "稍后执行", "native queue parser preserves pending text")
  check(queue?.items.first?.placement == .queued, "native queue parser preserves Host placement")
  let steer = ArkInteractionAPIContract.queueMutationPayload(
    sessionID: "session-1",
    itemID: "message-1",
    mutation: .steer
  )
  check(steer["action"]?["kind"]?.stringValue == "steer", "native queue mutation uses strict steer")

  let prompt = try? ArkInteractionAPIContract.promptPayload(
    sessionID: "session-1",
    invocationID: "invocation-1",
    text: "看这张图",
    images: [ArkPromptImage(mediaType: .png, data: Data([0, 1, 2]), name: "图.png")],
    mode: .queue,
    timeZone: "Asia/Shanghai"
  )
  check(prompt?["mode"]?.stringValue == "queue", "native prompt preserves queue delivery")
  check(
    prompt?["invocationId"]?.stringValue == "invocation-1",
    "native prompt carries one stable invocation id for idempotent Host delivery"
  )
  check(
    prompt?["content"]?.arrayValue?.first?["data"]?.stringValue == "AAEC",
    "native prompt encodes image bytes in the Host inline format"
  )
  check(
    prompt?["content"]?.arrayValue?.last?["text"]?.stringValue == "看这张图",
    "native prompt keeps text after ordered images"
  )

  let image = try? ArkInteractionAPIContract.sessionImage(from: .object([
    "attachment": .object([
      "attachmentId": .string("attachment-1"),
      "mediaType": .string("image/png"),
      "bytes": .number(3),
      "width": .number(2),
      "height": .number(1),
      "name": .string("图.png"),
    ]),
    "data": .string("AAEC"),
  ]))
  check(image?.data == Data([0, 1, 2]), "native attachment parser decodes authorized image bytes")
  check(image?.name == "图.png", "native attachment parser preserves the original name")

  check(
    ArkL10n.text(.planReviewHeader, .zh) == "计划待审阅"
      && ArkL10n.text(.planReviewHeader, .en) == "Plan ready for review",
    "native decision takeovers switch their shell copy from one language owner"
  )

  let rootURL = contractNativeRoot.appendingPathComponent("Sources/JiuzhangShellUI/ArkRootView.swift")
  guard let root = try? String(contentsOf: rootURL, encoding: .utf8) else {
    check(false, "native decision interaction source is readable")
    return
  }
  let composer = interactionSourceSlice(
    root,
    from: "private struct NativeComposer",
    through: "private struct NativeComposerSuggestionPanel"
  )
  check(
    composer?.contains("ArkInteractionAPIContract.planReview(from: question)") == true
      && composer?.contains("NativePlanReviewPanel") == true
      && composer?.contains("if model.selectedPendingInteraction == nil") == true,
    "native composer routes plan-review separately and fully yields its ordinary controls to takeovers"
  )
  let approvalPanel = interactionSourceSlice(
    root,
    from: "private struct NativeApprovalPanel",
    through: "private struct NativePlanReviewPanel"
  )
  check(
    approvalPanel?.contains("ark.interaction.approval.reject") == true
      && approvalPanel?.contains("ark.interaction.approval.allow-once") == true
      && approvalPanel?.contains("interactionIsResponding(request.id)") == true,
    "native approval takeover keeps one-shot correlated allow and reject actions"
  )
  let planPanel = interactionSourceSlice(
    root,
    from: "private struct NativePlanReviewPanel",
    through: "private struct NativeQuestionPanel"
  )
  check(
    planPanel?.contains("ark.interaction.plan-review.discuss") == true
      && planPanel?.contains("ark.interaction.plan-review.decline") == true
      && planPanel?.contains("ark.interaction.plan-review.approve") == true
      && planPanel?.contains("NativeMarkdownText(text: review.plan)") == true,
    "native plan review owns its markdown decision card and all reachable outcomes"
  )
  let questionPanel = interactionSourceSlice(
    root,
    from: "private struct NativeQuestionPanel",
    through: "private struct NativeDangerPermissionConfirmation"
  )
  check(
    questionPanel?.contains("ark.interaction.question.cancel") == true
      && questionPanel?.contains("ark.interaction.question.submit") == true
      && questionPanel?.contains("skipAndSubmit()") == true
      && questionPanel?.contains("!currentIsAnswered") == true,
    "native generic questions retain explicit cancel, skip, validation and submit behavior"
  )
  let queueDock = interactionSourceSlice(
    root,
    from: "private struct NativeQueueDock",
    through: "private struct NativeSessionStatsBar"
  )
  check(
    queueDock?.contains("ark.queue.dock") == true
      && queueDock?.contains("ark.queue.toggle") == true
      && queueDock?.contains("ark.queue.item.\\(item.id)") == true
      && queueDock?.contains("ark.queue.edit.\\(item.id)") == true
      && queueDock?.contains("ark.queue.steer.\\(item.id)") == true
      && queueDock?.contains("ark.queue.remove.\\(item.id)") == true
      && queueDock?.contains("ark.queue.editor.\\(item.id)") == true
      && queueDock?.contains("ark.queue.save.\\(item.id)") == true
      && root.contains("ark.queue.steering.\\(item.id)"),
    "native queue exposes stable per-occurrence controls and steering evidence for candidate acceptance"
  )
  check(
    ArkL10n.text(.queueRemove, .zh) == "移除"
      && ArkL10n.text(.queueRemove, .en) == "Remove",
    "native queue destructive action has one bilingual accessibility owner"
  )
}

private func interactionSourceSlice(
  _ source: String,
  from start: String,
  through end: String
) -> String? {
  guard
    let startRange = source.range(of: start),
    let endRange = source.range(
      of: end,
      range: startRange.lowerBound..<source.endIndex
    )
  else { return nil }
  return String(source[startRange.lowerBound..<endRange.upperBound])
}
