/**
 * Local hybrid search for the 万相织鉴 knowledge base: BM25 keyword scoring
 * over wiki pages, plus optional semantic vectors from the DashScope
 * embedding API. Runs fully in-process — no LLM Wiki app dependency.
 * @module @deepseek-ai/dsh-knowledge-wiki/search
 */

import { visitWikiTree } from './graph.ts'
import { parseFrontmatterField } from './frontmatter-utils.ts'
import { MAX_WIKI_PAGE_BYTES, readRegularFileBounded } from './filesystem.ts'
const FRONTMATTER_RE = /^---\n[\s\S]*?\n---\n?/

/** One indexed page. */
export interface SearchPage {
  readonly path: string
  readonly title: string
  readonly aliases: string[]
  readonly text: string
}

function parseAliases(raw: string): string[] {
  const value = /^aliases:\s*\[([^\]]*)\]\s*$/mu.exec(raw)?.[1]
  if (value === undefined) return []
  return value.split(',').map(item => item.trim().replace(/^["']|["']$/gu, '')).filter(Boolean)
}

/**
 * Collect all wiki pages with body text and frontmatter metadata stripped from the body.
 * @param wikiRoot - Absolute wiki directory to traverse.
 * @returns Search pages in traversal order.
 */
export function collectSearchPages(wikiRoot: string): SearchPage[] {
  const pages: SearchPage[] = []
  visitWikiTree(wikiRoot, {
    onMarkdown: ({ name, path, fullPath }) => {
      const raw = readRegularFileBounded(fullPath, MAX_WIKI_PAGE_BYTES).toString('utf8')
      let title = name.replace(/\.md$/u, '')
      for (const line of raw.split('\n')) {
        const field = parseFrontmatterField(line)
        if (field?.key === 'title' && field.value.trim() !== '') {
          title = field.value.trim().replace(/^["']|["']$/gu, '')
          break
        }
      }
      pages.push({ path, title, aliases: parseAliases(raw), text: raw.replace(FRONTMATTER_RE, '') })
    },
  })
  return pages
}

/** Tokenize text into lowercase word/bigram tokens (Chinese-aware).
 * @param text - Text to tokenize.
 * @returns Lowercase ASCII and CJK tokens.
 */
export function tokenize(text: string): string[] {
  const out: string[] = []
  const lower = text.toLowerCase()
  for (const match of lower.matchAll(/[a-z0-9][a-z0-9._-]{1,}/g)) out.push(match[0])
  for (const seg of lower.matchAll(/[\u4e00-\u9fff]+/g)) {
    const s = seg[0]
    if (s.length === 1) out.push(s)
    else {
      for (const character of s) out.push(character)
      for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2))
    }
  }
  return out
}

/** Stable English/Chinese query stop words shared by search and benchmarks. */
export const STOP_WORDS: ReadonlySet<string> = new Set([
  'the', 'and', 'or', 'for', 'with', 'not', 'all', 'one', 'can', 'will', 'when', 'what', 'your', 'our', 'you', 'this', 'that', 'are', 'was', 'have', 'has', 'had', 'from', 'into', 'about', 'which', 'would', 'could', 'should', 'there', 'their', 'they', 'them', 'then', 'than', 'just', 'but', 'use', 'used', 'using', 'make', 'made', 'get', 'got', 'like', 'want', 'need', 'please', 'help', 'how', 'why', 'where', 'who', 'also', 'very', 'more', 'most', 'some', 'any', 'each', 'only', 'other', 'such', 'well', 'back', 'down', 'over', 'under', 'again', 'still', 'even', 'ever', 'never', 'now', 'here', 'let', 'new', 'old', 'own', 'same', 'too', 'way', 'thing', 'things', 'something', 'anything', 'everything', 'nothing', 'someone', 'anyone', 'everyone', 'sure', 'right', 'good', 'bad', 'great', 'really', 'actually', 'maybe', 'yes', 'no', 'ok', 'okay', 'hi', 'hello',
  '知识', '文档', '文件', '这个', '什么', '怎么', '一个', '可以', '需要', '进行', '使用', '现在', '我们', '项目', '工作', '所有', '内容', '这样', '那个', '不是', '没有', '如果', '因为', '所以', '但是', '然后', '继续', '开始', '完成', '请问', '相关', '目前', '一下', '还有', '应该', '已经', '问题', '东西', '方面', '以及', '或者', '就是', '还是', '时候', '之后', '之前', '里面', '上面', '下面', '一些', '很多', '全部', '部分', '主要', '重要', '不同', '一样', '比较', '非常', '特别', '直接', '其实', '不过', '而且', '并且', '虽然', '但是', '由于', '因此', '同时', '另外', '此外', '其他', '其它', '通过', '根据', '按照', '对于', '关于', '包括', '包含', '属于', '来自', '作为', '成为', '变成', '产生', '出现', '存在', '提供', '支持', '帮助', '处理', '解决', '完成', '进行', '实现', '设计', '开发', '使用', '利用', '采用', '选择', '考虑', '需要', '要求', '希望', '想要', '可以', '能够', '可能', '应该', '必须', '一定', '因为', '所以', '结果', '效果', '影响', '情况', '状态', '方式', '方法', '过程', '阶段', '部分', '方面', '内容', '信息', '数据', '系统', '功能', '问题', '原因', '结论', '建议', '意见', '看法', '感觉', '知道', '看到', '听到', '想到', '觉得', '认为', '说明', '表示', '显示', '告诉', '询问', '回答', '回复',
])
const STOP = STOP_WORDS

const K1 = 1.5
const B = 0.75

interface ScoredPage {
  readonly page: SearchPage
  readonly score: number
}

interface IndexedPage {
  readonly page: SearchPage
  readonly tokenLength: number
  readonly frequencies: ReadonlyMap<string, number>
  readonly titleTokens: ReadonlySet<string>
}

/** Reusable, root-local BM25 data derived from the current Wiki page tree. */
export interface KnowledgeSearchIndex {
  readonly pages: readonly SearchPage[]
  readonly documents: readonly IndexedPage[]
  readonly docFreq: ReadonlyMap<string, number>
  readonly avgLen: number
}

/** Build the BM25 index used by searches over one unchanged page snapshot.
 * @param pages - Pages read from one Wiki root.
 * @returns Token frequencies and source pages for repeated queries.
 */
export function createKnowledgeSearchIndex(pages: readonly SearchPage[]): KnowledgeSearchIndex {
  const docFreq = new Map<string, number>()
  let totalTokenLength = 0
  const documents: IndexedPage[] = pages.map((page) => {
    const tokens = tokenize([page.title, ...page.aliases, page.text].join('\n'))
    const frequencies = new Map<string, number>()
    for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1)
    totalTokenLength += tokens.length
    for (const token of frequencies.keys()) docFreq.set(token, (docFreq.get(token) ?? 0) + 1)
    return {
      page,
      tokenLength: tokens.length,
      frequencies,
      titleTokens: new Set(tokenize([page.title, ...page.aliases].join('\n'))),
    }
  })
  const avgLen = totalTokenLength / Math.max(1, documents.length)
  return { pages, documents, docFreq, avgLen }
}

/** Score a query against an index without revisiting page text.
 * @param index - Prepared BM25 data.
 * @param query - Search terms.
 * @returns Ranked pages with positive scores.
 */
function scoreIndexedPages(index: KnowledgeSearchIndex, query: string): ScoredPage[] {
  const queryTokens = tokenize(query).filter(token => !STOP.has(token))
  if (queryTokens.length === 0) return []

  const scores = index.documents.map(({ page, tokenLength, frequencies, titleTokens }) => {
    let score = 0
    for (const q of queryTokens) {
      const df = index.docFreq.get(q) ?? 0
      if (df === 0) continue
      const idf = Math.log(1 + (index.pages.length - df + 0.5) / (df + 0.5))
      const tf = frequencies.get(q) ?? 0
      const norm = (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (tokenLength / index.avgLen)))
      score += idf * norm
    }
    // Title hits weigh double.
    for (const q of queryTokens) if (titleTokens.has(q)) score *= 1.5
    return { page, score }
  })
  return scores.filter(hit => hit.score > 0).sort((a, b) => b.score - a.score)
}

/** Score pages with BM25, preparing a one-use index for this query.
 * @param pages - Pages in traversal order.
 * @param query - Search terms.
 * @returns Ranked Wiki-relative paths and scores.
 */
export function bm25(pages: readonly SearchPage[], query: string): Array<{ path: string; score: number }> {
  return bm25FromKnowledgeSearchIndex(createKnowledgeSearchIndex(pages), query)
}

/** Score a prepared index for deterministic shadow comparison.
 * @param index - Prepared BM25 data.
 * @param query - Search terms.
 * @returns Ranked Wiki-relative paths and scores.
 */
export function bm25FromKnowledgeSearchIndex(
  index: KnowledgeSearchIndex,
  query: string,
): Array<{ path: string; score: number }> {
  return scoreIndexedPages(index, query).map(({ page, score }) => ({ path: page.path, score }))
}

/**
 * DashScope-compatible embedding for semantic search.
 * @param texts - input texts.
 * @param apiKey - DashScope API key (empty disables vector search).
 * @returns vectors aligned with texts, or null when unavailable.
 */
export async function embed(texts: string[], apiKey: string): Promise<number[][] | null> {
  if (!apiKey || texts.length === 0) return null
  const res = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'text-embedding-v3',
      input: texts.slice(0, 16),
    }),
  })
  if (!res.ok) throw new Error(`knowledge embedding request failed (${res.status})`)
  const body = await res.json() as { data?: unknown }
  if (!Array.isArray(body.data)) throw new Error('knowledge embedding response is malformed')
  const vectors = body.data.map((item: unknown) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return undefined
    return (item as { embedding?: unknown }).embedding
  })
  const dimension = Array.isArray(vectors[0]) ? vectors[0].length : 0
  const invalidVectors = dimension === 0 || vectors.some(vector =>
    !Array.isArray(vector)
    || vector.length !== dimension
    || vector.some(value => typeof value !== 'number' || !Number.isFinite(value)))
  if (invalidVectors) throw new Error('knowledge embedding response has invalid vectors')
  return vectors as number[][]
}

/**
 * Why semantic search was skipped for a query, when it was skipped.
 */
export interface EmbeddingUnavailable {
  /** Short, user-facing reason, such as `embedding request failed (401)`. */
  reason: string
}

/**
 * Cosine similarity between two vectors.
 * @param a - The a input.
 * @param b - The b input.
 * @returns The value produced by cosine.
 */
export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0)
    na += (a[i] ?? 0) * (a[i] ?? 0)
    nb += (b[i] ?? 0) * (b[i] ?? 0)
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/**
 * Hybrid search: BM25 scores blended with vector similarity when available.
 * @param wikiRoot - The wiki root input.
 * @param query - The query input.
 * @param apiKey - The api key input.
 * @param topK - The top k input.
 * @param unavailable - optional notification when embedding throws before falling back to keyword results.
 * @returns The value produced by hybrid search.
 */
export async function hybridSearch(
  wikiRoot: string,
  query: string,
  apiKey: string,
  topK: number,
  unavailable?: (diagnostic: EmbeddingUnavailable) => void,
): Promise<Array<{ path: string; score: number }>> {
  const index = createKnowledgeSearchIndex(collectSearchPages(wikiRoot))
  return hybridSearchFromKnowledgeSearchIndex(index, query, apiKey, topK, unavailable)
}

/** Hybrid search using a cached or caller-owned page index.
 * @param index - Prepared BM25 data.
 * @param query - Search terms.
 * @param apiKey - DashScope API key (empty disables vector search).
 * @param topK - Maximum number of results.
 * @param unavailable - Optional diagnostic for embedding fallback.
 * @returns Ranked Wiki-relative paths and scores.
 */
export async function hybridSearchFromKnowledgeSearchIndex(
  index: KnowledgeSearchIndex,
  query: string,
  apiKey: string,
  topK: number,
  unavailable?: (diagnostic: EmbeddingUnavailable) => void,
): Promise<Array<{ path: string; score: number }>> {
  const scoredPages = scoreIndexedPages(index, query)
  const keyword = scoredPages.map(({ page, score }) => ({ path: page.path, score }))
  if (!apiKey) return keyword.slice(0, topK)
  const topScoredPages = scoredPages.slice(0, 40)
  const topKeyword = keyword.slice(0, 40)

  let vector: number[][] | null
  try {
    vector = await embed(
      [query, ...topScoredPages.slice(0, 15).map(({ page }) => `${page.title}\n${page.text.slice(0, 600)}`)],
      apiKey,
    )
  } catch (error) {
    // Semantic search is optional: embed() still reports the failure (its own contract),
    // and the query degrades to keyword results instead of failing outright.
    unavailable?.({ reason: error instanceof Error ? error.message : String(error) })
    vector = null
  }

  if (!vector || vector.length < 2) {
    return keyword.slice(0, topK)
  }
  let queryVec: number[] = []
  const documentVectors: number[][] = []
  let firstVector = true
  for (const current of vector) {
    if (firstVector) {
      queryVec = current
      firstVector = false
    } else {
      documentVectors.push(current)
    }
  }
  const scores = new Map<string, number>()
  const maxVec = { score: 0 }
  topKeyword.slice(0, 15).forEach((hit, i) => {
    const sim = cosine(queryVec, documentVectors[i] ?? [])
    maxVec.score = Math.max(maxVec.score, sim)
    scores.set(hit.path, sim)
  })
  const maxKw = keyword.reduce((maximum, hit) => Math.max(maximum, hit.score), 0)
  return keyword.slice(0, topK).map((hit) => {
    const vecScore = scores.get(hit.path) ?? 0
    const normalizedVec = maxVec.score > 0 ? vecScore / maxVec.score : 0
    const blended = hit.score / maxKw * 0.7 + normalizedVec * 0.3
    return { path: hit.path, score: blended }
  }).sort((a, b) => b.score - a.score)
}
