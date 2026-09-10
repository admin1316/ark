import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { remoteMethods, type RemoteMethodMarker } from '@deepseek-ai/dsh-typert-protocol'
import { MemoryCredentials } from './memory.ts'

async function boot(seed: Record<string, string> = {}) {
  const ctx = new Context()
  await ctx.plugin(MemoryCredentials, seed)
  return ctx.credentials as MemoryCredentials
}

describe('credentials Native Remote owner', () => {
  it('exports describe/set/unset and never returns a secret value', async () => {
    const credentials = await boot({ DEMO_KEY: 'hidden-value' })
    expect(remoteMethods(credentials).map((entry: RemoteMethodMarker) => entry.exportName)).toEqual([
      'describe', 'set', 'unset',
    ])
    const described = await credentials.remoteDescribe(['DEMO_KEY'])
    expect(described).toEqual({
      credentials: { DEMO_KEY: { configured: true, source: 'memory', writable: true } },
    })
    expect(JSON.stringify(described)).not.toContain('hidden-value')
  })

  it('writes and removes a valid ref while rejecting invalid names and empty values', async () => {
    const credentials = await boot()
    await expect(credentials.remoteSet('DEMO_KEY', 'write-only-value')).resolves.toEqual({})
    expect(JSON.stringify(await credentials.remoteDescribe(['DEMO_KEY']))).not.toContain('write-only-value')
    await expect(credentials.remoteUnset('DEMO_KEY')).resolves.toEqual({})
    await expect(credentials.remoteDescribe(['DEMO_KEY'])).resolves.toEqual({
      credentials: { DEMO_KEY: { configured: false, writable: true } },
    })
    await expect(credentials.remoteDescribe(['not-a-ref']))
      .rejects.toMatchObject({ code: 'input-invalid', details: { ref: 'not-a-ref' } })
    await expect(credentials.remoteSet('not-a-ref', 'x'))
      .rejects.toMatchObject({ code: 'input-invalid', details: { ref: 'not-a-ref' } })
    await expect(credentials.remoteUnset('not-a-ref'))
      .rejects.toMatchObject({ code: 'input-invalid', details: { ref: 'not-a-ref' } })
    await expect(credentials.remoteSet('DEMO_KEY', ''))
      .rejects.toMatchObject({ code: 'credential-rejected', details: { ref: 'DEMO_KEY' } })

    vi.spyOn(credentials, 'describe').mockRejectedValueOnce(new Error('secret diagnostic'))
    await expect(credentials.remoteDescribe(['DEMO_KEY']))
      .rejects.toMatchObject({ code: 'credential-rejected', details: { ref: 'DEMO_KEY' } })
    vi.spyOn(credentials, 'unset').mockRejectedValueOnce(new Error('secret diagnostic'))
    await expect(credentials.remoteUnset('DEMO_KEY'))
      .rejects.toMatchObject({ code: 'credential-rejected', details: { ref: 'DEMO_KEY' } })
  })
})
