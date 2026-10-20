import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '../src/index.ts'
import type { SessionEvent } from '../src/types.ts'
import { describe, expect, it, vi } from 'vitest'

describe('atomic session append', () => {
  it('publishes one complete persistence group before individual event observers', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    try {
      const session = ctx.sessions.create(SessionId('atomic-publication'))
      const publications: { events: readonly SessionEvent[]; atomic: boolean; visible: number }[] = []
      const single: number[] = []
      ctx.on('session/committed', (_session, events, atomic) => {
        publications.push({ events, atomic, visible: session.seq })
      })
      ctx.on('session/event', () => { single.push(session.seq) })
      const events = session.appendAtomic([
        { type: 'turn/start', data: { turn: 1 } },
        { type: 'step/start', data: { turn: 1, step: 1 } },
        { type: 'user/message', data: createUserMessage({ content: [{ type: 'text', text: '合成输入' }], source: { kind: 'user' } }), surfaceOp: 'append' },
      ])
      expect(publications).toEqual([{ events, atomic: true, visible: 3 }])
      expect(single).toEqual([3, 3, 3])
      expect(Object.isFrozen(events)).toBe(true)
      expect(events.every(event => Object.isFrozen(event) && Object.isFrozen(event.data))).toBe(true)
      session.append('step/end', { turn: 1, step: 1 })
      expect(publications.at(-1)).toMatchObject({ atomic: false, visible: 4 })
    } finally { await ctx.fiber.dispose() }
  })

  it('rejects the complete group without publishing a valid leading member', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    try {
      const session = ctx.sessions.create(SessionId('atomic-reject'))
      const observed = vi.fn()
      ctx.on('session/committed', observed)
      expect(() => session.appendAtomic([
        { type: 'turn/start', data: { turn: 1 } },
        { type: 'user/message', data: createUserMessage({ content: [{ type: 'text', text: 'invalid' }], source: { kind: 'user' } }) } as never,
      ])).toThrow('requires a surfaceOp')
      expect(session.events).toEqual([])
      expect(session.surface.nodes).toEqual([])
      expect(observed).not.toHaveBeenCalled()
    } finally { await ctx.fiber.dispose() }
  })

  it('contains post-commit failure and rejects all events on a pre-commit dispatch veto', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    try {
      const session = ctx.sessions.create(SessionId('atomic-veto'))
      const veto = ctx.on('internal/dispatch', (_mode, name, args) => {
        if (name === 'session/event' && (args[1] as SessionEvent).seq === 1) throw new Error('synthetic veto')
      })
      const input = [
        { type: 'turn/start' as const, data: { turn: 1 } },
        { type: 'step/start' as const, data: { turn: 1, step: 1 } },
      ]
      expect(() => session.appendAtomic(input)).toThrow('synthetic veto')
      expect(session.seq).toBe(0)
      veto()
      ctx.on('session/committed', () => { throw new Error('synthetic observer') })
      expect(session.appendAtomic(input)).toHaveLength(2)
      expect(session.seq).toBe(2)
      expect(warn).toHaveBeenCalled()
    } finally { warn.mockRestore(); await ctx.fiber.dispose() }
  })
})
