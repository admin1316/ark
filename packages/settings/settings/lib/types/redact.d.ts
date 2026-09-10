/**
 * Structural secret redaction for settings values. `role('secret')` fields are
 * removed from a value before it crosses a wire boundary; a sidecar records
 * each schema-declared secret position and whether it currently holds a value,
 * so a configuration surface can render a write-only input without ever
 * receiving the secret itself.
 * @module @deepseek-ai/dsh-settings/redact
 */
import type z from '@deepseek-ai/schemastery';
/** One schema-declared secret position inside a redacted value. */
export interface RedactedSecret {
    /** Path from the section root to the removed field (concrete dict keys and array indexes included). */
    path: string[];
    /** Whether the field held a value before redaction. */
    set: boolean;
}
/** A value with every `role('secret')` field removed, plus the removal record. */
export interface RedactedValue {
    /** Detached copy of the input with secret fields absent. */
    value: unknown;
    /**
     * Every reachable secret position: object properties always (even unset, so
     * a form knows the slot exists), dict entries and array items only where the
     * value has them.
     */
    secrets: RedactedSecret[];
}
/**
 * Remove every `role('secret')` field a schema declares from a value. The
 * walker follows object, dict, array, tuple, union, and intersection relations.
 * Unsupported or malformed secret-bearing containers reject instead of returning
 * their values, including schema defaults and overridden layers. Secret array
 * positions become null so indexes remain stable.
 * @param schema - live schemastery schema describing the value.
 * @param value - the value to strip; `undefined` yields an empty record with
 *   object-property secret slots still enumerated.
 * @returns the stripped detached value and the ordered secret positions.
 */
export declare function redactSecrets(schema: z<never>, value: unknown): RedactedValue;
/**
 * Serialize form metadata with secret values removed from every default layer.
 * @param schema - live namespace schema, including shared schema nodes.
 * @returns its detached schemastery envelope, safe from schema-declared default secrets.
 */
export declare function redactSettingsSchema(schema: z<never>): unknown;
//# sourceMappingURL=redact.d.ts.map