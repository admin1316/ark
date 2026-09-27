# Agent Note: Native chat following keeps one interruptible animation

Status: implemented

English | [中文](2026-09-27-native-chat-scroll-follow-single-flight.zh.md)

## Problem

Each accepted transcript height change moved a following AppKit chat synchronously to the new tail. Replacing that jump with a new animation for every streamed update would repeatedly restart the motion and could make the reader lose control of the viewport.

In a large transcript, changing from the 24-row streaming window to a 96-row completed window prepended older rows during final-answer layout. A real 20,000-delta candidate run showed one frame of earlier turns just before the completed answer appeared.

## Decision

`ArkChatScrollCoordinator` animates bottom-follow changes through AppKit for 160 ms. `ArkChatScrollFollowMotion` keeps one animation active; completion reads the current measured tail, rather than holding a second pending target. If an animation made no useful progress, it settles with one immediate correction instead of looping. Content shrink or an out-of-range viewport also corrects immediately. Scroll input freezes the current presentation position and invalidates the outstanding completion before AppKit handles the gesture. Reduced Motion, reader anchors, session changes, and explicit history positioning remain immediate.

`ArkChatRenderWindow` keeps a large transcript's follower at 24 mounted rows both during streaming and after completion. A user who scrolls to the top of a mounted page automatically opens a bounded reader window: the first expansion includes the current tail and uses 96 or 160 rows for large transcripts, while each later page overlaps the previous range by up to 32 rows. The AppKit coordinator emits one latched callback for a user-driven top edge; moving away rearms it, and a session transition resets it. Before each prepend the view captures its visible row and restores that anchor after layout. Once all currently loaded rows are mounted, the same gesture requests one older database page and pins the former first row at the top. The existing buttons remain available for pointer users. Followers stay at 24 rows, and no second projection owner or polling loop is introduced.

## Alternatives considered

**Keep synchronous tail jumps.** Rejected because every completed transcript projection could move the visible viewport in a discrete step.

**Restart a smooth animation for every content change.** Rejected because a stream can update the target before motion completes, making repeated animation restarts compete with the reader's position.

**Add a separate SwiftUI scroll controller.** Rejected because the existing AppKit coordinator already owns per-session positions, user intent, and history anchors; a second owner could issue conflicting scrolls.

**Widen every large transcript when the stream ends.** Rejected because the extra rows change measured content height during the final Markdown update, visibly moving a following viewport to older turns before AppKit settles it. Readers can widen the range explicitly.

**Keep the older-page button as the only way past a render-window edge.** Rejected because a normal wheel or trackpad gesture stops at offset zero and requires a separate click, making a long transcript feel like scrolling has stalled. User-driven top-edge paging keeps the same bounded range and restores the visible row after each prepend.

## Testing

The focused native `chat-scroll` contract group passes and covers one active animation, current-geometry handoff, no-progress settlement, shrink correction, user interruption, reduced-motion positioning, and the AppKit wiring. The stale-target, no-progress, and shrink regressions failed against the prior code and pass after correction. After removing a temporary focused-test selector, the full Jiuzhang native contract executable passed all 53 groups again. A scroll-only self-contained runtime pack verified 164 workspace packages and 315 physical package identities against its source; an older pack was formally rejected for plan drift. The scroll-only candidate `3.1.1` (`2026092703`) passed receipt, dependency-closure, build, and strict signature checks. Launch Services reported the running bundle at `~/ark-test/candidate/Ark.app`, with the expected isolated identifier and build number; production remained `3.1.0` (`2026092701`). A later Alpha2 audit added separate background-wakeup and queued-message fixes, so that candidate does not represent the final combined source.

The mounted-range regression asserts the same 24-row follower limit on both sides of completion for 601 and 4,444 entries, and the same 96-row reader limit for a 4,444-entry transcript. The visual observation that motivated it used an isolated synthetic candidate and is not a post-fix visual pass; candidate retesting remains required before promotion.

On 2026-09-28, the isolated pre-fix candidate `2026092811` completed a 30-minute synthetic run with 20,000 streamed deltas, a tool call, and the final after-tool marker. The candidate UI accessibility tree contained the final answer and tool result, while a screenshot kept the reader on turns A/1427–1428. At the top of the mounted window, the scroll offset reached zero and the UI exposed “Load earlier content (4,373)”; further wheel movement could not reach earlier rows without pressing that button. This reproduces the scrolling complaint separately from delivery: the final stream arrived, but the bounded reader edge interrupted continuous scrolling. The 1,831-sample candidate process monitor passed with mean aggregate CPU 19.375%, peak aggregate RSS 337,200 KiB, and no process exit. The post-fix candidate scroll check is still pending.

A loopback-only mock returned 180 numbered synthetic lines per response. Four OpenAI-compatible requests completed with 469 streamed chunks each; no real model credentials or external provider were used. In the candidate window, a live screenshot showed numbered lines arriving while following the bottom, and completion showed line 180. A native wheel event moved the reader to lines 96–112 during another active stream; the same range remained visible after completion, and `Return to Latest` revealed line 180. The trajectory page displayed the three synthetic turns; returning to chat retained the completed transcript. Five candidate-only screenshots and their checksums are at `~/ark-test/evidence/alpha2-scroll-20260927/`. The test placeholder was deleted from the candidate-specific Keychain service, and the dedicated data home was emptied after the candidate exited.

Saving a hand-declared custom provider through Settings failed with `provider does not own the requested settings namespace`; the test used the existing DeepSeek route pointed at loopback instead. That separate settings defect was not changed in this scroll patch. The formal same-state visual comparison against the legacy source, longer repeated stress runs, and production promotion remain unverified.

## Consequences

Live followers move toward new content without an abrupt synchronous jump, while user gestures and historical reading retain their existing ownership. A tail update can take up to 160 ms to settle; when content grows again during that interval, the coordinator waits for the current animation to finish before following the measured new position. Shrink and stalled animation cases settle immediately.

Large transcripts show the latest 24 mounted rows until the reader explicitly pages older; this avoids automatic range growth at completion while keeping older turns available through the existing paging control.
