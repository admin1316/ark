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
/** Complete message reads over the existing immutable Session observation owner. */
import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { BlockAssembler, deepFreeze } from '@deepseek-ai/dsh-llm';
import { SessionQueryError } from '@deepseek-ai/dsh-session-query';
import { deriveTurnTokenUsage } from '@deepseek-ai/dsh-token-meter/client';
/** A read refusal that can cross the existing Remote result boundary. */
export class SemanticHistoryError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
/** Numeric indices and optional assembled text; never retains a prepared lease or raw log. */
export class SemanticHistoryReader {
    ctx;
    createPresenter;
    generations = new WeakMap();
    indices = new Map();
    content = new Map();
    contentBytes = 0;
    materializing = false;
    maxIndices;
    maxIndexBytes;
    maxContentBytes;
    maxContentReaders;
    contentIdleMs;
    constructor(ctx, createPresenter, limits = {}) {
        this.ctx = ctx;
        this.createPresenter = createPresenter;
        this.maxIndices = limits.indexEntries ?? 8;
        this.maxIndexBytes = limits.indexBytes ?? 16 * 1024 * 1024;
        this.maxContentBytes = limits.contentBytes ?? 8 * 1024 * 1024;
        this.maxContentReaders = limits.contentReaders ?? 8;
        this.contentIdleMs = limits.contentIdleMs ?? 60_000;
        for (const value of [this.maxIndices, this.maxIndexBytes, this.maxContentBytes, this.maxContentReaders, this.contentIdleMs]) {
            if (!Number.isSafeInteger(value) || value < 0)
                throw new Error('semantic history limits must be non-negative safe integers');
        }
    }
    /** Release cached indices and retained content readers, including their expiry timers. */
    clear() {
        this.indices.clear();
        for (const id of this.content.keys())
            this.closeContent(id);
    }
    /**
     * Retain one authoritative immutable source for raw and semantic history alike.
     * @param request - Session identity, optional expected child ownership, and optional previously issued source cut.
     * @param signal - cancels observation acquisition; an abort detected before return releases the acquired observation.
     * @returns authorized source and cut with a current-source assertion; the caller must dispose the returned lease.
     * @throws SemanticHistoryError when the query owner is absent, the source is stale, or child ownership is invalid.
     */
    async observe(request, signal) {
        const query = this.ctx.get('sessionQuery');
        if (query === undefined)
            throw new SemanticHistoryError('history-unavailable', 'session query is not mounted');
        if (request.sourceRevision !== undefined && typeof request.sourceRevision !== 'string') {
            throw new SemanticHistoryError('invalid-argument', 'sourceRevision must be a string');
        }
        let observed;
        try {
            observed = await query.observeSession(request.sessionId, {
                projectionMode: request.expectedSubagentMode === undefined ? 'none' : 'all', signal,
            });
        }
        catch (error) {
            if (request.sourceRevision !== undefined && error instanceof SessionQueryError
                && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
                throw new SemanticHistoryError('history-stale-source', 'history source is no longer available');
            }
            throw error;
        }
        try {
            signal.throwIfAborted();
            const identity = this.identity(observed);
            const through = request.sourceRevision === undefined ? observed.cursor
                : this.cut(request.sourceRevision, identity, observed.cursor);
            this.authorize(request, observed, through);
            return { observed, identity, through, revision: `${identity}:${String(through)}`,
                assertCurrent: () => { this.assertCurrent(observed, identity); },
                [Symbol.dispose]: () => { observed[Symbol.dispose](); },
            };
        }
        catch (error) {
            observed[Symbol.dispose]();
            throw error;
        }
    }
    authorize(request, observed, through) {
        if (request.expectedParentSessionId !== undefined && observed.header.parentSession !== request.expectedParentSessionId) {
            throw new SemanticHistoryError('subagent-unauthorized', 'subagent parent changed during history read');
        }
        if (observed.header.origin !== 'subagent' && request.expectedSubagentMode === undefined)
            return;
        if (observed.header.origin !== 'subagent' || request.expectedParentSessionId === undefined || request.expectedSubagentMode === undefined) {
            throw new SemanticHistoryError('subagent-unauthorized', 'child history requires its direct parent and mode');
        }
        // The registered identity projection is the descriptor authority. It was
        // observed with these exact events/header; a catalog lookup is not evidence.
        const descriptor = observed.projections?.values.subagent;
        if (descriptor === undefined || descriptor === null || descriptor.seq < (observed.header.seedLength ?? 0)
            || descriptor.seq > through) {
            throw new SemanticHistoryError('subagent-catalog-diagnostic', 'child history has no valid own descriptor at this cut');
        }
        if (descriptor.mode !== request.expectedSubagentMode) {
            throw new SemanticHistoryError('subagent-not-found', 'requested child mode does not match the history source');
        }
    }
    /**
     * Existing preset owner receives only the latest selection at the bound cut.
     * @param observed - retained immutable source whose header and events belong to this read.
     * @param identity - source identity returned with the observation, used to reuse its numeric index.
     * @param through - inclusive fixed event cut; later preset selections are excluded.
     * @param signal - checked while indexing to stop cancelled reads.
     * @returns original header and at most one preset-selection event for the existing preset resolver.
     */
    presentationSource(observed, identity, through, signal) {
        const index = this.index(identity, observed.events, through, signal);
        const seq = index.presetSelections.findLast(seq => seq <= through);
        const preset = seq === undefined ? undefined : observed.events[seq];
        return { header: observed.header, events: preset === undefined ? [] : [preset] };
    }
    /**
     * Read semantic descriptors or fragments of exact JSON content at an authorized source cut.
     * @param request - page cursor or content-reader request, including ownership and source revision where required.
     * @param signal - caller cancellation checked during source observation, indexing, and content production.
     * @returns a semantic page or content fragment; unfinished content is retained until completion, close, expiry, or clear.
     * @throws SemanticHistoryError for invalid requests, stale sources, ownership failures, or exhausted reader budgets.
     */
    async read(request, signal) {
        const env_1 = { stack: [], error: void 0, hasError: false };
        try {
            if (request.view === 'content' && typeof request.sourceRevision !== 'string') {
                throw new SemanticHistoryError('invalid-argument', 'content requires sourceRevision');
            }
            if (request.view === 'semantic' && request.beforeRecordId !== undefined && request.sourceRevision === undefined) {
                throw new SemanticHistoryError('invalid-argument', 'pagination requires sourceRevision');
            }
            if (request.view === 'content' && request.contentReadId !== undefined) {
                return this.continueContent(request, request.contentReadId, signal);
            }
            if (request.view === 'content' && request.close === true)
                throw new SemanticHistoryError('invalid-argument', 'close requires contentReadId');
            const source = __addDisposableResource(env_1, await this.observe(request, signal), false);
            const { observed, identity, through, revision } = source;
            const index = this.index(identity, observed.events, through, signal);
            const records = index.records.filter(record => record.orderSeq <= through);
            if (request.view === 'content') {
                const domain = ['tool', 'status', 'turn'].find(domain => request.recordId === `${identity}/dependency-${domain}`);
                const record = domain === undefined ? records.find(item => item.id === request.recordId)
                    : { id: request.recordId, kind: 'tool', domain, orderSeq: 0 };
                if (record === undefined)
                    throw new SemanticHistoryError('invalid-argument', 'record does not belong to this history cut');
                const offset = boundedInteger(request.offset, 0, 0, Number.MAX_SAFE_INTEGER, 'offset');
                const maximum = boundedInteger(request.maxCodeUnits, 16_384, 2, 65_536, 'maxCodeUnits');
                const key = `${revision}/${record.id}`;
                let readId;
                let materialized;
                if (materialized === undefined) {
                    if (offset !== 0)
                        throw new SemanticHistoryError('invalid-argument', 'continuation requires contentReadId');
                    if (this.materializing || this.content.size >= this.maxContentReaders || this.contentBytes > this.maxContentBytes) {
                        throw new SemanticHistoryError('history-content-busy', 'finish or close an existing content read first');
                    }
                    this.materializing = true;
                    let text;
                    try {
                        text = await this.recordText(record, observed, revision, index, through, signal);
                    }
                    finally {
                        this.materializing = false;
                    }
                    this.assertCurrent(observed, identity);
                    const bytes = contentCharge(key, text);
                    // One oversize message may complete without per-fragment rebuilding.
                    // It occupies the only oversize slot until completion, close or expiry.
                    if (this.content.size >= this.maxContentReaders || this.contentBytes > this.maxContentBytes
                        || (bytes <= this.maxContentBytes && this.contentBytes + bytes > this.maxContentBytes)) {
                        throw new SemanticHistoryError('history-content-busy', 'content reader budget is in use');
                    }
                    readId = randomUUID();
                    const timer = this.expiry(readId);
                    materialized = {
                        key, text, bytes, timer, sessionId: request.sessionId, parentSessionId: observed.header.parentSession,
                        subagentMode: request.expectedSubagentMode, subagentDescriptorSeq: observed.projections?.values.subagent?.seq,
                        identity, revision, through, recordId: record.id,
                    };
                    this.content.set(readId, materialized);
                    this.contentBytes += bytes;
                }
                // Above branches either validate or create this handle.
                if (readId === undefined)
                    throw new Error('content reader has no identity');
                const text = materialized.text;
                if (offset > text.length || splitsSurrogate(text, offset)) {
                    throw new SemanticHistoryError('invalid-argument', 'offset is not a content boundary');
                }
                let end = Math.min(text.length, offset + maximum);
                if (splitsSurrogate(text, end))
                    end -= 1;
                this.assertCurrent(observed, identity);
                const done = end === text.length;
                const fragment = text.slice(offset, end);
                if (done)
                    this.closeContent(readId);
                else {
                    clearTimeout(materialized.timer);
                    materialized.timer = this.expiry(readId);
                }
                return {
                    view: 'content', sourceRevision: revision, asOfThroughSeq: through,
                    recordId: record.id, contentReadId: readId, encoding: 'json', offset,
                    text: fragment, nextOffset: end, done,
                };
            }
            const count = boundedInteger(request.maxRecords, 50, 1, 200, 'maxRecords');
            const before = request.beforeRecordId === undefined
                ? records.length
                : records.findIndex(record => record.id === request.beforeRecordId);
            if (before < 0)
                throw new SemanticHistoryError('invalid-argument', 'cursor does not belong to this history cut');
            const start = Math.max(0, before - count);
            const page = [];
            for (const record of records.slice(start, before)) {
                signal.throwIfAborted();
                const canonical = atCut(record.canonical, through);
                const call = atCut(record.call, through);
                const result = atCut(record.result, through);
                const endSeq = record.turn === undefined ? undefined : atCut(index.turnEnds.get(record.turn), through);
                const end = endSeq === undefined ? undefined : observed.events[endSeq];
                const finalized = canonical === undefined ? undefined : observed.events[canonical];
                const state = record.kind === 'assistant'
                    ? finalized?.type === 'assistant/message'
                        ? finalized.data.interrupted === true ? 'interrupted' : 'complete'
                        : atCut(record.orphaned, through) !== undefined ? 'orphaned-prefix'
                            : atCut(record.closed, through) !== undefined || end !== undefined
                                ? 'failed-prefix'
                                : observed.source === 'live' ? 'active' : 'orphaned-prefix'
                    : record.kind === 'tool' && (call === undefined || result === undefined) ? 'unpaired' : 'complete';
                page.push({
                    id: record.id, kind: record.kind, orderSeq: record.orderSeq,
                    time: observed.events[record.orderSeq]?.time ?? 0,
                    ...record.turn === undefined ? {} : { turn: record.turn },
                    ...record.step === undefined ? {} : { step: record.step },
                    state, contentState: 'complete-at-cut',
                    preview: safePreview(this.preview(record, observed.events, through, signal)),
                    ...canonical === undefined ? {} : { canonicalEventSeq: canonical },
                    ...call === undefined ? {} : { callEventSeq: call },
                    ...result === undefined ? {} : { resultEventSeq: result },
                    ...end?.type === 'turn/end' && end.data.reason.kind === 'completed' ? { completedTurnEndSeq: end.seq } : {},
                });
            }
            this.assertCurrent(observed, identity);
            return {
                view: 'semantic', sourceRevision: revision, asOfThroughSeq: through,
                records: page, hasMore: start > 0,
                turns: this.turnContexts(index, through, new Set(page.flatMap(record => record.turn === undefined ? [] : [record.turn]))),
                dependencyRecords: { tool: `${identity}/dependency-tool`, status: `${identity}/dependency-status`, turn: `${identity}/dependency-turn` },
                ...start > 0 && page[0] !== undefined ? { nextBeforeRecordId: page[0].id } : {},
                pendingDomains: [],
            };
        }
        catch (e_1) {
            env_1.error = e_1;
            env_1.hasError = true;
        }
        finally {
            __disposeResources(env_1);
        }
    }
    async continueContent(request, readId, signal) {
        signal.throwIfAborted();
        const body = this.content.get(readId);
        if (body === undefined || body.sessionId !== request.sessionId
            || body.recordId !== request.recordId || body.revision !== request.sourceRevision) {
            throw new SemanticHistoryError('history-content-expired', 'content reader expired or belongs to another record');
        }
        if (request.expectedParentSessionId !== undefined && body.parentSessionId !== request.expectedParentSessionId) {
            throw new SemanticHistoryError('subagent-unauthorized', 'content reader belongs to another parent');
        }
        if (body.subagentMode !== undefined && (request.expectedSubagentMode !== body.subagentMode
            || request.expectedParentSessionId !== body.parentSessionId)) {
            throw new SemanticHistoryError('subagent-unauthorized', 'content reader requires its original child address');
        }
        const offset = boundedInteger(request.offset, 0, 0, Number.MAX_SAFE_INTEGER, 'offset');
        const maximum = boundedInteger(request.maxCodeUnits, 16_384, 2, 65_536, 'maxCodeUnits');
        if (request.close === true) {
            // Closing exposes no old content and must work after replacement/deletion.
            this.closeContent(readId);
            return { view: 'content', sourceRevision: body.revision, asOfThroughSeq: body.through,
                recordId: body.recordId, contentReadId: readId, encoding: 'json', offset, text: '', nextOffset: offset, done: true };
        }
        const current = this.ctx.sessions.get(body.sessionId);
        let valid = false;
        if (current !== undefined) {
            valid = this.generations.get(current) === body.identity && current.seq - 1 >= body.through
                && current.header.parentSession === body.parentSessionId;
            if (valid && body.subagentMode !== undefined) {
                valid = this.currentChildDescriptor(current, body.subagentMode, body.subagentDescriptorSeq);
            }
        }
        else if (body.identity.startsWith('cold-')) {
            const persistence = this.ctx.get('sessionPersistence');
            if (persistence !== undefined) {
                const snapshots = await persistence.listSnapshots(signal);
                const snapshot = snapshots.find(item => item.header.id === body.sessionId);
                signal.throwIfAborted();
                valid = this.ctx.sessions.get(body.sessionId) === undefined && snapshot !== undefined
                    && coldIdentity(String(snapshot.revision)) === body.identity
                    && snapshot.header.parentSession === body.parentSessionId;
            }
        }
        if (!valid) {
            this.closeContent(readId);
            throw new SemanticHistoryError('history-stale-source', 'content source was replaced or changed');
        }
        if (offset > body.text.length || splitsSurrogate(body.text, offset)) {
            throw new SemanticHistoryError('invalid-argument', 'offset is not a content boundary');
        }
        let end = Math.min(body.text.length, offset + maximum);
        if (splitsSurrogate(body.text, end))
            end -= 1;
        const done = end === body.text.length;
        const text = body.text.slice(offset, end);
        if (done)
            this.closeContent(readId);
        else {
            clearTimeout(body.timer);
            body.timer = this.expiry(readId);
        }
        return { view: 'content', sourceRevision: body.revision, asOfThroughSeq: body.through,
            recordId: body.recordId, contentReadId: readId, encoding: 'json', offset, text, nextOffset: end, done };
    }
    assertCurrent(observed, identity) {
        if (observed.source === 'live') {
            if (this.identity(observed) !== identity) {
                throw new SemanticHistoryError('history-stale-source', 'history source changed while presenting content');
            }
            const descriptor = observed.projections?.values.subagent;
            const current = this.ctx.sessions.get(observed.header.id);
            if (observed.header.origin === 'subagent' && (current === undefined || descriptor == null
                || !this.currentChildDescriptor(current, descriptor.mode, descriptor.seq))) {
                throw new SemanticHistoryError('history-stale-source', 'child descriptor changed while reading history');
            }
        }
    }
    currentChildDescriptor(session, mode, seq) {
        try {
            const descriptor = this.ctx.get('sessionProjections')?.snapshot(session, ['subagent']).values.subagent;
            return descriptor !== undefined && descriptor !== null && descriptor.mode === mode && descriptor.seq === seq;
        }
        catch {
            return false;
        }
    }
    identity(observed) {
        if (observed.source === 'prepared') {
            return coldIdentity(String(observed.revision));
        }
        const session = this.ctx.sessions.get(observed.header.id);
        if (session === undefined || session.header !== observed.header
            || session.seq - 1 < observed.cursor
            || session.eventAt(observed.cursor) !== observed.events[observed.cursor]) {
            throw new SemanticHistoryError('history-stale-source', 'live source changed during observation');
        }
        let generation = this.generations.get(session);
        if (generation === undefined) {
            generation = `live-${randomUUID()}`;
            this.generations.set(session, generation);
        }
        return generation;
    }
    cut(revision, identity, available) {
        const prefix = `${identity}:`;
        if (!revision.startsWith(prefix))
            throw new SemanticHistoryError('history-stale-source', 'history source was replaced or changed');
        const text = revision.slice(prefix.length);
        const cut = Number(text);
        if (!Number.isSafeInteger(cut) || cut < -1 || cut > available || String(cut) !== text) {
            throw new SemanticHistoryError('history-stale-source', 'history cut is no longer available');
        }
        return cut;
    }
    index(identity, events, through, signal) {
        let index = this.indices.get(identity);
        this.indices.delete(identity);
        index ??= {
            through: -1, records: [], currentAttempts: new Map(), firstChunks: new Map(), calls: new Map(),
            turnEnds: new Map(), turnStarts: new Map(), turnUsage: new Map(), usageBytes: 0, presetSelections: [],
            activeTurn: undefined, dependencies: { tool: [], status: [], turn: [] }, lastMetricChunk: undefined,
        };
        for (let seq = index.through + 1; seq <= through; seq += 1) {
            if ((seq & 4095) === 0)
                signal.throwIfAborted();
            const event = events[seq];
            if (event === undefined)
                throw new SemanticHistoryError('history-stale-source', 'history prefix is not contiguous');
            indexDependencies(index, event);
            switch (event.type) {
                case 'agent-preset/selected':
                    index.presetSelections.push(seq);
                    break;
                case 'turn/start':
                    if (!index.turnStarts.has(event.data.turn))
                        index.turnStarts.set(event.data.turn, seq);
                    index.activeTurn = event.data.turn;
                    break;
                case 'user/message':
                    index.records.push({ id: `${identity}/user-${String(seq)}`, kind: 'user', orderSeq: seq, canonical: seq, ...index.activeTurn === undefined ? {} : { turn: index.activeTurn } });
                    break;
                case 'assistant/chunk': {
                    const key = `${String(event.data.turn)}:${String(event.data.step)}`;
                    let attempt = index.currentAttempts.get(key);
                    if (attempt === undefined || attempt.canonical !== undefined) {
                        attempt = { id: `${identity}/assistant-${String(seq)}`, kind: 'assistant', orderSeq: seq, firstChunk: seq, turn: event.data.turn, step: event.data.step };
                        index.records.push(attempt);
                        index.currentAttempts.set(key, attempt);
                        index.firstChunks.set(seq, attempt);
                    }
                    attempt.lastChunk = seq;
                    if (event.data.chunk.type === 'finish' && (event.data.chunk.reason.kind === 'error' || event.data.chunk.reason.kind === 'aborted'))
                        attempt.closed = seq;
                    break;
                }
                case 'assistant/message': {
                    let first;
                    for (const source of event.sourceEventSeqs ?? []) {
                        const chunk = events[source];
                        if (chunk?.type === 'assistant/chunk' && chunk.data.turn === event.data.turn && chunk.data.step === event.data.step) {
                            first = first === undefined ? source : Math.min(first, source);
                        }
                    }
                    const key = `${String(event.data.turn)}:${String(event.data.step)}`;
                    let attempt = first === undefined ? undefined : index.firstChunks.get(first);
                    if (attempt === undefined || attempt.canonical !== undefined) {
                        attempt = { id: `${identity}/assistant-${String(seq)}`, kind: 'assistant', orderSeq: seq, turn: event.data.turn, step: event.data.step };
                        index.records.push(attempt);
                    }
                    attempt.canonical = seq;
                    index.currentAttempts.delete(key);
                    break;
                }
                case 'llm/retry-started': {
                    const key = `${String(event.data.turn)}:${String(event.data.step)}`;
                    const attempt = index.currentAttempts.get(key);
                    if (attempt !== undefined)
                        attempt.closed ??= seq;
                    index.currentAttempts.delete(key);
                    break;
                }
                case 'tool/call': {
                    const key = `${String(event.data.turn)}:${String(event.data.step)}:${event.data.callId}`;
                    const record = { id: `${identity}/tool-${String(seq)}`, kind: 'tool', orderSeq: seq, call: seq, turn: event.data.turn, step: event.data.step };
                    index.calls.set(key, record);
                    index.records.push(record);
                    break;
                }
                case 'tool/result': {
                    const key = `${String(event.data.turn)}:${String(event.data.step)}:${event.data.message.source.callId}`;
                    let record = index.calls.get(key);
                    if (record === undefined) {
                        record = { id: `${identity}/tool-${String(seq)}`, kind: 'tool', orderSeq: seq, turn: event.data.turn, step: event.data.step };
                        index.records.push(record);
                    }
                    record.result = seq;
                    break;
                }
                case 'session/end-seed':
                    for (const attempt of index.currentAttempts.values())
                        attempt.orphaned ??= seq;
                    index.currentAttempts.clear();
                    break;
                case 'turn/end':
                    index.turnEnds.set(event.data.turn, seq);
                    const start = index.turnStarts.get(event.data.turn);
                    const usage = start === undefined ? null : deriveTurnTokenUsage(eventRange(events, start, seq, signal)) ?? null;
                    index.turnUsage.set(event.data.turn, usage === null ? null : deepFreeze(usage));
                    index.usageBytes += JSON.stringify(usage).length * 2;
                    if (index.activeTurn === event.data.turn)
                        index.activeTurn = undefined;
                    for (const [key, attempt] of index.currentAttempts) {
                        if (attempt.turn === event.data.turn) {
                            attempt.closed ??= seq;
                            index.currentAttempts.delete(key);
                        }
                    }
                    break;
                default: break;
            }
            index.through = seq;
        }
        // Charge conservatively for numeric records plus map keys/entries. No body or
        // event array is retained. Oversize indices remain usable by this request.
        this.indices.set(identity, index);
        const charge = (value) => value.usageBytes + value.presetSelections.length * 16
            + value.records.length * 1024
            + (value.dependencies.tool.length + value.dependencies.status.length + value.dependencies.turn.length) * 16
            + (value.turnEnds.size + value.turnStarts.size + value.turnUsage.size) * 1024
            + [...value.calls.keys()].reduce((sum, key) => sum + key.length * 4 + 128, 0);
        let bytes = [...this.indices.values()].reduce((sum, value) => sum + charge(value), 0);
        while (this.indices.size > this.maxIndices || bytes > this.maxIndexBytes) {
            const first = this.indices.keys().next().value;
            if (first === undefined)
                break;
            const removed = this.indices.get(first);
            if (removed !== undefined)
                bytes -= charge(removed);
            this.indices.delete(first);
        }
        return index;
    }
    blocks(record, events, through, signal) {
        const canonical = atCut(record.canonical, through);
        const event = canonical === undefined ? undefined : events[canonical];
        if (event?.type === 'user/message')
            return event.data.content;
        if (event?.type === 'assistant/message')
            return event.data.message.content;
        const assembler = new BlockAssembler();
        if (record.firstChunk !== undefined && record.lastChunk !== undefined) {
            for (let seq = record.firstChunk; seq <= Math.min(through, record.lastChunk); seq += 1) {
                if ((seq & 4095) === 0)
                    signal.throwIfAborted();
                const chunk = events[seq];
                if (chunk?.type === 'assistant/chunk' && chunk.data.turn === record.turn && chunk.data.step === record.step)
                    assembler.push(chunk.data.chunk);
            }
        }
        return assembler.interruptedBlocks();
    }
    preview(record, events, through, signal) {
        if (record.kind === 'tool') {
            const call = record.call === undefined ? undefined : events[record.call];
            return call?.type === 'tool/call' ? call.data.name.slice(0, 256) : 'tool result';
        }
        const canonical = atCut(record.canonical, through);
        const event = canonical === undefined ? undefined : events[canonical];
        if (event?.type === 'user/message')
            return blockPreview(event.data.content);
        if (event?.type === 'assistant/message')
            return blockPreview(event.data.message.content);
        // A preview is a bounded streamed excerpt, never the authoritative body.
        // Full recovery separately feeds the same assembler through the exact cut.
        const assembler = new BlockAssembler();
        if (record.firstChunk === undefined || record.lastChunk === undefined)
            return '';
        const end = Math.min(through, record.lastChunk, record.firstChunk + 4095);
        for (let seq = record.firstChunk; seq <= end; seq += 1) {
            signal.throwIfAborted();
            const event = events[seq];
            if (event?.type !== 'assistant/chunk' || event.data.turn !== record.turn || event.data.step !== record.step)
                continue;
            const chunk = event.data.chunk;
            if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
                assembler.push({ ...chunk, text: chunk.text.slice(0, 256) });
            }
            else if (chunk.type === 'block-end' && (chunk.block.type === 'text' || chunk.block.type === 'reasoning')) {
                assembler.push({ ...chunk, block: { ...chunk.block, text: chunk.block.text.slice(0, 256) } });
            }
            else if (chunk.type === 'block-start' && (chunk.blockType === 'text' || chunk.blockType === 'reasoning')) {
                assembler.push(chunk);
            }
            const preview = blockPreview(assembler.interruptedBlocks());
            if (preview.length >= 256)
                return preview;
        }
        return blockPreview(assembler.interruptedBlocks());
    }
    async recordText(record, observed, revision, index, through, signal) {
        const canonical = atCut(record.canonical, through);
        const event = canonical === undefined ? undefined : observed.events[canonical];
        // Pass only the latest selection at this cut to the existing preset owner.
        // Presentation never scans the full log per dependency, or reads a later selection.
        const presetSeq = index.presetSelections.findLast(seq => seq <= through);
        const preset = presetSeq === undefined ? undefined : observed.events[presetSeq];
        const present = this.createPresenter({ header: observed.header, events: preset === undefined ? [] : [preset] });
        let body;
        if (record.domain !== undefined) {
            body = await this.dependencyBundle(record.domain, observed, revision, index, through, signal, present);
        }
        else if (record.kind === 'tool') {
            const callSeq = atCut(record.call, through);
            const resultSeq = atCut(record.result, through);
            const call = callSeq === undefined ? undefined : observed.events[callSeq];
            const result = resultSeq === undefined ? undefined : observed.events[resultSeq];
            const dependencies = call === undefined ? [] : [call];
            body = {
                kind: 'tool',
                ...call === undefined ? {} : { call: await present(call, dependencies) },
                ...result === undefined ? {} : { result: await present(result, dependencies) },
            };
        }
        else if (event?.type === 'user/message' || event?.type === 'assistant/message') {
            body = { kind: record.kind, entry: await present(event, []) };
        }
        else {
            body = { kind: 'assistant-prefix', turn: record.turn, step: record.step, content: this.blocks(record, observed.events, through, signal) };
        }
        signal.throwIfAborted();
        return JSON.stringify(body);
    }
    turnContexts(index, through, turns = index.turnStarts.keys()) {
        const result = [];
        for (const turn of turns) {
            const startSeq = atCut(index.turnStarts.get(turn), through);
            const endSeq = atCut(index.turnEnds.get(turn), through);
            if (startSeq === undefined && endSeq === undefined)
                continue;
            result.push({ turn, ...startSeq === undefined ? {} : { startSeq }, ...endSeq === undefined ? {} : { endSeq },
                usage: endSeq === undefined ? null : index.turnUsage.get(turn) ?? null });
        }
        return result;
    }
    async dependencyBundle(domain, observed, revision, index, through, signal, present) {
        const sequences = index.dependencies[domain].filter(seq => seq <= through);
        // At an old cut within a still-growing contiguous chunk run, that cut is
        // its actual last timing observation. Never substitute the latest tail.
        if (domain === 'turn' && observed.events[through]?.type === 'assistant/chunk' && sequences.at(-1) !== through)
            sequences.push(through);
        const entries = [];
        const missing = new Set();
        const sourceEvents = [];
        for (const seq of sequences) {
            signal.throwIfAborted();
            const event = observed.events[seq];
            if (event === undefined)
                throw new SemanticHistoryError('history-stale-source', 'dependency source is incomplete');
            sourceEvents.push(event);
            let dependencies = [];
            if (event.type === 'tool/result') {
                const key = `${String(event.data.turn)}:${String(event.data.step)}:${event.data.message.source.callId}`;
                const callSeq = atCut(index.calls.get(key)?.call, through);
                const call = callSeq === undefined ? undefined : observed.events[callSeq];
                if (call === undefined)
                    missing.add('parent-call');
                else
                    dependencies = [call];
            }
            entries.push(await present(event, dependencies));
        }
        for (const reason of missingDependencies(sourceEvents))
            missing.add(reason);
        return { kind: 'dependency', domain, sourceRevision: revision, asOfThroughSeq: through,
            completeness: missing.size === 0 ? 'complete' : 'unknown', missing: [...missing], chunkCoverage: domain === 'turn' ? 'timing-boundaries' : 'none',
            entries, turns: this.turnContexts(index, through) };
    }
    expiry(readId) {
        const timer = setTimeout(() => { this.closeContent(readId); }, this.contentIdleMs);
        timer.unref();
        return timer;
    }
    closeContent(readId) {
        const body = this.content.get(readId);
        if (body === undefined)
            return;
        clearTimeout(body.timer);
        this.contentBytes -= body.bytes;
        this.content.delete(readId);
    }
}
function atCut(seq, through) {
    return seq !== undefined && seq <= through ? seq : undefined;
}
function boundedInteger(value, fallback, minimum, maximum, name) {
    const result = value ?? fallback;
    if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
        throw new SemanticHistoryError('invalid-argument', `${name} must be an integer from ${String(minimum)} through ${String(maximum)}`);
    }
    return result;
}
function splitsSurrogate(text, offset) {
    return offset > 0 && offset < text.length
        && text.charCodeAt(offset - 1) >= 0xD800 && text.charCodeAt(offset - 1) <= 0xDBFF
        && text.charCodeAt(offset) >= 0xDC00 && text.charCodeAt(offset) <= 0xDFFF;
}
function contentCharge(key, text) {
    return Math.max(Buffer.byteLength(text), text.length * 2) + key.length * 2 + 128;
}
function blockPreview(blocks) {
    let preview = '';
    for (const block of blocks) {
        if (block.type !== 'text' && block.type !== 'reasoning')
            continue;
        if (preview.length > 0)
            preview += '\n';
        preview += block.text.slice(0, 256 - preview.length);
        if (preview.length >= 256)
            break;
    }
    return preview;
}
function safePreview(text) {
    const last = text.charCodeAt(text.length - 1);
    return last >= 0xD800 && last <= 0xDBFF ? text.slice(0, -1) : text;
}
function* eventRange(events, start, end, signal) {
    for (let seq = start; seq <= end; seq += 1) {
        if ((seq & 4095) === 0)
            signal.throwIfAborted();
        const event = events[seq];
        if (event !== undefined)
            yield event;
    }
}
function coldIdentity(revision) {
    return `cold-${createHash('sha256').update(revision).digest('hex')}`;
}
/** Event interests declared by the existing Native domain reducers. */
function indexDependencies(index, event) {
    if (event.type === 'assistant/chunk') {
        if (index.lastMetricChunk === undefined)
            index.dependencies.turn.push(event.seq);
        index.lastMetricChunk = event.seq;
        if (event.data.chunk.type === 'finish' && (event.data.chunk.reason.kind === 'error' || event.data.chunk.reason.kind === 'aborted')) {
            if (index.dependencies.turn.at(-1) !== event.seq)
                index.dependencies.turn.push(event.seq);
            index.lastMetricChunk = undefined;
        }
    }
    else {
        if (index.lastMetricChunk !== undefined && index.dependencies.turn.at(-1) !== index.lastMetricChunk) {
            index.dependencies.turn.push(index.lastMetricChunk);
        }
        index.lastMetricChunk = undefined;
    }
    switch (event.type) {
        case 'turn/start':
        case 'turn/end':
            index.dependencies.tool.push(event.seq);
            index.dependencies.status.push(event.seq);
            index.dependencies.turn.push(event.seq);
            break;
        case 'tool/call':
        case 'tool/result':
        case 'tool/code-dispatch-start':
        case 'tool/code-dispatch':
        case 'tool-workflow/run-start':
        case 'tool-workflow/agent-start':
        case 'tool-workflow/agent-end':
        case 'tool-workflow/run-end':
            index.dependencies.tool.push(event.seq);
            break;
        case 'assistant/message':
            index.dependencies.status.push(event.seq);
            index.dependencies.turn.push(event.seq);
            break;
        case 'step/start':
        case 'step/end':
            index.dependencies.turn.push(event.seq);
            break;
        case 'command/run':
        case 'command/done':
        case 'compaction/start':
        case 'compaction/summary':
        case 'compaction/end':
        case 'user/message':
        case 'request/context':
        case 'request/header':
        case 'llm/retry':
        case 'llm/retry-started':
            index.dependencies.status.push(event.seq);
            break;
        default: break;
    }
}
/** Check relationship presence; domain rendering remains with the existing consumer. */
function missingDependencies(events) {
    const missing = new Set();
    const calls = new Set();
    const dispatches = new Set();
    const workflows = new Set();
    const members = new Set();
    const commands = new Set();
    const compactions = new Set();
    const turns = new Set();
    for (const event of events) {
        switch (event.type) {
            case 'turn/start':
                turns.add(event.data.turn);
                break;
            case 'turn/end':
                if (!turns.has(event.data.turn))
                    missing.add('turn-start');
                break;
            case 'tool/call':
                calls.add(event.data.callId);
                break;
            case 'tool/result':
                if (!calls.has(event.data.message.source.callId))
                    missing.add('parent-call');
                break;
            case 'tool/code-dispatch-start':
            case 'tool/code-dispatch':
                if (!calls.has(event.data.rootCallId) || (event.data.parentCallId !== event.data.rootCallId && !dispatches.has(event.data.parentCallId)))
                    missing.add('parent-call');
                if (event.type === 'tool/code-dispatch-start')
                    dispatches.add(event.data.subCallId);
                else if (!dispatches.has(event.data.subCallId))
                    missing.add('dispatch-start');
                break;
            case 'tool-workflow/run-start':
                workflows.add(event.data.runId);
                break;
            case 'tool-workflow/agent-start':
                if (!workflows.has(event.data.runId))
                    missing.add('workflow-start');
                members.add(`${event.data.runId}:${String(event.data.seq)}`);
                break;
            case 'tool-workflow/agent-end':
                if (!members.has(`${event.data.runId}:${String(event.data.seq)}`))
                    missing.add('workflow-member');
                break;
            case 'tool-workflow/run-end':
                if (!workflows.has(event.data.runId))
                    missing.add('workflow-start');
                break;
            case 'command/run':
                commands.add(event.data.commandId);
                break;
            case 'command/done':
                if (!commands.has(event.data.commandId))
                    missing.add('command-start');
                break;
            case 'compaction/start':
                compactions.add(event.data.compactionId);
                break;
            case 'compaction/summary':
            case 'compaction/end':
                if (!compactions.has(event.data.compactionId))
                    missing.add('compaction-start');
                break;
            default: break;
        }
    }
    return [...missing];
}
//# sourceMappingURL=semantic-history.js.map