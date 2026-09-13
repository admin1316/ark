/** Ordinary retry admission through the real Loader, AgentLoop and JSONL owner. */
import { expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { installPromptReceipts } from '../src/prompt-receipts.ts'
import { Session, SessionId, SessionPromptInvocationId } from '@deepseek-ai/dsh-session'
import type { SessionRemotePromptRequest } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model'
import { createTeamRuntime } from '../../../subagent/agent-team/tests/runtime.ts'
import { textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import SessionRemoteOperationsService from '../src/index.ts'

async function fixture(mode: 'queue' | 'steer' = 'queue') {
  const run = await createTeamRuntime(Array.from({ length: 12 }, () => textResponse('synthetic result')))
  run.ctx.provide('attachments', { imageLimits: {
    maxImageBytes: 1024, maxImagesPerMessage: 4, maxMessageImageBytes: 4096,
    maxImagePixels: 1024, maxImageDimension: 32, mediaTypes: ['image/png'],
  } } as never)
  run.ctx.provide('workspaceRegistry', {
    sessionAdmissionRevision: () => 0, assertSessionAdmission: () => {},
  } as never)
  Object.assign(run.ctx.loader.builtins, {
    'retry-projections': SessionProjectionRegistry,
    'retry-default-model': AgentDefaultModelConfig,
    'retry-host-session': SessionRemoteOperationsService,
  })
  await run.ctx.loader.create({ name: 'cordis:retry-projections' })
  await run.ctx.loader.create({ name: 'cordis:retry-default-model', config: { provider: 'mock', model: 'mock' } })
  await run.ctx.loader.create({ name: 'cordis:retry-host-session' })
  await run.ctx.loader.await()
  const handle = await run.ctx.agents.create({ sessionId: SessionId('ordinary'), agentOptions: { provider: 'mock', model: 'mock' } })
  const request: SessionRemotePromptRequest = {
    sessionId: handle.agent.id, invocationId: SessionPromptInvocationId('same-ordinary-invocation'),
    mode, content: [{ type: 'text', text: 'synthetic ordinary request' }],
  }
  const operations = run.ctx.get('sessionRemoteOperations')
  if (operations === undefined) throw new Error('test Host session service did not initialize')
  const submit = (input = request, signal = new AbortController().signal) => operations.prompt(input, signal)
  return { ...run, handle, request, submit }
}

function acceptedIds(session: Session): Set<string> {
  return new Set(session.events.flatMap(event => event.type === 'agent/inbox/spliced' ? event.data.inserted : [])
    .filter(message => message.source.kind === 'user' && 'invocationId' in message.source)
    .map(message => message.id))
}

for (const mode of ['queue', 'steer'] as const) {
  it(`does not duplicate an ordinary ${mode} invocation after an uncertain response`, async () => {
    const run = await fixture(mode)
    try {
      expect(await run.submit()).toEqual({ ok: true, value: { accepted: true } })
      expect(await run.submit()).toEqual({ ok: true, value: { accepted: true } })
      await run.handle.agent.whenIdle()
      await run.ctx.sessions.flush(run.handle.agent.session)
      const stored = await run.ctx.sessionPersistence.inspect(run.handle.agent.id)
      const restored = Session.create(stored.meta.id, stored.events, stored.meta)
      expect(acceptedIds(restored).size).toBe(1)
    } finally { await run.dispose() }
  })
}

it('joins concurrent retries and rejects changed content, mode or timezone without another model request', async () => {
  const run = await fixture()
  try {
    expect(await Promise.all([run.submit(), run.submit(), run.submit()]))
      .toEqual(Array.from({ length: 3 }, () => ({ ok: true, value: { accepted: true } })))
    await run.handle.agent.whenIdle()
    const requestCount = run.adapter.requests.length
    for (const changed of [
      { ...run.request, content: [{ type: 'text' as const, text: 'different request' }] },
      { ...run.request, mode: 'steer' as const },
      { ...run.request, clientTimeZone: 'UTC' },
    ]) {
      expect(await run.submit(changed)).toMatchObject({ ok: false, error: { code: 'invocation-conflict' } })
    }
    vi.spyOn(run.ctx.llm, 'listProviders').mockReturnValue([])
    expect(await run.submit()).toEqual({ ok: true, value: { accepted: true } })
    expect(acceptedIds(run.handle.agent.session).size).toBe(1)
    expect(run.adapter.requests).toHaveLength(requestCount)
  } finally { await run.dispose() }
})

it('confirms an already durable cold retry without resuming an Agent or requiring its provider', async () => {
  const run = await fixture()
  try {
    expect(await run.submit()).toMatchObject({ ok: true })
    await run.handle.agent.whenIdle()
    await run.handle.dispose({ keepInbox: true })
    expect(run.ctx.sessions.get(run.request.sessionId)).toBeUndefined()
    const resume = vi.spyOn(run.ctx.agents, 'resume')
    const requestCount = run.adapter.requests.length
    vi.spyOn(run.ctx.llm, 'listProviders').mockReturnValue([])
    expect(await run.submit()).toEqual({ ok: true, value: { accepted: true } })
    expect(resume).not.toHaveBeenCalled()
    expect(run.ctx.agents.get(run.request.sessionId)).toBeUndefined()
    expect(run.adapter.requests).toHaveLength(requestCount)
  } finally { await run.dispose() }
})

it('retains acceptance after a failed durability barrier and retries confirmation without re-enqueueing', async () => {
  const run = await fixture()
  try {
    const materialize = vi.spyOn(run.ctx.sessionPersistence, 'ensureMaterialized').mockRejectedValueOnce(new Error('synthetic fsync failure'))
    expect(await run.submit()).toMatchObject({ ok: false, error: {
      code: 'prompt-durability-unconfirmed', details: { accepted: true, invocationId: run.request.invocationId },
    } })
    expect(acceptedIds(run.handle.agent.session).size).toBe(1)
    expect(await run.submit()).toEqual({ ok: true, value: { accepted: true } })
    expect(materialize).toHaveBeenCalledTimes(2)
    expect(acceptedIds(run.handle.agent.session).size).toBe(1)
  } finally { await run.dispose() }
})

it('cancels before commit but confirms durable acceptance if cancellation arrives from the committed splice', async () => {
  const run = await fixture()
  try {
    const before = new AbortController()
    before.abort()
    expect(await run.submit(run.request, before.signal)).toMatchObject({ ok: false, error: { code: 'cancelled' } })
    expect(acceptedIds(run.handle.agent.session).size).toBe(0)
    const after = new AbortController()
    const remove = run.ctx.on('session/event', (session, event) => {
      if (session.id === run.request.sessionId && event.type === 'agent/inbox/spliced' && event.data.inserted.length > 0) after.abort()
    })
    expect(await run.submit(run.request, after.signal)).toEqual({ ok: true, value: { accepted: true } })
    remove()
    expect(after.signal.aborted).toBe(true)
    expect(await run.submit()).toEqual({ ok: true, value: { accepted: true } })
    expect(acceptedIds(run.handle.agent.session).size).toBe(1)
  } finally { await run.dispose() }
})

it('advances receipt projection only over the unread suffix and excludes inherited fork identities', async () => {
  const run = await fixture()
  try {
    expect(await run.submit()).toMatchObject({ ok: true })
    await run.handle.agent.whenIdle()
    const original = run.handle.agent.session
    const parentEvents = original.events
    const child = Session.create(SessionId('receipt-fork'), parentEvents, {
      ...original.header, id: SessionId('receipt-fork'), seedLength: parentEvents.length,
    })
    expect(run.ctx.sessionProjections.stateOf(child, 'promptReceipts')?.entries).toEqual({})
    const reads = vi.spyOn(original, 'eventAt')
    const state = run.ctx.sessionProjections.stateOf(original, 'promptReceipts')
    reads.mockClear()
    for (let index = 0; index < 10; index++) expect(run.ctx.sessionProjections.stateOf(original, 'promptReceipts')).toBe(state)
    expect(reads).not.toHaveBeenCalled()
    expect(JSON.stringify(state).length).toBeLessThan(512)
    expect(run.ctx.sessionProjections.snapshot(original).values).not.toHaveProperty('promptReceipts')
  } finally { await run.dispose() }
})


it('removes the host-only receipt registration when its owning plugin unloads', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SessionProjectionRegistry)
    const owner = ctx.plugin({ inject: ['sessionProjections'], apply: installPromptReceipts })
    await owner
    const session = Session.create(SessionId('receipt-registration'), undefined, {
      id: SessionId('receipt-registration'), version: 0, createdAt: 1,
    })
    expect(ctx.sessionProjections.stateOf(session, 'promptReceipts')).toEqual({ seedLength: 0, entries: {} })
    await owner.dispose()
    expect(ctx.sessionProjections.stateOf(session, 'promptReceipts')).toBeUndefined()
  } finally { await ctx.fiber.dispose() }
})
