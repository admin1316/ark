/** Real Loader, AgentLoop and JSONL; only model output and disk latency are synthetic. */
import { expect, it, vi } from 'vitest'
import { createUserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionQuitAttemptId } from '@deepseek-ai/dsh-session'
import type { JsonlSessionPersistence } from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as checkpoints from '../../../session/session-checkpoint-policy/src/index.ts'
import { createTeamRuntime } from '../../../subagent/agent-team/tests/runtime.ts'
import { StorageLifecycle } from '../src/storage-lifecycle.ts'

async function fixture(waitTimeoutMs = 30000) {
  const text = 'x'.repeat(2 * 1024 * 1024)
  const script: StreamChunk[] = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'text-delta', index: 0, text: 'must wait' },
    { type: 'block-end', index: 0, block: { type: 'text', text: text + 'must wait' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const run = await createTeamRuntime([script], { sessionHighBytes: 1024 * 1024, sessionLowBytes: 512 * 1024,
    totalHighBytes: 8 * 1024 * 1024, totalLowBytes: 4 * 1024 * 1024, waitTimeoutMs })
  run.ctx.loader.builtins['pressure-checkpoint'] = checkpoints
  await run.ctx.loader.create({ name: 'cordis:pressure-checkpoint' }); await run.ctx.loader.await()
  const handle = await run.ctx.agents.create({ sessionId: SessionId('pressure-owner'), agentOptions: { provider: 'mock', model: 'mock' } })
  const owner = run.ctx.sessionPersistence as JsonlSessionPersistence
  const append = owner.appendBatch.bind(owner)
  const gate = Promise.withResolvers<undefined>()
  let block = false
  run.ctx.on('session/event', (session, event) => { if (session === handle.agent.session && event.type === 'assistant/chunk') block = true })
  vi.spyOn(owner, 'appendBatch').mockImplementation(async (...args) => { if (block) await gate.promise; await append(...args) })
  const storage = new StorageLifecycle(run.ctx)
  handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'synthetic bounded stream' }], source: { kind: 'user' } }))
  await vi.waitFor(() => {
    expect(handle.agent.session.events.filter(event => event.type === 'assistant/chunk')).toHaveLength(2)
    expect(owner.writeState(handle.agent.session).phase).toBe('pressured')
  })
  return { ...run, handle, owner, storage, gate }
}

it('pauses the next canonical chunk and waits for real saving before quit readiness', async () => {
  const run = await fixture()
  try {
    expect(run.handle.agent.session.events.filter(event => event.type === 'assistant/chunk')).toHaveLength(2)
    expect(() =>{  run.storage.assertAdmission(run.handle.agent.session) }).toThrow('storage-busy')
    const attemptId = 'synthetic-quit-one' as SessionQuitAttemptId
    const quitting = run.storage.handle({ kind: 'prepare-quit', attemptId, epoch: 0 })
    expect(quitting.quit?.safeToQuit).toBe(false)
    await vi.waitFor(() =>{  expect(run.storage.handle({ kind: 'state' }).quit?.phase).toBe('saving') })
    expect(run.owner.writeState(run.handle.agent.session).events).toBeGreaterThan(0)
    expect(() =>{  run.storage.assertAdmission() }).toThrow('storage-closing')
    run.gate.resolve(undefined)
    await vi.waitFor(() =>{  expect(run.storage.handle({ kind: 'state' }).quit?.safeToQuit).toBe(true) })
    expect(run.owner.writeState().totalEvents).toBe(0)
    expect(run.handle.agent.session.events.some(event => event.type === 'assistant/message' && event.data.interrupted)).toBe(true)
    const stored = await run.owner.inspect(run.handle.agent.id)
    expect(stored.events.map(event => event.seq)).toEqual(Array.from({ length: stored.events.length }, (_, i) => i))
  } finally { run.gate.resolve(undefined); await run.handle.dispose({ keepInbox: true }); await run.dispose() }
})

it('cancels a quit observer without cancelling the writer or accepting a late ready result', async () => {
  const run = await fixture()
  try {
    const attemptId = 'synthetic-cancel-quit' as SessionQuitAttemptId
    run.storage.handle({ kind: 'prepare-quit', attemptId, epoch: 0 })
    await vi.waitFor(() =>{  expect(run.storage.handle({ kind: 'state' }).quit?.phase).toBe('saving') })
    expect(run.storage.handle({ kind: 'cancel-quit', attemptId, epoch: 0 }).quit).toBeNull()
    expect(run.storage.handle({ kind: 'cancel-quit', attemptId, epoch: 0 }).quit).toBeNull()
    expect(run.storage.handle({ kind: 'prepare-quit', attemptId, epoch: 0 }).quit).toBeNull()
    expect(run.owner.writeState().totalEvents).toBeGreaterThan(0)
    run.gate.resolve(undefined)
    await run.ctx.sessions.flush(run.handle.agent.session)
    expect(run.storage.handle({ kind: 'state' }).quit).toBeNull()
    expect(run.owner.writeState().totalEvents).toBe(0)
  } finally { run.gate.resolve(undefined); await run.handle.dispose({ keepInbox: true }); await run.dispose() }
})


it('cancels a stalled stream at the configured deadline without cancelling its writer', async () => {
  const run = await fixture(250)
  try {
    await run.handle.agent.whenIdle()
    expect(run.handle.agent.session.events.filter(event => event.type === 'assistant/chunk')).toHaveLength(2)
    expect(run.handle.agent.session.events.some(event => event.type === 'assistant/message' && event.data.interrupted)).toBe(true)
    expect(run.owner.writeState(run.handle.agent.session)).toMatchObject({ phase: 'failed', errorCode: 'storage-stalled' })
    expect(run.owner.writeState().totalEvents).toBeGreaterThan(0)
    run.gate.resolve(undefined)
    await run.ctx.sessions.flush(run.handle.agent.session)
    expect(run.owner.writeState(run.handle.agent.session).phase).toBe('healthy')
  } finally { run.gate.resolve(undefined); await run.handle.dispose({ keepInbox: true }); await run.dispose() }
})

it('ignores arbitrary old quit epochs across two cancelled attempts', async () => {
  const run = await fixture()
  try {
    const first = 'synthetic-first' as SessionQuitAttemptId
    const second = 'synthetic-second' as SessionQuitAttemptId
    run.storage.handle({ kind: 'prepare-quit', attemptId: first, epoch: 0 })
    expect(run.storage.handle({ kind: 'cancel-quit', attemptId: first, epoch: 0 }).quitEpoch).toBe(1)
    run.storage.handle({ kind: 'prepare-quit', attemptId: second, epoch: 1 })
    expect(run.storage.handle({ kind: 'cancel-quit', attemptId: second, epoch: 1 }).quitEpoch).toBe(2)
    expect(run.storage.handle({ kind: 'prepare-quit', attemptId: first, epoch: 0 })).toMatchObject({ quitEpoch: 2, quit: null })
    expect(run.storage.handle({ kind: 'cancel-quit', attemptId: first, epoch: 0 })).toMatchObject({ quitEpoch: 2, quit: null })
    expect(() => run.storage.handle({ kind: 'prepare-quit', attemptId: first, epoch: 3 })).toThrow('epoch')
    run.gate.resolve(undefined)
    await run.owner.flushAll()
    expect(run.storage.handle({ kind: 'state' }).quit).toBeNull()
  } finally { run.gate.resolve(undefined); await run.handle.dispose({ keepInbox: true }); await run.dispose() }
})

it('vetoes an Agent prepared before quit when its asynchronous setup finishes after ready', async () => {
  const run = await createTeamRuntime([])
  const storage = new StorageLifecycle(run.ctx)
  const setupStarted = Promise.withResolvers<undefined>()
  const releaseSetup = Promise.withResolvers<undefined>()
  const creating = run.ctx.agents.create({ sessionId: SessionId('late-child'), setup: async () => {
    setupStarted.resolve(undefined)
    await releaseSetup.promise
  } })
  const rejected = expect(creating).rejects.toThrow('storage-closing')
  try {
    await setupStarted.promise
    storage.handle({ kind: 'prepare-quit', attemptId: 'synthetic-late' as SessionQuitAttemptId, epoch: 0 })
    await vi.waitFor(() =>{  expect(storage.handle({ kind: 'state' }).quit?.safeToQuit).toBe(true) })
    releaseSetup.resolve(undefined)
    await rejected
    expect(run.ctx.agents.get(SessionId('late-child'))).toBeUndefined()
    expect(run.ctx.sessions.get(SessionId('late-child'))).toBeUndefined()
    expect((await run.ctx.sessionPersistence.list()).some(meta => meta.id === 'late-child')).toBe(false)
    expect(run.ctx.sessionPersistence.writeState().totalEvents).toBe(0)
  } finally { releaseSetup.resolve(undefined); await creating.catch(() => {}); await run.dispose() }
})

it('waits for real settlement of a live child outside the Host handle map', async () => {
  const run = await createTeamRuntime([])
  const storage = new StorageLifecycle(run.ctx)
  const child = await run.lead.ctx.agents.create({ sessionId: SessionId('resident-child') })
  const release = Promise.withResolvers<undefined>()
  let cancelled = false
  const maintenance = child.agent.runMaintenance(async (signal) => {
    signal.addEventListener('abort', () => { cancelled = true }, { once: true })
    await release.promise
  })
  try {
    storage.handle({ kind: 'prepare-quit', attemptId: 'synthetic-tree' as SessionQuitAttemptId, epoch: 0 })
    expect(cancelled).toBe(true)
    expect(storage.handle({ kind: 'state' }).quit).toMatchObject({ phase: 'stopping', safeToQuit: false })
    release.resolve(undefined)
    await maintenance
    await vi.waitFor(() =>{  expect(storage.handle({ kind: 'state' }).quit?.safeToQuit).toBe(true) })
  } finally { release.resolve(undefined); await maintenance; await child.dispose({ keepInbox: true }); await run.dispose() }
})
