/**
 * Two-stage chain-of-thought ingestion: stage 1 analyzes the source into
 * entities/concepts/findings, stage 2 generates wiki pages as
 * `--- FILE: <path> ---` blocks. The harness LLM runtime supplies both
 * calls; generated pages are sanitized, stamped, canonicalized, merged
 * with any existing candidate page, and written under the project's
 * wiki/_candidates/ingest/ directory. Deterministic fallbacks (candidate
 * log entry, source
 * summary, review items) run after the model blocks.
 * @module @deepseek-ai/dsh-knowledge-wiki/ingest
 */

import { readFile } from 'node:fs/promises'
import { basename, join, normalize, resolve, sep } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { sourceIdentityForPath, sourceSummaryFileNameFromIdentity } from './source-slug.ts'
import { stampSourcesField } from './frontmatter-utils.ts'
import { sanitizeIngestedFileContent, stampGeneratedFrontmatterDates, stampGeneratedLogDate } from './sanitize.ts'
import { buildFallbackSourceSummaryPage, fallbackSummaryRelPath } from './fallback-summary.ts'
import { atomicWriteFile, isMissingPathError } from './filesystem.ts'
import { mergePageContent } from './merge-page.ts'
import { appendCandidateReviews, appendReviews, parseReviewBlocks } from './reviews.ts'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { IngestOutcome } from './types.ts'
import { executeKnowledgeWikiStage, type KnowledgeWikiStageExecutor } from './stage-executor.ts'

const OPENER_LINE = /^---\s*FILE:\s*(.+?)\s*---\s*$/i
const CLOSER_LINE = /^---\s*END\s+FILE\s*---\s*$/i
const FENCE_LINE = /^\s{0,3}(```+|~~~+)/
const CANDIDATE_INGEST_PREFIX = 'wiki/_candidates/ingest'
const CANDIDATE_LOG_REL = 'wiki/_governance/ingest-candidate-log.md'

/** Language rule matching LLM Wiki's: engineering output English, creative output Chinese. */
function languageRule(sourceContent: string): string {
  const creativeHints = /小说|剧本|分镜|角色|叙事|世界观|故事|对白|章节|灵感/
  const engineeringHints = /代码|函数|类型|测试|接口|部署|提交|构建|调试|bug|tsx?|rs\b/
  const creative = creativeHints.test(sourceContent)
  const engineering = engineeringHints.test(sourceContent)
  if (creative && !engineering) return 'MANDATORY OUTPUT LANGUAGE: Chinese（简体中文）'
  if (engineering && !creative) return 'MANDATORY OUTPUT LANGUAGE: English'
  return 'MANDATORY OUTPUT LANGUAGE: Chinese（简体中文，工程术语保留英文）'
}

/**
 * Stage 1: structured analysis of one source document.
 * @param purpose - the project purpose.md text (may be empty).
 * @param index - the wiki index text (may be empty).
 * @param sourceContent - the source document text.
 * @returns the analysis prompt.
 */
export function buildAnalysisPrompt(purpose: string, index: string, sourceContent: string): string {
  return [
    'You are an expert research analyst. Read the source document and produce a structured analysis.',
    'Do not output chain-of-thought, hidden reasoning, or a thinking transcript. Reason internally and write only the concise final analysis.',
    '',
    languageRule(sourceContent),
    '',
    'Your analysis should cover:',
    '',
    '## Key Entities',
    'List people, organizations, products, datasets, tools mentioned. For each:',
    '- Name and type',
    '- Role in the source (central vs. peripheral)',
    '- Whether it likely already exists in the wiki (check the index)',
    '',
    '## Key Concepts',
    'List theories, methods, techniques, phenomena. For each:',
    '- Name and brief definition',
    '- Why it matters in this source',
    '- Whether it likely already exists in the wiki',
    '',
    '## Main Arguments & Findings',
    '- What are the core claims or results?',
    '- What evidence supports them?',
    '- How strong is the evidence?',
    '- Which claims are reusable outside this one source or task?',
    '- Which claims are already covered by an existing wiki page and should not become a new page?',
    '',
    '## Workflow / Process Notes',
    '- Steps, tool usage patterns, iteration loops described',
    '- Constraints, pitfalls, or rules the source records',
    '',
    '## Suggested Wiki Pages',
    'Recommend concrete pages (type + path + one-line purpose) this source warrants.',
    'For every suggestion, state: admission=KEEP_CANDIDATE|EVIDENCE_ONLY|SKIP, novelty=new|extends|duplicate, evidence strength, applicability, and the canonical merge target when one exists.',
    'Do not suggest a page for conversational commands, task progress, tool transcripts, completion claims, local paths, commit hashes, build artifacts, or one-off troubleshooting history.',
    'If the source contains no reusable knowledge, explicitly return NO_CANONICAL_KNOWLEDGE.',
    'A reflection is not a fact. Classify it as a hypothesis unless it contains a reproducible failure pattern, evidence-backed cause, counterfactual action, prevention step, applicability boundary, and at least two independent sources.',
    '',
    '## Project Purpose (context)',
    purpose.trim() === '' ? '(none provided)' : purpose,
    '',
    '## Existing Wiki Index (partial)',
    index.trim() === '' ? '(none provided)' : index.slice(0, 8000),
    '',
    '## Source Document',
    '<<<',
    sourceContent.slice(0, 60000),
    '>>>',
  ].join('\n')
}

/** Options for the stage-2 generation prompt. */
export interface GenerationPromptOptions {
  /** The project purpose.md text (may be empty). */
  readonly purpose: string
  /** The wiki index text (may be empty). */
  readonly index: string
  /** Original source file name (goes into `sources`). */
  readonly sourceFileName: string
  /** The source text (language rule input). */
  readonly sourceContent: string
  /** Stage-1 analysis text. */
  readonly analysis: string
  /** ISO date string for created/updated/log stamps. */
  readonly today: string
  /** The project schema.md text (may be empty). */
  readonly schema: string
  /** The exact wiki-relative summary page path (wiki/sources/<slug>.md). */
  readonly summaryPath: string
}

/**
 * Stage 2: wiki page generation from the stage-1 analysis.
 * @param options - generation prompt inputs.
 * @returns the generation prompt.
 */
export function buildGenerationPrompt(options: GenerationPromptOptions): string {
  const { purpose, index, sourceFileName, sourceContent, analysis, today, schema, summaryPath } = options
  return [
    'You are a wiki maintainer. Based on the analysis provided, generate wiki files.',
    'Do not output chain-of-thought, hidden reasoning, or explanatory preamble. Reason internally and output only the requested FILE blocks.',
    '',
    languageRule(sourceContent),
    '',
    '## IMPORTANT: Today\'s Date',
    `Today is ${today}. Use this exact date for every created/updated field and log entry.`,
    '',
    '## IMPORTANT: Source File',
    `The original source file is: **${sourceFileName}**`,
    'All wiki pages generated from this source MUST include this filename in their frontmatter `sources` field.',
    '',
    '## What to generate',
    '',
    `1. A source summary candidate at **${summaryPath}** (MUST use this exact path)`,
    '2. Entity candidates at wiki/_candidates/ingest/entities/ only for stable, central identities supported by meaningful claims',
    '3. Concept candidates at wiki/_candidates/ingest/concepts/ only for reusable knowledge that passes every admission gate below',
    `4. A candidate log entry for ${CANDIDATE_LOG_REL} (format: ## [YYYY-MM-DD] ingest | Title)`,
    '',
    '## Canonical Admission Gate',
    '',
    'A concept or entity candidate is allowed only when all are true:',
    '- It adds a reusable claim, method, constraint, or decision beyond this one task.',
    '- Its source evidence is explicit and the body distinguishes evidence from inference.',
    '- It is not a duplicate; extending an existing topic must target that page for merge instead of creating a sibling.',
    '- It states applicability, limits, exceptions, or verification steps.',
    '- It contains no conversation transcript, tool log, progress narration, local path, commit hash, build artifact, or unsupported completion claim.',
    '- Reflections use candidate_kind: reflection and epistemic_status: hypothesis. They never become Canonical from one source or one conversation.',
    '- A verified reflection requires at least two independent sources plus explicit verification evidence; repeated messages from one session are one source.',
    'When any gate fails, generate no entity/concept candidate. Keep only the source summary candidate and log entry as Evidence/Candidate material.',
    '',
    '## Frontmatter Rules (CRITICAL — parser is strict)',
    '',
    '1. The VERY FIRST line of the file MUST be exactly `---` (three hyphens, nothing else).',
    '2. Every page needs frontmatter fields: type, status, origin, title, tags, related, created, updated, sources.',
    '3. Every generated page MUST use `status: candidate` and `origin: ingest`.',
    '4. `sources` MUST include the original source filename; array fields use the form ["item1", "item2"].',
    '5. Do NOT wrap files in code fences in your output.',
    '6. Use `## [YYYY-MM-DD] ingest | Title` (today\'s date) for the log entry heading.',
    '',
    '## Output format (STRICT)',
    '',
    'Wrap every file exactly like this:',
    '',
    '--- FILE: wiki/_candidates/ingest/concepts/example.md ---',
    '---',
    'type: concept',
    'status: candidate',
    'origin: ingest',
    'title: Example',
    'tags: []',
    'related: []',
    `created: ${today}`,
    `updated: ${today}`,
    'sources: ["original-source.md"]',
    '---',
    '',
    '# Example',
    '',
    'Page body…',
    '--- END FILE ---',
    '',
    '## Project Schema (context)',
    schema.trim() === '' ? '(none provided)' : schema.slice(0, 8000),
    '',
    '## Project Purpose (context)',
    purpose.trim() === '' ? '(none provided)' : purpose,
    '',
    '## Existing Wiki Index (partial)',
    index.trim() === '' ? '(none provided)' : index.slice(0, 8000),
    '',
    '## Analysis (stage 1 output)',
    '<<<',
    analysis,
    '>>>',
  ].join('\n')
}

/** One parsed FILE block. */
export interface ParsedFileBlock {
  readonly path: string
  readonly content: string
  readonly closed: boolean
}

/**
 * Parse `--- FILE: path --- … --- END FILE ---` blocks out of model output.
 * @param text - The text input.
 * @returns The value produced by parse file blocks.
 */
export function parseFileBlocks(text: string): ParsedFileBlock[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const blocks: ParsedFileBlock[] = []
  let current: {
    path: string
    content: string[]
    fenceMarker: string | null
    fenceLength: number
  } | null = null
  for (const line of lines) {
    if (current === null) {
      const openerMatch = OPENER_LINE.exec(line)
      const openedPath = openerMatch?.[1]
      if (openedPath !== undefined) {
        current = { path: openedPath.trim(), content: [], fenceMarker: null, fenceLength: 0 }
      }
      continue
    }
    const fenceRun = FENCE_LINE.exec(line)?.[1]
    if (fenceRun !== undefined) {
      const marker = fenceRun.charAt(0)
      if (current.fenceMarker === null) {
        current.fenceMarker = marker
        current.fenceLength = fenceRun.length
      } else if (marker === current.fenceMarker && fenceRun.length >= current.fenceLength) {
        current.fenceMarker = null
        current.fenceLength = 0
      }
      current.content.push(line)
      continue
    }
    if (current.fenceMarker === null && CLOSER_LINE.test(line)) {
      blocks.push({ path: current.path, content: current.content.join('\n'), closed: true })
      current = null
      continue
    }
    current.content.push(line)
  }
  if (current !== null) blocks.push({ path: current.path, content: current.content.join('\n'), closed: false })
  return blocks
}

/** Reject FILE block paths that escape the project's wiki/ directory.
 * FILE paths are project-relative (e.g. wiki/concepts/x.md), matching the
 * LLM Wiki prompt contract. */
function safeWikiPath(projectPath: string, rel: string): string {
  const wikiRoot = resolve(projectPath, 'wiki')
  const target = resolve(normalize(join(projectPath, rel)))
  if (!target.startsWith(wikiRoot + sep)) {
    throw new Error(`ingest: FILE path escapes wiki directory: ${rel}`)
  }
  return target
}

/** Route every generated wiki path into the non-graph candidate namespace. */
function candidateIngestRel(rel: string): string {
  if (rel === CANDIDATE_LOG_REL || rel.startsWith(`${CANDIDATE_INGEST_PREFIX}/`)) return rel
  if (!rel.startsWith('wiki/')) throw new Error(`ingest: FILE path must start with wiki/: ${rel}`)
  if (rel === 'wiki/log.md') return CANDIDATE_LOG_REL
  return `${CANDIDATE_INGEST_PREFIX}/${rel.slice('wiki/'.length)}`
}

/** Enforce candidate provenance even when the model omits the required fields. */
function stampCandidateFrontmatter(content: string): string {
  if (!content.startsWith('---\n')) return content
  let stamped = content
  if (/^status:\s*/mu.test(stamped)) stamped = stamped.replace(/^status:\s*.*$/mu, 'status: candidate')
  else stamped = stamped.replace(/^---\n/u, '---\nstatus: candidate\n')
  if (/^origin:\s*/mu.test(stamped)) stamped = stamped.replace(/^origin:\s*.*$/mu, 'origin: ingest')
  else stamped = stamped.replace(/^---\n/u, '---\norigin: ingest\n')
  return stamped
}

/**
 * Collect the visible text of one streamed LLM call. 也供 auto-sediment 的 kind 语义分类复用。
 * @param llm - Runtime streaming a single user message attributed to knowledge-wiki.
 * @param provider - Provider route for the model call.
 * @param model - Exact model id on that provider.
 * @param prompt - Text of the sole user message.
 * @param operation - Stable operation name used in streamed failure diagnostics.
 * @param signal - Optional cancellation passed to the runtime and checked before streaming and at each chunk.
 * @returns Concatenated text-delta content after the stream ends; reasoning and other chunk kinds are omitted.
 * @throws On observed cancellation, stream errors, or an aborted/error finish chunk; partial text is not returned.
 */
export async function completeText(
  llm: LlmRuntime,
  provider: string,
  model: string,
  prompt: string,
  operation = 'ingest',
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted()
  let out = ''
  for await (const chunk of llm.stream({
    provider,
    model,
    messages: [createUserMessage({
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'plugin', plugin: 'knowledge-wiki' },
    })],
    ...(signal === undefined ? {} : { signal }),
  })) {
    signal?.throwIfAborted()
    if (chunk.type === 'text-delta') out += chunk.text
    if (chunk.type === 'finish' && (chunk.reason.kind === 'aborted' || chunk.reason.kind === 'error')) {
      throw new Error(`${operation}: LLM call failed (${chunk.reason.kind})`)
    }
  }
  return out
}

/** Read a text file (best effort). */
async function optionalText(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (!isMissingPathError(error)) throw error
    return ''
  }
}

/** Append one log entry to wiki/log.md (existing entries preserved). */
async function appendLogEntry(logPath: string, entry: string): Promise<void> {
  const existing = await optionalText(logPath)
  atomicWriteFile(logPath, existing.replace(/\n*$/, '\n\n') + entry + '\n')
}

/**
 * Run the two-stage ingestion for one source file and write the generated
 * pages. Every extraction/model stage runs through the injected owned
 * worker/subprocess executor; this package refuses an in-process fallback.
 * Extraction has a 60-second deadline and each model stage has 120 seconds.
 * Candidate pages/log entries and reviews can be partially written; per-write failures become warnings.
 * @param executor - parent-owned worker/subprocess stage executor.
 * @param provider - LLM provider id (e.g. deepseek-official).
 * @param model - exact model id.
 * @param projectPath - absolute project root.
 * @param sourceRel - project-relative source path (e.g. raw/sources/x.md).
 * @param signal - Cancels executor stages and is checked between reads and before selected writes; no rollback.
 * @returns Written project-relative wiki/_candidates paths and warnings, including caught write-time cancellation.
 * @throws On uncaught cancellation, stage failures/missing text, or source/context read failures.
 */
export async function ingestSource(
  executor: KnowledgeWikiStageExecutor | undefined,
  provider: string,
  model: string,
  projectPath: string,
  sourceRel: string,
  signal: AbortSignal,
): Promise<IngestOutcome> {
  signal.throwIfAborted()
  const warnings: string[] = []
  const identity = sourceIdentityForPath(projectPath, join(projectPath, sourceRel))
  const sourceName = basename(sourceRel)
  const sourceTitle = sourceName.replace(/\.[^.]+$/u, '')
  const extracted = await executeKnowledgeWikiStage(executor, {
    kind: 'file-extract',
    path: join(projectPath, sourceRel),
    timeoutMs: 60_000,
  }, signal)
  signal.throwIfAborted()
  const sourceContent = extracted.text ?? ''
  if (sourceContent.trim() === '') {
    return { written: [], warnings: [...warnings, 'source content is empty'] }
  }

  const purpose = await optionalText(join(projectPath, 'purpose.md'))
  signal.throwIfAborted()
  const schema = await optionalText(join(projectPath, 'schema.md'))
  signal.throwIfAborted()
  const index = await optionalText(join(projectPath, 'wiki', 'index.md'))
  signal.throwIfAborted()
  const today = new Date().toISOString().slice(0, 10)
  const summaryFileName = sourceSummaryFileNameFromIdentity(identity)

  const analysis = await executeKnowledgeWikiStage(executor, {
    kind: 'llm-complete',
    provider,
    model,
    prompt: buildAnalysisPrompt(purpose, index, sourceContent),
    operation: 'ingest analysis',
    timeoutMs: 120_000,
  }, signal)
  if (analysis.text === null) throw new Error('ingest analysis returned no text')
  const generated = await executeKnowledgeWikiStage(executor, {
    kind: 'llm-complete',
    provider,
    model,
    prompt: buildGenerationPrompt({
      purpose,
      index,
      sourceFileName: sourceRel,
      sourceContent,
      analysis: analysis.text,
      today,
      schema,
      summaryPath: `${CANDIDATE_INGEST_PREFIX}/sources/${summaryFileName}`,
    }),
    operation: 'ingest generation',
    timeoutMs: 120_000,
  }, signal)
  if (generated.text === null) throw new Error('ingest generation returned no text')

  const written: string[] = []
  for (const block of parseFileBlocks(generated.text)) {
    signal.throwIfAborted()
    if (!block.closed) {
      warnings.push(`FILE block not closed: ${block.path}`)
      continue
    }
    let rel = block.path
    // Force the summary page onto the contract slug: the model may emit a
    // base-name path instead of the exact slugged path.
    if (rel === `wiki/sources/${sourceTitle}.md`) {
      rel = `wiki/sources/${summaryFileName}`
    }
    try {
      rel = candidateIngestRel(rel)
      const target = safeWikiPath(projectPath, rel)
      if (rel === CANDIDATE_LOG_REL) {
        const entry = block.content.replace(/^---[\s\S]*?---\n\n?/u, '').trim()
        if (entry !== '') {
          await appendLogEntry(target, stampGeneratedLogDate(entry, today))
          written.push(rel)
        }
        continue
      }
      let content = sanitizeIngestedFileContent(block.content)
      content = stampGeneratedFrontmatterDates(content, today)
      content = stampSourcesField(content, identity)
      content = stampCandidateFrontmatter(content)
      const existing = await optionalText(target)
      if (existing !== '') {
        const merged = mergePageContent(existing, content, identity, today)
        if (merged === existing) {
          warnings.push(`merge left page unchanged (missing/empty sources): ${rel}`)
          continue
        }
        content = merged
      }
      signal.throwIfAborted()
      atomicWriteFile(target, content)
      written.push(rel)
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error))
    }
  }

  // Deterministic fallbacks: log entry, source summary, and review items —
  // each independent of model output shape.
  if (!written.includes(CANDIDATE_LOG_REL)) {
    try {
      signal.throwIfAborted()
      await appendLogEntry(join(projectPath, CANDIDATE_LOG_REL), `## [${today}] ingest | ${sourceTitle}`)
      written.push(CANDIDATE_LOG_REL)
    } catch (error) {
      warnings.push(`log append failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const summaryRel = candidateIngestRel(fallbackSummaryRelPath(identity))
  if (!written.includes(summaryRel)) {
    try {
      signal.throwIfAborted()
      const target = safeWikiPath(projectPath, summaryRel)
      atomicWriteFile(target, stampCandidateFrontmatter(buildFallbackSourceSummaryPage(identity, today)))
      written.push(summaryRel)
    } catch (error) {
      warnings.push(`summary fallback failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  try {
    signal.throwIfAborted()
    const reviews = parseReviewBlocks(generated.text)
    if (reviews.length > 0) {
      appendReviews(join(projectPath, '.llm-wiki', 'review.json'), join(projectPath, sourceRel), reviews)
    }
  } catch (error) {
    warnings.push(`review append failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    signal.throwIfAborted()
    appendCandidateReviews(join(projectPath, '.llm-wiki', 'review.json'), projectPath, sourceRel, written)
  } catch (error) {
    warnings.push(`candidate review failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  return { written, warnings }
}
