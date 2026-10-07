import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId, type LlmRuntime } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import KnowledgeWikiService from '../../knowledge-wiki/src/index.ts'
import * as tools from '../src/index.ts'
import { verifierAuthority } from '../../knowledge-wiki/tests/verifier-authority-fixture.ts'
import { stageExecutorFor } from '../../knowledge-wiki/tests/stage-executor-fixture.ts'
import { wikiTestConfig } from '../../knowledge-wiki/tests/config-fixture.ts'

interface CanonicalServiceSurface {
  drainQueue(): Promise<void>
  reviews(request: { status?: string }): Promise<Array<{ id: string; reviewKind?: string; targetPath?: string }>>
  resolveReview(request: { reviewId: string; action?: string }): Promise<boolean>
}

const roots: string[] = []
let calls = 0

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function execute(ctx: Context, name: string, args: unknown, cwd = process.cwd()): Promise<ToolExecutionResult> {
  const id = SessionId(`wiki-integration-${++calls}`)
  const session = Session.create(id, [], { version: 0, id, createdAt: Date.now(), cwd })
  const agent = { id, session } as unknown as Agent
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId(`wiki-integration-${name}`),
    name,
    arguments: args,
    agent,
  })
}

describe('canonical Knowledge Wiki and model tools', () => {
  it('uses one service for queue ingest, trusted verification, promotion, read, and listing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wiki-tools-canonical-'))
    roots.push(root)
    const wikiRoot = join(root, 'wiki')
    mkdirSync(join(root, 'raw', 'sources'), { recursive: true })
    mkdirSync(wikiRoot)
    writeFileSync(join(root, 'raw', 'sources', 'source.md'), 'durable source evidence')

    let llmCall = 0
    const ctx = new Context()
    const llm = {
      stream: () => (async function* () {
        const text = llmCall++ === 0
          ? 'analysis'
          : [
            '--- FILE: wiki/concepts/queue-owner.md ---',
            '---',
            'type: concept',
            'status: candidate',
            'title: Queue owner',
            'sources: ["raw/sources/source.md"]',
            '---',
            '',
            '# Queue owner',
            '',
            'One canonical ingest lifecycle owner with durable verification evidence.',
            '--- END FILE ---',
          ].join('\n')
        yield { type: 'text-delta', text }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })(),
    } as unknown as LlmRuntime
    ctx.provide('llm', llm)
    ctx.provide('knowledgeWikiStageExecutor', stageExecutorFor(llm))
    ctx.provide('credentials', { resolve: async () => undefined })
    ctx.provide('timer', { interval: () => () => {} })
    ctx.provide('knowledgeWikiVerifierAuthority', verifierAuthority())
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    class CanonicalWiki extends KnowledgeWikiService {
      constructor(owner: Context) {
        super(owner, wikiTestConfig({
          wikiRoot,
          mainRoot: root,
          credential: 'VISION_API_KEY',
          llmProvider: 'p',
          llmModel: 'm',
        }))
      }
    }
    await ctx.plugin(CanonicalWiki, wikiTestConfig({
      wikiRoot,
      mainRoot: root,
      credential: 'VISION_API_KEY',
      llmProvider: 'p',
      llmModel: 'm',
    }))
    const service = ctx.get('knowledgeWiki') as unknown as CanonicalServiceSurface
    await ctx.plugin(tools)

    try {
      const queued = await execute(ctx, 'wiki_ingest', { input: 'raw/sources/source.md' }, root)
      expect(queued.isError, JSON.stringify(queued)).not.toBe(true)
      await service.drainQueue()
      const review = (await service.reviews({ status: 'unresolved' }))
        .find(item => item.reviewKind === 'candidate' && item.targetPath === 'concepts/queue-owner.md')
      expect(review).toBeDefined()

      const verified = await execute(ctx, 'wiki_verify_candidate', { reviewId: review!.id, action: 'Promote' }, root)
      expect(verified.value).toMatchObject({ ok: true, result: 'pass' })
      await expect(service.resolveReview({ reviewId: review!.id, action: 'Promote' })).resolves.toBe(true)

      const listed = await execute(ctx, 'wiki_files', {}, root)
      expect((listed.value as { files: string[] }).files).toContain('concepts/queue-owner.md')
      const read = await execute(ctx, 'wiki_read', { path: 'concepts/queue-owner.md' }, root)
      expect(read.value).toMatchObject({ path: 'concepts/queue-owner.md', truncated: false })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
