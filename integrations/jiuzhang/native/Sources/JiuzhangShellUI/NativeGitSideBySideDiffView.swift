import AppKit
import SwiftUI

struct NativeGitDiffDocument: Equatable {
  enum CellKind: Equatable {
    case context
    case deletion
    case addition
    case empty
    case hunk
    case metadata
  }

  struct Row: Equatable {
    let oldLine: Int?
    let oldText: String
    let oldKind: CellKind
    let newLine: Int?
    let newText: String
    let newKind: CellKind
  }

  let rows: [Row]

  init(patch: String) {
    let lines = patch.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
    var rows: [Row] = []
    var index = 0
    var oldLine = 0
    var newLine = 0
    var previousOldHunkEnd: Int?

    while index < lines.count {
      let line = lines[index]
      if line.hasPrefix("diff --git ") {
        rows.append(Self.spanningRow(line, kind: .metadata))
        index += 1
        continue
      }
      if line.hasPrefix("index ") || line.hasPrefix("--- ") || line.hasPrefix("+++ ") {
        index += 1
        continue
      }
      if let hunk = Self.parseHunkHeader(line) {
        let skipped: Int
        if let previousOldHunkEnd {
          skipped = max(0, hunk.oldStart - previousOldHunkEnd)
        } else {
          skipped = max(0, hunk.oldStart - 1)
        }
        let title = skipped > 0 ? "… \(skipped) unmodified lines" : line
        rows.append(Self.spanningRow(title, kind: .hunk))
        oldLine = hunk.oldStart
        newLine = hunk.newStart
        previousOldHunkEnd = hunk.oldStart + hunk.oldCount
        index += 1
        continue
      }
      if line.hasPrefix(" ") {
        let value = String(line.dropFirst())
        rows.append(
          Row(
            oldLine: oldLine,
            oldText: value,
            oldKind: .context,
            newLine: newLine,
            newText: value,
            newKind: .context
          )
        )
        oldLine += 1
        newLine += 1
        index += 1
        continue
      }
      if line.hasPrefix("-") && !line.hasPrefix("---") {
        var deletions: [String] = []
        while index < lines.count,
              lines[index].hasPrefix("-"),
              !lines[index].hasPrefix("---") {
          deletions.append(String(lines[index].dropFirst()))
          index += 1
        }
        var additions: [String] = []
        while index < lines.count,
              lines[index].hasPrefix("+"),
              !lines[index].hasPrefix("+++") {
          additions.append(String(lines[index].dropFirst()))
          index += 1
        }
        let rowCount = max(deletions.count, additions.count)
        for offset in 0..<rowCount {
          let deletion = offset < deletions.count ? deletions[offset] : nil
          let addition = offset < additions.count ? additions[offset] : nil
          rows.append(
            Row(
              oldLine: deletion == nil ? nil : oldLine,
              oldText: deletion ?? "",
              oldKind: deletion == nil ? .empty : .deletion,
              newLine: addition == nil ? nil : newLine,
              newText: addition ?? "",
              newKind: addition == nil ? .empty : .addition
            )
          )
          if deletion != nil { oldLine += 1 }
          if addition != nil { newLine += 1 }
        }
        continue
      }
      if line.hasPrefix("+") && !line.hasPrefix("+++") {
        rows.append(
          Row(
            oldLine: nil,
            oldText: "",
            oldKind: .empty,
            newLine: newLine,
            newText: String(line.dropFirst()),
            newKind: .addition
          )
        )
        newLine += 1
        index += 1
        continue
      }
      if line.hasPrefix("\\ No newline at end of file") || line.isEmpty {
        index += 1
        continue
      }
      rows.append(Self.spanningRow(line, kind: .metadata))
      index += 1
    }
    self.rows = rows
  }

  private static func spanningRow(_ text: String, kind: CellKind) -> Row {
    Row(
      oldLine: nil,
      oldText: text,
      oldKind: kind,
      newLine: nil,
      newText: text,
      newKind: kind
    )
  }

  private static func parseHunkHeader(
    _ line: String
  ) -> (oldStart: Int, oldCount: Int, newStart: Int)? {
    let pattern = #"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@"#
    guard let expression = try? NSRegularExpression(pattern: pattern),
          let match = expression.firstMatch(
            in: line,
            range: NSRange(location: 0, length: (line as NSString).length)
          )
    else { return nil }
    let value = line as NSString
    func integer(_ index: Int, default fallback: Int) -> Int {
      let range = match.range(at: index)
      guard range.location != NSNotFound else { return fallback }
      return Int(value.substring(with: range)) ?? fallback
    }
    return (
      oldStart: integer(1, default: 0),
      oldCount: integer(2, default: 1),
      newStart: integer(3, default: 0)
    )
  }
}

/// A single AppKit table owns both sides of the Git diff, so vertical motion,
/// row alignment, selection-free review, and inertial scrolling cannot drift.
struct NativeGitSideBySideDiffView: NSViewRepresentable {
  let patch: String
  let fileURL: URL?

  func makeCoordinator() -> Coordinator {
    Coordinator(patch: patch, fileURL: fileURL)
  }

  func makeNSView(context: Context) -> NativeGitDiffScrollView {
    let table = NSTableView()
    let column = NSTableColumn(identifier: .arkGitSplitDiffColumn)
    table.addTableColumn(column)
    table.headerView = nil
    table.rowSizeStyle = .custom
    table.rowHeight = 24
    table.intercellSpacing = .zero
    table.allowsEmptySelection = true
    table.allowsMultipleSelection = false
    table.selectionHighlightStyle = .none
    table.backgroundColor = .textBackgroundColor
    table.delegate = context.coordinator
    table.dataSource = context.coordinator

    let scrollView = NativeGitDiffScrollView()
    scrollView.borderType = .noBorder
    scrollView.drawsBackground = true
    scrollView.backgroundColor = .textBackgroundColor
    scrollView.hasVerticalScroller = true
    scrollView.hasHorizontalScroller = true
    scrollView.autohidesScrollers = true
    scrollView.documentView = table
    scrollView.onLayout = { [weak coordinator = context.coordinator, weak scrollView] in
      guard let coordinator, let scrollView else { return }
      coordinator.updateColumnWidth(in: scrollView)
    }
    context.coordinator.tableView = table
    context.coordinator.column = column
    context.coordinator.reload(force: true, in: scrollView)
    return scrollView
  }

  func updateNSView(_ scrollView: NativeGitDiffScrollView, context: Context) {
    context.coordinator.patch = patch
    context.coordinator.fileURL = fileURL
    context.coordinator.reload(force: false, in: scrollView)
  }

  static func dismantleNSView(
    _ scrollView: NativeGitDiffScrollView,
    coordinator: Coordinator
  ) {
    coordinator.tableView?.delegate = nil
    coordinator.tableView?.dataSource = nil
    coordinator.tableView = nil
    coordinator.column = nil
    scrollView.onLayout = nil
    scrollView.documentView = nil
  }

  @MainActor
  final class Coordinator: NSObject, NSTableViewDataSource, NSTableViewDelegate {
    var patch: String
    var fileURL: URL?
    weak var tableView: NSTableView?
    weak var column: NSTableColumn?
    private var fingerprint = ""
    private var rows: [NativeGitDiffDocument.Row] = []
    private var preferredContentWidth: CGFloat = 1200

    init(patch: String, fileURL: URL?) {
      self.patch = patch
      self.fileURL = fileURL
    }

    func reload(force: Bool, in scrollView: NSScrollView) {
      let next = String(patch.hashValue) + "\u{0}" + (fileURL?.pathExtension ?? "")
      guard force || fingerprint != next else {
        updateColumnWidth(in: scrollView)
        return
      }
      fingerprint = next
      rows = NativeGitDiffDocument(patch: patch).rows
      let maximumCharacters = rows.reduce(0) { result, row in
        max(result, row.oldText.count + row.newText.count)
      }
      preferredContentWidth = min(12_000, max(1200, CGFloat(maximumCharacters * 8 + 150)))
      tableView?.reloadData()
      updateColumnWidth(in: scrollView)
    }

    func updateColumnWidth(in scrollView: NSScrollView) {
      let width = max(scrollView.contentSize.width, preferredContentWidth)
      guard abs((column?.width ?? 0) - width) > 0.5 else { return }
      column?.width = width
      tableView?.frame.size.width = width
    }

    func numberOfRows(in tableView: NSTableView) -> Int { rows.count }

    func tableView(
      _ tableView: NSTableView,
      viewFor tableColumn: NSTableColumn?,
      row: Int
    ) -> NSView? {
      guard rows.indices.contains(row) else { return nil }
      let cell: NativeGitSplitDiffCell
      if let reused = tableView.makeView(
        withIdentifier: .arkGitSplitDiffCell,
        owner: self
      ) as? NativeGitSplitDiffCell {
        cell = reused
      } else {
        cell = NativeGitSplitDiffCell()
      }
      cell.configure(row: rows[row], fileExtension: fileURL?.pathExtension)
      return cell
    }

    func tableView(_ tableView: NSTableView, heightOfRow row: Int) -> CGFloat {
      guard rows.indices.contains(row) else { return 24 }
      let kind = rows[row].oldKind
      return kind == .hunk || kind == .metadata ? 28 : 24
    }
  }
}

final class NativeGitDiffScrollView: NSScrollView {
  var onLayout: (() -> Void)?

  override func layout() {
    super.layout()
    onLayout?()
  }
}

private final class NativeGitSplitDiffCell: NSTableCellView {
  private let left = NativeGitDiffSideView()
  private let right = NativeGitDiffSideView()
  private let divider = NSView()

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    identifier = .arkGitSplitDiffCell
    left.translatesAutoresizingMaskIntoConstraints = false
    right.translatesAutoresizingMaskIntoConstraints = false
    divider.translatesAutoresizingMaskIntoConstraints = false
    divider.wantsLayer = true
    divider.layer?.backgroundColor = NSColor.separatorColor.cgColor
    addSubview(left)
    addSubview(divider)
    addSubview(right)
    NSLayoutConstraint.activate([
      left.leadingAnchor.constraint(equalTo: leadingAnchor),
      left.topAnchor.constraint(equalTo: topAnchor),
      left.bottomAnchor.constraint(equalTo: bottomAnchor),
      left.widthAnchor.constraint(equalTo: widthAnchor, multiplier: 0.5, constant: -0.5),
      divider.leadingAnchor.constraint(equalTo: left.trailingAnchor),
      divider.topAnchor.constraint(equalTo: topAnchor),
      divider.bottomAnchor.constraint(equalTo: bottomAnchor),
      divider.widthAnchor.constraint(equalToConstant: 1),
      right.leadingAnchor.constraint(equalTo: divider.trailingAnchor),
      right.trailingAnchor.constraint(equalTo: trailingAnchor),
      right.topAnchor.constraint(equalTo: topAnchor),
      right.bottomAnchor.constraint(equalTo: bottomAnchor),
    ])
  }

  required init?(coder: NSCoder) {
    fatalError("NativeGitSplitDiffCell is programmatic")
  }

  func configure(row: NativeGitDiffDocument.Row, fileExtension: String?) {
    left.configure(
      line: row.oldLine,
      text: row.oldText,
      kind: row.oldKind,
      fileExtension: fileExtension
    )
    right.configure(
      line: row.newLine,
      text: row.newText,
      kind: row.newKind,
      fileExtension: fileExtension
    )
    setAccessibilityLabel(
      "old \(row.oldLine.map(String.init) ?? "") \(row.oldText), "
        + "new \(row.newLine.map(String.init) ?? "") \(row.newText)"
    )
  }
}

private final class NativeGitDiffSideView: NSView {
  private let number = NSTextField(labelWithString: "")
  private let code = NSTextField(labelWithString: "")

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    wantsLayer = true
    number.translatesAutoresizingMaskIntoConstraints = false
    code.translatesAutoresizingMaskIntoConstraints = false
    number.font = .monospacedDigitSystemFont(ofSize: 11, weight: .regular)
    number.textColor = .secondaryLabelColor
    number.alignment = .right
    code.font = NativeCodeSyntax.baseFont
    code.lineBreakMode = .byClipping
    code.maximumNumberOfLines = 1
    addSubview(number)
    addSubview(code)
    NSLayoutConstraint.activate([
      number.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 4),
      number.widthAnchor.constraint(equalToConstant: 40),
      number.centerYAnchor.constraint(equalTo: centerYAnchor),
      code.leadingAnchor.constraint(equalTo: number.trailingAnchor, constant: 10),
      code.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
      code.centerYAnchor.constraint(equalTo: centerYAnchor),
    ])
  }

  required init?(coder: NSCoder) {
    fatalError("NativeGitDiffSideView is programmatic")
  }

  func configure(
    line: Int?,
    text: String,
    kind: NativeGitDiffDocument.CellKind,
    fileExtension: String?
  ) {
    number.stringValue = line.map(String.init) ?? ""
    code.attributedStringValue = highlighted(text, fileExtension: fileExtension, kind: kind)
    switch kind {
    case .deletion:
      layer?.backgroundColor = NSColor.systemRed.withAlphaComponent(0.10).cgColor
      number.textColor = .systemRed
    case .addition:
      layer?.backgroundColor = NSColor.systemGreen.withAlphaComponent(0.10).cgColor
      number.textColor = .systemGreen
    case .empty:
      layer?.backgroundColor = NSColor.quaternaryLabelColor.withAlphaComponent(0.035).cgColor
      number.textColor = .secondaryLabelColor
    case .hunk:
      layer?.backgroundColor = NSColor.controlBackgroundColor.cgColor
      number.textColor = .secondaryLabelColor
    case .metadata:
      layer?.backgroundColor = NSColor.underPageBackgroundColor.cgColor
      number.textColor = .secondaryLabelColor
    case .context:
      layer?.backgroundColor = NSColor.textBackgroundColor.cgColor
      number.textColor = .secondaryLabelColor
    }
  }

  private func highlighted(
    _ text: String,
    fileExtension: String?,
    kind: NativeGitDiffDocument.CellKind
  ) -> NSAttributedString {
    let value = NSMutableAttributedString(
      string: text,
      attributes: [
        .font: NativeCodeSyntax.baseFont,
        .foregroundColor: kind == .hunk || kind == .metadata
          ? NSColor.secondaryLabelColor
          : NSColor.labelColor,
      ]
    )
    guard kind != .hunk, kind != .metadata, kind != .empty else { return value }
    for span in NativeCodeSyntax.spans(
      in: text,
      fileExtension: fileExtension,
      presentation: .source
    ) where NSMaxRange(span.range) <= value.length {
      value.addAttribute(.foregroundColor, value: span.kind.color, range: span.range)
    }
    return value
  }
}

private extension NSUserInterfaceItemIdentifier {
  static let arkGitSplitDiffColumn = NSUserInterfaceItemIdentifier("ark.review.split-diff")
  static let arkGitSplitDiffCell = NSUserInterfaceItemIdentifier("ark.review.split-diff-cell")
}
