/** Boundary tests use only synthetic keys and isolated original artifacts; no real learning credit is issued. */
import { readFileSync, rmSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { createReadOnlyLearningVerifier } from '../src/external-verifier-adapter.ts'
import { GraphContext, LearningGraphUnavailable, type LearningGraphOwner } from '../src/learning-graph-context.ts'
import { visitLearningPayloadEdges } from '../src/learning-graph-edges.ts'
import { LearningJournal, admissionFor, admitRecord } from '../src/learning-graph-journal.ts'
import { validateLearningGraph } from '../src/learning-graph.ts'
import * as S from '../src/learning-graph-schema.ts'
import { validateLearningReceiptChain, sha256 } from '../src/verifier.ts'
import { createLearningGraphFixture, createHistoricalUpdateFixture, LearningFixtureJournal,
  type LearningFixtureChanges } from './learning-graph-fixture.ts'
import { graphFixtureOwner as owner } from './learning-graph-coverage-owner.ts'

type Fixture = ReturnType<typeof createLearningGraphFixture>
type Json = Record<string, unknown>
const fixtures: Fixture[] = []
afterEach(() => { for (const value of fixtures.splice(0)) value.artifacts.dispose() })
function fixture(changes: LearningFixtureChanges = {}): Fixture {
  const value = createLearningGraphFixture(changes)
  fixtures.push(value)
  return value
}
function selected(value: Fixture) {
  return createReadOnlyLearningVerifier({ descriptor: value.descriptor,
    captureContext: value.captureContext, reducerSourceHash: value.reducerSourceHash })
}
function consume(value: Fixture) { return validateLearningReceiptChain(selected(value), value.trial) }

describe('missing selected learning owners remain unavailable', () => {
  it.each(['currentJournal', 'sessionContexts', 'wikiRoot', 'reviewFile', 'archiveRoot', 'now', 'projectId'] as const)(
    'distinguishes missing %s from forged graph evidence', (field) => {
      const value = fixture()
      const captured = owner(value)
      const missing = { ...captured, [field]: field === 'currentJournal' || field === 'sessionContexts' ? {} : '' } as LearningGraphOwner
      expect(() => new GraphContext(missing)).toThrow(LearningGraphUnavailable)
      expect(validateLearningGraph(value.trial, missing)).toEqual({ status: 'unavailable', errorCode: 'learning-owner-unavailable' })
    },
  )

  it('propagates missing session access context through bounded reads without relabeling it invalid', () => {
    const value = fixture()
    const captured = { ...owner(value), sessionContexts: new Map() }
    const ctx = new GraphContext(captured)
    expect(() => {
      admitRecord(ctx, value.semantic.verifiedRecord, value.sessions[0]!.session.id, false)
    }).toThrow(LearningGraphUnavailable)
    expect(ctx.ownerInputUnavailable).toBe(true)
    expect(validateLearningGraph(value.trial, captured)).toEqual({ status: 'unavailable', errorCode: 'learning-owner-unavailable' })
  })
})

describe('independent typed learning edges consume their original leaves', () => {
  it('resolves standalone mission, run, arm, snapshot, watermark, transition, injection, event and oracle references', () => {
    const value = fixture()
    const proposal = S.proposal.parse(value.proposalPayload)
    const use = S.use.parse(value.usePayloads[1])
    const arm = S.arm.parse(value.sessions[1]!.arm)
    const injection = use.injections[0]!
    const inputs: readonly { schema: z.ZodType; value: unknown }[] = [
      { schema: S.mission, value: proposal.mission }, { schema: S.run, value: arm.run },
      { schema: S.arm, value: arm }, { schema: S.snapshot, value: proposal.governedCandidate },
      { schema: S.watermark, value: proposal.governedCandidate.watermark },
      { schema: S.transition, value: proposal.canonicalIdentityTransition },
      { schema: S.injection, value: injection }, { schema: S.eventRef, value: injection.toolCall },
      { schema: S.observation, value: use.oracle },
    ]
    for (const input of inputs) {
      const ctx = new GraphContext(owner(value))
      expect(ctx.json(value.artifacts.put(input.value), input.schema)).toEqual(input.value)
    }
    const retained = readFileSync(value.artifacts.path(injection.renderedToolResult))
    rmSync(value.artifacts.path(injection.renderedToolResult))
    expect(() => new GraphContext(owner(value)).json(value.artifacts.put(injection), S.injection)).toThrow()
    expect(retained.byteLength).toBeGreaterThan(0)
  })

  it('traverses historical projection leaves without inventing a second promotion operation', () => {
    const value = createHistoricalUpdateFixture()
    fixtures.push(value)
    const projection = S.projection.parse(value.projection)
    const ctx = new GraphContext(owner(value))
    expect(ctx.json(value.artifacts.put(projection), S.projection)).toEqual(projection)
    rmSync(value.artifacts.path(projection.candidateRecordAfter))
    expect(() => new GraphContext(owner(value)).json(value.artifacts.put(projection), S.projection)).toThrow()
  })

  it('retains exclusion rule and evidence reads even though the enclosing trial cannot be accepted', () => {
    const value = fixture()
    const rule = value.artifacts.put({ kind: 'TEST_ONLY_EXCLUSION_RULE' })
    const evidence = value.artifacts.put({ kind: 'TEST_ONLY_EXCLUSION_OBSERVATION' })
    const payload = { ...value.trialPayload, exclusions: [{ useId: 'synthetic-use-baseline', rule, evidence }] }
    const request = value.artifacts.json(value.artifacts.json(value.trial)['requestArtifact'] as S.MeasuredTrial['grant'])
    const envelope = value.signers.evaluatorEnvelope('measured-trial', payload, value.artifacts.put(request),
      { issuedAt: value.times.measured, expiresAt: value.times.evidenceExpiry })
    const ref = value.artifacts.put(envelope)
    expect(new GraphContext(owner(value)).envelope(ref, 'measured-trial', S.trial, trial => trial.exclusions)).toEqual(payload.exclusions)
    rmSync(value.artifacts.path(rule))
    expect(() => new GraphContext(owner(value)).envelope(ref, 'measured-trial', S.trial, trial => trial)).toThrow()
  })

  it.each([S.journalEvent, S.childRequest])('rejects unsupported public edge discriminants rather than treating them as leaves', (schema) => {
    const value = fixture()
    const ctx = new GraphContext(owner(value))
    const unsupported = schema === S.journalEvent ? { payload: { type: 'knowledge/unsupported-future-event' } }
      : { operation: 'unsupported-future-operation' }
    expect(() => {
      visitLearningPayloadEdges(ctx, schema, unsupported)
    }).toThrow('unsupported learning protocol payload')
  })
})

describe('read-only journal observation and feedback replay', () => {
  it('keeps observed/candidate transitions low trust and only correction feedback downgrades them', () => {
    const value = fixture()
    const raw = { ...value.semantic.verifiedRecord }
    delete raw.claimKey
    delete raw.acl
    const journal = new LearningFixtureJournal(value.artifacts, value.signers, { ...raw.scope })
    const legacyLog = value.artifacts.putBytes('TEST_ONLY legacy observation, no positive authority', 'application/octet-stream')
    journal.append('synthetic-genesis', { type: 'knowledge/journal-started', legacyLog,
      legacyLastEventHash: sha256('TEST_ONLY_LEGACY_HASH') }, value.times.created)
    journal.append(raw.id, { type: 'knowledge/observed', legacyShapePayload: { record: raw } }, value.times.created)
    journal.append(raw.id, { type: 'knowledge/retrieved', legacyShapePayload: { path: raw.source, retrievalAt: value.times.measured } })
    journal.append(raw.id, { type: 'knowledge/injected', legacyShapePayload: { path: raw.source, outcome: 'neutral', outcomeSource: 'user-feedback', utilityScore: 999 } })
    journal.append(raw.id, { type: 'knowledge/candidate', legacyShapePayload: { record: raw } })
    journal.append(raw.id, { type: 'knowledge/injected', legacyShapePayload: { path: raw.source, outcome: 'successful', outcomeSource: 'user-feedback', utilityScore: 999 } })
    journal.append(raw.id, { type: 'knowledge/injected', legacyShapePayload: { path: raw.source, outcome: 'corrected', outcomeSource: 'user-feedback', utilityScore: 999 } })
    journal.append('missing-record', { type: 'knowledge/injected', legacyShapePayload: { path: raw.source, outcome: 'corrected', outcomeSource: 'user-feedback', utilityScore: 999 } })
    journal.append('missing-record', { type: 'knowledge/retrieved', legacyShapePayload: { path: raw.source, retrievalAt: value.times.measured } })
    journal.append('missing-record', { type: 'knowledge/rejected', evidence: legacyLog })
    const ctx = new GraphContext(owner(value, journal.head()))
    const replay = new LearningJournal(ctx, () => { throw new Error('observations must never promote') })
    expect(admissionFor(raw)).toMatchObject({ claimKey: null, acl: null })
    expect(replay.stateAt(3).records.get(raw.id)).toMatchObject({ verificationStatus: 'observed', trust: 'low',
      authority: 'untrusted-observation', successfulUses: 0, utilityScore: 0, retrievalHits: 1 })
    const result = replay.stateAt(journal.events.length - 1)
    expect(result.records.get(raw.id)).toMatchObject({ verificationStatus: 'rejected', lifecycle: 'downgraded',
      trust: 'low', authority: 'untrusted-observation', retrievalHits: 1, userCorrections: 1, successfulUses: 0, utilityScore: 0 })
    expect(result.records.has('missing-record')).toBe(false)
    expect(result.creditOwners.size).toBe(0)
    expect(replay.stateAt(journal.events.length - 1)).toBe(result)
  })

  it('rejects repeating an observed row instead of overwriting its prior governed state', () => {
    const value = fixture()
    const journal = new LearningFixtureJournal(value.artifacts, value.signers, { ...value.semantic.verifiedRecord.scope })
    journal.append('synthetic-genesis', { type: 'knowledge/journal-started', legacyLog: null, legacyLastEventHash: null }, value.times.created)
    for (let index = 0; index < 2; index++) journal.append(value.semantic.verifiedRecord.id,
      { type: 'knowledge/observed', legacyShapePayload: { record: value.semantic.verifiedRecord } })
    const replay = new LearningJournal(new GraphContext(owner(value, journal.head())), () => { throw new Error('unexpected promotion') })
    expect(() => replay.stateAt(2)).toThrow('invalid learning graph relation')
    expect(replay.stateAt(1).records.get(value.semantic.verifiedRecord.id)?.verificationStatus).toBe('observed')
  })

  it('replays identical observational receipts idempotently without adding knowledge credit', () => {
    const value = fixture()
    const original = [...value.journal.events]
    for (const type of ['knowledge/use-observed', 'knowledge/use-measured', 'knowledge/trial-measured', 'knowledge/trial-closed']) {
      const event = original.find(row => (row['payload'] as Json)['type'] === type)!
      value.journal.append(String(event['knowledgeId']), event['payload'] as Json)
    }
    const replay = new LearningJournal(new GraphContext(owner(value, value.journal.head())), () => { throw new Error('unexpected promotion') })
    const result = replay.stateAt(value.journal.events.length - 1)
    expect(result.observedFacts.size).toBe(2)
    expect(result.useReceipts.size).toBe(2)
    expect(result.trialReceipts.size).toBe(1)
    expect(result.grants.get('synthetic-grant-1')?.closed).toBe('complete')
    expect(result.creditOwners.size).toBe(0)
  })

  it('retains and bounds a second consumed read rather than erasing its reservation from session validation', () => {
    const value = fixture()
    const replayed = new LearningFixtureJournal(value.artifacts, value.signers, { ...value.semantic.verifiedRecord.scope })
    const read = value.journal.events.map(row => row['payload'] as Json).find(payload =>
      payload['type'] === 'knowledge/trial-consumed' && (payload['reservation'] as Json)['phase'] === 'knowledge-read')!
    let inserted = false
    for (const event of value.journal.events) {
      replayed.append(String(event['knowledgeId']), event['payload'] as Json, String(event['timestamp']))
      if (inserted || (event['payload'] as Json)['type'] !== 'knowledge/retrieved') continue
      inserted = true
      replayed.append(String(event['knowledgeId']), { type: 'knowledge/trial-consumed', reservation: {
        ...(read['reservation'] as Json), reservationId: 'synthetic-unmatched-second-read',
        callId: 'synthetic-unmatched-second-call', ordinal: 2,
      } }, String(event['timestamp']))
      replayed.append(String(event['knowledgeId']), event['payload'] as Json, String(event['timestamp']))
    }
    Object.assign(value.currentJournal, replayed.head())
    expect(consume(value)).toEqual({ status: 'invalid', errorCode: 'invalid-learning-graph' })
  })
})

describe('signed failed opportunities stay complete during graph evaluation', () => {
  it.each(['staleRecallRate', 'repairReuseSuccess'] as const)('keeps adverse %s observations as a failed scoped trial', (metric) => {
    const value = fixture({ use(use, variant) {
      if (variant !== 'candidate') return
      const counts = ((use['oracle'] as Json)['counts'] as Json)
      ;(counts[metric] as Json)['numerator'] = metric === 'staleRecallRate' ? 1 : 0
    } })
    expect(consume(value)).toMatchObject({ status: 'validated', trialResult: 'fail', creditCommitted: false, activationAllowed: false })
  })

  it('does not invent missing optional opportunities while retaining all signed arms', () => {
    const value = fixture({ use(use) { delete ((use['oracle'] as Json)['counts'] as Json)['memoryCorrectionRate'] },
      trial(trial) {
        delete (trial['counts'] as Json)['memoryCorrectionRate']
        // All preregistered required gates pass; the optional unknown remains in the reducer output.
        trial['result'] = 'pass'
      } })
    expect(consume(value)).toMatchObject({ status: 'validated', trialResult: 'pass',
      evaluation: { metrics: { memoryCorrectionRate: { status: 'UNKNOWN' } } }, creditCommitted: false, activationAllowed: false })
  })

  it('rejects a sealed WAL that substitutes a proposal for the actual measured-trial reference', () => {
    const value = createHistoricalUpdateFixture({ wal(core) { core['measuredTrial'] = core['proposal'] } })
    fixtures.push(value)
    expect(consume(value)).toEqual({ status: 'invalid', errorCode: 'invalid-learning-graph' })
  })
})
