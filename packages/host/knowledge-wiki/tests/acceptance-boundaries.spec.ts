import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  appendKnowledgeEvent,
  applyKnowledgeEvent,
  canonicalKnowledgeJson,
  createKnowledgeEvent,
  createKnowledgeRecord,
  detectKnowledgeConflicts,
  expireKnowledge,
  knowledgeInjectionDecision,
  knowledgeSha256,
  readKnowledgeEventLog,
  replayKnowledgeEvents,
  shouldRetainKnowledge,
  validateKnowledgeEvent,
  validateKnowledgeRecord,
} from '../src/knowledge-governance.ts'
import type { KnowledgeEvent, KnowledgeRecord } from '../src/types.ts'
import { verifierAuthority } from './verifier-authority-fixture.ts'

const roots: string[] = []
const scope = { projectId: 'project', workspaceId: 'workspace', sessionId: 'session' }
const access = { ...scope, actor: 'reader' }
const now = new Date('2026-10-08T00:00:00.000Z')
const authority = verifierAuthority()

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function record(): KnowledgeRecord {
  return createKnowledgeRecord({
    id: 'claim', content: 'Checked evidence', source: 'concepts/claim.md', scope,
    createdAt: '2026-10-07T00:00:00.000Z', expiresAt: '2026-10-09T00:00:00.000Z',
    verificationStatus: 'verified', confidence: 0.9, authority: 'independent-verifier',
    evidenceRefs: ['receipt'], acl: { readers: ['reader'], writers: ['writer'] },
  })
}

function logPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'governance-boundaries-'))
  roots.push(root)
  return join(root, 'events.jsonl')
}

function rehash(value: Record<string, unknown>): KnowledgeEvent {
  const unsigned = { ...value }
  delete unsigned.eventHash
  return { ...unsigned, eventHash: knowledgeSha256(canonicalKnowledgeJson(unsigned)) } as unknown as KnowledgeEvent
}

function signedEvent(
  type: 'knowledge/verified' | 'knowledge/promoted',
  payload: Record<string, unknown>,
  options: Parameters<typeof createKnowledgeEvent>[4] = {},
): KnowledgeEvent {
  return createKnowledgeEvent(type, 'claim', scope, {
    ...payload,
    authorityId: authority.authorityId,
    authoritySeal: authority.sealPromotion(canonicalKnowledgeJson({ type, knowledgeId: 'claim', payload })),
  }, options)
}

function verifiedEvent(options: Parameters<typeof createKnowledgeEvent>[4] = {}): KnowledgeEvent {
  return signedEvent('knowledge/verified', {
    record: { ...record(), authority: authority.authorityId }, authority: authority.authorityId,
    evidenceRefs: ['receipt'], confidence: 0.9,
  }, options)
}

describe('durable knowledge parser and model access boundaries', () => {
  it.each([null, [], 'claim'])('rejects a durable record that is not an object: %j', (value) => {
    expect(validateKnowledgeRecord(value)).toEqual({ ok: false, errors: ['record must be an object'] })
  })

  it.each([
    ['missing identity', { id: '' }],
    ['empty content', { content: ' ' }],
    ['missing source', { source: '' }],
    ['unbound source bytes', { sourceHash: 'invalid' }],
    ['absent scope', { scope: undefined }],
    ['empty project fence', { scope: { projectId: '' } }],
    ['unknown visibility', { scope: { visibility: 'public' } }],
    ['unknown trust', { trust: 'trusted' }],
    ['missing authority', { authority: '' }],
    ['non-list evidence', { evidenceRefs: null }],
    ['empty evidence reference', { evidenceRefs: [''] }],
    ['unknown verification state', { verificationStatus: 'approved' }],
    ['nonfinite confidence', { confidence: NaN }],
    ['out-of-range confidence', { confidence: 1.1 }],
    ['invalid creation time', { createdAt: 'yesterday' }],
    ['absent last verification time', { lastVerifiedAt: undefined }],
    ['invalid last verification time', { lastVerifiedAt: 'yesterday' }],
    ['absent expiry', { expiresAt: undefined }],
    ['invalid expiry', { expiresAt: 'tomorrow' }],
    ['expiry before creation', { expiresAt: '2026-10-06T00:00:00.000Z' }],
    ['non-list conflicts', { conflicts: null }],
    ['negative retrieval count', { retrievalHits: -1 }],
    ['fractional successful-use count', { successfulUses: 0.5 }],
    ['non-number corrections', { userCorrections: '0' }],
    ['nonfinite utility', { utilityScore: Infinity }],
    ['non-object ACL', { acl: [] }],
    ['non-list readers', { acl: { readers: 'reader' } }],
    ['empty writer identity', { acl: { writers: [''] } }],
  ])('denies malformed durable knowledge: %s', (_label, patch) => {
    const value = { ...record(), ...patch }
    expect(validateKnowledgeRecord(value).ok).toBe(false)
    expect(knowledgeInjectionDecision(value as KnowledgeRecord, access, now)).toEqual({ allowed: false, reason: 'invalid' })
  })

  it.each([
    ['wrong workspace', { ...access, workspaceId: 'other' }],
    ['wrong session', { ...access, sessionId: 'other' }],
    ['missing session', { projectId: access.projectId, workspaceId: access.workspaceId, actor: access.actor }],
  ])('denies correctly shaped knowledge outside its fence: %s', (_label, context) => {
    expect(knowledgeInjectionDecision(record(), context, now)).toEqual({ allowed: false, reason: 'scope-denied' })
  })

  it('denies missing actors, unverified claims, and exhausted utility while allowing an explicit empty reader ACL', () => {
    expect(knowledgeInjectionDecision(record(), scope, now).reason).toBe('acl-denied')
    expect(knowledgeInjectionDecision({ ...record(), verificationStatus: 'candidate' }, access, now).reason).toBe('unverified')
    expect(knowledgeInjectionDecision({ ...record(), confidence: 0 }, access, now).reason).toBe('low-confidence')
    expect(knowledgeInjectionDecision({ ...record(), retrievalHits: 3, utilityScore: 0 }, access, now).reason).toBe('low-confidence')
    expect(knowledgeInjectionDecision({ ...record(), acl: { readers: [] } }, scope, now).allowed).toBe(true)
    expect(knowledgeInjectionDecision({ ...record(), scope: { ...scope, visibility: 'session' } }, access, now).allowed).toBe(true)
    expect(knowledgeInjectionDecision({ ...record(), scope: { ...scope, visibility: 'session' } }, { ...access, sessionId: 'other' }, now).reason).toBe('scope-denied')
  })

  it('normalizes claims without conflating their source, scope, or verification state', () => {
    const base = record()
    const other = { ...base, id: 'other', content: 'different' }
    expect(detectKnowledgeConflicts(base, [base, other, { ...other, id: 'normalized', content: ' Checked   EVIDENCE ' }])).toEqual(['other'])
    expect(detectKnowledgeConflicts(base, [{ ...other, source: 'other.md' }, { ...other, scope: {} }, { ...other, verificationStatus: 'observed' }])).toEqual([])
  })
})

describe('knowledge journal rejection and lifecycle recovery', () => {
  it.each([
    ['schema', { schemaVersion: 2 }], ['type', { type: 'knowledge/unknown' }],
    ['id', { id: '' }], ['knowledge identity', { knowledgeId: '' }],
    ['sequence', { seq: -1 }], ['timestamp type', { timestamp: 1 }],
    ['timestamp', { timestamp: 'yesterday' }], ['scope', { scope: null }],
    ['source digest', { sourceHash: 'invalid' }], ['payload', { payload: [] }],
    ['chain link', { previousEventHash: 'invalid' }], ['digest', { eventHash: 'invalid' }],
  ])('rejects a hash-consistent journal row with invalid %s', (_label, patch) => {
    const event = createKnowledgeEvent('knowledge/observed', 'claim', scope, { record: record() })
    const changed = { ...event, ...patch }
    expect(validateKnowledgeEvent(_label === 'digest' ? changed : rehash(changed))).toBe(false)
  })

  it('rejects malformed constructors, stale append attempts, gaps, and invalid fold payloads', () => {
    expect(validateKnowledgeEvent(null)).toBe(false)
    expect(() => createKnowledgeEvent('unknown' as KnowledgeEvent['type'], 'claim', scope, {})).toThrow('unknown knowledge event')
    expect(() => createKnowledgeEvent('knowledge/observed', '', scope, {})).toThrow('identity/scope')
    expect(() => createKnowledgeEvent('knowledge/observed', 'claim', scope, {}, { seq: -1 })).toThrow('sequence/timestamp')
    const event = createKnowledgeEvent('knowledge/observed', 'claim', scope, { record: record() })
    const path = logPath()
    appendKnowledgeEvent(path, event)
    expect(() => { appendKnowledgeEvent(path, event) }).toThrow('hash/sequence mismatch')
    expect(() => replayKnowledgeEvents([{ ...event, eventHash: 'invalid' }])).toThrow('invalid knowledge event')
    expect(() => replayKnowledgeEvents([createKnowledgeEvent('knowledge/observed', 'claim', scope, { record: record() }, { seq: 1 })])).toThrow('chain must start')
    expect(() => replayKnowledgeEvents([event, event])).toThrow('chain gap')
    expect(() => replayKnowledgeEvents([createKnowledgeEvent('knowledge/observed', 'claim', scope, {})])).toThrow('record is invalid')
    expect(() => replayKnowledgeEvents([createKnowledgeEvent('knowledge/candidate', 'claim', scope, { record: {} })])).toThrow('record is invalid')
  })

  it('folds verified fallback, utility correction, conflicts, retirement, and rollback without mutating the prior state', () => {
    const first = verifiedEvent()
    let state = replayKnowledgeEvents([first])
    const original = state.records.get('claim')!
    const step = (type: KnowledgeEvent['type'], payload: Record<string, unknown>) => {
      state = applyKnowledgeEvent(state, createKnowledgeEvent(type, 'claim', scope, payload, {
        seq: state.lastSeq + 1, previousEventHash: state.lastEventHash,
      }))
    }
    step('knowledge/retrieved', {})
    step('knowledge/injected', { outcome: 'corrected' })
    step('knowledge/conflict', { conflictIds: ['other', '', 'other'] })
    expect(state.records.get('claim')).toMatchObject({ retrievalHits: 1, userCorrections: 1, utilityScore: -3, conflicts: ['other'], verificationStatus: 'conflict' })
    step('knowledge/rejected', {})
    expect(shouldRetainKnowledge(state.records.get('claim')!)).toBe(false)
    step('knowledge/rolled_back', {})
    expect(state.records.get('claim')).toMatchObject({ lifecycle: 'rolled_back', verificationStatus: 'candidate' })
    expect(original).toMatchObject({ retrievalHits: 0, userCorrections: 0, conflicts: [], verificationStatus: 'verified' })
    expect(shouldRetainKnowledge(
      { ...record(), retrievalHits: 5, utilityScore: 2 }, { minRetrievalHits: 4, minUtilityScore: 1 },
    )).toBe(true)
    expect(expireKnowledge(state, new Date('2026-10-10T00:00:00.000Z')).events).toHaveLength(1)
    const expired = expireKnowledge(state, new Date('2026-10-10T00:00:00.000Z')).state
    expect(expireKnowledge(expired, new Date('2026-10-11T00:00:00.000Z')).events).toEqual([])
  })

  it.each([
    { authority: '' }, { authority: 'untrusted-observation' }, { authoritySeal: null },
    { authoritySeal: { authorityId: 'impostor', proof: 'proof' } },
    { authoritySeal: { authorityId: 'independent-verifier', proof: '' } },
    { evidenceRefs: [] },
  ])('refuses verification transitions lacking an independent proof: %j', (patch) => {
    const observed = createKnowledgeEvent('knowledge/observed', 'claim', scope, { record: record() })
    const verified = createKnowledgeEvent('knowledge/verified', 'claim', scope, {
      record: record(),
      authority: 'independent-verifier', authoritySeal: { authorityId: 'independent-verifier', proof: 'proof' },
      evidenceRefs: ['receipt'], ...patch,
    }, { seq: 1, previousEventHash: observed.eventHash })
    expect(() => replayKnowledgeEvents([observed, verified])).toThrow('lacks independent authority/evidence')
  })

  it('rejects promotion without independent authority and without a conflict-free verified record', () => {
    const observed = createKnowledgeEvent('knowledge/observed', 'claim', scope, { record: record() })
    const promoted = createKnowledgeEvent('knowledge/promoted', 'claim', scope, {}, { seq: 1, previousEventHash: observed.eventHash })
    expect(() => replayKnowledgeEvents([observed, promoted])).toThrow('promotion lacks authority seal')
    const candidate = createKnowledgeEvent('knowledge/candidate', 'claim', scope, { record: record() })
    expect(() => replayKnowledgeEvents([
      candidate,
      signedEvent('knowledge/promoted', { contentHash: knowledgeSha256(record().content) }, {
        seq: 1, previousEventHash: candidate.eventHash,
      }),
    ])).toThrow('requires conflict-free verification evidence')
    const verified = verifiedEvent({ seq: 1, previousEventHash: observed.eventHash })
    const state = replayKnowledgeEvents([
      observed,
      verified,
      signedEvent('knowledge/promoted', { contentHash: knowledgeSha256(record().content) }, {
        seq: 2, previousEventHash: verified.eventHash,
      }),
    ])
    expect(state.records.get('claim')).toMatchObject({ lifecycle: 'canonical', source: 'concepts/claim.md' })
  })

  it('keeps an unjudged injection neutral and refuses a verifier transition that produces invalid state', () => {
    const observed = createKnowledgeEvent('knowledge/observed', 'claim', scope, { record: record() })
    const state = replayKnowledgeEvents([observed])
    const injected = applyKnowledgeEvent(state, createKnowledgeEvent('knowledge/injected', 'claim', scope, {}, {
      seq: 1, previousEventHash: observed.eventHash,
    }))
    expect(injected.records.get('claim')).toMatchObject({ successfulUses: 0, userCorrections: 0, utilityScore: 0 })
    const verified = createKnowledgeEvent('knowledge/verified', 'claim', scope, {
      record: { ...record(), confidence: 2 },
      authority: 'independent-verifier', authoritySeal: { authorityId: 'independent-verifier', proof: 'proof' },
      evidenceRefs: ['receipt'], confidence: 2,
    }, { seq: 1, previousEventHash: observed.eventHash })
    expect(() => applyKnowledgeEvent(state, verified)).toThrow('knowledge verification record is invalid')
  })

  it('skips future and non-expiring knowledge during expiry and preserves partial reader/writer ACLs', () => {
    const first = createKnowledgeEvent('knowledge/observed', 'claim', scope, { record: { ...record(), acl: { readers: ['reader'] } } })
    const second = createKnowledgeEvent('knowledge/observed', 'permanent', scope, {
      record: { ...record(), id: 'permanent', expiresAt: null, acl: { writers: ['writer'] } },
    }, { seq: 1, previousEventHash: first.eventHash })
    const state = replayKnowledgeEvents([first, second])
    expect(state.records.get('claim')?.acl).toEqual({ readers: ['reader'] })
    expect(state.records.get('permanent')?.acl).toEqual({ writers: ['writer'] })
    expect(expireKnowledge(state, now).events).toEqual([])
  })

  it('refuses a verified journal whose authority seal is absent or invalid', () => {
    const path = logPath()
    const event = createKnowledgeEvent('knowledge/verified', 'claim', scope, {
      record: record(), authority: 'independent-verifier', evidenceRefs: ['receipt'],
    })
    writeFileSync(path, `${JSON.stringify(event)}\n`)
    expect(() => readKnowledgeEventLog(path, authority)).toThrow('unauthenticated knowledge verification event')
    const sealed = createKnowledgeEvent('knowledge/verified', 'claim', scope, {
      ...event.payload, authorityId: authority.authorityId,
      authoritySeal: { authorityId: authority.authorityId, proof: 'wrong-proof' },
    })
    writeFileSync(path, `${JSON.stringify(sealed)}\n`)
    expect(() => readKnowledgeEventLog(path, authority)).toThrow('seal failed')
    const authenticated = verifiedEvent()
    writeFileSync(path, `${JSON.stringify(authenticated)}\n`)
    expect(readKnowledgeEventLog(path, authority)).toEqual([authenticated])
    expect(() => replayKnowledgeEvents([event])).toThrow('lacks independent authority/evidence')
  })
})
