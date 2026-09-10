import SwiftUI

/// One transcript-line execution summary. The row is visible while the tool
/// detail is collapsed, so users never need to expand raw output merely to see
/// whether work is running, finished, failed, or cancelled.
struct NativeExecutionInlineStatusView: View {
  let activity: ArkToolActivity
  let language: ArkLanguagePreference

  var body: some View {
    if let execution = activity.execution {
      if execution.phase == .running {
        TimelineView(.periodic(from: .now, by: 1)) { context in
          content(execution, now: context.date)
        }
      } else {
        content(execution, now: execution.finishedAt ?? Date())
      }
    }
  }

  private func content(_ execution: ArkExecutionActivity, now: Date) -> some View {
    HStack(spacing: 6) {
      NativeExecutionVisuals.phaseSymbol(execution.phase)
      Text(NativeExecutionVisuals.phaseLabel(execution.phase, language: language))
        .font(.system(size: 10, weight: .semibold))
        .foregroundStyle(NativeExecutionVisuals.phaseColor(execution.phase))
      if !execution.steps.isEmpty {
        Text("\(execution.completedStepCount)/\(execution.steps.count)")
          .font(.system(size: 9, design: .monospaced))
          .foregroundStyle(Color.secondary)
      }
      if let terminal = terminalResult {
        if let signal = terminal.signal {
          Text(signal)
            .font(.system(size: 9, design: .monospaced))
            .foregroundStyle(Color.red)
        } else if let exitCode = terminal.exitCode, exitCode != 0 {
          Text("exit \(exitCode)")
            .font(.system(size: 9, design: .monospaced))
            .foregroundStyle(Color.red)
        }
      }
      if let duration = execution.duration(at: now) {
        Text(NativeExecutionVisuals.formatDuration(duration))
          .font(.system(size: 9, design: .monospaced))
          .foregroundStyle(Color.secondary)
      }
    }
    .fixedSize(horizontal: true, vertical: false)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(activity.name)
    .accessibilityValue(accessibilityValue(execution, now: now))
    .accessibilityIdentifier("ark.chat.tool.execution.\(activity.id)")
  }

  private var terminalResult: ArkTerminalPresentation? {
    guard case .terminal(let terminal) = activity.resultView else { return nil }
    return terminal
  }

  private func accessibilityValue(_ execution: ArkExecutionActivity, now: Date) -> String {
    var values = [NativeExecutionVisuals.phaseLabel(execution.phase, language: language)]
    if !execution.steps.isEmpty {
      values.append("\(execution.completedStepCount)/\(execution.steps.count)")
    }
    if let signal = terminalResult?.signal {
      values.append(signal)
    } else if let exitCode = terminalResult?.exitCode {
      values.append("exit \(exitCode)")
    }
    if let duration = execution.duration(at: now) {
      values.append(NativeExecutionVisuals.formatDuration(duration))
    }
    return values.joined(separator: ", ")
  }
}

/// Compact durable execution state embedded in Ark's existing transcript tool
/// row. It owns no session state and renders only `ArkExecutionActivity` data
/// folded from history events, so history replay and reconnect produce the same
/// presentation as the live stream.
struct NativeExecutionActivityView: View {
  let activity: ArkToolActivity
  let language: ArkLanguagePreference
  let openChildSession: (String) -> Void

  @State private var stepsExpanded = true

  var body: some View {
    if let workflow = ArkWorkflowRunPresentation(activity: activity) {
      NativeWorkflowRunView(
        workflow: workflow,
        language: language,
        openChildSession: openChildSession
      )
    } else if let execution = activity.execution {
      if execution.phase == .running {
        TimelineView(.periodic(from: .now, by: 1)) { context in
          detail(execution, now: context.date)
        }
      } else {
        detail(execution, now: execution.finishedAt ?? Date())
      }
    }
  }

  private func detail(_ execution: ArkExecutionActivity, now: Date) -> some View {
    VStack(alignment: .leading, spacing: 7) {
        HStack(spacing: 7) {
          NativeExecutionVisuals.phaseSymbol(execution.phase)
          Text(NativeExecutionVisuals.phaseLabel(execution.phase, language: language))
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(NativeExecutionVisuals.phaseColor(execution.phase))
          if let stopReason = execution.stopReason, stopReason != "completed" {
            Text(stopReason)
              .font(.system(size: 9, design: .monospaced))
              .foregroundStyle(Color.secondary)
          }
          Spacer(minLength: 8)
          if let duration = execution.duration(at: now) {
            Text(NativeExecutionVisuals.formatDuration(duration))
              .font(.system(size: 9, design: .monospaced))
              .foregroundStyle(Color.secondary)
          }
        }

        if let terminal = terminalResult,
           terminal.exitCode != nil || terminal.signal != nil
        {
          HStack(spacing: 10) {
            if let exitCode = terminal.exitCode {
              Label("退出码 \(exitCode)", systemImage: exitCode == 0
                ? "checkmark.circle" : "exclamationmark.circle")
            }
            if let signal = terminal.signal {
              Label(signal, systemImage: "bolt.trianglebadge.exclamationmark")
            }
          }
          .font(.system(size: 9, design: .monospaced))
          .foregroundStyle(terminal.signal == nil && terminal.exitCode == 0
            ? Color.secondary : Color.red)
        }

        if !execution.steps.isEmpty {
          HStack(spacing: 8) {
            ProgressView(
              value: Double(execution.completedStepCount),
              total: Double(max(execution.steps.count, 1))
            )
            .progressViewStyle(.linear)
            .frame(maxWidth: 132)

            Text("\(execution.completedStepCount) / \(execution.steps.count)")
              .font(.system(size: 9, design: .monospaced))
              .foregroundStyle(Color.secondary)

            if execution.failedStepCount > 0 {
              Label("\(execution.failedStepCount)", systemImage: "exclamationmark.triangle.fill")
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(Color.red)
            }

            Spacer(minLength: 0)
            Button {
              stepsExpanded.toggle()
            } label: {
              Image(systemName: stepsExpanded ? "chevron.up" : "chevron.down")
                .frame(width: 22, height: 20)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(ArkL10n.text(
              stepsExpanded ? .executionCollapseSteps : .executionExpandSteps,
              language
            ))
            .accessibilityLabel(ArkL10n.text(
              stepsExpanded ? .executionCollapseSteps : .executionExpandSteps,
              language
            ))
            .accessibilityValue("\(execution.completedStepCount)/\(execution.steps.count)")
            .accessibilityIdentifier("ark.chat.tool.execution.steps.\(activity.id)")
          }

          if stepsExpanded {
            VStack(alignment: .leading, spacing: 4) {
              ForEach(execution.steps.prefix(12)) { step in
                stepRow(step, steps: execution.steps, now: now)
              }
              if execution.steps.count > 12 {
                Text(ArkL10n.format(
                  .executionMoreSteps,
                  language,
                  arguments: [String(execution.steps.count - 12)]
                ))
                  .font(.system(size: 9))
                  .foregroundStyle(Color.secondary)
                  .padding(.leading, 19)
              }
            }
          }
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(8)
      .background(Color.secondary.opacity(0.055), in: RoundedRectangle(cornerRadius: 7))
      .overlay(
        RoundedRectangle(cornerRadius: 7)
          .stroke(Color.secondary.opacity(0.12))
      )
      .accessibilityElement(children: .contain)
      .accessibilityIdentifier("ark.chat.tool.execution.detail.\(activity.id)")
  }

  private func stepRow(
    _ step: ArkExecutionStep,
    steps: [ArkExecutionStep],
    now: Date
  ) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 6) {
      NativeExecutionVisuals.phaseSymbol(step.phase)
        .frame(width: 13)
      Text(step.label ?? step.name)
        .font(.system(size: 10, weight: .medium))
        .lineLimit(1)
      if let phase = step.phaseLabel, !phase.isEmpty {
        Text(phase)
          .font(.system(size: 9))
          .foregroundStyle(Color.secondary)
          .lineLimit(1)
      }
      if let output = step.output?.split(separator: "\n").first, !output.isEmpty {
        Text(String(output))
          .font(.system(size: 9, design: .monospaced))
          .foregroundStyle(Color.secondary)
          .lineLimit(1)
          .truncationMode(.tail)
      }
      Spacer(minLength: 6)
      Text(NativeExecutionVisuals.formatDuration(step.duration(at: now)))
        .font(.system(size: 8, design: .monospaced))
        .foregroundStyle(Color.secondary)
    }
    .frame(minHeight: 18)
    .padding(.leading, CGFloat(stepDepth(step, in: steps)) * 12)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(step.label ?? step.name)
    .accessibilityValue(stepAccessibilityValue(step, now: now))
    .accessibilityIdentifier("ark.chat.tool.execution.step.\(step.id)")
  }

  private var terminalResult: ArkTerminalPresentation? {
    guard case .terminal(let terminal) = activity.resultView else { return nil }
    return terminal
  }

  private func stepDepth(_ step: ArkExecutionStep, in steps: [ArkExecutionStep]) -> Int {
    var depth = 0
    var parentCallID = step.parentCallID
    var visited: Set<String> = []
    while let parentID = parentCallID,
          parentID != activity.id,
          visited.insert(parentID).inserted,
          let parent = steps.first(where: { $0.id == parentID })
    {
      depth += 1
      parentCallID = parent.parentCallID
    }
    return min(depth, 4)
  }

  private func stepAccessibilityValue(_ step: ArkExecutionStep, now: Date) -> String {
    var values = [NativeExecutionVisuals.phaseLabel(step.phase, language: language)]
    if let output = step.output?.split(separator: "\n").first, !output.isEmpty {
      values.append(String(output))
    }
    values.append(NativeExecutionVisuals.formatDuration(step.duration(at: now)))
    return values.joined(separator: ", ")
  }
}

/// Dedicated workflow replay built solely from `tool-workflow/*` events.
/// Phase grouping and child identities come from `ArkWorkflowRunPresentation`;
/// this view owns disclosure only, never workflow lifecycle state.
private struct NativeWorkflowRunView: View {
  let workflow: ArkWorkflowRunPresentation
  let language: ArkLanguagePreference
  let openChildSession: (String) -> Void

  var body: some View {
    if workflow.execution.phase == .running {
      TimelineView(.periodic(from: .now, by: 1)) { context in
        content(now: context.date)
      }
    } else {
      content(now: workflow.execution.finishedAt ?? Date())
    }
  }

  private func content(now: Date) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 7) {
        Image(systemName: "point.3.connected.trianglepath.dotted")
          .foregroundStyle(Color.accentColor)
        Text(ArkL10n.format(.workflowRun, language, arguments: [workflow.name]))
          .font(.system(size: 11, weight: .semibold))
          .lineLimit(1)
        Text(ArkL10n.format(
          .workflowMembers,
          language,
          arguments: [String(workflow.memberCount)]
        ))
        .font(.system(size: 9, design: .monospaced))
        .foregroundStyle(Color.secondary)
        Spacer(minLength: 8)
        NativeExecutionVisuals.phaseSymbol(workflow.execution.phase)
        Text(NativeExecutionVisuals.phaseLabel(workflow.execution.phase, language: language))
          .font(.system(size: 9, weight: .semibold))
          .foregroundStyle(NativeExecutionVisuals.phaseColor(workflow.execution.phase))
        if let duration = workflow.execution.duration(at: now) {
          Text(NativeExecutionVisuals.formatDuration(duration))
            .font(.system(size: 9, design: .monospaced))
            .foregroundStyle(Color.secondary)
        }
      }

      if workflow.memberCount > 0 {
        ProgressView(
          value: Double(workflow.execution.completedStepCount),
          total: Double(workflow.memberCount)
        )
        .progressViewStyle(.linear)

        ScrollView {
          VStack(alignment: .leading, spacing: 7) {
            ForEach(workflow.phases) { phase in
              VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                  Text(phase.title ?? ArkL10n.text(.workflowPhaseUnassigned, language))
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(Color.secondary)
                  Text(String(phase.members.count))
                    .font(.system(size: 8, design: .monospaced))
                    .foregroundStyle(Color.secondary)
                }
                ForEach(phase.members) { member in
                  memberRow(member, now: now)
                }
              }
            }
          }
        }
        .frame(maxHeight: 176)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(9)
    .background(Color.accentColor.opacity(0.055), in: RoundedRectangle(cornerRadius: 8))
    .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.accentColor.opacity(0.18)))
    .accessibilityIdentifier("ark.chat.workflow.\(workflow.id)")
  }

  @ViewBuilder
  private func memberRow(_ member: ArkExecutionStep, now: Date) -> some View {
    if let childSessionID = member.childSessionID {
      Button {
        openChildSession(childSessionID)
      } label: {
        memberContent(member, now: now, navigable: true)
      }
      .buttonStyle(.plain)
      .help(ArkL10n.text(.workflowOpenSession, language))
      .accessibilityIdentifier("ark.chat.workflow.member.\(member.id)")
    } else {
      memberContent(member, now: now, navigable: false)
        .accessibilityIdentifier("ark.chat.workflow.member.\(member.id)")
    }
  }

  private func memberContent(
    _ member: ArkExecutionStep,
    now: Date,
    navigable: Bool
  ) -> some View {
    HStack(spacing: 7) {
      NativeExecutionVisuals.phaseSymbol(member.phase)
        .frame(width: 13)
      Text(member.label ?? member.name)
        .font(.system(size: 10, weight: .medium))
        .lineLimit(1)
      Text(NativeExecutionVisuals.phaseLabel(member.phase, language: language))
        .font(.system(size: 9))
        .foregroundStyle(NativeExecutionVisuals.phaseColor(member.phase))
      Spacer(minLength: 6)
      Text(NativeExecutionVisuals.formatDuration(member.duration(at: now)))
        .font(.system(size: 8, design: .monospaced))
        .foregroundStyle(Color.secondary)
      if navigable {
        Image(systemName: "arrow.up.forward.app")
          .font(.system(size: 9, weight: .semibold))
          .foregroundStyle(Color.secondary)
      }
    }
    .padding(.horizontal, 6)
    .frame(minHeight: 24)
    .background(
      member.phase == .failed ? Color.red.opacity(0.08) : Color.secondary.opacity(0.035),
      in: RoundedRectangle(cornerRadius: 5)
    )
    .contentShape(Rectangle())
  }
}

private enum NativeExecutionVisuals {
  static func phaseSymbol(_ phase: ArkExecutionPhase) -> some View {
    Group {
      if phase == .running {
        Image(systemName: "circle.dotted")
          .font(.system(size: 9, weight: .semibold))
          .foregroundStyle(Color.accentColor)
      } else {
        Image(systemName: symbolName(phase))
          .font(.system(size: 9, weight: .semibold))
          .foregroundStyle(phaseColor(phase))
      }
    }
  }

  private static func symbolName(_ phase: ArkExecutionPhase) -> String {
    switch phase {
    case .running: return "circle.dotted"
    case .succeeded: return "checkmark.circle.fill"
    case .failed: return "xmark.octagon.fill"
    case .cancelled: return "stop.circle.fill"
    }
  }

  static func phaseLabel(
    _ phase: ArkExecutionPhase,
    language: ArkLanguagePreference
  ) -> String {
    switch phase {
    case .running: return ArkL10n.text(.executionRunning, language)
    case .succeeded: return ArkL10n.text(.executionCompleted, language)
    case .failed: return ArkL10n.text(.executionFailed, language)
    case .cancelled: return ArkL10n.text(.executionCancelled, language)
    }
  }

  static func phaseColor(_ phase: ArkExecutionPhase) -> Color {
    switch phase {
    case .running: return .accentColor
    case .succeeded: return .green
    case .failed: return .red
    case .cancelled: return .orange
    }
  }

  static func formatDuration(_ interval: TimeInterval) -> String {
    if interval < 1 { return "\(Int((interval * 1_000).rounded())) ms" }
    if interval < 60 { return String(format: "%.1f s", interval) }
    let seconds = Int(interval.rounded())
    return "\(seconds / 60)m \(seconds % 60)s"
  }

}
