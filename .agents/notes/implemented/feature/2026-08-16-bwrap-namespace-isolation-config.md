# Agent Note: bwrap namespace isolation config

Status: implemented

English | [中文](2026-08-16-bwrap-namespace-isolation-config.zh.md)

## Problem

The enterprise audit flagged that the sandbox's three rungs confine file effects only: a bwrap-confined child shares the host PID and network namespaces, so it can signal same-uid host processes and reach the network. The seam's documented contract is file effects only, and network access is load-bearing for some confined commands, so turning isolation on unconditionally would break existing deployments.

## Decision

`dsh-sandbox-local` gains an optional `isolate` config (`{ network?: boolean, pid?: boolean }`, off by default). When enabled, the bwrap profile adds `--unshare-net` / `--unshare-pid` before the workspace mounts; the landlock, seatbelt, and windows-acl rungs ignore the option. The default preserves the documented file-effects contract; deployments needing namespace isolation opt in explicitly. Profile tests assert the exact argv with each flag combination, and the README (en/zh) documents the option.

## Alternatives considered

**Enable isolation unconditionally.** Rejected: the seam's contract is file effects only, network access is load-bearing for confined commands, and the landlock/seatbelt rungs cannot express the same isolation — a silent behavior change per platform would violate the shared-policy promise.

**Implement network/PID isolation for every rung.** Rejected: landlock has no namespace mechanism, seatbelt's is macOS-only, and windows-acl has none; the bwrap-only option covers the Linux deployment where the audit's signal/PID concern applies.

## Consequences

Deployments that set `isolate: { network: true, pid: true }` get namespace-isolated bwrap children and must accept that confined commands lose network access and cross-process visibility. Default behavior is unchanged.
