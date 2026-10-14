/** Private Native channel framing, ownership and real Loader consumer contracts. */
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { lstat, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { createServer, Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { canonicalJson, encodeKnowledgeWikiPromotionSealRequest, type KnowledgeWikiPromotionSealRequest, type KnowledgeWikiVerifierAuthority, type IndependentVerificationRequest } from '@deepseek-ai/dsh-knowledge-wiki'
import { NativeKnowledgeOwnerChannel, connectNativeKnowledgeOwner, nativeKnowledgeOwnerEndpointFromEnvironment, NATIVE_KNOWLEDGE_OWNER_MAX_FRAME_BYTES } from '../src/native-owner-channel.ts'
import { createNativeKnowledgeOwnerProviders } from '../src/native-owner-providers.ts'
import { connectNativeGuardCostOwner } from '../src/startup.ts'
import * as Startup from '../src/startup.ts'

// Only exact Windows fixture endpoints receive Unix stat test doubles; transport stays real.
const socketStats = vi.hoisted(() => new Map<string, Awaited<ReturnType<typeof lstat>>>())
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, lstat: async (...args: Parameters<typeof actual.lstat>) =>
    socketStats.get(String(args[0])) ?? actual.lstat(...args) }
})
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); socketStats.clear(); vi.unstubAllEnvs() })
const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
const sourceIdentity = { commit: 'a'.repeat(40), sourceDigest: digest('source'), dirty: true, dirtyDigest: digest('dirty'), buildDigest: digest('build') }
const token = 'test-launch-token-'.repeat(3)
const keys = Object.fromEntries(['promotion', 'journal', 'evaluator'].map(role => [role, generateKeyPairSync('ed25519')]))
type Frame = Record<string, unknown>
function frame(value: unknown): Buffer {
  const bytes = Buffer.from(JSON.stringify(value))
  const head = Buffer.alloc(4)
  head.writeUInt32BE(bytes.length)
  return Buffer.concat([head, bytes])
}
async function fixture(options: {
  socketPath?: string
  attestWindowsPipe?: boolean
  hello?: (value: Frame) => unknown
  request?: (value: Frame, peer: Socket) => void
  rawHello?: Buffer
  helloPeer?: (peer: Socket) => void
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ark-owner-'))
  const socketPath = options.socketPath ?? (process.platform === 'win32' ? String.raw`\\.\pipe\ark-owner-${randomUUID()}` : join(root, 'owner.sock'))
  const peers = new Set<Socket>()
  const requests: Frame[] = []
  const hello = { version: 1, ok: true, ownerStatus: 'ready', sourceIdentity, artifactRoot: root,
    authorities: Object.entries(keys).map(([role, key]) => ({ role, authorityId: `native-test:${role}`, publicKeySpki: key.publicKey.export({ type: 'spki', format: 'pem' }), sourceBindingHash: digest('binding') })) }
  const server = createServer((peer) => {
    peers.add(peer); peer.on('error', () => {}); peer.on('close', () => peers.delete(peer))
    let buffer = Buffer.alloc(0)
    peer.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      while (buffer.length >= 4 && buffer.length >= buffer.readUInt32BE(0) + 4) {
        const count = buffer.readUInt32BE(0); const value = JSON.parse(buffer.subarray(4, count + 4).toString()) as Frame
        buffer = buffer.subarray(count + 4)
        if (value.operation === 'hello') {
          expect(value).toEqual({ version: 1, operation: 'hello', launchToken: token })
          if (options.helloPeer !== undefined) options.helloPeer(peer)
          else peer.write(options.rawHello ?? frame(options.hello?.(hello) ?? hello))
        } else { requests.push(value); options.request?.(value, peer) }
      }
    })
  })
  cleanups.push(async () => {
    for (const peer of peers) peer.destroy()
    if (server.listening) await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    await rm(root, { recursive: true, force: true })
  })
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error): void => { reject(error) }
    server.once('error', failed)
    server.listen(socketPath, () => { server.off('error', failed); resolve() })
  })
  if (process.platform === 'win32' && options.attestWindowsPipe !== false) {
    const info = await lstat(root)
    const socketInfo = Object.create(info) as typeof info
    socketInfo.isSocket = () => true
    socketStats.set(socketPath, socketInfo)
  }
  return { root, endpoint: { socketPath, launchToken: token }, requests, peers, server }
}
async function ready(options: Parameters<typeof fixture>[0] = {}) {
  const owner = await fixture(options)
  const result = await connectNativeKnowledgeOwner(owner.endpoint)
  if (result.status !== 'ready') throw new Error('Expected test owner ready')
  cleanups.push(() => result.channel.close())
  return { ...owner, channel: result.channel }
}
const respond = (peer: Socket, request: Frame, result: unknown): void => {
  peer.write(frame({ version: 1, requestId: request.requestId, ok: true, result }))
}

describe('private Native channel', () => {
  it('rejects fixture listen failures before constructing a channel', async () => {
    await expect(fixture({ socketPath: join(tmpdir(), `ark-missing-${randomUUID()}`, 'owner.sock') })).rejects.toThrow()
  })
  it.runIf(process.platform === 'win32')('refuses a Windows pipe as a trusted Unix owner without publishing authority', async () => {
    const owner = await fixture({ attestWindowsPipe: false })
    await expect(connectNativeKnowledgeOwner(owner.endpoint)).rejects.toThrow()
    await expect(connectNativeGuardCostOwner(owner.endpoint)).rejects.toThrow()
    expect(owner.peers.size).toBe(0)
    vi.stubEnv('ARK_NATIVE_OWNER_SOCKET_PATH', owner.endpoint.socketPath); vi.stubEnv('ARK_NATIVE_OWNER_LAUNCH_TOKEN', token)
    const context = new Context(); cleanups.push(() => context.fiber.dispose())
    provideCmdline(context, { args: [], exit: () => {} })
    await expect(Startup.apply(context)).rejects.toThrow()
    expect(context.get('knowledgeWikiVerifierAuthority')).toBeUndefined()
    expect(context.get('nativeApiStartup')).toBeUndefined()
    expect(owner.peers.size).toBe(0)
  })
  it('keeps absent configuration and a disabled handshake without authority providers', async () => {
    expect(nativeKnowledgeOwnerEndpointFromEnvironment({})).toBeUndefined()
    const owner = await fixture({ hello: () => ({ version: 1, ok: true, ownerStatus: 'disabled', authorities: [] }) })
    expect(await connectNativeKnowledgeOwner(owner.endpoint)).toEqual({ status: 'disabled' })
  })
  it.each([
    { ARK_NATIVE_OWNER_SOCKET_PATH: '/tmp/a' },
    { ARK_NATIVE_OWNER_SOCKET_PATH: 'relative', ARK_NATIVE_OWNER_LAUNCH_TOKEN: token },
    { ARK_NATIVE_OWNER_SOCKET_PATH: '/tmp/a', ARK_NATIVE_OWNER_LAUNCH_TOKEN: 'short' },
  ])('rejects malformed launch configuration before connecting: %j', (env) => {
    expect(() => nativeKnowledgeOwnerEndpointFromEnvironment(env)).toThrow()
  })
  it('rejects regular files as a socket endpoint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ark-owner-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const file = join(root, 'plain'); await writeFile(file, '')
    await expect(connectNativeKnowledgeOwner({ launchToken: token, socketPath: file })).rejects.toThrow(/Unix socket/)
  })
  it.each([
    (hello: Frame) => ({ ...hello, unexpected: true }),
    (hello: Frame) => ({ ...hello, version: 2 }),
    (hello: Frame) => ({ ...hello, sourceIdentity: { digest: digest('not-identity') } }),
    (hello: Frame) => ({ ...hello, authorities: [] }),
    () => ({ version: 1, ok: true, ownerStatus: 'disabled', authorities: [], sourceIdentity }),
    (hello: Frame) => ({ ...hello, authorities: [...hello.authorities as unknown[], (hello.authorities as unknown[])[0]] }),
    (hello: Frame) => ({ ...hello, authorities: (hello.authorities as Frame[]).map(row => ({ ...row, publicKeySpki: keys.promotion!.privateKey.export({ type: 'pkcs8', format: 'pem' }) })) }),
  ])('rejects malformed or inflated authority hello %#', async (transform) => {
    const owner = await fixture({ hello: transform }); await expect(connectNativeKnowledgeOwner(owner.endpoint)).rejects.toThrow()
  })
  it.each([
    Buffer.from([0, 0, 0, 1]), Buffer.from([0, 128, 0, 1]), Buffer.from([0, 0, 0, 2, 0xff, 0xff]),
    Buffer.concat([frame({}), frame({})]),
  ])('rejects malformed hello framing %#', async (rawHello) => {
    const owner = await fixture({ rawHello }); await expect(connectNativeKnowledgeOwner(owner.endpoint)).rejects.toThrow()
  })
  it('rejects a peer that closes before hello and a stale socket endpoint', async () => {
    const owner = await fixture({ helloPeer(peer) { peer.end() } })
    await expect(connectNativeKnowledgeOwner(owner.endpoint)).rejects.toThrow(/closed before hello/)
    const stale = process.platform === 'win32' ? owner.endpoint.socketPath : join(owner.root, 'stale.sock')
    if (process.platform !== 'win32') await rename(owner.endpoint.socketPath, stale)
    await new Promise<void>((resolve) => { owner.server.close(() => { resolve() }) })
    await expect(connectNativeKnowledgeOwner({ ...owner.endpoint, socketPath: stale })).rejects.toThrow()
  })
  it('rejects mismatched source bindings and non-Ed25519 authority keys', async () => {
    for (const transform of [
      (hello: Frame) => ({ ...hello, authorities: (hello.authorities as Frame[]).map((row, i) => ({ ...row, sourceBindingHash: digest(`different:${i}`) })) }),
      (hello: Frame) => ({ ...hello, authorities: (hello.authorities as Frame[]).map(row => ({ ...row, publicKeySpki: generateKeyPairSync('x25519').publicKey.export({ type: 'spki', format: 'pem' }) })) }),
    ]) {
      const owner = await fixture({ hello: transform }); await expect(connectNativeKnowledgeOwner(owner.endpoint)).rejects.toThrow()
    }
  })
  it('rejects unsupported operations, pre-cancelled and queued-cancelled calls without dispatch', async () => {
    let current: Frame | undefined; let currentPeer: Socket | undefined
    const owner = await ready({ request(request, peer) { current = request; currentPeer = peer } })
    await expect(owner.channel.call('authorize' as never, {})).rejects.toThrow(/not supported/)
    await expect(owner.channel.call('verifyCandidate', {}, AbortSignal.abort('stop'))).rejects.toThrow(/cancelled/)
    const first = owner.channel.call('verifyCandidate', {})
    await vi.waitFor(() => { expect(current).toBeDefined() })
    const controller = new AbortController()
    const second = expect(owner.channel.call('evaluateCapturedUse', {}, controller.signal)).rejects.toThrow('queued cancellation')
    controller.abort(new Error('queued cancellation'))
    respond(currentPeer!, current!, true)
    await first; await second
    expect(owner.requests).toHaveLength(1)
  })
  it('waits for owner success after cancellation and refuses to return the cancelled result', async () => {
    const owner = await ready({ request(request, peer) { if (request.operation === 'cancel') respond(peer, request, true) } })
    const controller = new AbortController()
    const result = expect(owner.channel.call('verifyCandidate', {}, controller.signal)).rejects.toThrow(/stop after dispatch/)
    await vi.waitFor(() => { expect(owner.requests).toHaveLength(1) })
    controller.abort(new Error('stop after dispatch'))
    await result
  })
  it('assembles fragmented hello without accepting partial JSON', async () => {
    const disabled = frame({ version: 1, ok: true, ownerStatus: 'disabled', authorities: [] })
    const owner = await fixture({ helloPeer(peer) {
      peer.write(disabled.subarray(0, 2))
      setTimeout(() => { peer.write(disabled.subarray(2, 6)) }, 10)
      setTimeout(() => { peer.write(disabled.subarray(6)) }, 20)
    } })
    expect(await connectNativeKnowledgeOwner(owner.endpoint)).toEqual({ status: 'disabled' })
  })
  it('assembles fragmented response bodies without accepting partial JSON', async () => {
    const active = await ready({ request(request, peer) {
      const bytes = frame({ version: 1, requestId: request.requestId, ok: true, result: true })
      peer.write(bytes.subarray(0, 8)); setTimeout(() => { peer.write(bytes.subarray(8)) }, 10)
    } })
    expect(await active.channel.call('verifyCandidate', {})).toBe(true)
  })
  it('rejects an over-bound buffered hello before retaining the complete message', async () => {
    const bytes = Buffer.alloc(NATIVE_KNOWLEDGE_OWNER_MAX_FRAME_BYTES + 5)
    bytes.writeUInt32BE(NATIVE_KNOWLEDGE_OWNER_MAX_FRAME_BYTES)
    const owner = await fixture({ rawHello: bytes })
    await expect(connectNativeKnowledgeOwner(owner.endpoint)).rejects.toThrow(/frame size/)
  })
  it('contains socket errors, oversized callbacks and late data after close', async () => {
    const owner = await ready()
    for (const event of ['error', 'oversized'] as const) {
      const socket = new Socket()
      const channel = new NativeKnowledgeOwnerChannel(socket, owner.channel.identity)
      if (event === 'error') socket.emit('error', new Error('transport error'))
      else socket.emit('data', Buffer.alloc(NATIVE_KNOWLEDGE_OWNER_MAX_FRAME_BYTES + 5))
      socket.emit('data', Buffer.from([1]))
      await channel.close()
      await expect(channel.call('verifyCandidate', {})).rejects.toThrow(/unavailable/)
    }
  })
  it('contains a cancellation writer failure and cancellation while the write callback settles', async () => {
    const owner = await ready()
    for (const lateSuccess of [false, true]) {
      const socket = new Socket()
      const channel = new NativeKnowledgeOwnerChannel(socket, owner.channel.identity)
      const controller = new AbortController()
      let writes = 0
      vi.spyOn(socket, 'write').mockImplementation((buffer) => {
        writes++
        if (writes === 2) throw 'cancel writer failed'
        if (lateSuccess) {
          const request = JSON.parse((buffer as Buffer).subarray(4).toString()) as Frame
          socket.emit('data', frame({ version: 1, requestId: request.requestId, ok: true, result: true }))
          controller.abort(new Error('cancelled during send'))
        }
        return true
      })
      const completion = expect(channel.call('verifyCandidate', {}, controller.signal)).rejects.toThrow(
        lateSuccess ? /cancelled during send/ : /cancel writer failed/,
      )
      if (!lateSuccess) { await vi.waitFor(() => { expect(writes).toBe(1) }); controller.abort() }
      await completion
      await channel.close()
    }
  })
  it('bounds a stalled handshake and joins the deadline socket close', { timeout: 15_000 }, async () => {
    const owner = await fixture({ rawHello: Buffer.alloc(0) })
    await expect(connectNativeKnowledgeOwner(owner.endpoint)).rejects.toThrow(/10 seconds/)
    await vi.waitFor(() => { expect(owner.peers.size).toBe(0) })
  })
  it('preserves actual frozen source identity and decodes split responses', async () => {
    const owner = await ready({ request(request, peer) {
      const bytes = frame({ version: 1, requestId: request.requestId, ok: true, result: { accepted: true } })
      peer.write(bytes.subarray(0, 3)); setImmediate(() => peer.write(bytes.subarray(3)))
    } })
    expect(owner.channel.identity.sourceIdentity).toEqual(sourceIdentity)
    expect(Object.isFrozen(owner.channel.identity.sourceIdentity)).toBe(true)
    await expect(owner.channel.call('verifyCandidate', {})).resolves.toEqual({ accepted: true })
  })
  it('serializes cancellation until the matching owner acknowledgement', async () => {
    let cancelPeer: Socket | undefined; let cancelFrame: Frame | undefined
    const owner = await ready({ request(request, peer) {
      if (request.operation === 'cancel') { cancelPeer = peer; cancelFrame = request }
      else if (owner.requests.length > 2) respond(peer, request, { done: true })
    } })
    const controller = new AbortController()
    let settled = false
    const first = owner.channel.call('verifyCandidate', {}, controller.signal).finally(() => { settled = true })
    const firstCheck = expect(first).rejects.toThrow('cancelled in test')
    await vi.waitFor(() => { expect(owner.requests).toHaveLength(1) })
    const second = owner.channel.call('evaluateCapturedUse', {})
    controller.abort(new Error('cancelled in test'))
    await vi.waitFor(() => { expect(cancelFrame).toBeDefined() })
    expect(settled).toBe(false); expect(owner.requests).toHaveLength(2)
    cancelPeer!.write(frame({ version: 1, requestId: cancelFrame!.requestId, ok: false, error: { code: 'cancelled', message: 'cancelled in test' } }))
    await firstCheck
    await expect(second).resolves.toEqual({ done: true })
  })
  it.each([
    () => frame(null),
    (_request: Frame) => frame({ version: 1, requestId: 'other-id', ok: true, result: null }),
    (request: Frame) => frame({ version: 1, requestId: request.requestId, ok: true, result: null, extra: true }),
    (request: Frame) => frame({ version: 1, requestId: request.requestId, ok: false, error: { code: 4, message: 'bad' } }),
    () => { const header = Buffer.alloc(4); header.writeUInt32BE(NATIVE_KNOWLEDGE_OWNER_MAX_FRAME_BYTES + 1); return header },
    () => Buffer.from([0, 0, 0, 2, 0xff, 0xff]),
    () => Buffer.from([0, 0, 0, 2, 0x7b, 0x7b]),
  ])('closes on malformed or uncorrelated response %#', async (output) => {
    const owner = await ready({ request(request, peer) { peer.write(output(request)) } })
    await expect(owner.channel.call('verifyCandidate', {})).rejects.toThrow()
    await owner.channel.close()
    await expect(owner.channel.call('verifyCandidate', {})).rejects.toThrow(/unavailable/)
  })
  it('joins active and queued promises when the owner closes', async () => {
    const owner = await ready({ request(_request, peer) { peer.end() } })
    const first = expect(owner.channel.call('verifyCandidate', {})).rejects.toThrow(/closed/)
    const second = expect(owner.channel.call('evaluateCapturedUse', {})).rejects.toThrow(/unavailable/)
    await Promise.all([first, second]); await owner.channel.close()
  })
  it('rejects oversized outgoing bodies without leaving a pending request', async () => {
    const owner = await ready({ request(request, peer) { respond(peer, request, true) } })
    await expect(owner.channel.call('verifyCandidate', { text: 'x'.repeat(NATIVE_KNOWLEDGE_OWNER_MAX_FRAME_BYTES) })).rejects.toThrow(/frame size/)
    await expect(owner.channel.call('verifyCandidate', {})).resolves.toBe(true)
  })
})

const candidateRequest: IndependentVerificationRequest = {
  schemaVersion: 2, review: { id: 'review:1', resolved: false }, reviewHash: digest('review'),
  candidatePath: '_candidates/topic.md', candidateHash: digest('candidate'), sourceHash: digest('source'),
  targetPath: 'concepts/topic.md', governanceAction: 'Promote',
  governanceDecision: { action: 'Promote', targetPath: 'concepts/topic.md', policyVersion: 'test' }, sourceIdentity,
  environment: { nodeVersion: process.versions.node, platform: process.platform, arch: process.arch, policyVersion: 'test' },
}
const fixedRequest = {
  schemaVersion: 1 as const, operation: 'verify-registered-knowledge-task-v1' as const,
  sessionId: 'session:registered', sessionSnapshotHash: digest('snapshot'), captureFactsHash: digest('facts'),
  registeredManifestHash: digest('manifest'), registeredRequestHash: digest(canonicalJson(candidateRequest)),
  taskKind: 'single-line-v1' as const, finalOutputHash: digest('whole-output'), capturedProviderRequestHash: digest('request'),
}
function signedResult(role: string, requestHash: string) {
  const value = { authorityId: `native-test:${role}`, requestHash, result: 'fail', methods: ['integration_test'],
    outcomes: [{ name: 'fixed-task', result: 'fail', evidence: ['negative task retained'] }], issuedAt: '2026-10-13T00:00:00.000Z' }
  return { ...value, proof: sign(null, Buffer.from(canonicalJson(value)), keys[role]!.privateKey).toString('base64') }
}

describe('Native consumers', () => {
  it('accepts signed task failures, binds legacy request hashes and rejects cross-task or forged results', async () => {
    let override: Frame | undefined
    const owner = await ready({ request(request, peer) {
      const payload = request.payload as Frame
      const fixed = payload.operation === 'verify-registered-knowledge-task-v1'
      respond(peer, request, override ?? signedResult(fixed ? 'evaluator' : 'promotion',
        fixed ? fixedRequest.registeredRequestHash : digest(canonicalJson(payload))))
    } })
    const providers = createNativeKnowledgeOwnerProviders(owner.channel)
    const signal = new AbortController().signal
    const result = await providers.authority.verifyCandidate(candidateRequest, signal)
    expect(result.result).toBe('fail')
    expect(providers.authority.validateCandidateResult(candidateRequest, result)).toBe(true)
    expect(providers.authority.validateCandidateResult({ ...candidateRequest, sourceHash: digest('other') }, result)).toBe(false)
    expect((await providers.measuredUseEvaluator.verifyRegisteredFixedTask(fixedRequest, signal)).result).toBe('fail')
    override = signedResult('evaluator', digest('wrong underlying request'))
    await expect(providers.measuredUseEvaluator.verifyRegisteredFixedTask(fixedRequest, signal)).rejects.toThrow(/binding/)
    override = { ...signedResult('promotion', fixedRequest.registeredRequestHash), proof: Buffer.alloc(64).toString('base64') }
    await expect(providers.authority.verifyCandidate(candidateRequest, signal)).rejects.toThrow(/signature/)
    const valid = signedResult('promotion', fixedRequest.registeredRequestHash)
    for (const mutation of [
      { authorityId: 4 }, { requestHash: 4 }, { requestHash: 'bad' }, { result: 'claimed' }, { methods: null }, { methods: [] },
      { methods: ['invented'] }, { outcomes: null }, { outcomes: [] }, { outcomes: [{ name: 3, result: 'pass', evidence: [] }] },
      { outcomes: [{ name: 'test', result: 'claimed', evidence: [] }] }, { outcomes: [{ name: 'test', result: 'pass', evidence: [1] }] },
      { issuedAt: 4 }, { issuedAt: 'unknown' }, { proof: 7 }, { proof: 'invalid' }, { extra: true },
    ]) {
      override = { ...valid, ...mutation }
      await expect(providers.authority.verifyCandidate(candidateRequest, signal)).rejects.toThrow(/malformed/)
    }
  })
  it('decodes canonical evaluator artifacts and rejects malformed owner callback results', async () => {
    let output: unknown = { artifactBase64: Buffer.from('{"schemaVersion":1}').toString('base64') }
    const owner = await ready({ request(request, peer) { respond(peer, request, output) } })
    const providers = createNativeKnowledgeOwnerProviders(owner.channel)
    const signal = new AbortController().signal
    const evaluation = { ...fixedRequest, operation: 'evaluate-captured-knowledge-use-v1' as const,
      journalAttestationHash: digest('journal'), fixedTaskOracleHash: digest('oracle'), costWitnessHash: digest('cost') }
    expect(Buffer.from(await providers.measuredUseEvaluator.evaluateCapturedUse(evaluation, signal)).toString()).toBe('{"schemaVersion":1}')
    for (const malformed of [null, { artifactBase64: 4 }, { artifactBase64: '' }, { artifactBase64: '!bad-base64' }]) {
      output = malformed
      await expect(providers.measuredUseEvaluator.evaluateCapturedUse(evaluation, signal)).rejects.toThrow(/malformed/)
    }
    output = { signature: 'invalid' }
    await expect(providers.journalAuthority.signKnowledgeUseJournal({ schemaVersion: 1, kind: 'knowledge-use-journal-v1',
      useFactsHash: digest('facts'), journalArtifactHash: digest('journal'), journalSignerAuthorityId: 'native-test:journal' }, signal)).rejects.toThrow(/malformed/)
    const observation = { sessionId: 'session', endpoint: 'http://127.0.0.1:8080/chat/completions', provider: 'deepseek-official',
      configuredModel: 'fixture', wireModel: 'fixture', requestBodyHash: digest('body'), maxTokens: null, request: {} }
    output = { status: 'untracked' }
    expect(await providers.adapterClient.observeProviderRequest(observation)).toEqual(output)
    output = { status: 'registered', dispatchId: '/arbitrary/path' }
    await expect(providers.adapterClient.observeProviderRequest(observation)).rejects.toThrow(/malformed/)
    output = { status: 'claimed-complete' }
    await expect(providers.costOwner.resolveUniqueSettledUse({ schemaVersion: 1, operation: 'resolve-settled-use-cost-v1',
      sessionId: 'session', sessionSnapshotHash: digest('snapshot'), capturedRequestHashes: [] }, signal)).rejects.toThrow(/malformed/)
  })
  it('uses one captured receiver and verifies existing journal bytes', async () => {
    const owner = await ready({ request(request, peer) {
      respond(peer, request, { signature: sign(null, Buffer.from(canonicalJson(request.payload)), keys.journal!.privateKey).toString('base64') })
    } })
    const providers = createNativeKnowledgeOwnerProviders(owner.channel)
    owner.channel.call = async () => { throw new Error('mutable replacement must not run') }
    const journal = providers.journalAuthority.signKnowledgeUseJournal
    const request = { schemaVersion: 1 as const, kind: 'knowledge-use-journal-v1' as const, useFactsHash: digest('facts'), journalArtifactHash: digest('journal'), journalSignerAuthorityId: 'native-test:journal' }
    expect(await journal(request, new AbortController().signal)).toHaveLength(64)
    expect(Object.isFrozen(providers.journalAuthority)).toBe(true)
    expect(providers.authority.sourceIdentity()).toEqual(sourceIdentity)
  })
  it('rejects forged journal signatures and noncanonical receipt bytes', async () => {
    const owner = await ready({ request(request, peer) {
      respond(peer, request, request.operation === 'signKnowledgeUseJournal' ? { signature: Buffer.alloc(64).toString('base64') } : { artifactBase64: Buffer.from('{ "ok":true }').toString('base64') })
    } })
    const providers = createNativeKnowledgeOwnerProviders(owner.channel)
    await expect(providers.journalAuthority.signKnowledgeUseJournal({ schemaVersion: 1, kind: 'knowledge-use-journal-v1', useFactsHash: digest('facts'), journalArtifactHash: digest('journal'), journalSignerAuthorityId: 'native-test:journal' }, new AbortController().signal)).rejects.toThrow(/does not match/)
    await expect(providers.measuredUseEvaluator.finalizeMeasuredTrial({ schemaVersion: 1, operation: 'finalize-knowledge-measured-trial-v1', proposalHash: digest('p'), grantHash: digest('g'), preRegistrationHash: digest('r'), measurementDefinitionHash: digest('m'), orderedUseReceiptHashes: [] }, new AbortController().signal)).rejects.toThrow(/canonical/)
  })
  it('preserves the existing promotion signature bytes and rejects a changed payload', async () => {
    let returnedSeal: unknown
    const owner = await ready({ request(request, peer) {
      if (returnedSeal !== undefined) { respond(peer, request, returnedSeal); return }
      const payload = encodeKnowledgeWikiPromotionSealRequest(request.payload as KnowledgeWikiPromotionSealRequest)
      respond(peer, request, { authorityId: 'native-test:promotion', proof: sign(null, Buffer.from(payload), keys.promotion!.privateKey).toString('base64') })
    } })
    const authority = createNativeKnowledgeOwnerProviders(owner.channel).authority
    const request: KnowledgeWikiPromotionSealRequest = { schemaVersion: 1, domain: 'ark.knowledge-wiki', authorityId: authority.authorityId,
      operation: 'seal-knowledge-event', eventType: 'knowledge/promoted', knowledgeId: 'candidate:one',
      payload: { action: 'Promote', lifecycle: 'canonical', candidateHash: digest('candidate'), appliedPath: 'wiki/fixed.md' } }
    const seal = await authority.sealPromotion(request)
    expect(authority.validatePromotion(encodeKnowledgeWikiPromotionSealRequest(request), seal)).toBe(true)
    expect(authority.validatePromotion(encodeKnowledgeWikiPromotionSealRequest({ ...request, knowledgeId: 'candidate:changed' }), seal)).toBe(false)
    await expect(authority.sealPromotion({ ...request, authorityId: 'different' })).rejects.toThrow(/authority does not match/)
    returnedSeal = { authorityId: 'native-test:promotion', proof: Buffer.alloc(64).toString('base64') }
    await expect(authority.sealPromotion(request)).rejects.toThrow(/signature/)
    returnedSeal = { authorityId: 1, proof: 'bad' }
    await expect(authority.sealPromotion(request)).rejects.toThrow(/malformed/)
  })
  it('only sends request hashes and fixed provider metadata, with complete-cost unknown kept explicit', async () => {
    const owner = await ready({ request(request, peer) {
      respond(peer, request, request.operation === 'registerProviderDispatch' ? { status: 'registered', dispatchId: 'dispatch:1' } : { status: 'unknown', reason: 'incomplete-attempt-set' })
    } })
    const providers = createNativeKnowledgeOwnerProviders(owner.channel)
    const request = { messages: [{ content: [{ type: 'text', text: 'private prompt must stay local' }] }], config: { model: 'fixture' } }
    expect(await providers.adapterClient.observeProviderRequest({ sessionId: 'registered-session', endpoint: 'https://api.deepseek.com/chat/completions', provider: 'deepseek-official', configuredModel: 'fixture', wireModel: 'fixture', requestBodyHash: digest('final-http-bytes'), maxTokens: 64, request })).toEqual({ status: 'registered', dispatchId: 'dispatch:1' })
    expect(owner.requests[0]?.payload).toMatchObject({ capturedRequestHash: digest(canonicalJson(request)) })
    expect(JSON.stringify(owner.requests)).not.toContain('private prompt')
    expect(Object.keys(providers.adapterClient)).toEqual(['observeProviderRequest'])
    expect(await providers.costOwner.resolveUniqueSettledUse({ schemaVersion: 1, operation: 'resolve-settled-use-cost-v1', sessionId: 'registered-session', sessionSnapshotHash: digest('whole-snapshot'), capturedRequestHashes: [digest('request1'), digest('request2')] }, new AbortController().signal)).toEqual({ status: 'unknown', reason: 'incomplete-attempt-set' })
    expect(owner.requests[1]?.payload).toMatchObject({ capturedRequestHashes: [digest('request1'), digest('request2')] })
  })
  it('accepts only canonical content-addressed complete-cost artifacts', async () => {
    let mismatched = false
    const artifact = canonicalJson({ schemaVersion: 1, kind: 'settled-use-cost-witness-v1', attempts: [] })
    const owner = await ready({ request(request, peer) { respond(peer, request, { status: 'verified', artifactBytesBase64: Buffer.from(artifact).toString('base64'), artifactHash: digest(mismatched ? 'wrong' : artifact) }) } })
    const cost = createNativeKnowledgeOwnerProviders(owner.channel).costOwner
    const request = { schemaVersion: 1 as const, operation: 'resolve-settled-use-cost-v1' as const, sessionId: 'session', sessionSnapshotHash: digest('snapshot'), capturedRequestHashes: [digest('request')] }
    expect(await cost.resolveUniqueSettledUse(request, new AbortController().signal)).toMatchObject({ status: 'verified', artifactHash: digest(artifact) })
    mismatched = true
    await expect(cost.resolveUniqueSettledUse(request, new AbortController().signal)).rejects.toThrow(/hash does not match/)
  })
  it.each(['disabled', 'invalid'] as const)('startup handles %s owner without publishing authority', async (state) => {
    const owner = await fixture({ hello: () => state === 'disabled'
      ? { version: 1, ok: true, ownerStatus: 'disabled', authorities: [] } : { fake: true } })
    vi.stubEnv('ARK_NATIVE_OWNER_SOCKET_PATH', owner.endpoint.socketPath); vi.stubEnv('ARK_NATIVE_OWNER_LAUNCH_TOKEN', token)
    const context = new Context(); cleanups.push(() => context.fiber.dispose())
    provideCmdline(context, { args: [], exit: () => {} })
    if (state === 'invalid') await expect(Startup.apply(context)).rejects.toThrow(/hello/)
    else { await Startup.apply(context); expect(context.get('nativeApiStartup')).toEqual({}) }
    expect(context.get('knowledgeWikiVerifierAuthority')).toBeUndefined()
  })
  it('aborts and joins an unresponsive hello during startup disposal', async () => {
    const owner = await fixture({ rawHello: Buffer.alloc(0) })
    vi.stubEnv('ARK_NATIVE_OWNER_SOCKET_PATH', owner.endpoint.socketPath); vi.stubEnv('ARK_NATIVE_OWNER_LAUNCH_TOKEN', token)
    const context = new Context(); cleanups.push(() => context.fiber.dispose())
    provideCmdline(context, { args: [], exit: () => {} })
    const startup = context.plugin(Startup)
    await vi.waitFor(() => { expect(owner.peers.size).toBe(1) })
    await startup.dispose()
    await vi.waitFor(() => { expect(owner.peers.size).toBe(0) })
    expect(context.get('knowledgeWikiVerifierAuthority')).toBeUndefined()
    expect(context.get('nativeApiStartup')).toBeUndefined()
  })
  it('provides actual consumers through Loader and removes them after unload', async () => {
    const owner = await fixture()
    vi.stubEnv('ARK_NATIVE_OWNER_SOCKET_PATH', owner.endpoint.socketPath); vi.stubEnv('ARK_NATIVE_OWNER_LAUNCH_TOKEN', token)
    await writeFile(join(owner.root, 'cordis.yml'), '- id: native-startup\n  name: native-startup\n- id: consumer\n  name: consumer\n  inject: [knowledgeWikiVerifierAuthority]\n')
    const context = new Context(); cleanups.push(() => context.fiber.dispose())
    provideCmdline(context, { args: [], exit: (code) => { throw new Error(`Unexpected exit ${code}`) } })
    const seen: unknown[] = []
    const plugins: Record<string, unknown> = { 'native-startup': Startup, consumer: { name: 'consumer', apply(ctx: Context) {
      const authority = ctx.get('knowledgeWikiVerifierAuthority') as KnowledgeWikiVerifierAuthority
      seen.push(authority.sourceIdentity())
    } } }
    context.baseUrl = pathToFileURL(owner.root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    context.loader.internal = { version: 'v2', import: async (name: string) => plugins[name] } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(owner.root, 'cordis.yml')).href } })
    await context.loader.await()
    expect(seen).toEqual([sourceIdentity]); expect(context.get('knowledgeWikiMeasuredTrialReader')).toBeDefined()
    await context.fiber.dispose()
    expect(context.get('knowledgeWikiVerifierAuthority')).toBeUndefined()
    await vi.waitFor(() => { expect(owner.peers.size).toBe(0) })
  })
})


describe('guard-only owner connection', () => {
  const guardHello = { version: 1, ok: true, ownerStatus: 'disabled', authorities: [], peerRole: 'guard', costStatus: 'ready' }
  const admission = { schemaVersion: 1 as const, dispatchId: 'dispatch:1', attemptId: 'attempt:1', sessionIdHash: digest('session'),
    requestBodyHash: digest('request'), maxTokens: 64 }
  const settlement = { ...admission, responseIdHash: digest('response'), responseModel: 'fixture', inputTokens: 3, outputTokens: 5,
    upperBoundMicroCny: 2, finishReason: 'stop', settledAt: '2026-10-13T00:00:00.000Z' }
  it('shares the private channel with only two fixed guard methods and no signing identity', async () => {
    const owner = await fixture({ hello: () => guardHello, request(request, peer) {
      respond(peer, request, request.operation === 'admitProviderRequest' ? { status: 'matched' } : { status: 'recorded', artifactHash: digest('cost') })
    } })
    const result = await connectNativeGuardCostOwner(owner.endpoint)
    if (result.status !== 'ready') throw new Error('Expected guard connection')
    cleanups.push(result.close)
    expect(Object.keys(result)).toEqual(['status', 'close', 'closed', 'client'])
    expect(Object.keys(result.client)).toEqual(['admitProviderRequest', 'recordProviderSettlement'])
    expect(Object.isFrozen(result.client)).toBe(true)
    expect(await result.client.admitProviderRequest(admission)).toEqual({ status: 'matched' })
    expect(await result.client.recordProviderSettlement(settlement)).toEqual({ status: 'recorded', artifactHash: digest('cost') })
    expect(owner.requests.map(request => request.operation)).toEqual(['admitProviderRequest', 'recordProviderSettlement'])
    await result.close()
    await result.closed
    await expect(result.client.admitProviderRequest(admission)).rejects.toThrow(/unavailable/)
  })
  it('observes unexpected guard owner loss after the socket actually closes', async () => {
    const owner = await fixture({ hello: () => guardHello })
    const result = await connectNativeGuardCostOwner(owner.endpoint)
    if (result.status !== 'ready') throw new Error('Expected guard connection')
    cleanups.push(result.close)
    let terminated = false
    void result.closed.then(() => { terminated = true })
    expect(terminated).toBe(false)
    for (const peer of owner.peers) peer.destroy()
    await result.closed
    expect(terminated).toBe(true)
    await expect(result.client.admitProviderRequest(admission)).rejects.toThrow(/unavailable/)
  })
  it('keeps disabled cost ownership unavailable and rejects role confusion in both directions', async () => {
    const disabled = await fixture({ hello: () => ({ ...guardHello, costStatus: 'disabled' }) })
    expect(await connectNativeGuardCostOwner(disabled.endpoint)).toEqual({ status: 'disabled' })
    const guard = await fixture({ hello: () => guardHello })
    await expect(connectNativeKnowledgeOwner(guard.endpoint)).rejects.toThrow(/cannot provide signing/)
    const signing = await fixture()
    await expect(connectNativeGuardCostOwner(signing.endpoint)).rejects.toThrow(/guard peer/)
    const malformed = await fixture({ hello: () => ({ ...guardHello, costStatus: 'claimed' }) })
    await expect(connectNativeGuardCostOwner(malformed.endpoint)).rejects.toThrow(/hello/)
  })
  it('rejects forged guard admission or malformed settlement replies', async () => {
    const owner = await fixture({ hello: () => guardHello, request(request, peer) {
      respond(peer, request, request.operation === 'admitProviderRequest' ? { status: 'claimed' } : { status: 'recorded', artifactHash: 'not-a-digest' })
    } })
    const result = await connectNativeGuardCostOwner(owner.endpoint)
    if (result.status !== 'ready') throw new Error('Expected guard connection')
    cleanups.push(result.close)
    await expect(result.client.admitProviderRequest(admission)).rejects.toThrow(/malformed/)
    await expect(result.client.recordProviderSettlement(settlement)).rejects.toThrow(/malformed/)
  })
})
