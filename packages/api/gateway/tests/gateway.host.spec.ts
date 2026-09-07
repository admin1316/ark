/** Host-only strict Typert Gateway behavior and Connection handoff. */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import {
  TypertLookupFailure,
  TypertRemoteService,
  type InvocationDescriptor,
  type TypertContext,
  type TypertLookup,
} from '@deepseek-ai/dsh-typert-protocol'
import TypertGatewayService, {
  createTypertGatewayDispatcher,
} from '../src/index.ts'

type ConnectionRpcAuthority = 'trusted-host' | 'loopback'
type ConnectionRpcResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string; readonly details: object } }
type ConnectionRpcHandler = (
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
) => Promise<ConnectionRpcResult>

interface FixtureAgent {
  readonly id: string
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertLookupMap {
    gatewayFixture: TypertLookup<FixtureAgent, string>
  }

  interface TypertContextMap {
    gatewayFixture: TypertContext<string>
  }
}

class FakeConnectionService extends Service {
  matcher: ((endpoint: string) => boolean) | undefined
  handler: ConnectionRpcHandler | undefined
  authority: ConnectionRpcAuthority | undefined

  constructor(ctx: Context) {
    super(ctx, 'connection')
  }

  get rpc() {
    const owner = this.ctx
    return {
      handle: () => { throw new Error('fixture does not provide dedicated channels') },
      intercept: (
        channel: '/api',
        matcher: (endpoint: string) => boolean,
        handler: ConnectionRpcHandler,
        options: { authority: ConnectionRpcAuthority },
      ) => owner.effect(() => {
        if (channel !== '/api') throw new Error('fixture accepts only /api')
        this.matcher = matcher
        this.handler = handler
        this.authority = options.authority
        return () => {
          this.matcher = undefined
          this.handler = undefined
          this.authority = undefined
        }
      }),
    }
  }

  async request(endpoint: string, payload: unknown, signal = new AbortController().signal): Promise<Response> {
    if (this.matcher?.(endpoint) !== true || this.handler === undefined) {
      return new Response('not found', { status: 404 })
    }
    return Response.json({ result: await this.handler(endpoint, payload, signal) })
  }
}

class FixtureRemote extends TypertRemoteService {
  lastSignal: AbortSignal | undefined

  constructor(ctx: Context) {
    super(ctx, 'fixture')
  }

  run(agent: FixtureAgent, request: { readonly title: string }, signal: AbortSignal): object {
    this.lastSignal = signal
    return {
      agentId: agent.id,
      title: request.title,
      scope: 'root',
    }
  }

  scoped(request: { readonly title: string }): object {
    return {
      title: request.title,
      scope: 'root',
    }
  }
}

const stringCodec = {
  mode: 'strict' as const,
  typeSymbol: '@fixture/string',
  schema: {
    parse(value: unknown): string {
      if (typeof value !== 'string') throw new TypeError('expected string')
      return value
    },
  },
}

const requestCodec = {
  mode: 'strict' as const,
  typeSymbol: '@fixture/request',
  schema: {
    parse(value: unknown): { readonly title: string } {
      if (!isRecord(value) || typeof value.title !== 'string') throw new TypeError('expected request')
      return { title: value.title.trim() }
    },
  },
}

const resultCodec = {
  mode: 'strict' as const,
  typeSymbol: '@fixture/result',
  schema: {
    parse(value: unknown): { readonly agentId?: string; readonly title: string; readonly scope: string } {
      if (!isRecord(value)
        || (value.agentId !== undefined && typeof value.agentId !== 'string')
        || typeof value.title !== 'string'
        || typeof value.scope !== 'string') {
        throw new TypeError('expected result')
      }
      return {
        ...(value.agentId === undefined ? {} : { agentId: value.agentId }),
        title: value.title,
        scope: value.scope,
      }
    },
  },
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const packageRoot = fileURLToPath(new URL('..', import.meta.url))

const directDescriptor: InvocationDescriptor = {
  id: '@fixture/gateway#fixture/run',
  service: 'fixture',
  namespace: 'fixture',
  method: 'run',
  invocation: { kind: 'direct' },
  parameters: [
    {
      name: 'agent',
      wire: 'agentId',
      source: 'lookup',
      lookup: 'gatewayFixture',
      codec: stringCodec,
    },
    {
      name: 'request',
      wire: 'request',
      source: 'json',
      codec: requestCodec,
    },
  ],
  cancellation: { parameter: 'signal' },
  result: resultCodec,
}

const contextDescriptor: InvocationDescriptor = {
  id: '@fixture/gateway#fixture/scoped',
  service: 'fixture',
  namespace: 'fixture',
  method: 'scoped',
  invocation: {
    kind: 'context',
    context: 'gatewayFixture',
    wire: 'agentId',
    codec: stringCodec,
  },
  parameters: [{
    name: 'request',
    wire: 'request',
    source: 'json',
    codec: requestCodec,
  }],
  result: resultCodec,
}

async function setup(): Promise<{
  readonly ctx: Context
  readonly connection: FakeConnectionService
  readonly service: FixtureRemote
}> {
  const ctx = new Context()
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(FakeConnectionService)
  await ctx.plugin(TypertGatewayService)
  await ctx.plugin(FixtureRemote)
  return {
    ctx,
    connection: ctx.get('connection') as unknown as FakeConnectionService,
    service: ctx.get('fixture') as unknown as FixtureRemote,
  }
}

function register(ctx: Context, descriptors: readonly InvocationDescriptor[]): () => Promise<void> {
  return ctx.typert.register({
    package: '@fixture/gateway',
    face: 'host',
    schemas: [],
    model: { services: [], events: [], objects: [] },
    invocations: descriptors,
  })
}

describe('Host Typert Gateway', () => {
  it('publishes only a Host face with no Client or browser assembly metadata', () => {
    const manifest = JSON.parse(readFileSync(`${packageRoot}/package.json`, 'utf8')) as {
      dsh?: unknown
      exports?: Record<string, unknown>
      dependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
    }
    expect(manifest.dsh).toBeUndefined()
    expect(manifest.exports).not.toHaveProperty('./client')
    const dependencies = {
      ...manifest.dependencies,
      ...manifest.peerDependencies,
    }
    expect(Object.keys(dependencies).some(name => name.startsWith('@deepseek-ai/dsh-client-'))).toBe(false)
    expect(dependencies).not.toHaveProperty('@deepseek-ai/dsh-host-webserver')
    expect(dependencies).not.toHaveProperty('@deepseek-ai/dsh-host-connection')
  })

  it('withdraws its shared interceptor when the Gateway fiber unloads', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(TypertRegistry)
      await ctx.plugin(FakeConnectionService)
      const gateway = ctx.plugin(TypertGatewayService)
      await gateway
      const connection = ctx.get('connection') as unknown as FakeConnectionService
      expect(connection.matcher).toBeTypeOf('function')
      await gateway.dispose()
      expect(connection.matcher).toBeUndefined()
      expect(connection.handler).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('dynamically claims registered strict routes and retains withdrawn ownership', async () => {
    const { ctx, connection } = await setup()
    try {
      expect(connection.authority).toBe('loopback')
      expect(connection.matcher?.('fixture/run')).toBe(false)
      expect(connection.matcher?.('fixture.run')).toBe(false)
      const dispose = register(ctx, [directDescriptor])
      expect(connection.matcher?.('fixture/run')).toBe(true)
      expect(connection.matcher?.('unknown/route')).toBe(false)
      await dispose()
      expect(connection.matcher?.('fixture/run')).toBe(true)
      const response = await connection.request('fixture/run', {
        args: { agentId: 'agent-1', request: { title: 'ship' } },
      })
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({
        result: {
          ok: true,
          value: { ok: false, error: { code: 'definition-unavailable' } },
        },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('validates exact args, resolves lookups, forwards cancellation, and nests RemoteResult', async () => {
    const { ctx, connection, service } = await setup()
    try {
      register(ctx, [directDescriptor])
      const disposeLookup = ctx.typert.lookups.register('gatewayFixture', {
        parameter: 'agent',
        wire: 'agentId',
        hostTypeSymbol: '@fixture/agent',
        wireTypeSymbol: '@fixture/string',
        resolve: id => id === 'agent-1' ? { id } : undefined,
      })
      const signal = new AbortController().signal
      const response = await connection.request('fixture/run', {
        args: { agentId: 'agent-1', request: { title: '  ship  ' } },
      }, signal)
      await expect(response.json()).resolves.toEqual({
        result: {
          ok: true,
          value: {
            ok: true,
            value: { agentId: 'agent-1', title: 'ship', scope: 'root' },
          },
        },
      })
      expect(service.lastSignal).toBe(signal)

      for (const args of [
        { request: { title: 'missing lookup' } },
        { agentId: 'agent-1', request: { title: 'extra' }, extra: true },
      ]) {
        await expect(connection.request('fixture/run', { args }).then(value => value.json()))
          .resolves.toMatchObject({
            result: { value: { ok: false, error: { code: 'arguments-invalid' } } },
          })
      }
      await expect(connection.request('fixture/run', {
        args: { agentId: 'missing', request: { title: 'lookup' } },
      }).then(value => value.json())).resolves.toMatchObject({
        result: {
          value: { ok: false, error: { code: 'lookup-not-found', details: { lookup: 'gatewayFixture' } } },
        },
      })

      const cancelled = new AbortController()
      cancelled.abort(new Error('caller cancelled'))
      await expect(connection.request('fixture/run', {
        args: { agentId: 'agent-1', request: { title: 'cancelled' } },
      }, cancelled.signal).then(value => value.json())).resolves.toMatchObject({
        result: { value: { ok: false, error: { code: 'cancelled' } } },
      })

      await disposeLookup()
      ctx.typert.lookups.register('gatewayFixture', {
        parameter: 'agent',
        wire: 'agentId',
        hostTypeSymbol: '@fixture/agent',
        wireTypeSymbol: '@fixture/string',
        resolve: () => { throw new TypertLookupFailure({ code: 'agent-busy', message: 'owned', details: {} }) },
      })
      await expect(connection.request('fixture/run', {
        args: { agentId: 'agent-1', request: { title: 'lookup policy' } },
      }).then(value => value.json())).resolves.toMatchObject({
        result: { value: { ok: false, error: { code: 'agent-busy' } } },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('resolves strict Context receivers and preserves lookup policy failures', async () => {
    const { ctx, connection } = await setup()
    try {
      register(ctx, [contextDescriptor])
      const scoped = ctx.extend()
      let resolvedIdentity: string | undefined
      const dispose = ctx.typert.contexts.registerHost('gatewayFixture', {
        wire: 'agentId',
        wireTypeSymbol: '@fixture/string',
        resolve: (id) => {
          resolvedIdentity = id
          return id === 'agent-1' ? scoped : undefined
        },
      })
      await expect(connection.request('fixture/scoped', {
        args: { agentId: 'agent-1', request: { title: 'scope' } },
      }).then(value => value.json())).resolves.toMatchObject({
        result: {
          value: { ok: true, value: { title: 'scope', scope: 'root' } },
        },
      })
      expect(resolvedIdentity).toBe('agent-1')
      await dispose()
      ctx.typert.contexts.registerHost('gatewayFixture', {
        wire: 'agentId',
        wireTypeSymbol: '@fixture/string',
        resolve: () => { throw new TypertLookupFailure({ code: 'agent-busy', message: 'owned', details: {} }) },
      })
      await expect(connection.request('fixture/scoped', {
        args: { agentId: 'agent-1', request: { title: 'scope' } },
      }).then(value => value.json())).resolves.toMatchObject({
        result: { value: { ok: false, error: { code: 'agent-busy' } } },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('resolves services through the creating child plugin scope', async () => {
    const { ctx } = await setup()
    try {
      register(ctx, [directDescriptor])
      ctx.typert.lookups.register('gatewayFixture', {
        parameter: 'agent',
        wire: 'agentId',
        hostTypeSymbol: '@fixture/agent',
        wireTypeSymbol: '@fixture/string',
        resolve: id => ({ id }),
      })
      let dispatcher: ReturnType<typeof createTypertGatewayDispatcher> | undefined
      await ctx.plugin({
        name: 'gateway-child-scope-fixture',
        apply(childCtx: Context) {
          dispatcher = createTypertGatewayDispatcher(childCtx)
        },
      })
      await expect(dispatcher?.invoke(
        'fixture/run',
        { args: { agentId: 'agent-1', request: { title: 'child' } } },
        new AbortController().signal,
      )).resolves.toEqual({
        ok: true,
        value: { agentId: 'agent-1', title: 'child', scope: 'root' },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('returns 404 for unknown and frontend-like endpoints and refuses weak descriptors', async () => {
    const { ctx, connection } = await setup()
    try {
      expect((await connection.request('unknown/route', { args: {} })).status).toBe(404)
      expect((await connection.request('index.html', { args: {} })).status).toBe(404)
      register(ctx, [{
        ...directDescriptor,
        id: '@fixture/gateway#weak/run',
        namespace: 'weak',
        method: 'run',
        parameters: [{
          name: 'value',
          wire: 'value',
          source: 'json',
          codec: { mode: 'src-json' },
        }],
      }])
      await expect(connection.request('weak/run', { args: { value: 'x' } }).then(value => value.json()))
        .resolves.toMatchObject({
          result: { value: { ok: false, error: { code: 'definition-invalid' } } },
        })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
