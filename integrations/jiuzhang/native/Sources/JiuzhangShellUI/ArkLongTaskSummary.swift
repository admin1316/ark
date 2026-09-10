import Foundation
import JiuzhangShellCore

public enum ArkLongTaskPhase: Equatable, Sendable {
  case running
  case stopping
  case needsDecision
  case paused
  case failed
  case completed
}

public struct ArkLongTaskItem: Identifiable, Equatable, Sendable {
  public let id: String
  public let title: String
  public let phase: ArkExecutionPhase
  public let detail: String?

  public init(id: String, title: String, phase: ArkExecutionPhase, detail: String? = nil) {
    self.id = id
    self.title = title
    self.phase = phase
    self.detail = detail
  }
}

public struct ArkSessionJobPresentation: Identifiable, Equatable, Sendable {
  public let id: String
  public let kind: String
  public let label: String
  public let status: String
  public let detail: String?
  public let startedAt: Date
  public let finishedAt: Date?

  public init?(_ value: JSONValue) {
    guard
      let id = value["id"]?.stringValue,
      let kind = value["kind"]?.stringValue,
      let label = value["label"]?.stringValue,
      let status = value["status"]?.stringValue,
      let startedAt = value["startedAt"]?.numberValue
    else { return nil }
    self.id = id
    self.kind = kind
    self.label = label
    self.status = status
    detail = value["detail"]?.stringValue
    self.startedAt = Date(timeIntervalSince1970: startedAt / 1_000)
    finishedAt = value["finishedAt"]?.numberValue.map {
      Date(timeIntervalSince1970: $0 / 1_000)
    }
  }

  public var isActive: Bool { status == "running" || status == "stopping" }
  public var isStopping: Bool { status == "stopping" }
  public var executionPhase: ArkExecutionPhase {
    switch status {
    case "running": return .running
    case "completed": return .succeeded
    case "stopping", "killed": return .cancelled
    default: return .failed
    }
  }

  public func duration(at now: Date = Date()) -> TimeInterval {
    max(0, (finishedAt ?? now).timeIntervalSince(startedAt))
  }
}

/// One compact, typed summary for the work currently owned by the selected
/// session. The resolver consumes durable execution/job/projection facts only;
/// assistant prose never participates in status detection.
public struct ArkLongTaskSummary: Equatable, Sendable {
  public let title: String
  public let detail: String?
  public let phase: ArkLongTaskPhase
  public let startedAt: Date?
  public let completedCount: Int
  public let totalCount: Int
  public let failedCount: Int
  public let items: [ArkLongTaskItem]
  public let executionActivityID: String?

  public init(
    title: String,
    detail: String? = nil,
    phase: ArkLongTaskPhase,
    startedAt: Date? = nil,
    completedCount: Int = 0,
    totalCount: Int = 0,
    failedCount: Int = 0,
    items: [ArkLongTaskItem] = [],
    executionActivityID: String? = nil
  ) {
    self.title = title
    self.detail = detail
    self.phase = phase
    self.startedAt = startedAt
    self.completedCount = completedCount
    self.totalCount = totalCount
    self.failedCount = failedCount
    self.items = items
    self.executionActivityID = executionActivityID
  }

  public static func resolve(
    sessionRunning: Bool,
    pendingInteractionCount: Int,
    toolActivities: [ArkToolActivity],
    jobs: [ArkSessionJobPresentation],
    goal: ArkGoalSnapshot?,
    todos: [ArkTodoItemPresentation]
  ) -> ArkLongTaskSummary? {
    let runningActivity = sessionRunning
      ? toolActivities
        .filter { $0.execution?.phase == .running }
        .max { $0.sequence < $1.sequence }
      : nil
    let activeJobs = jobs.filter { $0.isActive }
      .sorted { $0.startedAt < $1.startedAt }
    let todoItems = todos.enumerated().map { index, item in
      ArkLongTaskItem(
        id: "todo:\(index)",
        title: item.content,
        phase: item.executionPhase
      )
    }
    let goalTitle = goal?.phase == .complete ? nil : goal?.objective

    // Todo projections are durable history, not lifecycle authority. They may
    // remain populated after a turn has ended, so they can enrich an active
    // summary but must never keep the composer in a permanent "processing"
    // state on their own.
    guard pendingInteractionCount > 0
      || sessionRunning
      || runningActivity != nil
      || !activeJobs.isEmpty
    else { return nil }

    let phase: ArkLongTaskPhase
    if pendingInteractionCount > 0 {
      phase = .needsDecision
    } else if activeJobs.contains(where: \.isStopping) {
      phase = .stopping
    } else {
      phase = .running
    }

    let executionItems = runningActivity?.execution?.steps.map {
      ArkLongTaskItem(
        id: "execution:\($0.id)",
        title: $0.label ?? $0.name,
        phase: $0.phase,
        detail: $0.output?.split(separator: "\n").first.map(String.init)
      )
    } ?? []
    let jobItems = activeJobs.map {
      ArkLongTaskItem(
        id: "job:\($0.id)",
        title: $0.label,
        phase: $0.executionPhase,
        detail: $0.detail
      )
    }
    let items = !executionItems.isEmpty
      ? executionItems + jobItems
      : todoItems + jobItems

    let completedCount: Int
    let totalCount: Int
    let failedCount: Int
    if let execution = runningActivity?.execution, !execution.steps.isEmpty {
      completedCount = execution.completedStepCount
      totalCount = execution.steps.count
      failedCount = execution.failedStepCount
    } else if !todoItems.isEmpty {
      completedCount = todoItems.filter { $0.phase != .running }.count
      totalCount = todoItems.count
      failedCount = todoItems.filter { $0.phase == .failed }.count
    } else {
      completedCount = 0
      totalCount = 0
      failedCount = 0
    }

    let activityTitle = runningActivity.map(presentationTitle)
    let jobTitle = activeJobs.first?.label
    let title: String
    if let goalTitle, !goalTitle.isEmpty {
      title = goalTitle
    } else if pendingInteractionCount > 0 {
      title = "等待你的决策"
    } else if let jobTitle, !jobTitle.isEmpty {
      title = jobTitle
    } else if let activityTitle, !activityTitle.isEmpty {
      title = activityTitle
    } else {
      title = "正在处理当前请求"
    }

    let detail: String? = if goalTitle?.isEmpty == false {
      activityTitle ?? activeJobs.first?.detail
    } else if jobTitle?.isEmpty == false {
      activityTitle ?? activeJobs.first?.detail
    } else {
      activeJobs.first?.detail
    }

    return ArkLongTaskSummary(
      title: title,
      detail: detail,
      phase: phase,
      startedAt: activeJobs.first?.startedAt ?? runningActivity?.execution?.startedAt,
      completedCount: completedCount,
      totalCount: totalCount,
      failedCount: failedCount,
      items: items,
      executionActivityID: runningActivity?.id
    )
  }

  private static func presentationTitle(_ activity: ArkToolActivity) -> String {
    switch activity.resultView ?? activity.callView {
    case .generic(let card): return card.title ?? activity.name
    case .terminal(let card): return card.title ?? activity.name
    case .diff(let card): return card.title ?? activity.name
    case .search(let card): return card.title ?? activity.name
    case .read(let card): return card.title ?? activity.name
    case .web(let card): return card.title ?? activity.name
    case nil: return activity.name
    }
  }

}

extension ArkAppModel {
  var selectedLongTaskSummary: ArkLongTaskSummary? {
    ArkLongTaskSummary.resolve(
      sessionRunning: selectedSession?.running == true,
      pendingInteractionCount: selectedPendingInteractionCount,
      toolActivities: toolActivities,
      jobs: selectedSessionJobPresentations,
      goal: currentGoal,
      todos: sessionProjections["todos"]
        .flatMap { ArkTodoListPresentation(projection: $0) }?.items ?? []
    )
  }

  var selectedSessionJobPresentations: [ArkSessionJobPresentation] {
    sessionJobs.compactMap(ArkSessionJobPresentation.init).sorted { left, right in
      if left.isActive != right.isActive { return left.isActive }
      if left.isActive { return left.startedAt < right.startedAt }
      return (left.finishedAt ?? left.startedAt) > (right.finishedAt ?? right.startedAt)
    }
  }
}
