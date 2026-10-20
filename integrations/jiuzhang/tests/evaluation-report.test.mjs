import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { arkEvaluationCases, arkEvaluationModels, arkEvaluationPolicy } from '../evals/cases.mjs'
import { createArkEvaluationTemplate, summarizeArkEvaluation } from '../evals/report.mjs'

const execFileAsync = promisify(execFile)
const script = fileURLToPath(new URL('../evals/report.mjs', import.meta.url))
function measuredFixture() {
  const result = createArkEvaluationTemplate()
  result.sourceCommit = 'a'.repeat(40)
  result.configurationSha256 = 'b'.repeat(64)
  result.evidenceMode = 'synthetic'
  result.modelConfigurationSha256 = Object.fromEntries(arkEvaluationModels.map(id => [id, 'c'.repeat(64)]))
  const row = result.records[0]
  row.status = 'completed'
  row.reason = null
  row.checks = Object.fromEntries(Object.keys(arkEvaluationCases[0].checks).map(id => [id, true]))
  Object.assign(row, { firstTokenMs: 20, totalMs: 80, inputTokens: 100, outputTokens: 50, costUsd: 0.01, toolCalls: 2, toolSuccesses: 2 })
  return result
}

test('24 synthetic tasks cover four equal categories and two rounds per model without assuming execution', () => {
  assert.equal(arkEvaluationCases.length, 24)
  assert.equal(new Set(arkEvaluationCases.map(item => item.id)).size, 24)
  assert.deepEqual(arkEvaluationPolicy.rounds, [1, 2])
  const categories = [...new Set(arkEvaluationCases.map(item => item.category))]
  assert.equal(categories.length, 4)
  for (const category of categories) assert.equal(arkEvaluationCases.filter(item => item.category === category).length, 6)
  const result = summarizeArkEvaluation(createArkEvaluationTemplate())
  assert.equal(result.total.planned, 192)
  assert.equal(result.total.notRun, 192)
  assert.equal(result.total.successRateCompleted, null)
  assert.equal(result.total.costUsd.knownTotal, null)
  assert.equal(result.hasMeasuredModelResults, false)
  assert.equal(result.completeMatrixExecuted, false)
})

test('metadata report distinguishes success, failed rubric, provider error, skip and missing observations', () => {
  const input = measuredFixture()
  const failed = structuredClone(input.records[0])
  failed.run = 2
  failed.checks.semantics = false
  failed.firstTokenMs = 40
  failed.totalMs = 120
  failed.costUsd = null
  input.records[1] = failed
  Object.assign(input.records[2], { status: 'error', reason: 'timeout', totalMs: 150, costUsd: 0.02 })
  Object.assign(input.records[3], { status: 'skipped', reason: 'protocol-unverified' })
  const report = summarizeArkEvaluation(input)
  assert.equal(report.evidenceMode, 'synthetic')
  assert.equal(report.hasMeasuredModelResults, false)
  assert.equal(report.total.completed, 2)
  assert.equal(report.total.successful, 1)
  assert.equal(report.total.unsuccessful, 1)
  assert.equal(report.total.errors, 1)
  assert.equal(report.total.skipped, 1)
  assert.equal(report.total.notRun, 188)
  assert.equal(report.total.successRateCompleted, 0.5)
  assert.equal(report.total.successRateAttempted, 1 / 3)
  assert.deepEqual(report.total.firstTokenMs, { mean: 30, samples: 2 })
  assert.equal(report.total.inputTokens.knownTotal, 200)
  assert.equal(report.total.inputTokens.missing, 1)
  assert.equal(report.total.costUsd.knownTotal, 0.03)
  assert.equal(report.total.costUsd.missing, 1)
  assert.equal(report.models['deepseek-flash'].successful, 1)
})

test('duplicate identities, missing runs, invalid metrics and mismatched suite/configuration reject', () => {
  const mutations = [
    input => { input.records[1] = input.records[0] },
    input => { input.records.pop() },
    input => { input.records[0].modelId = 'unregistered-model' },
    input => { input.records[0].firstTokenMs = 1000 },
    input => { input.records[0].toolSuccesses = 3 },
    input => { input.records[0].inputTokens = 1.5 },
    input => { input.records[0].costUsd = -1 },
    input => { input.records[0].inputTokens = Number.MAX_SAFE_INTEGER },
    input => { input.suiteSha256 = '0'.repeat(64) },
    input => { input.configurationSha256 = null },
    input => { input.records[2].costUsd = 0 },
    input => { input.evidenceMode = 'not-run' },
    input => { input.records[0].checks = {} },
  ]
  for (const mutate of mutations) {
    const input = measuredFixture()
    mutate(input)
    assert.throws(() => summarizeArkEvaluation(input), /Invalid evaluation metadata/u)
  }
})

test('schema rejects free text and credentials instead of forwarding them into reports or CLI errors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ark-evaluation-'))
  const privateText = 'SYNTHETIC_PRIVATE_FIELD_MUST_NEVER_PRINT'
  try {
    for (const mutate of [
      input => { input.apiKey = privateText },
      input => { input.records[0].answer = privateText },
      input => { input.records[0].reason = privateText },
      input => { input.sourceCommit = privateText },
    ]) {
      const input = measuredFixture()
      mutate(input)
      assert.throws(() => summarizeArkEvaluation(input), error => !error.message.includes(privateText))
      const path = join(root, 'metadata.json')
      await writeFile(path, JSON.stringify(input))
      await assert.rejects(execFileAsync(process.execPath, [script, 'summarize', path]), error => {
        assert.equal(error.stdout, '')
        assert.equal(error.stderr.includes(privateText), false)
        assert.equal(error.code, 1)
        return true
      })
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('CLI template and summary complete with networking unavailable and leave the metadata file unchanged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ark-offline-evaluation-'))
  try {
    const denyNetwork = join(root, 'deny-network.mjs')
    await writeFile(denyNetwork, "import http from 'node:http'; import https from 'node:https'; import net from 'node:net'; import tls from 'node:tls'; const deny=()=>{throw new Error('network forbidden')}; globalThis.fetch=deny; http.request=deny; http.get=deny; https.request=deny; https.get=deny; net.connect=deny; net.createConnection=deny; tls.connect=deny;\n")
    const { stdout } = await execFileAsync(process.execPath, ['--import', denyNetwork, script, 'template'])
    const path = join(root, 'metadata.json')
    await writeFile(path, stdout)
    const summarized = await execFileAsync(process.execPath, ['--import', denyNetwork, script, 'summarize', path])
    const report = JSON.parse(summarized.stdout)
    assert.equal(report.total.notRun, 192)
    assert.equal(await readFile(path, 'utf8'), stdout)
    assert.equal(report.hasMeasuredModelResults, false)
  } finally { await rm(root, { recursive: true, force: true }) }
})
