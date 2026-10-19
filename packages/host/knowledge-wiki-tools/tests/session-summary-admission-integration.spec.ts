import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SqliteSessionQueryEngine from '@deepseek-ai/dsh-session-query-sqlite'
import type { Agent } from '@deepseek-ai/dsh-agent'
import KnowledgeWikiService from '../../knowledge-wiki/src/index.ts'

const roots: string[] = []
const contexts: Context[] = []

const candidateResponse = JSON.stringify({
  action: 'candidate',
  title: 'Stable Topic',
  topic_key: 'stable-topic',
  issue_key: '',
  claims: ['A stable claim'],
  decisions: ['A durable decision'],
  procedures: ['A repeatable procedure'],
  verification_evidence: ['Session evidence'],
  related: [],
  scores: { reusable: 2, novelty: 2, evidence: 2, stability: 2 },
})

interface SummaryOwnerProbe {
  readonly backgroundStages: Set<AbortController>
}

interface Harness {
  readonly root: string
  readonly workspaceRoot: string
  readonly wikiRoot: string
  readonly ctx: Context
  readonly service: SummaryOwnerProbe
  readonly execute: ReturnType<typeof vi.fn>
}

type StageExecute = (request: unknown, signal: AbortSignal) => Promise<{ text: string }>

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function mount(stageExecute?: StageExecute): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'wiki-summary-admission-loader-'))
  roots.push(root)
  const wikiRoot = join(root, 'wiki')
  mkdirSync(wikiRoot, { recursive: true })
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'wiki-summary-admission-workspace-'))
  roots.push(workspaceRoot)
  const configPath = join(root, 'cordis.yml')
  writeFileSync(configPath, [
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-session-query-sqlite'",
    '  config:',
    "    path: ':memory:'",
    '    openAt: never',
    "- name: '@deepseek-ai/dsh-knowledge-wiki'",
    '  config:',
    `    wikiRoot: ${JSON.stringify(wikiRoot)}`,
    `    mainRoot: ${JSON.stringify(root)}`,
    "    credential: 'VISION_API_KEY'",
    "    llmProvider: 'admission-test'",
    "    llmModel: 'admission-test'",
    '',
  ].join('\n'), 'utf8')

  const ctx = new Context()
  contexts.push(ctx)
  const execute = vi.fn(stageExecute ?? (async (_request: unknown, signal: AbortSignal) => {
    signal.throwIfAborted()
    return { text: candidateResponse }
  }))
  ctx.provide('llm', { stream: () => { throw new Error('the injected summary stage owns every LLM call') } })
  ctx.provide('knowledgeWikiStageExecutor', { isolation: 'owned-worker-v1', execute })
  ctx.provide('credentials', { resolve: async () => undefined })
  ctx.provide('timer', { interval: () => () => {} })
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-query-sqlite', SqliteSessionQueryEngine],
    ['@deepseek-ai/dsh-knowledge-wiki', KnowledgeWikiService],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      const module = modules.get(specifier)
      if (module === undefined) throw new Error(`unexpected Loader import: ${specifier}`)
      return module
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()

  const service = ctx.get('knowledgeWiki') as unknown as SummaryOwnerProbe
  expect(ctx.sessionQuery).toBeDefined()
  return { root, workspaceRoot, wikiRoot, ctx, service, execute }
}

function makeSession(
  ctx: Context,
  workspaceRoot: string,
  id: string,
  options: {
    readonly origin?: 'subagent'
    readonly parentSession?: string
    readonly delegationDepth?: number
    readonly sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access'
    readonly approval?: 'ask' | 'never'
    readonly delegatedApproval?: boolean
  } = {},
) {
  const session = ctx.sessions.create(SessionId(id), {
    meta: {
      cwd: workspaceRoot,
      ...options.origin === undefined ? {} : { origin: options.origin },
      ...options.parentSession === undefined ? {} : { parentSession: SessionId(options.parentSession) },
      ...options.delegationDepth === undefined ? {} : { delegationDepth: options.delegationDepth },
    },
  })
  if (options.sandboxMode !== undefined) {
    session.append('sandbox/mode', {
      mode: options.sandboxMode,
      ...(options.delegatedApproval ? { source: 'delegation' as const } : {}),
    })
  }
  if (options.approval !== undefined) {
    session.append('approval/policy', {
      policy: options.approval,
      ...(options.delegatedApproval ? { source: 'delegation' as const } : {}),
    })
  }
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({
    source: { kind: 'user' },
    content: [{ type: 'text', text: 'How should a durable result be validated? '.repeat(12) }],
  }), { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createAssistantMessage({
      source: { provider: 'test', model: 'test' },
      content: [{ type: 'text', text: 'Record the evidence, verify the stable outcome, then retain a recoverable boundary. '.repeat(12) }],
    }),
  }, { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return session
}

function emitDisposed(ctx: Context, session: ReturnType<typeof makeSession>): void {
  ctx.emit('agent/disposed', {
    agent: { id: session.id, session } as unknown as Agent,
  })
}

async function waitForSummaryQuiescence(service: SummaryOwnerProbe): Promise<void> {
  while (service.backgroundStages.size > 0) {
    await new Promise<void>(resolve => setImmediate(resolve))
  }
}

function assertNoCandidateOrReview(root: string, wikiRoot: string): void {
  expect(existsSync(join(wikiRoot, '_candidates'))).toBe(false)
  expect(existsSync(join(root, '.llm-wiki', 'review.json'))).toBe(false)
  expect(existsSync(join(root, '.llm-wiki', 'knowledge-events.jsonl'))).toBe(false)
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isReviewEntry(value: unknown): value is { sourcePath: string; candidatePath: string; reviewKind: string } {
  return isRecord(value)
    && typeof value.sourcePath === 'string'
    && typeof value.candidatePath === 'string'
    && typeof value.reviewKind === 'string'
}

function isJournalEntry(value: unknown): value is { type: string; knowledgeId: string } {
  return isRecord(value)
    && typeof value.type === 'string'
    && typeof value.knowledgeId === 'string'
}

describe('automatic session summary admission through Loader', () => {
  it('rejects delegated, read-only, and missing-mode sessions in one workspace while allowing a writable root with approval never', async () => {
    const { ctx, workspaceRoot, service, execute } = await mount()
    const wikiRoot = join(workspaceRoot, 'wiki')
    const delegated = makeSession(ctx, workspaceRoot, 'summary-delegated', {
      origin: 'subagent',
      parentSession: 'summary-parent',
      delegationDepth: 1,
      sandboxMode: 'workspace-write',
      approval: 'never',
      delegatedApproval: true,
    })
    const readOnly = makeSession(ctx, workspaceRoot, 'summary-read-only', {
      sandboxMode: 'read-only',
      approval: 'never',
    })
    const missingMode = makeSession(ctx, workspaceRoot, 'summary-missing-mode', { approval: 'never' })
    for (const session of [delegated, readOnly, missingMode]) {
      const observed = await ctx.sessionQuery.readSession(session.id)
      expect(observed.session.id).toBe(session.id)
      expect(observed.events).toHaveLength(session.events.length)
      if (session.id === delegated.id) {
        expect(observed.session.origin).toBe('subagent')
        expect(observed.session.parentSession).toBe('summary-parent')
        expect(observed.session.delegationDepth).toBe(1)
        expect(observed.events.some(event => event.type === 'sandbox/mode' && event.data.mode === 'workspace-write')).toBe(true)
      }
      if (session.id === readOnly.id) {
        expect(observed.events.some(event => event.type === 'sandbox/mode' && event.data.mode === 'read-only')).toBe(true)
      }
      if (session.id === missingMode.id) {
        expect(observed.events.some(event => event.type === 'sandbox/mode')).toBe(false)
      }
      emitDisposed(ctx, session)
      expect(service.backgroundStages.size).toBe(1)
      await waitForSummaryQuiescence(service)
      expect(execute).not.toHaveBeenCalled()
      assertNoCandidateOrReview(workspaceRoot, wikiRoot)
    }

    const writableRoot = makeSession(ctx, workspaceRoot, 'summary-parent', {
      sandboxMode: 'workspace-write',
      approval: 'never',
    })
    const snapshot = await ctx.sessionQuery.readSession(writableRoot.id)
    expect(snapshot.session.origin).toBeUndefined()
    expect(snapshot.session.parentSession).toBeUndefined()
    expect(snapshot.session.delegationDepth).toBeUndefined()
    expect(snapshot.events.some(event => event.type === 'sandbox/mode' && event.data.mode === 'workspace-write')).toBe(true)
    expect(snapshot.events.at(-1)?.type).toBe('turn/end')
    emitDisposed(ctx, writableRoot)
    expect(service.backgroundStages.size).toBe(1)
    await waitForSummaryQuiescence(service)

    expect(execute).toHaveBeenCalledOnce()
    const candidatePath = join(wikiRoot, '_candidates', 'topics', 'stable-topic.md')
    expect(readFileSync(candidatePath, 'utf8')).toContain('session:summary-parent')
    const reviewPath = join(workspaceRoot, '.llm-wiki', 'review.json')
    const parsedReviews: unknown = parseJson(readFileSync(reviewPath, 'utf8'))
    expect(Array.isArray(parsedReviews)).toBe(true)
    const reviews = (parsedReviews as unknown[]).filter(isReviewEntry)
    expect(reviews).toContainEqual(expect.objectContaining({
      sourcePath: 'session:summary-parent',
      candidatePath: '_candidates/topics/stable-topic.md',
      reviewKind: 'candidate',
    }))
    const journalPath = join(workspaceRoot, '.llm-wiki', 'knowledge-events.jsonl')
    const journalLines = readFileSync(journalPath, 'utf8').trim().split('\n').map(parseJson)
    const journal = journalLines.filter(isJournalEntry)
    expect(journal.some(entry => entry.type === 'knowledge/observed' && /^candidate:/u.test(entry.knowledgeId))).toBe(true)
    expect(journal.some(entry => entry.type === 'knowledge/candidate' && /^candidate:/u.test(entry.knowledgeId))).toBe(true)
  })

  it('aborts and drains an in-flight summary when the Loader-owned service and SessionStore are disposed', async () => {
    let started!: () => void
    let quiesced!: () => void
    const stageStarted = new Promise<void>((resolve) => { started = resolve })
    const stageQuiesced = new Promise<void>((resolve) => { quiesced = resolve })
    const { ctx, workspaceRoot, service, execute } = await mount((_request, signal) => new Promise<{ text: string }>((resolve) => {
      started()
      const finish = (): void => {
        signal.removeEventListener('abort', finish)
        quiesced()
        resolve({ text: candidateResponse })
      }
      signal.addEventListener('abort', finish, { once: true })
    }))
    const sessions = ctx.sessions
    const session = makeSession(ctx, workspaceRoot, 'summary-disposed-in-flight', { sandboxMode: 'workspace-write' })
    await ctx.sessionQuery.readSession(session.id)
    emitDisposed(ctx, session)
    expect(service.backgroundStages.size).toBe(1)
    await stageStarted
    await ctx.fiber.dispose()
    await stageQuiesced
    await waitForSummaryQuiescence(service)

    expect(sessions.get(session.id)).toBeUndefined()
    expect(execute).toHaveBeenCalledOnce()
    assertNoCandidateOrReview(workspaceRoot, join(workspaceRoot, 'wiki'))
  })
})
