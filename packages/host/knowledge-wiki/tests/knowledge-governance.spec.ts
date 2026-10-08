import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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
} from '../src/knowledge-governance.ts'

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
    const first = record()
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
    expect(replayed?.successfulUses).toBe(0)
    expect(replayed?.utilityScore).toBe(0)
    const tampered = readFileSync(path, 'utf8').replace('knowledge/candidate', 'knowledge/verified')
    writeFileSync(path, tampered)
    expect(() => readKnowledgeEventLog(path)).toThrow('invalid knowledge event log')
  })

  it('emits explicit expiry transitions and does not retain dead low-utility records forever', () => {
    const item = record({
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      expiresAt: new Date(Date.now() - 1).toISOString(), retrievalHits: 4, utilityScore: 0,
    })
    const observed = createKnowledgeEvent('knowledge/observed', item.id, item.scope, { record: item }, { seq: 0 })
    const state = replayKnowledgeEvents([observed])
    const expired = expireKnowledge(state)
    expect(expired.events.map(event => event.type)).toEqual(['knowledge/expired'])
    expect(expired.state.records.get(item.id)?.verificationStatus).toBe('expired')
    expect(shouldRetainKnowledge(item)).toBe(false)
  })
})
