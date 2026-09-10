/** Relational checks over Team records and their committed Lead-log prefix. */
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InvariantInstaller, InvariantFailure } from '@deepseek-ai/dsh-invariants'
import { applyTeamEvent, foldTeam, isTeamEvent } from './fold.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-agent-team'
export const name = 'team-invariant'
export const inject = ['invariants']
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    if (!isTeamEvent(event)) return
    try { applyTeamEvent(foldTeam(session.id, session.events), event) }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      fail(`session event ${event.seq} violates the Agent Teams stream: ${message}`)
    }
  }, { global: true })
}, { inject: ['sessions'] })

/**
 * Register Team event invariants.
 * @param ctx - invariant registry owner.
 * @returns registration disposer after installation.
 */
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
