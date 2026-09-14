---
description: "Host desktop actions supplementing provider-owned settings and credential Remote methods."
kind: "package-reference"
---
# Settings Controller

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-api-settings-controller` supplies only Host desktop actions in the settings namespace: opening settings documents, checking Agent preset directory-opening availability, and opening those directories. The core settings and credentials providers are the sole owners of their configuration Remote methods, shared by browser and Native consumers.

## Table of Contents

- [Use this package](#use-this-package)
- [Configuration](#configuration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this package as a Loader entry where Host desktop actions are needed. It registers only `canOpenAgentPresetDirectory`, `openSettingsDocument`, and `openAgentPresetDirectory`; it neither mounts a credential controller nor declares duplicate read/write endpoints. `openSettingsDocument` delegates to the core provider's `remoteOpenDocument`, preserving absolute path ownership, cancellation, and sanitized failures.

`settings.describe/update/replace/mutate` belong to `@deepseek-ai/dsh-settings`; generic Remote writes cannot bypass namespaces reserved by domain transactions. `credentials.describe/set/unset` belong to `@deepseek-ai/dsh-credentials`. Describe returns `{ credentials: { [ref]: metadata } }` and validates the entire batch of at most 64 names before contacting the provider. Invalid names and oversized batches return `input-invalid`; empty values and provider refusals return `credential-rejected` without reflecting sensitive provider diagnostics. The Gateway diagnoses absent core Services; this package's unique actions retain actionable missing-provider errors.

`settings.openSettingsDocument()` prepares the provider-owned document and opens it with the native text-editor intent. `settings.canOpenAgentPresetDirectory()` reports native-opening availability when the preset page becomes visible. `settings.openAgentPresetDirectory(id)` resolves only a user-authored preset and either opens its directory or returns the path when native opening is unavailable; neither open method accepts a browser-supplied filesystem target.

-----

<a id="configuration"></a>
## Configuration

| Field | Default | Meaning |
|---|---|---|
| `nativeOpen` | platform-detected | Whether Agent preset directories can be handed to a native desktop opener |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-api-settings-controller) is the exhaustive source for accepted fields and their JSDoc.

-----

<a id="model-experience"></a>
## Model Experience

None, as settings and credential configuration are browser and Host state and register no prompt, tool, or session event.

#### KV Cache effect

No direct effect; reading or writing these configuration values does not alter model requests already in flight.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Credential batch policy belongs to the core credential provider, not this desktop-action package.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
