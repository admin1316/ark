import { Context } from '@deepseek-ai/cordis'
import type { JsonValue } from '@deepseek-ai/dsh-session/types'
import { describe, expect, it, vi } from 'vitest'
import {
  guardedPlugin, isPlugin, pluginName, sandboxDefineTool, sandboxRegisterTool,
} from '../src/guard.ts'
import {
  CordisInspectRegistryService,
  CordisDynamicPackageId,
  CordisDynamicPluginId,
  CordisDynamicPluginRunId,
  DynamicCordisRunnerService,
} from '../src/index.ts'
import type { DynamicCordisPlugin } from '../src/registry.ts'
import {
  cloneAttempt, inspectPackageFor, inspectPluginFor, inventoryRows, listPluginsFor,
  referenceFor, snapshotRows,
} from '../src/queries.ts'
import { evaluateHostCode, precheckCode } from '../src/sandbox.ts'
import { formatErrorDetails, steerGuardFailure } from '../src/steering.ts'
import { AGENT_A, AGENT_B, call, mount, setup, text } from './helpers.ts'

const CONTENT_OUTPUT = {
  schema: { type: 'json' },
  render: () => [{ type: 'text', text: 'ok' }],
}

function dynamicTool(parameters: unknown, overrides: Record<string, unknown> = {}) {
  return sandboxDefineTool({
    name: 'contract_probe',
    description: 'exercise the real sandbox tool boundary',
    parameters,
    output: CONTENT_OUTPUT,
    execute: async () => ({ ok: true }),
    ...overrides,
  })
}

function executeToolBoundary(tool: ReturnType<typeof dynamicTool>, args: unknown): Promise<unknown> {
  const execute: unknown = Reflect.get(tool, 'execute')
  if (typeof execute !== 'function') throw new Error('missing dynamic tool execute boundary')
  return Promise.resolve(Reflect.apply(execute, tool, [args, {}]))
}

describe('sandbox tool boundary', () => {
  it('normalizes the complete host DSL and preserves only JSON-owned output', async () => {
    const tool = dynamicTool({
      text: { type: 'string', required: true, enum: ['a', 'b'], description: 'text' },
      number: { type: 'number', const: 2, default: 2 },
      integer: { type: 'integer' },
      boolean: { type: 'boolean' },
      nothing: { type: 'null' },
      json: { type: 'json', examples: [{ nested: true }] },
      object: {
        type: 'object',
        additionalProperties: false,
        properties: { child: { type: 'string', required: true } },
      },
      array: { type: 'array', items: { type: 'number' } },
      variant: { oneOf: [{ type: 'string' }, { type: 'number' }] },
    }, {
      output: {
        schema: { type: 'json' },
        render: () => [{ type: 'text', text: 'rendered' }],
        presentationMeta: () => ({ origin: 'sandbox' }),
      },
      execute: async () => ({ nested: ['value'] }),
    })

    expect(tool.parameters).toMatchObject({
      type: 'object',
      required: ['text'],
      properties: {
        text: { type: 'string', enum: ['a', 'b'] },
        number: { type: 'number', const: 2, default: 2 },
        object: { type: 'object', additionalProperties: false, required: ['child'], properties: { child: { type: 'string' } } },
        array: { type: 'array', items: { type: 'number' } },
        variant: { oneOf: [{ type: 'string' }, { type: 'number' }] },
      },
    })
    await expect(executeToolBoundary(tool, { text: 'a' })).resolves.toEqual({ nested: ['value'] })
    expect(tool.output.render({}, {})).toEqual([{ type: 'text', text: 'rendered' }])
    expect(tool.output.presentationMeta?.({}, {})).toEqual({ origin: 'sandbox' })
  })

  it('accepts a raw JSON-schema wrapper and rebuilds nested required fields', () => {
    const tool = dynamicTool({
      type: 'object',
      additionalProperties: true,
      required: ['payload'],
      title: 'root',
      properties: {
        payload: {
          type: 'object',
          additionalProperties: false,
          required: ['id'],
          properties: {
            id: { type: 'string' },
            optional: { description: 'lossless JSON' },
          },
        },
      },
    })

    expect(tool.parameters).toMatchObject({
      type: 'object',
      title: 'root',
      required: ['payload'],
      properties: {
        payload: {
          type: 'object',
          additionalProperties: false,
          required: ['id'],
          properties: {
            id: { type: 'string' },
            optional: { description: 'lossless JSON' },
          },
        },
      },
    })
  })

  it.each([
    [null, 'parameters must be a ParameterSchemaSpec object'],
    [{ type: 'object', properties: {}, additionalProperties: false }, 'additionalProperties must be true or omitted'],
    [{ type: 'object', properties: [], additionalProperties: true }, 'properties must be an object of schemas'],
    [{ type: 'object', properties: {}, required: undefined }, 'required must be an array'],
    [{ bad: { type: 'missing' } }, 'must declare a valid type'],
    [{ bad: { type: 'object' } }, 'additionalProperties must be explicitly true or false'],
    [{ bad: { type: 'object', additionalProperties: 'no' } }, 'additionalProperties must be explicitly true or false'],
    [{ bad: { type: 'array', items: 42 } }, 'must be a ParameterSchemaSpec property object'],
    [{ bad: { type: 'string', enum: [] } }, 'enum must be a non-empty array'],
    [{ bad: { oneOf: [{ type: 'string' }] } }, 'oneOf must contain at least two schemas'],
    [{ bad: { type: 'string', required: false } }, 'required must be true when present'],
    [{ bad: { type: 'string', extra: true } }, 'is not supported by the unified schema DSL'],
  ])('rejects an invalid schema with its authored teaching boundary: %j', (parameters, message) => {
    expect(() => dynamicTool(parameters)).toThrow(message)
  })

  it('rejects circular, non-JSON, and malformed renderer values before they cross into the tool registry', async () => {
    const circular: { type: string; additionalProperties: boolean; properties: Record<string, unknown> } = {
      type: 'object', additionalProperties: false, properties: {},
    }
    circular.properties.self = circular
    expect(() => dynamicTool({ value: circular })).toThrow('is circular')

    const nonJson = dynamicTool({}, { execute: async () => new Map([['secret', 'no']]) })
    await expect(executeToolBoundary(nonJson, {})).rejects.toThrow('must be lossless JSON data')

    const malformedRenderer = dynamicTool({}, {
      output: { schema: { type: 'json' }, render: () => [{ text: 'missing tag' }] },
    })
    expect(() => malformedRenderer.output.render({}, {})).toThrow('must return an ARRAY of content blocks')
  })

  it('rejects lossy realm-shaped declarations and values rather than normalizing them by coercion', async () => {
    const malformedRequired: unknown[] = []
    Object.setPrototypeOf(malformedRequired, {})
    expect(() => dynamicTool({ type: 'object', properties: {}, additionalProperties: true, required: malformedRequired }))
      .toThrow('must be an array of declared property names')

    const nonFunctionPrototype: unknown[] = []
    Object.defineProperty(nonFunctionPrototype, 'constructor', { value: 1 })
    const nonFunctionList: unknown[] = []
    Object.setPrototypeOf(nonFunctionList, nonFunctionPrototype)
    expect(() => dynamicTool({ type: 'object', properties: {}, additionalProperties: true, required: nonFunctionList }))
      .toThrow('must be an array of declared property names')

    const revoked = Proxy.revocable(function Array() {}, {})
    revoked.revoke()
    const revokedPrototype: unknown[] = []
    Object.defineProperty(revokedPrototype, 'constructor', { value: revoked.proxy })
    const revokedList: unknown[] = []
    Object.setPrototypeOf(revokedList, revokedPrototype)
    expect(() => dynamicTool({ type: 'object', properties: {}, additionalProperties: true, required: revokedList }))
      .toThrow('must be an array of declared property names')

    const hiddenIndex: unknown[] = []
    hiddenIndex.length = 1
    Object.defineProperty(hiddenIndex, 'extra', { value: true })
    expect(() => dynamicTool({ type: 'object', properties: {}, additionalProperties: true, required: hiddenIndex }))
      .toThrow('must be an array of declared property names')

    const hiddenSchema: Record<string, unknown> = { type: 'string' }
    Object.defineProperty(hiddenSchema, 'secret', { value: true })
    expect(() => dynamicTool({ value: hiddenSchema })).toThrow('only own enumerable string keys')

    for (const value of [Infinity, -0, undefined, new Date()]) {
      const tool = dynamicTool({}, { execute: async () => value })
      await expect(executeToolBoundary(tool, {})).rejects.toThrow('must be lossless JSON data')
    }

    const sparse: unknown[] = []
    sparse.length = 1
    const arrayTool = dynamicTool({}, { execute: async () => sparse })
    await expect(executeToolBoundary(arrayTool, {})).rejects.toThrow('must be lossless JSON data')

    const hiddenArray: unknown[] = []
    hiddenArray.length = 1
    Object.defineProperty(hiddenArray, 'extra', { value: true })
    const holeTool = dynamicTool({}, { execute: async () => hiddenArray })
    await expect(executeToolBoundary(holeTool, {})).rejects.toThrow('must be lossless JSON data')

    const hiddenReturn: Record<string, unknown> = { ok: true }
    Object.defineProperty(hiddenReturn, 'extra', { value: true })
    const hiddenTool = dynamicTool({}, { execute: async () => hiddenReturn })
    await expect(executeToolBoundary(hiddenTool, {})).rejects.toThrow('must be lossless JSON data')
  })

  it('covers raw-schema omissions and nested object boundary failures', () => {
    expect(() => dynamicTool({ type: 'object', properties: {}, additionalProperties: true, required: 'not-an-array' }))
      .toThrow('must be an array of declared property names')
    expect(() => dynamicTool({ type: 'object', properties: { value: { type: 'string' } }, additionalProperties: true, required: [42] }))
      .toThrow('must be an array of declared property names')
    expect(() => dynamicTool({ type: 'object', properties: {}, additionalProperties: true, required: ['missing'] }))
      .toThrow('names undeclared property')
    expect(() => dynamicTool({ type: 'object', properties: {}, additionalProperties: true }))
      .not.toThrow()
    expect(() => dynamicTool({
      type: 'object', properties: {
        value: { type: 'string', required: ['wrong'] },
      }, additionalProperties: true,
    })).toThrow('required belongs to the containing raw object schema')
    expect(() => dynamicTool({
      type: 'object', properties: {
        value: { type: 'object', additionalProperties: 'false' },
      }, additionalProperties: true,
    })).toThrow('additionalProperties must be a boolean')
    expect(() => dynamicTool({
      type: 'object', properties: {
        value: { type: 'object', required: undefined },
      }, additionalProperties: true,
    })).toThrow('required must be an array')
    expect(() => dynamicTool({
      type: 'object', properties: {
        value: { type: 'object', properties: 42 },
      }, additionalProperties: true,
    })).toThrow('properties must be an object of schemas')
    expect(() => dynamicTool({
      type: 'object', properties: {
        value: { type: 'object', required: ['missing'] },
      }, additionalProperties: true,
    })).toThrow('names undeclared property')

    const properties: Record<string, unknown> = {}
    properties.loop = { type: 'object', additionalProperties: true, properties }
    expect(() => dynamicTool({ type: 'object', properties, additionalProperties: true })).toThrow('is circular')
    expect(() => dynamicTool({
      type: 'object', properties: { emptyObject: { type: 'object' } }, additionalProperties: true,
    })).not.toThrow()
    expect(() => dynamicTool({ arrayWithoutItems: { type: 'array' } })).not.toThrow()
  })

  it('only registers marker-provenance definitions and tears that registration down', async () => {
    const harness = await setup()
    expect(() => sandboxRegisterTool(harness.ctx, { name: 'forged' })).toThrow('must use a tool returned')

    const tool = dynamicTool({})
    const dispose = sandboxRegisterTool(harness.ctx, tool)
    expect(harness.ctx.tools.get('contract_probe')).toBeDefined()
    dispose()
    expect(harness.ctx.tools.get('contract_probe')).toBeUndefined()
  })

  it('narrowly accepts plugins and passes a guarded context to both plugin forms', async () => {
    const failures = vi.fn()
    expect(isPlugin(() => {})).toBe(true)
    expect(isPlugin({ apply() {} })).toBe(true)
    expect(isPlugin({})).toBe(false)
    const anonymous = { apply() {} }
    const named = { name: 'named', apply() {} }
    if (!isPlugin(anonymous) || !isPlugin(named)) throw new Error('expected valid plugin fixtures')
    expect(pluginName(anonymous)).toBe('<anonymous>')
    expect(pluginName(named)).toBe('named')

    const ctx = new Context()
    let functionSawGet = false
    await ctx.plugin(guardedPlugin((inner) => { functionSawGet = typeof inner.get === 'function' }, failures))
    let objectSawReadOnly = false
    await ctx.plugin(guardedPlugin({
      name: 'object-form',
      apply(inner) { objectSawReadOnly = !( 'root' in inner) },
    }, failures))
    expect(functionSawGet).toBe(true)
    expect(objectSawReadOnly).toBe(true)
    expect(failures).not.toHaveBeenCalled()
  })

  it('exposes only declared timer and tool schema access through the live guarded Context', async () => {
    const harness = await setup()
    await expect(mount(harness, `
      return { name: 'timer-denied', apply(ctx) { ctx.timeout(() => {}, 1) } }
    `)).rejects.toThrow('service "timer" is not injected')
    await mount(harness, `
      return {
        name: 'schema-reader', inject: ['tools', 'timer'],
        apply(ctx) {
          const schemas = ctx.get('tools').schemas()
          if (!('timer' in ctx) || !('timeout' in ctx) || schemas.length < 0) throw new Error('missing guarded access')
        },
      }
    `)
  })
})

describe('Host inspect registry', () => {
  const agent = AGENT_A

  function registration(
    query: (input: JsonValue | undefined, signal: AbortSignal) => JsonValue | Promise<JsonValue> = () => ({ ok: true }),
  ) {
    return {
      manifest: {
        id: 'Probe',
        description: 'A real read-only probe.',
        methods: [{
          name: 'read',
          description: 'Read the probe.',
          inputSchema: { type: 'object', properties: { value: { type: 'string' } }, additionalProperties: false },
          outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
        }],
      },
      query(_method: string, input: JsonValue | undefined, context: { signal: AbortSignal }) {
        return Promise.resolve(query(input, context.signal))
      },
    }
  }

  it('validates provider identity, query schemas, cancellation, output ownership, and disposer ownership', async () => {
    const ctx = new Context()
    const registry = new CordisInspectRegistryService(ctx)
    const dispose = registry.register(registration())
    const listed = registry.list()
    expect(listed).toMatchObject([{ id: 'Probe', platform: 'host', methods: [{ name: 'read' }] }])
    expect(() => registry.register(registration())).toThrow('already registered')

    const result = await registry.query('host', 'Probe', 'read', { value: 'ok' }, agent, new AbortController().signal)
    expect(result).toEqual({ ok: true })
    await expect(registry.query('host', 'Probe', 'read', null, agent, new AbortController().signal)).resolves.toEqual({ ok: true })
    const queryMethod: unknown = Reflect.get(registry, 'query')
    if (typeof queryMethod !== 'function') throw new Error('missing inspect query method')
    await expect(Promise.resolve(Reflect.apply(queryMethod, registry, [
      'browser', 'Probe', 'read', {}, agent, new AbortController().signal,
    ]))).rejects.toThrow('not available')
    await expect(registry.query('host', 'missing', 'read', {}, agent, new AbortController().signal)).rejects.toThrow('not registered')
    await expect(registry.query('host', 'Probe', 'missing', {}, agent, new AbortController().signal)).rejects.toThrow('has no method')
    await expect(registry.query('host', 'Probe', 'read', { extra: true }, agent, new AbortController().signal)).rejects.toThrow('rejected input')

    const before = new AbortController()
    before.abort()
    await expect(registry.query('host', 'Probe', 'read', {}, agent, before.signal)).rejects.toThrow(/abort/i)

    const after = new AbortController()
    registry.register({ ...registration((_input, signal) => {
      after.abort()
      return { ok: true, signalAborted: signal.aborted }
    }), manifest: { ...registration().manifest, id: 'After' } })
    await expect(registry.query('host', 'After', 'read', {}, agent, after.signal)).rejects.toThrow(/abort/i)

    registry.register({ ...registration(() => ({ nope: true })), manifest: { ...registration().manifest, id: 'BadOutput' } })
    await expect(registry.query('host', 'BadOutput', 'read', {}, agent, new AbortController().signal)).rejects.toThrow('returned invalid output')
    const undefinedOutput = registration()
    Reflect.set(undefinedOutput, 'query', async () => undefined)
    registry.register({ ...undefinedOutput, manifest: { ...registration().manifest, id: 'UndefinedOutput' } })
    await expect(registry.query('host', 'UndefinedOutput', 'read', {}, agent, new AbortController().signal)).rejects.toThrow('non-JSON')

    dispose()
    dispose()
    expect(registry.list()).not.toContainEqual(expect.objectContaining({ id: 'Probe' }))
  })

  it.each([
    [{ id: ' ', description: 'x', methods: [] }, 'id must not be empty'],
    [{ id: 'x', description: ' ', methods: [] }, 'needs a description'],
    [{ id: 'x', description: 'x', methods: [{ name: ' ', description: 'x', inputSchema: {}, outputSchema: {} }] }, 'empty method name'],
    [{ id: 'x', description: 'x', methods: [
      { name: 'same', description: 'x', inputSchema: {}, outputSchema: {} },
      { name: 'same', description: 'x', inputSchema: {}, outputSchema: {} },
    ] }, 'repeats method'],
    [{ id: 'x', description: 'x', methods: [{ name: 'read', description: ' ', inputSchema: {}, outputSchema: {} }] }, 'needs a description'],
  ])('rejects malformed manifest ownership at registration: %j', (manifest, message) => {
    const registry = new CordisInspectRegistryService(new Context())
    expect(() => registry.register({ manifest, query: async () => ({}) })).toThrow(message)
  })
})

describe('registry projections and lifecycle boundaries', () => {
  function fixture(): DynamicCordisPlugin {
    const pluginId = CordisDynamicPluginId('probe-1')
    const packageId = CordisDynamicPackageId('pkg-1')
    return {
      pluginId,
      sessionId: AGENT_A.id,
      packages: new Map([[packageId, { packageId, name: 'Probe', purpose: 'exercise projections', hostCode: 'return {}' }]]),
      currentPackageId: packageId,
      nextPackageId: packageId,
      run: { pluginRunId: CordisDynamicPluginRunId('run-1'), packageId, reportedRuntimeErrors: new Set() },
      latestRun: {
        pluginRunId: CordisDynamicPluginRunId('run-1'), packageId, mode: 'run', status: 'running',
        host: { status: 'running', waitingFor: ['late'] },
        error: { phase: 'host-guard', message: 'guard', pluginId, packageId, pluginRunId: CordisDynamicPluginRunId('run-1') },
      },
    }
  }

  it('keeps inventory source-free, session-owned, and detached from future mutable state', () => {
    const plugin = fixture()
    const registry = {
      all: () => [plugin],
      ofSession: (id: string) => id === AGENT_A.id ? [plugin] : [],
      get: (id: string) => id === plugin.pluginId ? plugin : undefined,
    }
    const inventory = inventoryRows(registry)
    const snapshot = snapshotRows(registry, AGENT_A)
    const reference = referenceFor(registry, AGENT_A, plugin.pluginId)
    expect(inventory[0]).not.toHaveProperty('hostCode')
    expect(snapshot[0]?.activeRun).toMatchObject({ pluginRunId: 'run-1' })
    expect(reference).toMatchObject({ pluginId: 'probe-1', packageId: 'pkg-1' })
    expect(listPluginsFor(registry, AGENT_A)).toHaveLength(1)
    expect(inspectPluginFor(registry, AGENT_A, plugin.pluginId).packages).toHaveLength(1)
    expect(inspectPackageFor(registry, AGENT_A, plugin.pluginId, CordisDynamicPackageId('pkg-1')).code).toEqual({ host: 'return {}' })
    if (plugin.latestRun !== undefined) {
      plugin.latestRun.host = { ...plugin.latestRun.host, waitingFor: [...plugin.latestRun.host.waitingFor, 'mutated'] }
    }
    expect(inventory[0]?.latestRun?.host.waitingFor).toEqual(['late'])
    if (plugin.latestRun === undefined) throw new Error('missing latest run fixture')
    expect(cloneAttempt(plugin.latestRun).error).toMatchObject({ message: 'guard' })
    expect(referenceFor(registry, AGENT_B, plugin.pluginId)).toBeUndefined()
    expect(() => inspectPluginFor(registry, AGENT_B, plugin.pluginId)).toThrow('no dynamic plugin')
    expect(() => inspectPackageFor(registry, AGENT_A, plugin.pluginId, CordisDynamicPackageId('missing'))).toThrow('does not exist')

    const unversioned: DynamicCordisPlugin = {
      pluginId: CordisDynamicPluginId('empty-1'), sessionId: AGENT_A.id, packages: new Map(),
    }
    const dangling: DynamicCordisPlugin = {
      pluginId: CordisDynamicPluginId('dangling-1'), sessionId: AGENT_A.id, packages: new Map(),
      nextPackageId: CordisDynamicPackageId('pkg-missing'),
    }
    const sparseRegistry = {
      all: () => [unversioned, dangling],
      ofSession: (id: string) => id === AGENT_A.id ? [unversioned, dangling] : [],
      get: (id: string) => id === unversioned.pluginId ? unversioned : id === dangling.pluginId ? dangling : undefined,
    }
    expect(inventoryRows(sparseRegistry)).toEqual(expect.arrayContaining([expect.objectContaining({ pluginId: 'empty-1' })]))
    expect(snapshotRows(sparseRegistry, AGENT_A)[0]).not.toHaveProperty('activeRun')
    expect(referenceFor(sparseRegistry, AGENT_A, unversioned.pluginId)).toBeUndefined()
    expect(referenceFor(sparseRegistry, AGENT_A, dangling.pluginId)).toBeUndefined()
    expect(() => inspectPluginFor(sparseRegistry, AGENT_A, unversioned.pluginId)).toThrow('has no package')
    expect(() => inspectPackageFor(sparseRegistry, AGENT_A, CordisDynamicPluginId('missing'), CordisDynamicPackageId('pkg-1'))).toThrow('no dynamic plugin')
  })

  it('runs success, cancelled, invalid-mode, concurrent, failure, guard-reporting, stop, and removal paths through the real runner', async () => {
    const harness = await setup()
    const owner = AGENT_A
    const steerDescriptor = Object.getOwnPropertyDescriptor(owner, 'steer')
    const steerSpy = vi.spyOn(owner, 'steer').mockImplementation(() => {})
    const disposeAgents = harness.ctx.provide('agents', { get: (id: string) => id === owner.id ? owner : undefined })

    try {
      for (const request of [
        { name: ' ', purpose: 'p', code: { host: 'return { apply() {} }' }, message: 'non-empty `name`' },
        { name: 'n', purpose: ' ', code: { host: 'return { apply() {} }' }, message: 'non-empty `purpose`' },
        { name: 'n', purpose: 'p', code: { host: ' ' }, message: 'non-empty `code.host`' },
      ]) {
        expect(() => harness.runner.define({ sessionId: owner.id, plugin: { kind: 'new', idPrefix: 'probe' }, ...request })).toThrow(request.message)
      }
      expect(() => harness.runner.define({
        sessionId: owner.id, plugin: { kind: 'new', idPrefix: 'TOO-LONG' }, name: 'n', purpose: 'p', code: { host: 'return { apply() {} }' },
      })).toThrow('3–6 lowercase')

      const defined = harness.runner.define({
        sessionId: owner.id, plugin: { kind: 'new', idPrefix: 'probe' }, name: 'first', purpose: 'first package', code: { host: 'return { name: "first", apply() {} }' },
      })
      const aborted = new AbortController()
      aborted.abort()
      await expect(harness.runner.run(owner, defined.pluginId, defined.packageId, 'run', aborted.signal)).resolves.toMatchObject({ ok: false, reason: 'host-half-failed' })
      await expect(harness.runner.run(AGENT_B, defined.pluginId, defined.packageId, 'run')).resolves.toMatchObject({ ok: false, reason: 'plugin-missing' })
      expect(() => harness.runner.define({
        sessionId: AGENT_B.id, plugin: { kind: 'existing', pluginId: defined.pluginId }, name: 'foreign', purpose: 'foreign', code: { host: 'return { apply() {} }' },
      })).toThrow('no dynamic plugin')
      await expect(harness.runner.run(owner, defined.pluginId, CordisDynamicPackageId('missing'), 'run')).resolves.toMatchObject({ ok: false, reason: 'package-missing' })
      await expect(harness.runner.run(owner, defined.pluginId, defined.packageId, 'update')).resolves.toMatchObject({ ok: false, reason: 'invalid-mode' })

      await expect(harness.runner.run(owner, defined.pluginId, defined.packageId, 'run')).resolves.toMatchObject({ ok: true, status: 'running' })
      expect(harness.runner.reference(owner, defined.pluginId)).toMatchObject({ pluginId: defined.pluginId })
      expect(harness.runner.listPlugins(owner)).toHaveLength(1)
      expect(harness.runner.inspectPlugin(owner, defined.pluginId)).toMatchObject({ pluginId: defined.pluginId })
      await expect(harness.runner.run(owner, defined.pluginId, defined.packageId, 'update')).resolves.toMatchObject({ ok: false, reason: 'invalid-mode' })
      await expect(harness.runner.run(owner, defined.pluginId, defined.packageId, 'run')).resolves.toMatchObject({ ok: true, mode: 'run' })
      const second = harness.runner.define({
        sessionId: owner.id, plugin: { kind: 'existing', pluginId: defined.pluginId }, name: 'second', purpose: 'second package',
        code: { host: 'await Promise.resolve(); return { name: "second", apply() {} }' },
      })
      await expect(harness.runner.run(owner, defined.pluginId, second.packageId, 'run')).resolves.toMatchObject({ ok: false, reason: 'invalid-mode' })
      const activation = harness.runner.run(owner, defined.pluginId, second.packageId, 'update')
      await expect(harness.runner.run(owner, defined.pluginId, second.packageId, 'update')).resolves.toMatchObject({ ok: false, reason: 'transition-in-flight' })
      await expect(activation).resolves.toMatchObject({ ok: true, mode: 'update' })

      const failing = harness.runner.define({
        sessionId: owner.id, plugin: { kind: 'existing', pluginId: defined.pluginId }, name: 'broken', purpose: 'broken package', code: { host: 'return 42' },
      })
      await expect(harness.runner.run(owner, defined.pluginId, failing.packageId, 'update')).resolves.toMatchObject({ ok: false, reason: 'host-half-failed' })
      expect(harness.runner.inspectPackage(owner, defined.pluginId, failing.packageId).latestRun).toMatchObject({ status: 'failed' })

      const guarded = harness.runner.define({
        sessionId: owner.id, plugin: { kind: 'existing', pluginId: defined.pluginId }, name: 'guarded', purpose: 'guarded package',
        code: { host: 'return { name: \'guarded\', inject: [\'tools\'], apply(ctx) { harness.registerTool(ctx, harness.defineTool({ name: \'trip_guard\', description: \'trip guard\', parameters: {}, output: { schema: { type: \'null\' }, render() { return [] } }, async execute() { return ctx.root } })) } }' },
      })
      await expect(harness.runner.run(owner, defined.pluginId, guarded.packageId, 'update')).resolves.toMatchObject({ ok: true })
      await call(harness.ctx, 'trip_guard', {})
      await call(harness.ctx, 'trip_guard', {})
      expect(steerSpy).toHaveBeenCalledTimes(1)
      expect(text(await call(harness.ctx, 'trip_guard', {}))).toContain('sandbox ctx does not expose')

      await expect(harness.runner.stop(owner, defined.pluginId)).resolves.toEqual({ ok: true })
      await expect(harness.runner.stop(owner, defined.pluginId)).resolves.toMatchObject({ ok: false, reason: 'not-running' })
      await expect(harness.runner.stop(owner, CordisDynamicPluginId('missing'))).resolves.toMatchObject({ ok: false, reason: 'plugin-missing' })
      await expect(harness.runner.undefine(owner, defined.pluginId)).resolves.toEqual({ ok: true, wasRunning: false })
      await expect(harness.runner.undefine(owner, defined.pluginId)).resolves.toMatchObject({ ok: false, reason: 'plugin-missing' })
    } finally {
      disposeAgents()
      steerSpy.mockRestore()
    }
    expect(Object.getOwnPropertyDescriptor(owner, 'steer')).toEqual(steerDescriptor)
  })

  /**
   * WHITE-BOX DEFENSIVE OWNER TEST. DynamicCordisRunnerService exclusively
   * owns this process-local registry and its run/attempt fields. The synthetic
   * states below verify its fail-closed guards only; they are not cited as
   * public tool-closure or ordinary producer evidence.
  */
  it('[white-box runner owner] keeps stale cleanup and failure deduplication fail-closed', async () => {
    const harness = await setup()
    const pluginId = CordisDynamicPluginId('stale-1')
    const packageId = CordisDynamicPackageId('pkg-stale')
    const run = { pluginRunId: CordisDynamicPluginRunId('run-stale'), packageId, reportedRuntimeErrors: new Set<string>() }
    const plugin: DynamicCordisPlugin = {
      pluginId, sessionId: AGENT_A.id, packages: new Map(), run,
      latestRun: { pluginRunId: run.pluginRunId, packageId, mode: 'run', status: 'running', host: { status: 'running', waitingFor: [] } },
    }
    await expect(Promise.resolve(invokeRunnerOwner(harness.runner, 'retract', [{ ...plugin, run: undefined }])))
      .resolves.toBeUndefined()
    expect(invokeRunnerOwner(harness.runner, 'runResponse', [plugin, run, 'run']))
      .toMatchObject({ status: 'running', waitingFor: [] })
    expect(invokeRunnerOwner(harness.runner, 'claimRuntimeFailure', [plugin, run, 'one'])).toBe(true)
    expect(invokeRunnerOwner(harness.runner, 'claimRuntimeFailure', [plugin, run, 'one'])).toBe(false)
    plugin.latestRun = {
      pluginRunId: CordisDynamicPluginRunId('other'),
      packageId,
      mode: 'run',
      status: 'running',
      host: { status: 'running', waitingFor: [] },
    }
    expect(invokeRunnerOwner(harness.runner, 'claimRuntimeFailure', [plugin, run, 'two'])).toBe(false)
    plugin.latestRun = {
      pluginRunId: run.pluginRunId,
      packageId,
      mode: 'run',
      status: 'failed',
      host: { status: 'running', waitingFor: [] },
    }
    expect(invokeRunnerOwner(harness.runner, 'claimRuntimeFailure', [plugin, run, 'three'])).toBe(false)
    await expect(Promise.resolve(invokeRunnerOwner(harness.runner, 'retract', [plugin]))).resolves.toBeUndefined()

    const objectFailure = harness.runner.define({
      sessionId: AGENT_A.id, plugin: { kind: 'new', idPrefix: 'plain' }, name: 'plain', purpose: 'object error', code: { host: 'throw { code: "plain" }' },
    })
    await expect(harness.runner.run(AGENT_A, objectFailure.pluginId, objectFailure.packageId, 'run')).resolves.toMatchObject({ ok: false, reason: 'host-half-failed' })

    const live = harness.runner.define({
      sessionId: AGENT_A.id, plugin: { kind: 'new', idPrefix: 'live' }, name: 'live', purpose: 'active removal', code: { host: 'return { apply() {} }' },
    })
    await harness.runner.run(AGENT_A, live.pluginId, live.packageId, 'run')
    await expect(harness.runner.undefine(AGENT_A, live.pluginId)).resolves.toEqual({ ok: true, wasRunning: true })

    const registryValue: unknown = Reflect.get(harness.runner, 'registry')
    if (!isRunnerOwnerRegistry(registryValue)) throw new Error('missing runner-owned registry')
    const registry = registryValue
    const missingLatestId = CordisDynamicPluginId('missing-latest-1')
    registry.add({
      pluginId: missingLatestId,
      sessionId: AGENT_A.id,
      packages: new Map(),
      run: {
        pluginRunId: CordisDynamicPluginRunId('run-missing-latest'),
        packageId: CordisDynamicPackageId('pkg-missing-latest'),
        reportedRuntimeErrors: new Set(),
      },
    })
    await expect(harness.runner.stop(AGENT_A, missingLatestId)).resolves.toEqual({ ok: true })
    await expect(harness.runner.undefine(AGENT_A, missingLatestId)).resolves.toEqual({ ok: true, wasRunning: false })

    const staleGuard = harness.runner.define({
      sessionId: AGENT_A.id, plugin: { kind: 'new', idPrefix: 'stale' }, name: 'stale', purpose: 'stale guard diagnostic',
      code: { host: 'return { inject: [\'tools\'], apply(ctx) { harness.registerTool(ctx, harness.defineTool({ name: \'stale_trip\', description: \'stale\', parameters: {}, output: { schema: { type: \'null\' }, render() { return [] } }, async execute() { return ctx.root } })) } }' },
    })
    await harness.runner.run(AGENT_A, staleGuard.pluginId, staleGuard.packageId, 'run')
    const stalePlugin = registry.get(staleGuard.pluginId)
    if (stalePlugin?.latestRun === undefined) throw new Error('missing stale diagnostic')
    const currentAttempt = stalePlugin.latestRun
    const newerAttempt = { ...currentAttempt, pluginRunId: CordisDynamicPluginRunId('other-run') }
    const latestRunDescriptor = Object.getOwnPropertyDescriptor(stalePlugin, 'latestRun')
    let attemptReads = 0
    Object.defineProperty(stalePlugin, 'latestRun', {
      configurable: true,
      get() {
        attemptReads += 1
        return attemptReads === 1 ? currentAttempt : newerAttempt
      },
    })
    try {
      await call(harness.ctx, 'stale_trip', {})
      expect(newerAttempt.error).toBeUndefined()
    } finally {
      restoreOwnProperty(stalePlugin, 'latestRun', latestRunDescriptor)
    }
    expect(Object.getOwnPropertyDescriptor(stalePlugin, 'latestRun')).toEqual(latestRunDescriptor)
  })

  it('renders stack-aware steering without a live owner and executes source code in a real VM', async () => {
    expect(formatErrorDetails({ message: 'plain' })).toBe('message: plain')
    expect(formatErrorDetails({ message: 'stacked', stack: 'trace' })).toContain('stack:\ntrace')
    const plugin = fixture()
    if (plugin.run === undefined) throw new Error('missing fixture run')
    steerGuardFailure(undefined, plugin, plugin.run, { message: 'ignored' })
    precheckCode('return { apply() {} }', 'code.host')
    await expect(evaluateHostCode({}, 'return 1', 'direct', 100)).rejects.toThrow()
  })
})

interface RunnerOwnerRegistry {
  add(plugin: DynamicCordisPlugin): void
  get(id: string): DynamicCordisPlugin | undefined
}

function isRunnerOwnerRegistry(value: unknown): value is RunnerOwnerRegistry {
  return typeof value === 'object'
    && value !== null
    && typeof Reflect.get(value, 'add') === 'function'
    && typeof Reflect.get(value, 'get') === 'function'
}

function invokeRunnerOwner(
  runner: DynamicCordisRunnerService,
  methodName: 'retract' | 'runResponse' | 'claimRuntimeFailure',
  args: unknown[],
): unknown {
  const method: unknown = Reflect.get(runner, methodName)
  if (typeof method !== 'function') throw new Error(`missing runner owner method ${methodName}`)
  return Reflect.apply(method, runner, args)
}

function restoreOwnProperty(target: object, key: PropertyKey, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor === undefined) Reflect.deleteProperty(target, key)
  else Object.defineProperty(target, key, descriptor)
}
