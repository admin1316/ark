/**
 * Measure the Rust shadow in one persistent child process.
 *
 * This helper is intentionally a small line-protocol harness. It is invoked
 * by benchmark-knowledge-search.ts and is not a production supervisor. The
 * Rust binary's normal one-request mode remains the production-compatible
 * path; --persistent is only an opt-in warm-envelope benchmark mode.
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function nowNs() {
  return process.hrtime.bigint()
}

function ms(start, end) {
  return Number(end - start) / 1e6
}

const activeChildren = new Set()

function spawnTracked(binary) {
  const child = spawn(binary, ['--persistent'], { stdio: ['pipe', 'pipe', 'pipe'] })
  activeChildren.add(child)
  child.once('close', () => activeChildren.delete(child))
  return child
}

function waitForSpawn(child) {
  return new Promise((resolve, reject) => {
    const onSpawn = () => {
      cleanup()
      resolve()
    }
    const onError = (error) => {
      cleanup()
      reject(error)
    }
    const cleanup = () => {
      child.off('spawn', onSpawn)
      child.off('error', onError)
    }
    child.once('spawn', onSpawn)
    child.once('error', onError)
  })
}

function waitForClose(child) {
  return new Promise((resolve, reject) => {
    const onClose = (code, signal) => {
      cleanup()
      resolve({ code, signal })
    }
    const onError = (error) => {
      cleanup()
      reject(error)
    }
    const cleanup = () => {
      child.off('close', onClose)
      child.off('error', onError)
    }
    child.once('close', onClose)
    child.once('error', onError)
  })
}

function validateOutput(line, payload) {
  const output = JSON.parse(line)
  if (output?.schemaVersion !== 1 || !Array.isArray(output.results)
    || typeof output.digest !== 'string' || typeof output.inputDigest !== 'string') {
    throw new Error('Rust persistent output failed schema validation')
  }
  if (output.inputDigest !== sha256(payload)) throw new Error('Rust persistent input digest mismatch')
  if (output.digest !== sha256(JSON.stringify(output.results))) throw new Error('Rust persistent result digest mismatch')
  return output
}

async function runPersistent(binary, payload, iterations, timeoutMs) {
  const spawnStarted = nowNs()
  const child = spawnTracked(binary)
  const lineReader = createInterface({ input: child.stdout })
  const lines = lineReader[Symbol.asyncIterator]()
  const closePromise = waitForClose(child)
  const timeout = setTimeout(() => child.kill('SIGTERM'), timeoutMs)
  timeout.unref()
  try {
    await waitForSpawn(child)
    const startupMs = ms(spawnStarted, nowNs())
    const samplesMs = []
    const measurementDigests = []
    let firstOutput
    for (let index = 0; index < iterations; index += 1) {
      const started = nowNs()
      child.stdin.write(`${payload}\n`)
      const next = await lines.next()
      if (next.done) throw new Error('Rust persistent child closed before response')
      const output = validateOutput(next.value, payload)
      firstOutput ??= output
      measurementDigests.push(JSON.stringify(output.results))
      samplesMs.push(ms(started, nowNs()))
    }
    child.stdin.end()
    const close = await closePromise
    if (close.code !== 0 || close.signal !== null) {
      throw new Error(`Rust persistent child exited ${String(close.code)}${close.signal === null ? '' : ` (${close.signal})`}`)
    }
    return {
      startupMs,
      samplesMs,
      measurementDigest: sha256(measurementDigests.join('\n')),
      resultDigest: firstOutput.digest,
      inputDigest: firstOutput.inputDigest,
    }
  } finally {
    clearTimeout(timeout)
    lineReader.close()
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  }
}

async function runRecovery(binary, payload, timeoutMs) {
  const child = spawnTracked(binary)
  const lineReader = createInterface({ input: child.stdout })
  const lines = lineReader[Symbol.asyncIterator]()
  const started = nowNs()
  const closePromise = waitForClose(child)
  try {
    await waitForSpawn(child)
    child.stdin.write(`${payload}\n`)
    const next = await lines.next()
    if (next.done) throw new Error('Rust recovery child closed before response')
    const output = validateOutput(next.value, payload)
    child.kill('SIGKILL')
    const crash = await closePromise
    if (crash.signal !== 'SIGKILL') throw new Error(`Rust recovery crash probe exited ${String(crash.code)}`)
    const restarted = await runPersistent(binary, payload, 1, timeoutMs)
    return {
      status: 'observed',
      crashSignal: crash.signal,
      restartRequestMs: restarted.samplesMs[0],
      restartStartupMs: restarted.startupMs,
      resultDigest: output.digest,
      elapsedMs: ms(started, nowNs()),
    }
  } finally {
    lineReader.close()
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  }
}

async function main() {
  const input = JSON.parse(readFileSync(0, 'utf8'))
  if (typeof input?.binary !== 'string' || typeof input?.request !== 'object') throw new Error('invalid persistent benchmark input')
  const payload = JSON.stringify(input.request)
  const iterations = Number.isSafeInteger(input.iterations) && input.iterations > 0 ? input.iterations : 1
  const timeoutMs = Number.isSafeInteger(input.timeoutMs) && input.timeoutMs > 0 ? input.timeoutMs : 30_000
  const measured = await runPersistent(input.binary, payload, iterations, timeoutMs)
  const recovery = await runRecovery(input.binary, payload, timeoutMs)
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, ...measured, recovery, cancellation: {
    status: 'not-measured',
    reason: 'The synchronous benchmark has no in-flight AbortSignal; cancellation remains owned by the TypeScript candidate boundary.',
  } })}\n`)
}

process.on('SIGTERM', () => {
  for (const child of activeChildren) child.kill('SIGTERM')
  process.exit(143)
})

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
