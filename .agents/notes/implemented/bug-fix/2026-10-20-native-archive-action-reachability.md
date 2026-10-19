# Agent Note: Native archive actions without pointer hover

Status: implemented

English | [中文](2026-10-20-native-archive-action-reachability.zh.md)

## Problem

An archived conversation's restore and permanent-delete buttons exist only while its native sidebar row is hovered. An assistive client cannot invoke a control absent from the accessibility tree, and a row without a persistent action cannot restore a conversation through keyboard or accessibility navigation. Successful archive RPCs do not establish that these native controls are reachable.

## Decision

Each [native archive row](../../../../integrations/jiuzhang/native/Sources/JiuzhangShellUI/NativeArchiveSidebarView.swift) exposes a full-row native context menu and named, localized accessibility actions independently of pointer hover. The row retains a stable session-specific accessibility identifier and its conversation title as its label. Existing hover buttons keep their compact placement and gain explicit localized labels; the date, row height, approved Ark branding, and surrounding layout remain intact.

Both entry paths reuse the existing model mutations. Restore calls `restoreArchivedSession`; permanent delete only sets `pendingDelete` and opens the existing named destructive confirmation. Cancel clears that pending intent without deleting. Menu items are disabled while the session's archive mutation is running, and accessibility actions reject invocation in that state. These controls do not bypass the [registry-owned archive and deletion lifecycle](../feature/2026-07-31-session-archive-global-set.md).

## Alternatives considered

**Keep hover as the only entry.** The buttons remain absent until a pointer event changes local row state, leaving assistive navigation dependent on a mouse interaction it does not own.

**Keep the icon buttons permanently visible.** This makes the controls discoverable but displaces the date and changes the accepted compact row layout. A native context menu and named accessibility actions provide another invocation path while preserving that presentation.

## Verification

A build or the existing native contract suite does not prove menu or assistive invocation. Restore, cancellation, confirmed deletion of synthetic conversations, persistence, and visual agreement with the approved baseline require separate candidate interaction evidence. That evidence records real native actions and resulting state without a test-only mutation API; this note does not record GUI acceptance as passed.

## Consequences

Archive actions retain one model owner and one deletion confirmation while becoming available without changing hover state. Pointer users keep the existing compact buttons; assistive clients gain explicit named actions. Builds and source checks remain insufficient for native interaction acceptance, and no test-only mutation path substitutes for the product controls.
