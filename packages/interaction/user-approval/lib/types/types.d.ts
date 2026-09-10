/**
 * Wire-safe approval identifiers and outcome vocabulary, free of
 * cordis/service imports so browser type chains can
 * consume them without loading this package's Context augmentation.
 * @module @deepseek-ai/dsh-user-approval/types
 */
import type { Branded } from '@deepseek-ai/dsh-brand';
import type { CallId } from '@deepseek-ai/dsh-llm/brand';
/**
 * Pairs one `approval/asked` audit event with its `approval/decided`.
 * Service-issued (one fresh id per {@link ApprovalService.request} call).
 */
export type ApprovalRequestId = Branded<'ApprovalRequestId'>;
/**
 * Brand a string as an {@link ApprovalRequestId}.
 * @param id - the raw id string to brand.
 * @returns the same string carrying the brand.
 */
export declare function ApprovalRequestId(id: string): ApprovalRequestId;
/**
 * Closed approval outcomes: a one-shot grant, explicit rejection, withdrawn
 * request, or unavailable answerer. Callers fail closed on `unavailable`.
 */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';
declare module '@deepseek-ai/dsh-session/types' {
    interface SessionEventMap {
        /**
         * An approval question was put to the answerer chain — log-only audit
         * (like `hook/*`; NOT a surface event, carries no `surfaceOp`). `id` pairs
         * it with the `approval/decided` that always follows; `toolName` is the
         * tool the question is about, `callId` the exact tool call when the asker
         * had one, `reason` the asker's human-readable explanation (e.g. a hook's
         * permission-decision reason).
         */
        'approval/asked': {
            id: ApprovalRequestId;
            toolName: string;
            callId?: CallId;
            reason?: string;
        };
        /**
         * The outcome of a prior `approval/asked` (same `id`) — log-only audit.
         * Exactly one per ask, appended when the outcome is known: a decision, a
         * cancellation, or the fail-closed `'unavailable'`.
         */
        'approval/decided': {
            id: ApprovalRequestId;
            outcome: ApprovalOutcome;
        };
    }
}
//# sourceMappingURL=types.d.ts.map