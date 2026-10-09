import { generateKeyPairSync, sign } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { SubprocessHandle, SubprocessOutcome, SubprocessRuntime, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createExternalVerifierAuthority, createReadOnlyLearningVerifier, getLearningGraphOwner } from '../src/external-verifier-adapter.ts'
import { canonicalJson, sha256, validateLearningReceiptChain } from '../src/verifier.ts'
import { createLearningGraphFixture } from './learning-graph-fixture.ts'

const fixtures: ReturnType<typeof createLearningGraphFixture>[] = []
afterEach(() => { for (const value of fixtures.splice(0)) value.artifacts.dispose() })

function fixture() {
  const value = createLearningGraphFixture()
  fixtures.push(value)
  return value
}

function artifactBytes(root: string) {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => [join(entry.parentPath, entry.name), readFileSync(join(entry.parentPath, entry.name))])
}

describe('read-only verifier authority boundaries', () => {
  it.each(['capture', 'reducer', 'executable', 'artifacts', 'journal'] as const)('rejects invalid %s owner inputs before capturing or modifying evidence', (field) => {
    const value = fixture()
    const descriptor = structuredClone(value.descriptor)
    const capture = vi.fn(value.captureContext)
    if (field === 'executable') descriptor.evaluator.executable = 'relative-verifier'
    if (field === 'artifacts') descriptor.evaluator.artifactRoot = 'relative-artifacts'
    if (field === 'journal') descriptor.journal.protectedHeadRoot = 'relative-head'
    const before = artifactBytes(value.artifacts.root)
    expect(() => createReadOnlyLearningVerifier({
      descriptor,
      // Exercise the runtime configuration parser, where an untyped launcher can supply a non-function.
      captureContext: field === 'capture' ? undefined as unknown as typeof capture : capture,
      reducerSourceHash: field === 'reducer' ? 'invalid-digest' : value.reducerSourceHash,
    })).toThrow('read-only learning authority configuration is invalid')
    expect(capture).not.toHaveBeenCalled()
    expect(artifactBytes(value.artifacts.root)).toEqual(before)
  })

  it('cannot execute, seal or validate a promotion and recaptures missing owner state', async () => {
    const value = fixture()
    const before = artifactBytes(value.artifacts.root)
    const capture = vi.fn(() => undefined)
    const authority = createReadOnlyLearningVerifier({
      descriptor: value.descriptor, captureContext: capture, reducerSourceHash: value.reducerSourceHash,
    })
    await expect(authority.verifyCandidate(value.semantic.request, new AbortController().signal))
      .rejects.toThrow('cannot execute checks')
    expect(() => authority.sealPromotion('synthetic-promotion')).toThrow('cannot sign a journal')
    expect(authority.validatePromotion('synthetic-promotion', { authorityId: authority.authorityId, proof: 'synthetic' })).toBe(false)
    expect(getLearningGraphOwner(authority)).toBeUndefined()
    expect(validateLearningReceiptChain(authority, value.trial)).toEqual({ status: 'unavailable', errorCode: 'learning-owner-unavailable' })
    expect(capture).toHaveBeenCalledTimes(2)
    expect(artifactBytes(value.artifacts.root)).toEqual(before)
  })
})

describe('external verifier subprocess ownership', () => {
  function controlledChild(missing?: 'stdout' | 'stderr') {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const done = Promise.withResolvers<SubprocessOutcome>()
    const exited = Promise.withResolvers<boolean>()
    const terminate = vi.fn()
    const waitForExit = vi.fn(() => exited.promise)
    const handle: SubprocessHandle = {
      pid: -1, stdin: undefined, stdout: missing === 'stdout' ? undefined : stdout,
      stderr: missing === 'stderr' ? undefined : stderr, collected: {}, done: done.promise, terminate, waitForExit,
    }
    const spawn = vi.fn((_spec: SubprocessSpawnSpec) => handle)
    // Only spawn is consumed; this controlled provider exposes stream and tree-settlement faults.
    const subprocess = { spawn } as unknown as SubprocessRuntime
    const value = fixture()
    const keys = generateKeyPairSync('ed25519')
    const unsigned = {
      authorityId: 'synthetic-stream-verifier', requestHash: sha256(canonicalJson(value.semantic.request)),
      result: 'pass' as const, methods: ['integration_test' as const],
      outcomes: [{ name: 'synthetic-only', result: 'pass' as const, evidence: ['test-only controlled child'] }],
      issuedAt: '2026-10-08T00:00:00.000Z',
    }
    const result = { ...unsigned, proof: sign(null, Buffer.from(canonicalJson(unsigned)), keys.privateKey).toString('base64') }
    const authority = createExternalVerifierAuthority({
      authorityId: unsigned.authorityId, sourceIdentity: value.semantic.request.sourceIdentity,
      executable: process.execPath, publicKey: keys.publicKey, privateKey: keys.privateKey,
    }, subprocess)
    return { stdout, stderr, done, exited, terminate, waitForExit, spawn, result, authority, request: value.semantic.request }
  }

  it.each(['stdout', 'stderr'] as const)('joins a malformed child missing %s before rejecting', async (missing) => {
    const value = controlledChild(missing)
    const pending = value.authority.verifyCandidate(value.request, new AbortController().signal)
    const settled = vi.fn()
    void pending.then(settled, settled)
    await Promise.resolve()
    expect(value.terminate).toHaveBeenCalledOnce()
    expect(value.waitForExit).toHaveBeenCalledOnce()
    expect(settled).not.toHaveBeenCalled()
    value.exited.resolve(true)
    await expect(pending).rejects.toThrow('requires piped output')
    expect(missing === 'stdout' ? value.stderr.destroyed : value.stdout.destroyed).toBe(true)
    expect(value.stdout.listenerCount('data') + value.stderr.listenerCount('data')).toBe(0)
  })

  it('accepts decoded string output only after tree quiescence and bounds exhausted diagnostics', async () => {
    const value = controlledChild()
    const pending = value.authority.verifyCandidate(value.request, new AbortController().signal)
    const settled = vi.fn()
    void pending.then(settled, settled)
    expect(value.spawn.mock.calls[0]?.[0].argv).toEqual([process.execPath])
    expect(value.spawn.mock.calls[0]?.[0].stdio.stdin).toEqual({ data: `${canonicalJson({ schemaVersion: 1, operation: 'verifyCandidate', request: value.request })}\n` })
    value.stdout.emit('data', JSON.stringify(value.result))
    value.stderr.emit('data', 'x'.repeat(16 * 1024))
    value.stderr.emit('data', 'discarded after stderr budget')
    value.done.resolve({ exitCode: 0, signal: null })
    await Promise.resolve()
    expect(value.terminate).toHaveBeenCalledOnce()
    expect(settled).not.toHaveBeenCalled()
    value.exited.resolve(true)
    await expect(pending).resolves.toEqual(value.result)
    expect(value.stdout.destroyed && value.stderr.destroyed).toBe(true)
    expect(value.stdout.listenerCount('data') + value.stderr.listenerCount('data')).toBe(0)
  })
})
