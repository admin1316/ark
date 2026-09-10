/**
 * Workspace entity registry (`ctx.workspaceRegistry`): durable workspace records,
 * stable registry order, and header-validated session membership over the
 * domain data form.
 * @module @deepseek-ai/dsh-workspace
 */
import { Context, Service } from '@deepseek-ai/cordis';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { SessionId } from '@deepseek-ai/dsh-session';
export { WorkspaceMoveInvalidError } from './entity.ts';
import type { Workspace, WorkspaceId as WorkspaceIdBrand } from './types.ts';
import type { WorkspaceRemoteArchiveRequest, WorkspaceRemoteArchivedValue, WorkspaceRemoteCreateRequest, WorkspaceRemoteCreateValue, WorkspaceRemoteDeleteArchivedRequest, WorkspaceRemoteDeleteArchivedValue, WorkspaceRemoteDeleteRequest, WorkspaceRemoteDeletedValue, WorkspaceRemoteInsertBeforeRequest, WorkspaceRemoteInsertSessionBeforeRequest, WorkspaceRemoteListValue, WorkspaceRemoteOrderValue, WorkspaceRemoteRenameRequest, WorkspaceRemoteResult, WorkspaceRemoteWorkspaceValue, WorkspaceSessionRetirer } from './remote.ts';
export type * from './remote.ts';
export type { Workspace } from './types.ts';
export { workspaceDomainState, workspaceRecord, workspaceDomainSpec } from './spec.ts';
export type { WorkspaceDomainState, WorkspaceRecord } from './spec.ts';
export { realpathNormalize } from './paths.ts';
/** Identifies one workspace record (see `src/types.ts` for the brand rationale). */
export type WorkspaceId = WorkspaceIdBrand;
/**
 * Brand a string as a {@link WorkspaceId}.
 * @param id - Raw workspace id string.
 * @returns the same string, branded at compile time.
 */
export declare function WorkspaceId(id: string): WorkspaceId;
/**
 * An archiveSession request named a session neither live nor in session
 * persistence — a definite miss only; storage faults propagate as themselves.
 */
export declare class WorkspaceUnknownSessionError extends Error {
    readonly sessionId: SessionId;
    /**
     * @param sessionId - The unknown session id.
     */
    constructor(sessionId: SessionId);
}
/** Permanent deletion requires an archived root and a cold, unreserved subtree. */
export declare class WorkspaceSessionDeletionBlockedError extends Error {
    readonly sessionId: SessionId;
    readonly reason: 'not-archived' | 'resident' | 'reserved';
    /**
     * @param sessionId - Session whose deletion was refused.
     * @param reason - The archive, residency, or reservation condition preventing deletion.
     */
    constructor(sessionId: SessionId, reason: 'not-archived' | 'resident' | 'reserved');
}
/** A workspace reorder named a source or anchor absent from the durable registry order. */
export declare class WorkspaceOrderInvalidError extends Error {
    readonly workspaceId: WorkspaceId;
    /**
     * @param workspaceId - Missing source or anchor id.
     */
    constructor(workspaceId: WorkspaceId);
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        workspaceRegistry: WorkspaceRegistry;
        workspaceSessionRetirer?: WorkspaceSessionRetirer;
    }
    interface Events {
        /**
         * Committed archive overlay after a non-delete mutation.
         * @param archivedSessionIds - current archive identities in durable order.
         * @mode emit
         */
        'workspace/archived-sessions-changed'(archivedSessionIds: readonly SessionId[]): void;
        /**
         * Permanently removed identity after log, account and archive commits.
         * @param sessionId - deleted identity.
         * @param archivedSessionIds - remaining archive overlay.
         * @mode emit
         */
        'workspace/session-deleted'(sessionId: SessionId, archivedSessionIds: readonly SessionId[]): void;
    }
}
/** A rename would collide with another Workspace title. */
export declare class WorkspaceNameConflictError extends Error {
    readonly workspaceName: string;
    constructor(workspaceName: string);
}
/** A rename supplied no visible title. */
export declare class WorkspaceTitleInvalidError extends Error {
    constructor();
}
/**
 * Durable workspace registry. Startup waits for `sessionPersistence`, builds
 * one canonical-cwd header index, and completes the one-time history
 * bootstrap before the service becomes active. The persistence dependency is
 * mandatory so an unavailable peer can never be mistaken for an empty
 * history and commit the initialized marker.
 */
export declare class WorkspaceRegistry extends TypertRemoteService {
    static inject: string[];
    private table?;
    private global?;
    private state?;
    private readonly entities;
    private readonly headers;
    private readonly sessionPaths;
    private readonly invalidSessionPaths;
    private readonly sessionDeletionEpoch;
    private readonly deletingSessions;
    private operationTail;
    private readonly host;
    constructor(ctx: Context);
    /** Open the domain, finish bootstrap when required, and rebuild the ordered cache. */
    protected [Service.init](): Promise<void>;
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
    create(path: string, title?: string): Promise<Workspace>;
    /**
     * Resolve canonical ownership and creation status in the same serialized operation.
     * @param path - existing directory.
     * @param title - initial title when a record is created.
     * @returns workspace and whether this operation created it.
     */
    createOrResolve(path: string, title?: string): Promise<{
        workspace: Workspace;
        created: boolean;
    }>;
    /**
     * Look up a workspace by id.
     * @param id - Workspace id.
     * @returns the workspace, or `undefined` when unknown.
     */
    get(id: WorkspaceId): Workspace | undefined;
    /**
     * Synchronous workspace projection in durable registry order. Every
     * entity's `sessionIds` getter is already filtered by the startup/live
     * canonical-cwd header index; this method performs no persistence reads.
     * @returns a fresh ordered array of workspace entities.
     */
    list(): Workspace[];
    /**
     * Project the native workspace list without persistence reads.
     * @param signal - request cancellation.
     * @returns durable rows and archive overlay.
     */
    remoteExportList(signal: AbortSignal): WorkspaceRemoteResult<WorkspaceRemoteListValue>;
    /**
     * Create or resolve a workspace registration through the native API.
     * @param request - existing directory to own.
     * @param signal - cancellation.
     * @returns row and atomic creation flag.
     */
    remoteExportCreate(request: WorkspaceRemoteCreateRequest, signal: AbortSignal): Promise<WorkspaceRemoteResult<WorkspaceRemoteCreateValue>>;
    /**
     * Rename a registered workspace through the native API.
     * @param request - workspace and replacement title.
     * @param signal - cancellation.
     * @returns renamed row.
     */
    remoteExportRename(request: WorkspaceRemoteRenameRequest, signal: AbortSignal): Promise<WorkspaceRemoteResult<WorkspaceRemoteWorkspaceValue>>;
    /**
     * Remove a workspace registration without deleting files or session logs.
     * @param request - registration to remove.
     * @param signal - cancellation.
     * @returns confirmation; files and logs remain.
     */
    remoteExportDelete(request: WorkspaceRemoteDeleteRequest, signal: AbortSignal): Promise<WorkspaceRemoteResult<WorkspaceRemoteDeletedValue>>;
    /**
     * Reorder a workspace through the native API.
     * @param request - workspace and optional anchor.
     * @param signal - cancellation.
     * @returns durable order.
     */
    remoteExportInsertBefore(request: WorkspaceRemoteInsertBeforeRequest, signal: AbortSignal): Promise<WorkspaceRemoteResult<WorkspaceRemoteOrderValue>>;
    /**
     * Reorder a session within its workspace account.
     * @param request - workspace, session and optional anchor.
     * @param signal - cancellation.
     * @returns updated account.
     */
    remoteExportInsertSessionBefore(request: WorkspaceRemoteInsertSessionBeforeRequest, signal: AbortSignal): Promise<WorkspaceRemoteResult<WorkspaceRemoteWorkspaceValue>>;
    /**
     * Archive a session through the native API while retaining its log.
     * @param request - session to archive.
     * @param signal - cancellation.
     * @returns committed archive overlay.
     */
    remoteExportArchiveSession(request: WorkspaceRemoteArchiveRequest, signal: AbortSignal): Promise<WorkspaceRemoteResult<WorkspaceRemoteArchivedValue>>;
    /**
     * Restore an archived session to the visible workspace projection.
     * @param request - archived session to restore.
     * @param signal - cancellation.
     * @returns committed archive overlay.
     */
    remoteExportUnarchiveSession(request: WorkspaceRemoteArchiveRequest, signal: AbortSignal): Promise<WorkspaceRemoteResult<WorkspaceRemoteArchivedValue>>;
    /**
     * Permanently delete an archived root through its existing lifecycle owners.
     * @param request - archived root to delete.
     * @param signal - cancellation.
     * @returns deletion and archive state.
     */
    remoteExportDeleteArchivedSession(request: WorkspaceRemoteDeleteArchivedRequest, signal: AbortSignal): Promise<WorkspaceRemoteResult<WorkspaceRemoteDeleteArchivedValue>>;
    private remoteOperation;
    /**
     * Persist a non-empty, unique workspace title before publishing it.
     * @param id - registered workspace.
     * @param title - visible replacement title.
     * @returns renamed workspace after durability.
     */
    rename(id: WorkspaceId, title: string): Promise<Workspace>;
    /**
     * Delete one workspace registration while retaining its directory and every
     * session log. The durable order is updated before the table deletion; a
     * failed table write restores the prior order and keeps the entity
     * published. Unknown ids are an idempotent no-op for domain callers.
     * @param id - Workspace registration to remove.
     * @returns `true` when a record was deleted, `false` when it was unknown.
     */
    delete(id: WorkspaceId): Promise<boolean>;
    /**
     * Move one workspace within the durable display order, DOM-insertBefore-like.
     * With an anchor it lands before that workspace; without one it appends.
     * @param id - Workspace to move.
     * @param beforeId - Workspace anchor; omitted appends.
     * @returns the complete committed workspace order.
     */
    insertBefore(id: WorkspaceId, beforeId?: WorkspaceId): Promise<readonly WorkspaceId[]>;
    /**
     * The registry-global archive set: sessions hidden from every grouping
     * surface. Archiving never touches workspace accounting — an archived
     * session keeps its `sessionIds` slot so unarchiving restores its position.
     * @returns the archived session ids in archive order.
     */
    get archivedSessionIds(): readonly SessionId[];
    /**
     * Capture the deletion generation before asynchronously loading a session.
     * @param sessionId - identity to observe.
     * @returns its in-process permanent-deletion generation.
     */
    sessionAdmissionRevision(sessionId: SessionId): number;
    /**
     * Reject publication while a session is archived or its deletion raced the load.
     * @param sessionId - identity being published.
     * @param revision - generation captured before asynchronous work.
     */
    assertSessionAdmission(sessionId: SessionId, revision: number): void;
    /**
     * Archive one session durably. The session must exist (live or in session
     * persistence); its workspace accounting — or lack of one — is irrelevant.
     * An already archived id resolves without writing.
     * @param sessionId - The session to archive.
     * @returns resolution after durability.
     */
    archiveSession(sessionId: SessionId): Promise<void>;
    /**
     * Remove a known session from the durable archive overlay.
     * @param sessionId - archived identity to restore.
     * @returns settlement after durable archive removal.
     */
    unarchiveSession(sessionId: SessionId): Promise<void>;
    /**
     * Delete an archived root and retained descendants before committing account and archive removal.
     * @param sessionId - archived root identity.
     * @param retireResident - exact lifecycle owner used to retire resident sessions.
     * @returns settlement after logs, derived cleanup, accounts and archive state commit.
     */
    deleteArchivedSession(sessionId: SessionId, retireResident?: (residentSessionId: SessionId) => Promise<void>): Promise<void>;
    /**
     * Whether a session is live, header-indexed, or present in a fresh
     * persistence listing. Only a definite miss returns false — a failing
     * `sessionPersistence.list()` propagates so storage faults never
     * masquerade as an unknown session.
     */
    private sessionKnown;
    /**
     * Resolve by canonical directory path without creating or mutating a
     * workspace. A missing path rejects during `realpath`; an existing unowned
     * directory returns `undefined`.
     * @param path - Existing directory path in any spelling.
     * @returns the workspace owning the canonical path, when one exists.
     */
    resolveByPath(path: string): Promise<Workspace | undefined>;
    private createCanonical;
    private deleteKnown;
    /**
     * Complete the one mutation explicitly named by durable state. Unexplained
     * order/table divergence still reaches {@link validateStoredState} and
     * fails loud; this path never guesses which operation created a row from its shape alone.
     */
    private recoverPendingMutation;
    private bootstrap;
    private validateStoredState;
    private rebuildEntities;
    private replaceHeaderIndex;
    private indexHeaders;
    private indexHeader;
    private indexLiveSessions;
    private reportFilteredCandidates;
    private readSessionHeader;
    private requireTable;
    private requireState;
    private setState;
    private enqueueOperation;
}
export default WorkspaceRegistry;
//# sourceMappingURL=index.d.ts.map