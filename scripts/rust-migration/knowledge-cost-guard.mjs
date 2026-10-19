import { createHash, randomUUID } from 'node:crypto'
import { lstat, open, unlink } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, isAbsolute, resolve } from 'node:path'
import { Transform, Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const UPSTREAM = 'https://api.deepseek.com/chat/completions'
const REQUEST_MODEL = 'deepseek-flash'
const RESPONSE_MODELS = new Set(['deepseek-flash'])
const MAX_OUTPUT_TOKENS = 8_192
const CONTEXT_TOKENS = 1_048_576
const MAX_REQUEST_BYTES = 64 * 1024 * 1024
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024
const MAX_SSE_EVENT_BYTES = 1024 * 1024
const MAX_REQUESTS = 32
const TRANCHE_MICRO_CNY = 5_000_000
const INPUT_MICRO_CNY_PER_TOKEN = 2
const OUTPUT_MICRO_CNY_PER_TOKEN = 8
const REQUEST_DEADLINE_MS = 120_000
const LEDGER_SCHEMA = 2

function reserveForOutputTokens(maxTokens) {
  return (CONTEXT_TOKENS - maxTokens) * INPUT_MICRO_CNY_PER_TOKEN
    + maxTokens * OUTPUT_MICRO_CNY_PER_TOKEN
}

function validReservation(value) {
  if (!Number.isSafeInteger(value)) return false
  const outputDelta = value - CONTEXT_TOKENS * INPUT_MICRO_CNY_PER_TOKEN
  const priceDelta = OUTPUT_MICRO_CNY_PER_TOKEN - INPUT_MICRO_CNY_PER_TOKEN
  if (outputDelta <= 0 || outputDelta % priceDelta !== 0) return false
  const maxTokens = outputDelta / priceDelta
  return maxTokens >= 1 && maxTokens <= MAX_OUTPUT_TOKENS && reserveForOutputTokens(maxTokens) === value
}

function fail(status, code) {
  const error = new Error(code)
  error.status = status
  error.code = code
  return error
}

function exactObject(value, required, optional = []) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const allowed = new Set([...required, ...optional])
  const keys = Object.keys(value)
  return required.every(key => Object.hasOwn(value, key)) && keys.every(key => allowed.has(key))
}

function validateToolCall(call) {
  return exactObject(call, ['id', 'type', 'function']) && typeof call.id === 'string' && call.type === 'function'
    && exactObject(call.function, ['name', 'arguments']) && typeof call.function.name === 'string'
    && typeof call.function.arguments === 'string'
}

function validateMessage(message) {
  if (message?.role === 'system') return exactObject(message, ['role', 'content']) && typeof message.content === 'string'
  if (message?.role === 'user') {
    if (!exactObject(message, ['role', 'content'])) return false
    if (typeof message.content === 'string') return true
    return Array.isArray(message.content) && message.content.every(part => (
      exactObject(part, ['type', 'text']) && part.type === 'text' && typeof part.text === 'string'
    ))
  }
  if (message?.role === 'assistant') {
    if (!exactObject(message, ['role', 'content'], ['reasoning_content', 'tool_calls'])) return false
    if (message.content !== null && typeof message.content !== 'string') return false
    if (Object.hasOwn(message, 'reasoning_content') && typeof message.reasoning_content !== 'string') return false
    return !Object.hasOwn(message, 'tool_calls')
      || (Array.isArray(message.tool_calls) && message.tool_calls.every(validateToolCall))
  }
  if (message?.role === 'tool') {
    return exactObject(message, ['role', 'tool_call_id', 'content'])
      && typeof message.tool_call_id === 'string' && typeof message.content === 'string'
  }
  return false
}

function validateTools(tools) {
  return Array.isArray(tools) && tools.every(tool => exactObject(tool, ['type', 'function'])
    && tool.type === 'function'
    && exactObject(tool.function, ['name', 'description', 'parameters'])
    && typeof tool.function.name === 'string' && typeof tool.function.description === 'string'
    && tool.function.parameters !== null && typeof tool.function.parameters === 'object'
    && !Array.isArray(tool.function.parameters))
}

function validatePluginPackageInventory(value) {
  return exactObject(value, ['version', 'packages']) && value.version === 1 && Array.isArray(value.packages)
    && value.packages.every(identity => exactObject(identity, ['name', 'version'])
      && typeof identity.name === 'string' && identity.name.length > 0
      && typeof identity.version === 'string' && identity.version.length > 0)
}

function validatePayload(payload) {
  const required = ['model', 'messages', 'stream', 'stream_options', 'max_tokens', 'dsh_plugin_packages']
  const optional = ['response_format', 'thinking', 'reasoning_effort', 'tools', 'temperature', 'stop']
  if (!exactObject(payload, required, optional) || payload.model !== REQUEST_MODEL || payload.stream !== true) return false
  if (!validatePluginPackageInventory(payload.dsh_plugin_packages)) return false
  if (!Array.isArray(payload.messages) || payload.messages.length === 0 || !payload.messages.every(validateMessage)) return false
  if (!exactObject(payload.stream_options, ['include_usage']) || payload.stream_options.include_usage !== true) return false
  if (!Number.isSafeInteger(payload.max_tokens) || payload.max_tokens < 1 || payload.max_tokens > MAX_OUTPUT_TOKENS) return false
  if (Object.hasOwn(payload, 'response_format')
    && (!exactObject(payload.response_format, ['type']) || payload.response_format.type !== 'json_object')) return false
  if (Object.hasOwn(payload, 'thinking')
    && (!exactObject(payload.thinking, ['type']) || !['enabled', 'disabled'].includes(payload.thinking.type))) return false
  if (Object.hasOwn(payload, 'reasoning_effort') && !['low', 'high', 'max'].includes(payload.reasoning_effort)) return false
  if (Object.hasOwn(payload, 'tools') && !validateTools(payload.tools)) return false
  if (Object.hasOwn(payload, 'temperature')
    && (typeof payload.temperature !== 'number' || !Number.isFinite(payload.temperature))) return false
  if (Object.hasOwn(payload, 'stop')
    && (!Array.isArray(payload.stop) || !payload.stop.every(value => typeof value === 'string'))) return false
  return true
}

/**
 * Validate the unchanged schema-2 budget ledger without reading or writing files.
 * @param {unknown} ledger Parsed ledger bytes.
 * @returns {boolean} Whether every fixed cap and reservation is valid.
 */
export function validateKnowledgeCostLedger(ledger) {
  return exactObject(ledger, ['schema', 'budgetMicroCny', 'maxRequests', 'requestCount', 'settledUpperBoundMicroCny', 'pending'])
    && ledger.schema === LEDGER_SCHEMA && ledger.budgetMicroCny === TRANCHE_MICRO_CNY
    && ledger.maxRequests === MAX_REQUESTS && Number.isSafeInteger(ledger.requestCount)
    && ledger.requestCount >= 0 && ledger.requestCount <= MAX_REQUESTS
    && Number.isSafeInteger(ledger.settledUpperBoundMicroCny)
    && ledger.settledUpperBoundMicroCny >= 0 && ledger.settledUpperBoundMicroCny <= TRANCHE_MICRO_CNY
    && Array.isArray(ledger.pending)
    && ledger.pending.every(row => exactObject(row, ['id', 'reservedMicroCny'])
      && typeof row.id === 'string' && row.id.length > 0 && validReservation(row.reservedMicroCny))
    && ledger.pending.reduce((sum, row) => sum + row.reservedMicroCny, ledger.settledUpperBoundMicroCny) <= TRANCHE_MICRO_CNY
}

/**
 * Read the finite capacity used by a launcher-pinned admission, without spending it.
 * @param {unknown} ledger Parsed schema-2 ledger.
 * @param {number} maxTokens Explicit output cap for an admitted request.
 * @returns {{remainingRequests:number,remainingBudgetMicroCny:number,perRequestReserveMicroCny:number}} Current bounds, including pending reserves.
 */
export function knowledgeCostAdmissionCapacity(ledger, maxTokens) {
  if (!validateKnowledgeCostLedger(ledger) || !Number.isSafeInteger(maxTokens)
    || maxTokens < 1 || maxTokens > MAX_OUTPUT_TOKENS) throw new TypeError('Invalid cost admission capacity')
  return Object.freeze({ remainingRequests: ledger.maxRequests - ledger.requestCount,
    remainingBudgetMicroCny: ledger.budgetMicroCny - ledger.settledUpperBoundMicroCny
      - ledger.pending.reduce((sum, row) => sum + row.reservedMicroCny, 0),
    perRequestReserveMicroCny: reserveForOutputTokens(maxTokens) })
}

async function readLedger(ledgerPath) {
  const named = await lstat(ledgerPath)
  if (!named.isFile() || named.isSymbolicLink()) throw fail(503, 'unsafe_budget_ledger')
  const handle = await open(ledgerPath, 'r+')
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.dev !== named.dev || opened.ino !== named.ino) throw fail(503, 'unsafe_budget_ledger')
    let value
    try { value = JSON.parse(await handle.readFile('utf8')) } catch { throw fail(503, 'invalid_budget_ledger') }
    if (!validateKnowledgeCostLedger(value)) throw fail(503, 'invalid_budget_ledger')
    return { value, handle }
  } catch (error) {
    await handle.close()
    throw error
  }
}

async function writeLedger(handle, value) {
  if (!validateKnowledgeCostLedger(value)) throw fail(503, 'invalid_budget_ledger_update')
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8')
  await handle.truncate(0)
  const written = await handle.write(bytes, 0, bytes.length, 0)
  if (written.bytesWritten !== bytes.length) throw fail(503, 'budget_ledger_write_failed')
  await handle.sync()
}

async function unlinkOwnedLock(lockPath, identity) {
  try {
    const current = await lstat(lockPath)
    if (current.isFile() && !current.isSymbolicLink() && current.dev === identity.dev && current.ino === identity.ino) {
      await unlink(lockPath)
    }
  } catch (error) { if (error?.code !== 'ENOENT') throw error }
}

function responseError(response, status, code) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify({ error: code }))
}

function endResponse(response) {
  return new Promise((resolveEnd, rejectEnd) => {
    const onError = error => rejectEnd(error)
    response.once('error', onError)
    response.once('finish', () => { response.off('error', onError); resolveEnd() })
    response.end()
  })
}

function usageCost(usage, maxTokens) {
  if (!exactObject(usage, ['prompt_tokens', 'completion_tokens', 'total_tokens'], [
    'prompt_tokens_details', 'prompt_cache_hit_tokens', 'prompt_cache_miss_tokens', 'completion_tokens_details',
  ])) return undefined
  const input = usage.prompt_tokens
  const output = usage.completion_tokens
  if (!Number.isSafeInteger(input) || input < 0 || !Number.isSafeInteger(output) || output < 0 || output > maxTokens
    || !Number.isSafeInteger(usage.total_tokens) || usage.total_tokens !== input + output || usage.total_tokens > CONTEXT_TOKENS) {
    return undefined
  }
  let hits
  if (Object.hasOwn(usage, 'prompt_cache_hit_tokens')) {
    if (!Number.isSafeInteger(usage.prompt_cache_hit_tokens) || usage.prompt_cache_hit_tokens < 0 || usage.prompt_cache_hit_tokens > input) return undefined
    hits = usage.prompt_cache_hit_tokens
  }
  if (Object.hasOwn(usage, 'prompt_tokens_details')) {
    if (!exactObject(usage.prompt_tokens_details, [], ['cached_tokens'])) return undefined
    const cached = usage.prompt_tokens_details.cached_tokens
    if (cached !== undefined && (!Number.isSafeInteger(cached) || cached < 0 || cached > input)) return undefined
    if (cached !== undefined && hits !== undefined && cached !== hits) return undefined
    if (cached !== undefined) hits = cached
  }
  if (Object.hasOwn(usage, 'prompt_cache_miss_tokens')) {
    const misses = usage.prompt_cache_miss_tokens
    if (!Number.isSafeInteger(misses) || misses < 0 || misses > input || (hits !== undefined && misses + hits !== input)) return undefined
  }
  if (Object.hasOwn(usage, 'completion_tokens_details')) {
    if (!exactObject(usage.completion_tokens_details, [], ['reasoning_tokens'])) return undefined
    const reasoning = usage.completion_tokens_details.reasoning_tokens
    if (reasoning !== undefined && (!Number.isSafeInteger(reasoning) || reasoning < 0 || reasoning > output)) return undefined
  }
  return input * INPUT_MICRO_CNY_PER_TOKEN + output * OUTPUT_MICRO_CNY_PER_TOKEN
}

class MeteringTransform extends Transform {
  constructor({ maxTokens, settle }) {
    super()
    this.maxTokens = maxTokens
    this.settle = settle
    this.decoder = new TextDecoder()
    this.pendingText = ''
    this.dataLines = []
    this.responseBytes = 0
    this.eventBytes = 0
    this.seenDone = false
    this.doneChunk = undefined
    this.id = undefined
    this.model = undefined
    this.finishCount = 0
    this.finishReason = undefined
    this.usageCount = 0
    this.usage = undefined
  }

  inspectEvent() {
    if (this.dataLines.length === 0) { this.eventBytes = 0; return }
    const data = this.dataLines.join('\n')
    this.dataLines = []
    this.eventBytes = 0
    if (this.seenDone) throw fail(502, 'data_after_done')
    if (data === '[DONE]') { this.seenDone = true; return }
    if (this.finishCount !== 0) throw fail(502, 'data_after_finish')
    let chunk
    try { chunk = JSON.parse(data) } catch { throw fail(502, 'malformed_provider_chunk') }
    if (chunk?.object !== 'chat.completion.chunk' || typeof chunk.id !== 'string' || chunk.id.length === 0
      || !RESPONSE_MODELS.has(chunk.model) || !Number.isSafeInteger(chunk.created) || !Array.isArray(chunk.choices)) {
      throw fail(502, 'invalid_provider_chunk')
    }
    if (this.id === undefined) { this.id = chunk.id; this.model = chunk.model }
    else if (chunk.id !== this.id || chunk.model !== this.model) throw fail(502, 'provider_response_identity_changed')
    if (chunk.choices.length !== 1) throw fail(502, 'invalid_provider_choice_count')
    const [choice] = chunk.choices
    if (!exactObject(choice, ['index', 'delta', 'finish_reason'], ['logprobs']) || choice.index !== 0
      || choice.delta === null || typeof choice.delta !== 'object' || Array.isArray(choice.delta)) {
      throw fail(502, 'invalid_provider_choice')
    }
    const finishing = choice.finish_reason !== null
    if (finishing) {
      if (!['stop', 'tool_calls', 'length', 'content_filter', 'insufficient_system_resource', 'aborted'].includes(choice.finish_reason)) {
        throw fail(502, 'invalid_provider_finish')
      }
      this.finishCount += 1
      this.finishReason = choice.finish_reason
    }
    const hasUsage = chunk.usage !== undefined && chunk.usage !== null
    if (finishing !== hasUsage) throw fail(502, finishing ? 'finish_chunk_missing_usage' : 'usage_before_finish')
    if (hasUsage) {
      if (this.usageCount !== 0) throw fail(502, 'duplicate_provider_usage')
      const cost = usageCost(chunk.usage, this.maxTokens)
      if (cost === undefined) throw fail(502, 'invalid_provider_usage')
      this.usageCount += 1
      this.usage = { cost, input: chunk.usage.prompt_tokens, output: chunk.usage.completion_tokens }
    }
  }

  inspectBytes(bytes, final = false) {
    this.responseBytes += bytes.length
    if (this.responseBytes > MAX_RESPONSE_BYTES) throw fail(502, 'provider_response_too_large')
    this.pendingText += this.decoder.decode(bytes, { stream: !final })
    let newline
    while ((newline = this.pendingText.indexOf('\n')) !== -1) {
      let line = this.pendingText.slice(0, newline)
      this.pendingText = this.pendingText.slice(newline + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      if (this.seenDone) {
        if (line.trim() !== '') throw fail(502, 'data_after_done')
        continue
      }
      if (line === '') { this.inspectEvent(); continue }
      if (line.startsWith(':')) continue
      if (line.startsWith('data:')) {
        this.eventBytes += Buffer.byteLength(line, 'utf8')
        if (this.eventBytes > MAX_SSE_EVENT_BYTES) throw fail(502, 'provider_event_too_large')
        this.dataLines.push(line.slice(5).replace(/^ /, ''))
      }
    }
    if (final && this.pendingText !== '') throw fail(502, 'unterminated_provider_event')
  }

  _transform(chunk, _encoding, callback) {
    try {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      this.inspectBytes(bytes)
      if (this.seenDone) this.doneChunk = this.doneChunk === undefined ? bytes : Buffer.concat([this.doneChunk, bytes])
      else this.push(bytes)
      callback()
    } catch (error) { callback(error) }
  }

  _flush(callback) {
    const finish = async () => {
      this.inspectBytes(Buffer.alloc(0), true)
      if (!this.seenDone || this.usageCount !== 1 || this.finishCount !== 1 || this.id === undefined
        || this.model === undefined || this.finishReason === undefined || this.usage === undefined || this.doneChunk === undefined) {
        throw fail(502, 'incomplete_metered_provider_response')
      }
      const responseIdHash = createHash('sha256').update(this.id).digest('hex')
      await this.settle({
        inputTokens: this.usage.input, outputTokens: this.usage.output,
        upperBoundMicroCny: this.usage.cost, responseIdHash, responseModel: this.model, finishReason: this.finishReason,
      })
      this.push(this.doneChunk)
      callback()
    }
    void finish().catch(callback)
  }
}

/**
 * Test-only cost guard. One durable CNY 5 ledger admits at most 32 dispatches,
 * pre-reserving the per-call context/output maximum before network I/O. It will
 * have no more than two worst-case reservations in flight; valid complete SSE
 * usage settles an all-cache-miss price upper bound. Missing, malformed,
 * interrupted, or crash-pending usage keeps the full reserve. The upstream URL,
 * model, limits and deadline are fixed. One controller owns each request until
 * fetch and response pipeline cleanup settle; close aborts and joins all owners.
 */
export async function startCostGuard({ ledgerPath, fetchImpl = fetch, host = '127.0.0.1', port = 0, requestDeadlineMs = REQUEST_DEADLINE_MS, requestEvidenceOwner }) {
  if (host !== '127.0.0.1') throw new TypeError('cost guard must bind to IPv4 loopback')
  // Launcher-owned request evidence. This alone does not establish protected custody. The existing budget ledger and upstream wire are unchanged.
  const admitMethod = requestEvidenceOwner?.admitRequest
  const settleMethod = requestEvidenceOwner?.recordSettlement
  if (requestEvidenceOwner !== undefined && (typeof admitMethod !== 'function'
    || typeof settleMethod !== 'function')) {
    throw new TypeError('request evidence owner requires closed admission and settlement methods')
  }
  const admitEvidence = admitMethod?.bind(requestEvidenceOwner)
  const recordEvidence = settleMethod?.bind(requestEvidenceOwner)
  if (!isAbsolute(ledgerPath)) throw new TypeError('budget ledger path must be absolute')
  if (!Number.isSafeInteger(requestDeadlineMs) || requestDeadlineMs < 1) throw new TypeError('invalid request deadline')
  const absoluteLedger = resolve(ledgerPath)
  const parentPath = dirname(absoluteLedger)
  const parentStat = await lstat(parentPath)
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()
    || (typeof process.getuid === 'function' && parentStat.uid !== process.getuid()) || (parentStat.mode & 0o077) !== 0) {
    throw new TypeError('budget ledger parent must be an owned, private ordinary directory')
  }
  const lockPath = `${absoluteLedger}.lock`
  const lockHandle = await open(lockPath, 'wx', 0o600)
  const lockStat = await lockHandle.stat()
  await lockHandle.writeFile(`${JSON.stringify({ owner: randomUUID(), pid: process.pid })}\n`)
  await lockHandle.sync()
  let ledgerHandle
  let server
  let closePromise
  let shuttingDown = false
  let ledgerTail = Promise.resolve()
  const activeControllers = new Set()
  const activeOperations = new Set()
  const serializeLedger = operation => {
    const current = ledgerTail.then(operation)
    ledgerTail = current.catch(() => {})
    return current
  }
  try {
    try {
      ledgerHandle = await open(absoluteLedger, 'wx', 0o600)
      const initial = {
        schema: LEDGER_SCHEMA, budgetMicroCny: TRANCHE_MICRO_CNY, maxRequests: MAX_REQUESTS,
        requestCount: 0, settledUpperBoundMicroCny: 0, pending: [],
      }
      await ledgerHandle.writeFile(`${JSON.stringify(initial)}\n`)
      await ledgerHandle.sync()
      const parentHandle = await open(parentPath, 'r')
      try {
        const currentParent = await lstat(parentPath)
        const openedParent = await parentHandle.stat()
        if (currentParent.dev !== parentStat.dev || currentParent.ino !== parentStat.ino
          || openedParent.dev !== parentStat.dev || openedParent.ino !== parentStat.ino) throw fail(503, 'unsafe_budget_ledger_parent')
        await parentHandle.sync()
      } finally { await parentHandle.close() }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const { value, handle } = await readLedger(absoluteLedger)
      try {
        if (value.pending.length > 2) throw fail(503, 'invalid_pending_reservations')
      } finally { await handle.close() }
    } finally { await ledgerHandle?.close() }

    const reserve = (id, maxTokens) => serializeLedger(async () => {
      const reservedMicroCny = reserveForOutputTokens(maxTokens)
      const { value, handle } = await readLedger(absoluteLedger)
      try {
        const pending = value.pending.reduce((sum, row) => sum + row.reservedMicroCny, 0)
        if (value.requestCount >= MAX_REQUESTS) throw fail(429, 'request_attempt_limit')
        if (value.settledUpperBoundMicroCny + pending + reservedMicroCny > TRANCHE_MICRO_CNY) throw fail(429, 'cost_reservation_limit')
        value.requestCount += 1
        value.pending.push({ id, reservedMicroCny })
        await writeLedger(handle, value)
      } finally { await handle.close() }
    })

    const settle = (id, usage) => serializeLedger(async () => {
      const { value, handle } = await readLedger(absoluteLedger)
      try {
        const index = value.pending.findIndex(row => row.id === id)
        if (index < 0) throw fail(503, 'missing_budget_reservation')
        const [pending] = value.pending.splice(index, 1)
        if (usage.upperBoundMicroCny > pending.reservedMicroCny) {
          value.pending.push(pending)
          throw fail(503, 'usage_exceeds_budget_reservation')
        }
        value.settledUpperBoundMicroCny += usage.upperBoundMicroCny
        await writeLedger(handle, value)
      } finally { await handle.close() }
    })

    const handleOperation = async (request, response, controller) => {
      const { signal } = controller
      const abort = code => {
        if (!signal.aborted) controller.abort(fail(code === 'client_disconnected' ? 499 : code === 'request_deadline' ? 504 : 503, code))
        if (!request.complete && !request.destroyed) request.destroy()
      }
      const onRequestAborted = () => abort('client_disconnected')
      const onResponseClose = () => { if (!response.writableEnded) abort('client_disconnected') }
      const onSignalAbort = () => { if (!request.complete && !request.destroyed) request.destroy() }
      const deadline = setTimeout(() => abort('request_deadline'), requestDeadlineMs)
      deadline.unref?.()
      request.once('aborted', onRequestAborted)
      response.once('close', onResponseClose)
      signal.addEventListener('abort', onSignalAbort, { once: true })
      try {
        if (shuttingDown) throw fail(503, 'guard_shutdown')
        if (request.method !== 'POST' || request.url !== '/chat/completions') throw fail(404, 'unsupported_endpoint')
        const authorization = request.headers.authorization
        if (typeof authorization !== 'string' || !/^Bearer\s+\S+$/i.test(authorization)) throw fail(401, 'missing_bearer_credential')
        const chunks = []
        let size = 0
        for await (const chunk of request) {
          size += chunk.length
          if (size > MAX_REQUEST_BYTES) throw fail(413, 'request_too_large')
          chunks.push(chunk)
        }
        const body = Buffer.concat(chunks)
        if (signal.aborted) throw signal.reason
        let payload
        try { payload = JSON.parse(body.toString('utf8')) } catch { throw fail(400, 'invalid_json') }
        if (!validatePayload(payload)) throw fail(400, 'request_shape_or_cost_cap_rejected')
        if (signal.aborted || request.aborted || response.destroyed) throw fail(499, 'client_disconnected')
        const attemptId = randomUUID()
        let admittedRequest
        if (admitEvidence !== undefined) {
          const sessionId = request.headers['x-deepseek-harness-session-id']
          const dispatchId = request.headers['x-ark-cost-dispatch-id']
          if (typeof dispatchId !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/u.test(dispatchId)) {
            throw fail(400, 'missing_or_invalid_registered_dispatch')
          }
          if (typeof sessionId !== 'string' || sessionId.length < 1 || sessionId.length > 128) {
            throw fail(400, 'missing_or_invalid_session_binding')
          }
          admittedRequest = Object.freeze({
            dispatchId, attemptId,
            sessionIdHash: createHash('sha256').update('ark-cost-session-v1\0').update(sessionId).digest('hex'),
            requestBodyHash: createHash('sha256').update(body).digest('hex'),
            maxTokens: payload.max_tokens,
          })
          // The header is an observation, never authority. The owner must match a registered adapter record.
          // Admission only verifies registration; it must not consume a trial/use grant.
          await admitEvidence(admittedRequest, signal)
          if (signal.aborted) throw signal.reason
        }
        await reserve(attemptId, payload.max_tokens)
        if (signal.aborted || request.aborted || response.destroyed) throw fail(499, 'client_disconnected')
        const headers = new Headers(request.headers)
        for (const key of ['host', 'connection', 'content-length', 'transfer-encoding', 'x-ark-cost-dispatch-id']) headers.delete(key)
        const upstream = await fetchImpl(UPSTREAM, { method: 'POST', headers, body, signal, redirect: 'error' })
        if (signal.aborted) {
          await upstream.body?.cancel(signal.reason)
          throw signal.reason
        }
        const outgoing = new Headers()
        for (const name of ['content-type', 'cache-control', 'retry-after', 'x-request-id']) {
          const value = upstream.headers.get(name)
          if (value !== null) outgoing.set(name, value)
        }
        if (upstream.status >= 200 && upstream.status < 300) {
          if (upstream.body === null || !/^text\/event-stream(?:\s*;|$)/i.test(upstream.headers.get('content-type') ?? '')) {
            await upstream.body?.cancel(fail(502, 'invalid_provider_stream'))
            throw fail(502, 'invalid_provider_stream')
          }
        }
        response.writeHead(upstream.status, Object.fromEntries(outgoing))
        if (upstream.status < 200 || upstream.status >= 300) {
          if (upstream.body === null) await endResponse(response)
          else await pipeline(Readable.fromWeb(upstream.body), response, { signal })
          return
        }
        await pipeline(Readable.fromWeb(upstream.body), new MeteringTransform({
          maxTokens: payload.max_tokens,
          settle: async usage => {
            // Budget settlement is authoritative even when the optional evidence sink fails.
            await settle(attemptId, usage)
            if (recordEvidence !== undefined) {
              if (signal.aborted) throw signal.reason
              await recordEvidence(Object.freeze({
                ...admittedRequest, ...usage, settledAt: new Date().toISOString(),
              }), signal)
              if (signal.aborted) throw signal.reason
            }
          },
        }), response, { signal })
      } catch (error) {
        if (response.destroyed || error?.code === 'client_disconnected') return
        if (response.headersSent) {
          if (!signal.aborted) controller.abort(error instanceof Error ? error : fail(502, 'upstream_stream_failed'))
          response.destroy(error instanceof Error ? error : undefined)
          return
        }
        const status = signal.aborted
          ? (signal.reason?.code === 'request_deadline' ? 504 : 503)
          : (Number.isSafeInteger(error?.status) ? error.status : 502)
        const code = signal.aborted
          ? (typeof signal.reason?.code === 'string' ? signal.reason.code : 'request_aborted')
          : (typeof error?.code === 'string' ? error.code : 'upstream_failure')
        responseError(response, status, code)
      } finally {
        clearTimeout(deadline)
        request.off('aborted', onRequestAborted)
        response.off('close', onResponseClose)
        signal.removeEventListener('abort', onSignalAbort)
        activeControllers.delete(controller)
      }
    }

    server = createServer((request, response) => {
      if (shuttingDown) { responseError(response, 503, 'guard_shutdown'); return }
      const controller = new AbortController()
      activeControllers.add(controller)
      const operation = handleOperation(request, response, controller)
      activeOperations.add(operation)
      void operation.finally(() => activeOperations.delete(operation)).catch(() => {})
    })
    await new Promise((resolveListen, rejectListen) => {
      server.once('error', rejectListen)
      server.listen(port, host, () => { server.off('error', rejectListen); resolveListen() })
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('loopback listener did not bind TCP')
    const close = () => {
      if (closePromise !== undefined) return closePromise
      shuttingDown = true
      closePromise = (async () => {
        const serverClosed = new Promise((resolveClose, rejectClose) => {
          server.close(error => error ? rejectClose(error) : resolveClose())
        })
        for (const controller of activeControllers) if (!controller.signal.aborted) controller.abort(fail(503, 'guard_shutdown'))
        await Promise.allSettled([...activeOperations])
        await serverClosed
        await lockHandle.close()
        await unlinkOwnedLock(lockPath, lockStat)
      })()
      return closePromise
    }
    return { baseURL: `http://${host}:${address.port}`, close }
  } catch (error) {
    await ledgerHandle?.close().catch(() => {})
    await lockHandle.close().catch(() => {})
    await unlinkOwnedLock(lockPath, lockStat).catch(() => {})
    throw error
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const ledgerPath = process.env.ARK_TEST_COST_LEDGER
  if (!ledgerPath || !isAbsolute(ledgerPath)) {
    process.stderr.write('Set ARK_TEST_COST_LEDGER to an absolute path in a private owner-managed directory.\n')
    process.exitCode = 2
  } else {
    startCostGuard({ ledgerPath }).then(server => {
      process.stdout.write(`${server.baseURL}\n`)
      const stop = () => { void server.close().catch(() => { process.exitCode = 1 }) }
      process.once('SIGINT', stop)
      process.once('SIGTERM', stop)
    }).catch(error => {
      process.stderr.write(`cost guard startup refused: ${typeof error?.code === 'string' ? error.code : 'startup_error'}\n`)
      process.exitCode = 1
    })
  }
}
