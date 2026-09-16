import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as installation from '../src/index.ts'
import * as companion from '../src/invariant.ts'
import { env, withCleanProxyEnv } from './proxy-env.ts'

const { proxyEnvironmentForChild } = installation
const proxyUrl = 'http://127.0.0.1:9'

/** Install a real policy without opening a request to its proxy endpoint. */
async function install(lookup: ReturnType<typeof env>): Promise<{ dispose: () => Promise<void> }> {
  const dispose = await installation.installProxyFromEnvironment(lookup, () => {})
  return { dispose }
}

/** One HTTP proxy policy used by the installation-boundary checks. */
function proxyAll(): ReturnType<typeof env> {
  return env({ HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl })
}

describe('the proxy invariant companion', () => {
  it('accepts the uninstalled state and releases its package registration', async () => {
    const ctx = new Context()
    const registry = await ctx.plugin(InvariantRegistry, {})
    try {
      expect(proxyEnvironmentForChild()).toEqual({})
      const first = await companion.apply(ctx)
      expect(() => ctx.invariants.register('@deepseek-ai/dsh-http-proxy', () => {}))
        .toThrow(/already registered/)
      await Promise.resolve().then(first)
      const next = await companion.apply(ctx)
      await Promise.resolve().then(next)
    } finally {
      await registry.dispose()
    }
  })

  it('accepts a direct policy and an actual installed HTTP proxy policy', async () => {
    await withCleanProxyEnv(async () => {
      for (const lookup of [env({}), proxyAll()]) {
        const { dispose } = await install(lookup)
        const ctx = new Context()
        const registry = await ctx.plugin(InvariantRegistry, {})
        const readEnvironment = vi.spyOn(installation, 'proxyEnvironmentForChild')
        try {
          const release = await companion.apply(ctx)
          expect(readEnvironment).toHaveBeenCalledOnce()
          expect(readEnvironment.mock.results[0]?.value).toEqual(
            lookup.get('HTTP_PROXY') === undefined
              ? {}
              : expect.objectContaining({ NODE_USE_ENV_PROXY: '1', HTTP_PROXY: proxyUrl }),
          )
          await Promise.resolve().then(release)
        } finally {
          readEnvironment.mockRestore()
          await registry.dispose()
          await dispose()
        }
      }
      expect(proxyEnvironmentForChild()).toEqual({})
    })
  })

  it('accepts inherited SOCKS settings only while Node proxy parsing is withheld', async () => {
    await withCleanProxyEnv(async () => {
      process.env.HTTP_PROXY = 'socks5://private-user:private-pass@proxy.example:1080'
      process.env.HTTPS_PROXY = proxyUrl
      const lookup = env({ HTTP_PROXY: process.env.HTTP_PROXY, HTTPS_PROXY: proxyUrl })
      const { dispose } = await install(lookup)
      const ctx = new Context()
      const registry = await ctx.plugin(InvariantRegistry, {})
      const readEnvironment = installation.proxyEnvironmentForChild
      try {
        expect(readEnvironment().NODE_USE_ENV_PROXY).toBeUndefined()
        const release = await companion.apply(ctx)
        await Promise.resolve().then(release)
        // Corrupt only the flag in the real installed policy's child result.
        const spy = vi.spyOn(installation, 'proxyEnvironmentForChild')
          .mockImplementation(() => ({ ...readEnvironment(), NODE_USE_ENV_PROXY: '1' }))
        try {
          await expect(companion.apply(ctx)).rejects.toThrow(/unsupported HTTP_PROXY/)
          await expect(companion.apply(ctx)).rejects.not.toThrow(/private-user|private-pass/)
        } finally {
          spy.mockRestore()
        }
        const recovered = await companion.apply(ctx)
        await Promise.resolve().then(recovered)
      } finally {
        await registry.dispose()
        await dispose()
      }
    })
  })
})
