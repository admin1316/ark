import { describe, expect, it } from 'vitest'
import {
  buildPage, extractConversationText, buildSessionSummaryPage,
  sessionSummarySlug, sessionSummaryRelPath,
} from '../src/auto-sediment.ts'

describe('buildPage wikilink escape', () => {
  it('escapes wikilinks from conversation text', () => {
    const page = buildPage('测试', {
      sessionId: 's1', turn: 1,
      input: '参考 [[技能路由架构]] 看看',
      output: '参见 [[wikilink]] 语法示例 [[12-ark-sessions--31-...]] 已处理',
      tools: [],
    }, '2026-08-19', '技能强化')
    expect(page).toContain('参考 [技能路由架构] 看看')
    expect(page).toContain('参见 [wikilink] 语法示例 [12-ark-sessions--31-...] 已处理')
    expect(page).not.toContain('[[')
    expect(page).not.toContain(']]')
  })
})

describe('extractConversationText', () => {
  const events = [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 2, data: { content: [{ type: 'text', text: '第一问' }] } },
    { type: 'assistant/message', seq: 3, data: { message: { content: [{ type: 'text', text: '第一答' }] } } },
    { type: 'turn/end', seq: 4, data: { turn: 1 } },
    { type: 'turn/start', seq: 5, data: { turn: 2 } },
    { type: 'user/message', seq: 6, data: { content: [{ type: 'text', text: '第二问' }] } },
    { type: 'assistant/message', seq: 7, data: { message: { content: [{ type: 'text', text: '第二答' }] } } },
    { type: 'turn/end', seq: 8, data: { turn: 2 } },
  ]
  it('organizes text by turn with user/assistant labels', () => {
    const text = extractConversationText(events)
    expect(text).toContain('第 1 轮')
    expect(text).toContain('用户：第一问')
    expect(text).toContain('助手：第一答')
    expect(text).toContain('第 2 轮')
    expect(text).toContain('用户：第二问')
  })
  it('returns empty for no events', () => {
    expect(extractConversationText([])).toBe('')
  })
  it('drops reasoning blocks', () => {
    const withReasoning = [
      { type: 'turn/start', seq: 1, data: { turn: 1 } },
      { type: 'user/message', seq: 2, data: { content: [{ type: 'text', text: '问' }] } },
      { type: 'assistant/message', seq: 3, data: { message: { content: [
        { type: 'reasoning', text: '内部推理' },
        { type: 'text', text: '最终答复' },
      ] } } },
    ]
    const text = extractConversationText(withReasoning)
    expect(text).toContain('最终答复')
    expect(text).not.toContain('内部推理')
  })

  it('ignores malformed content members without dropping valid text', () => {
    const malformed = [
      { type: 'turn/start', seq: 1, data: { turn: 1 } },
      { type: 'user/message', seq: 2, data: { content: [null, '字符串问题', 42, [], { type: 'text', text: '对象问题' }] } },
      { type: 'assistant/message', seq: 3, data: { message: { content: [
        undefined,
        { type: 'reasoning', text: '内部推理' },
        { type: 'text', text: '有效回答' },
      ] } } },
    ]
    expect(extractConversationText(malformed)).toContain('用户：字符串问题\n对象问题')
    expect(extractConversationText(malformed)).toContain('助手：有效回答')
    expect(extractConversationText(malformed)).not.toContain('内部推理')
  })
})

describe('session summary page', () => {
  it('builds a summary page with related frontmatter', () => {
    const page = buildSessionSummaryPage({
      title: '知识库调用验证',
      summary: '**要点一**：全链路调用已通。\n\n**要点二**：五个通道就绪。',
      related: ['wiki_search', '知识库'],
      sessionId: 'sess123',
      today: '2026-08-19',
      workspaceName: '技能强化',
    })
    expect(page).toContain('type: concept')
    expect(page).toContain('tags: [会话提炼, 自动生成]')
    expect(page).toContain('related: ["wiki_search", "知识库"]')
    expect(page).toContain('sources: ["workspace:技能强化", "session:sess123"]')
    expect(page).toContain('epistemic_status: hypothesis')
    expect(page).toContain('independent_source_count: 1')
    expect(page).toContain('**要点一**')
  })
  it('escapes wikilinks in AI summary text', () => {
    const page = buildSessionSummaryPage({
      title: '测试', summary: '参考 [[某页面]] 的做法', related: [],
      sessionId: 's1', today: '2026-08-19', workspaceName: 'w',
    })
    expect(page).not.toContain('[[')
    expect(page).toContain('[某页面]')
  })
  it('derives stable slug from title and session id', () => {
    expect(sessionSummarySlug('知识库调用验证', 'session-6bd7ec03-db8f')).toBe('知识库调用验证-6bd7ec03')
    expect(sessionSummarySlug('A/B:C', 'abc12345')).toBe('A-B-C-abc12345')
  })
  it('places summary pages under the non-graph candidate namespace', () => {
    expect(sessionSummaryRelPath('x-abc')).toBe('_candidates/sessions/x-abc.md')
  })
})
