import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { CallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import TerminalSessionService from '@deepseek-ai/dsh-terminal'
import * as TerminalBash from '@deepseek-ai/dsh-terminal-bash'
import SandboxProvider from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import LocalSubprocessService from '@deepseek-ai/dsh-subprocess-local'
import { pwshTestsAvailable } from '@deepseek-ai/dsh-pwsh-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import * as ToolPwshPersistent from '@deepseek-ai/dsh-tool-pwsh-persistent'

const hasPwsh = pwshTestsAvailable()

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
  const id = SessionId('persistent-pwsh-loader-agent')
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

describe.skipIf(!hasPwsh)('persistent pwsh through a real cordis.yml Loader composition', () => {
  it('preserves cwd and environment across calls', async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-persistent-pwsh-loader-')))
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
      '    shellDialect: pwsh',
      '    pollIntervalMs: 10',
      '    exactProbeAfterMs: 20',
      '    idleSilenceMs: 300',
      '    handoffGraceMs: 300',
      '    scrollbackLines: 20000',
      '    timeoutMs: 60000',
      '    disposeGraceMs: 500',
      "- name: '@deepseek-ai/dsh-tool-pwsh-persistent'",
      '  config:',
      '    timeoutMs: 60000',
      '',
    ].join('\n'))

    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-agent', AgentRegistry],
      ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
      ['@deepseek-ai/dsh-tools', ToolRegistry],
      ['@deepseek-ai/dsh-terminal', TerminalSessionService],
      ['@deepseek-ai/dsh-test-sandbox', PassthroughSandbox],
      ['@deepseek-ai/dsh-sandbox-policy', SandboxPolicyService],
      ['@deepseek-ai/dsh-subprocess-local', LocalSubprocessService],
      ['@deepseek-ai/dsh-terminal-bash', TerminalBash],
      ['@deepseek-ai/dsh-tool-pwsh-persistent', ToolPwshPersistent],
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
      name: 'pwsh',
      arguments: { command },
      agent: owner,
    })

    expect(context.tools.schemas().map(schema => schema.name)).toEqual(['pwsh'])
    // The first call's own contract: the wrapper strips its markers, so a
    // command that prints nothing succeeds with no output. A swallowed submit
    // returns the timeout notice and resets the shell instead, which is the
    // failure the cwd assertion below would otherwise misattribute to this call.
    const state = text(await execute('state', '$env:KEEP = "loader"; New-Item -ItemType Directory -Force -Path nested | Out-Null; Set-Location nested'))
    // The first call's own contract: a successful command returns neither the
    // timeout notice nor the shell-reset notice. Windows PSReadLine additionally
    // clips the echo of the long wrapper, which is not a failure of this call.
    expect(state).not.toContain('timed out after')
    expect(state).not.toContain('was reset; the next pwsh call starts from the workspace')
    const observed = text(await execute('observe', 'Write-Output "cwd=$PWD keep=$env:KEEP"'))
    expect(observed).toContain(`cwd=${join(root, 'nested')} keep=loader`)
    expect(observed).not.toContain('DSH_PERSISTENT_PWSH')

    const multiline = text(await execute(
      'multiline',
      '$value = "line one"\nWrite-Output "${value}:it\'s fine"',
    ))
    expect(multiline).toBe("line one:it's fine")
    expect(multiline).not.toContain('DSH_PERSISTENT_PWSH')

    const hereString = text(await execute(
      'here-string',
      "$h = @'\nalpha\nbeta\n'@\nWrite-Output $h",
    ))
    expect(hereString).toBe('alpha\nbeta')

    const large = text(await execute('large-output', '1..12050 | ForEach-Object { $_ }'))
    if (!large.startsWith('1\n2\n3\n') || !large.includes('<response clipped>')
      || large.includes('beginning of this command output was dropped')) {
      process.stderr.write(`pwsh-large-output-shape-diagnostic ${JSON.stringify({
        codeUnits: large.length,
        utf8Bytes: Buffer.byteLength(large, 'utf8'),
        lfCount: large.split('\n').length - 1,
        crlfCount: large.split('\r\n').length - 1,
        expectedPrefix: large.startsWith('1\n2\n3\n'),
        clippedMarker: large.includes('<response clipped>'),
        droppedPrefixMarker: large.includes('beginning of this command output was dropped'),
        wrapperMarker: large.includes('DSH_PERSISTENT_PWSH'),
        timeoutNotice: large.includes('timed out after'),
        resetNotice: large.includes('was reset; the next pwsh call starts from the workspace'),
      })}\n`)
    }
    expect(large.startsWith('1\n2\n3\n')).toBe(true)
    expect(large).toContain('<response clipped>')
    expect(large).not.toContain('beginning of this command output was dropped')

    const unicode = text(await execute(
      'unicode-output',
      "Write-Output (('x' * 15999) + [char]::ConvertFromUtf32(0x1f600) + 'tail')",
    ))
    if (!unicode.startsWith(`${'x'.repeat(15_999)}<response clipped>`) || unicode.includes('\uD83D')) {
      process.stderr.write(`pwsh-unicode-output-shape-diagnostic ${JSON.stringify({
        outputChars: unicode.length,
        outputUtf8Bytes: Buffer.byteLength(unicode, 'utf8'),
        firstNonXOffset: unicode.search(/[^x]/u),
        clippedMarkerOffset: unicode.indexOf('<response clipped>'),
        lineFeedCount: unicode.split('\n').length - 1,
        containsEmojiHighSurrogate: unicode.includes('\uD83D'),
        endsWithTail: unicode.endsWith('tail'),
        wrapperMarker: unicode.includes('DSH_PERSISTENT_PWSH'),
        timeoutNotice: unicode.includes('timed out after'),
        resetNotice: unicode.includes('was reset; the next pwsh call starts from the workspace'),
      })}\n`)
    }
    expect(unicode.startsWith(`${'x'.repeat(15_999)}<response clipped>`)).toBe(true)
    expect(unicode).not.toContain('\uD83D')
    expect(text(await execute('after-unicode-output', 'Write-Output ready'))).toBe('ready')

    const exited = text(await execute('exit', 'exit'))
    expect(exited).toContain('next pwsh call starts from the workspace')
    expect(text(await execute('after-exit', 'Write-Output "$PWD"'))).toBe(root)
  }, 120_000)
})
