/** Coordinator-owned accounting and cancellation-aware waits for unconfirmed writes. */
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionWriteQueueState } from './write-behind.ts'

/** Serialized-byte thresholds; these are not JavaScript heap limits. */
export interface SessionWritePressureConfig {
  readonly sessionHighBytes: number
  readonly sessionLowBytes: number
  readonly totalHighBytes: number
  readonly totalLowBytes: number
  readonly waitTimeoutMs: number
}

/** Resolved pressure defaults shared by concrete persistence providers. */
export const DEFAULT_WRITE_PRESSURE: SessionWritePressureConfig = Object.freeze({
  sessionHighBytes: 4 * 1024 * 1024, sessionLowBytes: 2 * 1024 * 1024,
  totalHighBytes: 32 * 1024 * 1024, totalLowBytes: 16 * 1024 * 1024, waitTimeoutMs: 30_000,
})

/** User-visible write health without event contents or backend exception strings. */
interface SessionWriteCounters {
  readonly events: number
  readonly bytes: number
  readonly totalEvents: number
  readonly totalBytes: number
  readonly oldestAt: number | null
  readonly lastSuccessAt: number | null
  readonly waitTimeoutMs: number
}

/** Health phases preserve the relationship between failures and their error codes. */
export type SessionWriteState = SessionWriteCounters & (
  | { readonly phase: 'healthy'; readonly errorCode: null }
  | { readonly phase: 'pressured'; readonly errorCode: null }
  | { readonly phase: 'failed'; readonly errorCode: 'storage-write-failed' | 'storage-stalled' }
  | { readonly phase: 'closing'; readonly errorCode: 'storage-write-failed' | 'storage-stalled' | null }
)

/** Stable failure used by admission and activity cancellation policies. */
export class SessionStorageUnavailable extends Error {
  constructor(readonly code: 'storage-busy' | 'storage-write-failed' | 'storage-stalled' | 'storage-closing') {
    super(code)
    this.name = 'SessionStorageUnavailable'
  }
}

/**
 * Resolve deployment thresholds once, before accepting writes.
 * @param config - provider configuration overrides.
 * @returns validated fixed thresholds.
 */
export function resolveWritePressure(config: Partial<SessionWritePressureConfig> = {}): SessionWritePressureConfig {
  const result = { ...DEFAULT_WRITE_PRESSURE, ...config }
  if (Object.values(result).some(value => !Number.isSafeInteger(value) || value <= 0)
    || result.sessionLowBytes >= result.sessionHighBytes || result.totalLowBytes >= result.totalHighBytes
    || result.sessionHighBytes > result.totalHighBytes || result.sessionLowBytes > result.totalLowBytes
    || result.waitTimeoutMs > 2_147_483_647) {
    throw new TypeError('writePressure requires positive integer thresholds, low < high and session <= total')
  }
  return Object.freeze(result)
}

const EMPTY: SessionWriteQueueState = Object.freeze({ events: 0, bytes: 0, oldestAt: null, lastSuccessAt: null, failed: false })

/** One coordinator owns exact-session accounting; waiters retain no event payload. */
export class WritePressure {
  private readonly states = new Map<Session, SessionWriteQueueState>()
  private readonly pressured = new Set<Session>()
  private readonly waiters = new Set<() => void>()
  private totalEvents = 0
  private totalBytes = 0
  private totalPressured = false
  private closing = false

  constructor(readonly config: SessionWritePressureConfig) {}

  /**
   * Publish a writer's acknowledgement-aware counters.
   * @param session - exact lifecycle owner.
   * @param state - counters including active writes.
   */
  update(session: Session, state: SessionWriteQueueState): void {
    const previous = this.states.get(session) ?? EMPTY
    this.totalEvents += state.events - previous.events
    this.totalBytes += state.bytes - previous.bytes
    this.states.set(session, state)
    if (state.bytes >= this.config.sessionHighBytes) this.pressured.add(session)
    else if (state.bytes <= this.config.sessionLowBytes) this.pressured.delete(session)
    if (this.totalBytes >= this.config.totalHighBytes) this.totalPressured = true
    else if (this.totalBytes <= this.config.totalLowBytes) this.totalPressured = false
    for (const wake of [...this.waiters]) wake()
  }

  /**
   * Read exact and aggregate counters without loading a session.
   * @param session - optional selected live session.
   * @returns safe operational health.
   */
  read(session?: Session): SessionWriteState {
    const own = session === undefined ? EMPTY : this.states.get(session) ?? EMPTY
    const all = session === undefined ? [...this.states.values()] : [own]
    const failed = all.some(state => state.failed)
    const oldest = all.reduce<number | null>((value, state) => state.oldestAt === null ? value
      : value === null ? state.oldestAt : Math.min(value, state.oldestAt), null)
    const oldestAt = session === undefined ? oldest : own.oldestAt
    const stalled = oldest !== null && Date.now() - oldest >= this.config.waitTimeoutMs
    const counters: SessionWriteCounters = { events: own.events, bytes: own.bytes, totalEvents: this.totalEvents,
      totalBytes: this.totalBytes, oldestAt, lastSuccessAt: own.lastSuccessAt, waitTimeoutMs: this.config.waitTimeoutMs }
    const errorCode = failed ? 'storage-write-failed' : stalled ? 'storage-stalled' : null
    if (this.closing) return { ...counters, phase: 'closing', errorCode }
    if (errorCode !== null) return { ...counters, phase: 'failed', errorCode }
    return { ...counters, phase: this.totalPressured || session !== undefined && this.pressured.has(session) ? 'pressured' : 'healthy',
      errorCode: null }
  }

  /**
   * Wait until low water, or reject without cancelling the owned writer.
   * @param session - exact producer lifecycle.
   * @param signal - caller wait cancellation.
   * @returns acknowledgement that production may continue.
   */
  wait(session: Session, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const initial = this.read(session)
    if (initial.phase === 'healthy') return Promise.resolve()
    if (initial.phase !== 'pressured') return Promise.reject(new SessionStorageUnavailable(initial.phase === 'closing'
      ? 'storage-closing' : initial.errorCode))
    return new Promise<void>((resolve, reject) => {
      let done = false
      const finish = (error?: Error): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        this.waiters.delete(wake)
        signal.removeEventListener('abort', abort)
        if (error === undefined) resolve(); else reject(error)
      }
      const wake = (): void => {
        const state = this.read(session)
        if (state.phase === 'healthy') finish()
        else if (state.phase !== 'pressured') finish(new SessionStorageUnavailable(state.phase === 'closing'
          ? 'storage-closing' : state.errorCode))
      }
      const abort = (): void => { finish(signal.reason instanceof Error ? signal.reason : new Error('aborted')) }
      const timer = setTimeout(() => { finish(new SessionStorageUnavailable('storage-stalled')) }, this.config.waitTimeoutMs)
      this.waiters.add(wake)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort(); else wake()
    })
  }

  /** Close production and release waiters; writers retain their own durability barriers. */
  close(): void { this.closing = true; for (const wake of [...this.waiters]) wake() }

  /**
   * Release settled lifecycle accounting only after its last write completes.
   * @param session - exact retired owner.
   */
  forget(session: Session): void {
    const state = this.states.get(session)
    if (state !== undefined && (state.events !== 0 || state.initializing)) throw new Error('cannot forget unconfirmed session writes')
    this.states.delete(session)
    this.pressured.delete(session)
  }
}
