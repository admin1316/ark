# Agent Note: Bound native startup parsing and Markdown publication work

Status: implemented

English | [中文](2026-09-08-native-startup-and-markdown-batching.zh.md)

## Problem

The standalone launcher invokes Node separately for every reachable JavaScript file before starting the backend. Process startup dominates this verification on a packaged runtime. Restoring a conversation also publishes one full SwiftUI transcript snapshot for each completed Markdown parse, repeatedly invalidating the same transcript during a burst of completions.

## Decision

The [runtime verifier](../../../../integrations/jiuzhang/src/runtime-closure.mjs) compiles reachable entries in bounded batches of 256 in a separate Node process. Node VM compilation uses module or CommonJS syntax according to the file extension and nearest package manifest; it never links or evaluates package code. A shebang is stripped only at byte zero; a preceding BOM must not turn Node-invalid input into accepted syntax. Package hashes, dependency reachability, forbidden packages, symlink rules, and receipt verification remain prerequisites.

The [native transcript feed](../../../../integrations/jiuzhang/native/Sources/JiuzhangShellUI/ArkRootView.swift) stages completed Markdown parses in the existing projection state. Parse completion schedules the existing feed refresh; that refresh reconciles the current session, source bytes, and request identity before synchronously draining ready blocks into one snapshot. No second completion queue or delayed installation separates validation from publication. Cancellation, source replacement, and session switching discard stale staged results.

The transcript render window moves by stable row identity instead of expanding to include the entire past. Earlier and newer controls keep every row reachable while preserving one bounded rendering owner. Historical preview rows load complete same-source content before enabling whole-message actions. Table columns use shared intrinsic text widths with a wrapping cap, independent of viewport geometry, so short columns do not force unnecessary horizontal scrolling.

The transcript scheduler and its contract probe share one base-interval policy; the probe does not maintain a second cadence formula. Trajectory body-loading checks require both a successful body response and a subsequent projection publication, so an empty observation window cannot establish row retention. Source-boundary checks do not depend on the event consumer being private.

When a turn completes, full Markdown parsing is asynchronous. A pending projected row retains its exact source and uses the existing bounded streaming renderer until canonical blocks install; it must not replace an already received answer with a history-loading spinner. Row identities still contain only the message ID and source slot, and the projection worker retains the existing session, source, and request checks. This transition does not imply that the complete long answer has already been laid out.

The trajectory fold computes an active assistant preview once after folding its chunks, rather than rescanning the growing full body for each delta. Canonical assistant messages still replace their streamed record. A 20,000-event regression retains the full output and every source event, compares the exact preview, and measures the fold against the five-second display budget.

## Alternatives considered

**Skip startup verification or cache only file timestamps.** This loses content and syntax validation after package changes. Batching retains the verification work and removes repeated process startup.

**Evaluate imports to verify modules.** Importing executes package code and can trigger filesystem, network, or registration effects. Compile-only VM constructors validate syntax without these effects.

**Publish every completed parse immediately.** Each completion copies the projection map and invalidates SwiftUI. Coalescing trades up to one short presentation interval for fewer copies and layout invalidations.

Cold and restored live sessions now retain the existing semantic reading snapshot in their conversation surface, replacing the separate record/cut/preview fields. The raw recovery tail is intentionally incomplete for closed turns; trajectory therefore combines semantic rows with replayed live rows and gives overlapping live messages precedence. Message body loads invalidate the same trajectory owner. This preserves closed history without a second reader, polling loop, or cache. Contracts check complete cold and warm row counts plus closed/active assistant bodies and duplicate suppression; native candidate acceptance remains separate.

The temporary plain Markdown frame now retains bounded opening and ending segments. Taking only a prefix of the already bounded streaming suffix hid the final completion marker while parsing was pending. The combined preview remains within the existing character budget plus its explicit omission separator and preserves grapheme boundaries; canonical content stays unchanged. Render-window sizing uses projected display rows rather than message count, so one answer containing thousands of paragraphs or tables retains the existing small long-transcript window after completion. The AppKit scroll coordinator also processes late body-height changes after a programmatic pin instead of discarding the next resize. Its existing no-op and reentrancy guards prevent redundant scrolling; the reading anchor still takes precedence over following the bottom.

Streaming trajectory builders append directly to their owned event and text buffers. Copying a builder before each append shared those buffers and repeatedly copied the growing prefix; the remote 20,000-event contract took 12.99 seconds. The unchanged contract and five-second budget pass locally in 0.048 seconds after in-place appends (the previous local run was 3.65 seconds), retaining every event and the exact final answer. Remote revalidation is still required.

## Consequences

Syntax parser objects remain bounded by the batch size and live outside the launcher heap. The selected Node must support VM modules and package-manifest discovery. The [runtime closure tests](../../../../integrations/jiuzhang/tests/runtime-closure.test.mjs) cover mixed syntax, invalid entries across batch boundaries, and absence of execution. The [native scroll tests](../../../../integrations/jiuzhang/native/Tests/JiuzhangShellCoreTests/ArkChatScrollContractChecks.swift) cover a 128-source batch, duplicate drain, source replacement, cancellation, and stale session completions. These checks do not establish production promotion or unbounded-session performance.

The bounded-container detail is being revised by the [native transcript layout proposal](../../proposed/bug-fix/2026-09-13-bounded-native-transcript-layout.md); parsing and publication decisions remain unchanged.
