import { execFile } from 'node:child_process'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const nativeRoot = join(root, 'integrations/jiuzhang/native')

const nodeResult = await execFileAsync(process.execPath, [
  '--import',
  'tsx',
  '--test',
  'integrations/jiuzhang/tests/deepseek-extension-acceptance.test.ts',
  'integrations/jiuzhang/tests/profile.test.mjs',
  'integrations/jiuzhang/tests/runtime.test.mjs',
  'integrations/jiuzhang/tests/candidate-data.test.mjs',
  'integrations/jiuzhang/tests/runtime-closure.test.mjs',
  'integrations/jiuzhang/tests/runtime-plan.test.mjs',
  'integrations/jiuzhang/tests/native-only.test.mjs',
  'integrations/jiuzhang/tests/native-artifact-safety.test.mjs',
  'integrations/jiuzhang/tests/lifecycle.test.mjs',
], { cwd: root, maxBuffer: 20_000_000 })
process.stdout.write(nodeResult.stdout)

if (process.platform === 'darwin') {
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
