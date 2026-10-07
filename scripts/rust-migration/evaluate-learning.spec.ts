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

  it('returns UNKNOWN when a metric has no opportunities', () => {
    const noOpportunity = { numerator: 0, denominator: 0 }
    const result = evaluateLearning(parseEvaluationInput({ schemaVersion: 1, records: [
      record('baseline', { counts: { ...counts(0), staleRecallRate: noOpportunity } }),
      record('candidate', { counts: { ...counts(0), staleRecallRate: noOpportunity } }),
    ] }))
    expect(result.metrics.staleRecallRate.status).toBe('UNKNOWN')
  })
})
