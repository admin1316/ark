import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { asRecord, assertKeys, requireSha256, requireString } from './validation.ts'

import {
  evaluateLearning, METRICS, type Count, type EvaluationInput, type MetricName, type OutcomeRecord,
} from '../../packages/host/knowledge-wiki/src/learning-evaluation.ts'

export { evaluateLearning } from '../../packages/host/knowledge-wiki/src/learning-evaluation.ts'
export type { EvaluationInput, MetricComparison } from '../../packages/host/knowledge-wiki/src/learning-evaluation.ts'

/**
 * Evidence references are opaque identifiers, paths, or URLs, but they must
 * remain safe to print, persist, and replay.  In particular, an absolute path
 * or traversal segment would let an outcome smuggle a host-local location
 * into an otherwise portable evidence record.
 */
function requireEvidenceRef(value: unknown, context: string): string {
  const ref = requireString(value, context)
  if (ref !== ref.trim()) throw new Error(`${context} must not have surrounding whitespace`)
  if (/[\u0000-\u001f\u007f]/u.test(ref)) throw new Error(`${context} contains control characters`)
  if (ref.startsWith('/') || ref.startsWith('\\') || /^[A-Za-z]:(?:\/|\\)/u.test(ref) || /^file:/iu.test(ref)) {
    throw new Error(`${context} must be relative or a URL`)
  }
  const pathPart = ref.split(/[?#]/u, 1)[0] ?? ref
  if (pathPart.split(/(?:\/|\\)/u).some(segment => segment === '..')) throw new Error(`${context} must not contain path traversal`)
  return ref
}
/**
 * Parse the versioned JSON boundary and reject malformed counts or claimed self-verification.
 * @param value - JSON-decoded input.
 * @returns Validated records; source evidence still needs an independent evaluator.
 */
export function parseEvaluationInput(value: unknown): EvaluationInput {
  const input = asRecord(value, 'input')
  assertKeys(input, ['schemaVersion', 'records'], 'input')
  if (input['schemaVersion'] !== 1 || !Array.isArray(input['records'])) throw new Error('input requires schemaVersion 1 and records')
  const records = input['records'].map((raw, index): OutcomeRecord => {
    const context = `records[${index}]`
    const record = asRecord(raw, context)
    assertKeys(record, ['pairId', 'variant', 'model', 'modelConfigHash', 'taskHash', 'goalHash', 'policyHash', 'producerId', 'evaluatorId', 'verificationStatus', 'evidenceRefs', 'counts'], context)
    const variant = record['variant']
    const verificationStatus = record['verificationStatus']
    if (variant !== 'baseline' && variant !== 'candidate') throw new Error(`${context}.variant is invalid`)
    if (verificationStatus !== 'verified' && verificationStatus !== 'unknown' && verificationStatus !== 'rejected') throw new Error(`${context}.verificationStatus is invalid`)
    const producerId = requireString(record['producerId'], `${context}.producerId`)
    const evaluatorId = requireString(record['evaluatorId'], `${context}.evaluatorId`)
    if (!Array.isArray(record['evidenceRefs'])) throw new Error(`${context}.evidenceRefs must be an array`)
    const parsedEvidenceRefs = record['evidenceRefs'].map((ref, refIndex) => requireEvidenceRef(ref, `${context}.evidenceRefs[${refIndex}]`))
    if (new Set(parsedEvidenceRefs).size !== parsedEvidenceRefs.length) throw new Error(`${context}.evidenceRefs must not contain duplicates`)
    const evidenceRefs = [...parsedEvidenceRefs].sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
    if (verificationStatus === 'verified' && (producerId === evaluatorId || evidenceRefs.length === 0)) throw new Error(`${context} verified outcomes require independent evidence`)
    const rawCounts = asRecord(record['counts'], `${context}.counts`)
    assertKeys(rawCounts, Object.keys(METRICS), `${context}.counts`)
    const counts: Partial<Record<MetricName, Count>> = {}
    for (const [metric, rawCount] of Object.entries(rawCounts)) {
      const count = asRecord(rawCount, `${context}.counts.${metric}`)
      assertKeys(count, ['numerator', 'denominator'], `${context}.counts.${metric}`)
      const numerator = count['numerator']
      const denominator = count['denominator']
      if (typeof numerator !== 'number' || typeof denominator !== 'number' || !Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || numerator < 0 || denominator < numerator) throw new Error(`${context}.counts.${metric} requires non-negative safe counts with numerator <= denominator`)
      counts[metric as MetricName] = { numerator, denominator }
    }
    return {
      pairId: requireString(record['pairId'], `${context}.pairId`), variant,
      model: requireString(record['model'], `${context}.model`),
      modelConfigHash: requireSha256(record['modelConfigHash'], `${context}.modelConfigHash`),
      taskHash: requireSha256(record['taskHash'], `${context}.taskHash`),
      goalHash: requireSha256(record['goalHash'], `${context}.goalHash`),
      policyHash: requireSha256(record['policyHash'], `${context}.policyHash`),
      producerId, evaluatorId, verificationStatus, evidenceRefs, counts,
    }
  })
  return { schemaVersion: 1, records }
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
  if (process.argv.length !== 3) throw new Error('usage: tsx scripts/rust-migration/evaluate-learning.ts <outcomes.json>')
  const inputPath = process.argv[2]
  if (inputPath === undefined) throw new Error('missing outcomes path')
  const input = JSON.parse(readFileSync(inputPath, 'utf8')) as unknown
  process.stdout.write(`${JSON.stringify(evaluateLearning(parseEvaluationInput(input)), null, 2)}\n`)
}
