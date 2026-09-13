# Agent Note: GUI testing system — protocol, state and native presentation

Status: implemented

English | [中文](2026-07-20-gui-testing-system.zh.md)

## Problem

Ark spans Host domain operations, an authenticated API carrier, client-side state machines and AppKit/SwiftUI layout. One end-to-end lane cannot isolate every failure, while a fast fixture-only suite cannot establish real carrier behavior or native responsiveness. [Repository testing policy](../../../../docs/testing.md) owns general coverage and real-composition rules; this note owns the division of GUI evidence.

## Decision

Tests follow the current architecture's independently observable boundaries. The [Web UI retirement](../simplification/2026-08-29-retire-generic-web-ui.md) removes browser component and Client loader lanes; it does not remove the need to test protocol, state and assembled presentation separately.

| Tier | Owner | Evidence |
| --- | --- | --- |
| Host and wire | [Host Connection](../../../../packages/host/connection/tests), [API gateway](../../../../packages/api/gateway/tests), domain Remote tests | Actual dispatch, serialization, authority, cancellation and failure behavior. |
| Native state and protocol | [Native contract tests](../../../../integrations/jiuzhang/native/Tests/JiuzhangShellCoreTests) | Controlled event histories, paging, session selection, deferred requests, draft ownership and projection results. |
| Assembled presentation | Native app and its packaged sidecar | Real window interactions, request transport, scroll/input behavior and bounded CPU measurements. |

A state test uses the event-sequence-in, snapshot-out path and controls only nondeterministic inputs: deferred replies, clocks and external services. Pure projection functions use direct tests. An interaction regression runs the actual owning view/controller composition; it does not replace an expensive dependency with a fake implementation of the property under test.

Each layer owns its assertions. Lower layers pin wire and state semantics; upper layers pin visible behavior and the integration between real owners. A recorded fixture is useful for deterministic state transitions but cannot certify network lifecycle, authentication or system layout. Keyless real compositions remain required where they can exercise those boundaries; credentialed provider checks prove a separate boundary.

The existing [history-window contract](../../../../integrations/jiuzhang/native/Tests/JiuzhangShellCoreTests/ArkHistoryWindowContractChecks.swift) isolates the combined transition of history, workbench width and composer state in a subprocess with a hard deadline. This catches main-thread layout stalls that pure projection assertions cannot see. Its bounded history window remains part of the contract; a layout change cannot silently render the entire retained history.

## Verification discipline

Every repaired defect needs an assertion at its actual owner. Carrier changes require real carrier tests; native layout or gesture changes require native interaction evidence. A passing build, signature, fixture or Host test alone does not qualify an installed app for release. Preserve exit codes, process identity, state and measured duration with the result.

When intended behavior changes, reconcile the implementation, the owning decision and its tests together. Do not leave a red assertion behind, increase its timeout to hide a hang, or replace a real path with a simulated success. Use the current [development commands](../../../../docs/development.md), rather than maintaining a second command inventory in this decision.

## Alternatives considered

**One end-to-end test for everything.** It repeats application startup for cheap state checks and gives poor control of event races; a focused state test can isolate those cases deterministically.

**Only isolated state or fixture tests.** They cannot prove the transport and system UI mechanisms that they bypass. Both deterministic state checks and real composition evidence are necessary.

**Reuse a real-clock demo as the universal fake.** Demo timing and controlled concurrency tests have different purposes; forcing reuse makes test outcomes depend on the demo's scheduling.

**Treat browser output as native acceptance.** The native product has different layout, focus, lifetime and resource behavior. Removed browser lanes cannot substitute for actual AppKit/SwiftUI evidence.

## Consequences

Failures can be localized without paying the full app cost for every pure state assertion. The accepted cost is several complementary evidence layers and a real native acceptance step; green lower layers never imply that the user-visible app has passed.
