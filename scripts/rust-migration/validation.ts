/** Shared validation helpers for the migration evidence boundaries. */

export function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${context} must be an object`)
  return value as Record<string, unknown>
}

export function assertKeys(value: Record<string, unknown>, allowed: readonly string[], context: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${context} has unknown field ${key}`)
  }
}

export function requireString(value: unknown, context: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${context} must be a non-empty string`)
  return value
}

export function requireSha256(value: unknown, context: string): string {
  const result = requireString(value, context)
  if (!/^[a-f0-9]{64}$/u.test(result)) throw new Error(`${context} must be a lowercase SHA-256`)
  return result
}
