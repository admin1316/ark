import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

// Exercise the actual E2E declaration and skip predicate without importing its
// provider harness or exposing the test process's environment to it.
const source = readFileSync(new URL('./provider-apis.e2e.ts', import.meta.url), 'utf8')
const start = source.indexOf('interface ProviderCase {')
const end = source.indexOf('const contexts: Context[] = []')
const predicate = /describe\.skipIf\(([^\n]+)\)\(/u.exec(source)?.[1]
if (start < 0 || end <= start || predicate === undefined) throw new Error('provider fixture declaration not found')
const declaration = stripTypeScriptTypes(source.slice(start, end))
const keys = [
  'DSH_PI_AI_OPENAI_BASE_URL', 'AZURE_OPENAI_API_KEY',
  'ANTHROPIC_API_KEY', 'DSH_PI_AI_ANTHROPIC_BASE_URL',
  'DSH_PI_AI_OPENAI_MODEL', 'DSH_PI_AI_ANTHROPIC_MODEL',
]
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function evaluate(values: Readonly<Record<string, string | undefined>>) {
  const reads: string[] = []
  const env = new Proxy(values, {
    get(target, key) {
      if (typeof key !== 'string' || !keys.includes(key)) throw new Error('unexpected environment access')
      reads.push(key)
      return target[key]
    },
    set() { throw new Error('environment writes forbidden') },
    ownKeys() { throw new Error('environment enumeration forbidden') },
  })
  const result: unknown = runInNewContext(
    `${declaration}\nproviderCases.map(profile => ({ provider: profile.provider, profile, skip: ${predicate} }))`,
    {
      process: { env },
      console: new Proxy({}, { get() { throw new Error('fixture output forbidden') } }),
      fetch() { throw new Error('network forbidden') },
    },
  )
  if (!Array.isArray(result)) throw new Error('expected provider cases')
  const rows = result.map((row: unknown) => {
    if (!isRecord(row) || typeof row['provider'] !== 'string'
      || typeof row['skip'] !== 'boolean' || !isRecord(row['profile'])) {
      throw new Error('invalid provider case')
    }
    return { provider: row['provider'], skip: row['skip'], profile: row['profile'] }
  })
  return { rows, reads }
}

describe('provider E2E credential-reference eligibility', () => {
  it('uses references throughout the current fixture instead of the removed key field', () => {
    expect(source).not.toMatch(/profile\.apiKey\b/u)
    expect(source.slice(start, end)).not.toMatch(/\bapiKey\??\s*:/u)
    expect(predicate).toBe('profile.apiKeyEnv === undefined')
  })

  it('preserves both legacy skip decisions for all unset, empty, and populated combinations', () => {
    const states = [undefined, '', 'synthetic-presence-sentinel']
    for (const azure of states) {
      for (const anthropic of states) {
        for (const openai of states) {
          const { rows, reads } = evaluate({
            AZURE_OPENAI_API_KEY: azure, ANTHROPIC_API_KEY: anthropic,
            OPENAI_API_KEY: openai, DEEPSEEK_API_KEY: 'must-not-be-read',
          })
          // Legacy fixture: Azure used truthiness; Anthropic tested undefined.
          // OPENAI_API_KEY alone never enabled this particular OpenAI fixture.
          expect(rows.map(row => [row.provider, row.skip])).toEqual([
            ['openai', !azure], ['anthropic', anthropic === undefined],
          ])
          expect(reads).toEqual(keys)
          expect(rows.map(row => row.profile['apiKeyEnv'])).toEqual([
            azure ? 'AZURE_OPENAI_API_KEY' : undefined,
            anthropic === undefined ? undefined : 'ANTHROPIC_API_KEY',
          ])
          expect(JSON.stringify(rows)).not.toContain('synthetic-presence-sentinel')
          expect(JSON.stringify(rows)).not.toContain('must-not-be-read')
        }
      }
    }
  })

  it('keeps a missing reference skipped even when unrelated credential sources are present', () => {
    const { rows, reads } = evaluate({ OPENAI_API_KEY: 'unrelated', DEEPSEEK_API_KEY: 'unrelated' })
    expect(rows.map(row => row.skip)).toEqual([true, true])
    expect(rows.every(row => !Object.hasOwn(row.profile, 'apiKeyEnv'))).toBe(true)
    expect(reads).toEqual(keys)
  })
})
