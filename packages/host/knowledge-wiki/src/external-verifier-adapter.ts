/** Launcher-owned external verifier adapter for governed Wiki candidates. */

import { createPublicKey, KeyObject, verify } from 'node:crypto'
import { dirname, isAbsolute } from 'node:path'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type {
  IndependentVerificationRequest,
  IndependentVerificationResult,
  KnowledgeWikiPromotionSealRequest,
  KnowledgeWikiSourceIdentity,
  KnowledgeWikiVerifierAuthority,
  PromotionCheckpoint,
  VerificationAuthoritySeal,
} from './verifier.ts'
import { canonicalJson, encodeKnowledgeWikiPromotionSealRequest, sha256 } from './verifier.ts'

const MAX_OUTPUT_BYTES = 256 * 1024
const MAX_STDERR_BYTES = 16 * 1024
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
  /**
   * Existing closed typed operation owner; this adapter retains only its matching Ed25519 public key.
   * It must honor a supplied signal and settle only after its own work is terminated and joined.
   */
  readonly promotionSealer: Pick<KnowledgeWikiVerifierAuthority, 'authorityId' | 'sealPromotion'>
  /** Shared managed process-tree owner used for verifier execution and teardown. */
  readonly subprocess: Pick<SubprocessRuntime, 'resolveExecutable' | 'spawn'>
  /** Maximum verifier subprocess execution time; it does not impose a deadline on promotion signing. */
  readonly timeoutMs?: number
}

type VerifierCommand = Required<Pick<
  ExternalVerifierOptions,
  'authorityId' | 'executable' | 'args' | 'subprocess' | 'timeoutMs'
>>

function safeEnvironment(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of SAFE_ENV_KEYS) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

function ed25519PublicKey(value: string | Buffer | KeyObject): KeyObject {
  if (value instanceof KeyObject) {
    if (value.type !== 'public' || value.asymmetricKeyType !== 'ed25519') {
      throw new Error('external verifier public key must be an Ed25519 public key')
    }
    return value
  }
  const pem = Buffer.isBuffer(value) ? value.toString('utf8') : value
  if (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/u.test(pem)) {
    throw new Error('external verifier public key must not contain private key PEM')
  }
  const key = createPublicKey(value)
  if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519') {
    throw new Error('external verifier public key must be an Ed25519 public key')
  }
  return key
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

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted
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

async function runVerifier(
  options: VerifierCommand,
  request: IndependentVerificationRequest,
  publicKey: ReturnType<typeof createPublicKey>,
  signal: AbortSignal,
): Promise<IndependentVerificationResult> {
  const timeoutMs = options.timeoutMs
  const payload = `${canonicalJson({ schemaVersion: 1, operation: 'verifyCandidate', request })}\n`
  if (signal.aborted) throw new Error('external verifier aborted')
  const controller = new AbortController()
  const abort = (): void => { controller.abort(signal.reason) }
  let child: SubprocessHandle | undefined
  const timeoutReason = new Error('external verifier timed out')
  const timer = setTimeout(() => {
    controller.abort(timeoutReason)
  }, timeoutMs)
  timer.unref()
  signal.addEventListener('abort', abort, { once: true })
  try {
    const env = safeEnvironment()
    const executable = await options.subprocess.resolveExecutable(options.executable, env, controller.signal)
    child = options.subprocess.spawn({
      argv: [executable, ...options.args],
      cwd: dirname(executable),
      env,
      stdio: { stdin: { data: payload }, stdout: 'pipe', stderr: 'pipe' },
      graceMs: 100,
      signal: controller.signal,
    })
    if (child.stdout === undefined || child.stderr === undefined) {
      throw new Error('external verifier subprocess did not provide piped output')
    }

    let outputBytes = 0
    let stderrBytes = 0
    const outputState = { exceeded: false }
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      outputBytes += bytes.byteLength
      if (outputBytes > MAX_OUTPUT_BYTES) {
        if (!outputState.exceeded) {
          outputState.exceeded = true
          child?.terminate()
        }
        return
      }
      stdout.push(bytes)
    })
    child.stderr.on('data', (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      const remaining = MAX_STDERR_BYTES - stderrBytes
      if (remaining > 0) {
        const retained = bytes.byteLength > remaining ? bytes.subarray(0, remaining) : bytes
        stderr.push(retained)
        stderrBytes += retained.byteLength
      }
    })

    const outcome = await child.done
    if (!await child.waitForExit(controller.signal)) {
      child.terminate()
      if (!await child.waitForExit()) throw new Error('external verifier process tree did not exit')
    }
    if (controller.signal.reason === timeoutReason) throw new Error(`external verifier timed out after ${timeoutMs}ms`)
    if (isAborted(signal)) throw new Error('external verifier aborted')
    if (outputState.exceeded) throw new Error('external verifier output exceeds 256 KiB')
    if (outcome.exitCode !== 0) {
      const detail = Buffer.concat(stderr).toString('utf8').slice(0, 1000)
      throw new Error(`external verifier exited ${String(outcome.exitCode)}${outcome.signal === null ? '' : ` (${outcome.signal})`}${detail === '' ? '' : `: ${detail}`}`)
    }
    const parsed = JSON.parse(Buffer.concat(stdout).toString('utf8')) as IndependentVerificationResult
    if (!verifyResult(options.authorityId, publicKey, request, parsed)) throw new Error('external verifier result signature or request binding is invalid')
    return parsed
  } catch (error) {
    if (child !== undefined) {
      child.terminate()
      await child.done.catch(() => {})
      if (!await child.waitForExit()) throw new Error('external verifier process tree did not exit')
    }
    if (controller.signal.reason === timeoutReason) throw new Error(`external verifier timed out after ${timeoutMs}ms`)
    if (isAborted(signal)) throw new Error('external verifier aborted')
    throw error
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
  }
}

/**
 * Create a launcher-owned verifier authority with captured command configuration and delegated typed signing.
 * @param options - Fixed launcher-owned command, source identity, public key, and verifier timeout.
 * @returns An authority that can be injected into KnowledgeWikiService; signer settlement follows its signal contract.
 */
export function createExternalVerifierAuthority(options: ExternalVerifierOptions): KnowledgeWikiVerifierAuthority {
  if (!AUTHORITY_RE.test(options.authorityId)) throw new Error('external verifier authorityId is invalid')
  if (!isAbsolute(options.executable)) throw new Error('external verifier executable must be absolute')
  if (!validSourceIdentity(options.sourceIdentity)) throw new Error('external verifier source identity is invalid')
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new Error('external verifier timeout is invalid')
  const publicKey = ed25519PublicKey(options.publicKey)
  const promotionSealer = options.promotionSealer
  const promotionSealerAuthorityId = promotionSealer.authorityId
  const delegatedSealPromotion = promotionSealer.sealPromotion.bind(promotionSealer)
  if (promotionSealerAuthorityId !== options.authorityId) throw new Error('promotion sealer authority does not match external verifier')
  const sourceIdentity = Object.freeze({ ...options.sourceIdentity })
  const command: VerifierCommand = Object.freeze({
    authorityId: options.authorityId,
    executable: options.executable,
    args: Object.freeze([...(options.args ?? [])]),
    subprocess: options.subprocess,
    timeoutMs,
  })
  return {
    authorityId: command.authorityId,
    sourceIdentity: () => sourceIdentity,
    verifyCandidate: (request, signal) => runVerifier(command, request, publicKey, signal),
    validateCandidateResult: (request, result) => verifyResult(command.authorityId, publicKey, request, result),
    async sealPromotion(request: KnowledgeWikiPromotionSealRequest, signal?: AbortSignal): Promise<VerificationAuthoritySeal> {
      signal?.throwIfAborted()
      const payload = encodeKnowledgeWikiPromotionSealRequest(request)
      if (request.authorityId !== command.authorityId) throw new Error('promotion seal authority context does not match')
      const seal = await delegatedSealPromotion(request, signal)
      signal?.throwIfAborted()
      if (promotionSealer.authorityId !== promotionSealerAuthorityId
        || seal.authorityId !== command.authorityId
        || !verify(null, Buffer.from(payload, 'utf8'), publicKey, Buffer.from(seal.proof, 'base64'))) {
        throw new Error('promotion sealer returned an invalid authority signature')
      }
      return seal
    },
    validatePromotion(payload: string, seal: VerificationAuthoritySeal): boolean {
      return seal.authorityId === command.authorityId
        && verify(null, Buffer.from(payload, 'utf8'), publicKey, Buffer.from(seal.proof, 'base64'))
    },
    checkpointPromotion(_payload: string, _checkpoint: PromotionCheckpoint): void {},
  }
}
