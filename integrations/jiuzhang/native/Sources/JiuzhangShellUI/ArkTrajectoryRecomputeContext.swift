/** Trajectory recompute context identity and the row-retention decision. */

import JiuzhangShellCore

/// The session and reading cut a set of trajectory rows belongs to.
///
/// Trajectory rows present one session at one source cut. Two recomputes belong
/// to the same context only when both parts match: a row folded from session A
/// is not a valid presentation of session B, and a row folded at one reading cut
/// is not a valid presentation of another.
struct ArkTrajectoryContext: Equatable {
  let sessionID: String?
  let cut: ArkHistoryCut?
}

/// Whether a recompute for `next` must discard the rows currently shown for `current`.
///
/// Rows belong to the context they were folded from. A recompute that moves to
/// another session or another reading cut must not leave the previous context's
/// rows on screen — the ledger would present one session's records as another's,
/// and stale rows would keep affordances that no longer apply. A recompute that
/// stays inside the same context keeps its rows until the new fold lands, so the
/// table does not flash through an empty state it never had.
///
/// Loading a second message body inside one reading window re-installs the same
/// session at the same cut, so it is a same-context recompute and must retain
/// the rows.
/// @param current - context of the rows currently on screen, or nil when none.
/// @param next - context the incoming recompute belongs to.
/// @returns true when the caller must clear the rows before folding.
func arkTrajectoryRecomputeDiscardsRecords(
  current: ArkTrajectoryContext?,
  next: ArkTrajectoryContext
) -> Bool {
  current != next
}
