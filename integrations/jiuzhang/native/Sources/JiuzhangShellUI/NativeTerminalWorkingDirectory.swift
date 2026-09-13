import Darwin
import Foundation

/// Working directory ownership for Workbench terminal sessions.
///
/// The live directory is sampled from the kernel so a restarted shell can
/// resume where the user actually was, and an unusable preferred directory
/// falls back to the workspace root and then the user's home directory.
enum NativeTerminalWorkingDirectory {
  /// Sample the current working directory of a live process with
  /// proc_pidinfo(PROC_PIDVNODEPATHINFO). Returns nil for any pid that cannot
  /// be inspected (dead, recycled, or not permitted).
  ///
  /// vip_path is a fixed PATH_MAX buffer that follows the vnode_info prefix
  /// inside proc_vnodepathinfo.pvi_cdir; the imported C struct owns that
  /// offset, so it is never hand-computed here.
  static func currentDirectory(ofPID pid: pid_t) -> String? {
    guard pid > 0 else { return nil }
    var info = proc_vnodepathinfo()
    let size = MemoryLayout<proc_vnodepathinfo>.size
    guard proc_pidinfo(pid, PROC_PIDVNODEPATHINFO, 0, &info, Int32(size)) == Int32(size) else {
      return nil
    }
    return withUnsafeBytes(of: &info.pvi_cdir.vip_path) { buffer -> String? in
      guard let baseAddress = buffer.baseAddress else { return nil }
      let characters = baseAddress.assumingMemoryBound(to: CChar.self)
      var length = 0
      while length < buffer.count, characters[length] != 0 { length += 1 }
      // A path that fills the whole buffer lost its terminator: refuse it
      // rather than read beyond the sampled struct.
      guard length > 0, length < buffer.count else { return nil }
      // File names are bytes, not guaranteed UTF-8: repair instead of failing.
      return String(decoding: buffer[0..<length], as: UTF8.self)
    }
  }

  /// Resolve the shell working directory for one session.
  ///
  /// - An existing preferred directory is used verbatim.
  /// - A missing, unreadable, or non-directory preferred path falls back to
  ///   workspaceRoot and then home, and reports repaired true with the
  ///   original preference as missing.
  /// - No preference (or a blank preference) is not a repair: the workspace
  ///   root is the normal first-run directory.
  static func resolve(
    preferred: String?,
    workspaceRoot: URL,
    home: URL
  ) -> (url: URL, repaired: Bool, missing: String?) {
    if let preferred {
      let normalized = preferred.trimmingCharacters(in: .whitespacesAndNewlines)
      if !normalized.isEmpty {
        if isDirectory(URL(fileURLWithPath: preferred, isDirectory: true)) {
          return (URL(fileURLWithPath: preferred, isDirectory: true), false, nil)
        }
        let fallback = firstExistingDirectory([workspaceRoot, home]) ?? home
        return (fallback, true, preferred)
      }
    }
    let fallback = firstExistingDirectory([workspaceRoot, home]) ?? workspaceRoot
    return (fallback, false, nil)
  }

  private static func firstExistingDirectory(_ candidates: [URL]) -> URL? {
    for candidate in candidates where isDirectory(candidate) {
      return candidate
    }
    return nil
  }

  private static func isDirectory(_ url: URL) -> Bool {
    var isDirectory: ObjCBool = false
    guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory) else {
      return false
    }
    return isDirectory.boolValue
  }
}

/// Bounded automatic-repair policy for an unexpectedly exited shell.
///
/// At most maxAttempts rebuilds inside a sliding window; every recorded
/// attempt returns the delay to wait before the next rebuild. A nil result
/// means the window is exhausted and the session must stop until the user
/// restarts it manually.
struct NativeTerminalRepairPolicy: Sendable {
  let maxAttempts: Int
  let window: TimeInterval
  let delays: [TimeInterval]
  private(set) var attempts: [Date]

  init(
    maxAttempts: Int = 3,
    window: TimeInterval = 15,
    delays: [TimeInterval] = [0.5, 1.5, 3]
  ) {
    self.maxAttempts = maxAttempts
    self.window = window
    self.delays = delays
    attempts = []
  }

  /// Record one rebuild attempt and return how long to wait before it.
  /// Returns nil once the window already holds maxAttempts attempts.
  mutating func recordAttempt(at now: Date) -> TimeInterval? {
    attempts.removeAll { now.timeIntervalSince($0) >= window }
    guard attempts.count < maxAttempts else { return nil }
    attempts.append(now)
    guard !delays.isEmpty else { return 0 }
    return delays[min(attempts.count - 1, delays.count - 1)]
  }

  mutating func reset() {
    attempts = []
  }

  var isExhausted: Bool {
    attempts.count >= maxAttempts
  }
}
