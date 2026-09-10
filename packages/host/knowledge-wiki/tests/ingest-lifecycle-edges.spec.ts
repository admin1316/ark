import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import {
  buildAnalysisPrompt,
  buildGenerationPrompt,
  completeText,
  ingestSource,
  parseFileBlocks,
} from '../src/ingest.ts'
import { sourceSummaryFileNameFromIdentity } from '../src/source-slug.ts'
import { stageExecutorFor } from './stage-executor-fixture.ts'
import type { KnowledgeWikiStageExecutor, KnowledgeWikiStageRequest } from '../src/stage-executor.ts'

const roots: string[] = []

afterEach(() => {
  vi.useRealTimers()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'wiki-ingest-lifecycle-'))
  roots.push(value)
  return value
}

function llmFor(generated: string, analysis = 'analysis'): LlmRuntime {
  let call = 0
  return {
    stream: () => {
      const text = call++ === 0 ? analysis : generated
      return (async function* () {
        yield { type: 'text-delta', text: text.slice(0, Math.ceil(text.length / 2)) }
        yield { type: 'text-delta', text: text.slice(Math.ceil(text.length / 2)) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  } as unknown as LlmRuntime
}

function writeSource(projectRoot: string, content = 'Reusable source about code, tests, API, and deployment.'): string {
  const rel = 'raw/sources/source.md'
  const full = join(projectRoot, rel)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content, 'utf8')
  return rel
}

describe('ingest prompt and stream boundaries', () => {
  it('selects creative, engineering, and mixed language rules and truncates context', () => {
    expect(buildAnalysisPrompt('', '', '小说角色与世界观')).toContain('Chinese（简体中文）')
    expect(buildAnalysisPrompt('', '', '代码函数测试接口')).toContain('MANDATORY OUTPUT LANGUAGE: English')
    expect(buildAnalysisPrompt('p', 'i'.repeat(9000), '小说代码')).toContain('工程术语保留英文')

    const generation = buildGenerationPrompt({
      purpose: 'purpose',
      index: 'i'.repeat(9000),
      sourceFileName: 'source.md',
      sourceContent: '代码',
      analysis: 'analysis',
      today: '2026-08-31',
      schema: 's'.repeat(9000),
      summaryPath: 'wiki/_candidates/ingest/sources/source.md',
    })
    expect(generation).toContain('MANDATORY OUTPUT LANGUAGE: English')
    expect(generation).toContain('purpose')
  })

  it('keeps closers inside both fence styles until a matching fence closes', () => {
    const blocks = parseFileBlocks([
      'noise',
      '--- FILE: wiki/a.md ---',
      '~~~ts',
      '--- END FILE ---',
      '```',
      '~~~',
      '--- END FILE ---',
    ].join('\n'))
    expect(blocks).toEqual([{
      path: 'wiki/a.md',
      content: '~~~ts\n--- END FILE ---\n```\n~~~',
      closed: true,
    }])
  })

  it('collects visible deltas and rejects aborted and failed finishes', async () => {
    const successful = llmFor('ignored', 'visible')
    await expect(completeText(successful, 'p', 'm', 'prompt')).resolves.toBe('visible')

    for (const reason of ['aborted', 'error'] as const) {
      const failing = {
        stream: () => (async function* () {
          yield { type: 'finish', reason: { kind: reason } }
        })(),
      } as unknown as LlmRuntime
      await expect(completeText(failing, 'p', 'm', 'prompt', 'research'))
        .rejects.toThrow(`research: LLM call failed (${reason})`)
    }
  })
})

describe('two-stage ingest lifecycle', () => {
  it.each(['ingest analysis', 'ingest generation'])('rejects absent text from %s before creating candidate output', async (missingOperation) => {
    const projectRoot = root()
    const sourceRel = writeSource(projectRoot)
    const requests: KnowledgeWikiStageRequest[] = []
    const executor: KnowledgeWikiStageExecutor = {
      isolation: 'owned-worker-v1',
      async execute(request) {
        requests.push(request)
        return { text: request.kind === 'llm-complete' && request.operation === missingOperation ? null : 'source or analysis text' }
      },
    }

    await expect(ingestSource(executor, 'p', 'm', projectRoot, sourceRel, new AbortController().signal))
      .rejects.toThrow(`${missingOperation} returned no text`)
    expect(requests.map(request => request.kind === 'llm-complete' ? request.operation : request.kind))
      .toEqual(missingOperation === 'ingest analysis'
        ? ['file-extract', 'ingest analysis']
        : ['file-extract', 'ingest analysis', 'ingest generation'])
    expect(existsSync(join(projectRoot, 'wiki'))).toBe(false)
    expect(existsSync(join(projectRoot, '.llm-wiki'))).toBe(false)
    expect(readFileSync(join(projectRoot, sourceRel), 'utf8')).toBe('Reusable source about code, tests, API, and deployment.')
  })

  it('reports real log and summary write errors without claiming either file was written', async () => {
    const projectRoot = root()
    const sourceRel = writeSource(projectRoot)
    const governance = join(projectRoot, 'wiki', '_governance')
    const sources = join(projectRoot, 'wiki', '_candidates', 'ingest', 'sources')
    mkdirSync(dirname(sources), { recursive: true })
    writeFileSync(governance, 'preserve governance blocker')
    writeFileSync(sources, 'preserve source blocker')

    const result = await ingestSource(
      stageExecutorFor(llmFor('no FILE blocks')), 'p', 'm', projectRoot, sourceRel, new AbortController().signal,
    )

    expect(result.written).toEqual([])
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.stringMatching(/^log append failed: /u),
      expect.stringMatching(/^summary fallback failed: /u),
    ]))
    expect(readFileSync(governance, 'utf8')).toBe('preserve governance blocker')
    expect(readFileSync(sources, 'utf8')).toBe('preserve source blocker')
  })

  it('returns a clean empty-source outcome before calling the model', async () => {
    const projectRoot = root()
    const sourceRel = writeSource(projectRoot, '   ')
    const llm = { stream: () => { throw new Error('must not run') } } as unknown as LlmRuntime
    await expect(ingestSource(
      stageExecutorFor(llm), 'p', 'm', projectRoot, sourceRel, new AbortController().signal,
    )).resolves.toEqual({
      written: [], warnings: ['source content is empty'],
    })

    mkdirSync(join(projectRoot, 'raw', 'sources'), { recursive: true })
    writeFileSync(join(projectRoot, 'raw', 'sources', 'unsupported.zip'), 'binary', 'utf8')
    await expect(ingestSource(
      stageExecutorFor(llm), 'p', 'm', projectRoot, 'raw/sources/unsupported.zip',
      new AbortController().signal,
    )).resolves.toEqual({
      written: [], warnings: ['source content is empty'],
    })
  })

  it('routes every generated page to candidates, merges safely, and persists first-run reviews', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-08-31T12:00:00.000Z'))
    const projectRoot = root()
    const sourceRel = writeSource(projectRoot)
    writeFileSync(join(projectRoot, 'purpose.md'), 'Purpose', 'utf8')
    writeFileSync(join(projectRoot, 'schema.md'), 'Schema', 'utf8')
    mkdirSync(join(projectRoot, 'wiki'), { recursive: true })
    writeFileSync(join(projectRoot, 'wiki', 'index.md'), '# Empty Index', 'utf8')
    const plainTarget = join(projectRoot, 'wiki', '_candidates', 'ingest', 'concepts', 'plain.md')
    const mergeTarget = join(projectRoot, 'wiki', '_candidates', 'ingest', 'concepts', 'merge.md')
    mkdirSync(dirname(plainTarget), { recursive: true })
    writeFileSync(plainTarget, 'frontmatter-less existing page', 'utf8')
    writeFileSync(mergeTarget, '---\nsources: ["source.md", "other.md"]\nupdated: old\n---\nExisting shared body', 'utf8')
    const summaryName = sourceSummaryFileNameFromIdentity('source.md')
    const generated = [
      '--- FILE: wiki/sources/source.md ---',
      '---',
      'type: source',
      'title: Source',
      'created: old',
      'updated: old',
      'sources: []',
      '---',
      '# Source summary',
      '--- END FILE ---',
      '--- FILE: wiki/log.md ---',
      '---',
      'type: log',
      '---',
      '## [2000-01-01] ingest | Source',
      '--- END FILE ---',
      '--- FILE: wiki/concepts/new.md ---',
      '---',
      'type: concept',
      'status: canonical',
      'origin: wrong',
      'title: New',
      'created: old',
      'updated: old',
      'sources: ["wrong.md"]',
      '---',
      '# New candidate',
      '--- END FILE ---',
      '--- FILE: wiki/_candidates/ingest/concepts/direct.md ---',
      'plain candidate without frontmatter',
      '--- END FILE ---',
      '--- FILE: wiki/_governance/ingest-candidate-log.md ---',
      '--- END FILE ---',
      '--- FILE: wiki/concepts/plain.md ---',
      '---',
      'type: concept',
      'title: Plain',
      'sources: ["source.md"]',
      '---',
      '# Replacement',
      '--- END FILE ---',
      '--- FILE: wiki/concepts/merge.md ---',
      '---',
      'type: concept',
      'title: Merge',
      'sources: ["source.md"]',
      'updated: old',
      '---',
      '# Generated body',
      '--- END FILE ---',
      '--- FILE: outside.md ---',
      'body',
      '--- END FILE ---',
      '--- FILE: wiki/../../../../escape.md ---',
      'body',
      '--- END FILE ---',
      '--- FILE: wiki/concepts/open.md ---',
      'unclosed',
      '---REVIEW: suggestion | Check source---',
      'description: Review the candidate.',
      '---END REVIEW---',
    ].join('\n')

    const generatedLlm = llmFor(generated)
    const result = await ingestSource(
      stageExecutorFor(generatedLlm), 'p', 'm', projectRoot, sourceRel,
      new AbortController().signal,
    )

    expect(result.written).toContain(`wiki/_candidates/ingest/sources/${summaryName}`)
    expect(result.written).toContain('wiki/_governance/ingest-candidate-log.md')
    expect(result.written).toContain('wiki/_candidates/ingest/concepts/new.md')
    expect(result.written).toContain('wiki/_candidates/ingest/concepts/direct.md')
    expect(result.written).toContain('wiki/_candidates/ingest/concepts/merge.md')
    expect(result.warnings).toContain('merge left page unchanged (missing/empty sources): wiki/_candidates/ingest/concepts/plain.md')
    expect(result.warnings).toContain('ingest: FILE path must start with wiki/: outside.md')
    expect(result.warnings).toContain('ingest: FILE path escapes wiki directory: wiki/_candidates/ingest/../../../../escape.md')
    expect(result.warnings.some(warning => warning.startsWith('FILE block not closed:'))).toBe(true)
    expect(readFileSync(join(projectRoot, 'wiki', '_candidates', 'ingest', 'concepts', 'new.md'), 'utf8'))
      .toContain('status: candidate')
    expect(readFileSync(join(projectRoot, 'wiki', '_governance', 'ingest-candidate-log.md'), 'utf8'))
      .toContain('## [2026-08-31] ingest | Source')
    expect(existsSync(join(projectRoot, '.llm-wiki', 'review.json'))).toBe(true)
    expect(existsSync(join(projectRoot, 'wiki', 'concepts', 'new.md'))).toBe(false)
    expect(readFileSync(join(projectRoot, 'wiki', 'index.md'), 'utf8')).toBe('# Empty Index')
  })

  it('adds deterministic log and source-summary fallbacks when the model emits no files', async () => {
    const projectRoot = root()
    const sourceRel = writeSource(projectRoot, '小说角色与叙事知识。'.repeat(20))
    const emptyLlm = llmFor('no FILE blocks')
    const result = await ingestSource(
      stageExecutorFor(emptyLlm), 'p', 'm', projectRoot, sourceRel,
      new AbortController().signal,
    )

    expect(result.written).toContain('wiki/_governance/ingest-candidate-log.md')
    expect(result.written.some(path => path.startsWith('wiki/_candidates/ingest/sources/'))).toBe(true)
    expect(result.warnings).toEqual([])
  })

  it('reports a non-missing filesystem error before deterministic fallbacks', async () => {
    const projectRoot = root()
    const sourceRel = writeSource(projectRoot)
    writeFileSync(join(projectRoot, 'wiki'), 'blocks directories', 'utf8')

    const failingLlm = llmFor('no FILE blocks')
    await expect(ingestSource(
      stageExecutorFor(failingLlm), 'p', 'm', projectRoot, sourceRel,
      new AbortController().signal,
    ))
      .rejects.toThrow('ENOTDIR')
  })
})
