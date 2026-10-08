/** Launcher-owned external verifier adapter for governed Wiki candidates. */

import { createPrivateKey, createPublicKey, KeyObject, sign, verify } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { isAbsolute } from 'node:path'
import type {
  IndependentVerificationRequest,
  IndependentVerificationResult,
  KnowledgeWikiSourceIdentity,
  KnowledgeWikiVerifierAuthority,
  PromotionCheckpoint,
  VerificationAuthoritySeal,
} from './verifier.ts'
import { canonicalJson, sha256, validateSemanticReceipt } from './verifier.ts'
import { createLearningArtifactOwner } from './learning-artifacts.ts'
import { evaluateLearning } from './learning-evaluation.ts'
import type { LearningGraphOwner } from './learning-graph-context.ts'
import { descriptor as learningDescriptorSchema } from './learning-graph-schema.ts'

const MAX_OUTPUT_BYTES = 256 * 1024
const DEFAULT_TIMEOUT_MS = 30_000
const SAFE_ENV_KEYS = [
  'PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL',
  'SYSTEMROOT', 'WINDIR', 'PATHEXT',
] as const
const SHA256_RE = /^[a-f0-9]{64}$/u
const COMMIT_RE = /^[a-f0-9]{40}$/u
const AUTHORITY_RE = /^[A-Za-z0-9._:-]{1,160}$/u

/** Fresh state captured by an actual selected owner, outside project-writable artifacts. */
export type LearningValidationContext = Pick<LearningGraphOwner,
  'now' | 'projectId' | 'currentJournal' | 'sessionContexts' | 'wikiRoot' | 'reviewFile' | 'archiveRoot'>

/** Explicit inputs for read-only graph verification; no runtime defaults or signing credentials. */
export interface ReadOnlyLearningVerifierOptions {
  readonly descriptor: unknown
  readonly captureContext: () => LearningValidationContext | undefined
  readonly reducerSourceHash: string
}

const learningOwners = new WeakMap<KnowledgeWikiVerifierAuthority, () => LearningGraphOwner | undefined>()

/**
 * Capture a fresh graph owner associated only by this module's read-only factory.
 * @param authority - Existing injected authority identity.
 * @returns Current source-owned inputs and a fresh traversal, or undefined when absent.
 * @throws If the selected owner cannot capture its current state.
 */
export function getLearningGraphOwner(authority: KnowledgeWikiVerifierAuthority): LearningGraphOwner | undefined {
  return learningOwners.get(authority)?.()
}

/** Configuration owned by the launcher/build owner, never by Wiki content. */
export interface ExternalVerifierOptions {
  /** Stable authority identifier included in every signed result and seal. */
  readonly authorityId: string
  /** Frozen source/build identity supplied by the launcher. */
  readonly sourceIdentity: KnowledgeWikiSourceIdentity
  /** Absolute verifier executable path. */
  readonly executable: string
  /** Fixed verifier arguments. */
  readonly args?: readonly string[]
  /** Ed25519 public key used to validate external results and WAL seals. */
  readonly publicKey: string | Buffer | KeyObject
  /** Ed25519 private key held by the launcher for WAL seals. */
  readonly privateKey: string | Buffer | KeyObject
  /** Maximum verifier execution time. */
  readonly timeoutMs?: number
}

function safeEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of SAFE_ENV_KEYS) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

function keyObject(value: string | Buffer | KeyObject, kind: 'public' | 'private'): KeyObject {
  if (value instanceof KeyObject) return value
  return kind === 'public'
    ? createPublicKey(value)
    : createPrivateKey(value)
}

function validSourceIdentity(identity: KnowledgeWikiSourceIdentity): boolean {
  return COMMIT_RE.test(identity.commit)
    && SHA256_RE.test(identity.sourceDigest)
    && SHA256_RE.test(identity.dirtyDigest)
    && SHA256_RE.test(identity.buildDigest)
    && typeof identity.dirty === 'boolean'
}

function signedPayload(value: Omit<IndependentVerificationResult, 'proof'>): string {
  return canonicalJson(value)
}

function verifyResult(
  authorityId: string,
  publicKey: ReturnType<typeof createPublicKey>,
  request: IndependentVerificationRequest,
  result: IndependentVerificationResult,
): boolean {
  const { proof, ...unsigned } = result
  if (result.authorityId !== authorityId
    || result.requestHash !== sha256(canonicalJson(request))
    || typeof proof !== 'string' || proof.length === 0
    || !Array.isArray(result.methods) || result.methods.length === 0
    || !Array.isArray(result.outcomes) || result.outcomes.length === 0
    || !Number.isFinite(Date.parse(result.issuedAt))) return false
  return verify(null, Buffer.from(signedPayload(unsigned), 'utf8'), publicKey, Buffer.from(proof, 'base64'))
}

function terminate(child: ChildProcessWithoutNullStreams): void {
  child.kill('SIGTERM')
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }, 100).unref()
}

async function runVerifier(
  options: ExternalVerifierOptions,
  request: IndependentVerificationRequest,
  publicKey: ReturnType<typeof createPublicKey>,
  signal: AbortSignal,
): Promise<IndependentVerificationResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const payload = `${canonicalJson({ schemaVersion: 1, operation: 'verifyCandidate', request })}\n`
  return new Promise((resolvePromise, reject) => {
    if (signal.aborted) {
      reject(new Error('external verifier aborted'))
      return
    }
    let settled = false
    let outputBytes = 0
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    const child = spawn(options.executable, [...(options.args ?? [])], {
      shell: false,
      env: safeEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const timerRef: { value?: NodeJS.Timeout } = {}
    const cleanup = (): void => {
      if (timerRef.value !== undefined) clearTimeout(timerRef.value)
      signal.removeEventListener('abort', abort)
    }
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const abort = (): void => {
      terminate(child)
      fail(new Error('external verifier aborted'))
    }
    child.stdout.on('data', (chunk: Buffer | string) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      outputBytes += value.byteLength
      if (outputBytes > MAX_OUTPUT_BYTES) {
        terminate(child)
        fail(new Error('external verifier output exceeds 256 KiB'))
        return
      }
      stdout.push(value)
    })
    child.stderr.on('data', (chunk: Buffer | string) => {
      if (Buffer.concat(stderr).byteLength < 16 * 1024) stderr.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    })
    child.once('error', (error) => { fail(error) })
    child.once('close', (code, childSignal) => {
      if (settled) return
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString('utf8').slice(0, 1000)
        fail(new Error(`external verifier exited ${String(code)}${childSignal === null ? '' : ` (${childSignal})`}${detail === '' ? '' : `: ${detail}`}`))
        return
      }
      try {
        const parsed = JSON.parse(Buffer.concat(stdout).toString('utf8')) as IndependentVerificationResult
        if (!verifyResult(options.authorityId, publicKey, request, parsed)) throw new Error('external verifier result signature or request binding is invalid')
        settled = true
        cleanup()
        resolvePromise(parsed)
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)))
      }
    })
    signal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => {
      terminate(child)
      fail(new Error(`external verifier timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    timerRef.value = timer
    timer.unref()
    child.stdin.end(payload)
  })
}

/**
 * Create a launcher-owned, signed external verifier authority.
 * @param options - Fixed launcher-owned command, source identity, keys, and deadline.
 * @returns An authority that can be injected into KnowledgeWikiService.
 */
export function createExternalVerifierAuthority(options: ExternalVerifierOptions): KnowledgeWikiVerifierAuthority {
  if (!AUTHORITY_RE.test(options.authorityId)) throw new Error('external verifier authorityId is invalid')
  if (!isAbsolute(options.executable)) throw new Error('external verifier executable must be absolute')
  if (!validSourceIdentity(options.sourceIdentity)) throw new Error('external verifier source identity is invalid')
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new Error('external verifier timeout is invalid')
  const publicKey = keyObject(options.publicKey, 'public')
  const privateKey = keyObject(options.privateKey, 'private')
  const probe = Buffer.from('ark-external-verifier-keypair-probe', 'utf8')
  const probeSignature = sign(null, probe, privateKey)
  if (!verify(null, probe, publicKey, probeSignature)) throw new Error('external verifier keypair does not match')
  const sourceIdentity = Object.freeze({ ...options.sourceIdentity })
  return {
    authorityId: options.authorityId,
    sourceIdentity: () => sourceIdentity,
    verifyCandidate: (request, signal) => runVerifier({ ...options, timeoutMs }, request, publicKey, signal),
    validateCandidateResult: (request, result) => verifyResult(options.authorityId, publicKey, request, result),
    sealPromotion(payload: string): VerificationAuthoritySeal {
      return { authorityId: options.authorityId, proof: sign(null, Buffer.from(payload, 'utf8'), privateKey).toString('base64') }
    },
    validatePromotion(payload: string, seal: VerificationAuthoritySeal): boolean {
      return seal.authorityId === options.authorityId
        && verify(null, Buffer.from(payload, 'utf8'), publicKey, Buffer.from(seal.proof, 'base64'))
    },
    checkpointPromotion(_payload: string, _checkpoint: PromotionCheckpoint): void {},
  }
}

/**
 * Bind public role verification and complete read-only learning evidence to the existing authority seam.
 * Descriptor selection and current-state custody belong to the caller's actual product owner;
 * parsing descriptor text and resolving its artifacts do not establish that custody.
 * This factory executes no checks, signs no WAL, and enables no trial or canonical writer.
 * @param options - Strict descriptor, fresh protected-state capture and selected reducer identity.
 * @returns An injected authority with frozen semantic validation and private graph-owner association.
 * @throws On invalid descriptor, role/public-key separation, budgets, or reducer identity.
 */
export function createReadOnlyLearningVerifier(options: ReadOnlyLearningVerifierOptions): KnowledgeWikiVerifierAuthority {
  let descriptor: ReturnType<typeof learningDescriptorSchema.parse>
  try {
    descriptor = learningDescriptorSchema.parse(options.descriptor)
    if (typeof options.captureContext !== 'function' || !SHA256_RE.test(options.reducerSourceHash)) {
      throw new Error('invalid owner input')
    }
    if (!isAbsolute(descriptor.evaluator.executable) || !isAbsolute(descriptor.evaluator.artifactRoot)
      || !isAbsolute(descriptor.journal.protectedHeadRoot)) throw new Error('invalid owner root')
  } catch {
    throw new Error('read-only learning authority configuration is invalid')
  }
  const artifactOwner = createLearningArtifactOwner({
    artifactRoot: descriptor.evaluator.artifactRoot,
    limits: {
      maxArtifactBytes: descriptor.maxArtifactBytes,
      maxArtifactsPerReceipt: descriptor.maxArtifactsPerReceipt,
      maxTotalArtifactBytes: descriptor.maxTotalArtifactBytes,
      maxArtifactGraphDepth: descriptor.maxArtifactGraphDepth,
      maxChildRequestBytes: descriptor.maxChildRequestBytes,
      maxChildResponseBytes: descriptor.maxChildResponseBytes,
      timeoutMs: descriptor.timeoutMs,
    },
    evaluator: {
      authorityId: descriptor.evaluator.authorityId,
      keyId: descriptor.evaluator.keyId,
      keyFingerprint: descriptor.evaluator.keyFingerprint,
      publicKeySpkiPem: descriptor.evaluator.publicKeySpkiPem,
    },
    journal: {
      signerId: descriptor.journal.signerId,
      keyId: descriptor.journal.keyId,
      keyFingerprint: descriptor.journal.keyFingerprint,
      publicKeySpkiPem: descriptor.journal.publicKeySpkiPem,
      projectIdentityHash: descriptor.journal.projectIdentityHash,
    },
  })
  const publicKey = keyObject(descriptor.evaluator.publicKeySpkiPem, 'public')
  const sourceIdentity = Object.freeze({ ...descriptor.sourceIdentity })
  const capture = options.captureContext
  const reducerSourceHash = options.reducerSourceHash
  const authority: KnowledgeWikiVerifierAuthority = {
    authorityId: descriptor.evaluator.authorityId,
    sourceIdentity: () => sourceIdentity,
    verifyCandidate(): Promise<IndependentVerificationResult> {
      return Promise.reject(new Error('read-only learning authority cannot execute checks'))
    },
    validateCandidateResult: (request, result) => verifyResult(descriptor.evaluator.authorityId, publicKey, request, result),
    sealPromotion(): VerificationAuthoritySeal {
      throw new Error('read-only learning authority cannot sign a journal')
    },
    validatePromotion: () => false,
  }
  learningOwners.set(authority, () => {
    const current = capture()
    if (current === undefined) return undefined
    if (current.currentJournal.protectedHead.epoch !== descriptor.journal.epoch) {
      throw new Error('read-only learning authority journal epoch is unavailable')
    }
    return {
      ...current,
      artifacts: artifactOwner.createTraversal(),
      proofs: artifactOwner.proofs,
      source: sourceIdentity,
      profile: descriptor.profile,
      profileDigest: descriptor.profileDigest,
      mission: descriptor.mission,
      allowedDefinitions: descriptor.evaluator.allowedDefinitions,
      allowedInitiationCapabilities: descriptor.evaluator.allowedInitiationCapabilities,
      reducer: { sourceHash: reducerSourceHash, evaluate: evaluateLearning },
      validateSemanticReceipt: raw => validateSemanticReceipt(authority, raw),
    }
  })
  return authority
}
