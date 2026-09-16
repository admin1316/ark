/**
 * Browser-safe request, result, and state-stream vocabulary for the Workspace
 * and directory-picking Remote namespaces this package owns. The picking seam
 * declares its own listing types, so they are re-exported here rather than
 * restated: a browser consumer reads the very declaration the backend answers.
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { z as zCore } from 'zod'

type ZodIssue = zCore.core.$ZodIssue

export type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
export type { DirectoryEntry, DirectoryListing } from '@deepseek-ai/dsh-host-directory-picker/types'

/** Canonical Workspace wire views and domain failures. */
export type {
  WorkspaceRemoteView as WorkspaceView,
  WorkspaceRemoteCreateRequest as WorkspaceCreateRequest,
  WorkspaceRemoteCreateValue as WorkspaceCreateValue,
  WorkspaceRemoteRenameRequest as WorkspaceRenameRequest,
  WorkspaceRemoteWorkspaceValue as WorkspaceValue,
  WorkspaceRemoteDeleteRequest as WorkspaceDeleteRequest,
  WorkspaceRemoteDeletedValue as WorkspaceDeleteValue,
  WorkspaceRemoteInsertBeforeRequest as WorkspaceInsertBeforeRequest,
  WorkspaceRemoteOrderValue as WorkspaceOrderValue,
  WorkspaceRemoteInsertSessionBeforeRequest as WorkspaceInsertSessionBeforeRequest,
  WorkspaceRemoteArchiveRequest as WorkspaceArchiveSessionRequest,
  WorkspaceRemoteArchivedValue as WorkspaceArchiveValue,
} from '@deepseek-ai/dsh-workspace/types'
import type { WorkspaceRemoteView as WorkspaceView, WorkspaceRemoteFailure } from '@deepseek-ai/dsh-workspace/types'
/** Canonical Workspace domain error, preserving the owner's code-specific details. */
export type WorkspaceError = WorkspaceRemoteFailure['error']

/** Stable directory-picking failure details returned by the picking wire verbs. */
export interface DirectoryPickerErrorDetailsMap {
  /** The directory creation request violates its semantic input constraints. */
  'bad-request': { readonly issues: ZodIssue[] }
  /** The verb needs an interaction the composed backend does not serve. */
  'directory-picker-unavailable': { readonly capability: string }
  /** The target is not fully qualified, or the backend cannot list it. */
  'directory-unreadable': { readonly path: string }
  /** A child of that name is already there. */
  'directory-exists': { readonly path: string }
  /** The parent is not fully qualified, the name is not one segment, or creation failed. */
  'directory-create-failed': { readonly path: string }
  /** The caller's own timeout or disconnect ended the chooser or the scan. */
  cancelled: Record<never, never>
  /** A backend failure with no seam code of its own. */
  internal: Record<never, never>
}

/** Complete reconnect baseline for Workspace browser state. */
export interface WorkspaceBaseline {
  readonly items: readonly WorkspaceView[]
  readonly archivedSessionIds: readonly SessionId[]
}

/** One ordered Workspace change after a generation's baseline. */
export type WorkspaceFollowIncrement =
  | { readonly type: 'upsert'; readonly workspace: WorkspaceView }
  | { readonly type: 'remove'; readonly workspaceId: WorkspaceId }
  | { readonly type: 'order'; readonly workspaceIds: readonly WorkspaceId[] }
  | { readonly type: 'archived'; readonly archivedSessionIds: readonly SessionId[] }

/** Workspace state stream; every generation starts with exactly one baseline. */
export type WorkspaceFollowFrame =
  | { readonly type: 'baseline'; readonly value: WorkspaceBaseline }
  | WorkspaceFollowIncrement
