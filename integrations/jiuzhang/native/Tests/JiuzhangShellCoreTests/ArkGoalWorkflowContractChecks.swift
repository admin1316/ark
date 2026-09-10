import Foundation
import JiuzhangShellCore
import JiuzhangShellUI

func runArkGoalWorkflowContractChecks() {
  let projection: JSONValue = .object([
    "goal": .object([
      "id": .string("goal-1"),
      "revision": .number(7),
      "objective": .string("Ship native workflow parity"),
      "phase": .string("paused"),
      "maxGoalRounds": .number(12),
    ]),
    "roundsStarted": .number(4),
  ])
  let goal = ArkGoalSnapshot(projection: projection)
  check(
    goal?.id == "goal-1"
      && goal?.revision == 7
      && goal?.objective == "Ship native workflow parity"
      && goal?.phase == .paused
      && goal?.maxGoalRounds == 12
      && goal?.roundsStarted == 4,
    "native goal projection preserves the complete durable CAS snapshot"
  )

  let blocked = ArkGoalSnapshot(projection: .object([
    "goal": .object([
      "id": .string("goal-2"),
      "revision": .number(2),
      "objective": .string("Wait for a decision"),
      "phase": .string("blocked"),
      "blockedReason": .object([
        "code": .string("needs-input"),
        "message": .string("Choose a release channel."),
      ]),
      "maxGoalRounds": .number(8),
    ]),
    "roundsStarted": .number(3),
  ]))
  check(
    blocked?.blockedReason == ArkGoalBlockReason(
      code: "needs-input",
      message: "Choose a release channel."
    ),
    "native goal projection preserves a typed blocked reason"
  )
  check(
    ArkGoalSnapshot(projection: .object([
      "goal": .object([
        "id": .string("goal-bad"),
        "revision": .number(1.5),
        "objective": .string("bad"),
        "phase": .string("active"),
        "maxGoalRounds": .number(1),
      ]),
      "roundsStarted": .number(0),
    ])) == nil,
    "native goal mutation authority fails closed on malformed projection revisions"
  )

  if let goal {
    check(
      ArkGoalMutation.edit(objective: "  Updated objective  ").request(
        sessionID: "session-1",
        goal: goal
      ) == ArkGoalMutationRequest(
        method: "goal/edit",
        args: [
          "agentId": .string("session-1"),
          "request": .object([
            "ref": .object([
              "id": .string("goal-1"),
              "revision": .number(7),
            ]),
            "objective": .string("Updated objective"),
          ]),
        ]
      ),
      "native goal edit sends the exact visible id and revision with a normalized objective"
    )
    for (mutation, method) in [
      (ArkGoalMutation.pause, "goal/pause"),
      (.resume, "goal/resume"),
      (.clear, "goal/clear"),
    ] {
      let request = mutation.request(sessionID: "session-1", goal: goal)
      check(
        request?.method == method
          && request?.args["agentId"]?.stringValue == "session-1"
          && request?.args["request"]?["ref"]?["id"]?.stringValue == "goal-1"
          && request?.args["request"]?["ref"]?["revision"]?.numberValue == 7,
        "native \(method) remains revision-safe"
      )
    }
  }

  let workflowEvents = [
    workflowEvent(0, "tool/call", [
      "turn": .number(1), "step": .number(1),
      "callId": .string("workflow-root"), "name": .string("workflow"),
      "arguments": .string("{}"),
    ]),
    workflowEvent(1, "tool-workflow/run-start", [
      "runId": .string("run-1"), "rootCallId": .string("workflow-root"),
      "name": .string("Repository audit"),
    ]),
    workflowEvent(2, "tool-workflow/agent-start", [
      "runId": .string("run-1"), "seq": .number(1),
      "label": .string("Inspect files"), "phase": .string("discovery"),
      "childId": .string("child-1"),
    ]),
    workflowEvent(3, "tool-workflow/agent-end", [
      "runId": .string("run-1"), "seq": .number(1), "outcome": .string("completed"),
    ]),
    workflowEvent(4, "tool-workflow/agent-start", [
      "runId": .string("run-1"), "seq": .number(2),
      "label": .string("Run checks"), "phase": .string("validation"),
      "childId": .string("child-2"),
    ]),
    workflowEvent(5, "tool-workflow/agent-end", [
      "runId": .string("run-1"), "seq": .number(2), "outcome": .string("failed"),
    ]),
    workflowEvent(6, "tool-workflow/run-end", [
      "runId": .string("run-1"), "stopReason": .string("error"),
    ]),
  ]
  let workflow = ArkToolProjection(events: workflowEvents).activities
    .first(where: { $0.id == "workflow:run-1" })
    .flatMap { ArkWorkflowRunPresentation(activity: $0) }
  check(
    workflow?.id == "run-1"
      && workflow?.name == "Repository audit"
      && workflow?.execution.phase == .failed
      && workflow?.phases.map(\.title) == ["discovery", "validation"]
      && workflow?.phases.first?.members.first?.childSessionID == "child-1"
      && workflow?.phases.last?.members.first?.childSessionID == "child-2"
      && workflow?.phases.last?.members.first?.phase == .failed,
    "native workflow replay groups durable members by phase and retains failed child navigation"
  )

  let recoveredWorkflow = ArkToolProjection(events: [
    workflowEvent(10, "tool/call", [
      "turn": .number(2), "step": .number(1),
      "callId": .string("workflow-recovered-root"), "name": .string("workflow"),
      "arguments": .string("{}"),
    ]),
    workflowEvent(11, "tool-workflow/run-start", [
      "runId": .string("run-recovered"),
      "rootCallId": .string("workflow-recovered-root"),
      "name": .string("Recovered workflow"),
    ]),
    workflowEvent(12, "turn/end", [
      "turn": .number(2),
      "reason": .object(["kind": .string("completed")]),
    ]),
  ]).activities.first(where: { $0.id == "workflow:run-recovered" })
  check(
    recoveredWorkflow?.turn == 2
      && recoveredWorkflow?.execution?.phase == .cancelled
      && recoveredWorkflow?.execution?.stopReason == "missing-result-at-turn-end",
    "native recovered turn settles a workflow whose durable run-end append was lost"
  )

  let legacyWorkflow = ArkToolProjection(events: [
    workflowEvent(20, "turn/start", ["turn": .number(3)]),
    workflowEvent(21, "tool-workflow/run-start", [
      "runId": .string("run-legacy"),
      "name": .string("Legacy workflow"),
    ]),
    workflowEvent(22, "turn/end", [
      "turn": .number(3),
      "reason": .object(["kind": .string("completed")]),
    ]),
  ]).activities.first(where: { $0.id == "workflow:run-legacy" })
  check(
    legacyWorkflow?.turn == 3 && legacyWorkflow?.execution?.phase == .cancelled,
    "native workflow replay keeps legacy run-start history readable and terminal"
  )

  let truncatedLegacyWorkflow = ArkToolProjection(events: [
    workflowEvent(24, "tool-workflow/run-start", [
      "runId": .string("run-truncated-legacy"),
      "name": .string("Truncated legacy workflow"),
    ]),
    workflowEvent(25, "turn/end", [
      "turn": .number(9),
      "reason": .object(["kind": .string("completed")]),
    ]),
  ]).activities.first(where: { $0.id == "workflow:run-truncated-legacy" })
  check(
    truncatedLegacyWorkflow?.execution?.phase == .cancelled,
    "native truncated legacy workflow uses the next terminal boundary instead of a permanent timer"
  )

  let deferredOwner = ArkToolProjection(events: [
    workflowEvent(30, "turn/start", ["turn": .number(4)]),
    workflowEvent(31, "tool-workflow/run-start", [
      "runId": .string("run-deferred-owner"),
      "rootCallId": .string("workflow-late-root"),
      "name": .string("Deferred owner"),
    ]),
    workflowEvent(32, "tool/call", [
      "turn": .number(4), "step": .number(7),
      "callId": .string("workflow-late-root"), "name": .string("workflow"),
      "arguments": .string("{}"),
    ]),
    workflowEvent(33, "turn/end", [
      "turn": .number(4),
      "reason": .object(["kind": .string("completed")]),
    ]),
  ]).activities.first(where: { $0.id == "workflow:run-deferred-owner" })
  check(
    deferredOwner?.turn == 4
      && deferredOwner?.step == 7
      && deferredOwner?.execution?.phase == .cancelled,
    "native workflow replay backfills a current owner that arrives after run-start"
  )

  let modelURL = contractNativeRoot.appendingPathComponent("Sources/JiuzhangShellUI/ArkAppModel.swift")
  let rootURL = contractNativeRoot.appendingPathComponent("Sources/JiuzhangShellUI/ArkRootView.swift")
  let executionURL = contractNativeRoot.appendingPathComponent(
    "Sources/JiuzhangShellUI/NativeExecutionActivityView.swift"
  )
  let l10nURL = contractNativeRoot.appendingPathComponent("Sources/JiuzhangShellUI/ArkL10n.swift")
  guard
    let model = try? String(contentsOf: modelURL, encoding: .utf8),
    let root = try? String(contentsOf: rootURL, encoding: .utf8),
    let execution = try? String(contentsOf: executionURL, encoding: .utf8),
    let l10n = try? String(contentsOf: l10nURL, encoding: .utf8)
  else {
    check(false, "native goal and workflow sources are readable")
    return
  }
  check(
    model.contains("mutation.request(sessionID: sessionID, goal: goal)")
      && model.contains("client.remoteCall(method: request.method, args: request.args)")
      && !model.contains("client.call(method: request.method, payload: request.payload)")
      && model.contains("guard goalMutationToken == nil"),
    "native goal owner serializes revision-safe Host mutations"
  )
  check(
    root.contains("private struct NativeGoalDock")
      && root.contains("ark.chat.goal.objective")
      && root.contains(".focused($objectiveFocused)")
      && root.contains("mutate(.pause)")
      && root.contains("mutate(.resume)")
      && root.contains("mutate(.clear)"),
    "native composer exposes edit pause resume and clear on the projected goal"
  )
  check(
    root.contains("plan?[\"pending\"]?.boolValue == true")
      && root.contains(".disabled(planPending)")
      && !root.contains("plan?[\"wanted\"]")
      && !root.contains("plan?[\"running\"]"),
    "native plan dock consumes the exact active and pending wire projection"
  )
  check(
    execution.contains("ArkWorkflowRunPresentation(activity: activity)")
      && execution.contains("ForEach(workflow.phases)")
      && execution.contains("openChildSession(childSessionID)")
      && execution.contains("ark.chat.workflow.member"),
    "native workflow card renders run phase members and child-session navigation"
  )
  check(
    l10n.contains("目标进行中")
      && l10n.contains("Goal active")
      && l10n.contains("工作流 · {0}")
      && l10n.contains("Workflow · {0}"),
    "native goal and workflow chrome switches through ArkL10n"
  )
}

private func workflowEvent(
  _ id: Int,
  _ type: String,
  _ data: [String: JSONValue]
) -> ArkHistoryEvent {
  ArkHistoryEvent(
    id: id,
    type: type,
    time: Date(timeIntervalSince1970: Double(id)),
    data: .object(data),
    view: nil
  )
}
