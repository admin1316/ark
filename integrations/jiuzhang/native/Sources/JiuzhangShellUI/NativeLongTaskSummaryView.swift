import SwiftUI

/// Stable composer-adjacent summary for the selected session's current work.
/// It remains one compact row while the transcript streams and expands only
/// when the user asks to inspect typed steps.
struct NativeLongTaskSummaryView: View {
  let summary: ArkLongTaskSummary
  let language: ArkLanguagePreference

  @State private var expanded = false

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack(spacing: 8) {
        Button { expanded.toggle() } label: {
          HStack(spacing: 8) {
            phaseSymbol(summary.phase)
              .frame(width: 14)
            VStack(alignment: .leading, spacing: 1) {
              Text(summary.title)
                .font(.system(size: 11, weight: .semibold))
                .lineLimit(1)
              if let detail = summary.detail, !detail.isEmpty {
                Text(detail)
                  .font(.system(size: 9))
                  .foregroundStyle(Color.secondary)
                  .lineLimit(1)
              }
            }
            if summary.totalCount > 0 {
              Text("\(summary.completedCount)/\(summary.totalCount)")
                .font(.system(size: 9, design: .monospaced))
                .foregroundStyle(Color.secondary)
            }
          }
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(summary.title)
        .accessibilityValue(summaryAccessibilityValue)
        .accessibilityHint(ArkL10n.text(
          expanded ? .executionCollapseSteps : .executionExpandSteps,
          language
        ))
        .accessibilityIdentifier("ark.chat.long-task.toggle")

        Spacer(minLength: 8)
        duration
        if summary.failedCount > 0 {
          Label("\(summary.failedCount)", systemImage: "exclamationmark.triangle.fill")
            .font(.system(size: 9, weight: .semibold))
            .foregroundStyle(Color.red)
        }
        Image(systemName: expanded ? "chevron.up" : "chevron.down")
          .font(.system(size: 9, weight: .semibold))
          .foregroundStyle(Color.secondary)
          .allowsHitTesting(false)
      }
      .frame(minHeight: 34)

      if summary.totalCount > 0 {
        ProgressView(
          value: Double(summary.completedCount),
          total: Double(max(summary.totalCount, 1))
        )
        .progressViewStyle(.linear)
      }

      if expanded, !summary.items.isEmpty {
        VStack(alignment: .leading, spacing: 4) {
          ForEach(summary.items.prefix(8)) { item in
            HStack(alignment: .firstTextBaseline, spacing: 7) {
              itemSymbol(item.phase)
                .frame(width: 13)
              Text(item.title)
                .font(.system(size: 10, weight: .medium))
                .lineLimit(1)
              if let detail = item.detail, !detail.isEmpty {
                Text(detail)
                  .font(.system(size: 9, design: .monospaced))
                  .foregroundStyle(Color.secondary)
                  .lineLimit(1)
              }
              Spacer(minLength: 0)
            }
            .frame(minHeight: 18)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(item.title)
            .accessibilityValue(itemAccessibilityValue(item))
            .accessibilityIdentifier("ark.chat.long-task.item.\(item.id)")
          }
          if summary.items.count > 8 {
            Text(ArkL10n.format(
              .executionMoreSteps,
              language,
              arguments: [String(summary.items.count - 8)]
            ))
              .font(.system(size: 9))
              .foregroundStyle(Color.secondary)
              .padding(.leading, 20)
          }
        }
        .padding(.bottom, 4)
      }
    }
    .padding(.horizontal, 10)
    .padding(.vertical, 5)
    .background(Color.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 10))
    .overlay(
      RoundedRectangle(cornerRadius: 10)
        .stroke(Color.secondary.opacity(0.16))
    )
    .accessibilityIdentifier("ark.chat.long-task")
  }

  @ViewBuilder
  private var duration: some View {
    if let startedAt = summary.startedAt {
      if summary.phase == .running || summary.phase == .stopping {
        TimelineView(.periodic(from: .now, by: 1)) { context in
          durationText(context.date.timeIntervalSince(startedAt))
        }
      } else {
        durationText(Date().timeIntervalSince(startedAt))
      }
    }
  }

  private func durationText(_ interval: TimeInterval) -> some View {
    Text(formatDuration(max(0, interval)))
      .font(.system(size: 9, design: .monospaced))
      .foregroundStyle(Color.secondary)
  }

  private func phaseSymbol(_ phase: ArkLongTaskPhase) -> some View {
    Group {
      switch phase {
      case .running:
        Image(systemName: "circle.dotted")
          .foregroundStyle(Color.accentColor)
      case .stopping:
        Image(systemName: "stop.circle.fill").foregroundStyle(Color.orange)
      case .needsDecision:
        Image(systemName: "questionmark.circle.fill").foregroundStyle(Color.orange)
      case .paused:
        Image(systemName: "pause.circle.fill").foregroundStyle(Color.secondary)
      case .failed:
        Image(systemName: "xmark.octagon.fill").foregroundStyle(Color.red)
      case .completed:
        Image(systemName: "checkmark.circle.fill").foregroundStyle(Color.green)
      }
    }
  }

  private func itemSymbol(_ phase: ArkExecutionPhase) -> some View {
    Group {
      switch phase {
      case .running:
        Image(systemName: "circle.dotted")
          .foregroundStyle(Color.accentColor)
      case .succeeded:
        Image(systemName: "checkmark.circle.fill").foregroundStyle(Color.green)
      case .failed:
        Image(systemName: "xmark.octagon.fill").foregroundStyle(Color.red)
      case .cancelled:
        Image(systemName: "stop.circle.fill").foregroundStyle(Color.orange)
      }
    }
    .font(.system(size: 9, weight: .semibold))
  }

  private var summaryAccessibilityValue: String {
    var values: [String] = []
    if let detail = summary.detail, !detail.isEmpty { values.append(detail) }
    if summary.totalCount > 0 {
      values.append(
        "\(ArkL10n.text(.executionCompleted, language)) "
          + "\(summary.completedCount)/\(summary.totalCount)"
      )
    }
    if summary.failedCount > 0 {
      values.append("\(ArkL10n.text(.executionFailed, language)) \(summary.failedCount)")
    }
    return values.joined(separator: ", ")
  }

  private func itemAccessibilityValue(_ item: ArkLongTaskItem) -> String {
    var values = [executionPhaseLabel(item.phase)]
    if let detail = item.detail, !detail.isEmpty { values.append(detail) }
    return values.joined(separator: ", ")
  }

  private func executionPhaseLabel(_ phase: ArkExecutionPhase) -> String {
    switch phase {
    case .running: return ArkL10n.text(.executionRunning, language)
    case .succeeded: return ArkL10n.text(.executionCompleted, language)
    case .failed: return ArkL10n.text(.executionFailed, language)
    case .cancelled: return ArkL10n.text(.executionCancelled, language)
    }
  }

  private func formatDuration(_ interval: TimeInterval) -> String {
    if interval < 60 { return String(format: "%.0fs", interval) }
    let seconds = Int(interval.rounded())
    if seconds < 3_600 { return "\(seconds / 60)m \(seconds % 60)s" }
    return "\(seconds / 3_600)h \((seconds % 3_600) / 60)m"
  }
}
