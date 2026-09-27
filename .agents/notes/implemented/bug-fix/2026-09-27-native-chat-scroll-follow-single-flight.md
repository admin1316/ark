# Agent Note: Native chat following keeps one interruptible animation

Status: implemented

English | [中文](2026-09-27-native-chat-scroll-follow-single-flight.zh.md)

## Problem

Each accepted transcript height change moved a following AppKit chat synchronously to the new tail. Replacing that jump with a new animation for every streamed update would repeatedly restart the motion and could make the reader lose control of the viewport.

## Decision

`ArkChatScrollCoordinator` animates bottom-follow changes through AppKit for 160 ms. `ArkChatScrollFollowMotion` keeps one animation active; completion reads the current measured tail, rather than holding a second pending target. If an animation made no useful progress, it settles with one immediate correction instead of looping. Content shrink or an out-of-range viewport also corrects immediately. Scroll input freezes the current presentation position and invalidates the outstanding completion before AppKit handles the gesture. Reduced Motion, reader anchors, session changes, and explicit history positioning remain immediate.

## Alternatives considered

**Keep synchronous tail jumps.** Rejected because every completed transcript projection could move the visible viewport in a discrete step.

**Restart a smooth animation for every content change.** Rejected because a stream can update the target before motion completes, making repeated animation restarts compete with the reader's position.

**Add a separate SwiftUI scroll controller.** Rejected because the existing AppKit coordinator already owns per-session positions, user intent, and history anchors; a second owner could issue conflicting scrolls.

## Testing

The focused native `chat-scroll` contract group passes and covers one active animation, current-geometry handoff, no-progress settlement, shrink correction, user interruption, reduced-motion positioning, and the AppKit wiring. The stale-target, no-progress, and shrink regressions failed against the prior code and pass after correction. After removing a temporary focused-test selector, the full Jiuzhang native contract executable passed all 53 groups again. A scroll-only self-contained runtime pack verified 164 workspace packages and 315 physical package identities against its source; an older pack was formally rejected for plan drift. The scroll-only candidate `3.1.1` (`2026092703`) passed receipt, dependency-closure, build, and strict signature checks. Launch Services reported the running bundle at `~/ark-test/candidate/Ark.app`, with the expected isolated identifier and build number; production remained `3.1.0` (`2026092701`). A later Alpha2 audit added separate background-wakeup and queued-message fixes, so that candidate does not represent the final combined source.

A loopback-only mock returned 180 numbered synthetic lines per response. Four OpenAI-compatible requests completed with 469 streamed chunks each; no real model credentials or external provider were used. In the candidate window, a live screenshot showed numbered lines arriving while following the bottom, and completion showed line 180. A native wheel event moved the reader to lines 96–112 during another active stream; the same range remained visible after completion, and `Return to Latest` revealed line 180. The trajectory page displayed the three synthetic turns; returning to chat retained the completed transcript. Five candidate-only screenshots and their checksums are at `~/ark-test/evidence/alpha2-scroll-20260927/`. The test placeholder was deleted from the candidate-specific Keychain service, and the dedicated data home was emptied after the candidate exited.

Saving a hand-declared custom provider through Settings failed with `provider does not own the requested settings namespace`; the test used the existing DeepSeek route pointed at loopback instead. That separate settings defect was not changed in this scroll patch. The formal same-state visual comparison against the legacy source, longer repeated stress runs, and production promotion remain unverified.

## Consequences

Live followers move toward new content without an abrupt synchronous jump, while user gestures and historical reading retain their existing ownership. A tail update can take up to 160 ms to settle; when content grows again during that interval, the coordinator waits for the current animation to finish before following the measured new position. Shrink and stalled animation cases settle immediately.
