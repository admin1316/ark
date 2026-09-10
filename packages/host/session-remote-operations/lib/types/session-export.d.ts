/**
 * Host-owned Session log download.
 *
 * The download streams each persisted Session artifact verbatim, optionally
 * includes every descendant under `subagents/`, and carries each referenced
 * image once under `media/`. A live Session crosses the authoritative flush
 * barrier immediately before its raw artifact is read. Compression and the
 * response queue are bounded, and request or consumer cancellation terminates
 * the producer rather than yielding a truncated archive.
 *
 * @module @deepseek-ai/dsh-host-session-remote-operations/session-export
 */
import type { Context } from '@deepseek-ai/cordis';
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment';
import { SessionId, type SessionStore } from '@deepseek-ai/dsh-session';
import type { SessionPersistence, SessionRawArtifact } from '@deepseek-ai/dsh-session-persistence';
import type { SessionQueryEngine } from '@deepseek-ai/dsh-session-query';
/** Final Host path for the Native Session archive download. */
export declare const SESSION_EXPORT_PATH = "/api/session/export";
/** Valid fflate DEFLATE levels accepted by Session export. */
export type SessionLogCompressionLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
/** Balanced default for Session archive compression. */
export declare const DEFAULT_SESSION_LOG_COMPRESSION_LEVEL: SessionLogCompressionLevel;
/** The services a Session export needs (the live store is optional). */
export interface SessionLogExportDeps {
    readonly sessionQuery: SessionQueryEngine | undefined;
    readonly sessionPersistence: SessionPersistence | undefined;
    readonly attachments: AttachmentStore | undefined;
    readonly sessions: SessionStore | undefined;
}
/** Export services narrowed to the mounted owners used by streaming. */
export interface SessionLogExportReady {
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
export declare function sessionLogCompressionLevel(value?: number): SessionLogCompressionLevel;
/**
 * Resolve the persistence, lineage, attachment, and live-session owners.
 * @param ctx - composed Host context.
 * @returns mounted owners, retaining absence for fail-loud HTTP responses.
 */
export declare function sessionLogExportDeps(ctx: Context): SessionLogExportDeps;
/**
 * Flush a live Session immediately before reading its raw durable artifact.
 * @param deps - export owners including the optional live Session store.
 * @param id - Session being read.
 * @param signal - caller cancellation around the durability barrier.
 */
export declare function flushLiveSessionLog(deps: Pick<SessionLogExportDeps, 'sessions'>, id: SessionId, signal?: AbortSignal): Promise<void>;
/** One exported artifact or referenced media object. */
export type SessionLogZipEntry = {
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
export declare function sessionLogZipFilename(sessionId: string): string;
/**
 * Yield root, descendants, then distinct referenced media in archive order.
 * @param deps - mounted export owners.
 * @param root - already-prepared root artifact.
 * @param sessionId - root Session identity.
 * @param includeDescendants - whether lineage descendants are included.
 * @param signal - read and lineage cancellation.
 * @returns entries in deterministic archive order.
 */
export declare function sessionLogZipEntries(deps: SessionLogExportReady, root: SessionRawArtifact, sessionId: SessionId, includeDescendants: boolean, signal?: AbortSignal): AsyncGenerator<SessionLogZipEntry>;
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
export declare function streamSessionLogZip(deps: SessionLogExportReady, root: SessionRawArtifact, sessionId: SessionId, includeDescendants: boolean, compressionLevel: SessionLogCompressionLevel, signal: AbortSignal): ReadableStream<Uint8Array>;
/**
 * Handle the final GET/HEAD Session export endpoint.
 * @param ctx - composed Host context.
 * @param request - trusted request already admitted by Host Connection.
 * @param compressionLevel - validated deployment compression level.
 * @returns bodyless HEAD preflight, streaming GET, or fail-loud status.
 */
export declare function fetchSessionLogExport(ctx: Context, request: Request, compressionLevel: SessionLogCompressionLevel): Promise<Response>;
//# sourceMappingURL=session-export.d.ts.map