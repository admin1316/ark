import Foundation

func runArkNativeCodeEditorContractChecks() {
  let editorURL = contractNativeRoot.appendingPathComponent(
    "Sources/JiuzhangShellUI/NativeCodeEditorView.swift"
  )
  let workbenchURL = contractNativeRoot.appendingPathComponent(
    "Sources/JiuzhangShellUI/NativeWorkbenchView.swift"
  )
  guard
    let editor = try? String(contentsOf: editorURL, encoding: .utf8),
    let workbench = try? String(contentsOf: workbenchURL, encoding: .utf8)
  else {
    check(false, "native code editor sources are readable")
    return
  }

  check(
    editor.contains("NSTextView(usingTextLayoutManager: true)")
      && editor.contains("textView.textLayoutManager")
      && editor.contains("scrollView.documentView = textView")
      && editor.contains("layer?.masksToBounds = true")
      && editor.contains("NativeCodeEditorView requires the TextKit 2 layout manager")
      && editor.contains("textView.string = value")
      && editor.contains("textContainer?.widthTracksTextView = true")
      && editor.contains("scrollView.hasHorizontalScroller = false")
      && editor.contains("textView.isHorizontallyResizable = false")
      && editor.contains("textView.autoresizingMask = [.width]")
      && editor.contains("monospacedSystemFont(ofSize: 13")
      && editor.contains("monospacedDigitSystemFont(ofSize: 11")
      && editor.contains("textView.textContainerInset = NSSize(width: 14, height: 12)")
      && editor.contains("textViewportLayoutController.layoutViewport()")
      && !editor.contains("ensureLayout(for: contentManager.documentRange)")
      && editor.contains("applyingSyntaxAttributes")
      && editor.contains("func fitDocument(to scrollView: NSScrollView)")
      && editor.contains("contentSize.width > 1")
      && editor.contains("usageBoundsForTextContainer.height")
      && editor.contains("pinHorizontalOrigin()")
      && editor.contains("captureViewportAnchor()")
      && editor.contains("restoreViewportAnchor(viewportAnchor)")
      && editor.contains("documentFitsViewport")
      && editor.contains("clipView.scroll(to: .zero)")
      && editor.contains("NSPoint(x: 0, y: visibleOrigin.y)")
      && editor.contains("abs(textView.frame.width - target.width) > 0.5"),
    "native Files editor uses viewport-only TextKit 2 soft wrapping with stable document geometry"
  )
  check(
    editor.contains("NativeCodeLineNumberView")
      && editor.contains("lineNumberHost")
      && editor.contains("installLineNumberView")
      && editor.contains("NSView.boundsDidChangeNotification")
      && editor.contains("updateLineStarts")
      && editor.contains("override var isFlipped: Bool { true }")
      && editor.contains("thicknessDidChange")
      && editor.contains("firstVisibleLine(in visible: NSRect")
      && editor.contains("while lower < upper")
      && editor.contains("rect.maxY < visible.minY")
      && editor.contains("textRect(forUTF16Offset:")
      && editor.contains("enumerateTextSegments(")
      && editor.contains("type: .standard")
      && editor.contains(".upstreamAffinity")
      && editor.contains("override func scrollWheel(with event: NSEvent)")
      && editor.contains("contentView.scroll(to: NSPoint(x: 0, y: origin.y))")
      && !editor.contains("firstRect(")
      && !editor.contains("NSRulerView")
      && !editor.contains("textView.string.reduce(into:"),
    "native Files editor owns a cached scroll-synchronized gutter independent of TextKit's ruler client"
  )
  check(
    editor.contains("maximumHighlightedBytes")
      && editor.contains("DispatchQueue.global(qos: .userInitiated).asyncAfter")
      && editor.contains("highlightWorkItem?.cancel()")
      && editor.contains("layoutManager.setRenderingAttributes")
      && editor.contains("resolvedColor(.labelColor, appearance: appearance)")
      && editor.contains("applyAppearance(from scrollView: NSScrollView)")
      && editor.contains("NativeCodeSyntax.tempered(.systemGreen)")
      && editor.contains("NativeCodeSyntax.tempered(.systemRed)")
      && editor.contains("(?<!`)`[^`\\\\r\\\\n]+`(?!`)")
      && !editor.contains("`[^`]+`"),
    "native Files syntax presentation is bounded, adaptive, and cannot color multiline Markdown fences as strings"
  )
  check(
    editor.contains("enum NativeCodeEditorPresentation")
      && editor.contains("case unifiedDiff")
      && editor.contains("presentation: NativeCodeEditorPresentation = .source")
      && editor.contains("if presentation == .unifiedDiff")
      && editor.contains("case diffAddition")
      && editor.contains("case diffDeletion")
      && editor.contains(".systemGreen.withAlphaComponent(0.10)")
      && editor.contains(".systemRed.withAlphaComponent(0.10)")
      && editor.contains(".backgroundColor: NSColor.clear"),
    "native TextKit editor owns adaptive unified-diff foreground and background presentation"
  )
  check(
    editor.contains("static func dismantleNSView")
      && editor.contains("coordinator.ruler?.detach()")
      && editor.contains("coordinator.textView?.delegate = nil"),
    "native Files TextKit bridge explicitly tears down observers and delegates"
  )

  let nativeTextEditor = nativeCodeEditorSlice(
    workbench,
    from: "private struct NativeTextEditor",
    through: "private struct NativeGitInspector"
  )
  check(
    nativeTextEditor?.contains("NativeCodeEditorView(text:") == true
      && nativeTextEditor?.contains("TextEditor(text:") == false
      && nativeTextEditor?.contains("set: model.updateEditorText") == true
      && workbench.contains("func updateEditorText(_ newValue: String)")
      && workbench.contains("fileTabs.updateText(id: activeID, text: newValue)")
      && workbench.contains("scheduleRecoveryDraft(for: tab)"),
    "native Workbench uses the TextKit 2 editor with the shared canonical file-tab state"
  )
  check(
    nativeTextEditor?.contains("if model.activeFileTab == nil") == true
      && nativeTextEditor?.contains("filesEmptyEditorTitle") == true
      && nativeTextEditor?.contains("filesEmptyEditorDetail") == true
      && nativeTextEditor?.contains("ark.files.empty-editor") == true
      && nativeTextEditor?.contains("private var loadedEditor") == true,
    "native Files shows a centered empty-editor state and mounts editing controls only after a file opens"
  )
}

private func nativeCodeEditorSlice(
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
  return String(source[startRange.lowerBound..<endRange.lowerBound])
}
