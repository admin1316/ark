/** Shared validation helpers for the migration evidence boundaries. */

/** Require an object at a migration evidence boundary.
 * @param value - Decoded JSON value.
 * @param context - Field description used in errors.
 * @returns The checked object.
 */
export function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${context} must be an object`)
  return value as Record<string, unknown>
}

/** Reject fields outside an evidence schema's allowlist.
 * @param value - Checked evidence object.
 * @param allowed - Fields admitted by this schema.
 * @param context - Object description used in errors.
 */
export function assertKeys(value: Record<string, unknown>, allowed: readonly string[], context: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${context} has unknown field ${key}`)
  }
}

/** Require non-empty evidence text without rewriting it.
 * @param value - Decoded field value.
 * @param context - Field description used in errors.
 * @returns The original checked string.
 */
export function requireString(value: unknown, context: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${context} must be a non-empty string`)
  return value
}

/** Require a lowercase SHA-256 evidence digest.
 * @param value - Decoded digest field.
 * @param context - Field description used in errors.
 * @returns The checked digest.
 */
export function requireSha256(value: unknown, context: string): string {
  const result = requireString(value, context)
  if (!/^[a-f0-9]{64}$/u.test(result)) throw new Error(`${context} must be a lowercase SHA-256`)
  return result
}
