/** Input normalization shared by roster and task commands. */
import { TeamError } from './error.ts'

/**
 * Normalize a required human-authored string.
 * @param value - raw input.
 * @param field - diagnostic field name.
 * @param maxLength - normalized character limit.
 * @returns trimmed non-empty text.
 */
export function requiredText(value: string, field: string, maxLength: number): string {
  const text = value.trim()
  if (text.length === 0) throw new TeamError(`${field} must be non-empty`, 'TEAM_INVALID_ARGUMENT')
  if (text.length > maxLength) throw new TeamError(`${field} exceeds ${maxLength} characters`, 'TEAM_INVALID_ARGUMENT')
  return text
}

/**
 * Normalize an advisory workspace-relative path prefix, not a write lock.
 * @param value - authored path prefix.
 * @returns slash-separated relative prefix.
 */
export function writeScope(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/+$/u, '')
  const segments = normalized.split('/')
  if (normalized.length === 0 || normalized.startsWith('/') || /^[a-z]:/iu.test(normalized)
    || segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new TeamError(`invalid workspace-relative write scope ${JSON.stringify(value)}`, 'TEAM_INVALID_WRITE_SCOPE')
  }
  return normalized
}
