// The document is the one durable boundary this provider owns, so every shape
// it cannot read back is refused at boot by name rather than skipped, and every
// record an external edit reshapes is republished instead of served stale.
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'
import { LocalCredentialProvider, renderFlatLayoutMigration } from '../src/index.ts'

const KEY = credentialRef('DSH_CRED_TEST')
const CODEX = credentialKey('llm-pi-ai', 'openai-codex')

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-credentials-shapes-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** Credential documents are seeded owner-only, exactly as the provider creates them. */
function writeCredentials(file: string, text: string): Promise<void> {
  return writeFile(file, text, { mode: 0o600 })
}

async function boot(config: ConstructorParameters<typeof LocalCredentialProvider>[1]): Promise<Context> {
  const ctx = new Context()
  const fiber = ctx.plugin(LocalCredentialProvider, config)
  cleanups.push(async () => { await fiber.dispose() })
  await fiber
  return ctx
}

describe('document shapes refused by name', () => {
  // A present-but-wrong section is refused too, not only an absent one: a
  // section the reader cannot enumerate would silently drop every entry in it.
  it.each([
    ['a records section that is not a mapping', 'version: 1\nrecords: nope\n',
      /"records" in .* must be a mapping/],
    ['a records section that is a sequence', 'version: 1\nrecords:\n  - llm-pi-ai/openai-codex\n',
      /"records" in .* must be a mapping/],
    ['a refs section that is a sequence', 'version: 1\nrefs:\n  - DSH_CRED_TEST\n',
      /"refs" in .* must be a mapping/],
    // An api-key record is admitted only in the spellings a later boot reads
    // back: a non-string key, an environment name outside the reference
    // grammar, and a payload YAML can express but JSON cannot (here a
    // !!binary scalar, which decodes to bytes no JSON round trip preserves).
    ['an api-key record whose key is not a string', 'version: 1\nrecords:\n  llm-pi-ai/acme:\n'
      + '    kind: api-key\n    key: 123\n', /non-string or empty key/],
    ['an api-key environment name outside the reference grammar', 'version: 1\nrecords:\n  llm-pi-ai/acme:\n'
      + '    kind: api-key\n    env:\n      "not a name": value\n', /must match/],
    ['a grant payload JSON cannot represent', 'version: 1\nrecords:\n  llm-pi-ai/acme:\n'
      + '    kind: grant\n    payload: !!binary aGk=\n', /JSON cannot represent/],
  ])('fails boot on %s', async (_case, text, message) => {
    const dir = await tempDir()
    const path = join(dir, '.credentials.yaml')
    await writeCredentials(path, text)
    await expect(new Context().plugin(LocalCredentialProvider, { path, watch: false })).rejects.toThrow(message)
  })
  // Every operand of a refusal chain is reached by some shape: a null section,
  // a null entry, and a sequence are three different admissions.
  it.each([
    ['a null record entry', 'version: 1\nrecords:\n  llm-pi-ai/acme:\n',
      /record "llm-pi-ai\/acme" .* must be a mapping/],
    ['a sequence record entry', 'version: 1\nrecords:\n  llm-pi-ai/acme:\n    - kind\n',
      /record "llm-pi-ai\/acme" .* must be a mapping/],
    ['a null api-key environment', 'version: 1\nrecords:\n  llm-pi-ai/acme:\n    kind: api-key\n    env:\n',
      /non-mapping env/],
    ['a sequence api-key environment', 'version: 1\nrecords:\n  llm-pi-ai/acme:\n    kind: api-key\n    env:\n      - AWS_PROFILE\n', /non-mapping env/],
    ['an api-key environment value that is not a string', 'version: 1\nrecords:\n  llm-pi-ai/acme:\n'
      + '    kind: api-key\n    env:\n      AWS_PROFILE: 123\n', /must be a non-empty string/],
  ])('fails boot on %s', async (_case, text, message) => {
    const dir = await tempDir()
    const path = join(dir, '.credentials.yaml')
    await writeCredentials(path, text)
    await expect(new Context().plugin(LocalCredentialProvider, { path, watch: false })).rejects.toThrow(message)
  })

  it.each([
    ['an empty refs section', 'version: 1\nrefs:\n'],
    ['an empty records section', 'version: 1\nrecords:\n'],
  ])('reads %s as the empty store', async (_case, text) => {
    const dir = await tempDir()
    const path = join(dir, '.credentials.yaml')
    await writeCredentials(path, text)
    const ctx = await boot({ path, watch: false })
    expect(await ctx.credentials.readRecord(CODEX)).toBeUndefined()
    expect(await ctx.credentials.resolve(KEY)).toBeUndefined()
  })

  it('admits every JSON scalar as a grant payload and returns it verbatim', async () => {
    const dir = await tempDir()
    const path = join(dir, '.credentials.yaml')
    const ctx = await boot({ path, watch: false })
    // null, string, and boolean payloads short-circuit the admission walk
    // before its number/object cases; each must survive the document round trip
    // exactly as the owner wrote it.
    for (const payload of [null, 'plain', true, false, 0]) {
      await ctx.credentials.modifyRecord(CODEX, () => Promise.resolve({ kind: 'grant', payload }))
      expect(await ctx.credentials.readRecord(CODEX)).toEqual({ kind: 'grant', payload })
    }
  })

  it('declines a flat document whose key is not a scalar', () => {
    // A complex key would be nested as-is and re-read as a credential the user
    // never named; the recognizer requires scalar keys.
    expect(renderFlatLayoutMigration('? [a, b]\n: value\n')).toBeUndefined()
  })
})

describe('flat-layout recognizer', () => {
  it('declines a flat document that already carries a version key', () => {
    // Nesting would turn the version stamp into a credential named 'version';
    // the recognizer declines and the ordinary parser reports the unsupported
    // version by name instead.
    expect(renderFlatLayoutMigration('version: 2\nDSH_CRED_TEST: a\n')).toBeUndefined()
    expect(renderFlatLayoutMigration('version: 1\nrefs:\n  DSH_CRED_TEST: a\n')).toBeUndefined()
  })

  it('nests a recognized flat document verbatim under a version stamp', () => {
    expect(renderFlatLayoutMigration('DSH_CRED_TEST: plain\n# annotated\n'))
      .toBe('version: 1\nrefs:\n  DSH_CRED_TEST: plain\n  # annotated\n')
    // A document that does not end in a newline gets one, so the appended
    // section is never glued onto the last entry.
    expect(renderFlatLayoutMigration('DSH_CRED_TEST: plain'))
      .toBe('version: 1\nrefs:\n  DSH_CRED_TEST: plain\n')
  })
})

describe('record reload comparison', () => {
  it('republishes a payload whose key changed without changing its size', async () => {
    const dir = await tempDir()
    const path = join(dir, '.credentials.yaml')
    const ctx = await boot({ path, watch: false })
    await ctx.credentials.modifyRecord(CODEX, () => Promise.resolve({ kind: 'grant', payload: { a: 1 } }))
    const seen: string[] = []
    ctx.on('credentials/record-updated', (key) => { seen.push(key) })

    // Same member count, different member name: an identity or size check would
    // call this unchanged and keep serving the old payload.
    await writeCredentials(path, 'version: 1\nrecords:\n  llm-pi-ai/openai-codex:\n'
      + '    kind: grant\n    payload:\n      b: 1\n')
    // Any write folds the unobserved document in before committing its own,
    // and a reference write adds no record event of its own to confuse the count.
    await ctx.credentials.set(KEY, 'ref-value')

    expect(seen).toEqual([CODEX])
    expect(await ctx.credentials.readRecord(CODEX)).toEqual({ kind: 'grant', payload: { b: 1 } })
  })

  it('keeps an unchanged record out of the update fan-out', async () => {
    const dir = await tempDir()
    const path = join(dir, '.credentials.yaml')
    const ctx = await boot({ path, watch: false })
    await ctx.credentials.modifyRecord(CODEX, () => Promise.resolve({ kind: 'grant', payload: { a: 1, nested: [1, 2] } }))
    const seen: string[] = []
    ctx.on('credentials/record-updated', (key) => { seen.push(key) })

    // A fold-in that re-reads the very same record: identical JSON content in a
    // freshly parsed object graph is a no-op, so no observer is woken.
    await ctx.credentials.set(KEY, 'ref-value')

    expect(seen).toEqual([])
    expect(await ctx.credentials.readRecord(CODEX)).toEqual({ kind: 'grant', payload: { a: 1, nested: [1, 2] } })
    // The write that triggered the fold-in still committed its own reference.
    expect(await ctx.credentials.resolve(KEY)).toEqual({ value: 'ref-value', source: 'file' })
  })
})
