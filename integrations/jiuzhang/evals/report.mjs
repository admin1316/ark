/** Offline metadata-only evaluation planner and reporter. No provider, credential or network access. */
import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { constants } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { arkEvaluationCases, arkEvaluationModels, arkEvaluationPolicy } from './cases.mjs'

export const arkEvaluationSuiteSHA256 = createHash('sha256')
  .update(JSON.stringify({ policy: arkEvaluationPolicy, models: arkEvaluationModels, cases: arkEvaluationCases })).digest('hex')
const STATUSES = ['completed', 'error', 'skipped', 'not-run']
const REASONS = ['budget-unapproved', 'provider-unavailable', 'credentials-unconfigured', 'protocol-unverified',
  'rate-limited', 'timeout', 'cancelled', 'provider-error', 'evaluation-error']
const METRICS = ['firstTokenMs', 'totalMs', 'inputTokens', 'outputTokens', 'costUsd', 'toolCalls', 'toolSuccesses']
const COUNTS = new Set(['inputTokens', 'outputTokens', 'toolCalls', 'toolSuccesses'])
const nullableMetrics = () => Object.fromEntries(METRICS.map(name => [name, null]))
const fail = () => { throw new Error('Invalid evaluation metadata; expected the exact public template schema with no free text or credentials.') }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const keys = (value, names) => {
  if (!object(value) || Object.keys(value).sort().join('\0') !== [...names].sort().join('\0')) fail()
}
const hash = (value, length) => value === null || (typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`, 'u').test(value))
const keyFor = row => `${row.modelId}/${row.caseId}/${row.run}`

/** Return the complete two-round matrix, with no fabricated observations or implicit API calls. */
export function createArkEvaluationTemplate() {
  return {
    schema: 'ark.eval.run.v1',
    suiteSha256: arkEvaluationSuiteSHA256,
    sourceCommit: null,
    configurationSha256: null,
    evidenceMode: 'not-run',
    modelConfigurationSha256: Object.fromEntries(arkEvaluationModels.map(id => [id, null])),
    records: arkEvaluationModels.flatMap(modelId => arkEvaluationCases.flatMap(item => arkEvaluationPolicy.rounds.map(run => ({
      caseId: item.id, modelId, run, status: 'not-run', reason: 'budget-unapproved', checks: null, ...nullableMetrics(),
    })))),
  }
}

function validate(input) {
  keys(input, ['schema', 'suiteSha256', 'sourceCommit', 'configurationSha256', 'evidenceMode', 'modelConfigurationSha256', 'records'])
  if (input.schema !== 'ark.eval.run.v1' || input.suiteSha256 !== arkEvaluationSuiteSHA256
    || !hash(input.sourceCommit, 40) || !hash(input.configurationSha256, 64)
    || !['not-run', 'synthetic', 'measured'].includes(input.evidenceMode)) fail()
  keys(input.modelConfigurationSha256, arkEvaluationModels)
  if (!Object.values(input.modelConfigurationSha256).every(value => hash(value, 64))) fail()
  const expected = createArkEvaluationTemplate().records
  if (!Array.isArray(input.records) || input.records.length !== expected.length) fail()
  const remaining = new Set(expected.map(keyFor))
  for (const row of input.records) {
    keys(row, ['caseId', 'modelId', 'run', 'status', 'reason', 'checks', ...METRICS])
    if (typeof row.caseId !== 'string' || typeof row.modelId !== 'string' || !Number.isInteger(row.run)
      || !remaining.delete(keyFor(row)) || !STATUSES.includes(row.status)
      || (row.reason !== null && !REASONS.includes(row.reason))) fail()
    for (const name of METRICS) {
      const value = row[name]
      if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1_000_000_000_000
        || (COUNTS.has(name) && !Number.isSafeInteger(value)))) fail()
    }
    if (row.firstTokenMs !== null && (row.totalMs === null || row.firstTokenMs > row.totalMs)) fail()
    if (row.toolSuccesses !== null && (row.toolCalls === null || row.toolSuccesses > row.toolCalls)) fail()
    if (row.status === 'completed') {
      const item = arkEvaluationCases.find(value => value.id === row.caseId)
      keys(row.checks, Object.keys(item.checks))
      if (!Object.values(row.checks).every(value => typeof value === 'boolean') || row.reason !== null || row.totalMs === null) fail()
    } else if (row.checks !== null || row.reason === null) fail()
    if (row.status === 'not-run' || row.status === 'skipped') {
      if (METRICS.some(name => row[name] !== null)) fail()
    } else if (input.evidenceMode === 'not-run' || input.sourceCommit === null || input.configurationSha256 === null
      || input.modelConfigurationSha256[row.modelId] === null) fail()
  }
  if (remaining.size !== 0) fail()
}

const mean = values => values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length
function statistics(rows) {
  const completed = rows.filter(row => row.status === 'completed')
  const successful = completed.filter(row => Object.values(row.checks).every(Boolean))
  const failed = rows.filter(row => row.status === 'error')
  const attempted = [...completed, ...failed]
  const measured = name => attempted.map(row => row[name]).filter(value => value !== null)
  const sum = name => {
    const values = measured(name)
    return values.length === 0 ? null : values.reduce((total, value) => total + value, 0)
  }
  return {
    planned: rows.length, completed: completed.length, successful: successful.length,
    unsuccessful: completed.length - successful.length, errors: failed.length,
    skipped: rows.filter(row => row.status === 'skipped').length,
    notRun: rows.filter(row => row.status === 'not-run').length,
    successRateCompleted: completed.length === 0 ? null : successful.length / completed.length,
    successRateAttempted: attempted.length === 0 ? null : successful.length / attempted.length,
    firstTokenMs: { mean: mean(measured('firstTokenMs')), samples: measured('firstTokenMs').length },
    totalMs: { mean: mean(measured('totalMs')), samples: measured('totalMs').length },
    inputTokens: { knownTotal: sum('inputTokens'), missing: attempted.length - measured('inputTokens').length },
    outputTokens: { knownTotal: sum('outputTokens'), missing: attempted.length - measured('outputTokens').length },
    costUsd: { knownTotal: sum('costUsd'), missing: attempted.length - measured('costUsd').length },
    toolCalls: { knownTotal: sum('toolCalls'), missing: attempted.length - measured('toolCalls').length },
    toolSuccesses: { knownTotal: sum('toolSuccesses'), missing: attempted.length - measured('toolSuccesses').length },
    reasons: Object.fromEntries(REASONS.map(reason => [reason, rows.filter(row => row.reason === reason).length])),
  }
}

/** Reject non-template fields, duplicates and invented metrics before deriving a metadata-only report. */
export function summarizeArkEvaluation(input) {
  validate(input)
  return {
    schema: 'ark.eval.summary.v1', suiteSha256: arkEvaluationSuiteSHA256,
    sourceCommit: input.sourceCommit, configurationSha256: input.configurationSha256,
    evidenceMode: input.evidenceMode,
    hasMeasuredModelResults: input.evidenceMode === 'measured' && input.records.some(row => row.status === 'completed'),
    completeMatrixExecuted: input.records.every(row => row.status === 'completed' || row.status === 'error'),
    total: statistics(input.records),
    models: Object.fromEntries(arkEvaluationModels.map(id => [id, {
      configurationSha256: input.modelConfigurationSha256[id],
      ...statistics(input.records.filter(row => row.modelId === id)),
    }])),
    categories: Object.fromEntries([...new Set(arkEvaluationCases.map(item => item.category))].map(category => [category,
      statistics(input.records.filter(row => arkEvaluationCases.find(item => item.id === row.caseId).category === category)),
    ])),
  }
}

async function readMetadata(path) {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const metadata = await file.stat()
    if (!metadata.isFile() || metadata.size > 2 * 1024 * 1024) fail()
    const bytes = await file.readFile('utf8')
    if (Buffer.byteLength(bytes, 'utf8') > 2 * 1024 * 1024) fail()
    return JSON.parse(bytes)
  } finally { await file.close() }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [mode, path, ...extra] = process.argv.slice(2)
    if (extra.length > 0) fail()
    if (mode === '--help' && path === undefined) console.log('Offline Ark evaluation metadata: template prints 192 not-run slots; summarize <metadata.json> prints a validated report. Completed/error records require sourceCommit, configurationSha256 and modelConfigurationSha256 hashes of reviewed credential-free configuration. evidenceMode is not-run, synthetic or measured. Record only rubric booleans, reason enums and numeric observations. No model execution, network, credential access or output-file writes occur.')
    else if (mode === 'template' && path === undefined) console.log(JSON.stringify(createArkEvaluationTemplate(), null, 2))
    else if (mode === 'summarize' && path !== undefined) console.log(JSON.stringify(summarizeArkEvaluation(await readMetadata(path)), null, 2))
    else throw new Error('Usage: node integrations/jiuzhang/evals/report.mjs template | summarize <metadata.json>. Offline only; template starts with 192 not-run slots. Fill only hashes, enums, rubric booleans and numeric observations; never include prompts, answers, errors, credentials or personal data.')
  } catch {
    console.error('Evaluation report rejected. Use template or summarize <metadata.json> with the exact public schema; input values are never printed on failure.')
    process.exitCode = 1
  }
}
