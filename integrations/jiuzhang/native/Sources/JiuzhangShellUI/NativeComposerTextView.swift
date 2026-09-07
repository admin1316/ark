import AppKit
import JiuzhangShellCore
import SwiftUI

private func focusComposerIfNeeded(_ editor: NSTextView) {
  guard let window = editor.window,
        window.isKeyWindow,
        window.firstResponder !== editor
  else { return }
  window.makeFirstResponder(editor)
}

private func focusSearchIfNeeded(_ field: NSSearchField) {
  guard let window = field.window, window.isKeyWindow else { return }
  if window.firstResponder === field { return }
  if let fieldEditor = field.currentEditor(), window.firstResponder === fieldEditor { return }
  window.makeFirstResponder(field)
}

/// Native multiline composer with the old Ark submission contract:
/// Enter submits, Shift+Enter inserts a newline, and Command+Enter submits
/// using the alternate busy-session delivery mode. Marked-text/IME events and
/// repeated Return presses never submit accidentally.
struct NativeComposerTextView: NSViewRepresentable {
  let text: String
  let references: [ArkComposerReferenceOccurrence]
  @Binding var isComposing: Bool
  let focusRevision: Int
  let requestedCaret: Int?
  let textChanged: (String, Int, Bool) -> Void
  let selectionChanged: (Int, Bool) -> Void
  let handleMenuKey: (ArkComposerMenuKey, Bool) -> Bool
  let moveFocus: (NativeComposerFocusAction) -> Void
  let referenceDeletionRange: (Int, Bool) -> NSRange?
  let submit: () -> Void
  let submitAlternate: () -> Void
  let pasteImage: (Data, ArkImageMediaType) -> Void
  let pasteDocument: (String) -> Void
  let addAttachmentURLs: ([URL]) -> Void

  func makeCoordinator() -> Coordinator {
    Coordinator(
      isComposing: $isComposing,
      focusRevision: focusRevision,
      textChanged: textChanged,
      selectionChanged: selectionChanged
    )
  }

  func makeNSView(context: Context) -> NSScrollView {
    let scroll = NSScrollView()
    scroll.drawsBackground = false
    scroll.hasVerticalScroller = true
    scroll.autohidesScrollers = true
    scroll.borderType = .noBorder

    let editor = ComposerNSTextView()
    editor.isRichText = false
    editor.allowsUndo = true
    editor.isAutomaticQuoteSubstitutionEnabled = false
    editor.isAutomaticDashSubstitutionEnabled = false
    editor.isAutomaticTextReplacementEnabled = false
    editor.font = .systemFont(ofSize: 14)
    editor.textColor = .labelColor
    editor.backgroundColor = .clear
    editor.textContainerInset = NSSize(width: 8, height: 8)
    editor.isVerticallyResizable = true
    editor.isHorizontallyResizable = false
    editor.autoresizingMask = [.width]
    editor.textContainer?.widthTracksTextView = true
    editor.string = text
    context.coordinator.applyReferenceStylesIfNeeded(
      to: editor,
      text: text,
      references: references
    )
    editor.onSubmit = submit
    editor.onSubmitAlternate = submitAlternate
    editor.onMenuKey = handleMenuKey
    editor.onFocusMove = moveFocus
    editor.onReferenceDeletionRange = referenceDeletionRange
    editor.onPasteImage = pasteImage
    editor.onPasteDocument = pasteDocument
    editor.onAddAttachmentURLs = addAttachmentURLs
    editor.onCompositionChanged = context.coordinator.setComposition
    editor.registerForDraggedTypes([.fileURL])
    scroll.documentView = editor
    context.coordinator.editor = editor
    // Initial text/storage installation emits AppKit text and selection
    // notifications. Attach the delegate only after that synchronous setup so
    // SwiftUI's makeNSView pass never publishes model changes from inside its
    // own view update transaction.
    editor.delegate = context.coordinator
    DispatchQueue.main.async { [weak editor] in
      if let editor { focusComposerIfNeeded(editor) }
    }
    return scroll
  }

  func updateNSView(_ scroll: NSScrollView, context: Context) {
    guard let editor = scroll.documentView as? ComposerNSTextView else { return }
    context.coordinator.textChanged = textChanged
    context.coordinator.selectionChanged = selectionChanged
    editor.onSubmit = submit
    editor.onSubmitAlternate = submitAlternate
    editor.onMenuKey = handleMenuKey
    editor.onFocusMove = moveFocus
    editor.onReferenceDeletionRange = referenceDeletionRange
    editor.onPasteImage = pasteImage
    editor.onPasteDocument = pasteDocument
    editor.onAddAttachmentURLs = addAttachmentURLs
    editor.onCompositionChanged = context.coordinator.setComposition
    let focusChanged = context.coordinator.focusRevision != focusRevision
    if focusChanged {
      context.coordinator.focusRevision = focusRevision
    }
    // IME owns marked text until composition commits. Replacing editor.string
    // from the SwiftUI binding during that window erases the visible first
    // composing glyph while leaving the candidate panel alive.
    context.coordinator.performProgrammaticUpdate {
      if !editor.hasMarkedText(), editor.string != text {
        let range = editor.selectedRange()
        editor.string = text
        let requested = focusChanged ? requestedCaret : nil
        editor.setSelectedRange(NSRange(
          location: min(requested ?? range.location, text.utf16.count),
          length: 0
        ))
      } else if focusChanged, let requestedCaret {
        editor.setSelectedRange(NSRange(
          location: min(requestedCaret, text.utf16.count),
          length: 0
        ))
      }
      if !editor.hasMarkedText() {
        context.coordinator.applyReferenceStylesIfNeeded(
          to: editor,
          text: text,
          references: references
        )
      }
    }
    if focusChanged {
      DispatchQueue.main.async { [weak editor] in
        if let editor { focusComposerIfNeeded(editor) }
      }
    }
  }

  final class Coordinator: NSObject, NSTextViewDelegate {
    private struct StyleFingerprint: Equatable {
      let text: String
      let references: [ArkComposerReferenceOccurrence]
      let fontName: String
      let fontSize: CGFloat
      let appearanceName: NSAppearance.Name
    }

    @Binding var isComposing: Bool
    weak var editor: NSTextView?
    var focusRevision: Int
    var textChanged: (String, Int, Bool) -> Void
    var selectionChanged: (Int, Bool) -> Void
    private var applyingProgrammaticUpdate = false
    private var styleFingerprint: StyleFingerprint?

    init(
      isComposing: Binding<Bool>,
      focusRevision: Int,
      textChanged: @escaping (String, Int, Bool) -> Void,
      selectionChanged: @escaping (Int, Bool) -> Void
    ) {
      _isComposing = isComposing
      self.focusRevision = focusRevision
      self.textChanged = textChanged
      self.selectionChanged = selectionChanged
    }

    func applyReferenceStylesIfNeeded(
      to editor: NSTextView,
      text: String,
      references: [ArkComposerReferenceOccurrence]
    ) {
      guard let storage = editor.textStorage else { return }
      let font = editor.font ?? NSFont.systemFont(ofSize: 14)
      let fingerprint = StyleFingerprint(
        text: text,
        references: references,
        fontName: font.fontName,
        fontSize: font.pointSize,
        appearanceName: editor.effectiveAppearance.name
      )
      guard styleFingerprint != fingerprint else { return }
      styleFingerprint = fingerprint

      let full = NSRange(location: 0, length: storage.length)
      storage.addAttributes([
        .foregroundColor: NSColor.labelColor,
        .font: NSFont.systemFont(ofSize: 14),
      ], range: full)
      for reference in references {
        let range = NSRange(location: reference.offset, length: reference.length)
        guard range.location >= 0, range.location + range.length <= storage.length else { continue }
        storage.addAttributes([
          .foregroundColor: NSColor.controlAccentColor,
          .font: NSFont.systemFont(ofSize: 14, weight: .medium),
        ], range: range)
      }
    }

    func textDidChange(_ notification: Notification) {
      guard !applyingProgrammaticUpdate,
        let editor = notification.object as? NSTextView
      else { return }
      let composing = editor.hasMarkedText()
      setComposition(composing)
      guard !composing else { return }
      textChanged(editor.string, editor.selectedRange().location, false)
    }

    func textViewDidChangeSelection(_ notification: Notification) {
      guard !applyingProgrammaticUpdate,
        let editor = notification.object as? NSTextView
      else { return }
      selectionChanged(editor.selectedRange().location, editor.hasMarkedText())
    }

    func setComposition(_ value: Bool) {
      guard !applyingProgrammaticUpdate, isComposing != value else { return }
      isComposing = value
    }

    func performProgrammaticUpdate(_ update: () -> Void) {
      let wasApplying = applyingProgrammaticUpdate
      applyingProgrammaticUpdate = true
      defer { applyingProgrammaticUpdate = wasApplying }
      update()
    }
  }
}

/// Single-line Native search owner for the plus launcher's file/session pages.
/// It moves first responder away from the message composer and routes the same
/// Up/Down/Enter/Escape contract, so search text never leaks into the draft.
struct NativeComposerSearchField: NSViewRepresentable {
  let text: String
  let placeholder: String
  let focusRevision: Int
  let textChanged: (String) -> Void
  let handleMenuKey: (ArkComposerMenuKey) -> Bool

  func makeCoordinator() -> Coordinator {
    Coordinator(
      focusRevision: focusRevision,
      textChanged: textChanged
    )
  }

  func makeNSView(context: Context) -> ComposerNSSearchField {
    let field = ComposerNSSearchField()
    field.stringValue = text
    field.placeholderString = placeholder
    field.font = .systemFont(ofSize: 12)
    field.focusRingType = .none
    field.sendsSearchStringImmediately = true
    field.delegate = context.coordinator
    field.onMenuKey = handleMenuKey
    context.coordinator.field = field
    DispatchQueue.main.async { [weak field] in
      if let field { focusSearchIfNeeded(field) }
    }
    return field
  }

  func updateNSView(_ field: ComposerNSSearchField, context: Context) {
    context.coordinator.textChanged = textChanged
    field.onMenuKey = handleMenuKey
    field.placeholderString = placeholder
    if field.stringValue != text { field.stringValue = text }
    if context.coordinator.focusRevision != focusRevision {
      context.coordinator.focusRevision = focusRevision
      DispatchQueue.main.async { [weak field] in
        if let field { focusSearchIfNeeded(field) }
      }
    }
  }

  final class Coordinator: NSObject, NSSearchFieldDelegate {
    weak var field: NSSearchField?
    var focusRevision: Int
    var textChanged: (String) -> Void

    init(focusRevision: Int, textChanged: @escaping (String) -> Void) {
      self.focusRevision = focusRevision
      self.textChanged = textChanged
    }

    func controlTextDidChange(_ notification: Notification) {
      guard let field = notification.object as? NSSearchField else { return }
      textChanged(field.stringValue)
    }
  }
}

final class ComposerNSSearchField: NSSearchField {
  var onMenuKey: ((ArkComposerMenuKey) -> Bool)?

  override func keyDown(with event: NSEvent) {
    let composing = (currentEditor() as? NSTextView)?.hasMarkedText() == true
    if !composing,
       let menuKey = ArkComposerMenuKey(nativeKeyCode: event.keyCode),
       onMenuKey?(menuKey) == true
    {
      return
    }
    super.keyDown(with: event)
  }
}

private extension ArkComposerMenuKey {
  init?(nativeKeyCode: UInt16) {
    switch nativeKeyCode {
    case 126: self = .up
    case 125: self = .down
    case 53: self = .escape
    case 36, 76: self = .enter
    default: return nil
    }
  }
}

enum NativeComposerSubmitAction: Equatable {
  case appKit
  case submit
  case submitAlternate

  static func resolve(
    keyCode: UInt16,
    modifierFlags: NSEvent.ModifierFlags,
    isRepeat: Bool,
    hasMarkedText: Bool
  ) -> NativeComposerSubmitAction {
    let isReturn = keyCode == 36 || keyCode == 76
    guard isReturn, !hasMarkedText, !isRepeat,
      !modifierFlags.contains(.shift)
    else { return .appKit }
    return modifierFlags.contains(.command) ? .submitAlternate : .submit
  }
}

enum NativeComposerFocusAction: Equatable {
  case appKit
  case next
  case previous

  static func resolve(
    keyCode: UInt16,
    modifierFlags: NSEvent.ModifierFlags,
    hasMarkedText: Bool
  ) -> NativeComposerFocusAction {
    guard keyCode == 48, !hasMarkedText else { return .appKit }
    let traversalModifiers = modifierFlags.intersection([.shift, .control, .option, .command])
    if traversalModifiers.isEmpty { return .next }
    if traversalModifiers == .shift { return .previous }
    return .appKit
  }
}

final class ComposerNSTextView: NSTextView {
  var onSubmit: (() -> Void)?
  var onSubmitAlternate: (() -> Void)?
  var onMenuKey: ((ArkComposerMenuKey, Bool) -> Bool)?
  var onFocusMove: ((NativeComposerFocusAction) -> Void)?
  var onReferenceDeletionRange: ((Int, Bool) -> NSRange?)?
  var onPasteImage: ((Data, ArkImageMediaType) -> Void)?
  var onPasteDocument: ((String) -> Void)?
  var onAddAttachmentURLs: (([URL]) -> Void)?
  var onCompositionChanged: ((Bool) -> Void)?

  override func setMarkedText(
    _ string: Any,
    selectedRange: NSRange,
    replacementRange: NSRange
  ) {
    super.setMarkedText(
      string,
      selectedRange: selectedRange,
      replacementRange: replacementRange
    )
    onCompositionChanged?(hasMarkedText())
    needsDisplay = true
  }

  override func unmarkText() {
    super.unmarkText()
    onCompositionChanged?(false)
  }

  override func resignFirstResponder() -> Bool {
    let result = super.resignFirstResponder()
    if result { onCompositionChanged?(false) }
    return result
  }

  override func paste(_ sender: Any?) {
    let pasteboard = NSPasteboard.general
    let urls = attachmentFileURLs(in: pasteboard)
    if !urls.isEmpty {
      onAddAttachmentURLs?(urls)
      return
    }
    if let data = pasteboard.data(forType: .png) {
      onPasteImage?(data, .png)
      return
    }
    if let tiff = pasteboard.data(forType: .tiff),
       let bitmap = NSBitmapImageRep(data: tiff),
       let png = bitmap.representation(using: .png, properties: [:]) {
      onPasteImage?(png, .png)
      return
    }
    if let text = pasteboard.string(forType: .string),
       text.utf8.count >= ArkDocumentReferenceStore.longPasteThreshold
    {
      onPasteDocument?(text)
      return
    }
    super.paste(sender)
  }

  override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
    attachmentFileURLs(in: sender.draggingPasteboard).isEmpty ? [] : .copy
  }

  override func prepareForDragOperation(_ sender: NSDraggingInfo) -> Bool {
    !attachmentFileURLs(in: sender.draggingPasteboard).isEmpty
  }

  override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
    let urls = attachmentFileURLs(in: sender.draggingPasteboard)
    guard !urls.isEmpty else { return false }
    onAddAttachmentURLs?(urls)
    return true
  }

  private func attachmentFileURLs(in pasteboard: NSPasteboard) -> [URL] {
    let allowed = Set([
      "png", "jpg", "jpeg", "webp", "gif",
      "doc", "docx", "odt", "rtf", "txt", "md", "markdown",
    ])
    return (pasteboard.readObjects(
      forClasses: [NSURL.self],
      options: [.urlReadingFileURLsOnly: true]
    ) as? [URL] ?? [])
      .filter { allowed.contains($0.pathExtension.lowercased()) }
  }

  override func keyDown(with event: NSEvent) {
    let composing = hasMarkedText()
    let menuKey = ArkComposerMenuKey(nativeKeyCode: event.keyCode)
    if let menuKey, onMenuKey?(menuKey, composing) == true { return }

    switch NativeComposerFocusAction.resolve(
      keyCode: event.keyCode,
      modifierFlags: event.modifierFlags,
      hasMarkedText: composing
    ) {
    case .next:
      if !moveKeyboardFocus(backward: false) { onFocusMove?(.next) }
      return
    case .previous:
      if !moveKeyboardFocus(backward: true) { onFocusMove?(.previous) }
      return
    case .appKit:
      break
    }

    let backwardDelete = event.keyCode == 51
    let forwardDelete = event.keyCode == 117
    if !composing,
       (backwardDelete || forwardDelete),
       selectedRange().length == 0,
       let range = onReferenceDeletionRange?(
        selectedRange().location,
        backwardDelete
       ),
       shouldChangeText(in: range, replacementString: "")
    {
      textStorage?.replaceCharacters(in: range, with: "")
      didChangeText()
      setSelectedRange(NSRange(location: range.location, length: 0))
      return
    }

    switch NativeComposerSubmitAction.resolve(
      keyCode: event.keyCode,
      modifierFlags: event.modifierFlags,
      isRepeat: event.isARepeat,
      hasMarkedText: composing
    ) {
    case .appKit:
      super.keyDown(with: event)
    case .submitAlternate:
      onSubmitAlternate?()
    case .submit:
      onSubmit?()
    }
  }

  private func moveKeyboardFocus(backward: Bool) -> Bool {
    guard let window else { return false }
    let destination = backward ? previousValidKeyView : nextValidKeyView
    guard let destination, destination !== self else { return false }
    return window.makeFirstResponder(destination)
  }
}
