/** Strict replay of Team records owned by one Lead Session. */
import { z } from 'zod';
import { SessionId } from '@deepseek-ai/dsh-session';
import { TeamId, TeamMessageId, TeamTaskId } from "./brand.js";
import { assertTaskGraphCandidate } from "./task-graph.js";
const nonNegativeSafeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positiveSafeInteger = nonNegativeSafeInteger.min(1);
const sessionIdSchema = z.string().min(1).transform(SessionId);
const teamIdSchema = z.string().min(1).transform(TeamId);
const numericTaskIdPattern = /^task-(\d+)$/u;
const teamTaskIdSchema = z.string().min(1).refine((value) => {
    const match = numericTaskIdPattern.exec(value);
    return match === null || Number.isSafeInteger(Number(match[1]));
}, { message: 'numeric task id suffix must be a safe integer' }).transform(TeamTaskId);
const teamMessageIdSchema = z.string().min(1).transform(TeamMessageId);
const coreContentBlockTypes = new Set(['text', 'reasoning', 'image', 'tool-call', 'tool-result']);
const imageAttachmentSchema = z.object({
    attachmentId: z.string().min(1),
    mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
    bytes: nonNegativeSafeInteger,
    width: positiveSafeInteger,
    height: positiveSafeInteger,
    name: z.string().optional(),
}).strict();
const contentBlockSchema = z.lazy(() => z.union([
    z.object({ type: z.literal('text'), text: z.string() }).strict(),
    z.object({ type: z.literal('reasoning'), text: z.string() }).strict(),
    z.object({ type: z.literal('image'), attachment: imageAttachmentSchema }).strict(),
    z.object({ type: z.literal('tool-call'), id: z.string().min(1), name: z.string(), arguments: z.string() }).strict(),
    z.object({ type: z.literal('tool-result'), toolCallId: z.string().min(1), content: z.array(contentBlockSchema), isError: z.boolean().optional() }).strict(),
    z.object({ type: z.string().min(1) }).loose().refine(block => !coreContentBlockTypes.has(block.type), {
        message: 'known content block types must match their declared fields',
    }),
]));
const teamMemberSnapshotSchema = z.object({
    id: sessionIdSchema, name: z.string(), description: z.string(), provider: z.string(),
    context: z.enum(['fresh', 'fork']), phase: z.enum(['provisioning', 'active', 'failed']), error: z.string().optional(),
}).strict();
const teamTaskSnapshotSchema = z.object({
    id: teamTaskIdSchema, revision: positiveSafeInteger, subject: z.string(), description: z.string(),
    status: z.enum(['pending', 'in_progress', 'completed', 'deleted']), ownerId: sessionIdSchema.optional(),
    blockedBy: z.array(teamTaskIdSchema), writeScopes: z.array(z.string()),
}).strict();
const teamMessageSnapshotSchema = z.object({
    id: teamMessageIdSchema, senderId: sessionIdSchema, senderName: z.string(), targetId: sessionIdSchema,
    delivery: z.enum(['quiet', 'wakeup']), content: z.array(contentBlockSchema),
}).strict();
const teamEventSelectorSchema = z.object({ version: nonNegativeSafeInteger, teamId: teamIdSchema }).loose();
const teamEventSchemas = {
    'team/member': z.object({ version: z.literal(1), teamId: teamIdSchema, member: teamMemberSnapshotSchema }).strict(),
    'team/task': z.object({ version: z.literal(1), teamId: teamIdSchema, task: teamTaskSnapshotSchema }).strict(),
    'team/message/queued': z.object({ version: z.literal(1), teamId: teamIdSchema, message: teamMessageSnapshotSchema }).strict(),
    'team/message/delivered': z.object({ version: z.literal(1), teamId: teamIdSchema, messageId: teamMessageIdSchema, targetId: sessionIdSchema }).strict(),
};
/**
 * Construct an empty fold for a root Session.
 * @param rootId - root identity selecting the Team's records.
 * @returns detached empty state.
 */
export function emptyTeamFoldState(rootId) {
    return {
        id: TeamId(rootId), members: new Map(), memberIdsByName: new Map(), tasks: new Map(),
        messages: new Map(), delivered: new Set(), nextTaskNumber: 1,
    };
}
/**
 * Identify Team-owned event tags.
 * @param event - candidate Session event.
 * @returns whether the event belongs to the Team domain.
 */
export function isTeamEvent(event) {
    return event.type === 'team/member' || event.type === 'team/task'
        || event.type === 'team/message/queued' || event.type === 'team/message/delivered';
}
function parsePersisted(type, schema, value) {
    try {
        return schema.parse(value);
    }
    catch (error) {
        throw new Error(`persisted Agent Teams ${type} payload is invalid`, { cause: error });
    }
}
/**
 * Apply one validated record, ignoring records inherited by another root fork.
 * @param state - mutable Team replay state.
 * @param event - next contiguous Session event.
 */
export function applyTeamEvent(state, event) {
    if (!isTeamEvent(event))
        return;
    const selector = parsePersisted(event.type, teamEventSelectorSchema, event.data);
    if (selector.version !== 1) {
        if (selector.teamId !== state.id)
            return;
        throw new Error(`unsupported Agent Teams event version ${String(selector.version)}`);
    }
    // Validation is non-coercing; clone the validated event so fold consumers cannot mutate its log.
    parsePersisted(event.type, teamEventSchemas[event.type], event.data);
    const decoded = structuredClone(event);
    if (decoded.data.teamId !== state.id)
        return;
    switch (decoded.type) {
        case 'team/member': {
            const member = decoded.data.member;
            const prior = state.members.get(member.id);
            const named = state.memberIdsByName.get(member.name);
            if (named !== undefined && named !== member.id)
                throw new Error(`teammate name "${member.name}" is reused by another member`);
            if (prior === undefined) {
                if (member.phase !== 'provisioning')
                    throw new Error(`teammate "${member.name}" must begin provisioning`);
                state.memberIdsByName.set(member.name, member.id);
            }
            else {
                if (prior.name !== member.name || prior.provider !== member.provider || prior.context !== member.context) {
                    throw new Error(`teammate "${member.id}" changed immutable identity fields`);
                }
                if (prior.phase !== 'provisioning' || member.phase === 'provisioning') {
                    throw new Error(`teammate "${member.name}" has an invalid ${prior.phase} -> ${member.phase} transition`);
                }
            }
            state.members.set(member.id, member);
            break;
        }
        case 'team/task': {
            const task = decoded.data.task;
            const prior = state.tasks.get(task.id);
            if (prior === undefined && task.revision !== 1)
                throw new Error(`team task "${task.id}" must begin at revision 1`);
            if (prior !== undefined && task.revision !== prior.revision + 1)
                throw new Error(`team task "${task.id}" revision is not contiguous`);
            assertTaskGraphCandidate(state.tasks, task);
            const match = numericTaskIdPattern.exec(task.id);
            if (match !== null) {
                const number = Number(match[1]);
                state.nextTaskNumber = Math.max(state.nextTaskNumber, number === Number.MAX_SAFE_INTEGER ? number : number + 1);
            }
            state.tasks.set(task.id, task);
            break;
        }
        case 'team/message/queued': {
            const message = decoded.data.message;
            if (state.messages.has(message.id))
                throw new Error(`team message "${message.id}" was queued twice`);
            state.messages.set(message.id, message);
            break;
        }
        case 'team/message/delivered': {
            const queued = state.messages.get(decoded.data.messageId);
            if (queued === undefined)
                throw new Error(`team message "${decoded.data.messageId}" was delivered before queueing`);
            if (queued.targetId !== decoded.data.targetId)
                throw new Error(`team message "${decoded.data.messageId}" target changed`);
            if (state.delivered.has(decoded.data.messageId))
                throw new Error(`team message "${decoded.data.messageId}" was delivered twice`);
            state.delivered.add(decoded.data.messageId);
            break;
        }
    }
}
/**
 * Replay the Lead log into the current Team state.
 * @param rootId - root Session identity selecting Team records.
 * @param events - complete contiguous Session log.
 * @returns detached replay state at the supplied log end.
 */
export function foldTeam(rootId, events) {
    const state = emptyTeamFoldState(rootId);
    for (const event of events)
        applyTeamEvent(state, event);
    return state;
}
//# sourceMappingURL=fold.js.map