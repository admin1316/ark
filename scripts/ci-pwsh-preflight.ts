#!/usr/bin/env node
/**
 * CI PowerShell capability preflight.
 *
 * The complete coverage lane owns 100% thresholds on the pwsh suites, so the
 * tool is a job requirement: this step proves it before the consumer runs,
 * installs the pinned official build when the runner image cannot provide it,
 * and fails with the concrete reason instead of letting the suites skip into a
 * low-coverage failure. The shared capability owner in
 * `packages/shell/pwsh-local/src/capability.ts` keeps this preflight and the
 * suites on the same definition of "usable".
 *
 * Usage:
 *   tsx scripts/ci-pwsh-preflight.ts [--require] [--install-dir DIR]
 *     [--tarball FILE --sha256 HEX]   # offline/test override, no download
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  PWSH_EXECUTABLE_ENV,
  probePwshCapability,
  type PwshCapability,
} from '../packages/shell/pwsh-local/src/capability.ts'

/** Pinned official PowerShell builds; never a floating latest. */
export const PINNED_PWSH = {
  'linux-x64': {
    version: '7.6.6',
    sha256: 'ddbc4a2d113bbd46d283cfedcbcd117a70caefd7673f41f2b4e0000badf103bc',
    url: 'https://github.com/PowerShell/PowerShell/releases/download/v7.6.6/powershell-7.6.6-linux-x64.tar.gz',
  },
  'linux-arm64': {
    version: '7.6.6',
    sha256: '924829e54c983648f6f1419a2dc7f9433c861b2fb5bd57736ff096c24f133729',
    url: 'https://github.com/PowerShell/PowerShell/releases/download/v7.6.6/powershell-7.6.6-linux-arm64.tar.gz',
  },
} as const

/** Execution round-trip token the synthetic command must echo. */
const ROUND_TRIP_TOKEN = 'dsh-pwsh-preflight-ok'

export interface PreflightOptions {
  require?: boolean
  installDir?: string
  tarball?: string
  sha256?: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  arch?: string
  log?: (line: string) => void
}

export interface PreflightResult {
  capability: PwshCapability
  roundTrip: boolean
  installed: boolean
  installSource: 'existing' | 'pinned-download' | 'local-tarball' | null
}

/**
 * Run one execution round trip through the resolved executable: the suites
 * decode child output, so a version query alone is not enough evidence.
 * @param executable - executable under test.
 * @param env - environment for the child.
 * @returns whether the token round-tripped.
 */
export function probeRoundTrip(executable: string, env: NodeJS.ProcessEnv): boolean {
  const command = `$PSVersionTable.PSVersion.Major; Write-Output '${ROUND_TRIP_TOKEN}'`
  const result = spawnSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    env,
    timeout: 20_000,
  })
  return result.status === 0 && result.stdout.includes(ROUND_TRIP_TOKEN)
}

function runCommand(command: string, args: string[]): void {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.error !== undefined) {
    throw new Error(`${command} ${args.join(' ')} could not run: ${result.error.message}`)
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status}): ${result.stderr.trim()}`)
  }
}

/**
 * Install the pinned official build into the job-scoped tools directory, after
 * verifying its published SHA-256.
 */
export function installPinnedPwsh(
  options: PreflightOptions,
): { executable: string; source: 'pinned-download' | 'local-tarball' } {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  if (options.installDir === undefined || options.installDir === '') {
    throw new Error('--install-dir is required to install PowerShell')
  }
  const key = `${platform}-${arch}`
  const localTarball = options.tarball
  let version: string
  let expected: string
  let url: string | undefined
  if (localTarball === undefined) {
    const asset = PINNED_PWSH[key as keyof typeof PINNED_PWSH] as
      | { version: string; sha256: string; url: string }
      | undefined
    if (asset === undefined) {
      throw new Error(`no pinned PowerShell asset for ${key}; install it in the job image instead`)
    }
    version = asset.version
    expected = options.sha256 ?? asset.sha256
    url = asset.url
  } else {
    version = 'local'
    expected = options.sha256 ?? ''
  }
  if (expected === '') throw new Error('a published SHA-256 is required to install PowerShell')
  const directory = join(options.installDir, `pwsh-${version}`)
  const tarball = localTarball ?? join(tmpdir(), `pwsh-${version}-${key}.tar.gz`)
  if (url !== undefined) runCommand('curl', ['-fsSL', '--retry', '2', '-o', tarball, url])
  const digest = createHash('sha256').update(readFileSync(tarball)).digest('hex')
  if (digest !== expected) {
    throw new Error(`PowerShell tarball checksum mismatch: expected ${expected}, got ${digest}`)
  }
  mkdirSync(directory, { recursive: true })
  runCommand('tar', ['-xzf', tarball, '-C', directory])
  const executable = join(directory, 'pwsh')
  if (!existsSync(executable)) throw new Error(`installed tarball has no pwsh at ${executable}`)
  chmodSync(executable, 0o755)
  // Only this job sees the tool: process env, the child env, and (on Actions)
  // the subsequent steps' PATH.
  env[PWSH_EXECUTABLE_ENV] = executable
  env.PATH = `${directory}:${env.PATH ?? ''}`
  if (env.GITHUB_PATH !== undefined && env.GITHUB_PATH !== '') {
    appendFileSync(env.GITHUB_PATH, `${directory}\n`)
  }
  return { executable, source: localTarball === undefined ? 'pinned-download' : 'local-tarball' }
}

/**
 * Absolute path of a PATH-resolved executable.
 *
 * The preflight runs once in the job's main process while the suites run in
 * forked processes; exporting the absolute path keeps both on the same file
 * instead of re-resolving through a PATH that a fork could see differently.
 * @param executable - executable the probe used.
 * @param env - environment used for the lookup.
 * @returns the absolute path, or the input when it cannot be resolved.
 */
export function resolveAbsoluteExecutable(executable: string, env: NodeJS.ProcessEnv): string {
  if (executable.startsWith('/')) return executable
  const lookup = spawnSync('/bin/sh', ['-c', 'command -v "$0"', executable], {
    encoding: 'utf8',
    env,
    timeout: 5_000,
  })
  const resolved = lookup.stdout.trim().split('\n')[0] ?? ''
  return lookup.status === 0 && resolved.startsWith('/') ? resolved : executable
}

/**
 * Probe, optionally install, and re-probe. Throws when the capability is
 * required and still unusable.
 * @param options - preflight inputs.
 * @returns the final capability and what produced it.
 */
export function runPwshPreflight(options: PreflightOptions = {}): PreflightResult {
  const env = options.env ?? process.env
  const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`))
  let capability = probePwshCapability({ env })
  let installed = false
  let installSource: PreflightResult['installSource'] = null
  if (!capability.available && (options.installDir !== undefined || options.tarball !== undefined)) {
    log(`pwsh-preflight: installing pinned PowerShell (${capability.reason}: ${capability.detail ?? 'no detail'})`)
    const installedPwsh = installPinnedPwsh(options)
    installed = true
    installSource = installedPwsh.source
    capability = probePwshCapability({ executable: installedPwsh.executable, env })
  }
  if (capability.available) {
    const absolute = resolveAbsoluteExecutable(capability.executable, env)
    capability = { ...capability, executable: absolute }
    if (absolute.startsWith('/')) {
      env[PWSH_EXECUTABLE_ENV] = absolute
      if (env.GITHUB_ENV !== undefined && env.GITHUB_ENV !== '') {
        appendFileSync(env.GITHUB_ENV, `${PWSH_EXECUTABLE_ENV}=${absolute}\n`)
      }
    }
  }
  const roundTrip = capability.available && probeRoundTrip(capability.executable, env)
  const result: PreflightResult = { capability, roundTrip, installed, installSource }
  log(`pwsh-preflight: ${JSON.stringify({
    available: capability.available,
    executable: capability.executable,
    reason: capability.reason,
    version: capability.version,
    architecture: capability.architecture,
    detail: capability.detail,
    roundTrip,
    installed,
    installSource,
  })}`)
  if (options.require === true && (!capability.available || !roundTrip)) {
    throw new Error(
      `PowerShell capability is required but unusable: ${capability.reason} at ${capability.executable}`
      + `${capability.detail === null ? '' : `: ${capability.detail}`}${roundTrip ? '' : ' (execution round trip failed)'}`,
    )
  }
  return result
}

/** Parse argv into preflight options. */
export function parsePreflightArgs(argv: string[]): PreflightOptions {
  const options: PreflightOptions = {}
  const value = (name: string, index: number): string => {
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) throw new Error(`${name} requires a value`)
    return next
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--require') options.require = true
    else if (arg === '--install-dir') options.installDir = value(arg, index++)
    else if (arg === '--tarball') options.tarball = value(arg, index++)
    else if (arg === '--sha256') options.sha256 = value(arg, index++)
    else throw new Error(`unknown preflight argument: ${arg ?? ''}`)
  }
  return options
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runPwshPreflight(parsePreflightArgs(process.argv.slice(2)))
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
