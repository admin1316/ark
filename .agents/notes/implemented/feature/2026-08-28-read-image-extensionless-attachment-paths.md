# Agent Note: read_image accepts extension-less attachment object paths

Status: implemented

English | [中文](2026-08-28-read-image-extensionless-attachment-paths.zh.md)

## Problem

Model-visible image descriptors name the normalized attachment's local read-only path, and normalized objects are content-addressed files without an image extension. `read_image` mapped `file_path` to a media type by extension alone and refused everything else, so passing the descriptor's own path back produced `read_image only accepts PNG/JPEG/WebP/GIF paths` for an image the store had already validated and persisted. The model's only workarounds were copying the object to a renamed file or re-uploading it.

## Decision

The extension stays the declared media type when it names one of the four supported formats, and every existing gate and diagnostic on that branch is unchanged. For a path without an extension the tool reads the bytes under the existing byte cap and identifies the container with `sniffImageMediaType`, a pure file-signature helper exported by the attachment Service Definition package. The sniffed type then passes through the same deployment media-type policy and `saveImage` admission, so the store's full decode remains the authority; a path whose extension names a non-image format is refused before any I/O. This narrows the sniffing rejection in [the minimal read_image tool note](2026-08-10-minimal-read-image-tool.md) to extension-bearing paths: an extension is still a declaration that fails closed on mismatch, while a path that declares nothing is identified from its bytes.

Reading an object path re-saves its bytes rather than short-circuiting through a reverse path lookup. Normalization passes an already-normalized image through byte-identically, so the re-save deduplicates to the same content-addressed reference; a store test pins that idempotency for a re-encoded object. No reference proof is required at the tool: object paths are unguessable content digests, the published objects are already readable through the mounted filesystem (Bash included), and the session-reference gate continues to protect the remote client RPC, which is the boundary where an attachment id alone grants bytes.

Two diagnostics are sharpened alongside: `INVALID_IMAGE` admission failures now name the offending path instead of surfacing the store's bare message, and an extension-less admission mismatch blames the file signature rather than a nonexistent extension.

## Consequences

The model reads a descriptor's normalized attachment path directly, in native and PTC modes, without copying, renaming, or re-uploading; recorded scenarios `read-image-attachment-path` and `ptc-read-image-attachment-path` pin both flows end to end, including deduplication to the stored reference. Ordinary extension-less image files become readable through the same content identification, while a wrong-extension path keeps its fast pre-I/O refusal and repair message. Any future consumer accepting extension-less image paths can reuse `sniffImageMediaType` instead of a second signature table.

## Alternatives considered

**Name objects with an extension on disk.** This changes the storage layout, dedup commit path, corrupt checks, export archive, and every committed object-path expectation, only to satisfy the tool's extension heuristic, and the heuristic itself — extension as media-type authority — stays wrong. The store already treats decoded content as the authority.

**Instruct the model to copy the object before reading.** Prompt guidance does not stop direct calls, so the misleading refusal survives; the copy adds a filesystem write and a turn for a pure read; and the re-read commits the identical bytes to the same reference anyway, so the copy changes nothing but cost.
