import AppKit
import SwiftUI

/// Owns one nonblocking knowledge file chooser; cancelled or released owners cannot publish a selection.
@MainActor
final class ArkKnowledgeFileSelection: ObservableObject {
  private var panel: NSOpenPanel? {
    willSet { objectWillChange.send() }
  }
  var isPresented: Bool { panel != nil }

  @discardableResult
  func present(
    _ selectedPanel: NSOpenPanel,
    for window: NSWindow?,
    selection: @escaping ([URL]) -> Void
  ) -> Bool {
    guard panel == nil else { return false }
    panel = selectedPanel
    let finish: (NSApplication.ModalResponse) -> Void = { [weak self, weak selectedPanel] response in
      guard let self, let selectedPanel, self.panel === selectedPanel else { return }
      self.panel = nil
      guard response == .OK else { return }
      selection(selectedPanel.urls)
    }
    if let window {
      selectedPanel.beginSheetModal(for: window, completionHandler: finish)
    } else {
      selectedPanel.begin(completionHandler: finish)
    }
    return true
  }

  func cancel() {
    let cancelledPanel = panel
    panel = nil
    cancelledPanel?.cancel(nil)
    cancelledPanel?.close()
  }

  deinit {
    let releasedPanel = panel
    Task { @MainActor in
      releasedPanel?.cancel(nil)
      releasedPanel?.close()
    }
  }
}

struct ArkKnowledgeProjectDraft: Identifiable {
  let id = UUID()
  let directory: URL
}

/// A presentation carries its selected directory; editable naming cannot redirect the target.
struct ArkKnowledgeProjectCreationSheet: View {
  let draft: ArkKnowledgeProjectDraft
  let language: ArkLanguagePreference
  let create: (String, String) -> Void
  let cancel: () -> Void
  @State private var name: String

  init(
    draft: ArkKnowledgeProjectDraft,
    language: ArkLanguagePreference,
    create: @escaping (String, String) -> Void,
    cancel: @escaping () -> Void
  ) {
    self.draft = draft
    self.language = language
    self.create = create
    self.cancel = cancel
    _name = State(initialValue: draft.directory.lastPathComponent)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      Text(ArkL10n.text(.wikiCreateProjectTitle, language))
        .font(.system(size: 18, weight: .semibold))
      TextField(ArkL10n.text(.wikiProjectName, language), text: $name)
        .accessibilityIdentifier("ark.wiki.project.name")
      LabeledContent(ArkL10n.text(.wikiProjectDirectory, language)) {
        Text(draft.directory.path)
          .font(.system(size: 11, design: .monospaced))
          .lineLimit(2)
          .truncationMode(.middle)
          .accessibilityIdentifier("ark.wiki.project.directory")
      }
      Text(ArkL10n.text(.wikiProjectCreationDetail, language))
        .font(.system(size: 11))
        .foregroundStyle(ArkPalette.secondary)
      HStack {
        Spacer()
        Button(ArkL10n.text(.wikiCancel, language), role: .cancel, action: cancel)
          .accessibilityIdentifier("ark.wiki.project.cancel")
        Button(ArkL10n.text(.wikiCreate, language)) {
          create(name, draft.directory.path)
        }
        .buttonStyle(.borderedProminent)
        .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        .accessibilityIdentifier("ark.wiki.project.create")
      }
    }
    .padding(22)
    .frame(width: 520, height: 230)
    .background(ArkPalette.panel)
  }
}
