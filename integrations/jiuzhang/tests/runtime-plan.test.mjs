import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createArkRuntimePlan } from '../src/runtime-plan.mjs'

const execFileAsync = promisify(execFile)
const repositoryRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const required = [
  '@deepseek-ai/dsh-deepseek-llm-api-extensions',
  '@deepseek-ai/dsh-host-plugin-inventory',
  '@deepseek-ai/dsh-native-api-runner',
  '@deepseek-ai/dsh-plugin-package-inventory-deepseek',
  '@deepseek-ai/dsh-session-log-deepseek',
  '@deepseek-ai/dsh-web-fetch-http',
]

test('current Ark runtime analysis maps its dedicated runner, security packages, and any forbidden reachability', async () => {
  const plan = await createArkRuntimePlan(repositoryRoot, { allowForbiddenAnalysis: true })
  const names = new Set(plan.packages.map(entry => entry.name))

  assert.deepEqual(plan.roots, ['@deepseek-ai/dsh-native-api-runner'])
  assert.equal(plan.target, 'macos-arm64')
  assert.equal(plan.version, 3)
  assert.deepEqual(plan.deferredPlatforms, ['win-x64'])
  assert.match(plan.sourceDigest, /^[a-f0-9]{64}$/)
  assert.match(plan.sourceIdentity.commit, /^[a-f0-9]{40}$/)
  assert.equal(plan.sourceIdentity.sourceSnapshotSha256, plan.sourceDigest)
  assert.match(plan.sourceIdentity.dirtyDiffSha256, /^[a-f0-9]{64}$/)
  assert.equal(plan.externalResolutions.length > 150, true)
  for (const input of [
    'pnpm-lock.yaml',
    'scripts/build-host-bundles.ts',
    'scripts/tsdown-host-package.config.ts',
    'tsdown.config.ts',
    'integrations/jiuzhang/src/pack-runtime.mjs',
    'integrations/jiuzhang/src/runtime-closure.mjs',
    'integrations/jiuzhang/native/build-app.sh',
  ]) {
    assert.ok(plan.repositoryInputs.some(entry => entry.path === input), `${input} must bind the source digest`)
  }
  assert.ok(plan.packages.every(entry => /^[a-f0-9]{64}$/u.test(entry.sourceSha256)))
  for (const name of required) assert.ok(names.has(name), `${name} must be in the current Ark closure plan`)
  assert.ok(names.has('@deepseek-ai/node-addon-landlock-run'), 'the portable Landlock seam remains in the closure')
  assert.equal(
    names.has('@deepseek-ai/dsh-sandbox-windows-acl'),
    false,
    'the macos-arm64 plan must omit the win32-only optional ACL backend',
  )
  assert.equal(names.has('@deepseek-ai/node-addon-landlock-run-linux-arm64'), false)
  assert.equal(names.has('@deepseek-ai/node-addon-landlock-run-linux-x64'), false)
  if (plan.forbiddenPackages.length === 0) {
    await assert.doesNotReject(createArkRuntimePlan(repositoryRoot))
  } else {
    assert.deepEqual(plan.forbiddenPackages, [
      '@deepseek-ai/dsh',
      '@deepseek-ai/dsh-headless',
    ])
    assert.ok(plan.forbiddenChains.every(chain => (
      chain.startsWith('@deepseek-ai/dsh-native-api-runner -> ')
      && chain.includes('@deepseek-ai/dsh-sdk-client')
    )))
    await assert.rejects(createArkRuntimePlan(repositoryRoot), /reaches forbidden packages/)
  }
})

test('plan-only pack writes an exact current-source closure receipt without building or packing', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'ark-runtime-plan-only-'))
  const output = join(parent, 'output')
  try {
    const analysis = await createArkRuntimePlan(repositoryRoot, { allowForbiddenAnalysis: true })
    const command = execFileAsync(process.execPath, [
      'integrations/jiuzhang/src/pack-runtime.mjs',
      '--out', output,
      '--plan-only',
    ], { cwd: repositoryRoot })
    if (analysis.forbiddenPackages.length > 0) {
      await assert.rejects(command, /reaches forbidden packages/)
    } else {
      const result = await command
      assert.match(result.stdout, /Ark current runtime plan:/)
      const plan = JSON.parse(await readFile(join(output, 'closure-plan.json'), 'utf8'))
      assert.match(plan.sourceDigest, /^[a-f0-9]{64}$/)
      assert.equal(plan.packlistsComplete, true)
      assert.ok(plan.packages.every(entry => entry.packlist.length > 0))
      const byName = new Map(plan.packages.map(entry => [entry.name, entry]))
      assert.ok(byName.get('@deepseek-ai/cordis').packlist.some(entry => entry.path === 'bin.js'))
      assert.ok(byName.get('@deepseek-ai/dsh-skill-badge').packlist.some(
        entry => entry.path === 'assets/dsh-badge.png',
      ))
      assert.ok(byName.get('@deepseek-ai/dsh-subprocess-local').packlist.some(
        entry => entry.path === 'scripts/ensure-spawn-helper.mjs',
      ))
      assert.ok(byName.get('@deepseek-ai/node-addon-landlock-run').sourceInputs.some(
        entry => entry.path === 'native/landlock-run/scripts/verify-entry-lib.mjs',
      ))
      assert.ok(byName.get('@deepseek-ai/dsh-native-api-runner').packlist.some(
        entry => entry.path === 'lib/bin.js',
      ))
      assert.match(plan.rootLockSha256, /^[a-f0-9]{64}$/)
      assert.equal(plan.externalResolutions.length > 150, true)
      assert.ok(plan.requiredFiles.some(entry => entry.path === 'jiuzhang/profile/forbidden-runtime-packages.json'))
      assert.ok(plan.requiredFiles.some(entry => entry.path === 'jiuzhang/profile/runtime-identity-policy.json'))
    }
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
})

test('runtime pack has one pinned offline lock/install owner and atomically publishes only a sealed runtime', async () => {
  const source = await readFile(join(repositoryRoot, 'integrations/jiuzhang/src/pack-runtime.mjs'), 'utf8')
  assert.match(source, /const lockCommand = \['pnpm', 'install', '--lockfile-only', '--offline', '--ignore-scripts'\]/u)
  assert.match(source, /const installCommand = \['pnpm', 'install', '--offline', '--frozen-lockfile'\]/u)
  assert.match(source, /actualPackageManagerVersion !== packageManagerVersion/u)
  assert.match(source, /lockfileAfterInstall !== lockfileBeforeInstall/u)
  assert.match(source, /createArkRuntimeManifest\(runtimeTemplate/u)
  assert.match(source, /exactExternalOverrides\(plan\)/u)
  assert.match(source, /root-lock-exact-resolutions/u)
  assert.match(source, /verifyArkPackReceipt\(runtimeTemplate/u)
  assert.ok(source.indexOf('await copyFile(receiptPath') < source.indexOf('await rename(staging, destination)'))
  assert.match(source, /await rm\(staging, \{ recursive: true, force: true \}\)/u)
})
