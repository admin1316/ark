import { generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { BlockAssembler, CallId, MessageId, createMessage, type ContentBlock, type StreamChunk, type ToolResultBlock } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionStore, type SessionEvent } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '../../packages/sandbox/sandbox-policy/src/session-mode.ts'
import { createKnowledgeWikiMeasuredTrialReader, MEASURED_TRIAL_METRICS, type OpportunityCounts } from '../../packages/host/knowledge-wiki/src/measured-trial.ts'
import { canonicalJson, sha256 } from '../../packages/host/knowledge-wiki/src/verifier.ts'
import { captureKnowledgeUse, capturePersistedKnowledgeUse, sealCapturedUse, type KnowledgeUseBinding,
  type KnowledgeUseJournalSignRequest, type KnowledgeUseJournalSigningAuthority } from './knowledge-session-use.ts'

const project = '/isolated/pilot-project'
const config = { provider: 'pilot-fixture', model: 'pilot-model' }
const journal = generateKeyPairSync('ed25519')
const retryOwner = generateKeyPairSync('ed25519')

function journalAuthority(options: {
  authorityId?: string
  publicKey?: KeyObject
  privateKey?: KeyObject
  sign?: (request: KnowledgeUseJournalSignRequest, signal: AbortSignal) => Promise<Uint8Array>
} = {}): KnowledgeUseJournalSigningAuthority {
  const authorityId = options.authorityId ?? 'journal-test'
  const publicKey = options.publicKey ?? journal.publicKey
  return {
    authorityId,
    publicKey,
    signKnowledgeUseJournal: options.sign ?? (async (request, signal) => {
      if (signal.aborted) throw new Error('test signer aborted')
      return sign(null, Buffer.from(canonicalJson(request), 'utf8'), options.privateKey ?? journal.privateKey)
    }),
  }
}

const journalAbortSignal = (): AbortSignal => new AbortController().signal

function retryDocument(f: { events: SessionEvent[]; snapshot: Buffer; binding: KnowledgeUseBinding }) {
  return { schemaVersion: 1, kind: 'same-arguments-failed-parent-retry-v1', authorityId: 'pilot-test:retry-owner',
    sessionId: f.binding.sessionId, turn: f.binding.turn, snapshotHash: sha256(f.snapshot), taskHash: sha256(f.binding.task),
    calls: f.events.filter(event => event.type === 'tool/call').map((call) => {
      const result = f.events.find(event => event.type === 'tool/result' && event.data.message.source.callId === call.data.callId)!
      return { callId: String(call.data.callId), callSeq: call.seq, resultSeq: result.seq, resultHash: sha256(canonicalJson(result)),
        argumentsHash: sha256(canonicalJson(JSON.parse(call.data.arguments) as unknown)), name: call.data.name,
        failed: call.data.callId === 'first-bash', retryOf: call.data.callId === 'second-bash' ? 'first-bash' : null as string | null }
    }) }
}

function signedRetry(f: Parameters<typeof retryDocument>[0], mutate = (_doc: ReturnType<typeof retryDocument>) => {}, keys = retryOwner) {
  const doc = retryDocument(f)
  mutate(doc)
  return { authorityId: 'pilot-test:retry-owner', publicKey: keys.publicKey,
    artifactBytes: Buffer.from(canonicalJson({ ...doc, proof: sign(null, Buffer.from(canonicalJson(doc)), keys.privateKey).toString('base64') })) }
}

function scenario(options: {
  candidate?: boolean
  noHeaderExtras?: boolean
  errorsAndRepeat?: boolean
  retrySecond?: { name: string; arguments: string }
  reusedParent?: boolean
  reasoning?: boolean
  noCost?: boolean
  repeatPolicy?: boolean
  sessionId?: string
  timeOffset?: number
} = {}) {
  const sessionId = options.sessionId ?? 'pilot-session'
  const session = Session.create(SessionId(sessionId), undefined, { version: 0, id: SessionId(sessionId), createdAt: 10, cwd: project })
  session.append('permission/preset', { preset: 'read-only' })
  session.append('sandbox/mode', { mode: 'read-only' })
  session.append('approval/policy', { policy: 'ask' })
  session.append('turn/start', { turn: 1 })
  let step = 0
  const start = () => { step += 1; session.append('step/start', { turn: 1, step }) }
  const model = (blocks: ContentBlock[]) => {
    const assembler = new BlockAssembler()
    const seqs: number[] = []
    const push = (chunk: StreamChunk) => {
      assembler.push(chunk)
      seqs.push(session.append('assistant/chunk', { turn: 1, step, chunk }).seq)
    }
    for (const [index, block] of blocks.entries()) {
      push({ type: 'block-start', index, blockType: block.type })
      push({ type: 'block-end', index, block })
    }
    push({ type: 'usage', usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 } })
    push({ type: 'finish', reason: { kind: blocks.some(block => block.type === 'tool-call') ? 'tool-calls' : 'stop' } })
    const usage = assembler.usage
    if (usage === undefined) throw new Error('fixture usage not assembled')
    session.append('assistant/message', { turn: 1, step, message: createMessage({ role: 'assistant', content: assembler.blocks(), source: { kind: 'model', ...config } }), usage }, { surfaceOp: 'append', sourceEventSeqs: seqs })
  }
  const call = (id: string, name: string, content: ContentBlock[], isError = false, args = '{"path":"concepts/fixed-rule.md"}') => {
    const callId = CallId(id)
    model([{ type: 'tool-call', id: callId, name, arguments: args }])
    session.append('tool/call', { turn: 1, step, callId, name, arguments: args })
    return () => {
      const resultContent: [ToolResultBlock] = [{ type: 'tool-result', toolCallId: callId, content, isError }]
      session.append('tool/result', { turn: 1, step, message: createMessage({ role: 'user', source: { kind: 'tool', callId }, content: resultContent }) }, { surfaceOp: 'append' })
      session.append('step/end', { turn: 1, step })
    }
  }
  start()
  session.append('user/message', { role: 'user', id: MessageId('pilot-input'), content: [{ type: 'text', text: 'registered task' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
  if (options.repeatPolicy) session.append('sandbox/mode', { mode: 'read-only' })
  session.append('request/header', { reason: 'initial', header: { config,
    ...(options.noHeaderExtras ? {} : { system: 'fixed system', tools: [{ name: 'wiki_read', description: 'Read scoped knowledge', parameters: { type: 'object' } }] }) } })
  const sourcePage = 'Frozen rule; not a prior answer.'
  const rendered: ContentBlock[] = [{ type: 'text', text: '# concepts/fixed-rule.md\n\nFrozen rule; not a prior answer.' }]
  const sourceContentHash = sha256(sourcePage)
  if (options.candidate) {
    const finishCall = call('wiki-call', 'wiki_read', rendered)
    const common = { knowledgeId: 'wiki:concepts/fixed-rule.md', path: 'concepts/fixed-rule.md',
      resultHash: sha256(JSON.stringify(rendered)), contentHash: sha256(JSON.stringify(rendered)), sourceContentHash,
      tool: 'wiki_read', callId: 'wiki-call', scope: { sessionId, projectId: project, workspaceId: project },
      verificationStatus: 'verified' as const }
    session.append('knowledge/retrieved', { ...common, kind: 'page', allowed: true, reason: 'ok' })
    session.append('knowledge/injected', { ...common, kind: 'page', value: rendered as never, contentBytes: Buffer.byteLength(JSON.stringify(rendered)) })
    finishCall()
    start()
  }
  if (options.errorsAndRepeat) {
    call('first-bash', 'bash', [{ type: 'text', text: 'first command failed' }], true)()
    start()
    call('second-bash', options.retrySecond?.name ?? 'bash', [{ type: 'text', text: 'retry succeeded' }], false,
      options.retrySecond?.arguments)()
    start()
    if (options.reusedParent) { call('third-bash', 'bash', [{ type: 'text', text: 'another succeeded' }])(); start() }
  }
  model([...(options.reasoning ? [{ type: 'reasoning' as const, text: 'private reasoning' }] : []), { type: 'text', text: 'SUM=23' }])
  session.append('step/end', { turn: 1, step })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const binding: KnowledgeUseBinding = {
    useId: 'use-1', sessionId: String(session.id), projectRoot: project, turn: 1, role: options.candidate ? 'candidate' : 'baseline',
    pairId: 'pair-1', grantId: options.candidate ? 'grant-1' : null, proposalHash: sha256('proposal'), measurementDefinitionHash: sha256('definition'),
    sourceIdentity: { commit: 'a'.repeat(40), sourceDigest: sha256('source'), dirty: true, dirtyDigest: sha256('dirty'), buildDigest: sha256('build') },
    profileIdentity: 'isolated-test-profile', buildIdentity: sha256('build'), config, task: 'registered task', goalHash: sha256('goal'), policyHash: sha256('policy'),
    permissions: { 'permission/preset': { preset: 'read-only' }, 'sandbox/mode': { mode: 'read-only' }, 'approval/policy': { policy: 'ask' } },
    knowledge: options.candidate ? { id: 'wiki:concepts/fixed-rule.md', sourceContentHash, rendered } : null,
    cost: options.noCost ? null : { microunits: 17, artifactBytes: Buffer.from('independent test cost evidence') },
  }
  const events = [...structuredClone(session.events)]
  if (options.timeOffset !== undefined) for (const item of events) Object.assign(item, { time: item.time + options.timeOffset })
  const metadata = structuredClone(session.header)
  const snapshot = Buffer.from(canonicalJson({ metadata, events }))
  if (options.errorsAndRepeat) Object.assign(binding, { retryEvidence: signedRetry({ events, snapshot, binding }) })
  return { metadata, events, snapshot, binding }
}

function capture(fixture: ReturnType<typeof scenario>) {
  return captureKnowledgeUse(fixture.metadata, fixture.events, fixture.snapshot, fixture.binding)
}

function event(fixture: ReturnType<typeof scenario>, type: string): Record<string, unknown> {
  const found = fixture.events.find(item => item.type === type)
  if (found === undefined) throw new Error(`test fixture has no ${type}`)
  return found
}

describe('complete session use capture', () => {
  it('reuses core projection and preserves original snapshot, complete output, and model request identity', () => {
    const fixture = scenario({ reasoning: true })
    const result = capture(fixture)
    expect(result.wholeOutput).toBe('SUM=23')
    expect(result.facts).toMatchObject({ role: 'baseline', knowledgeId: null, renderedToolResultHash: null,
      errorsRetriesToolCallsAndCost: { errors: 0, retries: 0, toolCalls: 0, costMicrounits: 17 } })
    const rawJournal = JSON.parse(result.artifacts.get(result.journalArtifactHash)!.toString('utf8')) as Record<string, unknown>
    expect(rawJournal['originalSnapshotHash']).toBe(sha256(fixture.snapshot))
    expect(result.requests[0]).toMatchObject({ ...config, sessionId: 'pilot-session', system: 'fixed system' })
    expect(capture(scenario({ noHeaderExtras: true })).requests[0]).not.toHaveProperty('system')
    expect(capture(scenario({ repeatPolicy: true })).wholeOutput).toBe('SUM=23')
  })
  it('binds actual retrieval, tool bytes, project and subsequent request without claiming the rule was correct', () => {
    const fixture = scenario({ candidate: true })
    const result = capture(fixture)
    expect(result.requests).toHaveLength(2)
    expect(result.facts).toMatchObject({ knowledgeId: fixture.binding.knowledge!.id, contentHash: fixture.binding.knowledge!.sourceContentHash, callId: 'wiki-call' })
    const request = JSON.parse(result.artifacts.get(result.facts['providerRequestHash'] as string)!.toString('utf8')) as {
      messages: Array<{ source: { callId?: string } }>
    }
    expect(request.messages.some(message => message.source.callId === 'wiki-call')).toBe(true)
    expect(result.facts).not.toHaveProperty('oracleIdentityAndResults')
  })
  it('retains the first failed command and repeated tool arguments after a successful retry', () => {
    const result = capture(scenario({ errorsAndRepeat: true }))
    expect(result).toMatchObject({ errors: 1, repeatedCalls: 1, wholeOutput: 'SUM=23' })
    expect(result.facts).toMatchObject({ errorsRetriesToolCallsAndCost: { errors: 1, retries: 1, toolCalls: 2 } })
  })
  it('keeps all visible assistant text, including progress prose', () => {
    const fixture = scenario({ candidate: true })
    const first = fixture.events.find(item => item.type === 'assistant/message')!
    if (first.type !== 'assistant/message') throw new Error('bad fixture')
    const seqs = first.sourceEventSeqs!
    // Regenerate a consistent raw text block instead of merely changing the final pane.
    const blocks = [{ type: 'text' as const, text: 'Reading.\n' }, ...first.data.message.content]
    const assembler = new BlockAssembler()
    const replacement: SessionEvent[] = []
    for (const [index, block] of blocks.entries()) {
      for (const chunk of [{ type: 'block-start' as const, index, blockType: block.type }, { type: 'block-end' as const, index, block }]) {
        assembler.push(chunk)
        replacement.push({ type: 'assistant/chunk', seq: 0, time: first.time, data: { turn: 1, step: 1, chunk } })
      }
    }
    for (const seq of seqs.slice(-2)) replacement.push(fixture.events[seq]!)
    fixture.events.splice(seqs[0]!, seqs.length, ...replacement)
    const delta = replacement.length - seqs.length
    for (const [index, item] of fixture.events.entries()) {
      Object.assign(item, { seq: index })
      if (item.type === 'assistant/message' && item === first) {
        Object.assign(item.data.message, { content: blocks })
        Object.assign(item, { sourceEventSeqs: replacement.map((_, offset) => seqs[0]! + offset) })
      } else if ('sourceEventSeqs' in item && item.sourceEventSeqs !== undefined) {
        Object.assign(item, { sourceEventSeqs: item.sourceEventSeqs.map(seq => seq + delta) })
      }
    }
    expect(capture(fixture).wholeOutput).toBe('Reading.\nSUM=23')
  })
  it.each(['empty', 'oversized'])('refuses %s raw snapshots', (kind) => {
    const fixture = scenario()
    fixture.snapshot = kind === 'empty' ? Buffer.alloc(0) : Buffer.alloc(16 * 1024 * 1024 + 1)
    expect(() => capture(fixture)).toThrow(/snapshot/u)
  })
  it.each(['projectRoot', 'sessionId', 'task', 'turn'])('refuses a wrong %s binding', (key) => {
    const fixture = scenario()
    Object.assign(fixture.binding, { [key]: key === 'turn' ? 2 : 'different' })
    expect(() => capture(fixture)).toThrow()
  })
  it('refuses a relative project, noncontiguous log, incomplete turn, repeated turn, and cancellation', () => {
    const relative = scenario(); Object.assign(relative.metadata, { cwd: 'relative' }); Object.assign(relative.binding, { projectRoot: 'relative' })
    expect(() => capture(relative)).toThrow(/project/u)
    const gap = scenario(); Object.assign(gap.events[0]!, { seq: 1 }); expect(() => capture(gap)).toThrow(/contiguous/u)
    const incomplete = scenario(); incomplete.events.pop(); expect(() => capture(incomplete)).toThrow(/incomplete/u)
    const repeated = scenario(); repeated.events.push({ type: 'turn/start', seq: repeated.events.length, time: 99, data: { turn: 1 } }); expect(() => capture(repeated)).toThrow(/repeated/u)
    const cancelled = scenario(); Object.assign(event(cancelled, 'turn/end')['data'] as object, { reason: { kind: 'aborted', reason: { kind: 'user' } } }); expect(() => capture(cancelled)).toThrow(/cancelled/u)
  })
  it('refuses policy drift and missing policy evidence', () => {
    const drift = scenario(); Object.assign(event(drift, 'sandbox/mode')['data'] as object, { mode: 'workspace-write' }); expect(() => capture(drift)).toThrow(/policy/u)
    const missing = scenario(); event(missing, 'approval/policy')['type'] = 'session/title'; event(missing, 'session/title')['data'] = { title: 'no policy' }; expect(() => capture(missing)).toThrow(/policy/u)
  })
  it.each([
    ['interrupted message', (f: ReturnType<typeof scenario>) => { Object.assign(event(f, 'assistant/message')['data'] as object, { interrupted: true }) }],
    ['lost stream links', (f: ReturnType<typeof scenario>) => { delete event(f, 'assistant/message')['sourceEventSeqs'] }],
    ['reordered chunks', (f: ReturnType<typeof scenario>) => { (event(f, 'assistant/message')['sourceEventSeqs'] as number[]).reverse() }],
    ['changed final pane', (f: ReturnType<typeof scenario>) => { const d = event(f, 'assistant/message')['data'] as { message: { content: unknown[] } }; d.message.content = [{ type: 'text', text: 'SUM=999' }] }],
    ['changed usage', (f: ReturnType<typeof scenario>) => { Object.assign(event(f, 'assistant/message')['data'] as object, { usage: { inputTokens: 999, outputTokens: 1, totalTokens: 1000 } }) }],
    ['changed model config', (f: ReturnType<typeof scenario>) => { Object.assign(f.binding, { config: { ...config, model: 'different' } }) }],
    ['empty stream links', (f: ReturnType<typeof scenario>) => { event(f, 'assistant/message')['sourceEventSeqs'] = [] }],
    ['missing raw finish', (f: ReturnType<typeof scenario>) => { const d = event(f, 'assistant/message'); d['sourceEventSeqs'] = (d['sourceEventSeqs'] as number[]).slice(0, -1) }],
    ['missing step end', (f: ReturnType<typeof scenario>) => { event(f, 'step/end')['type'] = 'session/title'; event(f, 'session/title')['data'] = { title: 'lost boundary' } }],
    ['foreign model attribution', (f: ReturnType<typeof scenario>) => { const d = event(f, 'assistant/message')['data'] as { message: { source: object } }; Object.assign(d.message.source, { model: 'other' }) }],
  ])('refuses %s', (_name, mutate) => { const f = scenario(); mutate(f); expect(() => capture(f)).toThrow() })
  it('refuses a raw error finish despite a completed turn marker', () => {
    const f = scenario()
    const chunk = f.events.find(item => item.type === 'assistant/chunk' && item.data.chunk.type === 'finish')
    if (chunk?.type !== 'assistant/chunk') throw new Error('missing test finish')
    Object.assign(chunk.data, { chunk: { type: 'finish', reason: { kind: 'error', failure: { code: 'UNKNOWN', message: 'failed' } } } })
    expect(() => capture(f)).toThrow(/finish/u)
  })
  it.each([
    ['mismatched call arguments', (f: ReturnType<typeof scenario>) => { Object.assign(event(f, 'tool/call')['data'] as object, { arguments: '{}' }) }],
    ['missing result', (f: ReturnType<typeof scenario>) => { event(f, 'tool/result')['type'] = 'session/title'; event(f, 'session/title')['data'] = { title: 'no result' } }],
    ['different result call id', (f: ReturnType<typeof scenario>) => { const d = event(f, 'tool/result')['data'] as { message: { source: object } }; Object.assign(d.message.source, { callId: 'other' }) }],
    ['different result step', (f: ReturnType<typeof scenario>) => { Object.assign(event(f, 'tool/result')['data'] as object, { step: 3 }) }],
    ['different block call id', (f: ReturnType<typeof scenario>) => { const d = event(f, 'tool/result')['data'] as { message: { content: object[] } }; Object.assign(d.message.content[0]!, { toolCallId: 'other' }) }],
    ['changed actual knowledge tool result', (f: ReturnType<typeof scenario>) => { const d = event(f, 'tool/result')['data'] as { message: { content: object[] } }; Object.assign(d.message.content[0]!, { content: [{ type: 'text', text: 'changed' }] }) }],
  ])('refuses %s', (_name, mutate) => { const f = scenario({ candidate: true }); mutate(f); expect(() => capture(f)).toThrow() })
  it.each([
    ['wrong source hash', { sourceContentHash: sha256('other') }], ['wrong knowledge scope', { scope: { sessionId: 'other', projectId: project, workspaceId: project } }],
    ['truncated knowledge', { truncated: true }], ['unverified knowledge', { verificationStatus: 'candidate' }], ['wrong rendering', { value: [{ type: 'text', text: 'changed' }] }],
    ['wrong content size', { contentBytes: 1 }], ['wrong result hash', { resultHash: sha256('other') }],
  ])('refuses %s', (_name, fields) => {
    const f = scenario({ candidate: true }); Object.assign(event(f, 'knowledge/injected')['data'] as object, fields); expect(() => capture(f)).toThrow(/knowledge/u)
  })
  it('refuses denied retrieval, an unrelated knowledge id, a missing grant, and baseline exposure', () => {
    const denied = scenario({ candidate: true }); Object.assign(event(denied, 'knowledge/retrieved')['data'] as object, { allowed: false, reason: 'scope-denied' }); expect(() => capture(denied)).toThrow(/retrieval/u)
    const unrelated = scenario({ candidate: true }); Object.assign(unrelated.binding.knowledge!, { id: 'other' }); expect(() => capture(unrelated)).toThrow(/injected/u)
    const grant = scenario({ candidate: true })
    Object.assign(grant.binding, { grantId: null })
    expect(() => capture(grant)).toThrow(/grant/u)
    const baseline = scenario({ candidate: true }); Object.assign(baseline.binding, { role: 'baseline', grantId: null, knowledge: null }); expect(() => capture(baseline)).toThrow(/baseline/u)
  })
  it.each(['exit', 'signal', 'timeout'])('retains foreground shell %s failure even when isError=false', (kind) => {
    const f = scenario({ errorsAndRepeat: true })
    const data = event(f, 'tool/result')['data'] as { message: { content: Array<{ content: ContentBlock[]; isError: boolean }> } }
    const result = data.message.content[0]!
    result.isError = false
    result.content = [{ type: 'text', text: kind === 'exit' ? 'denied\n[exit code: 1]' : kind === 'signal' ? 'stopped\n[killed by signal: SIGTERM]' : 'stopped\n[timed out after 10ms]' }]
    Object.assign(f.binding, { retryEvidence: signedRetry(f) })
    expect(capture(f).errors).toBe(1)
  })
  it('does not certify repeated calls as retries without independent attribution', async () => {
    const f = scenario({ errorsAndRepeat: true })
    delete (f.binding as { retryEvidence?: unknown }).retryEvidence
    const observed = capture(f)
    expect(observed.repeatedCalls).toBe(1)
    expect((observed.facts['errorsRetriesToolCallsAndCost'] as Record<string, unknown>)['retries']).toBeNull()
    await expect(sealCapturedUse(observed, journalAuthority(), journalAbortSignal())).rejects.toThrow(/retry evidence/u)
  })
  it.each([
    ['wrong session', (doc: ReturnType<typeof retryDocument>) => { doc.sessionId = 'other-session' }],
    ['wrong turn', (doc: ReturnType<typeof retryDocument>) => { doc.turn += 1 }],
    ['wrong snapshot', (doc: ReturnType<typeof retryDocument>) => { doc.snapshotHash = sha256('other snapshot') }],
    ['wrong task', (doc: ReturnType<typeof retryDocument>) => { doc.taskHash = sha256('other task') }],
    ['missing call', (doc: ReturnType<typeof retryDocument>) => { doc.calls.pop() }],
    ['extra call', (doc: ReturnType<typeof retryDocument>) => { doc.calls.push(doc.calls[0]!) }],
    ['wrong result', (doc: ReturnType<typeof retryDocument>) => { doc.calls[1]!.resultHash = sha256('other result') }],
    ['duplicate call', (doc: ReturnType<typeof retryDocument>) => { doc.calls[1] = doc.calls[0]! }],
    ['future parent', (doc: ReturnType<typeof retryDocument>) => { doc.calls[0]!.retryOf = 'second-bash' }],
    ['self parent', (doc: ReturnType<typeof retryDocument>) => { doc.calls[1]!.retryOf = 'second-bash' }],
  ] as const)('refuses authenticated but inconsistent retry attribution: %s', (_name, mutate) => {
    const f = scenario({ errorsAndRepeat: true })
    Object.assign(f.binding, { retryEvidence: signedRetry(f, mutate) })
    expect(() => capture(f)).toThrow(/retry/u)
  })
  it('refuses unsigned, malformed, oversized, mismatched-authority and substituted-key retry evidence', () => {
    const f = scenario({ errorsAndRepeat: true })
    const original = f.binding.retryEvidence!
    for (const artifactBytes of [Buffer.alloc(0), Buffer.alloc(2 * 1024 * 1024 + 1), Buffer.from('opaque attribution'),
      Buffer.from(canonicalJson(retryDocument(f)))]) {
      Object.assign(f.binding, { retryEvidence: { ...original, artifactBytes } })
      expect(() => capture(f)).toThrow()
    }
    for (const override of [{ authorityId: 'pilot-test:other' }, { publicKey: journal.publicKey },
      { publicKey: journal.privateKey }, { publicKey: generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey }]) {
      Object.assign(f.binding, { retryEvidence: { ...original, ...override } })
      expect(() => capture(f)).toThrow(/retry/u)
    }
    const doc = JSON.parse(original.artifactBytes.toString('utf8')) as Record<string, unknown>
    doc['turn'] = 2
    Object.assign(f.binding, { retryEvidence: { ...original, artifactBytes: Buffer.from(canonicalJson(doc)) } })
    expect(() => capture(f)).toThrow(/signature/u)
  })
  it('derives zero from exhaustive signed initial-call classification instead of a supplied count', () => {
    const f = scenario({ errorsAndRepeat: true })
    Object.assign(f.binding, { retryEvidence: signedRetry(f, (doc) => { doc.calls[1]!.retryOf = null }) })
    expect(capture(f).facts).toMatchObject({ errorsRetriesToolCallsAndCost: { retries: 0 } })
  })
  it('refuses to let the retry owner also seal the journal', async () => {
    const f = scenario({ errorsAndRepeat: true })
    Object.assign(f.binding, { retryEvidence: signedRetry(f, undefined, journal) })
    const authority = journalAuthority({ publicKey: journal.publicKey, privateKey: journal.privateKey })
    await expect(sealCapturedUse(capture(f), authority, journalAbortSignal()))
      .rejects.toThrow(/distinct/u)
  })
  it.each([
    { name: 'read', arguments: '{"path":"concepts/fixed-rule.md"}' },
    { name: 'bash', arguments: '{"path":"another-independent-query"}' },
  ])('refuses retry attribution across different tools or arguments: %j', (retrySecond) => {
    expect(() => capture(scenario({ errorsAndRepeat: true, retrySecond }))).toThrow(/same tool and canonical arguments/u)
  })
  it('refuses a successful parent and counting the same failed parent twice', () => {
    const successful = scenario({ errorsAndRepeat: true })
    const result = successful.events.find(item => item.type === 'tool/result')!
    if (result.type !== 'tool/result') throw new Error('wrong fixture')
    Object.assign(result.data.message.content[0], { isError: false })
    Object.assign(successful.binding, { retryEvidence: signedRetry(successful, (doc) => { doc.calls[0]!.failed = false }) })
    expect(() => capture(successful)).toThrow(/failed call/u)
    const repeated = scenario({ errorsAndRepeat: true, reusedParent: true })
    Object.assign(repeated.binding, { retryEvidence: signedRetry(repeated, (doc) => { doc.calls[2]!.retryOf = 'first-bash' }) })
    expect(() => capture(repeated)).toThrow(/unconsumed/u)
  })
  it('keeps missing cost evidence UNKNOWN and refuses sealing it', async () => {
    const captured = capture(scenario({ noCost: true }))
    expect(captured.costAvailable).toBe(false)
    expect((captured.facts['errorsRetriesToolCallsAndCost'] as Record<string, unknown>)['costMicrounits']).toBeNull()
    await expect(sealCapturedUse(captured, journalAuthority(), journalAbortSignal())).rejects.toThrow(/cost/u)
  })
  it.each([-1, 0.5, Infinity])('refuses invalid independent cost %s', (microunits) => {
    const f = scenario(); Object.assign(f.binding.cost!, { microunits }); expect(() => capture(f)).toThrow(/cost/u)
  })
})

describe('test-key journal signing', () => {
  it('signs the reader-compatible factual binding and original complete journal artifact', async () => {
    const captured = capture(scenario({ candidate: true }))
    const sealed = await sealCapturedUse(captured, journalAuthority(), journalAbortSignal())
    expect(sealed.hash).toBe(sha256(sealed.bytes))
    const { journalSignerSignature, ...unsigned } = JSON.parse(sealed.bytes.toString('utf8')) as Record<string, unknown>
    expect(unsigned).toMatchObject({ schemaVersion: 1, kind: 'knowledge-use-journal-v1', useFactsHash: sha256(canonicalJson(captured.facts)), journalArtifactHash: captured.journalArtifactHash })
    expect(verify(null, Buffer.from(canonicalJson(unsigned)), journal.publicKey, Buffer.from(journalSignerSignature as string, 'base64'))).toBe(true)
    expect(verify(null, Buffer.from(canonicalJson(unsigned)), generateKeyPairSync('ed25519').publicKey,
      Buffer.from(journalSignerSignature as string, 'base64'))).toBe(false)
  })
  it('refuses forged captures, changed facts, changed original bytes, and replaced artifact references', async () => {
    const signal = journalAbortSignal()
    const copied = capture(scenario())
    await expect(sealCapturedUse({ ...copied }, journalAuthority(), signal)).rejects.toThrow(/changed/u)
    const changed = capture(scenario())
    Object.assign(changed.facts, { callId: 'other' })
    await expect(sealCapturedUse(changed, journalAuthority(), signal)).rejects.toThrow(/changed/u)
    const bytes = capture(scenario())
    bytes.artifacts.get(bytes.journalArtifactHash)![0] = 0
    await expect(sealCapturedUse(bytes, journalAuthority(), signal)).rejects.toThrow(/changed/u)
    const removed = capture(scenario())
    const removedArtifacts = removed.artifacts as Map<string, Buffer>
    removedArtifacts.delete(removed.journalArtifactHash)
    await expect(sealCapturedUse(removed, journalAuthority(), signal)).rejects.toThrow(/changed/u)
    const added = capture(scenario()); (added.artifacts as Map<string, Buffer>).set(sha256('unowned'), Buffer.from('unowned'))
    await expect(sealCapturedUse(added, journalAuthority(), journalAbortSignal())).rejects.toThrow(/changed/u)
  })
  it('refuses invalid signing identities and public/non-Ed25519 keys', async () => {
    const captured = capture(scenario())
    await expect(sealCapturedUse(captured, journalAuthority({ authorityId: 'invalid id' }), journalAbortSignal()))
      .rejects.toThrow(/authority/u)
    await expect(sealCapturedUse(captured, journalAuthority({ publicKey: journal.privateKey }), journalAbortSignal()))
      .rejects.toThrow(/authority/u)
    const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const ecAuthority = journalAuthority({ publicKey: ec.publicKey, privateKey: ec.privateKey })
    await expect(sealCapturedUse(captured, ecAuthority, journalAbortSignal())).rejects.toThrow(/authority/u)
  })

  it('refuses coerced authority IDs and non-KeyObject public-key lookalikes before signer dispatch', async () => {
    const captured = capture(scenario())
    for (const authorityId of [['journal-test'], 17]) {
      let signerDispatched = false
      const authority = {
        ...journalAuthority({ sign: async (request) => {
          signerDispatched = true
          return sign(null, Buffer.from(canonicalJson(request), 'utf8'), journal.privateKey)
        } }),
        authorityId,
      } as unknown as KnowledgeUseJournalSigningAuthority
      await expect(sealCapturedUse(captured, authority, journalAbortSignal())).rejects.toThrow(/authority/u)
      expect(signerDispatched).toBe(false)
    }

    let signerDispatched = false
    const keyLookalike = {
      type: 'public', asymmetricKeyType: 'ed25519',
      export: () => journal.publicKey.export({ format: 'der', type: 'spki' }),
    }
    const authority = {
      ...journalAuthority({ sign: async (request) => {
        signerDispatched = true
        return sign(null, Buffer.from(canonicalJson(request), 'utf8'), journal.privateKey)
      } }),
      publicKey: keyLookalike,
    } as unknown as KnowledgeUseJournalSigningAuthority
    await expect(sealCapturedUse(captured, authority, journalAbortSignal())).rejects.toThrow(/authority/u)
    expect(signerDispatched).toBe(false)
  })

  it.each(['signature-as-text', undefined])('refuses a signer result that is not bytes: %s', async (returned) => {
    const authority = journalAuthority({
      sign: async () => returned as unknown as Uint8Array,
    })
    let sealedBytes: Buffer | undefined
    const pending = sealCapturedUse(capture(scenario()), authority, journalAbortSignal()).then((result) => {
      sealedBytes = result.bytes
      return result
    })
    await expect(pending).rejects.toThrow(/non-byte signature/u)
    expect(sealedBytes).toBeUndefined()
  })

  it('revalidates captured facts and exact artifact bytes after asynchronous signing settles', async () => {
    const captured = capture(scenario())
    let entered!: (request: KnowledgeUseJournalSignRequest) => void
    let release!: () => void
    const enteredPromise = new Promise<KnowledgeUseJournalSignRequest>((resolve) => { entered = resolve })
    const releasePromise = new Promise<void>((resolve) => { release = resolve })
    const authority = journalAuthority({ sign: async (request) => {
      entered(request)
      await releasePromise
      return sign(null, Buffer.from(canonicalJson(request), 'utf8'), journal.privateKey)
    } })
    const pending = sealCapturedUse(captured, authority, journalAbortSignal())
    const request = await enteredPromise
    Object.assign(captured.facts, { callId: 'mutated-while-signing' })
    release()
    await expect(pending).rejects.toThrow(/changed/u)
    expect(request).toMatchObject({ schemaVersion: 1, kind: 'knowledge-use-journal-v1', journalSignerAuthorityId: 'journal-test' })

    const artifactCapture = capture(scenario())
    let artifactEntered!: () => void
    let artifactRelease!: () => void
    const artifactEnteredPromise = new Promise<void>((resolve) => { artifactEntered = resolve })
    const artifactReleasePromise = new Promise<void>((resolve) => { artifactRelease = resolve })
    const artifactAuthority = journalAuthority({ sign: async (payload) => {
      artifactEntered()
      await artifactReleasePromise
      return sign(null, Buffer.from(canonicalJson(payload), 'utf8'), journal.privateKey)
    } })
    const artifactPending = sealCapturedUse(artifactCapture, artifactAuthority, journalAbortSignal())
    await artifactEnteredPromise
    const journalArtifact = artifactCapture.artifacts.get(artifactCapture.journalArtifactHash)
    if (journalArtifact === undefined) throw new Error('test capture lost the journal artifact before mutation')
    const firstByte = journalArtifact[0]
    if (firstByte === undefined) throw new Error('test journal artifact unexpectedly has no bytes')
    journalArtifact[0] = firstByte ^ 1
    artifactRelease()
    await expect(artifactPending).rejects.toThrow(/changed/u)
  })

  it('rejects cancellation, signer identity changes, and signatures for another key or payload after settlement', async () => {
    const preAbortedCapture = capture(scenario())
    const preAbortedController = new AbortController()
    preAbortedController.abort()
    let signerDispatched = false
    const preAbortedAuthority = journalAuthority({ sign: async (request) => {
      signerDispatched = true
      return sign(null, Buffer.from(canonicalJson(request), 'utf8'), journal.privateKey)
    } })
    await expect(sealCapturedUse(preAbortedCapture, preAbortedAuthority, preAbortedController.signal)).rejects.toThrow(/aborted/u)
    expect(signerDispatched).toBe(false)

    const cancelled = capture(scenario())
    const controller = new AbortController()
    let entered!: () => void
    let release!: () => void
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve })
    const releasePromise = new Promise<void>((resolve) => { release = resolve })
    const delayed = journalAuthority({ sign: async (request) => {
      entered()
      await releasePromise
      return sign(null, Buffer.from(canonicalJson(request), 'utf8'), journal.privateKey)
    } })
    const cancelledPending = sealCapturedUse(cancelled, delayed, controller.signal)
    await enteredPromise
    controller.abort()
    release()
    await expect(cancelledPending).rejects.toThrow(/aborted/u)

    const changedAuthorityCapture = capture(scenario())
    let changeEntered!: () => void
    let changeRelease!: () => void
    const changeEnteredPromise = new Promise<void>((resolve) => { changeEntered = resolve })
    const changeReleasePromise = new Promise<void>((resolve) => { changeRelease = resolve })
    const mutableAuthority = {
      ...journalAuthority({ sign: async (request) => {
        changeEntered()
        await changeReleasePromise
        return sign(null, Buffer.from(canonicalJson(request), 'utf8'), journal.privateKey)
      } }),
    }
    const changePending = sealCapturedUse(changedAuthorityCapture, mutableAuthority, journalAbortSignal())
    await changeEnteredPromise
    Object.assign(mutableAuthority, { authorityId: 'other-journal-owner' })
    changeRelease()
    await expect(changePending).rejects.toThrow(/changed/u)

    const wrongKey = generateKeyPairSync('ed25519')
    const wrongKeyAuthority = journalAuthority({ sign: async request => sign(null, Buffer.from(canonicalJson(request), 'utf8'), wrongKey.privateKey) })
    await expect(sealCapturedUse(capture(scenario()), wrongKeyAuthority, journalAbortSignal())).rejects.toThrow(/invalid signature/u)

    const otherPayloadAuthority = journalAuthority({ sign: async request => sign(null,
      Buffer.from(canonicalJson({ ...request, journalArtifactHash: sha256('other') }), 'utf8'), journal.privateKey) })
    await expect(sealCapturedUse(capture(scenario()), otherPayloadAuthority, journalAbortSignal())).rejects.toThrow(/invalid signature/u)
  })
})

describe('owner-loaded persisted use capture', () => {
  it.each(['none', 'zstd'] as const)('loads exact %s bytes without writing to the source snapshot', async (compression) => {
    const root = await mkdtemp(join(tmpdir(), 'ark-persisted-use-test-'))
    const context = new Context()
    try {
      const f = scenario({ candidate: true })
      await context.plugin(SessionStore)
      await context.plugin(JsonlSessionPersistence, { root, compression })
      await context.sessionPersistence.create(f.metadata)
      await context.sessionPersistence.append(f.metadata.id, f.events)
      const location = context.sessionPersistence.locate(f.metadata)
      if (location?.kind !== 'jsonl') throw new Error('fixture has no JSONL location')
      const original = await readFile(location.path)
      const result = await capturePersistedKnowledgeUse(location.path, sha256(original), f.binding)
      expect(result.wholeOutput).toBe('SUM=23')
      expect(result.facts).toMatchObject({ callId: 'wiki-call' })
      expect(await readFile(location.path)).toEqual(original)
      await expect(capturePersistedKnowledgeUse(location.path, sha256('other'), f.binding)).rejects.toThrow(/freezing/u)
    } finally {
      await context.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
  it('refuses relative paths, unsupported encoding and owner-repaired incomplete bytes', async () => {
    const f = scenario()
    await expect(capturePersistedKnowledgeUse('relative.jsonl', sha256('bytes'), f.binding)).rejects.toThrow(/absolute/u)
    await expect(capturePersistedKnowledgeUse('/absolute/snapshot.txt', sha256('bytes'), f.binding)).rejects.toThrow(/encoding/u)
    const root = await mkdtemp(join(tmpdir(), 'ark-invalid-use-test-'))
    const context = new Context()
    try {
      await context.plugin(SessionStore)
      await context.plugin(JsonlSessionPersistence, { root, compression: 'none' })
      await context.sessionPersistence.create(f.metadata)
      await context.sessionPersistence.append(f.metadata.id, f.events)
      const location = context.sessionPersistence.locate(f.metadata)
      if (location?.kind !== 'jsonl') throw new Error('fixture has no JSONL location')
      const torn = Buffer.concat([await readFile(location.path), Buffer.from('{"partial":')])
      await writeFile(location.path, torn)
      await expect(capturePersistedKnowledgeUse(location.path, sha256(torn), f.binding)).rejects.toThrow(/repaired|corrupt|incomplete/u)
      expect(await readFile(location.path)).toEqual(torn)
    } finally {
      await context.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('captured Wiki use read by the measured-trial consumer', () => {
  it('accepts actual captureKnowledgeUse and sealCapturedUse output with canonical session-event storage', async () => {
    const evaluator = generateKeyPairSync('ed25519')
    const authorityId = 'pilot-independent-evaluator'
    const measurementDefinitionHash = sha256('cross-owner-measurement-definition')
    const targetBytes = Buffer.from('Frozen rule; not a prior answer.')
    const modelIdentity = {
      model: config.model,
      modelConfigHash: sha256(canonicalJson(config)),
      taskHash: sha256('registered task'),
      goalHash: sha256('goal'),
      policyHash: sha256('policy'),
    }
    const files = new Map<string, Buffer>()
    const putRaw = (bytes: Buffer): string => { const hash = sha256(bytes); files.set(hash, bytes); return hash }
    const putCanonical = (value: Record<string, unknown>): string => putRaw(Buffer.from(canonicalJson(value), 'utf8'))
    const targetAfterHash = putRaw(targetBytes)
    const candidateHash = putRaw(Buffer.from('candidate repair bytes'))
    const semanticReceiptHash = putCanonical({ schemaVersion: 1, receiptId: 'semantic-1' })
    const sourceArtifactManifestHash = putCanonical({ schemaVersion: 1, sourceArtifacts: [] })
    const governedRecordHash = putCanonical({ schemaVersion: 1, knowledgeId: 'wiki:concepts/fixed-rule.md' })
    const scopeAclExpiryHash = putCanonical({ schemaVersion: 1, scope: 'project', acl: null, expiresAt: '1970-01-02T00:00:00.000Z' })
    const signRecord = (record: Record<string, unknown>): Record<string, unknown> => {
      const unsigned = { ...record, evaluatorAuthorityId: authorityId }
      return { ...unsigned, evaluatorSignature: sign(null, Buffer.from(canonicalJson(unsigned)), evaluator.privateKey).toString('base64') }
    }
    const proposal = {
      schemaVersion: 1,
      reviewHash: sha256('review'),
      semanticReceiptHash,
      candidatePath: '_candidates/ingest/concepts/fixed-rule.md',
      candidateHash,
      sourceArtifactManifestHash,
      governedRecordHash,
      scopeAclExpiryHash,
      action: 'Promote',
      targetPath: 'concepts/fixed-rule.md',
      targetBeforeHashOrVerifiedAbsence: 'verified-absence',
      targetAfterHash,
      frozenApprovalActor: 'reviewer-1',
      frozenApprovalTime: '1970-01-01T00:00:00.000Z',
      transformVersion: 'knowledge-promotion-v1',
      sourceIdentity: { commit: 'a'.repeat(40), sourceDigest: sha256('source') },
      buildIdentity: { build: 'candidate-build', digest: sha256('build') },
      profileIdentity: { profile: 'pilot', digest: sha256('profile') },
      modelPolicyIdentity: { model: config.model, policyHash: modelIdentity.policyHash },
      immutableMissionIdentity: { goalHash: modelIdentity.goalHash, acceptanceHash: sha256('acceptance') },
    }
    const proposalHash = putCanonical(proposal)
    const epochBase = Date.now()
    const time = (offset: number): string => new Date(epochBase + offset).toISOString()
    const preRegistration = signRecord({
      schemaVersion: 1,
      preRegistrationId: 'pilot-preregistration-1',
      proposalHash,
      measurementDefinitionHash,
      modelConfigTaskGoalPolicyIdentity: modelIdentity,
      orderedPairIds: ['pair-1'],
      issuedAt: time(-60_000),
    })
    const preRegistrationHash = putCanonical(preRegistration)
    const grantId = 'pilot-grant-1'
    const grant = signRecord({
      schemaVersion: 1, grantId, proposalHash, reviewedDecisionHash: proposalHash, preRegistrationHash,
      measurementDefinitionHash, allowedSessionIds: ['pilot-candidate-fresh-session'],
      modelConfigTaskGoalPolicyIdentity: modelIdentity,
      maxObservations: 1, maxTurns: 1,
      deadline: time(180_000), issuedAt: time(1_000), expiresAt: time(240_000),
    })
    const grantHash = putCanonical(grant)
    const baselineFixture = scenario({ sessionId: 'pilot-baseline-fresh-session' })
    const candidateFixture = scenario({ candidate: true, sessionId: 'pilot-candidate-fresh-session', timeOffset: 120_000 })
    for (const f of [baselineFixture, candidateFixture]) Object.assign(f.binding, {
      proposalHash, measurementDefinitionHash, pairId: 'pair-1', useId: f.binding.role === 'candidate' ? 'candidate-use-1' : 'baseline-use-1',
      grantId: f.binding.role === 'candidate' ? grantId : null,
    })
    const capturePair = [capture(baselineFixture), capture(candidateFixture)]
    const useHashes = await Promise.all(capturePair.map(async (captured, index) => {
      for (const [hash, bytes] of captured.artifacts) files.set(hash, Buffer.from(bytes))
      const sealed = await sealCapturedUse(captured, journalAuthority({ authorityId: 'pilot-test-journal-owner' }), journalAbortSignal())
      putRaw(sealed.bytes)
      const independentEvidenceHash = putRaw(Buffer.from(`independent test oracle evidence ${index}`, 'utf8'))
      const role = index === 0 ? 'baseline' : 'candidate'
      const counts = Object.fromEntries(MEASURED_TRIAL_METRICS.map(metric => [metric, {
        numerator: role === 'candidate' && (metric === 'knowledgeUtility' || metric === 'repairReuseSuccess') ? 1 : 0,
        denominator: 1,
      }])) as OpportunityCounts
      const references = [sealed.hash, independentEvidenceHash]
      const receipt = signRecord({
        ...captured.facts,
        oracleIdentityAndResults: {
          producerId: `ark-${role}-fixture`, evaluatorId: authorityId, verificationStatus: 'verified', counts, evidenceRefs: references,
        },
        evidenceArtifactReferences: references,
      })
      return putCanonical(receipt)
    }))
    const countsFor = (role: 'baseline' | 'candidate'): OpportunityCounts => Object.fromEntries(
      MEASURED_TRIAL_METRICS.map(metric => [metric, {
        numerator: role === 'candidate' && (metric === 'knowledgeUtility' || metric === 'repairReuseSuccess') ? 1 : 0,
        denominator: 1,
      }]),
    ) as OpportunityCounts
    const baselineCounts = countsFor('baseline')
    const candidateCounts = countsFor('candidate')
    const trial = signRecord({
      schemaVersion: 1, trialId: 'pilot-trial-1', proposalHash, grantHash, grantId, measurementDefinitionHash,
      orderedUseReceiptHashes: useHashes,
      baselineOpportunityNumeratorsAndDenominators: baselineCounts,
      candidateOpportunityNumeratorsAndDenominators: candidateCounts,
      safetyObservations: Object.fromEntries(['staleRecallRate', 'crossSessionLeakage', 'falseCompletionRate',
        'memoryPrivilegeEscalation', 'memoryPoisoning'].map(metric => [metric, candidateCounts[metric as keyof OpportunityCounts]])),
      issuedAt: time(150_000),
    })
    const trialHash = putCanonical(trial)
    const reader = createKnowledgeWikiMeasuredTrialReader({
      authorityId, publicKey: evaluator.publicKey,
      journalSignerAuthorityId: 'pilot-test-journal-owner', journalSignerPublicKey: journal.publicKey,
      artifacts: { resolveArtifact: hash => files.get(hash) },
    })
    const measured = reader.read(trialHash, {
      reviewHash: proposal.reviewHash, semanticReceiptHash: proposal.semanticReceiptHash,
      candidatePath: proposal.candidatePath, candidateHash, action: 'Promote', targetPath: proposal.targetPath,
      targetBeforeHashOrVerifiedAbsence: 'verified-absence',
    })
    expect(measured).toMatchObject({ eligibleForReview: true, targetAfterHash, successfulUses: 1, retrievalHits: 1 })
  })
})
