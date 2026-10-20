import { Context } from '@deepseek-ai/cordis'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import KnowledgeWikiService from '../src/index.ts'
import { createOwnedStageExecutor } from '../src/owned-stage-executor.ts'
import { knowledgeFilePolicyHash } from '../src/file-extract.ts'
import type { IngestQueueTask } from '../src/types.ts'
import { wikiTestConfig } from './config-fixture.ts'
import { projectRequest } from './project-request-fixture.ts'

interface QueueOwner {
  queue: IngestQueueTask[]
  scanSources(): Promise<void>
  drainQueue(): Promise<void>
  restoreQueue(): void
  enqueueIngest(input: string, force?: boolean): boolean
  executeQueuedIngest: (...args: unknown[]) => Promise<unknown>
}
const roots: string[] = []
const contexts: Context[] = []
function fixture(root?: string, history = 0) {
  root ??= mkdtempSync(join(tmpdir(), 'knowledge-permanent-')); if (!roots.includes(root)) roots.push(root)
  mkdirSync(join(root, 'wiki'), { recursive: true }); mkdirSync(join(root, 'raw/sources'), { recursive: true })
  const ctx = new Context(); contexts.push(ctx)
  ctx.provide('knowledgeWikiStageExecutor', createOwnedStageExecutor({ llm: {} as LlmRuntime, web: () => undefined, attachments: () => undefined }))
  const service = new KnowledgeWikiService(ctx, wikiTestConfig({ mainRoot: root, wikiRoot: join(root, 'wiki'), ingestHistoryLimit: history }))
  return { root, service, owner: service as unknown as QueueOwner }
}
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('permanent extraction failure admission', () => {
  it.each([
    ['document.docx', Buffer.from('synthetic Office container'), 'unsupported-format'],
    ['binary.txt', Buffer.from('PK\x03\x04binary'), 'binary-content'],
    ['invalid.txt', Buffer.from([0xff]), 'invalid-utf8'],
    ['control.txt', Buffer.from([0]), 'invalid-text'],
    ['empty.txt', Buffer.from(' \n\t'), 'empty-content'],
    ['unsupported.zip', Buffer.from('synthetic archive'), 'unsupported-format'],
  ] as const)('persists the typed %s rejection across history trimming, restart and cooldown', async (name, bytes, code) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { root, service, owner } = fixture()
    writeFileSync(join(root, 'raw/sources', name), bytes)
    const result = await service.ingestSource({ ...projectRequest(service), path: name })
    expect(result.status).toBe('error')
    expect(owner.queue).toEqual([])
    const cachePath = join(root, '.llm-wiki/ingest-cache.json')
    const cache = JSON.parse(readFileSync(cachePath, 'utf8')) as Record<string, {
      permanentFailure: NonNullable<IngestQueueTask['permanentFailure']>
    }>
    expect(cache[name]?.permanentFailure).toMatchObject({ code, policyHash: knowledgeFilePolicyHash() })
    expect(cache[name]?.permanentFailure.sourceHash).toMatch(/^[a-f0-9]{64}$/u)
    const fresh = fixture(root)
    fresh.owner.restoreQueue()
    const execute = vi.spyOn(fresh.owner, 'executeQueuedIngest')
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2 * 60 * 60 * 1000)
    await fresh.owner.scanSources(); await fresh.owner.drainQueue()
    expect(execute).not.toHaveBeenCalled()
    expect(fresh.owner.queue).toEqual([])
  })

  it.each(['source', 'policy', 'manual'] as const)('permits a fresh admission after %s changes', async (change) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { root, service, owner } = fixture(undefined, 2)
    const path = join(root, 'raw/sources/document.docx'); writeFileSync(path, 'first synthetic file')
    await service.ingestSource({ ...projectRequest(service), path: 'document.docx' })
    const execute = vi.spyOn(owner, 'executeQueuedIngest')
    if (change === 'source') writeFileSync(path, 'changed synthetic file')
    else if (change === 'policy') {
      const cachePath = join(root, '.llm-wiki/ingest-cache.json')
      const cache = JSON.parse(readFileSync(cachePath, 'utf8')) as Record<string, { permanentFailure: { policyHash: string } }>
      cache['document.docx']!.permanentFailure.policyHash = 'f'.repeat(64)
      writeFileSync(cachePath, JSON.stringify(cache))
      const previous = owner.queue[0]!
      owner.queue[0] = { ...previous, permanentFailure: { ...previous.permanentFailure!, policyHash: 'f'.repeat(64) } }
    }
    if (change === 'manual') await service.ingestSource({ ...projectRequest(service), path: 'document.docx' })
    else { await owner.scanSources(); await owner.drainQueue() }
    expect(execute).toHaveBeenCalledOnce()
  })

  it('restores a committed permanent failure over its old running lease but retains a new manual admission', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { root, service } = fixture(undefined, 2)
    writeFileSync(join(root, 'raw/sources/document.docx'), 'unchanged Office bytes')
    await service.ingestSource({ ...projectRequest(service), path: 'document.docx' })
    const queuePath = join(root, '.llm-wiki/ingest-queue.json')
    const terminal = JSON.parse(readFileSync(queuePath, 'utf8')) as IngestQueueTask[]
    const running = { ...terminal[0], status: 'running' }; delete running.permanentFailure
    writeFileSync(queuePath, JSON.stringify([running]))
    const recovered = fixture(root, 2)
    recovered.owner.restoreQueue()
    expect(recovered.owner.queue[0]?.status).toBe('error')
    recovered.owner.enqueueIngest('document.docx', true)
    const manual = fixture(root, 2)
    manual.owner.restoreQueue()
    expect(manual.owner.queue.filter(task => task.status === 'pending')).toHaveLength(1)
  })

  it.each([
    { code: 'unsupported-format', sourceHash: 'invalid', policyHash: 'f'.repeat(64) },
    { code: 'unknown', sourceHash: 'f'.repeat(64), policyHash: 'f'.repeat(64) },
  ])('refuses malformed permanent dispositions instead of retrying them', async (permanentFailure) => {
    const { root, owner } = fixture()
    mkdirSync(join(root, '.llm-wiki'), { recursive: true })
    writeFileSync(join(root, '.llm-wiki/ingest-cache.json'), JSON.stringify({ 'a.md': { permanentFailure } }))
    await expect(owner.scanSources()).rejects.toThrow('disposition')
  })
})
