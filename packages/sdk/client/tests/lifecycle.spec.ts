/**
 * `DeepSeekHarness` start/close ownership against a fully scripted client: one
 * memoized attempt owns the handshake until its failed-handshake cleanup
 * settles, so concurrent starts join that attempt instead of racing a second
 * client against the runtime that is still exiting. Every wait here is a
 * deferred settlement or an event-loop turn — no fixed sleeps, no subprocess.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { DeepSeekHarness, TransportClosedError } from '../src/index.ts'
import type { HarnessClient } from '../src/client.ts'
import type { DeepSeekHarnessOptions } from '../src/types.ts'

/** A settlement handle for one promise completed without a value. */
interface Completion {
  promise: Promise<void>
  resolve: () => void
  reject: (error: unknown) => void
}

/**
 * @returns a promise whose settlement the test controls directly.
 */
function completion(): Completion {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Drain the attempt's queued continuations (event-loop turns, never a sleep). */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 4; turn++) await new Promise(resolve => setImmediate(resolve))
}

/** What each scripted client method does for one scenario. */
interface ClientScript {
  /** Runs inside `start()` after the closed check. */
  start?: () => void
  /** The handshake outcome; omitted resolves. */
  initialize?: () => Promise<void>
  /** The teardown outcome; omitted resolves. */
  close?: () => Promise<void>
}

/** Counters and scripted outcomes for one `HarnessClient` stand-in. */
class ScriptedClient {
  startCalls = 0
  initializeCalls = 0
  closeCalls = 0
  cleanupRuns = 0
  closed = false
  private closeTask: Promise<void> | undefined

  /** @param script - per-method outcomes for this scenario. */
  constructor(private readonly script: ClientScript = {}) {}

  /** Mirror the real client: reuse after close throws; a repeated start is a no-op. */
  start(): void {
    this.startCalls += 1
    if (this.closed) throw new TransportClosedError('DeepSeek Harness runtime client is closed')
    this.script.start?.()
  }

  /** @returns the scripted handshake outcome. */
  initialize(): Promise<void> {
    this.initializeCalls += 1
    return this.script.initialize?.() ?? Promise.resolve()
  }

  /** Mirror the real client: one memoized teardown task shared by every caller. */
  close(): Promise<void> {
    this.closeCalls += 1
    this.closed = true
    if (this.closeTask === undefined) {
      this.cleanupRuns += 1
      this.closeTask = (async () => { await this.script.close?.() })()
    }
    return this.closeTask
  }

  /** The double satisfies the lifecycle surface `DeepSeekHarness` owns. */
  asClient(): HarnessClient {
    return this as unknown as HarnessClient
  }
}

/** The production helper's own construction seam: options plus a client factory. */
const HarnessConstructor = DeepSeekHarness as unknown as new (
  options: DeepSeekHarnessOptions,
  clientFactory: () => HarnessClient,
) => DeepSeekHarness

const openedHarnesses: DeepSeekHarness[] = []

afterEach(async () => {
  for (const harness of openedHarnesses.splice(0)) await harness.close().catch(() => {})
})

interface ScriptedHarness {
  harness: DeepSeekHarness
  clients: ScriptedClient[]
}

/**
 * @param scripts - one script per client the factory will create, in order.
 * @returns the harness under test plus the clients it created.
 */
function scriptedHarness(scripts: ClientScript[] = []): ScriptedHarness {
  const clients: ScriptedClient[] = []
  const harness = new HarnessConstructor({}, () => {
    const client = new ScriptedClient(scripts[clients.length] ?? {})
    clients.push(client)
    return client.asClient()
  })
  openedHarnesses.push(harness)
  return { harness, clients }
}

describe('DeepSeekHarness lifecycle ownership', () => {
  it('performs one handshake for concurrent starts', async () => {
    const initialize = completion()
    const { harness, clients } = scriptedHarness([{ initialize: () => initialize.promise }])

    const attempts = [harness.start(), harness.start(), harness.start()]

    expect(clients).toHaveLength(1)
    expect(clients[0]!.startCalls).toBe(1)
    expect(clients[0]!.initializeCalls).toBe(1)
    initialize.resolve()
    await Promise.all(attempts)
    expect(clients[0]!.initializeCalls).toBe(1)
    await harness.close()
    expect(clients[0]!.cleanupRuns).toBe(1)
  })

  it('joins a start during the failed-handshake cleanup window instead of racing a second client', async () => {
    const initialize = completion()
    const cleanup = completion()
    const initError = new Error('scripted init failure')
    const { harness, clients } = scriptedHarness([
      { initialize: () => initialize.promise, close: () => cleanup.promise },
    ])

    const first = harness.start()
    initialize.reject(initError)
    await settle()
    const cleanupStarted = clients[0]!.cleanupRuns

    // Cleanup is still in flight: these starts must observe the pending
    // attempt, not open a competing one against the exiting client.
    const second = harness.start()
    const third = harness.start()
    const windowClients = clients.length
    const windowStarts = clients[0]!.startCalls
    const windowInitializes = clients[0]!.initializeCalls

    cleanup.resolve()
    await expect(first).rejects.toBe(initError)
    await expect(second).rejects.toBe(initError)
    await expect(third).rejects.toBe(initError)

    expect(cleanupStarted).toBe(1)
    expect(windowClients).toBe(1)
    expect(windowStarts).toBe(1)
    expect(windowInitializes).toBe(1)
    // Exactly one replacement client, created only after cleanup settled.
    expect(clients).toHaveLength(2)
  })

  it('retries on one fresh client after cleanup and is not clobbered by the settled attempt', async () => {
    const initialize = completion()
    const cleanup = completion()
    const retryInitialize = completion()
    const initError = new Error('scripted init failure')
    const { harness, clients } = scriptedHarness([
      { initialize: () => initialize.promise, close: () => cleanup.promise },
      { initialize: () => retryInitialize.promise },
    ])

    const first = harness.start()
    initialize.reject(initError)
    await settle()
    const witness = harness.start()
    cleanup.resolve()
    await expect(first).rejects.toBe(initError)
    await expect(witness).rejects.toBe(initError)
    expect(clients).toHaveLength(2)

    // The settled attempt left exactly one usable client behind.
    const retry = harness.start()
    expect(clients).toHaveLength(2)
    expect(clients[1]!.startCalls).toBe(1)
    expect(clients[1]!.initializeCalls).toBe(1)
    expect(harness.client).toBe(clients[1]!.asClient())
    retryInitialize.resolve()
    await retry
  })

  it('preserves both causes and keeps the unproven client when cleanup fails', async () => {
    const initialize = completion()
    const cleanup = completion()
    const initError = new Error('scripted init failure')
    const cleanupError = new Error('scripted cleanup failure')
    const { harness, clients } = scriptedHarness([
      { initialize: () => initialize.promise, close: () => cleanup.promise },
    ])

    const first = harness.start()
    initialize.reject(initError)
    await settle()
    const witness = harness.start()
    cleanup.reject(cleanupError)

    const firstFailure = await first.catch((error: unknown) => error)
    const witnessFailure = await witness.catch((error: unknown) => error)
    expect(firstFailure).toBeInstanceOf(AggregateError)
    expect((firstFailure as AggregateError).errors).toEqual([initError, cleanupError])
    // The window start observed the same attempt; it never opened a competitor.
    expect(witnessFailure).toBe(firstFailure)
    expect(clients).toHaveLength(1)
    expect(harness.client).toBe(clients[0]!.asClient())
  })

  it('keeps close terminal across the cleanup window and the late handshake outcome', async () => {
    const initialize = completion()
    const cleanup = completion()
    const initError = new Error('scripted init failure')
    const { harness, clients } = scriptedHarness([
      { initialize: () => initialize.promise, close: () => cleanup.promise },
    ])

    const attempt = harness.start()
    initialize.reject(initError)
    await settle()

    // close() lands while the attempt's cleanup is still in flight.
    const closing = harness.close()
    cleanup.resolve()
    await closing
    await expect(attempt).rejects.toBe(initError)
    expect(clients).toHaveLength(1)
    expect(harness.client).toBe(clients[0]!.asClient())
    // Terminal: a later start reuses the closed client and never spawns.
    await expect(harness.start()).rejects.toBeInstanceOf(TransportClosedError)
    expect(clients).toHaveLength(1)
    expect(clients[0]!.cleanupRuns).toBe(1)
  })

  it('does not install a replacement client when a close wins a pending handshake', async () => {
    const initialize = completion()
    const { harness, clients } = scriptedHarness([{ initialize: () => initialize.promise }])

    const pending = harness.start()
    await harness.close()
    initialize.reject(new TransportClosedError('late initialize failure'))

    await expect(pending).rejects.toThrow('late initialize failure')
    expect(clients).toHaveLength(1)
    expect(harness.client).toBe(clients[0]!.asClient())
  })

  interface FailureForm {
    label: string
    script: () => ClientScript
  }

  const failureForms: FailureForm[] = [
    {
      label: 'a synchronous initialize throw',
      script: () => ({ initialize: () => { throw new Error('scripted init failure') } }),
    },
    {
      label: 'an asynchronous initialize rejection',
      script: () => ({ initialize: () => Promise.reject(new Error('scripted init failure')) }),
    },
    {
      label: 'a synchronous start throw',
      script: () => ({ start: () => { throw new Error('scripted init failure') } }),
    },
  ]

  for (const form of failureForms) {
    it(`releases the same way after ${form.label}`, async () => {
      const { harness, clients } = scriptedHarness([form.script()])

      const failure = await harness.start().catch((error: unknown) => error)
      expect(failure).toMatchObject({ message: 'scripted init failure' })
      expect(clients[0]!.cleanupRuns).toBe(1)
      // The failed attempt installed exactly one replacement client...
      expect(clients).toHaveLength(2)
      // ...and a retry uses it without resurrecting the failed attempt.
      await harness.start()
      expect(clients[0]!.startCalls).toBe(1)
      expect(clients[1]!.startCalls).toBe(1)
      expect(clients[1]!.initializeCalls).toBe(1)
      await harness.close()
    })
  }

  it('keeps independent harnesses independent', async () => {
    const failingInitialize = completion()
    const initError = new Error('first harness failed')
    const first = scriptedHarness([{ initialize: () => failingInitialize.promise }])
    const second = scriptedHarness([])

    const failing = first.harness.start()
    await second.harness.start()
    expect(second.clients).toHaveLength(1)
    failingInitialize.reject(initError)
    await expect(failing).rejects.toBe(initError)
    // The healthy harness neither joined the failure nor grew a second client.
    expect(second.clients).toHaveLength(1)
    expect(second.clients[0]!.initializeCalls).toBe(1)
    expect(second.harness.client).toBe(second.clients[0]!.asClient())
  })
})
