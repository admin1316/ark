/**
 * PowerShell capability probe: the single owner of "can this host run pwsh".
 *
 * The pwsh-gated suites and the CI preflight must agree on availability, so a
 * suite can never skip silently while a preflight reports the tool present.
 * Outcome classification is a pure function over the spawn result, so every
 * reason is unit-testable without depending on how a platform reports a
 * timeout or a denied executable.
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

/** One capability observation; `detail` is empty only for `OK`. */
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
  /** Explanation for a non-OK reason; empty string when available. */
  detail: string
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

/** One spawn outcome, decoupled from `spawnSync` so classification is pure. */
export interface PwshProbeOutcome {
  /** Executable the probe attempted. */
  executable: string
  /** Spawn-level failure, when the process could not run. */
  error?: NodeJS.ErrnoException | undefined
  /** Exit status; `null` when the child was terminated. */
  status: number | null
  /** Terminating signal, when the child was killed. */
  signal: NodeJS.Signals | null
  /** Child standard output. */
  stdout: string
  /** Child standard error. */
  stderr: string
}

const DEFAULT_TIMEOUT_MS = 15_000

/** Synthetic, profile-free, network-free command that proves execution. */
const PROBE_COMMAND =
  "$PSVersionTable.PSVersion.ToString() + ' ' + [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()"

/** Environment variable the complete coverage lane sets to require the tool. */
export const REQUIRE_PWSH_ENV = 'DSH_REQUIRE_PWSH'

/** Absolute executable resolved by a CI preflight, preferred over PATH lookup. */
export const PWSH_EXECUTABLE_ENV = 'DSH_PWSH_EXECUTABLE'

const CAPABILITY_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:[^\s]*)(?:\s+(\S+))?\s*$/m

/** Spawn error codes that already name the capability outcome. */
const ERROR_REASONS: Record<string, PwshCapabilityReason> = {
  ENOENT: 'NOT_FOUND',
  EACCES: 'NOT_EXECUTABLE',
  EPERM: 'NOT_EXECUTABLE',
  ETIMEDOUT: 'TIMEOUT',
}

/**
 * Classify one spawn outcome into a capability observation.
 * @param outcome - captured spawn result.
 * @returns the typed capability, including the reason and detail.
 */
export function classifyPwshProbe(outcome: PwshProbeOutcome): PwshCapability {
  const base = { executable: outcome.executable, version: null, architecture: null }
  if (outcome.error !== undefined) {
    const reason = ERROR_REASONS[outcome.error.code ?? ''] ?? (outcome.signal === null ? 'PROBE_FAILED' : 'TIMEOUT')
    return { ...base, available: false, reason, detail: outcome.error.message }
  }
  if (outcome.status === null) {
    return {
      ...base,
      available: false,
      reason: 'TIMEOUT',
      detail: `terminated by ${outcome.signal ?? 'unknown signal'}`,
    }
  }
  if (outcome.status !== 0) {
    return {
      ...base,
      available: false,
      reason: 'PROBE_FAILED',
      detail: outcome.stderr.trim() || `exit ${outcome.status}`,
    }
  }
  const match = CAPABILITY_PATTERN.exec(outcome.stdout)
  if (match === null) {
    return {
      ...base,
      available: false,
      reason: 'PROBE_FAILED',
      detail: `unexpected probe output: ${JSON.stringify(outcome.stdout.trim().slice(0, 120))}`,
    }
  }
  const version = `${match[1]}.${match[2]}.${match[3]}`
  const architecture = match[4] ?? null
  if (Number(match[1]) < MINIMUM_PWSH_MAJOR) {
    return {
      ...base,
      available: false,
      version,
      architecture,
      reason: 'VERSION_MISMATCH',
      detail: `requires PowerShell ${MINIMUM_PWSH_MAJOR}.x or newer`,
    }
  }
  return { executable: outcome.executable, available: true, reason: 'OK', version, architecture, detail: '' }
}

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
  const result = spawnSync(
    executable,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', PROBE_COMMAND],
    { encoding: 'utf8', env, timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS },
  )
  return classifyPwshProbe({
    executable,
    error: result.error,
    status: result.status,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
  })
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
  // Resolve the environment once and reuse it: the gate must judge the same
  // environment it probed, and the ambient default is part of every suite call.
  const env = options.env ?? process.env
  const capability = probePwshCapability({ ...options, env })
  if (capability.available) return true
  if (env[REQUIRE_PWSH_ENV] === '1') {
    throw new Error(
      `PowerShell is required (${REQUIRE_PWSH_ENV}=1) but unusable: ${capability.reason} at ${capability.executable}: ${capability.detail}`,
    )
  }
  return false
}
