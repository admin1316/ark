import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { startCostGuard } from './knowledge-cost-guard.mjs'

const encoder = new TextEncoder()
const basePayload = {
  model: 'deepseek-flash',
  messages: [
    { role: 'system', content: 'text-only system' },
    { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read', arguments: '{"path":"x"}' } }] },
    { role: 'tool', tool_call_id: 'call-1', content: 'done' },
  ],
  stream: true,
  stream_options: { include_usage: true },
  max_tokens: 8_192,
  dsh_plugin_packages: {
    version: 1,
    packages: [
      { name: '@deepseek-ai/dsh-deepseek-llm-api-extensions', version: '0.1.1-rc.2' },
      { name: '@deepseek-ai/dsh-llm-deepseek', version: '0.1.1-rc.2' },
    ],
  },
  tools: [{ type: 'function', function: { name: 'read', description: 'read file', parameters: { type: 'object' } } }],
}
const requestBody = JSON.stringify(basePayload)
const usage = { prompt_tokens: 10_000, completion_tokens: 200, total_tokens: 10_200 }

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'ark-cost-guard-offline-'))
  const ledgerPath = join(directory, 'ledger.json')
  try { await run({ directory, ledgerPath }) } finally { await rm(directory, { recursive: true, force: true }) }
}

function sseEvent(value) { return `data: ${JSON.stringify(value)}\n\n` }
function initialLedger(overrides = {}) {
  return {
    schema: 2,
    budgetMicroCny: 5_000_000,
    maxRequests: 32,
    requestCount: 0,
    settledUpperBoundMicroCny: 0,
    pending: [],
    ...overrides,
  }
}
function validBody({ usageValue = usage, responseId = 'resp-1', responseModel = 'deepseek-flash' } = {}) {
  const common = { id: responseId, object: 'chat.completion.chunk', created: 1, model: responseModel }
  return [
    sseEvent({ ...common, choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }], usage: null }),
    sseEvent({ ...common, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: usageValue }),
    'data: [DONE]\n\n',
  ].join('')
}
function mockResponse(body = validBody(), status = 200) {
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream; charset=utf-8' } })
}
function upstreamMock(calls, body = validBody()) {
  return async (url, options) => {
    calls.push({ url, options })
    return mockResponse(body)
  }
}
async function post(baseURL, payload = basePayload) {
  return fetch(`${baseURL}/chat/completions`, {
    method: 'POST', headers: { authorization: 'Bearer offline-placeholder', 'content-type': 'application/json' },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  })
}
async function waitUntil(predicate, timeoutMs = 2_000) {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('condition did not become true within test deadline')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}
async function readUsageLedger(path) { return JSON.parse(await readFile(path, 'utf8')) }

function rawPost(baseURL, body = requestBody) {
  const url = new URL(`${baseURL}/chat/completions`)
  const request = httpRequest({
    hostname: url.hostname, port: Number(url.port), path: url.pathname, method: 'POST',
    headers: {
      authorization: 'Bearer offline-placeholder', 'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    },
  })
  const response = new Promise((resolve, reject) => {
    request.once('response', resolve)
    request.once('error', reject)
  })
  request.end(body)
  return { request, response }
}

test('forwards valid serialized text/tool wire unchanged, settles exact usage, and admits several real attempts under CNY 5', async () => {
  await fixture(async ({ ledgerPath }) => {
    const calls = []
    const guard = await startCostGuard({ ledgerPath, fetchImpl: upstreamMock(calls) })
    try {
      for (let index = 0; index < 5; index += 1) {
        const response = await post(guard.baseURL)
        assert.equal(response.status, 200)
        assert.equal(await response.text(), validBody())
      }
      assert.equal(calls.length, 5)
      for (const call of calls) {
        assert.equal(call.url, 'https://api.deepseek.com/chat/completions')
        assert.equal(Buffer.from(call.options.body).toString(), requestBody)
        assert.equal(call.options.headers.get('authorization'), 'Bearer offline-placeholder')
        assert.equal(call.options.redirect, 'error')
        assert.ok(call.options.signal instanceof AbortSignal)
      }
      assert.deepEqual(await readUsageLedger(ledgerPath), {
        schema: 2,
        budgetMicroCny: 5_000_000,
        maxRequests: 32,
        requestCount: 5,
        settledUpperBoundMicroCny: 5 * (10_000 * 2 + 200 * 8),
        pending: [],
      })
    } finally { await guard.close() }
  })
})

test('rejects n, alternate output caps, unknown modalities, image/file/audio/video content before spending a reservation', async () => {
  await fixture(async ({ ledgerPath }) => {
    const calls = []
    const guard = await startCostGuard({ ledgerPath, fetchImpl: upstreamMock(calls) })
    try {
      const invalid = [
        { ...basePayload, n: 2 },
        { ...basePayload, n: 1 },
        { ...basePayload, model: 'deepseek-v4-flash' },
        { ...basePayload, model: 'deepseek-v4-pro' },
        { ...basePayload, max_completion_tokens: 8_192 },
        { ...basePayload, user_id: 'not-registered-by-the-existing-profile' },
        { ...basePayload, dsh_plugin_packages: { version: 2, packages: [] } },
        { ...basePayload, dsh_plugin_packages: { version: 1, packages: [{ name: '@example/plugin' }] } },
        { ...basePayload, dsh_plugin_packages: { version: 1, packages: [{ name: '@example/plugin', version: '1', extra: true }] } },
        { ...basePayload, modalities: ['text', 'audio'] },
        { ...basePayload, audio: { voice: 'alloy' } },
        { ...basePayload, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:x' } }] }] },
        { ...basePayload, messages: [{ role: 'user', content: [{ type: 'file', file_id: 'f' }] }] },
        { ...basePayload, messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'x' } }] }] },
        { ...basePayload, messages: [{ role: 'user', content: [{ type: 'video', video_url: 'x' }] }] },
        { ...basePayload, messages: [{ role: 'user', content: 'x', video: 'x' }] },
        { ...basePayload, max_tokens: 8_193 },
      ]
      const missingInventory = { ...basePayload }
      delete missingInventory.dsh_plugin_packages
      invalid.push(missingInventory)
      for (const body of invalid) assert.ok((await post(guard.baseURL, body)).status >= 400)
      assert.equal(calls.length, 0)
      assert.equal((await readUsageLedger(ledgerPath)).requestCount, 0)
    } finally { await guard.close() }
  })
})

test('up to 32 low-usage model requests can complete; request 33 is rejected without forwarding', async () => {
  await fixture(async ({ ledgerPath }) => {
    const calls = []
    const guard = await startCostGuard({ ledgerPath, fetchImpl: upstreamMock(calls) })
    try {
      for (let index = 0; index < 32; index += 1) assert.equal((await post(guard.baseURL)).status, 200)
      const blocked = await post(guard.baseURL)
      assert.equal(blocked.status, 429)
      assert.equal((await blocked.json()).error, 'request_attempt_limit')
      assert.equal(calls.length, 32)
      const ledger = await readUsageLedger(ledgerPath)
      assert.equal(ledger.requestCount, 32)
      assert.equal(ledger.settledUpperBoundMicroCny, 32 * (10_000 * 2 + 200 * 8))
      assert.deepEqual(ledger.pending, [])
    } finally { await guard.close() }
  })
})

test('two maximum-context peak-price reservations consume most of CNY 5 and deny request three before dispatch', async () => {
  await fixture(async ({ ledgerPath }) => {
    const maxUsage = { prompt_tokens: 1_040_384, completion_tokens: 8_192, total_tokens: 1_048_576 }
    const calls = []
    const guard = await startCostGuard({ ledgerPath, fetchImpl: upstreamMock(calls, validBody({ usageValue: maxUsage })) })
    try {
      for (let index = 0; index < 2; index += 1) {
        const response = await post(guard.baseURL)
        assert.equal(response.status, 200)
        await response.arrayBuffer()
      }
      const third = await post(guard.baseURL)
      assert.equal(third.status, 429)
      assert.equal((await third.json()).error, 'cost_reservation_limit')
      assert.equal(calls.length, 2)
      const ledger = await readUsageLedger(ledgerPath)
      assert.equal(ledger.requestCount, 2)
      assert.equal(ledger.settledUpperBoundMicroCny, 4_292_608)
      assert.deepEqual(ledger.pending, [])
    } finally { await guard.close() }
  })
})

test('a partial data: [DONE] marker stays incomplete until the remaining transport bytes arrive', { timeout: 3_000 }, async () => {
  await fixture(async ({ ledgerPath }) => {
    const wire = validBody()
    const withoutDone = wire.replace('data: [DONE]\n\n', '')
    const calls = []
    let prefixReady
    const prefixSent = new Promise(resolve => { prefixReady = resolve })
    let releaseDone
    let doneReleased = false
    let received = ''
    const guard = await startCostGuard({
      ledgerPath,
      fetchImpl: async (url, options) => {
        calls.push({ url, options })
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(`${withoutDone}data: [DO`))
            prefixReady()
            releaseDone = () => {
              if (doneReleased) return
              doneReleased = true
              controller.enqueue(encoder.encode('NE]\n'))
              controller.enqueue(encoder.encode('\n'))
              controller.close()
            }
          },
        })
        return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      },
    })
    try {
      const { request, response } = rawPost(guard.baseURL)
      request.on('error', () => {})
      const clientResponse = await response
      assert.equal(clientResponse.statusCode, 200)
      clientResponse.on('data', chunk => { received += chunk.toString('utf8') })
      const ended = new Promise((resolve, reject) => {
        clientResponse.once('end', () => resolve())
        clientResponse.once('error', reject)
        clientResponse.once('aborted', () => reject(new Error('response ended before complete [DONE] marker')))
      })
      await prefixSent
      await waitUntil(() => received.includes('data: [DO'))
      assert.ok(!received.includes('data: [DONE]'))
      let ledger = await readUsageLedger(ledgerPath)
      assert.equal(ledger.pending.length, 1)
      assert.equal(ledger.settledUpperBoundMicroCny, 0)
      releaseDone()
      await ended
      assert.equal(received, wire)
      assert.equal(calls.length, 1)
      ledger = await readUsageLedger(ledgerPath)
      assert.equal(ledger.pending.length, 0)
      assert.equal(ledger.settledUpperBoundMicroCny, 21_600)
    } finally { releaseDone?.(); await guard.close() }
  })
})

test('in-flight worst-case reservations cap parallel sends at two until valid usage settles', async () => {
  await fixture(async ({ ledgerPath }) => {
    const started = []
    const gate = new Promise(resolve => { globalThis.releaseGuardResponses = resolve })
    const guard = await startCostGuard({
      ledgerPath,
      fetchImpl: async (url, options) => {
        started.push({ url, options })
        await gate
        return mockResponse()
      },
    })
    try {
      const results = [post(guard.baseURL), post(guard.baseURL), post(guard.baseURL)]
      await waitUntil(() => started.length === 2)
      const third = await results[2]
      assert.equal(third.status, 429)
      assert.equal((await third.json()).error, 'cost_reservation_limit')
      assert.equal((await readUsageLedger(ledgerPath)).pending.length, 2)
      globalThis.releaseGuardResponses()
      const firstTwo = await Promise.all(results.slice(0, 2))
      assert.deepEqual(firstTwo.map(response => response.status), [200, 200])
      await Promise.all(firstTwo.map(response => response.text()))
      const ledger = await readUsageLedger(ledgerPath)
      assert.equal(ledger.requestCount, 2)
      assert.equal(ledger.pending.length, 0)
      assert.equal(ledger.settledUpperBoundMicroCny, 2 * (10_000 * 2 + 200 * 8))
    } finally {
      globalThis.releaseGuardResponses?.()
      delete globalThis.releaseGuardResponses
      await guard.close()
    }
  })
})

test('incomplete usage, duplicate usage, invalid totals and truncated streams retain full reserve and cannot refund', async () => {
  await fixture(async ({ ledgerPath }) => {
    const common = { id: 'resp-1', object: 'chat.completion.chunk', created: 1, model: 'deepseek-flash' }
    const invalidBodies = [
      validBody({ usageValue: null }),
      validBody({ usageValue: { ...usage, total_tokens: 1 } }),
      validBody().replace('data: [DONE]\n\n', ''),
      (() => {
        const body = validBody()
        const oneUsage = sseEvent({ ...common, choices: [], usage })
        return body.replace('data: [DONE]\n\n', `${oneUsage}data: [DONE]\n\n`)
      })(),
    ]
    for (const invalidBody of invalidBodies) {
      const calls = []
      const directory = await mkdtemp(join(tmpdir(), 'ark-cost-invalid-'))
      const isolatedLedger = join(directory, 'ledger.json')
      try {
        const guard = await startCostGuard({ ledgerPath: isolatedLedger, fetchImpl: upstreamMock(calls, invalidBody) })
        try {
          const { request, response } = rawPost(guard.baseURL)
          request.on('error', () => {})
          const outcome = await response.then(clientResponse => new Promise(resolve => {
            clientResponse.on('data', () => {})
            clientResponse.once('end', () => resolve('end'))
            clientResponse.once('aborted', () => resolve('aborted'))
            clientResponse.once('error', () => resolve('error'))
          }), error => `rejected:${error?.cause?.code ?? error?.code}`)
          assert.notEqual(outcome, 'end')
          await guard.close()
          const ledger = await readUsageLedger(isolatedLedger)
          assert.equal(ledger.requestCount, 1)
          assert.equal(ledger.pending.length, 1)
          assert.equal(ledger.settledUpperBoundMicroCny, 0)
        } finally { await guard.close() }
      } finally { await rm(directory, { recursive: true, force: true }) }
    }
  })
})

test('finish and usage must be on the last content chunk; later data or misplaced usage keeps the reserve', async () => {
  await fixture(async ({ ledgerPath }) => {
    const common = { id: 'resp-early-usage', object: 'chat.completion.chunk', created: 1, model: 'deepseek-flash' }
    const content = sseEvent({ ...common, choices: [{ index: 0, delta: { content: 'answer' }, finish_reason: null }], usage: null })
    const finishNoUsage = sseEvent({ ...common, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: null })
    const usageOnly = sseEvent({ ...common, choices: [], usage })
    const usageBeforeFinish = sseEvent({ ...common, choices: [{ index: 0, delta: {}, finish_reason: null }], usage })
    const finalWithUsage = sseEvent({ ...common, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage })
    const trailingDelta = sseEvent({ ...common, choices: [{ index: 0, delta: { content: 'late' }, finish_reason: null }], usage: null })
    const done = 'data: [DONE]\n\n'
    const invalidStreams = [
      [content, finishNoUsage, usageOnly, done].join(''),
      [content, usageOnly, finishNoUsage, done].join(''),
      [content, finalWithUsage, trailingDelta, done].join(''),
      [content, finishNoUsage, done].join(''),
      [content, usageBeforeFinish, done].join(''),
    ]
    for (const [index, invalidStream] of invalidStreams.entries()) {
      const directory = await mkdtemp(join(tmpdir(), 'ark-cost-ordering-'))
      const isolatedLedger = join(directory, 'ledger.json')
      try {
        const guard = await startCostGuard({ ledgerPath: isolatedLedger, fetchImpl: upstreamMock([], invalidStream) })
        try {
          const { request, response } = rawPost(guard.baseURL)
          request.on('error', () => {})
          const outcome = await response.then(clientResponse => new Promise(resolve => {
            clientResponse.on('data', () => {})
            clientResponse.once('end', () => resolve('end'))
            clientResponse.once('aborted', () => resolve('aborted'))
            clientResponse.once('error', () => resolve('error'))
          }), error => `rejected:${error?.cause?.code ?? error?.code}`)
          assert.notEqual(outcome, 'end', `stream ${index} must not appear complete`)
          await guard.close()
          const ledger = await readUsageLedger(isolatedLedger)
          assert.equal(ledger.requestCount, 1)
          assert.equal(ledger.pending.length, 1)
          assert.equal(ledger.pending[0].reservedMicroCny, 2_146_304)
          assert.equal(ledger.settledUpperBoundMicroCny, 0)
        } finally { await guard.close() }
      } finally { await rm(directory, { recursive: true, force: true }) }
    }
  })
})

test('deadline abort waits for real fetch settlement and cleans the AbortSignal listener', { timeout: 3_000 }, async () => {
  await fixture(async ({ ledgerPath }) => {
    let seenSignal
    let settled = false
    const guard = await startCostGuard({
      ledgerPath, requestDeadlineMs: 40,
      fetchImpl: (_url, options) => {
        seenSignal = options.signal
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            setTimeout(() => { settled = true; reject(options.signal.reason) }, 20)
          }, { once: true })
        })
      },
    })
    try {
      const response = await post(guard.baseURL)
      assert.equal(response.status, 504)
      assert.equal((await response.json()).error, 'request_deadline')
      assert.equal(seenSignal.aborted, true)
      assert.equal(settled, true)
      assert.equal(getEventListeners(seenSignal, 'abort').length, 0)
      const ledger = await readUsageLedger(ledgerPath)
      assert.equal(ledger.requestCount, 1)
      assert.equal(ledger.pending.length, 1)
    } finally { await guard.close() }
  })
})

test('client disconnect during upstream streaming aborts fetch and awaits body cancellation', { timeout: 3_000 }, async () => {
  await fixture(async ({ ledgerPath }) => {
    let seenSignal
    let streamCancelled = false
    const guard = await startCostGuard({
      ledgerPath,
      fetchImpl: async (_url, options) => {
        seenSignal = options.signal
        const stream = new ReadableStream({
          start(controller) { controller.enqueue(encoder.encode('data: : keepalive\\n\\n')) },
          cancel() { streamCancelled = true },
        })
        return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      },
    })
    try {
      const { request, response } = rawPost(guard.baseURL)
      const clientResponse = await response
      await new Promise(resolve => clientResponse.once('data', resolve))
      request.destroy()
      await waitUntil(() => seenSignal.aborted && streamCancelled)
      await guard.close()
      assert.equal(seenSignal.aborted, true)
      assert.equal(streamCancelled, true)
      const ledger = await readUsageLedger(ledgerPath)
      assert.equal(ledger.requestCount, 1)
      assert.equal(ledger.pending.length, 1)
    } finally { await guard.close() }
  })
})

test('close aborts and joins active fetch before releasing lock; pending cost survives restart', { timeout: 3_000 }, async () => {
  await fixture(async ({ ledgerPath }) => {
    let seenSignal
    let settled = false
    let releaseFetch
    const guard = await startCostGuard({
      ledgerPath,
      fetchImpl: (_url, options) => {
        seenSignal = options.signal
        return new Promise((_resolve, reject) => {
          releaseFetch = () => setTimeout(() => { settled = true; reject(options.signal.reason) }, 50)
          if (options.signal.aborted) releaseFetch()
          else options.signal.addEventListener('abort', releaseFetch, { once: true })
        })
      },
    })
    const { request, response } = rawPost(guard.baseURL)
    request.on('error', () => {})
    response.catch(() => {})
    try {
      await waitUntil(() => seenSignal !== undefined)
      const started = Date.now()
      request.destroy()
      const closing = guard.close()
      await closing
      assert.ok(Date.now() - started >= 40)
      assert.equal(seenSignal.aborted, true)
      assert.equal(settled, true)
      const ledger = await readUsageLedger(ledgerPath)
      assert.equal(ledger.requestCount, 1)
      assert.equal(ledger.pending.length, 1)
      assert.equal(ledger.pending[0].reservedMicroCny, 2_146_304)
      const restarted = await startCostGuard({ ledgerPath, fetchImpl: upstreamMock([]) })
      try { assert.ok(restarted.baseURL.startsWith('http://127.0.0.1:')) } finally { await restarted.close() }
    } finally { await guard.close() }
  })
})

test('client disconnect before full request body completion causes no reservation or provider dispatch', { timeout: 3_000 }, async () => {
  await fixture(async ({ ledgerPath }) => {
    const calls = []
    const guard = await startCostGuard({ ledgerPath, fetchImpl: upstreamMock(calls) })
    const url = new URL(`${guard.baseURL}/chat/completions`)
    const request = httpRequest({ hostname: url.hostname, port: Number(url.port), path: url.pathname, method: 'POST',
      headers: { authorization: 'Bearer offline-placeholder', 'content-type': 'application/json', 'content-length': 100_000 } })
    request.on('error', () => {})
    try {
      request.write('{"model":"deepseek-flash"')
      await new Promise(resolve => setTimeout(resolve, 10))
      const closed = new Promise(resolve => request.once('close', resolve))
      request.destroy()
      await closed
      await guard.close()
      assert.equal(calls.length, 0)
      const ledger = await readUsageLedger(ledgerPath)
      assert.equal(ledger.requestCount, 0)
      assert.deepEqual(ledger.pending, [])
    } finally { request.destroy(); await guard.close() }
  })
})

test('invalid provider SSE stream errors settle owner but retain full pre-reserve', { timeout: 3_000 }, async () => {
  await fixture(async ({ ledgerPath }) => {
    let seenSignal
    let cancelled = false
    const guard = await startCostGuard({
      ledgerPath,
      fetchImpl: async (_url, options) => {
        seenSignal = options.signal
        const stream = new ReadableStream({
          start(controller) { controller.enqueue(encoder.encode('data: {"broken":true}\\n\\n')); controller.error(new Error('offline malformed source')) },
          cancel() { cancelled = true },
        })
        return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      },
    })
    try {
      const { request, response } = rawPost(guard.baseURL)
      request.on('error', () => {})
      const outcome = await response.then(clientResponse => new Promise(resolve => {
        clientResponse.on('data', () => {})
        clientResponse.once('end', () => resolve('end'))
        clientResponse.once('error', () => resolve('error'))
        clientResponse.once('aborted', () => resolve('aborted'))
      }), error => `rejected:${error?.cause?.code ?? error?.code}`)
      assert.notEqual(outcome, 'end')
      await guard.close()
      assert.equal(seenSignal.aborted, true)
      const ledger = await readUsageLedger(ledgerPath)
      assert.equal(ledger.requestCount, 1)
      assert.equal(ledger.pending.length, 1)
      assert.equal(ledger.pending[0].reservedMicroCny, 2_146_304)
      assert.equal(ledger.settledUpperBoundMicroCny, 0)
      assert.equal(typeof cancelled, 'boolean')
    } finally { await guard.close() }
  })
})

test('a resumed lower output cap uses its exact reserve and denies the unchanged 8192-token reserve at the frozen balance', async () => {
  await fixture(async ({ ledgerPath }) => {
    const before = initialLedger({ requestCount: 26, settledUpperBoundMicroCny: 2_864_878 })
    await writeFile(ledgerPath, `${JSON.stringify(before)}\n`, { mode: 0o600 })
    const calls = []
    const guard = await startCostGuard({ ledgerPath, fetchImpl: upstreamMock(calls) })
    try {
      assert.equal((await post(guard.baseURL, { ...basePayload, max_tokens: 8_192 })).status, 429)
      assert.equal(calls.length, 0)
      assert.deepEqual(await readUsageLedger(ledgerPath), before)

      const response = await post(guard.baseURL, { ...basePayload, max_tokens: 4_096 })
      assert.equal(response.status, 200)
      assert.equal(await response.text(), validBody())
      assert.equal(calls.length, 1)
      assert.deepEqual(await readUsageLedger(ledgerPath), {
        ...before,
        requestCount: 27,
        settledUpperBoundMicroCny: before.settledUpperBoundMicroCny + usage.prompt_tokens * 2 + usage.completion_tokens * 8,
      })
    } finally { await guard.close() }
  })
})

test('two concurrent 4096-token requests reserve exact caps, stay within tranche, and keep unknown pending rows invalid', { timeout: 3_000 }, async () => {
  await fixture(async ({ directory, ledgerPath }) => {
    const calls = []
    let release
    const blocked = new Promise(resolve => { release = resolve })
    const guard = await startCostGuard({ ledgerPath, fetchImpl: async (url, options) => {
      calls.push({ url, options })
      await blocked
      return mockResponse()
    } })
    try {
      const small = { ...basePayload, max_tokens: 4_096 }
      const first = post(guard.baseURL, small)
      const second = post(guard.baseURL, small)
      await waitUntil(() => calls.length === 2)
      const pending = await readUsageLedger(ledgerPath)
      assert.equal(pending.requestCount, 2)
      assert.equal(pending.pending.length, 2)
      assert.deepEqual(pending.pending.map(row => row.reservedMicroCny), [2_121_728, 2_121_728])
      assert.ok(pending.settledUpperBoundMicroCny + pending.pending.reduce((sum, row) => sum + row.reservedMicroCny, 0) <= 5_000_000)
      assert.equal((await post(guard.baseURL, small)).status, 429)
      assert.equal(calls.length, 2)

      release()
      const [firstResponse, secondResponse] = await Promise.all([first, second])
      assert.equal(firstResponse.status, 200)
      assert.equal(secondResponse.status, 200)
      await Promise.all([firstResponse.text(), secondResponse.text()])
      const settled = await readUsageLedger(ledgerPath)
      assert.equal(settled.requestCount, 2)
      assert.equal(settled.pending.length, 0)
      assert.equal(settled.settledUpperBoundMicroCny, 2 * (usage.prompt_tokens * 2 + usage.completion_tokens * 8))
      assert.ok(settled.settledUpperBoundMicroCny <= 2 * 2_121_728)
    } finally { release(); await guard.close() }

    for (const [name, reservedMicroCny] of [
      ['below-output-min', 2_097_152],
      ['off-six-micro-grid', 2_000_000],
      ['above-output-max', 2_146_310],
    ]) {
      const invalidLedgerPath = join(directory, `${name}.json`)
      const invalid = initialLedger({ requestCount: 1, pending: [{ id: 'prior', reservedMicroCny }] })
      const bytes = `${JSON.stringify(invalid)}\n`
      await writeFile(invalidLedgerPath, bytes, { mode: 0o600 })
      await assert.rejects(startCostGuard({ ledgerPath: invalidLedgerPath, fetchImpl: upstreamMock([]) }), /invalid_budget_ledger/)
      assert.equal(await readFile(invalidLedgerPath, 'utf8'), bytes)
    }
  })
})
