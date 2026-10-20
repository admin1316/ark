/** Ordered, lossless live-session writes with explicit atomic group boundaries. */
import { Buffer } from 'node:buffer'
import type { SessionAtomicGroup, SessionEvent } from '@deepseek-ai/dsh-session'

/** Unconfirmed work includes the active batch until its durable acknowledgement. */
export interface SessionWriteQueueState {
  readonly initializing?: boolean
  readonly events: number
  readonly bytes: number
  readonly oldestAt: number | null
  readonly lastSuccessAt: number | null
  readonly failed: boolean
}

/** Dependencies and scheduling policy for one live session's write controller. */
export interface SessionWriteBehindOptions {
  readonly maxDelayMs: number
  readonly write: (events: readonly SessionEvent[], atomicGroups: readonly SessionAtomicGroup[]) => Promise<void>
  readonly reportBackgroundFailure: (error: unknown) => void
  readonly stateChanged?: (state: SessionWriteQueueState) => void
}

/** One writer owns retained events, group boundaries and every durability barrier. */
export class SessionWriteBehind {
  private pending: SessionEvent[] = []
  private groups: SessionAtomicGroup[] = []
  private pendingSince: number | null = null
  private timer: ReturnType<typeof setTimeout> | undefined
  private active: Promise<void> | undefined
  private barrier: Promise<void> | undefined
  private deadlineExpired = false
  private automaticPaused = false
  private eventCount = 0
  private byteCount = 0
  private oldestAt: number | null = null
  private lastSuccessAt: number | null = null
  private failed = false

  constructor(private readonly options: SessionWriteBehindOptions) {}

  /** Whether retained or actively written events still need acknowledgement. */
  get hasWork(): boolean { return this.eventCount > 0 || this.active !== undefined }

  /** Detached accounting snapshot, never a copy of event payloads. */
  get state(): SessionWriteQueueState {
    return { events: this.eventCount, bytes: this.byteCount, oldestAt: this.oldestAt,
      lastSuccessAt: this.lastSuccessAt, failed: this.failed }
  }

  /**
   * Retain one ordinary event.
   * @param event - committed canonical event.
   */
  enqueue(event: SessionEvent): void { this.enqueueBatch([event], false) }

  /**
   * Retain a complete commit without splitting its atomic boundary.
   * @param events - contiguous committed events.
   * @param atomic - whether all events must recover as one group.
   */
  enqueueBatch(events: readonly SessionEvent[], atomic: boolean): void {
    const first = events[0]
    if (first === undefined) return
    const wasEmpty = this.pending.length === 0
    const copies = events.map(event => structuredClone(event))
    const now = Date.now()
    this.pending.push(...copies)
    if (atomic) this.groups.push({ firstSeq: first.seq, count: copies.length })
    this.pendingSince ??= now
    this.oldestAt ??= now
    this.eventCount += copies.length
    this.byteCount += copies.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event)), 0)
    this.publish()
    if (this.barrier !== undefined) return
    if (this.automaticPaused) {
      this.automaticPaused = false
      this.deadlineExpired = false
      this.armTimer()
    } else if (wasEmpty) this.armTimer()
  }

  /**
   * Drain through quiescence. Cancelling a caller never cancels this owned write.
   * @returns the shared durability acknowledgement.
   */
  flush(): Promise<void> {
    if (this.barrier !== undefined) return this.barrier
    this.cancelTimer()
    this.deadlineExpired = false
    this.automaticPaused = false
    const barrier = Promise.withResolvers<void>()
    this.barrier = barrier.promise
    void this.drainBarrier(barrier.resolve, barrier.reject)
    return barrier.promise
  }

  /** Cancel scheduling without dropping retained work. */
  cancelAutomaticWait(): void { this.cancelTimer(); this.deadlineExpired = false }

  private publish(): void { this.options.stateChanged?.(this.state) }
  private armTimer(): void {
    this.cancelTimer()
    this.timer = setTimeout(() => { this.onDeadline() }, this.options.maxDelayMs)
  }
  private cancelTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }
  private onDeadline(): void {
    this.timer = undefined
    if (this.active !== undefined) { this.deadlineExpired = true; return }
    this.startBackground()
  }
  private startBackground(): void {
    void this.startWrite(true).then(() =>{  this.continueAutomatic() }, () => {})
  }
  private continueAutomatic(): void {
    if (this.barrier !== undefined || this.pending.length === 0) return
    if (this.deadlineExpired) { this.deadlineExpired = false; this.startBackground() }
  }
  private async drainBarrier(resolve: () => void, reject: (reason?: unknown) => void): Promise<void> {
    try {
      if (this.active !== undefined) {
        await Promise.allSettled([this.active])
        this.automaticPaused = false
      }
      while (this.pending.length > 0) await this.startWrite(false)
    } catch (error: unknown) {
      this.barrier = undefined
      reject(error)
      return
    }
    this.barrier = undefined
    resolve()
  }
  private startWrite(background: boolean): Promise<void> {
    const batch = this.pending.splice(0)
    const groups = this.groups.splice(0)
    const since = this.pendingSince
    this.pendingSince = null
    const bytes = batch.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event)), 0)
    this.cancelTimer()
    this.deadlineExpired = false
    const active = Promise.resolve().then(() => this.options.write(batch, groups)).then(() => {
      this.eventCount -= batch.length
      this.byteCount -= bytes
      this.oldestAt = this.pendingSince
      this.lastSuccessAt = Date.now()
      this.failed = false
      this.publish()
    }).catch((error: unknown) => {
      this.pending = batch.concat(this.pending)
      this.groups = groups.concat(this.groups)
      this.pendingSince = since
      this.oldestAt = this.pendingSince
      this.failed = true
      this.cancelTimer()
      this.deadlineExpired = false
      this.automaticPaused = true
      this.publish()
      if (background) this.options.reportBackgroundFailure(error)
      throw error
    }).finally(() => { this.active = undefined })
    this.active = active
    return active
  }
}
