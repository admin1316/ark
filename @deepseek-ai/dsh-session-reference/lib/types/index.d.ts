/**
 * Cross-session snapshot preparation. Hosts adapt mentions into structured
 * references; this service owns exact reads, projection, budgets, and durable context.
 *
 * @module @deepseek-ai/dsh-session-reference
 */
import { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import { type Config } from './config.ts';
import type { PreparedReferencedMessage, SessionReferenceCandidate, SessionReferenceInput, SessionReferenceMentionCandidate } from './types.ts';
export type * from './types.ts';
export type { Config, SessionReferenceErrorCode } from './config.ts';
export { DEFAULT_CANDIDATE_LIMIT, DEFAULT_MAX_REFERENCE_BYTES, MAX_REFERENCES, SessionReferenceError, } from './config.ts';
export { SESSION_REFERENCE_SCHEME, decodeSessionReferenceUri, encodeSessionReferenceUri, formatSessionReferenceMention, parseSessionReferenceText, } from './uri.ts';
declare module '@deepseek-ai/cordis' {
    interface Context {
        sessionReferenceResolver: SessionReferenceResolver;
    }
}
/** Exact-read consumer that prepares immutable cross-session message context. */
export declare class SessionReferenceResolver extends TypertRemoteService {
    static inject: string[];
    static Config: z<Config>;
    private readonly config;
    constructor(ctx: Context, config?: Config);
    /**
     * Replace canonical mentions in direct user messages and place each prepared
     * snapshot immediately after the message that cited it.
     * @param agent - agent entering the model step.
     * @param messages - messages accepted by downstream pre-step listeners.
     * @param signal - active turn cancellation.
     * @returns direct messages followed by their session-reference context in citation order.
     */
    private prepareDirectMessages;
    /**
     * List reference candidates, ranked by working-directory affinity.
     * @param agent - target agent; self is excluded and its cwd drives ranking.
     * @param query - optional case-insensitive session-id/cwd/title substring.
     * @param limit - optional positive result cap.
     * @param signal - optional cancellation boundary for host autocomplete teardown.
     * @returns candidates labeled by latest title or, when absent, session id.
     */
    listCandidates(agent: Agent, query?: string, limit?: number, signal?: AbortSignal): Promise<SessionReferenceCandidate[]>;
    /**
     * Remote face of {@link listCandidates}: the configured candidate limit
     * applies, and every candidate carries the canonical mention a host inserts
     * into the prompt draft.
     * @param agent - target agent; self is excluded and its cwd drives ranking.
     * @param query - optional case-insensitive session-id/cwd/title substring.
     * @param signal - caller cancellation.
     * @returns mention-carrying candidates in rank order.
     */
    remoteExportCandidates(agent: Agent, query: string, signal: AbortSignal): Promise<SessionReferenceMentionCandidate[]>;
    /**
     * Snapshot all references for one accepted direct message and return one aggregated durable context.
     * @param agent - target agent; references to it are rejected.
     * @param content - already host-normalized readable message content.
     * @param references - structured source sessions in mention order.
     * @param signal - optional cancellation boundary for the active turn.
     * @returns detached content and optional referenced-session context.
     */
    prepare(agent: Agent, content: ContentBlock[], references: SessionReferenceInput[], signal?: AbortSignal): Promise<PreparedReferencedMessage>;
    private renderSources;
}
export default SessionReferenceResolver;
//# sourceMappingURL=index.d.ts.map