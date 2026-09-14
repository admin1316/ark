import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { lstat, mkdtemp, mkdir, readFile, readdir, readlink, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'
import { encodeSegment, sessionDir, type JsonlCompression } from '../src/format.ts'
import { meta, oneTurnLog } from '../../session-persistence/tests/contract.ts'

async function fixture(compression: JsonlCompression) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-jsonl-delete-'))
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, { root, compression })
  const header = meta('delete-target', '/work')
  const sibling = meta('keep-sibling', '/work')
  for (const value of [header, sibling]) {
    await ctx.sessionPersistence.create(value)
    await ctx.sessionPersistence.append(value.id, oneTurnLog())
  }
  return {
    ctx, root, header, sibling,
    directory: sessionDir(root, header.cwd, header.id),
    async dispose() {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    },
  }
}

it.each(['none', 'zstd'] as const)('deletes the owned %s session directory without touching a sibling', async (compression) => {
  const state = await fixture(compression)
  try {
    await writeFile(join(state.directory, 'attachment.txt'), 'owned attachment')
    await expect(state.ctx.sessionPersistence.delete(state.header.id)).resolves.toBe(true)
    await expect(stat(state.directory)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await state.ctx.sessionPersistence.load(state.sibling.id)).events).toEqual(oneTurnLog())
  } finally {
    await state.dispose()
  }
})

it.each(['none', 'zstd'] as const)('finishes %s deletion after the session was moved out of discovery', async (compression) => {
  const state = await fixture(compression)
  try {
    const tombstoneRoot = join(dirname(state.directory), '~delete')
    const tombstone = join(tombstoneRoot, encodeSegment(state.header.id))
    await mkdir(tombstoneRoot)
    await rename(state.directory, tombstone)
    expect((await state.ctx.sessionPersistence.list()).map(item => item.id)).toEqual([state.sibling.id])
    await expect(state.ctx.sessionPersistence.delete(state.header.id)).resolves.toBe(true)
    await expect(stat(tombstone)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(state.ctx.sessionPersistence.delete(state.header.id)).resolves.toBe(false)
  } finally {
    await state.dispose()
  }
})

it('rejects a symlink deletion root without removing the session or following the link', async () => {
  const state = await fixture('none')
  const outside = await mkdtemp(join(tmpdir(), 'dsh-jsonl-delete-outside-'))
  try {
    const sentinel = join(outside, 'preserve.txt')
    await writeFile(sentinel, 'preserved')
    await symlink(outside, join(dirname(state.directory), '~delete'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(state.ctx.sessionPersistence.delete(state.header.id)).rejects.toThrow('invalid session deletion directory')
    expect(await readFile(sentinel, 'utf8')).toBe('preserved')
    expect((await state.ctx.sessionPersistence.load(state.header.id)).events).toEqual(oneTurnLog())
  } finally {
    await state.dispose()
    await rm(outside, { recursive: true, force: true })
  }
})

it('refuses a symlinked writer-lock directory instead of locking through it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-jsonl-delete-locks-'))
  const outside = await mkdtemp(join(tmpdir(), 'dsh-jsonl-delete-locks-outside-'))
  const ctx = new Context()
  try {
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    const header = meta('lock-target', '/work')
    await ctx.sessionPersistence.create(header)
    await ctx.sessionPersistence.append(header.id, oneTurnLog())
    const log = join(sessionDir(root, header.cwd, header.id), 'session.jsonl')
    // The first append took its lock through the real directory; replace it with
    // the link afterwards so the delete refuses instead of locking through it.
    await rm(join(root, '~locks'), { recursive: true, force: true })
    await symlink(outside, join(root, '~locks'), process.platform === 'win32' ? 'junction' : 'dir')

    await expect(ctx.sessionPersistence.delete(header.id))
      .rejects.toThrow('invalid session writer lock directory')

    // The link stayed a link, no lock landed outside the root, and the stored
    // log was left for a store that can lock it again.
    expect((await lstat(join(root, '~locks'))).isSymbolicLink()).toBe(true)
    expect(await readlink(join(root, '~locks'))).toBe(outside)
    expect(await readdir(outside)).toEqual([])
    expect(await readFile(log, 'utf8')).toContain('"lock-target"')
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

it('refuses a tombstone that is not an ordinary directory', async () => {
  const state = await fixture('none')
  try {
    const tombstoneRoot = join(dirname(state.directory), '~delete')
    const pending = join(tombstoneRoot, encodeSegment(state.header.id))
    await mkdir(tombstoneRoot)
    await writeFile(pending, 'half-written tombstone')

    await expect(state.ctx.sessionPersistence.delete(state.header.id))
      .rejects.toThrow('invalid session deletion tombstone')

    // A malformed tombstone is reported, not deleted or resolved by guesswork.
    expect(await readFile(pending, 'utf8')).toBe('half-written tombstone')
    expect((await state.ctx.sessionPersistence.load(state.header.id)).events).toEqual(oneTurnLog())
  } finally {
    await state.dispose()
  }
})

it('refuses an id with pending tombstones in two projects instead of choosing one', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-jsonl-delete-ambiguous-'))
  const ctx = new Context()
  try {
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    const id = 'ambiguous-target'
    const pendings: string[] = []
    for (const cwd of ['/work/one', '/work/two']) {
      const project = dirname(sessionDir(root, cwd, id))
      await mkdir(project, { recursive: true })
      const pending = join(project, '~delete', encodeSegment(id))
      await mkdir(pending, { recursive: true })
      pendings.push(pending)
    }

    await expect(ctx.sessionPersistence.delete(id))
      .rejects.toThrow('duplicate session deletion tombstones')

    for (const pending of pendings) expect((await lstat(pending)).isDirectory()).toBe(true)
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

it('refuses to delete through a symlinked session directory', async () => {
  const state = await fixture('none')
  const movedRoot = await mkdtemp(join(tmpdir(), 'dsh-jsonl-delete-moved-'))
  try {
    const moved = join(movedRoot, encodeSegment(state.header.id))
    await rename(state.directory, moved)
    await symlink(moved, state.directory, process.platform === 'win32' ? 'junction' : 'dir')

    await expect(state.ctx.sessionPersistence.delete(state.header.id))
      .rejects.toThrow('session deletion requires an ordinary directory and log')

    // The link is not followed: the real directory and its log are untouched.
    expect((await lstat(state.directory)).isSymbolicLink()).toBe(true)
    expect(await readFile(join(moved, 'session.jsonl'), 'utf8')).toContain('"delete-target"')
  } finally {
    await state.dispose()
    await rm(movedRoot, { recursive: true, force: true })
  }
})

it('refuses to delete a session whose log carries no valid header line', async () => {
  const state = await fixture('none')
  try {
    const log = join(state.directory, 'session.jsonl')
    await writeFile(log, '')

    await expect(state.ctx.sessionPersistence.delete(state.header.id))
      .rejects.toThrow('corrupt session log: invalid header line')

    // The empty log is left for inspection rather than destroyed.
    expect(await readFile(log, 'utf8')).toBe('')
    expect((await state.ctx.sessionPersistence.list()).map(item => item.id)).toEqual([state.sibling.id])
  } finally {
    await state.dispose()
  }
})
