import { describe, expect, it } from 'vitest'
import { Config, ProviderProfileSchema, assertServiceable, assertWritableConfig, resolveProfiles } from '../src/config.ts'
import { redactPiAiSecrets as redactConfig, redactProviderCredentialFields as redactFields, resolveProfileHeaders as resolveHeaders } from '../src/headers.ts'

const redactPiAiSecrets = (value: unknown) => redactConfig(value, Config)
const redactProviderCredentialFields = (value: unknown) => redactFields(value, ProviderProfileSchema)
const resolveProfileHeaders = (provider: string, source: Parameters<typeof resolveHeaders>[1]) =>
  resolveHeaders(provider, source, ProviderProfileSchema)

describe('provider header admission', () => {
  it('detaches public headers and credential references while retaining explicit empty authorization', () => {
    const source = { headers: { Authorization: '', 'X-Public': 'public' }, credentialHeaders: { 'api-key': 'FIXTURE_KEY' } }
    const resolved = resolveProfileHeaders('fixture', source)
    expect(resolved).toEqual(source)
    source.headers['X-Public'] = 'changed'
    source.credentialHeaders['api-key'] = 'CHANGED_KEY'
    expect(resolved.headers?.['X-Public']).toBe('public')
    expect(resolved.credentialHeaders?.['api-key']).toBe('FIXTURE_KEY')
    expect(resolveProfileHeaders('fixture', {})).toEqual({})
  })

  it('treats prototype-shaped header names as data', () => {
    const headers = Object.fromEntries([['__proto__', 'public']])
    const result = resolveProfileHeaders('fixture', { headers })
    expect(Object.hasOwn(result.headers!, '__proto__')).toBe(true)
    expect(Object.getPrototypeOf(result.headers)).toBe(Object.prototype)
  })

  it('retains legacy configuration without activating or rewriting its literal credentials', () => {
    const source = { providers: { openai: { headers: { Authorization: 'synthetic-private', 'api-key': 'synthetic-key' } } } }
    expect(() => { assertServiceable(source) }).not.toThrow()
    expect(resolveProfiles(source.providers).get('openai')).toMatchObject({
      migrationRequired: { headers: ['Authorization', 'api-key'] },
    })
    expect(resolveProfiles(source.providers).get('openai')?.headers).toBeUndefined()
    expect(() => { assertWritableConfig(source) }).toThrow('credential headers must use credential references')
    expect(source.providers.openai.headers.Authorization).toBe('synthetic-private')
    expect(() => { assertWritableConfig(Config({ providers: { openai: {
      headers: { Authorization: '' }, credentialHeaders: { 'api-key': 'FIXTURE_KEY' },
    } } })) }).not.toThrow()
  })

  it.each([
    { headers: { 'bad name': 'public' } },
    { headers: { 'X-Public': 'line\r\nsecond' } },
    { headers: { 'X-Public': 'one', 'x-public': 'two' } },
    { headers: { Authorization: '' }, credentialHeaders: { authorization: 'FIXTURE_KEY' } },
    { credentialHeaders: { 'api-key': 'ONE_KEY', 'API-KEY': 'TWO_KEY' } },
    { credentialHeaders: { 'bad name': 'FIXTURE_KEY' } },
    { credentialHeaders: { 'api-key': 'invalid reference' } },
  ])('rejects invalid or ambiguous header configuration %#', (source) => {
    expect(() => resolveProfileHeaders('fixture', source)).toThrow()
  })
})

describe('legacy provider secret projection', () => {
  it('hides unknown credential fields at every retained layer without hiding model capacities', () => {
    const value = { apiKey: 'root-private', providers: { openai: {
      apiKey: 'profile-private', token: 'token-private', accessToken: 'access-private',
      nested: { refresh_token: 'refresh-private' },
      models: [{ id: 'test', maxTokens: 1024, contextWindow: 4096, extra: { clientSecret: 'client-private' } }],
      modelOverrides: { token: { maxTokens: 1024 } },
    } } }
    const result = redactPiAiSecrets(value)
    expect(JSON.stringify(result)).not.toContain('-private')
    expect(result.value).toMatchObject({ providers: { openai: {
      models: [{ id: 'test', maxTokens: 1024, contextWindow: 4096 }],
      modelOverrides: { token: { maxTokens: 1024 } },
    } } })
    expect(result.secrets).toHaveLength(6)
    expect(result.secrets).toContainEqual({ path: ['providers', 'openai', 'models', '0', 'extra'], set: true })
    expect(value.providers.openai.apiKey).toBe('profile-private')
    expect(() => { assertWritableConfig({ providers: { openai: { ...value.providers.openai, models: [] } } }) }).toThrow()
    expect(redactPiAiSecrets({ apiKey: 'root-private' }).secrets).toEqual([{ path: ['apiKey'], set: true }])
  })

  it.each(['bearerToken', 'sessionToken', 'privateKey', 'aws_secret_access_key', 'aws_session_token', 'unrecognizedFutureOption'])
  ('hides and blocks undeclared %s regardless of its name', (field) => {
    const config = { providers: { openai: { [field]: 'synthetic-private', models: [] } } }
    const result = redactPiAiSecrets(config)
    expect(JSON.stringify(result)).not.toContain('synthetic-private')
    expect(result.secrets).toEqual([{ path: ['providers', 'openai', field], set: true }])
    expect(resolveProfiles(config.providers).get('openai')?.migrationRequired?.fields).toEqual([[field]])
    expect(() => { assertWritableConfig(config) }).toThrow()
  })

  it('retains declared dictionary keys, template values, and fields shared across retry alternatives', () => {
    const profile = {
      models: [{ id: 'bearerToken', input: ['text', 'image'], reasoningEfforts: { off: null, high: 'high' } }],
      compat: { chatTemplateKwargs: { token: 'literal-template-word', numeric: 2, flag: true, blank: null,
        variable: { $var: 'thinking.enabled', omitWhenOff: true } } },
      retryPolicy: { mode: 'always', maxRetries: 2, backoff: { initialDelayMs: 100, maxDelayMs: 1000, jitterRatio: 0 } },
    }
    const result = redactProviderCredentialFields(profile)
    expect(result.value).toEqual(profile)
    expect(result.secrets).toEqual([])
    expect(result.value).not.toBe(profile)
  })

  it('hides dictionary entries whose keys are not admitted by the live schema', () => {
    const result = redactProviderCredentialFields({ models: [{ id: 'test',
      reasoningEfforts: { bearerToken: 'synthetic-private', high: 'high', off: null },
    }] })
    expect(result.value).toEqual({ models: [{ id: 'test', reasoningEfforts: { high: 'high', off: null } }] })
    expect(result.secrets).toEqual([{ path: ['models', '0', 'reasoningEfforts', 'bearerToken'], set: true }])
    expect(JSON.stringify(result)).not.toContain('synthetic-private')
  })

  it.each([
    { models: 'synthetic-private' }, { models: [{ id: { privateKey: 'synthetic-private' } }] },
    { defaultInput: ['not-a-modality'] }, { compat: [] }, { thinkingBudgets: { high: 'synthetic-private' } },
  ])('refuses malformed declared values without echoing them %#', (profile) => {
    expect(() => redactProviderCredentialFields(profile)).toThrow('cannot safely redact malformed provider settings')
  })

  it.each(['apiKeyEnv', 'credentialHeaders'])('refuses malformed %s instead of returning a misplaced key', (field) => {
    const raw = field === 'apiKeyEnv' ? 'sk-not-a-reference' : { Authorization: 'sk-not-a-reference' }
    expect(() => redactPiAiSecrets({ providers: { openai: { [field]: raw } } })).toThrow(/cannot expose/)
    expect(() => redactPiAiSecrets({ providers: { openai: { [field]: ['private'] } } })).toThrow(
      field === 'apiKeyEnv' ? 'cannot safely redact malformed provider settings' : 'cannot expose malformed credential-header references',
    )
  })

  it('refuses cyclic and non-JSON profiles without echoing their contents', () => {
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    expect(() => redactProviderCredentialFields(cycle)).toThrow(/cyclic/)
    expect(() => redactProviderCredentialFields({ date: new Date() })).toThrow(/non-JSON/)
    expect(() => redactProviderCredentialFields({ fn: () => 'private-function-body' })).toThrow(/non-serializable/)
  })

  it('redacts every literal credential slot without mutating the source or reference plane', () => {
    const source = { providers: { openai: {
      headers: { Authorization: 'synthetic-private', 'X-Public': 'public', Cookie: undefined, 'X-Api-Key': { nested: 'synthetic-key' } },
      credentialHeaders: { 'api-key': 'FIXTURE_KEY' },
    }, blank: { headers: { Authorization: '' } }, unconfigured: {} } }
    const redacted = redactPiAiSecrets(source)
    expect(redacted).toEqual({ value: { providers: {
      openai: { headers: { 'X-Public': 'public' }, credentialHeaders: { 'api-key': 'FIXTURE_KEY' } },
      blank: { headers: { Authorization: '' } }, unconfigured: {},
    } }, secrets: [
      { path: ['providers', 'openai', 'headers', 'Authorization'], set: true },
      { path: ['providers', 'openai', 'headers', 'Cookie'], set: false },
      { path: ['providers', 'openai', 'headers', 'X-Api-Key'], set: true },
    ] })
    expect(JSON.stringify(redacted)).not.toContain('synthetic-')
    expect(source.providers.openai.headers.Authorization).toBe('synthetic-private')
    expect(redactPiAiSecrets(undefined)).toEqual({ value: undefined, secrets: [] })
    expect(redactPiAiSecrets({})).toEqual({ value: {}, secrets: [] })
  })

  it.each([null, [], 'synthetic-private', { providers: null }, { providers: [] },
    { providers: { openai: 'synthetic-private' } }, { providers: { openai: { headers: ['synthetic-private'] } } },
    { providers: { openai: { headers: { 'X-Public': { privateKey: 'synthetic-private' } } } } },
  ])('fails closed on malformed provider containers %#', (source) => {
    expect(() => redactPiAiSecrets(source)).toThrow(/cannot safely redact/)
  })
})
