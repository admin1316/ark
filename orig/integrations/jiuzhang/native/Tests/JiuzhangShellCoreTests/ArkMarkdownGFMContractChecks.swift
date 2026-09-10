import AppKit
import Darwin
import Foundation
import JiuzhangShellCore
import SwiftUI
@testable import JiuzhangShellUI

private func runMathRenderCacheChecks() {
  let coordinator = NativeGFMMathLabel.Coordinator()
  let initial = NativeGFMMathLabel.Coordinator.RenderInputs(
    source: "x^2",
    fontSize: 15,
    dark: false
  )
  check(
    coordinator.claimRender(initial) && !coordinator.claimRender(initial),
    "native math renderer claims identical source, font, and color inputs only once"
  )
  check(
    coordinator.claimRender(.init(source: "x^2", fontSize: 15, dark: true)),
    "native math renderer invalidates when a real color-scheme input changes"
  )
}

private func runSwiftMathPackagingAdapterChecks() {
  let fileManager = FileManager.default
  let buildScript = contractNativeRoot.appendingPathComponent("build-app.sh")
  let oldBundle = #"Bundle(url: Bundle.module.url(forResource: "mathFonts", withExtension: "bundle")!)!"#
  let oldLookup = #"Bundle.module.url(forResource: "mathFonts", withExtension: "bundle")"#
  let newBundle = #"Bundle(url: arkSwiftMathBundle().url(forResource: "mathFonts", withExtension: "bundle")!)!"#
  let newLookup = #"arkSwiftMathBundle().url(forResource: "mathFonts", withExtension: "bundle")"#
  let pinnedMTFont = """
  import Foundation

  public class MTFont {
      let mathTable = \(oldBundle)
  }
  """
  let pinnedMathFont = """
  import Foundation

  let first = \(oldLookup)
  let second = \(oldLookup)
  """

  struct AdapterResult {
    let status: Int32
    let output: String
    let mtFont: String
    let mathFont: String
  }

  func executeFixture(name: String, mtFont: String, mathFont: String) -> AdapterResult? {
    let root = fileManager.temporaryDirectory
      .appendingPathComponent("ark-swiftmath-\(name)-\(UUID().uuidString)", isDirectory: true)
    let mtURL = root.appendingPathComponent("Sources/SwiftMath/MathRender/MTFont.swift")
    let mathURL = root.appendingPathComponent("Sources/SwiftMath/MathBundle/MathFont.swift")
    defer { try? fileManager.removeItem(at: root) }
    do {
      try fileManager.createDirectory(
        at: mtURL.deletingLastPathComponent(),
        withIntermediateDirectories: true
      )
      try fileManager.createDirectory(
        at: mathURL.deletingLastPathComponent(),
        withIntermediateDirectories: true
      )
      try mtFont.write(to: mtURL, atomically: true, encoding: .utf8)
      try mathFont.write(to: mathURL, atomically: true, encoding: .utf8)

      let process = Process()
      let pipe = Pipe()
      process.executableURL = URL(fileURLWithPath: "/bin/zsh")
      process.arguments = [buildScript.path, "--adapt-swiftmath-checkout", root.path]
      process.standardOutput = pipe
      process.standardError = pipe
      try process.run()
      let output = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
      process.waitUntilExit()
      return AdapterResult(
        status: process.terminationStatus,
        output: output,
        mtFont: try String(contentsOf: mtURL, encoding: .utf8),
        mathFont: try String(contentsOf: mathURL, encoding: .utf8)
      )
    } catch {
      return nil
    }
  }

  if let success = executeFixture(name: "pinned", mtFont: pinnedMTFont, mathFont: pinnedMathFont) {
    check(
      success.status == 0
        && success.output.contains("replaced MTFont=1 MathFont=2 anchors")
        && success.mtFont.components(separatedBy: newBundle).count == 2
        && success.mtFont.components(separatedBy: oldBundle).count == 1
        && success.mtFont.components(separatedBy: "func arkSwiftMathBundle()").count == 2
        && success.mathFont.components(separatedBy: newLookup).count == 3
        && success.mathFont.components(separatedBy: oldLookup).count == 1,
      "SwiftMath packaging adapter replaces exactly one MTFont anchor and two MathFont anchors"
    )
  } else {
    check(false, "SwiftMath packaging adapter executes against the pinned-source fixture")
  }

  let failingFixtures: [(String, String, String)] = [
    ("mt-drift", pinnedMTFont.replacingOccurrences(of: "mathFonts", with: "renamedFonts"), pinnedMathFont),
    ("mt-duplicate", pinnedMTFont + "\nlet duplicate = \(oldBundle)\n", pinnedMathFont),
    ("mt-missing", pinnedMTFont.replacingOccurrences(of: oldBundle, with: "Bundle.module"), pinnedMathFont),
    ("math-drift", pinnedMTFont, pinnedMathFont.replacingOccurrences(of: "mathFonts", with: "renamedFonts")),
    ("math-duplicate", pinnedMTFont, pinnedMathFont + "\nlet third = \(oldLookup)\n"),
    ("math-missing", pinnedMTFont, pinnedMathFont.replacingOccurrences(of: "let second = \(oldLookup)", with: "")),
    ("pre-adapted", pinnedMTFont.replacingOccurrences(of: oldBundle, with: newBundle), pinnedMathFont),
  ]
  let failuresCloseWithoutWrites = failingFixtures.allSatisfy { name, mtFont, mathFont in
    guard let result = executeFixture(name: name, mtFont: mtFont, mathFont: mathFont) else {
      return false
    }
    return result.status != 0 && result.mtFont == mtFont && result.mathFont == mathFont
  }
  check(
    failuresCloseWithoutWrites,
    "SwiftMath packaging adapter fails closed without partial writes on drifted, duplicate, missing, or pre-adapted anchors"
  )
}

@MainActor
func runArkMarkdownGFMContractChecks() {
  runMathRenderCacheChecks()
  runSwiftMathPackagingAdapterChecks()
  let fixture = #"""
  # 中文 **粗体** 与 ~~删除~~

  段落含 [安全链接][docs]、行内 `code`、公式 \(E = mc^2\) 与脚注[^proof]。

  - [x] 已完成
    - 嵌套项目
  - [ ] 未完成

  3. 第三项
     1. 嵌套编号

  > 引用中的 **强调**

  | 左 | 中 | 右 |
  | :-- | :-: | --: |
  | A | B | C |

  ```swift
  let answer = 42
  ```

  $$
  \frac{-b \pm \sqrt{b^2-4ac}}{2a}
  $$

  <script>alert("literal")</script>

  [docs]: https://example.com/docs
  [^proof]: 第一行
      第二行
  """#

  let blocks = NativeGFMParser.parse(fixture)
  check(
    blocks.contains { block in
      guard case .heading(level: 1, let content) = block else { return false }
      return containsInline(content) { if case .strong = $0 { return true }; return false }
        && containsInline(content) { if case .strikethrough = $0 { return true }; return false }
    },
    "native Markdown parses CJK strong emphasis and GFM strikethrough in one heading"
  )
  let paragraphs = blocks.compactMap { block -> [NativeGFMInline]? in
    guard case .paragraph(let content) = block else { return nil }
    return content
  }
  check(
    paragraphs.contains { content in
      containsInline(content) {
        if case .link(let destination, _, _) = $0 {
          return destination == "https://example.com/docs"
        }
        return false
      }
    },
    "native Markdown resolves reference links"
  )
  check(
    paragraphs.contains { content in
      containsInline(content) { if case .math("E = mc^2") = $0 { return true }; return false }
    },
    "native Markdown preserves inline math"
  )
  check(
    paragraphs.contains { content in
      containsInline(content) {
        if case .footnoteReference(id: "PROOF", number: 1) = $0 { return true }
        return false
      }
    },
    "native Markdown numbers referenced footnotes"
  )
  check(
    blocks.contains { block in
      guard case .list(ordered: false, _, let items) = block, items.count == 2 else { return false }
      return items[0].checkbox == true
        && items[1].checkbox == false
        && items[0].blocks.contains {
          if case .list(ordered: false, _, let nested) = $0 { return nested.count == 1 }
          return false
        }
    },
    "native Markdown preserves task state and nested unordered-list structure"
  )
  check(
    blocks.contains { block in
      guard case .list(ordered: true, start: 3, let items) = block else { return false }
      return items.first?.blocks.contains {
        if case .list(ordered: true, start: 1, _) = $0 { return true }
        return false
      } == true
    },
    "native Markdown preserves ordered-list start values and nested numbering"
  )
  check(
    blocks.contains { block in
      guard case .table(let alignments, let headers, let rows) = block else { return false }
      return alignments == [.left, .center, .right]
        && headers.count == 3
        && rows.count == 1
        && rows[0].count == 3
    },
    "native Markdown preserves GFM table cells and column alignment"
  )
  check(
    ArkGFMTableAccessibility.label(
      value: "内存", header: "内存", rowIndex: nil,
      columnIndex: 1, isHeader: true
    ) == "2: 内存"
      && ArkGFMTableAccessibility.label(
        value: "162MB", header: "内存", rowIndex: 2,
        columnIndex: 1, isHeader: false
      ) == "3-2: 内存: 162MB"
      && ArkGFMTableAccessibility.identifier(
        tableID: "root.4", rowIndex: 2, columnIndex: 1, isHeader: false
      ) == "ark.markdown.table.root.4.cell.2.1"
      && ArkGFMTableAccessibility.identifier(
        tableID: "root.7", rowIndex: 2, columnIndex: 1, isHeader: false
      ) != ArkGFMTableAccessibility.identifier(
        tableID: "root.4", rowIndex: 2, columnIndex: 1, isHeader: false
      ),
    "native Markdown table accessibility binds every body value to its column header and stable row-column position"
  )
  check(
    blocks.contains { if case .code(language: "swift", source: let source) = $0 { return source.contains("let answer = 42") }; return false },
    "native Markdown preserves fenced-code language and exact source"
  )
  check(
    blocks.contains { if case .math(let source) = $0 { return source.contains("\\frac") }; return false },
    "native Markdown promotes settled display TeX to a native math block"
  )
  check(
    blocks.contains { block in
      guard case .footnotes(let notes) = block, notes.count == 1 else { return false }
      return notes[0].id == "PROOF"
        && notes[0].number == 1
        && containsLiteral(notes[0].blocks, "第一行")
        && containsLiteral(notes[0].blocks, "第二行")
    },
    "native Markdown renders referenced footnote definitions once in document order"
  )
  check(
    blocks.contains { if case .literal(let source) = $0 { return source.contains("<script>") }; return false },
    "native Markdown keeps raw HTML literal instead of executing it"
  )
  check(
    NativeGFMParser.parse(fixture) == blocks,
    "native Markdown parsing is deterministic for cache-safe streaming snapshots"
  )

  let largeFinalFixture = (0..<2_048)
    .map { "Final block \($0) preserves **complete** native Markdown." }
    .joined(separator: "\n\n")
  let largeFinalBlocks = NativeGFMParser.parse(largeFinalFixture)
  check(
    largeFinalBlocks.count == 2_048
      && containsLiteral(largeFinalBlocks.prefix(1).map { $0 }, "Final block 0")
      && containsLiteral(largeFinalBlocks.suffix(1).map { $0 }, "Final block 2047"),
    "native Markdown preserves every top-level block in a 2048-block final answer"
  )
  let mixedMessage = ArkMessage(
    id: 42,
    role: .assistant,
    text: "",
    blocks: [
      .text("source-a"),
      .image("image-1"),
      .reasoning("reasoning-2"),
      .text("source-b"),
      .unknown(type: "future", value: .string("value-4")),
    ],
    time: Date(timeIntervalSince1970: 42)
  )
  let sourceA = NativeAssistantMarkdownSourceKey(
    messageID: 42,
    sourceSlot: 0,
    source: "source-a"
  )
  let sourceB = NativeAssistantMarkdownSourceKey(
    messageID: 42,
    sourceSlot: 3,
    source: "source-b"
  )
  let mixedRows = NativeAssistantMarkdownRowProjection.rows(
    message: mixedMessage,
    sources: [sourceA, sourceB],
    blocksBySource: [
      sourceA: [.paragraph([.text("a0")]), .paragraph([.text("a1")])],
      sourceB: [.paragraph([.text("b0")])],
    ]
  )
  let mixedOrder = mixedRows.map { row -> String in
    switch row {
    case .pending(let source): return "pending-\(source.sourceSlot)"
    case .markdown(let block): return "markdown-\(block.source.sourceSlot)-\(block.blockIndex)"
    case .companion(_, let index, let block):
      let kind = switch block {
      case .text: "text"
      case .reasoning: "reasoning"
      case .image: "image"
      case .unknown: "unknown"
      }
      return "companion-\(index)-\(kind)"
    }
  }
  check(
    mixedOrder == [
      "markdown-0-0", "markdown-0-1", "companion-1-image",
      "companion-2-reasoning", "markdown-3-0", "companion-4-unknown",
    ]
      && Set(mixedRows.map(\.id)).count == mixedRows.count,
    "outer Markdown row projection preserves mixed block order and stable unique identities"
  )
  let pendingRows = NativeAssistantMarkdownRowProjection.rows(
    message: mixedMessage,
    sources: [sourceA, sourceB],
    blocksBySource: [sourceA: [.paragraph([.text("a0")])]]
  )
  check(
    pendingRows.contains {
      if case .pending(let source) = $0 { return source == sourceB }
      return false
    },
    "outer Markdown row projection exposes one non-truncating pending row until a complete source installs"
  )
  let hugeSource = NativeAssistantMarkdownSourceKey(
    messageID: 99,
    sourceSlot: 0,
    source: largeFinalFixture
  )
  let hugeMessage = ArkMessage(
    id: 99,
    role: .assistant,
    text: largeFinalFixture,
    time: Date(timeIntervalSince1970: 99)
  )
  let hugeRows = NativeAssistantMarkdownRowProjection.rows(
    message: hugeMessage,
    sources: [hugeSource],
    blocksBySource: [hugeSource: largeFinalBlocks]
  )
  let changedSource = NativeAssistantMarkdownSourceKey(
    messageID: 99,
    sourceSlot: 0,
    source: largeFinalFixture + " changed"
  )
  let changedRows = NativeAssistantMarkdownRowProjection.rows(
    message: hugeMessage,
    sources: [changedSource],
    blocksBySource: [changedSource: largeFinalBlocks]
  )
  check(
    hugeRows.count == 2_048
      && Set(hugeRows.map(\.id)).count == 2_048
      && hugeRows.first?.id != changedRows.first?.id,
    "outer Markdown row projection keeps 2048 blocks and invalidates identity when exact source changes"
  )
  runLargeFinalMarkdownHostingProbeProcess()

  let protectedInline = NativeGFMParser.parse(
    #"标记 ARKNATIVEINLINEMATH；代码 `\(literal\)`；转义 \\(literal\\)；公式 \(\alpha + 1\)。"#
  )
  check(
    protectedInline.contains { block in
      guard case .paragraph(let content) = block else { return false }
      let codeIsLiteral = containsInline(content) {
        if case .code(#"\(literal\)"#) = $0 { return true }
        return false
      }
      let escapedIsNotMath = !containsInline(content) {
        if case .math(let source) = $0 { return source.contains("literal") }
        return false
      }
      let authoredMath = containsInline(content) {
        if case .math(#"\alpha + 1"#) = $0 { return true }
        return false
      }
      return codeIsLiteral && escapedIsNotMath && authoredMath
    },
    "native Markdown protects authored inline math without interpreting code or escaped delimiters"
  )

  let packageURL = contractNativeRoot.appendingPathComponent("Package.swift")
  let modelURL = contractNativeRoot.appendingPathComponent(
    "Sources/JiuzhangShellUI/NativeMarkdownGFMModel.swift"
  )
  let viewURL = contractNativeRoot.appendingPathComponent(
    "Sources/JiuzhangShellUI/NativeMarkdownGFMView.swift"
  )
  let wrapperURL = contractNativeRoot.appendingPathComponent(
    "Sources/JiuzhangShellUI/NativeMarkdownView.swift"
  )
  let rootURL = contractNativeRoot.appendingPathComponent(
    "Sources/JiuzhangShellUI/ArkRootView.swift"
  )
  let toolsURL = contractNativeRoot.appendingPathComponent(
    "Sources/JiuzhangShellUI/NativeToolPresentationView.swift"
  )
  let buildURL = contractNativeRoot.appendingPathComponent("build-app.sh")
  guard
    let package = try? String(contentsOf: packageURL, encoding: .utf8),
    let model = try? String(contentsOf: modelURL, encoding: .utf8),
    let view = try? String(contentsOf: viewURL, encoding: .utf8),
    let wrapper = try? String(contentsOf: wrapperURL, encoding: .utf8),
    let root = try? String(contentsOf: rootURL, encoding: .utf8),
    let tools = try? String(contentsOf: toolsURL, encoding: .utf8),
    let build = try? String(contentsOf: buildURL, encoding: .utf8)
  else {
    check(false, "native Markdown sources are readable")
    return
  }
  let documentView = markdownSourceSlice(
    view,
    from: "struct NativeGFMDocumentView: View",
    through: "struct NativeGFMBlockView"
  )
  let blockView = markdownSourceSlice(
    view,
    from: "struct NativeGFMBlockView",
    through: "private struct NativeGFMListView"
  )
  let tableView = markdownSourceSlice(
    view,
    from: "private struct NativeGFMTableView",
    through: "private struct NativeGFMMathBlock"
  )
  let tableRoute = blockView.flatMap {
    markdownSourceSlice($0, from: "case .table", through: "case .math")
  }
  check(
    markdownContainsStackInvocation("  VStack\n  (alignment: .leading)", named: "VStack")
      && markdownContainsStackInvocation("\tLazyVStack (alignment: .leading)", named: "LazyVStack")
      && !markdownContainsStackInvocation("// LazyVStack(alignment: .leading)", named: "LazyVStack")
      && !markdownContainsStackInvocation("let marker = \"LazyVStack(\"", named: "LazyVStack")
      && !markdownContainsStackInvocation("LazyVStack(alignment: .leading)", named: "VStack"),
    "native Markdown stack contract recognizes whitespace variants without matching comments, strings, or identifier suffixes"
  )
  check(
    package.contains("swift-markdown.git\", exact: \"0.7.3\"")
      && package.contains("SwiftMath.git\", exact: \"1.7.3\"")
      && package.contains(".product(name: \"Markdown\", package: \"swift-markdown\")")
      && package.contains(".product(name: \"SwiftMath\", package: \"SwiftMath\")"),
    "native Markdown pins the GFM parser and AppKit math renderer without raising the macOS 13 baseline"
  )
  check(
    model.contains("Document(parsing: preprocessed.body)")
      && model.contains("case footnoteReference")
      && model.contains("case table(")
      && model.contains("case math(String)")
      && model.contains("final class NativeGFMDocumentModel: ObservableObject")
      && model.contains("actor NativeGFMParseWorker")
      && model.contains("NativeGFMParseWorker.shared.blocks(for: source)")
      && model.contains("guard !Task.isCancelled else { return nil }")
      && model.contains("deinit {\n    parseTask?.cancel()\n  }")
      && model.contains("Task.detached(priority: .userInitiated)") == false
      && model.contains("NativeGFMCache.shared.blocks(for: source)"),
    "native Markdown owns typed GFM semantics and serializes cancellable cache-miss parsing away from the AppKit main thread"
  )
  check(
    view.contains("import SwiftMath")
      && view.contains("@StateObject private var model: NativeGFMDocumentModel")
      && documentView?.contains("Text(firstFrameText)") == true
      && documentView?.contains("ArkStreamingPresentationPolicy.firstFrameText(text)") == true
      && documentView?.contains("let blocks = model.blocks") == true
      && markdownContainsStackInvocation(documentView, named: "VStack")
      && !markdownContainsStackInvocation(documentView, named: "LazyVStack")
      && documentView?.contains("ForEach(blocks.indices, id: \\.self)") == true
      && documentView?.contains("Array(model.blocks.enumerated())") == false
      && documentView?.contains(".onChange(of: text) { model.update(source: $0) }") == true
      && !view.contains("private var blocks: [NativeGFMBlock]")
      && view.contains("MTMathUILabel")
      && view.contains("struct RenderInputs: Equatable")
      && view.contains("guard coordinator.claimRender(inputs) else { return }")
      && view.contains("renderIfNeeded(view, coordinator: context.coordinator)")
      && view.contains("NativeCodeSyntax.spans(")
      && view.contains("case .unifiedDiff") == false
      && !view.contains("WKWebView")
      && !view.contains("HTMLString")
      && !view.contains("WebView")
      && !view.contains("AsyncImage(")
      && view.contains("Link(destination: url)"),
    "native Markdown bounds its first frame while one non-lazy document stack receives cached AppKit math and syntax views"
  )
  check(
    view.contains("private struct NativeGFMRemoteImage")
      && view.contains("[\"http\", \"https\"].contains")
      && view.contains("url.host ?? url.absoluteString")
      && !view.contains("AsyncImage(url: url)"),
    "model Markdown never fetches remote images automatically and exposes only a user-invoked native link"
  )
  check(
    model.contains("transaction.disablesAnimations = true")
      && model.contains("withTransaction(transaction)")
      && markdownContainsStackInvocation(documentView, named: "VStack")
      && !markdownContainsStackInvocation(documentView, named: "LazyVStack")
      && root.contains("LazyVStack(alignment: .leading, spacing: ChatLayoutMetrics.entrySpacing)")
      && documentView?.contains("Array(model.blocks.enumerated())") == false,
    "native Markdown keeps one transcript lazy owner and installs complete parsed message blocks without nested lazy placement"
  )
  check(
    wrapper.contains("baseFontSize: CGFloat = 14")
      && blockView?.contains("case .paragraph(let content):\n      inline(content, size: baseFontSize)") == true
      && tableRoute?.contains("fontSize: max(12, baseFontSize - 2)") == true
      && tableView?.contains("NativeGFMInlineRenderer.text(\n      value,\n      fontSize: fontSize") == true
      && tableView?.contains("VStack(alignment: .leading, spacing: 0)") == true
      && tableView?.contains("HStack(alignment: .top, spacing: 0)") == true
      && tableView?.contains("min(300, max(120, fontSize * 12))") == true
      && tableView?.contains(".frame(width: cellWidth") == true
      && tableView?.contains("Grid(") == false
      && tableView?.contains("GridRow") == false
      && tableView?.contains(".accessibilityElement(children: .combine)") == true
      && tableView?.contains("ArkGFMTableAccessibility.label(") == true
      && tableView?.contains("ArkGFMTableAccessibility.identifier(") == true
      && tableView?.contains("tableID: tableID") == true
      && tableView?.contains("ark.markdown.table.\\(tableID)") == true
      && view.contains("attributed.link = url")
      && root.contains("baseFontSize: fontSize"),
    "native Markdown keeps readable text and uses font-scaled fixed table columns without cross-row Grid alignment feedback"
  )
  check(
    wrapper.contains("@State private var accessibilityDocumentID = UUID().uuidString")
      && wrapper.contains("documentID: accessibilityDocumentID")
      && documentView?.contains("path: \"doc.\\(documentID).root.\\(index)\"") == true
      && !wrapper.contains("NativeMarkdownParser")
      && !wrapper.contains("case math(String)"),
    "all native Markdown calls route through the one GFM renderer with no legacy subset parser"
  )
  check(
    root.components(separatedBy: "NativeMarkdownDocument(").count > 4
      && tools.contains("NativeMarkdownDocument(text: answer)"),
    "native Chat, context, compaction, and typed web-result surfaces share the GFM renderer"
  )
  check(
    build.contains("arkSwiftMathBundle()")
      && build.contains("Bundle.main.resourceURL")
      && build.contains("Bundle.main.bundleURL.appendingPathComponent(bundleName)")
      && build.contains("Swift.fatalError(\"could not load SwiftMath resource bundle\")")
      && build.contains("value.endswith(b\"SwiftMath_SwiftMath.bundle\")")
      && build.contains("release binary retains an absolute SwiftMath resource fallback")
      && build.contains("/usr/bin/strip -S -x")
      && build.contains("release binary retains build-machine path after stripping")
      && build.contains("chmod u+w")
      && build.contains("if mt_source.count(old_bundle) != 1")
      && build.contains("if math_source.count(old_lookup) != 2")
      && build.contains("--adapt-swiftmath-checkout")
      && build.contains("-name 'SwiftMath_SwiftMath.bundle'")
      && build.contains("\"${app_path}/Contents/Resources/SwiftMath_SwiftMath.bundle\"")
      && build.contains("SwiftMath resource bundle is unavailable after the release build"),
    "candidate packaging adapts the pinned dependency to the sealed Resources path and fails closed on upstream drift"
  )
}

private func containsInline(
  _ values: [NativeGFMInline],
  matching predicate: (NativeGFMInline) -> Bool
) -> Bool {
  for value in values {
    if predicate(value) { return true }
    switch value {
    case .emphasis(let children), .strong(let children), .strikethrough(let children):
      if containsInline(children, matching: predicate) { return true }
    case .link(_, _, let children):
      if containsInline(children, matching: predicate) { return true }
    default:
      break
    }
  }
  return false
}

private func markdownSourceSlice(
  _ source: String,
  from start: String,
  through end: String
) -> String? {
  guard
    let startRange = source.range(of: start),
    let endRange = source.range(
      of: end,
      range: startRange.upperBound..<source.endIndex
    )
  else { return nil }
  return String(source[startRange.lowerBound..<endRange.upperBound])
}

private func markdownContainsStackInvocation(
  _ source: String?,
  named name: String
) -> Bool {
  guard let source else { return false }
  let escapedName = NSRegularExpression.escapedPattern(for: name)
  let pattern = "(?m)^[\\t ]*\\b\(escapedName)\\b[\\t \\r\\n]*\\("
  return source.range(of: pattern, options: .regularExpression) != nil
}

@MainActor
private func runLargeFinalMarkdownHostingProbe() {
  let environment = ProcessInfo.processInfo.environment
  let blockCount = max(2, Int(environment["ARK_MARKDOWN_PROBE_BLOCKS"] ?? "") ?? 2_048)
  let documentID = "r16-large-final"
  let firstTable = """
  | marker | value |
  | --- | --- |
  | first | Final rendered block 0 |
  """
  let lastTable = """
  | marker | value |
  | --- | --- |
  | last | Final rendered block \(blockCount - 1) |
  """
  let middle = (1..<(blockCount - 1)).map {
    "Final rendered block \($0) preserves **complete** native Markdown."
  }
  let fixture = ([firstTable] + middle + [lastTable]).joined(separator: "\n\n")
  let parsed = NativeGFMCache.shared.blocks(for: fixture)
  guard parsed.count == blockCount else {
    check(false, "native Markdown hosting probe receives every configured parsed block")
    return
  }

  let beforeResident = markdownResidentBytes()
  let started = CFAbsoluteTimeGetCurrent()
  let hosting = NSHostingView(rootView:
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 18) {
        Section {
          ForEach(parsed.indices, id: \.self) { index in
            NativeGFMBlockView(
              block: parsed[index],
              baseFontSize: 14,
              path: "doc.\(documentID).root.\(index)"
            )
            .frame(width: 680, alignment: .leading)
          }
        }
      }
      .padding(20)
    }
    .frame(width: 720, height: 900)
  )
  hosting.frame = NSRect(x: 0, y: 0, width: 720, height: 900)
  let window = NSWindow(
    contentRect: NSRect(x: -20_000, y: -20_000, width: 720, height: 900),
    styleMask: [.borderless],
    backing: .buffered,
    defer: false
  )
  window.contentView = hosting
  window.orderBack(nil)
  defer {
    window.contentView = nil
    window.close()
  }

  hosting.layoutSubtreeIfNeeded()
  guard let scrollView = markdownScrollView(in: hosting),
        let documentView = scrollView.documentView
  else {
    check(false, "native Markdown hosting probe exposes one outer transcript-like scroll view")
    return
  }
  let scrollCoordinator = ArkChatScrollCoordinator(
    scrollView: scrollView,
    followThreshold: 24
  )
  defer { scrollCoordinator.invalidate() }
  scrollCoordinator.activate(sessionID: "r17-render-probe")
  let minimumDocumentHeight = blockCount >= 256
    ? max(1_000, CGFloat(blockCount) * 10)
    : 1
  let fullDocumentReady = markdownWaitUntil(timeout: 8) {
    hosting.layoutSubtreeIfNeeded()
    return documentView.bounds.height > minimumDocumentHeight
  }
  guard fullDocumentReady else {
    check(false, "native Markdown hosting probe installs the complete cached 2048-block document")
    return
  }
  let contentHeight = documentView.bounds.height
  let viewportHeight = scrollView.documentVisibleRect.height
  let bottomY = documentView.isFlipped
    ? max(documentView.bounds.maxY - viewportHeight, documentView.bounds.minY)
    : documentView.bounds.minY
  scrollView.contentView.scroll(to: NSPoint(x: scrollView.contentView.bounds.minX, y: bottomY))
  scrollView.reflectScrolledClipView(scrollView.contentView)
  hosting.layoutSubtreeIfNeeded()
  let settledHeight = documentView.bounds.height
  var maximumRelayoutSeconds = 0.0
  for _ in 0..<3 {
    let relayoutStart = CFAbsoluteTimeGetCurrent()
    hosting.layoutSubtreeIfNeeded()
    maximumRelayoutSeconds = max(
      maximumRelayoutSeconds,
      CFAbsoluteTimeGetCurrent() - relayoutStart
    )
  }
  let elapsedSeconds = CFAbsoluteTimeGetCurrent() - started
  let afterResident = markdownResidentBytes()
  let residentDelta = beforeResident.flatMap { before in
    afterResident.map { after in after > before ? after - before : 0 }
  }
  let boundedResident = residentDelta.map { $0 <= 384 * 1_024 * 1_024 } ?? false
  let finalHeight = documentView.bounds.height
  scrollCoordinator.contentDidChange()
  hosting.layoutSubtreeIfNeeded()
  let finalVisibleRect = scrollView.documentVisibleRect
  let bottomError = documentView.isFlipped
    ? documentView.bounds.maxY - finalVisibleRect.maxY
    : finalVisibleRect.minY - documentView.bounds.minY
  let stableHeight = settledHeight.isFinite
    && settledHeight > viewportHeight
    && abs(finalHeight - settledHeight) <= 0.5

  check(
    abs(bottomError) <= 0.5,
    "native Markdown final reflow keeps the physical viewport clamped to the real bottom"
  )
  check(
    elapsedSeconds <= 12
      && maximumRelayoutSeconds <= 0.25
      && stableHeight
      && boundedResident,
    "native Markdown lays out a 2048-block final answer with bounded time, stable height, and RSS"
  )
  let elapsedLabel = String(format: "%.3f", elapsedSeconds)
  let relayoutLabel = String(format: "%.4f", maximumRelayoutSeconds)
  let bottomErrorLabel = String(format: "%.3f", bottomError)
  print(
    "R17 Markdown hosting probe: blocks=\(blockCount) ax=deferred-live elapsed=\(elapsedLabel)s "
      + "relayout=\(relayoutLabel)s heightTop=\(Int(contentHeight.rounded())) "
      + "heightFinal=\(Int(finalHeight.rounded())) "
      + "bottomError=\(bottomErrorLabel) "
      + "rssDelta=\(residentDelta ?? UInt64.max)"
  )
}

private func markdownProbeApplications(
  bundleIdentifier: String,
  appURL: URL
) -> [NSRunningApplication] {
  let expectedURL = appURL.standardizedFileURL
  return NSRunningApplication.runningApplications(withBundleIdentifier: bundleIdentifier)
    .filter { !$0.isTerminated && $0.bundleURL?.standardizedFileURL == expectedURL }
}

private func markdownWaitForProbeExit(
  bundleIdentifier: String,
  appURL: URL,
  timeout: TimeInterval
) -> Bool {
  let deadline = Date(timeIntervalSinceNow: timeout)
  repeat {
    if markdownProbeApplications(
      bundleIdentifier: bundleIdentifier,
      appURL: appURL
    ).isEmpty { return true }
    Thread.sleep(forTimeInterval: 0.05)
  } while Date() < deadline
  return markdownProbeApplications(
    bundleIdentifier: bundleIdentifier,
    appURL: appURL
  ).isEmpty
}

private func terminateMarkdownProbeApplication(
  bundleIdentifier: String,
  appURL: URL
) -> Bool {
  let running = markdownProbeApplications(
    bundleIdentifier: bundleIdentifier,
    appURL: appURL
  )
  guard !running.isEmpty else { return true }
  for application in running { _ = application.terminate() }
  if markdownWaitForProbeExit(
    bundleIdentifier: bundleIdentifier,
    appURL: appURL,
    timeout: 1
  ) { return true }
  for application in markdownProbeApplications(
    bundleIdentifier: bundleIdentifier,
    appURL: appURL
  ) { _ = application.forceTerminate() }
  return markdownWaitForProbeExit(
    bundleIdentifier: bundleIdentifier,
    appURL: appURL,
    timeout: 2
  )
}

private func runLargeFinalMarkdownHostingProbeProcess() {
  let fileManager = FileManager.default
  let bundleIdentifier = "cn.jiuzhangtianmu.ark.markdown-render-probe"
  let app = fileManager.temporaryDirectory
    .appendingPathComponent("ark-markdown-probe-\(UUID().uuidString).app", isDirectory: true)
  let contents = app.appendingPathComponent("Contents", isDirectory: true)
  let macOS = contents.appendingPathComponent("MacOS", isDirectory: true)
  let executable = macOS.appendingPathComponent("ArkMarkdownRenderProbe")
  let standardOutput = contents.appendingPathComponent("probe-stdout.txt")
  let standardError = contents.appendingPathComponent("probe-stderr.txt")
  let resultURL = contents.appendingPathComponent("probe-result.json")
  var keepFailedApp = false
  var probeLaunched = false
  defer {
    if probeLaunched && !terminateMarkdownProbeApplication(
      bundleIdentifier: bundleIdentifier,
      appURL: app
    ) {
      keepFailedApp = true
      check(false, "native Markdown probe leaves no exact hidden child process")
    }
    if !keepFailedApp { try? fileManager.removeItem(at: app) }
  }
  do {
    try fileManager.createDirectory(at: macOS, withIntermediateDirectories: true)
    try fileManager.copyItem(
      at: URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL,
      to: executable
    )
    try fileManager.setAttributes(
      [.posixPermissions: NSNumber(value: 0o755)],
      ofItemAtPath: executable.path
    )
    let info: [String: Any] = [
      "CFBundleDevelopmentRegion": "en",
      "CFBundleExecutable": "ArkMarkdownRenderProbe",
      "CFBundleIdentifier": bundleIdentifier,
      "CFBundleInfoDictionaryVersion": "6.0",
      "CFBundleName": "Ark Markdown Render Probe",
      "CFBundlePackageType": "APPL",
      "CFBundleShortVersionString": "1.0",
      "CFBundleVersion": "1",
      "LSMinimumSystemVersion": "13.0",
      "LSUIElement": true,
      "NSPrincipalClass": "NSApplication",
    ]
    let infoData = try PropertyListSerialization.data(
      fromPropertyList: info,
      format: .xml,
      options: 0
    )
    try infoData.write(to: contents.appendingPathComponent("Info.plist"), options: .atomic)

    let signer = Process()
    signer.executableURL = URL(fileURLWithPath: "/usr/bin/codesign")
    signer.arguments = ["--force", "--sign", "-", "--timestamp=none", app.path]
    try signer.run()
    signer.waitUntilExit()
    guard signer.terminationStatus == 0 else {
      check(false, "native Markdown rendering probe App signs ad hoc")
      return
    }

    let launcher = Process()
    let completed = DispatchSemaphore(value: 0)
    launcher.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    launcher.arguments = [
      "-W", "-n", "-g",
      "--stdout", standardOutput.path,
      "--stderr", standardError.path,
      "--env", "ARK_MARKDOWN_RENDER_PROBE_CHILD=1",
      "--env", "ARK_MARKDOWN_PROBE_BLOCKS=2048",
      "--env", "ARK_MARKDOWN_PROBE_RESULT=\(resultURL.path)",
      app.path,
    ]
    launcher.terminationHandler = { _ in completed.signal() }
    try launcher.run()
    probeLaunched = true
    let timedOut = completed.wait(timeout: .now() + 30) == .timedOut
    let childExited: Bool
    if timedOut {
      childExited = terminateMarkdownProbeApplication(
        bundleIdentifier: bundleIdentifier,
        appURL: app
      )
      if launcher.isRunning { launcher.terminate() }
    } else {
      childExited = markdownWaitForProbeExit(
        bundleIdentifier: bundleIdentifier,
        appURL: app,
        timeout: 1
      )
    }
    launcher.waitUntilExit()
    let rendered = [standardOutput, standardError].compactMap {
      try? String(contentsOf: $0, encoding: .utf8)
    }.joined(separator: "\n")
    let result = (try? Data(contentsOf: resultURL)).flatMap {
      try? JSONSerialization.jsonObject(with: $0) as? [String: Any]
    }
    let childPassed = result?["status"] as? String == "pass"
    check(
      !timedOut
        && childExited
        && launcher.terminationReason == .exit
        && launcher.terminationStatus == 0
        && childPassed
        && rendered.contains("R17 Markdown hosting probe: blocks=2048 ax=deferred-live"),
      "native Markdown 2048-block rendering and bottom-scroll probe passes in a real AppKit application loop"
    )
    if let metrics = rendered.split(separator: "\n").first(where: {
      $0.hasPrefix("R17 Markdown hosting probe:")
    }) {
      print(metrics)
    }
    if timedOut || !childExited || !childPassed || launcher.terminationStatus != 0 {
      keepFailedApp = true
      print(rendered)
      print("R17 Markdown probe App retained: \(app.path)")
    }
  } catch {
    check(false, "native Markdown rendering probe child starts: \(error.localizedDescription)")
  }
}

@MainActor
func runArkMarkdownHostingProbeChild() -> Int32 {
  let application = NSApplication.shared
  application.setActivationPolicy(.prohibited)
  let delegate = ArkMarkdownHostingProbeDelegate(application: application)
  application.delegate = delegate
  application.run()
  application.delegate = nil
  return delegate.status
}

@MainActor
private final class ArkMarkdownHostingProbeDelegate: NSObject, NSApplicationDelegate {
  private let application: NSApplication
  private let initialFailureCount: Int
  private(set) var status: Int32 = 1

  init(application: NSApplication) {
    self.application = application
    initialFailureCount = failureCount
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    DispatchQueue.main.async { [self] in
      runLargeFinalMarkdownHostingProbe()
      status = failureCount == initialFailureCount ? 0 : 1
      if let resultPath = ProcessInfo.processInfo.environment["ARK_MARKDOWN_PROBE_RESULT"] {
        let result = ["status": status == 0 ? "pass" : "fail"]
        if let data = try? JSONSerialization.data(withJSONObject: result) {
          try? data.write(to: URL(fileURLWithPath: resultPath), options: .atomic)
        }
      }
      application.terminate(nil)
    }
  }
}

@MainActor
private func markdownWaitUntil(
  timeout: TimeInterval,
  condition: () -> Bool
) -> Bool {
  let deadline = Date(timeIntervalSinceNow: timeout)
  while Date() < deadline {
    if condition() { return true }
    _ = RunLoop.main.run(mode: .default, before: Date(timeIntervalSinceNow: 0.01))
  }
  return condition()
}

@MainActor
private func markdownScrollView(in view: NSView) -> NSScrollView? {
  if let scroll = view as? NSScrollView { return scroll }
  for child in view.subviews {
    if let scroll = markdownScrollView(in: child) { return scroll }
  }
  return nil
}

private func markdownResidentBytes() -> UInt64? {
  var info = mach_task_basic_info()
  var count = mach_msg_type_number_t(
    MemoryLayout<mach_task_basic_info>.size / MemoryLayout<natural_t>.size
  )
  let result = withUnsafeMutablePointer(to: &info) { pointer in
    pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { rebound in
      task_info(
        mach_task_self_,
        task_flavor_t(MACH_TASK_BASIC_INFO),
        rebound,
        &count
      )
    }
  }
  guard result == KERN_SUCCESS else { return nil }
  return UInt64(info.resident_size)
}

private func containsLiteral(_ blocks: [NativeGFMBlock], _ text: String) -> Bool {
  for block in blocks {
    switch block {
    case .heading(_, let values), .paragraph(let values):
      if containsInline(values, matching: {
        if case .text(let value) = $0 { return value.contains(text) }
        if case .literal(let value) = $0 { return value.contains(text) }
        return false
      }) { return true }
    case .quote(let children):
      if containsLiteral(children, text) { return true }
    case .list(_, _, let items):
      if items.contains(where: { containsLiteral($0.blocks, text) }) { return true }
    case .footnotes(let notes):
      if notes.contains(where: { containsLiteral($0.blocks, text) }) { return true }
    case .literal(let value), .code(_, let value), .math(let value):
      if value.contains(text) { return true }
    case .image(_, let alt):
      if alt.contains(text) { return true }
    case .table(_, let headers, let rows):
      if headers.flatMap({ $0 }).contains(where: { inline in
        if case .text(let value) = inline { return value.contains(text) }
        return false
      }) { return true }
      if rows.flatMap({ $0 }).flatMap({ $0 }).contains(where: { inline in
        if case .text(let value) = inline { return value.contains(text) }
        return false
      }) { return true }
    case .rule:
      break
    }
  }
  return false
}
