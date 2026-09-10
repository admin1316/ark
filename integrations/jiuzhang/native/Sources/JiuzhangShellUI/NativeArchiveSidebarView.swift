import JiuzhangShellCore
import SwiftUI

/// Compact archive projection used by the original Workspace browser seat.
/// Restoring is immediate and reversible; permanent deletion stays behind a
/// second destructive confirmation without moving the user to another window.
struct NativeArchiveSidebarView: View {
  @ObservedObject var model: ArkAppModel
  @State private var hoveredSessionID: String?
  @State private var pendingDelete: ArkSessionSummary?

  private var sessions: [ArkSessionSummary] {
    model.sessions
      .filter { model.archivedSessionIDs.contains($0.id) }
      .sorted { $0.updatedAt > $1.updatedAt }
  }

  var body: some View {
    LazyVStack(spacing: 2) {
      if sessions.isEmpty {
        Text(ArkL10n.text(.archiveEmpty, model.languagePreference))
          .font(.system(size: 13))
          .foregroundStyle(.secondary)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(.horizontal, 12)
          .padding(.vertical, 16)
      }
      ForEach(sessions) { session in
        row(session)
      }
    }
    .accessibilityIdentifier("ark.archive.sidebar")
    .confirmationDialog(
      "永久删除“\(pendingDelete?.title ?? "这个对话")”？",
      isPresented: Binding(
        get: { pendingDelete != nil },
        set: { if !$0 { pendingDelete = nil } }
      ),
      titleVisibility: .visible
    ) {
      Button(ArkL10n.text(.archiveDeletePermanently, model.languagePreference), role: .destructive) {
        guard let session = pendingDelete else { return }
        model.deleteArchivedSessionPermanently(session.id)
        pendingDelete = nil
      }
      Button(ArkL10n.text(.archiveCancel, model.languagePreference), role: .cancel) { pendingDelete = nil }
    } message: {
      Text(ArkL10n.text(.archiveDeleteWarningShort, model.languagePreference))
    }
  }

  @ViewBuilder
  private func row(_ session: ArkSessionSummary) -> some View {
    let mutationRunning = model.archiveMutationIsRunning(session.id)
    HStack(spacing: 0) {
      Image(systemName: "archivebox")
        .font(.system(size: 12))
        .foregroundStyle(.secondary)
        .frame(width: 16)
      Text(session.title)
        .font(.system(size: 14))
        .lineLimit(1)
        .padding(.leading, 4)
      Spacer(minLength: 4)
      if mutationRunning {
        ProgressView()
          .controlSize(.small)
          .padding(.trailing, 6)
      } else if hoveredSessionID == session.id {
        Button {
          model.restoreArchivedSession(session.id)
        } label: {
          Image(systemName: "arrow.uturn.backward")
            .frame(width: 24, height: 28)
        }
        .buttonStyle(.plain)
        .help(ArkL10n.text(.archiveRestoreHelp, model.languagePreference))
        .accessibilityIdentifier("ark.archive.restore.\(session.id)")
        Button(role: .destructive) {
          pendingDelete = session
        } label: {
          Image(systemName: "trash")
            .frame(width: 24, height: 28)
        }
        .buttonStyle(.plain)
        .help(ArkL10n.text(.archiveDeletePermanently, model.languagePreference))
        .accessibilityIdentifier("ark.archive.delete.\(session.id)")
      } else {
        Text(relativeDate(session.updatedAt))
          .font(.system(size: 12))
          .foregroundStyle(.secondary)
          .padding(.trailing, 8)
      }
    }
    .padding(.leading, 8)
    .frame(height: 32)
    .background(
      hoveredSessionID == session.id
        ? Color(nsColor: .underPageBackgroundColor) : Color.clear,
      in: RoundedRectangle(cornerRadius: 8)
    )
    .onHover { hoveredSessionID = $0 ? session.id : nil }
  }

  private func relativeDate(_ date: Date) -> String {
    let seconds = max(0, Date().timeIntervalSince(date))
    if seconds < 60 { return "刚刚" }
    if seconds < 3_600 { return "\(Int(seconds / 60))分钟" }
    if seconds < 86_400 { return "\(Int(seconds / 3_600))小时" }
    if seconds < 604_800 { return "\(Int(seconds / 86_400))天" }
    return date.formatted(date: .numeric, time: .omitted)
  }
}
