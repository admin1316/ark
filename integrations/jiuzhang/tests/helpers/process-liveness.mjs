import { createConnection } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'

/** Probe one test-owned PID without changing process state. */
export const processIsAlive = (
  pid,
  signalProcess = process.kill.bind(process),
) => {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false
  try {
    signalProcess(pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    throw error
  }
}

/** Signal one already-owned safe PID, tolerating only a vanished process. */
export const signalOwnedProcess = (
  pid,
  signal,
  signalProcess = process.kill.bind(process),
) => {
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    throw new Error(`cannot signal unsafe test pid: ${String(pid)}`)
  }
  try {
    signalProcess(pid, signal)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    throw error
  }
}

const validProcessIdentity = identity => (
  Number.isSafeInteger(identity?.pid) && identity.pid > 1
    && typeof identity.started === 'string' && identity.started !== ''
    && typeof identity.executable === 'string' && identity.executable.startsWith('/')
    && typeof identity.args === 'string' && identity.args !== ''
)

/** Compare the immutable fields retained before a test-owned process is signalled. */
export const sameProcessIdentity = (left, right) => (
  validProcessIdentity(left) && validProcessIdentity(right)
    && left.pid === right.pid
    && left.started === right.started
    && left.executable === right.executable
    && left.args === right.args
)

/**
 * Signal a retained test process only while its start time, executable, and
 * complete argv still match a fresh process-table row. A vanished identity is
 * already clean; PID reuse fails closed without emitting a signal.
 */
export const signalExactProcessIdentity = (
  expected,
  currentRows,
  signal,
  signalProcess = process.kill.bind(process),
) => {
  if (!validProcessIdentity(expected)) {
    throw new Error('cannot signal an invalid retained process identity')
  }
  const current = currentRows.find(row => row?.pid === expected.pid)
  if (current === undefined) return false
  if (!sameProcessIdentity(current, expected)) {
    throw new Error(`refusing to signal reused or changed pid ${String(expected.pid)}`)
  }
  return signalOwnedProcess(expected.pid, signal, signalProcess)
}

/** Probe one exact IPv4 loopback port without treating timeouts as release. */
export const probeLoopbackPort = (
  port,
  connect = createConnection,
  timeoutMs = 300,
) => {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    return Promise.reject(new Error(`invalid loopback port: ${String(port)}`))
  }
  return new Promise((resolve, reject) => {
    let socket
    let settled = false
    const finish = result => {
      if (settled) return
      settled = true
      socket?.removeAllListeners()
      socket?.destroy()
      resolve(result)
    }
    try {
      socket = connect({ host: '127.0.0.1', port })
      socket.once('connect', () => { finish({ state: 'listening' }) })
      socket.once('error', error => {
        finish({
          state: error?.code === 'ECONNREFUSED' ? 'refused' : 'error',
          code: typeof error?.code === 'string' ? error.code : undefined,
        })
      })
      socket.setTimeout(timeoutMs, () => { finish({ state: 'timeout' }) })
    } catch (error) {
      reject(error)
    }
  })
}

/** Wait until an exact loopback connect is definitively refused. */
export const waitLoopbackPortUnbound = async (
  port,
  timeoutMs,
  {
    probe = probeLoopbackPort,
    now = Date.now,
    delay = sleep,
  } = {},
) => {
  const deadline = now() + timeoutMs
  const observations = []
  while (true) {
    const observation = await probe(port)
    observations.push(observation)
    if (observation.state === 'refused') return { released: true, observations }
    if (observation.state === 'error') {
      throw new Error(`loopback port ${String(port)} probe failed: ${String(observation.code ?? 'unknown')}`)
    }
    if (now() >= deadline) return { released: false, observations }
    await delay(50)
  }
}

/** Serialize only allowlisted error fields after removing runtime secrets. */
export const serializeRedactedError = (
  error,
  { secrets = [], pathReplacements = [] } = {},
) => {
  const replacements = [
    ...secrets.filter(value => typeof value === 'string' && value !== '').map(value => [value, '[REDACTED]']),
    ...pathReplacements
      .filter(([value]) => typeof value === 'string' && value !== '')
      .map(([value, replacement]) => [value, replacement]),
  ]
  const sanitize = value => {
    let text = String(value ?? '')
    for (const [needle, replacement] of replacements) text = text.replaceAll(needle, replacement)
    return text
      .replace(/Bearer\s+[^\s,;]+/giu, 'Bearer [REDACTED]')
      .replace(/((?:authorization|credential|api[_-]?key|token)\s*[=:]\s*)[^\s,;]+/giu, '$1[REDACTED]')
      .replace(/\{[^{}\n]{0,1000}\}/gu, '[REDACTED_OBJECT]')
      .slice(0, 1_000)
  }
  const visit = (value, seen) => {
    if (typeof value !== 'object' || value === null) {
      return { name: 'Error', message: sanitize(value), stackFrames: [] }
    }
    if (seen.has(value)) return { name: 'Error', message: '[CIRCULAR_ERROR]', stackFrames: [] }
    seen.add(value)
    const stackFrames = typeof value.stack === 'string'
      ? value.stack.split('\n').slice(1).filter(line => /^\s*at\s/u.test(line)).slice(0, 32).map(sanitize)
      : []
    const serialized = {
      name: typeof value.name === 'string' ? sanitize(value.name) : 'Error',
      ...(typeof value.code === 'string' || typeof value.code === 'number'
        ? { code: sanitize(value.code) }
        : {}),
      message: sanitize(value.message),
      stackFrames,
    }
    if (Array.isArray(value.errors)) {
      serialized.causes = value.errors.map(child => visit(child, seen))
    }
    return serialized
  }
  return visit(error, new Set())
}

export class CleanupTimeoutError extends Error {
  constructor(label, timeoutMs) {
    super(`${label} cleanup timed out after ${String(timeoutMs)}ms`)
    this.name = 'CleanupTimeoutError'
  }
}

export const withCleanupDeadline = async (label, timeoutMs, operation) => {
  let timer
  const controller = new AbortController()
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new CleanupTimeoutError(label, timeoutMs)
          reject(error)
          controller.abort(error)
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export const runCleanupSteps = async (label, primaryFailures, steps) => {
  const failures = [...primaryFailures]
  for (const step of steps) {
    try {
      await withCleanupDeadline(step.label, step.timeoutMs, step.run)
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, `${label}: primary and cleanup failures`)
}
