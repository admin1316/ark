/**
 * Private, launcher-bound client for Ark's protected knowledge owner.
 * This module is not a Remote service and its operation set is intentionally
 * closed to the existing knowledge, measured-use, and cost-observation owners.
 * @module @deepseek-ai/dsh-native-api-app/native-owner-channel
 */

import { createPublicKey, type KeyObject, randomUUID } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import net, { type Socket } from 'node:net'
import { isAbsolute } from 'node:path'
import type { KnowledgeWikiSourceIdentity } from '@deepseek-ai/dsh-knowledge-wiki'

/** Service key for the private channel client provided by Native startup. */
export const NATIVE_KNOWLEDGE_OWNER_CLIENT = 'nativeKnowledgeOwnerClient'

/** Maximum complete UTF-8 JSON frame accepted on the private local channel. */
export const NATIVE_KNOWLEDGE_OWNER_MAX_FRAME_BYTES = 8 * 1024 * 1024

const OPERATIONS: readonly NativeKnowledgeOwnerOperation[] = ['sealPromotion', 'signKnowledgeUseJournal', 'verifyCandidate',
  'evaluateCapturedUse', 'finalizeMeasuredTrial', 'registerProviderDispatch', 'recordProviderSettlement', 'resolveSettledUseCost', 'admitProviderRequest']

const OWNER_ROLES = ['promotion', 'journal', 'evaluator'] as const

/** Closed Native operation names; no generic signing or authorization method exists. */
export type NativeKnowledgeOwnerOperation =
  | 'sealPromotion'
  | 'signKnowledgeUseJournal'
  | 'verifyCandidate'
  | 'evaluateCapturedUse'
  | 'finalizeMeasuredTrial'
  | 'registerProviderDispatch'
  | 'recordProviderSettlement'
  | 'admitProviderRequest'
  | 'resolveSettledUseCost'

/** Per-launch Native endpoint supplied only by the App launcher. */
export interface NativeKnowledgeOwnerEndpoint {
  /** Absolute path of the launch-scoped Unix-domain socket. */
  readonly socketPath: string
  /** Random launch token, used only to bind this backend child to its App launch. */
  readonly launchToken: string
}

/** Public identities authenticated by the private launch handshake. */
export interface NativeKnowledgeOwnerIdentity {
  /** Stable Native/XPC source binding, not a KnowledgeWikiSourceIdentity. */
  readonly sourceBindingHash: string
  /** Frozen build identity supplied by the protected launcher registration. */
  readonly sourceIdentity: KnowledgeWikiSourceIdentity
  /** Launcher-owned read-only content-addressed receipt directory. */
  readonly artifactRoot: string
  /** Role-specific Ed25519 public key identities. */
  readonly authorities: Readonly<Record<NativeKnowledgeOwnerRole, NativeKnowledgeOwnerAuthority>>
}

/** Authority roles exposed by the Native owner. */
export type NativeKnowledgeOwnerRole = typeof OWNER_ROLES[number]

/** Authenticated public signing identity for one fixed owner role. */
export interface NativeKnowledgeOwnerAuthority {
  readonly authorityId: string
  readonly publicKey: KeyObject
  readonly sourceBindingHash: string
}

/** Error returned by a Native operation without leaking transport internals. */
export class NativeKnowledgeOwnerError extends Error {
  /** Stable refusal or transport classification supplied by the owner boundary. */
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'NativeKnowledgeOwnerError'
    this.code = code
  }
}

interface RequestFrame {
  readonly version: 1
  readonly requestId: string
  readonly operation: NativeKnowledgeOwnerOperation
  readonly payload: Readonly<Record<string, unknown>>
}

interface CancelFrame {
  readonly version: 1
  readonly requestId: string
  readonly operation: 'cancel'
}

interface SuccessFrame {
  readonly version: 1
  readonly requestId: string
  readonly ok: true
  readonly result: unknown
}

interface FailureFrame {
  readonly version: 1
  readonly requestId: string
  readonly ok: false
  readonly error: { readonly code: string; readonly message: string }
}

type ResponseFrame = SuccessFrame | FailureFrame

interface HelloFrame {
  readonly version: 1
  readonly operation: 'hello'
  readonly launchToken: string
}

interface ReadyHelloResponse {
  readonly version: 1
  readonly ok: true
  readonly ownerStatus: 'ready'
  readonly sourceIdentity: KnowledgeWikiSourceIdentity
  readonly artifactRoot: string
  readonly authorities: readonly {
    readonly role: NativeKnowledgeOwnerRole
    readonly authorityId: string
    readonly publicKeySpki: string
    readonly sourceBindingHash: string
  }[]
}

interface DisabledHelloResponse {
  readonly version: 1
  readonly ok: true
  readonly ownerStatus: 'disabled'
  readonly authorities: readonly []
}

interface GuardHelloResponse extends DisabledHelloResponse {
  readonly peerRole: 'guard'
  readonly costStatus: 'ready' | 'disabled'
}

type HelloResponse = ReadyHelloResponse | DisabledHelloResponse | GuardHelloResponse

interface PendingCall {
  readonly requestId: string
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
}

/**
 * One serialized request channel to the launch-matched Native owner.
 * @param socket - Connected and authenticated Unix-domain socket.
 * @param identity - Role public keys accepted by the completed hello handshake.
 */
export class NativeKnowledgeOwnerChannel<Identity extends NativeKnowledgeOwnerIdentity | undefined = NativeKnowledgeOwnerIdentity> {
  /** Public identities from the completed handshake; absent for a guard-only peer. */
  readonly identity: Identity
  private readonly socket: Socket
  private receiveBuffer = Buffer.alloc(0)
  private pending: PendingCall | undefined
  private tail: Promise<void> = Promise.resolve()
  private closed = false
  private readonly closedPromise: Promise<void>

  constructor(socket: Socket, identity: Identity) {
    this.socket = socket
    this.identity = identity
    this.closedPromise = new Promise(resolve => socket.once('close', resolve))
    socket.on('data', (chunk) => { this.receive(chunk) })
    socket.on('error', (error) => { this.failClosed(new NativeKnowledgeOwnerError('channel-error', error.message)) })
    socket.on('close', () => { this.failClosed(new NativeKnowledgeOwnerError('channel-closed', 'Native knowledge owner channel closed')) })
  }

  /**
   * Call one of the fixed typed Native operations in serialized order.
   * @param operation - Closed Native owner operation.
   * @param payload - Operation-owned JSON request; Native validates its exact schema.
   * @param signal - Optional operation cancellation signal.
   * @returns The operation-owned JSON result after the Native owner settles.
   * @throws On invalid input, cancellation, protocol failure, or owner refusal.
   */
  async call<TResult = unknown>(
    operation: NativeKnowledgeOwnerOperation,
    payload: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<TResult> {
    if (!OPERATIONS.includes(operation)) throw new NativeKnowledgeOwnerError('unsupported-operation', 'Native knowledge owner operation is not supported')
    this.assertOpen()
    if (signal?.aborted) throw abortError(signal)

    const { promise, resolve: release } = Promise.withResolvers<void>()
    const previous = this.tail
    this.tail = promise
    await previous
    try {
      this.assertOpen()
      if (signal?.aborted) throw abortError(signal)
      const requestId = randomUUID()
      const responsePromise = new Promise<unknown>((resolve, reject) => {
        this.pending = { requestId, resolve, reject }
      })
      const request: RequestFrame = { version: 1, requestId, operation, payload }
      try {
        writeRawFrame(this.socket, request)
      } catch (error) {
        this.clearPending()
        throw asError(error)
      }

      let cancelSent = false
      const cancel = (): void => {
        if (cancelSent || this.closed || this.pending?.requestId !== requestId) return
        cancelSent = true
        try {
          const frame: CancelFrame = { version: 1, requestId, operation: 'cancel' }
          writeRawFrame(this.socket, frame)
        } catch (error) {
          this.failClosed(asError(error))
        }
      }
      signal?.addEventListener('abort', cancel, { once: true })
      if (signal?.aborted) cancel()
      try {
        const result = await responsePromise
        if (signal?.aborted) throw abortError(signal)
        return result as TResult
      } finally {
        signal?.removeEventListener('abort', cancel)
      }
    } finally {
      release()
    }
  }

  /**
   * Close the private channel and settle the active operation as unavailable.
   * @returns After the socket is closed.
   */
  async close(): Promise<void> {
    if (!this.closed) {
      this.failClosed(new NativeKnowledgeOwnerError('channel-closed', 'Native knowledge owner channel disposed'))
    }
    await this.closedPromise
    await this.tail
  }

  /**
   * Observe actual socket termination without initiating shutdown.
   * @returns After the owned socket emits close, including unexpected owner loss.
   */
  whenClosed(): Promise<void> {
    return this.closedPromise
  }

  private assertOpen(): void {
    if (this.closed) throw new NativeKnowledgeOwnerError('channel-closed', 'Native knowledge owner channel is unavailable')
  }

  private receive(chunk: Buffer): void {
    if (this.closed) return
    if (this.receiveBuffer.byteLength + chunk.byteLength > NATIVE_KNOWLEDGE_OWNER_MAX_FRAME_BYTES + 4) {
      this.failClosed(new NativeKnowledgeOwnerError('invalid-frame-size', 'Native knowledge owner buffered frame exceeds the allowed size'))
      return
    }
    this.receiveBuffer = Buffer.concat([this.receiveBuffer, chunk])
    try {
      while (this.receiveBuffer.byteLength >= 4) {
        const length = this.receiveBuffer.readUInt32BE(0)
        if (length < 2 || length > NATIVE_KNOWLEDGE_OWNER_MAX_FRAME_BYTES) {
          throw new NativeKnowledgeOwnerError('invalid-frame-size', 'Native knowledge owner frame exceeds the allowed size')
        }
        if (this.receiveBuffer.byteLength < length + 4) return
        const text = this.receiveBuffer.toString('utf8', 4, length + 4)
        const body = this.receiveBuffer.subarray(4, length + 4)
        if (!Buffer.from(text, 'utf8').equals(body)) {
          throw new NativeKnowledgeOwnerError('invalid-frame-utf8', 'Native knowledge owner frame is not valid UTF-8')
        }
        this.receiveBuffer = this.receiveBuffer.subarray(length + 4)
        let value: unknown
        try {
          value = JSON.parse(text) as unknown
        } catch (error) {
          throw new NativeKnowledgeOwnerError('invalid-frame-json', `Native knowledge owner returned invalid JSON: ${asError(error).message}`)
        }
        this.acceptResponse(value)
      }
    } catch (error) {
      this.failClosed(asError(error))
    }
  }

  private acceptResponse(value: unknown): void {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new NativeKnowledgeOwnerError('invalid-response', 'Native knowledge owner response must be an object')
    }
    const frame = value as Partial<ResponseFrame>
    const pending = this.pending
    if (frame.version !== 1 || typeof frame.requestId !== 'string'
      || pending === undefined || frame.requestId !== pending.requestId
      || typeof frame.ok !== 'boolean') {
      throw new NativeKnowledgeOwnerError('unexpected-response', 'Native knowledge owner response did not match the active request')
    }
    if (frame.ok) {
      if (!exactKeys(frame, ['version', 'requestId', 'ok', 'result'])) {
        throw new NativeKnowledgeOwnerError('invalid-response', 'Native knowledge owner success response is missing its result')
      }
      this.pending = undefined
      pending.resolve(frame.result)
      return
    }
    const failure = frame as FailureFrame
    if (!exactKeys(frame, ['version', 'requestId', 'ok', 'error'])
      || !exactKeys(failure.error, ['code', 'message'])
      || typeof failure.error.code !== 'string' || typeof failure.error.message !== 'string') {
      throw new NativeKnowledgeOwnerError('invalid-response', 'Native knowledge owner failure response is malformed')
    }
    this.pending = undefined
    pending.reject(new NativeKnowledgeOwnerError(failure.error.code, failure.error.message))
  }

  private clearPending(): void {
    this.pending = undefined
  }

  private failClosed(error: Error): void {
    if (this.closed) return
    this.closed = true
    const pending = this.pending
    this.pending = undefined
    this.socket.destroy()
    if (pending !== undefined) void this.closedPromise.then(() => { pending.reject(error) })
  }
}

/**
 * Connect and authenticate the one launch-scoped Native owner channel.
 * @param endpoint - Socket path and private launch token injected by App.
 * @param signal - Launch teardown signal; handshake cancellation joins the closed socket.
 * @returns Authenticated channel and public owner identity, or an explicit disabled result.
 * @throws On partial/malformed launcher configuration, unexpected peer response, or connection failure.
 */
export async function connectNativeKnowledgeOwner(
  endpoint: NativeKnowledgeOwnerEndpoint,
  signal?: AbortSignal,
): Promise<{ readonly status: 'disabled' } | { readonly status: 'ready'; readonly channel: NativeKnowledgeOwnerChannel }> {
  return connectOwner(endpoint, 'signing', signal)
}

type OwnerConnection<Identity extends NativeKnowledgeOwnerIdentity | undefined> =
  | { readonly status: 'disabled' }
  | { readonly status: 'ready'; readonly channel: NativeKnowledgeOwnerChannel<Identity> }

function connectOwner(
  endpoint: NativeKnowledgeOwnerEndpoint, role: 'signing', signal?: AbortSignal,
): Promise<OwnerConnection<NativeKnowledgeOwnerIdentity>>
function connectOwner(
  endpoint: NativeKnowledgeOwnerEndpoint, role: 'guard', signal?: AbortSignal,
): Promise<OwnerConnection<undefined>>
async function connectOwner(
  endpoint: NativeKnowledgeOwnerEndpoint, role: 'signing' | 'guard', signal?: AbortSignal,
): Promise<OwnerConnection<NativeKnowledgeOwnerIdentity | undefined>> {
  validateEndpoint(endpoint)
  signal?.throwIfAborted()
  const info = await lstat(endpoint.socketPath)
  if (!info.isSocket()) throw new NativeKnowledgeOwnerError('invalid-socket-path', 'Native knowledge owner endpoint is not a Unix socket')
  signal?.throwIfAborted()
  const socket = net.createConnection({ path: endpoint.socketPath })
  const closed = new Promise<void>(resolve => socket.once('close', resolve))
  const abort = (): void => {
    socket.destroy(new NativeKnowledgeOwnerError('launch-cancelled', 'Native knowledge owner launch was cancelled'))
  }
  signal?.addEventListener('abort', abort, { once: true })
  const deadline = setTimeout(() => {
    socket.destroy(new NativeKnowledgeOwnerError('hello-timeout', 'Native knowledge owner did not complete its handshake within 10 seconds'))
  }, 10_000)
  deadline.unref()
  try {
    await waitConnected(socket)
    const helloPending = readHello(socket)
    writeRawFrame(socket, { version: 1, operation: 'hello', launchToken: endpoint.launchToken })
    const hello = await helloPending
    if (role === 'guard' && !('peerRole' in hello)) {
      throw new NativeKnowledgeOwnerError('wrong-owner-role', 'Guard cost channel requires a launch-authenticated guard peer')
    }
    if (role === 'signing' && 'peerRole' in hello) {
      throw new NativeKnowledgeOwnerError('wrong-owner-role', 'Guard cost channel cannot provide signing authorities')
    }
    if ('peerRole' in hello && hello.costStatus === 'ready') {
      return { status: 'ready', channel: new NativeKnowledgeOwnerChannel(socket, undefined) }
    }
    if (hello.ownerStatus === 'disabled') {
      socket.destroy()
      await closed
      return { status: 'disabled' }
    }
    const identity = parseOwnerIdentity(hello)
    return { status: 'ready', channel: new NativeKnowledgeOwnerChannel(socket, identity) }
  } catch (error) {
    socket.destroy()
    await closed
    throw error
  } finally {
    clearTimeout(deadline)
    signal?.removeEventListener('abort', abort)
  }
}

/** Guard ingress observation; App determines the guard role from the actual launch peer. */
export interface NativeGuardAdmissionRequest {
  readonly schemaVersion: 1
  readonly dispatchId: string
  readonly attemptId: string
  readonly sessionIdHash: string
  readonly requestBodyHash: string
  readonly maxTokens: number
}

/** Settled guard observation; no trial admission or counters can be supplied. */
export interface NativeGuardSettlementRequest extends NativeGuardAdmissionRequest {
  readonly responseIdHash: string
  readonly responseModel: string
  readonly inputTokens: number
  readonly outputTokens: number
  readonly upperBoundMicroCny: number
  readonly finishReason: string
  readonly settledAt: string
}

/**
 * Connect a separately launched guard to the same bounded codec and serialized lifecycle.
 * @param endpoint - The guard-specific endpoint and token injected by its App owner.
 * @param signal - Optional launch cancellation; teardown joins socket closure.
 * @returns A disabled result, or two fixed cost methods, socket termination, and their channel disposer; no signing identity is created.
 */
export async function connectNativeGuardCostOwner(endpoint: NativeKnowledgeOwnerEndpoint, signal?: AbortSignal): Promise<
  | { readonly status: 'disabled' }
  | {
    readonly status: 'ready'
    readonly close: () => Promise<void>
    readonly closed: Promise<void>
    readonly client: {
      readonly admitProviderRequest: (request: NativeGuardAdmissionRequest, signal?: AbortSignal) => Promise<{ readonly status: 'matched' }>
      readonly recordProviderSettlement: (request: NativeGuardSettlementRequest, signal?: AbortSignal) => Promise<{
        readonly status: 'recorded'
        readonly artifactHash: string
      }>
    }
  }
> {
  const connected = await connectOwner(endpoint, 'guard', signal)
  if (connected.status === 'disabled') return connected
  const call = connected.channel.call.bind(connected.channel)
  const close = connected.channel.close.bind(connected.channel)
  return Object.freeze({ status: 'ready' as const, close, closed: connected.channel.whenClosed(), client: Object.freeze({
    async admitProviderRequest(request: NativeGuardAdmissionRequest, signal?: AbortSignal): Promise<{ readonly status: 'matched' }> {
      const result = await call('admitProviderRequest', { ...request }, signal)
      if (!exactKeys(result, ['status']) || result.status !== 'matched') {
        throw new NativeKnowledgeOwnerError('invalid-result', 'Guard admission response is malformed')
      }
      return { status: 'matched' }
    },
    async recordProviderSettlement(request: NativeGuardSettlementRequest, signal?: AbortSignal): Promise<{
      readonly status: 'recorded'
      readonly artifactHash: string
    }> {
      const result = await call('recordProviderSettlement', { ...request }, signal)
      if (!exactKeys(result, ['status', 'artifactHash']) || result.status !== 'recorded'
        || typeof result.artifactHash !== 'string' || !/^[a-f0-9]{64}$/u.test(result.artifactHash)) {
        throw new NativeKnowledgeOwnerError('invalid-result', 'Guard settlement response is malformed')
      }
      return { status: 'recorded', artifactHash: result.artifactHash }
    },
  }) })
}

/**
 * Read launcher-provided endpoint variables without inheriting them from profiles.
 * @param environment - The process environment supplied by the Native launcher.
 * @returns Endpoint when configured, otherwise an explicit disabled state.
 * @throws If only one variable is present or either value is malformed.
 */
export function nativeKnowledgeOwnerEndpointFromEnvironment(
  environment: NodeJS.ProcessEnv,
): NativeKnowledgeOwnerEndpoint | undefined {
  const socketPath = environment.ARK_NATIVE_OWNER_SOCKET_PATH
  const launchToken = environment.ARK_NATIVE_OWNER_LAUNCH_TOKEN
  if (socketPath === undefined && launchToken === undefined) return undefined
  if (socketPath === undefined || launchToken === undefined) {
    throw new NativeKnowledgeOwnerError('invalid-launch-config', 'Native knowledge owner endpoint configuration is incomplete')
  }
  const endpoint = { socketPath, launchToken }
  validateEndpoint(endpoint)
  return endpoint
}

function parseOwnerIdentity(hello: ReadyHelloResponse): NativeKnowledgeOwnerIdentity {
  const authorities: Partial<Record<NativeKnowledgeOwnerRole, NativeKnowledgeOwnerAuthority>> = {}
  let sourceBindingHash: string | undefined
  for (const value of hello.authorities) {
    if (!OWNER_ROLES.includes(value.role)
      || typeof value.authorityId !== 'string' || value.authorityId.length === 0
      || typeof value.publicKeySpki !== 'string' || value.publicKeySpki.length === 0
      || !/^[a-f0-9]{64}$/u.test(value.sourceBindingHash)
      || authorities[value.role] !== undefined) {
      throw new NativeKnowledgeOwnerError('invalid-hello', 'Native knowledge owner authority identity is malformed or duplicated')
    }
    if (!/^-----BEGIN PUBLIC KEY-----[\s\S]+-----END PUBLIC KEY-----\s*$/u.test(value.publicKeySpki)) {
      throw new NativeKnowledgeOwnerError('invalid-hello', 'Native knowledge owner requires public SPKI keys')
    }
    const publicKey = createPublicKey(value.publicKeySpki)
    if (publicKey.type !== 'public' || publicKey.asymmetricKeyType !== 'ed25519') {
      throw new NativeKnowledgeOwnerError('invalid-hello', 'Native knowledge owner must advertise Ed25519 public keys')
    }
    if (sourceBindingHash !== undefined && sourceBindingHash !== value.sourceBindingHash) {
      throw new NativeKnowledgeOwnerError('invalid-hello', 'Native owner roles have mismatched source bindings')
    }
    sourceBindingHash = value.sourceBindingHash
    authorities[value.role] = Object.freeze({
      authorityId: value.authorityId,
      publicKey,
      sourceBindingHash: value.sourceBindingHash,
    })
  }
  const { promotion, journal, evaluator } = authorities
  if (promotion === undefined || journal === undefined || evaluator === undefined || sourceBindingHash === undefined) {
    throw new NativeKnowledgeOwnerError('invalid-hello', 'Native owner is missing a required signing authority')
  }
  return Object.freeze({
    sourceBindingHash, sourceIdentity: Object.freeze({ ...hello.sourceIdentity }), artifactRoot: hello.artifactRoot,
    authorities: Object.freeze({ promotion, journal, evaluator }),
  })
}

function validateEndpoint(endpoint: NativeKnowledgeOwnerEndpoint): void {
  if (typeof endpoint.socketPath !== 'string' || !isAbsolute(endpoint.socketPath)
    || endpoint.socketPath.includes('\0') || endpoint.socketPath.length > 100) {
    throw new NativeKnowledgeOwnerError('invalid-launch-config', 'Native knowledge owner socket path must be an absolute Unix socket path')
  }
  if (typeof endpoint.launchToken !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/u.test(endpoint.launchToken)) {
    throw new NativeKnowledgeOwnerError('invalid-launch-config', 'Native knowledge owner launch token is malformed')
  }
}

function waitConnected(socket: Socket): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      socket.removeListener('connect', onConnect)
      reject(new NativeKnowledgeOwnerError('connect-failed', error.message))
    }
    const onConnect = (): void => {
      socket.removeListener('error', onError)
      resolve()
    }
    socket.once('error', onError)
    socket.once('connect', onConnect)
  })
}

function readHello(socket: Socket): Promise<HelloResponse> {
  return new Promise<HelloResponse>((resolve, reject) => {
    let buffer = Buffer.alloc(0)
    const cleanup = (): void => {
      socket.removeListener('data', onData)
      socket.removeListener('error', onError)
      socket.removeListener('close', onClose)
    }
    const onError = (error: Error): void => {
      cleanup()
      reject(new NativeKnowledgeOwnerError('hello-failed', error.message))
    }
    const onClose = (): void => {
      cleanup()
      reject(new NativeKnowledgeOwnerError('hello-failed', 'Native knowledge owner closed before hello completed'))
    }
    const onData = (chunk: Buffer): void => {
      if (buffer.byteLength + chunk.byteLength > NATIVE_KNOWLEDGE_OWNER_MAX_FRAME_BYTES + 4) {
        cleanup()
        reject(new NativeKnowledgeOwnerError('invalid-hello', 'Native knowledge owner request exceeds the allowed frame size'))
        return
      }
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.byteLength < 4) return
      const length = buffer.readUInt32BE(0)
      if (length < 2 || length > NATIVE_KNOWLEDGE_OWNER_MAX_FRAME_BYTES) {
        cleanup()
        reject(new NativeKnowledgeOwnerError('invalid-hello', 'Native knowledge owner hello response exceeds the allowed frame size'))
        return
      }
      if (buffer.byteLength < length + 4) return
      if (buffer.byteLength !== length + 4) {
        cleanup()
        reject(new NativeKnowledgeOwnerError('invalid-hello', 'Native knowledge owner sent data before hello completed'))
        return
      }
      const body = buffer.subarray(4)
      const text = body.toString('utf8')
      if (!Buffer.from(text, 'utf8').equals(body)) {
        cleanup()
        reject(new NativeKnowledgeOwnerError('invalid-hello', 'Native knowledge owner hello is not valid UTF-8'))
        return
      }
      try {
        const value = JSON.parse(text) as unknown
        if (!isHelloResponse(value)) throw new Error('hello response shape is invalid')
        cleanup()
        resolve(value)
      } catch (error) {
        cleanup()
        reject(new NativeKnowledgeOwnerError('invalid-hello', asError(error).message))
      }
    }
    socket.on('data', onData)
    socket.once('error', onError)
    socket.once('close', onClose)
  })
}

function isHelloResponse(value: unknown): value is HelloResponse {
  if (exactKeys(value, ['version', 'ok', 'ownerStatus', 'authorities', 'peerRole', 'costStatus'])) {
    return value.version === 1 && value.ok === true && value.ownerStatus === 'disabled'
      && Array.isArray(value.authorities) && value.authorities.length === 0 && value.peerRole === 'guard'
      && (value.costStatus === 'ready' || value.costStatus === 'disabled')
  }
  if (!exactKeys(value, ['version', 'ok', 'ownerStatus', 'authorities'], ['sourceIdentity', 'artifactRoot'])) return false
  const response = value as unknown as Partial<Omit<ReadyHelloResponse, 'ownerStatus'> & { ownerStatus: 'disabled' | 'ready' }>
  if (response.version !== 1 || response.ok !== true
    || (response.ownerStatus !== 'disabled' && response.ownerStatus !== 'ready')
    || !Array.isArray(response.authorities)) return false
  if (response.ownerStatus === 'disabled') return response.authorities.length === 0
    && !Object.hasOwn(response, 'sourceIdentity') && !Object.hasOwn(response, 'artifactRoot')
  const identity = response.sourceIdentity
  if (!exactKeys(identity, ['commit', 'sourceDigest', 'dirty', 'dirtyDigest', 'buildDigest'])
    || typeof identity.commit !== 'string' || !/^[a-f0-9]{40}$/u.test(identity.commit)
    || typeof identity.dirty !== 'boolean'
    || !['sourceDigest', 'dirtyDigest', 'buildDigest'].every(key => typeof identity[key] === 'string' && /^[a-f0-9]{64}$/u.test(identity[key]))
    || typeof response.artifactRoot !== 'string' || !isAbsolute(response.artifactRoot) || response.artifactRoot.includes('\0')) return false
  return response.authorities.every(authority => typeof authority === 'object' && authority !== null
    && exactKeys(authority, ['role', 'authorityId', 'publicKeySpki', 'sourceBindingHash'])
    && OWNER_ROLES.includes((authority as ReadyHelloResponse['authorities'][number]).role)
    && typeof (authority as ReadyHelloResponse['authorities'][number]).authorityId === 'string'
    && typeof (authority as ReadyHelloResponse['authorities'][number]).publicKeySpki === 'string'
    && typeof (authority as ReadyHelloResponse['authorities'][number]).sourceBindingHash === 'string')
}

function writeRawFrame(socket: Socket, value: HelloFrame | RequestFrame | CancelFrame): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  if (body.byteLength > NATIVE_KNOWLEDGE_OWNER_MAX_FRAME_BYTES) {
    throw new NativeKnowledgeOwnerError('request-too-large', 'Native knowledge owner request exceeds the allowed frame size')
  }
  const header = Buffer.allocUnsafe(4)
  header.writeUInt32BE(body.byteLength, 0)
  socket.write(Buffer.concat([header, body]))
}

function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  return reason instanceof Error ? reason : new NativeKnowledgeOwnerError('aborted', 'Native knowledge owner operation was cancelled')
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function exactKeys(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => required.includes(key) || optional.includes(key))
}
