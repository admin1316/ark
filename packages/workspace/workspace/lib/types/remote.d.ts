/** Workspace Remote records and cancellation results. */
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type { WorkspaceId } from './types.ts';
/** A complete Workspace projection safe for the Native Remote boundary. */
export interface WorkspaceRemoteView {
    readonly workspaceId: WorkspaceId;
    readonly path: string;
    readonly title: string;
    readonly sessionIds: readonly SessionId[];
    readonly createdAt: string;
    readonly updatedAt: string;
}
/** A stable business failure returned without collapsing storage faults into a false success. */
export interface WorkspaceRemoteFailure {
    readonly ok: false;
    readonly error: {
        readonly code: string;
        readonly message: string;
        readonly details: Record<string, string>;
    };
}
/** A successful Workspace Remote response. */
export interface WorkspaceRemoteSuccess<Value> {
    readonly ok: true;
    readonly value: Value;
}
/** One Workspace Remote response. */
export type WorkspaceRemoteResult<Value> = WorkspaceRemoteSuccess<Value> | WorkspaceRemoteFailure;
/** Workspace order and archived-session membership in one directory response. */
export interface WorkspaceRemoteListValue {
    readonly items: readonly WorkspaceRemoteView[];
    readonly archivedSessionIds: readonly SessionId[];
}
/** Host path requested for a Workspace. */
export interface WorkspaceRemoteCreateRequest {
    readonly path: string;
}
/** Workspace result distinguishing creation from reuse. */
export interface WorkspaceRemoteCreateValue {
    readonly workspace: WorkspaceRemoteView;
    readonly created: boolean;
}
/** New display title addressed by stable Workspace identity. */
export interface WorkspaceRemoteRenameRequest {
    readonly workspaceId: WorkspaceId;
    readonly title: string;
}
/** Updated Workspace projection returned by a mutation. */
export interface WorkspaceRemoteWorkspaceValue {
    readonly workspace: WorkspaceRemoteView;
}
/** Workspace identity selected for removal. */
export interface WorkspaceRemoteDeleteRequest {
    readonly workspaceId: WorkspaceId;
}
/** Confirmation that the requested Workspace removal completed. */
export interface WorkspaceRemoteDeletedValue {
    readonly deleted: true;
}
/** Workspace move; an absent anchor appends it to the directory. */
export interface WorkspaceRemoteInsertBeforeRequest {
    readonly workspaceId: WorkspaceId;
    readonly beforeWorkspaceId?: WorkspaceId;
}
/** Committed Workspace order after a move. */
export interface WorkspaceRemoteOrderValue {
    readonly workspaceIds: readonly WorkspaceId[];
}
/** Session move within one Workspace; an absent anchor appends it. */
export interface WorkspaceRemoteInsertSessionBeforeRequest {
    readonly workspaceId: WorkspaceId;
    readonly sessionId: SessionId;
    readonly beforeSessionId?: SessionId;
}
/** Session identity selected for archive or restore. */
export interface WorkspaceRemoteArchiveRequest {
    readonly sessionId: SessionId;
}
/** Committed archived-session membership. */
export interface WorkspaceRemoteArchivedValue {
    readonly archivedSessionIds: readonly SessionId[];
}
/** Archived root whose persisted subtree is selected for permanent deletion. */
export interface WorkspaceRemoteDeleteArchivedRequest {
    readonly sessionId: SessionId;
}
/** Completed deletion and the remaining archived-session membership. */
export interface WorkspaceRemoteDeleteArchivedValue {
    readonly deleted: true;
    readonly archivedSessionIds: readonly SessionId[];
}
/**
 * A lifecycle owner that may retire exactly one archived resident Session.
 *
 * The registry never invents a disposer: the owner must prove that its Agent
 * is idle, archived, top-level, and not reserved before releasing it.  A
 * missing provider is intentionally treated as a resident deletion block.
 */
export interface WorkspaceSessionRetirer {
    retireArchivedSession(sessionId: SessionId, signal: AbortSignal): Promise<void>;
}
/**
 * Direct-call cancellation result; the Remote carrier independently preserves cancellation too.
 * @returns The value produced by workspace remote cancelled.
 */
export declare function workspaceRemoteCancelled(): WorkspaceRemoteFailure;
//# sourceMappingURL=remote.d.ts.map