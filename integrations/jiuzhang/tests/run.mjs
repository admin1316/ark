import { execFile } from 'node:child_process'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { arkTestInventory, verifyArkTestInventory } from './helpers/test-inventory.mjs'

const execFileAsync = promisify(execFile)
const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const nativeRoot = join(root, 'integrations/jiuzhang/native')
const options = new Set(process.argv.slice(2))
for (const option of options) {
  if (!['--node-only', '--inventory-only'].includes(option)) throw new Error(`unknown Ark test option: ${option}`)
}
const inventory = await verifyArkTestInventory(join(root, 'integrations/jiuzhang/tests'))
console.log(`Ark test inventory: ${inventory.registered} registered (${inventory.portable} portable, ${inventory.macos} macOS-only)`)
if (options.has('--inventory-only')) process.exit(0)
const tests = [
  ...arkTestInventory.portable,
  ...(process.platform === 'darwin' ? arkTestInventory.macos : []),
].map(file => `integrations/jiuzhang/tests/${file}`)

try {
  const nodeResult = await execFileAsync(process.execPath, [
    '--import',
    'tsx',
    '--test',
    '--test-concurrency=2',
    ...tests,
  ], { cwd: root, maxBuffer: 20_000_000 })
  process.stdout.write(nodeResult.stdout)
} catch (error) {
  if (error.stdout) process.stdout.write(error.stdout)
  if (error.stderr) process.stderr.write(error.stderr)
  throw new Error('Ark registered Node tests failed; see the test output above')
}

if (process.platform === 'darwin' && !options.has('--node-only')) {
  const moduleCache = await mkdtemp(join(tmpdir(), 'ark-jiuzhang-swift-modules-'))
  const scratchPath = await mkdtemp(join(tmpdir(), 'ark-jiuzhang-swift-build-'))
  const swiftEnvironment = {
    ...process.env,
    CLANG_MODULE_CACHE_PATH: moduleCache,
    SWIFTPM_MODULECACHE_OVERRIDE: moduleCache,
  }
  try {
    await execFileAsync('swift', [
      'build',
      '--disable-sandbox',
      '--package-path', nativeRoot,
      '--scratch-path', scratchPath,
      '--configuration', 'debug',
      '--product', 'JiuzhangShellContractTests',
      '-Xswiftc', '-enable-testing',
    ], { cwd: root, env: swiftEnvironment, maxBuffer: 40_000_000 })
    const { stdout } = await execFileAsync('swift', [
      'build',
      '--disable-sandbox',
      '--package-path', nativeRoot,
      '--scratch-path', scratchPath,
      '--configuration', 'debug',
      '--show-bin-path',
    ], { cwd: root, env: swiftEnvironment })
    const contract = join(stdout.trim(), 'JiuzhangShellContractTests')
    await access(contract)
    const result = await execFileAsync(contract, [], { cwd: nativeRoot, maxBuffer: 40_000_000 })
    process.stdout.write(result.stdout)
  } finally {
    await rm(moduleCache, { recursive: true, force: true })
    await rm(scratchPath, { recursive: true, force: true })
  }
}
