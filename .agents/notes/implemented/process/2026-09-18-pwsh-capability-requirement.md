# Agent Note: PowerShell capability is an explicit coverage-lane requirement

Status: implemented

English | [中文](2026-09-18-pwsh-capability-requirement.zh.md)

## Problem

The complete coverage lane enforces per-file 100% coverage on every package it instruments, including `packages/shell/pwsh-local` and `packages/shell/pwsh-sandbox`. Those suites admit themselves through a pwsh availability probe and skip when the probe fails, while the coverage exemption list in [coverage-exclude.ts](../../../../scripts/coverage-exclude.ts) ran its own copy of the same probe. On attempt 1 of [CI run 35360633929](https://github.com/admin1316/ark/actions/runs/35360633929) the two disagreed: the suites skipped (`pwsh-sandbox` 19 tests with 13 skipped, `pwsh-local` 36 tests with 27 skipped) while the exemption list still treated pwsh as available, so the lane failed with a low-coverage error for files whose tests never ran.

The job logs record the runner image, the platform, and the skip counts, but not the probe's executable, exit code, stderr, or timeout, and both attempts ran the same image version. The exact reason for that first skip is therefore an evidence boundary: it is consistent with a PATH lookup that failed inside forked suite processes, with a spawn-level rejection under coverage load, or with an unusable tool, and no artifact distinguishes them. The follow-up design has to make the distinction observable instead of guessing.

## Decision

[packages/shell/pwsh-local/src/capability.ts](../../../../packages/shell/pwsh-local/src/capability.ts) owns one probe for the whole repository. It resolves the executable (an explicit argument, then an absolute path exported by a preflight, then the shared resolver), runs one bounded, profile-free, network-free synthetic command, and reports a typed reason: `OK`, `NOT_FOUND`, `NOT_EXECUTABLE`, `TIMEOUT`, `PROBE_FAILED`, or `VERSION_MISMATCH`, together with the executable, version, architecture, and detail. Every pwsh-gated suite calls its gate instead of carrying a private `spawnSync` copy, and the coverage exemption list calls the same gate, so a suite and the exemption list can never disagree again.

The gate keeps the development-host skip: an unusable tool returns false and the optional suites skip as before. The complete coverage lane sets `DSH_REQUIRE_PWSH=1`, and the gate then throws with the executable, reason, and detail. A required suite therefore fails loudly instead of reporting a green skip, and a config-load failure replaces a silently exempted package.

[scripts/ci-pwsh-preflight.ts](../../../../scripts/ci-pwsh-preflight.ts) is the coverage job's prerequisite step. It prints one machine-readable capability line, exports the absolute executable (also through `GITHUB_ENV`) so forked suites cannot re-resolve it differently, and proves an execution round trip that echoes a token, which is the capability the suites actually use. When the tool is missing or unusable it installs the pinned official build into the job's temporary tools directory: PowerShell 7.6.6 for linux-x64 or linux-arm64, downloaded from the vendor release and verified against the published SHA-256 before extraction, with no global PATH change, no `sudo`, and no `curl | sh`. The step fails with the concrete reason when the capability still is not usable, and `ci.yml` orders it before the coverage consumer.

## Alternatives considered

**Rely on the runner image to provide pwsh.** The image does ship it, and that is exactly why the failure was invisible: a probe that fails for any reason becomes a skip, and the coverage error names a percentage instead of the capability. The preflight now states the fact it depends on.

**Force the suites to run by removing the skip.** Without a probe the suites would fail inside arbitrary fixture code, which moves the failure somewhere less readable and breaks the legitimate development-host skip.

**Retry the failing coverage job until it is green.** Attempt 2 passed, but a manual rerun is not a reproducibility guarantee; it leaves the same silent skip in place for the next occurrence.

**Install pwsh with a floating latest or a package manager.** Both make the lane depend on whatever the network serves that day; the pinned vendor asset with its published digest keeps the toolchain reproducible and reviewable.

**Make the suites trust a preflight receipt without probing.** A receipt is a claim about an earlier process; the round trip re-proves that this process can actually execute the tool it is about to test.

## Consequences

A development machine keeps the optional-suite skip, and the complete coverage lane either proves the capability before its consumers or fails with the executable, reason, and detail, so the next occurrence is diagnosable rather than inferred. A runner image without a usable pwsh self-heals from the pinned official build, and a tool whose major version is below 7 is reported as `VERSION_MISMATCH` instead of being used.

The historical attempt-1 cause stays a bounded unknown and is recorded as such rather than being relabelled as an environment fix. Bumping the pinned PowerShell version means updating both its URL and its published SHA-256, and the preflight covers linux-x64 and linux-arm64 only; other platforms must arrive with the tool present.
