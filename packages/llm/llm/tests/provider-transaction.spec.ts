import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { Service, symbols } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import LocalCredentials from '@deepseek-ai/dsh-credentials-local'
import { afterEach, expect, it, vi } from 'vitest'
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'
import { SettingsConflictError, settingsNamespace } from '@deepseek-ai/dsh-settings'
import legacySamples from './fixtures/legacy-v1-journals.json' with { type: 'json' }
import { createProviderRuntime, FixtureAdapter, Profile, PROVIDER_TEST_NS as NS, PROVIDER_TEST_REF as OLD_REF } from './provider-runtime.ts'

const OLD_KEY = 'synthetic-old-value'
const NEW_KEY = 'synthetic-new-value'
const JOURNAL = credentialKey('llm-remote', 'alpha')

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function runtime(options: Parameters<typeof createProviderRuntime>[0] = {}) {
  const run = await createProviderRuntime(options)
  cleanups.push(run.dispose)
  return run
}

it('commits config-only edits through Loader owners and returns the activated, redacted descriptor', async () => {
  const run = await runtime()
  const result = await run.mutate()
  expect(result).toMatchObject({ settings: { ns: NS, revision: 1, value: { alpha: { model: 'updated' } } }, live: { accepted: true } })
  expect(run.active().alpha.model).toBe('updated')
  expect(JSON.parse(await readFile(run.settingsPath, 'utf8'))).toMatchObject({ [NS]: { alpha: { model: 'updated' } } })
  expect(await run.ctx.credentials.resolve(OLD_REF)).toBeUndefined()
})

it('refuses a completed receipt when the live route no longer matches the saved profile', async () => {
  const run = await runtime()
  const request = run.request()
  await run.mutate(request)
  const stored = await readFile(run.settingsPath, 'utf8')
  vi.spyOn(run.ctx.llm, 'listProviders').mockReturnValue([])
  await expect(run.mutate(request)).rejects.toMatchObject({ failure: { code: 'provider-registration-rejected' } })
  expect(await readFile(run.settingsPath, 'utf8')).toBe(stored)
})

it('versions a key-only rotation without overwriting the old active reference', async () => {
  const run = await runtime()
  await run.ctx.credentials.set(OLD_REF, OLD_KEY)
  const result = await run.mutate(run.request({ ops: [], credential: { op: 'set', ref: OLD_REF, value: NEW_KEY } }))
  const nextRef = credentialRef(run.active().alpha.apiKeyEnv)
  expect(nextRef).toMatch(/^ARK_ALPHA_V_[A-F0-9]{24}$/u)
  expect(await run.ctx.credentials.resolve(OLD_REF)).toMatchObject({ value: OLD_KEY })
  expect(await run.ctx.credentials.resolve(nextRef)).toMatchObject({ value: NEW_KEY })
  expect(result.credential).toMatchObject({ configured: true, writable: true })
  expect(JSON.stringify(result)).not.toContain(NEW_KEY)
  expect(JSON.stringify(await run.ctx.credentials.readRecord(JOURNAL))).not.toContain(NEW_KEY)
})

it('commits an endpoint and credential pair, then reloads the same pair from real files', async () => {
  const run = await runtime()
  await run.ctx.credentials.set(OLD_REF, OLD_KEY)
  const request = run.request({ ops: [{ op: 'set', path: ['alpha', 'baseURL'], value: 'https://new.invalid/v1' }],
    credential: { op: 'set', ref: OLD_REF, value: NEW_KEY } })
  await run.mutate(request)
  const active = run.active()
  await run.close()
  const reboot = await runtime({ root: run.root })
  expect(reboot.active()).toEqual(active)
  expect(await reboot.ctx.credentials.resolve(credentialRef(active.alpha.apiKeyEnv))).toMatchObject({ value: NEW_KEY })
  const before = await readFile(run.credentialPath, 'utf8')
  await reboot.mutate(request)
  expect(await readFile(run.credentialPath, 'utf8')).toBe(before)
})

it('rotates every reference within a replaced profile including credential headers', async () => {
  const run = await runtime()
  await run.ctx.credentials.set(OLD_REF, OLD_KEY)
  const profile = { ...run.active().alpha, api: 'openai-completions', credentialHeaders: { Authorization: OLD_REF } }
  await run.mutate(run.request({ ops: [{ op: 'set', path: ['alpha'], value: profile }],
    credential: { op: 'set', ref: OLD_REF, value: NEW_KEY } }))
  expect(run.active().alpha.apiKeyEnv).not.toBe(OLD_REF)
  expect(run.active().alpha.credentialHeaders?.Authorization).toBe(run.active().alpha.apiKeyEnv)
})

it('leaves absent nested paths untouched and retains inherited values when removing user overrides', async () => {
  const run = await runtime()
  const before = run.active().alpha
  await run.mutate(run.request({ ops: [{ op: 'unset', path: ['alpha', 'absentObject', 'absent'] }] }))
  expect(run.active().alpha).toEqual(before)
  await run.mutate(run.request({ ops: [{ op: 'unset', path: ['alpha'] }] }))
  expect(run.active().alpha).toEqual(before)
})

it('commits root-profile replacement and reset without inventing absent user fields', async () => {
  const run = await runtime()
  const ns = settingsNamespace('root-profile-fixture')
  const scope = run.ctx.settings.register(ns, Profile, { base: {
    baseURL: 'https://root.invalid/v1', apiKeyEnv: '', model: 'initial',
  } })
  run.ctx.llm.registerConfigurableProviders([{ provider: 'root', displayName: 'Root', settingsNs: ns, settingsPath: [] }])
  let remove = run.ctx.llm.registerAdapter(['root'], new FixtureAdapter(scope.get()))
  scope.watch((next) => { remove(); remove = run.ctx.llm.registerAdapter(['root'], new FixtureAdapter(next)) })
  run.ctx.effect(() => () => { remove() })
  const request = () => run.request({ provider: 'root', settingsNs: ns,
    expectedRevision: run.ctx.settings.describe().find(entry => entry.ns === ns)!.revision,
    ops: [{ op: 'unset', path: [] }],
  })
  await run.mutate(request())
  await run.ctx.settings.replace(ns, {})
  await run.mutate(request())
  await run.mutate({ ...request(), ops: [{ op: 'set', path: [], value: { model: 'root-updated' } }] })
  expect(scope.get().model).toBe('root-updated')
  await run.mutate(request())
  expect(scope.get().model).toBe('initial')
})

it('persists a previously absent root section but does not claim a missing provider is live', async () => {
  const run = await runtime()
  const ns = settingsNamespace('absent-root-fixture')
  run.ctx.settings.register(ns, z.any())
  run.ctx.llm.registerConfigurableProviders([{ provider: 'absent', displayName: 'Absent', settingsNs: ns, settingsPath: [] }])
  await expect(run.mutate(run.request({ provider: 'absent', settingsNs: ns, expectedRevision: 0,
    ops: [{ op: 'set', path: ['model'], value: 'configured' }] })))
    .rejects.toMatchObject({ failure: { code: 'provider-registration-rejected' } })
  expect(run.ctx.settings.describe().find(entry => entry.ns === ns)?.user).toEqual({ model: 'configured' })
})

it('serializes an actual file credential owner when Cordis context tracing is disabled', async () => {
  const run = await runtime()
  const owner: unknown = Reflect.get(run.ctx.credentials, symbols.original)
  if (!(owner instanceof LocalCredentials)) throw new Error('fixture credential owner was not found')
  const tracker: unknown = Reflect.get(owner, Service.tracker)
  expect(Reflect.set(owner, Service.tracker, undefined)).toBe(true)
  try {
    await Promise.all([run.mutate(run.request({ expectedRevision: 0 })),
      run.mutate(run.request({ expectedRevision: 1, ops: [{ op: 'set', path: ['alpha', 'model'], value: 'last' }] }))])
    expect(run.active().alpha.model).toBe('last')
  } finally { Reflect.set(owner, Service.tracker, tracker) }
})

it('rejects staging when a whole-profile removal leaves no resulting credential reference', async () => {
  const run = await runtime()
  await expect(run.mutate(run.request({ ops: [{ op: 'unset', path: ['alpha'] }],
    credential: { op: 'set', ref: OLD_REF, value: NEW_KEY } })))
    .rejects.toMatchObject({ failure: { code: 'credential-rejected' } })
  expect(await run.ctx.credentials.readRecord(JOURNAL)).toBeUndefined()
})

it('refuses unrelated and still-referenced credential removal before claiming', async () => {
  const run = await runtime()
  for (const reference of [OLD_REF, 'ARK_SYNTHETIC_UNRELATED']) {
    await expect(run.mutate(run.request({ credential: { op: 'unset', ref: reference } })))
      .rejects.toMatchObject({ failure: { code: 'credential-rejected' } })
  }
  await expect(run.mutate(run.request({ credential: { op: 'set', ref: 'ARK_SYNTHETIC_UNRELATED', value: NEW_KEY } })))
    .rejects.toMatchObject({ failure: { code: 'credential-rejected' } })
  await expect(run.mutate(run.request({ credential: { op: 'set', ref: 'ARK_SYNTHETIC_BETA', value: NEW_KEY },
    ops: [{ op: 'set', path: ['alpha', 'apiKeyEnv'], value: 'ARK_SYNTHETIC_BETA' }] })))
    .rejects.toMatchObject({ failure: { code: 'credential-ownership-rejected' } })
  await expect(run.mutate(run.request({ ops: [{ op: 'set', path: ['alpha', 'apiKeyEnv'], value: 'ARK_SYNTHETIC_UNRELATED' }] })))
    .rejects.toMatchObject({ failure: { code: 'credential-ownership-required' } })
  expect(await run.ctx.credentials.readRecord(JOURNAL)).toBeUndefined()
})

it('refuses progress without recreating a removed claimed journal', async () => {
  const run = await runtime()
  const set = run.ctx.credentials.set.bind(run.ctx.credentials)
  vi.spyOn(run.ctx.credentials, 'set').mockImplementationOnce(async (...args) => {
    await set(...args)
    await run.ctx.credentials.deleteRecord(JOURNAL)
  })
  await expect(run.mutate(run.request({ credential: { op: 'set', ref: OLD_REF, value: NEW_KEY } })))
    .rejects.toMatchObject({ failure: { code: 'provider-transaction-in-doubt' } })
  expect(await run.ctx.credentials.readRecord(JOURNAL)).toBeUndefined()
  expect(run.revision()).toBe(0)
})

it('distinguishes unavailable journal reads, claim failures and unavailable credentials', async () => {
  const run = await runtime()
  const request = run.request({ credential: { op: 'set', ref: OLD_REF, value: NEW_KEY } })
  vi.spyOn(run.ctx.credentials, 'readRecord').mockRejectedValueOnce(new Error('fixture read failure'))
  await expect(run.mutate(request)).rejects.toMatchObject({ failure: { code: 'service-unavailable' } })
  vi.spyOn(run.ctx.credentials, 'resolve').mockRejectedValueOnce(new Error('fixture resolution failure'))
  await expect(run.mutate(request)).rejects.toMatchObject({ failure: { code: 'service-unavailable' } })
  vi.spyOn(run.ctx.credentials, 'modifyRecord').mockRejectedValueOnce(new Error('fixture claim failure'))
  await expect(run.mutate(request)).rejects.toMatchObject({ failure: { code: 'provider-transaction-in-doubt' } })
  expect(await run.ctx.credentials.readRecord(JOURNAL)).toBeUndefined()
})

it('refuses unowned namespaces, absent settings registrations and read-only credential references', async () => {
  const run = await runtime()
  await expect(run.mutate(run.request({ provider: 'unowned' })))
    .rejects.toMatchObject({ failure: { code: 'settings-rejected' } })
  run.ctx.llm.registerConfigurableProviders([{ provider: 'unregistered', displayName: 'Unregistered',
    settingsNs: 'unregistered', settingsPath: [] }])
  await expect(run.mutate(run.request({ provider: 'unregistered', settingsNs: 'unregistered' })))
    .rejects.toMatchObject({ failure: { code: 'settings-rejected' } })
  vi.spyOn(run.ctx.credentials, 'describe').mockResolvedValue({ configured: true, source: 'env', writable: false })
  await expect(run.mutate(run.request({ credential: { op: 'set', ref: OLD_REF, value: NEW_KEY } })))
    .rejects.toMatchObject({ failure: { code: 'credential-rejected' } })
})

it.each(['settings', 'credentials'])('refuses mutations after the actual %s owner is unloaded', async (owner) => {
  const run = await runtime()
  const entry = [...run.ctx.loader.entries()].find(candidate => candidate.options.name === `cordis:fixture-${owner}`)
  if (entry === undefined) throw new Error('fixture owner is missing')
  await entry.update({ disabled: true })
  await expect(run.ctx.llm.remoteMutateProvider({ transactionId: randomUUID(), provider: 'alpha', settingsNs: NS,
    expectedRevision: 0, ops: [{ op: 'set', path: ['alpha', 'model'], value: 'rejected' }] }, new AbortController().signal))
    .rejects.toMatchObject({ failure: { code: 'service-unavailable' } })
  if (owner === 'credentials') await expect(run.ctx.llm.remoteProviderTransaction({ provider: 'alpha', transactionId: randomUUID() }))
    .rejects.toMatchObject({ failure: { code: 'service-unavailable' } })
})

it('refuses mutation through a retired LLM owner', async () => {
  const run = await runtime()
  const llm = run.ctx.llm
  const request = run.request()
  const entry = [...run.ctx.loader.entries()].find(candidate => candidate.options.name === 'cordis:fixture-llm')
  if (entry === undefined) throw new Error('fixture LLM owner is missing')
  await entry.update({ disabled: true })
  await expect(llm.remoteMutateProvider(request, new AbortController().signal))
    .rejects.toMatchObject({ failure: { code: 'service-unavailable' } })
})

it.each(['prepared', 'settings-applied', 'done'])('does not return live success when the owner unloads after %s', async (phase) => {
  const run = await runtime()
  const request = run.request()
  const owner = [...run.ctx.loader.entries()].find(candidate => candidate.options.name === 'cordis:fixture-owner')
  if (owner === undefined) throw new Error('fixture registration owner is missing')
  const modify = run.ctx.credentials.modifyRecord.bind(run.ctx.credentials)
  vi.spyOn(run.ctx.credentials, 'modifyRecord').mockImplementation(async (...args) => {
    const result = await modify(...args)
    if (result?.kind === 'grant' && result.payload !== null && typeof result.payload === 'object'
      && 'phase' in result.payload && result.payload.phase === phase) await owner.update({ disabled: true })
    return result
  })
  await expect(run.mutate(request)).rejects.toMatchObject({ failure: {
    code: phase === 'done' ? 'provider-registration-rejected' : 'provider-transaction-in-doubt',
  } })
})

it('retains progress for retry if a stored plan no longer matches its registered profile path', async () => {
  const run = await runtime()
  const request = run.request({ credential: { op: 'set', ref: OLD_REF, value: NEW_KEY } })
  vi.spyOn(run.ctx.credentials, 'set').mockRejectedValueOnce(new Error('fixture staging failure'))
  await expect(run.mutate(request)).rejects.toMatchObject({ failure: { code: 'provider-transaction-in-doubt' } })
  const list = run.ctx.llm.listConfigurableProviders.bind(run.ctx.llm)
  vi.spyOn(run.ctx.llm, 'listConfigurableProviders').mockImplementation(() => list().map(provider =>
    provider.provider === 'alpha' ? { ...provider, settingsPath: ['renamed-profile'] } : provider))
  const bytes = await readFile(run.credentialPath, 'utf8')
  await expect(run.ctx.llm.remoteResumeProvider({ provider: 'alpha', transactionId: request.transactionId, credentialValue: NEW_KEY }, new AbortController().signal))
    .rejects.toMatchObject({ failure: { code: 'provider-transaction-in-doubt' } })
  expect(await readFile(run.credentialPath, 'utf8')).toBe(bytes)
})

it('preserves the failure boundary when settings preview rejects invalid field types', async () => {
  const run = await runtime()
  await expect(run.mutate(run.request({ ops: [{ op: 'set', path: ['alpha', 'model'], value: 7 }] })))
    .rejects.toMatchObject({ failure: { code: 'settings-rejected' } })
  expect(await run.ctx.credentials.readRecord(JOURNAL)).toBeUndefined()
  await expect(run.mutate(run.request({ ops: [{ op: 'set', path: ['alpha', 'model', 'nested'], value: 7 }] })))
    .rejects.toMatchObject({ failure: { code: 'settings-rejected' } })
})

it('preserves a same-process settings change that races credential staging', async () => {
  const run = await runtime()
  const set = run.ctx.credentials.set.bind(run.ctx.credentials)
  vi.spyOn(run.ctx.credentials, 'set').mockImplementationOnce(async (...args) => {
    await set(...args)
    await run.ctx.settings.update(NS, { beta: { model: 'concurrent-update' } })
  })
  await expect(run.mutate(run.request({ credential: { op: 'set', ref: OLD_REF, value: NEW_KEY } })))
    .rejects.toMatchObject({ failure: { code: 'settings-conflict' } })
  expect(run.active().beta.model).toBe('concurrent-update')
  expect(run.active().alpha.model).toBe('initial')
  expect(await readFile(run.credentialPath, 'utf8')).not.toContain(NEW_KEY)
})

it('reconciles settings that committed before their caller received a failure', async () => {
  const run = await runtime()
  const mutate = run.ctx.settings.mutate.bind(run.ctx.settings)
  vi.spyOn(run.ctx.settings, 'mutate').mockImplementationOnce(async (...args) => {
    await mutate(...args)
    throw new Error('fixture post-commit notification failure')
  })
  await run.mutate()
  expect(run.active().alpha.model).toBe('updated')
  expect(await run.ctx.credentials.readRecord(JOURNAL)).toMatchObject({ payload: { outcome: 'committed' } })
})

it('does not overwrite settings that diverge after the applied journal phase', async () => {
  const run = await runtime()
  const modify = run.ctx.credentials.modifyRecord.bind(run.ctx.credentials)
  vi.spyOn(run.ctx.credentials, 'modifyRecord').mockImplementation(async (...args) => {
    const result = await modify(...args)
    if (result?.kind === 'grant' && result.payload !== null && typeof result.payload === 'object'
      && 'phase' in result.payload && result.payload.phase === 'settings-applied') {
      await run.ctx.settings.update(NS, { alpha: { model: 'concurrent-winner' } })
    }
    return result
  })
  await expect(run.mutate()).rejects.toMatchObject({ failure: { code: 'provider-transaction-in-doubt' } })
  expect(run.active().alpha.model).toBe('concurrent-winner')
})

it('honors cancellation received while reference writability is being checked', async () => {
  const run = await runtime()
  const cancellation = new AbortController()
  const describe = run.ctx.credentials.describe.bind(run.ctx.credentials)
  vi.spyOn(run.ctx.credentials, 'describe').mockImplementationOnce(async (...args) => {
    const result = await describe(...args)
    cancellation.abort()
    return result
  })
  await expect(run.mutate(run.request({ credential: { op: 'set', ref: OLD_REF, value: NEW_KEY } }), cancellation.signal))
    .rejects.toMatchObject({ failure: { code: 'cancelled' } })
  expect(await run.ctx.credentials.readRecord(JOURNAL)).toBeUndefined()
})

it('drains a claimed transaction and refuses a queued claim while the LLM owner retires', async () => {
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const run = await runtime({ activation: async () => { entered.resolve(undefined); await release.promise } })
  const first = run.mutate().then(value => ({ value }), (error: unknown) => ({ error }))
  await entered.promise
  const queued = run.mutate(run.request()).then(value => ({ value }), (error: unknown) => ({ error }))
  const entry = [...run.ctx.loader.entries()].find(candidate => candidate.options.name === 'cordis:fixture-llm')
  if (entry === undefined) throw new Error('fixture LLM owner is missing')
  const llm = run.ctx.llm
  const retiring = entry.update({ disabled: true })
  try {
    await vi.waitFor(async () => {
      await expect(llm.remoteProviderTransaction({ provider: 'alpha', transactionId: randomUUID() }))
        .rejects.toMatchObject({ failure: { code: 'service-unavailable' } })
    })
  } finally { release.resolve(undefined) }
  await Promise.all([first, retiring])
  expect(await queued).toMatchObject({ error: { failure: { code: 'service-unavailable' } } })
})

it('reconciles a staged write that committed despite an observer error', async () => {
  const run = await runtime()
  const set = run.ctx.credentials.set.bind(run.ctx.credentials)
  vi.spyOn(run.ctx.credentials, 'set').mockImplementationOnce(async (...args) => {
    await set(...args)
    throw new Error('fixture post-commit failure')
  })
  await run.mutate(run.request({ credential: { op: 'set', ref: OLD_REF, value: NEW_KEY } }))
  expect(await run.ctx.credentials.readRecord(JOURNAL)).toMatchObject({ payload: { outcome: 'committed' } })
})

it('rejects a different staged value after an ambiguous write failure without overwriting it', async () => {
  const run = await runtime()
  const set = run.ctx.credentials.set.bind(run.ctx.credentials)
  vi.spyOn(run.ctx.credentials, 'set').mockImplementationOnce(async (reference) => {
    await set(reference, 'synthetic-winner')
    throw new Error('fixture post-commit failure')
  })
  const request = run.request({ credential: { op: 'set', ref: OLD_REF, value: NEW_KEY } })
  await expect(run.mutate(request)).rejects.toMatchObject({ failure: { code: 'provider-transaction-in-doubt' } })
  await expect(run.mutate(request)).rejects.toMatchObject({ failure: { code: 'provider-transaction-in-doubt' } })
  await expect(run.mutate({ ...request, ops: [] })).rejects.toMatchObject({ failure: { code: 'provider-transaction-in-doubt' } })
  expect(await readFile(run.credentialPath, 'utf8')).toContain('synthetic-winner')
})

it('records and replays a settings conflict after claim', async () => {
  const run = await runtime()
  vi.spyOn(run.ctx.settings, 'mutate').mockRejectedValueOnce(new SettingsConflictError(NS, 0, 1))
  const request = run.request()
  await expect(run.mutate(request)).rejects.toMatchObject({ failure: { code: 'settings-conflict' } })
  await expect(run.mutate(request)).rejects.toMatchObject({ failure: { code: 'settings-conflict' } })
})

it.each([false, true])('reconciles deferred removal after a %s post-commit failure', async (committed) => {
  const run = await runtime()
  await run.ctx.credentials.set(OLD_REF, OLD_KEY)
  const unset = run.ctx.credentials.unset.bind(run.ctx.credentials)
  vi.spyOn(run.ctx.credentials, 'unset').mockImplementationOnce(async (...args) => {
    if (committed) await unset(...args)
    throw new Error('fixture removal failure')
  })
  const request = run.request({ ops: [{ op: 'set', path: ['alpha', 'apiKeyEnv'], value: '' }], credential: { op: 'unset', ref: OLD_REF } })
  if (committed) await run.mutate(request)
  else {
    await expect(run.mutate(request)).rejects.toMatchObject({ failure: { code: 'provider-transaction-in-doubt' } })
    await run.ctx.llm.remoteResumeProvider({ provider: 'alpha', transactionId: request.transactionId }, new AbortController().signal)
  }
  expect(await run.ctx.credentials.resolve(OLD_REF)).toBeUndefined()
})

it('finishes an absent-reference unset and retains a journal when terminal persistence fails', async () => {
  const run = await runtime()
  const original = run.ctx.credentials.modifyRecord.bind(run.ctx.credentials)
  vi.spyOn(run.ctx.credentials, 'modifyRecord').mockImplementation(async (key, update, references) => original(key, async (current) => {
    const next = await update(current)
    if (next?.kind === 'grant' && next.payload !== null && typeof next.payload === 'object'
      && 'phase' in next.payload && next.payload.phase === 'done') throw new Error('fixture terminal failure')
    return next
  }, references))
  await expect(run.mutate(run.request({ ops: [{ op: 'set', path: ['alpha', 'apiKeyEnv'], value: '' }], credential: { op: 'unset', ref: OLD_REF } })))
    .rejects.toMatchObject({ failure: { code: 'provider-transaction-in-doubt' } })
  expect(await run.ctx.credentials.readRecord(JOURNAL)).toMatchObject({ payload: { phase: 'credential-applied' } })
})

it('keeps config and active credentials unchanged when staging fails, then retries the claim', async () => {
  const run = await runtime()
  await run.ctx.credentials.set(OLD_REF, OLD_KEY)
  const request = run.request({ credential: { op: 'set', ref: OLD_REF, value: NEW_KEY } })
  const fail = vi.spyOn(run.ctx.credentials, 'set').mockRejectedValueOnce(new Error(NEW_KEY))
  await expect(run.mutate(request)).rejects.toMatchObject({ failure: { code: 'provider-transaction-in-doubt' } })
  expect(run.revision()).toBe(0)
  expect(run.active().alpha.apiKeyEnv).toBe(OLD_REF)
  expect(await run.ctx.credentials.resolve(OLD_REF)).toMatchObject({ value: OLD_KEY })
  fail.mockRestore()
  await run.mutate(request)
  expect(run.active().alpha.model).toBe('updated')
})

it('keeps the old active pair after a real settings-file write failure', async () => {
  const run = await runtime()
  await run.ctx.credentials.set(OLD_REF, OLD_KEY)
  // Invalid external content forces the actual read-modify-write provider to refuse persistence.
  await writeFile(run.settingsPath, 'invalid json')
  const request = run.request({ credential: { op: 'set', ref: OLD_REF, value: NEW_KEY } })
  await expect(run.mutate(request)).rejects.toMatchObject({ failure: { code: 'settings-rejected' } })
  expect(run.active().alpha).toMatchObject({ model: 'initial', apiKeyEnv: OLD_REF })
  expect(await run.ctx.credentials.resolve(OLD_REF)).toMatchObject({ value: OLD_KEY })
  expect(await readFile(run.settingsPath, 'utf8')).toBe('invalid json')
  const journal = await run.ctx.credentials.readRecord(JOURNAL)
  expect(journal).toMatchObject({ payload: { outcome: 'rolled-back' } })
  expect(await readFile(run.credentialPath, 'utf8')).not.toContain(NEW_KEY)
  await expect(run.mutate(request)).rejects.toMatchObject({ failure: { code: 'settings-rejected' } })
})

it('rejects stale writes and retains exact completed retry history across newer writes and restart', async () => {
  const run = await runtime()
  const first = run.request()
  await run.mutate(first)
  const latest = run.request({ ops: [{ op: 'set', path: ['alpha', 'model'], value: 'latest' }] })
  await run.mutate(latest)
  expect(await run.ctx.llm.remoteProviderTransaction({ provider: 'alpha', transactionId: first.transactionId }))
    .toMatchObject({ state: 'committed', live: false })
  await expect(run.mutate({ ...first, transactionId: randomUUID() })).rejects.toMatchObject({ failure: { code: 'settings-conflict' } })
  await run.close()
  const reboot = await runtime({ root: run.root })
  const disk = await readFile(run.settingsPath, 'utf8')
  await reboot.mutate(first)
  expect(reboot.active().alpha.model).toBe('latest')
  expect(await readFile(run.settingsPath, 'utf8')).toBe(disk)
  await expect(reboot.mutate({ ...first, expectedRevision: 99 })).resolves.toMatchObject({ live: { accepted: true } })
  await expect(reboot.mutate({ ...first, ops: latest.ops })).rejects.toMatchObject({ failure: { code: 'provider-transaction-in-doubt' } })
})

it('serializes concurrent A, B and C writes and ends with C', async () => {
  const run = await runtime()
  const calls = ['A', 'B', 'C'].map((value, expectedRevision) => run.mutate(run.request({ expectedRevision,
    ops: [{ op: 'set', path: ['alpha', 'model'], value }] })))
  await Promise.all(calls)
  expect(run.active().alpha.model).toBe('C')
  expect(run.revision()).toBe(3)
})

it('aborts before claim without writes and finishes claimed work after caller cancellation', async () => {
  const run = await runtime()
  const request = run.request()
  await expect(run.mutate(request, AbortSignal.abort())).rejects.toMatchObject({ failure: { code: 'cancelled' } })
  expect(await run.ctx.credentials.readRecord(JOURNAL)).toBeUndefined()
  const cancel = new AbortController()
  const remove = run.ctx.on('credentials/record-updated', () => { cancel.abort() })
  await run.mutate(request, cancel.signal)
  remove()
  expect(cancel.signal.aborted).toBe(true)
  expect(run.active().alpha.model).toBe('updated')
  await run.mutate(run.request({ ops: [{ op: 'set', path: ['alpha', 'model'], value: 'next' }] }))
  expect(run.active().alpha.model).toBe('next')
})

it('coalesces exact concurrent retries without repeated settings or credential effects', async () => {
  const run = await runtime()
  const request = run.request({ credential: { op: 'set', ref: OLD_REF, value: NEW_KEY } })
  const setting = vi.spyOn(run.ctx.settings, 'mutate')
  const credential = vi.spyOn(run.ctx.credentials, 'set')
  await Promise.all([run.mutate(request), run.mutate(request), run.mutate(request)])
  expect(setting).toHaveBeenCalledTimes(1)
  expect(credential).toHaveBeenCalledTimes(1)
})

it.each(['not an env', '', '9INVALID'])('refuses invalid credential reference %j before claiming a journal', async (ref) => {
  const run = await runtime()
  await expect(run.mutate(run.request({ credential: { op: 'set', ref, value: NEW_KEY } })))
    .rejects.toMatchObject({ failure: { code: 'input-invalid' } })
  expect(await run.ctx.credentials.readRecord(JOURNAL)).toBeUndefined()
})

it('waits for activation before unsetting an old-generation credential', async () => {
  const entered = Promise.withResolvers<undefined>()
  const resume = Promise.withResolvers<undefined>()
  const run = await runtime({ activation: async () => { entered.resolve(undefined); await resume.promise } })
  await run.ctx.credentials.set(OLD_REF, OLD_KEY)
  const write = run.mutate(run.request({ ops: [{ op: 'set', path: ['alpha', 'apiKeyEnv'], value: '' }],
    credential: { op: 'unset', ref: OLD_REF } }))
  try {
    await entered.promise
    expect(run.active().alpha.apiKeyEnv).toBe(OLD_REF)
    expect(await run.ctx.credentials.resolve(OLD_REF)).toMatchObject({ value: OLD_KEY })
  } finally { resume.resolve(undefined) }
  await write
  expect(run.active().alpha.apiKeyEnv).toBe('')
  expect(await run.ctx.credentials.resolve(OLD_REF)).toBeUndefined()
})

it.each(['set', 'unset'] as const)('preserves an ordinary credential replacement during delayed %s activation', async (operation) => {
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const run = await runtime({ activation: async () => { entered.resolve(undefined); await release.promise } })
  await run.ctx.credentials.set(OLD_REF, OLD_KEY)
  const set = vi.spyOn(run.ctx.credentials, 'set')
  const request = run.request(operation === 'set'
    ? { credential: { op: 'set', ref: OLD_REF, value: NEW_KEY } }
    : { ops: [{ op: 'set', path: ['alpha', 'apiKeyEnv'], value: '' }], credential: { op: 'unset', ref: OLD_REF } })
  const outcome = run.mutate(request).then(value => ({ value }), (error: unknown) => ({ error }))
  await entered.promise
  const target = operation === 'unset' ? OLD_REF : set.mock.calls[0]?.[0]
  try {
    if (target === undefined) throw new Error('staged reference was not captured')
    await run.ctx.credentials.set(target, 'synthetic-concurrent-winner')
  } finally { release.resolve(undefined) }
  expect(await outcome).toMatchObject({ error: { failure: { code: 'credential-rejected' } } })
  if (target === undefined) throw new Error('staged reference was not captured')
  expect(await run.ctx.credentials.resolve(target)).toMatchObject({ value: 'synthetic-concurrent-winner' })
  expect(await run.ctx.credentials.readRecord(JOURNAL)).toMatchObject({ payload: { outcome: 'committed-not-live' } })
  await expect(run.ctx.llm.remoteResumeProvider({ provider: 'alpha', transactionId: request.transactionId }, new AbortController().signal))
    .rejects.toMatchObject({ failure: { code: 'credential-rejected' } })
})

it('does not remove a concurrent winner while compensating a failed settings write', async () => {
  const run = await runtime()
  const set = vi.spyOn(run.ctx.credentials, 'set')
  const mutate = run.ctx.settings.mutate.bind(run.ctx.settings)
  vi.spyOn(run.ctx.settings, 'mutate').mockImplementationOnce(async (...args) => {
    const target = set.mock.calls[0]?.[0]
    if (target === undefined) throw new Error('staged reference was not captured')
    await run.ctx.credentials.set(target, 'synthetic-rollback-winner')
    return mutate(...args)
  })
  await writeFile(run.settingsPath, 'invalid json')
  await expect(run.mutate(run.request({ credential: { op: 'set', ref: OLD_REF, value: NEW_KEY } })))
    .rejects.toMatchObject({ failure: { code: 'settings-rejected' } })
  const target = set.mock.calls[0]?.[0]
  if (target === undefined) throw new Error('staged reference was not captured')
  expect(await run.ctx.credentials.resolve(target)).toMatchObject({ value: 'synthetic-rollback-winner' })
  expect(await run.ctx.credentials.readRecord(JOURNAL)).toMatchObject({ payload: { outcome: 'rolled-back' } })
})

it('retains a retryable journal if compensating the staged credential fails', async () => {
  const run = await runtime()
  await writeFile(run.settingsPath, 'invalid json')
  const request = run.request({ credential: { op: 'set', ref: OLD_REF, value: NEW_KEY } })
  vi.spyOn(run.ctx.credentials, 'unset').mockRejectedValueOnce(new Error('fixture cleanup failure'))
  await expect(run.mutate(request)).rejects.toMatchObject({ failure: { code: 'provider-transaction-in-doubt' } })
  expect(await run.ctx.credentials.readRecord(JOURNAL)).toMatchObject({ payload: { phase: 'credential-staged' } })
  await expect(run.mutate(request)).rejects.toMatchObject({ failure: { code: 'settings-rejected' } })
  expect(await readFile(run.credentialPath, 'utf8')).not.toContain(NEW_KEY)
  expect(await run.ctx.credentials.readRecord(JOURNAL)).toMatchObject({ payload: { outcome: 'rolled-back' } })
})

it('rejects endpoint-only credential adoption, sibling edits and literal secrets', async () => {
  const run = await runtime()
  await expect(run.mutate(run.request({ ops: [{ op: 'set', path: ['alpha', 'baseURL'], value: 'https://foreign.invalid' }] })))
    .rejects.toMatchObject({ failure: { code: 'credential-ownership-rejected' } })
  await expect(run.mutate(run.request({ ops: [{ op: 'set', path: ['beta', 'model'], value: 'foreign' }] })))
    .rejects.toMatchObject({ failure: { code: 'settings-rejected' } })
  await expect(run.mutate(run.request({ ops: [{ op: 'set', path: ['alpha', 'apiKey'], value: NEW_KEY }] })))
    .rejects.toMatchObject({ failure: { code: 'settings-rejected' } })
  expect(await run.ctx.credentials.readRecord(JOURNAL)).toBeUndefined()
})

it('refuses legacy unverifiable journal history without modifying the store', async () => {
  const run = await runtime()
  await run.ctx.credentials.modifyRecord(JOURNAL, async () => ({ kind: 'grant', payload: { version: 1, phase: 'done' } }))
  const before = await readFile(run.credentialPath, 'utf8')
  await expect(run.mutate()).rejects.toMatchObject({ failure: { code: 'provider-transaction-in-doubt' } })
  expect(await readFile(run.credentialPath, 'utf8')).toBe(before)
})

it('routes model namespace edits through the domain transaction instead of generic Settings Remote', async () => {
  const run = await runtime()
  await expect(run.ctx.settings.remoteMutate(NS, run.request().ops, 0))
    .rejects.toMatchObject({ failure: { code: 'settings-rejected' } })
  expect(run.revision()).toBe(0)
  await run.mutate()
  expect(run.revision()).toBe(1)
})

it('rejects a nested owner transaction without deadlock or poisoning the next write', async () => {
  const failures: unknown[] = []
  const run = await runtime({ activation: async () => {
    try { await run.mutate() } catch (error) { failures.push(error) }
  } })
  await run.mutate()
  expect(failures).toMatchObject([{ failure: { code: 'provider-transaction-reentrant' } }])
  await run.mutate(run.request({ ops: [{ op: 'set', path: ['alpha', 'model'], value: 'next' }] }))
  expect(run.active().alpha.model).toBe('next')
})

it('does not report live success when the settings owner rejects activation', async () => {
  const run = await runtime({ activation: () => Promise.reject(new Error(NEW_KEY)) })
  await run.ctx.credentials.set(OLD_REF, OLD_KEY)
  const request = run.request({ credential: { op: 'set', ref: OLD_REF, value: NEW_KEY } })
  await expect(run.mutate(request)).rejects.toMatchObject({ failure: { code: 'provider-registration-rejected' } })
  expect(run.active().alpha).toMatchObject({ model: 'initial', apiKeyEnv: OLD_REF })
  expect(await run.ctx.credentials.resolve(OLD_REF)).toMatchObject({ value: OLD_KEY })
  const journal = await run.ctx.credentials.readRecord(JOURNAL)
  expect(journal).toMatchObject({ kind: 'grant', payload: { phase: 'done', outcome: 'committed-not-live' } })
  expect(JSON.stringify(journal)).not.toContain(NEW_KEY)
  await expect(run.mutate(request)).rejects.toMatchObject({ failure: { code: 'provider-registration-rejected' } })
})

it('restarts a partially recorded staged credential without staging the secret again', async () => {
  const run = await runtime()
  const request = run.request({ credential: { op: 'set', ref: OLD_REF, value: NEW_KEY } })
  const original = run.ctx.credentials.modifyRecord.bind(run.ctx.credentials)
  let calls = 0
  vi.spyOn(run.ctx.credentials, 'modifyRecord').mockImplementation((key, update, references) => {
    if (++calls === 2) return Promise.reject(new Error('fixture journal disk failure'))
    return original(key, update, references)
  })
  await expect(run.mutate(request)).rejects.toMatchObject({ failure: { code: 'provider-transaction-in-doubt' } })
  expect(run.revision()).toBe(0)
  await run.close()
  const reboot = await runtime({ root: run.root })
  const set = vi.spyOn(reboot.ctx.credentials, 'set')
  await reboot.mutate(request)
  expect(set).not.toHaveBeenCalled()
  expect(await reboot.ctx.credentials.resolve(credentialRef(reboot.active().alpha.apiKeyEnv))).toMatchObject({ value: NEW_KEY })
})

it('cancels a waiting transaction before claim while retaining a caller-independent input snapshot', async () => {
  const entered = Promise.withResolvers<undefined>()
  const resume = Promise.withResolvers<undefined>()
  let calls = 0
  const run = await runtime({ activation: async () => {
    if (++calls === 1) { entered.resolve(undefined); await resume.promise }
  } })
  const first = run.mutate()
  await entered.promise
  const cancel = new AbortController()
  const cancelled = run.mutate(run.request({ expectedRevision: 1 }), cancel.signal)
  const ops = [{ op: 'set' as const, path: ['alpha', 'model'], value: 'snapshotted' }]
  const last = run.mutate(run.request({ expectedRevision: 1, ops }))
  ops[0]!.value = 'caller-mutated'
  cancel.abort()
  const rejection = expect(cancelled).rejects.toMatchObject({ failure: { code: 'cancelled' } })
  resume.resolve(undefined)
  await Promise.all([first, rejection, last])
  expect(run.active().alpha.model).toBe('snapshotted')
})

it('accepts credential-reference-only removal without writing or exposing a key', async () => {
  const run = await runtime()
  await run.ctx.credentials.set(OLD_REF, OLD_KEY)
  await run.mutate(run.request({ ops: [{ op: 'set', path: ['alpha', 'apiKeyEnv'], value: '' }] }))
  expect(run.active().alpha.apiKeyEnv).toBe('')
  expect(await run.ctx.credentials.resolve(OLD_REF)).toMatchObject({ value: OLD_KEY })
})

it('drops extra operation fields before journaling a direct-service request', async () => {
  const run = await runtime()
  const op = { op: 'unset' as const, path: ['alpha', 'model'], value: 'EXTRA_SECRET_MARKER', extra: 'NESTED_SECRET_MARKER' }
  await run.mutate(run.request({ ops: [op] }))
  const record = await run.ctx.credentials.readRecord(JOURNAL)
  expect(JSON.stringify(record)).not.toContain('SECRET_MARKER')
  expect(record).toMatchObject({ payload: { plan: { ops: [{ op: 'unset', path: ['alpha', 'model'] }] } } })
})

it('shares journal ownership across separate executors using traced service contexts', async () => {
  const entered = Promise.withResolvers<undefined>()
  const resume = Promise.withResolvers<undefined>()
  const run = await runtime()
  const request = run.request({ credential: { op: 'set', ref: OLD_REF, value: NEW_KEY } })
  const entryId = await run.ctx.loader.create({ name: 'cordis:fixture-llm', isolate: { llm: true } })
  await run.ctx.loader.await()
  const entry = run.ctx.loader.resolve(entryId)
  const secondRuntime = entry.ctx.get('llm')
  if (secondRuntime === undefined) throw new Error('isolated LLM owner was not loaded')
  expect(secondRuntime.listConfigurableProviders()).toEqual([])
  secondRuntime.registerConfigurableProviders(run.ctx.llm.listConfigurableProviders())
  secondRuntime.registerAdapter(['alpha'], new FixtureAdapter(run.active().alpha))
  const set = run.ctx.credentials.set.bind(run.ctx.credentials)
  const writes = vi.spyOn(run.ctx.credentials, 'set').mockImplementation(async (ref, value, expected) => {
    entered.resolve(undefined)
    await resume.promise
    await set(ref, value, expected)
  })
  const first = run.mutate(request)
  await entered.promise
  const second = secondRuntime.remoteMutateProvider(request, new AbortController().signal)
  try { await new Promise(resolve => setTimeout(resolve, 30)) }
  finally { resume.resolve(undefined) }
  await Promise.all([first, second])
  expect(writes).toHaveBeenCalledTimes(1)
  expect(run.revision()).toBe(1)
  await entry.update({ disabled: true })
  await expect(run.ctx.settings.remoteMutate(NS, request.ops, 1))
    .rejects.toMatchObject({ failure: { code: 'settings-rejected' } })
})

it('refuses an old completed receipt while a newer journal still requires recovery', async () => {
  const run = await runtime()
  const first = run.request()
  await run.mutate(first)
  const pending = run.request({ credential: { op: 'set', ref: OLD_REF, value: NEW_KEY } })
  vi.spyOn(run.ctx.credentials, 'set').mockRejectedValueOnce(new Error('fixture staging failure'))
  await expect(run.mutate(pending)).rejects.toMatchObject({ failure: { code: 'provider-transaction-in-doubt' } })
  const entryId = await run.ctx.loader.create({ name: 'cordis:fixture-llm', isolate: { llm: true } })
  await run.ctx.loader.await()
  const entry = run.ctx.loader.resolve(entryId)
  const secondRuntime = entry.ctx.get('llm')
  if (secondRuntime === undefined) throw new Error('isolated LLM owner was not loaded')
  secondRuntime.registerConfigurableProviders(run.ctx.llm.listConfigurableProviders())
  await expect(secondRuntime.remoteMutateProvider(first, new AbortController().signal))
    .rejects.toMatchObject({ failure: { code: 'provider-transaction-in-doubt' } })
  await run.mutate(pending)
  await run.mutate(first)
})

it('lets an unrelated provider progress while another namespace waits for activation', async () => {
  const entered = Promise.withResolvers<undefined>()
  const resume = Promise.withResolvers<undefined>()
  const run = await runtime({ activation: async () => { entered.resolve(undefined); await resume.promise } })
  const independent = settingsNamespace('independent-fixture')
  const scope = run.ctx.settings.register(independent, Profile, { base: {
    baseURL: 'https://independent.invalid', apiKeyEnv: '', model: 'initial',
  } })
  run.ctx.llm.registerConfigurableProviders([{ provider: 'independent', displayName: 'Independent', settingsNs: independent, settingsPath: [] }])
  run.ctx.llm.registerAdapter(['independent'], new FixtureAdapter(scope.get()))
  const first = run.mutate()
  await entered.promise
  let completed = false
  const other = run.mutate(run.request({ provider: 'independent', settingsNs: independent, expectedRevision: 0,
    ops: [{ op: 'set', path: ['model'], value: 'independent' }] })).then((result) => { completed = true; return result })
  try {
    await vi.waitFor(() => { expect(completed).toBe(true) }, { timeout: 1000 })
    expect(scope.get().model).toBe('independent')
  } finally { resume.resolve(undefined); await Promise.all([first, other]) }
})

it('accepts reordered nested object keys after restart but rejects reordered model arrays', async () => {
  const run = await runtime()
  const request = run.request({ ops: [{ op: 'set', path: ['alpha', 'models'], value: [
    { id: 'first', contextWindow: 100 }, { id: 'second', contextWindow: 200 },
  ] }] })
  await run.mutate(request)
  await run.close()
  const reboot = await runtime({ root: run.root })
  const before = await readFile(run.settingsPath, 'utf8')
  const equivalent = [{ contextWindow: 100, id: 'first' }, { contextWindow: 200, id: 'second' }]
  await reboot.mutate({ ...request, expectedRevision: 99, ops: [{ op: 'set', path: ['alpha', 'models'], value: equivalent }] })
  expect(await readFile(run.settingsPath, 'utf8')).toBe(before)
  await expect(reboot.mutate({ ...request, ops: [{ op: 'set', path: ['alpha', 'models'], value: [...equivalent].reverse() }] }))
    .rejects.toMatchObject({ failure: { code: 'provider-transaction-in-doubt' } })
})

it('resumes a staged journal with equivalent reordered object keys', async () => {
  const run = await runtime()
  const request = run.request({ ops: [{ op: 'set', path: ['alpha', 'models'], value: [{ id: 'fixture', contextWindow: 100 }] }],
    credential: { op: 'set', ref: OLD_REF, value: NEW_KEY } })
  vi.spyOn(run.ctx.credentials, 'set').mockRejectedValueOnce(new Error('fixture staging failure'))
  await expect(run.mutate(request)).rejects.toMatchObject({ failure: { code: 'provider-transaction-in-doubt' } })
  await run.mutate({ ...request, expectedRevision: 99,
    ops: [{ op: 'set', path: ['alpha', 'models'], value: [{ contextWindow: 100, id: 'fixture' }] }] })
  expect(run.active().alpha.models).toEqual([{ id: 'fixture', contextWindow: 100 }])
})

it('pins the retained version-1 fixture bytes before exercising the compatibility parser', async () => {
  const bytes = await readFile(new URL('./fixtures/legacy-v1-journals.json', import.meta.url))
  expect(createHash('sha256').update(bytes).digest('hex')).toBe('0c470f13fde482852e6ed683b426b426e99929b40c060996182f831212cbab3d')
  expect(legacySamples.journals).toHaveLength(8)
})

it.each(legacySamples.journals.map((sample, index) => ({ index, sample })))('reads and reconciles frozen v1 phase $index without changing its input', async ({ index, sample }) => {
  const options = { namespace: 'legacy-fixture', baseAlpha: { baseURL: 'https://alpha.invalid/v1', apiKeyEnv: '', model: 'initial' } }
  const run = await runtime(options)
  const ns = settingsNamespace(options.namespace)
  const committedProfile = index === 1 || index === 2 || index >= 5
  if (index > 0) await run.ctx.settings.update(ns, { alpha: { model: 'fixture-model' } })
  if (index >= 5) await run.ctx.settings.update(ns, { alpha: { apiKeyEnv: 'ARK_SYNTHETIC_LEGACY' } })
  if (index >= 4) await run.ctx.credentials.set(credentialRef('ARK_SYNTHETIC_LEGACY'), 'synthetic-oracle-only-value')
  await run.ctx.credentials.modifyRecord(JOURNAL, () => Promise.resolve({ kind: 'grant', payload: sample.payload }))
  await run.close()
  const reboot = await runtime({ ...options, root: run.root })
  const request = { provider: 'alpha', transactionId: sample.payload.transactionId }
  const credentialBefore = await readFile(run.credentialPath, 'utf8')
  const state = await reboot.ctx.llm.remoteProviderTransaction(request)
  expect(state.state).toBe(sample.payload.phase === 'done' ? 'committed' : sample.payload.phase)
  expect(state.settingsNs).toBe('legacy-fixture')
  await reboot.ctx.llm.remoteProviderTransaction(request)
  expect(await readFile(run.credentialPath, 'utf8')).toBe(credentialBefore)
  const settingsBefore = reboot.ctx.settings.describe().find(entry => entry.ns === ns)!.user
  if (committedProfile) {
    await reboot.ctx.llm.remoteResumeProvider(request, new AbortController().signal)
    expect(await reboot.ctx.llm.remoteProviderTransaction(request)).toMatchObject({ state: 'committed', needsCredential: false })
    await reboot.ctx.llm.remoteResumeProvider(request, new AbortController().signal)
  } else {
    // A legacy plan has no persisted before-image digest: recovery must not guess across a restart.
    await expect(reboot.ctx.llm.remoteResumeProvider(request, new AbortController().signal))
      .rejects.toMatchObject({ failure: { code: 'settings-rejected' } })
    expect(await reboot.ctx.llm.remoteProviderTransaction(request)).toMatchObject({ state: 'rolled-back' })
  }
  expect(reboot.ctx.settings.describe().find(entry => entry.ns === ns)!.user).toEqual(settingsBefore)
  expect(await reboot.ctx.credentials.readRecord(JOURNAL)).toMatchObject({ kind: 'grant', payload: { version: 1, receiptVersion: 1, phase: 'done' } })
  expect(JSON.stringify(await reboot.ctx.credentials.readRecord(JOURNAL))).not.toContain('synthetic-oracle-only-value')
})

it('resumes a current transaction after revision reset using its persisted before-image digest', async () => {
  const run = await runtime()
  await run.mutate()
  const request = run.request({ ops: [{ op: 'set', path: ['alpha', 'model'], value: 'after-restart' }],
    credential: { op: 'set', ref: OLD_REF, value: NEW_KEY } })
  vi.spyOn(run.ctx.credentials, 'set').mockRejectedValueOnce(new Error('fixture interruption before staging'))
  await expect(run.mutate(request)).rejects.toMatchObject({ failure: { code: 'provider-transaction-in-doubt' } })
  await run.close()
  const reboot = await runtime({ root: run.root })
  const identity = { provider: request.provider, transactionId: request.transactionId }
  expect(await reboot.ctx.llm.remoteProviderTransaction(identity)).toMatchObject({ state: 'prepared', needsCredential: true })
  await expect(reboot.ctx.llm.remoteResumeProvider(identity, new AbortController().signal))
    .rejects.toMatchObject({ failure: { code: 'provider-transaction-needs-credential' } })
  await reboot.ctx.llm.remoteResumeProvider({ ...identity, credentialValue: NEW_KEY }, new AbortController().signal)
  expect(reboot.active().alpha.model).toBe('after-restart')
  expect(await reboot.ctx.llm.remoteProviderTransaction(identity)).toMatchObject({ state: 'committed', live: true })
  const before = await readFile(run.credentialPath, 'utf8')
  await reboot.ctx.llm.remoteResumeProvider(identity, new AbortController().signal)
  expect(await readFile(run.credentialPath, 'utf8')).toBe(before)
})

it('refuses changed persisted settings during recovery without overwriting them', async () => {
  const run = await runtime()
  const request = run.request({ credential: { op: 'set', ref: OLD_REF, value: NEW_KEY } })
  vi.spyOn(run.ctx.credentials, 'set').mockRejectedValueOnce(new Error('fixture interruption'))
  await expect(run.mutate(request)).rejects.toMatchObject({ failure: { code: 'provider-transaction-in-doubt' } })
  await run.close()
  await writeFile(run.settingsPath, JSON.stringify({ [NS]: { alpha: { model: 'newer-external-value' } } }))
  const reboot = await runtime({ root: run.root })
  const before = await readFile(run.settingsPath, 'utf8')
  await expect(reboot.ctx.llm.remoteResumeProvider({ provider: 'alpha', transactionId: request.transactionId, credentialValue: NEW_KEY }, new AbortController().signal))
    .rejects.toMatchObject({ failure: { code: 'settings-rejected' } })
  expect(await readFile(run.settingsPath, 'utf8')).toBe(before)
})

it('does not overwrite an unobserved on-disk edit while a normal settings mutation persists', async () => {
  const run = await runtime()
  await run.ctx.settings.update(NS, { alpha: { model: 'before' } })
  const before = JSON.stringify({ [NS]: { alpha: { model: 'external' } } })
  await writeFile(run.settingsPath, before)
  await expect(run.ctx.settings.update(NS, { alpha: { model: 'stale' } })).rejects.toThrow('changed on disk')
  expect(await readFile(run.settingsPath, 'utf8')).toBe(before)
})

it.each([
  { version: 2 }, { digest: 'invalid' }, { phase: 'restoring' }, { plan: null },
  { provider: 'wrong-provider' }, { settingsNs: 'INVALID' }, { transactionId: 'invalid' },
  { receiptVersion: 3 }, { unknown: 'fixture-secret-marker' },
])('refuses malformed legacy metadata without changing storage: %j', async (patch) => {
  const run = await runtime({ namespace: 'legacy-fixture' })
  const original = legacySamples.journals[0]!.payload
  await run.ctx.credentials.modifyRecord(JOURNAL, () => Promise.resolve({ kind: 'grant', payload: { ...original, ...patch } }))
  const before = await readFile(run.credentialPath, 'utf8')
  await expect(run.ctx.llm.remoteProviderTransaction({ provider: 'alpha', transactionId: original.transactionId }))
    .rejects.toMatchObject({ failure: { code: 'provider-transaction-in-doubt' } })
  expect(await readFile(run.credentialPath, 'utf8')).toBe(before)
})

it('refuses a forged before-image in an old journal whose digest cannot bind it', async () => {
  const run = await runtime({ namespace: 'legacy-fixture' })
  const original = legacySamples.journals[0]!.payload
  await run.ctx.credentials.modifyRecord(JOURNAL, () => Promise.resolve({ kind: 'grant', payload: {
    ...original, plan: { ...original.plan, expectedUserDigest: createHash('sha256').update('{}').digest('hex') },
  } }))
  await expect(run.ctx.llm.remoteResumeProvider({ provider: 'alpha', transactionId: original.transactionId }, new AbortController().signal))
    .rejects.toMatchObject({ failure: { code: 'provider-transaction-in-doubt' } })
  expect(run.revision()).toBe(0)
})

it('projects a legacy terminal failure without copying its unsafe diagnostics into the current journal', async () => {
  const run = await runtime({ namespace: 'legacy-fixture' })
  const original = legacySamples.journals[2]!.payload
  await run.ctx.credentials.modifyRecord(JOURNAL, () => Promise.resolve({ kind: 'grant', payload: {
    ...original, outcome: 'rolled-back', error: { code: 'settings-rejected', message: 'fixture-secret-marker',
      details: { ns: 'legacy-fixture', apiKey: 'fixture-secret-marker' } },
  } }))
  const identity = { provider: 'alpha', transactionId: original.transactionId }
  expect(JSON.stringify(await run.ctx.llm.remoteProviderTransaction(identity))).not.toContain('fixture-secret-marker')
  await expect(run.ctx.llm.remoteResumeProvider(identity, new AbortController().signal))
    .rejects.toMatchObject({ failure: { code: 'settings-rejected', message: 'provider settings write was rejected' } })
  const normalized = await run.ctx.credentials.readRecord(JOURNAL)
  expect(normalized).toMatchObject({ payload: { receiptVersion: 1, outcome: 'rolled-back' } })
  expect(JSON.stringify(normalized)).not.toContain('fixture-secret-marker')
})

it('shares one recovery executor across simultaneous resume calls', async () => {
  const run = await runtime()
  const request = run.request({ credential: { op: 'set', ref: OLD_REF, value: NEW_KEY } })
  const set = vi.spyOn(run.ctx.credentials, 'set').mockRejectedValueOnce(new Error('fixture interruption'))
  await expect(run.mutate(request)).rejects.toMatchObject({ failure: { code: 'provider-transaction-in-doubt' } })
  const resume = () => run.ctx.llm.remoteResumeProvider({ provider: 'alpha', transactionId: request.transactionId, credentialValue: NEW_KEY }, new AbortController().signal)
  await Promise.all([resume(), resume(), resume()])
  expect(set).toHaveBeenCalledTimes(2)
  expect(run.revision()).toBe(1)
})

it('keeps an old restore from reapplying changes after a newer provider transaction', async () => {
  const run = await runtime()
  const old = run.request()
  await run.mutate(old)
  await run.mutate(run.request({ ops: [{ op: 'set', path: ['alpha', 'model'], value: 'newer' }] }))
  const before = await readFile(run.settingsPath, 'utf8')
  await run.ctx.llm.remoteResumeProvider({ provider: 'alpha', transactionId: old.transactionId }, new AbortController().signal)
  expect(run.active().alpha.model).toBe('newer')
  expect(await readFile(run.settingsPath, 'utf8')).toBe(before)
})

it('does not recreate a journal removed between recovery read and claim', async () => {
  const run = await runtime()
  const request = run.request({ credential: { op: 'set', ref: OLD_REF, value: NEW_KEY } })
  vi.spyOn(run.ctx.credentials, 'set').mockRejectedValueOnce(new Error('fixture interruption'))
  await expect(run.mutate(request)).rejects.toMatchObject({ failure: { code: 'provider-transaction-in-doubt' } })
  const resolve = run.ctx.credentials.resolve.bind(run.ctx.credentials)
  let removed = false
  vi.spyOn(run.ctx.credentials, 'resolve').mockImplementation(async (ref) => {
    if (!removed) { removed = true; await run.ctx.credentials.deleteRecord(JOURNAL) }
    return resolve(ref)
  })
  await expect(run.ctx.llm.remoteResumeProvider({ provider: 'alpha', transactionId: request.transactionId, credentialValue: NEW_KEY }, new AbortController().signal))
    .rejects.toMatchObject({ failure: { code: 'provider-transaction-in-doubt' } })
  expect(await run.ctx.credentials.readRecord(JOURNAL)).toBeUndefined()
  expect(run.revision()).toBe(0)
})

it('cancels recovery before claim without changing its journal', async () => {
  const run = await runtime()
  const request = run.request({ credential: { op: 'set', ref: OLD_REF, value: NEW_KEY } })
  vi.spyOn(run.ctx.credentials, 'set').mockRejectedValueOnce(new Error('fixture interruption'))
  await expect(run.mutate(request)).rejects.toMatchObject({ failure: { code: 'provider-transaction-in-doubt' } })
  const before = await readFile(run.credentialPath, 'utf8')
  await expect(run.ctx.llm.remoteResumeProvider({ provider: 'alpha', transactionId: request.transactionId, credentialValue: NEW_KEY }, AbortSignal.abort()))
    .rejects.toMatchObject({ failure: { code: 'cancelled' } })
  expect(await readFile(run.credentialPath, 'utf8')).toBe(before)
})

it('does not normalize a terminal legacy journal after cancellation while waiting for its namespace', async () => {
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const run = await runtime({ namespace: 'legacy-fixture', activation: async () => { entered.resolve(undefined); await release.promise } })
  const legacy = { kind: 'grant' as const, payload: legacySamples.journals[2]!.payload }
  await run.ctx.credentials.modifyRecord(JOURNAL, async () => legacy)
  run.ctx.llm.registerAdapter(['beta'], new FixtureAdapter(run.active().beta))
  const beta = run.mutate(run.request({ provider: 'beta', ops: [{ op: 'set', path: ['beta', 'model'], value: 'changed' }] }))
  await entered.promise
  const read = vi.spyOn(run.ctx.credentials, 'readRecord')
  const cancellation = new AbortController()
  const resume = run.ctx.llm.remoteResumeProvider({ provider: 'alpha', transactionId: legacy.payload.transactionId }, cancellation.signal)
  const outcome = expect(resume).rejects.toMatchObject({ failure: { code: 'cancelled' } })
  try {
    await vi.waitFor(() => { expect(read).toHaveBeenCalledWith(JOURNAL) })
    cancellation.abort()
  } finally { release.resolve(undefined) }
  await Promise.all([beta, outcome])
  expect(await run.ctx.credentials.readRecord(JOURNAL)).toEqual(legacy)
})

it('drains claimed recovery on shutdown and records persisted-but-not-live instead of false activation', async () => {
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const run = await runtime({ activation: async () => { entered.resolve(undefined); await release.promise } })
  const request = run.request({ credential: { op: 'set', ref: OLD_REF, value: NEW_KEY } })
  vi.spyOn(run.ctx.credentials, 'set').mockRejectedValueOnce(new Error('fixture interruption'))
  await expect(run.mutate(request)).rejects.toMatchObject({ failure: { code: 'provider-transaction-in-doubt' } })
  const llm = run.ctx.llm
  const cancellation = new AbortController()
  const restore = llm.remoteResumeProvider({ provider: 'alpha', transactionId: request.transactionId, credentialValue: NEW_KEY }, cancellation.signal)
  const outcome = restore.then(value => ({ value }), (error: unknown) => ({ error }))
  await entered.promise
  cancellation.abort()
  const entry = [...run.ctx.loader.entries()].find(candidate => candidate.options.name === 'cordis:fixture-llm')
  if (entry === undefined) throw new Error('LLM fixture entry is missing')
  let disposed = false
  const retiring = entry.update({ disabled: true }).then(() => { disposed = true })
  try {
    await vi.waitFor(async () => {
      await expect(llm.remoteProviderTransaction({ provider: 'alpha', transactionId: request.transactionId }))
        .rejects.toMatchObject({ failure: { code: 'service-unavailable' } })
    })
    expect(disposed).toBe(false)
  } finally { release.resolve(undefined) }
  expect(await outcome).toMatchObject({ error: { failure: { code: 'settings-rejected' } } })
  await retiring
  expect(disposed).toBe(true)
  expect(await run.ctx.credentials.readRecord(JOURNAL)).toMatchObject({ payload: { phase: 'done', outcome: 'committed-not-live' } })
})

it.each(['truncated', 'malformed-middle'] as const)('refuses a %s credential document instead of booting an empty store', async (kind) => {
  const run = await runtime()
  await run.close()
  const valid = { kind: 'grant', payload: legacySamples.journals[2]!.payload }
  const document = kind === 'truncated'
    ? JSON.stringify({ version: 1, refs: {}, records: { 'llm-remote/alpha': valid } }).slice(0, -12)
    : JSON.stringify({ version: 1, refs: {}, records: {
      'llm-remote/alpha': valid, 'llm-remote/broken': { kind: 'unknown', payload: 'fixture-secret-marker' },
      'llm-remote/after': valid,
    } })
  await writeFile(run.credentialPath, document, { mode: 0o600 })
  await expect(runtime({ root: run.root })).rejects.toThrow()
  expect(await readFile(run.credentialPath, 'utf8')).toBe(document)
})
