import { SessionFormatError, sessionFormatCount, sessionFormatSafeInteger, snapshotSessionFormatJson, } from '@deepseek-ai/dsh-session-format';
import { assertReleasedSessionFormatHeader } from "./validation.js";
import { assertReleasedV0Keys, releasedV0Record } from "./validation-helpers.js";
const PHYSICAL_HEADER_REQUIRED = ['type', 'version', 'id', 'createdAt', 'delegationDepth'];
const PHYSICAL_HEADER_OPTIONAL = ['cwd', 'parentSession', 'seedLength', 'origin', 'agentPreset'];
const PACKED_TAGS = new Set(['text-chunks', 'reasoning-chunks', 'tool-call-chunks']);
/**
 * Test whether a compact migration item is a released packed Assistant row.
 * @param run - compact migration item to classify.
 * @returns whether the item carries the released Assistant chunk representation.
 */
export function isReleasedAssistantChunkRun(run) {
    return run.runType === 'released-assistant-chunks';
}
/** Frozen physical JSON codec for the released v0 layout. */
export const releasedV0SessionFormatCodec = createReleasedCodec(0);
/** Frozen physical JSON codec for the shared-layout released v1 format. */
export const releasedV1SessionFormatCodec = createReleasedCodec(1);
function createReleasedCodec(version) {
    return Object.freeze({
        version,
        decodeHeader: (value) => decodeHeader(value, version),
        createDecoder(headerValue, recovery) {
            const physical = decodePhysicalHeader(headerValue, version);
            const scanner = scanRows(recovery === 'recoverable');
            return {
                header: physical.header,
                headerInheritedEventCount: physical.inheritedEventCount,
                decodeRow: (rowValue, context) => { scanner.decodeRow(rowValue, context); },
                finish(_context) {
                    scanner.finish(physical.inheritedEventCount);
                    return physical.inheritedEventCount;
                },
            };
        },
    });
}
function scanRows(recoverable) {
    let rowIndex = 0;
    let eventCount = 0;
    let issue;
    return {
        decodeRow(rowValue, context) {
            const currentRow = rowIndex;
            rowIndex += 1;
            let packed = false;
            let decoded;
            try {
                const record = releasedV0Record(rowValue, `released Session row ${currentRow}`);
                const type = record['type'];
                if (typeof type === 'string' && PACKED_TAGS.has(type)) {
                    packed = true;
                    decoded = decodePackedRun(record, type, currentRow);
                }
                else {
                    decoded = decodeEvent(record, currentRow);
                }
            }
            catch (error) {
                const current = error instanceof SessionFormatError
                    ? error
                    : new SessionFormatError(`released Session row ${currentRow} is malformed`, { cause: error });
                if (!recoverable)
                    throw current;
                issue ??= current;
                return;
            }
            if (issue !== undefined) {
                if (!packed && decoded.type === 'turn/end')
                    throw issue;
                return;
            }
            const seq = packed
                ? decoded.firstSeq
                : decoded.seq;
            if (seq !== eventCount) {
                const gap = new SessionFormatError(`released Session row ${currentRow} has seq gap (expected ${eventCount}, got ${seq})`);
                if (!recoverable)
                    throw gap;
                issue = gap;
                if (!packed && decoded.type === 'turn/end')
                    throw gap;
                return;
            }
            if (packed) {
                const run = decoded;
                eventCount += run.eventCount;
                context.emitRun(run);
            }
            else {
                eventCount += 1;
                context.emitEvent(decoded);
            }
        },
        finish(inheritedEventCount) {
            if (inheritedEventCount > eventCount) {
                throw new SessionFormatError('Session inheritedEventCount exceeds its event count');
            }
        },
    };
}
function decodeHeader(value, version) {
    return decodePhysicalHeader(value, version).header;
}
function decodePhysicalHeader(value, version) {
    const source = snapshotSessionFormatJson(value, `released v${version} physical header`);
    const record = releasedV0Record(source, `released v${version} physical header`);
    assertReleasedV0Keys(record, PHYSICAL_HEADER_REQUIRED, PHYSICAL_HEADER_OPTIONAL, `released v${version} physical header`);
    if (record['type'] !== 'session' || record['version'] !== version) {
        throw new SessionFormatError(`expected released v${version} physical Session header`);
    }
    if (typeof record['id'] !== 'string')
        throw new SessionFormatError(`released v${version} header id must be a string`);
    const createdAt = sessionFormatCount(record['createdAt'], `released v${version} header createdAt`);
    const delegationDepth = sessionFormatCount(record['delegationDepth'], `released v${version} header delegationDepth`);
    const seedLength = record['seedLength'] === undefined
        ? 0
        : sessionFormatCount(record['seedLength'], `released v${version} header seedLength`);
    for (const key of ['cwd', 'parentSession', 'agentPreset']) {
        if (record[key] !== undefined && typeof record[key] !== 'string') {
            throw new SessionFormatError(`released v${version} header ${key} must be a string`);
        }
    }
    if (record['origin'] !== undefined && record['origin'] !== 'subagent') {
        throw new SessionFormatError(`released v${version} header origin must be "subagent"`);
    }
    const header = {
        version,
        id: record['id'],
        createdAt,
        ...(record['cwd'] === undefined ? {} : { cwd: record['cwd'] }),
        ...(record['parentSession'] === undefined ? {} : { parentSession: record['parentSession'] }),
        isSeeded: record['seedLength'] !== undefined,
        ...(record['origin'] === undefined ? {} : { origin: record['origin'] }),
        delegationDepth,
        ...(record['agentPreset'] === undefined ? {} : { agentPreset: record['agentPreset'] }),
    };
    assertReleasedSessionFormatHeader(header, version);
    return { header, inheritedEventCount: seedLength };
}
function decodeEvent(record, rowIndex) {
    if (record['sourceEventSeqs'] !== undefined) {
        const seq = sessionFormatCount(record['seq'], `released Session row ${rowIndex} seq`);
        return {
            ...record,
            sourceEventSeqs: decodeSeqRanges(record['sourceEventSeqs'], seq),
        };
    }
    return record;
}
function decodePackedRun(row, type, rowIndex) {
    const label = `released ${type} row ${rowIndex}`;
    assertReleasedV0Keys(row, ['type', 'seq0', 'time0', 'data'], [], label);
    const seq0 = sessionFormatCount(row['seq0'], `${label} seq0`);
    const time0 = sessionFormatSafeInteger(row['time0'], `${label} time0`);
    const data = releasedV0Record(row['data'], `${label} data`);
    const isTool = type === 'tool-call-chunks';
    assertReleasedV0Keys(data, isTool ? ['turn', 'step', 'index', 'id', 'dt', 'args'] : ['turn', 'step', 'index', 'dt', 'texts'], isTool ? ['name'] : [], `${label} data`);
    const payload = data[isTool ? 'args' : 'texts'];
    if (!Array.isArray(payload) || payload.length === 0 || payload.some(member => typeof member !== 'string')) {
        throw new SessionFormatError(`${label} payload must be a non-empty string array`);
    }
    const gaps = data['dt'];
    if (!Array.isArray(gaps) || gaps.length !== payload.length - 1) {
        throw new SessionFormatError(`${label} dt length must match its payload`);
    }
    let lastTime = time0;
    for (const gap of gaps) {
        const validGap = sessionFormatSafeInteger(gap, `${label} dt member`);
        lastTime = sessionFormatSafeInteger(lastTime + validGap, `${label} member time`);
    }
    const turn = sessionFormatCount(data['turn'], `${label} turn`);
    const step = sessionFormatCount(data['step'], `${label} step`);
    const chunkIndex = sessionFormatCount(data['index'], `${label} index`);
    if (isTool && (typeof data['id'] !== 'string'
        || data['id'].length === 0
        || (data['name'] !== undefined && typeof data['name'] !== 'string'))) {
        throw new SessionFormatError(`${label} id and optional name must be strings`);
    }
    const lastSeq = sessionFormatCount(seq0 + payload.length - 1, `${label} final seq`);
    const stream = (type === 'tool-call-chunks'
        ? {
            type,
            time0,
            index: chunkIndex,
            dt: gaps,
            id: data['id'],
            ...(data['name'] === undefined ? {} : { name: data['name'] }),
            args: payload,
        }
        : { type, time0, index: chunkIndex, dt: gaps, texts: payload });
    const run = {
        runType: 'released-assistant-chunks',
        firstSeq: seq0,
        eventCount: payload.length,
        turn,
        step,
        lastSeq,
        lastTime,
        stream,
        expand: () => expandAssistantChunkRun(run),
    };
    return run;
}
function* expandAssistantChunkRun(run) {
    const stream = run.stream;
    const gaps = stream['dt'];
    const members = stream['type'] === 'tool-call-chunks'
        ? stream['args']
        : stream['texts'];
    let time = run.stream['time0'];
    for (let index = 0; index < members.length; index += 1) {
        if (index > 0)
            time += gaps[index - 1];
        const member = members[index];
        const chunk = stream['type'] === 'text-chunks'
            ? { type: 'text-delta', index: stream['index'], text: member }
            : stream['type'] === 'reasoning-chunks'
                ? { type: 'reasoning-delta', index: stream['index'], text: member }
                : {
                    type: 'tool-call-delta',
                    index: stream['index'],
                    id: stream['id'],
                    ...(stream['name'] === undefined ? {} : { name: stream['name'] }),
                    argumentsDelta: member,
                };
        yield {
            type: 'assistant/chunk',
            seq: run.firstSeq + index,
            time,
            data: { turn: run.turn, step: run.step, chunk },
        };
    }
}
function decodeSeqRanges(value, maxEntries) {
    if (!Array.isArray(value))
        throw new SessionFormatError('sourceEventSeqs must be an array');
    const output = [];
    let hasRange = false;
    for (const entry of value) {
        if (typeof entry === 'number') {
            if (output.length >= maxEntries)
                throw new SessionFormatError('sourceEventSeqs exceeds its event seq');
            output.push(sessionFormatCount(entry, 'sourceEventSeqs member'));
            continue;
        }
        if (!Array.isArray(entry) || entry.length !== 2) {
            throw new SessionFormatError('sourceEventSeqs range must be a [start, end] pair');
        }
        const start = sessionFormatCount(entry[0], 'sourceEventSeqs range start');
        const end = sessionFormatCount(entry[1], 'sourceEventSeqs range end');
        if (end < start || end - start + 1 > maxEntries - output.length) {
            throw new SessionFormatError('sourceEventSeqs range exceeds its event seq');
        }
        for (let seq = start; seq <= end; seq += 1)
            output.push(seq);
        hasRange = true;
    }
    if (hasRange && output.some((member, index) => index > 0 && member <= output[index - 1])) {
        throw new SessionFormatError('sourceEventSeqs ranges must be strictly increasing');
    }
    return output;
}
//# sourceMappingURL=codec.js.map