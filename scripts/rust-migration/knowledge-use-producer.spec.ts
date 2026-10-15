import { config, scenario } from './knowledge-use-test-fixture.ts'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { createServer, type Socket } from 'node:net'
import { generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto'
import { mkdtemp, readFile, rm, mkdir, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { isolatedChildEnvironment } from './process-isolation.ts'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFailed, vi } from 'vitest'
import { Session, SessionId, SessionStore, KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence, { JsonlSessionPersistence as JsonlBackend } from '@deepseek-ai/dsh-session-persistence-jsonl'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { createWindowsProcessInspector } from '../../packages/subprocess/subprocess-local/src/windows-inspector.ts'
import SandboxLocal from '@deepseek-ai/dsh-sandbox-local'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '../../packages/sandbox/sandbox-policy/src/session-mode.ts'
import { createFileMeasuredTrialArtifactResolver, createKnowledgeWikiMeasuredTrialReader,
  MEASURED_TRIAL_METRICS } from '../../packages/host/knowledge-wiki/src/measured-trial.ts'
import { atomicWriteFile, resolveConfinedPath } from '../../packages/host/knowledge-wiki/src/filesystem.ts'
import { canonicalJson, sha256, encodeKnowledgeWikiPromotionSealRequest, type IndependentVerificationRequest,
  type IndependentVerificationResult } from '../../packages/host/knowledge-wiki/src/verifier.ts'
import { invoiceOracle, singleLineOracle, paginationOracle } from './knowledge-task-oracles.ts'
import { captureKnowledgeUse, capturePersistedKnowledgeUse } from './knowledge-session-use.ts'
import { evaluateKnowledgeUseOperation, describeCapturedKnowledgeCostUse, describeRegisteredKnowledgeTrial,
  type KnowledgeUseEvaluatorConfiguration } from './knowledge-use-evaluator.ts'
import { evaluateObservationOperation, resolveCompletedEvaluation, readObservationSnapshot, assertUnobservedKnowledgeStartPrefix } from './knowledge-observation.ts'
import { parseObservation, type Slot, type CostSlot } from './knowledge-observation-schema.ts'
import { compressZstdFrame } from '../../packages/session/session-persistence-jsonl/src/zstd.ts'
import { produceMeasuredUseV1, FIXED_KNOWLEDGE_MEASUREMENT_DEFINITION_V1, witnessedUseCost, deriveObservedUseCounts,
  type KnowledgeMeasuredUseEvaluator, type RegisteredTaskV1,
  type VerifyRegisteredFixedTaskV1Request } from './knowledge-use-producer.ts'

async function runEvaluatorCli(context: Context, configPath: string, request: unknown, inputBytes = canonicalJson(request),
  diagnostic?: (phase: string, facts?: Readonly<Record<string, unknown>>) => void) {
  const compiledRuntime = process.env['ARK_PRODUCER_COMPILED_RUNTIME_ROOT'] ?? process.env['ARK_OBSERVATION_COMPILED_RUNTIME_ROOT']
  const argv = compiledRuntime === undefined
    ? [process.execPath, '--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href,
      fileURLToPath(new URL('./knowledge-use-evaluator.ts', import.meta.url)), configPath]
    : [process.execPath, join(compiledRuntime, 'protected-helpers/scripts/rust-migration/knowledge-use-evaluator.mjs'), configPath]
  const child = context.subprocess.spawn({
    argv,
    cwd: process.cwd(), env: { ...isolatedChildEnvironment(),
      TSX_TSCONFIG_PATH: fileURLToPath(new URL('../../tsconfig.base.json', import.meta.url)) },
    graceMs: 1_000, signal: AbortSignal.timeout(15_000),
    stdio: { stdin: { data: inputBytes }, stdout: { maxBytes: 4 * 1024 * 1024 }, stderr: { maxBytes: 32 * 1024 } },
  })
  diagnostic?.('spawned', { pid: child.pid })
  try {
    const outcome = await child.done
    diagnostic?.('outcome', { pid: child.pid, exitCode: outcome.exitCode, signal: outcome.signal })
    const exitObserved = await child.waitForExit()
    diagnostic?.('tree-exit-observed', { pid: child.pid, exitObserved })
    expect(exitObserved).toBe(true)
    const stdout = child.collected.stdout?.readFrom(0)
    const stderr = child.collected.stderr?.readFrom(0)
    expect(stdout?.lossy).toBe(false)
    expect(stderr?.lossy).toBe(false)
    return { code: outcome.exitCode, stdout: stdout!.text, stderr: stderr!.text }
  } finally {
    diagnostic?.('cleanup-start', { pid: child.pid })
    child.terminate(); await child.done
    const exitObserved = await child.waitForExit()
    diagnostic?.('cleanup-exit-observed', { pid: child.pid, exitObserved })
    expect(exitObserved).toBe(true)
  }
}

async function cancelledEvaluator(configPath: string, mode: 'signal' | 'parent-exit') {
  if (process.platform === 'win32') return cancelledWindowsEvaluator(configPath, mode)
  const argv = [process.execPath, '--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href,
    fileURLToPath(new URL('./knowledge-use-evaluator.ts', import.meta.url)), configPath]
  const fifoRoot = await mkdtemp(join(tmpdir(), 'ark-evaluator-owner-loss-'))
  const fifo = join(fifoRoot, 'stdin.fifo')
  execFileSync('/usr/bin/mkfifo', [fifo])
  // A read/write FIFO descriptor held by the evaluator cannot turn owner loss into EOF.
  const parentCode = `const {spawn}=require('node:child_process');
    const fs=require('node:fs'); const input=fs.openSync(${JSON.stringify(fifo)},fs.constants.O_RDWR);
    const child=spawn(${JSON.stringify(argv[0])},${JSON.stringify(argv.slice(1))},{stdio:[input,'inherit','inherit']});
    fs.closeSync(input);
    process.stdout.write(String(child.pid)+'\\n');
    setTimeout(()=>{${mode === 'signal' ? "child.kill('SIGTERM')" : 'process.exit(0)'}},3000);
    child.once('exit',()=>process.exit(0));`
  const parent = spawn(process.execPath, ['--eval', parentCode], { cwd: process.cwd(),
    env: { ...isolatedChildEnvironment(), TSX_TSCONFIG_PATH: fileURLToPath(new URL('../../tsconfig.base.json', import.meta.url)) },
    stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = ''; let stderr = ''
  parent.stdout.on('data', (chunk) => { stdout += String(chunk) })
  parent.stderr.on('data', (chunk) => { stderr += String(chunk) })
  const timeout = setTimeout(() => { parent.kill('SIGKILL'); const pid = Number.parseInt(stdout, 10)
    if (Number.isSafeInteger(pid)) { try { process.kill(pid, 'SIGKILL') } catch {} } }, 10_000)
  try {
    await once(parent, 'close')
    expect(stderr).toContain('evaluator process cancelled or owner exited')
    const pid = Number.parseInt(stdout, 10)
    expect(Number.isSafeInteger(pid)).toBe(true)
    // Linux PID 1 may retain an exited orphan as a zombie; a live child still fails.
    await vi.waitFor(async () => {
      try { process.kill(pid, 0) } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
        throw error
      }
      if (process.platform === 'linux') {
        try {
          const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
          const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3)
          if (state === 'Z' || state === 'X') return
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
          throw error
        }
      }
      throw new Error(`evaluator pid ${pid} is still running`)
    }, { timeout: 5_000, interval: 20 })
  } finally {
    clearTimeout(timeout); parent.stdin.destroy(); parent.kill('SIGKILL')
    await rm(fifoRoot, { recursive: true, force: true })
  }
}

async function cancelledWindowsEvaluator(configPath: string, mode: 'signal' | 'parent-exit') {
  const root = await mkdtemp(join(tmpdir(), 'ark-evaluator-owner-loss-'))
  const readyPath = join(root, 'stdin.ready')
  const preloadPath = join(root, 'stdin-ready.mjs')
  const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href
  const inspectorUrl = new URL('../../packages/subprocess/subprocess-local/src/windows-inspector.ts', import.meta.url).href
  // This test-only seam runs when main actually awaits stdin, after installing
  // its cancellation listeners. It leaves the iterator and all input bytes intact.
  await writeFile(preloadPath, `import { writeFileSync, renameSync } from 'node:fs';
    import { createWindowsProcessInspector } from ${JSON.stringify(inspectorUrl)};
    const inspector = createWindowsProcessInspector();
    const iterate = process.stdin[Symbol.asyncIterator];
    process.stdin[Symbol.asyncIterator] = function (...args) {
      const identity = inspector.snapshot().tree(process.pid).find(entry => entry.pid === process.pid);
      if (identity === undefined) throw new Error('evaluator startup identity is unavailable');
      const ready = { ...identity, parentPid: process.ppid,
        readableEnded: this.readableEnded, termListeners: process.listenerCount('SIGTERM') };
      writeFileSync(${JSON.stringify(`${readyPath}.pending`)}, JSON.stringify(ready), { mode: 0o600, flag: 'wx' });
      renameSync(${JSON.stringify(`${readyPath}.pending`)}, ${JSON.stringify(readyPath)});
      return iterate.apply(this, args);
    };`, { mode: 0o600, flag: 'wx' })
  const argv = [process.execPath, '--import', tsx, '--import', pathToFileURL(preloadPath).href,
    fileURLToPath(new URL('./knowledge-use-evaluator.ts', import.meta.url)), configPath]
  const parentCode = `async function main() {
    const { spawn } = require('node:child_process');
    const { createWindowsProcessInspector } = await import(${JSON.stringify(inspectorUrl)});
    const inspector = createWindowsProcessInspector();
    const child = spawn(${JSON.stringify(argv[0])}, ${JSON.stringify(argv.slice(1))}, { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
    child.once('error', error => { process.stderr.write(String(error)); process.exit(1); });
    child.once('exit', (code, signal) => {
      process.send({ kind: 'child-exit', code, signal }, () => process.exit(0));
    });
    const identity = inspector.snapshot().tree(child.pid).find(entry => entry.pid === child.pid);
    process.send({ kind: 'spawned', pid: child.pid, started: identity?.started });
    process.once('message', mode => {
      if (child.stdin.destroyed || child.stdin.writableEnded) throw new Error('evaluator stdin was not held open');
      process.send({ kind: 'action', mode, pid: child.pid }, () => {
        if (mode === 'signal') { if (!child.kill('SIGTERM')) throw new Error('evaluator signal was not sent'); }
        else if (mode === 'parent-exit') process.exit(0);
        else throw new Error('unexpected owner-loss action');
      });
    });
    } main().catch(error => { process.stderr.write(String(error)); process.exit(1); });`
  const inspector = createWindowsProcessInspector()
  const parent = spawn(process.execPath, ['--import', tsx, '--eval', parentCode], { cwd: process.cwd(),
    env: { ...isolatedChildEnvironment(), TSX_TSCONFIG_PATH: fileURLToPath(new URL('../../tsconfig.base.json', import.meta.url)) },
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'] })
  const closed = once(parent, 'close').then(value => ({ value }), (error: unknown) => ({ error }))
  const spawned = once(parent, 'message')
  let stdout = ''; let stderr = ''
  const messages: unknown[] = []
  parent.stdout!.on('data', (chunk) => { stdout += String(chunk) })
  parent.stderr!.on('data', (chunk) => { stderr += String(chunk) })
  let spawnedPid: number | undefined
  let identity: { pid: number; started: string } | undefined
  parent.on('message', (message) => {
    messages.push(message)
    if (typeof message !== 'object' || message === null || !('kind' in message) || message.kind !== 'spawned'
      || !('pid' in message) || typeof message.pid !== 'number' || !Number.isSafeInteger(message.pid) || message.pid <= 0) return
    spawnedPid = message.pid
    if ('started' in message && typeof message.started === 'string' && /^\d+:\d+$/u.test(message.started)) {
      identity = { pid: message.pid, started: message.started }
    }
  })
  let timeout: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => { reject(new Error('evaluator owner-loss fixture exceeded 10000 ms')) }, 10_000)
  })
  let primaryError: unknown
  let primaryFailed = false
  try {
    const [message] = await Promise.race([spawned, deadline]) as [{ kind: string; pid: number; started: string }]
    expect(message.kind).toBe('spawned')
    expect(Number.isSafeInteger(message.pid)).toBe(true)
    expect(message.pid).toBeGreaterThan(0)
    expect(message.started).toMatch(/^\d+:\d+$/u)
    expect(identity).toBeDefined()
    if (identity === undefined) throw new Error('evaluator startup identity is unavailable')
    expect(inspector.snapshot().tree(message.pid).find(entry => entry.pid === message.pid)).toEqual(identity)
    const ready = await vi.waitFor(async () => JSON.parse(await readFile(readyPath, 'utf8')) as {
      pid: number
      started: string
      parentPid: number
      readableEnded: boolean
      termListeners: number
    }, { timeout: 3_000, interval: 20 })
    expect(ready).toMatchObject({ ...identity, parentPid: parent.pid, readableEnded: false })
    expect(ready.termListeners).toBeGreaterThan(0)
    expect(inspector.isAlive(identity)).toBe(true)
    await Promise.race([new Promise<void>((resolve, reject) => {
      parent.send(mode, (error) => { if (error) reject(error); else resolve() })
    }), deadline])
    const outcome = await Promise.race([closed, deadline])
    if ('error' in outcome) throw outcome.error
    expect(outcome.value).toEqual([0, null])
    expect(messages).toContainEqual({ kind: 'action', mode, pid: identity.pid })
    if (mode === 'signal') expect(messages).toContainEqual({ kind: 'child-exit', code: null, signal: 'SIGTERM' })
    // Windows SIGTERM and non-detached parent-job teardown are OS termination.
    // They do not demonstrate the evaluator's POSIX handler or ppid watcher.
    expect(stdout).toBe('')
    expect(stderr).toBe('')
    await vi.waitFor(() => {
      expect(() => process.kill(identity!.pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
    }, { timeout: 5_000, interval: 20 })
    process.stderr.write(`evaluator-owner-loss ${JSON.stringify({ mode, startup: ready, exit: 'esrch-non-running-or-absent' })}\n`)
  } catch (error) {
    primaryFailed = true
    primaryError = error
  } finally {
    clearTimeout(timeout)
    const cleanupErrors: unknown[] = []
    let parentExitProven = false; let childExitProven = false
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined
    const cleanupUntil = Date.now() + 5_000
    const cleanupDeadline = new Promise<never>((_resolve, reject) => {
      cleanupTimer = setTimeout(() => { reject(new Error('evaluator cleanup exceeded the existing 5000 ms observation budget')) }, 5_000)
    })
    try {
      parent.stdin!.destroy(); parent.kill('SIGKILL')
    } catch (error) { cleanupErrors.push(error) }
    try {
      const outcome = await Promise.race([closed, cleanupDeadline])
      if ('error' in outcome) throw outcome.error
      parentExitProven = true
    } catch (error) { cleanupErrors.push(error) }
    try {
      if (spawnedPid === undefined) throw new Error('evaluator child PID was not observed; retain its fixture root')
      if (identity !== undefined && inspector.isAlive(identity)) inspector.signalProcess(identity, 'SIGKILL')
      while (true) {
        try { process.kill(spawnedPid, 0) } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
          childExitProven = true
          break
        }
        if (identity === undefined) throw new Error('evaluator startup identity is unknown while its PID remains active')
        const current = inspector.snapshot().tree(spawnedPid).find(entry => entry.pid === spawnedPid)
        if (current === undefined || current.started !== identity.started) throw new Error('evaluator process identity is unreadable or changed')
        if (Date.now() >= cleanupUntil) throw new Error(`evaluator pid ${spawnedPid} is still running at the cleanup deadline`)
        await new Promise(resolve => setTimeout(resolve, Math.min(20, cleanupUntil - Date.now())))
      }
    } catch (error) { cleanupErrors.push(error) }
    finally { clearTimeout(cleanupTimer) }
    if (parentExitProven && childExitProven) {
      try { await rm(root, { recursive: true, force: true }) }
      catch (error) { cleanupErrors.push(error) }
    } else {
      cleanupErrors.push(new Error(`evaluator exit is unproved; retained fixture root ${root}`))
    }
    const errors = primaryFailed ? [primaryError, ...cleanupErrors] : cleanupErrors
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, 'evaluator body and/or cleanup failed')
  }
}


const rejectedReviewBinding = { reviewHash: sha256('review'), semanticReceiptHash: sha256('semantic'),
  candidatePath: '_candidates/x.md', candidateHash: sha256('candidate'), action: 'Promote' as const, targetPath: 'x.md',
  targetBeforeHashOrVerifiedAbsence: 'verified-absence' as const }

const invoiceSource = 'invoice_id,status,currency,amount\ni1,approved,USD,1.00'
const rateSource = 'currency,minor_units,usd_numerator,usd_denominator\nUSD,2,1,1'
const invoiceOutput = invoiceOracle(invoiceSource, rateSource, '').expected
const taskDefs = [
  { taskKind: 'invoice-v1' as const, output: invoiceOutput, source: { invoices: invoiceSource, rates: rateSource } },
  { taskKind: 'single-line-v1' as const, output: 'SUM=23', source: { terms: 'row_id,quantity,unit_value\nr1,1,23' } },
  { taskKind: 'pagination-v1' as const, output: 'pagination task executed', source: { paginate: (items: readonly object[],
    page: unknown, pageSize: unknown) => {
    if (typeof page !== 'number' || typeof pageSize !== 'number' || !Number.isSafeInteger(page) || !Number.isSafeInteger(pageSize)
      || page < 1 || pageSize < 1) throw new RangeError()
    const totalItems = items.length
    const totalPages = Math.ceil(totalItems / pageSize)
    return { items: items.filter((_, index) => index >= (page - 1) * pageSize && index < page * pageSize), page, pageSize,
      totalItems, totalPages }
  } } },
]

async function persistFixture(context: Context, _root: string, options: { candidate: boolean
  sessionId: string
  output: string
  projectRoot?: string }) {
  const f = scenario({ candidate: options.candidate, sessionId: options.sessionId, output: options.output,
    ...(options.projectRoot === undefined ? {} : { projectRoot: options.projectRoot }) })
  Object.assign(f.binding, { useId: `use:${options.sessionId}` })
  await context.sessionPersistence.create(f.metadata)
  await context.sessionPersistence.append(f.metadata.id, f.events)
  const location = context.sessionPersistence.locate(f.metadata)
  if (location?.kind !== 'jsonl') throw new Error('expected the ordinary JSONL test snapshot')
  const bytes = await readFile(location.path)
  return { f, snapshotPath: location.path, expectedSnapshotHash: sha256(bytes), beforeBytes: bytes }
}

function readArtifact(root: string, hash: string): Record<string, unknown> {
  const bytes = createFileMeasuredTrialArtifactResolver(root).resolveArtifact(hash)
  if (bytes === undefined) throw new Error('fixture artifact missing')
  return JSON.parse(Buffer.from(bytes).toString('utf8')) as Record<string, unknown>
}

function signOracle(authorityId: string, requestHash: string, result: 'pass' | 'fail', key: KeyObject): IndependentVerificationResult {
  const unsigned: Omit<IndependentVerificationResult, 'proof'> = {
    authorityId, requestHash, result, methods: ['unit_test'],
    outcomes: [{ name: 'fixed-task-oracle', result, evidence: [sha256(`oracle:${requestHash}:${result}`)] }],
    issuedAt: new Date().toISOString(),
  }
  return { ...unsigned, proof: sign(null, Buffer.from(canonicalJson(unsigned)), key).toString('base64') }
}

function fixtureCostWitness(request: {
  readonly sessionId: string
  readonly sessionSnapshotHash: string
  readonly capturedRequestHashes: readonly string[]
}, options: { omitRequestIndex?: number; nativePricing?: { responseModel: string; maxTokens: number } } = {}) {
  const attempts = request.capturedRequestHashes.flatMap((requestHash, requestIndex) => requestIndex === options.omitRequestIndex ? [] : [{
    capturedRequestHash: requestHash, dispatchId: `dispatch:${requestIndex}`, attemptId: `attempt:${requestIndex}`,
    requestBodyHash: sha256(`body ${requestIndex}`), responseIdHash: sha256(`response ${requestIndex}`), responseModel: options.nativePricing?.responseModel ?? config.model,
    maxTokens: options.nativePricing?.maxTokens ?? 100, inputTokens: 10, outputTokens: 3, upperBoundMicroCny: options.nativePricing === undefined ? 0 : 10 * 2 + 3 * 8, finishReason: 'stop', settledAt: new Date().toISOString(),
    registrationArtifactHash: sha256(`registered:${requestIndex}`), settlementArtifactHash: sha256(`settled:${requestIndex}`),
    retryOfDispatchId: null, retryAttributionArtifactHash: null,
  }])
  const artifactBytes = Buffer.from(canonicalJson({ schemaVersion: 1, kind: 'settled-use-cost-witness-v1',
    sessionIdHash: sha256(`ark-cost-session-v1\0${request.sessionId}`), sessionSnapshotHash: request.sessionSnapshotHash,
    capturedRequestHashes: [...request.capturedRequestHashes], attempts,
    totalUpperBoundMicrounits: attempts.reduce((total, attempt) => total + attempt.upperBoundMicroCny, 0) }))
  return { status: 'verified' as const, artifactBytesBase64: artifactBytes.toString('base64'), artifactHash: sha256(artifactBytes) }
}

describe('persisted actual-use producer', () => {
  it('sums every dispatch and retry while rejecting incomplete, duplicate and ambiguous cost evidence', () => {
    const f = scenario({ candidate: true })
    const captured = captureKnowledgeUse(f.metadata, f.events, f.snapshot, { ...f.binding, cost: null })
    const resolution = fixtureCostWitness({ sessionId: f.binding.sessionId, sessionSnapshotHash: sha256(f.snapshot),
      capturedRequestHashes: captured.requests.map(request => sha256(canonicalJson(request))) })
    const witness = JSON.parse(Buffer.from(resolution.artifactBytesBase64, 'base64').toString('utf8')) as {
      attempts: Array<Record<string, unknown>>
      totalUpperBoundMicrounits: number
    }
    for (const [index, attempt] of witness.attempts.entries()) attempt['upperBoundMicroCny'] = index + 2
    witness.totalUpperBoundMicrounits = 5
    const measure = (value: unknown) => witnessedUseCost(value, 'fixture-only-cost-owner', f.binding, captured, sha256(f.snapshot))
    expect(measure(witness)).toBe(5)
    const first = witness.attempts[0]
    if (first === undefined) throw new Error('fixture requires requests')
    const retry = { ...first, dispatchId: 'retry-dispatch', attemptId: 'retry-attempt', upperBoundMicroCny: 7,
      retryOfDispatchId: first['dispatchId'], retryAttributionArtifactHash: sha256('fixture-only-authenticated-retry') }
    expect(measure({ ...witness, attempts: [...witness.attempts, retry], totalUpperBoundMicrounits: 12 })).toBe(12)
    for (const invalid of [
      { ...witness, attempts: witness.attempts.slice(1) },
      { ...witness, attempts: [first, first] },
      { ...witness, totalUpperBoundMicrounits: 4 },
      { ...witness, attempts: [...witness.attempts, { ...retry, retryAttributionArtifactHash: null }] },
      { ...witness, attempts: [...witness.attempts, { ...retry, retryOfDispatchId: 'missing' }] },
      { ...witness, rawSessionId: f.binding.sessionId },
    ]) expect(measure(invalid)).toBeUndefined()
    const counts = deriveObservedUseCounts(captured, 'fail')
    expect(counts.verifiedTaskSuccess).toEqual({ numerator: 0, denominator: 1 })
    expect(counts.knowledgeUtility).toEqual({ numerator: 0, denominator: 0 })
    expect(counts.memoryPoisoning).toEqual({ numerator: 0, denominator: 0 })
  })

  it('derives repeated errors only from complete matching explicit-error observations', () => {
    const f = scenario({ errorsAndRepeat: true, explicitErrors: true })
    const captured = captureKnowledgeUse(f.metadata, f.events, f.snapshot, { ...f.binding, cost: null })
    expect(deriveObservedUseCounts(captured, 'fail')).toMatchObject({
      repeatedErrorRate: { numerator: 1, denominator: 2 }, repeatedToolCallRate: { numerator: 1, denominator: 2 },
      verifiedTaskSuccess: { numerator: 0, denominator: 1 },
    })
    const shell = scenario({ errorsAndRepeat: true, shellError: true })
    const shellCapture = captureKnowledgeUse(shell.metadata, shell.events, shell.snapshot, { ...shell.binding, cost: null })
    expect(deriveObservedUseCounts(shellCapture, 'fail').repeatedErrorRate).toEqual({ numerator: 0, denominator: 0 })
    const missing = { ...captured, artifacts: new Map(captured.artifacts) }
    missing.artifacts.delete(captured.journalArtifactHash)
    expect(() => deriveObservedUseCounts(missing, 'fail')).toThrow('journal is absent')
  })

  it('captures real persisted sessions, runs all three fixed oracle families, and reaches the real reader without claiming eligibility', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ark-use-producer-preview-'))
    const dataRoot = join(root, 'sessions')
    const artifactRoot = join(root, 'artifacts')
    await mkdir(dataRoot)
    await mkdir(artifactRoot)
    const context = new Context()
    const journalKeys = generateKeyPairSync('ed25519')
    const evaluatorKeys = generateKeyPairSync('ed25519')
    const journalAuthorityId = 'journal-preview-test'
    const evaluatorAuthorityId = 'evaluator-preview-test'
    const preregistrationHashes = [sha256('proposal'), sha256('grant'), sha256('prereg'), sha256('measurement')]
    const prepared: { pairId: string
      baseline: Awaited<ReturnType<typeof persistFixture>>
      candidate: Awaited<ReturnType<typeof persistFixture>>
      task: typeof taskDefs[number]
      registered: RegisteredTaskV1 }[] = []
    const requestByHash = new Map<string, { task: typeof taskDefs[number]; expectedOutputBytes: Buffer }>()
    const manifestByHash = new Map<string, { requestHash: string; task: typeof taskDefs[number] }>()
    const sessionTask = new Map<string, { pairId: string; task: typeof taskDefs[number]; role: 'baseline' | 'candidate' }>()
    try {
      await context.plugin(SessionStore)
      await context.plugin(JsonlSessionPersistence, { root: dataRoot, compression: 'none' })
      for (const [index, task] of taskDefs.entries()) {
        const pairId = `pair-${task.taskKind}`
        const baseline = await persistFixture(context, dataRoot, { candidate: false, sessionId: `base-${index}`, output: task.output })
        const candidate = await persistFixture(context, dataRoot, { candidate: true, sessionId: `cand-${index}`, output: task.output })
        for (const [role, fixture] of [['baseline', baseline], ['candidate', candidate]] as const) Object.assign(fixture.f.binding, {
          pairId, role, proposalHash: preregistrationHashes[0], measurementDefinitionHash: preregistrationHashes[3],
          useId: `${role}-${task.taskKind}`, grantId: role === 'candidate' ? preregistrationHashes[1] : null,
        })
        const manifestHash = sha256(`manifest:${task.taskKind}`)
        const requestHash = sha256(`request:${task.taskKind}`)
        const registered: RegisteredTaskV1 = { manifestHash, requestHash, taskKind: task.taskKind }
        requestByHash.set(requestHash, { task, expectedOutputBytes: Buffer.from(task.output) })
        manifestByHash.set(manifestHash, { requestHash, task })
        sessionTask.set(baseline.f.binding.sessionId, { pairId, task, role: 'baseline' })
        sessionTask.set(candidate.f.binding.sessionId, { pairId, task, role: 'candidate' })
        prepared.push({ pairId, baseline, candidate, task, registered })
      }
      const oracleFamilies = new Set<string>()
      let evaluateCalls = 0
      let finalizeCalls = 0
      const costOwner = {
        authorityId: 'fixture-only-cost-owner',
        async resolveUniqueSettledUse(request: Parameters<typeof fixtureCostWitness>[0]) { return fixtureCostWitness(request) },
      }
      const evaluator: KnowledgeMeasuredUseEvaluator = {
        authorityId: evaluatorAuthorityId,
        async verifyRegisteredFixedTask(request: VerifyRegisteredFixedTaskV1Request) {
          const registered = requestByHash.get(request.registeredRequestHash)
          const manifest = manifestByHash.get(request.registeredManifestHash)
          const session = sessionTask.get(request.sessionId)
          if (registered === undefined || manifest === undefined || session === undefined
            || manifest.requestHash !== request.registeredRequestHash
            || request.taskKind !== registered.task.taskKind || request.taskKind !== manifest.task.taskKind
            || request.taskKind !== session.task.taskKind) throw new Error('fixture task/request/session registration mismatch')
          const actualBytes = Buffer.from(
            createFileMeasuredTrialArtifactResolver(artifactRoot).resolveArtifact(request.finalOutputHash) ?? Buffer.alloc(0),
          )
          expect(actualBytes.equals(registered.expectedOutputBytes)).toBe(true)
          const output = actualBytes.toString('utf8')
          const task = registered.task
          const result = task.taskKind === 'invoice-v1'
            ? invoiceOracle(task.source.invoices, task.source.rates, output)
            : task.taskKind === 'single-line-v1'
              ? singleLineOracle(task.source.terms, output)
              : paginationOracle(task.source.paginate)
          oracleFamilies.add(task.taskKind)
          return signOracle(evaluatorAuthorityId, request.registeredRequestHash, result.result, evaluatorKeys.privateKey)
        },
        async evaluateCapturedUse(request) {
          evaluateCalls += 1
          expect(readArtifact(artifactRoot, request.fixedTaskOracleHash)['result']).toBe('pass')
          expect(request.fixedTaskOracleHash).toMatch(/^[a-f0-9]{64}$/u)
          expect('counts' in request).toBe(false)
          const bytes = Buffer.from(canonicalJson({ fixtureOnly: true, useFactsHash: sha256(canonicalJson(readArtifact(artifactRoot,
            request.captureFactsHash))), journalAttestationHash: request.journalAttestationHash }))
          return bytes
        },
        async finalizeMeasuredTrial(request) {
          finalizeCalls += 1
          expect(request.orderedUseReceiptHashes).toHaveLength(2)
          expect('counts' in request).toBe(false)
          const bytes = Buffer.from(canonicalJson({ fixtureOnly: true, orderedUseReceiptHashes: request.orderedUseReceiptHashes }))
          return bytes
        },
      }
      const reader = createKnowledgeWikiMeasuredTrialReader({
        authorityId: evaluatorAuthorityId, publicKey: evaluatorKeys.publicKey,
        journalSignerAuthorityId: journalAuthorityId, journalSignerPublicKey: journalKeys.publicKey,
        artifacts: createFileMeasuredTrialArtifactResolver(artifactRoot),
      })
      const pairs = prepared.map(pair => ({
        pairId: pair.pairId,
        baseline: { snapshotPath: pair.baseline.snapshotPath, expectedSnapshotHash: pair.baseline.expectedSnapshotHash,
          binding: pair.baseline.f.binding, registeredTask: pair.registered },
        candidate: { snapshotPath: pair.candidate.snapshotPath, expectedSnapshotHash: pair.candidate.expectedSnapshotHash,
          binding: pair.candidate.f.binding, registeredTask: pair.registered },
      }))
      const results: Awaited<ReturnType<typeof produceMeasuredUseV1>>[] = []
      for (const pair of pairs) {
        results.push(await produceMeasuredUseV1({
          pairs: [pair], proposalHash: preregistrationHashes[0]!, grantHash: preregistrationHashes[1]!,
          preRegistrationHash: preregistrationHashes[2]!, measurementDefinitionHash: preregistrationHashes[3]!,
          journalAuthority: {
            authorityId: journalAuthorityId, publicKey: journalKeys.publicKey,
            async signKnowledgeUseJournal(request, signal) {
              signal.throwIfAborted()
              return sign(null, Buffer.from(canonicalJson(request)), journalKeys.privateKey)
            },
          },
          costOwner, evaluator, reader,
          reviewBinding: rejectedReviewBinding,
          artifactRoot, signal: new AbortController().signal,
        }))
      }
      expect(results).toHaveLength(3)
      expect(results.every(result => result.status === 'rejected')).toBe(true)
      expect(oracleFamilies).toEqual(new Set(['invoice-v1', 'single-line-v1', 'pagination-v1']))
      expect(evaluateCalls).toBe(6)
      expect(finalizeCalls).toBe(3)
      expect(results.flatMap(result => result.orderedUseReceiptHashes)).toHaveLength(6)
      for (const pair of prepared) {
        expect(await readFile(pair.baseline.snapshotPath)).toEqual(pair.baseline.beforeBytes)
        expect(await readFile(pair.candidate.snapshotPath)).toEqual(pair.candidate.beforeBytes)
      }
    } finally {
      await context.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)

  it('retains a registered failing fixed-task result as a signed negative observation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ark-use-producer-negative-'))
    const dataRoot = join(root, 'sessions')
    const artifactRoot = join(root, 'artifacts')
    await mkdir(dataRoot); await mkdir(artifactRoot)
    const context = new Context()
    const fixture = generateKeyPairSync('ed25519')
    let signerCalls = 0
    let evaluateCalls = 0
    let finalizeCalls = 0
    try {
      await context.plugin(SessionStore)
      await context.plugin(JsonlSessionPersistence, { root: dataRoot, compression: 'none' })
      const candidate = await persistFixture(context, dataRoot, { candidate: true, sessionId: 'negative-candidate', output: 'SUM=22' })
      const baseline = await persistFixture(context, dataRoot, { candidate: false, sessionId: 'negative-baseline', output: 'SUM=22' })
      const proposalHash = sha256('negative-proposal')
      const measurementDefinitionHash = sha256('negative-measurement')
      for (const [role, row] of [['baseline', baseline], ['candidate', candidate]] as const) Object.assign(row.f.binding, {
        role, pairId: 'negative-pair', proposalHash, measurementDefinitionHash,
      })
      const task = { taskKind: 'single-line-v1' as const, output: 'SUM=23', source: { terms: 'row_id,quantity,unit_value\nr1,1,23' } }
      const registered = { manifestHash: sha256('manifest:negative'), requestHash: sha256('request:negative'), taskKind: task.taskKind }
      const evaluator: KnowledgeMeasuredUseEvaluator = {
        authorityId: 'negative-evaluator',
        async verifyRegisteredFixedTask(request) {
          const actualOutputBytes = Buffer.from(
            createFileMeasuredTrialArtifactResolver(artifactRoot).resolveArtifact(request.finalOutputHash) ?? Buffer.alloc(0),
          )
          expect(actualOutputBytes.toString('utf8')).toBe('SUM=22')
          const verdict = singleLineOracle(task.source.terms, actualOutputBytes.toString('utf8'))
          return signOracle('negative-evaluator', request.registeredRequestHash, verdict.result, fixture.privateKey)
        },
        async evaluateCapturedUse(request) { evaluateCalls++; expect((readArtifact(artifactRoot,
          request.fixedTaskOracleHash) as unknown as IndependentVerificationResult).result).toBe('fail'); return Buffer.from('{}') },
        async finalizeMeasuredTrial() { finalizeCalls++; return Buffer.from('{}') },
      }
      const keys = generateKeyPairSync('ed25519')
      const costOwner = { authorityId: 'fixture-only-cost-owner',
        async resolveUniqueSettledUse(request: Parameters<typeof fixtureCostWitness>[0]) { return fixtureCostWitness(request) } }
      const reader = { authorityId: evaluator.authorityId, read: () => undefined }
      const result = await produceMeasuredUseV1({
        pairs: [{ pairId: 'negative-pair', baseline: { snapshotPath: baseline.snapshotPath,
          expectedSnapshotHash: baseline.expectedSnapshotHash, binding: baseline.f.binding, registeredTask: registered },
        candidate: { snapshotPath: candidate.snapshotPath, expectedSnapshotHash: candidate.expectedSnapshotHash,
          binding: candidate.f.binding, registeredTask: registered } }],
        proposalHash, grantHash: sha256('grant'), preRegistrationHash: sha256('prereg'), measurementDefinitionHash,
        journalAuthority: { authorityId: 'negative-journal', publicKey: keys.publicKey,
          async signKnowledgeUseJournal(request) { signerCalls++; return sign(null, Buffer.from(canonicalJson(request)),
            keys.privateKey) } },
        costOwner, evaluator, reader, reviewBinding: rejectedReviewBinding,
        artifactRoot, signal: new AbortController().signal,
      })
      expect(result.status).toBe('rejected')
      expect(signerCalls).toBe(2)
      expect(evaluateCalls).toBe(2)
      expect(finalizeCalls).toBe(1)
    } finally {
      await context.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)


  it.each(taskDefs.flatMap(task => [{ task, productionDerivation: false }, { task,
    productionDerivation: true }]))('runs $task.taskKind through fixed owner=$productionDerivation and the actual v1 reader',
    async ({ task, productionDerivation }) => {
      const startedAt = performance.now()
      const phases: Array<{ phase: string; elapsedMs: number; facts?: Readonly<Record<string, unknown>> }> = []
      let droppedPhases = 0
      const recordPhase = (phase: string, facts?: Readonly<Record<string, unknown>>) => {
        if (!productionDerivation || task.taskKind !== 'single-line-v1') return
        if (phases.length === 64) { phases.shift(); droppedPhases++ }
        phases.push({ phase, elapsedMs: Math.round(performance.now() - startedAt), ...facts === undefined ? {} : { facts } })
      }
      const cliDiagnostic = (label: string) => (phase: string, facts?: Readonly<Record<string, unknown>>) => {
        recordPhase(`cli:${label}:${phase}`, facts)
      }
      // A Vitest timeout can settle the case before its async body reaches catch/finally.
      // Use the runner's failure hook; observe existing waits without querying or extending them.
      onTestFailed(() => {
        if (phases.length > 0) process.stderr.write(`knowledge-use-producer-phases ${JSON.stringify({
          taskKind: task.taskKind, productionDerivation, platform: process.platform,
          elapsedMs: Math.round(performance.now() - startedAt), droppedPhases, phases,
        })}\n`)
      })
      recordPhase('setup-start')
      // Opt-in artifact-plane smoke requires a completed, attested runtime pack. Source tests keep source owners.
      const compiledRuntime = productionDerivation ? process.env['ARK_PRODUCER_COMPILED_RUNTIME_ROOT'] : undefined
      const receiptBytes = compiledRuntime === undefined ? undefined
        : await readFile(join(compiledRuntime, '.ark-provenance/pack-receipt.json'))
      const packReceipt = receiptBytes === undefined ? undefined : JSON.parse(receiptBytes.toString('utf8')) as {
        sourceDigest: string
        sourceIdentity: { commit: string; dirty: boolean; dirtyDiffSha256: string }
        installedRuntimeManifestSha256: string
      }
      if (packReceipt !== undefined) {
        expect(packReceipt.installedRuntimeManifestSha256).toBe(sha256(await readFile(join(compiledRuntime!,
          '.ark-provenance/installed-runtime-manifest.json'))))
      }
      const compiledOwner = compiledRuntime === undefined ? undefined : await import(/* @vite-ignore */ pathToFileURL(
        join(compiledRuntime, 'protected-helpers/scripts/rust-migration/knowledge-use-evaluator.mjs')).href) as
        typeof import('./knowledge-use-evaluator.ts')
      const evaluate = compiledRuntime === undefined ? evaluateKnowledgeUseOperation : compiledOwner!.evaluateKnowledgeUseOperation
      const fixtureDestination = process.env['ARK_PRODUCER_FIXTURE_ROOT']
      const retainFixture = productionDerivation && task.taskKind === 'single-line-v1' && fixtureDestination !== undefined
      const root = await mkdtemp(join(retainFixture ? fixtureDestination : tmpdir(), 'ark-use-producer-v1-reader-'))
      const dataRoot = join(root, 'sessions')
      const artifactRoot = join(root, 'artifacts')
      await mkdir(dataRoot); await mkdir(artifactRoot)
      const context = new Context()
      const journalKeys = generateKeyPairSync('ed25519')
      const evaluatorKeys = generateKeyPairSync('ed25519')
      const authorityId = 'pilot-test:independent-evaluator'
      const journalAuthorityId = 'fixture-test-journal-owner'
      const projectRoot = join(root, 'project')
      await mkdir(join(projectRoot, '.llm-wiki/_candidates/ingest/concepts'), { recursive: true })
      const measurementDefinitionHash = sha256(canonicalJson(FIXED_KNOWLEDGE_MEASUREMENT_DEFINITION_V1))
      const targetBytes = Buffer.from('Frozen rule; not a prior answer.')
      const modelIdentity = { model: config.model, modelConfigHash: sha256(canonicalJson(config)),
        taskHash: sha256('registered task'), goalHash: sha256('goal'), policyHash: sha256('policy') }
      const files = new Map<string, Buffer>()
      const flushArtifacts = () => {
        const artifacts = createFileMeasuredTrialArtifactResolver(artifactRoot)
        for (const [hash, bytes] of files) {
          const prior = artifacts.resolveArtifact(hash)
          if (prior === undefined) atomicWriteFile(resolveConfinedPath(artifactRoot, hash, true), bytes)
          else expect(Buffer.from(prior)).toEqual(bytes)
        }
      }
      const putRaw = (bytes: Buffer): string => { const hash = sha256(bytes); files.set(hash, bytes); return hash }
      const putCanonical = (value: Record<string, unknown>): string => putRaw(Buffer.from(canonicalJson(value), 'utf8'))
      const signRecord = (record: Record<string, unknown>): Record<string, unknown> => {
        const unsigned = { ...record, evaluatorAuthorityId: authorityId }
        return { ...unsigned, evaluatorSignature: sign(null, Buffer.from(canonicalJson(unsigned)),
          evaluatorKeys.privateKey).toString('base64') }
      }
      putCanonical(FIXED_KNOWLEDGE_MEASUREMENT_DEFINITION_V1)
      const targetAfterHash = putRaw(targetBytes)
      const candidateHash = putRaw(Buffer.from('fixture candidate document bytes'))
      const semanticReceiptHash = putCanonical({ schemaVersion: 1, receiptId: 'fixture-semantic-receipt' })
      const sourceArtifactManifestHash = putCanonical({ schemaVersion: 1, sourceArtifacts: [] })
      const governedRecordHash = putCanonical({ schemaVersion: 1, knowledgeId: 'wiki:concepts/fixed-rule.md' })
      const scopeAclExpiryHash = putCanonical({ schemaVersion: 1, scope: 'project', acl: null, expiresAt: '1970-01-02T00:00:00.000Z' })
      const proposal = {
        schemaVersion: 1, reviewHash: sha256('fixture-review'), semanticReceiptHash,
        candidatePath: '_candidates/ingest/concepts/fixed-rule.md', candidateHash,
        sourceArtifactManifestHash, governedRecordHash, scopeAclExpiryHash, action: 'Promote',
        targetPath: 'concepts/fixed-rule.md', targetBeforeHashOrVerifiedAbsence: 'verified-absence', targetAfterHash,
        frozenApprovalActor: 'reviewer-fixture', frozenApprovalTime: new Date(Date.now() - 120_000).toISOString(),
        transformVersion: 'knowledge-promotion-v1',
        sourceIdentity: packReceipt === undefined
          ? { commit: 'a'.repeat(40), sourceDigest: sha256('source'), dirty: true, dirtyDigest: sha256('dirty'), buildDigest:
            sha256('build') }
          : { commit: packReceipt.sourceIdentity.commit, sourceDigest: packReceipt.sourceDigest, dirty: packReceipt.sourceIdentity.dirty,
            dirtyDigest: packReceipt.sourceIdentity.dirtyDiffSha256, buildDigest: packReceipt.installedRuntimeManifestSha256 },
        buildIdentity: { build: compiledRuntime === undefined ? 'fixture-build' : 'attested-compiled-fixture-stage',
          digest: packReceipt?.installedRuntimeManifestSha256 ?? sha256('build') },
        profileIdentity: { profile: 'isolated-test-profile', digest: sha256('profile') },
        modelPolicyIdentity: { model: config.model, policyHash: modelIdentity.policyHash },
        immutableMissionIdentity: { goalHash: modelIdentity.goalHash, acceptanceHash: sha256('acceptance') },
      }
      const proposalHash = putCanonical(proposal)
      const now = Date.now()
      const time = (offset: number) => new Date(now + offset).toISOString()
      const pairIds = ['pair-baseline-fails', 'pair-candidate-fails'] as const
      const preRegistration = signRecord({ schemaVersion: 1, preRegistrationId: 'fixture-prereg-1', proposalHash, measurementDefinitionHash,
        modelConfigTaskGoalPolicyIdentity: modelIdentity, orderedPairIds: [...pairIds], issuedAt: time(-60_000) })
      const preRegistrationHash = putCanonical(preRegistration)
      const grantId = 'fixture-grant-1'
      const candidateSessionIds = ['candidate-baseline-fails', 'candidate-candidate-fails'] as const
      const grant = signRecord({ schemaVersion: 1, grantId, proposalHash, reviewedDecisionHash: proposalHash, preRegistrationHash,
        measurementDefinitionHash, allowedSessionIds: [...candidateSessionIds], modelConfigTaskGoalPolicyIdentity: modelIdentity,
        maxObservations: 2, maxTurns: 2, deadline: time(retainFixture ? 86_400_000 : 180_000), issuedAt: time(-30_000),
        expiresAt: time(retainFixture ? 604_800_000 : 240_000) })
      const grantHash = putCanonical(grant)
      const taskSource = 'row_id,quantity,unit_value\nr1,1,23'
      const registered = { manifestHash: sha256('registered-manifest'), requestHash: sha256('registered-request'), taskKind: task.taskKind }
      const cases = [
        { pairId: pairIds[0], baselineSessionId: 'baseline-fails', candidateSessionId: candidateSessionIds[0],
          baselineOutput: 'incorrect output', candidateOutput: task.output },
        { pairId: pairIds[1], baselineSessionId: 'baseline-passes', candidateSessionId: candidateSessionIds[1],
          baselineOutput: task.output, candidateOutput: 'incorrect output' },
      ]
      const pairs: Array<{ pairId: string
        baseline: Awaited<ReturnType<typeof persistFixture>>
        candidate: Awaited<ReturnType<typeof persistFixture>> }> = []
      let journalSeal = async (request: unknown, _signal: AbortSignal) =>
        sign(null, Buffer.from(canonicalJson(request)), journalKeys.privateKey)
      let producerReceiptCount = 0
      const oracleOutcomes = new Map<string, 'pass' | 'fail'>()
      let evaluator: KnowledgeMeasuredUseEvaluator = {
        authorityId,
        async verifyRegisteredFixedTask(request) {
          const outputBytes = Buffer.from(
            createFileMeasuredTrialArtifactResolver(artifactRoot).resolveArtifact(request.finalOutputHash) ?? Buffer.alloc(0),
          )
          const oracleResult = task.taskKind === 'invoice-v1' ? invoiceOracle(invoiceSource, rateSource,
            outputBytes.toString('utf8')).result
            : task.taskKind === 'single-line-v1' ? singleLineOracle(taskSource, outputBytes.toString('utf8')).result
              : paginationOracle(outputBytes.toString('utf8') === task.output ? task.source.paginate : () =>
              { throw new Error('fixture negative pagination source') }).result
          expect(request.registeredRequestHash).toBe(registered.requestHash)
          oracleOutcomes.set(request.sessionId, oracleResult)
          return signOracle(authorityId, request.registeredRequestHash, oracleResult, evaluatorKeys.privateKey)
        },
        async evaluateCapturedUse(request) {
          const { proof, ...unsignedOracle } = readArtifact(artifactRoot,
            request.fixedTaskOracleHash) as unknown as IndependentVerificationResult
          expect(verify(null, Buffer.from(canonicalJson(unsignedOracle)), evaluatorKeys.publicKey, Buffer.from(proof, 'base64'))).toBe(true)
          expect((readArtifact(artifactRoot,
            request.captureFactsHash)['errorsRetriesToolCallsAndCost'] as { costMicrounits: number }).costMicrounits).toBe(0)
          const refs = [request.journalAttestationHash, request.fixedTaskOracleHash, request.costWitnessHash]
          // These fixture-only opportunity rows exercise the existing v1 reader schema. They are not
          // product measurements and do not fill missing production opportunities or cost provenance.
          const fixtureCounts = Object.fromEntries(MEASURED_TRIAL_METRICS.map((metric) => {
            if (metric === 'verifiedTaskSuccess') return [metric, { numerator: (readArtifact(artifactRoot,
              request.fixedTaskOracleHash) as unknown as IndependentVerificationResult).result === 'pass' ? 1 : 0, denominator: 1 }]
            if (['staleRecallRate','crossSessionLeakage','falseCompletionRate','memoryPrivilegeEscalation','memoryPoisoning'].includes(metric)) return [metric, { numerator: 0, denominator: 1 }]
            return [metric, { numerator: 0, denominator: 0 }]
          }))
          const receiptUnsigned = {
            ...readArtifact(artifactRoot, request.captureFactsHash),
            oracleIdentityAndResults: { producerId: 'fixture-producer', evaluatorId: authorityId, verificationStatus: 'verified',
              counts: fixtureCounts, evidenceRefs: refs },
            evidenceArtifactReferences: refs,
            evaluatorAuthorityId: authorityId,
          }
          producerReceiptCount += 1
          return Buffer.from(canonicalJson({ ...receiptUnsigned, evaluatorSignature: sign(null,
            Buffer.from(canonicalJson(receiptUnsigned)), evaluatorKeys.privateKey).toString('base64') }))
        },
        async finalizeMeasuredTrial(request) {
          const useHashes = request.orderedUseReceiptHashes
          expect(useHashes).toHaveLength(4)
          const useRecords = useHashes.map(hash =>
            JSON.parse(Buffer.from(createFileMeasuredTrialArtifactResolver(artifactRoot).resolveArtifact(hash) ??
              Buffer.alloc(0)).toString('utf8')) as { role: string
              oracleIdentityAndResults: { counts: Record<string, { numerator: number; denominator: number }> } })
          const roleCounts = (role: 'baseline' | 'candidate') => Object.fromEntries(MEASURED_TRIAL_METRICS.map((metric) => {
            const selected = useRecords.filter(item => item.role === role).map(item => item.oracleIdentityAndResults.counts[metric]!)
            return [metric, selected.reduce<{ numerator: number; denominator: number }>((sum, value) =>
              ({ numerator: sum.numerator + value.numerator, denominator: sum.denominator + value.denominator }), { numerator: 0,
              denominator: 0 })]
          }))
          const baselineCounts = roleCounts('baseline')
          const candidateCounts = roleCounts('candidate')
          const trial = signRecord({ schemaVersion: 1, trialId: 'fixture-trial-v1', proposalHash, grantHash, grantId,
            measurementDefinitionHash, orderedUseReceiptHashes: useHashes,
            baselineOpportunityNumeratorsAndDenominators: baselineCounts,
            candidateOpportunityNumeratorsAndDenominators: candidateCounts,
            safetyObservations:
              Object.fromEntries(['staleRecallRate','crossSessionLeakage','falseCompletionRate','memoryPrivilegeEscalation','memoryPoisoning'].map(metric => [metric, candidateCounts[metric as keyof typeof candidateCounts]])),
            issuedAt: time(150_000) })
          return Buffer.from(canonicalJson(trial))
        },
      }
      try {
        recordPhase('session-plugins-start')
        await context.plugin(SessionStore)
        await context.plugin(JsonlSessionPersistence, { root: dataRoot, compression: 'none' })
        recordPhase('session-plugins-done')
        recordPhase('persist-fixtures-start')
        for (const item of cases) {
          const baseline = await persistFixture(context, dataRoot, { candidate: false, sessionId: item.baselineSessionId,
            output: item.baselineOutput, projectRoot })
          const candidate = await persistFixture(context, dataRoot, { candidate: true, sessionId: item.candidateSessionId,
            output: item.candidateOutput, projectRoot })
          for (const [role, row] of [['baseline', baseline], ['candidate', candidate]] as const) Object.assign(row.f.binding, {
            role, pairId: item.pairId, proposalHash, measurementDefinitionHash, useId: `${role}-${item.pairId}`,
            grantId: role === 'candidate' ? grantId : null, sourceIdentity: proposal.sourceIdentity, buildIdentity:
              proposal.buildIdentity.digest,
          })
          pairs.push({ pairId: item.pairId, baseline, candidate })
        }
        recordPhase('persist-fixtures-done')
        let producerPairs = pairs.map(pair => ({ pairId: pair.pairId,
          baseline: { snapshotPath: pair.baseline.snapshotPath, expectedSnapshotHash: pair.baseline.expectedSnapshotHash,
            binding: pair.baseline.f.binding, registeredTask: registered },
          candidate: { snapshotPath: pair.candidate.snapshotPath, expectedSnapshotHash: pair.candidate.expectedSnapshotHash,
            binding: pair.candidate.f.binding, registeredTask: registered } }))
        const costRows = new Map<string, ReturnType<typeof fixtureCostWitness>>()
        for (const pair of producerPairs) for (const entry of [pair.baseline, pair.candidate]) {
          const captured = await capturePersistedKnowledgeUse(entry.snapshotPath, entry.expectedSnapshotHash, { ...entry.binding,
            cost: null })
          const cost = fixtureCostWitness({ sessionId: entry.binding.sessionId, sessionSnapshotHash: entry.expectedSnapshotHash,
            capturedRequestHashes: captured.requests.map(request => sha256(canonicalJson(request))) })
          costRows.set(entry.binding.sessionId, cost)
          putRaw(Buffer.from(cost.artifactBytesBase64, 'base64'))
        }
        if (productionDerivation) {
          recordPhase('production-owner-start')
          await context.plugin(LocalSubprocessRuntime)
          await context.plugin(SandboxLocal)
          await writeFile(join(projectRoot, '.llm-wiki', proposal.candidatePath), Buffer.from('fixture candidate document bytes'))
          await writeFile(join(projectRoot, 'terms.csv'), taskSource)
          await writeFile(join(projectRoot, 'invoices.csv'), invoiceSource)
          await writeFile(join(projectRoot, 'rates.csv'), rateSource)
          await writeFile(join(projectRoot, 'protected.txt'), 'frozen')
          const verificationRequest: IndependentVerificationRequest = { schemaVersion: 2, candidatePath: proposal.candidatePath,
            candidateHash, review: { id: 'fixture-review', confidence: 0.00001 }, reviewHash: proposal.reviewHash, sourceHash:
              sha256('registered source'),
            targetPath: proposal.targetPath, governanceAction: 'Promote',
            governanceDecision: { action: 'Promote', targetPath: proposal.targetPath, policyVersion: 'fixture-policy' },
            sourceIdentity: producerPairs[0]!.baseline.binding.sourceIdentity,
            environment: { nodeVersion: process.versions.node, platform: process.platform, arch: process.arch, policyVersion:
              'fixture-policy' } }
          const verificationRequestHash = putCanonical({ ...verificationRequest })
          const adapt = async (entry: typeof producerPairs[number]['baseline']) => {
            const codePath = `${entry.binding.sessionId}.ts`
            const expectedPass = ['baseline-passes', 'candidate-baseline-fails'].includes(entry.binding.sessionId)
            const code = expectedPass
              ? 'export function paginate(items,page,pageSize) { if(!Number.isSafeInteger(page)||!Number.isSafeInteger(pageSize)||page<1||pageSize<1) throw new RangeError(); return {items:items.slice((page-1)*pageSize,page*pageSize),page,pageSize,totalItems:items.length,totalPages:Math.ceil(items.length/pageSize)} }'
              : 'export function paginate() { throw new Error("registered negative source") }'
            await writeFile(join(projectRoot, codePath), code)
            const captured = await capturePersistedKnowledgeUse(entry.snapshotPath, entry.expectedSnapshotHash, { ...entry.binding,
              cost: null })
            putRaw(Buffer.from(captured.wholeOutput))
            const manifest = { schemaVersion: 1, mode: 'ephemeral-test-only', authorityId, projectRoot, artifactRoot,
              expectedRequestHash: verificationRequestHash, acceptedRuleHash: candidateHash,
              task: task.taskKind === 'invoice-v1' ? { kind: task.taskKind, invoices: { path: 'invoices.csv', hash: sha256(invoiceSource) },
                rates: { path: 'rates.csv', hash: sha256(rateSource) }, outputHash: sha256(captured.wholeOutput) }
                : task.taskKind === 'single-line-v1' ? { kind: task.taskKind, terms: { path: 'terms.csv', hash: sha256(taskSource) },
                  outputHash: sha256(captured.wholeOutput) }
                  : { kind: task.taskKind, code: { path: codePath, hash: sha256(code) }, protectedFiles: [{ path: 'protected.txt',
                    hash: sha256('frozen') }], timeoutMs: 10_000 } }
            return { ...entry, registeredTask: { taskKind: task.taskKind, requestHash: verificationRequestHash,
              manifestHash: putCanonical(manifest) } }
          }
          producerPairs = await Promise.all(producerPairs.map(async pair => ({ pairId: pair.pairId,
            baseline: await adapt(pair.baseline), candidate: await adapt(pair.candidate) })))
          const ownerConfig: KnowledgeUseEvaluatorConfiguration = { schemaVersion: 1, authorityId, producerId: 'fixture-owner-producer',
            promotionAuthorityId: 'pilot-test:promotion-owner', promotionVerificationManifestHashes: [putCanonical({
              ...JSON.parse(files.get(producerPairs[0]!.candidate.registeredTask.manifestHash)!.toString('utf8')) as Record<string,
                unknown>,
              authorityId: 'pilot-test:promotion-owner' })],
            sourceBindingHash: receiptBytes === undefined ? sha256('fixture-only-source-binding') : sha256(receiptBytes), artifactRoot,
            costAuthorityId: 'fixture-only-cost-owner',
            evaluatorPublicKeySpki: evaluatorKeys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
            journalAuthorityId, journalPublicKeySpki: journalKeys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
            registrations: producerPairs.flatMap(pair => [pair.baseline, pair.candidate]).map(entry => ({ ...entry,
              binding: { ...entry.binding, knowledge: entry.binding.knowledge === null ? null : {
                id: entry.binding.knowledge.id, sourceContentHash: entry.binding.knowledge.sourceContentHash,
                renderedArtifactHash: putRaw(Buffer.from(JSON.stringify(entry.binding.knowledge.rendered))) } },
              costWitnessHash: costRows.get(entry.binding.sessionId)!.artifactHash })),
            trial: { trialId: 'fixed-owner-trial', proposalHash, grantHash, preRegistrationHash, measurementDefinitionHash,
              orderedSessionIds: producerPairs.flatMap(pair => [pair.baseline.binding.sessionId, pair.candidate.binding.sessionId]) },
            promotionRequestHashes: [] }
          const sealed = async (request: unknown, signal: AbortSignal) => {
            const recipe = await evaluate(ownerConfig, request, context.subprocess, context.sandbox, signal)
            const bytes = Buffer.from(recipe.canonicalBytes, 'base64')
            return Buffer.from(canonicalJson({ ...JSON.parse(bytes.toString('utf8')) as Record<string, unknown>,
              [recipe.signatureField]: sign(null, bytes, evaluatorKeys.privateKey).toString('base64') }))
          }
          journalSeal = async (request, signal) => {
            const recipe = await evaluate(ownerConfig, request, context.subprocess, context.sandbox, signal)
            expect(recipe.role).toBe('journal')
            expect(recipe.signatureField).toBe('journalSignerSignature')
            return sign(null, Buffer.from(recipe.canonicalBytes, 'base64'), journalKeys.privateKey)
          }
          evaluator = { authorityId,
            async verifyRegisteredFixedTask(request, signal) {
              const result = JSON.parse((await sealed(request, signal)).toString('utf8')) as IndependentVerificationResult
              oracleOutcomes.set(request.sessionId, result.result)
              return result
            },
            async evaluateCapturedUse(request, signal) { producerReceiptCount++; return sealed(request, signal) },
            async finalizeMeasuredTrial(request, signal) { return sealed(request, signal) },
          }
          flushArtifacts()
          if (task.taskKind === 'pagination-v1' && process.platform !== 'darwin') {
            const first = producerPairs[0]!.baseline
            const registered = ownerConfig.registrations[0]!
            const witnessBytes = files.get(registered.costWitnessHash)!
            const captured = await capturePersistedKnowledgeUse(first.snapshotPath, first.expectedSnapshotHash, {
              ...first.binding, cost: { microunits: 0, artifactBytes: witnessBytes },
            })
            const captureFactsHash = putCanonical(captured.facts)
            const finalOutputHash = putRaw(Buffer.from(captured.wholeOutput))
            flushArtifacts()
            const immutablePaths = [first.snapshotPath, join(projectRoot, `${first.binding.sessionId}.ts`),
              join(projectRoot, 'protected.txt'), join(projectRoot, '.llm-wiki', proposal.candidatePath)]
            const originals = await Promise.all(immutablePaths.map(path => readFile(path)))
            const finalize = vi.spyOn(evaluator, 'finalizeMeasuredTrial')
            await expect(evaluator.verifyRegisteredFixedTask({ schemaVersion: 1,
              operation: 'verify-registered-knowledge-task-v1', sessionId: first.binding.sessionId,
              sessionSnapshotHash: first.expectedSnapshotHash, captureFactsHash,
              registeredManifestHash: first.registeredTask.manifestHash,
              registeredRequestHash: first.registeredTask.requestHash, taskKind: 'pagination-v1', finalOutputHash,
              capturedProviderRequestHash: String(captured.facts['providerRequestHash']),
            }, new AbortController().signal)).rejects.toThrow(process.platform === 'win32'
              ? 'pagination pilot requires full file-effect confinement'
              : 'pagination pilot network confinement is only implemented on macOS')
            expect(producerReceiptCount).toBe(0)
            expect(oracleOutcomes.size).toBe(0)
            expect(finalize).not.toHaveBeenCalled()
            expect(await Promise.all(immutablePaths.map(path => readFile(path)))).toEqual(originals)
            return
          }
          const candidateRecipe = await evaluate(ownerConfig, verificationRequest,
            context.subprocess, context.sandbox, new AbortController().signal)
          expect(candidateRecipe).toMatchObject({ role: 'promotion', signatureField: 'proof',
            sealBinding: { operation: 'verifyCandidate', requestHash: verificationRequestHash } })
          expect(JSON.parse(Buffer.from(candidateRecipe.canonicalBytes, 'base64').toString('utf8'))).toMatchObject({
            authorityId: ownerConfig.promotionAuthorityId, requestHash: verificationRequestHash, result: 'pass' })
          for (const changed of [
            { ...verificationRequest, review: { id: 'unregistered review' } },
            { ...verificationRequest, environment: { ...verificationRequest.environment, arch: 'changed' } },
          ]) await expect(evaluate(ownerConfig, changed, context.subprocess, context.sandbox,
            new AbortController().signal)).rejects.toThrow('not uniquely registered')
          await expect(evaluate({ ...ownerConfig,
            promotionVerificationManifestHashes: [...ownerConfig.promotionVerificationManifestHashes,
              ...ownerConfig.promotionVerificationManifestHashes] }, verificationRequest,
          context.subprocess, context.sandbox, new AbortController().signal)).rejects.toThrow('not uniquely registered')
          const promotion = { schemaVersion: 1 as const, domain: 'ark.knowledge-wiki' as const,
            authorityId: ownerConfig.promotionAuthorityId, operation: 'seal-knowledge-event' as const,
            eventType: 'knowledge/promoted' as const, knowledgeId: 'candidate:fixture', payload: { action: 'Promote',
              lifecycle: 'canonical', candidateHash, appliedPath: proposal.targetPath } }
          const promotionBytes = encodeKnowledgeWikiPromotionSealRequest(promotion)
          const promotionOwner = { ...ownerConfig, promotionRequestHashes: [sha256(promotionBytes)] }
          const promotionRecipe = await evaluate(promotionOwner,
            { operation: 'sealPromotion', request: promotion }, context.subprocess, context.sandbox, new AbortController().signal)
          expect(promotionRecipe).toMatchObject({ role: 'promotion', signatureField: 'proof' })
          expect(Buffer.from(promotionRecipe.canonicalBytes, 'base64').toString('utf8')).toBe(promotionBytes)
          await expect(evaluate(ownerConfig, { operation: 'sealPromotion', request: promotion },
            context.subprocess, context.sandbox, new AbortController().signal)).rejects.toThrow('not registered')
          await expect(evaluate(ownerConfig, { schemaVersion: 1, kind: 'knowledge-use-journal-v1',
            journalSignerAuthorityId: 'wrong-owner', useFactsHash: sha256('facts'), journalArtifactHash: sha256('journal') },
          context.subprocess, context.sandbox, new AbortController().signal)).rejects.toThrow('journal authority differs')
          expect(describeRegisteredKnowledgeTrial(ownerConfig).operationLimits.registerProviderDispatch).toBe(0)
          const ledgerBytes = Buffer.from(canonicalJson({ schema: 2, budgetMicroCny: 5_000_000, maxRequests: 32,
            requestCount: 3, settledUpperBoundMicroCny: 100, pending: [] }))
          const admission = { schemaVersion: 1, kind: 'knowledge-live-cost-admission-v1', proposalHash, grantHash,
            preRegistrationHash, sourceBindingHash: ownerConfig.sourceBindingHash, sessionIDs: ownerConfig.trial.orderedSessionIds,
            ledgerArtifactHash: putRaw(ledgerBytes), maximumNewDispatches: 8, maximumNewSettlements: 8 }
          const liveOwnerConfig = { ...ownerConfig, liveCostAdmissionHash: putCanonical(signRecord(admission)) }
          flushArtifacts()
          const liveDescriptor = describeRegisteredKnowledgeTrial(liveOwnerConfig)
          expect(liveDescriptor).toMatchObject({ liveCostAdmission: { admissionHash: liveOwnerConfig.liveCostAdmissionHash,
            ledgerArtifactHash: admission.ledgerArtifactHash, maximumNewDispatches: 8, maximumNewSettlements: 8 },
          operationLimits: { registerProviderDispatch: 8, recordProviderSettlement: 8 } })
          for (const mutation of [{ maximumNewDispatches: 30 }, { maximumNewSettlements: 9 },
            { sessionIDs: ['unregistered-session'] }, { sourceBindingHash: sha256('different source') },
            { grantHash: sha256('different grant') },
            { ledgerArtifactHash: putRaw(Buffer.from(canonicalJson({ schema: 2, budgetMicroCny: 5_000_000, maxRequests: 32,
              requestCount: 3, settledUpperBoundMicroCny: 3_000_000, pending: [] }))) },
          ]) {
            const hash = putCanonical(signRecord({ ...admission, ...mutation })); flushArtifacts()
            expect(() => describeRegisteredKnowledgeTrial({ ...ownerConfig, liveCostAdmissionHash: hash })).toThrow()
          }
          if (task.taskKind === 'single-line-v1') {
            await writeFile(join(root, 'live-owner-config.json'), canonicalJson(liveOwnerConfig), { mode: 0o600 })
            await writeFile(join(root, 'fixture-live-ledger.json'), ledgerBytes, { mode: 0o600 })
            const liveDescribe = await runEvaluatorCli(context, join(root, 'live-owner-config.json'),
              { schemaVersion: 1, operation: 'describeRegisteredTrial' }, undefined, cliDiagnostic('live-description'))
            expect(liveDescribe.code, liveDescribe.stderr).toBe(0)
            expect(JSON.parse(liveDescribe.stdout)).toEqual(liveDescriptor)
          }

          const firstRegistered = ownerConfig.registrations[0]!
          const independentCost = await describeCapturedKnowledgeCostUse(ownerConfig, { schemaVersion: 1,
            operation: 'describeCapturedCostUse', sessionId: firstRegistered.binding.sessionId,
            sessionSnapshotHash: firstRegistered.expectedSnapshotHash }, new AbortController().signal)
          const firstWitness = readArtifact(artifactRoot, firstRegistered.costWitnessHash)
          expect(independentCost).toEqual({ sessionIdHash: firstWitness['sessionIdHash'],
            sessionSnapshotHash: firstWitness['sessionSnapshotHash'], capturedRequestHashes: firstWitness['capturedRequestHashes'] })
          await expect(describeCapturedKnowledgeCostUse(ownerConfig, { schemaVersion: 1, operation: 'describeCapturedCostUse',
            sessionId: firstRegistered.binding.sessionId, sessionSnapshotHash: sha256('wrong snapshot') },
          new AbortController().signal)).rejects.toThrow()

          for (const field of ['profileIdentity', 'buildIdentity', 'projectRoot'] as const) {
            const changed = structuredClone(ownerConfig)
            Object.assign(changed.registrations[0]!.binding, { [field]: 'wrong-registration' })
            expect(() => describeRegisteredKnowledgeTrial(changed)).toThrow()
          }
          if (task.taskKind === 'single-line-v1') {
            const ownerConfigPath = join(root, 'owner-config.json')
            await writeFile(ownerConfigPath, canonicalJson(ownerConfig), { mode: 0o600 })
            const describe = await runEvaluatorCli(context, ownerConfigPath, { schemaVersion: 1, operation: 'describeRegisteredTrial' },
              undefined, cliDiagnostic('owner-description'))
            expect(describe.code, describe.stderr).toBe(0)
            expect(JSON.parse(describe.stdout)).toEqual(describeRegisteredKnowledgeTrial(ownerConfig))
            const candidateCheck = await runEvaluatorCli(context, ownerConfigPath, verificationRequest, undefined,
              cliDiagnostic('candidate-check'))
            expect(candidateCheck.code, candidateCheck.stderr).toBe(0)
            expect(JSON.parse(candidateCheck.stdout)).toMatchObject({ role: 'promotion', signatureField: 'proof' })
            const swiftBytes = canonicalJson(verificationRequest).replace('"confidence":0.00001', '"confidence":1e-05')
            expect(swiftBytes).not.toBe(canonicalJson(verificationRequest))
            const swiftNumbers = await runEvaluatorCli(context, ownerConfigPath, verificationRequest, swiftBytes,
              cliDiagnostic('swift-numbers'))
            expect(swiftNumbers.code, swiftNumbers.stderr).toBe(0)
            const swiftRecipe = JSON.parse(swiftNumbers.stdout) as { canonicalBytes: string; sealBinding: { requestHash: string } }
            expect(swiftRecipe.sealBinding.requestHash).toBe(sha256(swiftBytes))
            expect(swiftRecipe.sealBinding.requestHash).not.toBe(verificationRequestHash)
            expect(JSON.parse(Buffer.from(swiftRecipe.canonicalBytes, 'base64').toString('utf8'))).toMatchObject({
              requestHash: verificationRequestHash, result: 'pass' })


            const candidate = ownerConfig.registrations[1]!
            const costRequest = { schemaVersion: 1, operation: 'describeCapturedCostUse', sessionId: candidate.binding.sessionId,
              sessionSnapshotHash: candidate.expectedSnapshotHash }
            const cost = await runEvaluatorCli(context, ownerConfigPath, costRequest, undefined, cliDiagnostic('captured-cost'))
            expect(cost.code, cost.stderr).toBe(0)
            expect(JSON.parse(cost.stdout)).toEqual(await describeCapturedKnowledgeCostUse(ownerConfig, costRequest,
              new AbortController().signal))
            const reordered = structuredClone(ownerConfig)
            const knowledge = reordered.registrations[1]!.binding.knowledge!
            const original = JSON.parse(files.get(knowledge.renderedArtifactHash)!.toString('utf8')) as unknown
            // Identical fields with sorted keys must still fail the existing rendered-byte invariant.
            Object.assign(knowledge, { renderedArtifactHash: putRaw(Buffer.from(canonicalJson(original))) })
            const wrongPath = join(root, 'reordered-config.json')
            flushArtifacts()
            await writeFile(wrongPath, canonicalJson(reordered), { mode: 0o600 })
            const refused = await runEvaluatorCli(context, wrongPath, costRequest, undefined, cliDiagnostic('reordered-refusal'))
            expect(refused.code).not.toBe(0)
            expect(refused.stdout).toBe('')
            expect(refused.stderr).toContain('knowledge identity, scope, source, or rendered bytes differ')
            recordPhase('owner-loss:signal:start')
            await cancelledEvaluator(ownerConfigPath, 'signal')
            recordPhase('owner-loss:signal:done')
            recordPhase('owner-loss:parent-exit:start')
            await cancelledEvaluator(ownerConfigPath, 'parent-exit')
            recordPhase('owner-loss:parent-exit:done')

          }
          await expect(evaluate(ownerConfig, { schemaVersion: 1, operation: 'evaluate-captured-knowledge-use-v1',
            counts: {} },
          context.subprocess, context.sandbox, new AbortController().signal)).rejects.toThrow()
          recordPhase('production-owner-done')
        }
        flushArtifacts()
        const reader = createKnowledgeWikiMeasuredTrialReader({ authorityId, publicKey: evaluatorKeys.publicKey,
          journalSignerAuthorityId: journalAuthorityId,
          journalSignerPublicKey: journalKeys.publicKey, artifacts: createFileMeasuredTrialArtifactResolver(artifactRoot) })
        recordPhase('produce-measured-use-start')
        const result = await produceMeasuredUseV1({
          pairs: producerPairs,
          proposalHash, grantHash, preRegistrationHash, measurementDefinitionHash,
          journalAuthority: { authorityId: journalAuthorityId, publicKey: journalKeys.publicKey,
            async signKnowledgeUseJournal(request, signal) { return journalSeal(request, signal) } },
          costOwner: { authorityId: 'fixture-only-cost-owner', async resolveUniqueSettledUse(request) {
            const result = costRows.get(request.sessionId)
            if (result === undefined) throw new Error('fixture cost missing')
            return result
          } }, evaluator, reader,
          reviewBinding: { reviewHash: proposal.reviewHash, semanticReceiptHash, candidatePath: proposal.candidatePath, candidateHash,
            action: 'Promote',
            targetPath: proposal.targetPath, targetBeforeHashOrVerifiedAbsence: 'verified-absence' },
          artifactRoot, signal: new AbortController().signal,
        })
        recordPhase('produce-measured-use-done')
        expect(result.status).toBe(productionDerivation ? 'rejected' : 'ineligible')
        expect(producerReceiptCount).toBe(4)
        expect(oracleOutcomes).toEqual(new Map([
          ['baseline-fails', 'fail'], ['candidate-baseline-fails', 'pass'],
          ['baseline-passes', 'pass'], ['candidate-candidate-fails', 'fail'],
        ]))
        if (result.status === 'unknown') throw new Error('fixture costs must exist')
        const verified = reader.read(result.trialHash, { reviewHash: proposal.reviewHash, semanticReceiptHash,
          candidatePath: proposal.candidatePath,
          candidateHash, action: 'Promote', targetPath: proposal.targetPath, targetBeforeHashOrVerifiedAbsence: 'verified-absence' })
        if (productionDerivation) {
          expect(verified).toBeUndefined()
          const trial = readArtifact(artifactRoot, result.trialHash)
          expect(trial['candidateOpportunityNumeratorsAndDenominators']).toMatchObject({ verifiedTaskSuccess: { numerator: 1,
            denominator: 2 },
          knowledgeUtility: { numerator: 0, denominator: 0 }, memoryPoisoning: { numerator: 0, denominator: 0 },
          replayExplainability: { numerator: 2, denominator: 2 } })
        } else {
          expect(verified).toMatchObject({ eligibleForReview: false, proposalHash, grantId, successfulUses: 0, retrievalHits: 0 })
          expect(verified).toBeDefined()
        }
        if (productionDerivation && task.taskKind === 'single-line-v1') {
          const receiptHash = result.orderedUseReceiptHashes[1]!
          const receipt = readArtifact(artifactRoot, receiptHash)
          const selected = producerPairs[0]!.candidate
          const refs = receipt['evidenceArtifactReferences'] as string[]
          if (compiledRuntime !== undefined) {
            const fixedOracle = readArtifact(artifactRoot, refs[1]!)
            const outcome = (fixedOracle['outcomes'] as { name: string; evidence: string[] }[])
              .find(value => value.name === 'independent-task-oracle')!
            const report = readArtifact(artifactRoot, outcome.evidence[0]!)
            expect((report['facts'] as { executor: unknown }).executor).toMatchObject({
              verifierSourceHash: sha256(await readFile(join(compiledRuntime,
                'protected-helpers/scripts/rust-migration/knowledge-pilot-verifier.mjs'))),
              oracleSourceHash: sha256(await readFile(join(compiledRuntime,
                'protected-helpers/scripts/rust-migration/knowledge-task-oracles.mjs'))),
            })
          }
          const facts = Object.fromEntries(Object.entries(receipt).filter(([key]) => ![
            'oracleIdentityAndResults', 'evidenceArtifactReferences', 'evaluatorAuthorityId', 'evaluatorSignature',
          ].includes(key)))
          const refsRequest = { schemaVersion: 1, operation: 'evaluate-captured-knowledge-use-v1',
            sessionId: selected.binding.sessionId, sessionSnapshotHash: selected.expectedSnapshotHash,
            captureFactsHash: sha256(canonicalJson(facts)), registeredManifestHash: selected.registeredTask.manifestHash,
            registeredRequestHash: selected.registeredTask.requestHash, taskKind: selected.registeredTask.taskKind,
            finalOutputHash: (facts['finalOutputArtifactManifest'] as string[])[0], capturedProviderRequestHash:
              facts['providerRequestHash'],
            journalAttestationHash: refs[0], fixedTaskOracleHash: refs[1], costWitnessHash: refs[2] }
          const evaluation = await runEvaluatorCli(context, join(root, 'owner-config.json'), refsRequest, undefined,
            cliDiagnostic('captured-use-evaluation'))
          expect(evaluation.code, evaluation.stderr).toBe(0)
          const recipe = JSON.parse(evaluation.stdout) as { canonicalBytes: string; signatureField: string }
          expect(recipe.signatureField).toBe('evaluatorSignature')
          const unsigned = { ...receipt }; delete unsigned['evaluatorSignature']
          expect(Buffer.from(recipe.canonicalBytes, 'base64').toString('utf8')).toBe(canonicalJson(unsigned))
          const wrongFacts = await runEvaluatorCli(context, join(root, 'owner-config.json'), { ...refsRequest,
            captureFactsHash: sha256('changed facts') }, undefined, cliDiagnostic('wrong-facts-refusal'))
          expect(wrongFacts.code).not.toBe(0)
          expect(wrongFacts.stdout).toBe('')
          expect(wrongFacts.stderr).toContain('captured facts or complete output differs')
          const selectedCapture = await capturePersistedKnowledgeUse(selected.snapshotPath, selected.expectedSnapshotHash,
            { ...selected.binding, cost: null })
          const liveCost = { fixtureOnly: true, config: join(root, 'live-owner-config.json'),
            ledgerPath: join(root, 'fixture-live-ledger.json'), endpoint: 'http://127.0.0.1:1',
            provider: config.provider, configuredModel: config.model, wireModel: 'deepseek-flash',
            maximumNewDispatches: 8, maximumNewSettlements: 8,
            requests: selectedCapture.requests.map((request, index) => {
              const capturedRequestHash = sha256(canonicalJson(request))
              const fixtureWireBody = JSON.stringify({ model: 'deepseek-flash', messages: [{ role: 'user',
                content: `fixture-only captured request ${capturedRequestHash}` }], stream: true, stream_options: { include_usage: true },
              max_tokens: 8192, dsh_plugin_packages: { version: 1, packages: [] } })
              const requestBodyHash = sha256(fixtureWireBody)
              const common = { schemaVersion: 1, sessionIdHash: sha256(`ark-cost-session-v1\0${selected.binding.sessionId}`),
                requestBodyHash, maxTokens: 8192 }
              return { fixtureWireBody, registerProviderDispatch: { schemaVersion: 1, kind: 'adapter',
                sessionId: selected.binding.sessionId, endpoint: 'http://127.0.0.1:1', provider: config.provider,
                configuredModel: config.model, wireModel: 'deepseek-flash', requestBodyHash, maxTokens: 8192, capturedRequestHash },
              admitProviderRequest: common, recordProviderSettlement: { ...common, inputTokens: 10, outputTokens: 3,
                upperBoundMicroCny: 44, responseIdHash: sha256(`fixture-response-${index}`), responseModel: 'deepseek-flash',
                finishReason: index === selectedCapture.requests.length - 1 ? 'stop' : 'tool_calls', settledAt: new Date().toISOString() } }
            }) }
          await writeFile(join(root, 'probe-requests.json'), canonicalJson({ evaluateCapturedUse: refsRequest, liveCost,
            verifyCandidate: readArtifact(artifactRoot, selected.registeredTask.requestHash),

            describeCapturedCostUse: { schemaVersion: 1, operation: 'describeCapturedCostUse', sessionId: selected.binding.sessionId,
              sessionSnapshotHash: selected.expectedSnapshotHash } }), { mode: 0o600 })
          if (retainFixture) await writeFile('/tmp/ark-producer-retained-fixture.json', canonicalJson({ root, config: join(root,
            'owner-config.json'),
          requests: join(root, 'probe-requests.json'), fixtureOnly: true, privateKeysExported: false }))
        }
        recordPhase('snapshot-invariance-start')
        expect(await readFile(pairs[0]!.baseline.snapshotPath)).toEqual(pairs[0]!.baseline.beforeBytes)
        expect(await readFile(pairs[1]!.candidate.snapshotPath)).toEqual(pairs[1]!.candidate.beforeBytes)
        recordPhase('snapshot-invariance-done')
      } finally {
        recordPhase('context-dispose-start')
        await context.fiber.dispose()
        recordPhase('context-dispose-done')
        if (!retainFixture) {
          recordPhase('fixture-remove-start')
          await rm(root, { recursive: true, force: true })
          recordPhase('fixture-remove-done')
        }
      }
    }, 30_000)

  it('returns UNKNOWN when no independently settled per-use cost can be joined', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ark-use-producer-unknown-cost-'))
    const dataRoot = join(root, 'sessions')
    const artifactRoot = join(root, 'artifacts')
    await mkdir(dataRoot); await mkdir(artifactRoot)
    const context = new Context()
    const keys = generateKeyPairSync('ed25519')
    let verificationCalls = 0
    let signingCalls = 0
    const task = { taskKind: 'single-line-v1' as const, output: 'SUM=23', source: { terms: 'row_id,quantity,unit_value\\nr1,1,23' } }
    const registered = { manifestHash: sha256('unknown-manifest'), requestHash: sha256('unknown-request'), taskKind: task.taskKind }
    try {
      await context.plugin(SessionStore)
      await context.plugin(JsonlSessionPersistence, { root: dataRoot, compression: 'none' })
      const pairs = [] as Array<{ pairId: string
        baseline: Awaited<ReturnType<typeof persistFixture>>
        candidate: Awaited<ReturnType<typeof persistFixture>> }>
      for (const pairId of ['unknown-pair-a', 'unknown-pair-b']) {
        const suffix = pairId.endsWith('-a') ? 'a' : 'b'
        const baseline = await persistFixture(context, dataRoot, { candidate: false, sessionId: `unknown-base-${suffix}`,
          output: 'SUM=23' })
        const candidate = await persistFixture(context, dataRoot, { candidate: true, sessionId: `unknown-candidate-${suffix}`,
          output: 'SUM=23' })
        pairs.push({ pairId, baseline, candidate })
      }
      const proposalHash = sha256('unknown-proposal')
      const measurementDefinitionHash = sha256('unknown-measurement')
      for (const pair of pairs) for (const [role, row] of [['baseline', pair.baseline], ['candidate',
        pair.candidate]] as const) Object.assign(row.f.binding, {
        role, pairId: pair.pairId, proposalHash, measurementDefinitionHash,
      })
      const evaluator: KnowledgeMeasuredUseEvaluator = {
        authorityId: 'unknown-evaluator',
        async verifyRegisteredFixedTask(request) { verificationCalls++; return signOracle('unknown-evaluator',
          request.registeredRequestHash, 'pass', keys.privateKey) },
        async evaluateCapturedUse() { throw new Error('must not evaluate without unique cost') },
        async finalizeMeasuredTrial() { throw new Error('must not finalize without unique cost') },
      }
      const input = {
        pairs: pairs.map(pair => ({ pairId: pair.pairId, baseline: { snapshotPath: pair.baseline.snapshotPath,
          expectedSnapshotHash: pair.baseline.expectedSnapshotHash, binding: pair.baseline.f.binding, registeredTask: registered },
        candidate: { snapshotPath: pair.candidate.snapshotPath, expectedSnapshotHash: pair.candidate.expectedSnapshotHash,
          binding: pair.candidate.f.binding, registeredTask: registered } })),
        proposalHash, grantHash: sha256('unknown-grant'), preRegistrationHash: sha256('unknown-prereg'), measurementDefinitionHash,
        journalAuthority: { authorityId: 'unknown-journal', publicKey: keys.publicKey,
          async signKnowledgeUseJournal(request) { signingCalls++; return sign(null, Buffer.from(canonicalJson(request)),
            keys.privateKey) } },
        costOwner: { authorityId: 'fixture-only-cost-owner', async resolveUniqueSettledUse(request) {
          if (request.sessionId === 'unknown-candidate-b') {
            expect(request.capturedRequestHashes.length).toBeGreaterThan(1)
            return fixtureCostWitness(request, { omitRequestIndex: request.capturedRequestHashes.length - 1 })
          }
          return fixtureCostWitness(request)
        } }, evaluator,
        reader: { authorityId: evaluator.authorityId, read: () => undefined },
        reviewBinding: { reviewHash: sha256('review'), semanticReceiptHash: sha256('semantic'), candidatePath: '_candidates/x.md',
          candidateHash: sha256('candidate'), action: 'Promote', targetPath: 'x.md',
          targetBeforeHashOrVerifiedAbsence: 'verified-absence' },
        artifactRoot, signal: new AbortController().signal,
      } satisfies Parameters<typeof produceMeasuredUseV1>[0]
      const result = await produceMeasuredUseV1(input)
      expect(result).toEqual({ status: 'unknown', reason: 'no-unique-settled-cost-witness', orderedUseReceiptHashes: [] })
      expect(verificationCalls).toBe(0)
      expect(signingCalls).toBe(0)
      expect(await readdir(artifactRoot)).toEqual([])
      for (const override of [
        { reader: { ...input.reader, authorityId: 'different-reader' } },
        { journalAuthority: { ...input.journalAuthority, authorityId: evaluator.authorityId } },
        { costOwner: { ...input.costOwner, authorityId: '' } },
        { costOwner: { ...input.costOwner, async resolveUniqueSettledUse() { return { status: 'unknown' as const, reason: 'pending' } } } },
      ]) expect((await produceMeasuredUseV1({ ...input, ...override })).status).toBe('unknown')
      for (const changedPairs of [[], [input.pairs[0]!, input.pairs[0]!],
        input.pairs.map(pair => ({ ...pair, candidate: { ...pair.candidate, binding: { ...pair.candidate.binding,
          sessionId: pair.baseline.binding.sessionId } } })),
        input.pairs.map(pair => ({ ...pair, candidate: { ...pair.candidate, binding: { ...pair.candidate.binding,
          task: 'another registered task' } } })),
        input.pairs.map(pair => ({ ...pair, candidate: { ...pair.candidate, binding: { ...pair.candidate.binding,
          pairId: 'different pair' } } })),
      ]) await expect(produceMeasuredUseV1({ ...input, pairs: changedPairs })).rejects.toThrow()
      await expect(produceMeasuredUseV1({ ...input, costOwner: { ...input.costOwner,
        async resolveUniqueSettledUse(request) { return { ...fixtureCostWitness(request), artifactHash: sha256('changed digest') } },
      } })).rejects.toThrow('cost witness digest differs')
      expect(verificationCalls).toBe(0)
      expect(signingCalls).toBe(0)
      expect(await readdir(artifactRoot)).toEqual([])

    } finally {
      await context.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)

})

// These causal controls use ephemeral test authorities and synthetic provider observations.
// The registered original code is really modified and tested; no actual provider utility is claimed.
describe('pre-observation owner lifecycle', () => {
  it('admits only existing owner initialization records and rejects every known observation vocabulary', () => {
    const permitted = ['session/end-seed', 'agent-preset/selected', 'model/selection', 'plan/mode',
      'permission/preset', 'sandbox/mode', 'approval/policy']
    expect(() => {
      assertUnobservedKnowledgeStartPrefix([])
    }).not.toThrow()
    for (const type of permitted) {
      expect(KNOWN_SESSION_EVENT_TYPES.has(type)).toBe(true)
      expect(() => {
        assertUnobservedKnowledgeStartPrefix([{ type }])
      }).not.toThrow()
    }
    for (const type of KNOWN_SESSION_EVENT_TYPES) if (!permitted.includes(type)) {
      expect(() => {
        assertUnobservedKnowledgeStartPrefix([{ type }])
      }, type).toThrow('start fence contains task observations')
    }
    expect(() => {
      assertUnobservedKnowledgeStartPrefix([{ type: 'unknown/future-observation' }])
    }).toThrow()
  })

  const admissionTestName = process.platform === 'win32'
    ? 'refuses non-POSIX pre-observation admission from %s logs without changing the task'
    : 'freezes original code before overwrite and assembles legacy evidence from %s logs'
  it.each(['none', 'zstd'] as const)(admissionTestName,
    async (compression) => {
      const compactTaskStep = process.env['ARK_OBSERVATION_COMPACT_TASK_STEPS'] === '1'
      const dispatchLimit = compactTaskStep ? 3 : 2
      const retainRoot = process.env['ARK_OBSERVATION_FIXTURE_ROOT']
      const root = await mkdtemp(join(retainRoot ?? tmpdir(), 'ark-observation-causal-'))
      const artifactRoot = join(root, 'artifacts'), sessionRoot = join(root, 'sessions'), projectRoot = join(root, 'project')
      const compiledRoot = process.env['ARK_OBSERVATION_COMPILED_RUNTIME_ROOT']
      const runtimeRoot = compiledRoot ?? join(root, 'runtime')
      const entryRelativePath = 'protected-helpers/scripts/rust-migration/knowledge-use-evaluator.mjs'
      const guardEntryRelativePath = 'protected-helpers/scripts/rust-migration/knowledge-cost-guard-launcher.mjs'
      await mkdir(artifactRoot); await mkdir(sessionRoot); await mkdir(projectRoot)
      if (compiledRoot === undefined) {
        await mkdir(join(runtimeRoot, 'protected-helpers/scripts/rust-migration'), { recursive: true })
        await writeFile(join(runtimeRoot, entryRelativePath), 'fixture keyless entry')
        await writeFile(join(runtimeRoot, guardEntryRelativePath), 'fixture keyless guard')
      }
      await mkdir(join(projectRoot, '.llm-wiki/_candidates'), { recursive: true })
      const context = new Context()
      const keys = generateKeyPairSync('ed25519'), journalKeys = generateKeyPairSync('ed25519'), promotionKeys = generateKeyPairSync('ed25519')
      const authorityId = 'pilot-test:observation-evaluator'
      const signal = new AbortController().signal
      const put = (bytes: Buffer) => {
        const ref = { hash: sha256(bytes), byteLength: bytes.byteLength }
        atomicWriteFile(join(artifactRoot, ref.hash), bytes)
        return ref
      }
      const putJson = (value: unknown) => put(Buffer.from(canonicalJson(value)))
      const signed = (value: Record<string, unknown>) => {
        const unsigned = { ...value, evaluatorAuthorityId: authorityId }
        return putJson({ ...unsigned, evaluatorSignature: sign(null, Buffer.from(canonicalJson(unsigned)),
          keys.privateKey).toString('base64') })
      }
      try {
        await context.plugin(SessionStore)
        await context.plugin(JsonlSessionPersistence, { root: sessionRoot, compression })
        await context.plugin(LocalSubprocessRuntime)
        await context.plugin(SandboxLocal)
        const receiptBytes = compiledRoot === undefined ? undefined : await readFile(join(compiledRoot, '.ark-provenance/pack-receipt.json'))
        const manifestBytes = compiledRoot === undefined ? undefined : await readFile(join(compiledRoot,
          '.ark-provenance/installed-runtime-manifest.json'))
        const receipt = receiptBytes === undefined ? undefined : JSON.parse(receiptBytes.toString('utf8')) as { sourceDigest: string
          sourceIdentity: { commit: string; dirty: boolean; dirtyDiffSha256: string }
          installedRuntimeManifestSha256: string }
        const sourceIdentity = receipt === undefined ? { commit: 'a'.repeat(40), sourceDigest: sha256('source'), dirty: true,
          dirtyDigest: sha256('dirty'), buildDigest: sha256('build') }
          : { commit: receipt.sourceIdentity.commit, sourceDigest: receipt.sourceDigest, dirty: receipt.sourceIdentity.dirty,
            dirtyDigest: receipt.sourceIdentity.dirtyDiffSha256, buildDigest: receipt.installedRuntimeManifestSha256 }
        const buildDigest = sourceIdentity.buildDigest
        const modelIdentity = { model: config.model, modelConfigHash: sha256(canonicalJson(config)),
          taskHash: sha256('registered task'), goalHash: sha256('goal'), policyHash: sha256('policy') }
        const rule = put(Buffer.from('Frozen rule; not a prior answer.'))
        await writeFile(join(projectRoot, '.llm-wiki/_candidates/rule.md'), Buffer.from('Frozen rule; not a prior answer.'))
        const initialCode = put(Buffer.alloc(0)), protectedFile = put(Buffer.from('frozen task fixture'))
        await writeFile(join(projectRoot, 'paginate.ts'), Buffer.alloc(0)); await writeFile(join(projectRoot, 'protected.txt'),
          'frozen task fixture')
        const definition = putJson(FIXED_KNOWLEDGE_MEASUREMENT_DEFINITION_V1)
        const proposal = putJson({ candidatePath: '_candidates/rule.md', candidateHash: rule.hash, sourceIdentity, buildIdentity: {
          digest: buildDigest },
        profileIdentity: { profile: 'isolated-test-profile' }, reviewHash: sha256('review'), semanticReceiptHash: putJson({ fixture:
          'semantic' }).hash,
        action: 'Promote', targetPath: 'concepts/fixed-rule.md', targetBeforeHashOrVerifiedAbsence: 'verified-absence' })
        const prereg = signed({ proposalHash: proposal.hash, measurementDefinitionHash: definition.hash,
          orderedPairIds: ['pair-1'], modelConfigTaskGoalPolicyIdentity: modelIdentity, issuedAt: new Date(Date.now() -
          60_000).toISOString() })
        const deadline = new Date(Date.now() + (retainRoot === undefined ? 180_000 : 86_400_000)).toISOString(), expiresAt = new
        Date(Date.now() + (retainRoot === undefined ? 240_000 : 604_800_000)).toISOString()
        const grant = signed({ grantId: 'grant-1', proposalHash: proposal.hash, reviewedDecisionHash: proposal.hash,
          preRegistrationHash: prereg.hash, measurementDefinitionHash: definition.hash, allowedSessionIds: ['observe-candidate'],
          modelConfigTaskGoalPolicyIdentity: modelIdentity, maxObservations: 1, maxTurns: 1,
          issuedAt: new Date(Date.now() - 30_000).toISOString(), deadline, expiresAt })
        const verification = putJson({ schemaVersion: 2, candidatePath: '_candidates/rule.md', candidateHash: rule.hash })
        const fixtures = [scenario({ sessionId: 'observe-baseline', projectRoot }), scenario({ sessionId: 'observe-candidate', candidate:
        true, projectRoot })]
        const slots: Slot[] = []
        for (const [index, f] of fixtures.entries()) {
          if (!(context.sessionPersistence instanceof JsonlBackend)) throw new Error('expected original JSONL owner')
          await context.sessionPersistence.materializeHeader(f.metadata)
          // Header-only prefix is admitted before any task observation exists.
          const location = context.sessionPersistence.locate(f.metadata)
          if (location?.kind !== 'jsonl') throw new Error('missing original persistence location')
          const initial = await readFile(location.path)
          const rawInitial = Buffer.from((await context.sessionPersistence.readRaw(f.metadata.id))!.content)
          const header = rawInitial.subarray(0, rawInitial.indexOf(10) + 1)
          const eventPrefix = rawInitial.subarray(rawInitial.indexOf(10) + 1)
          const initialLoaded = await context.sessionPersistence.load(f.metadata.id)
          slots.push(parseObservation('Slot', { pairId: 'pair-1', role: index === 0 ? 'baseline' : 'candidate',
            useId: `observe-use-${index}`, sessionId: String(f.metadata.id), turn: 1,
            snapshotRelativePath: relative(sessionRoot, location.path), startFence: { encoding: compression === 'none' ? 'jsonl' :
              'jsonl-zstd',
            originalInitialSnapshotBytes: put(initial), metadataEnvelopeBytes: put(header), eventSequencePrefixBytes: put(eventPrefix),
            lastEventSeq: initialLoaded.events.at(-1)?.seq ?? null, expectedTurn: 1 }, grantId: index === 0 ? null : 'grant-1',
            knowledge: index === 0 ? null : { id: f.binding.knowledge!.id, sourceContentBytes: rule,
              renderedBytes: put(Buffer.from(JSON.stringify(f.binding.knowledge!.rendered))) },
            registeredVerificationRequestBytes: verification, acceptedRuleHash: rule.hash,
            taskDefinition: { kind: 'pagination-v1', codePath: 'paginate.ts', initialCodeBytes: initialCode,
              protectedFiles: [{ path: 'protected.txt', bytes: protectedFile }], timeoutMs: 2000 },
            allocatedTaskProjectionRelativeRoot: `tasks/slot-${index}` }))
        }
        const ledgerPath = process.env['ARK_OBSERVATION_LEDGER_PATH'] ?? join(root, 'ledger.json')
        const guardConfigurationPath = process.env['ARK_OBSERVATION_GUARD_CONFIG_PATH']
        const guardEndpoint = process.env['ARK_OBSERVATION_GUARD_ENDPOINT'] ?? 'http://127.0.0.1:1'
        const ledger = process.env['ARK_OBSERVATION_LEDGER_PATH'] === undefined
          ? putJson({ schema: 2, budgetMicroCny: 5_000_000, maxRequests: 32, requestCount: 0, settledUpperBoundMicroCny: 0, pending: [] })
          : put(await readFile(ledgerPath))
        const guardConfiguration = guardConfigurationPath === undefined
          ? putJson({ schemaVersion: 1, ledgerPath }) : put(await readFile(guardConfigurationPath))
        const coreInput = { schemaVersion: 1, kind: 'fixed-trial-admission-core-v1', mode: 'ephemeral-test-only',
          trialId: 'observation-trial',
          packReceiptBytes: receiptBytes === undefined ? putJson({ fixture: 'pack' }) : put(receiptBytes), installedManifestBytes:
          manifestBytes === undefined ? putJson({ fixture: 'manifest' }) : put(manifestBytes), runtimeRoot,
          nodePath: process.execPath, nodeHash: sha256(await readFile(process.execPath)), entryRelativePath,
          entryHash: sha256(await readFile(join(runtimeRoot, entryRelativePath))), projectRoot, sessionRoot, artifactRoot,
          authorities: { evaluator: { authorityId, publicKeySpkiBase64: keys.publicKey.export({ format: 'der', type: 'spki',
          }).toString('base64') },
          promotion: { authorityId: 'pilot-test:observation-promotion', publicKeySpkiBase64: promotionKeys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') },
          journal: { authorityId: 'fixture-observation-journal', publicKeySpkiBase64: journalKeys.publicKey.export({ format: 'der',
            type: 'spki' }).toString('base64') },
          costAuthorityId: authorityId, producerId: 'fixture-observation-producer' },
          proposalBytes: proposal, grantBytes: grant, preRegistrationBytes: prereg, measurementDefinitionBytes: definition,
          sourceIdentity, buildIdentity: buildDigest, profileIdentity: 'isolated-test-profile',
          originalTaskUtf8Bytes: put(Buffer.from('registered task')), originalConfigCanonicalBytes: putJson(config),
          originalPermissionsCanonicalBytes: putJson(fixtures[0]!.binding.permissions), goalHash: modelIdentity.goalHash, policyHash:
          modelIdentity.policyHash,
          deadline, expiresAt, orderedPairIds: ['pair-1'], orderedSlots: slots,
          promotionPolicy: { promotionRequestHashes: [], promotionVerificationManifestHashes: [] },
          operationLimits: { sealPromotion: 0, signKnowledgeUseJournal: 2, verifyCandidate: 2, evaluateCapturedUse: 2,
            finalizeMeasuredTrial: 1,
            registerProviderDispatch: dispatchLimit, recordProviderSettlement: dispatchLimit, resolveSettledUseCost: 2 },
          cost: { initialLedgerBytes: ledger, ledgerPath, endpoint: guardEndpoint, provider:
          config.provider,
          configuredModel: config.model, wireModel: 'deepseek-flash', maxTokens: 8192, maximumNewDispatches: dispatchLimit, maximumNewSettlements: dispatchLimit,
          guardConfigurationBytes: guardConfiguration }, guardEntryRelativePath,
          guardEntryHash: sha256(await readFile(join(runtimeRoot, guardEntryRelativePath))) }
        if (process.platform === 'win32') {
          // The protected Native admission schema intentionally accepts only
          // POSIX roots. Verify refusal without broadening that schema or
          // pretending this Windows fixture proves admitted task execution.
          expect(() => parseObservation('Core', coreInput)).toThrow()
          expect(await readFile(join(projectRoot, 'paginate.ts'))).toEqual(Buffer.alloc(0))
          expect(await readFile(join(projectRoot, 'protected.txt'), 'utf8')).toBe('frozen task fixture')
          expect((await context.sessionPersistence.load(fixtures[0]!.metadata.id)).events).toHaveLength(0)
          expect((await context.sessionPersistence.load(fixtures[1]!.metadata.id)).events).toHaveLength(0)
          return
        }
        const core = parseObservation('Core', coreInput)
        const sourceBindingHash = sha256(canonicalJson(core))
        const admission = signed({ schemaVersion: 1, kind: 'knowledge-live-cost-admission-v1', proposalHash: proposal.hash,
          grantHash: grant.hash, preRegistrationHash: prereg.hash, sourceBindingHash, sessionIDs: slots.map(slot => slot.sessionId),
          ledgerArtifactHash: ledger.hash, maximumNewDispatches: dispatchLimit, maximumNewSettlements: dispatchLimit })
        const intent = parseObservation('Intent', { schemaVersion: 1, kind: 'fixed-trial-admission-intent-v1', core, sourceBindingHash,
          liveCostAdmissionBytes: admission })
        const intentRef = putJson(intent)
        const launch = { schemaVersion: 1, kind: 'fixed-trial-intent-helper-launch-v1', intentHash: intentRef.hash, artifactRoot,
          sourceBindingHash }
        const described = parseObservation('DescribeIntentOutput', await evaluateObservationOperation(launch,
          { schemaVersion: 1, operation: 'describeAdmissionIntentV1' }, signal))
        const descriptorHash = sha256(canonicalJson(described.descriptor)), generationId = 'a0000000-0000-0000-0000-000000000001'
        expect(described.descriptor.sessionIDs).toEqual(slots.map(slot => slot.sessionId))
        const launchPath = join(root, 'intent-launch.json')
        await writeFile(launchPath, canonicalJson(launch))
        const cliDescription = await runEvaluatorCli(context, launchPath, { schemaVersion: 1, operation: 'describeAdmissionIntentV1' })
        expect(cliDescription.code, cliDescription.stderr).toBe(0)
        expect(JSON.parse(cliDescription.stdout)).toEqual(described)
        const outputs = []
        const actualTaskCommands: string[] = [], actualTaskOutputs: string[] = []
        const costSlots: CostSlot[] = []
        for (const [index, slot] of slots.entries()) {
        // Execute the registered original task file write and actual fixed test, before capture.
          const code = index === 0 ? Buffer.alloc(0) :
            Buffer.from('export function paginate(items,page,pageSize) { if(!Number.isSafeInteger(page)||!Number.isSafeInteger(pageSize)||page<1||pageSize<1) throw new RangeError(); return {items:items.slice((page-1)*pageSize,page*pageSize),page,pageSize,totalItems:items.length,totalPages:Math.ceil(items.length/pageSize)} }')
          const taskProgram = `const fs=require('node:fs');const
          assert=require('node:assert/strict');fs.writeFileSync(${JSON.stringify(join(projectRoot,
            'paginate.ts'))},Buffer.from(${JSON.stringify(code.toString('base64'))},'base64'));assert.equal(fs.readFileSync(${JSON.stringify(join(projectRoot, 'protected.txt'))},'utf8'),'frozen task fixture');console.log('registered task write and protected test completed')`
          const actualResult = execFileSync(process.execPath, ['--eval', taskProgram], { encoding: 'utf8', cwd: projectRoot })
          actualTaskCommands.push(taskProgram); actualTaskOutputs.push(actualResult)
          const completed = scenario({ sessionId: slot.sessionId, candidate: slot.role === 'candidate', projectRoot, output: index === 0
            ? '' : 'completed task',
          compactTaskStep, actualTaskTool: { arguments: JSON.stringify({ command: taskProgram }), result: actualResult } })
          await context.sessionPersistence.append(completed.metadata.id, completed.events)
          const input = { schemaVersion: 1, operation: 'captureNextCompletedRegisteredSlotV1', intentHash: intentRef.hash, descriptorHash,
            generationId, slotIndex: index, reservationRevision: index + 1, inflightEpoch: index + 1 }
          const output = parseObservation('CaptureNextOutput', await evaluateObservationOperation(launch, input, signal))
          expect(output.slot.outcome).toBe('complete')
          expect(output.slot.capture!.actualTaskFiles.find(file => file.path === 'paginate.ts')!.bytes.hash).toBe(sha256(code))
          if (index === 0) expect(output.slot.capture!.wholeOutputUtf8Bytes.byteLength).toBe(0)
          const marker = join(artifactRoot, 'trial-generations', generationId, 'committed-captures', `slot-${index}.json`)
          await mkdir(join(artifactRoot, 'trial-generations', generationId, 'committed-captures'), { recursive: true })
          await writeFile(marker, canonicalJson(output)) // synthetic Native CAS marker after successful joined task capture.
          outputs.push(output)
          const captured = output.slot.capture!
          const cost = fixtureCostWitness({ sessionId: slot.sessionId, sessionSnapshotHash: captured.originalSnapshot.hash,
            capturedRequestHashes: captured.capturedRequestHashes }, process.env['ARK_OBSERVATION_NATIVE_TEST_KEYS'] === '1'
            ? { nativePricing: { responseModel: core.cost.wireModel, maxTokens: core.cost.maxTokens } } : {})
          const witness = JSON.parse(Buffer.from(cost.artifactBytesBase64, 'base64').toString('utf8')) as { attempts: {
            registrationArtifactHash: string
            settlementArtifactHash: string }[] }
          costSlots.push({ sessionId: slot.sessionId, sessionSnapshotHash: captured.originalSnapshot.hash, capturedRequestHashes:
          captured.capturedRequestHashes,
          status: 'verified', witnessBytes: put(Buffer.from(cost.artifactBytesBase64, 'base64')),
          registrationArtifactHashes: witness.attempts.map(attempt => attempt.registrationArtifactHash),
          settlementArtifactHashes: witness.attempts.map(attempt => attempt.settlementArtifactHash), reason: null })
        }
        const collectedInput = { schemaVersion: 1, operation: 'collectFrozenRegisteredSlotsV1', intentHash: intentRef.hash, descriptorHash,
          generationId, reservationRevision: 3, inflightEpoch: 3 }
        const collected = parseObservation('CaptureOutput', await evaluateObservationOperation(launch, collectedInput, signal))
        const captureRef = putJson(collected), costRef = putJson({ schemaVersion: 1, kind: 'fixed-trial-native-cost-resolution-v1',
          intentHash: intentRef.hash, descriptorHash, generationId, reservationRevision: 3, orderedSlots: costSlots })
        const assemblyInput = { ...collectedInput, operation: 'assembleFrozenTrialConfigV1', captureOutputHash: captureRef.hash,
          costResolutionHash: costRef.hash }
        const assembled = parseObservation('AssemblerOutput', await evaluateObservationOperation(launch, assemblyInput, signal))
        expect(assembled.status).toBe('complete')
        const completedLaunch: unknown = JSON.parse((await readFile(join(artifactRoot, assembled.completedLaunchBytes!.hash))).toString('utf8'))
        const resolved = resolveCompletedEvaluation(completedLaunch)
        expect(resolved.config.registrations).toHaveLength(2)
        const baselineProjection = resolved.projections.get(slots[0]!.sessionId)!
        expect(await readFile(join(artifactRoot, baselineProjection.physicalRelativeRoot, 'paginate.ts'))).toEqual(Buffer.alloc(0))
        expect(await readFile(join(projectRoot, 'paginate.ts'))).not.toEqual(Buffer.alloc(0))
        for (const output of outputs) expect(await readFile(join(artifactRoot, output.slot.capture!.frozenSnapshotRelativePath))).toEqual(
          await readFile(join(sessionRoot, slots[output.slotIndex]!.snapshotRelativePath)))
        if (compactTaskStep) {
          const socketRoot = await mkdtemp('/private/tmp/ark-observation-channel-')
          const socketPath = join(socketRoot, 'owner.sock'), launchToken = 'ephemeral-observation-source-channel-token'
          const peers = new Set<Socket>(), operations: string[] = []
          let helloCount = 0
          const frame = (value: unknown) => { const bytes = Buffer.from(JSON.stringify(value)); const prefix = Buffer.alloc(4)
            prefix.writeUInt32BE(bytes.byteLength); return Buffer.concat([prefix, bytes]) }
          const executions = new Map([...resolved.projections].map(([id, projection]) => [id, {
            logicalProjectRoot: projection.logicalProjectRoot, physicalProjectRoot: join(artifactRoot, projection.physicalRelativeRoot),
            files: projection.files.map(file => ({ path: file.path, hash: file.bytes.hash })),
          }]))
          const server = createServer((peer) => {
            peers.add(peer); peer.on('error', () => {}); peer.on('close', () => peers.delete(peer))
            let buffered = Buffer.alloc(0)
            peer.on('data', (chunk) => {
              buffered = Buffer.concat([buffered, chunk])
              while (buffered.length >= 4 && buffered.length >= buffered.readUInt32BE(0) + 4) {
                const length = buffered.readUInt32BE(0)
                const request = JSON.parse(buffered.subarray(4, length + 4).toString('utf8')) as {
                  operation: string
                  requestId?: string
                  launchToken?: string
                  payload?: Record<string, unknown> }
                buffered = buffered.subarray(length + 4)
                if (request.operation === 'hello') {
                  expect(request.launchToken).toBe(launchToken); helloCount += 1
                  peer.write(frame({ version: 1, ok: true, ownerStatus: 'ready', sourceIdentity, artifactRoot,
                    authorities: [
                      ['promotion', core.authorities.promotion.authorityId, promotionKeys],
                      ['journal', core.authorities.journal.authorityId, journalKeys], ['evaluator', authorityId, keys],
                    ].map(([role, authority, pair]) => ({ role, authorityId: authority,
                      publicKeySpki: (pair as typeof keys).publicKey.export({ format: 'pem', type: 'spki' }), sourceBindingHash })) }))
                  continue
                }
                operations.push(request.operation)
                void (async () => {
                  try {
                    const payload = request.payload
                    if (payload === undefined) throw new Error('source fixture payload missing')
                    let result: unknown
                    if (request.operation === 'resolveSettledUseCost') {
                      const frozen = costSlots.find(slot => slot.sessionId === payload['sessionId'])
                      if (frozen === undefined || frozen.witnessBytes === null || frozen.sessionSnapshotHash !== payload['sessionSnapshotHash']
                      || canonicalJson(frozen.capturedRequestHashes) !== canonicalJson(payload['capturedRequestHashes'])) {
                        throw new Error('source cost fixture coverage differs')
                      }
                      result = { status: 'verified', artifactHash: frozen.witnessBytes.hash,
                        artifactBytesBase64: (await readFile(join(artifactRoot, frozen.witnessBytes.hash))).toString('base64') }
                    }
                    else {
                      const recipe = await evaluateKnowledgeUseOperation(resolved.config, payload, context.subprocess, context.sandbox,
                        signal, executions)
                      const bytes = Buffer.from(recipe.canonicalBytes, 'base64')
                      const pair = recipe.role === 'journal' ? journalKeys : recipe.role === 'promotion' ? promotionKeys : keys
                      const signature = sign(null, bytes, pair.privateKey).toString('base64')
                      result = recipe.role === 'journal' ? { signature } : recipe.signatureField === 'proof'
                        ? { ...(JSON.parse(bytes.toString('utf8')) as Record<string, unknown>), proof: signature }
                        : { artifactBase64: Buffer.from(canonicalJson({ ...(JSON.parse(bytes.toString('utf8')) as Record<string, unknown>),
                          [recipe.signatureField]: signature })).toString('base64') }
                    }
                    peer.write(frame({ version: 1, requestId: request.requestId, ok: true, result }))
                  } catch (error) {
                    peer.write(frame({ version: 1, requestId: request.requestId, ok: false,
                      error: { code: 'fixture-refused', message: error instanceof Error ? error.message : String(error) } }))
                  }
                })()
              }
            })
          })
          await new Promise<void>(done => server.listen(socketPath, done))
          try {
            const path = join(root, 'completed-launch-for-cli.json')
            await writeFile(path, canonicalJson(completedLaunch))
            const argv = compiledRoot === undefined
              ? [process.execPath, '--import', createRequire(import.meta.url).resolve('tsx'),
                fileURLToPath(new URL('./knowledge-use-producer.ts', import.meta.url)), path]
              : [process.execPath, join(compiledRoot, 'protected-helpers/scripts/rust-migration/knowledge-use-producer.mjs'), path]
            const child = context.subprocess.spawn({ argv, cwd: process.cwd(),
              env: { ...isolatedChildEnvironment(), ARK_NATIVE_OWNER_SOCKET_PATH: socketPath, ARK_NATIVE_OWNER_LAUNCH_TOKEN: launchToken,
                TSX_TSCONFIG_PATH: fileURLToPath(new URL('../../tsconfig.base.json', import.meta.url)) },
              signal: AbortSignal.timeout(30_000), graceMs: 1000,
              stdio: { stdin: { data: '' }, stdout: { maxBytes: 4 * 1024 * 1024 }, stderr: { maxBytes: 32 * 1024 } } })
            try {
              const outcome = await child.done
              expect(await child.waitForExit()).toBe(true)
              const stdout = child.collected.stdout?.readFrom(0), stderr = child.collected.stderr?.readFrom(0)
              expect(outcome.exitCode, stderr?.text).toBe(0)
              expect(stdout?.lossy).toBe(false); expect(stderr?.lossy).toBe(false)
              const result = JSON.parse(stdout!.text) as { status: string; orderedUseReceiptHashes: string[] }
              expect(result.status).toBe('rejected') // Actual original reader retains synthetic guard UNKNOWN/0-denominator limits.
              expect(result.orderedUseReceiptHashes).toHaveLength(2)
              expect(helloCount).toBe(1)
              expect(operations.filter(operation => operation === 'finalizeMeasuredTrial')).toHaveLength(1)
              for (const operation of ['resolveSettledUseCost', 'signKnowledgeUseJournal', 'verifyCandidate', 'evaluateCapturedUse']) {
                expect(operations.filter(item => item === operation)).toHaveLength(2)
              }
            } finally { child.terminate(); await child.done; expect(await child.waitForExit()).toBe(true) }
          } finally {
            for (const peer of peers) peer.destroy()
            await new Promise<void>(done => server.close(() => { done() }))
            await rm(socketRoot, { recursive: true, force: true })
          }
        }
        const unknownCost = putJson({ schemaVersion: 1, kind: 'fixed-trial-native-cost-resolution-v1', intentHash: intentRef.hash,
          descriptorHash,
          generationId, reservationRevision: 3, orderedSlots: costSlots.map((slot, index) => index === 0 ? slot : { ...slot,
            status: 'unknown', witnessBytes: null, reason: 'pending-attempt' }) })
        const ineligible = parseObservation('AssemblerOutput', await evaluateObservationOperation(launch, { ...assemblyInput,
          costResolutionHash: unknownCost.hash }, signal))
        expect(ineligible).toMatchObject({ status: 'ineligible-observation', completedConfigBytes: null, completedLaunchBytes: null,
          orderedRegisteredManifestHashes: [], orderedCostWitnessHashes: [] })
        await expect(evaluateObservationOperation(launch, { ...collectedInput, generationId: 'b0000000-0000-0000-0000-000000000002' },
          signal)).rejects.toThrow()
        await expect(evaluateObservationOperation(launch, { ...assemblyInput, inflightEpoch: 4 },
          signal)).rejects.toThrow('complete slot set differs')
        const first = slots[0]!
        const initial = await readFile(join(artifactRoot, first.startFence.originalInitialSnapshotBytes.hash))
        const bad = initial.subarray(0, initial.byteLength - 1)
        await expect(readObservationSnapshot(bad, intent, first, signal)).rejects.toThrow()
        const decoded = await readObservationSnapshot(initial, intent, first, signal)
        expect(decoded.loaded.events).toHaveLength(0)
        const zstdPhysical = await compressZstdFrame(Buffer.concat([decoded.metadata, Buffer.alloc(0)]))
        const observedPrefix = Session.create(SessionId('prefix-observation-only'), undefined,
          { version: 0, id: SessionId('prefix-observation-only'), createdAt: 10, cwd: projectRoot })
        observedPrefix.append('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'block-start', index: 0, blockType: 'text' } })
        await context.sessionPersistence.create(observedPrefix.header)
        await context.sessionPersistence.append(observedPrefix.id, observedPrefix.events)
        const observedLocation = context.sessionPersistence.locate(observedPrefix.header)
        if (observedLocation?.kind !== 'jsonl') throw new Error('missing original observation prefix')
        const observedSlot = { ...first, sessionId: String(observedPrefix.id) }
        const observedLoaded = await readObservationSnapshot(await readFile(observedLocation.path), intent, observedSlot, signal)
        expect(observedLoaded.loaded.events.some(event => event.type === 'assistant/chunk')).toBe(true)
        expect(() => {
          assertUnobservedKnowledgeStartPrefix(observedLoaded.loaded.events)
        }).toThrow('start fence contains task observations')
        const zstdSlot = { ...first, startFence: { ...first.startFence, encoding: 'jsonl-zstd' as const } }
        expect((await readObservationSnapshot(zstdPhysical, intent, zstdSlot, signal)).loaded.events).toHaveLength(0)
        expect(() => parseObservation('CaptureNextInput', { ...collectedInput, operation: 'captureNextCompletedRegisteredSlotV1', slotIndex: 0, callerOutputHash: sha256('injected'),
        })).toThrow()
        if (retainRoot !== undefined) {
          let testKeyTransferPath: string | null = null
          if (process.env['ARK_OBSERVATION_NATIVE_TEST_KEYS'] === '1') {
            const transferRoot = await mkdtemp('/private/tmp/ark-observation-test-keys-')
            testKeyTransferPath = join(transferRoot, 'ephemeral-test-seeds.json')
            const seed = (pair: typeof keys) => pair.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32).toString('hex')
            const privateSeedBytes = JSON.stringify({ promotion: seed(promotionKeys), evaluator: seed(keys),
              journal: seed(journalKeys) })
            await writeFile(testKeyTransferPath, privateSeedBytes,
              { flag: 'wx', mode: 0o600 })
          }
          const completedLaunchPath = join(root, 'completed-launch.json')
          await writeFile(completedLaunchPath, canonicalJson(completedLaunch))
          await writeFile(join(root, 'capture-inputs.json'), canonicalJson(outputs.map(output => ({ schemaVersion: 1,
            operation: 'captureNextCompletedRegisteredSlotV1', intentHash: intentRef.hash, descriptorHash, generationId,
            slotIndex: output.slotIndex, reservationRevision: output.reservationRevision, inflightEpoch: output.inflightEpoch }))))
          await writeFile(join(root, 'collect-input.json'), canonicalJson(collectedInput))
          await writeFile(join(root, 'assembler-input.json'), canonicalJson(assemblyInput))
          await writeFile(join(root, 'public-fixture.json'), canonicalJson({ schemaVersion: 1, fixtureOnly: true,
            observationScope: 'synthetic-provider-logs-actual-original-file-writes-and-task-test',
            compression, compactTaskStep, dispatchLimit, root, runtimeRoot,
            intentLaunchPath: launchPath, completedLaunchPath, testKeyTransferPath,
            intentHash: intentRef.hash, descriptorHash, generationId,
            initialSnapshots: slots.map(slot => ({ sessionId: slot.sessionId, originalPath: join(sessionRoot, slot.snapshotRelativePath),
              initialBlobPath: join(artifactRoot, slot.startFence.originalInitialSnapshotBytes.hash), expectedHash:
              slot.startFence.originalInitialSnapshotBytes.hash })),
            completedSlots: outputs.map(output => ({ slotIndex: output.slotIndex, sessionId: output.slot.sessionId,
              actualTaskCommand: actualTaskCommands[output.slotIndex], actualTaskOutput: actualTaskOutputs[output.slotIndex],
              capturedSnapshotPath: join(artifactRoot, output.slot.capture!.frozenSnapshotRelativePath),
              taskProjectionHash: output.slot.capture!.taskProjectionBytes.hash,
              taskProjectionPhysicalRoot: join(artifactRoot, 'trial-generations', generationId,
                slots[output.slotIndex]!.allocatedTaskProjectionRelativeRoot) })),
            codeOriginalPath: join(projectRoot, 'paginate.ts'), initialCodeBlobPath: join(artifactRoot, initialCode.hash),
            capturedCostResolutionHash: costRef.hash, capturedOutputHash: captureRef.hash,
            capturedRequestCounts: outputs.map(output => output.slot.capture!.capturedRequestHashes.length),
            nativeCostBoundsExpected: compactTaskStep ? 'within-fresh-preregistered-cap3' : 'over-cap2-negative',
            sourceBindingHash, syntheticProviderUtilityClaim: false }))
        }
      } finally { await context.fiber.dispose(); if (retainRoot === undefined) await rm(root, { recursive: true, force: true }) }
    }, 60_000)
})
