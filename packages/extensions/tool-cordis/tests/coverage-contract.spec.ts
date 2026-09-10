import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import DynamicCordisRunnerService from '@deepseek-ai/dsh-cordis-host-runner'
import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import * as ToolCordis from '../src/index.ts'
import {
  describeApi, describeDynamic, describeEvents, describePlugins, describeServices, describeTools,
  missingServices, providedServices, withinFiber,
} from '../src/inspect.ts'
import {
  presentDefineCall, presentInspectListCall, presentInspectQueryCall, presentInspectSelfCall,
  presentPackageInspectCall, presentRunCall, presentRuntimeInspectCall, presentStopCall, presentUndefineCall,
} from '../src/present.ts'
import { hostInspectProviders } from '../src/providers.ts'
import type { EventApiEntry, InheritedApiEntry, ServiceApiEntry, TypeApiEntry } from '../src/api-catalog.ts'

let calls = 0
const AGENT = { id: 'S-contract', steer() {}, inject() {} } as unknown as Agent

function call(
  ctx: Context,
  name: string,
  args: unknown,
  agent: Agent | null = AGENT,
  signal = new AbortController().signal,
): Promise<ToolExecutionResult> {
  return ctx.tools.execute({
    callId: CallId(`cordis-contract-${++calls}`), name, arguments: args, signal,
    ...agent === null ? {} : { agent },
  })
}

function value(result: ToolExecutionResult): unknown {
  if (result.isError) throw new Error(result.content.map(block => block.type === 'text' ? block.text : '').join(''))
  return result.value
}

function errorText(result: ToolExecutionResult): string {
  expect(result.isError).toBe(true)
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

async function setup(): Promise<{ ctx: Context; runner: DynamicCordisRunnerService; toolFiber: Awaited<ReturnType<Context['plugin']>> }> {
  const ctx = new Context()
  await ctx.plugin(Timer)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(DynamicCordisRunnerService)
  const toolFiber = await ctx.plugin({ name: ToolCordis.name, inject: ToolCordis.inject, apply: ToolCordis.apply })
  return { ctx, runner: ctx.dynamicCordisRunner, toolFiber }
}

const NOOP = 'return { name: "contract-noop", apply() {} }'

describe('Cordis model tools in a real Host composition', () => {
  it('registers, queries, validates, cancels, and unloads the real inspect-provider tree', async () => {
    const { ctx, toolFiber } = await setup()
    expect(ctx.tools.schemas().map(schema => schema.name)).toEqual(expect.arrayContaining([
      'cordis_inspect_list', 'cordis_inspect_query', 'cordis_inspect_self', 'cordis_define',
      'cordis_run', 'cordis_stop', 'cordis_undefine',
    ]))

    expect(value(await call(ctx, 'cordis_inspect_list', {}, undefined))).toMatchObject({
      providers: [{ id: 'Service' }, { id: 'Event' }, { id: 'Builtin' }, { id: 'Tool' }],
    })
    expect(errorText(await call(ctx, 'cordis_inspect_query', { platform: 'host', provider: 'Service', method: 'listService' }, null)))
      .toContain('Agent-backed session')

    expect(value(await call(ctx, 'cordis_inspect_query', {
      platform: 'host', provider: 'Service', method: 'listService', input: { service: 'tools' },
    }))).toMatchObject({ data: { mode: 'service', service: { key: 'tools' } } })
    expect(value(await call(ctx, 'cordis_inspect_query', {
      platform: 'host', provider: 'Event', method: 'listEvents', input: { event: 'agent/pre-step' },
    }))).toMatchObject({ data: { mode: 'event', event: { name: 'agent/pre-step' } } })
    const builtinsResult = value(await call(ctx, 'cordis_inspect_query', {
      platform: 'host', provider: 'Builtin', method: 'listBuiltins',
    }))
    const builtins = requiredArrayProperty(requiredObjectProperty(builtinsResult, 'data'), 'builtins')
    expect(builtins.map(entry => requiredStringProperty(entry, 'name'))).toContain('harness')
    const toolsResult = value(await call(ctx, 'cordis_inspect_query', {
      platform: 'host', provider: 'Tool', method: 'listTools',
    }))
    const tools = requiredArrayProperty(requiredObjectProperty(toolsResult, 'data'), 'tools')
    expect(tools.map(entry => requiredStringProperty(entry, 'name'))).toContain('cordis_define')

    expect(errorText(await call(ctx, 'cordis_inspect_query', {
      platform: 'host', provider: 'Service', method: 'missing',
    }))).toContain('has no method')
    const cancelled = new AbortController()
    cancelled.abort()
    expect(errorText(await call(ctx, 'cordis_inspect_query', {
      platform: 'host', provider: 'Service', method: 'listService',
    }, AGENT, cancelled.signal))).toMatch(/abort|cancel/i)

    await toolFiber.dispose()
    expect(ctx.cordisInspect.list()).toEqual([])
    expect(ctx.tools.get('cordis_define')).toBeUndefined()
  })

  it('defines, inspects, runs, stops, and removes a session-owned package through the tool pipeline', async () => {
    const { ctx, runner } = await setup()
    expect(errorText(await call(ctx, 'cordis_define', {
      plugin: { kind: 'new', idPrefix: 'probe' }, name: 'missing-agent', purpose: 'must reject', code: { host: NOOP },
    }, null))).toContain('Agent-backed session')

    expect(value(await call(ctx, 'cordis_define', {
      plugin: { kind: 'new', idPrefix: 'probe' }, name: 'contract', purpose: 'host lifecycle contract', code: { host: NOOP },
    }))).toMatchObject({ pluginId: 'probe-1', packageId: 'pkg-1' })
    const plugin = runner.inventory()[0]
    if (plugin === undefined) throw new Error('tool did not define a plugin')
    const packageId = plugin.packages[0]?.packageId
    if (packageId === undefined) throw new Error('tool did not define a package')
    const revision = value(await call(ctx, 'cordis_define', {
      plugin: { kind: 'existing', pluginId: String(plugin.pluginId) }, name: 'revision', purpose: 'second immutable package',
      code: { host: 'return { name: \'revision\', inject: [\'late\'], apply() {} }' },
    }))
    expect(revision).toMatchObject({ pluginId: String(plugin.pluginId), packageId: 'pkg-2' })
    const revisionPackageId = requiredStringProperty(revision, 'packageId')

    expect(value(await call(ctx, 'cordis_inspect_self', {}))).toMatchObject({ mode: 'plugins' })
    expect(errorText(await call(ctx, 'cordis_inspect_self', { packageId: String(packageId) }))).toContain('requires pluginId')
    expect(value(await call(ctx, 'cordis_inspect_self', { pluginId: String(plugin.pluginId) }))).toMatchObject({
      mode: 'plugin', pluginId: String(plugin.pluginId), state: 'defined', packageCount: 2,
    })
    expect(value(await call(ctx, 'cordis_inspect_self', { pluginId: String(plugin.pluginId), packageId: String(packageId) }))).toMatchObject({
      mode: 'package', code: { host: NOOP }, runtime: { host: { status: 'stopped' } },
    })

    expect(value(await call(ctx, 'cordis_run', {
      pluginId: String(plugin.pluginId), packageId: String(packageId), mode: 'run',
    }))).toMatchObject({ status: 'running', currentPackageId: String(packageId), host: { status: 'running' } })
    expect(value(await call(ctx, 'cordis_run', {
      pluginId: String(plugin.pluginId), packageId: revisionPackageId, mode: 'update',
    }))).toMatchObject({ status: 'waiting', currentPackageId: revisionPackageId, host: { status: 'waiting', waitingFor: ['late'] } })
    expect(errorText(await call(ctx, 'cordis_run', {
      pluginId: String(plugin.pluginId), packageId: 'missing', mode: 'run',
    }))).toContain('has no package')
    expect(value(await call(ctx, 'cordis_stop', { pluginId: String(plugin.pluginId) }))).toEqual({ pluginId: String(plugin.pluginId) })
    expect(value(await call(ctx, 'cordis_stop', { pluginId: String(plugin.pluginId) }))).toEqual({ pluginId: String(plugin.pluginId) })
    expect(errorText(await call(ctx, 'cordis_stop', { pluginId: 'missing-1' }))).toContain('no dynamic plugin')
    expect(value(await call(ctx, 'cordis_undefine', { pluginId: String(plugin.pluginId) }))).toEqual({ pluginId: String(plugin.pluginId), wasRunning: false })
    expect(errorText(await call(ctx, 'cordis_undefine', { pluginId: String(plugin.pluginId) }))).toContain('no dynamic plugin')
  })

  it('injects exact @pluginId context only after an accepted pre-step, with unavailable and cancelled references explicit', async () => {
    const { ctx, runner } = await setup()
    const defined = runner.define({
      sessionId: AGENT.id, plugin: { kind: 'new', idPrefix: 'probe' }, name: 'context', purpose: 'reference context', code: { host: NOOP },
    })
    await runner.run(AGENT, defined.pluginId, defined.packageId, 'run')
    const messages: UserMessage[] = [createUserMessage({
      content: [{ type: 'text', text: `Please repair @${defined.pluginId}` }], source: { kind: 'user' },
    })]
    const accepted = await agentEvents(ctx, AGENT).waterfall(
      'agent/pre-step', { messages, turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter' as const, messages }),
    )
    expect(accepted.kind).toBe('enter')
    if (accepted.kind !== 'enter') throw new Error('expected an entered decision')
    expect(accepted.messages).toHaveLength(2)
    const acceptedContext = accepted.messages[1]?.content[0]
    if (acceptedContext?.type !== 'text') throw new Error('expected a text context')
    expect(acceptedContext.text).toContain(`@${defined.pluginId}`)
    expect(acceptedContext.text).toContain('mode="update"')

    const unrun = runner.define({
      sessionId: AGENT.id, plugin: { kind: 'new', idPrefix: 'fresh' }, name: 'fresh', purpose: 'unrun reference', code: { host: NOOP },
    })
    const unrunMessages: UserMessage[] = [createUserMessage({
      content: [{ type: 'text', text: `Please inspect @${unrun.pluginId}` }], source: { kind: 'user' },
    })]
    const unrunDecision = await agentEvents(ctx, AGENT).waterfall(
      'agent/pre-step', { messages: unrunMessages, turn: 1, step: 2, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: unrunMessages }),
    )
    if (unrunDecision.kind !== 'enter') throw new Error('expected an entered unrun decision')
    const unrunContext = unrunDecision.messages[1]?.content[0]
    if (unrunContext?.type !== 'text') throw new Error('expected an unrun text context')
    expect(unrunContext.text).toContain('mode="run"')

    const unavailable: UserMessage[] = [createUserMessage({
      content: [{ type: 'text', text: 'Please repair @ghost-9' }], source: { kind: 'user' },
    })]
    const missing = await agentEvents(ctx, AGENT).waterfall(
      'agent/pre-step', { messages: unavailable, turn: 2, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: unavailable }),
    )
    if (missing.kind !== 'enter') throw new Error('expected an entered unavailable decision')
    const unavailableContext = missing.messages[1]?.content[0]
    if (unavailableContext?.type !== 'text') throw new Error('expected an unavailable text context')
    expect(unavailableContext.text).toContain('unavailable')

    const rejection = await agentEvents(ctx, AGENT).waterfall(
      'agent/pre-step', { messages, turn: 3, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'reject' as const }),
    )
    expect(rejection).toEqual({ kind: 'reject' })
    const plain: UserMessage[] = [createUserMessage({
      content: [{ type: 'text', text: 'No dynamic reference in this message.' }], source: { kind: 'user' },
    })]
    await expect(agentEvents(ctx, AGENT).waterfall(
      'agent/pre-step', { messages: plain, turn: 3, step: 2, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: plain }),
    )).resolves.toEqual({ kind: 'enter', messages: plain })
    const pluginMessage = createUserMessage({
      content: [{ type: 'text', text: `@${defined.pluginId}` }], source: { kind: 'plugin', plugin: 'another-plugin' },
    })
    await expect(agentEvents(ctx, AGENT).waterfall(
      'agent/pre-step', { messages: [pluginMessage], turn: 3, step: 3, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [pluginMessage] }),
    )).resolves.toEqual({ kind: 'enter', messages: [pluginMessage] })
    const imageOnly = createUserMessage({
      content: [{ type: 'reasoning', text: 'non-text content' }], source: { kind: 'user' },
    })
    await expect(agentEvents(ctx, AGENT).waterfall(
      'agent/pre-step', { messages: [imageOnly], turn: 3, step: 4, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [imageOnly] }),
    )).resolves.toEqual({ kind: 'enter', messages: [imageOnly] })
    const cancelled = new AbortController()
    cancelled.abort()
    await expect(agentEvents(ctx, AGENT).waterfall(
      'agent/pre-step', { messages, turn: 4, step: 1, signal: cancelled.signal },
      () => Promise.resolve({ kind: 'enter' as const, messages }),
    )).rejects.toThrow(/abort/i)
  })

  it('deduplicates only complete whitespace-delimited @pluginId tokens', async () => {
    const { ctx } = await setup()
    const messages: UserMessage[] = [createUserMessage({
      content: [{
        type: 'text',
        text: '@alpha-1\n@beta-2 @alpha-1 not@wrong-3 @abc-4x @toolong-5',
      }],
      source: { kind: 'user' },
    })]
    const decision = await agentEvents(ctx, AGENT).waterfall(
      'agent/pre-step', { messages, turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter' as const, messages }),
    )
    if (decision.kind !== 'enter') throw new Error('expected reference contexts')
    expect(decision.messages).toHaveLength(3)
    const rendered = decision.messages.slice(1).flatMap(message =>
      message.content.flatMap(block => block.type === 'text' ? [block.text] : [])).join('\n')
    expect(rendered).toContain('@alpha-1')
    expect(rendered).toContain('@beta-2')
    expect(rendered).not.toContain('@wrong-3')
    expect(rendered).not.toContain('@abc-4')
    expect(rendered).not.toContain('@toolong-5')
  })

  it('keeps renderer contracts strict while projecting defined, running, waiting, failed, and stopped package state', async () => {
    const { ctx, runner } = await setup()
    const runTool = ctx.tools.get('cordis_run')
    if (runTool === undefined) throw new Error('cordis_run is not registered')
    expect(() => runTool.output.render({}, null)).toThrow('expected a JSON object')
    expect(() => runTool.output.render({}, {})).toThrow('expected JSON string field "pluginId"')
    expect(() => runTool.output.presentationMeta?.({}, {})).toThrow('expected JSON string field "pluginId"')

    const defined = runner.define({
      sessionId: AGENT.id, plugin: { kind: 'new', idPrefix: 'probe' }, name: 'state', purpose: 'states', code: { host: NOOP },
    })
    expect(value(await call(ctx, 'cordis_inspect_self', { pluginId: String(defined.pluginId) }))).toMatchObject({ state: 'defined' })
    await runner.run(AGENT, defined.pluginId, defined.packageId, 'run')
    expect(value(await call(ctx, 'cordis_inspect_self', { pluginId: String(defined.pluginId), packageId: String(defined.packageId) }))).toMatchObject({
      runtime: { state: 'running', host: { status: 'running' } },
    })

    const waiting = runner.define({
      sessionId: AGENT.id, plugin: { kind: 'existing', pluginId: defined.pluginId }, name: 'waiting', purpose: 'wait',
      code: { host: 'return { name: \'waiting\', inject: [\'late\'], apply() {} }' },
    })
    await runner.run(AGENT, defined.pluginId, waiting.packageId, 'update')
    expect(value(await call(ctx, 'cordis_inspect_self', { pluginId: String(defined.pluginId), packageId: String(waiting.packageId) }))).toMatchObject({
      runtime: { state: 'waiting', host: { status: 'waiting', waitingFor: ['late'] } },
    })
    await runner.stop(AGENT, defined.pluginId)
    expect(value(await call(ctx, 'cordis_inspect_self', { pluginId: String(defined.pluginId), packageId: String(waiting.packageId) }))).toMatchObject({
      runtime: { state: 'stopped', host: { status: 'stopped' } },
    })
    const failed = runner.define({
      sessionId: AGENT.id, plugin: { kind: 'existing', pluginId: defined.pluginId }, name: 'failed', purpose: 'fail', code: { host: 'return 42' },
    })
    await runner.run(AGENT, defined.pluginId, failed.packageId, 'update')
    expect(value(await call(ctx, 'cordis_inspect_self', { pluginId: String(defined.pluginId), packageId: String(failed.packageId) }))).toMatchObject({
      runtime: { state: 'failed', host: { status: 'failed' } },
    })
  })
})

describe('inspection, provider, and render contracts', () => {
  const api: readonly ServiceApiEntry[] = [
    {
      key: 'catalogued', summary: 'A {@link Catalogued.service} for the report.', description: 'Catalogued service details.',
      methods: [
        { signature: 'read(value: Root): Child', description: 'Read one value.', parameters: [{ name: 'value', description: 'input value' }], returns: 'a child.', throws: ['when absent'] },
        { signature: 'probe(): void', description: 'Probe without a result.', parameters: [] },
      ],
    },
    { key: 'absent', summary: 'An unloaded service.', description: 'An unloaded service.', methods: [] },
  ]
  const types: readonly TypeApiEntry[] = [
    { name: 'Root', declaration: 'interface Root { child: Child }' },
    { name: 'Child', declaration: 'interface Child { ok: boolean }' },
    { name: 'Unused', declaration: 'interface Unused { no: boolean }' },
  ]
  const inherited: readonly InheritedApiEntry[] = [{ name: 'ctx.on', summary: 'Observe.' }]
  const events: readonly EventApiEntry[] = [{
    name: 'probe/event', mode: 'waterfall', summary: 'Probe event.', description: 'Detailed probe event.',
    signature: '(value: string, next: () => void): void', parameters: [{ name: 'value', description: 'input' }],
  }]

  it('reports live services, ownership, dynamic state, scopes, api contracts, and events from one real context', async () => {
    const { ctx, runner } = await setup()
    ctx.provide('catalogued', { read: () => ({ ok: true }) })
    const pending = await ctx.plugin({ name: 'waiting-plugin', inject: ['late'], apply() {} })
    expect(withinFiber(pending, ctx.fiber)).toBe(true)
    expect(withinFiber(ctx.fiber, pending)).toBe(false)
    expect(missingServices(ctx, pending)).toEqual(['late'])
    expect(providedServices(ctx, ctx.fiber)).toContain('catalogued')
    expect(describeServices(ctx, api).join('\n')).toContain('catalogued')
    expect(describeServices(new Context(), [])).toEqual(['(no services provided)'])
    expect(describePlugins(ctx).join('\n')).toContain('waiting-plugin')
    expect(describeTools(ctx).map(line => line.replace('- ', ''))).toContain('cordis_define')
    expect(describeDynamic(ctx)).toEqual([expect.stringContaining('No dynamic Plugins are defined')])

    const defined = runner.define({
      sessionId: AGENT.id, plugin: { kind: 'new', idPrefix: 'probe' }, name: 'wait', purpose: 'wait for late',
      code: { host: 'return { name: \'wait\', inject: [\'late\'], apply() {} }' },
    })
    await runner.run(AGENT, defined.pluginId, defined.packageId, 'run')
    expect(describeDynamic(ctx, AGENT).join('\n')).toContain('waiting for: late')

    const idle = runner.define({
      sessionId: AGENT.id, plugin: { kind: 'existing', pluginId: defined.pluginId }, name: 'idle', purpose: 'inactive package', code: { host: NOOP },
    })
    expect(describeDynamic(ctx, AGENT).join('\n')).toContain(`- ${idle.packageId}: idle — inactive package`)
    const unstarted = runner.define({
      sessionId: AGENT.id, plugin: { kind: 'new', idPrefix: 'idle' }, name: 'unstarted', purpose: 'not active', code: { host: NOOP },
    })
    expect(describeDynamic(ctx, AGENT).join('\n')).toContain(`- Plugin ${unstarted.pluginId}; current: none; next: none; stopped`)

    const provider = runner.define({
      sessionId: AGENT.id, plugin: { kind: 'new', idPrefix: 'give' }, name: 'provider', purpose: 'provide a live service',
      code: { host: 'return { name: \'provider\', apply(ctx) { ctx.provide(\'providedByDynamic\', {}) } }' },
    })
    await runner.run(AGENT, provider.pluginId, provider.packageId, 'run')
    expect(describeDynamic(ctx, AGENT).join('\n')).toContain('provides: providedByDynamic')

    const compact = describeApi(ctx, api, undefined, inherited, types).join('\n')
    expect(compact).toContain('catalogued — A Catalogued.service for the report.')
    expect(compact).toContain('not running (loadable services with no live provider): absent')
    expect(compact).toContain('inherited ctx API:')
    const exact = describeApi(ctx, api, 'catalogued', inherited, types).join('\n')
    expect(exact).toContain('@param value — input value')
    expect(exact).toContain('interface Child')
    expect(() => describeApi(ctx, api, 'absent', inherited, types)).toThrow('is not running')
    expect(() => describeApi(ctx, api, 'missing', inherited, types)).toThrow('no catalogued service')
    const firstApi = api[0]
    if (firstApi === undefined) throw new Error('missing service API fixture')
    expect(describeApi(ctx, [firstApi], undefined, [], []).join('\n')).not.toContain('not running (loadable services')
    expect(describeEvents(events).join('\n')).toContain('waterfall listeners')
    expect(describeEvents(events, 'probe/event').join('\n')).toContain('@param value — input')
    expect(() => describeEvents(events, 'missing')).toThrow('no catalogued event')
  })

  it('exposes provider calls and all replay-safe presentations without manufacturing an alternate runtime', async () => {
    const { ctx } = await setup()
    const providers = hostInspectProviders(ctx)
    const service = providers.find(provider => provider.manifest.id === 'Service')
    const tool = providers.find(provider => provider.manifest.id === 'Tool')
    if (service === undefined || tool === undefined) throw new Error('missing real providers')
    await expect(service.query('listService', { service: 'tools' }, { agent: AGENT, signal: new AbortController().signal }))
      .resolves.toMatchObject({ mode: 'service' })
    await expect(service.query('listService', null, { agent: AGENT, signal: new AbortController().signal }))
      .resolves.toMatchObject({ mode: 'catalog' })
    await expect(service.query('listService', { service: 42 }, { agent: AGENT, signal: new AbortController().signal }))
      .resolves.toMatchObject({ mode: 'catalog' })
    await expect(service.query('missing', undefined, { agent: AGENT, signal: new AbortController().signal })).rejects.toThrow('unknown Service inspect method')
    const visible = await tool.query('listTools', undefined, { agent: AGENT, signal: new AbortController().signal })
    expect(typeof visible === 'object' && visible !== null && Array.isArray(Reflect.get(visible, 'tools'))).toBe(true)
    expect(() => tool.query('missing', undefined, { agent: AGENT, signal: new AbortController().signal })).toThrow('unknown Tool inspect method')

    expect(presentRuntimeInspectCall({})).toMatchObject({ title: 'Inspect Cordis runtime' })
    expect(presentRuntimeInspectCall({ what: 'services', name: 'catalogued' }).title).toContain('services: catalogued')
    expect(presentInspectListCall()).toMatchObject({ kind: 'read' })
    expect(presentInspectQueryCall({ platform: 'host', provider: 'Service', method: 'listService' }).title).toContain('host Service.listService')
    expect(presentInspectSelfCall({}).title).toContain('dynamic Cordis Plugins')
    expect(presentInspectSelfCall({ pluginId: 'probe-1' }).title).toContain('probe-1')
    expect(presentInspectSelfCall({ pluginId: 'probe-1', packageId: 'pkg-1' }).title).toContain('probe-1/pkg-1')
    expect(presentPackageInspectCall({ pluginId: 'probe-1', packageId: 'pkg-1' }).title).toContain('Package probe-1/pkg-1')
    expect(presentDefineCall({ plugin: { kind: 'new', idPrefix: 'probe' }, name: 'n', purpose: 'p', code: { host: NOOP } }).title).toContain('new probe-*')
    expect(presentDefineCall({ plugin: { kind: 'existing', pluginId: 'probe-1' }, name: 'n', purpose: 'p', code: { host: NOOP } }).title).toContain('probe-1')
    expect(presentRunCall({ pluginId: 'probe-1', packageId: 'pkg-1', mode: 'run' }).title).toContain('Run')
    expect(presentRunCall({ pluginId: 'probe-1', packageId: 'pkg-1', mode: 'update' }).title).toContain('Update')
    expect(presentStopCall({ pluginId: 'probe-1' })).toMatchObject({ kind: 'execute' })
    expect(presentUndefineCall({ pluginId: 'probe-1' })).toMatchObject({ kind: 'delete' })
  })

  it('reports a never-run package as stopped when both the active and latest run are absent', async () => {
    const { ctx, runner } = await setup()
    const defined = runner.define({
      sessionId: AGENT.id, plugin: { kind: 'new', idPrefix: 'idle' }, name: 'idle', purpose: 'never run', code: { host: NOOP },
    })
    expect(runner.inspectPackage(AGENT, defined.pluginId, defined.packageId).latestRun).toBeUndefined()
    expect(runner.snapshot(AGENT)[0]?.activeRun).toBeUndefined()
    expect(value(await call(ctx, 'cordis_inspect_self', {
      pluginId: String(defined.pluginId), packageId: String(defined.packageId),
    }))).toMatchObject({ runtime: { host: { status: 'stopped', provides: [], waitingFor: [] } } })
  })
})

/**
 * WHITE-BOX DEFENSIVE OWNER TESTS. DynamicCordisRunnerService exclusively
 * owns the snapshot and process-local run records exercised here; Cordis owns
 * Fiber lifecycle state. These cases model fail-closed observation windows,
 * restore every replaced field in `finally`, and are never cited as public
 * tool-closure evidence.
 */
describe('white-box defensive owner projections', () => {
  it('[white-box runner owner] preserves receipt output when the follow-up snapshot changes', async () => {
    const { ctx, runner } = await setup()
    const first = runner.define({
      sessionId: AGENT.id, plugin: { kind: 'new', idPrefix: 'race' }, name: 'first', purpose: 'race baseline', code: { host: NOOP },
    })
    const snapshotDescriptor = Object.getOwnPropertyDescriptor(runner, 'snapshot')
    const realSnapshot = runner.snapshot.bind(runner)
    const snapshotSpy = vi.spyOn(runner, 'snapshot')
    try {
      snapshotSpy.mockReturnValue([])
      expect(value(await call(ctx, 'cordis_run', {
        pluginId: String(first.pluginId), packageId: String(first.packageId), mode: 'run',
      }))).toMatchObject({ host: { status: 'absent', provides: [], waitingFor: [] } })

      snapshotSpy.mockImplementation(agent => realSnapshot(agent).map(row => row.activeRun === undefined ? row : {
        ...row,
        activeRun: { pluginRunId: row.activeRun.pluginRunId, packageId: row.activeRun.packageId },
      }))
      const second = runner.define({
        sessionId: AGENT.id, plugin: { kind: 'existing', pluginId: first.pluginId }, name: 'second', purpose: 'race successor',
        code: { host: 'return { name: \'second\', inject: [\'late\'], apply() {} }' },
      })
      expect(value(await call(ctx, 'cordis_run', {
        pluginId: String(first.pluginId), packageId: String(second.packageId), mode: 'update',
      }))).toMatchObject({ host: { status: 'absent', provides: [], waitingFor: [] } })
    } finally {
      snapshotSpy.mockRestore()
    }
    expect(Object.getOwnPropertyDescriptor(runner, 'snapshot')).toEqual(snapshotDescriptor)
  })

  it('[white-box runner owner] projects missing Fiber/latestRun fields without inventing state', async () => {
    const { ctx, runner } = await setup()
    const defined = runner.define({
      sessionId: AGENT.id, plugin: { kind: 'new', idPrefix: 'stale' }, name: 'stale', purpose: 'stale projection',
      code: { host: 'return { name: \'stale\', inject: [\'late\'], apply() {} }' },
    })
    await runner.run(AGENT, defined.pluginId, defined.packageId, 'run')
    const registryValue: unknown = Reflect.get(runner, 'registry')
    if (!isWhiteBoxRegistry(registryValue)) throw new Error('missing runner-owned registry')
    const registry = registryValue
    const plugin = registry.get(defined.pluginId)
    if (plugin?.run === undefined || plugin.latestRun === undefined) throw new Error('missing live dynamic run')
    const originalLatest = plugin.latestRun
    const fiberDescriptor = Object.getOwnPropertyDescriptor(plugin.run, 'fiber')
    const latestDescriptor = Object.getOwnPropertyDescriptor(plugin, 'latestRun')
    const statusDescriptor = Object.getOwnPropertyDescriptor(originalLatest, 'status')
    let disposeLate: (() => void) | undefined
    try {
      Reflect.deleteProperty(plugin.run, 'fiber')
      expect(describeDynamic(ctx, AGENT).join('\n')).toContain('provides: none; waiting for: none')
      expect(value(await call(ctx, 'cordis_inspect_self', {
        pluginId: String(defined.pluginId), packageId: String(defined.packageId),
      }))).toMatchObject({ runtime: { host: { status: 'waiting', provides: [], waitingFor: ['late'] } } })

      if (!Reflect.set(originalLatest, 'status', 'starting-host')) throw new Error('could not set owner attempt state')
      expect(value(await call(ctx, 'cordis_inspect_self', { pluginId: String(defined.pluginId) })))
        .toMatchObject({ state: 'defined' })
      restoreOwnProperty(plugin.run, 'fiber', fiberDescriptor)
      Reflect.deleteProperty(plugin, 'latestRun')
      expect(value(await call(ctx, 'cordis_inspect_self', {
        pluginId: String(defined.pluginId), packageId: String(defined.packageId),
      }))).toMatchObject({ runtime: { host: { status: 'waiting', waitingFor: ['late'] } } })
      disposeLate = ctx.provide('late', {})
      expect(value(await call(ctx, 'cordis_inspect_self', {
        pluginId: String(defined.pluginId), packageId: String(defined.packageId),
      }))).toMatchObject({ runtime: { host: { status: 'running', waitingFor: [] } } })
      expect(value(await call(ctx, 'cordis_inspect_self', { pluginId: String(defined.pluginId) })))
        .toMatchObject({ state: 'running' })
    } finally {
      disposeLate?.()
      restoreOwnProperty(originalLatest, 'status', statusDescriptor)
      restoreOwnProperty(plugin, 'latestRun', latestDescriptor)
      restoreOwnProperty(plugin.run, 'fiber', fiberDescriptor)
    }
    expect(Object.getOwnPropertyDescriptor(originalLatest, 'status')).toEqual(statusDescriptor)
    expect(Object.getOwnPropertyDescriptor(plugin, 'latestRun')).toEqual(latestDescriptor)
    expect(Object.getOwnPropertyDescriptor(plugin.run, 'fiber')).toEqual(fiberDescriptor)
  })

  it('[white-box Cordis owner] renders a provider Fiber transitional state and restores it', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin({ name: 'pending-provider', apply(inner) { inner.provide('pendingService', {}) } })
    const stateDescriptor = Object.getOwnPropertyDescriptor(fiber, 'state')
    const originalState: unknown = Reflect.get(fiber, 'state')
    if (typeof originalState !== 'number') throw new Error('missing Cordis-owned Fiber state')
    try {
      if (!Reflect.set(fiber, 'state', 0)) throw new Error('could not set Cordis Fiber state')
      expect(describeServices(ctx, [{
        key: 'pendingService', summary: 'Pending provider.', description: 'Pending provider.', methods: [],
      }]).join('\n')).toContain(', pending')
    } finally {
      restoreOwnProperty(fiber, 'state', stateDescriptor)
    }
    expect(Object.getOwnPropertyDescriptor(fiber, 'state')).toEqual(stateDescriptor)
  })
})

interface WhiteBoxRunRecord {
  fiber?: unknown
}

interface WhiteBoxAttemptRecord {
  status: string
}

interface WhiteBoxPluginRecord {
  run?: WhiteBoxRunRecord
  latestRun?: WhiteBoxAttemptRecord
}

interface WhiteBoxRegistry {
  get(id: string): WhiteBoxPluginRecord | undefined
}

function isWhiteBoxRegistry(value: unknown): value is WhiteBoxRegistry {
  return typeof value === 'object' && value !== null && typeof Reflect.get(value, 'get') === 'function'
}

function requiredStringProperty(value: unknown, key: PropertyKey): string {
  if (typeof value !== 'object' || value === null) throw new Error(`missing object property ${String(key)}`)
  const property: unknown = Reflect.get(value, key)
  if (typeof property !== 'string') throw new Error(`missing string property ${String(key)}`)
  return property
}

function requiredObjectProperty(value: unknown, key: PropertyKey): object {
  if (typeof value !== 'object' || value === null) throw new Error(`missing object property ${String(key)}`)
  const property: unknown = Reflect.get(value, key)
  if (typeof property !== 'object' || property === null) throw new Error(`missing object property ${String(key)}`)
  return property
}

function requiredArrayProperty(value: unknown, key: PropertyKey): unknown[] {
  if (typeof value !== 'object' || value === null) throw new Error(`missing object property ${String(key)}`)
  const property: unknown = Reflect.get(value, key)
  if (!Array.isArray(property)) throw new Error(`missing array property ${String(key)}`)
  return property
}

function restoreOwnProperty(target: object, key: PropertyKey, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor === undefined) Reflect.deleteProperty(target, key)
  else Object.defineProperty(target, key, descriptor)
}
