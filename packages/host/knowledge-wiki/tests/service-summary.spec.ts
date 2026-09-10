import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import KnowledgeWikiService from '../src/index.ts'

interface SummarySurface {
  snapshots: { dispose(): void }
  summarizeSession(sessionId: string | undefined): Promise<void>
}

let mainRoot: string
let externalRoot: string
let ctx: Context
let service: SummarySurface
let output: string
let finishReason: 'stop' | 'aborted' | 'error'
let readSession: (sessionId: string) => Promise<unknown>
let getSessionService: Mock<(name: string) => unknown>
let stageExecutor: object

function longEvents(): unknown[] {
  return [
    { type: 'turn/start' },
    { type: 'user/message', data: { content: '用户提出一个可复用问题。'.repeat(12) } },
    { type: 'assistant/message', data: { content: '助手给出稳定方法、验证证据和回滚边界。'.repeat(12) } },
  ]
}

function decision(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    action: 'candidate',
    title: 'Stable Topic',
    topic_key: 'stable-topic',
    issue_key: '',
    claims: ['claim'],
    decisions: ['decision'],
    procedures: ['procedure'],
    verification_evidence: ['测试通过'],
    related: ['concepts/one', 42],
    scores: { reusable: 2, novelty: 2, evidence: 2, stability: 2 },
    ...overrides,
  })
}

beforeEach(() => {
  mainRoot = mkdtempSync(join(tmpdir(), 'wiki-summary-main-'))
  externalRoot = mkdtempSync(join(tmpdir(), 'wiki-summary-external-'))
  mkdirSync(join(mainRoot, 'wiki'), { recursive: true })
  ctx = new Context()
  output = decision()
  finishReason = 'stop'
  readSession = () => Promise.resolve({ session: { cwd: externalRoot }, events: longEvents() })
  stageExecutor = {
    isolation: 'owned-worker-v1',
    execute: async () => {
      if (finishReason !== 'stop') throw new Error(`stage ${finishReason}`)
      return { text: output }
    },
  }
  Object.defineProperty(ctx, 'logger', {
    configurable: true,
    value: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  })
  getSessionService = vi.fn<(name: string) => unknown>((name) => {
    if (name === 'sessionQuery') return { readSession }
    if (name === 'knowledgeWikiStageExecutor') return stageExecutor
    return undefined
  })
  vi.spyOn(ctx, 'get').mockImplementation(name => getSessionService(name))
  service = new KnowledgeWikiService(ctx, {
    wikiRoot: join(mainRoot, 'wiki'),
    mainRoot,
    credential: 'VISION_API_KEY',
    llmProvider: 'p', llmModel: 'm',
  }) as unknown as SummarySurface
})

afterEach(async () => {
  service.snapshots.dispose()
  await ctx.fiber.dispose()
  rmSync(mainRoot, { recursive: true, force: true })
  rmSync(externalRoot, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('session summary admission', () => {
  it('skips missing ids, services, workspaces, events, and short conversations', async () => {
    await service.summarizeSession(undefined)

    for (const value of [undefined, null, 1, {}, { readSession: 1 }]) {
      getSessionService.mockReturnValueOnce(value)
      await service.summarizeSession('session-missing-reader')
    }

    readSession = () => Promise.resolve({ session: { cwd: mainRoot }, events: longEvents() })
    await service.summarizeSession('session-main')
    readSession = () => Promise.resolve({ session: { cwd: externalRoot }, events: 'invalid' })
    await service.summarizeSession('session-invalid-events')
    readSession = () => Promise.resolve({ session: { cwd: externalRoot }, events: [] })
    await service.summarizeSession('session-empty-events')
    readSession = () => Promise.resolve({
      session: { cwd: externalRoot },
      events: [{ type: 'turn/start' }, { type: 'user/message', data: { content: 'short' } }],
    })
    await service.summarizeSession('session-short')

    expect(existsSync(join(externalRoot, 'wiki'))).toBe(false)
  })

  it('stops on aborted/error finishes and malformed or rejected decisions', async () => {
    for (finishReason of ['aborted', 'error'] as const) {
      await service.summarizeSession(`session-${finishReason}`)
    }
    finishReason = 'stop'
    for (output of [
      'no object',
      '{bad}',
      JSON.stringify({ action: 'skip' }),
      decision({ action: 'invalid' }),
      decision({ title: 42 }),
      decision({ title: '' }),
      decision({ title: '继续' }),
      decision({ claims: [], decisions: [], procedures: [] }),
      decision({ action: 'incident_open', issue_key: '' }),
      decision({ action: 'reflection', topic_key: '', failure_pattern: '' }),
      decision({ scores: { reusable: 1, novelty: 1, evidence: 1, stability: 1 } }),
      decision({ scores: 'invalid' }),
    ]) {
      await service.summarizeSession(`session-rejected-${Math.random()}`)
    }
    expect(existsSync(join(externalRoot, 'wiki'))).toBe(false)
  })

  it('creates and merges one stable candidate topic across sessions', async () => {
    output = '```json\n' + decision() + '\n```'
    await service.summarizeSession('session-first')
    const page = join(externalRoot, 'wiki', '_candidates', 'topics', 'stable-topic.md')
    expect(readFileSync(page, 'utf8')).toContain('session:session-first')

    await service.summarizeSession('session-second')
    const merged = readFileSync(page, 'utf8')
    expect(merged).toContain('session:session-second')
    expect(merged).toContain('evidence_count: 2')

    await service.summarizeSession('session-second')
    expect(readFileSync(page, 'utf8')).toBe(merged)
    expect(existsSync(join(externalRoot, '.llm-wiki', 'review.json'))).toBe(true)

    output = decision({ topic_key: '', issue_key: 42, related: 'not-an-array' })
    await service.summarizeSession('session-title-fallback')
    expect(existsSync(join(externalRoot, 'wiki', '_candidates', 'topics', 'stable-topic.md'))).toBe(true)
  })

  it('tracks open and verified incident attempts in one issue page', async () => {
    output = decision({
      action: 'incident_open',
      title: 'Backend stopped',
      issue_key: 'backend:status:stopped',
      attempts: [null, 42, {}, { hypothesis: 'port conflict', action: 'restart', result: 'failed' }],
      verification_evidence: [],
      scores: {},
    })
    await service.summarizeSession('session-incident-open')
    const page = join(externalRoot, 'wiki', '_candidates', 'incidents', 'backend-status-stopped.md')
    expect(readFileSync(page, 'utf8')).toContain('resolution_status: open')
    const beforeDuplicate = readFileSync(page, 'utf8')
    await service.summarizeSession('session-incident-open')
    expect(readFileSync(page, 'utf8')).toBe(beforeDuplicate)

    output = decision({
      action: 'incident_verified',
      title: 'Backend stopped',
      issue_key: 'backend:status:stopped',
      attempts: [{ hypothesis: '', action: 'replace owner' }, { hypothesis: 'old owner', result: 1 }],
      final_root_cause: 'duplicate owner',
      final_fix: 'single owner',
      verification_evidence: ['测试通过', 'unverified statement'],
      scores: {},
    })
    await service.summarizeSession('session-incident-verified')
    const verified = readFileSync(page, 'utf8')
    expect(verified).toContain('resolution_status: verified')
    expect(verified).toContain('最终根因')
    expect(verified).toContain('session:session-incident-verified')
  })

  it('downgrades unverified incidents and writes complete reflections', async () => {
    output = decision({
      action: 'incident_verified',
      title: 'Unconfirmed issue',
      issue_key: 'issue/unconfirmed',
      verification_evidence: ['assistant claimed completion'],
      attempts: [],
      scores: {},
    })
    await service.summarizeSession('session-unconfirmed')
    const incident = join(externalRoot, 'wiki', '_candidates', 'incidents', 'issue-unconfirmed.md')
    expect(readFileSync(incident, 'utf8')).toContain('resolution_status: open')

    output = JSON.stringify({
      action: 'incident_open',
      title: 'Sparse incident',
      issue_key: 'sparse-incident',
      attempts: 'not-an-array',
    })
    await service.summarizeSession('session-sparse-incident')
    expect(existsSync(join(externalRoot, 'wiki', '_candidates', 'incidents', 'sparse-incident.md'))).toBe(true)

    output = JSON.stringify({
      action: 'incident_verified',
      title: 'Verified without final narrative',
      issue_key: 'verified-no-final',
      attempts: [],
      verification_evidence: ['测试通过'],
    })
    await service.summarizeSession('session-verified-no-final')
    expect(existsSync(join(externalRoot, 'wiki', '_candidates', 'incidents', 'verified-no-final.md'))).toBe(true)

    output = decision({
      action: 'reflection',
      title: 'Reusable reflection',
      topic_key: 'reflection-key',
      failure_pattern: 'pattern',
      root_cause_hypothesis: 'cause',
      counterfactual: 'alternative',
      prevention: 'prevention',
      applicability: 'boundary',
      verification_evidence: ['observation'],
    })
    await service.summarizeSession('session-reflection')
    const reflection = join(externalRoot, 'wiki', '_candidates', 'reflections', 'reflection-key.md')
    expect(readFileSync(reflection, 'utf8')).toContain('candidate_kind: reflection')
    expect(readFileSync(reflection, 'utf8')).toContain('失败模式')
    await service.summarizeSession('session-reflection-second')
    expect(readFileSync(reflection, 'utf8')).toContain('反思证据增量')

    output = decision({
      action: 'candidate',
      title: 'Punctuation Topic',
      topic_key: '///',
    })
    await service.summarizeSession('session-punctuation')
    expect(existsSync(join(externalRoot, 'wiki', '_candidates', 'topics', 'unresolved-incident.md'))).toBe(true)
  })

  it('merges into candidates whose source arrays start empty', async () => {
    const topic = join(externalRoot, 'wiki', '_candidates', 'topics', 'empty-topic.md')
    mkdirSync(join(topic, '..'), { recursive: true })
    writeFileSync(topic, '---\nupdated: old\nevidence_count: 1\nsources: []\n---\n\n# Existing\n', 'utf8')
    output = decision({ topic_key: 'empty-topic' })
    await service.summarizeSession('session-empty-topic')
    expect(readFileSync(topic, 'utf8')).toContain('sources: ["session:session-empty-topic"]')

    const incident = join(externalRoot, 'wiki', '_candidates', 'incidents', 'empty-incident.md')
    mkdirSync(join(incident, '..'), { recursive: true })
    writeFileSync(incident, '---\nupdated: old\nresolution_status: open\nsources: []\n---\n\n# Existing\n', 'utf8')
    output = decision({
      action: 'incident_open', title: 'Empty incident', issue_key: 'empty-incident', attempts: [], scores: {},
    })
    await service.summarizeSession('session-empty-incident')
    expect(readFileSync(incident, 'utf8')).toContain('sources: ["session:session-empty-incident"]')
  })

  it('keeps summary failures best-effort at both reader and writer boundaries', async () => {
    readSession = () => Promise.reject(new Error('reader failed'))
    await expect(service.summarizeSession('session-reader-error')).resolves.toBeUndefined()

    const blocked = join(externalRoot, 'blocked')
    writeFileSync(blocked, 'file', 'utf8')
    readSession = () => Promise.resolve({ session: { cwd: blocked }, events: longEvents() })
    output = decision()
    await expect(service.summarizeSession('session-writer-error')).resolves.toBeUndefined()
  })
})
