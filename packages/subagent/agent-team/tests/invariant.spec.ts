import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantService, { InvariantError } from '@deepseek-ai/dsh-invariants'
import SessionStore, { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { TeamId, type TeamMemberSnapshot } from '@deepseek-ai/dsh-agent-team'
import * as TeamInvariant from '@deepseek-ai/dsh-agent-team/invariant'

/**
 * The companion registers one global 'internal/dispatch' observer, so these cases
 * drive it the way the session log does: ctx.emit('session/event', session, event)
 * hands the handler the exact [session, event] pair whose committed prefix it folds.
 */
async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantService, { enabled: true })
  await ctx.plugin(TeamInvariant)
  return ctx
}

/** One Team-owned envelope carrying a version-1 record the fold must validate. */
function teamEvent(data: unknown, seq = 0): SessionEvent {
  return { type: 'team/member', seq, time: 0, data } as unknown as SessionEvent
}

const PACKAGE_NAME = '@deepseek-ai/dsh-agent-team'

describe('Agent Teams stream invariant reporting', () => {
  it('ignores a session event outside the Team-owned record kinds', async () => {
    const ctx = await setup()
    try {
      const session = ctx.sessions.create(SessionId('team-invariant-unrelated'))
      expect(() => {
        ctx.emit('session/event', session, { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } })
      }).not.toThrow()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('names the offending event and the rejected durable record for an Error failure', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SessionStore)
      // A durable team/member record that fails the strict member schema. It is
      // appended before registration so the invariant sees it only through replay.
      const session = ctx.sessions.create(SessionId('team-invariant-corrupt-prefix'))
      // The payload is deliberately not a complete snapshot: the invariant must
      // reject the durable record at replay time, which is a runtime-only check.
      session.append('team/member', {
        version: 1,
        teamId: TeamId(session.id),
        member: { id: SessionId('incomplete-member') } as unknown as TeamMemberSnapshot,
      })
      await ctx.plugin(InvariantService, { enabled: true })
      await ctx.plugin(TeamInvariant)

      expect(() => { ctx.emit('session/event', session, teamEvent({ version: 1, teamId: session.id }, 7)) })
        .toThrow(expect.objectContaining<Partial<InvariantError>>({ code: 'INVARIANT', packageName: PACKAGE_NAME }))
      expect(() => { ctx.emit('session/event', session, teamEvent({ version: 1, teamId: session.id }, 7)) })
        .toThrow('session event 7 violates the Agent Teams stream: persisted Agent Teams team/member payload is invalid')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('stringifies a non-Error replay failure instead of reporting an empty message', async () => {
    const ctx = await setup()
    try {
      // The observer folds the session prefix through the public dispatch event.
      // A corrupt prefix can reject with any thrown value, so the handler must
      // still name the offending event rather than losing the reason.
      const hostile = {
        get type(): string {
          throw 'team replay exploded'
        },
      }
      const session = { id: SessionId('team-invariant-non-error'), events: [hostile] } as unknown as Session

      expect(() => { ctx.emit('session/event', session, teamEvent({ version: 1, teamId: session.id }, 3)) })
        .toThrow(expect.objectContaining<Partial<InvariantError>>({ code: 'INVARIANT', packageName: PACKAGE_NAME }))
      expect(() => { ctx.emit('session/event', session, teamEvent({ version: 1, teamId: session.id }, 3)) })
        .toThrow('session event 3 violates the Agent Teams stream: team replay exploded')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
