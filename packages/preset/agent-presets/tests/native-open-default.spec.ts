import { afterEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentPresets, { COMPOSITION_FILE } from '../src/index.ts'

// The child process that hands a directory to the desktop is the only
// boundary replaced here: everything else (Loader composition, roster
// resolution, trust checks, cancellation) is the shipping implementation.
// The default methods delegate to this module, and both answers are stubbed
// so the assertion holds on a headless host and on a desktop one.
const native = vi.hoisted(() => ({
  available: true,
  opened: [] as { path: string; signal: AbortSignal }[],
}))

vi.mock('@deepseek-ai/dsh-native-command', () => ({
  canOpenNativePath: () => native.available,
  openNativePath: (path: string, signal: AbortSignal) => {
    native.opened.push({ path, signal })
    return Promise.resolve()
  },
}))

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  native.available = true
  native.opened.length = 0
})

async function runtime() {
  const root = await mkdtemp(join(tmpdir(), 'native-preset-default-open-'))
  const ctx = new Context()
  cleanups.push(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  for (const name of ['system/shipped', 'user/mine']) {
    await mkdir(join(root, name), { recursive: true })
    await writeFile(join(root, name, COMPOSITION_FILE), '[]\n')
  }
  const config = join(root, 'host.yml')
  await writeFile(config, [
    '- name: cordis:native-presets', '  config:', '    default: shipped',
    '    includeShippedRoot: false', '    includeUserRoot: false', '    roots:',
    `      - path: ${JSON.stringify(join(root, 'system'))}`, '        trust: system',
    `      - path: ${JSON.stringify(join(root, 'user'))}`, '        trust: user', '',
  ].join('\n'))
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, { include: Include, 'native-presets': AgentPresets })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await ctx.loader.await()
  const presets = ctx.agentPresets
  if (!(presets instanceof AgentPresets)) throw new Error('native preset owner was not loaded')
  return { root, presets }
}

it('hands the resolved user preset directory to the default native opener', async () => {
  const { root, presets } = await runtime()
  const signal = new AbortController().signal
  expect(await presets.remoteOpenDocument('mine', signal)).toEqual({ opened: true })
  expect(native.opened).toEqual([{ path: join(root, 'user/mine'), signal }])
})

it('returns the directory instead of opening it when the host has no native opener', async () => {
  const { root, presets } = await runtime()
  native.available = false
  expect(await presets.remoteOpenDocument('mine', new AbortController().signal))
    .toEqual({ opened: false, path: join(root, 'user/mine') })
  expect(native.opened).toEqual([])
})
