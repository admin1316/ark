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
})
