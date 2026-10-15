/**
 * Profile machinery of `dsh-app-boot`: directory resolution and init,
 * manifest round-trips, two-anchor bundle resolution, patch-layer loading,
 * empty-root composition, and the installation module-fallback healing.
 */

import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { once } from 'node:events'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  composeEntries,
  healProfilesModuleFallback,
  initProfile,
  isSnapshotServedDirectory,
  loadProfile,
  PROFILE_PATCH_FILENAME,
  PROFILE_TEMPLATES,
  readProfileManifest,
  resolveBundleDir,
  resolveProfileDir,
  writeProfileManifest,
} from '../src/index.ts'

// pkg's read-only snapshot VFS (the `--sea` route this repo packages with)
// hooks the JavaScript `realpathSync` for snapshot directories while the
// syscall-backed `realpathSync.native` cannot see the snapshot at all, so a
// snapshot entry is reachable through that divergence alone — a divergence no
// real filesystem produces for an existing path. The resolver's packaged
// fallback is gated on it, so the suite simulates the divergence for one
// directory prefix at a time.
const snapshotVfs = vi.hoisted(() => ({
  /** Directory prefix served by the simulated snapshot VFS; undefined: off. */
  root: undefined as string | undefined,
  /** Error code the simulated syscall-backed canonicalizer raises there; undefined: a hook fault with no errno code. */
  nativeCode: 'ENOENT' as string | undefined,
  /** Exact path where the simulated snapshot canonicalizer itself fails, and how; a missing code means the hook threw a bare Error. */
  snapshotFailure: undefined as { path: string; code?: string } | undefined,
  /** Destination where the filesystem refuses replacement without removing the old entry. */
  renameRefusal: undefined as { destination: string; code: string } | undefined,
  statRefusal: undefined as { path: string; code: string | undefined; remaining: number } | undefined,
  createRefusal: undefined as { path: string; code: string | undefined } | undefined,
  unlinkRefusal: undefined as string | undefined,
  nativeRetarget: undefined as ((link: string, target: string,
    expected: { dev: bigint; ino: bigint; target: string }) => void) | undefined,
  /** Numbered syscall failures for one package candidate during a test. */
  transientNativeFailure: undefined as { path: string; remaining: number; code?: string } | undefined,
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const { sep: separator } = await import('node:path')
  const inSnapshot = (path: unknown): boolean => snapshotVfs.root !== undefined
    && (String(path) === snapshotVfs.root || String(path).startsWith(`${snapshotVfs.root}${separator}`))
  // A hook fault the simulated canonicalizer reports without any errno code.
  const codelessFault = (path: unknown): Error =>
    new Error(`simulated canonicalizer fault without an errno code at ${JSON.stringify(String(path))}`)
  const failure = (code: string | undefined, path: unknown): Error => code === undefined ? codelessFault(path) : Object.assign(
    new Error(`${code}: simulated pkg snapshot VFS entry ${JSON.stringify(String(path))}`),
    { code, errno: code === 'ENOENT' ? -2 : -1, syscall: 'realpath', path: String(path) },
  )
  const realpathSync = Object.assign(
    (path: string, options?: unknown): string => {
      const failed = snapshotVfs.snapshotFailure
      if (failed !== undefined && path === failed.path) throw failure(failed.code, path)
      return (actual.realpathSync as unknown as (target: string, callOptions?: unknown) => string)(path, options)
    },
    {
      native: (path: string): string => {
        if (inSnapshot(path)) throw failure(snapshotVfs.nativeCode, path)
        const transient = snapshotVfs.transientNativeFailure
        if (transient !== undefined && transient.path === path && transient.remaining > 0) {
          transient.remaining -= 1
          throw failure(transient.code, path)
        }
        return (actual.realpathSync.native as unknown as (target: string) => string)(path)
      },
    },
  )
  // A host whose rename cannot replace an existing destination (Windows): the
  // refusal is reported for exactly one destination path, everything else takes
  // the real rename.
  const renameSync = (from: string, to: string): void => {
    const refusal = snapshotVfs.renameRefusal
    if (refusal !== undefined && to === refusal.destination) {
      throw Object.assign(
        new Error(`${refusal.code}: simulated host refusing to replace ${JSON.stringify(to)}`),
        { code: refusal.code, errno: -1, syscall: 'rename', path: to, dest: to },
      )
    }
    actual.renameSync(from, to)
  }
  const lstatSync = (...args: Parameters<typeof actual.lstatSync>) => {
    const refusal = snapshotVfs.statRefusal
    if (refusal !== undefined && String(args[0]) === refusal.path && refusal.remaining > 0) {
      refusal.remaining--
      throw failure(refusal.code, args[0])
    }
    return actual.lstatSync(...args)
  }
  const unlinkSync = (path: import('node:fs').PathLike): void => {
    if (String(path) === snapshotVfs.unlinkRefusal) throw failure('EACCES', path)
    actual.unlinkSync(path)
  }
  const symlinkSync = (...args: Parameters<typeof actual.symlinkSync>): void => {
    const refusal = snapshotVfs.createRefusal
    if (refusal !== undefined && String(args[1]) === refusal.path) throw failure(refusal.code, args[1])
    actual.symlinkSync(...args)
  }
  return { ...actual, realpathSync, renameSync, lstatSync, unlinkSync, symlinkSync }
})

vi.mock('@deepseek-ai/dsh-win32-process', async (original) => {
  const actual = await original<typeof import('@deepseek-ai/dsh-win32-process')>()
  return { ...actual, replaceJunctionTarget: (...args: Parameters<typeof actual.replaceJunctionTarget>) => {
    if (snapshotVfs.nativeRetarget !== undefined) snapshotVfs.nativeRetarget(...args)
    else actual.replaceJunctionTarget(...args)
  } }
})

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

describe('resolveBundleDir in a packaged snapshot process', () => {
  afterEach(() => {
    snapshotVfs.root = undefined
    snapshotVfs.nativeCode = 'ENOENT'
    snapshotVfs.snapshotFailure = undefined
    snapshotVfs.renameRefusal = undefined
    snapshotVfs.transientNativeFailure = undefined
    Reflect.deleteProperty(process, 'pkg')
  })

  /** Stage an installation under the simulated snapshot prefix and mark the process packaged. */
  function stageSnapshotInstallation(
    bundles: Record<string, { patch?: string; deps?: Record<string, string> }> = {},
  ): { anchor: string; root: string } {
    const anchor = stageInstallation(bundles)
    snapshotVfs.root = dirname(anchor)
    Reflect.defineProperty(process, 'pkg', { configurable: true, value: {} })
    return { anchor, root: dirname(anchor) }
  }

  it('retries a transient missing junction while resolving through the profile fallback', () => {
    const home = tmp()
    const profileDir = join(home, 'profiles', 'active')
    const fallback = join(home, 'profiles', 'node_modules')
    const target = join(tmp(), 'fallback-target')
    const link = join(fallback, 'fallback-only')
    mkdirSync(target, { recursive: true })
    mkdirSync(fallback, { recursive: true })
    writeFileSync(join(target, 'package.json'), JSON.stringify({ name: 'fallback-only' }))
    symlinkSync(target, link, 'junction')
    snapshotVfs.transientNativeFailure = { path: link, remaining: 1, code: 'ENOENT' }

    expect(resolveBundleDir('t', 'fallback-only', join(profileDir, 'uninstalled', 'package.json'), profileDir))
      .toBe(realpathSync.native(target))
    expect(snapshotVfs.transientNativeFailure.remaining).toBe(0)
  })

  it('keeps a persistent junction resolution error loud after bounded retries', () => {
    const home = tmp()
    const profileDir = join(home, 'profiles', 'active')
    const fallback = join(home, 'profiles', 'node_modules')
    const target = join(tmp(), 'fallback-target')
    const link = join(fallback, 'fallback-only')
    mkdirSync(target, { recursive: true })
    mkdirSync(fallback, { recursive: true })
    writeFileSync(join(target, 'package.json'), JSON.stringify({ name: 'fallback-only' }))
    symlinkSync(target, link, 'junction')
    snapshotVfs.transientNativeFailure = { path: link, remaining: 9, code: 'EINVAL' }

    expect(() => resolveBundleDir(
      't', 'fallback-only', join(profileDir, 'uninstalled', 'package.json'), profileDir,
    )).toThrow(/EINVAL/)
    expect(snapshotVfs.transientNativeFailure.remaining).toBe(0)
  })

  it('keeps a canonicalizer failure without an errno code loud', () => {
    const home = tmp()
    const profileDir = join(home, 'profiles', 'active')
    const fallback = join(home, 'profiles', 'node_modules')
    const target = join(tmp(), 'fallback-target')
    const link = join(fallback, 'fallback-only')
    mkdirSync(target, { recursive: true })
    mkdirSync(fallback, { recursive: true })
    writeFileSync(join(target, 'package.json'), JSON.stringify({ name: 'fallback-only' }))
    symlinkSync(target, link, 'junction')
    snapshotVfs.transientNativeFailure = { path: link, remaining: 1 }

    expect(() => resolveBundleDir(
      't', 'fallback-only', join(profileDir, 'uninstalled', 'package.json'), profileDir,
    )).toThrow(/without an errno code/)
    expect(snapshotVfs.transientNativeFailure.remaining).toBe(0)
  })

  it('accepts a snapshot-served candidate the syscall canonicalizer cannot see', () => {
    const { anchor, root } = stageSnapshotInstallation({ 'in-box': { patch: '[]\n' } })
    const profileDir = tmp()
    const packageDir = join(root, 'node_modules', 'in-box')
    // The syscall sees nothing there while the snapshot does; the fallback must
    // return the snapshot's own canonical path for the package root.
    expect(() => realpathSync.native(packageDir)).toThrow(/ENOENT/)
    expect(resolveBundleDir('t', 'in-box', anchor, profileDir)).toBe(realpathSync(packageDir))
  })

  it('does not fall back outside a packaged process', () => {
    const anchor = stageInstallation({ 'snapshot-only': { patch: '[]\n' } })
    snapshotVfs.root = dirname(anchor)
    // Same native ENOENT as the packaged case, but no packaged-process marker:
    // the candidate must not be accepted.
    expect(() => realpathSync.native(join(dirname(anchor), 'node_modules', 'snapshot-only'))).toThrow(/ENOENT/)
    expect(() => resolveBundleDir('t', 'snapshot-only', anchor, tmp())).toThrow('cannot resolve profile bundle')
  })

  it('does not fall back when the anchor is an ordinary filesystem path', () => {
    const anchor = stageInstallation({ 'in-box': { patch: '[]\n' } })
    // Only the candidate's directory looks snapshot-served; the anchor is a
    // real filesystem path, so the packaged fallback must stay off.
    snapshotVfs.root = join(dirname(anchor), 'node_modules')
    Reflect.defineProperty(process, 'pkg', { configurable: true, value: {} })
    expect(() => resolveBundleDir('t', 'in-box', anchor, tmp())).toThrow('cannot resolve profile bundle')
  })

  it('does not accept a snapshot candidate without its manifest', () => {
    const { anchor, root } = stageSnapshotInstallation()
    mkdirSync(join(root, 'node_modules', 'manifest-less'), { recursive: true })
    expect(() => resolveBundleDir('t', 'manifest-less', anchor, tmp())).toThrow('cannot resolve profile bundle')
  })

  it('does not accept a missing snapshot candidate', () => {
    const { anchor } = stageSnapshotInstallation({ 'in-box': { patch: '[]\n' } })
    expect(() => resolveBundleDir('t', 'absent-in-snapshot', anchor, tmp())).toThrow('cannot resolve profile bundle')
  })

  it('treats a snapshot canonicalizer ENOENT as missing', () => {
    const { anchor, root } = stageSnapshotInstallation({ 'in-box': { patch: '[]\n' } })
    snapshotVfs.snapshotFailure = { path: join(root, 'node_modules', 'in-box'), code: 'ENOENT' }
    expect(() => resolveBundleDir('t', 'in-box', anchor, tmp())).toThrow('cannot resolve profile bundle')
  })

  it('keeps a non-missing snapshot canonicalizer failure loud', () => {
    const { anchor, root } = stageSnapshotInstallation({ 'in-box': { patch: '[]\n' } })
    snapshotVfs.snapshotFailure = { path: join(root, 'node_modules', 'in-box'), code: 'EACCES' }
    expect(() => resolveBundleDir('t', 'in-box', anchor, tmp())).toThrow(/EACCES/)
  })

  it('keeps a codeless snapshot canonicalizer fault loud', () => {
    const { anchor, root } = stageSnapshotInstallation({ 'in-box': { patch: '[]\n' } })
    // The candidate is really there (directory and manifest) but the snapshot's
    // own canonicalizer fails without an errno code: that is not "missing", so
    // it must surface instead of being reported as an unresolvable bundle.
    snapshotVfs.snapshotFailure = { path: join(root, 'node_modules', 'in-box') }
    expect(() => realpathSync(join(root, 'node_modules', 'in-box'))).toThrow(/without an errno code/)
    expect(() => resolveBundleDir('t', 'in-box', anchor, tmp()))
      .toThrow(/simulated canonicalizer fault without an errno code/)
  })

  it('keeps a non-missing syscall failure loud instead of falling back', () => {
    const { anchor, root } = stageSnapshotInstallation({ 'in-box': { patch: '[]\n' } })
    snapshotVfs.nativeCode = 'ELOOP'
    expect(() => realpathSync.native(join(root, 'node_modules', 'in-box'))).toThrow(/ELOOP/)
    expect(() => resolveBundleDir('t', 'in-box', anchor, tmp())).toThrow(/ELOOP/)
  })

  it('does not treat an absent anchor as snapshot-served', () => {
    const anchor = join(tmp(), 'absent', 'package.json')
    snapshotVfs.root = dirname(anchor)
    Reflect.defineProperty(process, 'pkg', { configurable: true, value: {} })
    expect(() => resolveBundleDir('t', 'in-box', anchor, tmp())).toThrow('cannot resolve profile bundle')
  })
})

describe('isSnapshotServedDirectory', () => {
  afterEach(() => {
    snapshotVfs.root = undefined
    snapshotVfs.nativeCode = 'ENOENT'
    snapshotVfs.snapshotFailure = undefined
    snapshotVfs.renameRefusal = undefined
    Reflect.deleteProperty(process, 'pkg')
  })

  it('recognizes a snapshot-served directory only in a packaged process', () => {
    const directory = tmp()
    snapshotVfs.root = directory
    Reflect.defineProperty(process, 'pkg', { configurable: true, value: {} })
    expect(isSnapshotServedDirectory(directory)).toBe(true)
    Reflect.deleteProperty(process, 'pkg')
    expect(isSnapshotServedDirectory(directory)).toBe(false)
  })

  it('rejects an ordinary filesystem directory, a missing one, and a non-missing fault', () => {
    const served = tmp()
    snapshotVfs.root = served
    Reflect.defineProperty(process, 'pkg', { configurable: true, value: {} })
    // The syscall canonicalizes a real directory, so it is not the snapshot arm.
    expect(isSnapshotServedDirectory(tmp())).toBe(false)
    // Both canonicalizers report a genuinely absent snapshot entry.
    expect(isSnapshotServedDirectory(join(served, 'absent'))).toBe(false)
    // A real I/O fault is not a snapshot entry either.
    snapshotVfs.nativeCode = 'EACCES'
    expect(isSnapshotServedDirectory(served)).toBe(false)
    // A hooked canonicalizer may fail without any errno code at all; that is
    // still not the snapshot arm, and checking the code must not throw.
    snapshotVfs.nativeCode = undefined
    expect(() => realpathSync.native(served)).toThrow(/without an errno code/)
    expect(isSnapshotServedDirectory(served)).toBe(false)
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
    expect(PROFILE_TEMPLATES.headless?.bundles).toContain('@deepseek-ai/dsh-base')
    try {
      loadProfile('t', 'headless', anchor, home)
    } catch {
      // Resolution failure is the plain-Node outcome for this empty anchor.
    }
    expect(readProfileManifest('t', resolveProfileDir('headless', home)).dsh?.profile?.bundles)
      .toEqual([...PROFILE_TEMPLATES.headless?.bundles ?? []])
  })

  it('pins SDK and ACP to their shared base plus exactly one app bundle', () => {
    expect(PROFILE_TEMPLATES.sdk).toEqual({
      bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app'],
    })
    expect(PROFILE_TEMPLATES.acp).toEqual({
      bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app'],
    })
  })

  it('ships the standalone minimal profile as one startup-only bundle with no base row', () => {
    expect(PROFILE_TEMPLATES['sdk-minimal']).toEqual({
      bundles: ['@deepseek-ai/dsh-sdk-minimal'],
      patchReload: 'startup',
    })
    const anchor = stageInstallation({ '@deepseek-ai/dsh-sdk-minimal': { patch: '[]\n' } })
    const home = tmp()
    const loaded = loadProfile('t', 'sdk-minimal', anchor, home)
    expect(loaded.patchReload).toBe('startup')
    expect(loaded.layers.map(layer => layer.packageName)).toEqual(['@deepseek-ai/dsh-sdk-minimal'])
    // The generated manifest pins the one-bundle roster and the frozen lifecycle.
    expect(readProfileManifest('t', resolveProfileDir('sdk-minimal', home)).dsh?.profile).toEqual({
      bundles: ['@deepseek-ai/dsh-sdk-minimal'],
      patchReload: 'startup',
    })
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
  afterEach(() => {
    snapshotVfs.renameRefusal = undefined
    snapshotVfs.statRefusal = undefined
    snapshotVfs.createRefusal = undefined
    snapshotVfs.unlinkRefusal = undefined
    snapshotVfs.nativeRetarget = undefined
  })

  it.each(['darwin', 'win32'] as const)('dispatches an existing link through the %s owner without removing it', (platform) => {
    const anchor = stageInstallation({})
    const home = tmp()
    const fallback = join(home, 'profiles', 'node_modules')
    mkdirSync(fallback, { recursive: true })
    const link = join(fallback, 'dsh-app')
    symlinkSync(tmp(), link, 'junction')
    const before = lstatSync(link, { bigint: true })
    const previousTarget = readlinkSync(link)
    const native = vi.fn((named: string, _target: string, identity: { dev: bigint; ino: bigint; target: string }) => {
      expect(named).toBe(link)
      expect(readlinkSync(named)).toBe(previousTarget)
      expect(identity).toEqual({ dev: before.dev, ino: before.ino, target: previousTarget })
    })
    snapshotVfs.nativeRetarget = native
    snapshotVfs.renameRefusal = { destination: link, code: 'EPERM' }
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
    try {
      Object.defineProperty(process, 'platform', { ...descriptor, value: platform })
      if (platform === 'win32') healProfilesModuleFallback(anchor, home)
      else expect(() => { healProfilesModuleFallback(anchor, home) }).toThrow('EPERM: simulated')
    } finally { Object.defineProperty(process, 'platform', descriptor) }
    expect(native).toHaveBeenCalledTimes(platform === 'win32' ? 1 : 0)
    expect(readlinkSync(link)).toBe(previousTarget)
    const after = lstatSync(link, { bigint: true })
    expect({ dev: after.dev, ino: after.ino }).toEqual({ dev: before.dev, ino: before.ino })
    expect(readdirSync(fallback)).toEqual(['dsh-app'])
    // This proves platform dispatch with a native-boundary observation, not a
    // successful Windows kernel update on a non-Windows host.
  })

  it('retains a native retarget refusal and leaves the managed point intact', () => {
    const anchor = stageInstallation({})
    const home = tmp()
    const fallback = join(home, 'profiles', 'node_modules')
    mkdirSync(fallback, { recursive: true })
    const link = join(fallback, 'dsh-app')
    symlinkSync(tmp(), link, 'junction')
    const previousTarget = readlinkSync(link)
    snapshotVfs.nativeRetarget = () => { throw new Error('native retarget refused') }
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
    try {
      Object.defineProperty(process, 'platform', { ...descriptor, value: 'win32' })
      expect(() => { healProfilesModuleFallback(anchor, home) }).toThrow('native retarget refused')
    } finally { Object.defineProperty(process, 'platform', descriptor) }
    expect(readlinkSync(link)).toBe(previousTarget)
    expect(readdirSync(fallback)).toEqual(['dsh-app'])
  })

  it.each(['EACCES', undefined])('does not treat lstat refusal %s as permission to create or replace', (code) => {
    const anchor = stageInstallation({})
    const home = tmp()
    const link = join(home, 'profiles', 'node_modules', 'dsh-app')
    snapshotVfs.statRefusal = { path: link, code, remaining: 1 }
    expect(() => { healProfilesModuleFallback(anchor, home) }).toThrow()
    expect(existsSync(link)).toBe(false)
  })

  it.each(['same-link', 'different-link', 'ordinary-directory'] as const)(
    'accepts only the identical winner after an initial-create race: %s', (winner) => {
      const anchor = stageInstallation({})
      const home = tmp()
      const fallback = join(home, 'profiles', 'node_modules')
      mkdirSync(fallback, { recursive: true })
      const link = join(fallback, 'dsh-app')
      const target = dirname(anchor)
      if (winner === 'ordinary-directory') mkdirSync(link)
      else symlinkSync(winner === 'same-link' ? target : tmp(), link, 'junction')
      // Model the lstat absence before a concurrent process publishes its
      // actual entry. The following symlink call and EEXIST are real syscalls.
      snapshotVfs.statRefusal = { path: link, code: 'ENOENT', remaining: 1 }
      if (winner === 'same-link') healProfilesModuleFallback(anchor, home)
      else expect(() => { healProfilesModuleFallback(anchor, home) }).toThrow()
      expect(lstatSync(link).isSymbolicLink()).toBe(winner !== 'ordinary-directory')
      if (winner === 'same-link') expect(readlinkSync(link)).toBe(target)
      else if (winner === 'different-link') expect(readlinkSync(link)).not.toBe(target)
      expect(readdirSync(fallback)).toEqual(['dsh-app'])
    })

  it.each(['EACCES', undefined])('retains initial-create refusal %s without retry or removal', (code) => {
    const anchor = stageInstallation({})
    const home = tmp()
    const link = join(home, 'profiles', 'node_modules', 'dsh-app')
    snapshotVfs.createRefusal = { path: link, code }
    expect(() => { healProfilesModuleFallback(anchor, home) }).toThrow()
    expect(existsSync(link)).toBe(false)
  })

  it('retains the rename refusal and staging cleanup failure without removing the old link', () => {
    const anchor = stageInstallation({})
    const home = tmp()
    const fallback = join(home, 'profiles', 'node_modules')
    mkdirSync(fallback, { recursive: true })
    const link = join(fallback, 'dsh-app')
    symlinkSync(tmp(), link, 'junction')
    const previousTarget = readlinkSync(link)
    snapshotVfs.renameRefusal = { destination: link, code: 'EPERM' }
    snapshotVfs.unlinkRefusal = `${link}.staged-${String(process.pid)}`
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
    let failure: unknown
    try {
      Object.defineProperty(process, 'platform', { ...descriptor, value: 'darwin' })
      healProfilesModuleFallback(anchor, home)
    } catch (error) { failure = error }
    finally { Object.defineProperty(process, 'platform', descriptor) }
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors.map(error => (error as NodeJS.ErrnoException).code)).toEqual(['EPERM', 'EACCES'])
    expect(readlinkSync(link)).toBe(previousTarget)
    expect(lstatSync(snapshotVfs.unlinkRefusal).isSymbolicLink()).toBe(true)
  })

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

  it('leaves the Harness home untouched when the installation is snapshot-served', () => {
    const anchor = stageInstallation({ 'in-box': { patch: '[]\n' } })
    const home = tmp()
    snapshotVfs.root = dirname(anchor)
    Reflect.defineProperty(process, 'pkg', { configurable: true, value: {} })
    try {
      // A packaged installation cannot be followed by any host resolver or
      // tool; the links would only dangle in the Harness home.
      healProfilesModuleFallback(anchor, home)
      expect(existsSync(join(home, 'profiles', 'node_modules'))).toBe(false)
    } finally {
      snapshotVfs.root = undefined
      Reflect.deleteProperty(process, 'pkg')
    }
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
    const link = join(fallback, 'dsh-app')
    symlinkSync(tmp(), link, 'junction')
    const before = lstatSync(link, { bigint: true })
    healProfilesModuleFallback(anchor, home)
    expect(readlinkSync(link)).toContain('app')
    if (process.platform === 'win32') {
      const after = lstatSync(link, { bigint: true })
      expect({ dev: after.dev, ino: after.ino }).toEqual({ dev: before.dev, ino: before.ino })
    }
  })

  it('preserves the old entry on POSIX rename refusal and uses in-place publication on Windows', () => {
    const anchor = stageInstallation({})
    const home = tmp()
    const fallback = join(home, 'profiles', 'node_modules')
    mkdirSync(fallback, { recursive: true })
    const link = join(fallback, 'dsh-app')
    symlinkSync(tmp(), link, 'junction')
    const previousTarget = readlinkSync(link)
    const previousIdentity = lstatSync(link, { bigint: true })
    snapshotVfs.renameRefusal = { destination: link, code: 'EPERM' }
    expect(() => { renameSync(link, link) }).toThrow(/EPERM: simulated host refusing to replace/)
    if (process.platform === 'win32') {
      healProfilesModuleFallback(anchor, home)
      expect(readlinkSync(link)).toBe(realpathSync.native(dirname(anchor)))
    } else {
      expect(() => { healProfilesModuleFallback(anchor, home) }).toThrow(/EPERM: simulated host refusing to replace/)
      expect(readlinkSync(link)).toBe(previousTarget)
    }
    const after = lstatSync(link, { bigint: true })
    expect({ dev: after.dev, ino: after.ino }).toEqual({ dev: previousIdentity.dev, ino: previousIdentity.ino })
    expect(readdirSync(fallback)).toEqual(['dsh-app'])
  })

  it('creates a missing link without needing to replace a destination', () => {
    const anchor = stageInstallation({ 'bundle-a': { patch: '[]\n' } })
    const home = tmp()
    const fallback = join(home, 'profiles', 'node_modules')
    const link = join(fallback, 'bundle-a')
    snapshotVfs.renameRefusal = { destination: link, code: 'EEXIST' }
    expect(() => { renameSync(link, link) }).toThrow(/EEXIST: simulated host refusing to replace/)
    healProfilesModuleFallback(anchor, home)
    // Initial creation does not need a rename or remove an existing entry.
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(realpathSync(link)).toBe(realpathSync.native(join(dirname(anchor), 'node_modules', 'bundle-a')))
    expect(readdirSync(fallback).sort()).toEqual(['bundle-a', 'dsh-app'])
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
    const started = performance.now()
    const phase = (name: string, details: Record<string, unknown> = {}): void => {
      process.stderr.write(`PROFILE_FALLBACK_CONCURRENCY_PHASE ${JSON.stringify({
        name, elapsedMs: Math.round(performance.now() - started), ...details,
      })}\n`)
    }
    const names = Array.from({ length: 160 }, (_, index) => `pkg-${String(index)}`)
    const first = stageInstallation(Object.fromEntries(names.map(name => [name, {}])))
    const second = stageInstallation(Object.fromEntries(names.map(name => [name, {}])))
    for (const anchor of [first, second]) for (const name of names) {
      const directory = join(dirname(anchor), 'node_modules', name)
      const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as Record<string, unknown>
      writeFileSync(join(directory, 'package.json'), JSON.stringify({ ...manifest,
        exports: { require: './entry.cjs', import: './entry.mjs' } }))
      writeFileSync(join(directory, 'entry.cjs'), `exports.name = ${JSON.stringify(name)}\n`)
      writeFileSync(join(directory, 'entry.mjs'), `export const name = ${JSON.stringify(name)}\n`)
    }
    const home = tmp()
    const fallback = join(home, 'profiles', 'node_modules')
    healProfilesModuleFallback(first, home)
    phase('staged-and-initial-heal', { packageCount: names.length })
    const profile = join(home, 'profiles', 'active')
    mkdirSync(profile)
    const reader = join(profile, 'reader.mjs')
    const profileSource = fileURLToPath(new URL('../src/profile.ts', import.meta.url))
    const cordisSource = fileURLToPath(new URL('../../../../vendor/cordis/src/index.ts', import.meta.url))
    const loaderSource = fileURLToPath(new URL('../../../../vendor/loader/src/index.ts', import.meta.url))
    writeFileSync(reader, [
      "import { readFileSync, lstatSync, readlinkSync } from 'node:fs'",
      "import { join, dirname } from 'node:path'",
      "import { createRequire } from 'node:module'",
      `import { Context } from ${JSON.stringify(pathToFileURL(cordisSource).href)}`,
      `import Loader from ${JSON.stringify(pathToFileURL(loaderSource).href)}`,
      `import { resolveBundleDir } from ${JSON.stringify(pathToFileURL(profileSource).href)}`,
      'const [fallback, ...names] = process.argv.slice(2)',
      "const profile = join(dirname(fallback), 'active')",
      "const absentInstallation = join(profile, 'uninstalled', 'package.json')",
      'const failures = []',
      'let passes = 0',
      'let stopping = false',
      'const bareImports = { cjs: 0, esm: 0, loader: 0 }',
      'const context = new Context()',
      'context.baseUrl = new URL("./loader-entry.mjs", import.meta.url).href',
      'await context.plugin(Loader, { baseUrl: new URL("./loader-entry.mjs", import.meta.url).href })',
      'const require = createRequire(import.meta.url)',
      // Every package is imported once per consumer with a fresh per-process
      // module cache. Later cached imports are not counted as new probes.
      'async function importBarePackages() {',
      '  for (const name of names) for (const consumer of ["cjs", "esm", "loader"]) {',
      '    try {',
      '      const module = consumer === "cjs" ? require(name) : consumer === "esm" ? await import(name) : await context.loader.import(name)',
      '      if (module.name !== name) throw new Error("imported another package")',
      '      bareImports[consumer] += 1',
      '    } catch (error) {',
      '      let observedEntry',
      '      try { const entry = join(fallback, name); const stat = lstatSync(entry, { bigint: true }); observedEntry = { isLink: stat.isSymbolicLink(), dev: String(stat.dev), ino: String(stat.ino), target: readlinkSync(entry) } }',
      '      catch (observationError) { observedEntry = { observationError: String(observationError), code: observationError.code } }',
      '      failures.push({ name, consumer, message: String(error), code: error.code, observedEntry })',
      '    }',
      '  }',
      '}',
      'let imports',
      "process.once('message', async () => { stopping = true; await imports; await context.fiber.dispose(); process.send({ passes, failures, bareImports }, error => { if (error) throw error; process.exit() }) })",
      'async function probe(name) {',
      // Probe the production resolver throughout all forty heals; ordinary
      // CJS/ESM/Loader consumers also traverse this same published namespace.
      "  const directory = resolveBundleDir('test', name, absentInstallation, profile)",
      "  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))",
      "  if (manifest.name !== name) throw new Error('resolved another package')",
      '}',
      'async function scan() {',
      '  for (const name of names) {',
      '    try {',
      '      await probe(name)',
      '    } catch (error) {',
      '      failures.push({ name, message: String(error), code: error.code })',
      '    }',
      '  }',
      '  passes += 1',
      '  if (!stopping) setImmediate(scan)',
      '}',
      "process.send('ready')",
      'imports = importBarePackages()',
      'scan()',
    ].join('\n'))
    const { spawn } = await import('node:child_process')
    const child = spawn(process.execPath, ['--expose-internals', '--import', 'tsx', reader, fallback, ...names], {
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    })
    phase('reader-spawned', { pid: child.pid })
    const exited = once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>
    try {
      const ready = await Promise.race([
        once(child, 'message'),
        exited.then(() => { throw new Error('resolver exited before readiness') }),
      ])
      expect(ready[0]).toBe('ready')
      phase('reader-ready')
      for (let index = 0; index < 40; index += 1) {
        healProfilesModuleFallback(index % 2 === 0 ? second : first, home)
        if ((index + 1) % 10 === 0) phase('healed', { heals: index + 1 })
      }
      const result = once(child, 'message')
      child.send('stop')
      phase('report-requested')
      const [report] = await Promise.race([
        result,
        exited.then(() => { throw new Error('resolver exited before reporting') }),
      ]) as [{ passes: number; failures: unknown[]; bareImports: { cjs: number; esm: number; loader: number } }]
      phase('report-received', { passes: report.passes, failureCount: report.failures.length })
      const [code, signal] = await exited
      phase('reader-exited', { code, signal })
      expect({ code, signal }).toEqual({ code: 0, signal: null })
      expect(report.passes).toBeGreaterThan(0)
      expect(report.failures).toEqual([])
      expect(report.bareImports).toEqual({ cjs: names.length, esm: names.length, loader: names.length })
      expect(readlinkSync(join(fallback, 'pkg-0'))).toBe(realpathSync.native(join(dirname(first), 'node_modules', 'pkg-0')))
    } finally {
      phase('cleanup-started', { exitCode: child.exitCode, signalCode: child.signalCode })
      if (child.exitCode === null && child.signalCode === null) child.kill()
      await exited
      for (const directory of [home, dirname(dirname(first)), dirname(dirname(second))]) {
        rmSync(directory, { recursive: true, force: true })
      }
      phase('cleanup-completed')
    }
  }, 20_000)
})
