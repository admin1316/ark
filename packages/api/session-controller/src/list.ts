/** Cached lifecycle summary only; canonical Host owns list/search and projection registration. */

import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { SessionProjectionHints, SessionProjectionValues, SessionSummary } from './types.ts'

/**
 * Build a created-session lifecycle hint without reading or replaying its log.
 * @param ctx - Host context providing the live Agent registry and optional cached projections.
 * @param session - exact Session whose header, cursor, and cached metadata describe the hint.
 * @returns lifecycle summary; unavailable cached projections are logged and omitted.
 */
export function sessionSummaryFor(ctx: Context, session: Session): SessionSummary {
  let projections: SessionProjectionHints | undefined
  try {
    const block = ctx.get('sessionProjections')?.cachedSnapshot(session)
    if (block !== undefined && Object.keys(block.values).length > 0) {
      projections = { asOfSeq: block.asOfSeq, values: block.values as SessionProjectionValues }
    }
  } catch (error: unknown) {
    ctx.logger.warn(`api-session: cached summary unavailable for "${session.id}": ${String(error)}`)
  }
  const metadata = projections?.values.sessionListMetadata
  return {
    sessionId: session.id,
    updatedAt: Math.max(session.header.createdAt, metadata?.lastPromptAt ?? 0),
    running: ctx.agents.get(session.id)?.status === 'running',
    blank: metadata?.blank ?? session.seq === 0,
    ...(session.header.parentSession === undefined ? {} : { parentSessionId: session.header.parentSession }),
    ...(session.header.origin === undefined ? {} : { origin: session.header.origin }),
    ...(session.header.cwd === undefined ? {} : { cwd: session.header.cwd }),
    ...(projections === undefined ? {} : { projections }),
  }
}
