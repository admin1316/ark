import AppKit
import SwiftUI

/// TextKit 2 大文本查看器：只读、可选中、monospaced 的原始 JSON 渲染。
///
/// - 通过 `NSTextView(usingTextLayoutManager: true)` 强制走 TextKit 2 懒排版路径，
///   只排版可视区域，而不是整段 100–400KB 字符串；
/// - `updateNSView` 只在文本内容真实变化时替换 text storage——父级普通状态更新
///   不会重新排版整段大文本，也不会把滚动位置打回顶部；
/// - 写入只走 TextKit 2 的 `textContentStorage` 路径，不存在 TextKit 1 回退；
/// - 字符串原样传入，不裁剪、不分页、不改变审计内容。
struct NativeRawJSONTextView: NSViewRepresentable {
  let text: String

  final class Coordinator {
    var lastText: String?
    weak var textView: NSTextView?
  }

  func makeCoordinator() -> Coordinator { Coordinator() }

  func makeNSView(context: Context) -> NSScrollView {
    let scrollView = NSScrollView()
    scrollView.hasVerticalScroller = true
    scrollView.hasHorizontalScroller = false
    scrollView.drawsBackground = false
    scrollView.borderType = .noBorder

    let textView = NSTextView(usingTextLayoutManager: true)
    textView.isEditable = false
    textView.isSelectable = true
    textView.isRichText = false
    textView.allowsUndo = false
    textView.drawsBackground = false
    textView.textColor = .labelColor
    textView.textContainerInset = NSSize(width: 14, height: 14)
    textView.isHorizontallyResizable = false
    textView.isVerticallyResizable = true
    textView.autoresizingMask = [.width]
    textView.minSize = NSSize(width: 0, height: 0)
    textView.maxSize = NSSize(
      width: CGFloat.greatestFiniteMagnitude,
      height: CGFloat.greatestFiniteMagnitude
    )

    scrollView.documentView = textView
    context.coordinator.textView = textView
    applyText(text, to: context.coordinator)
    return scrollView
  }

  func updateNSView(_ scrollView: NSScrollView, context: Context) {
    applyText(text, to: context.coordinator)
  }

  /// 文本内容真实变化才替换 storage：既保证内容最新，又避免每次 update 全量重排版。
  /// 只写 TextKit 2 的 `textContentStorage`；路径缺失时不更新 lastText，下次重试。
  private func applyText(_ newText: String, to coordinator: Coordinator) {
    guard newText != coordinator.lastText,
          let textView = coordinator.textView,
          let storage = textView.textContentStorage?.textStorage
    else { return }
    coordinator.lastText = newText
    let attributed = NSAttributedString(
      string: newText,
      attributes: [
        .font: NSFont.monospacedSystemFont(ofSize: 11, weight: .regular),
        .foregroundColor: NSColor.labelColor,
      ]
    )
    storage.setAttributedString(attributed)
  }
}
