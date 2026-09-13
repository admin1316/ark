import dns from 'node:dns'
import { expect, vi, type MockInstance } from 'vitest'
import { PROXY_ENV_NAMES } from '../src/policy.ts'

/** A launch environment built from the names a user would export, in the casings they wrote. */
export function env(values: Record<string, string>): { get(name: string): { value: string } | undefined } {
  return { get: name => (name in values ? { value: values[name] as string } : undefined) }
}

/** Run one case from a known-empty proxy environment, then restore what the machine had. */
export async function withCleanProxyEnv(run: () => Promise<void>): Promise<void> {
  const saved = Object.fromEntries(PROXY_ENV_NAMES.map(name => [name, process.env[name]]))
  for (const name of PROXY_ENV_NAMES) Reflect.deleteProperty(process.env, name)
  try {
    await run()
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) Reflect.deleteProperty(process.env, name)
      else process.env[name] = value
    }
  }
}

/** Refuse only the reserved test hostname, without depending on the machine DNS resolver. */
export function refuseFixtureLookup(hostname: string): MockInstance<typeof dns.lookup> {
  return vi.spyOn(dns, 'lookup').mockImplementation((...args: unknown[]) => {
    expect(args[0]).toBe(hostname)
    const callback = args.at(-1)
    if (typeof callback !== 'function') throw new Error('DNS lookup callback missing')
    const error = Object.assign(new Error('fixture hostname not found'), { code: 'ENOTFOUND' })
    queueMicrotask(() => { Reflect.apply(callback, undefined, [error]) })
  })
}

