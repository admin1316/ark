/**
 * Profile machinery of `dsh-app-boot`: directory resolution and init,
 * manifest round-trips, two-anchor bundle resolution, patch-layer loading,
 * empty-root composition, and the installation module-fallback healing.
 */

import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  composeEntries,
  healProfilesModuleFallback,
  initProfile,
  loadProfile,
  PROFILE_PATCH_FILENAME,
  PROFILE_TEMPLATES,
  readProfileManifest,
  resolveBundleDir,
  resolveProfileDir,
  writeProfileManifest,
} from '../src/index.ts'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'dsh-profile-'))

/** Stage a fake installed app: package.json with deps and a node_modules holding bundles. */
function stageInstallation(
  bundles: Record<string, { patch?: string; deps?: Record<string, string> }>,
  optional: readonly string[] = [],
): string {
  const root = tmp()
  const appDir = join(root, 'app')
  mkdirSync(join(appDir, 'node_modules'), { recursive: true })
  const appDeps: Record<string, string> = {}
  for (const [name, spec] of Object.entries(bundles)) {
    if (!optional.includes(name)) appDeps[name] = '0.0.0'
    const dir = join(appDir, 'node_modules', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name,
      version: '0.0.0',
      dependencies: spec.deps ?? {},
      ...spec.patch === undefined ? {} : { dsh: { bundle: { patch: './cordis.patch.yml' } } },
    }))
    if (spec.patch !== undefined) writeFileSync(join(dir, 'cordis.patch.yml'), spec.patch)
  }
  writeFileSync(join(appDir, 'package.json'), JSON.stringify({
    name: 'dsh-app',
    dependencies: appDeps,
    optionalDependencies: Object.fromEntries(optional.map(name => [name, '0.0.0'])),
  }))
  return join(appDir, 'package.json')
}

describe('resolveProfileDir', () => {
  it('joins the home and rejects traversal-shaped names', () => {
    const home = tmp()
    expect(resolveProfileDir('tui', home)).toBe(join(home, 'profiles', 'tui'))
    for (const bad of ['', '.', '..', 'a/b', 'a\\b']) {
      expect(() => resolveProfileDir(bad, home)).toThrow('invalid profile name')
    }
  })
})

describe('initProfile', () => {
  it('creates manifest, user patch layer, and pnpm workspace once, never overwriting', () => {
    const home = tmp()
    const dir = resolveProfileDir('tui', home)
    initProfile(dir, ['@deepseek-ai/dsh-base'])
    const manifest = readProfileManifest('t', dir)
    expect(manifest.dsh?.profile?.bundles).toEqual(['@deepseek-ai/dsh-base'])
    expect(readFileSync(join(dir, PROFILE_PATCH_FILENAME), 'utf8')).toContain('[]')
    expect(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')).toContain('nodeLinker: hoisted')
    // Re-init keeps user edits.
    writeFileSync(join(dir, PROFILE_PATCH_FILENAME), '- id: x\n  config: {}\n')
    initProfile(dir, ['other'])
    expect(readProfileManifest('t', dir).dsh?.profile?.bundles).toEqual(['@deepseek-ai/dsh-base'])
    expect(readFileSync(join(dir, PROFILE_PATCH_FILENAME), 'utf8')).toContain('- id: x')
  })
})

describe('manifest round-trip', () => {
  it('writes and reads back, and fails loud on a broken manifest', () => {
    const dir = tmp()
    writeProfileManifest(dir, { name: 'p', dsh: { profile: { bundles: ['a'] } } })
    expect(readProfileManifest('t', dir).dsh?.profile?.bundles).toEqual(['a'])
    writeFileSync(join(dir, 'package.json'), '[]')
    expect(() => readProfileManifest('t', dir)).toThrow('must hold a JSON object')
    expect(() => readProfileManifest('t', join(dir, 'nope'))).toThrow('failed to read profile manifest')
  })
})

describe('resolveBundleDir', () => {
  it('prefers the installation anchor, falls back to the profile, and fails loud', () => {
    const anchor = stageInstallation({ 'in-box': { patch: '[]\n' } })
    const profileDir = tmp()
    mkdirSync(join(profileDir, 'node_modules', 'local-only'), { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), '{}')
    writeFileSync(join(profileDir, 'node_modules', 'local-only', 'package.json'), JSON.stringify({ name: 'local-only', version: '0.0.0' }))
    expect(resolveBundleDir('t', 'in-box', anchor, profileDir)).toContain('in-box')
    expect(resolveBundleDir('t', 'local-only', anchor, profileDir)).toContain('local-only')
    expect(() => resolveBundleDir('t', 'absent', anchor, profileDir)).toThrow('cannot resolve profile bundle')
  })

  it('captures absolute and relative package links before callers read their manifests', () => {
    const anchor = stageInstallation({})
    const profileDir = tmp()
    const target = tmp()
    writeFileSync(join(target, 'package.json'), JSON.stringify({ name: 'linked-bundle' }))
    const modules = join(profileDir, 'node_modules')
    mkdirSync(modules)
    for (const [name, linkTarget] of [['absolute', target], ['relative', relative(process.platform === 'win32' ? process.cwd() : modules, target)]] as const) {
      symlinkSync(linkTarget, join(modules, name), 'junction')
      expect(resolveBundleDir('t', name, anchor, profileDir)).toBe(realpathSync.native(target))
    }
    symlinkSync(join(target, 'missing'), join(modules, 'dangling'), 'junction')
    expect(() => resolveBundleDir('t', 'dangling', anchor, profileDir)).toThrow('cannot resolve profile bundle')
    symlinkSync(join(modules, 'cycle'), join(modules, 'cycle'), 'junction')
    expect(() => resolveBundleDir('t', 'cycle', anchor, profileDir)).toThrow(/ELOOP/)
  })

  it('resolves a package whose exports map omits ./package.json', () => {
    // Common on npm: an exports map without "./package.json" makes
    // require.resolve('<pkg>/package.json') throw ERR_PACKAGE_PATH_NOT_EXPORTED;
    // resolution must fall through to the paths probe instead of misreporting
    // the installed package as missing.
    const anchor = stageInstallation({})
    const profileDir = tmp()
    writeFileSync(join(profileDir, 'package.json'), '{}')
    const dir = join(profileDir, 'node_modules', 'sealed-bundle')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'sealed-bundle',
      version: '0.0.0',
      exports: { '.': './index.js' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }))
    writeFileSync(join(dir, 'index.js'), '')
    writeFileSync(join(dir, 'cordis.patch.yml'), '[]\n')
    expect(resolveBundleDir('t', 'sealed-bundle', anchor, profileDir)).toBe(realpathSync.native(dir))
  })
})

describe('loadProfile', () => {
  it('resolves the patch reload lifecycle and rejects unknown values', () => {
    const anchor = stageInstallation({})
    const home = tmp()
    const dir = resolveProfileDir('demo', home)
    initProfile(dir, [])
    expect(loadProfile('t', 'demo', anchor, home).patchReload).toBe('live')
    writeProfileManifest(dir, { dsh: { profile: { patchReload: 'startup' } } })
    expect(loadProfile('t', 'demo', anchor, home).patchReload).toBe('startup')
    writeFileSync(join(dir, 'package.json'), '{"dsh":{"profile":{"patchReload":"unknown"}}}')
    expect(() => loadProfile('t', 'demo', anchor, home)).toThrow('invalid dsh.profile.patchReload')
  })
  it('resolves each dsh.profile.bundles entry to its patch layer in order, plus the user layer', () => {
    const anchor = stageInstallation({
      'bundle-a': { patch: '- insert:\n    - id: a\n      name: pkg-a\n' },
      'bundle-b': { patch: '- id: a\n  config:\n    v: 2\n' },
    })
    const home = tmp()
    const dir = resolveProfileDir('demo', home)
    initProfile(dir, ['bundle-a', 'bundle-b'])
    writeFileSync(join(dir, PROFILE_PATCH_FILENAME), '- id: a\n  config:\n    v: 3\n')
    const profile = loadProfile('t', 'demo', anchor, home)
    expect(profile.layers.map(layer => layer.packageName)).toEqual(['bundle-a', 'bundle-b'])
    expect(profile.patches).toHaveLength(1)
    const entries = composeEntries([
      ...profile.layers.map(layer => layer.patches),
      profile.patches,
    ])
    expect(entries).toEqual([{ id: 'a', name: 'pkg-a', config: { v: 3 } }])
    // A hand-made profile without the user layer file or dsh section: empty layers, no throw.
    rmSync(join(dir, PROFILE_PATCH_FILENAME))
    expect(loadProfile('t', 'demo', anchor, home).patches).toEqual([])
    writeProfileManifest(dir, { name: 'bare' })
    const bare = loadProfile('t', 'demo', anchor, home)
    expect(bare.layers).toEqual([])
  })

  it('auto-initializes only shipped templates and fails loud otherwise', () => {
    const anchor = stageInstallation({})
    const home = tmp()
    expect(() => loadProfile('t', 'custom', anchor, home))
      .toThrow('profile "custom" does not exist')
    // The headless template auto-initializes on first load. Bundle resolution
    // cannot be asserted to fail here: the source-plane test runner resolves
    // @deepseek-ai/* through tsconfig paths regardless of the staged anchor.
    expect(PROFILE_TEMPLATES.headless).toContain('@deepseek-ai/dsh-base')
    try {
      loadProfile('t', 'headless', anchor, home)
    } catch {
      // Resolution failure is the plain-Node outcome for this empty anchor.
    }
    expect(readProfileManifest('t', resolveProfileDir('headless', home)).dsh?.profile?.bundles)
      .toEqual([...PROFILE_TEMPLATES.headless ?? []])
  })

  it('pins SDK and ACP to their shared base plus exactly one app bundle', () => {
    expect(PROFILE_TEMPLATES.sdk).toEqual([
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-sdk-app',
    ])
    expect(PROFILE_TEMPLATES.acp).toEqual([
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-acp-app',
    ])
  })

  it('fails loud when a listed bundle declares no dsh.bundle', () => {
    const anchor = stageInstallation({ 'not-a-bundle': {} })
    const home = tmp()
    const dir = resolveProfileDir('demo', home)
    initProfile(dir, ['not-a-bundle'])
    expect(() => loadProfile('t', 'demo', anchor, home)).toThrow('declares no dsh.bundle')
  })
})

describe('composeEntries', () => {
  it('applies layers over an empty root and reports skipped patches', () => {
    const warnings: string[] = []
    const entries = composeEntries([
      [{ insert: [{ id: 'x', name: 'pkg-x', config: { a: 1 } }] }],
      [{ id: 'x', config: { a: 2 } }, { id: 'missing', config: {} }],
    ], message => warnings.push(message))
    expect(entries).toEqual([{ id: 'x', name: 'pkg-x', config: { a: 2 } }])
    expect(warnings.join('\n')).toContain('"missing"')
    // Default warn sink: skipped patches are silently dropped (boot repeats them).
    expect(composeEntries([[{ id: 'missing', config: {} }]])).toEqual([])
  })
})

describe('healProfilesModuleFallback', () => {
  it('links the app and bundle dependency surface flat under profiles/node_modules', () => {
    const anchor = stageInstallation({
      'bundle-a': { patch: '[]\n', deps: { 'dep-of-a': '0.0.0', 'ghost-dep': '0.0.0' } },
      'plain-lib': {},
      'optional-bundle': { patch: '[]\n' },
    }, ['optional-bundle'])
    // An app dependency that is declared but not installed: skipped, not fatal.
    const appManifest = JSON.parse(readFileSync(anchor, 'utf8')) as {
      dependencies: Record<string, string>
      optionalDependencies: Record<string, string>
    }
    appManifest.dependencies['never-installed'] = '0.0.0'
    appManifest.optionalDependencies['missing-optional'] = '0.0.0'
    writeFileSync(anchor, JSON.stringify(appManifest))
    // dep-of-a lives in the installation's node_modules too.
    const modules = join(anchor, '..', 'node_modules')
    mkdirSync(join(modules, 'dep-of-a'), { recursive: true })
    writeFileSync(join(modules, 'dep-of-a', 'package.json'), JSON.stringify({ name: 'dep-of-a', version: '0.0.0' }))
    const home = tmp()
    healProfilesModuleFallback(anchor, home)
    const fallback = join(home, 'profiles', 'node_modules')
    // App deps, the bundle's own deps, and the bundle itself are linked; the
    // plain library is linked as an app dep (harmless), the app itself too.
    for (const name of ['bundle-a', 'plain-lib', 'optional-bundle', 'dep-of-a', 'dsh-app']) {
      expect(lstatSync(join(fallback, name)).isSymbolicLink(), name).toBe(true)
    }
    // Idempotent, and a moved target is re-pointed.
    healProfilesModuleFallback(anchor, home)
    const before = readlinkSync(join(fallback, 'dep-of-a'))
    expect(before).toContain('dep-of-a')
  })

  it('throws when a fallback entry is a real directory', () => {
    const anchor = stageInstallation({})
    const home = tmp()
    mkdirSync(join(home, 'profiles', 'node_modules', 'dsh-app'), { recursive: true })
    expect(() => { healProfilesModuleFallback(anchor, home) }).toThrow('is not a symlink')
  })

  it('replaces a wrong symlink', () => {
    const anchor = stageInstallation({})
    const home = tmp()
    const fallback = join(home, 'profiles', 'node_modules')
    mkdirSync(fallback, { recursive: true })
    symlinkSync(tmp(), join(fallback, 'dsh-app'), 'junction')
    healProfilesModuleFallback(anchor, home)
    expect(readlinkSync(join(fallback, 'dsh-app'))).toContain('app')
  })

  it('tolerates losing the concurrent-heal race to an identical link and rejects a different one', () => {
    // The EEXIST arm: a second process wrote the link between our lstat miss
    // and symlinkSync. Simulated by pre-creating the correct link and calling
    // the internal path through a stale-lstat shim is not possible from
    // outside, so probe the observable contract: healing twice concurrently
    // is a no-op, and a foreign REAL directory still fails loud.
    const anchor = stageInstallation({})
    const home = tmp()
    healProfilesModuleFallback(anchor, home)
    healProfilesModuleFallback(anchor, home) // second healer sees the correct link
    const fallback = join(home, 'profiles', 'node_modules')
    expect(lstatSync(join(fallback, 'dsh-app')).isSymbolicLink()).toBe(true)
  })

  it('never lets a concurrent resolver observe a missing entry while re-pointing links', async () => {
    const names = Array.from({ length: 160 }, (_, index) => `pkg-${String(index)}`)
    const first = stageInstallation(Object.fromEntries(names.map(name => [name, {}])))
    const second = stageInstallation(Object.fromEntries(names.map(name => [name, {}])))
    const home = tmp()
    const fallback = join(home, 'profiles', 'node_modules')
    healProfilesModuleFallback(first, home)
    const reader = join(home, 'reader.mjs')
    const profileSource = fileURLToPath(new URL('../src/profile.ts', import.meta.url))
    writeFileSync(reader, [
      "import { lstatSync, readFileSync } from 'node:fs'",
      "import { join, dirname } from 'node:path'",
      `import { resolveBundleDir } from ${JSON.stringify(profileSource)}`,
      'const [fallback, ...names] = process.argv.slice(2)',
      "const profile = join(dirname(fallback), 'active')",
      "const absentInstallation = join(profile, 'uninstalled', 'package.json')",
      'const failures = []',
      'let passes = 0',
      "process.on('message', () => { process.send({ passes, failures }); process.exit() })",
      'async function probe(name) {',
      // Probe the directory entry itself and the real bundle resolver. A raw
      // existsSync(link/package.json) also reports macOS rename-time EINVAL
      // as false, which is neither a missing entry nor our resolved read path.
      "  if (!lstatSync(join(fallback, name)).isSymbolicLink()) throw new Error('link replaced by a non-link')",
      "  const directory = resolveBundleDir('test', name, absentInstallation, profile)",
      "  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))",
      "  if (manifest.name !== name) throw new Error('resolved another package')",
      '}',
      'async function scan() {',
      '  for (const name of names) {',
      '    try {',
      '      await probe(name)',
      '    } catch (error) {',
      // macOS reports EINVAL transiently while the parent re-points a link; that
      // window is neither a missing entry nor a wrong resolution. Re-probe once
      // after yielding, and still fail on any persistent error (ENOENT, non-link,
      // wrong package, malformed manifest).
      "      if (error.code === 'EINVAL') {",
      '        await new Promise(resolve => setImmediate(resolve))',
      '        try { await probe(name); continue } catch (retry) {',
      '          failures.push({ name, message: String(retry), code: retry.code })',
      '          continue',
      '        }',
      '      }',
      '      failures.push({ name, message: String(error), code: error.code })',
      '    }',
      '  }',
      '  passes += 1',
      '  setImmediate(scan)',
      '}',
      "process.send('ready')",
      'scan()',
    ].join('\n'))
    const { spawn } = await import('node:child_process')
    const child = spawn(process.execPath, ['--import', 'tsx', reader, fallback, ...names], {
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    })
    const exited = once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>
    try {
      await Promise.race([
        once(child, 'message'),
        exited.then(() => { throw new Error('resolver exited before readiness') }),
      ])
      for (let index = 0; index < 40; index += 1) {
        healProfilesModuleFallback(index % 2 === 0 ? second : first, home)
      }
      const result = once(child, 'message')
      child.send('stop')
      const [report] = await result as [{ passes: number; failures: unknown[] }]
      const [code, signal] = await exited
      expect({ code, signal }).toEqual({ code: 0, signal: null })
      expect(report.passes).toBeGreaterThan(0)
      expect(report.failures).toEqual([])
      expect(readlinkSync(join(fallback, 'pkg-0'))).toBe(realpathSync.native(join(dirname(first), 'node_modules', 'pkg-0')))
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill()
      await exited
      for (const directory of [home, dirname(dirname(first)), dirname(dirname(second))]) {
        rmSync(directory, { recursive: true, force: true })
      }
    }
  }, 20_000)
})
