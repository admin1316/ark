/** Duplicate-install-safe JSON and immutable-value helpers. @module @deepseek-ai/dsh-util-values */
/**
 * Lossless JSON scalars, dense ordinary arrays, and plain or null-prototype records.
 * Runtime validation rejects non-finite numbers, negative zero, and own properties
 * that JSON would discard; TypeScript's `number` cannot express these restrictions.
 */
export type JsonValue = null | boolean | number | string | JsonValue[] | {
    [key: string]: JsonValue;
};
/**
 * Mark an unreachable closed-union branch.
 * @param value - impossible value; an unhandled typed variant fails at the call site.
 * @param context - optional switch-site label included in the failure message.
 * @returns never; a runtime value that escaped its type always throws.
 */
export declare function assertNever(value: never, context?: string): never;
/**
 * Match own-property presence without reading values or rejecting unrelated keys.
 * Forbidden keys are checked first; both lists short-circuit in their given order.
 * @param value - object whose own keys are inspected; proxy trap errors propagate.
 * @param required - keys that must be own properties, including values of `undefined`.
 * @param forbidden - keys that must not be own properties; inherited keys do not count.
 * @returns whether every required key is present and every forbidden key is absent.
 */
export declare function matchesOwnKeyPattern(value: object, required: readonly PropertyKey[], forbidden: readonly PropertyKey[]): boolean;
/**
 * Validate and detach lossless JSON in one read per property, so a stateful
 * getter cannot change between validation and copying. Traversal is iterative,
 * so valid nesting is bounded by available memory rather than the JavaScript
 * call stack. Accepts ordinary arrays, plain or null-prototype objects, and JSON
 * scalars; rejects sparse, cyclic, exotic, negative-zero, and non-finite values.
 * Getter throws propagate.
 *
 * @param value - the candidate value to validate and detach.
 * @returns the detached snapshot, or `undefined` when the value is not
 *   losslessly JSON-serializable.
 */
export declare function snapshotJsonValue<T>(value: T): T | undefined;
/**
 * Test the same lossless JSON boundary as {@link snapshotJsonValue} without
 * detaching it. Only own enumerable string properties participate; `toJSON`
 * is ignored and getters run, so persistence boundaries use the snapshotter.
 * @param value - the candidate event data to test.
 * @returns whether `value` survives JSON round-trip losslessly.
 */
export declare function isJsonValue(value: unknown): boolean;
/**
 * Compare JSON-compatible values structurally using own enumerable record keys.
 * An inherited value cannot substitute for a missing own key.
 * @param a - one JSON-compatible value.
 * @param b - the other JSON-compatible value.
 * @returns whether both values contain the same JSON data.
 */
export declare function deepEqualJson(a: unknown, b: unknown): boolean;
/**
 * Deep-freeze an object graph in place while leaving live AbortSignal objects mutable.
 * @param value - value to freeze.
 * @returns the same value after every reachable enumerable child is frozen.
 */
export declare function deepFreeze<T>(value: T): T;
//# sourceMappingURL=index.d.ts.map