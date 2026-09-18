import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PWSH_EXECUTABLE_ENV,
  REQUIRE_PWSH_ENV,
  probePwshCapability,
  pwshTestsAvailable,
} from '@deepseek-ai/dsh-pwsh-local'

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

describe('pwsh capability probe', () => {
  it('reports NOT_FOUND for a missing executable', () => {
    const capability = probePwshCapability({ executable: join(tmpdir(), 'absent-pwsh'), env: noPath })
    expect(capability).toMatchObject({ available: false, reason: 'NOT_FOUND', version: null })
  })

  it('reports NOT_EXECUTABLE for a file without the execute bit', () => {
    const capability = probePwshCapability({ executable: fakePwsh("echo '7.6.6 X64'", 0o644), env: noPath })
    expect(capability.available).toBe(false)
    expect(capability.reason).toBe('NOT_EXECUTABLE')
  })

  it('reports VERSION_MISMATCH below the supported major', () => {
    const capability = probePwshCapability({ executable: fakePwsh("echo '5.1.14409.100 X64'"), env: noPath })
    expect(capability).toMatchObject({ available: false, reason: 'VERSION_MISMATCH', version: '5.1.14409' })
  })

  it('reports PROBE_FAILED with the child stderr on a non-zero exit', () => {
    const capability = probePwshCapability({ executable: fakePwsh('echo broken-tool >&2; exit 3'), env: noPath })
    expect(capability).toMatchObject({ available: false, reason: 'PROBE_FAILED' })
    expect(capability.detail).toContain('broken-tool')
  })

  it('reports PROBE_FAILED on unexpected output', () => {
    const capability = probePwshCapability({ executable: fakePwsh("echo 'not a version'"), env: noPath })
    expect(capability.reason).toBe('PROBE_FAILED')
    expect(capability.detail).toContain('unexpected probe output')
  })

  it('reports TIMEOUT when the probe exceeds its single deadline', () => {
    const capability = probePwshCapability({ executable: fakePwsh('sleep 5'), env: noPath, timeoutMs: 200 })
    expect(capability.reason).toBe('TIMEOUT')
    expect(capability.available).toBe(false)
  })

  it('reports OK with version and architecture for a usable executable', () => {
    const capability = probePwshCapability({ executable: fakePwsh("echo '7.6.6 X64'"), env: noPath })
    expect(capability).toMatchObject({
      available: true, reason: 'OK', version: '7.6.6', architecture: 'X64', detail: null,
    })
  })

  it('prefers the preflight-resolved absolute executable from the environment', () => {
    const executable = fakePwsh("echo '7.6.6 X64'")
    const capability = probePwshCapability({ env: { ...noPath, [PWSH_EXECUTABLE_ENV]: executable } })
    expect(capability).toMatchObject({ available: true, executable, version: '7.6.6' })
  })

  it('keeps the optional skip on a development host', () => {
    expect(pwshTestsAvailable({ executable: join(tmpdir(), 'absent-pwsh'), env: noPath })).toBe(false)
  })

  it('fails with the concrete reason when the tool is required', () => {
    expect(() => pwshTestsAvailable({
      executable: join(tmpdir(), 'absent-pwsh'),
      env: { ...noPath, [REQUIRE_PWSH_ENV]: '1' },
    })).toThrow(/NOT_FOUND/u)
    expect(() => pwshTestsAvailable({
      executable: fakePwsh("echo '5.1.14409.100 X64'"),
      env: { ...noPath, [REQUIRE_PWSH_ENV]: '1' },
    })).toThrow(/VERSION_MISMATCH/u)
  })

  it('lets a required run pass when the tool is usable', () => {
    const executable = fakePwsh("echo '7.6.6 X64'")
    expect(pwshTestsAvailable({ executable, env: { ...noPath, [REQUIRE_PWSH_ENV]: '1' } })).toBe(true)
  })
})
