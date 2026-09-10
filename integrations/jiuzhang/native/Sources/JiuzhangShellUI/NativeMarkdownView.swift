import Foundation
import SwiftUI

/// Browser-free Markdown presentation shared by native Chat messages, tool
/// results, context disclosures, and compacted-session summaries.
///
/// Parsing and rendering live in the GFM model/view pair so every surface
/// receives the same nested-list, table, math, code, reference, and footnote
/// semantics without HTML or an embedded browser engine.
struct NativeMarkdownDocument: View {
  @State private var accessibilityDocumentID = UUID().uuidString
  let text: String
  let baseFontSize: CGFloat
  let producedFilePaths: [String]
  let openURLAction: ((URL) -> OpenURLAction.Result)?

  init(
    text: String,
    baseFontSize: CGFloat = 14,
    producedFilePaths: [String] = [],
    openURLAction: ((URL) -> OpenURLAction.Result)? = nil
  ) {
    self.text = text
    self.baseFontSize = baseFontSize
    self.producedFilePaths = producedFilePaths
    self.openURLAction = openURLAction
  }

  var body: some View {
    NativeGFMDocumentView(
      text: text,
      baseFontSize: baseFontSize,
      documentID: accessibilityDocumentID
    )
      .nativeMarkdownRoutes(
        producedFilePaths: producedFilePaths,
        openURLAction: openURLAction
      )
  }
}

extension View {
  func nativeMarkdownRoutes(
    producedFilePaths: [String],
    openURLAction: ((URL) -> OpenURLAction.Result)? = nil
  ) -> some View {
    modifier(NativeMarkdownRouteModifier(
      producedFilePaths: producedFilePaths,
      openURLAction: openURLAction
    ))
  }
}

private struct NativeMarkdownRouteModifier: ViewModifier {
  @Environment(\.arkOpenToolFile) private var openToolFile
  let producedFilePaths: [String]
  let openURLAction: ((URL) -> OpenURLAction.Result)?

  func body(content: Content) -> some View {
    content
      .environment(\.nativeProducedFilePaths, producedFilePaths)
      .environment(\.openURL, OpenURLAction { url in
        guard let path = ArkProducedFilesProjection.mentionPath(from: url) else {
          return openURLAction?(url) ?? .systemAction
        }
        openToolFile(path)
        return .handled
      })
  }
}
