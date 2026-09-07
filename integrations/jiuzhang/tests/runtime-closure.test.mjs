import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, cp, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import {
  assertArkRuntimeClosure,
  createArkRuntimeManifest,
  packageJavaScriptEntries,
} from '../src/runtime-closure.mjs'

const execFileAsync = promisify(execFile)

const integrationRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const policy = join(integrationRoot, 'profile/forbidden-runtime-packages.json')
const policyDocument = JSON.parse(await readFile(policy, 'utf8'))

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableValue(child)]))
  }
  return value
}

function independentStableJson(value) {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`
}

function independentJsonSha256(value) {
  return createHash('sha256').update(independentStableJson(value)).digest('hex')
}

async function stageRuntime() {
  const root = await mkdtemp(join(tmpdir(), 'ark-runtime-closure-'))
  for (const relative of policyDocument.requiredFiles) {
    const source = relative.startsWith('jiuzhang/profile/')
      ? join(integrationRoot, 'profile', relative.slice('jiuzhang/profile/'.length))
      : join(integrationRoot, 'src', relative)
    const destination = join(root, relative)
    await mkdir(dirname(destination), { recursive: true })
    await copyFile(source, destination)
  }
  const dependencies = {}
  for (const name of policyDocument.required) {
    const packageRoot = join(root, 'node_modules', ...name.split('/'))
    await mkdir(packageRoot, { recursive: true })
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name, version: '1.0.0' }))
    dependencies[name] = '1.0.0'
  }
  const entry = join(root, 'node_modules/@deepseek-ai/dsh-native-api-runner/lib/bin.js')
  await mkdir(dirname(entry), { recursive: true })
  await writeFile(entry, '#!/usr/bin/env node\n')
  await writeFile(join(root, 'package.json'), JSON.stringify({
    name: 'ark-runtime-fixture',
    version: '0.0.0',
    dependencies,
  }))
  return root
}

async function addRootDependency(root, name, version) {
  const path = join(root, 'package.json')
  const manifest = JSON.parse(await readFile(path, 'utf8'))
  manifest.dependencies[name] = version
  await writeFile(path, JSON.stringify(manifest))
}

async function fileSha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

async function stageBoundRuntime() {
  const packRoot = await mkdtemp(join(tmpdir(), 'ark-bound-runtime-'))
  const temporary = await stageRuntime()
  const runtime = join(packRoot, 'runtime-template')
  await cp(temporary, runtime, { recursive: true })
  await rm(temporary, { recursive: true, force: true })
  const rootManifestPath = join(runtime, 'package.json')
  const rootManifest = JSON.parse(await readFile(rootManifestPath, 'utf8'))
  rootManifest.packageManager = 'pnpm@11.7.0'
  await writeFile(rootManifestPath, JSON.stringify(rootManifest))
  const workspaceSource = 'packages:\n  - .\nnodeLinker: hoisted\npackageImportMethod: copy\nautoInstallPeers: false\n'
  await writeFile(join(runtime, 'pnpm-workspace.yaml'), workspaceSource)
  const requiredFiles = []
  for (const path of policyDocument.requiredFiles) {
    requiredFiles.push({ path, sha256: await fileSha256(join(runtime, path)) })
  }
  const packagePlans = []
  const packageIndex = []
  const lockDependencies = []
  const lockPackages = []
  const lockSnapshots = []
  const tarStage = join(packRoot, '.tar-stage')
  await mkdir(tarStage)
  for (const name of policyDocument.required) {
    const sourceRoot = join(runtime, 'node_modules', ...name.split('/'))
    const sourceFiles = name === '@deepseek-ai/dsh-native-api-runner'
      ? ['lib/bin.js', 'package.json']
      : ['package.json']
    const packlist = []
    const packedFiles = []
    const packageStage = join(tarStage, name.replaceAll('/', '-'), 'package')
    for (const path of sourceFiles) {
      const source = join(sourceRoot, path)
      const fileHash = await fileSha256(source)
      packlist.push({ path, sha256: fileHash })
      packedFiles.push({ path, sha256: fileHash })
      await mkdir(dirname(join(packageStage, path)), { recursive: true })
      await copyFile(source, join(packageStage, path))
    }
    const tarball = `tarballs/${name.replaceAll('/', '-')}-1.0.0.tgz`
    const tarballPath = join(packRoot, tarball)
    await mkdir(dirname(tarballPath), { recursive: true })
    await execFileAsync('tar', ['-czf', tarballPath, '-C', dirname(packageStage), 'package'])
    const packagePlan = {
      name,
      version: '1.0.0',
      packlist,
      packlistSha256: createHash('sha256').update(JSON.stringify(packlist)).digest('hex'),
    }
    packagePlans.push(packagePlan)
    packageIndex.push({
      ...packagePlan,
      tarball,
      sha256: await fileSha256(tarballPath),
      packedFiles,
      packedFilesSha256: independentJsonSha256(packedFiles),
    })
    const specifier = `file:../${tarball}`
    lockDependencies.push(`      ${JSON.stringify(name)}:\n        specifier: ${specifier}\n        version: ${specifier}`)
    lockPackages.push(`  ${JSON.stringify(`${name}@${specifier}`)}:\n    resolution:\n      tarball: ${specifier}`)
    lockSnapshots.push(`  ${JSON.stringify(`${name}@${specifier}`)}: {}`)
  }
  await rm(tarStage, { recursive: true, force: true })
  packagePlans.sort((left, right) => left.name.localeCompare(right.name))
  packageIndex.sort((left, right) => left.name.localeCompare(right.name))
  await writeFile(join(runtime, 'pnpm-workspace.yaml'), `${workspaceSource}overrides:\n${packageIndex.map(
    entry => `  ${JSON.stringify(entry.name)}: ${JSON.stringify(`file:../${entry.tarball}`)}`,
  ).join('\n')}\n`)
  const lockSource = [
    "lockfileVersion: '9.0'",
    'settings:',
    '  autoInstallPeers: false',
    '  excludeLinksFromLockfile: false',
    'importers:',
    '  .:',
    '    dependencies:',
    ...lockDependencies.sort(),
    'packages:',
    ...lockPackages.sort(),
    'snapshots:',
    ...lockSnapshots.sort(),
    '',
  ].join('\n')
  await writeFile(join(runtime, 'pnpm-lock.yaml'), lockSource)
  const sourceIdentity = {
    commit: 'a'.repeat(40),
    dirty: true,
    dirtyDiffSha256: 'b'.repeat(64),
    dirtyStatusSha256: 'c'.repeat(64),
    sourceSnapshotSha256: 'd'.repeat(64),
  }
  const plan = {
    version: 3,
    target: 'macos-arm64',
    deferredPlatforms: [],
    sourceDigest: '1'.repeat(64),
    sourceIdentity,
    workspacePackageCount: packagePlans.length,
    packages: packagePlans,
    packlistsComplete: true,
    requiredFiles,
    rootLockSha256: '2'.repeat(64),
    externalResolutions: [],
    externalResolutionEdges: [],
    rootLockGraph: {
      workspaceImporters: packagePlans.map(entry => ({
        name: entry.name,
        version: entry.version,
        directory: `fixture/${entry.name}`,
        edges: [],
      })),
      externalSnapshots: [],
    },
    identityPolicySha256: await fileSha256(join(runtime, 'jiuzhang/profile/runtime-identity-policy.json')),
  }
  const installCommand = {
    version: 2,
    packageManager: 'pnpm@11.7.0',
    target: 'macos-arm64',
    cwd: '.',
    lockDerivation: {
      mode: 'root-lock-exact-resolutions',
      rootLockSha256: plan.rootLockSha256,
      externalResolutionCount: 0,
    },
    lockCommand: ['pnpm', 'install', '--lockfile-only', '--offline', '--ignore-scripts'],
    installCommand: ['pnpm', 'install', '--offline', '--frozen-lockfile'],
    network: 'forbidden',
    repeatabilityCheck: ['pnpm', 'install', '--offline', '--frozen-lockfile'],
  }
  const planPath = join(packRoot, 'closure-plan.json')
  const indexPath = join(packRoot, 'package-index.json')
  const commandPath = join(packRoot, 'install-command.json')
  await writeFile(planPath, independentStableJson(plan))
  await writeFile(indexPath, independentStableJson(packageIndex))
  await writeFile(commandPath, independentStableJson(installCommand))
  const manifestPackages = []
  for (const entry of packagePlans) {
    const packageRoot = join(runtime, 'node_modules', ...entry.name.split('/'))
    const files = []
    for (const path of entry.packlist.map(item => item.path).sort()) {
      files.push({ path, sha256: await fileSha256(join(packageRoot, path)) })
    }
    const contentSha256 = independentJsonSha256({ files, links: [] })
    manifestPackages.push({
      name: entry.name,
      version: entry.version,
      locator: `node_modules/${entry.name}`,
      aliases: [`node_modules/${entry.name}`],
      manifestSha256: await fileSha256(join(packageRoot, 'package.json')),
      contentSha256,
      contentFiles: files,
      contentLinks: [],
      integrity: `sha256-${contentSha256}`,
      javaScriptEntries: [],
      unresolvedRelativeImports: [],
    })
  }
  manifestPackages.sort((left, right) => left.locator.localeCompare(right.locator))
  const installed = {
    version: 2,
    target: 'macos-arm64',
    rootPackageJsonSha256: await fileSha256(rootManifestPath),
    lockfileSha256: await fileSha256(join(runtime, 'pnpm-lock.yaml')),
    requiredFiles: requiredFiles.toSorted((left, right) => left.path.localeCompare(right.path)),
    packageCount: manifestPackages.length,
    packages: manifestPackages,
    symlinks: [],
    allowedMultiVersionPackages: [],
    edges: packagePlans.map(entry => ({
      from: '<runtime>',
      to: `${entry.name}@${entry.version}`,
      section: 'dependencies',
    })).sort((left, right) => left.to.localeCompare(right.to)),
  }
  const installedPath = join(packRoot, 'installed-runtime-manifest.json')
  await writeFile(installedPath, independentStableJson(installed))
  const provenance = join(runtime, '.ark-provenance')
  await mkdir(provenance)
  for (const name of ['closure-plan.json', 'package-index.json', 'install-command.json', 'installed-runtime-manifest.json']) {
    await copyFile(join(packRoot, name), join(provenance, name))
  }
  const receipt = {
    version: 3,
    target: 'macos-arm64',
    sourceDigest: plan.sourceDigest,
    sourceIdentity,
    deferredPlatforms: [],
    runtimeRelativePath: 'runtime-template',
    workspacePackageCount: packagePlans.length,
    packedPackageCount: packageIndex.length,
    closurePlanSha256: await fileSha256(planPath),
    packageIndexSha256: await fileSha256(indexPath),
    installCommandSha256: await fileSha256(commandPath),
    runtimePackageJsonSha256: await fileSha256(join(runtime, 'package.json')),
    runtimeWorkspaceSha256: await fileSha256(join(runtime, 'pnpm-workspace.yaml')),
    lockfileSha256: await fileSha256(join(runtime, 'pnpm-lock.yaml')),
    identityPolicySha256: plan.identityPolicySha256,
    installedRuntimeManifestSha256: await fileSha256(installedPath),
    installedRuntimeIdentitySha256: independentJsonSha256(installed),
    install: {
      offline: true,
      frozenLockfile: true,
      packageManager: 'pnpm@11.7.0',
      lockDerivation: 'root-lock-exact-resolutions',
    },
  }
  const receiptPath = join(packRoot, 'pack-receipt.json')
  await writeFile(receiptPath, independentStableJson(receipt))
  await copyFile(receiptPath, join(provenance, 'pack-receipt.json'))
  return { packRoot, runtime, receiptPath, plan }
}

test('Ark runtime closure accepts the dedicated entry and scans pnpm package identities', async () => {
  const root = await stageRuntime()
  try {
    await writeFile(join(root, 'node_modules/.modules.yaml'), 'hoistPattern: []\n')
    assert.deepEqual(await assertArkRuntimeClosure(root, policy), { packageCount: policyDocument.required.length })
    const forbidden = join(root, 'node_modules/.pnpm/web-app/node_modules/@deepseek-ai/dsh-web-app')
    await mkdir(forbidden, { recursive: true })
    await writeFile(join(forbidden, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-web-app',
      version: '1.0.0',
    }))
    await assert.rejects(assertArkRuntimeClosure(root, policy), /dsh-web-app/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Ark runtime closure rejects a missing current required package or product asset', async () => {
  const root = await stageRuntime()
  try {
    await rm(join(root, 'node_modules/@deepseek-ai/dsh-session-log-deepseek'), { recursive: true })
    await assert.rejects(
      assertArkRuntimeClosure(root, policy),
      /dependency is unresolved: <runtime> -> @deepseek-ai\/dsh-session-log-deepseek/,
    )

    await mkdir(join(root, 'node_modules/@deepseek-ai/dsh-session-log-deepseek'), { recursive: true })
    await writeFile(
      join(root, 'node_modules/@deepseek-ai/dsh-session-log-deepseek/package.json'),
      JSON.stringify({ name: '@deepseek-ai/dsh-session-log-deepseek', version: '1.0.0' }),
    )
    await rm(join(root, 'runtime.mjs'))
    await assert.rejects(assertArkRuntimeClosure(root, policy), /lacks required current-source asset: .*runtime\.mjs/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Ark runtime closure follows direct package links and rejects node_modules bypass siblings', async () => {
  const root = await stageRuntime()
  try {
    const storePackage = join(root, 'node_modules/.pnpm/ui/node_modules/@deepseek-ai/dsh-client-ui-layout')
    await mkdir(storePackage, { recursive: true })
    await writeFile(join(storePackage, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-client-ui-layout',
      version: '1.0.0',
    }))
    const direct = join(root, 'node_modules/@deepseek-ai/dsh-client-ui-layout')
    await symlink('../.pnpm/ui/node_modules/@deepseek-ai/dsh-client-ui-layout', direct)
    await assert.rejects(assertArkRuntimeClosure(root, policy), /dsh-client-ui-layout/)

    await rm(direct)
    await rm(join(root, 'node_modules/.pnpm'), { recursive: true })
    await mkdir(join(root, 'node_modules.interrupted-v82-offline'))
    await assert.rejects(assertArkRuntimeClosure(root, policy), /node_modules\.interrupted-v82-offline/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Ark runtime closure rejects package symlinks that escape the runtime', async () => {
  const root = await stageRuntime()
  const outside = await mkdtemp(join(tmpdir(), 'ark-runtime-outside-'))
  try {
    await writeFile(join(outside, 'package.json'), JSON.stringify({ name: 'outside-package', version: '1.0.0' }))
    await symlink(outside, join(root, 'node_modules/outside-package'))
    await addRootDependency(root, 'outside-package', '1.0.0')
    await assert.rejects(assertArkRuntimeClosure(root, policy), /package link escapes the runtime/)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('Ark runtime closure rejects every browser-client package family member', async () => {
  for (const name of [
    '@deepseek-ai/dsh',
    '@deepseek-ai/dsh-client-web',
    '@deepseek-ai/dsh-client-test-runtime',
    '@deepseek-ai/dsh-client-connection',
    '@deepseek-ai/dsh-client-api-remotes',
  ]) {
    const root = await stageRuntime()
    try {
      const packageRoot = join(root, 'node_modules/.pnpm/client/node_modules', ...name.split('/'))
      await mkdir(packageRoot, { recursive: true })
      await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name, version: '1.0.0' }))
      await assert.rejects(assertArkRuntimeClosure(root, policy), new RegExp(name.slice(name.lastIndexOf('/') + 1)))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})

test('Ark runtime closure rejects forbidden dependency edges even when the target is absent', async () => {
  const root = await stageRuntime()
  try {
    const packageRoot = join(root, 'node_modules/.pnpm/owner/node_modules/@deepseek-ai/dsh-native-owner')
    await mkdir(packageRoot, { recursive: true })
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-native-owner',
      version: '1.0.0',
      optionalDependencies: {
        '@deepseek-ai/dsh-client-web': '0.1.1-rc.2',
      },
    }))
    await addRootDependency(root, '@deepseek-ai/dsh-native-owner', '1.0.0')
    await assert.rejects(
      assertArkRuntimeClosure(root, policy),
      /dsh-native-owner -> @deepseek-ai\/dsh-client-web/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Ark runtime closure rejects an exported first-party entry that plain Node cannot parse', async () => {
  const root = await stageRuntime()
  try {
    const packageRoot = join(root, 'node_modules/@deepseek-ai/dsh-syntax-fixture')
    await mkdir(join(packageRoot, 'lib'), { recursive: true })
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-syntax-fixture',
      version: '1.0.0',
      type: 'module',
      main: 'lib/index.js',
      exports: {
        '.': './lib/index.js',
        './broken': './lib/broken.js',
      },
    }))
    await writeFile(join(packageRoot, 'lib/index.js'), 'export const ok = true\n')
    await writeFile(join(packageRoot, 'lib/broken.js'), 'class Broken { @Remote("run") run() {} }\n')
    await addRootDependency(root, '@deepseek-ai/dsh-syntax-fixture', '1.0.0')
    await assert.rejects(
      assertArkRuntimeClosure(root, policy),
      /unparseable JavaScript entry @deepseek-ai\/dsh-syntax-fixture:lib\/broken\.js/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Ark runtime closure rejects a missing first-party dynamic chunk', async () => {
  const root = await stageRuntime()
  try {
    const packageRoot = join(root, 'node_modules/@deepseek-ai/dsh-dynamic-fixture')
    await mkdir(join(packageRoot, 'lib'), { recursive: true })
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-dynamic-fixture',
      version: '1.0.0',
      type: 'module',
      main: 'lib/index.js',
    }))
    await writeFile(join(packageRoot, 'lib/index.js'), 'export const load = () => import("./missing.js")\n')
    await addRootDependency(root, '@deepseek-ai/dsh-dynamic-fixture', '1.0.0')
    await assert.rejects(
      assertArkRuntimeClosure(root, policy),
      /dynamic JavaScript import is unresolved: lib\/index\.js -> \.\/missing\.js/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('recursive closure rejects duplicate exact copies and orphan store packages', async () => {
  const root = await stageRuntime()
  try {
    const source = join(root, 'node_modules/@deepseek-ai/dsh-settings')
    const duplicate = join(root, 'node_modules/.pnpm/duplicate/node_modules/@deepseek-ai/dsh-settings')
    await mkdir(dirname(duplicate), { recursive: true })
    await cp(source, duplicate, { recursive: true })
    await assert.rejects(
      assertArkRuntimeClosure(root, policy),
      /duplicate physical package identities: @deepseek-ai\/dsh-settings@1\.0\.0/,
    )

    await rm(join(root, 'node_modules/.pnpm'), { recursive: true })
    const orphan = join(root, 'node_modules/.pnpm/orphan/node_modules/orphan-package')
    await mkdir(orphan, { recursive: true })
    await writeFile(join(orphan, 'package.json'), JSON.stringify({ name: 'orphan-package', version: '2.0.0' }))
    await assert.rejects(assertArkRuntimeClosure(root, policy), /orphan package identities: orphan-package@2\.0\.0/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('recursive closure accepts only source-controlled multi-version externals', async () => {
  const root = await stageRuntime()
  try {
    const ownerA = join(root, 'node_modules/@deepseek-ai/dsh-settings')
    const ownerB = join(root, 'node_modules/@deepseek-ai/dsh-host-connection')
    const packageA = join(ownerA, 'node_modules/chokidar')
    const packageB = join(ownerB, 'node_modules/chokidar')
    await mkdir(packageA, { recursive: true })
    await mkdir(packageB, { recursive: true })
    await writeFile(join(packageA, 'package.json'), JSON.stringify({ name: 'chokidar', version: '4.0.3' }))
    await writeFile(join(packageB, 'package.json'), JSON.stringify({ name: 'chokidar', version: '5.0.0' }))
    for (const [owner, version] of [[ownerA, '4.0.3'], [ownerB, '5.0.0']]) {
      const manifestPath = join(owner, 'package.json')
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      manifest.dependencies = { chokidar: version }
      await writeFile(manifestPath, JSON.stringify(manifest))
    }
    const manifest = await createArkRuntimeManifest(root, policy)
    assert.deepEqual(manifest.allowedMultiVersionPackages, [{
      name: 'chokidar',
      versions: ['4.0.3', '5.0.0'],
    }])
    assert.equal(manifest.packages.filter(entry => entry.name === 'chokidar').length, 2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('recursive closure rejects an undeclared multi-version external', async () => {
  const root = await stageRuntime()
  try {
    const ownerA = join(root, 'node_modules/@deepseek-ai/dsh-settings')
    const ownerB = join(root, 'node_modules/@deepseek-ai/dsh-host-connection')
    for (const [owner, version] of [[ownerA, '1.0.0'], [ownerB, '2.0.0']]) {
      const packageRoot = join(owner, 'node_modules/shared-external')
      await mkdir(packageRoot, { recursive: true })
      await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
        name: 'shared-external',
        version,
      }))
      const manifestPath = join(owner, 'package.json')
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      manifest.dependencies = { 'shared-external': version }
      await writeFile(manifestPath, JSON.stringify(manifest))
    }
    await assert.rejects(
      createArkRuntimeManifest(root, policy),
      /undeclared multiversion package: shared-external/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('recursive closure rejects hardlinked package files', async () => {
  const root = await stageRuntime()
  try {
    const manifestPath = join(root, 'node_modules/@deepseek-ai/dsh-settings/package.json')
    const linkedSource = join(root, 'hardlink-source.json')
    await copyFile(manifestPath, linkedSource)
    await rm(manifestPath)
    await link(linkedSource, manifestPath)
    await assert.rejects(createArkRuntimeManifest(root, policy), /hardlinked file.*nlink=2/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('recursive manifest discovers nested package roots and is byte-repeatable', async () => {
  const root = await stageRuntime()
  try {
    const owner = join(root, 'node_modules/@deepseek-ai/dsh-settings')
    const nested = join(owner, 'node_modules/nested-package')
    await mkdir(join(nested, 'lib'), { recursive: true })
    await writeFile(join(nested, 'package.json'), JSON.stringify({
      name: 'nested-package',
      version: '3.0.0',
      main: 'lib/index.js',
    }))
    await writeFile(join(nested, 'lib/index.js'), 'module.exports = 1\n')
    const ownerManifestPath = join(owner, 'package.json')
    const ownerManifest = JSON.parse(await readFile(ownerManifestPath, 'utf8'))
    ownerManifest.dependencies = { 'nested-package': '3.0.0' }
    await writeFile(ownerManifestPath, JSON.stringify(ownerManifest))
    const first = await createArkRuntimeManifest(root, policy)
    const second = await createArkRuntimeManifest(root, policy)
    assert.equal(independentJsonSha256(first), independentJsonSha256(second))
    assert.ok(first.packages.some(entry => entry.name === 'nested-package' && entry.version === '3.0.0'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('bound receipt rejects an unrelated receipt and modified required profile bytes', async () => {
  const fixture = await stageBoundRuntime()
  try {
    assert.deepEqual(
      await assertArkRuntimeClosure(fixture.runtime, policy, {
        receiptPath: fixture.receiptPath,
        currentPlan: fixture.plan,
      }),
      { packageCount: policyDocument.required.length },
    )
    const foreign = await stageBoundRuntime()
    try {
      await assert.rejects(
        assertArkRuntimeClosure(fixture.runtime, policy, {
          receiptPath: foreign.receiptPath,
          currentPlan: fixture.plan,
        }),
        /receipt is not bound to this runtime/,
      )
    } finally {
      await rm(foreign.packRoot, { recursive: true, force: true })
    }
    await writeFile(join(fixture.runtime, 'jiuzhang/profile/cordis.patch.yml'), '# modified\n')
    await assert.rejects(
      assertArkRuntimeClosure(fixture.runtime, policy, {
        receiptPath: fixture.receiptPath,
        currentPlan: fixture.plan,
      }),
      /required profile\/source asset differs from its plan/,
    )
  } finally {
    await rm(fixture.packRoot, { recursive: true, force: true })
  }
})

test('bound receipt rejects forged plan, wrong TGZ/lock edge, runtime swap, and unregistered symlink', async () => {
  for (const mutation of ['plan', 'tarball', 'lock', 'lock-edge', 'runtime', 'symlink']) {
    const fixture = await stageBoundRuntime()
    try {
      if (mutation === 'plan') {
        const path = join(fixture.packRoot, 'closure-plan.json')
        const forged = JSON.parse(await readFile(path, 'utf8'))
        forged.sourceDigest = 'f'.repeat(64)
        await writeFile(path, independentStableJson(forged))
        await copyFile(path, join(fixture.runtime, '.ark-provenance/closure-plan.json'))
        const receipt = JSON.parse(await readFile(fixture.receiptPath, 'utf8'))
        receipt.sourceDigest = forged.sourceDigest
        receipt.closurePlanSha256 = await fileSha256(path)
        await writeFile(fixture.receiptPath, independentStableJson(receipt))
        await copyFile(fixture.receiptPath, join(fixture.runtime, '.ark-provenance/pack-receipt.json'))
      } else if (mutation === 'tarball') {
        const index = JSON.parse(await readFile(join(fixture.packRoot, 'package-index.json'), 'utf8'))
        await writeFile(join(fixture.packRoot, index[0].tarball), 'wrong tgz bytes')
      } else if (mutation === 'lock' || mutation === 'lock-edge') {
        const lockPath = join(fixture.runtime, 'pnpm-lock.yaml')
        if (mutation === 'lock') {
          await writeFile(lockPath, "lockfileVersion: '9.0'\nimporters: {}\n")
        } else {
          const index = JSON.parse(await readFile(join(fixture.packRoot, 'package-index.json'), 'utf8'))
          const [owner, dependency] = index
          const ownerSpecifier = `file:../${owner.tarball}`
          const marker = `  ${JSON.stringify(`${owner.name}@${ownerSpecifier}`)}: {}`
          const replacement = [
            `  ${JSON.stringify(`${owner.name}@${ownerSpecifier}`)}:`,
            '    dependencies:',
            `      ${JSON.stringify(dependency.name)}: file:../wrong-edge.tgz`,
          ].join('\n')
          const source = await readFile(lockPath, 'utf8')
          assert.ok(source.includes(marker))
          await writeFile(lockPath, source.replace(marker, replacement))
        }
        const manifestPath = join(fixture.packRoot, 'installed-runtime-manifest.json')
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
        manifest.lockfileSha256 = await fileSha256(lockPath)
        await writeFile(manifestPath, independentStableJson(manifest))
        await copyFile(manifestPath, join(fixture.runtime, '.ark-provenance/installed-runtime-manifest.json'))
        const receipt = JSON.parse(await readFile(fixture.receiptPath, 'utf8'))
        receipt.lockfileSha256 = await fileSha256(lockPath)
        receipt.installedRuntimeManifestSha256 = await fileSha256(manifestPath)
        receipt.installedRuntimeIdentitySha256 = independentJsonSha256(manifest)
        await writeFile(fixture.receiptPath, independentStableJson(receipt))
        await copyFile(fixture.receiptPath, join(fixture.runtime, '.ark-provenance/pack-receipt.json'))
      } else {
        const packageRoot = join(fixture.runtime, 'node_modules/@deepseek-ai/dsh-settings')
        if (mutation === 'runtime') {
          await writeFile(
            join(packageRoot, 'package.json'),
            JSON.stringify({ name: '@deepseek-ai/dsh-settings', version: '9.9.9' }),
          )
        } else {
          await symlink('package.json', join(packageRoot, 'unregistered-manifest-link.json'))
        }
      }
      await assert.rejects(
        assertArkRuntimeClosure(fixture.runtime, policy, {
          receiptPath: fixture.receiptPath,
          currentPlan: fixture.plan,
        }),
        {
          plan: /closure plan bytes differ/,
          tarball: /tarball .* hash mismatch/,
          lock: /runtime lock lacks its root importer/,
          'lock-edge': /workspace edge does not resolve to its TGZ|snapshot edges differ from root lock/,
          runtime: /workspace identity differs|installed runtime differs/,
          symlink: /installed runtime differs/,
        }[mutation],
      )
    } finally {
      await rm(fixture.packRoot, { recursive: true, force: true })
    }
  }
})

test('Ark runtime syntax inventory rejects an entry that escapes its package', () => {
  assert.throws(
    () => packageJavaScriptEntries({ main: '../outside.js' }),
    /unsafe JavaScript entry: \.\.\/outside\.js/,
  )
})
