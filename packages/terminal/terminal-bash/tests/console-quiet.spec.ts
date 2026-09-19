import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import type { SubprocessTerminalHandle } from '@deepseek-ai/dsh-subprocess'
import type { ResolvedConfig } from '@deepseek-ai/dsh-terminal-bash/src/config.ts'
import { LocalPtySession } from '@deepseek-ai/dsh-terminal-bash/src/session.ts'

function config(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    backendType: 'shell',
    shellDialect: 'pwsh',
    shellPath: '/usr/bin/pwsh',
    shellArgs: [],
    rows: 24,
    cols: 80,
    scrollbackLines: 10,
    scrollbackMaxBytes: 4096,
    maxReadBytes: 64,
    pollIntervalMs: 10,
    exactProbeAfterMs: 20,
    idleSilenceMs: 50,
    handoffGraceMs: 10,
    timeoutMs: 2000,
    disposeGraceMs: 10,
    ...overrides,
  }
}

function session(overrides: Partial<ResolvedConfig> = {}): { pty: LocalPtySession; output: PassThrough } {
  const output = new PassThrough()
  const terminal = {
    pid: 4242,
    output,
    done: new Promise(() => {}),
    write: async () => {},
    inspectForeground: async () => ({ processGroupId: 4242, inputWaiting: false }),
    signalForeground: async () => 4242,
    terminate: async () => {},
  } as unknown as SubprocessTerminalHandle
  return { pty: new LocalPtySession(terminal, config(overrides)), output }
}

// The pwsh bootstrap must not be injected until the console has started and
// gone quiet; these cases pin the real session implementation, not the fake
// session the ordering spec uses.
describe('LocalPtySession console-quiet wait', () => {
  it('resolves once output arrived and the settle window elapsed', async () => {
    const { pty, output } = session()
    try {
      const waiting = pty.waitForConsoleQuiet(1000)
      output.write('PS /tmp> ')
      await expect(waiting).resolves.toBe(true)
    } finally {
      output.end()
    }
  })

  it('returns false when the console produces no output before the bound', async () => {
    const { pty, output } = session()
    try {
      await expect(pty.waitForConsoleQuiet(60)).resolves.toBe(false)
    } finally {
      output.end()
    }
  })

  it('does not infer idle for a pwsh send without stdin-wait evidence', async () => {
    // The pwsh handoff needs the foreground observed back in its stdin wait;
    // with no such evidence the send must keep polling instead of settling on
    // the silence tier alone.
    const { pty, output } = session({ timeoutMs: 400 })
    try {
      let settledWith: string | undefined
      const operation = pty.startSend({ text: 'Write-Output hi', submit: true })
      void operation.done.then((result) => {
        settledWith = result.waitReason
      })
      await new Promise(resolve => setTimeout(resolve, 120))
      expect(settledWith).toBeUndefined()
      operation.cancel()
    } finally {
      output.end()
    }
  })

  it('rejects when the wait is aborted', async () => {
    const { pty, output } = session()
    try {
      const controller = new AbortController()
      const waiting = pty.waitForConsoleQuiet(1000, controller.signal)
      controller.abort(new Error('quiet wait cancelled'))
      await expect(waiting).rejects.toThrow('quiet wait cancelled')
    } finally {
      output.end()
    }
  })
})
