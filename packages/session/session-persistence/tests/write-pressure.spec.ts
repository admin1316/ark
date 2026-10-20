import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { waitForPersistenceOperation } from '../src/index.ts'
import { SessionWriteBehind } from '../src/write-behind.ts'
import { WritePressure, resolveWritePressure } from '../src/write-pressure.ts'

const contexts: Context[] = []
afterEach(async () => { vi.useRealTimers(); await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })
async function sessions() {
  const ctx = new Context(); contexts.push(ctx); await ctx.plugin(SessionStore)
  return [ctx.sessions.create(SessionId('one')), ctx.sessions.create(SessionId('two'))] as const
}
const limits = () => resolveWritePressure({ sessionHighBytes: 1000, sessionLowBytes: 400,
  totalHighBytes: 1800, totalLowBytes: 800, waitTimeoutMs: 100 })
const queued = (bytes: number, failed = false) => ({ events: bytes === 0 ? 0 : 1, bytes,
  oldestAt: bytes === 0 ? null : Date.now(), lastSuccessAt: null, failed })
function event(seq: number): SessionEvent<'turn/start'> { return { type: 'turn/start', seq, time: 1, data: { turn: seq + 1 } } }

it('keeps active atomic writes counted and retries their original group exactly once', async () => {
  const [session] = await sessions()
  const pressure = new WritePressure(limits())
  const gate = Promise.withResolvers<undefined>()
  const calls: unknown[] = []
  let attempt = 0
  const writer = new SessionWriteBehind({ maxDelayMs: 1000, stateChanged: (state) =>{  pressure.update(session, state) },
    write: async (events, groups) => { calls.push({ seqs: events.map(row => row.seq), groups }); if (++attempt === 1) { await gate.promise; throw new Error('synthetic disk failure') } },
    reportBackgroundFailure: () => {} })
  writer.enqueueBatch([event(0), event(1)], true)
  const before = writer.state
  const first = writer.flush()
  const outcome = expect(first).rejects.toThrow('synthetic disk failure')
  await Promise.resolve()
  expect(writer.state).toEqual(before)
  writer.enqueue(event(2))
  expect(pressure.read(session).events).toBe(3)
  gate.resolve(undefined); await outcome
  expect(writer.state.events).toBe(3)
  expect(writer.state.failed).toBe(true)
  await writer.flush()
  expect(calls).toEqual([{ seqs: [0, 1], groups: [{ firstSeq: 0, count: 2 }] },
    { seqs: [0, 1, 2], groups: [{ firstSeq: 0, count: 2 }] }])
  expect(writer.state).toMatchObject({ events: 0, bytes: 0, oldestAt: null, failed: false })
  expect(pressure.read(session).phase).toBe('healthy')
})

it('uses low-water hysteresis and isolates a different session failure', async () => {
  const [one, two] = await sessions(); const pressure = new WritePressure(limits())
  pressure.update(one, queued(1000))
  let ready = false
  const waiting = pressure.wait(one, new AbortController().signal).then(() => { ready = true })
  pressure.update(one, queued(500)); await Promise.resolve(); expect(ready).toBe(false)
  pressure.update(one, queued(400)); await waiting; expect(ready).toBe(true)
  pressure.update(two, queued(10, true))
  expect(pressure.read(two).phase).toBe('failed')
  expect(pressure.read(one).phase).toBe('healthy')
  expect(pressure.read().phase).toBe('failed')
})

it('applies aggregate high water until aggregate low water', async () => {
  const [one, two] = await sessions(); const pressure = new WritePressure(limits())
  pressure.update(one, queued(900)); pressure.update(two, queued(900))
  expect(pressure.read(one).phase).toBe('pressured')
  pressure.update(one, queued(500)); expect(pressure.read(one).phase).toBe('pressured')
  pressure.update(two, queued(300)); expect(pressure.read(one).phase).toBe('healthy')
})

it('cancels capacity observers without dropping writes or retaining timers', async () => {
  const [one] = await sessions(); vi.useFakeTimers(); const pressure = new WritePressure(limits())
  pressure.update(one, queued(1200)); const controller = new AbortController()
  const waiting = pressure.wait(one, controller.signal)
  const outcome = expect(waiting).rejects.toThrow('synthetic stop')
  controller.abort(new Error('synthetic stop')); await outcome
  expect(pressure.read(one).events).toBe(1); expect(vi.getTimerCount()).toBe(0)
  const timeout = expect(pressure.wait(one, new AbortController().signal)).rejects.toMatchObject({ code: 'storage-stalled' })
  await vi.advanceTimersByTimeAsync(100); await timeout
  expect(vi.getTimerCount()).toBe(0)
  pressure.update(one, queued(0)); pressure.forget(one)
})

it('closes observers but refuses to forget retained data', async () => {
  const [one] = await sessions(); const pressure = new WritePressure(limits())
  pressure.update(one, queued(1200))
  const closed = expect(pressure.wait(one, new AbortController().signal)).rejects.toMatchObject({ code: 'storage-closing' })
  pressure.close(); await closed
  expect(() =>{  pressure.forget(one) }).toThrow('cannot forget')
})

it('validates deployment bounds before production starts', () => {
  for (const config of [{ sessionLowBytes: 5_000_000 }, { totalHighBytes: 100 }, { waitTimeoutMs: 0 }, { sessionHighBytes: NaN }]) {
    expect(() => resolveWritePressure(config)).toThrow('writePressure')
  }
})

it('cancels only the observer while an owned durability operation still settles', async () => {
  const operation = Promise.withResolvers<number>()
  const controller = new AbortController()
  const observed = waitForPersistenceOperation(operation.promise, controller.signal)
  const rejected = expect(observed).rejects.toThrow('observer cancelled')
  controller.abort(new Error('observer cancelled'))
  await rejected
  operation.resolve(42)
  expect(await operation.promise).toBe(42)
  const success = waitForPersistenceOperation(Promise.resolve(7), new AbortController().signal)
  expect(await success).toBe(7)
  await expect(waitForPersistenceOperation(Promise.reject(new Error('disk failed')), new AbortController().signal)).rejects.toThrow('disk failed')
})

it('rejects failed, closing and already cancelled waits before starting a capacity observer', async () => {
  const [one, two] = await sessions()
  const pressure = new WritePressure(limits())
  await expect(pressure.wait(one, new AbortController().signal)).resolves.toBeUndefined()
  pressure.update(one, queued(100, true))
  await expect(pressure.wait(one, new AbortController().signal)).rejects.toMatchObject({ code: 'storage-write-failed' })
  pressure.update(one, queued(1200))
  const failure = expect(pressure.wait(one, new AbortController().signal)).rejects.toMatchObject({ code: 'storage-write-failed' })
  pressure.update(one, queued(1200, true))
  await failure
  const aborted = new AbortController()
  aborted.abort(new Error('already cancelled'))
  expect(() => pressure.wait(one, aborted.signal)).toThrow('already cancelled')
  pressure.close()
  await expect(pressure.wait(two, new AbortController().signal)).rejects.toMatchObject({ code: 'storage-closing' })
  expect(() => { new WritePressure(limits()).forget(two) }).not.toThrow()
  const initializing = new WritePressure(limits())
  initializing.update(two, { ...queued(0), initializing: true })
  expect(() => { initializing.forget(two) }).toThrow('cannot forget')
  expect(() => resolveWritePressure({ waitTimeoutMs: 2_147_483_648 })).toThrow('writePressure')
})

it('settles cancellation during capacity-listener registration once and removes the timer', async () => {
  const [one] = await sessions()
  vi.useFakeTimers()
  const pressure = new WritePressure(limits())
  pressure.update(one, queued(1200))
  const controller = new AbortController()
  const add = controller.signal.addEventListener.bind(controller.signal)
  vi.spyOn(controller.signal, 'addEventListener').mockImplementation((...args) => {
    add(...args)
    controller.abort('synthetic non-Error cancellation')
  })
  await expect(pressure.wait(one, controller.signal)).rejects.toThrow('aborted')
  expect(vi.getTimerCount()).toBe(0)
  expect(pressure.read(one).events).toBe(1)
})

it('does not allocate or schedule a write for an empty committed group', async () => {
  const write = vi.fn(async () => {})
  const writer = new SessionWriteBehind({ maxDelayMs: 1000, write, reportBackgroundFailure: () => {} })
  writer.enqueueBatch([], true)
  expect(writer.state.events).toBe(0)
  await writer.flush()
  expect(write).not.toHaveBeenCalled()
})
