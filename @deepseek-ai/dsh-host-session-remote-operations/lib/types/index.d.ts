/**
 * Host ownership for generated Session Remote operations and archived
 * Workspace-session retirement.
 *
 * The package reads each domain's live owner directly. It deliberately owns
 * no transcript, projection, workspace, attachment, or model-catalog cache.
 * Its only mutable maps serialize identity creation/resume, retain exact
 * AgentHandle capabilities, and hold the session-local model selection that
 * prompt assembly consumes.
 *
 * @module @deepseek-ai/dsh-host-session-remote-operations
 */
import { Context, Service } from '@deepseek-ai/cordis';
import { type ImageAttachmentLimits } from '@deepseek-ai/dsh-attachment';
import { SessionId, type SessionRemoteAcceptedValue, type SessionRemoteAttachmentRequest, type SessionRemoteAttachmentValue, type SessionRemoteCancelRequest, type SessionRemoteCreateRequest, type SessionRemoteCreateValue, type SessionRemoteForkRequest, type SessionRemoteForkValue, type SessionRemoteHistoryRequest, type SessionRemoteHistoryValue, type SessionRemoteListRequest, type SessionRemoteListValue, type SessionRemoteModels, type SessionRemoteModelsRequest, type SessionRemoteOperations, type SessionPromptInvocationId, type SessionRemotePromptRequest, type SessionRemotePromptValue, type SessionRemoteRenameRequest, type SessionRemoteRenameValue, type SessionRemoteResult, type SessionRemoteSearchRequest, type SessionRemoteSearchValue, type SessionRemoteSelectModelRequest, type SessionRemoteSelectModelValue, type SessionRemoteUpdateQueueRequest } from '@deepseek-ai/dsh-session';
import { type WorkspaceSessionRetirer } from '@deepseek-ai/dsh-workspace';
import { type SessionLogCompressionLevel } from './session-export.ts';
export { DEFAULT_SESSION_LOG_COMPRESSION_LEVEL, fetchSessionLogExport, flushLiveSessionLog, SESSION_EXPORT_PATH, sessionLogCompressionLevel, sessionLogZipEntries, sessionLogZipFilename, streamSessionLogZip, } from './session-export.ts';
export type { SessionLogCompressionLevel, SessionLogExportDeps, SessionLogExportReady, SessionLogZipEntry, } from './session-export.ts';
/** Persisted hint shared by Session listing and the projection cache. */
export interface SessionListMetadata {
    readonly blank: boolean;
    readonly lastPromptAt: number | null;
}
declare module '@deepseek-ai/dsh-session-projection/types' {
    interface SessionProjectionStateMap {
        sessionListMetadata: SessionListMetadata;
        imageLimits: null;
    }
    interface SessionProjectionMap {
        sessionListMetadata: SessionListMetadata;
        imageLimits: ImageAttachmentLimits;
    }
}
declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        /** User input admitted by generated Session Remote with caller identity. */
        'session-remote-user': {
            kind: 'user';
            invocationId: SessionPromptInvocationId;
            clientTimeZone?: string;
        };
    }
}
/** Composition options owned by the Host, not by the generated wire contract. */
export interface Config {
    /** Project directory used when Session creation names neither workspace nor cwd. */
    readonly cwd?: string;
    /** DEFLATE level for each Session archive entry; defaults to 6. */
    readonly sessionExportCompressionLevel?: SessionLogCompressionLevel;
}
/** Host implementation of G2's generated Session port and Workspace retirer. */
export declare class SessionRemoteOperationsService extends Service implements SessionRemoteOperations, WorkspaceSessionRetirer {
    static inject: string[];
    private readonly defaultCwd;
    /** Exact loopback-only path for streaming Session archives. */
    readonly path = "/api/session/export";
    private readonly sessionExportCompressionLevel;
    private readonly handles;
    private readonly creations;
    private readonly resumes;
    private readonly selections;
    private readonly imageAdmissionChains;
    private readonly lifetime;
    constructor(ctx: Context, config?: Config);
    /**
     * Handle the Host-owned Native Session archive endpoint.
     * @param request - authenticated download request carrying Session export query fields.
     * @param signal - optional Connection-owned cancellation signal.
     * @returns the streamed archive response or a closed HTTP error response.
     */
    fetch(request: Request, signal?: AbortSignal): Promise<Response>;
    /** Return the current default for a fresh or resumed Agent. */
    private agentOptions;
    /** Install or retrieve the session-local request selection. */
    private selectionFor;
    /** Resolve and mount the preset that owns one Agent's tool composition. */
    private composeAgent;
    /** Revalidate Workspace archive/deletion admission around publication. */
    private withSessionAdmission;
    /** Retain the exact lifecycle capability returned by AgentRegistry. */
    private ownHandle;
    /** Stable subagent ownership fence shared by all generic Session methods. */
    private subagentFailure;
    /** Assert a caller cannot adopt a Session under another preset. */
    private assertPresetUnchanged;
    /** Read one attached or persisted Session without acquiring a live Agent. */
    private readSessionState;
    /** Resolve one ordinary Session to a live Agent, resuming once per id. */
    private agentFor;
    /** Serialize model switching with image admission for one exact Agent. */
    private serializeImageAdmission;
    /** One exact projection cut for an attached or detached transcript. */
    private projectionsFor;
    /** Resolve the presentation scope without resuming a cold Session. */
    private presenterScope;
    /** Build the current visible Session listing without retaining a second index. */
    private visibleSummaries;
    /** List every attached or persisted Session visible to ordinary routing. */
    list(_request: SessionRemoteListRequest, signal: AbortSignal): Promise<SessionRemoteResult<SessionRemoteListValue>>;
    /** Search current message surfaces, then enforce ordinary Session visibility. */
    search(request: SessionRemoteSearchRequest, signal: AbortSignal): Promise<SessionRemoteResult<SessionRemoteSearchValue>>;
    /** Resolve or create one explicit identity once, preserving cwd and preset ownership. */
    private ensureSession;
    /** Create or adopt one ordinary Agent-backed Session. */
    create(request: SessionRemoteCreateRequest, signal: AbortSignal): Promise<SessionRemoteResult<SessionRemoteCreateValue>>;
    /** Resolve one history source without acquiring an Agent owner. */
    private historySource;
    /**
     * Serve a consistent attached-or-cold transcript page and projection cut.
     * When `hasMore` is true, the first returned event sequence is the strictly
     * smaller exclusive `beforeSeq` cursor for the next request.
     */
    history(request: SessionRemoteHistoryRequest, signal: AbortSignal): Promise<SessionRemoteResult<SessionRemoteHistoryValue>>;
    /** Build the advisory provider/model catalog directly from LlmRuntime. */
    private modelCatalog;
    /** Report the current session route and advisory model catalog. */
    models(request: SessionRemoteModelsRequest, signal: AbortSignal): Promise<SessionRemoteResult<SessionRemoteModels>>;
    /** Validate and apply one session-local provider/model/reasoning selection. */
    selectModel(request: SessionRemoteSelectModelRequest, signal: AbortSignal): Promise<SessionRemoteResult<SessionRemoteSelectModelValue>>;
    /** Append a user-owned durable title through SessionTitleService. */
    rename(request: SessionRemoteRenameRequest, signal: AbortSignal): Promise<SessionRemoteResult<SessionRemoteRenameValue>>;
    /** Resolve the Workspace inherited by an ordinary fork. */
    private forkWorkspace;
    /** Fork one completed-turn prefix under a new exact Agent lifecycle handle. */
    fork(request: SessionRemoteForkRequest, signal: AbortSignal): Promise<SessionRemoteResult<SessionRemoteForkValue>>;
    /** Promote base64 image parts to durable references in caller order. */
    private durablePromptContent;
    /** Revalidate one resolved prompt target at its synchronous delivery commit. */
    private assertPromptAdmission;
    /** Admit ordinary queued or steering input to the exact live Agent. */
    prompt(request: SessionRemotePromptRequest, signal: AbortSignal): Promise<SessionRemoteResult<SessionRemotePromptValue>>;
    /** Return bytes only for an image referenced by the addressed Session log. */
    attachment(request: SessionRemoteAttachmentRequest, signal: AbortSignal): Promise<SessionRemoteResult<SessionRemoteAttachmentValue>>;
    /** Validate one queue edit as text-only ContentBlock data. */
    private queueEditContent;
    /** Edit, remove, or immediately steer one exact pending inbox message. */
    updateQueue(request: SessionRemoteUpdateQueueRequest, signal: AbortSignal): Promise<SessionRemoteResult<SessionRemoteAcceptedValue>>;
    /** Cancel the active ordinary turn while preserving queued input. */
    cancel(request: SessionRemoteCancelRequest, signal: AbortSignal): Promise<SessionRemoteResult<SessionRemoteAcceptedValue>>;
    /**
     * Retire one archived resident only through the exact handle this Host owns.
     * The Workspace registry performs the subsequent descendant ordering,
     * persistence reservation check, durable delete, and account cleanup.
     */
    retireArchivedSession(sessionId: SessionId, signal: AbortSignal): Promise<void>;
}
export default SessionRemoteOperationsService;
//# sourceMappingURL=index.d.ts.map