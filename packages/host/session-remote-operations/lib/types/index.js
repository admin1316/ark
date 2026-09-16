/**
 * Host ownership for generated Session Remote operations and archived
 * Workspace-session retirement.
 *
 * The package reads each domain's live owner directly. It deliberately owns
 * no durable transcript, workspace, attachment, or model-catalog copy.
 * Its bounded semantic reader retains numeric history indices and explicitly
 * released content materializations over the existing Session query owner.
 * Other maps serialize identity creation/resume, retain exact AgentHandle
 * capabilities, and hold the session-local selection consumed by prompt assembly.
 *
 * @module @deepseek-ai/dsh-host-session-remote-operations
 */
var __addDisposableResource = (this && this.__addDisposableResource) || function (env, value, async) {
    if (value !== null && value !== void 0) {
        if (typeof value !== "object" && typeof value !== "function") throw new TypeError("Object expected.");
        var dispose, inner;
        if (async) {
            if (!Symbol.asyncDispose) throw new TypeError("Symbol.asyncDispose is not defined.");
            dispose = value[Symbol.asyncDispose];
        }
        if (dispose === void 0) {
            if (!Symbol.dispose) throw new TypeError("Symbol.dispose is not defined.");
            dispose = value[Symbol.dispose];
            if (async) inner = dispose;
        }
        if (typeof dispose !== "function") throw new TypeError("Object not disposable.");
        if (inner) dispose = function() { try { inner.call(this); } catch (e) { return Promise.reject(e); } };
        env.stack.push({ value: value, dispose: dispose, async: async });
    }
    else if (async) {
        env.stack.push({ async: true });
    }
    return value;
};
var __disposeResources = (this && this.__disposeResources) || (function (SuppressedError) {
    return function (env) {
        function fail(e) {
            env.error = env.hasError ? new SuppressedError(e, env.error, "An error was suppressed during disposal.") : e;
            env.hasError = true;
        }
        var r, s = 0;
        function next() {
            while (r = env.stack.pop()) {
                try {
                    if (!r.async && s === 1) return s = 0, env.stack.push(r), Promise.resolve().then(next);
                    if (r.dispose) {
                        var result = r.dispose.call(r.value);
                        if (r.async) return s |= 2, Promise.resolve(result).then(next, function(e) { fail(e); return next(); });
                    }
                    else s |= 1;
                }
                catch (e) {
                    fail(e);
                }
            }
            if (s === 1) return env.hasError ? Promise.reject(env.error) : Promise.resolve();
            if (env.hasError) throw env.error;
        }
        return next();
    };
})(typeof SuppressedError === "function" ? SuppressedError : function (error, suppressed, message) {
    var e = new Error(message);
    return e.name = "SuppressedError", e.error = error, e.suppressed = suppressed, e;
});
import { Buffer } from 'node:buffer';
import { installPromptReceipts, promptDigest } from "./prompt-receipts.js";
import { randomUUID } from 'node:crypto';
import { mkdir, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { Service } from '@deepseek-ai/cordis';
import { canonicalClientTimeZone } from '@deepseek-ai/dsh-subagent';
import { sessionModelSelection } from '@deepseek-ai/dsh-agent-default-model/session-selection';
import { PresetMountError, UnknownPresetError, resolveSessionPreset, } from '@deepseek-ai/dsh-agent-presets';
import { ApiRemoteSessionNotFound, ApiRemoteSubagentSessionOwnership, apiRemoteSubagentOwnershipError, hasApiRemoteSubagentOwner, } from '@deepseek-ai/dsh-api-remotes/agent-lookup';
import { AttachmentError, admitEncodedImages, } from '@deepseek-ai/dsh-attachment';
import { createUserMessage, freezeMessage, } from '@deepseek-ai/dsh-llm';
import { MessageId, ReasoningEffortId } from '@deepseek-ai/dsh-llm/brand';
import { findToolCallArguments, SessionId, isAppendSurfaceEvent, snapshotJsonValue, } from '@deepseek-ai/dsh-session';
import { SessionQueryError } from '@deepseek-ai/dsh-session-query';
import { SessionTitleInvalidError } from '@deepseek-ai/dsh-session-title';
import { isSkillName, isUserInvocable } from '@deepseek-ai/dsh-skill';
import { WorkspaceId as brandWorkspaceId, WorkspaceSessionDeletionBlockedError, } from '@deepseek-ai/dsh-workspace';
import { z } from 'zod';
import { SemanticHistoryReader, SemanticHistoryError } from "./semantic-history.js";
import { fetchSessionLogExport, sessionLogCompressionLevel, SESSION_EXPORT_PATH, } from "./session-export.js";
export { DEFAULT_SESSION_LOG_COMPRESSION_LEVEL, fetchSessionLogExport, flushLiveSessionLog, SESSION_EXPORT_PATH, sessionLogCompressionLevel, sessionLogZipEntries, sessionLogZipFilename, streamSessionLogZip, } from "./session-export.js";
const DEFAULT_COLD_BLANK_PROBE_MAX_BYTES = 1024;
const COLD_SUMMARY_BATCH_SIZE = 16;
const DEFAULT_MAX_MESSAGES = 50;
const MAX_HISTORY_MESSAGES = 2_048;
const MAX_HISTORY_PAGE_EVENTS = 2_048;
const MAX_HISTORY_PAGE_ENCODED_BYTES = 1_048_576;
const SESSION_SEARCH_RESULT_LIMIT = 20;
const SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS = 240;
const SESSION_SEARCH_PROVIDER_CALL_LIMIT = 100;
const MESSAGE_TYPES = new Set(['user/message', 'assistant/message']);
const sessionListMetadataSchema = z.object({
    blank: z.boolean(),
    lastPromptAt: z.number().nullable(),
});
const imageLimitsSchema = z.object({
    maxImageBytes: z.number().int().positive(),
    maxImagesPerMessage: z.number().int().positive(),
    maxMessageImageBytes: z.number().int().positive(),
    maxImagePixels: z.number().int().positive(),
    maxImageDimension: z.number().int().positive(),
    mediaTypes: z.array(z.union([
        z.literal('image/png'),
        z.literal('image/jpeg'),
        z.literal('image/webp'),
        z.literal('image/gif'),
    ])),
});
/** Requested identity already belongs to another project directory. */
class SessionCwdConflict extends Error {
    sessionId;
    requestedCwd;
    existingCwd;
    constructor(sessionId, requestedCwd, existingCwd) {
        super(`session "${sessionId}" already exists with cwd ${JSON.stringify(existingCwd)}; `
            + `requested ${JSON.stringify(requestedCwd)}`);
        this.sessionId = sessionId;
        this.requestedCwd = requestedCwd;
        this.existingCwd = existingCwd;
    }
}
/** Requested preset differs from the composition whose tools produced the log. */
class SessionPresetConflict extends Error {
    sessionId;
    requestedPreset;
    existingPreset;
    constructor(sessionId, requestedPreset, existingPreset) {
        super(existingPreset === undefined
            ? `session "${sessionId}" records no agent preset; requested ${JSON.stringify(requestedPreset)}`
            : `session "${sessionId}" runs ${JSON.stringify(existingPreset)}; requested ${JSON.stringify(requestedPreset)}`);
        this.sessionId = sessionId;
        this.requestedPreset = requestedPreset;
        this.existingPreset = existingPreset;
    }
}
/** Build one successful generated-port result. */
function success(value) {
    return { ok: true, value };
}
/** Preserve the Promise-shaped Host port for one synchronous mutation. */
function settled(result) {
    return Promise.resolve(result);
}
/** Build one stable generated-port business failure. */
function failure(code, message, details = {}) {
    return { ok: false, error: { code, message, details } };
}
/** Generated-port cancellation spelling. */
function cancelled(message = 'session Remote invocation was cancelled') {
    return failure('cancelled', message);
}
/** Return a lossless detached projection value or omit an invalid optional view. */
function jsonValue(value) {
    return snapshotJsonValue(value);
}
/** Read live abort state across awaits. */
function aborted(signal) {
    return signal.aborted;
}
/** Code-point-safe result snippet bound. */
function truncateUnicodeCodePoints(value, maximum) {
    let count = 0;
    let end = 0;
    for (const codePoint of value) {
        if (count === maximum)
            return value.slice(0, end);
        count += 1;
        end += codePoint.length;
    }
    return value;
}
/** Session-header fields shared by attached and cold listing rows. */
function summaryFields(header, projections) {
    const preset = projections?.values.agentPreset;
    return {
        ...header.parentSession === undefined ? {} : { parentSessionId: header.parentSession },
        ...header.origin === undefined ? {} : { origin: header.origin },
        ...header.cwd === undefined ? {} : { cwd: header.cwd },
        ...typeof preset !== 'string' ? {} : { agentPreset: preset },
    };
}
/** Convert a projection snapshot without leaking mutable registry state. */
function remoteProjections(value) {
    if (value === undefined || value === null || typeof value !== 'object')
        return undefined;
    const candidate = value;
    const asOfSeq = candidate.asOfSeq;
    if (typeof asOfSeq !== 'number' || !Number.isSafeInteger(asOfSeq) || candidate.values === null
        || typeof candidate.values !== 'object' || Array.isArray(candidate.values))
        return undefined;
    const values = jsonValue(candidate.values);
    if (values === undefined || Array.isArray(values) || values === null || typeof values !== 'object')
        return undefined;
    return {
        asOfSeq,
        values,
    };
}
/** Convert one validated durable event to the generated Remote envelope. */
function remoteEvent(event) {
    const envelope = event;
    const data = jsonValue(event.data);
    if (data === undefined)
        throw new Error(`session event ${event.type} has no lossless JSON payload`);
    const surfaceOp = envelope.surfaceOp === undefined ? undefined : jsonValue(envelope.surfaceOp);
    if (envelope.surfaceOp !== undefined && surfaceOp === undefined) {
        throw new Error(`session event ${event.type} has no lossless surface operation`);
    }
    return {
        type: event.type,
        seq: event.seq,
        time: event.time,
        data,
        ...envelope.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: [...envelope.sourceEventSeqs] },
        ...surfaceOp === undefined ? {} : { surfaceOp },
        ...event.ignorable === true ? { ignorable: true } : {},
    };
}
/** Find the exclusive array end for one sequence cursor without copying the log. */
function historyEndIndex(events, beforeSeq) {
    if (beforeSeq === undefined)
        return events.length;
    let lower = 0;
    let upper = events.length;
    while (lower < upper) {
        const middle = lower + Math.floor((upper - lower) / 2);
        if (events[middle].seq < beforeSeq)
            lower = middle + 1;
        else
            upper = middle;
    }
    return lower;
}
/**
 * Select one newest-first bounded event window. Message count is a secondary
 * readability boundary; the hard event bound always wins.
 */
function historyEventWindow(events, beforeSeq, maxMessages, maxEvents) {
    const end = historyEndIndex(events, beforeSeq);
    let start = end;
    let count = 0;
    let groupStart;
    while (start > 0 && end - start < maxEvents) {
        start -= 1;
        const event = events[start];
        if (groupStart !== undefined) {
            if (event.seq <= groupStart)
                break;
            continue;
        }
        if (!MESSAGE_TYPES.has(event.type) || !isAppendSurfaceEvent(event))
            continue;
        count += 1;
        if (count < maxMessages)
            continue;
        groupStart = event.seq;
        for (const source of event.sourceEventSeqs ?? []) {
            groupStart = Math.min(groupStart, source);
        }
        if (event.seq <= groupStart)
            break;
    }
    const page = events.slice(start, end);
    return {
        events: page,
        hasMore: start > 0,
    };
}
/** UTF-8 bytes occupied by one encoded history entry in the response array. */
function historyEntryBytes(entry) {
    return Buffer.byteLength(JSON.stringify(entry), 'utf8');
}
/**
 * Apply the hard encoded-byte bound after presentation metadata is attached.
 * If the newest single entry itself exceeds the bound, return that one entry
 * so the monotonic cursor still advances instead of livelocking.
 */
function historyEntryWindow(source, project, maximumEncodedBytes) {
    if (source.events.length === 0) {
        return { events: [], entries: [], hasMore: false };
    }
    let start = source.events.length;
    let encodedBytes = 2; // JSON array brackets.
    while (start > 0) {
        const entry = project(source.events[start - 1], source.events);
        const entryBytes = historyEntryBytes(entry);
        const separatorBytes = start === source.events.length ? 0 : 1;
        if (encodedBytes + separatorBytes + entryBytes > maximumEncodedBytes) {
            if (start === source.events.length) {
                start -= 1;
                encodedBytes += entryBytes;
            }
            break;
        }
        start -= 1;
        encodedBytes += separatorBytes + entryBytes;
    }
    const events = source.events.slice(start);
    // Re-project the retained suffix so a tool result cannot retain presentation
    // metadata derived from a call that the byte boundary removed.
    const entries = events.map(event => project(event, events));
    const finalEncodedBytes = Buffer.byteLength(JSON.stringify(entries), 'utf8');
    if (entries.length > 1 && finalEncodedBytes > maximumEncodedBytes) {
        throw new Error('history presentation metadata exceeded the encoded page budget');
    }
    const hasMore = source.hasMore || start > 0;
    return {
        events,
        entries,
        hasMore,
    };
}
/** Project one tool event through the owning Tool definition, fail-soft. */
function eventView(ctx, event, page, scope) {
    const tools = ctx.get('tools');
    if (tools === undefined)
        return undefined;
    try {
        if (event.type === 'tool/call') {
            const data = event.data;
            const view = tools.get(data.name, scope)?.presentCall?.(JSON.parse(data.arguments));
            return view === undefined ? undefined : jsonValue({ for: 'call', view });
        }
        if (event.type === 'tool/result') {
            const message = event.data.message;
            const result = message.content[0];
            const call = findToolCallArguments(page, message.source.callId);
            if (call === undefined)
                return undefined;
            const view = tools.get(call.name, scope)?.presentResult?.(call.args, {
                content: result.content,
                isError: result.isError === true,
                ...event.data.meta === undefined ? {} : { meta: event.data.meta },
            });
            return view === undefined ? undefined : jsonValue({ for: 'result', view });
        }
    }
    catch (error) {
        ctx.logger.warn(`session Remote presenter failed for ${event.type}: ${String(error)}`);
    }
    return undefined;
}
/** Search durable event carriers for an authorized attachment reference. */
function imageBlockIn(content, match) {
    if (!Array.isArray(content))
        return undefined;
    for (const value of content) {
        if (value === null || typeof value !== 'object' || Array.isArray(value))
            continue;
        const block = value;
        if (block.type === 'image' && block.attachment !== null && typeof block.attachment === 'object') {
            const ref = block.attachment;
            if (match(ref))
                return ref;
        }
        if (block.type === 'tool-result') {
            const nested = imageBlockIn(block.content, match);
            if (nested !== undefined)
                return nested;
        }
    }
    return undefined;
}
/** Search every durable content carrier in one event. */
function imageInEvent(event, match) {
    const data = event.data;
    const direct = imageBlockIn(data.content, match);
    if (direct !== undefined)
        return direct;
    const wrapped = imageBlockIn(data.message?.content, match);
    if (wrapped !== undefined)
        return wrapped;
    for (const message of data.inserted ?? []) {
        const inserted = imageBlockIn(message.content, match);
        if (inserted !== undefined)
            return inserted;
    }
    return event.type === 'assistant/chunk' && data.chunk?.type === 'block-end'
        ? imageBlockIn([data.chunk.block], match)
        : undefined;
}
/** Resolve one attachment only when the addressed Session log references it. */
function referencedImage(events, attachmentId) {
    for (const event of events) {
        const found = imageInEvent(event, ref => String(ref.attachmentId) === attachmentId);
        if (found !== undefined)
            return found;
    }
    return undefined;
}
/** Whether the transcript currently ends inside an open turn. */
function hasOpenTurn(session) {
    return session.events.findLast(event => event.type === 'turn/start' || event.type === 'turn/end')
        ?.type === 'turn/start';
}
/** Host implementation of G2's generated Session port and Workspace retirer. */
export class SessionRemoteOperationsService extends Service {
    static inject = [
        'agentDefaultModel',
        'agents',
        'attachments',
        'llm',
        'sessions',
        'workspaceRegistry',
    ];
    coldBlankProbeMaxBytes;
    defaultCwd;
    /** Exact loopback-only path for streaming Session archives. */
    path = SESSION_EXPORT_PATH;
    sessionExportCompressionLevel;
    handles = new Map();
    creations = new Map();
    resumes = new Map();
    admissionChains = new WeakMap();
    lifetime = new AbortController();
    semanticHistory;
    constructor(ctx, config = {}) {
        super(ctx, 'sessionRemoteOperations');
        this.semanticHistory = new SemanticHistoryReader(ctx, (source) => {
            let scope;
            return async (event, dependencies) => {
                // Non-tool domain records need only the lossless wire envelope. Resolve
                // one historical preset scope lazily for all tool entries in this body.
                const view = event.type === 'tool/call' || event.type === 'tool/result'
                    ? eventView(ctx, event, dependencies, await (scope ??= this.standingPresenterScope(source)))
                    : undefined;
                return { event: remoteEvent(event), ...view === undefined ? {} : { view } };
            };
        }, config.semanticHistory);
        this.coldBlankProbeMaxBytes = config.coldBlankProbeMaxBytes ?? DEFAULT_COLD_BLANK_PROBE_MAX_BYTES;
        if (!Number.isSafeInteger(this.coldBlankProbeMaxBytes) || this.coldBlankProbeMaxBytes < 0) {
            throw new RangeError('coldBlankProbeMaxBytes must be a non-negative safe integer');
        }
        this.defaultCwd = config.cwd ?? process.cwd();
        this.sessionExportCompressionLevel = sessionLogCompressionLevel(config.sessionExportCompressionLevel);
        if (!isAbsolute(this.defaultCwd)) {
            throw new Error(`host-session-remote-operations cwd must be absolute: ${JSON.stringify(this.defaultCwd)}`);
        }
        ctx.provide('workspaceSessionRetirer', this);
        ctx.inject(['connection'], connectionCtx => connectionCtx.connection.downloads.handle(this.path, (request, signal) => this.fetch(request, signal), { authority: 'loopback' }));
        ctx.on('agent/disposed', ({ agent }) => {
            if (this.handles.get(agent.id)?.agent === agent)
                this.handles.delete(agent.id);
        });
        ctx.effect(() => async () => {
            this.lifetime.abort(new Error('session Remote operations disposed'));
            this.semanticHistory.clear();
            const handles = [...this.handles.values()];
            this.handles.clear();
            await Promise.allSettled(handles.map(handle => handle.dispose({ keepInbox: true })));
        }, 'host-session-remote-operations: owned Agent handles');
        ctx.inject(['sessionProjections'], (projectionCtx) => {
            installPromptReceipts(projectionCtx);
            projectionCtx.sessionProjections.register({
                key: 'sessionListMetadata',
                stateSchema: sessionListMetadataSchema,
                init: () => ({ blank: true, lastPromptAt: null }),
                apply: (state, event) => {
                    const blank = state.blank && event.type !== 'turn/start';
                    const latest = event.type === 'user/message' && event.data.source.kind === 'user'
                        ? event.time
                        : state.lastPromptAt;
                    return blank === state.blank && latest === state.lastPromptAt
                        ? state
                        : { blank, lastPromptAt: latest };
                },
                wire: { viewSchema: sessionListMetadataSchema, view: state => state },
                stateVersion: 1,
            });
        });
        ctx.inject(['sessionProjections', 'attachments'], (projectionCtx) => {
            projectionCtx.sessionProjections.register({
                key: 'imageLimits',
                stateSchema: z.null(),
                init: () => null,
                apply: state => state,
                wire: { viewSchema: imageLimitsSchema, view: () => projectionCtx.attachments.imageLimits },
                stateVersion: 1,
            });
        });
    }
    /**
     * Handle the Host-owned Native Session archive endpoint.
     * @param request - authenticated download request carrying Session export query fields.
     * @param signal - optional Connection-owned cancellation signal.
     * @returns the streamed archive response or a closed HTTP error response.
     */
    fetch(request, signal) {
        return fetchSessionLogExport(this.ctx, signal === undefined ? request : new Request(request, { signal }), this.sessionExportCompressionLevel);
    }
    /** Return the current default for a fresh or resumed Agent. */
    agentOptions() {
        return { ...this.ctx.agentDefaultModel.currentSelection() };
    }
    /** Install or retrieve the session-local request selection. */
    selectionFor(agent) {
        return sessionModelSelection(this.ctx, agent);
    }
    /** Resolve and mount the preset that owns one Agent's tool composition. */
    async composeAgent(presetId) {
        const presets = this.ctx.get('agentPresets');
        if (presets === undefined) {
            return {
                setup: (agentCtx) => {
                    const agent = agentCtx.agent;
                    if (agent === undefined)
                        throw new Error('session Remote setup has no scoped agent');
                    this.selectionFor(agent);
                },
            };
        }
        const resolved = await presets.resolve(presetId);
        return {
            agentPreset: resolved.id,
            setup: async (agentCtx) => {
                const agent = agentCtx.agent;
                if (agent === undefined)
                    throw new Error('session Remote setup has no scoped agent');
                this.selectionFor(agent);
                await presets.mount(agentCtx, resolved.id);
            },
        };
    }
    /** Revalidate Workspace archive/deletion admission around publication. */
    withSessionAdmission(setup, checks) {
        return async (agentCtx) => {
            const prepared = await setup?.(agentCtx);
            return {
                commit: () => {
                    for (const check of checks) {
                        this.ctx.workspaceRegistry.assertSessionAdmission(check.sessionId, check.revision);
                    }
                    prepared?.commit();
                    for (const check of checks) {
                        this.ctx.workspaceRegistry.assertSessionAdmission(check.sessionId, check.revision);
                    }
                },
            };
        };
    }
    /** Retain the exact lifecycle capability returned by AgentRegistry. */
    ownHandle(handle) {
        this.handles.set(handle.agent.id, handle);
        return handle.agent;
    }
    /** Stable subagent ownership fence shared by all generic Session methods. */
    subagentFailure(sessionId) {
        const error = apiRemoteSubagentOwnershipError(sessionId);
        return failure(error.code, error.message, error.details);
    }
    /** Assert a caller cannot adopt a Session under another preset. */
    assertPresetUnchanged(sessionId, requested, existing) {
        if (requested === undefined || requested === existing)
            return;
        throw new SessionPresetConflict(sessionId, requested, existing);
    }
    /** Read one attached or persisted Session without acquiring a live Agent. */
    async readSessionState(sessionId, signal) {
        signal.throwIfAborted();
        const attached = this.ctx.sessions.get(sessionId);
        if (attached !== undefined) {
            return { id: attached.id, header: attached.header, events: [...attached.events] };
        }
        const persistence = this.ctx.get('sessionPersistence');
        if (persistence === undefined) {
            throw new Error('session persistence is not configured');
        }
        const header = (await persistence.list(signal)).find(candidate => candidate.id === sessionId);
        if (header === undefined || header.cwd === undefined) {
            throw new ApiRemoteSessionNotFound(`session "${sessionId}" not found`);
        }
        const inspected = await persistence.inspect(sessionId, signal);
        signal.throwIfAborted();
        if (inspected.meta.cwd === undefined) {
            throw new ApiRemoteSessionNotFound(`session "${sessionId}" not found`);
        }
        return { id: inspected.meta.id, header: inspected.meta, events: [...inspected.events] };
    }
    /** Resolve one ordinary Session to a live Agent, resuming once per id. */
    async agentFor(sessionId) {
        const revision = this.ctx.workspaceRegistry.sessionAdmissionRevision(sessionId);
        try {
            this.ctx.workspaceRegistry.assertSessionAdmission(sessionId, revision);
        }
        catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            return failure('agent-busy', reason, { reason });
        }
        const live = this.ctx.agents.get(sessionId);
        if (live !== undefined) {
            if (hasApiRemoteSubagentOwner(this.ctx, live.session, live))
                return this.subagentFailure(sessionId);
            return success(live);
        }
        const attached = this.ctx.sessions.get(sessionId);
        if (attached !== undefined && hasApiRemoteSubagentOwner(this.ctx, attached, undefined)) {
            return this.subagentFailure(sessionId);
        }
        let resume = this.resumes.get(sessionId);
        if (resume === undefined) {
            resume = (async () => {
                const inspected = await this.readSessionState(sessionId, this.lifetime.signal);
                if (hasApiRemoteSubagentOwner(this.ctx, { header: inspected.header }, undefined)) {
                    throw new ApiRemoteSubagentSessionOwnership(sessionId);
                }
                const preset = resolveSessionPreset({ header: inspected.header, events: inspected.events });
                const composition = await this.composeAgent(preset);
                const handle = await this.ctx.agents.resume({
                    resumeSessionId: sessionId,
                    agentOptions: this.agentOptions(),
                    signal: this.lifetime.signal,
                    setup: this.withSessionAdmission(composition.setup, [{ sessionId, revision }]),
                });
                return this.ownHandle(handle);
            })().finally(() => {
                this.resumes.delete(sessionId);
            });
            this.resumes.set(sessionId, resume);
        }
        try {
            const agent = await resume;
            this.ctx.workspaceRegistry.assertSessionAdmission(sessionId, revision);
            if (hasApiRemoteSubagentOwner(this.ctx, agent.session, agent))
                return this.subagentFailure(sessionId);
            return success(agent);
        }
        catch (error) {
            if (error instanceof ApiRemoteSessionNotFound) {
                return failure('session-not-found', error.message, { sessionId });
            }
            if (error instanceof ApiRemoteSubagentSessionOwnership)
                return this.subagentFailure(error.sessionId);
            const raced = this.ctx.agents.get(sessionId);
            if (raced !== undefined) {
                if (hasApiRemoteSubagentOwner(this.ctx, raced.session, raced))
                    return this.subagentFailure(sessionId);
                return success(raced);
            }
            return failure('internal', `resume failed for session "${sessionId}": ${String(error)}`);
        }
    }
    /** Serialize model switching and prompt admission for one exact Agent. */
    serializeAdmission(agent, operation) {
        const result = (this.admissionChains.get(agent) ?? Promise.resolve()).then(operation);
        this.admissionChains.set(agent, result.then(() => undefined, () => undefined));
        return result;
    }
    /** One exact projection cut for an attached or detached transcript. */
    projectionsFor(source) {
        const projections = this.ctx.get('sessionProjections');
        if (projections === undefined)
            return undefined;
        try {
            const snapshot = source.kind === 'attached'
                ? projections.snapshot(source.session)
                : projections.restore({}, source.events, 0, source.header).snapshot;
            return remoteProjections(snapshot);
        }
        catch (error) {
            this.ctx.logger.warn(`session Remote projections unavailable: ${String(error)}`);
            return undefined;
        }
    }
    /** Resolve the presentation scope without resuming a cold Session. */
    async presenterScope(sessionId, source) {
        const live = this.ctx.agents.get(sessionId);
        if (live !== undefined)
            return live;
        return this.standingPresenterScope(source);
    }
    /** Historical scope is resolved from the caller's fixed cut, never today's live preset. */
    async standingPresenterScope(source) {
        const presets = this.ctx.get('agentPresets');
        if (presets === undefined)
            return undefined;
        try {
            return await presets.standingKeyFor(resolveSessionPreset(source));
        }
        catch {
            return undefined;
        }
    }
    /** Cached listing hints never materialize a missing projection or replay a log. */
    listProjections(header, session) {
        try {
            return remoteProjections(session === undefined
                ? this.ctx.get('sessionProjectionCache')?.cachedSnapshot(header)
                : this.ctx.get('sessionProjections')?.cachedSnapshot(session));
        }
        catch (error) {
            this.ctx.logger.warn(`session.list: cached projections unavailable for "${header.id}": ${String(error)}`);
            return undefined;
        }
    }
    attachedSummary(session) {
        const projections = this.listProjections(session.header, session);
        const metadata = sessionListMetadataSchema.safeParse(projections?.values.sessionListMetadata);
        return {
            sessionId: session.id,
            updatedAt: Math.max(session.header.createdAt, metadata.success ? metadata.data.lastPromptAt ?? 0 : 0),
            running: this.ctx.agents.get(session.id)?.status === 'running',
            blank: metadata.success ? metadata.data.blank : session.seq === 0,
            ...summaryFields(session.header, projections),
            ...projections === undefined ? {} : { projections },
        };
    }
    /** Only small physical artifacts may be observed for an unknown cold blank hint. */
    async smallColdProjections(query, header, signal) {
        if (this.coldBlankProbeMaxBytes === 0)
            return undefined;
        const location = this.ctx.get('sessionPersistence')?.locate(header);
        if (location === undefined)
            return undefined;
        signal.throwIfAborted();
        try {
            if ((await stat(location.path)).size > this.coldBlankProbeMaxBytes)
                return undefined;
        }
        catch {
            signal.throwIfAborted();
            return undefined;
        }
        try {
            const env_1 = { stack: [], error: void 0, hasError: false };
            try {
                const observation = __addDisposableResource(env_1, await query.observeSession(header.id, { signal, projectionMode: 'all' }), false);
                signal.throwIfAborted();
                return remoteProjections(observation.projections);
            }
            catch (e_1) {
                env_1.error = e_1;
                env_1.hasError = true;
            }
            finally {
                __disposeResources(env_1);
            }
        }
        catch (error) {
            signal.throwIfAborted();
            this.ctx.logger.warn(`session.list: small cold observation for "${header.id}" failed; serving it visible: ${String(error)}`);
            return undefined;
        }
    }
    async coldSummary(query, header, signal) {
        const cached = this.listProjections(header);
        const metadata = sessionListMetadataSchema.safeParse(cached?.values.sessionListMetadata);
        const projections = metadata.success && !metadata.data.blank
            ? cached
            : await this.smallColdProjections(query, header, signal) ?? cached;
        const raced = this.ctx.sessions.get(header.id);
        if (raced !== undefined)
            return this.attachedSummary(raced);
        const current = sessionListMetadataSchema.safeParse(projections?.values.sessionListMetadata);
        return {
            sessionId: header.id,
            updatedAt: Math.max(header.createdAt, current.success ? current.data.lastPromptAt ?? 0 : 0),
            running: false,
            // Large, inaccessible, or failed observations remain unknown and visible.
            blank: current.success ? current.data.blank : false,
            ...summaryFields(header, projections),
            ...projections === undefined ? {} : { projections },
        };
    }
    /** Reuse query corpus visibility and cached hints; bound concurrent physical probes. */
    async visibleSummaries(query, signal) {
        signal.throwIfAborted();
        const records = await query.listSessions(signal);
        signal.throwIfAborted();
        const rows = [];
        const cold = [];
        for (const record of records) {
            const live = this.ctx.sessions.get(record.header.id);
            if (live !== undefined)
                rows.push(this.attachedSummary(live));
            else if (record.header.cwd !== undefined)
                cold.push(record.header);
        }
        for (let offset = 0; offset < cold.length; offset += COLD_SUMMARY_BATCH_SIZE) {
            signal.throwIfAborted();
            const settled = await Promise.allSettled(cold.slice(offset, offset + COLD_SUMMARY_BATCH_SIZE)
                .map(header => this.coldSummary(query, header, signal)));
            for (const result of settled) {
                if (result.status === 'rejected')
                    throw result.reason;
                rows.push(result.value);
            }
        }
        rows.sort((left, right) => right.updatedAt - left.updatedAt);
        return rows;
    }
    /** List every attached or persisted Session visible to ordinary routing. */
    async list(_request, signal) {
        if (aborted(signal))
            return cancelled();
        const query = this.ctx.get('sessionQuery');
        if (query === undefined) {
            return failure('internal', 'session listing is unavailable: this deployment does not mount @deepseek-ai/dsh-session-query');
        }
        try {
            return success({ items: await this.visibleSummaries(query, signal) });
        }
        catch (error) {
            if (aborted(signal))
                return cancelled();
            return failure('internal', `session listing failed: ${String(error)}`);
        }
    }
    /** Search current message surfaces, then enforce ordinary Session visibility. */
    async search(request, signal) {
        if (aborted(signal))
            return cancelled('session search was aborted');
        const query = request.query.trim();
        if (query.length === 0 || query.length > 500 || query.includes('\0')) {
            return failure('invalid-argument', 'session search query must be 1-500 non-NUL characters');
        }
        const sessionQuery = this.ctx.get('sessionQuery');
        if (sessionQuery === undefined) {
            return failure('internal', 'session search is unavailable: this deployment does not mount @deepseek-ai/dsh-session-query');
        }
        try {
            const visible = await sessionQuery.listSessions(signal);
            signal.throwIfAborted();
            const visibleIds = new Set(visible
                .filter(record => record.header.cwd !== undefined)
                .map(record => record.header.id));
            if (visibleIds.size === 0)
                return success({ items: [], hasMore: false });
            const accepted = [];
            const acceptedIds = new Set();
            const seenCursors = new Set();
            let cursor;
            let calls = 0;
            let pageLimit = SESSION_SEARCH_RESULT_LIMIT;
            while (accepted.length <= SESSION_SEARCH_RESULT_LIMIT) {
                signal.throwIfAborted();
                if (calls >= SESSION_SEARCH_PROVIDER_CALL_LIMIT) {
                    throw new Error(`session search provider exceeded ${SESSION_SEARCH_PROVIDER_CALL_LIMIT} calls`);
                }
                calls += 1;
                const requestedCursor = cursor;
                const requestedLimit = pageLimit;
                let page;
                try {
                    page = await sessionQuery.searchSessions({
                        query,
                        eventFilters: [
                            { kind: 'type', values: ['user/message', 'assistant/message'] },
                            { kind: 'surface', values: ['current'] },
                        ],
                        limit: requestedLimit,
                        ...requestedCursor === undefined ? {} : { cursor: requestedCursor },
                    }, { signal });
                }
                catch (error) {
                    if (requestedCursor === undefined && error instanceof SessionQueryError
                        && error.code === 'SESSION_QUERY_INVALID_LIMIT' && requestedLimit > 1) {
                        pageLimit = Math.max(1, Math.floor(requestedLimit / 2));
                        continue;
                    }
                    if (requestedCursor !== undefined && error instanceof SessionQueryError
                        && error.code === 'SESSION_QUERY_STALE_CURSOR') {
                        accepted.length = 0;
                        acceptedIds.clear();
                        seenCursors.clear();
                        cursor = undefined;
                        continue;
                    }
                    throw error;
                }
                signal.throwIfAborted();
                if (page.items.length > requestedLimit) {
                    throw new Error(`session search provider returned ${page.items.length} items; maximum is ${requestedLimit}`);
                }
                for (const hit of page.items) {
                    if (accepted.length > SESSION_SEARCH_RESULT_LIMIT)
                        continue;
                    if (!visibleIds.has(hit.header.id)
                        || hit.bestMatch.sessionId !== hit.header.id
                        || hit.bestMatch.surface !== 'current'
                        || !MESSAGE_TYPES.has(hit.bestMatch.type)
                        || acceptedIds.has(hit.header.id))
                        continue;
                    acceptedIds.add(hit.header.id);
                    accepted.push({
                        sessionId: hit.header.id,
                        snippet: truncateUnicodeCodePoints(hit.bestMatch.snippet, SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS),
                    });
                }
                if (page.nextCursor !== undefined) {
                    if (seenCursors.has(page.nextCursor))
                        throw new Error('session search provider repeated a cursor');
                    seenCursors.add(page.nextCursor);
                }
                if (accepted.length > SESSION_SEARCH_RESULT_LIMIT || page.nextCursor === undefined)
                    break;
                cursor = page.nextCursor;
            }
            return success({
                items: accepted.slice(0, SESSION_SEARCH_RESULT_LIMIT),
                hasMore: accepted.length > SESSION_SEARCH_RESULT_LIMIT,
            });
        }
        catch (error) {
            if (aborted(signal)
                || (error instanceof SessionQueryError && error.code === 'SESSION_QUERY_ABORTED')) {
                return cancelled('session search was aborted');
            }
            return failure('internal', `session search failed: ${String(error)}`);
        }
    }
    /** Resolve or create one explicit identity once, preserving cwd and preset ownership. */
    async ensureSession(sessionId, cwd, checkPersistedIdentity, requestedPreset, signal) {
        let creation = this.creations.get(sessionId);
        if (creation === undefined) {
            creation = (async () => {
                signal.throwIfAborted();
                const revision = this.ctx.workspaceRegistry.sessionAdmissionRevision(sessionId);
                this.ctx.workspaceRegistry.assertSessionAdmission(sessionId, revision);
                const live = this.ctx.agents.get(sessionId);
                const attached = this.ctx.sessions.get(sessionId);
                if (attached !== undefined && hasApiRemoteSubagentOwner(this.ctx, attached, live)) {
                    throw new ApiRemoteSubagentSessionOwnership(sessionId);
                }
                if (live !== undefined)
                    return live;
                const persistence = checkPersistedIdentity ? this.ctx.get('sessionPersistence') : undefined;
                const stored = persistence === undefined
                    ? undefined
                    : (await persistence.list(signal)).find(header => header.id === sessionId);
                signal.throwIfAborted();
                if (persistence !== undefined && stored !== undefined) {
                    const inspected = await persistence.inspect(sessionId, signal);
                    if (hasApiRemoteSubagentOwner(this.ctx, { header: inspected.meta }, undefined)) {
                        throw new ApiRemoteSubagentSessionOwnership(sessionId);
                    }
                    if (inspected.meta.cwd !== cwd) {
                        throw new SessionCwdConflict(sessionId, cwd, inspected.meta.cwd);
                    }
                    const storedPreset = resolveSessionPreset({ header: inspected.meta, events: inspected.events });
                    this.assertPresetUnchanged(sessionId, requestedPreset, storedPreset);
                    const composition = await this.composeAgent(storedPreset);
                    const handle = await this.ctx.agents.resume({
                        resumeSessionId: sessionId,
                        agentOptions: this.agentOptions(),
                        signal,
                        setup: this.withSessionAdmission(composition.setup, [{ sessionId, revision }]),
                    });
                    return this.ownHandle(handle);
                }
                await mkdir(cwd, { recursive: true });
                signal.throwIfAborted();
                const composition = await this.composeAgent(requestedPreset);
                const handle = await this.ctx.agents.create({
                    sessionId,
                    agentOptions: this.agentOptions(),
                    signal,
                    meta: {
                        cwd,
                        ...composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset },
                    },
                    setup: this.withSessionAdmission(composition.setup, [{ sessionId, revision }]),
                });
                return this.ownHandle(handle);
            })().catch((error) => {
                const raced = this.ctx.agents.get(sessionId);
                if (raced !== undefined) {
                    if (hasApiRemoteSubagentOwner(this.ctx, raced.session, raced)) {
                        throw new ApiRemoteSubagentSessionOwnership(sessionId);
                    }
                    return raced;
                }
                const attached = this.ctx.sessions.get(sessionId);
                if (attached !== undefined && hasApiRemoteSubagentOwner(this.ctx, attached, undefined)) {
                    throw new ApiRemoteSubagentSessionOwnership(sessionId);
                }
                throw error;
            }).finally(() => {
                this.creations.delete(sessionId);
            });
            this.creations.set(sessionId, creation);
        }
        const agent = await creation;
        if (hasApiRemoteSubagentOwner(this.ctx, agent.session, agent)) {
            throw new ApiRemoteSubagentSessionOwnership(sessionId);
        }
        this.assertPresetUnchanged(sessionId, requestedPreset, resolveSessionPreset(agent.session));
        if (agent.session.header.cwd !== cwd) {
            throw new SessionCwdConflict(sessionId, cwd, agent.session.header.cwd);
        }
        return agent;
    }
    /** Create or adopt one ordinary Agent-backed Session. */
    async create(request, signal) {
        if (aborted(signal))
            return cancelled();
        if (request.workspaceId !== undefined && request.cwd !== undefined) {
            return failure('invalid-argument', 'session.create accepts workspaceId or cwd, not both');
        }
        const sessionId = request.sessionId ?? SessionId(`session-${randomUUID()}`);
        let workspace;
        if (request.workspaceId !== undefined) {
            workspace = this.ctx.workspaceRegistry.get(brandWorkspaceId(request.workspaceId));
            if (workspace === undefined) {
                return failure('workspace-not-found', `workspace "${request.workspaceId}" not found`, { workspaceId: request.workspaceId });
            }
        }
        const cwd = workspace?.path ?? request.cwd ?? this.defaultCwd;
        if (!isAbsolute(cwd))
            return failure('invalid-argument', 'session cwd must be absolute', { cwd });
        try {
            const agent = await this.ensureSession(sessionId, cwd, request.sessionId !== undefined, request.agentPreset, signal);
            if (aborted(signal))
                return cancelled();
            if (workspace !== undefined && !workspace.sessionIds.includes(sessionId)) {
                try {
                    await workspace.attachSession(sessionId);
                }
                catch (error) {
                    return failure('workspace-attach-failed', `session "${sessionId}" was created but could not attach to workspace "${workspace.id}": ${String(error)}`, { sessionId, workspaceId: workspace.id });
                }
            }
            const agentPreset = resolveSessionPreset(agent.session);
            return success({
                sessionId,
                ...agentPreset === undefined ? {} : { agentPreset },
            });
        }
        catch (error) {
            if (aborted(signal))
                return cancelled();
            if (error instanceof SessionPresetConflict) {
                return failure('agent-preset-conflict', error.message, {
                    sessionId: error.sessionId,
                    requestedPreset: error.requestedPreset,
                    ...error.existingPreset === undefined ? {} : { existingPreset: error.existingPreset },
                });
            }
            if (error instanceof UnknownPresetError) {
                return failure('agent-preset-not-found', error.message, {
                    agentPreset: error.presetId,
                    available: [...error.available],
                });
            }
            if (error instanceof PresetMountError) {
                return failure('agent-preset-invalid', error.message, {
                    agentPreset: error.presetId,
                    reason: error.reason,
                });
            }
            if (error instanceof SessionCwdConflict) {
                return failure('session-conflict', error.message, {
                    sessionId: error.sessionId,
                    requestedCwd: error.requestedCwd,
                    ...error.existingCwd === undefined ? {} : { existingCwd: error.existingCwd },
                });
            }
            if (error instanceof ApiRemoteSubagentSessionOwnership)
                return this.subagentFailure(error.sessionId);
            return failure('internal', `failed to create session "${sessionId}": ${String(error)}`);
        }
    }
    /** Resolve one history source without acquiring an Agent owner. */
    async historySource(sessionId, signal) {
        const attached = this.ctx.sessions.get(sessionId);
        if (attached !== undefined)
            return { kind: 'attached', session: attached };
        const state = await this.readSessionState(sessionId, signal);
        return { kind: 'detached', header: state.header, events: state.events };
    }
    async history(request, signal) {
        const readSignal = AbortSignal.any([signal, this.lifetime.signal]);
        if (aborted(readSignal))
            return cancelled();
        if (request.view === 'semantic' || request.view === 'content') {
            try {
                return success(await this.semanticHistory.read(request, readSignal));
            }
            catch (error) {
                if (aborted(readSignal) || this.lifetime.signal.aborted)
                    return cancelled();
                if (error instanceof SemanticHistoryError)
                    return failure(error.code, error.message);
                return failure('internal', `semantic history unavailable: ${String(error)}`);
            }
        }
        if (request.beforeSeq !== undefined
            && (!Number.isSafeInteger(request.beforeSeq) || request.beforeSeq < 0)) {
            return failure('invalid-argument', 'beforeSeq must be a non-negative safe integer');
        }
        if (request.maxEvents !== undefined
            && (!Number.isSafeInteger(request.maxEvents)
                || request.maxEvents < 1
                || request.maxEvents > MAX_HISTORY_PAGE_EVENTS)) {
            return failure('invalid-argument', `maxEvents must be an integer from 1 through ${String(MAX_HISTORY_PAGE_EVENTS)}`);
        }
        if (request.maxMessages !== undefined
            && (!Number.isSafeInteger(request.maxMessages)
                || request.maxMessages < 1
                || request.maxMessages > MAX_HISTORY_MESSAGES)) {
            return failure('invalid-argument', `maxMessages must be an integer from 1 through ${String(MAX_HISTORY_MESSAGES)}`);
        }
        try {
            const env_2 = { stack: [], error: void 0, hasError: false };
            try {
                const fixed = __addDisposableResource(env_2, request.view === 'raw' || request.sourceRevision !== undefined || request.expectedSubagentMode !== undefined
                    ? await this.semanticHistory.observe(request, readSignal) : undefined, false);
                const source = fixed === undefined ? await this.historySource(request.sessionId, readSignal)
                    : { kind: 'detached', header: fixed.observed.header, events: fixed.observed.events };
                const bearing = source.kind === 'attached'
                    ? { header: source.session.header, events: source.session.events }
                    : { header: source.header, events: source.events };
                if (request.expectedParentSessionId !== undefined && bearing.header.parentSession !== request.expectedParentSessionId) {
                    return failure('subagent-unauthorized', 'subagent parent changed during history read', { sessionId: request.sessionId });
                }
                if (bearing.header.origin === 'subagent' && fixed === undefined) {
                    return failure('subagent-unauthorized', 'child history requires its direct parent and mode');
                }
                let scope = fixed === undefined ? await this.presenterScope(request.sessionId, bearing) : undefined;
                readSignal.throwIfAborted();
                fixed?.assertCurrent();
                // A bound read retains the actual immutable observation/lease. Later
                // appends cannot enter its page or change the authorized descriptor cut.
                const events = fixed?.observed.events ?? (source.kind === 'attached' ? source.session.events : source.events);
                const projections = fixed === undefined && request.beforeSeq === undefined
                    ? this.projectionsFor(source) : undefined;
                const binding = fixed === undefined ? {} : {
                    view: 'raw', sourceRevision: fixed.revision, asOfThroughSeq: fixed.through,
                };
                const sourcePage = historyEventWindow(events, fixed === undefined ? request.beforeSeq : Math.min(request.beforeSeq ?? fixed.through + 1, fixed.through + 1), request.maxMessages ?? DEFAULT_MAX_MESSAGES, request.maxEvents ?? MAX_HISTORY_PAGE_EVENTS);
                if (fixed !== undefined && sourcePage.events.some(event => event.type === 'tool/call' || event.type === 'tool/result')) {
                    scope = await this.standingPresenterScope(this.semanticHistory.presentationSource(fixed.observed, fixed.identity, fixed.through, readSignal));
                    readSignal.throwIfAborted();
                    this.lifetime.signal.throwIfAborted();
                    fixed.assertCurrent();
                }
                const fixedValue = {
                    ...binding,
                    events: [],
                    hasMore: true,
                    ...projections === undefined ? {} : { projections },
                };
                const fixedEncodedBytes = Buffer.byteLength(JSON.stringify(fixedValue), 'utf8');
                if (fixedEncodedBytes > MAX_HISTORY_PAGE_ENCODED_BYTES) {
                    throw new Error('history projection baseline exceeded the encoded page budget');
                }
                const eventArrayBudget = MAX_HISTORY_PAGE_ENCODED_BYTES - fixedEncodedBytes + 2;
                const page = historyEntryWindow(sourcePage, (event, pageEvents) => {
                    const view = eventView(this.ctx, event, pageEvents, scope);
                    return {
                        event: remoteEvent(event),
                        ...view === undefined ? {} : { view },
                    };
                }, eventArrayBudget);
                const value = {
                    ...binding,
                    events: page.entries,
                    hasMore: page.hasMore,
                    ...projections === undefined ? {} : { projections },
                };
                const valueEncodedBytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
                if (valueEncodedBytes > MAX_HISTORY_PAGE_ENCODED_BYTES && page.entries.length !== 1) {
                    throw new Error('history page exceeded the encoded byte budget');
                }
                fixed?.assertCurrent();
                return success(value);
            }
            catch (e_2) {
                env_2.error = e_2;
                env_2.hasError = true;
            }
            finally {
                __disposeResources(env_2);
            }
        }
        catch (error) {
            if (aborted(readSignal))
                return cancelled();
            if (error instanceof SemanticHistoryError)
                return failure(error.code, error.message);
            if (error instanceof ApiRemoteSessionNotFound) {
                return failure('session-not-found', error.message, { sessionId: request.sessionId });
            }
            return failure('internal', `history unavailable for session "${request.sessionId}": ${String(error)}`);
        }
    }
    /** Build the advisory provider/model catalog directly from LlmRuntime. */
    async modelCatalog(signal) {
        const catalog = await Promise.all(this.ctx.llm.listProviders().map(async (provider) => {
            try {
                signal.throwIfAborted();
                const models = await this.ctx.llm.listModels(provider.id);
                const entries = await Promise.all(models.map(async (model) => {
                    const resolved = await this.ctx.llm.resolveModelInfo(provider.id, model.id, signal);
                    return {
                        id: model.id,
                        name: model.name,
                        ...model.description === undefined ? {} : { description: model.description },
                        ...resolved.reasoning === undefined
                            ? {}
                            : {
                                reasoning: {
                                    efforts: resolved.reasoning.efforts.map(effort => ({
                                        id: effort.id,
                                        name: effort.name,
                                        ...effort.description === undefined ? {} : { description: effort.description },
                                    })),
                                    ...resolved.reasoning.defaultEffort === undefined
                                        ? {}
                                        : { defaultEffort: resolved.reasoning.defaultEffort },
                                },
                            },
                    };
                }));
                return {
                    kind: 'group',
                    value: { id: provider.id, name: provider.name, models: entries },
                };
            }
            catch (error) {
                if (signal.aborted)
                    throw error;
                return {
                    kind: 'failure',
                    value: {
                        id: provider.id,
                        name: provider.name,
                        message: error instanceof Error ? error.message : String(error),
                    },
                };
            }
        }));
        return {
            groups: catalog.flatMap(item => item.kind === 'group' && item.value.models.length > 0 ? [item.value] : []),
            failures: catalog.flatMap(item => item.kind === 'failure' ? [item.value] : []),
        };
    }
    /** Report the current session route and advisory model catalog. */
    async models(request, signal) {
        if (aborted(signal))
            return cancelled();
        const found = await this.agentFor(request.sessionId);
        if (!found.ok)
            return found;
        try {
            signal.throwIfAborted();
            const current = this.selectionFor(found.value).current;
            const catalog = await this.modelCatalog(signal);
            const routable = this.ctx.llm.listProviders().some(provider => provider.id === current.provider);
            return success({
                current: { ...current },
                routable,
                groups: catalog.groups,
                failures: catalog.failures,
            });
        }
        catch (error) {
            if (aborted(signal))
                return cancelled();
            return failure('internal', `model catalog unavailable: ${String(error)}`);
        }
    }
    /** Validate and apply one session-local provider/model/reasoning selection. */
    async selectModel(request, signal) {
        if (aborted(signal))
            return cancelled();
        const found = await this.agentFor(request.sessionId);
        if (!found.ok)
            return found;
        return this.serializeAdmission(found.value, async () => {
            try {
                const resolved = await this.ctx.llm.resolveCallConfig({
                    provider: request.provider,
                    model: request.model,
                    ...request.reasoningEffort === undefined
                        ? {}
                        : { reasoningEffort: ReasoningEffortId(request.reasoningEffort) },
                }, signal);
                signal.throwIfAborted();
                const selected = {
                    provider: resolved.provider,
                    model: resolved.model,
                    ...resolved.reasoningEffort === undefined
                        ? {}
                        : { reasoningEffort: resolved.reasoningEffort },
                };
                found.value.session.append('model/selection', selected);
                this.selectionFor(found.value);
                try {
                    await this.ctx.agentDefaultModel.saveSelection(selected);
                }
                catch (error) {
                    this.ctx.logger.warn(`session model selection was not saved as default: ${String(error)}`);
                }
                return success({ selected: { ...selected } });
            }
            catch (error) {
                if (aborted(signal))
                    return cancelled();
                return failure('model-unavailable', error instanceof Error ? error.message : String(error), { provider: request.provider, model: request.model });
            }
        });
    }
    /** Append a user-owned durable title through SessionTitleService. */
    async rename(request, signal) {
        if (aborted(signal))
            return cancelled();
        const found = await this.agentFor(request.sessionId);
        if (!found.ok)
            return found;
        const titles = this.ctx.get('sessionTitle');
        if (titles === undefined) {
            return failure('internal', 'renaming is unavailable: this deployment mounts no session-title service');
        }
        try {
            signal.throwIfAborted();
            const accepted = titles.rename(found.value.session, request.title);
            return success({ title: accepted.title, seq: accepted.eventSeq });
        }
        catch (error) {
            if (aborted(signal))
                return cancelled();
            if (error instanceof SessionTitleInvalidError) {
                return failure('title-invalid', error.message, { sessionId: request.sessionId });
            }
            return failure('internal', `failed to rename session "${request.sessionId}": ${String(error)}`);
        }
    }
    /** Resolve the Workspace inherited by an ordinary fork. */
    async forkWorkspace(source, signal) {
        const workspaces = this.ctx.workspaceRegistry.list();
        const direct = workspaces.find(workspace => workspace.sessionIds.includes(source.id));
        if (direct !== undefined || source.header.origin !== 'subagent')
            return direct;
        const query = this.ctx.get('sessionQuery');
        if (query === undefined) {
            throw new Error('cannot resolve a subagent fork workspace without session-query');
        }
        const lineage = await query.traceSession(source.id, signal);
        for (const ancestor of lineage.ancestors) {
            const workspace = workspaces.find(candidate => candidate.sessionIds.includes(ancestor.header.id));
            if (workspace !== undefined)
                return workspace;
        }
        return undefined;
    }
    /** Fork one completed-turn prefix under a new exact Agent lifecycle handle. */
    async fork(request, signal) {
        signal = AbortSignal.any([signal, this.lifetime.signal]);
        if (aborted(signal))
            return cancelled();
        if (request.atSeq !== undefined
            && (!Number.isSafeInteger(request.atSeq) || request.atSeq < 0)) {
            return failure('invalid-argument', 'atSeq must be a non-negative safe integer');
        }
        const parentRevision = this.ctx.workspaceRegistry.sessionAdmissionRevision(request.sessionId);
        try {
            this.ctx.workspaceRegistry.assertSessionAdmission(request.sessionId, parentRevision);
        }
        catch (error) {
            return failure('fork-unavailable', error instanceof Error ? error.message : String(error), { sessionId: request.sessionId });
        }
        let fixed;
        let checkedSource;
        try {
            let source;
            try {
                if (request.sourceRevision !== undefined) {
                    const observation = await this.semanticHistory.observe(request, signal);
                    fixed = observation;
                    source = { id: request.sessionId, header: observation.observed.header, events: observation.observed.events };
                    if (request.atSeq !== undefined && request.atSeq > observation.through) {
                        return failure('invalid-argument', 'fork anchor is outside the bound history cut');
                    }
                }
                else {
                    source = await this.readSessionState(request.sessionId, signal);
                }
            }
            catch (error) {
                if (aborted(signal))
                    return cancelled();
                if (error instanceof SemanticHistoryError)
                    return failure(error.code, error.message);
                if (error instanceof ApiRemoteSessionNotFound) {
                    return failure('session-not-found', error.message, { sessionId: request.sessionId });
                }
                return failure('internal', `fork source unavailable for session "${request.sessionId}": ${String(error)}`);
            }
            const lastSeq = fixed?.through ?? (source.events.at(-1)?.seq ?? -1);
            const anchoredBoundary = request.atSeq === undefined
                ? undefined
                : source.events.find(event => event.type === 'turn/end' && event.seq >= request.atSeq && event.seq <= lastSeq);
            const boundary = anchoredBoundary
                ?? (request.atSeq === undefined || request.atSeq > lastSeq
                    ? source.events.findLast(event => event.type === 'turn/end' && event.seq <= lastSeq)
                    : undefined);
            if (boundary === undefined) {
                return failure('fork-unavailable', request.atSeq !== undefined && request.atSeq <= lastSeq
                    ? `session "${request.sessionId}" has not completed the turn containing event ${request.atSeq}`
                    : `session "${request.sessionId}" has no completed turn to fork from`, { sessionId: request.sessionId });
            }
            let cut = boundary.seq + 1;
            while (cut <= lastSeq && source.events[cut]?.type !== 'turn/start')
                cut += 1;
            let workspace;
            try {
                workspace = await this.forkWorkspace(source, signal);
            }
            catch (error) {
                if (aborted(signal))
                    return cancelled();
                return failure('internal', `failed to resolve fork workspace for session "${request.sessionId}": ${String(error)}`);
            }
            const childId = SessionId(`session-${randomUUID()}`);
            const childRevision = this.ctx.workspaceRegistry.sessionAdmissionRevision(childId);
            // This seed is taken only from the initial immutable observation. Later
            // source validation never supplies replacement events or a newer preset.
            const seed = source.events.slice(0, cut);
            let handle;
            try {
                fixed?.assertCurrent();
                const composition = await this.composeAgent(resolveSessionPreset({
                    header: source.header, events: fixed === undefined ? source.events : seed,
                }));
                const admission = this.withSessionAdmission(composition.setup, [
                    { sessionId: request.sessionId, revision: parentRevision },
                    { sessionId: childId, revision: childRevision },
                ]);
                const bound = fixed;
                const setup = bound === undefined ? admission : async (agentCtx) => {
                    const prepared = await admission(agentCtx);
                    bound.assertCurrent();
                    // Reuse the source owner after all asynchronous composition work. A
                    // cold lease is a pinned snapshot, not an external-file write lock.
                    const checked = await this.semanticHistory.observe({
                        ...request, sourceRevision: bound.revision,
                    }, signal);
                    checkedSource = checked;
                    const assertSource = () => {
                        signal.throwIfAborted();
                        bound.assertCurrent();
                        checked.assertCurrent();
                        if (bound.observed.source === 'prepared' && this.ctx.sessions.get(request.sessionId) !== undefined) {
                            throw new SemanticHistoryError('history-stale-source', 'fork source became live before publication');
                        }
                    };
                    assertSource();
                    return { commit: () => {
                            assertSource();
                            prepared?.commit();
                            assertSource();
                        } };
                };
                handle = await this.ctx.agents.create({
                    sessionId: childId,
                    seed,
                    meta: {
                        ...source.header.cwd === undefined ? {} : { cwd: source.header.cwd },
                        parentSession: source.id,
                        seedLength: cut,
                        ...composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset },
                    },
                    agentOptions: this.agentOptions(),
                    signal,
                    setup,
                });
                signal.throwIfAborted();
                await this.ctx.sessions.flush(handle.agent.session);
                signal.throwIfAborted();
                this.ownHandle(handle);
            }
            catch (error) {
                if (handle !== undefined) {
                    try {
                        await handle.dispose();
                    }
                    catch (disposeError) {
                        this.ctx.logger.warn(`failed to dispose undurable fork "${childId}": ${String(disposeError)}`);
                    }
                }
                if (aborted(signal))
                    return cancelled();
                if (error instanceof SemanticHistoryError)
                    return failure(error.code, error.message);
                return failure('internal', `failed to fork session "${request.sessionId}": ${String(error)}`);
            }
            if (workspace !== undefined) {
                try {
                    await workspace.attachSession(childId);
                }
                catch (error) {
                    return failure('workspace-attach-failed', `session "${childId}" was forked but could not attach to workspace "${workspace.id}": ${String(error)}`, { sessionId: childId, workspaceId: workspace.id });
                }
            }
            return success({ sessionId: childId });
        }
        finally {
            // Both leases cover every early return and cancellation. A release
            // failure must not replace the operation's original result or error.
            for (const observation of [checkedSource, fixed]) {
                try {
                    observation?.[Symbol.dispose]();
                }
                catch {
                    this.ctx.logger.warn('failed to release a fork source observation');
                }
            }
        }
    }
    /** Promote base64 image parts to durable references in caller order. */
    async durablePromptContent(content) {
        if (content.every(part => part.type === 'text')) {
            return content.map(part => ({ type: 'text', text: part.text }));
        }
        const refs = await admitEncodedImages(this.ctx.attachments, content.filter(part => part.type === 'image'));
        let next = 0;
        return content.map(part => part.type === 'text'
            ? { type: 'text', text: part.text }
            : { type: 'image', attachment: refs[next++] });
    }
    /** Revalidate one resolved prompt target at its synchronous delivery commit. */
    assertPromptAdmission(sessionId, agent) {
        const revision = this.ctx.workspaceRegistry.sessionAdmissionRevision(sessionId);
        this.ctx.workspaceRegistry.assertSessionAdmission(sessionId, revision);
        if (this.ctx.agents.get(sessionId) !== agent || this.ctx.sessions.get(sessionId) !== agent.session) {
            throw new Error(`session "${sessionId}" lifecycle changed before prompt delivery`);
        }
    }
    /** Admit an unmatched slash line only when the live Agent can resolve its exact user-invocable skill. */
    async admitUnknownCommandAsSkill(commandLine, agent, signal) {
        const name = commandLine.slice(1).trim().split(/\s/u, 1)[0] ?? '';
        if (!isSkillName(name))
            return undefined;
        const registry = agent.ctx.get('skills') ?? this.ctx.get('skills');
        if (registry === undefined)
            return undefined;
        const skills = await registry.list({ cwd: agent.session.header.cwd, scope: agent, signal });
        return skills.some(skill => skill.name === name && isUserInvocable(skill))
            ? commandLine
            : undefined;
    }
    /** Read the existing projection without retaining a second transcript or receipt cache. */
    promptReceipt(session, invocationId) {
        const state = this.ctx.get('sessionProjections')?.stateOf(session, 'promptReceipts');
        if (state === undefined)
            throw new Error('ordinary prompt receipt projection is unavailable');
        return Object.hasOwn(state.entries, invocationId) ? state.entries[invocationId] : undefined;
    }
    receiptConflict(receipt, digest) {
        return receipt.conflict || receipt.digest === null || receipt.digest !== digest
            ? failure('invocation-conflict', 'invocationId was already accepted with different or unverifiable input') : undefined;
    }
    /** Once accepted, caller cancellation cannot undo delivery or bypass durability confirmation. */
    async confirmPrompt(session, invocationId) {
        try {
            const persistence = this.ctx.get('sessionPersistence');
            if (persistence === undefined || !await this.ctx.sessions.flush(session)) {
                throw new Error('ordinary prompt has no durability owner');
            }
            await persistence.ensureMaterialized(session);
            return success({ accepted: true });
        }
        catch (error) {
            return failure('prompt-durability-unconfirmed', 'prompt was accepted but its durable acknowledgement is not confirmed', {
                accepted: true, invocationId, reason: String(error),
            });
        }
    }
    /** Confirm a retry before provider lookup or Agent activation, including a cold completed Session. */
    async acceptedPrompt(request, digest, signal) {
        const env_3 = { stack: [], error: void 0, hasError: false };
        try {
            const revision = this.ctx.workspaceRegistry.sessionAdmissionRevision(request.sessionId);
            try {
                this.ctx.workspaceRegistry.assertSessionAdmission(request.sessionId, revision);
            }
            catch (error) {
                return failure('agent-busy', 'session lifecycle changed before prompt admission', { reason: String(error) });
            }
            const live = this.ctx.sessions.get(request.sessionId);
            if (live !== undefined) {
                if (hasApiRemoteSubagentOwner(this.ctx, live, this.ctx.agents.get(request.sessionId)))
                    return this.subagentFailure(request.sessionId);
                const receipt = this.promptReceipt(live, request.invocationId);
                if (receipt === undefined)
                    return undefined;
                return this.receiptConflict(receipt, digest) ?? this.confirmPrompt(live, request.invocationId);
            }
            const persistence = this.ctx.get('sessionPersistence');
            if (persistence === undefined)
                return undefined;
            const borrowed = __addDisposableResource(env_3, await persistence.borrowSession(request.sessionId, signal), false);
            signal.throwIfAborted();
            this.ctx.workspaceRegistry.assertSessionAdmission(request.sessionId, revision);
            if (this.ctx.sessions.get(request.sessionId) !== undefined)
                return await this.acceptedPrompt(request, digest, signal);
            if (borrowed.source === 'live')
                return failure('agent-busy', 'session lifecycle changed while verifying prompt admission');
            const session = borrowed.preparedSession;
            if (hasApiRemoteSubagentOwner(this.ctx, session, undefined))
                return this.subagentFailure(request.sessionId);
            this.ctx.get('sessionProjectionCache')?.hydratePrepared(session, borrowed.inspection.meta, borrowed.inspection.events);
            const receipt = this.promptReceipt(session, request.invocationId);
            if (receipt === undefined)
                return undefined;
            // This exact retained source was already read from persistence; no live flush or Agent resume is needed.
            return this.receiptConflict(receipt, digest) ?? success({ accepted: true });
        }
        catch (e_3) {
            env_3.error = e_3;
            env_3.hasError = true;
        }
        finally {
            __disposeResources(env_3);
        }
    }
    /** Admit ordinary queued or steering input to the exact live Agent. */
    async prompt(request, signal) {
        if (aborted(signal))
            return cancelled();
        if (request.invocationId.length === 0) {
            return failure('invalid-invocation-id', 'invocationId must be a non-empty opaque prompt identity');
        }
        const canonicalTimeZone = request.clientTimeZone === undefined
            ? undefined
            : canonicalClientTimeZone(request.clientTimeZone);
        if (request.clientTimeZone !== undefined && canonicalTimeZone === undefined) {
            return failure('invalid-time-zone', 'clientTimeZone must be UTC or a valid IANA Area/Location name', { value: request.clientTimeZone });
        }
        const digest = promptDigest(request, canonicalTimeZone);
        try {
            const accepted = await this.acceptedPrompt(request, digest, signal);
            if (accepted !== undefined)
                return accepted;
        }
        catch (error) {
            if (aborted(signal))
                return cancelled();
            return failure('prompt-unavailable', 'cannot verify ordinary prompt admission', { reason: String(error) });
        }
        const found = await this.agentFor(request.sessionId);
        if (!found.ok)
            return found;
        const agent = found.value;
        const commandLine = request.content.length === 1 && request.content[0]?.type === 'text'
            && request.content[0].text.startsWith('/')
            ? request.content[0].text
            : undefined;
        if (commandLine !== undefined) {
            const commands = this.ctx.get('commands');
            if (commands === undefined) {
                return failure('unknown-command', 'this deployment mounts no command registry');
            }
            try {
                const execution = await commands.execute(agent, commandLine, [], signal);
                if (execution === undefined) {
                    // Preserve a recognized skill gesture for dsh-tool-skill's pre-step
                    // owner; every other unmatched slash line remains a command error.
                    const skillPrompt = await this.admitUnknownCommandAsSkill(commandLine, agent, signal);
                    if (skillPrompt === undefined) {
                        return failure('unknown-command', `unknown command: ${commandLine.split(/\s/u, 1)[0] ?? commandLine}`);
                    }
                    request = { ...request, content: [{ type: 'text', text: skillPrompt }] };
                }
                else {
                    if (execution.result.kind === 'error') {
                        return failure('command-error', execution.result.text);
                    }
                    return success({
                        accepted: true,
                        command: {
                            kind: 'success',
                            ...execution.result.text === undefined ? {} : { text: execution.result.text },
                        },
                    });
                }
            }
            catch (error) {
                if (aborted(signal))
                    return cancelled();
                return failure('command-error', error instanceof Error ? error.message : String(error));
            }
        }
        const selection = this.selectionFor(agent).current;
        if (!this.ctx.llm.listProviders().some(provider => provider.id === selection.provider)) {
            return failure('model-unavailable', `no adapter serves provider "${selection.provider}"; select a model for this session`, { provider: selection.provider, model: selection.model });
        }
        // The Ark host path mirrors the controller: empty prompts never start a turn.
        const hasContent = request.content.some(part => part.type !== 'text' || part.text.trim().length > 0);
        if (!hasContent) {
            return failure('bad-request', 'prompt content must include non-whitespace text or an attachment', {});
        }
        const admit = async () => {
            try {
                signal.throwIfAborted();
                const receipt = this.promptReceipt(agent.session, request.invocationId);
                if (receipt !== undefined) {
                    return this.receiptConflict(receipt, digest) ?? await this.confirmPrompt(agent.session, request.invocationId);
                }
                if (this.ctx.get('sessionPersistence') === undefined) {
                    return failure('prompt-unavailable', 'ordinary prompts require a persistence owner');
                }
                // Ark 定制：图片一律允许上传，能否识别由模型自行决定；不再按模型模态拦截。
                const content = await this.durablePromptContent(request.content);
                signal.throwIfAborted();
                const source = {
                    kind: 'user',
                    invocationId: request.invocationId,
                    promptDigest: digest,
                    ...(canonicalTimeZone === undefined ? {} : { clientTimeZone: canonicalTimeZone }),
                };
                const message = createUserMessage({ content, source });
                this.assertPromptAdmission(request.sessionId, agent);
                try {
                    if (request.mode === 'steer')
                        agent.steer(message);
                    else
                        agent.followup(message);
                }
                catch (error) {
                    // A reentrant observer can throw or cancel after the log append committed.
                    if (this.promptReceipt(agent.session, request.invocationId) === undefined)
                        throw error;
                }
                if (this.promptReceipt(agent.session, request.invocationId) === undefined)
                    throw new Error('inbox did not record prompt acceptance');
                return await this.confirmPrompt(agent.session, request.invocationId);
            }
            catch (error) {
                if (aborted(signal))
                    return cancelled();
                if (error instanceof AttachmentError) {
                    return failure('attachment-error', error.message, { reason: error.code });
                }
                return failure('agent-busy', 'prompt rejected', { reason: String(error) });
            }
        };
        return this.serializeAdmission(agent, admit);
    }
    /** Return bytes only for an image referenced by the addressed Session log. */
    async attachment(request, signal) {
        if (aborted(signal))
            return cancelled();
        try {
            const state = await this.readSessionState(request.sessionId, signal);
            const ref = referencedImage(state.events, request.attachmentId);
            if (ref === undefined) {
                return failure('attachment-error', 'Image is not referenced by this session.', { reason: 'ATTACHMENT_NOT_REFERENCED' });
            }
            const stored = await this.ctx.attachments.readImage(ref, signal);
            return success({
                attachment: stored.ref,
                data: Buffer.from(stored.data).toString('base64'),
            });
        }
        catch (error) {
            if (aborted(signal))
                return cancelled();
            if (error instanceof ApiRemoteSessionNotFound) {
                return failure('session-not-found', error.message, { sessionId: request.sessionId });
            }
            if (error instanceof AttachmentError) {
                return failure('attachment-error', error.message, { reason: error.code });
            }
            return failure('internal', `attachment authorization unavailable for session "${request.sessionId}": ${String(error)}`);
        }
    }
    /** Validate one queue edit as text-only ContentBlock data. */
    queueEditContent(content) {
        const blocks = [];
        for (const value of content) {
            if (value === null || Array.isArray(value) || typeof value !== 'object')
                return undefined;
            const block = value;
            if (block.type !== 'text' || typeof block.text !== 'string')
                return undefined;
            blocks.push({ type: 'text', text: block.text });
        }
        return blocks;
    }
    /** Edit, remove, or immediately steer one exact pending inbox message. */
    updateQueue(request, signal) {
        if (aborted(signal))
            return settled(cancelled());
        const edited = request.action.kind === 'edit'
            ? this.queueEditContent(request.action.content)
            : undefined;
        if (request.action.kind === 'edit' && edited === undefined) {
            return settled(failure('attachment-error', 'queue edits accept text content only', { reason: 'QUEUE_EDIT_NON_TEXT' }));
        }
        if (edited !== undefined && !edited.some(block => block.type === 'text' && block.text.trim().length > 0)) {
            return settled(failure('invalid-argument', 'queue edit content must not be empty'));
        }
        const agent = this.ctx.agents.get(request.sessionId);
        // Upstream lets a continuable subagent's queue be edited, removed, and
        // steered; the child's inbox is its only turn queue, so mutating it here
        // is semantically correct. The shared ownership fence stays for every
        // other generic route (prompt, cancel, cold resume), so only an identity
        // with no live Agent at all — one that could not be a continuable child —
        // keeps rejecting below. A cold child has no live inbox to mutate, so it
        // rejects as queue-item-not-found rather than resuming under this route.
        if (agent === undefined) {
            return settled(failure('queue-item-not-found', 'queued item is no longer pending', { itemId: request.itemId }));
        }
        const messageId = MessageId(request.itemId);
        const target = agent.inbox.nextTurn.some(message => message.id === messageId)
            ? 'next-turn'
            : agent.inbox.nextStep.some(message => message.id === messageId) ? 'next-step' : undefined;
        const message = target === undefined
            ? undefined
            : (target === 'next-turn' ? agent.inbox.nextTurn : agent.inbox.nextStep)
                .find(candidate => candidate.id === messageId);
        if (target === undefined || message === undefined) {
            return settled(failure('queue-item-not-found', 'queued item is no longer pending', { itemId: request.itemId }));
        }
        if (request.action.kind === 'steer' && (target !== 'next-turn' || agent.status !== 'running')) {
            return settled(failure('steer-unavailable', 'current turn no longer accepts steering', { itemId: request.itemId }));
        }
        if (request.action.kind === 'edit') {
            agent.inbox.replace(messageId, freezeMessage({ ...message, content: edited }));
        }
        else {
            agent.inbox.remove(messageId);
            if (request.action.kind === 'steer')
                agent.steer(message);
        }
        return settled(success({ accepted: true }));
    }
    /** Cancel the active ordinary turn while preserving queued input. */
    cancel(request, signal) {
        if (aborted(signal))
            return settled(cancelled());
        const agent = this.ctx.agents.get(request.sessionId);
        if (agent === undefined) {
            return settled(failure('session-not-found', `session "${request.sessionId}" not found (not attached)`, { sessionId: request.sessionId }));
        }
        if (hasApiRemoteSubagentOwner(this.ctx, agent.session, agent)) {
            return settled(this.subagentFailure(request.sessionId));
        }
        agent.cancel({ kind: 'user' }, { keepInbox: true });
        return settled(success({ accepted: true }));
    }
    /**
     * Retire one archived resident only through the exact handle this Host owns.
     * The Workspace registry performs the subsequent descendant ordering,
     * persistence reservation check, durable delete, and account cleanup.
     */
    async retireArchivedSession(sessionId, signal) {
        signal.throwIfAborted();
        const agent = this.ctx.agents.get(sessionId);
        if (agent === undefined)
            return;
        const handle = this.handles.get(sessionId);
        if (handle === undefined || handle.agent !== agent || !this.ctx.agents.roots().includes(agent)) {
            throw new WorkspaceSessionDeletionBlockedError(sessionId, 'resident');
        }
        let disposal;
        try {
            await agent.runMaintenance((maintenanceSignal) => {
                signal.throwIfAborted();
                maintenanceSignal.throwIfAborted();
                const currentHandle = this.handles.get(sessionId);
                const unsafe = currentHandle !== handle
                    || handle.agent !== agent
                    || this.ctx.agents.get(sessionId) !== agent
                    || this.ctx.sessions.get(sessionId) !== agent.session
                    || !this.ctx.agents.roots().includes(agent)
                    || !this.ctx.workspaceRegistry.archivedSessionIds.includes(sessionId)
                    || agent.status !== 'idle'
                    || agent.inbox.hasPending
                    || hasOpenTurn(agent.session)
                    || (this.ctx.get('jobs')?.list(agent).some(job => job.ownerSession === sessionId) ?? false);
                if (unsafe)
                    throw new WorkspaceSessionDeletionBlockedError(sessionId, 'resident');
                signal.throwIfAborted();
                disposal = handle.dispose();
                return Promise.resolve();
            });
        }
        finally {
            if (disposal !== undefined)
                await disposal;
        }
    }
}
export default SessionRemoteOperationsService;
//# sourceMappingURL=index.js.map