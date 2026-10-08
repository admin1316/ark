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
import { canonicalJson, sha256 } from './verifier.ts'

const MAX_OUTPUT_BYTES = 256 * 1024
const DEFAULT_TIMEOUT_MS = 30_000
const SAFE_ENV_KEYS = [
  'PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL',
  'SYSTEMROOT', 'WINDIR', 'PATHEXT',
] as const
const SHA256_RE = /^[a-f0-9]{64}$/u
const COMMIT_RE = /^[a-f0-9]{40}$/u
const AUTHORITY_RE = /^[A-Za-z0-9._:-]{1,160}$/u

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
