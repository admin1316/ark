import Foundation
import JiuzhangShellCore
import JiuzhangShellUI

func runArkLongTaskSummaryContractChecks() {
  check(
    ArkLongTaskSummary.resolve(
      sessionRunning: false,
      pendingInteractionCount: 0,
      toolActivities: [],
      jobs: [],
      goal: nil,
      todos: []
    ) == nil,
    "native long-task summary stays absent without typed active work"
  )

  let startedAt = Date(timeIntervalSince1970: 100)
  let running = ArkToolActivity(
    id: "call-build",
    sequence: 20,
    name: "bash",
    arguments: #"{"command":"swift test"}"#,
    rawCall: .object([:]),
    callPresentation: .object([
      "card": .string("terminal"),
      "title": .string("swift test"),
    ]),
    execution: ArkExecutionActivity(
      startedAt: startedAt,
      steps: [
        ArkExecutionStep(
          id: "compile",
          name: "Compile",
          startedAt: startedAt,
          finishedAt: startedAt.addingTimeInterval(4),
          phase: .succeeded
        ),
        ArkExecutionStep(
          id: "tests",
          name: "Tests",
          startedAt: startedAt.addingTimeInterval(4),
          phase: .running
        ),
      ]
    )
  )
  let goal = ArkGoalSnapshot(projection: .object([
    "goal": .object([
      "id": .string("goal-1"),
      "revision": .number(1),
      "objective": .string("Close Chat-A"),
      "phase": .string("active"),
      "maxGoalRounds": .number(8),
    ]),
    "roundsStarted": .number(1),
  ]))
  let activeTodos = ArkTodoListPresentation(projection: .array([
    .object(["content": .string("Compile"), "status": .string("completed")]),
    .object(["content": .string("Test"), "status": .string("in_progress")]),
  ]))
  check(
    goal?.phase == .active
      && activeTodos?.items.map(\.status) == ["completed", "in_progress"],
    "native long-task inputs decode through the canonical typed goal and todo owners"
  )
  let summary = ArkLongTaskSummary.resolve(
    sessionRunning: true,
    pendingInteractionCount: 0,
    toolActivities: [running],
    jobs: [],
    goal: goal,
    todos: activeTodos?.items ?? []
  )
  check(
    summary?.title == "Close Chat-A"
      && summary?.detail == "swift test"
      && summary?.phase == .running
      && summary?.startedAt == startedAt
      && summary?.completedCount == 1
      && summary?.totalCount == 2
      && summary?.failedCount == 0
      && summary?.items.map(\.title) == ["Compile", "Tests"]
      && summary?.executionActivityID == "call-build",
    "native long-task summary prefers the durable goal while exposing current execution progress"
  )

  let waiting = ArkLongTaskSummary.resolve(
    sessionRunning: true,
    pendingInteractionCount: 1,
    toolActivities: [running],
    jobs: [],
    goal: nil,
    todos: []
  )
  check(
    waiting?.phase == .needsDecision && waiting?.title == "等待你的决策",
    "native long-task summary makes a typed pending interaction the visible blocking state"
  )

  let activeJob = ArkSessionJobPresentation(.object([
    "id": .string("bash-1"),
    "kind": .string("bash"),
    "label": .string("sleep 180"),
    "status": .string("running"),
    "detail": .string("background command"),
    "startedAt": .number(123_000),
  ]))
  check(
    activeJob?.isActive == true && activeJob?.executionPhase == .running,
    "native long-task jobs decode once into the typed session job owner"
  )
  let job = ArkLongTaskSummary.resolve(
    sessionRunning: false,
    pendingInteractionCount: 0,
    toolActivities: [],
    jobs: activeJob.map { [$0] } ?? [],
    goal: nil,
    todos: []
  )
  check(
    job?.title == "sleep 180"
      && job?.detail == "background command"
      && job?.startedAt == Date(timeIntervalSince1970: 123)
      && job?.items.first?.id == "job:bash-1",
    "native long-task summary folds session/jobs without parsing transcript prose"
  )

  let stoppingJob = ArkSessionJobPresentation(.object([
    "id": .string("bash-stop"),
    "kind": .string("bash"),
    "label": .string("stop sleep"),
    "status": .string("stopping"),
    "startedAt": .number(124_000),
  ]))
  check(
    ArkLongTaskSummary.resolve(
      sessionRunning: false,
      pendingInteractionCount: 0,
      toolActivities: [],
      jobs: stoppingJob.map { [$0] } ?? [],
      goal: nil,
      todos: []
    )?.phase == .stopping,
    "native long-task summary retains an explicitly stopping background job"
  )

  let completedJob = ArkSessionJobPresentation(.object([
    "id": .string("bash-done"),
    "kind": .string("bash"),
    "label": .string("finished sleep"),
    "status": .string("completed"),
    "startedAt": .number(125_000),
    "finishedAt": .number(126_000),
  ]))
  check(
    ArkLongTaskSummary.resolve(
      sessionRunning: false,
      pendingInteractionCount: 0,
      toolActivities: [],
      jobs: completedJob.map { [$0] } ?? [],
      goal: nil,
      todos: []
    ) == nil,
    "native long-task summary does not keep a terminal background job active"
  )
  for status in ["killed", "failed"] {
    let terminalJob = ArkSessionJobPresentation(.object([
      "id": .string("bash-\(status)"),
      "kind": .string("bash"),
      "label": .string("terminal \(status)"),
      "status": .string(status),
      "startedAt": .number(127_000),
      "finishedAt": .number(128_000),
    ]))
    check(
      ArkLongTaskSummary.resolve(
        sessionRunning: false,
        pendingInteractionCount: 0,
        toolActivities: [],
        jobs: terminalJob.map { [$0] } ?? [],
        goal: nil,
        todos: []
      ) == nil,
      "native long-task summary does not revive a \(status) background job"
    )
  }

  let backgroundWithPoll = ArkLongTaskSummary.resolve(
    sessionRunning: true,
    pendingInteractionCount: 0,
    toolActivities: [running],
    jobs: [ArkSessionJobPresentation(.object([
      "id": .string("bash-1"),
      "kind": .string("bash"),
      "label": .string("sleep 180"),
      "status": .string("running"),
      "startedAt": .number(90_000),
    ]))].compactMap { $0 },
    goal: nil,
    todos: []
  )
  check(
    backgroundWithPoll?.title == "sleep 180"
      && backgroundWithPoll?.detail == "swift test"
      && backgroundWithPoll?.startedAt == Date(timeIntervalSince1970: 90),
    "native long-task summary keeps the durable background job stable while polling tools remain secondary"
  )

  let completedTodos = ArkTodoListPresentation(projection: .array([
    .object(["content": .string("One"), "status": .string("completed")]),
    .object(["content": .string("Two"), "status": .string("completed")]),
  ]))
  let completed = ArkLongTaskSummary.resolve(
    sessionRunning: false,
    pendingInteractionCount: 0,
    toolActivities: [],
    jobs: [],
    goal: nil,
    todos: completedTodos?.items ?? []
  )
  check(
    completed == nil,
    "native long-task summary exits after the turn instead of persisting completed todos"
  )

  check(
    ArkLongTaskSummary.resolve(
      sessionRunning: false,
      pendingInteractionCount: 0,
      toolActivities: [running],
      jobs: [],
      goal: nil,
      todos: []
    ) == nil,
    "native long-task summary does not promote a stale historical tool row to session liveness"
  )

  let staleIncompleteTodos = ArkTodoListPresentation(projection: .array([
    .object(["content": .string("One"), "status": .string("completed")]),
    .object(["content": .string("Two"), "status": .string("pending")]),
  ]))
  check(
    ArkLongTaskSummary.resolve(
      sessionRunning: false,
      pendingInteractionCount: 0,
      toolActivities: [],
      jobs: [],
      goal: nil,
      todos: staleIncompleteTodos?.items ?? []
    ) == nil,
    "native long-task summary does not mistake stale incomplete todos for a running turn"
  )

  let finalizing = ArkLongTaskSummary.resolve(
    sessionRunning: true,
    pendingInteractionCount: 0,
    toolActivities: [],
    jobs: [],
    goal: nil,
    todos: completedTodos?.items ?? []
  )
  check(
    finalizing?.phase == .running
      && finalizing?.completedCount == 2
      && finalizing?.totalCount == 2,
    "native long-task summary may retain completed step context only while the turn is still running"
  )

  let pausedGoal = ArkGoalSnapshot(projection: .object([
    "goal": .object([
      "id": .string("goal-paused"),
      "revision": .number(2),
      "objective": .string("Resume after review"),
      "phase": .string("paused"),
      "maxGoalRounds": .number(8),
    ]),
    "roundsStarted": .number(2),
  ]))
  let paused = ArkLongTaskSummary.resolve(
    sessionRunning: false,
    pendingInteractionCount: 0,
    toolActivities: [],
    jobs: [],
    goal: pausedGoal,
    todos: staleIncompleteTodos?.items ?? []
  )
  check(
    paused == nil,
    "native long-task summary leaves an idle paused goal to the dedicated goal dock"
  )

  let activeIdle = ArkLongTaskSummary.resolve(
    sessionRunning: false,
    pendingInteractionCount: 0,
    toolActivities: [],
    jobs: [],
    goal: goal,
    todos: staleIncompleteTodos?.items ?? []
  )
  check(
    activeIdle == nil,
    "native long-task summary does not call an idle durable goal active processing"
  )

  let completedGoal = ArkGoalSnapshot(projection: .object([
    "goal": .object([
      "id": .string("goal-complete"),
      "revision": .number(3),
      "objective": .string("Already complete"),
      "phase": .string("complete"),
      "maxGoalRounds": .number(8),
    ]),
    "roundsStarted": .number(3),
  ]))
  check(
    ArkLongTaskSummary.resolve(
      sessionRunning: false,
      pendingInteractionCount: 0,
      toolActivities: [],
      jobs: [],
      goal: completedGoal,
      todos: staleIncompleteTodos?.items ?? []
    ) == nil,
    "native long-task summary exits when the durable goal is complete"
  )

  let blockedGoal = ArkGoalSnapshot(projection: .object([
    "goal": .object([
      "id": .string("goal-blocked"),
      "revision": .number(4),
      "objective": .string("Needs input"),
      "phase": .string("blocked"),
      "blockedReason": .object([
        "code": .string("needs-input"),
        "message": .string("Choose one option"),
      ]),
      "maxGoalRounds": .number(8),
    ]),
    "roundsStarted": .number(4),
  ]))
  check(
    ArkLongTaskSummary.resolve(
      sessionRunning: false,
      pendingInteractionCount: 0,
      toolActivities: [],
      jobs: [],
      goal: blockedGoal,
      todos: staleIncompleteTodos?.items ?? []
    ) == nil,
    "native long-task summary leaves an idle blocked goal to the dedicated goal dock"
  )

  let transcriptProse: JSONValue = .object([
    "message": .object([
      "role": .string("assistant"),
      "text": .string("I am still running the deployment; two steps remain."),
    ]),
  ])
  let proseGoal = ArkGoalSnapshot(projection: transcriptProse)
  let proseTodos = ArkTodoListPresentation(projection: transcriptProse)
  let proseOnlySummary = ArkLongTaskSummary.resolve(
    sessionRunning: false,
    pendingInteractionCount: 0,
    toolActivities: [],
    jobs: [],
    goal: proseGoal,
    todos: proseTodos?.items ?? []
  )
  check(
    proseGoal == nil && proseTodos == nil && proseOnlySummary == nil,
    "native long-task state uses typed execution/job/projection owners and never guesses from assistant text"
  )

  let viewURL = contractNativeRoot.appendingPathComponent(
    "Sources/JiuzhangShellUI/NativeLongTaskSummaryView.swift"
  )
  let rootURL = contractNativeRoot.appendingPathComponent(
    "Sources/JiuzhangShellUI/ArkRootView.swift"
  )
  guard
    let viewSource = try? String(contentsOf: viewURL, encoding: .utf8),
    let rootSource = try? String(contentsOf: rootURL, encoding: .utf8)
  else {
    check(false, "native long-task sources are readable")
    return
  }
  check(
    viewSource.contains("ark.chat.long-task.toggle")
      && viewSource.contains("TimelineView(.periodic(from: .now, by: 1))")
      && viewSource.components(separatedBy: "TimelineView(.periodic(from: .now, by: 1))").count == 2
      && viewSource.contains("Image(systemName: \"circle.dotted\")")
      && !viewSource.contains("ProgressView().controlSize(.mini)")
      && !viewSource.contains("cancelSelectedSession")
      && !viewSource.contains("ark.chat.long-task.stop"),
    "native long-task presentation keeps one-second duration updates without a display-rate spinner in the lazy transcript"
  )
  check(
    viewSource.contains(".accessibilityLabel(summary.title)")
      && viewSource.contains(".accessibilityValue(summaryAccessibilityValue)")
      && viewSource.contains("ark.chat.long-task.item.\\(item.id)")
      && viewSource.contains(".accessibilityValue(itemAccessibilityValue(item))"),
    "native long-task disclosure and typed child states remain explicit to AX"
  )
  check(
    rootSource.contains(
      "NativeLongTaskSummaryView(summary: summary, language: model.languagePreference)"
    ),
    "native composer mounts the durable long-task summary in its existing projection dock"
  )
  check(
    rootSource.contains("private struct NativeSessionActivityIndicator: View")
      && rootSource.contains("language: model.languagePreference")
      && rootSource.contains("NativeSessionStatusLight(")
      && rootSource.contains("options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect]")
      && rootSource.contains("ark.session.activity-indicator")
      && !rootSource.contains("Label(\"任务 \\(model.sessionJobs.count)\""),
    "native session light reveals typed job status through its AppKit tracking area without a duplicate task-count control"
  )
}
