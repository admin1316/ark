/** Fail-safe TypeScript/Rust boundary for the knowledge-search shadow. */

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import type { Page } from './benchmark-knowledge-search.ts'
import { bm25 } from '../../packages/host/knowledge-wiki/src/search.ts'
import { isolatedChildEnvironment } from './process-isolation.ts'

export interface KnowledgeSearchRequest {
  readonly schemaVersion: 1
  readonly requestId: string
  readonly sessionId: string
  readonly generation: number
  readonly capability: string
  readonly deadlineMs: number
  readonly budget: number
  readonly cancellationToken: string
  readonly pages: readonly Page[]
  readonly queries: readonly string[]
}

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

function rustResults(binaryPath: string, request: KnowledgeSearchRequest, timeoutMs: number, signal?: AbortSignal): RustProcessOutput {
  const requestBytes = JSON.stringify(request)
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

function validateRequest(request: KnowledgeSearchRequest): void {
  const bytes = Buffer.byteLength(JSON.stringify(request), 'utf8')
  if (bytes > 8 * 1024 * 1024) throw new Error('Rust request exceeds 8 MiB')
  if (request.requestId.length === 0 || request.requestId.length > 256
    || request.sessionId.length === 0 || request.sessionId.length > 256) throw new Error('Rust request identity limit exceeded')
  if (!Number.isSafeInteger(request.generation) || request.generation < 0
    || request.capability !== 'knowledge-search'
    || !Number.isSafeInteger(request.deadlineMs) || request.deadlineMs <= 0
    || !Number.isSafeInteger(request.budget) || request.budget <= 0
    || request.cancellationToken.length === 0) throw new Error('Rust request control metadata is invalid')
  if (request.pages.length > 4096 || request.queries.length > 64) throw new Error('Rust request count limit exceeded')
  const invalidPage = request.pages.some((page) => {
    if (page.path.length === 0 || page.path.length > 1024 || page.aliases.length > 64) return true
    if (page.title.length > 128 * 1024 || page.text.length > 128 * 1024) return true
    return page.aliases.some(alias => alias.length > 128 * 1024)
  })
  if (invalidPage) {
    throw new Error('Rust page limit exceeded')
  }
  if (request.queries.some(query => query.length > 8192)) throw new Error('Rust query limit exceeded')
}

/** Execute search with shadow fallback or enforce fail-closed behavior. */
export function runKnowledgeSearchBoundary(
  request: KnowledgeSearchRequest,
  options: RustBoundaryOptions,
): RustBoundaryResult {
  validateRequest(request)
  const typescriptResults = request.queries.map(query => bm25([...request.pages], query))
  const typescriptDigest = digest(typescriptResults)
  try {
    if (options.binaryPath === undefined || options.binaryPath.trim() === '') throw new Error('Rust shadow binary is not configured')
    const processResult = rustResults(options.binaryPath, request, options.timeoutMs ?? 30_000, options.signal)
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
