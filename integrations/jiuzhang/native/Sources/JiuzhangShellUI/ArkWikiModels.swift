import Foundation
import Darwin
import JiuzhangShellCore

/// One Markdown page loaded by the native knowledge workspace.
public struct ArkWikiPage: Identifiable, Equatable, Sendable {
  public let id: String
  public let title: String
  public let relativePath: String
  public let category: String
  public let community: Int?
  public let body: String
  public let links: [String]
  public let byteCount: Int

  public init(
    id: String,
    title: String,
    relativePath: String,
    category: String,
    community: Int? = nil,
    body: String,
    links: [String],
    byteCount: Int
  ) {
    self.id = id
    self.title = title
    self.relativePath = relativePath
    self.category = category
    self.community = community
    self.body = body
    self.links = links
    self.byteCount = byteCount
  }
}

/// One directed wiki-link edge rendered by the native graph canvas.
public struct ArkWikiEdge: Identifiable, Equatable, Sendable {
  public let source: String
  public let target: String
  public var id: String { "\(source)->\(target)" }

  public init(source: String, target: String) {
    self.source = source
    self.target = target
  }
}

/// Selection-relative presentation state for one graph node.
public enum ArkWikiGraphNodeEmphasis: Equatable, Sendable {
  case normal
  case selected
  case neighbor
  case receded
}

/// Pure graph focus projection shared by the native canvas and behavior contracts.
/// Edges are treated as undirected for visual adjacency while their stored direction
/// remains unchanged for the knowledge model.
public struct ArkWikiGraphFocus: Equatable, Sendable {
  public let selectedID: String?
  public let neighborIDs: Set<String>
  public let emphasizedEdgeIDs: Set<String>

  public init(selectedID: String?, edges: [ArkWikiEdge]) {
    self.selectedID = selectedID
    guard let selectedID else {
      neighborIDs = []
      emphasizedEdgeIDs = []
      return
    }

    var neighbors = Set<String>()
    var emphasized = Set<String>()
    for edge in edges where edge.source == selectedID || edge.target == selectedID {
      emphasized.insert(edge.id)
      if edge.source != selectedID { neighbors.insert(edge.source) }
      if edge.target != selectedID { neighbors.insert(edge.target) }
    }
    neighborIDs = neighbors
    emphasizedEdgeIDs = emphasized
  }

  public func nodeEmphasis(for id: String) -> ArkWikiGraphNodeEmphasis {
    guard let selectedID else { return .normal }
    if id == selectedID { return .selected }
    if neighborIDs.contains(id) { return .neighbor }
    return .receded
  }

  public func emphasizes(_ edge: ArkWikiEdge) -> Bool {
    emphasizedEdgeIDs.contains(edge.id)
  }
}

/// Durable viewport math for the native graph. Gesture deltas are committed only
/// when a gesture ends, so ordinary SwiftUI body invalidation cannot move the graph.
public struct ArkWikiGraphViewport: Equatable, Sendable {
  public static let minimumZoom = 0.45
  public static let maximumZoom = 3.0

  public private(set) var zoom: Double
  public private(set) var panX: Double
  public private(set) var panY: Double

  public init(zoom: Double = 1, panX: Double = 0, panY: Double = 0) {
    self.zoom = Self.clampedZoom(zoom)
    self.panX = panX.isFinite ? panX : 0
    self.panY = panY.isFinite ? panY : 0
  }

  public static func clampedZoom(_ value: Double) -> Double {
    guard value.isFinite, value > 0 else { return 1 }
    return min(maximumZoom, max(minimumZoom, value))
  }

  public func projectedZoom(multiplier: Double) -> Double {
    guard multiplier.isFinite, multiplier > 0 else { return zoom }
    return Self.clampedZoom(zoom * multiplier)
  }

  public mutating func magnify(by multiplier: Double) {
    zoom = projectedZoom(multiplier: multiplier)
  }

  public mutating func translate(x: Double, y: Double) {
    guard x.isFinite, y.isFinite else { return }
    panX += x
    panY += y
  }

  public mutating func reset() {
    zoom = 1
    panX = 0
    panY = 0
  }
}

/// Stable process-independent seeds for the deterministic idle layout.
public enum ArkWikiGraphLayout {
  public static func stableSeed(for id: String) -> UInt64 {
    var hash: UInt64 = 14_695_981_039_346_656_037
    for byte in id.utf8 {
      hash ^= UInt64(byte)
      hash &*= 1_099_511_628_211
    }
    return hash
  }

  public static func phase(for id: String) -> Double {
    Double(stableSeed(for: id) % 9_973) / 9_973.0 * Double.pi * 2
  }

  public static func sizeVariation(for id: String) -> Int {
    Int(stableSeed(for: id) % 11)
  }
}

/// One knowledge-governance review shown in the native inspector.
public struct ArkWikiReviewAction: Identifiable, Equatable, Sendable {
  public let action: String
  public let label: String
  public var id: String { action }
}

/// One knowledge-governance review shown in the native inspector.
public struct ArkWikiReview: Identifiable, Equatable, Sendable {
  public let id: String
  public let title: String
  public let type: String
  public let description: String
  public let affectedPages: [String]
  public let actions: [ArkWikiReviewAction]
  public let resolved: Bool
}

/// File-backed native wiki loader; generated and governance directories stay hidden.
public enum ArkWikiLoader {
  /// Index graph metadata by canonical Wiki path; the first Host row owns a
  /// repeated path because later rows cannot disambiguate the same file.
  public static func firstGraphNodeByPath(_ rows: [JSONValue]) -> [String: JSONValue] {
    var result: [String: JSONValue] = [:]
    for row in rows {
      guard let path = row["path"]?.stringValue,
            !path.isEmpty,
            result[path] == nil
      else { continue }
      result[path] = row
    }
    return result
  }

  /// Preserve the Host tree traversal order while retaining the first row for
  /// each file path and dropping rows that cannot identify a file.
  public static func uniqueFileRowsByPath(_ rows: [JSONValue]) -> [JSONValue] {
    var seen = Set<String>()
    return rows.filter { row in
      guard let path = row["path"]?.stringValue, !path.isEmpty else { return false }
      return seen.insert(path).inserted
    }
  }

  /// Project bilingual Markdown pairs into one interface language. When both
  /// `page.md` and `page.zh.md` exist, Chinese selects the latter and every
  /// other registered language selects the former. Unpaired pages remain
  /// visible so a partial knowledge base never loses content.
  public static func localizedFileRows(
    _ rows: [JSONValue],
    language: ArkLanguagePreference
  ) -> [JSONValue] {
    let unique = uniqueFileRowsByPath(rows)
    let paths = Set(unique.compactMap { $0["path"]?.stringValue })
    return unique.filter { row in
      guard let path = row["path"]?.stringValue else { return false }
      return keepsLocalizedPath(path, allPaths: paths, language: language)
    }
  }

  /// Preserve Wiki list order and retain the first page for an ambiguous graph
  /// identity so edges and selection keep one deterministic target.
  public static func uniquePagesByID(_ pages: [ArkWikiPage]) -> [ArkWikiPage] {
    var seen = Set<String>()
    return pages.filter { seen.insert($0.id).inserted }
  }

  /// Apply the same single-language projection to file-backed fallback pages.
  public static func localizedPages(
    _ pages: [ArkWikiPage],
    language: ArkLanguagePreference
  ) -> [ArkWikiPage] {
    let paths = Set(pages.map(\.relativePath))
    let localized = pages.filter {
      keepsLocalizedPath($0.relativePath, allPaths: paths, language: language)
    }
    return uniquePagesByID(localized)
  }

  /// Retain only graph edges whose endpoints both survive language projection.
  public static func visibleEdges(_ edges: [ArkWikiEdge], pages: [ArkWikiPage]) -> [ArkWikiEdge] {
    let visible = Set(pages.map(\.id))
    return edges.filter { visible.contains($0.source) && visible.contains($0.target) }
  }

  /// Remove the localization suffix from a filename used as a fallback title.
  public static func fallbackTitle(path: String, name: String?) -> String {
    let candidate = name.flatMap { $0.isEmpty ? nil : $0 }
      ?? URL(fileURLWithPath: path).lastPathComponent
    let withoutMarkdown = candidate.lowercased().hasSuffix(".md")
      ? String(candidate.dropLast(3))
      : candidate
    return withoutMarkdown.lowercased().hasSuffix(".zh")
      ? String(withoutMarkdown.dropLast(3))
      : withoutMarkdown
  }

  /// Index pages without trapping on duplicate graph identities; the first
  /// list row remains the deterministic edge and selection target.
  public static func firstPageByID(_ pages: [ArkWikiPage]) -> [String: ArkWikiPage] {
    var result: [String: ArkWikiPage] = [:]
    for page in pages where result[page.id] == nil {
      result[page.id] = page
    }
    return result
  }

  private static func keepsLocalizedPath(
    _ path: String,
    allPaths: Set<String>,
    language: ArkLanguagePreference
  ) -> Bool {
    let lowercased = path.lowercased()
    if lowercased.hasSuffix(".zh.md") {
      let english = String(path.dropLast(6)) + ".md"
      return language == .zh || !allPaths.contains(english)
    }
    if lowercased.hasSuffix(".md") {
      let chinese = String(path.dropLast(3)) + ".zh.md"
      return language != .zh || !allPaths.contains(chinese)
    }
    return true
  }

  public static func load(root: URL) throws -> ([ArkWikiPage], [ArkWikiEdge]) {
    // Foundation can enumerate /var roots using /private/var URLs. Derive both sides of
    // the relative path from the same canonical representation.
    let root = root.standardizedFileURL.resolvingSymlinksInPath()
    let manager = FileManager.default
    guard let enumerator = manager.enumerator(
      at: root,
      includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey],
      options: [.skipsHiddenFiles]
    ) else { return ([], []) }

    let rootFD = Darwin.open(root.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
    guard rootFD >= 0 else { throw ArkAPIError(message: "知识库本地目录无法安全读取") }
    defer { Darwin.close(rootFD) }
    var pages: [ArkWikiPage] = []
    var visited = 0
    var totalBytes = 0
    let canonicalRoot = root.standardizedFileURL.resolvingSymlinksInPath().path + "/"
    for case let url as URL in enumerator {
      try Task.checkCancellation()
      visited += 1
      guard visited <= 8_192 else { throw ArkAPIError(message: "知识库本地索引超过 8192 个条目限制") }
      let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
      if values.isSymbolicLink == true { enumerator.skipDescendants(); continue }
      guard values.isRegularFile == true, url.pathExtension.lowercased() == "md" else { continue }
      let canonicalPath = url.standardizedFileURL.resolvingSymlinksInPath().path
      guard canonicalPath.hasPrefix(canonicalRoot) else { continue }
      guard pages.count < 2_048 else { throw ArkAPIError(message: "知识库本地索引超过 2048 页限制") }
      let relativePath = String(canonicalPath.dropFirst(canonicalRoot.count))
      if relativePath.split(separator: "/").contains(where: { $0.hasPrefix("_") }) { continue }
      guard let fd = confinedPageDescriptor(rootFD: rootFD, relativePath: relativePath) else { continue }
      let file = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
      defer { try? file.close() }
      var metadata = stat()
      guard fstat(fd, &metadata) == 0, (metadata.st_mode & S_IFMT) == S_IFREG else { continue }
      guard metadata.st_size >= 0, metadata.st_size <= 2 * 1_024 * 1_024 else {
        throw ArkAPIError(message: "知识页面超过 2 MiB 本地读取限制")
      }
      let data = try file.read(upToCount: 2 * 1_024 * 1_024 + 1) ?? Data()
      totalBytes += data.count
      guard data.count <= 2 * 1_024 * 1_024, totalBytes <= 32 * 1_024 * 1_024 else {
        throw ArkAPIError(message: "知识库本地读取超过 32 MiB 限制")
      }
      try Task.checkCancellation()
      guard let body = String(data: data, encoding: .utf8) else { continue }
      let id = String(relativePath.dropLast(3))
      let category = relativePath.split(separator: "/").dropLast().first.map(String.init) ?? "other"
      pages.append(ArkWikiPage(
        id: id,
        title: title(in: body) ?? url.deletingPathExtension().lastPathComponent,
        relativePath: relativePath,
        category: category,
        body: body,
        links: links(in: body),
        byteCount: data.count
      ))
    }
    pages.sort {
      if $0.category != $1.category { return $0.category.localizedCompare($1.category) == .orderedAscending }
      return $0.title.localizedCompare($1.title) == .orderedAscending
    }
    let known = Set(pages.map(\.id))
    let byBasename = Dictionary(grouping: pages, by: { URL(fileURLWithPath: $0.id).lastPathComponent })
    var seen = Set<String>()
    var edges: [ArkWikiEdge] = []
    for page in pages {
      for rawTarget in page.links {
        let normalized = String(rawTarget.split(separator: "#", maxSplits: 1).first ?? "")
          .trimmingCharacters(in: .whitespacesAndNewlines)
        let target: String?
        if known.contains(normalized) { target = normalized }
        else { target = byBasename[URL(fileURLWithPath: normalized).lastPathComponent]?.first?.id }
        guard let target, target != page.id else { continue }
        let edge = ArkWikiEdge(source: page.id, target: target)
        if seen.insert(edge.id).inserted { edges.append(edge) }
      }
    }
    return (pages, edges)
  }

  /// Open each ancestor from the owned root so directory-link swaps cannot redirect a fallback read.
  private static func confinedPageDescriptor(rootFD: Int32, relativePath: String) -> Int32? {
    let components = relativePath.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
    guard !components.isEmpty, components.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }) else { return nil }
    var directory = Darwin.dup(rootFD)
    guard directory >= 0 else { return nil }
    defer { Darwin.close(directory) }
    for component in components.dropLast() {
      let next = component.withCString { Darwin.openat(directory, $0, O_RDONLY | O_DIRECTORY | O_NOFOLLOW) }
      guard next >= 0 else { return nil }
      Darwin.close(directory)
      directory = next
    }
    return components[components.count - 1].withCString {
      let descriptor = Darwin.openat(directory, $0, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
      return descriptor >= 0 ? descriptor : nil
    }
  }

  private static func title(in body: String) -> String? {
    for line in body.split(separator: "\n", omittingEmptySubsequences: false) {
      if line.hasPrefix("# ") { return String(line.dropFirst(2)).trimmingCharacters(in: .whitespaces) }
      if line.hasPrefix("title:") {
        return String(line.dropFirst("title:".count)).trimmingCharacters(in: .whitespacesAndNewlines)
      }
    }
    return nil
  }

  private static func links(in body: String) -> [String] {
    let pattern = #"\[\[([^\]|]+)(?:\|[^\]]+)?\]\]"#
    guard let expression = try? NSRegularExpression(pattern: pattern) else { return [] }
    let range = NSRange(body.startIndex..<body.endIndex, in: body)
    return expression.matches(in: body, range: range).compactMap { match in
      guard match.numberOfRanges > 1, let target = Range(match.range(at: 1), in: body) else { return nil }
      return String(body[target])
    }
  }
}
