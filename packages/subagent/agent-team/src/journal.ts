/** Serialized transactions over the exact Lead Session log. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEventMap, SessionId } from '@deepseek-ai/dsh-session'
import { foldTeam, type TeamEventType, type TeamFoldState } from './fold.ts'

/** Owns per-Lead transaction order and durable Team publication. */
export class TeamJournal {
  private readonly tails = new Map<SessionId, Promise<void>>()
  constructor(private readonly ctx: Context, private readonly onCommit: (root: Agent) => void) {}

  /**
   * Fold authoritative state for an exact live Lead.
   * @param root - live Lead Agent.
   * @returns replay state selected by its Team identity.
   */
  state(root: Agent): TeamFoldState { return foldTeam(root.id, root.session.events) }

  /**
   * Serialize one complete read-check-append operation for a Lead.
   * @param rootId - Lead identity selecting the queue.
   * @param operation - admitted asynchronous operation.
   * @returns the operation result.
   */
  async transact<T>(rootId: SessionId, operation: () => Promise<T>): Promise<T> {
    const run = (this.tails.get(rootId) ?? Promise.resolve()).then(operation, operation)
    const tail = run.then(() => undefined, () => undefined)
    this.tails.set(rootId, tail)
    try { return await run }
    finally { if (this.tails.get(rootId) === tail) this.tails.delete(rootId) }
  }

  /**
   * Append and flush a Team event before notifying observers.
   * @param root - exact live Lead owning the log.
   * @param type - Team event discriminant.
   * @param data - matching event payload.
   */
  async appendAndFlush<T extends TeamEventType>(root: Agent, type: T, data: SessionEventMap[T]): Promise<void> {
    root.session.append<TeamEventType>(type, data)
    await this.ctx.sessions.flush(root.session)
    this.onCommit(root)
  }
}
