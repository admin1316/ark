/** Launcher-only, pinned cost guard: credentials remain in incoming HTTP headers in memory. */
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectNativeGuardCostOwner, nativeKnowledgeOwnerEndpointFromEnvironment } from '@deepseek-ai/dsh-native-api-app/startup'
import { startCostGuard } from './knowledge-cost-guard.mjs'

/**
 * Read one fixed private launcher configuration without following a symlink.
 * @param {string} path Absolute, launcher-pinned configuration path.
 * @returns {{schemaVersion:1,ledgerPath:string}} The closed configuration, never a credential or module override.
 */
export function readGuardLaunchConfiguration(path) {
  if (!isAbsolute(path)) throw new TypeError('Guard configuration must be absolute')
  const named = lstatSync(path)
  if (!named.isFile() || named.isSymbolicLink() || named.size > 8192 || (named.mode & 0o077) !== 0
    || (typeof process.getuid === 'function' && named.uid !== process.getuid())) {
    throw new TypeError('Guard configuration must be a private owned regular file')
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  let value
  try {
    const opened = fstatSync(fd)
    if (!opened.isFile() || opened.dev !== named.dev || opened.ino !== named.ino || opened.size > 8192) {
      throw new TypeError('Guard configuration changed before open')
    }
    value = JSON.parse(readFileSync(fd, 'utf8'))
  } finally { closeSync(fd) }
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 2 || value.schemaVersion !== 1
    || typeof value.ledgerPath !== 'string' || !isAbsolute(value.ledgerPath)) {
    throw new TypeError('Guard configuration has an invalid closed shape')
  }
  return Object.freeze({ schemaVersion: 1, ledgerPath: value.ledgerPath })
}

/**
 * Start only after the Native-owned guard role accepts this pinned child.
 * @param {string} configurationPath Absolute launcher configuration path.
 * @param {AbortSignal} signal Process lifecycle signal, including Native normal shutdown.
 * @returns {Promise<{baseURL:string,close:()=>Promise<void>}>} Owned guard and channel shutdown.
 */
export async function launchKnowledgeCostGuard(configurationPath, signal) {
  const configuration = readGuardLaunchConfiguration(configurationPath)
  const endpoint = nativeKnowledgeOwnerEndpointFromEnvironment(process.env)
  if (endpoint === undefined) throw new Error('Native guard launch is not configured')
  const channel = await connectNativeGuardCostOwner(endpoint, signal)
  if (channel.status !== 'ready') throw new Error('Native guard cost authority is disabled')
  let ownerClosed = false
  let closing
  const close = () => closing ??= (async () => {
    signal.removeEventListener('abort', stop)
    try { await guard?.close() } finally { await channel.close() }
  })()
  const stop = () => { void close().catch(() => { process.exitCode = 1 }) }
  void channel.closed.then(() => { ownerClosed = true; if (guard !== undefined) stop() })
  let guard
  try {
    guard = await startCostGuard({ ledgerPath: configuration.ledgerPath, requestEvidenceOwner: {
      async admitRequest(facts, requestSignal) {
        await channel.client.admitProviderRequest({ schemaVersion: 1, ...facts }, requestSignal)
      },
      async recordSettlement(facts, requestSignal) {
        await channel.client.recordProviderSettlement({ schemaVersion: 1, ...facts }, requestSignal)
      },
    } })
  } catch (error) { await channel.close(); throw error }
  signal.addEventListener('abort', stop, { once: true })
  if (signal.aborted || ownerClosed) {
    await close()
    throw new Error('Native guard owner closed during startup')
  }
  return { baseURL: guard.baseURL, close }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const controller = new AbortController()
  let guard
  let stopPromise
  const stop = () => {
    if (!controller.signal.aborted) controller.abort(new Error('Native guard shutdown'))
    stopPromise ??= guard?.close()
    void stopPromise?.catch(() => { process.exitCode = 1 })
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  const parentPid = process.ppid
  const parentWatch = setInterval(() => {
    try {
      if (process.ppid !== parentPid || parentPid <= 1) stop()
      else process.kill(parentPid, 0)
    } catch (error) {
      if (error?.code === 'ESRCH') stop()
      else { stop(); process.exitCode = 1 }
    }
  }, 250)
  parentWatch.unref()
  controller.signal.addEventListener('abort', () => { clearInterval(parentWatch) }, { once: true })
  const configurationPath = process.argv[2]
  if (process.argv.length !== 3 || configurationPath === undefined) {
    process.stderr.write('Guard requires its fixed launcher configuration.\n')
    process.exitCode = 2
    clearInterval(parentWatch)
  } else {
    launchKnowledgeCostGuard(configurationPath, controller.signal).then(async started => {
      guard = started
      if (controller.signal.aborted) { await guard.close(); return }
      process.stdout.write(`${guard.baseURL}\n`)
    }).catch(() => {
      process.stderr.write('Native cost guard startup refused.\n')
      process.exitCode = 1
      clearInterval(parentWatch)
    })
  }
}
