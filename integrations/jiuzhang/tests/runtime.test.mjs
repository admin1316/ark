import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import {
  chmod,
  cp,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runtimeAssetSource } from '../src/runtime-plan.mjs'
import { composeEntries } from '../../../packages/boot/app-boot/lib/index.js'
import { prepareProfile } from '../../../packages/boot/profile-runner/lib/index.js'
import {
  assertStandaloneRuntimeClosure,
  createLaunchEnvironment,
  installRuntimeConfiguration,
  migrateLegacyProductData,
  readSettingsImportRecord,
  resolveBuiltArkNativeRunner,
  seedLocalModelProvider,
  purgeReservedJiuzhangPreset,
  resolveRepositoryRoot,
  resolveSessionWorkingDirectory,
} from '../src/runtime.mjs'

const launcherSrc = fileURLToPath(new URL('../src/', import.meta.url))
const runtimePolicy = JSON.parse(await readFile(
  fileURLToPath(new URL('../profile/forbidden-runtime-packages.json', import.meta.url)),
  'utf8',
))

const execFileAsync = promisify(execFile)

test('source layout skips the standalone artifact-closure check', async () => {
  assert.deepEqual(await assertStandaloneRuntimeClosure(), { skipped: true })
})

test('default chat working directory can be isolated from source and app runtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ark-default-workspace-'))
  try {
    assert.equal(
      await resolveSessionWorkingDirectory({ ARK_DEFAULT_WORKSPACE: root }),
      root,
    )
    await assert.rejects(
      resolveSessionWorkingDirectory({ ARK_DEFAULT_WORKSPACE: 'relative/path' }),
      /must be an absolute path/,
    )
    await assert.rejects(
      resolveSessionWorkingDirectory({ ARK_DEFAULT_WORKSPACE: '/' }),
      /cannot be a filesystem root/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('legacy product data migration preserves sessions, settings, credentials, and its source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ark-data-migration-'))
  const source = join(root, 'legacy', 'Harness')
  const target = join(root, 'Ark', 'Harness')
  try {
    await mkdir(join(source, 'sessions', 'workspace', 'session-1'), { recursive: true })
    await mkdir(join(source, 'attachments'), { recursive: true })
    await mkdir(join(source, 'storages'), { recursive: true })
    await writeFile(join(source, 'settings.yaml'), 'theme: dark\n', { mode: 0o600 })
    await writeFile(
      join(source, 'storages', 'credentials.json'),
      '{"provider":"managed-reference"}\n',
      { mode: 0o600 },
    )
    await writeFile(
      join(source, 'sessions', 'workspace', 'session-1', 'session.jsonl.zstd'),
      'session-bytes',
      { mode: 0o600 },
    )
    await symlink('../storages/credentials.json', join(source, 'attachments', 'credential-ref'))
    const preservedTime = new Date('2026-08-14T12:34:56.000Z')
    await utimes(join(source, 'settings.yaml'), preservedTime, preservedTime)

    const result = await migrateLegacyProductData(source, target)

    assert.equal(result.status, 'migrated')
    assert.equal(await readFile(join(target, 'settings.yaml'), 'utf8'), 'theme: dark\n')
    assert.equal(
      await readFile(join(target, 'storages', 'credentials.json'), 'utf8'),
      '{"provider":"managed-reference"}\n',
    )
    assert.equal(
      await readFile(
        join(target, 'sessions', 'workspace', 'session-1', 'session.jsonl.zstd'),
        'utf8',
      ),
      'session-bytes',
    )
    assert.equal(await readFile(join(source, 'settings.yaml'), 'utf8'), 'theme: dark\n')
    assert.equal((await lstat(join(target, 'settings.yaml'))).mode & 0o777, 0o600)
    assert.equal((await lstat(join(target, 'settings.yaml'))).mtimeMs, preservedTime.getTime())
    assert.equal(
      await readlink(join(target, 'attachments', 'credential-ref')),
      '../storages/credentials.json',
    )
    assert.equal((await migrateLegacyProductData(source, target)).status, 'already-migrated')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('legacy product data migration refuses conflicting destination data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ark-data-migration-'))
  const source = join(root, 'legacy', 'Harness')
  const target = join(root, 'Ark', 'Harness')
  try {
    await mkdir(source, { recursive: true })
    await mkdir(target, { recursive: true })
    await writeFile(join(source, 'settings.yaml'), 'source-value\n')
    await writeFile(join(target, 'settings.yaml'), 'target-value\n')

    await assert.rejects(
      migrateLegacyProductData(source, target),
      /migration conflict.*settings\.yaml/i,
    )
    assert.equal(await readFile(join(source, 'settings.yaml'), 'utf8'), 'source-value\n')
    assert.equal(await readFile(join(target, 'settings.yaml'), 'utf8'), 'target-value\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('runtime installation writes the profile without seeding a jiuzhang preset', async () => {
  const home = await mkdtemp(join(tmpdir(), 'jiuzhang-harness-'))
  try {
    const result = await installRuntimeConfiguration(home)
    assert.equal(result.created.length, 3)
    assert.deepEqual(result.replaced, [])
    assert.deepEqual(result.kept, [])

    assert.match(
      await readFile(join(home, 'profiles/jiuzhang/package.json'), 'utf8'),
      /dsh-profile-jiuzhang/,
    )

    const profile = await readFile(
      join(home, 'profiles/jiuzhang/cordis.patch.yml'),
      'utf8',
    )

    // persona/safety 仍由 profile 提供，不能随 jiuzhang preset 一起丢失。
    assert.match(profile, /不得声称已经采集、学习、训练/)

    assert.deepEqual(
      (await readdir(join(home, 'profiles/jiuzhang'))).sort(),
      ['cordis.patch.yml', 'package.json', 'pnpm-workspace.yaml'],
    )

    // 关键防回归：runtime installation 不得重新 seed jiuzhang preset。
    await assert.rejects(
      readdir(join(home, '.agent-presets/jiuzhang')),
      { code: 'ENOENT' },
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('runtime installation backs up and atomically replaces drifted Ark-owned profile files', async () => {
  const home = await mkdtemp(join(tmpdir(), 'jiuzhang-harness-'))
  try {
    await installRuntimeConfiguration(home)
    const packagePath = join(home, 'profiles/jiuzhang/package.json')
    const patchPath = join(home, 'profiles/jiuzhang/cordis.patch.yml')
    const driftedPackage = JSON.stringify({
      name: 'dsh-profile-jiuzhang',
      private: true,
      dependencies: { '@admin1316/dsh-better-sidebar': 'file:/tmp/sidebar.tgz' },
      dsh: { profile: { bundles: [
        '@deepseek-ai/dsh-base',
        '@deepseek-ai/dsh-web-app',
        '@admin1316/dsh-better-sidebar',
      ] } },
    }, null, 2) + '\n'
    const driftedPatch = '# stale product profile\n[]\n'
    await writeFile(packagePath, driftedPackage, { mode: 0o600 })
    await writeFile(patchPath, driftedPatch, { mode: 0o600 })

    const result = await installRuntimeConfiguration(home)
    assert.equal(result.created.length, 0)
    assert.deepEqual(result.replaced.sort(), [packagePath, patchPath].sort())
    assert.deepEqual(result.kept, [join(home, 'profiles/jiuzhang/pnpm-workspace.yaml')])
    assert.equal(typeof result.rollback, 'string')
    const installedManifest = JSON.parse(await readFile(packagePath, 'utf8'))
    assert.deepEqual(installedManifest.dsh.profile.bundles, [
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-native-api-app',
    ])
    assert.equal(await readFile(join(result.rollback, 'profiles/jiuzhang/package.json'), 'utf8'), driftedPackage)
    assert.equal(await readFile(join(result.rollback, 'profiles/jiuzhang/cordis.patch.yml'), 'utf8'), driftedPatch)
    const rollbackManifest = JSON.parse(await readFile(join(result.rollback, 'manifest.json'), 'utf8'))
    assert.equal(rollbackManifest.version, 1)
    assert.equal(rollbackManifest.files.length, 2)
    assert.equal((await lstat(result.rollback)).mode & 0o777, 0o700)
    assert.equal((await lstat(join(result.rollback, 'manifest.json'))).mode & 0o777, 0o600)

    const repeated = await installRuntimeConfiguration(home)
    assert.deepEqual(repeated, {
      created: [],
      replaced: [],
      kept: [packagePath, patchPath, join(home, 'profiles/jiuzhang/pnpm-workspace.yaml')],
    })

    await rm(join(result.rollback, 'profiles/jiuzhang/package.json'))
    await writeFile(packagePath, driftedPackage, { mode: 0o600 })
    await writeFile(patchPath, driftedPatch, { mode: 0o600 })
    await assert.rejects(
      installRuntimeConfiguration(home),
      /rollback file is invalid|ENOENT/,
    )
    assert.equal(await readFile(packagePath, 'utf8'), driftedPackage)
    assert.equal(await readFile(patchPath, 'utf8'), driftedPatch)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('runtime installation refuses linked profile ownership paths without modifying their targets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jiuzhang-profile-link-'))
  const home = join(root, 'home')
  const outside = join(root, 'outside')
  try {
    await mkdir(home)
    await mkdir(join(outside, 'jiuzhang'), { recursive: true })
    const victim = join(outside, 'jiuzhang', 'package.json')
    await writeFile(victim, 'outside-victim\n', { mode: 0o600 })
    await symlink(outside, join(home, 'profiles'))

    await assert.rejects(
      installRuntimeConfiguration(home),
      /not an ordinary directory/,
    )
    assert.equal(await readFile(victim, 'utf8'), 'outside-victim\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('runtime installation refuses hard-linked profile files without modifying the shared inode', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jiuzhang-profile-hardlink-'))
  const home = join(root, 'home')
  const victim = join(root, 'victim.json')
  try {
    await installRuntimeConfiguration(home)
    const packagePath = join(home, 'profiles/jiuzhang/package.json')
    await rm(packagePath)
    await writeFile(victim, 'hard-link-victim\n', { mode: 0o600 })
    await link(victim, packagePath)

    await assert.rejects(
      installRuntimeConfiguration(home),
      /not an ordinary single-link file/,
    )
    assert.equal(await readFile(victim, 'utf8'), 'hard-link-victim\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('runtime installation refuses a profile directory writable by other users', async () => {
  const home = await mkdtemp(join(tmpdir(), 'jiuzhang-profile-mode-'))
  try {
    await installRuntimeConfiguration(home)
    const profileRoot = join(home, 'profiles', 'jiuzhang')
    await chmod(profileRoot, 0o777)
    await assert.rejects(
      installRuntimeConfiguration(home),
      /writable by group or others/,
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('runtime installation refuses a linked rollback root before replacing drift', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jiuzhang-rollback-link-'))
  const home = join(root, 'home')
  const outside = join(root, 'outside')
  try {
    await installRuntimeConfiguration(home)
    const packagePath = join(home, 'profiles/jiuzhang/package.json')
    const drift = 'drift-before-linked-rollback\n'
    await writeFile(packagePath, drift, { mode: 0o600 })
    await mkdir(outside)
    await symlink(outside, join(home, '.ark-profile-rollbacks'))

    await assert.rejects(
      installRuntimeConfiguration(home),
      /not an ordinary directory/,
    )
    assert.equal(await readFile(packagePath, 'utf8'), drift)
    assert.deepEqual(await readdir(outside), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('launch environment is local, read-only, and telemetry-disabled by default', () => {
  const env = createLaunchEnvironment('/tmp/jiuzhang-home', {
    PATH: '/usr/bin',
    HOME: '/Users/tester',
    LANG: 'zh_CN.UTF-8',
    DEEPSEEK_API_KEY: 'must-not-leak',
    HTTP_PROXY: 'http://must-not-leak.invalid',
    NODE_OPTIONS: '--require=/tmp/must-not-load.cjs',
  })
  assert.equal(env.DSH_HOME, '/tmp/jiuzhang-home')
  assert.equal(env.DSH_PERMISSION_MODE, 'read-only')
  assert.equal(env.DSH_TELEMETRY_DISABLED, '1')
  assert.match(env.DSH_API_TOKEN, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(env.PATH, '/usr/bin')
  assert.equal(env.HOME, '/Users/tester')
  assert.equal(env.LANG, 'zh_CN.UTF-8')
  assert.equal(env.DEEPSEEK_API_KEY, undefined)
  assert.equal(env.HTTP_PROXY, undefined)
  assert.equal(env.NODE_OPTIONS, '--max-old-space-size=4096')
  assert.equal(env.NODE_OPTIONS.includes('--require'), false)

  const native = createLaunchEnvironment('/tmp/jiuzhang-home', {
    PATH: '/usr/bin',
    DSH_API_TOKEN: 'native-launch-token',
  })
  assert.equal(native.DSH_API_TOKEN, 'native-launch-token')
})

test('the launcher resolves the dedicated built Ark native API runner', async () => {
  const path = await resolveBuiltArkNativeRunner()
  assert.match(path, /packages\/boot\/native-api-runner\/lib\/bin\.js$/)
})

test('ordinary user preset directory permissions remain readable without weakening recovery privacy', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ark-preset-parent-mode-'))
  const parent = join(home, '.agent-presets')
  try {
    await mkdir(parent, { mode: 0o755 })
    await chmod(parent, 0o755)
    assert.equal((await purgeReservedJiuzhangPreset(home)).status, 'absent')
    assert.equal((await lstat(parent)).mode & 0o777, 0o755)
    await mkdir(join(parent, 'jiuzhang'), { mode: 0o755 })
    await writeFile(join(parent, 'jiuzhang', 'preset.json'), '{}')
    const recovered = await purgeReservedJiuzhangPreset(home)
    assert.equal(recovered.status, 'recovered')
    assert.equal((await lstat(dirname(recovered.recovery))).mode & 0o777, 0o700)
    await chmod(parent, 0o777)
    await assert.rejects(purgeReservedJiuzhangPreset(home), /writable by group or others/)
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('only the dedicated Native runner resolves the jiuzhang profile with dangerous tools disabled and public fetch enabled', async () => {
  const home = await mkdtemp(join(tmpdir(), 'jiuzhang-harness-'))
  try {
    await installRuntimeConfiguration(home)
    await assert.rejects(
      execFileAsync(
        process.execPath,
        ['--import', 'tsx', join(resolveRepositoryRoot(), 'apps/cli/src/bin.ts'), '--profile', 'jiuzhang', '--dump-config'],
        { env: createLaunchEnvironment(home, process.env), maxBuffer: 2_000_000 },
      ),
      /cannot resolve profile bundle "@deepseek-ai\/dsh-native-api-app"/,
    )
    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
    const nativeAnchor = join(
      resolveRepositoryRoot(),
      'packages/boot/native-api-runner/package.json',
    )
    const profile = prepareProfile('jiuzhang', nativeAnchor)
    const rows = composeEntries([
      profile.layers.flatMap(layer => layer.patches),
      profile.patches,
    ])
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    const byId = new Map(rows.map(row => [row.id, row]))
    assert.equal(byId.get('agent-presets')?.config?.default, 'standard')
    assert.equal(byId.get('session-telemetry-otel')?.disabled, true)
    for (const toolId of [
      'tool-bash',
      'tool-pwsh',
      'tool-fs',
      'tool-fs-search',
      'tool-subagent',
      'tool-workflow',
      'tool-str-replace-editor',
    ]) {
      assert.equal(byId.get(toolId)?.disabled, true, `${toolId} remains disabled on the Host plane`)
    }
    assert.notEqual(byId.get('web-fetch-http')?.disabled, true, 'the SSRF-protected fetch provider remains on the Host plane')
    assert.equal(byId.get('tool-web')?.disabled, true, 'the model-facing web tool is mounted only by Agent presets')
    assert.equal(byId.get('tool-web')?.config?.fetch, true, 'Agent-scoped public web_fetch uses the SSRF-protected provider')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('runtime installation preserves an existing user settings document', async () => {
  const home = await mkdtemp(join(tmpdir(), 'jiuzhang-harness-'))
  try {
    const settingsPath = join(home, 'settings.yaml')
    const userSettings = 'agent-presets:\n  default: cordis\npermission:\n  defaultPreset: workspace-write\n'
    await writeFile(settingsPath, userSettings, 'utf8')
    const result = await installRuntimeConfiguration(home)
    assert.equal(result.created.length, 3)
    assert.equal(await readFile(settingsPath, 'utf8'), userSettings)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('the same launcher pair serves a standalone runtime rooted beside its assets and runner', async () => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), 'jiuzhang-runtime-'))
  try {
    // Assemble the standalone layout: product files under jiuzhang/, the
    // installed Native API runner under node_modules, and the launcher pair at the
    // runtime root — exactly what build-app.sh records as JiuzhangRuntimeRoot.
    const assetRoot = join(runtimeRoot, 'jiuzhang')
    const integrationRoot = dirname(fileURLToPath(new URL('.', import.meta.url)))
    await cp(join(integrationRoot, 'profile'), join(assetRoot, 'profile'), { recursive: true })
    const standaloneArkRunner = join(
      runtimeRoot,
      'node_modules',
      '@deepseek-ai',
      'dsh-native-api-runner',
      'lib',
      'bin.js',
    )
    await mkdir(dirname(standaloneArkRunner), { recursive: true })
    await writeFile(standaloneArkRunner, '#!/usr/bin/env node\n', { mode: 0o755 })
    // The closure checker walks dependency edges from the root manifest's
    // dependencies, so the fixture must materialize the real transitive runtime
    // dependencies of the required packages too. Resolve them from the
    // repository's actual installs — never hardcoded paths or versions.
    const repoRequire = createRequire(import.meta.url)
    const findNearestPackageRoot = async (entryPath) => {
      let dir = dirname(entryPath)
      for (;;) {
        try {
          await readFile(join(dir, 'package.json'))
          return dir
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error
          const parent = dirname(dir)
          if (parent === dir) throw new Error(`no package.json above ${entryPath}`)
          dir = parent
        }
      }
    }
    const jsYamlRoot = await findNearestPackageRoot(repoRequire.resolve('js-yaml'))
    const jsYamlRequire = createRequire(join(jsYamlRoot, 'package.json'))
    const jsYamlManifest = JSON.parse(await readFile(join(jsYamlRoot, 'package.json'), 'utf8'))
    const jsYamlDependencyNames = Object.keys(jsYamlManifest.dependencies ?? {})
    for (const dependencyName of jsYamlDependencyNames) {
      const dependencyRoot = await findNearestPackageRoot(jsYamlRequire.resolve(dependencyName))
      const dependencyManifest = JSON.parse(await readFile(join(dependencyRoot, 'package.json'), 'utf8'))
      if (dependencyManifest.name !== dependencyName) {
        throw new Error(`resolved package ${dependencyManifest.name} for dependency ${dependencyName}`)
      }
      // Fail closed: the fixture only materializes one level of transitive
      // dependencies, so a deeper chain must never be silently flattened.
      const nestedDependencies = Object.keys(dependencyManifest.dependencies ?? {})
      if (nestedDependencies.length > 0) {
        throw new Error(
          `fixture materialization cannot flatten dependency ${dependencyName}: ${nestedDependencies.join(', ')}`,
        )
      }
      await cp(
        dependencyRoot,
        join(runtimeRoot, 'node_modules', ...dependencyName.split('/')),
        { recursive: true, dereference: true },
      )
    }
    for (const name of runtimePolicy.required) {
      const packageRoot = join(runtimeRoot, 'node_modules', ...name.split('/'))
      if (name === 'js-yaml') {
        // The closure checker itself requires js-yaml, so the standalone
        // layout must carry the real package, not a name-only stub.
        await cp(
          fileURLToPath(new URL('../../../node_modules/js-yaml', import.meta.url)),
          packageRoot,
          { recursive: true, dereference: true },
        )
        continue
      }
      await mkdir(packageRoot, { recursive: true })
      await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name, version: '0.0.0' }))
    }
    for (const asset of runtimePolicy.requiredFiles) {
      const destination = join(runtimeRoot, asset)
      await mkdir(dirname(destination), { recursive: true })
      await cp(runtimeAssetSource(dirname(dirname(integrationRoot)), asset), destination)
    }
    await writeFile(
      join(runtimeRoot, 'package.json'),
      JSON.stringify({
        name: 'ark-native-runtime-current',
        version: '0.0.0',
        // The closure checker starts its reachability walk from these names, so
        // the stub-installed required packages must be declared even though the
        // fixture does not install real manifests for them.
        dependencies: Object.fromEntries(runtimePolicy.required.map(name => [name, '0.0.0'])),
      }),
    )

    const standalone = await import(`${pathToFileURL(join(runtimeRoot, 'runtime.mjs')).href}?standalone=${Date.now()}`)
    assert.equal(await standalone.resolveBuiltArkNativeRunner(), await realpath(standaloneArkRunner))
    assert.deepEqual(
      await standalone.assertStandaloneRuntimeClosure(),
      // Required packages plus js-yaml's directly materialized runtime dependencies.
      { packageCount: runtimePolicy.required.length + jsYamlDependencyNames.length },
    )
    assert.equal(standalone.resolveRepositoryRoot(), await realpath(runtimeRoot))

    const home = await mkdtemp(join(tmpdir(), 'jiuzhang-harness-'))
    try {
      const result = await standalone.installRuntimeConfiguration(home)
      assert.equal(result.created.length, 3)
      await assert.rejects(
        readdir(join(home, '.agent-presets/jiuzhang')),
        { code: 'ENOENT' },
      )
      assert.deepEqual(
        (await readdir(join(home, 'profiles/jiuzhang'))).sort(),
        ['cordis.patch.yml', 'package.json', 'pnpm-workspace.yaml'],
      )

      const packageStore = join(runtimeRoot, 'package-store', 'fallback-test')
      const runtimeLink = join(runtimeRoot, 'node_modules', '@deepseek-ai', 'fallback-test')
      await mkdir(packageStore, { recursive: true })
      await writeFile(
        join(packageStore, 'package.json'),
        JSON.stringify({ name: '@deepseek-ai/fallback-test' }),
      )
      await symlink(packageStore, runtimeLink)
      assert.deepEqual(
        await standalone.ensureProfileModuleFallback(home),
        { created: 1, replaced: 0, kept: 0, pruned: 0 },
      )
      const profileScope = join(home, 'profiles', 'node_modules', '@deepseek-ai')
      assert.equal(
        await readlink(join(profileScope, 'fallback-test')),
        join(await realpath(runtimeRoot), 'node_modules', '@deepseek-ai', 'fallback-test'),
      )

      const stale = join(profileScope, 'stale')
      await symlink(packageStore, stale)
      assert.deepEqual(
        await standalone.ensureProfileModuleFallback(home),
        { created: 0, replaced: 0, kept: 1, pruned: 1 },
      )
      await assert.rejects(lstat(stale), { code: 'ENOENT' })

      const unsafeHome = await mkdtemp(join(tmpdir(), 'jiuzhang-fallback-link-'))
      const outside = await mkdtemp(join(tmpdir(), 'jiuzhang-fallback-outside-'))
      try {
        await standalone.installRuntimeConfiguration(unsafeHome)
        await symlink(outside, join(unsafeHome, 'profiles', 'node_modules'))
        await assert.rejects(
          standalone.ensureProfileModuleFallback(unsafeHome),
          /not an ordinary directory/,
        )
        assert.deepEqual(await readdir(outside), [])
      } finally {
        await rm(unsafeHome, { recursive: true, force: true })
        await rm(outside, { recursive: true, force: true })
      }
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  } finally {
    await rm(runtimeRoot, { recursive: true, force: true })
  }
})

test('a failed migration leaves no completion marker and a retry converges', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ark-data-migration-'))
  const source = join(root, 'legacy', 'Harness')
  const target = join(root, 'Ark', 'Harness')
  try {
    await mkdir(source, { recursive: true })
    await writeFile(join(source, 'settings.yaml'), 'agent-presets:\n  default: code\npermission:\n  defaultPreset: workspace-write\n')
    // A conflicting record path makes the first attempt copy the data and then
    // fail recording the import — the exact failure that used to leave the
    // completion marker behind and wrongly report "already-migrated" on retry.
    await mkdir(join(target, '.ark-settings-import.json'), { recursive: true })
    await assert.rejects(migrateLegacyProductData(source, target))
    await assert.rejects(
      readFile(join(target, '.ark-product-data-migration-v1'), 'utf8'),
      (error) => error?.code === 'ENOENT',
    )
    assert.deepEqual(
      (await readdir(target)).filter((entry) => entry.endsWith('.tmp')),
      [],
    )

    // The retry converges: no "already-migrated" shortcut, the record is
    // written, and the marker commits last as an ordinary 0600 file.
    await rm(join(target, '.ark-settings-import.json'), { recursive: true, force: true })
    const result = await migrateLegacyProductData(source, target)
    assert.equal(result.status, 'migrated')
    const record = JSON.parse(await readFile(join(target, '.ark-settings-import.json'), 'utf8'))
    assert.equal(record.agentPresetDefault, 'code')
    assert.equal(record.permissionPresetDefault, 'workspace-write')
    const marker = join(target, '.ark-product-data-migration-v1')
    assert.equal(await readFile(marker, 'utf8'), 'version: 1\n')
    assert.equal((await lstat(marker)).mode & 0o777, 0o600)
    assert.equal((await migrateLegacyProductData(source, target)).status, 'already-migrated')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('legacy migration records imported non-default settings for audit and rollback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ark-data-migration-'))
  const source = join(root, 'legacy', 'Harness')
  const target = join(root, 'Ark', 'Harness')
  try {
    await mkdir(source, { recursive: true })
    await writeFile(join(source, 'settings.yaml'), 'agent-presets:\n  default: code\npermission:\n  defaultPreset: workspace-write\n')

    const result = await migrateLegacyProductData(source, target)
    assert.equal(result.status, 'migrated')

    const record = JSON.parse(await readFile(join(target, '.ark-settings-import.json'), 'utf8'))
    assert.equal(record.version, 1)
    assert.equal(record.agentPresetDefault, 'code')
    assert.equal(record.permissionPresetDefault, 'workspace-write')
    assert.ok(Number.isFinite(Date.parse(record.importedAt)))

    assert.match(await readFile(join(target, 'settings.yaml'), 'utf8'), /default: code/)
    assert.match(await readFile(join(source, 'settings.yaml'), 'utf8'), /default: code/)

    // The GUI-facing pending-decision section lands in settings.yaml once.
    const targetSettings = await readFile(join(target, 'settings.yaml'), 'utf8')
    assert.match(targetSettings, /^ark-import:\n  agentPresetDefault: code\n  permissionPresetDefault: workspace-write\n  pending: true\n  choice: none/m)
    await writeFile(join(target, 'settings.yaml'), targetSettings.replace('pending: true', 'pending: false'))
    await migrateLegacyProductData(source, target).catch(() => {})
    // Idempotent: the section is not appended twice even when re-migration is attempted.
    assert.equal((await readFile(join(target, 'settings.yaml'), 'utf8')).match(/^ark-import:/gm)?.length, 1)

    const read = await readSettingsImportRecord(target)
    assert.deepEqual(read, { agentPresetDefault: 'code', permissionPresetDefault: 'workspace-write' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('legacy migration writes no import record when settings match the Ark safe defaults', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ark-data-migration-'))
  const source = join(root, 'legacy', 'Harness')
  const target = join(root, 'Ark', 'Harness')
  try {
    await mkdir(source, { recursive: true })
    await writeFile(join(source, 'settings.yaml'), 'agent-presets:\n  default: jiuzhang\npermission:\n  defaultPreset: read-only\n')
    await migrateLegacyProductData(source, target)
    await assert.rejects(
      readFile(join(target, '.ark-settings-import.json'), 'utf8'),
      (error) => error?.code === 'ENOENT',
    )
    assert.equal(await readSettingsImportRecord(target), undefined)
    assert.doesNotMatch(await readFile(join(target, 'settings.yaml'), 'utf8'), /^ark-import:/m)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('launch seeds one ready-to-use Ollama provider and never rewrites user edits', async () => {
  const home = await mkdtemp(join(tmpdir(), 'jiuzhang-harness-'))
  try {
    await seedLocalModelProvider(home)
    const seeded = await readFile(join(home, 'settings.yaml'), 'utf8')
    assert.match(seeded, /^llm-pi-ai:/m)
    assert.match(seeded, /providers:\n    ollama:/)
    assert.match(seeded, /baseURL: http:/)
    assert.match(seeded, /127\.0\.0\.1:11434/)

    // Idempotent: a second seed leaves the file untouched.
    await seedLocalModelProvider(home)
    assert.equal(await readFile(join(home, 'settings.yaml'), 'utf8'), seeded)

    // User edits (any llm-pi-ai section) are never overwritten.
    await writeFile(join(home, 'settings.yaml'), 'llm-pi-ai:\n  providers:\n    custom: {}\n')
    await seedLocalModelProvider(home)
    assert.match(await readFile(join(home, 'settings.yaml'), 'utf8'), /providers:\n    custom/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('startup recovery preserves the reserved legacy jiuzhang preset with a deterministic receipt', async () => {
  const home = await mkdtemp(join(tmpdir(), 'jiuzhang-harness-'))
  try {
    const legacy = join(home, '.agent-presets', 'jiuzhang')
    await mkdir(join(home, '.agent-presets'), { mode: 0o700 })
    await mkdir(legacy, { mode: 0o755 })
    await writeFile(join(legacy, 'preset.yml'), 'name: Ark\n', 'utf8')
    await symlink('../preset.yml', join(legacy, 'preserved-link'))

    const first = await purgeReservedJiuzhangPreset(home)
    assert.equal(first.status, 'recovered')
    assert.equal(
      first.recovery,
      join(home, '.ark-startup-recovery', 'reserved-agent-presets', 'jiuzhang', 'payload'),
    )
    assert.equal(await readFile(join(first.recovery, 'preset.yml'), 'utf8'), 'name: Ark\n')
    assert.equal(await readlink(join(first.recovery, 'preserved-link')), '../preset.yml')
    await assert.rejects(lstat(legacy), { code: 'ENOENT' })

    const receiptBytes = await readFile(first.receipt, 'utf8')
    const receipt = JSON.parse(receiptBytes)
    assert.equal(receipt.version, 1)
    assert.equal(receipt.operation, 'recover-reserved-jiuzhang-preset')
    assert.equal(receipt.recovery, '.ark-startup-recovery/reserved-agent-presets/jiuzhang/payload')
    assert.match(receipt.treeSha256, /^[0-9a-f]{64}$/)
    assert.equal((await lstat(first.receipt)).mode & 0o777, 0o600)

    // Idempotent: the recovery and receipt bytes stay unchanged, and another
    // user preset is never moved or removed.
    await mkdir(join(home, '.agent-presets', 'my-own'), { mode: 0o700 })
    const second = await purgeReservedJiuzhangPreset(home)
    assert.equal(second.status, 'already-recovered')
    assert.equal(await readFile(second.receipt, 'utf8'), receiptBytes)
    assert.deepEqual(
      (await readdir(join(home, '.agent-presets'))).sort(),
      ['my-own'],
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('startup recovery rejects symlinked preset ancestors and targets without touching outside data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jiuzhang-preset-links-'))
  const home = join(root, 'home')
  const outside = join(root, 'outside')
  try {
    await mkdir(home, { mode: 0o700 })
    await mkdir(outside, { mode: 0o700 })
    const victim = join(outside, 'victim.txt')
    await writeFile(victim, 'keep\n')
    await symlink(outside, join(home, '.agent-presets'))

    await assert.rejects(
      purgeReservedJiuzhangPreset(home),
      /not an ordinary directory/,
    )
    assert.equal(await readFile(victim, 'utf8'), 'keep\n')

    await unlink(join(home, '.agent-presets'))
    await mkdir(join(home, '.agent-presets'), { mode: 0o700 })
    await symlink(outside, join(home, '.agent-presets', 'jiuzhang'))
    await assert.rejects(
      purgeReservedJiuzhangPreset(home),
      /not an ordinary directory/,
    )
    assert.equal(await readFile(victim, 'utf8'), 'keep\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('startup recovery refuses an outside recovery escape and leaves the legacy directory in place', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jiuzhang-preset-escape-'))
  const home = join(root, 'home')
  const outside = join(root, 'outside')
  try {
    const legacy = join(home, '.agent-presets', 'jiuzhang')
    await mkdir(legacy, { recursive: true, mode: 0o700 })
    await writeFile(join(legacy, 'preset.yml'), 'name: Ark\n')
    await mkdir(outside, { mode: 0o700 })
    await symlink(outside, join(home, '.ark-startup-recovery'))

    await assert.rejects(
      purgeReservedJiuzhangPreset(home),
      /not an ordinary directory/,
    )
    assert.equal(await readFile(join(legacy, 'preset.yml'), 'utf8'), 'name: Ark\n')
    assert.deepEqual(await readdir(outside), [])

    await unlink(join(home, '.ark-startup-recovery'))
    const recoveryRoot = join(home, '.ark-startup-recovery', 'reserved-agent-presets', 'jiuzhang')
    await mkdir(recoveryRoot, { recursive: true, mode: 0o700 })
    await symlink(outside, join(recoveryRoot, 'payload'))
    await assert.rejects(
      purgeReservedJiuzhangPreset(home),
      /not an ordinary directory/,
    )
    assert.equal(await readFile(join(legacy, 'preset.yml'), 'utf8'), 'name: Ark\n')
    assert.deepEqual(await readdir(outside), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('startup recovery rejects a symlinked Harness home without following it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jiuzhang-home-link-'))
  const actual = join(root, 'actual')
  const alias = join(root, 'alias')
  try {
    const legacy = join(actual, '.agent-presets', 'jiuzhang')
    await mkdir(legacy, { recursive: true, mode: 0o700 })
    await writeFile(join(legacy, 'preset.yml'), 'name: Ark\n')
    await symlink(actual, alias)

    await assert.rejects(
      purgeReservedJiuzhangPreset(alias),
      /not an ordinary directory/,
    )
    assert.equal(await readFile(join(legacy, 'preset.yml'), 'utf8'), 'name: Ark\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
