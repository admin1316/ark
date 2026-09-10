import Foundation
import JiuzhangShellCore

public enum ArkSubagentCatalogPhase: String, Equatable, Sendable {
  case idle
  case loading
  case ready
  case failed
}

/// One parent-scoped catalog. Loading and failure retain the last good rows so
/// a transient Host error cannot collapse a visible lineage tree.
public struct ArkSubagentCatalogViewState: Equatable, Sendable {
  public var entries: [ArkSubagentEntry]
  public var parentAvailable: Bool
  public var phase: ArkSubagentCatalogPhase
  public var error: String?

  public init(
    entries: [ArkSubagentEntry] = [],
    parentAvailable: Bool = false,
    phase: ArkSubagentCatalogPhase = .idle,
    error: String? = nil
  ) {
    self.entries = entries
    self.parentAvailable = parentAvailable
    self.phase = phase
    self.error = error
  }

  public static func loading(previous: Self?) -> Self {
    Self(
      entries: previous?.entries ?? [],
      parentAvailable: previous?.parentAvailable ?? false,
      phase: .loading,
      error: nil
    )
  }

  public static func ready(_ catalog: ArkSubagentCatalog) -> Self {
    Self(
      entries: catalog.entries,
      parentAvailable: catalog.parentAvailable,
      phase: .ready,
      error: nil
    )
  }

  public static func failed(previous: Self?, message: String) -> Self {
    Self(
      entries: previous?.entries ?? [],
      parentAvailable: previous?.parentAvailable ?? false,
      phase: .failed,
      error: message
    )
  }
}

public enum ArkSubagentLineageRowKind: String, Equatable, Sendable {
  case child
  case diagnostic
  case loading
  case failure
}

public struct ArkSubagentLineageRow: Identifiable, Equatable, Sendable {
  public let id: String
  public let parentSessionID: String
  public let depth: Int
  public let kind: ArkSubagentLineageRowKind
  public let entry: ArkSubagentEntry?
  public let placeholder: Bool
  public let message: String?

  public init(
    id: String,
    parentSessionID: String,
    depth: Int,
    kind: ArkSubagentLineageRowKind,
    entry: ArkSubagentEntry? = nil,
    placeholder: Bool = false,
    message: String? = nil
  ) {
    self.id = id
    self.parentSessionID = parentSessionID
    self.depth = depth
    self.kind = kind
    self.entry = entry
    self.placeholder = placeholder
    self.message = message
  }
}

public enum ArkSubagentLineageProjection {
  public static func rows(
    rootSessionID: String,
    catalogs: [String: ArkSubagentCatalogViewState],
    sessions: [ArkSessionSummary],
    cachedEntries: [String: ArkSubagentEntry],
    expanded: Set<String>
  ) -> [ArkSubagentLineageRow] {
    var result: [ArkSubagentLineageRow] = []
    appendLevel(
      parentSessionID: rootSessionID,
      depth: 1,
      catalogs: catalogs,
      sessions: sessions,
      cachedEntries: cachedEntries,
      expanded: expanded,
      ancestors: [],
      result: &result
    )
    return result
  }

  public static func knownDescendantIDs(
    rootSessionID: String,
    catalogs: [String: ArkSubagentCatalogViewState],
    sessions: [ArkSessionSummary],
    cachedEntries: [String: ArkSubagentEntry]
  ) -> Set<String> {
    let allExpandable = Set(
      catalogs.values.flatMap(\.entries).filter { $0.kind == "child" }.map(\.id)
        + sessions.filter { $0.origin == "subagent" }.map(\.id)
    )
    return Set(rows(
      rootSessionID: rootSessionID,
      catalogs: catalogs,
      sessions: sessions,
      cachedEntries: cachedEntries,
      expanded: allExpandable
    ).compactMap { row in
      row.kind == .child ? row.entry?.id : nil
    })
  }

  public static func applyingRuntimeHints(
    _ entries: [ArkSubagentEntry],
    activity: [String: Bool],
    knownParents: Set<String>
  ) -> [ArkSubagentEntry] {
    entries.map { entry in
      ArkSubagentEntry(
        id: entry.id,
        kind: entry.kind,
        mode: entry.mode,
        activity: activity[entry.id].map { $0 ? "running" : "inactive" } ?? entry.activity,
        hasChildren: entry.hasChildren || knownParents.contains(entry.id),
        label: entry.label,
        reason: entry.reason
      )
    }
  }

  private static func appendLevel(
    parentSessionID: String,
    depth: Int,
    catalogs: [String: ArkSubagentCatalogViewState],
    sessions: [ArkSessionSummary],
    cachedEntries: [String: ArkSubagentEntry],
    expanded: Set<String>,
    ancestors: Set<String>,
    result: inout [ArkSubagentLineageRow]
  ) {
    guard !ancestors.contains(parentSessionID) else { return }
    var nextAncestors = ancestors
    nextAncestors.insert(parentSessionID)
    let state = catalogs[parentSessionID]

    if state?.phase == .failed {
      result.append(ArkSubagentLineageRow(
        id: "failure:\(parentSessionID)",
        parentSessionID: parentSessionID,
        depth: depth,
        kind: .failure,
        message: state?.error
      ))
    }

    let authoritative = state?.entries ?? []
    let fallback = fallbackEntries(
      parentSessionID: parentSessionID,
      sessions: sessions,
      cachedEntries: cachedEntries
    )
    let useFallback = authoritative.isEmpty
      && (state == nil || state?.phase == .loading || state?.phase == .failed)
    let entries = (useFallback ? fallback : authoritative).map { entry in
      guard let session = sessions.first(where: { $0.id == entry.id }) else { return entry }
      return ArkSubagentEntry(
        id: entry.id,
        kind: entry.kind,
        mode: entry.mode,
        activity: session.running ? "running" : "inactive",
        hasChildren: entry.hasChildren,
        label: entry.label,
        reason: entry.reason
      )
    }

    if entries.isEmpty, state == nil || state?.phase == .loading {
      result.append(ArkSubagentLineageRow(
        id: "loading:\(parentSessionID)",
        parentSessionID: parentSessionID,
        depth: depth,
        kind: .loading
      ))
      return
    }

    for entry in entries {
      let kind: ArkSubagentLineageRowKind = entry.kind == "child" ? .child : .diagnostic
      result.append(ArkSubagentLineageRow(
        id: "\(parentSessionID):\(kind.rawValue):\(entry.id)",
        parentSessionID: parentSessionID,
        depth: depth,
        kind: kind,
        entry: entry,
        placeholder: useFallback
      ))
      guard kind == .child, entry.hasChildren, expanded.contains(entry.id) else { continue }
      appendLevel(
        parentSessionID: entry.id,
        depth: depth + 1,
        catalogs: catalogs,
        sessions: sessions,
        cachedEntries: cachedEntries,
        expanded: expanded,
        ancestors: nextAncestors,
        result: &result
      )
    }
  }

  private static func fallbackEntries(
    parentSessionID: String,
    sessions: [ArkSessionSummary],
    cachedEntries: [String: ArkSubagentEntry]
  ) -> [ArkSubagentEntry] {
    sessions.filter {
      $0.origin == "subagent" && $0.parentSessionID == parentSessionID
    }.sorted { $0.updatedAt > $1.updatedAt }.map { session in
      let cached = cachedEntries[session.id]
      return ArkSubagentEntry(
        id: session.id,
        kind: "child",
        mode: cached?.mode,
        // The session summary is lifecycle authority. Cached catalog rows may
        // retain an older running label while a reconnect refresh is loading.
        activity: session.running ? "running" : "inactive",
        hasChildren: sessions.contains { candidate in
          candidate.origin == "subagent" && candidate.parentSessionID == session.id
        } || cached?.hasChildren == true,
        label: cached?.label ?? session.title,
        reason: cached?.reason
      )
    }
  }
}

/// One turn-scoped transcript unit for subagent dispatch. A single assistant
/// turn may start, prompt, inspect and wait for the same child through several
/// `subagent` tool calls. Rendering those calls as unrelated top-level rows is
/// noisy and makes the lazy transcript much more expensive to lay out.
public struct ArkSubagentTranscriptGroup: Identifiable, Equatable, Sendable {
  public let id: String
  public let sequence: Int
  public let turn: Int?
  public let activities: [ArkToolActivity]

  public init(sequence: Int, turn: Int?, activities: [ArkToolActivity]) {
    self.sequence = sequence
    self.turn = turn
    self.activities = activities.sorted { $0.sequence < $1.sequence }
    id = turn.map { "subagent-turn-\($0)" } ?? "subagent-call-\(sequence)"
  }

  public var phase: ArkExecutionPhase {
    if activities.contains(where: { $0.execution?.phase == .running }) { return .running }
    if activities.contains(where: { $0.isError || $0.execution?.phase == .failed }) { return .failed }
    if activities.contains(where: { $0.isInterrupted || $0.execution?.phase == .cancelled }) {
      return .cancelled
    }
    return .succeeded
  }

  public var startedAt: Date? {
    activities.compactMap { $0.execution?.startedAt }.min()
  }

  public var finishedAt: Date? {
    phase == .running ? nil : activities.compactMap { $0.execution?.finishedAt }.max()
  }
}

public enum ArkSubagentTranscriptProjection {
  public struct Result: Equatable, Sendable {
    public let groups: [ArkSubagentTranscriptGroup]
    public let ordinaryTools: [ArkToolActivity]
  }

  public static func fold(_ activities: [ArkToolActivity]) -> Result {
    var ordinaryTools: [ArkToolActivity] = []
    var grouped: [String: [ArkToolActivity]] = [:]
    var groupOrder: [String] = []

    for activity in activities {
      guard isSubagent(activity) else {
        ordinaryTools.append(activity)
        continue
      }
      let key = activity.turn.map { "turn:\($0)" } ?? "call:\(activity.id)"
      if grouped[key] == nil { groupOrder.append(key) }
      grouped[key, default: []].append(activity)
    }

    let groups = groupOrder.compactMap { key -> ArkSubagentTranscriptGroup? in
      guard let values = grouped[key], let sequence = values.map(\.sequence).min() else { return nil }
      return ArkSubagentTranscriptGroup(
        sequence: sequence,
        turn: values.first?.turn,
        activities: values
      )
    }
    return Result(groups: groups, ordinaryTools: ordinaryTools)
  }

  public static func isSubagent(_ activity: ArkToolActivity) -> Bool {
    if activity.callPresentation?["card"]?.stringValue == "generic",
       activity.callPresentation?["rawInput"]?["semanticKind"]?.stringValue == "subagent" {
      return true
    }
    // Compatibility for history produced before the semantic presentation
    // marker existed. New configurable names never enter this allowlist.
    if activity.name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "subagent" {
      return true
    }
    if case .generic(let card) = activity.callView,
       card.kind?.lowercased() == "subagent" {
      return true
    }
    return false
  }
}
