/**
 * The one definition of a well-formed provider API key, shared by every
 * adapter that puts one in an HTTP header.
 * @module @deepseek-ai/dsh-llm/api-key
 */
/**
 * Identify header names whose non-empty values must use credential storage.
 * @param name - header name, compared case-insensitively.
 * @returns whether the name carries authentication, tokens, passwords or cookies.
 */
export declare function isCredentialHeaderName(name: string): boolean;
/** Why a supplied API key cannot be used. */
export type ApiKeyRejection = 'empty' | 'illegalCharacters';
/** The verdict on one supplied API key. */
export type ApiKeyCheck = {
    readonly ok: true;
    readonly value: string;
} | {
    readonly ok: false;
    readonly reason: ApiKeyRejection;
};
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
export declare function normalizeApiKey(raw: string): ApiKeyCheck;
//# sourceMappingURL=api-key.d.ts.map