import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mkdtemp, mkdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
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
