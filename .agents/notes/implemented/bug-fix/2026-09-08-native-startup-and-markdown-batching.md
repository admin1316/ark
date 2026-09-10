# Agent Note: Bound native startup parsing and Markdown publication work

Status: implemented

English | [中文](2026-09-08-native-startup-and-markdown-batching.zh.md)

## Problem

The standalone launcher invokes Node separately for every reachable JavaScript file before starting the backend. Process startup dominates this verification on a packaged runtime. Restoring a conversation also publishes one full SwiftUI transcript snapshot for each completed Markdown parse, repeatedly invalidating the same transcript during a burst of completions.

## Decision

The [runtime verifier](../../../../integrations/jiuzhang/src/runtime-closure.mjs) compiles reachable entries in bounded batches of 256 in a separate Node process. Node VM compilation uses module or CommonJS syntax according to the file extension and nearest package manifest; it never links or evaluates package code. A shebang is stripped only at byte zero; a preceding BOM must not turn Node-invalid input into accepted syntax. Package hashes, dependency reachability, forbidden packages, symlink rules, and receipt verification remain prerequisites.

The [native transcript feed](../../../../integrations/jiuzhang/native/Sources/JiuzhangShellUI/ArkRootView.swift) stages completed Markdown parses in the existing projection state and publishes one snapshot after a 16 ms coalescing interval. Publication revalidates session, source bytes, and request identity. Cancellation, source replacement, and session switching discard stale staged results.

## Alternatives considered

**Skip startup verification or cache only file timestamps.** This loses content and syntax validation after package changes. Batching retains the verification work and removes repeated process startup.

**Evaluate imports to verify modules.** Importing executes package code and can trigger filesystem, network, or registration effects. Compile-only VM constructors validate syntax without these effects.

**Publish every completed parse immediately.** Each completion copies the projection map and invalidates SwiftUI. Coalescing trades up to one short presentation interval for fewer copies and layout invalidations.

## Consequences

Syntax parser objects remain bounded by the batch size and live outside the launcher heap. The selected Node must support VM modules and package-manifest discovery. The [runtime closure tests](../../../../integrations/jiuzhang/tests/runtime-closure.test.mjs) cover mixed syntax, invalid entries across batch boundaries, and absence of execution. The [native scroll tests](../../../../integrations/jiuzhang/native/Tests/JiuzhangShellCoreTests/ArkChatScrollContractChecks.swift) cover a 128-source batch, duplicate drain, source replacement, cancellation, and stale session completions. These checks do not establish production promotion or unbounded-session performance.
