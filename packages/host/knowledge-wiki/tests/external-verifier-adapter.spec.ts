import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { generateKeyPairSync, sign } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { Readable } from 'node:stream'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createExternalVerifierAuthority, type ExternalVerifierOptions } from '../src/external-verifier-adapter.ts'
import {
  canonicalJson,
  encodeKnowledgeWikiPromotionSealRequest,
  sha256,
  type KnowledgeWikiPromotionSealRequest,
  type KnowledgeWikiSourceIdentity,
  type IndependentVerificationRequest,
  type IndependentVerificationResult,
  type VerificationAuthoritySeal,
} from '../src/verifier.ts'

type KnowledgeWikiEventSealRequest = Extract<KnowledgeWikiPromotionSealRequest, { readonly operation: 'seal-knowledge-event' }>
type KnowledgeWikiWalSealRequest = Extract<KnowledgeWikiPromotionSealRequest, { readonly operation: 'seal-promotion-wal' }>

const roots: string[] = []
let verifierSubprocess: SubprocessRuntime
let disposeVerifierRuntime: (() => Promise<void>) | undefined

beforeAll(async () => {
  const context = new Context()
  const fiber = await context.plugin(LocalSubprocessRuntime)
  verifierSubprocess = context.subprocess
  disposeVerifierRuntime = () => fiber.dispose()
})

afterAll(async () => {
  await disposeVerifierRuntime?.()
})

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const sourceIdentity = {
  commit: 'a'.repeat(40),
  sourceDigest: '1'.repeat(64),
  dirty: false,
  dirtyDigest: '2'.repeat(64),
  buildDigest: '3'.repeat(64),
} as const

const request = {
  schemaVersion: 2,
  review: { id: 'review-1', resolved: false },
  reviewHash: '4'.repeat(64),
  candidatePath: '_candidates/topic.md',
  candidateHash: '5'.repeat(64),
  sourceHash: '6'.repeat(64),
  targetPath: 'concepts/topic.md',
  governanceAction: 'Promote',
  governanceDecision: { action: 'Promote', targetPath: 'concepts/topic.md', policyVersion: 'test' },
  sourceIdentity,
  environment: { nodeVersion: process.versions.node, platform: process.platform, arch: process.arch, policyVersion: 'test' },
} as const satisfies IndependentVerificationRequest

function verifierScript(result: IndependentVerificationResult, suffix = ''): string[] {
  return ['-e', `process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(${JSON.stringify(JSON.stringify(result))}));${suffix}`]
}

function authorityFixture() {
  const keys = generateKeyPairSync('ed25519')
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const unsigned = {
    authorityId: 'launcher-verifier',
    requestHash: sha256(canonicalJson(request)),
    result: 'pass' as const,
    methods: ['integration_test' as const],
    outcomes: [{ name: 'signed-check', result: 'pass' as const, evidence: ['external command checked the canonical request'] }],
    issuedAt: '2026-10-08T00:00:00.000Z',
  }
  const result: IndependentVerificationResult = {
    ...unsigned,
    proof: sign(null, Buffer.from(canonicalJson(unsigned)), keys.privateKey).toString('base64'),
  }
  const args = verifierScript(result)
  return { keys, result, executable: process.execPath, args, publicKey, privateKey }
}

function rawVerifierScript(body: string): string[] {
  return ['-e', body]
}

function authorityOptions(
  fixture: ReturnType<typeof authorityFixture>,
  overrides: Partial<ExternalVerifierOptions> = {},
): ExternalVerifierOptions {
  return {
    authorityId: 'launcher-verifier',
    sourceIdentity,
    executable: fixture.executable,
    args: fixture.args,
    publicKey: fixture.publicKey,
    promotionSealer: overrides.promotionSealer ?? {
      authorityId: overrides.authorityId ?? 'launcher-verifier',
      async sealPromotion(sealRequest) {
        const authorityId = overrides.authorityId ?? 'launcher-verifier'
        if (sealRequest.authorityId !== authorityId) throw new Error('fixture sealer authority mismatch')
        return {
          authorityId,
          proof: sign(null, Buffer.from(encodeKnowledgeWikiPromotionSealRequest(sealRequest), 'utf8'), fixture.keys.privateKey).toString('base64'),
        }
      },
    },
    subprocess: verifierSubprocess,
    ...overrides,
  }
}

function signedVariant(
  fixture: ReturnType<typeof authorityFixture>,
  overrides: Partial<Omit<IndependentVerificationResult, 'proof'>>,
): IndependentVerificationResult {
  const { proof: _proof, ...unsigned } = fixture.result
  const value = { ...unsigned, ...overrides }
  return {
    ...value,
    proof: sign(null, Buffer.from(canonicalJson(value)), fixture.keys.privateKey).toString('base64'),
  }
}

describe('external verifier adapter', () => {
  it('forwards cancellation to the typed sealer and skips dispatch for a pre-aborted request', async () => {
    const fixture = authorityFixture()
    const invokedSignals: AbortSignal[] = []
    let entered!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    const authority = createExternalVerifierAuthority(authorityOptions(fixture, {
      promotionSealer: {
        authorityId: 'launcher-verifier',
        sealPromotion(_request, signal) {
          if (signal === undefined) throw new Error('missing promotion cancellation signal')
          invokedSignals.push(signal)
          entered()
          return new Promise<VerificationAuthoritySeal>((_resolve, reject) => {
            signal.addEventListener('abort', () => {
              const reason: unknown = signal.reason
              reject(reason instanceof Error ? reason : new Error('promotion signing aborted'))
            }, { once: true })
          })
        },
      },
    }))
    const request = verifiedSealRequest()
    const preAborted = new AbortController()
    preAborted.abort(new Error('pre-aborted promotion request'))
    await expect(authority.sealPromotion(request, preAborted.signal)).rejects.toThrow('pre-aborted promotion request')
    expect(invokedSignals).toEqual([])

    const active = new AbortController()
    const pending = authority.sealPromotion(request, active.signal)
    await started
    expect(invokedSignals).toEqual([active.signal])
    active.abort(new Error('promotion request cancelled'))
    await expect(pending).rejects.toThrow('promotion request cancelled')
  })
  const verifiedSealRequest = (authorityId = 'launcher-verifier') => ({
    schemaVersion: 1,
    domain: 'ark.knowledge-wiki',
    authorityId,
    operation: 'seal-knowledge-event',
    eventType: 'knowledge/verified',
    knowledgeId: 'candidate:review-1',
    payload: {
      record: {
        id: 'candidate:review-1', content: 'fixture', source: '_candidates/topic.md', sourceHash: '6'.repeat(64),
        scope: { projectId: '/fixture/project', visibility: 'project' }, trust: 'low', authority: 'fixture',
        evidenceRefs: ['receipt-1'], verificationStatus: 'candidate', confidence: 0,
        createdAt: '2026-10-08T00:00:00.000Z', lastVerifiedAt: null, expiresAt: null, conflicts: [],
        retrievalHits: 0, successfulUses: 0, userCorrections: 0, utilityScore: 0, lifecycle: 'candidate',
      },
      trust: 'medium', authority: 'launcher-verifier', confidence: 0.9,
      lastVerifiedAt: '2026-10-08T00:00:00.000Z',
      candidatePath: '_candidates/topic.md',
      candidateHash: '5'.repeat(64),
      source: '_candidates/topic.md',
      evidenceRefs: ['receipt-1'],
    },
  } as const satisfies KnowledgeWikiEventSealRequest)

  it('verifies signed results and promotion seals from a launcher-owned child', async () => {
    const fixture = authorityFixture()
    const authority = createExternalVerifierAuthority(authorityOptions(fixture))
    expect(Object.isFrozen(authority.sourceIdentity())).toBe(true)
    await expect(authority.verifyCandidate(request, new AbortController().signal)).resolves.toEqual(fixture.result)
    expect(authority.validateCandidateResult(request, fixture.result)).toBe(true)
    const operation = verifiedSealRequest()
    const encoded = encodeKnowledgeWikiPromotionSealRequest(operation)
    expect(encoded).toBe(canonicalJson({
      type: operation.eventType,
      knowledgeId: operation.knowledgeId,
      payload: operation.payload,
    }))
    const seal = await authority.sealPromotion(operation)
    expect(authority.validatePromotion(encoded, seal)).toBe(true)
    expect(authority.validatePromotion(`${encoded} `, seal)).toBe(false)
    expect(authority.validatePromotion(encoded, { ...seal, authorityId: 'other' })).toBe(false)
    authority.checkpointPromotion?.('promotion-payload', { phase: 'journal-persisted', operationIndex: -1 })
  })

  it('rejects unknown operations, schema/domain/authority mismatches, and extra fields at runtime', async () => {
    const fixture = authorityFixture()
    const authority = createExternalVerifierAuthority(authorityOptions(fixture))
    const valid = verifiedSealRequest()
    for (const invalid of [
      { ...valid, operation: 'sign-anything' },
      { ...valid, schemaVersion: 2 },
      { ...valid, domain: 'other-domain' },
      { ...valid, authorityId: 'foreign-authority' },
      { ...valid, extra: true },
      { ...valid, payload: { ...valid.payload, arbitrary: 'value' } },
      { ...valid, operation: 'seal-promotion-wal', journal: {} },
      {
        ...valid,
        operation: 'seal-knowledge-event',
        eventType: 'knowledge/promoted',
        payload: { action: 'Accept', lifecycle: 'canonical', appliedPath: 'concepts/topic.md', candidateHash: '5'.repeat(64) },
      },
      'arbitrary signer payload',
      null,
      [],
    ]) {
      await expect(authority.sealPromotion(invalid as never)).rejects.toThrow()
    }
    let getterCalled = false
    const accessorRequest = { ...valid }
    Object.defineProperty(accessorRequest, 'operation', {
      enumerable: true,
      get() {
        getterCalled = true
        return 'seal-knowledge-event'
      },
    })
    await expect(authority.sealPromotion(accessorRequest as never)).rejects.toThrow()
    expect(getterCalled).toBe(false)

    const customPrototype: unknown = Object.assign(Object.create({ inherited: true }), valid)
    expect(() => encodeKnowledgeWikiPromotionSealRequest(customPrototype as never)).toThrow()
    expect(() => encodeKnowledgeWikiPromotionSealRequest(null as never)).toThrow()

    const exoticPayload = { ...valid.payload }
    Object.defineProperty(exoticPayload, Symbol('extra'), { value: 'hidden', enumerable: true })
    expect(() => encodeKnowledgeWikiPromotionSealRequest({ ...valid, payload: exoticPayload })).toThrow()
    const nonPlainRecord: unknown = Object.assign(Object.create({ inherited: true }), valid.payload.record)
    expect(() => encodeKnowledgeWikiPromotionSealRequest({
      ...valid,
      payload: { ...valid.payload, record: nonPlainRecord },
    })).toThrow()
    expect(() => encodeKnowledgeWikiPromotionSealRequest({
      ...valid, payload: { ...valid.payload, verificationStatus: undefined },
    })).toThrow()

    const cyclicRecord = { ...valid.payload.record } as Record<string, unknown>
    cyclicRecord.self = cyclicRecord
    expect(() => encodeKnowledgeWikiPromotionSealRequest({ ...valid, payload: { ...valid.payload, record: cyclicRecord } })).toThrow()

    const invalidVerified = [
      { ...valid.payload, candidateHash: 'bad' },
      { ...valid.payload, candidatePath: '' },
      { ...valid.payload, source: '' },
      { ...valid.payload, evidenceRefs: [7] },
      { ...valid.payload, trust: 'unknown' },
      { ...valid.payload, authority: 'foreign-authority' },
      { ...valid.payload, confidence: 1.5 },
      { ...valid.payload, lastVerifiedAt: 'not-an-ISO-date' },
      { ...valid.payload, record: undefined },
      { ...valid.payload, record: { ...valid.payload.record, id: 'candidate:other' } },
      { ...valid.payload, record: { ...valid.payload.record, lifecycle: 'unrecognized' } },
      { ...valid.payload, record: { ...valid.payload.record, lifecycle: ['canonical'] } },
      { ...valid.payload, record: { ...valid.payload.record, lifecycle: { value: 'canonical' } } },
      { ...valid.payload, record: { ...valid.payload.record, acl: { owners: ['fixture'] } } },
      { ...valid.payload, record: { ...valid.payload.record, lastVerifiedAt: ['2026-10-08T00:00:00.000Z'] } },
      { ...valid.payload, record: { ...valid.payload.record, expiresAt: ['2026-10-09T00:00:00.000Z'] } },
      { ...valid.payload, record: { ...valid.payload.record, claimKey: { key: 'topic-fixture' } } },
    ]
    for (const payload of invalidVerified) {
      expect(() => encodeKnowledgeWikiPromotionSealRequest({ ...valid, payload })).toThrow()
    }
    expect(() => encodeKnowledgeWikiPromotionSealRequest({
      ...valid,
      payload: { ...valid.payload, trust: ['medium'] },
    })).toThrow()

    const promotedPayload = {
      action: 'Promote', lifecycle: 'canonical', appliedPath: 'concepts/topic.md', candidateHash: '5'.repeat(64),
      trialHash: '1'.repeat(64), proposalHash: '2'.repeat(64), targetAfterHash: '3'.repeat(64),
      measuredTrialAuthorityId: 'trial-authority', evidenceRefs: ['4'.repeat(64)],
      retrievalHits: 1, successfulUses: 1, userCorrections: 0, utilityScore: 2,
      startedAt: '2026-10-08T00:00:00.000Z', endedAt: '2026-10-08T00:00:00.000Z',
    }
    const promotedRequest: KnowledgeWikiEventSealRequest = {
      schemaVersion: 1, domain: 'ark.knowledge-wiki', authorityId: 'launcher-verifier',
      operation: 'seal-knowledge-event', eventType: 'knowledge/promoted',
      knowledgeId: 'candidate:review-1', payload: promotedPayload,
    }
    expect(encodeKnowledgeWikiPromotionSealRequest(promotedRequest)).toBe(canonicalJson({
      type: promotedRequest.eventType, knowledgeId: promotedRequest.knowledgeId, payload: promotedPayload,
    }))
    expect(() => encodeKnowledgeWikiPromotionSealRequest({
      ...promotedRequest, payload: { ...promotedPayload, trialHash: 'bad' },
    })).toThrow()
  })

  it('signs a closed WAL core as the exact legacy canonical bytes and rejects extra WAL keys', async () => {
    const fixture = authorityFixture()
    const authority = createExternalVerifierAuthority(authorityOptions(fixture))
    const journal = {
      schemaVersion: 1 as const,
      id: `promotion-${'a'.repeat(24)}`,
      reviewId: 'review-1',
      candidateHash: '5'.repeat(64),
      createdAt: '2026-10-08T00:00:00.000Z',
      action: 'Promote',
      targetPath: 'concepts/topic.md',
      reviewHash: null,
      receiptId: null,
      receiptHash: null,
      operationSetHash: '',
      operations: [{ role: 'review' as const, path: '/wiki/review.json', before: 'old', after: 'new', stagingPath: '/wiki/.review-stage' }],
    }
    journal.operationSetHash = sha256(canonicalJson(journal.operations))
    const operation: KnowledgeWikiWalSealRequest = {
      schemaVersion: 1,
      domain: 'ark.knowledge-wiki',
      authorityId: 'launcher-verifier',
      operation: 'seal-promotion-wal',
      journal,
    }
    const legacyBytes = canonicalJson(journal)
    expect(encodeKnowledgeWikiPromotionSealRequest(operation)).toBe(legacyBytes)
    const seal = await authority.sealPromotion(operation)
    expect(authority.validatePromotion(legacyBytes, seal)).toBe(true)
    const foreignAuthorityOperation: KnowledgeWikiWalSealRequest = {
      ...operation,
      authorityId: 'foreign-authority',
    }
    await expect(authority.sealPromotion(foreignAuthorityOperation)).rejects.toThrow('authority context does not match')
    await expect(authority.sealPromotion({ ...operation, journal: { ...journal, state: 'prepared' } } as never)).rejects.toThrow()
    await expect(authority.sealPromotion({ ...operation, journal: { ...journal, operationSetHash: '0'.repeat(64) } })).rejects.toThrow()
    expect(() => encodeKnowledgeWikiPromotionSealRequest({
      ...operation,
      journal: { ...journal, measuredTrial: { trialHash: 'bad' } },
    } as never)).toThrow()
    expect(() => encodeKnowledgeWikiPromotionSealRequest({
      ...operation,
      journal: { ...journal, receiptId: 'receipt-without-hash' },
    })).toThrow()
    expect(() => encodeKnowledgeWikiPromotionSealRequest({
      ...operation,
      journal: { ...journal, reviewHash: 'not-a-hash' },
    })).toThrow()
    const badRoleOperations = [{ ...journal.operations[0], role: 'unknown-role' }]
    expect(() => encodeKnowledgeWikiPromotionSealRequest({
      ...operation,
      journal: { ...journal, operations: badRoleOperations, operationSetHash: sha256(canonicalJson(badRoleOperations)) },
    } as never)).toThrow()
    const coercibleRoleOperations = [{ ...journal.operations[0], role: ['review'] }]
    const coercibleRoleRequest = {
      ...operation,
      journal: {
        ...journal,
        operations: coercibleRoleOperations,
        operationSetHash: sha256(canonicalJson(coercibleRoleOperations)),
      },
    }
    await expect(authority.sealPromotion(coercibleRoleRequest as never)).rejects.toThrow()
    const badOptionalOperations = [{ ...journal.operations[0], before: 4 }]
    expect(() => encodeKnowledgeWikiPromotionSealRequest({
      ...operation,
      journal: { ...journal, operations: badOptionalOperations, operationSetHash: sha256(canonicalJson(badOptionalOperations)) },
    } as never)).toThrow()
  })

  it('keeps receipt and promotion identity bound after launcher options change', async () => {
    const fixture = authorityFixture()
    const options = authorityOptions(fixture)
    const authority = createExternalVerifierAuthority(options)
    const operation = verifiedSealRequest()
    const encoded = encodeKnowledgeWikiPromotionSealRequest(operation)
    const seal = await authority.sealPromotion(operation)
    Object.assign(options, { authorityId: 'changed-verifier' })

    expect(authority.validateCandidateResult(request, fixture.result)).toBe(true)
    expect(authority.validatePromotion(encoded, seal)).toBe(true)
    expect((await authority.sealPromotion(operation)).authorityId).toBe(authority.authorityId)
    await expect(authority.verifyCandidate(request, new AbortController().signal)).resolves.toEqual(fixture.result)
  })

  it('runs the validated executable after the caller replaces the command path', async () => {
    const fixture = authorityFixture()
    const options = authorityOptions(fixture)
    const authority = createExternalVerifierAuthority(options)
    Object.assign(options, { executable: join(tmpdir(), 'unexpected-verifier-command') })

    await expect(authority.verifyCandidate(request, new AbortController().signal)).resolves.toEqual(fixture.result)
  })

  it('runs the fixed arguments after the caller changes the original array', async () => {
    const fixture = authorityFixture()
    const authority = createExternalVerifierAuthority(authorityOptions(fixture))
    fixture.args.splice(0, fixture.args.length, ...rawVerifierScript('process.stdout.write("changed-command")'))

    await expect(authority.verifyCandidate(request, new AbortController().signal)).resolves.toEqual(fixture.result)
  })

  it('keeps the validated deadline after launcher options change', async () => {
    const fixture = authorityFixture()
    const options = authorityOptions(fixture, { timeoutMs: 5000 })
    const authority = createExternalVerifierAuthority(options)
    Object.assign(options, { timeoutMs: 1 })

    await expect(authority.verifyCandidate(request, new AbortController().signal)).resolves.toEqual(fixture.result)
  })

  it('rejects an invalid signed result, times out, and requires an absolute executable', async () => {
    const fixture = authorityFixture()
    const authority = createExternalVerifierAuthority(authorityOptions(fixture))
    const bad = { ...fixture.result, proof: Buffer.from('bad').toString('base64') }
    const badAuthority = createExternalVerifierAuthority(authorityOptions(fixture, { args: verifierScript(bad) }))
    await expect(badAuthority.verifyCandidate(request, new AbortController().signal)).rejects.toThrow('signature')

    const slow = verifierScript(fixture.result, 'setTimeout(() => {}, 5000)')
    const slowAuthority = createExternalVerifierAuthority(authorityOptions(fixture, { args: slow, timeoutMs: 20 }))
    await expect(slowAuthority.verifyCandidate(request, new AbortController().signal)).rejects.toThrow('timed out')
    expect(() => createExternalVerifierAuthority(authorityOptions(fixture, { executable: './verifier' }))).toThrow('absolute')
    expect(authority.authorityId).toBe('launcher-verifier')
  })

  it('rejects invalid authority configuration and defers a valid non-matching public key to seal verification', async () => {
    const fixture = authorityFixture()
    const invalidIdentities: readonly Partial<KnowledgeWikiSourceIdentity>[] = [
      { commit: 'bad' },
      { sourceDigest: 'bad' },
      { dirtyDigest: 'bad' },
      { buildDigest: 'bad' },
      { dirty: 'not-boolean' as never },
    ]
    for (const identity of invalidIdentities) {
      expect(() => createExternalVerifierAuthority(authorityOptions(fixture, {
        sourceIdentity: { ...sourceIdentity, ...identity },
      }))).toThrow('source identity is invalid')
    }
    expect(() => createExternalVerifierAuthority(authorityOptions(fixture, { authorityId: 'not allowed' })))
      .toThrow('authorityId is invalid')
    for (const timeoutMs of [0, -1, 120001, 1.5]) {
      expect(() => createExternalVerifierAuthority(authorityOptions(fixture, { timeoutMs })))
        .toThrow('timeout is invalid')
    }

    const other = generateKeyPairSync('ed25519')
    expect(fixture.keys.publicKey.type).toBe('public')
    expect(fixture.keys.publicKey.asymmetricKeyType).toBe('ed25519')
    expect(other.publicKey.type).toBe('public')
    expect(other.publicKey.asymmetricKeyType).toBe('ed25519')
    let sealCalls = 0
    const mismatchAuthority = createExternalVerifierAuthority(authorityOptions(fixture, {
      publicKey: other.publicKey,
      promotionSealer: {
        authorityId: 'launcher-verifier',
        async sealPromotion(sealRequest) {
          sealCalls += 1
          return {
            authorityId: 'launcher-verifier',
            proof: sign(null, Buffer.from(encodeKnowledgeWikiPromotionSealRequest(sealRequest), 'utf8'), fixture.keys.privateKey).toString('base64'),
          }
        },
      },
    }))
    expect(mismatchAuthority.authorityId).toBe('launcher-verifier')
    expect(sealCalls).toBe(0)
    await expect(mismatchAuthority.sealPromotion(verifiedSealRequest()))
      .rejects.toThrow('promotion sealer returned an invalid authority signature')
    expect(sealCalls).toBe(1)
    const objectKeyAuthority = createExternalVerifierAuthority(authorityOptions(fixture, {
      publicKey: fixture.keys.publicKey,
    }))
    expect(objectKeyAuthority.validateCandidateResult(request, fixture.result)).toBe(true)
  })

  it('accepts only public Ed25519 key material before verifier dispatch', () => {
    const fixture = authorityFixture()
    let sealCalls = 0
    const promotionSealer = {
      authorityId: 'launcher-verifier',
      async sealPromotion(sealRequest: KnowledgeWikiPromotionSealRequest) {
        sealCalls += 1
        return {
          authorityId: 'launcher-verifier',
          proof: sign(null, Buffer.from(encodeKnowledgeWikiPromotionSealRequest(sealRequest), 'utf8'), fixture.keys.privateKey).toString('base64'),
        }
      },
    }
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
    for (const publicKey of [
      fixture.keys.privateKey,
      fixture.keys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
      rsa.publicKey,
      rsa.publicKey.export({ type: 'spki', format: 'pem' }),
    ]) {
      expect(() => createExternalVerifierAuthority(authorityOptions(fixture, { publicKey, promotionSealer })))
        .toThrow(/public key/u)
    }

    const bufferPemAuthority = createExternalVerifierAuthority(authorityOptions(fixture, {
      publicKey: Buffer.from(fixture.publicKey, 'utf8'),
      promotionSealer,
    }))
    expect(bufferPemAuthority.validateCandidateResult(request, fixture.result)).toBe(true)
    expect(sealCalls).toBe(0)
  })

  it('rejects a sealer with a foreign authority id before signer dispatch', () => {
    const fixture = authorityFixture()
    let sealCalls = 0
    expect(() => createExternalVerifierAuthority(authorityOptions(fixture, {
      promotionSealer: {
        authorityId: 'foreign-authority',
        async sealPromotion() {
          sealCalls += 1
          return { authorityId: 'foreign-authority', proof: '' }
        },
      },
    }))).toThrow('promotion sealer authority does not match')
    expect(sealCalls).toBe(0)
  })

  it('rejects signed receipts with an invalid authority, request, proof, shape, or timestamp', () => {
    const fixture = authorityFixture()
    const authority = createExternalVerifierAuthority(authorityOptions(fixture))
    const invalidResults: readonly IndependentVerificationResult[] = [
      signedVariant(fixture, { authorityId: 'other-authority' }),
      signedVariant(fixture, { requestHash: 'f'.repeat(64) }),
      { ...fixture.result, proof: '' },
      signedVariant(fixture, { methods: [] }),
      signedVariant(fixture, { outcomes: [] }),
      signedVariant(fixture, { issuedAt: 'not-a-date' }),
    ]
    for (const result of invalidResults) {
      expect(authority.validateCandidateResult(request, result)).toBe(false)
    }
  })

  it('handles pre-abort, spawn error, malformed output, exit diagnostics, and environment isolation', async () => {
    const fixture = authorityFixture()
    const preAborted = new AbortController()
    preAborted.abort()
    const defaultAuthority = createExternalVerifierAuthority(authorityOptions(fixture))
    await expect(defaultAuthority.verifyCandidate(request, preAborted.signal)).rejects.toThrow('aborted')

    const missingRoot = mkdtempSync(join(tmpdir(), 'external-verifier-missing-'))
    roots.push(missingRoot)
    const missing = createExternalVerifierAuthority(authorityOptions(fixture, {
      executable: join(missingRoot, 'not-created'),
    }))
    await expect(missing.verifyCandidate(request, new AbortController().signal)).rejects.toThrow()

    const malformed = createExternalVerifierAuthority(authorityOptions(fixture, {
      args: rawVerifierScript('process.stdin.resume(); process.stdin.on("end", () => process.stdout.write("not-json"))'),
    }))
    await expect(malformed.verifyCandidate(request, new AbortController().signal)).rejects.toThrow()

    const nonzero = createExternalVerifierAuthority(authorityOptions(fixture, {
      args: rawVerifierScript('process.stdin.resume(); process.stdin.on("end", () => { process.stderr.write("denied"); process.exitCode = 7 })'),
    }))
    await expect(nonzero.verifyCandidate(request, new AbortController().signal)).rejects.toThrow('exited 7: denied')

    const noDetail = createExternalVerifierAuthority(authorityOptions(fixture, {
      args: rawVerifierScript('process.stdin.resume(); process.stdin.on("end", () => { process.exitCode = 6 })'),
    }))
    await expect(noDetail.verifyCandidate(request, new AbortController().signal)).rejects.toThrow('exited 6')

    const signalled = createExternalVerifierAuthority(authorityOptions(fixture, {
      args: rawVerifierScript('process.stdin.resume(); process.stdin.on("end", () => process.kill(process.pid, "SIGTERM"))'),
    }))
    // A self-signal calls TerminateProcess(..., 1) on Windows; no parent-side
    // uv_process_kill records a signal on that child handle.
    await expect(signalled.verifyCandidate(request, new AbortController().signal))
      .rejects.toThrow(process.platform === 'win32' ? 'external verifier exited 1' : 'SIGTERM')

    const previousSecret = process.env.ARK_VERIFIER_TEST_SECRET
    process.env.ARK_VERIFIER_TEST_SECRET = 'test-secret-must-not-leak'
    try {
      const isolated = createExternalVerifierAuthority(authorityOptions(fixture, {
        args: rawVerifierScript('process.stdin.resume(); process.stdin.on("end", () => { process.stderr.write(process.env.ARK_VERIFIER_TEST_SECRET ?? "absent"); process.exitCode = 5 })'),
      }))
      await expect(isolated.verifyCandidate(request, new AbortController().signal)).rejects.toThrow('absent')
    } finally {
      if (previousSecret === undefined) delete process.env.ARK_VERIFIER_TEST_SECRET
      else process.env.ARK_VERIFIER_TEST_SECRET = previousSecret
    }

    const cancelling = createExternalVerifierAuthority(authorityOptions(fixture, {
      args: rawVerifierScript('process.stdin.resume(); setInterval(() => {}, 1000)'),
    }))
    const controller = new AbortController()
    const pending = cancelling.verifyCandidate(request, controller.signal)
    setTimeout(() => { controller.abort() }, 50)
    await expect(pending).rejects.toThrow('aborted')
  }, 15_000)

  it('caps retained stderr and force-kills a child that ignores SIGTERM after output overflow', async () => {
    const fixture = authorityFixture()
    const largeStderr = createExternalVerifierAuthority(authorityOptions(fixture, {
      args: rawVerifierScript('process.stdin.resume(); process.stdin.on("end", () => { process.stderr.write("a"); setTimeout(() => { process.stderr.write("b".repeat(20000)); setTimeout(() => { process.stderr.write("ignored after cap"); process.exitCode = 7 }, 5) }, 5) })'),
    }))
    const errorMessage = await largeStderr.verifyCandidate(request, new AbortController().signal).then(
      () => '',
      (error: unknown) => error instanceof Error ? error.message : String(error),
    )
    expect(errorMessage).toContain('exited 7')
    expect(errorMessage.length).toBeLessThan(1050)

    const fixtureRoot = mkdtempSync(join(tmpdir(), 'external-verifier-tree-'))
    roots.push(fixtureRoot)
    const helperPidPath = join(fixtureRoot, 'helper.pid')
    const helperArgs = JSON.stringify([
      '-e',
      'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)',
    ])
    const oversized = createExternalVerifierAuthority(authorityOptions(fixture, {
      args: rawVerifierScript([
        'const { spawn } = require("node:child_process")',
        'const { writeFileSync } = require("node:fs")',
        'process.stdin.resume()',
        'process.on("SIGTERM", () => {})',
        `const helper = spawn(process.execPath, ${helperArgs}, { stdio: "ignore" })`,
        `writeFileSync(${JSON.stringify(helperPidPath)}, String(helper.pid))`,
        'process.stdin.on("end", () => { process.stdout.write("x".repeat(256 * 1024 + 1)); setTimeout(() => process.stdout.write("y"), 10); setInterval(() => {}, 1000) })',
      ].join('; ')),
    }))
    await expect(oversized.verifyCandidate(request, new AbortController().signal))
      .rejects.toThrow('output exceeds 256 KiB')
    expect(existsSync(helperPidPath)).toBe(true)
    const helperPid = Number(readFileSync(helperPidPath, 'utf8'))
    let helperStillRunning = true
    for (let attempt = 0; attempt < 30 && helperStillRunning; attempt += 1) {
      try {
        process.kill(helperPid, 0)
        await delay(25)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
        helperStillRunning = false
      }
    }
    expect(helperStillRunning).toBe(false)
  }, 15_000)

  it('does not settle a successful verification before managed process-tree quiescence', async () => {
    const fixture = authorityFixture()
    let reportWaitStarted: (() => void) | undefined
    let releaseWait: (() => void) | undefined
    const waitStarted = new Promise<void>((resolve) => { reportWaitStarted = resolve })
    const gate = new Promise<void>((resolve) => { releaseWait = resolve })
    const subprocess: Pick<SubprocessRuntime, 'resolveExecutable' | 'spawn'> = {
      resolveExecutable: (...args) => verifierSubprocess.resolveExecutable(...args),
      spawn: (spec) => {
        const handle: SubprocessHandle = verifierSubprocess.spawn(spec)
        return {
          pid: handle.pid,
          stdin: handle.stdin,
          stdout: handle.stdout,
          stderr: handle.stderr,
          collected: handle.collected,
          done: handle.done,
          terminate: () => { handle.terminate() },
          waitForExit: async (signal) => {
            reportWaitStarted?.()
            await gate
            return handle.waitForExit(signal)
          },
        }
      },
    }
    const authority = createExternalVerifierAuthority(authorityOptions(fixture, { subprocess }))
    let settled = false
    const pending = authority.verifyCandidate(request, new AbortController().signal)
    void pending.finally(() => { settled = true })
    await waitStarted
    expect(settled).toBe(false)
    releaseWait?.()
    await expect(pending).resolves.toEqual(fixture.result)
    expect(settled).toBe(true)
  })

  const postExitModes = process.platform === 'win32'
    ? ['windows-parent-job'] as const
    : ['timeout', 'cancel', 'natural'] as const
  it.each(postExitModes)('observes a started helper after verifier leader exit: %s', async (mode) => {
    const fixture = authorityFixture()
    const root = mkdtempSync(join(tmpdir(), 'external-verifier-post-exit-'))
    roots.push(root)
    const childPidPath = join(root, 'child.pid')
    const childReadyPath = join(root, 'child.ready')
    const childOutcomePath = join(root, 'child.outcome')
    const childProgram = mode === 'natural'
      ? 'setTimeout(() => {}, 350)'
      : 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'
    const readyProgram = [
      childProgram,
      `require('node:fs').writeFileSync(${JSON.stringify(childReadyPath)}, String(process.pid), { mode: 0o600 })`,
    ].join('; ')
    const args = rawVerifierScript([
      'const { spawn } = require("node:child_process")',
      'const { existsSync, writeFileSync } = require("node:fs")',
      `const helper = spawn(process.execPath, ['-e', ${JSON.stringify(readyProgram)}], { stdio: 'ignore', detached: false })`,
      'helper.unref()',
      `writeFileSync(${JSON.stringify(childPidPath)}, String(helper.pid), { mode: 0o600 })`,
      `helper.once('error', error => writeFileSync(${JSON.stringify(childOutcomePath)}, JSON.stringify({ error: String(error) }), { mode: 0o600 }))`,
      `helper.once('exit', (code, signal) => writeFileSync(${JSON.stringify(childOutcomePath)}, JSON.stringify({ code, signal }), { mode: 0o600 }))`,
      'process.stdin.resume()',
      `process.stdin.on('end', () => {
        const ready = setInterval(() => {
          if (!existsSync(${JSON.stringify(childReadyPath)})) return;
          clearInterval(ready);
          process.stdout.write(${JSON.stringify(JSON.stringify(fixture.result))});
        }, 10);
      })`,
    ].join('; '))
    let handle: SubprocessHandle | undefined
    const subprocess: Pick<SubprocessRuntime, 'resolveExecutable' | 'spawn'> = {
      resolveExecutable: (...values) => verifierSubprocess.resolveExecutable(...values),
      spawn: (spec) => {
        handle = verifierSubprocess.spawn(spec)
        return handle
      },
    }
    const controller = new AbortController()
    const authority = createExternalVerifierAuthority(authorityOptions(fixture, { args, subprocess, timeoutMs: 1200 }))
    const pending = authority.verifyCandidate(request, controller.signal)
      .then(value => ({ kind: 'result' as const, value }), (error: unknown) => ({ kind: 'error' as const, error }))
    let observationTimer: ReturnType<typeof setTimeout> | undefined
    let primaryError: unknown
    try {
      for (let attempt = 0; attempt < 100 && handle === undefined; attempt += 1) await delay(10)
      expect(handle).toBeDefined()
      if (handle === undefined) throw new Error('verifier handle was not created')
      const directOutcome = await handle.done
      expect(directOutcome.exitCode).toBe(0)
      expect(directOutcome.signal).toBeNull()
      const childPid = Number(readFileSync(childPidPath, 'utf8'))
      expect(readFileSync(childReadyPath, 'utf8')).toBe(String(childPid))
      expect(existsSync(childOutcomePath)).toBe(false)
      // libuv's non-detached Windows helper belongs to the parent's job and
      // dies with it. This is OS cleanup, not evidence of Harness signalling.
      if (mode === 'windows-parent-job') {
        await expect.poll(() => {
          try { process.kill(childPid, 0); return false }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
            return true
          }
        }, { timeout: 3000, interval: 10 }).toBe(true)
        expect(await pending).toEqual({ kind: 'result', value: fixture.result })
        return
      }
      // On POSIX the actual survivor uses no inherited output pipe.
      expect(() => process.kill(childPid, 0)).not.toThrow()
      if (mode === 'cancel') controller.abort(new Error('test owner cancelled after leader exit'))
      const result = await Promise.race([
        pending,
        new Promise<never>((_resolve, reject) => {
          observationTimer = setTimeout(() => { reject(new Error('verifier stayed pending after its operation deadline')) }, 3000)
        }),
      ])
      if (mode === 'natural') {
        expect(result).toEqual({ kind: 'result', value: fixture.result })
      } else {
        expect(result.kind).toBe('error')
        if (result.kind !== 'error') throw new Error('interrupted verification returned a result')
        expect(String(result.error)).toContain(mode === 'timeout' ? 'timed out' : 'aborted')
      }
      expect(() => process.kill(childPid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
    } catch (error) {
      primaryError = error
      throw error
    } finally {
      if (observationTimer !== undefined) clearTimeout(observationTimer)
      // This independent fixture cleanup also reaps a failing pre-fix run; it is not a passing owner outcome.
      try {
        handle?.terminate()
        await handle?.done.catch(() => {})
        if (handle !== undefined) expect(await handle.waitForExit()).toBe(true)
        await pending
      } catch (cleanupError) {
        if (primaryError !== undefined) throw new AggregateError([primaryError, cleanupError], 'verifier observation and cleanup failed')
        throw cleanupError
      }
    }
  }, 10_000)

  it.each(['timeout', 'cancel'] as const)('bounds an outstanding managed wait after a real leader exit: %s', async (mode) => {
    const fixture = authorityFixture()
    const entered = Promise.withResolvers<undefined>()
    let handle: SubprocessHandle | undefined
    let waiting = true
    const subprocess: Pick<SubprocessRuntime, 'resolveExecutable' | 'spawn'> = {
      resolveExecutable: (...values) => verifierSubprocess.resolveExecutable(...values),
      spawn: (spec) => {
        const owned = verifierSubprocess.spawn(spec)
        handle = owned
        return {
          ...owned,
          waitForExit: async (signal) => {
            if (!waiting) return owned.waitForExit(signal)
            waiting = false
            entered.resolve(undefined)
            if (signal === undefined) throw new Error('the first managed wait must retain its operation deadline')
            await new Promise<void>((resolve) => {
              if (signal.aborted) resolve()
              else signal.addEventListener('abort', () => { resolve() }, { once: true })
            })
            return false
          },
        }
      },
    }
    const controller = new AbortController()
    const authority = createExternalVerifierAuthority(authorityOptions(fixture, { subprocess, timeoutMs: 1200 }))
    const pending = authority.verifyCandidate(request, controller.signal)
      .then(value => ({ value }), (error: unknown) => ({ error }))
    let observationTimer: ReturnType<typeof setTimeout> | undefined
    let primaryError: unknown
    try {
      await entered.promise
      if (handle === undefined) throw new Error('verifier handle was not created')
      expect(await handle.done).toEqual({ exitCode: 0, signal: null })
      if (mode === 'cancel') controller.abort(new Error('test owner cancelled its outstanding managed wait'))
      const outcome = await Promise.race([
        pending,
        new Promise<never>((_resolve, reject) => {
          observationTimer = setTimeout(() => { reject(new Error('verifier stayed pending after its operation deadline')) }, 3000)
        }),
      ])
      expect(outcome).toHaveProperty('error')
      expect(String('error' in outcome ? outcome.error : undefined)).toContain(mode === 'timeout' ? 'timed out' : 'aborted')
    } catch (error) {
      primaryError = error
      throw error
    } finally {
      if (observationTimer !== undefined) clearTimeout(observationTimer)
      try {
        handle?.terminate()
        await handle?.done.catch(() => {})
        if (handle !== undefined) expect(await handle.waitForExit()).toBe(true)
        await pending
      } catch (cleanupError) {
        if (primaryError !== undefined) throw new AggregateError([primaryError, cleanupError], 'verifier observation and cleanup failed')
        throw cleanupError
      }
    }
  }, 10_000)

  it.each(['stdout', 'stderr'] as const)('terminates a verifier child when piped %s is unavailable', async (missingStream) => {
    const fixture = authorityFixture()
    let terminated = false
    const subprocess: Pick<SubprocessRuntime, 'resolveExecutable' | 'spawn'> = {
      resolveExecutable: (...args) => verifierSubprocess.resolveExecutable(...args),
      spawn: (spec) => {
        const handle = verifierSubprocess.spawn(spec)
        const streams = missingStream === 'stdout'
          ? { stdout: undefined }
          : { stderr: undefined }
        return {
          ...handle,
          ...streams,
          terminate: () => {
            terminated = true
            handle.terminate()
          },
        }
      },
    }
    const authority = createExternalVerifierAuthority(authorityOptions(fixture, {
      args: rawVerifierScript('process.stdin.resume(); setInterval(() => {}, 1000)'),
      subprocess,
    }))

    await expect(authority.verifyCandidate(request, new AbortController().signal))
      .rejects.toThrow('did not provide piped output')
    expect(terminated).toBe(true)
  })

  it('retries the process-tree exit probe after termination and fails closed if it stays unknown', async () => {
    const fixture = authorityFixture()
    let waitCalls = 0
    let terminateCalls = 0
    const subprocess: Pick<SubprocessRuntime, 'resolveExecutable' | 'spawn'> = {
      resolveExecutable: (...args) => verifierSubprocess.resolveExecutable(...args),
      spawn: (spec) => {
        const handle = verifierSubprocess.spawn(spec)
        return {
          ...handle,
          terminate: () => {
            terminateCalls += 1
            handle.terminate()
          },
          waitForExit: async (signal) => {
            waitCalls += 1
            return waitCalls === 1 ? false : handle.waitForExit(signal)
          },
        }
      },
    }
    const authority = createExternalVerifierAuthority(authorityOptions(fixture, { subprocess }))

    await expect(authority.verifyCandidate(request, new AbortController().signal)).resolves.toEqual(fixture.result)
    expect(terminateCalls).toBe(1)
    expect(waitCalls).toBe(2)

    const unknownExitSubprocess: Pick<SubprocessRuntime, 'resolveExecutable' | 'spawn'> = {
      resolveExecutable: (...args) => verifierSubprocess.resolveExecutable(...args),
      spawn: (spec) => {
        const handle = verifierSubprocess.spawn(spec)
        return {
          ...handle,
          waitForExit: async () => {
            waitCalls += 1
            return false
          },
        }
      },
    }
    const unknownExitAuthority = createExternalVerifierAuthority(authorityOptions(fixture, {
      subprocess: unknownExitSubprocess,
    }))
    await expect(unknownExitAuthority.verifyCandidate(request, new AbortController().signal))
      .rejects.toThrow('process tree did not exit')
    expect(waitCalls).toBe(5)
  })

  it('defaults to no extra verifier arguments and normalizes string stream chunks', async () => {
    const fixture = authorityFixture()
    let spawnedArgv: readonly string[] = []
    const stdout = Readable.from([JSON.stringify(fixture.result)])
    const stderr = Readable.from(['bounded diagnostic'])
    const done = Promise.all([
      new Promise<void>((resolve) => { stdout.once('end', resolve) }),
      new Promise<void>((resolve) => { stderr.once('end', resolve) }),
    ]).then(() => ({ exitCode: 0, signal: null }))
    const child = {
      pid: 1,
      stdin: undefined,
      stdout,
      stderr,
      collected: {} as SubprocessHandle['collected'],
      done,
      terminate: () => undefined,
      waitForExit: async () => true,
    } as SubprocessHandle
    const subprocess: Pick<SubprocessRuntime, 'resolveExecutable' | 'spawn'> = {
      resolveExecutable: async executable => executable,
      spawn: (spec) => {
        spawnedArgv = spec.argv
        return child
      },
    }
    const options: ExternalVerifierOptions = {
      authorityId: 'launcher-verifier',
      sourceIdentity,
      executable: fixture.executable,
      publicKey: fixture.publicKey,
      promotionSealer: authorityOptions(fixture).promotionSealer,
      subprocess,
    }
    const authority = createExternalVerifierAuthority(options)

    await expect(authority.verifyCandidate(request, new AbortController().signal)).resolves.toEqual(fixture.result)
    expect(spawnedArgv).toEqual([process.execPath])
  })

  it('consumes an already-rejected spawn outcome while cleaning up an invalid handle', async () => {
    const fixture = authorityFixture()
    const child = {
      pid: -1,
      stdin: undefined,
      stdout: undefined,
      stderr: undefined,
      collected: {} as SubprocessHandle['collected'],
      done: Promise.reject(new Error('spawn did not produce an outcome')),
      terminate: () => undefined,
      waitForExit: async () => true,
    } as SubprocessHandle
    const subprocess: Pick<SubprocessRuntime, 'resolveExecutable' | 'spawn'> = {
      resolveExecutable: async executable => executable,
      spawn: () => child,
    }
    const authority = createExternalVerifierAuthority(authorityOptions(fixture, { subprocess }))

    await expect(authority.verifyCandidate(request, new AbortController().signal))
      .rejects.toThrow('did not provide piped output')
  })
})
