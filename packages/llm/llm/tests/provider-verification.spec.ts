import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import LlmRuntime, { LlmAdapter, LlmError } from '../src/index.ts'
import type { GenerateOptions, LlmProviderVerificationMode, StreamChunk } from '../src/index.ts'

class ProbeAdapter extends LlmAdapter {
  requests: GenerateOptions[] = []
  probe: (signal: AbortSignal) => Promise<LlmProviderVerificationMode | undefined> = async () => undefined
  chunks: StreamChunk[] = [{ type: 'finish', reason: { kind: 'stop' } }]
  override verifyProvider(_provider: string, _model: string, signal: AbortSignal) { return this.probe(signal) }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield* this.chunks
  }
}

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose() })

async function runtime(options: { verificationTimeoutMs?: number; verificationCancellationGraceMs?: number } = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  const fiber = ctx.plugin(LlmRuntime, { verificationTimeoutMs: 100, verificationCancellationGraceMs: 10, ...options })
  await fiber
  const adapter = new ProbeAdapter()
  ctx.llm.registerAdapter(['fixture'], adapter)
  return { ctx, adapter, fiber }
}

const request = { provider: 'fixture', model: 'exact-model' }

it('resolves verification deadlines and refuses invalid timer bounds before service registration', async () => {
  expect(LlmRuntime.Config({})).toEqual({ verificationTimeoutMs: 15_000, verificationCancellationGraceMs: 2_000 })
  const ctx = new Context()
  try {
    for (const field of ['verificationTimeoutMs', 'verificationCancellationGraceMs']) {
      for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
        expect(() => new LlmRuntime(ctx, { [field]: value })).toThrow()
        expect(ctx.get('llm')).toBeUndefined()
      }
    }
  } finally { await ctx.fiber.dispose() }
})

it.each(['metadata-auth', 'endpoint-catalog'] as const)('classifies %s without generating a model response', async (mode) => {
  const { ctx, adapter } = await runtime()
  adapter.probe = async () => mode
  expect(await ctx.llm.remoteVerifyProvider(request, new AbortController().signal)).toEqual(mode === 'metadata-auth'
    ? { ...request, verified: true, mode }
    : { ...request, verified: false, mode, classification: 'reachability-only' })
  expect(adapter.requests).toEqual([])
})

it('uses the adapter default to request a bounded one-token generation fallback', async () => {
  const { ctx, adapter } = await runtime()
  adapter.probe = signal => LlmAdapter.prototype.verifyProvider.call(adapter, request.provider, request.model, signal)
  adapter.chunks = [{ type: 'text-delta', index: 0, text: 'synthetic-private-output' }, { type: 'finish', reason: { kind: 'stop' } }]
  expect(await ctx.llm.remoteVerifyProvider(request, new AbortController().signal))
    .toEqual({ ...request, verified: true, mode: 'minimal-generation' })
  expect(adapter.requests).toHaveLength(1)
  expect(adapter.requests[0]).toMatchObject({ provider: 'fixture', model: 'exact-model', maxTokens: 1,
    messages: [{ content: [{ type: 'text', text: '.' }], source: { kind: 'plugin', plugin: 'llm-verification' } }] })
})

it.each(['closed', 'error', 'aborted'] as const)('does not verify a %s fallback and never returns provider diagnostics', async (kind) => {
  const { ctx, adapter } = await runtime()
  adapter.chunks = kind === 'closed' ? [] : [{ type: 'finish', reason: { kind,
    failure: { message: 'synthetic-private-provider-output', code: 'AUTH' } } }]
  await expect(ctx.llm.remoteVerifyProvider(request, new AbortController().signal)).rejects.toMatchObject({
    failure: { code: 'provider-verification-failed', message: 'provider/model authentication verification failed' },
  })
})

it('keeps a cancelled uncooperative probe reserved until it actually stops', async () => {
  const { ctx, adapter } = await runtime()
  const started = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<'metadata-auth'>()
  adapter.probe = () => { started.resolve(undefined); return release.promise }
  const cancellation = new AbortController()
  const operation = ctx.llm.remoteVerifyProvider(request, cancellation.signal)
  const failed = expect(operation).rejects.toMatchObject({ failure: { code: 'provider-verification-still-running' } })
  await started.promise
  cancellation.abort()
  try {
    await failed
    await expect(ctx.llm.verifyModel(request.provider, request.model, new AbortController().signal))
      .rejects.toMatchObject({ code: 'VERIFICATION_STILL_RUNNING' })
  } finally { release.resolve('metadata-auth') }
  await new Promise(resolve => setTimeout(resolve, 0))
  adapter.probe = async () => 'metadata-auth'
  expect(await ctx.llm.remoteVerifyProvider(request, new AbortController().signal)).toMatchObject({ verified: true })
})

it.each(['cancel', 'deadline'] as const)('distinguishes cooperative %s from authentication failure', async (kind) => {
  const { ctx, adapter } = await runtime({ verificationTimeoutMs: 10 })
  const started = Promise.withResolvers<undefined>()
  adapter.probe = signal => new Promise((resolve) => {
    signal.addEventListener('abort', () => { resolve('metadata-auth') }, { once: true })
    started.resolve(undefined)
  })
  const cancellation = new AbortController()
  const operation = ctx.llm.remoteVerifyProvider(request, cancellation.signal)
  const failed = expect(operation).rejects.toMatchObject({ failure: {
    code: kind === 'cancel' ? 'cancelled' : 'provider-verification-timeout',
  } })
  await started.promise
  if (kind === 'cancel') cancellation.abort()
  await failed
})

it('drains a cooperative verification when its actual LLM owner is disposed', async () => {
  const { ctx, adapter } = await runtime()
  const started = Promise.withResolvers<undefined>()
  adapter.probe = signal => new Promise((resolve) => {
    signal.addEventListener('abort', () => { resolve('metadata-auth') }, { once: true })
    started.resolve(undefined)
  })
  const llm = ctx.llm
  const operation = llm.verifyModel(request.provider, request.model, new AbortController().signal)
  const failed = expect(operation).rejects.toMatchObject({ code: 'ABORTED' })
  await started.promise
  await ctx.fiber.dispose()
  await failed
  await expect(llm.verifyModel(request.provider, request.model, new AbortController().signal)).rejects.toBeInstanceOf(LlmError)
})

it('reports an uncooperative probe instead of acknowledging completed runtime disposal', async () => {
  const { ctx, adapter, fiber } = await runtime()
  const logged = vi.spyOn(fiber.ctx.logger, 'error').mockImplementation(() => undefined)
  const started = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<'metadata-auth'>()
  adapter.probe = () => { started.resolve(undefined); return release.promise }
  const operation = ctx.llm.verifyModel(request.provider, request.model, new AbortController().signal)
  const failed = expect(operation).rejects.toMatchObject({ code: 'VERIFICATION_STILL_RUNNING' })
  await started.promise
  try {
    await Promise.all([ctx.fiber.dispose(), failed])
    expect(logged).toHaveBeenCalledWith(expect.objectContaining({ code: 'VERIFICATION_STILL_RUNNING' }))
  } finally { release.resolve('metadata-auth'); logged.mockRestore() }
})

it('honors cancellation between probe completion and delivery to its caller', async () => {
  const { ctx, adapter } = await runtime()
  const outcomes: string[] = []
  for (let depth = 1; depth <= 12; depth++) {
    const cancellation = new AbortController()
    const queueAbort = (remaining: number) => {
      if (remaining === 0) cancellation.abort()
      else queueMicrotask(() => { queueAbort(remaining - 1) })
    }
    adapter.probe = async () => { queueAbort(depth); return 'metadata-auth' }
    try { outcomes.push(await ctx.llm.verifyModel(request.provider, request.model, cancellation.signal)) }
    catch (error) {
      expect(error).toMatchObject({ code: 'ABORTED' })
      outcomes.push('aborted')
    }
  }
  expect(outcomes).toContain('aborted')
  expect(outcomes).toContain('metadata-auth')
})

it('rejects malformed identities and pre-cancelled requests before adapter I/O', async () => {
  const { ctx, adapter } = await runtime()
  await expect(ctx.llm.remoteVerifyProvider({ ...request, provider: 'INVALID' }, new AbortController().signal))
    .rejects.toMatchObject({ failure: { code: 'input-invalid' } })
  await expect(ctx.llm.remoteVerifyProvider({ ...request, model: ' ' }, new AbortController().signal))
    .rejects.toMatchObject({ failure: { code: 'input-invalid' } })
  await expect(ctx.llm.remoteVerifyProvider(request, AbortSignal.abort())).rejects.toMatchObject({ failure: { code: 'cancelled' } })
  expect(adapter.requests).toEqual([])
})
