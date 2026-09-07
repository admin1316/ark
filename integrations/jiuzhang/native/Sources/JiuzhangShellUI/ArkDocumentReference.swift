import CryptoKit
import Foundation
import JiuzhangShellCore

public struct ArkPendingDocument: Identifiable, Equatable, Sendable {
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

public actor ArkDocumentReferenceStore {
  public static let longPasteThreshold = 8_000
  public static let maximumSourceBytes = 50 * 1_024 * 1_024
  public static let maximumExtractedBytes = 16 * 1_024 * 1_024
  public static let maximumPromptCharacters = 12_000

  private let rootURL: URL
  private let fileManager = FileManager.default

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

  public func remove(_ documents: [ArkPendingDocument]) {
    for document in documents {
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
      try data.write(to: target, options: .atomic)
      try fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: target.path)
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
