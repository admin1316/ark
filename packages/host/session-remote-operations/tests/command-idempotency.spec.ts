/** Durable human-command retries through Loader, the real Agent and JSONL persistence. */
import { expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { appendFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SessionId, SessionPromptInvocationId, type SessionRemoteCommandRequest } from '@deepseek-ai/dsh-session'
import Commands, { CommandId, commandDigest } from '@deepseek-ai/dsh-commands'
import Projections from '@deepseek-ai/dsh-session-projection'
import DefaultModel from '@deepseek-ai/dsh-agent-default-model'
import { createTeamRuntime } from '../../../subagent/agent-team/tests/runtime.ts'
import { textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import Operations from '../src/index.ts'

async function fixture() {
  const run = await createTeamRuntime([textResponse('synthetic model output')])
  run.ctx.provide('attachments', { imageLimits: {
    maxImageBytes: 1024, maxImagesPerMessage: 4, maxMessageImageBytes: 4096,
    maxImagePixels: 1024, maxImageDimension: 32, mediaTypes: ['image/png'],
  } } as never)
  run.ctx.provide('workspaceRegistry', { sessionAdmissionRevision: () => 0, assertSessionAdmission: () => {} } as never)
  Object.assign(run.ctx.loader.builtins, {
    'command-retry-projections': Projections, 'command-retry-default-model': DefaultModel,
    'command-retry-commands': Commands, 'command-retry-host': Operations,
  })
  await run.ctx.loader.create({ name: 'cordis:command-retry-projections' })
  await run.ctx.loader.create({ name: 'cordis:command-retry-default-model', config: { provider: 'mock', model: 'mock' } })
  await run.ctx.loader.create({ name: 'cordis:command-retry-commands' })
  await run.ctx.loader.create({ name: 'cordis:command-retry-host' })
  await run.ctx.loader.await()
  const handle = await run.ctx.agents.create({ sessionId: SessionId('command-retry'), agentOptions: { provider: 'mock', model: 'mock' } })
  const request: SessionRemoteCommandRequest = {
    sessionId: handle.agent.id, invocationId: SessionPromptInvocationId('synthetic-command-invocation'), line: '/record example', images: [],
  }
  const operations = run.ctx.get('sessionRemoteOperations')
  if (operations === undefined) throw new Error('Host command operations did not initialize')
  const submit = (input = request, signal = new AbortController().signal) => operations.command(input, signal)
  return { ...run, handle, request, submit, operations }
}

it('replays a keyless assembled command transcript with one durable filesystem effect', async () => {
  const run = await fixture()
  try {
    const effect = join(run.root, 'synthetic-effect.txt')
    run.ctx.commands.register({ name: 'record', description: 'Append one synthetic effect', handler: async () => {
      await appendFile(effect, 'synthetic effect\n', { mode: 0o600 })
      return { kind: 'success', text: 'synthetic effect saved' }
    } })
    const original = await run.submit()
    expect(original).toMatchObject({ ok: true, value: { state: 'completed' } })
    const events = run.handle.agent.session.events.filter(event => event.type.startsWith('command/'))
      .map(event => ({ type: event.type, data: event.data }))
    await run.handle.dispose({ keepInbox: true })
    const repeated = await run.submit()
    const commandId = original.ok ? original.value.commandId : ''
    const transcript = JSON.stringify({ original, repeated, events,
      filesystemEffect: await readFile(effect, 'utf8'), modelRequests: run.adapter.requests.length }, null, 2)
      .replaceAll(commandId, '{{command:1}}') + '\n'
    await expect(transcript).toMatchFileSnapshot('./fixtures/command-receipts.expected.json')
  } finally { await run.dispose() }
})

it('persists admission before side effects and replays a lost completed response after cold restore', async () => {
  const run = await fixture()
  let calls = 0
  try {
    run.ctx.commands.register({ name: 'record', description: 'Synthetic local effect', handler: async () => {
      const artifact = await run.ctx.sessionPersistence.readRaw(run.request.sessionId)
      expect(artifact?.content).toContain('synthetic-command-invocation')
      calls += 1
      return { kind: 'success', text: `recorded ${calls}` }
    } })
    const original = await run.submit()
    expect(original).toMatchObject({ ok: true, value: { state: 'completed', result: { kind: 'success', text: 'recorded 1' } } })
    expect(await run.submit()).toEqual(original)
    await run.handle.dispose({ keepInbox: true })
    const resume = vi.spyOn(run.ctx.agents, 'resume')
    vi.spyOn(run.ctx.llm, 'listProviders').mockReturnValue([])
    expect(await run.submit()).toEqual(original)
    expect(resume).not.toHaveBeenCalled()
    expect(calls).toBe(1)
    expect(run.adapter.requests).toHaveLength(0)
  } finally { await run.dispose() }
})

it('completes durable commands from an injected Host consumer without repeating their effect', async () => {
  const run = await fixture()
  let calls = 0
  let submit: typeof run.submit | undefined
  try {
    run.ctx.commands.register({ name: 'record', description: 'Synthetic injected command effect', handler: () => {
      calls += 1
      return { kind: 'success', text: `recorded ${calls}` }
    } })
    run.ctx.loader.builtins['command-retry-consumer'] = Object.assign((ctx: Context) => {
      const operations = ctx.sessionRemoteOperations
      if (operations === undefined) throw new Error('injected Host command consumer has no operations owner')
      submit = (request = run.request, signal = new AbortController().signal) => operations.command(request, signal)
    }, { inject: ['sessionRemoteOperations'] })
    await run.ctx.loader.create({ name: 'cordis:command-retry-consumer' })
    await run.ctx.loader.await()
    if (submit === undefined) throw new Error('injected Host consumer did not initialize')
    const original = await submit()
    expect(original).toMatchObject({ ok: true, value: { state: 'completed', result: { kind: 'success', text: 'recorded 1' } } })
    expect(await submit()).toEqual(original)
    expect(calls).toBe(1)
    expect(run.handle.agent.session.events.filter(event => event.type === 'command/run')).toHaveLength(1)
    expect(run.handle.agent.session.events.filter(event => event.type === 'command/done')).toHaveLength(1)
    await run.handle.dispose({ keepInbox: true })
    const resume = vi.spyOn(run.ctx.agents, 'resume')
    vi.spyOn(run.ctx.llm, 'listProviders').mockReturnValue([])
    expect(await submit()).toEqual(original)
    expect(resume).not.toHaveBeenCalled()
    expect(calls).toBe(1)
    expect(run.adapter.requests).toHaveLength(0)
  } finally { await run.dispose() }
})

it('keeps one running operation through concurrent retries and a disconnected transport', async () => {
  const run = await fixture()
  let finish!: () => void
  let calls = 0
  const blocked = new Promise<void>((resolve) => { finish = resolve })
  try {
    run.ctx.commands.register({ name: 'record', description: 'Synthetic blocked effect', handler: async () => {
      calls += 1
      await blocked
      return { kind: 'success' }
    } })
    const transport = new AbortController()
    const first = run.submit(run.request, transport.signal)
    await vi.waitFor(() => { expect(calls).toBe(1) })
    transport.abort(new Error('synthetic lost connection'))
    const repeats = await Promise.all(Array.from({ length: 10 }, () => run.submit()))
    for (const repeated of repeats) expect(repeated).toMatchObject({ ok: true, value: { state: 'running' } })
    expect(await run.submit({ ...run.request, line: '/record changed' })).toMatchObject({ ok: false, error: { code: 'invocation-conflict' } })
    expect(await run.submit({ ...run.request, invocationId: SessionPromptInvocationId('another-id') })).toMatchObject({ ok: false, error: { code: 'command-busy' } })
    expect(run.handle.agent.session.events.filter(event => event.type === 'command/done')).toHaveLength(0)
    finish()
    expect(await first).toMatchObject({ ok: true, value: { state: 'completed' } })
    expect(await run.submit()).toMatchObject({ ok: true, value: { state: 'completed' } })
    expect(calls).toBe(1)
  } finally { finish(); await run.dispose() }
})

it('does not enter a handler when the run durability barrier fails', async () => {
  const run = await fixture()
  const handler = vi.fn(() => ({ kind: 'success' as const }))
  try {
    run.ctx.commands.register({ name: 'record', description: 'Must not enter', handler })
    vi.spyOn(run.ctx.sessions, 'flush').mockRejectedValueOnce(new Error('synthetic run fsync failure'))
    expect(await run.submit()).toMatchObject({ ok: true, value: { state: 'unknown', reason: 'durability-unconfirmed' } })
    expect(await run.submit()).toMatchObject({ ok: true, value: { state: 'unknown', reason: 'interrupted' } })
    expect(handler).not.toHaveBeenCalled()
  } finally { await run.dispose() }
})

it('retries a failed result durability check without repeating a settled side effect', async () => {
  const run = await fixture()
  let calls = 0
  try {
    run.ctx.commands.register({ name: 'record', description: 'Effect before failed result flush', handler: () => {
      calls += 1
      vi.spyOn(run.ctx.sessions, 'flush').mockRejectedValueOnce(new Error('synthetic result fsync failure'))
      return { kind: 'success', text: 'effect finished' }
    } })
    expect(await run.submit()).toMatchObject({ ok: true, value: { state: 'unknown', reason: 'durability-unconfirmed' } })
    expect(await run.submit()).toMatchObject({ ok: true, value: { state: 'completed', result: { text: 'effect finished' } } })
    expect(calls).toBe(1)
  } finally { await run.dispose() }
})

it('reports an interrupted durable run without resuming or repeating the command', async () => {
  const run = await fixture()
  try {
    run.handle.agent.session.append('command/run', {
      commandId: CommandId('synthetic-interrupted'), name: 'record', source: { kind: 'user' },
      invocationId: run.request.invocationId, inputDigest: commandDigest(run.request),
    })
    await run.ctx.sessions.flush(run.handle.agent.session)
    await run.handle.dispose({ keepInbox: true })
    const resume = vi.spyOn(run.ctx.agents, 'resume')
    expect(await run.submit()).toMatchObject({ ok: true, value: { state: 'unknown', reason: 'interrupted' } })
    expect(resume).not.toHaveBeenCalled()
    expect(run.adapter.requests).toHaveLength(0)
  } finally { await run.dispose() }
})

it('rejects identity reuse between ordinary prompt and command planes', async () => {
  const run = await fixture()
  try {
    run.ctx.commands.register({ name: 'record', description: 'Synthetic record', handler: () => ({ kind: 'success' }) })
    expect(await run.submit()).toMatchObject({ ok: true })
    expect(await run.operations.prompt({
      sessionId: run.request.sessionId, invocationId: run.request.invocationId,
      mode: 'queue', content: [{ type: 'text', text: 'ordinary text with a command identity' }],
    }, new AbortController().signal)).toMatchObject({ ok: false, error: { code: 'invocation-conflict' } })
    const invocationId = SessionPromptInvocationId('ordinary-first')
    expect(await run.operations.prompt({ sessionId: run.request.sessionId, invocationId, mode: 'queue', content: [{ type: 'text', text: 'ordinary input' }] }, new AbortController().signal)).toMatchObject({ ok: true })
    expect(await run.submit({ ...run.request, invocationId })).toMatchObject({ ok: false, error: { code: 'invocation-conflict' } })
  } finally { await run.dispose() }
})

it('waits for an uncooperative entered handler instead of recording a false cancelled terminal', async () => {
  const run = await fixture()
  let finish!: () => void
  let entered = false
  const blocked = new Promise<void>((resolve) => { finish = resolve })
  const lifetime = new AbortController()
  try {
    run.ctx.commands.register({ name: 'record', description: 'Ignores cancellation until its effect settles', handler: async () => {
      entered = true
      await blocked
      return { kind: 'success', text: 'effect actually settled' }
    } })
    const operation = run.ctx.commands.execute(run.handle.agent, run.request, lifetime.signal, () => {})
    await vi.waitFor(() => { expect(entered).toBe(true) })
    lifetime.abort(new Error('synthetic operation cancellation'))
    expect(await run.submit()).toMatchObject({ ok: true, value: { state: 'running' } })
    expect(run.handle.agent.session.events.filter(event => event.type === 'command/done')).toHaveLength(0)
    let drained = false
    const drain = run.ctx.commands.whenSettled().then(() => { drained = true })
    await Promise.resolve()
    expect(drained).toBe(false)
    finish()
    expect(await operation).toMatchObject({ state: 'completed', result: { kind: 'success' } })
    await drain
    expect(drained).toBe(true)
  } finally { finish(); await run.dispose() }
})

it('replays a persisted error after an effect without treating that error as permission to rerun', async () => {
  const run = await fixture()
  let effects = 0
  try {
    run.ctx.commands.register({ name: 'record', description: 'Effect followed by an exception', handler: () => {
      effects += 1
      throw new Error('synthetic failure after the effect')
    } })
    const first = await run.submit()
    expect(first).toMatchObject({ ok: true, value: { state: 'completed', result: { kind: 'error', text: 'synthetic failure after the effect' } } })
    expect(await run.submit()).toEqual(first)
    expect(effects).toBe(1)
    expect(await run.submit({ ...run.request, invocationId: SessionPromptInvocationId('explicit-new-command-intent') }))
      .toMatchObject({ ok: true, value: { state: 'completed', result: { kind: 'error' } } })
    expect(effects).toBe(2)
    await run.handle.dispose({ keepInbox: true })
    expect(await run.submit()).toEqual(first)
    expect(effects).toBe(2)
  } finally { await run.dispose() }
})

it('routes the Session prompt slash branch through the same command receipt owner', async () => {
  const run = await fixture()
  let calls = 0
  try {
    run.ctx.commands.register({ name: 'record', description: 'Shared slash route', handler: () => {
      calls += 1
      return { kind: 'success', text: 'same effect' }
    } })
    const input = { sessionId: run.request.sessionId, invocationId: run.request.invocationId,
      mode: 'queue' as const, content: [{ type: 'text' as const, text: run.request.line }] }
    expect(await run.operations.prompt(input, new AbortController().signal)).toMatchObject({ ok: true, value: { accepted: true, command: { text: 'same effect' } } })
    expect(await run.submit()).toMatchObject({ ok: true, value: { state: 'completed', result: { text: 'same effect' } } })
    expect(await run.operations.prompt(input, new AbortController().signal)).toMatchObject({ ok: true })
    expect(calls).toBe(1)
    expect(run.adapter.requests).toHaveLength(0)
  } finally { await run.dispose() }
})

it('keeps an admitted slash skill in the ordinary receipt plane on retry', async () => {
  const run = await fixture()
  try {
    run.handle.agent.ctx.provide('skills', { list: async () => [{
      name: 'synthetic-skill', invocation: { modelInvocable: true, userInvocable: true },
    }] } as never)
    const input = { sessionId: run.request.sessionId, invocationId: run.request.invocationId,
      mode: 'queue' as const, content: [{ type: 'text' as const, text: '/synthetic-skill example' }] }
    expect(await run.operations.prompt(input, new AbortController().signal)).toMatchObject({ ok: true })
    expect(await run.operations.prompt(input, new AbortController().signal)).toMatchObject({ ok: true })
    await run.handle.agent.whenIdle()
    expect(run.adapter.requests).toHaveLength(1)
    expect(run.handle.agent.session.events.filter(event => event.type === 'command/run')).toHaveLength(0)
  } finally { await run.dispose() }
})
