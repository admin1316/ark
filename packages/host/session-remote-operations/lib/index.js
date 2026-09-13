import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { mkdir, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { Service } from "@deepseek-ai/cordis";
import { canonicalClientTimeZone } from "@deepseek-ai/dsh-subagent";
import { sessionModelSelection } from "@deepseek-ai/dsh-agent-default-model/session-selection";
import { PresetMountError, UnknownPresetError, resolveSessionPreset } from "@deepseek-ai/dsh-agent-presets";
import { ApiRemoteSessionNotFound, ApiRemoteSubagentSessionOwnership, apiRemoteSubagentOwnershipError, hasApiRemoteSubagentOwner } from "@deepseek-ai/dsh-api-remotes/agent-lookup";
import { AttachmentError, admitEncodedImages } from "@deepseek-ai/dsh-attachment";
import { BlockAssembler, createUserMessage, deepFreeze, freezeMessage } from "@deepseek-ai/dsh-llm";
import { MessageId, ReasoningEffortId } from "@deepseek-ai/dsh-llm/brand";
import { SessionId, findToolCallArguments, isAppendSurfaceEvent, snapshotJsonValue } from "@deepseek-ai/dsh-session";
import { SessionQueryError } from "@deepseek-ai/dsh-session-query";
import { SessionTitleInvalidError } from "@deepseek-ai/dsh-session-title";
import { isSkillName, isUserInvocable } from "@deepseek-ai/dsh-skill";
import { WorkspaceId, WorkspaceSessionDeletionBlockedError } from "@deepseek-ai/dsh-workspace";
import { deriveTurnTokenUsage } from "@deepseek-ai/dsh-token-meter/client";
import { Zip, ZipDeflate } from "fflate";
//#region lib/types/prompt-receipts.js
/** Incremental ordinary-prompt receipts derived from the existing inbox log. */
const receiptSchema = z.object({
	messageId: z.string(),
	seq: z.number().int().nonnegative(),
	digest: z.string().nullable(),
	conflict: z.boolean()
});
const stateSchema = z.object({
	seedLength: z.number().int().nonnegative(),
	entries: z.record(z.string(), receiptSchema)
});
/**
* Canonical request fingerprint; hash the encoded image instead of retaining it.
* @param request - original content and delivery mode; invocation and Session identities are not part of the digest.
* @param clientTimeZone - already canonicalized client time zone, or undefined when absent.
* @returns version-prefixed SHA-256 digest used to reject changed payloads under an accepted invocation identity.
*/
function promptDigest(request, clientTimeZone) {
	const content = request.content.map((part) => part.type === "text" ? {
		type: part.type,
		text: part.text
	} : {
		type: part.type,
		mediaType: part.mediaType,
		data: part.data,
		name: part.name ?? null
	});
	return "v1:" + createHash("sha256").update(JSON.stringify({
		mode: request.mode,
		clientTimeZone: clientTimeZone ?? null,
		content
	})).digest("hex");
}
/** Existing receipt entries are never rewritten by queue edits or later consumption. */
function foldReceipts(state, event) {
	if (event.seq < state.seedLength) return state;
	const messages = event.type === "agent/inbox/spliced" ? event.data.inserted : event.type === "user/message" ? [event.data] : [];
	let entries = state.entries;
	for (const message of messages) {
		const source = message.source;
		if (source.kind !== "user" || !("invocationId" in source) || typeof source.invocationId !== "string") continue;
		const previous = Object.hasOwn(entries, source.invocationId) ? entries[source.invocationId] : void 0;
		const digest = "promptDigest" in source && typeof source.promptDigest === "string" ? source.promptDigest : null;
		if (previous !== void 0) {
			if (previous.messageId === message.id && previous.digest === digest || previous.conflict) continue;
			if (entries === state.entries) entries = { ...entries };
			Object.defineProperty(entries, source.invocationId, {
				value: {
					...previous,
					conflict: true
				},
				enumerable: true,
				configurable: true,
				writable: true
			});
		} else {
			if (entries === state.entries) entries = { ...entries };
			Object.defineProperty(entries, source.invocationId, {
				value: {
					messageId: message.id,
					seq: event.seq,
					digest,
					conflict: false
				},
				enumerable: true,
				configurable: true,
				writable: true
			});
		}
	}
	return entries === state.entries ? state : {
		...state,
		entries
	};
}
/**
* Register with the shared projection owner; no receipt data is exposed on the wire.
* @param ctx - Host context with an injected projection registry that owns incremental replay and disposal.
*/
function installPromptReceipts(ctx) {
	ctx.sessionProjections.register({
		key: "promptReceipts",
		stateSchema,
		init: (header) => ({
			seedLength: header.seedLength ?? 0,
			entries: {}
		}),
		apply: foldReceipts,
		stateVersion: 1
	});
}
//#endregion
//#region lib/types/semantic-history.js
/** Complete message reads over the existing immutable Session observation owner. */
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
/** A read refusal that can cross the existing Remote result boundary. */
var SemanticHistoryError = class extends Error {
	code;
	constructor(code, message) {
		super(message);
		this.code = code;
	}
};
/** Numeric indices and optional assembled text; never retains a prepared lease or raw log. */
var SemanticHistoryReader = class {
	ctx;
	createPresenter;
	generations = /* @__PURE__ */ new WeakMap();
	indices = /* @__PURE__ */ new Map();
	content = /* @__PURE__ */ new Map();
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
		this.contentIdleMs = limits.contentIdleMs ?? 6e4;
		for (const value of [
			this.maxIndices,
			this.maxIndexBytes,
			this.maxContentBytes,
			this.maxContentReaders,
			this.contentIdleMs
		]) if (!Number.isSafeInteger(value) || value < 0) throw new Error("semantic history limits must be non-negative safe integers");
	}
	/** Release cached indices and retained content readers, including their expiry timers. */
	clear() {
		this.indices.clear();
		for (const id of this.content.keys()) this.closeContent(id);
	}
	/**
	* Retain one authoritative immutable source for raw and semantic history alike.
	* @param request - Session identity, optional expected child ownership, and optional previously issued source cut.
	* @param signal - cancels observation acquisition; an abort detected before return releases the acquired observation.
	* @returns authorized source and cut with a current-source assertion; the caller must dispose the returned lease.
	* @throws SemanticHistoryError when the query owner is absent, the source is stale, or child ownership is invalid.
	*/
	async observe(request, signal) {
		const query = this.ctx.get("sessionQuery");
		if (query === void 0) throw new SemanticHistoryError("history-unavailable", "session query is not mounted");
		if (request.sourceRevision !== void 0 && typeof request.sourceRevision !== "string") throw new SemanticHistoryError("invalid-argument", "sourceRevision must be a string");
		let observed;
		try {
			observed = await query.observeSession(request.sessionId, {
				projectionMode: request.expectedSubagentMode === void 0 ? "none" : "all",
				signal
			});
		} catch (error) {
			if (request.sourceRevision !== void 0 && error instanceof SessionQueryError && error.code === "SESSION_QUERY_SESSION_NOT_FOUND") throw new SemanticHistoryError("history-stale-source", "history source is no longer available");
			throw error;
		}
		try {
			signal.throwIfAborted();
			const identity = this.identity(observed);
			const through = request.sourceRevision === void 0 ? observed.cursor : this.cut(request.sourceRevision, identity, observed.cursor);
			this.authorize(request, observed, through);
			return {
				observed,
				identity,
				through,
				revision: `${identity}:${String(through)}`,
				assertCurrent: () => {
					this.assertCurrent(observed, identity);
				},
				[Symbol.dispose]: () => {
					observed[Symbol.dispose]();
				}
			};
		} catch (error) {
			observed[Symbol.dispose]();
			throw error;
		}
	}
	authorize(request, observed, through) {
		if (request.expectedParentSessionId !== void 0 && observed.header.parentSession !== request.expectedParentSessionId) throw new SemanticHistoryError("subagent-unauthorized", "subagent parent changed during history read");
		if (observed.header.origin !== "subagent" && request.expectedSubagentMode === void 0) return;
		if (observed.header.origin !== "subagent" || request.expectedParentSessionId === void 0 || request.expectedSubagentMode === void 0) throw new SemanticHistoryError("subagent-unauthorized", "child history requires its direct parent and mode");
		const descriptor = observed.projections?.values.subagent;
		if (descriptor === void 0 || descriptor === null || descriptor.seq < (observed.header.seedLength ?? 0) || descriptor.seq > through) throw new SemanticHistoryError("subagent-catalog-diagnostic", "child history has no valid own descriptor at this cut");
		if (descriptor.mode !== request.expectedSubagentMode) throw new SemanticHistoryError("subagent-not-found", "requested child mode does not match the history source");
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
		const seq = this.index(identity, observed.events, through, signal).presetSelections.findLast((seq) => seq <= through);
		const preset = seq === void 0 ? void 0 : observed.events[seq];
		return {
			header: observed.header,
			events: preset === void 0 ? [] : [preset]
		};
	}
	/**
	* Read semantic descriptors or fragments of exact JSON content at an authorized source cut.
	* @param request - page cursor or content-reader request, including ownership and source revision where required.
	* @param signal - caller cancellation checked during source observation, indexing, and content production.
	* @returns a semantic page or content fragment; unfinished content is retained until completion, close, expiry, or clear.
	* @throws SemanticHistoryError for invalid requests, stale sources, ownership failures, or exhausted reader budgets.
	*/
	async read(request, signal) {
		const env_1 = {
			stack: [],
			error: void 0,
			hasError: false
		};
		try {
			if (request.view === "content" && typeof request.sourceRevision !== "string") throw new SemanticHistoryError("invalid-argument", "content requires sourceRevision");
			if (request.view === "semantic" && request.beforeRecordId !== void 0 && request.sourceRevision === void 0) throw new SemanticHistoryError("invalid-argument", "pagination requires sourceRevision");
			if (request.view === "content" && request.contentReadId !== void 0) return this.continueContent(request, request.contentReadId, signal);
			if (request.view === "content" && request.close === true) throw new SemanticHistoryError("invalid-argument", "close requires contentReadId");
			const { observed, identity, through, revision } = __addDisposableResource$1(env_1, await this.observe(request, signal), false);
			const index = this.index(identity, observed.events, through, signal);
			const records = index.records.filter((record) => record.orderSeq <= through);
			if (request.view === "content") {
				const domain = [
					"tool",
					"status",
					"turn"
				].find((domain) => request.recordId === `${identity}/dependency-${domain}`);
				const record = domain === void 0 ? records.find((item) => item.id === request.recordId) : {
					id: request.recordId,
					kind: "tool",
					domain,
					orderSeq: 0
				};
				if (record === void 0) throw new SemanticHistoryError("invalid-argument", "record does not belong to this history cut");
				const offset = boundedInteger(request.offset, 0, 0, Number.MAX_SAFE_INTEGER, "offset");
				const maximum = boundedInteger(request.maxCodeUnits, 16384, 2, 65536, "maxCodeUnits");
				const key = `${revision}/${record.id}`;
				let readId;
				let materialized;
				if (materialized === void 0) {
					if (offset !== 0) throw new SemanticHistoryError("invalid-argument", "continuation requires contentReadId");
					if (this.materializing || this.content.size >= this.maxContentReaders || this.contentBytes > this.maxContentBytes) throw new SemanticHistoryError("history-content-busy", "finish or close an existing content read first");
					this.materializing = true;
					let text;
					try {
						text = await this.recordText(record, observed, revision, index, through, signal);
					} finally {
						this.materializing = false;
					}
					this.assertCurrent(observed, identity);
					const bytes = contentCharge(key, text);
					if (this.content.size >= this.maxContentReaders || this.contentBytes > this.maxContentBytes || bytes <= this.maxContentBytes && this.contentBytes + bytes > this.maxContentBytes) throw new SemanticHistoryError("history-content-busy", "content reader budget is in use");
					readId = randomUUID();
					const timer = this.expiry(readId);
					materialized = {
						key,
						text,
						bytes,
						timer,
						sessionId: request.sessionId,
						parentSessionId: observed.header.parentSession,
						subagentMode: request.expectedSubagentMode,
						subagentDescriptorSeq: observed.projections?.values.subagent?.seq,
						identity,
						revision,
						through,
						recordId: record.id
					};
					this.content.set(readId, materialized);
					this.contentBytes += bytes;
				}
				if (readId === void 0) throw new Error("content reader has no identity");
				const text = materialized.text;
				if (offset > text.length || splitsSurrogate(text, offset)) throw new SemanticHistoryError("invalid-argument", "offset is not a content boundary");
				let end = Math.min(text.length, offset + maximum);
				if (splitsSurrogate(text, end)) end -= 1;
				this.assertCurrent(observed, identity);
				const done = end === text.length;
				const fragment = text.slice(offset, end);
				if (done) this.closeContent(readId);
				else {
					clearTimeout(materialized.timer);
					materialized.timer = this.expiry(readId);
				}
				return {
					view: "content",
					sourceRevision: revision,
					asOfThroughSeq: through,
					recordId: record.id,
					contentReadId: readId,
					encoding: "json",
					offset,
					text: fragment,
					nextOffset: end,
					done
				};
			}
			const count = boundedInteger(request.maxRecords, 50, 1, 200, "maxRecords");
			const before = request.beforeRecordId === void 0 ? records.length : records.findIndex((record) => record.id === request.beforeRecordId);
			if (before < 0) throw new SemanticHistoryError("invalid-argument", "cursor does not belong to this history cut");
			const start = Math.max(0, before - count);
			const page = [];
			for (const record of records.slice(start, before)) {
				signal.throwIfAborted();
				const canonical = atCut(record.canonical, through);
				const call = atCut(record.call, through);
				const result = atCut(record.result, through);
				const endSeq = record.turn === void 0 ? void 0 : atCut(index.turnEnds.get(record.turn), through);
				const end = endSeq === void 0 ? void 0 : observed.events[endSeq];
				const finalized = canonical === void 0 ? void 0 : observed.events[canonical];
				const state = record.kind === "assistant" ? finalized?.type === "assistant/message" ? finalized.data.interrupted === true ? "interrupted" : "complete" : atCut(record.orphaned, through) !== void 0 ? "orphaned-prefix" : atCut(record.closed, through) !== void 0 || end !== void 0 ? "failed-prefix" : observed.source === "live" ? "active" : "orphaned-prefix" : record.kind === "tool" && (call === void 0 || result === void 0) ? "unpaired" : "complete";
				page.push({
					id: record.id,
					kind: record.kind,
					orderSeq: record.orderSeq,
					time: observed.events[record.orderSeq]?.time ?? 0,
					...record.turn === void 0 ? {} : { turn: record.turn },
					...record.step === void 0 ? {} : { step: record.step },
					state,
					contentState: "complete-at-cut",
					preview: safePreview(this.preview(record, observed.events, through, signal)),
					...canonical === void 0 ? {} : { canonicalEventSeq: canonical },
					...call === void 0 ? {} : { callEventSeq: call },
					...result === void 0 ? {} : { resultEventSeq: result },
					...end?.type === "turn/end" && end.data.reason.kind === "completed" ? { completedTurnEndSeq: end.seq } : {}
				});
			}
			this.assertCurrent(observed, identity);
			return {
				view: "semantic",
				sourceRevision: revision,
				asOfThroughSeq: through,
				records: page,
				hasMore: start > 0,
				turns: this.turnContexts(index, through, new Set(page.flatMap((record) => record.turn === void 0 ? [] : [record.turn]))),
				dependencyRecords: {
					tool: `${identity}/dependency-tool`,
					status: `${identity}/dependency-status`,
					turn: `${identity}/dependency-turn`
				},
				...start > 0 && page[0] !== void 0 ? { nextBeforeRecordId: page[0].id } : {},
				pendingDomains: []
			};
		} catch (e_1) {
			env_1.error = e_1;
			env_1.hasError = true;
		} finally {
			__disposeResources$1(env_1);
		}
	}
	async continueContent(request, readId, signal) {
		signal.throwIfAborted();
		const body = this.content.get(readId);
		if (body === void 0 || body.sessionId !== request.sessionId || body.recordId !== request.recordId || body.revision !== request.sourceRevision) throw new SemanticHistoryError("history-content-expired", "content reader expired or belongs to another record");
		if (request.expectedParentSessionId !== void 0 && body.parentSessionId !== request.expectedParentSessionId) throw new SemanticHistoryError("subagent-unauthorized", "content reader belongs to another parent");
		if (body.subagentMode !== void 0 && (request.expectedSubagentMode !== body.subagentMode || request.expectedParentSessionId !== body.parentSessionId)) throw new SemanticHistoryError("subagent-unauthorized", "content reader requires its original child address");
		const offset = boundedInteger(request.offset, 0, 0, Number.MAX_SAFE_INTEGER, "offset");
		const maximum = boundedInteger(request.maxCodeUnits, 16384, 2, 65536, "maxCodeUnits");
		if (request.close === true) {
			this.closeContent(readId);
			return {
				view: "content",
				sourceRevision: body.revision,
				asOfThroughSeq: body.through,
				recordId: body.recordId,
				contentReadId: readId,
				encoding: "json",
				offset,
				text: "",
				nextOffset: offset,
				done: true
			};
		}
		const current = this.ctx.sessions.get(body.sessionId);
		let valid = false;
		if (current !== void 0) {
			valid = this.generations.get(current) === body.identity && current.seq - 1 >= body.through && current.header.parentSession === body.parentSessionId;
			if (valid && body.subagentMode !== void 0) valid = this.currentChildDescriptor(current, body.subagentMode, body.subagentDescriptorSeq);
		} else if (body.identity.startsWith("cold-")) {
			const persistence = this.ctx.get("sessionPersistence");
			if (persistence !== void 0) {
				const snapshot = (await persistence.listSnapshots(signal)).find((item) => item.header.id === body.sessionId);
				signal.throwIfAborted();
				valid = this.ctx.sessions.get(body.sessionId) === void 0 && snapshot !== void 0 && coldIdentity(String(snapshot.revision)) === body.identity && snapshot.header.parentSession === body.parentSessionId;
			}
		}
		if (!valid) {
			this.closeContent(readId);
			throw new SemanticHistoryError("history-stale-source", "content source was replaced or changed");
		}
		if (offset > body.text.length || splitsSurrogate(body.text, offset)) throw new SemanticHistoryError("invalid-argument", "offset is not a content boundary");
		let end = Math.min(body.text.length, offset + maximum);
		if (splitsSurrogate(body.text, end)) end -= 1;
		const done = end === body.text.length;
		const text = body.text.slice(offset, end);
		if (done) this.closeContent(readId);
		else {
			clearTimeout(body.timer);
			body.timer = this.expiry(readId);
		}
		return {
			view: "content",
			sourceRevision: body.revision,
			asOfThroughSeq: body.through,
			recordId: body.recordId,
			contentReadId: readId,
			encoding: "json",
			offset,
			text,
			nextOffset: end,
			done
		};
	}
	assertCurrent(observed, identity) {
		if (observed.source === "live") {
			if (this.identity(observed) !== identity) throw new SemanticHistoryError("history-stale-source", "history source changed while presenting content");
			const descriptor = observed.projections?.values.subagent;
			const current = this.ctx.sessions.get(observed.header.id);
			if (observed.header.origin === "subagent" && (current === void 0 || descriptor == null || !this.currentChildDescriptor(current, descriptor.mode, descriptor.seq))) throw new SemanticHistoryError("history-stale-source", "child descriptor changed while reading history");
		}
	}
	currentChildDescriptor(session, mode, seq) {
		try {
			const descriptor = this.ctx.get("sessionProjections")?.snapshot(session, ["subagent"]).values.subagent;
			return descriptor !== void 0 && descriptor !== null && descriptor.mode === mode && descriptor.seq === seq;
		} catch {
			return false;
		}
	}
	identity(observed) {
		if (observed.source === "prepared") return coldIdentity(String(observed.revision));
		const session = this.ctx.sessions.get(observed.header.id);
		if (session === void 0 || session.header !== observed.header || session.seq - 1 < observed.cursor || session.eventAt(observed.cursor) !== observed.events[observed.cursor]) throw new SemanticHistoryError("history-stale-source", "live source changed during observation");
		let generation = this.generations.get(session);
		if (generation === void 0) {
			generation = `live-${randomUUID()}`;
			this.generations.set(session, generation);
		}
		return generation;
	}
	cut(revision, identity, available) {
		const prefix = `${identity}:`;
		if (!revision.startsWith(prefix)) throw new SemanticHistoryError("history-stale-source", "history source was replaced or changed");
		const text = revision.slice(prefix.length);
		const cut = Number(text);
		if (!Number.isSafeInteger(cut) || cut < -1 || cut > available || String(cut) !== text) throw new SemanticHistoryError("history-stale-source", "history cut is no longer available");
		return cut;
	}
	index(identity, events, through, signal) {
		let index = this.indices.get(identity);
		this.indices.delete(identity);
		index ??= {
			through: -1,
			records: [],
			currentAttempts: /* @__PURE__ */ new Map(),
			firstChunks: /* @__PURE__ */ new Map(),
			calls: /* @__PURE__ */ new Map(),
			turnEnds: /* @__PURE__ */ new Map(),
			turnStarts: /* @__PURE__ */ new Map(),
			turnUsage: /* @__PURE__ */ new Map(),
			usageBytes: 0,
			presetSelections: [],
			activeTurn: void 0,
			dependencies: {
				tool: [],
				status: [],
				turn: []
			},
			lastMetricChunk: void 0
		};
		for (let seq = index.through + 1; seq <= through; seq += 1) {
			if ((seq & 4095) === 0) signal.throwIfAborted();
			const event = events[seq];
			if (event === void 0) throw new SemanticHistoryError("history-stale-source", "history prefix is not contiguous");
			indexDependencies(index, event);
			switch (event.type) {
				case "agent-preset/selected":
					index.presetSelections.push(seq);
					break;
				case "turn/start":
					if (!index.turnStarts.has(event.data.turn)) index.turnStarts.set(event.data.turn, seq);
					index.activeTurn = event.data.turn;
					break;
				case "user/message":
					index.records.push({
						id: `${identity}/user-${String(seq)}`,
						kind: "user",
						orderSeq: seq,
						canonical: seq,
						...index.activeTurn === void 0 ? {} : { turn: index.activeTurn }
					});
					break;
				case "assistant/chunk": {
					const key = `${String(event.data.turn)}:${String(event.data.step)}`;
					let attempt = index.currentAttempts.get(key);
					if (attempt === void 0 || attempt.canonical !== void 0) {
						attempt = {
							id: `${identity}/assistant-${String(seq)}`,
							kind: "assistant",
							orderSeq: seq,
							firstChunk: seq,
							turn: event.data.turn,
							step: event.data.step
						};
						index.records.push(attempt);
						index.currentAttempts.set(key, attempt);
						index.firstChunks.set(seq, attempt);
					}
					attempt.lastChunk = seq;
					if (event.data.chunk.type === "finish" && (event.data.chunk.reason.kind === "error" || event.data.chunk.reason.kind === "aborted")) attempt.closed = seq;
					break;
				}
				case "assistant/message": {
					let first;
					for (const source of event.sourceEventSeqs ?? []) {
						const chunk = events[source];
						if (chunk?.type === "assistant/chunk" && chunk.data.turn === event.data.turn && chunk.data.step === event.data.step) first = first === void 0 ? source : Math.min(first, source);
					}
					const key = `${String(event.data.turn)}:${String(event.data.step)}`;
					let attempt = first === void 0 ? void 0 : index.firstChunks.get(first);
					if (attempt === void 0 || attempt.canonical !== void 0) {
						attempt = {
							id: `${identity}/assistant-${String(seq)}`,
							kind: "assistant",
							orderSeq: seq,
							turn: event.data.turn,
							step: event.data.step
						};
						index.records.push(attempt);
					}
					attempt.canonical = seq;
					index.currentAttempts.delete(key);
					break;
				}
				case "llm/retry-started": {
					const key = `${String(event.data.turn)}:${String(event.data.step)}`;
					const attempt = index.currentAttempts.get(key);
					if (attempt !== void 0) attempt.closed ??= seq;
					index.currentAttempts.delete(key);
					break;
				}
				case "tool/call": {
					const key = `${String(event.data.turn)}:${String(event.data.step)}:${event.data.callId}`;
					const record = {
						id: `${identity}/tool-${String(seq)}`,
						kind: "tool",
						orderSeq: seq,
						call: seq,
						turn: event.data.turn,
						step: event.data.step
					};
					index.calls.set(key, record);
					index.records.push(record);
					break;
				}
				case "tool/result": {
					const key = `${String(event.data.turn)}:${String(event.data.step)}:${event.data.message.source.callId}`;
					let record = index.calls.get(key);
					if (record === void 0) {
						record = {
							id: `${identity}/tool-${String(seq)}`,
							kind: "tool",
							orderSeq: seq,
							turn: event.data.turn,
							step: event.data.step
						};
						index.records.push(record);
					}
					record.result = seq;
					break;
				}
				case "session/end-seed":
					for (const attempt of index.currentAttempts.values()) attempt.orphaned ??= seq;
					index.currentAttempts.clear();
					break;
				case "turn/end":
					index.turnEnds.set(event.data.turn, seq);
					const start = index.turnStarts.get(event.data.turn);
					const usage = start === void 0 ? null : deriveTurnTokenUsage(eventRange(events, start, seq, signal)) ?? null;
					index.turnUsage.set(event.data.turn, usage === null ? null : deepFreeze(usage));
					index.usageBytes += JSON.stringify(usage).length * 2;
					if (index.activeTurn === event.data.turn) index.activeTurn = void 0;
					for (const [key, attempt] of index.currentAttempts) if (attempt.turn === event.data.turn) {
						attempt.closed ??= seq;
						index.currentAttempts.delete(key);
					}
					break;
				default: break;
			}
			index.through = seq;
		}
		this.indices.set(identity, index);
		const charge = (value) => value.usageBytes + value.presetSelections.length * 16 + value.records.length * 1024 + (value.dependencies.tool.length + value.dependencies.status.length + value.dependencies.turn.length) * 16 + (value.turnEnds.size + value.turnStarts.size + value.turnUsage.size) * 1024 + [...value.calls.keys()].reduce((sum, key) => sum + key.length * 4 + 128, 0);
		let bytes = [...this.indices.values()].reduce((sum, value) => sum + charge(value), 0);
		while (this.indices.size > this.maxIndices || bytes > this.maxIndexBytes) {
			const first = this.indices.keys().next().value;
			if (first === void 0) break;
			const removed = this.indices.get(first);
			if (removed !== void 0) bytes -= charge(removed);
			this.indices.delete(first);
		}
		return index;
	}
	blocks(record, events, through, signal) {
		const canonical = atCut(record.canonical, through);
		const event = canonical === void 0 ? void 0 : events[canonical];
		if (event?.type === "user/message") return event.data.content;
		if (event?.type === "assistant/message") return event.data.message.content;
		const assembler = new BlockAssembler();
		if (record.firstChunk !== void 0 && record.lastChunk !== void 0) for (let seq = record.firstChunk; seq <= Math.min(through, record.lastChunk); seq += 1) {
			if ((seq & 4095) === 0) signal.throwIfAborted();
			const chunk = events[seq];
			if (chunk?.type === "assistant/chunk" && chunk.data.turn === record.turn && chunk.data.step === record.step) assembler.push(chunk.data.chunk);
		}
		return assembler.interruptedBlocks();
	}
	preview(record, events, through, signal) {
		if (record.kind === "tool") {
			const call = record.call === void 0 ? void 0 : events[record.call];
			return call?.type === "tool/call" ? call.data.name.slice(0, 256) : "tool result";
		}
		const canonical = atCut(record.canonical, through);
		const event = canonical === void 0 ? void 0 : events[canonical];
		if (event?.type === "user/message") return blockPreview(event.data.content);
		if (event?.type === "assistant/message") return blockPreview(event.data.message.content);
		const assembler = new BlockAssembler();
		if (record.firstChunk === void 0 || record.lastChunk === void 0) return "";
		const end = Math.min(through, record.lastChunk, record.firstChunk + 4095);
		for (let seq = record.firstChunk; seq <= end; seq += 1) {
			signal.throwIfAborted();
			const event = events[seq];
			if (event?.type !== "assistant/chunk" || event.data.turn !== record.turn || event.data.step !== record.step) continue;
			const chunk = event.data.chunk;
			if (chunk.type === "text-delta" || chunk.type === "reasoning-delta") assembler.push({
				...chunk,
				text: chunk.text.slice(0, 256)
			});
			else if (chunk.type === "block-end" && (chunk.block.type === "text" || chunk.block.type === "reasoning")) assembler.push({
				...chunk,
				block: {
					...chunk.block,
					text: chunk.block.text.slice(0, 256)
				}
			});
			else if (chunk.type === "block-start" && (chunk.blockType === "text" || chunk.blockType === "reasoning")) assembler.push(chunk);
			const preview = blockPreview(assembler.interruptedBlocks());
			if (preview.length >= 256) return preview;
		}
		return blockPreview(assembler.interruptedBlocks());
	}
	async recordText(record, observed, revision, index, through, signal) {
		const canonical = atCut(record.canonical, through);
		const event = canonical === void 0 ? void 0 : observed.events[canonical];
		const presetSeq = index.presetSelections.findLast((seq) => seq <= through);
		const preset = presetSeq === void 0 ? void 0 : observed.events[presetSeq];
		const present = this.createPresenter({
			header: observed.header,
			events: preset === void 0 ? [] : [preset]
		});
		let body;
		if (record.domain !== void 0) body = await this.dependencyBundle(record.domain, observed, revision, index, through, signal, present);
		else if (record.kind === "tool") {
			const callSeq = atCut(record.call, through);
			const resultSeq = atCut(record.result, through);
			const call = callSeq === void 0 ? void 0 : observed.events[callSeq];
			const result = resultSeq === void 0 ? void 0 : observed.events[resultSeq];
			const dependencies = call === void 0 ? [] : [call];
			body = {
				kind: "tool",
				...call === void 0 ? {} : { call: await present(call, dependencies) },
				...result === void 0 ? {} : { result: await present(result, dependencies) }
			};
		} else if (event?.type === "user/message" || event?.type === "assistant/message") body = {
			kind: record.kind,
			entry: await present(event, [])
		};
		else body = {
			kind: "assistant-prefix",
			turn: record.turn,
			step: record.step,
			content: this.blocks(record, observed.events, through, signal)
		};
		signal.throwIfAborted();
		return JSON.stringify(body);
	}
	turnContexts(index, through, turns = index.turnStarts.keys()) {
		const result = [];
		for (const turn of turns) {
			const startSeq = atCut(index.turnStarts.get(turn), through);
			const endSeq = atCut(index.turnEnds.get(turn), through);
			if (startSeq === void 0 && endSeq === void 0) continue;
			result.push({
				turn,
				...startSeq === void 0 ? {} : { startSeq },
				...endSeq === void 0 ? {} : { endSeq },
				usage: endSeq === void 0 ? null : index.turnUsage.get(turn) ?? null
			});
		}
		return result;
	}
	async dependencyBundle(domain, observed, revision, index, through, signal, present) {
		const sequences = index.dependencies[domain].filter((seq) => seq <= through);
		if (domain === "turn" && observed.events[through]?.type === "assistant/chunk" && sequences.at(-1) !== through) sequences.push(through);
		const entries = [];
		const missing = /* @__PURE__ */ new Set();
		const sourceEvents = [];
		for (const seq of sequences) {
			signal.throwIfAborted();
			const event = observed.events[seq];
			if (event === void 0) throw new SemanticHistoryError("history-stale-source", "dependency source is incomplete");
			sourceEvents.push(event);
			let dependencies = [];
			if (event.type === "tool/result") {
				const key = `${String(event.data.turn)}:${String(event.data.step)}:${event.data.message.source.callId}`;
				const callSeq = atCut(index.calls.get(key)?.call, through);
				const call = callSeq === void 0 ? void 0 : observed.events[callSeq];
				if (call === void 0) missing.add("parent-call");
				else dependencies = [call];
			}
			entries.push(await present(event, dependencies));
		}
		for (const reason of missingDependencies(sourceEvents)) missing.add(reason);
		return {
			kind: "dependency",
			domain,
			sourceRevision: revision,
			asOfThroughSeq: through,
			completeness: missing.size === 0 ? "complete" : "unknown",
			missing: [...missing],
			chunkCoverage: domain === "turn" ? "timing-boundaries" : "none",
			entries,
			turns: this.turnContexts(index, through)
		};
	}
	expiry(readId) {
		const timer = setTimeout(() => {
			this.closeContent(readId);
		}, this.contentIdleMs);
		timer.unref();
		return timer;
	}
	closeContent(readId) {
		const body = this.content.get(readId);
		if (body === void 0) return;
		clearTimeout(body.timer);
		this.contentBytes -= body.bytes;
		this.content.delete(readId);
	}
};
function atCut(seq, through) {
	return seq !== void 0 && seq <= through ? seq : void 0;
}
function boundedInteger(value, fallback, minimum, maximum, name) {
	const result = value ?? fallback;
	if (!Number.isSafeInteger(result) || result < minimum || result > maximum) throw new SemanticHistoryError("invalid-argument", `${name} must be an integer from ${String(minimum)} through ${String(maximum)}`);
	return result;
}
function splitsSurrogate(text, offset) {
	return offset > 0 && offset < text.length && text.charCodeAt(offset - 1) >= 55296 && text.charCodeAt(offset - 1) <= 56319 && text.charCodeAt(offset) >= 56320 && text.charCodeAt(offset) <= 57343;
}
function contentCharge(key, text) {
	return Math.max(Buffer.byteLength(text), text.length * 2) + key.length * 2 + 128;
}
function blockPreview(blocks) {
	let preview = "";
	for (const block of blocks) {
		if (block.type !== "text" && block.type !== "reasoning") continue;
		if (preview.length > 0) preview += "\n";
		preview += block.text.slice(0, 256 - preview.length);
		if (preview.length >= 256) break;
	}
	return preview;
}
function safePreview(text) {
	const last = text.charCodeAt(text.length - 1);
	return last >= 55296 && last <= 56319 ? text.slice(0, -1) : text;
}
function* eventRange(events, start, end, signal) {
	for (let seq = start; seq <= end; seq += 1) {
		if ((seq & 4095) === 0) signal.throwIfAborted();
		const event = events[seq];
		if (event !== void 0) yield event;
	}
}
function coldIdentity(revision) {
	return `cold-${createHash("sha256").update(revision).digest("hex")}`;
}
/** Event interests declared by the existing Native domain reducers. */
function indexDependencies(index, event) {
	if (event.type === "assistant/chunk") {
		if (index.lastMetricChunk === void 0) index.dependencies.turn.push(event.seq);
		index.lastMetricChunk = event.seq;
		if (event.data.chunk.type === "finish" && (event.data.chunk.reason.kind === "error" || event.data.chunk.reason.kind === "aborted")) {
			if (index.dependencies.turn.at(-1) !== event.seq) index.dependencies.turn.push(event.seq);
			index.lastMetricChunk = void 0;
		}
	} else {
		if (index.lastMetricChunk !== void 0 && index.dependencies.turn.at(-1) !== index.lastMetricChunk) index.dependencies.turn.push(index.lastMetricChunk);
		index.lastMetricChunk = void 0;
	}
	switch (event.type) {
		case "turn/start":
		case "turn/end":
			index.dependencies.tool.push(event.seq);
			index.dependencies.status.push(event.seq);
			index.dependencies.turn.push(event.seq);
			break;
		case "tool/call":
		case "tool/result":
		case "tool/code-dispatch-start":
		case "tool/code-dispatch":
		case "tool-workflow/run-start":
		case "tool-workflow/agent-start":
		case "tool-workflow/agent-end":
		case "tool-workflow/run-end":
			index.dependencies.tool.push(event.seq);
			break;
		case "assistant/message":
			index.dependencies.status.push(event.seq);
			index.dependencies.turn.push(event.seq);
			break;
		case "step/start":
		case "step/end":
			index.dependencies.turn.push(event.seq);
			break;
		case "command/run":
		case "command/done":
		case "compaction/start":
		case "compaction/summary":
		case "compaction/end":
		case "user/message":
		case "request/context":
		case "request/header":
		case "llm/retry":
		case "llm/retry-started":
			index.dependencies.status.push(event.seq);
			break;
		default: break;
	}
}
/** Check relationship presence; domain rendering remains with the existing consumer. */
function missingDependencies(events) {
	const missing = /* @__PURE__ */ new Set();
	const calls = /* @__PURE__ */ new Set();
	const dispatches = /* @__PURE__ */ new Set();
	const workflows = /* @__PURE__ */ new Set();
	const members = /* @__PURE__ */ new Set();
	const commands = /* @__PURE__ */ new Set();
	const compactions = /* @__PURE__ */ new Set();
	const turns = /* @__PURE__ */ new Set();
	for (const event of events) switch (event.type) {
		case "turn/start":
			turns.add(event.data.turn);
			break;
		case "turn/end":
			if (!turns.has(event.data.turn)) missing.add("turn-start");
			break;
		case "tool/call":
			calls.add(event.data.callId);
			break;
		case "tool/result":
			if (!calls.has(event.data.message.source.callId)) missing.add("parent-call");
			break;
		case "tool/code-dispatch-start":
		case "tool/code-dispatch":
			if (!calls.has(event.data.rootCallId) || event.data.parentCallId !== event.data.rootCallId && !dispatches.has(event.data.parentCallId)) missing.add("parent-call");
			if (event.type === "tool/code-dispatch-start") dispatches.add(event.data.subCallId);
			else if (!dispatches.has(event.data.subCallId)) missing.add("dispatch-start");
			break;
		case "tool-workflow/run-start":
			workflows.add(event.data.runId);
			break;
		case "tool-workflow/agent-start":
			if (!workflows.has(event.data.runId)) missing.add("workflow-start");
			members.add(`${event.data.runId}:${String(event.data.seq)}`);
			break;
		case "tool-workflow/agent-end":
			if (!members.has(`${event.data.runId}:${String(event.data.seq)}`)) missing.add("workflow-member");
			break;
		case "tool-workflow/run-end":
			if (!workflows.has(event.data.runId)) missing.add("workflow-start");
			break;
		case "command/run":
			commands.add(event.data.commandId);
			break;
		case "command/done":
			if (!commands.has(event.data.commandId)) missing.add("command-start");
			break;
		case "compaction/start":
			compactions.add(event.data.compactionId);
			break;
		case "compaction/summary":
		case "compaction/end":
			if (!compactions.has(event.data.compactionId)) missing.add("compaction-start");
			break;
		default: break;
	}
	return [...missing];
}
//#endregion
//#region lib/types/session-export.js
/**
* Host-owned Session log download.
*
* The download streams each persisted Session artifact verbatim, optionally
* includes every descendant under `subagents/`, and carries each referenced
* image once under `media/`. A live Session crosses the authoritative flush
* barrier immediately before its raw artifact is read. Compression and the
* response queue are bounded, and request or consumer cancellation terminates
* the producer rather than yielding a truncated archive.
*
* @module @deepseek-ai/dsh-host-session-remote-operations/session-export
*/
/** Final Host path for the Native Session archive download. */
const SESSION_EXPORT_PATH = "/api/session/export";
/** Balanced default for Session archive compression. */
const DEFAULT_SESSION_LOG_COMPRESSION_LEVEL = 6;
const sessionLogQuerySchema = z.object({
	sessionId: z.string().min(1).transform((value) => SessionId(value)),
	includeDescendants: z.union([z.literal("true"), z.literal("false")]).optional()
}).transform((query) => ({
	sessionId: query.sessionId,
	includeDescendants: query.includeDescendants === "true"
}));
/**
* Validate one deployment compression value without silently rounding.
* @param value - configured level or undefined for the balanced default.
* @returns the exact accepted compression level.
*/
function sessionLogCompressionLevel(value) {
	const resolved = value ?? 6;
	if (!Number.isInteger(resolved) || resolved < 0 || resolved > 9) throw new Error(`sessionExportCompressionLevel must be an integer from 0 to 9; received ${String(resolved)}`);
	return resolved;
}
/**
* Resolve the persistence, lineage, attachment, and live-session owners.
* @param ctx - composed Host context.
* @returns mounted owners, retaining absence for fail-loud HTTP responses.
*/
function sessionLogExportDeps(ctx) {
	return {
		sessionQuery: ctx.get("sessionQuery"),
		sessionPersistence: ctx.get("sessionPersistence"),
		attachments: ctx.get("attachments"),
		sessions: ctx.get("sessions")
	};
}
/**
* Flush a live Session immediately before reading its raw durable artifact.
* @param deps - export owners including the optional live Session store.
* @param id - Session being read.
* @param signal - caller cancellation around the durability barrier.
*/
async function flushLiveSessionLog(deps, id, signal) {
	signal?.throwIfAborted();
	const sessions = deps.sessions;
	if (sessions === void 0) return;
	const session = sessions.get(id);
	if (session === void 0) return;
	await sessions.flush(session);
	signal?.throwIfAborted();
}
const MEDIA_TYPE_EXTENSIONS = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/webp": "webp",
	"image/gif": "gif"
};
function mediaEntryPath(ref) {
	return `media/${String(ref.attachmentId)}.${MEDIA_TYPE_EXTENSIONS[ref.mediaType]}`;
}
function collectImageRefs(content, refs) {
	if (!Array.isArray(content)) return;
	const pending = Array.from(content);
	while (pending.length > 0) {
		const value = pending.pop();
		if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
		const block = value;
		if (block.type === "image" && typeof block.attachment === "object" && block.attachment !== null) {
			const ref = block.attachment;
			refs.set(String(ref.attachmentId), ref);
		}
		if (Array.isArray(block.content)) pending.push(...Array.from(block.content));
	}
}
function collectEventImageRefs(event, refs) {
	const data = event.data;
	if (typeof data !== "object" || data === null) return;
	const carrier = data;
	collectImageRefs(carrier.content, refs);
	if (carrier.message !== void 0) collectImageRefs(carrier.message.content, refs);
	if (carrier.inserted !== void 0) for (const message of carrier.inserted) collectImageRefs(message.content, refs);
	if (carrier.chunk?.type === "block-end") collectImageRefs([carrier.chunk.block], refs);
}
function imageRefsInArtifact(content) {
	const refs = /* @__PURE__ */ new Map();
	for (const line of content.split("\n")) {
		if (line === "") continue;
		try {
			collectEventImageRefs(JSON.parse(line), refs);
		} catch {}
	}
	return refs;
}
function safeSessionIdSegment(id) {
	return id.replace(/[^A-Za-z0-9_-]/g, "_");
}
/**
* Build the archive filename for one root Session.
* @param sessionId - root Session identity.
* @returns path-safe attachment filename.
*/
function sessionLogZipFilename(sessionId) {
	return `dsh-session-${safeSessionIdSegment(sessionId)}.zip`;
}
/**
* Yield root, descendants, then distinct referenced media in archive order.
* @param deps - mounted export owners.
* @param root - already-prepared root artifact.
* @param sessionId - root Session identity.
* @param includeDescendants - whether lineage descendants are included.
* @param signal - read and lineage cancellation.
* @returns entries in deterministic archive order.
*/
async function* sessionLogZipEntries(deps, root, sessionId, includeDescendants, signal) {
	const media = /* @__PURE__ */ new Map();
	const rememberMedia = (content) => {
		for (const [id, ref] of imageRefsInArtifact(content)) media.set(id, ref);
	};
	rememberMedia(root.content);
	yield {
		path: root.filename,
		content: root.content
	};
	if (includeDescendants) {
		const seen = new Set([sessionId]);
		const collect = async function* (nodes) {
			for (const node of nodes) {
				signal?.throwIfAborted();
				const id = node.session.header.id;
				if (seen.has(id)) continue;
				seen.add(id);
				await flushLiveSessionLog(deps, id, signal);
				const raw = await deps.sessionPersistence.readRaw(id, signal);
				signal?.throwIfAborted();
				if (raw === void 0) throw new Error(`subagent "${id}" has no stored log artifact`);
				rememberMedia(raw.content);
				yield {
					path: `subagents/${safeSessionIdSegment(id)}/${raw.filename}`,
					content: raw.content
				};
				yield* collect(node.descendants);
			}
		};
		const lineage = await deps.sessionQuery.traceSession(sessionId, signal);
		signal?.throwIfAborted();
		yield* collect(lineage.descendants);
	}
	for (const ref of media.values()) {
		signal?.throwIfAborted();
		const stored = await deps.attachments.readImage(ref, signal);
		signal?.throwIfAborted();
		yield {
			path: mediaEntryPath(ref),
			data: stored.data
		};
	}
}
const PUSH_CHUNK_CODE_UNITS = 65536;
const PUSH_CHUNK_BYTES = 65536;
const RESPONSE_HIGH_WATER_MARK_BYTES = 65536;
var ResponseCapacityGate = class {
	releasePending;
	async wait(controller, signal) {
		signal.throwIfAborted();
		if (controller.desiredSize === null || controller.desiredSize > 0) return;
		await new Promise((resolve) => {
			const release = () => {
				this.releasePending = void 0;
				signal.removeEventListener("abort", release);
				resolve();
			};
			this.releasePending = release;
			signal.addEventListener("abort", release, { once: true });
		});
		signal.throwIfAborted();
	}
	pulled() {
		this.releasePending?.();
	}
};
async function pushBinaryChunks(deflate, data, controller, capacity, signal) {
	let offset = 0;
	do {
		signal.throwIfAborted();
		const end = Math.min(offset + PUSH_CHUNK_BYTES, data.byteLength);
		const finalChunk = end >= data.byteLength;
		deflate.push(data.subarray(offset, end), finalChunk);
		offset = end;
		await capacity.wait(controller, signal);
	} while (offset < data.byteLength);
}
async function pushArtifactChunks(deflate, content, controller, capacity, signal) {
	const encoder = new TextEncoder();
	let offset = 0;
	let finalChunk;
	do {
		signal.throwIfAborted();
		let end = Math.min(offset + PUSH_CHUNK_CODE_UNITS, content.length);
		if (end < content.length && end - offset > 1) {
			const last = content.charCodeAt(end - 1);
			if (last >= 55296 && last <= 56319) end -= 1;
		}
		finalChunk = end >= content.length;
		deflate.push(encoder.encode(content.slice(offset, end)), finalChunk);
		offset = end;
		await capacity.wait(controller, signal);
	} while (!finalChunk);
}
/**
* Stream one prepared Session ZIP with byte-capacity backpressure.
* @param deps - mounted export owners.
* @param root - prepared root artifact.
* @param sessionId - root Session identity.
* @param includeDescendants - whether lineage descendants are included.
* @param compressionLevel - validated DEFLATE level.
* @param signal - request cancellation combined with consumer cancellation.
* @returns pull-aware archive byte stream.
*/
function streamSessionLogZip(deps, root, sessionId, includeDescendants, compressionLevel, signal) {
	const producerAbort = new AbortController();
	const producerSignal = AbortSignal.any([signal, producerAbort.signal]);
	let zip;
	let zipTerminated = false;
	let zipTerminationFailed = false;
	let zipTerminationFailure;
	let producer;
	const capacity = new ResponseCapacityGate();
	let settleZip;
	let terminal;
	const zipOutcome = new Promise((resolve) => {
		settleZip = resolve;
	});
	const settleZipOnce = (outcome) => {
		if (terminal !== void 0) return false;
		terminal = outcome;
		settleZip(outcome);
		return true;
	};
	const terminateZip = () => {
		if (zip === void 0 || zipTerminated) return;
		zipTerminated = true;
		try {
			zip.terminate();
		} catch (error) {
			zipTerminationFailed = true;
			zipTerminationFailure = error;
		}
	};
	return new ReadableStream({
		start(controller) {
			const fail = (error) => {
				const normalized = sessionExportError(producerSignal.aborted ? producerSignal.reason : error);
				if (!settleZipOnce({
					kind: "failed",
					error: normalized
				})) return;
				controller.error(normalized);
				producerAbort.abort(normalized);
			};
			const archive = new Zip((error, data, final) => {
				if (terminal !== void 0) return;
				if (error) {
					fail(error);
					return;
				}
				if (producerSignal.aborted) {
					fail(producerSignal.reason);
					return;
				}
				try {
					if (data.byteLength > 0) controller.enqueue(data);
					if (final) {
						zipTerminated = true;
						controller.close();
						settleZipOnce({ kind: "completed" });
					}
				} catch (callbackError) {
					fail(callbackError);
				}
			});
			zip = archive;
			producer = (async () => {
				try {
					for await (const entry of sessionLogZipEntries(deps, root, sessionId, includeDescendants, producerSignal)) {
						producerSignal.throwIfAborted();
						const deflate = new ZipDeflate(entry.path, { level: compressionLevel });
						archive.add(deflate);
						producerSignal.throwIfAborted();
						if ("content" in entry) await pushArtifactChunks(deflate, entry.content, controller, capacity, producerSignal);
						else await pushBinaryChunks(deflate, entry.data, controller, capacity, producerSignal);
					}
					producerSignal.throwIfAborted();
					archive.end();
					const outcome = await zipOutcome;
					if (outcome.kind !== "completed") throw outcome.error;
				} catch (error) {
					const normalized = sessionExportError(error);
					if (terminal?.kind !== "cancelled") fail(normalized);
					terminateZip();
					if (terminal?.kind === "cancelled") {
						if (error === producerSignal.reason) return;
						throw normalized;
					}
				}
			})();
		},
		pull() {
			capacity.pulled();
		},
		async cancel(reason) {
			const cancellation = reason instanceof Error ? reason : /* @__PURE__ */ new Error("session log export stream cancelled");
			settleZipOnce({
				kind: "cancelled",
				error: cancellation
			});
			producerAbort.abort(cancellation);
			terminateZip();
			await producer;
			if (zipTerminationFailed) throw zipTerminationFailure;
		}
	}, {
		highWaterMark: RESPONSE_HIGH_WATER_MARK_BYTES,
		size: (chunk) => chunk.byteLength
	});
}
function sessionExportError(error) {
	return error instanceof Error ? error : new Error(String(error));
}
async function prepareSessionLogExport(ctx, sessionId, includeDescendants, signal) {
	const deps = sessionLogExportDeps(ctx);
	if (deps.sessionQuery === void 0 || deps.sessionPersistence === void 0 || deps.attachments === void 0) return new Response("session log export is unavailable: missing session-query, session-persistence, or attachments service", { status: 500 });
	if (!deps.sessionPersistence.supportsRawArtifacts) return new Response("session log export is unavailable: the persistence backend does not expose per-session raw artifacts", { status: 501 });
	const ready = {
		sessionQuery: deps.sessionQuery,
		sessionPersistence: deps.sessionPersistence,
		attachments: deps.attachments,
		sessions: deps.sessions
	};
	let root;
	try {
		await flushLiveSessionLog(deps, sessionId, signal);
		root = await deps.sessionPersistence.readRaw(sessionId, signal);
		signal.throwIfAborted();
	} catch {
		signal.throwIfAborted();
		return new Response("session log export failed to prepare the stored artifact", { status: 500 });
	}
	if (root === void 0) return new Response("session not found", { status: 404 });
	return {
		ready,
		root,
		sessionId,
		includeDescendants,
		headers: new Headers({
			"content-type": "application/zip",
			"content-disposition": `attachment; filename="${sessionLogZipFilename(sessionId)}"`
		})
	};
}
/**
* Handle the final GET/HEAD Session export endpoint.
* @param ctx - composed Host context.
* @param request - trusted request already admitted by Host Connection.
* @param compressionLevel - validated deployment compression level.
* @returns bodyless HEAD preflight, streaming GET, or fail-loud status.
*/
async function fetchSessionLogExport(ctx, request, compressionLevel) {
	const url = new URL(request.url);
	if (url.pathname !== "/api/session/export" || request.method !== "GET" && request.method !== "HEAD") return new Response("not found", { status: 404 });
	const parsed = sessionLogQuerySchema.safeParse(Object.fromEntries(url.searchParams));
	if (!parsed.success) return new Response("missing or invalid sessionId query parameter", { status: 400 });
	const prepared = await prepareSessionLogExport(ctx, parsed.data.sessionId, parsed.data.includeDescendants, request.signal);
	if (prepared instanceof Response) return request.method === "HEAD" ? new Response(null, {
		status: prepared.status,
		headers: prepared.headers
	}) : prepared;
	if (request.method === "HEAD") return new Response(null, { headers: prepared.headers });
	return new Response(streamSessionLogZip(prepared.ready, prepared.root, prepared.sessionId, prepared.includeDescendants, compressionLevel, request.signal), { headers: prepared.headers });
}
//#endregion
//#region lib/types/index.js
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
const DEFAULT_COLD_BLANK_PROBE_MAX_BYTES = 1024;
const COLD_SUMMARY_BATCH_SIZE = 16;
const DEFAULT_MAX_MESSAGES = 50;
const MAX_HISTORY_MESSAGES = 2048;
const MAX_HISTORY_PAGE_EVENTS = 2048;
const MAX_HISTORY_PAGE_ENCODED_BYTES = 1048576;
const SESSION_SEARCH_RESULT_LIMIT = 20;
const SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS = 240;
const SESSION_SEARCH_PROVIDER_CALL_LIMIT = 100;
const MESSAGE_TYPES = new Set(["user/message", "assistant/message"]);
const sessionListMetadataSchema = z.object({
	blank: z.boolean(),
	lastPromptAt: z.number().nullable()
});
const imageLimitsSchema = z.object({
	maxImageBytes: z.number().int().positive(),
	maxImagesPerMessage: z.number().int().positive(),
	maxMessageImageBytes: z.number().int().positive(),
	maxImagePixels: z.number().int().positive(),
	maxImageDimension: z.number().int().positive(),
	mediaTypes: z.array(z.union([
		z.literal("image/png"),
		z.literal("image/jpeg"),
		z.literal("image/webp"),
		z.literal("image/gif")
	]))
});
/** Requested identity already belongs to another project directory. */
var SessionCwdConflict = class extends Error {
	sessionId;
	requestedCwd;
	existingCwd;
	constructor(sessionId, requestedCwd, existingCwd) {
		super(`session "${sessionId}" already exists with cwd ${JSON.stringify(existingCwd)}; requested ${JSON.stringify(requestedCwd)}`);
		this.sessionId = sessionId;
		this.requestedCwd = requestedCwd;
		this.existingCwd = existingCwd;
	}
};
/** Requested preset differs from the composition whose tools produced the log. */
var SessionPresetConflict = class extends Error {
	sessionId;
	requestedPreset;
	existingPreset;
	constructor(sessionId, requestedPreset, existingPreset) {
		super(existingPreset === void 0 ? `session "${sessionId}" records no agent preset; requested ${JSON.stringify(requestedPreset)}` : `session "${sessionId}" runs ${JSON.stringify(existingPreset)}; requested ${JSON.stringify(requestedPreset)}`);
		this.sessionId = sessionId;
		this.requestedPreset = requestedPreset;
		this.existingPreset = existingPreset;
	}
};
/** Build one successful generated-port result. */
function success(value) {
	return {
		ok: true,
		value
	};
}
/** Preserve the Promise-shaped Host port for one synchronous mutation. */
function settled(result) {
	return Promise.resolve(result);
}
/** Build one stable generated-port business failure. */
function failure(code, message, details = {}) {
	return {
		ok: false,
		error: {
			code,
			message,
			details
		}
	};
}
/** Generated-port cancellation spelling. */
function cancelled(message = "session Remote invocation was cancelled") {
	return failure("cancelled", message);
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
		if (count === maximum) return value.slice(0, end);
		count += 1;
		end += codePoint.length;
	}
	return value;
}
/** Session-header fields shared by attached and cold listing rows. */
function summaryFields(header, projections) {
	const preset = projections?.values.agentPreset;
	return {
		...header.parentSession === void 0 ? {} : { parentSessionId: header.parentSession },
		...header.origin === void 0 ? {} : { origin: header.origin },
		...header.cwd === void 0 ? {} : { cwd: header.cwd },
		...typeof preset !== "string" ? {} : { agentPreset: preset }
	};
}
/** Convert a projection snapshot without leaking mutable registry state. */
function remoteProjections(value) {
	if (value === void 0 || value === null || typeof value !== "object") return void 0;
	const candidate = value;
	const asOfSeq = candidate.asOfSeq;
	if (typeof asOfSeq !== "number" || !Number.isSafeInteger(asOfSeq) || candidate.values === null || typeof candidate.values !== "object" || Array.isArray(candidate.values)) return void 0;
	const values = jsonValue(candidate.values);
	if (values === void 0 || Array.isArray(values) || values === null || typeof values !== "object") return void 0;
	return {
		asOfSeq,
		values
	};
}
/** Convert one validated durable event to the generated Remote envelope. */
function remoteEvent(event) {
	const envelope = event;
	const data = jsonValue(event.data);
	if (data === void 0) throw new Error(`session event ${event.type} has no lossless JSON payload`);
	const surfaceOp = envelope.surfaceOp === void 0 ? void 0 : jsonValue(envelope.surfaceOp);
	if (envelope.surfaceOp !== void 0 && surfaceOp === void 0) throw new Error(`session event ${event.type} has no lossless surface operation`);
	return {
		type: event.type,
		seq: event.seq,
		time: event.time,
		data,
		...envelope.sourceEventSeqs === void 0 ? {} : { sourceEventSeqs: [...envelope.sourceEventSeqs] },
		...surfaceOp === void 0 ? {} : { surfaceOp },
		...event.ignorable === true ? { ignorable: true } : {}
	};
}
/** Find the exclusive array end for one sequence cursor without copying the log. */
function historyEndIndex(events, beforeSeq) {
	if (beforeSeq === void 0) return events.length;
	let lower = 0;
	let upper = events.length;
	while (lower < upper) {
		const middle = lower + Math.floor((upper - lower) / 2);
		if (events[middle].seq < beforeSeq) lower = middle + 1;
		else upper = middle;
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
		if (groupStart !== void 0) {
			if (event.seq <= groupStart) break;
			continue;
		}
		if (!MESSAGE_TYPES.has(event.type) || !isAppendSurfaceEvent(event)) continue;
		count += 1;
		if (count < maxMessages) continue;
		groupStart = event.seq;
		for (const source of event.sourceEventSeqs ?? []) groupStart = Math.min(groupStart, source);
		if (event.seq <= groupStart) break;
	}
	return {
		events: events.slice(start, end),
		hasMore: start > 0
	};
}
/** UTF-8 bytes occupied by one encoded history entry in the response array. */
function historyEntryBytes(entry) {
	return Buffer.byteLength(JSON.stringify(entry), "utf8");
}
/**
* Apply the hard encoded-byte bound after presentation metadata is attached.
* If the newest single entry itself exceeds the bound, return that one entry
* so the monotonic cursor still advances instead of livelocking.
*/
function historyEntryWindow(source, project, maximumEncodedBytes) {
	if (source.events.length === 0) return {
		events: [],
		entries: [],
		hasMore: false
	};
	let start = source.events.length;
	let encodedBytes = 2;
	while (start > 0) {
		const entryBytes = historyEntryBytes(project(source.events[start - 1], source.events));
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
	const entries = events.map((event) => project(event, events));
	const finalEncodedBytes = Buffer.byteLength(JSON.stringify(entries), "utf8");
	if (entries.length > 1 && finalEncodedBytes > maximumEncodedBytes) throw new Error("history presentation metadata exceeded the encoded page budget");
	return {
		events,
		entries,
		hasMore: source.hasMore || start > 0
	};
}
/** Project one tool event through the owning Tool definition, fail-soft. */
function eventView(ctx, event, page, scope) {
	const tools = ctx.get("tools");
	if (tools === void 0) return void 0;
	try {
		if (event.type === "tool/call") {
			const data = event.data;
			const view = tools.get(data.name, scope)?.presentCall?.(JSON.parse(data.arguments));
			return view === void 0 ? void 0 : jsonValue({
				for: "call",
				view
			});
		}
		if (event.type === "tool/result") {
			const message = event.data.message;
			const result = message.content[0];
			const call = findToolCallArguments(page, message.source.callId);
			if (call === void 0) return void 0;
			const view = tools.get(call.name, scope)?.presentResult?.(call.args, {
				content: result.content,
				isError: result.isError === true,
				...event.data.meta === void 0 ? {} : { meta: event.data.meta }
			});
			return view === void 0 ? void 0 : jsonValue({
				for: "result",
				view
			});
		}
	} catch (error) {
		ctx.logger.warn(`session Remote presenter failed for ${event.type}: ${String(error)}`);
	}
}
/** Search durable event carriers for an authorized attachment reference. */
function imageBlockIn(content, match) {
	if (!Array.isArray(content)) return void 0;
	for (const value of content) {
		if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
		const block = value;
		if (block.type === "image" && block.attachment !== null && typeof block.attachment === "object") {
			const ref = block.attachment;
			if (match(ref)) return ref;
		}
		if (block.type === "tool-result") {
			const nested = imageBlockIn(block.content, match);
			if (nested !== void 0) return nested;
		}
	}
}
/** Search every durable content carrier in one event. */
function imageInEvent(event, match) {
	const data = event.data;
	const direct = imageBlockIn(data.content, match);
	if (direct !== void 0) return direct;
	const wrapped = imageBlockIn(data.message?.content, match);
	if (wrapped !== void 0) return wrapped;
	for (const message of data.inserted ?? []) {
		const inserted = imageBlockIn(message.content, match);
		if (inserted !== void 0) return inserted;
	}
	return event.type === "assistant/chunk" && data.chunk?.type === "block-end" ? imageBlockIn([data.chunk.block], match) : void 0;
}
/** Resolve one attachment only when the addressed Session log references it. */
function referencedImage(events, attachmentId) {
	for (const event of events) {
		const found = imageInEvent(event, (ref) => String(ref.attachmentId) === attachmentId);
		if (found !== void 0) return found;
	}
}
/** Whether the transcript currently ends inside an open turn. */
function hasOpenTurn(session) {
	return session.events.findLast((event) => event.type === "turn/start" || event.type === "turn/end")?.type === "turn/start";
}
/** Host implementation of G2's generated Session port and Workspace retirer. */
var SessionRemoteOperationsService = class extends Service {
	static inject = [
		"agentDefaultModel",
		"agents",
		"attachments",
		"llm",
		"sessions",
		"workspaceRegistry"
	];
	coldBlankProbeMaxBytes;
	defaultCwd;
	/** Exact loopback-only path for streaming Session archives. */
	path = SESSION_EXPORT_PATH;
	sessionExportCompressionLevel;
	handles = /* @__PURE__ */ new Map();
	creations = /* @__PURE__ */ new Map();
	resumes = /* @__PURE__ */ new Map();
	admissionChains = /* @__PURE__ */ new WeakMap();
	lifetime = new AbortController();
	semanticHistory;
	constructor(ctx, config = {}) {
		super(ctx, "sessionRemoteOperations");
		this.semanticHistory = new SemanticHistoryReader(ctx, (source) => {
			let scope;
			return async (event, dependencies) => {
				const view = event.type === "tool/call" || event.type === "tool/result" ? eventView(ctx, event, dependencies, await (scope ??= this.standingPresenterScope(source))) : void 0;
				return {
					event: remoteEvent(event),
					...view === void 0 ? {} : { view }
				};
			};
		}, config.semanticHistory);
		this.coldBlankProbeMaxBytes = config.coldBlankProbeMaxBytes ?? DEFAULT_COLD_BLANK_PROBE_MAX_BYTES;
		if (!Number.isSafeInteger(this.coldBlankProbeMaxBytes) || this.coldBlankProbeMaxBytes < 0) throw new RangeError("coldBlankProbeMaxBytes must be a non-negative safe integer");
		this.defaultCwd = config.cwd ?? process.cwd();
		this.sessionExportCompressionLevel = sessionLogCompressionLevel(config.sessionExportCompressionLevel);
		if (!isAbsolute(this.defaultCwd)) throw new Error(`host-session-remote-operations cwd must be absolute: ${JSON.stringify(this.defaultCwd)}`);
		ctx.provide("workspaceSessionRetirer", this);
		ctx.inject(["connection"], (connectionCtx) => connectionCtx.connection.downloads.handle(this.path, (request, signal) => this.fetch(request, signal), { authority: "loopback" }));
		ctx.on("agent/disposed", ({ agent }) => {
			if (this.handles.get(agent.id)?.agent === agent) this.handles.delete(agent.id);
		});
		ctx.effect(() => async () => {
			this.lifetime.abort(/* @__PURE__ */ new Error("session Remote operations disposed"));
			this.semanticHistory.clear();
			const handles = [...this.handles.values()];
			this.handles.clear();
			await Promise.allSettled(handles.map((handle) => handle.dispose({ keepInbox: true })));
		}, "host-session-remote-operations: owned Agent handles");
		ctx.inject(["sessionProjections"], (projectionCtx) => {
			installPromptReceipts(projectionCtx);
			projectionCtx.sessionProjections.register({
				key: "sessionListMetadata",
				stateSchema: sessionListMetadataSchema,
				init: () => ({
					blank: true,
					lastPromptAt: null
				}),
				apply: (state, event) => {
					const blank = state.blank && event.type !== "turn/start";
					const latest = event.type === "user/message" && event.data.source.kind === "user" ? event.time : state.lastPromptAt;
					return blank === state.blank && latest === state.lastPromptAt ? state : {
						blank,
						lastPromptAt: latest
					};
				},
				wire: {
					viewSchema: sessionListMetadataSchema,
					view: (state) => state
				},
				stateVersion: 1
			});
		});
		ctx.inject(["sessionProjections", "attachments"], (projectionCtx) => {
			projectionCtx.sessionProjections.register({
				key: "imageLimits",
				stateSchema: z.null(),
				init: () => null,
				apply: (state) => state,
				wire: {
					viewSchema: imageLimitsSchema,
					view: () => projectionCtx.attachments.imageLimits
				},
				stateVersion: 1
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
		return fetchSessionLogExport(this.ctx, signal === void 0 ? request : new Request(request, { signal }), this.sessionExportCompressionLevel);
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
		const presets = this.ctx.get("agentPresets");
		if (presets === void 0) return { setup: (agentCtx) => {
			const agent = agentCtx.agent;
			if (agent === void 0) throw new Error("session Remote setup has no scoped agent");
			this.selectionFor(agent);
		} };
		const resolved = await presets.resolve(presetId);
		return {
			agentPreset: resolved.id,
			setup: async (agentCtx) => {
				const agent = agentCtx.agent;
				if (agent === void 0) throw new Error("session Remote setup has no scoped agent");
				this.selectionFor(agent);
				await presets.mount(agentCtx, resolved.id);
			}
		};
	}
	/** Revalidate Workspace archive/deletion admission around publication. */
	withSessionAdmission(setup, checks) {
		return async (agentCtx) => {
			const prepared = await setup?.(agentCtx);
			return { commit: () => {
				for (const check of checks) this.ctx.workspaceRegistry.assertSessionAdmission(check.sessionId, check.revision);
				prepared?.commit();
				for (const check of checks) this.ctx.workspaceRegistry.assertSessionAdmission(check.sessionId, check.revision);
			} };
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
		if (requested === void 0 || requested === existing) return;
		throw new SessionPresetConflict(sessionId, requested, existing);
	}
	/** Read one attached or persisted Session without acquiring a live Agent. */
	async readSessionState(sessionId, signal) {
		signal.throwIfAborted();
		const attached = this.ctx.sessions.get(sessionId);
		if (attached !== void 0) return {
			id: attached.id,
			header: attached.header,
			events: [...attached.events]
		};
		const persistence = this.ctx.get("sessionPersistence");
		if (persistence === void 0) throw new Error("session persistence is not configured");
		const header = (await persistence.list(signal)).find((candidate) => candidate.id === sessionId);
		if (header === void 0 || header.cwd === void 0) throw new ApiRemoteSessionNotFound(`session "${sessionId}" not found`);
		const inspected = await persistence.inspect(sessionId, signal);
		signal.throwIfAborted();
		if (inspected.meta.cwd === void 0) throw new ApiRemoteSessionNotFound(`session "${sessionId}" not found`);
		return {
			id: inspected.meta.id,
			header: inspected.meta,
			events: [...inspected.events]
		};
	}
	/** Resolve one ordinary Session to a live Agent, resuming once per id. */
	async agentFor(sessionId) {
		const revision = this.ctx.workspaceRegistry.sessionAdmissionRevision(sessionId);
		try {
			this.ctx.workspaceRegistry.assertSessionAdmission(sessionId, revision);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			return failure("agent-busy", reason, { reason });
		}
		const live = this.ctx.agents.get(sessionId);
		if (live !== void 0) {
			if (hasApiRemoteSubagentOwner(this.ctx, live.session, live)) return this.subagentFailure(sessionId);
			return success(live);
		}
		const attached = this.ctx.sessions.get(sessionId);
		if (attached !== void 0 && hasApiRemoteSubagentOwner(this.ctx, attached, void 0)) return this.subagentFailure(sessionId);
		let resume = this.resumes.get(sessionId);
		if (resume === void 0) {
			resume = (async () => {
				const inspected = await this.readSessionState(sessionId, this.lifetime.signal);
				if (hasApiRemoteSubagentOwner(this.ctx, { header: inspected.header }, void 0)) throw new ApiRemoteSubagentSessionOwnership(sessionId);
				const preset = resolveSessionPreset({
					header: inspected.header,
					events: inspected.events
				});
				const composition = await this.composeAgent(preset);
				const handle = await this.ctx.agents.resume({
					resumeSessionId: sessionId,
					agentOptions: this.agentOptions(),
					signal: this.lifetime.signal,
					setup: this.withSessionAdmission(composition.setup, [{
						sessionId,
						revision
					}])
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
			if (hasApiRemoteSubagentOwner(this.ctx, agent.session, agent)) return this.subagentFailure(sessionId);
			return success(agent);
		} catch (error) {
			if (error instanceof ApiRemoteSessionNotFound) return failure("session-not-found", error.message, { sessionId });
			if (error instanceof ApiRemoteSubagentSessionOwnership) return this.subagentFailure(error.sessionId);
			const raced = this.ctx.agents.get(sessionId);
			if (raced !== void 0) {
				if (hasApiRemoteSubagentOwner(this.ctx, raced.session, raced)) return this.subagentFailure(sessionId);
				return success(raced);
			}
			return failure("internal", `resume failed for session "${sessionId}": ${String(error)}`);
		}
	}
	/** Serialize model switching and prompt admission for one exact Agent. */
	serializeAdmission(agent, operation) {
		const result = (this.admissionChains.get(agent) ?? Promise.resolve()).then(operation);
		this.admissionChains.set(agent, result.then(() => void 0, () => void 0));
		return result;
	}
	/** One exact projection cut for an attached or detached transcript. */
	projectionsFor(source) {
		const projections = this.ctx.get("sessionProjections");
		if (projections === void 0) return void 0;
		try {
			return remoteProjections(source.kind === "attached" ? projections.snapshot(source.session) : projections.restore({}, source.events, 0, source.header).snapshot);
		} catch (error) {
			this.ctx.logger.warn(`session Remote projections unavailable: ${String(error)}`);
			return;
		}
	}
	/** Resolve the presentation scope without resuming a cold Session. */
	async presenterScope(sessionId, source) {
		const live = this.ctx.agents.get(sessionId);
		if (live !== void 0) return live;
		return this.standingPresenterScope(source);
	}
	/** Historical scope is resolved from the caller's fixed cut, never today's live preset. */
	async standingPresenterScope(source) {
		const presets = this.ctx.get("agentPresets");
		if (presets === void 0) return void 0;
		try {
			return await presets.standingKeyFor(resolveSessionPreset(source));
		} catch {
			return;
		}
	}
	/** Cached listing hints never materialize a missing projection or replay a log. */
	listProjections(header, session) {
		try {
			return remoteProjections(session === void 0 ? this.ctx.get("sessionProjectionCache")?.cachedSnapshot(header) : this.ctx.get("sessionProjections")?.cachedSnapshot(session));
		} catch (error) {
			this.ctx.logger.warn(`session.list: cached projections unavailable for "${header.id}": ${String(error)}`);
			return;
		}
	}
	attachedSummary(session) {
		const projections = this.listProjections(session.header, session);
		const metadata = sessionListMetadataSchema.safeParse(projections?.values.sessionListMetadata);
		return {
			sessionId: session.id,
			updatedAt: Math.max(session.header.createdAt, metadata.success ? metadata.data.lastPromptAt ?? 0 : 0),
			running: this.ctx.agents.get(session.id)?.status === "running",
			blank: metadata.success ? metadata.data.blank : session.seq === 0,
			...summaryFields(session.header, projections),
			...projections === void 0 ? {} : { projections }
		};
	}
	/** Only small physical artifacts may be observed for an unknown cold blank hint. */
	async smallColdProjections(query, header, signal) {
		if (this.coldBlankProbeMaxBytes === 0) return void 0;
		const location = this.ctx.get("sessionPersistence")?.locate(header);
		if (location === void 0) return void 0;
		signal.throwIfAborted();
		try {
			if ((await stat(location.path)).size > this.coldBlankProbeMaxBytes) return void 0;
		} catch {
			signal.throwIfAborted();
			return;
		}
		try {
			const env_1 = {
				stack: [],
				error: void 0,
				hasError: false
			};
			try {
				const observation = __addDisposableResource(env_1, await query.observeSession(header.id, {
					signal,
					projectionMode: "all"
				}), false);
				signal.throwIfAborted();
				return remoteProjections(observation.projections);
			} catch (e_1) {
				env_1.error = e_1;
				env_1.hasError = true;
			} finally {
				__disposeResources(env_1);
			}
		} catch (error) {
			signal.throwIfAborted();
			this.ctx.logger.warn(`session.list: small cold observation for "${header.id}" failed; serving it visible: ${String(error)}`);
			return;
		}
	}
	async coldSummary(query, header, signal) {
		const cached = this.listProjections(header);
		const metadata = sessionListMetadataSchema.safeParse(cached?.values.sessionListMetadata);
		const projections = metadata.success && !metadata.data.blank ? cached : await this.smallColdProjections(query, header, signal) ?? cached;
		const raced = this.ctx.sessions.get(header.id);
		if (raced !== void 0) return this.attachedSummary(raced);
		const current = sessionListMetadataSchema.safeParse(projections?.values.sessionListMetadata);
		return {
			sessionId: header.id,
			updatedAt: Math.max(header.createdAt, current.success ? current.data.lastPromptAt ?? 0 : 0),
			running: false,
			blank: current.success ? current.data.blank : false,
			...summaryFields(header, projections),
			...projections === void 0 ? {} : { projections }
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
			if (live !== void 0) rows.push(this.attachedSummary(live));
			else if (record.header.cwd !== void 0) cold.push(record.header);
		}
		for (let offset = 0; offset < cold.length; offset += COLD_SUMMARY_BATCH_SIZE) {
			signal.throwIfAborted();
			const settled = await Promise.allSettled(cold.slice(offset, offset + COLD_SUMMARY_BATCH_SIZE).map((header) => this.coldSummary(query, header, signal)));
			for (const result of settled) {
				if (result.status === "rejected") throw result.reason;
				rows.push(result.value);
			}
		}
		rows.sort((left, right) => right.updatedAt - left.updatedAt);
		return rows;
	}
	/** List every attached or persisted Session visible to ordinary routing. */
	async list(_request, signal) {
		if (aborted(signal)) return cancelled();
		const query = this.ctx.get("sessionQuery");
		if (query === void 0) return failure("internal", "session listing is unavailable: this deployment does not mount @deepseek-ai/dsh-session-query");
		try {
			return success({ items: await this.visibleSummaries(query, signal) });
		} catch (error) {
			if (aborted(signal)) return cancelled();
			return failure("internal", `session listing failed: ${String(error)}`);
		}
	}
	/** Search current message surfaces, then enforce ordinary Session visibility. */
	async search(request, signal) {
		if (aborted(signal)) return cancelled("session search was aborted");
		const query = request.query.trim();
		if (query.length === 0 || query.length > 500 || query.includes("\0")) return failure("invalid-argument", "session search query must be 1-500 non-NUL characters");
		const sessionQuery = this.ctx.get("sessionQuery");
		if (sessionQuery === void 0) return failure("internal", "session search is unavailable: this deployment does not mount @deepseek-ai/dsh-session-query");
		try {
			const visible = await sessionQuery.listSessions(signal);
			signal.throwIfAborted();
			const visibleIds = new Set(visible.filter((record) => record.header.cwd !== void 0).map((record) => record.header.id));
			if (visibleIds.size === 0) return success({
				items: [],
				hasMore: false
			});
			const accepted = [];
			const acceptedIds = /* @__PURE__ */ new Set();
			const seenCursors = /* @__PURE__ */ new Set();
			let cursor;
			let calls = 0;
			let pageLimit = SESSION_SEARCH_RESULT_LIMIT;
			while (accepted.length <= SESSION_SEARCH_RESULT_LIMIT) {
				signal.throwIfAborted();
				if (calls >= SESSION_SEARCH_PROVIDER_CALL_LIMIT) throw new Error(`session search provider exceeded ${SESSION_SEARCH_PROVIDER_CALL_LIMIT} calls`);
				calls += 1;
				const requestedCursor = cursor;
				const requestedLimit = pageLimit;
				let page;
				try {
					page = await sessionQuery.searchSessions({
						query,
						eventFilters: [{
							kind: "type",
							values: ["user/message", "assistant/message"]
						}, {
							kind: "surface",
							values: ["current"]
						}],
						limit: requestedLimit,
						...requestedCursor === void 0 ? {} : { cursor: requestedCursor }
					}, { signal });
				} catch (error) {
					if (requestedCursor === void 0 && error instanceof SessionQueryError && error.code === "SESSION_QUERY_INVALID_LIMIT" && requestedLimit > 1) {
						pageLimit = Math.max(1, Math.floor(requestedLimit / 2));
						continue;
					}
					if (requestedCursor !== void 0 && error instanceof SessionQueryError && error.code === "SESSION_QUERY_STALE_CURSOR") {
						accepted.length = 0;
						acceptedIds.clear();
						seenCursors.clear();
						cursor = void 0;
						continue;
					}
					throw error;
				}
				signal.throwIfAborted();
				if (page.items.length > requestedLimit) throw new Error(`session search provider returned ${page.items.length} items; maximum is ${requestedLimit}`);
				for (const hit of page.items) {
					if (accepted.length > SESSION_SEARCH_RESULT_LIMIT) continue;
					if (!visibleIds.has(hit.header.id) || hit.bestMatch.sessionId !== hit.header.id || hit.bestMatch.surface !== "current" || !MESSAGE_TYPES.has(hit.bestMatch.type) || acceptedIds.has(hit.header.id)) continue;
					acceptedIds.add(hit.header.id);
					accepted.push({
						sessionId: hit.header.id,
						snippet: truncateUnicodeCodePoints(hit.bestMatch.snippet, SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS)
					});
				}
				if (page.nextCursor !== void 0) {
					if (seenCursors.has(page.nextCursor)) throw new Error("session search provider repeated a cursor");
					seenCursors.add(page.nextCursor);
				}
				if (accepted.length > SESSION_SEARCH_RESULT_LIMIT || page.nextCursor === void 0) break;
				cursor = page.nextCursor;
			}
			return success({
				items: accepted.slice(0, SESSION_SEARCH_RESULT_LIMIT),
				hasMore: accepted.length > SESSION_SEARCH_RESULT_LIMIT
			});
		} catch (error) {
			if (aborted(signal) || error instanceof SessionQueryError && error.code === "SESSION_QUERY_ABORTED") return cancelled("session search was aborted");
			return failure("internal", `session search failed: ${String(error)}`);
		}
	}
	/** Resolve or create one explicit identity once, preserving cwd and preset ownership. */
	async ensureSession(sessionId, cwd, checkPersistedIdentity, requestedPreset, signal) {
		let creation = this.creations.get(sessionId);
		if (creation === void 0) {
			creation = (async () => {
				signal.throwIfAborted();
				const revision = this.ctx.workspaceRegistry.sessionAdmissionRevision(sessionId);
				this.ctx.workspaceRegistry.assertSessionAdmission(sessionId, revision);
				const live = this.ctx.agents.get(sessionId);
				const attached = this.ctx.sessions.get(sessionId);
				if (attached !== void 0 && hasApiRemoteSubagentOwner(this.ctx, attached, live)) throw new ApiRemoteSubagentSessionOwnership(sessionId);
				if (live !== void 0) return live;
				const persistence = checkPersistedIdentity ? this.ctx.get("sessionPersistence") : void 0;
				const stored = persistence === void 0 ? void 0 : (await persistence.list(signal)).find((header) => header.id === sessionId);
				signal.throwIfAborted();
				if (persistence !== void 0 && stored !== void 0) {
					const inspected = await persistence.inspect(sessionId, signal);
					if (hasApiRemoteSubagentOwner(this.ctx, { header: inspected.meta }, void 0)) throw new ApiRemoteSubagentSessionOwnership(sessionId);
					if (inspected.meta.cwd !== cwd) throw new SessionCwdConflict(sessionId, cwd, inspected.meta.cwd);
					const storedPreset = resolveSessionPreset({
						header: inspected.meta,
						events: inspected.events
					});
					this.assertPresetUnchanged(sessionId, requestedPreset, storedPreset);
					const composition = await this.composeAgent(storedPreset);
					const handle = await this.ctx.agents.resume({
						resumeSessionId: sessionId,
						agentOptions: this.agentOptions(),
						signal,
						setup: this.withSessionAdmission(composition.setup, [{
							sessionId,
							revision
						}])
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
						...composition.agentPreset === void 0 ? {} : { agentPreset: composition.agentPreset }
					},
					setup: this.withSessionAdmission(composition.setup, [{
						sessionId,
						revision
					}])
				});
				return this.ownHandle(handle);
			})().catch((error) => {
				const raced = this.ctx.agents.get(sessionId);
				if (raced !== void 0) {
					if (hasApiRemoteSubagentOwner(this.ctx, raced.session, raced)) throw new ApiRemoteSubagentSessionOwnership(sessionId);
					return raced;
				}
				const attached = this.ctx.sessions.get(sessionId);
				if (attached !== void 0 && hasApiRemoteSubagentOwner(this.ctx, attached, void 0)) throw new ApiRemoteSubagentSessionOwnership(sessionId);
				throw error;
			}).finally(() => {
				this.creations.delete(sessionId);
			});
			this.creations.set(sessionId, creation);
		}
		const agent = await creation;
		if (hasApiRemoteSubagentOwner(this.ctx, agent.session, agent)) throw new ApiRemoteSubagentSessionOwnership(sessionId);
		this.assertPresetUnchanged(sessionId, requestedPreset, resolveSessionPreset(agent.session));
		if (agent.session.header.cwd !== cwd) throw new SessionCwdConflict(sessionId, cwd, agent.session.header.cwd);
		return agent;
	}
	/** Create or adopt one ordinary Agent-backed Session. */
	async create(request, signal) {
		if (aborted(signal)) return cancelled();
		if (request.workspaceId !== void 0 && request.cwd !== void 0) return failure("invalid-argument", "session.create accepts workspaceId or cwd, not both");
		const sessionId = request.sessionId ?? SessionId(`session-${randomUUID()}`);
		let workspace;
		if (request.workspaceId !== void 0) {
			workspace = this.ctx.workspaceRegistry.get(WorkspaceId(request.workspaceId));
			if (workspace === void 0) return failure("workspace-not-found", `workspace "${request.workspaceId}" not found`, { workspaceId: request.workspaceId });
		}
		const cwd = workspace?.path ?? request.cwd ?? this.defaultCwd;
		if (!isAbsolute(cwd)) return failure("invalid-argument", "session cwd must be absolute", { cwd });
		try {
			const agent = await this.ensureSession(sessionId, cwd, request.sessionId !== void 0, request.agentPreset, signal);
			if (aborted(signal)) return cancelled();
			if (workspace !== void 0 && !workspace.sessionIds.includes(sessionId)) try {
				await workspace.attachSession(sessionId);
			} catch (error) {
				return failure("workspace-attach-failed", `session "${sessionId}" was created but could not attach to workspace "${workspace.id}": ${String(error)}`, {
					sessionId,
					workspaceId: workspace.id
				});
			}
			const agentPreset = resolveSessionPreset(agent.session);
			return success({
				sessionId,
				...agentPreset === void 0 ? {} : { agentPreset }
			});
		} catch (error) {
			if (aborted(signal)) return cancelled();
			if (error instanceof SessionPresetConflict) return failure("agent-preset-conflict", error.message, {
				sessionId: error.sessionId,
				requestedPreset: error.requestedPreset,
				...error.existingPreset === void 0 ? {} : { existingPreset: error.existingPreset }
			});
			if (error instanceof UnknownPresetError) return failure("agent-preset-not-found", error.message, {
				agentPreset: error.presetId,
				available: [...error.available]
			});
			if (error instanceof PresetMountError) return failure("agent-preset-invalid", error.message, {
				agentPreset: error.presetId,
				reason: error.reason
			});
			if (error instanceof SessionCwdConflict) return failure("session-conflict", error.message, {
				sessionId: error.sessionId,
				requestedCwd: error.requestedCwd,
				...error.existingCwd === void 0 ? {} : { existingCwd: error.existingCwd }
			});
			if (error instanceof ApiRemoteSubagentSessionOwnership) return this.subagentFailure(error.sessionId);
			return failure("internal", `failed to create session "${sessionId}": ${String(error)}`);
		}
	}
	/** Resolve one history source without acquiring an Agent owner. */
	async historySource(sessionId, signal) {
		const attached = this.ctx.sessions.get(sessionId);
		if (attached !== void 0) return {
			kind: "attached",
			session: attached
		};
		const state = await this.readSessionState(sessionId, signal);
		return {
			kind: "detached",
			header: state.header,
			events: state.events
		};
	}
	async history(request, signal) {
		const readSignal = AbortSignal.any([signal, this.lifetime.signal]);
		if (aborted(readSignal)) return cancelled();
		if (request.view === "semantic" || request.view === "content") try {
			return success(await this.semanticHistory.read(request, readSignal));
		} catch (error) {
			if (aborted(readSignal) || this.lifetime.signal.aborted) return cancelled();
			if (error instanceof SemanticHistoryError) return failure(error.code, error.message);
			return failure("internal", `semantic history unavailable: ${String(error)}`);
		}
		if (request.beforeSeq !== void 0 && (!Number.isSafeInteger(request.beforeSeq) || request.beforeSeq < 0)) return failure("invalid-argument", "beforeSeq must be a non-negative safe integer");
		if (request.maxEvents !== void 0 && (!Number.isSafeInteger(request.maxEvents) || request.maxEvents < 1 || request.maxEvents > MAX_HISTORY_PAGE_EVENTS)) return failure("invalid-argument", `maxEvents must be an integer from 1 through ${String(MAX_HISTORY_PAGE_EVENTS)}`);
		if (request.maxMessages !== void 0 && (!Number.isSafeInteger(request.maxMessages) || request.maxMessages < 1 || request.maxMessages > MAX_HISTORY_MESSAGES)) return failure("invalid-argument", `maxMessages must be an integer from 1 through ${String(MAX_HISTORY_MESSAGES)}`);
		try {
			const env_2 = {
				stack: [],
				error: void 0,
				hasError: false
			};
			try {
				const fixed = __addDisposableResource(env_2, request.view === "raw" || request.sourceRevision !== void 0 || request.expectedSubagentMode !== void 0 ? await this.semanticHistory.observe(request, readSignal) : void 0, false);
				const source = fixed === void 0 ? await this.historySource(request.sessionId, readSignal) : {
					kind: "detached",
					header: fixed.observed.header,
					events: fixed.observed.events
				};
				const bearing = source.kind === "attached" ? {
					header: source.session.header,
					events: source.session.events
				} : {
					header: source.header,
					events: source.events
				};
				if (request.expectedParentSessionId !== void 0 && bearing.header.parentSession !== request.expectedParentSessionId) return failure("subagent-unauthorized", "subagent parent changed during history read", { sessionId: request.sessionId });
				if (bearing.header.origin === "subagent" && fixed === void 0) return failure("subagent-unauthorized", "child history requires its direct parent and mode");
				let scope = fixed === void 0 ? await this.presenterScope(request.sessionId, bearing) : void 0;
				readSignal.throwIfAborted();
				fixed?.assertCurrent();
				const events = fixed?.observed.events ?? (source.kind === "attached" ? source.session.events : source.events);
				const projections = fixed === void 0 && request.beforeSeq === void 0 ? this.projectionsFor(source) : void 0;
				const binding = fixed === void 0 ? {} : {
					view: "raw",
					sourceRevision: fixed.revision,
					asOfThroughSeq: fixed.through
				};
				const sourcePage = historyEventWindow(events, fixed === void 0 ? request.beforeSeq : Math.min(request.beforeSeq ?? fixed.through + 1, fixed.through + 1), request.maxMessages ?? DEFAULT_MAX_MESSAGES, request.maxEvents ?? MAX_HISTORY_PAGE_EVENTS);
				if (fixed !== void 0 && sourcePage.events.some((event) => event.type === "tool/call" || event.type === "tool/result")) {
					scope = await this.standingPresenterScope(this.semanticHistory.presentationSource(fixed.observed, fixed.identity, fixed.through, readSignal));
					readSignal.throwIfAborted();
					this.lifetime.signal.throwIfAborted();
					fixed.assertCurrent();
				}
				const fixedValue = {
					...binding,
					events: [],
					hasMore: true,
					...projections === void 0 ? {} : { projections }
				};
				const fixedEncodedBytes = Buffer.byteLength(JSON.stringify(fixedValue), "utf8");
				if (fixedEncodedBytes > MAX_HISTORY_PAGE_ENCODED_BYTES) throw new Error("history projection baseline exceeded the encoded page budget");
				const page = historyEntryWindow(sourcePage, (event, pageEvents) => {
					const view = eventView(this.ctx, event, pageEvents, scope);
					return {
						event: remoteEvent(event),
						...view === void 0 ? {} : { view }
					};
				}, MAX_HISTORY_PAGE_ENCODED_BYTES - fixedEncodedBytes + 2);
				const value = {
					...binding,
					events: page.entries,
					hasMore: page.hasMore,
					...projections === void 0 ? {} : { projections }
				};
				if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_HISTORY_PAGE_ENCODED_BYTES && page.entries.length !== 1) throw new Error("history page exceeded the encoded byte budget");
				fixed?.assertCurrent();
				return success(value);
			} catch (e_2) {
				env_2.error = e_2;
				env_2.hasError = true;
			} finally {
				__disposeResources(env_2);
			}
		} catch (error) {
			if (aborted(readSignal)) return cancelled();
			if (error instanceof SemanticHistoryError) return failure(error.code, error.message);
			if (error instanceof ApiRemoteSessionNotFound) return failure("session-not-found", error.message, { sessionId: request.sessionId });
			return failure("internal", `history unavailable for session "${request.sessionId}": ${String(error)}`);
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
						...model.description === void 0 ? {} : { description: model.description },
						...resolved.reasoning === void 0 ? {} : { reasoning: {
							efforts: resolved.reasoning.efforts.map((effort) => ({
								id: effort.id,
								name: effort.name,
								...effort.description === void 0 ? {} : { description: effort.description }
							})),
							...resolved.reasoning.defaultEffort === void 0 ? {} : { defaultEffort: resolved.reasoning.defaultEffort }
						} }
					};
				}));
				return {
					kind: "group",
					value: {
						id: provider.id,
						name: provider.name,
						models: entries
					}
				};
			} catch (error) {
				if (signal.aborted) throw error;
				return {
					kind: "failure",
					value: {
						id: provider.id,
						name: provider.name,
						message: error instanceof Error ? error.message : String(error)
					}
				};
			}
		}));
		return {
			groups: catalog.flatMap((item) => item.kind === "group" && item.value.models.length > 0 ? [item.value] : []),
			failures: catalog.flatMap((item) => item.kind === "failure" ? [item.value] : [])
		};
	}
	/** Report the current session route and advisory model catalog. */
	async models(request, signal) {
		if (aborted(signal)) return cancelled();
		const found = await this.agentFor(request.sessionId);
		if (!found.ok) return found;
		try {
			signal.throwIfAborted();
			const current = this.selectionFor(found.value).current;
			const catalog = await this.modelCatalog(signal);
			const routable = this.ctx.llm.listProviders().some((provider) => provider.id === current.provider);
			return success({
				current: { ...current },
				routable,
				groups: catalog.groups,
				failures: catalog.failures
			});
		} catch (error) {
			if (aborted(signal)) return cancelled();
			return failure("internal", `model catalog unavailable: ${String(error)}`);
		}
	}
	/** Validate and apply one session-local provider/model/reasoning selection. */
	async selectModel(request, signal) {
		if (aborted(signal)) return cancelled();
		const found = await this.agentFor(request.sessionId);
		if (!found.ok) return found;
		return this.serializeAdmission(found.value, async () => {
			try {
				const resolved = await this.ctx.llm.resolveCallConfig({
					provider: request.provider,
					model: request.model,
					...request.reasoningEffort === void 0 ? {} : { reasoningEffort: ReasoningEffortId(request.reasoningEffort) }
				}, signal);
				signal.throwIfAborted();
				const selected = {
					provider: resolved.provider,
					model: resolved.model,
					...resolved.reasoningEffort === void 0 ? {} : { reasoningEffort: resolved.reasoningEffort }
				};
				found.value.session.append("model/selection", selected);
				this.selectionFor(found.value);
				try {
					await this.ctx.agentDefaultModel.saveSelection(selected);
				} catch (error) {
					this.ctx.logger.warn(`session model selection was not saved as default: ${String(error)}`);
				}
				return success({ selected: { ...selected } });
			} catch (error) {
				if (aborted(signal)) return cancelled();
				return failure("model-unavailable", error instanceof Error ? error.message : String(error), {
					provider: request.provider,
					model: request.model
				});
			}
		});
	}
	/** Append a user-owned durable title through SessionTitleService. */
	async rename(request, signal) {
		if (aborted(signal)) return cancelled();
		const found = await this.agentFor(request.sessionId);
		if (!found.ok) return found;
		const titles = this.ctx.get("sessionTitle");
		if (titles === void 0) return failure("internal", "renaming is unavailable: this deployment mounts no session-title service");
		try {
			signal.throwIfAborted();
			const accepted = titles.rename(found.value.session, request.title);
			return success({
				title: accepted.title,
				seq: accepted.eventSeq
			});
		} catch (error) {
			if (aborted(signal)) return cancelled();
			if (error instanceof SessionTitleInvalidError) return failure("title-invalid", error.message, { sessionId: request.sessionId });
			return failure("internal", `failed to rename session "${request.sessionId}": ${String(error)}`);
		}
	}
	/** Resolve the Workspace inherited by an ordinary fork. */
	async forkWorkspace(source, signal) {
		const workspaces = this.ctx.workspaceRegistry.list();
		const direct = workspaces.find((workspace) => workspace.sessionIds.includes(source.id));
		if (direct !== void 0 || source.header.origin !== "subagent") return direct;
		const query = this.ctx.get("sessionQuery");
		if (query === void 0) throw new Error("cannot resolve a subagent fork workspace without session-query");
		const lineage = await query.traceSession(source.id, signal);
		for (const ancestor of lineage.ancestors) {
			const workspace = workspaces.find((candidate) => candidate.sessionIds.includes(ancestor.header.id));
			if (workspace !== void 0) return workspace;
		}
	}
	/** Fork one completed-turn prefix under a new exact Agent lifecycle handle. */
	async fork(request, signal) {
		signal = AbortSignal.any([signal, this.lifetime.signal]);
		if (aborted(signal)) return cancelled();
		if (request.atSeq !== void 0 && (!Number.isSafeInteger(request.atSeq) || request.atSeq < 0)) return failure("invalid-argument", "atSeq must be a non-negative safe integer");
		const parentRevision = this.ctx.workspaceRegistry.sessionAdmissionRevision(request.sessionId);
		try {
			this.ctx.workspaceRegistry.assertSessionAdmission(request.sessionId, parentRevision);
		} catch (error) {
			return failure("fork-unavailable", error instanceof Error ? error.message : String(error), { sessionId: request.sessionId });
		}
		let fixed;
		let checkedSource;
		try {
			let source;
			try {
				if (request.sourceRevision !== void 0) {
					const observation = await this.semanticHistory.observe(request, signal);
					fixed = observation;
					source = {
						id: request.sessionId,
						header: observation.observed.header,
						events: observation.observed.events
					};
					if (request.atSeq !== void 0 && request.atSeq > observation.through) return failure("invalid-argument", "fork anchor is outside the bound history cut");
				} else source = await this.readSessionState(request.sessionId, signal);
			} catch (error) {
				if (aborted(signal)) return cancelled();
				if (error instanceof SemanticHistoryError) return failure(error.code, error.message);
				if (error instanceof ApiRemoteSessionNotFound) return failure("session-not-found", error.message, { sessionId: request.sessionId });
				return failure("internal", `fork source unavailable for session "${request.sessionId}": ${String(error)}`);
			}
			const lastSeq = fixed?.through ?? source.events.at(-1)?.seq ?? -1;
			const boundary = (request.atSeq === void 0 ? void 0 : source.events.find((event) => event.type === "turn/end" && event.seq >= request.atSeq && event.seq <= lastSeq)) ?? (request.atSeq === void 0 || request.atSeq > lastSeq ? source.events.findLast((event) => event.type === "turn/end" && event.seq <= lastSeq) : void 0);
			if (boundary === void 0) return failure("fork-unavailable", request.atSeq !== void 0 && request.atSeq <= lastSeq ? `session "${request.sessionId}" has not completed the turn containing event ${request.atSeq}` : `session "${request.sessionId}" has no completed turn to fork from`, { sessionId: request.sessionId });
			let cut = boundary.seq + 1;
			while (cut <= lastSeq && source.events[cut]?.type !== "turn/start") cut += 1;
			let workspace;
			try {
				workspace = await this.forkWorkspace(source, signal);
			} catch (error) {
				if (aborted(signal)) return cancelled();
				return failure("internal", `failed to resolve fork workspace for session "${request.sessionId}": ${String(error)}`);
			}
			const childId = SessionId(`session-${randomUUID()}`);
			const childRevision = this.ctx.workspaceRegistry.sessionAdmissionRevision(childId);
			const seed = source.events.slice(0, cut);
			let handle;
			try {
				fixed?.assertCurrent();
				const composition = await this.composeAgent(resolveSessionPreset({
					header: source.header,
					events: fixed === void 0 ? source.events : seed
				}));
				const admission = this.withSessionAdmission(composition.setup, [{
					sessionId: request.sessionId,
					revision: parentRevision
				}, {
					sessionId: childId,
					revision: childRevision
				}]);
				const bound = fixed;
				const setup = bound === void 0 ? admission : async (agentCtx) => {
					const prepared = await admission(agentCtx);
					bound.assertCurrent();
					const checked = await this.semanticHistory.observe({
						...request,
						sourceRevision: bound.revision
					}, signal);
					checkedSource = checked;
					const assertSource = () => {
						signal.throwIfAborted();
						bound.assertCurrent();
						checked.assertCurrent();
						if (bound.observed.source === "prepared" && this.ctx.sessions.get(request.sessionId) !== void 0) throw new SemanticHistoryError("history-stale-source", "fork source became live before publication");
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
						...source.header.cwd === void 0 ? {} : { cwd: source.header.cwd },
						parentSession: source.id,
						seedLength: cut,
						...composition.agentPreset === void 0 ? {} : { agentPreset: composition.agentPreset }
					},
					agentOptions: this.agentOptions(),
					signal,
					setup
				});
				signal.throwIfAborted();
				await this.ctx.sessions.flush(handle.agent.session);
				signal.throwIfAborted();
				this.ownHandle(handle);
			} catch (error) {
				if (handle !== void 0) try {
					await handle.dispose();
				} catch (disposeError) {
					this.ctx.logger.warn(`failed to dispose undurable fork "${childId}": ${String(disposeError)}`);
				}
				if (aborted(signal)) return cancelled();
				if (error instanceof SemanticHistoryError) return failure(error.code, error.message);
				return failure("internal", `failed to fork session "${request.sessionId}": ${String(error)}`);
			}
			if (workspace !== void 0) try {
				await workspace.attachSession(childId);
			} catch (error) {
				return failure("workspace-attach-failed", `session "${childId}" was forked but could not attach to workspace "${workspace.id}": ${String(error)}`, {
					sessionId: childId,
					workspaceId: workspace.id
				});
			}
			return success({ sessionId: childId });
		} finally {
			for (const observation of [checkedSource, fixed]) try {
				observation?.[Symbol.dispose]();
			} catch {
				this.ctx.logger.warn("failed to release a fork source observation");
			}
		}
	}
	/** Promote base64 image parts to durable references in caller order. */
	async durablePromptContent(content) {
		if (content.every((part) => part.type === "text")) return content.map((part) => ({
			type: "text",
			text: part.text
		}));
		const refs = await admitEncodedImages(this.ctx.attachments, content.filter((part) => part.type === "image"));
		let next = 0;
		return content.map((part) => part.type === "text" ? {
			type: "text",
			text: part.text
		} : {
			type: "image",
			attachment: refs[next++]
		});
	}
	/** Revalidate one resolved prompt target at its synchronous delivery commit. */
	assertPromptAdmission(sessionId, agent) {
		const revision = this.ctx.workspaceRegistry.sessionAdmissionRevision(sessionId);
		this.ctx.workspaceRegistry.assertSessionAdmission(sessionId, revision);
		if (this.ctx.agents.get(sessionId) !== agent || this.ctx.sessions.get(sessionId) !== agent.session) throw new Error(`session "${sessionId}" lifecycle changed before prompt delivery`);
	}
	/** Admit an unmatched slash line only when the live Agent can resolve its exact user-invocable skill. */
	async admitUnknownCommandAsSkill(commandLine, agent, signal) {
		const name = commandLine.slice(1).trim().split(/\s/u, 1)[0] ?? "";
		if (!isSkillName(name)) return void 0;
		const registry = agent.ctx.get("skills") ?? this.ctx.get("skills");
		if (registry === void 0) return void 0;
		return (await registry.list({
			cwd: agent.session.header.cwd,
			scope: agent,
			signal
		})).some((skill) => skill.name === name && isUserInvocable(skill)) ? commandLine : void 0;
	}
	/** Read the existing projection without retaining a second transcript or receipt cache. */
	promptReceipt(session, invocationId) {
		const state = this.ctx.get("sessionProjections")?.stateOf(session, "promptReceipts");
		if (state === void 0) throw new Error("ordinary prompt receipt projection is unavailable");
		return Object.hasOwn(state.entries, invocationId) ? state.entries[invocationId] : void 0;
	}
	receiptConflict(receipt, digest) {
		return receipt.conflict || receipt.digest === null || receipt.digest !== digest ? failure("invocation-conflict", "invocationId was already accepted with different or unverifiable input") : void 0;
	}
	/** Once accepted, caller cancellation cannot undo delivery or bypass durability confirmation. */
	async confirmPrompt(session, invocationId) {
		try {
			const persistence = this.ctx.get("sessionPersistence");
			if (persistence === void 0 || !await this.ctx.sessions.flush(session)) throw new Error("ordinary prompt has no durability owner");
			await persistence.ensureMaterialized(session);
			return success({ accepted: true });
		} catch (error) {
			return failure("prompt-durability-unconfirmed", "prompt was accepted but its durable acknowledgement is not confirmed", {
				accepted: true,
				invocationId,
				reason: String(error)
			});
		}
	}
	/** Confirm a retry before provider lookup or Agent activation, including a cold completed Session. */
	async acceptedPrompt(request, digest, signal) {
		const env_3 = {
			stack: [],
			error: void 0,
			hasError: false
		};
		try {
			const revision = this.ctx.workspaceRegistry.sessionAdmissionRevision(request.sessionId);
			try {
				this.ctx.workspaceRegistry.assertSessionAdmission(request.sessionId, revision);
			} catch (error) {
				return failure("agent-busy", "session lifecycle changed before prompt admission", { reason: String(error) });
			}
			const live = this.ctx.sessions.get(request.sessionId);
			if (live !== void 0) {
				if (hasApiRemoteSubagentOwner(this.ctx, live, this.ctx.agents.get(request.sessionId))) return this.subagentFailure(request.sessionId);
				const receipt = this.promptReceipt(live, request.invocationId);
				if (receipt === void 0) return void 0;
				return this.receiptConflict(receipt, digest) ?? this.confirmPrompt(live, request.invocationId);
			}
			const persistence = this.ctx.get("sessionPersistence");
			if (persistence === void 0) return void 0;
			const borrowed = __addDisposableResource(env_3, await persistence.borrowSession(request.sessionId, signal), false);
			signal.throwIfAborted();
			this.ctx.workspaceRegistry.assertSessionAdmission(request.sessionId, revision);
			if (this.ctx.sessions.get(request.sessionId) !== void 0) return await this.acceptedPrompt(request, digest, signal);
			if (borrowed.source === "live") return failure("agent-busy", "session lifecycle changed while verifying prompt admission");
			const session = borrowed.preparedSession;
			if (hasApiRemoteSubagentOwner(this.ctx, session, void 0)) return this.subagentFailure(request.sessionId);
			this.ctx.get("sessionProjectionCache")?.hydratePrepared(session, borrowed.inspection.meta, borrowed.inspection.events);
			const receipt = this.promptReceipt(session, request.invocationId);
			if (receipt === void 0) return void 0;
			return this.receiptConflict(receipt, digest) ?? success({ accepted: true });
		} catch (e_3) {
			env_3.error = e_3;
			env_3.hasError = true;
		} finally {
			__disposeResources(env_3);
		}
	}
	/** Admit ordinary queued or steering input to the exact live Agent. */
	async prompt(request, signal) {
		if (aborted(signal)) return cancelled();
		if (request.invocationId.length === 0) return failure("invalid-invocation-id", "invocationId must be a non-empty opaque prompt identity");
		const canonicalTimeZone = request.clientTimeZone === void 0 ? void 0 : canonicalClientTimeZone(request.clientTimeZone);
		if (request.clientTimeZone !== void 0 && canonicalTimeZone === void 0) return failure("invalid-time-zone", "clientTimeZone must be UTC or a valid IANA Area/Location name", { value: request.clientTimeZone });
		const digest = promptDigest(request, canonicalTimeZone);
		try {
			const accepted = await this.acceptedPrompt(request, digest, signal);
			if (accepted !== void 0) return accepted;
		} catch (error) {
			if (aborted(signal)) return cancelled();
			return failure("prompt-unavailable", "cannot verify ordinary prompt admission", { reason: String(error) });
		}
		const found = await this.agentFor(request.sessionId);
		if (!found.ok) return found;
		const agent = found.value;
		const commandLine = request.content.length === 1 && request.content[0]?.type === "text" && request.content[0].text.startsWith("/") ? request.content[0].text : void 0;
		if (commandLine !== void 0) {
			const commands = this.ctx.get("commands");
			if (commands === void 0) return failure("unknown-command", "this deployment mounts no command registry");
			try {
				const execution = await commands.execute(agent, commandLine, [], signal);
				if (execution === void 0) {
					const skillPrompt = await this.admitUnknownCommandAsSkill(commandLine, agent, signal);
					if (skillPrompt === void 0) return failure("unknown-command", `unknown command: ${commandLine.split(/\s/u, 1)[0] ?? commandLine}`);
					request = {
						...request,
						content: [{
							type: "text",
							text: skillPrompt
						}]
					};
				} else {
					if (execution.result.kind === "error") return failure("command-error", execution.result.text);
					return success({
						accepted: true,
						command: {
							kind: "success",
							...execution.result.text === void 0 ? {} : { text: execution.result.text }
						}
					});
				}
			} catch (error) {
				if (aborted(signal)) return cancelled();
				return failure("command-error", error instanceof Error ? error.message : String(error));
			}
		}
		const selection = this.selectionFor(agent).current;
		if (!this.ctx.llm.listProviders().some((provider) => provider.id === selection.provider)) return failure("model-unavailable", `no adapter serves provider "${selection.provider}"; select a model for this session`, {
			provider: selection.provider,
			model: selection.model
		});
		if (!request.content.some((part) => part.type !== "text" || part.text.trim().length > 0)) return failure("bad-request", "prompt content must include non-whitespace text or an attachment", {});
		const admit = async () => {
			try {
				signal.throwIfAborted();
				const receipt = this.promptReceipt(agent.session, request.invocationId);
				if (receipt !== void 0) return this.receiptConflict(receipt, digest) ?? await this.confirmPrompt(agent.session, request.invocationId);
				if (this.ctx.get("sessionPersistence") === void 0) return failure("prompt-unavailable", "ordinary prompts require a persistence owner");
				const content = await this.durablePromptContent(request.content);
				signal.throwIfAborted();
				const message = createUserMessage({
					content,
					source: {
						kind: "user",
						invocationId: request.invocationId,
						promptDigest: digest,
						...canonicalTimeZone === void 0 ? {} : { clientTimeZone: canonicalTimeZone }
					}
				});
				this.assertPromptAdmission(request.sessionId, agent);
				try {
					if (request.mode === "steer") agent.steer(message);
					else agent.followup(message);
				} catch (error) {
					if (this.promptReceipt(agent.session, request.invocationId) === void 0) throw error;
				}
				if (this.promptReceipt(agent.session, request.invocationId) === void 0) throw new Error("inbox did not record prompt acceptance");
				return await this.confirmPrompt(agent.session, request.invocationId);
			} catch (error) {
				if (aborted(signal)) return cancelled();
				if (error instanceof AttachmentError) return failure("attachment-error", error.message, { reason: error.code });
				return failure("agent-busy", "prompt rejected", { reason: String(error) });
			}
		};
		return this.serializeAdmission(agent, admit);
	}
	/** Return bytes only for an image referenced by the addressed Session log. */
	async attachment(request, signal) {
		if (aborted(signal)) return cancelled();
		try {
			const ref = referencedImage((await this.readSessionState(request.sessionId, signal)).events, request.attachmentId);
			if (ref === void 0) return failure("attachment-error", "Image is not referenced by this session.", { reason: "ATTACHMENT_NOT_REFERENCED" });
			const stored = await this.ctx.attachments.readImage(ref, signal);
			return success({
				attachment: stored.ref,
				data: Buffer.from(stored.data).toString("base64")
			});
		} catch (error) {
			if (aborted(signal)) return cancelled();
			if (error instanceof ApiRemoteSessionNotFound) return failure("session-not-found", error.message, { sessionId: request.sessionId });
			if (error instanceof AttachmentError) return failure("attachment-error", error.message, { reason: error.code });
			return failure("internal", `attachment authorization unavailable for session "${request.sessionId}": ${String(error)}`);
		}
	}
	/** Validate one queue edit as text-only ContentBlock data. */
	queueEditContent(content) {
		const blocks = [];
		for (const value of content) {
			if (value === null || Array.isArray(value) || typeof value !== "object") return void 0;
			const block = value;
			if (block.type !== "text" || typeof block.text !== "string") return void 0;
			blocks.push({
				type: "text",
				text: block.text
			});
		}
		return blocks;
	}
	/** Edit, remove, or immediately steer one exact pending inbox message. */
	updateQueue(request, signal) {
		if (aborted(signal)) return settled(cancelled());
		const edited = request.action.kind === "edit" ? this.queueEditContent(request.action.content) : void 0;
		if (request.action.kind === "edit" && edited === void 0) return settled(failure("attachment-error", "queue edits accept text content only", { reason: "QUEUE_EDIT_NON_TEXT" }));
		if (edited !== void 0 && !edited.some((block) => block.type === "text" && block.text.trim().length > 0)) return settled(failure("invalid-argument", "queue edit content must not be empty"));
		const agent = this.ctx.agents.get(request.sessionId);
		if (agent === void 0) return settled(failure("queue-item-not-found", "queued item is no longer pending", { itemId: request.itemId }));
		const messageId = MessageId(request.itemId);
		const target = agent.inbox.nextTurn.some((message) => message.id === messageId) ? "next-turn" : agent.inbox.nextStep.some((message) => message.id === messageId) ? "next-step" : void 0;
		const message = target === void 0 ? void 0 : (target === "next-turn" ? agent.inbox.nextTurn : agent.inbox.nextStep).find((candidate) => candidate.id === messageId);
		if (target === void 0 || message === void 0) return settled(failure("queue-item-not-found", "queued item is no longer pending", { itemId: request.itemId }));
		if (request.action.kind === "steer" && (target !== "next-turn" || agent.status !== "running")) return settled(failure("steer-unavailable", "current turn no longer accepts steering", { itemId: request.itemId }));
		if (request.action.kind === "edit") agent.inbox.replace(messageId, freezeMessage({
			...message,
			content: edited
		}));
		else {
			agent.inbox.remove(messageId);
			if (request.action.kind === "steer") agent.steer(message);
		}
		return settled(success({ accepted: true }));
	}
	/** Cancel the active ordinary turn while preserving queued input. */
	cancel(request, signal) {
		if (aborted(signal)) return settled(cancelled());
		const agent = this.ctx.agents.get(request.sessionId);
		if (agent === void 0) return settled(failure("session-not-found", `session "${request.sessionId}" not found (not attached)`, { sessionId: request.sessionId }));
		if (hasApiRemoteSubagentOwner(this.ctx, agent.session, agent)) return settled(this.subagentFailure(request.sessionId));
		agent.cancel({ kind: "user" }, { keepInbox: true });
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
		if (agent === void 0) return;
		const handle = this.handles.get(sessionId);
		if (handle === void 0 || handle.agent !== agent || !this.ctx.agents.roots().includes(agent)) throw new WorkspaceSessionDeletionBlockedError(sessionId, "resident");
		let disposal;
		try {
			await agent.runMaintenance((maintenanceSignal) => {
				signal.throwIfAborted();
				maintenanceSignal.throwIfAborted();
				if (this.handles.get(sessionId) !== handle || handle.agent !== agent || this.ctx.agents.get(sessionId) !== agent || this.ctx.sessions.get(sessionId) !== agent.session || !this.ctx.agents.roots().includes(agent) || !this.ctx.workspaceRegistry.archivedSessionIds.includes(sessionId) || agent.status !== "idle" || agent.inbox.hasPending || hasOpenTurn(agent.session) || (this.ctx.get("jobs")?.list(agent).some((job) => job.ownerSession === sessionId) ?? false)) throw new WorkspaceSessionDeletionBlockedError(sessionId, "resident");
				signal.throwIfAborted();
				disposal = handle.dispose();
				return Promise.resolve();
			});
		} finally {
			if (disposal !== void 0) await disposal;
		}
	}
};
//#endregion
export { DEFAULT_SESSION_LOG_COMPRESSION_LEVEL, SESSION_EXPORT_PATH, SessionRemoteOperationsService, SessionRemoteOperationsService as default, fetchSessionLogExport, flushLiveSessionLog, sessionLogCompressionLevel, sessionLogZipEntries, sessionLogZipFilename, streamSessionLogZip };
