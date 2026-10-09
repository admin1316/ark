---
description: "Shared profile lifecycle for executable dsh applications. runProfile() composes bundle layers, profile and home patches, command-line overlays, telemetry policy, fail-loud startup, and bounded shutdown against the caller's explicit installAnchor."
kind: "package-library"
---

# `@deepseek-ai/dsh-profile-runner`

English | [中文](README.zh.md)

## Summary

Shared profile lifecycle for executable dsh applications. `runProfile()` composes bundle layers, profile and home patches, command-line overlays, telemetry policy, fail-loud startup, and bounded shutdown against the caller's explicit `installAnchor`. Generic applications keep live patch watching by default; managed applications set `watchLiveConfig: false`.

The package is also the single published source for the Native-safe `standard`, `code`, and `minimal` system presets. An application may add a distinct system root through `additionalSystemPresetRoots`; the generic CLI uses that seam for its CLI-only `cordis` preset without copying shared assets.

## Table of Contents

- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Model Experience

### Selected system preset

#### What the model sees

The runner adds no model-visible content. The application-selected preset owns scoped prompt sections and tools. The shared `standard` and `code` personas guide whole-turn output compliance and exact arithmetic without validating or filtering generated output; `minimal` retains its complete persona.

##### Shared standard/code guidance

```markdown
Follow the user's requested output format throughout the entire turn, including before and between tool calls. For output-only requests, make necessary tool calls without optional user-facing narration, then emit only the requested result. If the user requires a single JSON value, emit that value in the requested shape without greetings, plans, progress updates, Markdown fences, or surrounding explanation. Do not invent a result to satisfy an output format. When exact arithmetic is required, parse decimal inputs exactly, keep ratios as integer fractions, and apply rounding only at the requested stage using the specified rule. Do not treat an approximation as exact merely because it uses high decimal precision.
```

#### Token effect

Indirect and preset-dependent: the selected preset's prompt and tool descriptions determine the request size.

#### KV Cache effect

The runner preserves the selected preset's request prefix; changing the profile, preset, or mounted plugin configuration can invalidate reuse of that prefix.

## Known Limitations and Deferred Work

- Live patch watching is process-wide and intended for generic CLI applications; managed products must opt out explicitly.
- Additional system roots must contain unique preset ids because two system owners cannot define the same shipped preset.
- Persona instructions do not guarantee output compliance or arithmetic accuracy; verify complete ordinary assistant output and calculated results independently.

### Dev Note

None.
