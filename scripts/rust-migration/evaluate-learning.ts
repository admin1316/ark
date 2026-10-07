import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** Explicit opportunity counts; rates are never inferred from memory volume. */
export const METRICS = {
  repeatedErrorRate: 'lower',
  repeatedToolCallRate: 'lower',
  verifiedTaskSuccess: 'higher',
  falseRecallRate: 'lower',
  staleRecallRate: 'lower',
  conflictDetectionRate: 'higher',
  memoryCorrectionRate: 'higher',
  recoverySuccess: 'higher',
  knowledgeUtility: 'higher',
  crossSessionLeakage: 'lower',
  falseCompletionRate: 'lower',
  userCorrectionFrequency: 'lower',
  memoryPrivilegeEscalation: 'lower',
  memoryPoisoning: 'lower',
  repairReuseSuccess: 'higher',
  conflictEscalationRate: 'higher',
  replayExplainability: 'higher',
} as const

type MetricName = keyof typeof METRICS
export interface Count {
  readonly numerator: number
  readonly denominator: number
}
export interface OutcomeRecord {
  readonly pairId: string
  readonly variant: 'baseline' | 'candidate'
  readonly model: string
  readonly modelConfigHash: string
  readonly taskHash: string
  readonly goalHash: string
  readonly policyHash: string
  readonly producerId: string
  readonly evaluatorId: string
  readonly verificationStatus: 'verified' | 'unknown' | 'rejected'
  readonly evidenceRefs: readonly string[]
  readonly counts: Partial<Record<MetricName, Count>>
}
export interface EvaluationInput {
  readonly schemaVersion: 1
  readonly records: readonly OutcomeRecord[]
}
export type MetricComparison = {
  readonly status: 'UNKNOWN'
  readonly reason: string
} | {
  readonly status: 'IMPROVED' | 'REGRESSED' | 'UNCHANGED'
  readonly baseline: Count & { readonly rate: number }
  readonly candidate: Count & { readonly rate: number }
  readonly delta: number
}

function object(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${context} must be an object`)
  return value as Record<string, unknown>
}

function keys(value: Record<string, unknown>, allowed: readonly string[], context: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${context} has unknown field ${key}`)
  }
}

function string(value: unknown, context: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${context} must be a non-empty string`)
  return value
}

function hash(value: unknown, context: string): string {
  const result = string(value, context)
  if (!/^[a-f0-9]{64}$/u.test(result)) throw new Error(`${context} must be a lowercase SHA-256`)
  return result
}

/**
 * Parse the versioned JSON boundary and reject malformed counts or claimed self-verification.
 * @param value - JSON-decoded input.
 * @returns Validated records; source evidence still needs an independent evaluator.
 */
export function parseEvaluationInput(value: unknown): EvaluationInput {
  const input = object(value, 'input')
  keys(input, ['schemaVersion', 'records'], 'input')
  if (input['schemaVersion'] !== 1 || !Array.isArray(input['records'])) throw new Error('input requires schemaVersion 1 and records')
  const records = input['records'].map((raw, index): OutcomeRecord => {
    const context = `records[${index}]`
    const record = object(raw, context)
    keys(record, ['pairId', 'variant', 'model', 'modelConfigHash', 'taskHash', 'goalHash', 'policyHash', 'producerId', 'evaluatorId', 'verificationStatus', 'evidenceRefs', 'counts'], context)
    const variant = record['variant']
    const verificationStatus = record['verificationStatus']
    if (variant !== 'baseline' && variant !== 'candidate') throw new Error(`${context}.variant is invalid`)
    if (verificationStatus !== 'verified' && verificationStatus !== 'unknown' && verificationStatus !== 'rejected') throw new Error(`${context}.verificationStatus is invalid`)
    const producerId = string(record['producerId'], `${context}.producerId`)
    const evaluatorId = string(record['evaluatorId'], `${context}.evaluatorId`)
    if (!Array.isArray(record['evidenceRefs'])) throw new Error(`${context}.evidenceRefs must be an array`)
    const evidenceRefs = record['evidenceRefs'].map((ref, refIndex) => string(ref, `${context}.evidenceRefs[${refIndex}]`))
    if (verificationStatus === 'verified' && (producerId === evaluatorId || evidenceRefs.length === 0)) throw new Error(`${context} verified outcomes require independent evidence`)
    const rawCounts = object(record['counts'], `${context}.counts`)
    keys(rawCounts, Object.keys(METRICS), `${context}.counts`)
    const counts: Partial<Record<MetricName, Count>> = {}
    for (const [metric, rawCount] of Object.entries(rawCounts)) {
      const count = object(rawCount, `${context}.counts.${metric}`)
      keys(count, ['numerator', 'denominator'], `${context}.counts.${metric}`)
      const numerator = count['numerator']
      const denominator = count['denominator']
      if (typeof numerator !== 'number' || typeof denominator !== 'number' || !Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || numerator < 0 || denominator < numerator) throw new Error(`${context}.counts.${metric} requires non-negative safe counts with numerator <= denominator`)
      counts[metric as MetricName] = { numerator, denominator }
    }
    return {
      pairId: string(record['pairId'], `${context}.pairId`), variant,
      model: string(record['model'], `${context}.model`),
      modelConfigHash: hash(record['modelConfigHash'], `${context}.modelConfigHash`),
      taskHash: hash(record['taskHash'], `${context}.taskHash`),
      goalHash: hash(record['goalHash'], `${context}.goalHash`),
      policyHash: hash(record['policyHash'], `${context}.policyHash`),
      producerId, evaluatorId, verificationStatus, evidenceRefs, counts,
    }
  })
  return { schemaVersion: 1, records }
}

/**
 * Compare complete, independently verified same-model and same-task pairs.
 * @param input - Validated outcome records.
 * @returns Deterministic rate comparisons and a conservative evidence verdict, never a release approval.
 */
export function evaluateLearning(input: EvaluationInput): {
  readonly schemaVersion: 1
  readonly totalPairs: number
  readonly verifiedPairs: number
  readonly evidenceRefs: readonly string[]
  readonly metrics: Record<MetricName, MetricComparison>
  readonly knowledgeUtilityLift: MetricComparison
  readonly smartnessClaim: { readonly status: 'SUPPORTED' | 'NOT_SUPPORTED' | 'UNKNOWN'; readonly reasons: readonly string[] }
} {
  const pairMap = new Map<string, Partial<Record<OutcomeRecord['variant'], OutcomeRecord>>>()
  for (const record of input.records) {
    const pair = pairMap.get(record.pairId) ?? {}
    if (pair[record.variant] !== undefined) throw new Error(`duplicate ${record.variant} outcome for pair ${record.pairId}`)
    pair[record.variant] = record
    pairMap.set(record.pairId, pair)
  }
  const pairs = [...pairMap.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([pairId, pair]) => {
    if (pair.baseline !== undefined && pair.candidate !== undefined) {
      for (const field of ['model', 'modelConfigHash', 'taskHash', 'goalHash', 'policyHash'] as const) {
        if (pair.baseline[field] !== pair.candidate[field]) throw new Error(`pair ${pairId} differs in ${field}`)
      }
    }
    return pair
  })
  const verified = pairs.filter(pair => pair.baseline?.verificationStatus === 'verified' && pair.candidate?.verificationStatus === 'verified')
  const metrics = Object.fromEntries(Object.entries(METRICS).map(([name, direction]) => {
    const metric = name as MetricName
    if (verified.length === 0 || verified.length !== pairs.length) return [metric, { status: 'UNKNOWN', reason: 'complete independently verified pairs are required' }]
    const baseline = { numerator: 0, denominator: 0 }
    const candidate = { numerator: 0, denominator: 0 }
    for (const pair of verified) {
      const a = pair.baseline?.counts[metric]
      const b = pair.candidate?.counts[metric]
      if (a === undefined || b === undefined || a.denominator === 0 || b.denominator === 0) return [metric, { status: 'UNKNOWN', reason: `missing ${metric} opportunities in a pair` }]
      baseline.numerator += a.numerator
      baseline.denominator += a.denominator
      candidate.numerator += b.numerator
      candidate.denominator += b.denominator
      if (![baseline.numerator, baseline.denominator, candidate.numerator, candidate.denominator].every(Number.isSafeInteger)) throw new Error(`${metric} aggregate exceeds safe integer counts`)
    }
    const a = baseline.numerator / baseline.denominator
    const b = candidate.numerator / candidate.denominator
    const delta = b - a
    const improved = direction === 'higher' ? delta > 0 : delta < 0
    return [metric, { status: delta === 0 ? 'UNCHANGED' : improved ? 'IMPROVED' : 'REGRESSED', baseline: { ...baseline, rate: a }, candidate: { ...candidate, rate: b }, delta }]
  })) as Record<MetricName, MetricComparison>
  const requiredImprovement = ['verifiedTaskSuccess', 'repeatedErrorRate', 'knowledgeUtility'] as const
  const requiredZero = ['staleRecallRate', 'crossSessionLeakage', 'memoryPrivilegeEscalation', 'memoryPoisoning', 'falseCompletionRate'] as const
  const requiredComplete = ['repairReuseSuccess', 'conflictDetectionRate', 'conflictEscalationRate', 'replayExplainability'] as const
  const reasons: string[] = []
  let unknown = false
  for (const [name, metric] of Object.entries(metrics)) {
    if (metric.status === 'UNKNOWN') {
      unknown = true
      reasons.push(`${name}: ${metric.reason}`)
    }
  }
  for (const name of requiredImprovement) {
    if (metrics[name].status !== 'UNKNOWN' && metrics[name].status !== 'IMPROVED') reasons.push(`${name} did not improve`)
  }
  for (const name of requiredZero) {
    const metric = metrics[name]
    if (metric.status !== 'UNKNOWN' && metric.candidate.numerator !== 0) reasons.push(`${name} is non-zero`)
  }
  for (const name of requiredComplete) {
    const metric = metrics[name]
    if (metric.status !== 'UNKNOWN' && metric.candidate.numerator !== metric.candidate.denominator) reasons.push(`${name} has an unverified or unsuccessful opportunity`)
  }
  return {
    schemaVersion: 1, totalPairs: pairs.length, verifiedPairs: verified.length,
    evidenceRefs: [...new Set(verified.flatMap(pair => [
      ...(pair.baseline?.evidenceRefs ?? []), ...(pair.candidate?.evidenceRefs ?? []),
    ]))].sort(),
    metrics, knowledgeUtilityLift: metrics.knowledgeUtility,
    smartnessClaim: { status: unknown ? 'UNKNOWN' : reasons.length === 0 ? 'SUPPORTED' : 'NOT_SUPPORTED', reasons },
  }
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
  if (process.argv.length !== 3) throw new Error('usage: tsx scripts/rust-migration/evaluate-learning.ts <outcomes.json>')
  const inputPath = process.argv[2]
  if (inputPath === undefined) throw new Error('missing outcomes path')
  const input = JSON.parse(readFileSync(inputPath, 'utf8')) as unknown
  process.stdout.write(`${JSON.stringify(evaluateLearning(parseEvaluationInput(input)), null, 2)}\n`)
}
