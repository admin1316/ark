import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { Inbox } from '../src/inbox.ts'
import { describe, expect, it, vi } from 'vitest'

const message = (text: string) => createUserMessage({ content: [{ type: 'text' as const, text }], source: { kind: 'user' as const } })
const notifications = () => ({ claimed: vi.fn(), discarded: vi.fn(), inserted: vi.fn() })

describe('inbox prepared input commit', () => {
  it('keeps previewed input replayable until a complete step and message commit', () => {
    const session = Session.create(SessionId('inbox-cut'))
    const inbox = new Inbox(session, notifications())
    const prompt = message('synthetic')
    inbox.append('next-turn', prompt)
    const preview = inbox.preview('next-turn')
    expect(new Inbox(Session.create(session.id, session.events, session.header), notifications()).nextTurn).toEqual([prompt])
    expect(inbox.commit(preview, 1, [
      { type: 'step/start', data: { turn: 1, step: 1 } },
      { type: 'user/message', data: prompt, surfaceOp: 'append' },
    ])).toBe(true)
    expect(new Inbox(Session.create(session.id, session.events, session.header), notifications()).hasPending).toBe(false)
    expect(session.events.some(event => event.type === 'user/message' && event.data.id === prompt.id)).toBe(true)
  })

  it('preserves edited input and permits only unaffected appended tails', () => {
    const session = Session.create(SessionId('inbox-edit-cut'))
    const inbox = new Inbox(session, notifications())
    const first = message('first')
    inbox.append('next-turn', first)
    const preview = inbox.preview('next-turn')
    inbox.append('next-turn', message('later'))
    expect(inbox.isCurrent(preview)).toBe(true)
    const edited = message('edited')
    inbox.replace(first.id, edited)
    const before = session.seq
    expect(inbox.commit(preview, 1, [])).toBe(false)
    expect(session.seq).toBe(before)
    expect(inbox.nextTurn[0]).toEqual(edited)
  })
})
