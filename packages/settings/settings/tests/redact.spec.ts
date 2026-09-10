import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { redactSecrets, settingsNamespace } from '../src/index.ts'
import { MemorySettings } from './memory.ts'

const Profile = z.object({
  apiKey: z.string().role('secret'),
  apiKeyEnv: z.string().role('credential-ref'),
  baseURL: z.string(),
})

const Adapter: z<object> = z.object({
  apiKey: z.string().role('secret'),
  providers: z.dict(Profile),
  fallbacks: z.array(Profile),
  nested: z.object({
    token: z.string().role('secret'),
  }),
})

/** Dictionary fixture carrying one public and one defaulted secret dictionary. */
const DictionarySchema: z<{ headers: Record<string, string>; tokens: Record<string, string> }> = z.object({
  headers: z.dict(z.string()),
  tokens: z.dict(z.string().role('secret')).default({ private: 'synthetic-default-secret' }),
})

it('describes dictionary schemas with key references while stripping default secret values', async () => {
  const ctx = new Context()
  await ctx.plugin(MemorySettings)
  try {
    ctx.settings.register(settingsNamespace('dictionary-fixture'), DictionarySchema,
      { base: { headers: { Authorization: 'ARK_SYNTHETIC_REF' } } })
    const view = ctx.settings.describe({ redactSecrets: true })
    expect(view[0]?.value).toEqual({ headers: { Authorization: 'ARK_SYNTHETIC_REF' }, tokens: {} })
    expect(JSON.stringify(view)).not.toContain('synthetic-default-secret')
    expect(view[0]?.schema).toHaveProperty('refs')
  } finally { await ctx.fiber.dispose() }
})

it('refuses secret dictionary keys instead of exposing them in values or schema defaults', async () => {
  const ctx = new Context()
  await ctx.plugin(MemorySettings)
  try {
    ctx.settings.register(settingsNamespace('secret-key-fixture'), z.dict(z.string(), z.string().role('secret')),
      { base: { 'synthetic-secret-key': 'value' } })
    expect(() => ctx.settings.describe({ redactSecrets: true })).toThrow('secret dictionary keys')
  } finally { await ctx.fiber.dispose() }
})

it.each([null, {}, { refs: { unknown: {} } }, { refs: { invalid: null } }])(
  'rejects malformed serialized schema metadata %j', async (envelope) => {
    const ctx = new Context()
    await ctx.plugin(MemorySettings)
    try {
      const schema = z.object({ value: z.string() })
      ctx.settings.register(settingsNamespace('malformed-schema-fixture'), schema)
      Reflect.set(schema, 'toJSON', () => envelope)
      expect(() => ctx.settings.describe({ redactSecrets: true })).toThrow('settings schema')
    } finally { await ctx.fiber.dispose() }
  },
)

it('refuses secret literal schema metadata', async () => {
  const ctx = new Context()
  await ctx.plugin(MemorySettings)
  try {
    ctx.settings.register(settingsNamespace('secret-literal-fixture'), z.object({
      token: z.const('synthetic-literal-secret').role('secret'),
    }))
    expect(() => ctx.settings.describe({ redactSecrets: true })).toThrow('secret literal schema')
  } finally { await ctx.fiber.dispose() }
})

it('retains the non-configurable identity of a live schema during metadata discovery', async () => {
  const ctx = new Context()
  await ctx.plugin(MemorySettings)
  try {
    const schema = z.object({ label: z.string() })
    ctx.settings.register(settingsNamespace('missing-schema-identity'), schema)
    expect(Reflect.deleteProperty(schema, 'uid')).toBe(false)
    expect(ctx.settings.describe({ redactSecrets: true })[0]?.schema).toHaveProperty('refs')
  } finally { await ctx.fiber.dispose() }
})

it('discovers a shared live schema node once across multiple object properties', async () => {
  const ctx = new Context()
  await ctx.plugin(MemorySettings)
  try {
    const shared = z.string().role('secret').default('synthetic-shared-default')
    const schema = z.object({ first: z.string(), second: z.string() })
    schema.set('first', shared)
    schema.set('second', shared)
    ctx.settings.register(settingsNamespace('shared-schema-fixture'), schema)
    expect(JSON.stringify(ctx.settings.describe({ redactSecrets: true }))).not.toContain('synthetic-shared-default')
  } finally { await ctx.fiber.dispose() }
})

describe('redactSecrets', () => {
  it('redacts tuple and intersection relations and retains secret array positions', () => {
    const schema = z.object({
      tuple: z.tuple([z.string().role('secret'), z.string()]),
      array: z.array(z.string().role('secret')),
      both: z.intersect([z.object({ token: z.string().role('secret') }), z.object({ label: z.string() })]),
    })
    expect(redactSecrets(schema as z<never>, {
      tuple: ['tuple-secret', 'visible'], array: ['first-secret', 'second-secret'], both: { token: 'nested-secret', label: 'visible' },
    })).toEqual({
      value: { tuple: [null, 'visible'], array: [null, null], both: { label: 'visible' } },
      secrets: [
        { path: ['tuple', '0'], set: true }, { path: ['array', '0'], set: true },
        { path: ['array', '1'], set: true }, { path: ['both', 'token'], set: true },
      ],
    })
  })

  it('strips secrets from object, dict, and array containers and records each position', () => {
    const { value, secrets } = redactSecrets(Adapter as z<never>, {
      apiKey: 'top-secret',
      providers: {
        openai: { apiKey: 'sk-live', apiKeyEnv: 'OPENAI_API_KEY', baseURL: 'https://x' },
        anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY' },
      },
      fallbacks: [{ apiKey: 'fb', baseURL: 'https://y' }],
      nested: {},
    })
    expect(value).toEqual({
      providers: {
        openai: { apiKeyEnv: 'OPENAI_API_KEY', baseURL: 'https://x' },
        anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY' },
      },
      fallbacks: [{ baseURL: 'https://y' }],
      nested: {},
    })
    expect(secrets).toEqual([
      { path: ['apiKey'], set: true },
      { path: ['providers', 'openai', 'apiKey'], set: true },
      { path: ['providers', 'anthropic', 'apiKey'], set: false },
      { path: ['fallbacks', '0', 'apiKey'], set: true },
      { path: ['nested', 'token'], set: false },
    ])
  })

  it('enumerates unset object-property slots without inventing containers', () => {
    const { value, secrets } = redactSecrets(Adapter as z<never>, undefined)
    expect(value).toBeUndefined()
    expect(secrets).toEqual([
      { path: ['apiKey'], set: false },
      { path: ['nested', 'token'], set: false },
    ])
  })

  it('never mutates the input and preserves keys outside the schema', () => {
    const input = Object.freeze({
      apiKey: 'frozen',
      extra: Object.freeze({ keep: true }),
    })
    const { value } = redactSecrets(Adapter as z<never>, input)
    expect(input.apiKey).toBe('frozen')
    expect(value).toEqual({ extra: { keep: true }, nested: undefined } as never)
    expect((value as { extra: unknown }).extra).toEqual({ keep: true })
  })

  it('refuses malformed secret-bearing containers without echoing their values', () => {
    for (const field of ['providers', 'fallbacks', 'nested']) {
      expect(() => redactSecrets(Adapter as z<never>, { [field]: 'synthetic-malformed-secret' }))
        .toThrow('settings cannot safely redact a malformed secret-bearing container')
    }
  })

  it('preserves malformed public containers without classifying unmarked values as secrets', () => {
    const publicSchema = z.object({ object: z.object({ name: z.string() }), dict: z.dict(z.string()),
      array: z.array(z.string()), tuple: z.tuple([z.string()]) })
    const input = { object: 'public', dict: 'public', array: 'public', tuple: 'public' }
    expect(redactSecrets(publicSchema as z<never>, input)).toEqual({ value: input, secrets: [] })
  })

  it('refuses non-array secret-bearing tuples while retaining unmarked tuple positions', () => {
    const schema = z.tuple([z.string().role('secret')])
    for (const value of ['synthetic-tuple-secret', null, { value: 'synthetic-tuple-secret' }]) {
      expect(() => redactSecrets(schema as z<never>, value))
        .toThrow('settings cannot safely redact a malformed secret-bearing container')
    }
    expect(redactSecrets(schema as z<never>, ['synthetic-secret', 'public-tail']).value).toEqual([null, 'public-tail'])
  })

  it('treats a secret-role container as one opaque secret leaf', () => {
    const Weird = z.object({ blob: z.object({ inner: z.string() }).role('secret') })
    const { value, secrets } = redactSecrets(Weird as z<never>, { blob: { inner: 'x' } })
    expect(value).toEqual({})
    expect(secrets).toEqual([{ path: ['blob'], set: true }])
  })

  it('drops a dict entry whose entire value is the secret', () => {
    const Tokens = z.object({ tokens: z.dict(z.string().role('secret')) })
    const { value, secrets } = redactSecrets(Tokens as z<never>, { tokens: { a: 'x', b: 'y' } })
    expect(value).toEqual({ tokens: {} })
    expect(secrets).toEqual([
      { path: ['tokens', 'a'], set: true },
      { path: ['tokens', 'b'], set: true },
    ])
  })

  it('tolerates structural nodes missing their relation maps', () => {
    expect(redactSecrets({ type: 'dict' } as never, { k: 'v' })).toEqual({ value: { k: 'v' }, secrets: [] })
    expect(redactSecrets({ type: 'object' } as never, { k: 'v' })).toEqual({ value: { k: 'v' }, secrets: [] })
    expect(redactSecrets({ type: 'array' } as never, ['v'])).toEqual({ value: ['v'], secrets: [] })
    expect(redactSecrets({ type: 'tuple' } as never, 'malformed')).toEqual({ value: 'malformed', secrets: [] })
    expect(redactSecrets({ type: 'union' } as never, 'public')).toEqual({ value: 'public', secrets: [] })
    const shared = { type: 'string' }
    expect(redactSecrets({ type: 'transform', list: [shared, shared] } as never, 'public')).toEqual({ value: 'public', secrets: [] })
    expect(() => redactSecrets({ inner: { type: 'string', meta: { role: 'secret' } } } as never, 'private'))
      .toThrow('settings cannot safely redact schema type "unknown"')
  })
})

describe('describe() layers and redaction', () => {
  const NS = settingsNamespace('adapter')

  async function boot(doc?: Record<string, unknown>) {
    const ctx = new Context()
    await ctx.plugin(MemorySettings, doc === undefined ? undefined : { doc })
    return ctx
  }

  it('exposes detached base and user layers beside the resolved value', async () => {
    const ctx = await boot({ adapter: { baseURL: 'https://user' } })
    const base = { apiKey: 'entry-key', baseURL: 'https://base' }
    ctx.settings.register(NS, Profile, { base })
    const [descriptor] = ctx.settings.describe()
    expect(descriptor?.base).toEqual(base)
    expect(descriptor?.base).not.toBe(base)
    expect(descriptor?.user).toEqual({ baseURL: 'https://user' })
    expect(descriptor?.value).toEqual({ apiKey: 'entry-key', baseURL: 'https://user' })
    ;(descriptor?.user as Record<string, unknown>).baseURL = 'mutated'
    expect(ctx.settings.describe()[0]?.user).toEqual({ baseURL: 'https://user' })
    expect(descriptor?.secrets).toBeUndefined()
  })

  it('omits the layers when neither a base nor a user section exists', async () => {
    const ctx = await boot()
    ctx.settings.register(NS, Profile)
    const [descriptor] = ctx.settings.describe()
    expect(descriptor).not.toHaveProperty('base')
    expect(descriptor).not.toHaveProperty('user')
  })

  it('describes a section that became malformed after registration as having no user layer', async () => {
    const ctx = await boot({ adapter: { baseURL: 'https://user' } })
    const provider = ctx.get('settings') as MemorySettings
    ctx.settings.register(NS, Profile, { base: { baseURL: 'https://base' } })
    provider.pushExternal({ adapter: 5 })
    const [descriptor] = ctx.settings.describe()
    expect(descriptor).not.toHaveProperty('user')
    // The malformed publish kept the last good resolved value.
    expect(descriptor?.value).toEqual({ baseURL: 'https://user' })
  })

  it('redacts a descriptor that has neither base nor user layer', async () => {
    const ctx = await boot()
    ctx.settings.register(NS, Profile)
    const [descriptor] = ctx.settings.describe({ redactSecrets: true })
    expect(descriptor).not.toHaveProperty('base')
    expect(descriptor).not.toHaveProperty('user')
    expect(descriptor?.secrets).toEqual([{ path: ['apiKey'], set: false }])
  })

  it('redacts every layer and enumerates secret slots under redactSecrets', async () => {
    const ctx = await boot({ adapter: { apiKey: 'user-key', baseURL: 'https://user' } })
    ctx.settings.register(NS, Profile, { base: { apiKey: 'entry-key' } })
    const [descriptor] = ctx.settings.describe({ redactSecrets: true })
    expect(descriptor?.value).toEqual({ baseURL: 'https://user' })
    expect(descriptor?.base).toEqual({})
    expect(descriptor?.user).toEqual({ baseURL: 'https://user' })
    expect(descriptor?.secrets).toEqual([{ path: ['apiKey'], set: true }])
    const [verbatim] = ctx.settings.describe()
    expect(verbatim?.value).toEqual({ apiKey: 'user-key', baseURL: 'https://user' })
  })
})
