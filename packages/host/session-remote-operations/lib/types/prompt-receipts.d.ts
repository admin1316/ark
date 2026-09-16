import type { Context } from '@deepseek-ai/cordis';
import type { SessionPromptInvocationId, SessionRemotePromptRequest } from '@deepseek-ai/dsh-session';
/** One accepted invocation; no prompt body is retained in this projection. */
export interface PromptReceipt {
    readonly messageId: string;
    readonly seq: number;
    readonly digest: string | null;
    readonly conflict: boolean;
}
/** Host-only receipt state; inherited fork seed identities belong to the parent. */
export interface PromptReceipts {
    readonly seedLength: number;
    readonly entries: Record<string, PromptReceipt>;
}
declare module '@deepseek-ai/dsh-session-projection/types' {
    interface SessionProjectionStateMap {
        promptReceipts: PromptReceipts;
    }
}
declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        /** User input admitted by generated Session Remote with caller identity. */
        'session-remote-user': {
            kind: 'user';
            invocationId: SessionPromptInvocationId;
            clientTimeZone?: string;
            /** Versioned digest of original input, mode and canonical client timezone. */
            promptDigest?: string;
        };
    }
}
/**
 * Canonical request fingerprint; hash the encoded image instead of retaining it.
 * @param request - original content and delivery mode; invocation and Session identities are not part of the digest.
 * @param clientTimeZone - already canonicalized client time zone, or undefined when absent.
 * @returns version-prefixed SHA-256 digest used to reject changed payloads under an accepted invocation identity.
 */
export declare function promptDigest(request: SessionRemotePromptRequest, clientTimeZone: string | undefined): string;
/**
 * Register with the shared projection owner; no receipt data is exposed on the wire.
 * @param ctx - Host context with an injected projection registry that owns incremental replay and disposal.
 */
export declare function installPromptReceipts(ctx: Context): void;
//# sourceMappingURL=prompt-receipts.d.ts.map