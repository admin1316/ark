/**
 * Persistent shell PTY backend over the subprocess terminal primitive, shared
 * sandbox policy, bounded output, and provider-owned session cleanup.
 * @module @deepseek-ai/dsh-terminal-bash
 */

import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { TerminalBackendCleanupError } from '@deepseek-ai/dsh-terminal'
import type {
  TerminalBackend,
  TerminalBackendSpawnSpec,
  TerminalSendOperation,
  TerminalSendResult,
} from '@deepseek-ai/dsh-terminal'
import type { SubprocessTerminalHandle, SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import { effectiveSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { ENCODING_PREAMBLE } from '@deepseek-ai/dsh-pwsh-local'
import { type Config, type ResolvedConfig, resolveConfig, type ShellDialect, validateConfig } from './config.ts'
import { LocalPtySession } from './session.ts'
import { CONTROLLED_PROMPT } from './sanitize.ts'

export { Config } from './config.ts'
export type { Config as TerminalLocalConfig } from './config.ts'

/** Cordis plugin name. */
export const name = 'terminal-bash'
/** Required services: PTY registry, shared confinement policy, and process substrate. */
export const inject = ['terminals', 'sandboxPolicy', 'subprocess']

interface SandboxModeFenceState {
  pty: Context['terminals']
  sandboxPolicy: Context['sandboxPolicy']
}

const sandboxModeFences = new WeakMap<Agent, SandboxModeFenceState>()

function ensureSandboxModeFence(ctx: Context, owner: Agent): void {
  const existing = sandboxModeFences.get(owner)
  if (existing !== undefined) {
    existing.pty = ctx.terminals
    existing.sandboxPolicy = ctx.sandboxPolicy
    return
  }
  const state: SandboxModeFenceState = { pty: ctx.terminals, sandboxPolicy: ctx.sandboxPolicy }
  sandboxModeFences.set(owner, state)
  owner.ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    if (session !== owner.session || event.type !== 'sandbox/mode') return
    const currentMode = effectiveSandboxMode(session.events) ?? state.sandboxPolicy.defaultMode
    if (event.data.mode === currentMode || !state.pty.hasOwnerActivity(owner)) return
    throw new Error(
      `cannot change sandbox mode from "${currentMode}" to "${event.data.mode}" while persistent terminal sessions are open or being created; wait for creation to settle and close them first`,
    )
  }, { global: true })
}

function childEnvironment(spec: TerminalBackendSpawnSpec, dialect: ShellDialect): Record<string, string> {
  // The subprocess provider supplies its own scrubbed ambient base; these are
  // deliberate terminal-specific overrides layered after it.
  const common = {
    TERM: 'dumb',
    PAGER: 'cat',
    GIT_PAGER: 'cat',
    DSH_SHELL: '1',
    DSH_SESSION_ID: spec.owner.id,
    DSH_PTY_SESSION_ID: spec.sessionId,
  }
  if (dialect === 'pwsh') {
    // pwsh ignores PS1/PROMPT_COMMAND; its prompt is installed by the startup
    // bootstrap instead, and NO_COLOR keeps the renderer quiet.
    return { ...common, NO_COLOR: '1' }
  }
  return {
    ...common,
    PS1: CONTROLLED_PROMPT,
    // Re-asserting PS1 after the marker keeps prompt readiness working when a
    // command overwrote the shell variable: bash runs PROMPT_COMMAND before
    // rendering each prompt, so an override never survives to the next prompt.
    PROMPT_COMMAND: `printf "\\033]133;D;%s\\007" "$?"; PS1='${CONTROLLED_PROMPT}'`,
    BASH_SILENCE_DEPRECATION_WARNING: '1',
  }
}

/**
 * The pwsh prompt function that emits the shared OSC `133;D;` + BEL marker
 * before every prompt, mirroring bash's PROMPT_COMMAND. `[char]27`/`[char]7`
 * build the control bytes at runtime because raw ESC characters in submitted
 * input are unreliable under PSReadLine.
 */
export const PWSH_PROMPT_SETUP =
  "function prompt { [Console]::Write([char]27 + ']133;D;' + [int]$LASTEXITCODE + [char]7); '" + CONTROLLED_PROMPT + "' }"

function spawnArgv(ctx: Context, config: ResolvedConfig, policy: SandboxExecutionPolicy): string[] {
  const argv = [config.shellPath, ...config.shellArgs]
  if (policy.mode === 'danger-full-access') return argv
  const sandbox = ctx.get('sandbox')
  if (sandbox === undefined) {
    throw new Error(`terminal-bash: sandbox mode "${policy.mode}" requires a ctx.sandbox provider in the execution world`)
  }
  // Re-state the discriminant because object spread does not preserve its narrowed type.
  return sandbox.confine(argv, { ...policy, mode: policy.mode }).argv
}

/** How often the pwsh bootstrap re-submits input the console left parked. */
const PWSH_PARK_RELEASE_MS = 250

/**
 * Await the pwsh bootstrap, releasing input the console's startup window parked.
 *
 * A console that is still starting renders the injected submit as a paste whose
 * Enter is lost, so the bootstrap line stays typed and its prompt never appears.
 * On darwin the provider reports no stdin wait, so no other readiness tier can
 * settle it and the whole startup would run into its deadline. Re-submitting
 * releases the parked line (the bootstrap definition is idempotent) and the
 * prompt it produces settles this same send. The caller's absolute startup
 * deadline still bounds the loop by cancelling the operation.
 * @param session - the started PTY session awaiting its bootstrap.
 * @param operation - the in-flight bootstrap send.
 * @returns the bootstrap send result.
 */
async function awaitBootstrap(
  session: LocalPtySession,
  operation: TerminalSendOperation,
): Promise<TerminalSendResult> {
  for (;;) {
    let timer: NodeJS.Timeout | undefined
    let settled: TerminalSendResult | undefined
    try {
      settled = await Promise.race([
        operation.done,
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => { resolve(undefined) }, PWSH_PARK_RELEASE_MS)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
    if (settled !== undefined) return settled
    // A provider that reports the stdin wait has an exact readiness tier for this
    // handoff, and injecting an Enter there would land ahead of the next send's
    // own input; only a host without that evidence needs the release.
    if (!session.reportsStdinWait()) await session.submitParkedInput()
  }
}

// TODO(pty-initialize-race-home): Fold this outer abort race into
// LocalPtySession.initialize when the send-state consolidation lands; the
// session already owns the send lifecycle the race protects.
async function startupSession(
  session: LocalPtySession,
  dialect: ShellDialect,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  let startupOperation: TerminalSendOperation | undefined
  const start = async (): Promise<void> => {
    if (dialect === 'bash') {
      await session.initialize(signal)
      return
    }
    // The console must finish its startup negotiation before the first line is
    // injected: a submit written into that window is lost and the bootstrap
    // stays typed but never executes. The wait is bounded by the same deadline
    // as readiness, and a miss falls through to the existing timeout error.
    await session.waitForConsoleQuiet(timeoutMs, signal)
    // pwsh cannot install its prompt from the environment. Write the prompt
    // function through the session, pin UTF-8 output before user input, and
    // accept only backend stdin_read evidence; echoed setup source containing
    // the printable prompt is not readiness. Follow-up sends bridge silence
    // settlements during startup, while one absolute deadline bounds them.
    let viewport = ''
    for (;;) {
      const first = viewport.length === 0
      startupOperation = session.startSend({
        text: first ? ENCODING_PREAMBLE + PWSH_PROMPT_SETUP : '',
        submit: first,
        ...signal !== undefined ? { signal } : {},
      })
      // Follow-up sends keep the same release loop: a startup that has not reached
      // its prompt yet can have parked the line the previous send wrote.
      const result = await awaitBootstrap(session, startupOperation)
      if (result.waitReason === 'session_exit') throw new Error('PTY shell exited during startup')
      if (result.waitReason === 'timeout') throw new Error('PTY shell did not reach readiness before startup timeout')
      viewport = result.viewport
      if (result.waitReason === 'stdin_read') break
    }
    session.motd = viewport
  }
  const races: Promise<void>[] = []
  let onAbort: (() => void) | undefined
  if (signal !== undefined) {
    const aborted = Promise.withResolvers<never>()
    onAbort = () => { aborted.reject(signal.reason) }
    signal.addEventListener('abort', onAbort, { once: true })
    races.push(aborted.promise)
  }
  let deadlineTimer: NodeJS.Timeout | undefined
  if (dialect === 'pwsh') {
    const deadline = Promise.withResolvers<never>()
    deadlineTimer = setTimeout(() => {
      startupOperation?.cancel()
      deadline.reject(new Error('PTY shell did not reach readiness before startup timeout'))
    }, timeoutMs)
    races.push(deadline.promise)
  }
  try {
    signal?.throwIfAborted()
    await Promise.race([start(), ...races])
  } finally {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer)
    if (signal !== undefined && onAbort !== undefined) signal.removeEventListener('abort', onAbort)
  }
}

/** Local shell backend registered under the configured type. */
export class BashTerminalBackend implements TerminalBackend {
  readonly type: string

  constructor(
    private readonly ctx: Context,
    private readonly config: ResolvedConfig,
    private readonly spawnTerminal: (
      spec: SubprocessTerminalSpawnSpec,
    ) => Promise<SubprocessTerminalHandle> = spec => ctx.subprocess.spawnTerminal(spec),
    private readonly createSession: (
      terminal: SubprocessTerminalHandle,
      config: ResolvedConfig,
    ) => LocalPtySession = (terminal, config) => new LocalPtySession(terminal, config),
  ) {
    this.type = config.backendType
  }

  async spawn(spec: TerminalBackendSpawnSpec): Promise<LocalPtySession> {
    spec.signal?.throwIfAborted()
    ensureSandboxModeFence(this.ctx, spec.owner)
    const policy = this.ctx.sandboxPolicy.resolve({ session: spec.owner.session })
    const argv = spawnArgv(this.ctx, this.config, policy)
    if (argv[0] === undefined) throw new Error('terminal-bash: sandbox returned empty argv')
    const terminal = await this.spawnTerminal({
      argv,
      cwd: spec.cwd ?? policy.workspaceRoot,
      env: childEnvironment(spec, this.config.shellDialect),
      rows: this.config.rows,
      cols: this.config.cols,
      graceMs: this.config.disposeGraceMs,
      signal: spec.signal,
    })
    const session = this.createSession(terminal, this.config)
    try {
      await startupSession(session, this.config.shellDialect, this.config.timeoutMs, spec.signal)
      return session
    } catch (error) {
      try {
        await session.close('PTY startup failed')
      } catch (closeError: unknown) {
        throw new TerminalBackendCleanupError(error, closeError)
      }
      throw error
    }
  }
}

/** Register the local PTY backend. */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  validateConfig(resolved)
  ctx.terminals.registerBackend(new BashTerminalBackend(ctx, resolved))
}
