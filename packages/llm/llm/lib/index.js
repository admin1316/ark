import { createRequire } from "node:module";
import { addAbortListener } from "node:events";
import { createHash } from "node:crypto";
import z from "@deepseek-ai/schemastery";
import { MAX_TIMER_DELAY_MS, deadline, timeoutOf } from "@deepseek-ai/dsh-timeout";
import { Remote, TypertRemoteFailure, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { randomUUID } from "@deepseek-ai/dsh-util-crypto";
import { SettingsConflictError, deepEqualJson, remoteNamespaceView, settingsNamespace, snapshotSettingsJson } from "@deepseek-ai/dsh-settings";
import { AsyncLocalStorage } from "node:async_hooks";
import { isObject, symbols } from "@deepseek-ai/cordis";
import { CredentialConflictError, credentialCondition, credentialKey, credentialRef } from "@deepseek-ai/dsh-credentials";
//#region lib/types/brand.js
/**
* dsh-llm's owned branded ids: tool-call correlation and provider request
* diagnostics.
*
* The `Branded<B>` primitive itself lives in `@deepseek-ai/dsh-brand` (a
* zero-dependency type-only package) so every owner of a cross-boundary id can
* brand it without depending on dsh-llm; see that package's README for the
* nominal-typing policy.
*
* @module @deepseek-ai/dsh-llm/brand
*/
/**
* Brand a message identifier.
* @param id - the opaque message identifier.
* @returns the same string, branded; no validation is performed.
*/
function MessageId(id) {
	return id;
}
/**
* Brand a string as a {@link CallId}.
* @param id - the provider-issued (or synthesized) call id.
* @returns the same string, branded; no validation is performed.
*/
function CallId(id) {
	return id;
}
/**
* Brand a provider-issued request identifier.
* @param id - the opaque provider-issued string.
* @returns the same string, branded; no validation is performed.
*/
function ProviderRequestId(id) {
	return id;
}
/**
* Brand an adapter-owned reasoning-effort identifier.
* @param id - the opaque identifier exposed by one model capability.
* @returns the same string, branded; no validation is performed.
*/
function ReasoningEffortId(id) {
	return id;
}
//#endregion
//#region lib/types/call-config.js
/**
* Conversation call configuration and freeze utilities. Provider routing,
* model, reasoning effort, and sampling values are request-header state that
* can affect cache reuse; request waterfalls replace them and the loop logs
* changed snapshots instead of allowing silent per-call drift.
* @module dsh-llm/call-config
*/
/** Process-local identities of request objects assembled by dsh-agent-loop. */
const AGENT_LOOP_REQUESTS = /* @__PURE__ */ new WeakSet();
/**
* Field-wise equality over {@link LlmCallConfig} — the comparison a caller
* runs to decide whether a proposed configuration is a real change (worth a
* logged header snapshot) or the held one restated.
* @param a - one configuration.
* @param b - the other.
* @returns whether every field (including the `stop` list, element-wise) matches.
*/
function callConfigEquals(a, b) {
	if (a.provider !== b.provider || a.model !== b.model || a.reasoningEffort !== b.reasoningEffort || a.temperature !== b.temperature || a.maxTokens !== b.maxTokens) return false;
	if (a.stop === void 0 || b.stop === void 0) return a.stop === b.stop;
	return a.stop.length === b.stop.length && a.stop.every((s, i) => s === b.stop?.[i]);
}
/**
* Mark one exact request object as assembled by dsh-agent-loop.
* @param request - loop-owned request envelope before LLM dispatch.
* @returns the same request object marked as created by the process-local agent loop.
*/
function markAgentLoopRequest(request) {
	AGENT_LOOP_REQUESTS.add(request);
	return request;
}
/**
* Test whether the exact request object was assembled by dsh-agent-loop.
* @param request - request envelope observed at the LLM waterfall.
* @returns whether {@link markAgentLoopRequest} recorded this object.
*/
function isAgentLoopRequest(request) {
	return AGENT_LOOP_REQUESTS.has(request);
}
/**
* Deep-freeze a value in place with an iterative traversal, guarding cycles,
* so later mutation throws without imposing a JavaScript call-stack depth cap.
* {@link AbortSignal} objects are deliberately skipped because they are the
* request's live cancellation channel and freezing them breaks abort.
* @param value - the value to freeze in place.
* @returns the same value, frozen.
*/
function deepFreeze(value) {
	const seen = /* @__PURE__ */ new WeakSet();
	const pending = [{
		kind: "visit",
		node: value
	}];
	while (pending.length > 0) {
		const task = pending.pop();
		/* v8 ignore next -- the loop condition guarantees one pending task. */
		if (task === void 0) continue;
		if (task.kind === "property") {
			pending.push({
				kind: "visit",
				node: task.source[task.key]
			});
			continue;
		}
		const node = task.node;
		if (node === null || typeof node !== "object") continue;
		if (node instanceof AbortSignal) continue;
		if (seen.has(node)) continue;
		seen.add(node);
		Object.freeze(node);
		const keys = Object.keys(node);
		for (let index = keys.length - 1; index >= 0; index--) {
			const key = keys[index];
			/* v8 ignore next -- the loop is bounded by the captured key count. */
			if (key === void 0) continue;
			pending.push({
				kind: "property",
				source: node,
				key
			});
		}
	}
	return value;
}
//#endregion
//#region lib/types/message.js
/** Message value types, identity, and immutable construction helpers. */
/**
* Bound for a `notice` summary. The account rides a collapsed transcript row
* and is committed to the durable log, while its inputs — task labels, goal
* objectives, tool arguments — are caller text with no length of their own.
*/
const CONTEXT_SUMMARY_MAX_CHARS = 120;
/**
* Bound one `notice` summary to {@link CONTEXT_SUMMARY_MAX_CHARS}.
* @param summary - the producer's one-line account, of any length.
* @returns the account, ellipsized when it exceeds the bound.
*/
function boundContextSummary(summary) {
	return summary.length <= 120 ? summary : `${summary.slice(0, 119)}…`;
}
/**
* Detach and deep-freeze a message whose identity already exists.
* @param message - complete message, including its stable identity.
* @returns an immutable snapshot that preserves the identity.
*/
function freezeMessage(message) {
	return deepFreeze(structuredClone(message));
}
/**
* Create one identified message and freeze it before publication.
* @param input - complete role, content, and source for a new message.
* @returns an immutable message with a fresh stable identity.
*/
function createMessage(input) {
	return freezeMessage({
		...input,
		id: MessageId(randomUUID())
	});
}
/**
* Create one identified user-role message and freeze it before publication.
* @param input - complete content and source for a new user message.
* @returns an immutable user message with a fresh stable identity.
*/
function createUserMessage(input) {
	return createMessage({
		...input,
		role: "user"
	});
}
/**
* Create one identified model-produced assistant message and freeze it before publication.
* @param input - complete content plus the provider, model, and optional replay state for a new assistant message.
* @returns an immutable assistant message with fixed role/source tags and a fresh stable identity.
*/
function createAssistantMessage(input) {
	return createMessage({
		role: "assistant",
		content: input.content,
		source: {
			kind: "model",
			...input.source
		}
	});
}
/**
* Create and freeze one identified tool-result message.
* @param input - call identity, raw result blocks, and outcome.
* @returns an immutable user-role tool-result message.
*/
function createToolResultMessage(input) {
	return createUserMessage({
		source: {
			kind: "tool",
			callId: input.callId
		},
		content: [{
			type: "tool-result",
			toolCallId: input.callId,
			content: input.content,
			isError: input.isError
		}]
	});
}
//#endregion
//#region lib/types/error.js
/**
* Harness error base with a stable machine-routable code and chained cause.
* Package errors extend it so tool results and replay can retain failure class.
* @module @deepseek-ai/dsh-llm/error
*/
/**
* Base class for all harness errors. Carries a `code` (stable, programmatic —
* e.g. `NO_ADAPTER`, `INVALID_ARGS`, `INVARIANT`) distinct from the
* human-readable `message`, and supports `cause` chaining via the standard
* `ErrorOptions`. `name` defaults to the subclass constructor name.
*/
var HarnessError = class extends Error {
	/** Stable machine-routable failure class (e.g. `RATE_LIMIT`); route on this, never by parsing `message`. */
	code;
	constructor(message, code, options) {
		super(message, options);
		this.code = code;
		this.name = new.target.name;
	}
};
/** Canonical provider-neutral code for a model request rejected because its context window was exceeded. */
const CONTEXT_WINDOW_EXCEEDED_CODE = "CONTEXT_WINDOW_EXCEEDED";
/** Canonical provider-neutral code for an exhausted account quota or balance. */
const QUOTA_EXCEEDED_CODE = "QUOTA";
/**
* Canonical provider-neutral code for a response that completed normally but
* carried no content blocks at all. Providers occasionally emit a degenerate
* completion (a terminal stop with zero output); adapters classify it as this
* failure instead of yielding an empty assistant message, because an empty
* message silently ends the turn with nothing for the user or the loop to act
* on. The attempt produced nothing durable, so retry policy treats it as safe
* to repeat.
*/
const EMPTY_RESPONSE_CODE = "EMPTY_RESPONSE";
/**
* Canonical provider-neutral code for a credential that was supplied but
* cannot be used — malformed rather than absent. Distinct from
* `MISSING_CREDENTIAL` because the fix differs: correct the stored value
* rather than supply one. Deliberately outside the default retryable set —
* a malformed credential fails identically on every attempt.
*/
const INVALID_CREDENTIAL_CODE = "INVALID_CREDENTIAL";
/** Structured codes and plain phrases that explicitly name a context bound being exceeded. */
const STRUCTURED_CONTEXT_OVERFLOW = new RegExp(String.raw`(?:^|[^a-z0-9])context[\s_-](?:length|window)[\s_-]` + String.raw`(?:exceed(?:ed|s)?|overflow(?:ed)?|limit[\s_-]exceeded)(?:$|[^a-z0-9])`, "i");
/** Request-size wording that ties "too large" directly to model context capacity. */
const TOO_LARGE_FOR_CONTEXT = new RegExp(String.raw`\b(?:request|prompt|input|messages?)\s+(?:is\s+|are\s+)?` + String.raw`too\s+(?:large|long)\s+for\s+(?:(?:this|the)\s+)?` + String.raw`(?:model(?:'s)?\s+)?context(?:\s+window)?\b`, "i");
/** "Exceeds" wording is safe only when its object is explicitly the model context. */
const EXCEEDS_MODEL_CONTEXT = new RegExp(String.raw`\b(?:input|prompt|request|messages?)\b.{0,40}` + String.raw`\b(?:exceed(?:s|ed)?|overflows?|is\s+larger\s+than)\b.{0,40}` + String.raw`\b(?:the\s+)?(?:model(?:'s)?\s+)?context(?:\s+(?:length|window))?\b`, "i");
/**
* Recognize the context-overflow wording used by OpenAI-compatible providers
* and library adapters. Adapters pass all available provider code, type, and
* message text so both thrown and in-band delivery styles share one classifier.
* @param detail - provider error code/type/message text joined into one string.
* @returns true when the detail identifies a request exceeding the model context window.
*/
function isContextWindowExceededError(detail) {
	return STRUCTURED_CONTEXT_OVERFLOW.test(detail) || /\b(?:maximum|max)(?:\s+(?:allowed|supported))?\s+context\s+(?:length|window)\b/i.test(detail) || TOO_LARGE_FOR_CONTEXT.test(detail) || /\b(?:input|prompt|request)\s+(?:is\s+)?too\s+(?:long|large)\s+for\s+(?:this|the)\s+model\b/i.test(detail) || EXCEEDS_MODEL_CONTEXT.test(detail);
}
/**
* Recognize provider wording that identifies an exhausted account quota rather
* than a transient request-rate limit.
* @param detail - provider error code/type/message text joined into one string.
* @returns true only for terminal quota, balance, credit, budget, or usage-limit wording.
*/
function isQuotaExceededError(detail) {
	return /\binsufficient[\s_-]+(?:quota|balance|credits?)\b/i.test(detail) || /\b(?:quota|usage[\s_-]+limit)[\s_-]+(?:exceeded|exhausted|reached)\b/i.test(detail) || /\bexceed(?:ed|s)?[\s_-]+(?:(?:your|the)[\s_-]+)?(?:current[\s_-]+)?quota\b/i.test(detail) || /\b(?:balance|credits?)[\s_-]+(?:exhausted|depleted)\b/i.test(detail) || /\bout[\s_-]+of[\s_-]+(?:credits?|budget)\b/i.test(detail);
}
/**
* Render a thrown value with its full `cause` chain and AggregateError
* members, so transport wrappers like undici's `TypeError: fetch failed`
* surface the underlying failure instead of masking it. Plain structured
* failures render their own data-backed `message`. Diagnostic-surface
* rendering only (messages, notices, logs) — never parse the result; route on
* {@link HarnessError.code}.
* @param value - the caught value (`unknown` in catch clauses).
* @returns the outermost message first, each cause appended with `: ` (skipped
* when it repeats the wrapper message verbatim), and AggregateError members
* bracketed and `; `-joined.
*/
function errorChain(value) {
	const path = /* @__PURE__ */ new Set();
	const render = (current) => {
		if (path.has(current)) return "<circular cause>";
		path.add(current);
		try {
			if (!(current instanceof Error)) {
				if (typeof current === "object" && current !== null) {
					const descriptor = Object.getOwnPropertyDescriptor(current, "message");
					if (descriptor !== void 0 && "value" in descriptor && typeof descriptor.value === "string") return descriptor.value;
				}
				return String(current);
			}
			const message = current.message === "" ? current.name : current.message;
			const members = current instanceof AggregateError && current.errors.length > 0 ? ` [${current.errors.map(render).join("; ")}]` : "";
			const causeText = current.cause === void 0 || current.cause === null ? "" : render(current.cause);
			return `${message}${members}${causeText === "" || causeText === message ? "" : `: ${causeText}`}`;
		} catch {
			return "<unrenderable value>";
		} finally {
			path.delete(current);
		}
	};
	return render(value);
}
/**
* Narrow an arbitrary thrown value to a HarnessError (for `instanceof` at runtime boundaries).
* @param value - the caught value (`unknown` in catch clauses).
* @returns true only for real instances; duck-typed or cross-realm errors do not narrow.
*/
function isHarnessError(value) {
	return value instanceof HarnessError;
}
//#endregion
//#region lib/types/retry-policy.js
/**
* Provider-owned request-retry policy configuration and resolution.
*
* Adapters expose one resolved policy per registered provider route; the
* optional dsh-llm-retry plugin executes it on the agent's failed-step extension point.
*
* @module @deepseek-ai/dsh-llm/retry-policy
*/
const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_INITIAL_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 1e4;
const DEFAULT_JITTER_RATIO = .1;
const DEFAULT_RETRYABLE_CODES = Object.freeze([
	EMPTY_RESPONSE_CODE,
	"RATE_LIMIT",
	"SERVER",
	"TIMEOUT",
	"TRANSPORT"
]);
const backoffSchema = z.object({
	initialDelayMs: z.number().max(MAX_TIMER_DELAY_MS).default(DEFAULT_INITIAL_DELAY_MS),
	maxDelayMs: z.number().max(MAX_TIMER_DELAY_MS).default(DEFAULT_MAX_DELAY_MS),
	jitterRatio: z.number().min(0).max(1).default(DEFAULT_JITTER_RATIO)
});
const normalPolicySchema = z.object({
	mode: z.const("normal").required(),
	maxRetries: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_RETRIES),
	retryableCodes: z.array(z.string()).default([...DEFAULT_RETRYABLE_CODES]),
	backoff: backoffSchema
});
const alwaysPolicySchema = z.object({
	mode: z.const("always").required(),
	backoff: backoffSchema
});
/** Cordis schema embedded by each concrete provider configuration. */
const RetryPolicySchema = z.union([normalPolicySchema, alwaysPolicySchema]);
const NORMAL_POLICY_KEYS = new Set([
	"mode",
	"maxRetries",
	"retryableCodes",
	"backoff"
]);
const ALWAYS_POLICY_KEYS = new Set([
	"mode",
	"maxRetries",
	"retryableCodes",
	"backoff"
]);
const BACKOFF_KEYS = new Set([
	"initialDelayMs",
	"maxDelayMs",
	"jitterRatio"
]);
function validateKeys(value, allowed, path) {
	for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${path}: unknown key "${key}"`);
}
function resolveBackoff(config, path) {
	if (config !== void 0) validateKeys(config, BACKOFF_KEYS, path);
	const initialDelayMs = config?.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
	const maxDelayMs = config?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
	const jitterRatio = config?.jitterRatio ?? DEFAULT_JITTER_RATIO;
	if (!Number.isFinite(initialDelayMs) || initialDelayMs <= 0 || initialDelayMs > MAX_TIMER_DELAY_MS) throw new Error(`${path}.initialDelayMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`);
	if (!Number.isFinite(maxDelayMs) || maxDelayMs <= 0 || maxDelayMs > MAX_TIMER_DELAY_MS) throw new Error(`${path}.maxDelayMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`);
	if (initialDelayMs > maxDelayMs) throw new Error(`${path}.initialDelayMs must be less than or equal to maxDelayMs`);
	if (!Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1) throw new Error(`${path}.jitterRatio must be between 0 and 1`);
	return Object.freeze({
		initialDelayMs,
		maxDelayMs,
		jitterRatio
	});
}
/**
* Validate, default, and detach one provider-owned retry policy.
* @param config - optional provider configuration; omission selects normal defaults.
* @param path - diagnostic path naming the provider config that owns the value.
* @returns an immutable policy safe to capture in provider registration state.
*/
function resolveRetryPolicy(config, path) {
	if (config === void 0) return Object.freeze({
		mode: "normal",
		maxRetries: DEFAULT_MAX_RETRIES,
		retryableCodes: DEFAULT_RETRYABLE_CODES,
		...resolveBackoff(void 0, `${path}.backoff`)
	});
	switch (config.mode) {
		case "normal": {
			validateKeys(config, NORMAL_POLICY_KEYS, path);
			const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
			const retryableCodes = config.retryableCodes ?? [...DEFAULT_RETRYABLE_CODES];
			if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) throw new Error(`${path}.maxRetries must be a non-negative safe integer`);
			if (retryableCodes.length === 0) throw new Error(`${path}.retryableCodes must not be empty`);
			if (retryableCodes.some((code) => typeof code !== "string" || code.length === 0)) throw new Error(`${path}.retryableCodes must contain only non-empty strings`);
			if (new Set(retryableCodes).size !== retryableCodes.length) throw new Error(`${path}.retryableCodes must not contain duplicates`);
			return Object.freeze({
				mode: "normal",
				maxRetries,
				retryableCodes: Object.freeze([...retryableCodes]),
				...resolveBackoff(config.backoff, `${path}.backoff`)
			});
		}
		case "always":
			validateKeys(config, ALWAYS_POLICY_KEYS, path);
			return Object.freeze({
				mode: "always",
				...resolveBackoff(config.backoff, `${path}.backoff`)
			});
		default: throw new Error(`${path}.mode must be "normal" or "always"`);
	}
}
//#endregion
//#region lib/types/adapter-failure.js
/**
* Normalization for values thrown by a final LLM adapter boundary.
*
* @module @deepseek-ai/dsh-llm/adapter-failure
*/
/**
* Detach serializable provider facts from a value thrown by an adapter.
* @param value - arbitrary value thrown during adapter dispatch or iteration.
* @returns immutable provider-neutral facts suitable for a terminal finish chunk.
* @internal
*/
function normalizeLlmFailure(value) {
	const error = value instanceof Error ? value : new HarnessError(thrownMessage(value), "UNKNOWN", { cause: value });
	const carried = ownFailureSnapshot(error);
	if (carried !== void 0 && carried.code === ownErrorCode(error)) return carried;
	return Object.freeze({
		message: errorMessage(error),
		code: harnessErrorCode(error)
	});
}
/** Render a non-Error throw without letting hostile coercion escape normalization. */
function thrownMessage(value) {
	try {
		const message = String(value);
		return message.length > 0 ? message : "LLM adapter failed";
	} catch (_hostileThrownValue) {
		return "LLM adapter failed";
	}
}
/** Read a foreign error's own data-backed `code` without invoking accessors. */
function ownErrorCode(error) {
	try {
		const descriptor = Object.getOwnPropertyDescriptor(error, "code");
		return descriptor !== void 0 && "value" in descriptor ? descriptor.value : void 0;
	} catch (_sdkPropertyTrap) {
		return;
	}
}
/** Snapshot an own data property without invoking an SDK-defined accessor. */
function ownFailureSnapshot(error) {
	try {
		const descriptor = Object.getOwnPropertyDescriptor(error, "failure");
		return descriptor !== void 0 && "value" in descriptor ? failureSnapshot(descriptor.value) : void 0;
	} catch (_sdkPropertyTrap) {
		return;
	}
}
/** Validate and detach an arbitrary serializable failure payload. */
function failureSnapshot(value) {
	if (typeof value !== "object" || value === null) return void 0;
	try {
		const candidate = value;
		const message = candidate.message;
		const code = candidate.code;
		const status = candidate.status;
		const providerRetryAfterMs = candidate.providerRetryAfterMs;
		const requestId = candidate.requestId;
		if (typeof message !== "string" || message.length === 0 || typeof code !== "string" || code.length === 0 || status !== void 0 && (!Number.isInteger(status) || status < 100 || status > 599) || providerRetryAfterMs !== void 0 && (!Number.isFinite(providerRetryAfterMs) || providerRetryAfterMs <= 0) || requestId !== void 0 && (typeof requestId !== "string" || requestId.length === 0)) return void 0;
		return Object.freeze({
			message,
			code,
			...status === void 0 ? {} : { status },
			...providerRetryAfterMs === void 0 ? {} : { providerRetryAfterMs },
			...requestId === void 0 ? {} : { requestId }
		});
	} catch (_sdkFailureGetter) {
		return;
	}
}
/** Read an SDK error message without letting an accessor replace the primary failure. */
function errorMessage(error) {
	try {
		const message = error.message;
		if (typeof message === "string" && message.length > 0) return message;
	} catch (_sdkMessageGetter) {}
	return "LLM adapter failed";
}
/** Trust only Harness-owned codes; third-party SDK codes are not our taxonomy. */
function harnessErrorCode(error) {
	return error instanceof HarnessError ? error.code : "UNKNOWN";
}
//#endregion
//#region lib/types/api-key.js
/**
* The one definition of a well-formed provider API key, shared by every
* adapter that puts one in an HTTP header.
* @module @deepseek-ai/dsh-llm/api-key
*/
/**
* Characters an HTTP header value carries verbatim and every known provider
* key uses: printable ASCII, space excluded. A key outside this set cannot
* reach any provider — `fetch` refuses to build the header — so this is a
* transport invariant rather than one provider's policy. Latin-1 is excluded
* deliberately: a header could carry it, but no provider issues it, and
* admitting it trades a local explained refusal for an opaque 401.
*/
const LEGAL_API_KEY = /^[\x21-\x7E]+$/;
/**
* Identify header names whose non-empty values must use credential storage.
* @param name - header name, compared case-insensitively.
* @returns whether the name carries authentication, tokens, passwords or cookies.
*/
function isCredentialHeaderName(name) {
	return /authorization|api[-_]?key|auth[-_]?token|access[-_]?token|token|secret|credential|password|cookie/iu.test(name.trim());
}
/**
* Judge one *supplied* API key, trimming surrounding whitespace first.
*
* Trimming is silent because a padded key has one unambiguous reading; every
* other defect is reported. Absence is a configuration state this function
* never sees — a profile naming no credential authenticates through the
* provider's own ambient discovery or OAuth — so callers decide whether a
* value was supplied before asking.
* @param raw - the key exactly as configured, stored, or typed.
* @returns the trimmed key, or why it cannot be used.
*/
function normalizeApiKey(raw) {
	const value = raw.trim();
	if (value.length === 0) return {
		ok: false,
		reason: "empty"
	};
	if (!LEGAL_API_KEY.test(value)) return {
		ok: false,
		reason: "illegalCharacters"
	};
	return {
		ok: true,
		value
	};
}
//#endregion
//#region lib/types/never.js
/**
* Exhaustiveness helper for closed core unions. Use {@link assertNever} at the default branch so a
* new variant fails compilation at every required handler. Do not use it for declaration-merged
* unions such as session events or content blocks: handle known variants and explicitly fall
* through because plugins may add valid unknown cases.
* @module @deepseek-ai/dsh-llm/never
*/
/**
* Mark an unreachable closed-union branch. A newly unhandled typed variant fails at the call site;
* a value that escaped its type throws with diagnostics at runtime.
* @param value - the impossible value; typed `never` so an unhandled variant fails compilation at the call site.
* @param context - optional label (e.g. the switch site) prefixed into the throw message.
* @returns never — it always throws, with the offending value JSON-rendered in the message.
*/
function assertNever(value, context) {
	const rendered = JSON.stringify(value) ?? String(value);
	throw new Error(`unreachable variant${context ? ` in ${context}` : ""}: ${rendered}`);
}
//#endregion
//#region lib/types/content.js
/** Content-block structure helpers. @module @deepseek-ai/dsh-llm/content */
/**
* Bridge one attachment provider's host object location into the mounted
* tool execution world. The consumer supplies the current filesystem
* provider's mapping without making attachment or LLM definitions depend on it.
* @param attachments - provider that owns the normalized attachment object.
* @param mapHostPath - map one absolute host path into the current tool execution world.
* @param ref - durable normalized attachment reference.
* @returns a read-only execution-world path, or undefined when either provider exposes no mapping.
* @throws an attachment error when the durable reference is invalid.
*/
function resolveImageAttachmentAccess(attachments, mapHostPath, ref) {
	const hostPath = attachments.imageHostPath(ref);
	if (hostPath === void 0) return void 0;
	const readonlyPath = mapHostPath(hostPath);
	return readonlyPath === void 0 ? void 0 : { readonlyPath };
}
function quoted(value) {
	return JSON.stringify(value);
}
function imageIdentity(ref) {
	return ref.name === void 0 ? String(ref.attachmentId) : `${quoted(ref.name)} (${ref.attachmentId})`;
}
function extension(mediaType) {
	switch (mediaType) {
		case "image/png": return ".png";
		case "image/jpeg": return ".jpg";
		case "image/webp": return ".webp";
		case "image/gif": return ".gif";
		default: return assertNever(mediaType, "image extension");
	}
}
function normalizedAccessText(ref, access) {
	return ` Normalized copy (read-only; may be resized or re-encoded): ${quoted(access.readonlyPath)} (${ref.width}x${ref.height}px, ${ref.mediaType}). Source dimensions, format, and byte size may differ. Copy to a writable path ending in ${extension(ref.mediaType)} before editing.`;
}
/**
* Stable text shown to a model that cannot accept one durable image reference.
* @param ref - durable normalized attachment omitted from the request.
* @returns deterministic text-only placeholder.
*/
function textOnlyImageText(ref) {
	return `[image omitted because this model accepts text only; attachment sha256:${String(ref.attachmentId).slice(7, 15)}]`;
}
/**
* Stable model-facing handle for one exact request image. Identity comes from
* the occurrence's own durable reference: request versions are prepared per
* attachment id, so one shared version may serve occurrences whose display
* names differ.
* @param ref - the occurrence's durable normalized attachment.
* @param version - exact request-image dimensions shown beside the text.
* @param access - optional path resolved for the current tool execution world.
* @returns attachment handle and request-image dimensions.
*/
function requestImageHandleText(ref, version, access) {
	const preview = `Image ${imageIdentity(ref)}; request preview ${version.width}x${version.height}px.`;
	return access === void 0 ? `${preview} It may be resized or re-encoded; source dimensions, format, and byte size may differ.` : preview + normalizedAccessText(ref, access);
}
/**
* Stable per-image placeholder for a request-limit omission.
* @param ref - durable normalized attachment omitted from this request.
* @param access - optional provider-resolved path for model tools.
* @returns identity, normalized metadata, and the available recovery path.
*/
function offloadedImageText(ref, access) {
	const identity = `image omitted to fit request image limits; ${imageIdentity(ref)}.`;
	if (access === void 0) return `[${identity} No local normalized image path is available; ask the user to attach it again if needed.]`;
	return `[${identity}${normalizedAccessText(ref, access)}]`;
}
/**
* True when typed model content contains an image block, walking nested
* tool-result content. This is the one recursive image walk shared by every
* image policy (capability gating, text-only serialization, compaction
* survey), so a consumer cannot silently diverge on nesting depth.
* @param content - typed model content blocks.
* @returns whether any nested block is an image.
*/
function contentHasImage(content) {
	return content.some((block) => block.type === "image" || block.type === "tool-result" && contentHasImage(block.content));
}
/** Base64 length of raw image bytes, including padding. */
function base64Length(bytes) {
	return Math.ceil(bytes / 3) * 4;
}
/** Collect represented image lengths in request and nested-block order. */
function collectImageLengths(blocks, lengths, policy) {
	for (const block of blocks) if (block.type === "image") {
		const bytes = policy.byteLength === void 0 ? block.attachment.bytes : policy.byteLength(block.attachment);
		lengths.push(policy.representation === "base64" ? base64Length(bytes) : bytes);
	} else if (block.type === "tool-result") collectImageLengths(block.content, lengths, policy);
}
/** Replace the first `remaining.count` image occurrences without mutating durable messages. */
function replaceOldestImages(blocks, remaining, placeholder) {
	let next;
	for (const [index, block] of blocks.entries()) {
		if (block.type === "image" && remaining.count > 0) {
			remaining.count -= 1;
			next ??= blocks.slice(0, index);
			next.push({
				type: "text",
				text: placeholder(block.attachment)
			});
			continue;
		}
		if (block.type === "tool-result") {
			const content = replaceOldestImages(block.content, remaining, placeholder);
			if (content !== block.content) {
				next ??= blocks.slice(0, index);
				next.push({
					...block,
					content
				});
				continue;
			}
		}
		next?.push(block);
	}
	return next ?? blocks;
}
/** Replace every image occurrence, including nested tool results, for a text-only model. */
function replaceImagesForTextModel(blocks) {
	let next;
	for (const [index, block] of blocks.entries()) {
		if (block.type === "image") {
			next ??= blocks.slice(0, index);
			next.push({
				type: "text",
				text: textOnlyImageText(block.attachment)
			});
			continue;
		}
		if (block.type === "tool-result") {
			const content = replaceImagesForTextModel(block.content);
			if (content !== block.content) {
				next ??= blocks.slice(0, index);
				next.push({
					...block,
					content
				});
				continue;
			}
		}
		next?.push(block);
	}
	return next ?? blocks;
}
/**
* Project durable image history into deterministic text for an exact text-only model.
* @param messages - complete request history.
* @returns the original list without images, otherwise shallow message copies with stable placeholders.
*/
function projectImagesForTextModel(messages) {
	if (!messages.some((message) => contentHasImage(message.content))) return messages;
	return messages.map((message) => {
		const content = replaceImagesForTextModel(message.content);
		return content === message.content ? message : {
			...message,
			content
		};
	});
}
/**
* Number of oldest image occurrences one request projection removes, in whole
* count and byte quanta, once a route budget is exceeded. The result depends
* only on the represented lengths, so provider request pricing reproduces the
* exact serialization decision without building the projected messages.
* @param lengths - represented byte length of every occurrence, in request order.
* @param policy - count/byte budgets and removal quanta; unbounded when absent.
* @returns how many leading occurrences the projection replaces with placeholders.
*/
function offloadedImagePrefixCount(lengths, policy) {
	const total = lengths.reduce((sum, bytes) => sum + bytes, 0);
	const excessCount = policy.maxImages === void 0 ? 0 : Math.max(0, lengths.length - policy.maxImages);
	const excessBytes = policy.maxBytes === void 0 ? 0 : Math.max(0, total - policy.maxBytes);
	if (excessCount === 0 && excessBytes === 0) return 0;
	const countQuantum = policy.countQuantum ?? 1;
	const byteQuantum = policy.byteQuantum ?? 1;
	const removeCount = excessCount === 0 ? 0 : Math.ceil(excessCount / countQuantum) * countQuantum;
	const removeBytes = excessBytes === 0 ? 0 : Math.ceil(excessBytes / byteQuantum) * byteQuantum;
	let count = 0;
	let removedBytes = 0;
	for (const imageBytes of lengths) {
		if (count >= removeCount && (removeBytes === 0 || (byteQuantum === 1 ? removedBytes >= removeBytes : removedBytes > removeBytes))) break;
		removedBytes += imageBytes;
		count += 1;
	}
	return count;
}
/**
* Return a deterministic transient projection whose oldest images are replaced
* in whole count and byte quanta after a route budget is exceeded. The target
* depends only on complete durable history: at 129 one-megabyte images under
* a 128 MiB bound with a 64 MiB quantum, the oldest 65 images are removed so
* 64 MiB remain; that removed prefix stays fixed until total history exceeds
* 192 MiB.
* @param messages - complete request history, oldest first.
* @param policy - route representation, budgets, and removal quanta.
* @returns original messages below both bounds, otherwise shallow copies with deterministic placeholders.
*/
function offloadRequestImagesWithPolicy(messages, policy) {
	const lengths = [];
	for (const message of messages) collectImageLengths(message.content, lengths, policy);
	const count = offloadedImagePrefixCount(lengths, policy);
	if (count === 0) return messages;
	const remaining = { count };
	return messages.map((message) => {
		const content = replaceOldestImages(message.content, remaining, policy.placeholder);
		return content === message.content ? message : {
			...message,
			content
		};
	});
}
//#endregion
//#region lib/types/provider-transaction.js
/** Journaled Native provider writes; the Credential provider remains the only durable owner. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PROVIDER = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const resourceTails = /* @__PURE__ */ new WeakMap();
const execution = new AsyncLocalStorage();
/** Reserve each resource tier atomically: provider journal, namespace, then credential references. */
async function withResources(owner, keys, operation) {
	const original = Reflect.get(owner, symbols.original);
	const identity = isObject(original) ? original : owner;
	let tails = resourceTails.get(identity);
	if (tails === void 0) {
		tails = /* @__PURE__ */ new Map();
		resourceTails.set(identity, tails);
	}
	const distinct = [...new Set(keys)];
	const previous = distinct.flatMap((key) => tails.get(key) ?? []);
	const lease = Promise.withResolvers();
	for (const key of distinct) tails.set(key, lease.promise);
	try {
		await Promise.all(previous);
		return await operation();
	} finally {
		lease.resolve();
		for (const key of distinct) if (tails.get(key) === lease.promise) tails.delete(key);
		if (tails.size === 0) resourceTails.delete(identity);
	}
}
function fail(code, message, details = {}) {
	throw new TypertRemoteFailure({
		code,
		message,
		details
	});
}
function record(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function onlyFields(value, fields) {
	return Object.keys(value).every((key) => fields.includes(key));
}
/** JSON object insertion order is not part of a Native request's identity; array order is. */
function hashJson(value) {
	return hash(JSON.stringify(value, (_key, item) => record(item) ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item));
}
function strings(value) {
	return Array.isArray(value) && value.every((part) => typeof part === "string");
}
function pathOp(value) {
	return record(value) && strings(value.path) && (value.op === "unset" || value.op === "set" && Object.hasOwn(value, "value"));
}
function pathOps(value) {
	return Array.isArray(value) && value.every(pathOp);
}
function canonicalOps(ops) {
	return ops.map((op) => op.op === "unset" ? {
		op: "unset",
		path: [...op.path]
	} : {
		op: "set",
		path: [...op.path],
		value: op.value
	});
}
function prefix(path, base) {
	return base.length <= path.length && base.every((part, index) => path[index] === part);
}
function ref(value) {
	try {
		return credentialRef(value);
	} catch {
		return fail("input-invalid", "credential reference must be a valid environment name", { field: "credential.ref" });
	}
}
function snapshot(value) {
	try {
		return snapshotSettingsJson(value);
	} catch {
		return fail("input-invalid", "provider mutation must contain only lossless JSON data");
	}
}
function requestSnapshot(input) {
	const value = snapshot(input);
	if (!record(value) || typeof value.transactionId !== "string" || !UUID.test(value.transactionId) || typeof value.provider !== "string" || !PROVIDER.test(value.provider) || typeof value.settingsNs !== "string" || typeof value.expectedRevision !== "number" || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0 || !pathOps(value.ops) || value.ops.length > 64) return fail("input-invalid", "provider mutation has invalid identity, revision, or operations");
	try {
		settingsNamespace(value.settingsNs);
	} catch {
		return fail("input-invalid", "provider mutation namespace is invalid", { field: "settingsNs" });
	}
	const ops = canonicalOps(value.ops);
	if (ops.some((left, index) => ops.some((right, other) => index !== other && prefix(left.path, right.path)))) return fail("settings-rejected", "provider mutation paths must not overlap", { ns: value.settingsNs });
	let credential;
	if (value.credential !== void 0) {
		const item = value.credential;
		if (!record(item) || typeof item.ref !== "string") return fail("input-invalid", "provider credential is invalid");
		ref(item.ref);
		if (item.op === "unset") credential = {
			op: "unset",
			ref: item.ref
		};
		else if (item.op === "set" && typeof item.value === "string" && item.value.trim().length > 0) credential = {
			op: "set",
			ref: item.ref,
			value: item.value
		};
		else return fail("input-invalid", "provider credential value or operation is invalid");
	}
	if (value.ops.length === 0 && credential === void 0) return fail("settings-rejected", "provider mutation must change settings, a credential, or both");
	return {
		transactionId: value.transactionId,
		provider: value.provider,
		settingsNs: value.settingsNs,
		expectedRevision: value.expectedRevision,
		ops,
		...credential === void 0 ? {} : { credential }
	};
}
function transactionIdentity(input) {
	const value = snapshot(input);
	if (!record(value) || typeof value.provider !== "string" || !PROVIDER.test(value.provider) || typeof value.transactionId !== "string" || !UUID.test(value.transactionId)) return fail("input-invalid", "provider transaction needs a valid provider and UUID");
	return {
		provider: value.provider,
		transactionId: value.transactionId
	};
}
function pathValue(value, path) {
	let current = value;
	for (const key of path) {
		if (!record(current) || !Object.hasOwn(current, key)) return { present: false };
		current = current[key];
	}
	return current === void 0 ? { present: false } : {
		present: true,
		value: current
	};
}
function edit(value, op, path = op.path) {
	const [head, ...rest] = path;
	if (head === void 0) return op.op === "unset" ? {} : structuredClone(op.value);
	const source = record(value) ? value : {};
	if (rest.length === 0 && op.op === "unset") {
		const { [head]: removed, ...kept } = source;
		return kept;
	}
	const child = Object.hasOwn(source, head) ? source[head] : void 0;
	if (rest.length > 0 && op.op === "unset" && !record(child)) return source;
	return {
		...source,
		[head]: edit(child, op, rest)
	};
}
function apply(value, ops) {
	return ops.reduce((current, op) => edit(current, op), structuredClone(value ?? {}));
}
function satisfied(value, ops) {
	return ops.every((op) => {
		if (op.op === "unset" && op.path.length === 0) return value === void 0 || deepEqualJson(value, {});
		const current = pathValue(value, op.path);
		return op.op === "unset" ? !current.present : current.present && deepEqualJson(current.value, op.value);
	});
}
function references(value, path) {
	const profile = pathValue(value, path).value;
	const refs = /* @__PURE__ */ new Map();
	if (!record(profile)) return refs;
	const add = (value, tail) => {
		if (typeof value !== "string" || value === "") return;
		refs.set(value, [...refs.get(value) ?? [], [...path, ...tail]]);
	};
	add(profile.apiKeyEnv, ["apiKeyEnv"]);
	if (record(profile.credentialHeaders)) for (const [name, value] of Object.entries(profile.credentialHeaders)) add(value, ["credentialHeaders", name]);
	return refs;
}
function fingerprint(provider, value) {
	const selected = pathValue(value, provider.settingsPath).value;
	const profile = record(selected) ? selected : {};
	return hash(JSON.stringify({
		provider: provider.provider,
		settingsNs: provider.settingsNs,
		settingsPath: provider.settingsPath,
		baseURL: typeof profile.baseURL === "string" ? profile.baseURL.replace(/\/+$/u, "") : null,
		api: typeof profile.api === "string" ? profile.api : null
	}));
}
function makePlan(provider, value, request, configured) {
	const ops = request.ops.map((op) => structuredClone(op));
	let credential = request.credential;
	const after = apply(value, ops);
	if (credential?.op === "set" && (configured || references(value, provider.settingsPath).has(credential.ref))) {
		const versionRef = `ARK_${provider.provider.toUpperCase().replace(/[^A-Z0-9]+/gu, "_")}_V_${hash(JSON.stringify({
			transactionId: request.transactionId,
			endpointFingerprint: fingerprint(provider, after),
			sourceRef: credential.ref
		})).slice(0, 24).toUpperCase()}`;
		for (const path of references(after, provider.settingsPath).get(credential.ref) ?? []) {
			const owner = ops.find((op) => op.op === "set" && prefix(path, op.path));
			const replacement = {
				op: "set",
				path,
				value: versionRef
			};
			if (owner === void 0) ops.push(replacement);
			else ops[ops.indexOf(owner)] = {
				...owner,
				value: snapshot(edit(owner.value, replacement, path.slice(owner.path.length)))
			};
		}
		credential = {
			...credential,
			ref: versionRef
		};
	}
	return {
		settingsPath: [...provider.settingsPath],
		ops,
		expectedRevision: request.expectedRevision,
		...credential === void 0 ? {} : { credential: credential.op === "unset" ? {
			op: "unset",
			ref: credential.ref
		} : {
			op: "set",
			ref: credential.ref,
			valueDigest: hash(credential.value)
		} }
	};
}
function inputDigest(request) {
	return hashJson({
		provider: request.provider,
		settingsNs: request.settingsNs,
		ops: request.ops,
		credential: request.credential?.op === "set" ? {
			op: "set",
			ref: request.credential.ref,
			valueDigest: hash(request.credential.value)
		} : request.credential
	});
}
function plannedInputDigest(provider, settingsNs, plan) {
	return hashJson({
		provider,
		settingsNs,
		ops: plan.ops,
		credential: plan.credential
	});
}
function legacyPlanDigest(provider, settingsNs, plan) {
	return hash(JSON.stringify({
		provider,
		settingsNs,
		settingsPath: plan.settingsPath,
		ops: plan.ops,
		credential: plan.credential,
		requestDigest: plan.requestDigest
	}));
}
function planDigest(provider, namespace, plan) {
	return hashJson({
		provider,
		settingsNs: namespace,
		plan
	});
}
function isOutcome(value) {
	return value === "committed" || value === "rolled-back" || value === "committed-not-live";
}
function isPhase(value) {
	return value === "prepared" || value === "credential-staged" || value === "settings-applied" || value === "credential-applied" || value === "done";
}
function storedFailure(value) {
	if (value === void 0) return void 0;
	if (!record(value) || !record(value.details)) return fail("provider-transaction-in-doubt", "provider receipt failure is invalid");
	const details = value.details;
	if (value.code === "credential-rejected" && typeof details.provider === "string" && PROVIDER.test(details.provider)) return {
		code: value.code,
		message: "provider credential changed before commit",
		details: { provider: details.provider }
	};
	if (value.code === "settings-conflict" && typeof details.ns === "string" && typeof details.expected === "number" && Number.isSafeInteger(details.expected) && details.expected >= 0 && typeof details.actual === "number" && Number.isSafeInteger(details.actual) && details.actual >= 0) return {
		code: value.code,
		message: "provider settings revision changed",
		details: {
			ns: details.ns,
			expected: details.expected,
			actual: details.actual
		}
	};
	if (value.code === "settings-rejected" && typeof details.ns === "string") return {
		code: value.code,
		message: "provider settings write was rejected",
		details: { ns: details.ns }
	};
	if (value.code === "provider-registration-rejected" && typeof details.provider === "string" && PROVIDER.test(details.provider)) return {
		code: value.code,
		message: "provider settings were stored but did not activate",
		details: { provider: details.provider }
	};
	return fail("provider-transaction-in-doubt", "provider receipt failure is invalid");
}
function parseReceipt(value) {
	if (!record(value) || !onlyFields(value, [
		"requestDigest",
		"legacyInput",
		"outcome",
		"error"
	]) || typeof value.requestDigest !== "string" || !SHA256.test(value.requestDigest) || !isOutcome(value.outcome)) return fail("provider-transaction-in-doubt", "provider receipt history is invalid");
	const error = storedFailure(value.error);
	const legacyInput = parseLegacyInput(value.legacyInput);
	const identity = {
		requestDigest: value.requestDigest,
		...legacyInput === void 0 ? {} : { legacyInput }
	};
	if (value.outcome === "committed") {
		if (error !== void 0) return fail("provider-transaction-in-doubt", "provider receipt outcome is inconsistent");
		return {
			...identity,
			outcome: value.outcome
		};
	}
	if (error === void 0) return fail("provider-transaction-in-doubt", "provider receipt outcome is inconsistent");
	return {
		...identity,
		outcome: value.outcome,
		error
	};
}
function parseLegacyInput(value) {
	if (value === void 0) return void 0;
	if (!record(value) || !onlyFields(value, ["settingsPath", "digest"]) || !strings(value.settingsPath) || typeof value.digest !== "string" || !SHA256.test(value.digest)) return fail("provider-transaction-in-doubt", "provider legacy input binding is invalid");
	return {
		settingsPath: value.settingsPath,
		digest: value.digest
	};
}
function parseJournal(input) {
	if (input === void 0) return void 0;
	if (input.kind !== "grant") return fail("provider-transaction-in-doubt", "provider journal has an unsupported record kind");
	let value;
	try {
		value = snapshotSettingsJson(input.payload);
	} catch {
		return fail("provider-transaction-in-doubt", "provider journal is not valid JSON data");
	}
	if (!record(value) || value.version !== 1 || value.receiptVersion !== void 0 && value.receiptVersion !== 1) return fail("provider-transaction-in-doubt", "provider journal format is unsupported");
	const legacy = value.receiptVersion === void 0;
	if (!onlyFields(value, [
		"version",
		"receiptVersion",
		"transactionId",
		"provider",
		"settingsNs",
		"requestDigest",
		"digest",
		"plan",
		"phase",
		"completed",
		"outcome",
		"error",
		"legacyInput"
	])) return fail("provider-transaction-in-doubt", "provider journal contains unsupported fields");
	const plan = value.plan;
	if (typeof value.transactionId !== "string" || !UUID.test(value.transactionId) || typeof value.provider !== "string" || !PROVIDER.test(value.provider) || typeof value.settingsNs !== "string" || typeof value.digest !== "string" || !SHA256.test(value.digest) || !record(plan) || !onlyFields(plan, [
		"settingsPath",
		"ops",
		"expectedRevision",
		"expectedUserDigest",
		"requestDigest",
		"credential"
	]) || !strings(plan.settingsPath) || !pathOps(plan.ops) || typeof plan.expectedRevision !== "number" || !Number.isSafeInteger(plan.expectedRevision) || plan.expectedRevision < 0) return fail("provider-transaction-in-doubt", "provider journal identity or plan is invalid");
	if (legacy && plan.expectedUserDigest !== void 0) return fail("provider-transaction-in-doubt", "legacy provider plan cannot assert a current before-image");
	try {
		settingsNamespace(value.settingsNs);
	} catch {
		return fail("provider-transaction-in-doubt", "provider journal namespace is invalid");
	}
	for (const field of ["expectedUserDigest", "requestDigest"]) if (plan[field] !== void 0 && (typeof plan[field] !== "string" || !SHA256.test(plan[field]))) return fail("provider-transaction-in-doubt", "provider plan binding is invalid");
	let credential;
	if (plan.credential !== void 0) {
		const data = plan.credential;
		if (!record(data) || !onlyFields(data, data.op === "set" ? [
			"op",
			"ref",
			"valueDigest",
			"before"
		] : [
			"op",
			"ref",
			"before"
		]) || typeof data.ref !== "string") return fail("provider-transaction-in-doubt", "provider credential plan is invalid");
		try {
			credentialRef(data.ref);
		} catch {
			return fail("provider-transaction-in-doubt", "provider credential reference is invalid");
		}
		if (data.op === "unset") credential = {
			op: "unset",
			ref: data.ref
		};
		else if (data.op === "set" && typeof data.valueDigest === "string" && SHA256.test(data.valueDigest)) credential = {
			op: "set",
			ref: data.ref,
			valueDigest: data.valueDigest
		};
		else return fail("provider-transaction-in-doubt", "provider credential plan is invalid");
		if (data.before !== void 0) {
			const before = data.before;
			if (legacy || !record(before) || !onlyFields(before, ["valueDigest", "source"]) || before.valueDigest !== null && (typeof before.valueDigest !== "string" || !SHA256.test(before.valueDigest)) || before.source !== void 0 && (typeof before.source !== "string" || before.source.length === 0) || before.valueDigest === null && before.source !== void 0) return fail("provider-transaction-in-doubt", "provider credential before-image is invalid");
			credential.before = {
				valueDigest: before.valueDigest,
				...before.source === void 0 ? {} : { source: before.source }
			};
		}
	}
	if (!isPhase(value.phase)) return fail("provider-transaction-in-doubt", "provider journal phase is invalid");
	const parsedPlan = {
		settingsPath: plan.settingsPath,
		ops: plan.ops,
		expectedRevision: plan.expectedRevision,
		...typeof plan.expectedUserDigest === "string" ? { expectedUserDigest: plan.expectedUserDigest } : {},
		...typeof plan.requestDigest === "string" ? { requestDigest: plan.requestDigest } : {},
		...credential === void 0 ? {} : { credential }
	};
	if (!deepEqualJson(plan.ops, canonicalOps(plan.ops))) return fail("provider-transaction-in-doubt", "provider plan contains unsupported operation fields");
	const ops = parsedPlan.ops;
	if (ops.length === 0 && credential === void 0) return fail("provider-transaction-in-doubt", "provider plan contains no operation");
	if (ops.length > 64 || ops.some((op, index) => ops.some((other, otherIndex) => index !== otherIndex && prefix(op.path, other.path)))) return fail("provider-transaction-in-doubt", "provider plan operations overlap or exceed the limit");
	if ((legacy ? legacyPlanDigest(value.provider, value.settingsNs, parsedPlan) : planDigest(value.provider, value.settingsNs, parsedPlan)) !== value.digest) return fail("provider-transaction-in-doubt", "provider journal digest does not match its plan");
	const legacyInput = legacy ? {
		settingsPath: [...parsedPlan.settingsPath],
		digest: parsedPlan.requestDigest ?? legacyPlanDigest(value.provider, value.settingsNs, parsedPlan)
	} : parseLegacyInput(value.legacyInput);
	const requestDigest = legacy ? plannedInputDigest(value.provider, value.settingsNs, parsedPlan) : value.requestDigest;
	if (typeof requestDigest !== "string" || !SHA256.test(requestDigest)) return fail("provider-transaction-in-doubt", "provider request binding is invalid");
	const completed = {};
	if (!legacy) {
		if (!record(value.completed)) return fail("provider-transaction-in-doubt", "provider receipt history is invalid");
		for (const [id, item] of Object.entries(value.completed)) {
			if (!UUID.test(id)) return fail("provider-transaction-in-doubt", "provider receipt history is invalid");
			completed[id] = parseReceipt(item);
		}
	} else if (value.completed !== void 0 || value.requestDigest !== void 0 || value.legacyInput !== void 0) return fail("provider-transaction-in-doubt", "provider journal mixes incompatible formats");
	const error = value.error === void 0 && legacy && value.phase === "done" && value.outcome !== "committed" ? value.outcome === "committed-not-live" ? {
		code: "provider-registration-rejected",
		message: "provider settings were stored but did not activate",
		details: { provider: value.provider }
	} : {
		code: "settings-rejected",
		message: "provider settings write was rejected",
		details: { ns: value.settingsNs }
	} : storedFailure(value.error);
	const identity = {
		version: 1,
		receiptVersion: 1,
		transactionId: value.transactionId,
		provider: value.provider,
		settingsNs: value.settingsNs,
		requestDigest,
		digest: planDigest(value.provider, value.settingsNs, parsedPlan),
		plan: parsedPlan,
		...legacyInput === void 0 ? {} : { legacyInput },
		completed
	};
	if (value.phase === "done") {
		const receipt = parseReceipt({
			requestDigest,
			outcome: value.outcome,
			error,
			legacyInput
		});
		if (legacy) completed[value.transactionId] = receipt;
		if (!deepEqualJson(completed[value.transactionId], receipt)) return fail("provider-transaction-in-doubt", "provider terminal receipt disagrees with its history");
		return {
			...identity,
			...receipt,
			phase: value.phase
		};
	}
	if (value.outcome !== void 0 || error !== void 0 || Object.hasOwn(completed, value.transactionId)) return fail("provider-transaction-in-doubt", "unfinished provider transaction has a terminal receipt");
	return {
		...identity,
		phase: value.phase
	};
}
/** Each runtime drains its accepted work; shared service identities own resource serialization. */
var ProviderTransactions = class {
	ctx;
	runtime;
	pending = /* @__PURE__ */ new Set();
	stopped = false;
	constructor(ctx, runtime) {
		this.ctx = ctx;
		this.runtime = runtime;
		ctx.effect(() => async () => {
			this.stopped = true;
			await Promise.allSettled(this.pending);
		}, "llm.provider-transactions");
	}
	/**
	* Serialize shared configuration resources; unrelated namespaces and ordinary streaming remain independent.
	* @param input - Native request, snapshotted before waiting for the previous write.
	* @param signal - cancellation before durable claim; committed work retains ownership.
	* @returns the redacted committed state, or a typed recovery failure.
	*/
	async mutate(input, signal) {
		const request = requestSnapshot(input);
		return this.run(request.provider, signal, (settings, credentials) => withResources(settings, [request.settingsNs], () => this.execute(settings, credentials, request, signal)));
	}
	/**
	* Read the stored phase without claiming, upgrading, or executing the transaction.
	* @param input - provider and caller-held transaction id.
	* @returns durable state and write-only credential requirement, never the plan or value.
	*/
	async status(input) {
		const request = transactionIdentity(input);
		return this.track(() => this.query(request));
	}
	async query(request) {
		const credentials = this.ctx.get("credentials");
		if (credentials === void 0) return fail("service-unavailable", "provider transaction journal is unavailable");
		const { journal } = await this.read(credentials, request.provider);
		if (journal === void 0) return {
			state: "absent",
			needsCredential: false
		};
		const current = journal.transactionId === request.transactionId;
		const receipt = journal.completed[request.transactionId];
		let state;
		if (current) state = journal.phase === "done" ? journal.outcome : journal.phase;
		else {
			if (receipt === void 0) return {
				state: "absent",
				needsCredential: false
			};
			state = receipt.outcome;
		}
		let needsCredential = false;
		if (current && journal.phase !== "done" && journal.plan.credential?.op === "set") {
			const resolved = await this.resolveCredential(credentials, journal.plan.credential.ref);
			needsCredential = resolved === void 0 || hash(resolved.value) !== journal.plan.credential.valueDigest;
		}
		return {
			state,
			needsCredential,
			settingsNs: journal.settingsNs,
			...isOutcome(state) ? { live: current && state === "committed" && this.runtime.listProviders().some((provider) => provider.id === request.provider) } : {}
		};
	}
	/**
	* Continue the captured durable plan under the same journal, namespace and reference leases as new writes.
	* @param input - stored transaction identity and an optional write-only missing credential.
	* @param signal - cancellation before claim only; claimed work remains owned until settlement.
	* @returns the committed redacted state, or the durable terminal/recovery failure.
	*/
	async resume(input, signal) {
		const request = transactionIdentity(input);
		const value = snapshot(input);
		if (!record(value) || value.credentialValue !== void 0 && (typeof value.credentialValue !== "string" || value.credentialValue.trim() === "")) return fail("input-invalid", "provider recovery credential must be a non-empty string");
		const supplied = value.credentialValue;
		return this.run(request.provider, signal, async (settings, credentials) => {
			const captured = await this.read(credentials, request.provider);
			const journal = captured.journal;
			if (journal === void 0 || journal.transactionId !== request.transactionId && journal.completed[request.transactionId] === void 0) return fail("provider-transaction-in-doubt", "the requested provider transaction is not retained");
			return withResources(settings, [journal.settingsNs], async () => {
				let credential;
				const user = settings.describe().find((entry) => entry.ns === journal.settingsNs)?.user;
				const unverifiableWrite = (journal.phase === "prepared" || journal.phase === "credential-staged") && !satisfied(user, journal.plan.ops) && journal.plan.expectedUserDigest === void 0;
				if (journal.phase !== "done" && journal.transactionId === request.transactionId && !unverifiableWrite) {
					const planned = journal.plan.credential;
					if (planned?.op === "unset") credential = {
						op: "unset",
						ref: planned.ref
					};
					else if (planned?.op === "set") {
						const stored = await this.resolveCredential(credentials, planned.ref);
						const secret = supplied ?? stored?.value;
						if (secret === void 0 || hash(secret) !== planned.valueDigest) return fail("provider-transaction-needs-credential", "transaction needs its write-only credential again", {
							provider: request.provider,
							transactionId: request.transactionId,
							ref: planned.ref
						});
						credential = {
							op: "set",
							ref: planned.ref,
							value: secret
						};
					}
				}
				return this.execute(settings, credentials, {
					...request,
					settingsNs: journal.settingsNs,
					ops: journal.plan.ops,
					expectedRevision: journal.plan.expectedRevision,
					...credential === void 0 ? {} : { credential }
				}, signal, {
					...captured,
					journal
				});
			});
		});
	}
	async run(provider, signal, action) {
		if (this.stopped) return fail("service-unavailable", "provider transaction owner is stopped");
		if (execution.getStore()?.active) return fail("provider-transaction-reentrant", "provider mutation cannot be nested in a running transaction");
		if (signal.aborted) return fail("cancelled", "provider transaction was cancelled before durable claim");
		const settings = this.ctx.get("settings");
		const credentials = this.ctx.get("credentials");
		if (settings === void 0 || credentials === void 0) return fail("service-unavailable", "provider mutation requires settings and credentials owners");
		return this.track(() => withResources(credentials, [`journal:${provider}`], async () => {
			if (this.stopped) return fail("service-unavailable", "provider transaction owner is stopped");
			if (signal.aborted) return fail("cancelled", "provider transaction was cancelled before durable claim");
			const scope = { active: true };
			try {
				return await execution.run(scope, () => action(settings, credentials));
			} finally {
				scope.active = false;
			}
		}));
	}
	async track(operation) {
		if (this.stopped) return fail("service-unavailable", "provider transaction owner is stopped");
		const pending = operation();
		this.pending.add(pending);
		try {
			return await pending;
		} finally {
			this.pending.delete(pending);
		}
	}
	async execute(settings, credentials, request, signal, restoring) {
		const namespace = settingsNamespace(request.settingsNs);
		const captured = restoring ?? await this.read(credentials, request.provider);
		const previous = captured.journal;
		const before = settings.describe().find((entry) => entry.ns === namespace);
		let declaration = this.runtime.listConfigurableProviders().find((entry) => entry.provider === request.provider && entry.settingsNs === request.settingsNs);
		if (declaration === void 0 && before !== void 0 && previous !== void 0 && previous.transactionId === request.transactionId && previous.settingsNs === request.settingsNs && previous.plan.settingsPath.length > 0 && previous.plan.credential?.op !== "set" && previous.plan.ops.some((op) => op.op === "unset" && deepEqualJson(op.path, previous.plan.settingsPath)) && satisfied(before.user, previous.plan.ops) && !pathValue(before.value, previous.plan.settingsPath).present && !this.runtime.listConfigurableProviders().some((entry) => entry.settingsNs === request.settingsNs && (prefix(entry.settingsPath, previous.plan.settingsPath) || prefix(previous.plan.settingsPath, entry.settingsPath)))) declaration = {
			provider: previous.provider,
			settingsNs: previous.settingsNs,
			settingsPath: previous.plan.settingsPath
		};
		if (declaration === void 0) return fail("settings-rejected", "provider does not own the requested settings namespace");
		const digest = restoring === void 0 ? inputDigest(request) : restoring.journal.requestDigest;
		if (previous !== void 0 && previous.transactionId !== request.transactionId && previous.phase !== "done") return fail("provider-transaction-in-doubt", "provider has an unfinished configuration transaction");
		if (previous !== void 0) {
			const receipt = previous.completed[request.transactionId];
			if (receipt !== void 0) {
				if (restoring === void 0 && !this.matches(receipt, request)) return fail("provider-transaction-in-doubt", "transaction id was reused with different input");
				await this.claim(credentials, captured, previous, signal);
				this.checkReceipt(receipt);
				return this.result(settings, credentials, request, declaration.settingsPath, void 0);
			}
		}
		if (previous?.transactionId === request.transactionId && restoring === void 0 && !this.matches(previous, request)) return fail("provider-transaction-in-doubt", "transaction id was reused with different input");
		if (before === void 0) return fail("settings-rejected", "provider settings namespace is not registered");
		const replay = previous?.transactionId === request.transactionId ? previous : void 0;
		const configured = request.credential?.op === "set" && (await credentials.describe(ref(request.credential.ref))).configured;
		const plan = replay?.plan ?? {
			...makePlan(declaration, before.value, request, configured),
			expectedUserDigest: hashJson({ user: before.user })
		};
		if (!deepEqualJson(plan.settingsPath, declaration.settingsPath)) return fail("provider-transaction-in-doubt", "provider profile ownership changed during recovery");
		return withResources(credentials, [
			...references(before.value, plan.settingsPath).keys(),
			...references(apply(before.value, plan.ops), plan.settingsPath).keys(),
			...request.credential === void 0 ? [] : [request.credential.ref],
			...plan.credential === void 0 ? [] : [plan.credential.ref]
		].map((ref) => `reference:${ref}`), async () => {
			if (replay === void 0) {
				if (before.revision !== request.expectedRevision) return this.conflict(request.settingsNs, request.expectedRevision, before.revision);
				if (plan.credential !== void 0) plan.credential.before = credentialCondition(await this.resolveCredential(credentials, plan.credential.ref));
			}
			this.preflight(settings, declaration, before.value, plan, request, replay !== void 0 && satisfied(before.user, plan.ops));
			if (plan.credential !== void 0 && !(await credentials.describe(ref(plan.credential.ref))).writable) return fail("credential-rejected", "provider credential is read-only");
			if (signal.aborted) return fail("cancelled", "provider transaction was cancelled before durable claim");
			let journal = replay ?? {
				version: 1,
				receiptVersion: 1,
				transactionId: request.transactionId,
				provider: request.provider,
				settingsNs: request.settingsNs,
				requestDigest: digest,
				digest: planDigest(request.provider, request.settingsNs, plan),
				plan,
				phase: "prepared",
				completed: { ...previous?.completed }
			};
			await this.claim(credentials, captured, journal, signal);
			const advance = async (phase) => {
				const next = {
					...journal,
					phase
				};
				await this.write(credentials, journal, next);
				journal = next;
			};
			const finish = async (...result) => {
				const [outcome, error] = result;
				const identity = {
					requestDigest: journal.requestDigest,
					...journal.legacyInput === void 0 ? {} : { legacyInput: journal.legacyInput }
				};
				const receipt = outcome === "committed" ? {
					...identity,
					outcome
				} : {
					...identity,
					outcome,
					error
				};
				const next = {
					...journal,
					...receipt,
					phase: "done",
					completed: {
						...journal.completed,
						[request.transactionId]: receipt
					}
				};
				const condition = outcome === "committed" && plan.credential !== void 0 ? {
					ref: ref(plan.credential.ref),
					expected: { valueDigest: plan.credential.op === "set" ? plan.credential.valueDigest : null }
				} : void 0;
				await this.write(credentials, journal, next, condition);
				journal = next;
			};
			const rollback = async (failure) => {
				if (plan.credential?.op === "set" && plan.credential.before?.valueDigest === null) try {
					await credentials.unset(ref(plan.credential.ref), { valueDigest: plan.credential.valueDigest });
				} catch (error) {
					if (!(error instanceof CredentialConflictError)) return fail("provider-transaction-in-doubt", "staged credential rollback did not complete");
				}
				await finish("rolled-back", failure);
				throw new TypertRemoteFailure(failure);
			};
			const credentialConflict = async () => {
				const failure = {
					code: "credential-rejected",
					message: "provider credential changed before commit",
					details: { provider: request.provider }
				};
				await finish("committed-not-live", failure);
				throw new TypertRemoteFailure(failure);
			};
			if (replay !== void 0 && (journal.phase === "prepared" || journal.phase === "credential-staged") && !satisfied(before.user, plan.ops) && (plan.expectedUserDigest === void 0 || plan.expectedUserDigest !== hashJson({ user: before.user }))) return rollback(this.settingsFailure(request.settingsNs, /* @__PURE__ */ new Error("provider settings changed after claim")));
			if (journal.phase === "prepared") {
				if (plan.credential?.op === "set") await this.applyCredential(credentials, plan.credential, request.credential);
				await advance("credential-staged");
			}
			if (journal.phase === "credential-staged") {
				const current = settings.describe().find((entry) => entry.ns === namespace);
				if (current === void 0) return fail("provider-transaction-in-doubt", "provider settings owner disappeared");
				if (!satisfied(current.user, plan.ops)) {
					const revision = plan.expectedUserDigest !== void 0 && plan.expectedUserDigest === hashJson({ user: current.user }) ? current.revision : plan.expectedRevision;
					try {
						await settings.mutate(namespace, plan.ops, revision);
					} catch (error) {
						const after = settings.describe().find((entry) => entry.ns === namespace);
						if (after === void 0 || !satisfied(after.user, plan.ops)) return rollback(this.settingsFailure(request.settingsNs, error));
					}
				}
				await advance("settings-applied");
			}
			const committed = settings.describe().find((entry) => entry.ns === namespace);
			if (committed === void 0) return fail("provider-transaction-in-doubt", "provider settings disappeared after persistence");
			if (!satisfied(committed.user, plan.ops)) return fail("provider-transaction-in-doubt", "provider settings no longer match the committed plan");
			let accepted;
			try {
				accepted = await settings.settle(namespace, committed.revision);
			} catch (error) {
				const failure = this.settingsFailure(request.settingsNs, error);
				await finish("committed-not-live", failure);
				throw new TypertRemoteFailure(failure);
			}
			const expectedLive = plan.settingsPath.length === 0 || pathValue(committed.value, plan.settingsPath).present;
			if (!accepted || this.runtime.listProviders().some((provider) => provider.id === request.provider) !== expectedLive) {
				const failure = {
					code: "provider-registration-rejected",
					message: "provider settings were stored but did not activate",
					details: { provider: request.provider }
				};
				await finish("committed-not-live", failure);
				throw new TypertRemoteFailure(failure);
			}
			if (journal.phase === "settings-applied") {
				if (plan.credential?.op === "unset") try {
					await this.applyCredential(credentials, plan.credential, request.credential);
				} catch (error) {
					if (error instanceof CredentialConflictError) return credentialConflict();
					throw error;
				}
				await advance("credential-applied");
			}
			try {
				await finish("committed");
			} catch (error) {
				if (error instanceof CredentialConflictError) return credentialConflict();
				throw error;
			}
			return this.result(settings, credentials, request, plan.settingsPath, plan.credential?.ref);
		});
	}
	checkReceipt(receipt) {
		if (receipt.outcome !== "committed") throw new TypertRemoteFailure(receipt.error);
	}
	matches(receipt, request) {
		if (receipt.requestDigest === inputDigest(request)) return true;
		if (receipt.legacyInput === void 0) return false;
		const credential = request.credential === void 0 ? void 0 : request.credential.op === "unset" ? {
			op: "unset",
			ref: request.credential.ref
		} : {
			op: "set",
			ref: request.credential.ref,
			valueDigest: hash(request.credential.value)
		};
		return legacyPlanDigest(request.provider, request.settingsNs, {
			settingsPath: receipt.legacyInput.settingsPath,
			ops: [...request.ops],
			expectedRevision: request.expectedRevision,
			...credential === void 0 ? {} : { credential }
		}) === receipt.legacyInput.digest;
	}
	async read(credentials, provider) {
		try {
			const stored = structuredClone(await credentials.readRecord(credentialKey("llm-remote", provider)));
			const journal = parseJournal(stored);
			if (journal !== void 0 && journal.provider !== provider) return fail("provider-transaction-in-doubt", "provider journal ownership is invalid");
			return {
				stored,
				journal
			};
		} catch (error) {
			if (error instanceof TypertRemoteFailure) throw error;
			return fail("service-unavailable", "provider transaction journal is unavailable");
		}
	}
	async claim(credentials, captured, next, signal) {
		try {
			await credentials.modifyRecord(credentialKey("llm-remote", next.provider), (current) => {
				if (signal.aborted) return fail("cancelled", "provider transaction was cancelled before durable claim");
				if (!deepEqualJson(current, captured.stored)) return fail("provider-transaction-in-doubt", "provider transaction ownership changed before claim");
				const proposed = {
					kind: "grant",
					payload: next
				};
				return Promise.resolve(deepEqualJson(current, proposed) ? void 0 : proposed);
			});
		} catch (error) {
			if (error instanceof TypertRemoteFailure) throw error;
			return fail("provider-transaction-in-doubt", "provider journal claim failed");
		}
	}
	async resolveCredential(credentials, reference) {
		try {
			return await credentials.resolve(ref(reference));
		} catch {
			return fail("service-unavailable", "provider credential is unavailable");
		}
	}
	preflight(settings, declaration, before, plan, request, settingsAlreadyApplied) {
		for (const op of plan.ops) if (!prefix(op.path, declaration.settingsPath)) return fail("settings-rejected", "provider cannot mutate a sibling profile");
		const next = apply(before, plan.ops);
		const beforeRefs = references(before, declaration.settingsPath);
		const afterRefs = references(next, declaration.settingsPath);
		if (plan.credential?.op === "set" && !afterRefs.has(plan.credential.ref)) return fail("credential-rejected", "credential is not bound to the resulting profile");
		if (plan.credential?.op === "unset" && (!settingsAlreadyApplied && !beforeRefs.has(plan.credential.ref) || afterRefs.has(plan.credential.ref))) return fail("credential-rejected", "cannot remove an unrelated or still-referenced credential");
		const values = new Map(settings.describe().map((entry) => [String(entry.ns), entry.value]));
		const uses = this.runtime.listConfigurableProviders().flatMap((entry) => [...references(values.get(entry.settingsNs), entry.settingsPath).keys()].map((ref) => ({
			ref,
			provider: entry.provider,
			fingerprint: fingerprint(entry, values.get(entry.settingsNs))
		})));
		if (request.credential !== void 0 && uses.some((use) => use.ref === request.credential?.ref && use.provider !== request.provider)) return fail("credential-ownership-rejected", "requested credential belongs to another provider");
		for (const ref of afterRefs.keys()) {
			const conflicts = uses.filter((use) => use.ref === ref && (use.provider !== declaration.provider || use.fingerprint !== fingerprint(declaration, next)));
			if (conflicts.some((use) => use.provider !== declaration.provider) || conflicts.length > 0 && plan.credential?.ref !== ref) return fail("credential-ownership-rejected", "credential belongs to another provider or endpoint");
			if (!uses.some((use) => use.ref === ref && use.provider === declaration.provider && use.fingerprint === fingerprint(declaration, next)) && !(plan.credential?.op === "set" && plan.credential.ref === ref)) return fail("credential-ownership-required", "a new endpoint reference requires an explicit credential value");
		}
		if (plan.credential?.op === "unset" && uses.some((use) => use.ref === plan.credential?.ref && use.provider !== declaration.provider)) return fail("credential-ownership-rejected", "credential is still owned by another provider");
		try {
			const secrets = settings.previewMutation(settingsNamespace(request.settingsNs), plan.ops).secrets;
			if (plan.ops.some((op) => op.op === "set" && secrets.some((secret) => prefix(op.path, secret.path) || prefix(secret.path, op.path) && pathValue(op.value, secret.path.slice(op.path.length)).present))) return fail("settings-rejected", "provider settings transactions cannot carry literal secret fields");
		} catch (error) {
			if (error instanceof TypertRemoteFailure) throw error;
			throw new TypertRemoteFailure(this.settingsFailure(request.settingsNs, error));
		}
	}
	async write(credentials, expected, next, condition) {
		try {
			await credentials.modifyRecord(credentialKey("llm-remote", next.provider), (current) => {
				if (!deepEqualJson(parseJournal(current), expected)) return fail("provider-transaction-in-doubt", "provider journal ownership changed during commit");
				return Promise.resolve({
					kind: "grant",
					payload: next
				});
			}, condition === void 0 ? [] : [condition]);
		} catch (error) {
			if (error instanceof TypertRemoteFailure || error instanceof CredentialConflictError) throw error;
			return fail("provider-transaction-in-doubt", "provider transaction progress could not be persisted");
		}
	}
	async applyCredential(credentials, plan, supplied) {
		const reference = ref(plan.ref);
		const current = await credentials.resolve(reference);
		if (plan.op === "unset") {
			if (current === void 0) return;
			if (plan.before === void 0) return fail("provider-transaction-in-doubt", "credential removal has no durable before-image");
			try {
				await credentials.unset(reference, plan.before);
			} catch (error) {
				if (error instanceof CredentialConflictError) throw error;
				if (await credentials.resolve(reference) !== void 0) return fail("provider-transaction-in-doubt", "credential removal did not complete");
			}
			return;
		}
		if (current !== void 0 && hash(current.value) === plan.valueDigest) return;
		if (current !== void 0) return fail("provider-transaction-in-doubt", "the staged credential reference now holds a different value");
		if (supplied?.op !== "set" || hash(supplied.value) !== plan.valueDigest) return fail("provider-transaction-needs-credential", "transaction needs its write-only credential again");
		try {
			await credentials.set(reference, supplied.value, { valueDigest: null });
		} catch {
			const after = await credentials.resolve(reference);
			if (after === void 0 || hash(after.value) !== plan.valueDigest) return fail("provider-transaction-in-doubt", "credential staging did not complete");
		}
	}
	conflict(ns, expected, actual) {
		return fail("settings-conflict", "provider settings revision changed", {
			ns,
			expected,
			actual
		});
	}
	settingsFailure(ns, error) {
		return error instanceof SettingsConflictError ? {
			code: "settings-conflict",
			message: "provider settings revision changed",
			details: {
				ns,
				expected: error.expected,
				actual: error.actual
			}
		} : {
			code: "settings-rejected",
			message: "provider settings write was rejected",
			details: { ns }
		};
	}
	async result(settings, credentials, request, settingsPath, credentialRef) {
		const descriptor = settings.describe({ redactSecrets: true }).find((entry) => entry.ns === request.settingsNs);
		if (descriptor === void 0) return fail("provider-registration-rejected", "committed provider settings are unavailable");
		const expectedLive = settingsPath.length === 0 || pathValue(descriptor.value, settingsPath).present;
		if (this.runtime.listProviders().some((entry) => entry.id === request.provider) !== expectedLive) return fail("provider-registration-rejected", "committed provider route does not match its settings");
		const info = credentialRef === void 0 ? void 0 : await credentials.describe(ref(credentialRef));
		return {
			settings: remoteNamespaceView(descriptor),
			...info === void 0 ? {} : { credential: {
				configured: info.configured,
				writable: info.writable,
				...info.source === void 0 ? {} : { source: info.source }
			} },
			live: { accepted: true }
		};
	}
};
//#endregion
//#region lib/types/attribution.js
/**
* Centralize the non-secret product identity every provider request sends as `User-Agent`, keeping
* adapters from drifting. See
* `.agents/notes/implemented/architecture/2026-06-21-mandatory-app-attribution-headers.md`.
*
* App-attribution vocabulary for provider requests.
* @module @deepseek-ai/dsh-llm/attribution
*/
const { version } = createRequire(import.meta.url)("../package.json");
/**
* The harness's own identity: the default every adapter sends. Deployments
* that need a white-label identity pass their own {@link AppIdentity} to
* {@link attributionHeaders} — omission falls back to this default; nothing
* can suppress attribution entirely.
*/
const APP_IDENTITY = {
	product: "deepseek-harness",
	version,
	url: "https://github.com/deepseek-ai/deepseek-harness"
};
/**
* The standard `User-Agent` value: `product/version (+url)`. The
* parenthesized `+url` comment is the conventional self-identification form
* (RFC 9110 §10.1.5 product + comment syntax).
* @param identity - the identity to render; defaults to {@link APP_IDENTITY}.
* @returns the ready-to-send header value.
*/
function userAgent(identity = APP_IDENTITY) {
	return `${identity.product}/${identity.version} (+${identity.url})`;
}
/**
* Build the attribution headers an adapter must send on every provider
* request. Header names are lowercase (HTTP field names are case-insensitive
* on the wire).
* @param identity - the identity to send; defaults to {@link APP_IDENTITY} — omission cannot suppress attribution.
* @returns headers to merge into the provider request (currently just `user-agent`).
*/
function attributionHeaders(identity = APP_IDENTITY) {
	return { "user-agent": userAgent(identity) };
}
//#endregion
//#region lib/types/assembler.js
/**
* Incremental chunk-to-message assembler. This is the single canonical assembly
* algorithm used by the agent loop to build an assistant message from a chunk
* stream while logging the raw chunks for replay fidelity.
*
* @module @deepseek-ai/dsh-llm/assembler
*/
/**
* Incrementally assembles raw {@link StreamChunk}s into complete
* {@link ContentBlock}s and a final assistant {@link Message}.
*
* The agent loop feeds it while logging raw chunks for replay fidelity, then
* reads `blocks()` / `message()` / `usage` / `finish` once the stream ends,
* or `interruptedBlocks()` when cancellation cut the stream short.
*
* Tolerant of delta-only protocols (no block-start/end); deltas arriving for
* an index already closed by `block-end` are ignored (malformed stream) so a
* misbehaving adapter cannot grow memory or corrupt a completed block.
*/
var BlockAssembler = class {
	partials = /* @__PURE__ */ new Map();
	order = [];
	_usage;
	_finish;
	_replayState;
	/**
	* Feed one chunk into the assembly state.
	* @param chunk - the next raw chunk, in stream order.
	*/
	push(chunk) {
		switch (chunk.type) {
			case "block-start":
				if (!this.partials.has(chunk.index)) {
					this.order.push(chunk.index);
					this.partials.set(chunk.index, {
						blockType: chunk.blockType,
						text: "",
						toolCallArguments: ""
					});
				}
				return;
			case "text-delta":
			case "reasoning-delta": {
				const partial = this.ensure(chunk.index, chunk.type === "text-delta" ? "text" : "reasoning");
				if (partial.block) return;
				partial.text += chunk.text;
				return;
			}
			case "tool-call-delta": {
				const partial = this.ensure(chunk.index, "tool-call");
				if (partial.block) return;
				partial.toolCallId = chunk.id;
				if (chunk.name) partial.toolCallName = chunk.name;
				partial.toolCallArguments += chunk.argumentsDelta;
				return;
			}
			case "block-end": {
				const partial = this.ensure(chunk.index, chunk.block.type);
				if (partial.block) return;
				partial.block = chunk.block;
				return;
			}
			case "usage":
				this._usage = chunk.usage;
				return;
			case "finish":
				this._finish = chunk.reason;
				this._replayState = chunk.replayState;
				return;
			default: return assertNever(chunk, "BlockAssembler.push");
		}
	}
	ensure(index, blockType) {
		let partial = this.partials.get(index);
		if (!partial) {
			partial = {
				blockType,
				text: "",
				toolCallArguments: ""
			};
			this.partials.set(index, partial);
			this.order.push(index);
		}
		return partial;
	}
	assemble(partial, index) {
		if (partial.block) return partial.block;
		switch (partial.blockType) {
			case "text": return {
				type: "text",
				text: partial.text
			};
			case "reasoning": return {
				type: "reasoning",
				text: partial.text
			};
			case "tool-call": return {
				type: "tool-call",
				id: partial.toolCallId ?? CallId(`call-${index}`),
				name: partial.toolCallName ?? "",
				arguments: partial.toolCallArguments
			};
			default: throw new Error(`cannot assemble incomplete block of type "${partial.blockType}"`);
		}
	}
	/** Invariant accessor: every index in `order` has a partial. */
	mustGet(index) {
		const partial = this.partials.get(index);
		if (!partial) throw new Error(`BlockAssembler invariant violated: no partial for index ${index}`);
		return partial;
	}
	/**
	* The one shared keep/drop decision over all seen blocks: max-token
	* truncation drops tool calls that cannot be executed safely. Emitted blocks
	* and replay metadata both derive from this result, so they cannot disagree.
	*/
	assembled() {
		const all = this.order.map((index) => this.assemble(this.mustGet(index), index));
		const kept = this.finish.kind === "max-tokens" ? all.map((block) => block.type !== "tool-call") : void 0;
		const blocks = kept === void 0 ? all : all.filter((_, position) => kept[position]);
		const envelope = this._replayState;
		if (envelope?.blocks === void 0) return {
			blocks,
			replay: envelope
		};
		if (envelope.blocks.length !== all.length) return {
			blocks,
			replay: void 0
		};
		return {
			blocks,
			replay: kept === void 0 || blocks.length === all.length ? envelope : {
				response: envelope.response,
				blocks: envelope.blocks.filter((_, position) => kept[position])
			}
		};
	}
	/**
	* Assemble all blocks seen so far, in stream order.
	* @returns one block per seen index, except that max-token truncation drops
	*   tool calls that cannot be executed safely; an open block assembles from
	*   its accumulated deltas (an unknown block type never closed by `block-end` throws).
	*/
	blocks() {
		return this.assembled().blocks;
	}
	/**
	* Assemble the prefix an interrupted stream can safely finalize: closed and
	* open text/reasoning blocks with non-whitespace content, in stream order.
	* Tool calls are omitted because interruption precedes dispatch; retaining
	* one would require a fabricated result. Open unknown blocks are also omitted.
	* @returns the kept blocks; empty when nothing streamed before the interruption.
	*/
	interruptedBlocks() {
		return this.order.map((index) => {
			const partial = this.mustGet(index);
			const type = partial.block?.type ?? partial.blockType;
			if (type !== "text" && type !== "reasoning") return void 0;
			return this.assemble(partial, index);
		}).filter((block) => (block?.type === "text" || block?.type === "reasoning") && block.text.trim() !== "");
	}
	/** Usage from the `usage` chunk; undefined until one arrives. */
	get usage() {
		return this._usage;
	}
	/** Finish reason from the `finish` chunk; `{kind: 'stop'}` when the stream ended without one. */
	get finish() {
		return this._finish ?? { kind: "stop" };
	}
	/**
	* Replay metadata from the terminal finish chunk, if any, with per-block
	* entries pruned in step with {@link blocks}. Undefined when the envelope's
	* entries do not align with the emitted blocks.
	*/
	get replayState() {
		return this.assembled().replay;
	}
	/**
	* The assembled assistant message.
	* @param source - producer attribution for the assembled message.
	* @returns a frozen assistant-role message over `blocks()` (same open-block assembly rules).
	*/
	message(source = {
		kind: "plugin",
		plugin: "dsh-llm/assembler"
	}) {
		return createMessage({
			role: "assistant",
			content: this.blocks(),
			source
		});
	}
};
//#endregion
//#region lib/types/index.js
/**
* LLM service: adapter registry with a waterfall-interceptable streaming call
* API. Exports the `LlmRuntime` default, the abstract `LlmAdapter` for
* provider backends, and `BlockAssembler` for chunk assembly.
*
* @module @deepseek-ai/dsh-llm
*/
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
/**
* Typed error for LLM-related failures. Extends {@link HarnessError}, so the
* `code` string (e.g. `AUTH`, `RATE_LIMIT`, `NO_ADAPTER`) is shared taxonomy.
*/
var LlmError = class extends HarnessError {
	/** Serializable facts retained beside this live Error. */
	failure;
	/**
	* @param message - non-empty human-readable failure summary.
	* @param code - non-empty stable provider-neutral machine code.
	* @param options - optional cause and validated serializable provider facts.
	*/
	constructor(message, code, options) {
		if (typeof message !== "string" || message.length === 0) throw new Error("LlmError message must be a non-empty string");
		if (typeof code !== "string" || code.length === 0) throw new Error("LlmError code must be a non-empty string");
		if (options?.status !== void 0 && (!Number.isInteger(options.status) || options.status < 100 || options.status > 599)) throw new Error("LlmError status must be an integer from 100 through 599");
		if (options?.providerRetryAfterMs !== void 0 && (!Number.isFinite(options.providerRetryAfterMs) || options.providerRetryAfterMs <= 0)) throw new Error("LlmError providerRetryAfterMs must be a positive finite number");
		if (options?.requestId !== void 0 && (typeof options.requestId !== "string" || options.requestId.length === 0)) throw new Error("LlmError requestId must be a non-empty string");
		super(message, code, options);
		this.name = "LlmError";
		this.failure = Object.freeze({
			message,
			code,
			...options?.status === void 0 ? {} : { status: options.status },
			...options?.providerRetryAfterMs === void 0 ? {} : { providerRetryAfterMs: options.providerRetryAfterMs },
			...options?.requestId === void 0 ? {} : { requestId: options.requestId }
		});
	}
};
/**
* Accept one supplied credential, or refuse it as unusable.
*
* A stored key arrives from the credentials seam, a `.env` line, or a shell
* export, all of which pick up surrounding whitespace, so trimming is silent.
* Anything else fails here rather than inside `fetch`, whose ByteString
* refusal names a UTF-16 code point instead of the setting to change. The key
* never enters the message: `ref` names where to fix it, and echoing any part
* of a secret into a log or a UI is the failure this diagnosis avoids.
*
* Lives beside {@link LlmError} rather than in `./api-key.ts` so the predicate
* module stays dependency-free; both adapters share this one diagnosis instead
* of keeping near-identical local copies.
* @param raw - the credential exactly as supplied.
* @param pkg - the refusing package name, prefixed to the diagnostic.
* @param ref - the credential reference the value resolved through.
* @returns the trimmed, usable key.
*/
function assertUsableApiKey(raw, pkg, ref) {
	const checked = normalizeApiKey(raw);
	if (checked.ok) return checked.value;
	throw new LlmError(checked.reason === "empty" ? `${pkg}: the API key resolved from ${ref} is blank; set ${ref} to the raw key (the web Models page writes it) or export it in the launching environment` : `${pkg}: the API key resolved from ${ref} contains characters no HTTP header can carry; set ${ref} to the raw key alone (the web Models page writes it)`, INVALID_CREDENTIAL_CODE);
}
/**
* Provider-wire adapter for the harness message and stream vocabulary. Register implementations
* with `ctx.llm.registerAdapter(providers, adapter)`. Every provider HTTP request must include
* `attributionHeaders()`; prove the headers are added in the wire request or library header hook. The direct-fetch
* DeepSeek and library-backed pi-ai adapters meet this contract through different internals.
*/
var LlmAdapter = class {
	/**
	* Describe one provider route owned by this adapter.
	* @param provider - a route passed to `registerAdapter()` for this instance.
	* @returns detached display metadata whose id must equal `provider`.
	*/
	providerInfo(provider) {
		return {
			id: provider,
			name: provider
		};
	}
	/**
	* Return the provider-owned retry policy captured with this route.
	* @param _provider - a route passed to `registerAdapter()` for this instance.
	* @returns a resolved policy, or `undefined` to use the normal defaults.
	*/
	providerRetryPolicy(_provider) {}
	/**
	* Resolve provider-side request-image pricing for one exact model route.
	* The default declares none, so consumers fall back to their own neutral
	* estimate. Implementations must answer synchronously without I/O; the
	* token meter resolves this per measurement.
	* @param _provider - a route passed to `registerAdapter()` for this instance.
	* @param _model - exact model id passed to {@link GenerateOptions.model}.
	* @returns route-owned image pricing, or `undefined` when the route declares none.
	*/
	imageRequestPricing(_provider, _model) {}
	/**
	* List models this adapter can currently advertise for one owned provider.
	* The result is advisory: an adapter may accept unlisted model ids, and
	* consumers must not turn absence into request rejection.
	* @param _provider - one provider route owned by this adapter.
	* @returns discoverable models in adapter-preferred order.
	*/
	listModels(_provider) {
		return Promise.resolve([]);
	}
	/**
	* Resolve all metadata available for one exact model. This query is
	* independent of the advisory catalog and does not validate request routing.
	* @param provider - one provider route owned by this adapter.
	* @param model - exact model id passed to {@link GenerateOptions.model}.
	* @param _signal - cancellation for this exact-model lookup; asynchronous
	*   implementations must settle promptly after it aborts.
	* @returns provider/model identity plus any context, call-default, and reasoning metadata.
	*/
	resolveModel(provider, model, _signal) {
		return Promise.resolve({
			provider,
			id: model,
			name: model
		});
	}
	/**
	* Attempt a protocol-native, non-generative exact-route verification.
	* @param _provider - registered provider route.
	* @param _model - exact configured model.
	* @param _signal - owner cancellation signal.
	* @returns metadata proof, reachability-only evidence, or undefined for a bounded generation fallback.
	*/
	verifyProvider(_provider, _model, _signal) {
		return Promise.resolve(void 0);
	}
	/**
	* Bind exact model metadata and the eventual request dispatch to one adapter generation.
	* Dynamic adapters override this so settings changes between preparation and
	* dispatch cannot combine one generation's capabilities with another's endpoint.
	* @param provider - registered provider route.
	* @param model - exact model id.
	* @param signal - cancellation for model resolution.
	* @returns model metadata and a one-generation stream entry point.
	*/
	async prepareCall(provider, model, signal) {
		return {
			model: await this.resolveModel(provider, model, signal),
			stream: (options) => this.stream(options)
		};
	}
};
async function verificationSettles(operation, graceMs) {
	const env_1 = {
		stack: [],
		error: void 0,
		hasError: false
	};
	try {
		const expired = Promise.withResolvers();
		__addDisposableResource(env_1, addAbortListener(__addDisposableResource(env_1, deadline(void 0, graceMs, "LLM_VERIFICATION_CANCEL_TIMEOUT"), false).signal, () => {
			expired.resolve(false);
		}), false);
		return await Promise.race([Promise.allSettled([operation]).then(() => true), expired.promise]);
	} catch (e_1) {
		env_1.error = e_1;
		env_1.hasError = true;
	} finally {
		__disposeResources(env_1);
	}
}
/**
* Identify the exact endpoint and protocol authorized for a one-shot discovery credential.
* @param baseURL - candidate endpoint supplied by the caller.
* @param api - candidate protocol, defaulted like the discovery owner.
* @returns credential-free SHA-256 endpoint identity.
*/
function modelDiscoveryEndpointFingerprint(baseURL, api) {
	return createHash("sha256").update(JSON.stringify({
		endpoint: baseURL.replace(/\/+$/u, ""),
		api: api ?? "openai-completions"
	})).digest("hex");
}
/**
* The abstract `llm` service: an adapter registry plus a streaming model-call
* API, interceptable via the `llm/stream` waterfall.
*/
let LlmRuntime = (() => {
	let _classSuper = TypertRemoteService;
	let _instanceExtraInitializers = [];
	let _remoteVerifyProvider_decorators;
	let _remoteMutateProvider_decorators;
	let _remoteProviderTransaction_decorators;
	let _remoteResumeProvider_decorators;
	let _remoteProviders_decorators;
	let _remoteModels_decorators;
	let _listProviders_decorators;
	let _listConfigurableProviders_decorators;
	let _remoteDiscoverModels_decorators;
	return class LlmRuntime extends _classSuper {
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_remoteVerifyProvider_decorators = [Remote("verifyProvider")];
			_remoteMutateProvider_decorators = [Remote("mutateProvider")];
			_remoteProviderTransaction_decorators = [Remote("providerTransaction")];
			_remoteResumeProvider_decorators = [Remote("resumeProvider")];
			_remoteProviders_decorators = [Remote("providers")];
			_remoteModels_decorators = [Remote("models")];
			_listProviders_decorators = [Remote];
			_listConfigurableProviders_decorators = [Remote];
			_remoteDiscoverModels_decorators = [Remote("discoverModels")];
			__esDecorate(this, null, _remoteVerifyProvider_decorators, {
				kind: "method",
				name: "remoteVerifyProvider",
				static: false,
				private: false,
				access: {
					has: (obj) => "remoteVerifyProvider" in obj,
					get: (obj) => obj.remoteVerifyProvider
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _remoteMutateProvider_decorators, {
				kind: "method",
				name: "remoteMutateProvider",
				static: false,
				private: false,
				access: {
					has: (obj) => "remoteMutateProvider" in obj,
					get: (obj) => obj.remoteMutateProvider
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _remoteProviderTransaction_decorators, {
				kind: "method",
				name: "remoteProviderTransaction",
				static: false,
				private: false,
				access: {
					has: (obj) => "remoteProviderTransaction" in obj,
					get: (obj) => obj.remoteProviderTransaction
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _remoteResumeProvider_decorators, {
				kind: "method",
				name: "remoteResumeProvider",
				static: false,
				private: false,
				access: {
					has: (obj) => "remoteResumeProvider" in obj,
					get: (obj) => obj.remoteResumeProvider
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _remoteProviders_decorators, {
				kind: "method",
				name: "remoteProviders",
				static: false,
				private: false,
				access: {
					has: (obj) => "remoteProviders" in obj,
					get: (obj) => obj.remoteProviders
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _remoteModels_decorators, {
				kind: "method",
				name: "remoteModels",
				static: false,
				private: false,
				access: {
					has: (obj) => "remoteModels" in obj,
					get: (obj) => obj.remoteModels
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _listProviders_decorators, {
				kind: "method",
				name: "listProviders",
				static: false,
				private: false,
				access: {
					has: (obj) => "listProviders" in obj,
					get: (obj) => obj.listProviders
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _listConfigurableProviders_decorators, {
				kind: "method",
				name: "listConfigurableProviders",
				static: false,
				private: false,
				access: {
					has: (obj) => "listConfigurableProviders" in obj,
					get: (obj) => obj.listConfigurableProviders
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _remoteDiscoverModels_decorators, {
				kind: "method",
				name: "remoteDiscoverModels",
				static: false,
				private: false,
				access: {
					has: (obj) => "remoteDiscoverModels" in obj,
					get: (obj) => obj.remoteDiscoverModels
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
		static Config = z.object({
			verificationTimeoutMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(15e3),
			verificationCancellationGraceMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(2e3)
		});
		config = __runInitializers(this, _instanceExtraInitializers);
		verificationLifetime = new AbortController();
		verifications = /* @__PURE__ */ new Map();
		providerTransactions;
		adapters = /* @__PURE__ */ new Map();
		directory = /* @__PURE__ */ new Map();
		discoveries = /* @__PURE__ */ new Map();
		constructor(ctx, config = {}) {
			const resolved = LlmRuntime.Config(config);
			for (const field of ["verificationTimeoutMs", "verificationCancellationGraceMs"]) if (!Number.isFinite(resolved[field])) throw new Error(`llm: ${field} must be finite`);
			super(ctx, "llm");
			this.config = resolved;
			this.providerTransactions = new ProviderTransactions(ctx, this);
			ctx.effect(() => async () => {
				this.verificationLifetime.abort();
				if (!await verificationSettles(Promise.allSettled(this.verifications.values()), this.config.verificationCancellationGraceMs)) throw new LlmError("provider verification ignored runtime disposal and remains owner-tracked", "VERIFICATION_STILL_RUNNING");
			}, "llm.provider-verification");
			ctx.inject(["settings"], (settingsCtx) => {
				this.protectProviderSettings(settingsCtx);
				settingsCtx.on("llm/adapters-updated", () => {
					this.protectProviderSettings(settingsCtx);
				});
			});
		}
		protectProviderSettings(ctx) {
			const namespaces = this.listConfigurableProviders().map((entry) => settingsNamespace(entry.settingsNs));
			ctx.settings.setRemoteProtectedNamespaces([...new Set(namespaces)]);
		}
		/**
		* Run one bounded exact-route probe without returning provider output or credentials.
		* @param request - configured provider and model to verify.
		* @param signal - caller cancellation combined with the configured Host deadline.
		* @returns authentication evidence, or explicitly unverified catalog reachability.
		*/
		async remoteVerifyProvider(request, signal) {
			const env_2 = {
				stack: [],
				error: void 0,
				hasError: false
			};
			try {
				if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(request.provider) || request.model.trim() === "") throw new TypertRemoteFailure({
					code: "input-invalid",
					message: "provider verification needs a valid provider and model",
					details: {}
				});
				const bounded = __addDisposableResource(env_2, deadline(signal, this.config.verificationTimeoutMs, "LLM_PROVIDER_VERIFICATION_TIMEOUT"), false);
				let mode;
				try {
					mode = await this.verifyModel(request.provider, request.model, bounded.signal);
				} catch (error) {
					if (error instanceof LlmError && error.code === "VERIFICATION_STILL_RUNNING") throw new TypertRemoteFailure({
						code: "provider-verification-still-running",
						message: "provider verification remains owner-tracked",
						details: {
							provider: request.provider,
							model: request.model,
							state: "still-running"
						}
					});
					if (signal.aborted) throw new TypertRemoteFailure({
						code: "cancelled",
						message: "provider verification was cancelled",
						details: {}
					});
					if (timeoutOf(bounded.signal, "LLM_PROVIDER_VERIFICATION_TIMEOUT") !== void 0) throw new TypertRemoteFailure({
						code: "provider-verification-timeout",
						message: "provider verification timed out",
						details: {
							provider: request.provider,
							model: request.model
						}
					});
					throw new TypertRemoteFailure({
						code: "provider-verification-failed",
						message: "provider/model authentication verification failed",
						details: {
							provider: request.provider,
							model: request.model
						}
					});
				}
				return mode === "endpoint-catalog" ? {
					provider: request.provider,
					model: request.model,
					verified: false,
					mode,
					classification: "reachability-only"
				} : {
					provider: request.provider,
					model: request.model,
					verified: true,
					mode
				};
			} catch (e_2) {
				env_2.error = e_2;
				env_2.hasError = true;
			} finally {
				__disposeResources(env_2);
			}
		}
		/**
		* Verify one exact route while retaining admission until cancelled work actually settles.
		* @param provider - registered provider route.
		* @param model - exact configured model.
		* @param signal - owner cancellation and deadline.
		* @returns native metadata evidence or a bounded one-token generation handshake.
		*/
		async verifyModel(provider, model, signal) {
			const env_3 = {
				stack: [],
				error: void 0,
				hasError: false
			};
			try {
				if (signal.aborted || this.verificationLifetime.signal.aborted) throw new LlmError("provider verification aborted", "ABORTED");
				const key = JSON.stringify([provider, model]);
				if (this.verifications.has(key)) throw new LlmError("provider verification is still running", "VERIFICATION_STILL_RUNNING");
				const registration = this.registration(provider);
				const ownedSignal = AbortSignal.any([signal, this.verificationLifetime.signal]);
				const operation = Promise.resolve().then(() => this.performProviderVerification(registration, provider, model, ownedSignal));
				this.verifications.set(key, operation);
				const settled = operation.then((mode) => ({
					kind: "completed",
					mode
				}), (error) => ({
					kind: "failed",
					error
				})).finally(() => {
					this.verifications.delete(key);
				});
				const aborted = Promise.withResolvers();
				__addDisposableResource(env_3, addAbortListener(ownedSignal, () => {
					aborted.resolve(void 0);
				}), false);
				const result = await Promise.race([settled, aborted.promise.then(() => ({ kind: "aborted" }))]);
				if (result.kind === "completed") {
					if (ownedSignal.aborted) throw new LlmError("provider verification aborted", "ABORTED");
					return result.mode;
				}
				if (result.kind === "failed") throw result.error;
				if (!await verificationSettles(settled, this.config.verificationCancellationGraceMs)) throw new LlmError("provider verification ignored cancellation and is still running", "VERIFICATION_STILL_RUNNING");
				throw new LlmError("provider verification aborted", "ABORTED");
			} catch (e_3) {
				env_3.error = e_3;
				env_3.hasError = true;
			} finally {
				__disposeResources(env_3);
			}
		}
		async performProviderVerification(registration, provider, model, signal) {
			signal.throwIfAborted();
			const native = await registration.adapter.verifyProvider(provider, model, signal);
			if (native !== void 0) return native;
			const call = await registration.adapter.prepareCall(provider, model, signal);
			const info = this.normalizeModelInfo(registration, model, call.model);
			const config = this.resolveCallWithInfo({
				provider,
				model,
				maxTokens: 1
			}, info).config;
			let finish;
			for await (const chunk of call.stream({
				...config,
				signal,
				messages: [createUserMessage({
					content: [{
						type: "text",
						text: "."
					}],
					source: {
						kind: "plugin",
						plugin: "llm-verification"
					}
				})]
			})) if (chunk.type === "finish") finish = chunk.reason;
			signal.throwIfAborted();
			if (finish === void 0) throw new LlmError("provider verification stream closed without a terminal frame", "STREAM_CLOSED");
			if (finish.kind === "error" || finish.kind === "aborted") throw new LlmError(finish.failure.message, finish.failure.code);
			return "minimal-generation";
		}
		/**
		* Commit a Native profile and credential change through the existing storage owners.
		* @param request - caller-stable transaction identity, revision and profile edits.
		* @param signal - cancellation before durable claim; claimed work keeps its ownership.
		* @returns committed redacted settings only after owner activation succeeds.
		*/
		remoteMutateProvider(request, signal) {
			return this.providerTransactions.mutate(request, signal);
		}
		/**
		* Inspect a durable provider transaction without changing its journal or credentials.
		* @param request - provider and transaction identity retained by the native client.
		* @returns the recorded phase or outcome and whether recovery needs a write-only credential.
		*/
		remoteProviderTransaction(request) {
			return this.providerTransactions.status(request);
		}
		/**
		* Resume the existing durable plan instead of rebuilding edits from a refreshed UI.
		* @param request - stored transaction identity and optional missing credential.
		* @param signal - cancellation before durable claim only.
		* @returns the redacted committed state or the transaction's recovery failure.
		*/
		remoteResumeProvider(request, signal) {
			return this.providerTransactions.resume(request, signal);
		}
		/**
		* Join the configurable directory with live adapter routes for Native Settings.
		* @returns declared and active-only provider rows, without credentials.
		*/
		remoteProviders() {
			const live = this.listProviders();
			const active = new Set(live.map((provider) => provider.id));
			const declared = /* @__PURE__ */ new Set();
			const providers = this.listConfigurableProviders().map((entry) => {
				declared.add(entry.provider);
				return {
					provider: entry.provider,
					displayName: entry.displayName,
					settingsNs: entry.settingsNs,
					settingsPath: [...entry.settingsPath],
					active: active.has(entry.provider),
					...entry.declared === void 0 ? {} : { declared: entry.declared },
					...entry.error === void 0 ? {} : { error: entry.error },
					...entry.migrationRequired === void 0 ? {} : { migrationRequired: structuredClone(entry.migrationRequired) }
				};
			});
			for (const provider of live) if (!declared.has(provider.id)) providers.push({
				provider: provider.id,
				displayName: provider.name,
				settingsNs: "",
				settingsPath: [],
				active: true
			});
			return { providers };
		}
		/**
		* Read the host model catalog with failure isolation between providers.
		* @returns model groups and value-free provider failures.
		*/
		async remoteModels() {
			const catalogs = await Promise.all(this.listProviders().map(async (provider) => {
				try {
					const models = await this.listModels(provider.id);
					const rows = await Promise.all(models.map(async (model) => {
						const resolved = await this.resolveModelInfo(provider.id, model.id);
						return {
							id: model.id,
							name: model.name,
							...model.description === void 0 ? {} : { description: model.description },
							...resolved.defaultMaxTokens === void 0 ? {} : { defaultMaxTokens: resolved.defaultMaxTokens },
							...resolved.reasoning === void 0 ? {} : { reasoning: {
								efforts: resolved.reasoning.efforts.map((effort) => ({
									id: String(effort.id),
									name: effort.name,
									...effort.description === void 0 ? {} : { description: effort.description }
								})),
								...resolved.reasoning.defaultEffort === void 0 ? {} : { defaultEffort: String(resolved.reasoning.defaultEffort) }
							} }
						};
					}));
					return {
						kind: "group",
						group: {
							id: provider.id,
							name: provider.name,
							models: rows
						}
					};
				} catch {
					return {
						kind: "failure",
						failure: {
							id: provider.id,
							name: provider.name,
							message: "provider model catalog unavailable"
						}
					};
				}
			}));
			return {
				groups: catalogs.flatMap((entry) => entry.kind === "group" && entry.group.models.length > 0 ? [entry.group] : []),
				failures: catalogs.flatMap((entry) => entry.kind === "failure" ? [entry.failure] : [])
			};
		}
		/** Notify topology observers without letting one broken listener veto the commit. */
		emitAdaptersUpdated() {
			let invariantFailure;
			for (const listener of this.ctx.events.dispatch("emit", ["llm/adapters-updated"])) try {
				const returned = listener();
				if (returned != null && typeof returned.then === "function") Promise.resolve(returned).then(void 0, (error) => {
					this.warnAdaptersListenerFailure(error);
				});
			} catch (error) {
				if (error?.code === "INVARIANT") {
					invariantFailure ??= error;
					continue;
				}
				this.warnAdaptersListenerFailure(error);
			}
			if (invariantFailure !== void 0) throw invariantFailure;
		}
		/** Contained-listener diagnostic shared by the sync and async failure paths. */
		warnAdaptersListenerFailure(error) {
			this.ctx.logger.warn("llm: an llm/adapters-updated listener failed");
			this.ctx.logger.warn(error);
		}
		/**
		* Register an adapter for the given provider routes. Throws `LlmError` with code
		* `DUPLICATE_ADAPTER` if any provider already has an adapter (all-or-nothing).
		* Disposed with the fiber.
		* @param providers - every provider route this adapter should serve.
		* @param adapter - the adapter that streams calls for those providers.
		* @returns the disposer, carrying {@link AdapterRegistrationHandle.replace}.
		*/
		registerAdapter(providers, adapter) {
			const owned = /* @__PURE__ */ new Set();
			let released = false;
			const dispose = this.ctx.effect(function* () {
				if (providers.length === 0) throw new LlmError("an adapter must register at least one provider", "INVALID_ADAPTER");
				this.commitRoutes(owned, this.prepareRoutes(providers, adapter, owned));
				yield () => {
					released = true;
					for (const provider of owned) this.adapters.delete(provider);
					owned.clear();
					this.emitAdaptersUpdated();
				};
			}.bind(this), "llm.registerAdapter()");
			const handle = (() => void dispose());
			handle.replace = (next) => {
				if (released) throw new LlmError("a disposed adapter registration cannot replace its routes", "REGISTRATION_DISPOSED");
				this.commitRoutes(owned, this.prepareRoutes(next, adapter, owned));
			};
			return handle;
		}
		/**
		* Validate one candidate route set for `adapter`, treating routes this
		* registration already holds as available. Nothing is mutated: a rejected
		* candidate leaves the registry exactly as it was.
		*/
		prepareRoutes(providers, adapter, owned) {
			const unique = /* @__PURE__ */ new Set();
			const registrations = [];
			for (const provider of providers) {
				if (provider.length === 0) throw new LlmError("adapter provider names must be non-empty", "INVALID_ADAPTER");
				if (unique.has(provider) || this.adapters.has(provider) && !owned.has(provider)) throw new LlmError(`an adapter for provider "${provider}" is already registered`, "DUPLICATE_ADAPTER");
				const info = adapter.providerInfo(provider);
				if (typeof info.id !== "string" || info.id !== provider || typeof info.name !== "string" || info.name.length === 0) throw new LlmError(`adapter metadata for provider "${provider}" must preserve its id and have a non-empty name`, "INVALID_ADAPTER");
				unique.add(provider);
				const retryPolicy = adapter.providerRetryPolicy(provider) ?? resolveRetryPolicy(void 0, `llm: provider "${provider}" retryPolicy`);
				registrations.push({
					adapter,
					provider: {
						id: info.id,
						name: info.name
					},
					retryPolicy
				});
			}
			return registrations;
		}
		/**
		* Swap this registration's routes for the prepared ones in one synchronous
		* section, so no observer can see the registry between the release and the
		* re-registration. The route set's one mutation point is also where
		* `llm/adapters-updated` is published, so a `replace` announces itself
		* exactly like a first registration.
		*/
		commitRoutes(owned, registrations) {
			for (const provider of owned) this.adapters.delete(provider);
			owned.clear();
			for (const registration of registrations) {
				this.adapters.set(registration.provider.id, registration);
				owned.add(registration.provider.id);
			}
			this.emitAdaptersUpdated();
		}
		/**
		* Describe provider routes with a registered adapter.
		* @returns detached provider metadata in registration order.
		*/
		listProviders() {
			return [...this.adapters.values()].map(({ provider }) => ({ ...provider }));
		}
		/**
		* Declare provider routes an adapter plugin can activate through
		* configuration. Registration is all-or-nothing: an empty list, invalid
		* entry, or a provider already declared by any registration throws
		* `LlmError` without registering the rest. Disposed with the fiber.
		* @param entries - every configurable provider this plugin owns.
		* @returns a handle that withdraws all of them, and can atomically replace them.
		*/
		registerConfigurableProviders(entries) {
			let held = [];
			let disposed = false;
			/**
			* Validate a candidate set in full against everything this registration
			* does not already hold, then publish it. Nothing is written until the
			* whole set passes, so a refused candidate leaves the current entries in
			* place — the property that makes `replace` a swap rather than a
			* delete-then-add that can strand the directory empty.
			*/
			const commit = (candidates) => {
				const detached = [];
				const own = new Set(held.map((entry) => entry.provider));
				for (const entry of candidates) {
					if (entry.provider.length === 0 || entry.displayName.length === 0 || entry.settingsNs.length === 0) throw new LlmError("configurable providers need a non-empty provider, displayName, and settingsNs", "INVALID_DIRECTORY");
					if (entry.settingsPath.some((segment) => segment.length === 0)) throw new LlmError(`configurable provider "${entry.provider}" has an empty settingsPath segment`, "INVALID_DIRECTORY");
					if (this.directory.has(entry.provider) && !own.has(entry.provider) || detached.some((seen) => seen.provider === entry.provider)) throw new LlmError(`configurable provider "${entry.provider}" is already declared`, "DUPLICATE_DIRECTORY");
					detached.push({
						...entry,
						settingsPath: [...entry.settingsPath],
						...entry.migrationRequired === void 0 ? {} : { migrationRequired: structuredClone(entry.migrationRequired) }
					});
				}
				for (const entry of held) this.directory.delete(entry.provider);
				for (const entry of detached) this.directory.set(entry.provider, entry);
				held = detached;
				this.emitAdaptersUpdated();
			};
			const dispose = this.ctx.effect(function* () {
				if (entries.length === 0) throw new LlmError("a configurable-provider registration must declare at least one provider", "INVALID_DIRECTORY");
				commit(entries);
				yield () => {
					disposed = true;
					for (const entry of held) this.directory.delete(entry.provider);
					held = [];
					this.emitAdaptersUpdated();
				};
			}.bind(this), "llm.registerConfigurableProviders()");
			const handle = (() => void dispose());
			handle.replace = (next) => {
				if (disposed) throw new LlmError("this configurable-provider registration was disposed", "REGISTRATION_DISPOSED");
				commit(next);
			};
			return handle;
		}
		/**
		* List every declared configurable provider, registered or dormant.
		* @returns detached directory entries in declaration order.
		*/
		listConfigurableProviders() {
			return [...this.directory.values()].map((entry) => ({
				...entry,
				settingsPath: [...entry.settingsPath],
				...entry.migrationRequired === void 0 ? {} : { migrationRequired: structuredClone(entry.migrationRequired) }
			}));
		}
		/**
		* Offer to interrogate provider endpoints on behalf of the settings
		* namespace this plugin owns. The namespace is the key because that is what
		* a configuration surface already holds from the configurable-provider
		* directory, and because a provider being *added* has no route to name yet.
		* Disposed with the fiber.
		* @param settingsNs - the namespace whose profiles this discovery serves.
		* @param discover - interrogates one endpoint and must honor the supplied signal.
		* @returns the disposer that withdraws the offer.
		*/
		registerModelDiscovery(settingsNs, discover) {
			const dispose = this.ctx.effect(function* () {
				if (settingsNs.length === 0) throw new LlmError("model discovery needs a non-empty settings namespace", "INVALID_DISCOVERY");
				if (this.discoveries.has(settingsNs)) throw new LlmError(`model discovery for "${settingsNs}" is already registered`, "DUPLICATE_DISCOVERY");
				this.discoveries.set(settingsNs, discover);
				yield () => {
					this.discoveries.delete(settingsNs);
				};
			}.bind(this), "llm.registerModelDiscovery()");
			return () => void dispose();
		}
		/**
		* Interrogate one provider endpoint for the models it advertises. The
		* request describes a draft, not a stored route, so nothing here reads or
		* writes settings or credentials — the caller owns both, and the reply is
		* candidate metadata a surface may offer for adoption.
		* @param settingsNs - namespace whose registered discovery serves this draft.
		* @param request - the endpoint, protocol, and one-shot credential to use.
		* @param signal - caller cancellation.
		* @returns the advertised models, deduplicated in endpoint order.
		*/
		async discoverModels(settingsNs, request, signal) {
			const discover = this.discoveries.get(settingsNs);
			if (discover === void 0) throw new LlmError(`no model discovery is registered for "${settingsNs}"`, "NO_DISCOVERY");
			if ((request.provider ?? "").length === 0 && (request.baseURL ?? "").length === 0) throw new LlmError("model discovery needs a provider route or a baseURL", "INVALID_DISCOVERY");
			let bound = request;
			if (request.apiKey !== void 0) {
				const endpoint = request.baseURL;
				if (endpoint === void 0 || endpoint.length === 0) throw new LlmError("a one-shot discovery credential requires its exact candidate baseURL", "INVALID_DISCOVERY");
				bound = {
					...request,
					credentialEndpointFingerprint: modelDiscoveryEndpointFingerprint(endpoint, request.api)
				};
			}
			const discovered = signal === void 0 ? await discover(bound) : await discover(bound, signal);
			const seen = /* @__PURE__ */ new Set();
			const models = [];
			for (const model of discovered) {
				if (typeof model.id !== "string" || model.id.length === 0 || seen.has(model.id)) continue;
				for (const capacity of [model.contextWindow, model.maxTokens]) if (capacity !== void 0 && (!Number.isSafeInteger(capacity) || capacity <= 0)) throw new LlmError("model discovery returned an invalid capacity", "INVALID_MODEL_INFO");
				seen.add(model.id);
				models.push({
					id: model.id,
					...model.name === void 0 ? {} : { name: model.name },
					...model.contextWindow === void 0 ? {} : { contextWindow: model.contextWindow },
					...model.maxTokens === void 0 ? {} : { maxTokens: model.maxTokens }
				});
			}
			return models;
		}
		/**
		* Remote adapter for one draft provider interrogation.
		* @param request - namespace, endpoint, protocol, and one-shot credential to use.
		* @param signal - caller cancellation supplied by the Remote carrier.
		* @returns advertised models in the Native response envelope.
		* @throws TypertRemoteFailure with `model-discovery-failed` when discovery refuses or fails.
		*/
		async remoteDiscoverModels(request, signal) {
			const checkCancellation = () => {
				if (signal.aborted) throw new TypertRemoteFailure({
					code: "cancelled",
					message: "model discovery was cancelled",
					details: {}
				});
			};
			checkCancellation();
			try {
				const { settingsNs, ...draft } = request;
				const models = await this.discoverModels(settingsNs, draft, signal);
				checkCancellation();
				return { models: models.map((model) => ({
					id: model.id,
					...model.name === void 0 ? {} : { name: model.name },
					...model.contextWindow === void 0 ? {} : { contextWindow: model.contextWindow },
					...model.maxTokens === void 0 ? {} : { maxTokens: model.maxTokens }
				})) };
			} catch {
				checkCancellation();
				throw new TypertRemoteFailure({
					code: "model-discovery-failed",
					message: "provider model discovery failed",
					details: {
						settingsNs: request.settingsNs,
						...request.baseURL === void 0 ? {} : { baseURL: request.baseURL }
					}
				});
			}
		}
		/**
		* Resolve the retry policy captured when one provider route was registered.
		* @param provider - registered provider route to inspect.
		* @returns the provider-owned policy, with normal defaults already resolved.
		*/
		providerRetryPolicy(provider) {
			return this.registration(provider).retryPolicy;
		}
		/**
		* Resolve provider-side request-image pricing for one exact route, or
		* `undefined` when the provider is unregistered or declares none. Unknown
		* providers degrade to `undefined` rather than throwing because callers
		* price durable history whose route may no longer be mounted.
		* @param provider - provider route named by a request header.
		* @param model - exact model id named by the same header.
		* @returns the owning adapter's image pricing for the route, when declared.
		*/
		imageRequestPricing(provider, model) {
			return this.adapters.get(provider)?.adapter.imageRequestPricing(provider, model);
		}
		/** Detach typed adapter-owned modality metadata. */
		detachedModalities(modalities) {
			return modalities === void 0 ? void 0 : [...modalities];
		}
		/**
		* Discover models advertised by one registered provider. Catalog membership
		* is advisory and never changes routing or request validation.
		* @param provider - registered provider route to inspect.
		* @returns detached model metadata in adapter-preferred order.
		*/
		async listModels(provider) {
			const models = await this.registration(provider).adapter.listModels(provider);
			const seen = /* @__PURE__ */ new Set();
			return models.map((model) => {
				if (typeof model.provider !== "string" || model.provider !== provider || typeof model.id !== "string" || model.id.length === 0 || typeof model.name !== "string" || model.name.length === 0 || model.description !== void 0 && typeof model.description !== "string" || seen.has(model.id)) throw new LlmError(`adapter returned invalid or duplicate model metadata for provider "${provider}"`, "INVALID_CATALOG");
				seen.add(model.id);
				const inputModalities = this.detachedModalities(model.inputModalities);
				return {
					provider: model.provider,
					id: model.id,
					name: model.name,
					...model.description === void 0 ? {} : { description: model.description },
					...inputModalities === void 0 ? {} : { inputModalities }
				};
			});
		}
		/**
		* Resolve and validate all metadata from the adapter that owns one exact
		* route. The result is detached from adapter-owned objects; catalog
		* membership remains advisory and does not control request routing.
		* @param provider - registered provider route to inspect.
		* @param model - exact model id passed to the adapter.
		* @param signal - optional cancellation for adapter-owned asynchronous lookup.
		* @returns exact model identity plus available context and reasoning metadata.
		*/
		async resolveModelInfo(provider, model, signal) {
			return this.resolveModelInfoFor(this.registration(provider), model, signal);
		}
		async resolveModelInfoFor(registration, model, signal) {
			const resolved = await registration.adapter.resolveModel(registration.provider.id, model, signal);
			return this.normalizeModelInfo(registration, model, resolved);
		}
		/** Validate and detach one adapter-returned exact model result. */
		normalizeModelInfo(registration, model, resolved) {
			const provider = registration.provider.id;
			if (typeof resolved.provider !== "string" || resolved.provider !== provider || typeof resolved.id !== "string" || resolved.id !== model || typeof resolved.name !== "string" || resolved.name.length === 0 || resolved.description !== void 0 && typeof resolved.description !== "string") throw new LlmError(`adapter returned invalid exact model metadata for provider "${provider}" model "${model}"`, "INVALID_MODEL_INFO");
			const context = resolved.context;
			if (context !== void 0 && (!Number.isSafeInteger(context.contextWindow) || context.contextWindow <= 0)) throw new LlmError(`adapter returned invalid context metadata for provider "${provider}" model "${model}"`, "INVALID_MODEL_CONTEXT");
			const inputModalities = this.detachedModalities(resolved.inputModalities);
			const defaultMaxTokens = resolved.defaultMaxTokens;
			if (defaultMaxTokens !== void 0 && (!Number.isSafeInteger(defaultMaxTokens) || defaultMaxTokens <= 0)) throw new LlmError(`adapter returned invalid default maxTokens for provider "${provider}" model "${model}"`, "INVALID_MODEL_MAX_TOKENS");
			const info = {
				provider,
				id: model,
				name: resolved.name,
				...resolved.description === void 0 ? {} : { description: resolved.description },
				...inputModalities === void 0 ? {} : { inputModalities },
				...context === void 0 ? {} : { context: { contextWindow: context.contextWindow } },
				...defaultMaxTokens === void 0 ? {} : { defaultMaxTokens }
			};
			const reasoning = resolved.reasoning;
			if (reasoning === void 0) return info;
			if (reasoning.efforts.length === 0) throw new LlmError(`adapter returned invalid reasoning metadata for provider "${provider}" model "${model}"`, "INVALID_MODEL_REASONING");
			const seen = /* @__PURE__ */ new Set();
			const efforts = reasoning.efforts.map((effort) => {
				if (typeof effort.id !== "string" || effort.id.length === 0 || typeof effort.name !== "string" || effort.name.length === 0 || effort.description !== void 0 && typeof effort.description !== "string" || seen.has(effort.id)) throw new LlmError(`adapter returned invalid or duplicate reasoning effort metadata for provider "${provider}" model "${model}"`, "INVALID_MODEL_REASONING");
				seen.add(effort.id);
				return {
					id: effort.id,
					name: effort.name,
					...effort.description === void 0 ? {} : { description: effort.description }
				};
			});
			if (reasoning.defaultEffort !== void 0 && !seen.has(reasoning.defaultEffort)) throw new LlmError(`adapter returned an unknown default reasoning effort for provider "${provider}" model "${model}"`, "INVALID_MODEL_REASONING");
			return {
				...info,
				reasoning: {
					efforts,
					...reasoning.defaultEffort === void 0 ? {} : { defaultEffort: reasoning.defaultEffort }
				}
			};
		}
		/**
		* Validate a conversation call config against its exact model capability and
		* materialize adapter-configured defaults. Unsupported explicit efforts
		* reject before provider I/O; no clamping or aliasing is performed. This
		* standalone query does not bind a later dispatch; use {@link prepareCall}
		* when logging and streaming must share one adapter registration.
		* @param config - provider/model route and optional request controls.
		* @param signal - optional cancellation for adapter-owned capability lookup.
		* @returns a detached config only when a default must be materialized.
		*/
		async resolveCallConfig(config, signal) {
			return (await this.resolveCallFor(this.registration(config.provider), config, signal)).config;
		}
		async resolveCallFor(registration, config, signal) {
			const info = await this.resolveModelInfoFor(registration, config.model, signal);
			return this.resolveCallWithInfo(config, info);
		}
		/** Validate request controls against one already-bound exact model result. */
		resolveCallWithInfo(config, info) {
			const defaulted = config.maxTokens === void 0 && info.defaultMaxTokens !== void 0 ? {
				...config,
				maxTokens: info.defaultMaxTokens
			} : config;
			const reasoning = info.reasoning;
			const requested = defaulted.reasoningEffort;
			let resolvedConfig = defaulted;
			if (reasoning === void 0) {
				if (requested !== void 0) throw new LlmError(`provider "${config.provider}" model "${config.model}" does not support reasoning effort "${requested}"`, "UNSUPPORTED_REASONING_EFFORT");
			} else {
				const effective = requested ?? reasoning.defaultEffort;
				if (effective !== void 0) {
					if (!reasoning.efforts.some((effort) => effort.id === effective)) throw new LlmError(`provider "${config.provider}" model "${config.model}" does not support reasoning effort "${effective}"`, "UNSUPPORTED_REASONING_EFFORT");
					if (requested !== effective) resolvedConfig = {
						...defaulted,
						reasoningEffort: effective
					};
				}
			}
			return {
				config: resolvedConfig,
				...info.context === void 0 ? {} : { context: info.context },
				modelInfo: info
			};
		}
		/**
		* Resolve one call under its current adapter registration. The returned
		* one-shot handle keeps that registration across header logging and dispatch,
		* so HMR cannot combine one adapter's capability result with another adapter.
		* @param config - provider/model route and optional request controls.
		* @param signal - optional cancellation for adapter-owned capability lookup.
		* @returns a prepared config and its registration-bound stream entry point.
		*/
		async prepareCall(config, signal) {
			const registration = this.registration(config.provider);
			const adapterCall = await registration.adapter.prepareCall(config.provider, config.model, signal);
			const modelInfo = this.normalizeModelInfo(registration, config.model, adapterCall.model);
			const resolved = this.resolveCallWithInfo(config, modelInfo);
			const resolvedConfig = deepFreeze(structuredClone(resolved.config));
			const context = resolved.context === void 0 ? void 0 : deepFreeze(structuredClone(resolved.context));
			const adapterDefaults = deepFreeze({
				...config.reasoningEffort === void 0 && resolvedConfig.reasoningEffort !== void 0 ? { reasoningEffort: true } : {},
				...config.maxTokens === void 0 && resolvedConfig.maxTokens !== void 0 ? { maxTokens: true } : {}
			});
			let dispatched = false;
			return Object.freeze({
				config: resolvedConfig,
				retryPolicy: registration.retryPolicy,
				adapterDefaults,
				...context === void 0 ? {} : { context },
				...modelInfo.inputModalities === void 0 ? {} : { inputModalities: Object.freeze([...modelInfo.inputModalities]) },
				stream: (options) => {
					if (dispatched) throw new LlmError("a prepared LLM call can only be dispatched once", "INVALID_PREPARED_CALL");
					if (!callConfigEquals(options, resolvedConfig)) throw new LlmError("prepared LLM call config changed before adapter dispatch", "INVALID_PREPARED_CALL");
					dispatched = true;
					return this.streamWithRegistration(options, {
						registration,
						config: resolvedConfig,
						modelInfo,
						dispatch: (options) => adapterCall.stream(options)
					});
				}
			});
		}
		registration(provider) {
			const registration = this.adapters.get(provider);
			if (!registration) throw new LlmError(`no adapter registered for provider "${provider}"`, "NO_ADAPTER");
			return registration;
		}
		/** Remove replay state whose historical route is owned by another adapter. */
		forAdapter(options, adapter) {
			const messages = options.messages.map((message) => {
				const source = message.source;
				if (message.role !== "assistant" || source.kind !== "model" || source.replayState === void 0) return message;
				if (this.adapters.get(source.provider)?.adapter === adapter) return message;
				return freezeMessage({
					...message,
					source: {
						kind: "model",
						provider: source.provider,
						model: source.model
					}
				});
			});
			if (messages.every((message, index) => message === options.messages[index])) return options;
			const filtered = {
				...options,
				messages
			};
			return Object.isFrozen(options) ? deepFreeze(filtered) : filtered;
		}
		/**
		* Final adapter boundary. Adapter selection, dispatch, iterator construction,
		* and iteration failures become one terminal failure chunk. Middleware and
		* downstream consumer failures remain thrown plugin or consumer errors.
		*/
		async *adapterStream(options, prepared) {
			let iterator;
			try {
				const registration = prepared?.registration ?? this.registration(options.provider);
				const adapter = registration.adapter;
				let modelInfo;
				let resolvedConfig;
				let dispatch;
				if (prepared === void 0) {
					const adapterCall = await adapter.prepareCall(options.provider, options.model, options.signal);
					modelInfo = this.normalizeModelInfo(registration, options.model, adapterCall.model);
					resolvedConfig = this.resolveCallWithInfo(options, modelInfo).config;
					dispatch = (options) => adapterCall.stream(options);
				} else {
					modelInfo = prepared.modelInfo;
					resolvedConfig = prepared.config;
					dispatch = prepared.dispatch;
				}
				if (prepared !== void 0 && !callConfigEquals(options, resolvedConfig)) throw new LlmError("prepared LLM call config changed before adapter dispatch", "INVALID_PREPARED_CALL");
				const resolvedOptions = callConfigEquals(options, resolvedConfig) ? options : Object.isFrozen(options) ? deepFreeze({
					...options,
					...resolvedConfig
				}) : {
					...options,
					...resolvedConfig
				};
				const projectedOptions = modelInfo.inputModalities !== void 0 && !modelInfo.inputModalities.includes("image") && resolvedOptions.messages.some((message) => contentHasImage(message.content)) ? Object.isFrozen(resolvedOptions) ? deepFreeze({
					...resolvedOptions,
					messages: projectImagesForTextModel(resolvedOptions.messages)
				}) : {
					...resolvedOptions,
					messages: projectImagesForTextModel(resolvedOptions.messages)
				} : resolvedOptions;
				iterator = dispatch(this.forAdapter(projectedOptions, adapter))[Symbol.asyncIterator]();
			} catch (error) {
				yield adapterFailureChunk(error, options.signal);
				return;
			}
			let completed = false;
			try {
				while (true) {
					let item;
					try {
						const next = await iterator.next();
						item = next.done ? { done: true } : {
							done: false,
							value: next.value
						};
					} catch (error) {
						completed = true;
						yield adapterFailureChunk(error, options.signal);
						return;
					}
					if (item.done) {
						completed = true;
						return;
					}
					yield item.value;
				}
			} finally {
				if (!completed) {
					const close = iterator.return?.bind(iterator);
					if (close) await close();
				}
			}
		}
		/**
		* Stream one model call as raw chunks (token-level deltas). Replay state is
		* retained only when the same adapter instance owns its historical provider
		* and the target provider. Final adapter selection remains fixed through
		* asynchronous exact-model resolution and dispatch. Adapter selection,
		* dispatch, and iteration failures become terminal `error` or `aborted`
		* finish chunks; middleware, nested-call, cleanup, and consumer failures
		* remain thrown.
		* @param options - the full request; `options.provider` selects the adapter.
		* @returns the chunk stream, possibly wrapped by `llm/stream` listeners.
		*/
		stream(options) {
			return this.streamWithRegistration(options);
		}
		streamWithRegistration(options, prepared) {
			return this.ctx.waterfall(this, "llm/stream", options, () => this.adapterStream(options, prepared));
		}
	};
})();
/** Convert one adapter throw into the stream protocol's terminal outcome. */
function adapterFailureChunk(error, signal) {
	const failure = normalizeLlmFailure(error);
	return {
		type: "finish",
		reason: signal?.aborted || failure.code === "ABORTED" ? {
			kind: "aborted",
			failure
		} : {
			kind: "error",
			failure
		}
	};
}
//#endregion
export { APP_IDENTITY, BlockAssembler, CONTEXT_SUMMARY_MAX_CHARS, CONTEXT_WINDOW_EXCEEDED_CODE, CallId, EMPTY_RESPONSE_CODE, HarnessError, INVALID_CREDENTIAL_CODE, LlmAdapter, LlmError, LlmRuntime, LlmRuntime as default, MessageId, ProviderRequestId, QUOTA_EXCEEDED_CODE, ReasoningEffortId, RetryPolicySchema, assertNever, assertUsableApiKey, attributionHeaders, boundContextSummary, callConfigEquals, contentHasImage, createAssistantMessage, createMessage, createToolResultMessage, createUserMessage, deepFreeze, errorChain, freezeMessage, isAgentLoopRequest, isContextWindowExceededError, isCredentialHeaderName, isHarnessError, isQuotaExceededError, markAgentLoopRequest, modelDiscoveryEndpointFingerprint, normalizeApiKey, offloadRequestImagesWithPolicy, offloadedImagePrefixCount, offloadedImageText, projectImagesForTextModel, requestImageHandleText, resolveImageAttachmentAccess, resolveRetryPolicy, textOnlyImageText, userAgent };
