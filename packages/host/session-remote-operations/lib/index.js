import { readFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { Service } from "@deepseek-ai/cordis";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { PresetMountError, UnknownPresetError, resolveSessionPreset } from "@deepseek-ai/dsh-agent-presets";
import { ApiRemoteSessionNotFound, ApiRemoteSubagentSessionOwnership, apiRemoteSubagentOwnershipError, hasApiRemoteSubagentOwner } from "@deepseek-ai/dsh-api-remotes/agent-lookup";
import { AttachmentError, admitEncodedImages } from "@deepseek-ai/dsh-attachment";
import { createUserMessage, freezeMessage } from "@deepseek-ai/dsh-llm";
import { MessageId, ReasoningEffortId } from "@deepseek-ai/dsh-llm/brand";
import { SessionId, findToolCallArguments, isAppendSurfaceEvent, snapshotJsonValue } from "@deepseek-ai/dsh-session";
import { SessionQueryError } from "@deepseek-ai/dsh-session-query";
import { SessionTitleInvalidError } from "@deepseek-ai/dsh-session-title";
import { WorkspaceId, WorkspaceSessionDeletionBlockedError } from "@deepseek-ai/dsh-workspace";
import { z } from "zod";
import { Zip, ZipDeflate } from "fflate";
//#region src/session-export.ts
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
//#region src/index.ts
/**
* Host ownership for generated Session Remote operations and archived
* Workspace-session retirement.
*
* The package reads each domain's live owner directly. It deliberately owns
* no transcript, projection, workspace, attachment, or model-catalog cache.
* Its only mutable maps serialize identity creation/resume, retain exact
* AgentHandle capabilities, and hold the session-local model selection that
* prompt assembly consumes.
*
* @module @deepseek-ai/dsh-host-session-remote-operations
*/
const DEFAULT_MAX_MESSAGES = 50;
const MAX_HISTORY_MESSAGES = 2048;
const MAX_HISTORY_PAGE_EVENTS = 2048;
const MAX_HISTORY_PAGE_ENCODED_BYTES = 1048576;
const SESSION_SEARCH_RESULT_LIMIT = 20;
const SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS = 240;
const SESSION_SEARCH_PROVIDER_CALL_LIMIT = 100;
const MESSAGE_TYPES = new Set(["user/message", "assistant/message"]);
const IANA_TIME_ZONE = /^[A-Za-z][A-Za-z0-9_+.-]*(?:\/[A-Za-z0-9_+.-]+)+$/;
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
/** Validate and canonicalize one user-supplied IANA time zone. */
function canonicalClientTimeZone(value) {
	if (value.length === 0 || value.trim() !== value || value !== "UTC" && !IANA_TIME_ZONE.test(value)) return void 0;
	try {
		const canonical = new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone;
		return canonical === "UTC" || IANA_TIME_ZONE.test(canonical) ? canonical : void 0;
	} catch {
		return;
	}
}
/** Whether one transcript has started an Agent turn. */
function sessionBlank(events) {
	return !events.some((event) => event.type === "turn/start");
}
/** Latest human prompt time in one exact log cut. */
function lastPromptAt(events) {
	let latest = null;
	for (const event of events) if (event.type === "user/message" && event.data.source.kind === "user") latest = event.time;
	return latest;
}
/** Session-header fields shared by attached and cold listing rows. */
function summaryFields(header, events = []) {
	const preset = resolveSessionPreset({
		header,
		events
	});
	return {
		...header.parentSession === void 0 ? {} : { parentSessionId: header.parentSession },
		...header.origin === void 0 ? {} : { origin: header.origin },
		...header.cwd === void 0 ? {} : { cwd: header.cwd },
		...preset === void 0 ? {} : { agentPreset: preset }
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
function historyEventWindow(events, beforeSeq, maxMessages) {
	const end = historyEndIndex(events, beforeSeq);
	let start = end;
	let count = 0;
	let groupStart;
	while (start > 0 && end - start < MAX_HISTORY_PAGE_EVENTS) {
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
	defaultCwd;
	/** Exact loopback-only path for streaming Session archives. */
	path = SESSION_EXPORT_PATH;
	sessionExportCompressionLevel;
	handles = /* @__PURE__ */ new Map();
	creations = /* @__PURE__ */ new Map();
	resumes = /* @__PURE__ */ new Map();
	selections = /* @__PURE__ */ new WeakMap();
	imageAdmissionChains = /* @__PURE__ */ new WeakMap();
	lifetime = new AbortController();
	constructor(ctx, config = {}) {
		super(ctx, "sessionRemoteOperations");
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
			const handles = [...this.handles.values()];
			this.handles.clear();
			await Promise.allSettled(handles.map((handle) => handle.dispose({ keepInbox: true })));
		}, "host-session-remote-operations: owned Agent handles");
		ctx.inject(["sessionProjections"], (projectionCtx) => {
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
		const existing = this.selections.get(agent);
		if (existing !== void 0) return existing;
		let selected;
		const currentDefault = () => ({ ...this.ctx.agentDefaultModel.currentSelection() });
		const selection = {
			get current() {
				if (selected !== void 0) return selected;
				const logged = agent.session.requestHeader()?.config;
				if (logged !== void 0) return {
					provider: logged.provider,
					model: logged.model,
					...logged.reasoningEffort === void 0 ? {} : { reasoningEffort: logged.reasoningEffort }
				};
				return currentDefault();
			},
			set current(next) {
				selected = next;
			},
			assembled: void 0
		};
		installModelSelection(agent.ctx, selection);
		this.selections.set(agent, selection);
		return selection;
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
	/** Serialize model switching with image admission for one exact Agent. */
	serializeImageAdmission(agent, operation) {
		const result = (this.imageAdmissionChains.get(agent) ?? Promise.resolve()).then(operation);
		this.imageAdmissionChains.set(agent, result.then(() => void 0, () => void 0));
		return result;
	}
	/** One exact projection cut for an attached or detached transcript. */
	projectionsFor(source) {
		const projections = this.ctx.get("sessionProjections");
		if (projections === void 0) return void 0;
		try {
			return remoteProjections(source.kind === "attached" ? projections.snapshot(source.session) : projections.restore({}, source.events, 0).snapshot);
		} catch (error) {
			this.ctx.logger.warn(`session Remote projections unavailable: ${String(error)}`);
			return;
		}
	}
	/** Resolve the presentation scope without resuming a cold Session. */
	async presenterScope(sessionId, source) {
		const live = this.ctx.agents.get(sessionId);
		if (live !== void 0) return live;
		const presets = this.ctx.get("agentPresets");
		if (presets === void 0) return void 0;
		try {
			return await presets.standingKeyFor(resolveSessionPreset(source));
		} catch {
			return;
		}
	}
	/** Build the current visible Session listing without retaining a second index. */
	async visibleSummaries(signal) {
		signal.throwIfAborted();
		const rows = this.ctx.sessions.list().map((session) => {
			const promptAt = lastPromptAt(session.events);
			const projections = this.projectionsFor({
				kind: "attached",
				session
			});
			return {
				sessionId: session.id,
				updatedAt: Math.max(session.header.createdAt, promptAt ?? 0),
				running: this.ctx.agents.get(session.id)?.status === "running",
				blank: sessionBlank(session.events),
				...summaryFields(session.header, session.events),
				...projections === void 0 ? {} : { projections }
			};
		});
		const liveIds = new Set(rows.map((row) => row.sessionId));
		const persistence = this.ctx.get("sessionPersistence");
		if (persistence !== void 0) {
			const headers = (await persistence.list(signal)).filter((header) => !liveIds.has(header.id) && header.cwd !== void 0);
			for (const header of headers) {
				signal.throwIfAborted();
				let events;
				try {
					events = [...(await persistence.inspect(header.id, signal)).events];
				} catch (error) {
					if (signal.aborted) throw error;
					this.ctx.logger.warn(`session.list: cold inspection for "${header.id}" failed; serving it visible: ${String(error)}`);
				}
				const raced = this.ctx.sessions.get(header.id);
				if (raced !== void 0) {
					const promptAt = lastPromptAt(raced.events);
					const projections = this.projectionsFor({
						kind: "attached",
						session: raced
					});
					rows.push({
						sessionId: raced.id,
						updatedAt: Math.max(raced.header.createdAt, promptAt ?? 0),
						running: this.ctx.agents.get(raced.id)?.status === "running",
						blank: sessionBlank(raced.events),
						...summaryFields(raced.header, raced.events),
						...projections === void 0 ? {} : { projections }
					});
					continue;
				}
				const projections = events === void 0 ? remoteProjections(this.ctx.get("sessionProjectionCache")?.cachedSnapshot(header)) : this.projectionsFor({
					kind: "detached",
					header,
					events
				});
				const promptAt = events === void 0 ? null : lastPromptAt(events);
				rows.push({
					sessionId: header.id,
					updatedAt: Math.max(header.createdAt, promptAt ?? 0),
					running: false,
					blank: events === void 0 ? false : sessionBlank(events),
					...summaryFields(header, events),
					...projections === void 0 ? {} : { projections }
				});
			}
		}
		rows.sort((left, right) => right.updatedAt - left.updatedAt);
		return rows;
	}
	/** List every attached or persisted Session visible to ordinary routing. */
	async list(_request, signal) {
		if (aborted(signal)) return cancelled();
		try {
			return success({ items: await this.visibleSummaries(signal) });
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
			const visible = await this.visibleSummaries(signal);
			const visibleIds = new Set(visible.map((item) => item.sessionId));
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
	/**
	* Serve a consistent attached-or-cold transcript page and projection cut.
	* When `hasMore` is true, the first returned event sequence is the strictly
	* smaller exclusive `beforeSeq` cursor for the next request.
	*/
	async history(request, signal) {
		if (aborted(signal)) return cancelled();
		if (request.beforeSeq !== void 0 && (!Number.isSafeInteger(request.beforeSeq) || request.beforeSeq < 0)) return failure("invalid-argument", "beforeSeq must be a non-negative safe integer");
		if (request.maxMessages !== void 0 && (!Number.isSafeInteger(request.maxMessages) || request.maxMessages < 1 || request.maxMessages > MAX_HISTORY_MESSAGES)) return failure("invalid-argument", `maxMessages must be an integer from 1 through ${String(MAX_HISTORY_MESSAGES)}`);
		try {
			const source = await this.historySource(request.sessionId, signal);
			const bearing = source.kind === "attached" ? {
				header: source.session.header,
				events: source.session.events
			} : {
				header: source.header,
				events: source.events
			};
			const scope = await this.presenterScope(request.sessionId, bearing);
			signal.throwIfAborted();
			const events = source.kind === "attached" ? [...source.session.events] : source.events;
			const projections = request.beforeSeq === void 0 ? this.projectionsFor(source) : void 0;
			const sourcePage = historyEventWindow(events, request.beforeSeq, request.maxMessages ?? DEFAULT_MAX_MESSAGES);
			const fixedValue = {
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
				events: page.entries,
				hasMore: page.hasMore,
				...projections === void 0 ? {} : { projections }
			};
			if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_HISTORY_PAGE_ENCODED_BYTES && page.entries.length !== 1) throw new Error("history page exceeded the encoded byte budget");
			return success(value);
		} catch (error) {
			if (aborted(signal)) return cancelled();
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
		return this.serializeImageAdmission(found.value, async () => {
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
				this.selectionFor(found.value).current = selected;
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
		if (aborted(signal)) return cancelled();
		if (request.atSeq !== void 0 && (!Number.isSafeInteger(request.atSeq) || request.atSeq < 0)) return failure("invalid-argument", "atSeq must be a non-negative safe integer");
		const parentRevision = this.ctx.workspaceRegistry.sessionAdmissionRevision(request.sessionId);
		try {
			this.ctx.workspaceRegistry.assertSessionAdmission(request.sessionId, parentRevision);
		} catch (error) {
			return failure("fork-unavailable", error instanceof Error ? error.message : String(error), { sessionId: request.sessionId });
		}
		let source;
		try {
			source = await this.readSessionState(request.sessionId, signal);
		} catch (error) {
			if (aborted(signal)) return cancelled();
			if (error instanceof ApiRemoteSessionNotFound) return failure("session-not-found", error.message, { sessionId: request.sessionId });
			return failure("internal", `fork source unavailable for session "${request.sessionId}": ${String(error)}`);
		}
		const lastSeq = source.events.at(-1)?.seq ?? -1;
		const boundary = (request.atSeq === void 0 ? void 0 : source.events.find((event) => event.type === "turn/end" && event.seq >= request.atSeq)) ?? (request.atSeq === void 0 || request.atSeq > lastSeq ? source.events.findLast((event) => event.type === "turn/end") : void 0);
		if (boundary === void 0) return failure("fork-unavailable", request.atSeq !== void 0 && request.atSeq <= lastSeq ? `session "${request.sessionId}" has not completed the turn containing event ${request.atSeq}` : `session "${request.sessionId}" has no completed turn to fork from`, { sessionId: request.sessionId });
		let cut = boundary.seq + 1;
		while (cut < source.events.length && source.events[cut]?.type !== "turn/start") cut += 1;
		let workspace;
		try {
			workspace = await this.forkWorkspace(source, signal);
		} catch (error) {
			if (aborted(signal)) return cancelled();
			return failure("internal", `failed to resolve fork workspace for session "${request.sessionId}": ${String(error)}`);
		}
		const childId = SessionId(`session-${randomUUID()}`);
		const childRevision = this.ctx.workspaceRegistry.sessionAdmissionRevision(childId);
		const composition = await this.composeAgent(resolveSessionPreset({
			header: source.header,
			events: source.events
		}));
		let handle;
		try {
			handle = await this.ctx.agents.create({
				sessionId: childId,
				seed: source.events.slice(0, cut),
				meta: {
					...source.header.cwd === void 0 ? {} : { cwd: source.header.cwd },
					parentSession: source.id,
					seedLength: cut,
					...composition.agentPreset === void 0 ? {} : { agentPreset: composition.agentPreset }
				},
				agentOptions: this.agentOptions(),
				signal,
				setup: this.withSessionAdmission(composition.setup, [{
					sessionId: request.sessionId,
					revision: parentRevision
				}, {
					sessionId: childId,
					revision: childRevision
				}])
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
	/**
	* An unknown "/<name>" command whose name matches an installed skill is
	* the skill invocation form: admit the text unchanged. The agent's
	* injected skill catalog plus its skill tool resolve the methodology
	* server-side on demand, so nothing is expanded into the visible message.
	* Returns undefined when no such skill directory exists.
	*/
	admitUnknownCommandAsSkill(commandLine, sessionId) {
		const name = commandLine.slice(1).trim().split(/\s/u, 1)[0] ?? "";
		if (name.length === 0 || !/^[a-z0-9][a-z0-9-]*$/u.test(name)) return void 0;
		const skillMarkdown = join(name, "SKILL.md");
		const homes = /* @__PURE__ */ new Set();
		const envHome = process.env.DSH_HOME;
		if (envHome !== void 0 && envHome !== "") homes.add(envHome);
		homes.add(join(homedir(), ".agents"));
		const sessionCwd = this.ctx.sessions.get(sessionId)?.header.cwd;
		if (sessionCwd !== void 0 && sessionCwd !== "") {
			homes.add(sessionCwd);
			homes.add(this.defaultCwd);
		}
		for (const home of homes) for (const leaf of [
			"skills",
			join(".agents", "skills"),
			join(".dsh", "skills")
		]) try {
			readFileSync(join(home, leaf, skillMarkdown), "utf8");
			return commandLine;
		} catch {
			continue;
		}
	}
	/** Admit ordinary queued or steering input to the exact live Agent. */
	async prompt(request, signal) {
		if (aborted(signal)) return cancelled();
		if (request.invocationId.length === 0) return failure("invalid-invocation-id", "invocationId must be a non-empty opaque prompt identity");
		const canonicalTimeZone = request.clientTimeZone === void 0 ? void 0 : canonicalClientTimeZone(request.clientTimeZone);
		if (request.clientTimeZone !== void 0 && canonicalTimeZone === void 0) return failure("invalid-time-zone", "clientTimeZone must be UTC or a valid IANA Area/Location name", { value: request.clientTimeZone });
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
					const skillPrompt = this.admitUnknownCommandAsSkill(commandLine, request.sessionId);
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
		const hasImage = request.content.some((part) => part.type === "image");
		const admit = async () => {
			try {
				signal.throwIfAborted();
				if (hasImage) {
					const modelInfo = await this.ctx.llm.resolveModelInfo(selection.provider, selection.model, signal);
					if (modelInfo.inputModalities !== void 0 && !modelInfo.inputModalities.includes("image")) return failure("attachment-error", `Model "${selection.model}" does not support image input.`, { reason: "MODEL_DOES_NOT_SUPPORT_IMAGES" });
				}
				const content = await this.durablePromptContent(request.content);
				signal.throwIfAborted();
				const message = createUserMessage({
					content,
					source: {
						kind: "user",
						invocationId: request.invocationId,
						...canonicalTimeZone === void 0 ? {} : { clientTimeZone: canonicalTimeZone }
					}
				});
				this.assertPromptAdmission(request.sessionId, agent);
				if (request.mode === "steer") agent.steer(message);
				else agent.followup(message);
				return success({ accepted: true });
			} catch (error) {
				if (aborted(signal)) return cancelled();
				if (error instanceof AttachmentError) return failure("attachment-error", error.message, { reason: error.code });
				return failure("agent-busy", "prompt rejected", { reason: String(error) });
			}
		};
		return hasImage ? this.serializeImageAdmission(agent, admit) : admit();
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
		const agent = this.ctx.agents.get(request.sessionId);
		if (agent !== void 0 && hasApiRemoteSubagentOwner(this.ctx, agent.session, agent)) return settled(this.subagentFailure(request.sessionId));
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
