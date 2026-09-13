import { matchesOwnKeyPattern } from '@deepseek-ai/dsh-util-values';
import { SessionFormatError, SessionFormatUnsupportedMigrationError, defineSessionFormatMigration, sessionFormatCount, } from '@deepseek-ai/dsh-session-format';
import { isReleasedAssistantChunkRun } from "./codec.js";
import { assertReleasedEventPayload, assertReleasedV1Header, } from "./validation.js";
import { assertReleasedV0Keys, releasedV0Record } from "./validation-helpers.js";
/** Identity format edge that promotes released v0 into released v1. */
export const sessionFormatV0ToV1 = defineSessionFormatMigration({
    name: '@deepseek-ai/dsh-session-format-v0-to-v1',
    fromVersion: 0,
    toVersion: 1,
    migrateHeader(header) {
        assertHeaderVersion(header, 0);
        return { ...header, version: 1 };
    },
    createStage(input) {
        return new ReleasedV0ToV1Stage(input);
    },
    validateTargetHeader: assertReleasedV1Header,
});
class ReleasedV0ToV1Stage {
    input;
    headerInheritedEventCount;
    state = { messageIds: new Map(), retryIds: new Map() };
    constructor(input) {
        this.input = input;
        assertHeaderVersion(input.sourceHeader, 0);
        this.headerInheritedEventCount = sessionFormatCount(input.sourceInheritedEventCount, 'format v0 inherited event count');
    }
    transformEvent(event, context) {
        const normalized = normalizeReleasedV0Event(event, this.input.sourceHeader.id, this.state);
        assertSourceDeliveryMarker(normalized, this.input);
        context.emitEvent(normalized);
    }
    transformRun(run, context) {
        if (isReleasedAssistantChunkRun(run)) {
            context.emitRun(run);
            return;
        }
        for (const event of run.expand())
            this.transformEvent(event, context);
    }
    finish(_context) {
        return this.headerInheritedEventCount;
    }
}
function assertHeaderVersion(header, version) {
    if (header.version !== version)
        throw new SessionFormatError(`expected format v${version} header`);
}
function normalizeReleasedV0Event(event, sessionId, state) {
    const named = normalizeLegacyCompactionType(event);
    assertSupportedLegacyType(named, sessionId);
    const start = normalizeLegacyTurnStart(named, sessionId);
    const end = normalizeLegacyTurnEnd(start, sessionId);
    const header = normalizeLegacyRequestHeader(end, sessionId);
    const steering = normalizeLegacySteering(header, sessionId);
    const retry = normalizeLegacyRetry(steering, sessionId, state.retryIds);
    const compaction = normalizeLegacyCompaction(retry, sessionId, state);
    const message = normalizeLegacyMessage(compaction, sessionId, state.messageIds);
    if (message.type !== 'assistant/chunk')
        assertReleasedEventPayload(message, 0);
    const messageId = eventMessageId(message);
    if (messageId !== undefined)
        state.messageIds.set(message.seq, messageId);
    return message;
}
function normalizeLegacyCompactionType(event) {
    const type = event.type;
    switch (type) {
        case 'compact/start':
            return { ...event, type: 'compaction/start' };
        case 'compact/summary':
            return { ...event, type: 'compaction/summary' };
        case 'compact/end':
            return { ...event, type: 'compaction/end' };
        case 'compact/prune':
            return { ...event, type: 'compaction/prune' };
        default:
            return event;
    }
}
function assertSourceDeliveryMarker(event, input) {
    if (event.type !== 'session-log-deepseek/delivery-accepted')
        return;
    const data = releasedV0Record(event.data, `${event.type} ${event.seq} data`);
    const acceptedVersion = data['sessionFormatVersion'] ?? 0;
    const inherited = input.sourceHeader.parentSession !== undefined
        && event.seq < sessionFormatCount(input.sourceInheritedEventCount, 'format v0 inherited event count');
    if (acceptedVersion === 0 && !inherited && data['sessionId'] !== input.sourceHeader.id) {
        throw new SessionFormatError('current-generation delivery marker names the wrong Session');
    }
}
function normalizeLegacyRetry(event, sessionId, retryIds) {
    if (event.type !== 'llm/retry')
        return event;
    const data = releasedV0Record(event.data, `llm/retry ${event.seq} data`);
    const chain = [data['turn'], data['step'], data['provider'], data['policyKey']]
        .map(value => JSON.stringify(value))
        .join('\0');
    const retryId = data['retryId'];
    if (typeof retryId === 'string' && retryId.length > 0) {
        retryIds.set(chain, retryId);
        return event;
    }
    if (Object.hasOwn(data, 'retryId'))
        return event;
    const migratedRetryId = retryIds.get(chain) ?? `legacy-retry:${sessionId}:${event.seq}`;
    retryIds.set(chain, migratedRetryId);
    return { ...event, data: { ...data, retryId: migratedRetryId } };
}
function normalizeLegacyCompaction(event, sessionId, state) {
    if (event.type === 'session/end-seed') {
        delete state.compactionId;
        return event;
    }
    if (event.type === 'compaction/start') {
        const data = releasedV0Record(event.data, `compaction/start ${event.seq} data`);
        const existing = data['compactionId'];
        if (typeof existing === 'string' && existing.length > 0) {
            state.compactionId = existing;
            return event;
        }
        if (Object.hasOwn(data, 'compactionId'))
            return event;
        const id = `legacy-compaction:${sessionId}:${event.seq}`;
        state.compactionId = id;
        return { ...event, data: { ...data, compactionId: id } };
    }
    const compactionId = state.compactionId;
    if (compactionId === undefined)
        return event;
    if (event.type === 'compaction/summary' || event.type === 'compaction/end') {
        const normalized = addLegacyCompactionId(event, compactionId);
        if (event.type === 'compaction/end')
            delete state.compactionId;
        return normalized;
    }
    if (event.type !== 'user/message')
        return event;
    const data = releasedV0Record(event.data, `user/message ${event.seq} data`);
    const source = data['source'];
    if (!releasedIsRecord(source) || source['kind'] !== 'plugin' || source['plugin'] !== 'compact'
        || Object.hasOwn(source, 'compactionId'))
        return event;
    return {
        ...event,
        data: {
            ...data,
            source: {
                ...source,
                compactionId,
            },
        },
    };
}
function addLegacyCompactionId(event, compactionId) {
    const data = releasedV0Record(event.data, `${event.type} ${event.seq} data`);
    if (Object.hasOwn(data, 'compactionId'))
        return event;
    return { ...event, data: { ...data, compactionId } };
}
function normalizeLegacyRequestHeader(event, sessionId) {
    if (event.type !== 'request/header')
        return event;
    const data = releasedV0Record(event.data, `request/header ${event.seq} data`);
    const header = releasedV0Record(data['header'], `request/header ${event.seq} header`);
    if (!Object.hasOwn(header, 'messagePrefix'))
        return event;
    if (!Array.isArray(header['messagePrefix'])) {
        throw new SessionFormatError(`session ${JSON.stringify(sessionId)} contains malformed request/header messagePrefix at seq ${event.seq}`);
    }
    const { messagePrefix: _messagePrefix, ...currentHeader } = header;
    return { ...event, data: { ...data, header: currentHeader } };
}
function assertSupportedLegacyType(event, sessionId) {
    if (event.type === 'request/header-delta' || event.type === 'mode/set') {
        throw new SessionFormatUnsupportedMigrationError(`session ${JSON.stringify(sessionId)} contains unsupported legacy ${event.type} event at seq ${event.seq}`);
    }
    if (event.type === 'request/header') {
        const data = releasedV0Record(event.data, `request/header ${event.seq} data`);
        if (data['reason'] === 'fallback') {
            throw new SessionFormatUnsupportedMigrationError(`session ${JSON.stringify(sessionId)} contains unsupported request/header reason "fallback" at seq ${event.seq}`);
        }
    }
}
function normalizeLegacySteering(event, sessionId) {
    if (event.type !== 'steering/message')
        return event;
    const data = releasedV0Record(event.data, `steering/message ${event.seq} data`);
    const wrapped = data['message'];
    if (wrapped !== undefined) {
        assertReleasedV0Keys(data, ['turn', 'message'], [], `steering/message ${event.seq} data`);
        sessionFormatCount(data['turn'], `steering/message ${event.seq} turn`);
        return { ...event, type: 'user/message', data: wrapped };
    }
    assertReleasedV0Keys(data, ['turn', 'content', 'source'], [], `steering/message ${event.seq} data`);
    sessionFormatCount(data['turn'], `steering/message ${event.seq} turn`);
    const { turn: _turn, ...message } = data;
    return {
        ...event,
        type: 'user/message',
        data: {
            ...message,
            id: legacyMessageId(sessionId, event.seq),
            role: 'user',
        },
    };
}
function normalizeLegacyTurnStart(event, sessionId) {
    if (event.type !== 'turn/start')
        return event;
    const data = releasedV0Record(event.data, `turn/start ${event.seq} data`);
    if (!Object.hasOwn(data, 'trigger'))
        return event;
    assertReleasedV0Keys(data, ['turn', 'trigger'], [], `turn/start ${event.seq} data`);
    const turn = sessionFormatCount(data['turn'], `turn/start ${event.seq} turn`);
    const trigger = releasedV0Record(data['trigger'], `turn/start ${event.seq} trigger`);
    if (turn < 1 || typeof trigger['kind'] !== 'string' || trigger['kind'].length === 0) {
        throw malformedLegacy(sessionId, 'turn/start', event.seq);
    }
    return { ...event, data: { turn } };
}
function normalizeLegacyTurnEnd(event, sessionId) {
    if (event.type !== 'turn/end')
        return event;
    const data = releasedV0Record(event.data, `turn/end ${event.seq} data`);
    assertReleasedV0Keys(data, ['turn', 'reason'], [], `turn/end ${event.seq} data`);
    const turn = sessionFormatCount(data['turn'], `turn/end ${event.seq} turn`);
    if (turn < 1)
        throw malformedLegacy(sessionId, 'turn/end', event.seq);
    const reason = releasedV0Record(data['reason'], `turn/end ${event.seq} reason`);
    if (typeof reason['kind'] !== 'string')
        throw malformedLegacy(sessionId, 'turn/end', event.seq);
    let current;
    switch (reason['kind']) {
        case 'completed':
        case 'blocked':
        case 'max-tokens':
        case 'interrupted':
            assertReleasedV0Keys(reason, ['kind'], [], `turn/end ${event.seq} reason`);
            return event;
        case 'aborted':
            if (Object.hasOwn(reason, 'reason'))
                return event;
            assertReleasedV0Keys(reason, ['kind'], [], `turn/end ${event.seq} reason`);
            current = { kind: 'aborted', reason: { kind: 'legacy' } };
            break;
        case 'disposed':
            assertReleasedV0Keys(reason, ['kind'], [], `turn/end ${event.seq} reason`);
            current = { kind: 'aborted', reason: { kind: 'disposed' } };
            break;
        case 'error':
            if (Object.hasOwn(reason, 'error'))
                return event;
            current = normalizeLegacyErrorReason(reason, event.seq, sessionId);
            break;
        default:
            return event;
    }
    return { ...event, data: { ...data, reason: current } };
}
function normalizeLegacyErrorReason(reason, seq, sessionId) {
    sessionFormatCount(reason['step'], `turn/end ${seq} error step`);
    const failure = reason['failure'];
    if (failure !== undefined) {
        assertReleasedV0Keys(reason, ['kind', 'step', 'failure'], [], `turn/end ${seq} reason`);
        const record = releasedV0Record(failure, `turn/end ${seq} failure`);
        assertReleasedV0Keys(record, ['message', 'code'], ['status', 'providerRetryAfterMs', 'requestId'], `turn/end ${seq} failure`);
        if (typeof record['message'] !== 'string' || typeof record['code'] !== 'string') {
            throw malformedLegacy(sessionId, 'turn/end', seq);
        }
        return { kind: 'error', error: record };
    }
    assertReleasedV0Keys(reason, ['kind', 'step', 'message'], ['code'], `turn/end ${seq} reason`);
    if (typeof reason['message'] !== 'string'
        || (reason['code'] !== undefined && typeof reason['code'] !== 'string')) {
        throw malformedLegacy(sessionId, 'turn/end', seq);
    }
    return {
        kind: 'error',
        error: {
            message: reason['message'],
            code: typeof reason['code'] === 'string' ? reason['code'] : 'UNKNOWN',
        },
    };
}
function normalizeLegacyMessage(event, sessionId, messageIds) {
    const data = releasedV0Record(event.data, `${event.type} ${event.seq} data`);
    switch (event.type) {
        case 'user/message':
            if (!matchesOwnKeyPattern(data, ['content', 'source'], ['id', 'role', 'message']))
                return event;
            return {
                ...event,
                data: {
                    ...data,
                    id: legacyMessageId(sessionId, event.seq),
                    role: 'user',
                },
            };
        case 'assistant/message': {
            if (!matchesOwnKeyPattern(data, ['content', 'provenance'], ['message']))
                return event;
            const { content, provenance, ...eventData } = data;
            const source = releasedV0Record(provenance, `assistant/message ${event.seq} provenance`);
            return {
                ...event,
                data: {
                    ...eventData,
                    message: {
                        id: legacyMessageId(sessionId, event.seq),
                        role: 'assistant',
                        content,
                        source: { ...source, kind: 'model' },
                    },
                },
            };
        }
        case 'tool/result': {
            if (!matchesOwnKeyPattern(data, ['callId', 'content', 'isError'], ['message']))
                return event;
            const { callId, content, isError, ...eventData } = data;
            if (typeof callId !== 'string' || typeof isError !== 'boolean' || content === undefined)
                return event;
            const inheritedId = replacementStart(event);
            const messageId = inheritedId === undefined
                ? legacyMessageId(sessionId, event.seq)
                : messageIds.get(inheritedId);
            if (messageId === undefined) {
                throw new SessionFormatError(`tool/result ${event.seq} replacement cites a message without identity`);
            }
            return {
                ...event,
                data: {
                    ...eventData,
                    message: {
                        id: messageId,
                        role: 'user',
                        content: [{ type: 'tool-result', toolCallId: callId, content, isError }],
                        source: { kind: 'tool', callId },
                    },
                },
            };
        }
        default:
            return event;
    }
}
function replacementStart(event) {
    const operation = event['surfaceOp'];
    if (operation === undefined || !releasedIsRecord(operation) || operation['op'] !== 'replace')
        return undefined;
    // Source envelope validation admits only non-negative safe replacement endpoints.
    return operation['start'];
}
function eventMessageId(event) {
    const data = releasedV0Record(event.data, `${event.type} ${event.seq} data`);
    const message = event.type === 'user/message'
        ? data
        : releasedIsRecord(data['message']) ? data['message'] : undefined;
    return typeof message?.['id'] === 'string' ? message['id'] : undefined;
}
function releasedIsRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function legacyMessageId(sessionId, seq) {
    return `legacy-message:${sessionId}:${seq}`;
}
function malformedLegacy(sessionId, type, seq) {
    return new SessionFormatError(`session ${JSON.stringify(sessionId)} contains malformed pre-react-loop ${type} at seq ${seq}`);
}
//# sourceMappingURL=migration.js.map