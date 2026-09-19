import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const scriptPath = fileURLToPath(new URL('./prepare-ci-bubblewrap.sh', import.meta.url))

/** One controlled preparation scenario; the doubles read it from disk. */
interface Scenario {
  platform: { system: string; machine: string }
  /** Per-asset download outcome: the tarball and its `.sha256sum` sibling. */
  assets: Record<'tarball' | 'checksum', 'serve' | 'http404' | 'network' | 'html'>
  /** Digest comparison outcome; `undefined` keeps the double's real comparison. */
  digest?: 'match' | 'mismatch' | 'real'
  /** Digest the served checksum asset carries. */
  checksumDigest?: string
  checksumAssetRaw?: string
  digestMode?: never
  payloadBytes?: number
  /** Whether `tar` produces the expected source tree. */
  sourceTree?: 'present' | 'absent'
  sourceVersion?: string
  binaryVersion?: string
  binaryMode?: string
  fileCapabilities?: string
  aptExit?: number
  mesonSetupExit?: number
  mesonCompileExit?: number
  versionExit?: number
  namespaceExit?: number
  probeMode?: 'ok' | 'writable' | 'noscript' | 'wrong-error'
  /** Upstream adapter outcome for the reviewed security regressions. */
  upstream?: 'pass' | 'fail' | 'skipped'
  /** How the adapter double answers the two negative-control invocations. */
  controls?: 'reject' | 'accept-ok' | 'accept-fail'
  /** Runner kind; only the disposable hosted runner may install packages. */
  environment?: 'github-hosted' | 'self-hosted'
}

const quote = (value: string): string => `'${value.replaceAll('\'', '\\' + '\'')}'`

const workspaces: string[] = []

afterEach(() => {
  for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true })
})
const shimSource = String.raw`#!/usr/bin/env node
// Command double for scripts/prepare-ci-bubblewrap.spec.ts. It keeps the real
// command-line contract of each tool it stands in for (flags, stdout/stderr,
// exit codes) so the spec drives the production script's control flow instead of
// reimplementing it. The built binary the script produces is itself a call back
// into this double, so the probes are scenario-controlled too.
import { createHash } from 'node:crypto'
import { appendFileSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'

const command = process.argv[2] ?? ''
const args = process.argv.slice(3)
const scenario = JSON.parse(readFileSync(process.env.SPEC_SCENARIO, 'utf8'))
const log = (entry) => appendFileSync(process.env.SPEC_LOG, JSON.stringify(entry) + '\n')
const digest = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

const optionValue = (name) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] ?? '' : ''
}

const positional = () => {
  const valueFlags = ['--output', '--connect-timeout', '--max-time', '-C', '-c', '-xf']
  const found = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (valueFlags.includes(arg)) {
      index += 1
      continue
    }
    if (arg.startsWith('-')) continue
    found.push(arg)
  }
  return found
}

if (command === 'uname') {
  process.stdout.write((args.includes('-m') ? scenario.platform.machine : scenario.platform.system) + '\n')
  process.exit(0)
}

if (command === 'sysctl') process.exit(0)

if (command === 'sudo') {
  const result = spawnSync(args[0], args.slice(1), { stdio: 'inherit' })
  process.exit(result.status ?? 1)
}

if (command === 'apt-get') {
  log({ command: 'apt-get' })
  process.exit(scenario.aptExit ?? 0)
}

if (command === 'curl') {
  const output = optionValue('--output')
  const url = positional()[0] ?? ''
  const asset = url.endsWith('.sha256sum') ? 'checksum' : 'tarball'
  const mode = scenario.assets[asset]
  log({ command: 'curl', asset, mode, url })
  if (mode === 'http404') {
    process.stderr.write('curl: (22) The requested URL returned error: 404\n')
    process.exit(22)
  }
  if (mode === 'network') {
    process.stderr.write('curl: (56) Recv failure: Connection reset by peer\n')
    process.exit(56)
  }
  if (mode === 'html') {
    writeFileSync(output, '<!DOCTYPE HTML PUBLIC "-//IETF//DTD HTML 2.0//EN"><html><head><title>404 Not Found</title></head></html>')
    process.exit(0)
  }
  if (asset === 'checksum') {
    // Mirrors the release's checksum asset: the digest line names the tarball.
    const value = scenario.checksumDigest ?? '9760d007363e3abba7c747489910f9f82d9fca53ba3bd3282e396fa3c97a3314'
    writeFileSync(output, scenario.checksumAssetRaw ?? value + ' *bubblewrap-0.12.0.tar.xz\n')
    process.exit(0)
  }
  // The real release bytes are not available offline, so the served fixture is a
  // deterministic buffer; digest outcomes are declared per scenario because no
  // fixture can reproduce the published archive value.
  writeFileSync(output, Buffer.alloc(scenario.payloadBytes ?? 126452, 0x62))
  process.exit(0)
}

if (command === 'sha256sum') {
  if (!args.includes('--check')) {
    for (const file of args) process.stdout.write(digest(file) + '  ' + file + '\n')
    process.exit(0)
  }
  const lines = readFileSync(0, 'utf8').split('\n').filter(line => line.trim().length > 0)
  const compared = lines.every((line) => {
    const [expected, file] = line.trim().split(/\s+/)
    return digest(file) === expected
  })
  log({ command: 'sha256sum', check: true, lines: lines.length, compared })
  if (scenario.digest === 'match') process.exit(0)
  if (scenario.digest === 'mismatch') process.exit(1)
  // 'real' (or absent) keeps the genuine comparison, so a served fixture that is
  // not the published release can never pass.
  process.exit(compared ? 0 : 1)
}

if (command === 'tar') {
  const target = optionValue('-C')
  log({ command: 'tar', target })
  if (scenario.sourceTree === 'absent') process.exit(0)
  const root = join(target, 'bubblewrap-0.12.0')
  mkdirSync(root, { recursive: true })
  const version = scenario.sourceVersion ?? '0.12.0'
  writeFileSync(join(root, 'meson.build'), "project(\n  'bubblewrap',\n  'c',\n  version : '" + version + "',\n  meson_version : '>=0.49.0',\n)\n")
  process.exit(0)
}

if (command === 'meson') {
  if (args[0] === 'setup') {
    log({ command: 'meson-setup' })
    process.exit(scenario.mesonSetupExit ?? 0)
  }
  if (args[0] === 'compile') {
    const buildDir = optionValue('-C')
    log({ command: 'meson-compile', buildDir })
    if (scenario.mesonCompileExit ?? 0 !== 0) process.exit(scenario.mesonCompileExit ?? 1)
    mkdirSync(buildDir, { recursive: true })
    const binary = join(buildDir, 'bwrap')
    writeFileSync(binary, '#!/bin/sh\nexec "' + process.env.SPEC_NODE + '" "' + process.env.SPEC_DOUBLE + '" bwrap "$@"\n', { mode: 0o755 })
    chmodSync(binary, scenario.binaryMode ? Number.parseInt(scenario.binaryMode, 8) : 0o755)
    process.exit(0)
  }
  process.exit(2)
}

if (command === 'stat') {
  process.stdout.write((scenario.binaryMode ?? '755') + '\n')
  process.exit(0)
}

if (command === 'getcap') {
  process.stdout.write(scenario.fileCapabilities ?? '')
  process.exit(0)
}

if (command === 'python3') {
  const bwrap = optionValue('--bwrap')
  if (bwrap.includes('always-ok-bwrap')) {
    log({ command: 'python3', control: 'always-ok' })
    process.exit(scenario.controls === 'accept-ok' ? 0 : 1)
  }
  if (bwrap.includes('always-fail-bwrap')) {
    log({ command: 'python3', control: 'always-fail' })
    process.exit(scenario.controls === 'accept-fail' ? 0 : 1)
  }
  const mode = scenario.upstream ?? 'pass'
  log({ command: 'python3', upstream: mode })
  if (mode === 'pass') {
    process.stdout.write('upstream-security: testsRun=2 failures=0 errors=0 skipped=0 selected=2\nupstream-security: passed\n')
    process.exit(0)
  }
  if (mode === 'skipped') {
    process.stdout.write('upstream-security: testsRun=2 failures=0 errors=0 skipped=2 selected=2\n')
    process.exit(1)
  }
  process.stdout.write('upstream-security: testsRun=2 failures=1 errors=0 skipped=0 selected=2\n')
  process.exit(1)
}

if (command === 'bwrap') {
  if (args.includes('--version')) {
    process.stdout.write('bubblewrap ' + (scenario.binaryVersion ?? '0.12.0') + '\n')
    process.exit(scenario.versionExit ?? 0)
  }
  const joined = args.join(' ')
  if (joined.includes('inner.txt')) {
    log({ command: 'bwrap', probe: 'readonly' })
    if (scenario.probeMode === 'noscript') process.exit(1)
    if (scenario.probeMode === 'writable') process.exit(0)
    process.stdout.write('inner-started\n')
    const message = scenario.probeMode === 'wrong-error' ? 'bwrap: no such file or directory\n' : 'printf: /tmp/inner.txt: Read-only file system\n'
    process.stderr.write(message)
    process.exit(1)
  }
  log({ command: 'bwrap', probe: 'namespace' })
  process.stdout.write('nested-ok\n')
  process.exit(scenario.namespaceExit ?? 0)
}

process.stderr.write('unexpected double: ' + command + '\n')
process.exit(127)`

interface PrepareCall {
  command: string
  asset?: string
  mode?: string
  probe?: string
  compared?: boolean
}

interface PrepareRun {
  status: number | null
  stdout: string
  stderr: string
  githubPath: string
  calls: PrepareCall[]
  runner: string
  publishedPath: string
}

function runPrepare(overrides: Partial<Scenario> = {}, seed?: (runner: string) => void): PrepareRun {
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-bwrap-spec-'))
  workspaces.push(workspace)
  const bin = join(workspace, 'bin')
  const runner = join(workspace, 'runner')
  const githubPath = join(workspace, 'github-path')
  mkdirSync(bin, { recursive: true })
  mkdirSync(runner, { recursive: true })
  const doublePath = join(bin, 'command-double.mjs')
  writeFileSync(doublePath, shimSource, { mode: 0o755 })
  // Node resolves a shebang symlink to its real path, so each command gets a
  // one-line wrapper that names the double and passes the command on.
  for (const command of ['uname', 'sysctl', 'sudo', 'apt-get', 'curl', 'sha256sum', 'tar', 'meson', 'stat', 'getcap', 'bwrap', 'python3']) {
    const wrapper = join(bin, command)
    writeFileSync(wrapper, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(doublePath)} ${command} "$@"\n`, { mode: 0o755 })
  }
  writeFileSync(githubPath, '')
  seed?.(runner)
  const scenario: Scenario = {
    platform: { system: 'Linux', machine: 'x86_64' },
    assets: { tarball: 'serve', checksum: 'serve' },
    digest: 'match',
    payloadBytes: 126_452,
    sourceTree: 'present',
    sourceVersion: '0.12.0',
    binaryVersion: '0.12.0',
    binaryMode: '755',
    probeMode: 'ok',
    upstream: 'pass',
    controls: 'reject',
    ...overrides,
  }
  const scenarioPath = join(workspace, 'scenario.json')
  const scenarioEnvironment = scenario.environment ?? 'github-hosted'
  const logPath = join(workspace, 'calls.jsonl')
  writeFileSync(scenarioPath, JSON.stringify(scenario))
  writeFileSync(logPath, '')
  const result = spawnSync('bash', [scriptPath], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      RUNNER_TEMP: runner,
      GITHUB_PATH: githubPath,
      // The package-installation branch is authorized only on the disposable
      // hosted runner; the spec simulates that environment.
      RUNNER_ENVIRONMENT: scenarioEnvironment,
      SPEC_SCENARIO: scenarioPath,
      SPEC_LOG: logPath,
      SPEC_NODE: process.execPath,
      SPEC_DOUBLE: doublePath,
    },
  })
  const calls: PrepareCall[] = readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(line => line.length > 0)
    .map(line => JSON.parse(line) as PrepareCall)
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    githubPath: readFileSync(githubPath, 'utf8'),
    calls,
    runner,
    publishedPath: join(runner, 'dsh-bubblewrap', 'usr', 'bin', 'bwrap'),
  }
}

// Platform mapping. The build-flow suite below drives a POSIX shell script and
// its command doubles, so it runs on POSIX hosts only. Windows keeps its own
// case: the script must refuse a non-Linux host without invoking a package
// manager or publishing an unverified tool path to later steps.
describe.skipIf(process.platform === 'win32')('prepare-ci-bubblewrap', () => {
  it('builds the pinned release from source and publishes a probe-tested binary', () => {
    const run = runPrepare()
    expect(run.status, run.stderr).toBe(0)
    expect(run.githubPath).toBe(`${run.runner}/dsh-bubblewrap/usr/bin\n`)
    expect(existsSync(run.publishedPath)).toBe(true)
    expect(run.stderr).toContain('verified bubblewrap-0.12.0.tar.xz sha256=9760d007')
    expect(run.stdout).toContain('bubblewrap 0.12.0 built from source')
    expect(run.stdout).toContain('binary_sha256=')
    expect(run.stdout).toContain('bubblewrap functional probe passed')
    expect(run.stdout).toContain('upstream-security: testsRun=2 failures=0 errors=0 skipped=0')
    expect(run.stdout).toContain('bubblewrap CVE-2026-87766 upstream security regressions passed')
    expect(run.calls.map(call => call.command)).toEqual(expect.arrayContaining(['curl', 'apt-get', 'meson-setup', 'meson-compile', 'bwrap']))
  }, 30_000)

  it('bounds retries on a transient failure and refuses a withdrawn asset at once', () => {
    const flaky = runPrepare({ assets: { tarball: 'network', checksum: 'serve' } })
    expect(flaky.status, flaky.stderr).not.toBe(0)
    expect(flaky.calls.filter(call => call.command === 'curl' && call.asset === 'tarball')).toHaveLength(2)
    expect(flaky.githubPath).toBe('')
    const withdrawn = runPrepare({ assets: { tarball: 'http404', checksum: 'serve' } })
    expect(withdrawn.status, withdrawn.stderr).not.toBe(0)
    expect(withdrawn.calls.filter(call => call.command === 'curl' && call.asset === 'tarball')).toHaveLength(1)
    expect(withdrawn.stderr).toContain('the pinned source is unavailable')
  }, 30_000)

  it('rejects tampered bytes before any build step', () => {
    const html = runPrepare({ assets: { tarball: 'html', checksum: 'serve' }, digest: 'real' })
    expect(html.status, html.stderr).not.toBe(0)
    expect(html.stderr).toContain('source tarball digest does not match the pinned release value')
    const mismatch = runPrepare({ digest: 'mismatch' })
    expect(mismatch.status, mismatch.stderr).not.toBe(0)
    expect(mismatch.stderr).toContain('source tarball digest does not match the pinned release value')
    for (const run of [html, mismatch]) {
      expect(run.githubPath).toBe('')
      expect(run.calls.some(call => call.command === 'meson-setup')).toBe(false)
      expect(existsSync(run.publishedPath)).toBe(false)
    }
  }, 30_000)

  it('rejects a checksum asset that does not describe the pinned tarball', () => {
    const wrongName = runPrepare({ checksumAssetRaw: `${'0'.repeat(64)} *another-file.tar.xz\n`, digest: 'match' })
    expect(wrongName.status, wrongName.stderr).not.toBe(0)
    expect(wrongName.stderr).toContain('checksum asset does not describe the pinned tarball')
    const wrongDigest = runPrepare({ checksumDigest: '0'.repeat(64), digest: 'match' })
    expect(wrongDigest.status, wrongDigest.stderr).not.toBe(0)
    expect(wrongDigest.stderr).toContain('checksum asset carries a different digest')
    for (const run of [wrongName, wrongDigest]) expect(run.githubPath).toBe('')
  }, 30_000)

  it('rejects a source tree that is not the pinned release', () => {
    const absent = runPrepare({ sourceTree: 'absent' })
    expect(absent.status, absent.stderr).not.toBe(0)
    expect(absent.stderr).toContain('the source tree has no meson.build')
    const wrong = runPrepare({ sourceVersion: '0.11.2' })
    expect(wrong.status, wrong.stderr).not.toBe(0)
    expect(wrong.stderr).toContain('is not bubblewrap 0.12.0')
    for (const run of [absent, wrong]) {
      expect(run.githubPath).toBe('')
      expect(run.calls.some(call => call.command === 'meson-setup')).toBe(false)
    }
  }, 30_000)

  it('stops when the build itself fails', () => {
    const setup = runPrepare({ mesonSetupExit: 1 })
    expect(setup.status, setup.stderr).not.toBe(0)
    expect(setup.githubPath).toBe('')
    const compile = runPrepare({ mesonCompileExit: 2 })
    expect(compile.status, compile.stderr).not.toBe(0)
    expect(compile.githubPath).toBe('')
    expect(existsSync(compile.publishedPath)).toBe(false)
  }, 30_000)

  it('refuses a binary that is not the pinned version', () => {
    const run = runPrepare({ binaryVersion: '0.11.2' })
    expect(run.status, run.stderr).not.toBe(0)
    expect(run.stderr).toContain('unexpected version string: bubblewrap 0.11.2')
    expect(run.githubPath).toBe('')
  }, 30_000)

  it('refuses a setuid binary or one carrying file capabilities', () => {
    const setuid = runPrepare({ binaryMode: '4755' })
    expect(setuid.status, setuid.stderr).not.toBe(0)
    expect(setuid.stderr).toContain('refusing a setuid binary')
    const capabilities = runPrepare({ fileCapabilities: '/tmp/bwrap cap_net_admin=ep' })
    expect(capabilities.status, capabilities.stderr).not.toBe(0)
    expect(capabilities.stderr).toContain('refusing a binary with file capabilities')
    for (const run of [setuid, capabilities]) expect(run.githubPath).toBe('')
  }, 30_000)

  it('fails when the namespace probe does not run or the read-only bind is writable', () => {
    const namespace = runPrepare({ namespaceExit: 1 })
    expect(namespace.status, namespace.stderr).not.toBe(0)
    const writable = runPrepare({ probeMode: 'writable' })
    expect(writable.status, writable.stderr).not.toBe(0)
    expect(writable.stderr).toContain('the read-only bind was writable inside the sandbox')
    const noscript = runPrepare({ probeMode: 'noscript' })
    expect(noscript.status, noscript.stderr).not.toBe(0)
    expect(noscript.stderr).toContain('the sandboxed command never started')
    const wrongError = runPrepare({ probeMode: 'wrong-error' })
    expect(wrongError.status, wrongError.stderr).not.toBe(0)
    expect(wrongError.stderr).toContain('the refusal did not come from the read-only bind')
    for (const run of [namespace, writable, noscript, wrongError]) expect(run.githubPath).toBe('')
  }, 30_000)

  it('fails the CVE-2026-87766 regression when the tool cannot defend anything', () => {
    // The negative controls prove the gate discriminates: an always-successful
    // tool must trip the refusal assertion, and a tool that never runs must
    // trip the adapter's skip-is-failure rule.
    const alwaysOk = runPrepare({ controls: 'accept-ok' })
    expect(alwaysOk.status, alwaysOk.stderr).not.toBe(0)
    expect(alwaysOk.stderr).toContain('the security regression accepted an always-successful tool')
    const alwaysFail = runPrepare({ controls: 'accept-fail' })
    expect(alwaysFail.status, alwaysFail.stderr).not.toBe(0)
    expect(alwaysFail.stderr).toContain('the security regression accepted a tool that never runs')
    for (const run of [alwaysOk, alwaysFail]) expect(run.githubPath).toBe('')
  }, 30_000)

  it('fails when the upstream security regressions fail or are skipped', () => {
    const failed = runPrepare({ upstream: 'fail' })
    expect(failed.status, failed.stderr).not.toBe(0)
    expect(failed.githubPath).toBe('')
    const skipped = runPrepare({ upstream: 'skipped' })
    expect(skipped.status, skipped.stderr).not.toBe(0)
    expect(skipped.githubPath).toBe('')
    const run = runPrepare()
    expect(run.status, run.stderr).toBe(0)
    expect(run.calls.filter(call => call.command === 'python3').length).toBe(3)
  }, 30_000)
  it('never trusts a leftover tool tree and never publishes an unverified one', () => {
    const seed = (runner: string): void => {
      const stale = join(runner, 'dsh-bubblewrap', 'usr', 'bin')
      mkdirSync(stale, { recursive: true })
      writeFileSync(join(stale, 'bwrap'), 'poisoned')
    }
    const failed = runPrepare({ assets: { tarball: 'http404', checksum: 'serve' } }, seed)
    expect(failed.status, failed.stderr).not.toBe(0)
    expect(failed.githubPath).toBe('')
    expect(readFileSync(join(failed.runner, 'dsh-bubblewrap', 'usr', 'bin', 'bwrap'), 'utf8')).toBe('poisoned')
    const recovered = runPrepare({}, seed)
    expect(recovered.status, recovered.stderr).toBe(0)
    expect(readFileSync(recovered.publishedPath, 'utf8')).not.toBe('poisoned')
  }, 30_000)

  it('refuses to install packages on a runner that is not disposable', () => {
    const run = runPrepare({ environment: 'self-hosted' })
    expect(run.status, run.stderr).not.toBe(0)
    expect(run.stderr).toContain('refusing to install packages here')
    expect(run.calls.some(call => call.command === 'apt-get')).toBe(false)
    expect(run.githubPath).toBe('')
  }, 30_000)

  it('refuses to prepare outside Linux x86_64', () => {
    const run = runPrepare({ platform: { system: 'Darwin', machine: 'arm64' } })
    expect(run.status, run.stderr).not.toBe(0)
    expect(run.stderr).toContain('supports only Linux x86_64 hosted runners')
    expect(run.calls).toEqual([])
  }, 30_000)

  it('keeps the digest double faithful to sha256sum', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-bwrap-spec-'))
    workspaces.push(workspace)
    const bin = join(workspace, 'bin')
    mkdirSync(bin, { recursive: true })
    const doublePath = join(bin, 'command-double.mjs')
    writeFileSync(doublePath, shimSource, { mode: 0o755 })
    const wrapper = join(bin, 'sha256sum')
    writeFileSync(wrapper, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(doublePath)} sha256sum "$@"\n`, { mode: 0o755 })
    const scenarioPath = join(workspace, 'scenario.json')
    writeFileSync(scenarioPath, JSON.stringify({ assets: {}, platform: {} }))
    const fixture = join(workspace, 'fixture.tar.xz')
    writeFileSync(fixture, 'fixture-bytes')
    const result = spawnSync(wrapper, [fixture], {
      encoding: 'utf8',
      env: { PATH: bin, SPEC_SCENARIO: scenarioPath, SPEC_LOG: join(workspace, 'calls.jsonl') },
    })
    const expected = createHash('sha256').update('fixture-bytes').digest('hex')
    expect(result.stdout.trim()).toBe(`${expected}  ${fixture}`)
  })
})

describe.skipIf(process.platform !== 'win32')('prepare-ci-bubblewrap on a non-Linux host', () => {
  it('refuses without publishing a tool path', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-bwrap-win-'))
    workspaces.push(workspace)
    const githubPath = join(workspace, 'github-path')
    writeFileSync(githubPath, '')
    const result = spawnSync('bash', [scriptPath], {
      encoding: 'utf8',
      env: { ...process.env, RUNNER_TEMP: workspace, GITHUB_PATH: githubPath },
    })
    expect(result.status, result.stderr).not.toBe(0)
    expect(result.stderr).toContain('supports only Linux x86_64 hosted runners')
    expect(readFileSync(githubPath, 'utf8')).toBe('')
  }, 30_000)
})
