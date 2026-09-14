import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { CredentialInfo } from '@deepseek-ai/dsh-credentials/types'
import { TypertLookupFailure, remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'

/** A store whose `describe` carries more than the view declares, as a foreign provider might. */
class LeakyCredentials extends MemoryCredentials {
  override describe(): Promise<CredentialInfo> {
    return Promise.resolve(
      { configured: true, source: 'memory', writable: true, value: 'sk-leaked' } as CredentialInfo,
    )
  }
}

/** A store whose write rejects with a bare string, the way some client libraries do. */
class LiteralRejectingCredentials extends MemoryCredentials {
  override async set(): Promise<void> {
    throw 'the store refused'
  }
}

/** A store whose provider-owned policy rejects an otherwise valid write. */
class RejectingCredentials extends MemoryCredentials {
  override set(): Promise<void> {
    return Promise.reject(new Error('a read-only source shadows this reference'))
  }
}

async function boot(
  seed: Record<string, string> = {},
  provider: typeof MemoryCredentials = MemoryCredentials,
): Promise<CredentialProvider> {
  const ctx = new Context()
  await ctx.plugin(provider, seed)
  return ctx.credentials
}

describe('the credentials Remote namespace a configuration surface calls', () => {
  it('publishes the credentials namespace from its own service key', async () => {
    const controller = await boot()
    const binding = controller.typertRemote
    expect(binding.serviceKey).toBe('credentials')
    expect(binding.namespace).toBe('credentials')
    expect(remoteMethods(controller).map(method => method.exportName)).toEqual(['describe', 'set', 'unset'])
  })

  it('describes a batch of references as one map, values excluded', async () => {
    const controller = await boot({ DEEPSEEK_API_KEY: 'sk-seeded' })
    const { credentials: described } = await controller.remoteDescribe(['DEEPSEEK_API_KEY', 'OPENAI_API_KEY'])
    expect(described).toEqual({
      DEEPSEEK_API_KEY: { configured: true, source: 'memory', writable: true },
      OPENAI_API_KEY: { configured: false, writable: true },
    })
    expect(JSON.stringify(described)).not.toContain('sk-seeded')
  })

  it('reports an invalid reference as input-invalid', async () => {
    const controller = await boot()
    const read = vi.spyOn(controller, 'describe')
    for (const call of [
      () => controller.remoteDescribe(['DEEPSEEK_API_KEY', 'not a var']),
      () => controller.remoteSet('not a var', 'sk-live'),
      () => controller.remoteUnset('not a var'),
    ]) {
      const failure = await call().catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(TypertLookupFailure)
      expect((failure as TypertLookupFailure)).toMatchObject({ code: 'input-invalid' })
    }
    expect(read).not.toHaveBeenCalled()
  })

  it('answers the largest batch it accepts and reports one reference more as input-invalid', async () => {
    const controller = await boot()
    const accepted = Array.from({ length: 64 }, (_unused, index) => `REF_${String(index)}`)
    expect(Object.keys((await controller.remoteDescribe(accepted)).credentials)).toHaveLength(64)
    const read = vi.spyOn(controller, 'describe')
    const failure = await controller.remoteDescribe([...accepted, 'REF_64']).catch((error: unknown) => error)
    expect((failure as TypertLookupFailure)).toMatchObject({ code: 'input-invalid' })
    expect(read).not.toHaveBeenCalled()
  })

  it('answers only the fields the view declares, whatever a provider returns', async () => {
    const controller = await boot({}, LeakyCredentials)
    const { credentials: described } = await controller.remoteDescribe(['DEEPSEEK_API_KEY'])
    expect(described.DEEPSEEK_API_KEY).toEqual({ configured: true, source: 'memory', writable: true })
    expect(JSON.stringify(described)).not.toContain('sk-leaked')
  })

  it('stores and removes through the same references the batch describes', async () => {
    const controller = await boot()
    await controller.remoteSet('DEEPSEEK_API_KEY', 'sk-live')
    expect((await controller.remoteDescribe(['DEEPSEEK_API_KEY'])).credentials)
      .toEqual({ DEEPSEEK_API_KEY: { configured: true, source: 'memory', writable: true } })
    await controller.remoteUnset('DEEPSEEK_API_KEY')
    expect((await controller.remoteDescribe(['DEEPSEEK_API_KEY'])).credentials)
      .toEqual({ DEEPSEEK_API_KEY: { configured: false, writable: true } })
  })

  it('reports a refused write as credential-rejected naming only the reference', async () => {
    const controller = await boot({}, RejectingCredentials)
    const failure = await controller.remoteSet('DEEPSEEK_API_KEY', 'sk-live').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(TypertLookupFailure)
    expect(failure).toMatchObject({ failure: {
      code: 'credential-rejected', message: 'credential "DEEPSEEK_API_KEY" was rejected',
      details: { ref: 'DEEPSEEK_API_KEY' },
    } })
  })

  it('rejects an empty value before calling the provider', async () => {
    const controller = await boot()
    const write = vi.spyOn(controller, 'set')
    const failure = await controller.remoteSet('DEEPSEEK_API_KEY', '').catch((error: unknown) => error)
    expect((failure as TypertLookupFailure)).toMatchObject({ code: 'credential-rejected' })
    expect(write).not.toHaveBeenCalled()
  })

  it('sanitizes a refusal that is not an Error', async () => {
    const controller = await boot({}, LiteralRejectingCredentials)
    const failure = await controller.remoteSet('DEEPSEEK_API_KEY', 'sk-live').catch((error: unknown) => error)
    expect(failure).toMatchObject({ failure: { message: 'credential "DEEPSEEK_API_KEY" was rejected' } })
  })
})
