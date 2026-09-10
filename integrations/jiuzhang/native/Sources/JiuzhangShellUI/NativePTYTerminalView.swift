import AppKit
import Darwin
import SwiftUI

struct NativeTerminalOutputBatch: Equatable, Sendable {
  let text: String
  let droppedBytes: Int
  let resetsANSIState: Bool
}

final class NativeTerminalOutputInbox: @unchecked Sendable {
  private enum TokenKind {
    case ansi
    case text
  }

  private struct Token {
    let kind: TokenKind
    var data: Data
  }

  private let lock = NSLock()
  private let byteLimit: Int
  private var tokens: [Token] = []
  private var head = 0
  private var pendingBytes = 0
  private var droppedBytes = 0
  private var pendingUTF8 = Data()
  private var expectedUTF8Length = 0
  private var pendingANSI = Data()
  private var resetsANSIState = false
  private var flushScheduled = false

  init(byteLimit: Int = 1_048_576) {
    precondition(byteLimit > 0)
    self.byteLimit = byteLimit
  }

  func enqueue(_ value: Data) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    guard !value.isEmpty else { return false }
    for byte in value { consume(byte) }
    trimToLimit()
    guard pendingBytes > 0 || droppedBytes > 0 else { return false }
    guard !flushScheduled else { return false }
    flushScheduled = true
    return true
  }

  func drain(finalizing: Bool = false) -> NativeTerminalOutputBatch {
    lock.lock()
    defer { lock.unlock() }
    if finalizing { finalizeIncompleteInput() }
    var data = Data()
    data.reserveCapacity(pendingBytes)
    for token in tokens[head...] { data.append(token.data) }
    let batch = NativeTerminalOutputBatch(
      text: String(decoding: data, as: UTF8.self),
      droppedBytes: droppedBytes,
      resetsANSIState: resetsANSIState
    )
    tokens.removeAll(keepingCapacity: true)
    head = 0
    pendingBytes = 0
    droppedBytes = 0
    resetsANSIState = false
    flushScheduled = false
    return batch
  }

  func clear() {
    lock.lock()
    tokens.removeAll(keepingCapacity: true)
    head = 0
    pendingBytes = 0
    droppedBytes = 0
    pendingUTF8.removeAll(keepingCapacity: true)
    expectedUTF8Length = 0
    pendingANSI.removeAll(keepingCapacity: true)
    resetsANSIState = false
    flushScheduled = false
    lock.unlock()
  }

  var bufferedByteCount: Int {
    lock.lock()
    defer { lock.unlock() }
    return pendingBytes
  }

  private func trimToLimit() {
    while pendingBytes > byteLimit, head < tokens.count {
      let overflow = pendingBytes - byteLimit
      let token = tokens[head]
      if token.kind == .ansi || token.data.count <= overflow {
        pendingBytes -= token.data.count
        droppedBytes += token.data.count
        head += 1
      } else {
        let safeDrop = safeUTF8PrefixLength(atLeast: overflow, in: token.data)
        tokens[head].data = Data(token.data.dropFirst(safeDrop))
        pendingBytes -= safeDrop
        droppedBytes += safeDrop
      }
      resetsANSIState = true
    }
    if head > 64, head * 2 >= tokens.count {
      tokens.removeFirst(head)
      head = 0
    }
  }

  private func consume(_ byte: UInt8) {
    if !pendingANSI.isEmpty {
      pendingANSI.append(byte)
      if pendingANSI.count >= 3, (0x40...0x7E).contains(byte) {
        appendToken(pendingANSI, kind: .ansi)
        pendingANSI.removeAll(keepingCapacity: true)
      } else if pendingANSI.count >= 256 {
        appendReplacementCharacter()
        pendingANSI.removeAll(keepingCapacity: true)
        resetsANSIState = true
      }
      return
    }

    if !pendingUTF8.isEmpty {
      if (0x80...0xBF).contains(byte) {
        pendingUTF8.append(byte)
        if pendingUTF8.count == expectedUTF8Length {
          appendCompletedUTF8Scalar()
        }
      } else {
        appendReplacementCharacter()
        pendingUTF8.removeAll(keepingCapacity: true)
        expectedUTF8Length = 0
        consume(byte)
      }
      return
    }

    if byte == 0x1B {
      pendingANSI.append(byte)
      return
    }
    if byte < 0x80 {
      appendToken(Data([byte]), kind: .text)
      return
    }
    if (0xC2...0xDF).contains(byte) {
      pendingUTF8.append(byte)
      expectedUTF8Length = 2
    } else if (0xE0...0xEF).contains(byte) {
      pendingUTF8.append(byte)
      expectedUTF8Length = 3
    } else if (0xF0...0xF4).contains(byte) {
      pendingUTF8.append(byte)
      expectedUTF8Length = 4
    } else {
      appendReplacementCharacter()
    }
  }

  private func appendCompletedUTF8Scalar() {
    defer {
      pendingUTF8.removeAll(keepingCapacity: true)
      expectedUTF8Length = 0
    }
    guard String(data: pendingUTF8, encoding: .utf8) != nil else {
      appendReplacementCharacter()
      return
    }
    appendToken(pendingUTF8, kind: .text)
  }

  private func appendReplacementCharacter() {
    appendToken(Data("\u{FFFD}".utf8), kind: .text)
  }

  private func appendToken(_ data: Data, kind: TokenKind) {
    guard !data.isEmpty else { return }
    if kind == .text, head < tokens.count, tokens[tokens.count - 1].kind == .text {
      tokens[tokens.count - 1].data.append(data)
    } else {
      tokens.append(Token(kind: kind, data: data))
    }
    pendingBytes += data.count
  }

  private func finalizeIncompleteInput() {
    if !pendingUTF8.isEmpty {
      appendReplacementCharacter()
      pendingUTF8.removeAll(keepingCapacity: true)
      expectedUTF8Length = 0
    }
    if !pendingANSI.isEmpty {
      appendReplacementCharacter()
      pendingANSI.removeAll(keepingCapacity: true)
      resetsANSIState = true
    }
    trimToLimit()
  }

  private func safeUTF8PrefixLength(atLeast minimum: Int, in data: Data) -> Int {
    var boundary = min(minimum, data.count)
    while boundary < data.count, (data[boundary] & 0xC0) == 0x80 { boundary += 1 }
    return boundary
  }
}

@MainActor
final class NativePTYTerminalSession: ObservableObject {
  let rootURL: URL

  @Published private(set) var output = ""
  @Published private(set) var isRunning = false
  @Published private(set) var terminationStatus: Int32?
  @Published private(set) var termination: NativePTYTermination?
  @Published private(set) var errorMessage: String?

  var processIdentifier: pid_t? { processOwner?.processID }
  var processGroupIdentifier: pid_t? { processOwner?.processGroupID }
  var processSessionIdentifier: pid_t? { processOwner?.sessionID }

  private var processOwner: NativePTYProcessOwner?
  private var masterHandle: FileHandle?
  private var masterDescriptor: Int32 = -1
  private var started = false
  private let helperExecutable: URL?
  private let baseEnvironment: [String: String]
  private let outputLimit = 1_048_576
  private let outputInbox = NativeTerminalOutputInbox()
  private let publishIntervalNanoseconds: UInt64 = 33_000_000

  init(
    rootURL: URL,
    helperExecutable: URL? = Bundle.main.executableURL,
    baseEnvironment: [String: String] = ProcessInfo.processInfo.environment
  ) {
    self.rootURL = rootURL.standardizedFileURL
    self.helperExecutable = helperExecutable
    self.baseEnvironment = baseEnvironment
  }

  deinit {
    processOwner?.shutdownDetached()
  }

  func startIfNeeded() {
    guard !started else { return }
    started = true
    guard let helperExecutable else {
      errorMessage = NativePTYProcessError.helperUnavailable.localizedDescription
      return
    }
    do {
      let spawned = try NativePTYProcessSpawner.spawn(
        helperExecutable: helperExecutable,
        rootURL: rootURL,
        baseEnvironment: baseEnvironment
      )
      let masterHandle = FileHandle(
        fileDescriptor: spawned.masterDescriptor,
        closeOnDealloc: true
      )
      installReadHandler(on: masterHandle)
      let processOwner = NativePTYProcessOwner(
        process: spawned,
        willShutdown: { [weak self] in self?.prepareForShutdown() },
        didTerminate: { [weak self] termination in self?.finishTermination(termination) }
      )
      self.processOwner = processOwner
      self.masterHandle = masterHandle
      masterDescriptor = spawned.masterDescriptor
      isRunning = true
      terminationStatus = nil
      termination = nil
      errorMessage = nil
      processOwner.startMonitoring()
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  func send(_ value: String) {
    startIfNeeded()
    guard isRunning, let masterHandle else { return }
    do {
      try masterHandle.write(contentsOf: Data(value.utf8))
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  func sendCommand(_ command: String) {
    let value = command.trimmingCharacters(in: .newlines)
    guard !value.isEmpty else { return }
    send(value + "\n")
  }

  func sendControlC() {
    send(String(UnicodeScalar(3)))
  }

  func resize(columns: Int, rows: Int) {
    guard masterDescriptor >= 0 else { return }
    var size = winsize(
      ws_row: UInt16(max(2, min(rows, Int(UInt16.max)))),
      ws_col: UInt16(max(2, min(columns, Int(UInt16.max)))),
      ws_xpixel: 0,
      ws_ypixel: 0
    )
    _ = withUnsafeMutablePointer(to: &size) { pointer in
      Darwin.ioctl(masterDescriptor, TIOCSWINSZ, pointer)
    }
  }

  func clear() {
    outputInbox.clear()
    output = ""
  }

  func terminate() {
    Task { [weak self] in _ = await self?.shutdown() }
  }

  @discardableResult
  func shutdown() async -> NativePTYTermination? {
    guard let processOwner else {
      prepareForShutdown()
      isRunning = false
      return termination
    }
    return await processOwner.shutdown()
  }

  private func appendOutput(_ value: String) {
    output += value
    if output.utf8.count > outputLimit {
      let limiter = NativeTerminalOutputInbox(byteLimit: outputLimit / 2)
      _ = limiter.enqueue(Data(output.utf8))
      let suffix = limiter.drain(finalizing: true)
      output = "… earlier terminal output truncated …\n"
        + (suffix.resetsANSIState ? "\u{001B}[0m" : "")
        + suffix.text
    }
  }

  private func flushOutputInbox(finalizing: Bool = false) {
    let batch = outputInbox.drain(finalizing: finalizing)
    guard !batch.text.isEmpty || batch.droppedBytes > 0 else { return }
    let reset = batch.resetsANSIState ? "\u{001B}[0m" : ""
    let dropped = batch.droppedBytes > 0
      ? "… terminal output dropped before display (\(batch.droppedBytes) bytes) …\n"
      : ""
    appendOutput(reset + dropped + batch.text)
  }

  private func installReadHandler(on masterHandle: FileHandle) {
    let outputInbox = outputInbox
    masterHandle.readabilityHandler = { [weak self, outputInbox] handle in
      let data = handle.availableData
      guard !data.isEmpty else { return }
      guard outputInbox.enqueue(data) else { return }
      Task { @MainActor [weak self] in
        guard let self else { return }
        try? await Task.sleep(nanoseconds: self.publishIntervalNanoseconds)
        self.flushOutputInbox()
      }
    }
  }

  private func prepareForShutdown() {
    flushOutputInbox(finalizing: true)
    masterHandle?.readabilityHandler = nil
    masterHandle?.closeFile()
    masterHandle = nil
    masterDescriptor = -1
  }

  private func finishTermination(_ termination: NativePTYTermination) {
    guard processOwner?.processID == termination.processID else { return }
    prepareForShutdown()
    processOwner = nil
    isRunning = false
    self.termination = termination
    terminationStatus = termination.displayStatus
    if !termination.sessionDrained {
      errorMessage = "Terminal session 未能在时限内完全退出"
    }
  }
}

struct NativePTYTerminalView: View {
  @ObservedObject var session: NativePTYTerminalSession
  let language: ArkLanguagePreference
  @State private var input = ""

  var body: some View {
    GeometryReader { geometry in
      VStack(spacing: 0) {
        HStack(spacing: 10) {
          Label(ArkL10n.text(.filesTerminalTitle, language), systemImage: "terminal")
            .font(.system(size: 12, weight: .semibold))
          Text(session.rootURL.path)
            .font(.system(size: 10, design: .monospaced))
            .foregroundStyle(Color.secondary)
            .lineLimit(1)
            .truncationMode(.middle)
          Spacer()
          Button("⌃C", action: session.sendControlC)
            .buttonStyle(.borderless)
            .disabled(!session.isRunning)
          if session.isRunning {
            Button(action: session.terminate) {
              Label(ArkL10n.text(.filesTerminalStop, language), systemImage: "stop.fill")
            }
            .buttonStyle(.borderless)
            .foregroundStyle(Color.red)
          }
          Button(action: session.clear) {
            Label(ArkL10n.text(.filesTerminalClear, language), systemImage: "trash")
          }
          .buttonStyle(.borderless)
          .disabled(session.output.isEmpty)
        }
        .padding(.horizontal, 12)
        .frame(height: 42)
        .background(Color(nsColor: .controlBackgroundColor))
        Divider()

        NativeTerminalOutputView(text: session.output)
          .frame(maxWidth: .infinity, maxHeight: .infinity)

        Divider()
        HStack(spacing: 8) {
          Image(systemName: "chevron.right")
            .font(.system(size: 11, weight: .bold, design: .monospaced))
            .foregroundStyle(Color.green)
          TextField(ArkL10n.text(.filesTerminalPlaceholder, language), text: $input)
            .textFieldStyle(.plain)
            .font(.system(size: 12, design: .monospaced))
            .onSubmit(sendInput)
          Button(action: sendInput) {
            Image(systemName: "arrow.up.circle.fill")
              .font(.system(size: 18))
          }
          .buttonStyle(.plain)
          .disabled(input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .padding(.horizontal, 12)
        .frame(height: 42)
        .background(Color(nsColor: .controlBackgroundColor))
        if let error = session.errorMessage {
          Text(error)
            .font(.system(size: 10))
            .foregroundStyle(Color.red)
            .padding(.horizontal, 10)
            .frame(maxWidth: .infinity, minHeight: 24, alignment: .leading)
        } else if let status = session.terminationStatus, !session.isRunning {
          Text("exit \(status)")
            .font(.system(size: 10, design: .monospaced))
            .foregroundStyle(Color.secondary)
            .padding(.horizontal, 10)
            .frame(maxWidth: .infinity, minHeight: 24, alignment: .leading)
        }
      }
      .onAppear {
        session.startIfNeeded()
        resize(geometry.size)
      }
      .onChange(of: geometry.size) { resize($0) }
    }
    .accessibilityIdentifier("ark.workbench.pty-terminal")
  }

  private func sendInput() {
    let command = input
    input = ""
    session.sendCommand(command)
  }

  private func resize(_ size: CGSize) {
    let columns = max(20, Int((size.width - 24) / 8))
    let rows = max(4, Int((size.height - 86) / 18))
    session.resize(columns: columns, rows: rows)
  }
}

private struct NativeTerminalOutputView: NSViewRepresentable {
  let text: String

  func makeCoordinator() -> Coordinator { Coordinator() }

  func makeNSView(context: Context) -> NSScrollView {
    let scrollView = NSScrollView()
    let textView = NSTextView()
    scrollView.borderType = .noBorder
    scrollView.drawsBackground = true
    scrollView.backgroundColor = .textBackgroundColor
    scrollView.hasVerticalScroller = true
    scrollView.hasHorizontalScroller = true
    scrollView.autohidesScrollers = true
    scrollView.documentView = textView
    textView.isEditable = false
    textView.isSelectable = true
    textView.isRichText = true
    textView.drawsBackground = true
    textView.backgroundColor = .textBackgroundColor
    textView.textContainerInset = NSSize(width: 12, height: 10)
    textView.isHorizontallyResizable = true
    textView.isVerticallyResizable = true
    textView.autoresizingMask = []
    textView.maxSize = NSSize(
      width: CGFloat.greatestFiniteMagnitude,
      height: CGFloat.greatestFiniteMagnitude
    )
    textView.textContainer?.containerSize = NSSize(
      width: CGFloat.greatestFiniteMagnitude,
      height: CGFloat.greatestFiniteMagnitude
    )
    textView.textContainer?.widthTracksTextView = false
    context.coordinator.textView = textView
    context.coordinator.apply(text, scrollView: scrollView)
    return scrollView
  }

  func updateNSView(_ scrollView: NSScrollView, context: Context) {
    context.coordinator.apply(text, scrollView: scrollView)
  }

  final class Coordinator {
    weak var textView: NSTextView?
    private var lastText = ""
    private let parser = NativeANSIText.Parser()

    func apply(_ text: String, scrollView: NSScrollView) {
      guard text != lastText, let textView else { return }
      let clip = scrollView.contentView
      let documentHeight = textView.frame.height
      let sticksToBottom = clip.bounds.maxY >= documentHeight - 30
      let appendsToCurrentOutput = text.hasPrefix(lastText)
      let suffix = appendsToCurrentOutput
        ? String(text.dropFirst(lastText.count))
        : text

      let changedRange: NSRange?
      if !appendsToCurrentOutput {
        parser.reset()
        textView.textStorage?.setAttributedString(parser.attributed(suffix))
        changedRange = nil
      } else if !suffix.isEmpty {
        let attributed = parser.attributed(suffix)
        let location = textView.textStorage?.length ?? 0
        textView.textStorage?.append(attributed)
        changedRange = NSRange(location: location, length: attributed.length)
      } else {
        changedRange = NSRange(location: textView.textStorage?.length ?? 0, length: 0)
      }
      lastText = text
      updateDocumentSize(textView, in: scrollView, changedRange: changedRange)
      if sticksToBottom || documentHeight <= clip.bounds.height {
        textView.scrollToEndOfDocument(nil)
      }
    }

    private func updateDocumentSize(
      _ textView: NSTextView,
      in scrollView: NSScrollView,
      changedRange: NSRange?
    ) {
      guard
        let layoutManager = textView.layoutManager,
        let textContainer = textView.textContainer
      else { return }
      if let changedRange {
        guard changedRange.length > 0 else { return }
        layoutManager.ensureLayout(forCharacterRange: changedRange)
      } else {
        layoutManager.ensureLayout(for: textContainer)
      }
      let used = layoutManager.usedRect(for: textContainer)
      let inset = textView.textContainerInset
      textView.setFrameSize(
        NSSize(
          width: max(scrollView.contentSize.width, ceil(used.width + inset.width * 2)),
          height: max(scrollView.contentSize.height, ceil(used.height + inset.height * 2))
        )
      )
    }
  }
}

enum NativeANSIText {
  final class Parser {
    private var attributes = NativeANSIText.baseAttributes()
    private var pendingSequence = ""

    func reset() {
      attributes = NativeANSIText.baseAttributes()
      pendingSequence = ""
    }

    func attributed(_ raw: String) -> NSAttributedString {
      let normalized = (pendingSequence + raw)
        .replacingOccurrences(of: "\r\n", with: "\n")
        .replacingOccurrences(of: "\r", with: "\n")
      pendingSequence = ""
      let output = NSMutableAttributedString()
      var cursor = normalized.startIndex
      while cursor < normalized.endIndex {
        guard let escape = normalized[cursor...].range(of: "\u{001B}[") else {
          NativeANSIText.append(
            String(normalized[cursor...]),
            to: output,
            attributes: attributes
          )
          break
        }
        NativeANSIText.append(
          String(normalized[cursor..<escape.lowerBound]),
          to: output,
          attributes: attributes
        )
        guard let terminator = normalized[escape.upperBound...].firstIndex(where: {
          guard let scalar = $0.unicodeScalars.first?.value else { return false }
          return (0x40...0x7E).contains(scalar)
        }) else {
          pendingSequence = String(normalized[escape.lowerBound...])
          break
        }
        let payload = normalized[escape.upperBound..<terminator]
        if normalized[terminator] == "m",
           payload.allSatisfy({ $0.isNumber || $0 == ";" })
        {
          attributes = NativeANSIText.applySGR(String(payload), to: attributes)
        }
        cursor = normalized.index(after: terminator)
      }
      return output
    }
  }

  private static func append(
    _ text: String,
    to output: NSMutableAttributedString,
    attributes: [NSAttributedString.Key: Any]
  ) {
    let displayText = displayText(text)
    guard !displayText.isEmpty else { return }
    output.append(NSAttributedString(string: displayText, attributes: attributes))
  }

  private static func displayText(_ text: String) -> String {
    var output = ""
    for character in text {
      if character == "\u{0008}" {
        if !output.isEmpty { output.removeLast() }
        continue
      }
      if character == "\n" || character == "\t"
        || !character.unicodeScalars.allSatisfy({ $0.value < 0x20 || $0.value == 0x7F })
      {
        output.append(character)
      }
    }
    return output
  }

  private static func baseAttributes() -> [NSAttributedString.Key: Any] {
    [
      .font: NSFont.monospacedSystemFont(ofSize: 12, weight: .regular),
      .foregroundColor: NSColor.labelColor,
    ]
  }

  private static func applySGR(
    _ payload: String,
    to current: [NSAttributedString.Key: Any]
  ) -> [NSAttributedString.Key: Any] {
    var attributes = current
    let codes = payload.isEmpty ? [0] : payload.split(separator: ";").compactMap { Int($0) }
    for code in codes {
      switch code {
      case 0: attributes = baseAttributes()
      case 1: attributes[.font] = NSFont.monospacedSystemFont(ofSize: 12, weight: .bold)
      case 22: attributes[.font] = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
      case 30...37: attributes[.foregroundColor] = color(code - 30, bright: false)
      case 39: attributes[.foregroundColor] = NSColor.labelColor
      case 90...97: attributes[.foregroundColor] = color(code - 90, bright: true)
      default: break
      }
    }
    return attributes
  }

  private static func color(_ index: Int, bright: Bool) -> NSColor {
    let colors: [NSColor] = [
      .labelColor, .systemRed, .systemGreen, .systemYellow,
      .systemBlue, .systemPurple, .systemCyan, .white,
    ]
    let base = colors.indices.contains(index) ? colors[index] : .labelColor
    return bright ? (base.highlight(withLevel: 0.22) ?? base) : base
  }
}
