# Agent Note: Derive native turn navigation from durable terminal state

Status: proposed

English | [中文](2026-09-13-native-turn-navigation-terminal-state.zh.md)

## Problem

Imported history contained all nine turn-end events, yet native navigation labelled turns 1, 3, 4, and 9 as running. Those turns ended as interrupted or aborted. Navigation treated absence from the successful-fork set as running and inferred interruption from the final assistant message. A turn can end without an interrupted message, or without any assistant message; its empty navigation detail then incorrectly said Pending.

## Proposal

The existing [turn projection](../../../../integrations/jiuzhang/native/Sources/JiuzhangShellUI/ArkChatTurnMetrics.swift) retains terminal state from every `turn/end`. [History snapshots](../../../../integrations/jiuzhang/native/Sources/JiuzhangShellUI/ArkHistoryReadingWindow.swift) carry this fact from the same-cut turn seed; live snapshots carry it from the existing model projection. [Navigation](../../../../integrations/jiuzhang/native/Sources/JiuzhangShellUI/ArkRootView.swift) uses that state for its marker, accessibility value, and empty-answer detail. Terminal changes also invalidate the existing presentation cache.

Known reasons distinguish completed, aborted, interrupted, failed, blocked, and output-limited turns. An unfamiliar extension reason still proves that the turn ended. Without terminal evidence, only the current live turn may display Running; a historical cut displays Historical prefix and an inactive unresolved turn displays Unknown state. The successful-fork set remains completed-only, preserving the independent [completed-tail action boundary](../../implemented/bug-fix/2026-08-02-message-fork-actions-require-completed-turn-tail.md).

## Alternatives considered

**Add every ended turn to the completed set.** This would grant successful-fork eligibility to failed or interrupted turns.

**Infer lifecycle from the last assistant message or session activity.** Message interruption is a different fact, and one current session status cannot describe all historical turns. The original log already contains the required terminal evidence.

## Acceptance criteria

Behavior checks must cover every built-in reason, an extension reason, a turn without assistant output, incremental versus restored projection, same-cut history installation, and unchanged fork eligibility. Real candidate navigation must agree with the imported history's terminal events, including empty-answer help. Source checks and synthetic tests do not establish candidate acceptance or production promotion.

## Risks

A fixed cut may precede a later terminal event; displaying a historical prefix is intentional until the user returns to a newer cut. Unknown extension reasons receive a generic ended label rather than an invented success or failure classification.
