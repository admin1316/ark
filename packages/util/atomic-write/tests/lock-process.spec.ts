import { fork } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const children: ChildProcess[] = []
const directories: string[] = []

afterEach(async () => {
  await Promise.all(children.splice(0).map(async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return
    const exited = once(child, 'exit')
    child.kill('SIGKILL')
    await exited
  }))
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-lock-process-'))
  directories.push(dir)
  return dir
}

async function worker(): Promise<ChildProcess> {
  const child = fork(fileURLToPath(new URL('./fixtures/lock-process.ts', import.meta.url)), [], {
    execArgv: ['--import', 'tsx'],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: {},
  })
  children.push(child)
  const [message] = await once(child, 'message') as unknown[]
  expect(message).toEqual({ type: 'ready' })
  return child
}

async function hold(child: ChildProcess, target: string): Promise<void> {
  const held = once(child, 'message')
  child.send({ target, mode: 'hold', waitMs: 2_000 })
  expect((await held)[0]).toEqual({ type: 'held' })
}

async function increment(child: ChildProcess, target: string, waitMs: number): Promise<unknown> {
  const result = once(child, 'message')
  const exited = once(child, 'exit')
  child.send({ target, mode: 'increment', waitMs })
  const [message] = await result as unknown[]
  await exited
  return message
}

async function crash(child: ChildProcess): Promise<void> {
  const exited = once(child, 'exit')
  child.kill('SIGKILL')
  await exited
}

describe('writer lock process lifecycle', () => {
  it('recovers the legacy PID record left by a killed holder in another process', async () => {
    const dir = await scratch()
    const target = join(dir, 'settings')
    await writeFile(target, '0')
    const holder = await worker()
    await hold(holder, target)
    // Start the successor before the holder exits so Windows cannot reuse the
    // holder PID for the contender and legitimately classify that PID as live.
    const successor = await worker()
    await crash(holder)
    expect(await readFile(`${target}.lock`, 'utf8')).toBe(`${holder.pid}\n`)

    expect(await increment(successor, target, 500)).toEqual({ type: 'done' })
    expect(await readFile(target, 'utf8')).toBe('1')
    expect(await readdir(dir)).toEqual(['settings'])
  }, 20_000)

  it('never takes over another live process, regardless of a short deadline', async () => {
    const target = join(await scratch(), 'settings')
    await writeFile(target, '0')
    const holder = await worker()
    await hold(holder, target)
    const contender = await worker()

    const result = await increment(contender, target, 50)
    expect(result).toHaveProperty('type', 'error')
    expect(result).toHaveProperty('message', expect.stringContaining('timed out'))
    expect(await readFile(`${target}.lock`, 'utf8')).toBe(`${holder.pid}\n`)
    expect(await readFile(target, 'utf8')).toBe('0')
  }, 20_000)

  it('serializes eight independent contenders taking over the same crashed holder', async () => {
    const dir = await scratch()
    const target = join(dir, 'settings')
    await writeFile(target, '0')
    const holder = await worker()
    await hold(holder, target)
    const contenders = await Promise.all(Array.from({ length: 8 }, () => worker()))
    await crash(holder)

    const results = await Promise.all(contenders.map(child => increment(child, target, 10_000)))
    expect(results).toEqual(Array.from({ length: 8 }, () => ({ type: 'done' })))
    expect(await readFile(target, 'utf8')).toBe('8')
    expect(await readdir(dir)).toEqual(['settings'])
  }, 30_000)
})
