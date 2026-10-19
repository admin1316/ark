/** Built-startup smoke: local fixture socket only, never an upstream API request. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { launchKnowledgeCostGuard, readGuardLaunchConfiguration } from './knowledge-cost-guard-launcher.mjs'

const helper = fileURLToPath(new URL('./knowledge-cost-guard-launcher.mjs', import.meta.url))
const token = 'offline-owner-token-'.repeat(3)
const timeout = ms => new Promise(resolve => { setTimeout(resolve, ms) })
async function until(check, ms = 5000) {
  const deadline = Date.now() + ms
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error('Owned lifecycle did not settle')
    await timeout(20)
  }
}
function frame(value) {
  const bytes = Buffer.from(JSON.stringify(value))
  const head = Buffer.alloc(4)
  head.writeUInt32BE(bytes.length)
  return Buffer.concat([head, bytes])
}
async function fixture(run, costStatus = 'ready', closeAfterHello = false) {
  const directory = await mkdtemp(join(tmpdir(), 'ark-guard-launch-'))
  const configPath = join(directory, 'config.json')
  const ledgerPath = join(directory, 'ledger.json')
  const socketPath = join(directory, 'owner.sock')
  await writeFile(configPath, JSON.stringify({ schemaVersion: 1, ledgerPath }), { mode: 0o600 })
  const peers = new Set()
  const server = createServer(peer => {
    peers.add(peer)
    peer.on('error', () => {})
    peer.on('close', () => { peers.delete(peer) })
    let bytes = Buffer.alloc(0)
    peer.on('data', chunk => {
      bytes = Buffer.concat([bytes, chunk])
      if (bytes.length < 4 || bytes.length < bytes.readUInt32BE(0) + 4) return
      const hello = JSON.parse(bytes.subarray(4).toString())
      assert.deepEqual(hello, { version: 1, operation: 'hello', launchToken: token })
      const reply = frame({ version: 1, ok: true, ownerStatus: 'disabled', authorities: [], peerRole: 'guard', costStatus })
      if (closeAfterHello) peer.end(reply)
      else peer.write(reply)
      bytes = Buffer.alloc(0)
    })
  })
  await new Promise(resolve => { server.listen(socketPath, resolve) })
  const before = { socket: process.env.ARK_NATIVE_OWNER_SOCKET_PATH, token: process.env.ARK_NATIVE_OWNER_LAUNCH_TOKEN }
  process.env.ARK_NATIVE_OWNER_SOCKET_PATH = socketPath
  process.env.ARK_NATIVE_OWNER_LAUNCH_TOKEN = token
  try { await run({ directory, configPath, ledgerPath, peers, socketPath }) } finally {
    for (const peer of peers) peer.destroy()
    await new Promise(resolve => { server.close(resolve) })
    if (before.socket === undefined) delete process.env.ARK_NATIVE_OWNER_SOCKET_PATH
    else process.env.ARK_NATIVE_OWNER_SOCKET_PATH = before.socket
    if (before.token === undefined) delete process.env.ARK_NATIVE_OWNER_LAUNCH_TOKEN
    else process.env.ARK_NATIVE_OWNER_LAUNCH_TOKEN = before.token
    await rm(directory, { recursive: true, force: true })
  }
}

test('private fixed launcher configuration rejects relative, shared, symlink and extra-field files', async () => fixture(async f => {
  assert.deepEqual(readGuardLaunchConfiguration(f.configPath), { schemaVersion: 1, ledgerPath: f.ledgerPath })
  assert.equal(Object.isFrozen(readGuardLaunchConfiguration(f.configPath)), true)
  assert.throws(() => readGuardLaunchConfiguration('relative.json'))
  await chmod(f.configPath, 0o644)
  assert.throws(() => readGuardLaunchConfiguration(f.configPath))
  await chmod(f.configPath, 0o600)
  const link = join(f.directory, 'link.json')
  await symlink(f.configPath, link)
  assert.throws(() => readGuardLaunchConfiguration(link))
  for (const content of [null, [], { schemaVersion: 1, ledgerPath: 'relative' },
    { schemaVersion: 1, ledgerPath: f.ledgerPath, upstream: 'https://invalid.example' },
    { schemaVersion: 2, ledgerPath: f.ledgerPath }, 'invalid-json']) {
    await writeFile(f.configPath, typeof content === 'string' ? content : JSON.stringify(content))
    assert.throws(() => readGuardLaunchConfiguration(f.configPath))
  }
  await writeFile(f.configPath, ' '.repeat(8193))
  assert.throws(() => readGuardLaunchConfiguration(f.configPath))
}))

test('disabled Native cost role opens no guard and creates no budget ledger', async () => fixture(async f => {
  await assert.rejects(launchKnowledgeCostGuard(f.configPath, new AbortController().signal), /disabled/)
  await assert.rejects(readFile(f.ledgerPath), { code: 'ENOENT' })
}, 'disabled'))

test('owner disappearance during startup leaves no usable listener', async () => fixture(async f => {
  let guard
  try { guard = await launchKnowledgeCostGuard(f.configPath, new AbortController().signal) } catch (error) {
    assert.match(error.message, /owner closed during startup/)
  }
  if (guard !== undefined) {
    await until(async () => {
      try { await fetch(guard.baseURL); return false } catch { return true }
    })
    await guard.close()
  }
  await until(() => f.peers.size === 0)
  assert.equal(JSON.parse(await readFile(f.ledgerPath, 'utf8')).requestCount, 0)
}, 'ready', true))

test('owner socket loss closes the actual guard HTTP listener and joins the channel', async () => fixture(async f => {
  const guard = await launchKnowledgeCostGuard(f.configPath, new AbortController().signal)
  assert.equal((await fetch(guard.baseURL)).status, 404)
  for (const peer of f.peers) peer.destroy()
  await until(async () => {
    try { await fetch(guard.baseURL); return false } catch { return true }
  })
  await guard.close()
  assert.equal(JSON.parse(await readFile(f.ledgerPath, 'utf8')).requestCount, 0)
}))

test('process lifecycle abort closes the listener without a caller-issued close', async () => fixture(async f => {
  const controller = new AbortController()
  const guard = await launchKnowledgeCostGuard(f.configPath, controller.signal)
  controller.abort(new Error('Native normal exit'))
  await until(async () => {
    try { await fetch(guard.baseURL); return false } catch { return true }
  })
  await guard.close()
  await until(() => f.peers.size === 0)
}))

test('actual CLI exits after its App-like parent is killed, with no orphan listener or child PID', async () => fixture(async f => {
  const parentScript = `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, [process.argv[1], process.argv[2]], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    process.stdout.write(child.pid + '\\n');
    child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
    child.once('exit', () => process.exit(0));
  `
  const parent = spawn(process.execPath, ['-e', parentScript, helper, f.configPath], {
    env: { PATH: process.env.PATH, ARK_NATIVE_OWNER_SOCKET_PATH: f.socketPath, ARK_NATIVE_OWNER_LAUNCH_TOKEN: token },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = '', errors = ''
  parent.stdout.on('data', bytes => { output += bytes.toString() })
  parent.stderr.on('data', bytes => { errors += bytes.toString() })
  const done = new Promise(resolve => { parent.once('exit', (code, signal) => { resolve({ code, signal }) }) })
  let childPid
  try {
    await until(() => output.trim().split('\n').length === 2 || parent.exitCode !== null)
    const [pid, baseURL] = output.trim().split('\n')
    childPid = Number(pid)
    assert.ok(Number.isSafeInteger(childPid) && childPid > 1, errors)
    assert.match(baseURL, /^http:\/\/127\.0\.0\.1:\d+$/)
    assert.equal((await fetch(baseURL)).status, 404)
    parent.kill('SIGKILL')
    assert.deepEqual(await done, { code: null, signal: 'SIGKILL' })
    await until(() => {
      try { process.kill(childPid, 0); return false } catch (error) { assert.equal(error.code, 'ESRCH'); return true }
    })
    await assert.rejects(fetch(baseURL))
    await until(() => f.peers.size === 0)
    assert.equal(JSON.parse(await readFile(f.ledgerPath, 'utf8')).requestCount, 0)
  } finally {
    if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGKILL')
    if (childPid === undefined && /^\d+\n/.test(output)) childPid = Number(output.split('\n')[0])
    if (childPid !== undefined) {
      try { process.kill(childPid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
    }
    await done
  }
}))
