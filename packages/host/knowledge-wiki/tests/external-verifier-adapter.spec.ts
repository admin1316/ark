import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { generateKeyPairSync, sign } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createExternalVerifierAuthority,
  type ExternalVerifierOptions,
} from '../src/external-verifier-adapter.ts'
import {
  canonicalJson,
  sha256,
  type IndependentVerificationRequest,
  type IndependentVerificationResult,
} from '../src/verifier.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

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
  chmodSync(path, 0o755)
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
  const executable = verifierScript(result)
  return { keys, result, executable, publicKey, privateKey }
}

function authorityOptions(
  fixture: ReturnType<typeof authorityFixture>,
  overrides: Partial<ExternalVerifierOptions> = {},
): ExternalVerifierOptions {
  return {
    authorityId: 'launcher-verifier',
    sourceIdentity,
    executable: fixture.executable,
    publicKey: fixture.publicKey,
    privateKey: fixture.privateKey,
    ...overrides,
  }
}

describe('external verifier adapter', () => {
  it('verifies signed results and promotion seals from a launcher-owned child', async () => {
    const fixture = authorityFixture()
    const authority = createExternalVerifierAuthority({
      authorityId: 'launcher-verifier', sourceIdentity, executable: fixture.executable,
      publicKey: fixture.publicKey, privateKey: fixture.privateKey, timeoutMs: 5000,
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
      publicKey: fixture.keys.publicKey, privateKey: fixture.keys.privateKey,
    })
    objectAuthority.checkpointPromotion?.('promotion-payload', {
      phase: 'journal-persisted', operationIndex: -1,
    })
  })

  it('rejects an invalid signed result, times out, and requires an absolute executable', async () => {
    const fixture = authorityFixture()
    const authority = createExternalVerifierAuthority({
      authorityId: 'launcher-verifier', sourceIdentity, executable: fixture.executable,
      publicKey: fixture.publicKey, privateKey: fixture.privateKey,
    })
    const bad = { ...fixture.result, proof: Buffer.from('bad').toString('base64') }
    const badExecutable = verifierScript(bad)
    const badAuthority = createExternalVerifierAuthority({
      authorityId: 'launcher-verifier', sourceIdentity, executable: badExecutable,
      publicKey: fixture.publicKey, privateKey: fixture.privateKey,
    })
    await expect(badAuthority.verifyCandidate(request, new AbortController().signal)).rejects.toThrow('signature')

    const slow = verifierScript(fixture.result, 'setTimeout(() => {}, 5000)')
    const slowAuthority = createExternalVerifierAuthority({
      authorityId: 'launcher-verifier', sourceIdentity, executable: slow,
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
    const failingAuthority = createExternalVerifierAuthority(authorityOptions(fixture, { executable: failing }))
    await expect(failingAuthority.verifyCandidate(request, new AbortController().signal))
      .rejects.toThrow(/external verifier exited 7: x+/u)

    const signalled = verifierScript(fixture.result, `
process.kill(process.pid, 'SIGTERM')
`)
    const signalledAuthority = createExternalVerifierAuthority(authorityOptions(fixture, {
      executable: signalled,
    }))
    await expect(signalledAuthority.verifyCandidate(request, new AbortController().signal))
      .rejects.toThrow(/external verifier exited null \(SIGTERM\)/u)
  })

  it('rejects invalid JSON and output over the protocol budget', async () => {
    const fixture = authorityFixture()
    const invalidJson = verifierScript(fixture.result, `
process.stdout.write('not-json')
`)
    const invalidJsonAuthority = createExternalVerifierAuthority(authorityOptions(fixture, {
      executable: invalidJson,
    }))
    await expect(invalidJsonAuthority.verifyCandidate(request, new AbortController().signal))
      .rejects.toThrow(/JSON/u)

    const noisy = verifierScript(fixture.result, `
process.stdout.write('x'.repeat(256 * 1024 + 1))
`)
    const noisyAuthority = createExternalVerifierAuthority(authorityOptions(fixture, { executable: noisy }))
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
      const authority = createExternalVerifierAuthority(authorityOptions(fixture, { executable }))
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
      executable: hanging,
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
      executable: ignoresTerm,
      timeoutMs: 20,
    }))
    await expect(timeoutAuthority.verifyCandidate(request, new AbortController().signal))
      .rejects.toThrow('timed out')
    await new Promise(resolve => setTimeout(resolve, 150))
  })
})
