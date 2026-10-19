# Agent Note: Shared native JSON integer validation

Status: implemented

English | [中文](2026-10-11-shared-native-json-integer-validation.zh.md)

## Problem

History RPC parsing, live event envelopes, native catch-up, and model-capacity parsing carried the same finite, integral, JavaScript-safe number predicate. Settings snapshot and mutation duplicated namespace decoding and converted unchecked revision numbers to `Int`, allowing truncation or an out-of-range trap. Context and domain decoders repeated a nonnegative native-integer predicate with a different upper bound.

## Decision

[`JSONValue.jsonSafeInteger(minimum:)`](../../../../integrations/jiuzhang/native/Sources/JiuzhangShellCore/ArkAPIClient.swift) owns this predicate. History, event-pump, semantic-history, subagent-page, and UI callers validate at their existing entry points. The default minimum is zero; subscription and source-cut callers explicitly allow the `-1` sentinel, and model capacity requires a minimum of one. These callers retain their finite, integral, JavaScript-safe and native `Int` bounds.

The [settings decoder](../../../../integrations/jiuzhang/native/Sources/JiuzhangShellCore/ArkSettingsAPI.swift) validates revision as a nonnegative JavaScript-safe integer, matching the [settings authority](../../../../packages/settings/settings/src/index.ts). Snapshot reads skip invalid namespaces; mutation rejects an invalid response. Both paths use the same namespace decoder without changing the wire fields or their distinct failure policies.

`JSONValue.nonnegativeIntegerValue` owns the native predicate used by context and domain decoders: finite, integral, nonnegative, and strictly below `Int.max`. Positive-only context fields additionally reject zero. The two predicates retain their distinct bounds.

## Alternatives considered

Keeping separate predicates retains maintenance drift. Removing checks from an entry point weakens that input boundary. Putting the shared predicate on the JSON value type lets both Core and UI consume it without making numeric validation depend on the API client.

## Consequences

Each numeric rule has one pure implementation. Callers retain their own error paths and ordering checks. The [numeric contracts](../../../../integrations/jiuzhang/native/Tests/JiuzhangShellCoreTests/ArkChatPresentationContractChecks.swift) cover valid endpoints, the sentinel, nonnumbers, nonfinite values, fractional values, and the distinct upper bounds. The [settings wire contracts](../../../../integrations/jiuzhang/native/Tests/JiuzhangShellCoreTests/ArkProviderRecoveryContractChecks.swift) exercise both describe and mutate responses: valid revisions preserve all namespace metadata, while fractional, negative, unsafe, overflowing and nonnumeric revisions follow each caller's failure policy. Invalid settings revisions cannot be silently truncated or passed to an unsafe integer conversion.
