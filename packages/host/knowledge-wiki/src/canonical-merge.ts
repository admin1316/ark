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

/** Frozen inputs for preparing exact canonical bytes without granting mutation authority. */
export interface CanonicalPreparationInput {
  readonly action: 'Promote' | 'Merge' | 'Replace' | 'Deduplicate'
  readonly candidateContent: string
  /** Already resolved wiki-relative target; this function does not resolve or read paths. */
  readonly targetPath: string
  /** Exact captured target bytes, or explicit absence for Promote. */
  readonly targetBefore: string | undefined
  readonly reviewedAt: string
  readonly actor: string
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
 * @param approvedBy - The review actor; existing callers default to governance-agent.
 * @returns The value produced by merge candidate into canonical.
 */
export function mergeCandidateIntoCanonical(
  canonicalContent: string,
  candidateContent: string,
  approvedAt: string,
  approvedBy = 'governance-agent',
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
    content: renderCanonical(preferred, canonical, candidate, approvedAt, approvedBy),
    mode,
  }
}

/**
 * Explicit human-approved replacement. The caller must archive the previous canonical first.
 * @param canonicalContent - The canonical content input.
 * @param candidateContent - The candidate content input.
 * @param approvedAt - The approved at input.
 * @param approvedBy - The review actor; existing callers default to governance-agent.
 * @returns The value produced by replace canonical with candidate.
 */
export function replaceCanonicalWithCandidate(
  canonicalContent: string,
  candidateContent: string,
  approvedAt: string,
  approvedBy = 'governance-agent',
): CanonicalMergeResult {
  const canonical = parsePage(canonicalContent)
  const candidate = parsePage(candidateContent)
  if (normalizeKnowledgeBody(candidate.body) === '') {
    throw new Error('candidate replacement refused: empty knowledge body')
  }
  return {
    content: renderCanonical(candidate, canonical, candidate, approvedAt, approvedBy),
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

/**
 * Prepare exact target bytes from captured inputs. Promote retains its day stamp;
 * updates retain their full timestamp except evidence pages, which retain the day restamp.
 * The result grants no review, trial, filesystem, journal, or promotion authority.
 * @param input - Frozen action, content, target prestate, timestamp, and actor.
 * @returns Exact targetAfter bytes for the existing action-specific transform.
 */
export function prepareCanonicalTarget(input: CanonicalPreparationInput): string {
  const { action, candidateContent, targetPath, targetBefore, reviewedAt, actor } = input
  const today = reviewedAt.slice(0, 10)
  if (action === 'Promote') {
    if (targetBefore !== undefined) throw new Error('canonical preparation requires an absent Promote target')
    return targetPath.startsWith('_evidence/')
      ? stampEvidence(candidateContent, today, actor)
      : stampCanonical(candidateContent, today, actor)
  }
  if (targetBefore === undefined) throw new Error('canonical preparation requires existing target bytes for an update')
  let next: CanonicalMergeResult
  switch (action) {
    case 'Merge':
      next = mergeCandidateIntoCanonical(targetBefore, candidateContent, reviewedAt, actor)
      break
    case 'Replace':
      next = replaceCanonicalWithCandidate(targetBefore, candidateContent, reviewedAt, actor)
      break
    case 'Deduplicate':
      next = deduplicateCandidateAgainstCanonical(targetBefore, candidateContent, reviewedAt, actor)
      break
    default:
      return assertNever(action)
  }
  return targetPath.startsWith('_evidence/') ? stampEvidence(next.content, today, actor) : next.content
}

function assertNever(action: never): never {
  throw new Error(`unsupported canonical preparation action: ${String(action)}`)
}

function stampCanonical(content: string, today: string, approvedBy: string): string {
  let output = content
  if (/^status:\s*/mu.test(output)) output = output.replace(/^status:\s*.*$/mu, 'status: canonical')
  else output = output.replace(/^---\n/u, '---\nstatus: canonical\n')
  output = output.replace(/^approved_at:\s*.*\n?/mu, '')
  output = output.replace(/^approved_by:\s*.*\n?/mu, '')
  return output.replace(/^---\n/u, `---\napproved_at: ${today}\napproved_by: ${approvedBy}\n`)
}

function stampEvidence(content: string, today: string, approvedBy: string): string {
  return stampCanonical(content, today, approvedBy).replace(/^status:\s*canonical$/mu, 'status: evidence')
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
