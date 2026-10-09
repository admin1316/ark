# Agent Note: Native preset guidance for exact output and arithmetic

Status: implemented

English | [中文](2026-10-09-native-exact-output-guidance.zh.md)

## Problem

A Native task can produce correct final JSON while an earlier ordinary assistant message violates the user's whole-turn output contract. Finite-precision arithmetic can also agree with a fixture without establishing exactness for other inputs. Checking only the final message or one calculated example does not establish either property.

## Decision

The shared `standard` and `code` persona text in `packages/boot/profile-runner/config/agent-presets/` guides the model to honor requested output formats throughout the turn, use tools without extra narration for output-only requests, and preserve exact decimal and rational values until the specified rounding stage. The [profile runner](../../../../packages/boot/profile-runner/README.md) owns these Native-safe assets. Their scoped personas shadow the deployment default through the existing persona registration; the `minimal` preset's complete persona retains its exact semantics.

This is prompt guidance. Assistant text remains authoritative and visible in the session log; the change adds no output filter, retry, structured-output transport, event type, permission exception, or learning credit. It preserves the [per-session preset ownership](../architecture/2026-08-03-per-session-agent-presets.md) decision rather than superseding it.

## Alternatives considered

**Change the deployment persona or another preset copy.** A scoped preset persona shadows the deployment default, and unrelated assets do not determine the Native request. The shared owner is the place whose rendered text must be tested.

**Filter progress text or validate only the final JSON.** Filtering hides a genuine contract violation and changes the relationship between model output, durable history, and user-visible output. Final-message validation misses ordinary messages emitted before tool calls.

**Enable provider JSON mode or reuse child structured output.** Neither existing path supplies a root whole-turn contract across tool steps. A provider transport extension would require a separate reviewed public contract; child capture does not suppress earlier ordinary text.

## Consequences

The selected persona contributes additional stable prompt text and can change request-token accounting and prefix-cache reuse. Guidance remains probabilistic: runnable keyless composition verifies that the actual shared preset reaches the logged request, while fresh Native conversations independently test whole-turn output and exact calculations. A passing fixture is not proof of general arithmetic correctness, durable correction reuse, or a speed improvement.

The [Native composition regression](../../../../packages/bundle/native-api-app/tests/native-persona-request.spec.ts) mounts the real profile and shared presets, scripts only the external model, and compares the actual provider request with the durable header and public persistence inspection. Its complete header goldens cover POSIX tools; Windows needs independent actual PowerShell goldens. The unfiltered prelude/tool/final-message case retains cross-platform assertions and never credits its authored model output as compliance.
