# `@deepseek-ai/dsh-profile-runner`

English | [中文](README.zh.md)

Shared profile lifecycle for executable dsh applications. `runProfile()` composes bundle layers, profile and home patches, command-line overlays, telemetry policy, fail-loud startup, and bounded shutdown against the caller's explicit `installAnchor`. Generic applications keep live patch watching by default; managed applications set `watchLiveConfig: false`.

The package is also the single published source for the Native-safe `standard`, `code`, and `minimal` system presets. An application may add a distinct system root through `additionalSystemPresetRoots`; the generic CLI uses that seam for its CLI-only `cordis` preset without copying shared assets.

## Model Experience

### Selected system preset

#### What the model sees

The runner adds no model-visible content. The application-selected `standard`, `code`, or `minimal` preset owns the session's prompt sections and tools, including any text contributed by the plugins that preset mounts.

#### Token effect

Indirect and preset-dependent: the selected preset's prompt and tool descriptions determine the request size.

#### KV Cache effect

The runner preserves the selected preset's request prefix; changing the profile, preset, or mounted plugin configuration can invalidate reuse of that prefix.

## Known Limitations and Deferred Work

- Live patch watching is process-wide and intended for generic CLI applications; managed products must opt out explicitly.
- Additional system roots must contain unique preset ids because two system owners cannot define the same shipped preset.
