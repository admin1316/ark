/** Content-block structure helpers. @module @deepseek-ai/dsh-llm/content */
import { assertNever } from "./never.js";
/**
 * Map a host-backed attachment path into the current filesystem execution world.
 * @param attachments - The attachments input.
 * @param mapHostPath - The map host path input.
 * @param ref - The ref input.
 * @returns The value produced by resolve image attachment access.
 */
export function resolveImageAttachmentAccess(attachments, mapHostPath, ref) {
    const hostPath = attachments.imageHostPath(ref);
    if (hostPath === undefined)
        return undefined;
    const readonlyPath = mapHostPath(hostPath);
    return readonlyPath === undefined ? undefined : { readonlyPath };
}
function imageIdentity(ref) {
    return ref.name === undefined ? String(ref.attachmentId) : `${JSON.stringify(ref.name)} (${ref.attachmentId})`;
}
function extension(mediaType) {
    switch (mediaType) {
        case 'image/png': return '.png';
        case 'image/jpeg': return '.jpg';
        case 'image/webp': return '.webp';
        case 'image/gif': return '.gif';
        default: return assertNever(mediaType, 'image extension');
    }
}
function normalizedAccessText(ref, access) {
    return ` Normalized copy (read-only; may be resized or re-encoded): ${JSON.stringify(access.readonlyPath)} (${ref.width}x${ref.height}px, ${ref.mediaType}).`
        + ' Source dimensions, format, and byte size may differ.'
        + ` Copy to a writable path ending in ${extension(ref.mediaType)} before editing.`;
}
/** Model-facing stand-in for an image removed to fit a provider request bound. */
export const OFFLOADED_IMAGE_TEXT = '[image omitted to keep the request within its image limit; older images are omitted first. If this image is still needed, read its file again when a path is available; otherwise ask the user to attach it again.]';
/**
 * Stable text shown to a model that cannot accept one durable image reference.
 * @param ref - durable master reference omitted from the request.
 * @returns deterministic text-only placeholder.
 */
export function textOnlyImageText(ref) {
    const digest = String(ref.attachmentId).slice('sha256:'.length, 'sha256:'.length + 8);
    return `[image omitted because this model accepts text only; attachment sha256:${digest}]`;
}
export function requestImageHandleText(value, dimensions, access) {
    const ref = 'attachment' in value ? value.attachment : value;
    const version = 'attachment' in value ? value : dimensions;
    if (version === undefined)
        throw new TypeError('request image dimensions are required');
    const preview = `Image ${imageIdentity(ref)}; request preview ${version.width}x${version.height}px.`;
    return access === undefined
        ? `${preview} It may be resized or re-encoded; source dimensions, format, and byte size may differ.`
        : preview + normalizedAccessText(ref, access);
}
/**
 * Stable placeholder for an image omitted by request limits.
 * @param ref - The ref input.
 * @param access - The access input.
 * @returns The value produced by offloaded image text.
 */
export function offloadedImageText(ref, access) {
    const identity = `image omitted to fit request image limits; ${imageIdentity(ref)}.`;
    if (access === undefined) {
        return `[${identity} No local normalized image path is available; ask the user to attach it again if needed.]`;
    }
    return `[${identity}${normalizedAccessText(ref, access)}]`;
}
/**
 * True when typed model content contains an image block, walking nested
 * tool-result content. This is the one recursive image walk shared by every
 * image policy (capability gating, text-only serialization, compaction
 * survey), so a consumer cannot silently diverge on nesting depth.
 * @param content - typed model content blocks.
 * @returns whether any nested block is an image.
 */
export function contentHasImage(content) {
    return content.some(block => block.type === 'image'
        || (block.type === 'tool-result' && contentHasImage(block.content)));
}
/** Base64 length of raw image bytes, including padding. */
function base64Length(bytes) {
    return Math.ceil(bytes / 3) * 4;
}
/**
 * Return the number of oldest image occurrences removed by the policy.
 * @param lengths - The lengths input.
 * @param policy - The policy input.
 * @returns The value produced by offloaded image prefix count.
 */
export function offloadedImagePrefixCount(lengths, policy) {
    const total = lengths.reduce((sum, bytes) => sum + bytes, 0);
    const excessCount = policy.maxImages === undefined ? 0 : Math.max(0, lengths.length - policy.maxImages);
    const excessBytes = policy.maxBytes === undefined ? 0 : Math.max(0, total - policy.maxBytes);
    if (excessCount === 0 && excessBytes === 0)
        return 0;
    const countQuantum = policy.countQuantum ?? 1;
    const byteQuantum = policy.byteQuantum ?? 1;
    const removeCount = excessCount === 0 ? 0 : Math.ceil(excessCount / countQuantum) * countQuantum;
    const removeBytes = excessBytes === 0 ? 0 : Math.ceil(excessBytes / byteQuantum) * byteQuantum;
    let count = 0;
    let removedBytes = 0;
    for (const imageBytes of lengths) {
        const byteTargetMet = removeBytes === 0
            || (byteQuantum === 1 ? removedBytes >= removeBytes : removedBytes > removeBytes);
        if (count >= removeCount && byteTargetMet)
            break;
        removedBytes += imageBytes;
        count += 1;
    }
    return count;
}
/** Collect represented image lengths in request and nested-block order. */
function collectImageLengths(blocks, lengths, policy) {
    for (const block of blocks) {
        if (block.type === 'image') {
            const bytes = policy.byteLength === undefined
                ? block.attachment.bytes
                : policy.byteLength(block.attachment);
            lengths.push(policy.representation === 'base64' ? base64Length(bytes) : bytes);
        }
        else if (block.type === 'tool-result') {
            collectImageLengths(block.content, lengths, policy);
        }
    }
}
/** Replace the first `remaining.count` image occurrences without mutating durable messages. */
function replaceOldestImages(blocks, remaining, placeholder) {
    let next;
    for (const [index, block] of blocks.entries()) {
        if (block.type === 'image' && remaining.count > 0) {
            remaining.count -= 1;
            next ??= blocks.slice(0, index);
            next.push({ type: 'text', text: placeholder(block.attachment) });
            continue;
        }
        if (block.type === 'tool-result') {
            const content = replaceOldestImages(block.content, remaining, placeholder);
            if (content !== block.content) {
                next ??= blocks.slice(0, index);
                next.push({ ...block, content });
                continue;
            }
        }
        next?.push(block);
    }
    return next ?? blocks;
}
/** Replace every image occurrence, including nested tool results, for a text-only model. */
function replaceImagesForTextModel(blocks) {
    let next;
    for (const [index, block] of blocks.entries()) {
        if (block.type === 'image') {
            next ??= blocks.slice(0, index);
            next.push({ type: 'text', text: textOnlyImageText(block.attachment) });
            continue;
        }
        if (block.type === 'tool-result') {
            const content = replaceImagesForTextModel(block.content);
            if (content !== block.content) {
                next ??= blocks.slice(0, index);
                next.push({ ...block, content });
                continue;
            }
        }
        next?.push(block);
    }
    return next ?? blocks;
}
/**
 * Project durable image history into deterministic text for an exact text-only model.
 * @param messages - complete request history.
 * @returns the original list without images, otherwise shallow message copies with stable placeholders.
 */
export function projectImagesForTextModel(messages) {
    if (!messages.some(message => contentHasImage(message.content)))
        return messages;
    return messages.map((message) => {
        const content = replaceImagesForTextModel(message.content);
        return content === message.content ? message : { ...message, content };
    });
}
/**
 * Return transient request messages whose oldest images are replaced until
 * their accumulated base64 payload fits the configured bound. The selection
 * is deterministic from durable message order and attachment metadata; a
 * provider can serialize the returned messages without reading omitted bytes.
 * @param messages - complete request history, oldest first.
 * @param maxRequestImageBytes - positive bound on total base64 image payload; undefined preserves every image.
 * @returns the original messages when they already fit, otherwise shallow message copies with replaced content trees.
 */
export function offloadRequestImages(messages, maxRequestImageBytes) {
    return offloadRequestImagesWithPolicy(messages, {
        representation: 'base64',
        ...maxRequestImageBytes === undefined ? {} : { maxBytes: maxRequestImageBytes },
        byteQuantum: 1,
        placeholder: () => OFFLOADED_IMAGE_TEXT,
    });
}
/**
 * Return a deterministic transient projection whose oldest images are replaced
 * in whole count and byte quanta after a route budget is exceeded. The target
 * depends only on complete durable history: at 129 one-megabyte images under
 * a 128 MiB bound with a 64 MiB quantum, the oldest 65 images are removed so
 * 64 MiB remain; that removed prefix stays fixed until total history exceeds
 * 192 MiB.
 * @param messages - complete request history, oldest first.
 * @param policy - route representation, budgets, and removal quanta.
 * @returns original messages below both bounds, otherwise shallow copies with deterministic placeholders.
 */
export function offloadRequestImagesWithPolicy(messages, policy) {
    const lengths = [];
    for (const message of messages)
        collectImageLengths(message.content, lengths, policy);
    const count = offloadedImagePrefixCount(lengths, policy);
    if (count === 0)
        return messages;
    const remaining = { count };
    const placeholder = policy.placeholder ?? (() => OFFLOADED_IMAGE_TEXT);
    return messages.map((message) => {
        const content = replaceOldestImages(message.content, remaining, placeholder);
        return content === message.content ? message : { ...message, content };
    });
}
//# sourceMappingURL=content.js.map