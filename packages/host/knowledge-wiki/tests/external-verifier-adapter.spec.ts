import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { generateKeyPairSync, sign } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import {
  createExternalVerifierAuthority as createAuthority,
  type ExternalVerifierOptions,
} from '../src/external-verifier-adapter.ts'
import {
  canonicalJson,
  sha256,
  type IndependentVerificationRequest,
  type IndependentVerificationResult,
} from '../src/verifier.ts'

const roots: string[] = []
const ownedPids = new Set<number>()
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const pid of ownedPids) {
    try { process.kill(pid, 'SIGKILL') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
  await waitUntil(() => [...ownedPids].every(pid => !pidAlive(pid)))
  ownedPids.clear()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function createExternalVerifierAuthority(options: ExternalVerifierOptions) {
  const ctx = new Context()
  contexts.push(ctx)
  const subprocess = new LocalSubprocessRuntime(ctx)
  return createAuthority(options, subprocess)
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

async function waitUntil(ready: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000
  while (!ready()) {
    if (Date.now() >= deadline) throw new Error('owned verifier fixture did not reach its expected state')
    await delay(10)
  }
}

const sourceIdentity = {
  commit: 'a'.repeat(40),
  sourceDigest: '1'.repeat(64),
  dirty: false,
  dirtyDigest: '2'.repeat(64),
  buildDigest: '3'.repeat(64),
} as const

const request = {
  schemaVersion: 2,
  review: { id: 'review-1', resolved: false },
  reviewHash: '4'.repeat(64),
  candidatePath: '_candidates/topic.md',
  candidateHash: '5'.repeat(64),
  sourceHash: '6'.repeat(64),
  targetPath: 'concepts/topic.md',
  governanceAction: 'Promote',
  governanceDecision: { action: 'Promote', targetPath: 'concepts/topic.md', policyVersion: 'test' },
  sourceIdentity,
  environment: { nodeVersion: process.versions.node, platform: process.platform, arch: process.arch, policyVersion: 'test' },
} as const satisfies IndependentVerificationRequest

function verifierScript(result: IndependentVerificationResult, suffix = ''): string {
  const root = mkdtempSync(join(tmpdir(), 'external-verifier-adapter-'))
  roots.push(root)
  const path = join(root, 'verifier.mjs')
  writeFileSync(path, `#!/usr/bin/env node\nprocess.stdin.resume(); process.stdin.on('end', () => process.stdout.write(${JSON.stringify(JSON.stringify(result))}));${suffix}\n`)
  return path
}

function authorityFixture() {
  const keys = generateKeyPairSync('ed25519')
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const unsigned = {
    authorityId: 'launcher-verifier',
    requestHash: sha256(canonicalJson(request)),
    result: 'pass' as const,
    methods: ['integration_test' as const],
    outcomes: [{ name: 'signed-check', result: 'pass' as const, evidence: ['external command checked the canonical request'] }],
    issuedAt: '2026-10-08T00:00:00.000Z',
  }
  const result: IndependentVerificationResult = {
    ...unsigned,
    proof: sign(null, Buffer.from(canonicalJson(unsigned)), keys.privateKey).toString('base64'),
  }
  const script = verifierScript(result)
  return { keys, result, executable: process.execPath, args: [script], publicKey, privateKey }
}

function authorityOptions(
  fixture: ReturnType<typeof authorityFixture>,
  overrides: Partial<ExternalVerifierOptions> = {},
): ExternalVerifierOptions {
  return {
    authorityId: 'launcher-verifier',
    sourceIdentity,
    executable: fixture.executable,
    args: fixture.args,
    publicKey: fixture.publicKey,
    privateKey: fixture.privateKey,
    ...overrides,
  }
}

describe('external verifier adapter', () => {
  it('keeps an ordinary unlisted ambient value out of the managed verifier child', async () => {
    const fixture = authorityFixture()
    const name = 'ARK_VERIFIER_TEST_UNLISTED'
    const previous = process.env[name]
    process.env[name] = 'fixture-must-not-cross'
    try {
      const script = verifierScript(fixture.result, `
if (process.env.${name} !== undefined) process.exit(88)
`)
      const authority = createExternalVerifierAuthority(authorityOptions(fixture, { args: [script] }))
      await expect(authority.verifyCandidate(request, new AbortController().signal)).resolves.toEqual(fixture.result)
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, name)
      else process.env[name] = previous
    }
  })

  it.skipIf(process.platform === 'win32').each(['abort', 'timeout', 'overflow', 'success', 'dispose'] as const)(
    'joins the owned leader and TERM-trapping helper before settling %s',
    async (mode) => {
      const fixture = authorityFixture()
      const root = roots.at(-1)!
      const pidFile = join(root, 'owned-pids.json')
      const executable = join(root, 'owned-tree.mjs')
      const helper = 'process.on(\'SIGTERM\', () => {}); process.send(process.pid); setInterval(() => {}, 1000)'
      writeFileSync(executable, `
import { spawn } from 'node:child_process'
import { renameSync, writeFileSync } from 'node:fs'
process.on('SIGTERM', () => {})
process.stdin.resume()
const helper = spawn(process.execPath, ['-e', ${JSON.stringify(helper)}], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
helper.once('message', pid => {
  writeFileSync(${JSON.stringify(pidFile + '.tmp')}, JSON.stringify([process.pid, pid]))
  renameSync(${JSON.stringify(pidFile + '.tmp')}, ${JSON.stringify(pidFile)})
  process.stdout.write(${JSON.stringify(JSON.stringify(fixture.result))})
  ${mode === 'overflow' ? 'process.stdout.write(\'x\'.repeat(2 * 1024 * 1024))' : ''}
  ${mode === 'success' ? 'process.exit(0)' : 'setInterval(() => {}, 1000)'}
})
`)
      const controller = new AbortController()
      const authority = createExternalVerifierAuthority(authorityOptions(fixture, {
        args: [executable], timeoutMs: mode === 'timeout' ? 1000 : 5000,
      }))
      const pending = authority.verifyCandidate(request, controller.signal)
      // Observe every settlement immediately, including output overflow before the readiness poll.
      const outcome = pending.then(value => ({ value }), (error: unknown) => ({ error }))
      await waitUntil(() => existsSync(pidFile))
      const pids = JSON.parse(readFileSync(pidFile, 'utf8')) as number[]
      for (const pid of pids) ownedPids.add(pid)
      if (mode === 'abort') controller.abort()
      if (mode === 'dispose') await contexts.at(-1)!.fiber.dispose()
      const result = await outcome
      if (mode === 'success') expect(result).toEqual({ value: fixture.result })
      else expect('error' in result && result.error instanceof Error && result.error.message).toMatch(
        mode === 'abort' ? /aborted/u : mode === 'timeout' ? /timed out/u : mode === 'dispose' ? /exited/u : /output exceeds/u,
      )
      expect(pids.map(pidAlive)).toEqual([false, false])
    },
  )

  it('verifies signed results and promotion seals from a launcher-owned child', async () => {
    const fixture = authorityFixture()
    const authority = createExternalVerifierAuthority({
      authorityId: 'launcher-verifier', sourceIdentity, executable: fixture.executable,
      args: fixture.args, publicKey: fixture.publicKey, privateKey: fixture.privateKey, timeoutMs: 5000,
    })
    expect(Object.isFrozen(authority.sourceIdentity())).toBe(true)
    await expect(authority.verifyCandidate(request, new AbortController().signal)).resolves.toEqual(fixture.result)
    expect(authority.validateCandidateResult(request, fixture.result)).toBe(true)
    const seal = authority.sealPromotion('promotion-payload')
    expect(authority.validatePromotion('promotion-payload', seal)).toBe(true)
    expect(authority.validatePromotion('tampered', seal)).toBe(false)

    // The launcher can retain parsed KeyObjects, and the optional checkpoint
    // hook is part of the authority surface even when it has no side effect.
    const objectAuthority = createExternalVerifierAuthority({
      authorityId: 'launcher-verifier', sourceIdentity, executable: fixture.executable,
      args: fixture.args, publicKey: fixture.keys.publicKey, privateKey: fixture.keys.privateKey,
    })
    objectAuthority.checkpointPromotion?.('promotion-payload', {
      phase: 'journal-persisted', operationIndex: -1,
    })
  })

  it('rejects an invalid signed result, times out, and requires an absolute executable', async () => {
    const fixture = authorityFixture()
    const authority = createExternalVerifierAuthority({
      authorityId: 'launcher-verifier', sourceIdentity, executable: fixture.executable,
      args: fixture.args, publicKey: fixture.publicKey, privateKey: fixture.privateKey,
    })
    const bad = { ...fixture.result, proof: Buffer.from('bad').toString('base64') }
    const badExecutable = verifierScript(bad)
    const badAuthority = createExternalVerifierAuthority({
      authorityId: 'launcher-verifier', sourceIdentity, executable: process.execPath, args: [badExecutable],
      publicKey: fixture.publicKey, privateKey: fixture.privateKey,
    })
    await expect(badAuthority.verifyCandidate(request, new AbortController().signal)).rejects.toThrow('signature')

    const slow = verifierScript(fixture.result, 'setTimeout(() => {}, 5000)')
    const slowAuthority = createExternalVerifierAuthority({
      authorityId: 'launcher-verifier', sourceIdentity, executable: process.execPath, args: [slow],
      publicKey: fixture.publicKey, privateKey: fixture.privateKey, timeoutMs: 20,
    })
    await expect(slowAuthority.verifyCandidate(request, new AbortController().signal)).rejects.toThrow('timed out')
    expect(() => createExternalVerifierAuthority({
      authorityId: 'launcher-verifier', sourceIdentity, executable: './verifier',
      publicKey: fixture.publicKey, privateKey: fixture.privateKey,
    })).toThrow('absolute')
    void authority
  })

  it('rejects invalid launcher-owned authority configuration', () => {
    const fixture = authorityFixture()
    const invalidIdentities: Array<[string, Record<string, unknown>]> = [
      ['commit', { commit: 'bad' }],
      ['source digest', { sourceDigest: 'bad' }],
      ['dirty digest', { dirtyDigest: 'bad' }],
      ['build digest', { buildDigest: 'bad' }],
      ['dirty flag', { dirty: 'false' }],
    ]
    for (const [label, patch] of invalidIdentities) {
      expect(() => createExternalVerifierAuthority(authorityOptions(fixture, {
        sourceIdentity: { ...sourceIdentity, ...patch },
      })), label).toThrow('source identity')
    }

    expect(() => createExternalVerifierAuthority(authorityOptions(fixture, { authorityId: '' })))
      .toThrow('authorityId')
    expect(() => createExternalVerifierAuthority(authorityOptions(fixture, { authorityId: 'bad space' })))
      .toThrow('authorityId')
    expect(() => createExternalVerifierAuthority(authorityOptions(fixture, { timeoutMs: 0 })))
      .toThrow('timeout')
    expect(() => createExternalVerifierAuthority(authorityOptions(fixture, { timeoutMs: 120_001 })))
      .toThrow('timeout')

    const otherKeys = generateKeyPairSync('ed25519')
    expect(() => createExternalVerifierAuthority(authorityOptions(fixture, {
      privateKey: otherKeys.privateKey,
    }))).toThrow('keypair')
  })

  it('fails closed for an already-aborted verification request', async () => {
    const fixture = authorityFixture()
    const authority = createExternalVerifierAuthority(authorityOptions(fixture))
    const controller = new AbortController()
    controller.abort()
    await expect(authority.verifyCandidate(request, controller.signal)).rejects.toThrow('aborted')
  })

  it('reports child spawn failures and bounded stderr for nonzero exits', async () => {
    const fixture = authorityFixture()
    const authority = createExternalVerifierAuthority(authorityOptions(fixture, {
      executable: join(tmpdir(), 'missing-external-verifier-command'),
    }))
    await expect(authority.verifyCandidate(request, new AbortController().signal)).rejects.toThrow()

    const failing = verifierScript(fixture.result, `
process.stderr.write('x'.repeat(12 * 1024))
setTimeout(() => {
  process.stderr.write('y'.repeat(12 * 1024))
  process.exit(7)
}, 100)
`)
    const failingAuthority = createExternalVerifierAuthority(authorityOptions(fixture, { args: [failing] }))
    await expect(failingAuthority.verifyCandidate(request, new AbortController().signal))
      .rejects.toThrow(/external verifier exited 7: x+/u)

    const signalled = verifierScript(fixture.result, `
process.kill(process.pid, 'SIGTERM')
`)
    const signalledAuthority = createExternalVerifierAuthority(authorityOptions(fixture, {
      args: [signalled],
    }))
    await expect(signalledAuthority.verifyCandidate(request, new AbortController().signal))
      .rejects.toThrow(/external verifier exited (?:null \(SIGTERM\)|\d+)/u)
  })

  it('rejects invalid JSON and output over the protocol budget', async () => {
    const fixture = authorityFixture()
    const invalidJson = verifierScript(fixture.result, `
process.stdout.write('not-json')
`)
    const invalidJsonAuthority = createExternalVerifierAuthority(authorityOptions(fixture, {
      args: [invalidJson],
    }))
    await expect(invalidJsonAuthority.verifyCandidate(request, new AbortController().signal))
      .rejects.toThrow(/JSON/u)

    const noisy = verifierScript(fixture.result, `
process.stdout.write('x'.repeat(2 * 1024 * 1024))
`)
    const noisyAuthority = createExternalVerifierAuthority(authorityOptions(fixture, { args: [noisy] }))
    await expect(noisyAuthority.verifyCandidate(request, new AbortController().signal))
      .rejects.toThrow('output exceeds 256 KiB')
  })

  it('rejects malformed signed result fields and promotion seals', async () => {
    const fixture = authorityFixture()
    const fields: Array<[string, Partial<IndependentVerificationResult>]> = [
      ['authority', { authorityId: 'other-authority' }],
      ['request hash', { requestHash: '0'.repeat(64) }],
      ['proof', { proof: '' }],
      ['methods', { methods: [] }],
      ['outcomes', { outcomes: [] }],
      ['issuedAt', { issuedAt: 'not-a-date' }],
    ]
    for (const [label, patch] of fields) {
      const executable = verifierScript({ ...fixture.result, ...patch })
      const authority = createExternalVerifierAuthority(authorityOptions(fixture, { args: [executable] }))
      await expect(authority.verifyCandidate(request, new AbortController().signal), label)
        .rejects.toThrow('signature or request binding')
    }

    const authority = createExternalVerifierAuthority(authorityOptions(fixture))
    const seal = authority.sealPromotion('payload')
    expect(authority.validatePromotion('payload', { ...seal, authorityId: 'other' })).toBe(false)
    expect(authority.validatePromotion('payload', { ...seal, proof: 'bad' })).toBe(false)
  })

  it('aborts a running verifier and escalates a child that ignores SIGTERM', async () => {
    const fixture = authorityFixture()
    const hanging = verifierScript(fixture.result, `
setInterval(() => {}, 1000)
`)
    const authority = createExternalVerifierAuthority(authorityOptions(fixture, {
      args: [hanging],
      timeoutMs: 5_000,
    }))
    const controller = new AbortController()
    const pending = authority.verifyCandidate(request, controller.signal)
    setTimeout(() => { controller.abort() }, 25)
    await expect(pending).rejects.toThrow('aborted')

    const ignoresTerm = verifierScript(fixture.result, `
process.on('SIGTERM', () => {})
setInterval(() => {}, 1000)
`)
    const timeoutAuthority = createExternalVerifierAuthority(authorityOptions(fixture, {
      args: [ignoresTerm],
      timeoutMs: 1000,
    }))
    await expect(timeoutAuthority.verifyCandidate(request, new AbortController().signal))
      .rejects.toThrow('timed out')
    await new Promise(resolve => setTimeout(resolve, 150))
  })
})
