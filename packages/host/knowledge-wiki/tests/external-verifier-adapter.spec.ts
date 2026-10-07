import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { generateKeyPairSync, sign } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { createExternalVerifierAuthority } from '../src/external-verifier-adapter.ts'
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
})
