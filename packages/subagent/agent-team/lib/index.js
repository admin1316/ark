import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { inspect } from "node:util";
import { HarnessError, createUserMessage } from "@deepseek-ai/dsh-llm";
import { z as z$1 } from "zod";
import { SessionId } from "@deepseek-ai/dsh-session";
import { randomUUID } from "node:crypto";
import { foldSubagentDescriptor } from "@deepseek-ai/dsh-subagent";
//#region lib/types/brand.js
/**
* Brand the root Session identity as its implicit Team identity.
* @param id - root Session identity.
* @returns the unchanged string with the Team brand.
*/
function TeamId(id) {
	return id;
}
/**
* Brand a validated Team-local task identity.
* @param id - task identity.
* @returns the unchanged string with the task brand.
*/
function TeamTaskId(id) {
	return id;
}
/**
* Brand a generated durable message identity.
* @param id - message identity.
* @returns the unchanged string with the message brand.
*/
function TeamMessageId(id) {
	return id;
}
//#endregion
//#region lib/types/error.js
/** Stable Team errors and bounded diagnostics. */
/** Failure raised by the Team domain. */
var TeamError = class extends HarnessError {
	constructor(message, code, options) {
		super(message, code, options);
		this.name = "TeamError";
	}
};
/**
* Describe an arbitrary failure without replacing its original identity.
* @param error - caught failure.
* @returns a single-line description with bounded inspection depth.
*/
function errorMessage(error) {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	return inspect(error, {
		breakLength: Infinity,
		compact: true,
		depth: 4
	});
}
//#endregion
//#region lib/types/activity.js
/** One-shot Team waiters, separate from durable state projection. */
/** Owns current change waiters and releases each at most once. */
var TeamActivity = class {
	waiters = /* @__PURE__ */ new Map();
	closed = false;
	/**
	* Wait for a later Team or member-status change.
	* @param id - Team whose next edge wakes the caller.
	* @param timeoutMs - integer duration from ten seconds through one hour.
	* @param signal - cancellation of this wait only.
	* @returns whether the wait ended by timeout.
	*/
	async wait(id, timeoutMs, signal) {
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1e4 || timeoutMs > 36e5) throw new TeamError("timeoutMs must be an integer from 10000 through 3600000", "TEAM_INVALID_TIMEOUT");
		signal.throwIfAborted();
		if (this.closed) return { timedOut: false };
		return { timedOut: !await new Promise((resolve, reject) => {
			const waiters = this.waiters.get(id) ?? /* @__PURE__ */ new Set();
			this.waiters.set(id, waiters);
			let settled = false;
			const finish = (settle) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal.removeEventListener("abort", onAbort);
				waiters.delete(waiter);
				if (waiters.size === 0) this.waiters.delete(id);
				settle();
			};
			const onAbort = () => {
				finish(() => {
					const reason = signal.reason;
					reject(reason instanceof Error ? reason : new TeamError(`wait_agent aborted: ${errorMessage(reason)}`, "TEAM_WAIT_ABORTED"));
				});
			};
			const waiter = { resolve: () => finish(() => resolve(true)) };
			waiters.add(waiter);
			const timer = setTimeout(() => finish(() => resolve(false)), timeoutMs);
			signal.addEventListener("abort", onAbort, { once: true });
			if (signal.aborted) onAbort();
		}) };
	}
	/**
	* Wake every current waiter for one Team.
	* @param id - Team whose waiters observe the change.
	*/
	notify(id) {
		const waiters = this.waiters.get(id);
		if (waiters === void 0) return;
		this.waiters.delete(id);
		for (const waiter of waiters) waiter.resolve();
	}
	/** Close admission and release current waiters during disposal. */
	close() {
		this.closed = true;
		for (const waiters of this.waiters.values()) for (const waiter of waiters) waiter.resolve();
		this.waiters.clear();
	}
};
//#endregion
//#region lib/types/task-graph.js
/** Task dependency error retained for command error mapping. */
var TeamTaskGraphError = class extends Error {
	violation;
	constructor(message, violation) {
		super(message);
		this.violation = violation;
		this.name = "TeamTaskGraphError";
	}
};
/**
* Validate the entire active task graph with one candidate replacement.
* @param current - task snapshots before the proposed event.
* @param candidate - new or next-revision task snapshot.
* @throws for missing, duplicate, self-referential, or cyclic dependencies.
*/
function assertTaskGraphCandidate(current, candidate) {
	const tasks = new Map(current);
	tasks.set(candidate.id, candidate);
	for (const task of tasks.values()) {
		if (task.status === "deleted") continue;
		const seen = /* @__PURE__ */ new Set();
		for (const blockerId of task.blockedBy) {
			if (blockerId === task.id) throw new TeamTaskGraphError(`team task "${task.id}" cannot block itself`, "cycle");
			if (seen.has(blockerId)) throw new TeamTaskGraphError(`team task "${task.id}" repeats blocker "${blockerId}"`, "duplicate");
			const blocker = tasks.get(blockerId);
			if (blocker === void 0 || blocker.status === "deleted") throw new TeamTaskGraphError(`blocker task "${blockerId}" for "${task.id}" is missing or deleted`, "missing");
			seen.add(blockerId);
		}
	}
	const visiting = /* @__PURE__ */ new Set();
	const visited = /* @__PURE__ */ new Set();
	const visit = (id) => {
		if (visiting.has(id)) throw new TeamTaskGraphError(`task dependency cycle includes "${id}"`, "cycle");
		if (visited.has(id)) return;
		const task = tasks.get(id);
		if (task === void 0 || task.status === "deleted") return;
		visiting.add(id);
		for (const blockerId of task.blockedBy) visit(blockerId);
		visiting.delete(id);
		visited.add(id);
	};
	for (const task of tasks.values()) visit(task.id);
}
//#endregion
//#region lib/types/fold.js
/** Strict replay of Team records owned by one Lead Session. */
const nonNegativeSafeInteger = z$1.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positiveSafeInteger = nonNegativeSafeInteger.min(1);
const sessionIdSchema = z$1.string().min(1).transform(SessionId);
const teamIdSchema = z$1.string().min(1).transform(TeamId);
const numericTaskIdPattern = /^task-(\d+)$/u;
const teamTaskIdSchema = z$1.string().min(1).refine((value) => {
	const match = numericTaskIdPattern.exec(value);
	return match === null || Number.isSafeInteger(Number(match[1]));
}, { message: "numeric task id suffix must be a safe integer" }).transform(TeamTaskId);
const teamMessageIdSchema = z$1.string().min(1).transform(TeamMessageId);
const coreContentBlockTypes = new Set([
	"text",
	"reasoning",
	"image",
	"tool-call",
	"tool-result"
]);
const imageAttachmentSchema = z$1.object({
	attachmentId: z$1.string().min(1),
	mediaType: z$1.enum([
		"image/png",
		"image/jpeg",
		"image/webp",
		"image/gif"
	]),
	bytes: nonNegativeSafeInteger,
	width: positiveSafeInteger,
	height: positiveSafeInteger,
	name: z$1.string().optional()
}).strict();
const contentBlockSchema = z$1.lazy(() => z$1.union([
	z$1.object({
		type: z$1.literal("text"),
		text: z$1.string()
	}).strict(),
	z$1.object({
		type: z$1.literal("reasoning"),
		text: z$1.string()
	}).strict(),
	z$1.object({
		type: z$1.literal("image"),
		attachment: imageAttachmentSchema
	}).strict(),
	z$1.object({
		type: z$1.literal("tool-call"),
		id: z$1.string().min(1),
		name: z$1.string(),
		arguments: z$1.string()
	}).strict(),
	z$1.object({
		type: z$1.literal("tool-result"),
		toolCallId: z$1.string().min(1),
		content: z$1.array(contentBlockSchema),
		isError: z$1.boolean().optional()
	}).strict(),
	z$1.object({ type: z$1.string().min(1) }).loose().refine((block) => !coreContentBlockTypes.has(block.type), { message: "known content block types must match their declared fields" })
]));
const teamMemberSnapshotSchema = z$1.object({
	id: sessionIdSchema,
	name: z$1.string(),
	description: z$1.string(),
	provider: z$1.string(),
	context: z$1.enum(["fresh", "fork"]),
	phase: z$1.enum([
		"provisioning",
		"active",
		"failed"
	]),
	error: z$1.string().optional()
}).strict();
const teamTaskSnapshotSchema = z$1.object({
	id: teamTaskIdSchema,
	revision: positiveSafeInteger,
	subject: z$1.string(),
	description: z$1.string(),
	status: z$1.enum([
		"pending",
		"in_progress",
		"completed",
		"deleted"
	]),
	ownerId: sessionIdSchema.optional(),
	blockedBy: z$1.array(teamTaskIdSchema),
	writeScopes: z$1.array(z$1.string())
}).strict();
const teamMessageSnapshotSchema = z$1.object({
	id: teamMessageIdSchema,
	senderId: sessionIdSchema,
	senderName: z$1.string(),
	targetId: sessionIdSchema,
	delivery: z$1.enum(["quiet", "wakeup"]),
	content: z$1.array(contentBlockSchema)
}).strict();
const teamEventSelectorSchema = z$1.object({
	version: nonNegativeSafeInteger,
	teamId: teamIdSchema
}).loose();
const teamEventSchemas = {
	"team/member": z$1.object({
		version: z$1.literal(1),
		teamId: teamIdSchema,
		member: teamMemberSnapshotSchema
	}).strict(),
	"team/task": z$1.object({
		version: z$1.literal(1),
		teamId: teamIdSchema,
		task: teamTaskSnapshotSchema
	}).strict(),
	"team/message/queued": z$1.object({
		version: z$1.literal(1),
		teamId: teamIdSchema,
		message: teamMessageSnapshotSchema
	}).strict(),
	"team/message/delivered": z$1.object({
		version: z$1.literal(1),
		teamId: teamIdSchema,
		messageId: teamMessageIdSchema,
		targetId: sessionIdSchema
	}).strict()
};
/**
* Construct an empty fold for a root Session.
* @param rootId - root identity selecting the Team's records.
* @returns detached empty state.
*/
function emptyTeamFoldState(rootId) {
	return {
		id: TeamId(rootId),
		members: /* @__PURE__ */ new Map(),
		memberIdsByName: /* @__PURE__ */ new Map(),
		tasks: /* @__PURE__ */ new Map(),
		messages: /* @__PURE__ */ new Map(),
		delivered: /* @__PURE__ */ new Set(),
		nextTaskNumber: 1
	};
}
/**
* Identify Team-owned event tags.
* @param event - candidate Session event.
* @returns whether the event belongs to the Team domain.
*/
function isTeamEvent(event) {
	return event.type === "team/member" || event.type === "team/task" || event.type === "team/message/queued" || event.type === "team/message/delivered";
}
function parsePersisted(type, schema, value) {
	try {
		return schema.parse(value);
	} catch (error) {
		throw new Error(`persisted Agent Teams ${type} payload is invalid`, { cause: error });
	}
}
/**
* Apply one validated record, ignoring records inherited by another root fork.
* @param state - mutable Team replay state.
* @param event - next contiguous Session event.
*/
function applyTeamEvent(state, event) {
	if (!isTeamEvent(event)) return;
	const selector = parsePersisted(event.type, teamEventSelectorSchema, event.data);
	if (selector.version !== 1) {
		if (selector.teamId !== state.id) return;
		throw new Error(`unsupported Agent Teams event version ${String(selector.version)}`);
	}
	parsePersisted(event.type, teamEventSchemas[event.type], event.data);
	const decoded = structuredClone(event);
	if (decoded.data.teamId !== state.id) return;
	switch (decoded.type) {
		case "team/member": {
			const member = decoded.data.member;
			const prior = state.members.get(member.id);
			const named = state.memberIdsByName.get(member.name);
			if (named !== void 0 && named !== member.id) throw new Error(`teammate name "${member.name}" is reused by another member`);
			if (prior === void 0) {
				if (member.phase !== "provisioning") throw new Error(`teammate "${member.name}" must begin provisioning`);
				state.memberIdsByName.set(member.name, member.id);
			} else {
				if (prior.name !== member.name || prior.provider !== member.provider || prior.context !== member.context) throw new Error(`teammate "${member.id}" changed immutable identity fields`);
				if (prior.phase !== "provisioning" || member.phase === "provisioning") throw new Error(`teammate "${member.name}" has an invalid ${prior.phase} -> ${member.phase} transition`);
			}
			state.members.set(member.id, member);
			break;
		}
		case "team/task": {
			const task = decoded.data.task;
			const prior = state.tasks.get(task.id);
			if (prior === void 0 && task.revision !== 1) throw new Error(`team task "${task.id}" must begin at revision 1`);
			if (prior !== void 0 && task.revision !== prior.revision + 1) throw new Error(`team task "${task.id}" revision is not contiguous`);
			assertTaskGraphCandidate(state.tasks, task);
			const match = numericTaskIdPattern.exec(task.id);
			if (match !== null) {
				const number = Number(match[1]);
				state.nextTaskNumber = Math.max(state.nextTaskNumber, number === Number.MAX_SAFE_INTEGER ? number : number + 1);
			}
			state.tasks.set(task.id, task);
			break;
		}
		case "team/message/queued": {
			const message = decoded.data.message;
			if (state.messages.has(message.id)) throw new Error(`team message "${message.id}" was queued twice`);
			state.messages.set(message.id, message);
			break;
		}
		case "team/message/delivered": {
			const queued = state.messages.get(decoded.data.messageId);
			if (queued === void 0) throw new Error(`team message "${decoded.data.messageId}" was delivered before queueing`);
			if (queued.targetId !== decoded.data.targetId) throw new Error(`team message "${decoded.data.messageId}" target changed`);
			if (state.delivered.has(decoded.data.messageId)) throw new Error(`team message "${decoded.data.messageId}" was delivered twice`);
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
function foldTeam(rootId, events) {
	const state = emptyTeamFoldState(rootId);
	for (const event of events) applyTeamEvent(state, event);
	return state;
}
//#endregion
//#region lib/types/journal.js
/** Owns per-Lead transaction order and durable Team publication. */
var TeamJournal = class {
	ctx;
	onCommit;
	tails = /* @__PURE__ */ new Map();
	constructor(ctx, onCommit) {
		this.ctx = ctx;
		this.onCommit = onCommit;
	}
	/**
	* Fold authoritative state for an exact live Lead.
	* @param root - live Lead Agent.
	* @returns replay state selected by its Team identity.
	*/
	state(root) {
		return foldTeam(root.id, root.session.events);
	}
	/**
	* Serialize one complete read-check-append operation for a Lead.
	* @param rootId - Lead identity selecting the queue.
	* @param operation - admitted asynchronous operation.
	* @returns the operation result.
	*/
	async transact(rootId, operation) {
		const run = (this.tails.get(rootId) ?? Promise.resolve()).then(operation, operation);
		const tail = run.then(() => void 0, () => void 0);
		this.tails.set(rootId, tail);
		try {
			return await run;
		} finally {
			if (this.tails.get(rootId) === tail) this.tails.delete(rootId);
		}
	}
	/**
	* Append and flush a Team event before notifying observers.
	* @param root - exact live Lead owning the log.
	* @param type - Team event discriminant.
	* @param data - matching event payload.
	*/
	async appendAndFlush(root, type, data) {
		root.session.append(type, data);
		await this.ctx.sessions.flush(root.session);
		this.onCommit(root);
	}
};
//#endregion
//#region lib/types/lifecycle.js
/** Shared admission cutoff and bounded Team shutdown. */
/** Owns the cancellation fact shared by all Team runtime operations. */
var TeamRuntimeLifecycle = class {
	disposalTimeoutMs;
	controller = new AbortController();
	disposalDeadline;
	constructor(disposalTimeoutMs) {
		this.disposalTimeoutMs = disposalTimeoutMs;
	}
	/** Cancellation shared by all admitted runtime operations. */
	get signal() {
		return this.controller.signal;
	}
	/** Whether shutdown has closed admission, independently of completed cleanup. */
	get disposed() {
		return this.signal.aborted;
	}
	/** Original cancellation reason used to distinguish shutdown from unexpected failure. */
	get reason() {
		return this.signal.reason;
	}
	isCancellation(reason) {
		const seen = /* @__PURE__ */ new Set();
		let current = reason;
		while (!seen.has(current)) {
			if (this.disposed && current === this.reason) return true;
			if (this.disposed && current instanceof TeamError && current.code === "TEAM_DISPOSED") return true;
			if (!(current instanceof Error)) return false;
			seen.add(current);
			current = current.cause;
		}
		return false;
	}
	/** Close admission and cancel interruptible work. */
	close() {
		if (this.disposed) return;
		this.disposalDeadline = Date.now() + this.disposalTimeoutMs;
		this.controller.abort(new TeamError("Agent Teams service disposed", "TEAM_DISPOSED"));
	}
	/**
	* Await admitted operations and retain failures other than runtime cancellation.
	* @param operations - operations captured after admission closes.
	* @param failures - destination for unexpected rejections or timeouts.
	*/
	async settle(operations, failures) {
		if (operations.length === 0) return;
		try {
			const outcomes = await this.withTimeout(Promise.allSettled(operations));
			for (const outcome of outcomes) if (outcome.status === "rejected" && !this.isCancellation(outcome.reason)) failures.push(outcome.reason);
		} catch (error) {
			failures.push(error);
		}
	}
	/**
	* Bound one shutdown operation.
	* @param operation - settlement that might otherwise wait indefinitely.
	* @returns the operation's result.
	*/
	async withTimeout(operation) {
		let timer;
		const timeout = new Promise((_resolve, reject) => {
			timer = setTimeout(() => reject(new TeamError(`Agent Teams runtime disposal exceeded ${this.disposalTimeoutMs}ms`, "TEAM_DISPOSAL_TIMEOUT")), this.disposalDeadline === void 0 ? this.disposalTimeoutMs : Math.max(0, this.disposalDeadline - Date.now()));
		});
		try {
			return await Promise.race([operation, timeout]);
		} finally {
			clearTimeout(timer);
		}
	}
};
//#endregion
//#region lib/types/session-message.js
function pendingInboxMessages(events) {
	const inbox = {
		"next-turn": [],
		"next-step": []
	};
	for (const event of events) {
		if (event.type !== "agent/inbox/spliced") continue;
		inbox[event.data.target].splice(event.data.start, event.data.removedCount ?? 0, ...event.data.inserted);
	}
	return [...inbox["next-turn"], ...inbox["next-step"]];
}
/**
* Check visible history and the remaining durable inbox for a message identity.
* @param events - non-inherited Session event suffix.
* @param predicate - message identity check.
* @returns whether a visible or still-pending message matches.
*/
function messageAccepted(events, predicate) {
	return events.some((event) => event.type === "user/message" && predicate(event.data)) || pendingInboxMessages(events).some(predicate);
}
//#endregion
//#region lib/types/validation.js
/** Input normalization shared by roster and task commands. */
/**
* Normalize a required human-authored string.
* @param value - raw input.
* @param field - diagnostic field name.
* @param maxLength - normalized character limit.
* @returns trimmed non-empty text.
*/
function requiredText(value, field, maxLength) {
	const text = value.trim();
	if (text.length === 0) throw new TeamError(`${field} must be non-empty`, "TEAM_INVALID_ARGUMENT");
	if (text.length > maxLength) throw new TeamError(`${field} exceeds ${maxLength} characters`, "TEAM_INVALID_ARGUMENT");
	return text;
}
/**
* Normalize an advisory workspace-relative path prefix, not a write lock.
* @param value - authored path prefix.
* @returns slash-separated relative prefix.
*/
function writeScope(value) {
	const normalized = value.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/+$/u, "");
	const segments = normalized.split("/");
	if (normalized.length === 0 || normalized.startsWith("/") || /^[a-z]:/iu.test(normalized) || segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) throw new TeamError(`invalid workspace-relative write scope ${JSON.stringify(value)}`, "TEAM_INVALID_WRITE_SCOPE");
	return normalized;
}
//#endregion
//#region lib/types/roster.js
/** Exact Team membership and continuable-child lifecycle. */
const MEMBER_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
/**
* Resolve an active teammate name or the Lead pseudo-row.
* @param root - exact live Lead.
* @param state - current Team fold.
* @param rawName - member name to resolve.
* @returns durable identity and normalized name.
*/
function resolveActiveMember(root, state, rawName) {
	const name = rawName.trim();
	if (name === "lead") return {
		id: root.id,
		name
	};
	const id = state.memberIdsByName.get(name);
	const member = id === void 0 ? void 0 : state.members.get(id);
	if (member === void 0 || member.phase !== "active") throw new TeamError(`active teammate "${name}" not found`, "TEAM_MEMBER_NOT_FOUND");
	return {
		id: member.id,
		name
	};
}
/** Owns roster identities and their continuable children. */
var TeamRoster = class {
	ctx;
	journal;
	lifecycle;
	maxMembers;
	inFlightCreations = /* @__PURE__ */ new Set();
	constructor(ctx, journal, lifecycle, maxMembers) {
		this.ctx = ctx;
		this.journal = journal;
		this.lifecycle = lifecycle;
		this.maxMembers = maxMembers;
	}
	/**
	* Require membership of an exact live Agent.
	* @param agent - calling Agent identity.
	* @returns its current Team and role.
	*/
	membership(agent) {
		const membership = this.tryMembership(agent);
		if (membership === void 0) throw new TeamError(`agent "${agent.id}" is not a member of an active Agent Team`, "TEAM_NOT_MEMBER");
		return membership;
	}
	/**
	* Resolve membership without admitting stale identities or foreign subagents.
	* @param agent - candidate live Agent.
	* @returns current membership, or undefined when it cannot be established.
	*/
	tryMembership(agent) {
		if (this.ctx.agents.get(agent.id) !== agent) return void 0;
		try {
			const parentId = agent.session.header.parentSession;
			if (parentId !== void 0) {
				const root = this.ctx.agents.get(parentId);
				if (root !== void 0) {
					const member = this.journal.state(root).members.get(agent.id);
					if (member?.phase === "active" || member?.phase === "provisioning") return {
						root,
						id: TeamId(root.id),
						role: "teammate",
						name: member.name
					};
				}
			}
			if (this.subagentDescriptor(agent)) return void 0;
			return {
				root: agent,
				id: TeamId(agent.id),
				role: "lead",
				name: "lead"
			};
		} catch {
			return;
		}
	}
	/**
	* List the roster with current runtime status.
	* @param membership - exact caller membership.
	* @returns Lead and teammate rows in creation order.
	*/
	list(membership) {
		const { root } = membership;
		const result = [{
			id: root.id,
			name: "lead",
			role: "lead",
			status: root.status,
			...root.options.model === void 0 ? {} : { model: root.options.model },
			diagnostics: []
		}];
		for (const member of this.journal.state(root).members.values()) {
			const live = this.ctx.agents.get(member.id);
			const model = live?.options.model ?? root.options.model;
			result.push({
				id: member.id,
				name: member.name,
				role: "teammate",
				status: member.phase === "failed" ? "failed" : member.phase === "provisioning" ? "provisioning" : live?.status ?? "inactive",
				description: member.description,
				provider: member.provider,
				context: member.context,
				...model === void 0 ? {} : { model },
				diagnostics: member.error === void 0 ? [] : [member.error]
			});
		}
		return result;
	}
	/**
	* Admit one Lead-owned teammate creation before the shutdown cutoff.
	* @param caller - exact live Lead.
	* @param request - teammate identity, initial message, provider and cancellation.
	* @returns the active member after durable prompt acceptance.
	*/
	async spawn(caller, request) {
		if (this.lifecycle.disposed) throw new TeamError("Agent Teams service is disposing", "TEAM_DISPOSED");
		const operation = this.spawnAdmitted(caller, request);
		this.inFlightCreations.add(operation);
		try {
			return await operation;
		} finally {
			this.inFlightCreations.delete(operation);
		}
	}
	/**
	* Capture admitted creations before ordered disposal.
	* @returns creation operations that have not settled.
	*/
	pendingCreations() {
		return [...this.inFlightCreations];
	}
	/**
	* Reconcile provisioning when a Team Lead starts.
	* @param agent - newly started exact live Agent.
	* @param signal - runtime cancellation.
	*/
	async recoverFor(agent, signal) {
		signal.throwIfAborted();
		const membership = this.tryMembership(agent);
		if (membership?.role === "lead") await this.reconcileProvisioning(membership.root, signal);
	}
	/**
	* Interrupt a teammate turn without discarding its pending inbox.
	* @param caller - exact live Lead.
	* @param targetName - durable teammate name.
	* @returns status immediately before cancellation.
	*/
	interrupt(caller, targetName) {
		const membership = this.membership(caller);
		if (membership.role !== "lead") throw new TeamError("only the Team Lead can interrupt teammates", "TEAM_LEAD_REQUIRED");
		const target = resolveActiveMember(membership.root, this.journal.state(membership.root), targetName);
		if (target.id === membership.root.id) throw new TeamError("the Team Lead cannot interrupt itself", "TEAM_INVALID_TARGET");
		const live = this.ctx.agents.get(target.id);
		if (live === void 0) return { previousStatus: "inactive" };
		const previousStatus = live.status;
		this.ctx.subagents.interrupt(target.id, {
			kind: "ancestor",
			agent: caller
		});
		return { previousStatus };
	}
	/**
	* Group currently live roster children for owner-checked teardown.
	* @returns child session identities grouped by their exact current Lead.
	*/
	liveChildrenByRoot() {
		const teams = /* @__PURE__ */ new Map();
		for (const agent of this.ctx.agents.list()) {
			const rootId = agent.session.header.parentSession;
			if (rootId === void 0) continue;
			const root = this.ctx.agents.get(rootId);
			if (root === void 0 || !this.journal.state(root).members.has(agent.id)) continue;
			const children = teams.get(root) ?? [];
			children.push(agent.id);
			teams.set(root, children);
		}
		return teams;
	}
	/**
	* Release selected teammate activations through their continuation owner.
	* @param root - exact Lead authorizing release.
	* @param childIds - selected roster children.
	*/
	async stopTeammates(root, childIds) {
		await this.lifecycle.withTimeout(this.ctx.subagents.drainContinuableChildren(root, childIds));
	}
	async spawnAdmitted(caller, request) {
		const membership = this.membership(caller);
		if (membership.role !== "lead") throw new TeamError("only the Team Lead can create teammates", "TEAM_LEAD_REQUIRED");
		const signal = AbortSignal.any([request.signal, this.lifecycle.signal]);
		signal.throwIfAborted();
		const root = membership.root;
		const name = this.memberName(request.name);
		const description = requiredText(request.description, "description", 200);
		const childId = SessionId(randomUUID());
		const member = {
			id: childId,
			name,
			description,
			provider: requiredText(request.provider, "provider", 200),
			context: request.context,
			phase: "provisioning"
		};
		await this.journal.transact(root.id, async () => {
			const state = this.journal.state(root);
			if (state.memberIdsByName.has(name)) throw new TeamError(`teammate name "${name}" was already used in this Team`, "TEAM_MEMBER_NAME_TAKEN");
			if (state.members.size >= this.maxMembers) throw new TeamError(`Team member limit ${this.maxMembers} reached`, "TEAM_MEMBER_LIMIT");
			await this.journal.appendAndFlush(root, "team/member", {
				version: 1,
				teamId: TeamId(root.id),
				member
			});
		});
		try {
			const started = await this.ctx.subagents.startContinuable({
				childId,
				provider: request.provider,
				label: description,
				request: {
					prompt: request.prompt,
					parent: root
				},
				signal
			});
			await this.checkpointInitialPrompt(childId, started.messageId, signal);
		} catch (error) {
			const failed = {
				...member,
				phase: "failed",
				error: errorMessage(error)
			};
			try {
				const phase = await this.settleProvisioning(root, failed);
				await this.stopTeammates(root, [childId]);
				if (phase === "active") throw new TeamError(`teammate "${name}" became active while its creator reported failure`, "TEAM_PROVISIONING_CONFLICT", { cause: error });
			} catch (recordError) {
				throw new AggregateError([error, recordError], "teammate creation and durable failure recording both failed");
			}
			throw error;
		}
		const active = {
			...member,
			phase: "active"
		};
		if (await this.settleProvisioning(root, active) === "failed") {
			const conflict = new TeamError(`teammate "${name}" was reconciled as failed while creation was in progress`, "TEAM_PROVISIONING_CONFLICT");
			try {
				await this.stopTeammates(root, [childId]);
			} catch (cleanupError) {
				throw new AggregateError([conflict, cleanupError], "provisioning conflict cleanup failed");
			}
			throw conflict;
		}
		return { member: this.memberView(active) };
	}
	async checkpointInitialPrompt(childId, messageId, signal) {
		for (;;) {
			signal.throwIfAborted();
			const session = this.ctx.sessions.get(childId);
			if (session === void 0) {
				const stored = await this.ctx.sessionPersistence.inspect(childId, signal);
				if (messageAccepted(stored.events.slice(stored.meta.seedLength ?? 0), (message) => message.id === messageId)) return;
				throw new TeamError(`teammate "${childId}" initial prompt was not durably accepted`, "TEAM_PROVISIONING_CONFLICT");
			}
			const progress = Promise.withResolvers();
			progress.promise.catch(() => void 0);
			const stopEvent = this.ctx.on("session/event", (candidate) => {
				if (candidate === session) progress.resolve(void 0);
			});
			const stopDisposed = this.ctx.on("session/disposed", (candidate) => {
				if (candidate === session) progress.resolve(void 0);
			});
			const onAbort = () => {
				const reason = signal.reason;
				progress.reject(reason instanceof Error ? reason : new TeamError(`teammate creation aborted: ${errorMessage(reason)}`, "TEAM_DISPOSED"));
			};
			signal.addEventListener("abort", onAbort, { once: true });
			try {
				signal.throwIfAborted();
				await this.ctx.sessions.flush(session);
				if (messageAccepted(session.events.slice(session.header.seedLength ?? 0), (message) => message.id === messageId)) return;
				if (this.ctx.sessions.get(childId) !== session) continue;
				await progress.promise;
			} finally {
				signal.removeEventListener("abort", onAbort);
				stopDisposed();
				stopEvent();
			}
		}
	}
	async reconcileProvisioning(root, signal) {
		const provisioning = [...this.journal.state(root).members.values()].filter((member) => member.phase === "provisioning");
		for (const member of provisioning) {
			signal.throwIfAborted();
			if (this.ctx.agents.get(member.id) !== void 0) continue;
			let phase = "failed";
			let failure = "provisioning did not leave a resumable child Session";
			try {
				const loaded = await this.ctx.sessionPersistence.inspect(member.id, signal);
				const suffix = loaded.events.slice(loaded.meta.seedLength ?? 0);
				const descriptor = foldSubagentDescriptor(suffix);
				const accepted = messageAccepted(suffix, (message) => message.source.kind === "user");
				if (loaded.meta.parentSession === root.id && descriptor?.mode === "continuable" && descriptor.provider === member.provider && accepted) phase = "active";
				else failure = "persisted child Session does not match the provisioned continuation";
			} catch (error) {
				failure = `child Session recovery failed: ${errorMessage(error)}`;
			}
			signal.throwIfAborted();
			await this.journal.transact(root.id, async () => {
				signal.throwIfAborted();
				const current = this.journal.state(root).members.get(member.id);
				if (current?.phase !== "provisioning") return;
				const settled = {
					...current,
					phase,
					...phase === "failed" ? { error: failure } : {}
				};
				await this.journal.appendAndFlush(root, "team/member", {
					version: 1,
					teamId: TeamId(root.id),
					member: settled
				});
			});
		}
	}
	memberView(member) {
		const live = this.ctx.agents.get(member.id);
		return {
			id: member.id,
			name: member.name,
			role: "teammate",
			status: live?.status ?? "inactive",
			description: member.description,
			provider: member.provider,
			context: member.context,
			...live?.options.model === void 0 ? {} : { model: live.options.model },
			diagnostics: []
		};
	}
	memberName(value) {
		if (!MEMBER_NAME.test(value) || value.length > 64 || value === "lead") throw new TeamError("teammate name must be lower-kebab-case, at most 64 characters, and not \"lead\"", "TEAM_INVALID_MEMBER_NAME");
		return value;
	}
	settleProvisioning(root, terminal) {
		return this.journal.transact(root.id, async () => {
			const current = this.journal.state(root).members.get(terminal.id);
			if (current === void 0) throw new TeamError(`provisioned teammate "${terminal.id}" disappeared`, "TEAM_PROVISIONING_CONFLICT");
			if (current.phase !== "provisioning") return current.phase;
			await this.journal.appendAndFlush(root, "team/member", {
				version: 1,
				teamId: TeamId(root.id),
				member: terminal
			});
			return terminal.phase === "active" ? "active" : "failed";
		});
	}
	subagentDescriptor(agent) {
		return foldSubagentDescriptor(agent.session.events.slice(agent.session.header.seedLength ?? 0)) !== void 0;
	}
};
//#endregion
//#region lib/types/mailbox.js
/** Durable Team mailbox admission, ordered dispatch and acknowledgement. */
/** Owns process-local admission and delivery state for the durable mailbox. */
var TeamMailbox = class {
	ctx;
	journal;
	roster;
	lifecycle;
	maxPendingMessagesPerMember;
	maxMessageBytes;
	dispatchTails = /* @__PURE__ */ new Map();
	activeDispatches = /* @__PURE__ */ new Map();
	inFlightMessages = /* @__PURE__ */ new Set();
	inFlightDispatches = /* @__PURE__ */ new Set();
	constructor(ctx, journal, roster, lifecycle, maxPendingMessagesPerMember, maxMessageBytes) {
		this.ctx = ctx;
		this.journal = journal;
		this.roster = roster;
		this.lifecycle = lifecycle;
		this.maxPendingMessagesPerMember = maxPendingMessagesPerMember;
		this.maxMessageBytes = maxMessageBytes;
	}
	/**
	* Queue a durable peer message, then attempt delivery.
	* @param caller - exact live sending member.
	* @param request - target, content, delivery mode and pre-queue cancellation.
	* @returns durable identity and immediate acceptance observation.
	*/
	async send(caller, request) {
		if (this.lifecycle.disposed) throw new TeamError("Agent Teams service is disposing", "TEAM_DISPOSED");
		return await this.trackDispatch(this.sendAdmitted(caller, {
			...request,
			signal: AbortSignal.any([request.signal, this.lifecycle.signal])
		}));
	}
	/**
	* Checkpoint a target's receipt before acknowledging it in the Lead log.
	* @param session - exact target Session.
	* @param event - newly appended Session event.
	*/
	observeSessionEvent(session, event) {
		if (this.lifecycle.disposed || event.type !== "user/message" || event.data.source.kind !== "team-message") return;
		const source = event.data.source;
		const acknowledgement = Promise.resolve().then(async () => {
			const root = this.ctx.agents.get(SessionId(source.teamId));
			if (root !== void 0) await this.checkpointDelivered(root, session, source.messageId);
		}).catch((error) => {
			this.ctx.logger.warn(`Team message "${source.messageId}" acknowledgement failed: ${errorMessage(error)}`);
		});
		this.trackDispatch(acknowledgement);
	}
	/**
	* Retry pending messages relevant to a newly started member.
	* @param agent - exact live member.
	* @param signal - runtime cancellation.
	*/
	async recoverFor(agent, signal) {
		signal.throwIfAborted();
		const membership = this.roster.tryMembership(agent);
		if (membership === void 0) return;
		const state = this.journal.state(membership.root);
		const messages = [...state.messages.values()].filter((message) => !state.delivered.has(message.id) && (membership.role === "lead" || message.targetId === agent.id));
		for (const message of messages) {
			signal.throwIfAborted();
			if (membership.role === "lead" && message.delivery === "quiet" && message.targetId !== membership.root.id && this.ctx.agents.get(message.targetId) === void 0) continue;
			await this.tryDispatch(membership.root, message, signal);
		}
	}
	/**
	* Capture admitted mailbox work before shutdown waits for it.
	* @returns admitted dispatch and acknowledgement operations.
	*/
	pendingDispatches() {
		return [...this.inFlightDispatches];
	}
	async sendAdmitted(caller, request) {
		const membership = this.roster.membership(caller);
		request.signal.throwIfAborted();
		const root = membership.root;
		const content = structuredClone(request.content);
		const queued = await this.journal.transact(root.id, async () => {
			request.signal.throwIfAborted();
			const state = this.journal.state(root);
			const target = resolveActiveMember(root, state, request.target);
			if (target.id === caller.id) throw new TeamError("a Team member cannot message itself", "TEAM_SELF_MESSAGE");
			const pending = [...state.messages.values()].filter((candidate) => candidate.targetId === target.id && !state.delivered.has(candidate.id)).length;
			if (pending >= this.maxPendingMessagesPerMember) throw new TeamError(`teammate "${target.name}" has ${pending} pending messages`, "TEAM_MAILBOX_FULL");
			const message = {
				id: TeamMessageId(`team-message-${randomUUID()}`),
				senderId: caller.id,
				senderName: membership.name,
				targetId: target.id,
				delivery: request.delivery,
				content
			};
			if (Buffer.byteLength(JSON.stringify(this.deliveryContent(message)), "utf8") > this.maxMessageBytes) throw new TeamError(`team message exceeds ${this.maxMessageBytes} bytes`, "TEAM_MESSAGE_TOO_LARGE");
			await this.journal.appendAndFlush(root, "team/message/queued", {
				version: 1,
				teamId: TeamId(root.id),
				message
			});
			return {
				message,
				dispatch: this.tryDispatch(root, message, request.signal)
			};
		});
		const accepted = await queued.dispatch;
		return {
			messageId: queued.message.id,
			status: accepted ? "accepted" : "queued"
		};
	}
	tryDispatch(root, message, signal) {
		if (this.lifecycle.disposed || this.inFlightMessages.has(message.id)) return Promise.resolve(false);
		this.inFlightMessages.add(message.id);
		const operation = this.trackDispatch(this.tryDispatchAdmitted(root, message, AbortSignal.any([signal, this.lifecycle.signal])));
		const forget = () => {
			this.inFlightMessages.delete(message.id);
		};
		operation.then(forget, forget);
		return operation;
	}
	trackDispatch(operation) {
		this.inFlightDispatches.add(operation);
		const forget = () => {
			this.inFlightDispatches.delete(operation);
		};
		operation.then(forget, forget);
		return operation;
	}
	async tryDispatchAdmitted(root, message, signal) {
		const active = this.activeDispatches.get(message.targetId);
		const live = message.targetId === root.id ? root : this.ctx.agents.get(message.targetId);
		if (active !== void 0 && live !== void 0 && message.delivery === "quiet" && this.messagePrecedes(root, message.id, active.id)) return await this.dispatchOnce(root, message, signal);
		return await this.serializeDispatch(message, () => this.dispatchOnce(root, message, signal));
	}
	async serializeDispatch(message, operation) {
		const targetId = message.targetId;
		const prior = this.dispatchTails.get(targetId) ?? Promise.resolve();
		const dispatch = async () => {
			this.activeDispatches.set(targetId, message);
			try {
				return await operation();
			} finally {
				this.activeDispatches.delete(targetId);
			}
		};
		const run = prior.then(dispatch, dispatch);
		const tail = run.then(() => void 0, () => void 0);
		this.dispatchTails.set(targetId, tail);
		try {
			return await run;
		} finally {
			if (this.dispatchTails.get(targetId) === tail) this.dispatchTails.delete(targetId);
		}
	}
	async dispatchOnce(root, message, signal) {
		try {
			const target = message.targetId === root.id ? root : this.ctx.agents.get(message.targetId);
			if (target !== void 0 && this.targetRecorded(target.session, message.id)) return await this.checkpointDelivered(root, target.session, message.id);
			const source = {
				kind: "team-message",
				teamId: TeamId(root.id),
				messageId: message.id,
				senderId: message.senderId,
				senderName: message.senderName
			};
			const content = this.deliveryContent(message);
			if (message.targetId === root.id) {
				const input = createUserMessage({
					content,
					source
				});
				if (message.delivery === "wakeup") root.followup(input);
				else root.inject(input);
				return await this.checkpointDelivered(root, root.session, message.id);
			}
			if (message.delivery === "quiet") {
				if (target === void 0) return false;
				target.inject(createUserMessage({
					content,
					source
				}));
				return await this.checkpointDelivered(root, target.session, message.id);
			}
			if (target === void 0) {
				const recorded = await this.persistedTargetRecorded(message.targetId, message.id, signal);
				if (recorded === void 0) return false;
				if (recorded) {
					await this.markDelivered(root, message.id, message.targetId);
					return true;
				}
			}
			await this.ctx.subagents.followup(root, message.targetId, content, {
				source,
				signal
			});
			await this.markDelivered(root, message.id, message.targetId);
			return true;
		} catch (error) {
			this.ctx.logger.warn(`team message "${message.id}" remains queued: ${errorMessage(error)}`);
			return false;
		}
	}
	messagePrecedes(root, left, right) {
		const ids = [...this.journal.state(root).messages.keys()];
		return ids.indexOf(left) < ids.indexOf(right);
	}
	async checkpointDelivered(root, target, messageId) {
		await this.ctx.sessions.flush(target);
		if (!this.targetRecorded(target, messageId)) return false;
		await this.markDelivered(root, messageId, target.id);
		return true;
	}
	markDelivered(root, messageId, targetId) {
		return this.journal.transact(root.id, async () => {
			const state = this.journal.state(root);
			if (state.delivered.has(messageId)) return;
			const queued = state.messages.get(messageId);
			if (queued === void 0 || queued.targetId !== targetId) return;
			await this.journal.appendAndFlush(root, "team/message/delivered", {
				version: 1,
				teamId: TeamId(root.id),
				messageId,
				targetId
			});
		});
	}
	targetRecorded(session, messageId) {
		return messageAccepted(session.events.slice(session.header.seedLength ?? 0), (message) => message.source.kind === "team-message" && message.source.messageId === messageId);
	}
	deliveryContent(message) {
		return [{
			type: "text",
			text: `Team message ${message.id} from ${message.senderName}:`
		}, ...structuredClone(message.content)];
	}
	async persistedTargetRecorded(targetId, messageId, signal) {
		try {
			const stored = await this.ctx.sessionPersistence.inspect(targetId, signal);
			return messageAccepted(stored.events.slice(stored.meta.seedLength ?? 0), (message) => message.source.kind === "team-message" && message.source.messageId === messageId);
		} catch (error) {
			this.ctx.logger.warn(`cannot inspect Team message target "${targetId}": ${errorMessage(error)}`);
			return;
		}
	}
};
//#endregion
//#region lib/types/task-board.js
const TASK_GRAPH_ERROR_CODES = {
	missing: "TEAM_TASK_NOT_FOUND",
	duplicate: "TEAM_INVALID_ARGUMENT",
	cycle: "TEAM_TASK_DEPENDENCY_CYCLE"
};
function scopesOverlap(left, right) {
	return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}
/** Owns task limits, authorization, revisions and derived views. */
var TeamTaskBoard = class {
	journal;
	maxTasks;
	constructor(journal, maxTasks) {
		this.journal = journal;
		this.maxTasks = maxTasks;
	}
	/**
	* Create an unowned pending task in the Lead log.
	* @param membership - exact caller membership.
	* @param request - task text, blockers and advisory write scopes.
	* @returns revision-one view after durability.
	*/
	create(membership, request) {
		const { root } = membership;
		return this.journal.transact(root.id, async () => {
			const state = this.journal.state(root);
			if ([...state.tasks.values()].filter((task) => task.status !== "deleted").length >= this.maxTasks) throw new TeamError(`Team task limit ${this.maxTasks} reached`, "TEAM_TASK_LIMIT");
			const id = TeamTaskId(`task-${state.nextTaskNumber}`);
			if (state.tasks.has(id)) throw new TeamError("Team task id space exhausted", "TEAM_TASK_LIMIT");
			const task = {
				id,
				revision: 1,
				subject: requiredText(request.subject, "subject", 200),
				description: requiredText(request.description, "description", 16384),
				status: "pending",
				blockedBy: this.dependencies(request.blockedBy ?? [], state),
				writeScopes: this.writeScopes(request.writeScopes ?? [])
			};
			this.assertTaskGraph(state, task);
			await this.journal.appendAndFlush(root, "team/task", {
				version: 1,
				teamId: TeamId(root.id),
				task
			});
			return this.taskView(root, state, task);
		});
	}
	/**
	* Read one task, including its deleted tombstone.
	* @param membership - exact caller membership.
	* @param id - Team-local task identity.
	* @returns latest runtime-enriched view.
	*/
	get(membership, id) {
		const { root } = membership;
		const state = this.journal.state(root);
		const task = state.tasks.get(id);
		if (task === void 0) throw new TeamError(`team task "${id}" not found`, "TEAM_TASK_NOT_FOUND");
		return this.taskView(root, state, task);
	}
	/**
	* List non-deleted tasks in creation order.
	* @param membership - exact caller membership.
	* @returns detached task views.
	*/
	list(membership) {
		const { root } = membership;
		const state = this.journal.state(root);
		return [...state.tasks.values()].filter((task) => task.status !== "deleted").map((task) => this.taskView(root, state, task));
	}
	/**
	* Compare-and-set an authorized transition.
	* @param caller - exact live calling Agent.
	* @param membership - caller's Team role and Lead.
	* @param request - identity, expected revision, action and action fields.
	* @returns committed next-revision view.
	*/
	update(caller, membership, request) {
		const root = membership.root;
		return this.journal.transact(root.id, async () => {
			const state = this.journal.state(root);
			const current = state.tasks.get(request.taskId);
			if (current === void 0) throw new TeamError(`team task "${request.taskId}" not found`, "TEAM_TASK_NOT_FOUND");
			if (current.revision !== request.expectedRevision) throw new TeamError(`stale team task "${current.id}" revision ${request.expectedRevision}; current revision is ${current.revision}`, "TEAM_TASK_STALE_REVISION");
			if (current.status === "deleted") throw new TeamError(`team task "${current.id}" is deleted`, "TEAM_TASK_DELETED");
			if (current.revision === Number.MAX_SAFE_INTEGER) throw new TeamError("Team task revision space exhausted", "TEAM_TASK_LIMIT");
			const lead = membership.role === "lead";
			const authorizeOwner = () => {
				if (!lead && current.ownerId !== caller.id) throw new TeamError("task mutation requires its owner or Team Lead", "TEAM_TASK_UNAUTHORIZED");
			};
			let next;
			switch (request.action) {
				case "claim":
					if (current.ownerId !== void 0 && current.ownerId !== caller.id) throw new TeamError(`team task "${current.id}" is owned by another member`, "TEAM_TASK_ALREADY_CLAIMED");
					if (current.status !== "pending" || !this.taskReady(state, current)) throw new TeamError(`team task "${current.id}" is not ready to claim`, "TEAM_TASK_BLOCKED");
					next = {
						...current,
						status: "in_progress",
						ownerId: caller.id
					};
					break;
				case "release":
					authorizeOwner();
					if (current.status !== "in_progress") throw new TeamError("only an in-progress task can be released", "TEAM_TASK_INVALID_TRANSITION");
					next = this.withoutOwner({
						...current,
						status: "pending"
					});
					break;
				case "edit":
					authorizeOwner();
					if (request.subject === void 0 && request.description === void 0 && request.writeScopes === void 0) throw new TeamError("task edit requires subject, description, or write_scopes", "TEAM_INVALID_ARGUMENT");
					next = {
						...current,
						...request.subject === void 0 ? {} : { subject: requiredText(request.subject, "subject", 200) },
						...request.description === void 0 ? {} : { description: requiredText(request.description, "description", 16384) },
						...request.writeScopes === void 0 ? {} : { writeScopes: this.writeScopes(request.writeScopes) }
					};
					break;
				case "set_dependencies":
					authorizeOwner();
					if (request.blockedBy === void 0) throw new TeamError("set_dependencies requires blocked_by", "TEAM_INVALID_ARGUMENT");
					next = {
						...current,
						blockedBy: this.dependencies(request.blockedBy, state, current.id)
					};
					break;
				case "complete":
					authorizeOwner();
					if (current.status !== "in_progress") throw new TeamError("only an in-progress task can complete", "TEAM_TASK_INVALID_TRANSITION");
					next = {
						...current,
						status: "completed"
					};
					break;
				case "reopen":
					authorizeOwner();
					if (current.status !== "completed") throw new TeamError("only a completed task can reopen", "TEAM_TASK_INVALID_TRANSITION");
					next = this.withoutOwner({
						...current,
						status: "pending"
					});
					break;
				case "reassign": {
					if (!lead) throw new TeamError("only the Team Lead can reassign tasks", "TEAM_LEAD_REQUIRED");
					if (current.status !== "pending" && current.status !== "in_progress") throw new TeamError("only a pending or in-progress task can be reassigned", "TEAM_TASK_INVALID_TRANSITION");
					if (request.owner === void 0 || request.owner.trim().length === 0) {
						next = this.withoutOwner({
							...current,
							status: "pending"
						});
						break;
					}
					if (!this.taskReady(state, current)) throw new TeamError(`team task "${current.id}" is blocked`, "TEAM_TASK_BLOCKED");
					const assignee = resolveActiveMember(root, state, request.owner);
					next = {
						...current,
						status: "in_progress",
						ownerId: assignee.id
					};
					break;
				}
				case "delete": {
					authorizeOwner();
					const dependent = [...state.tasks.values()].find((task) => task.status !== "deleted" && task.id !== current.id && task.blockedBy.includes(current.id));
					if (dependent !== void 0) throw new TeamError(`team task "${current.id}" still blocks "${dependent.id}"`, "TEAM_TASK_HAS_DEPENDENTS");
					next = {
						...current,
						status: "deleted"
					};
					break;
				}
				default: throw new TeamError(`unsupported task action ${String(request.action)}`, "TEAM_INVALID_ARGUMENT");
			}
			const task = {
				...next,
				revision: current.revision + 1
			};
			this.assertTaskGraph(state, task);
			await this.journal.appendAndFlush(root, "team/task", {
				version: 1,
				teamId: TeamId(root.id),
				task
			});
			return this.taskView(root, state, task);
		});
	}
	dependencies(values, state, self) {
		const seen = /* @__PURE__ */ new Set();
		const result = [];
		for (const id of values) {
			if (id === self) throw new TeamError("a team task cannot block itself", "TEAM_TASK_DEPENDENCY_CYCLE");
			if (seen.has(id)) throw new TeamError(`duplicate blocker "${id}"`, "TEAM_INVALID_ARGUMENT");
			const task = state.tasks.get(id);
			if (task === void 0 || task.status === "deleted") throw new TeamError(`blocker task "${id}" not found`, "TEAM_TASK_NOT_FOUND");
			seen.add(id);
			result.push(id);
		}
		return result;
	}
	writeScopes(values) {
		return [...new Set(values.map(writeScope))];
	}
	assertTaskGraph(state, candidate) {
		try {
			assertTaskGraphCandidate(state.tasks, candidate);
		} catch (error) {
			if (!(error instanceof TeamTaskGraphError)) throw error;
			throw new TeamError(error.message, TASK_GRAPH_ERROR_CODES[error.violation], { cause: error });
		}
	}
	taskReady(state, task) {
		return task.blockedBy.every((id) => state.tasks.get(id)?.status === "completed");
	}
	withoutOwner(task) {
		const { ownerId: _ownerId, ...without } = task;
		return without;
	}
	taskView(root, state, task) {
		const ownerName = task.ownerId === void 0 ? void 0 : task.ownerId === root.id ? "lead" : state.members.get(task.ownerId)?.name;
		const warnings = /* @__PURE__ */ new Set();
		for (const other of state.tasks.values()) {
			if (other.id === task.id || other.status !== "in_progress") continue;
			if (task.writeScopes.some((left) => other.writeScopes.some((right) => scopesOverlap(left, right)))) warnings.add(`write scopes overlap with ${other.id}`);
		}
		return {
			id: task.id,
			revision: task.revision,
			subject: task.subject,
			description: task.description,
			status: task.status,
			blockedBy: structuredClone(task.blockedBy),
			writeScopes: structuredClone(task.writeScopes),
			...ownerName === void 0 ? {} : { ownerName },
			ready: task.status === "pending" && this.taskReady(state, task),
			writeScopeWarnings: [...warnings]
		};
	}
};
//#endregion
//#region lib/types/index.js
/** Team service over roster, durable mailbox, task board and runtime lifetime owners. */
const DEFAULTS = {
	maxMembers: 8,
	maxTasks: 256,
	maxPendingMessagesPerMember: 64,
	maxMessageBytes: 65536,
	disposalTimeoutMs: 5e3
};
function positiveLimit(name, value) {
	if (!Number.isSafeInteger(value) || value < 1) throw new TeamError(`${name} must be a positive safe integer`, "TEAM_INVALID_CONFIG");
	return value;
}
/** Agent Teams backed by the exact live Lead's durable Session log. */
var TeamService = class extends Service {
	static inject = [
		"agents",
		"sessions",
		"sessionPersistence",
		"subagents"
	];
	static Config = z.object({
		maxMembers: z.number().step(1).min(1).default(DEFAULTS.maxMembers),
		maxTasks: z.number().step(1).min(1).default(DEFAULTS.maxTasks),
		maxPendingMessagesPerMember: z.number().step(1).min(1).default(DEFAULTS.maxPendingMessagesPerMember),
		maxMessageBytes: z.number().step(1).min(1).default(DEFAULTS.maxMessageBytes),
		disposalTimeoutMs: z.number().step(1).min(1).default(DEFAULTS.disposalTimeoutMs)
	});
	config;
	activity;
	lifecycle;
	journal;
	roster;
	mailbox;
	tasks;
	recoveries = /* @__PURE__ */ new Set();
	constructor(ctx, config = {}) {
		super(ctx, "agentTeams");
		this.config = {
			maxMembers: positiveLimit("maxMembers", config.maxMembers ?? DEFAULTS.maxMembers),
			maxTasks: positiveLimit("maxTasks", config.maxTasks ?? DEFAULTS.maxTasks),
			maxPendingMessagesPerMember: positiveLimit("maxPendingMessagesPerMember", config.maxPendingMessagesPerMember ?? DEFAULTS.maxPendingMessagesPerMember),
			maxMessageBytes: positiveLimit("maxMessageBytes", config.maxMessageBytes ?? DEFAULTS.maxMessageBytes),
			disposalTimeoutMs: positiveLimit("disposalTimeoutMs", config.disposalTimeoutMs ?? DEFAULTS.disposalTimeoutMs)
		};
		this.activity = new TeamActivity();
		this.lifecycle = new TeamRuntimeLifecycle(this.config.disposalTimeoutMs);
		this.journal = new TeamJournal(ctx, (root) => this.activity.notify(TeamId(root.id)));
		this.roster = new TeamRoster(ctx, this.journal, this.lifecycle, this.config.maxMembers);
		this.mailbox = new TeamMailbox(ctx, this.journal, this.roster, this.lifecycle, this.config.maxPendingMessagesPerMember, this.config.maxMessageBytes);
		this.tasks = new TeamTaskBoard(this.journal, this.config.maxTasks);
		ctx.on("session/event", (session, event) => this.mailbox.observeSessionEvent(session, event));
		ctx.on("agent/session-start", ({ agent }) => this.scheduleRecovery(agent));
		ctx.on("agent/status", ({ agent }) => {
			const membership = this.roster.tryMembership(agent);
			if (membership !== void 0) this.activity.notify(membership.id);
		});
		ctx.effect(() => () => this.disposeRuntime(), "agentTeams.runtimeLifecycle()");
		for (const agent of ctx.agents.list()) this.scheduleRecovery(agent);
	}
	/**
	* Require the caller's current live team membership.
	* @param agent - exact live caller.
	* @returns current Team role.
	*/
	membership(agent) {
		return this.roster.membership(agent);
	}
	/**
	* Read the live member's team roster.
	* @param agent - exact live member.
	* @returns roster in creation order.
	*/
	listMembers(agent) {
		return this.roster.list(this.roster.membership(agent));
	}
	/**
	* Create a teammate under the live Lead's roster and runtime lifetime.
	* @param caller - exact Lead.
	* @param request - creation request.
	* @returns durable active member.
	*/
	async spawnTeammate(caller, request) {
		return await this.roster.spawn(caller, request);
	}
	/**
	* Admit a peer message through the durable team mailbox.
	* @param caller - exact sender.
	* @param request - peer message.
	* @returns durable admission result.
	*/
	async sendMessage(caller, request) {
		return await this.mailbox.send(caller, request);
	}
	/**
	* Add a task to the caller's durable team board.
	* @param caller - exact member.
	* @param request - new task fields.
	* @returns committed task view.
	*/
	async createTask(caller, request) {
		return await this.tasks.create(this.roster.membership(caller), request);
	}
	/**
	* Read one task from the caller's team board.
	* @param caller - exact member.
	* @param id - task identity.
	* @returns latest task, including tombstones.
	*/
	getTask(caller, id) {
		return this.tasks.get(this.roster.membership(caller), id);
	}
	/**
	* Read visible tasks from the caller's team board.
	* @param caller - exact member.
	* @returns non-deleted tasks.
	*/
	listTasks(caller) {
		return this.tasks.list(this.roster.membership(caller));
	}
	/**
	* Commit a revision-checked team task mutation.
	* @param caller - exact member.
	* @param request - revision-checked mutation.
	* @returns committed task view.
	*/
	async updateTask(caller, request) {
		return await this.tasks.update(caller, this.roster.membership(caller), request);
	}
	/**
	* Wait for activity in the caller's team without retaining ownership after cancellation.
	* @param caller - exact member.
	* @param timeoutMs - bounded wait.
	* @param signal - wait cancellation.
	* @returns change or timeout.
	*/
	async waitForChange(caller, timeoutMs, signal) {
		return await this.activity.wait(this.roster.membership(caller).id, timeoutMs, signal);
	}
	/**
	* Interrupt a teammate owned by the live Lead.
	* @param caller - exact Lead.
	* @param targetName - teammate name.
	* @returns status before interruption.
	*/
	interrupt(caller, targetName) {
		return this.roster.interrupt(caller, targetName);
	}
	/**
	* Probe membership without admitting stale or foreign callers.
	* @param agent - candidate caller.
	* @returns membership or undefined for stale or foreign identities.
	*/
	tryMembership(agent) {
		return this.roster.tryMembership(agent);
	}
	scheduleRecovery(agent) {
		queueMicrotask(() => {
			if (this.lifecycle.disposed) return;
			const operation = this.recoverFor(agent).catch((error) => {
				if (!this.lifecycle.disposed) this.ctx.logger.warn(`Agent Teams recovery for "${agent.id}" failed: ${errorMessage(error)}`);
			});
			this.recoveries.add(operation);
			operation.then(() => {
				this.recoveries.delete(operation);
			});
		});
	}
	async recoverFor(agent) {
		await this.roster.recoverFor(agent, this.lifecycle.signal);
		await this.mailbox.recoverFor(agent, this.lifecycle.signal);
	}
	async disposeRuntime() {
		this.lifecycle.close();
		this.activity.close();
		const failures = [];
		await this.lifecycle.settle([...this.recoveries], failures);
		await this.lifecycle.settle(this.roster.pendingCreations(), failures);
		await this.lifecycle.settle(this.mailbox.pendingDispatches(), failures);
		for (const [root, childIds] of this.roster.liveChildrenByRoot()) try {
			await this.roster.stopTeammates(root, childIds);
		} catch (error) {
			failures.push(error);
		}
		if (failures.length > 0) throw new AggregateError(failures, "Agent Teams runtime disposal failed");
	}
};
//#endregion
export { TeamError, TeamId, TeamMessageId, TeamService, TeamService as default, TeamTaskId, foldTeam };
