import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { load: parseYaml } = require('js-yaml')

export const ARK_RUNTIME_ROOT_PACKAGES = ['@deepseek-ai/dsh-native-api-runner']
const ARK_RUNTIME_TARGET = Object.freeze({ id: 'macos-arm64', os: 'darwin', cpu: 'arm64' })
const ARK_RUNTIME_PROFILE_FILES = new Set([
  'jiuzhang/profile/package.json',
  'jiuzhang/profile/cordis.patch.yml',
  'jiuzhang/profile/pnpm-workspace.yaml',
  'jiuzhang/profile/runtime-identity-policy.json',
  'jiuzhang/profile/forbidden-runtime-packages.json',
])
const ARK_RUNTIME_REPOSITORY_INPUTS = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.base.json',
  'tsconfig.host.json',
  'tsconfig.json',
  'tsdown.config.ts',
  'scripts/build-host-bundles.ts',
  'scripts/tsdown-host-package.config.ts',
  'integrations/jiuzhang/src/pack-runtime.mjs',
  'integrations/jiuzhang/src/runtime-plan.mjs',
  'integrations/jiuzhang/src/runtime-closure.mjs',
  'integrations/jiuzhang/native/build-app.sh',
]
const PACKAGE_INPUT_DIRECT_NAMES = new Set([
  'package.json',
  'cordis.patch.yml',
  'tsconfig.json',
  'tsdown.config.ts',
  'tsdown.config.js',
  'tsdown.config.mjs',
  'tsdown.config.cjs',
])
const PACKAGE_INPUT_TREES = new Set(['src', 'config', 'lib'])
const PACK_LIFECYCLE_SCRIPTS = new Set([
  'preinstall',
  'install',
  'postinstall',
  'prepack',
  'prepare',
  'postpack',
  'prepublishOnly',
  'build',
  'build:js',
])

async function optionalLstat(path) {
  try {
    return await lstat(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableValue(child)]))
  }
  return value
}

function jsonSha256(value) {
  return createHash('sha256').update(JSON.stringify(stableValue(value), null, 2)).update('\n').digest('hex')
}

async function childDirectories(root) {
  if (await optionalLstat(root) === undefined) return []
  return (await readdir(root, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && !entry.isSymbolicLink())
    .map(entry => join(root, entry.name))
    .sort()
}

async function workspaceManifestPaths(repositoryRoot) {
  const paths = []
  for (const group of await childDirectories(join(repositoryRoot, 'packages'))) {
    for (const packageRoot of await childDirectories(group)) paths.push(join(packageRoot, 'package.json'))
  }
  for (const packageRoot of await childDirectories(join(repositoryRoot, 'vendor'))) {
    paths.push(join(packageRoot, 'package.json'))
  }
  for (const packageRoot of await childDirectories(join(repositoryRoot, 'apps'))) {
    paths.push(join(packageRoot, 'package.json'))
  }
  paths.push(join(repositoryRoot, 'native/landlock-run/package.json'))
  for (const packageRoot of await childDirectories(join(repositoryRoot, 'native/landlock-run/packages'))) {
    paths.push(join(packageRoot, 'package.json'))
  }
  return paths.filter(path => isAbsolute(path) && path.startsWith(`${repositoryRoot}/`))
}

function capture(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, npm_config_ignore_scripts: 'true' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    throw new Error(`${command} ${args.join(' ')} failed${detail === '' ? '' : `\n${detail}`}`)
  }
  return result.stdout
}

async function packagePacklist(repositoryRoot, packageRoot) {
  const output = capture('pnpm', ['--config.ignore-scripts=true', 'pack', '--dry-run', '--json'], packageRoot)
  const jsonStart = output.lastIndexOf('\n{')
  const parsed = JSON.parse(jsonStart === -1 ? output : output.slice(jsonStart + 1))
  const result = Array.isArray(parsed) ? parsed[0] : parsed
  if (!Array.isArray(result?.files)) {
    throw new Error(`Ark runtime could not obtain a package packlist: ${packageRoot}`)
  }
  const files = []
  for (const item of result.files) {
    if (typeof item?.path !== 'string' || item.path === '' || isAbsolute(item.path)
      || item.path.split('/').includes('..')) {
      throw new Error(`Ark runtime packlist has an unsafe member: ${packageRoot}: ${String(item?.path)}`)
    }
    let path = join(packageRoot, item.path)
    let metadata = await optionalLstat(path)
    if (metadata === undefined && /^LICEN[CS]E(?:\..+)?$/iu.test(item.path)) {
      path = join(repositoryRoot, item.path)
      metadata = await optionalLstat(path)
    }
    if (metadata === undefined || !metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Ark runtime packlist member is not an ordinary file: ${path}`)
    }
    files.push({
      path: item.path,
      sourcePath: relative(repositoryRoot, path).replaceAll('\\', '/'),
      sha256: createHash('sha256').update(await readFile(path)).digest('hex'),
    })
  }
  return files.sort((left, right) => left.path.localeCompare(right.path))
}

async function packageContentManifest(packageRoot) {
  const files = []
  const links = []
  const visit = async (directory, prefix = '') => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue
      const path = join(directory, entry.name)
      const child = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isSymbolicLink()) {
        const target = await realpath(path)
        if (target !== packageRoot && !target.startsWith(`${packageRoot}/`)) {
          throw new Error(`Ark root-lock package content has an escaping symlink: ${path}`)
        }
        links.push({ path: child, target: relative(packageRoot, target).replaceAll('\\', '/') })
      } else if (entry.isDirectory()) {
        await visit(path, child)
      } else if (entry.isFile()) {
        files.push({ path: child, sha256: createHash('sha256').update(await readFile(path)).digest('hex') })
      } else {
        throw new Error(`Ark root-lock package content has a special file: ${path}`)
      }
    }
  }
  await visit(packageRoot)
  files.sort((left, right) => left.path.localeCompare(right.path))
  links.sort((left, right) => left.path.localeCompare(right.path))
  return { files, links, contentManifestSha256: jsonSha256({ files, links }) }
}

async function rootInstalledExternalContent(repositoryRoot, resolutions) {
  const modulesRoot = join(repositoryRoot, 'node_modules')
  const expected = new Set(resolutions.map(entry => `${entry.name}@${entry.version}`))
  const roots = new Map()
  const visited = new Set()
  const inspectAlias = async alias => {
    const packageRoot = await realpath(alias)
    if (packageRoot !== modulesRoot && !packageRoot.startsWith(`${modulesRoot}/`)) {
      // A workspace link: node_modules aliases the repository's own package
      // directories. They are not external content and are skipped here.
      return
    }
    const manifestPath = join(packageRoot, 'package.json')
    if ((await optionalLstat(manifestPath))?.isFile() !== true) return
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    const identity = `${String(manifest.name)}@${String(manifest.version)}`
    if (!expected.has(identity)) return
    const matches = roots.get(identity) ?? new Set()
    matches.add(packageRoot)
    roots.set(identity, matches)
  }
  const inspectNodeModules = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === '.pnpm') continue
      const path = join(directory, entry.name)
      if (entry.name.startsWith('@')) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue
        for (const child of await readdir(path, { withFileTypes: true })) {
          if (child.isDirectory() || child.isSymbolicLink()) await inspectAlias(join(path, child.name))
        }
      } else if (entry.isDirectory() || entry.isSymbolicLink()) {
        await inspectAlias(path)
      }
    }
  }
  const visit = async directory => {
    const physical = await realpath(directory)
    if (visited.has(physical)) return
    visited.add(physical)
    if (directory.endsWith('/node_modules')) await inspectNodeModules(directory)
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) await visit(join(directory, entry.name))
    }
  }
  await visit(modulesRoot)
  const result = new Map()
  for (const resolution of resolutions) {
    const identity = `${resolution.name}@${resolution.version}`
    const candidates = roots.get(identity)
    if (candidates === undefined || candidates.size === 0) {
      // The root install pruned this resolution (a platform-scoped optional,
      // for example): record its absence explicitly. The receipt verification
      // then relies on the tarball integrity check instead of a content
      // manifest, and the runtime must not install the package either way.
      result.set(identity, null)
      continue
    }
    const manifests = []
    for (const packageRoot of candidates) manifests.push(await packageContentManifest(packageRoot))
    const digests = [...new Set(manifests.map(entry => entry.contentManifestSha256))]
    if (digests.length !== 1) {
      throw new Error(`Ark root lock has divergent installed content for ${identity}`)
    }
    result.set(identity, manifests[0])
  }
  return result
}

function scriptFileCandidates(manifest) {
  const values = []
  const add = value => {
    if (typeof value === 'string' && value !== '') values.push(value)
  }
  if (typeof manifest.bin === 'string') add(manifest.bin)
  else if (manifest.bin !== null && typeof manifest.bin === 'object' && !Array.isArray(manifest.bin)) {
    for (const value of Object.values(manifest.bin)) add(value)
  }
  for (const [name, command] of Object.entries(manifest.scripts ?? {})) {
    if (!PACK_LIFECYCLE_SCRIPTS.has(name) || typeof command !== 'string') continue
    for (const match of command.matchAll(/(?:^|[\s"'])((?:\.\.?\/|[A-Za-z0-9_.-]+\/)[A-Za-z0-9_./-]+\.(?:[cm]?js|ts|sh|py))(?:$|[\s"'])/gu)) {
      add(match[1])
    }
  }
  return [...new Set(values)]
}

async function sourceInputFiles(repositoryRoot, packageRoot, manifest, packlist) {
  const files = new Set()
  const addFile = async path => {
    const physical = resolve(path)
    if (physical !== repositoryRoot && !physical.startsWith(`${repositoryRoot}/`)) {
      throw new Error(`Ark runtime executable source input escapes the repository: ${path}`)
    }
    const metadata = await optionalLstat(physical)
    if (metadata === undefined || !metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Ark runtime executable source input is unavailable: ${physical}`)
    }
    files.add(physical)
  }
  const addTree = async (root) => {
    if (await optionalLstat(root) === undefined) return
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const path = join(root, entry.name)
      if (entry.isSymbolicLink()) {
        throw new Error(`Ark runtime source input must not be a symlink: ${path}`)
      }
      if (entry.isDirectory()) await addTree(path)
      else if (entry.isFile() && entry.name !== 'tsconfig.tsbuildinfo') files.add(path)
    }
  }
  for (const entry of await readdir(packageRoot, { withFileTypes: true })) {
    const path = join(packageRoot, entry.name)
    if (entry.isSymbolicLink() && (PACKAGE_INPUT_DIRECT_NAMES.has(entry.name) || PACKAGE_INPUT_TREES.has(entry.name))) {
      throw new Error(`Ark runtime source input must not be a symlink: ${path}`)
    }
    if (entry.isFile() && (
      PACKAGE_INPUT_DIRECT_NAMES.has(entry.name)
      || /^tsconfig\..+\.json$/u.test(entry.name)
    )) files.add(path)
  }
  for (const tree of PACKAGE_INPUT_TREES) await addTree(join(packageRoot, tree))
  for (const entry of packlist ?? []) await addFile(join(repositoryRoot, entry.sourcePath))
  for (const candidate of scriptFileCandidates(manifest)) await addFile(resolve(packageRoot, candidate))
  return [...files].sort()
}

async function sourceInputDigest(repositoryRoot, packageRoot, manifest, packlist) {
  const digest = createHash('sha256')
  const inputs = []
  for (const path of await sourceInputFiles(repositoryRoot, packageRoot, manifest, packlist)) {
    const inputPath = relative(repositoryRoot, path).replaceAll('\\', '/')
    const fileSha256 = createHash('sha256').update(await readFile(path)).digest('hex')
    digest.update(`${inputPath}\u0000${fileSha256}\n`)
    inputs.push({ path: inputPath, sha256: fileSha256 })
  }
  return { sourceSha256: digest.digest('hex'), inputs }
}

async function loadWorkspace(repositoryRoot) {
  const workspace = new Map()
  for (const path of await workspaceManifestPaths(repositoryRoot)) {
    if (await optionalLstat(path) === undefined) continue
    const raw = await readFile(path)
    const manifest = JSON.parse(raw.toString('utf8'))
    if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
      throw new Error(`Ark runtime workspace manifest lacks name/version: ${path}`)
    }
    if (workspace.has(manifest.name)) throw new Error(`Ark runtime workspace package is duplicated: ${manifest.name}`)
    const packageRoot = resolve(path, '..')
    const physicalRoot = await realpath(packageRoot)
    if (physicalRoot !== packageRoot) {
      throw new Error(`Ark runtime workspace package root must not resolve through a link: ${packageRoot}`)
    }
    workspace.set(manifest.name, {
      directory: relative(repositoryRoot, packageRoot).replaceAll('\\', '/'),
      manifest,
      manifestSha256: createHash('sha256').update(raw).digest('hex'),
      packageRoot,
    })
  }
  return workspace
}

async function repositoryInputDigests(repositoryRoot) {
  const inputs = []
  for (const relativePath of ARK_RUNTIME_REPOSITORY_INPUTS) {
    const path = join(repositoryRoot, relativePath)
    const metadata = await optionalLstat(path)
    if (metadata === undefined || !metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Ark runtime plan lacks an ordinary build input: ${path}`)
    }
    inputs.push({
      path: relativePath,
      sha256: createHash('sha256').update(await readFile(path)).digest('hex'),
    })
  }
  return inputs
}

function dependencyReference(value) {
  if (typeof value === 'string') return value
  if (value !== null && typeof value === 'object' && typeof value.version === 'string') return value.version
  return undefined
}

function isLocalReference(value) {
  return value.startsWith('link:') || value.startsWith('workspace:') || value.startsWith('file:')
}

function snapshotIdentity(name, reference, snapshots) {
  const direct = `${name}@${reference}`
  if (Object.hasOwn(snapshots, direct)) return direct
  const matches = Object.keys(snapshots).filter(key => key.startsWith(`${name}@${reference}(`))
  if (matches.length === 1) return matches[0]
  if (matches.length > 1) {
    throw new Error(`Ark root lock has ambiguous snapshot contexts for ${name}@${reference}`)
  }
  throw new Error(`Ark root lock lacks the exact snapshot ${name}@${reference}`)
}

function identityVersion(name, snapshotKey) {
  const prefix = `${name}@`
  if (!snapshotKey.startsWith(prefix)) throw new Error(`Ark root lock snapshot/name mismatch: ${snapshotKey}`)
  const value = snapshotKey.slice(prefix.length).split('(')[0]
  if (value === '' || value.startsWith('npm:')) {
    throw new Error(`Ark root lock uses an unsupported external alias: ${snapshotKey}`)
  }
  return value
}

function sortedRecord(value) {
  if (value === undefined) return undefined
  if (Array.isArray(value)) return [...value].sort()
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)))
  }
  return value
}

async function deriveRootLockedExternals(repositoryRoot, workspace, reached, identityPolicy, allowIdentityAnalysis) {
  const lockPath = join(repositoryRoot, 'pnpm-lock.yaml')
  const rootLock = parseYaml(await readFile(lockPath, 'utf8'))
  const snapshots = rootLock?.snapshots
  const packages = rootLock?.packages
  const importers = rootLock?.importers
  if (snapshots === null || typeof snapshots !== 'object' || Array.isArray(snapshots)
    || packages === null || typeof packages !== 'object' || Array.isArray(packages)
    || importers === null || typeof importers !== 'object' || Array.isArray(importers)) {
    throw new Error('Ark root pnpm lock lacks importers/packages/snapshots')
  }
  const workspaceNames = new Set(reached.keys())
  const queue = []
  const workspaceImporters = []
  for (const [name, record] of reached) {
    const importer = importers[record.directory]
    if (importer === undefined) throw new Error(`Ark root lock lacks workspace importer ${record.directory}`)
    const importerEdges = []
    for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const [dependency, value] of Object.entries(importer[section] ?? {})) {
        // An unsatisfied external peer is recorded in the importer's peer
        // section and is exactly what autoInstallPeers: false keeps out of
        // the runtime; skip it here so the plan demands only what the
        // runtime actually resolves. Satisfied peers are recorded under
        // dependencies and handled there.
        if (section === 'peerDependencies' && !workspace.has(dependency)) continue
        const reference = dependencyReference(value)
        const specifier = value?.specifier
        if (reference === undefined || typeof specifier !== 'string') {
          throw new Error(`Ark root lock importer edge is malformed: ${record.directory}:${section}:${dependency}`)
        }
        if (workspace.has(dependency)) {
          const target = workspace.get(dependency)
          const reachedTarget = reached.has(dependency)
          if (!reachedTarget && !(section === 'optionalDependencies' && !supportsArkRuntimeTarget(target.manifest))) {
            throw new Error(`Ark root lock reaches an unplanned workspace package: ${record.directory}:${dependency}`)
          }
          importerEdges.push({
            name: dependency,
            section,
            specifier,
            kind: reachedTarget ? 'workspace' : 'omitted-platform-workspace',
            version: target.manifest.version,
          })
          continue
        }
        if (isLocalReference(reference)) {
          throw new Error(`Ark root lock has a plan-external local importer edge: ${record.directory}:${dependency}`)
        }
        const snapshotKey = snapshotIdentity(dependency, reference, snapshots)
        importerEdges.push({
          name: dependency,
          section,
          specifier,
          kind: 'external',
          snapshotKey,
        })
        queue.push({ from: `${name}@${record.manifest.version}`, name: dependency, reference, section })
      }
    }
    // A peer-only workspace package records no importer edges in the root
    // lock — its peers are resolved by the consumer context and materialize
    // as real edges in the installed runtime lock. Synthesize the reached,
    // lock-unrecorded manifest peers so runtime-lock verification compares
    // the same edge set the install actually produces.
    const recorded = new Set(importerEdges.map(edge => edge.name))
    for (const [dependency, specifier] of Object.entries(record.manifest.peerDependencies ?? {})) {
      if (recorded.has(dependency) || !reached.has(dependency)) continue
      importerEdges.push({
        name: dependency,
        section: 'peerDependencies',
        specifier: String(specifier),
        kind: 'workspace',
        version: workspace.get(dependency).manifest.version,
      })
    }
    workspaceImporters.push({
      name,
      version: record.manifest.version,
      directory: record.directory,
      edges: importerEdges.sort((left, right) => (
        left.section.localeCompare(right.section) || left.name.localeCompare(right.name)
      )),
    })
  }
  const seenSnapshots = new Set()
  const exact = new Map()
  const edges = []
  const externalSnapshots = new Map()
  for (let index = 0; index < queue.length; index++) {
    const item = queue[index]
    const snapshotKey = snapshotIdentity(item.name, item.reference, snapshots)
    const version = identityVersion(item.name, snapshotKey)
    const packageKey = `${item.name}@${version}`
    const resolution = packages[packageKey]?.resolution
    if (resolution === undefined || typeof resolution.integrity !== 'string') {
      throw new Error(`Ark root lock external lacks exact integrity: ${packageKey}`)
    }
    const identity = `${item.name}@${version}`
    const previous = exact.get(identity)
    if (previous !== undefined && previous.integrity !== resolution.integrity) {
      throw new Error(`Ark root lock identity has conflicting integrity: ${identity}`)
    }
    exact.set(identity, { name: item.name, version, integrity: resolution.integrity })
    edges.push({ from: item.from, name: item.name, version, integrity: resolution.integrity, section: item.section })
    if (seenSnapshots.has(snapshotKey)) continue
    seenSnapshots.add(snapshotKey)
    const snapshot = snapshots[snapshotKey]
    const packageMetadata = packages[packageKey]
    // Record the snapshot's dependency edges under the runtime template's
    // autoInstallPeers: false semantics: peers the root auto-installed are
    // not part of the runtime closure, so they are filtered from the
    // recorded edge lists exactly as the traversal skips them.
    const snapshotDeclaredPeers = packageMetadata.peerDependencies ?? {}
    const withoutDeclaredPeers = (record) => Object.fromEntries(
      Object.entries(record ?? {}).filter(([dependency]) => snapshotDeclaredPeers[dependency] === undefined))
    externalSnapshots.set(snapshotKey, {
      snapshotKey,
      name: item.name,
      version,
      integrity: resolution.integrity,
      resolution: sortedRecord(packageMetadata.resolution),
      os: sortedRecord(packageMetadata.os),
      cpu: sortedRecord(packageMetadata.cpu),
      engines: sortedRecord(packageMetadata.engines),
      hasBin: packageMetadata.hasBin === true,
      requiresBuild: packageMetadata.requiresBuild === true,
      optional: packageMetadata.optional === true,
      peerDependencies: sortedRecord(packageMetadata.peerDependencies),
      peerDependenciesMeta: sortedRecord(packageMetadata.peerDependenciesMeta),
      dependencies: sortedRecord(withoutDeclaredPeers(snapshot?.dependencies)),
      optionalDependencies: sortedRecord(withoutDeclaredPeers(snapshot?.optionalDependencies)),
      transitivePeerDependencies: sortedRecord(snapshot?.transitivePeerDependencies),
    })
    // The runtime template resolves with autoInstallPeers: false — its
    // reviewed standalone policy — so a peer of an external package enters
    // the runtime only through some real dependency edge, never through the
    // peer edge itself. Mirror that: peers declared by an external package
    // are not part of the runtime closure.
    const declaredPeers = packageMetadata.peerDependencies ?? {}
    for (const section of ['dependencies', 'optionalDependencies']) {
      for (const [dependency, value] of Object.entries(snapshot?.[section] ?? {})) {
        if (workspaceNames.has(dependency)) continue
        if (declaredPeers[dependency] !== undefined) continue
        const reference = dependencyReference(value)
        if (reference === undefined || isLocalReference(reference)) continue
        queue.push({ from: identity, name: dependency, reference, section })
      }
    }
  }
  const externalResolutions = [...exact.values()].sort((left, right) => (
    left.name.localeCompare(right.name) || left.version.localeCompare(right.version)
  ))
  // Bind each external resolution to the content the root install actually
  // carries on disk: the runtime template's installed bytes must derive from
  // exactly this content, so the plan carries it for receipt verification.
  const installedContent = await rootInstalledExternalContent(repositoryRoot, externalResolutions)
  for (const entry of externalResolutions) {
    const content = installedContent.get(`${entry.name}@${entry.version}`)
    if (content === null || content === undefined) {
      entry.contentManifestSha256 = null
      continue
    }
    entry.contentManifestSha256 = content.contentManifestSha256
    entry.contentFiles = content.files
    entry.contentLinks = content.links
  }
  const versionsByName = new Map()
  for (const entry of externalResolutions) {
    const versions = versionsByName.get(entry.name) ?? []
    versions.push(entry.version)
    versionsByName.set(entry.name, versions)
  }
  const declared = identityPolicy.allowedMultipleVersions
  for (const [name, versions] of versionsByName) {
    const unique = [...new Set(versions)].sort()
    if (unique.length < 2) continue
    if (JSON.stringify(unique) !== JSON.stringify(declared[name]) && allowIdentityAnalysis !== true) {
      throw new Error(`Ark root lock has an undeclared multiversion external: ${name} [${unique.join(', ')}]`)
    }
  }
  return {
    rootLockSha256: createHash('sha256').update(await readFile(lockPath)).digest('hex'),
    externalResolutions,
    externalResolutionEdges: edges.sort((left, right) => (
      left.from.localeCompare(right.from) || left.name.localeCompare(right.name)
      || left.version.localeCompare(right.version) || left.section.localeCompare(right.section)
    )),
    rootLockGraph: {
      workspaceImporters: workspaceImporters.sort((left, right) => left.name.localeCompare(right.name)),
      externalSnapshots: [...externalSnapshots.values()].sort((left, right) => (
        left.snapshotKey.localeCompare(right.snapshotKey)
      )),
    },
  }
}

function repositorySourceIdentity(repositoryRoot, sourceSnapshotSha256) {
  const runGit = args => {
    const result = spawnSync('git', args, { cwd: repositoryRoot, encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 })
    if (result.status !== 0) throw new Error(`Ark runtime could not read Git source identity: git ${args.join(' ')}`)
    return result.stdout
  }
  const commit = runGit(['rev-parse', 'HEAD']).toString('utf8').trim()
  const dirtyDiff = runGit(['diff', '--binary', '--no-ext-diff', 'HEAD', '--'])
  const status = runGit(['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  return {
    commit,
    dirty: status.length > 0,
    dirtyDiffSha256: createHash('sha256').update(dirtyDiff).digest('hex'),
    dirtyStatusSha256: createHash('sha256').update(status).digest('hex'),
    sourceSnapshotSha256,
  }
}

/** npm-compatible positive/negative platform selector for one manifest axis. */
function platformAxisAllows(values, actual) {
  if (!Array.isArray(values) || !values.every(value => typeof value === 'string')) return true
  if (values.includes(`!${actual}`)) return false
  const positive = values.filter(value => !value.startsWith('!'))
  return positive.length === 0 || positive.includes(actual)
}

/** Whether one workspace package can be installed for Ark.app's exact target. */
function supportsArkRuntimeTarget(manifest) {
  return platformAxisAllows(manifest.os, ARK_RUNTIME_TARGET.os)
    && platformAxisAllows(manifest.cpu, ARK_RUNTIME_TARGET.cpu)
}

/** Resolve one runtime-template asset back to its current repository source. */
export function runtimeAssetSource(repositoryRoot, relativePath) {
  if (ARK_RUNTIME_PROFILE_FILES.has(relativePath)) {
    return join(repositoryRoot, 'integrations/jiuzhang/profile', relativePath.slice('jiuzhang/profile/'.length))
  }
  if (['start.mjs', 'runtime.mjs', 'runtime-closure.mjs'].includes(relativePath)) {
    return join(repositoryRoot, 'integrations/jiuzhang/src', relativePath)
  }
  throw new Error(`Ark runtime policy names an unsupported source asset: ${relativePath}`)
}

/**
 * Build the exact current-source workspace closure rooted at Ark's dedicated runner.
 * @param {string} root - absolute DeepSeek Harness repository root.
 * @param {{requireBuilt?: boolean, allowForbiddenAnalysis?: boolean, allowIdentityAnalysis?: boolean, verifyPacklists?: boolean}} options - build controls.
 * @returns {Promise<object>} deterministic closure plan for pack and receipt generation.
 */
export async function createArkRuntimePlan(root, options = {}) {
  if (!isAbsolute(root)) throw new Error('Ark runtime plan root must be absolute')
  const repositoryRoot = await realpath(resolve(root))
  const policyPath = join(repositoryRoot, 'integrations/jiuzhang/profile/forbidden-runtime-packages.json')
  const policyRaw = await readFile(policyPath)
  const policy = JSON.parse(policyRaw.toString('utf8'))
  if (!Array.isArray(policy.required) || !policy.required.every(name => typeof name === 'string')
    || !Array.isArray(policy.requiredFiles) || !policy.requiredFiles.every(path => typeof path === 'string')
    || !Array.isArray(policy.exact) || !Array.isArray(policy.prefixes)) {
    throw new Error(`Ark runtime policy is invalid: ${policyPath}`)
  }
  const identityPolicyPath = join(repositoryRoot, 'integrations/jiuzhang/profile/runtime-identity-policy.json')
  const identityPolicyRaw = await readFile(identityPolicyPath)
  const identityPolicy = JSON.parse(identityPolicyRaw.toString('utf8'))
  if (identityPolicy.version !== 1 || identityPolicy.target !== ARK_RUNTIME_TARGET.id
    || identityPolicy.allowDuplicatePhysicalIdentities !== false
    || identityPolicy.allowExternalHardlinks !== false
    || identityPolicy.allowedMultipleVersions === null
    || typeof identityPolicy.allowedMultipleVersions !== 'object'
    || Array.isArray(identityPolicy.allowedMultipleVersions)) {
    throw new Error(`Ark runtime identity policy is invalid: ${identityPolicyPath}`)
  }
  for (const [name, versions] of Object.entries(identityPolicy.allowedMultipleVersions)) {
    if (!Array.isArray(versions) || versions.length < 2
      || !versions.every(version => typeof version === 'string' && version !== '')
      || JSON.stringify(versions) !== JSON.stringify([...new Set(versions)].sort())) {
      throw new Error(`Ark runtime identity policy has an invalid exact multiversion entry: ${name}`)
    }
  }

  const workspace = await loadWorkspace(repositoryRoot)
  const reached = new Map()
  const queue = [...ARK_RUNTIME_ROOT_PACKAGES]
  const parents = new Map(ARK_RUNTIME_ROOT_PACKAGES.map(name => [name, undefined]))
  const external = new Map()
  const missingWorkspace = new Set()
  for (let index = 0; index < queue.length; index++) {
    const name = queue[index]
    if (reached.has(name)) continue
    const record = workspace.get(name)
    if (record === undefined) {
      missingWorkspace.add(name)
      continue
    }
    reached.set(name, record)
    const peerMeta = record.manifest.peerDependenciesMeta ?? {}
    for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      const dependencies = record.manifest[section]
      if (dependencies === undefined || dependencies === null || typeof dependencies !== 'object'
        || Array.isArray(dependencies)) continue
      for (const dependency of Object.keys(dependencies).sort()) {
        const range = dependencies[dependency]
        if (section === 'peerDependencies' && peerMeta[dependency]?.optional === true) continue
        if (workspace.has(dependency)) {
          const dependencyRecord = workspace.get(dependency)
          if (section === 'optionalDependencies' && !supportsArkRuntimeTarget(dependencyRecord.manifest)) {
            continue
          }
          if (!parents.has(dependency)) parents.set(dependency, name)
          queue.push(dependency)
        } else if (typeof range === 'string' && range.startsWith('workspace:')) {
          missingWorkspace.add(`${name} -> ${dependency}`)
        } else {
          external.set(`${dependency}\u0000${String(range)}`, { name: dependency, range: String(range) })
        }
      }
    }
  }
  if (missingWorkspace.size > 0) {
    throw new Error(`Ark runtime plan has unresolved workspace packages: ${[...missingWorkspace].sort().join(', ')}`)
  }

  // A required identity may be reached as a workspace package or as an
  // external dependency of a reached one; both satisfy the policy.
  const reachedNames = new Set(reached.keys())
  for (const entry of external.keys()) reachedNames.add(entry.split('\u0000')[0])
  const missingRequired = policy.required.filter(name => !reachedNames.has(name)).sort()
  if (missingRequired.length > 0) {
    throw new Error(`Ark runtime plan lacks required package identities: ${missingRequired.join(', ')}`)
  }
  const forbidden = [...reachedNames]
    .filter(name => policy.exact.includes(name) || policy.prefixes.some(prefix => name.startsWith(prefix)))
    .sort()
  const forbiddenChains = forbidden.map((name) => {
    const chain = [name]
    let parent = parents.get(name)
    while (parent !== undefined) {
      chain.unshift(parent)
      parent = parents.get(parent)
    }
    return chain.join(' -> ')
  })
  if (forbidden.length > 0 && options.allowForbiddenAnalysis !== true) {
    throw new Error(`Ark runtime plan reaches forbidden packages: ${forbiddenChains.join('; ')}`)
  }

  const assetDigests = []
  for (const relativePath of policy.requiredFiles) {
    const source = runtimeAssetSource(repositoryRoot, relativePath)
    const stat = await optionalLstat(source)
    if (stat === undefined || !stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Ark runtime plan lacks required current-source asset: ${source}`)
    }
    const bytes = await readFile(source)
    assetDigests.push({
      path: relativePath,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })
  }

  const reachedEntries = [...reached]
  const packages = new Array(reachedEntries.length)
  let packageCursor = 0
  const inspectPackage = async () => {
    while (packageCursor < reachedEntries.length) {
      const index = packageCursor++
      const [name, record] = reachedEntries[index]
      const packlist = options.verifyPacklists === true
        ? await packagePacklist(repositoryRoot, record.packageRoot)
        : []
      const source = await sourceInputDigest(
        repositoryRoot,
        record.packageRoot,
        record.manifest,
        packlist,
      )
      packages[index] = {
        name,
        version: record.manifest.version,
        directory: record.directory,
        manifestSha256: record.manifestSha256,
        sourceSha256: source.sourceSha256,
        sourceInputs: source.inputs,
        packlist,
        packlistSha256: createHash('sha256').update(JSON.stringify(packlist)).digest('hex'),
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, reachedEntries.length) }, inspectPackage))
  packages.sort((left, right) => left.name.localeCompare(right.name))
  if (options.requireBuilt === true) {
    const staleBuilds = []
    for (const entry of packages) {
      const main = workspace.get(entry.name)?.manifest.main
      if (typeof main !== 'string') continue
      const built = join(repositoryRoot, entry.directory, main)
      const stat = await optionalLstat(built)
      if (stat === undefined || !stat.isFile()) staleBuilds.push(`${entry.name}: ${relative(repositoryRoot, built)}`)
    }
    if (staleBuilds.length > 0) {
      throw new Error(`Ark runtime plan requires fresh built package entries: ${staleBuilds.join(', ')}`)
    }
  }

  const repositoryInputs = await repositoryInputDigests(repositoryRoot)
  const locked = await deriveRootLockedExternals(
    repositoryRoot,
    workspace,
    reached,
    identityPolicy,
    options.allowIdentityAnalysis,
  )
  const digest = createHash('sha256')
  for (const entry of packages) {
    digest.update(`${entry.name}\u0000${entry.version}\u0000${entry.manifestSha256}\u0000${entry.sourceSha256}\n`)
  }
  for (const asset of assetDigests) digest.update(`${asset.path}\u0000${asset.sha256}\n`)
  for (const input of repositoryInputs) digest.update(`${input.path}\u0000${input.sha256}\n`)
  for (const entry of locked.externalResolutions) {
    digest.update(`${entry.name}\u0000${entry.version}\u0000${entry.integrity}\n`)
  }
  digest.update(`identity-policy\u0000${createHash('sha256').update(identityPolicyRaw).digest('hex')}\n`)
  const sourceDigest = digest.digest('hex')
  return {
    version: 3,
    target: ARK_RUNTIME_TARGET.id,
    deferredPlatforms: ['win-x64'],
    roots: [...ARK_RUNTIME_ROOT_PACKAGES],
    requiredPackages: [...policy.required].sort(),
    requiredFiles: assetDigests,
    forbiddenPackages: forbidden,
    forbiddenChains,
    workspacePackageCount: packages.length,
    packages,
    packlistsComplete: options.verifyPacklists === true,
    repositoryInputs,
    externalDependencies: [...external.values()].sort((left, right) => (
      left.name.localeCompare(right.name) || left.range.localeCompare(right.range)
    )),
    rootLockSha256: locked.rootLockSha256,
    externalResolutions: locked.externalResolutions,
    externalResolutionEdges: locked.externalResolutionEdges,
    rootLockGraph: locked.rootLockGraph,
    identityPolicySha256: createHash('sha256').update(identityPolicyRaw).digest('hex'),
    sourceDigest,
    sourceIdentity: repositorySourceIdentity(repositoryRoot, sourceDigest),
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const plan = await createArkRuntimePlan(resolve(process.argv[2] ?? '.'))
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
}
