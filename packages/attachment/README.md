---
description: "The durable binary attachment seam and its local filesystem implementation."
kind: "package-group"
---

# attachment/ - durable attachment capability family

English | [中文](README.zh.md)

The durable binary attachment seam and its local filesystem implementation. Both are product packages.

| Package | Role | ctx key |
|---|---|---|
| `attachment/` | Immutable attachment references, image limits, and storage service | `ctx.attachments` |
| `attachment-local/` | Content-addressed private storage below `DSH_HOME` | (registers on `ctx.attachments`) |

Unsent UI drafts are intentionally outside this capability. Bytes enter durable storage only when a user prompt is submitted or when a provider adapter commits structured model output.

The [attachment reference](../../docs/subsystems/attachment.md) defines durable image identity, validation, and verified reads.
