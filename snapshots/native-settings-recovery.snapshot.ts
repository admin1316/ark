import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import z from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file'
import { TypertLookupFailure } from '@deepseek-ai/dsh-typert-protocol'
import yaml from 'js-yaml'

it('native Settings persists a redacted edit, activates it and rejects a stale editor through a real Loader', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ark-settings-snapshot-'))
  const ctx = new Context()
  const namespace = settingsNamespace('native-theme')
  const applied: string[] = []
  try {
    const settingsPath = join(root, 'settings.yaml')
    const configPath = join(root, 'cordis.yml')
    await writeFile(settingsPath, 'native-theme:\n  theme: dark\n  token: fixture-only-secret\n')
    await writeFile(configPath, [
      '- id: settings', '  name: cordis:native-settings-storage', '  config:',
      `    path: ${JSON.stringify(settingsPath)}`, '    watch: false',
      '- id: owner', '  name: cordis:native-settings-owner', '',
    ].join('\n'))
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    Object.assign(ctx.loader.builtins, {
      include: Include,
      'native-settings-storage': FileSettingsProvider,
      'native-settings-owner': {
        inject: ['settings'],
        apply(owner: Context) {
          const scope = owner.settings.register(namespace, z.object({
            theme: z.string(), token: z.string().role('secret'),
          }))
          scope.watch(next => { applied.push(next.theme) })
        },
      },
    })
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await ctx.loader.await()
    const settings = ctx.settings
    const before = settings.remoteDescribe().namespaces[0]!
    const after = await settings.remoteMutate(namespace, [{ op: 'set', path: ['theme'], value: 'light' }], before.revision)
    const accepted = await settings.settle(namespace, after.revision)
    let stale: unknown
    try { await settings.remoteUpdate(namespace, { theme: 'dark' }, before.revision) }
    catch (error) {
      if (!(error instanceof TypertLookupFailure)) throw error
      stale = error.failure
    }
    expect(yaml.load(await readFile(settingsPath, 'utf8'))).toEqual({
      [namespace]: { theme: 'light', token: 'fixture-only-secret' },
    })
    // Schema uids are process-local; the snapshot records the stable UI-visible fields.
    const projection = (view: typeof before) => ({ value: view.value, user: view.user, secrets: view.secrets, revision: view.revision })
    expect({ before: projection(before), after: projection(after), accepted, applied, stale }).toMatchSnapshot()
    const entry = [...ctx.loader.entries()].find(candidate => candidate.options.name === 'cordis:native-settings-owner')
    if (entry === undefined) throw new Error('Loader owner entry is missing')
    await entry.update({ disabled: true })
    await ctx.loader.await()
    expect(settings.remoteDescribe().namespaces).toEqual([])
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

it.each(['base', 'default'])('native Settings refuses a malformed secret %s behind a valid user layer', async (layer) => {
  const root = await mkdtemp(join(tmpdir(), 'ark-settings-secret-shape-'))
  const ctx = new Context()
  const namespace = settingsNamespace('secret-shape-fixture')
  try {
    const settingsPath = join(root, 'settings.json')
    const configPath = join(root, 'cordis.yml')
    const document = JSON.stringify({ [namespace]: { tokens: {} } })
    await writeFile(settingsPath, document, { mode: 0o600 })
    await writeFile(configPath, [
      '- id: settings', '  name: cordis:secret-shape-storage', '  config:',
      `    path: ${JSON.stringify(settingsPath)}`, '    watch: false',
      '- id: owner', '  name: cordis:secret-shape-owner', '',
    ].join('\n'))
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    Object.assign(ctx.loader.builtins, { include: Include, 'secret-shape-storage': FileSettingsProvider,
      'secret-shape-owner': {
        inject: ['settings'],
        apply(owner: Context) {
          const tokens = z.dict(z.string().role('secret'))
          if (layer === 'default') Reflect.set(tokens.meta, 'default', 'synthetic-default-secret')
          const schema: z<object> = z.object({ tokens })
          owner.settings.register(namespace, schema, layer === 'base' ? { base: { tokens: 'synthetic-base-secret' } } : {})
        },
      },
    })
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await ctx.loader.await()
    let failure: { name: string; message: string } | undefined
    try { ctx.settings.remoteDescribe() }
    catch (error) {
      if (!(error instanceof TypeError)) throw error
      failure = { name: error.name, message: error.message }
    }
    expect({ layer, failure, resolved: ctx.settings.get(namespace),
      documentUnchanged: await readFile(settingsPath, 'utf8') === document }).toMatchSnapshot()
    expect(JSON.stringify(failure)).not.toContain('synthetic-')
  } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
})
