import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { nativeConfigurationModules, nativeEndpointCoverage, nativePackageEntries, verifyNativeGeneratedImports } from '../src/build-native.mjs'
import { createArkRuntimePlan } from '../src/runtime-plan.mjs'

async function fixture(files, outDir = 'lib/types') {
  const root = await mkdtemp(join(tmpdir(), 'ark-native-source-'))
  await mkdir(join(root, 'src'))
  for (const file of files) await writeFile(join(root, 'src', file), 'export const value = 1\n')
  const config = join(root, 'tsconfig.json')
  await writeFile(config, JSON.stringify({
    compilerOptions: { target: 'es2024', module: 'esnext', declaration: true, composite: true, rootDir: 'src', outDir },
    include: ['src'],
  }))
  return { root, config, dispose: () => rm(root, { recursive: true, force: true }) }
}

test('native bundling derives renamed CJS workers from the published declaration mapping', async () => {
  const f = await fixture(['index.ts', 'dialog-worker.ts'])
  try {
    const entries = nativePackageEntries(f.root, {
      name: '@fixture/native', main: 'lib/index.js', types: 'lib/types/index.d.ts', files: ['lib/types-*.js'],
      exports: { './worker': { types: './lib/types/dialog-worker.d.ts', default: './lib/worker.cjs' } },
    }, f.config)
    assert.deepEqual(entries.map(entry => [entry.input.slice(f.root.length + 1), entry.output.slice(f.root.length + 1)]), [
      ['lib/types/index.js', 'lib/index.js'], ['lib/types/dialog-worker.js', 'lib/worker.cjs'],
    ])
  } finally { await f.dispose() }
})

test('native bundling rejects retained artifacts with no compilable source', async () => {
  const f = await fixture([])
  try {
    await mkdir(join(f.root, 'lib'))
    await writeFile(join(f.root, 'lib/index.js'), 'export const stale = true\n')
    assert.throws(() => nativePackageEntries(f.root, { name: '@fixture/stale', main: 'lib/index.js' }, f.config), /cannot parse|no compilable/)
  } finally { await f.dispose() }
})

test('a stale worker file cannot replace its missing source mapping', async () => {
  const f = await fixture(['index.ts'])
  try {
    await mkdir(join(f.root, 'lib'))
    await writeFile(join(f.root, 'lib/worker.cjs'), 'module.exports = {}\n')
    assert.throws(() => nativePackageEntries(f.root, {
      name: '@fixture/stale-worker', exports: { './worker': { types: './lib/types/missing.d.ts', default: './lib/worker.cjs' } },
    }, f.config), /no current-source implementation/)
  } finally { await f.dispose() }
})

test('direct tsc outputs remain explicit source-backed entries', async () => {
  const f = await fixture(['index.ts'], 'lib')
  try {
    const [entry] = nativePackageEntries(f.root, { name: '@fixture/direct', main: 'lib/index.js', types: 'lib/index.d.ts' }, f.config)
    assert.equal(entry.passthrough, true)
    assert.equal(entry.source, join(f.root, 'src/index.ts'))
  } finally { await f.dispose() }
})

test('native compilation refuses output outside the package-owned lib directory', async () => {
  const f = await fixture(['index.ts'], '../outside')
  try {
    assert.throws(() => nativePackageEntries(f.root, { name: '@fixture/escape', main: 'lib/index.js' }, f.config), /output escapes/)
  } finally { await f.dispose() }
})

test('native configuration audit follows grouped literal plugins and omits explicitly disabled rows', () => {
  assert.deepEqual(nativeConfigurationModules([{ insert: [
    { name: '@deepseek-ai/dsh-parent', config: [{ name: '@deepseek-ai/dsh-child/entry' }] },
    { name: '@deepseek-ai/dsh-disabled', disabled: true },
    { name: 'cordis:group', config: [{ name: '@deepseek-ai/dsh-child/entry' }] },
  ] }]), ['@deepseek-ai/dsh-child', '@deepseek-ai/dsh-parent'])
})

test('compiler-only input planning cannot certify built packages or packlists', async () => {
  for (const option of [{ requireBuilt: true }, { verifyPacklists: true }]) {
    await assert.rejects(createArkRuntimePlan('/unopened-fixture', { sourceOnly: true, ...option }), /cannot attest/)
  }
})

test('native compiler identity excludes retained lib inputs while package identity retains them', async () => {
  const root = new URL('../../..', import.meta.url).pathname
  const source = await createArkRuntimePlan(root, { sourceOnly: true })
const artifact = await createArkRuntimePlan(root)
  assert.equal(source.inputPlane, 'source')
  assert.equal(artifact.inputPlane, 'package')
  assert.deepEqual(source.packages.map(pkg => pkg.name), artifact.packages.map(pkg => pkg.name))
  assert.ok(source.packages.every(pkg => pkg.sourceInputs.every(input => !input.path.startsWith(`${pkg.directory}/lib/`))))
  assert.ok(artifact.packages.some(pkg => pkg.sourceInputs.some(input => input.path.startsWith(`${pkg.directory}/lib/`))))
  assert.notEqual(source.sourceDigest, artifact.sourceDigest)
})

test('native endpoint acceptance rejects missing, duplicate, wrong-owner and non-strict descriptors', () => {
  const descriptor = { namespace: 'settings', method: 'describe', service: 'settings', result: { mode: 'strict' } }
  const endpoints = ['settings/describe', 'settings/mutate']
  const owners = { 'settings/describe': 'settings', 'settings/mutate': 'settings' }
  assert.deepEqual(nativeEndpointCoverage([descriptor], endpoints, owners).missing, ['settings/mutate'])
  const invalid = { ...descriptor, service: 'other', result: { mode: 'unchecked' } }
  const result = nativeEndpointCoverage([descriptor, invalid], endpoints, owners)
  assert.deepEqual(result.wrongOwners, ['settings/describe'])
  assert.deepEqual(result.nonStrict, ['settings/describe'])
  assert.deepEqual(result.duplicates, ['settings/describe'])
  const complete = nativeEndpointCoverage([descriptor, { ...descriptor, method: 'mutate' }], endpoints, owners)
  assert.equal(complete.covered, 2)
  for (const errors of [complete.missing, complete.wrongOwners, complete.nonStrict, complete.duplicates]) assert.deepEqual(errors, [])
})

test('native reflection cannot introduce undeclared runtime dependencies', () => {
  const source = "import { z } from 'zod'\nimport { readFile } from 'node:fs'\nimport './local.js'"
  assert.throws(() => verifyNativeGeneratedImports(source, { name: '@fixture/native', devDependencies: { zod: '*' } }), /undeclared.*zod/)
  assert.doesNotThrow(() => verifyNativeGeneratedImports(source, { name: '@fixture/native', dependencies: { zod: '^4.4.3' } }))
  assert.doesNotThrow(() => verifyNativeGeneratedImports("import { x } from '@fixture/domain/types'", {
    name: '@fixture/native', peerDependencies: { '@fixture/domain': '*' },
  }))
})
