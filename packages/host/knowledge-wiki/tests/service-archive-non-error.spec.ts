import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'

vi.mock('node:child_process', () => ({
  execFileSync: () => { throw 'primitive archive failure' },
}))

import KnowledgeWikiService from '../src/index.ts'

describe('archive primitive failures', () => {
  const roots: string[] = []
  const contexts: Context[] = []

  afterEach(async () => {
    for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('stringifies non-Error export and import failures', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wiki-archive-string-'))
    roots.push(root)
    mkdirSync(join(root, 'wiki'), { recursive: true })
    const ctx = new Context()
    contexts.push(ctx)
    const service = new KnowledgeWikiService(ctx, {
      wikiRoot: join(root, 'wiki'), mainRoot: root,
      credential: 'VISION_API_KEY', llmProvider: 'p', llmModel: 'm',
    }) as unknown as {
      snapshots: { dispose(): void }
      exportProject(): Promise<{ path: string; error?: string }>
      importProject(request: { path: string }): Promise<{ ok: boolean; error?: string }>
    }

    expect(await service.exportProject()).toEqual({ path: '', error: 'primitive archive failure' })
    expect(await service.importProject({ path: '/archive.zip' })).toEqual({
      ok: false, error: 'primitive archive failure',
    })
    service.snapshots.dispose()
  })
})
