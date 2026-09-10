import AppKit
import SwiftUI

/// AppKit-backed file tree for Native Files.
///
/// `NSOutlineView` owns row reuse, keyboard selection, disclosure state, and
/// inertial scrolling. SwiftUI only supplies the shared Workbench model; it no
/// longer rebuilds a recursive view tree for every scroll or selection change.
struct NativeFileOutlineView: NSViewRepresentable {
  @ObservedObject var model: NativeWorkbenchModel

  func makeCoordinator() -> Coordinator {
    Coordinator(model: model)
  }

  func makeNSView(context: Context) -> NSScrollView {
    let outline = NativeClickableOutlineView()
    let column = NSTableColumn(identifier: .arkFileNameColumn)
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
    outline.onRowClick = { [weak coordinator = context.coordinator, weak outline] row, wasSelected in
      guard let coordinator, let outline else { return }
      coordinator.handleRowClick(row, wasSelected: wasSelected, in: outline)
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
    context.coordinator.model = model
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
    var model: NativeWorkbenchModel
    weak var outlineView: NSOutlineView?
    private var displayedRevision = -1
    private var displayedQuery = ""
    private var syncingSelection = false
    private var roots: [NativeFileNode] = []

    init(model: NativeWorkbenchModel) {
      self.model = model
    }

    func reload(force: Bool) {
      guard let outlineView else { return }
      let query = model.fileSearchQuery
      if force || displayedRevision != model.fileTreeRevision || displayedQuery != query {
        displayedRevision = model.fileTreeRevision
        displayedQuery = query
        roots = model.filteredRootNodes
        outlineView.reloadData()
        restoreExpansion(in: outlineView, nodes: roots)
      }
      synchronizeSelection(in: outlineView)
    }

    func outlineView(_ outlineView: NSOutlineView, numberOfChildrenOfItem item: Any?) -> Int {
      if let node = item as? NativeFileNode { return node.children?.count ?? 0 }
      return roots.count
    }

    func outlineView(_ outlineView: NSOutlineView, isItemExpandable item: Any) -> Bool {
      (item as? NativeFileNode)?.isDirectory == true
    }

    func outlineView(_ outlineView: NSOutlineView, child index: Int, ofItem item: Any?) -> Any {
      if let node = item as? NativeFileNode {
        return node.children?[index] as Any
      }
      return roots[index]
    }

    func outlineView(
      _ outlineView: NSOutlineView,
      viewFor tableColumn: NSTableColumn?,
      item: Any
    ) -> NSView? {
      guard let node = item as? NativeFileNode else { return nil }
      let cell: NSTableCellView
      if let reused = outlineView.makeView(withIdentifier: .arkFileCell, owner: self) as? NSTableCellView {
        cell = reused
      } else {
        cell = makeCell()
      }
      cell.textField?.stringValue = node.name
      cell.textField?.font = node.url == model.rootURL
        ? .systemFont(ofSize: 13, weight: .semibold)
        : .systemFont(ofSize: 13)
      cell.textField?.toolTip = node.url.path
      cell.imageView?.image = NSImage(
        systemSymbolName: node.isDirectory ? "folder" : node.systemImage,
        accessibilityDescription: nil
      )
      cell.imageView?.contentTintColor = node.isDirectory ? .secondaryLabelColor : fileTint(for: node)
      return cell
    }

    func outlineViewSelectionDidChange(_ notification: Notification) {
      guard !syncingSelection,
            let outlineView,
            outlineView.selectedRow >= 0,
            let node = outlineView.item(atRow: outlineView.selectedRow) as? NativeFileNode
      else { return }
      model.selectTreeNode(node)
      guard !node.isDirectory else { return }
      Task { await model.selectFile(node.url) }
    }

    func outlineView(_ outlineView: NSOutlineView, shouldExpandItem item: Any) -> Bool {
      guard let node = item as? NativeFileNode else { return false }
      node.isExpanded = true
      if node.children != nil { return true }
      // Never call `expandItem` from this delegate callback or its completion.
      // The async load publishes `fileTreeRevision`; the following representable
      // update reloads the tree and `restoreExpansion` performs one non-reentrant
      // expansion after children exist.
      model.loadChildren(of: node)
      return false
    }

    func outlineViewItemDidExpand(_ notification: Notification) {
      (notification.userInfo?["NSObject"] as? NativeFileNode)?.isExpanded = true
    }

    func outlineViewItemDidCollapse(_ notification: Notification) {
      (notification.userInfo?["NSObject"] as? NativeFileNode)?.isExpanded = false
    }

    private func makeCell() -> NSTableCellView {
      let cell = NSTableCellView()
      cell.identifier = .arkFileCell
      let icon = NSImageView()
      icon.translatesAutoresizingMaskIntoConstraints = false
      icon.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 13, weight: .regular)
      let label = NSTextField(labelWithString: "")
      label.translatesAutoresizingMaskIntoConstraints = false
      label.font = .systemFont(ofSize: 13)
      label.lineBreakMode = .byTruncatingMiddle
      label.maximumNumberOfLines = 1
      cell.addSubview(icon)
      cell.addSubview(label)
      cell.imageView = icon
      cell.textField = label
      NSLayoutConstraint.activate([
        icon.leadingAnchor.constraint(equalTo: cell.leadingAnchor, constant: 3),
        icon.centerYAnchor.constraint(equalTo: cell.centerYAnchor),
        icon.widthAnchor.constraint(equalToConstant: 16),
        icon.heightAnchor.constraint(equalToConstant: 16),
        label.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 5),
        label.trailingAnchor.constraint(equalTo: cell.trailingAnchor, constant: -6),
        label.centerYAnchor.constraint(equalTo: cell.centerYAnchor),
      ])
      return cell
    }

    private func restoreExpansion(in outlineView: NSOutlineView, nodes: [NativeFileNode]) {
      for node in nodes where node.isDirectory && node.isExpanded {
        outlineView.expandItem(node)
        if let children = node.children { restoreExpansion(in: outlineView, nodes: children) }
      }
    }

    private func synchronizeSelection(in outlineView: NSOutlineView) {
      guard let path = model.activeFileTab?.canonicalPath else {
        if outlineView.selectedRow >= 0 {
          syncingSelection = true
          outlineView.deselectAll(nil)
          syncingSelection = false
        }
        return
      }
      for row in 0..<outlineView.numberOfRows {
        guard let node = outlineView.item(atRow: row) as? NativeFileNode,
              node.canonicalPath == path
        else { continue }
        if outlineView.selectedRow != row {
          syncingSelection = true
          outlineView.selectRowIndexes(IndexSet(integer: row), byExtendingSelection: false)
          outlineView.scrollRowToVisible(row)
          syncingSelection = false
        }
        break
      }
    }

    func handleRowClick(_ row: Int, wasSelected: Bool, in outlineView: NSOutlineView) {
      guard row >= 0,
            let node = outlineView.item(atRow: row) as? NativeFileNode
      else { return }
      if node.isDirectory {
        if outlineView.isItemExpanded(node) {
          outlineView.collapseItem(node)
        } else {
          outlineView.expandItem(node)
        }
      } else if wasSelected {
        Task { await model.selectFile(node.url) }
      }
    }

    private func fileTint(for node: NativeFileNode) -> NSColor {
      switch node.url.pathExtension.lowercased() {
      case "swift": return .systemOrange
      case "md", "markdown": return .systemGreen
      case "json", "yaml", "yml", "toml": return .systemYellow
      default: return .secondaryLabelColor
      }
    }
  }
}

/// NSOutlineView keeps disclosure-triangle behavior, while a single click on
/// the rest of a directory row toggles that directory. File rows continue to
/// open through the selection delegate. The disclosure hit is excluded so one
/// physical click can never expand and immediately collapse the same item.
private final class NativeClickableOutlineView: NSOutlineView {
  var onRowClick: ((Int, Bool) -> Void)?

  override func mouseDown(with event: NSEvent) {
    let point = convert(event.locationInWindow, from: nil)
    let clickedRow = row(at: point)
    let wasSelected = clickedRow >= 0 && selectedRow == clickedRow
    let disclosureFrame = clickedRow >= 0 ? frameOfOutlineCell(atRow: clickedRow) : .zero
    let clickedDisclosure = disclosureFrame.contains(point)
    super.mouseDown(with: event)
    guard event.clickCount == 1, clickedRow >= 0, !clickedDisclosure else { return }
    onRowClick?(clickedRow, wasSelected)
  }
}

/// Native search field fixed above the outline instead of scrolling with rows.
struct NativeWorkbenchSearchField: NSViewRepresentable {
  @Binding var text: String
  let placeholder: String

  func makeCoordinator() -> Coordinator { Coordinator(text: $text) }

  func makeNSView(context: Context) -> NSSearchField {
    let field = NSSearchField()
    field.delegate = context.coordinator
    field.placeholderString = placeholder
    field.font = .systemFont(ofSize: 12)
    field.controlSize = .small
    field.sendsSearchStringImmediately = true
    field.sendsWholeSearchString = true
    return field
  }

  func updateNSView(_ field: NSSearchField, context: Context) {
    if field.stringValue != text { field.stringValue = text }
    field.placeholderString = placeholder
  }

  final class Coordinator: NSObject, NSSearchFieldDelegate {
    @Binding var text: String

    init(text: Binding<String>) { _text = text }

    func controlTextDidChange(_ notification: Notification) {
      guard let field = notification.object as? NSSearchField else { return }
      text = field.stringValue
    }
  }
}

private extension NSUserInterfaceItemIdentifier {
  static let arkFileNameColumn = NSUserInterfaceItemIdentifier("ark.files.name")
  static let arkFileCell = NSUserInterfaceItemIdentifier("ark.files.cell")
}
