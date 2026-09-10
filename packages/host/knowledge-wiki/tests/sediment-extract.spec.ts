import { describe, expect, it } from 'vitest'
import { extractTurnPair } from '../src/auto-sediment.ts'

/** Ark 会话日志还原后的事件结构（turn/start 划段 + data 内文本）。 */
function turnStart(): Record<string, unknown> {
  return { type: 'turn/start', seq: 1, data: { turn: 1 } }
}
function userMessage(text: string): Record<string, unknown> {
  return { type: 'user/message', seq: 2, data: { role: 'user', content: [{ type: 'text', text }] } }
}
function assistantMessage(text: string, turn: number): Record<string, unknown> {
  return { type: 'assistant/message', seq: 3, data: { turn, message: { role: 'assistant', content: [{ type: 'text', text }] } } }
}
function toolCall(name: string): Record<string, unknown> {
  return { type: 'tool/call', seq: 4, data: { name } }
}
function turnEnd(): Record<string, unknown> {
  return { type: 'turn/end', seq: 5, data: { turn: 1 } }
}

const SESSION = 'session-test'

describe('extractTurnPair', () => {
  it('extracts input, output and tools for the requested turn', () => {
    const events = [
      turnStart(),
      userMessage('帮我整理万相织鉴的训练方案'),
      toolCall('wiki_search'),
      assistantMessage('我整理了训练方案，核心是分三阶段：先做数据清洗，再两阶段注入，最后做质量验收与回归。', 1),
      turnEnd(),
    ]
    const pair = extractTurnPair(events, SESSION, 1)
    expect(pair).toEqual({
      sessionId: SESSION,
      turn: 1,
      input: '帮我整理万相织鉴的训练方案',
      output: '我整理了训练方案，核心是分三阶段：先做数据清洗，再两阶段注入，最后做质量验收与回归。',
      tools: ['wiki_search'],
    })
  })

  it('isolates turns by turn/start boundaries (multi-turn session)', () => {
    const events = [
      turnStart(),
      userMessage('第一轮的问题'),
      assistantMessage('第一轮的回复内容比较长，远远超过四十个字符的沉淀门槛要求，可以放心正常记录到知识图谱里。', 1),
      turnEnd(),
      turnStart(),
      userMessage('第二轮的问题'),
      assistantMessage('第二轮的回复同样超过四十个字符的沉淀门槛要求，可以放心正常记录到知识图谱里面去。', 2),
      turnEnd(),
    ]
    const first = extractTurnPair(events, SESSION, 1)
    const second = extractTurnPair(events, SESSION, 2)
    expect(first!.input).toBe('第一轮的问题')
    expect(first!.output).toBe('第一轮的回复内容比较长，远远超过四十个字符的沉淀门槛要求，可以放心正常记录到知识图谱里。')
    expect(second!.input).toBe('第二轮的问题')
    expect(second!.output).toBe('第二轮的回复同样超过四十个字符的沉淀门槛要求，可以放心正常记录到知识图谱里面去。')
  })

  it('drops reasoning blocks from assistant output', () => {
    const events = [
      turnStart(),
      userMessage('问题'),
      { type: 'assistant/message', seq: 3, data: { turn: 1, message: { content: [
        { type: 'reasoning', text: '内部推理过程' },
        { type: 'text', text: '最终结论。这条结论文字足够长，已经远远超过四十个字符的沉淀门槛，可以放心正常记录。' },
      ] } } },
      turnEnd(),
    ]
    const pair = extractTurnPair(events, SESSION, 1)
    expect(pair!.output).toBe('最终结论。这条结论文字足够长，已经远远超过四十个字符的沉淀门槛，可以放心正常记录。')
    expect(pair!.output).not.toContain('推理')
  })

  it('skips null and primitive blocks while preserving valid turn text', () => {
    const answer = '最终回答保留有效对象文本，同时忽略空值、数组和数字；这段内容足够长，可以通过沉淀门槛并形成稳定回归。'
    const events = [
      turnStart(),
      { type: 'user/message', seq: 2, data: { content: ['字符串问题', null, 7, [], { type: 'text', text: '对象问题' }] } },
      { type: 'assistant/message', seq: 3, data: { turn: 1, message: { content: [null, { type: 'text', text: answer }] } } },
      turnEnd(),
    ]
    expect(extractTurnPair(events, SESSION, 1)).toMatchObject({
      input: '字符串问题\n对象问题',
      output: answer,
    })
  })

  it('returns null for a turn with no content, and for a non-existent turn', () => {
    expect(extractTurnPair([], SESSION, 1)).toBeNull()
    const events = [turnStart(), userMessage('x'), turnEnd()]
    expect(extractTurnPair(events, SESSION, 2)).toBeNull()
  })

  it('returns null when the assistant reply is too short', () => {
    const events = [
      turnStart(),
      userMessage('问题'),
      assistantMessage('好', 1),
      turnEnd(),
    ]
    expect(extractTurnPair(events, SESSION, 1)).toBeNull()
  })
})
