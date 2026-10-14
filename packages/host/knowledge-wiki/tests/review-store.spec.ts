import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { encodeReviewStore, readReviewStore, REVIEW_STORE_MAX_BYTES, writeReviewStore } from '../src/review-store.ts'
import { appendCandidateReviews, commitReviewAppend, prepareReviewAppend } from '../src/reviews.ts'

const dirs: string[] = []
const inspectionFault = vi.hoisted(() => ({ path: '', calls: 0 }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    lstatSync: (...args: Parameters<typeof actual.lstatSync>) => {
      if (String(args[0]) === inspectionFault.path) {
        inspectionFault.calls += 1
        throw Object.assign(new Error('ENAMETOOLONG: candidate path inspection failed'), { code: 'ENAMETOOLONG' })
      }
      return actual.lstatSync(...args)
    },
  }
})

function fixture(): string {
  const path = mkdtempSync(join(tmpdir(), 'wiki-review-store-'))
  dirs.push(path)
  return path
}

function exactLimitItem(padding = ''): { readonly id: string; readonly title: string; readonly resolved: boolean; readonly padding: string } {
  return { id: 'review-exact', title: 'Review', resolved: false, padding }
}

afterEach(() => {
  inspectionFault.path = ''
  inspectionFault.calls = 0
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('review store encoding', () => {
  it('writes and reads an exactly 8 MiB UTF-8 JSON array', () => {
    const path = fixture()
    const reviewFile = join(path, 'review.json')
    let low = 0
    let high = REVIEW_STORE_MAX_BYTES
    while (low < high) {
      const mid = Math.ceil((low + high) / 2)
      const text = `${JSON.stringify([exactLimitItem('x'.repeat(mid))], null, 2)}\n`
      if (Buffer.byteLength(text, 'utf8') <= REVIEW_STORE_MAX_BYTES) low = mid
      else high = mid - 1
    }
    const encoded = encodeReviewStore([exactLimitItem('x'.repeat(low))])
    expect(Buffer.byteLength(encoded, 'utf8')).toBe(REVIEW_STORE_MAX_BYTES)
    writeReviewStore(reviewFile, encoded)
    expect(readReviewStore(reviewFile)?.toString('utf8')).toBe(encoded)
  })

  it('counts JSON escaping and multibyte UTF-8 bytes before accepting output', () => {
    const escaped = encodeReviewStore([exactLimitItem('"\\'.repeat(100))])
    expect(escaped).toContain('"padding": "\\\"\\\\')
    const unicode = encodeReviewStore([exactLimitItem('界'.repeat(100))])
    expect(Buffer.byteLength(unicode, 'utf8')).toBeGreaterThan(unicode.length)
  })

  it('rejects over-limit output before replacing existing bytes', () => {
    const path = fixture()
    const reviewFile = join(path, 'review.json')
    writeFileSync(reviewFile, '[{"id":"old"}]\n')
    expect(() => encodeReviewStore([exactLimitItem('x'.repeat(REVIEW_STORE_MAX_BYTES))])).toThrow('review store exceeds')
    expect(readFileSync(reviewFile, 'utf8')).toBe('[{"id":"old"}]\n')
  })

  it('preserves absence and refuses an oversized file read', () => {
    const path = fixture()
    const reviewFile = join(path, 'review.json')
    expect(readReviewStore(reviewFile)).toBeUndefined()
    writeFileSync(reviewFile, Buffer.alloc(REVIEW_STORE_MAX_BYTES + 1, 0x20))
    expect(() => readReviewStore(reviewFile)).toThrow(`file exceeds ${REVIEW_STORE_MAX_BYTES} bytes`)
  })

  it('treats a missing review file as an empty store and refuses malformed persisted rows without replacing them', () => {
    const root = fixture()
    const reviewFile = join(root, '.llm-wiki', 'review.json')
    const candidatePath = '_candidates/ingest/valid.md'
    const candidate = join(root, 'wiki', candidatePath)
    mkdirSync(dirname(candidate), { recursive: true })
    writeFileSync(candidate, '---\ntitle: Valid\nstatus: candidate\n---\n\nA durable candidate page with enough substance to be reviewed.\n')

    expect(appendCandidateReviews(reviewFile, root, undefined, [`wiki/${candidatePath}`])).toBe(1)
    const validBytes = readFileSync(reviewFile, 'utf8')
    writeFileSync(reviewFile, '[{}]\n')
    expect(() => appendCandidateReviews(reviewFile, root, undefined, [`wiki/${candidatePath}`]))
      .toThrow('invalid knowledge review state')
    expect(readFileSync(reviewFile, 'utf8')).toBe('[{}]\n')
    expect(validBytes).toContain('candidate-')
  })

  it('rejects source changes and actual unplanned candidate paths before changing the review store', () => {
    const root = fixture()
    const wikiRoot = join(root, 'wiki')
    const reviewFile = join(root, '.llm-wiki', 'review.json')
    const candidatePath = '_candidates/ingest/bound.md'
    const candidateFull = join(wikiRoot, candidatePath)
    const sourceFull = join(root, 'raw', 'source.md')
    const content = '---\ntitle: Bound\nstatus: candidate\n---\n\nA reviewed candidate page with stable source evidence.\n'
    mkdirSync(dirname(candidateFull), { recursive: true })
    mkdirSync(dirname(sourceFull), { recursive: true })
    writeFileSync(candidateFull, content)
    writeFileSync(sourceFull, 'original source bytes')

    const changedSourcePlan = prepareReviewAppend(reviewFile, root, 'raw/source.md', [], [{ path: `wiki/${candidatePath}`, content }])
    writeFileSync(sourceFull, 'changed source bytes')
    expect(() => commitReviewAppend(changedSourcePlan)).toThrow('candidate or source changed after review append preflight')
    expect(existsSync(reviewFile)).toBe(false)

    const secondPath = '_candidates/ingest/unplanned.md'
    const secondFull = join(wikiRoot, secondPath)
    const secondContent = '---\ntitle: Unplanned\nstatus: candidate\n---\n\nAnother independently valid candidate body.\n'
    writeFileSync(secondFull, secondContent)
    const unplannedPlan = prepareReviewAppend(reviewFile, root, undefined, [], [{ path: `wiki/${candidatePath}`, content }])
    expect(() => commitReviewAppend(unplannedPlan, [`wiki/${secondPath}`]))
      .toThrow('candidate path was not included in review append preflight')
    expect(existsSync(reviewFile)).toBe(false)
  })

  it('preserves legacy duplicate ids and updates only the first matching row', () => {
    const root = fixture()
    const reviewFile = join(root, '.llm-wiki', 'review.json')
    const candidatePath = '_candidates/ingest/duplicate.md'
    const candidateFull = join(root, 'wiki', candidatePath)
    const candidateId = `candidate-${createHash('sha256').update(candidatePath).digest('hex').slice(0, 16)}`
    const legacy = [
      { id: candidateId, title: 'First legacy row', type: 'candidate-approval', resolved: true, marker: 'first' },
      { id: candidateId, title: 'Second legacy row', type: 'candidate-approval', resolved: false, marker: 'second', longTail: 'retained' },
    ]
    mkdirSync(dirname(reviewFile), { recursive: true })
    writeFileSync(reviewFile, `${JSON.stringify(legacy, null, 2)}\n`)
    mkdirSync(dirname(candidateFull), { recursive: true })
    const content = '---\ntitle: Duplicate\nstatus: candidate\n---\n\nA valid candidate body replacing the first legacy row.\n'
    writeFileSync(candidateFull, content)

    expect(appendCandidateReviews(reviewFile, root, undefined, [`wiki/${candidatePath}`])).toBe(1)
    const rows = JSON.parse(readFileSync(reviewFile, 'utf8')) as Array<Record<string, unknown>>
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ id: candidateId, candidateHash: requireCandidateHash(content) })
    expect(rows[1]).toEqual(legacy[1])
  })

  it('includes every legacy duplicate row in the complete projection byte bound', () => {
    const root = fixture()
    const reviewFile = join(root, '.llm-wiki', 'review.json')
    const candidatePath = '_candidates/ingest/duplicate-cap.md'
    const candidate = join(root, 'wiki', candidatePath)
    mkdirSync(dirname(reviewFile), { recursive: true })
    mkdirSync(dirname(candidate), { recursive: true })
    const tail = 'x'.repeat(REVIEW_STORE_MAX_BYTES - 500)
    const duplicateRows = [
      { id: 'legacy-duplicate', title: 'first', type: 'suggestion', resolved: false },
      { id: 'legacy-duplicate', title: tail, type: 'suggestion', resolved: false },
    ]
    const before = encodeReviewStore(duplicateRows)
    expect(Buffer.byteLength(before, 'utf8')).toBeLessThan(REVIEW_STORE_MAX_BYTES)
    writeFileSync(reviewFile, before)
    const candidateContent = '---\ntitle: Candidate\nstatus: candidate\n---\n\nA small new candidate row pushes the complete duplicate-preserving projection over the cap.\n'
    expect(() => prepareReviewAppend(reviewFile, root, undefined, [], [{
      path: `wiki/${candidatePath}`, content: candidateContent,
    }])).toThrow('review store exceeds')
    expect(readFileSync(reviewFile, 'utf8')).toBe(before)
    expect(existsSync(candidate)).toBe(false)
  })

  it('refuses an invalid opaque append plan without writing', () => {
    const root = fixture()
    const reviewFile = join(root, '.llm-wiki', 'review.json')
    expect(() => commitReviewAppend({} as Parameters<typeof commitReviewAppend>[0])).toThrow('invalid review append plan')
    expect(existsSync(reviewFile)).toBe(false)
  })

  it('propagates an overlong candidate path inspection failure before publishing', () => {
    const root = fixture()
    const reviewFile = join(root, '.llm-wiki', 'review.json')
    const overlongComponent = 'x'.repeat(300)
    mkdirSync(join(root, 'wiki', '_candidates'), { recursive: true })
    inspectionFault.path = join(root, 'wiki', '_candidates', overlongComponent)
    expect(() => prepareReviewAppend(reviewFile, root, undefined, [], [{
      path: `wiki/_candidates/${overlongComponent}/page.md`,
      content: '---\ntitle: Blocked\nstatus: candidate\n---\n\nPath inspection must propagate a real filesystem error.\n',
    }])).toThrow('ENAMETOOLONG: candidate path inspection failed')
    expect(inspectionFault.calls).toBe(1)
    expect(existsSync(reviewFile)).toBe(false)
  })

  it('preserves distinct advisory source metadata and registers the actual longest same-path variant', () => {
    const root = fixture()
    const reviewFile = join(root, '.llm-wiki', 'review.json')
    const candidatePath = '_candidates/ingest/variant-longest.md'
    const candidateFull = join(root, 'wiki', candidatePath)
    const preferred = '---\ntitle: Short\nstatus: candidate\n---\n\nA candidate variant.\n'
    const longestTitle = 'Long fallback '.repeat(80).trimEnd()
    const fallback = `---\ntitle: ${longestTitle}\nstatus: candidate\n---\n\nA deterministic fallback variant.\n`
    const advisory = {
      type: 'suggestion', title: 'Advisory', description: 'A generated review.',
      affectedPages: [], searchQueries: [],
    }
    const plan = prepareReviewAppend(
      reviewFile,
      root,
      'raw/source-relative.md',
      [advisory],
      [
        { path: `wiki/${candidatePath}`, content: preferred },
        { path: `wiki/${candidatePath}`, content: fallback },
      ],
      join(root, 'raw', 'source-absolute.md'),
    )
    mkdirSync(dirname(candidateFull), { recursive: true })
    writeFileSync(candidateFull, fallback)
    expect(commitReviewAppend(plan)).toMatchObject({ advisoryAppended: 1, candidateAppended: 1 })
    const rows = JSON.parse(readFileSync(reviewFile, 'utf8')) as Array<{ title: string; sourcePath?: string; reviewKind?: string }>
    expect(rows.find(row => row.reviewKind === 'advisory')?.sourcePath).toBe(join(root, 'raw', 'source-absolute.md'))
    expect(rows.find(row => row.reviewKind === 'candidate')?.title).toBe(longestTitle)
    expect(rows.find(row => row.reviewKind === 'candidate')?.sourcePath).toBe('raw/source-relative.md')
  })

  it('omits advisory source metadata when an advisory has no source provenance', () => {
    const root = fixture()
    const reviewFile = join(root, '.llm-wiki', 'review.json')
    const advisory = {
      type: 'suggestion', title: 'Unattributed advisory', description: 'A review without source provenance.',
      affectedPages: [], searchQueries: [],
    }

    const plan = prepareReviewAppend(reviewFile, root, undefined, [advisory], [])
    expect(commitReviewAppend(plan)).toMatchObject({ advisoryAppended: 1, candidateAppended: 0 })
    const rows = JSON.parse(readFileSync(reviewFile, 'utf8')) as Array<Record<string, unknown>>
    const row = rows[0]
    expect(row?.reviewKind).toBe('advisory')
    expect(row && Object.hasOwn(row, 'sourcePath')).toBe(false)
  })

  it('deduplicates repeated identical candidate variants when re-reviewing a resolved legacy row', () => {
    const root = fixture()
    const reviewFile = join(root, '.llm-wiki', 'review.json')
    const candidatePath = '_candidates/ingest/re-review-identical.md'
    const candidateFull = join(root, 'wiki', candidatePath)
    const id = `candidate-${createHash('sha256').update(candidatePath).digest('hex').slice(0, 16)}`
    const content = '---\ntitle: Re-review\nstatus: candidate\n---\n\nThe same valid candidate is registered twice after its previous review was resolved.\n'
    const oldRow = {
      id, title: 'Previously resolved', type: 'candidate-approval', resolved: true,
      candidateHash: requireCandidateHash(content), marker: 'legacy-resolution',
    }
    mkdirSync(dirname(reviewFile), { recursive: true })
    writeFileSync(reviewFile, `${JSON.stringify([oldRow], null, 2)}\n`)

    const input = { path: `wiki/${candidatePath}`, content }
    const plan = prepareReviewAppend(reviewFile, root, undefined, [], [input, input])
    mkdirSync(dirname(candidateFull), { recursive: true })
    writeFileSync(candidateFull, content)
    expect(commitReviewAppend(plan).candidateAppended).toBe(1)

    const rows = JSON.parse(readFileSync(reviewFile, 'utf8')) as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id, candidateHash: requireCandidateHash(content), resolved: false })
  })

  it('rejects a candidate projection over the shared bound before publishing candidate or review bytes', () => {
    const root = fixture()
    const reviewFile = join(root, '.llm-wiki', 'review.json')
    mkdirSync(join(root, 'wiki'), { recursive: true })
    mkdirSync(join(root, '.llm-wiki'), { recursive: true })
    let low = 0
    let high = REVIEW_STORE_MAX_BYTES
    while (low < high) {
      const mid = Math.ceil((low + high) / 2)
      const text = `${JSON.stringify([{ id: 'legacy', title: 'x'.repeat(mid), type: 'suggestion', resolved: false }], null, 2)}\n`
      if (Buffer.byteLength(text, 'utf8') <= REVIEW_STORE_MAX_BYTES) low = mid
      else high = mid - 1
    }
    const before = encodeReviewStore([{ id: 'legacy', title: 'x'.repeat(low), type: 'suggestion', resolved: false }])
    expect(Buffer.byteLength(before, 'utf8')).toBe(REVIEW_STORE_MAX_BYTES)
    writeFileSync(reviewFile, before)
    const candidatePath = '_candidates/ingest/cap-check.md'
    const candidateFull = join(root, 'wiki', candidatePath)
    expect(() => prepareReviewAppend(reviewFile, root, undefined, [], [{
      path: `wiki/${candidatePath}`,
      content: '---\ntitle: Cap check\nstatus: candidate\n---\n\nA durable candidate body for testing the shared projection boundary.\n',
    }])).toThrow('review store exceeds')
    expect(existsSync(candidateFull)).toBe(false)
    expect(readFileSync(reviewFile, 'utf8')).toBe(before)
  })

  it('accepts only a preflighted fallback variant and refuses an unplanned candidate body', () => {
    const root = fixture()
    mkdirSync(join(root, 'wiki'), { recursive: true })
    const reviewFile = join(root, '.llm-wiki', 'review.json')
    const candidatePath = '_candidates/ingest/variant.md'
    const candidateFull = join(root, 'wiki', candidatePath)
    const preferred = '---\ntitle: Preferred\nstatus: candidate\n---\n\nPreferred generated candidate content.\n'
    const fallback = '---\ntitle: Fallback\nstatus: candidate\n---\n\nDeterministic fallback candidate content.\n'
    const variants = [
      { path: `wiki/${candidatePath}`, content: preferred },
      { path: `wiki/${candidatePath}`, content: fallback },
    ]

    const acceptedPlan = prepareReviewAppend(reviewFile, root, undefined, [], variants)
    mkdirSync(dirname(candidateFull), { recursive: true })
    writeFileSync(candidateFull, fallback)
    expect(commitReviewAppend(acceptedPlan)).toMatchObject({ advisoryAppended: 0, candidateAppended: 1 })
    const accepted = JSON.parse(readFileSync(reviewFile, 'utf8')) as Array<{ candidateHash: string }>
    expect(accepted[0]?.candidateHash).toBe(requireCandidateHash(fallback))

    const other = '---\ntitle: Other\nstatus: candidate\n---\n\nUnplanned candidate content.\n'
    const refusedFile = join(root, '.llm-wiki', 'refused.json')
    const refusedPlan = prepareReviewAppend(refusedFile, root, undefined, [], variants)
    writeFileSync(candidateFull, other)
    expect(() => commitReviewAppend(refusedPlan)).toThrow('candidate or source changed after review append preflight')
    expect(existsSync(refusedFile)).toBe(false)
  })

  it('re-resolves planned candidate paths and refuses an ancestor symlink replacement', () => {
    const root = fixture()
    const wikiRoot = join(root, 'wiki')
    const reviewFile = join(root, '.llm-wiki', 'review.json')
    const candidatePath = '_candidates/ingest/path-check.md'
    const content = '---\ntitle: Path check\nstatus: candidate\n---\n\nA candidate with stable path provenance.\n'
    const plan = prepareReviewAppend(reviewFile, root, undefined, [], [{ path: `wiki/${candidatePath}`, content }])
    const candidateParent = join(wikiRoot, '_candidates', 'ingest')
    const outside = join(root, 'outside')
    mkdirSync(join(wikiRoot, '_candidates'), { recursive: true })
    mkdirSync(outside)
    symlinkSync(outside, candidateParent, 'dir')
    writeFileSync(join(outside, 'path-check.md'), content)

    expect(() => commitReviewAppend(plan)).toThrow('candidate path changed after review append preflight')
    expect(existsSync(reviewFile)).toBe(false)
  })

  it('refuses a candidate when canonical state changes its planned governance decision', () => {
    const root = fixture()
    const wikiRoot = join(root, 'wiki')
    const reviewFile = join(root, '.llm-wiki', 'review.json')
    const candidatePath = '_candidates/ingest/concepts/governance-change.md'
    const content = [
      '---',
      'title: Durable verification procedure',
      'status: candidate',
      'sources: [https://example.test/source]',
      '---',
      '',
      '## Verification procedure',
      '- Method: verify the invariant and evidence before publication.',
      '- Boundary: preserve rollback data when the precondition is false.',
      '- Acceptance: test the expected result and record a recovery point.',
      'This procedure explains the durable method, verification evidence, risk boundary, and rollback conditions.',
      '',
    ].join('\n')
    const plan = prepareReviewAppend(reviewFile, root, undefined, [], [{ path: `wiki/${candidatePath}`, content }])
    const candidateFull = join(wikiRoot, candidatePath)
    mkdirSync(dirname(candidateFull), { recursive: true })
    writeFileSync(candidateFull, content)
    const canonical = join(wikiRoot, 'concepts', 'governance-change.md')
    mkdirSync(dirname(canonical), { recursive: true })
    writeFileSync(canonical, content)

    expect(() => commitReviewAppend(plan)).toThrow('candidate governance changed after review append preflight')
    expect(existsSync(reviewFile)).toBe(false)
  })

  it('updates only the first legacy duplicate candidate id and preserves the remaining row', () => {
    const root = fixture()
    const wikiRoot = join(root, 'wiki')
    mkdirSync(wikiRoot, { recursive: true })
    const reviewFile = join(root, '.llm-wiki', 'review.json')
    mkdirSync(join(root, '.llm-wiki'), { recursive: true })
    const candidatePath = '_candidates/ingest/duplicate.md'
    const id = `candidate-${createHash('sha256').update(candidatePath).digest('hex').slice(0, 16)}`
    const first = { id, title: 'Old first', type: 'candidate-approval', resolved: true, candidateHash: 'old-first' }
    const duplicate = { id, title: 'Legacy second duplicate', type: 'legacy', resolved: false, marker: 'retain' }
    writeFileSync(reviewFile, `${JSON.stringify([first, duplicate], null, 2)}\n`)
    const content = '---\ntitle: Updated candidate\nstatus: candidate\n---\n\nA replacement candidate row.\n'
    const plan = prepareReviewAppend(reviewFile, root, undefined, [], [{ path: `wiki/${candidatePath}`, content }])
    const candidateFull = join(wikiRoot, candidatePath)
    mkdirSync(dirname(candidateFull), { recursive: true })
    writeFileSync(candidateFull, content)

    expect(commitReviewAppend(plan).candidateAppended).toBe(1)
    const after = JSON.parse(readFileSync(reviewFile, 'utf8')) as Array<Record<string, unknown>>
    expect(after).toHaveLength(2)
    expect(after[0]).toMatchObject({ id, candidateHash: requireCandidateHash(content), resolved: false })
    expect(after[1]).toEqual(duplicate)
  })
})

function requireCandidateHash(content: string): string {
  return createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex')
}
