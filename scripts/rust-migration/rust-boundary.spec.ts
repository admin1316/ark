import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runKnowledgeSearchBoundary, type KnowledgeSearchRequest } from './rust-boundary.ts'

const request: KnowledgeSearchRequest = {
  schemaVersion: 1,
  requestId: 'test-request-1',
  sessionId: 'test-session-1',
  generation: 1,
  capability: 'knowledge-search',
  deadlineMs: 30_000,
  budget: 1,
  cancellationToken: 'test-cancel-1',
  pages: [{ path: 'a.md', title: 'Runtime', aliases: [], text: 'verified replay' }],
  queries: ['verified replay'],
}

const binary = resolve('rust/knowledge-search-shadow/target/release/knowledge-search-shadow')

describe('Rust knowledge-search boundary', () => {
  it.each([
    ['generation zero', { ...request, generation: 0 }, 'control metadata'],
    ['UTF-8 identity', { ...request, requestId: '中'.repeat(86) }, 'identity limit'],
    ['UTF-8 page path', {
      ...request,
      pages: [{ ...request.pages[0]!, path: '中'.repeat(342) }],
    }, 'page limit'],
    ['UTF-8 query', { ...request, queries: ['😀'.repeat(2048) + 'x'] }, 'query limit'],
    ['query token count', {
      ...request,
      queries: [Array.from({ length: 257 }, () => 'runtime').join(' ')],
    }, 'query token limit'],
  ] satisfies Array<[string, KnowledgeSearchRequest, string]>)('rejects %s before candidate execution', (_label, invalid, reason) => {
    expect(() => runKnowledgeSearchBoundary(invalid, { mode: 'shadow' })).toThrow(reason)
  })

  it('falls back to TypeScript in shadow mode when Rust is unavailable', () => {
    const result = runKnowledgeSearchBoundary(request, { mode: 'shadow', binaryPath: '/missing/rust-shadow' })
    expect(result.source).toBe('typescript')
    expect(result.observation.status).toBe('fallback')
    expect(result.observation.matched).toBe(false)
  })

  it('fails closed in enforce mode when Rust is unavailable', () => {
    expect(() => runKnowledgeSearchBoundary(request, { mode: 'enforce', binaryPath: '/missing/rust-shadow' })).toThrow('failed closed')
  })

  it.skipIf(!existsSync(binary))('uses Rust only after matching the TypeScript result when a binary is available', () => {
    const result = runKnowledgeSearchBoundary(request, { mode: 'enforce', binaryPath: binary })
    expect(result.source).toBe('rust')
    expect(result.observation).toMatchObject({ attempted: true, matched: true, status: 'matched', timedOut: false, exitCode: 0, signal: null })
  })
})
