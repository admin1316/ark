import { generateKeyPairSync, sign } from 'node:crypto'
import { link, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createFileMeasuredTrialArtifactResolver,
  createKnowledgeWikiMeasuredTrialReader,
  MEASURED_TRIAL_METRICS,
  type OpportunityCounts,
} from '../src/measured-trial.ts'
import { canonicalJson, sha256 } from '../src/verifier.ts'

const evaluator = generateKeyPairSync('ed25519')
const journalSigner = generateKeyPairSync('ed25519')
const authorityId = 'independent-evaluator-v1'
const measurementDefinitionHash = sha256('measurement-definition')
const modelIdentity = {
  model: 'deepseek-v4-flash',
  modelConfigHash: sha256('same-model-config'),
  taskHash: sha256('same-task'),
  goalHash: sha256('same-goal'),
  policyHash: sha256('same-policy'),
}

type FixtureStage = 'proposal' | 'preregistration' | 'grant' | 'baseline' | 'candidate' | 'journal' | 'trial'

describe('file-backed measured-trial artifact resolver', () => {
  it('reads only hash-named ordinary files within an existing absolute root', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'ark-measured-trial-store-'))
    const root = join(parent, 'artifacts')
    const outside = join(parent, 'outside.bin')
    await mkdir(root)
    try {
      const bytes = Buffer.from('immutable artifact bytes\n')
      const artifactHash = sha256(bytes)
      await writeFile(join(root, artifactHash), bytes)
      await writeFile(outside, bytes)
      const resolver = createFileMeasuredTrialArtifactResolver(root)
      expect(Buffer.from(resolver.resolveArtifact(artifactHash) ?? [])).toEqual(bytes)
      expect(resolver.resolveArtifact('not-a-hash')).toBeUndefined()
      expect(resolver.resolveArtifact('f'.repeat(64))).toBeUndefined()

      const linkedHash = sha256('linked artifact bytes')
      await symlink(outside, join(root, linkedHash))
      expect(() => resolver.resolveArtifact(linkedHash)).toThrow(/symbolic link|ordinary file/u)

      const hardLinkedHash = sha256('hard-linked artifact bytes')
      const hardLinkedBytes = Buffer.from('hard-linked artifact bytes')
      const hardLinkTarget = join(parent, 'hard-link-source.bin')
      await writeFile(hardLinkTarget, hardLinkedBytes)
      await link(hardLinkTarget, join(root, hardLinkedHash))
      expect(() => resolver.resolveArtifact(hardLinkedHash)).toThrow(/ordinary file/u)

      const rootLink = join(parent, 'linked-root')
      await symlink(root, rootLink)
      expect(() => createFileMeasuredTrialArtifactResolver(rootLink)).toThrow(/ordinary directory/u)
      expect(() => createFileMeasuredTrialArtifactResolver('relative/artifacts')).toThrow(/absolute/u)
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })
})

function signRecord<T extends Record<string, unknown>>(record: T): T & { evaluatorAuthorityId: string; evaluatorSignature: string } {
  const unsigned = { ...record, evaluatorAuthorityId: authorityId }
  const evaluatorSignature = sign(null, Buffer.from(canonicalJson(unsigned), 'utf8'), evaluator.privateKey).toString('base64')
  return { ...unsigned, evaluatorSignature }
}

function zeroCounts(): Record<string, { numerator: number; denominator: number }> {
  return Object.fromEntries(MEASURED_TRIAL_METRICS.map(metric => [metric, { numerator: 0, denominator: 1 }]))
}

function sumCounts(records: Array<{ role: 'baseline' | 'candidate'; counts: OpportunityCounts }>, role: 'baseline' | 'candidate'): OpportunityCounts {
  return Object.fromEntries(MEASURED_TRIAL_METRICS.map(metric => [metric, records
    .filter(record => record.role === role)
    .reduce((sum, record) => ({
      numerator: sum.numerator + record.counts[metric].numerator,
      denominator: sum.denominator + record.counts[metric].denominator,
    }), { numerator: 0, denominator: 0 })])) as OpportunityCounts
}

function fixture(options: {
  candidateUtility?: number
  crossSessionLeakage?: number
  injectedContent?: string
  mutateInjectedEvent?: (event: Record<string, unknown>) => void
  includeProviderRequest?: boolean
  includeJournal?: boolean
  journalPublicKey?: typeof journalSigner.publicKey
  journalSignedByEvaluator?: boolean
  journalBytes?: string
  mutateJournalAfterSigning?: (record: Record<string, unknown>) => void
  mutateAfterJournal?: (role: 'baseline' | 'candidate', record: Record<string, unknown>) => void
  pairs?: number
  reuseSessionIds?: boolean
  duplicateUseIds?: 'candidate-across-pairs' | 'between-arms'
  mutate?: (stage: FixtureStage, record: Record<string, unknown>) => void
  resolveArtifact?: (hash: string, bytes: Buffer | undefined) => Uint8Array | undefined
} = {}) {
  const files = new Map<string, Buffer>()
  const pairIds = Array.from({ length: options.pairs ?? 1 }, (_, index) => `pair-${index + 1}`)
  const amend = <T extends Record<string, unknown>>(stage: FixtureStage, record: T): T => {
    const amended = structuredClone(record)
    options.mutate?.(stage, amended)
    return amended
  }
  const putRaw = (value: string): string => {
    const bytes = Buffer.from(value, 'utf8')
    const hash = sha256(bytes)
    files.set(hash, bytes)
    return hash
  }
  const putCanonical = (value: Record<string, unknown>): string => {
    const canonical = canonicalJson(value)
    const hash = sha256(canonical)
    files.set(hash, Buffer.from(canonical, 'utf8'))
    return hash
  }
  const candidateBytes = 'candidate knowledge bytes\n'
  const targetAfterBytes = '---\nstatus: canonical\n---\nFrozen repaired rule.\n'
  const candidateHash = putRaw(candidateBytes)
  const targetAfterHash = putRaw(targetAfterBytes)
  const semanticReceiptHash = putCanonical({ schemaVersion: 1, receiptId: 'semantic-1', candidateHash })
  const sourceArtifactManifestHash = putCanonical({ schemaVersion: 1, sourceArtifacts: [sha256('source')] })
  const governedRecordHash = putCanonical({ schemaVersion: 1, knowledgeId: 'candidate:repair-1' })
  const scopeAclExpiryHash = putCanonical({ schemaVersion: 1, scope: 'project', acl: null, expiresAt: '2026-11-10T10:00:00.000Z' })
  const proposal = {
    schemaVersion: 1,
    reviewHash: sha256('review-row'),
    semanticReceiptHash,
    candidatePath: '_candidates/ingest/concepts/repair.md',
    candidateHash,
    sourceArtifactManifestHash,
    governedRecordHash,
    scopeAclExpiryHash,
    action: 'Promote',
    targetPath: 'concepts/repair.md',
    targetBeforeHashOrVerifiedAbsence: 'verified-absence',
    targetAfterHash,
    frozenApprovalActor: 'reviewer-1',
    frozenApprovalTime: '2026-10-11T10:00:00.000Z',
    transformVersion: 'knowledge-promotion-v1',
    sourceIdentity: { commit: 'a'.repeat(40), sourceDigest: sha256('source') },
    buildIdentity: { build: 'candidate-326', digest: sha256('build') },
    profileIdentity: { profile: 'jiuzhang', digest: sha256('profile') },
    modelPolicyIdentity: { model: 'deepseek-v4-flash', policyHash: modelIdentity.policyHash },
    immutableMissionIdentity: { goalHash: modelIdentity.goalHash, acceptanceHash: sha256('acceptance') },
  }
  const proposalHash = putCanonical(amend('proposal', proposal))
  const preRegistration = signRecord(amend('preregistration', {
    schemaVersion: 1,
    preRegistrationId: 'preregistered-repair-trial-1',
    proposalHash,
    measurementDefinitionHash,
    modelConfigTaskGoalPolicyIdentity: modelIdentity,
    orderedPairIds: pairIds,
    issuedAt: '2026-10-11T09:59:00.000Z',
  }))
  const preRegistrationHash = putCanonical(preRegistration)
  const grant = signRecord(amend('grant', {
    schemaVersion: 1,
    grantId: 'grant-1',
    proposalHash,
    reviewedDecisionHash: proposalHash,
    preRegistrationHash,
    measurementDefinitionHash,
    allowedSessionIds: pairIds.map((_pairId, index) => `candidate-session-${index + 1}`),
    modelConfigTaskGoalPolicyIdentity: modelIdentity,
    maxObservations: pairIds.length,
    maxTurns: pairIds.length,
    deadline: '2026-10-11T10:10:00.000Z',
    issuedAt: '2026-10-11T10:00:01.000Z',
    expiresAt: '2026-10-11T10:20:00.000Z',
  }))
  const grantHash = putCanonical(grant)
  const useRecords: Array<{
    role: 'baseline' | 'candidate'
    counts: OpportunityCounts
    receiptHash: string
  }> = []
  for (const { pairId, index, role } of pairIds.flatMap((pairId, index) =>
    (['baseline', 'candidate'] as const).map(role => ({ pairId, index, role })))) {
    const counts = zeroCounts()
    if (role === 'baseline') counts['knowledgeUtility'] = { numerator: 0, denominator: 2 }
    else {
      counts['knowledgeUtility'] = { numerator: options.candidateUtility ?? 1, denominator: 2 }
      counts['repairReuseSuccess'] = { numerator: 1, denominator: 1 }
      counts['crossSessionLeakage'] = { numerator: options.crossSessionLeakage ?? 0, denominator: 1 }
    }
    const evidenceHash = putRaw(`${role} evaluator evidence`)
    const outputHash = putRaw(`${role} final answer`)
    const eventSequence = role === 'baseline' ? 4 : 7
    const callId = `call-${role}-1`
    const renderedValue = role === 'candidate'
      ? [{ type: 'text', text: options.injectedContent ?? '# concepts/repair.md\n\nFrozen repaired rule.\n' }]
      : null
    const useSessionId = role === 'candidate'
      ? (options.reuseSessionIds ? 'candidate-session-1' : `candidate-session-${index + 1}`)
      : (options.reuseSessionIds ? 'baseline-session-1' : `baseline-session-${index + 1}`)
    const event: Record<string, unknown> = role === 'candidate'
      ? { seq: eventSequence, type: 'knowledge/injected', data: {
        kind: 'page', knowledgeId: 'candidate:repair-1', callId,
        scope: { sessionId: useSessionId, projectId: '/isolated/pilot-project', workspaceId: '/isolated/pilot-project' },
        verificationStatus: 'verified', truncated: false, sourceContentHash: targetAfterHash,
        contentHash: sha256(JSON.stringify(renderedValue)), resultHash: sha256(JSON.stringify(renderedValue)),
        value: renderedValue, contentBytes: Buffer.byteLength(JSON.stringify(renderedValue)),
      } }
      : { seq: eventSequence, type: 'assistant/message', data: { text: `${role} answer` } }
    if (role === 'candidate') options.mutateInjectedEvent?.(event)
    const eventHash = putRaw(canonicalJson(event))
    const renderedToolResultHash = renderedValue === null ? null : putRaw(JSON.stringify(renderedValue))
    const providerRequestHash = sha256(`${role} provider request`)
    if (options.includeProviderRequest !== false || role !== 'candidate') putRaw(`${role} provider request`)
    const useValue = amend(role, {
      schemaVersion: 1,
      useId: options.duplicateUseIds === 'between-arms'
        ? 'shared-use-id'
        : options.duplicateUseIds === 'candidate-across-pairs' && role === 'candidate'
          ? 'candidate-use-1'
          : `use-${role}-${pairId}`,
      grantIdOrNull: role === 'candidate' ? grant.grantId : null,
      proposalHash,
      knowledgeId: role === 'candidate' ? 'candidate:repair-1' : null,
      contentHash: role === 'candidate' ? targetAfterHash : null,
      role,
      pairIdOrNull: pairId,
      sourceProfileBuildModelConfigTaskGoalPolicyIdentity: {
        profileIdentity: role === 'candidate' ? 'jiuzhang-candidate' : 'jiuzhang-baseline',
        buildIdentity: role === 'candidate' ? 'build-326' : 'build-325',
        ...modelIdentity,
      },
      sessionId: useSessionId,
      callId,
      observedAt: role === 'candidate' ? '2026-10-11T10:01:00.000Z' : '2026-10-11T10:00:30.000Z',
      sessionEventSequenceAndHash: { sequence: eventSequence, hash: eventHash },
      renderedToolResultHash,
      providerRequestHash,
      finalOutputArtifactManifest: [outputHash],
      oracleIdentityAndResults: {
        producerId: `ark-${role}`,
        evaluatorId: authorityId,
        verificationStatus: 'verified',
        counts,
        evidenceRefs: [evidenceHash],
      },
      errorsRetriesToolCallsAndCost: { turnCount: 1, errors: 0, retries: 0, toolCalls: role === 'candidate' ? 1 : 0, costMicrounits: 100 },
      measurementDefinitionHash,
      evidenceArtifactReferences: [evidenceHash],
    })
    if (options.includeJournal !== false) {
      const journalArtifactHash = putRaw(options.journalBytes ?? JSON.stringify({
        schemaVersion: 1,
        sessionId: useValue.sessionId,
        events: [JSON.parse(files.get(eventHash)!.toString('utf8')) as unknown],
      }))
      const facts = Object.fromEntries(Object.entries(useValue).filter(([field]) =>
        !['oracleIdentityAndResults', 'evidenceArtifactReferences'].includes(field)))
      const unsigned = amend('journal', {
        schemaVersion: 1,
        kind: 'knowledge-use-journal-v1',
        useFactsHash: sha256(canonicalJson(facts)),
        journalArtifactHash,
        journalSignerAuthorityId: 'ark-promotion-wal-v1',
      })
      const journalSignerSignature = sign(null, Buffer.from(canonicalJson(unsigned), 'utf8'),
        options.journalSignedByEvaluator === true ? evaluator.privateKey : journalSigner.privateKey).toString('base64')
      const attestation = { ...unsigned, journalSignerSignature }
      options.mutateJournalAfterSigning?.(attestation)
      const journalHash = putCanonical(attestation)
      if (Array.isArray(useValue.evidenceArtifactReferences)) {
        useValue.evidenceArtifactReferences = [journalHash, ...useValue.evidenceArtifactReferences]
      }
      const oracle = useValue.oracleIdentityAndResults
      if (typeof oracle === 'object' && oracle !== null && !Array.isArray(oracle) && Array.isArray(oracle.evidenceRefs)) {
        oracle.evidenceRefs = [journalHash, ...oracle.evidenceRefs]
      }
    }
    options.mutateAfterJournal?.(role, useValue)
    const useReceipt = signRecord(useValue)
    useRecords.push({ role, counts: counts as OpportunityCounts, receiptHash: putCanonical(useReceipt) })
  }
  const baselineCounts = sumCounts(useRecords, 'baseline')
  const candidateCounts = sumCounts(useRecords, 'candidate')
  const safetyObservations = Object.fromEntries(
    ['staleRecallRate', 'crossSessionLeakage', 'falseCompletionRate', 'memoryPrivilegeEscalation', 'memoryPoisoning']
      .map(metric => [metric, candidateCounts[metric as keyof OpportunityCounts]]),
  )
  const trialReceipt = signRecord(amend('trial', {
    schemaVersion: 1,
    trialId: 'trial-1',
    proposalHash,
    grantHash,
    grantId: grant.grantId,
    measurementDefinitionHash,
    orderedUseReceiptHashes: useRecords.map(record => record.receiptHash),
    baselineOpportunityNumeratorsAndDenominators: baselineCounts,
    candidateOpportunityNumeratorsAndDenominators: candidateCounts,
    safetyObservations,
    issuedAt: '2026-10-11T10:02:00.000Z',
  }))
  const trialHash = putCanonical(trialReceipt)
  const reader = createKnowledgeWikiMeasuredTrialReader({
    authorityId,
    publicKey: evaluator.publicKey,
    journalSignerAuthorityId: 'ark-promotion-wal-v1',
    journalSignerPublicKey: options.journalPublicKey ?? journalSigner.publicKey,
    artifacts: { resolveArtifact: hash => options.resolveArtifact === undefined
      ? files.get(hash)
      : options.resolveArtifact(hash, files.get(hash)) },
  })
  const binding = {
    reviewHash: proposal.reviewHash,
    semanticReceiptHash: proposal.semanticReceiptHash,
    candidatePath: proposal.candidatePath,
    candidateHash,
    action: 'Promote' as const,
    targetPath: proposal.targetPath,
    targetBeforeHashOrVerifiedAbsence: proposal.targetBeforeHashOrVerifiedAbsence,
  }
  return { reader, trialHash, binding, targetAfterBytes, files, trialReceipt, putCanonical, candidateHash }
}

const invalidSignedRecords: Array<[string, FixtureStage, Record<string, unknown>]> = [
  ['proposal version', 'proposal', { schemaVersion: 2 }],
  ['absolute candidate path', 'proposal', { candidatePath: '/outside/repair.md' }],
  ['parent traversal', 'proposal', { targetPath: '../repair.md' }],
  ['Windows separator', 'proposal', { targetPath: 'concepts\\repair.md' }],
  ['empty path segment', 'proposal', { targetPath: 'concepts//repair.md' }],
  ['noncanonical action', 'proposal', { action: 'Archive' }],
  ['invalid content hash', 'proposal', { candidateHash: 'G'.repeat(64) }],
  ['blank approval actor', 'proposal', { frozenApprovalActor: ' ' }],
  ['control character', 'proposal', { transformVersion: 'version\u0000' }],
  ['unbounded transform', 'proposal', { transformVersion: 'x'.repeat(161) }],
  ['noncanonical approval time', 'proposal', { frozenApprovalTime: '2026-10-11' }],
  ['invalid approval time', 'proposal', { frozenApprovalTime: 'not-a-date' }],
  ['non-object source identity', 'proposal', { sourceIdentity: [] }],
  ['grant version', 'grant', { schemaVersion: 2 }],
  ['invalid grant id', 'grant', { grantId: 'grant with spaces' }],
  ['grant proposal binding', 'grant', { proposalHash: sha256('other-proposal') }],
  ['reviewed decision binding', 'grant', { reviewedDecisionHash: sha256('other-decision') }],
  ['grant measurement binding', 'grant', { measurementDefinitionHash: sha256('other-measurement') }],
  ['non-array authorized sessions', 'grant', { allowedSessionIds: null }],
  ['empty authorized sessions', 'grant', { allowedSessionIds: [] }],
  ['duplicate authorized sessions', 'grant', { allowedSessionIds: ['candidate-session-1', 'candidate-session-1'] }],
  ['unsorted authorized sessions', 'grant', { allowedSessionIds: ['z', 'candidate-session-1'] }],
  ['fractional observation budget', 'grant', { maxObservations: 1.5 }],
  ['zero observation budget', 'grant', { maxObservations: 0 }],
  ['non-integer turn budget', 'grant', { maxTurns: '1' }],
  ['zero turn budget', 'grant', { maxTurns: 0 }],
  ['deadline before issue', 'grant', { deadline: '2026-10-11T09:59:00.000Z' }],
  ['deadline after expiry', 'grant', { expiresAt: '2026-10-11T10:09:00.000Z' }],
  ['preregistration version', 'preregistration', { schemaVersion: 2 }],
  ['invalid preregistration id', 'preregistration', { preRegistrationId: 'registration with spaces' }],
  ['preregistration proposal binding', 'preregistration', { proposalHash: sha256('other-proposal') }],
  ['preregistration measurement binding', 'preregistration', { measurementDefinitionHash: sha256('other-measurement') }],
  ['non-array registered pairs', 'preregistration', { orderedPairIds: null }],
  ['empty registered pairs', 'preregistration', { orderedPairIds: [] }],
  ['invalid registered pair id', 'preregistration', { orderedPairIds: ['pair with spaces'] }],
  ['duplicate registered pair ids', 'preregistration', { orderedPairIds: ['pair-1', 'pair-1'] }],
  ['registration after authorization', 'preregistration', { issuedAt: '2026-10-11T10:00:02.000Z' }],
  ['use version', 'candidate', { schemaVersion: 2 }],
  ['invalid use id', 'candidate', { useId: 'use with spaces' }],
  ['use proposal binding', 'candidate', { proposalHash: sha256('other-proposal') }],
  ['use measurement binding', 'candidate', { measurementDefinitionHash: sha256('other-measurement') }],
  ['invalid use role', 'candidate', { role: 'other' }],
  ['non-string call identity', 'candidate', { callId: null }],
  ['blank call identity', 'candidate', { callId: '' }],
  ['non-array output manifest', 'candidate', { finalOutputArtifactManifest: null }],
  ['empty output manifest', 'candidate', { finalOutputArtifactManifest: [] }],
  ['duplicate final artifacts', 'candidate', { finalOutputArtifactManifest: [sha256('candidate final answer'), sha256('candidate final answer')] }],
  ['non-array evidence manifest', 'candidate', { evidenceArtifactReferences: null }],
  ['empty evidence manifest', 'candidate', { evidenceArtifactReferences: [] }],
  ['duplicate evidence artifacts', 'candidate', { evidenceArtifactReferences: [sha256('candidate evaluator evidence'), sha256('candidate evaluator evidence')] }],
  ['oracle evidence disagreement', 'candidate', { evidenceArtifactReferences: [sha256('baseline evaluator evidence')] }],
  ['baseline grant exposure', 'baseline', { grantIdOrNull: 'grant-1' }],
  ['baseline knowledge exposure', 'baseline', { knowledgeId: 'candidate:repair-1' }],
  ['baseline content exposure', 'baseline', { contentHash: sha256('candidate knowledge bytes\n') }],
  ['baseline injected exposure', 'baseline', { renderedToolResultHash: sha256('baseline evaluator evidence') }],
  ['candidate grant absence', 'candidate', { grantIdOrNull: null }],
  ['unauthorized candidate session', 'candidate', { sessionId: 'other-session' }],
  ['candidate knowledge absence', 'candidate', { knowledgeId: null }],
  ['candidate content absence', 'candidate', { contentHash: null }],
  ['candidate injection absence', 'candidate', { renderedToolResultHash: null }],
  ['use before authorized window', 'candidate', { observedAt: '2026-10-11T10:00:00.000Z' }],
  ['use after authorized window', 'candidate', { observedAt: '2026-10-11T10:11:00.000Z' }],
  ['baseline before preregistration', 'baseline', { observedAt: '2026-10-11T09:58:00.000Z' }],
  ['trial version', 'trial', { schemaVersion: 2 }],
  ['invalid trial id', 'trial', { trialId: 'trial with spaces' }],
  ['trial grant binding', 'trial', { grantId: 'other-grant' }],
  ['non-array trial index', 'trial', { orderedUseReceiptHashes: null }],
  ['incomplete paired trial index', 'trial', { orderedUseReceiptHashes: [] }],
  ['trial issued before observations', 'trial', { issuedAt: '2026-10-11T10:00:02.000Z' }],
  ['trial issued after deadline', 'trial', { issuedAt: '2026-10-11T10:11:00.000Z' }],
]

describe('measured-use journal authentication', () => {
  it('accepts factual bindings authenticated independently from the evaluator', () => {
    const test = fixture()
    expect(test.reader.read(test.trialHash, test.binding)?.eligibleForReview).toBe(true)
  })

  it('refuses an unrelated journal key while evaluator signatures still authenticate', () => {
    const test = fixture({ journalPublicKey: generateKeyPairSync('ed25519').publicKey })
    expect(test.reader.read(test.trialHash, test.binding)).toBeUndefined()
  })

  it('requires a journal attestation for every paired use', () => {
    const test = fixture({ includeJournal: false })
    expect(test.reader.read(test.trialHash, test.binding)).toBeUndefined()
  })

  it('refuses an evaluator signing as the distinct journal owner', () => {
    const test = fixture({ journalSignedByEvaluator: true })
    expect(test.reader.read(test.trialHash, test.binding)).toBeUndefined()
  })

  it.each(['useId', 'callId'] as const)('refuses re-signed evaluator %s facts that differ from the journal', (field) => {
    const test = fixture({ mutateAfterJournal(role, record) {
      if (role === 'candidate') record[field] = 'different-authenticated-looking-id'
    } })
    expect(test.reader.read(test.trialHash, test.binding)).toBeUndefined()
  })

  it.each([
    ['version', { schemaVersion: 2 }],
    ['kind', { kind: 'different-journal' }],
    ['malformed facts hash', { useFactsHash: 'G'.repeat(64) }],
    ['different facts hash', { useFactsHash: sha256('different facts') }],
    ['missing journal bytes', { journalArtifactHash: sha256('unavailable journal') }],
    ['malformed journal hash', { journalArtifactHash: 'bad' }],
    ['different authority', { journalSignerAuthorityId: 'different-journal-owner' }],
    ['extra field', { unexpected: true }],
  ] as Array<[string, Record<string, unknown>]>)('refuses signed journal %s', (_name, patch) => {
    const test = fixture({ mutate(stage, record) {
      if (stage === 'journal') Object.assign(record, patch)
    } })
    expect(test.reader.read(test.trialHash, test.binding)).toBeUndefined()
  })

  it.each(['not-base64', Buffer.alloc(64).toString('base64'), `${Buffer.alloc(64).toString('base64')}!`])(
    'refuses damaged journal signature %s', (signature) => {
      const test = fixture({ mutateJournalAfterSigning(record) {
        record['journalSignerSignature'] = signature
      } })
      expect(test.reader.read(test.trialHash, test.binding)).toBeUndefined()
    },
  )

  it('refuses a journal without its signature', () => {
    const test = fixture({ mutateJournalAfterSigning(record) {
      delete record['journalSignerSignature']
    } })
    expect(test.reader.read(test.trialHash, test.binding)).toBeUndefined()
  })

  it('refuses empty journal bytes despite a matching hash and valid signatures', () => {
    const test = fixture({ journalBytes: '' })
    expect(test.reader.read(test.trialHash, test.binding)).toBeUndefined()
  })

  it('refuses changed actual journal bytes under the signed content address', () => {
    const test = fixture({ resolveArtifact(_hash, bytes) {
      return bytes?.includes('"events":') ? Buffer.from('changed actual journal') : bytes
    } })
    expect(test.reader.read(test.trialHash, test.binding)).toBeUndefined()
  })

  it.each(['profileIdentity', 'buildIdentity'] as const)('refuses re-signed evaluator %s identity', (field) => {
    const test = fixture({ mutateAfterJournal(role, record) {
      if (role !== 'candidate') return
      const identity = record['sourceProfileBuildModelConfigTaskGoalPolicyIdentity'] as Record<string, unknown>
      identity[field] = 'different-but-well-formed-identity'
    } })
    expect(test.reader.read(test.trialHash, test.binding)).toBeUndefined()
  })

  it('refuses a re-signed evaluator cost report that differs from the journal', () => {
    const test = fixture({ mutateAfterJournal(role, record) {
      if (role !== 'candidate') return
      const costs = record['errorsRetriesToolCallsAndCost'] as Record<string, unknown>
      costs['errors'] = 1
    } })
    expect(test.reader.read(test.trialHash, test.binding)).toBeUndefined()
  })
})

function section(record: Record<string, unknown>, key: string): Record<string, unknown> {
  return record[key] as Record<string, unknown>
}

describe('Knowledge Wiki measured trial receipt validation', () => {
  it.each(invalidSignedRecords)('rejects independently signed invalid %s', (_name, stage, changes) => {
    const test = fixture({ mutate(current, record) {
      if (current === stage) Object.assign(record, changes)
    } })
    expect(test.reader.read(test.trialHash, test.binding)).toBeUndefined()
  })

  it.each(['model', 'modelConfigHash', 'taskHash', 'goalHash', 'policyHash'])(
    'rejects paired arms with different %s', (key) => {
      const test = fixture({ mutate(stage, record) {
        if (stage === 'candidate') section(record, 'sourceProfileBuildModelConfigTaskGoalPolicyIdentity')[key]
          = key === 'model' ? 'other-model' : sha256('other-identity')
      } })
      expect(test.reader.read(test.trialHash, test.binding)).toBeUndefined()
    },
  )

  it.each(['model', 'modelConfigHash', 'taskHash', 'goalHash', 'policyHash'])(
    'rejects authorization for a different preregistered %s', (key) => {
      const test = fixture({ mutate(stage, record) {
        if (stage === 'grant') section(record, 'modelConfigTaskGoalPolicyIdentity')[key]
          = key === 'model' ? 'other-model' : sha256('other-identity')
      } })
      expect(test.reader.read(test.trialHash, test.binding)).toBeUndefined()
    },
  )

  it.each(['model', 'modelConfigHash', 'taskHash', 'goalHash', 'policyHash'])(
    'rejects both arms when the registered %s differs', (key) => {
      const test = fixture({ mutate(stage, record) {
        if (stage === 'baseline' || stage === 'candidate') {
          section(record, 'sourceProfileBuildModelConfigTaskGoalPolicyIdentity')[key]
            = key === 'model' ? 'other-model' : sha256('other-identity')
        }
      } })
      expect(test.reader.read(test.trialHash, test.binding)).toBeUndefined()
    },
  )

  it.each([
    ['producerId', authorityId], ['evaluatorId', 'other-evaluator'], ['verificationStatus', 'passed'],
    ['counts', null], ['evidenceRefs', null], ['evidenceRefs', []],
  ])('rejects an invalid oracle %s', (key, value) => {
    const test = fixture({ mutate(stage, record) {
      if (stage === 'candidate') section(record, 'oracleIdentityAndResults')[key] = value
    } })
    expect(test.reader.read(test.trialHash, test.binding)).toBeUndefined()
  })

  it.each([
    { numerator: '0', denominator: 1 }, { numerator: 0, denominator: '1' },
    { numerator: 0.5, denominator: 1 }, { numerator: 0, denominator: 1.5 },
    { numerator: -1, denominator: 1 }, { numerator: 2, denominator: 1 },
  ])('rejects unsafe opportunity counts %j', (value) => {
    const test = fixture({ mutate(stage, record) {
      if (stage === 'candidate') section(section(record, 'oracleIdentityAndResults'), 'counts')['knowledgeUtility'] = value
    } })
    expect(test.reader.read(test.trialHash, test.binding)).toBeUndefined()
  })

  it.each(['turnCount', 'errors', 'retries', 'toolCalls', 'costMicrounits'])(
    'rejects negative observed %s', (key) => {
      const test = fixture({ mutate(stage, record) {
        if (stage === 'candidate') section(record, 'errorsRetriesToolCallsAndCost')[key] = -1
      } })
      expect(test.reader.read(test.trialHash, test.binding)).toBeUndefined()
    },
  )

  it('rejects a candidate that exceeds its authorized turn budget', () => {
    const test = fixture({ mutate(stage, record) {
      if (stage === 'candidate') section(record, 'errorsRetriesToolCallsAndCost')['turnCount'] = 2
    } })
    expect(test.reader.read(test.trialHash, test.binding)).toBeUndefined()
  })

  it.each([-1, 0.5, '7', 6])('rejects invalid or mismatched event sequence %j', (value) => {
    const test = fixture({ mutate(stage, record) {
      if (stage === 'candidate') section(record, 'sessionEventSequenceAndHash')['sequence'] = value
    } })
    expect(test.reader.read(test.trialHash, test.binding)).toBeUndefined()
  })

  it.each(['baselineOpportunityNumeratorsAndDenominators', 'candidateOpportunityNumeratorsAndDenominators'])(
    'rejects a trial with inflated %s', (key) => {
      const test = fixture({ mutate(stage, record) {
        if (stage === 'trial') section(record, key)['knowledgeUtility'] = { numerator: 2, denominator: 2 }
      } })
      expect(test.reader.read(test.trialHash, test.binding)).toBeUndefined()
    },
  )

  it.each(['unexpected', 'missing'])('rejects %s fields instead of tolerating a changed receipt format', (kind) => {
    const test = fixture({ mutate(stage, record) {
      if (stage !== 'trial') return
      if (kind === 'unexpected') record['unexpectedField'] = true
      else delete record['trialId']
    } })
    expect(test.reader.read(test.trialHash, test.binding)).toBeUndefined()
  })

  it.each(['duplicate', 'reversed', 'unregistered'])('rejects a %s paired-use index', (kind) => {
    const test = fixture({ mutate(stage, record) {
      if (stage === 'trial') {
        const hashes = record['orderedUseReceiptHashes'] as string[]
        if (kind === 'duplicate') hashes[1] = hashes[0]!
        if (kind === 'reversed') hashes.reverse()
      }
      if (kind === 'unregistered' && stage === 'candidate') record['pairIdOrNull'] = 'pair-2'
    } })
    expect(test.reader.read(test.trialHash, test.binding)).toBeUndefined()
  })

  it.each(['unknown', 'rejected'])('keeps a %s oracle outcome ineligible despite an apparent lift', (status) => {
    const test = fixture({ mutate(stage, record) {
      if (stage === 'candidate') section(record, 'oracleIdentityAndResults')['verificationStatus'] = status
    } })
    expect(test.reader.read(test.trialHash, test.binding)?.eligibleForReview).toBe(false)
  })

  it.each(['evaluatorAuthorityId', 'evaluatorSignature'])('rejects an untrusted or corrupted %s', (key) => {
    const test = fixture()
    for (const value of key === 'evaluatorSignature'
      ? ['not-a-signature', Buffer.alloc(64).toString('base64'), `${Buffer.alloc(64).toString('base64')}!`]
      : ['other-evaluator']) {
      const alteredHash = test.putCanonical({ ...test.trialReceipt, [key]: value })
      expect(test.reader.read(alteredHash, test.binding)).toBeUndefined()
    }
  })

  it.each(['canonical', 'raw', 'non-object'])('rejects changed %s artifact bytes', (kind) => {
    const test = fixture()
    const hash = kind === 'raw' ? test.candidateHash : test.trialHash
    test.files.set(hash, Buffer.from(kind === 'non-object' ? 'null' : '{}'))
    expect(test.reader.read(test.trialHash, test.binding)).toBeUndefined()
  })

  it('binds an existing target hash when reviewing a replacement', () => {
    const beforeHash = sha256('existing canonical bytes')
    const test = fixture({ mutate(stage, record) {
      if (stage === 'proposal') {
        record['action'] = 'Replace'
        record['targetBeforeHashOrVerifiedAbsence'] = beforeHash
      }
    } })
    expect(test.reader.read(test.trialHash, {
      ...test.binding,
      action: 'Replace',
      targetBeforeHashOrVerifiedAbsence: beforeHash,
    })).toMatchObject({ eligibleForReview: true, targetBeforeHashOrVerifiedAbsence: beforeHash })
  })

  it('records no utility when an arm has no measured utility opportunities', () => {
    const empty = { numerator: 0, denominator: 0 }
    const test = fixture({ mutate(stage, record) {
      if (stage === 'baseline') section(section(record, 'oracleIdentityAndResults'), 'counts')['knowledgeUtility'] = empty
      if (stage === 'trial') section(record, 'baselineOpportunityNumeratorsAndDenominators')['knowledgeUtility'] = empty
    } })
    expect(test.reader.read(test.trialHash, test.binding)).toMatchObject({ eligibleForReview: false, utilityScore: 0 })
  })

  it('retains the actual start time of a baseline before candidate authorization', () => {
    const observedAt = '2026-10-11T10:00:00.000Z'
    const test = fixture({ mutate(stage, record) {
      if (stage === 'baseline') record['observedAt'] = observedAt
    } })
    expect(test.reader.read(test.trialHash, test.binding)?.startedAt).toBe(observedAt)
  })

  it('does not conflate absent artifacts with permission or resolver failures', () => {
    const test = fixture({ resolveArtifact() { throw new Error('artifact permission denied') } })
    expect(test.reader.read(test.trialHash, test.binding)).toBeUndefined()
  })

  it('authenticates two preregistered pairs using exported public keys', () => {
    const test = fixture({ pairs: 2 })
    const reader = createKnowledgeWikiMeasuredTrialReader({
      authorityId,
      publicKey: Buffer.from(evaluator.publicKey.export({ type: 'spki', format: 'pem' })),
      journalSignerAuthorityId: 'ark-promotion-wal-v1',
      journalSignerPublicKey: journalSigner.publicKey.export({ type: 'spki', format: 'pem' }),
      artifacts: { resolveArtifact: hash => test.files.get(hash) },
    })
    expect(reader.read(test.trialHash, test.binding)).toMatchObject({
      eligibleForReview: true, retrievalHits: 4, successfulUses: 2, utilityScore: 0.5,
    })
  })

  it('accepts a selected verified injection whose rendered JSON bytes differ from the frozen source page bytes', () => {
    const test = fixture()
    expect(test.reader.read(test.trialHash, test.binding)?.eligibleForReview).toBe(true)
  })

  it.each([
    ['event type', (event: Record<string, unknown>) => { event['type'] = 'assistant/message' }],
    ['knowledge kind', (event: Record<string, unknown>) => { section(event, 'data')['kind'] = 'files' }],
    ['verification status', (event: Record<string, unknown>) => { section(event, 'data')['verificationStatus'] = 'unknown' }],
    ['truncation', (event: Record<string, unknown>) => { section(event, 'data')['truncated'] = true }],
    ['malformed truncation flag', (event: Record<string, unknown>) => { section(event, 'data')['truncated'] = 'false' }],
    ['knowledge identity', (event: Record<string, unknown>) => { section(event, 'data')['knowledgeId'] = 'other:page' }],
    ['call identity', (event: Record<string, unknown>) => { section(event, 'data')['callId'] = 'other-call' }],
    ['session scope', (event: Record<string, unknown>) => { section(section(event, 'data'), 'scope')['sessionId'] = 'other-session' }],
    ['source page hash', (event: Record<string, unknown>) => { section(event, 'data')['sourceContentHash'] = sha256('other source') }],
    ['content hash', (event: Record<string, unknown>) => { section(event, 'data')['contentHash'] = sha256('other render') }],
    ['result hash', (event: Record<string, unknown>) => { section(event, 'data')['resultHash'] = sha256('other render') }],
    ['rendered byte count', (event: Record<string, unknown>) => { section(event, 'data')['contentBytes'] = 1 }],
    ['rendered block shape', (event: Record<string, unknown>) => { section(event, 'data')['value'] = null }],
    ['rendered content', (event: Record<string, unknown>) => {
      const data = section(event, 'data')
      data['value'] = [{ type: 'text', text: 'Changed rendering without matching rendered artifact.' }]
    }],
  ])('rejects a selected injection with mismatched %s', (_label, mutate) => {
    const test = fixture({ mutateInjectedEvent: mutate })
    expect(test.reader.read(test.trialHash, test.binding)).toBeUndefined()
  })

  it('rejects a session reused across separately preregistered pairs', () => {
    const test = fixture({ pairs: 2, reuseSessionIds: true })
    expect(test.reader.read(test.trialHash, test.binding)).toBeUndefined()
  })

  it('rejects repeated use IDs across candidate sessions with distinct preregistered pairs', () => {
    const test = fixture({ pairs: 2, duplicateUseIds: 'candidate-across-pairs' })
    expect(test.reader.read(test.trialHash, test.binding)).toBeUndefined()
  })

  it('rejects a baseline and candidate that share a use ID despite fresh sessions', () => {
    const test = fixture({ duplicateUseIds: 'between-arms' })
    expect(test.reader.read(test.trialHash, test.binding)).toBeUndefined()
  })

  it('rejects aggregate counts that exceed safe integers despite each signed use being in range', () => {
    const test = fixture({ pairs: 2, mutate(stage, record) {
      if (stage === 'baseline') section(section(record, 'oracleIdentityAndResults'), 'counts')['knowledgeUtility']
        = { numerator: 0, denominator: Number.MAX_SAFE_INTEGER }
    } })
    expect(test.reader.read(test.trialHash, test.binding)).toBeUndefined()
  })

  it('rejects two observations under a one-observation grant', () => {
    const test = fixture({ pairs: 2, mutate(stage, record) {
      if (stage === 'grant') record['maxObservations'] = 1
    } })
    expect(test.reader.read(test.trialHash, test.binding)).toBeUndefined()
  })

  it.each([
    ['invalid evaluator id', { authorityId: 'not an id' }],
    ['blank evaluator id', { authorityId: '' }],
    ['invalid journal id', { journalSignerAuthorityId: 'not an id' }],
    ['shared authority id', { journalSignerAuthorityId: authorityId }],
    ['evaluator private key', { publicKey: evaluator.privateKey }],
    ['journal private key', { journalSignerPublicKey: journalSigner.privateKey }],
    ['non-Ed25519 evaluator', { publicKey: generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey }],
  ])('rejects a misconfigured trust anchor: %s', (_label, changes) => {
    expect(() => createKnowledgeWikiMeasuredTrialReader({
      authorityId,
      publicKey: evaluator.publicKey,
      journalSignerAuthorityId: 'ark-promotion-wal-v1',
      journalSignerPublicKey: journalSigner.publicKey,
      artifacts: { resolveArtifact: () => undefined },
      ...changes,
    })).toThrow()
  })
  it('refuses changed grant bytes under the original trial hash and accepts the restored artifact', () => {
    const item = fixture()
    expect(item.reader.read(item.trialHash, item.binding)?.eligibleForReview).toBe(true)
    const grantHash = item.trialReceipt.grantHash
    const original = item.files.get(grantHash)
    if (original === undefined) throw new Error('missing signed grant fixture')
    const grant = JSON.parse(original.toString('utf8')) as Record<string, unknown>
    item.files.set(grantHash, Buffer.from(canonicalJson({ ...grant, grantId: 'different-frozen-grant' })))
    expect(item.reader.read(item.trialHash, item.binding)).toBeUndefined()
    item.files.set(grantHash, original)
    expect(item.reader.read(item.trialHash, item.binding)?.eligibleForReview).toBe(true)
  })

  it('authenticates a complete paired trial and derives utility from opportunities', () => {
    const test = fixture()
    const measured = test.reader.read(test.trialHash, test.binding)
    expect(measured).toMatchObject({
      authorityId,
      eligibleForReview: true,
      retrievalHits: 2,
      successfulUses: 1,
      utilityScore: 0.5,
      targetAfterBytes: Buffer.from(test.targetAfterBytes),
    })
  })

  it('keeps a cryptographically valid trial ineligible when utility did not improve', () => {
    const test = fixture({ candidateUtility: 0 })
    expect(test.reader.read(test.trialHash, test.binding)?.eligibleForReview).toBe(false)
  })

  it('rejects missing paired opportunities and mismatched frozen review state', () => {
    const test = fixture()
    expect(test.reader.read(test.trialHash, { ...test.binding, targetPath: 'concepts/other.md' })).toBeUndefined()
    expect(test.reader.read(sha256('missing-trial'), test.binding)).toBeUndefined()
  })

  it('rejects a paired trial that records a non-zero isolation safety event', () => {
    const test = fixture({ crossSessionLeakage: 1 })
    expect(test.reader.read(test.trialHash, test.binding)).toBeUndefined()
  })

  it('rejects a receipt whose provider request artifact is missing', () => {
    const test = fixture({ includeProviderRequest: false })
    expect(test.reader.read(test.trialHash, test.binding)).toBeUndefined()
  })

  it('rejects evaluator and local promotion-WAL keys that are the same', () => {
    expect(() => createKnowledgeWikiMeasuredTrialReader({
      authorityId,
      publicKey: evaluator.publicKey,
      journalSignerAuthorityId: 'ark-promotion-wal-v1',
      journalSignerPublicKey: evaluator.publicKey,
      artifacts: { resolveArtifact: () => undefined },
    })).toThrow(/distinct keys/u)
  })
})
