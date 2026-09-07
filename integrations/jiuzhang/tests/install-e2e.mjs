// Installed-state acceptance: boot the product exactly as a packaged install
// would — the embedded node binary plus the launcher, an isolated home — and
// verify the acceptance surface: a native self-contained bundle, API-only
// root fencing, the Bearer gate, the seeded local-model provider, and clean
// shutdown. A standalone runtime remains available for development, but the
// product acceptance target is the assembled Ark.app (ARK_APP_PATH).

import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'
import WebSocket from 'ws'
import {
  probeLoopbackPort,
  runCleanupSteps,
  serializeRedactedError,
  signalOwnedProcess,
  waitLoopbackPortUnbound,
  withCleanupDeadline,
} from './helpers/process-liveness.mjs'
import {
  createInstallProcessOwnership,
  parseInstallProcessTable,
  retainedBackendIsAlive,
  retainedLauncherIsAlive,
} from './helpers/install-process-ownership.mjs'

const execFileAsync = promisify(execFile)
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const installScriptPath = fileURLToPath(import.meta.url)
const processLivenessPath = fileURLToPath(new URL('./helpers/process-liveness.mjs', import.meta.url))
const processOwnershipPath = fileURLToPath(new URL('./helpers/install-process-ownership.mjs', import.meta.url))
let wsEntryPath
let wsPackageRoot

const writeAtomic = async (path, content) => {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  await writeFile(temporary, content, { flag: 'wx', mode: 0o600 })
  await rename(temporary, path)
}

const fileIdentity = async path => ({ path, sha256: sha256(await readFile(path)) })

const treeIdentity = async (root, manifestPath) => {
  const records = []
  let fileCount = 0
  let symlinkCount = 0
  let totalFileBytes = 0
  const walk = async directory => {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const absolute = join(directory, entry.name)
      const name = relative(root, absolute).split(sep).join('/')
      const identity = await lstat(absolute)
      const mode = identity.mode & 0o7777
      if (identity.isSymbolicLink()) {
        symlinkCount += 1
        records.push(JSON.stringify({ type: 'link', path: name, mode, target: await readlink(absolute) }))
      } else if (identity.isDirectory()) {
        await walk(absolute)
      } else if (identity.isFile()) {
        const bytes = await readFile(absolute)
        fileCount += 1
        totalFileBytes += bytes.length
        records.push(JSON.stringify({ type: 'file', path: name, mode, size: bytes.length, sha256: sha256(bytes) }))
      } else {
        throw new Error(`unsupported installed-state entry: ${absolute}`)
      }
    }
  }
  await walk(root)
  records.sort()
  const manifest = records.join('\n') + '\n'
  if (manifestPath !== undefined) await writeAtomic(manifestPath, manifest)
  return {
    root,
    fileCount,
    symlinkCount,
    totalFileBytes,
    manifestPath,
    manifestRecordCount: records.length,
    manifestSha256: sha256(manifest),
  }
}

const summarizeFrame = frame => ({
  method: frame?.method,
  sessionId: frame?.payload?.sessionId,
  lastSeq: frame?.payload?.lastSeq,
  seq: frame?.payload?.event?.seq,
})

const executionEvidence = {
  schema: 'ark.install-e2e.execution.v2',
  startedAt: new Date().toISOString(),
  environment: {
    nodeVersion: process.version,
    platform: process.platform,
    architecture: process.arch,
  },
  checks: [],
  processRuns: [],
  status: 'RUNNING',
}
const record = (kind, detail = {}) => {
  executionEvidence.checks.push({ at: new Date().toISOString(), kind, ...detail })
}

const runtimeRoot = process.env.JIUZHANG_RUNTIME_ROOT
const appPath = process.env.ARK_APP_PATH
const receiptPath = process.env.ARK_INSTALL_E2E_RECEIPT
if (receiptPath !== undefined) {
  assert.ok(isAbsolute(receiptPath), 'ARK_INSTALL_E2E_RECEIPT must be an absolute path')
}
let node = process.execPath
let launcher = join(runtimeRoot ?? '', 'start.mjs')
let runner = join(
  runtimeRoot ?? '',
  'node_modules/@deepseek-ai/dsh-native-api-runner/lib/bin.js',
)
let resolvedRuntimeRoot = runtimeRoot
try {
  if (runtimeRoot === undefined && appPath === undefined) {
    throw new Error('install-e2e requires JIUZHANG_RUNTIME_ROOT or ARK_APP_PATH')
  }
  wsEntryPath = fileURLToPath(import.meta.resolve('ws'))
  wsPackageRoot = dirname(wsEntryPath)
  if (appPath !== undefined) {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const { stdout } = await promisify(execFile)('/usr/bin/plutil', ['-p', join(appPath, 'Contents/Info.plist')])
    const key = (name, { requireEmbedded = false } = {}) => {
      const match = stdout.match(new RegExp('"Jiuzhang' + name + '" => "([^"]*)"'))
      if (match === null) throw new Error('missing plist key Jiuzhang' + name)
      const value = match[1]
      if (requireEmbedded) {
        assert.match(value, /^Contents\/Resources\//, `Jiuzhang${name} must be embedded in Ark.app`)
      }
      return value.startsWith('Contents/') ? join(appPath, value) : value
    }
    node = key('NodeExecutable', { requireEmbedded: true })
    launcher = key('LauncherPath', { requireEmbedded: true })
    runner = key('RunnerPath', { requireEmbedded: true })
    resolvedRuntimeRoot = key('RuntimeRoot', { requireEmbedded: true })
  }
  assert.ok(resolvedRuntimeRoot !== undefined)
} catch (error) {
  executionEvidence.completedAt = new Date().toISOString()
  executionEvidence.status = 'FAIL'
  executionEvidence.failures = [serializeRedactedError(error)]
  if (receiptPath !== undefined) {
    await writeAtomic(receiptPath, `${JSON.stringify({
      schema: 'ark.install-e2e.receipt.v2',
      execution: executionEvidence,
    }, null, 2)}\n`)
  }
  throw new Error('install-e2e preflight failed; see the structured receipt')
}

const closureModule = join(resolvedRuntimeRoot, 'runtime-closure.mjs')
const closurePolicy = join(
  resolvedRuntimeRoot,
  'jiuzhang/profile/forbidden-runtime-packages.json',
)
const pluginInventoryDescriptor = join(
  resolvedRuntimeRoot,
  'node_modules/@deepseek-ai/dsh-host-plugin-inventory/lib/typert.host.js',
)
const manifestPathFor = (phase, name) => (
  receiptPath === undefined ? undefined : `${receiptPath}.${phase}.${name}.manifest.jsonl`
)
const captureExecutionIdentity = async phase => {
  const paths = {
    installScript: installScriptPath,
    processLiveness: processLivenessPath,
    processOwnership: processOwnershipPath,
    wsEntry: wsEntryPath,
    wsPackage: join(wsPackageRoot, 'package.json'),
    plutil: '/usr/bin/plutil',
    ps: '/bin/ps',
    lsof: '/usr/sbin/lsof',
    node,
    launcher,
    runner,
    closureModule,
    closurePolicy,
    pluginInventoryDescriptor,
    ...(appPath === undefined ? {} : {
      infoPlist: join(appPath, 'Contents/Info.plist'),
      mainBinary: join(appPath, 'Contents/MacOS/Ark'),
    }),
  }
  const files = {}
  for (const [name, path] of Object.entries(paths)) files[name] = await fileIdentity(path)
  return {
    files,
    wsPackageTree: await treeIdentity(wsPackageRoot, manifestPathFor(phase, 'ws-package')),
    runtimeTree: await treeIdentity(resolvedRuntimeRoot, manifestPathFor(phase, 'runtime')),
    ...(appPath === undefined ? {} : {
      appTree: await treeIdentity(appPath, manifestPathFor(phase, 'app')),
    }),
  }
}
const comparableExecutionIdentity = identity => {
  if (identity === undefined) return undefined
  const withoutManifestPath = tree => {
    const { manifestPath: _manifestPath, ...rest } = tree
    return rest
  }
  return {
    files: identity.files,
    wsPackageTree: withoutManifestPath(identity.wsPackageTree),
    runtimeTree: withoutManifestPath(identity.runtimeTree),
    ...(identity.appTree === undefined ? {} : { appTree: withoutManifestPath(identity.appTree) }),
  }
}
let inputIdentityBefore
let home
const apiToken = randomBytes(32).toString('base64url')
let pluginInventoryReceipt
const launch = () => {
  assert.ok(home !== undefined, 'isolated install home exists before launch')
  return spawn(node, [launcher, '--port', '0'], {
    env: {
      ...process.env,
      JIUZHANG_DSH_HOME: home,
      DSH_API_TOKEN: apiToken,
      ARK_SEED_OLLAMA: '1',
    },
  })
}

const waitForReadiness = child => new Promise((resolve, reject) => {
  let output = ''
  let diagnostics = ''
  let settled = false
  const cleanup = () => {
    clearTimeout(timer)
    child.stdout?.off('data', onStdout)
    child.stderr?.off('data', onStderr)
    child.off('exit', onExit)
    child.off('error', onError)
  }
  const finish = (callback, value) => {
    if (settled) return
    settled = true
    cleanup()
    callback(value)
  }
  const onStdout = (chunk) => {
    output += String(chunk)
    const match = output.match(/dsh native-api: (http:\/\/127\.0\.0\.1:\d+)/)
    if (match !== null) {
      finish(resolve, match[1])
    }
  }
  const onStderr = (chunk) => {
    diagnostics += String(chunk)
  }
  const onExit = code => finish(reject, new Error(
    'launcher exited early: ' + String(code)
      + (diagnostics.trim() === '' ? '' : '\n' + diagnostics.trim()),
  ))
  const onError = error => finish(reject, error)
  const timer = setTimeout(() => {
    finish(reject, new Error('readiness URL timeout'))
  }, 60_000)
  child.stdout?.on('data', onStdout)
  child.stderr?.on('data', onStderr)
  child.once('exit', onExit)
  child.once('error', onError)
})

const processTable = async () => {
  const { stdout } = await execFileAsync('/bin/ps', ['-ww', '-axo', 'pid=,ppid=,lstart=,args='], {
    timeout: 2_000,
    killSignal: 'SIGKILL',
  })
  return parseInstallProcessTable(stdout)
}
const processOwnership = createInstallProcessOwnership(processTable)

const listenerOwners = async baseURL => {
  const url = new URL(baseURL)
  assert.equal(url.hostname, '127.0.0.1', 'installed readiness must bind IPv4 loopback')
  const port = Number(url.port)
  assert.equal(Number.isSafeInteger(port) && port > 0, true, 'readiness URL has a concrete port')
  let stdout = ''
  try {
    ({ stdout } = await execFileAsync('/usr/sbin/lsof', [
      '-nP', `-iTCP:${String(port)}`, '-sTCP:LISTEN', '-Fpcn',
    ], { timeout: 2_000, killSignal: 'SIGKILL' }))
  } catch (error) {
    if (error?.code !== 1) throw error
  }
  const owners = []
  let current
  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) {
      if (current !== undefined) owners.push(current)
      current = { pid: Number(line.slice(1)), command: undefined, endpoints: [] }
    } else if (line.startsWith('c') && current !== undefined) {
      current.command = line.slice(1)
    } else if (line.startsWith('n') && current !== undefined) {
      current.endpoints.push(line.slice(1))
    }
  }
  if (current !== undefined) owners.push(current)
  return { port, owners }
}

const captureOwnedProcessState = async (ownedChild, baseURL, phase) => {
  const listener = await listenerOwners(baseURL)
  assert.equal(listener.owners.length, 1, `${phase} readiness has exactly one listener owner`)
  assert.ok(
    listener.owners[0].endpoints.includes(`127.0.0.1:${String(listener.port)}`),
    `${phase} readiness listener is bound to the captured IPv4 loopback port`,
  )
  const state = await withCleanupDeadline(`${phase} launcher ownership capture`, 2_500, async () => (
    processOwnership.capture(ownedChild, {
      launcherExecutable: node,
      launcherArgument: launcher,
      backendExecutable: node,
      backendArgument: runner,
      listenerPids: listener.owners.map(owner => owner.pid),
    })
  ))
  assert.equal(state.listenerBackends.length, 1, `${phase} binds one listener backend identity`)
  record('process-ownership', {
    phase,
    port: listener.port,
    listenerOwners: listener.owners,
    launcher: state.launcher,
    backends: state.backends,
    listenerBackends: state.listenerBackends,
  })
  executionEvidence.processRuns.push({
    phase,
    port: listener.port,
    listenerOwners: listener.owners,
    launcher: state.launcher,
    backends: state.backends,
  })
  return state
}

const processIdentityIsAlive = async (state, identity) => {
  return retainedBackendIsAlive(await processTable(), state, identity)
}

const waitIdentityDead = async (state, identity, timeoutMs) => {
  const deadline = Date.now() + timeoutMs
  while (await processIdentityIsAlive(state, identity)) {
    if (Date.now() >= deadline) return false
    await sleep(50)
  }
  return true
}

const signalBackendIdentity = async (state, identity, signal) => {
  if (!await processIdentityIsAlive(state, identity)) return
  const sent = signalOwnedProcess(identity.pid, signal)
  record('process-signal', { role: 'backend', pid: identity.pid, signal, sent })
}

const terminateBackendIdentity = async (state, identity) => {
  if (!await processIdentityIsAlive(state, identity)) return
  await signalBackendIdentity(state, identity, 'SIGTERM')
  if (await waitIdentityDead(state, identity, 2_000)) return
  await signalBackendIdentity(state, identity, 'SIGKILL')
  if (!await waitIdentityDead(state, identity, 2_000)) {
    throw new Error(`backend pid ${String(identity.pid)} survived identity-fenced cleanup`)
  }
}

const waitChildExit = async (child, signal) => {
  if (child.exitCode !== null || child.signalCode !== null) return true
  return await new Promise(resolve => {
    let settled = false
    const finish = value => {
      if (settled) return
      settled = true
      child.off('exit', onExit)
      signal?.removeEventListener('abort', onAbort)
      resolve(value)
    }
    const onExit = () => { finish(true) }
    const onAbort = () => { finish(false) }
    child.once('exit', onExit)
    if (signal?.aborted === true) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
    if (child.exitCode !== null || child.signalCode !== null) onExit()
  })
}

const stopOwnedLauncher = async (child, state) => {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (state?.launcher === undefined) {
    throw new Error('cannot stop launcher without its captured start and executable identity')
  }
  const failures = []
  let exited = false
  try {
    if (!retainedLauncherIsAlive(await processTable(), state)) {
      throw new Error(`launcher identity drifted before TERM: ${String(state.launcher.pid)}`)
    }
    const sent = signalOwnedProcess(state.launcher.pid, 'SIGTERM')
    record('process-signal', { role: 'launcher', pid: state.launcher.pid, signal: 'SIGTERM', sent })
    exited = await withCleanupDeadline('launcher TERM wait', 12_000, async signal => waitChildExit(child, signal))
  } catch (error) {
    failures.push(error)
  }
  if (!exited) {
    try {
      if (!retainedLauncherIsAlive(await processTable(), state)) {
        throw new Error(`launcher identity drifted before KILL: ${String(state.launcher.pid)}`)
      }
      const sent = signalOwnedProcess(state.launcher.pid, 'SIGKILL')
      record('process-signal', { role: 'launcher', pid: state.launcher.pid, signal: 'SIGKILL', sent })
    } catch (error) {
      failures.push(error)
    }
    try {
      exited = await withCleanupDeadline('launcher KILL wait', 2_000, async signal => waitChildExit(child, signal))
    } catch (error) {
      failures.push(error)
    }
  }
  if (!exited) failures.push(new Error(`launcher pid ${String(state.launcher.pid)} did not exit`))
  throwFailures('owned launcher cleanup', failures)
}

const throwFailures = (label, failures) => {
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, `${label}: primary and cleanup failures`)
}

const waitEndpointClosed = async (baseURL, timeoutMs) => {
  const port = Number(new URL(baseURL).port)
  const probe = await waitLoopbackPortUnbound(port, timeoutMs)
  const listener = await listenerOwners(baseURL)
  record('readiness-port-release', {
    port,
    released: probe.released,
    observations: probe.observations,
    remainingListenerOwners: listener.owners,
  })
  return probe.released && listener.owners.length === 0
}

const stopLauncher = async (child, baseURL) => {
  if (child === undefined) return
  const captureFailures = []
  let state = processOwnership.get(child)
  if (state === undefined && child.exitCode === null && child.signalCode === null) {
    try {
      state = await withCleanupDeadline('launcher ownership capture', 2_500, async () => (
        processOwnership.capture(child, {
          launcherExecutable: node,
          launcherArgument: launcher,
          backendExecutable: node,
          backendArgument: runner,
        })
      ))
    } catch (error) {
      captureFailures.push(error)
      state = processOwnership.get(child)
    }
  }
  if (state?.capturePromise !== undefined) {
    try {
      state = await withCleanupDeadline('retained launcher ownership capture', 2_500, async () => (
        state.capturePromise
      ))
    } catch (error) {
      captureFailures.push(error)
      state = processOwnership.get(child)
    }
  }
  return processOwnership.cleanup(child, async retained => {
    const steps = [
      {
        label: 'owned launcher stop',
        timeoutMs: 16_000,
        run: async () => { await stopOwnedLauncher(child, state) },
      },
      ...retained?.backends.map((backend, index) => ({
        label: `backend ${String(index)} identity cleanup`,
        timeoutMs: 5_000,
        run: async () => { await terminateBackendIdentity(retained, backend) },
      })) ?? [],
      ...(baseURL === undefined ? [] : [{
        label: 'readiness endpoint close',
        timeoutMs: 3_000,
        run: async () => {
          assert.equal(await waitEndpointClosed(baseURL, 2_000), true, 'the actual readiness port is released')
        },
      }]),
    ]
    if (baseURL !== undefined && retained?.captureError === undefined) {
      try {
        assert.ok(retained?.listenerBackends.length > 0, 'launcher owns the exact readiness listener child')
      } catch (error) {
        captureFailures.push(error)
      }
    }
    await runCleanupSteps('install-e2e launcher cleanup', captureFailures, steps)
  })
}

const observeFinalResiduals = async (ownedChild, baseURL) => {
  try {
    const rows = await processTable()
    const state = ownedChild === undefined ? undefined : processOwnership.get(ownedChild)
    const launcherAlive = state === undefined ? false : retainedLauncherIsAlive(rows, state)
    const capturedBackendSurvivors = state?.backends
      .filter(backend => retainedBackendIsAlive(rows, state, backend)) ?? []
    const exactExecutableResiduals = rows.filter(row => (
      row.executable === node
        && row.args.trim().split(/\s+/u).some(argument => argument === launcher || argument === runner)
    ))
    const listener = baseURL === undefined ? undefined : await listenerOwners(baseURL)
    const portProbe = listener === undefined ? undefined : await probeLoopbackPort(listener.port)
    const observation = {
      launcherAlive,
      capturedBackendSurvivors,
      exactExecutableResiduals,
      ...(listener === undefined ? {} : {
        port: listener.port,
        listenerOwners: listener.owners,
        portProbe,
      }),
    }
    record('final-residual-observation', observation)
    assert.equal(launcherAlive, false, 'captured launcher identity is gone after cleanup')
    assert.deepEqual(capturedBackendSurvivors, [], 'captured backend identities are gone after cleanup')
    assert.deepEqual(exactExecutableResiduals, [], 'no exact launcher or runner executable residual remains')
    if (listener !== undefined) {
      assert.deepEqual(listener.owners, [], 'the exact readiness port has no listener owner')
      assert.equal(portProbe.state, 'refused', 'the exact readiness port definitively refuses connections')
    }
  } catch (error) {
    record('final-residual-observation-error', {
      error: serializeRedactedError(error, {
        secrets: [apiToken, 'install-e2e-not-a-real-secret'],
        pathReplacements: home === undefined ? [] : [[home, '[ISOLATED_HOME]']],
      }),
    })
    throw error
  }
}

const downlinkURL = (baseURL, path) => baseURL.replace(/^http:/, 'ws:') + path

const openDownlink = (baseURL, path) => new Promise((resolve, reject) => {
  const socket = new WebSocket(downlinkURL(baseURL, path), {
    headers: { Authorization: 'Bearer ' + apiToken },
  })
  const frames = []
  const waiters = new Set()
  const fail = error => reject(error instanceof Error ? error : new Error(String(error)))
  socket.once('error', fail)
  socket.on('message', data => {
    const frame = JSON.parse(String(data))
    frames.push(frame)
    record('websocket-frame', { path, ...summarizeFrame(frame) })
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(frame)) continue
      clearTimeout(waiter.timer)
      waiters.delete(waiter)
      waiter.resolve(frame)
    }
  })
  socket.once('open', () => {
    socket.off('error', fail)
    record('websocket-open', { path })
    resolve({
      socket,
      waitFor(predicate, label, timeoutMs = 10_000) {
        const existing = frames.find(predicate)
        if (existing !== undefined) return Promise.resolve(existing)
        return new Promise((resolveFrame, rejectFrame) => {
          const waiter = {
            predicate,
            resolve: resolveFrame,
            timer: setTimeout(() => {
              waiters.delete(waiter)
              rejectFrame(new Error(`downlink frame timeout: ${label}`))
            }, timeoutMs),
          }
          waiters.add(waiter)
        })
      },
    })
  })
})

const waitDownlinkClosed = (downlink, signal) => new Promise(resolve => {
  if (downlink === undefined || downlink.socket.readyState === WebSocket.CLOSED) {
    resolve(true)
    return
  }
  let settled = false
  const finish = value => {
    if (settled) return
    settled = true
    downlink.socket.off('close', onClose)
    signal?.removeEventListener('abort', onAbort)
    resolve(value)
  }
  const onClose = () => { finish(true) }
  const onAbort = () => { finish(false) }
  downlink.socket.once('close', onClose)
  if (signal?.aborted === true) onAbort()
  else signal?.addEventListener('abort', onAbort, { once: true })
  if (downlink.socket.readyState === WebSocket.CLOSED) onClose()
})

const closeOwnedDownlink = async (downlink, label) => {
  if (downlink === undefined || downlink.socket.readyState === WebSocket.CLOSED) return
  downlink.socket.close(1000, 'installed acceptance complete')
  try {
    await withCleanupDeadline(`${label} close`, 2_000, async signal => waitDownlinkClosed(downlink, signal))
  } catch (primary) {
    const failures = [primary]
    try {
      downlink.socket.terminate()
    } catch (error) {
      failures.push(error)
    }
    try {
      await withCleanupDeadline(`${label} terminate`, 1_000, async signal => waitDownlinkClosed(downlink, signal))
    } catch (error) {
      failures.push(error)
    }
    if (failures.length === 1) throw failures[0]
    throw new AggregateError(failures, `${label}: close and terminate failures`)
  }
  record('websocket-close', { label, code: 1000 })
}

const expectUnauthenticatedUpgradeRejected = (baseURL, path) => new Promise((resolve, reject) => {
  const socket = new WebSocket(downlinkURL(baseURL, path))
  const timer = setTimeout(() => reject(new Error('unauthenticated upgrade rejection timeout')), 5_000)
  socket.once('unexpected-response', (_request, response) => {
    clearTimeout(timer)
    assert.equal(response.statusCode, 401)
    record('websocket-unauthenticated-rejected', { path, status: response.statusCode })
    response.resume()
    resolve()
  })
  socket.once('open', () => {
    clearTimeout(timer)
    socket.close()
    reject(new Error('unauthenticated WebSocket unexpectedly opened'))
  })
  socket.once('error', error => {
    clearTimeout(timer)
    reject(error)
  })
})

let child
let base
let muxDownlink
let hostDownlink
let hostLivenessSessionId
const testFailures = []
try {
  inputIdentityBefore = await captureExecutionIdentity('before')
  executionEvidence.inputIdentityBefore = inputIdentityBefore
  const { assertArkRuntimeClosure } = await import(pathToFileURL(closureModule).href)
  const closureResult = await assertArkRuntimeClosure(resolvedRuntimeRoot, closurePolicy)
  record('runtime-closure', { packageCount: closureResult.packageCount })
  assert.match(runner, /\/node_modules\/@deepseek-ai\/dsh-native-api-runner\/lib\/bin\.js$/)
  home = await mkdtemp(join(tmpdir(), 'ark-install-e2e-'))
  child = launch()
  base = await waitForReadiness(child)
  record('readiness', { phase: 'initial', baseURL: base, port: Number(new URL(base).port) })
  await captureOwnedProcessState(child, base, 'initial')

  const rpcResult = async (method, payload = {}) => {
    const rpcId = `install-e2e-${method}`
    const response = await fetch(base + '/api/' + method, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + apiToken },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
    })
    assert.equal(response.status, 200, method + ' must be reachable through the app-owned Bearer token')
    const envelope = await response.json()
    assert.equal(envelope.type, 'server-response')
    assert.equal(envelope.rpcId, rpcId)
    record('rpc-response', {
      method,
      status: response.status,
      envelopeType: envelope.type,
      rpcIdMatched: true,
      carrierOk: envelope.result?.ok,
    })
    return envelope.result
  }
  const remoteResult = async (method, args = {}) => {
    const carrier = await rpcResult(method, { args })
    assert.equal(carrier?.ok, true, method + ' must return a successful Host carrier result')
    return carrier.value
  }
  const remote = async (method, args = {}) => {
    const result = await remoteResult(method, args)
    assert.equal(
      result?.ok,
      true,
      method + ' must return a successful RemoteResult: ' + JSON.stringify(result?.error ?? null),
    )
    const value = result.value
    if (typeof value === 'object' && value !== null && typeof value.ok === 'boolean'
      && ('value' in value || 'error' in value)) {
      assert.equal(
        value.ok,
        true,
        method + ' must return a successful domain RemoteResult: ' + JSON.stringify(value.error ?? null),
      )
      record('remote-result', { method, hostOk: true, domainLayer: true, domainOk: true })
      return value.value
    }
    record('remote-result', { method, hostOk: true, domainLayer: false })
    return value
  }

  const root = await fetch(base + '/')
  assert.equal(root.status, 200)
  assert.deepEqual(await root.json(), { service: 'Planet API', status: 'running' })
  record('http-response', { name: 'api-root', status: root.status, shape: 'Planet API/running' })
  const index = await fetch(base + '/index.html')
  assert.equal(index.status, 404, 'API-only mode exposes no browser product entry')
  record('http-response', { name: 'index-html', status: index.status })
  const unauthenticatedInventory = await fetch(base + '/api/pluginInventory/list', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: 'install-e2e-plugin-inventory-no-token',
      method: 'pluginInventory/list',
      payload: { args: {} },
    }),
  })
  assert.equal(unauthenticatedInventory.status, 401, 'plugin inventory stays behind the app-owned Bearer token')
  record('http-response', { name: 'plugin-inventory-unauthenticated', status: unauthenticatedInventory.status })
  const unknownRoute = await fetch(base + '/api/unknown/route', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + apiToken },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: 'install-e2e-unknown-route',
      method: 'unknown/route',
      payload: { args: {} },
    }),
  })
  assert.equal(unknownRoute.status, 404, 'unknown API routes remain carrier 404s')
  record('http-response', { name: 'unknown-route', status: unknownRoute.status })

  const rpcId = 'install-e2e-settings'
  const body = JSON.stringify({
    type: 'client-request',
    rpcId,
    method: 'settings/describe',
    payload: { args: {} },
  })
  const bare = await fetch(base + '/api/settings/describe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  })
  assert.equal(bare.status, 401)
  record('http-response', { name: 'settings-unauthenticated', status: bare.status })
  const authed = await fetch(base + '/api/settings/describe', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + apiToken },
    body,
  })
  assert.equal(authed.status, 200, 'the app-owned Bearer token admits the settings API')
  const envelope = await authed.json()
  assert.equal(envelope.type, 'server-response')
  assert.equal(envelope.rpcId, rpcId)
  assert.equal(envelope.result?.ok, true)
  assert.equal(envelope.result?.value?.ok, true)
  record('http-response', {
    name: 'settings-authenticated',
    status: authed.status,
    envelopeType: envelope.type,
    carrierOk: envelope.result?.ok,
    remoteOk: envelope.result?.value?.ok,
  })
  const retiredDotRoute = await fetch(base + '/api/settings.describe', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + apiToken },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: 'install-e2e-retired-settings-dot-route',
      method: 'settings.describe',
      payload: {},
    }),
  })
  assert.equal(retiredDotRoute.status, 404, 'retired dot RPC routes cannot re-enter the installed API')
  record('http-response', { name: 'retired-settings-dot-route', status: retiredDotRoute.status })
  await expectUnauthenticatedUpgradeRejected(base, '/api/events/mux')
  await expectUnauthenticatedUpgradeRejected(base, '/api/events/host')

  const providers = await remote('llm/providers')
  assert.ok(Array.isArray(providers.providers), 'native Settings receives the real Provider directory')
  const presets = await remote('agentPreset/list')
  assert.ok(Array.isArray(presets.presets), 'native Settings receives the real Agent preset roster')
  assert.equal(presets.authorable, true, 'installed Ark exposes one user-owned preset root')
  const sourcePreset = presets.presets.find(preset => preset.id === 'standard' && preset.broken === undefined)
    ?? presets.presets.find(preset => preset.broken === undefined)
  assert.equal(typeof sourcePreset?.id, 'string', 'installed Ark exposes a healthy preset to copy')
  const copiedPresetId = 'install-e2e-preset'
  await remote('agentPreset/copy', {
    from: sourcePreset.id,
    agentPreset: copiedPresetId,
    name: 'Install E2E Preset',
  })
  let authoredRoster = await remote('agentPreset/list')
  assert.ok(authoredRoster.presets.some(preset => (
    preset.id === copiedPresetId && preset.trust === 'user'
  )))
  const copiedPreset = await remote('agentPreset/read', { agentPreset: copiedPresetId })
  assert.equal(copiedPreset.agentPreset, copiedPresetId)
  assert.equal(copiedPreset.trust, 'user')
  assert.equal(typeof copiedPreset.content, 'string')
  const plugins = await remote('pluginInventory/list')
  assert.ok(Array.isArray(plugins.entries), 'native Settings receives the real plugin inventory')
  assert.ok(plugins.entries.length > 0, 'the built Native runtime returns non-empty plugin inventory entries')
  assert.ok(
    plugins.entries.some(entry => entry.moduleName === '@deepseek-ai/dsh-host-plugin-inventory'),
    'the built Native runtime registers the Host plugin inventory owner itself',
  )
  const settingsDirectory = await remote('settings/describe')
  const transactionalProvider = providers.providers.find(provider => provider.provider === 'deepseek-official')
    ?? providers.providers.find(provider => provider.settingsNs !== '')
  assert.equal(typeof transactionalProvider?.provider, 'string', 'installed Ark exposes a configurable provider')
  const providerSettings = settingsDirectory.namespaces.find(
    namespace => namespace.ns === transactionalProvider.settingsNs,
  )
  assert.equal(typeof providerSettings?.revision, 'number', 'configurable provider owns a settings namespace')
  const providerRefPath = [...transactionalProvider.settingsPath, 'apiKeyEnv']
  const pathEntry = (root, path) => {
    let current = root
    for (const part of path) {
      if (typeof current !== 'object' || current === null || Array.isArray(current)
        || !Object.prototype.hasOwnProperty.call(current, part)) return { present: false }
      current = current[part]
    }
    return { present: true, value: current }
  }
  const originalProviderRef = pathEntry(providerSettings.user, providerRefPath)
  const testCredentialRef = 'ARK_INSTALL_E2E_PROVIDER_KEY'
  const committedProvider = await remote('llm/mutateProvider', { request: {
    transactionId: '11111111-1111-4111-8111-111111111111',
    provider: transactionalProvider.provider,
    settingsNs: transactionalProvider.settingsNs,
    ops: [{ op: 'set', path: providerRefPath, value: testCredentialRef }],
    expectedRevision: providerSettings.revision,
    credential: { op: 'set', ref: testCredentialRef, value: 'install-e2e-not-a-real-secret' },
  } })
  assert.equal(pathEntry(committedProvider.settings.user, providerRefPath).value, testCredentialRef)
  assert.equal(committedProvider.credential.configured, true)
  assert.doesNotMatch(JSON.stringify(committedProvider), /install-e2e-not-a-real-secret/)
  const credentialDocument = await readFile(join(home, '.credentials.yaml'), 'utf8')
  assert.doesNotMatch(
    credentialDocument,
    /install-e2e-not-a-real-secret/,
    'the packaged Provider journal must never persist credential material',
  )
  const configuredTestCredential = await remote('credentials/describe', { refs: [testCredentialRef] })
  assert.equal(configuredTestCredential.credentials[testCredentialRef].configured, true)
  const restoredProvider = await remote('llm/mutateProvider', { request: {
    transactionId: '22222222-2222-4222-8222-222222222222',
    provider: transactionalProvider.provider,
    settingsNs: transactionalProvider.settingsNs,
    ops: originalProviderRef.present
      ? [{ op: 'set', path: providerRefPath, value: originalProviderRef.value }]
      : [{ op: 'unset', path: providerRefPath }],
    expectedRevision: committedProvider.settings.revision,
    credential: { op: 'unset', ref: testCredentialRef },
  } })
  assert.deepEqual(pathEntry(restoredProvider.settings.user, providerRefPath), originalProviderRef)
  assert.equal(restoredProvider.credential.configured, false)
  const shellSettings = settingsDirectory.namespaces.find(namespace => namespace.ns === 'shell')
  assert.equal(typeof shellSettings?.revision, 'number')
  const previousGraceMs = shellSettings.user?.graceMs
  const committedShell = await remote('settings/mutate', {
    ns: 'shell',
    ops: [{ op: 'set', path: ['graceMs'], value: 2_501 }],
    expectedRevision: shellSettings.revision,
  })
  assert.equal(committedShell.value.graceMs, 2_501)
  const staleShell = await remoteResult('settings/mutate', {
    ns: 'shell',
    ops: [{ op: 'set', path: ['graceMs'], value: 2_502 }],
    expectedRevision: shellSettings.revision,
  })
  assert.equal(staleShell.ok, false)
  assert.equal(staleShell.error.code, 'settings-conflict')
  assert.deepEqual(staleShell.error.details, {
    ns: 'shell',
    expected: shellSettings.revision,
    actual: committedShell.revision,
  })
  record('expected-domain-failure', { method: 'settings/mutate', code: staleShell.error.code })
  const afterConflict = await remote('settings/describe')
  const currentShell = afterConflict.namespaces.find(namespace => namespace.ns === 'shell')
  assert.equal(currentShell.value.graceMs, 2_501, 'stale extension mutation changes nothing')
  await remote('settings/mutate', {
    ns: 'shell',
    ops: previousGraceMs === undefined
      ? [{ op: 'unset', path: ['graceMs'] }]
      : [{ op: 'set', path: ['graceMs'], value: previousGraceMs }],
    expectedRevision: currentShell.revision,
  })
  const refreshedPlugins = await remote('pluginInventory/list')
  assert.deepEqual(
    refreshedPlugins.entries.map(entry => entry.entryId).sort(),
    plugins.entries.map(entry => entry.entryId).sort(),
    'extension inventory refresh preserves the Host-owned entry set after mutation and conflict reload',
  )
  pluginInventoryReceipt = {
    method: 'pluginInventory/list',
    runtimeRoot: resolvedRuntimeRoot,
    runner,
    runnerSha256: sha256(await readFile(runner)),
    descriptor: pluginInventoryDescriptor,
    descriptorSha256: sha256(await readFile(pluginInventoryDescriptor)),
    entryCount: refreshedPlugins.entries.length,
    entrySha256: sha256(JSON.stringify(refreshedPlugins.entries)),
    entries: refreshedPlugins.entries,
  }

  const workspacePath = join(home, 'fixture-workspace')
  await mkdir(workspacePath)
  muxDownlink = await openDownlink(base, '/api/events/mux')
  hostDownlink = await openDownlink(base, '/api/events/host')
  const createdWorkspace = await remote('workspace/create', { request: { path: workspacePath } })
  const workspaceId = createdWorkspace.workspace?.workspaceId
  assert.equal(
    typeof workspaceId,
    'string',
    'workspace/create returned an unexpected value: ' + JSON.stringify(createdWorkspace),
  )
  const createdSession = await remote('session/create', { request: {
    workspaceId,
    agentPreset: copiedPresetId,
  } })
  const sessionId = createdSession.sessionId
  assert.equal(typeof sessionId, 'string')
  const subscribed = await muxDownlink.waitFor(
    frame => frame.method === 'session/subscribed' && frame.payload?.sessionId === sessionId,
    'mux session/subscribed',
  )
  const initialLastSeq = subscribed.payload.lastSeq
  assert.equal(Number.isSafeInteger(initialLastSeq) && initialLastSeq >= -1, true)
  const initialHistory = await remote('session/history', {
    request: { sessionId, maxMessages: 50 },
  })
  assert.equal(
    initialHistory.events.at(-1)?.event.seq ?? -1,
    initialLastSeq,
    'subscription baseline matches the exact initialized session history cut',
  )
  await hostDownlink.waitFor(
    frame => frame.method === 'host/session-added' && frame.payload?.sessionId === sessionId,
    'host session-added',
  )

  await closeOwnedDownlink(muxDownlink, 'mux reconnect downlink')
  assert.equal(hostDownlink.socket.readyState, WebSocket.OPEN, 'mux-only disconnect keeps host downlink open')
  const hostLivenessSession = await remote('session/create', { request: {
    workspaceId,
    agentPreset: sourcePreset.id,
  } })
  hostLivenessSessionId = hostLivenessSession.sessionId
  assert.equal(typeof hostLivenessSessionId, 'string')
  await hostDownlink.waitFor(
    frame => frame.method === 'host/session-added' && frame.payload?.sessionId === hostLivenessSessionId,
    'host remains live after mux-only disconnect',
  )
  await remote('agentPreset/select', { agentId: sessionId, agentPreset: sourcePreset.id })
  const advancedHistory = await remote('session/history', {
    request: { sessionId, maxMessages: 50 },
  })
  const advancedLastSeq = advancedHistory.events.at(-1)?.event.seq ?? -1
  assert.ok(advancedLastSeq > initialLastSeq, 'session history advances while mux is disconnected')
  record('mux-disconnected-history-advanced', {
    sessionId,
    initialLastSeq,
    advancedLastSeq,
    hostLivenessSessionId,
  })
  muxDownlink = await openDownlink(base, '/api/events/mux')
  const reconnected = await muxDownlink.waitFor(
    frame => frame.method === 'session/subscribed' && frame.payload?.sessionId === sessionId,
    'mux reconnect subscription baseline',
  )
  assert.equal(reconnected.payload.lastSeq, advancedLastSeq)
  record('mux-reconnect-catch-up', {
    sessionId,
    initialLastSeq,
    advancedLastSeq,
    reconnectLastSeq: reconnected.payload.lastSeq,
  })
  await remote('agentPreset/remove', { agentPreset: copiedPresetId })
  authoredRoster = await remote('agentPreset/list')
  assert.ok(!authoredRoster.presets.some(preset => preset.id === copiedPresetId))
  let livenessArchive = await remote('workspace/archiveSession', {
    request: { sessionId: hostLivenessSessionId },
  })
  assert.ok(livenessArchive.archivedSessionIds.includes(hostLivenessSessionId))
  const livenessDeleted = await remote('workspace/deleteArchivedSession', {
    request: { sessionId: hostLivenessSessionId },
  })
  assert.equal(livenessDeleted.deleted, true)
  hostLivenessSessionId = undefined
  let archiveState = await remote('workspace/archiveSession', { request: { sessionId } })
  assert.ok(archiveState.archivedSessionIds.includes(sessionId))
  await closeOwnedDownlink(muxDownlink, 'pre-restart mux downlink')
  await closeOwnedDownlink(hostDownlink, 'pre-restart host downlink')
  muxDownlink = undefined
  hostDownlink = undefined
  await stopLauncher(child, base)
  child = launch()
  base = await waitForReadiness(child)
  record('readiness', { phase: 'restart', baseURL: base, port: Number(new URL(base).port) })
  await captureOwnedProcessState(child, base, 'restart')
  const restartedWorkspace = await remote('workspace/list')
  assert.ok(
    restartedWorkspace.archivedSessionIds.includes(sessionId),
    'archive state survives a clean Host restart before restore',
  )
  record('restart-persistence', { sessionId, archivedAfterRestart: true })
  archiveState = await remote('workspace/unarchiveSession', { request: { sessionId } })
  assert.ok(!archiveState.archivedSessionIds.includes(sessionId))
  archiveState = await remote('workspace/archiveSession', { request: { sessionId } })
  assert.ok(archiveState.archivedSessionIds.includes(sessionId))
  const deleted = await remote('workspace/deleteArchivedSession', { request: { sessionId } })
  assert.equal(deleted.deleted, true)
  assert.ok(!deleted.archivedSessionIds.includes(sessionId))
  const sessions = await remote('session/list', { request: {} })
  assert.ok(!sessions.items.some(item => item.sessionId === sessionId), 'permanent delete removes the retained log')

  const settings = await readFile(join(home, 'settings.yaml'), 'utf8')
  assert.match(settings, /^llm-pi-ai:/m)
  assert.match(settings, /127\.0\.0\.1:11434/)
} catch (error) {
  testFailures.push(error)
}
try {
  await runCleanupSteps('install-e2e cleanup', [], [
    { label: 'mux downlink cleanup', timeoutMs: 4_000, run: async () => { await closeOwnedDownlink(muxDownlink, 'mux downlink') } },
    { label: 'host downlink cleanup', timeoutMs: 4_000, run: async () => { await closeOwnedDownlink(hostDownlink, 'host downlink') } },
    { label: 'launcher cleanup', timeoutMs: 60_000, run: async () => { await stopLauncher(child, base) } },
    { label: 'final residual observation', timeoutMs: 5_000, run: async () => { await observeFinalResiduals(child, base) } },
    {
      label: 'install home cleanup',
      timeoutMs: 5_000,
      run: async () => {
        if (home !== undefined) await rm(home, { recursive: true, force: true })
      },
    },
  ])
} catch (error) {
  testFailures.push(error)
}

try {
  executionEvidence.inputIdentityAfter = await captureExecutionIdentity('after')
  assert.deepEqual(
    comparableExecutionIdentity(executionEvidence.inputIdentityAfter),
    comparableExecutionIdentity(inputIdentityBefore),
    'installed-state execution-defining bytes remain unchanged',
  )
  record('execution-input-identity', {
    unchanged: true,
    appTreeManifestSha256: executionEvidence.inputIdentityAfter.appTree?.manifestSha256,
    runtimeTreeManifestSha256: executionEvidence.inputIdentityAfter.runtimeTree.manifestSha256,
  })
} catch (error) {
  testFailures.push(error)
}

executionEvidence.completedAt = new Date().toISOString()
executionEvidence.status = testFailures.length === 0 ? 'PASS' : 'FAIL'
executionEvidence.failures = testFailures.map(error => serializeRedactedError(error, {
  secrets: [apiToken, 'install-e2e-not-a-real-secret'],
  pathReplacements: home === undefined ? [] : [[home, '[ISOLATED_HOME]']],
}))

if (receiptPath !== undefined) {
  const receipt = {
    schema: 'ark.install-e2e.receipt.v2',
    ...(pluginInventoryReceipt ?? {}),
    pluginInventory: pluginInventoryReceipt,
    execution: executionEvidence,
  }
  await writeAtomic(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`)
}

if (testFailures.length > 0) {
  console.error(`install-e2e: acceptance failed (${String(testFailures.length)} recorded failure groups); see the structured receipt`)
  process.exitCode = 1
} else {
  console.log('install-e2e: Ark installed state accepted')
}
