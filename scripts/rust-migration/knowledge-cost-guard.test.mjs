import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { knowledgeCostAdmissionCapacity, startCostGuard, validateKnowledgeCostLedger } from './knowledge-cost-guard.mjs'

const sessionId = '00000000-0000-4000-8000-000000000001'
const body = JSON.stringify({ model: 'deepseek-flash', messages: [{ role: 'user', content: 'offline task' }], stream: true,
  stream_options: { include_usage: true }, max_tokens: 8192,
  dsh_plugin_packages: { version: 1, packages: [] } })
const common = { id: 'offline-response', object: 'chat.completion.chunk', created: 1, model: 'deepseek-flash' }
const event = value => `data: ${JSON.stringify(value)}\n\n`
const stream = event({ ...common, choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }], usage: null })
  + event({ ...common, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }) + 'data: [DONE]\n\n'
const digest = text => createHash('sha256').update(text).digest('hex')
async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'ark-cost-witness-preview-'))
  try { await run(join(directory, 'ledger.json')) } finally { await rm(directory, { recursive: true, force: true }) }
}
async function post(guard, serialized = body, withSession = true) {
  return fetch(`${guard.baseURL}/chat/completions`, { method: 'POST', body: serialized,
    headers: { authorization: 'Bearer offline-fixture-placeholder', 'content-type': 'application/json',
      ...(withSession ? { 'x-deepseek-harness-session-id': sessionId } : {}),
      'x-ark-cost-dispatch-id': 'offline-dispatch-1' } })
}
const ledger = async path => JSON.parse(await readFile(path, 'utf8'))
const validResponse = () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } })

test('finite admission reads existing schema2 capacity including pending reservations without mutation', () => {
  const actual = { schema: 2, budgetMicroCny: 5000000, maxRequests: 32,
    requestCount: 17, settledUpperBoundMicroCny: 1874848, pending: [{ id: 'held', reservedMicroCny: 2146304 }] }
  const original = JSON.stringify(actual)
  assert.equal(validateKnowledgeCostLedger(actual), true)
  assert.deepEqual(knowledgeCostAdmissionCapacity(actual, 8192), {
    remainingRequests: 15, remainingBudgetMicroCny: 978848, perRequestReserveMicroCny: 2146304,
  })
  assert.equal(Object.isFrozen(knowledgeCostAdmissionCapacity(actual, 1)), true)
  assert.equal(JSON.stringify(actual), original)
  for (const invalid of [null, { ...actual, schema: 1 }, { ...actual, budgetMicroCny: 6000000 }, { ...actual, extra: true }]) {
    assert.equal(validateKnowledgeCostLedger(invalid), false)
    assert.throws(() => knowledgeCostAdmissionCapacity(invalid, 8192), TypeError)
  }
  for (const invalid of [null, 0, -1, 8193, 1.5, Number.NaN]) {
    assert.throws(() => knowledgeCostAdmissionCapacity(actual, invalid), TypeError)
  }
})

test('records exact ingress hashes and usage only after registered-owner admission without changing schema2 or wire', async () => fixture(async path => {
  let admission, settlement, forwarded
  const guard = await startCostGuard({ ledgerPath: path,
    requestEvidenceOwner: {
      admitRequest(facts, signal) { admission = facts; assert.ok(Object.isFrozen(facts)); assert.equal(signal.aborted, false)
        assert.equal(facts.requestBodyHash, digest(body)); },
      recordSettlement(facts, signal) { settlement = facts; assert.ok(Object.isFrozen(facts)); assert.equal(signal.aborted, false) },
    },
    fetchImpl: async (_url, request) => { forwarded = request; return validResponse() },
  })
  try {
    const response = await post(guard)
    assert.equal(await response.text(), stream)
    assert.equal(forwarded.body.toString(), body)
    assert.equal(forwarded.headers.get('authorization'), 'Bearer offline-fixture-placeholder')
    assert.equal(forwarded.headers.get('x-ark-cost-dispatch-id'), null)
    assert.equal(admission.dispatchId, 'offline-dispatch-1')
    assert.equal(admission.sessionIdHash, digest(`ark-cost-session-v1\0${sessionId}`))
    assert.equal(settlement.attemptId, admission.attemptId)
    assert.equal(settlement.requestBodyHash, admission.requestBodyHash)
    assert.equal(settlement.responseIdHash, digest(common.id))
    assert.equal(settlement.upperBoundMicroCny, 36)
    assert.equal(settlement.inputTokens, 10); assert.equal(settlement.outputTokens, 2)
    const serialized = JSON.stringify(settlement)
    assert.ok(!serialized.includes(sessionId)); assert.ok(!serialized.includes('offline-fixture-placeholder'))
    assert.ok(!serialized.includes('offline task'))
    assert.deepEqual(await ledger(path), { schema: 2, budgetMicroCny: 5000000, maxRequests: 32,
      requestCount: 1, settledUpperBoundMicroCny: 36, pending: [] })
  } finally { await guard.close() }
}))

test('missing session observation refuses witness-mode dispatch before admission and budget reservation', async () => fixture(async path => {
  let admitted = 0, forwarded = 0
  const guard = await startCostGuard({ ledgerPath: path, requestEvidenceOwner: {
    admitRequest() { admitted++ }, recordSettlement() { throw new Error('unexpected settlement') },
  }, fetchImpl: async () => { forwarded++; return validResponse() } })
  try {
    const response = await post(guard, body, false)
    assert.equal(response.status, 400)
    assert.equal((await response.json()).error, 'missing_or_invalid_session_binding')
    assert.equal(admitted, 0); assert.equal(forwarded, 0); assert.equal((await ledger(path)).requestCount, 0)
  } finally { await guard.close() }
}))

test('a valid-looking session header cannot admit changed body without the independent registered record', async () => fixture(async path => {
  let forwarded = 0
  const guard = await startCostGuard({ ledgerPath: path, requestEvidenceOwner: {
    admitRequest(facts) { if (facts.requestBodyHash !== digest(body)) throw new Error('unregistered_body') },
    recordSettlement() { throw new Error('unexpected settlement') },
  }, fetchImpl: async () => { forwarded++; return validResponse() } })
  try {
    const response = await post(guard, body.replace('offline task', 'another task'))
    assert.equal(response.status, 502); await response.arrayBuffer()
    assert.equal(forwarded, 0); assert.equal((await ledger(path)).requestCount, 0)
  } finally { await guard.close() }
}))

test('incomplete provider response creates no cost witness and keeps the original full budget reserve', async () => fixture(async path => {
  let settlements = 0
  const guard = await startCostGuard({ ledgerPath: path, requestEvidenceOwner: {
    admitRequest() {}, recordSettlement() { settlements++ },
  }, fetchImpl: async () => new Response(stream.replace('data: [DONE]\n\n', ''), { headers: { 'content-type': 'text/event-stream' } }) })
  try {
    await assert.rejects(async () => { const response = await post(guard); await response.text() })
    const actual = await ledger(path)
    assert.equal(actual.requestCount, 1); assert.equal(actual.settledUpperBoundMicroCny, 0)
    assert.equal(actual.pending.length, 1); assert.equal(actual.pending[0].reservedMicroCny, 2146304)
    assert.equal(settlements, 0)
  } finally { await guard.close() }
}))

test('failed evidence storage cannot undo an already settled budget charge or release a complete response', async () => fixture(async path => {
  const guard = await startCostGuard({ ledgerPath: path, requestEvidenceOwner: {
    admitRequest() {}, recordSettlement() { throw new Error('offline_storage_failure') },
  }, fetchImpl: async () => validResponse() })
  try {
    await assert.rejects(async () => { const response = await post(guard); await response.text() })
    const actual = await ledger(path)
    assert.equal(actual.requestCount, 1); assert.equal(actual.settledUpperBoundMicroCny, 36)
    assert.deepEqual(actual.pending, [])
  } finally { await guard.close() }
}))

test('guard shutdown aborts and joins a cooperative settlement owner before close resolves', async () => fixture(async path => {
  let entered, terminated = false
  const reached = new Promise(resolve => { entered = resolve })
  const guard = await startCostGuard({ ledgerPath: path, requestEvidenceOwner: {
    admitRequest() {},
    recordSettlement(_facts, signal) { entered(); return new Promise((_resolve, reject) => {
      const abort = () => { terminated = true; reject(signal.reason) }
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    }) },
  }, fetchImpl: async () => validResponse() })
  const response = post(guard).then(async r => r.text())
  const rejected = assert.rejects(response)
  await reached
  await guard.close()
  await rejected
  assert.equal(terminated, true)
  assert.equal((await ledger(path)).settledUpperBoundMicroCny, 36)
}))


test('captured owner methods preserve their receiver and cannot be replaced after startup', async () => fixture(async path => {
  let admissions = 0, settlements = 0
  const owner = { identity: 'offline-owner',
    admitRequest() { assert.equal(this, owner); assert.equal(this.identity, 'offline-owner'); admissions++ },
    recordSettlement() { assert.equal(this, owner); settlements++ },
  }
  const guard = await startCostGuard({ ledgerPath: path, requestEvidenceOwner: owner, fetchImpl: async () => validResponse() })
  owner.admitRequest = () => { throw new Error('replaced admission must not run') }
  owner.recordSettlement = () => { throw new Error('replaced settlement must not run') }
  try {
    assert.equal(await (await post(guard)).text(), stream)
    assert.equal(admissions, 1); assert.equal(settlements, 1)
  } finally { await guard.close() }
}))


test('missing registered dispatch refuses evidence-mode send before admission or spend', async () => fixture(async path => {
  let admitted = 0, sent = 0
  const guard = await startCostGuard({ ledgerPath: path, requestEvidenceOwner: {
    admitRequest() { admitted++ }, recordSettlement() { throw new Error('unexpected settle') },
  }, fetchImpl: async () => { sent++; return validResponse() } })
  try {
    const response = await fetch(`${guard.baseURL}/chat/completions`, { method: 'POST', body,
      headers: { authorization: 'Bearer offline-placeholder', 'x-deepseek-harness-session-id': sessionId } })
    assert.equal(response.status, 400)
    assert.equal((await response.json()).error, 'missing_or_invalid_registered_dispatch')
    assert.equal(admitted, 0); assert.equal(sent, 0); assert.equal((await ledger(path)).requestCount, 0)
  } finally { await guard.close() }
}))
