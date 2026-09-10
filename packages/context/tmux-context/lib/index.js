import { createRequire } from "node:module";
import z from "@deepseek-ai/schemastery";
import { addAbortListener } from "node:events";
import { createHash } from "node:crypto";
import { Service, isObject, symbols } from "@deepseek-ai/cordis";
import { AsyncLocalStorage } from "node:async_hooks";
import "node:path";
import "node:child_process";
import "node:os";
//#region ../../util/timeout/src/index.ts
/**
* Shared timeout arithmetic, signal fusion, and classification. The library
* only notifies through abort signals; each capability still owns the mechanism
* that stops its work and translates timeout reasons into public outcomes.
* @module @deepseek-ai/dsh-timeout
*/
/**
* Internal abort reason carrying a capability-owned code and elapsed deadline.
* Providers translate it through {@link timeoutOf} before returning to callers.
*/
var TimeoutReason = class extends Error {
	code;
	timeoutMs;
	name = "TimeoutReason";
	/**
	* @param code Capability-owned timeout code (e.g. `BASH_TIMEOUT`).
	* @param timeoutMs The deadline that elapsed, in milliseconds.
	*/
	constructor(code, timeoutMs) {
		super(`${code} after ${timeoutMs}ms`);
		this.code = code;
		this.timeoutMs = timeoutMs;
	}
};
/** Largest delay Node schedules without clamping it to one millisecond. */
const MAX_TIMER_DELAY_MS = 2147483647;
function assertTimerDelay(timeoutMs, name) {
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) throw new Error(`${name} must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`);
}
/**
* Fuse upstream cancellation with an identifiable timeout. `timeoutMs <= 0` is
* the internal no-timer sentinel; the returned disposer clears an armed timer.
* The signal only notifies, so callers must stop their own work.
*
* @param upstream The caller's cancellation signal, if any, fused into the result.
* @param timeoutMs Deadline in milliseconds; `<= 0` means "no timeout" (arm no timer).
* @param code Capability-owned code stamped onto the timeout's {@link TimeoutReason}.
* @returns The fused {@link Deadline} (signal + timer cleanup).
*/
function deadline(upstream, timeoutMs, code) {
	if (timeoutMs <= 0) return {
		signal: upstream ?? new AbortController().signal,
		[Symbol.dispose]() {}
	};
	assertTimerDelay(timeoutMs, "deadline timeoutMs");
	const timer = new AbortController();
	const id = setTimeout(() => {
		timer.abort(new TimeoutReason(code, timeoutMs));
	}, timeoutMs);
	return {
		signal: upstream !== void 0 ? AbortSignal.any([upstream, timer.signal]) : timer.signal,
		[Symbol.dispose]() {
			clearTimeout(id);
		}
	};
}
/**
* Recover a timeout reason from a reason-bearing object. Supplying `code`
* distinguishes this deadline from a nested upstream deadline; a foreign code
* follows the ordinary cancellation path.
*
* @param x An {@link AbortSignal} or any `{ reason }` carrier (e.g. a caught abort error).
* @param code When provided, only a {@link TimeoutReason} with this exact `code` matches.
* @returns The matching {@link TimeoutReason}, else `undefined`.
*/
function timeoutOf(x, code) {
	const reason = x.reason;
	if (!(reason instanceof TimeoutReason)) return void 0;
	return code === void 0 || reason.code === code ? reason : void 0;
}
//#endregion
//#region ../../typert/protocol/src/index.ts
/**
* Remote decorators and explicit Gateway bindings backed only by private
* module state. Strict reflection remains a Typert compiler responsibility.
* @module @deepseek-ai/dsh-typert-protocol
*/
const TYPERT_REMOTE_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/;
/**
* Test one generated Remote name against the Connection endpoint grammar.
* @param value - namespace, method, lookup, or Context segment.
* @returns whether the value can cross the shared RPC carrier unchanged.
*/
function isTypertRemoteSegment(value) {
	return value !== "." && value !== ".." && TYPERT_REMOTE_SEGMENT_PATTERN.test(value);
}
/** A business Remote rejection preserved by unary and stream carriers. */
var TypertRemoteFailure = class extends Error {
	/** Stable caller-facing failure payload. */
	failure;
	/**
	* Wrap one business rejection for transport without changing its code or details.
	* @param failure - business failure returned unchanged to the caller.
	*/
	constructor(failure) {
		super(failure.message);
		this.name = "TypertRemoteFailure";
		this.failure = failure;
	}
};
const markers = /* @__PURE__ */ new WeakMap();
/**
* Bind one visible Service field to a Cordis key and Remote namespace.
* @param service - owning Service instance, normally `this`.
* @param serviceKey - exact Cordis service key.
* @param options - optional distinct wire namespace.
* @returns a frozen, inspectable binding with no compiler-injected metadata.
*/
function bindTypertRemote(service, serviceKey, options = {}) {
	validateName("service key", serviceKey);
	const namespace = options.namespace ?? serviceKey;
	validateName("namespace", namespace);
	return Object.freeze({
		service,
		serviceKey,
		namespace
	});
}
/** Cordis Service base that exposes its registered name through Typert Gateway. */
var TypertRemoteService = class extends Service {
	/** Visible binding consumed by the Gateway's source-mode discovery. */
	typertRemote;
	/**
	* Register the Service and bind the same key to Typert Gateway.
	* @param ctx - owning Cordis Context.
	* @param serviceKey - exact Cordis service key and default wire namespace.
	* @param options - optional distinct wire namespace.
	*/
	constructor(ctx, serviceKey, options = {}) {
		super(ctx, serviceKey);
		this.typertRemote = bindTypertRemote(this, this.name, options);
	}
};
function Remote(methodExportOrOptions, context) {
	if (typeof methodExportOrOptions === "string") {
		validateName("Remote export name", methodExportOrOptions);
		return remoteDecorator({ kind: "direct" }, void 0, methodExportOrOptions);
	}
	if (typeof methodExportOrOptions === "object") {
		if (remoteOptionMode(methodExportOrOptions) !== "stream" || Reflect.ownKeys(methodExportOrOptions).length !== 1) throw new TypeError("typert-protocol: Remote options must contain exactly mode: \"stream\"");
		return remoteDecorator({ kind: "direct" }, "stream");
	}
	if (context === void 0) throw new TypeError("typert-protocol: Remote decorator context is missing");
	addMarkerInitializer(context, { kind: "direct" });
}
function remoteOptionMode(options) {
	return Reflect.get(options, "mode");
}
function remoteDecorator(invocation, mode, exportName) {
	return function(_method, context) {
		addMarkerInitializer(context, invocation, mode, exportName);
	};
}
function addMarkerInitializer(context, invocation, mode, exportName) {
	if (context.private || context.static || typeof context.name !== "string") throw new TypeError("typert-protocol: Remote decorators require a public instance method with a string name");
	const method = context.name;
	context.addInitializer(function() {
		const prototype = Object.getPrototypeOf(this);
		if (prototype === null) throw new TypeError(`typert-protocol: cannot mark Remote method "${method}" on an object without a prototype`);
		mark(prototype, method, invocation, mode, exportName);
	});
}
function mark(prototype, method, invocation, mode, exportName) {
	let table = markers.get(prototype);
	if (table === void 0) {
		table = /* @__PURE__ */ new Map();
		markers.set(prototype, table);
	}
	const marker = {
		...exportName === void 0 || exportName === method ? {} : { exportName },
		...mode === void 0 ? {} : { mode },
		invocation: Object.freeze(invocation)
	};
	const current = table.get(method);
	if (current !== void 0) {
		if (current.exportName === marker.exportName && current.mode === marker.mode && sameInvocation(current.invocation, invocation)) return;
		throw new Error(`typert-protocol: Remote method "${method}" has conflicting invocation markers`);
	}
	table.set(method, Object.freeze(marker));
}
function sameInvocation(left, right) {
	return left.kind === right.kind && (left.kind === "direct" || right.kind === "context" && left.context === right.context);
}
function validateName(subject, value) {
	if (!isTypertRemoteSegment(value)) throw new TypeError(`typert-protocol: ${subject} must contain only RPC endpoint segment characters`);
}
//#endregion
//#region ../../util/crypto/src/index.ts
/**
* Random v4 UUID, minted from `crypto.getRandomValues`.
* @returns the UUID string.
*/
function randomUUID() {
	const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
	const hex = Array.from(bytes, (byte, index) => {
		return (index === 6 ? byte & 15 | 64 : index === 8 ? byte & 63 | 128 : byte).toString(16).padStart(2, "0");
	}).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
//#endregion
//#region ../../llm/llm/src/brand.ts
/**
* Brand a message identifier.
* @param id - the opaque message identifier.
* @returns the same string, branded; no validation is performed.
*/
function MessageId(id) {
	return id;
}
//#endregion
//#region ../../llm/llm/src/call-config.ts
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
* Deep-freeze a value in place with an iterative traversal, guarding cycles,
* so later mutation throws without imposing a JavaScript call-stack depth cap.
* {@link AbortSignal} objects are deliberately skipped because they are the
* request's live cancellation channel and freezing them breaks abort.
* @param value - the value to freeze in place.
* @returns the same value, frozen.
*/
function deepFreeze$1(value) {
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
//#region ../../llm/llm/src/message.ts
/** Message value types, identity, and immutable construction helpers. */
/**
* Detach and deep-freeze a message whose identity already exists.
* @param message - complete message, including its stable identity.
* @returns an immutable snapshot that preserves the identity.
*/
function freezeMessage(message) {
	return deepFreeze$1(structuredClone(message));
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
//#endregion
//#region ../../llm/llm/src/error.ts
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
new RegExp(String.raw`(?:^|[^a-z0-9])context[\s_-](?:length|window)[\s_-]` + String.raw`(?:exceed(?:ed|s)?|overflow(?:ed)?|limit[\s_-]exceeded)(?:$|[^a-z0-9])`, "i");
new RegExp(String.raw`\b(?:request|prompt|input|messages?)\s+(?:is\s+|are\s+)?` + String.raw`too\s+(?:large|long)\s+for\s+(?:(?:this|the)\s+)?` + String.raw`(?:model(?:'s)?\s+)?context(?:\s+window)?\b`, "i");
new RegExp(String.raw`\b(?:input|prompt|request|messages?)\b.{0,40}` + String.raw`\b(?:exceed(?:s|ed)?|overflows?|is\s+larger\s+than)\b.{0,40}` + String.raw`\b(?:the\s+)?(?:model(?:'s)?\s+)?context(?:\s+(?:length|window))?\b`, "i");
//#endregion
//#region ../../llm/llm/src/retry-policy.ts
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
z.union([normalPolicySchema, alwaysPolicySchema]);
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
	if (!Number.isFinite(initialDelayMs) || initialDelayMs <= 0 || initialDelayMs > 2147483647) throw new Error(`${path}.initialDelayMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`);
	if (!Number.isFinite(maxDelayMs) || maxDelayMs <= 0 || maxDelayMs > 2147483647) throw new Error(`${path}.maxDelayMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`);
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
//#region ../../llm/llm/src/adapter-failure.ts
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
//#region ../../llm/llm/src/content.ts
/**
* Stable text shown to a model that cannot accept one durable image reference.
* @param ref - durable normalized attachment omitted from the request.
* @returns deterministic text-only placeholder.
*/
function textOnlyImageText(ref) {
	return `[image omitted because this model accepts text only; attachment sha256:${String(ref.attachmentId).slice(7, 15)}]`;
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
new Set([
	".html",
	".htm",
	".xhtml",
	".svg"
]);
//#endregion
//#region ../../settings/settings/src/redact.ts
/** Whether a value is a plain data object the walker may recurse into. */
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function children(node) {
	return [
		...Object.values(node.dict ?? {}),
		...[node.inner, node.sKey].filter((child) => child !== void 0),
		...node.list ?? []
	];
}
function assertPublicKeys(node) {
	if (node.sKey !== void 0 && containsSecret(node.sKey)) throw new TypeError("settings cannot expose secret dictionary keys");
}
function containsSecret(node, seen = /* @__PURE__ */ new Set()) {
	if (seen.has(node)) return false;
	seen.add(node);
	return node.meta?.role === "secret" || children(node).some((child) => containsSecret(child, seen));
}
function setProperty(record, key, value) {
	Object.defineProperty(record, key, {
		value,
		enumerable: true,
		configurable: true,
		writable: true
	});
}
function walk(node, value, path, secrets) {
	if (node === void 0) return value;
	if (node.meta?.role === "secret") {
		secrets.push({
			path,
			set: value !== void 0
		});
		return;
	}
	const shapeMatches = node.type === "object" || node.type === "dict" ? isRecord(value) : node.type === "array" || node.type === "tuple" ? Array.isArray(value) : true;
	if (value !== void 0 && !shapeMatches && containsSecret(node)) throw new TypeError("settings cannot safely redact a malformed secret-bearing container");
	switch (node.type) {
		case "object": {
			const properties = node.dict ?? {};
			const source = isRecord(value) ? value : void 0;
			const rebuilt = {};
			if (source !== void 0) for (const [key, entry] of Object.entries(source)) {
				if (Object.hasOwn(properties, key)) continue;
				setProperty(rebuilt, key, entry);
			}
			for (const [key, child] of Object.entries(properties)) {
				const stripped = walk(child, source !== void 0 && Object.hasOwn(source, key) ? source[key] : void 0, [...path, key], secrets);
				if (stripped !== void 0) setProperty(rebuilt, key, stripped);
			}
			return source === void 0 && Object.keys(rebuilt).length === 0 ? value : rebuilt;
		}
		case "dict": {
			assertPublicKeys(node);
			if (!isRecord(value)) return value;
			const rebuilt = {};
			for (const [key, entry] of Object.entries(value)) {
				const stripped = walk(node.inner, entry, [...path, key], secrets);
				if (stripped !== void 0) setProperty(rebuilt, key, stripped);
			}
			return rebuilt;
		}
		case "array":
			if (!Array.isArray(value)) return value;
			return value.map((entry, index) => walk(node.inner, entry, [...path, String(index)], secrets) ?? null);
		case "union":
		case "intersect": return (node.list ?? []).reduce((current, branch) => walk(branch, current, path, secrets), value);
		case "tuple":
			if (!Array.isArray(value)) return value;
			return value.map((entry, index) => walk(node.list?.[index], entry, [...path, String(index)], secrets) ?? null);
		default:
			if (containsSecret(node)) throw new TypeError(`settings cannot safely redact schema type "${node.type ?? "unknown"}"`);
			return value;
	}
}
//#endregion
//#region ../../settings/settings/src/index.ts
/**
* Service Definition for the user-settings capability seam (`ctx.settings`). Providers store one raw document of
* per-namespace sections; plugins register a namespace schema and read the
* resolved value, which layers schema defaults, the registrant's composition
* `base`, and the user document section, in that order.
* @module @deepseek-ai/dsh-settings
*/
const NAMESPACE_PATTERN = /^[a-z][a-z0-9-]*$/;
/**
* Brand a raw string as a {@link SettingsNamespace}.
* @param value - candidate namespace; lowercase kebab-case, as in plugin short names.
* @returns the branded namespace.
*/
function settingsNamespace(value) {
	if (!NAMESPACE_PATTERN.test(value)) throw new TypeError(`settings namespace "${value}" must match ${String(NAMESPACE_PATTERN)}`);
	return value;
}
/**
* Deep equality over JSON-compatible data (objects, arrays, primitives) — the
* Service Definition's single change-detection predicate, exported so the invariant
* companion checks exactly the implementation's relation.
* @param a - one JSON-compatible value.
* @param b - the other JSON-compatible value.
* @returns whether the two values are structurally equal.
*/
function deepEqualJson(a, b) {
	if (a === b) return true;
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
		return a.every((entry, index) => deepEqualJson(entry, b[index]));
	}
	const left = a;
	const right = b;
	const keys = Object.keys(left);
	if (keys.length !== Object.keys(right).length) return false;
	return keys.every((key) => Object.hasOwn(right, key) && deepEqualJson(left[key], right[key]));
}
/**
* A write refused because the namespace moved since the caller read it. The
* Service Definition's serialized write queue orders writes; it cannot tell a fresh writer
* from one holding a stale snapshot, which is what this reports.
*/
var SettingsConflictError = class extends Error {
	/** Stable machine code for wire layers mapping this to their own taxonomy. */
	code = "SETTINGS_CONFLICT";
	/** The revision the write expected. */
	expected;
	/** The revision the namespace actually stands at. */
	actual;
	/**
	* @param ns - the namespace whose write was refused.
	* @param expected - the revision the caller sent.
	* @param actual - the revision now stored.
	*/
	constructor(ns, expected, actual) {
		super(`settings namespace "${ns}" changed since it was read (expected revision ${String(expected)}, now ${String(actual)})`);
		this.name = "SettingsConflictError";
		this.expected = expected;
		this.actual = actual;
	}
};
/** Whether a value is a plain data object (not an array, null, or class instance). */
function isPlainObject(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}
/** Apply one path op to a detached section, returning the next section. */
function applyPathOp(section, op) {
	const [head, ...rest] = op.path;
	if (head === void 0) {
		if (op.op === "unset") return {};
		if (!isPlainObject(op.value)) throw new TypeError("settings mutate: setting the section root requires a plain object");
		return { ...op.value };
	}
	if (rest.length === 0) {
		if (op.op === "set") return {
			...section,
			[head]: op.value
		};
		const { [head]: _removed, ...kept } = section;
		return kept;
	}
	const child = Object.hasOwn(section, head) ? section[head] : void 0;
	if (!isPlainObject(child)) {
		if (op.op === "unset") return section;
		return {
			...section,
			[head]: applyPathOp({}, {
				...op,
				path: rest
			})
		};
	}
	return {
		...section,
		[head]: applyPathOp(child, {
			...op,
			path: rest
		})
	};
}
/** Human label for a value that lossless JSON cannot represent (numbers reject inline). */
function describeRejected(value) {
	if (value === void 0) return "undefined";
	if (typeof value === "object" && value !== null) {
		const name = Object.getPrototypeOf(value)?.constructor?.name;
		return name === void 0 || name === "Object" ? "a non-plain object" : `a ${name}`;
	}
	return `a ${typeof value}`;
}
/**
* Detach and validate one write input in a single walk before persistence:
* only JSON data (plain objects, arrays, strings, finite numbers,
* booleans, `null`) may reach a provider document. `structuredClone` alone
* would admit Dates, Maps, BigInts, and cycles that YAML/JSON storage then
* silently distorts on the reload round-trip. `undefined` entries in objects
* are skipped — the same sparse-patch semantics as {@link mergeLayers} — while
* an `undefined` array entry is rejected rather than coerced.
* @param root - plain-object write input (caller-checked).
* @param reject - builds the validation error from a value label and its `$`-rooted path.
* @returns the detached JSON-compatible clone.
*/
function cloneJsonShaped(root, reject) {
	const visiting = /* @__PURE__ */ new WeakSet();
	const clone = (value, path) => {
		if (value === null || typeof value === "string" || typeof value === "boolean") return value;
		if (typeof value === "number") {
			if (!Number.isFinite(value)) throw reject("a non-finite number", path);
			if (Object.is(value, -0)) throw reject("negative zero", path);
			return value;
		}
		if (Array.isArray(value)) {
			if (visiting.has(value)) throw reject("a circular reference", path);
			visiting.add(value);
			const entries = [];
			for (let index = 0; index < value.length; index++) entries.push(clone(value[index], `${path}[${index}]`));
			visiting.delete(value);
			return entries;
		}
		if (isPlainObject(value)) return cloneObject(value, path);
		throw reject(describeRejected(value), path);
	};
	const cloneObject = (value, path) => {
		if (visiting.has(value)) throw reject("a circular reference", path);
		visiting.add(value);
		const out = {};
		for (const [key, entry] of Object.entries(value)) {
			if (entry === void 0) continue;
			Object.defineProperty(out, key, {
				value: clone(entry, `${path}.${key}`),
				enumerable: true,
				writable: true,
				configurable: true
			});
		}
		visiting.delete(value);
		return out;
	};
	return cloneObject(root, "$");
}
/**
* Layer `over` onto `under`: plain objects merge recursively, every other
* value (arrays included) replaces the lower layer wholesale. `over` never
* carries `undefined` entries — sections come from parsed documents and write
* snapshots pass {@link cloneJsonShaped}, which strips them so a sparse patch
* cannot erase lower keys.
*/
function mergeLayers(under, over) {
	if (over === void 0) return under;
	if (!isPlainObject(under) || !isPlainObject(over)) return over;
	const merged = { ...under };
	for (const [key, value] of Object.entries(over)) Object.defineProperty(merged, key, {
		value: Object.hasOwn(merged, key) ? mergeLayers(merged[key], value) : value,
		enumerable: true,
		writable: true,
		configurable: true
	});
	return merged;
}
/** Recursively freeze one resolved value so handed-out snapshots stay immutable. */
function deepFreeze(value) {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
	for (const entry of Object.values(value)) deepFreeze(entry);
	return Object.freeze(value);
}
new AsyncLocalStorage();
Service.init;
/**
* Project an already-redacted descriptor as detached, lossless Remote data.
* @param descriptor - descriptor obtained with secret redaction enabled.
* @returns a namespace view that carries no provider-owned object references.
*/
function remoteNamespaceView(descriptor) {
	return {
		ns: String(descriptor.ns),
		schema: snapshotSettingsJson(descriptor.schema),
		value: snapshotSettingsJson(descriptor.value),
		...descriptor.base === void 0 ? {} : { base: snapshotSettingsJson(descriptor.base) },
		...descriptor.user === void 0 ? {} : { user: snapshotSettingsJson(descriptor.user) },
		applies: descriptor.applies,
		secrets: (descriptor.secrets ?? []).map((secret) => ({
			path: [...secret.path],
			set: secret.set
		})),
		revision: descriptor.revision
	};
}
/**
* Detach lossless JSON through the same validator used by settings writes.
* This does not redact secrets; callers own whether the input may cross a wire or journal.
* @param value - JSON-compatible input to snapshot before asynchronous work.
* @returns a detached value; unsupported numbers, sparse arrays and cycles reject.
*/
function snapshotSettingsJson(value) {
	const detached = cloneJsonShaped({ value }, () => /* @__PURE__ */ new TypeError("settings descriptor contains non-JSON data"))["value"];
	if (detached === void 0) throw new TypeError("settings descriptor contains non-JSON data");
	return detached;
}
//#endregion
//#region ../../credentials/credentials/src/index.ts
/**
* Service Definition for the credential-reference capability seam (`ctx.credentials`). Settings and composition files carry
* *references* to secrets — environment-variable names — while providers own
* the actual values and their storage. Consumers resolve a reference once per
* operation, so a changed credential reaches the next operation without any
* plugin restart, and configuration surfaces describe a reference without
* ever seeing its value.
* @module @deepseek-ai/dsh-credentials
*/
const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Both halves of a {@link CredentialKey}; the `/` between them is what keeps it out of {@link REF_PATTERN}. */
const KEY_SEGMENT_PATTERN = /^[a-z][a-z0-9-]*$/;
/**
* Brand a raw string as a {@link CredentialRef}.
* @param value - candidate reference; a POSIX shell identifier such as `DEEPSEEK_API_KEY`.
* @returns the branded reference.
*/
function credentialRef(value) {
	if (!isCredentialRefName(value)) throw new TypeError(`credential ref "${value}" must match ${String(REF_PATTERN)}`);
	return value;
}
/**
* Whether a raw string could name a reference at all. Consumers that receive
* environment-variable names from somewhere else — a provider library's own
* ambient discovery, a hook payload — ask this before resolving, because a name
* outside the grammar has no reference to miss and should read as "not set"
* rather than as a thrown error.
* @param value - candidate reference.
* @returns true when {@link credentialRef} would accept it.
*/
function isCredentialRefName(value) {
	return REF_PATTERN.test(value);
}
/**
* Brand a scope and an id as a {@link CredentialKey}.
* @param scope - the owning plugin's registered name, such as `llm-pi-ai`.
* @param id - that plugin's own addressing unit, such as a provider route key.
* @returns the branded key.
* @throws TypeError when either segment is not a lowercase hyphenated identifier.
*/
function credentialKey(scope, id) {
	for (const segment of [scope, id]) if (!KEY_SEGMENT_PATTERN.test(segment)) throw new TypeError(`credential key segment "${segment}" must match ${String(KEY_SEGMENT_PATTERN)}`);
	return `${scope}/${id}`;
}
/** The reference changed before its conditional write; no requested write occurred. */
var CredentialConflictError = class extends Error {
	ref;
	/** @param ref - the reference whose condition no longer holds. */
	constructor(ref) {
		super(`credential reference "${ref}" changed before its conditional write`);
		this.ref = ref;
		this.name = "CredentialConflictError";
	}
};
/**
* Capture a reference's value and source without retaining its secret.
* @param current - the resolved reference, or absence.
* @returns the condition for a later provider-owned conditional write.
*/
function credentialCondition(current) {
	return current === void 0 ? { valueDigest: null } : {
		valueDigest: createHash("sha256").update(current.value).digest("hex"),
		source: current.source
	};
}
//#endregion
//#region ../../llm/llm/src/provider-transaction.ts
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
function apply$1(value, ops) {
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
	const after = apply$1(value, ops);
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
			...references(apply$1(before.value, plan.ops), plan.settingsPath).keys(),
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
		const next = apply$1(before, plan.ops);
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
//#region ../../llm/llm/src/attribution.ts
/**
* Centralize the non-secret product identity every provider request sends as `User-Agent`, keeping
* adapters from drifting. See
* `.agents/notes/implemented/architecture/2026-06-21-mandatory-app-attribution-headers.md`.
*
* App-attribution vocabulary for provider requests.
* @module @deepseek-ai/dsh-llm/attribution
*/
const { version } = createRequire(import.meta.url)("../package.json");
//#endregion
//#region ../../llm/llm/src/index.ts
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
(() => {
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
			const resolvedConfig = deepFreeze$1(structuredClone(resolved.config));
			const context = resolved.context === void 0 ? void 0 : deepFreeze$1(structuredClone(resolved.context));
			const adapterDefaults = deepFreeze$1({
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
			return Object.isFrozen(options) ? deepFreeze$1(filtered) : filtered;
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
				const resolvedOptions = callConfigEquals(options, resolvedConfig) ? options : Object.isFrozen(options) ? deepFreeze$1({
					...options,
					...resolvedConfig
				}) : {
					...options,
					...resolvedConfig
				};
				const projectedOptions = modelInfo.inputModalities !== void 0 && !modelInfo.inputModalities.includes("image") && resolvedOptions.messages.some((message) => contentHasImage(message.content)) ? Object.isFrozen(resolvedOptions) ? deepFreeze$1({
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
//#region lib/types/index.js
/**
* Opt-in request-preparation tmux-location context. Eligible step attempts
* append durable, source-attributed context naming the tmux session, window,
* and pane this agent process runs in, plus the window's pane-tree layout.
*
* The plugin pulls state once per turn, for the first request (`step === 1`), by
* running one `tmux display-message` through the `ctx.shell` executor service. It
* confirms this process genuinely runs inside the pane `$TMUX_PANE` names by
* matching the pane's `#{pane_tty}` against this process's controlling terminal,
* so a terminal that merely inherited `$TMUX`/`$TMUX_PANE` from a tmux ancestor
* (e.g. a VS Code integrated terminal) reads as "not in tmux". It re-injects
* only when the rendered tmux state changes since the last injection (a moved,
* renamed, or re-laid-out pane), with an optional `refreshIntervalMs` floor
* between injections. Absent tmux environment, an inherited-only environment,
* absent `ctx.shell`, or a failed query is a no-op, never an error: an executor
* rejection is contained and logged as a warning so the turn continues.
*
* @module @deepseek-ai/dsh-tmux-context
*/
/** Cordis plugin name used by loader diagnostics. */
const name = "tmux-context";
/** The agent registry that owns pre-step processing. */
const inject = ["agents"];
/** Schemastery validation for {@link Config}. */
const Config = z.object({ refreshIntervalMs: z.number() });
/**
* Tab-separated tmux format fields, in query order. Layout (`window_layout`)
* is the pane-tree description; pane/window pixel sizes are intentionally
* excluded (own location and layout only, per the package scope).
*/
const TMUX_FIELDS = [
	"#{session_name}",
	"#{window_index}",
	"#{window_name}",
	"#{pane_index}",
	"#{pane_id}",
	"#{window_active}",
	"#{pane_active}",
	"#{window_layout}"
];
/** Prefix marking the volatile turn/step preamble line of a rendered reading. */
const READING_PREFIX = "tmux location (turn ";
/**
* Field separator between tmux format fields. tmux does not interpret C escapes
* in a format, so the literal two-character sequence `\t` is emitted verbatim
* and split back out here; this avoids embedding raw whitespace in the command.
*/
const FIELD_SEP = "\\t";
/**
* Read this process's tmux location through the bash seam, or `undefined` when
* this process is not genuinely running inside a tmux pane or the query fails.
*
* `$TMUX_PANE` alone is insufficient: a terminal launched from a tmux shell
* (e.g. VS Code's integrated terminal, a desktop launcher) inherits `$TMUX` and
* `$TMUX_PANE` from that ancestor, so the variables are present even though this
* process does not live in that pane. The command therefore also compares the
* pane's `#{pane_tty}` against this process's own controlling terminal
* (`ps -o tty=` for {@link processId}); a genuine pane owns this process's tty,
* an inherited environment names some other pane's tty. Fields are emitted only
* on a match, so an inherited environment reads as "not in tmux" and injects
* nothing.
*
* The location is optional context, so an executor rejection is a failed query,
* not a turn failure: `resolve()` may reject the command on policy grounds and
* `run()` only promises to resolve for nonzero exits, timeouts, and aborts, so
* both are contained and reported as a warning.
*
* @param bash - The executor service used to run the read-only tmux/ps commands.
* @param logger - receives a warning when the executor rejects the query.
* @param processId - this agent process's pid, whose controlling tty must match the pane.
* @param signal - abort signal forwarded to the executor.
* @returns the parsed location, or `undefined` when not in a real pane or on any failure.
*/
async function queryTmuxLocation(bash, logger, processId, signal) {
	const format = TMUX_FIELDS.join(FIELD_SEP);
	const command = [
		"[ -n \"$TMUX_PANE\" ] || exit 1",
		`self_tty=$(ps -o tty= -p ${processId} | tr -d ' ')`,
		"[ -n \"$self_tty\" ] || exit 1",
		"pane_tty=$(tmux display-message -t \"$TMUX_PANE\" -p '#{pane_tty}') || exit 1",
		"[ \"$pane_tty\" = \"/dev/$self_tty\" ] || exit 1",
		`exec tmux display-message -t "$TMUX_PANE" -p '${format}'`
	].join("\n");
	let result;
	try {
		result = await bash.run(bash.resolve({
			command,
			signal
		}));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logger.warn(`tmux location query failed: ${message}; injecting no location this turn`);
		return;
	}
	if (result.exitCode !== 0) return void 0;
	const parts = result.stdout.text.split("\n", 1)[0].split(FIELD_SEP);
	if (parts.length !== TMUX_FIELDS.length) return void 0;
	const [sessionName, windowIndex, windowName, paneIndex, paneId, windowActive, paneActive, windowLayout] = parts;
	if (paneId.length === 0) return void 0;
	return {
		sessionName,
		windowIndex,
		windowName,
		paneIndex,
		paneId,
		windowActive,
		paneActive,
		windowLayout
	};
}
/**
* Render the stable tmux state block: the part of a reading compared for
* change suppression. It excludes the turn preamble so re-injection is driven
* only by tmux state, not by loop position.
*/
function renderState(location) {
	return `session ${location.sessionName}, window ${location.windowIndex} ${JSON.stringify(location.windowName)}, pane ${location.paneIndex} ${location.paneId}\nwindow active=${location.windowActive}, pane active=${location.paneActive}, layout ${location.windowLayout}`;
}
/** Render the full durable reading, including the volatile turn preamble. */
function renderReading(location, turn) {
	return `${READING_PREFIX}${turn}):\n${renderState(location)}`;
}
/**
* The stable state block of this plugin's latest durable injection, or
* `undefined` when the session has none. Scans raw durable events so the
* schedule survives compaction and resumed processes without process-local
* cache state.
*/
function latestInjectedState(agent) {
	for (const event of [...agent.session.events].reverse()) if (event.type === "user/message" && event.data.source.kind === "plugin" && event.data.source.plugin === "tmux-context") {
		const [block] = event.data.content;
		if (block?.type !== "text") return void 0;
		const newline = block.text.indexOf("\n");
		return {
			state: newline === -1 ? "" : block.text.slice(newline + 1),
			time: event.time
		};
	}
}
/** Reject refresh intervals that cannot represent an exact elapsed-millisecond threshold. */
function validateRefreshInterval(refreshIntervalMs) {
	if (refreshIntervalMs !== void 0 && (!Number.isSafeInteger(refreshIntervalMs) || refreshIntervalMs < 0)) throw new TypeError(`tmux-context: refreshIntervalMs must be a non-negative safe integer, got ${String(refreshIntervalMs)}`);
}
/**
* Register a prepended pre-step listener for the lifetime of `ctx`.
* @param ctx - plugin context; the listener is disposed with it.
* @param config - durable refresh scheduling configuration.
* @throws when the refresh interval is invalid.
*/
function apply(ctx, config) {
	const refreshIntervalMs = config.refreshIntervalMs;
	validateRefreshInterval(refreshIntervalMs);
	ctx.on("agent/pre-step", async ({ agent, turn, step, signal }, next) => {
		const decision = await next();
		if (decision.kind === "reject" || signal.aborted || step !== 1) return decision;
		const bash = ctx.get("shell");
		if (bash === void 0) return decision;
		const previous = latestInjectedState(agent);
		if (refreshIntervalMs !== void 0 && refreshIntervalMs > 0 && previous !== void 0) {
			const now = Date.now();
			if (now >= previous.time && now - previous.time < refreshIntervalMs) return decision;
		}
		const location = await queryTmuxLocation(bash, ctx.logger, process.pid, signal);
		if (location === void 0) return decision;
		const state = renderState(location);
		if (previous !== void 0 && previous.state === state) return decision;
		const text = renderReading(location, turn);
		return {
			kind: "enter",
			messages: [createUserMessage({
				content: [{
					type: "text",
					text
				}],
				source: {
					kind: "plugin",
					plugin: name,
					form: "snapshot",
					sections: [{
						name,
						text
					}]
				}
			}), ...decision.messages]
		};
	}, { prepend: true });
}
//#endregion
export { Config, apply, inject, name };
