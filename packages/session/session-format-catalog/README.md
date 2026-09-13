---
description: "Static first-party Session codecs and adjacent migrations for offline conversion."
kind: "package-library"
---

# @deepseek-ai/dsh-session-format-catalog

English | [中文](README.zh.md)

## Summary

`dsh-session-format-catalog` assembles the released v0–v3 codecs and adjacent migration edges without consulting mounted plugins. Its target format is v3; Ark’s installed `dsh-session` writer and persistence readers use v0 and do not consume this catalog. A transformed v3 artifact is an offline migration result, not an installable Ark session.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### When to use it

Use this library for isolated released-format conversion and validation. Feature compositions cannot register or reorder entries. Ark’s JSONL persistence does not invoke these migrations and rejects foreign session versions. Mutable row-decoder state belongs to one caller-owned restore.

### Entry point

```text
const restore = sessionFormatCatalog.createRestore(physicalHeader, { recovery: 'recoverable', validation: 'transformed' })
for (const row of physicalRows) restore.decodeRow(row)
const current = restore.finish()
const headerRecord = sessionFormatCatalog.encodeCurrentHeader(current.header, current.inheritedEventCount)
const eventRecords = current.events.map(sessionFormatCatalog.encodeCurrentEvent)
```

Import `sessionFormatCatalog` from the package root. An offline reader creates one restore, sends parsed physical rows to `decodeRow()`, and calls `finish()` once. The encoding methods produce catalog-target v3 records; they must not write Ark’s active v0 history. `readHeader()` classifies offline readability: valid v0–v2 headers require migration, valid v3 headers are current for this catalog, future versions are unsupported, and malformed headers are rejected.

`validation: 'transformed'` applies complete released-v3 validation after migration. Already-v3 input receives codec checks only; pass the result to `restoreReleasedV3Artifact` for full offline relationship validation. `validation: 'current'` additionally requires acceptance by the installed Session package, so v3 results fail against Ark’s v0 core. Recovery mode controls incomplete-tail handling independently; it cannot authorize a foreign format.

The catalog directly owns the released readers. Its `dsh-session` peer supplies installed event names and restoration rules; historical edge validators remain frozen. Installed admission preserves the core’s three-argument restore contract and rejects catalog seeds, nonzero inherited cuts, invalid cuts, and version skew instead of discarding metadata.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[`src/catalog.ts`](src/catalog.ts) directly owns codec and edge ordering. [`src/current.ts`](src/current.ts) checks installed-version, seed, and inherited-cut admission before delegating event and request validation to the installed Session. The low-level constructor rejects duplicate codecs, duplicate edges, gaps, and entries beyond the catalog target version before a read can begin.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Migration machinery](../session-format/README.md) — catalog construction and dispatch behavior.
- [Released v0 to v1 edge](../session-format-v0-to-v1/README.md) — codec and validator ownership.
- [Released v1 to v2 edge](../session-format-v1-to-v2/README.md) — Assistant stream embedding and cardinality-changing reference remapping.
- [Released V2 to V3 specification](../session-format-v2-to-v3/README.md#v2-to-v3-specification) — transformations, preservation, and refusal.
- [JSONL persistence](../session-persistence-jsonl/README.md) — immutable generation naming and exclusive publication.

-----

<a id="model-experience"></a>
## Model Experience

### Catalog dispatch

#### What the model sees

Nothing directly. Ark request reconstruction does not consume the offline `sessionFormatCatalog`.

#### Token effect

Zero direct tokens.

#### KV Cache effect

No direct effect; restored history determines cache identity in its consumer.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Runtime admission is separate** — catalog v3 is not supported by Ark’s v0 writer. Core and persistence migration must be implemented before enabling this catalog for active history.
- **First-party build inventory only** — external migration ownership and distribution are not supported.
- **Static ordering is closed** — runtime plugin registration cannot supply a missing historical edge.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
