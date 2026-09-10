/** Real Native preset composition shared by behavior tests and keyless snapshots. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { boot, healProfilesModuleFallback, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'

const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url))

export async function createNativePresetRuntime() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-native-code-preset-'))
  const previousHome = process.env.DSH_HOME
  let context: Context | undefined
  const dispose = async () => {
    try { await context?.fiber.dispose() }
    finally {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      await rm(home, { recursive: true, force: true })
    }
  }
  try {
    process.env.DSH_HOME = home
    healProfilesModuleFallback(join(repoRoot, 'packages/boot/native-api-runner/package.json'), home)
    const profileDir = join(home, 'profiles', 'native-code')
    await mkdir(profileDir, { recursive: true })
    const rootConfig = join(profileDir, 'cordis.yml')
    await writeFile(rootConfig, '[]\n')
    const profile = loadOverlayPatches('dsh-native-test', join(repoRoot, 'integrations/jiuzhang/profile/cordis.patch.yml'))
    const presetConfig: unknown = profile.find(row => row.id === 'agent-presets')?.config
    if (presetConfig === null || typeof presetConfig !== 'object' || Array.isArray(presetConfig)) {
      throw new Error('Native profile must declare its preset configuration')
    }
    const patches: PatchOptions[] = [
      ...loadOverlayPatches('dsh-native-test', join(repoRoot, 'packages/bundle/base/cordis.patch.yml')),
      ...loadOverlayPatches('dsh-native-test', join(repoRoot, 'packages/bundle/native-api-app/cordis.patch.yml')),
      ...profile,
      { id: 'settings', config: { path: join(home, 'settings.yaml'), watch: false } },
      { id: 'credentials', config: { mode: 'file', path: join(home, 'credentials.yaml'), watch: false } },
      { id: 'storage-json', config: { root: join(home, 'storages') } },
      { id: 'knowledge-wiki', config: { wikiRoot: join(home, 'knowledge/wiki'), mainRoot: join(home, 'knowledge'),
        apiKey: '', llmProvider: 'deepseek-official', llmModel: 'deepseek-v4-flash' } },
      { id: 'agent-presets', config: { ...presetConfig,
        roots: [{ path: join(repoRoot, 'packages/boot/profile-runner/config/agent-presets'), trust: 'system' }], includeUserRoot: false } },
      { id: 'webserver', disabled: true },
      { id: 'native-api-runtime', disabled: true },
      { id: 'host-connection', disabled: true },
      { id: 'native-events', disabled: true },
      { id: 'session-telemetry-otel', disabled: true },
    ]
    context = await boot('dsh-native-test', rootConfig, patches, (ctx) => {
      provideCmdline(ctx, { args: ['--port', '0'], exit: () => {} })
    })
    return { context, dispose }
  } catch (error) { await dispose(); throw error }
}
