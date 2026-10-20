/** A real Loader child retains accepted input across failed pre-step saving. */
import { expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { Session, SessionId, type SessionQuitAttemptId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { JsonlSessionPersistence } from '@deepseek-ai/dsh-session-persistence-jsonl'
import type {} from '@deepseek-ai/dsh-session-title'
import { join } from 'node:path'
import * as Checkpoints from '../../../session/session-checkpoint-policy/src/index.ts'
import { createTeamRuntime } from '../../../subagent/agent-team/tests/runtime.ts'
import { textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { Inbox } from '../../../core/agent/src/inbox.ts'
import { StorageLifecycle } from '../src/storage-lifecycle.ts'

async function recoveryFixture(script: Parameters<typeof createTeamRuntime>[0]) {
  const run = await createTeamRuntime(script)
  const gates = new Map<SessionId, PromiseWithResolvers<undefined>>()
  const failed = new Set<SessionId>()
  run.ctx.on('agent/pre-step', async ({ agent }, next) => {
    if (agent === run.lead) return { kind: 'reject' }
    if (!gates.has(agent.id)) {
      const gate = Promise.withResolvers<undefined>()
      gates.set(agent.id, gate)
      await gate.promise
    }
    return next()
  })
  run.ctx.loader.builtins['storage-recovery-checkpoint'] = Checkpoints
  await run.ctx.loader.create({ name: 'cordis:storage-recovery-checkpoint' })
  await run.ctx.loader.await()
  const owner = run.ctx.sessionPersistence as JsonlSessionPersistence
  const append = owner.appendBatch.bind(owner)
  vi.spyOn(owner, 'appendBatch').mockImplementation(async (...args) => {
    if (failed.has(args[0].id)) throw new Error('synthetic unavailable storage')
    await append(...args)
  })
  return { ...run, owner, failed,
    async park(parent: Agent, original: string) {
      const started = await run.ctx.subagents.startContinuable({ provider: 'spawn', label: 'synthetic recovery child',
        request: { parent, prompt: [{ type: 'text', text: original }] }, signal: new AbortController().signal })
      const child = run.ctx.agents.get(started.childId)
      if (child === undefined) throw new Error('accepted child was not resident')
      await vi.waitFor(() => { expect(gates.has(child.id)).toBe(true) })
      failed.add(child.id)
      // The accepted input is durable; a pending rename makes the next save fail.
      child.session.append('session/title', { title: 'synthetic pending rename', messageSeqs: [], source: { kind: 'user' } })
      const gate = gates.get(child.id)
      if (gate === undefined) throw new Error('child preparation gate was not installed')
      gate.resolve(undefined)
      await child.whenIdle()
      return { started, child }
    },
    async dispose() {
      failed.clear()
      for (const gate of gates.values()) gate.resolve(undefined)
      await run.dispose()
    },
  }
}

async function coldInbox(root: string, ids: readonly SessionId[]) {
  const ctx = new Context()
  try {
    await ctx.plugin(Loader)
    Object.assign(ctx.loader.builtins, { 'cold-sessions': SessionStore, 'cold-persistence': JsonlPersistence })
    await ctx.loader.create({ name: 'cordis:cold-sessions' })
    await ctx.loader.create({ name: 'cordis:cold-persistence', config: { root: join(root, 'sessions'), compression: 'none' } })
    await ctx.loader.await()
    return await Promise.all(ids.map(async (id) => {
      const loaded = await ctx.sessionPersistence.load(id)
      const session = Session.create(id, loaded.events, loaded.meta)
      const inbox = new Inbox(session, { claimed() {}, discarded() {}, inserted() {} })
      return { id, queued: [...inbox.nextTurn, ...inbox.nextStep].map(message => message.id),
        users: session.events.flatMap(event => event.type === 'user/message' ? [event.data.id] : []) }
    }))
  } finally { await ctx.fiber.dispose() }
}

it('parks a continuable child after failed saving and executes retained input once after explicit continuation', async () => {
  const run = await recoveryFixture([textResponse('original completed'), textResponse('explicit continuation completed')])
  const original = 'SYNTHETIC_INPUT_RETAINED_DURING_STORAGE_FAILURE'
  const owner = run.owner
  try {
    const { child, started } = await run.park(run.lead, original)
    expect(child.status).toBe('idle')
    expect(run.ctx.agents.get(started.childId)).toBe(child)
    expect(child.inbox.nextTurn.map(message => message.id)).toEqual([started.messageId])
    expect(child.session.events.some(event => event.type === 'step/start' || event.type === 'user/message')).toBe(false)
    expect(owner.writeState(child.session).phase).toBe('failed')
    expect(run.adapter.requests).toHaveLength(0)
    await new Promise((resolve) => { setTimeout(resolve, 80) })
    expect(child.status).toBe('idle')
    expect(child.inbox.nextTurn.map(message => message.id)).toEqual([started.messageId])
    expect(run.adapter.requests).toHaveLength(0)

    run.failed.clear()
    await owner.flushAll()
    expect(owner.writeState(child.session).phase).toBe('healthy')
    expect(child.status).toBe('idle')
    expect(child.inbox.nextTurn.map(message => message.id)).toEqual([started.messageId])
    expect(run.adapter.requests).toHaveLength(0)
    const continued = await run.ctx.subagents.followup(run.lead, child.id,
      [{ type: 'text', text: 'Explicitly continue the retained work.' }],
      { source: { kind: 'user' }, signal: new AbortController().signal })
    await child.whenIdle()
    await vi.waitFor(() => { expect(run.ctx.agents.get(child.id)).toBeUndefined() })
    const stored = await owner.load(child.id)
    const accepted = stored.events.flatMap(event => event.type === 'user/message' && event.data.source.kind !== 'plugin'
      ? [event.data] : [])
    expect(accepted.map(message => message.id)).toEqual([started.messageId, continued])
    expect(accepted[0]?.content).toEqual([{ type: 'text', text: original }])
    expect(child.inbox.hasPending).toBe(false)
    expect(run.adapter.requests).toHaveLength(2)
    expect(stored.events.filter(event => event.type === 'turn/end' && event.data.reason.kind === 'aborted')).toHaveLength(1)
    expect(stored.events.filter(event => event.type === 'turn/end' && event.data.reason.kind === 'completed')).toHaveLength(2)
  } finally {
    await run.dispose()
  }
})

it('preserves accepted pending input through Host readiness, complete Loader stop and a fresh cold reader', async () => {
  const run = await recoveryFixture([])
  try {
    const first = await run.park(run.lead, 'SYNTHETIC_PENDING_CHILD_AT_EXIT')
    const nested = await run.park(first.child, 'SYNTHETIC_PENDING_GRANDCHILD_AT_EXIT')
    const registry = run.ctx.agents
    expect(first.child.status).toBe('idle')
    expect(nested.child.status).toBe('idle')
    run.failed.clear()
    const storage = new StorageLifecycle(run.ctx)
    storage.handle({ kind: 'prepare-quit', attemptId: 'synthetic-pending-exit' as SessionQuitAttemptId, epoch: 0 })
    await vi.waitFor(() => { expect(storage.handle({ kind: 'state' }).quit?.safeToQuit).toBe(true) })
    expect(run.owner.writeState().totalEvents).toBe(0)
    await run.ctx.fiber.dispose()
    expect(registry.list()).toEqual([])
    expect(run.adapter.requests).toHaveLength(0)
    expect(await coldInbox(run.root, [first.child.id, nested.child.id])).toEqual([
      { id: first.child.id, queued: [first.started.messageId], users: [] },
      { id: nested.child.id, queued: [nested.started.messageId], users: [] },
    ])
  } finally { await run.dispose() }
})

it('preserves a pending descendant forest when its exact Host parent leaves', async () => {
  const run = await recoveryFixture([])
  try {
    const first = await run.park(run.lead, 'SYNTHETIC_PENDING_SCOPED_CHILD')
    const nested = await run.park(first.child, 'SYNTHETIC_PENDING_SCOPED_GRANDCHILD')
    run.failed.clear()
    await run.owner.flushAll()
    await run.ctx.subagents.drainContinuableDescendants([run.lead])
    expect(run.ctx.agents.get(first.child.id)).toBeUndefined()
    expect(run.ctx.agents.get(nested.child.id)).toBeUndefined()
    expect(run.ctx.agents.get(run.lead.id)).toBe(run.lead)
    await run.owner.flushAll()
    const stored = await coldInbox(run.root, [first.child.id, nested.child.id])
    for (const [index, original] of [first.started.messageId, nested.started.messageId].entries()) {
      expect(stored[index]?.queued.filter(id => id === original)).toHaveLength(1)
      expect(stored[index]?.users).not.toContain(original)
    }
    expect(run.adapter.requests).toHaveLength(0)
  } finally { await run.dispose() }
})

it.each(['owner-scope', 'explicit-handle'] as const)('distinguishes %s disposal of a saved pending Agent', async (teardown) => {
  const run = await recoveryFixture([])
  try {
    const scope = await run.ctx.plugin({ name: 'pending-agent-owner', inject: ['agents'], apply() {} })
    const handle = await scope.ctx.agents.create({ sessionId: SessionId('synthetic-owned-pending'),
      agentOptions: { provider: 'mock', model: 'mock' } })
    const message = createUserMessage({ content: [{ type: 'text', text: 'SYNTHETIC_SAVED_PENDING_INPUT' }], source: { kind: 'user' } })
    handle.agent.send(message, 'next-turn', false)
    await run.ctx.sessions.flush(handle.agent.session)
    if (teardown === 'owner-scope') await scope.dispose()
    else await handle.dispose()
    expect(run.ctx.agents.get(handle.agent.id)).toBeUndefined()
    await run.owner.flushAll()
    expect(await coldInbox(run.root, [handle.agent.id])).toEqual([
      { id: handle.agent.id, queued: teardown === 'owner-scope' ? [message.id] : [], users: [] },
    ])
    expect(run.adapter.requests).toHaveLength(0)
  } finally { await run.dispose() }
})

it('keeps explicit selected-child release destructive for that complete forest', async () => {
  const run = await recoveryFixture([])
  try {
    const first = await run.park(run.lead, 'SYNTHETIC_DISCARDED_CHILD')
    const nested = await run.park(first.child, 'SYNTHETIC_DISCARDED_GRANDCHILD')
    run.failed.clear()
    await run.owner.flushAll()
    await run.ctx.subagents.drainContinuableChildren(run.lead, [first.child.id])
    expect(run.ctx.agents.get(first.child.id)).toBeUndefined()
    expect(run.ctx.agents.get(nested.child.id)).toBeUndefined()
    await run.owner.flushAll()
    expect(await coldInbox(run.root, [first.child.id, nested.child.id])).toEqual([
      { id: first.child.id, queued: [], users: [] },
      { id: nested.child.id, queued: [], users: [] },
    ])
    expect(run.adapter.requests).toHaveLength(0)
  } finally { await run.dispose() }
})
