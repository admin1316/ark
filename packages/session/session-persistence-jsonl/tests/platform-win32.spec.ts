/**
 * Platform-dispatch coverage for the JSONL deletion path.
 *
 * Windows publishes the tombstone directory through the Win32 durable-namespace
 * primitive instead of POSIX `mkdir` + parent `fsync`. That primitive cannot
 * load on this host, so the boundary is substituted with the filesystem work it
 * performs — `mkdir` for the durable directory, `rename` for the write-through
 * publication — while every line of the backend's own deletion logic runs for
 * real. The second case drives the same dispatch with a primitive that published
 * a reparse point, which is exactly the state the backend must refuse.
 */
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { lstat, mkdir, mkdtemp, readdir, rename, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { encodeSegment, sessionDir } from '../src/format.ts'
import { meta, oneTurnLog } from '../../session-persistence/tests/contract.ts'

/** The platform this test process really runs on; the link type needs it, not the stub. */
const hostPlatform = process.platform
const directoryLinkType = hostPlatform === 'win32' ? 'junction' : 'dir'

const win32State = vi.hoisted(() => ({
  /** Targets the platform primitive was asked to publish durably. */
  ensured: [] as string[],
  /** `[existing, replacement]` pairs published write-through. */
  published: [] as [string, string][],
  /** Target the primitive publishes as a directory reparse point instead of a real directory. */
  reparseRoot: undefined as string | undefined,
  /** Directory that reparse point resolves to. */
  reparseTarget: undefined as string | undefined,
}))

vi.mock('../src/win32.ts', () => ({
  ensureDurableDirectoryWin32: async (target: string): Promise<void> => {
    win32State.ensured.push(target)
    if (win32State.reparseRoot === target && win32State.reparseTarget !== undefined) {
      await mkdir(win32State.reparseTarget, { recursive: true })
      await symlink(win32State.reparseTarget, target, directoryLinkType)
      return
    }
    await mkdir(target, { recursive: true })
  },
  publishNewFileWin32: async (existing: string, replacement: string): Promise<void> => {
    win32State.published.push([existing, replacement])
    await rename(existing, replacement)
  },
}))

const contexts: Context[] = []
const roots: string[] = []

afterEach(async () => {
  win32State.ensured = []
  win32State.published = []
  win32State.reparseRoot = undefined
  win32State.reparseTarget = undefined
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function mountWindows(): Promise<{ ctx: Context; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-jsonl-win32-delete-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  return { ctx, root }
}

it('deletes through the Win32 durable-namespace path when the process reports Windows', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  const { ctx, root } = await mountWindows()
  const target = meta('win32-target', '/work')
  const sibling = meta('win32-sibling', '/work')
  for (const header of [target, sibling]) {
    await ctx.sessionPersistence.create(header)
    await ctx.sessionPersistence.append(header.id, oneTurnLog())
  }
  const directory = sessionDir(root, target.cwd, target.id)
  const tombstoneRoot = join(dirname(directory), '~delete')
  const tombstone = join(tombstoneRoot, encodeSegment(target.id))
  win32State.ensured = []
  win32State.published = []

  await expect(ctx.sessionPersistence.delete(target.id)).resolves.toBe(true)

  // The platform primitive — not the POSIX rename — published the tombstone.
  expect(win32State.ensured).toEqual([tombstoneRoot])
  expect(win32State.published).toEqual([[directory, tombstone]])
  await expect(lstat(directory)).rejects.toMatchObject({ code: 'ENOENT' })
  expect((await ctx.sessionPersistence.load(sibling.id)).events).toEqual(oneTurnLog())
})

it('refuses a tombstone root the Windows primitive published as a reparse point', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  const { ctx, root } = await mountWindows()
  const target = meta('win32-reparse', '/work')
  await ctx.sessionPersistence.create(target)
  await ctx.sessionPersistence.append(target.id, oneTurnLog())
  const directory = sessionDir(root, target.cwd, target.id)
  const outside = await mkdtemp(join(tmpdir(), 'dsh-jsonl-win32-reparse-'))
  roots.push(outside)
  win32State.published = []
  win32State.reparseRoot = join(dirname(directory), '~delete')
  win32State.reparseTarget = outside

  await expect(ctx.sessionPersistence.delete(target.id))
    .rejects.toThrow('invalid session deletion directory')

  // Nothing was published through the link and the session survived intact.
  expect(win32State.published).toEqual([])
  expect(await readdir(outside)).toEqual([])
  expect((await ctx.sessionPersistence.load(target.id)).events).toEqual(oneTurnLog())
})
