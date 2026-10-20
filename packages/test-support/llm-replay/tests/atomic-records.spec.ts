import { expect, it } from 'vitest'
import { parseSessionLog } from '../src/index.ts'

it('reads a physical atomic group without adding synthetic envelope fields to its container', () => {
  const events = [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
  ]
  const header = JSON.stringify({ type: 'session', version: 0, id: 'synthetic', createdAt: 0 })
  const scalar = `${header}\n${events.map(value => JSON.stringify(value)).join('\n')}\n`
  const atomic = `${header}\n${JSON.stringify({ type: 'atomic-events', version: 1, seq: 0, events })}\n`
  expect(parseSessionLog(atomic)).toEqual(parseSessionLog(scalar))
})
