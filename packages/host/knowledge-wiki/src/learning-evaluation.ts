/** Shared paired-count reduction for the Wiki learning graph and evaluation CLI. */

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

/** Metric identity in the shared paired-count contract. */
export type MetricName = keyof typeof METRICS
/** Explicit nonnegative opportunity count, validated before reduction. */
export interface Count {
  readonly numerator: number
  readonly denominator: number
}
/** One variant's outcome and evidence labels; proof authentication belongs to its caller. */
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

/** Versioned complete input to the deterministic learning reducer. */
export interface EvaluationInput {
  readonly schemaVersion: 1
  readonly records: readonly OutcomeRecord[]
}
/** Missing comparison evidence or an exactly ordered count-ratio comparison with approximate display rates. */
export type MetricComparison = {
  readonly status: 'UNKNOWN'
  readonly reason: string
} | {
  readonly status: 'IMPROVED' | 'REGRESSED' | 'UNCHANGED'
  readonly baseline: Count & { readonly rate: number }
  readonly candidate: Count & { readonly rate: number }
  /** Approximate exact rational difference; separately rounded rates can be equal. */
  readonly delta: number
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
  for (const pair of verified) {
    const baseline = pair.baseline
    const candidate = pair.candidate
    if (baseline === undefined || candidate === undefined) throw new Error('verified pair is incomplete')
    const producers = new Set([baseline.producerId, candidate.producerId])
    const evaluators = new Set([baseline.evaluatorId, candidate.evaluatorId])
    if ([...producers].some(id => evaluators.has(id))) {
      throw new Error(`pair ${baseline.pairId} reuses a producer identity as an evaluator`)
    }
  }
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
    const difference = BigInt(candidate.numerator) * BigInt(baseline.denominator)
      - BigInt(baseline.numerator) * BigInt(candidate.denominator)
    const denominator = BigInt(baseline.denominator) * BigInt(candidate.denominator)
    const delta = Number(difference) / Number(denominator)
    const improved = direction === 'higher' ? difference > 0n : difference < 0n
    return [metric, { status: difference === 0n ? 'UNCHANGED' : improved ? 'IMPROVED' : 'REGRESSED', baseline: { ...baseline, rate: a }, candidate: { ...candidate, rate: b }, delta }]
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
