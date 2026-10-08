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

/** Build a child that emits a protocol-shaped response for a supplied result. */
function outputScript(results: unknown, mutate?: 'digest' | 'inputDigest'): string {
  const encodedResults = JSON.stringify(results)
  return candidateScript(`
const crypto = require('node:crypto')
const chunks = []
process.stdin.on('data', chunk => chunks.push(chunk))
process.stdin.on('end', () => {
  const input = Buffer.concat(chunks).toString('utf8')
  const results = ${encodedResults}
  const hash = value => crypto.createHash('sha256').update(value).digest('hex')
  const digest = hash(JSON.stringify(results))
  const inputDigest = hash(input)
  process.stdout.write(JSON.stringify({
    schemaVersion: 1,
    results,
    digest: ${mutate === 'digest' ? '\'0\'.repeat(64)' : 'digest'},
    inputDigest: ${mutate === 'inputDigest' ? '\'0\'.repeat(64)' : 'inputDigest'},
  }))
})
`)
}

function alteredRequest(patch: Record<string, unknown>): ReturnType<typeof request> {
  return { ...request(), ...patch }
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

  it('clamps protocol generation and budget at their safe bounds', () => {
    expect(createRustKnowledgeSearchRequest({
      sessionId: 'session-test', generation: 7.9, pages: [], query: 'runtime', budget: 0,
    })).toMatchObject({ generation: 7, budget: 1 })
    expect(createRustKnowledgeSearchRequest({
      sessionId: 'session-test', generation: -4, pages: [], query: 'runtime', budget: 5000,
    })).toMatchObject({ generation: 1, budget: 4096 })
  })

  it('falls back for every invalid request control and payload limit', async () => {
    const page = { path: 'page.md', title: 'title', aliases: [], text: 'body' }
    const invalid: Array<[string, Record<string, unknown>]> = [
      ['schema version', { schemaVersion: 2 }],
      ['capability', { capability: 'other' }],
      ['empty request id', { requestId: '' }],
      ['long request id', { requestId: 'x'.repeat(257) }],
      ['empty session id', { sessionId: '' }],
      ['long session id', { sessionId: 'x'.repeat(257) }],
      ['generation', { generation: 0 }],
      ['deadline', { deadlineMs: 0 }],
      ['budget', { budget: 0 }],
      ['cancellation token', { cancellationToken: '' }],
      ['page path', { pages: [{ ...page, path: '' }] }],
      ['long page path', { pages: [{ ...page, path: 'x'.repeat(1025) }] }],
      ['alias count', { pages: [{ ...page, aliases: Array.from({ length: 65 }, () => 'alias') }] }],
      ['page title', { pages: [{ ...page, title: 'x'.repeat(128 * 1024 + 1) }] }],
      ['page text', { pages: [{ ...page, text: 'x'.repeat(128 * 1024 + 1) }] }],
      ['page alias', { pages: [{ ...page, aliases: ['x'.repeat(128 * 1024 + 1)] }] }],
      ['query length', { queries: ['x'.repeat(8193)] }],
      ['query count', { queries: Array.from({ length: 65 }, () => 'query') }],
      ['page count', { pages: Array.from({ length: 4097 }, () => page) }],
    ]
    for (const [label, patch] of invalid) {
      const result = await runRustKnowledgeSearchCandidate(
        alteredRequest(patch), expected, { mode: 'shadow', binaryPath: validOutputScript() },
      )
      expect(result.observation.status, label).toBe('fallback')
      expect(result.observation.reason, label).toBeTruthy()
    }
  })

  it('rejects requests larger than the wire budget', async () => {
    const page = { path: 'page.md', title: 'title', aliases: [], text: 'x'.repeat(128 * 1024) }
    const result = await runRustKnowledgeSearchCandidate(
      alteredRequest({ pages: Array.from({ length: 70 }, () => page) }),
      expected,
      { mode: 'shadow', binaryPath: validOutputScript() },
    )
    expect(result.observation.status).toBe('fallback')
    expect(result.observation.reason).toContain('8 MiB')
  })

  it('is disabled without touching the candidate binary', async () => {
    const result = await runRustKnowledgeSearchCandidate(request(), expected, {
      mode: 'disabled',
      binaryPath: join(root, 'does-not-exist'),
    })
    expect(result.results).toEqual(expected)
    expect(result.source).toBe('typescript')
    expect(result.observation.attempted).toBe(false)
    expect(result.observation.status).toBe('disabled')
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

    const defaultDeadline = await runRustKnowledgeSearchCandidate(request(), expected, {
      mode: 'shadow', binaryPath: validOutputScript(),
    })
    expect(defaultDeadline.observation.status).toBe('matched')
  })

  it('rejects invalid hits and both digest bindings', async () => {
    const invalidOutputs: unknown[] = [
      null,
      [],
      { schemaVersion: 2, results: [[]], digest: '0'.repeat(64), inputDigest: '0'.repeat(64) },
      { schemaVersion: 1, results: [[null]], digest: '0'.repeat(64), inputDigest: '0'.repeat(64) },
      { schemaVersion: 1, results: [[{}]], digest: '0'.repeat(64), inputDigest: '0'.repeat(64) },
      { schemaVersion: 1, results: [[{ path: '', score: 1 }]], digest: '0'.repeat(64), inputDigest: '0'.repeat(64) },
      { schemaVersion: 1, results: [[{ path: 'page.md', score: Number.POSITIVE_INFINITY }]], digest: '0'.repeat(64), inputDigest: '0'.repeat(64) },
      { schemaVersion: 1, results: [[]], digest: 'bad', inputDigest: '0'.repeat(64) },
      { schemaVersion: 1, results: [[]], digest: '0'.repeat(64), inputDigest: 'bad' },
      { schemaVersion: 1, results: [[]], digest: '0'.repeat(64) },
      { schemaVersion: 1, results: [[]], inputDigest: '0'.repeat(64) },
    ]
    for (const value of invalidOutputs) {
      const script = candidateScript(`process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(JSON.stringify(${JSON.stringify(value)})))`)
      const result = await runRustKnowledgeSearchCandidate(request(), expected, {
        mode: 'shadow', binaryPath: script, timeoutMs: 5000,
      })
      expect(result.observation.status).toBe('fallback')
    }
    for (const mutate of ['digest', 'inputDigest'] as const) {
      const result = await runRustKnowledgeSearchCandidate(request(), expected, {
        mode: 'shadow', binaryPath: outputScript([[]], mutate), timeoutMs: 5000,
      })
      expect(result.observation.status).toBe('fallback')
      expect(result.observation.reason).toContain('digest mismatch')
    }
  })

  it('returns Rust output only after an exact enforce-mode match', async () => {
    const result = await runRustKnowledgeSearchCandidate(request(), expected, {
      mode: 'enforce', binaryPath: outputScript([[{ path: 'page.md', score: 1 }]]), timeoutMs: 5000,
    }).catch(() => undefined)
    // The output is intentionally divergent from the expected baseline, so enforce
    // must reject it rather than expose candidate data to the caller.
    expect(result).toBeUndefined()

    const matched = await runRustKnowledgeSearchCandidate(request(), expected, {
      mode: 'enforce', binaryPath: outputScript([[]]), timeoutMs: 5000,
    })
    expect(matched.source).toBe('rust')
    expect(matched.observation.status).toBe('matched')
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

    const badTimeout = await runRustKnowledgeSearchCandidate(request(), expected, {
      mode: 'shadow', binaryPath: validOutputScript(), timeoutMs: 0,
    })
    expect(badTimeout.observation.reason).toContain('outside 1..120000ms')

    const divergent = await runRustKnowledgeSearchCandidate(request(), expected, {
      mode: 'shadow', binaryPath: outputScript([[{ path: 'different.md', score: 1 }]]), timeoutMs: 5000,
    })
    expect(divergent.observation).toMatchObject({ status: 'fallback', matched: false })
    expect(divergent.observation.reason).toContain('result mismatch')
  })

  it('fails closed in enforce mode instead of returning a divergent candidate', async () => {
    await expect(runRustKnowledgeSearchCandidate(request(), expected, {
      mode: 'enforce',
      binaryPath: candidateScript('process.stdin.resume(); process.stdin.on("end", () => process.stdout.write("{}"))'),
      timeoutMs: 5000,
    })).rejects.toThrow('Rust candidate failed closed')
  })

  it('fails closed for invalid requests, paths, and timeouts in enforce mode', async () => {
    await expect(runRustKnowledgeSearchCandidate(
      alteredRequest({ budget: 0 }), expected,
      { mode: 'enforce', binaryPath: validOutputScript(), timeoutMs: 5000 },
    )).rejects.toThrow('control metadata')
    await expect(runRustKnowledgeSearchCandidate(request(), expected, {
      mode: 'enforce', binaryPath: '', timeoutMs: 5000,
    })).rejects.toThrow('not configured')
    await expect(runRustKnowledgeSearchCandidate(request(), expected, {
      mode: 'enforce', binaryPath: './candidate', timeoutMs: 5000,
    })).rejects.toThrow('must be absolute')
    await expect(runRustKnowledgeSearchCandidate(request(), expected, {
      mode: 'enforce', binaryPath: validOutputScript(), timeoutMs: 0,
    })).rejects.toThrow('outside 1..120000ms')

    const controller = new AbortController()
    controller.abort()
    await expect(runRustKnowledgeSearchCandidate(request(), expected, {
      mode: 'enforce', binaryPath: validOutputScript(), timeoutMs: 5000,
    }, controller.signal)).rejects.toThrow('failed closed: Rust candidate aborted')
  })

  it('falls back when the child exits nonzero and preserves bounded stderr', async () => {
    const failing = candidateScript(`
process.stdin.resume()
process.stdin.on('end', () => {
  process.stderr.write('x'.repeat(32 * 1024))
  setTimeout(() => process.stderr.write('y'.repeat(32 * 1024)), 5)
  setTimeout(() => { process.stderr.write('z'); process.exit(7) }, 15)
})
`)
    const result = await runRustKnowledgeSearchCandidate(request(), expected, {
      mode: 'shadow', binaryPath: failing, timeoutMs: 5000,
    })
    expect(result.observation.status).toBe('fallback')
    expect(result.observation.reason).toContain('exited 7')
    expect(result.observation.reason?.length).toBeLessThan(2200)

    const quietFailure = candidateScript('process.stdin.resume(); process.stdin.on(\'end\', () => process.exit(7))')
    const quietResult = await runRustKnowledgeSearchCandidate(request(), expected, {
      mode: 'shadow', binaryPath: quietFailure, timeoutMs: 5000,
    })
    expect(quietResult.observation.reason).toContain('exited 7')
  })

  it('falls back when candidate output exceeds the output budget', async () => {
    const noisy = candidateScript(`
process.stdin.resume()
process.stdin.on('end', () => process.stdout.write('x'.repeat(16 * 1024 * 1024 + 1)))
`)
    const result = await runRustKnowledgeSearchCandidate(request(), expected, {
      mode: 'shadow', binaryPath: noisy, timeoutMs: 5000,
    })
    expect(result.observation.status).toBe('fallback')
    expect(result.observation.reason).toContain('16 MiB')
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

  it('aborts a running child after it has been spawned', async () => {
    const hanging = candidateScript('process.stdin.resume(); setInterval(() => {}, 1000)')
    const controller = new AbortController()
    const pending = runRustKnowledgeSearchCandidate(request(), expected, {
      mode: 'shadow', binaryPath: hanging, timeoutMs: 5000,
    }, controller.signal)
    setTimeout(() => { controller.abort() }, 50)
    const result = await pending
    expect(result.observation).toMatchObject({ status: 'fallback', aborted: true, timedOut: false })
  })

  it('handles a signal that aborts at child-process entry', async () => {
    let reads = 0
    const signal = {
      get aborted() { reads += 1; return reads > 1 },
      addEventListener() {},
      removeEventListener() {},
    } as unknown as AbortSignal
    const result = await runRustKnowledgeSearchCandidate(request(), expected, {
      mode: 'shadow', binaryPath: validOutputScript(), timeoutMs: 1000,
    }, signal)
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

  it('escalates a child that ignores SIGTERM after a timeout', async () => {
    const ignoresTerm = candidateScript(`
process.on('SIGTERM', () => {})
process.stdin.resume()
setInterval(() => {}, 1000)
`)
    const result = await runRustKnowledgeSearchCandidate(request(), expected, {
      mode: 'shadow', binaryPath: ignoresTerm, timeoutMs: 20,
    })
    expect(result.observation).toMatchObject({ status: 'fallback', timedOut: true })
    // Keep the parent alive until the unref'd escalation timer has had a chance
    // to deliver SIGKILL to a child that ignored SIGTERM.
    await new Promise(resolve => setTimeout(resolve, 150))
  })
})
