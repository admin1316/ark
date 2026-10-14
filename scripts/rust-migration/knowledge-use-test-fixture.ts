/** Shared synthetic saved-provider fixtures; no actual model utility is claimed. */
import { generateKeyPairSync, sign } from 'node:crypto'
import { BlockAssembler, CallId, MessageId, createMessage, type ContentBlock, type StreamChunk,
  type ToolResultBlock } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { canonicalJson, sha256 } from '../../packages/host/knowledge-wiki/src/verifier.ts'
import type { KnowledgeUseBinding } from './knowledge-session-use.ts'

export const project = '/isolated/pilot-project'
export const config = { provider: 'pilot-fixture', model: 'pilot-model' }
const retryOwner = generateKeyPairSync('ed25519')

export function retryDocument(f: { events: SessionEvent[]; snapshot: Buffer; binding: KnowledgeUseBinding }) {
  return { schemaVersion: 1, kind: 'same-arguments-failed-parent-retry-v1', authorityId: 'pilot-test:retry-owner',
    sessionId: f.binding.sessionId, turn: f.binding.turn, snapshotHash: sha256(f.snapshot), taskHash: sha256(f.binding.task),
    calls: f.events.filter(event => event.type === 'tool/call').map((call) => {
      const result = f.events.find(event => event.type === 'tool/result' && event.data.message.source.callId === call.data.callId)
      if (result === undefined) throw new Error('retry fixture lacks its original tool result')
      return { callId: String(call.data.callId), callSeq: call.seq, resultSeq: result.seq, resultHash: sha256(canonicalJson(result)),
        argumentsHash: sha256(canonicalJson(JSON.parse(call.data.arguments) as unknown)), name: call.data.name,
        failed: call.data.callId === 'first-bash', retryOf: call.data.callId === 'second-bash' ? 'first-bash' : null as string | null }
    }) }
}

export function signedRetry(f: Parameters<typeof retryDocument>[0], mutate = (_doc: ReturnType<typeof retryDocument>) => {},
  keys = retryOwner) {
  const doc = retryDocument(f)
  mutate(doc)
  return { authorityId: 'pilot-test:retry-owner', publicKey: keys.publicKey,
    artifactBytes: Buffer.from(canonicalJson({ ...doc, proof: sign(null, Buffer.from(canonicalJson(doc)),
      keys.privateKey).toString('base64') })) }
}

export function scenario(options: {
  candidate?: boolean
  noHeaderExtras?: boolean
  actualTaskTool?: { arguments: string; result: string }
  compactTaskStep?: boolean
  errorsAndRepeat?: boolean
  explicitErrors?: boolean
  shellError?: boolean
  retrySecond?: { name: string; arguments: string }
  reusedParent?: boolean
  reasoning?: boolean
  noCost?: boolean
  repeatPolicy?: boolean
  sessionId?: string
  timeOffset?: number
  output?: string
  projectRoot?: string
} = {}) {
  const sessionId = options.sessionId ?? 'pilot-session'
  const projectRoot = options.projectRoot ?? project
  const session = Session.create(SessionId(sessionId), undefined, { version: 0, id: SessionId(sessionId), createdAt: 10, cwd: projectRoot })
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
    session.append('assistant/message', { turn: 1, step, message: createMessage({ role: 'assistant', content: assembler.blocks(),
      source: { kind: 'model', ...config } }), usage }, { surfaceOp: 'append', sourceEventSeqs: seqs })
  }
  const call = (id: string, name: string, content: ContentBlock[], isError = false, args = '{"path":"concepts/fixed-rule.md"}', visibleOutput?: string) => {
    const callId = CallId(id)
    model([{ type: 'tool-call', id: callId, name, arguments: args }, ...(visibleOutput === undefined ? [] : [{ type: 'text' as const, text: visibleOutput }])])
    session.append('tool/call', { turn: 1, step, callId, name, arguments: args })
    return () => {
      const resultContent: [ToolResultBlock] = [{ type: 'tool-result', toolCallId: callId, content, isError }]
      session.append('tool/result', { turn: 1, step, message: createMessage({ role: 'user', source: { kind: 'tool', callId },
        content: resultContent }) }, { surfaceOp: 'append' })
      session.append('step/end', { turn: 1, step })
    }
  }
  start()
  session.append('user/message', { role: 'user', id: MessageId('pilot-input'), content: [{ type: 'text', text: 'registered task' }],
    source: { kind: 'user' } }, { surfaceOp: 'append' })
  if (options.repeatPolicy) session.append('sandbox/mode', { mode: 'read-only' })
  session.append('request/header', { reason: 'initial', header: { config,
    ...(options.noHeaderExtras ? {} : { system: 'fixed system', tools: [{ name: 'wiki_read', description: 'Read scoped knowledge',
      parameters: { type: 'object' } }] }) } })
  const sourcePage = 'Frozen rule; not a prior answer.'
  const rendered: ContentBlock[] = [{ type: 'text', text: '# concepts/fixed-rule.md\n\nFrozen rule; not a prior answer.' }]
  const sourceContentHash = sha256(sourcePage)
  if (options.candidate) {
    const finishCall = call('wiki-call', 'wiki_read', rendered)
    const common = { knowledgeId: 'wiki:concepts/fixed-rule.md', path: 'concepts/fixed-rule.md',
      resultHash: sha256(JSON.stringify(rendered)), contentHash: sha256(JSON.stringify(rendered)), sourceContentHash,
      tool: 'wiki_read', callId: 'wiki-call', scope: { sessionId, projectId: projectRoot, workspaceId: projectRoot },
      verificationStatus: 'verified' as const }
    session.append('knowledge/retrieved', { ...common, kind: 'page', allowed: true, reason: 'ok' })
    session.append('knowledge/injected', { ...common, kind: 'page', value: rendered as never,
      contentBytes: Buffer.byteLength(JSON.stringify(rendered)) })
    finishCall()
    start()
  }
  if (options.actualTaskTool !== undefined) {
    call('actual-task-bash', 'bash', [{ type: 'text', text: options.actualTaskTool.result }], false, options.actualTaskTool.arguments, options.compactTaskStep ? options.output ?? 'SUM=23' : undefined)()
    if (!options.compactTaskStep) start()
  }
  if (options.errorsAndRepeat) {
    call('first-bash', 'bash', [{ type: 'text', text: options.shellError
      ? 'first command failed\n[exit code: 1]' : 'first command failed' }], options.shellError !== true)()
    start()
    call('second-bash', options.retrySecond?.name ?? 'bash', [{ type: 'text', text: 'retry succeeded' }], options.explicitErrors ?? false,
      options.retrySecond?.arguments)()
    start()
    if (options.reusedParent) { call('third-bash', 'bash', [{ type: 'text', text: 'another succeeded' }])(); start() }
  }
  if (!options.compactTaskStep) {
    model([...(options.reasoning ? [{ type: 'reasoning' as const, text: 'private reasoning' }] : []), { type: 'text',
      text: options.output ?? 'SUM=23' }])
    session.append('step/end', { turn: 1, step })
  }
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const binding: KnowledgeUseBinding = {
    useId: 'use-1', sessionId: String(session.id), projectRoot, turn: 1, role: options.candidate ? 'candidate' : 'baseline',
    pairId: 'pair-1', grantId: options.candidate ? 'grant-1' : null, proposalHash: sha256('proposal'),
    measurementDefinitionHash: sha256('definition'),
    sourceIdentity: { commit: 'a'.repeat(40), sourceDigest: sha256('source'), dirty: true, dirtyDigest: sha256('dirty'),
      buildDigest: sha256('build') },
    profileIdentity: 'isolated-test-profile', buildIdentity: sha256('build'), config, task: 'registered task',
    goalHash: sha256('goal'), policyHash: sha256('policy'),
    permissions: { 'permission/preset': { preset: 'read-only' }, 'sandbox/mode': { mode: 'read-only' },
      'approval/policy': { policy: 'ask' } },
    knowledge: options.candidate ? { id: 'wiki:concepts/fixed-rule.md', sourceContentHash, rendered } : null,
    cost: options.noCost ? null : { microunits: 17, artifactBytes: Buffer.from('independent test cost evidence') },
  }
  const events = [...structuredClone(session.events)]
  if (options.timeOffset !== undefined) for (const item of events) Object.assign(item, { time: item.time + options.timeOffset })
  const metadata = structuredClone(session.header)
  const snapshot = Buffer.from(canonicalJson({ metadata, events }))
  if (options.errorsAndRepeat && !options.explicitErrors) {
    Object.assign(binding, { retryEvidence: signedRetry({ events, snapshot, binding }) })
  }
  return { metadata, events, snapshot, binding }
}
