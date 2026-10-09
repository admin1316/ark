# Agent Note: Literal stdin for sandboxed Bash tools

Status: implemented

English | [中文](2026-10-09-bash-literal-stdin.zh.md)

## Problem

macOS Bash 3.2 writes here-document input to a temporary file before starting an interpreter. A read-only rational calculation therefore fails even though it only needs to read an existing CSV. Inline-script guidance leaves the model assembling nested shell quoting and does not expose the existing process input channel.

## Decision

The [Bash tool](../../../../packages/shell/tool-bash/README.md) exposes optional literal `stdin`, forwarding it through the existing shell and subprocess providers. A model sends a multiline script with `command: "python3 -"` and the script as `stdin`. The command is executed unchanged; input is written as UTF-8 and then closed. Omitted input retains the command-only behavior, and an empty string remains valid.

The tool checks UTF-8 bytes against its positive safe-integer `maxStdinBytes` configuration before this tool’s sandbox escalation approval, job registration, or execution. The default is 1 MiB; larger input is rejected whole, without truncation or a temporary-file fallback. Trusted in-process callers retain their existing shell request contract.

Both fields remain in the ordinary logged tool arguments. Calls with stdin use the existing generic execute card with `{command, stdin}` as its raw input; foreground results retain the terminal result view and its exit status, so a nonzero exit remains visible as a failure. Command-only presentations, event envelopes, environment protection, sandbox profiles, cancellation, output bounds, and process cleanup retain their existing owners.

This supersedes the model-facing stdin omission in the [stdin/env decision](../architecture/2026-06-30-bash-stdin-env-trusted-plugin-api.md) and the reliance on the [inline-script guidance](2026-10-09-read-only-bash-inline-scripts.md). The tool still forbids using an alternate route to obtain a denied read or write.

## Alternatives considered

**Allow temporary writes under read-only mode.** This would weaken the established file policy for every command sharing that allowance.

**Rewrite here-documents or change shells.** Automatic conversion would need to preserve arbitrary quoting, expansion, redirection, and shell behavior. Newer Bash also retains a temporary-file path for sufficiently large here-documents, so selecting it does not provide a general solution.

**Keep only inline-script guidance.** Nested quoting and argument-size constraints remain, while the subprocess provider already accepts literal input with managed lifecycle behavior.

## Consequences

The additive tool field gives permitted multiline tasks a temporary-file-free input path. It does not make arbitrary unchanged Bash 3.2 here-documents succeed: their write denial remains an explicit regression test. A real model can still choose that syntax; native candidate acceptance must examine every tool outcome and cannot infer success from this source change.

The registered `bash-stdin` headless snapshot executes the real tool and command, preserving its literal input and output in the assembled log. Focused tests cover UTF-8 size boundaries, large input, ignored input, cancellation, request forwarding, presentation, a real Seatbelt rational calculation, and an attempted write whose file remains absent. These checks do not establish native acceptance, cross-conversation learning, or a release result.
