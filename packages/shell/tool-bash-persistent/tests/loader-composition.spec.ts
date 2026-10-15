import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, onTestFailed, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { CallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import TerminalSessionService from '@deepseek-ai/dsh-terminal'
import * as TerminalLocal from '@deepseek-ai/dsh-terminal-bash'
import SandboxProvider from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ToolBashPersistent from '@deepseek-ai/dsh-tool-bash-persistent'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

class PassthroughSandbox extends SandboxProvider {
  confine(argv: readonly string[], _policy: SandboxPolicy): ConfinedArgv {
    return { argv: [...argv], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }
  }
}

function agent(ctx: Context, cwd: string): Agent {
  const id = SessionId('persistent-bash-loader-agent')
  const scope = ctx.plugin(() => {})
  const session = Session.create(id, [], { version: 0, id, createdAt: 0, cwd })
  const value: Agent = {
    id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle',
    ctx: scope.ctx,
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject: () => {},
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  ctx.agents.register(value)
  return value
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

const suite = process.platform === 'linux' || process.platform === 'darwin' ? describe : describe.skip

suite('persistent Bash through a real cordis.yml Loader composition', () => {
  it('preserves cwd and environment across calls', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-persistent-bash-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-agent'",
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-tools'",
      "- name: '@deepseek-ai/dsh-terminal'",
      "- name: '@deepseek-ai/dsh-test-sandbox'",
      "- name: '@deepseek-ai/dsh-sandbox-policy'",
      '  config:',
      '    mode: danger-full-access',
      `    workspaceRoot: ${JSON.stringify(root)}`,
      "- name: '@deepseek-ai/dsh-subprocess-local'",
      "- name: '@deepseek-ai/dsh-terminal-bash'",
      '  config:',
      '    pollIntervalMs: 10',
      '    exactProbeAfterMs: 20',
      // The silence tier is pushed beyond the send bound, so no send below can
      // settle as inferred_idle: every case proves the controlled-prompt fast
      // path that the production defaults (3.5s silence) would otherwise mask.
      '    idleSilenceMs: 30000',
      '    handoffGraceMs: 100',
      '    scrollbackLines: 20000',
      '    timeoutMs: 2000',
      '    disposeGraceMs: 500',
      "- name: '@deepseek-ai/dsh-tool-bash-persistent'",
      '  config:',
      '    timeoutMs: 5000',
      '',
    ].join('\n'))

    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-agent', AgentRegistry],
      ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
      ['@deepseek-ai/dsh-tools', ToolRuntime],
      ['@deepseek-ai/dsh-terminal', TerminalSessionService],
      ['@deepseek-ai/dsh-test-sandbox', PassthroughSandbox],
      ['@deepseek-ai/dsh-sandbox-policy', SandboxPolicyService],
      ['@deepseek-ai/dsh-subprocess-local', LocalSubprocessRuntime],
      ['@deepseek-ai/dsh-terminal-bash', TerminalLocal],
      ['@deepseek-ai/dsh-tool-bash-persistent', ToolBashPersistent],
    ])
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await context.loader.await()

    const owner = agent(context, root)
    const signal = new AbortController().signal
    const execute = (id: string, command: string) => context!.tools.execute({
      signal,
      callId: CallId(id),
      name: 'bash',
      arguments: { command },
      agent: owner,
    })

    expect(context.tools.schemas().map(schema => schema.name)).toEqual(['bash'])
    await execute('state', 'export KEEP=loader; mkdir -p nested; cd nested')
    const observed = text(await execute('observe', 'printf "cwd=%s keep=%s\\n" "$PWD" "$KEEP"'))
    expect(observed).toContain(`cwd=${join(root, 'nested')} keep=loader`)
    expect(observed).not.toContain('DSH_PERSISTENT_BASH')

    const multiline = text(await execute(
      'multiline',
      'value="line one"\nprintf "%s:%s\\n" "$value" "it\'s fine"',
    ))
    expect(multiline).toBe("line one:it's fine")
    expect(multiline).not.toContain('DSH_PERSISTENT_BASH')

    const heredoc = text(await execute(
      'heredoc',
      "cat <<'EOF'\nalpha\nbeta\nEOF",
    ))
    expect(heredoc).toBe('alpha\nbeta')

    const pipeline = text(await execute(
      'pipeline',
      '{ sleep 0.1; printf "delayed\\n"; } | cat',
    ))
    expect(pipeline).toBe('delayed')

    const large = text(await execute('large-output', 'seq 1 12050'))
    expect(large.startsWith('1\n2\n3\n')).toBe(true)
    expect(large).toContain('<response clipped>')
    expect(large).not.toContain('beginning of this command output was dropped')

    const terminal = context.terminals
    const startedAt = performance.now()
    let startMarker = ''
    let endMarker = ''
    let observedSession: Parameters<typeof terminal.startSend>[1] | undefined
    const shape = (value: string) => {
      const end = endMarker === '' ? -1 : value.lastIndexOf(endMarker)
      return { chars: value.length, utf8Bytes: Buffer.byteLength(value),
        startSeen: startMarker !== '' && value.includes(startMarker), endSeen: end >= 0,
        endStatusSeen: end >= 0 && /^\d+\r?\n/u.test(value.slice(end + endMarker.length)) }
    }
    const diagnostic = { sends: 0, submissions: 0, outputReads: 0, scrollbackReads: 0, lists: 0,
      rejected: false, lastListedStatus: 'unbound',
      done: { observed: false, waitReason: 'none', status: 'none', truncated: false, ...shape('') },
      output: { truncated: false, ...shape('') },
      scrollback: { totalLines: 0, lineBegin: 0, lineEnd: 0, truncated: false, ...shape('') } }
    onTestFailed(() => { console.error('bash-unicode-existing-terminal-calls', {
      elapsedMs: Math.round(performance.now() - startedAt), ...diagnostic,
    }) })
    const restoreOutputReads: Array<() => void> = []
    const originalStart = terminal.startSend.bind(terminal)
    const sendSpy = vi.spyOn(terminal, 'startSend').mockImplementation((...args) => {
      const operation = originalStart(...args)
      observedSession = args[1]
      if (args[2].submit) {
        startMarker = /__DSH_PERSISTENT_BASH_START_[a-f0-9-]+__/u.exec(args[2].text)?.[0] ?? ''
        endMarker = /__DSH_PERSISTENT_BASH_END_[a-f0-9-]+:/u.exec(args[2].text)?.[0] ?? ''
        diagnostic.submissions += 1
      }
      diagnostic.sends += 1
      const originalOutput = operation.readOutput.bind(operation)
      const outputSpy = vi.spyOn(operation, 'readOutput').mockImplementation(() => {
        const result = originalOutput()
        diagnostic.outputReads += 1
        diagnostic.output = { ...shape(result.delta), truncated: result.truncated }
        return result
      })
      restoreOutputReads.push(() => { outputSpy.mockRestore() })
      void operation.done.then((result) => {
        diagnostic.done = { observed: true, ...shape(result.viewport), truncated: result.truncated,
          waitReason: ['stdin_read', 'inferred_idle', 'timeout', 'session_exit'].includes(result.waitReason)
            ? result.waitReason : 'other',
          status: result.sessionStatus.kind === 'running' ? 'running' : 'exited' }
      }, () => { diagnostic.rejected = true })
      return operation
    })
    const originalRead = terminal.read.bind(terminal)
    const readSpy = vi.spyOn(terminal, 'read').mockImplementation((...args) => {
      const result = originalRead(...args)
      diagnostic.scrollbackReads += 1
      diagnostic.scrollback = { ...shape(result.text), truncated: result.truncated,
        totalLines: result.totalLines, lineBegin: result.lineBegin, lineEnd: result.lineEnd }
      return result
    })
    const originalList = terminal.list.bind(terminal)
    const listSpy = vi.spyOn(terminal, 'list').mockImplementation((...args) => {
      const result = originalList(...args)
      diagnostic.lists += 1
      const status = result.find(session => session.sessionId === observedSession)?.status.kind
      diagnostic.lastListedStatus = status === 'running' || status === 'exited' ? status : 'unbound'
      return result
    })
    try {
      const unicode = text(await execute('unicode-output', "printf 'x%.0s' {1..15999}; printf '😀tail\\n'"))
      expect(unicode.startsWith(`${'x'.repeat(15_999)}<response clipped>`), JSON.stringify({
        outputChars: unicode.length,
        outputUtf8Bytes: Buffer.byteLength(unicode),
        firstNonXOffset: unicode.search(/[^x]/u),
        clippedMarkerOffset: unicode.indexOf('<response clipped>'),
        lineFeedCount: unicode.split('\n').length - 1,
        containsEmojiHighSurrogate: unicode.includes('\uD83D'),
        endsWithTail: unicode.endsWith('tail'),
      })).toBe(true)
      expect(unicode).not.toContain('\uD83D')
    } finally {
      for (const restore of restoreOutputReads) restore()
      sendSpy.mockRestore()
      readSpy.mockRestore()
      listSpy.mockRestore()
    }
    expect(text(await execute('after-unicode-output', 'printf "ready\\n"'))).toBe('ready')

    // `exec` replaces the wrapper before its end marker prints; the seam's
    // stdin_read readiness is what returns the replacement shell's prompt
    // instead of spinning until the tool deadline.
    const execed = text(await execute('exec-replacement', 'exec bash --noprofile --norc -i'))
    expect(execed).toBe('dsh> ')

    const exited = text(await execute('exit', 'exit'))
    expect(exited).toContain('next bash call starts from the workspace')
    expect(text(await execute('after-exit', 'printf "%s\\n" "$PWD"'))).toBe(root)
  }, 20_000)
})
