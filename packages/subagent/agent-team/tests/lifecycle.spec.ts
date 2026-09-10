import { afterEach, expect, it, vi } from 'vitest'
import { TeamActivity } from '../src/activity.ts'
import { TeamId } from '../src/brand.ts'
import { TeamRuntimeLifecycle } from '../src/lifecycle.ts'
import { TeamError } from '../src/error.ts'

afterEach(() => vi.useRealTimers())

it('releases wait timers on change, caller abort, timeout and service close', async () => {
  vi.useFakeTimers()
  const activity = new TeamActivity()
  const team = TeamId('lead')
  const changed = activity.wait(team, 10_000, new AbortController().signal)
  activity.notify(team)
  await expect(changed).resolves.toEqual({ timedOut: false })
  expect(vi.getTimerCount()).toBe(0)
  const controller = new AbortController()
  const aborting = activity.wait(team, 10_000, controller.signal)
  const aborted = expect(aborting).rejects.toThrow('cancelled')
  controller.abort(new Error('cancelled'))
  await aborted
  expect(vi.getTimerCount()).toBe(0)
  const timed = activity.wait(team, 10_000, new AbortController().signal)
  await vi.advanceTimersByTimeAsync(10_000)
  await expect(timed).resolves.toEqual({ timedOut: true })
  const closing = activity.wait(team, 10_000, new AbortController().signal)
  activity.close()
  await expect(closing).resolves.toEqual({ timedOut: false })
  await expect(activity.wait(team, 10_000, new AbortController().signal)).resolves.toEqual({ timedOut: false })
  expect(vi.getTimerCount()).toBe(0)
})

it.each([0, 9_999, 3_600_001, Number.NaN, 10_000.5])('rejects invalid wait duration %s', async (duration) => {
  await expect(new TeamActivity().wait(TeamId('lead'), duration, new AbortController().signal))
    .rejects.toMatchObject({ code: 'TEAM_INVALID_TIMEOUT' })
})

it('bounds shutdown and distinguishes cancellation from unexpected failures', async () => {
  vi.useFakeTimers()
  const lifecycle = new TeamRuntimeLifecycle(25)
  const pending = Promise.withResolvers<undefined>()
  const bounded = lifecycle.withTimeout(pending.promise)
  const rejected = expect(bounded).rejects.toMatchObject({ code: 'TEAM_DISPOSAL_TIMEOUT' })
  await vi.advanceTimersByTimeAsync(25)
  await rejected
  expect(vi.getTimerCount()).toBe(0)
  lifecycle.close()
  const failures: unknown[] = []
  const unexpected = new Error('unexpected')
  await lifecycle.settle([
    Promise.reject(lifecycle.reason),
    Promise.reject(new Error('wrapped', { cause: lifecycle.reason })),
    Promise.reject(new TeamError('disposed', 'TEAM_DISPOSED')),
    Promise.reject(unexpected),
  ], failures)
  expect(failures).toEqual([unexpected])
  expect(vi.getTimerCount()).toBe(0)
})

it('uses one shutdown deadline rather than restarting the budget for each stage', async () => {
  vi.useFakeTimers()
  const lifecycle = new TeamRuntimeLifecycle(25)
  lifecycle.close()
  const first = lifecycle.withTimeout(new Promise(resolve => setTimeout(resolve, 20)))
  await vi.advanceTimersByTimeAsync(20)
  await first
  lifecycle.close()
  const second = lifecycle.withTimeout(new Promise<never>(() => {}))
  const failure = expect(second).rejects.toMatchObject({ code: 'TEAM_DISPOSAL_TIMEOUT' })
  await vi.advanceTimersByTimeAsync(5)
  await failure
  expect(vi.getTimerCount()).toBe(0)
})
