import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { deepResearch } from '../src/research.ts'
import type { KnowledgeWikiStageExecutor } from '../src/stage-executor.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

async function research(output: string, before?: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'research-evidence-')); roots.push(root)
  before?.(root)
  const executor: KnowledgeWikiStageExecutor = {
    isolation: 'owned-worker-v1', assertSearchAvailable() {},
    async execute(request) {
      if (request.kind === 'web-search') return { text: null, sources: [
        { url: 'https://SOURCE.test:443/doc?part=1#first', title: 'Actual source', snippet: 'Search evidence only.' },
        { url: 'https://source.test/doc?part=1#second' },
        { url: 'https://source.test/doc?part=2', title: 'Different query' },
        { url: 'javascript:alert(1)' }, { url: 'https://user:password@source.test/doc' },
      ] }
      return { text: request.kind === 'llm-complete' && request.operation === 'research query expansion' ? 'source query' : output }
    },
  }
  const result = await deepResearch(executor, 'fixture', 'fixture-model', root, 'synthetic topic', new AbortController().signal)
  return { root, result }
}

function page(body: string, name = 'result.md', metadata = 'title: Result'): string {
  return `--- FILE: wiki/_candidates/research/${name} ---\n---\n${metadata}\n---\n\n${body}\n--- END FILE ---`
}

describe('research search-snippet evidence closure', () => {
  it('normalizes real source identities, preserves query semantics, and stamps only actual citations', async () => {
    const { root, result } = await research(page('Evidence [source][actual].\n\n[actual]: https://source.test:443/doc?part=1#section', 'result.md', [
      'title: Result', 'type: canonical', 'status: canonical', 'status: verified', 'origin: human',
      'created: 1900-01-01', 'sources: [https://invented.test]', 'approved_by: human',
    ].join('\n')))
    expect(result.errorCode).toBeUndefined()
    expect(result.sources).toEqual([
      { url: 'https://source.test/doc?part=1', title: 'Actual source', evidence: 'search-snippet' },
      { url: 'https://source.test/doc?part=2', title: 'Different query', evidence: 'search-snippet' },
    ])
    expect(result.sourceCount).toBe(2)
    expect(result.pageSources[result.written[0]!]).toEqual(['https://source.test/doc?part=1'])
    const content = readFileSync(join(root, result.written[0]!), 'utf8')
    expect(content).toContain('type: research\nstatus: candidate\norigin: research')
    expect(content).toContain('sources: ["https://source.test/doc?part=1"]')
    expect(content).not.toContain('canonical')
    expect(content).not.toContain('approved_by')
    expect(content).not.toContain('1900')
    expect(content).not.toContain('invented.test')
  })

  it.each([
    '[unknown](https://invented.test/doc)', '[unsafe](javascript:alert%281%29)',
    '[credential](https://user:password@source.test/doc?part=1)',
    '[source][missing]', '[source](https://source.test/doc?part=1)\n\n[extra]: https://invented.test',
    '<a href="https://invented.test">HTML</a>', '![tracking](https://source.test/doc?part=1)',
    'No citation at all.', '```markdown\n[source](https://source.test/doc?part=1)\n```',
  ])('rejects unknown, dangerous, unresolved or absent citations: %s', async (body) => {
    const { result } = await research(page(body))
    expect(result).toMatchObject({ written: [], errorCode: 'invalid-citations' })
  })

  it.each(['plain answer', '', '--- FILE: result.md ---\nno frontmatter\n--- END FILE ---', page('')])
  ('reports invalid output when no candidate can be validated', async (output) => {
    const { result } = await research(output)
    expect(result).toMatchObject({ written: [], errorCode: 'invalid-output' })
  })

  it('reports all-collision failure and preserves the earlier file bytes', async () => {
    const { root, result } = await research(page('[source](https://source.test/doc?part=1)'), (root) => {
      mkdirSync(join(root, 'wiki/_candidates/research'), { recursive: true })
      writeFileSync(join(root, 'wiki/_candidates/research/result.md'), 'existing bytes')
    })
    expect(result).toMatchObject({ written: [], errorCode: 'no-pages' })
    expect(readFileSync(join(root, 'wiki/_candidates/research/result.md'), 'utf8')).toBe('existing bytes')
  })

  it('retains valid pages and warnings when another page has invalid citations', async () => {
    const { result } = await research(page('[source](https://source.test/doc?part=1)', 'valid.md') + '\n'
      + page('[unknown](https://invented.test)', 'invalid.md'))
    expect(result.errorCode).toBeUndefined()
    expect(result.written).toEqual(['wiki/_candidates/research/valid.md'])
    expect(result.warnings).toHaveLength(1)
  })
})
