import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import {
  TypertLookupFailure,
  type InvocationDescriptor,
  type TypertRegistryContract,
} from '@deepseek-ai/dsh-typert-protocol'
import { createTypertGatewayDispatcher } from '../src/index.ts'

const endpoint = 'fixture/run'

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

const identityCodec = {
  mode: 'strict' as const,
  typeSymbol: '@fixture/json',
  schema: { parse: (value: unknown): unknown => value },
}

function descriptor(overrides: Partial<InvocationDescriptor> = {}): InvocationDescriptor {
  return {
    id: '@fixture/coverage#fixture/run',
    service: 'fixture',
    namespace: 'fixture',
    method: 'run',
    invocation: { kind: 'direct' },
    parameters: [],
    result: identityCodec,
    ...overrides,
  }
}

function receiver(methods: Record<string, unknown> = {}): Record<string, unknown> {
  const service: Record<string, unknown> = { ...methods }
  service.typertRemote = {
    service,
    serviceKey: 'fixture',
    namespace: 'fixture',
  }
  return service
}

interface HarnessOptions {
  readonly descriptor?: InvocationDescriptor
  readonly seen?: boolean
  readonly service?: object
  readonly contextProvider?: { wire: string; wireTypeSymbol: string; resolve(identity: unknown): Promise<unknown> }
  readonly lookupProvider?: { wire: string; wireTypeSymbol: string; resolve(value: unknown): Promise<unknown> }
  readonly typert?: TypertRegistryContract
}

function harness(options: HarnessOptions = {}): {
  readonly ctx: Context
  readonly invoke: (payload: unknown, signal?: AbortSignal) => Promise<unknown>
} {
  const values = new Map<string, unknown>()
  const local = {
    get: (value: string): InvocationDescriptor | undefined => value === endpoint ? options.descriptor : undefined,
    hasSeen: (): boolean => options.seen === true,
  }
  const typert = options.typert ?? {
    local,
    contexts: { getHost: (): HarnessOptions['contextProvider'] => options.contextProvider },
    lookups: { get: (): HarnessOptions['lookupProvider'] => options.lookupProvider },
  } as unknown as TypertRegistryContract
  values.set('typert', typert)
  if (options.service !== undefined) values.set('fixture', options.service)
  const ctx = { get: (key: string): unknown => values.get(key) } as unknown as Context
  const dispatcher = createTypertGatewayDispatcher(ctx)
  return {
    ctx,
    invoke: (payload, signal = new AbortController().signal) => dispatcher.invoke(endpoint, payload, signal),
  }
}

function errorCode(value: unknown): string {
  return (value as { readonly ok: false; readonly error: { readonly code: string } }).error.code
}

describe('Typert Gateway strict error coverage', () => {
  it('rejects unavailable, malformed, withdrawn, and mismatched descriptors without dispatching', async () => {
    const absent = createTypertGatewayDispatcher({ get: () => undefined } as unknown as Context)
    expect(absent.claims(endpoint)).toBe(false)
    expect(errorCode(await absent.invoke(endpoint, { args: {} }, new AbortController().signal))).toBe('service-unavailable')
    expect(errorCode(await absent.invoke('fixture/run/extra', { args: {} }, new AbortController().signal))).toBe('arguments-invalid')

    const missing = harness()
    expect(errorCode(await missing.invoke({ args: {} }))).toBe('invocation-unavailable')
    const withdrawn = harness({ seen: true })
    expect(errorCode(await withdrawn.invoke({ args: {} }))).toBe('definition-unavailable')

    const mismatched = harness({
      descriptor: descriptor({ namespace: 'other' }),
      service: receiver({ run: () => ({}) }),
    })
    expect(errorCode(await mismatched.invoke({ args: {} }))).toBe('definition-invalid')

  })

  it('fails closed for malformed payloads, missing services, bindings, and methods', async () => {
    const good = descriptor({
      parameters: [{ name: 'value', wire: 'value', source: 'json', codec: stringCodec }],
      result: stringCodec,
    })
    const unavailable = harness({ descriptor: good })
    expect(errorCode(await unavailable.invoke({ args: { value: 'x' } }))).toBe('service-unavailable')

    const unbound = harness({ descriptor: good, service: { run: () => 'x' } })
    expect(errorCode(await unbound.invoke({ args: { value: 'x' } }))).toBe('binding-invalid')

    const missingMethod = harness({ descriptor: good, service: receiver() })
    expect(errorCode(await missingMethod.invoke({ args: { value: 'x' } }))).toBe('method-unavailable')

    const dispatched = harness({ descriptor: good, service: receiver({ run: (value: string) => value }) })
    for (const payload of [null, [], { args: [] }, { args: { value: 'x' }, extra: true }, { args: {} }]) {
      expect(errorCode(await dispatched.invoke(payload))).toBe('arguments-invalid')
    }
    expect(errorCode(await dispatched.invoke({ args: { value: 1 } }))).toBe('input-invalid')
  })

  it('covers lookup and Context provider absence, mismatch, failure, and not-found results', async () => {
    const lookupDescriptor = descriptor({
      parameters: [{ name: 'agent', wire: 'agentId', source: 'lookup', lookup: 'fixture', codec: stringCodec }],
      result: identityCodec,
    })
    const service = receiver({ run: (agent: { id: string }) => ({ id: agent.id }) })
    const payload = { args: { agentId: 'agent-1' } }
    expect(errorCode(await harness({ descriptor: lookupDescriptor, service }).invoke(payload))).toBe('lookup-unavailable')
    expect(errorCode(await harness({
      descriptor: lookupDescriptor,
      service,
      lookupProvider: { wire: 'other', wireTypeSymbol: '@fixture/string', resolve: async () => ({ id: 'x' }) },
    }).invoke(payload))).toBe('provider-mismatch')
    expect(errorCode(await harness({
      descriptor: lookupDescriptor,
      service,
      lookupProvider: { wire: 'agentId', wireTypeSymbol: '@fixture/string', resolve: async () => { throw new Error('lookup failed') } },
    }).invoke(payload))).toBe('lookup-failed')
    expect(errorCode(await harness({
      descriptor: lookupDescriptor,
      service,
      lookupProvider: { wire: 'agentId', wireTypeSymbol: '@fixture/string', resolve: async () => undefined },
    }).invoke(payload))).toBe('lookup-not-found')
    expect(errorCode(await harness({
      descriptor: lookupDescriptor,
      service,
      lookupProvider: {
        wire: 'agentId',
        wireTypeSymbol: '@fixture/string',
        resolve: async () => { throw new TypertLookupFailure({ code: 'agent-busy', message: 'owned', details: {} }) },
      },
    }).invoke(payload))).toBe('agent-busy')
    expect(errorCode(await harness({
      descriptor: descriptor({
        parameters: [{ name: 'agent', wire: 'agentId', source: 'lookup', codec: stringCodec }],
        result: identityCodec,
      }),
      service,
    }).invoke(payload))).toBe('lookup-unavailable')

    const contextDescriptor = descriptor({
      implementation: 'scoped',
      invocation: { kind: 'context', context: 'fixture', wire: 'agentId', codec: stringCodec },
      result: identityCodec,
    })
    const contextService = receiver({ scoped: () => ({ ok: true }) })
    const contextPayload = { args: { agentId: 'agent-1' } }
    expect(errorCode(await harness({ descriptor: contextDescriptor, service: contextService }).invoke(contextPayload))).toBe('context-unavailable')
    expect(errorCode(await harness({
      descriptor: contextDescriptor,
      service: contextService,
      contextProvider: { wire: 'other', wireTypeSymbol: '@fixture/string', resolve: async () => undefined },
    }).invoke(contextPayload))).toBe('provider-mismatch')
    expect(errorCode(await harness({
      descriptor: contextDescriptor,
      service: contextService,
      contextProvider: { wire: 'agentId', wireTypeSymbol: '@fixture/string', resolve: async () => { throw new Error('context failed') } },
    }).invoke(contextPayload))).toBe('context-failed')
    expect(errorCode(await harness({
      descriptor: contextDescriptor,
      service: contextService,
      contextProvider: { wire: 'agentId', wireTypeSymbol: '@fixture/string', resolve: async () => undefined },
    }).invoke(contextPayload))).toBe('context-not-found')
  })

  it('contains cancellation, thrown Remote failures, and every JSON-result rejection family', async () => {
    const outputs = new Map<string, unknown>()
    const raw = receiver({
      run: (value: string, signal?: AbortSignal): unknown => {
        if (signal?.aborted) throw new Error('cancelled inside service')
        return outputs.get(value)
      },
      throwRaw: (): never => { throw { code: 'agent-busy', message: 'owned', details: {} } },
    })
    const rawDescriptor = descriptor({
      parameters: [{ name: 'value', wire: 'value', source: 'json', codec: stringCodec }],
      result: identityCodec,
      cancellation: { parameter: 'signal' },
    })
    const call = (value: string, signal = new AbortController().signal): Promise<unknown> =>
      harness({ descriptor: rawDescriptor, service: raw }).invoke({ args: { value } }, signal)
    const cancelled = new AbortController()
    cancelled.abort(new Error('caller cancelled'))
    expect(errorCode(await call('cancelled', cancelled.signal))).toBe('cancelled')
    const abortDuringCall = new AbortController()
    const aborting = receiver({
      run: (): never => {
        abortDuringCall.abort(new Error('cancelled during invocation'))
        throw new Error('service observed cancellation')
      },
    })
    expect(errorCode(await harness({ descriptor: rawDescriptor, service: aborting })
      .invoke({ args: { value: 'during' } }, abortDuringCall.signal))).toBe('cancelled')
    const abortAfterResult = new AbortController()
    const afterResult = receiver({
      run: (): object => {
        abortAfterResult.abort(new Error('cancelled after service result'))
        return { complete: true }
      },
    })
    expect(errorCode(await harness({ descriptor: rawDescriptor, service: afterResult })
      .invoke({ args: { value: 'after' } }, abortAfterResult.signal))).toBe('cancelled')

    outputs.set('number', 3)
    expect(await call('number')).toEqual({ ok: true, value: 3 })
    outputs.set('array', ['one'])
    expect(await call('array')).toEqual({ ok: true, value: ['one'] })
    outputs.set('decorated-array', Object.assign(['one'], { [Symbol('extra')]: true }))
    expect(errorCode(await call('decorated-array'))).toBe('result-invalid')
    outputs.set('undefined', undefined)
    expect(await call('undefined')).toEqual({ ok: true, value: undefined })

    const invalidOutputs: ReadonlyArray<readonly [string, unknown]> = [
      ['nan', Number.NaN],
      ['infinity', Infinity],
      ['bigint', 1n],
      ['date', new Date()],
      ['symbol', Object.assign({ ok: true }, { [Symbol('secret')]: true })],
    ]
    for (const [key, value] of invalidOutputs) {
      outputs.set(key, value)
      expect(errorCode(await call(key))).toBe('result-invalid')
    }
    const sparse = Object.assign(['first'] as string[], { extra: true })
    sparse.length = 2
    outputs.set('sparse', sparse)
    expect(errorCode(await call('sparse'))).toBe('result-invalid')
    const cyclic: { self?: unknown } = {}
    cyclic.self = cyclic
    outputs.set('cyclic', cyclic)
    expect(errorCode(await call('cyclic'))).toBe('result-invalid')
    const getter = {} as { readonly value?: string }
    Object.defineProperty(getter, 'value', { enumerable: true, get: () => 'hidden' })
    outputs.set('getter', getter)
    expect(errorCode(await call('getter'))).toBe('result-invalid')

    const thrownDescriptor = descriptor({ implementation: 'throwRaw' })
    const thrown = harness({ descriptor: thrownDescriptor, service: raw })
    expect(errorCode(await thrown.invoke({ args: {} }))).toBe('agent-busy')
    const ordinary = harness({
      descriptor: descriptor({ implementation: 'throwRaw' }),
      service: receiver({ throwRaw: (): never => { throw 'plain failure' } }),
    })
    expect(errorCode(await ordinary.invoke({ args: {} }))).toBe('internal')
    const errorObject = harness({
      descriptor: descriptor({ implementation: 'throwRaw' }),
      service: receiver({ throwRaw: (): never => { throw new Error('ordinary error') } }),
    })
    expect(errorCode(await errorObject.invoke({ args: {} }))).toBe('internal')

    const optional = descriptor({
      parameters: [{
        name: 'optional',
        wire: 'optional',
        source: 'json',
        acceptsUndefined: true,
        codec: identityCodec,
      }],
      result: identityCodec,
    })
    expect(await harness({
      descriptor: optional,
      service: receiver({ run: (value: unknown) => value }),
    }).invoke({ args: {} })).toEqual({ ok: true, value: undefined })
  })
})
