/** Historical synchronous Rust experiment; request validation is owned by the candidate. */

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { bm25 } from '../../packages/host/knowledge-wiki/src/search.ts'
import {
  validateRustKnowledgeSearchRequest,
  type RustKnowledgeSearchRequest,
} from '../../packages/host/knowledge-wiki/src/rust-search-candidate.ts'
import { isolatedChildEnvironment } from './process-isolation.ts'

/** Shared request type retained under the historical experiment's import name. */
export type KnowledgeSearchRequest = RustKnowledgeSearchRequest

type RustBoundaryMode = 'shadow' | 'enforce'

export interface RustBoundaryOptions {
  readonly binaryPath?: string
  readonly mode: RustBoundaryMode
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

interface RustBoundaryObservation {
  readonly attempted: boolean
  readonly matched: boolean
  readonly status: 'matched' | 'fallback' | 'failed'
  readonly timedOut: boolean
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly reason?: string
}

export interface RustBoundaryResult {
  readonly results: readonly (readonly { readonly path: string; readonly score: number }[])[]
  readonly source: 'typescript' | 'rust'
  readonly digest: string
  readonly observation: RustBoundaryObservation
}

interface RustOutput {
  readonly schemaVersion: number
  readonly results: readonly (readonly { readonly path: string; readonly score: number }[])[]
  readonly digest: string
  readonly inputDigest: string
}

interface RustProcessOutput {
  readonly output: RustOutput
  readonly exitCode: number
  readonly signal: NodeJS.Signals | null
}

class RustProcessError extends Error {
  readonly timedOut: boolean
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null

  constructor(message: string, details: { timedOut: boolean; exitCode: number | null; signal: NodeJS.Signals | null }) {
    super(message)
    this.name = 'RustProcessError'
    this.timedOut = details.timedOut
    this.exitCode = details.exitCode
    this.signal = details.signal
  }
}

function canonicalResults(results: readonly (readonly { readonly path: string; readonly score: number }[])[]): string {
  return JSON.stringify(results)
}

function digest(results: readonly (readonly { readonly path: string; readonly score: number }[])[]): string {
  return createHash('sha256').update(canonicalResults(results)).digest('hex')
}

function rustResults(binaryPath: string, requestBytes: string, timeoutMs: number, signal?: AbortSignal): RustProcessOutput {
  const processResult = spawnSync(binaryPath, [], {
    input: requestBytes,
    encoding: 'utf8',
    timeout: timeoutMs,
    env: isolatedChildEnvironment(),
    signal,
  })
  const timedOut = processResult.error?.name === 'Error' && (processResult.error as NodeJS.ErrnoException).code === 'ETIMEDOUT'
  if (processResult.error !== undefined) {
    throw new RustProcessError(processResult.error.message, {
      timedOut,
      exitCode: processResult.status,
      signal: processResult.signal,
    })
  }
  if (processResult.status !== 0) {
    throw new RustProcessError(`Rust shadow exited ${String(processResult.status)}: ${processResult.stderr}`, {
      timedOut: false,
      exitCode: processResult.status,
      signal: processResult.signal,
    })
  }
  const output = JSON.parse(processResult.stdout) as RustOutput
  const validSchema = output.schemaVersion === 1
    && Array.isArray(output.results)
    && /^[a-f0-9]{64}$/u.test(output.digest)
    && /^[a-f0-9]{64}$/u.test(output.inputDigest)
  if (!validSchema) {
    throw new Error('Rust shadow output failed schema validation')
  }
  const expectedInputDigest = createHash('sha256').update(requestBytes).digest('hex')
  if (output.inputDigest !== expectedInputDigest) throw new Error('Rust shadow input digest mismatch')
  if (output.digest !== createHash('sha256').update(JSON.stringify(output.results)).digest('hex')) throw new Error('Rust shadow result digest mismatch')
  return { output, exitCode: processResult.status, signal: processResult.signal }
}

/** Execute search with shadow fallback or enforce fail-closed behavior. */
export function runKnowledgeSearchBoundary(
  request: KnowledgeSearchRequest,
  options: RustBoundaryOptions,
): RustBoundaryResult {
  const requestBytes = validateRustKnowledgeSearchRequest(request)
  const typescriptResults = request.queries.map(query => bm25([...request.pages], query))
  const typescriptDigest = digest(typescriptResults)
  try {
    if (options.binaryPath === undefined || options.binaryPath.trim() === '') throw new Error('Rust shadow binary is not configured')
    const processResult = rustResults(options.binaryPath, requestBytes, options.timeoutMs ?? 30_000, options.signal)
    const rustDigest = digest(processResult.output.results)
    const matched = canonicalResults(processResult.output.results) === canonicalResults(typescriptResults)
    if (!matched) throw new Error(`Rust shadow result mismatch: ${rustDigest} !== ${typescriptDigest}`)
    return {
      results: options.mode === 'enforce' ? processResult.output.results : typescriptResults,
      source: options.mode === 'enforce' ? 'rust' : 'typescript',
      digest: typescriptDigest,
      observation: {
        attempted: true,
        matched: true,
        status: 'matched',
        timedOut: false,
        exitCode: processResult.exitCode,
        signal: processResult.signal,
      },
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    if (options.mode === 'enforce') throw new Error(`Rust enforce failed closed: ${reason}`)
    const processError = error instanceof RustProcessError ? error : undefined
    return {
      results: typescriptResults,
      source: 'typescript',
      digest: typescriptDigest,
      observation: {
        attempted: true,
        matched: false,
        status: 'fallback',
        timedOut: processError?.timedOut ?? false,
        exitCode: processError?.exitCode ?? null,
        signal: processError?.signal ?? null,
        reason,
      },
    }
  }
}
