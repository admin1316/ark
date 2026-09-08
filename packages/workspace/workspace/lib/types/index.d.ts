/**
 * Workspace entity registry (`ctx.workspaceRegistry`): durable workspace records,
 * stable registry order, and header-validated session membership over the
 * domain data form.
 * @module @deepseek-ai/dsh-workspace
 */
import { Context, Service } from '@deepseek-ai/cordis';
import type { SessionId } from '@deepseek-ai/dsh-session';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
export { WorkspaceMoveInvalidError } from './entity.ts';
import type { Workspace, WorkspaceId as WorkspaceIdBrand } from './types.ts';
import type { WorkspaceRemoteArchiveRequest, WorkspaceRemoteArchivedValue, WorkspaceRemoteCreateRequest, WorkspaceRemoteCreateValue, WorkspaceRemoteDeleteArchivedRequest, WorkspaceRemoteDeleteArchivedValue, WorkspaceRemoteDeleteRequest, WorkspaceRemoteDeletedValue, WorkspaceRemoteInsertBeforeRequest, WorkspaceRemoteInsertSessionBeforeRequest, WorkspaceRemoteListValue, WorkspaceRemoteOrderValue, WorkspaceRemoteRenameRequest, WorkspaceRemoteResult, WorkspaceRemoteWorkspaceValue, WorkspaceSessionRetirer } from './remote.ts';
export type { Workspace } from './types.ts';
export { workspaceDomainState, workspaceRecord, workspaceDomainSpec } from './spec.ts';
export type { WorkspaceDomainState, WorkspaceRecord } from './spec.ts';
export { realpathNormalize } from './paths.ts';
export type * from './remote.ts';
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
/** A rename request would collide with another Workspace's display title. */
export declare class WorkspaceNameConflictError extends Error {
    readonly workspaceName: string;
    constructor(workspaceName: string);
}
/** A Remote rename supplied an empty title after normalization. */
export declare class WorkspaceTitleInvalidError extends Error {
    constructor();
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        workspaceRegistry: WorkspaceRegistry;
        /** Optional exact lifecycle disposer used only by archived-session deletion. */
        workspaceSessionRetirer?: WorkspaceSessionRetirer;
    }
    interface Events {
        /**
         * Complete committed archive set after a non-delete mutation.
         * @param archivedSessionIds - Current archived session identities in durable order.
         * @mode emit
         */
        'workspace/archived-sessions-changed'(archivedSessionIds: readonly SessionId[]): void;
        /**
         * One permanently deleted identity after log/account/archive commits.
         * @param sessionId - Root session identity that was permanently deleted.
         * @param archivedSessionIds - Remaining archived session identities in durable order.
         * @mode emit
         */
        'workspace/session-deleted'(sessionId: SessionId, archivedSessionIds: readonly SessionId[]): void;
    }
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
     * Create one Workspace or resolve the existing canonical path in the same
     * registry serialization slot.  The `created` bit is therefore not guessed
     * from a stale preflight lookup.
     * @param path - Existing directory to own, in any path spelling.
     * @param title - Display title used only when a new record is created.
     * @returns the workspace and whether a new record was created.
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
     * List durable Workspaces and the archive overlay through the generated Remote boundary.
     * @param signal - caller-owned cancellation signal.
     * @returns the workspace list and archived-session overlay.
     */
    remoteExportList(signal: AbortSignal): WorkspaceRemoteResult<WorkspaceRemoteListValue>;
    /**
     * Create or resolve one canonical existing directory through the generated Remote boundary.
     * @param request - directory path to create or resolve.
     * @param signal - caller-owned cancellation signal.
     * @returns the workspace result and creation flag.
     */
    remoteExportCreate(request: WorkspaceRemoteCreateRequest, signal: AbortSignal): Promise<WorkspaceRemoteResult<WorkspaceRemoteCreateValue>>;
    /**
     * Rename one Workspace without exposing the registry's write chain to transport code.
     * @param request - workspace id and replacement title.
     * @param signal - caller-owned cancellation signal.
     * @returns the renamed workspace result.
     */
    remoteExportRename(request: WorkspaceRemoteRenameRequest, signal: AbortSignal): Promise<WorkspaceRemoteResult<WorkspaceRemoteWorkspaceValue>>;
    /**
     * Remove only a Workspace registration; neither files nor session logs are touched.
     * @param request - workspace id to remove.
     * @param signal - caller-owned cancellation signal.
     * @returns confirmation of the registration removal.
     */
    remoteExportDelete(request: WorkspaceRemoteDeleteRequest, signal: AbortSignal): Promise<WorkspaceRemoteResult<WorkspaceRemoteDeletedValue>>;
    /**
     * Reorder Workspace rows using DOM-insertBefore semantics.
     * @param request - workspace and optional anchor ids.
     * @param signal - caller-owned cancellation signal.
     * @returns the resulting workspace order.
     */
    remoteExportInsertBefore(request: WorkspaceRemoteInsertBeforeRequest, signal: AbortSignal): Promise<WorkspaceRemoteResult<WorkspaceRemoteOrderValue>>;
    /**
     * Reorder an accounted Session inside one Workspace.
     * @param request - workspace, session, and optional anchor ids.
     * @param signal - caller-owned cancellation signal.
     * @returns the updated workspace result.
     */
    remoteExportInsertSessionBefore(request: WorkspaceRemoteInsertSessionBeforeRequest, signal: AbortSignal): Promise<WorkspaceRemoteResult<WorkspaceRemoteWorkspaceValue>>;
    /**
     * Archive one Session without changing its Workspace account or log.
     * @param request - session id to archive.
     * @param signal - caller-owned cancellation signal.
     * @returns the archived-session ids after the operation.
     */
    remoteExportArchiveSession(request: WorkspaceRemoteArchiveRequest, signal: AbortSignal): Promise<WorkspaceRemoteResult<WorkspaceRemoteArchivedValue>>;
    /**
     * Restore one archived Session without changing its retained Workspace position.
     * @param request - archived session id to restore.
     * @param signal - caller-owned cancellation signal.
     * @returns the archived-session ids after the operation.
     */
    remoteExportUnarchiveSession(request: WorkspaceRemoteArchiveRequest, signal: AbortSignal): Promise<WorkspaceRemoteResult<WorkspaceRemoteArchivedValue>>;
    /**
     * Permanently delete an archived Session only through the exact lifecycle-retirement capability.
     * @param request - archived session id to delete.
     * @param signal - caller-owned cancellation signal.
     * @returns deletion confirmation and remaining archived-session ids.
     */
    remoteExportDeleteArchivedSession(request: WorkspaceRemoteDeleteArchivedRequest, signal: AbortSignal): Promise<WorkspaceRemoteResult<WorkspaceRemoteDeleteArchivedValue>>;
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
     * Rename one Workspace through the same serialization chain as all registry writes.
     * @param id - Workspace registration to rename.
     * @param title - replacement display title.
     * @returns the renamed workspace.
     */
    rename(id: WorkspaceId, title: string): Promise<Workspace>;
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
     * Capture the in-process permanent-deletion generation for publication fencing.
     * @param sessionId - Session identity whose deletion generation is read.
     * @returns Current admission generation for the session.
     */
    sessionAdmissionRevision(sessionId: SessionId): number;
    /**
     * Revalidate a publication against archive membership and deletion races.
     * @param sessionId - Session identity being published.
     * @param revision - Admission generation captured before the asynchronous work.
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
     * Remove an existing session from the archive set without touching its log/account slot.
     * @param sessionId - Archived session identity to restore.
     * @returns Resolution after the archive mutation is durable.
     */
    unarchiveSession(sessionId: SessionId): Promise<void>;
    /**
     * Permanently delete one archived session and every retained descendant.
     * Logs commit descendant-first before workspace accounts and archive state;
     * a later failure leaves the root archive marker available for retry.
     * @param sessionId - Archived root session identity to delete.
     * @param retireResident - Callback that retires a live/resident session before log deletion.
     * @returns Resolution after all retained records and archive state are durable.
     */
    deleteArchivedSession(sessionId: SessionId, retireResident?: (residentSessionId: SessionId) => Promise<void>): Promise<void>;
    /** Finish a crash-left delete whose authoritative log disappeared first. */
    private reconcileStaleArchivedSessions;
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
    /** Run one Remote mutation with cancellation and known business failures kept explicit. */
    private remoteOperation;
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