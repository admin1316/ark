import z from "@deepseek-ai/schemastery";
import { errorChain } from "@deepseek-ai/dsh-llm";
import { canOpenNativePath, openNativePath } from "@deepseek-ai/dsh-native-command";
import { Remote, TypertLookupFailure, TypertRemoteFailure, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { mkdir } from "node:fs/promises";
import { sessionModelSelection } from "@deepseek-ai/dsh-agent-default-model/session-selection";
import { SessionQueryError } from "@deepseek-ai/dsh-session-query";
import { apiRemoteSubagentOwnershipError, hasApiRemoteSubagentOwner } from "@deepseek-ai/dsh-api-remotes/agent-lookup";
import { isAppendSurfaceEvent } from "@deepseek-ai/dsh-session";
import { isChunkRow, packChunkRuns } from "@deepseek-ai/dsh-session/chunk-rows";
import { isUserInvocable } from "@deepseek-ai/dsh-skill";
//#region lib/types/agent.js
/** Agent activation, composition, and model-selection policy owned by API Session. */
var __addDisposableResource$3 = function(env, value, async) {
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
		if (inner) dispose = function() {
			try {
				inner.call(this);
			} catch (e) {
				return Promise.reject(e);
			}
		};
		env.stack.push({
			value,
			dispose,
			async
		});
	} else if (async) env.stack.push({ async: true });
	return value;
};
var __disposeResources$3 = (function(SuppressedError) {
	return function(env) {
		function fail(e) {
			env.error = env.hasError ? new SuppressedError(e, env.error, "An error was suppressed during disposal.") : e;
			env.hasError = true;
		}
		var r, s = 0;
		function next() {
			while (r = env.stack.pop()) try {
				if (!r.async && s === 1) return s = 0, env.stack.push(r), Promise.resolve().then(next);
				if (r.dispose) {
					var result = r.dispose.call(r.value);
					if (r.async) return s |= 2, Promise.resolve(result).then(next, function(e) {
						fail(e);
						return next();
					});
				} else s |= 1;
			} catch (e) {
				fail(e);
			}
			if (s === 1) return env.hasError ? Promise.reject(env.error) : Promise.resolve();
			if (env.hasError) throw env.error;
		}
		return next();
	};
})(typeof SuppressedError === "function" ? SuppressedError : function(error, suppressed, message) {
	var e = new Error(message);
	return e.name = "SuppressedError", e.error = error, e.suppressed = suppressed, e;
});
/** Cold Session identity absent from persistence. */
var ApiSessionNotFound = class extends Error {};
/** Session identity whose lifecycle belongs to subagent routing. */
var ApiSessionSubagentOwnership = class extends Error {
	sessionId;
	/** @param sessionId - identity reserved to subagent routing. */
	constructor(sessionId) {
		super(`session "${sessionId}" is a subagent session; use subagent delivery`);
		this.sessionId = sessionId;
	}
};
/** Explicit-id creation attempted to adopt a Session under another cwd. */
var ApiSessionCwdConflict = class extends Error {
	sessionId;
	requestedCwd;
	existingCwd;
	constructor(sessionId, requestedCwd, existingCwd) {
		super(existingCwd === void 0 ? `session "${sessionId}" records no cwd and cannot be adopted for "${requestedCwd}"` : `session "${sessionId}" belongs to "${existingCwd}", not "${requestedCwd}"`);
		this.sessionId = sessionId;
		this.requestedCwd = requestedCwd;
		this.existingCwd = existingCwd;
	}
};
/** Explicit-id creation attempted to adopt a Session under another preset. */
var ApiSessionPresetConflict = class extends Error {
	sessionId;
	requestedPreset;
	existingPreset;
	constructor(sessionId, requestedPreset, existingPreset) {
		super(existingPreset === void 0 ? `session "${sessionId}" records no agent preset and cannot be adopted under "${requestedPreset}"` : `session "${sessionId}" runs agent preset "${existingPreset}", not "${requestedPreset}"`);
		this.sessionId = sessionId;
		this.requestedPreset = requestedPreset;
		this.existingPreset = existingPreset;
	}
};
/**
* Inspect one cold Session without repairing, resuming, or publishing it.
* @param ctx - Host context carrying Session persistence.
* @param sessionId - durable Session identity.
* @param signal - optional cancellation for persistence reads.
* @returns the persisted header and complete event prefix.
*/
async function inspectApiSession(ctx, sessionId, signal) {
	try {
		const env_1 = {
			stack: [],
			error: void 0,
			hasError: false
		};
		try {
			const observation = __addDisposableResource$3(env_1, await ctx.sessionQuery.observeSession(sessionId, {
				...signal === void 0 ? {} : { signal },
				projectionMode: "none"
			}), false);
			if (observation.header.cwd === void 0) throw new ApiSessionNotFound(`session "${sessionId}" not found`);
			return {
				meta: observation.header,
				events: [...observation.events]
			};
		} catch (e_1) {
			env_1.error = e_1;
			env_1.hasError = true;
		} finally {
			__disposeResources$3(env_1);
		}
	} catch (error) {
		if (error instanceof SessionQueryError && error.code === "SESSION_QUERY_SESSION_NOT_FOUND") throw new ApiSessionNotFound(`session "${sessionId}" not found`);
		throw error;
	}
}
/** Owns every operation that may create, resume, or configure a Web Agent. */
var ApiSessionAgentController = class {
	ctx;
	resumes = /* @__PURE__ */ new Map();
	creations = /* @__PURE__ */ new Map();
	imageAdmissionChains = /* @__PURE__ */ new WeakMap();
	/** @param ctx - Host context carrying Agent, model, persistence, and Typert services. */
	constructor(ctx) {
		this.ctx = ctx;
		ctx.typert.lookups.configure("agent", async (sessionId) => {
			const found = await this.resolveAgent(sessionId);
			if ("error" in found) throw new TypertLookupFailure(found.error);
			return found.agent;
		});
		ctx.typert.lookups.configure("session", async (sessionId) => {
			const found = await this.resolveAgent(sessionId);
			if ("error" in found) throw new TypertLookupFailure(found.error);
			return found.agent.session;
		});
		ctx.typert.contexts.configureHost("agent", async (sessionId) => {
			const found = await this.resolveAgent(sessionId);
			if ("error" in found) throw new TypertLookupFailure(found.error);
			return found.agent.ctx;
		});
	}
	/**
	* Resolve or resume one ordinary Session, deduplicating concurrent resumes.
	* @param sessionId - ordinary Session identity.
	* @returns the live Agent or a stable Session-domain failure.
	*/
	async resolveAgent(sessionId) {
		return this.resolve(sessionId);
	}
	/**
	* Resolve one ordinary Session from an already-retained exact observation.
	* @param observation - Host-owned observation whose preparation stays pinned through setup.
	* @returns the live Agent or a stable Session-domain failure.
	*/
	async resolveObservedAgent(observation) {
		return this.resolve(observation.header.id, observation);
	}
	async resolve(sessionId, observation) {
		const live = this.liveAgent(sessionId);
		if (live !== void 0) return live;
		const attached = this.ctx.sessions.get(sessionId);
		if (attached !== void 0 && hasApiRemoteSubagentOwner(this.ctx, attached, void 0)) return { error: apiRemoteSubagentOwnershipError(sessionId) };
		let resume = this.resumes.get(sessionId);
		if (resume === void 0) {
			resume = this.resume(sessionId, observation).finally(() => {
				this.resumes.delete(sessionId);
			});
			this.resumes.set(sessionId, resume);
		}
		try {
			return { agent: await resume };
		} catch (error) {
			if (error instanceof ApiSessionNotFound) return { error: {
				code: "session-not-found",
				message: error.message,
				details: { sessionId }
			} };
			if (error instanceof ApiSessionSubagentOwnership) return { error: apiRemoteSubagentOwnershipError(error.sessionId) };
			const raced = this.liveAgent(sessionId);
			if (raced !== void 0) return raced;
			const racedSession = this.ctx.sessions.get(sessionId);
			if (racedSession !== void 0 && hasApiRemoteSubagentOwner(this.ctx, racedSession, void 0)) return { error: apiRemoteSubagentOwnershipError(sessionId) };
			return { error: {
				code: "internal",
				message: `resume failed for session "${sessionId}": ${String(error)}`,
				details: {}
			} };
		}
	}
	/**
	* Resolve one requested identity, creating or resuming it once.
	* @param sessionId - requested Session identity.
	* @param cwd - directory the Session must own.
	* @param checkPersistedIdentity - whether to inspect a cold identity before creation.
	* @param presetId - optional Agent preset the Session must own.
	* @returns the matching live ordinary Agent.
	*/
	async ensureSession(sessionId, cwd, checkPersistedIdentity, presetId) {
		let creation = this.creations.get(sessionId);
		if (creation === void 0) {
			creation = this.createOrAdopt(sessionId, cwd, checkPersistedIdentity, presetId).catch((error) => {
				const live = this.ctx.agents.get(sessionId);
				if (live !== void 0) {
					if (hasApiRemoteSubagentOwner(this.ctx, live.session, live)) throw new ApiSessionSubagentOwnership(sessionId);
					return live;
				}
				const attached = this.ctx.sessions.get(sessionId);
				if (attached !== void 0 && hasApiRemoteSubagentOwner(this.ctx, attached, void 0)) throw new ApiSessionSubagentOwnership(sessionId);
				throw error;
			}).finally(() => {
				this.creations.delete(sessionId);
			});
			this.creations.set(sessionId, creation);
		}
		const agent = await creation;
		if (hasApiRemoteSubagentOwner(this.ctx, agent.session, agent)) throw new ApiSessionSubagentOwnership(sessionId);
		if (presetId !== void 0) this.assertPresetUnchanged(sessionId, presetId, this.presetForSession(agent.session));
		if (agent.session.header.cwd !== cwd) throw new ApiSessionCwdConflict(sessionId, cwd, agent.session.header.cwd);
		return agent;
	}
	/**
	* Install or return the Session-local model selection used by prompt assembly.
	* @param agent - live Agent that owns the selection.
	* @returns the installed mutable selection reference.
	*/
	selectionFor(agent) {
		return sessionModelSelection(this.ctx, agent);
	}
	/**
	* Read the current Agent preset from the Session projection.
	* @param session - live Session whose projection state is available.
	* @returns the current preset, or undefined when the capability is absent.
	*/
	presetForSession(session) {
		return this.ctx.sessionProjections.stateOf(session, "agentPreset") ?? void 0;
	}
	/**
	* Serialize image admission and model selection for one Agent.
	* @param agent - live Agent that owns the serialization chain.
	* @param operation - asynchronous operation admitted after prior work settles.
	* @returns the operation result or rejection.
	*/
	serializeImageAdmission(agent, operation) {
		const result = (this.imageAdmissionChains.get(agent) ?? Promise.resolve()).then(operation);
		this.imageAdmissionChains.set(agent, result.then(() => void 0, () => void 0));
		return result;
	}
	/**
	* Resolve the preset id and pre-publication Agent setup for a create or resume.
	* @param presetId - requested preset or the configured default when omitted.
	* @returns the resolved preset identity and Agent setup callback.
	*/
	async composeAgent(presetId) {
		const presets = this.ctx.get("agentPresets");
		if (presets === void 0) return { setup: (agentCtx) => {
			this.installSelection(agentCtx);
		} };
		const resolvedId = (await presets.resolve(presetId)).id;
		return {
			agentPreset: resolvedId,
			setup: async (agentCtx) => {
				this.installSelection(agentCtx);
				await presets.mount(agentCtx, resolvedId);
			}
		};
	}
	liveAgent(sessionId) {
		const agent = this.ctx.agents.get(sessionId);
		if (agent === void 0) return void 0;
		return hasApiRemoteSubagentOwner(this.ctx, agent.session, agent) ? { error: apiRemoteSubagentOwnershipError(sessionId) } : { agent };
	}
	async resume(sessionId, supplied) {
		if (supplied !== void 0) return this.resumeObserved(sessionId, supplied);
		try {
			const env_2 = {
				stack: [],
				error: void 0,
				hasError: false
			};
			try {
				const observation = __addDisposableResource$3(env_2, await this.ctx.sessionQuery.observeSession(sessionId), false);
				return await this.resumeObserved(sessionId, observation);
			} catch (e_2) {
				env_2.error = e_2;
				env_2.hasError = true;
			} finally {
				__disposeResources$3(env_2);
			}
		} catch (error) {
			if (error instanceof SessionQueryError && error.code === "SESSION_QUERY_SESSION_NOT_FOUND") throw new ApiSessionNotFound(`session "${sessionId}" not found`);
			throw error;
		}
	}
	async resumeObserved(sessionId, observation) {
		if (observation.header.id !== sessionId || observation.header.cwd === void 0) throw new ApiSessionNotFound(`session "${sessionId}" not found`);
		if (hasApiRemoteSubagentOwner(this.ctx, { header: observation.header }, void 0)) throw new ApiSessionSubagentOwnership(sessionId);
		const composition = await this.composeAgent(this.presetForObservation(observation));
		const published = this.ctx.sessions.get(sessionId);
		const live = this.ctx.agents.get(sessionId);
		if (published !== void 0 && hasApiRemoteSubagentOwner(this.ctx, published, live)) throw new ApiSessionSubagentOwnership(sessionId);
		return (await this.ctx.agents.resume({
			resumeSessionId: sessionId,
			agentOptions: this.agentOptions(),
			setup: composition.setup
		})).agent;
	}
	async createOrAdopt(sessionId, cwd, checkPersistedIdentity, presetId) {
		const attached = this.ctx.sessions.get(sessionId);
		const live = this.ctx.agents.get(sessionId);
		if (attached !== void 0 && hasApiRemoteSubagentOwner(this.ctx, attached, live)) throw new ApiSessionSubagentOwnership(sessionId);
		if (live !== void 0) return live;
		if (checkPersistedIdentity) try {
			const env_3 = {
				stack: [],
				error: void 0,
				hasError: false
			};
			try {
				const observation = __addDisposableResource$3(env_3, await this.ctx.sessionQuery.observeSession(sessionId), false);
				if (hasApiRemoteSubagentOwner(this.ctx, { header: observation.header }, void 0)) throw new ApiSessionSubagentOwnership(sessionId);
				if (observation.header.cwd !== cwd) throw new ApiSessionCwdConflict(sessionId, cwd, observation.header.cwd);
				const storedPreset = this.presetForObservation(observation);
				this.assertPresetUnchanged(sessionId, presetId, storedPreset);
				const composition = await this.composeAgent(storedPreset);
				return (await this.ctx.agents.resume({
					resumeSessionId: sessionId,
					agentOptions: this.agentOptions(),
					setup: composition.setup
				})).agent;
			} catch (e_3) {
				env_3.error = e_3;
				env_3.hasError = true;
			} finally {
				__disposeResources$3(env_3);
			}
		} catch (error) {
			if (!(error instanceof SessionQueryError) || error.code !== "SESSION_QUERY_SESSION_NOT_FOUND") throw error;
		}
		try {
			await mkdir(cwd, { recursive: true });
		} catch (error) {
			throw new Error(`failed to ensure project directory "${cwd}": ${String(error)}`, { cause: error });
		}
		const composition = await this.composeAgent(presetId);
		return (await this.ctx.agents.create({
			sessionId,
			agentOptions: this.agentOptions(),
			meta: {
				cwd,
				...composition.agentPreset === void 0 ? {} : { agentPreset: composition.agentPreset }
			},
			setup: composition.setup
		})).agent;
	}
	agentOptions() {
		const { provider, model } = this.ctx.agentDefaultModel.currentSelection();
		return {
			provider,
			model
		};
	}
	installSelection(agentCtx) {
		const agent = agentCtx.agent;
		if (agent === void 0) throw new Error("api-session: Agent setup has no scoped Agent");
		this.selectionFor(agent);
	}
	/**
	* Read the current Agent preset from an all-projections observation.
	* @param observation - exact Session observation carrying its projection snapshot.
	* @returns the current preset, or undefined when the capability is absent.
	*/
	presetForObservation(observation) {
		if (observation.projections === void 0) throw new Error("api-session: Agent activation requires a projected Session observation");
		return observation.projections.values.agentPreset ?? void 0;
	}
	assertPresetUnchanged(sessionId, requested, existing) {
		if (requested === void 0 || requested === existing) return;
		throw new ApiSessionPresetConflict(sessionId, requested, existing);
	}
};
//#endregion
//#region lib/types/control.js
/** Live Session queue, jobs, and projection state with reconnect baselines. */
/** Owns the Host-wide Session control stream. */
var SessionControlController = class {
	ctx;
	streams = /* @__PURE__ */ new Set();
	/** @param ctx - Host context carrying live Agent, projection, and jobs services. */
	constructor(ctx) {
		this.ctx = ctx;
		ctx.on("session/event", (session, event) => {
			this.onSessionEvent(session, event);
		});
		ctx.inject(["sessionProjections"], (projectionCtx) => {
			projectionCtx.sessionProjections.onChanged((session, key, value, seq) => {
				this.broadcast({
					type: "projection",
					sessionId: session.id,
					key,
					value,
					seq
				});
			});
		});
		ctx.inject(["jobs"], (jobsCtx) => {
			jobsCtx.jobs.onJobsChanged((owner) => {
				this.onJobsChanged(owner);
			});
		});
		ctx.on("session/created", (session) => {
			const jobs = this.jobsFor(this.ctx.agents.get(session.id));
			if (jobs.length > 0) this.broadcast({
				type: "jobs",
				sessionId: session.id,
				jobs
			});
		});
		ctx.effect(() => () => {
			for (const stream of this.streams) stream.end();
			this.streams.clear();
		}, "session-controller.control");
	}
	/**
	* Open one generation of Host-wide live control state.
	* @param signal - Remote stream cancellation.
	* @returns one complete baseline followed by live replacement frames.
	*/
	async *control(signal) {
		signal.throwIfAborted();
		const queue = new ControlQueue();
		this.streams.add(queue);
		try {
			yield {
				type: "baseline",
				value: this.baseline()
			};
			yield* queue.iterate(signal);
		} finally {
			this.streams.delete(queue);
			queue.end();
		}
	}
	baseline() {
		const sessions = this.ctx.sessions.list();
		const queues = Object.create(null);
		const jobs = Object.create(null);
		for (const session of sessions) {
			const agent = this.ctx.agents.get(session.id);
			queues[session.id] = agent?.session === session ? queueItems(agent) : [];
			jobs[session.id] = this.jobsFor(agent);
		}
		return {
			queues,
			jobs,
			projections: this.projectionBaseline(sessions)
		};
	}
	projectionBaseline(sessions) {
		const registry = this.ctx.get("sessionProjections");
		const blocks = Object.create(null);
		for (const session of sessions) {
			const snapshot = registry?.snapshot(session);
			blocks[session.id] = snapshot === void 0 ? {
				asOfSeq: session.seq - 1,
				values: {}
			} : {
				asOfSeq: snapshot.asOfSeq,
				values: snapshot.values
			};
		}
		return blocks;
	}
	onSessionEvent(session, event) {
		if (event.type !== "agent/inbox/spliced") return;
		const agent = this.ctx.agents.get(session.id);
		if (agent?.session !== session) return;
		this.broadcast({
			type: "queue",
			sessionId: session.id,
			items: queueItems(agent, event.data)
		});
	}
	onJobsChanged(owner) {
		if (owner !== void 0) {
			this.broadcast({
				type: "jobs",
				sessionId: owner.id,
				jobs: this.jobsFor(owner)
			});
			return;
		}
		for (const session of this.ctx.sessions.list()) this.broadcast({
			type: "jobs",
			sessionId: session.id,
			jobs: this.jobsFor(this.ctx.agents.get(session.id))
		});
	}
	jobsFor(agent) {
		const jobs = this.ctx.get("jobs");
		return jobs === void 0 ? [] : jobs.list(agent).map(jobView);
	}
	broadcast(frame) {
		for (const stream of this.streams) stream.push(frame);
	}
};
var ControlQueue = class {
	buffer = [];
	wake;
	done = false;
	push(frame) {
		if (this.done) return;
		this.buffer.push(frame);
		const wake = this.wake;
		this.wake = void 0;
		wake?.();
	}
	end() {
		if (this.done) return;
		this.done = true;
		const wake = this.wake;
		this.wake = void 0;
		wake?.();
	}
	async *iterate(signal) {
		const onAbort = () => {
			this.end();
		};
		signal.addEventListener("abort", onAbort, { once: true });
		try {
			while (!this.done && !signal.aborted) {
				const frame = this.buffer.shift();
				if (frame !== void 0) {
					yield frame;
					continue;
				}
				await new Promise((resolve) => {
					this.wake = resolve;
				});
			}
			while (this.buffer.length > 0 && !signal.aborted) yield this.buffer.shift();
		} finally {
			signal.removeEventListener("abort", onAbort);
			this.end();
		}
	}
};
function queueItems(agent, splice) {
	return [...agent.inbox.project("next-turn", splice).map((message) => ({
		id: message.id,
		placement: "queued",
		...promptRpcId(message),
		message: {
			id: message.id,
			content: message.content
		}
	})), ...agent.inbox.project("next-step", splice).map((message) => ({
		id: message.id,
		placement: message.source.kind === "user" ? "steering" : "context",
		...promptRpcId(message),
		message: {
			id: message.id,
			content: message.content
		}
	}))];
}
/** Prompt-RPC identity carried by a browser-submitted message's user source. */
function promptRpcId(message) {
	const source = message.source;
	if (source.kind !== "user") return {};
	if ("invocationId" in source && typeof source.invocationId === "string") return { rpcId: source.invocationId };
	return "rpcId" in source && typeof source.rpcId === "string" ? { rpcId: source.rpcId } : {};
}
function jobView(job) {
	return {
		id: job.id,
		kind: job.kind,
		label: job.label,
		status: job.status,
		...job.detail === void 0 ? {} : { detail: job.detail },
		startedAt: job.startedAt,
		...job.finishedAt === void 0 ? {} : { finishedAt: job.finishedAt }
	};
}
//#endregion
//#region lib/types/history.js
/** Cold Session history pagination and live-event source. */
var __addDisposableResource$2 = function(env, value, async) {
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
		if (inner) dispose = function() {
			try {
				inner.call(this);
			} catch (e) {
				return Promise.reject(e);
			}
		};
		env.stack.push({
			value,
			dispose,
			async
		});
	} else if (async) env.stack.push({ async: true });
	return value;
};
var __disposeResources$2 = (function(SuppressedError) {
	return function(env) {
		function fail(e) {
			env.error = env.hasError ? new SuppressedError(e, env.error, "An error was suppressed during disposal.") : e;
			env.hasError = true;
		}
		var r, s = 0;
		function next() {
			while (r = env.stack.pop()) try {
				if (!r.async && s === 1) return s = 0, env.stack.push(r), Promise.resolve().then(next);
				if (r.dispose) {
					var result = r.dispose.call(r.value);
					if (r.async) return s |= 2, Promise.resolve(result).then(next, function(e) {
						fail(e);
						return next();
					});
				} else s |= 1;
			} catch (e) {
				fail(e);
			}
			if (s === 1) return env.hasError ? Promise.reject(env.error) : Promise.resolve();
			if (env.hasError) throw env.error;
		}
		return next();
	};
})(typeof SuppressedError === "function" ? SuppressedError : function(error, suppressed, message) {
	var e = new Error(message);
	return e.name = "SuppressedError", e.error = error, e.suppressed = suppressed, e;
});
const DEFAULT_MAX_MESSAGES = 50;
const MESSAGE_TYPES = new Set(["user/message", "assistant/message"]);
/** Implements cold-safe history operations delegated by the Session Controller. */
var SessionHistoryController = class {
	ctx;
	promote;
	closeFollowers = /* @__PURE__ */ new Set();
	/**
	* @param ctx - Host context carrying Session query and projection services.
	* @param promote - starts ordinary Session activation after snapshot delivery.
	*/
	constructor(ctx, promote) {
		this.ctx = ctx;
		this.promote = promote;
		ctx.effect(() => () => {
			for (const close of this.closeFollowers) close();
			this.closeFollowers.clear();
		}, "session-controller.history");
	}
	/**
	* Read one message-aligned history page without activating an Agent.
	* @param request - durable address and backwards-page cursor.
	* @param signal - caller cancellation for persistence reads.
	* @returns a contiguous event page.
	*/
	async page(request, signal) {
		const env_1 = {
			stack: [],
			error: void 0,
			hasError: false
		};
		try {
			validatePageRequest(request);
			const source = __addDisposableResource$2(env_1, await this.sourceFor(request.address, signal, false), false);
			signal.throwIfAborted();
			const sourceLog = source.events;
			const sourceCursor = sourceLog.at(-1)?.seq ?? -1;
			if (request.throughSeq > sourceCursor) reject("bad-request", `session page through seq ${String(request.throughSeq)} is past cursor ${String(sourceCursor)}`, {});
			/* v8 ignore next -- Session and persistence validation guarantee a dense zero-based event prefix. */
			if (request.throughSeq >= 0 && sourceLog[request.throughSeq]?.seq !== request.throughSeq) reject("internal", `session log does not contain through seq ${String(request.throughSeq)}`, {});
			const page = paginate(sourceLog, request.beforeSeq, request.maxMessages ?? DEFAULT_MAX_MESSAGES, request.throughSeq);
			return {
				records: pageRecords(page.events),
				hasMore: page.hasMore
			};
		} catch (e_1) {
			env_1.error = e_1;
			env_1.hasError = true;
		} finally {
			__disposeResources$2(env_1);
		}
	}
	/**
	* Follow events appended after an initial cursor on one durable address.
	* @param request - durable address and last committed sequence already held by the caller.
	* @param signal - stream cancellation owned by the Remote carrier.
	* @returns a complete opening snapshot followed by gap-free event frames.
	*/
	async *follow(request, signal) {
		validateFollowRequest(request);
		const { address } = request;
		const target = addressId(address);
		const buffered = [];
		let snapshotCursor;
		let wake;
		const notify = () => {
			const resume = wake;
			wake = void 0;
			resume?.();
		};
		const follower = { closed: false };
		const close = () => {
			follower.closed = true;
			notify();
		};
		this.closeFollowers.add(close);
		const disposeEvent = this.ctx.on("session/event", (session, event) => {
			if (session.id !== target) return;
			buffered.push(event);
			notify();
		}, { global: true });
		const disposeCreated = this.ctx.on("session/created", (session) => {
			if (session.id !== target) return;
			const suffix = session.events.slice(snapshotCursor === void 0 ? session.firstLiveSeq : snapshotCursor + 1);
			buffered.unshift(...suffix);
			notify();
		}, { global: true });
		const onAbort = () => {
			notify();
		};
		signal.addEventListener("abort", onAbort, { once: true });
		try {
			const env_2 = {
				stack: [],
				error: void 0,
				hasError: false
			};
			try {
				const source = __addDisposableResource$2(env_2, await this.sourceFor(address, signal, true), false);
				const events = source.events;
				signal.throwIfAborted();
				const cursor = source.cursor;
				snapshotCursor = cursor;
				const page = paginate(events, void 0, request.maxMessages ?? DEFAULT_MAX_MESSAGES);
				yield {
					type: "snapshot",
					header: source.header,
					cursor,
					records: pageRecords(page.events),
					hasMore: page.hasMore,
					projections: source.projections === void 0 ? {
						asOfSeq: cursor,
						values: {}
					} : projectionBlock(source.projections)
				};
				if (address.kind === "session" && source.source === "prepared") {
					const promotion = source.retain();
					try {
						this.promote(promotion);
					} catch (error) {
						promotion[Symbol.dispose]();
						throw error;
					}
				}
				let nextSeq = cursor + 1;
				while (!follower.closed && !signal.aborted) {
					const item = buffered.shift();
					if (item === void 0) {
						await new Promise((resolve) => {
							wake = resolve;
						});
						continue;
					}
					if (item.seq < nextSeq) continue;
					if (item.seq !== nextSeq) reject("internal", `session event stream skipped seq ${String(nextSeq)}`, {});
					nextSeq++;
					yield entryFor(item);
				}
			} catch (e_2) {
				env_2.error = e_2;
				env_2.hasError = true;
			} finally {
				__disposeResources$2(env_2);
			}
		} finally {
			this.closeFollowers.delete(close);
			signal.removeEventListener("abort", onAbort);
			disposeCreated();
			disposeEvent();
		}
	}
	async sourceFor(address, signal, withProjections) {
		const sessionId = addressId(address);
		try {
			const observation = await this.ctx.sessionQuery.observeSession(sessionId, {
				signal,
				projectionMode: withProjections || address.kind === "subagent" ? "all" : "none"
			});
			if (observation.header.cwd === void 0) {
				observation[Symbol.dispose]();
				rejectNotFound(address);
			}
			try {
				validateAddress(address, observation.header, observation.projections);
			} catch (error) {
				observation[Symbol.dispose]();
				throw error;
			}
			return observation;
		} catch (error) {
			if (error instanceof SessionQueryError && error.code === "SESSION_QUERY_SESSION_NOT_FOUND") rejectNotFound(address);
			throw error;
		}
	}
};
function projectionBlock(snapshot) {
	return {
		asOfSeq: snapshot.asOfSeq,
		values: snapshot.values
	};
}
function validatePageRequest(request) {
	if (!Number.isSafeInteger(request.throughSeq) || request.throughSeq < -1) reject("bad-request", "throughSeq must be an integer greater than or equal to -1", {});
	if (request.beforeSeq !== void 0 && (!Number.isSafeInteger(request.beforeSeq) || request.beforeSeq < 0)) reject("bad-request", "beforeSeq must be a non-negative safe integer", {});
	if (request.maxMessages !== void 0 && (!Number.isSafeInteger(request.maxMessages) || request.maxMessages <= 0)) reject("bad-request", "maxMessages must be a positive safe integer", {});
}
function validateFollowRequest(request) {
	if (request.maxMessages !== void 0 && (!Number.isSafeInteger(request.maxMessages) || request.maxMessages <= 0)) reject("bad-request", "maxMessages must be a positive safe integer", {});
}
function addressId(address) {
	return address.kind === "session" ? address.sessionId : address.childSessionId;
}
function validateAddress(address, header, projections) {
	if (address.kind === "session") {
		if (header.origin === "subagent") reject("agent-busy", "subagent Sessions require their durable parent address", { reason: "use subagent delivery for this child session" });
		return;
	}
	if (header.origin !== "subagent" || header.parentSession !== address.parentSessionId) reject("subagent-unauthorized", "subagent does not belong to the supplied parent", { childSessionId: address.childSessionId });
	const identity = projections?.values.subagent;
	if (identity === null) reject("subagent-catalog-diagnostic", "subagent descriptor is corrupt", {
		parentSessionId: address.parentSessionId,
		childSessionId: address.childSessionId,
		reason: "corrupt"
	});
	if (identity === void 0 || identity.seq < (header.seedLength ?? 0)) reject("subagent-catalog-diagnostic", "subagent descriptor is unavailable", {
		parentSessionId: address.parentSessionId,
		childSessionId: address.childSessionId,
		reason: "unsupported"
	});
	if (identity.mode !== address.mode) reject("subagent-unauthorized", "subagent mode does not match the supplied address", { childSessionId: address.childSessionId });
}
function rejectNotFound(address) {
	if (address.kind === "session") reject("session-not-found", `session "${address.sessionId}" not found`, { sessionId: address.sessionId });
	reject("subagent-not-found", "subagent is unavailable", {
		parentSessionId: address.parentSessionId,
		childSessionId: address.childSessionId
	});
}
function reject(code, message, details) {
	throw new TypertRemoteFailure({
		code,
		message,
		details
	});
}
function paginate(events, beforeSeq, maxMessages, throughSeq = events.at(-1)?.seq ?? -1) {
	const end = Math.min(throughSeq + 1, beforeSeq ?? throughSeq + 1);
	let count = 0;
	let cut = 0;
	for (let index = end - 1; index >= 0; index--) {
		const event = events[index];
		if (!MESSAGE_TYPES.has(event.type) || !isAppendSurfaceEvent(event)) continue;
		count++;
		const sources = event.sourceEventSeqs;
		let groupStart = event.seq;
		if (sources !== void 0) for (const source of sources) groupStart = Math.min(groupStart, source);
		if (count >= maxMessages) {
			cut = groupStart;
			break;
		}
	}
	return {
		events: events.slice(cut, end),
		hasMore: cut > 0
	};
}
function entryFor(event) {
	return {
		type: "event",
		event
	};
}
function chunkEntryFor(row) {
	switch (row.type) {
		case "text-chunks": return {
			type: "chunks",
			event: {
				type: "chunkrow/text-chunks",
				seq: row.seq0,
				time: row.time0,
				data: row.data
			}
		};
		case "reasoning-chunks": return {
			type: "chunks",
			event: {
				type: "chunkrow/reasoning-chunks",
				seq: row.seq0,
				time: row.time0,
				data: row.data
			}
		};
		case "tool-call-chunks": return {
			type: "chunks",
			event: {
				type: "chunkrow/tool-call-chunks",
				seq: row.seq0,
				time: row.time0,
				data: row.data
			}
		};
	}
}
/** Encode one bounded logical page without changing its pagination cut. */
function pageRecords(events) {
	return packChunkRuns(events).map((record) => isChunkRow(record) ? chunkEntryFor(record) : entryFor(record));
}
//#endregion
//#region lib/types/list.js
/** Cached lifecycle summary only; canonical Host owns list/search and projection registration. */
/**
* Build a created-session lifecycle hint without reading or replaying its log.
* @param ctx - Host context providing the live Agent registry and optional cached projections.
* @param session - exact Session whose header, cursor, and cached metadata describe the hint.
* @returns lifecycle summary; unavailable cached projections are logged and omitted.
*/
function sessionSummaryFor(ctx, session) {
	let projections;
	try {
		const block = ctx.get("sessionProjections")?.cachedSnapshot(session);
		if (block !== void 0 && Object.keys(block.values).length > 0) projections = {
			asOfSeq: block.asOfSeq,
			values: block.values
		};
	} catch (error) {
		ctx.logger.warn(`api-session: cached summary unavailable for "${session.id}": ${String(error)}`);
	}
	const metadata = projections?.values.sessionListMetadata;
	return {
		sessionId: session.id,
		updatedAt: Math.max(session.header.createdAt, metadata?.lastPromptAt ?? 0),
		running: ctx.agents.get(session.id)?.status === "running",
		blank: metadata?.blank ?? session.seq === 0,
		...session.header.parentSession === void 0 ? {} : { parentSessionId: session.header.parentSession },
		...session.header.origin === void 0 ? {} : { origin: session.header.origin },
		...session.header.cwd === void 0 ? {} : { cwd: session.header.cwd },
		...projections === void 0 ? {} : { projections }
	};
}
//#endregion
//#region lib/types/catalog.js
/** Shared projection of the live LLM registry into the browser model catalog. */
/**
* Build the browser model catalog without requiring a Session.
* @param ctx - Host context carrying the live LLM registry.
* @param defaultSelection - deployment default used before a Session selects a model.
* @returns successful non-empty provider groups and isolated provider failures.
*/
async function buildModelCatalog(ctx, defaultSelection = ctx.agentDefaultModel.currentSelection()) {
	const providers = ctx.llm.listProviders();
	const catalog = await Promise.all(providers.map(async (provider) => {
		try {
			const models = await ctx.llm.listModels(provider.id);
			const entries = await Promise.all(models.map(async (model) => {
				const resolved = await ctx.llm.resolveModelInfo(provider.id, model.id);
				const reasoning = resolved.reasoning === void 0 ? void 0 : {
					efforts: resolved.reasoning.efforts.map((effort) => ({
						id: effort.id,
						name: effort.name,
						...effort.description === void 0 ? {} : { description: effort.description }
					})),
					...resolved.reasoning.defaultEffort === void 0 ? {} : { defaultEffort: resolved.reasoning.defaultEffort }
				};
				return {
					id: model.id,
					name: model.name,
					...model.description === void 0 ? {} : { description: model.description },
					...reasoning === void 0 ? {} : { reasoning }
				};
			}));
			return {
				kind: "group",
				group: {
					id: provider.id,
					name: provider.name,
					models: entries
				}
			};
		} catch (error) {
			return {
				kind: "failure",
				failure: {
					id: provider.id,
					name: provider.name,
					message: error instanceof Error ? error.message : String(error)
				}
			};
		}
	}));
	return {
		default: { ...defaultSelection },
		routableProviders: providers.map((provider) => provider.id),
		groups: catalog.flatMap((item) => item.kind === "group" ? [item.group] : []).filter((group) => group.models.length > 0),
		failures: catalog.flatMap((item) => item.kind === "failure" ? [item.failure] : [])
	};
}
//#endregion
//#region lib/types/skill-catalog.js
/** Session-addressed, cold-readable skill catalog Remote. */
var __runInitializers$1 = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
var __esDecorate$1 = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) if (kind === "field") initializers.unshift(_);
		else descriptor[key] = _;
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
var __addDisposableResource$1 = function(env, value, async) {
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
		if (inner) dispose = function() {
			try {
				inner.call(this);
			} catch (e) {
				return Promise.reject(e);
			}
		};
		env.stack.push({
			value,
			dispose,
			async
		});
	} else if (async) env.stack.push({ async: true });
	return value;
};
var __disposeResources$1 = (function(SuppressedError) {
	return function(env) {
		function fail(e) {
			env.error = env.hasError ? new SuppressedError(e, env.error, "An error was suppressed during disposal.") : e;
			env.hasError = true;
		}
		var r, s = 0;
		function next() {
			while (r = env.stack.pop()) try {
				if (!r.async && s === 1) return s = 0, env.stack.push(r), Promise.resolve().then(next);
				if (r.dispose) {
					var result = r.dispose.call(r.value);
					if (r.async) return s |= 2, Promise.resolve(result).then(next, function(e) {
						fail(e);
						return next();
					});
				} else s |= 1;
			} catch (e) {
				fail(e);
			}
			if (s === 1) return env.hasError ? Promise.reject(env.error) : Promise.resolve();
			if (env.hasError) throw env.error;
		}
		return next();
	};
})(typeof SuppressedError === "function" ? SuppressedError : function(error, suppressed, message) {
	var e = new Error(message);
	return e.name = "SuppressedError", e.error = error, e.suppressed = suppressed, e;
});
/** Host service backing `ctx.remote.skills` without activating a cold Agent. */
let SessionSkillCatalog = (() => {
	let _classSuper = TypertRemoteService;
	let _instanceExtraInitializers = [];
	let _list_decorators;
	return class SessionSkillCatalog extends _classSuper {
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_list_decorators = [Remote];
			__esDecorate$1(this, null, _list_decorators, {
				kind: "method",
				name: "list",
				static: false,
				private: false,
				access: {
					has: (obj) => "list" in obj,
					get: (obj) => obj.list
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			if (_metadata) Object.defineProperty(this, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		static inject = [
			"agents",
			"sessionQuery",
			"typert"
		];
		/** @param ctx - Host context carrying Session reads and optional skill/preset services. */
		constructor(ctx) {
			super(ctx, "sessionSkillCatalog", { namespace: "skills" });
			__runInitializers$1(this, _instanceExtraInitializers);
		}
		/**
		* List the user-invocable skills visible to one Session composition.
		* @param request - Session identity whose cwd and preset select the catalog view.
		* @param signal - caller lifetime carried by the Remote transport; admitted catalog reads retain their existing completion semantics.
		* @returns user-invocable skill metadata without loading skill bodies.
		* @throws TypertRemoteFailure when the Session cannot be inspected or no registry can serve it.
		*/
		async list(request, signal) {
			const { sessionId } = request;
			let cwd;
			let agentPreset;
			try {
				const env_1 = {
					stack: [],
					error: void 0,
					hasError: false
				};
				try {
					const observation = __addDisposableResource$1(env_1, await this.ctx.sessionQuery.observeSession(sessionId), false);
					if (observation.projections === void 0) throw new Error("skill catalog requires a projected Session observation");
					cwd = observation.header.cwd;
					agentPreset = observation.projections.values.agentPreset ?? void 0;
				} catch (e_1) {
					env_1.error = e_1;
					env_1.hasError = true;
				} finally {
					__disposeResources$1(env_1);
				}
			} catch (error) {
				if (error instanceof SessionQueryError && error.code === "SESSION_QUERY_SESSION_NOT_FOUND") throw failure("session-not-found", `session "${sessionId}" not found`, { sessionId });
				throw failure("internal", `session "${sessionId}" could not be inspected: ${String(error)}`);
			}
			if (cwd === void 0) throw failure("internal", `session "${sessionId}" has no project cwd`);
			const live = this.ctx.agents.get(sessionId);
			const presets = this.ctx.get("agentPresets");
			const skillRegistry = (live === void 0 ? void 0 : presets?.serviceFor(live, "skills")) ?? this.ctx.get("skills");
			if (skillRegistry === void 0) throw failure("internal", "skill registry is absent: neither this session's agent preset nor the host composition mounts @deepseek-ai/dsh-skill");
			const scope = await this.scopeFor(sessionId, agentPreset);
			try {
				return { skills: (await skillRegistry.list({
					cwd,
					scope
				})).filter(isUserInvocable).map((skill) => ({
					name: skill.name,
					description: skill.description,
					...skill.whenToUse === void 0 ? {} : { whenToUse: skill.whenToUse },
					modelInvocable: skill.invocation.modelInvocable
				})) };
			} catch (error) {
				throw failure("internal", `skill listing failed: ${String(error)}`);
			}
		}
		/** Resolve a live or standing preset scope without creating an Agent. */
		async scopeFor(sessionId, agentPreset) {
			const live = this.ctx.agents.get(sessionId);
			if (live !== void 0) return live;
			const presets = this.ctx.get("agentPresets");
			if (presets === void 0) return void 0;
			try {
				return await presets.standingKeyFor(agentPreset);
			} catch {
				return;
			}
		}
	};
})();
/** Build one stable Remote failure with optional typed details. */
function failure(code, message, details = {}) {
	return new TypertRemoteFailure({
		code,
		message,
		details
	});
}
//#endregion
//#region lib/types/index.js
/** Session legacy desktop actions, journal streams, and live control state. */
var __runInitializers = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
var __esDecorate = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) if (kind === "field") initializers.unshift(_);
		else descriptor[key] = _;
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
var __addDisposableResource = function(env, value, async) {
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
		if (inner) dispose = function() {
			try {
				inner.call(this);
			} catch (e) {
				return Promise.reject(e);
			}
		};
		env.stack.push({
			value,
			dispose,
			async
		});
	} else if (async) env.stack.push({ async: true });
	return value;
};
var __disposeResources = (function(SuppressedError) {
	return function(env) {
		function fail(e) {
			env.error = env.hasError ? new SuppressedError(e, env.error, "An error was suppressed during disposal.") : e;
			env.hasError = true;
		}
		var r, s = 0;
		function next() {
			while (r = env.stack.pop()) try {
				if (!r.async && s === 1) return s = 0, env.stack.push(r), Promise.resolve().then(next);
				if (r.dispose) {
					var result = r.dispose.call(r.value);
					if (r.async) return s |= 2, Promise.resolve(result).then(next, function(e) {
						fail(e);
						return next();
					});
				} else s |= 1;
			} catch (e) {
				fail(e);
			}
			if (s === 1) return env.hasError ? Promise.reject(env.error) : Promise.resolve();
			if (env.hasError) throw env.error;
		}
		return next();
	};
})(typeof SuppressedError === "function" ? SuppressedError : function(error, suppressed, message) {
	var e = new Error(message);
	return e.name = "SuppressedError", e.error = error, e.suppressed = suppressed, e;
});
/** Desktop and streaming additions to the canonical Session Remote namespace. */
let SessionController = (() => {
	let _classSuper = TypertRemoteService;
	let _instanceExtraInitializers = [];
	let _modelCatalog_decorators;
	let _canOpenWorkspacePath_decorators;
	let _openWorkspacePath_decorators;
	let _page_decorators;
	let _follow_decorators;
	let _control_decorators;
	return class SessionController extends _classSuper {
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_modelCatalog_decorators = [Remote("modelCatalog")];
			_canOpenWorkspacePath_decorators = [Remote];
			_openWorkspacePath_decorators = [Remote("openWorkspacePath")];
			_page_decorators = [Remote("page")];
			_follow_decorators = [Remote({ mode: "stream" })];
			_control_decorators = [Remote({ mode: "stream" })];
			__esDecorate(this, null, _modelCatalog_decorators, {
				kind: "method",
				name: "modelCatalog",
				static: false,
				private: false,
				access: {
					has: (obj) => "modelCatalog" in obj,
					get: (obj) => obj.modelCatalog
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _canOpenWorkspacePath_decorators, {
				kind: "method",
				name: "canOpenWorkspacePath",
				static: false,
				private: false,
				access: {
					has: (obj) => "canOpenWorkspacePath" in obj,
					get: (obj) => obj.canOpenWorkspacePath
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _openWorkspacePath_decorators, {
				kind: "method",
				name: "openWorkspacePath",
				static: false,
				private: false,
				access: {
					has: (obj) => "openWorkspacePath" in obj,
					get: (obj) => obj.openWorkspacePath
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _page_decorators, {
				kind: "method",
				name: "page",
				static: false,
				private: false,
				access: {
					has: (obj) => "page" in obj,
					get: (obj) => obj.page
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _follow_decorators, {
				kind: "method",
				name: "follow",
				static: false,
				private: false,
				access: {
					has: (obj) => "follow" in obj,
					get: (obj) => obj.follow
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _control_decorators, {
				kind: "method",
				name: "control",
				static: false,
				private: false,
				access: {
					has: (obj) => "control" in obj,
					get: (obj) => obj.control
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			if (_metadata) Object.defineProperty(this, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		static inject = [
			"agentDefaultModel",
			"agents",
			"attachments",
			"llm",
			"sessions",
			"sessionProjections",
			"sessionQuery",
			"typert",
			"workspaceRegistry"
		];
		static Config = z.object({ nativeOpen: z.boolean() });
		agents = __runInitializers(this, _instanceExtraInitializers);
		controlState;
		history;
		openPath;
		canOpenPath;
		promotions = /* @__PURE__ */ new Set();
		/**
		* @param ctx - Host context containing the Session capability assembly.
		* @param config - native desktop handoff policy.
		*/
		constructor(ctx, config, internals = {}) {
			super(ctx, "sessionController", { namespace: "session" });
			this.agents = new ApiSessionAgentController(ctx);
			this.controlState = new SessionControlController(ctx);
			ctx.effect(() => async () => {
				await Promise.allSettled([...this.promotions]);
			}, "session-controller.promotions");
			this.history = new SessionHistoryController(ctx, (observation) => {
				this.promote(observation);
			});
			this.openPath = internals.openPath ?? openNativePath;
			this.canOpenPath = internals.canOpenPath ?? (() => config.nativeOpen ?? (internals.openPath !== void 0 || canOpenNativePath()));
			ctx.plugin(SessionSkillCatalog);
			ctx.on("session/created", (session) => {
				ctx.emit("api-session/added", sessionSummaryFor(ctx, session));
			});
			ctx.on("session/disposed", (session) => {
				ctx.emit("api-session/removed", session.id);
			});
			ctx.on("agent/status", ({ agent, status }) => {
				ctx.emit("api-session/status", agent.id, status === "running");
			});
			ctx.on("agent/error", ({ agent, error }) => {
				ctx.emit("api-session/error", agent.id, errorChain(error));
			});
			ctx.on("session/event", (session, event) => {
				if (event.type !== "user/message" || event.data.source.kind !== "user") return;
				ctx.emit("api-session/activity", session.id, event.time);
			});
		}
		promote(observation) {
			const sessionId = observation.header.id;
			const task = (async () => {
				const env_1 = {
					stack: [],
					error: void 0,
					hasError: false
				};
				try {
					const ownedObservation = __addDisposableResource(env_1, observation, false);
					const result = await this.agents.resolveObservedAgent(ownedObservation);
					if ("error" in result) this.ctx.emit("api-session/error", sessionId, result.error.message);
				} catch (e_1) {
					env_1.error = e_1;
					env_1.hasError = true;
				} finally {
					__disposeResources(env_1);
				}
			})().catch((error) => {
				this.ctx.logger.error(`session-controller: background activation for "${sessionId}" failed: ${errorChain(error)}`);
			});
			this.promotions.add(task);
			task.finally(() => {
				this.promotions.delete(task);
			});
		}
		/**
		* Resolve or resume one ordinary Session for another Host API domain.
		* @param sessionId - Session identity whose Agent owns the operation.
		* @returns the live Agent or the stable Session-domain failure.
		*/
		resolveAgent(sessionId) {
			return this.agents.resolveAgent(sessionId);
		}
		/**
		* Inspect one attached or persisted Session without activating its Agent.
		* @param sessionId - durable Session identity.
		* @param signal - optional caller cancellation for persistence reads.
		* @returns the current attached state or persisted header and event prefix.
		*/
		inspect(sessionId, signal) {
			const attached = this.ctx.sessions.get(sessionId);
			if (attached !== void 0) return Promise.resolve({
				meta: attached.header,
				events: [...attached.events]
			});
			return inspectApiSession(this.ctx, sessionId, signal);
		}
		/**
		* Describe every currently routable model for Host-generation selectors.
		* @returns provider-grouped models, the deployment default, and isolated provider failures.
		*/
		modelCatalog() {
			return buildModelCatalog(this.ctx);
		}
		/**
		* Report whether this deployment can hand a Session workspace path to a native desktop.
		* @returns true when the matching open operation is available.
		*/
		canOpenWorkspacePath() {
			return this.canOpenPath();
		}
		/**
		* Open one path prepared by a Session-aware caller on the Host desktop.
		* @param request - path after best-effort Session workspace resolution.
		* @param signal - caller lifetime; abort terminates the native command.
		* @returns confirmation after the native opener accepts the path.
		* @throws TypertRemoteFailure when the request is invalid, cancelled, or the opener fails.
		*/
		async openWorkspacePath(request, signal) {
			if (request.path.length === 0) throw new TypertRemoteFailure({
				code: "bad-request",
				message: "session.openWorkspacePath requires a non-empty path",
				details: {}
			});
			signal.throwIfAborted();
			try {
				await this.openPath(request.path, signal);
				return { opened: true };
			} catch (error) {
				if (signal.aborted) throw new TypertRemoteFailure({
					code: "cancelled",
					message: "path open was aborted",
					details: {}
				});
				throw new TypertRemoteFailure({
					code: "internal",
					message: `path open failed: ${error instanceof Error ? error.message : String(error)}`,
					details: {}
				});
			}
		}
		/**
		* Read one cold-safe, message-aligned Session history page.
		* @param request - durable address, backward cursor, and page budget.
		* @param signal - cancellation for persistence reads.
		* @returns one chronological page.
		*/
		page(request, signal) {
			return this.history.page(request, signal);
		}
		/**
		* Follow one Session log from its opening or resume cursor.
		* @param request - durable address and last committed sequence already held by the caller.
		* @param signal - cancellation owned by the Remote stream carrier.
		* @returns a complete opening snapshot followed by gap-free event frames.
		*/
		follow(request, signal) {
			return this.history.follow(request, signal);
		}
		/**
		* Stream a complete live-control baseline followed by replacement frames.
		* @param signal - cancellation owned by the Remote stream carrier.
		* @returns one complete baseline followed by live replacement frames.
		*/
		control(signal) {
			return this.controlState.control(signal);
		}
	};
})();
//#endregion
export { ApiSessionNotFound, SessionController, SessionController as default, SessionSkillCatalog, buildModelCatalog };
