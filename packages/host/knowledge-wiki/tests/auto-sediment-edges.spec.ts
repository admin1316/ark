import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildPage,
  buildSessionSummaryPage,
  classifyKind,
  classifyWithLlm,
  extractConversationText,
  extractTurnPair,
  pageExists,
  pageRelPath,
  readPageContent,
  sedimentPage,
  sedimentTarget,
  sessionShortId,
  sessionSummaryRelPath,
  sessionSummarySlug,
  slugFrom,
  titleFrom,
  type TurnPair,
} from '../src/auto-sediment.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'wiki-sediment-'))
  roots.push(root)
  return root
}

const pair: TurnPair = {
  sessionId: 'session-123456789',
  turn: 2,
  input: '为什么 [[input]] 没有正常显示？',
  output: '已经排查根因并完成修复，验证通过。'.repeat(4) + ' [[output]]',
  tools: ['read', 'edit'],
}

describe('turn extraction and classification edges', () => {
  it('narrows malformed events and deduplicates cumulative message snapshots', () => {
    const events: unknown[] = [
      null,
      42,
      { type: 1 },
      { type: 'user/message', data: { content: 'before turn' } },
      { type: 'turn/start' },
      { type: 'user/message', data: null },
      { type: 'user/message', data: { content: [
        'first',
        null,
        ['nested'],
        { type: 'reasoning', text: 'hidden' },
      ] } },
      { type: 'user/message', data: { content: { content: [{ text: 'first cumulative' }] } } },
      { type: 'user/message', data: { content: 'first cumulative answer' } },
      { type: 'user/message', data: { content: 'first cumulative answer' } },
      { type: 'user/message', data: { content: 'first' } },
      { type: 'user/message', data: { content: {} } },
      { type: 'assistant/message', data: { content: { text: 'short ignored by cumulative' } } },
      { type: 'assistant/message', data: { content: {} } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'A'.repeat(45) }] } } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'A'.repeat(45) + ' final' }] } } },
      { type: 'tool/call', data: { tool: 'bash' } },
      { type: 'tool/call', data: { name: 'bash' } },
      { type: 'tool/call', data: {} },
      { type: 'turn/start' },
      { type: 'assistant/message', data: { content: 'other turn' } },
    ]

    expect(extractTurnPair(events, 'session-id', 1)).toEqual({
      sessionId: 'session-id',
      turn: 1,
      input: 'first cumulative answer',
      output: 'short ignored by cumulative\n' + 'A'.repeat(45) + ' final',
      tools: ['bash'],
    })
    expect(extractTurnPair(events, 'session-id', 2)).toBeNull()
    expect(extractTurnPair([{ type: 'turn/start' }, { type: 'user/message', data: { content: 'input' } }], 's', 1))
      .toBeNull()
    expect(extractTurnPair([
      { type: 'turn/start' },
      { type: 'user/message', data: { content: 'input' } },
      { type: 'assistant/message', data: { content: 'tiny' } },
    ], 's', 1)).toBeNull()
  })

  it('covers title, target, slug, and deterministic classifier alternatives', () => {
    expect(sedimentTarget(undefined, '/main')).toBeNull()
    expect(sedimentTarget('/main', '/main')).toBeNull()
    expect(sedimentTarget('/main/sub', '/main')).toBeNull()
    expect(sedimentTarget('/work/project', '/main')).toEqual({
      wikiRoot: '/work/project/wiki', workspaceName: 'project',
    })

    expect(titleFrom('short\nA sufficiently long title / with bad:* chars', undefined))
      .toBe('A sufficiently long title with bad chars')
    expect(titleFrom('tiny', ' Session title ')).toBe('Session title')
    expect(titleFrom('', undefined)).toBe('会话知识沉淀')
    expect(slugFrom(' / ', 'session-', 3)).toBe('-unknown-t3')
    expect(sessionShortId('session-abcdefghijk')).toBe('abcdefgh')
    expect(pageRelPath('concept', 'slug')).toContain('会话沉淀/slug.md')
    expect(pageRelPath('problem-solving', 'slug')).toContain('问题解决/slug.md')

    expect(classifyKind('这是为什么？', '已排查原因')).toBe('problem-solving')
    expect(classifyKind('发生故障', '界面不对')).toBe('problem-solving')
    expect(classifyKind('太慢', '已经调好')).toBe('problem-solving')
    expect(classifyKind('普通说明', '普通回答')).toBe('concept')
  })

  it('parses semantic classification output and rejects every malformed shape', async () => {
    await expect(classifyWithLlm(async () => 'no json', 'i', 'o')).resolves.toBeNull()
    await expect(classifyWithLlm(async () => '{bad}', 'i', 'o')).resolves.toBeNull()
    await expect(classifyWithLlm(async () => '[]', 'i', 'o')).resolves.toBeNull()
    await expect(classifyWithLlm(async () => '{"kind":"other"}', 'i', 'o')).resolves.toBeNull()
    await expect(classifyWithLlm(async () => '{"kind":"concept","title":42}', 'i', 'o'))
      .resolves.toEqual({ kind: 'concept', title: null })
    await expect(classifyWithLlm(async () => '{"kind":"problem-solving","title":" Fixed "}', 'i', 'o'))
      .resolves.toEqual({ kind: 'problem-solving', title: 'Fixed' })
  })
})

describe('sediment page lifecycle', () => {
  it('builds both page kinds with and without tools and escapes conversational wikilinks', () => {
    const problem = buildPage(' title\nline ', pair, '2026-08-31', 'workspace', 'problem-solving')
    expect(problem).toContain('tags: [问题解决, 自动生成]')
    expect(problem).toContain('[input]')
    expect(problem).not.toContain('[[input]]')
    expect(problem).toContain('## 使用工具')

    const concept = buildPage('Concept', { ...pair, tools: [] }, '2026-08-31', 'workspace')
    expect(concept).toContain('tags: [会话沉淀, 自动生成]')
    expect(concept).not.toContain('## 使用工具')
  })

  it('writes once, reads the result, and refuses duplicate or impossible roots', () => {
    const root = fixture()
    const wikiRoot = join(root, 'wiki')
    const first = sedimentPage({
      wikiRoot,
      pair,
      sessionTitle: 'Session',
      today: '2026-08-31',
      workspaceName: 'workspace',
      kind: 'problem-solving',
      title: 'Fixed issue',
    })
    expect(first).toBeTruthy()
    expect(pageExists(wikiRoot, first!)).toBe(true)
    expect(readPageContent(wikiRoot, first!)).toContain('# Fixed issue')
    expect(sedimentPage({
      wikiRoot,
      pair,
      today: '2026-08-31',
      workspaceName: 'workspace',
      kind: 'problem-solving',
      title: 'Fixed issue',
    })).toBeNull()

    const blocked = join(root, 'blocked')
    writeFileSync(blocked, 'file', 'utf8')
    expect(() => sedimentPage({
      wikiRoot: blocked,
      pair,
      today: '2026-08-31',
      workspaceName: 'workspace',
    })).toThrow()
    expect(pageExists(wikiRoot, 'missing.md')).toBe(false)
  })
})

describe('session summary projection', () => {
  it('groups valid event text by turn and skips malformed or pre-turn records', () => {
    const conversation = extractConversationText([
      null,
      { type: 'assistant/message', data: { content: 'before' } },
      { type: 'turn/start' },
      { type: 'user/message', data: { content: [{ text: 'question' }] } },
      { type: 'assistant/message', data: { message: { content: [{ text: 'answer' }] } } },
      { type: 'turn/start' },
      { type: 'user/message', data: { content: '' } },
      { type: 'assistant/message', data: null },
      { type: 'turn/start' },
      { type: 'user/message', data: { content: 'question' } },
      { type: 'assistant/message', data: { content: 'answer extended' } },
    ])
    expect(conversation).toContain('第 1 轮\n用户：question\n助手：answer')
    expect(conversation).toContain('第 3 轮\n用户：question\n助手：answer extended')
    expect(conversation).not.toContain('before')
  })

  it('builds default and evidence-rich summary pages', () => {
    expect(sessionSummaryRelPath('slug')).toContain('_candidates/sessions/slug.md')
    expect(sessionSummarySlug('Title / Here', 'session-abcdefghijk')).toBe('Title-Here-abcdefgh')

    const minimal = buildSessionSummaryPage({
      title: 'Title\nLine',
      summary: 'Summary [[not-link]]',
      related: [],
      sessionId: 'session-1',
      today: '2026-08-31',
      workspaceName: 'workspace',
      evidenceCount: 0,
      independentSourceCount: 0,
    })
    expect(minimal).toContain('candidate_kind: knowledge')
    expect(minimal).toContain('evidence_count: 1')
    expect(minimal).toContain('related: []')
    expect(minimal).not.toContain('resolution_status:')
    expect(minimal).toContain('Summary [not-link]')

    const rich = buildSessionSummaryPage({
      title: 'Reflection',
      summary: 'Verified summary',
      related: ['"quoted"', 'plain'],
      sessionId: 'session-2',
      today: '2026-08-31',
      workspaceName: 'workspace',
      candidateKind: 'reflection',
      epistemicStatus: 'verified',
      evidenceCount: 3,
      independentSourceCount: 2,
      resolutionStatus: 'verified',
      issueId: 'issue-1',
    })
    expect(rich).toContain('candidate_kind: reflection')
    expect(rich).toContain('resolution_status: verified')
    expect(rich).toContain('issue_id: issue-1')
    expect(rich).toContain('related: ["quoted", "plain"]')
  })
})
