import { Context, Service } from "@deepseek-ai/cordis";
import { AttachmentStore, ImageAttachmentLimits } from "@deepseek-ai/dsh-attachment";
import { SessionId, SessionPromptInvocationId, SessionRemoteAcceptedValue, SessionRemoteAttachmentRequest, SessionRemoteAttachmentValue, SessionRemoteCancelRequest, SessionRemoteCreateRequest, SessionRemoteCreateValue, SessionRemoteForkRequest, SessionRemoteForkValue, SessionRemoteHistoryRequest, SessionRemoteHistoryValue, SessionRemoteListRequest, SessionRemoteListValue, SessionRemoteModels, SessionRemoteModelsRequest, SessionRemoteOperations, SessionRemotePromptRequest, SessionRemotePromptValue, SessionRemoteRenameRequest, SessionRemoteRenameValue, SessionRemoteResult, SessionRemoteSearchRequest, SessionRemoteSearchValue, SessionRemoteSelectModelRequest, SessionRemoteSelectModelValue, SessionRemoteUpdateQueueRequest, SessionStore } from "@deepseek-ai/dsh-session";
import { SessionQueryEngine } from "@deepseek-ai/dsh-session-query";
import { WorkspaceSessionRetirer } from "@deepseek-ai/dsh-workspace";
import { SessionPersistence, SessionRawArtifact } from "@deepseek-ai/dsh-session-persistence";

//#region src/session-export.d.ts
/** Final Host path for the Native Session archive download. */
declare const SESSION_EXPORT_PATH = "/api/session/export";
/** Valid fflate DEFLATE levels accepted by Session export. */
type SessionLogCompressionLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
/** Balanced default for Session archive compression. */
declare const DEFAULT_SESSION_LOG_COMPRESSION_LEVEL: SessionLogCompressionLevel;
/** The services a Session export needs (the live store is optional). */
interface SessionLogExportDeps {
  readonly sessionQuery: SessionQueryEngine | undefined;
  readonly sessionPersistence: SessionPersistence | undefined;
  readonly attachments: AttachmentStore | undefined;
  readonly sessions: SessionStore | undefined;
}
/** Export services narrowed to the mounted owners used by streaming. */
interface SessionLogExportReady {
  readonly sessionQuery: SessionQueryEngine;
  readonly sessionPersistence: SessionPersistence;
  readonly attachments: AttachmentStore;
  readonly sessions: SessionStore | undefined;
}
/**
 * Validate one deployment compression value without silently rounding.
 * @param value - configured level or undefined for the balanced default.
 * @returns the exact accepted compression level.
 */
declare function sessionLogCompressionLevel(value?: number): SessionLogCompressionLevel;
/**
 * Flush a live Session immediately before reading its raw durable artifact.
 * @param deps - export owners including the optional live Session store.
 * @param id - Session being read.
 * @param signal - caller cancellation around the durability barrier.
 */
declare function flushLiveSessionLog(deps: Pick<SessionLogExportDeps, 'sessions'>, id: SessionId, signal?: AbortSignal): Promise<void>;
/** One exported artifact or referenced media object. */
type SessionLogZipEntry = {
  readonly path: string;
  readonly content: string;
} | {
  readonly path: string;
  readonly data: Uint8Array;
};
/**
 * Build the archive filename for one root Session.
 * @param sessionId - root Session identity.
 * @returns path-safe attachment filename.
 */
declare function sessionLogZipFilename(sessionId: string): string;
/**
 * Yield root, descendants, then distinct referenced media in archive order.
 * @param deps - mounted export owners.
 * @param root - already-prepared root artifact.
 * @param sessionId - root Session identity.
 * @param includeDescendants - whether lineage descendants are included.
 * @param signal - read and lineage cancellation.
 * @returns entries in deterministic archive order.
 */
declare function sessionLogZipEntries(deps: SessionLogExportReady, root: SessionRawArtifact, sessionId: SessionId, includeDescendants: boolean, signal?: AbortSignal): AsyncGenerator<SessionLogZipEntry>;
/**
 * Stream one prepared Session ZIP with byte-capacity backpressure.
 * @param deps - mounted export owners.
 * @param root - prepared root artifact.
 * @param sessionId - root Session identity.
 * @param includeDescendants - whether lineage descendants are included.
 * @param compressionLevel - validated DEFLATE level.
 * @param signal - request cancellation combined with consumer cancellation.
 * @returns pull-aware archive byte stream.
 */
declare function streamSessionLogZip(deps: SessionLogExportReady, root: SessionRawArtifact, sessionId: SessionId, includeDescendants: boolean, compressionLevel: SessionLogCompressionLevel, signal: AbortSignal): ReadableStream<Uint8Array>;
/**
 * Handle the final GET/HEAD Session export endpoint.
 * @param ctx - composed Host context.
 * @param request - trusted request already admitted by Host Connection.
 * @param compressionLevel - validated deployment compression level.
 * @returns bodyless HEAD preflight, streaming GET, or fail-loud status.
 */
declare function fetchSessionLogExport(ctx: Context, request: Request, compressionLevel: SessionLogCompressionLevel): Promise<Response>;
//#endregion
//#region src/index.d.ts
/** Persisted hint shared by Session listing and the projection cache. */
interface SessionListMetadata {
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
interface Config {
  /** Project directory used when Session creation names neither workspace nor cwd. */
  readonly cwd?: string;
  /** DEFLATE level for each Session archive entry; defaults to 6. */
  readonly sessionExportCompressionLevel?: SessionLogCompressionLevel;
}
/** Host implementation of G2's generated Session port and Workspace retirer. */
declare class SessionRemoteOperationsService extends Service implements SessionRemoteOperations, WorkspaceSessionRetirer {
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
  /** Admit an unmatched slash line only when the live Agent can resolve its exact user-invocable skill. */
  private admitUnknownCommandAsSkill;
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
//#endregion
export { Config, DEFAULT_SESSION_LOG_COMPRESSION_LEVEL, SESSION_EXPORT_PATH, SessionListMetadata, type SessionLogCompressionLevel, type SessionLogExportDeps, type SessionLogExportReady, type SessionLogZipEntry, SessionRemoteOperationsService, SessionRemoteOperationsService as default, fetchSessionLogExport, flushLiveSessionLog, sessionLogCompressionLevel, sessionLogZipEntries, sessionLogZipFilename, streamSessionLogZip };
//# sourceMappingURL=index.d.ts.map