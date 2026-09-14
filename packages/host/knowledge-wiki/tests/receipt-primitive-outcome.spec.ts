import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalJson, readTrustedReceipt, sha256 } from '../src/verifier.ts'
import { verifierAuthority } from './verifier-authority-fixture.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('stored receipt outcome shape', () => {
  it('rejects a receipt whose outcomes are not independent outcome objects', () => {
    const root = mkdtempSync(join(tmpdir(), 'wiki-receipt-primitive-'))
    roots.push(root)
    const reviewFile = join(root, 'review.json')
    const authority = verifierAuthority()
    const receipts = join(dirname(reviewFile), 'verification-receipts')
    mkdirSync(receipts, { recursive: true })

    const request = { schemaVersion: 2 }
    const result = {
      authorityId: 'test-independent-verifier',
      requestHash: sha256(canonicalJson(request)),
      result: 'pass',
      methods: ['integration_test'],
      outcomes: ['a plain string outcome'],
      issuedAt: '2026-09-04T00:00:00.000Z',
      proof: 'independent-proof',
    }
    // The receipt hash covers the id-less payload (readTrustedReceipt strips id).
    const unsigned = { schemaVersion: 2, request, result }
    const receiptHash = sha256(canonicalJson(unsigned))
    writeFileSync(
      join(receipts, 'verification-primitive-outcome.json'),
      JSON.stringify({ ...unsigned, id: 'verification-primitive-outcome', receiptHash }),
      'utf8',
    )
    expect(readTrustedReceipt(authority, reviewFile, 'verification-primitive-outcome')).toBeUndefined()
  })
})
