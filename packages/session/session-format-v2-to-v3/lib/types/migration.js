/** Streaming system-prompt promotion followed by canonical V3 envelope conversion. */
import { createHash } from 'node:crypto';
import { SessionFormatError, SessionFormatUnsupportedMigrationError, defineSessionFormatMigration, sessionFormatCount } from '@deepseek-ai/dsh-session-format';
import { assertReleasedV2Header } from '@deepseek-ai/dsh-session-format-v1-to-v2';
import { assertEvent, canonicalizeTransformedEvent, record, SURFACE_TYPES } from "./payload.js";
import { remapEvent } from "./references.js";
import { assertReleasedV3Header } from "./validation.js";
/** Promote system prompts, remap audited references, and canonicalize envelopes and PTC vocabulary. */
export const sessionFormatV2ToV3 = defineSessionFormatMigration({
    name: '@deepseek-ai/dsh-session-format-v2-to-v3',
    fromVersion: 2,
    toVersion: 3,
    migrateHeader(header) {
        assertReleasedV2Header(header);
        return { ...header, version: 3, ...(header.agentPreset === 'code' ? { agentPreset: 'ptc' } : {}) };
    },
    createStage(input) { return new ReleasedV2ToV3Stage(input); },
    validateTargetHeader: assertReleasedV3Header,
});
class ReleasedV2ToV3Stage {
    input;
    headerInheritedEventCount;
    mapping = [];
    originalIds = new Set();
    generatedIds = new Set();
    targetSeq = 0;
    sourceCut;
    targetCut;
    lastForeignDeliverySeq;
    step;
    head;
    prompt = '';
    constructor(input) {
        this.input = input;
        assertReleasedV2Header(input.sourceHeader);
        this.sourceCut = input.sourceHeader.isSeeded ? undefined : 0;
        this.targetCut = input.sourceHeader.isSeeded ? undefined : 0;
        if (!input.sourceHeader.isSeeded)
            this.headerInheritedEventCount = 0;
    }
    transformEvent(event, context) {
        if (event.seq !== this.mapping.length)
            throw new SessionFormatError('format v2 source events must be dense');
        assertEvent(event, 2);
        this.observeMessageIds(event);
        let source = event;
        const data = record(event.data, event.type);
        if (event.type === 'request/header') {
            const { system, ...header } = record(data['header'], 'request header');
            const prompt = typeof system === 'string' ? system : '';
            if (prompt !== this.prompt)
                this.emitSystem(prompt, event, context);
            source = { ...event, data: { ...data, header } };
        }
        if (SURFACE_TYPES.has(event.type) && this.head === undefined) {
            throw new SessionFormatUnsupportedMigrationError('format v2 surface before first step cannot acquire a system head without changing chronology');
        }
        if (event.type === 'session/end-seed' && data['inherited'] === true) {
            if (!this.input.sourceHeader.isSeeded)
                throw new SessionFormatError('format v2 unseeded Session contains an inherited end-seed marker');
            this.sourceCut = event.seq;
            this.targetCut = this.targetSeq;
        }
        if (event.type === 'session-log-deepseek/delivery-accepted') {
            if (data['sessionFormatVersion'] === 3)
                throw new SessionFormatError('format v2 delivery marker claims target format v3');
            if (data['sessionFormatVersion'] === 2 && data['sessionId'] !== this.input.sourceHeader.id)
                this.lastForeignDeliverySeq = event.seq;
        }
        const target = remapEvent(source, this.targetSeq, this.mapping);
        this.mapping.push(this.targetSeq++);
        context.emitEvent(canonicalizeTransformedEvent(renamePtcEvent(target)));
        if (event.type === 'step/start') {
            this.step = { turn: data['turn'], step: data['step'] };
            if (this.head === undefined)
                this.emitSystem('', event, context);
        }
        else if (event.type === 'step/end' || event.type === 'turn/end') {
            this.step = undefined;
        }
    }
    transformRun(run, context) {
        for (const event of run.expand())
            this.transformEvent(event, context);
    }
    finish(_context) {
        const cut = sessionFormatCount(this.sourceCut, 'format v2 inherited end-seed marker');
        if (this.input.sourceInheritedEventCount !== undefined && this.input.sourceInheritedEventCount !== cut) {
            throw new SessionFormatError('format v2 inherited end-seed marker disagrees with its source cut');
        }
        if (this.lastForeignDeliverySeq !== undefined
            && (this.input.sourceHeader.parentSession === undefined || this.lastForeignDeliverySeq >= cut)) {
            throw new SessionFormatError('current-generation delivery marker names the wrong Session');
        }
        return sessionFormatCount(this.targetCut, 'format v3 inherited event count');
    }
    observeMessageIds(event) {
        const data = record(event.data, event.type);
        const messages = event.type === 'user/message' ? [data]
            : event.type === 'assistant/message' || event.type === 'tool/result' ? [record(data['message'], 'message')]
                : event.type === 'agent/inbox/spliced' ? data['inserted']
                    : event.type === 'session/title-llm-request' ? data['messages'] : [];
        // assertEvent validates every owned message before identity observation.
        for (const message of messages) {
            const id = message['id'];
            if (this.generatedIds.has(id))
                throw new SessionFormatUnsupportedMigrationError('source message id collides with a generated system message id');
            this.originalIds.add(id);
        }
    }
    emitSystem(prompt, anchor, context) {
        if (this.step === undefined) {
            throw new SessionFormatUnsupportedMigrationError('format v2 changed request prompt outside an open step cannot retain source chronology');
        }
        const identity = JSON.stringify(['session-format-v2-to-v3', this.input.sourceHeader.id, anchor.seq, anchor.type]);
        const id = 'v2-to-v3-system-' + createHash('sha256').update(identity).digest('hex');
        if (this.originalIds.has(id) || this.generatedIds.has(id)) {
            throw new SessionFormatUnsupportedMigrationError('generated system message id collides with an existing message id');
        }
        this.generatedIds.add(id);
        const seq = this.targetSeq++;
        context.emitEvent(canonicalizeTransformedEvent({
            type: 'system/message', seq, time: anchor.time,
            data: {
                ...this.step,
                message: {
                    id,
                    role: 'system', source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' },
                    content: prompt === '' ? [] : [{ type: 'text', text: prompt }],
                },
            },
            ...(this.head === undefined
                ? { surfaceOp: 'append' }
                : { surfaceOp: { op: 'replace', start: this.head, end: this.head }, sourceEventSeqs: [this.head] }),
        }));
        this.head = seq;
        this.prompt = prompt;
    }
}
/** Source admission precedes renaming, so these payloads have exact audited fields. */
function renamePtcEvent(event) {
    switch (event.type) {
        case 'agent-preset/selected':
            return event.data['agentPreset'] === 'code'
                ? { ...event, data: { ...event.data, agentPreset: 'ptc' } } : event;
        case 'tool/code-dispatch-start':
            return { ...event, type: 'tool/ptc-dispatch-start' };
        case 'tool/code-dispatch':
            return { ...event, type: 'tool/ptc-dispatch' };
        case 'user/message': {
            const data = renameMessageSource(event.data);
            return data === event.data ? event : { ...event, data };
        }
        case 'agent/inbox/spliced':
        case 'session/title-llm-request': {
            const data = event.data;
            const key = event.type === 'agent/inbox/spliced' ? 'inserted' : 'messages';
            const messages = data[key];
            const renamed = messages.map(renameMessageSource);
            return renamed.every((message, index) => message === messages[index])
                ? event
                : { ...event, data: { ...data, [key]: renamed } };
        }
        default:
            // Content, tool arguments, message IDs, and other payloads are not plugin attribution slots.
            return event;
    }
}
function renameMessageSource(message) {
    const source = message['source'];
    if (source['kind'] !== 'plugin' || source['plugin'] !== 'tools-code-mode')
        return message;
    return { ...message, source: { ...source, plugin: 'tools-ptc' } };
}
//# sourceMappingURL=migration.js.map