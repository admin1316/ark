import { describe, expect, it } from 'vitest'
import { generateKeyPairSync, sign } from 'node:crypto'
import { canonicalJson } from '../../packages/host/knowledge-wiki/src/verifier.ts'
import { evaluateLearning, parseEvaluationInput, parseTrustedEvaluatorKeys } from './evaluate-learning.ts'

const HASH = 'a'.repeat(64)
const AUTHORITY_ID = 'independent-evaluator'
const CANDIDATE_AUTHORITY_ID = 'candidate-evaluator'
const KEY_PAIR = generateKeyPairSync('ed25519')
const CANDIDATE_KEY_PAIR = generateKeyPairSync('ed25519')
const TRUSTED_EVALUATOR_KEYS = {
  [AUTHORITY_ID]: KEY_PAIR.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  [CANDIDATE_AUTHORITY_ID]: CANDIDATE_KEY_PAIR.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
}
const METRICS = [
  'repeatedErrorRate', 'repeatedToolCallRate', 'verifiedTaskSuccess', 'falseRecallRate', 'staleRecallRate',
  'conflictDetectionRate', 'memoryCorrectionRate', 'recoverySuccess', 'knowledgeUtility',
  'crossSessionLeakage', 'falseCompletionRate', 'userCorrectionFrequency', 'memoryPrivilegeEscalation',
  'memoryPoisoning', 'repairReuseSuccess', 'conflictEscalationRate', 'replayExplainability',
] as const

function counts(numerator: number, denominator = 1): Record<string, { numerator: number; denominator: number }> {
  return Object.fromEntries(METRICS.map(metric => [metric, { numerator, denominator }]))
}

function record(variant: 'baseline' | 'candidate', overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const evaluatorId = typeof overrides['evaluatorId'] === 'string' ? overrides['evaluatorId'] : AUTHORITY_ID
  const unsigned = {
    pairId: 'pair-1', variant, model: 'model', modelConfigHash: HASH, taskHash: HASH,
    goalHash: HASH, policyHash: HASH, producerId: `${variant}-producer`, evaluatorId,
    verificationStatus: 'verified', evidenceRefs: [`evidence-${variant}`], counts: counts(0), ...overrides,
  }
  if (unsigned.verificationStatus !== 'verified') return unsigned
  const payload = { ...unsigned, authorityId: unsigned.evaluatorId }
  const keyPair = evaluatorId === AUTHORITY_ID ? KEY_PAIR : CANDIDATE_KEY_PAIR
  const signature = sign(null, Buffer.from(canonicalJson(payload), 'utf8'), keyPair.privateKey).toString('base64')
  return { ...payload, signature }
}

function improvedPair(falseRecallNumerator = 0): [Record<string, unknown>, Record<string, unknown>] {
  return [
    record('baseline', { counts: {
      ...counts(1), verifiedTaskSuccess: { numerator: 0, denominator: 1 }, knowledgeUtility: { numerator: 0, denominator: 1 },
      memoryCorrectionRate: { numerator: 0, denominator: 1 }, recoverySuccess: { numerator: 0, denominator: 1 },
      falseRecallRate: { numerator: 0, denominator: 1 },
    } }),
    record('candidate', { counts: {
      ...counts(0), verifiedTaskSuccess: { numerator: 1, denominator: 1 }, knowledgeUtility: { numerator: 1, denominator: 1 },
      memoryCorrectionRate: { numerator: 1, denominator: 1 }, recoverySuccess: { numerator: 1, denominator: 1 },
      repairReuseSuccess: { numerator: 1, denominator: 1 }, conflictDetectionRate: { numerator: 1, denominator: 1 },
      conflictEscalationRate: { numerator: 1, denominator: 1 }, replayExplainability: { numerator: 1, denominator: 1 },
      falseRecallRate: { numerator: falseRecallNumerator, denominator: 1 },
    } }),
  ]
}

describe('learning evaluation', () => {
  it('aggregates verified pairs and applies metric direction', () => {
    const [baseline, candidate] = improvedPair()
    const result = evaluateLearning(parseEvaluationInput({ schemaVersion: 1, records: [baseline, candidate] }), TRUSTED_EVALUATOR_KEYS)
    expect(result.metrics.repeatedErrorRate.status).toBe('IMPROVED')
    expect(result.metrics.verifiedTaskSuccess.status).toBe('IMPROVED')
    expect(result.smartnessClaim.status).toBe('SUPPORTED')
    expect(result.evidenceRefs).toEqual(['evidence-baseline', 'evidence-candidate'])
  })

  it('returns UNKNOWN for an unpaired or unverified comparison', () => {
    const result = evaluateLearning(parseEvaluationInput({
      schemaVersion: 1,
      records: [record('baseline', { verificationStatus: 'unknown' })],
    }), TRUSTED_EVALUATOR_KEYS)
    expect(result.totalPairs).toBe(1)
    expect(result.verifiedPairs).toBe(0)
    expect(result.metrics.knowledgeUtility.status).toBe('UNKNOWN')
    expect(result.smartnessClaim.status).toBe('UNKNOWN')
  })

  it('rejects mismatched pair identities and duplicate variants', () => {
    expect(() => evaluateLearning(parseEvaluationInput({ schemaVersion: 1, records: [
      record('baseline'), record('candidate', { taskHash: 'b'.repeat(64) }),
    ] }), TRUSTED_EVALUATOR_KEYS)).toThrow(/differs in taskHash/)
    expect(() => evaluateLearning(parseEvaluationInput({ schemaVersion: 1, records: [
      record('baseline'), record('baseline'),
    ] }), TRUSTED_EVALUATOR_KEYS)).toThrow(/duplicate baseline/)
  })

  it('rejects a verified record without independent evidence', () => {
    expect(() => parseEvaluationInput({ schemaVersion: 1, records: [record('baseline', {
      producerId: 'same', evaluatorId: 'same', evidenceRefs: [],
    })] })).toThrow(/independent evidence/)
  })

  it.each([
    ['/Users/hui/private-key.txt', 'must be relative or a URL'],
    ['C:\\Users\\hui\\private-key.txt', 'must be relative or a URL'],
    ['file:///Users/hui/private-key.txt', 'must be relative or a URL'],
    ['../../private-key.txt', 'must not contain path traversal'],
    ['evidence\u0000secret', 'contains control characters'],
    [' evidence.txt ', 'must not have surrounding whitespace'],
  ])('rejects unsafe evidence reference %j', (ref, message) => {
    expect(() => parseEvaluationInput({ schemaVersion: 1, records: [record('baseline', { evidenceRefs: [ref] })] }))
      .toThrow(message)
  })

  it('rejects duplicate evidence references', () => {
    expect(() => parseEvaluationInput({ schemaVersion: 1, records: [record('baseline', {
      evidenceRefs: ['same-evidence', 'same-evidence'],
    })] })).toThrow(/must not contain duplicates/)
  })

  it('requires evidence references to use canonical sorted order', () => {
    expect(() => parseEvaluationInput({ schemaVersion: 1, records: [record('baseline', {
      evidenceRefs: ['z-evidence', 'a-evidence'],
    })] })).toThrow(/must be in sorted order/)
  })

  it('requires evaluator identities to remain independent from both pair producers', () => {
    const baseline = record('baseline', { pairId: 'cross-role-pair', producerId: 'baseline-producer' })
    const candidate = record('candidate', {
      pairId: 'cross-role-pair', producerId: AUTHORITY_ID, evaluatorId: CANDIDATE_AUTHORITY_ID,
    })
    expect(() => evaluateLearning(parseEvaluationInput({ schemaVersion: 1, records: [baseline, candidate] }), TRUSTED_EVALUATOR_KEYS))
      .toThrow(/reuses a producer identity as an evaluator/)
  })

  it('rejects unsigned, tampered, or untrusted evaluator attestations', () => {
    const verified = record('baseline')
    const { signature: _signature, ...unsigned } = verified
    expect(() => parseEvaluationInput({ schemaVersion: 1, records: [unsigned] })).toThrow(/signature from their independent evaluator/)
    const tampered = { ...verified, counts: counts(1) }
    const input = parseEvaluationInput({ schemaVersion: 1, records: [tampered] })
    expect(() => evaluateLearning(input, TRUSTED_EVALUATOR_KEYS)).toThrow(/invalid evaluator signature/)
    expect(() => evaluateLearning(parseEvaluationInput({ schemaVersion: 1, records: [verified] }), {})).toThrow(/untrusted evaluator/)
  })

  it('does not trust inherited keys or special object properties', () => {
    const inheritedKeys = Object.create(TRUSTED_EVALUATOR_KEYS) as typeof TRUSTED_EVALUATOR_KEYS
    expect(() => evaluateLearning(parseEvaluationInput({ schemaVersion: 1, records: [record('baseline')] }), inheritedKeys)).toThrow(/untrusted evaluator/)
    const parsed = parseTrustedEvaluatorKeys(JSON.parse(JSON.stringify(TRUSTED_EVALUATOR_KEYS)) as unknown)
    expect(Object.getPrototypeOf(parsed)).toBeNull()
    expect(parsed[AUTHORITY_ID]).toBe(TRUSTED_EVALUATOR_KEYS[AUTHORITY_ID])
  })

  it('does not support a smartness claim when any measured quality metric regresses', () => {
    const [baseline, candidate] = improvedPair(1)
    const result = evaluateLearning(parseEvaluationInput({ schemaVersion: 1, records: [baseline, candidate] }), TRUSTED_EVALUATOR_KEYS)
    expect(result.metrics.falseRecallRate.status).toBe('REGRESSED')
    expect(result.smartnessClaim.status).toBe('NOT_SUPPORTED')
    expect(result.smartnessClaim.reasons).toContain('falseRecallRate regressed')
  })

  it('returns UNKNOWN when a metric has no opportunities', () => {
    const noOpportunity = { numerator: 0, denominator: 0 }
    const result = evaluateLearning(parseEvaluationInput({ schemaVersion: 1, records: [
      record('baseline', { counts: { ...counts(0), staleRecallRate: noOpportunity } }),
      record('candidate', { counts: { ...counts(0), staleRecallRate: noOpportunity } }),
    ] }), TRUSTED_EVALUATOR_KEYS)
    expect(result.metrics.staleRecallRate.status).toBe('UNKNOWN')
  })
})
