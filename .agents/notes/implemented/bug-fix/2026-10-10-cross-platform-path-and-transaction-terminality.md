# Agent Note: Cross-platform Wiki paths and provider transaction terminality

Status: implemented

English | [中文](2026-10-10-cross-platform-path-and-transaction-terminality.zh.md)

## Problem

The session-summary writer formed a durable Wiki-relative path with the host path separator. On Windows, the review-governance boundary correctly rejected that backslash path, leaving a candidate page without its review record. A provider-settings owner could also unload after settings were persisted but before the mutation read its committed descriptor; returning `provider-transaction-in-doubt` then misrepresented a known persisted-but-not-live outcome.

## Decision

The [Knowledge Wiki session summarizer](../../../../packages/host/knowledge-wiki/src/index.ts) constructs durable Wiki-relative paths with `path.posix.join`; filesystem paths continue to use the host `path.join`. The [provider transaction owner](../../../../packages/llm/llm/src/provider-transaction.ts) records `committed-not-live` with a `settings-rejected` failure when its settings owner disappears after persistence. It does not report live success or leave a recoverable transaction open when the committed settings descriptor is no longer available.

The Windows native gate retains broad package-link and output-truncation assertions while bounding their repetition and volume under instrumented coverage: the profile test still repoints all 160 links on each pass, and the PowerShell output still exceeds the 16,000-character response cap.

## Alternatives considered

**Accept backslashes at the governance boundary.** Durable Wiki references are deliberately POSIX-style and reject traversal and platform-specific separators. Keeping the boundary strict and fixing the trusted producer preserves one portable format.

**Keep an in-doubt transaction after the settings owner disappears.** Settings persistence has already completed at this point. Writing a terminal `committed-not-live` receipt records what is known and prevents a later recovery attempt from implying activation.

**Keep the original Windows stress volume.** Forty complete repoints of a 160-link graph and a 12,050-line PowerShell stream exceeded the Windows coverage runtime. Twelve passes still exercise 1,920 link changes, while 5,000 lines still cross the output cap; both checks preserve the behavior they cover with less test time.

## Consequences

The review index now receives the same slash-separated candidate path on every host. Provider shutdown races leave an explicit, terminal receipt that distinguishes persistence from activation. The Windows native lane still needs to complete successfully on GitHub before cross-platform acceptance is reported.

## Testing

The focused Vitest run for provider transactions, Wiki session summaries, profile fallback, and persistent PowerShell Loader composition passed on macOS: 132 passed and one environment-specific PowerShell suite skipped. The Windows-native cases require the GitHub Windows runner for final verification.
