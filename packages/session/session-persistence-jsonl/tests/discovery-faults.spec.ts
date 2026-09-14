/**
 * Discovery-fault coverage for the JSONL backend's list path.
 *
 * A log can disappear between the discovery probe and the header read (a
 * concurrent delete), and a header read can fail for a reason that is neither
 * absence nor a corrupt Zstandard frame (an I/O fault). Both are timing- or
 * environment-dependent, so the read-only `open` of the exact log path is
 * faulted here — the same shape as the existing stat-race seam in
 * `jsonl.spec.ts` — while the rest of the scan runs against real files.
 */
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { logPath, type JsonlCompression } from '../src/format.ts'
import { meta, oneTurnLog } from '../../session-persistence/tests/contract.ts'

interface HeaderReadFault {
  /** Absolute log path whose read-only opens are faulted. */
  path: string
  /** Read-only opens of {@link path} observed so far. */
  opens: number
  /** Fault injected for every open after the discovery probe. */
  mode: 'vanished' | 'io-error'
}

const fault = vi.hoisted(() => ({ current: undefined as HeaderReadFault | undefined }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: (async (...args: Parameters<typeof actual.open>) => {
      const target = fault.current
      if (target !== undefined && args[1] === 'r' && String(args[0]) === target.path) {
        target.opens += 1
        // The discovery probe is the first read-only open of the log; the header
        // read that follows it is the one a concurrent delete or an I/O fault
        // can break.
        if (target.opens > 1) {
          const vanished = target.mode === 'vanished'
          throw Object.assign(
            new Error(`${vanished ? 'ENOENT: no such file or directory' : 'EIO: i/o error'}, open '${target.path}'`),
            { code: vanished ? 'ENOENT' : 'EIO', syscall: 'open', path: target.path },
          )
        }
      }
      return actual.open(...args)
    }) as typeof actual.open,
  }
})

const contexts: Context[] = []
const roots: string[] = []

afterEach(async () => {
  fault.current = undefined
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture(): Promise<Context> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-jsonl-discovery-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  return ctx
}

/** Create one durable session and report the log path the backend chose for it. */
async function seed(ctx: Context, id: string): Promise<{ id: string; path: string }> {
  const header = meta(id, '/work')
  await ctx.sessionPersistence.create(header)
  await ctx.sessionPersistence.append(header.id, oneTurnLog())
  const service = ctx.get('sessionPersistence') as unknown as { root: string }
  return {
    id,
    path: logPath(service.root, header.cwd, header.id, 'none' satisfies JsonlCompression),
  }
}

it('skips a log that vanished after discovery and still lists the remaining sessions', async () => {
  const ctx = await fixture()
  const vanished = await seed(ctx, 'vanished-target')
  const survivor = await seed(ctx, 'surviving-sibling')
  expect(vanished.path.endsWith('session.jsonl')).toBe(true)
  const injected: HeaderReadFault = { path: vanished.path, opens: 0, mode: 'vanished' }
  fault.current = injected

  const listed = await ctx.sessionPersistence.list()

  expect(listed.map(item => item.id)).toEqual([survivor.id])
  expect(injected.opens).toBe(2)
  // The survivor is still a real, loadable log.
  expect((await ctx.sessionPersistence.load(survivor.id)).events).toEqual(oneTurnLog())
})

it('surfaces an unexpected header-read fault instead of reporting a shorter inventory', async () => {
  const ctx = await fixture()
  const broken = await seed(ctx, 'broken-target')
  const healthy = await seed(ctx, 'healthy-sibling')
  const injected: HeaderReadFault = { path: broken.path, opens: 0, mode: 'io-error' }
  fault.current = injected

  await expect(ctx.sessionPersistence.list()).rejects.toMatchObject({ code: 'EIO' })
  expect(injected.opens).toBe(2)

  fault.current = undefined
  expect((await ctx.sessionPersistence.list()).map(item => item.id).sort())
    .toEqual([broken.id, healthy.id].sort())
})
