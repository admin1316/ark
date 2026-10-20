import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId, type SessionQuitAttemptId } from '@deepseek-ai/dsh-session'
import type { SessionWriteState } from '@deepseek-ai/dsh-session-persistence'
import { StorageLifecycle } from '../src/storage-lifecycle.ts'

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })

const counters = { events: 0, bytes: 0, totalEvents: 0, totalBytes: 0,
  oldestAt: null, lastSuccessAt: null, waitTimeoutMs: 30000 }
const healthy: SessionWriteState = { ...counters, phase: 'healthy', errorCode: null }
const quitId = 'synthetic-storage-quit' as SessionQuitAttemptId

function fixture(options: { persistence?: boolean; commands?: boolean } = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  let state: SessionWriteState = healthy
  const session = Session.create(SessionId('synthetic-storage-session'))
  const get = vi.fn((id: SessionId) => id === session.id ? session : undefined)
  const agents: { cancel: ReturnType<typeof vi.fn>; whenIdle: () => Promise<void> }[] = []
  const flushAll = vi.fn(() => Promise.resolve())
  const writeState = vi.fn((_session?: Session): SessionWriteState => state)
  const whenSettled = vi.fn(() => Promise.resolve())
  ctx.provide('sessions', { get } as never)
  ctx.provide('agents', { list: () => agents } as never)
  const persistence = { writeState, flushAll }
  if (options.persistence !== false) ctx.provide('sessionPersistence', persistence as never)
  if (options.commands !== false) ctx.provide('commands', { whenSettled } as never)
  return { ctx, storage: new StorageLifecycle(ctx), session, get, agents, flushAll, writeState, whenSettled,
    setState(value: SessionWriteState) { state = value }, persistence }
}

it('observes the exact requested session and blocks admission for each unhealthy phase', () => {
  const run = fixture()
  expect(run.storage.handle({ kind: 'state', sessionId: run.session.id }).write).toEqual(healthy)
  expect(run.writeState).toHaveBeenLastCalledWith(run.session)
  run.storage.assertAdmission(run.session)
  expect(run.get).toHaveBeenCalledWith(run.session.id)
  const cases: [SessionWriteState, string][] = [
    [{ ...counters, phase: 'pressured', errorCode: null }, 'storage-busy'],
    [{ ...counters, phase: 'closing', errorCode: null }, 'storage-closing'],
    [{ ...counters, phase: 'failed', errorCode: 'storage-write-failed' }, 'storage-write-failed'],
    [{ ...counters, phase: 'failed', errorCode: 'storage-stalled' }, 'storage-stalled'],
  ]
  for (const [state, code] of cases) {
    run.setState(state)
    expect(() => { run.storage.assertAdmission(run.session) }).toThrow(code)
    expect(run.storage.handle({ kind: 'state', sessionId: run.session.id }).write).toEqual(state)
  }
  run.storage.handle({ kind: 'state', sessionId: SessionId('missing-session') })
  expect(run.writeState).toHaveBeenLastCalledWith(undefined)
})

it('owns one save retry across response polls and permits a new retry after disk recovery', async () => {
  const run = fixture()
  const blocked = Promise.withResolvers<undefined>()
  run.setState({ ...counters, phase: 'failed', errorCode: 'storage-write-failed' })
  run.flushAll.mockReturnValueOnce(blocked.promise)
  expect(run.storage.handle({ kind: 'retry-save' }).retrying).toBe(true)
  expect(run.storage.handle({ kind: 'retry-save' }).retrying).toBe(true)
  expect(run.flushAll).toHaveBeenCalledTimes(1)
  blocked.reject(new Error('synthetic disk still unavailable'))
  await vi.waitFor(() => { expect(run.storage.handle({ kind: 'state' }).retrying).toBe(false) })
  expect(run.storage.handle({ kind: 'state' }).write.phase).toBe('failed')
  run.flushAll.mockImplementationOnce(() => { run.setState(healthy); return Promise.resolve() })
  expect(run.storage.handle({ kind: 'retry-save' }).retrying).toBe(true)
  await vi.waitFor(() => { expect(run.storage.handle({ kind: 'state' }).retrying).toBe(false) })
  expect(run.flushAll).toHaveBeenCalledTimes(2)
  expect(run.storage.handle({ kind: 'state' }).write).toEqual(healthy)
})

it('keeps a repeated quit identity on one quiescence barrier and rejects competing identities', async () => {
  const run = fixture()
  const idle = Promise.withResolvers<undefined>()
  const cancel = vi.fn()
  run.agents.push({ cancel, whenIdle: () => idle.promise })
  const activeSignal = run.storage.activitySignal
  const request = { kind: 'prepare-quit' as const, attemptId: quitId, epoch: 0 }
  expect(run.storage.handle(request).quit?.phase).toBe('stopping')
  expect(activeSignal.aborted).toBe(true)
  expect(run.storage.handle(request).quit?.phase).toBe('stopping')
  expect(cancel).toHaveBeenCalledTimes(1)
  expect(() => { run.storage.assertAdmission() }).toThrow('storage-closing')
  expect(() => run.storage.handle({ ...request, attemptId: 'another' as SessionQuitAttemptId })).toThrow('another quit attempt')
  expect(() => run.storage.handle({ kind: 'cancel-quit', attemptId: 'another' as SessionQuitAttemptId, epoch: 0 })).toThrow('does not match')
  idle.resolve(undefined)
  await vi.waitFor(() => { expect(run.storage.handle({ kind: 'state' }).quit?.safeToQuit).toBe(true) })
  expect(run.flushAll).toHaveBeenCalledTimes(1)
  expect(run.whenSettled).toHaveBeenCalledTimes(1)
  expect(run.storage.handle(request).quit?.safeToQuit).toBe(true)
  expect(run.flushAll).toHaveBeenCalledTimes(1)
  expect(run.storage.handle({ kind: 'cancel-quit', attemptId: quitId, epoch: 0 }).quitEpoch).toBe(1)
  expect(run.storage.activitySignal.aborted).toBe(false)
  run.storage.assertAdmission()
  expect(run.storage.handle(request).quit).toBeNull()
})

it('reports failed quiescence and restarts the same quit identity only on an explicit retry', async () => {
  const run = fixture({ commands: false })
  const whenIdle = vi.fn().mockRejectedValueOnce(new Error('synthetic agent teardown failed')).mockResolvedValue(undefined)
  const cancel = vi.fn()
  run.agents.push({ cancel, whenIdle })
  const request = { kind: 'prepare-quit' as const, attemptId: quitId, epoch: 0 }
  run.storage.handle(request)
  await vi.waitFor(() => { expect(run.storage.handle({ kind: 'state' }).quit).toMatchObject({ phase: 'failed', safeToQuit: false }) })
  expect(run.flushAll).not.toHaveBeenCalled()
  expect(cancel).toHaveBeenCalledTimes(1)
  run.storage.handle(request)
  await vi.waitFor(() => { expect(run.storage.handle({ kind: 'state' }).quit?.safeToQuit).toBe(true) })
  expect(cancel).toHaveBeenCalledTimes(2)
  expect(run.flushAll).toHaveBeenCalledTimes(1)
})

it('refuses quit readiness when a resolved save still leaves unconfirmed events', async () => {
  const run = fixture()
  run.setState({ ...healthy, events: 2, totalEvents: 2 })
  run.storage.handle({ kind: 'prepare-quit', attemptId: quitId, epoch: 0 })
  await vi.waitFor(() => { expect(run.storage.handle({ kind: 'state' }).quit).toMatchObject({ phase: 'failed', safeToQuit: false }) })
  run.setState(healthy)
  run.storage.handle({ kind: 'prepare-quit', attemptId: quitId, epoch: 0 })
  await vi.waitFor(() => { expect(run.storage.handle({ kind: 'state' }).quit?.safeToQuit).toBe(true) })
})

it('rejects invalid quit epochs and empty current identities before stopping work', () => {
  const run = fixture()
  for (const epoch of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 1]) {
    expect(() => run.storage.handle({ kind: 'prepare-quit', attemptId: quitId, epoch })).toThrow('epoch')
  }
  expect(() => run.storage.handle({ kind: 'prepare-quit', attemptId: '' as SessionQuitAttemptId, epoch: 0 })).toThrow('non-empty')
  expect(run.storage.activitySignal.aborted).toBe(false)
  expect(run.flushAll).not.toHaveBeenCalled()
})

it('fails closed without a persistence provider instead of announcing saved state', async () => {
  const run = fixture({ persistence: false })
  expect(() => { run.storage.assertAdmission() }).toThrow('storage-write-failed')
  expect(() => run.storage.handle({ kind: 'state' })).toThrow('storage-write-failed')
  expect(() => run.storage.handle({ kind: 'prepare-quit', attemptId: quitId, epoch: 0 })).toThrow('storage-write-failed')
  run.ctx.provide('sessionPersistence', run.persistence as never)
  await vi.waitFor(() => { expect(run.storage.handle({ kind: 'state' }).quit?.safeToQuit).toBe(true) })
})

it('does not publish saving for a quit cancelled as command quiescence settles', async () => {
  const run = fixture()
  const settled = Promise.withResolvers<undefined>()
  run.whenSettled.mockReturnValueOnce(settled.promise)
  run.storage.handle({ kind: 'prepare-quit', attemptId: quitId, epoch: 0 })
  await vi.waitFor(() => { expect(run.whenSettled).toHaveBeenCalledTimes(1) })
  const cancelled = settled.promise.then(() => run.storage.handle({ kind: 'cancel-quit', attemptId: quitId, epoch: 0 }))
  settled.resolve(undefined)
  await cancelled
  await Promise.resolve()
  expect(run.storage.handle({ kind: 'state' }).quit).toBeNull()
  expect(run.flushAll).not.toHaveBeenCalled()
  expect(run.storage.activitySignal.aborted).toBe(false)
})

it('does not publish readiness for a quit cancelled between save confirmation and its response', async () => {
  const run = fixture()
  let confirmed = false
  let cancelScheduled = false
  const cancelDelivered = Promise.withResolvers<undefined>()
  run.flushAll.mockImplementationOnce(() => { confirmed = true; return Promise.resolve() })
  run.writeState.mockImplementation(() => {
    if (confirmed && !cancelScheduled) {
      cancelScheduled = true
      queueMicrotask(() => { queueMicrotask(() => {
        run.storage.handle({ kind: 'cancel-quit', attemptId: quitId, epoch: 0 })
        cancelDelivered.resolve(undefined)
      }) })
    }
    return healthy
  })
  run.storage.handle({ kind: 'prepare-quit', attemptId: quitId, epoch: 0 })
  await cancelDelivered.promise
  await Promise.resolve()
  expect(run.storage.handle({ kind: 'state' }).quit).toBeNull()
  expect(run.flushAll).toHaveBeenCalledTimes(1)
  expect(run.storage.activitySignal.aborted).toBe(false)
  run.storage.handle({ kind: 'prepare-quit', attemptId: quitId, epoch: 1 })
  await vi.waitFor(() => { expect(run.storage.handle({ kind: 'state' }).quit?.safeToQuit).toBe(true) })
})
