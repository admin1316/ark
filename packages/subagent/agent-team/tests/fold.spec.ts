import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { foldTeam } from '../src/fold.ts'
import { TeamTaskId } from '../src/brand.ts'

// Negative fixtures intentionally contain malformed persisted values beyond the static event types.
const baseline = JSON.parse(readFileSync(new URL('./fixtures/fold-baseline.json', import.meta.url), 'utf8')) as {
  baselineSha256: string
  scenarios: { name: string; events: SessionEvent[]; expected: { state?: unknown; error?: string } }[]
}

describe('Team replay against the preserved runtime baseline', () => {
  it('pins the exact baseline artifact', () => {
    expect(baseline.baselineSha256).toBe('807f1c8de95b79bbaae3c38eb212db3deaea0212dbb8b8f85d220b66f17d0953')
  })
  for (const scenario of baseline.scenarios) {
    it(scenario.name, () => {
      const run = () => foldTeam(SessionId('lead'), scenario.events)
      if (scenario.expected.error !== undefined) {
        expect(run).toThrow(scenario.expected.error)
        return
      }
      const state = run()
      expect({
        id: state.id, members: [...state.members], names: [...state.memberIdsByName], tasks: [...state.tasks],
        messages: [...state.messages], delivered: [...state.delivered], nextTaskNumber: state.nextTaskNumber,
      }).toEqual(scenario.expected.state)
    })
  }
  it('keeps replay output detached from source log objects', () => {
    const scenario = baseline.scenarios.find(item => item.name === 'task created')!
    const events = structuredClone(scenario.events)
    const state = foldTeam(SessionId('lead'), events)
    state.tasks.values().next().value!.blockedBy.push(TeamTaskId('mutable-view'))
    expect(events).toEqual(scenario.events)
  })
})
