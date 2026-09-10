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
export function isCredentialHeaderName(name) {
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
export function normalizeApiKey(raw) {
    const value = raw.trim();
    if (value.length === 0)
        return { ok: false, reason: 'empty' };
    if (!LEGAL_API_KEY.test(value))
        return { ok: false, reason: 'illegalCharacters' };
    return { ok: true, value };
}
//# sourceMappingURL=api-key.js.map