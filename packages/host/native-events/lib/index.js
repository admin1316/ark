import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { Service } from "@deepseek-ai/cordis";
import { resolveSessionPreset } from "@deepseek-ai/dsh-agent-presets";
import { API_REMOTE_FORWARDED_EVENTS } from "@deepseek-ai/dsh-api-remotes/events";
import { errorChain } from "@deepseek-ai/dsh-llm";
import { findToolCallArguments, isJsonValue } from "@deepseek-ai/dsh-session";
import { UserQuestionError } from "@deepseek-ai/dsh-user-questions";
import { workspaceDomainState, workspaceRecord } from "@deepseek-ai/dsh-workspace";
//#region lib/types/index.js
/**
* Authoritative Native event projections and interactive response correlation.
*
* Durable Sessions, Agents, Workspaces, jobs, and projections remain owned by
* their domain services. This package owns only their live Native projection,
* the two reconnectable event sources, and the pending human-interaction table
* paired with the exact response carrier.
*
* @module @deepseek-ai/dsh-host-native-events
*/
function record(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function clientResponse(value) {
	const envelope = record(value);
	const result = record(envelope?.result);
	if (envelope?.type !== "client-response" || typeof envelope.rpcId !== "string" || typeof result?.ok !== "boolean") return void 0;
	if (result.ok) return {
		type: "client-response",
		rpcId: envelope.rpcId,
		result: {
			ok: true,
			...Object.hasOwn(result, "value") ? { value: result.value } : {}
		}
	};
	const error = record(result.error);
	if (typeof error?.code !== "string" || typeof error.message !== "string" || !Object.hasOwn(error, "details")) return void 0;
	return {
		type: "client-response",
		rpcId: envelope.rpcId,
		result: {
			ok: false,
			error: {
				code: error.code,
				message: error.message,
				details: error.details
			}
		}
	};
}
function approvalResponse(value) {
	const payload = record(value);
	if (typeof payload?.sessionId !== "string" || payload.sessionId.length === 0 || typeof payload.approvalId !== "string" || payload.approvalId.length === 0 || payload.outcome !== "allowed-once" && payload.outcome !== "rejected") return void 0;
	return {
		sessionId: payload.sessionId,
		approvalId: payload.approvalId,
		outcome: payload.outcome
	};
}
function questionResponse(value) {
	const payload = record(value);
	const answer = record(payload?.answer);
	if (typeof payload?.sessionId !== "string" || payload.sessionId.length === 0 || !Array.isArray(answer?.answers)) return void 0;
	const answers = [];
	for (const candidate of answer.answers) {
		const item = record(candidate);
		if (typeof item?.id !== "string" || !Array.isArray(item.selected) || !item.selected.every((value) => typeof value === "string") || item.custom !== void 0 && typeof item.custom !== "string") return void 0;
		answers.push({
			id: item.id,
			selected: item.selected,
			...item.custom === void 0 ? {} : { custom: item.custom }
		});
	}
	return {
		sessionId: payload.sessionId,
		answer: { answers }
	};
}
/** Maximum queued frames retained by one socket generation. */
const NATIVE_EVENT_QUEUE_MAX_FRAMES = 4096;
/** Maximum encoded frame bytes retained by one socket generation. */
const NATIVE_EVENT_QUEUE_MAX_BYTES = 8 * 1024 * 1024;
var NativeEventQueueError = class extends Error {
	code;
	details;
	constructor(code, message, details) {
		super(message);
		this.name = "NativeEventQueueError";
		this.code = code;
		this.details = details;
	}
};
/**
* Single-consumer bounded ring joining synchronous Host events to one socket.
* Overflow fails that generation so reconnect baselines/history recover every
* durable or replayable frame; no event class is silently discarded.
*/
var FrameQueue = class {
	buffer;
	head = 0;
	tail = 0;
	size = 0;
	bufferedBytes = 0;
	waiter;
	done = false;
	failure;
	maximumFrames = NATIVE_EVENT_QUEUE_MAX_FRAMES;
	maximumBytes = NATIVE_EVENT_QUEUE_MAX_BYTES;
	constructor() {
		this.buffer = Array.from({ length: this.maximumFrames }, () => void 0);
	}
	push(item) {
		if (this.done || this.failure !== void 0) return;
		let bytes;
		try {
			bytes = Buffer.byteLength(JSON.stringify(item), "utf8");
		} catch (error) {
			this.fail(new NativeEventQueueError("EVENT_FRAME_ENCODING_FAILED", `native event frame could not be encoded: ${String(error)}`, {
				maximumFrames: this.maximumFrames,
				maximumBytes: this.maximumBytes
			}));
			return;
		}
		if (this.size >= this.maximumFrames || bytes > this.maximumBytes || this.bufferedBytes + bytes > this.maximumBytes) {
			this.fail(new NativeEventQueueError("EVENT_QUEUE_OVERFLOW", "native event socket generation exceeded its bounded queue", {
				maximumFrames: this.maximumFrames,
				maximumBytes: this.maximumBytes,
				queuedFrames: this.size,
				queuedBytes: this.bufferedBytes,
				incomingBytes: bytes
			}));
			return;
		}
		this.buffer[this.tail] = {
			frame: item,
			bytes
		};
		this.tail = (this.tail + 1) % this.maximumFrames;
		this.size += 1;
		this.bufferedBytes += bytes;
		this.waiter?.();
	}
	end() {
		this.done = true;
		this.waiter?.();
	}
	async *iterate(signal, cleanup) {
		const onAbort = () => {
			this.waiter?.();
		};
		signal.addEventListener("abort", onAbort, { once: true });
		try {
			while (true) {
				if (signal.aborted) return;
				const frame = this.take();
				if (frame !== void 0) {
					yield frame;
					continue;
				}
				if (this.done) return;
				await new Promise((resolve) => {
					this.waiter = resolve;
				});
				this.waiter = void 0;
			}
		} finally {
			signal.removeEventListener("abort", onAbort);
			this.buffer.fill(void 0);
			this.size = 0;
			this.bufferedBytes = 0;
			cleanup();
		}
	}
	fail(error) {
		if (this.done || this.failure !== void 0) return;
		this.failure = error;
		this.waiter?.();
	}
	take() {
		if (this.failure !== void 0) throw this.failure;
		if (this.size === 0) return void 0;
		const queued = this.buffer[this.head];
		if (queued === void 0) throw new Error("native event queue ring invariant failed");
		this.buffer[this.head] = void 0;
		this.head = (this.head + 1) % this.maximumFrames;
		this.size -= 1;
		this.bufferedBytes -= queued.bytes;
		return queued.frame;
	}
};
function eventFrame(payload, rpcId = randomUUID()) {
	return {
		rpcId,
		payload
	};
}
function requestedFrame(pending) {
	return eventFrame({
		type: "approval/requested",
		sessionId: pending.sessionId,
		approvalId: pending.approvalId,
		toolName: pending.toolName,
		...pending.callId === void 0 ? {} : { callId: pending.callId },
		...pending.reason === void 0 ? {} : { reason: pending.reason }
	}, pending.rpcId);
}
function sessionBlank(session) {
	return !session.events.some((event) => event.type === "turn/start");
}
function sessionListFields(header, events) {
	const agentPreset = resolveSessionPreset({
		header,
		events
	});
	return {
		...header.parentSession === void 0 ? {} : { parentSessionId: header.parentSession },
		...header.origin === void 0 ? {} : { origin: header.origin },
		...header.cwd === void 0 ? {} : { cwd: header.cwd },
		...agentPreset === void 0 ? {} : { agentPreset }
	};
}
function jobViews(snapshots) {
	return snapshots.map((job) => ({
		id: job.id,
		kind: job.kind,
		label: job.label,
		status: job.status,
		...job.detail === void 0 ? {} : { detail: job.detail },
		startedAt: job.startedAt,
		...job.finishedAt === void 0 ? {} : { finishedAt: job.finishedAt }
	}));
}
function workspaceView(workspace) {
	return {
		workspaceId: workspace.id,
		path: workspace.path,
		title: workspace.title,
		sessionIds: [...workspace.sessionIds],
		createdAt: workspace.createdAt,
		updatedAt: workspace.updatedAt
	};
}
function changedWorkspaceView(workspaceId, value) {
	const record = workspaceRecord.parse(value);
	return {
		workspaceId,
		path: record.path,
		title: record.title,
		sessionIds: [...record.sessionIds],
		createdAt: record.createdAt,
		updatedAt: record.updatedAt
	};
}
function jsonArgs(event, args) {
	for (const [index, arg] of args.entries()) if (!isJsonValue(arg)) throw new Error(`forwarded host event "${event}" argument ${String(index)} is not lossless JSON data`);
	return args;
}
function toolEventView(ctx, event, argsFor, agent) {
	const tools = ctx.get("tools");
	if (tools === void 0) return void 0;
	try {
		if (event.type === "tool/call") {
			const data = event.data;
			const view = tools.get(data.name, agent)?.presentCall?.(JSON.parse(data.arguments));
			if (view === void 0 || !isJsonValue(view)) return void 0;
			return {
				for: "call",
				view
			};
		}
		if (event.type === "tool/result") {
			const { message, meta } = event.data;
			const result = message.content[0];
			const call = argsFor(message.source.callId);
			if (call === void 0) return void 0;
			const view = tools.get(call.name, agent)?.presentResult?.(call.args, {
				content: result.content,
				isError: result.isError === true,
				...meta === void 0 ? {} : { meta }
			});
			if (view === void 0 || !isJsonValue(view)) return void 0;
			return {
				for: "result",
				view
			};
		}
	} catch (error) {
		ctx.logger.warn(`host-native-events presenter failed for ${event.type}: ${String(error)}`);
	}
}
function queueItems(agent, splice) {
	const project = (target) => {
		const messages = target === "next-turn" ? agent.inbox.nextTurn : agent.inbox.nextStep;
		return splice?.target === target ? messages.toSpliced(splice.start, splice.removedCount ?? 0, ...splice.inserted) : messages;
	};
	return [...project("next-turn").map((message) => ({
		id: message.id,
		placement: "queued",
		message
	})), ...project("next-step").map((message) => ({
		id: message.id,
		placement: message.source.kind === "user" ? "steering" : "context",
		message
	}))];
}
function matchesQuestions(payload, pending) {
	if (payload.sessionId !== pending.sessionId) return false;
	if (payload.answer.answers.length !== pending.questions.length) return false;
	return payload.answer.answers.every((answer, index) => {
		const question = pending.questions[index];
		if (answer.id !== question.id) return false;
		if (new Set(answer.selected).size !== answer.selected.length) return false;
		const custom = answer.custom?.trim();
		if (custom !== void 0 && custom === "") return false;
		if (question.multiSelect !== true) {
			if (custom !== void 0 && answer.selected.length > 0) return false;
			if (answer.selected.length > 1) return false;
		}
		const labels = new Set(question.options?.map((option) => option.label) ?? []);
		return answer.selected.every((label) => labels.has(label));
	});
}
/** Sole Host owner for Native event projection and answer correlation. */
var NativeEventsService = class extends Service {
	static inject = [
		"agents",
		"connection",
		"sessions",
		"userQuestions",
		"workspaceRegistry"
	];
	pendingQuestions = /* @__PURE__ */ new Map();
	pendingApprovals = /* @__PURE__ */ new Map();
	muxQueues = /* @__PURE__ */ new Set();
	constructor(ctx) {
		super(ctx, "nativeEvents");
		ctx.connection.events.handle("mux", (signal) => this.openMux(signal));
		ctx.connection.events.handle("host", (signal) => this.openHost(signal));
		ctx.connection.responses.handle((message, signal) => this.respond(message, signal));
		ctx.inject(["sessionProjections"], (projectionCtx) => {
			projectionCtx.sessionProjections.onChanged((session, key, value, seq) => {
				this.broadcast({
					type: "session/projection",
					sessionId: session.id,
					key,
					value,
					seq
				});
			});
		});
		ctx.on("session/event", (session, event) => {
			if (event.type !== "agent/inbox/spliced") return;
			const agent = ctx.agents.get(session.id);
			if (agent?.session !== session) return;
			this.broadcast({
				type: "session/queue",
				sessionId: session.id,
				items: queueItems(agent, event.data)
			});
		});
		const disposeQuestions = ctx.userQuestions.registerProvider({ ask: (request) => this.askQuestion(request) });
		ctx.effect(() => () => {
			disposeQuestions();
			for (const pending of [...this.pendingQuestions.values()]) {
				this.claimQuestion(pending, "cancelled");
				pending.reject(new UserQuestionError("native user-questions provider was disposed", "ASK_ABORTED"));
			}
			for (const pending of [...this.pendingApprovals.values()]) pending.resolve("cancelled");
			for (const queue of this.muxQueues) queue.end();
			this.muxQueues.clear();
		}, "host-native-events: pending interactions");
		if (ctx.get("approval") !== void 0) this.registerApprovalAnswerer();
	}
	/**
	* Test whether one Session still owns an answerable human interaction.
	* @param sessionId - Session identity whose pending questions and approvals are inspected.
	* @returns whether at least one answerable interaction remains pending.
	*/
	hasPendingSession(sessionId) {
		return [...this.pendingQuestions.values()].some((pending) => pending.sessionId === sessionId) || [...this.pendingApprovals.values()].some((pending) => pending.sessionId === sessionId);
	}
	broadcast(payload) {
		const envelope = eventFrame(payload);
		for (const queue of this.muxQueues) queue.push(envelope);
	}
	askQuestion(request) {
		const sessionId = request.agent?.id;
		if (sessionId === void 0) return Promise.reject(new UserQuestionError("native user interaction requires an agent-owned session", "ASK_MISSING_AGENT"));
		if (request.signal?.aborted === true) return Promise.reject(new UserQuestionError("ask_user_question was aborted before the user answered", "ASK_ABORTED"));
		return new Promise((resolve, reject) => {
			const pending = {
				rpcId: randomUUID(),
				sessionId,
				questions: request.questions,
				resolve,
				reject,
				...request.signal === void 0 ? {} : { signal: request.signal }
			};
			const onAbort = () => {
				this.claimQuestion(pending, "cancelled");
				reject(new UserQuestionError("ask_user_question was aborted before the user answered", "ASK_ABORTED"));
			};
			pending.onAbort = onAbort;
			this.pendingQuestions.set(pending.rpcId, pending);
			request.signal?.addEventListener("abort", onAbort, { once: true });
			const envelope = eventFrame({
				type: "question/requested",
				sessionId,
				questions: request.questions
			}, pending.rpcId);
			for (const queue of this.muxQueues) queue.push(envelope);
		});
	}
	claimQuestion(pending, outcome) {
		if (!this.pendingQuestions.delete(pending.rpcId)) return;
		if (pending.signal !== void 0 && pending.onAbort !== void 0) pending.signal.removeEventListener("abort", pending.onAbort);
		this.broadcast({
			type: "question/resolved",
			sessionId: pending.sessionId,
			questionRpcId: pending.rpcId,
			outcome
		});
	}
	registerApprovalAnswerer() {
		this.ctx.on("approval/request", (request, next) => {
			if (request.signal?.aborted === true) return Promise.resolve("cancelled");
			const claimed = /* @__PURE__ */ new Set();
			for (const entry of this.pendingApprovals.values()) claimed.add(entry.approvalId);
			const decided = /* @__PURE__ */ new Set();
			let approvalId;
			for (let index = request.agent.session.events.length - 1; index >= 0; index -= 1) {
				const event = request.agent.session.events[index];
				if (event.type === "approval/decided") decided.add(event.data.id);
				else if (event.type === "approval/asked") {
					if (decided.has(event.data.id) || claimed.has(event.data.id)) continue;
					if ((request.callId ?? null) !== (event.data.callId ?? null)) continue;
					approvalId = event.data.id;
					break;
				}
			}
			if (approvalId === void 0) return next();
			const id = approvalId;
			return new Promise((resolve) => {
				const settle = (outcome) => {
					if (!this.pendingApprovals.delete(pending.rpcId)) return;
					request.signal?.removeEventListener("abort", onAbort);
					this.broadcast({
						type: "approval/resolved",
						sessionId: pending.sessionId,
						approvalId: id,
						outcome
					});
					resolve(outcome);
				};
				const onAbort = () => {
					settle("cancelled");
				};
				const pending = {
					rpcId: randomUUID(),
					sessionId: request.agent.session.id,
					approvalId: id,
					toolName: request.toolName,
					...request.callId === void 0 ? {} : { callId: request.callId },
					...request.reason === void 0 ? {} : { reason: request.reason },
					resolve: settle
				};
				this.pendingApprovals.set(pending.rpcId, pending);
				request.signal?.addEventListener("abort", onAbort, { once: true });
				const envelope = requestedFrame(pending);
				for (const queue of this.muxQueues) queue.push(envelope);
			});
		});
	}
	respond(message, signal) {
		signal.throwIfAborted();
		const envelope = clientResponse(message);
		if (envelope === void 0) return {
			accepted: false,
			reason: "bad-response"
		};
		const approval = this.pendingApprovals.get(envelope.rpcId);
		if (approval !== void 0) {
			if (!envelope.result.ok) return {
				accepted: false,
				reason: "bad-response"
			};
			const payload = approvalResponse(envelope.result.value);
			if (payload === void 0 || payload.sessionId !== approval.sessionId || payload.approvalId !== approval.approvalId) return {
				accepted: false,
				reason: "bad-response"
			};
			signal.throwIfAborted();
			approval.resolve(payload.outcome);
			return { accepted: true };
		}
		const pending = this.pendingQuestions.get(envelope.rpcId);
		if (pending === void 0) return {
			accepted: false,
			reason: "not-pending"
		};
		if (!envelope.result.ok) {
			if (envelope.result.error.code !== "cancelled") return {
				accepted: false,
				reason: "bad-response"
			};
			signal.throwIfAborted();
			this.claimQuestion(pending, "cancelled");
			pending.reject(new UserQuestionError("the user cancelled ask_user_question", "ASK_CANCELLED"));
			return { accepted: true };
		}
		const payload = questionResponse(envelope.result.value);
		if (payload === void 0 || !matchesQuestions(payload, pending)) return {
			accepted: false,
			reason: "bad-response"
		};
		signal.throwIfAborted();
		this.claimQuestion(pending, "answered");
		pending.resolve({ answers: payload.answer.answers.map((answer) => ({
			id: answer.id,
			selected: answer.selected,
			...answer.custom === void 0 ? {} : { custom: answer.custom }
		})) });
		return { accepted: true };
	}
	openMux(signal) {
		const queue = new FrameQueue();
		this.muxQueues.add(queue);
		const generation = randomUUID();
		const sessions = this.ctx.sessions.list();
		const sessionIds = sessions.map((session) => session.id);
		queue.push(eventFrame({
			type: "stream/baseline",
			channel: "mux",
			generation,
			phase: "begin"
		}));
		for (const session of sessions) queue.push(eventFrame({
			type: "session/subscribed",
			sessionId: session.id,
			lastSeq: session.seq - 1
		}));
		for (const pending of this.pendingQuestions.values()) queue.push(eventFrame({
			type: "question/requested",
			sessionId: pending.sessionId,
			questions: pending.questions
		}, pending.rpcId));
		for (const pending of this.pendingApprovals.values()) queue.push(requestedFrame(pending));
		for (const session of sessions) {
			const agent = this.ctx.agents.get(session.id);
			if (agent?.session === session && agent.inbox.hasPending) queue.push(eventFrame({
				type: "session/queue",
				sessionId: session.id,
				items: queueItems(agent)
			}));
		}
		const jobs = this.ctx.get("jobs");
		if (jobs !== void 0) for (const session of sessions) {
			const views = jobViews(jobs.list(this.ctx.agents.get(session.id)));
			if (views.length > 0) queue.push(eventFrame({
				type: "session/jobs",
				sessionId: session.id,
				jobs: views
			}));
		}
		const openCalls = /* @__PURE__ */ new Map();
		const disposers = [
			this.ctx.on("session/event", (session, event) => {
				if (event.type === "tool/call") {
					const data = event.data;
					try {
						let table = openCalls.get(session.id);
						if (table === void 0) {
							table = /* @__PURE__ */ new Map();
							openCalls.set(session.id, table);
						}
						table.set(data.callId, {
							name: data.name,
							args: JSON.parse(data.arguments)
						});
					} catch {}
				} else if (event.type === "turn/end") openCalls.delete(session.id);
				const agent = this.ctx.agents.get(session.id);
				const view = toolEventView(this.ctx, event, (callId) => openCalls.get(session.id)?.get(callId) ?? findToolCallArguments(session.events, callId), agent);
				queue.push(eventFrame({
					type: "session/event",
					sessionId: session.id,
					event,
					...view === void 0 ? {} : { view }
				}));
			}),
			this.ctx.on("session/created", (session) => {
				queue.push(eventFrame({
					type: "session/subscribed",
					sessionId: session.id,
					lastSeq: session.seq - 1
				}));
				const views = jobs === void 0 ? [] : jobViews(jobs.list(this.ctx.agents.get(session.id)));
				if (views.length > 0) queue.push(eventFrame({
					type: "session/jobs",
					sessionId: session.id,
					jobs: views
				}));
			}),
			this.ctx.on("session/disposed", (session) => {
				openCalls.delete(session.id);
			}),
			...jobs === void 0 ? [] : [jobs.onJobsChanged((owner) => {
				if (owner !== void 0) {
					queue.push(eventFrame({
						type: "session/jobs",
						sessionId: owner.id,
						jobs: jobViews(jobs.list(owner))
					}));
					return;
				}
				for (const session of this.ctx.sessions.list()) queue.push(eventFrame({
					type: "session/jobs",
					sessionId: session.id,
					jobs: jobViews(jobs.list(this.ctx.agents.get(session.id)))
				}));
			})]
		];
		queue.push(eventFrame({
			type: "stream/baseline",
			channel: "mux",
			generation,
			phase: "complete",
			sessionIds
		}));
		return queue.iterate(signal, () => {
			this.muxQueues.delete(queue);
			for (const dispose of disposers) dispose();
		});
	}
	openHost(signal) {
		const queue = new FrameQueue();
		const generation = randomUUID();
		const sessions = this.ctx.sessions.list();
		const sessionIds = sessions.map((session) => session.id);
		queue.push(eventFrame({
			type: "stream/baseline",
			channel: "host",
			generation,
			phase: "begin"
		}));
		const committedWorkspaces = this.ctx.workspaceRegistry.list();
		const committedWorkspaceIds = new Set(committedWorkspaces.map((workspace) => String(workspace.id)));
		let committedWorkspaceOrder = committedWorkspaces.map((workspace) => workspace.id);
		for (const session of sessions) queue.push(eventFrame({
			type: "host/session-status",
			sessionId: session.id,
			running: this.ctx.agents.get(session.id)?.status === "running"
		}));
		const disposers = [
			this.ctx.on("workspace/archived-sessions-changed", (archivedSessionIds) => {
				queue.push(eventFrame({
					type: "host/archived-sessions-changed",
					archivedSessionIds: [...archivedSessionIds]
				}));
			}),
			this.ctx.on("workspace/session-deleted", (sessionId, archivedSessionIds) => {
				queue.push(eventFrame({
					type: "host/session-deleted",
					sessionId,
					archivedSessionIds: [...archivedSessionIds]
				}));
			}),
			this.ctx.on("session/created", (session) => {
				queue.push(eventFrame({
					type: "host/session-added",
					sessionId: session.id,
					blank: sessionBlank(session),
					...sessionListFields(session.header, session.events)
				}));
			}),
			this.ctx.on("session/disposed", (session) => {
				queue.push(eventFrame({
					type: "host/session-removed",
					sessionId: session.id
				}));
			}),
			this.ctx.on("agent/status", ({ agent, status }) => {
				queue.push(eventFrame({
					type: "host/session-status",
					sessionId: agent.id,
					running: status === "running"
				}));
			}),
			this.ctx.on("agent/error", ({ agent, error }) => {
				queue.push(eventFrame({
					type: "host/agent-error",
					sessionId: agent.id,
					message: errorChain(error)
				}));
			}),
			this.ctx.on("domain/changed", (change) => {
				if (change.domain !== "workspace") return;
				if (change.table === "") {
					if (change.operation !== "put") return;
					const state = workspaceDomainState.parse(change.value);
					const orderChanged = state.workspaceIds.length === committedWorkspaceOrder.length && state.workspaceIds.every((workspaceId) => committedWorkspaceIds.has(String(workspaceId))) && state.workspaceIds.some((workspaceId, index) => workspaceId !== committedWorkspaceOrder[index]);
					for (const workspaceId of state.workspaceIds) {
						if (committedWorkspaceIds.has(workspaceId)) continue;
						const workspace = this.ctx.workspaceRegistry.get(workspaceId);
						if (workspace === void 0) throw new Error(`committed workspace registry references missing workspace "${workspaceId}"`);
						committedWorkspaceIds.add(workspaceId);
						queue.push(eventFrame({
							type: "host/workspace-changed",
							workspace: workspaceView(workspace)
						}));
					}
					committedWorkspaceOrder = [...state.workspaceIds];
					if (orderChanged) queue.push(eventFrame({
						type: "host/workspace-order-changed",
						workspaceIds: [...state.workspaceIds]
					}));
					return;
				}
				if (change.table !== "workspaces") return;
				if (change.operation === "deleted") {
					if (!committedWorkspaceIds.delete(change.key)) return;
					queue.push(eventFrame({
						type: "host/workspace-removed",
						workspaceId: change.key
					}));
					return;
				}
				if (!committedWorkspaceIds.has(change.key)) return;
				queue.push(eventFrame({
					type: "host/workspace-changed",
					workspace: changedWorkspaceView(change.key, change.value)
				}));
			}),
			...API_REMOTE_FORWARDED_EVENTS.map((name) => this.ctx.on(name, ((...args) => {
				queue.push(eventFrame({
					type: "host/remote-event",
					event: name,
					args: jsonArgs(name, args)
				}));
			})))
		];
		queue.push(eventFrame({
			type: "stream/baseline",
			channel: "host",
			generation,
			phase: "complete",
			sessionIds
		}));
		return queue.iterate(signal, () => {
			for (const dispose of disposers) dispose();
		});
	}
};
//#endregion
export { NATIVE_EVENT_QUEUE_MAX_BYTES, NATIVE_EVENT_QUEUE_MAX_FRAMES, NativeEventsService, NativeEventsService as default };
