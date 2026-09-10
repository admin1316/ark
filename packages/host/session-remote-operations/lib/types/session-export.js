/**
 * Host-owned Session log download.
 *
 * The download streams each persisted Session artifact verbatim, optionally
 * includes every descendant under `subagents/`, and carries each referenced
 * image once under `media/`. A live Session crosses the authoritative flush
 * barrier immediately before its raw artifact is read. Compression and the
 * response queue are bounded, and request or consumer cancellation terminates
 * the producer rather than yielding a truncated archive.
 *
 * @module @deepseek-ai/dsh-host-session-remote-operations/session-export
 */
import { Zip, ZipDeflate } from 'fflate';
import { SessionId } from '@deepseek-ai/dsh-session';
import { z } from 'zod';
/** Final Host path for the Native Session archive download. */
export const SESSION_EXPORT_PATH = '/api/session/export';
/** Balanced default for Session archive compression. */
export const DEFAULT_SESSION_LOG_COMPRESSION_LEVEL = 6;
const sessionLogQuerySchema = z.object({
    sessionId: z.string().min(1).transform(value => SessionId(value)),
    includeDescendants: z.union([z.literal('true'), z.literal('false')]).optional(),
}).transform(query => ({
    sessionId: query.sessionId,
    includeDescendants: query.includeDescendants === 'true',
}));
/**
 * Validate one deployment compression value without silently rounding.
 * @param value - configured level or undefined for the balanced default.
 * @returns the exact accepted compression level.
 */
export function sessionLogCompressionLevel(value) {
    const resolved = value ?? DEFAULT_SESSION_LOG_COMPRESSION_LEVEL;
    if (!Number.isInteger(resolved) || resolved < 0 || resolved > 9) {
        throw new Error(`sessionExportCompressionLevel must be an integer from 0 to 9; received ${String(resolved)}`);
    }
    return resolved;
}
/**
 * Resolve the persistence, lineage, attachment, and live-session owners.
 * @param ctx - composed Host context.
 * @returns mounted owners, retaining absence for fail-loud HTTP responses.
 */
export function sessionLogExportDeps(ctx) {
    return {
        sessionQuery: ctx.get('sessionQuery'),
        sessionPersistence: ctx.get('sessionPersistence'),
        attachments: ctx.get('attachments'),
        sessions: ctx.get('sessions'),
    };
}
/**
 * Flush a live Session immediately before reading its raw durable artifact.
 * @param deps - export owners including the optional live Session store.
 * @param id - Session being read.
 * @param signal - caller cancellation around the durability barrier.
 */
export async function flushLiveSessionLog(deps, id, signal) {
    signal?.throwIfAborted();
    const sessions = deps.sessions;
    if (sessions === undefined)
        return;
    const session = sessions.get(id);
    if (session === undefined)
        return;
    await sessions.flush(session);
    signal?.throwIfAborted();
}
const MEDIA_TYPE_EXTENSIONS = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
};
function mediaEntryPath(ref) {
    return `media/${String(ref.attachmentId)}.${MEDIA_TYPE_EXTENSIONS[ref.mediaType]}`;
}
function collectImageRefs(content, refs) {
    if (!Array.isArray(content))
        return;
    const pending = Array.from(content);
    while (pending.length > 0) {
        const value = pending.pop();
        if (typeof value !== 'object' || value === null || Array.isArray(value))
            continue;
        const block = value;
        if (block.type === 'image' && typeof block.attachment === 'object' && block.attachment !== null) {
            const ref = block.attachment;
            refs.set(String(ref.attachmentId), ref);
        }
        if (Array.isArray(block.content)) {
            pending.push(...Array.from(block.content));
        }
    }
}
function collectEventImageRefs(event, refs) {
    const data = event.data;
    if (typeof data !== 'object' || data === null)
        return;
    const carrier = data;
    collectImageRefs(carrier.content, refs);
    if (carrier.message !== undefined)
        collectImageRefs(carrier.message.content, refs);
    if (carrier.inserted !== undefined) {
        for (const message of carrier.inserted)
            collectImageRefs(message.content, refs);
    }
    if (carrier.chunk?.type === 'block-end')
        collectImageRefs([carrier.chunk.block], refs);
}
function imageRefsInArtifact(content) {
    const refs = new Map();
    for (const line of content.split('\n')) {
        if (line === '')
            continue;
        try {
            collectEventImageRefs(JSON.parse(line), refs);
        }
        catch {
            // An unparsable line cannot name trusted media, but is still exported verbatim.
        }
    }
    return refs;
}
function safeSessionIdSegment(id) {
    return id.replace(/[^A-Za-z0-9_-]/g, '_');
}
/**
 * Build the archive filename for one root Session.
 * @param sessionId - root Session identity.
 * @returns path-safe attachment filename.
 */
export function sessionLogZipFilename(sessionId) {
    return `dsh-session-${safeSessionIdSegment(sessionId)}.zip`;
}
/**
 * Yield root, descendants, then distinct referenced media in archive order.
 * @param deps - mounted export owners.
 * @param root - already-prepared root artifact.
 * @param sessionId - root Session identity.
 * @param includeDescendants - whether lineage descendants are included.
 * @param signal - read and lineage cancellation.
 * @returns entries in deterministic archive order.
 */
export async function* sessionLogZipEntries(deps, root, sessionId, includeDescendants, signal) {
    const media = new Map();
    const rememberMedia = (content) => {
        for (const [id, ref] of imageRefsInArtifact(content))
            media.set(id, ref);
    };
    rememberMedia(root.content);
    yield { path: root.filename, content: root.content };
    if (includeDescendants) {
        const seen = new Set([sessionId]);
        const collect = async function* (nodes) {
            for (const node of nodes) {
                signal?.throwIfAborted();
                const id = node.session.header.id;
                if (seen.has(id))
                    continue;
                seen.add(id);
                await flushLiveSessionLog(deps, id, signal);
                const raw = await deps.sessionPersistence.readRaw(id, signal);
                signal?.throwIfAborted();
                if (raw === undefined)
                    throw new Error(`subagent "${id}" has no stored log artifact`);
                rememberMedia(raw.content);
                yield {
                    path: `subagents/${safeSessionIdSegment(id)}/${raw.filename}`,
                    content: raw.content,
                };
                yield* collect(node.descendants);
            }
        };
        const lineage = await deps.sessionQuery.traceSession(sessionId, signal);
        signal?.throwIfAborted();
        yield* collect(lineage.descendants);
    }
    for (const ref of media.values()) {
        signal?.throwIfAborted();
        const stored = await deps.attachments.readImage(ref, signal);
        signal?.throwIfAborted();
        yield { path: mediaEntryPath(ref), data: stored.data };
    }
}
const PUSH_CHUNK_CODE_UNITS = 1 << 16;
const PUSH_CHUNK_BYTES = 1 << 16;
const RESPONSE_HIGH_WATER_MARK_BYTES = 1 << 16;
class ResponseCapacityGate {
    releasePending;
    async wait(controller, signal) {
        signal.throwIfAborted();
        if (controller.desiredSize === null || controller.desiredSize > 0)
            return;
        await new Promise((resolve) => {
            const release = () => {
                this.releasePending = undefined;
                signal.removeEventListener('abort', release);
                resolve();
            };
            this.releasePending = release;
            signal.addEventListener('abort', release, { once: true });
        });
        signal.throwIfAborted();
    }
    pulled() {
        this.releasePending?.();
    }
}
async function pushBinaryChunks(deflate, data, controller, capacity, signal) {
    let offset = 0;
    do {
        signal.throwIfAborted();
        const end = Math.min(offset + PUSH_CHUNK_BYTES, data.byteLength);
        const finalChunk = end >= data.byteLength;
        deflate.push(data.subarray(offset, end), finalChunk);
        offset = end;
        await capacity.wait(controller, signal);
    } while (offset < data.byteLength);
}
async function pushArtifactChunks(deflate, content, controller, capacity, signal) {
    const encoder = new TextEncoder();
    let offset = 0;
    let finalChunk;
    do {
        signal.throwIfAborted();
        let end = Math.min(offset + PUSH_CHUNK_CODE_UNITS, content.length);
        if (end < content.length && end - offset > 1) {
            const last = content.charCodeAt(end - 1);
            if (last >= 0xd800 && last <= 0xdbff)
                end -= 1;
        }
        finalChunk = end >= content.length;
        deflate.push(encoder.encode(content.slice(offset, end)), finalChunk);
        offset = end;
        await capacity.wait(controller, signal);
    } while (!finalChunk);
}
/**
 * Stream one prepared Session ZIP with byte-capacity backpressure.
 * @param deps - mounted export owners.
 * @param root - prepared root artifact.
 * @param sessionId - root Session identity.
 * @param includeDescendants - whether lineage descendants are included.
 * @param compressionLevel - validated DEFLATE level.
 * @param signal - request cancellation combined with consumer cancellation.
 * @returns pull-aware archive byte stream.
 */
export function streamSessionLogZip(deps, root, sessionId, includeDescendants, compressionLevel, signal) {
    const producerAbort = new AbortController();
    const producerSignal = AbortSignal.any([signal, producerAbort.signal]);
    let zip;
    let zipTerminated = false;
    let zipTerminationFailed = false;
    let zipTerminationFailure;
    let producer;
    const capacity = new ResponseCapacityGate();
    let settleZip;
    let terminal;
    const zipOutcome = new Promise((resolve) => { settleZip = resolve; });
    const settleZipOnce = (outcome) => {
        if (terminal !== undefined)
            return false;
        terminal = outcome;
        settleZip(outcome);
        return true;
    };
    const terminateZip = () => {
        if (zip === undefined || zipTerminated)
            return;
        zipTerminated = true;
        try {
            zip.terminate();
        }
        catch (error) {
            zipTerminationFailed = true;
            zipTerminationFailure = error;
        }
    };
    return new ReadableStream({
        start(controller) {
            const fail = (error) => {
                const normalized = sessionExportError(producerSignal.aborted ? producerSignal.reason : error);
                if (!settleZipOnce({ kind: 'failed', error: normalized }))
                    return;
                controller.error(normalized);
                producerAbort.abort(normalized);
            };
            const archive = new Zip((error, data, final) => {
                if (terminal !== undefined)
                    return;
                if (error) {
                    fail(error);
                    return;
                }
                if (producerSignal.aborted) {
                    fail(producerSignal.reason);
                    return;
                }
                try {
                    if (data.byteLength > 0)
                        controller.enqueue(data);
                    if (final) {
                        zipTerminated = true;
                        controller.close();
                        settleZipOnce({ kind: 'completed' });
                    }
                }
                catch (callbackError) {
                    fail(callbackError);
                }
            });
            zip = archive;
            producer = (async () => {
                try {
                    for await (const entry of sessionLogZipEntries(deps, root, sessionId, includeDescendants, producerSignal)) {
                        producerSignal.throwIfAborted();
                        const deflate = new ZipDeflate(entry.path, { level: compressionLevel });
                        archive.add(deflate);
                        // fflate may report failure and continue its current add() stack.
                        // Unwind here before pushing bytes; termination stays outside that callback.
                        producerSignal.throwIfAborted();
                        if ('content' in entry) {
                            await pushArtifactChunks(deflate, entry.content, controller, capacity, producerSignal);
                        }
                        else {
                            await pushBinaryChunks(deflate, entry.data, controller, capacity, producerSignal);
                        }
                    }
                    producerSignal.throwIfAborted();
                    archive.end();
                    const outcome = await zipOutcome;
                    if (outcome.kind !== 'completed')
                        throw outcome.error;
                }
                catch (error) {
                    const normalized = sessionExportError(error);
                    if (terminal?.kind !== 'cancelled')
                        fail(normalized);
                    terminateZip();
                    if (terminal?.kind === 'cancelled') {
                        const abortReason = producerSignal.reason;
                        if (error === abortReason)
                            return;
                        throw normalized;
                    }
                }
            })();
        },
        pull() {
            capacity.pulled();
        },
        async cancel(reason) {
            const cancellation = reason instanceof Error
                ? reason
                : new Error('session log export stream cancelled');
            settleZipOnce({ kind: 'cancelled', error: cancellation });
            producerAbort.abort(cancellation);
            terminateZip();
            await producer;
            if (zipTerminationFailed)
                throw zipTerminationFailure;
        },
    }, {
        highWaterMark: RESPONSE_HIGH_WATER_MARK_BYTES,
        size: chunk => chunk.byteLength,
    });
}
function sessionExportError(error) {
    return error instanceof Error ? error : new Error(String(error));
}
async function prepareSessionLogExport(ctx, sessionId, includeDescendants, signal) {
    const deps = sessionLogExportDeps(ctx);
    if (deps.sessionQuery === undefined || deps.sessionPersistence === undefined || deps.attachments === undefined) {
        return new Response('session log export is unavailable: missing session-query, session-persistence, or attachments service', { status: 500 });
    }
    if (!deps.sessionPersistence.supportsRawArtifacts) {
        return new Response('session log export is unavailable: the persistence backend does not expose per-session raw artifacts', { status: 501 });
    }
    const ready = {
        sessionQuery: deps.sessionQuery,
        sessionPersistence: deps.sessionPersistence,
        attachments: deps.attachments,
        sessions: deps.sessions,
    };
    let root;
    try {
        await flushLiveSessionLog(deps, sessionId, signal);
        root = await deps.sessionPersistence.readRaw(sessionId, signal);
        signal.throwIfAborted();
    }
    catch {
        signal.throwIfAborted();
        return new Response('session log export failed to prepare the stored artifact', { status: 500 });
    }
    if (root === undefined)
        return new Response('session not found', { status: 404 });
    return {
        ready,
        root,
        sessionId,
        includeDescendants,
        headers: new Headers({
            'content-type': 'application/zip',
            'content-disposition': `attachment; filename="${sessionLogZipFilename(sessionId)}"`,
        }),
    };
}
/**
 * Handle the final GET/HEAD Session export endpoint.
 * @param ctx - composed Host context.
 * @param request - trusted request already admitted by Host Connection.
 * @param compressionLevel - validated deployment compression level.
 * @returns bodyless HEAD preflight, streaming GET, or fail-loud status.
 */
export async function fetchSessionLogExport(ctx, request, compressionLevel) {
    const url = new URL(request.url);
    if (url.pathname !== SESSION_EXPORT_PATH || (request.method !== 'GET' && request.method !== 'HEAD')) {
        return new Response('not found', { status: 404 });
    }
    const parsed = sessionLogQuerySchema.safeParse(Object.fromEntries(url.searchParams));
    if (!parsed.success) {
        return new Response('missing or invalid sessionId query parameter', { status: 400 });
    }
    const prepared = await prepareSessionLogExport(ctx, parsed.data.sessionId, parsed.data.includeDescendants, request.signal);
    if (prepared instanceof Response) {
        return request.method === 'HEAD'
            ? new Response(null, { status: prepared.status, headers: prepared.headers })
            : prepared;
    }
    if (request.method === 'HEAD') {
        return new Response(null, { headers: prepared.headers });
    }
    return new Response(streamSessionLogZip(prepared.ready, prepared.root, prepared.sessionId, prepared.includeDescendants, compressionLevel, request.signal), { headers: prepared.headers });
}
//# sourceMappingURL=session-export.js.map