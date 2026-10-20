/** Command retry identities reconstructed from the authoritative session log. */
import { createHash } from 'node:crypto'
import type { SessionEvent, SessionRemoteCommandRequest, SessionPromptInvocationId } from '@deepseek-ai/dsh-session'
import type { CommandId } from './brand.ts'

/** One command's immutable admission and optional settlement coordinates. */
export interface CommandReceipt {
  readonly commandId: CommandId
  readonly digest: string
  readonly runSeq: number
  readonly doneSeq: number | null
  readonly conflict: boolean
}

/** Host-only receipt projection; fork seeds retain their parent's identities. */
export interface CommandReceipts {
  readonly seedLength: number
  readonly entries: Record<string, CommandReceipt>
  readonly commandIds: Record<string, string>
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap { commandReceipts: CommandReceipts }
}

/**
 * Fingerprint command input without retaining another copy of uploaded images.
 * @param request - Exact command submission; session and invocation identities are separate keys.
 * @returns A versioned SHA-256 fingerprint.
 */
export function commandDigest(request: SessionRemoteCommandRequest): string {
  const images = request.images.map(image => ({
    mediaType: image.mediaType, name: image.name ?? null,
    sha256: createHash('sha256').update(image.data).digest('hex'),
  }))
  return 'command-v1:' + createHash('sha256').update(JSON.stringify({ line: request.line, images })).digest('hex')
}

/**
 * Fold only this session's command admissions and result coordinates.
 * @param state - Prior receipt index.
 * @param event - Next authoritative event.
 * @returns The unchanged state when the event carries no new receipt information.
 */
export function foldCommandReceipts(state: CommandReceipts, event: SessionEvent): CommandReceipts {
  if (event.seq < state.seedLength) return state
  if (event.type === 'command/run') {
    const { invocationId, inputDigest, commandId } = event.data
    if (invocationId === undefined && inputDigest === undefined) return state
    if (typeof invocationId !== 'string' || invocationId.length === 0
      || typeof inputDigest !== 'string' || !/^command-v1:[a-f0-9]{64}$/u.test(inputDigest)) {
      throw new Error('command admission has invalid invocation metadata')
    }
    if (Object.hasOwn(state.commandIds, commandId) && state.commandIds[commandId] !== invocationId) {
      throw new Error('command admission repeats commandId for another invocation')
    }
    const previous = Object.hasOwn(state.entries, invocationId) ? state.entries[invocationId] : undefined
    const value: CommandReceipt = previous === undefined
      ? { commandId, digest: inputDigest, runSeq: event.seq, doneSeq: null, conflict: false }
      : { ...previous, conflict: true }
    const entries = { ...state.entries }
    Object.defineProperty(entries, invocationId, { value, enumerable: true, configurable: true, writable: true })
    const commandIds = { ...state.commandIds }
    Object.defineProperty(commandIds, commandId, { value: invocationId, enumerable: true, configurable: true, writable: true })
    return { ...state, entries, commandIds }
  }
  if (event.type !== 'command/done') return state
  const invocationId = Object.hasOwn(state.commandIds, event.data.commandId) ? state.commandIds[event.data.commandId] : undefined
  if (invocationId === undefined) return state
  const previous = state.entries[invocationId]
  if (previous === undefined) throw new Error('command receipt index is inconsistent')
  const persistedKind: unknown = event.data.kind
  if ((persistedKind !== 'success' && persistedKind !== 'error')
    || (event.data.text !== undefined && typeof event.data.text !== 'string')
    || (event.data.kind === 'error' && typeof event.data.text !== 'string')
    || (event.data.sourceEventSeq !== undefined && (event.data.kind !== 'success'
      || !Number.isSafeInteger(event.data.sourceEventSeq) || event.data.sourceEventSeq < 0
      || event.data.sourceEventSeq >= event.seq))) throw new Error('command receipt has an invalid result')
  const entries = { ...state.entries }
  Object.defineProperty(entries, invocationId, {
    value: { ...previous, doneSeq: event.seq, conflict: previous.conflict || previous.doneSeq !== null },
    enumerable: true, configurable: true, writable: true,
  })
  return { ...state, entries }
}

/**
 * Find a caller identity without accepting inherited Object prototype members.
 * @param state - Current receipt index.
 * @param invocationId - Caller-minted submission identity.
 * @returns The receipt when this session owns one.
 */
export function commandReceipt(state: CommandReceipts, invocationId: SessionPromptInvocationId): CommandReceipt | undefined {
  return Object.hasOwn(state.entries, invocationId) ? state.entries[invocationId] : undefined
}
