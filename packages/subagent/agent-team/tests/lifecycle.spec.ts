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

it('settles one wait once when its signal delivers the abort during registration', async () => {
  vi.useFakeTimers()
  const activity = new TeamActivity()
  const team = TeamId('lead')
  const controller = new AbortController()
  const register = controller.signal.addEventListener.bind(controller.signal)
  const reason = new Error('registration raced the abort')
  // An injected signal that records its abort while the listener is being
  // registered and still reports an aborted signal afterwards must settle the wait
  // exactly once: settling twice would release a live waiter and re-enter the timer path.
  Object.defineProperty(controller.signal, 'addEventListener', {
    configurable: true,
    value: (type: string, listener: () => void, options?: AddEventListenerOptions): void => {
      register(type, listener, options)
      controller.abort(reason)
    },
  })

  await expect(activity.wait(team, 10_000, controller.signal)).rejects.toBe(reason)
  expect(vi.getTimerCount()).toBe(0)
  // The double settlement released the waiter once: nothing is left for a later
  // change to settle, and the next wait on the same Team still resolves normally.
  activity.notify(team)
  const next = activity.wait(team, 10_000, new AbortController().signal)
  activity.notify(team)
  await expect(next).resolves.toEqual({ timedOut: false })
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
  const reason = lifecycle.reason
  if (!(reason instanceof Error)) throw new Error('Agent Teams disposal reason must be an Error')
  await lifecycle.settle([
    Promise.reject(reason),
    Promise.reject(new Error('wrapped', { cause: reason })),
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
