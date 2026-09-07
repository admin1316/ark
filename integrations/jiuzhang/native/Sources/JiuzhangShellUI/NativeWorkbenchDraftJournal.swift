import CryptoKit
import Darwin
import Foundation
import JiuzhangShellCore

struct NativeWorkbenchDraftRecord: Codable, Equatable, Identifiable, Sendable {
  static let currentVersion = 1

  let version: Int
  let workspaceRoot: String
  let filePath: String
  let savedBaseline: String
  let draftText: String
  let updatedAt: Date

  var id: String { workspaceRoot + "\u{0}" + filePath }

  init(
    workspaceRoot: String,
    filePath: String,
    savedBaseline: String,
    draftText: String,
    updatedAt: Date = Date()
  ) {
    version = Self.currentVersion
    self.workspaceRoot = workspaceRoot
    self.filePath = filePath
    self.savedBaseline = savedBaseline
    self.draftText = draftText
    self.updatedAt = updatedAt
  }
}

enum NativeWorkbenchDraftJournalError: LocalizedError {
  case pathOutsideWorkspace
  case recordTooLarge
  case invalidRecord
  case fileSystem(String)

  var errorDescription: String? {
    switch self {
    case .pathOutsideWorkspace:
      return "Draft path is outside the workspace root."
    case .recordTooLarge:
      return "Recovery draft exceeds the bounded journal record size."
    case .invalidRecord:
      return "Recovery draft is invalid."
    case .fileSystem(let message):
      return message
    }
  }
}

/// Durable, local-only recovery storage for unsaved Native Files buffers.
///
/// Every record is identified by canonical workspace + file path, written
/// atomically with mode 0600, and pruned by both record count and total bytes.
/// The journal never writes the user's source file and never crosses the
/// workspace root.
final class NativeWorkbenchDraftJournal: @unchecked Sendable {
  static let defaultMaximumRecordBytes = 20 * 1024 * 1024
  static let defaultMaximumTotalBytes = 64 * 1024 * 1024
  static let defaultMaximumRecords = 50

  let storageURL: URL
  private let maximumRecordBytes: Int
  private let maximumTotalBytes: Int
  private let maximumRecords: Int
  private let encoder: JSONEncoder
  private let decoder: JSONDecoder
  private let lock = NSLock()

  init(
    storageURL: URL? = nil,
    maximumRecordBytes: Int = defaultMaximumRecordBytes,
    maximumTotalBytes: Int = defaultMaximumTotalBytes,
    maximumRecords: Int = defaultMaximumRecords
  ) {
    self.storageURL = storageURL ?? Self.defaultStorageURL()
    self.maximumRecordBytes = maximumRecordBytes
    self.maximumTotalBytes = maximumTotalBytes
    self.maximumRecords = maximumRecords
    encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .iso8601
    decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
  }

  func save(_ record: NativeWorkbenchDraftRecord) throws {
    try lock.withLock {
      let normalized = try normalizedRecord(record)
      if normalized.draftText == normalized.savedBaseline {
        try removeRecordLocked(workspaceRoot: normalized.workspaceRoot, filePath: normalized.filePath)
        return
      }
      let data = try encoder.encode(normalized)
      guard data.count <= maximumRecordBytes else {
        throw NativeWorkbenchDraftJournalError.recordTooLarge
      }
      try ensureStorageDirectoryLocked()
      let destination = recordURL(
        workspaceRoot: normalized.workspaceRoot,
        filePath: normalized.filePath
      )
      try atomicWriteLocked(data, to: destination)
      try pruneLocked()
    }
  }

  func load(workspaceRoot: URL) throws -> [NativeWorkbenchDraftRecord] {
    try lock.withLock {
      let canonicalRoot = Self.canonicalPath(workspaceRoot)
      guard FileManager.default.fileExists(atPath: storageURL.path) else { return [] }
      let urls = try FileManager.default.contentsOfDirectory(
        at: storageURL,
        includingPropertiesForKeys: [.isRegularFileKey],
        options: [.skipsHiddenFiles]
      )
      return urls
        .filter { $0.pathExtension == "json" }
        .compactMap { url -> NativeWorkbenchDraftRecord? in
          guard let data = try? Data(contentsOf: url),
                let record = try? decoder.decode(NativeWorkbenchDraftRecord.self, from: data),
                record.version == NativeWorkbenchDraftRecord.currentVersion,
                record.workspaceRoot == canonicalRoot,
                Self.isContained(filePath: record.filePath, in: canonicalRoot),
                record.draftText != record.savedBaseline
          else { return nil }
          return record
        }
        .sorted { $0.updatedAt > $1.updatedAt }
    }
  }

  func discard(workspaceRoot: URL, fileURL: URL) throws {
    try lock.withLock {
      let root = Self.canonicalPath(workspaceRoot)
      let file = Self.canonicalPath(fileURL)
      guard Self.isContained(filePath: file, in: root) else {
        throw NativeWorkbenchDraftJournalError.pathOutsideWorkspace
      }
      try removeRecordLocked(workspaceRoot: root, filePath: file)
    }
  }

  func recordURL(workspaceRoot: String, filePath: String) -> URL {
    let identity = workspaceRoot + "\u{0}" + filePath
    let digest = SHA256.hash(data: Data(identity.utf8))
      .map { String(format: "%02x", $0) }
      .joined()
    return storageURL.appendingPathComponent(digest).appendingPathExtension("json")
  }

  private func normalizedRecord(
    _ record: NativeWorkbenchDraftRecord
  ) throws -> NativeWorkbenchDraftRecord {
    guard record.version == NativeWorkbenchDraftRecord.currentVersion else {
      throw NativeWorkbenchDraftJournalError.invalidRecord
    }
    let root = Self.canonicalPath(URL(fileURLWithPath: record.workspaceRoot, isDirectory: true))
    let file = Self.canonicalPath(URL(fileURLWithPath: record.filePath))
    guard Self.isContained(filePath: file, in: root) else {
      throw NativeWorkbenchDraftJournalError.pathOutsideWorkspace
    }
    return NativeWorkbenchDraftRecord(
      workspaceRoot: root,
      filePath: file,
      savedBaseline: record.savedBaseline,
      draftText: record.draftText,
      updatedAt: record.updatedAt
    )
  }

  private func ensureStorageDirectoryLocked() throws {
    do {
      try FileManager.default.createDirectory(
        at: storageURL,
        withIntermediateDirectories: true,
        attributes: [.posixPermissions: 0o700]
      )
      guard chmod(storageURL.path, 0o700) == 0 else {
        throw NativeWorkbenchDraftJournalError.fileSystem(
          String(cString: strerror(errno))
        )
      }
    } catch let error as NativeWorkbenchDraftJournalError {
      throw error
    } catch {
      throw NativeWorkbenchDraftJournalError.fileSystem(error.localizedDescription)
    }
  }

  private func atomicWriteLocked(_ data: Data, to destination: URL) throws {
    let temporary = storageURL.appendingPathComponent(".\(UUID().uuidString).tmp")
    let descriptor = open(
      temporary.path,
      O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC,
      S_IRUSR | S_IWUSR
    )
    guard descriptor >= 0 else {
      throw NativeWorkbenchDraftJournalError.fileSystem(String(cString: strerror(errno)))
    }
    var shouldUnlink = true
    defer {
      close(descriptor)
      if shouldUnlink { unlink(temporary.path) }
    }
    try data.withUnsafeBytes { rawBuffer in
      guard let baseAddress = rawBuffer.baseAddress else { return }
      var written = 0
      while written < rawBuffer.count {
        let result = Darwin.write(
          descriptor,
          baseAddress.advanced(by: written),
          rawBuffer.count - written
        )
        guard result > 0 else {
          throw NativeWorkbenchDraftJournalError.fileSystem(
            String(cString: strerror(errno))
          )
        }
        written += result
      }
    }
    guard fsync(descriptor) == 0 else {
      throw NativeWorkbenchDraftJournalError.fileSystem(String(cString: strerror(errno)))
    }
    guard rename(temporary.path, destination.path) == 0 else {
      throw NativeWorkbenchDraftJournalError.fileSystem(String(cString: strerror(errno)))
    }
    shouldUnlink = false
    guard chmod(destination.path, 0o600) == 0 else {
      throw NativeWorkbenchDraftJournalError.fileSystem(String(cString: strerror(errno)))
    }
    let directoryDescriptor = open(storageURL.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC)
    if directoryDescriptor >= 0 {
      _ = fsync(directoryDescriptor)
      close(directoryDescriptor)
    }
  }

  private func removeRecordLocked(workspaceRoot: String, filePath: String) throws {
    let url = recordURL(workspaceRoot: workspaceRoot, filePath: filePath)
    guard FileManager.default.fileExists(atPath: url.path) else { return }
    do {
      try FileManager.default.removeItem(at: url)
    } catch {
      throw NativeWorkbenchDraftJournalError.fileSystem(error.localizedDescription)
    }
  }

  private func pruneLocked() throws {
    let keys: Set<URLResourceKey> = [.fileSizeKey, .contentModificationDateKey, .isRegularFileKey]
    var entries = try FileManager.default.contentsOfDirectory(
      at: storageURL,
      includingPropertiesForKeys: Array(keys),
      options: [.skipsHiddenFiles]
    ).compactMap { url -> (URL, Int, Date)? in
      guard url.pathExtension == "json",
            let values = try? url.resourceValues(forKeys: keys),
            values.isRegularFile == true
      else { return nil }
      return (url, values.fileSize ?? 0, values.contentModificationDate ?? .distantPast)
    }
    entries.sort { $0.2 < $1.2 }
    var total = entries.reduce(0) { $0 + $1.1 }
    while entries.count > maximumRecords || total > maximumTotalBytes {
      let removed = entries.removeFirst()
      try FileManager.default.removeItem(at: removed.0)
      total -= removed.1
    }
  }

  private static func defaultStorageURL() -> URL {
    do {
      let locations = try JiuzhangShellContract.launchDataLocations()
      if locations.isCandidate { return locations.workbenchDrafts }
    } catch {
      preconditionFailure("Invalid candidate data configuration; refusing production draft storage")
    }
    let applicationSupport = FileManager.default.urls(
      for: .applicationSupportDirectory,
      in: .userDomainMask
    ).first ?? FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent("Library/Application Support", isDirectory: true)
    return applicationSupport
      .appendingPathComponent("Ark", isDirectory: true)
      .appendingPathComponent("Workbench Drafts", isDirectory: true)
  }

  private static func canonicalPath(_ url: URL) -> String {
    url.standardizedFileURL.resolvingSymlinksInPath().path
  }

  private static func isContained(filePath: String, in rootPath: String) -> Bool {
    filePath == rootPath || filePath.hasPrefix(rootPath + "/")
  }
}

/// Application-owned termination bridge for the currently mounted Workbench.
///
/// SwiftUI owns each Workbench model as a `StateObject`; AppDelegate therefore
/// owns only this coordinator, while mounted models register weak flush
/// callbacks. Flush failures are returned to the lifecycle owner so it can veto
/// teardown without logging draft contents.
enum NativeWorkbenchDraftFlushOutcome {
  case flushed
  case unavailable
  case failed(String)
}

@MainActor
public final class NativeWorkbenchDraftFlushCoordinator {
  private var flushers: [UUID: @MainActor () async -> NativeWorkbenchDraftFlushOutcome] = [:]

  public init() {}

  @discardableResult
  func register(
    _ flush: @escaping @MainActor () async -> NativeWorkbenchDraftFlushOutcome
  ) -> UUID {
    let id = UUID()
    flushers[id] = flush
    return id
  }

  func unregister(_ id: UUID) {
    flushers.removeValue(forKey: id)
  }

  /// Flush every mounted Workbench and return the first failure after giving
  /// all independent draft owners a chance to persist their buffers.
  public func flush() async -> String? {
    let activeFlushers = Array(flushers)
    var firstError: String?
    var unavailableIDs: [UUID] = []
    for (id, flush) in activeFlushers {
      switch await flush() {
      case .flushed:
        break
      case .unavailable:
        unavailableIDs.append(id)
      case .failed(let error):
        if firstError == nil { firstError = error }
      }
    }
    unavailableIDs.forEach { flushers.removeValue(forKey: $0) }
    return firstError
  }
}

actor NativeWorkbenchDraftWriter {
  private let journal: NativeWorkbenchDraftJournal
  private let debounceNanoseconds: UInt64
  private var highestMutationSequence: [String: UInt64] = [:]

  init(
    journal: NativeWorkbenchDraftJournal,
    debounceNanoseconds: UInt64 = 350_000_000
  ) {
    self.journal = journal
    self.debounceNanoseconds = debounceNanoseconds
  }

  func schedule(
    _ record: NativeWorkbenchDraftRecord,
    mutationSequence: UInt64
  ) async -> String? {
    let key = record.id
    guard admit(mutationSequence, for: key) else { return nil }
    if debounceNanoseconds > 0 {
      try? await Task.sleep(nanoseconds: debounceNanoseconds)
    }
    guard highestMutationSequence[key] == mutationSequence else { return nil }
    return save(record)
  }

  func writeImmediately(
    _ record: NativeWorkbenchDraftRecord,
    mutationSequence: UInt64
  ) -> String? {
    guard admit(mutationSequence, for: record.id) else { return nil }
    return save(record)
  }

  func clear(
    workspaceRoot: URL,
    fileURL: URL,
    mutationSequence: UInt64
  ) -> String? {
    let key = NativeWorkbenchDraftRecord(
      workspaceRoot: workspaceRoot.standardizedFileURL.resolvingSymlinksInPath().path,
      filePath: fileURL.standardizedFileURL.resolvingSymlinksInPath().path,
      savedBaseline: "",
      draftText: ""
    ).id
    guard admit(mutationSequence, for: key) else { return nil }
    do {
      try journal.discard(workspaceRoot: workspaceRoot, fileURL: fileURL)
      return nil
    } catch {
      return error.localizedDescription
    }
  }

  private func admit(_ mutationSequence: UInt64, for key: String) -> Bool {
    guard mutationSequence > (highestMutationSequence[key] ?? 0) else { return false }
    highestMutationSequence[key] = mutationSequence
    return true
  }

  private func save(_ record: NativeWorkbenchDraftRecord) -> String? {
    do {
      try journal.save(record)
      return nil
    } catch {
      return error.localizedDescription
    }
  }
}

private extension NSLock {
  func withLock<T>(_ body: () throws -> T) rethrows -> T {
    lock()
    defer { unlock() }
    return try body()
  }
}
