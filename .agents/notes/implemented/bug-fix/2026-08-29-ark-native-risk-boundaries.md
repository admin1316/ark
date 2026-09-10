# Agent Note: Ark native risk boundaries

Status: implemented

English | [中文](2026-08-29-ark-native-risk-boundaries.zh.md)

## Problem

Ark could assemble a Native client with an older Host RPC set, build directly over an existing or production `Ark.app`, persist Provider secrets in a recovery journal or child argv, discard editor changes created while Git was running, replace an event pump before its WebSocket receive loops reached quiescence, trap on duplicate wire/config identifiers, route a model owned by an inactive Provider, lose the final Workbench edit inside its debounce window, stop only the foreground Terminal shell while descendants survived, auto-fetch remote Markdown images, retain a drifted third-party bundle in the product profile, and dispatch non-API WebSocket upgrades even while the listener claimed API-only mode.

## Decision

Native builds are candidate-only. The output owner rejects production, link-shaped, nested, and existing App targets, while the self-contained build follows the Native API runtime plan and requires every strict Remote route in the implementation, generated descriptor, Host lookup, and package entry before and after embedding.

Provider mutation keeps one durable transaction identity per Provider. Its active journal contains settings intent and a credential digest, never credential material. macOS Keychain writes run `/usr/bin/security` in a private pseudoterminal and provide both confirmations through terminal input; the value never enters argv, captured output, a document, or a propagated diagnostic.

Workbench Git operations capture the clean file-tab state at launch. A successful worktree-changing operation resets tabs only when the current state is still exactly that clean snapshot; later edits, opened tabs, and selection changes remain owned by the user and existing save CAS rejects external-file conflicts.

`ArkEventPump.stop()` is one asynchronous quiescence operation shared by concurrent callers. It cancels sockets and receive tasks, awaits every task, then finishes the stream. `ArkAppModel.shutdown()` awaits that operation before AppKit releases the interface or starts a replacement backend lifecycle.

Duplicate identities are handled at their domain owners instead of by a trapping dictionary initializer. Provider model rows, sessions, and Wiki paths/pages preserve Host order and the first unambiguous row; duplicate feedback message IDs reject the wire response. The composer filters fallback model groups through the current Provider `active` facts and remains unavailable until those facts are known.

AppDelegate owns a `NativeWorkbenchDraftFlushCoordinator`; mounted Workbench models register weak flush callbacks. Termination and backend replacement flush the latest dirty-tab snapshot before and after model shutdown, and any persistence failure vetoes teardown while retaining the interface. Journal writes keep the existing owner-only, same-directory atomic persistence and never log draft text.

Native Terminal launch now uses the Ark executable's pre-application helper mode with `posix_spawn`, a new session, `login_tty`, and a verified foreground process group. Closing a tab asynchronously enumerates only groups in the owned session, applies bounded HUP, TERM, and KILL escalation, and performs the one `waitpid`; a child that deliberately escapes with a new session is outside this ownership boundary. Remote Markdown images render as validated native links and inert metadata instead of background `AsyncImage` requests.

API-only authority is enforced before upgrade-route dispatch: a loopback-authorized upgrade outside `/api` receives 404 even when it carries a token. Ark-owned profile files are reconciled only through ordinary, non-shared, non-writable directory and file paths; drift is content-addressed into an owner-only, fully verified rollback before compare-and-swap replacement. The mandatory Native overlay disables the browser roster and sets `serveFrontend: false`, so Ark resolves no frontend dist and mounts no HTML fallback while retaining the current startup/readiness and Host half of the `/api` event transport.

Queue controls and the composer expose stable accessibility identities. A saved model route is usable only while its Provider is active; an absent route displays an explicit unavailable state and keeps Send disabled even with a non-empty draft. Queue edit, remove, and strict-steer remain Host-owned mutations over stable item identities.

The root three-column `Layout` exports no alignment guide, so both `explicitAlignment` overloads return `nil`. This overrides SwiftUI's default implementation, which derived alignment by re-entering `placeSubviews` and repeatedly measuring the complete chat `LazyVStack`; placement remains the sole owner of main, divider, and Workbench geometry.

## Verification

Artifact-policy contracts reject unsafe outputs and missing Host routes. Provider and Keychain tests cover digest-only journals, transaction recovery, secret-free errors, and PTY input. The assembled-app E2E uses an isolated home and harmless credential to prove Keychain set, a secret-free credential document, restore, and unset. Native contracts cover dirty-tab preservation, duplicate-key inputs, inactive Provider filtering, termination flush, concurrent EventPump stop, Terminal session ownership, inert remote images, Queue accessibility seams, and the root explicit-alignment override. Candidate behavior covers exact backend replacement, restored UI, complete process/port cleanup, and an isolated unsaved file that survives quit as a `0600` recovery record, reopens through the recovery sheet, and leaves the source file unchanged. The v82 candidate additionally proved live profile rollback identity, zero active browser-roster or Better Sidebar entries, 404 for both Better Sidebar terminal upgrades with and without Bearer authentication, 401/101 for unauthenticated/authenticated `events.mux`, a real PTY command plus HUP/TERM-resistant background-process reap, explicit unavailable-model disablement with zero created sessions, and live Queue edit/remove/steer against a local stalled mock. Its five-minute soak then reproduced the layout fault: 35 consecutive decayed `ps` readings above 80% were confirmed by a five-second sample with 3,607/3,880 main-thread samples in SwiftUI flush and 889 entries through default alignment into `ArkRootSplitLayout.placeSubviews`. The v83 sample after the override had 4,285/4,285 main-thread samples in normal `mach_msg`; interval `top` measured Hero repeat at maximum 63% with zero samples at or above 80%, and a three-minute real user task at maximum 47.5% with zero samples at or above 80%. Queue recovery after dropping only the `events.mux` socket remains unproven.

## Alternatives considered

**Patch the existing bundle in place.** This would preserve source/artifact drift and bypass candidate identity, rollback, and codesign evidence, so the build fails instead.

**Pass the Keychain value to `security -w` in argv.** Process inspection and child diagnostics can expose it, so argv never carries credential material.

**Pipe the value to ordinary stdin.** macOS `security -w` reads and confirms through a controlling terminal; a pipe can exit without storing the intended value. The implementation uses the already-pinned `node-pty` dependency and requires both prompts.

**Disable the editor for the entire Git operation.** This narrows user interaction without proving that late callbacks preserve state. Snapshot ownership retains normal editing and makes the destructive reset conditional at its commit point.

**Keep trapping dictionary initializers and trust Host uniqueness.** Several values cross wire, persistence, and plugin boundaries where duplicates remain representable. Domain-specific first-row ownership or an explicit invalid-response error preserves order without converting ambiguity into a process crash.

**Treat model ID membership as routability.** An inactive Provider can still retain catalog/settings rows, so membership is advisory. Current Provider activity remains the fail-closed authority.

**Rely on the 350 ms draft debounce during termination.** Quit and backend replacement can occur before the scheduled write. The lifecycle owner invokes the same journal directly and vetoes teardown on failure.

## Consequences

Credentials-local has a runtime dependency on the already-shipped `node-pty` package for macOS Keychain mode. Candidate assembly refuses stale runtimes instead of producing a partially functional App. Git may still change the worktree before a concurrent edit is observed, but the in-memory draft survives and cannot silently overwrite the changed file. First-wins Wiki deduplication hides later ambiguous rows instead of repairing upstream data. The Native product packages no browser application, HTML fallback, or WebKit surface. Host-only Remote and NativeEvents owners provide the authenticated loopback API and event transports. This decision does not close fixed-port policy, the Queue mux-only reconnect proof, B0 freeze, unified soak, or production promotion.
