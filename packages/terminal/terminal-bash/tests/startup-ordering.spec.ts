import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { TerminalSessionId } from '@deepseek-ai/dsh-terminal'
import type { TerminalBackendSpawnSpec } from '@deepseek-ai/dsh-terminal'
import { ENCODING_PREAMBLE } from '@deepseek-ai/dsh-pwsh-local'
import { BashTerminalBackend, PWSH_PROMPT_SETUP } from '@deepseek-ai/dsh-terminal-bash'
import type { ResolvedConfig } from '@deepseek-ai/dsh-terminal-bash/src/config.ts'

interface FakeSession {
  motd: string
  order: string[]
  closed: boolean
  waitForConsoleQuiet(timeoutMs: number, signal?: AbortSignal): Promise<boolean>
  initialize(signal?: AbortSignal): Promise<void>
  startSend(request: { text: string; submit: boolean; signal?: AbortSignal }): {
    done: Promise<{ waitReason: string; viewport: string }>
    cancel(): void
  }
  close(reason: string): Promise<void>
}

function fakeConfig(dialect: 'bash' | 'pwsh'): ResolvedConfig {
  return {
    backendType: 'shell',
    shellDialect: dialect,
    shellPath: dialect === 'pwsh' ? '/usr/bin/pwsh' : '/bin/bash',
    shellArgs: [],
    rows: 40,
    cols: 160,
    scrollbackLines: 100,
    scrollbackMaxBytes: 32768,
    maxReadBytes: 16384,
    pollIntervalMs: 10,
    exactProbeAfterMs: 20,
    idleSilenceMs: 250,
    handoffGraceMs: 250,
    timeoutMs: 5000,
    disposeGraceMs: 500,
  }
}

function fakeContext(): Context {
  return {
    terminals: { hasOwnerActivity: () => false },
    sandboxPolicy: {
      resolve: () => ({ mode: 'danger-full-access', workspaceRoot: '/tmp' }),
      defaultMode: 'danger-full-access',
    },
    get: () => undefined,
    on: () => {},
  } as unknown as Context
}

function fakeOwner(): TerminalBackendSpawnSpec['owner'] {
  return {
    id: 'startup-ordering-agent',
    session: {},
    ctx: { on: () => {} },
  } as unknown as TerminalBackendSpawnSpec['owner']
}

function createSession(order: string[], quiet: boolean, sent: string[] = []): FakeSession {
  return {
    motd: '',
    order,
    closed: false,
    async waitForConsoleQuiet() {
      order.push('console-quiet')
      return quiet
    },
    async initialize() {
      order.push('initialize')
      this.motd = 'dsh> '
    },
    startSend(request) {
      order.push(request.text.length === 0 ? 'observe' : 'bootstrap')
      sent.push(request.text)
      return {
        done: Promise.resolve({ waitReason: 'stdin_read', viewport: 'dsh> ' }),
        cancel() {},
      }
    },
    async close() {
      this.closed = true
    },
  }
}

function backend(
  dialect: 'bash' | 'pwsh',
  quiet: boolean,
): { backend: BashTerminalBackend; order: string[]; sent: string[] } {
  const order: string[] = []
  const sent: string[] = []
  const instance = new BashTerminalBackend(
    fakeContext(),
    fakeConfig(dialect),
    async () => ({ pid: 4242 }) as never,
    () => createSession(order, quiet, sent) as never,
  )
  return { backend: instance, order, sent }
}

const spec = (): TerminalBackendSpawnSpec => ({
  type: 'shell',
  name: 'main',
  owner: fakeOwner(),
  sessionId: TerminalSessionId('startup-ordering-session'),
  cwd: '/tmp',
})

describe('terminal-bash startup ordering', () => {
  it('waits for the pwsh console before submitting the prompt bootstrap', async () => {
    const { backend: instance, order } = backend('pwsh', true)
    const session = (await instance.spawn(spec())) as unknown as FakeSession
    expect(order).toEqual(['console-quiet', 'bootstrap'])
    expect(session.motd).toBe('dsh> ')
  })

  it('submits exactly the pinned encoding preamble plus the prompt setup', async () => {
    const { backend: instance, sent } = backend('pwsh', true)
    await instance.spawn(spec())
    expect(sent).toEqual([ENCODING_PREAMBLE + PWSH_PROMPT_SETUP])
  })

  it('still submits after a console-quiet miss instead of failing early', async () => {
    const { backend: instance, order } = backend('pwsh', false)
    await instance.spawn(spec())
    expect(order).toEqual(['console-quiet', 'bootstrap'])
  })

  it('keeps the bash path on initialize without a console-quiet wait', async () => {
    const { backend: instance, order } = backend('bash', true)
    await instance.spawn(spec())
    expect(order).toEqual(['initialize'])
  })
})
