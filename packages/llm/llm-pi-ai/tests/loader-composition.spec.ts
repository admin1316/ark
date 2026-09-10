/**
 * Real-composition guard for the dormant pi-ai posture: LlmRuntime,
 * settings-file, credentials-local, and a bare `llm-pi-ai` row boot from a
 * test-only cordis.yml through the actual Loader + Include path, an external
 * edit of settings.yaml registers the route live, and the next request
 * carries the credential the credentials document supplies. A hand-mounted `ctx.plugin` cannot
 * catch Loader export-shape failures, which is why the twin adapter has the
 * same guard.
 */

import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime, { createMessage, createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'
import { createLaunchEnvironmentSnapshot, DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { assemble } from './assemble.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'
import { catalogProvider, catalogProviderIds } from '../src/catalog.ts'
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai'

/** One text block, then a tool call truncated by the output-token ceiling. */
const truncatedToolCallEvents = [
  '{"choices":[{"delta":{"role":"assistant","content":""},"index":0,"finish_reason":null}]}',
  '{"choices":[{"delta":{"content":"partial"},"index":0,"finish_reason":null}]}',
  '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"echo","arguments":"{\\"text\\":"}}]},"index":0,"finish_reason":null}]}',
  '{"choices":[{"delta":{},"index":0,"finish_reason":"length"}],"usage":{"prompt_tokens":3,"completion_tokens":4}}',
  '[DONE]',
]

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  await closeMockServers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

/** Boot the dormant composition: a bare `llm-pi-ai` row with no config at all. */
async function loadComposition(options: {
  base?: LlmPiAi.Config
  user?: unknown
} = {}): Promise<{ ctx: Context; settingsPath: string }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-pi-composition-'))
  const settingsPath = join(root, 'settings.yaml')
  await writeFile(settingsPath, options.user === undefined ? '# personal settings\n' : JSON.stringify({ 'llm-pi-ai': options.user }))
  await writeFile(join(root, '.credentials.yaml'), 'version: 1\nrefs:\n  PI_COMPOSITION_KEY: key-from-store\n', { mode: 0o600 })

  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- id: llm',
    "  name: 'test-llm-service'",
    '- id: settings',
    "  name: '@deepseek-ai/dsh-settings-file'",
    '  config:',
    `    path: ${JSON.stringify(settingsPath)}`,
    '    debounceMs: 10',
    '- id: credentials',
    "  name: '@deepseek-ai/dsh-credentials-local'",
    '  config:',
    `    path: ${JSON.stringify(join(root, '.credentials.yaml'))}`,
    '    debounceMs: 10',
    '    mode: file',
    '- id: llm-pi-ai',
    "  name: '@deepseek-ai/dsh-llm-pi-ai'",
    ...options.base === undefined ? [] : [`  config: ${JSON.stringify(options.base)}`],
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([{ source: 'process', values: {} }]))
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['test-llm-service', LlmRuntime],
    ['@deepseek-ai/dsh-settings-file', FileSettingsProvider],
    ['@deepseek-ai/dsh-credentials-local', LocalCredentialProvider],
    ['@deepseek-ai/dsh-llm-pi-ai', LlmPiAi],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await ctx.loader.await()
  return { ctx, settingsPath }
}

describe('llm-pi-ai real dormant composition', () => {
  it.each([
    ['created-version', 'terminal-version', 'terminal-version'],
    ['created-version', undefined, 'created-version'],
    [undefined, undefined, undefined],
  ])('preserves Responses server identity without filling it from the requested alias (%s/%s)', async (created, terminal, expected) => {
    const message = { id: 'msg-fixture', type: 'message', role: 'assistant',
      content: [{ type: 'output_text', text: 'hello', annotations: [] }] }
    const events = [
      { type: 'response.created', response: { id: 'resp-fixture', model: created } },
      { type: 'response.output_item.added', output_index: 0, item: { ...message, content: [] } },
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'hello' },
      { type: 'response.output_item.done', output_index: 0, item: message },
      { type: 'response.completed', response: { id: 'resp-fixture', model: terminal, status: 'completed',
        output: [message], usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 } } },
    ].map(event => JSON.stringify(event))
    const server = await mockServer([{ events }])
    const { ctx } = await loadComposition({ user: { providers: { openai: {
      api: 'openai-responses', baseURL: server.url, apiKeyEnv: 'PI_COMPOSITION_KEY',
      models: [{ id: 'requested-alias' }],
    } } } })
    const result = await assemble(ctx, { provider: 'openai', model: 'requested-alias',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'hello' }],
        source: { kind: 'plugin', plugin: 'test' } })],
    })
    expect(result.finish).toEqual({ kind: 'stop' })
    expect(result.message.source).toMatchObject({ replayState: { response: { model: 'requested-alias', responseId: 'resp-fixture' } } })
    if (expected === undefined) expect(result.message.source).not.toHaveProperty('replayState.response.responseModel')
    else expect(result.message.source).toHaveProperty('replayState.response.responseModel', expected)
    expect(server.paths).toEqual(['/responses'])
    expect(server.requests[0]).toMatchObject({ model: 'requested-alias', stream: true })
  })

  it.each([true, false])('checks actual DeepSeek generation when model details are absent (accepted=%s)', async (accepted) => {
    const server = await mockServer([{ status: 404 }, accepted ? { events: textEvents } : {
      status: 401, body: JSON.stringify({ error: { message: 'synthetic credential rejected', type: 'authentication_error' } }),
    }])
    const { ctx } = await loadComposition({ user: { providers: { deepseek: {
      apiKeyEnv: 'PI_COMPOSITION_KEY', baseURL: `${server.url}/v1`,
    } } } })
    const request = { provider: 'deepseek', model: 'deepseek-v4-flash' }
    const operation = ctx.llm.remoteVerifyProvider(request, new AbortController().signal)
    if (accepted) await expect(operation).resolves.toMatchObject({ ...request, verified: true, mode: 'minimal-generation' })
    else await expect(operation).rejects.toMatchObject({ failure: { code: 'provider-verification-failed' } })
    expect(server.paths).toEqual(['/v1/models/deepseek-v4-flash', '/v1/chat/completions'])
    expect(server.requests[1]).toMatchObject({ model: request.model })
  })
  it('replays an ordinary Bailian chat through the real Loader and HTTP protocol', async () => {
    const server = await mockServer([{ events: textEvents }])
    const { ctx } = await loadComposition({ user: { providers: { 'bailian-cn': {
      apiKeyEnv: 'PI_COMPOSITION_KEY', baseURL: `${server.url}/compatible-mode/v1`,
    } } } })
    const selection = { provider: 'bailian-cn', model: 'qwen3.8-flash' }
    const result = await assemble(ctx, { ...selection, messages: [createUserMessage({
      content: [{ type: 'text', text: 'hi' }], source: { kind: 'plugin', plugin: 'test' },
    })] })
    expect(server.requests[0]).toMatchObject({ model: selection.model })
    expect(server.headers[0]?.authorization).toBe('Bearer key-from-store')
    expect({ selection, path: server.paths[0], finish: result.finish, content: result.message.content }).toMatchInlineSnapshot(`
      {
        "content": [
          {
            "text": "hello",
            "type": "text",
          },
        ],
        "finish": {
          "kind": "stop",
        },
        "path": "/compatible-mode/v1/chat/completions",
        "selection": {
          "model": "qwen3.8-flash",
          "provider": "bailian-cn",
        },
      }
    `)
  })
  it('retains an unconstructible route as a repair diagnostic rather than losing Settings', async () => {
    const { ctx } = await loadComposition({ user: { providers: { 'missing-catalog': {} } } })
    expect(ctx.settings.remoteDescribe().namespaces.some(entry => entry.ns === 'llm-pi-ai')).toBe(true)
    expect(ctx.llm.remoteProviders().providers.find(entry => entry.provider === 'missing-catalog')?.error).toBeTruthy()
    await expect(ctx.llm.resolveModelInfo('missing-catalog', 'unavailable')).rejects.toMatchObject({ code: 'INVALID_CONFIG' })
  })

  it('rejects non-HTTP credential-header values without exposing them or dispatching', async () => {
    const { ctx } = await loadComposition({ user: { providers: { local: {
      api: 'openai-completions', baseURL: 'https://fixture.invalid', models: [{ id: 'local-model' }],
      credentialHeaders: { 'X-Credential': 'PI_COMPOSITION_KEY' },
    } } } })
    await ctx.credentials.set(credentialRef('PI_COMPOSITION_KEY'), 'synthetic-😀')
    const fetch = vi.fn(() => { throw new Error('invalid header must not reach HTTP') })
    vi.stubGlobal('fetch', fetch)
    const result = await assemble(ctx, { provider: 'local', model: 'local-model', messages: [] })
    expect(result.finish).toMatchObject({ kind: 'error', failure: { code: 'INVALID_CREDENTIAL' } })
    expect(JSON.stringify(result)).not.toContain('synthetic-')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('keeps catalog-invalid settings repairable without blocking independent providers', async () => {
    const stored = { providers: { openai: { modelOverrides: { 'removed-catalog-model': { name: 'Retained model' } } }, deepseek: {} } }
    const { ctx, settingsPath } = await loadComposition({ user: stored })
    const before = await readFile(settingsPath, 'utf8')
    const directory = ctx.llm.remoteProviders().providers
    const broken = directory.find(entry => entry.provider === 'openai')!
    expect(broken.error).toContain('removed-catalog-model')
    expect(await ctx.llm.listModels('openai')).not.toHaveLength(0)
    expect(await ctx.llm.listModels('deepseek')).not.toHaveLength(0)
    await expect(ctx.llm.resolveModelInfo('openai', 'removed-catalog-model')).rejects.toMatchObject({ code: 'INVALID_CONFIG' })
    expect(await readFile(settingsPath, 'utf8')).toBe(before)
    await ctx.settings.update(settingsNamespace('llm-pi-ai'), { providers: { deepseek: { displayName: 'Independent' } } })
    const namespace = ctx.settings.remoteDescribe().namespaces.find(entry => entry.ns === 'llm-pi-ai')!
    await expect(ctx.settings.mutate(settingsNamespace('llm-pi-ai'), [
      { op: 'set', path: ['providers', 'openai', 'displayName'], value: 'Still broken' },
    ], namespace.revision)).rejects.toThrow('removed-catalog-model')
    await ctx.settings.mutate(settingsNamespace('llm-pi-ai'), [
      { op: 'unset', path: ['providers', 'openai', 'modelOverrides', 'removed-catalog-model'] },
    ], namespace.revision)
    const repaired = ctx.llm.remoteProviders().providers.find(entry => entry.provider === 'openai')!
    expect(repaired.error).toBeUndefined()
    expect(ctx.llm.remoteProviders().providers.find(entry => entry.provider === 'deepseek')?.displayName).toBe('Independent')
    expect({ broken, repaired }).toMatchSnapshot()
  })

  it('carries private endpoint budgets and priority through the Loader and provider wire', async () => {
    const server = await mockServer([{ events: textEvents }])
    const { ctx } = await loadComposition({ user: { providers: { local: {
      api: 'openai-completions', baseURL: server.url, apiKeyEnv: 'PI_COMPOSITION_KEY',
      thinkingBudgets: { high: 4096 },
      compat: { thinkingTokenBudgetField: 'thinking_budget', vllmPriority: -1,
        thinkingFormat: 'chat-template', chatTemplateKwargs: { budget: { $var: 'thinking.budget' } } },
      models: [{ id: 'local-thinking', reasoningEfforts: { high: 'high' } }],
    } } } })
    const result = await assemble(ctx, { provider: 'local', model: 'local-thinking',
      reasoningEffort: ReasoningEffortId('high'),
      messages: [createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })],
    })
    expect(server.requests[0]).toMatchObject({ thinking_budget: 4096, priority: -1, chat_template_kwargs: { budget: 4096 } })
    expect({ request: server.requests[0], content: result.message.content, finish: result.finish }).toMatchSnapshot()
  })

  it('preserves provider-native effort through two assembled turns without a session format migration', async () => {
    const requests: unknown[] = []
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      requests.push(await new Request(input, init).json())
      const events = [
        { type: 'message_start', message: { id: 'msg-effort-fixture', type: 'message', role: 'assistant',
          model: 'claude-fixture', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
      ]
      return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
        { headers: { 'content-type': 'text/event-stream' } })
    })
    const { ctx } = await loadComposition({ user: { providers: { local: {
      api: 'anthropic-messages', baseURL: 'https://fixture.invalid', apiKeyEnv: 'PI_COMPOSITION_KEY',
      compat: { supportsMidConvoEffort: true, forceAdaptiveThinking: true },
      models: [{ id: 'claude-fixture', reasoningEfforts: { low: 'low', high: 'high' } }],
    } } } })
    const user = createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })
    const first = await assemble(ctx, { provider: 'local', model: 'claude-fixture',
      reasoningEffort: ReasoningEffortId('high'), messages: [user] })
    expect(first.finish).toEqual({ kind: 'stop' })
    expect(first.message.source).toMatchObject({ replayState: { response: { version: 2, providerThinkingLevel: 'high' } } })
    const second = await assemble(ctx, { provider: 'local', model: 'claude-fixture',
      reasoningEffort: ReasoningEffortId('low'), messages: [user, first.message, user] })
    expect(second.finish).toEqual({ kind: 'stop' })
    expect(second.message.source).toMatchObject({ replayState: { response: { version: 2, providerThinkingLevel: 'low' } } })
    expect({ requests,
      first: { content: first.message.content, source: first.message.source, finish: first.finish },
      second: { content: second.message.content, source: second.message.source, finish: second.finish },
    }).toMatchSnapshot()
  })

  it.each(['bearerToken', 'sessionToken', 'privateKey', 'aws_secret_access_key', 'aws_session_token', 'unrecognizedFutureOption'])
  ('withholds undeclared %s from every layer and refuses writes through the live owner', async (field) => {
    const retained = { providers: { openai: { apiKeyEnv: 'PI_COMPOSITION_KEY', [field]: 'synthetic-retained-private' } } }
    const { ctx, settingsPath } = await loadComposition({ base: retained, user: retained })
    const before = await readFile(settingsPath, 'utf8')
    const view = ctx.settings.remoteDescribe().namespaces.find(entry => entry.ns === 'llm-pi-ai')!
    expect(JSON.stringify(view)).not.toContain('synthetic-retained-private')
    expect(ctx.llm.remoteProviders().providers.find(entry => entry.provider === 'openai')).toMatchObject({
      active: false, migrationRequired: { paths: [[field]], inheritedPaths: [[field]] },
    })
    await expect(ctx.settings.mutate(settingsNamespace('llm-pi-ai'),
      [{ op: 'set', path: ['providers', 'openai', field], value: 'synthetic-new-private' }], view.revision,
    )).rejects.toThrow('credential headers must use credential references')
    expect(await readFile(settingsPath, 'utf8')).toBe(before)
  })

  it('redacts schema-invalid dictionary keys retained after a file watcher update', async () => {
    const { ctx, settingsPath } = await loadComposition({ user: { providers: { openai: { models: [] } } } })
    const before = ctx.settings.remoteDescribe().namespaces.find(entry => entry.ns === 'llm-pi-ai')!
    const modelIds = (await ctx.llm.listModels('openai')).map(model => model.id)
    const invalid = JSON.stringify({ 'llm-pi-ai': { providers: { openai: { models: [{
      id: 'gpt-test', reasoningEfforts: { bearerToken: 'synthetic-private', high: 'high' },
    }] } } } })
    const incoming = `${settingsPath}.incoming`
    await writeFile(incoming, invalid)
    await rename(incoming, settingsPath)
    await vi.waitFor(() => {
      const view = ctx.settings.remoteDescribe().namespaces.find(entry => entry.ns === 'llm-pi-ai')!
      expect(view.user).toMatchObject({ providers: { openai: { models: [{ id: 'gpt-test', reasoningEfforts: { high: 'high' } }] } } })
      expect(JSON.stringify(view)).not.toContain('synthetic-private')
      expect(view.value).toEqual(before.value)
    })
    expect((await ctx.llm.listModels('openai')).map(model => model.id)).toEqual(modelIds)
    expect(await readFile(settingsPath, 'utf8')).toBe(invalid)
  })

  it.each(['openai', 'local-gateway'])('commits removal of %s and replays its receipt without restoring the route', async (provider) => {
    const profile = provider === 'openai' ? {} : {
      baseURL: 'https://example.invalid/v1', api: 'openai-completions',
      models: [{ id: 'fixture-model', name: 'Fixture', contextWindow: 4096, maxTokens: 1024 }],
    }
    const { ctx } = await loadComposition({ user: { providers: { [provider]: profile } } })
    const descriptor = ctx.settings.describe().find(entry => entry.ns === 'llm-pi-ai')!
    expect(ctx.llm.listProviders().some(entry => entry.id === provider)).toBe(true)
    const request = { provider, transactionId: randomUUID(), settingsNs: 'llm-pi-ai',
      expectedRevision: descriptor.revision, ops: [{ op: 'unset' as const, path: ['providers', provider] }] }
    const result = await ctx.llm.remoteMutateProvider(request, new AbortController().signal)
    expect(result.live).toEqual({ accepted: true })
    expect(ctx.llm.listProviders().some(entry => entry.id === provider)).toBe(false)
    await expect(ctx.llm.remoteMutateProvider(request, new AbortController().signal)).resolves.toMatchObject({ live: { accepted: true } })
    await expect(ctx.llm.remoteMutateProvider({ ...request, transactionId: randomUUID(),
      ops: [{ op: 'set', path: ['providers', 'sibling'], value: {} }] }, new AbortController().signal)).rejects.toBeDefined()
    expect(ctx.llm.listProviders().some(entry => entry.id === provider)).toBe(false)
  })

  it.each(['retry', 'resume'])('finishes a removed custom profile after credential cleanup failed (%s)', async (mode) => {
    const provider = 'local-gateway'
    const reference = credentialRef('PI_REMOVAL_KEY')
    const { ctx } = await loadComposition({ user: { providers: { [provider]: {
      baseURL: 'https://example.invalid/v1', api: 'openai-completions', models: [{ id: 'fixture-model' }],
      apiKeyEnv: reference,
    } } } })
    await ctx.credentials.set(reference, 'synthetic-removal-key')
    const request = { provider, transactionId: randomUUID(), settingsNs: 'llm-pi-ai',
      expectedRevision: ctx.settings.describe().find(entry => entry.ns === 'llm-pi-ai')!.revision,
      ops: [{ op: 'unset' as const, path: ['providers', provider] }],
      credential: { op: 'unset' as const, ref: reference } }
    const unset = vi.spyOn(ctx.credentials, 'unset').mockRejectedValueOnce(new Error('synthetic cleanup interruption'))
    await expect(ctx.llm.remoteMutateProvider(request, new AbortController().signal))
      .rejects.toMatchObject({ failure: { code: 'provider-transaction-in-doubt', message: 'credential removal did not complete' } })
    expect(ctx.llm.listProviders().some(entry => entry.id === provider)).toBe(false)
    await expect(ctx.llm.remoteMutateProvider({ ...request, ops: [{ op: 'unset', path: ['providers', 'sibling'] }] },
      new AbortController().signal)).rejects.toBeDefined()
    const result = mode === 'retry'
      ? await ctx.llm.remoteMutateProvider(request, new AbortController().signal)
      : await ctx.llm.remoteResumeProvider(request, new AbortController().signal)
    expect(result.live).toEqual({ accepted: true })
    expect(await ctx.credentials.resolve(reference)).toBeUndefined()
    expect(ctx.llm.listProviders().some(entry => entry.id === provider)).toBe(false)
    unset.mockRestore()
  })

  it('keeps an inherited provider live after removing only its user override', async () => {
    const { ctx } = await loadComposition({ base: { providers: { openai: {} } }, user: { providers: { openai: { models: [] } } } })
    const result = await ctx.llm.remoteMutateProvider({ provider: 'openai', transactionId: randomUUID(), settingsNs: 'llm-pi-ai',
      expectedRevision: ctx.settings.describe().find(entry => entry.ns === 'llm-pi-ai')!.revision,
      ops: [{ op: 'unset', path: ['providers', 'openai'] }],
    }, new AbortController().signal)
    expect(result.live).toEqual({ accepted: true })
    expect(ctx.llm.listProviders().some(entry => entry.id === 'openai')).toBe(true)
  })

  it('redacts unknown stored secrets and migrates user-owned fields through the real provider transaction', async () => {
    const legacy = { apiKey: 'synthetic-old-api-key', token: 'synthetic-old-token',
      headers: { Authorization: 'synthetic-old-header' } }
    const { ctx, settingsPath } = await loadComposition({ user: { providers: { openai: legacy } } })
    const before = await readFile(settingsPath, 'utf8')
    const view = ctx.settings.remoteDescribe().namespaces.find(entry => entry.ns === 'llm-pi-ai')!
    expect(JSON.stringify(view)).not.toContain('synthetic-old-')
    expect(await readFile(settingsPath, 'utf8')).toBe(before)
    const provider = ctx.llm.remoteProviders().providers.find(entry => entry.provider === 'openai')!
    expect(provider).toMatchObject({ active: false, migrationRequired: { code: 'credential-fields', inheritedPaths: [] } })
    const paths = provider.migrationRequired!.paths!
    expect(paths).toEqual([['headers', 'Authorization'], ['apiKey'], ['token']])
    const reference = credentialRef('PI_MIGRATED_KEY')
    await ctx.llm.remoteMutateProvider({ provider: 'openai', transactionId: randomUUID(), settingsNs: 'llm-pi-ai',
      expectedRevision: view.revision,
      ops: [...paths.map(path => ({ op: 'unset' as const, path: ['providers', 'openai', ...path] })),
        { op: 'set', path: ['providers', 'openai', 'apiKeyEnv'], value: reference }],
      credential: { op: 'set', ref: reference, value: 'synthetic-migrated-key' },
    }, new AbortController().signal)
    expect(ctx.llm.remoteProviders().providers.find(entry => entry.provider === 'openai')).toMatchObject({ active: true })
    expect(ctx.llm.remoteProviders().providers.find(entry => entry.provider === 'openai')?.migrationRequired).toBeUndefined()
    expect(await readFile(settingsPath, 'utf8')).not.toContain('synthetic-old-')
    expect((await ctx.credentials.resolve(reference))?.value).toBe('synthetic-migrated-key')
    const journal = JSON.stringify(await ctx.credentials.readRecord(credentialKey('llm-remote', 'openai')))
    expect(journal).not.toContain('synthetic-old-')
    expect(journal).not.toContain('synthetic-migrated-key')
  })

  it('reports inherited secret fields and refuses user-layer migration without changing deployment or credentials', async () => {
    const { ctx, settingsPath } = await loadComposition({
      base: { providers: { openai: { accessToken: 'synthetic-base-token' } } } as LlmPiAi.Config,
      user: { providers: { openai: { apiKey: 'synthetic-user-key', token: 'synthetic-user-token' } } },
    })
    const before = await readFile(settingsPath, 'utf8')
    const view = ctx.settings.remoteDescribe().namespaces.find(entry => entry.ns === 'llm-pi-ai')!
    expect(JSON.stringify(view)).not.toContain('synthetic-')
    const migration = ctx.llm.remoteProviders().providers.find(entry => entry.provider === 'openai')!.migrationRequired!
    expect(migration.inheritedPaths).toEqual([['accessToken']])
    const reference = credentialRef('PI_BLOCKED_MIGRATION')
    await expect(ctx.llm.remoteMutateProvider({ provider: 'openai', transactionId: randomUUID(), settingsNs: 'llm-pi-ai',
      expectedRevision: view.revision,
      ops: [...migration.paths!.map(path => ({ op: 'unset' as const, path: ['providers', 'openai', ...path] })),
        { op: 'set', path: ['providers', 'openai', 'apiKeyEnv'], value: reference }],
      credential: { op: 'set', ref: reference, value: 'synthetic-new-key' },
    }, new AbortController().signal)).rejects.toMatchObject({ failure: { code: 'settings-rejected' } })
    expect(await readFile(settingsPath, 'utf8')).toBe(before)
    expect((await ctx.credentials.describe(reference)).configured).toBe(false)
  })

  it('restores the entire built-in catalog when an explicit empty model list overrides a narrowed base', async () => {
    const declared = catalogProvider('deepseek')!.getModels()
    expect(declared.length).toBeGreaterThan(1)
    const { ctx } = await loadComposition({ base: { providers: { deepseek: { models: [{ id: declared[0]!.id }] } } } })
    expect(await ctx.llm.listModels('deepseek')).toHaveLength(1)
    await ctx.settings.update(settingsNamespace('llm-pi-ai'), { providers: { deepseek: { models: [] } } })
    expect((await ctx.llm.listModels('deepseek')).map(model => model.id)).toEqual(declared.map(model => model.id))
  })

  it('offers every installed provider and routes credentials with provider-owned requirements and built-in endpoints', async () => {
    const { ctx } = await loadComposition()
    const ids = catalogProviderIds()
    expect(ids.length).toBeGreaterThan(0)
    expect(new Set(ids).size).toBe(ids.length)
    const directory = ctx.llm.remoteProviders().providers
    expect(ids.every(id => directory.some(entry => entry.provider === id && !entry.active))).toBe(true)
    await ctx.credentials.set(credentialRef('CLOUDFLARE_ACCOUNT_ID'), 'synthetic-account')
    await ctx.credentials.set(credentialRef('CLOUDFLARE_GATEWAY_ID'), 'synthetic-gateway')
    vi.stubGlobal('fetch', () => { throw new Error('catalog credential regression must not contact an external endpoint') })
    const profiles: Record<string, LlmPiAi.PiAiProviderProfile> = {}
    for (const id of ids) {
      const reference = credentialRef(`ARK_CATALOG_${id.replaceAll('-', '_').toUpperCase()}`)
      await ctx.credentials.set(reference, `synthetic-${id}-key`)
      profiles[id] = { apiKeyEnv: reference }
    }
    await ctx.settings.update(settingsNamespace('llm-pi-ai'), { providers: profiles })
    const failures: Array<{ provider: string; reason: string }> = []
    for (const id of ids) {
      const owner = catalogProvider(id)
      if (owner === undefined) throw new Error(`catalog route ${id} has no implementation owner`)
      const models = await ctx.llm.listModels(id)
      const declared = owner.getModels()
      expect(models, id).toHaveLength(declared.length)
      expect(models.length, id).toBeGreaterThan(0)
      for (const entry of declared) {
        const metadata = await ctx.llm.resolveModelInfo(id, entry.id)
        expect(metadata.context?.contextWindow, `${id}/${entry.id}`).toBe(entry.contextWindow)
        expect(metadata.inputModalities, `${id}/${entry.id}`).toEqual(entry.input)
        expect(metadata.defaultMaxTokens, `${id}/${entry.id}`).toBeUndefined()
        if (entry.reasoning) {
          expect(metadata.reasoning?.efforts.map(effort => String(effort.id)), `${id}/${entry.id}`)
            .toEqual(getSupportedThinkingLevels(entry))
        }
      }
      const transport = vi.spyOn(owner, 'streamSimple').mockImplementation(() => { throw new Error('synthetic transport boundary') })
      try {
        await assemble(ctx, { provider: id, model: models[0]!.id, messages: [] })
        if (transport.mock.calls.length !== 1) failures.push({ provider: id, reason: 'credential did not reach native provider transport' })
        else {
          expect(transport.mock.calls[0]?.[2]?.apiKey, id).toBe(`synthetic-${id}-key`)
          expect(transport.mock.calls[0]?.[0].baseUrl, id).toBe(owner.getModels()[0]!.baseUrl)
          const reference = credentialRef(`ARK_CATALOG_${id.replaceAll('-', '_').toUpperCase()}`)
          await ctx.credentials.set(reference, `synthetic-${id}-rotated`)
          await assemble(ctx, { provider: id, model: models[0]!.id, messages: [] })
          expect(transport.mock.calls[1]?.[2]?.apiKey, id).toBe(`synthetic-${id}-rotated`)
          await ctx.credentials.unset(reference)
          const missing = await assemble(ctx, { provider: id, model: models[0]!.id, messages: [] })
          expect(missing.finish, id).toMatchObject({ kind: 'error', failure: { code: 'MISSING_CREDENTIAL' } })
          await ctx.credentials.set(reference, 'synthetic-invalid-\u{1f600}')
          const invalid = await assemble(ctx, { provider: id, model: models[0]!.id, messages: [] })
          expect(invalid.finish, id).toMatchObject({ kind: 'error', failure: { code: 'INVALID_CREDENTIAL' } })
          expect(transport, id).toHaveBeenCalledTimes(2)
        }
      } finally { transport.mockRestore() }
    }
    expect(failures).toEqual([])
  })

  it('projects legacy header migration without revealing or rewriting retained credentials', async () => {
    const legacy = { providers: { openai: { headers: { Authorization: 'synthetic-legacy-private', 'X-Public': 'visible' } } } }
    const { ctx, settingsPath } = await loadComposition({ base: legacy, user: legacy })
    const before = await readFile(settingsPath, 'utf8')
    const directory = ctx.llm.remoteProviders().providers.find(entry => entry.provider === 'openai')
    const view = ctx.settings.remoteDescribe().namespaces.find(entry => entry.ns === 'llm-pi-ai')!
    expect(directory).toMatchObject({ active: false, migrationRequired: { code: 'credential-headers', fields: ['Authorization'] } })
    expect(JSON.stringify(view)).not.toContain('synthetic-legacy-private')
    expect(view.value).toMatchObject({ providers: { openai: { headers: { 'X-Public': 'visible' } } } })
    expect(view.base).toMatchObject({ providers: {
      openai: { headers: { 'X-Public': 'visible' } },
    } })
    expect(view.user).toEqual({ providers: { openai: { headers: { 'X-Public': 'visible' } } } })
    await expect(ctx.settings.replace(settingsNamespace('llm-pi-ai'), legacy)).rejects.toThrow(/credential headers must use credential references/)
    expect(await readFile(settingsPath, 'utf8')).toBe(before)
    expect(ctx.llm.listProviders()).toEqual([])
  })

  it('verifies exact metadata through the Loader, live settings and credential owner without a generation request', async () => {
    const { ctx } = await loadComposition()
    const requests: Array<{ path: string; credential: boolean; publicHeader: string | null }> = []
    vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      requests.push({ path: new URL(input).pathname,
        credential: headers.get('x-vendor-proof') === 'key-from-store', publicHeader: headers.get('x-public') })
      return headers.has('x-vendor-proof') ? new Response(JSON.stringify({ id: 'exact-model' })) : new Response(null, { status: 401 })
    })
    await ctx.settings.update(settingsNamespace('llm-pi-ai'), { providers: { 'fixture-gateway': {
      api: 'openai-completions', baseURL: 'https://fixture.invalid/v1', models: [{ id: 'exact-model' }],
      headers: { 'X-Public': 'public' }, credentialHeaders: { 'X-Vendor-Proof': 'PI_COMPOSITION_KEY' },
    } } })
    const result = await ctx.llm.remoteVerifyProvider({ provider: 'fixture-gateway', model: 'exact-model' }, new AbortController().signal)
    expect({ result, requests }).toMatchSnapshot()
    await ctx.credentials.unset(credentialRef('PI_COMPOSITION_KEY'))
    await expect(ctx.llm.remoteVerifyProvider({ provider: 'fixture-gateway', model: 'exact-model' }, new AbortController().signal))
      .rejects.toMatchObject({ failure: { code: 'provider-verification-failed' } })
    expect(requests).toHaveLength(2)
  })

  it('boots with zero routes and registers one the moment settings supply a profile', async () => {
    vi.stubEnv('PI_COMPOSITION_KEY', '')
    const server = await mockServer([{ events: textEvents }])
    const { ctx, settingsPath } = await loadComposition()

    // The shipped posture: the adapter exists, no route does.
    expect(ctx.llm.listProviders()).toEqual([])

    // Exactly what the web Models page leaves on disk.
    await writeFile(settingsPath, [
      'llm-pi-ai:',
      '  providers:',
      '    deepseek:',
      '      apiKeyEnv: PI_COMPOSITION_KEY',
      `      baseURL: ${server.url}`,
      '',
    ].join('\n'))
    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['deepseek'])
    }, { timeout: 5000 })

    const result = await assemble(ctx, { provider: 'deepseek', model: 'deepseek-v4-flash', messages: [] })
    expect(result.message.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(server.headers[0]?.authorization).toBe('Bearer key-from-store')
  })

  it('continues natively after max-token assembly drops a tool call, with pruned replay metadata', async () => {
    vi.stubEnv('PI_COMPOSITION_KEY', '')
    const server = await mockServer([
      { events: truncatedToolCallEvents },
      { events: textEvents },
    ])
    const { ctx, settingsPath } = await loadComposition()
    await writeFile(settingsPath, [
      'llm-pi-ai:',
      '  providers:',
      '    deepseek:',
      '      apiKeyEnv: PI_COMPOSITION_KEY',
      `      baseURL: ${server.url}`,
      '',
    ].join('\n'))
    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['deepseek'])
    }, { timeout: 5000 })

    const truncated = await assemble(ctx, {
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      messages: [],
    })
    expect(truncated.finish).toEqual({ kind: 'max-tokens' })
    expect(truncated.message.content).toEqual([{ type: 'text', text: 'partial' }])
    expect(truncated.message.source).toEqual({
      kind: 'model',
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      replayState: {
        response: {
          kind: 'pi-ai',
          version: 2,
          api: 'openai-completions',
          provider: 'deepseek',
          model: 'deepseek-v4-flash',
          stopReason: 'length',
        },
        blocks: [{ type: 'text' }],
      },
    })

    const continued = await assemble(ctx, {
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      messages: [
        truncated.message,
        createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }),
      ],
    })
    expect(continued.message.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(server.requests).toHaveLength(2)
    expect(server.requests[1]).toMatchObject({
      messages: [
        { role: 'assistant', content: 'partial' },
        { role: 'user', content: 'continue' },
      ],
    })
    const followup = server.requests[1] as { messages?: unknown[] }
    expect(followup.messages?.[0]).not.toHaveProperty('tool_calls')
  })

  it('continues a legacy session whose stored replay state no longer matches its content', async () => {
    vi.stubEnv('PI_COMPOSITION_KEY', '')
    const server = await mockServer([{ events: textEvents }])
    const { ctx, settingsPath } = await loadComposition()
    await writeFile(settingsPath, [
      'llm-pi-ai:',
      '  providers:',
      '    deepseek:',
      '      apiKeyEnv: PI_COMPOSITION_KEY',
      `      baseURL: ${server.url}`,
      '',
    ].join('\n'))
    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['deepseek'])
    }, { timeout: 5000 })

    // A pre-envelope session log entry: max-token assembly dropped the tool
    // call from content while the flat v1 state still describes both blocks.
    const poisoned = createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'partial' }],
      source: {
        kind: 'model',
        ...{
          provider: 'deepseek',
          model: 'deepseek-v4-flash',
          replayState: {
            kind: 'pi-ai',
            version: 1,
            api: 'openai-completions',
            provider: 'deepseek',
            model: 'deepseek-v4-flash',
            stopReason: 'length',
            blocks: [{ type: 'text' }, { type: 'tool-call' }],
          },
        },
      },
    })
    const continued = await assemble(ctx, {
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      messages: [
        poisoned,
        createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }),
      ],
    })
    expect(continued.finish).toEqual({ kind: 'stop' })
    expect(continued.message.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(server.requests[0]).toMatchObject({
      messages: [
        { role: 'assistant', content: 'partial' },
        { role: 'user', content: 'continue' },
      ],
    })
  })
})
