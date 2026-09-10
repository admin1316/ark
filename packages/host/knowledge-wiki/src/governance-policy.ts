/** Autonomous, deterministic policy for Candidate disposition. */

import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync } from 'node:fs'
import { basename, join, posix, relative, resolve, win32 } from 'node:path'
import { mergeCandidateIntoCanonical } from './canonical-merge.ts'
import { readRegularFileBounded } from './filesystem.ts'

/**
 * Defines the governance action type used by this package.
 */
export type GovernanceAction = 'Promote' | 'Merge' | 'Deduplicate' | 'Archive' | 'Hold'

/**
 * Describes the governance decision value used by this package.
 */
export interface GovernanceDecision {
  action: GovernanceAction
  confidence: number
  score: number
  reasons: string[]
  claimFingerprint: string
  targetPath?: string
}

/** Directories that contain visible Canonical knowledge. */
export const CANONICAL_WIKI_DIRECTORIES = Object.freeze([
  'concepts', 'entities', 'findings', 'research', 'methodology',
])
const POLICY_VERSION = 'wiki-governance-v3'

/** One validated Wiki-root-relative path and its absolute filesystem target. */
export interface GovernedWikiPath {
  readonly relativePath: string
  readonly absolutePath: string
}

/**
 * Resolve one durable Wiki-relative path without repairing unsafe input.
 * @param root - absolute Wiki root that owns the path.
 * @param input - persisted POSIX-style path relative to the Wiki root.
 * @param allowMissing - whether a missing suffix is valid for a future create.
 * @returns the normalized relative/absolute pair, or undefined when unsafe or absent.
 */
export function resolveGovernedWikiPath(
  root: string,
  input: string,
  allowMissing: boolean,
): GovernedWikiPath | undefined {
  if (input === '' || input.includes('\0') || input.includes('\\') || posix.isAbsolute(input) || win32.isAbsolute(input)) {
    return undefined
  }
  const parts = input.split('/')
  if (parts.some(part => part === '' || part === '.' || part === '..')) return undefined
  const relativePath = parts.join('/')
  const base = resolve(root)
  const absolutePath = join(base, ...parts)
  let cursor = base
  for (const part of parts) {
    cursor = join(cursor, part)
    try {
      if (lstatSync(cursor).isSymbolicLink()) return undefined
    } catch (error) {
      if (!isMissingPathError(error)) throw error
      if (allowMissing) break
      return undefined
    }
  }
  return { relativePath, absolutePath }
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT'
}

/**
 * Provides the governance policy version operation.
 * @returns The value produced by governance policy version.
 */
export function governancePolicyVersion(): string {
  return POLICY_VERSION
}

/**
 * Provides the decide candidate governance operation.
 * @param wikiRoot - The wiki root input.
 * @param candidatePath - The candidate path input.
 * @param content - The content input.
 * @param suggestedTarget - The suggested target input.
 * @returns The value produced by decide candidate governance.
 */
export function decideCandidateGovernance(
  wikiRoot: string,
  candidatePath: string,
  content: string,
  suggestedTarget?: string,
): GovernanceDecision {
  const body = extractBody(content)
  const title = extractTitle(content, candidatePath)
  const normalized = normalize(body)
  const fingerprint = createHash('sha256').update(normalized).digest('hex')
  const quality = scoreQuality(candidatePath, title, body, content)
  const governedTarget = suggestedTarget === undefined
    ? undefined
    : resolveGovernedWikiPath(wikiRoot, suggestedTarget, true)
  const safeTarget = governedTarget?.relativePath

  if (quality.hardReject) {
    return decision('Archive', 0.99, quality.score, quality.reasons, fingerprint, safeTarget)
  }

  if (governedTarget !== undefined && existsSync(governedTarget.absolutePath)) {
    const canonical = readRegularFileBounded(governedTarget.absolutePath, 5 * 1024 * 1024).toString('utf8')
    const similarity = bodySimilarity(extractBody(canonical), body)
    if (similarity >= 0.82) {
      return decision('Deduplicate', similarity, quality.score, ['same target and high content overlap'], fingerprint, safeTarget)
    }
    if (!quality.autoEligible) {
      return decision('Hold', 0.98, quality.score, [...quality.reasons, 'candidate is not eligible to change canonical knowledge'], fingerprint, safeTarget)
    }
    try {
      mergeCandidateIntoCanonical(canonical, content, new Date().toISOString())
      return decision('Merge', 0.99, quality.score, ['same canonical target; deterministic merge is safe'], fingerprint, safeTarget)
    } catch {
      return decision('Hold', 1 - similarity, quality.score, ['same target but bodies diverge'], fingerprint, safeTarget)
    }
  }

  const match = findCanonicalMatch(wikiRoot, title, body)
  if (match !== undefined && match.similarity >= 0.82) {
    return decision('Deduplicate', match.similarity, quality.score, ['high-overlap canonical page already exists'], fingerprint, match.path)
  }

  if (safeTarget !== undefined && quality.autoEligible && quality.score >= 8) {
    return decision('Promote', Math.min(0.98, 0.72 + quality.score * 0.026), quality.score, quality.reasons, fingerprint, safeTarget)
  }
  if (quality.score <= 2) {
    return decision('Archive', 0.92, quality.score, quality.reasons, fingerprint, safeTarget)
  }
  return decision('Hold', 0.6, quality.score, [...quality.reasons, 'insufficient confidence for autonomous disposition'], fingerprint, safeTarget)
}

function decision(
  action: GovernanceAction,
  confidence: number,
  score: number,
  reasons: string[],
  claimFingerprint: string,
  targetPath?: string,
): GovernanceDecision {
  return { action, confidence, score, reasons, claimFingerprint, ...(targetPath ? { targetPath } : {}) }
}

function scoreQuality(candidatePath: string, title: string, body: string, content: string): {
  score: number
  reasons: string[]
  hardReject: boolean
  autoEligible: boolean
} {
  const reasons: string[] = []
  const compact = normalize(body)
  const sources = /^sources:\s*\[([^\]]*)\]/mu.exec(content)?.[1]?.trim() ?? ''
  const sourceList = parseSources(sources)
  const independentSources = sourceList.filter(isIndependentSource)
  const hasSource = sourceList.length > 0
  const hasIndependentSource = independentSources.length > 0
  const conversationOnlySource = hasSource && !hasIndependentSource
  const shortCommand = /^(继续|开始|看看|修好了吗|完成了吗|可以了吗|然后呢|你固定了吗|再试试)[？?!！。.]*$/u.test(title.trim())
  const pastedPlaceholder = /pasted[-_ ]image[-_ ]available|\[pasted image\]/iu.test(`${title}\n${body}`)
  const sessionQuestion = candidatePath.startsWith('_candidates/sessions/')
    && /^(请|你|我们|是不是|为什么|怎么|如何)|[？?]$/u.test(title.trim())
  const incidentCandidate = candidatePath.startsWith('_candidates/incidents/')
    || /^candidate_kind:\s*incident\s*$/mu.test(content)
  const reflectionCandidate = candidatePath.startsWith('_candidates/reflections/')
    || /^candidate_kind:\s*reflection\s*$/mu.test(content)
  const epistemicStatus = /^epistemic_status:\s*(\S+)\s*$/mu.exec(content)?.[1] ?? ''
  const independentSourceCount = Number(/^independent_source_count:\s*(\d+)\s*$/mu.exec(content)?.[1] ?? 0)
  const reflectionComplete = !reflectionCandidate || [
    '失败模式', '根因假设', '反事实做法', '防复发动作', '适用条件',
  ].every(heading => new RegExp(`^##\\s+${heading}\\s*$`, 'mu').test(body))
  const durableSignal = /(原则|方法|流程|规范|约束|决策|根因|适用条件|验证证据|风险|回滚|不变量|验收|边界|例外)/u.test(body)
  const applicability = /(适用|不适用|前提|条件|限制|边界|例外|触发|when|unless|prerequisite|limitation)/iu.test(body)
  const actionable = /(步骤|流程|门禁|检查|验证|回滚|输入|输出|操作|执行器|验收)/u.test(body)
  const connected = /^related:\s*\[[^\]]+\]/mu.test(content) || /\[\[[^\]]+\]\]/u.test(body)
  const processMatches = body.match(
    /(使用工具|\bbash\b|\bread\b|\bedit\b|git:\s|tarball|编译打包|运行时.*同步|全部完成|API Error|Cogitated)/giu,
  )?.length ?? 0
  const transcriptPollution = /(本轮输入|本轮结论|本页由「对话自动沉淀」|Thought for \d+s|Ran \d+ shell command)/iu.test(body)
  const unstableHistory = /(\/Users\/|node_modules\/|git:\s*[0-9a-f]{7,40}|\b[0-9a-f]{7,40}\b|tarball:|运行时.*同步)/iu.test(body)
  const assistantClaim = /(已修复|修复完成|部署完成|全部完成|固化完成)/u.test(body)
  const verification = /(测试通过|复现通过|验收通过|实际请求|运行时证据|验证证据|回滚点)/u.test(body)

  if (shortCommand) reasons.push('title is a conversational command')
  if (pastedPlaceholder) reasons.push('pasted-image placeholder')
  if (incidentCandidate) reasons.push('incident history belongs in Evidence or Archive, not Canonical')
  if (reflectionCandidate && !reflectionComplete) reasons.push('reflection is missing failure, cause, counterfactual, prevention, or applicability')
  if (reflectionCandidate && epistemicStatus !== 'verified') reasons.push('reflection remains a hypothesis until independently verified')
  if (reflectionCandidate && independentSourceCount < 2) reasons.push('reflection has fewer than two independent sources')
  if (compact.length < 120) reasons.push('knowledge body is too short')
  if (!hasSource) reasons.push('candidate has no source evidence')
  if (!hasIndependentSource) reasons.push(hasSource ? 'session or workspace context is not independent evidence' : 'candidate has no independent source evidence')
  if (sessionQuestion && !durableSignal) reasons.push('generic session Q&A without durable project knowledge')
  if (transcriptPollution) reasons.push('conversation transcript markers remain in the body')
  if (processMatches >= 3) reasons.push('tool and progress log pollution')
  if (unstableHistory) reasons.push('local path, build artifact, or revision detail is not stable knowledge')
  if (assistantClaim && !verification) reasons.push('assistant completion claim has no independent verification')

  const hardReject = shortCommand
    || pastedPlaceholder
    || incidentCandidate
    || (reflectionCandidate && !reflectionComplete)
    || compact.length < 80
    || (sessionQuestion && !durableSignal)
    || (transcriptPollution && processMatches >= 2)
    || processMatches >= 5
    || (assistantClaim && !verification && processMatches >= 2)
  if (hardReject) return { score: 0, reasons, hardReject, autoEligible: false }

  let score = 0
  if (compact.length >= 180 && compact.length <= 12_000) score += 1
  if (hasIndependentSource) score += 2
  if (durableSignal) score += 2
  if (/^#{2,3}\s+|^\s*[-*]\s+|^\s*\d+[.]\s+/mu.test(body)) score += 1
  if (title.length >= 4 && title.length <= 48 && !sessionQuestion) score += 1
  if (verification) score += 1
  if (applicability || actionable) score += 1
  if (connected) score += 1
  if (processMatches >= 2) score -= 2
  if (transcriptPollution) score -= 3
  if (unstableHistory) score -= 2
  if (assistantClaim && !verification) score -= 2
  score = Math.max(0, Math.min(10, score))
  const autoEligible = score >= 8
    && hasSource
    && hasIndependentSource
    && durableSignal
    && (verification || actionable)
    && !transcriptPollution
    && !unstableHistory
    && processMatches < 2
    && epistemicStatus !== 'hypothesis'
    && !conversationOnlySource
    && (!reflectionCandidate || (epistemicStatus === 'verified' && independentSourceCount >= 2 && independentSources.length >= 2 && verification))
  if (!autoEligible) reasons.push('candidate remains in review because one or more canonical admission gates failed')
  reasons.push(`deterministic quality score ${score}/10`)
  return { score, reasons, hardReject: false, autoEligible }
}

function parseSources(value: string): string[] {
  return value.split(',').map(item => item.trim().replace(/^["']|["']$/gu, '')).filter(Boolean)
}

function isIndependentSource(source: string): boolean {
  return !/(?:^|[/.:_-])(?:session|conversation|chat)(?:$|[/.:_-])|ark-sessions\//iu.test(source)
    && !/^(?:workspace|generated|auto):/iu.test(source)
}

function findCanonicalMatch(wikiRoot: string, candidateTitle: string, candidateBody: string): {
  path: string
  similarity: number
} | undefined {
  let best: { path: string; similarity: number } | undefined
  for (const dirName of CANONICAL_WIKI_DIRECTORIES) {
    const root = resolveGovernedWikiPath(wikiRoot, dirName, false)
    if (root === undefined) continue
    for (const full of markdownFiles(root.absolutePath)) {
      const content = readRegularFileBounded(full, 5 * 1024 * 1024).toString('utf8')
      const titleScore = ngramSimilarity(candidateTitle, extractTitle(content, basename(full)))
      const bodyScore = bodySimilarity(candidateBody, extractBody(content))
      const similarity = Math.max(bodyScore, titleScore * 0.45 + bodyScore * 0.55)
      if (best === undefined || similarity > best.similarity) {
        best = { path: relative(wikiRoot, full), similarity }
      }
    }
  }
  return best
}

function markdownFiles(root: string): string[] {
  const output: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name)
    if (entry.isDirectory()) output.push(...markdownFiles(full))
    else if (entry.isFile() && entry.name.endsWith('.md')) output.push(full)
  }
  return output
}

function extractTitle(content: string, fallback: string): string {
  return (/^title:\s*(.+)$/mu.exec(content)?.[1] ?? /^#\s+(.+)$/mu.exec(content)?.[1] ?? fallback)
    .trim()
    .replace(/^["']|["']$/gu, '')
}

function extractBody(content: string): string {
  return content.replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/u, '').trim()
}

function bodySimilarity(left: string, right: string): number {
  const a = normalize(left)
  const b = normalize(right)
  if (a === '' || b === '') return 0
  if (a === b) return 1
  if (a.includes(b) || b.includes(a)) return Math.min(a.length, b.length) / Math.max(a.length, b.length)
  return ngramSimilarity(a, b, 3)
}

function ngramSimilarity(left: string, right: string, size = 2): number {
  const a = ngrams(normalize(left), size)
  const b = ngrams(normalize(right), size)
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const item of a) if (b.has(item)) intersection += 1
  return intersection / (a.size + b.size - intersection)
}

function ngrams(value: string, size: number): Set<string> {
  const output = new Set<string>()
  for (let i = 0; i <= value.length - size; i += 1) output.add(value.slice(i, i + size))
  return output
}

function normalize(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/^#\s+.*$/gmu, '')
    .replace(/^>\s*本页由.*$/gmu, '')
    .replace(/[`*_#>\-\s，。！？、；：,.!?;:'"“”‘’（）()\[\]{}]/gu, '')
    .toLowerCase()
}
