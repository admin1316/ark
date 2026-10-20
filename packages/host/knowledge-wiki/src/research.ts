/**
 * Deep-research pipeline (Ark-native port of LLM Wiki's): one topic →
 * LLM-generated multi-queries → web search through the harness web runtime →
 * a synthesized research candidate written into wiki/_candidates/research/.
 * both query expansion and synthesis; the web seam supplies citeable sources.
 * @module @deepseek-ai/dsh-knowledge-wiki/research
 */

import { basename } from 'node:path'
import type { WebSearchSource } from '@deepseek-ai/dsh-web'
import { parseFileBlocks } from './ingest.ts'
import type { ResearchResult } from './types.ts'
import { createPrivateConfinedFileIfMissing } from './filesystem.ts'
import { executeKnowledgeWikiStage, type KnowledgeWikiStageExecutor } from './stage-executor.ts'
import { normalizeResearchURL, validateResearchPage } from './research-evidence.ts'

/** Parse 3-5 search queries out of the LLM expansion output. */
function parseQueries(text: string): string[] {
  const lines = text.split('\n')
    .map(line => line.replace(/^[-*•\d.)\s]+/, '').trim())
    .filter(line => line.length >= 3 && line.length <= 120)
  return [...new Set(lines)].slice(0, 5)
}

/**
 * Run the deep-research pipeline for one topic.
 * Query expansion and synthesis each have a 120-second deadline; each search has 60 seconds.
 * Zero sources blocks synthesis; partial search and page-write failures remain warnings.
 * @param executor - Parent-owned worker/subprocess executor for model and web-search stages; absence rejects.
 * @param provider - LLM provider id.
 * @param model - exact model id.
 * @param projectPath - absolute project root.
 * @param topic - the research topic.
 * @param signal - Cancels stages and prevents subsequent page writes.
 * @returns Project-relative wiki/_candidates/research paths, unique source URL count, and warnings.
 * @throws If query expansion or synthesis fails, times out, or observes cancellation.
 */
export async function deepResearch(
  executor: KnowledgeWikiStageExecutor | undefined,
  provider: string,
  model: string,
  projectPath: string,
  topic: string,
  signal: AbortSignal,
): Promise<ResearchResult> {
  signal.throwIfAborted()
  if (executor === undefined) throw new Error('knowledge Wiki stage executor unavailable; refusing research')
  if (executor.assertSearchAvailable === undefined) throw new Error('knowledge web search availability cannot be established')
  await executor.assertSearchAvailable(signal)
  signal.throwIfAborted()
  const operationExecutor = executor.prepareOperation === undefined
    ? executor
    : await executor.prepareOperation({ provider, model, modelCalls: 2 }, signal)
  const warnings: string[] = []

  const expansion = await executeKnowledgeWikiStage(operationExecutor, {
    kind: 'llm-complete',
    provider,
    model,
    prompt: [
      'You are a research assistant. Given one research topic, produce 3-5 focused web-search queries that together cover the topic.',
      'Output ONLY the queries, one per line, no numbering, no preamble, no other text.',
      'Queries should be specific, search-engine-friendly, and complementary (different angles, not rewordings).',
      '',
      'MANDATORY OUTPUT LANGUAGE: match the topic language; English queries are fine for English sources.',
      '',
      `Topic: ${topic}`,
    ].join('\n'),
    operation: 'research query expansion',
    timeoutMs: 120_000,
  }, signal)
  const queries = parseQueries(expansion.text ?? '')
  if (queries.length === 0) {
    return { written: [], pageSources: {}, sources: [], sourceCount: 0, warnings: ['research: LLM produced no usable queries'], errorCode: 'invalid-queries' }
  }

  const sources: WebSearchSource[] = []
  const seenUrls = new Set<string>()
  for (const query of queries) {
    try {
      const result = await executeKnowledgeWikiStage(operationExecutor, {
        kind: 'web-search',
        query,
        maxResults: 4,
        timeoutMs: 60_000,
      }, signal)
      for (const source of result.sources ?? []) {
        const url = normalizeResearchURL(source.url)
        if (url === null || seenUrls.has(url)) continue
        seenUrls.add(url)
        sources.push({ ...source, url })
      }
    } catch (error) {
      signal.throwIfAborted()
      warnings.push(`search "${query}" failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  signal.throwIfAborted()
  if (sources.length === 0) {
    return { written: [], pageSources: {}, sources: [], sourceCount: 0, warnings: [...warnings, 'research: no citeable web sources; synthesis was not run'], errorCode: 'no-sources' }
  }

  const sourceDigest = sources.map((source, i) => (
    `${i + 1}. ${source.title ?? source.url}\n   URL: ${source.url}\n   ${source.snippet ?? ''}`
  )).join('\n')

  const synthesis = await executeKnowledgeWikiStage(operationExecutor, {
    kind: 'llm-complete',
    provider,
    model,
    prompt: [
      'You are a research synthesist. Based on the topic and the collected web sources, generate one wiki research page.',
      'Do not output chain-of-thought or preamble. Output ONLY the FILE block.',
      'The page must include a summary of findings, key points with source citations (as markdown links), and open questions.',
      'The supplied evidence consists of search snippets, not fetched full pages. State this limitation and distinguish inference from source statements.',
      'Cite only the supplied source URLs, using Markdown links or reference links. Include at least one citation; do not add other links, images, or HTML.',
      '',
      'Output format (STRICT):',
      '--- FILE: wiki/_candidates/research/<slug>.md ---',
      '---',
      'type: research',
      'status: candidate',
      'origin: research',
      'title: <topic title>',
      'tags: [deep-research]',
      'related: []',
      'created: <today>',
      'updated: <today>',
      'sources: [<all source URLs>]',
      '---',
      '',
      '# <topic title>',
      '',
      '## 摘要',
      '...',
      '## 关键发现',
      '- ... [source title](url)',
      '## 待决问题',
      '- ...',
      '--- END FILE ---',
      '',
      `Today is: ${new Date().toISOString().slice(0, 10)}.`,
      '',
      `Topic: ${topic}`,
      '',
      'Collected sources:',
      sourceDigest,
    ].join('\n'),
    operation: 'research synthesis',
    timeoutMs: 120_000,
  }, signal)

  const written: string[] = []
  const pageSources: Record<string, string[]> = {}
  let rejection: 'invalid-output' | 'invalid-citations' | undefined
  let validPages = 0
  const today = new Date().toISOString().slice(0, 10)
  for (const block of parseFileBlocks(synthesis.text ?? '')) {
    signal.throwIfAborted()
    if (!block.closed) {
      warnings.push(`FILE block not closed: ${block.path}`)
      rejection ??= 'invalid-output'
      continue
    }
    const fileName = basename(block.path)
    const rel = `wiki/_candidates/research/${fileName}`
    if (!/^[^\\/\u0000]+\.md$/iu.test(fileName) || fileName === '.md') {
      warnings.push(`invalid research page filename: ${block.path}`)
      rejection ??= 'invalid-output'
      continue
    }
    const page = validateResearchPage(block.content, seenUrls, fileName.slice(0, -3), today)
    if ('errorCode' in page) {
      warnings.push(`${block.path}: ${page.message}`)
      if (page.errorCode === 'invalid-citations' || rejection === undefined) rejection = page.errorCode
      continue
    }
    validPages++
    try {
      signal.throwIfAborted()
      if (!createPrivateConfinedFileIfMissing(projectPath, rel, Buffer.from(page.content))) {
        warnings.push(`research destination already exists; existing page preserved: ${rel}`)
        continue
      }
      written.push(rel)
      pageSources[rel] = page.sourceURLs
    } catch (error) {
      signal.throwIfAborted()
      warnings.push(error instanceof Error ? error.message : String(error))
    }
  }
  const errorCode = written.length > 0 ? undefined : validPages > 0 ? 'no-pages' : rejection ?? 'invalid-output'
  if (errorCode !== undefined && warnings.length === 0) warnings.push('research produced no valid candidate pages')
  return {
    written, pageSources, sourceCount: sources.length,
    sources: sources.map(({ url, title }) => ({ url, ...title === undefined ? {} : { title }, evidence: 'search-snippet' as const })),
    warnings, ...errorCode === undefined ? {} : { errorCode },
  }
}
