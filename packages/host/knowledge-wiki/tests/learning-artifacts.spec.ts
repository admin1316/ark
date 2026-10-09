import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import {
  existsSync, fstatSync, linkSync, mkdirSync, mkdtempSync, readdirSync, realpathSync,
  renameSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { canonicalJson } from '../src/verifier.ts'

const io = vi.hoisted(() => ({
  beforeOpen: undefined as ((path: string) => void) | undefined,
  beforeRead: undefined as ((descriptor: number) => void) | undefined,
}))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      io.beforeOpen?.(String(args[0]))
      return actual.openSync(...args)
    },
    readSync: (...args: Parameters<typeof actual.readSync>) => {
      io.beforeRead?.(args[0])
      return actual.readSync(...args)
    },
  }
})

import {
  canonicalLearningJson, createLearningArtifactOwner, decodeCanonicalJson, parseArtifactRef,
  type ArtifactRef, type EvaluatorKind, type JournalKind, type LearningArtifactLimits,
} from '../src/learning-artifacts.ts'

const roots: string[] = []
const now = '2026-10-08T10:00:00.000Z'
const limits: LearningArtifactLimits = {
  maxArtifactBytes: 4096, maxArtifactsPerReceipt: 30, maxTotalArtifactBytes: 16384,
  maxArtifactGraphDepth: 8, maxChildRequestBytes: 4096, maxChildResponseBytes: 4096, timeoutMs: 1000,
}
const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')

afterEach(() => {
  io.beforeOpen = undefined
  io.beforeRead = undefined
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wiki-learning-artifacts-')))
  roots.push(root)
  // Keys are dedicated in-memory test trust. Private key objects are never
  // exported, persisted, dispatched or included in diagnostic output.
  const evaluatorKey = generateKeyPairSync('ed25519')
  const journalKey = generateKeyPairSync('ed25519')
  const evaluator = {
    authorityId: 'fixture-evaluator', keyId: 'evaluator-1',
    publicKeySpkiPem: evaluatorKey.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    keyFingerprint: digest(evaluatorKey.publicKey.export({ type: 'spki', format: 'der' })),
  }
  const journal = {
    signerId: 'fixture-journal', keyId: 'journal-1', projectIdentityHash: digest('fixture-project'),
    publicKeySpkiPem: journalKey.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    keyFingerprint: digest(journalKey.publicKey.export({ type: 'spki', format: 'der' })),
  }
  const options = { artifactRoot: root, limits, evaluator, journal }
  const owner = createLearningArtifactOwner(options)
  const pathFor = (ref: ArtifactRef) => join(root, 'sha256', ref.digest.slice(0, 2), ref.digest)
  const store = (bytes: string | Uint8Array, mediaType: ArtifactRef['mediaType'] = 'application/json'): ArtifactRef => {
    const raw = Buffer.from(bytes)
    const ref: ArtifactRef = { algorithm: 'sha256', digest: digest(raw), bytes: raw.length, mediaType }
    const path = pathFor(ref)
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    if (!existsSync(path)) writeFileSync(path, raw, { flag: 'wx', mode: 0o600 })
    return ref
  }
  const evaluatorEnvelope = (kind: EvaluatorKind = 'measured-use') => {
    const request = store('{"operation":"measureUse","requestId":"request-1","schemaVersion":2}')
    const standalone = kind === 'measurement-definition' || kind === 'trial-initiation-capability'
    const body = {
      schemaVersion: 1, domain: 'ark.knowledge.evaluator', kind,
      authorityId: evaluator.authorityId, keyId: evaluator.keyId, keyFingerprint: evaluator.keyFingerprint,
      requestHash: standalone ? null : request.digest, requestArtifact: standalone ? null : request,
      issuedAt: '2026-10-08T09:00:00.000Z', expiresAt: '2026-10-08T11:00:00.000Z', payload: { fixture: true },
    }
    const proof = sign(null, Buffer.from('ARK-KNOWLEDGE-EVALUATOR\0' + canonicalJson(body)), evaluatorKey.privateKey)
    return { ...body, proof: { algorithm: 'Ed25519', signatureBase64: proof.toString('base64') } }
  }
  const journalEnvelope = (kind: JournalKind = 'event') => {
    const body = { schemaVersion: 1, domain: 'ark.knowledge.local-journal', kind,
      projectIdentityHash: journal.projectIdentityHash, signerId: journal.signerId,
      keyId: journal.keyId, keyFingerprint: journal.keyFingerprint, payload: { fixture: true } }
    const proof = sign(null, Buffer.from('ARK-KNOWLEDGE-LOCAL-JOURNAL\0' + canonicalJson(body)), journalKey.privateKey)
    return { ...body, proof: { algorithm: 'Ed25519', signatureBase64: proof.toString('base64') } }
  }
  return { root, owner, options, store, pathFor, evaluatorEnvelope, journalEnvelope, evaluatorKey, journalKey }
}

describe('new canonical learning bytes', () => {
  it('pins lexical ASCII keys, arrays, JSON number/string rendering and Unicode without changing raw text', () => {
    const text = '{"10":"ten","2":"two","A":[true,null,1.25,1e+21],"a":"雪\\n"}'
    expect(canonicalLearningJson(decodeCanonicalJson(Buffer.from(text)))).toBe(text)
  })

  it.each([
    '\ufeff{}', '{}\n', '{}\r\n', ' {}', '{"z":1,"a":2}', '{"a":1,"a":1}',
    '{"a":-0}', '{"a":1e400}', '{"a":1.0}', '{"a":"\\ud800"}', '{"é":1}',
    '{"a":"\\u0061"}', '{"a":undefined}',
  ])('rejects noncanonical or lossy JSON text %j', (text) => {
    expect(() => decodeCanonicalJson(Buffer.from(text))).toThrow('learning evidence rejected')
  })

  it('rejects malformed UTF8 and programmatic non-JSON/cyclic values', () => {
    expect(() => decodeCanonicalJson(Buffer.from([0x22, 0xc0, 0xaf, 0x22]))).toThrow('learning evidence rejected')
    const cycle: { self?: unknown } = {}
    cycle.self = cycle
    for (const value of [undefined, NaN, Infinity, -0, '\ud800', { a: undefined }, [, 1], cycle, new Date()]) {
      expect(() => canonicalLearningJson(value)).toThrow('learning evidence rejected')
    }
  })
})

describe('protected artifact bytes and per-validation budgets', () => {
  it('reads exact raw BOM/CRLF/final-byte framing and repeated DAG references with a fresh traversal', () => {
    const f = fixture()
    const raw = '\ufeff# Raw\r\nno final LF'
    const ref = f.store(raw, 'text/markdown; charset=utf-8')
    const entriesBefore = readdirSync(f.root, { recursive: true }).sort()
    const traversal = f.owner.createTraversal()
    expect(traversal.visit(ref, bytes => Buffer.from(bytes).toString('utf8'))).toBe(raw)
    expect(traversal.visit(ref, bytes => Buffer.from(bytes).toString('utf8'))).toBe(raw)
    expect(f.owner.createTraversal().visit(ref, bytes => bytes.length)).toBe(ref.bytes)
    expect(readdirSync(f.root, { recursive: true }).sort()).toEqual(entriesBefore)
    const empty = f.store('', 'application/octet-stream')
    expect(f.owner.createTraversal().visit(empty, bytes => bytes.length)).toBe(0)
  })

  it.each([
    { algorithm: 'sha512' }, { digest: 'A'.repeat(64) }, { digest: '../escape' }, { bytes: -1 },
    { bytes: 1.5 }, { bytes: Number.MAX_SAFE_INTEGER + 1 }, { mediaType: 'text/plain' }, { path: '/foreign' },
  ])('rejects malformed/extra reference fields before opening a target', (change) => {
    const f = fixture()
    const ref = f.store('{}')
    expect(() => parseArtifactRef({ ...ref, ...change })).toThrow('learning evidence rejected')
    expect(() => f.owner.createTraversal().visit({ ...ref, ...change } as ArtifactRef, () => true))
      .toThrow('learning evidence rejected')
  })

  it('retains arbitrary opaque binary bytes while requiring lossless UTF8 for text/JSON/NDJSON edges', () => {
    const f = fixture()
    const raw = Buffer.from([0xff, 0x00, 0xc0, 0xaf, 0x80])
    const binary = f.store(raw, 'application/octet-stream')
    expect(f.owner.createTraversal().visit(binary, bytes => Buffer.from(bytes).equals(raw))).toBe(true)
    for (const mediaType of ['application/json', 'application/x-ndjson', 'text/markdown; charset=utf-8'] as const) {
      expect(() => f.owner.createTraversal().visit({ ...binary, mediaType }, () => true)).toThrow('learning evidence rejected')
    }
  })

  it.each(['missing', 'hash', 'size', 'hardlink', 'leaf-link', 'directory', 'ancestor-link', 'utf8'])('rejects real filesystem %s tampering', (change) => {
    const f = fixture()
    let ref = f.store('exact bytes', 'application/octet-stream')
    const path = f.pathFor(ref)
    if (change === 'missing') rmSync(path)
    if (change === 'hash') writeFileSync(path, 'other bytes')
    if (change === 'size') ref = { ...ref, bytes: ref.bytes + 1 }
    if (change === 'hardlink') linkSync(path, join(f.root, 'second-link'))
    if (change === 'leaf-link') { renameSync(path, join(f.root, 'retained')); symlinkSync(join(f.root, 'retained'), path) }
    if (change === 'directory') { rmSync(path); mkdirSync(path) }
    if (change === 'ancestor-link') {
      const parent = dirname(path)
      renameSync(parent, join(f.root, 'retained-directory'))
      symlinkSync(join(f.root, 'retained-directory'), parent)
    }
    if (change === 'utf8') ref = f.store(Buffer.from([0xff]), 'text/markdown; charset=utf-8')
    expect(() => f.owner.createTraversal().visit(ref, () => true)).toThrow('learning evidence rejected')
  })

  it('rejects a configured root alias and changed file identity at the actual open/read boundary', () => {
    const f = fixture()
    expect(() => createLearningArtifactOwner({ ...f.options, artifactRoot: '' })).toThrow('learning evidence rejected')
    const alias = join(f.root, 'alias')
    symlinkSync(f.root, alias)
    expect(() => createLearningArtifactOwner({ ...f.options, artifactRoot: alias })).toThrow('learning evidence rejected')
    const ref = f.store('same bytes', 'application/octet-stream')
    const path = f.pathFor(ref)
    io.beforeOpen = (opening) => {
      if (opening !== path) return
      io.beforeOpen = undefined
      renameSync(path, join(f.root, 'retained-file'))
      writeFileSync(path, 'same bytes')
    }
    expect(() => f.owner.createTraversal().visit(ref, () => true)).toThrow('learning evidence rejected')
    let fd: number | undefined
    io.beforeRead = (descriptor) => {
      io.beforeRead = undefined
      fd = descriptor
      renameSync(path, join(f.root, 'retained-again'))
      writeFileSync(path, 'same bytes')
    }
    expect(() => f.owner.createTraversal().visit(ref, () => true)).toThrow('learning evidence rejected')
    expect(() => fstatSync(fd!)).toThrow('EBADF')
  })

  it('charges repeated edges/bytes, checks narrowing immediately, and never refunds a failed visitor', () => {
    const f = fixture()
    const ref = f.store('{}')
    const edges = f.owner.createTraversal({ maxArtifactsPerReceipt: 2 })
    edges.visit(ref, () => true)
    expect(() => edges.visit(ref, () => { throw new Error('visitor failed') })).toThrow('learning evidence rejected')
    expect(() => edges.visit(ref, () => true)).toThrow('learning evidence rejected')
    const bytes = f.owner.createTraversal({ maxTotalArtifactBytes: 3 })
    bytes.visit(ref, () => true)
    expect(() => bytes.visit(ref, () => true)).toThrow('learning evidence rejected')
    const narrow = f.owner.createTraversal()
    narrow.visit(ref, () => true)
    narrow.visit(ref, () => true)
    expect(() => { narrow.narrowLimits({ maxArtifactsPerReceipt: 1 }) }).toThrow('learning evidence rejected')
    const perFile = f.owner.createTraversal()
    perFile.visit(ref, () => true)
    expect(() => { perFile.narrowLimits({ maxArtifactBytes: 1 }) }).toThrow('learning evidence rejected')
    const empty = f.store('', 'application/octet-stream')
    expect(() => perFile.visit(empty, () => true)).toThrow('learning evidence rejected')
  })

  it('rejects oversized declared bytes before opening or parsing, and preserves accumulated depth/byte bounds', () => {
    const f = fixture()
    const a = f.store('{}')
    const b = f.store('[]')
    let opens = 0
    io.beforeOpen = () => { opens++ }
    expect(() => f.owner.createTraversal({ maxArtifactBytes: 1 }).visit(a, () => true)).toThrow('learning evidence rejected')
    expect(opens).toBe(0)
    io.beforeOpen = undefined
    const traversal = f.owner.createTraversal()
    traversal.visit(a, () => traversal.visit(b, () => true))
    expect(() => { traversal.narrowLimits({ maxArtifactGraphDepth: 1 }) }).toThrow('learning evidence rejected')
    expect(() => traversal.visit(a, () => true)).toThrow('learning evidence rejected')
    expect(() => { traversal.narrowLimits({ maxTotalArtifactBytes: 3 }) }).toThrow('learning evidence rejected')
    expect(() => f.owner.createTraversal().visit(a, () => Promise.resolve(true))).toThrow('learning evidence rejected')
  })

  it('keeps digest active across descendants, rejects cycles/depth, and times out before accepting a callback result', () => {
    const f = fixture()
    const a = f.store('{}')
    const b = f.store('[]')
    const traversal = f.owner.createTraversal()
    expect(() => traversal.visit(a, () => traversal.visit(b, () => traversal.visit(a, () => true))))
      .toThrow('learning evidence rejected')
    const depth = f.owner.createTraversal({ maxArtifactGraphDepth: 1 })
    expect(() => depth.visit(a, () => depth.visit(b, () => true))).toThrow('learning evidence rejected')
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0)
    const timed = f.owner.createTraversal()
    expect(() => timed.visit(a, () => { clock.mockReturnValue(1001); return true })).toThrow('learning evidence rejected')
  })

  it.each(Object.keys(limits))('requires an explicit positive safe %s budget and refuses inflation', (key) => {
    const f = fixture()
    for (const invalid of [undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => createLearningArtifactOwner({ ...f.options, limits: { ...limits, [key]: invalid } }))
        .toThrow('learning evidence rejected')
    }
    const traversal = f.owner.createTraversal()
    traversal.narrowLimits({ maxArtifactBytes: 2 })
    traversal.narrowLimits({ maxArtifactBytes: 4096 })
    expect(traversal.limits.maxArtifactBytes).toBe(2)
  })
})

describe('disjoint fixed public signature anchors', () => {
  it.each(['trial-initiation-capability', 'measurement-definition', 'trial-authorization', 'measured-use', 'measured-trial'] as const)(
    'verifies approved evaluator kind %s with strict request nullability', (kind) => {
      const f = fixture()
      expect(f.owner.proofs.verifyEvaluatorEnvelope(f.evaluatorEnvelope(kind), kind, now).kind).toBe(kind)
    },
  )

  it.each(['event', 'promotion-wal', 'journal-watermark', 'archive-wal-v1'] as const)('verifies local journal kind %s', (kind) => {
    const f = fixture()
    expect(f.owner.proofs.verifyJournalEnvelope(f.journalEnvelope(kind), kind).kind).toBe(kind)
  })

  it('rejects wrong keys, role/project/domain/version/kind, extra fields, malformed signature and expired/future time', () => {
    const f = fixture()
    const envelope = f.evaluatorEnvelope()
    const variants = [
      { ...envelope, schemaVersion: 2 }, { ...envelope, kind: 'other' }, { ...envelope, domain: 'ark.knowledge.local-journal' },
      { ...envelope, keyId: 'foreign' }, { ...envelope, keyFingerprint: f.options.journal.keyFingerprint },
      { ...envelope, authorityId: f.options.journal.signerId }, { ...envelope, extra: true },
      { ...envelope, proof: { ...envelope.proof, extra: true } },
      { ...envelope, proof: { algorithm: 'Ed25519', signatureBase64: envelope.proof.signatureBase64.slice(0, -1) } },
      { ...envelope, proof: { algorithm: 'Ed25519', signatureBase64: 'A'.repeat(88) } },
      { ...envelope, issuedAt: '2026-10-08T12:00:00.000Z' }, { ...envelope, expiresAt: now },
      { ...envelope, issuedAt: '2026-10-08T09:00:00Z' }, { ...envelope, requestHash: null },
      { ...envelope, requestArtifact: null }, { ...envelope, requestHash: digest('foreign-request') },
      { ...envelope, payload: { fixture: false } },
    ]
    for (const value of variants) {
      expect(() => f.owner.proofs.verifyEvaluatorEnvelope(value, 'measured-use', now)).toThrow('learning evidence rejected')
    }
    const journal = f.journalEnvelope()
    expect(() => f.owner.proofs.verifyEvaluatorEnvelope(journal, 'measured-use', now)).toThrow('learning evidence rejected')
    expect(() => f.owner.proofs.verifyJournalEnvelope(envelope, 'event')).toThrow('learning evidence rejected')
    expect(() => f.owner.proofs.verifyJournalEnvelope({ ...journal, projectIdentityHash: digest('other-project') }, 'event'))
      .toThrow('learning evidence rejected')
    const body = canonicalJson({ ...envelope, proof: undefined })
    const wrongSignature = sign(null, Buffer.from('ARK-KNOWLEDGE-EVALUATOR\0' + body), f.journalKey.privateKey)
    expect(() => f.owner.proofs.verifyEvaluatorEnvelope({ ...envelope,
      proof: { algorithm: 'Ed25519', signatureBase64: wrongSignature.toString('base64') } }, 'measured-use', now))
      .toThrow('learning evidence rejected')
  })

  it('requires actual NUL signature domains and canonical base64 padding bits, and bounds child request/response envelopes', () => {
    const f = fixture()
    const envelope = f.evaluatorEnvelope()
    const body = canonicalJson({ ...envelope, proof: undefined })
    const wrongDomain = sign(null, Buffer.from('ARK-KNOWLEDGE-EVALUATOR\\u0000' + body), f.evaluatorKey.privateKey)
    expect(() => f.owner.proofs.verifyEvaluatorEnvelope({ ...envelope,
      proof: { algorithm: 'Ed25519', signatureBase64: wrongDomain.toString('base64') } }, 'measured-use', now))
      .toThrow('learning evidence rejected')
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    const signature = envelope.proof.signatureBase64
    const alternate = signature.slice(0, 85) + alphabet.charAt(alphabet.indexOf(signature[85]!) + 1) + '=='
    expect(Buffer.from(alternate, 'base64').equals(Buffer.from(signature, 'base64'))).toBe(true)
    expect(() => f.owner.proofs.verifyEvaluatorEnvelope({ ...envelope,
      proof: { algorithm: 'Ed25519', signatureBase64: alternate } }, 'measured-use', now)).toThrow('learning evidence rejected')
    for (const field of ['maxChildRequestBytes', 'maxChildResponseBytes'] as const) {
      const owner = createLearningArtifactOwner({ ...f.options, limits: { ...limits, [field]: 1 } })
      expect(() => owner.proofs.verifyEvaluatorEnvelope(envelope, 'measured-use', now)).toThrow('learning evidence rejected')
    }
    const returned = f.owner.proofs.verifyEvaluatorEnvelope(envelope, 'measured-use', now)
    envelope.payload.fixture = false
    expect((returned.payload as { fixture: boolean }).fixture).toBe(true)
  })

  it('requires supplied Ed25519 SPKI fingerprints and disjoint evaluator/journal identities and keys', () => {
    const f = fixture()
    const sameId = { ...f.options.journal, signerId: f.options.evaluator.authorityId }
    expect(() => createLearningArtifactOwner({ ...f.options, journal: sameId }))
      .toThrow('learning evidence rejected')
    expect(() => createLearningArtifactOwner({ ...f.options, journal: { ...f.options.journal,
      publicKeySpkiPem: f.options.evaluator.publicKeySpkiPem, keyFingerprint: f.options.evaluator.keyFingerprint } }))
      .toThrow('learning evidence rejected')
    expect(() => createLearningArtifactOwner({ ...f.options, evaluator: { ...f.options.evaluator, keyFingerprint: digest('wrong') } }))
      .toThrow('learning evidence rejected')
    const wrongType = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey
    expect(() => createLearningArtifactOwner({ ...f.options, evaluator: { ...f.options.evaluator,
      publicKeySpkiPem: wrongType.export({ type: 'spki', format: 'pem' }).toString(),
      keyFingerprint: digest(wrongType.export({ type: 'spki', format: 'der' })) } })).toThrow('learning evidence rejected')
  })
})
