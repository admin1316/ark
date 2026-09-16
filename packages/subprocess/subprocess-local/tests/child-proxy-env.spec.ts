import { afterEach, describe, expect, it } from 'vitest'
import { installProxyFromEnvironment } from '@deepseek-ai/dsh-http-proxy'
import { childEnv } from '../src/spawn.ts'

const disposers: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
})

/** The installer reads its environment through this lookup, not through a plain object. */
function envLookup(values: Record<string, string>) {
  const entries = new Map(Object.entries(values).map(([name, value]) => [name, { value }]))
  return { get: (name: string) => entries.get(name) }
}

describe('child process proxy environment', () => {
  it('overlays the resolved proxy policy and asks the child Node to read it', async () => {
    disposers.push(await installProxyFromEnvironment(
      envLookup({ HTTP_PROXY: 'http://proxy.invalid:3128', HTTPS_PROXY: 'http://proxy.invalid:3128' }),
      () => undefined,
    ))
    const env = childEnv()
    expect(env['NODE_USE_ENV_PROXY']).toBe('1')
    expect(env['HTTP_PROXY']).toBe('http://proxy.invalid:3128')
    expect(env['HTTPS_PROXY']).toBe('http://proxy.invalid:3128')
  })

  it('leaves the child environment untouched when no proxy is declared', () => {
    const env = childEnv()
    expect(env['NODE_USE_ENV_PROXY']).toBeUndefined()
  })

  it('removes a proxy name the user never exported instead of handing the child this process\'s published one', async () => {
    // The user named the scheme in one casing only. The install publishes both
    // casings into THIS process's environment, so the child environment would
    // inherit a derivation the user never wrote unless the tombstone removes it.
    const saved = {
      HTTP_PROXY: process.env.HTTP_PROXY,
      http_proxy: process.env.http_proxy,
    }
    process.env.HTTP_PROXY = 'http://user.invalid:3128'
    Reflect.deleteProperty(process.env, 'http_proxy')
    try {
      disposers.push(await installProxyFromEnvironment(
        envLookup({ HTTP_PROXY: 'http://user.invalid:3128' }),
        () => undefined,
      ))
      expect(process.env.http_proxy).toBe('http://user.invalid:3128')

      const env = childEnv()
      expect(env['HTTP_PROXY']).toBe('http://user.invalid:3128')
      expect(Object.hasOwn(env, 'http_proxy')).toBe(false)
      expect(env['http_proxy']).toBeUndefined()

      // The same tombstone must survive an explicit caller entry: an ambient
      // derived name is removed before the caller's own entries are merged.
      const explicit = childEnv({ PATH: '/usr/bin', http_proxy: 'http://explicit.invalid:8080' })
      expect(explicit['PATH']).toBe('/usr/bin')
      expect(explicit['http_proxy']).toBe('http://explicit.invalid:8080')
    } finally {
      for (const dispose of disposers.splice(0)) await dispose()
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) Reflect.deleteProperty(process.env, name)
        else process.env[name] = value
      }
    }
  })
})
