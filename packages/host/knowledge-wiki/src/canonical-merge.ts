/**
 * Deterministic Candidate -> Canonical merge policy.
 *
 * The LLM may propose a merge, but this module only auto-merges exact
 * duplicates and strict body supersets. Divergent bodies require a separately
 * reviewed merged candidate.
 */

import {
  formatFrontmatterArray,
  parseFrontmatterArray,
  parseFrontmatterBlock,
  parseFrontmatterField,
} from './frontmatter-utils.ts'

interface ParsedPage {
  fields: Map<string, string>
  body: string
}

/**
 * Describes the canonical merge result value used by this package.
 */
export interface CanonicalMergeResult {
  content: string
  mode: 'duplicate' | 'canonical-superset' | 'candidate-superset' | 'replace'
}

const CANDIDATE_ONLY_FIELDS = new Set([
  'candidate_id',
  'candidate_kind',
  'candidate_hash',
  'origin',
  'resolution_status',
  'review_status',
])

/**
 * Merge only exact duplicates or strict body supersets.
 * @param canonicalContent - The canonical content input.
 * @param candidateContent - The candidate content input.
 * @param approvedAt - The approved at input.
 * @returns The value produced by merge candidate into canonical.
 */
export function mergeCandidateIntoCanonical(
  canonicalContent: string,
  candidateContent: string,
  approvedAt: string,
): CanonicalMergeResult {
  const canonical = parsePage(canonicalContent)
  const candidate = parsePage(candidateContent)
  const canonicalKey = normalizeKnowledgeBody(canonical.body)
  const candidateKey = normalizeKnowledgeBody(candidate.body)
  if (canonicalKey === '' || candidateKey === '') {
    throw new Error('candidate merge refused: empty knowledge body')
  }

  let preferred = canonical
  let mode: CanonicalMergeResult['mode'] = 'duplicate'
  if (canonicalKey === candidateKey) {
    mode = 'duplicate'
  } else if (canonicalKey.includes(candidateKey)) {
    mode = 'canonical-superset'
  } else if (candidateKey.includes(canonicalKey)) {
    preferred = candidate
    mode = 'candidate-superset'
  } else {
    throw new Error('candidate merge refused: bodies diverge; create a reviewed merged candidate')
  }

  return {
    content: renderCanonical(preferred, canonical, candidate, approvedAt),
    mode,
  }
}

/**
 * Explicit human-approved replacement. The caller must archive the previous canonical first.
 * @param canonicalContent - The canonical content input.
 * @param candidateContent - The candidate content input.
 * @param approvedAt - The approved at input.
 * @returns The value produced by replace canonical with candidate.
 */
export function replaceCanonicalWithCandidate(
  canonicalContent: string,
  candidateContent: string,
  approvedAt: string,
): CanonicalMergeResult {
  const canonical = parsePage(canonicalContent)
  const candidate = parsePage(candidateContent)
  if (normalizeKnowledgeBody(candidate.body) === '') {
    throw new Error('candidate replacement refused: empty knowledge body')
  }
  return {
    content: renderCanonical(candidate, canonical, candidate, approvedAt, 'governance-agent'),
    mode: 'replace',
  }
}

/**
 * Keep the canonical body and merge only provenance from a semantic duplicate.
 * @param canonicalContent - The canonical content input.
 * @param candidateContent - The candidate content input.
 * @param approvedAt - The approved at input.
 * @param approvedBy - The approved by input.
 * @returns The value produced by deduplicate candidate against canonical.
 */
export function deduplicateCandidateAgainstCanonical(
  canonicalContent: string,
  candidateContent: string,
  approvedAt: string,
  approvedBy = 'governance-agent',
): CanonicalMergeResult {
  const canonical = parsePage(canonicalContent)
  const candidate = parsePage(candidateContent)
  return {
    content: renderCanonical(canonical, canonical, candidate, approvedAt, approvedBy),
    mode: 'duplicate',
  }
}

function parsePage(content: string): ParsedPage {
  const block = parseFrontmatterBlock(content)
  if (block === null) throw new Error('candidate merge refused: missing frontmatter')
  const fields = new Map<string, string>()
  for (const line of block.body.split(/\r?\n/u)) {
    const field = parseFrontmatterField(line)
    if (field === null) continue
    fields.set(field.key, field.value)
  }
  return { fields, body: block.rest.trim() }
}

function renderCanonical(
  preferred: ParsedPage,
  previousCanonical: ParsedPage,
  candidate: ParsedPage,
  approvedAt: string,
  approvedBy = 'governance-agent',
): string {
  const fields = new Map(preferred.fields)
  for (const key of CANDIDATE_ONLY_FIELDS) fields.delete(key)

  const previousCreated = previousCanonical.fields.get('created')
  const allSources = [...readSources(previousCanonical), ...readSources(candidate)]
  fields.set('status', 'canonical')
  fields.set('approved_at', approvedAt)
  fields.set('approved_by', approvedBy)
  fields.set('updated', approvedAt.slice(0, 10))
  fields.set('sources', formatFrontmatterArray([...new Set(allSources)]))
  if (previousCreated !== undefined) fields.set('created', previousCreated)

  const frontmatter = [...fields]
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n')
  return `---\n${frontmatter}\n---\n\n${preferred.body.trim()}\n`
}

function readSources(page: ParsedPage): string[] {
  const raw = page.fields.get('sources')
  return raw === undefined ? [] : parseFrontmatterArray(raw)
}

function normalizeKnowledgeBody(body: string): string {
  return body
    .normalize('NFKC')
    .replace(/^#\s+.*$/gmu, '')
    .replace(/^>\s*本页由.*$/gmu, '')
    .replace(/[`*_#>\-\s，。！？、；：,.!?;:'"“”‘’（）()\[\]{}]/gu, '')
    .toLowerCase()
}
