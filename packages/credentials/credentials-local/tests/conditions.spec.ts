import { Context } from '@deepseek-ai/cordis'
import { credentialCondition, credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'
import { createLaunchEnvironmentSnapshot, DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { LocalCredentialProvider } from '../src/index.ts'

const REF = credentialRef('ARK_SYNTHETIC_CONDITION')
const KEY = credentialKey('fixture', 'transaction')
const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function boot(path?: string) {
  if (path === undefined) {
    const root = await mkdtemp(join(tmpdir(), 'ark-credential-condition-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    path = join(root, 'credentials.yaml')
  }
  const ctx = new Context()
  ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([{ source: 'process', values: {} }]))
  await ctx.plugin(LocalCredentialProvider, { path, watch: false })
  cleanups.push(() => ctx.fiber.dispose())
  return { credentials: ctx.credentials, path }
}

it('checks absence, digest and source before changing the managed reference', async () => {
  const { credentials } = await boot()
  await credentials.set(REF, 'synthetic-first', { valueDigest: null })
  const expected = credentialCondition(await credentials.resolve(REF))
  await expect(credentials.set(REF, 'synthetic-other', { valueDigest: null }))
    .rejects.toMatchObject({ name: 'CredentialConflictError' })
  await expect(credentials.unset(REF, { ...expected, source: 'keychain' }))
    .rejects.toMatchObject({ name: 'CredentialConflictError' })
  await credentials.set(REF, 'synthetic-next', expected)
  await expect(credentials.unset(REF, expected)).rejects.toMatchObject({ name: 'CredentialConflictError' })
  await credentials.unset(REF, credentialCondition(await credentials.resolve(REF)))
  await credentials.unset(REF, { valueDigest: null })
  expect(await credentials.resolve(REF)).toBeUndefined()
})

it('reconciles another owner under the file lock before conditional writes and record commits', async () => {
  const first = await boot()
  const second = await boot(first.path)
  await first.credentials.set(REF, 'synthetic-first')
  const expected = credentialCondition(await first.credentials.resolve(REF))
  await second.credentials.set(REF, 'synthetic-winner')
  const bytes = await readFile(first.path, 'utf8')
  await expect(first.credentials.unset(REF, expected)).rejects.toMatchObject({ name: 'CredentialConflictError' })
  const mutate = vi.fn(async () => ({ kind: 'grant' as const, payload: { committed: true } }))
  await expect(first.credentials.modifyRecord(KEY, mutate, [{ ref: REF, expected }]))
    .rejects.toMatchObject({ name: 'CredentialConflictError' })
  expect(mutate).not.toHaveBeenCalled()
  expect(await readFile(first.path, 'utf8')).toBe(bytes)
})

it('holds reference exclusion through a checked record commit, including another document owner', async () => {
  const first = await boot()
  const second = await boot(first.path)
  await first.credentials.set(REF, 'synthetic-first')
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const record = first.credentials.modifyRecord(KEY, async () => {
    entered.resolve(undefined)
    await release.promise
    expect(await first.credentials.resolve(REF)).toMatchObject({ value: 'synthetic-first' })
    return { kind: 'grant', payload: { committed: true } }
  }, [{ ref: REF, expected: credentialCondition(await first.credentials.resolve(REF)) }])
  await entered.promise
  const local = first.credentials.set(REF, 'synthetic-local')
  const external = second.credentials.set(REF, 'synthetic-other')
  release.resolve(undefined)
  await Promise.all([record, local, external])
  expect(await first.credentials.readRecord(KEY)).toMatchObject({ payload: { committed: true } })
})

it('captures conditions before queued callers can change their objects', async () => {
  const { credentials } = await boot()
  await credentials.set(REF, 'synthetic-first')
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const holder = credentials.modifyRecord(KEY, async () => {
    entered.resolve(undefined)
    await release.promise
    return undefined
  })
  await entered.promise
  const expected = credentialCondition(await credentials.resolve(REF))
  const record = credentials.modifyRecord(KEY, async () => ({ kind: 'grant', payload: true }), [{ ref: REF, expected }])
  const unset = credentials.unset(REF, expected)
  expected.valueDigest = null
  release.resolve(undefined)
  await Promise.all([holder, record, unset])
  expect(await credentials.resolve(REF)).toBeUndefined()
  expect(await credentials.readRecord(KEY)).toEqual({ kind: 'grant', payload: true })
})
