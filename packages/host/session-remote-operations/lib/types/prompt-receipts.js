/** Incremental ordinary-prompt receipts derived from the existing inbox log. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
const receiptSchema = z.object({
    messageId: z.string(), seq: z.number().int().nonnegative(),
    digest: z.string().nullable(), conflict: z.boolean(),
});
const stateSchema = z.object({
    seedLength: z.number().int().nonnegative(), entries: z.record(z.string(), receiptSchema),
});
/**
 * Canonical request fingerprint; hash the encoded image instead of retaining it.
 * @param request - original content and delivery mode; invocation and Session identities are not part of the digest.
 * @param clientTimeZone - already canonicalized client time zone, or undefined when absent.
 * @returns version-prefixed SHA-256 digest used to reject changed payloads under an accepted invocation identity.
 */
export function promptDigest(request, clientTimeZone) {
    const content = request.content.map(part => part.type === 'text' ? { type: part.type, text: part.text } : {
        type: part.type, mediaType: part.mediaType, data: part.data, name: part.name ?? null,
    });
    return 'v1:' + createHash('sha256').update(JSON.stringify({ mode: request.mode, clientTimeZone: clientTimeZone ?? null, content })).digest('hex');
}
/** Existing receipt entries are never rewritten by queue edits or later consumption. */
function foldReceipts(state, event) {
    if (event.seq < state.seedLength)
        return state;
    const messages = event.type === 'agent/inbox/spliced' ? event.data.inserted
        : event.type === 'user/message' ? [event.data] : [];
    let entries = state.entries;
    for (const message of messages) {
        const source = message.source;
        if (source.kind !== 'user' || !('invocationId' in source) || typeof source.invocationId !== 'string')
            continue;
        const previous = Object.hasOwn(entries, source.invocationId) ? entries[source.invocationId] : undefined;
        const digest = 'promptDigest' in source && typeof source.promptDigest === 'string' ? source.promptDigest : null;
        if (previous !== undefined) {
            // Queue edits and user/message consumption retain the original message id.
            if ((previous.messageId === message.id && previous.digest === digest) || previous.conflict)
                continue;
            if (entries === state.entries)
                entries = { ...entries };
            Object.defineProperty(entries, source.invocationId, {
                value: { ...previous, conflict: true }, enumerable: true, configurable: true, writable: true,
            });
        }
        else {
            if (entries === state.entries)
                entries = { ...entries };
            Object.defineProperty(entries, source.invocationId, {
                value: { messageId: message.id, seq: event.seq, digest, conflict: false },
                enumerable: true, configurable: true, writable: true,
            });
        }
    }
    return entries === state.entries ? state : { ...state, entries };
}
/**
 * Register with the shared projection owner; no receipt data is exposed on the wire.
 * @param ctx - Host context with an injected projection registry that owns incremental replay and disposal.
 */
export function installPromptReceipts(ctx) {
    ctx.sessionProjections.register({
        key: 'promptReceipts', stateSchema,
        init: header => ({ seedLength: header.seedLength ?? 0, entries: {} }),
        apply: foldReceipts, stateVersion: 1,
    });
}
//# sourceMappingURL=prompt-receipts.js.map