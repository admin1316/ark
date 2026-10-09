# Agent Note: Read-only bash tasks use inline scripts

Status: implemented

English | [中文](2026-10-09-read-only-bash-inline-scripts.zh.md)

## Problem

A read-only computation can fail before its interpreter starts because the shell uses a temporary file to deliver a here-document. The failure then repeats in a fresh conversation despite an accurate final answer in the preceding task. Advice to escalate every sandbox denial does not distinguish that incidental write from access the task actually needs.

## Decision

The [bash tool](../../../../packages/shell/tool-bash/README.md#model-experience) supplies fixed cross-call guidance in its system-prompt section: here-documents, here-strings, and temporary script files can require writes; correctly quoted `python3 -c` or `node -e` arguments can perform permitted reads and computation without that temporary-file write. The model keeps the same sandbox and investigates the reported exit status. This is conditional advice, not a claim that every shell always uses a temporary file or that every inline script is read-only.

The tool description permits escalation only when the task requires the denied access and a wider mode would permit it. A denied read or write remains forbidden through any alternate route. The existing approval sequence, executor, command argv, managed environment, result markers, and wire format keep their contracts. The shared escalation hint reports the available approval path; it does not decide whether the task requires that access.

## Alternatives considered

**Escalate an incidental temporary-file write.** This seeks a wider permission solely for shell input delivery when the task can stay within its existing authorization. Escalation remains appropriate for genuinely required access under the existing approval policy.

**Rewrite shell commands automatically.** Replacing shell syntax would require preserving quoting, expansion, interpreter input, and cancellation semantics for arbitrary commands. The tool leaves commands under the model's control and confines their execution through the existing owner.

## Consequences

The guidance applies across bash callers without changing the executor or granting filesystem access. Its fixed text adds input tokens while the plugin is registered and retains the prompt section's existing scope and cache behavior. A result can still carry the unchanged general escalation hint, so its interpretation depends on the standing guidance and the task's actual access needs.

Text and keyless replay checks cannot establish that a real model avoids the failure. The isolated Native 3.1.8 task remains pending. This change supplies no verified learning or cross-conversation repair-reuse evidence, knowledge-admission authority, Rust migration, or measured speed improvement.
