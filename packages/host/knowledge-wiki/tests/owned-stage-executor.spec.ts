import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import WebRuntime from '@deepseek-ai/dsh-web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOwnedStageExecutor } from '../src/owned-stage-executor.ts'
import { executeKnowledgeWikiStage } from '../src/stage-executor.ts'

const roots: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function harness(stream?: (options: GenerateOptions) => AsyncIterable<StreamChunk>) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(WebRuntime)
  class FixtureAdapter extends LlmAdapter {
    override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      return stream?.(options) ?? (async function* () { yield { type: 'text-delta', index: 0, text: 'provider answer' } as const })()
    }
  }
  ctx.llm.registerAdapter(['fixture-provider'], new FixtureAdapter())
  return { ctx, executor: createOwnedStageExecutor({ llm: ctx.llm, web: () => ctx.web, attachments: () => undefined }) }
}

const request = { kind: 'llm-complete' as const, provider: 'fixture-provider', model: 'fixture-model', prompt: 'source', operation: 'analysis', timeoutMs: 10_000 }

describe('owned knowledge stages and provider ownership', () => {
  it('extracts UTF-8 text in its file isolate', async () => {
    const { executor } = await harness()
    const root = mkdtempSync(join(tmpdir(), 'owned-knowledge-'))
    roots.push(root)
    const path = join(root, 'source.md')
    writeFileSync(path, '# 正文\ntext')
    await expect(executor.execute({ kind: 'file-extract', path, timeoutMs: 5000 }, new AbortController().signal)).resolves.toEqual({ text: '# 正文\ntext' })
  })
  it('rejects Office and disguised binary before any model request', async () => {
    const stream = vi.fn()
    const { executor } = await harness(stream)
    const root = mkdtempSync(join(tmpdir(), 'owned-knowledge-'))
    roots.push(root)
    const path = join(root, 'source.txt')
    writeFileSync(path, Buffer.from('PK\x03\x04word/document.xml'))
    await expect(executor.execute({ kind: 'file-extract', path, timeoutMs: 5000 }, new AbortController().signal)).rejects.toThrow('binary')
    await expect(executor.execute({ kind: 'file-extract', path: path + '.docx', timeoutMs: 5000 }, new AbortController().signal)).rejects.toThrow('verified text extractor')
    expect(stream).not.toHaveBeenCalled()
  })
  it('dispatches text through the registered provider and prepared call', async () => {
    const { executor, ctx } = await harness()
    const prepare = vi.spyOn(ctx.llm, 'prepareCall')
    await expect(executor.execute(request, new AbortController().signal)).resolves.toEqual({ text: 'provider answer' })
    expect(prepare).toHaveBeenCalledWith({ provider: 'fixture-provider', model: 'fixture-model' }, expect.any(AbortSignal))
  })
  it('does not re-route an unavailable model to DeepSeek', async () => {
    const { executor } = await harness()
    await expect(executor.execute({ ...request, provider: 'missing' }, new AbortController().signal)).rejects.toThrow('missing')
  })
  it('awaits provider cancellation cleanup before returning the deadline failure', async () => {
    let stopped = false
    const { executor } = await harness(options => (async function* () {
      await new Promise<void>(resolve => options.signal?.addEventListener('abort', () => { resolve() }, { once: true }))
      await new Promise<void>(resolve => setTimeout(resolve, 15))
      stopped = true
      options.signal?.throwIfAborted()
      yield { type: 'text-delta', index: 0, text: 'unreachable' } as const
    })())
    await expect(executeKnowledgeWikiStage(executor, { ...request, timeoutMs: 40 }, new AbortController().signal)).rejects.toThrow('timed out')
    expect(stopped).toBe(true)
  })
  it('refuses a pre-aborted request before spawning or provider preparation', async () => {
    const { executor, ctx } = await harness()
    const prepare = vi.spyOn(ctx.llm, 'prepareCall')
    const signal = AbortSignal.abort(new Error('already stopped'))
    await expect(executor.execute(request, signal)).rejects.toThrow('already stopped')
    expect(prepare).not.toHaveBeenCalled()
  })
  it('preflights and dispatches search through the existing web owner', async () => {
    const { executor, ctx } = await harness()
    expect(() => executor.assertSearchAvailable?.()).toThrow('provider')
    const search = vi.fn(async () => ({ sources: [{ url: 'https://source.fixture.test', title: 'source' }], truncated: false }))
    ctx.web.registerSearchProvider({ id: 'fixture-search', available: () => true, search })
    expect(() => executor.assertSearchAvailable?.()).not.toThrow()
    const signal = new AbortController().signal
    await expect(executor.execute({ kind: 'web-search', query: 'question', maxResults: 2, timeoutMs: 1000 }, signal)).resolves.toEqual({ text: null, sources: [{ url: 'https://source.fixture.test', title: 'source' }] })
    expect(search).toHaveBeenCalledWith({ query: 'question', maxResults: 2 }, signal)
  })
})
