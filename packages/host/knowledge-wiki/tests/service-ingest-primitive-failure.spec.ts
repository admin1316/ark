import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import KnowledgeWikiService from '../src/index.ts'
import { wikiTestConfig } from './config-fixture.ts'

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('service ingest primitive failures', () => {
  it('stringifies a non-Error ingest rejection into the outcome warnings', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wiki-ingest-primitive-'))
    roots.push(root)
    mkdirSync(join(root, 'wiki'), { recursive: true })
    const ctx = new Context()
    contexts.push(ctx)
    const service = new KnowledgeWikiService(ctx, wikiTestConfig({
      wikiRoot: join(root, 'wiki'), mainRoot: root,
      credential: 'VISION_API_KEY', llmProvider: 'p', llmModel: 'm',
    })) as unknown as {
      snapshots: { dispose(): void }
      captureProjectContext(): unknown
      ingestSource(request: { path: string }): Promise<{ written: string[]; warnings: string[]; status: string; errorCode?: string }>
    }

    // A context seam that fails with a primitive renders as a string outcome.
    service.captureProjectContext = () => { throw 'primitive ingest failure' }
    const outcome = await service.ingestSource({ path: 'raw/sources/anything.md' })
    expect(outcome).toMatchObject({ written: [], status: 'error', errorCode: 'invalid-input' })
    expect(outcome.warnings).toEqual(['primitive ingest failure'])
    service.snapshots.dispose()
  })
})
