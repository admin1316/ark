/**
 * Shared record predicate for decoded protocol and durable JSON values.
 * @module @deepseek-ai/dsh-sdk-protocol/record
 */
/**
 * Whether `value` can be read as a string-keyed record.
 * @param value - The value to inspect.
 * @returns `true` for a non-null, non-array object.
 */
export declare function isRecord(value: unknown): value is Record<string, unknown>;
//# sourceMappingURL=record.d.ts.map