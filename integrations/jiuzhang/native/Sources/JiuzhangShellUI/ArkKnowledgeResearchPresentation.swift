import SwiftUI
import JiuzhangShellCore

/// Actual search URLs share the same native browser navigation policy in every knowledge view.
@MainActor
struct NativeKnowledgeResearchSources: View {
  let sources: [ArkKnowledgeResearchSource]
  let language: ArkLanguagePreference
  var openSource: (URL) -> Void = { NativeWorkbenchCommandCenter.shared.openResearchSource.send($0) }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(language == .zh ? "来源 · 搜索摘要" : "Sources · search snippets")
        .font(.system(size: 12, weight: .semibold))
      Text(language == .zh ? "研究使用搜索摘要，未读取来源全文；候选仍需审阅。" : "Research used search snippets, not full pages. Candidates still need review.")
        .font(.system(size: 10))
        .foregroundStyle(ArkPalette.secondary)
        .accessibilityIdentifier("ark.wiki.research.snippet-notice")
      ForEach(sources) { source in
        Button {
          guard let url = URL(string: source.url), NativeBrowserNavigationPolicy.allows(url) else { return }
          openSource(url)
        } label: {
          Label(source.url, systemImage: "arrow.up.right.square")
            .lineLimit(2)
            .multilineTextAlignment(.leading)
        }
        .buttonStyle(.link)
        .font(.system(size: 10))
        .help(language == .zh ? "在工作台浏览器中打开" : "Open in Workbench browser")
        .accessibilityIdentifier("ark.wiki.research.source.\(source.url)")
      }
    }
    .accessibilityIdentifier("ark.wiki.research.sources")
  }
}

/// A successful current-project result remains available beside the research controls.
@MainActor
struct NativeKnowledgeResearchResultView: View {
  let result: ArkKnowledgeResearchResult
  let language: ArkLanguagePreference
  var openSource: (URL) -> Void = { NativeWorkbenchCommandCenter.shared.openResearchSource.send($0) }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(language == .zh
        ? "已生成 \(result.findings.count) 个待审阅候选；\(result.sourceCount) 个搜索摘要来源。"
        : "Created \(result.findings.count) candidates for review from \(result.sourceCount) search-snippet sources.")
        .font(.system(size: 12, weight: .semibold))
        .accessibilityIdentifier("ark.wiki.research.result")
      if result.degraded {
        Text(language == .zh ? "部分研究未完成" : "Research partially completed")
          .font(.system(size: 11, weight: .medium))
          .foregroundStyle(Color.orange)
          .accessibilityIdentifier("ark.wiki.research.degraded")
      }
      ScrollView {
        VStack(alignment: .leading, spacing: 8) {
          NativeKnowledgeResearchSources(sources: result.sources, language: language, openSource: openSource)
          ForEach(Array(result.warnings.enumerated()), id: \.offset) { index, warning in
            Text(warning)
              .font(.system(size: 10))
              .foregroundStyle(Color.orange)
              .accessibilityIdentifier("ark.wiki.research.warning.\(index)")
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      .frame(maxHeight: 130)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(12)
    .background(ArkPalette.panel)
  }
}
