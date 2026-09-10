import { afterEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import AgentPresets, { COMPOSITION_FILE } from '../src/index.ts'

class HostPresets extends AgentPresets {
  available = true
  readonly opened = vi.fn(async (_path: string, _signal: AbortSignal) => {})
  protected override canOpenPresetDirectory() { return this.available }
  protected override openPresetDirectory(path: string, signal: AbortSignal) { return this.opened(path, signal) }
}

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function runtime() {
  const root = await mkdtemp(join(tmpdir(), 'native-preset-open-'))
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
  Object.assign(ctx.loader.builtins, { include: Include, 'native-presets': HostPresets })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await ctx.loader.await()
  const presets = ctx.agentPresets
  if (!(presets instanceof HostPresets)) throw new Error('native preset owner was not loaded')
  return { root, ctx, presets }
}

it('exposes Native preset names and performs a real copied-directory workflow under Loader', async () => {
  const { root, presets } = await runtime()
  expect(remoteMethods(presets).map(method => method.exportName).sort()).toEqual(['copy', 'list', 'openDocument', 'read', 'remove', 'select'])
  expect(await presets.remoteExportList()).toMatchObject({ authorable: true, hasDocument: true })
  expect(await presets.remoteExportCopy('shipped', 'copied', '我的预设')).toEqual({ agentPreset: 'copied' })
  expect(await presets.readDocument('copied')).toMatchObject({ agentPreset: 'copied', name: '我的预设', content: '[]\n' })
  const signal = new AbortController().signal
  expect(await presets.remoteOpenDocument('copied', signal)).toEqual({ opened: true })
  expect(presets.opened).toHaveBeenCalledExactlyOnceWith(join(root, 'user/copied'), signal)
  expect(await presets.remoteExportDelete('copied')).toEqual({})
  await expect(presets.resolve('copied')).rejects.toThrow('not found')
})

it('refuses shipped and missing targets, and returns a path only without a native opener', async () => {
  const { root, presets } = await runtime()
  for (const id of ['shipped', 'missing', '']) await expect(presets.remoteOpenDocument(id, new AbortController().signal)).rejects.toThrow()
  expect(presets.opened).not.toHaveBeenCalled()
  presets.available = false
  expect(await presets.remoteOpenDocument('mine', new AbortController().signal)).toEqual({ opened: false, path: join(root, 'user/mine') })
})

it('honors cancellation before and after handoff and contains native command errors', async () => {
  const { presets } = await runtime()
  await expect(presets.remoteOpenDocument('mine', AbortSignal.abort())).rejects.toMatchObject({ failure: { code: 'cancelled' } })
  expect(presets.opened).not.toHaveBeenCalled()
  presets.opened.mockRejectedValueOnce(new Error('private command diagnostic'))
  await expect(presets.remoteOpenDocument('mine', new AbortController().signal)).rejects.toMatchObject({
    failure: { code: 'internal', message: 'agent preset document open failed' },
  })
  const cancel = new AbortController()
  presets.opened.mockImplementationOnce(async () => { cancel.abort() })
  await expect(presets.remoteOpenDocument('mine', cancel.signal)).rejects.toMatchObject({ failure: { code: 'cancelled' } })
})
