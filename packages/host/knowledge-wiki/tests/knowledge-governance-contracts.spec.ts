import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  appendKnowledgeEvent,
  applyKnowledgeEvent,
  canonicalKnowledgeJson,
  canKnowledgeChangePolicy,
  createKnowledgeEvent,
  createKnowledgeRecord,
  detectKnowledgeConflicts,
  expireKnowledge,
  knowledgeInjectionDecision,
  readKnowledgeEventLog,
  shouldRetainKnowledge,
  updateKnowledgeUtility,
  validateKnowledgeEvent,
  validateKnowledgeRecord,
  type KnowledgeState,
} from '../src/knowledge-governance.ts'
import type { KnowledgeEvent, KnowledgeEventType, KnowledgeRecord } from '../src/types.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(overrides: Partial<Parameters<typeof createKnowledgeRecord>[0]> = {}): KnowledgeRecord {
  return createKnowledgeRecord({
    id: 'claim:alpha',
    content: 'A verified statement with a source and a bounded applicability.',
    source: 'source.md',
    scope: { projectId: 'project-a', workspaceId: 'workspace-a', sessionId: 'session-a', visibility: 'workspace' },
    trust: 'high',
    authority: 'independent-verifier',
    evidenceRefs: ['receipt:1'],
    verificationStatus: 'verified',
    confidence: 0.9,
    createdAt: '2026-09-01T00:00:00.000Z',
    lastVerifiedAt: '2026-10-01T00:00:00.000Z',
    expiresAt: '2026-11-01T00:00:00.000Z',
    ...overrides,
  })
}

function state(): KnowledgeState {
  return { records: new Map(), lastSeq: -1, lastEventHash: null }
}

function event(
  type: KnowledgeEventType,
  record: KnowledgeRecord,
  current: KnowledgeState,
  payload: Readonly<Record<string, unknown>> = {},
): KnowledgeEvent {
  // Match the production writer: admission is unverified; verification is a
  // separate, authority-bearing event rather than a self-declared label.
  if ((type === 'knowledge/observed' || type === 'knowledge/candidate') && payload.record !== undefined) {
    payload = { ...payload, record: { ...(payload.record as KnowledgeRecord), verificationStatus: 'candidate', lifecycle: 'candidate' } }
  }
  return createKnowledgeEvent(type, record.id, record.scope, payload, {
    seq: current.lastSeq + 1,
    previousEventHash: current.lastEventHash,
    timestamp: '2026-10-11T00:00:00.000Z',
  })
}

function verifiedState(record: KnowledgeRecord): KnowledgeState {
  const admitted = applyKnowledgeEvent(state(), event('knowledge/candidate', record, state(), { record }))
  return applyKnowledgeEvent(admitted, event('knowledge/verified', record, admitted, {
    authority: 'independent-verifier',
    authoritySeal: { authorityId: 'independent-verifier', proof: 'unit-verification-shape' },
    evidenceRefs: ['receipt:verified'], trust: record.trust, confidence: record.confidence,
  }))
}

describe('knowledge governance validation contracts', () => {
  it('enforces explicit session fences and blocks repeatedly useless verified knowledge', () => {
    const item = fixture()
    expect(knowledgeInjectionDecision(item, {
      projectId: 'project-a', workspaceId: 'workspace-a', sessionId: 'other-session',
    })).toMatchObject({ allowed: false, reason: 'scope-denied' })
    expect(knowledgeInjectionDecision(fixture({ retrievalHits: 3, utilityScore: 0 }), {
      projectId: 'project-a', workspaceId: 'workspace-a', sessionId: 'session-a',
    })).toMatchObject({ allowed: false, reason: 'low-confidence' })
  })

  it('keeps omitted ACL dimensions omitted when replaying a governed record', () => {
    for (const acl of [{}, { readers: ['reader'] }, { writers: ['writer'] }]) {
      const item = fixture({ acl })
      const replayed = applyKnowledgeEvent(state(), event('knowledge/observed', item, state(), { record: item }))
      expect(replayed.records.get(item.id)?.acl).toEqual(acl)
      expect(replayed.records.get(item.id)?.acl).not.toBe(acl)
    }
  })

  it('rejects a non-null predecessor on the first event and malformed predecessor hashes', () => {
    const item = fixture()
    const linkedFirst = createKnowledgeEvent('knowledge/observed', item.id, item.scope, { record: item }, {
      seq: 0, previousEventHash: 'a'.repeat(64),
    })
    expect(() => applyKnowledgeEvent(state(), linkedFirst)).toThrow('chain must start at seq 0')
    const malformed = createKnowledgeEvent('knowledge/observed', item.id, item.scope, { record: item }, {
      seq: 0, previousEventHash: 'not-a-hash',
    })
    expect(validateKnowledgeEvent(malformed)).toBe(false)
  })

  it('validates the post-transition record instead of accepting invalid verifier metadata', () => {
    const item = fixture({ verificationStatus: 'candidate' })
    const current = applyKnowledgeEvent(state(), event('knowledge/candidate', item, state(), { record: item }))
    const payload = {
      authority: 'independent-verifier',
      authoritySeal: { authorityId: 'independent-verifier', proof: 'unit-verification' },
      evidenceRefs: ['receipt:unit'],
    }
    expect(() => applyKnowledgeEvent(current, event('knowledge/verified', item, current, { ...payload, confidence: 2 })))
      .toThrow('transition produced an invalid record')
    const verified = applyKnowledgeEvent(current, event('knowledge/verified', item, current, { ...payload, confidence: 0.95 }))
    expect(verified.records.get(item.id)?.confidence).toBe(0.95)
    expect(() => applyKnowledgeEvent(verified, event('knowledge/promoted', item, verified)))
      .toThrow('promotion lacks authority seal')
  })

  it('expires low-utility knowledge without a deadline through a replayable event', () => {
    const item = fixture({ expiresAt: null, retrievalHits: 3, utilityScore: 0 })
    const current = verifiedState(item)
    const expired = expireKnowledge(current, new Date('2026-10-11T01:00:00.000Z'))
    expect(expired.events).toHaveLength(1)
    expect(expired.events[0]?.payload).toEqual({ reason: 'low-utility', retrievalHits: 3, utilityScore: 0 })
    expect(expired.state.records.get(item.id)?.verificationStatus).toBe('expired')
    expect(applyKnowledgeEvent(current, expired.events[0]!)).toEqual(expired.state)
  })

  it('rejects an append whose sequence does not match the durable log', () => {
    const root = mkdtempSync(join(tmpdir(), 'knowledge-append-boundary-'))
    roots.push(root)
    const path = join(root, 'events.jsonl')
    const item = fixture()
    const first = event('knowledge/observed', item, state(), { record: item })
    appendKnowledgeEvent(path, first)
    const before = readFileSync(path, 'utf8')
    expect(() => { appendKnowledgeEvent(path, first) }).toThrow('event hash/sequence mismatch')
    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  it('canonicalizes object keys while preserving array order and omitting undefined fields', () => {
    expect(canonicalKnowledgeJson({ z: undefined, b: { y: 2, x: 1 }, a: [3, 1] }))
      .toBe('{"a":[3,1],"b":{"x":1,"y":2}}')
  })

  it('uses conservative defaults when an observation first becomes a durable record', () => {
    const item = createKnowledgeRecord({ id: 'observed', content: 'Fact.', source: 'capture.md', scope: {} })
    expect(item).toMatchObject({
      trust: 'low',
      authority: 'untrusted-observation',
      verificationStatus: 'observed',
      confidence: 0,
      lastVerifiedAt: null,
      expiresAt: null,
      retrievalHits: 0,
      successfulUses: 0,
      userCorrections: 0,
      utilityScore: 0,
    })
    expect(item.sourceHash).toMatch(/^[a-f0-9]{64}$/u)
  })

  it('rejects malformed records, scopes, ACLs, and lifecycle counters', () => {
    const good = fixture()
    expect(validateKnowledgeRecord(null)).toMatchObject({ ok: false, errors: ['record must be an object'] })
    expect(validateKnowledgeRecord([])).toMatchObject({ ok: false, errors: ['record must be an object'] })

    const invalid = {
      ...good,
      id: ' ',
      content: '',
      source: '',
      sourceHash: 'not-a-digest',
      scope: { visibility: 'private' },
      trust: 'unbounded',
      authority: '',
      evidenceRefs: ['ok', 7],
      verificationStatus: 'pending',
      confidence: Number.POSITIVE_INFINITY,
      createdAt: 'not-a-date',
      lastVerifiedAt: undefined,
      expiresAt: 'not-a-date',
      conflicts: ['ok', ''],
      retrievalHits: -1,
      successfulUses: 1.5,
      userCorrections: Number.NaN,
      utilityScore: Number.POSITIVE_INFINITY,
      acl: [],
    }
    const result = validateKnowledgeRecord(invalid)
    expect(result.ok).toBe(false)
    expect(result.errors).toEqual(expect.arrayContaining([
      'id is required', 'content is required', 'source is required', 'sourceHash must be sha256',
      'scope is invalid', 'trust is invalid', 'authority is required', 'evidenceRefs are invalid',
      'verificationStatus is invalid', 'confidence must be between 0 and 1', 'createdAt is invalid',
      'lastVerifiedAt is invalid', 'expiresAt is invalid', 'conflicts are invalid',
      'retrievalHits must be a non-negative integer', 'successfulUses must be a non-negative integer',
      'userCorrections must be a non-negative integer', 'utilityScore must be finite', 'acl is invalid',
    ]))
  })

  it('accepts only well-formed visibility fences and reader/writer ACL lists', () => {
    const base = fixture()
    for (const scope of [
      {},
      { visibility: 'project', projectId: 'p' },
      { visibility: 'workspace', workspaceId: 'w' },
      { visibility: 'session', sessionId: 's' },
    ]) expect(validateKnowledgeRecord({ ...base, scope }).ok).toBe(true)

    for (const scope of [
      null,
      [],
      { projectId: 4 },
      { workspaceId: '' },
      { sessionId: ' ' },
      { visibility: 'other' },
      { visibility: 'project' },
      { visibility: 'workspace' },
      { visibility: 'session' },
    ]) expect(validateKnowledgeRecord({ ...base, scope }).errors).toContain('scope is invalid')

    expect(validateKnowledgeRecord({ ...base, acl: undefined }).ok).toBe(true)
    expect(validateKnowledgeRecord({ ...base, acl: { readers: ['a'], writers: ['b'] } }).ok).toBe(true)
    for (const acl of [null, [], 'reader', { readers: 'a' }, { readers: [''] }, { writers: [null] }]) {
      expect(validateKnowledgeRecord({ ...base, acl }).errors).toContain('acl is invalid')
    }
  })

  it('covers record lifecycle date and numeric boundaries', () => {
    const good = fixture()
    expect(validateKnowledgeRecord({ ...good, confidence: 0, expiresAt: null, lastVerifiedAt: null }).ok).toBe(true)
    expect(validateKnowledgeRecord({ ...good, confidence: 1 }).ok).toBe(true)
    expect(validateKnowledgeRecord({ ...good, confidence: -0.01 }).errors).toContain('confidence must be between 0 and 1')
    expect(validateKnowledgeRecord({ ...good, confidence: 1.01 }).errors).toContain('confidence must be between 0 and 1')
    expect(validateKnowledgeRecord({ ...good, expiresAt: good.createdAt }).errors).toContain('expiresAt must be after createdAt')
    expect(validateKnowledgeRecord({ ...good, expiresAt: '2026-08-30T00:00:00.000Z' }).errors)
      .toContain('expiresAt must be after createdAt')
  })

  it('finds only divergent verified or candidate claims in the same scope and claim key', () => {
    const subject = fixture({ claimKey: 'claim:alpha', content: 'Same statement.' })
    const peer = (id: string, overrides: Partial<Parameters<typeof createKnowledgeRecord>[0]> = {}) => fixture({
      id, claimKey: 'claim:alpha', content: `Different statement ${id}.`, ...overrides,
    })
    expect(detectKnowledgeConflicts(subject, [
      subject,
      peer('same-content', { content: '  Same\n statement.  ' }),
      peer('different-project', { scope: { ...subject.scope, projectId: 'project-b' } }),
      peer('different-claim', { claimKey: 'claim:other' }),
      peer('rejected', { verificationStatus: 'rejected' }),
      peer('conflict', { verificationStatus: 'conflict' }),
      peer('verified'),
      peer('candidate', { verificationStatus: 'candidate' }),
    ])).toEqual(['verified', 'candidate'])
  })

  it('denies stale, unverified, out-of-scope, low-confidence, and low-utility injection', () => {
    const context = { projectId: 'project-a', workspaceId: 'workspace-a', sessionId: 'session-a', actor: 'reader' }
    expect(knowledgeInjectionDecision(fixture(), context).reason).toBe('ok')
    expect(knowledgeInjectionDecision(fixture({ verificationStatus: 'expired' }), context).reason).toBe('expired')
    expect(knowledgeInjectionDecision(fixture({ expiresAt: '2026-10-01T00:00:00.000Z' }), context, new Date('2026-10-02T00:00:00.000Z')).reason).toBe('expired')
    expect(knowledgeInjectionDecision(fixture({ verificationStatus: 'observed' }), context).reason).toBe('unverified')
    expect(knowledgeInjectionDecision(fixture({ scope: { visibility: 'session', sessionId: 'other' } }), context).reason).toBe('scope-denied')
    expect(knowledgeInjectionDecision(fixture({ scope: { projectId: 'project-b' } }), context).reason).toBe('scope-denied')
    expect(knowledgeInjectionDecision(fixture({ scope: { workspaceId: 'workspace-b' } }), context).reason).toBe('scope-denied')
    expect(knowledgeInjectionDecision(fixture({ confidence: 0 }), context).reason).toBe('low-confidence')
    expect(knowledgeInjectionDecision(fixture({ retrievalHits: 3, utilityScore: 0 }), context).reason).toBe('low-confidence')
    expect(knowledgeInjectionDecision(fixture({ retrievalHits: 3, utilityScore: 0.01 }), context).reason).toBe('ok')
    expect(knowledgeInjectionDecision(fixture({ acl: { readers: [] } }), context).reason).toBe('ok')
  })

  it('rejects corrupt provenance before a verified label can authorize injection', () => {
    const item = fixture()
    expect(knowledgeInjectionDecision({ ...item, sourceHash: 'corrupt-digest' }, {
      projectId: 'project-a', workspaceId: 'workspace-a', sessionId: 'session-a',
    })).toEqual({ allowed: false, reason: 'invalid' })
    expect(item.sourceHash).toMatch(/^[a-f0-9]{64}$/u)
  })

  it('requires high-trust, verified, unconflicted and unexpired authority for policy changes', () => {
    expect(canKnowledgeChangePolicy(fixture())).toBe(true)
    expect(canKnowledgeChangePolicy(fixture({ authority: 'untrusted-observation' }))).toBe(false)
    expect(canKnowledgeChangePolicy(fixture({ verificationStatus: 'candidate' }))).toBe(false)
    expect(canKnowledgeChangePolicy(fixture({ conflicts: ['claim:beta'] }))).toBe(false)
    expect(canKnowledgeChangePolicy(fixture({ expiresAt: '2026-10-01T00:00:00.000Z' }))).toBe(false)
  })

  it('applies retention thresholds and utility outcomes without mutating the source record', () => {
    const item = fixture({ retrievalHits: 3, utilityScore: 0 })
    expect(shouldRetainKnowledge(item)).toBe(false)
    expect(shouldRetainKnowledge(item, { minRetrievalHits: 4 })).toBe(true)
    expect(shouldRetainKnowledge({ ...item, utilityScore: 0.1 }, { minUtilityScore: 0 })).toBe(true)
    expect(shouldRetainKnowledge({ ...item, verificationStatus: 'expired' })).toBe(false)
    expect(shouldRetainKnowledge({ ...item, verificationStatus: 'rejected' })).toBe(false)
    expect(updateKnowledgeUtility(item, 'successful')).toMatchObject({ successfulUses: 1, utilityScore: 0.6667 })
    expect(updateKnowledgeUtility(item, 'corrected')).toMatchObject({ userCorrections: 1, utilityScore: -1 })
    expect(updateKnowledgeUtility(item, 'neutral')).toMatchObject({ successfulUses: 0, userCorrections: 0, utilityScore: 0 })
    expect(item).toMatchObject({ successfulUses: 0, userCorrections: 0, utilityScore: 0 })
  })
})

describe('knowledge event chain validation and replay contracts', () => {
  it.each(['knowledge/observed', 'knowledge/candidate'] as const)('refuses self-certified admission through %s', (type) => {
    for (const item of [fixture(), fixture({ verificationStatus: 'candidate', lifecycle: 'canonical' })]) {
      const untrusted = createKnowledgeEvent(type, item.id, item.scope, { record: item })
      const current = state()
      expect(() => applyKnowledgeEvent(current, untrusted)).toThrow('untrusted knowledge admission')
      expect(current).toEqual(state())
    }
  })

  it('takes verification provenance from the full record while retaining counters and conflicts', () => {
    const authentic = fixture({ verificationStatus: 'candidate' })
    const unsigned = fixture({
      verificationStatus: 'candidate', content: 'Unsigned replacement.', source: 'other.md',
      scope: { projectId: 'different-project', visibility: 'project' },
      acl: { readers: ['different-reader'] }, claimKey: 'unsigned-claim',
      conflicts: ['claim:existing-conflict'], retrievalHits: 2,
    })
    const current = applyKnowledgeEvent(state(), event('knowledge/candidate', unsigned, state(), { record: unsigned }))
    const verified = applyKnowledgeEvent(current, event('knowledge/verified', authentic, current, {
      record: authentic, authority: 'independent-verifier',
      authoritySeal: { authorityId: 'independent-verifier', proof: 'unit-verification-shape' },
      evidenceRefs: ['receipt:verified'], confidence: 0.9,
    }))
    const changed = verified.records.get(authentic.id)!
    expect(changed).toMatchObject({
      content: authentic.content, source: authentic.source, sourceHash: authentic.sourceHash,
      scope: authentic.scope, lifecycle: 'candidate', verificationStatus: 'verified',
      conflicts: ['claim:existing-conflict'], retrievalHits: 2,
    })
    expect(changed.acl).toBeUndefined()
    expect(changed.claimKey).toBeUndefined()
    expect(current.records.get(unsigned.id)?.source).toBe('other.md')
  })

  it('keeps a record introduced by semantic verification out of canonical reuse', () => {
    const item = fixture({ lifecycle: 'canonical' })
    const current = applyKnowledgeEvent(state(), event('knowledge/verified', item, state(), {
      record: item, authority: 'independent-verifier',
      authoritySeal: { authorityId: 'independent-verifier', proof: 'unit-verification-shape' },
      evidenceRefs: ['receipt:verified'], confidence: 0.9,
    }))
    expect(current.records.get(item.id)).toMatchObject({ verificationStatus: 'verified', lifecycle: 'candidate' })
  })
  it('rejects malformed event identities, hashes, payloads and predecessor links', () => {
    const item = fixture()
    const first = createKnowledgeEvent('knowledge/observed', item.id, item.scope, { record: item }, {
      id: 'event-0', seq: 0, timestamp: '2026-10-11T00:00:00.000Z',
    })
    expect(validateKnowledgeEvent(first)).toBe(true)
    expect(validateKnowledgeEvent(null)).toBe(false)
    expect(validateKnowledgeEvent([])).toBe(false)
    expect(validateKnowledgeEvent({ ...first, schemaVersion: 2 })).toBe(false)
    expect(validateKnowledgeEvent({ ...first, type: 'unknown' })).toBe(false)
    expect(validateKnowledgeEvent({ ...first, id: '' })).toBe(false)
    expect(validateKnowledgeEvent({ ...first, knowledgeId: ' ' })).toBe(false)
    expect(validateKnowledgeEvent({ ...first, seq: -1 })).toBe(false)
    expect(validateKnowledgeEvent({ ...first, timestamp: 'bad-date' })).toBe(false)
    expect(validateKnowledgeEvent({ ...first, scope: null })).toBe(false)
    expect(validateKnowledgeEvent({ ...first, sourceHash: 'bad' })).toBe(false)
    expect(validateKnowledgeEvent({ ...first, payload: [] })).toBe(false)
    expect(validateKnowledgeEvent({ ...first, previousEventHash: 'bad' })).toBe(false)
    expect(validateKnowledgeEvent({ ...first, eventHash: 'bad' })).toBe(false)
    expect(validateKnowledgeEvent({ ...first, payload: { record: { ...item, content: 'tampered' } } })).toBe(false)

    const second = createKnowledgeEvent('knowledge/retrieved', item.id, item.scope, {}, {
      id: 'event-1', seq: 1, timestamp: '2026-10-11T00:00:00.000Z', previousEventHash: first.eventHash,
    })
    expect(validateKnowledgeEvent(second, first)).toBe(true)
    expect(validateKnowledgeEvent({ ...second, seq: 2 }, first)).toBe(false)
    expect(validateKnowledgeEvent({ ...second, previousEventHash: 'a'.repeat(64) }, first)).toBe(false)
  })

  it('rejects a self-consistent event linked to a different predecessor', () => {
    const item = fixture()
    const first = event('knowledge/observed', item, state(), { record: item })
    const detached = createKnowledgeEvent('knowledge/retrieved', item.id, item.scope, {}, {
      seq: 1, previousEventHash: 'a'.repeat(64),
    })
    expect(validateKnowledgeEvent(detached)).toBe(true)
    expect(validateKnowledgeEvent(detached, first)).toBe(false)
    const current = applyKnowledgeEvent(state(), first)
    expect(() => applyKnowledgeEvent(current, detached)).toThrow('knowledge event chain gap')
    expect(current.lastEventHash).toBe(first.eventHash)
    expect(current.records.get(item.id)?.retrievalHits).toBe(0)
  })

  it('rejects a tampered event before changing replay state', () => {
    const item = fixture()
    const first = event('knowledge/observed', item, state(), { record: item })
    const current = state()
    const tampered = { ...first, payload: { record: { ...item, content: 'Replaced after hashing.' } } }
    expect(() => applyKnowledgeEvent(current, tampered)).toThrow('invalid knowledge event')
    expect(current).toEqual(state())
  })

  it('keeps conflict marking effective when the optional peer list is absent', () => {
    const item = fixture()
    const current = verifiedState(item)
    const conflicted = applyKnowledgeEvent(current, event('knowledge/conflict', item, current))
    const changed = conflicted.records.get(item.id)!
    expect(changed.conflicts).toEqual([])
    expect(changed.verificationStatus).toBe('conflict')
    expect(knowledgeInjectionDecision(changed, {
      projectId: 'project-a', workspaceId: 'workspace-a', sessionId: 'session-a',
    }, new Date('2026-10-11T00:00:00.000Z'))).toEqual({ allowed: false, reason: 'conflict' })
    expect(current.records.get(item.id)?.verificationStatus).toBe('verified')
  })

  it('refuses a sealed promotion before verification or while a conflict remains', () => {
    const item = fixture({ verificationStatus: 'candidate', lifecycle: 'candidate' })
    const candidate = applyKnowledgeEvent(state(), event('knowledge/candidate', item, state(), { record: item }))
    const seal = {
      authorityId: 'independent-verifier',
      authoritySeal: { authorityId: 'independent-verifier', proof: 'unit-promotion-shape' },
    }
    expect(() => applyKnowledgeEvent(candidate, event('knowledge/promoted', item, candidate, seal)))
      .toThrow('knowledge promotion requires conflict-free verification evidence')
    const verified = applyKnowledgeEvent(candidate, event('knowledge/verified', item, candidate, {
      authority: 'independent-verifier',
      authoritySeal: { authorityId: 'independent-verifier', proof: 'unit-verification-shape' },
      evidenceRefs: ['receipt:verified'],
    }))
    const conflicted = applyKnowledgeEvent(verified, event('knowledge/conflict', item, verified, { conflictIds: ['claim:beta'] }))
    expect(() => applyKnowledgeEvent(conflicted, event('knowledge/promoted', item, conflicted, seal)))
      .toThrow('knowledge promotion requires conflict-free verification evidence')
    expect(candidate.records.get(item.id)?.lifecycle).toBe('candidate')
    expect(conflicted.records.get(item.id)?.conflicts).toEqual(['claim:beta'])
  })

  it('rejects invalid event constructors and hashes valid optional provenance', () => {
    const item = fixture()
    expect(() => createKnowledgeEvent('invalid' as KnowledgeEventType, item.id, item.scope, {})).toThrow(/unknown knowledge event type/u)
    expect(() => createKnowledgeEvent('knowledge/observed', '', item.scope, {})).toThrow(/identity\/scope/u)
    expect(() => createKnowledgeEvent('knowledge/observed', item.id, { visibility: 'project' }, {})).toThrow(/identity\/scope/u)
    expect(() => createKnowledgeEvent('knowledge/observed', item.id, item.scope, {}, { seq: -1 })).toThrow(/sequence\/timestamp/u)
    expect(() => createKnowledgeEvent('knowledge/observed', item.id, item.scope, {}, { timestamp: 'bad-date' })).toThrow(/sequence\/timestamp/u)
    const withSource = createKnowledgeEvent('knowledge/observed', item.id, item.scope, {}, { sourceHash: 'a'.repeat(64) })
    expect(validateKnowledgeEvent(withSource)).toBe(true)
  })

  it('replays verification, utility, conflict, expiry, rejection, promotion and rollback transitions', () => {
    const original = fixture({ acl: { readers: ['reader'], writers: ['owner'] } })
    let current = state()
    const observed = event('knowledge/observed', original, current, { record: original })
    current = applyKnowledgeEvent(current, observed)
    const verified = event('knowledge/verified', original, current, {
      authority: 'independent-verifier',
      authoritySeal: { authorityId: 'independent-verifier', proof: 'proof' },
      evidenceRefs: ['receipt:verified'],
      trust: 'high',
      confidence: 1,
    })
    current = applyKnowledgeEvent(current, verified)
    expect(current.records.get(original.id)).toMatchObject({ verificationStatus: 'verified', authority: 'independent-verifier', trust: 'high' })

    current = applyKnowledgeEvent(current, event('knowledge/retrieved', original, current))
    current = applyKnowledgeEvent(current, event('knowledge/injected', original, current, { outcome: 'successful' }))
    current = applyKnowledgeEvent(current, event('knowledge/injected', original, current, { outcome: 'corrected' }))
    const beforeNeutral = current.records.get(original.id)
    current = applyKnowledgeEvent(current, event('knowledge/injected', original, current, { outcome: 'neutral' }))
    expect(current.records.get(original.id)).toEqual(beforeNeutral)

    current = applyKnowledgeEvent(current, event('knowledge/conflict', original, current, { conflictIds: ['other', '', 'other'] }))
    expect(current.records.get(original.id)?.conflicts).toEqual(['other'])
    current = applyKnowledgeEvent(current, event('knowledge/expired', original, current))
    expect(current.records.get(original.id)?.verificationStatus).toBe('expired')
    current = applyKnowledgeEvent(current, event('knowledge/rejected', original, current))
    expect(current.records.get(original.id)).toMatchObject({ verificationStatus: 'rejected', lifecycle: 'downgraded' })
    current = applyKnowledgeEvent(current, event('knowledge/rolled_back', original, current))
    expect(current.records.get(original.id)).toMatchObject({ verificationStatus: 'candidate', lifecycle: 'rolled_back' })
  })

  it('accepts a properly sealed canonical transition only after verification evidence', () => {
    const item = fixture({ verificationStatus: 'candidate' })
    let current = applyKnowledgeEvent(state(), event('knowledge/candidate', item, state(), { record: item }))
    current = applyKnowledgeEvent(current, event('knowledge/verified', item, current, {
      authority: 'independent-verifier',
      authoritySeal: { authorityId: 'independent-verifier', proof: 'verified-proof' },
      evidenceRefs: ['receipt:verified'],
    }))
    const promoted = event('knowledge/promoted', item, current, {
      authorityId: 'independent-verifier',
      authoritySeal: { authorityId: 'independent-verifier', proof: 'promoted-proof' },
      appliedPath: 'concepts/alpha.md',
      trialHash: '1'.repeat(64),
      proposalHash: '2'.repeat(64),
      targetAfterHash: '3'.repeat(64),
      measuredTrialAuthorityId: 'paired-trial-evaluator',
      evidenceRefs: ['4'.repeat(64)],
      retrievalHits: 2,
      successfulUses: 1,
      userCorrections: 0,
      utilityScore: 0.5,
      startedAt: '2026-10-11T10:00:00.000Z',
      endedAt: '2026-10-11T10:02:00.000Z',
    })
    current = applyKnowledgeEvent(current, promoted)
    expect(current.records.get(item.id)).toMatchObject({
      lifecycle: 'canonical',
      source: 'concepts/alpha.md',
      retrievalHits: 2,
      successfulUses: 1,
      utilityScore: 0.5,
    })
    const invalid = createKnowledgeEvent('knowledge/promoted', item.id, item.scope, {
      authorityId: 'different', authoritySeal: { authorityId: 'independent-verifier', proof: 'proof' },
    }, { seq: current.lastSeq + 1, previousEventHash: current.lastEventHash })
    expect(() => applyKnowledgeEvent(current, invalid)).toThrow(/promotion lacks authority seal/u)

    const { appliedPath: _appliedPath, ...samePathPayload } = promoted.payload
    const samePath = applyKnowledgeEvent(current, event('knowledge/promoted', item, current, samePathPayload))
    expect(samePath.records.get(item.id)?.source).toBe('concepts/alpha.md')
    expect(samePath.records.get(item.id)?.lifecycle).toBe('canonical')
    expect(current.records.get(item.id)?.retrievalHits).toBe(2)
  })

  it('keeps a legacy semantic-only promotion out of the canonical model-visible lifecycle', () => {
    const item = fixture({ verificationStatus: 'candidate' })
    let current = applyKnowledgeEvent(state(), event('knowledge/candidate', item, state(), { record: item }))
    current = applyKnowledgeEvent(current, event('knowledge/verified', item, current, {
      authority: 'independent-verifier',
      authoritySeal: { authorityId: 'independent-verifier', proof: 'verified-proof' },
      evidenceRefs: ['receipt:verified'],
    }))
    current = applyKnowledgeEvent(current, event('knowledge/promoted', item, current, {
      authorityId: 'independent-verifier',
      authoritySeal: { authorityId: 'independent-verifier', proof: 'legacy-semantic-only' },
      appliedPath: 'concepts/alpha.md',
    }))
    expect(current.records.get(item.id)).toMatchObject({
      verificationStatus: 'verified',
      lifecycle: 'downgraded',
    })
  })

  it('fails closed on event gaps, recordless transitions and unauthenticated verification', () => {
    const item = fixture()
    const first = event('knowledge/observed', item, state(), { record: item })
    const offStart = createKnowledgeEvent('knowledge/observed', item.id, item.scope, { record: item }, { seq: 1 })
    expect(() => applyKnowledgeEvent(state(), offStart)).toThrow(/chain must start at seq 0/u)
    const current = applyKnowledgeEvent(state(), first)
    const gap = createKnowledgeEvent('knowledge/retrieved', item.id, item.scope, {}, {
      seq: 3, previousEventHash: current.lastEventHash,
    })
    expect(() => applyKnowledgeEvent(current, gap)).toThrow(/chain gap/u)
    expect(() => applyKnowledgeEvent(state(), event('knowledge/observed', item, state()))).toThrow(/record is invalid/u)

    const invalidVerified = event('knowledge/verified', item, current, {
      authority: 'untrusted-observation',
      authoritySeal: { authorityId: 'untrusted-observation', proof: 'proof' },
      evidenceRefs: [],
    })
    expect(() => applyKnowledgeEvent(current, invalidVerified)).toThrow(/independent authority\/evidence/u)

    const recordlessState = applyKnowledgeEvent(state(), event('knowledge/retrieved', item, state()))
    expect(recordlessState.records.size).toBe(0)
    expect(recordlessState.lastSeq).toBe(0)
  })

  it('validates signed event-log authority, ignores blank lines and rejects malformed files', () => {
    const root = mkdtempSync(join(tmpdir(), 'knowledge-event-log-contract-'))
    roots.push(root)
    const path = join(root, 'events.jsonl')
    expect(readKnowledgeEventLog(path)).toEqual([])
    const item = fixture()
    const unsigned = event('knowledge/verified', item, state(), {
      record: fixture({ verificationStatus: 'candidate' }),
      authorityId: 'trusted',
      authoritySeal: { authorityId: 'trusted', proof: 'signed-proof' },
      evidenceRefs: ['receipt'],
    })
    writeFileSync(path, `\n${JSON.stringify(unsigned)}\n\n`)
    const accepted = readKnowledgeEventLog(path, {
      authorityId: 'trusted',
      validatePromotion: payload => payload.includes('"evidenceRefs":["receipt"]'),
    })
    expect(accepted).toHaveLength(1)
    expect(readFileSync(path, 'utf8')).toContain(JSON.stringify(unsigned))
    expect(() => readKnowledgeEventLog(path, { authorityId: 'other', validatePromotion: () => true }))
      .toThrow(/unauthenticated knowledge verification event/u)
    expect(() => readKnowledgeEventLog(path, { authorityId: 'trusted', validatePromotion: () => false }))
      .toThrow(/seal failed/u)

    writeFileSync(path, '{invalid json}\n')
    expect(() => readKnowledgeEventLog(path)).toThrow()
  })

  it.each([undefined, null, { id: 'wrong-knowledge-id' }])('rejects authenticated verification without its complete matching record: %s', (record) => {
    const root = mkdtempSync(join(tmpdir(), 'knowledge-verification-record-'))
    roots.push(root)
    const path = join(root, 'events.jsonl')
    const item = fixture()
    const verification = event('knowledge/verified', item, state(), {
      authorityId: 'trusted', authoritySeal: { authorityId: 'trusted', proof: 'unit-seal-shape' },
      record: record === undefined || record === null ? record : { ...item, ...record },
    })
    const bytes = `${JSON.stringify(verification)}\n`
    writeFileSync(path, bytes)
    expect(() => readKnowledgeEventLog(path, { authorityId: 'trusted', validatePromotion: () => true }))
      .toThrow('unauthenticated knowledge verification record')
    expect(readFileSync(path, 'utf8')).toBe(bytes)
  })

  it('appends only the next hash-bound event to a regular owned file', () => {
    const root = mkdtempSync(join(tmpdir(), 'knowledge-event-append-contract-'))
    roots.push(root)
    const path = join(root, 'events.jsonl')
    const item = fixture()
    const first = event('knowledge/observed', item, state(), { record: item })
    appendKnowledgeEvent(path, first)
    expect(readKnowledgeEventLog(path)).toEqual([first])
    const stale = createKnowledgeEvent('knowledge/retrieved', item.id, item.scope, {}, { seq: 4 })
    expect(() => { appendKnowledgeEvent(path, stale) }).toThrow(/hash\/sequence mismatch/u)

    if (process.platform !== 'win32') {
      const target = join(root, 'target.jsonl')
      writeFileSync(target, '')
      const linked = join(root, 'linked.jsonl')
      symlinkSync(target, linked)
      expect(() => { appendKnowledgeEvent(linked, first) }).toThrow(/unique ordinary file/u)
    }
  })
})
