import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { expandAtomicSessionLog } from '../src/storage-records.ts'
import { normalizeSessionSnapshots } from '../src/normalize.ts'

describe('atomic runtime records in snapshot inputs', () => {
  it('normalizes logical messages and identities identically to scalar records', () => {
    const header = { type: 'session', version: 0, id: '11111111-2222-4333-8444-555555555555', createdAt: 5, cwd: '/synthetic' }
    const prompt = createUserMessage({ content: [{ type: 'text', text: 'synthetic input' }], source: { kind: 'user' } })
    const events = [
      { type: 'agent/inbox/spliced', seq: 0, time: 10, data: { target: 'next-turn', start: 0, inserted: [prompt] } },
      { type: 'user/message', seq: 1, time: 11, data: prompt, surfaceOp: 'append' },
    ]
    const scalar = [header, ...events].map(value => JSON.stringify(value)).join('\n') + '\n'
    const atomic = [header, { type: 'atomic-events', version: 1, seq: 0, events }].map(value => JSON.stringify(value)).join('\n') + '\n'
    expect(expandAtomicSessionLog(scalar)).toBe(scalar)
    expect(expandAtomicSessionLog(atomic)).toBe(scalar)
    const context = { cwd: '/synthetic', sessionIds: [header.id] }
    expect(normalizeSessionSnapshots([atomic], context)).toEqual(normalizeSessionSnapshots([scalar], context))
  })

  it('rejects unsupported atomic rows instead of hiding them in normalization', () => {
    expect(() => expandAtomicSessionLog('{"type":"atomic-events","version":2,"events":[]}\n')).toThrow('expected version 1')
  })
})
