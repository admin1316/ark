import Foundation
import JiuzhangShellCore

/// Search fallback shared by the native navigation surface.
///
/// Local metadata is always available even when the optional Host full-text
/// index is disabled. Remote hits enrich or append to that deterministic local
/// list; they never replace it wholesale.
public enum ArkSessionSearchResolver {
  public static func localHits(
    query: String,
    sessions: [ArkSessionSummary],
    workspaces: [ArkWorkspace],
    archivedSessionIDs: Set<String>
  ) -> [ArkSessionSearchHit] {
    let needle = normalized(query)
    guard !needle.isEmpty else { return [] }

    var workspaceBySessionID: [String: ArkWorkspace] = [:]
    for workspace in workspaces {
      for sessionID in workspace.sessionIDs {
        workspaceBySessionID[sessionID] = workspace
      }
    }

    return sessions
      .filter { !archivedSessionIDs.contains($0.id) }
      .sorted {
        if $0.updatedAt != $1.updatedAt { return $0.updatedAt > $1.updatedAt }
        return $0.id < $1.id
      }
      .compactMap { session in
        let workspace = workspaceBySessionID[session.id]
          ?? workspaces.first(where: { workspace in
            guard let cwd = session.cwd else { return false }
            return URL(fileURLWithPath: cwd).standardizedFileURL.path
              == URL(fileURLWithPath: workspace.path).standardizedFileURL.path
          })
        let fields = [
          session.title,
          session.cwd,
          workspace?.title,
          workspace?.path,
        ].compactMap { $0 }
        guard fields.contains(where: { normalized($0).contains(needle) }) else { return nil }
        let snippet = workspace.map { "\($0.title) · \($0.path)" }
          ?? session.cwd
          ?? session.title
        return ArkSessionSearchHit(sessionID: session.id, snippet: snippet)
      }
  }

  public static func merge(
    local: [ArkSessionSearchHit],
    remote: [ArkSessionSearchHit]
  ) -> [ArkSessionSearchHit] {
    var result = local
    var indexBySessionID = Dictionary(
      uniqueKeysWithValues: local.enumerated().map { ($0.element.sessionID, $0.offset) }
    )
    for hit in remote {
      if let index = indexBySessionID[hit.sessionID] {
        if !hit.snippet.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
          result[index] = hit
        }
      } else {
        indexBySessionID[hit.sessionID] = result.count
        result.append(hit)
      }
    }
    return result
  }

  private static func normalized(_ value: String) -> String {
    value
      .trimmingCharacters(in: .whitespacesAndNewlines)
      .folding(
        options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive],
        locale: .current
      )
      .lowercased()
  }
}
