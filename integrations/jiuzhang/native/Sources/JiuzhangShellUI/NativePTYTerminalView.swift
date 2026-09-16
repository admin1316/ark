import AppKit
import Darwin
import SwiftUI
import SwiftTerm

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

/// Bounded, thread-safe byte hand-off between the PTY read handler (background) and the main actor.
///
/// The read handler must never allocate one MainActor Task per chunk: under a flood the queued
/// Tasks (each holding its own raw bytes) grew without limit while the main thread sat inside a
/// layout transaction. Callers append here — exactly one caller per burst gets `true` and schedules
/// the drain; bytes beyond the ceiling are dropped oldest-first so memory stays bounded.
final class NativeTerminalRawHandoff: @unchecked Sendable {
  private let lock = NSLock()
  private let limit: Int
  private var bytes: [UInt8] = []
  private var scheduled = false
  private var dropped = 0

  init(limit: Int) {
    self.limit = limit
  }

  /// Appends bytes; returns true when the caller must schedule a drain on the main actor.
  func append(_ newBytes: [UInt8]) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    bytes.append(contentsOf: newBytes)
    if bytes.count > limit {
      let excess = bytes.count - limit
      bytes.removeFirst(excess)
      dropped += excess
    }
    guard !scheduled else { return false }
    scheduled = true
    return true
  }

  /// Takes everything buffered and reopens the "schedule a drain" gate.
  func take() -> [UInt8] {
    lock.lock()
    defer { lock.unlock() }
    let taken = bytes
    bytes.removeAll(keepingCapacity: true)
    scheduled = false
    return taken
  }

  var pendingCount: Int {
    lock.lock()
    defer { lock.unlock() }
    return bytes.count
  }

  var droppedBytes: Int {
    lock.lock()
    defer { lock.unlock() }
    return dropped
  }
}

/// One coalesced diagnostic flush per publish interval instead of one sleeping Task per chunk.
final class NativeTerminalFlushGate: @unchecked Sendable {
  private let lock = NSLock()
  private var scheduled = false

  /// Returns true when the caller owns the next flush.
  func begin() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    guard !scheduled else { return false }
    scheduled = true
    return true
  }

  func end() {
    lock.lock()
    defer { lock.unlock() }
    scheduled = false
  }
}

@MainActor
final class NativePTYTerminalSession: ObservableObject {
  let rootURL: URL
  /// Stable identity of the logical session inside this workspace; nil disables persistence.
  let sessionKey: String?

  /// Diagnostic/contract transcript. Deliberately not @Published: nothing renders it any more
  /// (SwiftTerm owns the pixels), and publishing at the 33 ms flush cadence invalidated the whole
  /// terminal view on every chunk of a heavy stream.
  private(set) var output = ""
  @Published private(set) var isRunning = false
  @Published private(set) var terminationStatus: Int32?
  @Published private(set) var termination: NativePTYTermination?
  @Published private(set) var errorMessage: String?

  /// Interface language for the transcript notices this session emits. The view sets it before the
  /// first spawn; `.zh` only applies to headless contract runs.
  var language: ArkLanguagePreference = .zh

  var processIdentifier: pid_t? { processOwner?.processID }
  var processGroupIdentifier: pid_t? { processOwner?.processGroupID }
  var processSessionIdentifier: pid_t? { processOwner?.sessionID }

  /// Raw PTY bytes for the terminal surface. The inbox-backed `output` string remains the
  /// diagnostic/contract transcript; SwiftTerm owns everything the user sees.
  var onOutput: (([UInt8]) -> Void)?
  /// The session-owned SwiftTerm emulator; see `terminalSurface()`.
  private var surfaceHost: NativeTerminalSurfaceHost?

  private let store: NativeTerminalSessionStore?
  private var savedSnapshot: NativeTerminalSessionSnapshot?
  private var activeWorkingDirectory: URL?
  private var lastSampledWorkingDirectory: String?
  private var cwdSampleTask: Task<Void, Never>?
  private var repairTask: Task<Void, Never>?
  private var repairPolicy = NativeTerminalRepairPolicy()
  private var repairCount = 0
  /// Hard lifetime ceiling for automatic rebuilds. The sliding policy window only bounds the rate;
  /// this bounds total churn so a slow crash loop can never restart a session forever.
  static let defaultLifetimeAutomaticRepairLimit = 20
  var lifetimeAutomaticRepairLimit = NativePTYTerminalSession.defaultLifetimeAutomaticRepairLimit
  private var lifetimeAutomaticRepairCount = 0
  /// Guards `restartSession()` against re-entry while a teardown/restart cycle is in flight.
  private var restartInFlight = false
  private var sessionStartedAt: Date?
  private var lastPersistAt: Date?
  private var intentionalShutdown = false

  private var processOwner: NativePTYProcessOwner?
  private var masterHandle: FileHandle?
  private var masterDescriptor: Int32 = -1
  private var started = false
  /// Last window size actually pushed to the PTY. `TIOCSWINSZ` raises `SIGWINCH` even when the
  /// character grid is unchanged, and a login shell redisplays a fresh prompt per signal — so the
  /// repeated layout passes of a split drag or window animation would flood the transcript.
  private var lastAppliedWindowSize: (columns: Int, rows: Int)?
  private let helperExecutable: URL?
  private let baseEnvironment: [String: String]
  private let outputLimit = 1_048_576
  /// Thread-safe PTY→main-actor hand-off (see `drainRawHandoff`); bounded so a flood cannot queue
  /// without limit while the main thread is busy.
  private let rawHandoff = NativeTerminalRawHandoff(limit: 8 * 1024 * 1024)
  /// Coalesces the diagnostic flush to one per publish interval instead of one sleeping Task per
  /// chunk.
  private let outputFlushGate = NativeTerminalFlushGate()
  private let outputInbox = NativeTerminalOutputInbox()
  private let publishIntervalNanoseconds: UInt64 = 33_000_000
  private let persistInterval: TimeInterval = 5
  private let cwdSampleIntervalNanoseconds: UInt64 = 2_000_000_000

  init(
    rootURL: URL,
    sessionKey: String? = nil,
    store: NativeTerminalSessionStore? = nil,
    helperExecutable: URL? = Bundle.main.executableURL,
    baseEnvironment: [String: String] = ProcessInfo.processInfo.environment
  ) {
    self.rootURL = rootURL.standardizedFileURL
    self.sessionKey = sessionKey
    self.store = store ?? (sessionKey == nil ? nil : NativeTerminalSessionStore())
    self.helperExecutable = helperExecutable
    self.baseEnvironment = baseEnvironment
    if let sessionKey, let store = self.store {
      // Only the working directory is restored: the shell is new, so its screen must be new too.
      let snapshot = store.load(forKey: sessionKey)
      savedSnapshot = snapshot
      lastSampledWorkingDirectory = snapshot?.cwd
      // One-shot retention pass on session start; no timer, and the live key is protected.
      store.prune(activeKeys: [sessionKey])
    }
  }

  deinit {
    processOwner?.shutdownDetached()
  }

  func startIfNeeded() {
    guard !started else { return }
    started = true
    intentionalShutdown = false
    guard let helperExecutable else {
      errorMessage = NativePTYProcessError.helperUnavailable.localizedDescription
      return
    }
    // A missing workspace (or a persisted cwd that no longer exists) is repaired before spawn so
    // the shell never starts inside a directory that vanished while the app was closed.
    let resolution = NativeTerminalWorkingDirectory.resolve(
      preferred: activeWorkingDirectory?.path ?? savedSnapshot?.cwd,
      workspaceRoot: rootURL,
      home: FileManager.default.homeDirectoryForCurrentUser
    )
    activeWorkingDirectory = resolution.url
    if resolution.repaired {
      emitTranscriptLine(
        ArkL10n.text(.filesTerminalSessionRepaired, language)
          + (language == .zh ? "：" : ": ")
          + ArkL10n.text(.filesTerminalMissingDirectory, language)
          + " \(resolution.url.path)"
      )
    }
    do {
      let spawned = try NativePTYProcessSpawner.spawn(
        helperExecutable: helperExecutable,
        rootURL: resolution.url,
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
      // A fresh PTY starts at the spawner's default grid, so the next resize must apply.
      lastAppliedWindowSize = nil
      isRunning = true
      terminationStatus = nil
      termination = nil
      errorMessage = nil
      sessionStartedAt = Date()
      processOwner.startMonitoring()
      startWorkingDirectorySampling()
      persist(force: false)
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  func send(_ value: String) {
    send(bytes: ArraySlice(Array(value.utf8)))
  }

  func send(bytes: ArraySlice<UInt8>) {
    startIfNeeded()
    guard isRunning, let masterHandle, !bytes.isEmpty else { return }
    do {
      try masterHandle.write(contentsOf: Data(bytes))
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

  /// The clamped character grid, or nil when it equals what was already applied.
  /// Pure so the SIGWINCH-flood guard carries an executable contract: `TIOCSWINSZ` signals the
  /// shell even for an unchanged grid, and each signal makes a login shell redisplay a prompt.
  nonisolated static func windowSizeIfNeeded(
    columns: Int,
    rows: Int,
    lastApplied: (columns: Int, rows: Int)?
  ) -> (columns: Int, rows: Int)? {
    let applied = (
      columns: max(2, min(columns, Int(UInt16.max))),
      rows: max(2, min(rows, Int(UInt16.max)))
    )
    if let lastApplied, lastApplied.columns == applied.columns, lastApplied.rows == applied.rows { return nil }
    return applied
  }

  func resize(columns: Int, rows: Int) {
    guard masterDescriptor >= 0,
          let applied = Self.windowSizeIfNeeded(
            columns: columns, rows: rows, lastApplied: lastAppliedWindowSize
          )
    else { return }
    var size = winsize(
      ws_row: UInt16(applied.rows),
      ws_col: UInt16(applied.columns),
      ws_xpixel: 0,
      ws_ypixel: 0
    )
    let result = withUnsafeMutablePointer(to: &size) { pointer in
      Darwin.ioctl(masterDescriptor, TIOCSWINSZ, pointer)
    }
    // Only a landed resize becomes the dedupe baseline, so a failed ioctl is retried on the
    // next layout pass instead of stranding the shell at a stale grid.
    guard result == 0 else { return }
    lastAppliedWindowSize = applied
  }

  /// Manual stop (tab close, app quit). Always persists the tail first and never arms repair.
  @discardableResult
  func shutdown() async -> NativePTYTermination? {
    intentionalShutdown = true
    repairTask?.cancel()
    repairTask = nil
    persistNow()
    stopWorkingDirectorySampling()
    guard let processOwner else {
      prepareForShutdown()
      isRunning = false
      return termination
    }
    return await processOwner.shutdown()
  }

  /// Manual repair (Command-R): persist the live tail, tear the PTY down, then start a fresh shell in
  /// the same working directory with a cleared repair budget.
  func restartSession() {
    // Command-R is a keyboard shortcut: holding it (or pressing it again during the async
    // teardown) must not run a second shutdown/restart cycle, which would leak the first shell
    // (audited 2026-09-12: restartSession had no in-flight guard).
    // A second Command-R during the async teardown used to be a silent no-op, so the operator
    // pressed it again (usability audit round-3, C2). Say what the terminal is doing instead.
    guard !restartInFlight else {
      emitTranscriptLine(ArkL10n.text(.filesTerminalRestarting, language))
      return
    }
    restartInFlight = true
    persistNow()
    repairTask?.cancel()
    repairTask = nil
    intentionalShutdown = true
    Task { @MainActor [weak self] in
      guard let self else { return }
      _ = await self.shutdown()
      self.intentionalShutdown = false
      self.repairPolicy.reset()
      // Only an explicit user restart clears the lifetime ceiling.
      self.lifetimeAutomaticRepairCount = 0
      self.restartShell()
      self.restartInFlight = false
    }
  }

  /// The one SwiftTerm emulator for this session. It is created on first install and kept for the
  /// session's lifetime so a tab switch only re-parents it: screen, scrollback, alternate screen and
  /// cursor survive, and output keeps arriving while the tab is hidden.
  func terminalSurface() -> NativeTerminalSurfaceHost {
    if let surfaceHost { return surfaceHost }
    let surface = NativeTerminalSurfaceHost(session: self)
    surfaceHost = surface
    return surface
  }

  func uninstallTerminalSurface(from container: NSView) {
    surfaceHost?.uninstall(from: container)
  }

  /// Persist the live tail immediately; used on tab close and app quit.
  func persistNow() {
    persist(force: true)
  }

  /// Diagnostics/test hooks: prove teardown cancels both the cwd sampler and any pending repair.
  var isSamplingWorkingDirectory: Bool { cwdSampleTask != nil }
  var hasPendingAutomaticRepair: Bool { repairTask != nil }
  var lifetimeAutomaticRepairCountSnapshot: Int { lifetimeAutomaticRepairCount }

  /// Localized exit-status line for the thin bottom row (no hardcoded English).
  func exitStatusText(_ status: Int32) -> String { shellExitedLine(status) }

  private func appendOutput(_ value: String) {
    output += value
    guard output.utf8.count > outputLimit else { return }
    // Byte-suffix trim (same UTF-8-safe helper the store uses). The previous byte-wise inbox
    // re-encode cost O(1 MiB) per flush and dominated the flood path on the main thread.
    let tail = NativeTerminalSessionStore.boundedTranscript(output, limitBytes: outputLimit / 2)
    output = "… earlier terminal output truncated …\n\u{001B}[0m" + tail
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
      // One hand-off per burst, not one MainActor Task per chunk. The old shape allocated a Task
      // holding its raw bytes for *every* read and a second Task per read for the diagnostic
      // flush; under a flood (yes/cat/compiler logs) that queue was unbounded while the main
      // thread sat inside a layout transaction (audited 2026-09-12, P1-6 residual). The buffers
      // live in thread-safe helpers so this background callback never touches MainActor state.
      if self?.rawHandoff.append(Array(data)) == true {
        Task { @MainActor [weak self] in self?.drainRawHandoff() }
      }
      guard outputInbox.enqueue(data) else { return }
      guard self?.outputFlushGate.begin() == true else { return }
      Task { @MainActor [weak self] in
        let interval = self?.publishIntervalNanoseconds ?? 33_000_000
        try? await Task.sleep(nanoseconds: interval)
        self?.outputFlushGate.end()
        self?.flushOutputInbox()
      }
    }
  }

  /// Main-actor side of the bounded hand-off: takes the burst accumulated since the last drain.
  private func drainRawHandoff() {
    let bytes = rawHandoff.take()
    guard !bytes.isEmpty else { return }
    onOutput?(bytes)
    // Throttled: the working directory is persisted at most every persistInterval seconds.
    persist(force: false)
  }

  /// Test/diagnostic hook: bytes waiting in the thread-safe hand-off buffer.
  var pendingRawHandoffBytes: Int { rawHandoff.pendingCount }

  /// Test/diagnostic hook: bytes dropped by the hand-off ceiling.
  var droppedRawHandoffBytes: Int { rawHandoff.droppedBytes }

  /// Emit a localized notice as terminal output: the PTY surface sees real bytes and the diagnostic
  /// transcript keeps a copy, so no extra UI chrome is introduced.
  private func emitTranscriptLine(_ text: String) {
    let line = "\r\n" + text + "\r\n"
    let bytes = Array(line.utf8)
    onOutput?(bytes)
    appendOutput(line)
  }

  func shellExitedLine(_ status: Int32) -> String {
    let prefix = ArkL10n.text(.filesTerminalShellExited, language)
    let closing = language == .zh ? "）" : ")"
    return "\(prefix) \(status)\(closing)"
  }

  private func persist(force: Bool) {
    guard let store, let sessionKey else { return }
    let now = Date()
    if !force, let lastPersistAt, now.timeIntervalSince(lastPersistAt) < persistInterval { return }
    lastPersistAt = now
    // Only honest state is persisted: where the shell was and how often it had to be rebuilt.
    let snapshot = NativeTerminalSessionSnapshot(
      cwd: lastSampledWorkingDirectory ?? activeWorkingDirectory?.path,
      updatedAt: now,
      repairCount: repairCount
    )
    savedSnapshot = snapshot
    store.save(snapshot, forKey: sessionKey)
  }

  private func startWorkingDirectorySampling() {
    cwdSampleTask?.cancel()
    cwdSampleTask = Task { @MainActor [weak self] in
      while !Task.isCancelled {
        let interval = self?.cwdSampleIntervalNanoseconds ?? 2_000_000_000
        try? await Task.sleep(nanoseconds: interval)
        guard let self else { return }
        guard self.isRunning, let pid = self.processIdentifier else { continue }
        guard let directory = NativeTerminalWorkingDirectory.currentDirectory(ofPID: pid),
              directory != self.lastSampledWorkingDirectory
        else { continue }
        self.lastSampledWorkingDirectory = directory
        self.activeWorkingDirectory = URL(fileURLWithPath: directory, isDirectory: true)
        self.persist(force: false)
      }
    }
  }

  private func stopWorkingDirectorySampling() {
    cwdSampleTask?.cancel()
    cwdSampleTask = nil
  }

  /// Rebuild after an unexpected exit. Manual shutdown/restart clears intentionalShutdown
  /// explicitly, so this guard only blocks a repair racing a user-driven teardown.
  private func restartShell() {
    guard !intentionalShutdown else { return }
    started = false
    processOwner = nil
    masterHandle = nil
    masterDescriptor = -1
    lastAppliedWindowSize = nil
    termination = nil
    terminationStatus = nil
    errorMessage = nil
    startIfNeeded()
  }

  private func scheduleAutomaticRepair(after termination: NativePTYTermination) {
    let now = Date()
    // Lifetime ceiling first: a slow crash loop (each shell surviving past the policy window) resets
    // the rate budget but must never restart forever.
    guard lifetimeAutomaticRepairCount < lifetimeAutomaticRepairLimit else {
      emitTranscriptLine(ArkL10n.text(.filesTerminalStopped, language))
      return
    }
    // A shell that ran longer than the repair window is healthy: start a fresh rate budget.
    if let sessionStartedAt, now.timeIntervalSince(sessionStartedAt) > repairPolicy.window {
      repairPolicy.reset()
    }
    sessionStartedAt = nil
    guard let delay = repairPolicy.recordAttempt(at: now) else {
      emitTranscriptLine(ArkL10n.text(.filesTerminalStopped, language))
      return
    }
    lifetimeAutomaticRepairCount += 1
    repairCount += 1
    emitTranscriptLine(shellExitedLine(termination.displayStatus))
    emitTranscriptLine(ArkL10n.text(.filesTerminalRestarting, language))
    repairTask?.cancel()
    repairTask = Task { @MainActor [weak self] in
      try? await Task.sleep(nanoseconds: UInt64(max(0, delay) * 1_000_000_000))
      guard !Task.isCancelled, let self else { return }
      self.repairTask = nil
      self.restartShell()
    }
  }

  private func prepareForShutdown() {
    stopWorkingDirectorySampling()
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
      errorMessage = ArkL10n.text(.filesTerminalDrainTimeout, language)
    }
    // Every exit — including a user stop, so the tab-close path is covered too — lands on disk.
    persistNow()
    guard !intentionalShutdown else { return }
    // Automatic repair needs a persistent identity: headless contract sessions (no sessionKey)
    // must keep their terminal state after a natural exit instead of silently rebuilding.
    guard sessionKey != nil, store != nil else { return }
    scheduleAutomaticRepair(after: termination)
  }
}

struct NativePTYTerminalView: View {
  @ObservedObject var session: NativePTYTerminalSession
  let language: ArkLanguagePreference

  var body: some View {
    VStack(spacing: 0) {
      NativePTYTerminalSurface(session: session, language: language)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
      if let error = session.errorMessage {
        Text(error)
          .font(.system(size: 10))
          .foregroundStyle(Color.red)
          .padding(.horizontal, 10)
          .frame(maxWidth: .infinity, minHeight: 24, alignment: .leading)
      } else if let status = session.terminationStatus, !session.isRunning {
        Text(session.exitStatusText(status))
          .font(.system(size: 10, design: .monospaced))
          .foregroundStyle(Color.secondary)
          .padding(.horizontal, 10)
          .frame(maxWidth: .infinity, minHeight: 24, alignment: .leading)
      }
    }
    .onAppear {
      session.language = language
      // The emulator must exist before the shell can print its first banner: output that arrives
      // while no surface is installed has nowhere to go.
      _ = session.terminalSurface()
      session.startIfNeeded()
    }
    .accessibilityIdentifier("ark.workbench.pty-terminal")
  }
}

/// The SwiftTerm emulator is owned by the *session*, not by the SwiftUI representable that shows it.
/// Switching tool tabs (terminal → files → terminal) tears the representable down; a surface created
/// inside it would be destroyed with it — that is exactly the garbled screen reported after coming
/// back from a file tab (2026-09-12). One emulator per session keeps screen, scrollback, alternate
/// screen and cursor intact, and keeps live output flowing into it while the tab is hidden. Nothing
/// is ever replayed into it: PTY bytes are the only author of terminal content.
final class NativeTerminalSurfaceHost: NSObject, TerminalViewDelegate {
  let view: TerminalView

  private weak var session: NativePTYTerminalSession?
  private weak var monitoredView: TerminalView?
  private var restartMonitor: Any?
  private var pending: [UInt8] = []
  private var pendingOffset = 0
  private var drainScheduled = false
  /// Bounded per main-queue turn: a 20 MB flood must not block the chat/UI run loop for hundreds
  /// of milliseconds. Each turn parses at most this many bytes and then yields to the run loop.
  private let maxFeedBytesPerTurn = 16 * 1024
  /// Ceiling for bytes queued toward the emulator (see `enqueue`); the diagnostic transcript caps
  /// at 1 MiB, this bounded display queue used to have no cap at all.
  let pendingByteLimit = 8 * 1024 * 1024
  private let pendingDropNoticeThreshold = 262_144
  private var droppedPendingBytes = 0

  init(session: NativePTYTerminalSession) {
    self.session = session
    view = TerminalView(frame: .zero)
    super.init()
    view.terminalDelegate = self
    installRestartShortcutMonitor()
    MainActor.assumeIsolated {
      // No content is ever injected here: the emulator starts empty and only the PTY may fill it.
      // SwiftTerm owns this session's raw PTY stream from now on — attached or not.
      session.onOutput = { [weak self] bytes in self?.enqueue(bytes) }
    }
  }

  deinit {
    removeRestartShortcutMonitor()
  }

  /// Re-parent the retained emulator into the container SwiftUI just made. Nothing is rebuilt: the
  /// same `TerminalView` — and its whole buffer — simply moves.
  func install(in container: NSView) {
    guard view.superview !== container else { return }
    view.removeFromSuperview()
    view.translatesAutoresizingMaskIntoConstraints = false
    container.addSubview(view)
    NSLayoutConstraint.activate([
      view.leadingAnchor.constraint(equalTo: container.leadingAnchor),
      view.trailingAnchor.constraint(equalTo: container.trailingAnchor),
      view.topAnchor.constraint(equalTo: container.topAnchor),
      view.bottomAnchor.constraint(equalTo: container.bottomAnchor),
    ])
    // The terminal tab is now the visible tool: hand it the keyboard so it is type-ready, which is
    // what an embedded terminal is expected to do. Deferred one runloop turn because the container
    // is not in a window yet, and skipped whenever a real text editor owns focus (chat composer).
    DispatchQueue.main.async { [weak self] in self?.focusIfNothingIsEditing() }
  }

  /// Adopt the keyboard only when no editable text responder owns it. Blindly calling
  /// `makeFirstResponder` here would yank focus out of the chat composer whenever SwiftUI
  /// re-installed the surface.
  private func focusIfNothingIsEditing() {
    guard let window = view.window, window.isKeyWindow, window.firstResponder !== view else { return }
    if let textView = window.firstResponder as? NSTextView, textView.isEditable { return }
    if window.firstResponder is NSTextField { return }
    window.makeFirstResponder(view)
  }

  /// Unhook the display while another tool tab is in front. The emulator stays alive and keeps
  /// receiving output, so coming back shows the live screen instead of a rebuilt approximation.
  func uninstall(from container: NSView) {
    guard view.superview === container else { return }
    if let window = view.window, window.firstResponder === view {
      window.makeFirstResponder(nil)
    }
    view.removeFromSuperview()
  }

  /// Test/diagnostic hook: the visible text of the retained emulator's active buffer.
  func surfaceText() -> String {
    String(decoding: view.terminal.getBufferAsData(kind: .active), as: UTF8.self)
  }

  /// Command-R restarts only when *this* terminal owns key focus. A window-level SwiftUI
  /// keyboardShortcut fired while the chat composer was focused and killed the foreground
  /// command the user was watching, so the shortcut is scoped to the terminal view instead.
  private func installRestartShortcutMonitor() {
    if restartMonitor != nil, monitoredView === view { return }
    removeRestartShortcutMonitor()
    monitoredView = view
    restartMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) {
      [weak self, weak view] event in
      guard let self, let view,
            let session = self.session,
            let window = view.window,
            event.window === window,
            self.isTerminalFocused(view),
            // A held-down shortcut must not restart the session repeatedly.
            !event.isARepeat,
            // Standard macOS shortcut semantics: Command only, CapsLock/Numpad ignored, and no
            // Option/Control/Shift combination.
            event.modifierFlags.contains(.command),
            event.modifierFlags.intersection([.option, .control, .shift]).isEmpty,
            // CapsLock makes charactersIgnoringModifiers uppercase; compare case-insensitively.
            event.charactersIgnoringModifiers?.lowercased() == "r"
      else { return event }
      MainActor.assumeIsolated { session.restartSession() }
      return nil
    }
  }

  private func removeRestartShortcutMonitor() {
    guard let restartMonitor else { return }
    self.restartMonitor = nil
    monitoredView = nil
    if Thread.isMainThread {
      NSEvent.removeMonitor(restartMonitor)
    } else {
      DispatchQueue.main.async { NSEvent.removeMonitor(restartMonitor) }
    }
  }

  private func isTerminalFocused(_ view: TerminalView) -> Bool {
    var responder: NSResponder? = view.window?.firstResponder
    while let current = responder {
      if current === view { return true }
      responder = (current as? NSView)?.superview
    }
    return false
  }

  /// Called on the main actor by the session's raw-output bridge. It runs whether or not the tab is
  /// visible: the emulator must see every byte, not only the ones painted on screen.
  ///
  /// The queue is bounded: the PTY keeps producing while the main thread is inside a layout
  /// transaction, and before 2026-09-12 nothing capped this buffer (audited: a flood plus a busy
  /// main thread grew it without limit). Beyond the ceiling the *oldest* bytes are dropped — the
  /// tail is what the user is watching — and one notice explains the gap per threshold.
  func enqueue(_ bytes: [UInt8]) {
    pending.append(contentsOf: bytes)
    let queued = pending.count - pendingOffset
    guard queued > pendingByteLimit else {
      scheduleDrain()
      return
    }
    let excess = queued - pendingByteLimit
    pendingOffset += excess
    droppedPendingBytes += excess
    if droppedPendingBytes >= pendingDropNoticeThreshold {
      pending.append(contentsOf: Array("\r\n… terminal output dropped (\(droppedPendingBytes) bytes) …\r\n".utf8))
      droppedPendingBytes = 0
    }
    if pendingOffset > 1_048_576 {
      pending.removeFirst(pendingOffset)
      pendingOffset = 0
    }
    scheduleDrain()
  }

  /// Test/diagnostic hook: bytes queued toward the emulator but not yet parsed.
  var queuedByteCount: Int { pending.count - pendingOffset }

  private func scheduleDrain() {
    guard !drainScheduled else { return }
    drainScheduled = true
    DispatchQueue.main.async { [weak self] in self?.drainPending() }
  }

  private func drainPending() {
    drainScheduled = false
    guard pendingOffset < pending.count else {
      pending.removeAll(keepingCapacity: true)
      pendingOffset = 0
      return
    }
    let end = min(pending.count, pendingOffset + maxFeedBytesPerTurn)
    view.feed(byteArray: pending[pendingOffset..<end])
    pendingOffset = end
    if pendingOffset >= pending.count {
      pending.removeAll(keepingCapacity: true)
      pendingOffset = 0
    } else {
      scheduleDrain()
    }
  }

  // TerminalViewDelegate: whatever the emulator sends to the shell goes to the PTY.
  func send(source: TerminalView, data: ArraySlice<UInt8>) {
    MainActor.assumeIsolated { session?.send(bytes: data) }
  }

  // TerminalViewDelegate: SwiftTerm reports the real font-metric grid; the session pushes
  // TIOCSWINSZ with its dedupe guard so the shell matches the emulator.
  func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
    MainActor.assumeIsolated { session?.resize(columns: newCols, rows: newRows) }
  }

  func setTerminalTitle(source: TerminalView, title: String) {}

  func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}

  func scrolled(source: TerminalView, position: Double) {}

  func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}

  func bell(source: TerminalView) {
    NSSound.beep()
  }
}

/// SwiftTerm-backed surface. SwiftTerm owns every pixel the user sees — cursor addressing,
/// alternate screen, mouse, truecolor, bracketed paste, scrollback. This container only installs the
/// session's retained emulator, so switching tabs re-parents instead of rebuilding it.
private struct NativePTYTerminalSurface: NSViewRepresentable {
  let session: NativePTYTerminalSession
  let language: ArkLanguagePreference

  func makeCoordinator() -> Coordinator {
    Coordinator(session: session)
  }

  func makeNSView(context: Context) -> NSView {
    let container = NSView(frame: .zero)
    installSurface(on: container)
    return container
  }

  func updateNSView(_ container: NSView, context: Context) {
    installSurface(on: container)
  }

  static func dismantleNSView(_ container: NSView, coordinator: Coordinator) {
    // The emulator lives on the session; only its display is unhooked here.
    coordinator.session.uninstallTerminalSurface(from: container)
  }

  private func installSurface(on container: NSView) {
    session.language = language
    session.terminalSurface().install(in: container)
  }

  /// Carries the session to `dismantleNSView`; the emulator itself lives on the session.
  final class Coordinator {
    let session: NativePTYTerminalSession

    init(session: NativePTYTerminalSession) {
      self.session = session
    }
  }
}