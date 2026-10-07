import {
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createRustKnowledgeSearchRequest,
  runRustKnowledgeSearchCandidate,
} from '../src/rust-search-candidate.ts'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'knowledge-search-candidate-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function candidateScript(body: string): string {
  const path = join(root, 'candidate')
  writeFileSync(path, `#!/usr/bin/env node\n${body}\n`, 'utf8')
  chmodSync(path, 0o755)
  return path
}

function request() {
  return createRustKnowledgeSearchRequest({
    sessionId: 'session-test',
    generation: 3,
    pages: [],
    query: 'runtime',
    budget: 8,
    timeoutMs: 5000,
  })
}

const expected = [[]]

function validOutputScript(): string {
  return candidateScript(`
const crypto = require('node:crypto')
const chunks = []
process.stdin.on('data', chunk => chunks.push(chunk))
process.stdin.on('end', () => {
  const input = Buffer.concat(chunks).toString('utf8')
  const results = [[]]
  const hash = value => crypto.createHash('sha256').update(value).digest('hex')
  process.stdout.write(JSON.stringify({ schemaVersion: 1, results, digest: hash(JSON.stringify(results)), inputDigest: hash(input) }))
})
`)
}

describe('rust knowledge-search candidate boundary', () => {
  it('maps the host initial generation to the Rust protocol first generation', () => {
    expect(createRustKnowledgeSearchRequest({
      sessionId: 'session-test',
      generation: 0,
      pages: [],
      query: 'runtime',
      budget: 1,
    }).generation).toBe(1)
  })

  it('is disabled without touching the candidate binary', async () => {
    const result = await runRustKnowledgeSearchCandidate(request(), expected, {
      mode: 'disabled',
      binaryPath: join(root, 'does-not-exist'),
    })
    expect(result).toEqual({
      results: expected,
      source: 'typescript',
      observation: expect.objectContaining({
        attempted: false,
        status: 'disabled',
      }),
    })
  })

  it('matches in shadow mode while retaining the TypeScript source', async () => {
    const result = await runRustKnowledgeSearchCandidate(request(), expected, {
      mode: 'shadow',
      binaryPath: validOutputScript(),
      timeoutMs: 5000,
    })
    expect(result.results).toEqual(expected)
    expect(result.source).toBe('typescript')
    expect(result.observation).toMatchObject({ attempted: true, matched: true, status: 'matched' })
    expect(result.observation.requestDigest).toMatch(/^[a-f0-9]{64}$/u)
    expect(result.observation.resultDigest).toMatch(/^[a-f0-9]{64}$/u)
  })

  it('falls back in shadow mode when the binary is missing or malformed', async () => {
    const missing = await runRustKnowledgeSearchCandidate(request(), expected, {
      mode: 'shadow',
      binaryPath: join(root, 'does-not-exist'),
      timeoutMs: 5000,
    })
    expect(missing.source).toBe('typescript')
    expect(missing.observation.status).toBe('fallback')

    const malformed = await runRustKnowledgeSearchCandidate(request(), expected, {
      mode: 'shadow',
      binaryPath: candidateScript('process.stdin.resume(); process.stdin.on("end", () => process.stdout.write("{}"))'),
      timeoutMs: 5000,
    })
    expect(malformed.source).toBe('typescript')
    expect(malformed.observation.status).toBe('fallback')

    const relative = await runRustKnowledgeSearchCandidate(request(), expected, {
      mode: 'shadow',
      binaryPath: './candidate',
      timeoutMs: 1000,
    })
    expect(relative.source).toBe('typescript')
    expect(relative.observation.reason).toContain('must be absolute')
  })

  it('fails closed in enforce mode instead of returning a divergent candidate', async () => {
    await expect(runRustKnowledgeSearchCandidate(request(), expected, {
      mode: 'enforce',
      binaryPath: candidateScript('process.stdin.resume(); process.stdin.on("end", () => process.stdout.write("{}"))'),
      timeoutMs: 5000,
    })).rejects.toThrow('Rust candidate failed closed')
  })

  it('turns an already-cancelled shadow request into a TypeScript fallback', async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await runRustKnowledgeSearchCandidate(request(), expected, {
      mode: 'shadow',
      binaryPath: validOutputScript(),
      timeoutMs: 1000,
    }, controller.signal)
    expect(result.source).toBe('typescript')
    expect(result.observation).toMatchObject({ status: 'fallback', aborted: true })
  })

  it('kills a timed-out shadow child and keeps the TypeScript result', async () => {
    const slow = candidateScript('process.stdin.resume(); setTimeout(() => {}, 5000)')
    const result = await runRustKnowledgeSearchCandidate(request(), expected, {
      mode: 'shadow',
      binaryPath: slow,
      timeoutMs: 50,
    })
    expect(result.source).toBe('typescript')
    expect(result.observation).toMatchObject({ status: 'fallback', timedOut: true })
  })
})
