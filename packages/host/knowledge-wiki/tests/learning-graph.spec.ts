import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createReadOnlyLearningVerifier } from '../src/external-verifier-adapter.ts'
import { validateLearningReceiptChain } from '../src/verifier.ts'
import { canonicalJson, sha256 } from '../src/verifier.ts'
import type { ArtifactRef } from '../src/learning-artifacts.ts'
import { createLearningGraphFixture, FIXTURE_TIME, LearningFixtureSigners, type LearningFixtureChanges } from './learning-graph-fixture.ts'

type Fixture = ReturnType<typeof createLearningGraphFixture>
type ObjectValue = Record<string, unknown>
const fixtures: Fixture[] = []
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.artifacts.dispose() })

function fixture(changes: LearningFixtureChanges = {}): Fixture {
  const value = createLearningGraphFixture(changes)
  fixtures.push(value)
  return value
}

function authority(value: Fixture) {
  // The JSON-shaped synthetic descriptor is still parsed at the actual owner
  // boundary. This cast supplies no trust, reducer, or verification callback.
  return createReadOnlyLearningVerifier({
    descriptor: value.descriptor,
    captureContext: value.captureContext,
    reducerSourceHash: value.reducerSourceHash,
  })
}

function consume(value: Fixture) { return validateLearningReceiptChain(authority(value), value.trial) }
function object(value: unknown): ObjectValue { return value as ObjectValue }
function bytesBefore(value: Fixture) {
  return readdirSync(value.artifacts.root, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map((entry) => {
      const path = join(entry.parentPath, entry.name)
      return { path: relative(value.artifacts.root, path), bytes: readFileSync(path) }
    })
    .sort((left, right) => left.path.localeCompare(right.path))
}

type UnrelatedBinding = 'use-facts' | 'use-grant-id' | 'grant-definition-hash' | 'grant-definition-id' | 'trial-grant-id'
  | 'trial-grant-ref' | 'trial-grant-scope' | 'trial-ordered-arm' | 'grant-duplicate-fields' | 'standalone-use-arm'

/** Keep a complete second trial in the current journal while changing only its unrelated request subgraph. */
function fixtureWithUnrelatedTrial(binding?: UnrelatedBinding, standalone = false): Fixture {
  const value = fixture()
  const unrelated = createLearningGraphFixture({}, {
    artifacts: value.artifacts, signers: value.signers, journal: value.journal, tag: 'unrelated', timeOffsetMs: 10_000,
    allowedDefinitions: value.descriptor.evaluator.allowedDefinitions,
    allowedInitiationCapabilities: value.descriptor.evaluator.allowedInitiationCapabilities,
    sessionContexts: value.sessionContexts,
  })
  value.descriptor.evaluator.allowedDefinitions = unrelated.descriptor.evaluator.allowedDefinitions
  value.descriptor.evaluator.allowedInitiationCapabilities = unrelated.descriptor.evaluator.allowedInitiationCapabilities
  for (const [sessionId, context] of unrelated.sessionContexts) value.sessionContexts.set(sessionId, context)
  if (standalone) {
    for (let index = value.journal.events.length - 1; index >= 0; index--) {
      const payload = object(value.journal.events[index]!['payload'])
      if (payload['grantId'] === unrelated.authorization['grantId']
        && (payload['type'] === 'knowledge/trial-measured' || payload['type'] === 'knowledge/trial-closed')) {
        value.journal.events.splice(index, 1)
      }
    }
  }

  if (binding !== undefined) {
    const artifacts = value.artifacts
    const reissue = (ref: ArtifactRef, payload: ObjectValue, request: ObjectValue, header: ObjectValue = {}): ArtifactRef => {
      const original = artifacts.json(ref)
      return artifacts.put(value.signers.evaluatorEnvelope(String(original['kind']), payload, artifacts.put(request), {
        issuedAt: original['issuedAt'], expiresAt: original['expiresAt'], ...header,
      }))
    }
    const originalTrial = artifacts.json(unrelated.trial)
    const trial = structuredClone(object(originalTrial['payload']))
    const trialRequest = structuredClone(artifacts.json(originalTrial['requestArtifact'] as ArtifactRef))
    if (binding === 'grant-definition-hash' || binding === 'grant-definition-id' || binding === 'grant-duplicate-fields') {
      const originalGrant = artifacts.json(unrelated.grant)
      const grant = structuredClone(object(originalGrant['payload']))
      const request = structuredClone(artifacts.json(originalGrant['requestArtifact'] as ArtifactRef))
      if (binding === 'grant-definition-hash') grant['definitionHash'] = sha256('not the actual unrelated definition digest')
      else if (binding === 'grant-definition-id') request['definitionId'] = 'not-the-resolved-unrelated-definition'
      else grant['evaluatedContentHash'] = sha256('not the evaluated content of the referenced proposal')
      const malformed = reissue(unrelated.grant, grant, request)
      trial['grant'] = malformed
      trialRequest['grant'] = malformed
    } else if (binding === 'use-facts' || binding === 'use-grant-id' || binding === 'trial-grant-ref'
      || binding === 'trial-grant-scope' || binding === 'trial-ordered-arm' || binding === 'standalone-use-arm') {
      const originalUseRef = (trial['allUsesInPreregisteredOrder'] as ArtifactRef[])[0]!
      const originalUse = artifacts.json(originalUseRef)
      const use = structuredClone(object(originalUse['payload']))
      const request = structuredClone(artifacts.json(originalUse['requestArtifact'] as ArtifactRef))
      if (binding === 'use-facts') {
        const facts = structuredClone(artifacts.json(request['facts'] as ArtifactRef))
        facts['initialWorld'] = use['finalWorld']
        request['facts'] = artifacts.put(facts)
      } else if (binding === 'use-grant-id') request['grant'] = value.grant
      else if (binding === 'trial-ordered-arm' || binding === 'standalone-use-arm') {
        use['sessionId'] = unrelated.sessions[1]?.session.id
        const { oracle: _oracle, result: _result, ...facts } = use
        request['facts'] = artifacts.put(facts)
      } else {
        const originalGrant = artifacts.json(unrelated.grant)
        const grant = structuredClone(object(originalGrant['payload']))
        const grantRequest = artifacts.json(originalGrant['requestArtifact'] as ArtifactRef)
        const header = binding === 'trial-grant-ref'
          ? { expiresAt: new Date(Date.parse(String(originalGrant['expiresAt'])) + 1).toISOString() } : {}
        if (binding === 'trial-grant-scope') grant['scope'] = { projectId: 'different-project', visibility: 'project' }
        request['grant'] = reissue(unrelated.grant, grant, grantRequest, header)
      }
      const malformed = reissue(originalUseRef, use, request)
      const uses = [...trial['allUsesInPreregisteredOrder'] as ArtifactRef[]]
      uses[0] = malformed
      trial['allUsesInPreregisteredOrder'] = uses
      trialRequest['useReceipts'] = uses
      if (standalone) {
        const observed = value.journal.events.find(event => object(event['payload'])['type'] === 'knowledge/use-observed'
          && object(event['payload'])['useId'] === use['useId'])
        const measured = value.journal.events.find(event => object(event['payload'])['type'] === 'knowledge/use-measured'
          && object(event['payload'])['useId'] === use['useId'])
        if (observed === undefined || measured === undefined) throw new Error('synthetic standalone measured use unavailable')
        object(observed['payload'])['factManifest'] = request['facts']
        object(measured['payload'])['receipt'] = malformed
      }
    } else trial['grantId'] = 'not-the-resolved-unrelated-grant'

    if (!standalone) {
      const malformedTrial = reissue(unrelated.trial, trial, trialRequest)
      const row = value.journal.events.find(event => object(event['payload'])['type'] === 'knowledge/trial-measured'
        && object(event['payload'])['grantId'] === unrelated.authorization['grantId'])
      if (row === undefined) throw new Error('synthetic unrelated trial journal row unavailable')
      object(row['payload'])['receipt'] = malformedTrial
      object(row['payload'])['grantId'] = trial['grantId']
    }
    // Re-sign exact current event bytes after the changed reference; retained earlier snapshots remain unchanged.
    let previousEventHash: string | null = null
    for (const [index, original] of value.journal.events.entries()) {
      const { eventHash: _eventHash, seal: _seal, ...body } = original
      body['previousEventHash'] = previousEventHash
      const seal = value.signers.journalEnvelope('event', { eventBodyHash: sha256(canonicalJson(body)) })
      const eventHash = sha256(canonicalJson({ ...body, seal }))
      value.journal.events[index] = { ...body, seal, eventHash }
      previousEventHash = eventHash
    }
  }
  Object.assign(value.currentJournal, value.journal.head())
  return { ...value, captureContext: () => ({ ...value.captureContext(), now: unrelated.times.now }) }
}

function retainBindingFixture(value: Fixture, name: string, result: ReturnType<typeof consume>): void {
  const retainedRoot = process.env['DSH_LEARNING_GRAPH_TEST_EVIDENCE_ROOT']
  if (retainedRoot === undefined) return
  mkdirSync(retainedRoot, { recursive: true, mode: 0o700 })
  cpSync(value.artifacts.root, join(retainedRoot, name), { recursive: true })
  writeFileSync(join(retainedRoot, `${name}-index.json`), JSON.stringify({
    classification: 'TEST_ONLY_SYNTHETIC_GRAPH_NOT_REAL_LEARNING', providerCalls: 0, privateKeysPersisted: false,
    result, trial: value.trial, descriptor: value.descriptor,
    ownerContext: { ...value.captureContext(), sessionContexts: [...value.sessionContexts] },
    artifacts: [...value.artifacts.entries.values()].map(entry => entry.ref), originalStore: value.artifacts.root,
  }, null, 2), { mode: 0o600 })
}

describe('complete read-only synthetic learning graph', () => {
  it('consumes the complete synthetic DAG through the actual private consumer without granting credit', () => {
    const value = fixture()
    const before = bytesBefore(value)
    const result = consume(value)
    const retainedRoot = process.env['DSH_LEARNING_GRAPH_TEST_EVIDENCE_ROOT']
    if (retainedRoot !== undefined) {
      mkdirSync(retainedRoot, { recursive: true, mode: 0o700 })
      cpSync(value.artifacts.root, join(retainedRoot, 'complete-synthetic-fixture'), { recursive: true })
      writeFileSync(join(retainedRoot, 'complete-synthetic-fixture-index.json'), JSON.stringify({
        classification: 'TEST_ONLY_SYNTHETIC_GRAPH_NOT_REAL_LEARNING', providerCalls: 0,
        evaluatorPrivateKeyPersisted: false, journalPrivateKeyPersisted: false, result,
        trial: value.trial, descriptor: value.descriptor,
        ownerContext: { ...value.captureContext(), sessionContexts: [...value.sessionContexts] },
        artifacts: [...value.artifacts.entries.values()].map(({ ref }) => ref),
        originalStore: value.artifacts.root,
      }, null, 2), { mode: 0o600 })
    }
    expect(result).toMatchObject({
      status: 'validated', proposalHash: value.proposal.digest, grantId: 'synthetic-grant-1', trialHash: value.trial.digest,
      evaluatedContentHash: value.proposalPayload['evaluatedContentHash'], candidateKnowledgeId: 'synthetic-candidate', canonicalKnowledgeId: 'synthetic-candidate',
      trialResult: 'pass', uniqueCandidateUseIds: ['synthetic-use-candidate'], creditCommitted: false, activationAllowed: false,
      uses: [{ useId: 'synthetic-use-baseline', variant: 'baseline', result: 'fail' }, { useId: 'synthetic-use-candidate', variant: 'candidate', result: 'pass' }],
      recomputedCounts: value.trialPayload['counts'], evaluation: value.evaluationOutput,
    })
    expect(value.evaluationInput.records).toHaveLength(2)
    expect(value.evaluationInput.records[0]).toMatchObject({ variant: 'baseline', verificationStatus: 'verified' })
    expect(Object.keys(value.evaluationOutput.metrics)).toHaveLength(17)
    expect(value.semantic.verifiedRecord).toMatchObject({ successfulUses: 0, retrievalHits: 0, utilityScore: 0, lifecycle: 'candidate' })
    expect(value.sessions.map(session => session.session.events.at(-1)?.type)).toEqual(['turn/end', 'turn/end'])
    expect(value.sessions.every(session => !session.session.events.some(event => event.type === 'session/end-seed'))).toBe(true)
    expect(value.artifacts.entries.size).toBeGreaterThan(50)
    expect(bytesBefore(value)).toEqual(before)
    expect(consume(value)).toEqual(result)
    expect(bytesBefore(value)).toEqual(before)

  })

  it('retains an independently signed unknown baseline arm and the real reducer UNKNOWN output', () => {
    const value = fixture({ use(use, variant) {
      if (variant === 'baseline') {
        use['result'] = 'unknown'
        const oracle = object(use['oracle'])
        oracle['verdict'] = 'unknown'; oracle['taskSuccess'] = 'unknown'; oracle['correctRepairReuse'] = 'unknown'
      }
    } })
    expect(consume(value)).toMatchObject({ status: 'validated', trialResult: 'unknown', evaluation: { verifiedPairs: 0, smartnessClaim: { status: 'UNKNOWN' } }, creditCommitted: false, activationAllowed: false,
      uses: [{ useId: 'synthetic-use-baseline', variant: 'baseline', result: 'unknown' }, { useId: 'synthetic-use-candidate', variant: 'candidate', result: 'pass' }] })
    expect(value.trialPayload['omittedUses']).toEqual([])
    expect(value.useReceipts).toHaveLength(2)
  })

  it('keeps a complete authenticated failed trial as a failed trial', () => {
    const value = fixture({ use(use, variant) {
      if (variant === 'candidate') {
        use['result'] = 'fail'
        const oracle = object(use['oracle'])
        oracle['verdict'] = 'fail'; oracle['taskSuccess'] = 'fail'; oracle['correctRepairReuse'] = 'fail'
        object(object(oracle['counts'])['verifiedTaskSuccess'])['numerator'] = 0
        object(object(oracle['counts'])['repairReuseSuccess'])['numerator'] = 0
      }
    } })
    expect(consume(value)).toMatchObject({ status: 'validated', trialResult: 'fail', evaluation: { verifiedPairs: 1, smartnessClaim: { status: 'NOT_SUPPORTED' } }, uniqueCandidateUseIds: [], creditCommitted: false, activationAllowed: false })
  })

  const tamperCases: readonly { name: string; changes: LearningFixtureChanges }[] = [
    { name: 'review cross-reference', changes: { proposal(value) { value['reviewHash'] = sha256('different review') } } },
    { name: 'semantic source identity', changes: { proposal(value) { value['sourceIdentity'] = { ...object(value['sourceIdentity']), buildDigest: sha256('different build') } } } },
    { name: 'signed capability principal', changes: { capability(value) { value['approvedActorPrincipalId'] = 'different-principal' } } },
    { name: 'signed capability candidate identity', changes: { capability(value) { value['candidateAdmissionIdentityHash'] = sha256('different admission') } } },
    { name: 'definition arm omission', changes: { definition(value) { value['completeOrderedArms'] = [object(value['completeOrderedArms'])[0]] } } },
    { name: 'required safety metric omission', changes: { definition(value) { value['requiredMetricNames'] = (value['requiredMetricNames'] as string[]).filter(name => name !== 'memoryPoisoning') } } },
    { name: 'signed definition budget below the already consumed traversal count', changes: { definition(value) { value['maxArtifacts'] = 1 } } },
    { name: 'different paired frozen world with matching use reference', changes: { definition(value) { const arm = object((value['completeOrderedArms'] as unknown[])[1]); arm['frozenTaskWorld'] = arm['expectedOutputManifest'] } } },
    { name: 'different paired expected output manifest', changes: { definition(value) { const arm = object((value['completeOrderedArms'] as unknown[])[1]); arm['expectedOutputManifest'] = arm['frozenTaskWorld'] } } },
    { name: 'snapshot complete record identity', changes: { snapshot(value) { object(value['admissionIdentity'])['sourceHash'] = sha256('different source') } } },
    { name: 'snapshot watermark prefix', changes: { snapshot(value) { object(object(value['watermark'])['checkpoint'])['payload'] = {} } } },
    { name: 'exact target transform', changes: { proposal(value) { value['targetAfter'] = value['candidate']; value['evaluatedContentHash'] = value['candidateHash'] } } },
    { name: 'broadened scope', changes: { proposal(value) { value['scope'] = {} } } },
    { name: 'broadened ACL', changes: { proposal(value) { value['acl'] = null } } },
    { name: 'extended finite expiry', changes: { proposal(value) { value['knowledgeExpiresAt'] = '2026-11-08T00:00:00.000Z' } } },
    { name: 'existing target old hash only', changes: { proposal(value) { value['targetBefore'] = value['candidate']; value['targetGovernance'] = { kind: 'existing', governed: value['governedCandidate'] }; object(value['decision'])['action'] = 'Replace' } } },
    { name: 'grant proposal hash', changes: { grant(value) { value['proposalHash'] = sha256('different proposal') } } },
    { name: 'child request operation', changes: { childRequest(value) { if (value['operation'] === 'measureUse') value['operation'] = 'authorizeTrial' } } },
    { name: 'child request use identity', changes: { childRequest(value) { if (value['operation'] === 'measureUse') value['useId'] = 'unregistered-use' } } },
    { name: 'missing candidate provider facts', changes: { use(value, variant) { if (variant === 'candidate') value['requests'] = [] } } },
    { name: 'jointly omitted provider attempt and reservation', changes: { sessionFacts(value, variant) {
      if (variant !== 'candidate') return
      const removed = value.requests.shift()
      const index = value.reservations.findIndex(reservation => reservation['requestAttemptId'] === removed?.['attemptId'])
      value.reservations.splice(index, 1)
      for (const request of value.requests) request['ordinal'] = 1
      for (const reservation of value.reservations) if (reservation['phase'] === 'model-request') reservation['ordinal'] = 1
    } } },
    { name: 'wrong final content hash', changes: { use(value, variant) { if (variant === 'candidate') value['evaluatedContentHash'] = sha256('candidate raw bytes instead of final output') } } },
    { name: 'use arm cross-reference', changes: { use(value, variant) { if (variant === 'candidate') value['pairId'] = 'different-pair' } } },
    { name: 'injection rendered accounting', changes: { use(value, variant) { if (variant === 'candidate') object((value['injections'] as unknown[])[0])['renderedToolResultHash'] = sha256('different rendered result') } } },
    { name: 'oracle definition cross-reference', changes: { use(value, variant) { if (variant === 'candidate') object(value['oracle'])['oracleDefinitionHash'] = sha256('different oracle') } } },
    { name: 'use result contradicts signed oracle verdict', changes: { use(value, variant) { if (variant === 'candidate') value['result'] = 'fail' } } },
    { name: 'evaluator wrong role', changes: { useEnvelope(value, _variant, signers) { return signers.journalEnvelope('event', object(value['payload'])) } } },
    { name: 'evaluator wrong key', changes: { useEnvelope(value) { const other = new LearningFixtureSigners(); return other.evaluatorEnvelope('measured-use', object(value['payload']), value['requestArtifact'] as ArtifactRef) } } },
    { name: 'evaluator wrong domain with valid signature', changes: { useEnvelope(value, _variant, signers) { return signers.evaluatorEnvelope('measured-use', object(value['payload']), value['requestArtifact'] as ArtifactRef, { domain: 'ark.knowledge.local-journal' }) } } },
    { name: 'old hash-only request', changes: { useEnvelope(value, _variant, signers) { return signers.evaluatorEnvelope('measured-use', object(value['payload']), null, { requestHash: value['requestHash'] }) } } },
    { name: 'altered protected head', changes: { protectedHead(value) { value['eventHash'] = sha256('different protected event') } } },
    { name: 'protected suffix truncation', changes: { protectedHead(value) { value['seq'] = Number(value['seq']) - 1 } } },
    { name: 'claimed aggregate count', changes: { trial(value) { object(object(object(value['counts'])['knowledgeUtility'])['candidate'])['numerator'] = 0 } } },
    { name: 'aggregate failed arm omission', changes: { trial(value) { value['allUsesInPreregisteredOrder'] = (value['allUsesInPreregisteredOrder'] as unknown[]).slice(1); value['omittedUses'] = ['synthetic-use-baseline'] } } },
    { name: 'duplicate signed use', changes: { trial(value) { const uses = value['allUsesInPreregisteredOrder'] as unknown[]; value['allUsesInPreregisteredOrder'] = [uses[0], uses[0]] } } },
    { name: 'reducer output swap', changes: { trial(value) { value['evaluationOutput'] = value['evaluationInput'] } } },
  ]
  it.each(tamperCases)('rejects $name after independent fixture re-signing', ({ changes }) => {
    expect(consume(fixture()).status).toBe('validated')
    const value = fixture(changes)
    const before = bytesBefore(value)
    expect(consume(value)).toEqual({ status: 'invalid', errorCode: 'invalid-learning-graph' })
    expect(bytesBefore(value)).toEqual(before)
  })

  it.each(['knowledge/rejected', 'knowledge/conflict', 'knowledge/expired', 'knowledge/rolled_back'])('denies current terminal suffix %s', (type) => {
    expect(consume(fixture()).status).toBe('validated')
    const value = fixture({ suffix(journal, knowledgeId) { journal.append(knowledgeId, { type, evidence: journal.artifacts.put({ kind: 'TEST_ONLY', reason: type }) }) } })
    expect(consume(value)).toEqual({ status: 'invalid', errorCode: 'invalid-learning-graph' })
  })

  it('denies the exact same source owner even when the second owner is terminal', () => {
    expect(consume(fixture()).status).toBe('validated')
    const value = fixture({ suffix(journal, _knowledgeId, record) {
      journal.append('synthetic-competing-id', { type: 'knowledge/candidate', legacyShapePayload: { record: { ...record, id: 'synthetic-competing-id' } } })
      journal.append('synthetic-competing-id', { type: 'knowledge/rejected', evidence: journal.artifacts.put({ kind: 'TEST_ONLY', reason: 'terminal duplicate source' }) })
    } })
    expect(consume(value)).toEqual({ status: 'invalid', errorCode: 'invalid-learning-graph' })
  })

  it.each(['proposal', 'mission manifest', 'child request kind'])('resolves an unrelated signed journal grant with invalid %s evidence', (edge) => {
    expect(consume(fixture()).status).toBe('validated')
    const value = fixture({ suffix(journal, knowledgeId) {
      const original = journal.events.find(event => object(event['payload'])['type'] === 'knowledge/trial-authorized')
      if (original === undefined) throw new Error('synthetic original authorization unavailable')
      const originalPayload = object(original['payload'])
      const grant = journal.artifacts.json(originalPayload['grant'] as ArtifactRef)
      const authorization = structuredClone(object(grant['payload']))
      const capability = journal.artifacts.json(authorization['initiationCapability'] as ArtifactRef)
      const initiation = journal.artifacts.put(journal.signers.evaluatorEnvelope('trial-initiation-capability', {
        ...object(capability['payload']), capabilityId: 'unrelated-capability-2',
      }, null))
      const missing: ArtifactRef = { algorithm: 'sha256', digest: sha256(`absent unrelated ${edge}`), bytes: 1, mediaType: 'application/json' }
      authorization['grantId'] = 'unrelated-grant-2'
      authorization['initiationCapability'] = initiation
      if (edge === 'proposal') {
        authorization['proposal'] = missing
        authorization['proposalHash'] = missing.digest
      } else if (edge === 'mission manifest') {
        for (const arm of authorization['sessionArms'] as ObjectValue[]) object(object(arm['run'])['mission'])['originalManifest'] = missing
      }
      const observed = journal.events.find(event => object(event['payload'])['type'] === 'knowledge/use-observed')
      if (observed === undefined) throw new Error('synthetic original observed facts unavailable')
      const request = journal.artifacts.put(edge === 'child request kind'
        ? { schemaVersion: 2, requestId: 'unrelated-wrong-kind-request-2', operation: 'measureUse', grant: originalPayload['grant'],
          useId: object(observed['payload'])['useId'], facts: object(observed['payload'])['factManifest'] }
        : { schemaVersion: 2, requestId: 'unrelated-authorize-request-2', operation: 'authorizeTrial',
          proposal: authorization['proposal'], definitionId: 'synthetic-definition-1', initiationCapability: initiation })
      const signed = journal.artifacts.put(journal.signers.evaluatorEnvelope('trial-authorization', authorization, request))
      journal.append(knowledgeId, { type: 'knowledge/trial-authorized', grant: signed,
        proposal: authorization['proposal'], initiationCapabilityHash: initiation.digest })
    } })
    const before = bytesBefore(value)
    expect(consume(value)).toEqual({ status: 'invalid', errorCode: 'invalid-learning-graph' })
    expect(bytesBefore(value)).toEqual(before)
  })

  const unrelatedBindings: readonly { name: string; binding: UnrelatedBinding }[] = [
    { name: 'measured-use original facts differ from the signed complete product projection', binding: 'use-facts' },
    { name: 'measured-use original grant resolves to a different grant id', binding: 'use-grant-id' },
    { name: 'authorization definition hash differs from the actual definition digest', binding: 'grant-definition-hash' },
    { name: 'authorization original definition id differs from the resolved definition', binding: 'grant-definition-id' },
    { name: 'measured-trial grant id differs from the resolved original grant', binding: 'trial-grant-id' },
    { name: 'ordered measured-use original grant has the same payload but a distinct signed ArtifactRef', binding: 'trial-grant-ref' },
    { name: 'ordered measured-use original grant reuses the grant id with a different scope', binding: 'trial-grant-scope' },
    { name: 'ordered measured-use session id differs from its granted arm with otherwise exact product facts', binding: 'trial-ordered-arm' },
    { name: 'authorization evaluated content duplicate differs from its referenced proposal', binding: 'grant-duplicate-fields' },
  ]
  it.each(unrelatedBindings)('rejects unrelated current-journal binding: $name', ({ binding }) => {
    const positive = fixtureWithUnrelatedTrial()
    const positiveBefore = bytesBefore(positive)
    const positiveResult = consume(positive)
    retainBindingFixture(positive, `unrelated-positive-${binding}`, positiveResult)
    expect(positiveResult.status).toBe('validated')
    expect(bytesBefore(positive)).toEqual(positiveBefore)
    const value = fixtureWithUnrelatedTrial(binding)
    const before = bytesBefore(value)
    const result = consume(value)
    retainBindingFixture(value, `unrelated-malformed-${binding}`, result)
    expect(result).toEqual({ status: 'invalid', errorCode: 'invalid-learning-graph' })
    expect(bytesBefore(value)).toEqual(before)
  })

  it('rejects unrelated standalone measured-use arm mismatch without an enclosing trial', () => {
    const positive = fixtureWithUnrelatedTrial(undefined, true)
    const positiveBefore = bytesBefore(positive)
    const positiveResult = consume(positive)
    retainBindingFixture(positive, 'standalone-positive-use-arm', positiveResult)
    expect(positiveResult.status).toBe('validated')
    expect(bytesBefore(positive)).toEqual(positiveBefore)
    const value = fixtureWithUnrelatedTrial('standalone-use-arm', true)
    const before = bytesBefore(value)
    const result = consume(value)
    retainBindingFixture(value, 'standalone-malformed-use-arm', result)
    expect(result).toEqual({ status: 'invalid', errorCode: 'invalid-learning-graph' })
    expect(bytesBefore(value)).toEqual(before)
  })

  it('allows authenticated observational growth while preserving immutable admission identity', () => {
    const value = fixture({ suffix(journal, knowledgeId, record) {
      journal.append(knowledgeId, { type: 'knowledge/retrieved', legacyShapePayload: { path: record.source, retrievalAt: FIXTURE_TIME.measured } })
    } })
    expect(consume(value)).toMatchObject({ status: 'validated', trialResult: 'pass', creditCommitted: false, activationAllowed: false })
  })

  it('denies the unchanged retention gate after three authenticated neutral retrievals', () => {
    expect(consume(fixture()).status).toBe('validated')
    const value = fixture({ suffix(journal, knowledgeId, record) {
      for (let index = 0; index < 3; index += 1) journal.append(knowledgeId, { type: 'knowledge/retrieved', legacyShapePayload: { path: record.source, retrievalAt: FIXTURE_TIME.measured } })
    } })
    expect(consume(value)).toEqual({ status: 'invalid', errorCode: 'invalid-learning-graph' })
  })

  it('checks exact provider bytes again at consumption and never repairs an altered artifact', () => {
    const value = fixture()
    expect(consume(value).status).toBe('validated')
    const provider = value.artifacts.json((value.usePayloads[1]?.['requests'] as ArtifactRef[])[0]!)
    const body = provider['requestBody'] as ArtifactRef
    writeFileSync(value.artifacts.path(body), 'altered synthetic request bytes')
    const before = bytesBefore(value)
    expect(consume(value)).toEqual({ status: 'invalid', errorCode: 'invalid-learning-graph' })
    expect(bytesBefore(value)).toEqual(before)
  })

  it('captures current owner context anew and requires the genuine private owner association', () => {
    const value = fixture()
    const selected = authority(value)
    expect(validateLearningReceiptChain(selected, value.trial).status).toBe('validated')
    value.currentJournal.protectedHead.eventHash = sha256('new divergent protected head')
    expect(validateLearningReceiptChain(selected, value.trial)).toEqual({ status: 'invalid', errorCode: 'invalid-learning-graph' })
    expect(validateLearningReceiptChain(undefined, value.trial)).toEqual({ status: 'unavailable', errorCode: 'learning-owner-unavailable' })
    expect(validateLearningReceiptChain({ ...selected }, value.trial)).toEqual({ status: 'unavailable', errorCode: 'learning-owner-unavailable' })
  })

  it('expires the evidence through the actual recaptured clock owner', () => {
    const value = fixture()
    const selected = createReadOnlyLearningVerifier({ descriptor: value.descriptor, reducerSourceHash: value.reducerSourceHash,
      captureContext: () => ({ ...value.captureContext(), now: FIXTURE_TIME.evidenceExpiry }) })
    expect(validateLearningReceiptChain(selected, value.trial)).toEqual({ status: 'invalid', errorCode: 'invalid-learning-graph' })
  })

  it('requires the selected fixed epoch on every fresh owner capture', () => {
    const value = fixture()
    const selected = authority(value)
    expect(validateLearningReceiptChain(selected, value.trial).status).toBe('validated')
    value.currentJournal.protectedHead.epoch = 'different-epoch-without-an-owner-transition'
    expect(validateLearningReceiptChain(selected, value.trial)).toEqual({ status: 'unavailable', errorCode: 'learning-owner-unavailable' })
  })
})
