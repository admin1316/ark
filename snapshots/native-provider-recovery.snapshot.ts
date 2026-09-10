import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { TypertRemoteFailure } from '@deepseek-ai/dsh-typert-protocol'
import { createProviderRuntime, PROVIDER_TEST_REF } from '../packages/llm/llm/tests/provider-runtime.ts'
import type { RemoteLlmProviderTransactionResult } from '@deepseek-ai/dsh-llm/types'

it('projects native provider status, explicit recovery and restart from one real Loader composition', async () => {
  const run = await createProviderRuntime()
  const identity = { provider: 'alpha', transactionId: '44444444-4444-4444-8444-444444444444' }
  const observed: RemoteLlmProviderTransactionResult[] = []
  const observations: Promise<void>[] = []
  try {
    const absent = await run.ctx.llm.remoteProviderTransaction(identity)
    await run.ctx.credentials.set(PROVIDER_TEST_REF, 'snapshot-original-secret')
    const dispose = run.ctx.on('credentials/record-updated', () => {
      observations.push(run.ctx.llm.remoteProviderTransaction(identity).then((state) => { observed.push(state) }))
    })
    const result = await run.mutate(run.request({ ...identity,
      ops: [{ op: 'set', path: ['alpha', 'model'], value: 'snapshot-model' }],
      credential: { op: 'set', ref: PROVIDER_TEST_REF, value: 'snapshot-new-secret' },
    }))
    await Promise.all(observations)
    dispose()
    const credentialsBefore = await readFile(run.credentialPath, 'utf8')
    await Promise.all([run.ctx.llm.remoteResumeProvider(identity, new AbortController().signal),
      run.ctx.llm.remoteResumeProvider(identity, new AbortController().signal)])
    const duplicateDidNotWrite = credentialsBefore === await readFile(run.credentialPath, 'utf8')
    let staleCode: string | undefined
    try { await run.mutate(run.request({ expectedRevision: 0 })) }
    catch (error) {
      if (!(error instanceof TypertRemoteFailure)) throw error
      staleCode = error.failure.code
    }
    const oldCredentialPreserved = (await run.ctx.credentials.resolve(PROVIDER_TEST_REF))?.value === 'snapshot-original-secret'
    const newCredentialConfigured = (await run.ctx.credentials.describe(credentialRef(run.active().alpha.apiKeyEnv))).configured
    await run.close()
    const reboot = await createProviderRuntime({ root: run.root })
    try {
      const restarted = await reboot.ctx.llm.remoteProviderTransaction(identity)
      const recovered = await reboot.ctx.llm.remoteResumeProvider(identity, new AbortController().signal)
      const transcript = { absent, observed, saved: { ns: result.settings.ns, revision: result.settings.revision,
        value: result.settings.value, user: result.settings.user, secrets: result.settings.secrets },
      oldCredentialPreserved, newCredentialConfigured, duplicateDidNotWrite, staleCode, restarted,
      recovered: { ns: recovered.settings.ns, value: recovered.settings.value, user: recovered.settings.user } }
      expect(JSON.stringify(transcript)).not.toContain('snapshot-original-secret')
      expect(JSON.stringify(transcript)).not.toContain('snapshot-new-secret')
      expect(transcript).toMatchSnapshot()
    } finally { await reboot.dispose() }
  } finally { await run.dispose() }
})

it('reports a concurrent credential replacement without deleting it or acknowledging live success', async () => {
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const run = await createProviderRuntime({ activation: async () => { entered.resolve(undefined); await release.promise } })
  const identity = { provider: 'alpha', transactionId: '55555555-5555-4555-8555-555555555555' }
  try {
    await run.ctx.credentials.set(PROVIDER_TEST_REF, 'snapshot-original-secret')
    const operation = run.mutate(run.request({ ...identity,
      ops: [{ op: 'set', path: ['alpha', 'apiKeyEnv'], value: '' }],
      credential: { op: 'unset', ref: PROVIDER_TEST_REF },
    })).then(() => 'unexpected-success', (error: unknown) => {
      if (!(error instanceof TypertRemoteFailure)) throw error
      return error.failure
    })
    await entered.promise
    await run.ctx.credentials.set(PROVIDER_TEST_REF, 'snapshot-concurrent-secret')
    release.resolve(undefined)
    const failure = await operation
    const state = await run.ctx.llm.remoteProviderTransaction(identity)
    const concurrentCredentialPreserved = (await run.ctx.credentials.resolve(PROVIDER_TEST_REF))?.value === 'snapshot-concurrent-secret'
    expect({ failure, state, concurrentCredentialPreserved, activeReference: run.active().alpha.apiKeyEnv }).toMatchSnapshot()
  } finally { release.resolve(undefined); await run.dispose() }
})
