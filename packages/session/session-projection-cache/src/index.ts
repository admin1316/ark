/**
 * Persisted projection cache (`ctx.sessionProjectionCache`): durable
 * checkpoints of every projection unit's state, one record per session on
 * the `session_projcache` domain (`per-record` layout — the shipped json
 * backend stores one document per session under its root). Reads and writes
 * share ONE coherent state: the domain's in-memory tables serve every read
 * synchronously, and each write lands on the domain's write chain (durability
 * first, then memory), so a read can never observe a disk write the memory
 * has not applied, or a memory value the disk does not hold. The cache is a
 * fold shortcut, never an authority: a row
 * is possibly stale (its `seq` says how stale) but never wrong, so every
 * write path is fail-soft (a lost write costs a longer tail replay on the
 * next cold read) and a `ver` mismatch discards the row instead of migrating
 * it. Design authority: the session-projection RFC
 * (.agents/notes/proposed/architecture/2026-07-27-session-projection-and-command-log.md).
 * @module @deepseek-ai/dsh-session-projection-cache
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { snapshotJsonValue } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type {
  ProjectionCheckpoint,
  ProjectionSnapshot,
  SessionProjectionMap,
} from '@deepseek-ai/dsh-session-projection'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { projectionCacheDomainSpec } from './spec.ts'
import type { CheckpointIdentity, CheckpointRecord } from './spec.ts'

export { checkpointIdentity, checkpointRecord, checkpointRow, projectionCacheDomainSpec } from './spec.ts'
export type { CheckpointIdentity, CheckpointRecord } from './spec.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionProjectionCache: SessionProjectionCache
  }
}

/**
 * Plugin config. Both throttle triggers are deployment choices with no
 * universally correct value, so the composition states them explicitly
 * (cordis.yml); the three mandatory write points (session creation,
 * `turn/end`, and session disposal) are policy, not tunables, and always
 * fire.
 */
export interface Config {
  /** Committed events per session that force a durable checkpoint write between mandatory points. */
  writeEveryEvents: number
  /** Longest time (milliseconds) a dirty checkpoint may stay unwritten between mandatory points. */
  writeIntervalMs: number
}

export const Config: z<Config> = z.object({
  writeEveryEvents: z.natural().min(1).required(),
  writeIntervalMs: z.natural().min(1).required(),
})

/** Per-session write-behind bookkeeping (live sessions only; dropped at retire). */
interface DirtyState {
  /** Committed events since the latest scheduled checkpoint. */
  pending: number
  /** Interval trigger armed at the first dirty event after a clean write. */
  timer: ReturnType<typeof setTimeout> | undefined
}

interface PendingCheckpoint {
  readonly record: CheckpointRecord
  readonly session?: Session
}

/** One durable write and one replaceable latest checkpoint for a session slot. */
interface CheckpointWriter {
  pending: PendingCheckpoint | undefined
  running: Promise<void> | undefined
}

/**
 * The persisted projection cache service. Opens the `session_projcache`
 * domain at init, checkpoints live sessions on a throttled write-behind
 * (count/interval triggers from {@link Config}) plus three mandatory points —
 * session creation, `turn/end`, and session disposal (the live-to-cold
 * moment) — and serves the
 * cached rows for a session header. Every durable write is fail-soft:
 * failures log a warning and the cache self-heals on the next write.
 */
export class SessionProjectionCache extends Service {
  static inject = ['storageDomain', 'sessionProjections', 'sessions']

  static Config: z<Config> = Config

  private table?: KvTable<SessionId, CheckpointRecord>
  private readonly dirty = new Map<Session, DirtyState>()
  private readonly writers = new Map<SessionId, CheckpointWriter>()
  private readonly observedWrites = new WeakSet<Promise<void>>()
  private closing = false

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'sessionProjectionCache')
  }

  /** Open the domain and install the write-behind listeners. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(projectionCacheDomainSpec)
    this.table = domain.table('sessions')
    this.ctx.effect(() => {
      const stopWrites = this.installWritePath()
      return async () => {
        try { await stopWrites() }
        finally { await domain.close() }
      }
    }, 'sessionProjectionCache.writeOwner')
  }

  /**
   * The stored record for one session, accepted only when its bound log
   * identity matches `expected`. A session id names a slot, not a lifecycle:
   * a recreated id or a persistence store swapped under a surviving cache
   * must not let an old record seed state folded from an unrelated log.
   * Synchronous from the domain's in-memory state — the same state every
   * write mutated, so a read can never go around the write chain to the
   * medium.
   * @param id - the session whose record is read.
   * @param expected - the log identity the caller holds (live or stored header).
   * @returns the identity-matching record, or `undefined` (absent or unrelated).
   */
  private recordFor(id: SessionId, expected: CheckpointIdentity): CheckpointRecord | undefined {
    const record = this.requireTable().get(id)
    if (record === undefined) return undefined
    return identityMatches(record.identity, expected) ? record : undefined
  }

  /**
   * The zero-I/O listing read: whole values viewed straight from the stored
   * rows (version-matching keys only), each cut carried with its watermark so
   * a client value store can seed under its higher-seq-wins rule — as stale
   * as the last durable checkpoint but never wrong, and never from an
   * unrelated log (the caller's header is the identity witness). Fresher
   * paths (the history tail baseline) supersede these values whenever a
   * session is actually opened.
   * @param meta - the listed session's header (identity witness; no log read).
   * @param keys - optional projection keys required by the caller's audience.
   * @returns the cut (`asOfSeq` = lowest served-row watermark), or
   *   `undefined` when no usable row exists for this lifecycle.
   */
  cachedSnapshot(
    meta: SessionHeader,
    keys?: readonly Extract<keyof SessionProjectionMap, string>[],
  ): ProjectionSnapshot | undefined {
    const record = this.recordFor(meta.id, identityOf(meta))
    if (record === undefined) return undefined
    const values = this.ctx.sessionProjections.viewCheckpoint(record.rows, keys)
    const servedKeys = Object.keys(values)
    if (servedKeys.length === 0) return undefined
    // The block carries ONE cut: the lowest served watermark is the seq every
    // value is at least current as of (under-claiming is safe under
    // higher-seq-wins; over-claiming would let a stale value outrank pushes).
    const asOfSeq = Math.min(...servedKeys.map(key => (record.rows[key] as { seq: number }).seq))
    return { asOfSeq, values }
  }

  /**
   * Hydrate projection cells for an already-prepared Session without another
   * persistence read. The cache seeds matching rows; the supplied exact log
   * advances every unit to the observation cut. No checkpoint is written
   * because the logical observation may contain recovery events not yet durable.
   * @param session - exact unpublished Session retained by persistence.
   * @param meta - observed lifecycle header.
   * @param events - exact logical event prefix represented by the observation.
   * @returns all projection values at the event cut.
   */
  hydratePrepared(
    session: Session,
    meta: SessionHeader,
    events: readonly SessionEvent[],
  ): ProjectionSnapshot {
    const record = this.recordFor(meta.id, identityOf(meta))
    if (record === undefined) {
      return this.ctx.sessionProjections.hydrate(session, {}, events, 0)
    }
    try {
      return this.ctx.sessionProjections.hydrate(session, record.rows, events, 0)
    } catch {
      // Cached rows are disposable derived data. Retry from the exact log so a
      // stale schema cannot make a valid Session unreadable.
      return this.ctx.sessionProjections.hydrate(session, {}, events, 0)
    }
  }

  /**
   * Capture a detached live cut and share its session's durable writer. A newer
   * pending cut may supersede it; the returned promise settles after the writer
   * drains. Canonical events flush before any live checkpoint reaches storage.
   * @param session - the live session to checkpoint.
   * @returns resolution after durability and event emission; rejects on failure or shutdown.
   */
  write(session: Session): Promise<void> {
    if (this.closing) return Promise.reject(new Error('session projection cache is closing'))
    try {
      const result = this.queueCheckpoint(session.id, this.checkpoint(identityOf(session.header),
        this.ctx.sessionProjections.checkpoint(session), session))
      this.markScheduled(session)
      return result
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error), { cause: error }))
    }
  }

  /**
   * Cold-read one session's projections from its complete log. Each unit is
   * seeded from the identity-checked cached rows — the registry skips `apply`
   * for the already-folded prefix (events at or below the row's `seq`) — and
   * the refreshed checkpoint is written back (fail-soft, fire-and-forget), so
   * the first cold read creates the cache row and later ones seed from it.
   * The caller supplies the complete log in seq order: this service never
   * consults the persistence layer.
   * @param meta - the stored session header (identity witness).
   * @param events - the session's complete log, in seq order.
   * @returns the projection cut at the log end.
   */
  coldSnapshot(meta: SessionHeader, events: readonly SessionEvent[]): ProjectionSnapshot {
    const restored = this.ctx.sessionProjections.restore(this.recordFor(meta.id, identityOf(meta))?.rows ?? {}, events, 0, meta)
    // Refresh the row so the next cold read seeds from it; fail-soft and
    // fire-and-forget — a failed write-back only costs a longer tail replay.
    this.observeWrite(this.put(meta.id, identityOf(meta), restored.checkpoint),
      `cold-read write-back for "${meta.id}"`)
    return restored.snapshot
  }


  // --- write-behind (throttle + mandatory points) ---

  private installWritePath(): () => Promise<void> {
    // Every committed event advances the dirty counter; turn/end is a
    // mandatory point (the durable value most reads want is the turn-final
    // one), count/interval throttle the in-turn stream.
    this.ctx.on('session/event', (session: Session, event: SessionEvent) => {
      if (event.type === 'turn/end') {
        this.flushSoft(session, 'turn/end')
        return
      }
      const state = this.dirty.get(session) ?? { pending: 0, timer: undefined }
      this.dirty.set(session, state)
      state.pending += 1
      if (state.pending >= this.config.writeEveryEvents) {
        this.flushSoft(session, 'count threshold')
        return
      }
      state.timer ??= setTimeout(() => {
        this.flushSoft(session, 'interval')
      }, this.config.writeIntervalMs)
    })

    // Creation is the FIRST mandatory point: a session that never talks (a
    // forked child seeded with its ancestor's title, say) would otherwise
    // get its first row only at detach — so a crash, or a fork held live in
    // the store, would leave the seed-derived values (the title) unreadable
    // on the cold list. The creation write captures the seed-derived cut.
    this.ctx.on('session/created', (session: Session) => {
      this.flushSoft(session, 'create')
    })

    // Detach (the live-to-cold moment): the final mandatory point. After
    // this write the cold-read ladder serves the session from the cache.
    // flushSoft's synchronous prefix reads and resets the dirty state, so
    // dropping it (timer already cleared by markScheduled) right after is safe.
    this.ctx.on('session/disposed', (session: Session) => {
      this.flushSoft(session, 'detach')
      this.markScheduled(session)
      this.dirty.delete(session)
    })

    // Close admission before awaiting writers. The domain stays open until
    // every captured cut, including a dirty tail, settles.
    return async () => {
      this.closing = true
      const captureFailures: unknown[] = []
      for (const [session, state] of this.dirty) {
        if (state.pending > 0) {
          try {
            void this.queueCheckpoint(session.id, this.checkpoint(identityOf(session.header),
              this.ctx.sessionProjections.checkpoint(session), session))
          } catch (error) { captureFailures.push(error) }
        }
      }
      for (const state of this.dirty.values()) {
        if (state.timer !== undefined) clearTimeout(state.timer)
      }
      this.dirty.clear()
      const results = await Promise.allSettled([...this.writers].map(([id, writer]) => this.startWriter(id, writer)))
      const failures: unknown[] = [...captureFailures]
      for (const result of results) {
        if (result.status === 'rejected') failures.push(result.reason)
      }
      if (failures.length > 0) throw new AggregateError(failures, 'session projection cache: final checkpoint drain failed')
    }
  }

  /**
   * One fail-soft durable checkpoint. Every caller has work by construction:
   * the throttle triggers only fire dirty (markScheduled clears the timer with
   * the counter) and the mandatory points write unconditionally.
   */
  private flushSoft(session: Session, trigger: string): void {
    this.observeWrite(this.write(session), `${trigger} write for "${session.id}"`)
  }

  /** Observe one shared writer once, regardless of the number of automatic triggers. */
  private observeWrite(write: Promise<void>, operation: string): void {
    if (this.observedWrites.has(write)) return
    this.observedWrites.add(write)
    void write.catch((error: unknown) => {
      this.ctx.logger.warn(`session projection cache: ${operation} failed (cache stays stale): ${String(error)}`)
    })
  }

  /** Reset the throttle; the writer retains the snapshot until durability succeeds. */
  private markScheduled(session: Session): void {
    const state = this.dirty.get(session)
    if (state === undefined) return
    state.pending = 0
    if (state.timer !== undefined) {
      clearTimeout(state.timer)
      state.timer = undefined
    }
  }

  private checkpoint(identity: CheckpointIdentity, rows: ProjectionCheckpoint, session?: Session): PendingCheckpoint {
    const detached = snapshotJsonValue(rows)
    if (detached === undefined) {
      throw new TypeError('projection checkpoint is not losslessly JSON-serializable (a unit state violates the plain-JSON contract)')
    }
    return { record: { identity, rows: detached as CheckpointRecord['rows'] },
      ...session === undefined || this.ctx.sessions.get(session.id) !== session ? {} : { session } }
  }

  /** Share one writer while replacing only checkpoints that have not started. */
  private put(id: SessionId, identity: CheckpointIdentity, rows: ProjectionCheckpoint, session?: Session): Promise<void> {
    if (this.closing) return Promise.reject(new Error('session projection cache is closing'))
    try {
      return this.queueCheckpoint(id, this.checkpoint(identity, rows, session))
    } catch (error) { return Promise.reject(error instanceof Error ? error : new Error(String(error), { cause: error })) }
  }

  private queueCheckpoint(id: SessionId, checkpoint: PendingCheckpoint): Promise<void> {
    const writer = this.writers.get(id) ?? { pending: undefined, running: undefined }
    writer.pending = checkpoint
    this.writers.set(id, writer)
    return this.startWriter(id, writer)
  }

  private startWriter(id: SessionId, writer: CheckpointWriter): Promise<void> {
    if (writer.running !== undefined) return writer.running
    const result = Promise.withResolvers<void>()
    writer.running = result.promise
    void this.drainWriter(id, writer).then(result.resolve, result.reject)
    return result.promise
  }

  private async drainWriter(id: SessionId, writer: CheckpointWriter): Promise<void> {
    try {
      while (writer.pending !== undefined) {
        const checkpoint = writer.pending
        writer.pending = undefined
        try {
          // The immutable cut must never land before its canonical events.
          if (checkpoint.session !== undefined && this.ctx.sessions.get(id) === checkpoint.session) {
            await this.ctx.sessions.flush(checkpoint.session)
          }
          await this.requireTable().put(id, checkpoint.record)
        } catch (error) {
          const retained = this.writers.get(id)?.pending ?? checkpoint
          writer.pending = retained.session !== undefined && this.ctx.sessions.get(id) !== retained.session
            ? { record: retained.record } : retained
          throw error
        }
      }
    } finally {
      writer.running = undefined
      if (writer.pending === undefined) this.writers.delete(id)
    }
  }

  private requireTable(): KvTable<SessionId, CheckpointRecord> {
    /* v8 ignore next -- Service.init assigns the table before the service becomes injectable */
    if (this.table === undefined) throw new Error('session projection cache is not initialized')
    return this.table
  }
}

/** Project a header onto the identity fields a record is bound to. */
function identityOf(header: SessionHeader): CheckpointIdentity {
  return { createdAt: header.createdAt, ...header.cwd === undefined ? {} : { cwd: header.cwd } }
}

/** Whether a stored record's bound identity names the caller's lifecycle. */
function identityMatches(stored: CheckpointIdentity, expected: CheckpointIdentity): boolean {
  return stored.createdAt === expected.createdAt && stored.cwd === expected.cwd
}

export default SessionProjectionCache
