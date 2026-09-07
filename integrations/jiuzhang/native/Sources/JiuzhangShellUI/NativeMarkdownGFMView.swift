import AppKit
import SwiftMath
import SwiftUI

private struct NativeProducedFilePathsKey: EnvironmentKey {
  static let defaultValue: [String] = []
}

extension EnvironmentValues {
  var nativeProducedFilePaths: [String] {
    get { self[NativeProducedFilePathsKey.self] }
    set { self[NativeProducedFilePathsKey.self] = newValue }
  }
}

struct NativeGFMDocumentView: View {
  let text: String
  let baseFontSize: CGFloat
  let documentID: String
  @StateObject private var model: NativeGFMDocumentModel

  init(text: String, baseFontSize: CGFloat, documentID: String) {
    self.text = text
    self.baseFontSize = baseFontSize
    self.documentID = documentID
    _model = StateObject(wrappedValue: NativeGFMDocumentModel(source: text))
  }

  var body: some View {
    Group {
      if model.source == text, !model.blocks.isEmpty {
        let blocks = model.blocks
        // The transcript already owns vertical virtualization. A second
        // vertical LazyVStack here creates nested lazy placement engines; after
        // appending a turn to a long transcript, SwiftUI can keep negotiating
        // their document heights even after the durable turn has ended. Keep
        // one vertical lazy owner and render one message's parsed blocks as an
        // ordinary stack. Streaming text remains bounded before this point.
        VStack(alignment: .leading, spacing: 10) {
          ForEach(blocks.indices, id: \.self) { index in
            NativeGFMBlockView(
              block: blocks[index],
              baseFontSize: baseFontSize,
              path: "doc.\(documentID).root.\(index)"
            )
          }
        }
      } else {
        // A cache hit still completes on the next actor turn. Never hand an
        // entire very large transcript message to CoreText for that temporary
        // first frame: doing so can monopolize the main thread before the
        // parsed lazy blocks are installed.
        Text(firstFrameText)
          .font(.system(size: baseFontSize))
          .lineSpacing(4)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .onChange(of: text) { model.update(source: $0) }
  }

  private var firstFrameText: String {
    ArkStreamingPresentationPolicy.firstFrameText(text)
  }
}

struct NativeGFMBlockView: View {
  let block: NativeGFMBlock
  let baseFontSize: CGFloat
  let path: String
  @Environment(\.colorScheme) private var colorScheme
  @Environment(\.nativeProducedFilePaths) private var producedFilePaths

  @ViewBuilder
  var body: some View {
    switch block {
    case .heading(let level, let content):
      inline(content, size: max(baseFontSize + 1, baseFontSize + 9 - CGFloat(level) * 1.7))
        .fontWeight(level <= 2 ? .semibold : .medium)
        .padding(.top, level <= 2 ? 5 : 2)
    case .paragraph(let content):
      inline(content, size: baseFontSize)
        .lineSpacing(4)
    case .image(let source, let alt):
      NativeGFMRemoteImage(source: source, alt: alt)
    case .quote(let blocks):
      HStack(alignment: .top, spacing: 9) {
        Rectangle().fill(Color.secondary.opacity(0.55)).frame(width: 3)
        VStack(alignment: .leading, spacing: 8) {
          ForEach(Array(blocks.enumerated()), id: \.offset) { index, child in
            NativeGFMBlockView(
              block: child,
              baseFontSize: max(12, baseFontSize - 1),
              path: "\(path).quote.\(index)"
            )
          }
        }
        .foregroundStyle(Color.secondary)
      }
    case .list(let ordered, let start, let items):
      NativeGFMListView(
        ordered: ordered,
        start: start,
        items: items,
        baseFontSize: baseFontSize,
        path: "\(path).list"
      )
    case .code(let language, let source):
      NativeGFMCodeBlock(
        language: language,
        source: source,
        fontSize: max(12, baseFontSize - 2)
      )
    case .table(let alignments, let headers, let rows):
      NativeGFMTableView(
        alignments: alignments,
        headers: headers,
        rows: rows,
        fontSize: max(12, baseFontSize - 2),
        tableID: path
      )
    case .math(let source):
      NativeGFMMathBlock(source: source, fontSize: max(16, baseFontSize + 2))
    case .footnotes(let footnotes):
      NativeGFMFootnotesView(
        footnotes: footnotes,
        baseFontSize: baseFontSize,
        path: "\(path).footnotes"
      )
    case .literal(let source):
      Text(source)
        .font(.system(size: max(12, baseFontSize - 1), design: .monospaced))
        .foregroundStyle(Color.secondary)
    case .rule:
      Divider().overlay(Color(nsColor: .separatorColor))
    }
  }

  private func inline(_ values: [NativeGFMInline], size: CGFloat) -> Text {
    NativeGFMInlineRenderer.text(
      values,
      fontSize: size,
      colorScheme: colorScheme,
      producedFilePaths: producedFilePaths
    )
  }
}

private struct NativeGFMListView: View {
  let ordered: Bool
  let start: Int
  let items: [NativeGFMListItem]
  let baseFontSize: CGFloat
  let path: String

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      ForEach(Array(items.enumerated()), id: \.offset) { index, item in
        HStack(alignment: .top, spacing: 8) {
          marker(item, index: index)
            .frame(width: 24, alignment: .trailing)
          VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(item.blocks.enumerated()), id: \.offset) { blockIndex, block in
              NativeGFMBlockView(
                block: block,
                baseFontSize: baseFontSize,
                path: "\(path).item.\(index).block.\(blockIndex)"
              )
            }
          }
          .frame(maxWidth: .infinity, alignment: .leading)
        }
      }
    }
  }

  @ViewBuilder
  private func marker(_ item: NativeGFMListItem, index: Int) -> some View {
    if let checked = item.checkbox {
      Image(systemName: checked ? "checkmark.square.fill" : "square")
        .font(.system(size: max(11, baseFontSize - 1), weight: .medium))
        .foregroundStyle(checked ? Color.accentColor : Color.secondary)
        .accessibilityLabel(Text(LocalizedStringKey(checked ? "完成" : "未完成")))
    } else {
      Text(ordered ? "\(start + index)." : "•")
        .font(.system(size: baseFontSize))
        .foregroundStyle(Color.secondary)
    }
  }
}

private struct NativeGFMCodeBlock: View {
  let language: String?
  let source: String
  let fontSize: CGFloat
  @State private var copied = false
  @Environment(\.colorScheme) private var colorScheme

  var body: some View {
    VStack(spacing: 0) {
      HStack {
        Text(language?.isEmpty == false ? language! : "code")
          .font(.system(size: 10, weight: .medium, design: .monospaced))
          .foregroundStyle(Color.secondary)
        Spacer()
        Button {
          NSPasteboard.general.clearContents()
          NSPasteboard.general.setString(source, forType: .string)
          copied = true
          DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { copied = false }
        } label: {
          Text(LocalizedStringKey(copied ? "已复制" : "复制"))
        }
        .buttonStyle(.borderless)
        .font(.system(size: 10))
      }
      .padding(.horizontal, 10)
      .frame(height: 30)
      .background(Color(nsColor: .underPageBackgroundColor))
      Divider().overlay(Color(nsColor: .separatorColor))
      ScrollView(.horizontal) {
        Text(highlighted)
          .fixedSize(horizontal: true, vertical: false)
          .padding(11)
      }
    }
    .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 9))
    .overlay(RoundedRectangle(cornerRadius: 9).stroke(Color(nsColor: .separatorColor)))
  }

  private var highlighted: AttributedString {
    let font = NSFont.monospacedSystemFont(ofSize: fontSize, weight: .regular)
    let value = NSMutableAttributedString(
      string: source,
      attributes: [
        .font: font,
        .foregroundColor: resolved(.labelColor),
      ]
    )
    guard source.utf8.count <= NativeCodeSyntax.maximumHighlightedBytes else {
      return (try? AttributedString(value, including: \.appKit)) ?? AttributedString(source)
    }
    let presentation: NativeCodeEditorPresentation = normalizedLanguage == "diff"
      ? .unifiedDiff
      : .source
    for span in NativeCodeSyntax.spans(
      in: source,
      fileExtension: normalizedLanguage,
      presentation: presentation
    ) where NSMaxRange(span.range) <= value.length {
      value.addAttribute(.foregroundColor, value: resolved(span.kind.color), range: span.range)
      if let background = span.kind.backgroundColor {
        value.addAttribute(.backgroundColor, value: resolved(background), range: span.range)
      }
    }
    return (try? AttributedString(value, including: \.appKit)) ?? AttributedString(source)
  }

  private var normalizedLanguage: String {
    let raw = language?.split(whereSeparator: { $0.isWhitespace }).first.map(String.init) ?? ""
    switch raw.lowercased() {
    case "typescript", "ts", "tsx": return "ts"
    case "javascript", "js", "jsx": return "js"
    case "shellscript", "shell", "bash", "sh", "zsh": return "sh"
    case "jsonc": return "jsonc"
    case "yml": return "yml"
    case "markdown": return "md"
    case "python": return "py"
    case "rust": return "rs"
    case "c++": return "cpp"
    default: return raw.lowercased()
    }
  }

  private func resolved(_ color: NSColor) -> NSColor {
    let appearance = NSAppearance(named: colorScheme == .dark ? .darkAqua : .aqua)
    var result = color
    appearance?.performAsCurrentDrawingAppearance {
      result = color.usingColorSpace(.deviceRGB) ?? color
    }
    return result
  }
}

enum ArkGFMTableAccessibility {
  static func label(
    value: String,
    header: String,
    rowIndex: Int?,
    columnIndex: Int,
    isHeader: Bool
  ) -> String {
    if isHeader { return "\(columnIndex + 1): \(value)" }
    let position = "\((rowIndex ?? 0) + 1)-\(columnIndex + 1)"
    return header.isEmpty
      ? "\(position): \(value)"
      : "\(position): \(header): \(value)"
  }

  static func identifier(
    tableID: String,
    rowIndex: Int?,
    columnIndex: Int,
    isHeader: Bool
  ) -> String {
    isHeader
      ? "ark.markdown.table.\(tableID).header.\(columnIndex)"
      : "ark.markdown.table.\(tableID).cell.\(rowIndex ?? 0).\(columnIndex)"
  }
}

private struct NativeGFMTableView: View {
  let alignments: [NativeGFMTableAlignment]
  let headers: [[NativeGFMInline]]
  let rows: [[[NativeGFMInline]]]
  let fontSize: CGFloat
  let tableID: String
  @Environment(\.colorScheme) private var colorScheme
  @Environment(\.nativeProducedFilePaths) private var producedFilePaths

  var body: some View {
    ScrollView(.horizontal) {
      VStack(alignment: .leading, spacing: 0) {
        tableRow(headers, rowIndex: nil, header: true)
        if !rows.isEmpty { Divider() }
        ForEach(rows.indices, id: \.self) { rowIndex in
          tableRow(normalized(rows[rowIndex]), rowIndex: rowIndex, header: false)
          if rowIndex < rows.count - 1 { Divider() }
        }
      }
    }
    .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
    .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color(nsColor: .separatorColor)))
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("ark.markdown.table.\(tableID)")
  }

  private func normalized(_ row: [[NativeGFMInline]]) -> [[NativeGFMInline]] {
    if row.count >= headers.count { return Array(row.prefix(headers.count)) }
    return row + Array(repeating: [], count: headers.count - row.count)
  }

  private var cellWidth: CGFloat {
    min(300, max(120, fontSize * 12))
  }

  private func tableRow(
    _ values: [[NativeGFMInline]],
    rowIndex: Int?,
    header: Bool
  ) -> some View {
    HStack(alignment: .top, spacing: 0) {
      ForEach(values.indices, id: \.self) { index in
        cell(values[index], index: index, rowIndex: rowIndex, header: header)
      }
    }
    .accessibilityElement(children: .contain)
  }

  private func cell(
    _ value: [NativeGFMInline],
    index: Int,
    rowIndex: Int?,
    header: Bool
  ) -> some View {
    NativeGFMInlineRenderer.text(
      value,
      fontSize: fontSize,
      colorScheme: colorScheme,
      producedFilePaths: producedFilePaths
    )
      .fontWeight(header ? .semibold : .regular)
      .multilineTextAlignment(textAlignment(index))
      .padding(.horizontal, 10)
      .padding(.vertical, 7)
      .frame(width: cellWidth, alignment: frameAlignment(index))
      .background(header ? Color(nsColor: .underPageBackgroundColor) : Color.clear)
      .accessibilityElement(children: .combine)
      .accessibilityLabel(ArkGFMTableAccessibility.label(
        value: NativeGFMInlineRenderer.plainText(value),
        header: index < headers.count
          ? NativeGFMInlineRenderer.plainText(headers[index])
          : "",
        rowIndex: rowIndex,
        columnIndex: index,
        isHeader: header
      ))
      .accessibilityIdentifier(ArkGFMTableAccessibility.identifier(
        tableID: tableID,
        rowIndex: rowIndex,
        columnIndex: index,
        isHeader: header
      ))
  }

  private func textAlignment(_ index: Int) -> TextAlignment {
    guard index < alignments.count else { return .leading }
    switch alignments[index] {
    case .center: return .center
    case .right: return .trailing
    case .left, .unspecified: return .leading
    }
  }

  private func frameAlignment(_ index: Int) -> Alignment {
    guard index < alignments.count else { return .leading }
    switch alignments[index] {
    case .center: return .center
    case .right: return .trailing
    case .left, .unspecified: return .leading
    }
  }
}

private struct NativeGFMMathBlock: View {
  let source: String
  let fontSize: CGFloat
  @Environment(\.colorScheme) private var colorScheme

  var body: some View {
    ScrollView(.horizontal) {
      NativeGFMMathLabel(
        source: source,
        fontSize: fontSize,
        colorScheme: colorScheme
      )
      .fixedSize(horizontal: true, vertical: true)
      .padding(10)
    }
    .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
    .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color(nsColor: .separatorColor)))
    .accessibilityLabel(source)
  }
}

struct NativeGFMMathLabel: NSViewRepresentable {
  let source: String
  let fontSize: CGFloat
  let colorScheme: ColorScheme

  final class Coordinator {
    struct RenderInputs: Equatable {
      let source: String
      let fontSize: CGFloat
      let dark: Bool
    }

    private var renderedInputs: RenderInputs?

    func claimRender(_ inputs: RenderInputs) -> Bool {
      guard renderedInputs != inputs else { return false }
      renderedInputs = inputs
      return true
    }
  }

  func makeCoordinator() -> Coordinator { Coordinator() }

  func makeNSView(context: Context) -> MTMathUILabel {
    let view = MTMathUILabel()
    view.textAlignment = .left
    view.labelMode = .display
    view.contentInsets = MTEdgeInsets(top: 2, left: 2, bottom: 2, right: 2)
    renderIfNeeded(view, coordinator: context.coordinator)
    return view
  }

  func updateNSView(_ view: MTMathUILabel, context: Context) {
    renderIfNeeded(view, coordinator: context.coordinator)
  }

  private func renderIfNeeded(_ view: MTMathUILabel, coordinator: Coordinator) {
    let inputs = Coordinator.RenderInputs(
      source: source,
      fontSize: fontSize,
      dark: colorScheme == .dark
    )
    guard coordinator.claimRender(inputs) else { return }
    view.latex = inputs.source
    view.fontSize = inputs.fontSize
    view.textColor = inputs.dark ? .white : .black
    view.invalidateIntrinsicContentSize()
  }

  func sizeThatFits(
    _ proposal: ProposedViewSize,
    nsView: MTMathUILabel,
    context: Context
  ) -> CGSize? {
    let size = nsView.fittingSize
    return CGSize(width: max(1, ceil(size.width)), height: max(fontSize * 1.5, ceil(size.height)))
  }
}

private struct NativeGFMFootnotesView: View {
  let footnotes: [NativeGFMFootnote]
  let baseFontSize: CGFloat
  let path: String

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Divider()
      ForEach(Array(footnotes.enumerated()), id: \.offset) { footnoteIndex, footnote in
        HStack(alignment: .top, spacing: 8) {
          Text("[\(footnote.number)]")
            .font(.system(size: max(10, baseFontSize - 2), weight: .semibold))
            .foregroundStyle(Color.accentColor)
            .frame(minWidth: 25, alignment: .trailing)
          VStack(alignment: .leading, spacing: 5) {
            ForEach(Array(footnote.blocks.enumerated()), id: \.offset) { blockIndex, block in
              NativeGFMBlockView(
                block: block,
                baseFontSize: max(11, baseFontSize - 1),
                path: "\(path).note.\(footnoteIndex).block.\(blockIndex)"
              )
            }
          }
        }
      }
    }
  }
}

private struct NativeGFMRemoteImage: View {
  let source: String?
  let alt: String

  var body: some View {
    if let url = safeRemoteURL {
      Link(destination: url) {
        VStack(alignment: .leading, spacing: 6) {
          Label(
            alt.isEmpty ? (url.host ?? url.absoluteString) : alt,
            systemImage: "photo"
          )
          .lineLimit(2)
          if let host = url.host, !host.isEmpty {
            Text(verbatim: host)
              .font(.system(size: 10))
              .foregroundStyle(Color.secondary)
          }
        }
        .padding(12)
        .frame(maxWidth: 620, minHeight: 72, alignment: .leading)
        .background(Color(nsColor: .controlBackgroundColor))
      }
      .buttonStyle(.plain)
      .clipShape(RoundedRectangle(cornerRadius: 9))
      .overlay(RoundedRectangle(cornerRadius: 9).stroke(Color(nsColor: .separatorColor)))
      .accessibilityLabel(alt.isEmpty ? Text(verbatim: url.absoluteString) : Text(verbatim: alt))
    } else {
      failure
    }
  }

  private var safeRemoteURL: URL? {
    guard let source, let url = URL(string: source),
          ["http", "https"].contains(url.scheme?.lowercased() ?? "")
    else { return nil }
    return url
  }

  @ViewBuilder
  private var failure: some View {
    if alt.isEmpty {
      Label("图片不可用", systemImage: "photo.badge.exclamationmark")
        .foregroundStyle(Color.secondary)
        .frame(height: 80)
    } else {
      Label(alt, systemImage: "photo.badge.exclamationmark")
        .foregroundStyle(Color.secondary)
        .frame(height: 80)
    }
  }
}

private struct NativeGFMInlineStyle: OptionSet {
  let rawValue: Int
  static let emphasis = NativeGFMInlineStyle(rawValue: 1 << 0)
  static let strong = NativeGFMInlineStyle(rawValue: 1 << 1)
  static let strikethrough = NativeGFMInlineStyle(rawValue: 1 << 2)
  static let code = NativeGFMInlineStyle(rawValue: 1 << 3)
}

private enum NativeGFMInlineRenderer {
  static func text(
    _ values: [NativeGFMInline],
    fontSize: CGFloat,
    colorScheme: ColorScheme,
    producedFilePaths: [String]
  ) -> Text {
    values.reduce(Text("")) { partial, value in
      partial + text(
        value,
        style: [],
        fontSize: fontSize,
        colorScheme: colorScheme,
        producedFilePaths: producedFilePaths
      )
    }
  }

  private static func text(
    _ value: NativeGFMInline,
    style: NativeGFMInlineStyle,
    fontSize: CGFloat,
    colorScheme: ColorScheme,
    producedFilePaths: [String]
  ) -> Text {
    switch value {
    case .text(let source), .literal(let source):
      return styled(source, style: style, fontSize: fontSize)
    case .softBreak:
      return Text(" ")
    case .lineBreak:
      return Text("\n")
    case .emphasis(let children):
      return nested(children, style: style.union(.emphasis), fontSize: fontSize, colorScheme: colorScheme, producedFilePaths: producedFilePaths)
    case .strong(let children):
      return nested(children, style: style.union(.strong), fontSize: fontSize, colorScheme: colorScheme, producedFilePaths: producedFilePaths)
    case .strikethrough(let children):
      return nested(children, style: style.union(.strikethrough), fontSize: fontSize, colorScheme: colorScheme, producedFilePaths: producedFilePaths)
    case .code(let source):
      if let url = safeURL(source), ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
        return linked(source, url: url, style: style.union(.code), fontSize: fontSize)
      }
      if let path = ArkProducedFilesProjection.resolveMention(source, paths: producedFilePaths),
         let url = ArkProducedFilesProjection.mentionURL(for: path) {
        return linked(source, url: url, style: style.union(.code), fontSize: fontSize)
      }
      return styled(source, style: style.union(.code), fontSize: fontSize)
    case .link(let destination, _, let children):
      guard let destination, let url = safeURL(destination) else {
        return nested(children, style: style, fontSize: fontSize, colorScheme: colorScheme, producedFilePaths: producedFilePaths)
      }
      let label = plainText(children)
      return linked(label, url: url, style: style, fontSize: fontSize)
    case .image(_, let alt):
      return styled(alt, style: style, fontSize: fontSize)
    case .math(let source):
      if let image = NativeGFMMathImageCache.shared.image(
        source: source,
        fontSize: fontSize,
        dark: colorScheme == .dark
      ) {
        return Text(Image(nsImage: image)).baselineOffset(-2)
      }
      return styled("\\(\(source)\\)", style: style.union(.code), fontSize: fontSize)
    case .footnoteReference(_, let number):
      return Text("[\(number)]")
        .font(.system(size: max(9, fontSize - 3), weight: .semibold))
        .foregroundColor(.accentColor)
        .baselineOffset(fontSize * 0.28)
    }
  }

  private static func nested(
    _ children: [NativeGFMInline],
    style: NativeGFMInlineStyle,
    fontSize: CGFloat,
    colorScheme: ColorScheme,
    producedFilePaths: [String]
  ) -> Text {
    children.reduce(Text("")) { partial, child in
      partial + text(
        child,
        style: style,
        fontSize: fontSize,
        colorScheme: colorScheme,
        producedFilePaths: producedFilePaths
      )
    }
  }

  private static func styled(
    _ source: String,
    style: NativeGFMInlineStyle,
    fontSize: CGFloat
  ) -> Text {
    var value = Text(source)
      .font(.system(size: fontSize, design: style.contains(.code) ? .monospaced : .default))
    if style.contains(.strong) { value = value.bold() }
    if style.contains(.emphasis) { value = value.italic() }
    if style.contains(.strikethrough) { value = value.strikethrough() }
    if style.contains(.code) { value = value.foregroundColor(.secondary) }
    return value
  }

  private static func linked(
    _ source: String,
    url: URL,
    style: NativeGFMInlineStyle,
    fontSize: CGFloat
  ) -> Text {
    var attributed = AttributedString(source)
    attributed.link = url
    var value = Text(attributed)
      .font(.system(size: fontSize, design: style.contains(.code) ? .monospaced : .default))
    if style.contains(.strong) { value = value.bold() }
    if style.contains(.emphasis) { value = value.italic() }
    if style.contains(.strikethrough) { value = value.strikethrough() }
    return value
  }

  private static func safeURL(_ source: String) -> URL? {
    guard let url = URL(string: source),
          ["http", "https", "mailto"].contains(url.scheme?.lowercased() ?? "")
    else { return nil }
    return url
  }

  static func plainText(_ values: [NativeGFMInline]) -> String {
    values.map { value in
      switch value {
      case .text(let source), .literal(let source), .code(let source), .math(let source):
        return source
      case .softBreak: return " "
      case .lineBreak: return "\n"
      case .emphasis(let children), .strong(let children), .strikethrough(let children):
        return plainText(children)
      case .link(_, _, let children): return plainText(children)
      case .image(_, let alt): return alt
      case .footnoteReference(_, let number): return "[\(number)]"
      }
    }.joined()
  }
}

private final class NativeGFMMathImageCache: @unchecked Sendable {
  static let shared = NativeGFMMathImageCache()
  private let cache = NSCache<NSString, NSImage>()

  func image(source: String, fontSize: CGFloat, dark: Bool) -> NSImage? {
    let key = "\(dark ? "d" : "l")|\(fontSize)|\(source)" as NSString
    if let cached = cache.object(forKey: key) { return cached }
    let renderer = MTMathImage(
      latex: source,
      fontSize: fontSize,
      textColor: dark ? .white : .black,
      labelMode: .text,
      textAlignment: .left
    )
    let (_, image) = renderer.asImage()
    if let image { cache.setObject(image, forKey: key) }
    return image
  }
}
