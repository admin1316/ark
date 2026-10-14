import { afterEach, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import { Context } from '@deepseek-ai/cordis'
import { lstat, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { CallId, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { type SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import SessionPersistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionPersistenceSqlite from '@deepseek-ai/dsh-session-persistence-sqlite'
import { meta } from '../../session-persistence/tests/contract.ts'
import { testSql } from './test-sql.ts'

type BackendName = 'jsonl-zstd' | 'sqlite'

interface MountedBackend {
  readonly persistence: SessionPersistence
  dispose(): Promise<void>
}

const directories: string[] = []
const failedDisposals = new Set<string>()
async function cleanupDirectories(owned: readonly string[]): Promise<void> {
  const cleanup = await Promise.allSettled(owned.map((directory) => {
    if (failedDisposals.has(directory)) {
      return Promise.reject(new Error('differential fixture owner did not reach quiescence; directory retained'))
    }
    return rm(directory, { recursive: true, force: true })
  }))
  const failures = cleanup.flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : [])
  if (failures.length) throw new AggregateError(failures, 'differential fixture directory cleanup failed')
}

afterEach(async () => {
  await cleanupDirectories(directories.splice(0))
})

async function freshDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  directories.push(directory)
  return directory
}

async function disposalErrors(ctx: Context, cleanups: readonly (() => Promise<void>)[]): Promise<unknown[]> {
  const logged = vi.spyOn(ctx.logger, 'error')
  try {
    const failures: unknown[] = []
    for (const cleanup of cleanups) {
      const [result] = await Promise.allSettled([cleanup()])
      if (result?.status === 'rejected') failures.push(result.reason as unknown)
    }
    const calls: unknown[][] = logged.mock.calls
    return [...failures, ...calls.flat()]
  } finally {
    logged.mockRestore()
  }
}

async function mount(name: BackendName, root: string, ctx = new Context()): Promise<MountedBackend> {
  let disposeBackend: () => Promise<void>
  try {
    await ctx.plugin(SessionStore)
    switch (name) {
      case 'jsonl-zstd': {
        const fiber = await ctx.plugin(SessionPersistenceJsonl, { root: join(root, 'jsonl') })
        disposeBackend = () => fiber.dispose()
        break
      }
      case 'sqlite': {
        const fiber = await ctx.plugin(SessionPersistenceSqlite, { path: join(root, 'sessions.db') })
        disposeBackend = () => fiber.dispose()
        break
      }
    }
  } catch (error: unknown) {
    const failures = await disposalErrors(ctx, [() => ctx.fiber.dispose()])
    if (failures.length) {
      failedDisposals.add(dirname(root))
      throw new AggregateError([error, ...failures], 'differential fixture startup and context disposal failed')
    }
    throw error
  }
  return { persistence: ctx.sessionPersistence, dispose: async () => {
    const failures = await disposalErrors(ctx, [disposeBackend, () => ctx.fiber.dispose()])
    if (failures.length) {
      failedDisposals.add(dirname(root))
      throw new AggregateError(failures, 'differential fixture backend and context disposal failed')
    }
  } }
}

function closedChunkLog(
  entries: readonly { readonly chunk: StreamChunk; readonly time: number }[],
): SessionEvent[] {
  const chunks = entries.map(({ chunk, time }, index): SessionEvent => ({
    type: 'assistant/chunk',
    seq: index + 2,
    time,
    data: { turn: 1, step: 1, chunk },
  }))
  return [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
    ...chunks,
    { type: 'step/end', seq: chunks.length + 2, time: 3, data: { turn: 1, step: 1 } },
    {
      type: 'turn/end',
      seq: chunks.length + 3,
      time: 4,
      data: { turn: 1, reason: { kind: 'completed' } },
    },
  ]
}

function packingMatrixLog(): SessionEvent[] {
  const entries: { chunk: StreamChunk; time: number }[] = [
    ...Array.from({ length: 5 }, (_, index) => ({
      chunk: { type: 'text-delta' as const, index: 0, text: `text-${index}` },
      time: 1_000 + index,
    })),
    ...Array.from({ length: 4 }, (_, index) => ({
      chunk: { type: 'reasoning-delta' as const, index: 1, text: `reason-${index}` },
      time: 990 - index,
    })),
    ...Array.from({ length: 4 }, (_, index) => ({
      chunk: {
        type: 'tool-call-delta' as const,
        index: 2,
        id: CallId('named-call'),
        name: 'write',
        argumentsDelta: `{${index}`,
      },
      time: 2_000 + index,
    })),
    ...Array.from({ length: 3 }, (_, index) => ({
      chunk: {
        type: 'tool-call-delta' as const,
        index: 3,
        id: CallId('unnamed-call'),
        argumentsDelta: `${index}}`,
      },
      time: 3_000 + index,
    })),
    { chunk: { type: 'block-start', index: 4, blockType: 'text' }, time: 4_000 },
    { chunk: { type: 'text-delta', index: 4, text: 'short-a' }, time: 4_001 },
    { chunk: { type: 'text-delta', index: 4, text: 'short-b' }, time: 4_002 },
    { chunk: { type: 'text-delta', index: 5, text: 'scalar-singleton' }, time: 4_003 },
    { chunk: { type: 'finish', reason: { kind: 'stop' } }, time: 4_004 },
  ]
  return closedChunkLog(entries)
}

function batches(events: readonly SessionEvent[], sizes: readonly number[]): SessionEvent[][] {
  const result: SessionEvent[][] = []
  let offset = 0
  let index = 0
  while (offset < events.length) {
    const size = sizes[index % sizes.length] as number
    result.push(events.slice(offset, offset + size))
    offset += size
    index += 1
  }
  return result
}

async function verifyBackend(
  name: BackendName,
  root: string,
  events: readonly SessionEvent[],
  sizes: readonly number[],
): Promise<void> {
  const header = { ...meta('differential', '/work'), delegationDepth: 0 }
  for (const reopened of [false, true]) {
    const mounted = await mount(name, root)
    const failures: unknown[] = []
    try {
      if (reopened) {
        expect(await mounted.persistence.inspect(header.id), `${name} reopen`).toEqual({ meta: header, events })
      } else {
        await mounted.persistence.create(header)
        for (const batch of batches(events, sizes)) {
          await mounted.persistence.append(header.id, batch)
        }
        expect(await mounted.persistence.inspect(header.id), name).toEqual({ meta: header, events })
        expect(await mounted.persistence.list(), name).toEqual([header])
        const revision = (await mounted.persistence.listSnapshots())[0]?.revision
        for (let fromSeq = 0; fromSeq <= events.length + 1; fromSeq += 1) {
          expect((await mounted.persistence.readFrom(header.id, fromSeq)).events, `${name} seq ${fromSeq}`)
            .toEqual(events.slice(fromSeq))
        }
        expect((await mounted.persistence.listSnapshots())[0]?.revision, name).toBe(revision)
      }
    } catch (error: unknown) {
      failures.push(error)
    }
    try {
      await mounted.dispose()
    } catch (error: unknown) {
      failures.push(error)
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'differential verification and disposal failed')
  }
}

const streamChunkArbitrary: fc.Arbitrary<StreamChunk> = fc.oneof(
  fc.record({ type: fc.constant<'text-delta'>('text-delta'), index: fc.nat(2), text: fc.string() }),
  fc.record({ type: fc.constant<'reasoning-delta'>('reasoning-delta'), index: fc.nat(2), text: fc.string() }),
  fc.record({
    type: fc.constant<'tool-call-delta'>('tool-call-delta'),
    index: fc.nat(2),
    id: fc.constantFrom(CallId('call-1'), CallId('call-2')),
    argumentsDelta: fc.string(),
  }),
  fc.record({
    type: fc.constant<'tool-call-delta'>('tool-call-delta'),
    index: fc.nat(2),
    id: fc.constantFrom(CallId('call-1'), CallId('call-2')),
    name: fc.constantFrom('read', 'write'),
    argumentsDelta: fc.string(),
  }),
  fc.record({
    type: fc.constant<'block-start'>('block-start'),
    index: fc.nat(2),
    blockType: fc.constant<'text'>('text'),
  }),
  fc.record({ type: fc.constant<'finish'>('finish'), reason: fc.constant({ kind: 'stop' as const }) }),
)

const randomWorkload = fc.record({
  entries: fc.array(fc.record({
    chunk: streamChunkArbitrary,
    time: fc.oneof(
      { weight: 4, arbitrary: fc.integer({ min: 0, max: 10_000 }) },
      { weight: 1, arbitrary: fc.integer({ min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER }) },
    ),
  }), { maxLength: 30 }),
  batchSizes: fc.array(fc.integer({ min: 1, max: 8 }), { minLength: 1, maxLength: 8 }),
}).map(({ entries, batchSizes }) => ({
  events: JSON.parse(JSON.stringify(closedChunkLog(entries))) as SessionEvent[],
  batchSizes,
}))

const randomizedDifferentialTimeoutMs = process.platform === 'win32' ? 120_000 : 60_000

describe('SQLite cross-backend differential behavior', () => {
  it('disposes an initialized Session store when SQLite rejects its database path', async () => {
    const directory = await freshDirectory('dsh-sqlite-invalid-mount-')
    const root = join(directory, 'sqlite')
    await mkdir(join(root, 'sessions.db'), { recursive: true })
    const ctx = new Context()
    let disposed = false
    ctx.effect(() => () => { disposed = true }, 'rejected mount owner')

    await expect(mount('sqlite', root, ctx)).rejects.toThrow('must be a regular file')
    expect(disposed).toBe(true)
    expect(failedDisposals.has(directory)).toBe(false)
  })

  it('retains the directory and both errors if rejected initialization cannot confirm context cleanup', async () => {
    const directory = await freshDirectory('dsh-sqlite-rejected-cleanup-')
    const root = join(directory, 'sqlite')
    const databasePath = join(root, 'sessions.db')
    await mkdir(databasePath, { recursive: true })
    const ctx = new Context()
    let disposed = false
    ctx.effect(() => () => { disposed = true }, 'rejected mount owner')
    const cleanupError = new Error('injected owner cleanup failure after actual join')
    const dispose = ctx.fiber.dispose
    const spy = vi.spyOn(ctx.fiber, 'dispose').mockImplementation(async () => {
      await dispose()
      throw cleanupError
    })
    try {
      const error: unknown = await mount('sqlite', root, ctx).catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(AggregateError)
      const errors: unknown[] = (error as AggregateError).errors
      expect(errors).toHaveLength(2)
      expect(errors[0]).toBeInstanceOf(Error)
      expect((errors[0] as Error).message).toContain('must be a regular file')
      expect(errors[1]).toBe(cleanupError)
      expect(failedDisposals.has(directory)).toBe(true)
      await expect(cleanupDirectories([directory])).rejects.toThrow('directory cleanup failed')
      expect((await lstat(databasePath)).isDirectory()).toBe(true)
    } finally {
      spy.mockRestore()
      // The injected rejection followed the actual join; only that confirmed
      // owner may release this negative control's retained test directory.
      if (disposed) failedDisposals.delete(directory)
    }
    expect(disposed).toBe(true)
  })

  it('rejects a logged disposal failure even when Cordis fulfills the Context join', async () => {
    const directory = await freshDirectory('dsh-sqlite-logged-cleanup-')
    const root = join(directory, 'sqlite')
    const databasePath = join(root, 'sessions.db')
    await mkdir(databasePath, { recursive: true })
    const ctx = new Context()
    let disposed = false
    ctx.effect(() => () => { disposed = true }, 'rejected mount owner')
    const cleanupError = new Error('injected actual effect disposal failure')
    ctx.effect(() => () => { throw cleanupError }, 'failing disposal negative control')
    try {
      const error: unknown = await mount('sqlite', root, ctx).catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(AggregateError)
      const errors: unknown[] = (error as AggregateError).errors
      expect(errors).toHaveLength(2)
      expect((errors[0] as Error).message).toContain('must be a regular file')
      expect(errors[1]).toBe(cleanupError)
      expect(failedDisposals.has(directory)).toBe(true)
      await expect(cleanupDirectories([directory])).rejects.toThrow('directory cleanup failed')
      expect((await lstat(databasePath)).isDirectory()).toBe(true)
    } finally {
      // The control owns only synchronous effects and a rejected unopened
      // database; its confirmed join permits cleanup after testing refusal.
      if (disposed) failedDisposals.delete(directory)
    }
    expect(disposed).toBe(true)
  })

  it('preserves a verification failure together with its logged backend disposal failure', async () => {
    const directory = await freshDirectory('dsh-sqlite-verification-cleanup-')
    const root = join(directory, 'sqlite')
    const verificationError = new Error('injected verification create failure')
    const cleanupError = new Error('injected backend disposal failure')
    let disposed = false
    const create = vi.spyOn(SessionPersistenceSqlite.prototype, 'create').mockImplementationOnce(function(this: SessionPersistenceSqlite) {
      this.ctx.effect(() => () => {
        disposed = true
        throw cleanupError
      }, 'failing backend disposal negative control')
      return Promise.reject(verificationError)
    })
    try {
      const error: unknown = await verifyBackend('sqlite', root, closedChunkLog([]), [1])
        .catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(AggregateError)
      const errors: unknown[] = (error as AggregateError).errors
      expect(errors).toHaveLength(2)
      expect(errors[0]).toBe(verificationError)
      expect(errors[1]).toBeInstanceOf(AggregateError)
      expect((errors[1] as AggregateError).errors).toEqual([cleanupError])
      await expect(cleanupDirectories([directory])).rejects.toThrow('directory cleanup failed')
      expect((await lstat(root)).isDirectory()).toBe(true)
    } finally {
      create.mockRestore()
      // create rejected before opening SQLite and all Context work joined;
      // the only failing disposer is this synchronous negative control.
      if (disposed) failedDisposals.delete(directory)
    }
    expect(disposed).toBe(true)
  })

  it('matches JSONL/Zstandard for every packed kind, scalar fallback, suffix, partition, and reopen', async () => {
    const events = packingMatrixLog()
    for (const [partitionIndex, sizes] of [[events.length], [1], [2, 1, 5, 3]].entries()) {
      const directory = await freshDirectory(`dsh-sqlite-matrix-${partitionIndex}-`)
      for (const name of ['jsonl-zstd', 'sqlite'] as const) {
        const root = join(directory, name)
        await verifyBackend(name, root, events, sizes)
        if (name === 'sqlite') {
          const db = new DatabaseSync(join(root, 'sessions.db'), { readOnly: true })
          try {
            expect(db.prepare(testSql('count-physical-types')).all()).toEqual([
              [
                { type: 'reasoning-chunks', count: 1 },
                { type: 'text-chunks', count: 1 },
                { type: 'tool-call-chunks', count: 2 },
              ],
              [],
              [
                { type: 'reasoning-chunks', count: 1 },
                { type: 'text-chunks', count: 1 },
                { type: 'tool-call-chunks', count: 1 },
              ],
            ][partitionIndex])
          } finally {
            db.close()
          }
        }
      }
    }
  }, 30_000)

  it('matches JSONL/Zstandard across randomized logical logs and append partitions', async () => {
    await fc.assert(fc.asyncProperty(randomWorkload, async ({ events, batchSizes }) => {
      const directory = await freshDirectory('dsh-sqlite-property-')
      const failures: unknown[] = []
      try {
        for (const name of ['jsonl-zstd', 'sqlite'] as const) {
          await verifyBackend(name, join(directory, name), events, batchSizes)
        }
      } catch (error: unknown) {
        failures.push(error)
      }
      if (!failedDisposals.has(directory)) {
        try {
          await rm(directory, { recursive: true, force: true })
          const index = directories.indexOf(directory)
          if (index !== -1) directories.splice(index, 1)
        } catch (error: unknown) {
          failures.push(error)
        }
      }
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) throw new AggregateError(failures, 'differential workload and directory cleanup failed')
    }), { numRuns: 100, seed: 0x5A17E })
  }, randomizedDifferentialTimeoutMs)

})
