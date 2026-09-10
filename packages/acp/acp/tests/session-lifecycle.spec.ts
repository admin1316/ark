import { afterEach, describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import { makeBridgeHarness, textResponse, type BridgeHarness } from './harness.ts'

function header(
  id: string,
  createdAt: number,
  cwd: string | null = process.cwd(),
  extra: Partial<SessionHeader> = {},
): SessionHeader {
  return {
    version: SESSION_FORMAT_VERSION,
    id: SessionId(id),
    createdAt,
    ...cwd === null ? {} : { cwd },
    ...extra,
  }
}

function cursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

describe('ACP persistent session lifecycle', () => {
  let harness: BridgeHarness | undefined

  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
    vi.restoreAllMocks()
  })

  it('advertises, closes, lists, resumes, and continues a materialized session', async () => {
    harness = await makeBridgeHarness({
      persistence: true,
      script: [textResponse('before close'), textResponse('after resume')],
    })
    const initialized = await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    expect(initialized.agentCapabilities).toMatchObject({
      mcpCapabilities: { http: true },
      sessionCapabilities: { close: {}, list: {}, resume: {} },
    })

    const created = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await harness.client.prompt({ sessionId: created.sessionId, prompt: [{ type: 'text', text: 'first' }] })
    await expect(harness.client.closeSession({ sessionId: created.sessionId })).resolves.toEqual({})
    expect(harness.ctx.agents.get(SessionId(created.sessionId))).toBeUndefined()

    await expect(harness.client.listSessions({})).resolves.toEqual({
      sessions: [{ sessionId: created.sessionId, cwd: process.cwd() }],
    })
    const resumed = await harness.client.resumeSession({
      sessionId: created.sessionId,
      cwd: process.cwd(),
    })
    expect(Array.isArray(resumed.configOptions)).toBe(true)
    await expect(harness.client.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'second' }],
    })).resolves.toEqual({ stopReason: 'end_turn' })
  })

  it('filters every non-top-level or active source and paginates stable ties', async () => {
    harness = await makeBridgeHarness({ persistence: true, config: { sessionListPageSize: 1 } })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const persistence = harness.persistence!
    persistence.seed(header('eligible-b', 10))
    persistence.seed(header('eligible-a', 10))
    persistence.seed(header('other-cwd', 11, '/tmp'))
    persistence.seed(header('subagent', 20, process.cwd(), { origin: 'subagent' }))
    persistence.seed(header('child', 20, process.cwd(), { parentSession: SessionId('parent') }))
    persistence.seed(header('no-cwd', 20, null))
    persistence.seed(header('relative-cwd', 20, 'relative'))

    const foreign = harness.ctx.sessions.create(SessionId('foreign-active'), { meta: { cwd: process.cwd() } })
    persistence.seed(foreign.header)
    await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })

    const first = await harness.client.listSessions({ cwd: process.cwd() })
    expect(first.sessions).toEqual([{ sessionId: 'eligible-a', cwd: process.cwd() }])
    expect(first.nextCursor).toEqual(expect.any(String))
    if (first.nextCursor === undefined) throw new Error('expected the first ACP page to carry a cursor')
    const second = await harness.client.listSessions({ cwd: process.cwd(), cursor: first.nextCursor })
    expect(second).toEqual({ sessions: [{ sessionId: 'eligible-b', cwd: process.cwd() }] })
    await expect(harness.client.listSessions({ cwd: null, cursor: null })).resolves.toMatchObject({
      sessions: [{ sessionId: 'other-cwd', cwd: '/tmp' }],
    })
  })

  it('uses physical directory identity and a lexical fallback for missing paths', async () => {
    harness = await makeBridgeHarness({ persistence: true })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    harness.persistence!.seed(header('existing-dir', 2, process.cwd()))
    harness.persistence!.seed(header('missing-dir', 1, '/tmp/acp-coverage-missing'))

    await expect(harness.client.listSessions({ cwd: process.cwd() })).resolves.toEqual({
      sessions: [{ sessionId: 'existing-dir', cwd: process.cwd() }],
    })
    await expect(harness.client.listSessions({ cwd: '/tmp/acp-coverage-missing' })).resolves.toEqual({
      sessions: [{ sessionId: 'missing-dir', cwd: '/tmp/acp-coverage-missing' }],
    })
    await expect(harness.client.listSessions({ cwd: 'relative' })).rejects.toThrow(/absolute path/)
  })

  it('rejects every malformed cursor field and a non-canonical encoding', async () => {
    harness = await makeBridgeHarness({ persistence: true })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const invalid = [
      '%',
      cursor({}),
      cursor([1]),
      cursor(['1', 'id']),
      cursor([1.5, 'id']),
      cursor([-1, 'id']),
      cursor([1, 2]),
      cursor([1, '']),
      Buffer.from('[1, "id"]', 'utf8').toString('base64url'),
    ]
    for (const value of invalid) {
      await expect(harness.client.listSessions({ cursor: value })).rejects.toThrow(/cursor is invalid/)
    }
  })

  it('hides a session while its resume activation is pending', async () => {
    harness = await makeBridgeHarness({ persistence: true })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const persistence = harness.persistence!
    persistence.seed(header('activating', 1))
    const listed = await persistence.list()
    const gate = Promise.withResolvers<SessionHeader[]>()
    const list = vi.spyOn(persistence, 'list').mockReturnValueOnce(gate.promise)

    const resume = harness.client.resumeSession({ sessionId: 'activating', cwd: process.cwd() })
    await vi.waitFor(() => { expect(list).toHaveBeenCalledOnce() })
    await expect(harness.client.listSessions({})).resolves.toEqual({ sessions: [] })
    gate.resolve(listed)
    expect(Array.isArray((await resume).configOptions)).toBe(true)
  })

  it('rejects unavailable, active, child, and workspace-mismatched resumes', async () => {
    harness = await makeBridgeHarness({ persistence: true })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const persistence = harness.persistence!
    persistence.seed(header('subagent', 1, process.cwd(), { origin: 'subagent' }))
    persistence.seed(header('child', 2, process.cwd(), { parentSession: SessionId('parent') }))
    persistence.seed(header('no-cwd', 3, null))
    persistence.seed(header('wrong-cwd', 4, '/tmp'))
    const active = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })

    await expect(harness.client.resumeSession({ sessionId: 'missing', cwd: process.cwd() }))
      .rejects.toThrow(/not resumable/)
    await expect(harness.client.resumeSession({ sessionId: 'subagent', cwd: process.cwd() }))
      .rejects.toThrow(/not resumable/)
    await expect(harness.client.resumeSession({ sessionId: 'child', cwd: process.cwd() }))
      .rejects.toThrow(/not resumable/)
    await expect(harness.client.resumeSession({ sessionId: 'no-cwd', cwd: process.cwd() }))
      .rejects.toThrow(/cwd does not match/)
    await expect(harness.client.resumeSession({ sessionId: 'wrong-cwd', cwd: process.cwd() }))
      .rejects.toThrow(/cwd does not match/)
    await expect(harness.client.resumeSession({ sessionId: active.sessionId, cwd: process.cwd() }))
      .rejects.toThrow(/already active/)
    await expect(harness.client.resumeSession({ sessionId: 'missing', cwd: 'relative' }))
      .rejects.toThrow(/absolute path/)
    await expect(harness.client.resumeSession({
      sessionId: 'missing',
      cwd: process.cwd(),
      additionalDirectories: ['/tmp'],
    })).rejects.toThrow(/additionalDirectories/)
  })

  it('reports persistence-only methods when no backend is mounted', async () => {
    harness = await makeBridgeHarness()
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    await expect(harness.client.listSessions({})).rejects.toThrow(/requires a session persistence backend/)
    await expect(harness.client.resumeSession({ sessionId: 'missing', cwd: process.cwd() }))
      .rejects.toThrow(/requires a session persistence backend/)
  })

  it('restores a logged adapter-default effort as an unpinned route', async () => {
    harness = await makeBridgeHarness({ persistence: true })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const event = {
      type: 'request/header',
      seq: 0,
      time: 1,
      data: {
        header: {
          config: { provider: 'mock', model: 'mock', reasoningEffort: ReasoningEffortId('high') },
          adapterDefaults: { reasoningEffort: true },
          system: '',
          tools: [],
        },
        reason: 'initial',
      },
    } as SessionEvent<'request/header'>
    harness.persistence!.seed(header('default-effort', 1), [event])

    const resumed = await harness.client.resumeSession({ sessionId: 'default-effort', cwd: process.cwd() })
    expect(Array.isArray(resumed.configOptions)).toBe(true)
  })

  it('restores an explicitly logged reasoning effort', async () => {
    harness = await makeBridgeHarness({
      persistence: true,
      config: { provider: 'mock', model: 'reasoner' },
      models: [{ id: 'reasoner', reasoningEfforts: ['high'] }],
    })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const event = {
      type: 'request/header',
      seq: 0,
      time: 1,
      data: {
        header: {
          config: { provider: 'mock', model: 'reasoner', reasoningEffort: ReasoningEffortId('high') },
          system: '',
          tools: [],
        },
        reason: 'initial',
      },
    } as SessionEvent<'request/header'>
    harness.persistence!.seed(header('explicit-effort', 1), [event])

    const resumed = await harness.client.resumeSession({ sessionId: 'explicit-effort', cwd: process.cwd() })
    expect(resumed.configOptions?.find(option => option.id === 'reasoning_effort'))
      .toMatchObject({ currentValue: 'high' })
  })

  it('maps fresh-session factory and activation failures without leaking agents', async () => {
    harness = await makeBridgeHarness({ persistence: true })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const create = vi.spyOn(harness.ctx.agents, 'create').mockRejectedValueOnce(new Error('factory unavailable'))
    await expect(harness.client.newSession({ cwd: process.cwd(), mcpServers: [] }))
      .rejects.toThrow('Internal error')
    create.mockRestore()

    vi.spyOn(harness.ctx.llm, 'resolveCallConfig').mockRejectedValueOnce(new Error('model discovery failed'))
    await expect(harness.client.newSession({ cwd: process.cwd(), mcpServers: [] }))
      .rejects.toThrow('Internal error')
    expect(harness.ctx.agents.list()).toEqual([])
  })

  it('maps resume composition errors and removes failed option discovery', async () => {
    harness = await makeBridgeHarness({ persistence: true })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const persistence = harness.persistence!
    persistence.seed(header('bad-mcp', 1))
    persistence.seed(header('resume-factory', 2))
    persistence.seed(header('bad-options', 3))

    await expect(harness.client.resumeSession({
      sessionId: 'bad-mcp',
      cwd: process.cwd(),
      mcpServers: [{ name: 'relative', command: 'node', args: [], env: [] }],
    })).rejects.toThrow(/command must be an absolute path/)

    const resume = vi.spyOn(harness.ctx.agents, 'resume').mockRejectedValueOnce(new Error('resume factory unavailable'))
    await expect(harness.client.resumeSession({ sessionId: 'resume-factory', cwd: process.cwd() }))
      .rejects.toThrow('Internal error')
    resume.mockRestore()

    vi.spyOn(harness.ctx.llm, 'resolveCallConfig').mockRejectedValueOnce(new Error('resume options unavailable'))
    await expect(harness.client.resumeSession({ sessionId: 'bad-options', cwd: process.cwd() }))
      .rejects.toThrow('Internal error')
    expect(harness.ctx.agents.get(SessionId('bad-options'))).toBeUndefined()
  })

  it('maps model-option errors while preserving unrelated runtime failures', async () => {
    harness = await makeBridgeHarness()
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await expect(harness.client.setSessionConfigOption({
      sessionId,
      configId: 'unknown',
      value: 'x',
    })).rejects.toThrow(/unknown session config option/)

    vi.spyOn(harness.ctx.llm, 'listProviders').mockImplementationOnce(() => { throw new Error('catalog exploded') })
    await expect(harness.client.setSessionConfigOption({
      sessionId,
      configId: 'model',
      value: JSON.stringify(['mock', 'mock']),
    })).rejects.toThrow('Internal error')
  })

  it('contains activity-drain failures while still removing the closed session', async () => {
    harness = await makeBridgeHarness({ persistence: true })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const agent = harness.ctx.agents.get(SessionId(sessionId))!
    vi.spyOn(agent, 'whenIdle').mockRejectedValueOnce(new Error('idle drain failed'))

    await expect(harness.client.closeSession({ sessionId })).rejects.toThrow(/session close failed.*activity drain failed/i)
    expect(harness.ctx.agents.get(SessionId(sessionId))).toBeUndefined()
    await expect(harness.client.closeSession({ sessionId })).rejects.toThrow(/unknown session/)
  })
})
