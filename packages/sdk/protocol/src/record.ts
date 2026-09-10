/** Shared record predicate for decoded protocol and durable JSON values. */

/**
 * Test whether a parsed value is a string-keyed object rather than an array.
 * @param value - decoded protocol or durable JSON value.
 * @returns whether the value is a non-null, non-array object.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
