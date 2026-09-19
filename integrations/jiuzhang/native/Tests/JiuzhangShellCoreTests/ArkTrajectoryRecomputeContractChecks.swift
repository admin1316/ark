import Foundation
@testable import JiuzhangShellCore
@testable import JiuzhangShellUI

/// Trajectory rows belong to one session at one reading cut.
///
/// A recompute inside one context must keep the rows on screen until the new
/// fold lands: clearing first makes the table flash through an empty state it
/// never had. A recompute that moves context must not present the previous
/// context's rows as the new one's.
func runArkTrajectoryRecomputeContractChecks() {
  guard
    let cutSeven = try? ArkHistoryCut(sourceRevision: "rev-1", throughSequence: 7),
    let cutNine = try? ArkHistoryCut(sourceRevision: "rev-1", throughSequence: 9)
  else {
    check(false, "trajectory recompute fixtures construct")
    return
  }

  let sameContext = ArkTrajectoryContext(sessionID: "A", cut: cutSeven)
  let otherSession = ArkTrajectoryContext(sessionID: "B", cut: cutSeven)
  let otherCut = ArkTrajectoryContext(sessionID: "A", cut: cutNine)
  let liveContext = ArkTrajectoryContext(sessionID: "A", cut: nil)

  check(
    !arkTrajectoryRecomputeDiscardsRecords(current: sameContext, next: sameContext),
    "a recompute inside one session and one reading cut keeps the rows on screen"
  )
  check(
    arkTrajectoryRecomputeDiscardsRecords(current: sameContext, next: otherSession),
    "a recompute that moves to another session discards the previous session's rows"
  )
  check(
    arkTrajectoryRecomputeDiscardsRecords(current: sameContext, next: otherCut),
    "a recompute that moves to another reading cut discards the previous cut's rows"
  )
  check(
    arkTrajectoryRecomputeDiscardsRecords(current: nil, next: sameContext),
    "the first recompute for a context has no rows to keep"
  )
  check(
    !arkTrajectoryRecomputeDiscardsRecords(current: liveContext, next: liveContext),
    "a live session with no reading cut keeps its rows across a recompute"
  )
}
