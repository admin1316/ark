import Darwin
import Foundation

/// Error thrown by {@link BackendProcess.start} when a previous process has
/// not been reaped yet.
public enum BackendProcessError: Error {
  case alreadyRunning
}

/// Rolling breaker for backend launches that reach readiness and then crash.
/// A readiness line starts the stability clock; it does not forgive earlier
/// failures until that exact process has remained ready for the whole window.
public struct BackendRestartCircuitBreaker {
  public let maximumRapidRestarts: Int
  public let stableWindow: TimeInterval
  public private(set) var rapidRestartCount = 0
  private var readyAt: Date?

  public init(maximumRapidRestarts: Int = 3, stableWindow: TimeInterval = 30) {
    precondition(maximumRapidRestarts > 0)
    precondition(stableWindow > 0)
    self.maximumRapidRestarts = maximumRapidRestarts
    self.stableWindow = stableWindow
  }

  public mutating func recordLaunch() {
    readyAt = nil
  }

  public mutating func recordReadiness(at date: Date = Date()) {
    if readyAt == nil { readyAt = date }
  }

  /// Return the bounded retry delay, or nil after too many rapid failures.
  public mutating func restartDelayAfterUnexpectedExit(at date: Date = Date()) -> TimeInterval? {
    if let readyAt, date.timeIntervalSince(readyAt) >= stableWindow {
      rapidRestartCount = 0
    }
    readyAt = nil
    guard rapidRestartCount < maximumRapidRestarts else { return nil }
    rapidRestartCount += 1
    return TimeInterval(1 << (rapidRestartCount - 1))
  }
}

/// Wraps one backend launch. Each {@link start} creates a fresh Foundation
/// `Process` and output `Pipe`, because a `Process` cannot be re-run
/// after termination; the shell restarts the backend after an unexpected
/// exit, so no launch may reuse another launch's objects. The old process's
/// termination handler clears only its own pipe and reports only its own
/// exit and stop completion.
public final class BackendProcess {
  /// The launcher gets six seconds for its child and two seconds to reap/exit.
  public static let forceKillGraceSeconds: TimeInterval = 8

  private let lock = NSLock()
  private var process: Process?
  private var output: Pipe?
  private var bufferedOutput = Data()
  private var stopCompletions: [() -> Void] = []
  private var forceKillWorkItem: DispatchWorkItem?
  private var forceKillDeadline: Date?
  private var stopRequested = false

  /// Receives every output line the child writes (stdout and stderr merged).
  public var onLine: ((String) -> Void)?
  /// Receives the child's termination status after it exits, on the main queue.
  public var onExit: ((Int32) -> Void)?

  public init() {}

  /// Whether a process is currently running.
  public var isRunning: Bool {
    lock.lock()
    defer { lock.unlock() }
    return process?.isRunning ?? false
  }

  /// Process identifier of the running process, or nil when none is running.
  public var processIdentifier: pid_t? {
    lock.lock()
    defer { lock.unlock() }
    return process?.processIdentifier
  }

  /// Start a fresh backend process with its own pipe.
  /// - Throws: `BackendProcessError.alreadyRunning` when the previous
  /// process has not been reaped yet, or the launch error from `Process.run`.
  public func start(
    executable: String,
    arguments: [String],
    environment: [String: String],
    workingDirectory: URL
  ) throws {
    lock.lock()
    guard process == nil else {
      lock.unlock()
      throw BackendProcessError.alreadyRunning
    }
    let process = Process()
    let output = Pipe()
    self.process = process
    self.output = output
    lock.unlock()

    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    process.environment = environment
    process.currentDirectoryURL = workingDirectory
    process.standardOutput = output
    process.standardError = output

    output.fileHandleForReading.readabilityHandler = { [weak self] handle in
      guard let self else { return }
      let data = handle.availableData
      guard !data.isEmpty else { return }
      self.consume(data)
    }
    process.terminationHandler = { [weak self, weak output] terminated in
      DispatchQueue.main.async {
        guard let self, let output else { return }
        output.fileHandleForReading.readabilityHandler = nil
        self.flushBufferedOutput()
        // Clear the ownership slot before notifying observers. The observer
        // is allowed to start a replacement after it receives the exit signal;
        // clearing it afterwards races that recovery path into
        // `alreadyRunning`.
        let stopCompletions: [() -> Void]
        self.lock.lock()
        if self.process === terminated {
          self.process = nil
          self.output = nil
          self.forceKillWorkItem?.cancel()
          self.forceKillWorkItem = nil
          self.forceKillDeadline = nil
          self.stopRequested = false
        }
        stopCompletions = self.stopCompletions
        self.stopCompletions.removeAll()
        self.lock.unlock()
        self.onExit?(terminated.terminationStatus)
        stopCompletions.forEach { $0() }
      }
    }

    do {
      try process.run()
    } catch {
      lock.lock()
      if self.process === process {
        self.process = nil
        self.output = nil
      }
      lock.unlock()
      output.fileHandleForReading.readabilityHandler = nil
      throw error
    }
  }

  /// Terminate the running launcher, force-killing it after a bounded grace, and
  /// invoke `completion` once the termination handler has reaped it. When
  /// nothing is running, `completion` runs immediately. The force deadline is
  /// capped at eight seconds but may be shortened by the AppKit owner's one
  /// absolute termination deadline.
  public func stop(deadline: Date? = nil, completion: @escaping () -> Void) {
    let process: Process
    let shouldTerminate: Bool
    let selectedDeadline: Date
    lock.lock()
    guard let running = self.process, running.isRunning else {
      lock.unlock()
      completion()
      return
    }
    process = running
    stopCompletions.append(completion)
    shouldTerminate = !stopRequested
    stopRequested = true
    let boundedDeadline = Date().addingTimeInterval(Self.forceKillGraceSeconds)
    selectedDeadline = min(deadline ?? boundedDeadline, boundedDeadline)
    let shouldReschedule = forceKillDeadline.map { selectedDeadline < $0 } ?? true
    if shouldReschedule {
      forceKillWorkItem?.cancel()
      forceKillDeadline = selectedDeadline
      let pid = process.processIdentifier
      let workItem = DispatchWorkItem { [weak self, weak process] in
        guard let self, let process else { return }
        self.lock.lock()
        let stillOwned = self.process === process && process.isRunning
        self.lock.unlock()
        if stillOwned { _ = Darwin.kill(pid, SIGKILL) }
      }
      forceKillWorkItem = workItem
      DispatchQueue.global().asyncAfter(
        deadline: .now() + max(0, selectedDeadline.timeIntervalSinceNow),
        execute: workItem
      )
    }
    lock.unlock()
    if shouldTerminate { process.terminate() }
  }

  private func consume(_ data: Data) {
    lock.lock()
    bufferedOutput.append(data)
    var lines: [String] = []
    while let newline = bufferedOutput.firstIndex(of: 0x0A) {
      let lineData = bufferedOutput[..<newline]
      bufferedOutput.removeSubrange(...newline)
      if let line = String(data: lineData, encoding: .utf8) {
        lines.append(line)
      }
    }
    lock.unlock()

    for line in lines {
      DispatchQueue.main.async { [weak self] in
        self?.onLine?(line)
      }
    }
  }

  private func flushBufferedOutput() {
    lock.lock()
    let data = bufferedOutput
    bufferedOutput.removeAll(keepingCapacity: false)
    lock.unlock()
    guard !data.isEmpty, let line = String(data: data, encoding: .utf8) else { return }
    onLine?(line)
  }
}
