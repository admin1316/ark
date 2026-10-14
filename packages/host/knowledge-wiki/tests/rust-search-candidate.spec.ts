import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import {
  createRustKnowledgeSearchRequest,
  runRustKnowledgeSearchCandidate,
} from '../src/rust-search-candidate.ts'

const spawnObserver = vi.hoisted(() => ({
  onSpawn: undefined as ((child: unknown) => void) | undefined,
}))

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>()
  return {
    ...original,
    spawn: (...args: Parameters<typeof original.spawn>) => {
      const child = original.spawn(...args)
      spawnObserver.onSpawn?.(child)
      return child
    },
  }
})

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'knowledge-search-candidate-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function candidateScript(body: string): string {
  const path = join(root, process.platform === 'win32' ? 'candidate.cjs' : 'candidate')
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

  it('rejects UTF-8 and tokenizer overflow before starting a child', async () => {
    const page = { path: 'page.md', title: 'title', aliases: [], text: 'body' }
    const marker = join(root, 'started')
    const binary = candidateScript(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`)
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ requestId: '中'.repeat(86) }, 'identity limit'],
      [{ sessionId: '中'.repeat(86) }, 'identity limit'],
      [{ pages: [{ ...page, path: '中'.repeat(342) }] }, 'page limit'],
      [{ pages: [{ ...page, title: '中'.repeat(43691) }] }, 'page limit'],
      [{ pages: [{ ...page, text: '中'.repeat(43691) }] }, 'page limit'],
      [{ pages: [{ ...page, aliases: ['中'.repeat(43691)] }] }, 'page limit'],
      [{ queries: ['😀'.repeat(2048) + 'x'] }, 'query limit'],
      [{ queries: ['中'.repeat(129)] }, 'query token limit'],
      [{ queries: [Array(257).fill('runtime').join(' ')] }, 'query token limit'],
    ]
    for (const [patch, reason] of cases) {
      const result = await runRustKnowledgeSearchCandidate(
        alteredRequest(patch), expected, { mode: 'shadow', binaryPath: binary },
      )
      expect(result.results).toBe(expected)
      expect(result.observation).toMatchObject({ status: 'fallback', matched: false })
      expect(result.observation.reason).toContain(reason)
      await expect(runRustKnowledgeSearchCandidate(
        alteredRequest(patch), expected, { mode: 'enforce', binaryPath: binary },
      )).rejects.toThrow(new RegExp(`failed closed: .*${reason}`))
    }
    expect(existsSync(marker)).toBe(false)
  })

  it('accepts the exact UTF-8 byte and query token endpoints', async () => {
    const page = {
      path: '中'.repeat(341) + 'x',
      title: '中'.repeat(43690) + 'xx',
      aliases: ['中'.repeat(43690) + 'xx'],
      text: '中'.repeat(43690) + 'xx',
    }
    for (const query of ['中'.repeat(128) + 'a2', '😀'.repeat(2048), Array(256).fill('runtime').join(' ')]) {
      const result = await runRustKnowledgeSearchCandidate(
        alteredRequest({
          requestId: '中'.repeat(85) + 'x', sessionId: '中'.repeat(85) + 'x', pages: [page], queries: [query],
        }), expected, { mode: 'shadow', binaryPath: validOutputScript() },
      )
      expect(result.observation.status).toBe('matched')
      expect(result.results).toBe(expected)
    }
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

  it('supports an explicit executable with script arguments', async () => {
    const result = await runRustKnowledgeSearchCandidate(request(), expected, {
      mode: 'shadow',
      binaryPath: process.execPath,
      binaryArgs: [validOutputScript()],
      timeoutMs: 5000,
    })
    expect(result.observation.status).toBe('matched')
    expect(result.source).toBe('typescript')
  })

  it('launches a Node candidate script through the Node executable on Windows', async () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    try {
      const result = await runRustKnowledgeSearchCandidate(request(), expected, {
        mode: 'shadow',
        binaryPath: validOutputScript(),
        timeoutMs: 5000,
      })
      expect(result.observation.status).toBe('matched')
      expect(result.source).toBe('typescript')
    } finally {
      platform.mockRestore()
    }
  })

  it('rejects invalid hits and both digest bindings', async () => {
    const invalidOutputs: unknown[] = [
      null,
      [],
      { schemaVersion: 2, results: [[]], digest: '0'.repeat(64), inputDigest: '0'.repeat(64) },
      { schemaVersion: 1, results: [[null]], digest: '0'.repeat(64), inputDigest: '0'.repeat(64) },
      { schemaVersion: 1, results: [[{}]], digest: '0'.repeat(64), inputDigest: '0'.repeat(64) },
      { schemaVersion: 1, results: [[{ path: '', score: 1 }]], digest: '0'.repeat(64), inputDigest: '0'.repeat(64) },
      { schemaVersion: 1, results: [[{ path: 'x'.repeat(1025), score: 1 }]], digest: '0'.repeat(64), inputDigest: '0'.repeat(64) },
      { schemaVersion: 1, results: [[{ path: '中'.repeat(342), score: 1 }]], digest: '0'.repeat(64), inputDigest: '0'.repeat(64) },
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

  it('drops stderr emitted only after the parent confirms it collected the 64 KiB cap', async () => {
    const acknowledgement = join(root, 'stderr-cap-collected')
    const failing = candidateScript(`
const fs = require('node:fs')
process.stdin.resume()
process.stdin.on('end', () => {
  process.stderr.write('x'.repeat(64 * 1024), () => {
    const waitForAcknowledgement = setInterval(() => {
      if (!fs.existsSync(${JSON.stringify(acknowledgement)})) return
      clearInterval(waitForAcknowledgement)
      process.stderr.write('z', () => process.exit(7))
    }, 1)
  })
})
`)
    let collectedBytes = 0
    let postAcknowledgementBytes = 0
    let acknowledged = false
    spawnObserver.onSpawn = (child) => {
      const processChild = child as ChildProcessWithoutNullStreams
      processChild.stderr.on('data', (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(chunk)
        collectedBytes += bytes
        if (!acknowledged && collectedBytes >= 64 * 1024) {
          acknowledged = true
          writeFileSync(acknowledgement, 'collected')
        } else if (acknowledged) {
          postAcknowledgementBytes += bytes
        }
      })
    }
    try {
      const result = await runRustKnowledgeSearchCandidate(request(), expected, {
        mode: 'shadow', binaryPath: failing, timeoutMs: 5000,
      })
      expect(result.observation.status).toBe('fallback')
      expect(result.observation.reason).toContain('exited 7')
      expect(result.observation.reason?.length).toBeLessThan(2200)
      expect(acknowledged).toBe(true)
      expect(collectedBytes).toBeGreaterThanOrEqual(64 * 1024)
      expect(postAcknowledgementBytes).toBe(1)
    } finally {
      spawnObserver.onSpawn = undefined
    }
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
