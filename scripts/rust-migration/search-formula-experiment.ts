/**
 * Deterministic, offline search-formula experiment.
 *
 * This file deliberately lives outside the production search module. It is a
 * small replay harness for comparing the current BM25 contract with BM25F,
 * BM25+, and rank-based hybrid fusion. It does not change the production
 * formula or call an embedding service.
 */

import { createHash } from 'node:crypto'
import { bm25, STOP_WORDS, tokenize, type SearchPage } from '../../packages/host/knowledge-wiki/src/search.ts'

/** A page used by the offline formula experiment. */
export interface FormulaExperimentPage extends SearchPage {}

/** A query and its independently supplied relevance judgments. */
export interface JudgedSearchQuery {
  /** Stable identifier for the judged query. */
  readonly id: string
  /** Query text replayed through every formula. */
  readonly query: string
  /** Query category used for slice reporting. */
  readonly type: string
  /** Relevance grade by page path; zero or missing paths are non-relevant. */
  readonly relevance: Readonly<Record<string, number>>
  /** Optional semantic rank supplied by a frozen evaluator fixture. */
  readonly vectorOrder?: readonly string[]
}

/** Input for a formula experiment. */
export interface FormulaExperimentFixture {
  /** Frozen corpus used by every formula. */
  readonly pages: readonly FormulaExperimentPage[]
  /** Judged queries over the corpus. */
  readonly queries: readonly JudgedSearchQuery[]
  /** SHA-256 hash of pages and queries, used to prevent accidental drift. */
  readonly corpusHash: string
}

/** A ranked page returned by one formula. */
export interface FormulaRankedHit {
  /** Page path. */
  readonly path: string
  /** Formula score, before display rounding. */
  readonly score: number
}

/** Aggregate quality metrics for one formula. */
export interface FormulaMetrics {
  /** Mean recall over queries with at least one judged relevant page. */
  readonly recallAt5: number
  /** Mean reciprocal rank of the first relevant page. */
  readonly mrr: number
  /** Mean graded nDCG at five results. */
  readonly ndcgAt5: number
  /** Fraction of queries for which the formula returned no results. */
  readonly emptyResultRate: number
}

/** Per-formula experiment output. */
export interface FormulaExperimentResult {
  /** Formula identifier. */
  readonly formula: 'bm25' | 'bm25f' | 'bm25+' | 'rrf'
  /** Formula parameters used by this run. */
  readonly parameters: Readonly<Record<string, number>>
  /** Aggregate quality metrics. */
  readonly metrics: FormulaMetrics
  /** Ranked results for each judged query, in query order. */
  readonly rankings: Readonly<Record<string, readonly FormulaRankedHit[]>>
}

/** Complete deterministic experiment report. */
export interface FormulaExperimentReport {
  /** Report schema version. */
  readonly schemaVersion: 1
  /** Indicates that no network or mutable index was used. */
  readonly mode: 'offline-deterministic'
  /** Frozen fixture hash. */
  readonly corpusHash: string
  /** Number of unique production stop words used by tokenization. */
  readonly stopWordCount: number
  /** Formula reports. */
  readonly results: readonly FormulaExperimentResult[]
}

const BM25_K1 = 1.5
const BM25_B = 0.75
const BM25_PLUS_DELTA = 0.5
const BM25F_K1 = 1.2
const BM25F_FIELDS = {
  title: { weight: 3, b: 0.2 },
  aliases: { weight: 2, b: 0.2 },
  body: { weight: 1, b: 0.75 },
} as const

type FormulaField = keyof typeof BM25F_FIELDS

interface PreparedField {
  readonly tokens: readonly string[]
  readonly frequencies: ReadonlyMap<string, number>
}

interface PreparedFormulaPage {
  readonly page: FormulaExperimentPage
  readonly fields: Readonly<Record<FormulaField, PreparedField>>
  readonly allTokens: readonly string[]
}

function fieldTokens(page: FormulaExperimentPage, field: FormulaField): string[] {
  if (field === 'title') return tokenize(page.title)
  if (field === 'aliases') return tokenize(page.aliases.join('\n'))
  return tokenize(page.text)
}

function frequencies(tokens: readonly string[]): ReadonlyMap<string, number> {
  const output = new Map<string, number>()
  for (const token of tokens) output.set(token, (output.get(token) ?? 0) + 1)
  return output
}

function preparePages(pages: readonly FormulaExperimentPage[]): {
  readonly pages: readonly PreparedFormulaPage[]
  readonly docFreq: ReadonlyMap<string, number>
  readonly avgLength: Readonly<Record<FormulaField, number>>
} {
  const prepared = pages.map((page) => {
    const fields = {
      title: fieldTokens(page, 'title'),
      aliases: fieldTokens(page, 'aliases'),
      body: fieldTokens(page, 'body'),
    }
    return {
      page,
      fields: {
        title: { tokens: fields.title, frequencies: frequencies(fields.title) },
        aliases: { tokens: fields.aliases, frequencies: frequencies(fields.aliases) },
        body: { tokens: fields.body, frequencies: frequencies(fields.body) },
      },
      allTokens: [...fields.title, ...fields.aliases, ...fields.body],
    }
  })
  const docFreq = new Map<string, number>()
  for (const item of prepared) {
    for (const token of new Set(item.allTokens)) docFreq.set(token, (docFreq.get(token) ?? 0) + 1)
  }
  const avgLength = {
    title: prepared.reduce((sum, item) => sum + item.fields.title.tokens.length, 0) / Math.max(1, prepared.length),
    aliases: prepared.reduce((sum, item) => sum + item.fields.aliases.tokens.length, 0) / Math.max(1, prepared.length),
    body: prepared.reduce((sum, item) => sum + item.fields.body.tokens.length, 0) / Math.max(1, prepared.length),
  }
  return { pages: prepared, docFreq, avgLength }
}

function queryTerms(query: string): string[] {
  return [...new Set(tokenize(query).filter(token => !STOP_WORDS.has(token)))]
}

function fixtureHash(pages: readonly FormulaExperimentPage[], queries: readonly JudgedSearchQuery[]): string {
  return createHash('sha256').update(JSON.stringify({ pages, queries })).digest('hex')
}

function idf(documents: number, documentFrequency: number): number {
  return Math.log(1 + (documents - documentFrequency + 0.5) / (documentFrequency + 0.5))
}

function rank(scores: Iterable<FormulaRankedHit>): FormulaRankedHit[] {
  return [...scores].filter(hit => hit.score > 0 && Number.isFinite(hit.score)).sort((left, right) => {
    const difference = right.score - left.score
    return difference !== 0 ? difference : left.path.localeCompare(right.path)
  })
}

/** Score a query with field-aware BM25F using fixed, tunable shadow parameters. */
export function bm25f(pages: readonly FormulaExperimentPage[], query: string): FormulaRankedHit[] {
  const index = preparePages(pages)
  const terms = queryTerms(query)
  if (terms.length === 0) return []
  return rank(index.pages.map(({ page, fields }) => {
    let score = 0
    for (const term of terms) {
      const documentFrequency = index.docFreq.get(term) ?? 0
      if (documentFrequency === 0) continue
      let weightedTf = 0
      for (const field of Object.keys(BM25F_FIELDS) as FormulaField[]) {
        const config = BM25F_FIELDS[field]
        const prepared = fields[field]
        const average = index.avgLength[field]
        const lengthNormalization = 1 - config.b + config.b * prepared.tokens.length / Math.max(1, average)
        weightedTf += config.weight * (prepared.frequencies.get(term) ?? 0) / lengthNormalization
      }
      if (weightedTf > 0) score += idf(index.pages.length, documentFrequency) * ((BM25F_K1 + 1) * weightedTf / (BM25F_K1 + weightedTf))
    }
    return { path: page.path, score }
  }))
}

/** Score a query with BM25 plus a lower-bounded term-frequency contribution. */
export function bm25Plus(pages: readonly FormulaExperimentPage[], query: string): FormulaRankedHit[] {
  const baseline = bm25(pages, query)
  const index = preparePages(pages)
  const terms = queryTerms(query)
  if (terms.length === 0) return []
  const scores = new Map(baseline.map(hit => [hit.path, hit.score]))
  for (const item of index.pages) {
    let score = scores.get(item.page.path) ?? 0
    for (const term of terms) {
      const documentFrequency = index.docFreq.get(term) ?? 0
      const termFrequency = (item.fields.title.frequencies.get(term) ?? 0)
        + (item.fields.aliases.frequencies.get(term) ?? 0)
        + (item.fields.body.frequencies.get(term) ?? 0)
      if (documentFrequency > 0 && termFrequency > 0) {
        score += BM25_PLUS_DELTA * idf(index.pages.length, documentFrequency)
      }
    }
    scores.set(item.page.path, score)
  }
  return rank(index.pages.map(item => ({ path: item.page.path, score: scores.get(item.page.path) ?? 0 })))
}

/** Fuse two independently ranked lists with reciprocal rank fusion. */
export function reciprocalRankFusion(
  lexical: readonly FormulaRankedHit[],
  semanticPaths: readonly string[],
  k = 60,
  alpha = 0.5,
): FormulaRankedHit[] {
  const scores = new Map<string, number>()
  lexical.forEach((hit, index) => scores.set(hit.path, (scores.get(hit.path) ?? 0) + alpha / (k + index + 1)))
  semanticPaths.forEach((path, index) => scores.set(path, (scores.get(path) ?? 0) + (1 - alpha) / (k + index + 1)))
  return rank([...scores].map(([path, score]) => ({ path, score })))
}

function metricForRanking(
  ranking: readonly FormulaRankedHit[],
  query: JudgedSearchQuery,
): { recall: number | null; reciprocalRank: number; ndcg: number } {
  const relevant = Object.entries(query.relevance).filter(([, grade]) => grade > 0)
  const hits = ranking.slice(0, 5)
  const hitPaths = new Set(hits.map(hit => hit.path))
  const recall = relevant.length === 0 ? null : relevant.filter(([path]) => hitPaths.has(path)).length / relevant.length
  const firstRelevantIndex = ranking.findIndex(hit => (query.relevance[hit.path] ?? 0) > 0)
  const reciprocalRank = firstRelevantIndex < 0 ? 0 : 1 / (firstRelevantIndex + 1)
  const dcg = hits.reduce((sum, hit, index) => sum + (query.relevance[hit.path] ?? 0) / Math.log2(index + 2), 0)
  const ideal = relevant.map(([, grade]) => grade).sort((left, right) => right - left).slice(0, 5)
  const idealDcg = ideal.reduce((sum, grade, index) => sum + grade / Math.log2(index + 2), 0)
  return { recall, reciprocalRank, ndcg: idealDcg === 0 ? 0 : dcg / idealDcg }
}

function metrics(rankings: Readonly<Record<string, readonly FormulaRankedHit[]>>, queries: readonly JudgedSearchQuery[]): FormulaMetrics {
  const values = queries.map(query => metricForRanking(rankings[query.id] ?? [], query))
  const recallValues = values.flatMap(value => value.recall === null ? [] : [value.recall])
  return {
    recallAt5: recallValues.length === 0 ? 0 : recallValues.reduce((sum, value) => sum + value, 0) / recallValues.length,
    mrr: values.reduce((sum, value) => sum + value.reciprocalRank, 0) / Math.max(1, values.length),
    ndcgAt5: values.reduce((sum, value) => sum + value.ndcg, 0) / Math.max(1, values.length),
    emptyResultRate: values.filter((_, index) => (rankings[queries[index]?.id ?? ''] ?? []).length === 0).length / Math.max(1, values.length),
  }
}

function evaluate(
  formula: FormulaExperimentResult['formula'],
  fixture: FormulaExperimentFixture,
  ranker: (query: JudgedSearchQuery) => FormulaRankedHit[],
  parameters: Readonly<Record<string, number>>,
): FormulaExperimentResult {
  const rankings = Object.fromEntries(fixture.queries.map(query => [query.id, ranker(query)]))
  return { formula, parameters, rankings, metrics: metrics(rankings, fixture.queries) }
}

/** Build the small frozen corpus used by tests and local smoke runs. */
export function formulaExperimentFixture(): FormulaExperimentFixture {
  const pages: FormulaExperimentPage[] = [
    { path: 'concepts/rust-runtime.md', title: 'Rust runtime candidate', aliases: ['Rust 候选', 'rust shadow'], text: 'The Rust candidate provides deterministic BM25 ranking, differential replay, and process isolation.' },
    { path: 'concepts/cancellation.md', title: 'Cancellation and recovery', aliases: ['请求取消', 'crash recovery'], text: 'Cancel an in-flight request and recover the candidate process without changing the active session.' },
    { path: 'concepts/knowledge-governance.md', title: '知识治理', aliases: ['knowledge governance'], text: '知识库治理记录候选来源、证据、冲突检查、promotion 和 retention。' },
    { path: 'concepts/unrelated.md', title: 'Release checklist', aliases: ['packaging'], text: 'Package metadata and release notes for the application.' },
    { path: 'concepts/semantic-boundary.md', title: 'Semantic boundary', aliases: ['embedding boundary'], text: 'Embedding vectors require a fixed dimension and finite values before hybrid ranking.' },
  ]
  const queries: JudgedSearchQuery[] = [
    { id: 'q-rust', query: 'Rust candidate differential replay', type: 'exact-identifier', relevance: { 'concepts/rust-runtime.md': 3 } },
    { id: 'q-cancel', query: '如何取消请求并恢复', type: 'cross-language', relevance: { 'concepts/cancellation.md': 3 }, vectorOrder: ['concepts/cancellation.md', 'concepts/rust-runtime.md'] },
    { id: 'q-governance', query: '知识治理 candidate', type: 'chinese', relevance: { 'concepts/knowledge-governance.md': 3 } },
    { id: 'q-vector', query: 'semantic vector dimension', type: 'semantic', relevance: { 'concepts/semantic-boundary.md': 3 }, vectorOrder: ['concepts/semantic-boundary.md', 'concepts/rust-runtime.md'] },
    { id: 'q-empty', query: 'please show', type: 'stop-word-only', relevance: {} },
  ]
  const hash = fixtureHash(pages, queries)
  return { pages, queries, corpusHash: hash }
}

/** Run all formula shadows over one frozen fixture without network access. */
export function runFormulaExperiment(fixture = formulaExperimentFixture()): FormulaExperimentReport {
  if (fixtureHash(fixture.pages, fixture.queries) !== fixture.corpusHash) {
    throw new Error('formula experiment corpus hash does not match pages and queries')
  }
  const lexical = (query: JudgedSearchQuery): FormulaRankedHit[] => bm25(fixture.pages, query.query)
  return {
    schemaVersion: 1,
    mode: 'offline-deterministic',
    corpusHash: fixture.corpusHash,
    stopWordCount: STOP_WORDS.size,
    results: [
      evaluate('bm25', fixture, lexical, { k1: BM25_K1, b: BM25_B }),
      evaluate('bm25f', fixture, fixtureQuery => bm25f(fixture.pages, fixtureQuery.query), { k1: BM25F_K1, titleWeight: BM25F_FIELDS.title.weight, aliasWeight: BM25F_FIELDS.aliases.weight, bodyWeight: BM25F_FIELDS.body.weight }),
      evaluate('bm25+', fixture, fixtureQuery => bm25Plus(fixture.pages, fixtureQuery.query), { delta: BM25_PLUS_DELTA }),
      evaluate('rrf', fixture, fixtureQuery => reciprocalRankFusion(lexical(fixtureQuery), fixtureQuery.vectorOrder ?? [], 60, 0.5), { k: 60, alpha: 0.5 }),
    ],
  }
}

if (process.argv[1] !== undefined && import.meta.filename === process.argv[1]) {
  process.stdout.write(`${JSON.stringify(runFormulaExperiment(), null, 2)}\n`)
}
