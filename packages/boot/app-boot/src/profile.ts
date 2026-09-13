/**
 * Profile discovery, initialization, and patch-layer composition for the
 * `dsh --profile` launcher family.
 *
 * A profile is a directory under `$DSH_HOME/profiles/<name>` holding a
 * `package.json` (out-of-tree plugin dependencies plus the profile manifest
 * `dsh.profile` with its ordered `bundles` list) and a `cordis.patch.yml`
 * (the user's own patch layer, applied after every bundle layer). Bundles are
 * npm packages whose manifest declares
 * `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`; the tree is
 * composed by applying each bundle's patch list in `dsh.profile.bundles` order over
 * an empty entry list, then the profile's own patches, then any launcher
 * layers (`--patch` files and flag-derived patches).
 *
 * Module resolution is two-anchor by construction: a bundle name resolves
 * first from the dsh installation (the launcher's own package), then from the
 * profile directory. The Loader's `baseUrl` is the profile directory, whose
 * `node_modules` pnpm manages for out-of-tree plugins, while the maintained
 * flat fallback directory `$DSH_HOME/profiles/node_modules` (one symlink per
 * package the installation's app and installed optional bundles depend on) makes every in-box
 * plugin Node-resolvable from any profile through the ordinary parent-walk.
 * @module @deepseek-ai/dsh-app-boot/profile
 */

import { createRequire } from 'node:module'
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { applyEntryPatches, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { loadOverlayPatches } from './index.ts'

/** Directory under the Harness home holding every profile. */
export const PROFILES_DIR = 'profiles'

/** The user patch layer inside a profile directory (hot-reloaded on long-lived surfaces). */
export const PROFILE_PATCH_FILENAME = 'cordis.patch.yml'

/** The bundle half of the `dsh` manifest section: what a bundle package exports. */
export interface DshBundleManifest {
  /** The patch layer this bundle exports, relative to its package root. */
  patch: string
}

/** The profile half of the `dsh` manifest section: what a profile directory composes. */
export interface DshProfileManifest {
  /** Ordered bundle layer list (package names). */
  bundles?: string[]
  /** Apply patch edits live, or freeze them for this launch; defaults to live. */
  patchReload?: 'live' | 'startup'
}

/**
 * The profile-launcher slice of the `dsh`-owned package.json section. A
 * manifest may declare both roles; other consumers own additional keys.
 */
export interface DshManifestSection {
  /** Bundle metadata consumed by the profile launcher. */
  bundle?: DshBundleManifest
  /** Profile metadata consumed by the profile launcher. */
  profile?: DshProfileManifest
}

/** The slice of package.json both profiles and bundles use. */
export interface ProfileManifest {
  name?: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  dsh?: DshManifestSection
}

/** One resolved bundle layer of a profile. */
export interface ProfileLayer {
  /** The bundle's package name, as listed in `dsh.profile.bundles`. */
  packageName: string
  /** Absolute directory of the resolved bundle package. */
  packageDir: string
  /** Absolute path of the bundle's patch file. */
  patchPath: string
  /** The parsed patch list. */
  patches: PatchOptions[]
}

/** A loaded profile: resolved bundle layers plus the user's own patch layer. */
export interface Profile {
  /** The profile name (its directory basename). */
  name: string
  /** Resolved patch lifecycle for the launcher. */
  patchReload: 'live' | 'startup'
  /** Absolute profile directory. */
  dir: string
  /** Bundle layers in `dsh.profile.bundles` order. */
  layers: ProfileLayer[]
  /** Absolute path of the profile's own patch file. */
  patchPath: string
  /** The profile's own patches; empty when the file is absent. */
  patches: PatchOptions[]
}

/**
 * Resolve a profile's directory under the Harness home.
 * @param name - the profile name (`dsh --profile <name>`).
 * @param home - the Harness home; defaults to {@link resolveDshHome}.
 * @returns the absolute profile directory (which may not exist yet).
 */
export function resolveProfileDir(name: string, home: string = resolveDshHome()): string {
  if (name === '' || name.includes('/') || name.includes('\\') || name === '.' || name === '..'
    // The launcher-maintained flat module fallback lives at this sibling path.
    || name === 'node_modules') {
    throw new Error(`dsh: invalid profile name ${JSON.stringify(name)}`)
  }
  return join(home, PROFILES_DIR, name)
}

/** One shipped profile template: the initial bundle layers and the patch lifecycle it pins. */
export interface ProfileTemplate {
  /** Initial `dsh.profile.bundles` layer list. */
  bundles: readonly string[]
  /** Initial `dsh.profile.patchReload`; an omitted lifecycle keeps the default live reload. */
  patchReload?: 'live' | 'startup'
}

/**
 * The shipped profile templates auto-initialized on first use, by name.
 *
 * `sdk-minimal` is the standalone minimal SDK roster: its one bundle inserts
 * the complete Cordis tree over the empty profile root, so the profile pins
 * startup-only patch loading and never lists `@deepseek-ai/dsh-base`.
 */
export const PROFILE_TEMPLATES: Record<string, ProfileTemplate> = {
  acp: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app'] },
  headless: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'] },
  sdk: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app'] },
  'sdk-minimal': { bundles: ['@deepseek-ai/dsh-sdk-minimal'], patchReload: 'startup' },
}

/** The bundle list a `dsh plugin` init uses for a name with no shipped template. */
export const DEFAULT_PROFILE_BUNDLES: readonly string[] = ['@deepseek-ai/dsh-base']

const PROFILE_PATCH_TEMPLATE = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
[]
`

// The hoisted linker gives out-of-tree plugins a flat node_modules whose
// missing peers (cordis and friends) fall through to the healed
// profiles/node_modules installation fallback, so every plugin shares the
// installation's single cordis instance instead of a duplicate. pnpm ≥10
// reads its settings from pnpm-workspace.yaml, not .npmrc.
const PROFILE_PNPM_WORKSPACE = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`

/**
 * Initialize a profile directory: manifest, empty user patch layer, and the
 * pnpm settings out-of-tree plugins need. Existing files are never touched,
 * so re-running is a no-op on an initialized profile.
 * @param dir - the profile directory from {@link resolveProfileDir}.
 * @param bundles - the initial `dsh.profile.bundles` layer list.
 * @param patchReload - the initial patch lifecycle a startup-only template
 * pins; omitted keeps the default live reload out of the manifest.
 */
export function initProfile(dir: string, bundles: readonly string[], patchReload?: 'live' | 'startup'): void {
  mkdirSync(dir, { recursive: true })
  const manifestPath = join(dir, 'package.json')
  if (!existsSync(manifestPath)) {
    const manifest: ProfileManifest & { private: boolean } = {
      name: `dsh-profile-${basename(dir)}`,
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: [...bundles], ...patchReload === undefined ? {} : { patchReload } } },
    }
    writeFileSync(manifestPath, JSON.stringify(manifest, undefined, 2) + '\n')
  }
  const patchPath = join(dir, PROFILE_PATCH_FILENAME)
  if (!existsSync(patchPath)) writeFileSync(patchPath, PROFILE_PATCH_TEMPLATE)
  const workspacePath = join(dir, 'pnpm-workspace.yaml')
  if (!existsSync(workspacePath)) writeFileSync(workspacePath, PROFILE_PNPM_WORKSPACE)
}

/** Ensure `link` is a symlink to `target`, replacing a wrong or dangling link; a real directory throws. */
function ensureSymlink(link: string, target: string): void {
  let stat
  try {
    stat = lstatSync(link)
  } catch {
    // Missing link (first run) — created below. Any other lstat failure on a
    // path we just created the parent of would resurface on symlinkSync.
    stat = undefined
  }
  if (stat !== undefined) {
    if (!stat.isSymbolicLink()) {
      throw new Error(`dsh: ${link} exists and is not a symlink; remove it so dsh can manage the installation fallback`)
    }
    if (readlinkSync(link) === target) return
  }
  // Replace by atomic rename. Every profile resolves bare plugin names through
  // this fallback, and a restart heals it while another runtime may still be
  // answering a preset roster or a mount: unlinking first leaves the entry
  // missing for the whole gap between the two syscalls, and one missing entry
  // marks every preset that names the package broken. The staged link sits
  // beside its destination so the rename stays on one filesystem.
  const staged = `${link}.staged-${String(process.pid)}`
  try {
    unlinkSync(staged)
  } catch {
    // Nothing of ours is staged under this name.
  }
  symlinkSync(target, staged, 'junction')
  try {
    renameSync(staged, link)
    return
  } catch (error) {
    /* v8 ignore next 3 -- POSIX rename always replaces the link; only Windows can refuse. */
    if (!['EEXIST', 'EPERM', 'ENOTEMPTY', 'EISDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      unlinkSync(staged)
      throw error
    }
  }
  // Windows fallback: delete the reparse point itself (unlink, not rmSync — a
  // junction is a directory to rmSync and throws EISDIR unless recursive).
  unlinkSync(staged)
  if (stat !== undefined) unlinkSync(link)
  try {
    symlinkSync(target, link, 'junction')
  } catch (error) {
    // Concurrent launches heal the same fallback; losing the race to a
    // process writing the identical link is success, anything else is not.
    /* v8 ignore next 4 */
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST'
      || !lstatSync(link).isSymbolicLink() || readlinkSync(link) !== target) {
      throw error
    }
  }
}

/**
 * Maintain the flat module fallback `$DSH_HOME/profiles/node_modules`: one
 * symlink per package in the dsh app's resolvable dependency CLOSURE (BFS
 * over dependencies, installed optional dependencies, and peers from the app manifest), each resolved from its own
 * real location. Node's parent-directory walk from any profile finds this
 * directory after the profile's own `node_modules`, so every in-box plugin
 * resolves without pnpm ever managing it — the exact "bundles come from the
 * installation" contract. The closure (not just direct dependencies) is
 * required for out-of-tree plugins: their peer dependencies name Service
 * Definition packages (`dsh-compaction`, `dsh-invariants`, ...) that the app
 * reaches only through its Service Provider packages. Symlinked packages
 * resolve their own dependencies from their real directories (Node's default
 * symlink-following), so each package needs only its one flat link.
 * Idempotent: correct links are kept and moved installations are
 * re-pointed; a stale link to a vanished package stays until its name is
 * reused (dangling links are invisible to resolution).
 * @param installAnchor - absolute path of the dsh app's package.json.
 * @param home - the Harness home; defaults to {@link resolveDshHome}.
 */
export function healProfilesModuleFallback(installAnchor: string, home: string = resolveDshHome()): void {
  const profilesDir = join(home, PROFILES_DIR)
  const modulesDir = join(profilesDir, 'node_modules')
  mkdirSync(modulesDir, { recursive: true })
  const appManifest = JSON.parse(readFileSync(installAnchor, 'utf8')) as ProfileManifest
  const links = new Map<string, string>()
  /* v8 ignore next -- a real app manifest always declares its name */
  if (appManifest.name !== undefined) links.set(appManifest.name, dirname(installAnchor))
  // BFS over the resolvable dependency graph; the visited set is the link
  // map itself (first resolution wins, matching Node's own nearest-wins).
  const queue: { anchor: string; manifest: ProfileManifest }[] = [{ anchor: installAnchor, manifest: appManifest }]
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    // Peer dependencies participate: Service Definition packages (dsh-subprocess,
    // dsh-compaction, ...) are peers of their implementations, never plain
    // dependencies, yet out-of-tree plugins import them directly.
    /* v8 ignore next -- a real app manifest always declares dependencies */
    for (const dep of [
      ...Object.keys(next.manifest.dependencies ?? {}),
      ...Object.keys(next.manifest.optionalDependencies ?? {}),
      ...Object.keys(next.manifest.peerDependencies ?? {}),
    ]) {
      if (links.has(dep)) continue
      const dir = packageDirFromAnchor(next.anchor, dep)
      // A declared-but-uninstalled dependency cannot be a loader-visible
      // plugin; skip it rather than fail the whole boot.
      if (dir === undefined) continue
      links.set(dep, dir)
      const manifestPath = join(dir, 'package.json')
      queue.push({ anchor: manifestPath, manifest: JSON.parse(readFileSync(manifestPath, 'utf8')) as ProfileManifest })
    }
  }
  for (const [packageName, target] of links) {
    const link = join(modulesDir, packageName)
    mkdirSync(dirname(link), { recursive: true })
    ensureSymlink(link, target)
  }
}

/**
 * Read a profile's manifest.
 * @param binName - the diagnostic prefix on the thrown error.
 * @param dir - the profile directory.
 * @returns the parsed manifest.
 */
export function readProfileManifest(binName: string, dir: string): ProfileManifest {
  const path = join(dir, 'package.json')
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    throw new Error(`${binName}: failed to read profile manifest ${path}: ${String(error)}`)
  }
  // The field checks below validate the file data before trusting the parse type.
  const parsed = JSON.parse(raw) as ProfileManifest | null
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${binName}: profile manifest ${path} must hold a JSON object`)
  }
  return parsed
}

/**
 * Write a profile's manifest back (2-space JSON, trailing newline).
 * @param dir - the profile directory.
 * @param manifest - the manifest value to persist.
 */
export function writeProfileManifest(dir: string, manifest: ProfileManifest): void {
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, undefined, 2) + '\n')
}

/**
 * Whether `directory` is served by pkg's read-only snapshot VFS rather than
 * the physical filesystem. The `--sea` route this repo packages with hooks the
 * JavaScript `realpathSync` inside the snapshot (directories only) while the
 * syscall-backed `realpathSync.native` cannot see the snapshot at all, so a
 * snapshot directory canonicalizes through the former and reports ENOENT
 * through the latter — a divergence no real filesystem produces for an
 * existing directory. Only the packaged process can see that VFS at all, and
 * only through the same marker the ripgrep sidecar selection uses. Callers
 * pass an anchor's containing directory because that is the entry kind every
 * resolution candidate is; a launcher whose installation lives inside the
 * snapshot also uses this to know that host-filesystem resolution cannot reach
 * that installation at all.
 * @param directory - the containing directory of a resolution anchor.
 * @returns whether the directory resolves through the embedded snapshot VFS.
 */
export function isSnapshotServedDirectory(directory: string): boolean {
  if (!('pkg' in process)) return false
  try {
    realpathSync.native(directory)
    return false
  } catch (error) {
    // A directory the syscall cannot see at all is the snapshot case; a real
    // I/O fault (ELOOP, EACCES, ...) is not, and the candidate probe below
    // still fails loud on that.
    if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return false
  }
  try {
    realpathSync(directory)
    return true
  } catch {
    return false
  }
}

/**
 * Canonicalize one candidate that the syscall-backed canonicalizer reported
 * missing while resolving from a snapshot-served anchor. Only a candidate that
 * is really there — the directory and its manifest both exist — is accepted,
 * and only through the snapshot's own canonicalizer; its ENOENT/ENOTDIR still
 * means missing and every other error stays loud, so this can never turn a
 * genuinely missing package into a resolution.
 * @param candidate - the probed `node_modules/<package>` path.
 * @returns the canonical package directory, or `undefined` when it is missing.
 */
function snapshotPackageDir(candidate: string): string | undefined {
  if (!existsSync(candidate) || !existsSync(join(candidate, 'package.json'))) return undefined
  try {
    return realpathSync(candidate)
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
    return undefined
  }
}

/**
 * Resolve a package's root directory from one anchor without depending on the
 * package exporting `./package.json` (`require.resolve` would need that):
 * probe the require resolution paths for a directory holding the named
 * manifest. This is Node's own node_modules lookup order, so the result
 * matches what the Loader would import from the same anchor. Capture a package
 * symlink's destination before probing its manifest: traversing a link while
 * another process atomically replaces it can fail with EINVAL on macOS. A
 * snapshot-served anchor additionally accepts a candidate the syscall-backed
 * canonicalizer cannot see, through {@link snapshotPackageDir}.
 * @param anchor - absolute path of a package.json to resolve from.
 * @param packageName - the package name to resolve.
 * @returns the canonical package directory, or `undefined` when it is absent.
 */
function packageDirFromAnchor(anchor: string, packageName: string): string | undefined {
  // One probe per anchor, so ordinary Node processes answer from the packaged
  // marker alone and never pay a filesystem call for it.
  const snapshotAnchor = isSnapshotServedDirectory(dirname(anchor))
  // resolve.paths returns null only for builtins, which no bundle name is.
  /* v8 ignore next */
  for (const searchPath of createRequire(anchor).resolve.paths(packageName) ?? []) {
    const candidate = join(searchPath, packageName)
    let directory: string
    try {
      directory = realpathSync.native(candidate)
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      // The syscall reports a snapshot entry as missing; the snapshot's own
      // canonicalizer is the only authority left for this candidate.
      const canonical = snapshotAnchor ? snapshotPackageDir(candidate) : undefined
      if (canonical === undefined) continue
      directory = canonical
    }
    if (existsSync(join(directory, 'package.json'))) return directory
  }
  return undefined
}

/**
 * Resolve one bundle package's directory: installation anchor first, then the
 * profile directory. The installation-first order is the contract that
 * `@deepseek-ai/dsh-base` (and every other in-box bundle) always comes from
 * the same installation as the running dsh, never from a profile-local copy.
 * Resolution does not require the package to export `./package.json`.
 * @param binName - the diagnostic prefix on the thrown error.
 * @param packageName - the bundle's package name from `dsh.profile.bundles`.
 * @param installAnchor - absolute path of a file inside the dsh app package (its package.json).
 * @param profileDir - the profile directory (second anchor).
 * @returns the bundle package's absolute directory.
 */
export function resolveBundleDir(
  binName: string, packageName: string, installAnchor: string, profileDir: string,
): string {
  for (const anchor of [installAnchor, join(profileDir, 'package.json')]) {
    const dir = packageDirFromAnchor(anchor, packageName)
    if (dir !== undefined) return dir
  }
  throw new Error(
    `${binName}: cannot resolve profile bundle ${JSON.stringify(packageName)} from the dsh installation or ${profileDir}; `
    + `run 'dsh plugin --profile ${basename(profileDir)} install' if its dependency is not installed`,
  )
}

/**
 * Load a profile: resolve every `dsh.profile.bundles` entry to its patch
 * layer and parse the profile's own patch file. A listed bundle without a
 * `dsh.bundle` manifest fails loud — naming a bundle-less package as a layer
 * is a misconfiguration, not "no patches".
 * @param binName - the diagnostic prefix on thrown errors.
 * @param name - the profile name.
 * @param installAnchor - absolute path of the dsh app's package.json (first resolution anchor).
 * @param home - the Harness home; defaults to {@link resolveDshHome}.
 * @param options - `userLayer: false` skips reading `cordis.patch.yml`, so a
 * bundles-only consumer (`--dump-default-config`, a recovery diagnostic)
 * cannot fail on a broken user layer.
 * @returns the loaded profile (empty `patches` when the user layer is skipped).
 */
export function loadProfile(
  binName: string, name: string, installAnchor: string, home: string = resolveDshHome(),
  options: { userLayer?: boolean } = {},
): Profile {
  const dir = resolveProfileDir(name, home)
  if (!existsSync(join(dir, 'package.json'))) {
    const template = PROFILE_TEMPLATES[name]
    if (template === undefined) {
      throw new Error(
        `${binName}: profile ${JSON.stringify(name)} does not exist; create it with 'dsh plugin --profile ${name} add <package>'`,
      )
    }
    initProfile(dir, template.bundles, template.patchReload)
  }
  const manifest = readProfileManifest(binName, dir)
  const patchReload: unknown = manifest.dsh?.profile?.patchReload ?? 'live'
  if (patchReload !== 'live' && patchReload !== 'startup') {
    throw new Error(`${binName}: profile ${JSON.stringify(name)} has invalid dsh.profile.patchReload`)
  }
  // A hand-written profile manifest may omit the dsh section entirely.
  const bundles = manifest.dsh?.profile?.bundles ?? []
  const layers = bundles.map((packageName): ProfileLayer => {
    const packageDir = resolveBundleDir(binName, packageName, installAnchor, dir)
    const bundleManifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as ProfileManifest
    const declared = bundleManifest.dsh?.bundle?.patch
    if (declared === undefined) {
      throw new Error(`${binName}: profile bundle ${JSON.stringify(packageName)} declares no dsh.bundle in its package.json`)
    }
    const patchPath = join(packageDir, declared)
    return { packageName, packageDir, patchPath, patches: loadOverlayPatches(binName, patchPath) }
  })
  const patchPath = join(dir, PROFILE_PATCH_FILENAME)
  const patches = options.userLayer !== false && existsSync(patchPath)
    ? loadOverlayPatches(binName, patchPath)
    : []
  return { name, dir, layers, patchPath, patches, patchReload }
}

/**
 * Compose patch layers into the effective entry list over an empty root —
 * the same single `applyEntryPatches` call the boot include makes, so flag
 * derivation and config dumps see exactly what mounts.
 * @param layers - patch lists in application order.
 * @param warn - sink for skipped-patch diagnostics; defaults to silent (boot repeats them).
 * @returns the composed entry list.
 */
export function composeEntries(
  layers: readonly PatchOptions[][], warn: (message: string) => void = () => {},
): EntryOptions[] {
  return applyEntryPatches([], structuredClone(layers.flat()), (message: string, ...args: unknown[]) => {
    let index = 0
    warn(message.replace(/%C/g, () => JSON.stringify(args[index++])))
  })
}
