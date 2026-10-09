import { describe, expect, it } from 'vitest'
import { evaluateLearning, parseEvaluationInput } from './evaluate-learning.ts'

const HASH = 'a'.repeat(64)
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
  return {
    pairId: 'pair-1', variant, model: 'model', modelConfigHash: HASH, taskHash: HASH,
    goalHash: HASH, policyHash: HASH, producerId: `${variant}-producer`, evaluatorId: `${variant}-evaluator`,
    verificationStatus: 'verified', evidenceRefs: [`evidence-${variant}`], counts: counts(0), ...overrides,
  }
}

describe('learning evaluation', () => {
  it('aggregates verified pairs and applies metric direction', () => {
    const baseline = record('baseline', { counts: {
      ...counts(1), verifiedTaskSuccess: { numerator: 0, denominator: 1 }, knowledgeUtility: { numerator: 0, denominator: 1 },
    } })
    const candidate = record('candidate', { counts: {
      ...counts(0), verifiedTaskSuccess: { numerator: 1, denominator: 1 }, knowledgeUtility: { numerator: 1, denominator: 1 },
      repairReuseSuccess: { numerator: 1, denominator: 1 }, conflictDetectionRate: { numerator: 1, denominator: 1 },
      conflictEscalationRate: { numerator: 1, denominator: 1 }, replayExplainability: { numerator: 1, denominator: 1 },
    } })
    const result = evaluateLearning(parseEvaluationInput({ schemaVersion: 1, records: [baseline, candidate] }))
    expect(result.metrics.repeatedErrorRate.status).toBe('IMPROVED')
    expect(result.metrics.verifiedTaskSuccess.status).toBe('IMPROVED')
    expect(result.smartnessClaim.status).toBe('SUPPORTED')
    expect(result.evidenceRefs).toEqual(['evidence-baseline', 'evidence-candidate'])
  })

  it('returns UNKNOWN for an unpaired or unverified comparison', () => {
    const result = evaluateLearning(parseEvaluationInput({
      schemaVersion: 1,
      records: [record('baseline', { verificationStatus: 'unknown' })],
    }))
    expect(result.totalPairs).toBe(1)
    expect(result.verifiedPairs).toBe(0)
    expect(result.metrics.knowledgeUtility.status).toBe('UNKNOWN')
    expect(result.smartnessClaim.status).toBe('UNKNOWN')
  })

  it('rejects mismatched pair identities and duplicate variants', () => {
    expect(() => evaluateLearning(parseEvaluationInput({ schemaVersion: 1, records: [
      record('baseline'), record('candidate', { taskHash: 'b'.repeat(64) }),
    ] }))).toThrow(/differs in taskHash/)
    expect(() => evaluateLearning(parseEvaluationInput({ schemaVersion: 1, records: [
      record('baseline'), record('baseline'),
    ] }))).toThrow(/duplicate baseline/)
  })

  it('rejects a verified record without independent evidence', () => {
    expect(() => parseEvaluationInput({ schemaVersion: 1, records: [record('baseline', {
      producerId: 'same', evaluatorId: 'same', evidenceRefs: [],
    })] })).toThrow(/independent evidence/)
  })

  it('rejects unsafe or duplicate evidence references and normalizes safe refs', () => {
    for (const evidenceRefs of [['../outside.json'], ['/tmp/outcome.json'], ['\\\\server\\share\\outcome.json'], ['file:///tmp/outcome.json'], ['evidence/ok\nspoof'], ['evidence/ok', 'evidence/ok']]) {
      expect(() => parseEvaluationInput({ schemaVersion: 1, records: [record('baseline', { evidenceRefs })] })).toThrow(/evidenceRefs/)
    }
    const parsed = parseEvaluationInput({ schemaVersion: 1, records: [record('baseline', {
      evidenceRefs: ['https://example.test/z', 'evidence/a.json', 'https://example.test/a'],
    })] })
    expect(parsed.records[0]?.evidenceRefs).toEqual(['evidence/a.json', 'https://example.test/a', 'https://example.test/z'])
  })

  it('rejects a verified pair whose producer and evaluator identities cross', () => {
    expect(() => evaluateLearning(parseEvaluationInput({ schemaVersion: 1, records: [
      record('baseline', { producerId: 'baseline-producer', evaluatorId: 'independent-evaluator' }),
      record('candidate', { producerId: 'candidate-producer', evaluatorId: 'baseline-producer' }),
    ] }))).toThrow(/reuses a producer identity as an evaluator/)
  })

  it('returns UNKNOWN when a metric has no opportunities', () => {
    const noOpportunity = { numerator: 0, denominator: 0 }
    const result = evaluateLearning(parseEvaluationInput({ schemaVersion: 1, records: [
      record('baseline', { counts: { ...counts(0), staleRecallRate: noOpportunity } }),
      record('candidate', { counts: { ...counts(0), staleRecallRate: noOpportunity } }),
    ] }))
    expect(result.metrics.staleRecallRate.status).toBe('UNKNOWN')
  })

  it.each([
    ['knowledgeUtility', false, 'IMPROVED'],
    ['knowledgeUtility', true, 'REGRESSED'],
    ['repeatedErrorRate', false, 'REGRESSED'],
    ['repeatedErrorRate', true, 'IMPROVED'],
  ] as const)('compares distinct large fractions exactly for %s (reverse=%s)', (metric, reverse, status) => {
    const d = Number.MAX_SAFE_INTEGER
    const lower = { numerator: d - 2, denominator: d - 1 }
    const higher = { numerator: d - 1, denominator: d }
    const result = evaluateLearning(parseEvaluationInput({ schemaVersion: 1, records: [
      record('baseline', { counts: { ...counts(0), [metric]: reverse ? higher : lower } }),
      record('candidate', { counts: { ...counts(0), [metric]: reverse ? lower : higher } }),
    ] }))
    const comparison = result.metrics[metric]
    expect(comparison.status).toBe(status)
    if (comparison.status === 'UNKNOWN') throw new Error('comparison unexpectedly lacks opportunities')
    expect(comparison.baseline.rate).toBe(comparison.candidate.rate)
    // These adjacent fractions differ by exactly 1 / (d * (d - 1)).
    expect(comparison.delta).toBe((reverse ? -1 : 1) / (d * (d - 1)))
  })

  it('keeps equivalent large fractions unchanged', () => {
    const d = Number.MAX_SAFE_INTEGER - 1
    const result = evaluateLearning(parseEvaluationInput({ schemaVersion: 1, records: [
      record('baseline', { counts: { ...counts(0), knowledgeUtility: { numerator: d / 2 - 1, denominator: d / 2 } } }),
      record('candidate', { counts: { ...counts(0), knowledgeUtility: { numerator: d - 2, denominator: d } } }),
    ] }))
    expect(result.metrics.knowledgeUtility).toMatchObject({ status: 'UNCHANGED', delta: 0 })
  })

  it('accepts the safe aggregate boundary and rejects overflow', () => {
    const d = Number.MAX_SAFE_INTEGER
    const records = [
      record('baseline', { counts: counts(d - 2, d - 1) }),
      record('candidate', { counts: counts(d - 2, d - 1) }),
      record('baseline', { pairId: 'pair-2', counts: counts(1) }),
      record('candidate', { pairId: 'pair-2', counts: counts(1) }),
    ]
    const result = evaluateLearning(parseEvaluationInput({ schemaVersion: 1, records }))
    expect(result.metrics.knowledgeUtility).toMatchObject({
      status: 'UNCHANGED', baseline: { numerator: d - 1, denominator: d }, candidate: { numerator: d - 1, denominator: d }, delta: 0,
    })
    expect(() => evaluateLearning(parseEvaluationInput({ schemaVersion: 1, records: [
      ...records,
      record('baseline', { pairId: 'pair-3', counts: counts(0) }),
      record('candidate', { pairId: 'pair-3', counts: counts(0) }),
    ] }))).toThrow(/aggregate exceeds safe integer counts/)
  })
})
