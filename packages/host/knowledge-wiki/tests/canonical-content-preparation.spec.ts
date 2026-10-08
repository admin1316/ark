import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { prepareCanonicalTarget, type CanonicalPreparationInput } from '../src/canonical-merge.ts'

const reviewedAt = '2026-10-08T16:17:18.123Z'
const actor = 'reviewer:alice'
const targetBefore = `---
title: Canonical
status: canonical
created: 2025-01-02
sources: ["canonical", "shared"]
approved_at: old
approved_by: prior
updated: 2025-01-02
---

# Canonical heading

Alpha beta
`
const candidateContent = `---
title: Candidate
status: candidate
created: 2026-08-01
sources: ["shared", "candidate"]
candidate_id: c1
origin: ingest
approved_at: old-candidate
approved_by: author
---

# Candidate heading

Alpha, beta!
`
const promoted = `---
approved_at: 2026-10-08
approved_by: reviewer:alice
title: Candidate
status: canonical
created: 2026-08-01
sources: ["shared", "candidate"]
candidate_id: c1
origin: ingest
---

# Candidate heading

Alpha, beta!
`
const promotedEvidence = `---
approved_at: 2026-10-08
approved_by: reviewer:alice
title: Candidate
status: evidence
created: 2026-08-01
sources: ["shared", "candidate"]
candidate_id: c1
origin: ingest
---

# Candidate heading

Alpha, beta!
`
const retained = `---
title: Canonical
status: canonical
created: 2025-01-02
sources: ["canonical", "shared", "candidate"]
approved_at: 2026-10-08T16:17:18.123Z
approved_by: reviewer:alice
updated: 2026-10-08
---

# Canonical heading

Alpha beta
`
const retainedEvidence = `---
approved_at: 2026-10-08
approved_by: reviewer:alice
title: Canonical
status: evidence
created: 2025-01-02
sources: ["canonical", "shared", "candidate"]
updated: 2026-10-08
---

# Canonical heading

Alpha beta
`
const replaced = `---
title: Candidate
status: canonical
created: 2025-01-02
sources: ["canonical", "shared", "candidate"]
approved_at: 2026-10-08T16:17:18.123Z
approved_by: reviewer:alice
updated: 2026-10-08
---

# Candidate heading

Alpha, beta!
`
const replacedEvidence = `---
approved_at: 2026-10-08
approved_by: reviewer:alice
title: Candidate
status: evidence
created: 2025-01-02
sources: ["canonical", "shared", "candidate"]
updated: 2026-10-08
---

# Candidate heading

Alpha, beta!
`

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

afterEach(() => vi.useRealTimers())

describe('frozen canonical content preparation', () => {
  it.each([
    ['Promote', 'concepts/page.md', promoted],
    ['Promote', '_evidence/research/page.md', promotedEvidence],
    ['Merge', 'concepts/page.md', retained],
    ['Merge', '_evidence/research/page.md', retainedEvidence],
    ['Replace', 'concepts/page.md', replaced],
    ['Replace', '_evidence/research/page.md', replacedEvidence],
    ['Deduplicate', 'concepts/page.md', retained],
    ['Deduplicate', '_evidence/research/page.md', retainedEvidence],
  ] as const)('pins exact %s bytes for %s across clocks and retries', (action, targetPath, expected) => {
    const input = Object.freeze({
      action, candidateContent, targetPath, targetBefore: action === 'Promote' ? undefined : targetBefore,
      reviewedAt, actor,
    })
    vi.useFakeTimers()
    vi.setSystemTime('2040-01-01T00:00:00Z')
    const first = prepareCanonicalTarget(input)
    vi.setSystemTime('1999-12-31T23:59:59Z')
    const retry = prepareCanonicalTarget(input)
    expect(first).toBe(expected)
    expect(retry).toBe(expected)
    expect(hash(first)).toBe(hash(expected))
    expect(hash(retry)).toBe(hash(first))
    expect(input).toEqual({
      action, candidateContent, targetPath, targetBefore: action === 'Promote' ? undefined : targetBefore,
      reviewedAt, actor,
    })
  })

  it('uses normalized equality only to select the canonical body, retaining its exact characters', () => {
    const canonical = '---\ntitle: Canonical\n---\n\n# Original heading\n\nＡlpha, BETA!\n'
    const candidate = '---\ntitle: Candidate\n---\n\n# Other heading\n\nalpha beta\n'
    const output = prepareCanonicalTarget({
      action: 'Merge', candidateContent: candidate, targetPath: 'concepts/page.md', targetBefore: canonical,
      reviewedAt, actor,
    })
    expect(output).toBe('---\ntitle: Canonical\nstatus: canonical\napproved_at: 2026-10-08T16:17:18.123Z\napproved_by: reviewer:alice\nupdated: 2026-10-08\nsources: []\n---\n\n# Original heading\n\nＡlpha, BETA!\n')
    expect(hash(canonical)).not.toBe(hash(candidate))
    expect(hash(output)).not.toBe(hash(candidate))
  })

  it('retains existing Promote raw stamping quirks instead of re-rendering the page', () => {
    const promote = (content: string, targetPath = 'concepts/page.md') => prepareCanonicalTarget({
      action: 'Promote', candidateContent: content, targetPath, targetBefore: undefined, reviewedAt, actor,
    })
    expect(promote('---\ntitle: Raw\n---\n\n  Raw body  ')).toBe(
      '---\napproved_at: 2026-10-08\napproved_by: reviewer:alice\nstatus: canonical\ntitle: Raw\n---\n\n  Raw body  ',
    )
    expect(promote('---\r\ntitle: Raw\r\nstatus: candidate\r\napproved_at: old\r\napproved_by: old\r\n---\r\n\r\nRaw body')).toBe(
      '---\r\ntitle: Raw\r\nstatus: canonical\r\n\r\n\r\n---\r\n\r\nRaw body',
    )
    expect(promote('plain body\n')).toBe('plain body\n')
    expect(promote('---\nstatus: candidate\napproved_at: first\napproved_at: second\napproved_by: first\napproved_by: second\n---\nBody')).toBe(
      '---\napproved_at: 2026-10-08\napproved_by: reviewer:alice\nstatus: canonical\napproved_at: second\napproved_by: second\n---\nBody',
    )
    expect(promote(candidateContent, '_evidence-other/page.md')).toBe(promoted)
  })

  it('uses the supplied day without reparsing timestamp offsets', () => {
    expect(prepareCanonicalTarget({
      action: 'Promote', candidateContent: '---\ntitle: Offset\n---\nBody', targetPath: 'concepts/page.md',
      targetBefore: undefined, reviewedAt: '2026-10-08T23:59:59-07:00', actor,
    })).toBe('---\napproved_at: 2026-10-08\napproved_by: reviewer:alice\nstatus: canonical\ntitle: Offset\n---\nBody')
  })

  it.each(['', targetBefore])('refuses Promote with captured existing target bytes', (before) => {
    expect(() => prepareCanonicalTarget({
      action: 'Promote', candidateContent, targetPath: 'concepts/page.md', targetBefore: before,
      reviewedAt, actor,
    })).toThrow('requires an absent Promote target')
  })

  it.each(['Merge', 'Replace', 'Deduplicate'] as const)('requires an explicit existing prestate for %s', (action) => {
    const input: CanonicalPreparationInput = {
      action, candidateContent, targetPath: 'concepts/page.md', targetBefore: undefined, reviewedAt, actor,
    }
    expect(() => prepareCanonicalTarget(input)).toThrow('requires existing target bytes for an update')
    expect(() => prepareCanonicalTarget({ ...input, targetBefore: '' })).toThrow('missing frontmatter')
    expect(() => prepareCanonicalTarget({ ...input, targetBefore, candidateContent: 'plain' })).toThrow('missing frontmatter')
  })

  it('retains Merge rejection and explicit replacement or provenance-only deduplication behavior', () => {
    const input: CanonicalPreparationInput = {
      action: 'Merge', candidateContent: '---\ntitle: Divergent\n---\n\nomega\n',
      targetPath: 'concepts/page.md', targetBefore, reviewedAt, actor,
    }
    expect(() => prepareCanonicalTarget(input)).toThrow('bodies diverge')
    expect(prepareCanonicalTarget({ ...input, action: 'Deduplicate' })).toContain('# Canonical heading\n\nAlpha beta\n')
    expect(prepareCanonicalTarget({ ...input, action: 'Replace' })).toContain('\n\nomega\n')
    expect(() => prepareCanonicalTarget({ ...input, action: 'Replace', candidateContent: '---\ntitle: Empty\n---\n # !! ' }))
      .toThrow('empty knowledge body')
  })
})
