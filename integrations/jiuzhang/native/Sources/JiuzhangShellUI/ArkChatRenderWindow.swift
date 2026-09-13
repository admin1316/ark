import Foundation

/// A movable, bounded row range. A reading anchor stays fixed while live rows
/// append; only an explicit return to latest resumes following the tail.
struct ArkChatRenderWindow: Equatable {
  private(set) var firstRowID: String?

  var followsLatest: Bool { firstRowID == nil }

  func range(in ids: [String], limit: Int) -> Range<Int> {
    guard limit > 0, !ids.isEmpty else { return 0..<0 }
    let start = firstRowID.flatMap { ids.firstIndex(of: $0) }
      ?? max(0, ids.count - limit)
    return start..<min(ids.count, start + limit)
  }

  mutating func earlier(in ids: [String], limit: Int) {
    let current = range(in: ids, limit: limit)
    guard current.lowerBound > 0 else { return }
    let overlap = min(32, max(0, limit / 4))
    let start = max(0, current.lowerBound - max(1, limit - overlap))
    firstRowID = ids[start]
  }

  mutating func later(in ids: [String], limit: Int) {
    let current = range(in: ids, limit: limit)
    guard current.upperBound < ids.count else { returnToLatest(); return }
    let overlap = min(32, max(0, limit / 4))
    let start = current.lowerBound + max(1, limit - overlap)
    if start >= max(0, ids.count - limit) { returnToLatest() }
    else { firstRowID = ids[start] }
  }

  mutating func reveal(_ id: String, in ids: [String], limit: Int) {
    guard let index = ids.firstIndex(of: id), limit > 0 else { return }
    firstRowID = ids[max(0, index - limit / 2)]
  }

  mutating func returnToLatest() { firstRowID = nil }
}
