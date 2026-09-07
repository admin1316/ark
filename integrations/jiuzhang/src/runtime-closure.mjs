import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { dirname, extname, isAbsolute, join, parse, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const { load: parseYaml } = require('js-yaml')

const PROVENANCE_DIRECTORY = '.ark-provenance'
const JAVASCRIPT_EXTENSION = /\.[cm]?js$/u

async function optionalLstat(path) {
  try {
    return await lstat(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function sha256File(path) {
  return sha256(await readFile(path))
}

function normalizedRelative(root, path) {
  const value = relative(root, path).replaceAll('\\', '/')
  if (value === '' || value === '..' || value.startsWith('../') || isAbsolute(value)) {
    throw new Error(`Ark runtime path escapes its root: ${path}`)
  }
  return value
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableValue(child)]))
  }
  return value
}

export function stableJson(value) {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`
}

export function jsonSha256(value) {
  return sha256(stableJson(value))
}

function safeEntry(value) {
  const normalized = value.startsWith('./') ? value.slice(2) : value
  if (normalized === '' || normalized.startsWith('/') || normalized.includes('\\')
    || normalized.split('/').includes('..')) {
    throw new Error(`Ark runtime manifest has an unsafe JavaScript entry: ${value}`)
  }
  return normalized
}

/** Return concrete manifest-declared JavaScript entry patterns. */
export function packageJavaScriptEntries(manifest) {
  const entries = new Set()
  const add = (value) => {
    if (typeof value !== 'string' || value === '') return
    if (!JAVASCRIPT_EXTENSION.test(value) && !value.includes('*')) return
    const normalized = safeEntry(value)
    if (JAVASCRIPT_EXTENSION.test(normalized) || normalized.includes('*')) entries.add(normalized)
  }
  const visit = (value) => {
    if (typeof value === 'string') return add(value)
    if (Array.isArray(value)) {
      for (const child of value) visit(child)
    } else if (value !== null && typeof value === 'object') {
      for (const child of Object.values(value)) visit(child)
    }
  }
  add(manifest?.main)
  if (typeof manifest?.bin === 'string') add(manifest.bin)
  else if (manifest?.bin !== null && typeof manifest?.bin === 'object' && !Array.isArray(manifest.bin)) {
    for (const value of Object.values(manifest.bin)) add(value)
  }
  visit(manifest?.exports)
  visit(manifest?.imports)
  return [...entries].sort()
}

/** Reject one packed module source that the selected Node cannot parse. */
export function assertJavaScriptModuleSyntax(
  source,
  label,
  nodeExecutable = process.execPath,
  packageType = 'module',
) {
  const inputType = label.endsWith('.cjs') || (label.endsWith('.js') && packageType !== 'module')
    ? 'commonjs'
    : 'module'
  const result = spawnSync(
    nodeExecutable,
    ['--check', `--input-type=${inputType}`, '-'],
    { input: source, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  )
  if (result.error !== undefined) {
    throw new Error(`Ark runtime could not syntax-check ${label}: ${result.error.message}`)
  }
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    const outcome = result.signal === null ? `exit ${String(result.status)}` : `signal ${result.signal}`
    throw new Error(`Ark runtime has an unparseable JavaScript entry ${label} (${outcome})${detail === '' ? '' : `\n${detail}`}`)
  }
}

function assertJavaScriptPathSyntax(path, label, nodeExecutable) {
  const result = spawnSync(
    nodeExecutable,
    ['--check', path],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
  if (result.error !== undefined) {
    throw new Error(`Ark runtime could not syntax-check ${label}: ${result.error.message}`)
  }
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    const outcome = result.signal === null ? `exit ${String(result.status)}` : `signal ${result.signal}`
    throw new Error(`Ark runtime has an unparseable JavaScript entry ${label} (${outcome})${detail === '' ? '' : `\n${detail}`}`)
  }
}

async function packagePayload(packageRoot) {
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
          throw new Error(`Ark runtime package contains an escaping symlink: ${path}`)
        }
        links.push({ path: child, target: normalizedRelative(packageRoot, target) })
      } else if (entry.isDirectory()) {
        await visit(path, child)
      } else if (entry.isFile()) {
        const identity = await lstat(path)
        if (identity.nlink !== 1) {
          throw new Error(`Ark runtime package contains a hardlinked file: ${path} (nlink=${String(identity.nlink)})`)
        }
        files.push({ path: child, sha256: await sha256File(path) })
      } else {
        throw new Error(`Ark runtime package contains a special file: ${path}`)
      }
    }
  }
  await visit(packageRoot)
  files.sort((left, right) => left.path.localeCompare(right.path))
  links.sort((left, right) => left.path.localeCompare(right.path))
  return {
    files,
    links,
    contentSha256: jsonSha256({ files, links }),
  }
}

async function collectJavaScriptFiles(packageRoot) {
  const files = []
  const visit = async (directory, prefix = '') => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.isSymbolicLink()) continue
      const path = join(directory, entry.name)
      const child = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) await visit(path, child)
      else if (entry.isFile() && JAVASCRIPT_EXTENSION.test(entry.name)) files.push(child)
    }
  }
  await visit(packageRoot)
  return files.sort()
}

function wildcardPattern(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/gu, '\\$&').replaceAll('*', '(.+)')
  return new RegExp(`^${escaped}$`, 'u')
}

function resolveRelativeModule(fromEntry, specifier, available) {
  if (!specifier.startsWith('.')) return undefined
  const extension = extname(specifier)
  if (extension !== '' && !JAVASCRIPT_EXTENSION.test(extension)) return undefined
  const base = resolve('/', dirname(fromEntry), specifier).slice(1)
  for (const candidate of [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`, `${base}/index.js`]) {
    if (available.has(candidate)) return candidate
  }
  return undefined
}

async function actualJavaScriptEntries(record, nodeExecutable) {
  const availableList = await collectJavaScriptFiles(record.packageRoot)
  const available = new Set(availableList)
  const declared = packageJavaScriptEntries(record.manifest)
  const roots = new Set()
  for (const entry of declared) {
    if (entry.includes('*')) {
      const matcher = wildcardPattern(entry)
      const matches = availableList.filter(candidate => matcher.test(candidate))
      for (const match of matches) roots.add(match)
    } else {
      if (!available.has(entry)) {
        throw new Error(`Ark runtime package ${record.name} lacks its JavaScript entry: ${entry}`)
      }
      roots.add(entry)
    }
  }
  const queue = [...roots]
  const inspected = new Set()
  const staticImportPattern = /(?:\bimport\s+[^"']*?\bfrom\s*|\bexport\s+[^"']*?\bfrom\s*)["']([^"']+)["']/gu
  const sideEffectImportPattern = /\bimport\s*["']([^"']+)["']/gu
  const dynamicImportPattern = /(?:\bimport\s*\(|\brequire\s*\()\s*["']([^"']+)["']/gu
  const unresolvedRelativeImports = new Set()
  for (let index = 0; index < queue.length; index++) {
    const entry = queue[index]
    if (inspected.has(entry)) continue
    inspected.add(entry)
    const path = resolve(record.packageRoot, entry)
    if (path === record.packageRoot || !path.startsWith(`${record.packageRoot}/`)) {
      throw new Error(`Ark runtime package ${record.name} has an escaping JavaScript entry: ${entry}`)
    }
    const physical = await realpath(path)
    if (physical !== path || !physical.startsWith(`${record.packageRoot}/`)) {
      throw new Error(`Ark runtime package ${record.name} has a linked JavaScript entry: ${entry}`)
    }
    const source = await readFile(path, 'utf8')
    assertJavaScriptPathSyntax(path, `${record.name}:${entry}`, nodeExecutable)
    for (const match of source.matchAll(staticImportPattern)) {
      const imported = resolveRelativeModule(entry, match[1], available)
      if (imported === undefined && match[1].startsWith('.')) {
        if (record.name.startsWith('@deepseek-ai/')) {
          throw new Error(`Ark runtime static JavaScript import is unresolved: ${entry} -> ${match[1]}`)
        }
        unresolvedRelativeImports.add(`${entry} -> ${match[1]}`)
      }
      if (imported !== undefined && !inspected.has(imported)) queue.push(imported)
    }
    for (const match of source.matchAll(sideEffectImportPattern)) {
      const imported = resolveRelativeModule(entry, match[1], available)
      if (imported === undefined && match[1].startsWith('.')) {
        if (record.name.startsWith('@deepseek-ai/')) {
          throw new Error(`Ark runtime static JavaScript import is unresolved: ${entry} -> ${match[1]}`)
        }
        unresolvedRelativeImports.add(`${entry} -> ${match[1]}`)
      }
      if (imported !== undefined && !inspected.has(imported)) queue.push(imported)
    }
    for (const match of source.matchAll(dynamicImportPattern)) {
      const imported = resolveRelativeModule(entry, match[1], available)
      if (imported === undefined && match[1].startsWith('.')) {
        if (record.name.startsWith('@deepseek-ai/')) {
          throw new Error(`Ark runtime dynamic JavaScript import is unresolved: ${entry} -> ${match[1]}`)
        }
        unresolvedRelativeImports.add(`${entry} -> ${match[1]}`)
      }
      if (imported !== undefined && !inspected.has(imported)) queue.push(imported)
    }
  }
  return {
    entries: [...inspected].sort(),
    unresolvedRelativeImports: [...unresolvedRelativeImports].sort(),
  }
}

async function discoverPackageRecords(runtimeRoot) {
  const recordsByRoot = new Map()
  const visitedDirectories = new Set()
  const symlinks = new Map()
  const inspectPackageAlias = async (alias) => {
    const target = await realpath(alias)
    if (target !== runtimeRoot && !target.startsWith(`${runtimeRoot}/`)) {
      throw new Error(`Ark runtime package link escapes the runtime: ${alias}`)
    }
    const manifestPath = join(target, 'package.json')
    const manifestStat = await optionalLstat(manifestPath)
    if (manifestStat === undefined) return
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
      throw new Error(`Ark runtime package manifest is not an ordinary file: ${manifestPath}`)
    }
    const raw = await readFile(manifestPath)
    const manifest = JSON.parse(raw.toString('utf8'))
    if (typeof manifest.name !== 'string' || manifest.name === ''
      || typeof manifest.version !== 'string' || manifest.version === '') {
      throw new Error(`Ark runtime package manifest lacks name/version: ${manifestPath}`)
    }
    let record = recordsByRoot.get(target)
    if (record === undefined) {
      const payload = await packagePayload(target)
      record = {
        name: manifest.name,
        version: manifest.version,
        manifest,
        manifestSha256: sha256(raw),
        contentSha256: payload.contentSha256,
        contentFiles: payload.files,
        contentLinks: payload.links,
        integrity: `sha256-${payload.contentSha256}`,
        packageRoot: target,
        locator: normalizedRelative(runtimeRoot, target),
        aliases: new Set(),
      }
      recordsByRoot.set(target, record)
    }
    record.aliases.add(normalizedRelative(runtimeRoot, alias))
  }
  const inspectNodeModules = async (modulesRoot) => {
    for (const entry of await readdir(modulesRoot, { withFileTypes: true })) {
      if (entry.name === '.pnpm') continue
      const path = join(modulesRoot, entry.name)
      if (entry.name.startsWith('@')) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) {
          throw new Error(`Ark runtime package scope is not an ordinary directory: ${path}`)
        }
        for (const child of await readdir(path, { withFileTypes: true })) {
          if (child.isDirectory() || child.isSymbolicLink()) await inspectPackageAlias(join(path, child.name))
        }
      } else if (entry.isDirectory() || entry.isSymbolicLink()) {
        await inspectPackageAlias(path)
      }
    }
  }
  const visit = async (directory) => {
    const physical = await realpath(directory)
    if (physical !== runtimeRoot && !physical.startsWith(`${runtimeRoot}/`)) {
      throw new Error(`Ark runtime directory escapes the runtime: ${directory}`)
    }
    if (visitedDirectories.has(physical)) return
    visitedDirectories.add(physical)
    if (directory.endsWith('/node_modules')) await inspectNodeModules(directory)
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        const target = await realpath(path)
        if (target !== runtimeRoot && !target.startsWith(`${runtimeRoot}/`)) {
          throw new Error(`Ark runtime symlink escapes the runtime: ${path}`)
        }
        symlinks.set(normalizedRelative(runtimeRoot, path), normalizedRelative(runtimeRoot, target))
        continue
      }
      if (entry.isDirectory()) await visit(path)
    }
  }
  await visit(join(runtimeRoot, 'node_modules'))
  return {
    records: [...recordsByRoot.values()],
    symlinks: [...symlinks.entries()].map(([path, target]) => ({ path, target }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  }
}

async function resolveDependency(startRoot, name, runtimeRoot, recordsByRoot) {
  const segments = name.split('/')
  let directory = startRoot
  while (directory === runtimeRoot || directory.startsWith(`${runtimeRoot}/`)) {
    const candidate = join(directory, 'node_modules', ...segments)
    if (await optionalLstat(candidate) !== undefined) {
      const physical = await realpath(candidate)
      if (physical !== runtimeRoot && !physical.startsWith(`${runtimeRoot}/`)) {
        throw new Error(`Ark runtime dependency link escapes the runtime: ${candidate}`)
      }
      const record = recordsByRoot.get(physical)
      if (record === undefined) throw new Error(`Ark runtime dependency has no package record: ${candidate}`)
      return record
    }
    if (directory === runtimeRoot) break
    directory = dirname(directory)
  }
  return undefined
}

async function reachablePackageGraph(runtimeRoot, rootManifest, records) {
  const recordsByRoot = new Map(records.map(record => [record.packageRoot, record]))
  const reached = new Set()
  const edges = []
  const queue = [{ name: '<runtime>', packageRoot: runtimeRoot, manifest: rootManifest }]
  for (let index = 0; index < queue.length; index++) {
    const owner = queue[index]
    const peerMeta = owner.manifest.peerDependenciesMeta ?? {}
    for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      const table = owner.manifest[section]
      if (table === undefined || table === null || typeof table !== 'object' || Array.isArray(table)) continue
      for (const dependency of Object.keys(table).sort()) {
        const resolved = await resolveDependency(owner.packageRoot, dependency, runtimeRoot, recordsByRoot)
        const optional = section === 'optionalDependencies'
          || (section === 'peerDependencies' && peerMeta[dependency]?.optional === true)
        if (resolved === undefined) {
          if (optional) continue
          throw new Error(`Ark runtime dependency is unresolved: ${owner.name} -> ${dependency}`)
        }
        edges.push({ from: owner.name, to: `${resolved.name}@${resolved.version}`, section })
        if (!reached.has(resolved.packageRoot)) {
          reached.add(resolved.packageRoot)
          queue.push(resolved)
        }
      }
    }
  }
  return { reached, edges: edges.sort((left, right) => (
    left.from.localeCompare(right.from) || left.to.localeCompare(right.to) || left.section.localeCompare(right.section)
  )) }
}

async function loadPolicy(policyPath) {
  const policy = JSON.parse(await readFile(policyPath, 'utf8'))
  if (!Array.isArray(policy?.required) || !policy.required.every(value => typeof value === 'string')
    || !Array.isArray(policy?.requiredFiles) || !policy.requiredFiles.every(value => typeof value === 'string')
    || !Array.isArray(policy?.exact) || !policy.exact.every(value => typeof value === 'string')
    || !Array.isArray(policy?.prefixes) || !policy.prefixes.every(value => typeof value === 'string')) {
    throw new Error(`Ark runtime package policy is invalid: ${policyPath}`)
  }
  return policy
}

async function loadIdentityPolicy(runtimeRoot) {
  const path = join(runtimeRoot, 'jiuzhang/profile/runtime-identity-policy.json')
  const policy = JSON.parse(await readFile(path, 'utf8'))
  if (policy.version !== 1 || policy.target !== 'macos-arm64'
    || policy.allowDuplicatePhysicalIdentities !== false
    || policy.allowExternalHardlinks !== false
    || policy.symlinks?.mode !== 'receipt-exact'
    || policy.symlinks?.allowEscaping !== false
    || policy.allowedMultipleVersions === null
    || typeof policy.allowedMultipleVersions !== 'object'
    || Array.isArray(policy.allowedMultipleVersions)) {
    throw new Error(`Ark runtime identity policy is invalid: ${path}`)
  }
  for (const [name, versions] of Object.entries(policy.allowedMultipleVersions)) {
    if (!Array.isArray(versions) || versions.length < 2
      || !versions.every(version => typeof version === 'string' && version !== '')
      || stableJson(versions) !== stableJson([...new Set(versions)].sort())) {
      throw new Error(`Ark runtime identity policy has an invalid exact multiversion entry: ${name}`)
    }
  }
  return policy
}

async function ordinaryRoot(path, label) {
  const metadata = await optionalLstat(path)
  if (metadata === undefined || !metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} is not an ordinary directory: ${path}`)
  }
  return await realpath(path)
}

/** Produce the deterministic recursive installed-runtime identity manifest. */
export async function createArkRuntimeManifest(runtimePath, policyPath, options = {}) {
  if (!isAbsolute(runtimePath) || !isAbsolute(policyPath)) {
    throw new Error('Ark runtime closure paths must be absolute')
  }
  const runtimeRoot = await ordinaryRoot(resolve(runtimePath), 'Ark runtime root')
  if (runtimeRoot === parse(runtimeRoot).root) throw new Error('Ark runtime root cannot be a filesystem root')
  const nodeModules = await ordinaryRoot(join(runtimeRoot, 'node_modules'), 'Ark runtime node_modules')
  if (nodeModules !== join(runtimeRoot, 'node_modules')) {
    throw new Error(`Ark runtime node_modules must not resolve through a link: ${nodeModules}`)
  }
  const bypasses = (await readdir(runtimeRoot, { withFileTypes: true }))
    .filter(entry => entry.name.startsWith('node_modules.'))
    .map(entry => entry.name)
    .sort()
  if (bypasses.length > 0) {
    throw new Error(`Ark runtime contains unchecked package-tree siblings: ${bypasses.join(', ')}`)
  }
  const rootManifestPath = join(runtimeRoot, 'package.json')
  const rootManifestStat = await optionalLstat(rootManifestPath)
  if (rootManifestStat === undefined || !rootManifestStat.isFile() || rootManifestStat.isSymbolicLink()) {
    throw new Error(`Ark runtime lacks an ordinary root package manifest: ${rootManifestPath}`)
  }
  const rootManifestRaw = await readFile(rootManifestPath)
  const rootManifest = JSON.parse(rootManifestRaw.toString('utf8'))
  const policy = await loadPolicy(policyPath)
  const identityPolicy = await loadIdentityPolicy(runtimeRoot)
  const requiredFiles = []
  for (const relativePath of policy.requiredFiles) {
    const normalized = safeEntry(relativePath)
    const path = join(runtimeRoot, normalized)
    const metadata = await optionalLstat(path)
    if (metadata === undefined || !metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Ark runtime lacks required current-source asset: ${path}`)
    }
    requiredFiles.push({ path: normalized, sha256: await sha256File(path) })
  }
  const entry = join(runtimeRoot, 'node_modules/@deepseek-ai/dsh-native-api-runner/lib/bin.js')
  if ((await optionalLstat(entry))?.isFile() !== true) {
    throw new Error(`Ark runtime lacks the dedicated native API entry: ${entry}`)
  }
  const discovered = await discoverPackageRecords(runtimeRoot)
  const records = discovered.records
  const exactIdentityRoots = new Map()
  for (const record of records) {
    const identity = `${record.name}@${record.version}`
    const roots = exactIdentityRoots.get(identity) ?? []
    roots.push(record.locator)
    exactIdentityRoots.set(identity, roots)
  }
  const duplicatePhysical = [...exactIdentityRoots.entries()].filter(([, roots]) => roots.length > 1)
  const duplicatePhysicalPackages = duplicatePhysical.map(([identity, roots]) => {
    const matches = records.filter(record => `${record.name}@${record.version}` === identity)
    const contentHashes = [...new Set(matches.map(record => record.contentSha256))]
    if (contentHashes.length !== 1) {
      throw new Error(`Ark runtime duplicate identity has different content: ${identity}`)
    }
    return { identity, locators: roots.sort(), contentSha256: contentHashes[0] }
  }).sort((left, right) => left.identity.localeCompare(right.identity))
  if (duplicatePhysicalPackages.length > 0) {
    throw new Error(`Ark runtime contains duplicate physical package identities: ${duplicatePhysicalPackages.map(
      entry => `${entry.identity} [${entry.locators.join(', ')}]`,
    ).join('; ')}`)
  }
  const names = new Set(records.map(record => record.name))
  const forbidden = [...names]
    .filter(name => policy.exact.includes(name) || policy.prefixes.some(prefix => name.startsWith(prefix)))
    .sort()
  if (forbidden.length > 0) {
    throw new Error(`Ark runtime contains forbidden package identities: ${forbidden.join(', ')}`)
  }
  const forbiddenEdges = new Set()
  for (const { name, manifest } of records) {
    for (const key of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      const table = manifest[key]
      if (table === undefined || table === null || typeof table !== 'object' || Array.isArray(table)) continue
      for (const dependency of Object.keys(table)) {
        if (policy.exact.includes(dependency) || policy.prefixes.some(prefix => dependency.startsWith(prefix))) {
          forbiddenEdges.add(`${name} -> ${dependency}`)
        }
      }
    }
  }
  if (forbiddenEdges.size > 0) {
    throw new Error(`Ark runtime contains forbidden package manifest edges: ${[...forbiddenEdges].sort().join(', ')}`)
  }
  const { reached, edges } = await reachablePackageGraph(runtimeRoot, rootManifest, records)
  const orphans = records.filter(record => !reached.has(record.packageRoot))
  if (orphans.length > 0) {
    throw new Error(`Ark runtime contains orphan package identities: ${orphans.map(record => (
      `${record.name}@${record.version}:${record.locator}`
    )).sort().join(', ')}`)
  }
  const missing = policy.required.filter(name => !records.some(record => record.name === name && reached.has(record.packageRoot))).sort()
  if (missing.length > 0) {
    throw new Error(`Ark runtime lacks reachable required package identities: ${missing.join(', ')}`)
  }
  const plan = options.plan
  if (plan !== undefined) {
    const expectedWorkspace = new Map(plan.packages.map(entry => [entry.name, entry.version]))
    const unexpectedFirstParty = records.filter(record => (
      record.name.startsWith('@deepseek-ai/') && !expectedWorkspace.has(record.name)
    ))
    if (unexpectedFirstParty.length > 0) {
      throw new Error(`Ark runtime contains plan-external first-party packages: ${unexpectedFirstParty.map(
        record => `${record.name}@${record.version}`,
      ).sort().join(', ')}`)
    }
    for (const [name, version] of expectedWorkspace) {
      const matches = records.filter(record => record.name === name)
      if (matches.length !== 1 || matches[0].version !== version) {
        throw new Error(`Ark runtime workspace identity differs from its plan: ${name}@${version}`)
      }
    }
    for (const asset of plan.requiredFiles) {
      const actual = requiredFiles.find(entry => entry.path === asset.path)
      if (actual?.sha256 !== asset.sha256) {
        throw new Error(`Ark runtime required profile/source asset differs from its plan: ${asset.path}`)
      }
    }
  }
  const nodeExecutable = options.nodeExecutable ?? process.execPath
  const packages = []
  for (const record of records.sort((left, right) => left.locator.localeCompare(right.locator))) {
    const javaScript = await actualJavaScriptEntries(record, nodeExecutable)
    packages.push({
      name: record.name,
      version: record.version,
      locator: record.locator,
      aliases: [...record.aliases].sort(),
      manifestSha256: record.manifestSha256,
      contentSha256: record.contentSha256,
      contentFiles: record.contentFiles,
      contentLinks: record.contentLinks,
      integrity: record.integrity,
      javaScriptEntries: javaScript.entries,
      unresolvedRelativeImports: javaScript.unresolvedRelativeImports,
    })
  }
  const versionsByName = new Map()
  for (const record of packages) {
    const versions = versionsByName.get(record.name) ?? new Set()
    versions.add(record.version)
    versionsByName.set(record.name, versions)
  }
  const allowedMultiVersionPackages = [...versionsByName.entries()]
    .filter(([, versions]) => versions.size > 1)
    .map(([name, versions]) => ({ name, versions: [...versions].sort() }))
    .sort((left, right) => left.name.localeCompare(right.name))
  for (const entry of allowedMultiVersionPackages) {
    if (JSON.stringify(entry.versions) !== JSON.stringify(identityPolicy.allowedMultipleVersions[entry.name])) {
      throw new Error(`Ark runtime contains an undeclared multiversion package: ${entry.name} [${entry.versions.join(', ')}]`)
    }
  }
  const lockfilePath = join(runtimeRoot, 'pnpm-lock.yaml')
  const lockfileSha256 = (await optionalLstat(lockfilePath))?.isFile() === true
    ? await sha256File(lockfilePath)
    : null
  return {
    version: 2,
    target: options.target ?? 'macos-arm64',
    rootPackageJsonSha256: sha256(rootManifestRaw),
    lockfileSha256,
    requiredFiles: requiredFiles.sort((left, right) => left.path.localeCompare(right.path)),
    packageCount: packages.length,
    packages,
    symlinks: discovered.symlinks,
    allowedMultiVersionPackages,
    edges,
  }
}

async function requireHash(path, expected, label) {
  if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/u.test(expected)) {
    throw new Error(`Ark pack receipt lacks ${label} hash`)
  }
  const actual = await sha256File(path)
  if (actual !== expected) throw new Error(`Ark pack receipt ${label} hash mismatch: ${path}`)
}

function capture(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`Ark provenance command failed: ${command} ${args.join(' ')}`)
  }
  return result.stdout
}

async function tarballInventory(path, cwd) {
  const members = capture('tar', ['-tzf', path], cwd).toString('utf8').split('\n')
    .filter(member => member.startsWith('package/') && !member.endsWith('/'))
    .map(member => member.slice('package/'.length))
    .sort()
  const files = []
  for (const member of members) {
    const bytes = capture('tar', ['-xOzf', path, `package/${member}`], cwd)
    files.push({ path: member, sha256: sha256(bytes) })
  }
  return { files, filesSha256: jsonSha256(files) }
}

function expectedInstallCommand(plan, packageManager) {
  return {
    version: 2,
    packageManager,
    target: plan.target,
    cwd: '.',
    lockDerivation: {
      mode: 'root-lock-exact-resolutions',
      rootLockSha256: plan.rootLockSha256,
      externalResolutionCount: plan.externalResolutions.length,
    },
    lockCommand: ['pnpm', 'install', '--lockfile-only', '--offline', '--ignore-scripts'],
    installCommand: ['pnpm', 'install', '--offline', '--frozen-lockfile'],
    network: 'forbidden',
    repeatabilityCheck: ['pnpm', 'install', '--offline', '--frozen-lockfile'],
  }
}

function normalizedLockValue(value) {
  return Array.isArray(value) ? [...value].sort() : value
}

async function verifyPackageIndex(plan, packageIndex, packRoot) {
  if (plan.packlistsComplete !== true) throw new Error('Ark closure plan lacks complete package packlists')
  if (!Array.isArray(packageIndex) || packageIndex.length !== plan.packages.length) {
    throw new Error('Ark package index is not a bijection with its closure plan')
  }
  const planByName = new Map(plan.packages.map(entry => [entry.name, entry]))
  if (planByName.size !== plan.packages.length) throw new Error('Ark closure plan contains duplicate package names')
  const seenNames = new Set()
  const seenTarballs = new Set()
  for (const entry of packageIndex) {
    const planned = planByName.get(entry.name)
    if (planned === undefined || planned.version !== entry.version || seenNames.has(entry.name)) {
      throw new Error(`Ark package index name/version is not bijective: ${String(entry.name)}@${String(entry.version)}`)
    }
    for (const [key, value] of Object.entries(planned)) {
      if (stableJson(entry[key]) !== stableJson(value)) {
        throw new Error(`Ark package index differs from its closure plan: ${entry.name}:${key}`)
      }
    }
    if (typeof entry.tarball !== 'string' || !entry.tarball.startsWith('tarballs/')
      || entry.tarball.includes('..') || seenTarballs.has(entry.tarball)) {
      throw new Error(`Ark package index has an invalid or duplicate TGZ path: ${String(entry.tarball)}`)
    }
    seenNames.add(entry.name)
    seenTarballs.add(entry.tarball)
    const path = resolve(packRoot, entry.tarball)
    if (!path.startsWith(`${packRoot}/`)) throw new Error(`Ark package TGZ escapes its pack root: ${entry.tarball}`)
    await requireHash(path, entry.sha256, `tarball ${entry.name}`)
    const packed = await tarballInventory(path, packRoot)
    if (jsonSha256(packed) !== jsonSha256({ files: entry.packedFiles, filesSha256: entry.packedFilesSha256 })) {
      throw new Error(`Ark package TGZ inventory mismatch: ${entry.name}`)
    }
    const packedManifest = JSON.parse(capture('tar', ['-xOzf', path, 'package/package.json'], packRoot).toString('utf8'))
    if (packedManifest.name !== entry.name || packedManifest.version !== entry.version) {
      throw new Error(`Ark package TGZ identity mismatch: ${entry.name}`)
    }
    // Set equality, not listing order: the plan sorts packlists with
    // localeCompare while the tarball inventory sorts by byte order, so both
    // sides are canonicalized to byte order before comparing.
    const packedPaths = packed.files.map(file => file.path).sort()
    const plannedPaths = planned.packlist.map(file => file.path).sort()
    if (JSON.stringify(packedPaths) !== JSON.stringify(plannedPaths)) {
      throw new Error(`Ark package TGZ packlist differs from current source: ${entry.name}`)
    }
  }
  if (seenNames.size !== planByName.size) throw new Error('Ark package index omits closure-plan packages')
}

function verifyRuntimeLock(plan, packageIndex, runtimeRoot, lockSource) {
  const lock = parseYaml(lockSource)
  const importer = lock?.importers?.['.']
  const packages = lock?.packages
  const snapshots = lock?.snapshots
  if (importer === undefined || packages === null || typeof packages !== 'object' || Array.isArray(packages)) {
    throw new Error('Ark runtime lock lacks its root importer or package resolutions')
  }
  if (snapshots === null || typeof snapshots !== 'object' || Array.isArray(snapshots)) {
    throw new Error('Ark runtime lock lacks exact snapshots')
  }
  // The root workspace and the runtime template resolve the same packages in
  // different peer contexts, so the runtime lock's keys carry different
  // peer-resolution suffixes (possibly nested). Keys normalize to their
  // plain identity; suffix groups are context noise.
  const plainKey = (key) => {
    let current = key
    while (current.endsWith(')')) {
      let depth = 0
      let index = current.length - 1
      for (; index >= 0; index--) {
        if (current[index] === ')') depth += 1
        else if (current[index] === '(') {
          depth -= 1
          if (depth === 0) break
        }
      }
      if (index < 0) break
      current = current.slice(0, index)
    }
    return current
  }
  const runtimeKeyFor = (name, version) => {
    const plain = `${name}@${version}`
    if (packages[plain] !== undefined) return plain
    return Object.keys(packages).find(key => key.startsWith(`${plain}(`)) ?? plain
  }
  const runtimeSnapshotFor = (snapshotKey) => {
    if (snapshots[snapshotKey] !== undefined) return snapshots[snapshotKey]
    const plain = plainKey(snapshotKey)
    const suffixed = Object.keys(snapshots).find(key => key === plain || key.startsWith(`${plain}(`))
    return suffixed === undefined ? undefined : snapshots[suffixed]
  }
  const dependencies = importer.dependencies
  if (dependencies === null || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
    throw new Error('Ark runtime lock lacks root dependencies')
  }
  const indexedNames = new Set(packageIndex.map(entry => entry.name))
  if (JSON.stringify(Object.keys(dependencies).sort()) !== JSON.stringify([...indexedNames].sort())) {
    throw new Error('Ark runtime lock root importer is not a package-index bijection')
  }
  for (const entry of packageIndex) {
    const expected = `file:../${entry.tarball}`
    const locked = dependencies[entry.name]
    if (locked?.specifier !== expected || typeof locked?.version !== 'string'
      || !locked.version.startsWith(expected)) {
      throw new Error(`Ark runtime lock does not resolve ${entry.name} to its indexed TGZ`)
    }
  }
  const indexByName = new Map(packageIndex.map(entry => [entry.name, entry]))
  const sourceImporters = new Map(plan.rootLockGraph.workspaceImporters.map(entry => [entry.name, entry]))
  for (const entry of packageIndex) {
    const locked = dependencies[entry.name]
    const snapshotKey = `${entry.name}@${locked.version}`
    const snapshot = snapshots[snapshotKey]
    if (snapshot === undefined) throw new Error(`Ark runtime lock lacks workspace TGZ snapshot: ${snapshotKey}`)
    const actualEdges = []
    for (const section of ['dependencies', 'optionalDependencies']) {
      for (const [name, reference] of Object.entries(snapshot[section] ?? {})) {
        const workspaceTarget = indexByName.get(name)
        if (workspaceTarget !== undefined) {
          const expected = `file:../${workspaceTarget.tarball}`
          if (typeof reference !== 'string' || !reference.startsWith(expected)) {
            throw new Error(`Ark runtime lock workspace edge does not resolve to its TGZ: ${entry.name} -> ${name}`)
          }
          actualEdges.push({ name, section, kind: 'workspace', version: workspaceTarget.version })
        } else {
          if (typeof reference !== 'string') {
            throw new Error(`Ark runtime lock external edge is malformed: ${entry.name} -> ${name}`)
          }
          const externalSnapshot = Object.keys(snapshots).find(key => (
            key === `${name}@${reference}` || key.startsWith(`${name}@${reference}(`)
          ))
          if (externalSnapshot === undefined) {
            throw new Error(`Ark runtime lock external edge has no exact snapshot: ${entry.name} -> ${name}`)
          }
          // The frozen install prunes optional dependencies whose declared
          // platform does not match macos-arm64 while their snapshot edges
          // stay recorded; mirror that rule here. A platform-mismatched edge
          // outside the optional section still installs and still fails.
          if (section === 'optionalDependencies') {
            const externalPackage = packages[externalSnapshot]
            const declaredOs = externalPackage?.os
            const declaredCpu = externalPackage?.cpu
            const osAllowed = !Array.isArray(declaredOs) || declaredOs.includes('darwin')
            const cpuAllowed = !Array.isArray(declaredCpu) || declaredCpu.includes('arm64')
            if (!osAllowed || !cpuAllowed) continue
          }
          actualEdges.push({ name, section, kind: 'external', snapshotKey: externalSnapshot })
        }
      }
    }
    // Section labels are representation noise across the three sources: the
    // manifest declares peers, the root lock records satisfied workspace
    // peers under dependencies, and the runtime lock files auto-installed
    // peers under optionalDependencies. The invariant is the resolved edge
    // set — name, kind, version, and the plain snapshot key — so both are
    // normalized before comparing; platform-omitted workspace edges stay
    // excluded, and install-pruned optional platform edges are skipped above.
    const stripSection = ({ name, kind, version, snapshotKey }) => (
      version === undefined
        ? { name, kind, snapshotKey: plainKey(snapshotKey) }
        : { name, kind, version }
    )
    const comparableEdges = actualEdges
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(stripSection)
    const expectedEdges = sourceImporters.get(entry.name).edges
      .filter(edge => edge.kind !== 'omitted-platform-workspace')
      .map(edge => edge.kind === 'workspace'
        ? { name: edge.name, section: edge.section, kind: edge.kind, version: edge.version }
        : { name: edge.name, section: edge.section, kind: edge.kind, snapshotKey: edge.snapshotKey })
      .map(stripSection)
      .sort((left, right) => left.name.localeCompare(right.name))
    if (stableJson(comparableEdges) !== stableJson(expectedEdges)) {
      console.error(`EDGE-DIFF ${entry.name}\nACTUAL: ${stableJson(actualEdges)}\nEXPECTED: ${stableJson(expectedEdges)}`)
      throw new Error(`Ark runtime lock workspace snapshot edges differ from root lock: ${entry.name}`)
    }
  }
  const expectedExternal = new Map(plan.externalResolutions.map(entry => [`${entry.name}@${entry.version}`, entry]))
  for (const entry of expectedExternal.values()) {
    const locked = packages[runtimeKeyFor(entry.name, entry.version)]
    if (locked?.resolution?.integrity !== entry.integrity) {
      console.error(`EXTRES-DIFF ${entry.name}@${entry.version} runtimeKey=${runtimeKeyFor(entry.name, entry.version)} locked=${JSON.stringify(locked?.resolution ?? null)} expected=${entry.integrity}`)
      throw new Error(`Ark runtime lock external resolution differs from root lock: ${entry.name}@${entry.version}`)
    }
  }
  const unexpected = []
  for (const [key, value] of Object.entries(packages)) {
    const tarball = value?.resolution?.tarball
    if ((typeof tarball === 'string' && tarball.startsWith('file:')) || key.includes('@file:')) continue
    // Platform-marked optionals stay recorded in the lock while the frozen
    // macos-arm64 install prunes them; they are not runtime content.
    const declaredOs = value?.os
    const declaredCpu = value?.cpu
    const osAllowed = !Array.isArray(declaredOs) || declaredOs.includes('darwin')
    const cpuAllowed = !Array.isArray(declaredCpu) || declaredCpu.includes('arm64')
    if (value?.optional === true || !osAllowed || !cpuAllowed) continue
    if (!expectedExternal.has(plainKey(key))) unexpected.push(key)
  }
  if (unexpected.length > 0) {
    throw new Error(`Ark runtime lock contains plan-external resolutions: ${unexpected.sort().join(', ')}`)
  }
  const expectedSnapshots = new Map(plan.rootLockGraph.externalSnapshots.map(entry => [entry.snapshotKey, entry]))
  for (const expected of expectedSnapshots.values()) {
    const packageMetadata = packages[runtimeKeyFor(expected.name, expected.version)]
    const snapshot = runtimeSnapshotFor(expected.snapshotKey)
    if (packageMetadata === undefined || snapshot === undefined) {
      throw new Error(`Ark runtime lock lacks root-lock-derived snapshot: ${expected.snapshotKey}`)
    }
    // Dependency references embed the resolving context as trailing
    // peer-suffix groups; the two locks resolve the same packages in
    // different contexts, so references normalize to their plain identity
    // before the records compare. Optional peers of the package itself are
    // recorded in the runtime snapshot's optionalDependencies without being
    // installed; both sides drop declared peers for the same reason the
    // traversal skips them.
    const declaredPeers = packageMetadata.peerDependencies ?? {}
    const withoutDeclaredPeers = (record) => Object.fromEntries(
      Object.entries(record ?? {}).filter(([dependency]) => declaredPeers[dependency] === undefined))
    const normalizeReferences = (record) => {
      if (record === undefined || record === null) return record
      return Object.fromEntries(Object.entries(record).map(([dependency, reference]) => (
        [dependency, typeof reference === 'string' ? plainKey(reference) : reference]
      )))
    }
    const actual = {
      snapshotKey: expected.snapshotKey,
      name: expected.name,
      version: expected.version,
      integrity: packageMetadata.resolution?.integrity,
      resolution: normalizedLockValue(packageMetadata.resolution),
      os: normalizedLockValue(packageMetadata.os),
      cpu: normalizedLockValue(packageMetadata.cpu),
      engines: normalizedLockValue(packageMetadata.engines),
      hasBin: packageMetadata.hasBin === true,
      requiresBuild: packageMetadata.requiresBuild === true,
      optional: packageMetadata.optional === true,
      peerDependencies: normalizedLockValue(packageMetadata.peerDependencies),
      peerDependenciesMeta: normalizedLockValue(packageMetadata.peerDependenciesMeta),
      dependencies: normalizeReferences(normalizedLockValue(withoutDeclaredPeers(snapshot.dependencies))),
      optionalDependencies: normalizeReferences(normalizedLockValue(withoutDeclaredPeers(snapshot.optionalDependencies))),
      transitivePeerDependencies: normalizedLockValue(snapshot.transitivePeerDependencies),
    }
    const expectedNormalized = {
      ...expected,
      dependencies: normalizeReferences(normalizedLockValue(expected.dependencies)),
      optionalDependencies: normalizeReferences(normalizedLockValue(expected.optionalDependencies)),
    }
    if (stableJson(actual) !== stableJson(expectedNormalized)) {
      const fields = [...new Set([...Object.keys(actual), ...Object.keys(expected)])]
      const differing = fields
        .filter(field => stableJson(actual[field]) !== stableJson(expected[field]))
        .map(field => `${field}: expected=${stableJson(expected[field])} actual=${stableJson(actual[field])}`)
      console.error(`SNAPDIFF ${expected.snapshotKey}\n  ${differing.join('\n  ')}`)
      throw new Error(`Ark runtime lock snapshot metadata or edges differ from root lock: ${expected.snapshotKey}`)
    }
  }
  const expectedPlainSnapshotKeys = new Set([...expectedSnapshots.keys()].map(plainKey))
  const unexpectedSnapshots = Object.keys(snapshots).filter(key => {
    if (expectedSnapshots.has(key) || expectedPlainSnapshotKeys.has(plainKey(key))) return false
    if (packageIndex.some(entry => key.startsWith(`${entry.name}@file:../${entry.tarball}`))) return false
    // Platform-marked optionals stay recorded while the macos-arm64 install
    // prunes them; their snapshots are lock bookkeeping, not runtime content.
    const metadata = packages[plainKey(key)]
    const declaredOs = metadata?.os
    const declaredCpu = metadata?.cpu
    const osAllowed = !Array.isArray(declaredOs) || declaredOs.includes('darwin')
    const cpuAllowed = !Array.isArray(declaredCpu) || declaredCpu.includes('arm64')
    if (metadata?.optional === true || !osAllowed || !cpuAllowed) return false
    return true
  })
  if (unexpectedSnapshots.length > 0) {
    throw new Error(`Ark runtime lock contains plan-external snapshots: ${unexpectedSnapshots.sort().join(', ')}`)
  }
}

function verifyRuntimeWorkspace(plan, packageIndex, workspaceSource) {
  const workspace = parseYaml(workspaceSource)
  if (workspace?.nodeLinker !== 'hoisted' || workspace?.packageImportMethod !== 'copy'
    || workspace?.autoInstallPeers !== false) {
    throw new Error('Ark runtime workspace lacks deterministic copy/hoisted/no-auto-peer policy')
  }
  const expected = new Map(packageIndex.map(entry => [entry.name, `file:../${entry.tarball}`]))
  for (const edge of plan.externalResolutionEdges) {
    const selector = `${edge.from}>${edge.name}`
    const previous = expected.get(selector)
    if (previous !== undefined && previous !== edge.version) {
      throw new Error(`Ark root lock requires conflicting exact runtime overrides: ${selector}`)
    }
    expected.set(selector, edge.version)
  }
  const actual = new Map(Object.entries(workspace.overrides ?? {}))
  if (stableJson([...actual].sort()) !== stableJson([...expected].sort())) {
    throw new Error('Ark runtime workspace overrides are not the exact root-lock/TGZ derivation')
  }
}

/** Policy-approved lifecycle-build package names from a workspace policy document. */
function builtPackageNames(workspacePolicy) {
  return new Set(Object.entries(workspacePolicy?.allowBuilds ?? {})
    .filter(([, allowed]) => allowed === true)
    .map(([key]) => (key.startsWith('@') ? `@${key.split('@')[1]}` : key.split('@')[0])))
}

function verifyInstalledContentRoots(plan, packageIndex, manifest, builtPackages) {
  const installedByIdentity = new Map(manifest.packages.map(entry => [`${entry.name}@${entry.version}`, entry]))
  for (const entry of packageIndex) {
    const installed = installedByIdentity.get(`${entry.name}@${entry.version}`)
    if (installed === undefined || installed.contentLinks.length !== 0) {
      throw new Error(`Ark installed workspace bytes do not derive from indexed TGZ: ${entry.name}`)
    }
    // Set equality with canonical byte ordering: the installed content
    // manifest sorts with localeCompare while the TGZ inventory sorts by
    // byte order, so both sides are canonicalized before comparing.
    const byPath = (left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
    const canonicalContent = [...installed.contentFiles].sort(byPath)
    const canonicalPacked = [...entry.packedFiles].sort(byPath)
    if (stableJson(canonicalContent) !== stableJson(canonicalPacked)) {
      for (const [index, rec] of canonicalPacked.entries()) {
        if (JSON.stringify(rec) !== JSON.stringify(canonicalContent[index])) {
          console.error(`CONTENT-RECORD-DIFF ${entry.name}[${index}] packed=${JSON.stringify(rec)} content=${JSON.stringify(canonicalContent[index])}`)
        }
      }
      throw new Error(`Ark installed workspace bytes do not derive from indexed TGZ: ${entry.name}`)
    }
  }
  for (const entry of plan.externalResolutions) {
    // A null manifest marks a resolution the root install pruned; the
    // tarball integrity loop already binds its bytes, so only the content
    // checks are skipped.
    if (entry.contentManifestSha256 === null) continue
    const installed = installedByIdentity.get(`${entry.name}@${entry.version}`)
    if (installed === undefined) continue
    // A policy-approved lifecycle build (node-pty, koffi) compiles in its own
    // install root, so its build outputs are not byte-reproducible across the
    // root tree and the template. The source is pinned by the tarball
    // integrity loop and the build is approved by the workspace policy; the
    // content-equality check applies to pristine packages only.
    if (builtPackages.has(entry.name)) continue
    if (typeof entry.contentManifestSha256 !== 'string'
      || installed.contentSha256 !== entry.contentManifestSha256
      || stableJson(installed.contentFiles) !== stableJson(entry.contentFiles)
      || stableJson(installed.contentLinks) !== stableJson(entry.contentLinks)) {
      if (entry.name === '@anthropic-ai/sdk') {
        const packed = new Map((entry.contentFiles ?? []).map(f => [f.path, f.sha256]))
        const content = new Map((installed.contentFiles ?? []).map(f => [f.path, f.sha256]))
        console.error(`EXTCONTENT-DIFF ${entry.name} rootSha=${entry.contentManifestSha256} installedSha=${installed.contentSha256} rootCount=${packed.size} installedCount=${content.size}`)
        for (const [p, s] of packed) if (content.get(p) !== s) console.error(`  root-only-or-diff ${p} ${s?.slice(0, 12)} vs ${content.get(p)?.slice(0, 12)}`)
        for (const [p, s] of content) if (!packed.has(p)) console.error(`  installed-only ${p} ${s?.slice(0, 12)}`)
      }
      throw new Error(`Ark installed external bytes do not derive from root-lock content: ${entry.name}@${entry.version}`)
    }
  }
}

export async function createArkPackReceipt({
  plan,
  packageIndex,
  installCommand,
  installedManifest,
  runtimeRoot,
  packRoot,
}) {
  const packageManager = JSON.parse(await readFile(join(runtimeRoot, 'package.json'), 'utf8')).packageManager
  const expectedCommand = expectedInstallCommand(plan, packageManager)
  if (stableJson(installCommand) !== stableJson(expectedCommand)) {
    throw new Error('Ark install command semantics differ from the frozen offline owner')
  }
  const lockSource = await readFile(join(runtimeRoot, 'pnpm-lock.yaml'), 'utf8')
  const workspaceSource = await readFile(join(runtimeRoot, 'pnpm-workspace.yaml'), 'utf8')
  verifyRuntimeWorkspace(plan, packageIndex, workspaceSource)
  verifyRuntimeLock(plan, packageIndex, runtimeRoot, lockSource)
  const workspacePolicy = parseYaml(workspaceSource)
  const builtPackages = builtPackageNames(workspacePolicy)
  return {
    version: 3,
    sourceDigest: plan.sourceDigest,
    sourceIdentity: plan.sourceIdentity,
    target: plan.target,
    deferredPlatforms: plan.deferredPlatforms,
    runtimeRelativePath: normalizedRelative(packRoot, runtimeRoot),
    workspacePackageCount: plan.workspacePackageCount,
    packedPackageCount: packageIndex.length,
    closurePlanSha256: await sha256File(join(packRoot, 'closure-plan.json')),
    packageIndexSha256: await sha256File(join(packRoot, 'package-index.json')),
    installCommandSha256: await sha256File(join(packRoot, 'install-command.json')),
    runtimePackageJsonSha256: await sha256File(join(runtimeRoot, 'package.json')),
    runtimeWorkspaceSha256: await sha256File(join(runtimeRoot, 'pnpm-workspace.yaml')),
    lockfileSha256: sha256(lockSource),
    identityPolicySha256: await sha256File(join(runtimeRoot, 'jiuzhang/profile/runtime-identity-policy.json')),
    installedRuntimeManifestSha256: await sha256File(join(packRoot, 'installed-runtime-manifest.json')),
    installedRuntimeIdentitySha256: jsonSha256(installedManifest),
    install: {
      offline: true,
      frozenLockfile: true,
      packageManager,
      lockDerivation: 'root-lock-exact-resolutions',
    },
  }
}

/** Verify the pack receipt and recompute the exact installed-runtime manifest. */
export async function verifyArkPackReceipt(runtimePath, policyPath, receiptPath, options = {}) {
  const runtimeRoot = await ordinaryRoot(resolve(runtimePath), 'Ark runtime root')
  const physicalReceipt = await realpath(receiptPath)
  const packRoot = dirname(physicalReceipt)
  if (physicalReceipt !== join(packRoot, 'pack-receipt.json')) {
    throw new Error(`Ark pack receipt must use its canonical pack path: ${join(packRoot, 'pack-receipt.json')}`)
  }
  const receipt = JSON.parse(await readFile(physicalReceipt, 'utf8'))
  if (typeof receipt.runtimeRelativePath !== 'string') {
    throw new Error('Ark pack receipt lacks its bound runtime path')
  }
  const boundRuntime = await realpath(resolve(packRoot, receipt.runtimeRelativePath))
  if (boundRuntime !== runtimeRoot || !boundRuntime.startsWith(`${packRoot}/`)) {
    throw new Error(`Ark pack receipt is not bound to this runtime: ${runtimeRoot}`)
  }
  const provenanceRoot = join(runtimeRoot, PROVENANCE_DIRECTORY)
  if (receipt.version !== 3 || receipt.target !== 'macos-arm64' || receipt.install?.offline !== true
    || receipt.install?.frozenLockfile !== true) {
    throw new Error('Ark pack receipt is not a v3 frozen offline macos-arm64 receipt')
  }
  const planPath = join(packRoot, 'closure-plan.json')
  const indexPath = join(packRoot, 'package-index.json')
  const commandPath = join(packRoot, 'install-command.json')
  const manifestPath = join(packRoot, 'installed-runtime-manifest.json')
  await requireHash(planPath, receipt.closurePlanSha256, 'closure plan')
  await requireHash(indexPath, receipt.packageIndexSha256, 'package index')
  await requireHash(commandPath, receipt.installCommandSha256, 'install command')
  await requireHash(manifestPath, receipt.installedRuntimeManifestSha256, 'installed runtime manifest')
  await requireHash(join(runtimeRoot, 'package.json'), receipt.runtimePackageJsonSha256, 'runtime package.json')
  await requireHash(join(runtimeRoot, 'pnpm-workspace.yaml'), receipt.runtimeWorkspaceSha256, 'runtime workspace')
  await requireHash(join(runtimeRoot, 'pnpm-lock.yaml'), receipt.lockfileSha256, 'frozen lockfile')
  await requireHash(join(provenanceRoot, 'closure-plan.json'), receipt.closurePlanSha256, 'embedded closure plan')
  await requireHash(join(provenanceRoot, 'package-index.json'), receipt.packageIndexSha256, 'embedded package index')
  await requireHash(join(provenanceRoot, 'install-command.json'), receipt.installCommandSha256, 'embedded install command')
  await requireHash(
    join(provenanceRoot, 'installed-runtime-manifest.json'),
    receipt.installedRuntimeManifestSha256,
    'embedded installed runtime manifest',
  )
  await requireHash(join(provenanceRoot, 'pack-receipt.json'), await sha256File(physicalReceipt), 'embedded pack receipt')
  const plan = JSON.parse(await readFile(planPath, 'utf8'))
  const packageIndex = JSON.parse(await readFile(indexPath, 'utf8'))
  let currentPlan = options.currentPlan
  if (currentPlan === undefined && options.sourcePlanPath !== undefined && options.repositoryRoot !== undefined) {
    const sourcePlan = await import(pathToFileURL(options.sourcePlanPath).href)
    currentPlan = await sourcePlan.createArkRuntimePlan(options.repositoryRoot, {
      requireBuilt: true,
      verifyPacklists: true,
    })
  }
  if (currentPlan === undefined) {
    throw new Error('Ark pack receipt verification requires a regenerated current closure plan')
  }
  if ((await readFile(planPath, 'utf8')) !== stableJson(currentPlan)) {
    throw new Error('Ark closure plan bytes differ from the regenerated current source plan')
  }
  await verifyPackageIndex(plan, packageIndex, packRoot)
  const installCommand = JSON.parse(await readFile(commandPath, 'utf8'))
  const recorded = JSON.parse(await readFile(manifestPath, 'utf8'))
  const actual = await createArkRuntimeManifest(runtimeRoot, policyPath, {
    plan,
    nodeExecutable: options.nodeExecutable,
    target: receipt.target,
  })
  if (jsonSha256(actual) !== jsonSha256(recorded)) {
    throw new Error('Ark installed runtime differs from its bound recursive manifest')
  }
  const verifierBuiltPackages = builtPackageNames(parseYaml(await readFile(join(runtimeRoot, 'pnpm-workspace.yaml'), 'utf8')))
  verifyInstalledContentRoots(plan, packageIndex, actual, verifierBuiltPackages)
  const expectedReceipt = await createArkPackReceipt({
    plan,
    packageIndex,
    installCommand,
    installedManifest: actual,
    runtimeRoot,
    packRoot,
  })
  if ((await readFile(physicalReceipt, 'utf8')) !== stableJson(expectedReceipt)) {
    throw new Error('Ark pack receipt bytes differ from the fully regenerated receipt')
  }
  return { receipt, plan, packageIndex, manifest: actual }
}

/**
 * Assert that a standalone Ark runtime contains its dedicated entry and no
 * forbidden package. Passing a receipt is required by production packaging;
 * policy-only mode remains available for isolated fixture tests.
 */
export async function assertArkRuntimeClosure(runtimePath, policyPath, options = {}) {
  const result = options.receiptPath === undefined
    ? { manifest: await createArkRuntimeManifest(runtimePath, policyPath, options) }
    : await verifyArkPackReceipt(runtimePath, policyPath, options.receiptPath, options)
  return options.details === true ? result : { packageCount: result.manifest.packageCount }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const positional = []
  const options = {}
  for (let index = 2; index < process.argv.length; index++) {
    const value = process.argv[index]
    if (value === '--receipt') options.receiptPath = process.argv[++index]
    else if (value === '--node') options.nodeExecutable = process.argv[++index]
    else if (value === '--source-plan') options.sourcePlanPath = process.argv[++index]
    else if (value === '--repository-root') options.repositoryRoot = process.argv[++index]
    else if (value === '--json') options.details = true
    else positional.push(value)
  }
  try {
    const result = await assertArkRuntimeClosure(positional[0] ?? '', positional[1] ?? '', options)
    if (options.details === true) process.stdout.write(stableJson(result))
    else console.log(`Ark runtime closure verified: ${String(result.packageCount)} physical package identities`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 2
  }
}
