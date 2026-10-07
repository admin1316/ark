/**
 * Optional Rust knowledge-search candidate boundary.
 *
 * The candidate is deliberately separate from the production TypeScript
 * search path.  `disabled` is the default, `shadow` always returns the
 * TypeScript baseline, and `enforce` fails closed unless the Rust response
 * is byte-identical to that baseline.  The child process receives no parent
 * credentials and is bounded by a request/output size, deadline, and abort
 * signal.
 *
 * @module @deepseek-ai/dsh-knowledge-wiki/rust-search-candidate
 */

import { createHash, randomUUID } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { isAbsolute } from 'node:path'
import type { SearchPage } from './search.ts'

const MAX_REQUEST_BYTES = 8 * 1024 * 1024
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024
const MAX_PAGES = 4096
const MAX_QUERIES = 64
const MAX_PAGE_BYTES = 128 * 1024
const MAX_PATH_BYTES = 1024
const MAX_QUERY_BYTES = 8192
const DEFAULT_TIMEOUT_MS = 30_000

const ALLOWED_ENVIRONMENT = [
  'PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL',
  'SYSTEMROOT', 'WINDIR', 'PATHEXT', 'CARGO_HOME', 'RUSTUP_HOME',
] as const

/** Runtime lane for the isolated Rust search candidate. */
export type RustKnowledgeSearchMode = 'disabled' | 'shadow' | 'enforce'

/** Options controlling candidate execution and its fail-safe mode. */
export interface RustKnowledgeSearchOptions {
  readonly mode: RustKnowledgeSearchMode
  readonly binaryPath: string
  readonly timeoutMs?: number
}

/** Versioned request sent to the isolated Rust search process. */
export interface RustKnowledgeSearchRequest {
  readonly schemaVersion: 1
  readonly requestId: string
  readonly sessionId: string
  readonly generation: number
  readonly capability: 'knowledge-search'
  readonly deadlineMs: number
  readonly budget: number
  readonly cancellationToken: string
  readonly pages: readonly SearchPage[]
  readonly queries: readonly string[]
}

/** One path and score returned by the Rust search candidate. */
export interface RustKnowledgeSearchHit {
  readonly path: string
  readonly score: number
}

/** Observable execution state for one Rust candidate comparison. */
export interface RustKnowledgeSearchObservation {
  readonly attempted: boolean
  readonly matched: boolean
  readonly status: 'disabled' | 'matched' | 'fallback' | 'failed'
  readonly timedOut: boolean
  readonly aborted: boolean
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly requestDigest?: string
  readonly resultDigest?: string
  readonly reason?: string
}

/** Candidate result, retaining the TypeScript result in shadow mode. */
export interface RustKnowledgeSearchResult {
  readonly results: readonly (readonly RustKnowledgeSearchHit[])[]
  readonly source: 'typescript' | 'rust'
  readonly observation: RustKnowledgeSearchObservation
}

interface RustOutput {
  readonly schemaVersion: number
  readonly results: readonly (readonly RustKnowledgeSearchHit[])[]
  readonly digest: string
  readonly inputDigest: string
}

interface ChildExit {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function canonicalResults(results: readonly (readonly RustKnowledgeSearchHit[])[]): string {
  return JSON.stringify(results)
}

function isolatedEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of ALLOWED_ENVIRONMENT) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

function validHit(value: unknown): value is RustKnowledgeSearchHit {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const hit = value as Record<string, unknown>
  return typeof hit.path === 'string'
    && hit.path.length > 0
    && hit.path.length <= MAX_PATH_BYTES
    && typeof hit.score === 'number'
    && Number.isFinite(hit.score)
}

function validateRequest(request: RustKnowledgeSearchRequest): string {
  const wire = request as unknown as Record<string, unknown>
  if (wire.schemaVersion !== 1 || wire.capability !== 'knowledge-search') {
    throw new Error('Rust candidate request contract is invalid')
  }
  if (request.requestId.length === 0 || request.requestId.length > 256
    || request.sessionId.length === 0 || request.sessionId.length > 256) {
    throw new Error('Rust candidate request identity limit exceeded')
  }
  if (!Number.isSafeInteger(request.generation) || request.generation < 1
    || !Number.isSafeInteger(request.deadlineMs) || request.deadlineMs <= 0
    || !Number.isSafeInteger(request.budget) || request.budget <= 0
    || request.cancellationToken.length === 0) {
    throw new Error('Rust candidate request control metadata is invalid')
  }
  if (request.pages.length > MAX_PAGES || request.queries.length > MAX_QUERIES) {
    throw new Error('Rust candidate request count limit exceeded')
  }
  for (const page of request.pages) {
    if (page.path.length === 0 || page.path.length > MAX_PATH_BYTES || page.aliases.length > 64
      || page.title.length > MAX_PAGE_BYTES || page.text.length > MAX_PAGE_BYTES
      || page.aliases.some(alias => alias.length > MAX_PAGE_BYTES)) {
      throw new Error('Rust candidate page limit exceeded')
    }
  }
  if (request.queries.some(query => query.length > MAX_QUERY_BYTES)) {
    throw new Error('Rust candidate query limit exceeded')
  }
  const requestBytes = JSON.stringify(request)
  if (Buffer.byteLength(requestBytes, 'utf8') > MAX_REQUEST_BYTES) {
    throw new Error('Rust candidate request exceeds 8 MiB')
  }
  return requestBytes
}

function validateOutput(value: unknown, requestBytes: string): RustOutput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Rust candidate output is not an object')
  }
  const output = value as Partial<RustOutput>
  if (output.schemaVersion !== 1 || !Array.isArray(output.results)
    || !/^[a-f0-9]{64}$/u.test(output.digest ?? '')
    || !/^[a-f0-9]{64}$/u.test(output.inputDigest ?? '')) {
    throw new Error('Rust candidate output failed schema validation')
  }
  if (!output.results.every(result => Array.isArray(result) && result.every(validHit))) {
    throw new Error('Rust candidate output contains an invalid hit')
  }
  const results = output.results
  const expectedInputDigest = digest(requestBytes)
  const expectedResultDigest = digest(canonicalResults(results))
  if (output.inputDigest !== expectedInputDigest) throw new Error('Rust candidate input digest mismatch')
  if (output.digest !== expectedResultDigest) throw new Error('Rust candidate result digest mismatch')
  return {
    schemaVersion: 1,
    results,
    digest: output.digest,
    inputDigest: output.inputDigest,
  }
}

function terminate(child: ChildProcessWithoutNullStreams): void {
  // `killed` only means that kill() was called; it does not mean the child
  // has exited. Use the exit fields for the escalation check.
  child.kill('SIGTERM')
  // A child that ignores SIGTERM must not remain attached to the host.
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }, 100).unref()
}

function spawnCandidate(binaryPath: string, requestBytes: string, timeoutMs: number, signal?: AbortSignal): Promise<{
  readonly output: RustOutput
  readonly exit: ChildExit
}> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(Object.assign(new Error('Rust candidate aborted'), { timedOut: false, aborted: true }))
      return
    }
    let settled = false
    let timedOut = false
    let aborted = false
    let stdoutBytes = 0
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    const timeoutRef: { current?: NodeJS.Timeout } = {}
    const child = spawn(binaryPath, [], {
      env: isolatedEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const finishReject = (error: Error): void => {
      if (settled) return
      settled = true
      if (timeoutRef.current !== undefined) clearTimeout(timeoutRef.current)
      signal?.removeEventListener('abort', abort)
      reject(Object.assign(error, { timedOut, aborted }))
    }
    const finishResolve = (exit: ChildExit): void => {
      if (settled) return
      settled = true
      if (timeoutRef.current !== undefined) clearTimeout(timeoutRef.current)
      signal?.removeEventListener('abort', abort)
      try {
        if (exit.code !== 0) {
          const detail = Buffer.concat(stderr).toString('utf8').slice(0, 2000)
          throw new Error(`Rust candidate exited ${String(exit.code)}${detail === '' ? '' : `: ${detail}`}`)
        }
        const raw = Buffer.concat(stdout).toString('utf8')
        resolve({ output: validateOutput(JSON.parse(raw) as unknown, requestBytes), exit })
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    }
    const abort = (): void => {
      aborted = true
      terminate(child)
      finishReject(new Error('Rust candidate aborted'))
    }
    child.stdout.on('data', (chunk: Buffer | string) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      stdoutBytes += value.byteLength
      if (stdoutBytes > MAX_OUTPUT_BYTES) {
        terminate(child)
        finishReject(new Error('Rust candidate output exceeds 16 MiB'))
        return
      }
      stdout.push(value)
    })
    child.stderr.on('data', (chunk: Buffer | string) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      if (Buffer.concat(stderr).byteLength < 64 * 1024) stderr.push(value)
    })
    child.once('error', (error) => { finishReject(error) })
    child.once('close', (code, childSignal) => { finishResolve({ code, signal: childSignal }) })
    signal?.addEventListener('abort', abort, { once: true })
    timeoutRef.current = setTimeout(() => {
      timedOut = true
      terminate(child)
      finishReject(new Error(`Rust candidate timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    timeoutRef.current.unref()
    child.stdin.end(requestBytes)
  })
}

function fallback(
  expected: readonly (readonly RustKnowledgeSearchHit[])[],
  observation: RustKnowledgeSearchObservation,
): RustKnowledgeSearchResult {
  return { results: expected, source: 'typescript', observation }
}

/**
 * Run one isolated Rust candidate comparison. Shadow mode is observational
 * and always returns the expected TypeScript result. Enforce mode is opt-in
 * and fails closed on missing, malformed, timed-out, cancelled, or divergent
 * candidates; it never silently falls back to Rust output.
 * @param request - Versioned request sent to the isolated child process.
 * @param expected - Canonical TypeScript result used as the comparison baseline.
 * @param options - Candidate mode, binary path, and execution deadline.
 * @param signal - Optional cancellation signal for the child process.
 * @returns The compared result and an execution observation.
 */
export async function runRustKnowledgeSearchCandidate(
  request: RustKnowledgeSearchRequest,
  expected: readonly (readonly RustKnowledgeSearchHit[])[],
  options: RustKnowledgeSearchOptions,
  signal?: AbortSignal,
): Promise<RustKnowledgeSearchResult> {
  if (options.mode === 'disabled') {
    return fallback(expected, {
      attempted: false,
      matched: false,
      status: 'disabled',
      timedOut: false,
      aborted: false,
      exitCode: null,
      signal: null,
    })
  }
  // Do not spawn a child after the caller has already cancelled the request.
  // This makes the observation deterministic when AbortSignal delivery races
  // with child-process creation.
  if (signal?.aborted === true) {
    const reason = 'Rust candidate aborted'
    if (options.mode === 'enforce') throw new Error(`Rust candidate failed closed: ${reason}`)
    return fallback(expected, {
      attempted: true,
      matched: false,
      status: 'fallback',
      timedOut: false,
      aborted: true,
      exitCode: null,
      signal: null,
      reason,
    })
  }
  let requestBytes: string
  try {
    requestBytes = validateRequest(request)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    if (options.mode === 'enforce') throw new Error(`Rust candidate failed closed: ${reason}`)
    return fallback(expected, {
      attempted: true,
      matched: false,
      status: 'fallback',
      timedOut: false,
      aborted: false,
      exitCode: null,
      signal: null,
      reason,
    })
  }
  if (options.binaryPath.trim() === '' || !isAbsolute(options.binaryPath)) {
    const reason = options.binaryPath.trim() === ''
      ? 'Rust candidate binary is not configured'
      : 'Rust candidate binary path must be absolute'
    if (options.mode === 'enforce') throw new Error(`Rust candidate failed closed: ${reason}`)
    return fallback(expected, {
      attempted: true,
      matched: false,
      status: 'fallback',
      timedOut: false,
      aborted: false,
      exitCode: null,
      signal: null,
      requestDigest: digest(requestBytes),
      reason,
    })
  }
  const requestDigest = digest(requestBytes)
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) {
    const reason = 'Rust candidate timeout is outside 1..120000ms'
    if (options.mode === 'enforce') throw new Error(`Rust candidate failed closed: ${reason}`)
    return fallback(expected, {
      attempted: true,
      matched: false,
      status: 'fallback',
      timedOut: false,
      aborted: false,
      exitCode: null,
      signal: null,
      requestDigest,
      reason,
    })
  }
  try {
    const processResult = await spawnCandidate(options.binaryPath, requestBytes, timeoutMs, signal)
    const expectedCanonical = canonicalResults(expected)
    const actualCanonical = canonicalResults(processResult.output.results)
    const matched = expectedCanonical === actualCanonical
    if (!matched) {
      const reason = `Rust candidate result mismatch: ${processResult.output.digest} !== ${digest(expectedCanonical)}`
      if (options.mode === 'enforce') throw new Error(`Rust candidate failed closed: ${reason}`)
      return fallback(expected, {
        attempted: true,
        matched: false,
        status: 'fallback',
        timedOut: false,
        aborted: false,
        exitCode: processResult.exit.code,
        signal: processResult.exit.signal,
        requestDigest,
        resultDigest: processResult.output.digest,
        reason,
      })
    }
    const observation: RustKnowledgeSearchObservation = {
      attempted: true,
      matched: true,
      status: 'matched',
      timedOut: false,
      aborted: false,
      exitCode: processResult.exit.code,
      signal: processResult.exit.signal,
      requestDigest,
      resultDigest: processResult.output.digest,
    }
    return {
      results: options.mode === 'enforce' ? processResult.output.results : expected,
      source: options.mode === 'enforce' ? 'rust' : 'typescript',
      observation,
    }
  } catch (error) {
    const candidateError = error as Error & { timedOut?: boolean; aborted?: boolean }
    const reason = candidateError.message
    const timedOut = candidateError.timedOut === true
    const aborted = candidateError.aborted === true
    if (options.mode === 'enforce') throw new Error(`Rust candidate failed closed: ${reason}`)
    return fallback(expected, {
      attempted: true,
      matched: false,
      status: 'fallback',
      timedOut,
      aborted,
      exitCode: null,
      signal: null,
      requestDigest,
      reason,
    })
  }
}

/**
 * Build protocol metadata for one model search invocation.
 * @param input - Session identity, corpus, query, budget, and timeout inputs.
 * @returns A validated versioned Rust candidate request.
 */
export function createRustKnowledgeSearchRequest(input: {
  readonly sessionId: string
  readonly generation: number
  readonly pages: readonly SearchPage[]
  readonly query: string
  readonly budget: number
  readonly timeoutMs?: number
}): RustKnowledgeSearchRequest {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return {
    schemaVersion: 1,
    requestId: randomUUID(),
    sessionId: input.sessionId,
    // Rust uses generation zero as an invalid/uninitialized lease. The host
    // starts its project generation at zero, so the first candidate request
    // is explicitly promoted to the protocol's first valid generation.
    generation: Math.max(1, Math.trunc(input.generation)),
    capability: 'knowledge-search',
    deadlineMs: Date.now() + timeoutMs,
    budget: Math.max(1, Math.min(4096, Math.trunc(input.budget))),
    cancellationToken: randomUUID(),
    pages: input.pages,
    queries: [input.query],
  }
}
