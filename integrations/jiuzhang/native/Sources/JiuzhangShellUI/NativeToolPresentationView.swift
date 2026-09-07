import AppKit
import JiuzhangShellCore
import SwiftUI

struct NativeToolPresentationSummary: View {
  let activity: ArkToolActivity
  let language: ArkLanguagePreference
  let openChildSession: (String) -> Void

  init(
    activity: ArkToolActivity,
    language: ArkLanguagePreference = .zh,
    openChildSession: @escaping (String) -> Void = { _ in }
  ) {
    self.activity = activity
    self.language = language
    self.openChildSession = openChildSession
  }

  private var call: ArkToolPresentation? { activity.callView }
  private var result: ArkToolPresentation? { activity.resultView }

  var body: some View {
    let presentation = result ?? call
    VStack(alignment: .leading, spacing: 6) {
      NativeExecutionActivityView(
        activity: activity,
        language: language,
        openChildSession: openChildSession
      )
      if let description = call?.terminalCard?.description {
        Text(description).font(.system(size: 10)).foregroundStyle(Color.secondary)
      }
      if let structured = activity.structuredView {
        structuredSummary(structured)
      } else {
        switch presentation {
        case .generic, nil:
          fallbackSummary
        case .terminal:
          terminalSummary
        case .diff(let card):
          diffSummary(card)
        case .search(let card):
          Text(searchSummary(card))
            .font(.system(size: 11))
            .foregroundStyle(Color.secondary)
        case .read(let card):
          Text(readSummary(card))
            .font(.system(size: 11, design: .monospaced))
            .foregroundStyle(Color.secondary)
        case .web(let card):
          Text(webSummary(card))
            .font(.system(size: 11))
            .foregroundStyle(Color.secondary)
        }
      }
    }
  }

  @ViewBuilder
  private func structuredSummary(_ presentation: ArkStructuredToolPresentation) -> some View {
    switch presentation {
    case .todo(let list):
      VStack(alignment: .leading, spacing: 6) {
        HStack(spacing: 7) {
          Label(ArkL10n.text(.toolTodoTitle, language), systemImage: "checklist")
            .font(.system(size: 11, weight: .semibold))
          Spacer(minLength: 8)
          Text(todoCounts(list))
            .font(.system(size: 9, design: .monospaced))
            .foregroundStyle(Color.secondary)
        }
        ForEach(Array(list.items.prefix(10).enumerated()), id: \.offset) { _, item in
          HStack(alignment: .firstTextBaseline, spacing: 7) {
            Image(systemName: todoSymbol(item.status))
              .font(.system(size: 10, weight: .semibold))
              .foregroundStyle(todoColor(item.status))
              .frame(width: 14)
            Text(item.content)
              .font(.system(size: 11))
              .foregroundStyle(item.status == "completed" ? Color.secondary : Color.primary)
              .strikethrough(item.status == "completed")
          }
        }
      }

    case .questions(let batch):
      VStack(alignment: .leading, spacing: 8) {
        ForEach(Array(batch.questions.prefix(3).enumerated()), id: \.offset) { _, question in
          VStack(alignment: .leading, spacing: 5) {
            Label(
              question.header ?? ArkL10n.text(.toolQuestionFallback, language),
              systemImage: "questionmark.bubble"
            )
              .font(.system(size: 11, weight: .semibold))
            Text(question.question)
              .font(.system(size: 11))
            if let options = question.options, !options.isEmpty {
              HStack(spacing: 5) {
                ForEach(Array(options.prefix(3).enumerated()), id: \.offset) { _, option in
                  Text(option.label)
                    .font(.system(size: 9, weight: .medium))
                    .padding(.horizontal, 7)
                    .frame(height: 20)
                    .background(Color.secondary.opacity(0.09), in: Capsule())
                }
              }
            }
          }
        }
        if activity.isError, let result = activity.result, !result.isEmpty {
          Label(firstLine(result), systemImage: "xmark.octagon.fill")
            .font(.system(size: 10))
            .foregroundStyle(Color.red)
        }
      }
    }
  }

  @ViewBuilder
  private var terminalSummary: some View {
    if let output = result?.terminalCard?.output ?? activity.result {
      Text(compactTerminalPreview(output, lines: 6))
        .font(.system(size: 11, design: .monospaced))
        .foregroundStyle(Color.secondary)
        .lineLimit(6)
    }
  }

  @ViewBuilder
  private func diffSummary(_ card: ArkDiffPresentation) -> some View {
    ForEach(Array(card.diffs.prefix(4).enumerated()), id: \.offset) { _, diff in
      Label(diff.path, systemImage: "doc.badge.ellipsis")
        .font(.system(size: 10, design: .monospaced))
        .foregroundStyle(Color.secondary)
    }
  }

  @ViewBuilder
  private var fallbackSummary: some View {
    if let result = activity.result, !result.isEmpty {
      Text(result)
        .font(.system(size: 11, design: .monospaced))
        .foregroundStyle(Color.secondary)
        .lineLimit(5)
    } else if !activity.arguments.isEmpty {
      Text(activity.arguments)
        .font(.system(size: 10, design: .monospaced))
        .foregroundStyle(Color.secondary)
        .lineLimit(3)
    }
  }

  private func compactTerminalPreview(_ text: String, lines: Int) -> String {
    let values = text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
    guard values.count > lines else { return values.joined(separator: "\n") }
    let headCount = max(lines - 3, 1)
    let tailCount = max(lines - headCount - 1, 1)
    return
      (Array(values.prefix(headCount))
      + ["…"]
      + Array(values.suffix(tailCount))).joined(separator: "\n")
  }

  private func todoCounts(_ list: ArkTodoListPresentation) -> String {
    ArkL10n.format(
      .toolTodoCounts,
      language,
      arguments: [
        String(list.runningCount),
        String(list.pendingCount),
        String(list.completedCount),
      ]
    )
  }

  private func todoSymbol(_ status: String) -> String {
    switch status {
    case "completed": return "checkmark.circle.fill"
    case "in_progress": return "circle.dotted"
    default: return "circle"
    }
  }

  private func todoColor(_ status: String) -> Color {
    switch status {
    case "completed": return .green
    case "in_progress": return .accentColor
    default: return .secondary
    }
  }

  private func firstLine(_ text: String) -> String {
    text.split(separator: "\n", omittingEmptySubsequences: false).first.map(String.init) ?? text
  }

  private func searchSummary(_ card: ArkSearchPresentation) -> String {
    let noun = card.shape == "paths" ? "条路径" : "个匹配"
    return "找到 \(card.total) \(noun)" + (card.truncated ? " · 已截断" : "")
  }

  private func readSummary(_ card: ArkReadPresentation) -> String {
    card.path ?? activity.result ?? "读取完成"
  }

  private func webSummary(_ card: ArkWebPresentation) -> String {
    let base = if card.kind == "fetch" {
      "HTTP \(card.statusCode ?? 0) · \(card.url ?? "网页")"
    } else {
      "网页搜索 · \(card.sources.count) 个来源"
    }
    return base + (card.truncated ? " · 已截断" : "")
  }
}

struct NativeToolPresentationDetail: View {
  let activity: ArkToolActivity

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 13) {
        LabeledContent("工具") { Text(activity.name) }
        LabeledContent("状态") {
          Text(statusLabel)
            .foregroundStyle(statusColor)
        }
        if let title = activity.resultView?.title ?? activity.callView?.title {
          LabeledContent("操作") { Text(title).multilineTextAlignment(.trailing) }
        }
        if let cwd = activity.callView?.terminalCard?.cwd {
          LabeledContent("目录") { Text(cwd).font(.system(size: 10, design: .monospaced)) }
        }
        switch activity.resultView ?? activity.callView {
        case .diff(let card):
          diffDetails(card.diffs)
        case .read(let card):
          readDetails(card)
        case .search(let card):
          searchDetails(card)
        case .web(let card):
          webDetails(card)
        case .generic, .terminal, nil:
          if !activity.arguments.isEmpty {
            section("参数", activity.arguments)
          }
          if let output = activity.resultView?.terminalCard?.output ?? activity.result, !output.isEmpty {
            section("结果", output)
          }
        }
        DisclosureGroup("原始事件") {
          VStack(alignment: .leading, spacing: 10) {
            section("Call", pretty(activity.rawCall))
            if let raw = activity.rawResult { section("Result", pretty(raw)) }
          }
          .padding(.top, 7)
        }
        .font(.system(size: 11, weight: .medium))
        .foregroundStyle(Color.secondary)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  @ViewBuilder
  private func diffDetails(_ diffs: [ArkFileDiff]) -> some View {
    ForEach(Array(diffs.enumerated()), id: \.offset) { _, diff in
      VStack(alignment: .leading, spacing: 7) {
        Text(diff.path)
          .font(.system(size: 11, weight: .semibold, design: .monospaced))
        if let old = diff.oldText { section("修改前", old) }
        if let new = diff.newText { section("修改后", new) }
      }
    }
  }

  @ViewBuilder
  private func readDetails(_ card: ArkReadPresentation) -> some View {
    if let path = card.path { LabeledContent("文件") { Text(path) } }
    if !card.lines.isEmpty {
      section(
        "内容",
        card.lines
          .map { $0.number > 0 ? "\($0.number)  \($0.text)" : $0.text }
          .joined(separator: "\n"))
    }
  }

  @ViewBuilder
  private func searchDetails(_ card: ArkSearchPresentation) -> some View {
    if !card.paths.isEmpty { section("路径", card.paths.joined(separator: "\n")) }
    ForEach(Array(card.files.enumerated()), id: \.offset) { _, file in
      section(
        file.path,
        file.matches
          .map { "\($0.lineNumber)  \($0.line)" }
          .joined(separator: "\n"))
    }
  }

  @ViewBuilder
  private func webDetails(_ card: ArkWebPresentation) -> some View {
    if let answer = card.answer { NativeMarkdownDocument(text: answer) }
    ForEach(Array(card.sources.enumerated()), id: \.offset) { _, source in
      VStack(alignment: .leading, spacing: 3) {
        Text(source.title ?? source.url)
          .font(.system(size: 11, weight: .semibold))
        Text(source.url).font(.system(size: 9, design: .monospaced)).foregroundStyle(Color.secondary)
      }
    }
  }

  private func section(_ title: String, _ value: String) -> some View {
    VStack(alignment: .leading, spacing: 5) {
      Text(title).font(.system(size: 10, weight: .semibold)).foregroundStyle(Color.secondary)
      ScrollView(.horizontal) {
        Text(value).font(.system(size: 10, design: .monospaced)).textSelection(.enabled)
          .fixedSize(horizontal: true, vertical: false)
      }
      .padding(8)
      .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 7))
    }
  }

  private func pretty(_ value: some Codable) -> String {
    guard let data = try? JSONEncoder.prettyTool.encode(value),
      let string = String(data: data, encoding: .utf8)
    else { return String(describing: value) }
    return string
  }

  private var statusLabel: String {
    if activity.isInterrupted { return "已中断" }
    if activity.result == nil { return "运行中" }
    if activity.isError { return "失败" }
    if let signal = activity.resultView?.terminalCard?.signal { return signal }
    if let exit = activity.resultView?.terminalCard?.exitCode, exit != 0 {
      return "退出 \(exit)"
    }
    return "完成"
  }

  private var statusColor: Color {
    if activity.isInterrupted { return .orange }
    if activity.result == nil { return .orange }
    if activity.isError || activity.resultView?.terminalCard?.signal != nil {
      return .red
    }
    if let exit = activity.resultView?.terminalCard?.exitCode, exit != 0 {
      return .red
    }
    return .green
  }
}

extension JSONEncoder {
  fileprivate static var prettyTool: JSONEncoder {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    return encoder
  }
}

/// Case payload accessors: Swift resolves `.terminal` on an enum value to the
/// case constructor, not the payload, so views pattern-match through these.
private extension ArkToolPresentation {
  /// The card title every card kind carries.
  var title: String? {
    switch self {
    case .generic(let card): return card.title
    case .terminal(let card): return card.title
    case .diff(let card): return card.title
    case .search(let card): return card.title
    case .read(let card): return card.title
    case .web(let card): return card.title
    }
  }

  var terminalCard: ArkTerminalPresentation? {
    if case .terminal(let card) = self { return card }
    return nil
  }

  var diffCard: ArkDiffPresentation? {
    if case .diff(let card) = self { return card }
    return nil
  }

  var searchCard: ArkSearchPresentation? {
    if case .search(let card) = self { return card }
    return nil
  }

  var readCard: ArkReadPresentation? {
    if case .read(let card) = self { return card }
    return nil
  }

  var webCard: ArkWebPresentation? {
    if case .web(let card) = self { return card }
    return nil
  }
}
