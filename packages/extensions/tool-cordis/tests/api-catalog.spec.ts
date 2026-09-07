// Behavioral coverage for the cordis API catalog's projection functions —
// the machine-readable directory the cordis_inspect tool serves to the model.
// Fixture-driven (entries injected), so the specs stay independent of the
// generated data files and pin the catalog/contract projection semantics.

import { describe, expect, it } from 'vitest'
import * as catalog from '../src/api-catalog.ts'
import type { EventApiEntry, ServiceApiEntry } from '../src/api-catalog.ts'

const serviceFixture: readonly ServiceApiEntry[] = [
  {
    key: 'sessions',
    summary: 'session management',
    description: 'Create, list, select, and remove sessions.',
    methods: [
      {
        signature: 'create(opts: { workspaceId?: string }): Promise<RpcResult<{ sessionId: string }>>',
        description: 'Create a session.',
        parameters: [{ name: 'opts', description: 'target workspace' }],
      },
    ],
  },
]

const eventFixture: readonly EventApiEntry[] = [
  {
    name: 'session/updated',
    mode: 'emit',
    summary: 'a session changed',
    description: 'Emitted when a session changes.',
    signature: '(sessionId: string): void',
    parameters: [{ name: 'sessionId', description: 'changed session' }],
  },
]

describe('queryServiceApi', () => {
  it('retains the COV1-generated agentLoop type closure through runtime word boundaries', () => {
    const detail = catalog.queryServiceApi('agentLoop')
    const referencedTypes = requiredArrayProperty(detail, 'referencedTypes')
    const names = referencedTypes.map(type => requiredStringProperty(type, 'name'))

    expect(names).toEqual(expect.arrayContaining([
      'Agent',
      'AgentOptions',
      'SessionId',
    ]))
    expect(referencedTypes).toHaveLength(65)
    expect(names.every(name => name.length > 0)).toBe(true)
  })

  it('projects a compact catalog when no key is given', () => {
    const directory = catalog.queryServiceApi(undefined, serviceFixture)
    expect(requiredStringProperty(directory, 'mode')).toBe('catalog')
    expect(requiredArrayProperty(directory, 'services')).toEqual([
      { key: 'sessions', description: 'session management', methods: [
        { signature: 'create(opts: { workspaceId?: string }): Promise<RpcResult<{ sessionId: string }>>' },
      ] },
    ])
  })

  it('projects one exact service contract with its referenced type closure when keyed', () => {
    const detail = catalog.queryServiceApi('sessions', serviceFixture)
    // The access seat teaches the optional `ctx.get` vs hard `inject` reading.
    expect(detail).toMatchObject({
      mode: 'service',
      service: {
        key: 'sessions',
        access: {
          optional: {
            expression: 'ctx.get("sessions")',
            requiresUndefinedCheck: true,
          },
          hardDependency: { inject: ['sessions'] },
        },
      },
    })
    expect(requiredArrayProperty(detail, 'referencedTypes')).toBeDefined()
  })

  it('rejects an unknown key loudly', () => {
    expect(() => catalog.queryServiceApi('nope', serviceFixture)).toThrow(/no catalogued Service named "nope"/)
  })

  it('uses bracket access for non-identifier service keys', () => {
    const unusual: readonly ServiceApiEntry[] = [{
      key: 'service-name', summary: 'unusual key', description: 'unusual key', methods: [],
    }]
    expect(catalog.queryServiceApi('service-name', unusual)).toMatchObject({
      service: { access: { hardDependency: { expression: 'ctx["service-name"]' } } },
    })
  })
})

describe('queryEventApi', () => {
  it('projects a compact event directory without a name', () => {
    const directory = catalog.queryEventApi(undefined, eventFixture)
    expect(requiredStringProperty(directory, 'mode')).toBe('catalog')
    expect(requiredArrayProperty(directory, 'events')).toEqual([
      { name: 'session/updated', description: 'a session changed', mode: 'emit', signature: '(sessionId: string): void' },
    ])
  })

  it('projects one exact listener contract when keyed', () => {
    expect(catalog.queryEventApi('session/updated', eventFixture)).toMatchObject({
      mode: 'event',
      event: { name: 'session/updated', signature: '(sessionId: string): void' },
    })
  })

  it('rejects an unknown event name loudly', () => {
    expect(() => catalog.queryEventApi('nope', eventFixture)).toThrow(/no catalogued Event named "nope"/)
  })
})

function requiredArrayProperty(value: unknown, key: PropertyKey): unknown[] {
  if (typeof value !== 'object' || value === null) throw new Error(`missing object property ${String(key)}`)
  const property: unknown = Reflect.get(value, key)
  if (!Array.isArray(property)) throw new Error(`missing array property ${String(key)}`)
  return property
}

function requiredStringProperty(value: unknown, key: PropertyKey): string {
  if (typeof value !== 'object' || value === null) throw new Error(`missing object property ${String(key)}`)
  const property: unknown = Reflect.get(value, key)
  if (typeof property !== 'string') throw new Error(`missing string property ${String(key)}`)
  return property
}
