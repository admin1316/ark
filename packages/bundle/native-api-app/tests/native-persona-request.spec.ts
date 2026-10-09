/**
 * Actual Native shipped presets reach the real AgentLoop request and durable
 * log. Only the external model is scripted; its output proves preservation,
 * never model compliance with the guidance being tested.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { CallId, createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { expect, it } from 'vitest'
import { createNativePresetRuntime } from './native-preset-runtime.ts'

const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url))
const provider = 'native-persona-fixture'
const model = 'native-persona-model'
const prelude = "I'll read the input before returning JSON."
const result = '{"value":7}'
const keylessPatches = [
  { id: 'llm-deepseek', disabled: true },
  { id: 'plugin-package-inventory-deepseek', disabled: true },
  { id: 'session-title-llm', disabled: true },
] as const

function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

class ScriptedModel extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly responses: StreamChunk[][]) { super() }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const response = this.responses.shift()
    if (response === undefined) throw new Error('Native persona fixture exhausted')
    yield * response
  }
}

async function shippedPersona(preset: string): Promise<string> {
  const entries = yaml.load(await readFile(join(repoRoot,
    'packages/boot/profile-runner/config/agent-presets', preset, 'agent.cordis.yml'), 'utf8'),
  { schema: entryListSchema }) as { id: string; config?: { text?: string } }[]
  const text = entries.find(row => row.id === 'persona')?.config?.text
  if (text === undefined) throw new Error(`Native ${preset} has no persona`)
  return text
}

// Full headers include platform-owned shell schemas and the generated PTC SDK.
// These goldens belong to POSIX; Windows needs its own real pwsh observation.
it.runIf(process.platform !== 'win32').each(['standard', 'code', 'minimal'] as const)(
  'logs the complete rendered shipped Native %s persona and exact request header', async (preset) => {
    const runtime = await createNativePresetRuntime(keylessPatches)
    const ctx = runtime.context
    let handle: Awaited<ReturnType<typeof ctx.agents.create>> | undefined
    let unregister: (() => void) | undefined
    try {
      const adapter = new ScriptedModel([textResponse(result)])
      unregister = ctx.llm.registerAdapter([provider], adapter)
      const world = join(runtime.home, 'world')
      await mkdir(world)
      handle = await ctx.agents.create({
        sessionId: SessionId(`native-persona-${preset}`),
        meta: { cwd: world },
        agentOptions: { provider, model },
        setup: agentCtx => ctx.agentPresets.mount(agentCtx, preset).then(() => undefined),
      })
      const persona = (await shippedPersona(preset))
        .replaceAll('{{model}}', model).replaceAll('{{cwd}}', world)
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Return only {"value":7}.' }],
        source: { kind: 'user' } }))
      await handle.agent.whenIdle()
      await ctx.sessions.flush(handle.agent.session)
      expect(adapter.requests).toHaveLength(1)
      const header = handle.agent.session.requestHeader()
      expect(header).toBeDefined()
      expect(header?.system).toBe(adapter.requests[0]?.system)
      expect(header?.tools).toEqual(adapter.requests[0]?.tools)
      expect(header?.config).toMatchObject({ provider, model })
      if (preset === 'minimal') {
        expect(header?.system).toBe('You are a helpful software engineer assistant.')
        expect(header?.system).not.toContain('Follow the user\'s requested output format')
        expect(handle.agent.session.events.filter(event => event.type === 'user/message'
          && event.data.source.kind === 'plugin')).toEqual([])
      } else {
        expect(header?.system).toContain(persona)
        expect(header?.system).not.toContain('你是 Ark。')
        expect(header?.system).not.toContain('{{model}}')
        expect(header?.system).not.toContain('{{cwd}}')
        expect(persona).toBe((await shippedPersona(preset === 'standard' ? 'code' : 'standard'))
          .replaceAll('{{model}}', model).replaceAll('{{cwd}}', world))
      }
      const stored = await ctx.sessionPersistence.inspect(handle.agent.session.id)
      const raw = await ctx.sessionPersistence.readRaw(handle.agent.session.id)
      expect(stored).toBeDefined()
      expect(raw).toBeDefined()
      const liveHeaders = handle.agent.session.events.filter(event => event.type === 'request/header')
      expect(stored?.events.filter(event => event.type === 'request/header')).toEqual(liveHeaders)
      expect(raw?.content).toContain(JSON.stringify(liveHeaders[0]?.data))
      // Only paths owned by this fixture and the source checkout vary. Keep all
      // model-visible sections and tool descriptions in the full header pin.
      expect(JSON.parse(JSON.stringify(header).replaceAll(runtime.home, '{{testHome}}')
        .replaceAll(repoRoot, '{{sourceRoot}}'))).toMatchSnapshot()
    } finally {
      await handle?.dispose()
      unregister?.()
      await runtime.dispose()
    }
  }, 120_000,
)

it('preserves a model prelude, a real tool read, and final JSON across the entire Native turn', async () => {
  const runtime = await createNativePresetRuntime(keylessPatches)
  const ctx = runtime.context
  let handle: Awaited<ReturnType<typeof ctx.agents.create>> | undefined
  let unregister: (() => void) | undefined
  try {
    const world = join(runtime.home, 'world')
    await mkdir(world)
    const input = join(world, 'input.txt')
    const original = '7\n'
    await writeFile(input, original)
    const callId = CallId('native-persona-read')
    const adapter = new ScriptedModel([
      [
        ...textResponse(prelude).slice(0, -1),
        { type: 'block-start', index: 1, blockType: 'tool-call' },
        { type: 'tool-call-delta', index: 1, id: callId, name: 'read',
          argumentsDelta: JSON.stringify({ file_path: input }) },
        { type: 'block-end', index: 1, block: { type: 'tool-call', id: callId, name: 'read',
          arguments: JSON.stringify({ file_path: input }) } },
        { type: 'finish', reason: { kind: 'tool-calls' } },
      ],
      textResponse(result),
    ])
    unregister = ctx.llm.registerAdapter([provider], adapter)
    handle = await ctx.agents.create({ sessionId: SessionId('native-persona-unfiltered'),
      meta: { cwd: world }, agentOptions: { provider, model },
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'standard').then(() => undefined) })
    handle.agent.followup(createUserMessage({ content: [{ type: 'text',
      text: 'Read input.txt and return only one JSON value with its integer value.' }], source: { kind: 'user' } }))
    await handle.agent.whenIdle()
    await ctx.sessions.flush(handle.agent.session)
    expect(adapter.requests).toHaveLength(2)
    expect(adapter.requests[0]?.system).toContain((await shippedPersona('standard'))
      .replaceAll('{{model}}', model).replaceAll('{{cwd}}', world))
    const live = handle.agent.session.events
    const ordinary = live.flatMap(event => event.type === 'assistant/message'
      ? event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []) : [])
    expect(ordinary).toEqual([prelude, result])
    expect(() => { JSON.parse(ordinary.join('')) }).toThrow()
    expect(live.filter(event => event.type === 'tool/call').map(event => event.data.name)).toEqual(['read'])
    const toolResults = live.flatMap(event => event.type === 'tool/result' ? event.data.message.content : [])
    expect(toolResults).toHaveLength(1)
    expect(toolResults[0]).toMatchObject({ type: 'tool-result', isError: false })
    const toolText = toolResults.flatMap(block => block.type === 'tool-result'
      ? block.content.flatMap(part => part.type === 'text' ? [part.text] : []) : [])
    expect(toolText).toHaveLength(1)
    expect(toolText[0]).toContain('7')
    expect(await readFile(input, 'utf8')).toBe(original)
    const stored = await ctx.sessionPersistence.inspect(handle.agent.session.id)
    const persistedOrdinary = stored?.events.flatMap(event => event.type === 'assistant/message'
      ? event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []) : [])
    expect(persistedOrdinary).toEqual(ordinary)
    const raw = await ctx.sessionPersistence.readRaw(handle.agent.session.id)
    expect(raw?.content).toContain(prelude)
    expect(raw?.content).toContain(JSON.stringify(result))
    expect({ ordinary, fullOutput: ordinary.join(''), toolNames: ['read'], inputUnchanged: true }).toMatchSnapshot()
  } finally {
    await handle?.dispose()
    unregister?.()
    await runtime.dispose()
  }
}, 120_000)
