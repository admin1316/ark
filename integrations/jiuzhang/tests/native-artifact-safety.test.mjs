import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { runtimeAssetSource } from '../src/runtime-plan.mjs'

const execFileAsync = promisify(execFile)
const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const nativeRoot = join(root, 'integrations/jiuzhang/native')
const integrationRoot = join(root, 'integrations/jiuzhang')
const buildScript = join(nativeRoot, 'build-app.sh')
const installScript = join(nativeRoot, 'install-local.sh')
const updateScript = join(nativeRoot, 'update-local.sh')
const runtimePolicyPath = join(integrationRoot, 'profile/forbidden-runtime-packages.json')
const runtimePolicy = JSON.parse(await readFile(runtimePolicyPath, 'utf8'))

async function runZsh(script, args, options = {}) {
  return execFileAsync('/bin/zsh', [script, ...args], { cwd: root, ...options })
}

async function rejectsPolicy(script, args, pattern) {
  await assert.rejects(runZsh(script, args), (error) => {
    assert.equal(error.code, 2)
    assert.match(error.stderr, pattern)
    return true
  })
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

async function findInstalledNodePtyRoot() {
  const store = join(root, 'node_modules/.pnpm')
  const matches = []
  for (const entry of await readdir(store, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const candidate = join(store, entry.name, 'node_modules/node-pty')
    try {
      const manifest = JSON.parse(await readFile(join(candidate, 'package.json'), 'utf8'))
      if (manifest.name === 'node-pty' && manifest.version === '1.2.0-beta.15') matches.push(candidate)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  assert.equal(
    matches.length,
    1,
    `expected exactly one installed node-pty@1.2.0-beta.15 fixture, found ${matches.length}`,
  )
  return matches[0]
}

async function assertAbsent(path) {
  await assert.rejects(access(path), { code: 'ENOENT' })
}

async function treeSha256(rootPath) {
  const digest = createHash('sha256')
  async function visit(path, relativePath) {
    const metadata = await lstat(path)
    digest.update(`${relativePath}\0${metadata.mode}\0${metadata.size}\0`)
    if (metadata.isSymbolicLink()) {
      digest.update(`link\0${await readlink(path)}\0`)
      return
    }
    if (metadata.isFile()) {
      digest.update('file\0')
      digest.update(await readFile(path))
      return
    }
    assert.equal(metadata.isDirectory(), true, `unexpected special fixture path: ${path}`)
    digest.update('directory\0')
    const entries = await readdir(path)
    entries.sort()
    for (const entry of entries) {
      await visit(join(path, entry), relativePath === '.' ? entry : `${relativePath}/${entry}`)
    }
  }
  await visit(rootPath, '.')
  return digest.digest('hex')
}

async function assertPruneRejectsWithoutMutation(runtime, pattern) {
  const before = await treeSha256(runtime)
  await assert.rejects(
    runZsh(buildScript, ['--prune-node-pty-macos-arm64', runtime]),
    (error) => {
      assert.equal(error.code, 2)
      assert.match(error.stderr, pattern)
      return true
    },
  )
  assert.equal(await treeSha256(runtime), before, 'rejected prune mutated the runtime tree')
}

async function writeRuntimeFixture(rootPath, {
  directLink = true,
  hoistedDirect = false,
  route = true,
  pluginInventoryRoute = true,
} = {}) {
  const rootDependencies = Object.fromEntries([
    ...runtimePolicy.required,
    '@deepseek-ai/dsh-llm',
  ].map(name => [name, '1.0.0']))
  for (const relative of runtimePolicy.requiredFiles) {
    const source = runtimeAssetSource(root, relative)
    const destination = join(rootPath, relative)
    await mkdir(dirname(destination), { recursive: true })
    await copyFile(source, destination)
  }
  for (const name of runtimePolicy.required) {
    if (name === '@deepseek-ai/dsh-native-api-runner'
      || name === '@deepseek-ai/dsh-host-plugin-inventory'
      || name === '@deepseek-ai/dsh-api-gateway') continue
    const packageRoot = join(rootPath, 'node_modules', ...name.split('/'))
    await mkdir(packageRoot, { recursive: true })
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name, version: '1.0.0' }))
  }
  const arkEntry = join(
    rootPath,
    'node_modules/@deepseek-ai/dsh-native-api-runner/lib/bin.js',
  )
  await mkdir(dirname(arkEntry), { recursive: true })
  await writeFile(arkEntry, '#!/usr/bin/env node\n')
  await writeFile(join(
    rootPath,
    'node_modules/@deepseek-ai/dsh-native-api-runner/package.json',
  ), JSON.stringify({
    name: '@deepseek-ai/dsh-native-api-runner',
    version: '1.0.0',
  }))
  const gatewayPackage = join(
    rootPath,
    'node_modules/.pnpm/dsh-api-gateway-fixture/node_modules/@deepseek-ai/dsh-api-gateway',
  )
  await mkdir(join(gatewayPackage, 'lib'), { recursive: true })
  await writeFile(join(gatewayPackage, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-api-gateway',
    version: '1.0.0',
    main: 'lib/index.js',
  }))
  await writeFile(
    join(gatewayPackage, 'lib/index.js'),
    route
      ? 'export function createTypertGatewayDispatcher() {}\nexport const route = "llm/mutateProvider"\nexport const carrier = \'intercept("/api"\'\n'
      : 'export function createTypertGatewayDispatcher() {}\n',
  )
  if (directLink) {
    const gatewayDirect = join(rootPath, 'node_modules/@deepseek-ai/dsh-api-gateway')
    await mkdir(dirname(gatewayDirect), { recursive: true })
    if (hoistedDirect) {
      await cp(gatewayPackage, gatewayDirect, { recursive: true })
      await rm(gatewayPackage, { recursive: true })
    }
    else {
      await symlink(
        '../.pnpm/dsh-api-gateway-fixture/node_modules/@deepseek-ai/dsh-api-gateway',
        gatewayDirect,
      )
    }
  }

  const llmPackage = join(
    rootPath,
    'node_modules/.pnpm/dsh-llm-fixture/node_modules/@deepseek-ai/dsh-llm',
  )
  await mkdir(join(llmPackage, 'lib'), { recursive: true })
  await writeFile(join(llmPackage, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-llm',
    version: '1.0.0',
    main: 'lib/index.js',
  }))
  await writeFile(join(llmPackage, 'lib/index.js'), 'export const llm = true\n')
  const llmDescriptor = route
    ? "export const descriptor = { id: '@deepseek-ai/dsh-llm#llm/mutateProvider', service: 'llm' }\n"
    : "export const descriptor = { id: '@deepseek-ai/dsh-llm#llm/models', service: 'llm' }\n"
  await writeFile(join(llmPackage, 'lib/typert.host.js'), llmDescriptor)
  await writeFile(join(llmPackage, 'lib/typert.remote-client.js'), llmDescriptor)
  const llmDirect = join(rootPath, 'node_modules/@deepseek-ai/dsh-llm')
  await mkdir(dirname(llmDirect), { recursive: true })
  if (hoistedDirect) {
    await cp(llmPackage, llmDirect, { recursive: true })
    await rm(llmPackage, { recursive: true })
  } else {
    await symlink('../.pnpm/dsh-llm-fixture/node_modules/@deepseek-ai/dsh-llm', llmDirect)
  }

  const inventoryPackage = join(
    rootPath,
    'node_modules/.pnpm/plugin-inventory-fixture/node_modules/@deepseek-ai/dsh-host-plugin-inventory',
  )
  await mkdir(join(inventoryPackage, 'lib'), { recursive: true })
  await writeFile(join(inventoryPackage, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-host-plugin-inventory',
    version: '1.0.0',
    main: 'lib/index.js',
  }))
  await writeFile(
    join(inventoryPackage, 'lib/index.js'),
    pluginInventoryRoute
      ? 'class Base { constructor() {} }\nclass Inventory extends Base { constructor(ctx) { super(ctx, "pluginInventory") } list() {} }\nfunction Remote() { return () => {} }\nRemote("list")(Inventory.prototype.list)\n'
      : 'export class Inventory {}\n',
  )
  const descriptor = pluginInventoryRoute
    ? "export const route = 'pluginInventory/list'\n"
    : "export const route = 'pluginInventory/status'\n"
  await writeFile(join(inventoryPackage, 'lib/typert.host.js'), descriptor)
  await writeFile(join(inventoryPackage, 'lib/typert.remote-client.js'), descriptor)
  const inventoryDirect = join(rootPath, 'node_modules/@deepseek-ai/dsh-host-plugin-inventory')
  await mkdir(dirname(inventoryDirect), { recursive: true })
  if (hoistedDirect) {
    await cp(inventoryPackage, inventoryDirect, { recursive: true })
    await rm(inventoryPackage, { recursive: true })
  }
  else {
    await symlink(
      '../.pnpm/plugin-inventory-fixture/node_modules/@deepseek-ai/dsh-host-plugin-inventory',
      inventoryDirect,
    )
  }
  await writeFile(join(rootPath, 'package.json'), JSON.stringify({
    name: 'ark-runtime-artifact-fixture',
    version: '0.0.0',
    dependencies: rootDependencies,
  }))
}

test('native Ark artifact scripts reject production paths and accept a fresh temporary candidate', {
  skip: process.platform !== 'darwin',
}, async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'ark-native-artifact-safety-'))
  try {
    const safeOutput = join(sandbox, 'candidate-output')
    const safe = await runZsh(buildScript, ['--check-output', safeOutput])
    assert.match(safe.stdout, /safe Ark candidate output/)

    for (const dangerous of [
      '/',
      '/Applications',
      '/Applications/Ark.app',
      '/Applications/Ark.app/Contents',
      join(sandbox, 'Ark.app', 'nested-output'),
    ]) {
      await rejectsPolicy(buildScript, ['--check-output', dangerous], /refusing/)
    }

    const linkedOutput = join(sandbox, 'linked-output')
    await symlink('/Applications', linkedOutput)
    await rejectsPolicy(buildScript, ['--check-output', linkedOutput], /refusing/)

    await mkdir(join(safeOutput, 'Ark.app'), { recursive: true })
    await rejectsPolicy(buildScript, ['--check-output', safeOutput], /existing Ark candidate unit/)
    await rm(join(safeOutput, 'Ark.app'), { recursive: true })
    await writeFile(join(safeOutput, 'provenance.json'), '{}\n')
    await rejectsPolicy(buildScript, ['--check-output', safeOutput], /existing Ark candidate unit/)
    await rejectsPolicy(
      buildScript,
      ['--check-signing-config', 'Apple Development: Wrong (ABCDEFGHIJ)', 'ABCDEFGHIJ'],
      /must begin with 'Developer ID Application: '/,
    )
    await rejectsPolicy(
      buildScript,
      ['--check-signing-config', 'Developer ID Application: Example (ABCDEFGHIJ)', 'WRONG'],
      /exact 10-character Apple Team ID/,
    )
    const signing = await runZsh(buildScript, [
      '--check-signing-config',
      'Developer ID Application: Example (ABCDEFGHIJ)',
      'ABCDEFGHIJ',
    ])
    assert.match(signing.stdout, /valid Developer ID Application identity and Team ID/)
    await rejectsPolicy(installScript, ['--system'], /governed promotion flow/)
    await rejectsPolicy(updateScript, ['--system'], /governed promotion flow/)
  } finally {
    await rm(sandbox, { recursive: true, force: true })
  }
})

test('candidate build audits every Mach-O architecture and publishes only after signing', {
  skip: process.platform !== 'darwin' || process.arch !== 'arm64',
}, async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'ark-macho-inventory-'))
  try {
    const source = join(sandbox, 'fixture.c')
    const armTree = join(sandbox, 'arm64')
    const x86Tree = join(sandbox, 'x86_64')
    await mkdir(armTree)
    await mkdir(x86Tree)
    await writeFile(source, 'int main(void) { return 0; }\n')
    await execFileAsync('/usr/bin/clang', ['-arch', 'arm64', '-c', source, '-o', join(armTree, 'fixture.o')])
    await execFileAsync('/usr/bin/clang', ['-arch', 'x86_64', '-c', source, '-o', join(x86Tree, 'fixture.o')])
    const inventoryPath = join(sandbox, 'arm64.json')
    await runZsh(buildScript, ['--audit-macho-tree', armTree, 'pre-sign', inventoryPath])
    const inventory = JSON.parse(await readFile(inventoryPath, 'utf8'))
    assert.equal(inventory.machOCount, 1)
    assert.deepEqual(inventory.files[0].architectures, ['arm64'])
    await assert.rejects(
      runZsh(buildScript, ['--audit-macho-tree', x86Tree, 'pre-sign', join(sandbox, 'x86.json')]),
      /must contain exactly arm64.*x86_64/s,
    )
    const wrongCertificate = join(sandbox, 'wrong-certificate')
    await execFileAsync('/usr/bin/clang', ['-arch', 'arm64', source, '-o', wrongCertificate])
    await execFileAsync('/usr/bin/codesign', ['--force', '--sign', '-', wrongCertificate])
    await assert.rejects(
      runZsh(buildScript, [
        '--check-signed-identity',
        wrongCertificate,
        'Developer ID Application: Example (ABCDEFGHIJ)',
        'ABCDEFGHIJ',
      ]),
      /authority does not match/,
    )

    const buildSource = await readFile(buildScript, 'utf8')
    const staging = buildSource.indexOf('mktemp -d "${destination:h}/.${destination:t}.staging.XXXXXX"')
    const packCopy = buildSource.indexOf('/usr/bin/ditto "${external_pack_root}" "${staged_pack_root}"')
    const stagedVerification = buildSource.indexOf(
      'ark_require_pack_receipt "${runtime_root}" "${effective_pack_receipt}"',
    )
    const signing = buildSource.indexOf('/usr/bin/codesign --force --deep')
    const publish = buildSource.indexOf('/bin/mv "${build_stage_root}" "${destination}"')
    assert.ok(staging >= 0 && staging < packCopy && packCopy < stagedVerification)
    assert.ok(stagedVerification < signing && signing < publish)
    assert.match(buildSource, /ark_cleanup_build[\s\S]*\/bin\/rm -rf -- "\$\{build_stage_root\}"/u)
    assert.match(buildSource, /staged_pack_root="\$\{build_stage_root\}\/pack-input"/u)
    assert.match(buildSource, /ark_require_pack_receipt "\$\{runtime_root\}" "\$\{effective_pack_receipt\}"/u)
    assert.match(buildSource, /ArkSourceCommit/u)
    assert.match(buildSource, /ArkSourceDirtyDiffSHA256/u)
    assert.match(buildSource, /ArkSourceSnapshotSHA256/u)
    assert.match(buildSource, /ArkPackReceiptSHA256/u)
    assert.match(buildSource, /Authority=\$\{identity\}/u)
    assert.match(buildSource, /TeamIdentifier=\$\{team_id\}/u)
    assert.match(buildSource, /staged_receipt_path="\$\{build_stage_root\}\/provenance\.json"/u)
  } finally {
    await rm(sandbox, { recursive: true, force: true })
  }
})

test('atomic candidate-unit publication exposes neither half after a pre-publish crash', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'ark-candidate-unit-'))
  try {
    const destination = join(sandbox, 'candidate')
    const interrupted = join(sandbox, '.candidate.staging.interrupted')
    await mkdir(join(interrupted, 'Ark.app'), { recursive: true })
    await writeFile(join(interrupted, 'provenance.json'), '{}\n')
    await rm(interrupted, { recursive: true, force: true })
    await assertAbsent(destination)

    const complete = join(sandbox, '.candidate.staging.complete')
    await mkdir(join(complete, 'Ark.app'), { recursive: true })
    await writeFile(join(complete, 'provenance.json'), '{}\n')
    await rename(complete, destination)
    await access(join(destination, 'Ark.app'))
    await access(join(destination, 'provenance.json'))
  } finally {
    await rm(sandbox, { recursive: true, force: true })
  }
})

test('runtime install-state prune removes only exact pnpm metadata and rejects non-files atomically', {
  skip: process.platform !== 'darwin',
}, async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'ark-runtime-install-state-'))
  try {
    const runtime = join(sandbox, 'runtime')
    const modules = join(runtime, 'node_modules')
    await mkdir(modules, { recursive: true })
    await writeFile(join(modules, '.modules.yaml'), 'storeDir: /build/machine\n')
    await writeFile(join(modules, '.pnpm-workspace-state-v1.json'), '{"build":"/tmp/source"}\n')
    await writeFile(join(modules, 'keep.json'), '{}\n')

    await assert.rejects(
      runZsh(buildScript, ['--check-runtime-install-state', runtime]),
      /runtime retains package-manager install state/,
    )
    const pruned = await runZsh(buildScript, ['--prune-runtime-install-state', runtime])
    assert.match(pruned.stdout, /removed 2 package-manager state files/)
    const checked = await runZsh(buildScript, ['--check-runtime-install-state', runtime])
    assert.match(checked.stdout, /accepted zero package-manager state files/)
    await assertAbsent(join(modules, '.modules.yaml'))
    await assertAbsent(join(modules, '.pnpm-workspace-state-v1.json'))
    assert.equal(await readFile(join(modules, 'keep.json'), 'utf8'), '{}\n')

    const rejected = join(sandbox, 'rejected')
    const rejectedModules = join(rejected, 'node_modules')
    await mkdir(rejectedModules, { recursive: true })
    const first = join(rejectedModules, '.modules.yaml')
    const outside = join(sandbox, 'outside.json')
    await writeFile(first, 'keep until full preflight succeeds\n')
    await writeFile(outside, '{}\n')
    await symlink(outside, join(rejectedModules, '.pnpm-workspace-state-v1.json'))
    await assert.rejects(
      runZsh(buildScript, ['--prune-runtime-install-state', rejected]),
      /not an ordinary file/,
    )
    assert.equal(await readFile(first, 'utf8'), 'keep until full preflight succeeds\n')
  } finally {
    await rm(sandbox, { recursive: true, force: true })
  }
})

test('self-contained runtime compatibility follows the strict Gateway and requires mutateProvider', {
  skip: process.platform !== 'darwin',
}, async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'ark-native-runtime-compatibility-'))
  const client = join(sandbox, 'ArkSettingsAPI.swift')
  try {
    await writeFile(client, 'let method = "llm/mutateProvider"\n')

    const compatible = join(sandbox, 'compatible')
    await writeRuntimeFixture(compatible)
    const accepted = await runZsh(buildScript, [
      '--check-runtime-compatibility', client, compatible,
    ])
    assert.match(accepted.stdout, /compatible Native Provider client and Host runtime/)

    const hoisted = join(sandbox, 'hoisted')
    await writeRuntimeFixture(hoisted, { hoistedDirect: true })
    const acceptedHoisted = await runZsh(buildScript, [
      '--check-runtime-compatibility', client, hoisted,
    ])
    assert.match(acceptedHoisted.stdout, /compatible Native Provider client and Host runtime/)

    await mkdir(join(compatible, 'node_modules.interrupted-v82-offline'))
    await rejectsPolicy(
      buildScript,
      ['--check-runtime-compatibility', client, compatible],
      /node_modules\.interrupted-v82-offline/,
    )
    await rm(join(compatible, 'node_modules.interrupted-v82-offline'), { recursive: true })

    const webContaminated = join(sandbox, 'web-contaminated')
    await writeRuntimeFixture(webContaminated)
    const webPackage = join(
      webContaminated,
      'node_modules/.pnpm/web-app/node_modules/@deepseek-ai/dsh-web-app',
    )
    await mkdir(webPackage, { recursive: true })
    await writeFile(join(webPackage, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-web-app',
    }))
    await rejectsPolicy(
      buildScript,
      ['--check-runtime-compatibility', client, webContaminated],
      /dsh-web-app/,
    )

    const missingRoute = join(sandbox, 'missing-route')
    await writeRuntimeFixture(missingRoute, { route: false })
    await rejectsPolicy(
      buildScript,
      ['--check-runtime-compatibility', client, missingRoute],
      /strict Gateway entry lacks llm\/mutateProvider|LLM descriptor lacks llm\/mutateProvider/,
    )
    const blockedOutput = join(sandbox, 'blocked-build')
    await assert.rejects(runZsh(buildScript, [blockedOutput], {
      env: {
        ...process.env,
        JIUZHANG_SELF_CONTAINED: '1',
        JIUZHANG_RUNTIME_ROOT: missingRoute,
        JIUZHANG_NODE_EXECUTABLE: process.execPath,
      },
    }), (error) => {
      assert.equal(error.code, 2)
      assert.match(error.stderr, /requires JIUZHANG_PACK_RECEIPT/)
      return true
    })
    await assert.rejects(access(blockedOutput), { code: 'ENOENT' })

    const missingPackage = join(sandbox, 'missing-package')
    await writeRuntimeFixture(missingPackage, { directLink: false })
    await rejectsPolicy(
      buildScript,
      ['--check-runtime-compatibility', client, missingPackage],
      /lacks the direct @deepseek-ai\/dsh-api-gateway package directory/,
    )

    const missingInventoryRoute = join(sandbox, 'missing-inventory-route')
    await writeRuntimeFixture(missingInventoryRoute, { pluginInventoryRoute: false })
    await rejectsPolicy(
      buildScript,
      ['--check-runtime-compatibility', client, missingInventoryRoute],
      /plugin inventory (entry|descriptor) lacks (its list Remote|pluginInventory\/list)/,
    )
  } finally {
    await rm(sandbox, { recursive: true, force: true })
  }
})

test('macOS arm64 packaging prunes every hoisted and pnpm-store node-pty native payload', {
  skip: process.platform !== 'darwin' || process.arch !== 'arm64',
}, async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'ark-node-pty-macos-prune-'))
  try {
    const source = await findInstalledNodePtyRoot()
    const runtime = join(sandbox, 'runtime')
    const hoisted = join(runtime, 'node_modules/node-pty')
    const storeCopy = join(runtime, 'node_modules/.pnpm/node-pty@layout-independent/node_modules/node-pty')
    await cp(source, hoisted, { recursive: true })
    await cp(source, storeCopy, { recursive: true })

    for (const packageRoot of [hoisted, storeCopy]) {
      await mkdir(join(packageRoot, 'prebuilds/freebsd-riscv'), { recursive: true })
      await writeFile(join(packageRoot, 'prebuilds/freebsd-riscv/pty.node'), 'foreign addon')
      await mkdir(join(packageRoot, 'third_party/conpty/future/win10-riscv'), { recursive: true })
      await writeFile(join(packageRoot, 'third_party/conpty/future/win10-riscv/OpenConsole.exe'), 'foreign exe')
      await mkdir(join(packageRoot, 'build/Release'), { recursive: true })
      await writeFile(join(packageRoot, 'build/Release/pty.node'), 'unlabelled addon')
    }

    const hiddenBeforePrune = join(storeCopy, 'lib/OpenConsole.exe')
    await writeFile(hiddenBeforePrune, 'L56 hidden Windows payload')
    await assertPruneRejectsWithoutMutation(runtime, /retains a Windows native payload/)
    await access(join(hoisted, 'prebuilds/win32-x64'))
    await access(join(storeCopy, 'prebuilds/win32-x64'))
    await rm(hiddenBeforePrune)

    await assert.rejects(
      runZsh(buildScript, ['--check-node-pty-macos-arm64', runtime]),
      /retains foreign prebuilds|retains a Windows/,
    )

    const preserved = new Map()
    for (const packageRoot of [hoisted, storeCopy]) {
      for (const relative of [
        'lib/index.js',
        'lib/unixTerminal.js',
        'prebuilds/darwin-arm64/pty.node',
        'prebuilds/darwin-arm64/spawn-helper',
      ]) {
        preserved.set(`${packageRoot}:${relative}`, await sha256(join(packageRoot, relative)))
      }
    }

    const pruned = await runZsh(buildScript, ['--prune-node-pty-macos-arm64', runtime])
    assert.match(pruned.stdout, /prune accepted 2 physical package copies/)
    const checked = await runZsh(buildScript, ['--check-node-pty-macos-arm64', runtime])
    assert.match(checked.stdout, /check accepted 2 physical package copies/)

    const hiddenWindowsPayload = join(hoisted, 'lib/OpenConsole.exe')
    await writeFile(hiddenWindowsPayload, 'unexpected Windows payload')
    await assert.rejects(
      runZsh(buildScript, ['--check-node-pty-macos-arm64', runtime]),
      /retains a Windows native payload/,
    )
    await rm(hiddenWindowsPayload)

    for (const packageRoot of [hoisted, storeCopy]) {
      assert.deepEqual(await readdir(join(packageRoot, 'prebuilds')), ['darwin-arm64'])
      await assertAbsent(join(packageRoot, 'third_party/conpty'))
      await assertAbsent(join(packageRoot, 'build'))
      for (const relative of [
        'lib/index.js',
        'lib/unixTerminal.js',
        'prebuilds/darwin-arm64/pty.node',
        'prebuilds/darwin-arm64/spawn-helper',
      ]) {
        assert.equal(await sha256(join(packageRoot, relative)), preserved.get(`${packageRoot}:${relative}`))
      }
    }

    const terminalScript = `
      const pty = require(${JSON.stringify(hoisted)});
      const terminal = pty.spawn('/bin/zsh', ['-lc', 'printf node-pty-macos-prune-ok'], {
        name: 'xterm-color', cols: 80, rows: 24, cwd: process.cwd(), env: process.env,
      });
      let output = '';
      const timeout = setTimeout(() => process.exit(2), 5000);
      terminal.onData(data => { output += data; });
      terminal.onExit(({ exitCode }) => {
        clearTimeout(timeout);
        if (exitCode !== 0 || !output.includes('node-pty-macos-prune-ok')) process.exit(3);
      });
    `
    await execFileAsync(process.execPath, ['-e', terminalScript], { cwd: root, timeout: 10_000 })

    const invalid = join(sandbox, 'invalid-runtime')
    const invalidPackage = join(invalid, 'node_modules/node-pty')
    await cp(source, invalidPackage, { recursive: true })
    await rm(join(invalidPackage, 'prebuilds/darwin-arm64/spawn-helper'))
    await assert.rejects(
      runZsh(buildScript, ['--prune-node-pty-macos-arm64', invalid]),
      /lacks ordinary darwin spawn helper/,
    )
    await access(join(invalidPackage, 'prebuilds/win32-x64'))
  } finally {
    await rm(sandbox, { recursive: true, force: true })
  }
})

test('node-pty main containment rejects traversal, absolute, and symlink escapes atomically', {
  skip: process.platform !== 'darwin' || process.arch !== 'arm64',
}, async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'ark-node-pty-main-containment-'))
  try {
    const source = await findInstalledNodePtyRoot()
    const variants = [
      {
        name: 'parent-traversal',
        configure: async (runtime, packageRoot, manifest) => {
          await writeFile(join(runtime, 'escape.js'), 'module.exports = {}\n')
          manifest.main = '../../escape.js'
          await writeFile(join(packageRoot, 'package.json'), JSON.stringify(manifest))
        },
        pattern: /main must not be absolute or contain '\.\.'/,
      },
      {
        name: 'absolute',
        configure: async (runtime, packageRoot, manifest) => {
          const escape = join(runtime, 'escape.js')
          await writeFile(escape, 'module.exports = {}\n')
          manifest.main = escape
          await writeFile(join(packageRoot, 'package.json'), JSON.stringify(manifest))
        },
        pattern: /main must not be absolute or contain '\.\.'/,
      },
      {
        name: 'symlink',
        configure: async (runtime, packageRoot, manifest) => {
          await writeFile(join(runtime, 'escape.js'), 'module.exports = {}\n')
          const main = join(packageRoot, 'lib/index.js')
          await rm(main)
          await symlink('../../../escape.js', main)
          manifest.main = './lib/index.js'
          await writeFile(join(packageRoot, 'package.json'), JSON.stringify(manifest))
        },
        pattern: /lacks ordinary portable JavaScript entry|package main traverses a symlink/,
      },
    ]

    for (const variant of variants) {
      const runtime = join(sandbox, variant.name)
      const packageRoot = join(runtime, 'node_modules/node-pty')
      await cp(source, packageRoot, { recursive: true })
      const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
      await variant.configure(runtime, packageRoot, manifest)
      await assertPruneRejectsWithoutMutation(runtime, variant.pattern)
      await access(join(packageRoot, 'prebuilds/win32-x64'))
    }
  } finally {
    await rm(sandbox, { recursive: true, force: true })
  }
})

test('macOS packaging removes only audited browser-only runtime assets and rejects unknown assets atomically', {
  skip: process.platform !== 'darwin',
}, async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'ark-runtime-browser-assets-'))
  const packageFixture = async (runtime, name, files) => {
    const packageRoot = join(runtime, 'node_modules', ...name.split('/'))
    await mkdir(packageRoot, { recursive: true })
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name }))
    for (const [relative, body] of Object.entries(files)) {
      const destination = join(packageRoot, relative)
      await mkdir(dirname(destination), { recursive: true })
      await writeFile(destination, body)
    }
  }
  try {
    const runtime = join(sandbox, 'accepted')
    await packageFixture(runtime, '@mixmark-io/domino', {
      'lib/index.js': 'export const parse = true\n',
      'test/fixture/doc.html': '<p>fixture</p>\n',
      'test/case.js': 'throw new Error("not shipped at runtime")\n',
    })
    await packageFixture(runtime, 'pdfjs-dist', {
      'build/pdf.mjs': 'export const pdf = true\n',
      'web/pdf_viewer.css': '.viewer {}\n',
      'web/pdf_viewer.mjs': 'export const viewer = true\n',
      'legacy/web/pdf_viewer.css': '.legacy {}\n',
    })
    await packageFixture(runtime, 'tslib', {
      'tslib.js': 'module.exports = {}\n',
      'tslib.html': '<script src="tslib.js"></script>\n',
    })

    await assert.rejects(
      runZsh(buildScript, ['--check-runtime-browser-assets', runtime]),
      /retains audited browser-only assets/,
    )
    const pruned = await runZsh(buildScript, ['--prune-runtime-browser-assets', runtime])
    assert.match(pruned.stdout, /removed 4 audited files/)
    const checked = await runZsh(buildScript, ['--check-runtime-browser-assets', runtime])
    assert.match(checked.stdout, /accepted zero HTML\/CSS-family files/)
    await assertAbsent(join(runtime, 'node_modules/@mixmark-io/domino/test'))
    await assertAbsent(join(runtime, 'node_modules/pdfjs-dist/web'))
    await assertAbsent(join(runtime, 'node_modules/pdfjs-dist/legacy/web'))
    await assertAbsent(join(runtime, 'node_modules/tslib/tslib.html'))
    await access(join(runtime, 'node_modules/@mixmark-io/domino/lib/index.js'))
    await access(join(runtime, 'node_modules/pdfjs-dist/build/pdf.mjs'))
    await access(join(runtime, 'node_modules/tslib/tslib.js'))

    const rejected = join(sandbox, 'rejected')
    await packageFixture(rejected, '@mixmark-io/domino', {
      'lib/index.js': 'export const parse = true\n',
      'test/fixture/doc.html': '<p>fixture</p>\n',
    })
    await packageFixture(rejected, 'unknown-web-ui', {
      'index.html': '<main>unknown</main>\n',
    })
    const before = await treeSha256(rejected)
    await assert.rejects(
      runZsh(buildScript, ['--prune-runtime-browser-assets', rejected]),
      /contains unaudited HTML\/CSS-family assets/,
    )
    assert.equal(await treeSha256(rejected), before)

    const buildRuntime = join(sandbox, 'build-rejected-runtime')
    await writeRuntimeFixture(buildRuntime)
    await packageFixture(buildRuntime, 'unknown-web-ui', {
      'index.html': '<main>unknown build input</main>\n',
    })
    const buildRuntimeBefore = await treeSha256(buildRuntime)
    const blockedOutput = join(sandbox, 'blocked-build-output')
    await assert.rejects(runZsh(buildScript, [blockedOutput], {
      env: {
        ...process.env,
        JIUZHANG_SELF_CONTAINED: '1',
        JIUZHANG_RUNTIME_ROOT: buildRuntime,
        JIUZHANG_NODE_EXECUTABLE: process.execPath,
      },
    }), (error) => {
      assert.equal(error.code, 2)
      assert.match(error.stderr, /requires JIUZHANG_PACK_RECEIPT/)
      return true
    })
    await assertAbsent(blockedOutput)
    assert.equal(await treeSha256(buildRuntime), buildRuntimeBefore)
  } finally {
    await rm(sandbox, { recursive: true, force: true })
  }
})

test('macOS packaging normalizes the audited Canvas install id and rejects unknown build paths atomically', {
  skip: process.platform !== 'darwin' || process.arch !== 'arm64',
}, async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'ark-runtime-macho-id-'))
  const source = join(sandbox, 'install-id-fixture.node')
  const canvasPath = runtime => join(
    runtime,
    'node_modules/@napi-rs/canvas-darwin-arm64/skia.darwin-arm64.node',
  )
  const pnpmCanvasPath = runtime => join(
    runtime,
    'node_modules/.pnpm/@napi-rs+canvas-darwin-arm64@fixture/node_modules/@napi-rs/canvas-darwin-arm64/skia.darwin-arm64.node',
  )
  const writeCanvasPackage = async addon => {
    await mkdir(dirname(addon), { recursive: true })
    await writeFile(join(dirname(addon), 'package.json'), JSON.stringify({
      name: '@napi-rs/canvas-darwin-arm64',
    }))
    await copyFile(source, addon)
  }
  const installId = async path => {
    const { stdout } = await execFileAsync('/usr/bin/otool', ['-D', path])
    return stdout.trim().split('\n').at(-1)
  }
  try {
    // This test exercises Mach-O load-command rewriting, not Canvas rendering.
    // Compile a real dylib so the policy does not depend on an unrelated optional package being installed.
    const fixtureSource = join(sandbox, 'install-id-fixture.c')
    await writeFile(fixtureSource, 'int fixture_value(void) { return 1; }\n')
    await execFileAsync('/usr/bin/clang', [fixtureSource, '-dynamiclib', '-o', source,
      '-Wl,-install_name,/Users/runner/work/canvas/canvas/target/aarch64-apple-darwin/release/deps/libcanvas.dylib'])
    await access(source)
    const runtime = join(sandbox, 'accepted')
    const expected = canvasPath(runtime)
    const pnpmExpected = pnpmCanvasPath(runtime)
    await writeCanvasPackage(expected)
    await writeCanvasPackage(pnpmExpected)
    const oldId = await installId(expected)
    assert.match(oldId, /^\/Users\/runner\/work\/canvas\//)
    assert.match(await installId(pnpmExpected), /^\/Users\/runner\/work\/canvas\//)

    const unknown = join(runtime, 'node_modules/unknown-native/unknown.node')
    await mkdir(dirname(unknown), { recursive: true })
    await copyFile(source, unknown)
    const expectedBefore = await sha256(expected)
    const pnpmExpectedBefore = await sha256(pnpmExpected)
    await assert.rejects(
      runZsh(buildScript, ['--normalize-runtime-macho-ids', runtime]),
      /contains unaudited Mach-O paths/,
    )
    assert.equal(await sha256(expected), expectedBefore)
    assert.equal(await sha256(pnpmExpected), pnpmExpectedBefore)

    await rm(unknown)
    const maliciousSource = join(sandbox, 'malicious-rpath.c')
    await writeFile(maliciousSource, 'int main(void) { return 0; }\n')
    await mkdir(dirname(unknown), { recursive: true })
    await execFileAsync('/usr/bin/clang', [
      maliciousSource,
      '-o', unknown,
      '-Wl,-rpath,/usr/lib/swift injected',
    ])
    await assert.rejects(
      runZsh(buildScript, ['--normalize-runtime-macho-ids', runtime]),
      /contains unaudited Mach-O paths/,
    )
    await rm(unknown)

    const nonSystemLoad = join(runtime, 'node_modules/unknown-native/non-system.node')
    await execFileAsync('/usr/bin/clang', [maliciousSource, '-o', nonSystemLoad])
    await execFileAsync('/usr/bin/install_name_tool', [
      '-change',
      '/usr/lib/libSystem.B.dylib',
      '/opt/ark/lib/libFake.dylib',
      nonSystemLoad,
    ])
    await assert.rejects(
      runZsh(buildScript, ['--normalize-runtime-macho-ids', runtime]),
      /contains unaudited Mach-O paths/,
    )
    await rm(nonSystemLoad)

    const duplicateBefore = await sha256(expected)
    const duplicatePnpmBefore = await sha256(pnpmExpected)
    await assert.rejects(
      runZsh(buildScript, ['--normalize-runtime-macho-ids', runtime]),
      /multiple physical Canvas Mach-O copies/,
    )
    assert.equal(await sha256(expected), duplicateBefore)
    assert.equal(await sha256(pnpmExpected), duplicatePnpmBefore)
    await rm(dirname(dirname(dirname(pnpmExpected))), { recursive: true, force: true })
    const normalized = await runZsh(buildScript, ['--normalize-runtime-macho-ids', runtime])
    assert.match(normalized.stdout, /Canvas package copies=1 normalized physical IDs=1/)
    assert.equal(await installId(expected), '@rpath/skia.darwin-arm64.node')
    const checked = await runZsh(buildScript, ['--normalize-runtime-macho-ids', runtime])
    assert.match(checked.stdout, /Canvas package copies=1 normalized physical IDs=0/)
  } finally {
    await rm(sandbox, { recursive: true, force: true })
  }
})

test('macOS packaging atomically removes only audited main Swift toolchain RPATHs', {
  skip: process.platform !== 'darwin' || process.arch !== 'arm64',
}, async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'ark-main-swift-rpath-'))
  const source = join(sandbox, 'main.c')
  const accepted = join(sandbox, 'accepted')
  const rejected = join(sandbox, 'rejected')
  const toolchainRpath = '/Library/Developer/CommandLineTools/usr/lib/swift-6.2/macosx'
  const xcodeToolchainRpath = '/Applications/Xcode 26 Beta.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift-6.3/macosx'
  const compile = async (output, rpaths = []) => {
    await writeFile(source, 'int main(void) { return 0; }\n')
    await execFileAsync('/usr/bin/clang', [
      source,
      '-o', output,
      ...rpaths.map(value => `-Wl,-rpath,${value}`),
    ])
  }
  const readRpaths = async path => {
    const { stdout } = await execFileAsync('/usr/bin/otool', ['-l', path])
    const lines = stdout.split('\n').map(line => line.trim())
    const values = []
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index] === 'cmd LC_RPATH' && lines[index + 2]?.startsWith('path ')) {
        const match = /^path (.+) \(offset [0-9]+\)$/u.exec(lines[index + 2])
        assert.notEqual(match, null, `unparsable LC_RPATH: ${lines[index + 2]}`)
        values.push(match[1])
      }
    }
    return values
  }
  try {
    await compile(accepted, [
      '/usr/lib/swift',
      '@loader_path',
      toolchainRpath,
      xcodeToolchainRpath,
    ])
    await rejectsPolicy(
      buildScript,
      ['--check-main-swift-rpaths', accepted],
      /retains build-toolchain Swift RPATHs/,
    )
    const normalized = await runZsh(buildScript, ['--normalize-main-swift-rpaths', accepted])
    assert.match(normalized.stdout, /removed 2 build-toolchain entries; retained=2/)
    assert.deepEqual(await readRpaths(accepted), ['/usr/lib/swift', '@loader_path'])
    const checked = await runZsh(buildScript, ['--check-main-swift-rpaths', accepted])
    assert.match(checked.stdout, /accepted 2 entries; build-toolchain entries=0/)

    const noRpath = join(sandbox, 'no-rpath')
    await compile(noRpath)
    const noRpathChecked = await runZsh(buildScript, ['--check-main-swift-rpaths', noRpath])
    assert.match(noRpathChecked.stdout, /accepted 0 entries; build-toolchain entries=0/)

    const malicious = join(sandbox, 'malicious-space')
    await compile(malicious, ['/usr/lib/swift injected', '@loader_path'])
    const maliciousBefore = await sha256(malicious)
    await rejectsPolicy(
      buildScript,
      ['--normalize-main-swift-rpaths', malicious],
      /has unaudited RPATHs/,
    )
    assert.equal(await sha256(malicious), maliciousBefore)

    const candidateBinary = join(sandbox, 'candidate/Ark.app/Contents/MacOS/Ark')
    await mkdir(dirname(candidateBinary), { recursive: true })
    await compile(candidateBinary, ['/usr/lib/swift injected', '@loader_path'])
    await rejectsPolicy(
      buildScript,
      ['--check-candidate', join(sandbox, 'candidate/Ark.app')],
      /has unaudited RPATHs/,
    )

    const dependencyCandidate = join(sandbox, 'dependency-candidate/Ark.app/Contents/MacOS/Ark')
    await mkdir(dirname(dependencyCandidate), { recursive: true })
    await compile(dependencyCandidate)
    await execFileAsync('/usr/bin/install_name_tool', [
      '-change',
      '/usr/lib/libSystem.B.dylib',
      '@loader_path/evil.dylib',
      dependencyCandidate,
    ])
    await rejectsPolicy(
      buildScript,
      ['--check-candidate', join(sandbox, 'dependency-candidate/Ark.app')],
      /has unaudited dynamic dependencies/,
    )

    await compile(rejected, [
      '/usr/lib/swift',
      '@loader_path',
      toolchainRpath,
      join(sandbox, 'unaudited-runtime'),
    ])
    const rejectedBefore = await sha256(rejected)
    await rejectsPolicy(
      buildScript,
      ['--normalize-main-swift-rpaths', rejected],
      /has unaudited RPATHs/,
    )
    assert.equal(await sha256(rejected), rejectedBefore, 'rejected RPATH normalization changed the binary')
    assert.deepEqual(await readRpaths(rejected), [
      '/usr/lib/swift',
      '@loader_path',
      toolchainRpath,
      join(sandbox, 'unaudited-runtime'),
    ])

    for (const [name, replacement, pattern] of [
      [
        'developer-dependency',
        '/Library/Developer/CommandLineTools/usr/lib/libSystem.B.dylib',
        /retains build-machine dynamic dependencies/,
      ],
      ['malformed-system-dependency', '/usr/lib/libSystem (evil).dylib', /has unaudited dynamic dependencies/],
      ['loader-dependency', '@loader_path/evil.dylib', /has unaudited dynamic dependencies/],
      ['rpath-dependency', '@rpath/evil.dylib', /has unaudited dynamic dependencies/],
    ]) {
      const dependency = join(sandbox, name)
      await compile(dependency)
      await execFileAsync('/usr/bin/install_name_tool', [
        '-change',
        '/usr/lib/libSystem.B.dylib',
        replacement,
        dependency,
      ])
      const dependencyBefore = await sha256(dependency)
      await rejectsPolicy(
        buildScript,
        ['--normalize-main-swift-rpaths', dependency],
        pattern,
      )
      assert.equal(await sha256(dependency), dependencyBefore)
    }
  } finally {
    await rm(sandbox, { recursive: true, force: true })
  }
})
