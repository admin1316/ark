import { createHash, randomBytes } from 'node:crypto'
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { createArkRuntimePlan, runtimeAssetSource } from './runtime-plan.mjs'
import {
  assertJavaScriptModuleSyntax,
  createArkPackReceipt,
  createArkRuntimeManifest,
  packageJavaScriptEntries,
  stableJson,
  verifyArkPackReceipt,
} from './runtime-closure.mjs'

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    throw new Error(`${command} ${args.join(' ')} failed with ${String(result.status)}${detail === '' ? '' : `\n${detail}`}`)
  }
}

function capture(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with ${String(result.status)}\n${result.stderr.trim()}`)
  }
  return result.stdout
}

async function writeJson(path, value, options = {}) {
  await writeFile(path, stableJson(value), options)
}

function packedMember(tarball, member, repositoryRoot) {
  return capture('tar', ['-xOzf', tarball, member], repositoryRoot)
}

function captureBuffer(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: null, stdio: ['ignore', 'pipe', 'pipe'] })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with ${String(result.status)}`)
  }
  return result.stdout
}

function tarballInventory(tarball, repositoryRoot) {
  const members = capture('tar', ['-tzf', tarball], repositoryRoot).split('\n')
    .filter(member => member.startsWith('package/') && !member.endsWith('/'))
    .map(member => member.slice('package/'.length))
    .sort()
  const files = members.map(path => ({
    path,
    sha256: createHash('sha256').update(
      captureBuffer('tar', ['-xOzf', tarball, `package/${path}`], repositoryRoot),
    ).digest('hex'),
  }))
  return {
    files,
    filesSha256: createHash('sha256').update(stableJson(files)).digest('hex'),
  }
}

function exactExternalOverrides(plan) {
  const overrides = new Map()
  for (const edge of plan.externalResolutionEdges) {
    const selector = `${edge.from}>${edge.name}`
    const previous = overrides.get(selector)
    if (previous !== undefined && previous !== edge.version) {
      throw new Error(`root lock requires conflicting exact runtime overrides: ${selector}`)
    }
    overrides.set(selector, edge.version)
  }
  return overrides
}

function tarballName(entry) {
  const unscoped = entry.name.startsWith('@') ? entry.name.slice(1).replace('/', '-') : entry.name
  return `${unscoped}-${entry.version}.tgz`
}

function tarballGroup(directory) {
  if (directory.startsWith('vendor/')) return 'vendor'
  if (directory.startsWith('native/')) return 'native'
  return 'dsh'
}

function assertSafeOutput(repositoryRoot, output) {
  if (!isAbsolute(output)) throw new Error('Ark runtime pack output must be absolute')
  const destination = resolve(output)
  if (destination === '/' || destination === repositoryRoot || destination.startsWith(`${repositoryRoot}/`)
    || destination === '/Applications' || destination.startsWith('/Applications/')) {
    throw new Error(`refusing unsafe Ark runtime pack output: ${destination}`)
  }
  const temporaryRoots = ['/private/tmp', resolve(tmpdir())]
  if (!temporaryRoots.some(root => destination.startsWith(`${root}/`))) {
    throw new Error(`Ark runtime pack output must stay under a temporary root: ${destination}`)
  }
  return destination
}

async function writePlanOnly(repositoryRoot, output) {
  const destination = assertSafeOutput(repositoryRoot, output)
  const plan = await createArkRuntimePlan(repositoryRoot, { verifyPacklists: true })
  await mkdir(destination, { recursive: false })
  await writeJson(join(destination, 'closure-plan.json'), plan, { flag: 'wx' })
  return plan
}

async function pack(repositoryRoot, output) {
  const destination = assertSafeOutput(repositoryRoot, output)
  const staging = `${destination}.staging-${process.pid}-${randomBytes(6).toString('hex')}`
  await mkdir(staging, { recursive: false })
  try {
    run(process.execPath, ['integrations/jiuzhang/src/build-native.mjs'], repositoryRoot)
    const repositoryManifest = JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8'))
    if (typeof repositoryManifest.packageManager !== 'string'
      || !repositoryManifest.packageManager.startsWith('pnpm@')) {
      throw new Error('Ark runtime pack requires the repository pnpm packageManager pin')
    }
    const plan = await createArkRuntimePlan(repositoryRoot, { requireBuilt: true, verifyPacklists: true })
    const runtimeTemplate = join(staging, 'runtime-template')
    await mkdir(runtimeTemplate, { recursive: true })
    const dependencies = {}
    const packed = []
    for (const entry of plan.packages) {
      const group = tarballGroup(entry.directory)
      const tarballDirectory = join(staging, 'tarballs', group)
      await mkdir(tarballDirectory, { recursive: true })
      run('pnpm', ['--dir', entry.directory, 'pack', '--pack-destination', tarballDirectory], repositoryRoot)
      const filename = tarballName(entry)
      const path = join(tarballDirectory, filename)
      const packedManifest = JSON.parse(packedMember(path, 'package/package.json', repositoryRoot))
      if (packedManifest.name !== entry.name || packedManifest.version !== entry.version) {
        throw new Error(
          `packed workspace identity drifted: expected ${entry.name}@${entry.version}, found ${String(packedManifest.name)}@${String(packedManifest.version)}`,
        )
      }
      for (const moduleEntry of packageJavaScriptEntries(packedManifest)) {
        if (moduleEntry.includes('*')) continue
        assertJavaScriptModuleSyntax(
          packedMember(path, `package/${moduleEntry}`, repositoryRoot),
          `${entry.name}:${moduleEntry}`,
          process.execPath,
          packedManifest.type,
        )
      }
      const bytes = await readFile(path)
      const packedInventory = tarballInventory(path, repositoryRoot)
      // The contract is set equality, not listing order: the plan sorts with
      // localeCompare while the tarball inventory sorts by byte order, so both
      // sides are canonicalized to byte order before comparing.
      const plannedPaths = entry.packlist.map(file => file.path).sort()
      const packedPaths = packedInventory.files.map(file => file.path).sort()
      if (JSON.stringify(packedPaths) !== JSON.stringify(plannedPaths)) {
        throw new Error(`packed workspace packlist drifted after planning: ${entry.name}`)
      }
      const tarball = relative(staging, path).replaceAll('\\', '/')
      const runtimeSpecifier = relative(runtimeTemplate, path).replaceAll('\\', '/')
      dependencies[entry.name] = `file:${runtimeSpecifier}`
      packed.push({
        ...entry,
        tarball,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        packedFiles: packedInventory.files,
        packedFilesSha256: packedInventory.filesSha256,
      })
    }
    const packedByName = new Map(packed.map(entry => [entry.name, entry]))
    const requiredTarball = (name) => {
      const entry = packedByName.get(name)
      if (entry === undefined) throw new Error(`Ark runtime pack lacks required tarball: ${name}`)
      return resolve(staging, entry.tarball)
    }
    const pluginInventoryDescriptor = packedMember(
      requiredTarball('@deepseek-ai/dsh-host-plugin-inventory'),
      'package/lib/typert.host.js',
      repositoryRoot,
    )
    if (!pluginInventoryDescriptor.includes('pluginInventory/list')) {
      throw new Error('packed Host plugin inventory lacks pluginInventory/list')
    }
    const webFetchEntry = packedMember(
      requiredTarball('@deepseek-ai/dsh-web-fetch-http'),
      'package/lib/index.js',
      repositoryRoot,
    )
    if (!webFetchEntry.includes('resolvePublicAddresses')
      || !webFetchEntry.includes('createPinnedLookup')
      || !webFetchEntry.includes('WEB_BLOCKED_URL')) {
      throw new Error('packed WebFetch lacks public-address validation and pinned transport')
    }
    const nativeRunnerEntry = packedMember(
      requiredTarball('@deepseek-ai/dsh-native-api-runner'),
      'package/lib/bin.js',
      repositoryRoot,
    )
    if (!nativeRunnerEntry.includes('runNativeApi')) {
      throw new Error('packed dedicated Native runner lacks runNativeApi')
    }
    const nativeRunnerImports = [...nativeRunnerEntry.matchAll(/from\s+["']\.\/([^"']+\.js)["']/gu)]
      .map(match => match[1])
    // Both a bundled executable and a thin executable importing its sibling are valid.
    // The published library entry and every retained relative import must exist in the same tarball.
    packedMember(requiredTarball('@deepseek-ai/dsh-native-api-runner'), 'package/lib/index.js', repositoryRoot)
    for (const imported of nativeRunnerImports) {
      packedMember(
        requiredTarball('@deepseek-ai/dsh-native-api-runner'),
        `package/lib/${imported}`,
        repositoryRoot,
      )
    }
    const runtimeManifest = {
      name: 'ark-native-runtime-current',
      version: '0.0.0',
      private: true,
      type: 'module',
      packageManager: repositoryManifest.packageManager,
      dependencies,
    }
    await writeJson(join(runtimeTemplate, 'package.json'), runtimeManifest)
    // Packed workspace manifests carry released semver ranges. pnpm v11 owns
    // overrides in pnpm-workspace.yaml, so force every workspace edge back to
    // the exact hashed tarball selected above instead of allowing an
    // unpublished current package to fall through to the registry.
    const workspaceTemplateSource = await readFile(
      join(repositoryRoot, 'integrations/jiuzhang/profile/pnpm-workspace.yaml'),
      'utf8',
    )
    const subprocessLocalSpecifier = dependencies['@deepseek-ai/dsh-subprocess-local']
    if (typeof subprocessLocalSpecifier !== 'string') {
      throw new Error('Ark runtime pack lacks the subprocess-local tarball build policy input')
    }
    const buildPolicyPlaceholder = '__ARK_SUBPROCESS_LOCAL_SPEC__'
    if (!workspaceTemplateSource.includes(buildPolicyPlaceholder)) {
      throw new Error('Ark runtime workspace template lacks its subprocess-local build policy placeholder')
    }
    const workspaceTemplate = workspaceTemplateSource.replaceAll(
      buildPolicyPlaceholder,
      subprocessLocalSpecifier,
    )
    const overrideMap = new Map(Object.entries(dependencies))
    for (const [selector, version] of exactExternalOverrides(plan)) overrideMap.set(selector, version)
    const overrides = [...overrideMap]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, specifier]) => `  ${JSON.stringify(name)}: ${JSON.stringify(specifier)}`)
      .join('\n')
    await writeFile(
      join(runtimeTemplate, 'pnpm-workspace.yaml'),
      `${workspaceTemplate.trimEnd()}\n\noverrides:\n${overrides}\n`,
    )
    for (const asset of plan.requiredFiles) {
      const destinationPath = join(runtimeTemplate, asset.path)
      await mkdir(resolve(destinationPath, '..'), { recursive: true })
      await copyFile(runtimeAssetSource(repositoryRoot, asset.path), destinationPath)
    }
    const packageManagerVersion = repositoryManifest.packageManager.slice('pnpm@'.length)
    const actualPackageManagerVersion = capture('pnpm', ['--version'], repositoryRoot).trim()
    if (actualPackageManagerVersion !== packageManagerVersion) {
      throw new Error(
        `Ark runtime pack requires ${repositoryManifest.packageManager}, found pnpm@${actualPackageManagerVersion}`,
      )
    }
    const lockCommand = ['pnpm', 'install', '--lockfile-only', '--offline', '--ignore-scripts']
    const installCommand = ['pnpm', 'install', '--offline', '--frozen-lockfile']
    const installOwner = {
      version: 2,
      packageManager: repositoryManifest.packageManager,
      target: plan.target,
      cwd: '.',
      lockDerivation: {
        mode: 'root-lock-exact-resolutions',
        rootLockSha256: plan.rootLockSha256,
        externalResolutionCount: plan.externalResolutions.length,
      },
      lockCommand,
      installCommand,
      network: 'forbidden',
      repeatabilityCheck: installCommand,
    }
    const planPath = join(staging, 'closure-plan.json')
    const indexPath = join(staging, 'package-index.json')
    const commandPath = join(staging, 'install-command.json')
    await writeJson(planPath, plan)
    await writeJson(indexPath, packed)
    await writeJson(commandPath, installOwner)
    run(lockCommand[0], lockCommand.slice(1), runtimeTemplate)
    const lockfilePath = join(runtimeTemplate, 'pnpm-lock.yaml')
    const lockfileBeforeInstall = createHash('sha256').update(await readFile(lockfilePath)).digest('hex')
    run(installCommand[0], installCommand.slice(1), runtimeTemplate)
    const lockfileAfterInstall = createHash('sha256').update(await readFile(lockfilePath)).digest('hex')
    if (lockfileAfterInstall !== lockfileBeforeInstall) {
      throw new Error('Ark frozen offline install changed its generated lockfile')
    }
    const installedManifest = await createArkRuntimeManifest(runtimeTemplate, join(
      runtimeTemplate,
      'jiuzhang/profile/forbidden-runtime-packages.json',
    ), {
      plan,
      nodeExecutable: process.execPath,
      target: plan.target,
    })
    const installedManifestPath = join(staging, 'installed-runtime-manifest.json')
    await writeJson(installedManifestPath, installedManifest)
    const provenanceRoot = join(runtimeTemplate, '.ark-provenance')
    await mkdir(provenanceRoot)
    for (const name of [
      'closure-plan.json',
      'package-index.json',
      'install-command.json',
      'installed-runtime-manifest.json',
    ]) await copyFile(join(staging, name), join(provenanceRoot, name))
    const finalPlan = await createArkRuntimePlan(repositoryRoot, { requireBuilt: true, verifyPacklists: true })
    if (stableJson(finalPlan) !== stableJson(plan)) {
      throw new Error('Ark runtime source inputs changed while the pack was being assembled')
    }
    const receipt = await createArkPackReceipt({
      plan,
      packageIndex: packed,
      installCommand: installOwner,
      installedManifest,
      runtimeRoot: runtimeTemplate,
      packRoot: staging,
    })
    const receiptPath = join(staging, 'pack-receipt.json')
    await writeJson(receiptPath, receipt)
    await copyFile(receiptPath, join(provenanceRoot, 'pack-receipt.json'))
    await verifyArkPackReceipt(runtimeTemplate, join(
      runtimeTemplate,
      'jiuzhang/profile/forbidden-runtime-packages.json',
    ), receiptPath, { currentPlan: finalPlan, nodeExecutable: process.execPath })
    await rename(staging, destination)
    return plan
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
  }
}

const repositoryRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    out: { type: 'string' },
    'plan-only': { type: 'boolean', default: false },
  },
})
if (values.out === undefined) throw new Error('usage: pack-runtime.mjs --out /absolute/output [--plan-only]')
const plan = values['plan-only']
  ? await writePlanOnly(repositoryRoot, values.out)
  : await pack(repositoryRoot, values.out)
console.log(
  `Ark current runtime ${values['plan-only'] ? 'plan' : 'pack'}: ${String(plan.workspacePackageCount)} workspace packages, source ${plan.sourceDigest}`,
)
