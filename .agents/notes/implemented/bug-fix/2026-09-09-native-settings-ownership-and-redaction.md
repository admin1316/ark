# Agent Note: Native Settings ownership and conservative secret projection

Status: implemented

English | [中文](2026-09-09-native-settings-ownership-and-redaction.zh.md)

## Problem

Recovered Settings sources lack the native Remote methods preserved in the application, exact-revision activation results, and namespace retirement barriers. A redacted value can also leak credentials through an unvisited schema branch or a schema default. Unsubscribing an observer does not stop a callback already running.

## Decision

The existing Settings provider owns native reads, writes, and its local-document handoff. Generic Remote writes cannot mutate a namespace reserved by a domain transaction owner. Replies are detached; write rejections retain revision conflicts without exposing storage or validation diagnostics. The native command receives only the provider's unchanged absolute path and caller cancellation.

The provider binds settlement before commit notification and distinguishes persistence from successful owner callbacks. Namespace disposal retains ownership while accepted writes and started callbacks drain, including unsubscribed callbacks. A timed-out owner remains reserved until its work stops; an old scope cannot write through a replacement. This extends the [write-path owner](../architecture/2026-07-30-settings-write-path-integrity.md), whose queue and persistence decisions remain active.

Secret projection removes all positions declared by any union or intersection branch without selecting or evaluating a branch. Tuples retain indexes; secret array positions become null. Serialized defaults are redacted with their own schema, including parent defaults containing nested secrets. Unsupported secret-bearing transformations and unresolved references reject. This partially supersedes the redaction alternative in the [configuration hardening note](2026-08-15-config-backup-and-redaction.md); its backup and diagnostic decisions remain independent and active.

Dictionary key schemas participate in live-node discovery alongside values, so their serialized references remain recognizable in Native form metadata. Secret-bearing keys are refused before projecting values or defaults: retaining such a key in a path or a redacted-value object would itself reveal the secret. Public dictionary keys remain supported without weakening unknown-reference rejection.

Each projected layer must have a provable secret-container shape independently. A valid resolved value does not authorize passing through a malformed base, user layer or schema default. Non-absent malformed object, dict, array and tuple values whose schemas contain secrets reject with a fixed diagnostic that never echoes the value. Public containers retain their passthrough behavior; unmarked tuple tails remain outside secret classification.

## Alternatives considered

**A second Settings bridge.** It would duplicate write queues, cancellation, and provider-path ownership. The existing service already owns these operations.

**Resolve one union branch before redacting.** Resolution can transform values or admit the same value through a less restrictive branch. Taking every declared secret position avoids that dependency, at the cost of conservative over-redaction.

**Keep schema defaults verbatim.** Form metadata is also a wire payload and can contain the same credentials as the resolved value.

**Trust only effective-value validation.** A user layer can hide an invalid base or default while the descriptor still exposes that lower layer. Redaction therefore checks every layer it returns.

## Consequences

Behavior tests cover protected writes, conflicts, cancellation, path changes, activation rejection, delayed disposal, expired scopes, prototype-shaped JSON keys, and schema-default secrets. A real Loader and file-backed provider snapshot covers persisted native edits, activation, stale-editor refusal, and unload. Coverage remains a separate failing gate; these tests do not establish installed-app or production acceptance. Unsupported secret schemas reject, and unmarked strings are not automatically classified as credentials.
