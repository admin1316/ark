import { AssistantStreamAccumulator } from '@deepseek-ai/dsh-llm';
import { SessionFormatUnsupportedMigrationError, defineSessionFormatMigration, sessionFormatCount, } from '@deepseek-ai/dsh-session-format';
import { RELEASED_V0_EVENT_DISPOSITIONS, assertReleasedEventPayload, assertReleasedV1Header, isReleasedAssistantChunkRun, } from '@deepseek-ai/dsh-session-format-v0-to-v1';
import { assertReleasedV2Header } from "./validation.js";
const CHUNK_EVENT_REQUIRED = ['type', 'seq', 'time', 'data'];
const CHUNK_EVENT_OPTIONAL = ['ignorable', 'sourceEventSeqs', 'surfaceOp'];
const CHUNK_EVENT_KEYS = new Set([...CHUNK_EVENT_REQUIRED, ...CHUNK_EVENT_OPTIONAL]);
/** Adjacent migration that embeds released-v1 top-level Assistant chunks into v2 attempt events. */
export const sessionFormatV1ToV2 = defineSessionFormatMigration({
    name: '@deepseek-ai/dsh-session-format-v1-to-v2',
    fromVersion: 1,
    toVersion: 2,
    migrateHeader(header) {
        assertReleasedV1Header(header);
        return { ...header, version: 2 };
    },
    createStage(input) {
        return input.sourceKind === 'decoded'
            ? new DecodedReleasedV1ToV2Stage(input)
            : new TransformedReleasedV1ToV2Stage(input);
    },
    validateTargetHeader: assertReleasedV2Header,
});
class TransformedReleasedV1ToV2Stage {
    state;
    constructor(input) {
        assertReleasedV1Header(input.sourceHeader);
        this.state = {
            sourceHeader: input.sourceHeader,
            sourceCut: sessionFormatCount(input.sourceInheritedEventCount, 'format v1 inherited event count'),
            mapping: new Map(),
            legacyTurns: legacyTurnState(),
            pending: undefined,
            targetSeq: 0,
            targetCut: input.sourceHeader.isSeeded ? undefined : 0,
            lastTime: input.sourceHeader.createdAt,
        };
    }
    transformEvent(event, context) {
        transformReleasedEvent(this.state, event, context);
    }
    transformRun(run, context) {
        transformReleasedRun(this.state, run, context);
    }
    finish(context) {
        return finishMigration(this.state, context);
    }
}
class DecodedReleasedV1ToV2Stage extends TransformedReleasedV1ToV2Stage {
    transformEvent(event, context) {
        if (event.type !== 'assistant/chunk'
            && RELEASED_V0_EVENT_DISPOSITIONS[event.type] !== undefined) {
            assertReleasedEventPayload(event, 1);
        }
        super.transformEvent(event, context);
    }
}
function transformReleasedEvent(state, event, context) {
    if (event.type === 'assistant/chunk')
        assertChunkEnvelope(event);
    if (RELEASED_V0_EVENT_DISPOSITIONS[event.type] === undefined) {
        throw refusal(`format v1 contains unknown event type ${JSON.stringify(event.type)} at seq ${event.seq}`);
    }
    const interrupted = legacyInterruptedTurn(state.legacyTurns, event);
    if (event.type === 'turn/start' && state.legacyTurns.openTurn !== null && interrupted === undefined) {
        throw refusal(`turn/start ${JSON.stringify(record(event.data)['turn'])} does not close the prior turn`);
    }
    assertSourceDeliveryMarker(state, event);
    observeLegacyTurn(state.legacyTurns, event);
    state.lastTime = event.time;
    if (interrupted !== undefined) {
        finishAttempt(state, context);
        emitGenerated(state, event.seq, interrupted, context);
    }
    const legacyGoal = splitLegacyGoalChange(event);
    if (legacyGoal !== undefined) {
        emitGenerated(state, event.seq, legacyGoal.change, context);
        emitSource(state, legacyGoal.message, context);
        return;
    }
    if (event.type === 'assistant/chunk') {
        transformChunk(state, event, context);
        return;
    }
    if (event.type === 'assistant/message') {
        transformMessage(state, event, context);
        return;
    }
    if (closesAttempt(event)) {
        finishAttempt(state, context);
        emitSource(state, event, context);
        return;
    }
    if (state.pending !== undefined) {
        state.pending.afterLastChunk.push(event);
        return;
    }
    emitSource(state, event, context);
}
function assertChunkEnvelope(event) {
    const unexpected = Object.keys(event).find(key => !CHUNK_EVENT_KEYS.has(key));
    if (unexpected !== undefined)
        throw refusal(`assistant/chunk ${event.seq} has unexpected member ${unexpected}`);
    const missing = CHUNK_EVENT_REQUIRED.find(key => !Object.hasOwn(event, key));
    if (missing !== undefined)
        throw refusal(`assistant/chunk ${event.seq} lacks required member ${missing}`);
    if (event.ignorable !== undefined && event.ignorable !== true) {
        throw refusal(`assistant/chunk ${event.seq} ignorable must be true when present`);
    }
}
function assertSourceDeliveryMarker(state, event) {
    if (event.type !== 'session-log-deepseek/delivery-accepted')
        return;
    const data = record(event.data);
    const inherited = state.sourceHeader.parentSession !== undefined && event.seq < state.sourceCut;
    if (data['sessionFormatVersion'] === 1 && !inherited && data['sessionId'] !== state.sourceHeader.id) {
        throw refusal('current-generation delivery marker names the wrong Session');
    }
}
function transformReleasedRun(state, run, context) {
    if (!isReleasedAssistantChunkRun(run)) {
        for (const event of run.expand())
            transformReleasedEvent(state, event, context);
        return;
    }
    state.legacyTurns.previous = undefined;
    state.lastTime = run.lastTime;
    if (state.pending !== undefined
        && (state.pending.group.terminal
            || state.pending.group.turn !== run.turn
            || state.pending.group.step !== run.step)) {
        finishAttempt(state, context);
    }
    else if (state.pending !== undefined) {
        flushBuffered(state, state.pending, context);
    }
    state.pending ??= { group: attemptGroup(run.turn, run.step), afterLastChunk: [] };
    assertAttemptRange(state, run.firstSeq, run.lastSeq);
    flushAccumulator(state.pending.group);
    appendStreamRecord(state.pending.group, run.stream, run.lastTime);
    recordChunkSpan(state.pending.group, run.firstSeq, run.eventCount, run.lastTime);
}
function finishMigration(state, context) {
    finishAttempt(state, context);
    if (state.sourceHeader.isSeeded && state.targetCut === undefined) {
        state.targetCut = state.targetSeq;
        context.emitEvent({
            type: 'session/end-seed',
            seq: state.targetSeq,
            time: state.lastTime,
            data: { inherited: true },
        });
        state.targetSeq += 1;
    }
    return state.targetCut;
}
function transformChunk(state, event, context) {
    const data = record(event.data);
    const turn = coordinate(data['turn']);
    const step = coordinate(data['step']);
    const chunk = record(data['chunk']);
    if (state.pending !== undefined
        && (state.pending.group.terminal
            || state.pending.group.turn !== turn
            || state.pending.group.step !== step)) {
        finishAttempt(state, context);
    }
    else if (state.pending !== undefined) {
        flushBuffered(state, state.pending, context);
    }
    state.pending ??= { group: attemptGroup(turn, step), afterLastChunk: [] };
    assertAttemptCut(state, state.pending.group, event.seq);
    state.pending.group.accumulator ??= new AssistantStreamAccumulator();
    state.pending.group.accumulator.push({
        time: event.time,
        chunk: data['chunk'],
    });
    recordChunkSpan(state.pending.group, event.seq, 1, event.time);
    if (chunk['type'] === 'finish')
        state.pending.group.terminal = true;
}
function transformMessage(state, event, context) {
    const data = record(event.data);
    const turn = coordinate(data['turn']);
    const step = coordinate(data['step']);
    const sources = event.sourceEventSeqs;
    const pending = state.pending;
    if (pending !== undefined && (pending.group.turn !== turn || pending.group.step !== step)) {
        finishAttempt(state, context);
        emitSource(state, messageEvent(event, attemptGroup(turn, step)), context);
        return;
    }
    if (!Array.isArray(sources)) {
        if (pending !== undefined) {
            throw refusal(`assistant/message ${event.seq} does not cite its complete v1 chunk attempt`);
        }
        emitSource(state, messageEvent(event, attemptGroup(turn, step)), context);
        return;
    }
    if (sources.length === 0) {
        finishAttempt(state, context);
        emitSource(state, messageEvent(event, attemptGroup(turn, step)), context);
        return;
    }
    if (pending === undefined
        || !matchesChunkSources(pending.group, sources)) {
        throw refusal(`assistant/message ${event.seq} chunk provenance is not one complete ordered attempt`);
    }
    assertAttemptCut(state, pending.group, event.seq);
    pending.group.terminal = true;
    flushBuffered(state, pending, context);
    emitSource(state, messageEvent(event, pending.group), context);
    state.pending = undefined;
}
function finishAttempt(state, context) {
    const pending = state.pending;
    if (pending === undefined)
        return;
    emitGenerated(state, pending.group.lastChunkSeq, attemptEvent(pending.group), context);
    flushBuffered(state, pending, context);
    state.pending = undefined;
}
function flushBuffered(state, pending, context) {
    for (const event of pending.afterLastChunk)
        emitSource(state, event, context);
    pending.afterLastChunk.length = 0;
}
function emitSource(state, event, context) {
    let source = event;
    if (state.sourceHeader.isSeeded
        && event.seq === state.sourceCut
        && event.type === 'session/end-seed') {
        source = { ...event, data: { inherited: true } };
    }
    ensureTargetCut(state, event.seq, event.time, source.type, context);
    state.mapping.set(event.seq, state.targetSeq);
    context.emitEvent(remapReferences(source, state.targetSeq, state.mapping));
    state.targetSeq += 1;
}
function emitGenerated(state, origin, event, context) {
    ensureTargetCut(state, origin, event.time, event.type, context);
    context.emitEvent(remapReferences(event, state.targetSeq, state.mapping));
    state.targetSeq += 1;
}
function ensureTargetCut(state, origin, time, type, context) {
    if (!state.sourceHeader.isSeeded || state.targetCut !== undefined || origin < state.sourceCut)
        return;
    state.targetCut = state.targetSeq;
    if (origin === state.sourceCut && type === 'session/end-seed')
        return;
    context.emitEvent({
        type: 'session/end-seed',
        seq: state.targetSeq,
        time,
        data: { inherited: true },
    });
    state.targetSeq += 1;
}
function assertAttemptCut(state, group, member) {
    const first = group.spans[0]?.firstSeq ?? member;
    if ((first < state.sourceCut) !== (member < state.sourceCut)) {
        throw refusal(`inherited Session cut ${state.sourceCut} splits one Assistant attempt`);
    }
}
function assertAttemptRange(state, first, last) {
    if ((first < state.sourceCut) !== (last < state.sourceCut)) {
        throw refusal(`inherited Session cut ${state.sourceCut} splits one Assistant attempt`);
    }
}
function legacyTurnState() {
    return { openTurn: null, openStep: null, previous: undefined };
}
function legacyInterruptedTurn(state, event) {
    if (event.type !== 'turn/start' || state.openTurn === null || state.openStep !== null
        || coordinate(record(event.data)['turn']) !== state.openTurn + 1
        || state.previous?.type !== 'agent/inbox/spliced')
        return undefined;
    const splice = record(state.previous.data);
    if (splice['target'] !== 'next-turn' || !Array.isArray(splice['inserted']) || splice['inserted'].length === 0) {
        return undefined;
    }
    return {
        type: 'turn/end',
        seq: event.seq,
        time: event.time,
        data: { turn: state.openTurn, reason: { kind: 'interrupted' } },
    };
}
function observeLegacyTurn(state, event) {
    const data = record(event.data);
    if (event.type === 'turn/start') {
        state.openTurn = coordinate(data['turn']);
        state.openStep = null;
    }
    else if (event.type === 'turn/end') {
        state.openTurn = null;
        state.openStep = null;
    }
    else if (event.type === 'step/start') {
        state.openStep = coordinate(data['step']);
    }
    else if (event.type === 'step/end') {
        state.openStep = null;
    }
    state.previous = event;
}
function splitLegacyGoalChange(event) {
    if (event.type !== 'user/message')
        return undefined;
    const data = record(event.data);
    const source = record(data['source']);
    if (source['kind'] !== 'goal' || source['change'] === undefined)
        return undefined;
    return {
        change: {
            type: 'goal/change',
            seq: event.seq,
            time: event.time,
            data: source['change'],
        },
        message: {
            ...event,
            data: { ...data, source: { kind: 'plugin', plugin: 'goal' } },
        },
    };
}
function closesAttempt(event) {
    return event.type === 'turn/end'
        || event.type === 'step/end'
        || event.type === 'llm/retry'
        || event.type === 'llm/retry-started';
}
function attemptGroup(turn, step) {
    return { turn, step, spans: [], stream: [], chunkCount: 0, terminal: false };
}
function recordChunkSpan(group, firstSeq, eventCount, lastTime) {
    const previous = group.spans.at(-1);
    if (previous !== undefined && previous.firstSeq + previous.eventCount === firstSeq) {
        previous.eventCount += eventCount;
    }
    else {
        group.spans.push({ firstSeq, eventCount });
    }
    group.chunkCount += eventCount;
    group.lastChunkSeq = firstSeq + eventCount - 1;
    group.lastChunkTime = lastTime;
}
function matchesChunkSources(group, sources) {
    if (sources.length !== group.chunkCount)
        return false;
    let index = 0;
    for (const span of group.spans) {
        for (let offset = 0; offset < span.eventCount; offset += 1) {
            if (sources[index] !== span.firstSeq + offset)
                return false;
            index += 1;
        }
    }
    return true;
}
function recordLastTime(record) {
    if (record.type === 'chunk')
        return record.time;
    return record.dt.reduce((time, gap) => time + gap, record.time0);
}
function mutableRecord(record) {
    if (record.type === 'chunk')
        return record;
    if (record.type === 'tool-call-chunks') {
        return { ...record, dt: [...record.dt], args: [...record.args] };
    }
    return { ...record, dt: [...record.dt], texts: [...record.texts] };
}
function appendStreamRecord(group, source, lastTime, owned = true) {
    const previous = group.stream.at(-1);
    if (previous === undefined || source.type === 'chunk' || previous.record.type !== source.type) {
        group.stream.push({ record: owned ? source : mutableRecord(source), lastTime });
        return;
    }
    const gap = source.time0 - previous.lastTime;
    if (previous.record.index !== source.index || !Number.isSafeInteger(gap)) {
        group.stream.push({ record: owned ? source : mutableRecord(source), lastTime });
        return;
    }
    if (source.type === 'tool-call-chunks') {
        const target = previous.record;
        if (target.id !== source.id || target.name !== source.name) {
            group.stream.push({ record: owned ? source : mutableRecord(source), lastTime });
            return;
        }
        ;
        target.dt.push(gap);
        for (const value of source.dt)
            target.dt.push(value);
        for (const value of source.args)
            target.args.push(value);
    }
    else {
        const target = previous.record;
        target.dt.push(gap);
        for (const value of source.dt)
            target.dt.push(value);
        for (const value of source.texts)
            target.texts.push(value);
    }
    previous.lastTime = lastTime;
}
function flushAccumulator(group) {
    const accumulator = group.accumulator;
    if (accumulator === undefined)
        return;
    for (const record of accumulator.snapshot()) {
        appendStreamRecord(group, record, recordLastTime(record), false);
    }
    delete group.accumulator;
}
function streamOf(group) {
    flushAccumulator(group);
    return group.stream.map(({ record }) => record);
}
function messageEvent(source, group) {
    const data = record(source.data);
    const { sourceEventSeqs: _sourceEventSeqs, ...event } = source;
    return {
        ...event,
        data: { ...data, stream: streamOf(group) },
    };
}
function attemptEvent(group) {
    return {
        type: 'assistant/attempt',
        seq: group.lastChunkSeq,
        time: group.lastChunkTime,
        data: { turn: group.turn, step: group.step, stream: streamOf(group) },
    };
}
function remapReferences(source, targetSeq, mapping) {
    const { sourceEventSeqs, surfaceOp, ...event } = source;
    const sources = sourceEventSeqs === undefined
        ? {}
        : {
            sourceEventSeqs: mapList(numberArray(sourceEventSeqs), mapping, `${source.type} ${source.seq} sources`),
        };
    let operation = surfaceOp;
    if (surfaceOp !== undefined && surfaceOp !== 'append') {
        const replacement = record(surfaceOp);
        operation = {
            op: 'replace',
            start: mapOne(coordinate(replacement['start']), mapping, `${source.type} ${source.seq} surface start`),
            end: mapOne(coordinate(replacement['end']), mapping, `${source.type} ${source.seq} surface end`),
        };
    }
    return {
        ...event,
        seq: targetSeq,
        data: remapPayloadReferences(source, mapping),
        ...sources,
        ...(operation === undefined ? {} : { surfaceOp: operation }),
    };
}
function remapPayloadReferences(event, mapping) {
    const data = record(event.data);
    switch (event.type) {
        case 'command/done':
            return data['sourceEventSeq'] === undefined
                ? data
                : {
                    ...data,
                    sourceEventSeq: mapOne(coordinate(data['sourceEventSeq']), mapping, `command/done ${event.seq} sourceEventSeq`),
                };
        case 'compaction/prune':
        case 'compaction/summary': {
            const range = record(data['shadowedRange']);
            return {
                ...data,
                shadowedRange: {
                    start: mapOne(coordinate(range['start']), mapping, `${event.type} ${event.seq} shadowedRange start`),
                    end: mapOne(coordinate(range['end']), mapping, `${event.type} ${event.seq} shadowedRange end`),
                },
                shadowedSeqs: mapList(numberArray(data['shadowedSeqs']), mapping, `${event.type} ${event.seq} shadowedSeqs`),
            };
        }
        case 'session/title':
        case 'session/title-llm-request':
            return {
                ...data,
                messageSeqs: mapList(numberArray(data['messageSeqs']), mapping, `${event.type} ${event.seq} messageSeqs`),
            };
        default:
            return data;
    }
}
function mapList(values, mapping, label) {
    return values.map(value => mapOne(value, mapping, label));
}
function mapOne(value, mapping, label) {
    const mapped = mapping.get(value);
    if (mapped === undefined)
        throw refusal(`${label} targets consumed assistant/chunk ${value}`);
    return mapped;
}
function record(value) {
    return value;
}
function numberArray(value) {
    return value;
}
function coordinate(value) {
    return value;
}
function refusal(message) {
    return new SessionFormatUnsupportedMigrationError(message);
}
//# sourceMappingURL=migration.js.map