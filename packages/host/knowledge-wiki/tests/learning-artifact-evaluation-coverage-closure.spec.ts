import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  canonicalLearningJson, createLearningArtifactOwner, decodeCanonicalJson, parseArtifactRef,
  type LearningArtifactLimits, type LearningArtifactOwnerOptions,
} from '../src/learning-artifacts.ts'
import { evaluateLearning, METRICS, type Count, type MetricName, type OutcomeRecord } from '../src/learning-evaluation.ts'
import { FIXTURE_TIME, LearningFixtureArtifacts, LearningFixtureSigners } from './learning-graph-fixture.ts'

const artifacts: LearningFixtureArtifacts[] = []
const limits: LearningArtifactLimits = {
  maxArtifactBytes: 8192, maxArtifactsPerReceipt: 32, maxTotalArtifactBytes: 32768,
  maxArtifactGraphDepth: 8, maxChildRequestBytes: 4096, maxChildResponseBytes: 8192, timeoutMs: 1000,
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const value of artifacts.splice(0)) value.dispose()
})

function fixture() {
  const store = new LearningFixtureArtifacts()
  artifacts.push(store)
  const signers = new LearningFixtureSigners()
  const options: LearningArtifactOwnerOptions = {
    artifactRoot: store.root, limits,
    evaluator: { authorityId: signers.evaluatorId, ...signers.evaluatorPublic },
    journal: { signerId: signers.journalId, ...signers.journalPublic },
  }
  return { store, signers, options, owner: createLearningArtifactOwner(options) }
}

function artifactBytes(root: string) {
  return readdirSync(root, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile())
    .map(entry => [join(entry.parentPath, entry.name), readFileSync(join(entry.parentPath, entry.name))])
}

describe('artifact public value boundaries', () => {
  it.each(['accessor', 'nonenumerable', 'symbol'] as const)('rejects an artifact reference with a %s field without invoking user code', (field) => {
    const value = fixture()
    const ref = { ...value.store.put({ marker: true }) }
    const getter = vi.fn(() => 2)
    if (field === 'accessor') Object.defineProperty(ref, 'bytes', { enumerable: true, get: getter })
    if (field === 'nonenumerable') Object.defineProperty(ref, 'bytes', { enumerable: false, value: ref.bytes })
    if (field === 'symbol') {
      Reflect.deleteProperty(ref, 'bytes')
      Object.defineProperty(ref, Symbol('bytes'), { enumerable: true, value: 2 })
    }
    const before = artifactBytes(value.store.root)
    expect(() => parseArtifactRef(ref)).toThrow('learning evidence rejected')
    expect(getter).not.toHaveBeenCalled()
    expect(artifactBytes(value.store.root)).toEqual(before)
  })

  it.each(['array-accessor', 'array-hidden', 'object-accessor', 'object-hidden'] as const)(
    'rejects %s JSON descriptors without invoking user code', (kind) => {
      const getter = vi.fn(() => 'not evaluated')
      const value = kind.startsWith('array') ? ['initial'] : { item: 'initial' }
      const key = Array.isArray(value) ? '0' : 'item'
      Object.defineProperty(value, key, kind.endsWith('accessor')
        ? { enumerable: true, get: getter } : { enumerable: false, value: 'hidden' })
      expect(() => canonicalLearningJson(value)).toThrow('learning evidence rejected')
      expect(getter).not.toHaveBeenCalled()
    },
  )

  it('retains valid surrogate pairs and rejects unpaired or out-of-range second code units', () => {
    const text = 'Literal \ud800\udc00 and \udbff\udfff survive exactly.'
    const encoded = canonicalLearningJson({ text })
    expect(decodeCanonicalJson(Buffer.from(encoded))).toEqual({ text })
    for (const invalid of ['\ud800\ue000', '\udc00']) {
      expect(() => canonicalLearningJson({ text: invalid })).toThrow('learning evidence rejected')
      expect(() => decodeCanonicalJson(Buffer.from(JSON.stringify({ text: invalid })))).toThrow('learning evidence rejected')
    }
  })

  it.each([42, 'not a public key', '-----BEGIN PUBLIC KEY-----\ninvalid\n-----END PUBLIC KEY-----'])('rejects malformed public anchor %j', (pem) => {
    const value = fixture()
    const before = artifactBytes(value.store.root)
    expect(() => createLearningArtifactOwner({ ...value.options,
      // The launcher boundary validates runtime input even when an untyped caller violates its static type.
      evaluator: { ...value.options.evaluator, publicKeySpkiPem: pem as string } })).toThrow('learning evidence rejected')
    expect(artifactBytes(value.store.root)).toEqual(before)
  })

  it('rejects an ordinary file selected as the artifact root without altering it', () => {
    const value = fixture()
    const ref = value.store.put({ marker: 'ordinary file' })
    const before = artifactBytes(value.store.root)
    expect(() => createLearningArtifactOwner({ ...value.options, artifactRoot: value.store.path(ref) }))
      .toThrow('learning evidence rejected')
    expect(artifactBytes(value.store.root)).toEqual(before)
  })
})

describe('artifact proof and traversal bounds', () => {
  it.each(['issuedAt', 'expiresAt', 'now'] as const)('rejects a non-string %s even with an authentic test signature', (field) => {
    const value = fixture()
    const changes = field === 'now' ? {} : { [field]: 1 }
    const envelope = value.signers.evaluatorEnvelope('measurement-definition', { fixture: true }, null, changes)
    expect(() => value.owner.proofs.verifyEvaluatorEnvelope(envelope, 'measurement-definition',
      field === 'now' ? 1 as unknown as string : FIXTURE_TIME.now)).toThrow('learning evidence rejected')
  })

  it.each(['measurement-definition', 'trial-initiation-capability'] as const)(
    'requires both standalone request fields to be null for %s', (kind) => {
      const value = fixture()
      const request = value.store.put({ operation: 'synthetic-request' })
      const before = artifactBytes(value.store.root)
      for (const change of [{ requestHash: request.digest }, { requestArtifact: request }]) {
        const envelope = value.signers.evaluatorEnvelope(kind, { fixture: true }, null, change)
        expect(() => value.owner.proofs.verifyEvaluatorEnvelope(envelope, kind, FIXTURE_TIME.now))
          .toThrow('learning evidence rejected')
      }
      const valid = value.signers.evaluatorEnvelope(kind, { fixture: true })
      expect(value.owner.proofs.verifyEvaluatorEnvelope(valid, kind, FIXTURE_TIME.now)).toMatchObject({
        requestHash: null, requestArtifact: null, kind,
      })
      expect(artifactBytes(value.store.root)).toEqual(before)
    },
  )

  it.each(['evaluator', 'journal'] as const)('does not accept a valid %s signature after its deadline', (role) => {
    const value = fixture()
    const envelope = role === 'evaluator'
      ? value.signers.evaluatorEnvelope('measurement-definition', { fixture: true })
      : value.signers.journalEnvelope('event', { fixture: true })
    const before = artifactBytes(value.store.root)
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0).mockReturnValueOnce(0).mockReturnValueOnce(limits.timeoutMs + 1)
    const verify = () => role === 'evaluator'
      ? value.owner.proofs.verifyEvaluatorEnvelope(envelope, 'measurement-definition', FIXTURE_TIME.now)
      : value.owner.proofs.verifyJournalEnvelope(envelope, 'event')
    expect(verify).toThrow('learning evidence rejected')
    clock.mockReturnValue(0)
    expect(verify()).toMatchObject({ payload: { fixture: true } })
    expect(artifactBytes(value.store.root)).toEqual(before)
  })

  it('accepts the exact journal envelope size and rejects one byte over the owner bound', () => {
    const value = fixture()
    const envelope = value.signers.journalEnvelope('event', { fixture: 'bounded journal envelope' })
    const size = Buffer.byteLength(canonicalLearningJson(envelope))
    const bounded = (maxArtifactBytes: number) => createLearningArtifactOwner({
      ...value.options, limits: { ...limits, maxArtifactBytes },
    })
    expect(bounded(size).proofs.verifyJournalEnvelope(envelope, 'event')).toEqual(envelope)
    expect(() => bounded(size - 1).proofs.verifyJournalEnvelope(envelope, 'event')).toThrow('learning evidence rejected')
  })

  it.each(['unknown', 'symbol', 'zero', 'fraction'] as const)('rejects %s traversal limits without resetting consumption', (kind) => {
    const value = fixture()
    const ref = value.store.put({ fixture: true })
    const traversal = value.owner.createTraversal({ maxArtifactsPerReceipt: 2 })
    expect(traversal.visit(ref, bytes => bytes.length)).toBe(ref.bytes)
    const original = traversal.limits
    const invalid = kind === 'unknown' ? { unrecognizedBudget: 1 }
      : kind === 'symbol' ? { [Symbol('maxArtifactBytes')]: 1 }
        : { maxArtifactBytes: kind === 'zero' ? 0 : 1.5 }
    expect(() => { traversal.narrowLimits(invalid) }).toThrow('learning evidence rejected')
    expect(traversal.limits).toBe(original)
    expect(traversal.visit(ref, bytes => bytes.length)).toBe(ref.bytes)
    expect(() => traversal.visit(ref, () => 'not admitted')).toThrow('learning evidence rejected')
  })

  it('rejects an active digest cycle, clears the active stack and keeps charged edges', () => {
    const value = fixture()
    const ref = value.store.put({ marker: 'cycle' })
    const traversal = value.owner.createTraversal({ maxArtifactsPerReceipt: 3 })
    const inner = vi.fn(() => 'not admitted')
    expect(() => traversal.visit(ref, () => traversal.visit(ref, inner))).toThrow('learning evidence rejected')
    expect(inner).not.toHaveBeenCalled()
    expect(traversal.visit(ref, bytes => bytes.length)).toBe(ref.bytes)
    expect(() => traversal.visit(ref, inner)).toThrow('learning evidence rejected')
    expect(inner).not.toHaveBeenCalled()
  })
})

function counts(numerator = 1, denominator = 1): Record<MetricName, Count> {
  return Object.fromEntries(Object.keys(METRICS).map(name => [name, { numerator, denominator }])) as Record<MetricName, Count>
}

function outcome(variant: OutcomeRecord['variant'], overrides: Partial<OutcomeRecord> = {}): OutcomeRecord {
  return {
    pairId: 'synthetic-pair', variant, model: 'synthetic-model', modelConfigHash: 'a'.repeat(64),
    taskHash: 'b'.repeat(64), goalHash: 'c'.repeat(64), policyHash: 'd'.repeat(64),
    producerId: `synthetic-${variant}-producer`, evaluatorId: `synthetic-${variant}-evaluator`,
    verificationStatus: 'verified', evidenceRefs: [`synthetic-evidence-${variant}`], counts: counts(), ...overrides,
  }
}

describe('paired evaluation refusal and missing evidence', () => {
  it.each(['baseline', 'candidate'] as const)('rejects duplicate %s arms without mutating evidence', (variant) => {
    const record = outcome(variant)
    const before = structuredClone(record)
    expect(() => evaluateLearning({ schemaVersion: 1, records: [record, record] })).toThrow(`duplicate ${variant} outcome`)
    expect(record).toEqual(before)
  })

  it.each(['model', 'modelConfigHash', 'taskHash', 'goalHash', 'policyHash'] as const)('refuses unmatched %s instead of comparing rates', (field) => {
    const candidate = outcome('candidate', { [field]: field === 'model' ? 'another-model' : 'f'.repeat(64) })
    expect(() => evaluateLearning({ schemaVersion: 1, records: [outcome('baseline'), candidate] })).toThrow(`differs in ${field}`)
  })

  it('rejects an evaluator who also produced the other arm', () => {
    const baseline = outcome('baseline')
    const candidate = outcome('candidate', { evaluatorId: baseline.producerId })
    expect(() => evaluateLearning({ schemaVersion: 1, records: [baseline, candidate] })).toThrow('reuses a producer identity as an evaluator')
  })

  it.each(['missing-baseline', 'missing-candidate', 'unknown', 'rejected'] as const)('keeps an incomplete comparison UNKNOWN: %s', (fault) => {
    const records = fault === 'missing-baseline' ? [outcome('candidate')]
      : fault === 'missing-candidate' ? [outcome('baseline')]
        : [outcome('baseline'), outcome('candidate', { verificationStatus: fault })]
    const result = evaluateLearning({ schemaVersion: 1, records })
    expect(result.verifiedPairs).toBe(0)
    expect(result.metrics.knowledgeUtility).toEqual({ status: 'UNKNOWN', reason: 'complete independently verified pairs are required' })
    expect(result.evidenceRefs).toEqual([])
    expect(result.smartnessClaim.status).toBe('UNKNOWN')
  })

  it.each(['baseline', 'candidate'] as const)('does not invent missing or zero-denominator %s opportunities', (variant) => {
    for (const count of [undefined, { numerator: 0, denominator: 0 }]) {
      const incomplete: Partial<Record<MetricName, Count>> = counts()
      if (count === undefined) delete incomplete.knowledgeUtility
      else incomplete.knowledgeUtility = count
      const baseline = outcome('baseline', variant === 'baseline' ? { counts: incomplete } : {})
      const candidate = outcome('candidate', variant === 'candidate' ? { counts: incomplete } : {})
      const result = evaluateLearning({ schemaVersion: 1, records: [baseline, candidate] })
      expect(result.verifiedPairs).toBe(1)
      expect(result.metrics.knowledgeUtility).toEqual({ status: 'UNKNOWN', reason: 'missing knowledgeUtility opportunities in a pair' })
      expect(result.smartnessClaim.status).toBe('UNKNOWN')
    }
  })

  it('accepts exactly safe aggregate counts and refuses overflow in the next complete pair', () => {
    const d = Number.MAX_SAFE_INTEGER
    const records = [
      outcome('baseline', { counts: counts(d - 1, d - 1) }), outcome('candidate', { counts: counts(d - 1, d - 1) }),
      outcome('baseline', { pairId: 'synthetic-pair-2' }), outcome('candidate', { pairId: 'synthetic-pair-2' }),
    ]
    const result = evaluateLearning({ schemaVersion: 1, records })
    expect(result.metrics.knowledgeUtility).toEqual({ status: 'UNCHANGED',
      baseline: { numerator: d, denominator: d, rate: 1 }, candidate: { numerator: d, denominator: d, rate: 1 }, delta: 0 })
    expect(() => evaluateLearning({ schemaVersion: 1, records: [...records,
      outcome('baseline', { pairId: 'synthetic-pair-3' }), outcome('candidate', { pairId: 'synthetic-pair-3' }),
    ] })).toThrow('aggregate exceeds safe integer counts')
  })

  it('reports regression and incomplete repair opportunities without a supported improvement claim', () => {
    const result = evaluateLearning({ schemaVersion: 1, records: [outcome('baseline'), outcome('candidate', { counts: {
      ...counts(), knowledgeUtility: { numerator: 0, denominator: 1 }, repairReuseSuccess: { numerator: 1, denominator: 2 },
    } })] })
    expect(result.metrics.knowledgeUtility).toMatchObject({ status: 'REGRESSED', delta: -1 })
    expect(result.smartnessClaim.status).toBe('NOT_SUPPORTED')
    expect(result.smartnessClaim.reasons).toContain('repairReuseSuccess has an unverified or unsuccessful opportunity')
    expect(result.smartnessClaim.reasons).toContain('knowledgeUtility did not improve')
    expect(result.evidenceRefs).toEqual(['synthetic-evidence-baseline', 'synthetic-evidence-candidate'])
  })
})
