import { afterEach, describe, expect, it, vi } from 'vitest'
import { prepareCanonicalTarget, type CanonicalPreparationInput } from '../src/canonical-merge.ts'
import { buildVerificationRequest, sha256, validateSemanticReceipt } from '../src/verifier.ts'
import { createLearningGraphFixture } from './learning-graph-fixture.ts'
import { verifierAuthority } from './verifier-authority-fixture.ts'

const fixtures: ReturnType<typeof createLearningGraphFixture>[] = []
afterEach(() => { for (const value of fixtures.splice(0)) value.artifacts.dispose() })

describe('verification boundary closure', () => {
  it.each([undefined, null, [], { schemaVersion: 1 }, { schemaVersion: 2, id: 7 }, { schemaVersion: 2, id: '../escape' }])('rejects malformed decoded semantic receipt %j before invoking authority', (raw) => {
    const authority = verifierAuthority()
    const validate = vi.spyOn(authority, 'validateCandidateResult')
    expect(validateSemanticReceipt(authority, raw)).toBeUndefined()
    expect(validate).not.toHaveBeenCalled()
  })

  it('binds a source-less candidate to its stable candidate label and rejects a different source hash', () => {
    const value = createLearningGraphFixture()
    fixtures.push(value)
    const { sourcePath: _sourcePath, sourceHash: _sourceHash, ...row } = value.semantic.review
    const authority = verifierAuthority()
    const wikiRoot = value.captureContext().wikiRoot
    const expectedHash = sha256(row.candidatePath!)
    const result = buildVerificationRequest(authority, wikiRoot, { ...row, sourceHash: expectedHash }, 'Promote')
    expect(result).toMatchObject({ candidatePath: row.candidatePath, sourceHash: expectedHash })
    expect(buildVerificationRequest(authority, wikiRoot, { ...row, sourceHash: sha256('wrong-source') }, 'Promote')).toBeUndefined()
  })

  it('refuses an unsupported canonical action without returning transformed bytes', () => {
    const input = Object.freeze({
      // Exercise runtime refusal if a caller bypasses the closed TypeScript action union.
      action: 'Delete' as CanonicalPreparationInput['action'],
      candidateContent: 'candidate bytes', targetBefore: 'canonical bytes', targetPath: 'concepts/topic.md',
      reviewedAt: '2026-10-09T00:00:00.000Z', actor: 'synthetic-principal',
    })
    expect(() => prepareCanonicalTarget(input)).toThrow('unsupported canonical preparation action: Delete')
    expect(input.targetBefore).toBe('canonical bytes')
    expect(input.candidateContent).toBe('candidate bytes')
  })
})
