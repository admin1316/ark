import { fork, type ChildProcess } from 'node:child_process'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

function child(root: string, mode: string, phase = '') {
  const processEnv = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !/KEY|TOKEN|SECRET|PASSWORD|^VITEST|^NODE_V8_COVERAGE/iu.test(key)))
  const running = fork(fileURLToPath(new URL('./fixtures/provider-process.ts', import.meta.url)), [root, mode, phase], {
    execArgv: ['--import', 'tsx'], silent: true, env: { ...processEnv, DSH_HOME: root,
      TSX_TSCONFIG_PATH: fileURLToPath(new URL('../../../../tsconfig.base.json', import.meta.url)) },
  })
  const messages: unknown[] = []
  let output = ''
  running.stdout?.on('data', (data: Buffer) => { output += data.toString() })
  running.stderr?.on('data', (data: Buffer) => { output += data.toString() })
  running.on('message', (message) => { messages.push(message) })
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    running.once('exit', (code, signal) => { resolve({ code, signal }) })
  })
  return { running, done, messages, output: () => output }
}

async function stop(running: ChildProcess) {
  if (running.exitCode !== null || running.signalCode !== null) return
  const exit = new Promise((resolve) => { running.once('exit', resolve) })
  running.kill('SIGKILL')
  await exit
}

it.each(['prepared', 'credential-staged', 'settings-applied', 'credential-applied', 'done'])(
  'recovers after SIGKILL at the durable %s boundary and a second fresh process', async (phase) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'ark-provider-process-')))
    const children: ChildProcess[] = []
    try {
      const first = child(root, 'start', phase)
      children.push(first.running)
      await expect.poll(() => first.messages, { timeout: 10_000 }).toContainEqual({ event: 'paused', phase })
      first.running.kill('SIGKILL')
      expect(await first.done).toEqual({ code: null, signal: 'SIGKILL' })
      const second = child(root, 'resume')
      children.push(second.running)
      expect(await second.done).toEqual({ code: 0, signal: null })
      expect(second.messages).toMatchObject([{
        event: 'result', before: { state: phase === 'done' ? 'committed' : phase },
        after: { state: 'committed', needsCredential: false, live: true },
        model: 'process-recovered', baseURL: 'https://process-fixture.invalid/v1',
        credentialConfigured: true, oldCredentialPreserved: true,
        credentialWrites: phase === 'prepared' ? 1 : 0,
        settingsWrites: phase === 'prepared' || phase === 'credential-staged' ? 1 : 0,
      }])
      const third = child(root, 'resume')
      children.push(third.running)
      expect(await third.done).toEqual({ code: 0, signal: null })
      expect(third.messages).toMatchObject([{ event: 'result', credentialWrites: 0, settingsWrites: 0,
        after: { state: 'committed', needsCredential: false, live: true } }])
      for (const run of [first, second, third]) {
        expect(run.output()).not.toContain('fixture-process-old-secret')
        expect(run.output()).not.toContain('fixture-process-next-secret')
      }
    } finally {
      await Promise.all(children.map(stop))
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000,
)

it.each([0, 1, 2, 3, 4, 5, 6, 7])('reads frozen v1 fixture %i after an actual process restart', async (index) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ark-provider-process-')))
  const first = child(root, 'legacy-start', String(index))
  let second: ReturnType<typeof child> | undefined
  try {
    await expect.poll(() => first.messages, { timeout: 10_000 }).toContainEqual({ event: 'paused', phase: String(index) })
    first.running.kill('SIGKILL')
    expect(await first.done).toEqual({ code: null, signal: 'SIGKILL' })
    second = child(root, 'legacy-resume', String(index))
    expect(await second.done).toEqual({ code: 0, signal: null })
    const committed = index === 1 || index === 2 || index >= 5
    expect(second.messages).toMatchObject([{ event: 'legacy-result', normalized: true, settingsUnchanged: true,
      after: { state: committed ? 'committed' : 'rolled-back' },
      ...committed ? {} : { failureCode: 'settings-rejected' },
    }])
    expect(first.output() + second.output()).not.toContain('synthetic-oracle-only-value')
  } finally {
    await stop(first.running)
    if (second !== undefined) await stop(second.running)
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
