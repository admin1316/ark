import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'
import { createProviderRuntime, PROVIDER_TEST_REF } from '../provider-runtime.ts'
import { TypertRemoteFailure } from '@deepseek-ai/dsh-typert-protocol'
import legacySamples from './legacy-v1-journals.json' with { type: 'json' }

const transactionId = '33333333-3333-4333-8333-333333333333'
const oldValue = 'fixture-process-old-secret'
const nextValue = 'fixture-process-next-secret'

async function main() {
  for (const owner of ['@deepseek-ai/dsh-credentials', '@deepseek-ai/dsh-credentials-local',
    '@deepseek-ai/dsh-settings', '@deepseek-ai/dsh-settings-file', '@deepseek-ai/cordis-plugin-loader']) {
    if (!import.meta.resolve(owner).endsWith('/src/index.ts')) throw new Error('process fixture requires source-owned services')
  }
  const [root, mode, phase] = process.argv.slice(2)
  if (root === undefined || (mode !== 'start' && mode !== 'resume' && mode !== 'legacy-start' && mode !== 'legacy-resume')) {
    throw new Error('invalid fixture invocation')
  }
  const legacy = mode.startsWith('legacy-')
  const run = await createProviderRuntime({ root, ...legacy ? {
    namespace: 'legacy-fixture', baseAlpha: { baseURL: 'https://alpha.invalid/v1', apiKeyEnv: '', model: 'initial' },
  } : {} })
  try {
    if (legacy) {
      const index = Number(phase)
      const sample = legacySamples.journals[index]
      if (!Number.isInteger(index) || sample === undefined) throw new Error('invalid legacy fixture index')
      const identity = { provider: 'alpha', transactionId: sample.payload.transactionId }
      if (mode === 'legacy-start') {
        if (index > 0) await run.ctx.settings.update(run.namespace, { alpha: { model: 'fixture-model' } })
        if (index >= 5) await run.ctx.settings.update(run.namespace, { alpha: { apiKeyEnv: 'ARK_SYNTHETIC_LEGACY' } })
        if (index >= 4) await run.ctx.credentials.set(credentialRef('ARK_SYNTHETIC_LEGACY'), 'synthetic-oracle-only-value')
        await run.ctx.credentials.modifyRecord(credentialKey('llm-remote', 'alpha'),
          () => Promise.resolve({ kind: 'grant', payload: sample.payload }))
        await new Promise<void>((resolve) => {
          process.once('message', () => { resolve() })
          process.send?.({ event: 'paused', phase })
        })
        throw new Error('legacy fixture unexpectedly continued')
      }
      const storedBefore = run.ctx.settings.describe().find(entry => entry.ns === run.namespace)?.user
      const before = await run.ctx.llm.remoteProviderTransaction(identity)
      let failureCode: string | undefined
      try { await run.ctx.llm.remoteResumeProvider(identity, new AbortController().signal) }
      catch (error) {
        if (!(error instanceof TypertRemoteFailure)) throw error
        failureCode = error.failure.code
      }
      const after = await run.ctx.llm.remoteProviderTransaction(identity)
      const storedAfter = run.ctx.settings.describe().find(entry => entry.ns === run.namespace)?.user
      const record = await run.ctx.credentials.readRecord(credentialKey('llm-remote', 'alpha'))
      if (record?.kind !== 'grant' || record.payload === null || typeof record.payload !== 'object'
        || !('receiptVersion' in record.payload) || record.payload.receiptVersion !== 1) throw new Error('legacy fixture was not normalized')
      process.send?.({ event: 'legacy-result', before, after, failureCode,
        normalized: true, settingsUnchanged: JSON.stringify(storedBefore) === JSON.stringify(storedAfter) })
      return
    }
    if (mode === 'start') {
      await run.ctx.credentials.set(PROVIDER_TEST_REF, oldValue)
      await run.mutate()
      const modify = run.ctx.credentials.modifyRecord.bind(run.ctx.credentials)
      run.ctx.credentials.modifyRecord = async (key, callback, references) => {
        const result = await modify(key, callback, references)
        if (result?.kind === 'grant' && result.payload !== null && typeof result.payload === 'object'
          && 'phase' in result.payload && result.payload.phase === phase) {
          // modifyRecord returned: the durable write and its file-lock release both completed.
          await new Promise<void>((resolve) => {
            process.once('message', () => { resolve() })
            process.send?.({ event: 'paused', phase })
          })
        }
        return result
      }
      await run.mutate(run.request({ transactionId, ops: [
        { op: 'set', path: ['alpha', 'model'], value: 'process-recovered' },
        { op: 'set', path: ['alpha', 'baseURL'], value: 'https://process-fixture.invalid/v1' },
      ], credential: { op: 'set', ref: PROVIDER_TEST_REF, value: nextValue } }))
      throw new Error('fixture did not pause at the selected durable phase')
    }
    let credentialWrites = 0
    let settingsWrites = 0
    const set = run.ctx.credentials.set.bind(run.ctx.credentials)
    run.ctx.credentials.set = async (ref, value, expected) => { credentialWrites++; await set(ref, value, expected) }
    const mutate = run.ctx.settings.mutate.bind(run.ctx.settings)
    run.ctx.settings.mutate = async (ns, ops, revision) => { settingsWrites++; await mutate(ns, ops, revision) }
    const identity = { provider: 'alpha', transactionId }
    const before = await run.ctx.llm.remoteProviderTransaction(identity)
    await run.ctx.llm.remoteResumeProvider({ ...identity, credentialValue: nextValue }, new AbortController().signal)
    const after = await run.ctx.llm.remoteProviderTransaction(identity)
    const profile = run.active().alpha
    const journal = await run.ctx.credentials.readRecord(credentialKey('llm-remote', 'alpha'))
    if (JSON.stringify(journal).includes(nextValue)) throw new Error('fixture journal leaked a secret')
    const result = { event: 'result', before, after, model: profile.model, baseURL: profile.baseURL,
      credentialRef: profile.apiKeyEnv,
      credentialConfigured: (await run.ctx.credentials.describe(credentialRef(profile.apiKeyEnv))).configured,
      oldCredentialPreserved: (await run.ctx.credentials.resolve(PROVIDER_TEST_REF))?.value === oldValue,
      credentialWrites, settingsWrites,
      settingsHash: createHash('sha256').update(await readFile(run.settingsPath)).digest('hex'),
      credentialHash: createHash('sha256').update(await readFile(run.credentialPath)).digest('hex'),
    }
    process.send?.(result)
  } finally { await run.close(); if (process.connected) process.disconnect() }
}

main().catch(() => {
  process.send?.({ event: 'fixture-error' })
  process.exitCode = 1
  if (process.connected) process.disconnect()
})
