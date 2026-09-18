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
  /** `uname` answers. */
  platform: { system: string; machine: string }
  /** Per-source outcome, keyed by URL host. */
  sources: Record<string, 'serve' | 'http404' | 'network' | 'html'>
  /** Digest comparison outcome; `undefined` keeps the double's real comparison. */
  digest?: 'match' | 'mismatch'
  /** Bytes the served fixture carries. */
  payloadBytes?: number
  /** Control fields `dpkg-deb --field` answers. */
  control: Record<string, string>
  /** `dpkg-deb --contents` output. */
  contents: string
  /** `dpkg-deb --extract` exit code. */
  extractExit?: number
  /** `bwrap --version` exit code. */
  versionExit?: number
  /** Positive confinement probe exit code. */
  probeExit?: number
  /** Negative (read-only bind must refuse) probe exit code. */
  negativeProbeExit?: number
}

const quote = (value: string): string => `'${value.replaceAll('\'', '\\' + '\'')}'`

const workspaces: string[] = []

afterEach(() => {
  for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true })
})
const shimSource = String.raw`#!/usr/bin/env node
// Command double for scripts/prepare-ci-bubblewrap.spec.ts. It keeps the real
// command-line contract of each tool it stands in for (flags, stdin, exit
// codes) so the spec drives the production script's control flow rather than a
// reimplementation of it.
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const command = process.argv[2] ?? ''
const args = process.argv.slice(3)
const scenario = JSON.parse(readFileSync(process.env.SPEC_SCENARIO, 'utf8'))
const log = (entry) => appendFileSync(process.env.SPEC_LOG, JSON.stringify(entry) + '\n')
const digest = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

if (command === 'uname') {
  process.stdout.write((args.includes('-m') ? scenario.platform.machine : scenario.platform.system) + '\n')
  process.exit(0)
}

if (command === 'sysctl') process.exit(0)

if (command === 'sudo') {
  const result = spawnSync(args[0], args.slice(1), { stdio: 'inherit' })
  process.exit(result.status ?? 1)
}

if (command === 'curl') {
  const valueFlags = ['--output', '--connect-timeout', '--max-time']
  let output = ''
  let url = ''
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (valueFlags.includes(arg)) {
      if (arg === '--output') output = args[index + 1] ?? ''
      index += 1
      continue
    }
    if (arg.startsWith('-')) continue
    url = arg
  }
  const host = new URL(url).host
  const mode = scenario.sources[host]
  log({ command: 'curl', host, mode })
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
  // The real package bytes are not available offline, so the served fixture is
  // a deterministic buffer of the pinned size; the digest outcome is declared
  // per scenario because no fixture can reproduce the published archive value.
  writeFileSync(output, Buffer.alloc(scenario.payloadBytes ?? 50436, 0x62))
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
  process.exit(compared ? 0 : 1)
}

if (command === 'dpkg-deb') {
  if (args[0] === '--field') {
    const requested = args.slice(2)
    const fields = requested.length > 0 ? requested : Object.keys(scenario.control)
    for (const field of fields) process.stdout.write(String(scenario.control[field] ?? '') + '\n')
    process.exit(0)
  }
  if (args[0] === '--contents') {
    process.stdout.write(scenario.contents)
    process.exit(0)
  }
  if (args[0] === '--extract') {
    const target = args[2]
    const exit = scenario.extractExit ?? 0
    if (exit !== 0) {
      process.stdout.write('extracted ' + target + '\n')
      process.exit(exit)
    }
    mkdirSync(join(target, 'usr/bin'), { recursive: true })
    writeFileSync(join(target, 'usr/bin/bwrap'), '#!/bin/sh\nexec "' + process.env.SPEC_NODE + '" "' + process.env.SPEC_DOUBLE + '" bwrap "$@"\n', { mode: 0o755 })
    process.exit(0)
  }
  process.exit(2)
}

if (command === 'bwrap') {
  if (args.includes('--version')) {
    process.stdout.write('bubblewrap 0.9.0\n')
    process.exit(scenario.versionExit ?? 0)
  }
  const negative = args.some(arg => arg.includes('.dsh-bwrap-probe'))
  log({ command: 'bwrap', negative })
  if (negative) process.exit(scenario.negativeProbeExit ?? 1)
  process.exit(scenario.probeExit ?? 0)
}

process.stderr.write('unexpected double: ' + command + '\n')
process.exit(127)`

interface PrepareCall {
  command: string
  host?: string
  mode?: string
  negative?: boolean
}

interface PrepareRun {
  status: number | null
  stdout: string
  stderr: string
  githubPath: string
  calls: PrepareCall[]
  runner: string
  bwrapPath: string
  payloadPath: string
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
  for (const command of ['curl', 'sha256sum', 'dpkg-deb', 'bwrap', 'uname', 'sudo', 'sysctl']) {
    const wrapper = join(bin, command)
    writeFileSync(wrapper, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(doublePath)} ${command} "$@"\n`, { mode: 0o755 })
  }
  writeFileSync(githubPath, '')
  seed?.(runner)
  const scenario: Scenario = {
    platform: { system: 'Linux', machine: 'x86_64' },
    sources: { 'archive.ubuntu.com': 'serve', 'security.ubuntu.com': 'serve' },
    digest: 'match',
    payloadBytes: 50_436,
    control: { Package: 'bubblewrap', Version: '0.9.0-1ubuntu0.3', Architecture: 'amd64' },
    contents: '-rwxr-xr-x root/root 12345 2026-09-17 12:00 ./usr/bin/bwrap\n',
    extractExit: 0,
    ...overrides,
  }
  const scenarioPath = join(workspace, 'scenario.json')
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
    bwrapPath: join(runner, 'dsh-bubblewrap', 'usr', 'bin', 'bwrap'),
    payloadPath: join(runner, 'dsh-bubblewrap', 'usr', 'bin', 'bwrap'),
  }
}

describe('prepare-ci-bubblewrap', () => {
  it('verifies the pinned payload and publishes only a working tool', () => {
    const run = runPrepare()
    expect(run.status, run.stderr).toBe(0)
    expect(run.githubPath).toBe(`${run.runner}/dsh-bubblewrap/usr/bin\n`)
    expect(existsSync(run.bwrapPath)).toBe(true)
    expect(run.stderr).toContain('verified bubblewrap 0.9.0-1ubuntu0.3 amd64')
    expect(run.stdout).toContain('bubblewrap 0.9.0-1ubuntu0.3 amd64 sha256=')
    expect(run.stdout).toContain('source=https://archive.ubuntu.com/ubuntu/pool/main/b/bubblewrap/')
    expect(run.stdout).toContain('bubblewrap functional probe passed')
  })

  it('falls back to the audited security mirror, without retrying the 404', () => {
    const run = runPrepare({ sources: { 'archive.ubuntu.com': 'http404', 'security.ubuntu.com': 'serve' } })
    expect(run.status, run.stderr).toBe(0)
    const hosts = run.calls.filter(call => call.command === 'curl').map(call => call.host)
    expect(hosts).toEqual(['archive.ubuntu.com', 'security.ubuntu.com'])
    expect(run.stdout).toContain('source=https://security.ubuntu.com/ubuntu/pool/main/b/bubblewrap/')
  })

  it('bounds retries per source and never retries a withdrawn artifact', () => {
    const run = runPrepare({ sources: { 'archive.ubuntu.com': 'network', 'security.ubuntu.com': 'serve' } })
    expect(run.status, run.stderr).toBe(0)
    const hosts = run.calls.filter(call => call.command === 'curl').map(call => call.host)
    expect(hosts).toEqual(['archive.ubuntu.com', 'archive.ubuntu.com', 'security.ubuntu.com'])
  })

  it('fails without publishing when every source is unavailable', () => {
    const run = runPrepare({ sources: { 'archive.ubuntu.com': 'http404', 'security.ubuntu.com': 'http404' } })
    expect(run.status, run.stderr).not.toBe(0)
    expect(run.githubPath).toBe('')
    expect(existsSync(run.bwrapPath)).toBe(false)
    expect(run.stderr).toContain('no audited source could deliver the pinned payload')
  })

  it('rejects an HTML error page served with status 200', () => {
    const run = runPrepare({ sources: { 'archive.ubuntu.com': 'html', 'security.ubuntu.com': 'html' } })
    expect(run.status, run.stderr).not.toBe(0)
    expect(run.githubPath).toBe('')
    expect(run.stderr).toContain('expected 50436')
  })

  it('fails on a digest mismatch before extracting or publishing', () => {
    const run = runPrepare({ digest: 'mismatch' })
    expect(run.status, run.stderr).not.toBe(0)
    expect(run.stderr).toContain('payload digest does not match the pinned index value')
    expect(run.githubPath).toBe('')
    expect(existsSync(run.bwrapPath)).toBe(false)
    expect(run.calls.some(call => call.command === 'dpkg-deb')).toBe(false)
  })

  it('fails on a payload whose control identity is another revision', () => {
    const run = runPrepare({ control: { Package: 'bubblewrap', Version: '0.9.0-1ubuntu0.2', Architecture: 'amd64' } })
    expect(run.status, run.stderr).not.toBe(0)
    expect(run.stderr).toContain('unexpected payload identity')
    expect(run.githubPath).toBe('')
  })

  it('fails on a payload built for another architecture', () => {
    const run = runPrepare({ control: { Package: 'bubblewrap', Version: '0.9.0-1ubuntu0.3', Architecture: 'arm64' } })
    expect(run.status, run.stderr).not.toBe(0)
    expect(run.githubPath).toBe('')
  })

  it('fails when the payload carries no bwrap executable', () => {
    const run = runPrepare({ contents: 'drwxr-xr-x root/root 0 2026-09-17 12:00 ./usr/\n' })
    expect(run.status, run.stderr).not.toBe(0)
    expect(run.stderr).toContain('does not contain usr/bin/bwrap')
    expect(run.githubPath).toBe('')
  })

  it('fails when extraction fails even after printing progress', () => {
    const run = runPrepare({ extractExit: 2 })
    expect(run.status, run.stderr).not.toBe(0)
    expect(run.stderr).toContain('payload extraction failed')
    expect(run.githubPath).toBe('')
  })

  it('fails when the version probe passes but confinement does not run', () => {
    const run = runPrepare({ probeExit: 1 })
    expect(run.status, run.stderr).not.toBe(0)
    expect(run.githubPath).toBe('')
  })

  it('fails when the read-only bind is writable', () => {
    const run = runPrepare({ negativeProbeExit: 0 })
    expect(run.status, run.stderr).not.toBe(0)
    expect(run.stderr).toContain('the read-only bind was writable; confinement probe failed')
    expect(run.githubPath).toBe('')
  })

  it('never trusts a leftover tree from an earlier attempt', () => {
    const seed = (runner: string): void => {
      const stale = join(runner, 'dsh-bubblewrap', 'usr', 'bin')
      mkdirSync(stale, { recursive: true })
      writeFileSync(join(stale, 'bwrap'), 'poisoned')
      writeFileSync(join(runner, 'bubblewrap_0.9.0-1ubuntu0.3_amd64.deb'), 'stale-archive')
    }
    const failed = runPrepare({ sources: { 'archive.ubuntu.com': 'http404', 'security.ubuntu.com': 'http404' } }, seed)
    expect(failed.status, failed.stderr).not.toBe(0)
    expect(failed.githubPath).toBe('')
    expect(readFileSync(join(failed.runner, 'dsh-bubblewrap', 'usr', 'bin', 'bwrap'), 'utf8')).toBe('poisoned')
    const recovered = runPrepare({}, seed)
    expect(recovered.status, recovered.stderr).toBe(0)
    const replaced = readFileSync(join(recovered.runner, 'dsh-bubblewrap', 'usr', 'bin', 'bwrap'), 'utf8')
    expect(replaced).not.toBe('poisoned')
  })
  it('refuses to prepare outside Linux x86_64', () => {
    const run = runPrepare({ platform: { system: 'Darwin', machine: 'arm64' } })
    expect(run.status, run.stderr).not.toBe(0)
    expect(run.stderr).toContain('supports only Linux x86_64 hosted runners')
    expect(run.calls).toEqual([])
  })

  it('keeps the digest double faithful to sha256sum', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-bwrap-spec-'))
    workspaces.push(workspace)
    const bin = join(workspace, 'bin')
    mkdirSync(bin, { recursive: true })
    const doublePath = join(bin, 'command-double.mjs')
    writeFileSync(doublePath, shimSource, { mode: 0o755 })
    writeFileSync(join(bin, 'sha256sum'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(doublePath)} sha256sum "$@"\n`, { mode: 0o755 })
    const fixture = join(workspace, 'fixture.deb')
    writeFileSync(fixture, 'fixture-bytes')
    const scenarioPath = join(workspace, 'scenario.json')
    writeFileSync(scenarioPath, JSON.stringify({ sources: {}, control: {}, contents: '', platform: {} }))
    const result = spawnSync(join(bin, 'sha256sum'), [fixture], {
      encoding: 'utf8',
      env: { PATH: bin, SPEC_SCENARIO: scenarioPath, SPEC_LOG: join(workspace, 'calls.jsonl') },
    })
    const expected = createHash('sha256').update('fixture-bytes').digest('hex')
    expect(result.stdout.trim()).toBe(`${expected}  ${fixture}`)
  })
})
