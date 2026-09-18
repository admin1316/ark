/** Persistent PTY session with bounded output, readiness, and terminal-protocol replies. */

import { appendFileSync } from 'node:fs'
import { Buffer } from 'node:buffer'
import { createRequire } from 'node:module'
import type { IDisposable, Terminal as HeadlessTerminalType } from '@xterm/headless'
import type {
  SubprocessOutcome,
  SubprocessTerminalForeground,
  SubprocessTerminalHandle,
} from '@deepseek-ai/dsh-subprocess'
import { TerminalError } from '@deepseek-ai/dsh-terminal'
import type {
  TerminalBackendSession,
  TerminalReadRequest,
  TerminalReadResult,
  TerminalSendOperation,
  TerminalSendRead,
  TerminalSendRequest,
  TerminalSendResult,
  TerminalSessionStatus,
  TerminalSignal,
  TerminalSignalResult,
  TerminalWaitReason,
} from '@deepseek-ai/dsh-terminal'
import type { ResolvedConfig } from './config.ts'
import { CONTROLLED_PROMPT, TerminalSanitizer } from './sanitize.ts'

// Node exposes this package's CommonJS main as default-only, so load its named export through require.
const { Terminal: HeadlessTerminal } = createRequire(import.meta.url)('@xterm/headless') as typeof import('@xterm/headless')

function utf8Tail(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text) <= maxBytes) return { text, truncated: false }
  const chars = Array.from(text)
  let bytes = 0
  let start = chars.length
  while (start > 0) {
    const next = Buffer.byteLength(chars[start - 1] as string)
    if (bytes + next > maxBytes) break
    bytes += next
    start -= 1
  }
  return { text: chars.slice(start).join(''), truncated: true }
}

class BoundedTextBuffer {
  private value = ''
  private dropped = false

  constructor(
    private readonly maxBytes: number,
    private readonly maxLines?: number,
  ) {}

  append(text: string): void {
    if (text.length === 0) return
    this.value += text
    if (this.maxLines !== undefined) {
      const lines = this.value.split('\n')
      if (lines.length > this.maxLines) {
        this.value = lines.slice(lines.length - this.maxLines).join('\n')
        this.dropped = true
      }
    }
    const tail = utf8Tail(this.value, this.maxBytes)
    this.value = tail.text
    this.dropped ||= tail.truncated
  }

  consume(): TerminalSendRead {
    const delta = this.value
    const truncated = this.dropped
    this.value = ''
    this.dropped = false
    return { delta, truncated }
  }

  snapshot(): { text: string; truncated: boolean } {
    return { text: this.value, truncated: this.dropped }
  }
}

class LocalSendOperation implements TerminalSendOperation {
  private readonly output: BoundedTextBuffer
  private readonly promise: PromiseWithResolvers<TerminalSendResult>
  private finished = false
  private cancellationRequested = false
  private initialForegroundLeftWait: boolean
  private initialForegroundPgid: number | undefined

  readonly expectedPromptTail: string | undefined

  constructor(
    maxBytes: number,
    readonly startedAt: number,
    private readonly onCancel: () => void,
    request: TerminalSendRequest,
  ) {
    this.output = new BoundedTextBuffer(maxBytes)
    this.promise = Promise.withResolvers<TerminalSendResult>()
    this.initialForegroundLeftWait = true
    this.expectedPromptTail = request.expectedPromptTail
  }

  get done(): Promise<TerminalSendResult> {
    return this.promise.promise
  }

  get settled(): boolean {
    return this.finished
  }

  get cancelRequested(): boolean {
    return this.cancellationRequested
  }

  append(text: string): void {
    if (!this.finished) this.output.append(text)
  }

  settle(waitReason: TerminalWaitReason, sessionStatus: TerminalSessionStatus, inheritedTruncation: boolean): void {
    if (this.finished) return
    this.finished = true
    const read = this.output.snapshot()
    this.promise.resolve({
      viewport: read.text,
      waitReason,
      sessionStatus,
      truncated: read.truncated || inheritedTruncation,
    })
  }

  fail(error: unknown): void {
    if (this.finished) return
    this.finished = true
    this.promise.reject(error)
  }

  readOutput(): TerminalSendRead {
    return this.output.consume()
  }

  setInitialForeground(foreground: SubprocessTerminalForeground | undefined): void {
    this.initialForegroundPgid = foreground?.processGroupId
    this.initialForegroundLeftWait = foreground?.inputWaiting !== true
  }

  acceptsStdinWait(pgid: number, waiting: boolean): boolean {
    // The same group may still expose the wait that existed before terminal.write.
    // Observe every poll so a departure before the exact-settlement threshold
    // still makes a later return to that wait post-write evidence.
    if (pgid !== this.initialForegroundPgid) return waiting
    if (!waiting) this.initialForegroundLeftWait = true
    return waiting && this.initialForegroundLeftWait
  }

  cancel(): boolean {
    if (this.finished) return false
    this.cancellationRequested = true
    this.onCancel()
    return true
  }
}

/** Backend session wrapping one provider-owned terminal process. */
export class LocalPtySession implements TerminalBackendSession {
  motd = ''
  readonly pid: number
  private readonly decoder = new TextDecoder()
  /** Protocol state only; the sanitizer and bounded buffers own returned text. */
  private readonly emulator: HeadlessTerminalType
  private readonly emulatorData: IDisposable
  private readonly sanitizer: TerminalSanitizer
  // Bounded startup diagnostics (DSH_DEBUG_PWSH_STARTUP): the value is a file
  // path to append to, or any other non-empty value for console.error. Only
  // booleans, counts, and ids are recorded — never environment values or user
  // content. State lines are deduplicated to one log per state change.
  private readonly startupTraceTarget = process.env.DSH_DEBUG_PWSH_STARTUP
  private readonly startupT0 = Date.now()
  private startupLastState = ''

  private atStartup(phase: string): void {
    if (this.startupTraceTarget === undefined) return
    const line = `[pty-startup] +${Date.now() - this.startupT0}ms ${phase}`
    try {
      if (/[/\\]/.test(this.startupTraceTarget)) appendFileSync(this.startupTraceTarget, `${line}\n`)
      else console.error(line)
    } catch { /* diagnostics never crash the host */ }
  }

  private atStartupState(state: string): void {
    if (state === this.startupLastState) return
    this.startupLastState = state
    this.atStartup(`state ${state}`)
  }
  private readonly scrollback: BoundedTextBuffer
  private readonly outputEnded = Promise.withResolvers<void>()
  private readonly completion: Promise<void>
  private statusValue: TerminalSessionStatus = { kind: 'running' }
  // TODO(pty-send-state-consolidation): Fold the per-send fields below
  // (active/activeTimer/activeDeadlineTimer/activeAbort/interrupting/
  // activeWrite/pollingReady/polling and terminal-protocol work) into one send-lifecycle
  // owner; the cancellation/readiness interplay has enough pinned tests to carry that refactor safely.
  private active: LocalSendOperation | undefined
  private activeTimer: NodeJS.Timeout | undefined
  private activeDeadlineTimer: NodeJS.Timeout | undefined
  private activeAbort: (() => void) | undefined
  private interrupting: LocalSendOperation | undefined
  private activeWrite: Promise<boolean> | undefined
  private pollingReady: LocalSendOperation | undefined
  private polling = false
  private promptSeen = false
  private promptTextSeen = false
  private promptTail = ''
  private shellPgid: number | undefined
  private initializing = false
  private lastOutputAt = Date.now()
  private closing = false
  private closePromise: Promise<void> | undefined
  private transportFailure: Error | undefined
  private emulatorWrites = Promise.resolve()
  private emulatorWriteDone: (() => void) | undefined
  private emulatorBuffer = ''
  private emulatorWriting = false
  private responseWrites = Promise.resolve()
  private pendingResponseWrites = 0
  private emulatorClosed = false

  constructor(
    private readonly terminal: SubprocessTerminalHandle,
    private readonly config: ResolvedConfig,
  ) {
    this.pid = terminal.pid
    this.emulator = new HeadlessTerminal({ cols: config.cols, rows: config.rows, scrollback: 0 })
    this.emulatorData = this.emulator.onData((data) => {
      this.pendingResponseWrites += 1
      const response = this.responseWrites.then(async () => { await this.terminal.write(data) })
      this.responseWrites = response.then(
        () => { this.finishResponseWrite() },
        (error: unknown) => {
          this.finishResponseWrite()
          if (!this.emulatorClosed && !this.closing) this.onTransportFailure(error)
        },
      )
    })
    this.sanitizer = new TerminalSanitizer(config.maxReadBytes)
    this.scrollback = new BoundedTextBuffer(config.scrollbackMaxBytes, config.scrollbackLines)
    terminal.output.on('data', this.onTerminalData)
    terminal.output.once('end', this.onTerminalEnd)
    terminal.output.once('error', this.onTerminalError)
    this.completion = terminal.done.then(
      outcome => this.onExit(outcome),
      (error: unknown) => { this.onTransportFailure(error) },
    )
  }

  /**
   * Capture startup output through the same readiness contract as later sends.
   * @param signal - optional cancellation while the shell reaches its first prompt.
   * @returns Resolves after startup readiness; rejects on exit or readiness timeout.
   */
  async initialize(signal?: AbortSignal): Promise<void> {
    this.atStartup('T0 initialize entered')
    this.initializing = true
    try {
      const operation = this.startSend({ text: '', submit: false, ...signal !== undefined ? { signal } : {} })
      this.atStartup('T1 send operation created')
      const result = await operation.done
      if (result.waitReason === 'session_exit') throw new Error('PTY shell exited during startup')
      if (result.waitReason === 'timeout') throw new Error('PTY shell did not reach readiness before startup timeout')
      this.motd = result.viewport
    } catch (error: unknown) {
      this.atStartup(`FAILED ${String(error).slice(0, 160)}`)
      signal?.throwIfAborted()
      throw error
    } finally {
      this.initializing = false
    }
  }

  /**
   * Wait until the child console has started, answered its terminal queries,
   * and then stayed quiet for a bounded settle window.
   *
   * pwsh negotiates cursor-position queries while its console starts; input
   * written into that window is rendered as a paste whose submit keystroke is
   * lost, so the prompt bootstrap would stay typed but never execute and every
   * readiness tier would eventually time out. Waiting out the startup traffic
   * is the observable boundary that makes the first injected line reliable;
   * the wait is bounded by the same startup deadline that bounds readiness.
   * @param timeoutMs - absolute bound for the wait.
   * @param signal - optional cancellation while waiting.
   * @returns whether console quiet was observed before the bound.
   */
  async waitForConsoleQuiet(timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    const settleMs = Math.max(this.config.pollIntervalMs * 2, 120)
    const deadline = Date.now() + timeoutMs
    const pollMs = Math.max(1, Math.min(this.config.pollIntervalMs, 20))
    for (;;) {
      signal?.throwIfAborted()
      const quietFor = Date.now() - this.lastOutputAt
      if (this.scrollback.snapshot().text.length > 0 && this.pendingResponseWrites === 0 && quietFor >= settleMs) {
        return true
      }
      if (Date.now() >= deadline) return false
      await new Promise(resolve => setTimeout(resolve, pollMs))
    }
  }

  /**
   * Submit whatever the console left parked in its line editor.
   *
   * A pwsh console that is still starting renders an injected submit as a paste
   * whose Enter is lost: the line stays typed, no prompt marker is printed, and
   * the readiness tiers cannot settle it. Writing the submit sequence on its own
   * releases that parked line — the startup definitions are idempotent — and the
   * prompt it produces is the readiness evidence the caller already waits for.
   * A console that already shows the expected prompt is left untouched.
   * @returns whether a submit was written.
   */
  async submitParkedInput(): Promise<boolean> {
    if (this.promptSeen && this.promptTextSeen) return false
    this.atStartup('T6_PARK_RELEASE')
    await this.terminal.write('\r')
    return true
  }

  startSend(request: TerminalSendRequest): TerminalSendOperation {
    if (this.closing) throw new Error('PTY session is closing')
    if (this.statusValue.kind === 'exited') throw new Error('PTY session has exited')
    if (this.active !== undefined) {
      const draining = this.activeWrite !== undefined
        ? ' or draining provider write'
        : this.interrupting !== undefined
          ? ' or draining foreground interrupt'
          : ''
      throw new TerminalError(`PTY session already has an active send${draining}`, 'SEND_ACTIVE')
    }
    if (request.signal?.aborted === true) throw new Error('PTY send aborted before write')

    const operation = new LocalSendOperation(
      this.config.maxReadBytes,
      Date.now(),
      () => { this.interrupt(operation) },
      request,
    )
    this.active = operation
    this.resetReadinessEvidence()

    if (request.signal !== undefined) {
      const onAbort = (): void => { operation.cancel() }
      request.signal.addEventListener('abort', onAbort, { once: true })
      this.activeAbort = () => request.signal?.removeEventListener('abort', onAbort)
    }
    this.activeDeadlineTimer = setTimeout(() => {
      if (this.active === operation) {
        this.settleActive('timeout', this.activeWrite !== undefined
          || this.interrupting === operation
          || this.protocolWorkPending())
      }
    }, this.config.timeoutMs)
    void this.beginSend(operation, request)
    return operation
  }

  private async beginSend(operation: LocalSendOperation, request: TerminalSendRequest): Promise<void> {
    let foreground: SubprocessTerminalForeground | undefined
    try {
      if (this.protocolWorkPending()) await this.drainTerminalProtocol()
      const emulatorWrites = this.emulatorWrites
      const responseWrites = this.responseWrites
      foreground = await this.terminal.inspectForeground()
      if (this.protocolStateChanged(emulatorWrites, responseWrites)) {
        foreground = await this.inspectForegroundAfterProtocol()
      }
    } catch (error: unknown) {
      if (this.protocolWorkPending()) await this.drainTerminalProtocol()
      // A pre-write inspection failure while cancellation owns the slot must not
      // release it: interruptOnce's in-flight foreground signal could land on a
      // successor's foreground group. The interrupt path's post-signal tail
      // resumes polling, whose guarded catch propagates a persistent failure.
      // A retained settled operation implies that same in-flight interrupt, so
      // this guard admits only an unsettled active send.
      if (this.active === operation && !this.closing && this.interrupting !== operation) {
        this.failActive(error)
      }
      return
    }
    try {
      if (this.active !== operation || this.closing || this.interrupting === operation) return
      operation.setInitialForeground(foreground)
      const input = `${request.text}${request.submit ? '\r' : ''}`
      if (input.length > 0 && !operation.cancelRequested) {
        this.resetReadinessEvidence()
        const write = this.terminal.write(input)
        this.activeWrite = write.then(() => true, () => false)
        try {
          await write
        } finally {
          this.activeWrite = undefined
        }
      }
      // Cancellation owns post-write signalling and reservation release.
      if (operation.cancelRequested) return
      if (this.active === operation && operation.settled) {
        this.releaseSettledActive()
        return
      }
      // Closing can race the awaited provider write even though static analysis sees only local assignments.
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- awaited provider writes can close the session.
      if (this.active === operation && !this.closing) {
        this.pollingReady = operation
        this.schedulePoll(operation)
      }
    } catch (error: unknown) {
      if (this.active === operation && !this.closing) {
        if (operation.settled) this.releaseSettledActive()
        else this.failActive(error)
      }
    }
  }

  private resetReadinessEvidence(): void {
    this.lastOutputAt = Date.now()
    this.promptSeen = false
    this.promptTextSeen = false
    this.promptTail = ''
  }

  read(request: TerminalReadRequest): TerminalReadResult {
    const snapshot = this.scrollback.snapshot()
    const lines = snapshot.text.split('\n')
    const totalLines = snapshot.text.length === 0 ? 0 : lines.length
    const offset = request.offset ?? 0
    const count = request.count ?? 500
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('PTY read offset must be a non-negative safe integer')
    if (!Number.isSafeInteger(count) || count <= 0) throw new Error('PTY read count must be a positive safe integer')
    if (offset >= totalLines) {
      return { text: '', totalLines, lineBegin: offset, lineEnd: offset, truncated: snapshot.truncated }
    }
    const end = totalLines - offset
    const start = Math.max(0, end - count)
    const requested = lines.slice(start, end).join('\n')
    const bounded = utf8Tail(requested, this.config.maxReadBytes)
    const returnedLines = bounded.text.length === 0 ? 0 : bounded.text.split('\n').length
    return {
      text: bounded.text,
      totalLines,
      lineBegin: offset,
      lineEnd: offset + returnedLines,
      truncated: snapshot.truncated || bounded.truncated,
    }
  }

  async signal(signal: TerminalSignal): Promise<TerminalSignalResult> {
    if (this.closing) throw new Error('PTY session is closing')
    const targetPgid = await this.terminal.signalForeground(signal)
    return { delivered: true, targetPgid }
  }

  status(): TerminalSessionStatus {
    return this.statusValue
  }

  close(reason: string): Promise<void> {
    this.closing = true
    if (this.closePromise !== undefined) return this.closePromise
    const closing = this.closeOnce(reason).catch((error: unknown) => {
      this.closePromise = undefined
      this.failActive(error)
      throw error
    })
    this.closePromise = closing
    return closing
  }

  private readonly onTerminalData = (chunk: Buffer | Uint8Array | string): void => {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
    const data = this.decoder.decode(bytes, { stream: true })
    this.queueEmulatorData(data)
    this.onData(data)
  }

  private readonly onTerminalEnd = (): void => {
    this.onData(this.decoder.decode())
    this.appendOutput(this.sanitizer.flush())
    this.closeEmulator()
    this.outputEnded.resolve()
  }

  private readonly onTerminalError = (error: Error): void => {
    this.closeEmulator()
    this.onTransportFailure(error)
    this.outputEnded.resolve()
  }

  private onData(data: string): void {
    this.atStartupState(`T2_FIRST_OUTPUT bytes=${Buffer.byteLength(data, 'utf8')}`)
    const sanitized = this.sanitizer.push(data)
    this.appendOutput(sanitized.text)
    if (sanitized.prompt) {
      // TODO(pty-delayed-signal-prompt): With a reproducer, define a marker-generation boundary
      // before attributing a signal-delayed prompt to a later send.
      // Bash can print PROMPT_COMMAND before the kernel publishes its return
      // to the foreground process group. Retain the marker; polling below is
      // the authority that accepts it only after bash owns the foreground.
      this.promptSeen = true
      this.promptTail = ''
      this.lastOutputAt = Date.now()
      this.atStartup('T3_PROMPT_MARKER promptSeen=yes')
    }
    if (this.promptSeen && sanitized.promptTail !== undefined) {
      // The expected prompt text is the send's declared tail (a caller that
      // installed a custom shell prompt declares what its prompt emits) or the
      // session dialect's default controlled prompt.
      const expectedPrompt = this.active?.expectedPromptTail ?? CONTROLLED_PROMPT
      const remaining = Math.max(0, expectedPrompt.length + 1 - this.promptTail.length)
      const overflowed = sanitized.promptTail.length > remaining
      const overflowPart = sanitized.promptTail.slice(remaining)
      this.promptTail += sanitized.promptTail.slice(0, remaining)
      if (overflowed) this.promptTail = `${expectedPrompt}\0`
      // An overflow tail may carry trailing CR/LF the shell emitted after the
      // prompt text (Windows PSReadLine rendering); pure-whitespace extra
      // bytes still complete the prompt. Non-whitespace extra bytes are a
      // command echo, which must never be attributed as prompt readiness.
      const promptTextSeen = overflowed
        ? overflowPart.trim().length === 0
        : this.promptTail === expectedPrompt
      if (promptTextSeen && !this.promptTextSeen) this.atStartup('T4_PROMPT_TEXT promptTextSeen=yes')
      this.promptTextSeen = promptTextSeen
    }
  }

  private async onExit(outcome: SubprocessOutcome): Promise<void> {
    await this.outputEnded.promise
    if (this.transportFailure !== undefined) return
    this.statusValue = { kind: 'exited', exitCode: outcome.exitCode, signal: outcome.signal }
    this.settleActive('session_exit')
  }

  private onTransportFailure(error: unknown): void {
    const failure = error instanceof Error ? error : new Error(String(error))
    this.transportFailure ??= failure
    this.statusValue = { kind: 'exited', exitCode: null, signal: null }
    this.closeEmulator()
    this.failActive(failure)
    void this.terminal.terminate().catch(() => {})
  }

  private appendOutput(text: string): void {
    if (text.length === 0) return
    this.lastOutputAt = Date.now()
    this.scrollback.append(text)
    this.active?.append(text)
  }

  private schedulePoll(operation: LocalSendOperation, delayMs = this.config.pollIntervalMs): void {
    if (this.active !== operation || this.interrupting === operation || this.polling) return
    if (this.activeTimer !== undefined) clearTimeout(this.activeTimer)
    this.activeTimer = setTimeout(() => {
      this.activeTimer = undefined
      void this.pollReadiness(operation)
    }, delayMs)
  }

  private async pollReadiness(operation: LocalSendOperation): Promise<void> {
    if (this.active !== operation || this.polling) return
    this.polling = true
    try {
      if (this.statusValue.kind === 'exited') {
        this.settleActive('session_exit')
        return
      }
      if (this.protocolWorkPending()) await this.drainTerminalProtocol()
      const emulatorWrites = this.emulatorWrites
      const responseWrites = this.responseWrites
      let foreground = await this.terminal.inspectForeground()
      if (this.protocolStateChanged(emulatorWrites, responseWrites)) {
        foreground = await this.inspectForegroundAfterProtocol()
      }
      if (this.active !== operation || this.closing || this.interrupting === operation) return
      const idleFor = Date.now() - this.lastOutputAt
      if (this.promptSeen && foreground !== undefined && this.shellPgid === undefined) {
        this.shellPgid = foreground.processGroupId
      }
      if (this.promptSeen && this.promptTextSeen && idleFor >= this.config.pollIntervalMs
        && foreground?.processGroupId === this.shellPgid) {
        this.settleActive('stdin_read')
        return
      }
      const elapsed = Date.now() - operation.startedAt
      const startupHasOutput = !this.initializing || this.scrollback.snapshot().text.length > 0
      const acceptsStdinWait = startupHasOutput && foreground !== undefined
        && operation.acceptsStdinWait(foreground.processGroupId, foreground.inputWaiting)
      this.atStartupState(`fg=${foreground === undefined ? 'undef' : foreground.processGroupId} shellPgid=${this.shellPgid ?? 'undef'} inputWaiting=${String(foreground?.inputWaiting === true)} promptSeen=${this.promptSeen ? 'yes' : 'no'} promptTextSeen=${this.promptTextSeen ? 'yes' : 'no'} output=${startupHasOutput ? 'yes' : 'no'} idleForMs=${idleFor}`)
      if (elapsed >= this.config.exactProbeAfterMs && acceptsStdinWait) {
        this.settleActive('stdin_read')
        return
      }
      // A prompt candidate can race bash's foreground handoff, but an interactive
      // child also inherits PROMPT_COMMAND. Silence therefore remains the bound
      // on waiting for shell ownership instead of letting a child marker suppress
      // readiness until the absolute timeout. For pwsh the silence bound alone
      // settles before the first submitted pipeline has even been consumed on a
      // cold runner (PSReadLine warm-up), so the inferred handoff additionally
      // requires the foreground to be observed back in its stdin wait; bash
      // keeps the silence-only bound and settles on its prompt reprint.
      const handoffGrace = this.promptSeen ? this.config.handoffGraceMs : 0
      const handoffReady = startupHasOutput
        && (this.config.shellDialect !== 'pwsh' || acceptsStdinWait)
      if (handoffReady && idleFor >= this.config.idleSilenceMs + handoffGrace) {
        this.settleActive('inferred_idle')
      }
    } catch (error: unknown) {
      if (this.protocolWorkPending()) await this.drainTerminalProtocol()
      if (this.active === operation && !this.closing && this.interrupting !== operation) this.failActive(error)
    } finally {
      this.polling = false
      const active = this.active
      // Awaited provider inspection can clear or replace the active send despite static analysis.
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- awaited inspection can replace the active send.
      if (active !== undefined && this.pollingReady === active) this.schedulePoll(active)
    }
  }

  /** Wait until generated replies reach the provider before another send can publish. */
  private async drainTerminalProtocol(): Promise<void> {
    for (;;) {
      const emulatorWrites = this.emulatorWrites
      await emulatorWrites
      const responseWrites = this.responseWrites
      await responseWrites
      if (emulatorWrites === this.emulatorWrites && responseWrites === this.responseWrites
        && !this.protocolWorkPending()) return
    }
  }

  /** Sample foreground state only after protocol replies are quiet for the entire inspection. */
  private async inspectForegroundAfterProtocol(): Promise<SubprocessTerminalForeground | undefined> {
    for (;;) {
      if (this.protocolWorkPending()) await this.drainTerminalProtocol()
      const emulatorWrites = this.emulatorWrites
      const responseWrites = this.responseWrites
      const foreground = await this.terminal.inspectForeground()
      if (!this.protocolStateChanged(emulatorWrites, responseWrites)) return foreground
    }
  }

  private protocolStateChanged(emulatorWrites: Promise<void>, responseWrites: Promise<void>): boolean {
    return emulatorWrites !== this.emulatorWrites || responseWrites !== this.responseWrites
      || this.protocolWorkPending()
  }

  private protocolWorkPending(): boolean {
    return this.emulatorWriteDone !== undefined || this.pendingResponseWrites > 0
  }

  private queueEmulatorData(data: string): void {
    if (this.emulatorClosed) return
    this.emulatorBuffer += data
    if (this.emulatorWriteDone === undefined) {
      const idle = Promise.withResolvers<undefined>()
      this.emulatorWrites = idle.promise
      this.emulatorWriteDone = () => { idle.resolve(undefined) }
    }
    this.pumpEmulator()
  }

  private pumpEmulator(): void {
    if (this.emulatorWriting || this.emulatorClosed) return
    if (this.emulatorBuffer.length === 0) {
      const done = this.emulatorWriteDone
      this.emulatorWriteDone = undefined
      done?.()
      this.releaseSettledActive()
      return
    }
    const data = this.emulatorBuffer
    this.emulatorBuffer = ''
    this.emulatorWriting = true
    try {
      this.emulator.write(data, () => {
        this.emulatorWriting = false
        this.pumpEmulator()
      })
    } catch (error: unknown) {
      this.emulatorWriting = false
      this.emulatorBuffer = ''
      const done = this.emulatorWriteDone
      this.emulatorWriteDone = undefined
      done?.()
      this.releaseSettledActive()
      if (!this.closing) this.onTransportFailure(error)
    }
  }

  private finishResponseWrite(): void {
    this.pendingResponseWrites -= 1
    this.releaseSettledActive()
  }

  private releaseSettledActive(): void {
    const operation = this.active
    if (operation === undefined || !operation.settled || this.activeWrite !== undefined
      || this.interrupting === operation || this.protocolWorkPending()) return
    this.clearActive()
  }

  private closeEmulator(): void {
    if (this.emulatorClosed) return
    this.emulatorClosed = true
    this.emulatorBuffer = ''
    this.emulatorWriting = false
    const done = this.emulatorWriteDone
    this.emulatorWriteDone = undefined
    done?.()
    this.emulatorData.dispose()
    this.emulator.dispose()
  }

  private settleActive(waitReason: TerminalWaitReason, retainOwnership = false): void {
    const operation = this.active
    if (operation === undefined) return
    if (this.initializing) this.atStartup(`T7 settled: reason=${waitReason} status=${this.statusValue.kind}`)
    const scrollbackTruncated = this.scrollback.snapshot().truncated
    if (retainOwnership) {
      this.stopPolling()
      this.activeAbort?.()
      this.activeAbort = undefined
    } else {
      this.clearActive()
    }
    operation.settle(waitReason, this.statusValue, scrollbackTruncated)
  }

  private stopPolling(): void {
    this.stopReadinessPolling()
    if (this.activeDeadlineTimer !== undefined) clearTimeout(this.activeDeadlineTimer)
    this.activeDeadlineTimer = undefined
  }

  private stopReadinessPolling(): void {
    if (this.activeTimer !== undefined) clearTimeout(this.activeTimer)
    this.activeTimer = undefined
    this.pollingReady = undefined
  }

  private clearActive(): void {
    const operation = this.active
    this.stopPolling()
    this.activeAbort?.()
    this.activeAbort = undefined
    if (this.interrupting === operation) this.interrupting = undefined
    this.pollingReady = undefined
    this.active = undefined
  }

  private failActive(error: unknown): void {
    const operation = this.active
    if (operation === undefined) return
    this.clearActive()
    operation.fail(error)
  }

  private interrupt(operation: LocalSendOperation): void {
    if (this.active !== operation) return
    this.interrupting = operation
    this.stopReadinessPolling()
    void this.interruptOnce(operation)
  }

  private async interruptOnce(operation: LocalSendOperation): Promise<void> {
    try {
      const activeWrite = this.activeWrite
      if (activeWrite !== undefined && !await activeWrite) return
      await this.terminal.signalForeground('SIGINT')
    } catch (error: unknown) {
      if (this.active === operation && !this.closing) this.onTransportFailure(error)
      return
    } finally {
      if (this.interrupting === operation) this.interrupting = undefined
    }
    if (this.active === operation && operation.settled) {
      this.releaseSettledActive()
    } else if (this.active === operation && !this.closing) {
      this.pollingReady = operation
      this.schedulePoll(operation, 0)
    }
  }

  private async closeOnce(reason: string): Promise<void> {
    // Stop readiness polling but retain the active operation: teardown settles
    // it as session_exit below, so an in-flight send is never mis-settled as
    // stdin_read/inferred_idle/timeout during the grace period.
    this.stopPolling()
    this.closeEmulator()
    try {
      await this.terminal.terminate()
    } catch (error: unknown) {
      throw new Error(`PTY cleanup failed (${reason})`, { cause: error })
    }
    // Quiescence is the active send's terminal outcome.
    this.settleActive('session_exit')
    await this.completion
    this.terminal.output.off('data', this.onTerminalData)
    this.terminal.output.off('end', this.onTerminalEnd)
    this.terminal.output.off('error', this.onTerminalError)
    if (this.transportFailure !== undefined) throw this.transportFailure
  }
}
