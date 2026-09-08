import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { Remote, TypertLookupFailure, TypertRemoteService, isTypertRemoteFailure } from "@deepseek-ai/dsh-typert-protocol";
import { SettingsConflictError, deepEqualJson, remoteNamespaceView, settingsNamespace } from "@deepseek-ai/dsh-settings";
import z from "@deepseek-ai/schemastery";
import { MAX_TIMER_DELAY_MS, deadline } from "@deepseek-ai/dsh-timeout";
import { AsyncLocalStorage } from "node:async_hooks";
import { symbols } from "@deepseek-ai/cordis";
import { credentialKey, credentialRef } from "@deepseek-ai/dsh-credentials";
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
		id: MessageId(crypto.randomUUID())
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
/**
* Whether a stream chunk carries visible model output (the first-token
* boundary shared by client step timing and the whole-log sessionStats
* projection). Empty deltas (heartbeats, empty tool-call frames) do not count
* as a first token.
* @param chunk - the stream chunk to test.
* @returns true when the chunk contains a non-empty text/reasoning/tool delta.
*/
function isTokenDelta(chunk) {
	switch (chunk.type) {
		case "text-delta":
		case "reasoning-delta": return chunk.text !== "";
		case "tool-call-delta": return chunk.argumentsDelta !== "" || chunk.name !== void 0;
		default: return false;
	}
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
		message: errorMessage$1(error),
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
function errorMessage$1(error) {
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
* Map a host-backed attachment path into the current filesystem execution world.
* @param attachments - The attachments input.
* @param mapHostPath - The map host path input.
* @param ref - The ref input.
* @returns The value produced by resolve image attachment access.
*/
function resolveImageAttachmentAccess(attachments, mapHostPath, ref) {
	const hostPath = attachments.imageHostPath(ref);
	if (hostPath === void 0) return void 0;
	const readonlyPath = mapHostPath(hostPath);
	return readonlyPath === void 0 ? void 0 : { readonlyPath };
}
function imageIdentity(ref) {
	return ref.name === void 0 ? String(ref.attachmentId) : `${JSON.stringify(ref.name)} (${ref.attachmentId})`;
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
	return ` Normalized copy (read-only; may be resized or re-encoded): ${JSON.stringify(access.readonlyPath)} (${ref.width}x${ref.height}px, ${ref.mediaType}). Source dimensions, format, and byte size may differ. Copy to a writable path ending in ${extension(ref.mediaType)} before editing.`;
}
/** Model-facing stand-in for an image removed to fit a provider request bound. */
const OFFLOADED_IMAGE_TEXT = "[image omitted to keep the request within its image limit; older images are omitted first. If this image is still needed, read its file again when a path is available; otherwise ask the user to attach it again.]";
/**
* Stable text shown to a model that cannot accept one durable image reference.
* @param ref - durable master reference omitted from the request.
* @returns deterministic text-only placeholder.
*/
function textOnlyImageText(ref) {
	return `[image omitted because this model accepts text only; attachment sha256:${String(ref.attachmentId).slice(7, 15)}]`;
}
function requestImageHandleText(value, dimensions, access) {
	const ref = "attachment" in value ? value.attachment : value;
	const version = "attachment" in value ? value : dimensions;
	if (version === void 0) throw new TypeError("request image dimensions are required");
	const preview = `Image ${imageIdentity(ref)}; request preview ${version.width}x${version.height}px.`;
	return access === void 0 ? `${preview} It may be resized or re-encoded; source dimensions, format, and byte size may differ.` : preview + normalizedAccessText(ref, access);
}
/**
* Stable placeholder for an image omitted by request limits.
* @param ref - The ref input.
* @param access - The access input.
* @returns The value produced by offloaded image text.
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
/**
* Return the number of oldest image occurrences removed by the policy.
* @param lengths - The lengths input.
* @param policy - The policy input.
* @returns The value produced by offloaded image prefix count.
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
* Return transient request messages whose oldest images are replaced until
* their accumulated base64 payload fits the configured bound. The selection
* is deterministic from durable message order and attachment metadata; a
* provider can serialize the returned messages without reading omitted bytes.
* @param messages - complete request history, oldest first.
* @param maxRequestImageBytes - positive bound on total base64 image payload; undefined preserves every image.
* @returns the original messages when they already fit, otherwise shallow message copies with replaced content trees.
*/
function offloadRequestImages(messages, maxRequestImageBytes) {
	return offloadRequestImagesWithPolicy(messages, {
		representation: "base64",
		...maxRequestImageBytes === void 0 ? {} : { maxBytes: maxRequestImageBytes },
		byteQuantum: 1,
		placeholder: () => OFFLOADED_IMAGE_TEXT
	});
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
	const placeholder = policy.placeholder ?? (() => "[image omitted to keep the request within its image limit; older images are omitted first. If this image is still needed, read its file again when a path is available; otherwise ask the user to attach it again.]");
	return messages.map((message) => {
		const content = replaceOldestImages(message.content, remaining, placeholder);
		return content === message.content ? message : {
			...message,
			content
		};
	});
}
//#endregion
//#region lib/types/remote.js
/** Native Typert Remote projections owned by the LLM configuration domain. */
const PROVIDER_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROVIDER_VERIFY_TIMEOUT_MS = 15e3;
const SECRET_HEADER_NAME = /authorization|api[-_]?key|auth[-_]?token|access[-_]?token|token|secret|credential|password|cookie/i;
const transactionTails = /* @__PURE__ */ new WeakMap();
const transactionExecution = new AsyncLocalStorage();
/** Reserve every key together; acquire journal, namespace, then reference tiers. */
async function withTransactionKeys(owner, keys, operation) {
	if (keys.length === 0) return operation();
	const identity = Reflect.get(owner, symbols.original) ?? owner;
	let tails = transactionTails.get(identity);
	if (tails === void 0) {
		tails = /* @__PURE__ */ new Map();
		transactionTails.set(identity, tails);
	}
	const distinct = [...new Set(keys)].sort();
	const previous = distinct.flatMap((key) => tails.get(key) ?? []);
	const lease = Promise.withResolvers();
	for (const key of distinct) tails.set(key, lease.promise);
	try {
		await Promise.all(previous);
		return await operation();
	} finally {
		lease.resolve();
		for (const key of distinct) if (tails.get(key) === lease.promise) tails.delete(key);
		if (tails.size === 0) transactionTails.delete(identity);
	}
}
/** Hold one provider executor through settlement; reject recursive callback mutations. */
async function withProviderExecution(credentials, provider, signal, operation) {
	if (transactionExecution.getStore()?.active) remoteFailure("provider-transaction-reentrant", "provider mutation cannot be nested inside a running provider transaction", { provider });
	return withTransactionKeys(credentials, [`journal:${provider}`], async () => {
		assertProviderNotCancelled(signal);
		const execution = { active: true };
		try {
			return await transactionExecution.run(execution, operation);
		} finally {
			execution.active = false;
		}
	});
}
/** Before durable claim, cancellation leaves no credential or profile mutation. */
function assertProviderNotCancelled(signal) {
	if (signal?.aborted) remoteFailure("cancelled", "provider transaction was cancelled before durable claim", {});
}
/** Lock both removed and adopted references, including a staged generation. */
function transactionCredentialRefs(value, ops, settingsPath, suppliedRef) {
	return new Set([
		...providerCredentialRefs(value, settingsPath),
		...providerCredentialRefs(applyRemoteOps(value, ops), settingsPath),
		...suppliedRef === void 0 ? [] : [suppliedRef]
	]);
}
/**
* Whether an HTTP header value must live behind a credential reference.
* @param name - Header name to classify case-insensitively.
* @returns True for credential-, token-, cookie-, or password-bearing names.
*/
function isCredentialHeaderName(name) {
	return SECRET_HEADER_NAME.test(name.trim().toLowerCase());
}
/**
* Project the configured and live provider directories without giving writes a second owner.
* @param runtime - The runtime input.
* @returns The value produced by list remote providers.
*/
function listRemoteProviders(runtime) {
	const active = new Set(runtime.listProviders().map((provider) => provider.id));
	const declared = /* @__PURE__ */ new Set();
	const providers = runtime.listConfigurableProviders().map((entry) => {
		declared.add(entry.provider);
		return {
			provider: entry.provider,
			displayName: entry.displayName,
			settingsNs: entry.settingsNs,
			settingsPath: [...entry.settingsPath],
			active: active.has(entry.provider),
			...entry.declared === void 0 ? {} : { declared: entry.declared },
			...entry.migrationRequired === void 0 ? {} : { migrationRequired: {
				code: entry.migrationRequired.code,
				fields: [...entry.migrationRequired.fields]
			} }
		};
	});
	for (const provider of runtime.listProviders()) {
		if (declared.has(provider.id)) continue;
		providers.push({
			provider: provider.id,
			displayName: provider.name,
			settingsNs: "",
			settingsPath: [],
			active: true
		});
	}
	return { providers };
}
/**
* Build a failure-isolated host-scoped model catalog.
* @param runtime - The runtime input.
* @returns The value produced by list remote models.
*/
async function listRemoteModels(runtime) {
	const catalog = await Promise.all(runtime.listProviders().map(async (provider) => {
		try {
			const models = await runtime.listModels(provider.id);
			const rows = await Promise.all(models.map(async (model) => {
				return projectRemoteModel(model, await runtime.resolveModelInfo(provider.id, model.id));
			}));
			return {
				kind: "group",
				group: {
					id: provider.id,
					name: provider.name,
					models: rows
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
		groups: catalog.flatMap((entry) => entry.kind === "group" && entry.group.models.length > 0 ? [entry.group] : []),
		failures: catalog.flatMap((entry) => entry.kind === "failure" ? [entry.failure] : [])
	};
}
/**
* Discover a draft provider's models without storing or returning its one-shot secret.
* @param runtime - The runtime input.
* @param request - The request input.
* @param signal - The signal input.
* @returns The value produced by discover remote models.
*/
async function discoverRemoteModels(runtime, request, signal) {
	if (signal.aborted) remoteFailure("cancelled", "model discovery was cancelled", {});
	try {
		const models = await runtime.discoverModels(request.settingsNs, {
			...request.provider === void 0 ? {} : { provider: request.provider },
			...request.baseURL === void 0 ? {} : { baseURL: request.baseURL },
			...request.api === void 0 ? {} : { api: request.api },
			...request.apiKey === void 0 ? {} : { apiKey: request.apiKey },
			signal
		});
		if (isAborted(signal)) remoteFailure("cancelled", "model discovery was cancelled", {});
		return { models: models.map(remoteDiscoveredModel) };
	} catch (error) {
		if (isTypertRemoteFailure(error)) throw error;
		if (isRemoteFailure(error)) throwRemoteFailure(error);
		if (isAborted(signal)) remoteFailure("cancelled", "model discovery was cancelled", {});
		remoteFailure("model-discovery-failed", "provider model discovery failed", {
			settingsNs: request.settingsNs,
			...request.baseURL === void 0 ? {} : { baseURL: request.baseURL }
		});
	}
}
/**
* Read one provider transaction without returning its operations or secrets.
* @param runtime - Live provider registry used only for terminal live-state projection.
* @param ctx - Host context containing the secure credential journal provider.
* @param request - Provider id and transaction UUID to inspect.
* @returns Durable phase, credential requirement, and optional live state.
*/
async function providerTransactionStatus(runtime, ctx, request) {
	if (!PROVIDER_PATTERN.test(request.provider) || !UUID_PATTERN.test(request.transactionId)) remoteFailure("input-invalid", "provider transaction status needs a valid provider and UUID", {});
	const credentials = ctx.get("credentials");
	if (credentials === void 0) remoteFailure("service-unavailable", "credentials service is absent", {});
	const record = await readProviderJournal(credentials, request.provider);
	const payload = record?.kind === "grant" && isRecord(record.payload) ? record.payload : void 0;
	if (payload === void 0 || payload.transactionId !== request.transactionId) return {
		state: "absent",
		needsCredential: false
	};
	const phase = payload.phase;
	const outcome = payload.outcome;
	const state = phase === "done" ? outcome === "committed" || outcome === "rolled-back" || outcome === "committed-not-live" ? outcome : "absent" : phase === "prepared" || phase === "credential-staged" || phase === "settings-applied" || phase === "credential-applied" ? phase : "absent";
	if (state === "absent") remoteFailure("provider-transaction-in-doubt", "provider transaction journal is unreadable", {
		provider: request.provider,
		transactionId: request.transactionId
	});
	const plan = isRecord(payload.plan) ? payload.plan : void 0;
	const credential = plan !== void 0 && isCredentialPlan(plan.credential) ? plan.credential : void 0;
	let needsCredential = phase !== "done" && credential?.op === "set";
	if (needsCredential && credential !== void 0) {
		const current = await credentials.resolve(remoteCredentialRef(credential.ref));
		needsCredential = current === void 0 || hash(current.value) !== credential.valueDigest;
	}
	return {
		state,
		needsCredential,
		...typeof payload.settingsNs === "string" ? { settingsNs: payload.settingsNs } : {},
		...phase === "done" ? { live: outcome === "committed" && runtime.listProviders().some((row) => row.id === request.provider) } : {}
	};
}
/**
* Resume a durable provider transaction without asking the caller to rebuild its settings operations.
* @param runtime - Provider and model registry receiving the resumed commit.
* @param ctx - Host context containing settings and secure credential services.
* @param request - Provider id, transaction UUID, and optional credential replay.
* @param signal - Cancellation before a durable claim; claimed work keeps ownership until settled.
* @returns Committed provider mutation view or the journal's terminal failure.
*/
async function resumeRemoteProvider(runtime, ctx, request, signal) {
	if (!PROVIDER_PATTERN.test(request.provider) || !UUID_PATTERN.test(request.transactionId)) remoteFailure("input-invalid", "provider transaction resume needs a valid provider and UUID", {});
	const credentials = ctx.get("credentials");
	if (credentials === void 0) remoteFailure("service-unavailable", "credentials service is absent", {});
	return withProviderExecution(credentials, request.provider, signal, () => readAndResumeProvider(runtime, ctx, credentials, request, signal));
}
/** Read recovery metadata only after owning its provider journal. */
async function readAndResumeProvider(runtime, ctx, credentials, request, signal) {
	const journal = parseJournal(await readProviderJournal(credentials, request.provider), request.provider, request.transactionId);
	if (journal.transactionId !== request.transactionId || journal.provider !== request.provider) remoteFailure("provider-transaction-in-doubt", "the requested provider transaction is not current", {
		provider: request.provider,
		transactionId: request.transactionId
	});
	const settings = ctx.get("settings");
	if (settings === void 0) remoteFailure("service-unavailable", "settings service is absent", {});
	const ns = remoteSettingsNamespace(journal.settingsNs);
	return withTransactionKeys(settings, [`namespace:${journal.settingsNs}`], () => {
		assertProviderNotCancelled(signal);
		const refs = transactionCredentialRefs(settings.describe().find((candidate) => candidate.ns === ns)?.value, journal.plan.ops, journal.plan.settingsPath, journal.plan.credential?.ref);
		return withTransactionKeys(credentials, [...refs].map((ref) => `reference:${ref}`), () => resumeProviderJournal(runtime, settings, credentials, request, journal, refs, signal));
	});
}
/** Resolve a replay secret and complete recovery within all three resource tiers. */
async function resumeProviderJournal(runtime, settings, credentials, request, journal, refs, signal) {
	assertProviderNotCancelled(signal);
	if (journal.phase === "done") {
		requireCommittedJournal(journal, request.provider, request.transactionId);
		const ns = remoteSettingsNamespace(journal.settingsNs);
		const ref = journal.plan.credential === void 0 ? void 0 : remoteCredentialRef(journal.plan.credential.ref);
		return remoteMutationResult(runtime, settings, credentials, ns, journal.provider, journal.settingsNs, ref);
	}
	const credentialPlan = journal.plan.credential;
	let credential;
	if (credentialPlan?.op === "unset") credential = {
		op: "unset",
		ref: credentialPlan.ref
	};
	else if (credentialPlan?.op === "set") {
		const ref = remoteCredentialRef(credentialPlan.ref);
		const current = await credentials.resolve(ref);
		const value = request.credentialValue ?? (current !== void 0 && hash(current.value) === credentialPlan.valueDigest ? current.value : void 0);
		if (value === void 0 || hash(value) !== credentialPlan.valueDigest) remoteFailure("provider-transaction-needs-credential", "the durable provider transaction needs its write-only credential again", {
			provider: request.provider,
			transactionId: request.transactionId,
			ref: credentialPlan.ref
		});
		credential = {
			op: "set",
			ref: credentialPlan.ref,
			value
		};
	}
	return mutateProviderRequest(runtime, settings, credentials, {
		transactionId: journal.transactionId,
		provider: journal.provider,
		settingsNs: journal.settingsNs,
		ops: journal.plan.ops,
		expectedRevision: journal.plan.expectedRevision,
		...credential === void 0 ? {} : { credential }
	}, journal, signal, refs);
}
/**
* Run one bounded exact-route request without exposing provider output.
* @param runtime - Provider registry that performs the exact model verification.
* @param request - Provider/model route to probe.
* @param signal - Caller cancellation combined with the fixed verification deadline.
* @returns Verification mode and accepted state; model output is discarded.
*/
async function verifyRemoteProvider(runtime, request, signal) {
	if (!PROVIDER_PATTERN.test(request.provider) || request.model.trim().length === 0) remoteFailure("input-invalid", "provider verification needs a valid provider and model", {});
	const deadline = AbortSignal.timeout(PROVIDER_VERIFY_TIMEOUT_MS);
	const bounded = AbortSignal.any([signal, deadline]);
	let mode;
	try {
		mode = await runtime.verifyModel(request.provider, request.model, bounded);
	} catch (error) {
		if (error?.code === "VERIFICATION_STILL_RUNNING") remoteFailure("provider-verification-still-running", "provider verification ignored cancellation and remains owner-tracked", {
			provider: request.provider,
			model: request.model,
			state: "still-running"
		});
		if (signal.aborted) remoteFailure("cancelled", "provider verification was cancelled", {});
		if (deadline.aborted) remoteFailure("provider-verification-timeout", "provider verification timed out", {
			provider: request.provider,
			model: request.model
		});
		if (isTypertRemoteFailure(error)) throw error;
		remoteFailure("provider-verification-failed", "provider/model authentication verification failed", {
			provider: request.provider,
			model: request.model
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
}
/**
* Commit a provider configuration change with a secret-free durable retry receipt.
* @param runtime - Provider registry used for ownership and activation checks.
* @param ctx - Host settings and credential service owners.
* @param request - Provider mutation with its expected settings revision and transaction id.
* @param signal - Cancellation before durable claim; late cancellation does not interrupt commit.
* @returns The committed redacted view, or a typed conflict, cancellation or recovery failure.
*/
async function mutateRemoteProvider(runtime, ctx, request, signal) {
	validateProviderRequest(request);
	const settings = ctx.get("settings");
	if (settings === void 0) remoteFailure("service-unavailable", "settings service is absent", {});
	const credentials = ctx.get("credentials");
	if (credentials === void 0) remoteFailure("service-unavailable", "credentials service is absent", {});
	return withProviderExecution(credentials, request.provider, signal, () => withTransactionKeys(settings, [`namespace:${request.settingsNs}`], () => mutateProviderRequest(runtime, settings, credentials, request, void 0, signal)));
}
/** Share mutation admission while preserving an explicit resume's original journal. */
async function mutateProviderRequest(runtime, settings, credentials, request, journalSnapshot, signal, heldRefs) {
	assertProviderNotCancelled(signal);
	validateProviderRequest(request);
	const ns = remoteSettingsNamespace(request.settingsNs);
	const declaration = runtime.listConfigurableProviders().find((entry) => entry.provider === request.provider && entry.settingsNs === request.settingsNs);
	if (declaration === void 0) remoteFailure("settings-rejected", `provider "${request.provider}" is not declared by settings namespace "${request.settingsNs}"`, { ns: request.settingsNs });
	const before = settings.describe().find((candidate) => candidate.ns === ns);
	if (before === void 0) remoteFailure("settings-rejected", `settings namespace "${request.settingsNs}" is not registered`, { ns: request.settingsNs });
	const replay = await endpointMutationReplay(credentials, declaration, request, journalSnapshot);
	const stagedRequest = replay?.request ?? endpointBoundMutationRequest(declaration, before.value, request);
	validateProviderRequest(stagedRequest);
	const plan = replay?.plan ?? {
		...mutationPlan(declaration.settingsPath, stagedRequest),
		...stagedRequest === request ? {} : { requestDigest: mutationDigest(request.provider, request.settingsNs, mutationPlan(declaration.settingsPath, request)) }
	};
	const refs = transactionCredentialRefs(before.value, stagedRequest.ops, declaration.settingsPath, stagedRequest.credential?.ref);
	if (request.credential !== void 0) refs.add(request.credential.ref);
	const execute = () => {
		assertProviderNotCancelled(signal);
		if (replay?.phase !== "done") {
			validateProviderOwnership(declaration.settingsPath, before.value, stagedRequest);
			validateCredentialScope(runtime, settings, declaration, before.value, stagedRequest);
			validateProviderSecrets(settings, ns, stagedRequest);
		}
		return mutateProviderTransaction(runtime, settings, credentials, ns, stagedRequest, plan, replay?.phase, signal);
	};
	if (heldRefs !== void 0) {
		if ([...refs].some((ref) => !heldRefs.has(ref))) remoteFailure("provider-transaction-in-doubt", "provider resume reference ownership changed before commit", { provider: request.provider });
		return execute();
	}
	return withTransactionKeys(credentials, [...refs].map((ref) => `reference:${ref}`), execute);
}
async function mutateProviderTransaction(runtime, settings, credentials, ns, request, plan, replay, signal) {
	const credential = request.credential;
	const ref = credential === void 0 ? void 0 : remoteCredentialRef(credential.ref);
	if (replay !== "done" && credential !== void 0 && ref !== void 0) await ensureWritableCredential(credentials, ref, credential.ref);
	const digest = mutationDigest(request.provider, request.settingsNs, plan);
	const journalKey = credentialKey("llm-remote", request.provider);
	const proposed = {
		version: 1,
		transactionId: request.transactionId,
		digest,
		provider: request.provider,
		settingsNs: request.settingsNs,
		plan,
		phase: "prepared"
	};
	let journal;
	assertProviderNotCancelled(signal);
	try {
		journal = await claimJournal(credentials, journalKey, proposed, request, replay);
	} catch (error) {
		if (isTypertRemoteFailure(error)) throw error;
		if (isRemoteFailure(error)) throwRemoteFailure(error);
		remoteFailure("provider-transaction-in-doubt", "provider transaction journal could not be acquired", {
			provider: request.provider,
			transactionId: request.transactionId
		});
	}
	if (journal.phase === "done") {
		requireCommittedJournal(journal, request.provider, request.transactionId);
		return remoteMutationResult(runtime, settings, credentials, ns, request.provider, request.settingsNs, ref);
	}
	let active = journal;
	if (replay === void 0) {
		const current = settings.describe().find((candidate) => candidate.ns === ns);
		if (current === void 0) remoteFailure("provider-transaction-in-doubt", `settings namespace "${request.settingsNs}" disappeared before provider mutation`, {
			provider: request.provider,
			transactionId: request.transactionId
		});
		if (current.revision !== active.plan.expectedRevision) await rejectProviderRevision(credentials, journalKey, active, ns, current.revision);
	}
	if (active.phase === "prepared" && active.plan.credential?.op === "set") {
		await applyCredentialPlan(credentials, active, request.credential);
		active = {
			...active,
			phase: "credential-staged"
		};
		try {
			await writeJournal(credentials, journalKey, active);
		} catch {
			remoteFailure("provider-transaction-in-doubt", "provider credential staging could not be journaled", {
				provider: request.provider,
				transactionId: request.transactionId
			});
		}
	}
	if (active.phase === "prepared" || active.phase === "credential-staged") {
		const current = settings.describe().find((candidate) => candidate.ns === ns);
		if (current === void 0) remoteFailure("provider-transaction-in-doubt", `settings namespace "${request.settingsNs}" disappeared before provider mutation`, {
			provider: request.provider,
			transactionId: request.transactionId
		});
		let settingsCommitted = remoteOpsSatisfied(current.user, active.plan.ops);
		if (!settingsCommitted) {
			if (current.revision !== active.plan.expectedRevision) await rejectProviderRevision(credentials, journalKey, active, ns, current.revision);
			try {
				await settings.mutate(ns, active.plan.ops, active.plan.expectedRevision);
				settingsCommitted = true;
			} catch (error) {
				const after = settings.describe().find((candidate) => candidate.ns === ns);
				settingsCommitted = after !== void 0 && remoteOpsSatisfied(after.user, active.plan.ops);
				if (!settingsCommitted) {
					const failure = settingsFailureValue(request.settingsNs, error);
					try {
						await finishJournal(credentials, journalKey, active, "rolled-back", failure);
					} catch {
						remoteFailure("provider-transaction-in-doubt", "provider rollback receipt could not be persisted", {
							provider: request.provider,
							transactionId: request.transactionId
						});
					}
					throwRemoteFailure(failure);
				}
			}
		}
		active = {
			...active,
			phase: "settings-applied"
		};
		try {
			await writeJournal(credentials, journalKey, active);
		} catch {
			remoteFailure("provider-transaction-in-doubt", "provider settings commit could not be journaled", {
				provider: request.provider,
				transactionId: request.transactionId
			});
		}
	}
	if (active.phase === "settings-applied") {
		if (active.plan.credential !== void 0) {
			await applyCredentialPlan(credentials, active, request.credential);
			active = {
				...active,
				phase: "credential-applied"
			};
			try {
				await writeJournal(credentials, journalKey, active);
			} catch {
				remoteFailure("provider-transaction-in-doubt", "provider credential commit could not be journaled", {
					provider: request.provider,
					transactionId: request.transactionId
				});
			}
		}
	}
	const committed = postWriteNamespace(settings, ns, request.settingsNs);
	let accepted = false;
	try {
		accepted = await settings.settle(ns, committed.revision);
	} catch (error) {
		const failure = settingsFailureValue(request.settingsNs, error);
		await finishOrInDoubt(credentials, journalKey, active, "committed-not-live", failure);
		throwRemoteFailure(failure);
	}
	if (!accepted || !runtime.listProviders().some((provider) => provider.id === request.provider)) {
		const failure = {
			code: "provider-registration-rejected",
			message: `provider "${request.provider}" settings were stored but its live route rejected the configuration`,
			details: {
				provider: request.provider,
				transactionId: request.transactionId
			}
		};
		await finishOrInDoubt(credentials, journalKey, active, "committed-not-live", failure);
		throwRemoteFailure(failure);
	}
	await finishOrInDoubt(credentials, journalKey, active, "committed");
	return remoteMutationResult(runtime, settings, credentials, ns, request.provider, request.settingsNs, ref);
}
/** Reuse the durable conflict receipt both before staging and after external drift. */
async function rejectProviderRevision(credentials, key, active, ns, revision) {
	const failure = settingsFailureValue(active.settingsNs, new SettingsConflictError(ns, active.plan.expectedRevision, revision));
	try {
		await finishJournal(credentials, key, active, "rolled-back", failure);
	} catch {
		remoteFailure("provider-transaction-in-doubt", "provider stale-write receipt could not be persisted", {
			provider: active.provider,
			transactionId: active.transactionId
		});
	}
	throwRemoteFailure(failure);
}
async function remoteMutationResult(runtime, settings, credentials, ns, provider, nsName, ref) {
	if (!runtime.listProviders().some((entry) => entry.id === provider)) remoteFailure("provider-registration-rejected", "committed provider route is not live", { ns: nsName });
	const info = ref === void 0 ? void 0 : await credentials.describe(ref);
	return {
		settings: postWriteNamespace(settings, ns, nsName),
		...info === void 0 ? {} : { credential: {
			configured: info.configured,
			...info.source === void 0 ? {} : { source: info.source },
			writable: info.writable
		} },
		live: { accepted: true }
	};
}
function postWriteNamespace(settings, ns, nsName) {
	const descriptor = settings.describe({ redactSecrets: true }).find((candidate) => candidate.ns === ns);
	if (descriptor === void 0) remoteFailure("internal", `settings namespace "${nsName}" was disposed after its write`, {});
	return remoteNamespaceView(descriptor);
}
/**
* Canonical provider/model projection shared by every catalog caller.
* @param model - Declared model identity and display metadata.
* @param resolved - Adapter-resolved limits and reasoning capabilities.
* @returns Client-safe model view with normalized string reasoning ids.
*/
function projectRemoteModel(model, resolved) {
	const reasoning = resolved.reasoning === void 0 ? void 0 : {
		efforts: resolved.reasoning.efforts.map((effort) => ({
			id: String(effort.id),
			name: effort.name,
			...effort.description === void 0 ? {} : { description: effort.description }
		})),
		...resolved.reasoning.defaultEffort === void 0 ? {} : { defaultEffort: String(resolved.reasoning.defaultEffort) }
	};
	return {
		id: model.id,
		name: model.name,
		...model.description === void 0 ? {} : { description: model.description },
		...resolved.defaultMaxTokens === void 0 ? {} : { defaultMaxTokens: resolved.defaultMaxTokens },
		...reasoning === void 0 ? {} : { reasoning }
	};
}
function remoteDiscoveredModel(model) {
	return {
		id: model.id,
		...model.name === void 0 ? {} : { name: model.name },
		...model.contextWindow === void 0 ? {} : { contextWindow: model.contextWindow },
		...model.maxTokens === void 0 ? {} : { maxTokens: model.maxTokens }
	};
}
function validateProviderRequest(request) {
	if (!UUID_PATTERN.test(request.transactionId)) remoteFailure("input-invalid", "provider mutation transactionId must be a UUID", { field: "transactionId" });
	if (!PROVIDER_PATTERN.test(request.provider)) remoteFailure("input-invalid", "provider mutation provider must be lower-kebab-case", { field: "provider" });
	if (request.settingsNs.length === 0) remoteFailure("input-invalid", "provider mutation settingsNs must be non-empty", { field: "settingsNs" });
	if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0) remoteFailure("input-invalid", "provider mutation expectedRevision must be a non-negative safe integer", { field: "expectedRevision" });
	if (!Array.isArray(request.ops) || request.ops.length > 64) remoteFailure("input-invalid", "provider mutation ops must contain at most 64 operations", { field: "ops" });
	if (request.ops.length === 0 && request.credential === void 0) remoteFailure("settings-rejected", "provider mutation must change settings, a credential, or both", { ns: request.settingsNs });
	for (const op of request.ops) if (!isSettingsPathOperation(op)) remoteFailure("input-invalid", "provider mutation operations must carry an op and string path", { field: "ops" });
	if (remoteOpsOverlap(request.ops)) remoteFailure("settings-rejected", "provider mutation paths must not overlap", { ns: request.settingsNs });
	if (request.credential?.op === "set" && request.credential.value.trim().length === 0) remoteFailure("input-invalid", "provider credential value must be non-empty", { field: "credential.value" });
	if (request.credential !== void 0) remoteCredentialRef(request.credential.ref);
}
/** Reuse a claimed endpoint generation for exact retries and durable resumes. */
async function endpointMutationReplay(credentials, declaration, request, journalSnapshot) {
	const record = journalSnapshot === void 0 ? await readProviderJournal(credentials, request.provider) : {
		kind: "grant",
		payload: journalSnapshot
	};
	const payload = record?.kind === "grant" && isRecord(record.payload) ? record.payload : void 0;
	if (payload?.transactionId !== request.transactionId) return void 0;
	const journal = parseJournal(record, request.provider, request.transactionId, request, declaration.settingsPath);
	const { requestDigest, ...durableInput } = journal.plan;
	const inputDigest = mutationDigest(request.provider, request.settingsNs, mutationPlan(declaration.settingsPath, request));
	if (journal.provider !== request.provider || journal.settingsNs !== request.settingsNs || !deepEqualJson(journal.plan.settingsPath, declaration.settingsPath) || payload.plan !== void 0 && mutationDigest(journal.provider, journal.settingsNs, journal.plan) !== journal.digest || inputDigest !== requestDigest && inputDigest !== mutationDigest(journal.provider, journal.settingsNs, durableInput)) remoteFailure("provider-transaction-in-doubt", "provider transaction retry does not match its durable endpoint plan", {
		provider: request.provider,
		transactionId: request.transactionId
	});
	const credential = journal.plan.credential;
	if (credential?.op !== request.credential?.op) remoteFailure("provider-transaction-in-doubt", "provider transaction retry changed its credential operation", {
		provider: request.provider,
		transactionId: request.transactionId
	});
	return {
		request: {
			...request,
			ops: journal.plan.ops,
			expectedRevision: journal.plan.expectedRevision,
			...request.credential === void 0 || credential === void 0 ? {} : { credential: {
				...request.credential,
				ref: credential.ref
			} }
		},
		plan: journal.plan,
		phase: journal.phase
	};
}
/**
* Repointing an endpoint never overwrites the credential reference the old
* live generation still reads. A deterministic transaction-scoped reference
* is staged first, and the settings switch later points every matching profile
* slot at that new version.
*/
function endpointBoundMutationRequest(declaration, currentValue, request) {
	if (request.credential?.op !== "set") return request;
	const candidateValue = applyRemoteOps(currentValue, request.ops);
	const beforeFingerprint = providerEndpointFingerprint(declaration, currentValue);
	const afterFingerprint = providerEndpointFingerprint(declaration, candidateValue);
	if (beforeFingerprint === afterFingerprint) return request;
	if (!providerCredentialRefs(currentValue, declaration.settingsPath).has(request.credential.ref)) return request;
	const versionRef = endpointBoundCredentialRef(declaration.provider, request.transactionId, afterFingerprint, request.credential.ref);
	const referencePaths = providerCredentialReferencePaths(candidateValue, declaration.settingsPath, request.credential.ref);
	const ops = request.ops.map((op) => structuredClone(op));
	for (const referencePath of referencePaths) {
		const ownerIndex = ops.findIndex((op) => pathStartsWith(referencePath, op.path));
		if (ownerIndex === -1) {
			ops.push({
				op: "set",
				path: referencePath,
				value: versionRef
			});
			continue;
		}
		const owner = ops[ownerIndex];
		if (owner === void 0) throw new Error("provider mutation owner index was lost");
		if (owner.op !== "set") remoteFailure("credential-version-required", "endpoint change cannot inherit a credential through an unset profile ancestor", {
			provider: request.provider,
			ref: request.credential.ref
		});
		ops[ownerIndex] = {
			...owner,
			value: setValueAtPath(owner.value, referencePath.slice(owner.path.length), versionRef)
		};
	}
	return {
		...request,
		ops,
		credential: {
			op: "set",
			ref: versionRef,
			value: request.credential.value
		}
	};
}
/** Deterministic, valid environment-style name for one endpoint generation. */
function endpointBoundCredentialRef(provider, transactionId, endpointFingerprint, sourceRef) {
	return `ARK_${provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_V_${hash(JSON.stringify({
		transactionId,
		endpointFingerprint,
		sourceRef
	})).slice(0, 24).toUpperCase()}`;
}
/** Absolute profile paths whose current value names one credential reference. */
function providerCredentialReferencePaths(root, settingsPath, ref) {
	const selected = pathValue(root, settingsPath);
	if (!selected.present || !isRecord(selected.value)) return [];
	const paths = [];
	if (selected.value.apiKeyEnv === ref) paths.push([...settingsPath, "apiKeyEnv"]);
	if (isRecord(selected.value.credentialHeaders)) {
		for (const [header, value] of Object.entries(selected.value.credentialHeaders)) if (value === ref) paths.push([
			...settingsPath,
			"credentialHeaders",
			header
		]);
	}
	return paths;
}
function setValueAtPath(root, path, value) {
	const [head, ...rest] = path;
	if (head === void 0) return value;
	const record = isRecord(root) ? root : {};
	return {
		...record,
		[head]: setValueAtPath(record[head], rest, value)
	};
}
/** Read one secure provider journal without exposing a storage-specific failure. */
async function readProviderJournal(credentials, provider) {
	try {
		return await credentials.readRecord(credentialKey("llm-remote", provider));
	} catch {
		remoteFailure("service-unavailable", "provider transaction journal is unavailable", {});
	}
}
/** Return only when a terminal journal committed; otherwise replay its durable failure. */
function requireCommittedJournal(journal, provider, transactionId) {
	if (journal.outcome === "committed") return;
	throwRemoteFailure(journal.error ?? {
		code: journal.outcome === "committed-not-live" ? "provider-registration-rejected" : "settings-rejected",
		message: "provider transaction did not commit successfully",
		details: {
			provider,
			transactionId
		}
	});
}
/** Confine a provider transaction to its declared profile and credential. */
function validateProviderOwnership(settingsPath, currentValue, request) {
	for (const op of request.ops) if (!pathStartsWith(op.path, settingsPath)) remoteFailure("settings-rejected", `provider "${request.provider}" cannot mutate a sibling settings path`, {
		provider: request.provider,
		path: [...op.path]
	});
	const credential = request.credential;
	if (credential === void 0) return;
	const before = providerCredentialRefs(currentValue, settingsPath);
	const after = providerCredentialRefs(applyRemoteOps(currentValue, request.ops), settingsPath);
	if (credential.op === "set") {
		if (!after.has(credential.ref)) remoteFailure("credential-rejected", `provider "${request.provider}" credential is not bound to its resulting profile`, {
			provider: request.provider,
			ref: credential.ref
		});
		return;
	}
	if (!before.has(credential.ref) || after.has(credential.ref)) remoteFailure("credential-rejected", `provider "${request.provider}" cannot unset an unrelated or still-referenced credential`, {
		provider: request.provider,
		ref: credential.ref
	});
}
/** Credential references named by one exact provider profile. */
function providerCredentialRefs(root, settingsPath) {
	const selected = pathValue(root, settingsPath);
	if (!selected.present || !isRecord(selected.value)) return /* @__PURE__ */ new Set();
	const refs = /* @__PURE__ */ new Set();
	if (typeof selected.value.apiKeyEnv === "string" && selected.value.apiKeyEnv.length > 0) refs.add(selected.value.apiKeyEnv);
	if (isRecord(selected.value.credentialHeaders)) {
		for (const ref of Object.values(selected.value.credentialHeaders)) if (typeof ref === "string" && ref.length > 0) refs.add(ref);
	}
	return refs;
}
/**
* Keep a credential reference bound to one provider and endpoint generation.
* Repointing an endpoint or adopting another provider's reference requires the
* write-only credential in the same transaction; a reference-only edit can
* never disclose an existing secret to a new endpoint.
*/
function validateCredentialScope(runtime, settings, declaration, currentValue, request) {
	const descriptors = new Map(settings.describe().map((row) => [String(row.ns), row.value]));
	const current = runtime.listConfigurableProviders().flatMap((entry) => providerCredentialUses(entry, descriptors.get(entry.settingsNs)));
	const candidate = providerCredentialUses(declaration, applyRemoteOps(currentValue, request.ops));
	const suppliedRef = request.credential?.op === "set" ? request.credential.ref : void 0;
	for (const use of candidate) {
		const conflicts = current.filter((existing) => existing.ref === use.ref && (existing.provider !== use.provider || existing.fingerprint !== use.fingerprint));
		if (conflicts.some((existing) => existing.provider !== use.provider) || conflicts.length > 0 && suppliedRef !== use.ref) remoteFailure("credential-ownership-rejected", `credential reference "${use.ref}" belongs to another provider or endpoint`, {
			provider: request.provider,
			ref: use.ref
		});
		if (!current.some((existing) => existing.ref === use.ref && existing.provider === use.provider && existing.fingerprint === use.fingerprint) && suppliedRef !== use.ref) remoteFailure("credential-ownership-required", `credential reference "${use.ref}" needs an explicit value for this provider endpoint`, {
			provider: request.provider,
			ref: use.ref
		});
	}
	if (request.credential?.op === "unset") {
		if (current.some((use) => use.ref === request.credential?.ref && (use.provider !== request.provider || candidate.some((next) => next.ref === use.ref)))) remoteFailure("credential-ownership-rejected", `credential reference "${request.credential.ref}" is still owned by a provider endpoint`, {
			provider: request.provider,
			ref: request.credential.ref
		});
	}
}
/** Extract only reference and endpoint ownership facts; never credential values. */
function providerCredentialUses(entry, root) {
	const selected = pathValue(root, entry.settingsPath);
	if (!selected.present || !isRecord(selected.value)) return [];
	const profile = selected.value;
	const refs = /* @__PURE__ */ new Set();
	if (typeof profile.apiKeyEnv === "string" && profile.apiKeyEnv.length > 0) refs.add(profile.apiKeyEnv);
	if (isRecord(profile.credentialHeaders)) {
		for (const ref of Object.values(profile.credentialHeaders)) if (typeof ref === "string" && ref.length > 0) refs.add(ref);
	}
	const fingerprint = providerEndpointFingerprint(entry, root);
	return [...refs].map((ref) => ({
		provider: entry.provider,
		ref,
		fingerprint
	}));
}
/** Identity of one provider's exact endpoint/protocol routing generation. */
function providerEndpointFingerprint(entry, root) {
	const selected = pathValue(root, entry.settingsPath);
	const profile = selected.present && isRecord(selected.value) ? selected.value : {};
	return hash(JSON.stringify({
		provider: entry.provider,
		settingsNs: entry.settingsNs,
		settingsPath: entry.settingsPath,
		baseURL: typeof profile.baseURL === "string" ? profile.baseURL.replace(/\/+$/, "") : null,
		api: typeof profile.api === "string" ? profile.api : null
	}));
}
/** Refuse any operation that would copy a schema-declared secret into the journal. */
function validateProviderSecrets(settings, ns, request) {
	let secrets;
	try {
		secrets = settings.previewMutation(ns, request.ops).secrets;
	} catch (error) {
		remoteSettingsFailure(request.settingsNs, error);
	}
	if (request.ops.some((op) => secrets.some((secret) => pathStartsWith(op.path, secret.path) || pathStartsWith(secret.path, op.path)))) remoteFailure("settings-rejected", "provider settings transactions cannot carry literal secret fields; use credential references", {
		provider: request.provider,
		ns: request.settingsNs
	});
}
/** Whether `path` is the declared profile itself or one of its descendants. */
function pathStartsWith(path, prefix) {
	return prefix.length <= path.length && prefix.every((part, index) => path[index] === part);
}
/** Apply already-validated Remote path operations to a detached JSON value. */
function applyRemoteOps(root, ops) {
	return ops.reduce((current, op) => applyRemoteOp(current, op, op.path), structuredClone(root ?? {}));
}
/** Immutable path update used only for credential/profile ownership preflight. */
function applyRemoteOp(root, op, path) {
	const [head, ...rest] = path;
	if (head === void 0) return op.op === "unset" ? {} : structuredClone(op.value);
	const record = isRecord(root) ? root : {};
	if (rest.length === 0) {
		if (op.op === "set") return {
			...record,
			[head]: structuredClone(op.value)
		};
		const { [head]: _removed, ...kept } = record;
		return kept;
	}
	const child = record[head];
	if (op.op === "unset" && !isRecord(child)) return record;
	return {
		...record,
		[head]: applyRemoteOp(child, op, rest)
	};
}
/** Produce the secret-free durable transaction plan. */
function mutationPlan(settingsPath, request) {
	let ops;
	try {
		const encoded = JSON.stringify(request.ops);
		ops = JSON.parse(encoded);
		if (!deepEqualJson(ops, request.ops)) throw new TypeError("not lossless JSON");
	} catch {
		remoteFailure("input-invalid", "provider mutation operations must contain only lossless JSON values", { field: "ops" });
	}
	const credential = request.credential === void 0 ? void 0 : request.credential.op === "set" ? {
		op: "set",
		ref: request.credential.ref,
		valueDigest: hash(request.credential.value)
	} : {
		op: "unset",
		ref: request.credential.ref
	};
	return {
		settingsPath: [...settingsPath],
		ops,
		expectedRevision: request.expectedRevision,
		...credential === void 0 ? {} : { credential }
	};
}
async function ensureWritableCredential(credentials, ref, displayRef) {
	try {
		if (!(await credentials.describe(ref)).writable) remoteFailure("credential-rejected", `credential ${displayRef} is supplied by a read-only source`, { ref: displayRef });
	} catch (error) {
		if (isTypertRemoteFailure(error)) throw error;
		if (isRemoteFailure(error)) throwRemoteFailure(error);
		remoteFailure("credential-rejected", `credential "${displayRef}" was rejected`, { ref: displayRef });
	}
}
/** Reach one journaled credential state without ever persisting its value. */
async function applyCredentialPlan(credentials, active, supplied) {
	const plan = active.plan.credential;
	if (plan === void 0) return;
	const ref = remoteCredentialRef(plan.ref);
	if (plan.op === "unset") {
		if (!await credentialMatches(credentials, ref, void 0)) try {
			await credentials.unset(ref);
		} catch {
			if (!await credentialMatches(credentials, ref, void 0)) remoteFailure("provider-transaction-in-doubt", `credential "${plan.ref}" did not reach its requested state`, {
				provider: active.provider,
				transactionId: active.transactionId
			});
		}
		return;
	}
	const current = await credentials.resolve(ref);
	if (current !== void 0 && hash(current.value) === plan.valueDigest) return;
	if (supplied?.op !== "set" || supplied.ref !== plan.ref || hash(supplied.value) !== plan.valueDigest) remoteFailure("provider-transaction-needs-credential", "the durable provider transaction needs its write-only credential again", {
		provider: active.provider,
		transactionId: active.transactionId,
		ref: plan.ref
	});
	try {
		await credentials.set(ref, supplied.value);
	} catch {
		const after = await credentials.resolve(ref);
		if (after === void 0 || hash(after.value) !== plan.valueDigest) remoteFailure("provider-transaction-in-doubt", `credential "${plan.ref}" did not reach its requested state`, {
			provider: active.provider,
			transactionId: active.transactionId
		});
	}
}
async function finishOrInDoubt(credentials, key, active, outcome, error) {
	try {
		await finishJournal(credentials, key, active, outcome, error);
	} catch {
		remoteFailure("provider-transaction-in-doubt", "provider terminal receipt could not be persisted", {
			provider: active.provider,
			transactionId: active.transactionId
		});
	}
}
function remoteSettingsNamespace(value) {
	try {
		return settingsNamespace(value);
	} catch (error) {
		remoteSettingsFailure(value, error);
	}
}
function remoteCredentialRef(value) {
	try {
		return credentialRef(value);
	} catch (error) {
		remoteFailure("input-invalid", errorMessage(error), { ref: value });
	}
}
function remoteSettingsFailure(ns, error) {
	throwRemoteFailure(settingsFailureValue(ns, error));
}
function settingsFailureValue(ns, error) {
	if (error instanceof SettingsConflictError) return {
		code: "settings-conflict",
		message: error.message,
		details: {
			ns,
			expected: error.expected,
			actual: error.actual
		}
	};
	return {
		code: "settings-rejected",
		message: `settings write for "${ns}" was rejected`,
		details: { ns }
	};
}
function remoteOpsOverlap(ops) {
	return ops.some((left, index) => ops.some((right, otherIndex) => {
		if (index === otherIndex) return false;
		const shortest = Math.min(left.path.length, right.path.length);
		return left.path.length <= right.path.length && left.path.slice(0, shortest).every((segment, part) => segment === right.path[part]);
	}));
}
function remoteOpsSatisfied(user, ops) {
	return ops.every((op) => {
		if (op.op === "unset" && op.path.length === 0) return user === void 0 || deepEqualJson(user, {});
		const current = pathValue(user, op.path);
		return op.op === "unset" ? !current.present : current.present && deepEqualJson(current.value, op.value);
	});
}
function pathValue(root, path) {
	if (path.length === 0) return root === void 0 ? { present: false } : {
		present: true,
		value: root
	};
	let current = root;
	for (const part of path) {
		if (!isRecord(current) || !Object.hasOwn(current, part)) return { present: false };
		current = current[part];
	}
	return {
		present: true,
		value: current
	};
}
function mutationDigest(provider, settingsNs, plan) {
	return hash(JSON.stringify({
		provider,
		settingsNs,
		settingsPath: plan.settingsPath,
		ops: plan.ops,
		credential: plan.credential,
		requestDigest: plan.requestDigest
	}));
}
function hash(value) {
	return createHash("sha256").update(value).digest("hex");
}
async function claimJournal(credentials, key, proposed, request, replay) {
	let selected;
	await credentials.modifyRecord(key, (current) => {
		const currentPayload = current?.kind === "grant" && isRecord(current.payload) ? current.payload : void 0;
		if (replay !== void 0 && currentPayload?.transactionId !== proposed.transactionId) remoteFailure("provider-transaction-in-doubt", "provider transaction ownership changed before replay claim", {
			provider: proposed.provider,
			transactionId: proposed.transactionId
		});
		if (current === void 0) {
			selected = proposed;
			return Promise.resolve({
				kind: "grant",
				payload: proposed
			});
		}
		const journal = parseJournal(current, proposed.provider, proposed.transactionId, request, proposed.plan.settingsPath);
		if (replay === "done" && journal.phase !== "done") remoteFailure("provider-transaction-in-doubt", "completed provider transaction became active before receipt replay", {
			provider: proposed.provider,
			transactionId: proposed.transactionId
		});
		if (journal.transactionId === proposed.transactionId) {
			if (mutationDigest(journal.provider, journal.settingsNs, journal.plan) !== proposed.digest) remoteFailure("provider-transaction-in-doubt", "provider transaction id was reused with different input", {
				provider: proposed.provider,
				transactionId: proposed.transactionId
			});
			if (journal.digest !== proposed.digest) {
				if (currentPayload?.plan !== void 0) remoteFailure("provider-transaction-in-doubt", "provider transaction journal digest does not match its durable plan", {
					provider: proposed.provider,
					transactionId: proposed.transactionId
				});
				const upgraded = {
					...journal,
					digest: proposed.digest
				};
				selected = upgraded;
				return Promise.resolve({
					kind: "grant",
					payload: upgraded
				});
			}
			selected = journal;
			return Promise.resolve(void 0);
		}
		if (journal.phase !== "done") remoteFailure("provider-transaction-in-doubt", "provider already has an unfinished configuration transaction", {
			provider: proposed.provider,
			transactionId: proposed.transactionId
		});
		selected = proposed;
		return Promise.resolve({
			kind: "grant",
			payload: proposed
		});
	});
	if (selected === void 0) remoteFailure("provider-transaction-in-doubt", "provider transaction journal was not acquired", {
		provider: proposed.provider,
		transactionId: proposed.transactionId
	});
	return selected;
}
async function writeJournal(credentials, key, next) {
	await credentials.modifyRecord(key, (current) => {
		const journal = parseJournal(current, next.provider, next.transactionId);
		if (journal.transactionId !== next.transactionId || journal.digest !== next.digest || mutationDigest(journal.provider, journal.settingsNs, journal.plan) !== journal.digest) remoteFailure("provider-transaction-in-doubt", "provider transaction ownership changed during commit", {
			provider: next.provider,
			transactionId: next.transactionId
		});
		return Promise.resolve({
			kind: "grant",
			payload: next
		});
	});
}
async function finishJournal(credentials, key, active, outcome, error) {
	await writeJournal(credentials, key, {
		version: 1,
		transactionId: active.transactionId,
		digest: active.digest,
		provider: active.provider,
		settingsNs: active.settingsNs,
		plan: active.plan,
		phase: "done",
		outcome,
		...error === void 0 ? {} : { error: secretFreeFailure(error) }
	});
}
async function credentialMatches(credentials, ref, expected) {
	return (await credentials.resolve(ref))?.value === expected;
}
function parseJournal(record, provider, transactionId, request, settingsPath = []) {
	const payload = record?.kind === "grant" && isRecord(record.payload) ? record.payload : void 0;
	if (payload === void 0 || payload.version !== 1 || typeof payload.transactionId !== "string" || typeof payload.digest !== "string" || typeof payload.provider !== "string" || typeof payload.settingsNs !== "string" || payload.phase !== "prepared" && payload.phase !== "credential-staged" && payload.phase !== "settings-applied" && payload.phase !== "credential-applied" && payload.phase !== "done") remoteFailure("provider-transaction-in-doubt", `provider "${provider}" has an unreadable secure transaction journal`, {
		provider,
		transactionId
	});
	if (payload.phase === "done") {
		if (payload.outcome !== "committed" && payload.outcome !== "rolled-back" && payload.outcome !== "committed-not-live") remoteFailure("provider-transaction-in-doubt", `provider "${provider}" has an unreadable terminal transaction journal`, {
			provider,
			transactionId
		});
		const plan = parsePlan(payload.plan, payload, request, settingsPath, provider, transactionId);
		return {
			version: 1,
			transactionId: payload.transactionId,
			digest: payload.digest,
			provider: payload.provider,
			settingsNs: payload.settingsNs,
			plan,
			phase: "done",
			outcome: payload.outcome,
			...isRemoteFailure(payload.error) ? { error: secretFreeFailure(payload.error) } : {}
		};
	}
	const plan = parsePlan(payload.plan, payload, request, settingsPath, provider, transactionId);
	return {
		version: 1,
		transactionId: payload.transactionId,
		digest: payload.digest,
		provider: payload.provider,
		settingsNs: payload.settingsNs,
		plan,
		phase: payload.phase
	};
}
/** Parse a current plan, or safely upgrade an earlier request-bound journal. */
function parsePlan(value, legacy, request, settingsPath, provider, transactionId) {
	if (isRecord(value) && Array.isArray(value.settingsPath) && value.settingsPath.every((part) => typeof part === "string") && Array.isArray(value.ops) && value.ops.every(isSettingsPathOperation) && typeof value.expectedRevision === "number" && Number.isSafeInteger(value.expectedRevision) && value.expectedRevision >= 0 && (value.credential === void 0 || isCredentialPlan(value.credential)) && (value.requestDigest === void 0 || typeof value.requestDigest === "string" && /^[a-f0-9]{64}$/.test(value.requestDigest))) return {
		settingsPath: [...value.settingsPath],
		ops: structuredClone(value.ops),
		expectedRevision: value.expectedRevision,
		...value.credential === void 0 ? {} : { credential: { ...value.credential } },
		...value.requestDigest === void 0 ? {} : { requestDigest: value.requestDigest }
	};
	if (request !== void 0 && legacy.transactionId !== request.transactionId) return {
		settingsPath: [],
		ops: [],
		expectedRevision: 0
	};
	if (request !== void 0) {
		const candidates = /* @__PURE__ */ new Set();
		if (typeof legacy.expectedRevision === "number" && Number.isSafeInteger(legacy.expectedRevision)) candidates.add(legacy.expectedRevision);
		candidates.add(request.expectedRevision);
		if (request.expectedRevision > 0) candidates.add(request.expectedRevision - 1);
		for (const expectedRevision of candidates) {
			if (expectedRevision < 0) continue;
			const plan = mutationPlan(settingsPath, {
				...request,
				expectedRevision
			});
			const legacyDigest = hash(JSON.stringify({
				provider: request.provider,
				settingsNs: request.settingsNs,
				ops: request.ops,
				expectedRevision,
				credential: request.credential?.op === "set" ? {
					op: "set",
					ref: request.credential.ref,
					valueDigest: hash(request.credential.value)
				} : request.credential
			}));
			if (legacy.digest === legacyDigest) return plan;
		}
	}
	remoteFailure("provider-transaction-in-doubt", `provider "${provider}" has a legacy transaction that needs an exact retry`, {
		provider,
		transactionId
	});
}
function isCredentialPlan(value) {
	if (!isRecord(value) || typeof value.ref !== "string") return false;
	return value.op === "unset" ? value.valueDigest === void 0 : value.op === "set" && typeof value.valueDigest === "string";
}
function secretFreeFailure(failure) {
	return {
		code: failure.code,
		message: failure.message,
		details: Object.fromEntries(Object.entries(failure.details).filter(([key]) => !/key|token|secret|password/i.test(key)))
	};
}
function isRemoteFailure(value) {
	return isRecord(value) && typeof value.code === "string" && typeof value.message === "string" && isRecord(value.details);
}
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** Read a mutable AbortSignal after an await without retaining stale flow narrowing. */
function isAborted(signal) {
	return signal.aborted;
}
/** Validate a path mutation at the Remote boundary before domain mutation sees it. */
function isSettingsPathOperation(value) {
	if (!isRecord(value)) return false;
	return (value.op === "set" || value.op === "unset") && Array.isArray(value.path) && value.path.every((part) => typeof part === "string");
}
/** Preserve a typed Remote failure through the strict Gateway's Error-only control flow. */
function throwRemoteFailure(failure) {
	throw new TypertLookupFailure(failure);
}
function remoteFailure(code, message, details) {
	throwRemoteFailure({
		code,
		message,
		details
	});
}
function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}
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
//#region lib/types/adapter.js
/**
* The adapter contract surface: what a provider adapter implements, what a
* registration returns, and the prepared-call snapshot. Provider packages
* (pi-ai, deepseek) depend on this module; the runtime imports it too.
*
* @module @deepseek-ai/dsh-llm/adapter
*/
/**
* Build one live image-access resolver from the provider composition's service lookups.
* Keeping this in the adapter contract layer gives every provider the same attachment/path
* behavior without making the provider-neutral LLM package own a filesystem service.
* @param resolveAttachments - resolves the currently mounted attachment store.
* @param mapHostPath - maps a host path through the currently mounted filesystem service.
* @returns a resolver that observes both services at call time.
*/
function createImageAttachmentAccessResolver(resolveAttachments, mapHostPath) {
	return (ref) => {
		const attachments = resolveAttachments();
		return attachments === void 0 ? void 0 : resolveImageAttachmentAccess(attachments, mapHostPath, ref);
	};
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
	* Resolve synchronous provider-side request-image pricing for one exact
	* route. Adapters without visual-token billing return undefined.
	* @param _provider - one provider route owned by this adapter.
	* @param _model - exact model id whose image input will be priced.
	* @returns synchronous image-pricing metadata, or `undefined` when unsupported.
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
	* Perform a protocol-native, non-generative authentication/metadata probe
	* when the adapter supports one. Returning `undefined` asks LlmRuntime to use
	* its explicitly classified minimal-generation fallback.
	* @param _provider - exact registered provider route.
	* @param _model - exact configured model id.
	* @param _signal - owner cancellation signal.
	* @returns the non-generative mode, or undefined for the bounded fallback.
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
/**
* The abstract `llm` service: an adapter registry plus a streaming model-call
* API, interceptable via the `llm/stream` waterfall.
*/
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
* Stable identity for the exact endpoint/protocol a one-shot discovery
* credential may reach. The fingerprint contains no credential material.
* @param baseURL - candidate endpoint typed by the caller.
* @param api - candidate wire protocol, defaulted like the discovery owner.
* @returns SHA-256 endpoint identity.
*/
function modelDiscoveryEndpointFingerprint(baseURL, api) {
	const endpoint = baseURL.replace(/\/+$/, "");
	return createHash("sha256").update(JSON.stringify({
		endpoint,
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
	let _remoteProviders_decorators;
	let _remoteMutateProvider_decorators;
	let _remoteProviderTransaction_decorators;
	let _remoteResumeProvider_decorators;
	let _remoteModels_decorators;
	let _remoteDiscoverModels_decorators;
	let _remoteVerifyProvider_decorators;
	return class LlmRuntime extends _classSuper {
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_remoteProviders_decorators = [Remote("providers")];
			_remoteMutateProvider_decorators = [Remote("mutateProvider")];
			_remoteProviderTransaction_decorators = [Remote("providerTransaction")];
			_remoteResumeProvider_decorators = [Remote("resumeProvider")];
			_remoteModels_decorators = [Remote("models")];
			_remoteDiscoverModels_decorators = [Remote("discoverModels")];
			_remoteVerifyProvider_decorators = [Remote("verifyProvider")];
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
			if (_metadata) Object.defineProperty(this, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		adapters = (__runInitializers(this, _instanceExtraInitializers), /* @__PURE__ */ new Map());
		directory = /* @__PURE__ */ new Map();
		discoveries = /* @__PURE__ */ new Map();
		verifications = /* @__PURE__ */ new Map();
		constructor(ctx) {
			super(ctx, "llm");
			ctx.effect(() => () => {
				for (const state of this.verifications.values()) state.controller.abort(new LlmError("LLM runtime disposed during provider verification", "ABORTED"));
			}, "llm.providerVerifications");
			ctx.inject(["settings"], (sctx) => {
				this.syncProtectedSettingsNamespaces(sctx.settings);
			});
		}
		/** Keep generic Settings Remote writes out of provider-owned namespaces. */
		syncProtectedSettingsNamespaces(settings = this.ctx.get("settings")) {
			if (settings === void 0) return;
			const namespaces = [...new Set([...this.directory.values()].map((entry) => settingsNamespace(entry.settingsNs)))];
			settings.setRemoteProtectedNamespaces(namespaces);
		}
		/**
		* Read configurable providers through the domain-owned Native Remote.
		* @returns the redacted configurable-provider catalog.
		*/
		remoteProviders() {
			return listRemoteProviders(this.remoteRuntime());
		}
		/**
		* Commit one idempotent provider settings/credential transaction.
		* @param request - provider mutation and expected revision.
		* @param signal - Caller cancellation before durable claim; claimed commits retain ownership until settled.
		* @returns the committed provider mutation result.
		*/
		async remoteMutateProvider(request, signal) {
			return mutateRemoteProvider(this.remoteRuntime(), this.ctx, request, signal);
		}
		/**
		* Read the durable, secret-free state of one provider mutation.
		* @param request - Provider id and transaction UUID to inspect.
		* @returns Current durable phase and whether a staged credential is still required.
		*/
		async remoteProviderTransaction(request) {
			return providerTransactionStatus(this.remoteRuntime(), this.ctx, request);
		}
		/**
		* Continue one journaled provider mutation after Host or app restart.
		* @param request - Provider id, transaction UUID, and optional write-only credential replay.
		* @param signal - Caller cancellation before resuming a durable commit.
		* @returns Committed provider view or the transaction's durable terminal failure.
		*/
		async remoteResumeProvider(request, signal) {
			return resumeRemoteProvider(this.remoteRuntime(), this.ctx, request, signal);
		}
		/**
		* Read the failure-isolated host-scoped model catalog.
		* @returns the model catalog grouped by provider.
		*/
		async remoteModels() {
			return listRemoteModels(this.remoteRuntime());
		}
		/**
		* Interrogate a draft endpoint with an optional write-only one-shot key.
		* @param request - draft endpoint and discovery options.
		* @param signal - caller-owned cancellation signal.
		* @returns discovered models and provider diagnostics.
		*/
		async remoteDiscoverModels(request, signal) {
			return discoverRemoteModels(this.remoteRuntime(), request, signal);
		}
		/**
		* Execute one bounded exact provider/model/auth probe.
		* @param request - Exact provider and model route to verify.
		* @param signal - Caller cancellation combined with the Host verification deadline.
		* @returns Verification mode used by the adapter or fallback request.
		*/
		async remoteVerifyProvider(request, signal) {
			return verifyRemoteProvider(this.remoteRuntime(), request, signal);
		}
		/** Present only public LLM operations to the Remote adapter. */
		remoteRuntime() {
			return {
				listProviders: () => this.listProviders(),
				listConfigurableProviders: () => this.listConfigurableProviders(),
				listModels: (provider) => this.listModels(provider),
				resolveModelInfo: (provider, model, signal) => this.resolveModelInfo(provider, model, signal),
				discoverModels: (settingsNs, request) => this.discoverModels(settingsNs, request),
				verifyModel: (provider, model, signal) => this.verifyModel(provider, model, signal)
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
		/** Release a fire-and-forget registration without leaking cleanup failures. */
		disposeRegistration(dispose, owner) {
			try {
				Promise.resolve(dispose()).catch((error) => {
					this.warnRegistrationDisposalFailure(owner, error);
				});
			} catch (error) {
				this.warnRegistrationDisposalFailure(owner, error);
			}
		}
		/** Record a registration cleanup failure through the service logger. */
		warnRegistrationDisposalFailure(owner, error) {
			this.ctx.logger.warn(`llm: ${owner}: disposal failed`);
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
			const handle = (() => {
				this.disposeRegistration(dispose, "registerAdapter()");
			});
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
					settingsNamespace(entry.settingsNs);
					if (entry.settingsPath.some((segment) => segment.length === 0)) throw new LlmError(`configurable provider "${entry.provider}" has an empty settingsPath segment`, "INVALID_DIRECTORY");
					if (entry.migrationRequired !== void 0 && (entry.migrationRequired.fields.length === 0 || entry.migrationRequired.fields.some((field) => field.length === 0))) throw new LlmError(`configurable provider "${entry.provider}" has invalid migration metadata`, "INVALID_DIRECTORY");
					if (this.directory.has(entry.provider) && !own.has(entry.provider) || detached.some((seen) => seen.provider === entry.provider)) throw new LlmError(`configurable provider "${entry.provider}" is already declared`, "DUPLICATE_DIRECTORY");
					detached.push({
						...entry,
						settingsPath: [...entry.settingsPath],
						...entry.migrationRequired === void 0 ? {} : { migrationRequired: {
							code: entry.migrationRequired.code,
							fields: [...entry.migrationRequired.fields]
						} }
					});
				}
				for (const entry of held) this.directory.delete(entry.provider);
				for (const entry of detached) this.directory.set(entry.provider, entry);
				held = detached;
				this.syncProtectedSettingsNamespaces();
				this.emitAdaptersUpdated();
			};
			const dispose = this.ctx.effect(function* () {
				if (entries.length === 0) throw new LlmError("a configurable-provider registration must declare at least one provider", "INVALID_DIRECTORY");
				commit(entries);
				yield () => {
					disposed = true;
					for (const entry of held) this.directory.delete(entry.provider);
					held = [];
					this.syncProtectedSettingsNamespaces();
					this.emitAdaptersUpdated();
				};
			}.bind(this), "llm.registerConfigurableProviders()");
			const handle = (() => {
				this.disposeRegistration(dispose, "registerConfigurableProviders()");
			});
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
				...entry.migrationRequired === void 0 ? {} : { migrationRequired: {
					code: entry.migrationRequired.code,
					fields: [...entry.migrationRequired.fields]
				} }
			}));
		}
		/**
		* Offer to interrogate provider endpoints on behalf of the settings
		* namespace this plugin owns. The namespace is the key because that is what
		* a configuration surface already holds from the configurable-provider
		* directory, and because a provider being *added* has no route to name yet.
		* Disposed with the fiber.
		* @param settingsNs - the namespace whose profiles this discovery serves.
		* @param discover - interrogates one endpoint; must honor `request.signal`.
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
			return () => {
				this.disposeRegistration(dispose, "registerModelDiscovery()");
			};
		}
		/**
		* Interrogate one provider endpoint for the models it advertises. The
		* request describes a draft, not a stored route, so nothing here reads or
		* writes settings or credentials — the caller owns both, and the reply is
		* candidate metadata a surface may offer for adoption.
		* @param settingsNs - namespace whose registered discovery serves this draft.
		* @param request - the endpoint, protocol, and one-shot credential to use.
		* @returns the advertised models, deduplicated in endpoint order.
		*/
		async discoverModels(settingsNs, request) {
			const discover = this.discoveries.get(settingsNs);
			if (discover === void 0) throw new LlmError(`no model discovery is registered for "${settingsNs}"`, "NO_DISCOVERY");
			if ((request.provider ?? "").length === 0 && (request.baseURL ?? "").length === 0) throw new LlmError("model discovery needs a provider route or a baseURL", "INVALID_DISCOVERY");
			const bound = request.apiKey === void 0 ? request : {
				...request,
				credentialEndpointFingerprint: modelDiscoveryEndpointFingerprint(request.baseURL ?? "", request.api)
			};
			if (request.apiKey !== void 0 && (request.baseURL ?? "").length === 0) throw new LlmError("a one-shot discovery credential requires its exact candidate baseURL", "INVALID_DISCOVERY");
			const discovered = await discover(bound);
			const seen = /* @__PURE__ */ new Set();
			const models = [];
			for (const model of discovered) {
				if (typeof model.id !== "string" || model.id.length === 0 || seen.has(model.id)) continue;
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
		* Resolve the retry policy captured when one provider route was registered.
		* @param provider - registered provider route to inspect.
		* @returns the provider-owned policy, with normal defaults already resolved.
		*/
		providerRetryPolicy(provider) {
			return this.registration(provider).retryPolicy;
		}
		/**
		* Resolve route-owned request-image pricing without performing I/O. Unknown
		* routes intentionally degrade to heuristic pricing for historical logs.
		* @param provider - provider route whose registered adapter owns pricing.
		* @param model - exact model id whose image occurrences will be priced.
		* @returns route-owned pricing, or `undefined` when the route supplies none.
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
		/**
		* Prove an exact provider/model route can authenticate and complete a bounded
		* request. The caller supplies the deadline signal; no output is retained or
		* returned to configuration surfaces.
		* @param provider - Registered provider route to authenticate.
		* @param model - Exact model id to probe.
		* @param signal - Caller-owned deadline and cancellation signal.
		* @returns Adapter-native or bounded fallback verification mode.
		*/
		async verifyModel(provider, model, signal) {
			signal.throwIfAborted();
			const key = `${provider}\0${model}`;
			if (this.verifications.has(key)) throw new LlmError(`provider verification for "${provider}/${model}" is still running`, "VERIFICATION_STILL_RUNNING");
			const registration = this.registration(provider);
			const controller = new AbortController();
			const operation = this.performProviderVerification(registration, provider, model, controller.signal);
			const state = {
				controller,
				operation
			};
			this.verifications.set(key, state);
			operation.then(() => {
				if (this.verifications.get(key) === state) this.verifications.delete(key);
			}, () => {
				if (this.verifications.get(key) === state) this.verifications.delete(key);
			});
			const aborted = Promise.withResolvers();
			const forwardAbort = () => {
				aborted.resolve("aborted");
			};
			signal.addEventListener("abort", forwardAbort, { once: true });
			if (signal.aborted) forwardAbort();
			try {
				const outcome = await Promise.race([operation.then((mode) => ({
					kind: "completed",
					mode
				}), (error) => ({
					kind: "failed",
					error
				})), aborted.promise.then(() => ({ kind: "aborted" }))]);
				if (outcome.kind === "completed") {
					signal.throwIfAborted();
					return outcome.mode;
				}
				if (outcome.kind === "failed") throw outcome.error;
				controller.abort(signal.reason);
				if (!await settlesWithin(operation, 2e3)) throw new LlmError(`provider verification for "${provider}/${model}" ignored cancellation and is still running`, "VERIFICATION_STILL_RUNNING");
				signal.throwIfAborted();
				throw new LlmError("provider verification aborted", "ABORTED");
			} finally {
				signal.removeEventListener("abort", forwardAbort);
			}
		}
		/** Adapter-native metadata probe, falling back to one discarded-token handshake. */
		async performProviderVerification(registration, provider, model, signal) {
			const native = await registration.adapter.verifyProvider(provider, model, signal);
			if (native !== void 0) return native;
			const adapterCall = await registration.adapter.prepareCall(provider, model, signal);
			const modelInfo = this.normalizeModelInfo(registration, model, adapterCall.model);
			const config = this.resolveCallWithInfo({
				provider,
				model,
				maxTokens: 1
			}, modelInfo).config;
			let finish;
			for await (const chunk of adapterCall.stream({
				...config,
				messages: [createUserMessage({
					content: [{
						type: "text",
						text: "."
					}],
					source: {
						kind: "plugin",
						plugin: "llm-verification"
					}
				})],
				signal
			})) if (chunk.type === "finish") finish = chunk.reason;
			signal.throwIfAborted();
			if (finish === void 0) throw new LlmError("provider verification stream closed without a terminal frame", "STREAM_CLOSED");
			if (finish.kind === "error" || finish.kind === "aborted") throw new LlmError(finish.failure.message, finish.failure.code);
			return "minimal-generation";
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
			if (context !== void 0 && (!Number.isInteger(context.contextWindow) || context.contextWindow <= 0)) throw new LlmError(`adapter returned invalid context metadata for provider "${provider}" model "${model}"`, "INVALID_MODEL_CONTEXT");
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
				if (!completed) try {
					const close = iterator.return?.bind(iterator);
					if (close) await close();
				} catch (error) {
					this.ctx.logger.warn("llm: adapter stream cleanup failed");
					this.ctx.logger.warn(error);
				}
			}
		}
		/**
		* Stream one model call as raw chunks (token-level deltas). Replay state is
		* retained only when the same adapter instance owns its historical provider
		* and the target provider. Final adapter selection remains fixed through
		* asynchronous exact-model resolution and dispatch. Adapter selection,
		* dispatch, and iteration failures become terminal `error` or `aborted`
		* finish chunks; middleware, nested-call, and consumer failures remain
		* thrown. A downstream-close cleanup failure is logged so it cannot mask
		* the consumer's own completion or failure.
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
/** Wait briefly for an aborted adapter operation to prove ownership quiescence. */
async function settlesWithin(operation, timeoutMs) {
	const env_1 = {
		stack: [],
		error: void 0,
		hasError: false
	};
	try {
		const timeout = __addDisposableResource(env_1, deadline(void 0, timeoutMs, "LLM_ABORT_QUIESCENCE_TIMEOUT"), false);
		return await Promise.race([operation.then(() => true, () => true), new Promise((resolve) => {
			timeout.signal.addEventListener("abort", () => {
				resolve(false);
			}, { once: true });
		})]);
	} catch (e_1) {
		env_1.error = e_1;
		env_1.hasError = true;
	} finally {
		__disposeResources(env_1);
	}
}
//#endregion
export { APP_IDENTITY, BlockAssembler, CONTEXT_SUMMARY_MAX_CHARS, CONTEXT_WINDOW_EXCEEDED_CODE, CallId, EMPTY_RESPONSE_CODE, HarnessError, INVALID_CREDENTIAL_CODE, LlmAdapter, LlmError, LlmRuntime, LlmRuntime as default, MessageId, OFFLOADED_IMAGE_TEXT, ProviderRequestId, QUOTA_EXCEEDED_CODE, ReasoningEffortId, RetryPolicySchema, assertNever, assertUsableApiKey, attributionHeaders, boundContextSummary, callConfigEquals, contentHasImage, createAssistantMessage, createImageAttachmentAccessResolver, createMessage, createToolResultMessage, createUserMessage, deepFreeze, errorChain, freezeMessage, isAgentLoopRequest, isContextWindowExceededError, isCredentialHeaderName, isHarnessError, isQuotaExceededError, isTokenDelta, markAgentLoopRequest, modelDiscoveryEndpointFingerprint, normalizeApiKey, offloadRequestImages, offloadRequestImagesWithPolicy, offloadedImagePrefixCount, offloadedImageText, projectImagesForTextModel, projectRemoteModel, requestImageHandleText, resolveImageAttachmentAccess, resolveRetryPolicy, textOnlyImageText, userAgent };
