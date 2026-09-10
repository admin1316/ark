import AppKit
import SwiftUI

/// AppKit-backed changed-file tree used by Native Review.
///
/// Review deliberately shares the same source-list geometry, row reuse,
/// keyboard selection, and inertial scrolling behavior as Native Files. Git
/// status remains a presentation attribute of a leaf; selecting a leaf still
/// delegates to the single `NativeWorkbenchModel` Git owner.
struct NativeGitChangeOutlineView: NSViewRepresentable {
  let rootURL: URL
  let changes: [NativeGitChange]
  let selectedPath: String?
  let expandAllDirectories: Bool
  let showsStateDots: Bool
  let onSelect: (NativeGitChange) -> Void

  func makeCoordinator() -> Coordinator {
    Coordinator(
      rootURL: rootURL,
      changes: changes,
      selectedPath: selectedPath,
      expandAllDirectories: expandAllDirectories,
      showsStateDots: showsStateDots,
      onSelect: onSelect
    )
  }

  func makeNSView(context: Context) -> NSScrollView {
    let outline = NativeGitClickableOutlineView()
    let column = NSTableColumn(identifier: .arkGitChangeColumn)
    column.resizingMask = .autoresizingMask
    outline.addTableColumn(column)
    outline.outlineTableColumn = column
    outline.headerView = nil
    outline.style = .sourceList
    outline.rowSizeStyle = .custom
    outline.rowHeight = 28
    outline.indentationPerLevel = 18
    outline.intercellSpacing = NSSize(width: 0, height: 1)
    outline.allowsEmptySelection = true
    outline.allowsMultipleSelection = false
    outline.autoresizesOutlineColumn = true
    outline.backgroundColor = .windowBackgroundColor
    outline.delegate = context.coordinator
    outline.dataSource = context.coordinator
    outline.onDirectoryClick = { [weak coordinator = context.coordinator, weak outline] row in
      guard let coordinator, let outline else { return }
      coordinator.toggleDirectory(at: row, in: outline)
    }

    let scrollView = NSScrollView()
    scrollView.borderType = .noBorder
    scrollView.drawsBackground = true
    scrollView.backgroundColor = .windowBackgroundColor
    scrollView.hasVerticalScroller = true
    scrollView.hasHorizontalScroller = true
    scrollView.autohidesScrollers = true
    scrollView.documentView = outline

    context.coordinator.outlineView = outline
    context.coordinator.reload(force: true)
    return scrollView
  }

  func updateNSView(_ scrollView: NSScrollView, context: Context) {
    context.coordinator.rootURL = rootURL
    context.coordinator.changes = changes
    context.coordinator.selectedPath = selectedPath
    context.coordinator.expandAllDirectories = expandAllDirectories
    context.coordinator.showsStateDots = showsStateDots
    context.coordinator.onSelect = onSelect
    context.coordinator.reload(force: false)
  }

  static func dismantleNSView(_ scrollView: NSScrollView, coordinator: Coordinator) {
    coordinator.outlineView?.delegate = nil
    coordinator.outlineView?.dataSource = nil
    coordinator.outlineView = nil
    scrollView.documentView = nil
  }

  @MainActor
  final class Coordinator: NSObject, NSOutlineViewDataSource, NSOutlineViewDelegate {
    var rootURL: URL
    var changes: [NativeGitChange]
    var selectedPath: String?
    var expandAllDirectories: Bool
    var showsStateDots: Bool
    var onSelect: (NativeGitChange) -> Void
    weak var outlineView: NSOutlineView?
    private var fingerprint = ""
    private var root: NativeGitChangeNode?
    private var syncingSelection = false
    private var expandedDirectories = Set<String>()

    init(
      rootURL: URL,
      changes: [NativeGitChange],
      selectedPath: String?,
      expandAllDirectories: Bool,
      showsStateDots: Bool,
      onSelect: @escaping (NativeGitChange) -> Void
    ) {
      self.rootURL = rootURL
      self.changes = changes
      self.selectedPath = selectedPath
      self.expandAllDirectories = expandAllDirectories
      self.showsStateDots = showsStateDots
      self.onSelect = onSelect
    }

    func reload(force: Bool) {
      guard let outlineView else { return }
      let nextFingerprint = rootURL.path + "\u{3}" + String(expandAllDirectories) + "\u{2}"
        + changes.map { "\($0.code)\u{0}\($0.path)" }.joined(separator: "\u{1}")
      if force || fingerprint != nextFingerprint {
        captureExpansion(in: outlineView)
        fingerprint = nextFingerprint
        root = NativeGitChangeNode.tree(
          rootName: rootURL.lastPathComponent,
          changes: changes
        )
        outlineView.reloadData()
        if let root {
          outlineView.expandItem(root)
          restoreExpansion(in: outlineView, node: root)
        }
      }
      synchronizeSelection(in: outlineView)
    }

    func outlineView(_ outlineView: NSOutlineView, numberOfChildrenOfItem item: Any?) -> Int {
      if let node = item as? NativeGitChangeNode { return node.children.count }
      return root == nil ? 0 : 1
    }

    func outlineView(_ outlineView: NSOutlineView, isItemExpandable item: Any) -> Bool {
      (item as? NativeGitChangeNode)?.isDirectory == true
    }

    func outlineView(_ outlineView: NSOutlineView, child index: Int, ofItem item: Any?) -> Any {
      if let node = item as? NativeGitChangeNode { return node.children[index] }
      return root as Any
    }

    func outlineView(
      _ outlineView: NSOutlineView,
      viewFor tableColumn: NSTableColumn?,
      item: Any
    ) -> NSView? {
      guard let node = item as? NativeGitChangeNode else { return nil }
      let cell: NativeGitChangeCellView
      if let reused = outlineView.makeView(
        withIdentifier: .arkGitChangeCell,
        owner: self
      ) as? NativeGitChangeCellView {
        cell = reused
      } else {
        cell = NativeGitChangeCellView()
      }
      cell.configure(
        node: node,
        rootPath: rootURL.path,
        showsStateDots: showsStateDots
      )
      return cell
    }

    func outlineView(_ outlineView: NSOutlineView, shouldSelectItem item: Any) -> Bool {
      (item as? NativeGitChangeNode)?.change != nil
    }

    func outlineViewSelectionDidChange(_ notification: Notification) {
      guard !syncingSelection,
            let outlineView,
            outlineView.selectedRow >= 0,
            let node = outlineView.item(atRow: outlineView.selectedRow) as? NativeGitChangeNode,
            let change = node.change
      else { return }
      onSelect(change)
    }

    func outlineViewItemDidExpand(_ notification: Notification) {
      guard let node = notification.userInfo?["NSObject"] as? NativeGitChangeNode else { return }
      expandedDirectories.insert(node.identifier)
    }

    func outlineViewItemDidCollapse(_ notification: Notification) {
      guard let node = notification.userInfo?["NSObject"] as? NativeGitChangeNode else { return }
      expandedDirectories.remove(node.identifier)
    }

    func toggleDirectory(at row: Int, in outlineView: NSOutlineView) {
      guard row >= 0,
            let node = outlineView.item(atRow: row) as? NativeGitChangeNode,
            node.isDirectory
      else { return }
      if outlineView.isItemExpanded(node) {
        outlineView.collapseItem(node)
      } else {
        outlineView.expandItem(node)
      }
    }

    private func captureExpansion(in outlineView: NSOutlineView) {
      for row in 0..<outlineView.numberOfRows {
        guard let node = outlineView.item(atRow: row) as? NativeGitChangeNode,
              node.isDirectory
        else { continue }
        if outlineView.isItemExpanded(node) {
          expandedDirectories.insert(node.identifier)
        }
      }
    }

    private func restoreExpansion(
      in outlineView: NSOutlineView,
      node: NativeGitChangeNode
    ) {
      for child in node.children where child.isDirectory {
        if expandAllDirectories || expandedDirectories.contains(child.identifier) {
          outlineView.expandItem(child)
          restoreExpansion(in: outlineView, node: child)
        }
      }
    }

    private func synchronizeSelection(in outlineView: NSOutlineView) {
      guard let selectedPath else {
        if outlineView.selectedRow >= 0 {
          syncingSelection = true
          outlineView.deselectAll(nil)
          syncingSelection = false
        }
        return
      }
      for row in 0..<outlineView.numberOfRows {
        guard let node = outlineView.item(atRow: row) as? NativeGitChangeNode,
              node.change?.path == selectedPath
        else { continue }
        if outlineView.selectedRow != row {
          syncingSelection = true
          outlineView.selectRowIndexes(IndexSet(integer: row), byExtendingSelection: false)
          outlineView.scrollRowToVisible(row)
          syncingSelection = false
        }
        return
      }
    }
  }
}

private final class NativeGitChangeNode: NSObject {
  let identifier: String
  let name: String
  let relativePath: String
  let change: NativeGitChange?
  var children: [NativeGitChangeNode]

  var isDirectory: Bool { change == nil }

  init(
    identifier: String,
    name: String,
    relativePath: String,
    change: NativeGitChange? = nil,
    children: [NativeGitChangeNode] = []
  ) {
    self.identifier = identifier
    self.name = name
    self.relativePath = relativePath
    self.change = change
    self.children = children
  }

  static func tree(rootName: String, changes: [NativeGitChange]) -> NativeGitChangeNode {
    let root = NativeGitChangeNode(
      identifier: "directory:",
      name: rootName,
      relativePath: ""
    )
    var directories: [String: NativeGitChangeNode] = ["": root]

    for change in changes.sorted(by: { $0.path.localizedStandardCompare($1.path) == .orderedAscending }) {
      let components = change.path.split(separator: "/").map(String.init)
      guard let fileName = components.last else { continue }
      var parentPath = ""
      var parent = root
      for component in components.dropLast() {
        let path = parentPath.isEmpty ? component : parentPath + "/" + component
        if let existing = directories[path] {
          parent = existing
        } else {
          let directory = NativeGitChangeNode(
            identifier: "directory:\(path)",
            name: component,
            relativePath: path
          )
          parent.children.append(directory)
          directories[path] = directory
          parent = directory
        }
        parentPath = path
      }
      parent.children.append(
        NativeGitChangeNode(
          identifier: "file:\(change.path)",
          name: fileName,
          relativePath: change.path,
          change: change
        )
      )
    }
    sortRecursively(root)
    return root
  }

  private static func sortRecursively(_ node: NativeGitChangeNode) {
    node.children.sort { lhs, rhs in
      if lhs.isDirectory != rhs.isDirectory { return lhs.isDirectory }
      return lhs.name.localizedStandardCompare(rhs.name) == .orderedAscending
    }
    node.children.filter(\.isDirectory).forEach(sortRecursively)
  }
}

private final class NativeGitChangeCellView: NSTableCellView {
  private let statusField = NSTextField(labelWithString: "")
  private let icon = NSImageView()
  private let nameField = NSTextField(labelWithString: "")
  private let stagedDot = NSView()
  private let workingDot = NSView()

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    identifier = .arkGitChangeCell
    statusField.translatesAutoresizingMaskIntoConstraints = false
    icon.translatesAutoresizingMaskIntoConstraints = false
    nameField.translatesAutoresizingMaskIntoConstraints = false
    stagedDot.translatesAutoresizingMaskIntoConstraints = false
    workingDot.translatesAutoresizingMaskIntoConstraints = false
    statusField.font = .monospacedSystemFont(ofSize: 10, weight: .semibold)
    statusField.alignment = .center
    nameField.font = .systemFont(ofSize: 13)
    nameField.lineBreakMode = .byTruncatingMiddle
    nameField.maximumNumberOfLines = 1
    icon.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 13, weight: .regular)
    for dot in [stagedDot, workingDot] {
      dot.wantsLayer = true
      dot.layer?.cornerRadius = 2.5
    }
    addSubview(statusField)
    addSubview(icon)
    addSubview(nameField)
    addSubview(stagedDot)
    addSubview(workingDot)
    imageView = icon
    textField = nameField
    NSLayoutConstraint.activate([
      statusField.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 2),
      statusField.centerYAnchor.constraint(equalTo: centerYAnchor),
      statusField.widthAnchor.constraint(equalToConstant: 24),
      icon.leadingAnchor.constraint(equalTo: statusField.trailingAnchor, constant: 2),
      icon.centerYAnchor.constraint(equalTo: centerYAnchor),
      icon.widthAnchor.constraint(equalToConstant: 16),
      icon.heightAnchor.constraint(equalToConstant: 16),
      nameField.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 5),
      nameField.centerYAnchor.constraint(equalTo: centerYAnchor),
      stagedDot.leadingAnchor.constraint(greaterThanOrEqualTo: nameField.trailingAnchor, constant: 5),
      stagedDot.centerYAnchor.constraint(equalTo: centerYAnchor),
      stagedDot.widthAnchor.constraint(equalToConstant: 5),
      stagedDot.heightAnchor.constraint(equalToConstant: 5),
      workingDot.leadingAnchor.constraint(equalTo: stagedDot.trailingAnchor, constant: 4),
      workingDot.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -6),
      workingDot.centerYAnchor.constraint(equalTo: centerYAnchor),
      workingDot.widthAnchor.constraint(equalToConstant: 5),
      workingDot.heightAnchor.constraint(equalToConstant: 5),
    ])
  }

  required init?(coder: NSCoder) {
    fatalError("NativeGitChangeCellView is programmatic")
  }

  func configure(
    node: NativeGitChangeNode,
    rootPath: String,
    showsStateDots: Bool
  ) {
    statusField.isHidden = node.isDirectory
    statusField.stringValue = node.change?.code ?? ""
    if node.change?.hasConflict == true {
      statusField.textColor = .systemRed
    } else {
      statusField.textColor = node.change?.isUntracked == true ? .systemOrange : .controlAccentColor
    }
    icon.image = NSImage(
      systemSymbolName: node.isDirectory
        ? "folder"
        : node.change?.hasConflict == true
          ? "exclamationmark.triangle"
          : systemImage(for: node.name),
      accessibilityDescription: nil
    )
    icon.contentTintColor = node.change?.hasConflict == true
      ? .systemRed
      : node.isDirectory ? .secondaryLabelColor : fileTint(for: node.name)
    nameField.stringValue = node.name
    nameField.font = node.relativePath.isEmpty
      ? .systemFont(ofSize: 13, weight: .semibold)
      : .systemFont(ofSize: 13)
    nameField.toolTip = node.relativePath.isEmpty
      ? rootPath
      : URL(fileURLWithPath: rootPath).appendingPathComponent(node.relativePath).path
    stagedDot.isHidden = !showsStateDots || node.change?.hasStagedChange != true
    workingDot.isHidden = !showsStateDots || node.change?.hasWorkingChange != true
    stagedDot.layer?.backgroundColor = NSColor.systemGreen.cgColor
    workingDot.layer?.backgroundColor = NSColor.systemOrange.cgColor
    setAccessibilityLabel(
      node.change.map { "\($0.code) \($0.path)" } ?? node.name
    )
  }

  private func systemImage(for name: String) -> String {
    switch URL(fileURLWithPath: name).pathExtension.lowercased() {
    case "swift": return "swift"
    case "md", "txt": return "doc.plaintext"
    case "json", "yaml", "yml", "toml": return "curlybraces"
    default: return "doc"
    }
  }

  private func fileTint(for name: String) -> NSColor {
    switch URL(fileURLWithPath: name).pathExtension.lowercased() {
    case "swift": return .systemOrange
    case "md", "markdown": return .systemGreen
    case "json", "yaml", "yml", "toml": return .systemYellow
    default: return .secondaryLabelColor
    }
  }
}

private final class NativeGitClickableOutlineView: NSOutlineView {
  var onDirectoryClick: ((Int) -> Void)?

  override func mouseDown(with event: NSEvent) {
    let point = convert(event.locationInWindow, from: nil)
    let clickedRow = row(at: point)
    let disclosureFrame = clickedRow >= 0 ? frameOfOutlineCell(atRow: clickedRow) : .zero
    let clickedDisclosure = disclosureFrame.contains(point)
    let clickedDirectory = clickedRow >= 0
      && (item(atRow: clickedRow) as? NativeGitChangeNode)?.isDirectory == true
    super.mouseDown(with: event)
    guard event.clickCount == 1, clickedDirectory, !clickedDisclosure else { return }
    onDirectoryClick?(clickedRow)
  }
}

private extension NSUserInterfaceItemIdentifier {
  static let arkGitChangeColumn = NSUserInterfaceItemIdentifier("ark.review.change")
  static let arkGitChangeCell = NSUserInterfaceItemIdentifier("ark.review.change-cell")
}
