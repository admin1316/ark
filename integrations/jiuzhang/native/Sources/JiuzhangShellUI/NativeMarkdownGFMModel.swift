import Combine
import Foundation
import Markdown
import SwiftUI

indirect enum NativeGFMInline: Equatable, Sendable {
  case text(String)
  case softBreak
  case lineBreak
  case emphasis([NativeGFMInline])
  case strong([NativeGFMInline])
  case strikethrough([NativeGFMInline])
  case code(String)
  case link(destination: String?, title: String?, children: [NativeGFMInline])
  case image(source: String?, alt: String)
  case math(String)
  case footnoteReference(id: String, number: Int)
  case literal(String)
}

struct NativeGFMListItem: Equatable, Sendable {
  let checkbox: Bool?
  let blocks: [NativeGFMBlock]
}

enum NativeGFMTableAlignment: Equatable, Sendable {
  case left
  case center
  case right
  case unspecified
}

struct NativeGFMFootnote: Equatable, Sendable {
  let id: String
  let number: Int
  let blocks: [NativeGFMBlock]
}

indirect enum NativeGFMBlock: Equatable, Sendable {
  case heading(level: Int, content: [NativeGFMInline])
  case paragraph([NativeGFMInline])
  case image(source: String?, alt: String)
  case quote([NativeGFMBlock])
  case list(ordered: Bool, start: Int, items: [NativeGFMListItem])
  case code(language: String?, source: String)
  case table(
    alignments: [NativeGFMTableAlignment],
    headers: [[NativeGFMInline]],
    rows: [[[NativeGFMInline]]]
  )
  case math(String)
  case footnotes([NativeGFMFootnote])
  case literal(String)
  case rule
}

final class NativeGFMCache: @unchecked Sendable {
  static let shared = NativeGFMCache()

  private let lock = NSLock()
  private var values: [String: [NativeGFMBlock]] = [:]
  private var order: [String] = []

  func blocks(for source: String) -> [NativeGFMBlock] {
    lock.lock()
    if let cached = values[source] {
      lock.unlock()
      return cached
    }
    lock.unlock()

    let parsed = NativeGFMParser.parse(source)
    lock.lock()
    values[source] = parsed
    order.append(source)
    if order.count > 192 {
      for key in order.prefix(48) { values.removeValue(forKey: key) }
      order.removeFirst(48)
    }
    lock.unlock()
    return parsed
  }
}

/// Serializes native Markdown parsing across every surface. Cancelling a view
/// task cannot interrupt the parser's synchronous work, but actor isolation
/// guarantees there is never more than one parse consuming CPU; cancelled
/// requests waiting behind it exit before starting, leaving only the newest
/// requested source eligible for installation.
actor NativeGFMParseWorker {
  static let shared = NativeGFMParseWorker()

  func blocks(for source: String) -> [NativeGFMBlock]? {
    guard !Task.isCancelled else { return nil }
    let parsed = NativeGFMCache.shared.blocks(for: source)
    guard !Task.isCancelled else { return nil }
    return parsed
  }
}

/// Main-actor owner for one Markdown surface. Parsing is pure and cache-backed,
/// so it runs off-main; scrolling a large historical message into view never
/// blocks AppKit while Swift Markdown builds its syntax tree.
@MainActor
final class NativeGFMDocumentModel: ObservableObject {
  @Published private(set) var blocks: [NativeGFMBlock] = []
  private(set) var source: String
  private var generation: UInt64 = 0
  private var parseTask: Task<Void, Never>?

  init(source: String) {
    self.source = source
    schedule(source)
  }

  deinit {
    parseTask?.cancel()
  }

  func update(source: String) {
    guard self.source != source else { return }
    self.source = source
    blocks = []
    schedule(source)
  }

  private func schedule(_ source: String) {
    parseTask?.cancel()
    generation &+= 1
    let requestedGeneration = generation
    parseTask = Task { [weak self] in
      guard let parsed = await NativeGFMParseWorker.shared.blocks(for: source) else { return }
      guard let self,
            !Task.isCancelled,
            generation == requestedGeneration,
            self.source == source
      else { return }
      var transaction = Transaction(animation: nil)
      transaction.disablesAnimations = true
      withTransaction(transaction) {
        self.blocks = parsed
      }
    }
  }
}

enum NativeGFMParser {
  static func parse(_ source: String) -> [NativeGFMBlock] {
    let preprocessed = preprocess(source)
    var converter = Converter(
      footnoteDefinitions: preprocessed.footnotes,
      inlineMath: preprocessed.inlineMath,
      inlineMathTokenPrefix: preprocessed.inlineMathTokenPrefix
    )
    let document = Document(parsing: preprocessed.body)
    var blocks = converter.blocks(document.children)

    let footnotes = converter.footnoteOrder.compactMap { id -> NativeGFMFootnote? in
      guard let source = preprocessed.footnotes[id] else { return nil }
      var footnoteConverter = Converter(
        footnoteDefinitions: [:],
        inlineMath: preprocessed.inlineMath,
        inlineMathTokenPrefix: preprocessed.inlineMathTokenPrefix
      )
      let footnoteDocument = Document(parsing: source)
      return NativeGFMFootnote(
        id: id,
        number: converter.footnoteNumbers[id] ?? 0,
        blocks: footnoteConverter.blocks(footnoteDocument.children)
      )
    }
    if !footnotes.isEmpty { blocks.append(.footnotes(footnotes)) }
    return blocks
  }

  private struct Preprocessed {
    let body: String
    let footnotes: [String: String]
    let inlineMath: [String: String]
    let inlineMathTokenPrefix: String
  }

  /// Keeps TeX and footnote syntax out of the GFM block parser without
  /// interpreting either construct inside authored code fences.
  private static func preprocess(_ source: String) -> Preprocessed {
    let lines = source.replacingOccurrences(of: "\r\n", with: "\n")
      .split(separator: "\n", omittingEmptySubsequences: false)
      .map(String.init)
    var output: [String] = []
    var footnotes: [String: String] = [:]
    var inlineMath: [String: String] = [:]
    let inlineMathTokenPrefix = uniqueInlineMathTokenPrefix(in: source)
    var index = 0
    var fence: String?

    while index < lines.count {
      let line = lines[index]
      let trimmed = line.trimmingCharacters(in: .whitespaces)

      if let activeFence = fence {
        output.append(line)
        if trimmed.hasPrefix(activeFence) { fence = nil }
        index += 1
        continue
      }

      if let marker = fenceMarker(trimmed) {
        fence = marker
        output.append(line)
        index += 1
        continue
      }

      if let definition = footnoteDefinition(line) {
        var body = [definition.body]
        index += 1
        while index < lines.count {
          let continuation = lines[index]
          if continuation.hasPrefix("    ") {
            body.append(String(continuation.dropFirst(4)))
            index += 1
          } else if continuation.hasPrefix("\t") {
            body.append(String(continuation.dropFirst()))
            index += 1
          } else if continuation.trimmingCharacters(in: .whitespaces).isEmpty,
                    index + 1 < lines.count,
                    lines[index + 1].hasPrefix("    ")
          {
            body.append("")
            index += 1
          } else {
            break
          }
        }
        let key = definition.id.uppercased()
        if footnotes[key] == nil {
          footnotes[key] = replacingInlineMath(
            in: body.joined(separator: "\n"),
            tokenPrefix: inlineMathTokenPrefix,
            values: &inlineMath
          )
        }
        continue
      }

      if let math = singleLineMathBlock(trimmed) {
        appendMathFence(math, to: &output)
        index += 1
        continue
      }

      if trimmed == "$$" || trimmed == "\\[" {
        let terminator = trimmed == "$$" ? "$$" : "\\]"
        var math: [String] = []
        index += 1
        while index < lines.count,
              lines[index].trimmingCharacters(in: .whitespaces) != terminator
        {
          math.append(lines[index])
          index += 1
        }
        appendMathFence(math.joined(separator: "\n"), to: &output)
        if index < lines.count { index += 1 }
        continue
      }

      output.append(replacingInlineMath(
        in: line,
        tokenPrefix: inlineMathTokenPrefix,
        values: &inlineMath
      ))
      index += 1
    }
    return Preprocessed(
      body: output.joined(separator: "\n"),
      footnotes: footnotes,
      inlineMath: inlineMath,
      inlineMathTokenPrefix: inlineMathTokenPrefix
    )
  }

  private static let inlineMathTokenSuffix = "MATHEND"

  private static func uniqueInlineMathTokenPrefix(in source: String) -> String {
    var prefix = "ARKNATIVEINLINEMATH"
    while source.contains(prefix) { prefix.append("X") }
    return prefix
  }

  /// CommonMark consumes the backslashes in `\(...\)` before producing Text
  /// nodes. Protect authored inline TeX with a collision-free plain-text token
  /// while preserving fenced and inline code verbatim.
  private static func replacingInlineMath(
    in source: String,
    tokenPrefix: String,
    values: inout [String: String]
  ) -> String {
    var output = ""
    var index = source.startIndex
    var codeDelimiterLength: Int?

    while index < source.endIndex {
      if source[index] == "`" {
        var runEnd = source.index(after: index)
        while runEnd < source.endIndex, source[runEnd] == "`" {
          runEnd = source.index(after: runEnd)
        }
        let runLength = source.distance(from: index, to: runEnd)
        output.append(contentsOf: source[index..<runEnd])
        if codeDelimiterLength == runLength {
          codeDelimiterLength = nil
        } else if codeDelimiterLength == nil {
          codeDelimiterLength = runLength
        }
        index = runEnd
        continue
      }

      if codeDelimiterLength == nil,
         source[index...].hasPrefix("\\("),
         !isEscaped(source, at: index)
      {
        let valueStart = source.index(index, offsetBy: 2)
        if let close = closingInlineMath(in: source, after: valueStart) {
          let value = String(source[valueStart..<close])
          if !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            let token = "\(tokenPrefix)\(values.count)\(inlineMathTokenSuffix)"
            values[token] = value
            output.append(token)
            index = source.index(close, offsetBy: 2)
            continue
          }
        }
      }

      output.append(source[index])
      index = source.index(after: index)
    }
    return output
  }

  private static func closingInlineMath(
    in source: String,
    after start: String.Index
  ) -> String.Index? {
    var index = start
    while index < source.endIndex {
      if source[index...].hasPrefix("\\)"), !isEscaped(source, at: index) {
        return index
      }
      index = source.index(after: index)
    }
    return nil
  }

  private static func isEscaped(_ source: String, at index: String.Index) -> Bool {
    var cursor = index
    var slashCount = 0
    while cursor > source.startIndex {
      let previous = source.index(before: cursor)
      guard source[previous] == "\\" else { break }
      slashCount += 1
      cursor = previous
    }
    return !slashCount.isMultiple(of: 2)
  }

  private static func fenceMarker(_ line: String) -> String? {
    if line.hasPrefix("```") { return "```" }
    if line.hasPrefix("~~~") { return "~~~" }
    return nil
  }

  private static func footnoteDefinition(_ line: String) -> (id: String, body: String)? {
    let trimmed = line.trimmingCharacters(in: .whitespaces)
    guard trimmed.hasPrefix("[^"), let close = trimmed.range(of: "]:") else { return nil }
    let idStart = trimmed.index(trimmed.startIndex, offsetBy: 2)
    guard idStart < close.lowerBound else { return nil }
    let id = String(trimmed[idStart..<close.lowerBound]).trimmingCharacters(in: .whitespaces)
    guard !id.isEmpty else { return nil }
    let body = String(trimmed[close.upperBound...]).trimmingCharacters(in: .whitespaces)
    return (id, body)
  }

  private static func singleLineMathBlock(_ line: String) -> String? {
    guard line.count >= 4, line.hasPrefix("$$"), line.hasSuffix("$$") else { return nil }
    let start = line.index(line.startIndex, offsetBy: 2)
    let end = line.index(line.endIndex, offsetBy: -2)
    guard start < end else { return nil }
    return String(line[start..<end]).trimmingCharacters(in: .whitespaces)
  }

  private static func appendMathFence(_ source: String, to output: inout [String]) {
    output.append("```ark-math")
    output.append(source)
    output.append("```")
  }

  private struct Converter {
    let footnoteDefinitions: [String: String]
    let inlineMath: [String: String]
    let inlineMathTokenPrefix: String
    var footnoteOrder: [String] = []
    var footnoteNumbers: [String: Int] = [:]

    mutating func blocks(_ children: MarkupChildren) -> [NativeGFMBlock] {
      children.compactMap { block($0) }
    }

    mutating func block(_ markup: Markup) -> NativeGFMBlock? {
      switch markup {
      case let heading as Heading:
        return .heading(level: heading.level, content: inlines(heading.children))
      case let paragraph as Paragraph:
        let values = inlines(paragraph.children)
        if values.count == 1,
           case .image(let source, let alt) = values[0]
        {
          return .image(source: source, alt: alt)
        }
        return .paragraph(values)
      case let quote as BlockQuote:
        return .quote(blocks(quote.children))
      case let list as OrderedList:
        return .list(
          ordered: true,
          start: Int(list.startIndex),
          items: list.listItems.map { listItem($0) }
        )
      case let list as UnorderedList:
        return .list(
          ordered: false,
          start: 1,
          items: list.listItems.map { listItem($0) }
        )
      case let code as CodeBlock:
        let language = code.language?.trimmingCharacters(in: .whitespacesAndNewlines)
        if language == "ark-math" || language == "math" {
          return .math(code.code)
        }
        return .code(language: language?.isEmpty == false ? language : nil, source: code.code)
      case let table as Markdown.Table:
        let alignments = table.columnAlignments.map { alignment -> NativeGFMTableAlignment in
          switch alignment {
          case .left: return .left
          case .center: return .center
          case .right: return .right
          case nil: return .unspecified
          }
        }
        var headers: [[NativeGFMInline]] = []
        for child in table.head.children {
          if let cell = child as? Markdown.Table.Cell { headers.append(inlines(cell.children)) }
        }
        var rows: [[[NativeGFMInline]]] = []
        for row in table.body.rows {
          var values: [[NativeGFMInline]] = []
          for child in row.children {
            if let cell = child as? Markdown.Table.Cell { values.append(inlines(cell.children)) }
          }
          rows.append(values)
        }
        return .table(alignments: alignments, headers: headers, rows: rows)
      case is ThematicBreak:
        return .rule
      case let html as HTMLBlock:
        return .literal(html.rawHTML)
      default:
        let nested = blocks(markup.children)
        return nested.isEmpty ? nil : .quote(nested)
      }
    }

    mutating func listItem(_ item: ListItem) -> NativeGFMListItem {
      let checkbox: Bool?
      switch item.checkbox {
      case .checked: checkbox = true
      case .unchecked: checkbox = false
      case nil: checkbox = nil
      }
      return NativeGFMListItem(checkbox: checkbox, blocks: blocks(item.children))
    }

    mutating func inlines(_ children: MarkupChildren) -> [NativeGFMInline] {
      children.flatMap { inline($0) }
    }

    mutating func inline(_ markup: Markup) -> [NativeGFMInline] {
      switch markup {
      case let text as Markdown.Text:
        return splitSpecialText(text.string)
      case is SoftBreak:
        return [.softBreak]
      case is LineBreak:
        return [.lineBreak]
      case let value as Emphasis:
        return [.emphasis(inlines(value.children))]
      case let value as Strong:
        return [.strong(inlines(value.children))]
      case let value as Strikethrough:
        return [.strikethrough(inlines(value.children))]
      case let value as InlineCode:
        return [.code(value.code)]
      case let value as Markdown.Link:
        return [.link(
          destination: value.destination,
          title: value.title,
          children: inlines(value.children)
        )]
      case let value as Markdown.Image:
        return [.image(source: value.source, alt: plainText(value.children))]
      case let value as InlineHTML:
        return [.literal(value.rawHTML)]
      case let value as SymbolLink:
        return [.code(value.destination ?? "")]
      default:
        let nested = inlines(markup.children)
        if !nested.isEmpty { return nested }
        if let value = markup as? PlainTextConvertibleMarkup {
          return [.literal(value.plainText)]
        }
        return []
      }
    }

    mutating func splitSpecialText(_ source: String) -> [NativeGFMInline] {
      guard !source.isEmpty else { return [] }
      var output: [NativeGFMInline] = []
      var plain = ""
      var index = source.startIndex

      func flush() {
        if !plain.isEmpty {
          output.append(.text(plain))
          plain.removeAll(keepingCapacity: true)
        }
      }

      while index < source.endIndex {
        if let token = inlineMathToken(in: source, at: index),
           let value = inlineMath[token.value]
        {
          flush()
          output.append(.math(value))
          index = token.endIndex
          continue
        }

        if source[index...].hasPrefix("[^"),
           let close = source[index...].firstIndex(of: "]")
        {
          let idStart = source.index(index, offsetBy: 2)
          let id = String(source[idStart..<close]).uppercased()
          if footnoteDefinitions[id] != nil {
            flush()
            let number = footnoteNumber(for: id)
            output.append(.footnoteReference(id: id, number: number))
            index = source.index(after: close)
            continue
          }
        }

        if source[index] == "$",
           !source[index...].hasPrefix("$$"),
           !isEscaped(source, at: index),
           let close = closingDollar(in: source, after: index)
        {
          let valueStart = source.index(after: index)
          let value = String(source[valueStart..<close])
          if !value.isEmpty,
             value.first?.isWhitespace != true,
             value.last?.isWhitespace != true
          {
            flush()
            output.append(.math(value))
            index = source.index(after: close)
            continue
          }
        }

        plain.append(source[index])
        index = source.index(after: index)
      }
      flush()
      return output
    }

    private func inlineMathToken(
      in source: String,
      at index: String.Index
    ) -> (value: String, endIndex: String.Index)? {
      guard source[index...].hasPrefix(inlineMathTokenPrefix),
            let suffix = source.range(
              of: NativeGFMParser.inlineMathTokenSuffix,
              range: index..<source.endIndex
            )
      else { return nil }
      let endIndex = suffix.upperBound
      let token = String(source[index..<endIndex])
      guard inlineMath[token] != nil else { return nil }
      return (token, endIndex)
    }

    mutating func footnoteNumber(for id: String) -> Int {
      if let number = footnoteNumbers[id] { return number }
      let number = footnoteOrder.count + 1
      footnoteOrder.append(id)
      footnoteNumbers[id] = number
      return number
    }

    private func plainText(_ children: MarkupChildren) -> String {
      children.map { child -> String in
        if let value = child as? PlainTextConvertibleMarkup { return value.plainText }
        return plainText(child.children)
      }.joined()
    }

    private func closingDollar(in source: String, after opening: String.Index) -> String.Index? {
      var index = source.index(after: opening)
      while index < source.endIndex {
        if source[index] == "\n" { return nil }
        if source[index] == "$", !isEscaped(source, at: index) { return index }
        index = source.index(after: index)
      }
      return nil
    }

    private func isEscaped(_ source: String, at index: String.Index) -> Bool {
      var cursor = index
      var slashCount = 0
      while cursor > source.startIndex {
        let previous = source.index(before: cursor)
        guard source[previous] == "\\" else { break }
        slashCount += 1
        cursor = previous
      }
      return slashCount.isMultiple(of: 2) == false
    }
  }
}
