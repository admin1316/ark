/** Generated Remote wire types owned by the workspace domain. */
import type { SessionId } from '@deepseek-ai/dsh-session';
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
/**
 * Describes the workspace remote list value value used by this package.
 */
export interface WorkspaceRemoteListValue {
    readonly items: readonly WorkspaceRemoteView[];
    readonly archivedSessionIds: readonly SessionId[];
}
/**
 * Describes the workspace remote create request value used by this package.
 */
export interface WorkspaceRemoteCreateRequest {
    readonly path: string;
}
/**
 * Describes the workspace remote create value value used by this package.
 */
export interface WorkspaceRemoteCreateValue {
    readonly workspace: WorkspaceRemoteView;
    readonly created: boolean;
}
/**
 * Describes the workspace remote rename request value used by this package.
 */
export interface WorkspaceRemoteRenameRequest {
    readonly workspaceId: WorkspaceId;
    readonly title: string;
}
/**
 * Describes the workspace remote workspace value value used by this package.
 */
export interface WorkspaceRemoteWorkspaceValue {
    readonly workspace: WorkspaceRemoteView;
}
/**
 * Describes the workspace remote delete request value used by this package.
 */
export interface WorkspaceRemoteDeleteRequest {
    readonly workspaceId: WorkspaceId;
}
/**
 * Describes the workspace remote deleted value value used by this package.
 */
export interface WorkspaceRemoteDeletedValue {
    readonly deleted: true;
}
/**
 * Describes the workspace remote insert before request value used by this package.
 */
export interface WorkspaceRemoteInsertBeforeRequest {
    readonly workspaceId: WorkspaceId;
    readonly beforeWorkspaceId?: WorkspaceId;
}
/**
 * Describes the workspace remote order value value used by this package.
 */
export interface WorkspaceRemoteOrderValue {
    readonly workspaceIds: readonly WorkspaceId[];
}
/**
 * Describes the workspace remote insert session before request value used by this package.
 */
export interface WorkspaceRemoteInsertSessionBeforeRequest {
    readonly workspaceId: WorkspaceId;
    readonly sessionId: SessionId;
    readonly beforeSessionId?: SessionId;
}
/**
 * Describes the workspace remote archive request value used by this package.
 */
export interface WorkspaceRemoteArchiveRequest {
    readonly sessionId: SessionId;
}
/**
 * Describes the workspace remote archived value value used by this package.
 */
export interface WorkspaceRemoteArchivedValue {
    readonly archivedSessionIds: readonly SessionId[];
}
/**
 * Describes the workspace remote delete archived request value used by this package.
 */
export interface WorkspaceRemoteDeleteArchivedRequest {
    readonly sessionId: SessionId;
}
/**
 * Describes the workspace remote delete archived value value used by this package.
 */
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