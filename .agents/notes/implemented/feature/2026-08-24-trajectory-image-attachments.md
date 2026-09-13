# Agent Note: Trajectory durable image attachments

Status: implemented

English | [中文](2026-08-24-trajectory-image-attachments.zh.md)

## Problem

Trajectory did not display session images. A durable `{ type: 'image', attachment: ImageAttachmentRef }` block rendered as pretty-printed JSON in the details panel, and an image-only user message produced an empty ledger row. The only image path Trajectory knew was `imageSrc` sniffing over inline wire fields (`url`, `image_url`, base64 `data`), which no production event carries: every producer commits a durable `ImageAttachmentRef` before its event is appended. Users could not confirm from the execution ledger which image the model saw ([issue #2986](https://github.com/deepseek-harness/deepseek-harness/issues/2986)), while Chat already displayed the same attachments.

## Decision

- [`ArkMessageImageStore`](../../../../integrations/jiuzhang/native/Sources/JiuzhangShellUI/ArkMessageImageStore.swift) owns authorized historical image bytes for the selected session. `ArkAppModel.messageImages` supplies the same store to Chat and Trajectory. Concurrent requests for one attachment share one load; retained bytes are reused until eviction. Changing the selected session cancels pending loads, clears bytes, and rejects stale completions. The cache retains up to 24 images with a 64 MiB eviction threshold, while permitting one oversized image to remain readable.
- `NativeMessageImages` in [`ArkRootView.swift`](../../../../integrations/jiuzhang/native/Sources/JiuzhangShellUI/ArkRootView.swift) renders both Chat attachments and the attachments in [`NativeTrajectoryParityView.swift`](../../../../integrations/jiuzhang/native/Sources/JiuzhangShellUI/NativeTrajectoryParityView.swift). Loading, cancellation, retry, and original-image preview therefore have one presentation implementation.
- Trajectory extracts image attachment identifiers from recorded image blocks and passes them to the shared gallery. Retrieval uses the session-authorized `session/attachment` endpoint through `ArkInteractionAPI.readImage`; the gallery does not fetch arbitrary URLs from event text.
- Image-bearing records retain their attachment identifiers even when no text is present. Trajectory displays the localized attachment count and the shared gallery rather than relying on a text-only summary.
- Neither the storage nor the BFF changes: `session.attachment` already authorizes by session-log reference (missing, corrupt, and unreferenced attachments fail loud into the gallery's retry state), and sha256 content addressing already stores each image once.

## Alternatives considered

**Keep Trajectory's own `<img>` rendering and feed it resolved URLs.** This duplicates the loading placeholder, retry control, and lightbox that `ui-attachment` already owns, and contradicts [slot-based attachment ownership](../architecture/2026-08-17-dynamic-client-render-and-attachment-ownership.md), which rejected cross-plugin component imports.

**Lift the `conversation.message.images` declaration to a shared parent so both views render one key.** `renderSlot` is typed to the declaring entry's own children table, so a sibling `conversation.view` entry cannot render another entry's child key; the slot registry also rejects a second declaration of the same key. A second key sharing the owner type is the supported composition and lets a theme replace either gallery independently.

**Keep the inline `imageSrc` sniffing beside the durable path.** All producers (host prompt admission, `read_image`, MCP projection, ACP ingress) commit durable refs before their events append, so the sniffing matched nothing; keeping it would preserve a non-durable rendering path the acceptance criteria exclude.

**A Trajectory-owned image cache.** A second cache per view issues duplicate `session.attachment` RPCs and duplicate blob URLs for the same session attachment, violating the "Chat and Trajectory reference the same session attachment" requirement for no benefit.

## Consequences

- Chat and Trajectory share gallery behavior and cached bytes. Evicted images can require another authorized read; the cache does not promise one read for the entire lifetime of a long session.
- Session changes release cached bytes and cancel pending work. Attempt tokens prevent an old request from publishing into the newly selected session.
- [`ArkMessageImageStoreContractChecks.swift`](../../../../integrations/jiuzhang/native/Tests/JiuzhangShellCoreTests/ArkMessageImageStoreContractChecks.swift) exercises concurrent-load deduplication, retained bytes, retry, cancellation, and stale completion rejection. Its gallery-wiring assertions inspect source; actual Native interaction remains necessary to verify the displayed images and preview controls.
