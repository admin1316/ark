import CryptoKit
import Foundation
import Darwin
import JiuzhangShellCore

public struct ArkPendingDocument: Identifiable, Codable, Equatable, Sendable {
  public let id: String
  public let name: String
  public let sourceBytes: Int
  public let extractedCharacters: Int
  let textURL: URL

  public init(
    id: String,
    name: String,
    sourceBytes: Int,
    extractedCharacters: Int,
    textURL: URL
  ) {
    self.id = id
    self.name = name
    self.sourceBytes = sourceBytes
    self.extractedCharacters = extractedCharacters
    self.textURL = textURL
  }
}

public struct ArkPersistedComposerSubmission: Sendable {
  public let document: ArkComposerDraftDocument
  public let journalIdentifier: String
  public let images: [ArkPromptImage]
  public let documents: [ArkPendingDocument]
}

public actor ArkDocumentReferenceStore {
  public static let longPasteThreshold = 8_000
  public static let maximumSourceBytes = 50 * 1_024 * 1_024
  public static let maximumExtractedBytes = 16 * 1_024 * 1_024
  public static let maximumPromptCharacters = 12_000

  private let rootURL: URL
  private let fileManager = FileManager.default
  private struct CachedAttachments {
    let images: [ArkPromptImage]
    let documents: [ArkPendingDocument]
    let identifier: String
  }
  private var composerJournals: [String: CachedAttachments] = [:]

  public init(rootURL: URL? = nil) {
    if let rootURL {
      self.rootURL = rootURL.standardizedFileURL
    } else {
      do {
        self.rootURL = try JiuzhangShellContract.launchDataLocations().documentReferences
      } catch {
        preconditionFailure("Invalid candidate data configuration; refusing production document storage")
      }
    }
  }

  public func importPastedText(_ text: String, name: String) throws -> ArkPendingDocument {
    try store(text: text, name: name, sourceBytes: text.utf8.count)
  }

  public func importFile(_ sourceURL: URL) throws -> ArkPendingDocument {
    let accessed = sourceURL.startAccessingSecurityScopedResource()
    defer { if accessed { sourceURL.stopAccessingSecurityScopedResource() } }
    let values = try sourceURL.resourceValues(forKeys: [
      .isRegularFileKey,
      .isSymbolicLinkKey,
      .fileSizeKey,
    ])
    guard values.isRegularFile == true, values.isSymbolicLink != true else {
      throw ArkAPIError(message: "只能导入普通文档文件")
    }
    let sourceBytes = values.fileSize ?? 0
    guard sourceBytes > 0, sourceBytes <= Self.maximumSourceBytes else {
      throw ArkAPIError(message: "文档大小超过 50 MiB 限制")
    }
    let ext = sourceURL.pathExtension.lowercased()
    let text: String
    switch ext {
    case "txt", "md", "markdown":
      let data = try Data(contentsOf: sourceURL, options: [.mappedIfSafe])
      guard data.count <= Self.maximumExtractedBytes,
            let value = String(data: data, encoding: .utf8)
      else { throw ArkAPIError(message: "文档不是受支持的 UTF-8 文本或内容过大") }
      text = value
    case "doc", "docx", "odt", "rtf":
      text = try extractOfficeText(from: sourceURL)
    default:
      throw ArkAPIError(message: "仅支持 Word、ODT、RTF、TXT 与 Markdown 文档")
    }
    return try store(text: text, name: sourceURL.lastPathComponent, sourceBytes: sourceBytes)
  }

  public func contextualizedPrompt(
    baseText: String,
    documents: [ArkPendingDocument]
  ) throws -> String {
    guard !documents.isEmpty else { return baseText }
    let metadata = DocumentEnvelope(
      displayText: baseText,
      documents: documents.map {
        DocumentEnvelope.Reference(
          id: $0.id,
          name: $0.name,
          sourceBytes: $0.sourceBytes,
          extractedCharacters: $0.extractedCharacters
        )
      }
    )
    let encodedMetadata = try JSONEncoder().encode(metadata).base64EncodedString()
    var sections: [String] = []
    var remaining = Self.maximumPromptCharacters
    for document in documents where remaining > 0 {
      let text = try String(contentsOf: document.textURL, encoding: .utf8)
      let candidates = chunks(from: text)
      let terms = queryTerms(baseText)
      let selected = candidates.enumerated()
        .map { (index: $0.offset, text: $0.element, score: score($0.element, terms: terms)) }
        .sorted {
          if $0.score != $1.score { return $0.score > $1.score }
          return $0.index < $1.index
        }
        .prefix(4)
        .sorted { $0.index < $1.index }
      var excerpts: [String] = []
      for row in selected where remaining > 0 {
        let excerpt = String(row.text.prefix(remaining))
        guard !excerpt.isEmpty else { continue }
        excerpts.append(excerpt)
        remaining -= excerpt.count
      }
      let digest = document.id.replacingOccurrences(of: "sha256:", with: "")
      sections.append([
        "[Local document: \(document.name) · sha256:\(digest.prefix(12))]",
        "Only bounded relevant excerpts are included; the full document is not in chat context.",
        excerpts.joined(separator: "\n\n--- excerpt ---\n\n"),
      ].joined(separator: "\n"))
    }
    let request = baseText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      ? "请根据以下本地文档相关片段作答。"
      : baseText
    return request + "\n[[ARK_DOCUMENT_CONTEXT_V1:\(encodedMetadata)]]\n\n"
      + sections.joined(separator: "\n\n")
  }

  private struct PendingSubmission: Codable {
    let sessionID: String?
    let document: ArkComposerDraftDocument
    let journalIdentifier: String
    let commandAction: Bool?

    init(sessionID: String?, document: ArkComposerDraftDocument, journalIdentifier: String,
      commandAction: Bool? = nil) {
      self.sessionID = sessionID
      self.document = document
      self.journalIdentifier = journalIdentifier
      self.commandAction = commandAction
    }
  }

  private func pendingSubmissionURL(_ sessionID: String?) -> URL {
    let key = sessionID.map { "session:\($0)" } ?? "new-session:"
    let digest = SHA256.hash(data: Data(key.utf8)).map { String(format: "%02x", $0) }.joined()
    return rootURL.appendingPathComponent("pending-\(digest).json")
  }

  private func composerJournal(sessionID: String?, images: [ArkPromptImage], documents: [ArkPendingDocument], cache: Bool = true) throws -> String {
    let key = pendingSubmissionURL(sessionID).lastPathComponent
    if let cached = composerJournals[key], cached.images == images, cached.documents == documents {
      return cached.identifier
    }
    let identifier = try persistDraftAttachments(images: images, documents: documents)
    if cache { composerJournals[key] = CachedAttachments(images: images, documents: documents, identifier: identifier) }
    return identifier
  }

  /// Share one attachment receipt between autosave and transmitted-payload recovery.
  public func persistComposerState(document: ArkComposerDraftDocument, sessionID: String?,
    images: [ArkPromptImage], documents: [ArkPendingDocument]) throws -> String {
    let identifier = try composerJournal(sessionID: sessionID, images: images, documents: documents)
    do {
      try persistPendingSubmission(document: document, sessionID: sessionID, journalIdentifier: identifier)
      return identifier
    } catch {
      removeDraftAttachments(identifier)
      throw error
    }
  }

  /// The captured payload reaches disk even if autosave has advanced to a later edit.
  public func persistInflightComposerSubmission(document: ArkComposerDraftDocument, sessionID: String?,
    images: [ArkPromptImage], documents: [ArkPendingDocument]) throws -> String {
    let identifier = try composerJournal(sessionID: sessionID, images: images, documents: documents, cache: false)
    do {
      try persistInflightSubmission(document: document, sessionID: sessionID, journalIdentifier: identifier)
      return identifier
    } catch {
      removeDraftAttachments(identifier)
      throw error
    }
  }

  /// The file and its directory reach the filesystem before a prompt may be transmitted.
  public func persistPendingSubmission(document: ArkComposerDraftDocument, sessionID: String?, journalIdentifier: String) throws {
    guard UUID(uuidString: journalIdentifier) != nil else {
      throw ArkAPIError(message: "草稿提交记录无效")
    }
    let value = PendingSubmission(sessionID: sessionID, document: document, journalIdentifier: journalIdentifier)
    let data = try JSONEncoder().encode(value)
    guard data.count <= 4 * 1_024 * 1_024 else { throw ArkAPIError(message: "待提交草稿超过本地保存限制") }
    let target = pendingSubmissionURL(sessionID)
    let previous = try pendingSubmission(at: target)
    if let previous, previous.document == document, previous.journalIdentifier == journalIdentifier { return }
    try durableWrite(data, to: target)
    if let previous, previous.journalIdentifier != journalIdentifier { removeDraftAttachments(previous.journalIdentifier) }
  }

  private func pendingSubmission(at url: URL) throws -> PendingSubmission? {
    guard fileManager.fileExists(atPath: url.path) else { return nil }
    return try JSONDecoder().decode(PendingSubmission.self,
      from: readRegularFile(url, maximumBytes: 4 * 1_024 * 1_024))
  }

  public func restorePendingSubmission(sessionID: String?) throws -> ArkPersistedComposerSubmission? {
    let url = pendingSubmissionURL(sessionID)
    guard fileManager.fileExists(atPath: url.path) else { return nil }
    let data = try readRegularFile(url, maximumBytes: 4 * 1_024 * 1_024)
    let value = try JSONDecoder().decode(PendingSubmission.self, from: data)
    guard value.sessionID == sessionID else {
      throw ArkAPIError(message: "待提交草稿身份不匹配")
    }
    let attachments = try restoreDraftAttachments(value.journalIdentifier)
    composerJournals[pendingSubmissionURL(sessionID).lastPathComponent] = CachedAttachments(
      images: attachments.images, documents: attachments.documents, identifier: value.journalIdentifier)
    return ArkPersistedComposerSubmission(document: value.document, journalIdentifier: value.journalIdentifier,
      images: attachments.images, documents: attachments.documents)
  }

  private func inflightSubmissionURL(_ submissionID: String) throws -> URL {
    guard UUID(uuidString: submissionID) != nil else { throw ArkAPIError(message: "待确认消息身份无效") }
    return rootURL.appendingPathComponent("inflight-\(submissionID).json")
  }

  /// Keep the transmitted payload independently from text edited while its receipt is pending.
  public func persistInflightSubmission(document: ArkComposerDraftDocument, sessionID: String?, journalIdentifier: String) throws {
    try writeInflightSubmission(document: document, sessionID: sessionID,
      journalIdentifier: journalIdentifier, commandAction: nil)
  }

  private func writeInflightSubmission(document: ArkComposerDraftDocument, sessionID: String?,
    journalIdentifier: String, commandAction: Bool?) throws {
    guard let submissionID = document.submissionID else { throw ArkAPIError(message: "待确认消息身份缺失") }
    guard UUID(uuidString: journalIdentifier) != nil else { throw ArkAPIError(message: "草稿提交记录无效") }
    let data = try JSONEncoder().encode(PendingSubmission(sessionID: sessionID, document: document,
      journalIdentifier: journalIdentifier, commandAction: commandAction))
    guard data.count <= 4 * 1_024 * 1_024 else { throw ArkAPIError(message: "待确认消息超过本地限制") }
    let target = try inflightSubmissionURL(submissionID)
    let previous = try pendingSubmission(at: target)
    if let previous, previous.document == document, previous.journalIdentifier == journalIdentifier,
      previous.commandAction == commandAction { return }
    if previous == nil, try inflightSubmissionURLs().count >= 128 {
      throw ArkAPIError(message: "待确认消息数量超过本地恢复限制")
    }
    try durableWrite(data, to: target)
    if let previous, previous.journalIdentifier != journalIdentifier { removeDraftAttachments(previous.journalIdentifier) }
  }

  private func inflightSubmissionURLs() throws -> [URL] {
    guard fileManager.fileExists(atPath: rootURL.path) else { return [] }
    let entries = try fileManager.contentsOfDirectory(at: rootURL, includingPropertiesForKeys: nil)
      .filter { $0.lastPathComponent.hasPrefix("inflight-") && $0.pathExtension == "json" }
      .sorted { $0.lastPathComponent < $1.lastPathComponent }
    guard entries.count <= 128 else { throw ArkAPIError(message: "待确认消息数量超过本地恢复限制") }
    return entries
  }

  private func inflightSubmissions() throws -> [PendingSubmission] {
    try inflightSubmissionURLs().map { entry in
      let data = try readRegularFile(entry, maximumBytes: 4 * 1_024 * 1_024)
      let value = try JSONDecoder().decode(PendingSubmission.self, from: data)
      guard let submissionID = value.document.submissionID,
        try inflightSubmissionURL(submissionID).lastPathComponent == entry.lastPathComponent else {
        throw ArkAPIError(message: "待确认消息记录身份不匹配")
      }
      return value
    }
  }

  private func commandActionIdentity(_ value: PendingSubmission) throws -> String {
    guard let submissionID = value.document.submissionID, UUID(uuidString: submissionID) != nil else {
      throw ArkAPIError(message: "待确认命令身份无效")
    }
    let attachments = try restoreDraftAttachments(value.journalIdentifier)
    guard attachments.images.isEmpty, attachments.documents.isEmpty else {
      throw ArkAPIError(message: "待确认命令附件记录无效")
    }
    return submissionID
  }

  /// A repeated native menu action reuses its durable identity until a terminal receipt arrives.
  func prepareCommandAction(sessionID: String, line: String, invocationID: String? = nil) throws -> String {
    if let invocationID, let existing = try pendingSubmission(at: inflightSubmissionURL(invocationID)) {
      guard existing.commandAction == true, existing.sessionID == sessionID,
        existing.document.submissionID == invocationID, existing.document.text == line else {
        throw ArkAPIError(message: "待确认命令身份对应了不同内容，已阻止发送")
      }
      return try commandActionIdentity(existing)
    }
    let inflight: [PendingSubmission]
    if invocationID == nil { inflight = try inflightSubmissions() }
    else { inflight = [] }
    let matches = invocationID == nil ? inflight.filter {
      $0.commandAction == true && $0.sessionID == sessionID && $0.document.text == line
    } : []
    guard matches.count <= 1 else { throw ArkAPIError(message: "待确认命令身份冲突，请保留记录并检查执行状态") }
    if let previous = matches.first { return try commandActionIdentity(previous) }
    var document = invocationID.map { ArkComposerDraftDocument(commandLine: line, invocationID: $0) }
      ?? ArkComposerDraftDocument(text: line)
    let submissionID = document.ensureSubmissionID()
    let journal = try composerJournal(sessionID: sessionID, images: [], documents: [], cache: false)
    do {
      try writeInflightSubmission(document: document, sessionID: sessionID,
        journalIdentifier: journal, commandAction: true)
      return submissionID
    } catch {
      removeDraftAttachments(journal)
      throw error
    }
  }

  public func restoreInflightSubmissions(sessionID: String?) throws -> [ArkPersistedComposerSubmission] {
    try inflightSubmissions().compactMap { value in
      guard value.commandAction != true else { return nil }
      guard value.sessionID == sessionID || value.document.submissionID == sessionID else { return nil }
      let attachments = try restoreDraftAttachments(value.journalIdentifier)
      return ArkPersistedComposerSubmission(document: value.document, journalIdentifier: value.journalIdentifier,
        images: attachments.images, documents: attachments.documents)
    }
  }

  public func removeInflightSubmission(_ submissionID: String?) throws {
    guard let submissionID else { return }
    let target = try inflightSubmissionURL(submissionID)
    guard let previous = try pendingSubmission(at: target) else { return }
    try fileManager.removeItem(at: target)
    try synchronizeRoot()
    removeDraftAttachments(previous.journalIdentifier)
  }

  /// A source snapshot requires a matching document and attachments; nil retains receipt-only acknowledgement.
  public func acknowledgePendingSubmission(sessionID: String?, submissionID: String?,
    matchingDocument: ArkComposerDraftDocument? = nil, matchingImages: [ArkPromptImage] = [],
    matchingDocuments: [ArkPendingDocument] = []) throws {
    let target = pendingSubmissionURL(sessionID)
    guard fileManager.fileExists(atPath: target.path) else { return }
    let data = try readRegularFile(target, maximumBytes: 4 * 1_024 * 1_024)
    let value = try JSONDecoder().decode(PendingSubmission.self, from: data)
    guard value.document.submissionID == submissionID else { return }
    if let matchingDocument {
      guard value.document == matchingDocument else { return }
      let attachments = try restoreDraftAttachments(value.journalIdentifier)
      guard attachments.images == matchingImages, attachments.documents == matchingDocuments else { return }
    }
    _ = try persistComposerState(document: ArkComposerDraftDocument(), sessionID: sessionID, images: [], documents: [])
  }

  /// Commit an exact native draft update before retiring the command's durable identity.
  func acknowledgeCommandDraft(sessionID: String, previous: ArkComposerDraftDocument,
    replacement: ArkComposerDraftDocument) throws -> Bool {
    guard let value = try pendingSubmission(at: pendingSubmissionURL(sessionID)) else {
      throw ArkAPIError(message: "命令已完成，但草稿保存尚未确认；原命令回执已保留")
    }
    guard value.document == previous else { return false }
    try persistPendingSubmission(document: replacement, sessionID: sessionID,
      journalIdentifier: value.journalIdentifier)
    return true
  }

  public func removePendingSubmission(sessionID: String?, submissionID: String? = nil) throws {
    let target = pendingSubmissionURL(sessionID)
    guard let previous = try pendingSubmission(at: target) else { return }
    if let submissionID, previous.document.submissionID != submissionID { return }
    try fileManager.removeItem(at: target)
    try synchronizeRoot()
    composerJournals.removeValue(forKey: target.lastPathComponent)
    removeDraftAttachments(previous.journalIdentifier)
  }

  /// A retired writer cannot remove the manifest committed by a newer generation.
  func removePendingSubmission(sessionID: String?, matchingDocument document: ArkComposerDraftDocument,
    journalIdentifier: String) throws {
    let target = pendingSubmissionURL(sessionID)
    guard let current = try pendingSubmission(at: target), current.document == document,
      current.journalIdentifier == journalIdentifier else { return }
    try removePendingSubmission(sessionID: sessionID)
  }

  private func durableWrite(_ data: Data, to target: URL) throws {
    try ensureRoot()
    let temporary = rootURL.appendingPathComponent(".write-\(UUID().uuidString)")
    let fd = Darwin.open(temporary.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
    guard fd >= 0 else { throw ArkAPIError(message: "草稿无法写入本地存储") }
    let file = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
    defer { try? file.close(); try? fileManager.removeItem(at: temporary) }
    try file.write(contentsOf: data)
    try file.synchronize()
    guard Darwin.rename(temporary.path, target.path) == 0 else { throw ArkAPIError(message: "草稿无法原子保存") }
    try synchronizeRoot()
  }

  private func synchronizeRoot() throws {
    let fd = Darwin.open(rootURL.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
    guard fd >= 0 else { throw ArkAPIError(message: "草稿目录无法同步") }
    defer { Darwin.close(fd) }
    guard Darwin.fsync(fd) == 0 else { throw ArkAPIError(message: "草稿目录同步失败") }
  }

  private struct StoredImage: Codable {
    let mediaType: String
    let data: Data
    let name: String?
  }
  private struct StoredAttachments: Codable {
    let images: [StoredImage]
    let documents: [ArkPendingDocument]
  }

  /// Commit attachment bytes and local document references before a submission can leave the app.
  public func persistDraftAttachments(images: [ArkPromptImage], documents: [ArkPendingDocument]) throws -> String {
    try ensureRoot()
    guard images.count <= 20, documents.count <= 8,
      images.allSatisfy({ !$0.data.isEmpty && $0.data.count <= 5 * 1_024 * 1_024 }),
      images.reduce(0, { $0 + $1.data.count }) <= 100 * 1_024 * 1_024 else {
      throw ArkAPIError(message: "草稿附件超过本地保存限制")
    }
    let snapshot = StoredAttachments(images: images.map {
      StoredImage(mediaType: $0.mediaType.rawValue, data: $0.data, name: $0.name)
    }, documents: documents)
    let identifier = UUID().uuidString.lowercased()
    let target = rootURL.appendingPathComponent("draft-\(identifier).json")
    let refs = rootURL.appendingPathComponent("draft-\(identifier).refs")
    do {
      try durableWrite(JSONEncoder().encode(documents.map(\.id)), to: refs)
      try durableWrite(JSONEncoder().encode(snapshot), to: target)
      return identifier
    } catch {
      removeDraftAttachments(identifier)
      throw error
    }
  }

  /// Restore only regular files inside this store; journal identifiers cannot choose a path.
  public func restoreDraftAttachments(_ identifier: String) throws -> (images: [ArkPromptImage], documents: [ArkPendingDocument]) {
    guard UUID(uuidString: identifier) != nil else { throw ArkAPIError(message: "草稿附件记录无效") }
    let target = rootURL.appendingPathComponent("draft-\(identifier).json")
    let data = try readRegularFile(target, maximumBytes: 140 * 1_024 * 1_024)
    let stored = try JSONDecoder().decode(StoredAttachments.self, from: data)
    guard stored.images.count <= 20, stored.documents.count <= 8 else {
      throw ArkAPIError(message: "草稿附件记录超过限制")
    }
    let images = try stored.images.map { item -> ArkPromptImage in
      guard let type = ArkImageMediaType(rawValue: item.mediaType), !item.data.isEmpty,
        item.data.count <= 5 * 1_024 * 1_024 else { throw ArkAPIError(message: "草稿图片记录无效") }
      return ArkPromptImage(mediaType: type, data: item.data, name: item.name)
    }
    guard images.reduce(0, { $0 + $1.data.count }) <= 100 * 1_024 * 1_024 else {
      throw ArkAPIError(message: "草稿图片记录超过限制")
    }
    for document in stored.documents {
      let digest = document.id.replacingOccurrences(of: "sha256:", with: "")
      guard digest.count == 64, digest.allSatisfy({ $0.isHexDigit }),
        document.textURL.standardizedFileURL == rootURL.appendingPathComponent("\(digest).txt").standardizedFileURL else {
        throw ArkAPIError(message: "草稿文档引用不属于本地存储")
      }
      let content = try readRegularFile(document.textURL, maximumBytes: Self.maximumExtractedBytes)
      guard SHA256.hash(data: content).map({ String(format: "%02x", $0) }).joined() == digest else {
        throw ArkAPIError(message: "草稿文档内容已发生变化")
      }
    }
    return (images, stored.documents)
  }

  public func removeDraftAttachments(_ identifier: String) {
    guard UUID(uuidString: identifier) != nil,
      let entries = try? fileManager.contentsOfDirectory(at: rootURL, includingPropertiesForKeys: nil) else { return }
    for entry in entries where (entry.lastPathComponent.hasPrefix("pending-") || entry.lastPathComponent.hasPrefix("inflight-")) && entry.pathExtension == "json" {
      guard let data = try? readRegularFile(entry, maximumBytes: 4 * 1_024 * 1_024),
        let pending = try? JSONDecoder().decode(PendingSubmission.self, from: data) else { return }
      if pending.journalIdentifier == identifier { return }
    }
    try? fileManager.removeItem(at: rootURL.appendingPathComponent("draft-\(identifier).json"))
    try? fileManager.removeItem(at: rootURL.appendingPathComponent("draft-\(identifier).refs"))
    for key in Array(composerJournals.keys) where composerJournals[key]?.identifier == identifier {
      composerJournals.removeValue(forKey: key)
    }
  }

  private func readRegularFile(_ url: URL, maximumBytes: Int) throws -> Data {
    let fd = Darwin.open(url.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
    guard fd >= 0 else { throw ArkAPIError(message: "草稿附件文件无法读取") }
    let file = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
    defer { try? file.close() }
    var metadata = stat()
    guard fstat(fd, &metadata) == 0, (metadata.st_mode & S_IFMT) == S_IFREG,
      metadata.st_size >= 0, metadata.st_size <= maximumBytes else {
      throw ArkAPIError(message: "草稿附件不是受支持的普通文件")
    }
    let data = try file.read(upToCount: maximumBytes + 1) ?? Data()
    guard data.count <= maximumBytes else { throw ArkAPIError(message: "草稿附件文件超过限制") }
    return data
  }

  public func remove(_ documents: [ArkPendingDocument]) {
    // Inactive drafts from another launch may still own the same content-addressed text.
    guard let entries = try? fileManager.contentsOfDirectory(at: rootURL, includingPropertiesForKeys: nil) else { return }
    var referenced = Set<String>()
    for entry in entries where entry.lastPathComponent.hasPrefix("draft-") && entry.pathExtension == "refs" {
      guard let data = try? readRegularFile(entry, maximumBytes: 8_192),
        let identifiers = try? JSONDecoder().decode([String].self, from: data) else { return }
      referenced.formUnion(identifiers)
    }
    for document in documents where !referenced.contains(document.id) {
      guard document.textURL.deletingLastPathComponent().standardizedFileURL == rootURL.standardizedFileURL else { continue }
      try? fileManager.removeItem(at: document.textURL)
    }
  }

  private func ensureRoot() throws {
    try fileManager.createDirectory(at: rootURL, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    try fileManager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: rootURL.path)
  }

  private func store(text: String, name: String, sourceBytes: Int) throws -> ArkPendingDocument {
    let data = Data(text.utf8)
    guard !data.isEmpty, data.count <= Self.maximumExtractedBytes else {
      throw ArkAPIError(message: "提取后的文档内容为空或超过 16 MiB 限制")
    }
    try ensureRoot()
    let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    let target = rootURL.appendingPathComponent("\(digest).txt", isDirectory: false)
    if !fileManager.fileExists(atPath: target.path) {
      try durableWrite(data, to: target)
    }
    return ArkPendingDocument(
      id: "sha256:\(digest)",
      name: name,
      sourceBytes: sourceBytes,
      extractedCharacters: text.count,
      textURL: target
    )
  }

  private func extractOfficeText(from sourceURL: URL) throws -> String {
    try ensureRoot()
    let temporary = rootURL.appendingPathComponent(".extract-\(UUID().uuidString).txt")
    defer { try? fileManager.removeItem(at: temporary) }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/textutil")
    process.arguments = ["-convert", "txt", "-output", temporary.path, "--", sourceURL.path]
    let errors = Pipe()
    process.standardOutput = FileHandle.nullDevice
    process.standardError = errors
    try process.run()
    process.waitUntilExit()
    guard process.terminationStatus == 0 else {
      let detail = String(decoding: errors.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        .trimmingCharacters(in: .whitespacesAndNewlines)
      throw ArkAPIError(message: detail.isEmpty ? "Word 文档提取失败" : detail)
    }
    let values = try temporary.resourceValues(forKeys: [.fileSizeKey])
    guard let bytes = values.fileSize, bytes > 0, bytes <= Self.maximumExtractedBytes else {
      throw ArkAPIError(message: "提取后的 Word 文档为空或超过 16 MiB 限制")
    }
    return try String(contentsOf: temporary, encoding: .utf8)
  }

  private func chunks(from text: String, target: Int = 2_400) -> [String] {
    var result: [String] = []
    var buffer = ""
    for paragraph in text.components(separatedBy: "\n\n") {
      if paragraph.count > target {
        if !buffer.isEmpty { result.append(buffer); buffer = "" }
        var start = paragraph.startIndex
        while start < paragraph.endIndex {
          let end = paragraph.index(start, offsetBy: target, limitedBy: paragraph.endIndex)
            ?? paragraph.endIndex
          result.append(String(paragraph[start..<end]))
          start = end
        }
      } else if buffer.count + paragraph.count + 2 > target {
        if !buffer.isEmpty { result.append(buffer) }
        buffer = paragraph
      } else {
        if !buffer.isEmpty { buffer += "\n\n" }
        buffer += paragraph
      }
    }
    if !buffer.isEmpty { result.append(buffer) }
    return result.filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
  }

  private func queryTerms(_ value: String) -> [String] {
    var terms = Set<String>()
    for word in value.lowercased().split(whereSeparator: { !$0.isLetter && !$0.isNumber }) {
      let characters = Array(word)
      if characters.count >= 2 { terms.insert(String(word)) }
      if characters.count >= 3 {
        for index in 0..<(characters.count - 1) {
          terms.insert(String(characters[index...index + 1]))
        }
      }
    }
    return Array(terms)
  }

  private func score(_ value: String, terms: [String]) -> Int {
    guard !terms.isEmpty else { return 0 }
    let normalized = value.lowercased()
    return terms.reduce(0) { result, term in
      result + max(0, normalized.components(separatedBy: term).count - 1) * max(1, term.count)
    }
  }

  private struct DocumentEnvelope: Codable {
    struct Reference: Codable {
      let id: String
      let name: String
      let sourceBytes: Int
      let extractedCharacters: Int
    }

    let displayText: String
    let documents: [Reference]
  }
}
