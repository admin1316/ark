import Foundation
@testable import JiuzhangShellCore
@testable import JiuzhangShellUI

/// A reported gap must never be treated as healed: the resync re-pulls a full page, and the
/// page validator is the gate that proves the re-pull actually closed the range. The applied
/// anchor is what makes that re-pull converge: it may only advance contiguously, so a hole has to
/// be paged in rather than skipped or truncated away.
func runArkEventChannelRecoveryContractChecks() {
  func event(_ id: Int) -> ArkHistoryEvent {
    ArkHistoryEvent(id: id, type: "turn/start", time: Date(timeIntervalSince1970: Double(id)), data: .null, view: nil)
  }

  // A contiguous page reaching the cursor validates.
  let contiguous = (1...5).map(event)
  precondition(
    (try? ArkEventSequenceValidator.validateReconciled(contiguous, expectedThrough: 5)) != nil,
    "a contiguous page reaching the cursor must validate"
  )

  // A page short of the cursor is reported incomplete — the state a reset resync must remove.
  let short = (1...3).map(event)
  precondition(
    (try? ArkEventSequenceValidator.validateReconciled(short, expectedThrough: 5)) == nil,
    "a page short of the cursor must be reported incomplete"
  )

  // The damaged state: the local baseline sits at 548334 while the stream has moved on.
  // Such a page must be rejected, never accepted as if the missing range had arrived.
  let gapped = [event(548334), event(548617)]
  precondition(
    (try? ArkEventSequenceValidator.validateReconciled(gapped, expectedThrough: nil)) == nil,
    "a page containing a gap must be rejected rather than accepted as healed"
  )

  // --- applied anchor -------------------------------------------------------

  // Consecutive frames advance the anchor by exactly one.
  var cursor = ArkSessionEventCursor()
  for id in 0...3 {
    precondition(cursor.observe(id) == .accepted, "sequence \(id) continues the range")
  }
  precondition(cursor.applied == 3 && cursor.next == 4, "the anchor tracks the last accepted frame")

  // The reported bug: the stream moves on while the local tail stops at 113151. The anchor must
  // stay put — the range is paged in — and the frame must never be applied on top of the hole.
  var behind = ArkSessionEventCursor(applied: 113151)
  precondition(
    behind.observe(115884) == .hole(target: 115884),
    "a frame above the anchor reports the hole instead of advancing the anchor"
  )
  precondition(
    behind.applied == 113151 && behind.next == 113152,
    "reporting a hole must not move the anchor: moving it would pretend the range arrived"
  )

  // Re-delivery inside the reconciled range is covered, not re-applied and not re-pulled.
  precondition(behind.observe(113151) == .covered, "an already covered sequence is skipped")
  precondition(behind.applied == 113151, "a covered sequence leaves the anchor untouched")

  // A baseline ahead of the anchor is the same hole; a baseline behind it reseats the anchor,
  // because that means the Host log itself shrank and the local frames no longer exist.
  var baselineAhead = ArkSessionEventCursor(applied: 100)
  precondition(
    baselineAhead.adoptBaseline(160) == .hole(target: 160) && baselineAhead.applied == 100,
    "a baseline above the anchor is a range to page in"
  )
  var baselineBehind = ArkSessionEventCursor(applied: 100)
  precondition(
    baselineBehind.adoptBaseline(60) == .covered && baselineBehind.applied == 60,
    "a shorter Host log reseats the anchor on the baseline"
  )
  var freshAttach = ArkSessionEventCursor()
  precondition(
    freshAttach.adoptBaseline(-1) == .covered && freshAttach.applied == -1,
    "an empty Host log leaves a fresh client at the start of the range"
  )

  // A frame a reconcile already staged stays in the dedupe set; when it is the next sequence
  // it must still advance the anchor. The live handler therefore observes the cursor first and
  // dedupes only the append — dropping the frame on the dedupe before the cursor saw it left the
  // anchor behind the transcript and turned the *next* frame into a hole that never existed.
  var restaged = ArkSessionEventCursor(applied: 100)
  precondition(
    restaged.observe(101) == .accepted && restaged.applied == 101,
    "a frame restaged by a reconcile still advances the anchor when it is next"
  )

  // Reconciliation may raise the anchor to a contiguous head, never lower it.
  var reconciled = ArkSessionEventCursor(applied: 113151)
  reconciled.adoptReconciledHead(115884)
  precondition(reconciled.applied == 115884, "a reconciled head raises the anchor")
  reconciled.adoptReconciledHead(115000)
  precondition(reconciled.applied == 115884, "a stale head must never move the anchor backwards")

  // The healed install is the local tail plus exactly the missing range: it stays a superset of
  // what the stream already delivered, so healing never rewinds the transcript.
  let healed = contiguous + (6...9).map(event)
  precondition(
    (try? ArkEventSequenceValidator.validateReconciled(healed, expectedThrough: 9)) != nil,
    "bridging the missing range must validate contiguously"
  )
  precondition(
    healed.prefix(5).map(\.id) == contiguous.map(\.id),
    "a heal must keep the delivered tail instead of re-pulling from the baseline"
  )
  let rewound = [event(113151)] + [event(115884)]
  precondition(
    (try? ArkEventSequenceValidator.validateReconciled(rewound, expectedThrough: nil)) == nil,
    "a heal that jumps to the reported sequence is still a hole, not a heal"
  )

  // --- presentation pacing -------------------------------------------------

  // Trimming to the exact cap rebuilds the turn projections over the whole window on every single
  // publish once the transcript reaches the cap, which is what starves the receive loop. The trim
  // batch has to leave real headroom below the cap.
  precondition(
    ArkStreamingPresentationPolicy.presentationTrimBatch > 0,
    "the presentation trim batch must be positive"
  )
  precondition(
    ArkStreamingPresentationPolicy.presentationTrimBatch <= ArkStreamingPresentationPolicy.presentedEventLimit / 2,
    "the trim batch must leave at least half the window below the cap"
  )
  precondition(
    ArkHistoryCatchUpAccumulator.maximumPresentationEvents
      == ArkStreamingPresentationPolicy.presentedEventLimit,
    "the live publisher and the history walk must agree on one presentation cap"
  )
}
