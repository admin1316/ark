import { SessionFormatError, isSessionFormatJsonObject } from '@deepseek-ai/dsh-session-format';
/**
 * Require one plain JSON object.
 * @param value - candidate JSON value.
 * @param label - diagnostic subject.
 * @returns validated object record.
 */
export function releasedV0Record(value, label) {
    if (!isSessionFormatJsonObject(value))
        throw new SessionFormatError(`${label} must be a JSON object`);
    return value;
}
/**
 * Require every named member and no member outside the optional list.
 * @param record - candidate object.
 * @param required - members that must exist.
 * @param optional - additional admitted members.
 * @param label - diagnostic subject.
 */
export function assertReleasedV0Keys(record, required, optional = [], label) {
    const allowed = new Set([...required, ...optional]);
    const unexpected = Object.keys(record).find(key => !allowed.has(key));
    if (unexpected !== undefined)
        throw new SessionFormatError(`${label} has unexpected member ${JSON.stringify(unexpected)}`);
    const missing = required.find(key => !Object.hasOwn(record, key));
    if (missing !== undefined)
        throw new SessionFormatError(`${label} lacks required member ${JSON.stringify(missing)}`);
}
//# sourceMappingURL=validation-helpers.js.map