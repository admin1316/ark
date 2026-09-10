import { describe, expect, it } from 'vitest'
import { buildAnalysisPrompt, buildGenerationPrompt, parseFileBlocks } from '../src/ingest.ts'

describe('buildAnalysisPrompt', () => {
  it('embeds purpose, index and the source document', () => {
    const prompt = buildAnalysisPrompt('构建审计工作流', '## concept\n- [[concepts/x]]', 'source body')
    expect(prompt).toContain('构建审计工作流')
    expect(prompt).toContain('- [[concepts/x]]')
    expect(prompt).toContain('source body')
    expect(prompt).toContain('Do not output chain-of-thought')
  })

  it('marks missing purpose/index placeholders', () => {
    const prompt = buildAnalysisPrompt('', '', 'body')
    expect(prompt).toContain('(none provided)')
  })
})

describe('buildGenerationPrompt', () => {
  const base = {
    purpose: '',
    index: '',
    sourceFileName: 'ark-sessions/a.md',
    sourceContent: '内容',
    analysis: '分析',
    today: '2026-08-19',
    schema: '',
    summaryPath: 'wiki/sources/12-ark-sessions--10-a--1js7z6u.md',
  }

  it('pins today\'s date, the exact summary path and the schema context', () => {
    const prompt = buildGenerationPrompt({ ...base, schema: 'schema.md 内容' })
    expect(prompt).toContain('Today is 2026-08-19')
    expect(prompt).toContain('wiki/sources/12-ark-sessions--10-a--1js7z6u.md')
    expect(prompt).toContain('schema.md 内容')
    expect(prompt).toContain('sources: ["original-source.md"]')
    expect(prompt).toContain('Reflections use candidate_kind: reflection')
  })

  it('marks a missing schema placeholder', () => {
    expect(buildGenerationPrompt(base)).toContain('(none provided)')
  })
})

describe('parseFileBlocks', () => {
  it('parses CRLF files and fence-aware closers', () => {
    const text = [
      '--- FILE: wiki/a.md ---',
      '---',
      'type: concept',
      '---',
      '```ts',
      '--- END FILE ---',
      '```',
      '--- END FILE ---',
    ].join('\r\n')
    const blocks = parseFileBlocks(text)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.path).toBe('wiki/a.md')
    expect(blocks[0]!.content).toContain('--- END FILE ---')
    expect(blocks[0]!.closed).toBe(true)
  })

  it('reports an unclosed block', () => {
    const blocks = parseFileBlocks('--- FILE: wiki/a.md ---\ncontent')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.closed).toBe(false)
  })

  it('returns nothing for output without blocks', () => {
    expect(parseFileBlocks('just prose')).toEqual([])
  })

  it('handles multiple blocks and trims the opener path', () => {
    const text = [
      '--- FILE: wiki/a.md ---',
      'A',
      '--- END FILE ---',
      '--- FILE:  wiki/b.md  ---',
      'B',
      '--- END FILE ---',
    ].join('\n')
    const blocks = parseFileBlocks(text)
    expect(blocks.map(block => block.path)).toEqual(['wiki/a.md', 'wiki/b.md'])
  })
})
