import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdirSync, readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import {
  CleanupTimeoutError,
  probeLoopbackPort,
  processIsAlive as isAlive,
  runCleanupSteps,
  sameProcessIdentity,
  serializeRedactedError,
  signalExactProcessIdentity,
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

const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const startMjs = join(root, 'integrations/jiuzhang/src/start.mjs')
const backendProcessSwift = join(
  root,
  'integrations/jiuzhang/native/Sources/JiuzhangShellCore/BackendProcess.swift',
)
const execFileAsync = promisify(execFile)

/** A dummy child that records its pid and exits cleanly on TERM.
 * 配置走 argv（launcher 会透传非自有参数），因为 backend 的 launch env
 * 是白名单式构造，测试私有 env 变量到不了 child。 */
const longLivedChild = `
import { appendFileSync, writeFileSync } from 'node:fs'
const valueOf = prefix => {
  const arg = process.argv.find(entry => entry.startsWith(prefix))
  return arg === undefined ? undefined : arg.slice(prefix.length)
}
writeFileSync(valueOf('--child-pid-file='), String(process.pid))
process.on('SIGTERM', () => {
  const termLog = valueOf('--term-log=')
  if (termLog) appendFileSync(termLog, 'term\\n')
  process.exit(0)
})
setInterval(() => {}, 1000)
`

/** A backend that records ownership but deliberately ignores TERM, exercising
 * the launcher's bounded KILL path rather than the test cleanup fallback. */
const stubbornChild = `
import { writeFileSync } from 'node:fs'
const pidFile = process.argv.find(entry => entry.startsWith('--child-pid-file='))?.split('=')[1]
writeFileSync(pidFile, String(process.pid))
process.on('SIGTERM', () => {})
setInterval(() => {}, 1000)
`

/** A dummy parent that spawns the launcher with its own pid, records the
 * launcher pid, and sleeps until killed. */
const dummyParent = `
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
const argv = JSON.parse(process.env.LAUNCH_ARGV)
const launcher = spawn(process.execPath, [...argv, '--parent-pid', String(process.pid)], {
  stdio: 'ignore',
  env: process.env,
})
writeFileSync(process.env.LAUNCHER_PID_FILE, String(launcher.pid))
setInterval(() => {}, 1000)
`

const nativeDataEnvironment = home => {
  const workspace = join(home, 'Default Workspace')
  mkdirSync(workspace, { recursive: true, mode: 0o700 })
  return {
    DSH_HOME: home,
    ARK_MAIN_ROOT: join(home, 'Knowledge'),
    ARK_WIKI_ROOT: join(home, 'Knowledge/wiki'),
    ARK_DEFAULT_WORKSPACE: workspace,
  }
}

const launch = (
  home,
  { parentPid, childScript, extraEnv = {}, childArgs = [] } = {},
) => {
  const argv = [startMjs, '--port', '0']
  if (parentPid !== undefined) {
    argv.push('--parent-pid', String(parentPid))
  }
  argv.push(...childArgs)

  return spawn(process.execPath, argv, {
    env: {
      ...process.env,
      ...nativeDataEnvironment(home),
      JIUZHANG_DSH_HOME: home,
      JIUZHANG_LAUNCHER_CHILD: childScript,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

const spawnDummyParent = (
  home,
  { childScript, launcherPidFile, extraEnv = {}, childArgs = [] },
) => {
  const parentPath = join(home, 'parent.mjs')

  return spawn(process.execPath, [parentPath], {
    env: {
      ...process.env,
      ...nativeDataEnvironment(home),
      JIUZHANG_DSH_HOME: home,
      JIUZHANG_LAUNCHER_CHILD: childScript,
      LAUNCHER_PID_FILE: launcherPidFile,
      LAUNCH_ARGV: JSON.stringify([
        startMjs,
        '--port', '0',
        ...childArgs,
      ]),
      ...extraEnv,
    },
    stdio: 'ignore',
  })
}

const waitExit = async (proc, timeoutMs) => {
  const deadline = Date.now() + timeoutMs
  while (proc.exitCode === null && proc.signalCode === null) {
    if (Date.now() > deadline) return false
    await sleep(100)
  }
  return true
}

const waitFile = async (path, timeoutMs) => {
  const deadline = Date.now() + timeoutMs
  while (true) {
    try {
      return await readFile(path, 'utf8')
    } catch {
      if (Date.now() > deadline) return null
      await sleep(100)
    }
  }
}

const runCleanups = async (label, cleanups) => {
  await runCleanupSteps(label, [], cleanups.map((run, index) => ({
    label: `${label} step ${String(index + 1)}`,
    timeoutMs: 8_000,
    run,
  })))
}

const readProcessTable = async () => {
  const { stdout } = await execFileAsync(
    '/bin/ps',
    ['-ww', '-axo', 'pid=,ppid=,lstart=,args='],
    { maxBuffer: 16_000_000 },
  )
  return parseInstallProcessTable(stdout)
}

const captureTestIdentity = async (pid, { executable = process.execPath, argument } = {}) => {
  const identity = (await readProcessTable()).find(row => row.pid === pid)
  assert.ok(identity, `test process ${String(pid)} exposes a start identity`)
  assert.equal(identity.executable, executable, `test process ${String(pid)} executable matches`)
  if (argument !== undefined) {
    assert.ok(
      identity.args.trim().split(/\s+/u).includes(argument),
      `test process ${String(pid)} argv contains ${argument}`,
    )
  }
  return identity
}

const exactIdentityIsAlive = async identity => (
  (await readProcessTable()).some(row => sameProcessIdentity(row, identity))
)

const waitIdentityDead = async (identity, timeoutMs) => {
  const deadline = Date.now() + timeoutMs
  while (await exactIdentityIsAlive(identity)) {
    if (Date.now() > deadline) return false
    await sleep(100)
  }
  return true
}

/** Cleanup may signal only an identity retained before the failure path. */
const terminateTestIdentity = async identity => {
  if (identity === null || identity === undefined) return
  let rows = await readProcessTable()
  if (!signalExactProcessIdentity(identity, rows, 'SIGTERM')) return
  if (await waitIdentityDead(identity, 2_000)) return
  rows = await readProcessTable()
  if (!signalExactProcessIdentity(identity, rows, 'SIGKILL')) return
  if (!await waitIdentityDead(identity, 2_000)) {
    throw new Error(`test identity ${String(identity.pid)} survived SIGKILL cleanup`)
  }
}

const terminateTestHandle = async child => {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  if (await waitExit(child, 2_000)) return
  child.kill('SIGKILL')
  if (!await waitExit(child, 2_000)) {
    throw new Error(`test child handle ${String(child.pid)} survived SIGKILL cleanup`)
  }
}

const writeScript = async (home, name, body) => {
  const path = join(home, name)
  await writeFile(path, body)
  return path
}

test('lifecycle: PID helpers reject sentinels and distinguish ESRCH from EPERM without OS signals', () => {
  const calls = []
  const alive = (pid, signal) => {
    calls.push([pid, signal])
    return true
  }
  for (const invalid of [undefined, null, 0, 1, -1, Number.NaN, Number.POSITIVE_INFINITY, 2.5]) {
    assert.equal(isAlive(invalid, alive), false)
  }
  assert.deepEqual(calls, [], 'invalid PID values never reach the signal boundary')

  const esrch = Object.assign(new Error('gone'), { code: 'ESRCH' })
  assert.equal(isAlive(42, (pid, signal) => {
    calls.push([pid, signal])
    throw esrch
  }), false)

  const eperm = Object.assign(new Error('denied'), { code: 'EPERM' })
  assert.throws(() => isAlive(43, (pid, signal) => {
    calls.push([pid, signal])
    throw eperm
  }), error => error === eperm)
  assert.deepEqual(calls, [[42, 0], [43, 0]])

  assert.equal(signalOwnedProcess(44, 'SIGTERM', (pid, signal) => {
    calls.push([pid, signal])
    throw esrch
  }), false)
  assert.throws(() => signalOwnedProcess(45, 'SIGKILL', (pid, signal) => {
    calls.push([pid, signal])
    throw eperm
  }), error => error === eperm)
  assert.throws(() => signalOwnedProcess(0, 'SIGKILL', alive), /unsafe test pid/)
  assert.deepEqual(calls, [[42, 0], [43, 0], [44, 'SIGTERM'], [45, 'SIGKILL']])
})

test('lifecycle: cleanup signals only a retained exact start/executable/argv identity', () => {
  const expected = {
    pid: 91,
    parentPid: 12,
    started: 'Thu Sep  4 12:50:46 2026',
    executable: '/runtime/node',
    args: '/runtime/node /runtime/start.mjs --port 0',
  }
  const signals = []
  assert.equal(signalExactProcessIdentity(
    expected,
    [expected],
    'SIGTERM',
    (pid, signal) => { signals.push([pid, signal]) },
  ), true)
  assert.throws(() => signalExactProcessIdentity(
    expected,
    [{ ...expected, started: 'Thu Sep  4 12:55:00 2026' }],
    'SIGKILL',
    (pid, signal) => { signals.push([pid, signal]) },
  ), /refusing to signal reused or changed pid/)
  assert.equal(signalExactProcessIdentity(expected, [], 'SIGKILL'), false)
  assert.deepEqual(signals, [[91, 'SIGTERM']])
})

test('lifecycle: cleanup runner attempts every task and preserves failure order', async () => {
  const order = []
  const first = new Error('first cleanup failed')
  const third = new Error('third cleanup failed')
  await assert.rejects(runCleanups('contract', [
    () => { order.push('first'); throw first },
    () => { order.push('second') },
    () => { order.push('third'); throw third },
  ]), error => (
    error instanceof AggregateError
      && error.errors[0] === first
      && error.errors[1] === third
  ))
  assert.deepEqual(order, ['first', 'second', 'third'])
})

test('lifecycle: exact loopback release accepts only ECONNREFUSED', async () => {
  const refusedSocket = new EventEmitter()
  refusedSocket.destroy = () => {}
  refusedSocket.setTimeout = () => {}
  const refused = probeLoopbackPort(49_268, () => {
    queueMicrotask(() => {
      refusedSocket.emit('error', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }))
    })
    return refusedSocket
  })
  assert.deepEqual(await refused, { state: 'refused', code: 'ECONNREFUSED' })
  await assert.rejects(probeLoopbackPort(0), /invalid loopback port/)

  let clock = 0
  const observations = [
    { state: 'listening' },
    { state: 'timeout' },
    { state: 'refused', code: 'ECONNREFUSED' },
  ]
  const released = await waitLoopbackPortUnbound(49_268, 200, {
    probe: async () => observations.shift(),
    now: () => clock,
    delay: async milliseconds => { clock += milliseconds },
  })
  assert.equal(released.released, true)
  assert.deepEqual(released.observations.map(item => item.state), ['listening', 'timeout', 'refused'])

  await assert.rejects(waitLoopbackPortUnbound(49_268, 200, {
    probe: async () => ({ state: 'error', code: 'EPERM' }),
    now: () => clock,
    delay: async () => {},
  }), /probe failed: EPERM/)
})

test('lifecycle: failure evidence preserves aggregate shape without secrets', () => {
  const secret = 'sentinel-install-secret'
  const nested = Object.assign(new Error(`credential=${secret} ${JSON.stringify({ token: secret })}`), {
    code: 'fixture-secret',
  })
  const serialized = serializeRedactedError(
    new AggregateError([new Error(`Bearer ${secret}`), nested], `outer ${secret}`),
    { secrets: [secret], pathReplacements: [['/tmp/private-home', '[ISOLATED_HOME]']] },
  )
  const text = JSON.stringify(serialized)
  assert.doesNotMatch(text, /sentinel-install-secret/)
  assert.match(text, /\[REDACTED\]/)
  assert.equal(serialized.causes.length, 2)
  assert.equal(serialized.causes[1].code, 'fixture-secret')
})

test('lifecycle: deadline cleanup preserves [primary, timeout, later failure] and continues', async () => {
  const primary = new Error('primary failed')
  const later = new Error('later cleanup failed')
  const order = []
  await assert.rejects(runCleanupSteps('deadline contract', [primary], [
    {
      label: 'never-settling first cleanup',
      timeoutMs: 20,
      run: () => new Promise(() => {}),
    },
    {
      label: 'later cleanup',
      timeoutMs: 20,
      run: () => { order.push('later'); throw later },
    },
  ]), error => (
    error instanceof AggregateError
      && error.errors[0] === primary
      && error.errors[1] instanceof CleanupTimeoutError
      && error.errors[2] === later
  ))
  assert.deepEqual(order, ['later'])
})

test('lifecycle: deadline abort detaches the losing operation listener', async () => {
  const emitter = new EventEmitter()
  let observedAbort = false
  await assert.rejects(withCleanupDeadline('listener detach', 20, signal => new Promise(resolve => {
    const onExit = () => { resolve(true) }
    const onAbort = () => {
      observedAbort = true
      emitter.off('exit', onExit)
      resolve(false)
    }
    emitter.once('exit', onExit)
    signal.addEventListener('abort', onAbort, { once: true })
  })), error => error instanceof CleanupTimeoutError)
  assert.equal(observedAbort, true)
  assert.equal(emitter.listenerCount('exit'), 0)
})

test('lifecycle: macOS process rows retain start and executable identity', () => {
  assert.deepEqual(parseInstallProcessTable([
    '  28468     1 Thu Sep  4 12:50:46 2026 /candidate/Ark.app/Contents/Resources/node/bin/node /runtime/start.mjs',
    '  28478 28468 Thu Sep  4 12:50:47 2026 /candidate/Ark.app/Contents/Resources/node/bin/node /runtime/runner.js',
    '',
  ].join('\n')), [
    {
      pid: 28468,
      parentPid: 1,
      started: 'Thu Sep  4 12:50:46 2026',
      executable: '/candidate/Ark.app/Contents/Resources/node/bin/node',
      args: '/candidate/Ark.app/Contents/Resources/node/bin/node /runtime/start.mjs',
    },
    {
      pid: 28478,
      parentPid: 28468,
      started: 'Thu Sep  4 12:50:47 2026',
      executable: '/candidate/Ark.app/Contents/Resources/node/bin/node',
      args: '/candidate/Ark.app/Contents/Resources/node/bin/node /runtime/runner.js',
    },
  ])
})

test('lifecycle: retained install ownership rejects PID reuse and makes cleanup idempotent', async () => {
  const child = { pid: 42, exitCode: null, signalCode: null }
  let rows = [
    { pid: 42, parentPid: 10, started: 'launcher-a', executable: '/runtime/node', args: '/runtime/node /runtime/start.mjs' },
    { pid: 43, parentPid: 42, started: 'backend-a', executable: '/runtime/node', args: '/runtime/node /runtime/runner.js' },
  ]
  let reads = 0
  let cleanupRuns = 0
  const signals = []
  const captureGate = Promise.withResolvers()
  const ownership = createInstallProcessOwnership(async () => { reads += 1; return captureGate.promise })
  const firstCapture = ownership.capture(child, {
    launcherExecutable: '/runtime/node',
    launcherArgument: '/runtime/start.mjs',
    backendExecutable: '/runtime/node',
    backendArgument: '/runtime/runner.js',
    listenerPids: [43],
  })
  const secondCapture = ownership.capture(child)
  captureGate.resolve(rows)
  const [firstState, secondState] = await Promise.all([firstCapture, secondCapture])
  assert.equal(firstState, secondState, 'concurrent capture shares one retained state')
  assert.deepEqual(firstState.listenerBackends, [rows[1]])
  assert.equal(retainedLauncherIsAlive(rows, firstState), true)
  child.exitCode = 0
  rows = [
    { pid: 42, parentPid: 999, started: 'unrelated-launcher', executable: '/runtime/node', args: '/runtime/node /other/start.mjs' },
    { pid: 43, parentPid: 42, started: 'backend-a', executable: '/runtime/node', args: '/runtime/node /runtime/runner.js' },
  ]
  const cleanup = async state => {
    cleanupRuns += 1
    for (const backend of state.backends) {
      if (retainedBackendIsAlive(rows, state, backend)) signals.push(backend.pid)
    }
  }
  await ownership.cleanup(child, cleanup)
  await ownership.cleanup(child, cleanup)
  assert.equal(reads, 1, 'cleanup never rediscovers from the exited numeric launcher PID')
  assert.equal(cleanupRuns, 1, 'second cleanup reuses the retained cleanup promise')
  assert.equal(retainedLauncherIsAlive(rows, firstState), false)
  assert.deepEqual(signals, [], 'launcher PID reuse cannot redirect a backend signal')
})

test('lifecycle: install ownership rejects listener and executable drift', async () => {
  const rows = [
    { pid: 62, parentPid: 10, started: 'launcher', executable: '/runtime/node', args: '/runtime/node /runtime/start.mjs' },
    { pid: 63, parentPid: 62, started: 'backend', executable: '/runtime/node', args: '/runtime/node /runtime/runner.js' },
  ]
  await assert.rejects(
    createInstallProcessOwnership(async () => rows).capture(
      { pid: 62, exitCode: null, signalCode: null },
      { launcherExecutable: '/other/node', listenerPids: [63] },
    ),
    /launcher executable mismatch/,
  )
  await assert.rejects(
    createInstallProcessOwnership(async () => rows).capture(
      { pid: 62, exitCode: null, signalCode: null },
      { backendExecutable: '/runtime/node', listenerPids: [64] },
    ),
    /listener pid 64 is not a direct launcher child/,
  )
  await assert.rejects(
    createInstallProcessOwnership(async () => [
      { ...rows[0], args: '/runtime/node /runtime/start.mjs.evil' },
      rows[1],
    ]).capture(
      { pid: 62, exitCode: null, signalCode: null },
      { launcherArgument: '/runtime/start.mjs', listenerPids: [63] },
    ),
    /launcher argv mismatch/,
  )
  await assert.rejects(
    createInstallProcessOwnership(async () => [
      rows[0],
      { ...rows[1], args: '/runtime/node /runtime/runner.js.evil' },
    ]).capture(
      { pid: 62, exitCode: null, signalCode: null },
      { backendArgument: '/runtime/runner.js', listenerPids: [63] },
    ),
    /listener argv mismatch/,
  )
})

test('lifecycle: retained backend allows only the captured reparented identity', async () => {
  const child = { pid: 72, exitCode: null, signalCode: null }
  const launcher = {
    pid: 72,
    parentPid: 10,
    started: 'launcher',
    executable: '/runtime/node',
    args: '/runtime/node /runtime/start.mjs',
  }
  const backend = {
    pid: 73,
    parentPid: 72,
    started: 'backend',
    executable: '/runtime/node',
    args: '/runtime/node /runtime/runner.js',
  }
  const state = await createInstallProcessOwnership(async () => [launcher, backend]).capture(child, {
    listenerPids: [73],
    launcherExecutable: '/runtime/node',
    launcherArgument: '/runtime/start.mjs',
    backendExecutable: '/runtime/node',
    backendArgument: '/runtime/runner.js',
  })
  const reparented = [{ ...backend, parentPid: 1 }]
  assert.equal(retainedBackendIsAlive(reparented, state, backend), true)
  assert.equal(retainedBackendIsAlive([{ ...backend, parentPid: 1, started: 'reused' }], state, backend), false)
  assert.equal(retainedBackendIsAlive([{ ...backend, parentPid: 1, executable: '/other/node' }], state, backend), false)
  assert.equal(retainedBackendIsAlive([{ ...backend, parentPid: 1, args: '/other/runner.js' }], state, backend), false)
})

test('lifecycle: install ownership retains ps failure and emits zero backend signals', async () => {
  const child = { pid: 52, exitCode: null, signalCode: null }
  const psFailure = new Error('ps failed')
  let reads = 0
  let cleanupRuns = 0
  const signals = []
  const ownership = createInstallProcessOwnership(async () => { reads += 1; throw psFailure })
  await assert.rejects(ownership.capture(child), error => error === psFailure)
  await ownership.cleanup(child, async state => {
    cleanupRuns += 1
    for (const backend of state.backends) signals.push(backend.pid)
  })
  await ownership.cleanup(child, async () => { cleanupRuns += 1 })
  assert.equal(reads, 1)
  assert.equal(cleanupRuns, 1)
  assert.deepEqual(signals, [])
})

test('lifecycle: parent alive keeps the backend running (no false kill)', { timeout: 30_000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'ark-lifecycle-alive-'))
  const pidFile = join(home, 'child.pid')
  const childScript = await writeScript(home, 'child.mjs', longLivedChild)
  const launcher = launch(home, { parentPid: process.pid, childScript, childArgs: [`--child-pid-file=${pidFile}`] })
  let childIdentity = null
  t.after(async () => {
    await runCleanups('parent-alive lifecycle', [
      async () => { await terminateTestHandle(launcher) },
      async () => { await terminateTestIdentity(childIdentity) },
      async () => { await rm(home, { recursive: true, force: true }) },
    ])
  })

  const childPidText = await waitFile(pidFile, 8_000)
  assert.ok(childPidText, 'dummy child should report its pid')
  const childPid = Number(childPidText.trim())
  childIdentity = await captureTestIdentity(childPid, { argument: childScript })
  await sleep(3_500) // 至少跨过一个 2s 检测周期
  assert.equal(isAlive(launcher.pid), true, 'launcher must survive with a live parent')
  assert.equal(isAlive(childPid), true, 'backend child must not be killed while parent is alive')

  launcher.kill('SIGTERM')
  assert.equal(await waitExit(launcher, 8_000), true, 'launcher exits on SIGTERM')
  assert.equal(await exactIdentityIsAlive(childIdentity), false, 'backend child must not survive its launcher')
})

test('lifecycle: invalid parent identity exits before blocking setup can spawn a child', { timeout: 30_000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'ark-lifecycle-early-parent-death-'))
  const pidFile = join(home, 'child.pid')
  const childScript = await writeScript(home, 'child.mjs', longLivedChild)
  const launcher = launch(home, {
    parentPid: process.pid + 1_000_000,
    childScript,
    childArgs: [`--child-pid-file=${pidFile}`],
  })
  t.after(async () => {
    await runCleanups('early-parent-death lifecycle', [
      async () => { await terminateTestHandle(launcher) },
      async () => { await rm(home, { recursive: true, force: true }) },
    ])
  })

  assert.equal(await waitExit(launcher, 5_000), true, 'launcher exits when its initial parent identity is stale')
  assert.equal(await waitFile(pidFile, 500), null, 'no backend is spawned after the parent identity is stale')
})

test('lifecycle: parent death terminates the owned child and exits the launcher', { timeout: 30_000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'ark-lifecycle-parent-death-'))
  const childPidFile = join(home, 'child.pid')
  const launcherPidFile = join(home, 'launcher.pid')
  const childScript = await writeScript(home, 'child.mjs', longLivedChild)
  await writeScript(home, 'parent.mjs', dummyParent)
  const parent = spawnDummyParent(home, { childScript, launcherPidFile, childArgs: [`--child-pid-file=${childPidFile}`] })
  let childIdentity = null
  let launcherIdentity = null
  t.after(async () => {
    await runCleanups('parent-death lifecycle', [
      async () => { await terminateTestHandle(parent) },
      async () => { await terminateTestIdentity(launcherIdentity) },
      async () => { await terminateTestIdentity(childIdentity) },
      async () => { await rm(home, { recursive: true, force: true }) },
    ])
  })

  const childPidText = await waitFile(childPidFile, 8_000)
  const launcherPidText = await waitFile(launcherPidFile, 8_000)
  assert.ok(childPidText, 'dummy child should report its pid')
  assert.ok(launcherPidText, 'dummy parent should report the launcher pid')
  const childPid = Number(childPidText.trim())
  const launcherPid = Number(launcherPidText.trim())
  launcherIdentity = await captureTestIdentity(launcherPid, { argument: startMjs })
  childIdentity = await captureTestIdentity(childPid, { argument: childScript })

  parent.kill('SIGKILL') // 模拟 UI crash
  assert.equal(await waitExit(parent, 5_000), true, 'dummy parent must die')
  assert.equal(await waitIdentityDead(childIdentity, 12_000), true, 'backend child must not orphan after parent death')
  assert.equal(await waitIdentityDead(launcherIdentity, 12_000), true, 'launcher must not orphan after parent death')
})

test('lifecycle: launcher SIGTERM terminates the owned child', { timeout: 30_000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'ark-lifecycle-term-'))
  const pidFile = join(home, 'child.pid')
  const childScript = await writeScript(home, 'child.mjs', longLivedChild)
  const launcher = launch(home, { parentPid: process.pid, childScript, childArgs: [`--child-pid-file=${pidFile}`] })
  let childIdentity = null
  t.after(async () => {
    await runCleanups('launcher-term lifecycle', [
      async () => { await terminateTestHandle(launcher) },
      async () => { await terminateTestIdentity(childIdentity) },
      async () => { await rm(home, { recursive: true, force: true }) },
    ])
  })

  const childPidText = await waitFile(pidFile, 8_000)
  assert.ok(childPidText, 'dummy child should report its pid')
  const childPid = Number(childPidText.trim())
  childIdentity = await captureTestIdentity(childPid, { argument: childScript })

  launcher.kill('SIGTERM')
  assert.equal(await waitExit(launcher, 8_000), true, 'launcher exits on SIGTERM')
  assert.equal(await exactIdentityIsAlive(childIdentity), false, 'child must exit together with the launcher')
})

test('lifecycle: launcher reaps a TERM-resistant child before the UI outer deadline', { timeout: 30_000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'ark-lifecycle-stubborn-'))
  const pidFile = join(home, 'child.pid')
  const childScript = await writeScript(home, 'stubborn-child.mjs', stubbornChild)
  const launcher = launch(home, {
    parentPid: process.pid,
    childScript,
    childArgs: [`--child-pid-file=${pidFile}`],
  })
  let childIdentity = null
  t.after(async () => {
    await runCleanups('stubborn-child lifecycle', [
      async () => { await terminateTestHandle(launcher) },
      async () => { await terminateTestIdentity(childIdentity) },
      async () => { await rm(home, { recursive: true, force: true }) },
    ])
  })

  const childPidText = await waitFile(pidFile, 8_000)
  assert.ok(childPidText, 'stubborn child should report its pid')
  const childPid = Number(childPidText.trim())
  childIdentity = await captureTestIdentity(childPid, { argument: childScript })
  launcher.kill('SIGTERM')
  assert.equal(await waitExit(launcher, 8_000), true, 'launcher exits after its six-second child deadline')
  assert.equal(await waitIdentityDead(childIdentity, 1_000), true, 'TERM-resistant child is killed and reaped first')
  assert.equal(launcher.exitCode, 1, 'forced child cleanup is diagnosed as a nonzero launcher exit')
})

test('lifecycle: child exit first reaps cleanly without double terminate', { timeout: 30_000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'ark-lifecycle-child-first-'))
  const childScript = await writeScript(home, 'exit-child.mjs', 'process.exit(7)\n')
  const launcher = launch(home, { parentPid: process.pid, childScript })
  t.after(async () => {
    await runCleanups('child-first lifecycle', [
      async () => { await terminateTestHandle(launcher) },
      async () => { await rm(home, { recursive: true, force: true }) },
    ])
  })

  assert.equal(await waitExit(launcher, 8_000), true, 'launcher exits after its child')
  assert.equal(launcher.exitCode, 7, 'launcher propagates the child exit code')
})

test('lifecycle: parent-death and SIGTERM race still cleans up exactly once', { timeout: 30_000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'ark-lifecycle-race-'))
  const childPidFile = join(home, 'child.pid')
  const launcherPidFile = join(home, 'launcher.pid')
  const termLog = join(home, 'terms.log')
  const childScript = await writeScript(home, 'child.mjs', longLivedChild)
  await writeScript(home, 'parent.mjs', dummyParent)
  const parent = spawnDummyParent(home, {
    childScript,
    launcherPidFile,
    childArgs: [`--child-pid-file=${childPidFile}`, `--term-log=${termLog}`],
  })
  let childIdentity = null
  let launcherIdentity = null
  t.after(async () => {
    await runCleanups('race lifecycle', [
      async () => { await terminateTestHandle(parent) },
      async () => { await terminateTestIdentity(launcherIdentity) },
      async () => { await terminateTestIdentity(childIdentity) },
      async () => { await rm(home, { recursive: true, force: true }) },
    ])
  })

  const childPidText = await waitFile(childPidFile, 8_000)
  const launcherPidText = await waitFile(launcherPidFile, 8_000)
  assert.ok(childPidText, 'dummy child should report its pid')
  assert.ok(launcherPidText, 'dummy parent should report the launcher pid')
  const childPid = Number(childPidText.trim())
  const launcherPid = Number(launcherPidText.trim())
  launcherIdentity = await captureTestIdentity(launcherPid, { argument: startMjs })
  childIdentity = await captureTestIdentity(childPid, { argument: childScript })

  // 近同时触发两条路径：parent death 与 launcher SIGTERM。
  parent.kill('SIGKILL')
  try {
    signalExactProcessIdentity(launcherIdentity, await readProcessTable(), 'SIGTERM')
  } catch (error) {
    // parent-death 路径可能已抢先让 launcher 退出——该竞态是允许结果。
    if (error?.code !== 'ESRCH') throw error
  }

  assert.equal(await waitIdentityDead(childIdentity, 12_000), true, 'child must exit under the race')
  assert.equal(await waitIdentityDead(launcherIdentity, 12_000), true, 'launcher must exit under the race')
  const terms = await readFile(termLog, 'utf8')
  assert.equal(terms.split('\n').filter(Boolean).length, 1, 'child receives exactly one TERM')
})

test('lifecycle: launcher source carries no forbidden cleanup patterns', () => {
  const source = readFileSync(startMjs, 'utf8')
  const backendProcess = readFileSync(backendProcessSwift, 'utf8')
  for (const banned of ['killall', 'pkill', 'lsof']) {
    assert.ok(!source.includes(banned), `launcher source must not contain ${banned}`)
  }
  assert.ok(source.includes('--parent-pid'), 'launcher accepts the UI parent pid')
  assert.ok(source.includes('shutdownOnce'), 'launcher owns one shutdown path')
  assert.ok(source.includes('process.ppid'), 'launcher watches its own parent identity')
  assert.ok(
    source.indexOf('parentWatch = setInterval') < source.indexOf('await assertStandaloneRuntimeClosure()'),
    'parent identity watcher is installed before blocking runtime preparation',
  )
  assert.match(source, /const CHILD_GRACE_MS = 6_000/, 'launcher preserves the runner five-second grace plus margin')
  assert.ok(
    source.indexOf('recheckParent()\nchild = spawn') >= 0
      && source.lastIndexOf('recheckParent()') > source.indexOf('child.once(\'exit\''),
    'launcher rechecks parent identity immediately before and after spawn',
  )
  assert.match(backendProcess, /forceKillGraceSeconds: TimeInterval = 8/, 'UI launcher stop grace covers the child deadline')
})
