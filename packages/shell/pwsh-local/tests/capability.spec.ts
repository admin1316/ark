import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PWSH_EXECUTABLE_ENV,
  REQUIRE_PWSH_ENV,
  classifyPwshProbe,
  probePwshCapability,
  pwshTestsAvailable,
} from '@deepseek-ai/dsh-pwsh-local'
import type { PwshProbeOutcome } from '@deepseek-ai/dsh-pwsh-local'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Write a fake pwsh in a temp directory; the real machine tool is never touched. */
function fakePwsh(body: string, mode = 0o755): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pwsh-capability-'))
  roots.push(root)
  const file = join(root, 'pwsh')
  writeFileSync(file, `#!/bin/bash\n${body}\n`)
  chmodSync(file, mode)
  return file
}

const noPath = { PATH: '/nonexistent' }

function outcome(overrides: Partial<PwshProbeOutcome> = {}): PwshProbeOutcome {
  return { executable: '/fake/pwsh', status: 0, signal: null, stdout: '', stderr: '', ...overrides }
}

function spawnError(code: string, message = `spawn fake ${code}`): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException
  error.code = code
  return error
}

describe('pwsh probe outcome classification', () => {
  it('maps spawn error codes to their reasons', () => {
    expect(classifyPwshProbe(outcome({ error: spawnError('ENOENT') })))
      .toMatchObject({ available: false, reason: 'NOT_FOUND' })
    expect(classifyPwshProbe(outcome({ error: spawnError('EACCES') })))
      .toMatchObject({ available: false, reason: 'NOT_EXECUTABLE' })
    expect(classifyPwshProbe(outcome({ error: spawnError('EPERM') })))
      .toMatchObject({ available: false, reason: 'NOT_EXECUTABLE' })
    expect(classifyPwshProbe(outcome({ error: spawnError('ETIMEDOUT') })))
      .toMatchObject({ available: false, reason: 'TIMEOUT' })
  })

  it('classifies an unknown spawn error by whether a signal was recorded', () => {
    expect(classifyPwshProbe(outcome({ error: spawnError('EUNKNOWN') })))
      .toMatchObject({ available: false, reason: 'PROBE_FAILED' })
    const withoutCode = new Error('spawn failed') as NodeJS.ErrnoException
    expect(classifyPwshProbe(outcome({ error: withoutCode })))
      .toMatchObject({ available: false, reason: 'PROBE_FAILED' })
    expect(classifyPwshProbe(outcome({ error: spawnError('EUNKNOWN'), signal: 'SIGKILL' })))
      .toMatchObject({ available: false, reason: 'TIMEOUT' })
  })

  it('classifies a terminated child as a timeout with its signal', () => {
    expect(classifyPwshProbe(outcome({ status: null, signal: 'SIGTERM' })))
      .toMatchObject({ available: false, reason: 'TIMEOUT', detail: 'terminated by SIGTERM' })
    expect(classifyPwshProbe(outcome({ status: null, signal: null })))
      .toMatchObject({ available: false, reason: 'TIMEOUT', detail: 'terminated by unknown signal' })
  })

  it('reports the child stderr, or the exit code when it is empty', () => {
    expect(classifyPwshProbe(outcome({ status: 7, stderr: 'broken-tool\n' })))
      .toMatchObject({ available: false, reason: 'PROBE_FAILED', detail: 'broken-tool' })
    expect(classifyPwshProbe(outcome({ status: 7, stderr: '   ' })))
      .toMatchObject({ available: false, reason: 'PROBE_FAILED', detail: 'exit 7' })
  })

  it('rejects output that carries no version', () => {
    const capability = classifyPwshProbe(outcome({ stdout: 'not a version' }))
    expect(capability.reason).toBe('PROBE_FAILED')
    expect(capability.detail).toContain('unexpected probe output')
  })

  it('accepts a version with or without architecture', () => {
    expect(classifyPwshProbe(outcome({ stdout: '7.6.6 X64\n' })))
      .toMatchObject({ available: true, reason: 'OK', version: '7.6.6', architecture: 'X64', detail: '' })
    expect(classifyPwshProbe(outcome({ stdout: '7.6.6\n' })))
      .toMatchObject({ available: true, reason: 'OK', version: '7.6.6', architecture: null })
  })

  it('rejects a version below the supported major', () => {
    expect(classifyPwshProbe(outcome({ stdout: '5.1.14409.100 X64\n' })))
      .toMatchObject({ available: false, reason: 'VERSION_MISMATCH', version: '5.1.14409' })
  })
})

// Platform mapping. The classifier block above is pure and runs everywhere;
// the probe cases that spawn a stand-in tool need a POSIX shell script with an
// execute bit, so they are scheduled for POSIX hosts, while the absent-tool,
// optional-skip and required-mode cases stay cross-platform. Windows keeps its
// own preflight lookup case in scripts/ci-pwsh-preflight.spec.ts.
const posixToolFixtures = process.platform !== 'win32'

describe('pwsh capability probe', () => {
  it('reports NOT_FOUND for a missing executable', () => {
    const capability = probePwshCapability({ executable: join(tmpdir(), 'absent-pwsh'), env: noPath })
    expect(capability).toMatchObject({ available: false, reason: 'NOT_FOUND', version: null })
    expect(capability.detail.length).toBeGreaterThan(0)
  })

  it.skipIf(!posixToolFixtures)('reports NOT_EXECUTABLE for a file without the execute bit', () => {
    const capability = probePwshCapability({ executable: fakePwsh("echo '7.6.6 X64'", 0o644), env: noPath })
    expect(capability.available).toBe(false)
    expect(capability.reason).toBe('NOT_EXECUTABLE')
  })

  it.skipIf(!posixToolFixtures)('reports VERSION_MISMATCH below the supported major', () => {
    const capability = probePwshCapability({ executable: fakePwsh("echo '5.1.14409.100 X64'"), env: noPath })
    expect(capability).toMatchObject({ available: false, reason: 'VERSION_MISMATCH', version: '5.1.14409' })
  })

  it.skipIf(!posixToolFixtures)('reports PROBE_FAILED with the child stderr on a non-zero exit', () => {
    const capability = probePwshCapability({ executable: fakePwsh('echo broken-tool >&2; exit 3'), env: noPath })
    expect(capability).toMatchObject({ available: false, reason: 'PROBE_FAILED' })
    expect(capability.detail).toContain('broken-tool')
  })

  it.skipIf(!posixToolFixtures)('reports PROBE_FAILED on unexpected output', () => {
    const capability = probePwshCapability({ executable: fakePwsh("echo 'not a version'"), env: noPath })
    expect(capability.reason).toBe('PROBE_FAILED')
    expect(capability.detail).toContain('unexpected probe output')
  })

  // The timeout reason itself is pinned by the classifier cases above: how a
  // killed child surfaces (ETIMEDOUT spawn error versus status null with a
  // signal) differs per platform, so a spawn-based case would assert the host
  // rather than the contract. This exercises the explicit-deadline input.
  it.skipIf(!posixToolFixtures)('accepts an explicit deadline', () => {
    const capability = probePwshCapability({
      executable: fakePwsh("echo '7.6.6 X64'"),
      env: noPath,
      timeoutMs: 5_000,
    })
    expect(capability).toMatchObject({ available: true, reason: 'OK' })
  })

  it.skipIf(!posixToolFixtures)('reports OK with version and architecture for a usable executable', () => {
    const capability = probePwshCapability({ executable: fakePwsh("echo '7.6.6 X64'"), env: noPath })
    expect(capability).toMatchObject({
      available: true, reason: 'OK', version: '7.6.6', architecture: 'X64', detail: '',
    })
  })

  it.skipIf(!posixToolFixtures)('falls back to the shared resolver when no executable is supplied', () => {
    const capability = probePwshCapability({ env: noPath })
    expect(capability.executable).toBe('pwsh')
    expect(capability.available).toBe(false)
  })

  it.skipIf(!posixToolFixtures)('prefers the preflight-resolved absolute executable from the environment', () => {
    const executable = fakePwsh("echo '7.6.6 X64'")
    const capability = probePwshCapability({ env: { ...noPath, [PWSH_EXECUTABLE_ENV]: executable } })
    expect(capability).toMatchObject({ available: true, executable, version: '7.6.6' })
  })

  it.skipIf(!posixToolFixtures)('can read the ambient environment and its own default deadline', () => {
    const capability = probePwshCapability()
    expect(typeof capability.available).toBe('boolean')
    expect(capability.executable.length).toBeGreaterThan(0)
  })

  it('keeps the optional skip on a development host', () => {
    expect(pwshTestsAvailable({ executable: join(tmpdir(), 'absent-pwsh'), env: noPath })).toBe(false)
  })

  it('fails with the concrete reason when a required tool is absent', () => {
    expect(() => pwshTestsAvailable({
      executable: join(tmpdir(), 'absent-pwsh'),
      env: { ...noPath, [REQUIRE_PWSH_ENV]: '1' },
    })).toThrow(/NOT_FOUND/u)
  })

  it.skipIf(!posixToolFixtures)('fails with the version reason when a required tool is too old', () => {
    expect(() => pwshTestsAvailable({
      executable: fakePwsh("echo '5.1.14409.100 X64'"),
      env: { ...noPath, [REQUIRE_PWSH_ENV]: '1' },
    })).toThrow(/VERSION_MISMATCH/u)
  })

  it('falls back to the ambient environment when no options are given', () => {
    const previousExecutable = process.env.DSH_PWSH_EXECUTABLE
    const previousRequire = process.env.DSH_REQUIRE_PWSH
    process.env.DSH_PWSH_EXECUTABLE = join(tmpdir(), 'absent-pwsh')
    delete process.env.DSH_REQUIRE_PWSH
    try {
      expect(pwshTestsAvailable()).toBe(false)
    } finally {
      if (previousExecutable === undefined) delete process.env.DSH_PWSH_EXECUTABLE
      else process.env.DSH_PWSH_EXECUTABLE = previousExecutable
      if (previousRequire === undefined) delete process.env.DSH_REQUIRE_PWSH
      else process.env.DSH_REQUIRE_PWSH = previousRequire
    }
  })

  it.skipIf(!posixToolFixtures)('lets a required run pass when the tool is usable', () => {
    const executable = fakePwsh("echo '7.6.6 X64'")
    expect(pwshTestsAvailable({ executable, env: { ...noPath, [REQUIRE_PWSH_ENV]: '1' } })).toBe(true)
  })
})
