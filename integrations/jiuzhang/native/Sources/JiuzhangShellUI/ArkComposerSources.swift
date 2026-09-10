import Foundation
import JiuzhangShellCore

public enum ArkComposerSuggestionKind: String, Codable, Equatable, Sendable {
  case command
  case skill
  case skillCollection
  case fileCollection
  case sessionCollection
  case file
  case directory
  case session
}

/// Visual grouping used only by the explicit plus launcher. Typed `/` and `@`
/// completion remain a flat ranked list so their keyboard behavior does not
/// change.
public enum ArkComposerSuggestionSection: String, Codable, Equatable, Sendable {
  case add
  case tasks
  case plugins
}

/// One navigation owner for every nested plus-launcher surface.
public enum ArkComposerLauncherPage: Equatable, Sendable {
  case root
  case skills
  case skillFamily(String)
  case files
  case sessions
}

public enum ArkComposerReferenceAppearance: String, Codable, Equatable, Sendable {
  case file
  case folder
  case session
}

/// One detached row rendered by the shared Native composer menu.
public struct ArkComposerSuggestion: Identifiable, Equatable, Sendable {
  public let id: String
  public let kind: ArkComposerSuggestionKind
  public let title: String
  public let detail: String?
  public let replacement: String
  public let canonicalReference: String?
  public let appearance: ArkComposerReferenceAppearance?
  public let command: ArkComposerCommand?
  public let section: ArkComposerSuggestionSection?
  public let keepsMenuOpen: Bool
  public let userOnly: Bool

  public init(
    id: String,
    kind: ArkComposerSuggestionKind,
    title: String,
    detail: String? = nil,
    replacement: String,
    canonicalReference: String? = nil,
    appearance: ArkComposerReferenceAppearance? = nil,
    command: ArkComposerCommand? = nil,
    section: ArkComposerSuggestionSection? = nil,
    keepsMenuOpen: Bool = false,
    userOnly: Bool = false
  ) {
    self.id = id
    self.kind = kind
    self.title = title
    self.detail = detail
    self.replacement = replacement
    self.canonicalReference = canonicalReference
    self.appearance = appearance
    self.command = command
    self.section = section
    self.keepsMenuOpen = keepsMenuOpen
    self.userOnly = userOnly
  }
}

public struct ArkComposerSkillFamily: Identifiable, Equatable, Sendable {
  public let id: String
  public let title: String
  public let skills: [ArkComposerSkill]

  public init(id: String, title: String, skills: [ArkComposerSkill]) {
    self.id = id
    self.title = title
    self.skills = skills
  }
}

public enum ArkComposerTrigger: Character, Equatable, Sendable {
  case slash = "/"
  case reference = "@"
}

public enum ArkComposerTriggerPosition: Equatable, Sendable {
  case leading
  case inline
}

/// Revision-stamped trigger span. Async candidate results may mutate only this exact draft.
public struct ArkComposerTriggerHit: Equatable, Sendable {
  public let trigger: ArkComposerTrigger
  public let query: String
  public let quoted: Bool
  public let position: ArkComposerTriggerPosition
  public let range: NSRange
  public let draftRevision: UInt64

  public init(
    trigger: ArkComposerTrigger,
    query: String,
    quoted: Bool,
    position: ArkComposerTriggerPosition,
    range: NSRange,
    draftRevision: UInt64
  ) {
    self.trigger = trigger
    self.query = query
    self.quoted = quoted
    self.position = position
    self.range = range
    self.draftRevision = draftRevision
  }
}

public enum ArkComposerMenuKey: Equatable, Sendable {
  case up
  case down
  case enter
  case escape
}

/// Complete menu state. One generation owns both async source groups.
public struct ArkComposerSuggestionMenu: Equatable, Sendable {
  public var generation: UInt64
  public var hit: ArkComposerTriggerHit?
  public var candidates: [ArkComposerSuggestion]
  public var highlightedIndex: Int?
  public var loading: Bool
  public var error: String?

  public static let closed = ArkComposerSuggestionMenu(
    generation: 0,
    hit: nil,
    candidates: [],
    highlightedIndex: nil,
    loading: false,
    error: nil
  )

  public var isOpen: Bool { hit != nil }

  public mutating func begin(generation: UInt64, hit: ArkComposerTriggerHit) {
    self.generation = generation
    self.hit = hit
    candidates = []
    highlightedIndex = nil
    loading = true
    error = nil
  }

  @discardableResult
  public mutating func publish(
    generation: UInt64,
    candidates: [ArkComposerSuggestion],
    error: String? = nil
  ) -> Bool {
    guard generation == self.generation, hit != nil else { return false }
    self.candidates = candidates
    highlightedIndex = candidates.isEmpty ? nil : 0
    loading = false
    self.error = error
    return true
  }

  public mutating func move(_ delta: Int) {
    guard !candidates.isEmpty else { return }
    let current = highlightedIndex ?? 0
    highlightedIndex = (current + delta + candidates.count) % candidates.count
  }

  public mutating func close() {
    hit = nil
    candidates = []
    highlightedIndex = nil
    loading = false
    error = nil
  }
}

/// Browser-independent trigger grammar using NSTextView's UTF-16 coordinate space.
public enum ArkComposerTriggerDetector {
  public static func detect(
    text: String,
    caret: Int,
    revision: UInt64
  ) -> ArkComposerTriggerHit? {
    let source = text as NSString
    guard caret >= 0, caret <= source.length else { return nil }
    let before = source.substring(to: caret)

    if let quoted = lastMatch(#"(?:^|\s)(@\"([^\"]*))$"#, in: before),
       let prefix = capture(quoted, group: 1, in: before),
       let query = capture(quoted, group: 2, in: before)
    {
      let start = caret - (prefix as NSString).length
      return hit(
        trigger: .reference,
        query: query,
        quoted: true,
        start: start,
        end: caret,
        text: source,
        revision: revision
      )
    }
    if let plain = lastMatch(#"(?:^|\s)(@([^\s]*))$"#, in: before),
       let prefix = capture(plain, group: 1, in: before),
       let query = capture(plain, group: 2, in: before)
    {
      let start = caret - (prefix as NSString).length
      return hit(
        trigger: .reference,
        query: query,
        quoted: false,
        start: start,
        end: caret,
        text: source,
        revision: revision
      )
    }

    var index = caret - 1
    while index >= 0 {
      let scalar = source.character(at: index)
      if let uni = UnicodeScalar(scalar), CharacterSet.whitespacesAndNewlines.contains(uni) { return nil }
      guard scalar == Character("/").utf16.first else {
        index -= 1
        continue
      }
      guard slashBoundaryIsValid(source, at: index) else {
        index -= 1
        continue
      }
      return hit(
        trigger: .slash,
        query: source.substring(with: NSRange(location: index + 1, length: caret - index - 1)),
        quoted: false,
        start: index,
        end: caret,
        text: source,
        revision: revision
      )
    }
    return nil
  }

  private static func hit(
    trigger: ArkComposerTrigger,
    query: String,
    quoted: Bool,
    start: Int,
    end: Int,
    text: NSString,
    revision: UInt64
  ) -> ArkComposerTriggerHit {
    let leading = firstNonWhitespace(in: text) == start
    return ArkComposerTriggerHit(
      trigger: trigger,
      query: query,
      quoted: quoted,
      position: leading ? .leading : .inline,
      range: NSRange(location: start, length: end - start),
      draftRevision: revision
    )
  }

  private static func slashBoundaryIsValid(_ text: NSString, at index: Int) -> Bool {
    if index == 0 { return true }
    let previous = text.character(at: index - 1)
    // R19-02：surrogate（代理对码元）无独立 Unicode scalar，一律按“非空白、非字母数字”处理，禁止强解包
    if let uni = UnicodeScalar(previous), CharacterSet.whitespacesAndNewlines.contains(uni) { return true }
    if previous == Character("/").utf16.first { return false }
    if previous == Character("_").utf16.first { return false }
    if previous == Character(":").utf16.first, index >= 2 {
      if let uni = UnicodeScalar(text.character(at: index - 2)) {
        if !CharacterSet.whitespacesAndNewlines.contains(uni) { return false }
      } else {
        return false
      }
    }
    if let uni = UnicodeScalar(previous) {
      return !CharacterSet.alphanumerics.contains(uni)
    }
    return true
  }

  private static func firstNonWhitespace(in text: NSString) -> Int? {
    for index in 0..<text.length {
      let scalar = text.character(at: index)

      if let uni = UnicodeScalar(scalar) {
        if !CharacterSet.whitespacesAndNewlines.contains(uni) {
          return index
        }
      } else {
        // surrogate / 非独立 Unicode scalar：按非空白处理
        return index
      }
    }
    return nil
  }

  private static func lastMatch(_ pattern: String, in text: String) -> NSTextCheckingResult? {
    try? NSRegularExpression(pattern: pattern).firstMatch(
      in: text,
      range: NSRange(location: 0, length: (text as NSString).length)
    )
  }

  private static func capture(
    _ match: NSTextCheckingResult,
    group: Int,
    in text: String
  ) -> String? {
    let range = match.range(at: group)
    guard range.location != NSNotFound else { return nil }
    return (text as NSString).substring(with: range)
  }
}

/// Shared synthesis and fuzzy ordering for command, Skill, file, and session rows.
public enum ArkComposerSuggestionBuilder {
  public static func slash(
    commands: [ArkComposerCommand],
    skills: [ArkComposerSkill],
    query: String,
    position: ArkComposerTriggerPosition,
    localizedCommands: [String: (title: String, detail: String)] = [:]
  ) -> [ArkComposerSuggestion] {
    var rows: [ArkComposerSuggestion] = []
    var commandNames = Set<String>()
    for command in commands {
      commandNames.insert(command.name)
      if position == .inline, command.input != nil { continue }
      rows.append(commandSuggestion(command, localized: localizedCommands[command.name]))
    }
    for skill in deduplicatedSkills(skills) where !commandNames.contains(skill.name) {
      rows.append(skillSuggestion(skill))
    }
    return rank(rows, query: query)
  }

  /// Build the explicit plus launcher from authoritative command and Skill
  /// catalogs. Goal/Plan/compact appear only when the selected Agent actually
  /// advertises them; no preset capability is manufactured in Native UI.
  public static func capabilityLauncher(
    commands: [ArkComposerCommand],
    skills: [ArkComposerSkill],
    filesTitle: String,
    filesDetail: String,
    sessionsTitle: String,
    sessionsDetail: String,
    skillsTitle: String,
    skillsDetail: String,
    commandTitles: [String: String],
    commandDetails: [String: String],
    position: ArkComposerTriggerPosition = .leading
  ) -> [ArkComposerSuggestion] {
    var rows = [
      ArkComposerSuggestion(
        id: "launcher:files",
        kind: .fileCollection,
        title: filesTitle,
        detail: filesDetail,
        replacement: "",
        section: .add,
        keepsMenuOpen: true
      ),
      ArkComposerSuggestion(
        id: "launcher:sessions",
        kind: .sessionCollection,
        title: sessionsTitle,
        detail: sessionsDetail,
        replacement: "",
        section: .add,
        keepsMenuOpen: true
      ),
    ]
    let priority = ["goal", "plan", "compact"]
    for name in priority {
      guard let command = commands.first(where: { $0.name == name }) else { continue }
      if position == .inline, command.input != nil { continue }
      rows.append(commandSuggestion(
        command,
        title: commandTitles[name],
        detail: commandDetails[name],
        section: .tasks
      ))
    }
    let commandNames = Set(commands.map(\.name))
    let uniqueSkills = deduplicatedSkills(skills)
      .filter { !commandNames.contains($0.name) }
    if !uniqueSkills.isEmpty {
      rows.append(ArkComposerSuggestion(
        id: "skill-collection",
        kind: .skillCollection,
        title: skillsTitle,
        detail: skillsDetail,
        replacement: "",
        section: .plugins,
        keepsMenuOpen: true
      ))
    }
    return rows
  }

  public static func groupedSlash(
    commands: [ArkComposerCommand],
    skills: [ArkComposerSkill],
    skillsTitle: String,
    skillsDetail: String,
    localizedCommands: [String: (title: String, detail: String)] = [:]
  ) -> [ArkComposerSuggestion] {
    var rows = slash(commands: commands, skills: [], query: "", position: .leading, localizedCommands: localizedCommands)
    let uniqueSkills = deduplicatedSkills(skills)
    if !uniqueSkills.isEmpty {
      rows.append(ArkComposerSuggestion(
        id: "skill-collection",
        kind: .skillCollection,
        title: skillsTitle,
        detail: skillsDetail,
        replacement: "",
        keepsMenuOpen: true
      ))
    }
    return rows
  }

  public static func skillsOnly(_ skills: [ArkComposerSkill]) -> [ArkComposerSuggestion] {
    slash(commands: [], skills: deduplicatedSkills(skills), query: "", position: .leading)
  }

  public static func skillFamilies(
    _ skills: [ArkComposerSkill],
    otherTitle: String
  ) -> [ArkComposerSkillFamily] {
    let unique = deduplicatedSkills(skills)
    let rawPrefixes = unique.map { canonicalFamilyPrefix($0.name) }
    let counts = Dictionary(grouping: rawPrefixes, by: { $0 }).mapValues(\.count)
    let genericPrefixes: Set<String> = ["app", "ark", "dsh", "general", "native", "skill", "tool"]
    var buckets: [String: [ArkComposerSkill]] = [:]
    for skill in unique {
      let prefix = canonicalFamilyPrefix(skill.name)
      let family = prefix.count >= 3
        && !genericPrefixes.contains(prefix)
        && (counts[prefix] ?? 0) >= 2
        ? prefix
        : "_other"
      buckets[family, default: []].append(skill)
    }
    return buckets.map { key, rows in
      ArkComposerSkillFamily(
        id: key,
        title: key == "_other" ? otherTitle : familyDisplayName(key),
        skills: rows.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
      )
    }.sorted {
      if $0.id == "_other" { return false }
      if $1.id == "_other" { return true }
      return $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending
    }
  }

  /// A curated catalog with no repeated family prefix should open directly.
  /// The extra "Other Skills" level only adds latency and a redundant click.
  public static func skillCollectionRows(
    _ skills: [ArkComposerSkill],
    otherTitle: String,
    familyDetail: (Int) -> String
  ) -> [ArkComposerSuggestion] {
    let families = skillFamilies(skills, otherTitle: otherTitle)
    if families.count == 1, families[0].id == "_other" {
      return skillsOnly(families[0].skills)
    }
    return families.map { family in
      ArkComposerSuggestion(
        id: "skill-family:\(family.id)",
        kind: .skillCollection,
        title: family.title,
        detail: familyDetail(family.skills.count),
        replacement: "",
        keepsMenuOpen: true
      )
    }
  }

  public static func deduplicatedSkills(_ skills: [ArkComposerSkill]) -> [ArkComposerSkill] {
    var seen = Set<String>()
    return skills.filter { seen.insert($0.name.lowercased()).inserted }
  }

  private static func commandSuggestion(
    _ command: ArkComposerCommand,
    title: String? = nil,
    detail: String? = nil,
    section: ArkComposerSuggestionSection? = nil,
    localized: (title: String, detail: String)? = nil
  ) -> ArkComposerSuggestion {
    return ArkComposerSuggestion(
      id: "command:\(command.name)",
      kind: .command,
      title: title ?? localized?.title ?? command.name,
      detail: detail ?? localized?.detail ?? command.description,
      replacement: command.input == nil ? "/\(command.name)" : "/\(command.name) ",
      command: command,
      section: section
    )
  }

  private static func skillSuggestion(
    _ skill: ArkComposerSkill,
    section: ArkComposerSuggestionSection? = nil
  ) -> ArkComposerSuggestion {
    let detail = [skill.description, skill.whenToUse]
      .compactMap { $0 }
      .filter { !$0.isEmpty }
      .joined(separator: " · ")
    return ArkComposerSuggestion(
      id: "skill:\(skill.name)",
      kind: .skill,
      title: skill.name,
      detail: detail,
      replacement: "/\(skill.name) ",
      section: section,
      userOnly: !skill.modelInvocable
    )
  }

  private static func canonicalFamilyPrefix(_ name: String) -> String {
    let normalized = name.lowercased()
    return normalized.split(separator: "-", maxSplits: 1).first.map(String.init) ?? normalized
  }

  private static func familyDisplayName(_ key: String) -> String {
    guard let first = key.first else { return key }
    return String(first).uppercased() + key.dropFirst()
  }

  public static func references(
    files: [ArkComposerFileCandidate],
    sessions: [ArkComposerSessionCandidate],
    query: String,
    preserveQuote: Bool
  ) -> [ArkComposerSuggestion] {
    var rows: [ArkComposerSuggestion] = []
    for file in files {
      guard let mention = fileMention(file, preserveQuote: preserveQuote) else { continue }
      let label = URL(fileURLWithPath: file.path).lastPathComponent
      if file.kind == .directory {
        rows.append(ArkComposerSuggestion(
          id: "directory:\(file.path)",
          kind: .directory,
          title: label + "/",
          detail: file.path,
          replacement: mention,
          appearance: .folder,
          keepsMenuOpen: true
        ))
      } else {
        rows.append(ArkComposerSuggestion(
          id: "file:\(file.path)",
          kind: .file,
          title: label,
          detail: file.path,
          replacement: "@\(label)",
          canonicalReference: mention,
          appearance: .file
        ))
      }
    }
    for session in sessions {
      let detail = [session.sessionID == session.label ? nil : session.sessionID, session.cwd]
        .compactMap { $0 }
        .joined(separator: " · ")
      rows.append(ArkComposerSuggestion(
        id: "session:\(session.sessionID)",
        kind: .session,
        title: session.label,
        detail: detail,
        replacement: "@\(session.label)",
        canonicalReference: session.mention,
        appearance: .session
      ))
    }
    // Host file/session services already apply cwd-aware and metadata-aware
    // ranking. Preserve that authority (files first, then sessions) instead of
    // re-filtering a title when the query matched a path or session id.
    return rows
  }

  public static func fileMention(
    _ candidate: ArkComposerFileCandidate,
    preserveQuote: Bool
  ) -> String? {
    let path = candidate.kind == .directory ? candidate.path + "/" : candidate.path
    guard path.rangeOfCharacter(from: .controlCharacters) == nil, !path.contains("\"") else {
      return nil
    }
    let quoted = preserveQuote || path.rangeOfCharacter(from: .whitespacesAndNewlines) != nil
    if !quoted { return "@\(path)" }
    return candidate.kind == .directory ? "@\"\(path)" : "@\"\(path)\""
  }

  public static func rank(
    _ candidates: [ArkComposerSuggestion],
    query rawQuery: String
  ) -> [ArkComposerSuggestion] {
    let query = rawQuery.lowercased()
    guard !query.isEmpty else { return candidates }
    return candidates.enumerated().compactMap { index, candidate -> Ranked? in
      let title = candidate.title.lowercased()
      guard let score = fuzzyScore(title, query) else { return nil }
      return Ranked(
        candidate: candidate,
        index: index,
        prefix: title.hasPrefix(query),
        score: score
      )
    }.sorted {
      if $0.prefix != $1.prefix { return $0.prefix && !$1.prefix }
      if $0.score != $1.score { return $0.score > $1.score }
      return $0.index < $1.index
    }.map(\.candidate)
  }

  private struct Ranked {
    let candidate: ArkComposerSuggestion
    let index: Int
    let prefix: Bool
    let score: Int
  }

  private static func fuzzyScore(_ name: String, _ query: String) -> Int? {
    let nameChars = Array(name)
    let queryChars = Array(query)
    guard queryChars.count <= nameChars.count else { return nil }
    var cursor = 0
    var score = 0
    var previousMatch = -2
    for queryChar in queryChars {
      guard let match = nameChars[cursor...].firstIndex(of: queryChar) else { return nil }
      score += match == previousMatch + 1 ? 5 : 1
      if match == 0 || nameChars[match - 1] == "-" || nameChars[match - 1] == "_" { score += 8 }
      score -= match - cursor
      previousMatch = match
      cursor = match + 1
    }
    return score
  }
}

/// One structured reference range in a display-text Native composer draft.
public struct ArkComposerReferenceOccurrence: Identifiable, Codable, Equatable, Sendable {
  public let id: String
  public let source: String
  public let canonicalReference: String
  public let label: String
  public let appearance: ArkComposerReferenceAppearance
  public var offset: Int
  public let length: Int

  public init(
    id: String = UUID().uuidString.lowercased(),
    source: String,
    canonicalReference: String,
    label: String,
    appearance: ArkComposerReferenceAppearance,
    offset: Int,
    length: Int
  ) {
    self.id = id
    self.source = source
    self.canonicalReference = canonicalReference
    self.label = label
    self.appearance = appearance
    self.offset = offset
    self.length = length
  }
}

/// Persistable draft truth: readable text plus independently addressable reference ranges.
public struct ArkComposerDraftDocument: Codable, Equatable, Sendable {
  public private(set) var text: String
  public private(set) var references: [ArkComposerReferenceOccurrence]
  public private(set) var revision: UInt64

  public init(
    text: String = "",
    references: [ArkComposerReferenceOccurrence] = [],
    revision: UInt64 = 0
  ) {
    self.text = text
    self.references = references.sorted { $0.offset < $1.offset }
    self.revision = revision
  }

  public mutating func replaceText(_ next: String) {
    guard next != text else { return }
    let range = editRange(from: text, to: next)
    reconcile(replacing: range.oldRange, insertedLength: range.insertedLength)
    text = next
    revision &+= 1
  }

  public mutating func replacePlainText(
    in range: NSRange,
    with replacement: String,
    expectedRevision: UInt64
  ) -> Bool {
    guard expectedRevision == revision, valid(range, in: text) else { return false }
    reconcile(replacing: range, insertedLength: (replacement as NSString).length)
    text = (text as NSString).replacingCharacters(in: range, with: replacement)
    revision &+= 1
    return true
  }

  public mutating func insertReference(
    in range: NSRange,
    displayText: String,
    canonicalReference: String,
    source: String,
    label: String,
    appearance: ArkComposerReferenceAppearance,
    expectedRevision: UInt64
  ) -> Bool {
    guard expectedRevision == revision,
          valid(range, in: text),
          !displayText.isEmpty,
          !canonicalReference.isEmpty
    else { return false }
    let original = text as NSString
    let needsLeadingGap: Bool
    if range.length == 0, range.location > 0 {
      let previousRange = original.rangeOfComposedCharacterSequence(at: range.location - 1)
      let previous = original.substring(with: previousRange)
      needsLeadingGap = previous.rangeOfCharacter(from: .whitespacesAndNewlines) == nil
    } else {
      needsLeadingGap = false
    }
    let tailLocation = range.location + range.length
    let needsGap = tailLocation >= original.length
      || original.substring(with: NSRange(location: tailLocation, length: 1)) != " "
    let leadingGap = needsLeadingGap ? " " : ""
    let inserted = leadingGap + displayText + (needsGap ? " " : "")
    reconcile(replacing: range, insertedLength: (inserted as NSString).length)
    text = original.replacingCharacters(in: range, with: inserted)
    references.append(ArkComposerReferenceOccurrence(
      source: source,
      canonicalReference: canonicalReference,
      label: label,
      appearance: appearance,
      offset: range.location + (leadingGap as NSString).length,
      length: (displayText as NSString).length
    ))
    references.sort { $0.offset < $1.offset }
    revision &+= 1
    return true
  }

  public mutating func clear() {
    guard !text.isEmpty || !references.isEmpty else { return }
    text = ""
    references = []
    revision &+= 1
  }

  public func prepending(_ prefix: ArkComposerDraftDocument) -> ArkComposerDraftDocument {
    guard !prefix.text.isEmpty else { return self }
    guard !text.isEmpty else { return prefix }
    let separator = "\n"
    let shift = (prefix.text as NSString).length + (separator as NSString).length
    let shifted = references.map { occurrence -> ArkComposerReferenceOccurrence in
      var copy = occurrence
      copy.offset += shift
      return copy
    }
    return ArkComposerDraftDocument(
      text: prefix.text + separator + text,
      references: prefix.references + shifted,
      revision: max(prefix.revision, revision) &+ 1
    )
  }

  public func serializedText() throws -> String {
    let source = text as NSString
    var cursor = 0
    var result = ""
    for reference in references.sorted(by: { $0.offset < $1.offset }) {
      let range = NSRange(location: reference.offset, length: reference.length)
      guard valid(range, in: text), reference.offset >= cursor else {
        throw ArkAPIError(message: "输入框引用状态已失效，请重新选择引用")
      }
      let expectedDisplay = "@\(reference.label)"
      guard source.substring(with: range) == expectedDisplay else {
        throw ArkAPIError(message: "输入框引用已被编辑，请重新选择引用")
      }
      result += source.substring(with: NSRange(location: cursor, length: reference.offset - cursor))
      result += reference.canonicalReference
      cursor = reference.offset + reference.length
    }
    result += source.substring(from: cursor)
    return result
  }

  public func deletionRange(caret: Int, backward: Bool) -> NSRange? {
    for reference in references {
      if backward, caret == reference.offset + reference.length {
        return NSRange(location: reference.offset, length: reference.length)
      }
      if !backward, caret == reference.offset {
        return NSRange(location: reference.offset, length: reference.length)
      }
    }
    return nil
  }

  private mutating func reconcile(replacing range: NSRange, insertedLength: Int) {
    let delta = insertedLength - range.length
    let end = range.location + range.length
    references = references.compactMap { occurrence in
      let occurrenceEnd = occurrence.offset + occurrence.length
      if occurrenceEnd <= range.location { return occurrence }
      if occurrence.offset >= end {
        var shifted = occurrence
        shifted.offset += delta
        return shifted
      }
      return nil
    }
  }

  private func valid(_ range: NSRange, in value: String) -> Bool {
    range.location >= 0 && range.length >= 0
      && range.location <= (value as NSString).length
      && range.location + range.length <= (value as NSString).length
  }

  private func editRange(from old: String, to new: String) -> (oldRange: NSRange, insertedLength: Int) {
    let lhs = Array(old.utf16)
    let rhs = Array(new.utf16)
    var prefix = 0
    while prefix < min(lhs.count, rhs.count), lhs[prefix] == rhs[prefix] { prefix += 1 }
    var suffix = 0
    while suffix < min(lhs.count, rhs.count) - prefix,
          lhs[lhs.count - 1 - suffix] == rhs[rhs.count - 1 - suffix]
    {
      suffix += 1
    }
    return (
      NSRange(location: prefix, length: lhs.count - prefix - suffix),
      rhs.count - prefix - suffix
    )
  }
}

public enum ArkComposerSubmissionRoute: Equatable, Sendable {
  case prompt
  case command(ArkComposerCommand)

  public static func resolve(
    text: String,
    imageCount: Int,
    commands: [ArkComposerCommand]
  ) throws -> ArkComposerSubmissionRoute {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let match = try? NSRegularExpression(pattern: #"^/([a-z][a-z0-9_-]*)(?=$|\s)"#)
      .firstMatch(in: trimmed, range: NSRange(location: 0, length: (trimmed as NSString).length)),
      match.range(at: 1).location != NSNotFound
    else { return .prompt }
    let name = (trimmed as NSString).substring(with: match.range(at: 1))
    guard let command = commands.first(where: { $0.name == name }) else { return .prompt }
    let remainder = (trimmed as NSString).substring(from: match.range.location + match.range.length)
    if command.input == nil, !remainder.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      return .prompt
    }
    if imageCount > 0, command.input?.acceptsImages != true {
      throw ArkAPIError(message: "/\(name) 不接受图片附件")
    }
    return .command(command)
  }
}
