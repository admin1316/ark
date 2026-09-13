# Agent Note: Bound native transcript layout and restore leaf text selection

Status: proposed

English | [中文](2026-09-13-bounded-native-transcript-layout.zh.md)

## Problem

A short conversation can stall the native interface during the combination of table reflow, a Workbench width change, and installation of another turn. Static history-loading probes did not reproduce this transition. Main-thread samples implicated SwiftUI lazy-stack layout; the backend could finish while the interface remained busy. Separately, disabling native text selection prevented users from dragging over conversation text.

## Proposal

The current source candidate replaces only the main transcript's `LazyVStack` with `VStack` in [ArkRootView](../../../../integrations/jiuzhang/native/Sources/JiuzhangShellUI/ArkRootView.swift). The existing [render window](../../../../integrations/jiuzhang/native/Sources/JiuzhangShellUI/ArkChatRenderWindow.swift) remains the mounted-row owner: at most 400 entries when settled, and 96 or 160 while streaming. Stable row identities, turn anchors, earlier/newer navigation, and return-to-latest remain intact. This does not mount the complete session.

[Markdown leaves](../../../../integrations/jiuzhang/native/Sources/JiuzhangShellUI/NativeMarkdownGFMView.swift) and reasoning text use standard SwiftUI `textSelection(.enabled)`. This covers shared user/assistant paragraphs, headings, list bodies, code, and table cells without adding a transcript-wide selection owner. Explicit full-message and full-code copy actions remain available.

Adjacent ordinary paragraphs from the same Markdown source share one selectable `Text`, reusing parsed inline values and the existing assistant row cache. A run contains at most eight paragraphs, 4,096 UTF-16 units, and 256 inline nodes; its identity is the first original block index. Code, tables, headings, and other block kinds end the run. A pre-existing oversized paragraph remains independent. The ordinary document renderer uses the same grouping rule; this does not join different messages or source blocks.

This is partial supersession of the bounded lazy-layout detail in [startup and Markdown batching](../../implemented/bug-fix/2026-09-08-native-startup-and-markdown-batching.md); its parsing and publication decisions remain active. The earlier [root alignment boundary](../../implemented/bug-fix/2026-08-29-ark-native-risk-boundaries.md) also remains necessary. Neither note qualifies for whole-note archival.

## Verification boundary

The same synthetic full-root Release transition, without a loaded WebKit page, timed out after 25.02 seconds with 17.17 seconds of child CPU on the old container. With the bounded `VStack`, it exited normally in 15.73 seconds with 1.04 seconds of child CPU and 54 heartbeats. A separate 100-turn Release case passed in 8.32 seconds with 3.37 seconds of child CPU. These are controlled diagnostic runs, not application latency percentiles or a production improvement percentage.

The UI target build passed. A native mouse-drag probe selected range `{0,19}` in a real text leaf. Its private-pasteboard `writeSelection` oracle returned false, so that probe is not evidence of successful or broken product Cmd+C. Real candidate drag-and-copy, the reproduced interaction sequence, and the 60-minute acceptance run remain pending; this note does not record a shipped release.

## Alternatives considered

**Keep the lazy container because static loading passes.** Those probes missed the failing width-change and turn-installation combination; the controlled transition is the relevant comparison.

**Disable hosting intrinsic sizing.** A matching pinned-host baseline passed without changing sizing options, so there was no corresponding failure evidence to justify changing the root host contract.

**Use an unbounded eager transcript or disable selection globally.** The former discards the existing mounting budget; the latter removes the user's requested interaction. Reusing the render window and native leaf selection avoids both costs.

## Acceptance criteria

The rebuilt candidate must remain responsive through table display, Workbench collapse/expansion, and the next streamed turn; preserve turn navigation and bidirectional history reachability; and support actual mouse-drag plus Cmd+C on user and assistant text. Complete the planned 60-minute active/idle run with CPU and memory receipts before recording release acceptance.

## Risks

An eager stack still measures up to the existing window limit; it is not a total-memory bound or proof of frame-time targets. A grouped row contains more than one original paragraph, so its bounded text budget and the combined-layout regression both matter. Native selection across separate runs, other block kinds, or messages is not guaranteed. Synthetic success cannot substitute for the user's real window, saved state, and accessibility interaction.
