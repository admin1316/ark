import AppKit
import SwiftUI

enum NativeCodeEditorPresentation: Equatable {
  case source
  case unifiedDiff
}

/// Editable TextKit 2 code surface used by Native Files.
///
/// The TextKit 2 container tracks the viewport width so long lines wrap without
/// clipping. Text replacement is guarded by exact content equality to preserve
/// selection and scroll position across ordinary SwiftUI updates. Syntax
/// attributes are debounced and skipped for very large files; text ownership
/// always remains with the bound file tab.
struct NativeCodeEditorView: NSViewRepresentable {
  @Binding var text: String
  let fileURL: URL?
  let isEditable: Bool
  let presentation: NativeCodeEditorPresentation

  init(
    text: Binding<String>,
    fileURL: URL?,
    isEditable: Bool,
    presentation: NativeCodeEditorPresentation = .source
  ) {
    _text = text
    self.fileURL = fileURL
    self.isEditable = isEditable
    self.presentation = presentation
  }

  func makeCoordinator() -> Coordinator {
    Coordinator(text: $text, presentation: presentation)
  }

  func makeNSView(context: Context) -> NativeCodeEditorContainerView {
    let containerView = NativeCodeEditorContainerView()
    let scrollView = containerView.scrollView
    let textView = NSTextView(usingTextLayoutManager: true)
    precondition(
      textView.textLayoutManager != nil,
      "NativeCodeEditorView requires the TextKit 2 layout manager"
    )
    scrollView.borderType = .noBorder
    scrollView.drawsBackground = true
    scrollView.backgroundColor = .textBackgroundColor
    scrollView.hasVerticalScroller = true
    scrollView.hasHorizontalScroller = false
    scrollView.autohidesScrollers = true
    scrollView.contentView.postsBoundsChangedNotifications = true
    scrollView.documentView = textView

    textView.delegate = context.coordinator
    textView.isEditable = isEditable
    textView.isSelectable = true
    textView.isRichText = false
    textView.importsGraphics = false
    textView.allowsUndo = true
    textView.isAutomaticQuoteSubstitutionEnabled = false
    textView.isAutomaticDashSubstitutionEnabled = false
    textView.isAutomaticTextReplacementEnabled = false
    textView.isAutomaticSpellingCorrectionEnabled = false
    textView.usesFindBar = true
    textView.font = NativeCodeSyntax.baseFont
    textView.textColor = .labelColor
    textView.backgroundColor = .textBackgroundColor
    textView.drawsBackground = true
    textView.textContainerInset = NSSize(width: 14, height: 12)
    textView.isHorizontallyResizable = false
    textView.isVerticallyResizable = true
    textView.autoresizingMask = [.width]
    textView.minSize = NSSize(width: 0, height: 0)
    textView.maxSize = NSSize(
      width: CGFloat.greatestFiniteMagnitude,
      height: CGFloat.greatestFiniteMagnitude
    )
    textView.textContainer?.containerSize = NSSize(
      width: max(1, scrollView.contentSize.width),
      height: CGFloat.greatestFiniteMagnitude
    )
    textView.textContainer?.widthTracksTextView = true

    let gutter = NativeCodeLineNumberView(textView: textView, scrollView: scrollView)
    containerView.installLineNumberView(gutter)
    context.coordinator.textView = textView
    context.coordinator.ruler = gutter
    scrollView.onStableLayout = { [weak scrollView, weak coordinator = context.coordinator] in
      guard let scrollView, let coordinator else { return }
      coordinator.fitDocument(to: scrollView)
      scrollView.pinHorizontalOrigin()
      coordinator.layoutViewport()
    }
    context.coordinator.applyAppearance(from: scrollView)
    context.coordinator.applyExternalText(
      text,
      fileURL: fileURL,
      presentation: presentation
    )
    let coordinator = context.coordinator
    DispatchQueue.main.async { [weak scrollView, weak coordinator] in
      guard let scrollView, let coordinator else { return }
      coordinator.fitDocument(to: scrollView)
      coordinator.layoutViewport()
    }
    return containerView
  }

  func updateNSView(_ containerView: NativeCodeEditorContainerView, context: Context) {
    let scrollView = containerView.scrollView
    guard let textView = scrollView.documentView as? NSTextView else { return }
    textView.isEditable = isEditable
    context.coordinator.presentation = presentation
    context.coordinator.applyAppearance(from: scrollView)
    context.coordinator.fitDocument(to: scrollView)
    context.coordinator.applyExternalText(
      text,
      fileURL: fileURL,
      presentation: presentation
    )
  }

  static func dismantleNSView(
    _ containerView: NativeCodeEditorContainerView,
    coordinator: Coordinator
  ) {
    let scrollView = containerView.scrollView
    coordinator.highlightWorkItem?.cancel()
    coordinator.ruler?.detach()
    coordinator.textView?.delegate = nil
    coordinator.textView = nil
    coordinator.ruler = nil
    scrollView.onStableLayout = nil
    scrollView.documentView = nil
  }

  final class Coordinator: NSObject, NSTextViewDelegate {
    @Binding var text: String
    weak var textView: NSTextView?
    fileprivate weak var ruler: NativeCodeLineNumberView?
    var lastText: String?
    var lastFileExtension: String?
    var lastFileIdentity: String?
    var presentation: NativeCodeEditorPresentation
    var lastPresentation: NativeCodeEditorPresentation?
    var applyingExternalText = false
    var applyingSyntaxAttributes = false
    var highlightRevision = 0
    var highlightWorkItem: DispatchWorkItem?
    var lastAppearanceName: NSAppearance.Name?

    init(text: Binding<String>, presentation: NativeCodeEditorPresentation) {
      _text = text
      self.presentation = presentation
    }

    func fitDocument(to scrollView: NSScrollView) {
      guard let textView, textView.enclosingScrollView === scrollView else { return }
      let contentSize = scrollView.contentSize
      guard contentSize.width > 1, contentSize.height > 1 else { return }
      let clipView = scrollView.contentView
      let previousOrigin = clipView.bounds.origin
      let wasAtTop = previousOrigin.y <= 1
      let viewportAnchor = wasAtTop ? nil : ruler?.captureViewportAnchor()
      textView.textContainer?.containerSize = NSSize(
        width: floor(contentSize.width),
        height: CGFloat.greatestFiniteMagnitude
      )
      textView.textContainer?.widthTracksTextView = true
      textView.textLayoutManager?.textViewportLayoutController.layoutViewport()
      let usedHeight = textView.textLayoutManager?.usageBoundsForTextContainer.height ?? 0
      let target = NSSize(
        width: floor(contentSize.width),
        height: max(
          floor(contentSize.height),
          ceil(usedHeight + textView.textContainerInset.height * 2 + 8)
        )
      )
      let requiresResize = abs(textView.frame.width - target.width) > 0.5
        || abs(textView.frame.height - target.height) > 0.5
      if requiresResize { textView.setFrameSize(target) }
      textView.textLayoutManager?.textViewportLayoutController.layoutViewport()

      let documentFitsViewport = target.height <= floor(contentSize.height) + 1
      if wasAtTop || documentFitsViewport {
        clipView.scroll(to: .zero)
        scrollView.reflectScrolledClipView(clipView)
      } else if let viewportAnchor {
        ruler?.restoreViewportAnchor(viewportAnchor)
      } else {
        let maximumY = max(0, target.height - contentSize.height)
        clipView.scroll(to: NSPoint(x: 0, y: min(maximumY, max(0, previousOrigin.y))))
        scrollView.reflectScrolledClipView(clipView)
      }
      textView.needsDisplay = true
      ruler?.needsDisplay = true
    }

    func applyAppearance(from scrollView: NSScrollView) {
      guard let textView else { return }
      let appearance = scrollView.effectiveAppearance
      let name = appearance.bestMatch(from: [.darkAqua, .aqua])
      let changed = name != lastAppearanceName
      lastAppearanceName = name
      appearance.performAsCurrentDrawingAppearance {
        scrollView.backgroundColor = .textBackgroundColor
        textView.backgroundColor = .textBackgroundColor
        textView.textColor = .labelColor
      }
      guard changed, let lastText else { return }
      scheduleHighlight(
        text: lastText,
        fileExtension: lastFileExtension,
        presentation: presentation
      )
      DispatchQueue.main.async { [weak self] in self?.layoutViewport() }
    }

    func applyExternalText(
      _ value: String,
      fileURL: URL?,
      presentation: NativeCodeEditorPresentation
    ) {
      guard let textView else { return }
      let fileExtension = fileURL?.pathExtension.lowercased()
      let fileIdentity = fileURL?.standardizedFileURL.path
      let contentChanged = textView.string != value
      let presentationChanged = presentation != lastPresentation
      let fileChanged = fileIdentity != lastFileIdentity
      guard contentChanged || fileExtension != lastFileExtension || presentationChanged else {
        return
      }

      if contentChanged {
        applyingExternalText = true
        let selection = textView.selectedRange()
        let visibleOrigin = textView.enclosingScrollView?.contentView.bounds.origin
        textView.string = value
        textView.font = NativeCodeSyntax.baseFont
        textView.textColor = .labelColor
        let location = min(selection.location, (value as NSString).length)
        textView.setSelectedRange(NSRange(location: location, length: 0))
        if presentation == .unifiedDiff, fileChanged {
          textView.enclosingScrollView?.contentView.scroll(to: .zero)
          if let scrollView = textView.enclosingScrollView {
            scrollView.reflectScrolledClipView(scrollView.contentView)
          }
        } else if let visibleOrigin {
          textView.enclosingScrollView?.contentView.scroll(
            to: NSPoint(x: 0, y: visibleOrigin.y)
          )
          textView.enclosingScrollView?.reflectScrolledClipView(
            textView.enclosingScrollView!.contentView
          )
        }
        applyingExternalText = false
      }

      lastText = value
      lastFileExtension = fileExtension
      lastFileIdentity = fileIdentity
      lastPresentation = presentation
      updateDocumentIndex(value)
      if let scrollView = textView.enclosingScrollView { fitDocument(to: scrollView) }
      DispatchQueue.main.async { [weak self] in self?.layoutViewport() }
      scheduleHighlight(
        text: value,
        fileExtension: fileExtension,
        presentation: presentation
      )
    }

    func textDidChange(_ notification: Notification) {
      guard !applyingExternalText,
            !applyingSyntaxAttributes,
            let editor = notification.object as? NSTextView
      else { return }
      text = editor.string
      lastText = editor.string
      updateDocumentIndex(editor.string)
      if let scrollView = editor.enclosingScrollView { fitDocument(to: scrollView) }
      scheduleHighlight(
        text: editor.string,
        fileExtension: lastFileExtension,
        presentation: presentation
      )
    }

    func textViewDidChangeSelection(_ notification: Notification) {
      ruler?.needsDisplay = true
    }

    func layoutViewport() {
      textView?.textLayoutManager?.textViewportLayoutController.layoutViewport()
    }

    private func updateDocumentIndex(_ value: String) {
      var starts = [0]
      var offset = 0
      for codeUnit in value.utf16 {
        offset += 1
        if codeUnit == 10 {
          starts.append(offset)
        }
      }
      ruler?.updateLineStarts(starts)
    }

    private func scheduleHighlight(
      text: String,
      fileExtension: String?,
      presentation: NativeCodeEditorPresentation
    ) {
      highlightWorkItem?.cancel()
      highlightRevision += 1
      let revision = highlightRevision
      guard text.utf8.count <= NativeCodeSyntax.maximumHighlightedBytes else {
        applyHighlights([], text: text, revision: revision)
        return
      }

      let work = DispatchWorkItem { [weak self] in
        let spans = NativeCodeSyntax.spans(
          in: text,
          fileExtension: fileExtension,
          presentation: presentation
        )
        DispatchQueue.main.async { [weak self] in
          self?.applyHighlights(spans, text: text, revision: revision)
        }
      }
      highlightWorkItem = work
      DispatchQueue.global(qos: .userInitiated).asyncAfter(
        deadline: .now() + 0.12,
        execute: work
      )
    }

    private func applyHighlights(
      _ spans: [NativeCodeSyntax.Span],
      text: String,
      revision: Int
    ) {
      guard revision == highlightRevision,
            let textView,
            textView.string == text,
            let layoutManager = textView.textLayoutManager,
            let contentManager = layoutManager.textContentManager
      else { return }
      applyingSyntaxAttributes = true
      let appearance = textView.effectiveAppearance
      layoutManager.setRenderingAttributes(
        [
          .foregroundColor: resolvedColor(.labelColor, appearance: appearance),
          .backgroundColor: NSColor.clear,
        ],
        for: contentManager.documentRange
      )
      let start = contentManager.documentRange.location
      let textLength = (text as NSString).length
      for span in spans where NSMaxRange(span.range) <= textLength {
        guard
          let location = contentManager.location(start, offsetBy: span.range.location),
          let end = contentManager.location(location, offsetBy: span.range.length),
          let range = NSTextRange(location: location, end: end)
        else { continue }
        var attributes: [NSAttributedString.Key: Any] = [
          .foregroundColor: resolvedColor(span.kind.color, appearance: appearance),
        ]
        if let backgroundColor = span.kind.backgroundColor {
          attributes[.backgroundColor] = resolvedColor(
            backgroundColor,
            appearance: appearance
          )
        }
        layoutManager.setRenderingAttributes(attributes, for: range)
      }
      applyingSyntaxAttributes = false
      layoutManager.textViewportLayoutController.layoutViewport()
      textView.needsDisplay = true
    }

    private func resolvedColor(_ color: NSColor, appearance: NSAppearance) -> NSColor {
      var resolved = color
      appearance.performAsCurrentDrawingAppearance {
        resolved = color.usingColorSpace(.deviceRGB) ?? color
      }
      return resolved
    }
  }
}

final class NativeCodeEditorContainerView: NSView {
  let scrollView = NativeCodeScrollView()
  private let lineNumberHost = NSView()
  private var lineNumberWidth: NSLayoutConstraint!

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    wantsLayer = true
    layer?.masksToBounds = true
    lineNumberHost.translatesAutoresizingMaskIntoConstraints = false
    scrollView.translatesAutoresizingMaskIntoConstraints = false
    addSubview(lineNumberHost)
    addSubview(scrollView)
    lineNumberWidth = lineNumberHost.widthAnchor.constraint(equalToConstant: 42)
    NSLayoutConstraint.activate([
      lineNumberHost.leadingAnchor.constraint(equalTo: leadingAnchor),
      lineNumberHost.topAnchor.constraint(equalTo: topAnchor),
      lineNumberHost.bottomAnchor.constraint(equalTo: bottomAnchor),
      lineNumberWidth,
      scrollView.leadingAnchor.constraint(equalTo: lineNumberHost.trailingAnchor),
      scrollView.trailingAnchor.constraint(equalTo: trailingAnchor),
      scrollView.topAnchor.constraint(equalTo: topAnchor),
      scrollView.bottomAnchor.constraint(equalTo: bottomAnchor),
    ])
  }

  required init?(coder: NSCoder) {
    fatalError("NativeCodeEditorContainerView is programmatic")
  }

  fileprivate func installLineNumberView(_ view: NativeCodeLineNumberView) {
    lineNumberHost.subviews.forEach { $0.removeFromSuperview() }
    view.translatesAutoresizingMaskIntoConstraints = false
    view.thicknessDidChange = { [weak self] width in
      self?.lineNumberWidth.constant = width
    }
    lineNumberHost.addSubview(view)
    NSLayoutConstraint.activate([
      view.leadingAnchor.constraint(equalTo: lineNumberHost.leadingAnchor),
      view.trailingAnchor.constraint(equalTo: lineNumberHost.trailingAnchor),
      view.topAnchor.constraint(equalTo: lineNumberHost.topAnchor),
      view.bottomAnchor.constraint(equalTo: lineNumberHost.bottomAnchor),
    ])
  }
}

final class NativeCodeScrollView: NSScrollView {
  var onStableLayout: (() -> Void)?
  private var layoutCallbackPending = false

  override func layout() {
    super.layout()
    pinHorizontalOrigin()
    guard !layoutCallbackPending else { return }
    layoutCallbackPending = true
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      layoutCallbackPending = false
      onStableLayout?()
    }
  }

  override func scrollWheel(with event: NSEvent) {
    super.scrollWheel(with: event)
    pinHorizontalOrigin()
  }

  func pinHorizontalOrigin() {
    let origin = contentView.bounds.origin
    guard abs(origin.x) > 0.25 else { return }
    contentView.scroll(to: NSPoint(x: 0, y: origin.y))
    reflectScrolledClipView(contentView)
  }
}

private struct NativeCodeViewportAnchor {
  let utf16Offset: Int
  let offsetWithinLine: CGFloat
}

private final class NativeCodeLineNumberView: NSView {
  private weak var textView: NSTextView?
  private weak var observedClipView: NSClipView?
  private let numberFont = NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .regular)
  private var lineStarts = [0]
  var thicknessDidChange: ((CGFloat) -> Void)?
  override var isFlipped: Bool { true }

  init(textView: NSTextView, scrollView: NSScrollView) {
    self.textView = textView
    observedClipView = scrollView.contentView
    super.init(frame: .zero)
    wantsLayer = true
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(clipBoundsDidChange),
      name: NSView.boundsDidChangeNotification,
      object: scrollView.contentView
    )
  }

  required init?(coder: NSCoder) {
    fatalError("NativeCodeLineNumberView is programmatic")
  }

  deinit {
    detach()
  }

  func detach() {
    if let observedClipView {
      NotificationCenter.default.removeObserver(
        self,
        name: NSView.boundsDidChangeNotification,
        object: observedClipView
      )
    }
    observedClipView = nil
    textView = nil
    thicknessDidChange = nil
  }

  func updateLineStarts(_ starts: [Int]) {
    let normalized = starts.isEmpty ? [0] : starts
    guard normalized != lineStarts else { return }
    lineStarts = normalized
    let count = lineStarts.count
    let digits = String(count).count
    let requiredThickness = max(46, CGFloat(digits * 8 + 20))
    thicknessDidChange?(requiredThickness)
    needsDisplay = true
  }

  @objc private func clipBoundsDidChange() {
    needsDisplay = true
  }

  func captureViewportAnchor() -> NativeCodeViewportAnchor? {
    guard let textView, let clipView = observedClipView, !lineStarts.isEmpty else { return nil }
    let visible = clipView.bounds
    let index = firstVisibleLine(in: visible, textView: textView)
    guard index < lineStarts.count,
          let rect = textRect(forUTF16Offset: lineStarts[index], in: textView)
    else { return nil }
    return NativeCodeViewportAnchor(
      utf16Offset: lineStarts[index],
      offsetWithinLine: visible.minY - rect.minY
    )
  }

  func restoreViewportAnchor(_ anchor: NativeCodeViewportAnchor) {
    guard let textView,
          let clipView = observedClipView,
          let scrollView = textView.enclosingScrollView,
          let rect = textRect(forUTF16Offset: anchor.utf16Offset, in: textView)
    else { return }
    let maximumY = max(0, textView.frame.height - clipView.bounds.height)
    let targetY = min(maximumY, max(0, rect.minY + anchor.offsetWithinLine))
    clipView.scroll(to: NSPoint(x: 0, y: targetY))
    scrollView.reflectScrolledClipView(clipView)
  }

  override func draw(_ dirtyRect: NSRect) {
    guard let textView, let clipView = observedClipView else { return }
    NSColor.controlBackgroundColor.setFill()
    dirtyRect.fill()

    let visible = clipView.bounds
    let first = max(0, firstVisibleLine(in: visible, textView: textView) - 1)
    let selectedLine = lineIndex(at: textView.selectedRange().location)

    let paragraph = NSMutableParagraphStyle()
    paragraph.alignment = .right
    let attributes: [NSAttributedString.Key: Any] = [
      .font: numberFont,
      .foregroundColor: NSColor.secondaryLabelColor,
      .paragraphStyle: paragraph,
    ]

    var index = first
    while index < lineStarts.count {
      guard let lineRect = textRect(forUTF16Offset: lineStarts[index], in: textView) else {
        index += 1
        continue
      }
      let y = lineRect.minY - visible.minY
      if lineRect.minY > visible.maxY { break }
      if lineRect.maxY < visible.minY {
        index += 1
        continue
      }
      if index == selectedLine {
        NSColor.selectedContentBackgroundColor.withAlphaComponent(0.12).setFill()
        NSRect(x: 0, y: y, width: bounds.width, height: lineRect.height).fill()
      }
      let numberRect = NSRect(x: 4, y: y, width: bounds.width - 10, height: lineRect.height)
      String(index + 1).draw(in: numberRect, withAttributes: attributes)
      index += 1
    }

    NSColor.separatorColor.setFill()
    NSRect(x: bounds.maxX - 1, y: dirtyRect.minY, width: 1, height: dirtyRect.height).fill()
  }

  private func lineIndex(at utf16Offset: Int) -> Int {
    let offset = max(0, utf16Offset)
    var lower = 0
    var upper = lineStarts.count
    while lower < upper {
      let middle = (lower + upper) / 2
      if lineStarts[middle] <= offset {
        lower = middle + 1
      } else {
        upper = middle
      }
    }
    return max(0, lower - 1)
  }

  private func firstVisibleLine(in visible: NSRect, textView: NSTextView) -> Int {
    var lower = 0
    var upper = lineStarts.count
    while lower < upper {
      let middle = (lower + upper) / 2
      guard let rect = textRect(forUTF16Offset: lineStarts[middle], in: textView) else {
        upper = middle
        continue
      }
      if rect.maxY < visible.minY { lower = middle + 1 }
      else { upper = middle }
    }
    return min(lower, max(0, lineStarts.count - 1))
  }

  private func textRect(forUTF16Offset offset: Int, in textView: NSTextView) -> NSRect? {
    guard let layoutManager = textView.textLayoutManager,
          let contentManager = layoutManager.textContentManager,
          let start = contentManager.location(
            contentManager.documentRange.location,
            offsetBy: offset
          )
    else { return nil }
    let textLength = (textView.string as NSString).length
    let endOffset = min(textLength, offset + 1)
    guard let end = contentManager.location(
      contentManager.documentRange.location,
      offsetBy: endOffset
    ), let range = NSTextRange(location: start, end: end) else { return nil }

    var result: NSRect?
    let options: NSTextLayoutManager.SegmentOptions = endOffset == offset
      ? [.rangeNotRequired, .upstreamAffinity]
      : [.rangeNotRequired]
    layoutManager.enumerateTextSegments(
      in: range,
      type: .standard,
      options: options
    ) { _, frame, _, _ in
      result = frame
      return false
    }
    guard let result else { return nil }
    return NSRect(
      x: result.minX,
      y: result.minY + textView.textContainerInset.height,
      width: result.width,
      height: max(
        result.height,
        ceil(
          NativeCodeSyntax.baseFont.ascender
            - NativeCodeSyntax.baseFont.descender
            + NativeCodeSyntax.baseFont.leading
        )
      )
    )
  }
}

enum NativeCodeSyntax {
  static let maximumHighlightedBytes = 1_000_000
  static let baseFont = NSFont.monospacedSystemFont(ofSize: 13, weight: .regular)
  enum Kind {
    case comment
    case string
    case keyword
    case number
    case heading
    case type
    case callable
    case property
    case diffAddition
    case diffDeletion
    case diffHunk
    case diffHeader

    var color: NSColor {
      switch self {
      case .comment: return .secondaryLabelColor
      case .string: return NativeCodeSyntax.tempered(.systemGreen)
      case .keyword: return NativeCodeSyntax.tempered(.systemRed)
      case .number: return NativeCodeSyntax.tempered(.systemOrange)
      case .heading: return NativeCodeSyntax.tempered(.systemBlue)
      case .type: return NativeCodeSyntax.tempered(.systemOrange)
      case .callable: return NativeCodeSyntax.tempered(.systemPurple)
      case .property: return NativeCodeSyntax.tempered(.systemTeal)
      case .diffAddition: return NativeCodeSyntax.tempered(.systemGreen)
      case .diffDeletion: return NativeCodeSyntax.tempered(.systemRed)
      case .diffHunk: return NativeCodeSyntax.tempered(.systemCyan)
      case .diffHeader: return .secondaryLabelColor
      }
    }

    var backgroundColor: NSColor? {
      switch self {
      case .diffAddition: return .systemGreen.withAlphaComponent(0.10)
      case .diffDeletion: return .systemRed.withAlphaComponent(0.10)
      default: return nil
      }
    }
  }

  struct Span {
    let range: NSRange
    let kind: Kind
  }

  static func spans(
    in text: String,
    fileExtension: String?,
    presentation: NativeCodeEditorPresentation
  ) -> [Span] {
    let range = NSRange(location: 0, length: (text as NSString).length)
    guard range.length > 0 else { return [] }
    var values: [Span] = []
    let ext = fileExtension ?? ""

    if presentation == .unifiedDiff {
      append(
        pattern: "(?m)^\\+(?!\\+\\+).*(?:\\n|$)",
        kind: .diffAddition,
        text: text,
        range: range,
        to: &values
      )
      append(
        pattern: "(?m)^-(?!--).*(?:\\n|$)",
        kind: .diffDeletion,
        text: text,
        range: range,
        to: &values
      )
      append(
        pattern: "(?m)^@@.*(?:\\n|$)",
        kind: .diffHunk,
        text: text,
        range: range,
        to: &values
      )
      append(
        pattern: "(?m)^(?:diff --git|index |--- |\\+\\+\\+ ).*(?:\\n|$)",
        kind: .diffHeader,
        text: text,
        range: range,
        to: &values
      )
      return values
    }

    if ["md", "markdown"].contains(ext) {
      append(pattern: "(?m)^#{1,6}\\s+.*$", kind: .heading, text: text, range: range, to: &values)
      append(
        pattern: "(?<!`)`[^`\\r\\n]+`(?!`)",
        kind: .callable,
        text: text,
        range: range,
        to: &values
      )
      append(pattern: "(?m)^>.*$", kind: .comment, text: text, range: range, to: &values)
      return values
    }

    if ["json", "jsonc"].contains(ext) {
      append(pattern: "\"(?:\\\\.|[^\"\\\\])*\"", kind: .string, text: text, range: range, to: &values)
      append(pattern: "\"(?:\\\\.|[^\"\\\\])*\"(?=\\s*:)", kind: .property, text: text, range: range, to: &values)
      append(pattern: "\\b(?:true|false|null)\\b", kind: .keyword, text: text, range: range, to: &values)
      append(pattern: "\\b(?:-?0x[0-9A-Fa-f]+|-?\\d+(?:\\.\\d+)?)\\b", kind: .number, text: text, range: range, to: &values)
      append(pattern: "(?s)/\\*.*?\\*/|(?m)//.*$", kind: .comment, text: text, range: range, to: &values)
      return values
    }

    if ["yaml", "yml"].contains(ext) {
      append(pattern: "\"(?:\\\\.|[^\"\\\\])*\"|'(?:''|[^'])*'", kind: .string, text: text, range: range, to: &values)
      append(pattern: "(?m)^\\s*[A-Za-z_][A-Za-z0-9_.-]*(?=\\s*:)", kind: .property, text: text, range: range, to: &values)
      append(pattern: "\\b(?:true|false|null|yes|no|on|off)\\b", kind: .keyword, text: text, range: range, to: &values)
      append(pattern: "\\b(?:-?0x[0-9A-Fa-f]+|-?\\d+(?:\\.\\d+)?)\\b", kind: .number, text: text, range: range, to: &values)
      append(pattern: "(?m)#.*$", kind: .comment, text: text, range: range, to: &values)
      return values
    }

    append(pattern: "\"(?:\\\\.|[^\"\\\\])*\"|'(?:\\\\.|[^'\\\\])*'", kind: .string, text: text, range: range, to: &values)
    append(pattern: "\\b(?:true|false|null|nil|let|var|func|struct|class|enum|protocol|extension|public|private|internal|fileprivate|open|static|import|return|if|else|switch|case|guard|for|while|async|await|throws|throw|try|catch|const|function|interface|type|export|from|new|this|in|where|some|any)\\b", kind: .keyword, text: text, range: range, to: &values)
    append(pattern: "\\b[A-Z][A-Za-z0-9_]*\\b", kind: .type, text: text, range: range, to: &values)
    append(pattern: "\\b[A-Za-z_][A-Za-z0-9_]*(?=\\s*\\()", kind: .callable, text: text, range: range, to: &values)
    append(pattern: "\\b(?:0x[0-9A-Fa-f]+|\\d+(?:\\.\\d+)?)\\b", kind: .number, text: text, range: range, to: &values)
    append(pattern: "(?s)/\\*.*?\\*/|(?m)//.*$|(?m)#(?![A-Za-z0-9_]).*$", kind: .comment, text: text, range: range, to: &values)
    return values
  }

  private static func tempered(_ accent: NSColor) -> NSColor {
    accent.blended(withFraction: 0.18, of: .labelColor) ?? accent
  }

  private static func append(
    pattern: String,
    kind: Kind,
    text: String,
    range: NSRange,
    to values: inout [Span]
  ) {
    guard let expression = try? NSRegularExpression(pattern: pattern) else { return }
    for match in expression.matches(in: text, range: range) {
      values.append(Span(range: match.range, kind: kind))
    }
  }
}
