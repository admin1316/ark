import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { installPinnedPwsh, parsePreflightArgs, runPwshPreflight } from './ci-pwsh-preflight.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pwsh-preflight-'))
  roots.push(root)
  return root
}

/** A fake pwsh that answers both the capability probe and the round trip. */
function fakePwsh(): string {
  const root = scratch()
  const file = join(root, 'pwsh')
  writeFileSync(file, "#!/bin/bash\necho '7.6.6 X64'\necho 'dsh-pwsh-preflight-ok'\n")
  chmodSync(file, 0o755)
  return file
}

/** A tarball containing one fake pwsh, plus its real digest. */
function pwshTarball(): { tarball: string; sha256: string } {
  const root = scratch()
  const staged = join(root, 'stage')
  mkdirSync(staged)
  const binary = join(staged, 'pwsh')
  writeFileSync(binary, "#!/bin/bash\necho '7.6.6 X64'\necho 'dsh-pwsh-preflight-ok'\n")
  chmodSync(binary, 0o755)
  const tarball = join(root, 'pwsh.tar.gz')
  const packed = spawnSync('tar', ['-czf', tarball, '-C', staged, 'pwsh'], { encoding: 'utf8' })
  if (packed.status !== 0) throw new Error(`tar failed: ${packed.stderr}`)
  return { tarball, sha256: createHash('sha256').update(readFileSync(tarball)).digest('hex') }
}

const noPath = { PATH: '/nonexistent' }

describe('ci PowerShell preflight', () => {
  it('reports an existing usable tool without installing anything', () => {
    const executable = fakePwsh()
    const result = runPwshPreflight({ require: true, env: { ...noPath, DSH_PWSH_EXECUTABLE: executable }, log: () => {} })
    expect(result.installed).toBe(false)
    expect(result.installSource).toBeNull()
    expect(result.capability).toMatchObject({ available: true, reason: 'OK', version: '7.6.6' })
    expect(result.roundTrip).toBe(true)
  })

  it('exports the PATH-resolved tool as an absolute executable', () => {
    const executable = fakePwsh()
    const env: NodeJS.ProcessEnv = { PATH: `${join(executable, '..')}:/bin` }
    const result = runPwshPreflight({ require: true, env, log: () => {} })
    expect(result.capability.available).toBe(true)
    expect(result.capability.executable).toBe(executable)
    expect(env.DSH_PWSH_EXECUTABLE).toBe(executable)
  })

  it('publishes the resolved executable to later steps through GITHUB_ENV', () => {
    const executable = fakePwsh()
    const githubEnv = join(scratch(), 'github-env')
    writeFileSync(githubEnv, '')
    const env: NodeJS.ProcessEnv = { ...noPath, DSH_PWSH_EXECUTABLE: executable, GITHUB_ENV: githubEnv }
    runPwshPreflight({ require: true, env, log: () => {} })
    expect(readFileSync(githubEnv, 'utf8')).toContain(`DSH_PWSH_EXECUTABLE=${executable}`)
  })

  it('installs the pinned asset from a local tarball and proves it by execution', () => {
    const { tarball, sha256 } = pwshTarball()
    const installDir = join(scratch(), 'tools')
    const env: NodeJS.ProcessEnv = { ...noPath }
    const result = runPwshPreflight({ require: true, installDir, tarball, sha256, env, log: () => {} })
    expect(result.installed).toBe(true)
    expect(result.installSource).toBe('local-tarball')
    expect(result.capability).toMatchObject({ available: true, reason: 'OK', version: '7.6.6' })
    expect(result.roundTrip).toBe(true)
    expect(env.DSH_PWSH_EXECUTABLE).toBe(result.capability.executable)
    expect(existsSync(join(installDir, 'pwsh-local', 'pwsh'))).toBe(true)
  })

  it('refuses a tarball whose digest does not match the published value', () => {
    const { tarball } = pwshTarball()
    const installDir = join(scratch(), 'tools')
    expect(() => runPwshPreflight({
      require: true,
      installDir,
      tarball,
      sha256: '0'.repeat(64),
      env: { ...noPath },
      log: () => {},
    })).toThrow(/checksum mismatch/u)
  })

  it('fails with the concrete reason when the tool is required and absent', () => {
    expect(() => runPwshPreflight({ require: true, env: { ...noPath }, log: () => {} }))
      .toThrow(/required but unusable: NOT_FOUND/u)
  })

  it('keeps the optional-skip semantics when the tool is not required', () => {
    const result = runPwshPreflight({ env: { ...noPath }, log: () => {} })
    expect(result.capability.available).toBe(false)
    expect(result.roundTrip).toBe(false)
  })

  it('parses the CLI contract and rejects unknown arguments', () => {
    expect(parsePreflightArgs(['--require', '--install-dir', '/tmp/tools', '--tarball', '/tmp/a.tgz', '--sha256', 'ab']))
      .toEqual({ require: true, installDir: '/tmp/tools', tarball: '/tmp/a.tgz', sha256: 'ab' })
    expect(() => parsePreflightArgs(['--wat'])).toThrow(/unknown preflight argument/u)
  })

  it('installs only through the documented inputs', () => {
    expect(() => installPinnedPwsh({ env: { ...noPath } })).toThrow(/--install-dir is required/u)
    expect(() => installPinnedPwsh({ installDir: '/tmp/tools', env: { ...noPath }, platform: 'win32', arch: 'x64' }))
      .toThrow(/no pinned PowerShell asset for win32-x64/u)
  })
})

describe('coverage lane PowerShell contract', () => {
  const workflow = readFileSync(join(import.meta.dirname, '..', '.github', 'workflows', 'ci.yml'), 'utf8')

  /** Lines of one job block, so ordering is asserted inside the real job. */
  function jobLines(job: string): string[] {
    const lines = workflow.split('\n')
    const start = lines.findIndex(line => line === `  ${job}:`)
    if (start < 0) throw new Error(`missing job: ${job}`)
    let end = lines.length
    for (let index = start + 1; index < lines.length; index += 1) {
      if (/^  \S/u.test(lines[index] ?? '')) { end = index; break }
    }
    return lines.slice(start, end)
  }

  function jobSteps(job: string): { name: string; body: string[] }[] {
    const steps: { name: string; body: string[] }[] = []
    let current: { name: string; body: string[] } | undefined
    for (const line of jobLines(job)) {
      const match = /^      - name: (.*)$/u.exec(line)
      if (match !== null) {
        current = { name: match[1] ?? '', body: [] }
        steps.push(current)
        continue
      }
      current?.body.push(line)
    }
    return steps
  }

  it('preflights PowerShell before the coverage consumer and requires it there', () => {
    const steps = jobSteps('node-24-coverage')
    const names = steps.map(step => step.name)
    const preflight = names.indexOf('PowerShell capability (coverage prerequisite)')
    const hostBuild = names.indexOf('Build host lib outputs (coverage prerequisite)')
    const coverage = names.indexOf('Run exhaustive coverage')
    expect(preflight).toBeGreaterThanOrEqual(0)
    expect(hostBuild).toBeGreaterThan(preflight)
    expect(coverage).toBeGreaterThan(hostBuild)
    const preflightBody = steps[preflight]?.body.join('\n') ?? ''
    expect(preflightBody).toContain('scripts/ci-pwsh-preflight.ts')
    expect(preflightBody).toContain('--require')
    expect(preflightBody).toContain('--install-dir')
    expect(preflightBody).toContain("DSH_REQUIRE_PWSH: '1'")
    const coverageBody = steps[coverage]?.body.join('\n') ?? ''
    expect(coverageBody).toContain("DSH_REQUIRE_PWSH: '1'")
    expect(coverageBody).toContain('pnpm run check:ci:coverage')
  })
})
