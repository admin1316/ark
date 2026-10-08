/** Read-only byte, traversal and public-proof boundaries for the approved learning baseline. */
import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { readRegularFileBounded, resolveConfinedPath } from './filesystem.ts'
import { canonicalJson } from './verifier.ts'

/** Exact content reference; neither paths nor URLs are accepted. */
export interface ArtifactRef {
  readonly algorithm: 'sha256'
  readonly digest: string
  readonly bytes: number
  readonly mediaType: 'application/json' | 'application/x-ndjson' | 'text/markdown; charset=utf-8' | 'application/octet-stream'
}

/** Required owner budgets; no deployment values are defaulted. */
export interface LearningArtifactLimits {
  readonly maxArtifactBytes: number
  readonly maxArtifactsPerReceipt: number
  readonly maxTotalArtifactBytes: number
  readonly maxArtifactGraphDepth: number
  readonly maxChildRequestBytes: number
  readonly maxChildResponseBytes: number
  readonly timeoutMs: number
}

/** Budgets a definition may additionally tighten without resetting consumption. */
export type LearningTraversalLimits = Pick<LearningArtifactLimits,
  'maxArtifactBytes' | 'maxArtifactsPerReceipt' | 'maxTotalArtifactBytes' | 'maxArtifactGraphDepth'>

/** Approved independent evaluator discriminants. */
export type EvaluatorKind = 'trial-initiation-capability' | 'measurement-definition' | 'trial-authorization' | 'measured-use' | 'measured-trial'
/** Approved local integrity discriminants; these never certify evaluator facts. */
export type JournalKind = 'event' | 'promotion-wal' | 'journal-watermark' | 'archive-wal-v1'

/** Strict authenticated header; graph owner validates the operation-specific payload. */
export interface EvaluatorEnvelope<K extends EvaluatorKind = EvaluatorKind, P = unknown> {
  readonly schemaVersion: 1
  readonly domain: 'ark.knowledge.evaluator'
  readonly kind: K
  readonly authorityId: string
  readonly keyId: string
  readonly keyFingerprint: string
  readonly requestHash: string | null
  readonly requestArtifact: ArtifactRef | null
  readonly issuedAt: string
  readonly expiresAt: string
  readonly payload: P
  readonly proof: { readonly algorithm: 'Ed25519'; readonly signatureBase64: string }
}

/** Strict local authenticated header with no factual evaluator authority. */
export interface JournalEnvelope<K extends JournalKind = JournalKind, P = unknown> {
  readonly schemaVersion: 1
  readonly domain: 'ark.knowledge.local-journal'
  readonly projectIdentityHash: string
  readonly kind: K
  readonly signerId: string
  readonly keyId: string
  readonly keyFingerprint: string
  readonly payload: P
  readonly proof: { readonly algorithm: 'Ed25519'; readonly signatureBase64: string }
}

/** One validation's monotonic budgets and active recursive digest stack. */
export interface LearningArtifactTraversal {
  readonly limits: LearningArtifactLimits
  /** Holds this digest active through the synchronous callback; charges every edge and byte. */
  visit<T>(ref: ArtifactRef, read: (bytes: Uint8Array) => T): T
  /** Tightens limits, including all already consumed references; never resets counters. */
  narrowLimits(limits: Partial<LearningTraversalLimits>): void
}

/** Proof methods bound to the root-supplied public anchors, never artifact-selected keys. */
export interface LearningPublicProofs {
  readonly evaluatorAuthorityId: string
  readonly journalSignerId: string
  readonly projectIdentityHash: string
  verifyEvaluatorEnvelope<K extends EvaluatorKind>(value: unknown, expectedKind: K, now: string): EvaluatorEnvelope<K>
  verifyJournalEnvelope<K extends JournalKind>(value: unknown, expectedKind: K): JournalEnvelope<K>
}

/** Trust is supplied by the actual owner; descriptor text does not authenticate custody. */
export interface LearningArtifactOwnerOptions {
  readonly artifactRoot: string
  readonly limits: LearningArtifactLimits
  readonly evaluator: {
    readonly authorityId: string
    readonly keyId: string
    readonly keyFingerprint: string
    readonly publicKeySpkiPem: string
  }
  readonly journal: {
    readonly signerId: string
    readonly keyId: string
    readonly keyFingerprint: string
    readonly publicKeySpkiPem: string
    readonly projectIdentityHash: string
  }
}

/** Immutable public owner configuration; each factual validation obtains a fresh traversal. */
export interface LearningArtifactOwner {
  readonly limits: LearningArtifactLimits
  readonly proofs: LearningPublicProofs
  createTraversal(limits?: Partial<LearningTraversalLimits>): LearningArtifactTraversal
}

const evaluatorKinds: readonly string[] = [
  'trial-initiation-capability', 'measurement-definition', 'trial-authorization', 'measured-use', 'measured-trial',
]
const journalKinds: readonly string[] = ['event', 'promotion-wal', 'journal-watermark', 'archive-wal-v1']
const traversalKeys: readonly (keyof LearningTraversalLimits)[] = [
  'maxArtifactBytes', 'maxArtifactsPerReceipt', 'maxTotalArtifactBytes', 'maxArtifactGraphDepth',
]
const budgetKeys: readonly (keyof LearningArtifactLimits)[] = [
  ...traversalKeys, 'maxChildRequestBytes', 'maxChildResponseBytes', 'timeoutMs',
]

function reject(): never { throw new Error('learning evidence rejected') }
function checked<T>(operation: () => T): T {
  try { return operation() } catch { return reject() }
}
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return reject()
  const prototype: unknown = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return reject()
  return value as Record<string, unknown>
}
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const result = object(value)
  const names = Reflect.ownKeys(result)
  if (names.length !== keys.length || names.some(key => typeof key !== 'string' || !keys.includes(key))) return reject()
  if (names.some((key) => {
    const property = Object.getOwnPropertyDescriptor(result, key)
    return property?.enumerable !== true || !Object.hasOwn(property, 'value')
  })) return reject()
  return result
}
function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}
function hash(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value) }
function text(value: unknown): value is string { return typeof value === 'string' && value.length > 0 }
function time(value: unknown): number {
  if (typeof value !== 'string') return reject()
  const date = new Date(value)
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) return reject()
  return date.getTime()
}
function losslessUtf8(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes)
  const decoded = raw.toString('utf8')
  if (!Buffer.from(decoded, 'utf8').equals(raw)) return reject()
  return decoded
}
function validString(value: string): void {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index)
      if (!(next >= 0xdc00 && next <= 0xdfff)) reject()
    } else if (unit >= 0xdc00 && unit <= 0xdfff) reject()
  }
}
function validJson(value: unknown, active: Set<object>): void {
  if (value === null || typeof value === 'boolean') return
  if (typeof value === 'string') { validString(value); return }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) reject()
    return
  }
  if (typeof value !== 'object' || active.has(value)) return reject()
  active.add(value)
  try {
    if (Array.isArray(value)) {
      if (Reflect.ownKeys(value).length !== value.length + 1) reject()
      for (let index = 0; index < value.length; index++) {
        const property = Object.getOwnPropertyDescriptor(value, index)
        if (property?.enumerable !== true || !Object.hasOwn(property, 'value')) reject()
        validJson(property.value, active)
      }
    } else {
      const record = object(value)
      for (const key of Reflect.ownKeys(record)) {
        if (typeof key !== 'string' || /[^\x00-\x7f]/u.test(key)) reject()
        const property = Object.getOwnPropertyDescriptor(record, key)
        if (property?.enumerable !== true || !Object.hasOwn(property, 'value')) reject()
        validJson(property.value, active)
      }
    }
  } finally { active.delete(value) }
}

/**
 * Serialize strict JSON with lexical ASCII keys and the existing canonical owner.
 * @param value - JSON value already bounded by the calling artifact/child owner; no undefined or lossy primitives.
 * @returns Canonical JSON text with no transport LF.
 * @throws Generic rejection for invalid values, cycles or serialization failures.
 */
export function canonicalLearningJson(value: unknown): string {
  return checked(() => { validJson(value, new Set()); return canonicalJson(value) })
}

/**
 * Decode new canonical JSON without repairing any encoding, key order or framing.
 * @param bytes - Exact bounded artifact or child bytes; transports remove only their separately declared LF first.
 * @returns Parsed JSON; the graph owner still validates every payload schema.
 * @throws Generic rejection for invalid UTF8, duplicate/noncanonical keys, framing or invalid JSON values.
 */
export function decodeCanonicalJson(bytes: Uint8Array): unknown {
  return checked(() => {
    const raw = losslessUtf8(bytes)
    const value: unknown = JSON.parse(raw)
    if (canonicalLearningJson(value) !== raw) reject()
    return value
  })
}

/**
 * Validate the complete runtime content-addressed reference shape.
 * @param value - Untrusted reference with exactly the four approved fields.
 * @returns Detached frozen reference with exact bytes and media type.
 * @throws Generic rejection for any malformed, extra or missing field.
 */
export function parseArtifactRef(value: unknown): ArtifactRef {
  return checked(() => {
    const ref = exact(value, ['algorithm', 'digest', 'bytes', 'mediaType'])
    if (ref.algorithm !== 'sha256' || !hash(ref.digest)
      || typeof ref.bytes !== 'number' || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0 || Object.is(ref.bytes, -0)
      || typeof ref.mediaType !== 'string'
      || !['application/json', 'application/x-ndjson', 'text/markdown; charset=utf-8', 'application/octet-stream'].includes(ref.mediaType)) reject()
    return Object.freeze({ ...ref }) as unknown as ArtifactRef
  })
}

function ordinaryRoot(root: string): void {
  for (let cursor = root; ; cursor = dirname(cursor)) {
    const stat = lstatSync(cursor)
    if (!stat.isDirectory() || stat.isSymbolicLink()) reject()
    if (dirname(cursor) === cursor) return
  }
}
function publicAnchor(pem: string, fingerprint: string): KeyObject {
  if (!hash(fingerprint) || typeof pem !== 'string'
    || !/^-----BEGIN PUBLIC KEY-----\r?\n(?:[A-Za-z0-9+/=]+\r?\n)+-----END PUBLIC KEY-----\r?\n?$/u.test(pem)) reject()
  const key = createPublicKey({ key: pem, type: 'spki', format: 'pem' })
  if (key.asymmetricKeyType !== 'ed25519'
    || createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex') !== fingerprint) reject()
  return key
}
function signature(value: unknown): Buffer {
  const proof = exact(value, ['algorithm', 'signatureBase64'])
  if (proof.algorithm !== 'Ed25519' || typeof proof.signatureBase64 !== 'string' || proof.signatureBase64.length !== 88) reject()
  const decoded = Buffer.from(proof.signatureBase64, 'base64')
  if (decoded.length !== 64 || decoded.toString('base64') !== proof.signatureBase64) reject()
  return decoded
}
function verifyProof(record: Record<string, unknown>, prefix: string, key: KeyObject): void {
  const { proof, ...body } = record
  if (!verify(null, Buffer.from(prefix + canonicalLearningJson(body)), key, signature(proof))) reject()
}

/**
 * Bind read-only artifact/proof validation to explicitly supplied owner trust and budgets.
 * @param options - Actual owner public anchors/root and all seven positive safe budgets; source text does not authenticate custody.
 * @returns Fixed public-proof owner with a fresh, monotonic traversal for each validation.
 * @throws Generic rejection for missing/invalid budgets, roots, fingerprints or non-disjoint Ed25519 roles.
 */
export function createLearningArtifactOwner(options: LearningArtifactOwnerOptions): LearningArtifactOwner {
  return checked(() => {
    exact(options.limits, budgetKeys)
    if (budgetKeys.some(key => !positive(options.limits[key])) || !text(options.artifactRoot)) reject()
    const limits = Object.freeze({ ...options.limits })
    const root = resolve(options.artifactRoot)
    ordinaryRoot(root)
    const evaluator = Object.freeze({ ...options.evaluator })
    const journal = Object.freeze({ ...options.journal })
    if (!text(evaluator.authorityId) || !text(evaluator.keyId) || !text(journal.signerId) || !text(journal.keyId)
      || evaluator.authorityId === journal.signerId || evaluator.keyFingerprint === journal.keyFingerprint
      || !hash(journal.projectIdentityHash)) reject()
    const evaluatorKey = publicAnchor(evaluator.publicKeySpkiPem, evaluator.keyFingerprint)
    const journalKey = publicAnchor(journal.publicKeySpkiPem, journal.keyFingerprint)
    const proofs: LearningPublicProofs = Object.freeze({
      evaluatorAuthorityId: evaluator.authorityId, journalSignerId: journal.signerId, projectIdentityHash: journal.projectIdentityHash,
      verifyEvaluatorEnvelope<K extends EvaluatorKind>(value: unknown, expectedKind: K, now: string): EvaluatorEnvelope<K> {
        return checked(() => {
          const started = performance.now()
          if (Buffer.byteLength(canonicalLearningJson(value)) > limits.maxChildResponseBytes) reject()
          const record = exact(value, ['schemaVersion', 'domain', 'kind', 'authorityId', 'keyId', 'keyFingerprint',
            'requestHash', 'requestArtifact', 'issuedAt', 'expiresAt', 'payload', 'proof'])
          if (!evaluatorKinds.includes(expectedKind) || record.schemaVersion !== 1 || record.domain !== 'ark.knowledge.evaluator'
            || record.kind !== expectedKind || record.authorityId !== evaluator.authorityId || record.keyId !== evaluator.keyId
            || record.keyFingerprint !== evaluator.keyFingerprint) reject()
          const issuedAt = time(record.issuedAt)
          const expiresAt = time(record.expiresAt)
          const at = time(now)
          if (issuedAt > at || expiresAt <= at || issuedAt >= expiresAt) reject()
          if (expectedKind === 'measurement-definition' || expectedKind === 'trial-initiation-capability') {
            if (record.requestHash !== null || record.requestArtifact !== null) reject()
          } else {
            const request = parseArtifactRef(record.requestArtifact)
            if (!hash(record.requestHash) || request.digest !== record.requestHash || request.mediaType !== 'application/json'
              || request.bytes > limits.maxChildRequestBytes) reject()
          }
          verifyProof(record, 'ARK-KNOWLEDGE-EVALUATOR\0', evaluatorKey)
          if (performance.now() - started > limits.timeoutMs) reject()
          return decodeCanonicalJson(Buffer.from(canonicalLearningJson(record))) as EvaluatorEnvelope<K>
        })
      },
      verifyJournalEnvelope<K extends JournalKind>(value: unknown, expectedKind: K): JournalEnvelope<K> {
        return checked(() => {
          const started = performance.now()
          if (Buffer.byteLength(canonicalLearningJson(value)) > limits.maxArtifactBytes) reject()
          const record = exact(value, ['schemaVersion', 'domain', 'projectIdentityHash', 'kind', 'signerId', 'keyId', 'keyFingerprint', 'payload', 'proof'])
          if (!journalKinds.includes(expectedKind) || record.schemaVersion !== 1 || record.domain !== 'ark.knowledge.local-journal'
            || record.kind !== expectedKind || record.signerId !== journal.signerId || record.keyId !== journal.keyId
            || record.keyFingerprint !== journal.keyFingerprint || record.projectIdentityHash !== journal.projectIdentityHash) reject()
          verifyProof(record, 'ARK-KNOWLEDGE-LOCAL-JOURNAL\0', journalKey)
          if (performance.now() - started > limits.timeoutMs) reject()
          return decodeCanonicalJson(Buffer.from(canonicalLearningJson(record))) as JournalEnvelope<K>
        })
      },
    })
    return Object.freeze({ limits, proofs,
      createTraversal(additionalLimits?: Partial<LearningTraversalLimits>): LearningArtifactTraversal {
        let current = limits
        let edges = 0
        let bytes = 0
        let largest = 0
        let deepest = 0
        const active = new Set<string>()
        const started = performance.now()
        const deadline = () => {
          if (performance.now() - started > current.timeoutMs || edges > current.maxArtifactsPerReceipt
            || bytes > current.maxTotalArtifactBytes || largest > current.maxArtifactBytes
            || deepest > current.maxArtifactGraphDepth) reject()
        }
        const traversal: LearningArtifactTraversal = Object.freeze({
          get limits() { return current },
          narrowLimits(narrow: Partial<LearningTraversalLimits>): void {
            checked(() => {
              deadline()
              const fields = object(narrow)
              if (Reflect.ownKeys(fields).some(key => !traversalKeys.includes(key as keyof LearningTraversalLimits))) reject()
              const next = { ...current }
              for (const key of traversalKeys) {
                if (!Object.hasOwn(fields, key)) continue
                if (!positive(fields[key])) reject()
                next[key] = Math.min(next[key], fields[key])
              }
              current = Object.freeze(next)
              deadline()
            })
          },
          visit<T>(value: ArtifactRef, read: (bytes: Uint8Array) => T): T {
            return checked(() => {
              deadline()
              const ref = parseArtifactRef(value)
              if (edges >= current.maxArtifactsPerReceipt || ref.bytes > current.maxArtifactBytes
                || ref.bytes > current.maxTotalArtifactBytes - bytes || active.size >= current.maxArtifactGraphDepth) reject()
              edges++
              bytes += ref.bytes
              largest = Math.max(largest, ref.bytes)
              deepest = Math.max(deepest, active.size + 1)
              if (active.has(ref.digest)) reject()
              active.add(ref.digest)
              try {
                ordinaryRoot(root)
                const relative = `sha256/${ref.digest.slice(0, 2)}/${ref.digest}`
                const path = resolveConfinedPath(root, relative, false)
                const raw = readRegularFileBounded(path, ref.bytes)
                if (raw.length !== ref.bytes || createHash('sha256').update(raw).digest('hex') !== ref.digest) reject()
                if (ref.mediaType !== 'application/octet-stream') losslessUtf8(raw)
                resolveConfinedPath(root, relative, false)
                deadline()
                const result = read(raw)
                if ((typeof result === 'object' && result !== null || typeof result === 'function')
                  && typeof Reflect.get(result, 'then') === 'function') reject()
                deadline()
                return result
              } finally { active.delete(ref.digest) }
            })
          },
        })
        if (additionalLimits !== undefined) traversal.narrowLimits(additionalLimits)
        return traversal
      },
    })
  })
}
