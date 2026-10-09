import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createReadOnlyLearningVerifier } from '../src/external-verifier-adapter.ts'
import { sha256, validateLearningReceiptChain } from '../src/verifier.ts'
import { canonicalJson } from '../src/verifier.ts'
import type { ArtifactRef } from '../src/learning-artifacts.ts'
import { createHistoricalUpdateFixture, type HistoricalFixtureChanges } from './learning-graph-fixture.ts'

type Fixture = ReturnType<typeof createHistoricalUpdateFixture>
type ObjectValue = Record<string, unknown>
const fixtures: Fixture[] = []
afterEach(() => { for (const value of fixtures.splice(0)) value.artifacts.dispose() })
function fixture(changes: HistoricalFixtureChanges = {}) {
  const value = createHistoricalUpdateFixture(changes)
  fixtures.push(value)
  return value
}
function consume(value: Fixture) {
  const selected = createReadOnlyLearningVerifier({ descriptor: value.descriptor, captureContext: value.captureContext,
    reducerSourceHash: value.reducerSourceHash })
  return validateLearningReceiptChain(selected, value.trial)
}
function files(value: Fixture) {
  return readdirSync(value.artifacts.root, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map((entry) => {
    const path = join(entry.parentPath, entry.name)
    return { path: relative(value.artifacts.root, path), bytes: readFileSync(path) }
  }).sort((left, right) => left.path.localeCompare(right.path))
}
function operation(core: ObjectValue, index: number): ObjectValue { return (core['operations'] as ObjectValue[])[index]! }
function rehashOperations(core: ObjectValue) { core['operationSetHash'] = sha256(canonicalJson(core['operations'])) }

describe('complete historical canonical authority in a synthetic update graph', { timeout: 120_000 }, () => {
  it('validates an update only after the entire historical Promote proof, immutable WAL, and projection', () => {
    const value = fixture()
    const before = files(value)
    const result = consume(value)
    const retainedRoot = process.env['DSH_LEARNING_GRAPH_TEST_EVIDENCE_ROOT']
    if (retainedRoot !== undefined) {
      mkdirSync(retainedRoot, { recursive: true, mode: 0o700 })
      cpSync(value.artifacts.root, join(retainedRoot, 'historical-update-synthetic-fixture'), { recursive: true })
      writeFileSync(join(retainedRoot, 'historical-update-synthetic-index.json'), JSON.stringify({
        classification: 'TEST_ONLY_SYNTHETIC_GRAPH_NOT_REAL_LEARNING', providerCalls: 0, builds: 0,
        privateKeysPersisted: false, result, descriptor: value.descriptor,
        ownerContext: { ...value.captureContext(), sessionContexts: [...value.sessionContexts] },
        currentTrial: value.trial, historicalTrial: value.historical.trial, historicalWal: value.wal,
        targetSnapshot: value.targetSnapshot, artifacts: [...value.artifacts.entries.values()].map(entry => entry.ref),
      }, null, 2), { mode: 0o600 })
    }
    expect(result).toMatchObject({ status: 'validated', trialResult: 'pass', candidateKnowledgeId: 'synthetic-update-candidate', canonicalKnowledgeId: 'synthetic-candidate',
      uniqueCandidateUseIds: ['synthetic-update-use-candidate'], evaluation: value.evaluationOutput, creditCommitted: false, activationAllowed: false })
    expect(value.historical.usePayloads.map(use => use['result'])).toEqual(['fail', 'pass'])
    expect(value.usePayloads.map(use => use['result'])).toEqual(['fail', 'pass'])
    expect(value.historicalCanonical).toMatchObject({ id: 'synthetic-candidate', lifecycle: 'canonical', source: value.semantic.targetPath,
      retrievalHits: 1, successfulUses: 1, utilityScore: 1, expiresAt: value.historical.semantic.verifiedRecord.expiresAt })
    expect(value.semantic.verifiedRecord).toMatchObject({ id: 'synthetic-update-candidate', lifecycle: 'candidate', successfulUses: 0, utilityScore: 0 })
    expect(value.proposalPayload['targetBefore']).toEqual(value.historical.proposalPayload['targetAfter'])
    expect(value.artifacts.json(value.wal)).not.toHaveProperty('state')
    expect(files(value)).toEqual(before)
    expect(consume(value)).toEqual(result)
    expect(files(value)).toEqual(before)
  })

  const cases: readonly { name: string; changes: HistoricalFixtureChanges }[] = [
    { name: 'historical canonical bytes with a valid new operation hash and seal', changes: { wal(core) { operation(core, 1)['after'] = `${String(operation(core, 1)['after'])} `; rehashOperations(core) } } },
    { name: 'historical candidate archive exact bytes', changes: { wal(core) { operation(core, 0)['after'] = 'different frozen candidate'; rehashOperations(core) } } },
    { name: 'historical candidate delete preimage', changes: { wal(core) { operation(core, 4)['before'] = 'different deleted candidate'; rehashOperations(core) } } },
    { name: 'historical operation role order', changes: { wal(core) { const operations = core['operations'] as unknown[]; [operations[0], operations[1]] = [operations[1], operations[0]]; rehashOperations(core) } } },
    { name: 'historical deterministic auxiliary name', changes: { wal(core) { operation(core, 1)['stagingPath'] = `${String(operation(core, 1)['stagingPath'])}-different`; rehashOperations(core) } } },
    { name: 'historical path outside the actual owner root', changes: { wal(core) { operation(core, 1)['path'] = '/tmp/unowned-canonical.md'; rehashOperations(core) } } },
    { name: 'historical review transformation dropping unrelated rows', changes: { wal(core) { const rows = JSON.parse(String(operation(core, 2)['after'])) as unknown[]; operation(core, 2)['after'] = JSON.stringify(rows.slice(0, 1), null, 2); rehashOperations(core) } } },
    { name: 'historical governance append replacing the signed actor', changes: { wal(core) { const entry = JSON.parse(String(operation(core, 3)['after'])) as ObjectValue; entry['actor'] = 'different-actor'; operation(core, 3)['after'] = `${JSON.stringify(entry)}\n`; rehashOperations(core) } } },
    { name: 'historical mutable state marker in the immutable WAL artifact', changes: { wal(core) { core['state'] = 'committed' } } },
    { name: 'historical duplicated use credit', changes: { projection(value) { value['newlyCreditedUseIds'] = ['synthetic-use-candidate', 'synthetic-use-candidate'] } } },
    { name: 'historical caller-inflated successful uses', changes: { canonicalRecord(value) { return { ...value, successfulUses: 2 } } } },
    { name: 'historical old semantic source hash as new output provenance', changes: { canonicalRecord(value) { return { ...value, sourceHash: sha256('synthetic:independent-source-label') } } } },
    { name: 'different candidate and target readers with the current actor still allowed', changes: { update: { candidateRecord(value) { return { ...value, acl: { readers: ['synthetic-approved-principal', 'other-reader'], writers: ['synthetic-approved-principal'] } } } } } },
    { name: 'different candidate and target writers', changes: { update: { candidateRecord(value) { return { ...value, acl: { readers: ['synthetic-approved-principal'], writers: ['different-writer'] } } } } } },
    { name: 'different effective claim identity', changes: { update: { candidateRecord(value) { return { ...value, claimKey: 'different-claim' } } } } },
    { name: 'existing target expiry later than the candidate expiry', changes: { update: { candidateRecord(value) { return { ...value, expiresAt: '2026-10-08T00:05:00.000Z' } } } } },
    { name: 'existing target transition relabeled to the candidate id', changes: { update: { proposal(value) { (value['canonicalIdentityTransition'] as ObjectValue)['canonicalKnowledgeId'] = value['knowledgeId'] } } } },
  ]
  it.each(cases)('rejects $name through complete recursive history validation', ({ changes }) => {
    expect(consume(fixture()).status).toBe('validated')
    const value = fixture(changes)
    const before = files(value)
    expect(consume(value)).toEqual({ status: 'invalid', errorCode: 'invalid-learning-graph' })
    expect(files(value)).toEqual(before)
  })

  it('requires the original historical failed arm artifact rather than only the old target hash', () => {
    const value = fixture()
    expect(consume(value).status).toBe('validated')
    const failedUse = value.historical.useReceipts[0] as ArtifactRef
    rmSync(value.artifacts.path(failedUse))
    const before = files(value)
    expect(consume(value)).toEqual({ status: 'invalid', errorCode: 'invalid-learning-graph' })
    expect(files(value)).toEqual(before)
  })

  it.each(['knowledge/rejected', 'knowledge/conflict', 'knowledge/expired', 'knowledge/rolled_back'])('denies current target terminal suffix %s', (type) => {
    expect(consume(fixture()).status).toBe('validated')
    const value = fixture({ update: { suffix(journal, _candidateId, record) {
      journal.append('synthetic-candidate', { type, evidence: journal.artifacts.put({ kind: 'TEST_ONLY', reason: type }) }, new Date(Date.parse(record.createdAt) + 6000).toISOString())
    } } })
    expect(consume(value)).toEqual({ status: 'invalid', errorCode: 'invalid-learning-graph' })
  })
})
