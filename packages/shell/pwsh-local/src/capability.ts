/**
 * PowerShell capability probe: the single owner of "can this host run pwsh".
 *
 * The pwsh-gated suites and the CI preflight must agree on availability, so a
 * suite can never skip silently while a preflight reports the tool present.
 * The probe records the executable, the version, the host architecture, and a
 * typed reason, with one bounded deadline per attempt.
 *
 * @module @deepseek-ai/dsh-pwsh-local/capability
 */

import { spawnSync } from 'node:child_process'
import { resolvePwshPath } from './resolve.ts'

/** Minimum supported PowerShell major version. */
export const MINIMUM_PWSH_MAJOR = 7

/** Why a host cannot run the pwsh-gated suites. */
export type PwshCapabilityReason =
  | 'OK'
  | 'NOT_FOUND'
  | 'NOT_EXECUTABLE'
  | 'TIMEOUT'
  | 'PROBE_FAILED'
  | 'VERSION_MISMATCH'

/** One capability observation. */
export interface PwshCapability {
  /** Executable the probe attempted. */
  executable: string
  /** Whether the executable ran the synthetic command successfully. */
  available: boolean
  /** Typed outcome, logged by the preflight and thrown in required mode. */
  reason: PwshCapabilityReason
  /** Parsed version, when the probe reached it. */
  version: string | null
  /** Reported host architecture, when the probe reached it. */
  architecture: string | null
  /** Human-readable detail for a non-OK reason. */
  detail: string | null
}

/** Probe inputs; every field defaults to the host environment. */
export interface PwshProbeOptions {
  /** Executable to probe; defaults to the shared resolver. */
  executable?: string
  /** Environment used for resolution and for the child process. */
  env?: NodeJS.ProcessEnv
  /** Single bounded deadline for the probe attempt. */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 15_000

/** Synthetic, profile-free, network-free command that proves execution. */
const PROBE_COMMAND =
  "$PSVersionTable.PSVersion.ToString() + ' ' + [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()"

/** Environment variable the complete coverage lane sets to require the tool. */
export const REQUIRE_PWSH_ENV = 'DSH_REQUIRE_PWSH'

/** Absolute executable resolved by a CI preflight, preferred over PATH lookup. */
export const PWSH_EXECUTABLE_ENV = 'DSH_PWSH_EXECUTABLE'

const CAPABILITY_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:[^\s]*)\s+(\S+)\s*$/m

/**
 * Probe PowerShell availability with one bounded attempt.
 * @param options - probe inputs.
 * @returns the typed capability observation.
 */
export function probePwshCapability(options: PwshProbeOptions = {}): PwshCapability {
  const env = options.env ?? process.env
  // A preflight-resolved absolute path removes the PATH-lookup failure mode
  // without changing the resolution rules a caller may still pass explicitly.
  const executable = options.executable
    ?? env[PWSH_EXECUTABLE_ENV]
    ?? resolvePwshPath(undefined, env)
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const result = spawnSync(
    executable,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', PROBE_COMMAND],
    { encoding: 'utf8', env, timeout },
  )
  const base = { executable, version: null, architecture: null } as const
  if (result.error !== undefined) {
    const code = (result.error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { ...base, available: false, reason: 'NOT_FOUND', detail: result.error.message }
    if (code === 'EACCES' || code === 'EPERM') {
      return { ...base, available: false, reason: 'NOT_EXECUTABLE', detail: result.error.message }
    }
    if (code === 'ETIMEDOUT' || result.signal !== null) {
      return { ...base, available: false, reason: 'TIMEOUT', detail: result.error.message }
    }
    return { ...base, available: false, reason: 'PROBE_FAILED', detail: result.error.message }
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || `exit ${result.status}`
    return { ...base, available: false, reason: 'PROBE_FAILED', detail }
  }
  const match = CAPABILITY_PATTERN.exec(result.stdout)
  if (match === null) {
    return {
      ...base,
      available: false,
      reason: 'PROBE_FAILED',
      detail: `unexpected probe output: ${JSON.stringify(result.stdout.trim().slice(0, 120))}`,
    }
  }
  const version = `${match[1]}.${match[2]}.${match[3]}`
  const architecture = match[4] ?? null
  if (Number(match[1]) < MINIMUM_PWSH_MAJOR) {
    return {
      available: false,
      executable,
      version,
      architecture,
      reason: 'VERSION_MISMATCH',
      detail: `requires PowerShell ${MINIMUM_PWSH_MAJOR}.x or newer`,
    }
  }
  return { executable, available: true, reason: 'OK', version, architecture, detail: null }
}

/**
 * Test-suite gate over the shared probe.
 *
 * A development host keeps the optional-suite skip; the complete coverage lane
 * sets {@link REQUIRE_PWSH_ENV} and this throws with the concrete reason
 * instead, so a required suite can never report a green skip.
 * @param options - probe inputs.
 * @returns whether the pwsh-gated suites may run.
 */
export function pwshTestsAvailable(options: PwshProbeOptions = {}): boolean {
  const capability = probePwshCapability(options)
  if (capability.available) return true
  const env = options.env ?? process.env
  if (env[REQUIRE_PWSH_ENV] === '1') {
    const detail = capability.detail === null ? '' : `: ${capability.detail}`
    throw new Error(
      `PowerShell is required (${REQUIRE_PWSH_ENV}=1) but unusable: ${capability.reason} at ${capability.executable}${detail}`,
    )
  }
  return false
}
