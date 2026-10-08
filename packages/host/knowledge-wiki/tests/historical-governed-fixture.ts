import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  appendKnowledgeEvent, createKnowledgeEvent, createKnowledgeRecord,
  readKnowledgeEventLog, replayKnowledgeEvents,
} from '../src/knowledge-governance.ts'
import { canonicalJson, sha256, type KnowledgeWikiVerifierAuthority } from '../src/verifier.ts'
import { verifierAuthority } from './verifier-authority-fixture.ts'

/**
 * Seed historical, fixture-signed admission for read-boundary regressions.
 * This never invokes current production promotion or invents measured trial outcomes.
 */
export function seedHistoricalCanonicalKnowledge(input: {
  projectRoot: string
  wikiRoot: string
  path: string
  content: string
  authority?: KnowledgeWikiVerifierAuthority
  knowledgeId?: string
}) {
  const authority = input.authority ?? verifierAuthority()
  const knowledgeId = input.knowledgeId ?? `historical-fixture:${input.path}`
  const eventPath = join(input.projectRoot, '.llm-wiki/knowledge-events.jsonl')
  const prior = readKnowledgeEventLog(eventPath, authority)
  const existing = replayKnowledgeEvents(prior).records.get(knowledgeId)
  const record = existing ?? createKnowledgeRecord({
    id: knowledgeId,
    content: input.content,
    source: input.path,
    contentHash: sha256(input.content),
    scope: { projectId: input.projectRoot, visibility: 'project' },
    lifecycle: 'candidate',
  })
  const append = (type: 'knowledge/candidate' | 'knowledge/verified' | 'knowledge/promoted', payload: Record<string, unknown>) => {
    const events = readKnowledgeEventLog(eventPath, authority)
    const signed = type === 'knowledge/candidate' ? payload : {
      ...payload,
      authorityId: authority.authorityId,
      authoritySeal: authority.sealPromotion(canonicalJson({ type, knowledgeId, payload })),
    }
    appendKnowledgeEvent(eventPath, createKnowledgeEvent(type, knowledgeId, record.scope, signed, {
      seq: events.length, previousEventHash: events.at(-1)?.eventHash ?? null,
    }))
  }
  if (existing === undefined) append('knowledge/candidate', { record })
  append('knowledge/verified', {
    record,
    authority: authority.authorityId,
    confidence: 1,
    trust: 'medium',
    evidenceRefs: ['historical-fixture-only:no-measured-trial-claim'],
    fixturePurpose: 'historical-admission-for-read-boundary-only',
  })
  mkdirSync(dirname(join(input.wikiRoot, input.path)), { recursive: true })
  writeFileSync(join(input.wikiRoot, input.path), input.content)
  append('knowledge/promoted', {
    contentHash: sha256(input.content),
    appliedPath: input.path,
    fixturePurpose: 'historical-admission-for-read-boundary-only',
  })
  return { authority, knowledgeId, eventPath }
}
