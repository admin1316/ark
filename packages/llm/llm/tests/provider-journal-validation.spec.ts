import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { afterEach, expect, it, vi } from 'vitest'
import { createProviderRuntime, PROVIDER_TEST_REF } from './provider-runtime.ts'
import legacySamples from './fixtures/legacy-v1-journals.json' with { type: 'json' }

const KEY = credentialKey('llm-remote', 'alpha')
const ID = '66666666-6666-4666-8666-666666666666'
const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function replace(target: Record<string, unknown>, path: string[], value: unknown) {
  const [head, ...tail] = path
  if (head === undefined) throw new Error('fixture mutation requires a field')
  if (tail.length === 0) { target[head] = value; return }
  const nested = target[head]
  if (!object(nested)) throw new Error('fixture mutation requires an object parent')
  replace(nested, tail, value)
}

const invalidFields: Array<{ path: string[]; value: unknown }> = [
  { path: ['version'], value: 2 },
  { path: ['receiptVersion'], value: 2 },
  { path: ['transactionId'], value: 'invalid' },
  { path: ['provider'], value: 'INVALID' },
  { path: ['settingsNs'], value: '' },
  { path: ['digest'], value: 'invalid' },
  { path: ['requestDigest'], value: 'invalid' },
  { path: ['phase'], value: 'unknown' },
  { path: ['plan'], value: null },
  { path: ['plan', 'extra'], value: true },
  { path: ['plan', 'settingsPath'], value: [7] },
  { path: ['plan', 'expectedRevision'], value: -1 },
  { path: ['plan', 'expectedUserDigest'], value: false },
  { path: ['plan', 'requestDigest'], value: 'invalid' },
  { path: ['plan', 'ops'], value: [{ op: 'set', path: ['alpha'], value: {} }, { op: 'unset', path: ['alpha', 'model'] }] },
  { path: ['plan', 'ops'], value: Array.from({ length: 65 }, (_, i) => ({ op: 'unset', path: ['alpha', String(i)] })) },
  { path: ['plan', 'ops'], value: [{ op: 'unset', path: ['alpha'], extra: true }] },
  { path: ['plan', 'credential'], value: null },
  { path: ['plan', 'credential', 'ref'], value: 'not a reference' },
  { path: ['plan', 'credential', 'op'], value: 'unknown' },
  { path: ['plan', 'credential', 'valueDigest'], value: 7 },
  { path: ['plan', 'credential', 'before'], value: 7 },
  { path: ['plan', 'credential', 'before'], value: { valueDigest: 'invalid' } },
  { path: ['plan', 'credential', 'before'], value: { valueDigest: null, source: 'file' } },
  { path: ['plan', 'credential', 'before'], value: { valueDigest: '0'.repeat(64), source: '' } },
  { path: ['plan', 'credential', 'before'], value: { valueDigest: '0'.repeat(64), source: 1 } },
  { path: ['plan', 'credential', 'before'], value: { valueDigest: null, extra: true } },
  { path: ['legacyInput'], value: {} },
  { path: ['legacyInput'], value: { settingsPath: [], digest: 'invalid' } },
  { path: ['completed'], value: [] },
  { path: ['completed', 'invalid'], value: {} },
  { path: ['completed', ID], value: null },
  { path: ['completed', ID, 'requestDigest'], value: false },
  { path: ['completed', ID, 'outcome'], value: 'unknown' },
  { path: ['completed', ID, 'outcome'], value: 'rolled-back' },
  { path: ['completed', ID, 'error'], value: null },
  { path: ['completed', ID, 'error'], value: { code: 'settings-rejected', details: { ns: 'transaction-fixture' } } },
  { path: ['completed', ID, 'error'], value: { code: 'unexpected', message: 'synthetic-diagnostic', details: {} } },
  { path: ['completed', ID, 'error'], value: { code: 'settings-conflict', details: { ns: 'fixture', expected: -1, actual: 0 } } },
  { path: ['completed', ID, 'error'], value: { code: 'settings-conflict', details: { ns: 'fixture', expected: 0, actual: -1 } } },
  { path: ['completed', ID, 'error'], value: { code: 'settings-conflict', details: { ns: false, expected: 0, actual: 0 } } },
  { path: ['completed', ID, 'error'], value: { code: 'provider-registration-rejected', details: { provider: 'INVALID' } } },
  { path: ['completed', ID, 'requestDigest'], value: '0'.repeat(64) },
]

it.each(invalidFields)('refuses malformed retained journal field $path without writing', async ({ path, value }) => {
  const run = await createProviderRuntime()
  cleanups.push(run.dispose)
  await run.mutate(run.request({ transactionId: ID, credential: { op: 'set', ref: PROVIDER_TEST_REF, value: 'synthetic-validation' } }))
  const stored = structuredClone(await run.ctx.credentials.readRecord(KEY))
  if (stored?.kind !== 'grant' || !object(stored.payload)) throw new Error('fixture did not create a grant journal')
  replace(stored.payload, path, value)
  await run.ctx.credentials.modifyRecord(KEY, async () => stored)
  const bytes = await readFile(run.credentialPath, 'utf8')
  await expect(run.ctx.llm.remoteProviderTransaction({ provider: 'alpha', transactionId: ID }))
    .rejects.toMatchObject({ failure: { code: 'provider-transaction-in-doubt' } })
  expect(await readFile(run.credentialPath, 'utf8')).toBe(bytes)
})

it.each([
  ['provider', 'INVALID'], ['transactionId', 'bad'], ['settingsNs', ''], ['expectedRevision', -1],
  ['expectedRevision', 1.5], ['ops', []], ['ops', Array.from({ length: 65 }, (_, i) => ({ op: 'unset', path: [String(i)] }))],
  ['credential', {}], ['credential', { op: 'set', ref: PROVIDER_TEST_REF, value: '' }],
  ['credential', { op: 'set', ref: PROVIDER_TEST_REF, value: 7 }], ['credential', { op: 'unknown', ref: PROVIDER_TEST_REF }],
  ['ops', [{ op: 'set', path: ['alpha'], value: {} }, { op: 'set', path: ['alpha', 'model'], value: 'overlap' }]],
] as const)('refuses invalid mutation input %s', async (field, value) => {
  const run = await createProviderRuntime()
  cleanups.push(run.dispose)
  const request = run.request()
  Reflect.set(request, field, value)
  await expect(run.mutate(request)).rejects.toHaveProperty('failure.code')
  expect(await run.ctx.credentials.readRecord(KEY)).toBeUndefined()
})

it('rejects lossy request data and unknown recovery identities before writing', async () => {
  const run = await createProviderRuntime()
  cleanups.push(run.dispose)
  expect(await run.ctx.llm.remoteProviderTransaction({ provider: 'alpha', transactionId: ID }))
    .toEqual({ state: 'absent', needsCredential: false })
  const request = run.request()
  Reflect.set(request, 'extra', Number.POSITIVE_INFINITY)
  await expect(run.mutate(request)).rejects.toMatchObject({ failure: { code: 'input-invalid' } })
  await expect(run.ctx.llm.remoteProviderTransaction({ provider: 'INVALID', transactionId: ID }))
    .rejects.toMatchObject({ failure: { code: 'input-invalid' } })
  for (const credentialValue of ['', '  ']) {
    await expect(run.ctx.llm.remoteResumeProvider({ provider: 'alpha', transactionId: ID, credentialValue }, new AbortController().signal))
      .rejects.toMatchObject({ failure: { code: 'input-invalid' } })
  }
  await expect(run.ctx.llm.remoteResumeProvider({ provider: 'alpha', transactionId: ID }, new AbortController().signal))
    .rejects.toMatchObject({ failure: { code: 'provider-transaction-in-doubt' } })
  await run.mutate()
  expect(await run.ctx.llm.remoteProviderTransaction({ provider: 'alpha', transactionId: randomUUID() }))
    .toEqual({ state: 'absent', needsCredential: false })
  await expect(run.ctx.llm.remoteResumeProvider({ provider: 'alpha', transactionId: ID }, new AbortController().signal))
    .rejects.toMatchObject({ failure: { code: 'provider-transaction-in-doubt' } })
})

it.each(['completed', 'requestDigest', 'legacyInput'])('refuses a legacy journal mixed with current %s metadata', async (field) => {
  const run = await createProviderRuntime({ namespace: 'legacy-fixture' })
  cleanups.push(run.dispose)
  const sample = legacySamples.journals[2]!.payload
  await run.ctx.credentials.modifyRecord(KEY, async () => ({ kind: 'grant', payload: { ...sample, [field]: {} } }))
  await expect(run.ctx.llm.remoteProviderTransaction({ provider: 'alpha', transactionId: sample.transactionId }))
    .rejects.toMatchObject({ failure: { code: 'provider-transaction-in-doubt' } })
})

it.each(['rolled-back', 'committed-not-live'])('projects the safe default error of an old %s receipt', async (outcome) => {
  const run = await createProviderRuntime({ namespace: 'legacy-fixture' })
  cleanups.push(run.dispose)
  const sample = legacySamples.journals[2]!.payload
  await run.ctx.credentials.modifyRecord(KEY, async () => ({ kind: 'grant', payload: { ...sample, outcome } }))
  expect(await run.ctx.llm.remoteProviderTransaction({ provider: 'alpha', transactionId: sample.transactionId })).toMatchObject({ state: outcome })
})

it('refuses a digest-valid journal stored under another provider identity', async () => {
  const run = await createProviderRuntime({ namespace: 'legacy-fixture' })
  cleanups.push(run.dispose)
  const sample = legacySamples.journals[2]!.payload
  const digest = createHash('sha256').update(JSON.stringify({ provider: 'beta', settingsNs: sample.settingsNs,
    settingsPath: sample.plan.settingsPath, ops: sample.plan.ops })).digest('hex')
  await run.ctx.credentials.modifyRecord(KEY, async () => ({ kind: 'grant', payload: { ...sample, provider: 'beta', digest } }))
  await expect(run.ctx.llm.remoteProviderTransaction({ provider: 'alpha', transactionId: sample.transactionId }))
    .rejects.toMatchObject({ failure: { code: 'provider-transaction-in-doubt', message: 'provider journal ownership is invalid' } })
})

it('requires the write-only value when a retained normalized plan stages a missing credential', async () => {
  const run = await createProviderRuntime({ namespace: 'legacy-fixture' })
  cleanups.push(run.dispose)
  await run.ctx.settings.update(run.namespace, { alpha: { model: 'fixture-model', apiKeyEnv: 'ARK_SYNTHETIC_LEGACY' } })
  const sample = legacySamples.journals[4]!.payload
  const request = run.request({ transactionId: sample.transactionId, ops: [{ op: 'set', path: ['alpha', 'model'], value: 'fixture-model' }] })
  const hash = (value: string) => createHash('sha256').update(value).digest('hex')
  const requestDigest = hash(JSON.stringify({ provider: 'alpha', settingsNs: run.namespace, settingsPath: ['alpha'], ops: request.ops }))
  const plan = { ...sample.plan, requestDigest }
  const digest = hash(JSON.stringify({ provider: 'alpha', settingsNs: run.namespace,
    settingsPath: plan.settingsPath, ops: plan.ops, credential: plan.credential, requestDigest }))
  await run.ctx.credentials.modifyRecord(KEY, async () => ({ kind: 'grant', payload: { ...sample, plan, digest, phase: 'prepared' } }))
  await expect(run.mutate(request)).rejects.toMatchObject({ failure: { code: 'provider-transaction-needs-credential' } })
  expect(await run.ctx.credentials.readRecord(KEY)).toMatchObject({ payload: { phase: 'prepared' } })
})

it('refuses a legacy implicit removal while another provider still references the credential', async () => {
  const run = await createProviderRuntime()
  cleanups.push(run.dispose)
  await run.ctx.credentials.set(PROVIDER_TEST_REF, 'synthetic-shared')
  await run.ctx.settings.update(run.namespace, { beta: { apiKeyEnv: PROVIDER_TEST_REF } })
  const plan = { settingsPath: ['alpha'], expectedRevision: 0,
    ops: [{ op: 'set', path: ['alpha', 'apiKeyEnv'], value: '' }], credential: { op: 'unset', ref: PROVIDER_TEST_REF } }
  const digest = createHash('sha256').update(JSON.stringify({ provider: 'alpha', settingsNs: run.namespace,
    settingsPath: plan.settingsPath, ops: plan.ops, credential: plan.credential })).digest('hex')
  await run.ctx.credentials.modifyRecord(KEY, async () => ({ kind: 'grant', payload: {
    version: 1, transactionId: ID, provider: 'alpha', settingsNs: run.namespace, plan, digest, phase: 'prepared',
  } }))
  const bytes = await readFile(run.credentialPath, 'utf8')
  await expect(run.ctx.llm.remoteResumeProvider({ provider: 'alpha', transactionId: ID }, new AbortController().signal))
    .rejects.toMatchObject({ failure: { code: 'credential-ownership-rejected' } })
  expect(await readFile(run.credentialPath, 'utf8')).toBe(bytes)
})

it('refuses deferred removal from an older plan without a credential before-image', async () => {
  const run = await createProviderRuntime()
  cleanups.push(run.dispose)
  await run.ctx.credentials.set(PROVIDER_TEST_REF, 'synthetic-retained')
  vi.spyOn(run.ctx.credentials, 'unset').mockRejectedValueOnce(new Error('fixture interruption'))
  const request = run.request({ ops: [{ op: 'set', path: ['alpha', 'apiKeyEnv'], value: '' }],
    credential: { op: 'unset', ref: PROVIDER_TEST_REF } })
  await expect(run.mutate(request)).rejects.toMatchObject({ failure: { code: 'provider-transaction-in-doubt' } })
  const current = await run.ctx.credentials.readRecord(KEY)
  if (current?.kind !== 'grant' || !object(current.payload)) throw new Error('fixture journal is missing')
  const plan = structuredClone(current.payload.plan)
  if (!object(plan) || !object(plan.credential)) throw new Error('fixture credential plan is missing')
  delete plan.expectedUserDigest
  delete plan.credential.before
  const digest = createHash('sha256').update(JSON.stringify({ provider: 'alpha', settingsNs: run.namespace,
    settingsPath: plan.settingsPath, ops: plan.ops, credential: plan.credential })).digest('hex')
  await run.ctx.credentials.modifyRecord(KEY, async () => ({ kind: 'grant', payload: {
    version: 1, transactionId: request.transactionId, provider: 'alpha', settingsNs: run.namespace, plan, digest, phase: 'settings-applied',
  } }))
  await expect(run.ctx.llm.remoteResumeProvider({ provider: 'alpha', transactionId: request.transactionId }, new AbortController().signal))
    .rejects.toMatchObject({ failure: { code: 'provider-transaction-in-doubt', message: 'credential removal has no durable before-image' } })
  expect(await run.ctx.credentials.resolve(PROVIDER_TEST_REF)).toMatchObject({ value: 'synthetic-retained' })
})

it('rejects terminal metadata on an unfinished journal and a plan with no operation', async () => {
  const run = await createProviderRuntime()
  cleanups.push(run.dispose)
  await run.mutate(run.request({ transactionId: ID }))
  const stored = structuredClone(await run.ctx.credentials.readRecord(KEY))
  if (stored?.kind !== 'grant' || !object(stored.payload)) throw new Error('fixture did not create a journal')
  const payload = stored.payload
  await run.ctx.credentials.modifyRecord(KEY, async () => ({ ...stored, payload: { ...payload, phase: 'prepared' } }))
  await expect(run.ctx.llm.remoteProviderTransaction({ provider: 'alpha', transactionId: ID }))
    .rejects.toMatchObject({ failure: { code: 'provider-transaction-in-doubt' } })
  replace(stored.payload, ['plan', 'ops'], [])
  await run.ctx.credentials.modifyRecord(KEY, async () => stored)
  await expect(run.ctx.llm.remoteProviderTransaction({ provider: 'alpha', transactionId: ID }))
    .rejects.toMatchObject({ failure: { code: 'provider-transaction-in-doubt' } })
})

it('refuses an API-key record and lossy grant payload instead of interpreting either as a journal', async () => {
  const run = await createProviderRuntime()
  cleanups.push(run.dispose)
  await run.ctx.credentials.modifyRecord(KEY, async () => ({ kind: 'api-key' }))
  await expect(run.ctx.llm.remoteProviderTransaction({ provider: 'alpha', transactionId: ID }))
    .rejects.toMatchObject({ failure: { code: 'provider-transaction-in-doubt' } })
  vi.spyOn(run.ctx.credentials, 'readRecord').mockResolvedValueOnce({ kind: 'grant', payload: { value: Infinity } })
  await expect(run.ctx.llm.remoteProviderTransaction({ provider: 'alpha', transactionId: ID }))
    .rejects.toMatchObject({ failure: { code: 'provider-transaction-in-doubt' } })
})

it.each(['none', 'set', 'unset'] as const)('matches the original input of a normalized legacy %s receipt', async (kind) => {
  const run = await createProviderRuntime()
  cleanups.push(run.dispose)
  const request = run.request({
    ...kind === 'none' ? {} : kind === 'set'
      ? { credential: { op: 'set' as const, ref: PROVIDER_TEST_REF, value: 'synthetic-normalized-secret' } }
      : { ops: [{ op: 'set', path: ['alpha', 'apiKeyEnv'], value: '' }], credential: { op: 'unset' as const, ref: PROVIDER_TEST_REF } },
  })
  await run.mutate(request)
  const current = await run.ctx.credentials.readRecord(KEY)
  if (current?.kind !== 'grant' || !object(current.payload)) throw new Error('fixture journal is missing')
  const plan = structuredClone(current.payload.plan)
  if (!object(plan)) throw new Error('fixture plan is missing')
  delete plan.expectedUserDigest
  if (object(plan.credential)) delete plan.credential.before
  const hash = (value: string) => createHash('sha256').update(value).digest('hex')
  const credential = request.credential?.op === 'set'
    ? { op: 'set', ref: request.credential.ref, valueDigest: hash(request.credential.value) } : request.credential
  plan.requestDigest = hash(JSON.stringify({ provider: request.provider, settingsNs: request.settingsNs,
    settingsPath: ['alpha'], ops: request.ops, credential }))
  const user = run.ctx.settings.describe().find(entry => entry.ns === run.namespace)?.user
  if (!object(user) || !object(user.alpha)) throw new Error('fixture committed profile is missing')
  plan.ops = [{ op: 'set', path: ['alpha'], value: user.alpha }]
  const digest = hash(JSON.stringify({ provider: request.provider, settingsNs: request.settingsNs,
    settingsPath: plan.settingsPath, ops: plan.ops, credential: plan.credential, requestDigest: plan.requestDigest }))
  await run.ctx.credentials.modifyRecord(KEY, async () => ({ kind: 'grant', payload: {
    version: 1, transactionId: request.transactionId, provider: request.provider, settingsNs: request.settingsNs,
    plan, digest, phase: 'done', outcome: 'committed',
  } }))
  const settings = await readFile(run.settingsPath, 'utf8')
  await run.mutate(request)
  expect(await readFile(run.settingsPath, 'utf8')).toBe(settings)
  expect(await run.ctx.credentials.readRecord(KEY)).toMatchObject({ payload: { receiptVersion: 1, outcome: 'committed' } })
})
