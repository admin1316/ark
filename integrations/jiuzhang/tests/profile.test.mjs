import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { JSON_SCHEMA, load, Type } from 'js-yaml'

// The Loader's YAML dialect round-trips `!!js` scalars as expression nodes
// it evaluates at entry activation; the profile test parses with the same
// tag so the patch stays readable and the platform-selected values are
// assertable.
const jsExpression = new Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data) => typeof data === 'string',
  construct: (data) => ({ __jsExpr: data }),
})
const loaderYAML = JSON_SCHEMA.extend(jsExpression)

/** Evaluate a loader `!!js` expression node (plain values pass through). */
function evalJsExpr(node) {
  return typeof node === 'object' && node !== null && '__jsExpr' in node
    ? Function(`"use strict"; return (${node.__jsExpr})`)()
    : node
}

const integrationRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const profileRoot = join(integrationRoot, 'profile')
const nativeApiBundlePatch = join(integrationRoot, '../../packages/bundle/native-api-app/cordis.patch.yml')
const sharedPresetRoot = join(integrationRoot, '../../packages/boot/profile-runner/config/agent-presets')
const cliPresetRoot = join(integrationRoot, '../../apps/cli/config/agent-presets')

test('the jiuzhang profile composes only the base and native API bundles', async () => {
  const manifest = JSON.parse(await readFile(join(profileRoot, 'package.json'), 'utf8'))
  assert.deepEqual(manifest.dsh.profile.bundles, [
    '@deepseek-ai/dsh-base',
    '@deepseek-ai/dsh-native-api-app',
  ])
})

test('the standalone runtime admits only reviewed dependency build scripts', async () => {
  const workspace = load(await readFile(join(profileRoot, 'pnpm-workspace.yaml'), 'utf8'))
  assert.deepEqual(workspace.allowBuilds, {
    '@deepseek-ai/dsh-subprocess-local@__ARK_SUBPROCESS_LOCAL_SPEC__': true,
    '@google/genai': false,
    koffi: true,
    'node-pty': true,
    'node-addon-require-builtin': false,
    protobufjs: false,
    'tesseract.js': false,
  })
})

test('the native API bundle owns API-only transport without browser rows or frontend assets', async () => {
  const layers = load(await readFile(nativeApiBundlePatch, 'utf8'), { schema: loaderYAML })
  assert.ok(Array.isArray(layers))
  const rows = layers.flatMap(layer => layer.insert ?? [])
  const byId = new Map(rows.map(row => [row.id, row]))
  assert.equal(byId.get('webserver')?.config?.apiOnly, true)
  assert.equal(byId.get('webserver')?.config?.port?.__jsExpr, 'ctx.nativeApiStartup.port ?? 0')
  assert.equal(byId.get('host-connection')?.name, '@deepseek-ai/dsh-host-connection')
  assert.equal(byId.get('code-runtime')?.name, '@deepseek-ai/dsh-code-runtime-worker-thread')
  assert.deepEqual(byId.get('host-connection')?.config?.trustedHosts, [])
  assert.equal(byId.get('native-api-runtime')?.name, '@deepseek-ai/dsh-native-api-app')
  assert.equal(rows.some(row => row.name === '@deepseek-ai/dsh-web-app'), false)
  assert.equal(rows.some(row => row.name === '@deepseek-ai/dsh-host-frontend-static'), false)
  assert.equal(rows.some(row => row.name?.startsWith('@deepseek-ai/dsh-client-')), false)
})

test('Ark exposes only shared standard, code, and minimal presets', async () => {
  const directoryNames = async root => (await readdir(root, { withFileTypes: true }))
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort()
  assert.deepEqual(await directoryNames(sharedPresetRoot), ['code', 'minimal', 'standard'])
  assert.deepEqual(await directoryNames(cliPresetRoot), ['cordis'])
})

test('the jiuzhang profile disables telemetry and persistent sqlite', async () => {
  const rows = load(await readFile(join(profileRoot, 'cordis.patch.yml'), 'utf8'), { schema: loaderYAML })
  assert.ok(Array.isArray(rows))
  const byId = new Map(rows.map(row => [row.id, row]))
  assert.equal(byId.get('agent-presets')?.config?.default, 'standard')
  assert.equal(byId.get('agent-presets')?.config?.includeShippedRoot, false, 'launcher-owned Native presets must not be shadowed')
  assert.deepEqual(byId.get('agent-presets')?.config?.reservedIds, ['jiuzhang'])
  assert.equal(byId.get('session-telemetry-otel')?.disabled, true)
  assert.equal(byId.has('webserver'), false, 'the API bundle retains the --port startup expression')
  assert.deepEqual(byId.get('session-query-sqlite')?.config, {
    path: ':memory:',
    openAt: 'never',
  })
  // Ark defaults credentials to the macOS login Keychain; non-macOS dev/CI
  // compositions keep the file-backed mode.
  assert.equal(
    evalJsExpr(byId.get('credentials')?.config?.mode),
    process.platform === 'darwin' ? 'keychain' : 'file',
  )
})

test('the profile provides the Ark persona and safety rules outside any preset', async () => {
  const rows = load(
    await readFile(join(profileRoot, 'cordis.patch.yml'), 'utf8'),
    { schema: loaderYAML },
  )
  const prompt = rows.find(row => row.id === 'system-prompt')
  assert.ok(prompt, 'profile patch defines the system-prompt row')
  assert.match(prompt.config.persona, /你是 Ark/)
  assert.match(prompt.config.persona, /不得声称已经采集、学习、训练/)
})

test('the integration contains no database, pdf, or legacy Ark references', async () => {
  const files = await listFiles(integrationRoot)
  assert.equal(files.some(path => /\.(?:db|sqlite3?|pdf)$/i.test(path)), false)
  for (const path of files.filter(path => !path.includes('/tests/'))) {
    const body = await readFile(path, 'utf8')
    const forbidden = new RegExp(['industry', 'brain|Some-Many-Books|ark\\.db'].join('-'), 'i')
    assert.doesNotMatch(body, forbidden)
  }
})

// Build output directories are not product surface: a Swift scratch build
// (native/.build) contains its own build.db and must not be read as a
// product database.
const BUILD_OUTPUT_DIRS = new Set(['.build', 'node_modules'])

async function listFiles(root) {
  const found = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory() && BUILD_OUTPUT_DIRS.has(entry.name)) continue
    const path = join(root, entry.name)
    if (entry.isDirectory()) found.push(...await listFiles(path))
    else if (entry.isFile()) found.push(path)
  }
  return found
}
