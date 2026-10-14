import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import {
  appendKnowledgeEvent,
  canKnowledgeChangePolicy,
  createKnowledgeEvent,
  createKnowledgeRecord,
  detectKnowledgeConflicts,
  expireKnowledge,
  knowledgeInjectionDecision,
  readKnowledgeEventLog,
  replayKnowledgeEvents,
  shouldRetainKnowledge,
  validateKnowledgeRecord,
} from '../src/knowledge-governance.ts'

const MAX_EVENT_LOG_BYTES = 64 * 1024 * 1024
const EVENT_TIMESTAMP = '2026-10-13T00:00:00.000Z'
const EVENT_PATH_PREFIX = 'concepts/é"\\\n'

function record(overrides: Partial<Parameters<typeof createKnowledgeRecord>[0]> = {}) {
  return createKnowledgeRecord({
    id: 'k-1',
    content: 'A reusable verified claim with applicability and evidence.',
    source: 'source.md',
    scope: { projectId: 'project-a', workspaceId: 'workspace-a', visibility: 'workspace' },
    evidenceRefs: ['receipt-1'],
    verificationStatus: 'verified',
    confidence: 0.9,
    trust: 'high',
    lastVerifiedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  })
}

function eventLineBytes(event: ReturnType<typeof createKnowledgeEvent>): number {
  return Buffer.byteLength(`${JSON.stringify(event)}\n`, 'utf8')
}

function sizedRetrievedEvent(
  root: string,
  seq: number,
  previousEventHash: string | null,
  lineBytes: number,
  id: string,
) {
  const create = (path: string) => createKnowledgeEvent('knowledge/retrieved', 'page:probe', {
    projectId: root,
    visibility: 'project',
  }, { path, retrievalAt: EVENT_TIMESTAMP }, {
    seq, timestamp: EVENT_TIMESTAMP, previousEventHash, id,
  })
  const baseBytes = eventLineBytes(create(EVENT_PATH_PREFIX))
  const paddingBytes = lineBytes - baseBytes
  if (!Number.isSafeInteger(paddingBytes) || paddingBytes < 0) throw new Error('invalid event line fixture size')
  const event = create(`${EVENT_PATH_PREFIX}${'x'.repeat(paddingBytes)}`)
  if (eventLineBytes(event) !== lineBytes) throw new Error('event line fixture byte count drifted')
  return event
}

function hashTree(root: string): string {
  const entries: string[] = []
  const visit = (directory: string, relative: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const child = join(directory, entry.name)
      const childRelative = relative === '' ? entry.name : `${relative}/${entry.name}`
      if (entry.isDirectory()) {
        entries.push(`directory:${childRelative}`)
        visit(child, childRelative)
      } else {
        entries.push(`file:${childRelative}:${createHash('sha256').update(readFileSync(child)).digest('hex')}`)
      }
    }
  }
  visit(root, '')
  return createHash('sha256').update(entries.join('\n')).digest('hex')
}

describe('knowledge governance state and replay', () => {
  it('rejects visibility scopes without their corresponding fence', () => {
    expect(() => createKnowledgeRecord({
      id: 'unscoped-project', content: 'x', source: 'x', scope: { visibility: 'project' },
    })).toThrow(/scope is invalid/)
    expect(() => createKnowledgeRecord({
      id: 'unscoped-workspace', content: 'x', source: 'x', scope: { visibility: 'workspace' },
    })).toThrow(/scope is invalid/)
    expect(() => createKnowledgeRecord({
      id: 'unscoped-session', content: 'x', source: 'x', scope: { visibility: 'session' },
    })).toThrow(/scope is invalid/)
  })

  it('validates nullable timestamps and optional claim keys at the record owner', () => {
    const valid = record({ claimKey: 'claim:k-1', lastVerifiedAt: null, expiresAt: null })
    expect(validateKnowledgeRecord(valid).ok).toBe(true)
    expect(validateKnowledgeRecord(record()).ok).toBe(true)

    const singletonDate = ['2026-10-08T00:00:00.000Z']
    const invalidLastVerifiedAt = { ...valid, lastVerifiedAt: singletonDate } as never
    const invalidExpiresAt = { ...valid, expiresAt: singletonDate } as never
    const invalidClaimKey = { ...valid, claimKey: { key: 'claim:k-1' } } as never
    expect(validateKnowledgeRecord(invalidLastVerifiedAt).ok).toBe(false)
    expect(validateKnowledgeRecord(invalidExpiresAt).ok).toBe(false)
    expect(validateKnowledgeRecord(invalidClaimKey).ok).toBe(false)

    const objectKeyA = { ...valid, id: 'k-object-a', content: 'First claim.', claimKey: { key: 'same' } } as never
    const objectKeyB = { ...valid, id: 'k-object-b', content: 'Different claim.', claimKey: { key: 'same' } } as never
    expect(detectKnowledgeConflicts(objectKeyA, [objectKeyB])).toEqual([])
    const stringKeyA = record({ id: 'k-string-a', content: 'First claim.', claimKey: 'same' })
    const stringKeyB = record({ id: 'k-string-b', content: 'Different claim.', claimKey: 'same' })
    expect(detectKnowledgeConflicts(stringKeyA, [stringKeyB])).toEqual(['k-string-b'])
  })

  it('enforces scope, ACL, expiry, conflict, and low-trust policy gates', () => {
    const item = record({ acl: { readers: ['agent-a'] }, authority: 'independent-verifier' })
    expect(knowledgeInjectionDecision(item, { projectId: 'project-a', workspaceId: 'workspace-a', actor: 'agent-a' }).allowed).toBe(true)
    expect(knowledgeInjectionDecision(item, { projectId: 'project-b', workspaceId: 'workspace-a', actor: 'agent-a' }).reason).toBe('scope-denied')
    expect(knowledgeInjectionDecision(item, { projectId: 'project-a', workspaceId: 'workspace-a', actor: 'agent-b' }).reason).toBe('acl-denied')
    expect(knowledgeInjectionDecision(record({ createdAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() - 1).toISOString() }), { projectId: 'project-a', workspaceId: 'workspace-a' }).reason).toBe('expired')
    expect(knowledgeInjectionDecision(record({ conflicts: ['k-2'] }), { projectId: 'project-a', workspaceId: 'workspace-a' }).reason).toBe('conflict')
    expect(canKnowledgeChangePolicy(record({ trust: 'low' }))).toBe(false)
    expect(canKnowledgeChangePolicy(item)).toBe(true)
  })

  it('detects divergent claims in one scope and replays a tamper-evident event chain', () => {
    const first = record({ verificationStatus: 'candidate' })
    const second = record({ id: 'k-2', content: 'A divergent claim with the same workspace scope.', source: 'other.md', claimKey: 'claim:k-1' })
    const firstWithClaim = record({ claimKey: 'claim:k-1' })
    expect(detectKnowledgeConflicts(firstWithClaim, [second])).toEqual(['k-2'])
    const dir = mkdtempSync(join(tmpdir(), 'knowledge-events-'))
    const path = join(dir, 'events.jsonl')
    const observed = createKnowledgeEvent('knowledge/observed', first.id, first.scope, { record: first }, { seq: 0 })
    appendKnowledgeEvent(path, observed)
    const candidate = createKnowledgeEvent('knowledge/candidate', first.id, first.scope, { record: first }, { seq: 1, previousEventHash: observed.eventHash })
    appendKnowledgeEvent(path, candidate)
    const retrieval = createKnowledgeEvent('knowledge/retrieved', first.id, first.scope, {}, { seq: 2, previousEventHash: candidate.eventHash })
    appendKnowledgeEvent(path, retrieval)
    const injected = createKnowledgeEvent('knowledge/injected', first.id, first.scope, { outcome: 'successful' }, { seq: 3, previousEventHash: retrieval.eventHash })
    appendKnowledgeEvent(path, injected)
    const replayed = replayKnowledgeEvents(readKnowledgeEventLog(path)).records.get(first.id)
    expect(replayed?.verificationStatus).toBe('candidate')
    expect(replayed?.retrievalHits).toBe(1)
    expect(replayed?.successfulUses).toBe(1)
    const tampered = readFileSync(path, 'utf8').replace('knowledge/candidate', 'knowledge/verified')
    writeFileSync(path, tampered)
    expect(() => readKnowledgeEventLog(path)).toThrow('invalid knowledge event log')
  })

  it('accepts an exact UTF-8 JSONL byte limit and rejects a one-byte overflow without changing the tree', () => {
    for (const overflowBy of [0, 1]) {
      const dir = mkdtempSync(join(tmpdir(), 'knowledge-event-log-byte-bound-'))
      try {
        const path = join(dir, 'events.jsonl')
        const nextEventBytes = eventLineBytes(createKnowledgeEvent('knowledge/retrieved', 'page:probe', {
          projectId: dir,
          visibility: 'project',
        }, { path: EVENT_PATH_PREFIX, retrievalAt: EVENT_TIMESTAMP }, {
          seq: 1, timestamp: EVENT_TIMESTAMP, previousEventHash: 'a'.repeat(64), id: 'event-next',
        }))
        const first = sizedRetrievedEvent(dir, 0, null, MAX_EVENT_LOG_BYTES - nextEventBytes + overflowBy, 'event-first')
        const second = createKnowledgeEvent('knowledge/retrieved', 'page:probe', {
          projectId: dir,
          visibility: 'project',
        }, { path: EVENT_PATH_PREFIX, retrievalAt: EVENT_TIMESTAMP }, {
          seq: 1, timestamp: EVENT_TIMESTAMP, previousEventHash: first.eventHash, id: 'event-next',
        })
        appendKnowledgeEvent(path, first)
        const before = readFileSync(path)
        expect(readKnowledgeEventLog(path)).toHaveLength(1)
        expect(before.byteLength).toBe(MAX_EVENT_LOG_BYTES - nextEventBytes + overflowBy)
        expect(eventLineBytes(second)).toBe(nextEventBytes)

        if (overflowBy === 0) {
          appendKnowledgeEvent(path, second)
          const after = readFileSync(path)
          expect(after.byteLength).toBe(MAX_EVENT_LOG_BYTES)
          expect(after.toString('utf8').endsWith('\n')).toBe(true)
          expect(readKnowledgeEventLog(path)).toHaveLength(2)
        } else {
          const treeBefore = hashTree(dir)
          const beforeDigest = createHash('sha256').update(before).digest('hex')
          expect(() => { appendKnowledgeEvent(path, second) }).toThrow(/knowledge event log exceeds/u)
          expect(hashTree(dir)).toBe(treeBefore)
          const after = readFileSync(path)
          expect(after.byteLength).toBe(before.byteLength)
          expect(createHash('sha256').update(after).digest('hex')).toBe(beforeDigest)
          expect(readKnowledgeEventLog(path)).toHaveLength(1)
        }
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  }, 30_000)

  it('rejects an ordinary retrieval append before crossing the cap and preserves a readable event tree', () => {
    const dir = mkdtempSync(join(tmpdir(), 'knowledge-event-log-production-shape-'))
    try {
      const path = join(dir, 'events.jsonl')
      const lines: string[] = []
      let bytes = 0
      let seq = 0
      let previousEventHash: string | null = null
      let next = createKnowledgeEvent('knowledge/retrieved', 'page:probe', {
        projectId: dir,
        visibility: 'project',
      }, { path: 'concepts/probe.md', retrievalAt: EVENT_TIMESTAMP }, {
        seq, timestamp: EVENT_TIMESTAMP, previousEventHash, id: `probe-${seq}`,
      })
      let nextLine = `${JSON.stringify(next)}\n`
      while (bytes + Buffer.byteLength(nextLine, 'utf8') <= MAX_EVENT_LOG_BYTES) {
        lines.push(nextLine)
        bytes += Buffer.byteLength(nextLine, 'utf8')
        previousEventHash = next.eventHash
        seq += 1
        next = createKnowledgeEvent('knowledge/retrieved', 'page:probe', {
          projectId: dir,
          visibility: 'project',
        }, { path: 'concepts/probe.md', retrievalAt: EVENT_TIMESTAMP }, {
          seq, timestamp: EVENT_TIMESTAMP, previousEventHash, id: `probe-${seq}`,
        })
        nextLine = `${JSON.stringify(next)}\n`
      }
      const prior = lines.join('')
      expect(Buffer.byteLength(prior, 'utf8')).toBe(bytes)
      expect(bytes).toBeLessThanOrEqual(MAX_EVENT_LOG_BYTES)
      expect(bytes + Buffer.byteLength(nextLine, 'utf8')).toBeGreaterThan(MAX_EVENT_LOG_BYTES)
      writeFileSync(path, prior)
      expect(readKnowledgeEventLog(path)).toHaveLength(seq)
      const priorHash = createHash('sha256').update(prior).digest('hex')
      const treeBefore = hashTree(dir)

      expect(() => { appendKnowledgeEvent(path, next) }).toThrow(/knowledge event log exceeds/u)

      const after = readFileSync(path)
      expect(after.byteLength).toBe(bytes)
      expect(createHash('sha256').update(after).digest('hex')).toBe(priorHash)
      expect(hashTree(dir)).toBe(treeBefore)
      expect(readKnowledgeEventLog(path)).toHaveLength(seq)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  it('rejects an oversized new event before creating its parent directory or file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'knowledge-event-log-new-byte-bound-'))
    try {
      const parent = join(dir, 'not-created')
      const path = join(parent, 'events.jsonl')
      const event = sizedRetrievedEvent(dir, 0, null, MAX_EVENT_LOG_BYTES + 1, 'event-too-large')
      expect(() => { appendKnowledgeEvent(path, event) }).toThrow(/knowledge event log exceeds/u)
      expect(existsSync(parent)).toBe(false)
      expect(existsSync(path)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  it('emits explicit expiry transitions and does not retain dead low-utility records forever', () => {
    const item = record({
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      expiresAt: new Date(Date.now() - 1).toISOString(), retrievalHits: 4, utilityScore: 0,
      verificationStatus: 'candidate',
    })
    const observed = createKnowledgeEvent('knowledge/observed', item.id, item.scope, { record: item }, { seq: 0 })
    const state = replayKnowledgeEvents([observed])
    const expired = expireKnowledge(state)
    expect(expired.events.map(event => event.type)).toEqual(['knowledge/expired'])
    expect(expired.state.records.get(item.id)?.verificationStatus).toBe('expired')
    expect(shouldRetainKnowledge(item)).toBe(false)
  })

  it('expires a verified record after three retrievals without utility lift', () => {
    const item = record({ verificationStatus: 'candidate', retrievalHits: 3, utilityScore: 0 })
    const observed = createKnowledgeEvent('knowledge/observed', item.id, item.scope, { record: item }, { seq: 0 })
    const verified = createKnowledgeEvent('knowledge/verified', item.id, item.scope, {
      record: item, authority: 'independent-verifier',
      authoritySeal: { authorityId: 'independent-verifier', proof: 'unit-verification-shape' },
      evidenceRefs: ['receipt:verified'], trust: 'high', confidence: 0.9,
    }, { seq: 1, previousEventHash: observed.eventHash })
    const expired = expireKnowledge(replayKnowledgeEvents([observed, verified]))
    expect(expired.events).toHaveLength(1)
    expect(expired.events[0]).toMatchObject({
      type: 'knowledge/expired',
      knowledgeId: item.id,
      payload: { reason: 'low-utility', retrievalHits: 3, utilityScore: 0 },
    })
    expect(expired.state.records.get(item.id)?.verificationStatus).toBe('expired')
  })
})
