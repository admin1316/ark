import { normalizeApiKey } from "./api-key.js";
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
export class HarnessError extends Error {
    /** Stable machine-routable failure class (e.g. `RATE_LIMIT`); route on this, never by parsing `message`. */
    code;
    constructor(message, code, options) {
        super(message, options);
        this.code = code;
        this.name = new.target.name;
    }
}
/** Canonical provider-neutral code for a model request rejected because its context window was exceeded. */
export const CONTEXT_WINDOW_EXCEEDED_CODE = 'CONTEXT_WINDOW_EXCEEDED';
/** Canonical provider-neutral code for an exhausted account quota or balance. */
export const QUOTA_EXCEEDED_CODE = 'QUOTA';
/**
 * Canonical provider-neutral code for a response that completed normally but
 * carried no content blocks at all. Providers occasionally emit a degenerate
 * completion (a terminal stop with zero output); adapters classify it as this
 * failure instead of yielding an empty assistant message, because an empty
 * message silently ends the turn with nothing for the user or the loop to act
 * on. The attempt produced nothing durable, so retry policy treats it as safe
 * to repeat.
 */
export const EMPTY_RESPONSE_CODE = 'EMPTY_RESPONSE';
/**
 * Canonical provider-neutral code for a credential that was supplied but
 * cannot be used — malformed rather than absent. Distinct from
 * `MISSING_CREDENTIAL` because the fix differs: correct the stored value
 * rather than supply one. Deliberately outside the default retryable set —
 * a malformed credential fails identically on every attempt.
 */
export const INVALID_CREDENTIAL_CODE = 'INVALID_CREDENTIAL';
/** Structured codes and plain phrases that explicitly name a context bound being exceeded. */
const STRUCTURED_CONTEXT_OVERFLOW = new RegExp(String.raw `(?:^|[^a-z0-9])context[\s_-](?:length|window)[\s_-]`
    + String.raw `(?:exceed(?:ed|s)?|overflow(?:ed)?|limit[\s_-]exceeded)(?:$|[^a-z0-9])`, 'i');
/** Request-size wording that ties "too large" directly to model context capacity. */
const TOO_LARGE_FOR_CONTEXT = new RegExp(String.raw `\b(?:request|prompt|input|messages?)\s+(?:is\s+|are\s+)?`
    + String.raw `too\s+(?:large|long)\s+for\s+(?:(?:this|the)\s+)?`
    + String.raw `(?:model(?:'s)?\s+)?context(?:\s+window)?\b`, 'i');
/** "Exceeds" wording is safe only when its object is explicitly the model context. */
const EXCEEDS_MODEL_CONTEXT = new RegExp(String.raw `\b(?:input|prompt|request|messages?)\b.{0,40}`
    + String.raw `\b(?:exceed(?:s|ed)?|overflows?|is\s+larger\s+than)\b.{0,40}`
    + String.raw `\b(?:the\s+)?(?:model(?:'s)?\s+)?context(?:\s+(?:length|window))?\b`, 'i');
/**
 * Recognize the context-overflow wording used by OpenAI-compatible providers
 * and library adapters. Adapters pass all available provider code, type, and
 * message text so both thrown and in-band delivery styles share one classifier.
 * @param detail - provider error code/type/message text joined into one string.
 * @returns true when the detail identifies a request exceeding the model context window.
 */
export function isContextWindowExceededError(detail) {
    return STRUCTURED_CONTEXT_OVERFLOW.test(detail)
        || /\b(?:maximum|max)(?:\s+(?:allowed|supported))?\s+context\s+(?:length|window)\b/i.test(detail)
        || TOO_LARGE_FOR_CONTEXT.test(detail)
        || /\b(?:input|prompt|request)\s+(?:is\s+)?too\s+(?:long|large)\s+for\s+(?:this|the)\s+model\b/i.test(detail)
        || EXCEEDS_MODEL_CONTEXT.test(detail);
}
/**
 * Recognize provider wording that identifies an exhausted account quota rather
 * than a transient request-rate limit.
 * @param detail - provider error code/type/message text joined into one string.
 * @returns true only for terminal quota, balance, credit, budget, or usage-limit wording.
 */
export function isQuotaExceededError(detail) {
    return /\binsufficient[\s_-]+(?:quota|balance|credits?)\b/i.test(detail)
        || /\b(?:quota|usage[\s_-]+limit)[\s_-]+(?:exceeded|exhausted|reached)\b/i.test(detail)
        || /\bexceed(?:ed|s)?[\s_-]+(?:(?:your|the)[\s_-]+)?(?:current[\s_-]+)?quota\b/i.test(detail)
        || /\b(?:balance|credits?)[\s_-]+(?:exhausted|depleted)\b/i.test(detail)
        || /\bout[\s_-]+of[\s_-]+(?:credits?|budget)\b/i.test(detail);
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
export function errorChain(value) {
    // Tracks the active recursion path (entries removed on exit), so only true
    // cycles are flagged and a diamond-shared cause still renders in full.
    const path = new Set();
    const render = (current) => {
        if (path.has(current))
            return '<circular cause>';
        path.add(current);
        try {
            if (!(current instanceof Error)) {
                if (typeof current === 'object' && current !== null) {
                    const descriptor = Object.getOwnPropertyDescriptor(current, 'message');
                    if (descriptor !== undefined && 'value' in descriptor && typeof descriptor.value === 'string') {
                        return descriptor.value;
                    }
                }
                return String(current);
            }
            const message = current.message === '' ? current.name : current.message;
            const members = current instanceof AggregateError && current.errors.length > 0
                ? ` [${current.errors.map(render).join('; ')}]`
                : '';
            const causeText = current.cause === undefined || current.cause === null
                ? ''
                : render(current.cause);
            // Wrappers like `new HarnessError(String(value), code, { cause: value })`
            // repeat their cause verbatim; rendering it again would only add noise.
            const cause = causeText === '' || causeText === message ? '' : `: ${causeText}`;
            return `${message}${members}${cause}`;
        }
        catch {
            // Only hostile coercion or hostile accessors (a throwing toString /
            // Symbol.toPrimitive on a non-Error, or a throwing message/name/cause/
            // errors getter on an Error subclass): this renderer feeds UI notices
            // and logs, so nothing may escape. Inner frames catch their own throws,
            // so only the hostile node collapses, not the whole chain.
            return '<unrenderable value>';
        }
        finally {
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
export function isHarnessError(value) {
    return value instanceof HarnessError;
}
/**
 * Typed error for LLM-related failures. Extends {@link HarnessError}, so the
 * `code` string (e.g. `AUTH`, `RATE_LIMIT`, `NO_ADAPTER`) is shared taxonomy.
 */
export class LlmError extends HarnessError {
    /** Serializable facts retained beside this live Error. */
    failure;
    /**
     * @param message - non-empty human-readable failure summary.
     * @param code - non-empty stable provider-neutral machine code.
     * @param options - optional cause and validated serializable provider facts.
     */
    constructor(message, code, options) {
        if (typeof message !== 'string' || message.length === 0)
            throw new Error('LlmError message must be a non-empty string');
        if (typeof code !== 'string' || code.length === 0)
            throw new Error('LlmError code must be a non-empty string');
        if (options?.status !== undefined
            && (!Number.isInteger(options.status) || options.status < 100 || options.status > 599)) {
            throw new Error('LlmError status must be an integer from 100 through 599');
        }
        if (options?.providerRetryAfterMs !== undefined
            && (!Number.isFinite(options.providerRetryAfterMs) || options.providerRetryAfterMs <= 0)) {
            throw new Error('LlmError providerRetryAfterMs must be a positive finite number');
        }
        if (options?.requestId !== undefined
            && (typeof options.requestId !== 'string' || options.requestId.length === 0)) {
            throw new Error('LlmError requestId must be a non-empty string');
        }
        super(message, code, options);
        this.name = 'LlmError';
        this.failure = Object.freeze({
            message,
            code,
            ...options?.status === undefined ? {} : { status: options.status },
            ...options?.providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs: options.providerRetryAfterMs },
            ...options?.requestId === undefined ? {} : { requestId: options.requestId },
        });
    }
}
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
export function assertUsableApiKey(raw, pkg, ref) {
    const checked = normalizeApiKey(raw);
    if (checked.ok)
        return checked.value;
    // The Models page is named as the writer it usually is, not as the only one:
    // the same value can arrive from a hand-edited .env or a shell export in a
    // composition that mounts no credentials seam at all, where directing the
    // user to a page that deployment does not serve would be a dead end.
    throw new LlmError(checked.reason === 'empty'
        ? `${pkg}: the API key resolved from ${ref} is blank; set ${ref} to the raw key`
            + ' (the web Models page writes it) or export it in the launching environment'
        : `${pkg}: the API key resolved from ${ref} contains characters no HTTP header can carry;`
            + ` set ${ref} to the raw key alone (the web Models page writes it)`, INVALID_CREDENTIAL_CODE);
}
//# sourceMappingURL=error.js.map