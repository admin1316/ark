import AppKit
@testable import JiuzhangShellUI

@MainActor
private final class KnowledgeSelectionPanel: NSOpenPanel {
  var selectedURLs: [URL] = []
  private(set) var presentations = 0
  private(set) var cancellations = 0
  private(set) var closes = 0
  var completion: ((NSApplication.ModalResponse) -> Void)?

  override var urls: [URL] { selectedURLs }
  override func begin(completionHandler handler: @escaping (NSApplication.ModalResponse) -> Void) {
    presentations += 1
    completion = handler
  }
  override func beginSheetModal(
    for window: NSWindow,
    completionHandler handler: @escaping (NSApplication.ModalResponse) -> Void
  ) {
    presentations += 1
    completion = handler
  }
  override func cancel(_ sender: Any?) { cancellations += 1 }
  override func close() { closes += 1 }
}

@MainActor
func runArkKnowledgeFileSelectionContractChecks() async {
  _ = NSApplication.shared
  let a = URL(fileURLWithPath: "/synthetic/Project A", isDirectory: true)
  let b = URL(fileURLWithPath: "/synthetic/Project B", isDirectory: true)
  let first = KnowledgeSelectionPanel(), rejected = KnowledgeSelectionPanel()
  first.selectedURLs = [a]
  rejected.selectedURLs = [b]
  let owner = ArkKnowledgeFileSelection()
  var received: [[URL]] = []
  check(owner.present(first, for: nil) { received.append($0) }, "knowledge selection admits its first native panel")
  check(!owner.present(rejected, for: nil) { received.append($0) }
    && first.presentations == 1 && rejected.presentations == 0,
    "repeated knowledge selection cannot open another native panel")
  owner.cancel()
  first.completion?(.OK)
  check(!owner.isPresented && first.cancellations == 1 && first.closes == 1 && received.isEmpty,
    "cancel closes the owned chooser and suppresses a late successful selection")

  check(owner.present(rejected, for: nil) { received.append($0) }, "selection can open again after cancellation")
  first.completion?(.OK)
  check(owner.isPresented && received.isEmpty, "an old chooser response cannot settle its replacement")
  rejected.completion?(.OK)
  rejected.completion?(.OK)
  check(!owner.isPresented && received == [[b]], "a successful native selection publishes once")

  let releasedPanel = KnowledgeSelectionPanel()
  releasedPanel.selectedURLs = [a]
  var releasedOwner: ArkKnowledgeFileSelection? = ArkKnowledgeFileSelection()
  weak var released = releasedOwner
  _ = releasedOwner?.present(releasedPanel, for: nil) { received.append($0) }
  releasedOwner = nil
  for _ in 0..<20 { await Task.yield() }
  releasedPanel.completion?(.OK)
  check(released == nil && releasedPanel.cancellations == 1 && releasedPanel.closes == 1 && received == [[b]],
    "releasing the selection owner closes its panel without publishing a late response")

  print("NOT_RUN_GUI: first project-sheet directory, initial name, enabled Create and button payload require isolated candidate interaction")
}
