/**
 * Workspace entity registry (`ctx.workspaceRegistry`): durable workspace records,
 * stable registry order, and header-validated session membership over the
 * domain data form.
 * @module @deepseek-ai/dsh-workspace
 */

import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { SessionPersistenceDeleteBlockedError } from '@deepseek-ai/dsh-session-persistence'
import type { DomainGlobal, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { WorkspaceEntity, WorkspaceMoveInvalidError } from './entity.ts'
import type { WorkspaceEntityHost } from './entity.ts'

export { WorkspaceMoveInvalidError } from './entity.ts'
import { realpathNormalize } from './paths.ts'
import { workspaceDomainSpec } from './spec.ts'
import type { WorkspaceDomainState, WorkspaceRecord } from './spec.ts'
import type { Workspace, WorkspaceId as WorkspaceIdBrand } from './types.ts'
import { workspaceRemoteCancelled } from './remote.ts'
import type {
  WorkspaceRemoteArchiveRequest, WorkspaceRemoteArchivedValue, WorkspaceRemoteCreateRequest, WorkspaceRemoteCreateValue,
  WorkspaceRemoteDeleteArchivedRequest, WorkspaceRemoteDeleteArchivedValue, WorkspaceRemoteDeleteRequest,
  WorkspaceRemoteDeletedValue, WorkspaceRemoteFailure, WorkspaceRemoteInsertBeforeRequest,
  WorkspaceRemoteInsertSessionBeforeRequest, WorkspaceRemoteListValue, WorkspaceRemoteOrderValue,
  WorkspaceRemoteRenameRequest, WorkspaceRemoteResult, WorkspaceRemoteView, WorkspaceRemoteWorkspaceValue, WorkspaceSessionRetirer,
} from './remote.ts'
export type * from './remote.ts'

export type { Workspace } from './types.ts'
export { workspaceDomainState, workspaceRecord, workspaceDomainSpec } from './spec.ts'
export type { WorkspaceDomainState, WorkspaceRecord } from './spec.ts'
export { realpathNormalize } from './paths.ts'

/** Identifies one workspace record (see `src/types.ts` for the brand rationale). */
export type WorkspaceId = WorkspaceIdBrand

/**
 * Brand a string as a {@link WorkspaceId}.
 * @param id - Raw workspace id string.
 * @returns the same string, branded at compile time.
 */
export function WorkspaceId(id: string): WorkspaceId {
  return id as WorkspaceId
}

/**
 * An archiveSession request named a session neither live nor in session
 * persistence — a definite miss only; storage faults propagate as themselves.
 */
export class WorkspaceUnknownSessionError extends Error {
  /**
   * @param sessionId - The unknown session id.
   */
  constructor(readonly sessionId: SessionId) {
    super(`cannot archive session '${sessionId}': live sessions and session persistence hold no such session`)
    this.name = 'WorkspaceUnknownSessionError'
  }
}

/** Permanent deletion requires an archived root and a cold, unreserved subtree. */
export class WorkspaceSessionDeletionBlockedError extends Error {
  /**
   * @param sessionId - Session whose deletion was refused.
   * @param reason - The archive, residency, or reservation condition preventing deletion.
   */
  constructor(
    readonly sessionId: SessionId,
    readonly reason: 'not-archived' | 'resident' | 'reserved',
  ) {
    const message = reason === 'not-archived'
      ? `cannot permanently delete session '${sessionId}': it is not archived`
      : reason === 'resident'
        ? `cannot permanently delete session '${sessionId}' while it is live or resident`
        : `cannot permanently delete session '${sessionId}' while resume holds a reservation`
    super(message)
    this.name = 'WorkspaceSessionDeletionBlockedError'
  }
}

/** A workspace reorder named a source or anchor absent from the durable registry order. */
export class WorkspaceOrderInvalidError extends Error {
  /**
   * @param workspaceId - Missing source or anchor id.
   */
  constructor(readonly workspaceId: WorkspaceId) {
    super(`cannot reorder unknown workspace '${workspaceId}'`)
    this.name = 'WorkspaceOrderInvalidError'
  }
}


declare module '@deepseek-ai/cordis' {
  interface Context {
    workspaceRegistry: WorkspaceRegistry
    workspaceSessionRetirer?: WorkspaceSessionRetirer
  }
  interface Events {
    /**
     * Committed archive overlay after a non-delete mutation.
     * @param archivedSessionIds - current archive identities in durable order.
     * @mode emit
     */
    'workspace/archived-sessions-changed'(archivedSessionIds: readonly SessionId[]): void
    /**
     * Permanently removed identity after log, account and archive commits.
     * @param sessionId - deleted identity.
     * @param archivedSessionIds - remaining archive overlay.
     * @mode emit
     */
    'workspace/session-deleted'(sessionId: SessionId, archivedSessionIds: readonly SessionId[]): void
  }
}

/** A rename would collide with another Workspace title. */
export class WorkspaceNameConflictError extends Error {
  constructor(readonly workspaceName: string) {
    super(`workspace display name ${JSON.stringify(workspaceName)} already exists`)
    this.name = 'WorkspaceNameConflictError'
  }
}

/** A rename supplied no visible title. */
export class WorkspaceTitleInvalidError extends Error {
  constructor() { super('workspace title must be non-empty'); this.name = 'WorkspaceTitleInvalidError' }
}

interface BootstrapGroup {
  readonly path: string
  readonly headers: SessionHeader[]
  readonly newestAt: number
}

const sameIds = (left: readonly WorkspaceId[], right: readonly WorkspaceId[]): boolean =>
  left.length === right.length && left.every((id, index) => id === right[index])

const compareHeaders = (left: SessionHeader, right: SessionHeader): number =>
  right.createdAt - left.createdAt || String(left.id).localeCompare(String(right.id))

function workspaceRemoteView(workspace: Workspace): WorkspaceRemoteView {
  return {
    workspaceId: workspace.id, path: workspace.path, title: workspace.title, sessionIds: [...workspace.sessionIds],
    createdAt: workspace.createdAt, updatedAt: workspace.updatedAt,
  }
}

function workspaceRemoteError(code: string, error: unknown, details: Record<string, string>): WorkspaceRemoteFailure {
  return { ok: false, error: { code, message: error instanceof Error ? error.message : String(error), details } }
}

function workspaceRemoteFailure(error: unknown): WorkspaceRemoteFailure | undefined {
  if (error instanceof WorkspaceOrderInvalidError) return workspaceRemoteError('workspace-not-found', error, { workspaceId: String(error.workspaceId) })
  if (error instanceof WorkspaceNameConflictError) return workspaceRemoteError('workspace-name-conflict', error, { name: error.workspaceName })
  if (error instanceof WorkspaceTitleInvalidError) return workspaceRemoteError('arguments-invalid', error, {})
  if (error instanceof WorkspaceMoveInvalidError) return workspaceRemoteError('workspace-move-invalid', error, {})
  if (error instanceof WorkspaceUnknownSessionError) return workspaceRemoteError('session-not-found', error, { sessionId: String(error.sessionId) })
  if (error instanceof WorkspaceSessionDeletionBlockedError) {
    return workspaceRemoteError('session-delete-blocked', error, { sessionId: String(error.sessionId), reason: error.reason })
  }
  return undefined
}

function workspaceCancelledAfterAwait(signal: AbortSignal): WorkspaceRemoteFailure | undefined {
  return signal.aborted ? workspaceRemoteCancelled() : undefined
}

/** Compute a validated descendant-first order without consuming the JavaScript call stack. */
function sessionDeletionPostOrder(rootSessionId: SessionId, headers: readonly SessionHeader[]): SessionId[] {
  const byId = new Map<SessionId, SessionHeader>()
  for (const header of headers) {
    const prior = byId.get(header.id)
    if (prior !== undefined && prior.parentSession !== header.parentSession) {
      throw new Error(`cannot permanently delete session '${rootSessionId}': session '${header.id}' has conflicting parent metadata`)
    }
    byId.set(header.id, header)
  }
  const children = new Map<SessionId, SessionId[]>()
  for (const header of byId.values()) {
    if (header.parentSession === undefined) continue
    const siblings = children.get(header.parentSession) ?? []
    siblings.push(header.id)
    children.set(header.parentSession, siblings)
  }
  for (const siblings of children.values()) siblings.sort((a, b) => String(a).localeCompare(String(b)))
  const visiting = new Set<SessionId>()
  const path: SessionId[] = []
  const order: SessionId[] = []
  const stack: { id: SessionId; exiting: boolean }[] = [{ id: rootSessionId, exiting: false }]
  while (stack.length > 0) {
    const frame = stack.pop()
    if (frame === undefined) break
    if (frame.exiting) {
      path.pop()
      visiting.delete(frame.id)
      order.push(frame.id)
      continue
    }
    if (visiting.has(frame.id)) {
      const start = path.indexOf(frame.id)
      throw new Error(`cannot permanently delete session '${rootSessionId}': retained lineage cycle ${[...path.slice(start), frame.id].join(' -> ')}`)
    }
    visiting.add(frame.id)
    path.push(frame.id)
    stack.push({ id: frame.id, exiting: true })
    for (const child of [...children.get(frame.id) ?? []].reverse()) stack.push({ id: child, exiting: false })
  }
  return order
}

/**
 * Durable workspace registry. Startup waits for `sessionPersistence`, builds
 * one canonical-cwd header index, and completes the one-time history
 * bootstrap before the service becomes active. The persistence dependency is
 * mandatory so an unavailable peer can never be mistaken for an empty
 * history and commit the initialized marker.
 */
export class WorkspaceRegistry extends TypertRemoteService {
  static inject = ['storageDomain', 'sessionPersistence']

  private table?: KvTable<WorkspaceId, WorkspaceRecord>
  private global?: DomainGlobal<WorkspaceDomainState>
  private state?: WorkspaceDomainState
  private readonly entities = new Map<WorkspaceId, WorkspaceEntity>()
  private readonly headers = new Map<SessionId, SessionHeader>()
  private readonly sessionPaths = new Map<SessionId, string>()
  private readonly invalidSessionPaths = new Map<SessionId, string>()
  private readonly sessionDeletionEpoch = new Map<SessionId, number>()
  private readonly deletingSessions = new Set<SessionId>()
  private operationTail: Promise<void> = Promise.resolve()

  private readonly host: WorkspaceEntityHost = {
    table: () => this.requireTable(),
    sessionPath: id => this.sessionPaths.get(id),
    readSessionHeader: id => this.readSessionHeader(id),
    rememberSessionPath: (id, path) => {
      this.sessionPaths.set(id, path)
      this.invalidSessionPaths.delete(id)
    },
  }

  constructor(ctx: Context) {
    super(ctx, 'workspaceRegistry', { namespace: 'workspace' })
  }

  /** Open the domain, finish bootstrap when required, and rebuild the ordered cache. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(workspaceDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'workspace.domainClose')
    this.table = domain.table('workspaces')
    this.global = domain.global
    this.state = domain.global.get()

    await this.recoverPendingMutation()
    this.validateStoredState(this.state)
    if (!this.state.initialized) {
      const headers = await this.ctx.sessionPersistence.list()
      await this.replaceHeaderIndex(headers)
      await this.bootstrap(headers)
    } else if (this.table.size > 0) {
      await this.replaceHeaderIndex(await this.ctx.sessionPersistence.list())
    }

    await this.indexLiveSessions()
    this.validateStoredState(this.requireState())
    this.rebuildEntities()
    this.reportFilteredCandidates()
  }

  /**
   * Create or reuse a workspace for an existing directory. The path is
   * canonicalized through `fs.realpath`; a nonexistent path rejects with the
   * original error and a non-directory rejects. Repeated calls for the same
   * canonical path return the existing entity without changing its title.
   * A newly created workspace is prepended to the durable registry order.
   * Different canonical paths may share a display title.
   * @param path - Existing directory to own, in any path spelling.
   * @param title - Display title used only when a new record is created.
   * @returns the existing or newly durable workspace.
   */
  async create(path: string, title?: string): Promise<Workspace> {
    return (await this.createOrResolve(path, title)).workspace
  }

  /**
   * Resolve canonical ownership and creation status in the same serialized operation.
   * @param path - existing directory.
   * @param title - initial title when a record is created.
   * @returns workspace and whether this operation created it.
   */
  async createOrResolve(path: string, title?: string): Promise<{ workspace: Workspace; created: boolean }> {
    const canonical = await realpathNormalize(path)
    if (!(await stat(canonical)).isDirectory()) {
      throw new Error(`cannot create a workspace at '${canonical}': path is not a directory`)
    }
    return await this.enqueueOperation(() => this.createCanonical(canonical, title))
  }

  /**
   * Look up a workspace by id.
   * @param id - Workspace id.
   * @returns the workspace, or `undefined` when unknown.
   */
  get(id: WorkspaceId): Workspace | undefined {
    return this.entities.get(id)
  }

  /**
   * Synchronous workspace projection in durable registry order. Every
   * entity's `sessionIds` getter is already filtered by the startup/live
   * canonical-cwd header index; this method performs no persistence reads.
   * @returns a fresh ordered array of workspace entities.
   */
  list(): Workspace[] {
    return this.requireState().workspaceIds.map((id) => {
      const entity = this.entities.get(id)
      if (entity === undefined) {
        throw new Error(`workspace registry order references missing workspace '${id}'`)
      }
      return entity
    })
  }

  /**
   * Project the native workspace list without persistence reads.
   * @param signal - request cancellation.
   * @returns durable rows and archive overlay.
   */
  @Remote('list')
  remoteExportList(signal: AbortSignal): WorkspaceRemoteResult<WorkspaceRemoteListValue> {
    if (signal.aborted) return workspaceRemoteCancelled()
    return { ok: true, value: { items: this.list().map(workspaceRemoteView), archivedSessionIds: [...this.archivedSessionIds] } }
  }

  /**
   * Create or resolve a workspace registration through the native API.
   * @param request - existing directory to own.
   * @param signal - cancellation.
   * @returns row and atomic creation flag.
   */
  @Remote('create')
  async remoteExportCreate(
    request: WorkspaceRemoteCreateRequest, signal: AbortSignal,
  ): Promise<WorkspaceRemoteResult<WorkspaceRemoteCreateValue>> {
    if (signal.aborted) return workspaceRemoteCancelled()
    try {
      const created = await this.createOrResolve(request.path)
      const cancellation = workspaceCancelledAfterAwait(signal)
      if (cancellation !== undefined) return cancellation
      return { ok: true, value: { workspace: workspaceRemoteView(created.workspace), created: created.created } }
    } catch (error) {
      const cancellation = workspaceCancelledAfterAwait(signal)
      if (cancellation !== undefined) return cancellation
      return workspaceRemoteError('workspace-invalid-path', error, { path: request.path })
    }
  }

  /**
   * Rename a registered workspace through the native API.
   * @param request - workspace and replacement title.
   * @param signal - cancellation.
   * @returns renamed row.
   */
  @Remote('rename')
  remoteExportRename(
    request: WorkspaceRemoteRenameRequest, signal: AbortSignal,
  ): Promise<WorkspaceRemoteResult<WorkspaceRemoteWorkspaceValue>> {
    return this.remoteOperation(signal, async () => ({
      workspace: workspaceRemoteView(await this.rename(request.workspaceId, request.title)),
    }))
  }

  /**
   * Remove a workspace registration without deleting files or session logs.
   * @param request - registration to remove.
   * @param signal - cancellation.
   * @returns confirmation; files and logs remain.
   */
  @Remote('delete')
  remoteExportDelete(
    request: WorkspaceRemoteDeleteRequest, signal: AbortSignal,
  ): Promise<WorkspaceRemoteResult<WorkspaceRemoteDeletedValue>> {
    return this.remoteOperation(signal, async () => {
      if (!await this.delete(request.workspaceId)) throw new WorkspaceOrderInvalidError(request.workspaceId)
      return { deleted: true }
    })
  }

  /**
   * Reorder a workspace through the native API.
   * @param request - workspace and optional anchor.
   * @param signal - cancellation.
   * @returns durable order.
   */
  @Remote('insertBefore')
  remoteExportInsertBefore(
    request: WorkspaceRemoteInsertBeforeRequest, signal: AbortSignal,
  ): Promise<WorkspaceRemoteResult<WorkspaceRemoteOrderValue>> {
    return this.remoteOperation(signal, async () => ({
      workspaceIds: [...await this.insertBefore(request.workspaceId, request.beforeWorkspaceId)],
    }))
  }

  /**
   * Reorder a session within its workspace account.
   * @param request - workspace, session and optional anchor.
   * @param signal - cancellation.
   * @returns updated account.
   */
  @Remote('insertSessionBefore')
  remoteExportInsertSessionBefore(
    request: WorkspaceRemoteInsertSessionBeforeRequest, signal: AbortSignal,
  ): Promise<WorkspaceRemoteResult<WorkspaceRemoteWorkspaceValue>> {
    return this.remoteOperation(signal, async () => {
      const workspace = this.get(request.workspaceId)
      if (workspace === undefined) throw new WorkspaceOrderInvalidError(request.workspaceId)
      await workspace.insertSessionBefore(request.sessionId, request.beforeSessionId)
      return { workspace: workspaceRemoteView(workspace) }
    })
  }

  /**
   * Archive a session through the native API while retaining its log.
   * @param request - session to archive.
   * @param signal - cancellation.
   * @returns committed archive overlay.
   */
  @Remote('archiveSession')
  remoteExportArchiveSession(
    request: WorkspaceRemoteArchiveRequest, signal: AbortSignal,
  ): Promise<WorkspaceRemoteResult<WorkspaceRemoteArchivedValue>> {
    return this.remoteOperation(signal, async () => {
      await this.archiveSession(request.sessionId)
      return { archivedSessionIds: [...this.archivedSessionIds] }
    })
  }

  /**
   * Restore an archived session to the visible workspace projection.
   * @param request - archived session to restore.
   * @param signal - cancellation.
   * @returns committed archive overlay.
   */
  @Remote('unarchiveSession')
  remoteExportUnarchiveSession(
    request: WorkspaceRemoteArchiveRequest, signal: AbortSignal,
  ): Promise<WorkspaceRemoteResult<WorkspaceRemoteArchivedValue>> {
    return this.remoteOperation(signal, async () => {
      await this.unarchiveSession(request.sessionId)
      return { archivedSessionIds: [...this.archivedSessionIds] }
    })
  }

  /**
   * Permanently delete an archived root through its existing lifecycle owners.
   * @param request - archived root to delete.
   * @param signal - cancellation.
   * @returns deletion and archive state.
   */
  @Remote('deleteArchivedSession')
  remoteExportDeleteArchivedSession(
    request: WorkspaceRemoteDeleteArchivedRequest, signal: AbortSignal,
  ): Promise<WorkspaceRemoteResult<WorkspaceRemoteDeleteArchivedValue>> {
    return this.remoteOperation(signal, async () => {
      const retirer = this.ctx.get('workspaceSessionRetirer')
      await this.deleteArchivedSession(
        request.sessionId, retirer === undefined ? undefined : id => retirer.retireArchivedSession(id, signal),
      )
      return { deleted: true, archivedSessionIds: [...this.archivedSessionIds] }
    })
  }

  private async remoteOperation<Value>(signal: AbortSignal, operation: () => Promise<Value>): Promise<WorkspaceRemoteResult<Value>> {
    if (signal.aborted) return workspaceRemoteCancelled()
    try {
      const value = await operation()
      return workspaceCancelledAfterAwait(signal) ?? { ok: true, value }
    } catch (error) {
      const cancellation = workspaceCancelledAfterAwait(signal)
      if (cancellation !== undefined) return cancellation
      const failure = workspaceRemoteFailure(error)
      if (failure !== undefined) return failure
      throw error
    }
  }

  /**
   * Persist a non-empty, unique workspace title before publishing it.
   * @param id - registered workspace.
   * @param title - visible replacement title.
   * @returns renamed workspace after durability.
   */
  rename(id: WorkspaceId, title: string): Promise<Workspace> {
    const normalized = title.trim()
    if (normalized.length === 0) throw new WorkspaceTitleInvalidError()
    return this.enqueueOperation(async () => {
      const workspace = this.entities.get(id)
      if (workspace === undefined) throw new WorkspaceOrderInvalidError(id)
      if (workspace.title === normalized) return workspace
      if (this.list().some(other => other.id !== id && other.title === normalized)) throw new WorkspaceNameConflictError(normalized)
      await workspace.setTitle(normalized)
      return workspace
    })
  }

  /**
   * Delete one workspace registration while retaining its directory and every
   * session log. The durable order is updated before the table deletion; a
   * failed table write restores the prior order and keeps the entity
   * published. Unknown ids are an idempotent no-op for domain callers.
   * @param id - Workspace registration to remove.
   * @returns `true` when a record was deleted, `false` when it was unknown.
   */
  delete(id: WorkspaceId): Promise<boolean> {
    return this.enqueueOperation(() => this.deleteKnown(id))
  }

  /**
   * Move one workspace within the durable display order, DOM-insertBefore-like.
   * With an anchor it lands before that workspace; without one it appends.
   * @param id - Workspace to move.
   * @param beforeId - Workspace anchor; omitted appends.
   * @returns the complete committed workspace order.
   */
  insertBefore(id: WorkspaceId, beforeId?: WorkspaceId): Promise<readonly WorkspaceId[]> {
    return this.enqueueOperation(async () => {
      const state = this.requireState()
      if (!state.workspaceIds.includes(id)) throw new WorkspaceOrderInvalidError(id)
      if (beforeId !== undefined && !state.workspaceIds.includes(beforeId)) {
        throw new WorkspaceOrderInvalidError(beforeId)
      }
      if (beforeId === id) return state.workspaceIds
      const without = state.workspaceIds.filter(workspaceId => workspaceId !== id)
      const at = beforeId === undefined ? without.length : without.indexOf(beforeId)
      const workspaceIds = [...without.slice(0, at), id, ...without.slice(at)]
      if (sameIds(workspaceIds, state.workspaceIds)) return state.workspaceIds
      await this.setState({ ...state, workspaceIds })
      return workspaceIds
    })
  }

  /**
   * The registry-global archive set: sessions hidden from every grouping
   * surface. Archiving never touches workspace accounting — an archived
   * session keeps its `sessionIds` slot so unarchiving restores its position.
   * @returns the archived session ids in archive order.
   */
  get archivedSessionIds(): readonly SessionId[] {
    return this.requireState().archivedSessionIds
  }

  /**
   * Capture the deletion generation before asynchronously loading a session.
   * @param sessionId - identity to observe.
   * @returns its in-process permanent-deletion generation.
   */
  sessionAdmissionRevision(sessionId: SessionId): number { return this.sessionDeletionEpoch.get(sessionId) ?? 0 }

  /**
   * Reject publication while a session is archived or its deletion raced the load.
   * @param sessionId - identity being published.
   * @param revision - generation captured before asynchronous work.
   */
  assertSessionAdmission(sessionId: SessionId, revision: number): void {
    if (this.requireState().archivedSessionIds.includes(sessionId)) throw new Error(`cannot publish session '${sessionId}' while it is archived`)
    if (this.deletingSessions.has(sessionId) || this.sessionAdmissionRevision(sessionId) !== revision) {
      throw new Error(`cannot publish session '${sessionId}': permanent deletion raced this lifecycle`)
    }
  }

  /**
   * Archive one session durably. The session must exist (live or in session
   * persistence); its workspace accounting — or lack of one — is irrelevant.
   * An already archived id resolves without writing.
   * @param sessionId - The session to archive.
   * @returns resolution after durability.
   */
  archiveSession(sessionId: SessionId): Promise<void> {
    return this.enqueueOperation(async () => {
      // The chain slot serializes against every other registry write, so this
      // check-then-write pair cannot interleave with another archive.
      if (this.requireState().archivedSessionIds.includes(sessionId)) return
      if (!(await this.sessionKnown(sessionId))) {
        throw new WorkspaceUnknownSessionError(sessionId)
      }
      const state = this.requireState()
      const archivedSessionIds = [...state.archivedSessionIds, sessionId]
      await this.setState({ ...state, archivedSessionIds })
      this.ctx.emit('workspace/archived-sessions-changed', archivedSessionIds)
    })
  }

  /**
   * Remove a known session from the durable archive overlay.
   * @param sessionId - archived identity to restore.
   * @returns settlement after durable archive removal.
   */
  unarchiveSession(sessionId: SessionId): Promise<void> {
    return this.enqueueOperation(async () => {
      const state = this.requireState()
      if (!state.archivedSessionIds.includes(sessionId)) return
      const live = this.ctx.get('sessions')?.get(sessionId)
      const persisted = (await this.ctx.sessionPersistence.list()).some(header => header.id === sessionId)
      if (live === undefined && !persisted) throw new WorkspaceUnknownSessionError(sessionId)
      const archivedSessionIds = state.archivedSessionIds.filter(id => id !== sessionId)
      await this.setState({ ...state, archivedSessionIds })
      this.ctx.emit('workspace/archived-sessions-changed', archivedSessionIds)
    })
  }

  /**
   * Delete an archived root and retained descendants before committing account and archive removal.
   * @param sessionId - archived root identity.
   * @param retireResident - exact lifecycle owner used to retire resident sessions.
   * @returns settlement after logs, derived cleanup, accounts and archive state commit.
   */
  deleteArchivedSession(sessionId: SessionId, retireResident?: (residentSessionId: SessionId) => Promise<void>): Promise<void> {
    return this.enqueueOperation(async () => {
      if (!this.requireState().archivedSessionIds.includes(sessionId)) throw new WorkspaceSessionDeletionBlockedError(sessionId, 'not-archived')
      const fenced = new Set<SessionId>()
      // Cached headers retain already-deleted descendants until account cleanup commits.
      const observedHeaders: SessionHeader[] = [...this.headers.values()]
      const fence = (id: SessionId): void => {
        this.sessionDeletionEpoch.set(id, this.sessionAdmissionRevision(id) + 1)
        this.deletingSessions.add(id)
        fenced.add(id)
      }
      fence(sessionId)
      try {
        let deletionOrder: SessionId[]
        for (;;) {
          const persisted = await this.ctx.sessionPersistence.list()
          const live = this.ctx.get('sessions')?.list().map(session => session.header) ?? []
          observedHeaders.push(...persisted, ...live)
          deletionOrder = sessionDeletionPostOrder(sessionId, observedHeaders)
          const newlyFenced = deletionOrder.filter(id => !fenced.has(id))
          for (const id of newlyFenced) fence(id)
          if (newlyFenced.length === 0) break
        }
        for (const id of deletionOrder) {
          if (this.ctx.get('sessions')?.get(id) === undefined) continue
          if (retireResident === undefined) throw new WorkspaceSessionDeletionBlockedError(id, 'resident')
          await retireResident(id)
          if (this.ctx.get('sessions')?.get(id) !== undefined) throw new WorkspaceSessionDeletionBlockedError(id, 'resident')
        }
        for (const id of deletionOrder) {
          try { await this.ctx.sessionPersistence.delete(id) }
          catch (error) {
            if (!(error instanceof SessionPersistenceDeleteBlockedError)) throw error
            throw new WorkspaceSessionDeletionBlockedError(id, error.reason === 'live' ? 'resident' : 'reserved')
          }
        }
        for (const workspace of this.entities.values()) for (const id of deletionOrder) await workspace.detachSession(id)
        const deleted = new Set(deletionOrder)
        const committed = this.requireState()
        const archivedSessionIds = committed.archivedSessionIds.filter(id => !deleted.has(id))
        await this.setState({ ...committed, archivedSessionIds })
        for (const id of deletionOrder) {
          this.headers.delete(id)
          this.sessionPaths.delete(id)
          this.invalidSessionPaths.delete(id)
        }
        for (const id of deletionOrder) this.ctx.emit('workspace/session-deleted', id, archivedSessionIds)
      } finally {
        for (const id of fenced) this.deletingSessions.delete(id)
      }
    })
  }

  /**
   * Whether a session is live, header-indexed, or present in a fresh
   * persistence listing. Only a definite miss returns false — a failing
   * `sessionPersistence.list()` propagates so storage faults never
   * masquerade as an unknown session.
   */
  private async sessionKnown(id: SessionId): Promise<boolean> {
    if (this.ctx.get('sessions')?.get(id) !== undefined) return true
    if (this.headers.has(id)) return true
    await this.indexHeaders(await this.ctx.sessionPersistence.list())
    return this.headers.has(id)
  }

  /**
   * Resolve by canonical directory path without creating or mutating a
   * workspace. A missing path rejects during `realpath`; an existing unowned
   * directory returns `undefined`.
   * @param path - Existing directory path in any spelling.
   * @returns the workspace owning the canonical path, when one exists.
   */
  async resolveByPath(path: string): Promise<Workspace | undefined> {
    const canonical = await realpathNormalize(path)
    for (const entity of this.entities.values()) {
      if (entity.path === canonical) return entity
    }
    return undefined
  }

  private async createCanonical(canonical: string, title?: string): Promise<{ workspace: WorkspaceEntity; created: boolean }> {
    for (const entity of this.entities.values()) {
      if (entity.path === canonical) return { workspace: entity, created: false }
    }

    const workspaceName = title ?? basename(canonical)
    const table = this.requireTable()
    const state = this.requireState()
    const id = WorkspaceId(randomUUID())
    const now = new Date().toISOString()
    const record: WorkspaceRecord = {
      path: canonical,
      title: workspaceName,
      sessionIds: [],
      createdAt: now,
      updatedAt: now,
    }
    const entity = new WorkspaceEntity(this.host, id, record)
    this.entities.set(id, entity)
    const pendingState: WorkspaceDomainState = {
      ...state,
      pendingMutation: { operation: 'create', workspaceId: id },
    }
    try {
      await this.setState(pendingState)
    } catch (error) {
      this.entities.delete(id)
      throw error
    }
    try {
      await table.put(id, record)
    } catch (error) {
      this.entities.delete(id)
      try {
        await this.setState(state)
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `workspace '${id}' record write and pending-marker rollback both failed`,
        )
      }
      throw error
    }

    try {
      await this.setState({
        initialized: true,
        workspaceIds: [id, ...state.workspaceIds],
        archivedSessionIds: state.archivedSessionIds,
      })
    } catch (error) {
      this.entities.delete(id)
      try {
        await table.delete(id)
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `workspace '${id}' order write and record rollback both failed; the pending marker remains recoverable`,
        )
      }
      try {
        await this.setState(state)
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `workspace '${id}' order write and pending-marker rollback both failed`,
        )
      }
      throw error
    }
    return { workspace: entity, created: true }
  }

  private async deleteKnown(id: WorkspaceId): Promise<boolean> {
    const entity = this.entities.get(id)
    if (entity === undefined) return false
    const state = this.requireState()
    const nextState = {
      initialized: true,
      workspaceIds: state.workspaceIds.filter(workspaceId => workspaceId !== id),
      archivedSessionIds: state.archivedSessionIds,
    }
    await this.setState({
      ...nextState,
      pendingMutation: { operation: 'delete', workspaceId: id },
    })
    this.entities.delete(id)
    try {
      await this.requireTable().delete(id)
    } catch (error) {
      this.entities.set(id, entity)
      try {
        await this.setState(state)
      } catch (rollbackError) {
        // The durable marker still says to finish deletion, so the cache must
        // agree with that recoverable direction rather than republish a row
        // absent from the persisted order.
        this.entities.delete(id)
        throw new AggregateError(
          [error, rollbackError],
          `workspace '${id}' record deletion and registry-order rollback both failed`,
        )
      }
      throw error
    }
    try {
      await this.setState(nextState)
    } catch (error) {
      // The deletion committed at the table write and was already published
      // to Host streams. Keep the durable marker for startup recovery rather
      // than reporting failure after the requested state became true.
      this.ctx.logger.warn(
        `workspace '${id}' was deleted but its pending marker could not be cleared: ${String(error)}`,
      )
    }
    return true
  }

  /**
   * Complete the one mutation explicitly named by durable state. Unexplained
   * order/table divergence still reaches {@link validateStoredState} and
   * fails loud; this path never guesses which operation created a row from its shape alone.
   */
  private async recoverPendingMutation(): Promise<void> {
    const state = this.requireState()
    const pending = state.pendingMutation
    if (pending === undefined) return
    if (state.workspaceIds.includes(pending.workspaceId)) {
      throw new Error(
        `workspace domain is inconsistent: pending ${pending.operation} workspace `
        + `'${pending.workspaceId}' is still present in registry order`,
      )
    }
    await this.requireTable().delete(pending.workspaceId)
    await this.setState({
      initialized: state.initialized,
      workspaceIds: state.workspaceIds,
      archivedSessionIds: state.archivedSessionIds,
    })
  }

  private async bootstrap(headers: readonly SessionHeader[]): Promise<void> {
    const table = this.requireTable()
    const state = this.requireState()
    const groupsByPath = new Map<string, SessionHeader[]>()
    for (const header of headers) {
      const path = this.sessionPaths.get(header.id)
      if (path === undefined) continue
      const group = groupsByPath.get(path)
      if (group === undefined) groupsByPath.set(path, [header])
      else group.push(header)
    }
    const groups: BootstrapGroup[] = [...groupsByPath].map(([path, groupHeaders]) => {
      groupHeaders.sort(compareHeaders)
      const newest = groupHeaders[0] as SessionHeader
      return { path, headers: groupHeaders, newestAt: newest.createdAt }
    }).sort((left, right) =>
      right.newestAt - left.newestAt || left.path.localeCompare(right.path))

    const byPath = new Map<string, WorkspaceId>()
    const accounted = new Map<SessionId, WorkspaceId>()
    for (const [id, record] of table.entries()) {
      byPath.set(record.path, id)
      for (const sessionId of record.sessionIds) accounted.set(sessionId, id)
    }

    for (const group of groups) {
      let id = byPath.get(group.path)
      if (id === undefined) {
        const sessionIds = group.headers
          .map(header => header.id)
          .filter(sessionId => !accounted.has(sessionId))
        if (sessionIds.length === 0) continue
        id = WorkspaceId(randomUUID())
        const createdAt = new Date(group.newestAt).toISOString()
        const record: WorkspaceRecord = {
          path: group.path,
          title: basename(group.path),
          sessionIds,
          createdAt,
          updatedAt: createdAt,
        }
        await table.put(id, record)
        byPath.set(group.path, id)
        for (const sessionId of sessionIds) accounted.set(sessionId, id)
        continue
      }

      const current = table.get(id) as WorkspaceRecord
      const historical = group.headers
        .map(header => header.id)
        .filter(sessionId => accounted.get(sessionId) === undefined || accounted.get(sessionId) === id)
      const historicalSet = new Set(historical)
      const sessionIds = [
        ...historical,
        ...current.sessionIds.filter(sessionId => !historicalSet.has(sessionId)),
      ]
      if (sameSessionIds(current.sessionIds, sessionIds)) continue
      await table.update(id, record => ({
        ...record,
        sessionIds,
        updatedAt: new Date().toISOString(),
      }))
      for (const sessionId of historical) accounted.set(sessionId, id)
    }

    const groupRank = new Map(groups.map(group => [group.path, group.newestAt]))
    const priorRank = new Map(state.workspaceIds.map((id, index) => [id, index]))
    const workspaceIds = [...table.entries()]
      .sort(([leftId, left], [rightId, right]) => {
        const leftTime = groupRank.get(left.path) ?? Date.parse(left.createdAt)
        const rightTime = groupRank.get(right.path) ?? Date.parse(right.createdAt)
        return rightTime - leftTime
          || (priorRank.get(leftId) ?? Number.MAX_SAFE_INTEGER)
            - (priorRank.get(rightId) ?? Number.MAX_SAFE_INTEGER)
          || String(leftId).localeCompare(String(rightId))
      })
      .map(([id]) => id)

    if (!sameIds(state.workspaceIds, workspaceIds)) {
      await this.setState({ initialized: false, workspaceIds, archivedSessionIds: state.archivedSessionIds })
    }
    await this.setState({ initialized: true, workspaceIds, archivedSessionIds: state.archivedSessionIds })
  }

  private validateStoredState(state: WorkspaceDomainState): void {
    const table = this.requireTable()
    const order = new Set<WorkspaceId>()
    for (const id of state.workspaceIds) {
      if (order.has(id)) {
        throw new Error(`workspace domain is inconsistent: registry order repeats workspace '${id}'`)
      }
      if (table.get(id) === undefined) {
        throw new Error(`workspace domain is inconsistent: registry order references missing workspace '${id}'`)
      }
      order.add(id)
    }
    if (state.initialized && order.size !== table.size) {
      const orphan = [...table.keys()].find(id => !order.has(id))
      throw new Error(
        `workspace domain is inconsistent: workspace '${orphan as WorkspaceId}' is absent from registry order`,
      )
    }

    const paths = new Map<string, WorkspaceId>()
    const accounted = new Map<SessionId, WorkspaceId>()
    for (const [id, record] of table.entries()) {
      const pathHolder = paths.get(record.path)
      if (pathHolder !== undefined) {
        throw new Error(
          `workspace domain is inconsistent: path '${record.path}' is claimed `
          + `by both workspace '${pathHolder}' and workspace '${id}'`,
        )
      }
      paths.set(record.path, id)
      for (const sessionId of record.sessionIds) {
        const holder = accounted.get(sessionId)
        if (holder !== undefined) {
          throw new Error(
            `workspace domain is inconsistent: session '${sessionId}' is accounted `
            + `by both workspace '${holder}' and workspace '${id}'`,
          )
        }
        accounted.set(sessionId, id)
      }
    }
  }

  private rebuildEntities(): void {
    this.entities.clear()
    for (const id of this.requireState().workspaceIds) {
      const record = this.requireTable().get(id) as WorkspaceRecord
      this.entities.set(id, new WorkspaceEntity(this.host, id, record))
    }
  }

  private async replaceHeaderIndex(headers: readonly SessionHeader[]): Promise<void> {
    this.headers.clear()
    this.sessionPaths.clear()
    this.invalidSessionPaths.clear()
    await this.indexHeaders(headers)
  }

  private async indexHeaders(headers: readonly SessionHeader[]): Promise<void> {
    for (const header of headers) await this.indexHeader(header)
  }

  private async indexHeader(header: SessionHeader): Promise<void> {
    this.headers.set(header.id, header)
    this.sessionPaths.delete(header.id)
    if (header.cwd === undefined) {
      this.invalidSessionPaths.set(header.id, 'header has no cwd')
      return
    }
    try {
      const path = await realpathNormalize(header.cwd)
      if (!(await stat(path)).isDirectory()) {
        this.invalidSessionPaths.set(header.id, `cwd '${header.cwd}' is not a directory`)
        return
      }
      this.sessionPaths.set(header.id, path)
      this.invalidSessionPaths.delete(header.id)
    } catch {
      this.invalidSessionPaths.set(header.id, `cwd '${header.cwd}' does not resolve`)
    }
  }

  private async indexLiveSessions(): Promise<void> {
    const sessions = this.ctx.get('sessions')
    if (sessions === undefined) return
    await this.indexHeaders(sessions.list().map(session => session.header))
  }

  private reportFilteredCandidates(): void {
    for (const entity of this.entities.values()) {
      const record = this.requireTable().get(entity.id) as WorkspaceRecord
      for (const sessionId of record.sessionIds) {
        const path = this.sessionPaths.get(sessionId)
        if (path === record.path) continue
        const reason = this.invalidSessionPaths.get(sessionId)
          ?? (this.headers.has(sessionId)
            ? `canonical cwd '${path}' differs from workspace path '${record.path}'`
            : 'session header is missing')
        this.ctx.logger.warn(
          `workspace '${entity.id}' filtered session '${sessionId}' from membership: ${reason}`,
        )
      }
    }
  }

  private async readSessionHeader(id: SessionId): Promise<SessionHeader> {
    const live = this.ctx.get('sessions')?.get(id)
    if (live !== undefined) {
      this.headers.set(id, live.header)
      return live.header
    }
    const cached = this.headers.get(id)
    if (cached !== undefined) return cached

    const headers = await this.ctx.sessionPersistence.list()
    await this.indexHeaders(headers)
    const header = this.headers.get(id)
    if (header === undefined) {
      throw new Error(`cannot validate session '${id}': session persistence holds no such session`)
    }
    return header
  }

  private requireTable(): KvTable<WorkspaceId, WorkspaceRecord> {
    if (this.table === undefined) throw new Error('workspace registry is not started yet')
    return this.table
  }

  private requireState(): WorkspaceDomainState {
    if (this.state === undefined) throw new Error('workspace registry is not started yet')
    return this.state
  }

  private async setState(state: WorkspaceDomainState): Promise<void> {
    await (this.global as DomainGlobal<WorkspaceDomainState>).set(state)
    this.state = state
  }

  private enqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(async () => {
      // A committed delete may leave only its marker cleanup pending. Retry
      // recovery before another create/delete can overwrite that pending operation record.
      await this.recoverPendingMutation()
      return await operation()
    })
    this.operationTail = result.then(() => {}, () => {})
    return result
  }
}

const sameSessionIds = (left: readonly SessionId[], right: readonly SessionId[]): boolean =>
  left.length === right.length && left.every((id, index) => id === right[index])

export default WorkspaceRegistry
