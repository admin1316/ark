# Agent Note: Root-session automatic summary admission

Status: implemented

English | [中文](2026-10-12-session-summary-admission.zh.md)

## Problem

The Knowledge Wiki host writes automatic Candidates outside model file tools when an agent is disposed. Delegated agents share their parent's workspace and already send findings into the parent conversation. Treating every disposal as an independent summary owner can create duplicate pages and files during a delegated read task. Session lineage alone does not describe file permission, and approval mode does not substitute for file policy.

## Decision

The writer uses the complete optional session-query snapshot and the existing sandbox-policy event fold. It admits only the requested root-session identity, absent origin and parent lineage, zero or absent delegation depth, and an explicit writable logged mode. The existing non-main workspace and conversation-length checks still apply. Missing file policy skips automatic summarization rather than borrowing a deployment default whose value is absent from the captured log. Child results remain available through the parent's conversation and settlement notice.

After the asynchronous summary stage, the writer rereads eligibility and compares cwd, mode, event count, and extracted conversation before writing. Event count also rejects newly appended input beyond the extraction limit. The operation's existing controller rejects publication after cancellation. Reader and writer errors remain contained at the best-effort disposal boundary. Candidate formats, review governance, sandbox execution, model route, and promotion requirements are unchanged.

## Alternatives considered

- Filter only the disposal listener: rejected because direct summary callers would bypass admission.
- Disable automatic summaries: rejected because writable root conversations still own this supported behavior.
- Infer write permission from `approval=never`, lineage, or the prompt's prose: rejected because those facts do not supply a logged file policy or a structured per-file authorization.
- Summarize every child independently: rejected because the parent already receives the findings and owns the combined task context.

## Consequences

Delegated, read-only, unlogged-policy, and stale summary inputs cannot independently publish automatic Candidates. Existing writable root summaries still create and merge the same pages and review records. Old sessions without an explicit mode no longer qualify for automatic summary; explicit ingest and existing governed Wiki operations retain their own authorization.

This is a same-process pre-write recheck, not an atomic lock or multi-file rollback. A writable root policy is coarse eligibility, not a per-file task grant: arbitrary natural-language file allowlists are not enforced by this summary path. Source refusal tests and actual Loader disposal composition verify this decision; they do not establish independent verifier custody, knowledge reuse, installed-candidate acceptance, or a measured performance improvement.
