/** Incremental ordinary-prompt receipts derived from the existing inbox log. */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent, SessionPromptInvocationId, SessionRemotePromptRequest } from '@deepseek-ai/dsh-session'
import { z } from 'zod'

/** One accepted invocation; no prompt body is retained in this projection. */
export interface PromptReceipt {
  readonly messageId: string
  readonly seq: number
  readonly digest: string | null
  readonly conflict: boolean
}
/** Host-only receipt state; inherited fork seed identities belong to the parent. */
export interface PromptReceipts {
  readonly seedLength: number
  readonly entries: Record<string, PromptReceipt>
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap { promptReceipts: PromptReceipts }
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** User input admitted by generated Session Remote with caller identity. */
    'session-remote-user': {
      kind: 'user'
      invocationId: SessionPromptInvocationId
      clientTimeZone?: string
      /** Versioned digest of original input, mode and canonical client timezone. */
      promptDigest?: string
    }
  }
}

const receiptSchema = z.object({
  messageId: z.string(), seq: z.number().int().nonnegative(),
  digest: z.string().nullable(), conflict: z.boolean(),
}) satisfies z.ZodType<PromptReceipt>
const stateSchema = z.object({
  seedLength: z.number().int().nonnegative(), entries: z.record(z.string(), receiptSchema),
}) satisfies z.ZodType<PromptReceipts>

/**
 * Canonical request fingerprint; hash the encoded image instead of retaining it.
 * @param request - original content and delivery mode; invocation and Session identities are not part of the digest.
 * @param clientTimeZone - already canonicalized client time zone, or undefined when absent.
 * @returns version-prefixed SHA-256 digest used to reject changed payloads under an accepted invocation identity.
 */
export function promptDigest(request: SessionRemotePromptRequest, clientTimeZone: string | undefined): string {
  const content = request.content.map(part => part.type === 'text' ? { type: part.type, text: part.text } : {
    type: part.type, mediaType: part.mediaType, data: part.data, name: part.name ?? null,
  })
  return 'v1:' + createHash('sha256').update(JSON.stringify({ mode: request.mode, clientTimeZone: clientTimeZone ?? null, content })).digest('hex')
}

/** Existing receipt entries are never rewritten by queue edits or later consumption. */
function foldReceipts(state: PromptReceipts, event: SessionEvent): PromptReceipts {
  if (event.seq < state.seedLength) return state
  const messages = event.type === 'agent/inbox/spliced' ? event.data.inserted
    : event.type === 'user/message' ? [event.data] : []
  let entries = state.entries
  for (const message of messages) {
    const source = message.source
    if (source.kind !== 'user' || !('invocationId' in source) || typeof source.invocationId !== 'string') continue
    const previous = Object.hasOwn(entries, source.invocationId) ? entries[source.invocationId] : undefined
    const digest = 'promptDigest' in source && typeof source.promptDigest === 'string' ? source.promptDigest : null
    if (previous !== undefined) {
      // Queue edits and user/message consumption retain the original message id.
      if ((previous.messageId === message.id && previous.digest === digest) || previous.conflict) continue
      if (entries === state.entries) entries = { ...entries }
      Object.defineProperty(entries, source.invocationId, {
        value: { ...previous, conflict: true }, enumerable: true, configurable: true, writable: true,
      })
    } else {
      if (entries === state.entries) entries = { ...entries }
      Object.defineProperty(entries, source.invocationId, {
        value: { messageId: message.id, seq: event.seq, digest, conflict: false },
        enumerable: true, configurable: true, writable: true,
      })
    }
  }
  return entries === state.entries ? state : { ...state, entries }
}

/**
 * Register with the shared projection owner; no receipt data is exposed on the wire.
 * @param ctx - Host context with an injected projection registry that owns incremental replay and disposal.
 */
export function installPromptReceipts(ctx: Context): void {
  ctx.sessionProjections.register({
    key: 'promptReceipts', stateSchema,
    init: header => ({ seedLength: header.seedLength ?? 0, entries: {} }),
    apply: foldReceipts, stateVersion: 1,
  })
}
