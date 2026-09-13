/** Session legacy desktop actions, journal streams, and live control state. */
import { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { type ApiSessionAgentResult } from './agent.ts';
import { buildModelCatalog } from './catalog.ts';
import type { ModelCatalog, SessionControlFrame, SessionFollowFrame, SessionFollowRequest, SessionOpenWorkspacePathRequest, SessionOpenWorkspacePathValue, SessionPage, SessionPageRequest } from './types.ts';
export type * from './types.ts';
export { ApiSessionNotFound } from './agent.ts';
export { SessionSkillCatalog } from './skill-catalog.ts';
declare module '@deepseek-ai/cordis' {
    interface Context {
        /** Legacy desktop actions and journal stream owner. */
        sessionController: SessionController;
    }
}
/** Session Controller deployment policy. */
export interface Config {
    /** Override platform desktop-opener detection. */
    readonly nativeOpen?: boolean;
}
/** Host integrations replaceable by direct unit tests. */
export interface SessionControllerInternals {
    /** Native default-application handoff. */
    readonly openPath?: (path: string, signal: AbortSignal) => Promise<void>;
    /** Native handoff availability probe. */
    readonly canOpenPath?: () => boolean;
}
/** Desktop and streaming additions to the canonical Session Remote namespace. */
export declare class SessionController extends TypertRemoteService {
    static inject: string[];
    static Config: z<Config>;
    private readonly agents;
    private readonly controlState;
    private readonly history;
    private readonly openPath;
    private readonly canOpenPath;
    private readonly promotions;
    /**
     * @param ctx - Host context containing the Session capability assembly.
     * @param config - native desktop handoff policy.
     */
    constructor(ctx: Context, config: Config, internals?: SessionControllerInternals);
    private promote;
    /**
     * Resolve or resume one ordinary Session for another Host API domain.
     * @param sessionId - Session identity whose Agent owns the operation.
     * @returns the live Agent or the stable Session-domain failure.
     */
    resolveAgent(sessionId: SessionId): Promise<ApiSessionAgentResult>;
    /**
     * Inspect one attached or persisted Session without activating its Agent.
     * @param sessionId - durable Session identity.
     * @param signal - optional caller cancellation for persistence reads.
     * @returns the current attached state or persisted header and event prefix.
     */
    inspect(sessionId: SessionId, signal?: AbortSignal): Promise<{
        meta: SessionHeader;
        events: SessionEvent[];
    }>;
    /**
     * Describe every currently routable model for Host-generation selectors.
     * @returns provider-grouped models, the deployment default, and isolated provider failures.
     */
    modelCatalog(): Promise<ModelCatalog>;
    /**
     * Report whether this deployment can hand a Session workspace path to a native desktop.
     * @returns true when the matching open operation is available.
     */
    canOpenWorkspacePath(): boolean;
    /**
     * Open one path prepared by a Session-aware caller on the Host desktop.
     * @param request - path after best-effort Session workspace resolution.
     * @param signal - caller lifetime; abort terminates the native command.
     * @returns confirmation after the native opener accepts the path.
     * @throws TypertRemoteFailure when the request is invalid, cancelled, or the opener fails.
     */
    openWorkspacePath(request: SessionOpenWorkspacePathRequest, signal: AbortSignal): Promise<SessionOpenWorkspacePathValue>;
    /**
     * Read one cold-safe, message-aligned Session history page.
     * @param request - durable address, backward cursor, and page budget.
     * @param signal - cancellation for persistence reads.
     * @returns one chronological page.
     */
    page(request: SessionPageRequest, signal: AbortSignal): Promise<SessionPage>;
    /**
     * Follow one Session log from its opening or resume cursor.
     * @param request - durable address and last committed sequence already held by the caller.
     * @param signal - cancellation owned by the Remote stream carrier.
     * @returns a complete opening snapshot followed by gap-free event frames.
     */
    follow(request: SessionFollowRequest, signal: AbortSignal): AsyncIterable<SessionFollowFrame>;
    /**
     * Stream a complete live-control baseline followed by replacement frames.
     * @param signal - cancellation owned by the Remote stream carrier.
     * @returns one complete baseline followed by live replacement frames.
     */
    control(signal: AbortSignal): AsyncIterable<SessionControlFrame>;
}
export { buildModelCatalog };
export default SessionController;
//# sourceMappingURL=index.d.ts.map