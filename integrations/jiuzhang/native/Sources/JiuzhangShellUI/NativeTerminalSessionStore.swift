import CryptoKit
import Darwin
import Foundation
import JiuzhangShellCore

/// One restorable Workbench terminal session.
///
/// Only honest, machine-readable state is stored: the last observed working
/// directory (so a fresh shell reopens where the user was working), when it was
/// last seen, and how many automatic rebuilds the shell needed. Terminal
/// *content* is deliberately absent — the PTY is the only author of anything a
/// terminal shows, and replaying a text tail into a fresh emulator can only
/// fabricate a screen (2026-09-12: exactly that garbled the terminal).
struct NativeTerminalSessionSnapshot: Codable, Equatable, Sendable {
  var cwd: String?
  var updatedAt: Date
  var repairCount: Int
}

/// Durable, local-only storage for restorable Workbench terminal sessions.
///
/// Every snapshot is keyed by the SHA-256 of its raw session key, written
/// atomically with mode 0600 inside a 0700 directory, and bounded by byte
/// count. Corrupt or unreadable records degrade to nil; write failures are
/// silent because a lost session merely falls back to a fresh shell.
final class NativeTerminalSessionStore: @unchecked Sendable {
  static let recordExtension = "json"
  /// Retention bounds for prune: newest N records, 30-day TTL, and a 24-hour "recently used"
  /// grace window that overrides the count bound.
  static let defaultMaxRecords = 64
  static let defaultRecordTTL: TimeInterval = 30 * 24 * 60 * 60
  static let defaultRecentInterval: TimeInterval = 24 * 60 * 60

  let storageDirectoryURL: URL

  private let encoder: JSONEncoder
  private let decoder: JSONDecoder
  private let lock = NSLock()

  init(storageDirectoryURL: URL? = nil) {
    self.storageDirectoryURL = storageDirectoryURL ?? Self.defaultStorageURL()
    encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .secondsSince1970
    decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .secondsSince1970
  }

  func load(forKey key: String) -> NativeTerminalSessionSnapshot? {
    lock.lock()
    defer { lock.unlock() }
    guard let data = try? Data(contentsOf: recordURL(forKey: key)),
          let snapshot = try? decoder.decode(NativeTerminalSessionSnapshot.self, from: data)
    else { return nil }
    return snapshot
  }

  func save(_ snapshot: NativeTerminalSessionSnapshot, forKey key: String) {
    lock.lock()
    defer { lock.unlock() }
    guard let data = try? encoder.encode(snapshot) else { return }
    guard ensureStorageDirectory() else { return }
    writeAtomically(data, to: recordURL(forKey: key))
  }

  func remove(forKey key: String) {
    lock.lock()
    defer { lock.unlock() }
    try? FileManager.default.removeItem(at: recordURL(forKey: key))
  }

  /// Drop stale session records so the snapshot directory cannot grow without bound.
  ///
  /// Retention is decided from record content plus caller-supplied liveness:
  /// - keys in activeKeys are never removed;
  /// - records older than ttl are removed;
  /// - records touched within recentInterval survive the count pass (recently used);
  /// - otherwise only the newest maxRecords remain.
  /// Corrupt records fall back to their file modification date. Silent on I/O failure.
  /// Returns the number of records removed.
  @discardableResult
  func prune(
    now: Date = Date(),
    activeKeys: Set<String> = [],
    maxRecords: Int = NativeTerminalSessionStore.defaultMaxRecords,
    ttl: TimeInterval = NativeTerminalSessionStore.defaultRecordTTL,
    recentInterval: TimeInterval = NativeTerminalSessionStore.defaultRecentInterval
  ) -> Int {
    lock.lock()
    defer { lock.unlock() }
    guard let contents = try? FileManager.default.contentsOfDirectory(
      at: storageDirectoryURL,
      includingPropertiesForKeys: [.contentModificationDateKey],
      options: [.skipsHiddenFiles]
    ) else { return 0 }
    let protectedKeys = Set(activeKeys.map { Self.storageKey($0) })
    var survivors: [(url: URL, updatedAt: Date)] = []
    var removed = 0
    for url in contents where url.pathExtension == Self.recordExtension {
      let key = url.deletingPathExtension().lastPathComponent
      if protectedKeys.contains(key) { continue }
      let modified = (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?
        .contentModificationDate
      let updatedAt: Date
      if let data = try? Data(contentsOf: url),
         let snapshot = try? decoder.decode(NativeTerminalSessionSnapshot.self, from: data) {
        updatedAt = snapshot.updatedAt
      } else {
        updatedAt = modified ?? .distantPast
      }
      if now.timeIntervalSince(updatedAt) > ttl {
        if (try? FileManager.default.removeItem(at: url)) != nil { removed += 1 }
        continue
      }
      survivors.append((url, updatedAt))
    }
    let recentCount = survivors.filter { now.timeIntervalSince($0.updatedAt) <= recentInterval }.count
    var stale = survivors.filter { now.timeIntervalSince($0.updatedAt) > recentInterval }
    stale.sort { $0.updatedAt > $1.updatedAt }
    let budget = max(0, maxRecords - recentCount)
    for entry in stale.dropFirst(budget) {
      if (try? FileManager.default.removeItem(at: entry.url)) != nil { removed += 1 }
    }
    return removed
  }

  /// The on-disk record for one raw session key: sha256 hex plus .json.
  func recordURL(forKey key: String) -> URL {
    storageDirectoryURL
      .appendingPathComponent(Self.storageKey(key), isDirectory: false)
      .appendingPathExtension(Self.recordExtension)
  }

  /// Keep the tail of a transcript without splitting a UTF-8 scalar.
  ///
  /// The result is always a byte suffix of text and its UTF-8 length never
  /// exceeds limitBytes; a limit that lands mid-scalar drops the partial
  /// leading scalar, and a non-positive limit yields the empty string.
  static func boundedTranscript(_ text: String, limitBytes: Int) -> String {
    guard limitBytes > 0 else { return "" }
    let bytes = Array(text.utf8)
    guard bytes.count > limitBytes else { return text }
    var start = bytes.count - limitBytes
    while start < bytes.count, (bytes[start] & 0xC0) == 0x80 {
      start += 1
    }
    guard start < bytes.count else { return "" }
    return String(decoding: bytes[start...], as: UTF8.self)
  }

  /// Stable storage key for one raw session key (SHA-256, lowercase hex).
  static func storageKey(_ raw: String) -> String {
    SHA256.hash(data: Data(raw.utf8))
      .map { String(format: "%02x", $0) }
      .joined()
  }

  /// Candidate builds keep sessions under their isolated launch home; the
  /// installed product uses ~/Library/Application Support/Ark/Harness.
  /// Resolution failures degrade to the product-owned Harness home.
  static func defaultStorageURL(fileManager: FileManager = .default) -> URL {
    let harnessHome: URL
    if let locations = try? JiuzhangShellContract.launchDataLocations(fileManager: fileManager) {
      harnessHome = locations.harnessHome
    } else {
      harnessHome = JiuzhangShellContract.defaultHarnessHome(fileManager: fileManager)
    }
    return harnessHome.appendingPathComponent("terminal-sessions", isDirectory: true)
  }

  @discardableResult
  private func ensureStorageDirectory() -> Bool {
    do {
      try FileManager.default.createDirectory(
        at: storageDirectoryURL,
        withIntermediateDirectories: true,
        attributes: [.posixPermissions: 0o700]
      )
    } catch {
      var isDirectory: ObjCBool = false
      guard FileManager.default.fileExists(
        atPath: storageDirectoryURL.path,
        isDirectory: &isDirectory
      ), isDirectory.boolValue else { return false }
    }
    return chmod(storageDirectoryURL.path, 0o700) == 0
  }

  @discardableResult
  private func writeAtomically(_ data: Data, to destination: URL) -> Bool {
    let temporary = storageDirectoryURL.appendingPathComponent(
      ".\(UUID().uuidString).tmp",
      isDirectory: false
    )
    let descriptor = open(
      temporary.path,
      O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC,
      S_IRUSR | S_IWUSR
    )
    guard descriptor >= 0 else { return false }
    var shouldUnlink = true
    defer {
      close(descriptor)
      if shouldUnlink { unlink(temporary.path) }
    }
    let wroteAll = data.withUnsafeBytes { rawBuffer -> Bool in
      guard let baseAddress = rawBuffer.baseAddress else { return rawBuffer.count == 0 }
      var written = 0
      while written < rawBuffer.count {
        let result = Darwin.write(
          descriptor,
          baseAddress.advanced(by: written),
          rawBuffer.count - written
        )
        guard result > 0 else { return false }
        written += result
      }
      return true
    }
    guard wroteAll, fsync(descriptor) == 0 else { return false }
    guard rename(temporary.path, destination.path) == 0 else { return false }
    shouldUnlink = false
    guard chmod(destination.path, 0o600) == 0 else { return false }
    let directoryDescriptor = open(storageDirectoryURL.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC)
    if directoryDescriptor >= 0 {
      _ = fsync(directoryDescriptor)
      close(directoryDescriptor)
    }
    return true
  }
}
