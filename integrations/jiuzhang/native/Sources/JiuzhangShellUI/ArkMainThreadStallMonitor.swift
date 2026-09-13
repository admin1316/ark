import Foundation

/// Opt-in recorder for main-thread stalls during real usage.
///
/// A synthetic stress driver can only approximate what a user does. This monitor records the
/// freezes that actually happen, with the app context at that moment, so a report is actionable:
///
/// ```
/// defaults write cn.jiuzhangtianmu.industrybrain ark.native.diagnostics.mainThreadStalls -bool true
/// ```
///
/// A single main-run-loop heartbeat (250 ms) measures how late it actually fired. A late tick past
/// the threshold appends one line to `~/Library/Logs/Ark/main-thread-stalls.log`. Off by default,
/// no UI, no timers when disabled, and each line is bounded.
@MainActor
final class ArkMainThreadStallMonitor {
  static let shared = ArkMainThreadStallMonitor()
  static let defaultsKey = "ark.native.diagnostics.mainThreadStalls"

  private let heartbeat: TimeInterval = 0.25
  private let threshold: TimeInterval = 0.4
  private var timer: Timer?
  private var lastTick = Date()
  /// Supplied by the owner: a one-line description of what the app is doing (session state,
  /// entry counts, workbench/terminal state). Called only when a stall is recorded.
  var contextProvider: (() -> String)?

  private init() {}

  /// Starts the heartbeat when the opt-in default is set. Safe to call more than once.
  func startIfEnabled(fileManager: FileManager = .default) {
    guard UserDefaults.standard.bool(forKey: Self.defaultsKey), timer == nil else { return }
    lastTick = Date()
    let timer = Timer(timeInterval: heartbeat, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated { self?.tick() }
    }
    RunLoop.main.add(timer, forMode: .common)
    self.timer = timer
    log("monitor started (heartbeat \(Int(heartbeat * 1000)) ms, threshold \(Int(threshold * 1000)) ms)")
  }

  func stop() {
    timer?.invalidate()
    timer = nil
  }

  private func tick() {
    let now = Date()
    let late = now.timeIntervalSince(lastTick) - heartbeat
    lastTick = now
    guard late >= threshold else { return }
    let context = contextProvider?() ?? "context unavailable"
    log(String(format: "stall %.0fms  %@", late * 1000, context))
  }

  private func log(_ line: String) {
    let directory = FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent("Library/Logs/Ark", isDirectory: true)
    try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let url = directory.appendingPathComponent("main-thread-stalls.log")
    let stamp = ISO8601DateFormatter().string(from: Date())
    let entry = "\(stamp) \(line)\n"
    if let handle = try? FileHandle(forWritingTo: url) {
      handle.seekToEndOfFile()
      handle.write(Data(entry.utf8))
      try? handle.close()
    } else {
      try? Data(entry.utf8).write(to: url, options: .atomic)
    }
    FileHandle.standardError.write(Data("ark: \(line)\n".utf8))
  }
}