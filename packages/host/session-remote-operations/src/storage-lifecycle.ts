/** Host-owned saving and explicit quit preparation over the existing persistence owner. */
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionQuitAttemptId, SessionRemoteStorageRequest, SessionRemoteStorageValue } from '@deepseek-ai/dsh-session'
import { SessionStorageUnavailable, waitForPersistenceOperation } from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-commands'

type QuitState = NonNullable<SessionRemoteStorageValue['quit']>
interface QuitAttempt { readonly id: SessionQuitAttemptId; readonly abort: AbortController; state: QuitState; done: Promise<void> }

/** One save retry and one quit attempt; neither creates a second writer or stores content. */
export class StorageLifecycle {
  private quit: QuitAttempt | undefined
  private retry: Promise<void> | undefined
  private quitEpoch = 0
  private activity = new AbortController()

  constructor(private readonly ctx: Context) {
    ctx.on('agent/publishing', ({ agent }) => { this.assertAdmission(agent.session) })
  }

  /** Signal for command execution, independent of a response transport lifetime. */
  get activitySignal(): AbortSignal { return this.activity.signal }

  /**
   * Fail before accepting new work; receipt confirmations bypass this gate.
   * @param session - optional exact live producer.
   */
  assertAdmission(session?: Session): void {
    if (this.quit !== undefined) throw new SessionStorageUnavailable('storage-closing')
    const state = this.persistence().writeState(session)
    if (state.phase !== 'healthy') throw new SessionStorageUnavailable(state.phase === 'pressured'
      ? 'storage-busy' : state.phase === 'closing' ? 'storage-closing' : state.errorCode)
  }

  /**
   * Handle authenticated state, retry and quit actions without retaining caller payload.
   * @param request - explicit action.
   * @returns current state; long operations remain owned here after response timeout.
   */
  handle(request: SessionRemoteStorageRequest): SessionRemoteStorageValue {
    if (request.kind === 'prepare-quit' || request.kind === 'cancel-quit') {
      if (!Number.isSafeInteger(request.epoch) || request.epoch < 0 || request.epoch > this.quitEpoch) {
        throw new Error('quit epoch must match the observed Host epoch')
      }
      if (request.epoch === this.quitEpoch) {
        if (request.attemptId.length === 0) throw new Error('quit attemptId must be non-empty')
        if (request.kind === 'prepare-quit') {
          if (this.quit !== undefined && this.quit.id !== request.attemptId) throw new Error('another quit attempt is active')
          if (this.quit === undefined || this.quit.state.phase === 'failed') this.beginQuit(request.attemptId)
        } else {
          if (this.quit?.id !== request.attemptId) throw new Error('quit attempt does not match')
          this.quit.abort.abort(new Error('quit cancelled'))
          this.quit = undefined
          this.quitEpoch += 1
          this.activity = new AbortController()
        }
      }
    } else if (request.kind === 'retry-save' && this.retry === undefined) {
      const operation = this.flushAll()
      this.retry = operation
      void operation.catch(() => {}).finally(() => {
        this.retry = undefined
      })
    }
    const session = request.kind === 'state' && request.sessionId !== undefined ? this.ctx.sessions.get(request.sessionId) : undefined
    return { quitEpoch: this.quitEpoch, write: this.persistence().writeState(session), retrying: this.retry !== undefined,
      quit: this.quit?.state ?? null }
  }

  private persistence() {
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) throw new SessionStorageUnavailable('storage-write-failed')
    return persistence
  }

  private async flushAll(): Promise<void> {
    await this.persistence().flushAll()
    const state = this.persistence().writeState()
    if (state.totalEvents !== 0) throw new SessionStorageUnavailable('storage-write-failed')
  }

  private beginQuit(id: SessionQuitAttemptId): void {
    const attempt: QuitAttempt = { id, abort: new AbortController(),
      state: { attemptId: id, phase: 'stopping', safeToQuit: false, errorCode: null }, done: Promise.resolve() }
    this.quit = attempt
    this.activity.abort(new Error('application quit requested'))
    const agents = this.ctx.agents.list()
    for (const agent of agents) agent.cancel({ kind: 'hook', reason: 'application quit requested' }, { keepInbox: true })
    attempt.done = (async () => {
      await waitForPersistenceOperation(Promise.all(agents.map(agent => agent.whenIdle())), attempt.abort.signal)
      await waitForPersistenceOperation(this.ctx.get('commands')?.whenSettled() ?? Promise.resolve(), attempt.abort.signal)
      if (this.quit !== attempt) return
      attempt.abort.signal.throwIfAborted()
      attempt.state = { ...attempt.state, phase: 'saving' }
      await waitForPersistenceOperation(this.flushAll(), attempt.abort.signal)
      if (this.quit !== attempt) return
      attempt.abort.signal.throwIfAborted()
      attempt.state = { ...attempt.state, phase: 'ready', safeToQuit: true }
    })().catch(() => {
      if (this.quit === attempt && !attempt.abort.signal.aborted) {
        attempt.state = { ...attempt.state, phase: 'failed', errorCode: 'storage-write-failed' }
      }
    })
  }
}
