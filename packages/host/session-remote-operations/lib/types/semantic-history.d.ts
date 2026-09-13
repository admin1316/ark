import type { Context } from '@deepseek-ai/cordis';
import type { PresetBearingSession } from '@deepseek-ai/dsh-agent-presets';
import type { SessionEvent, SessionRemoteHistoryIdentity, SessionRemoteHistoryEntry, SessionRemoteHistoryContentRequest, SessionRemoteHistoryContentValue, SessionRemoteSemanticHistoryRequest, SessionRemoteSemanticHistoryValue } from '@deepseek-ai/dsh-session';
import { type SessionObservation } from '@deepseek-ai/dsh-session-query';
/** A read refusal that can cross the existing Remote result boundary. */
export declare class SemanticHistoryError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
/** Host bounds affect reuse only: self-contained cursors can rebuild evicted indices. */
export interface SemanticHistoryLimits {
    /** Maximum number of reusable history indices. */
    readonly indexEntries?: number;
    /** Byte budget for retained history indices. */
    readonly indexBytes?: number;
    /** Retained content byte budget; one oversize record may finish before further reads are admitted. */
    readonly contentBytes?: number;
    /** Maximum number of simultaneously retained content readers. */
    readonly contentReaders?: number;
    /** Milliseconds of inactivity before a content reader expires. */
    readonly contentIdleMs?: number;
}
type PresentEntry = (event: SessionEvent, dependencies: readonly SessionEvent[]) => Promise<SessionRemoteHistoryEntry>;
type CreatePresenter = (source: PresetBearingSession) => PresentEntry;
/** Numeric indices and optional assembled text; never retains a prepared lease or raw log. */
export declare class SemanticHistoryReader {
    private readonly ctx;
    private readonly createPresenter;
    private readonly generations;
    private readonly indices;
    private readonly content;
    private contentBytes;
    private materializing;
    private readonly maxIndices;
    private readonly maxIndexBytes;
    private readonly maxContentBytes;
    private readonly maxContentReaders;
    private readonly contentIdleMs;
    constructor(ctx: Context, createPresenter: CreatePresenter, limits?: SemanticHistoryLimits);
    /** Release cached indices and retained content readers, including their expiry timers. */
    clear(): void;
    /**
     * Retain one authoritative immutable source for raw and semantic history alike.
     * @param request - Session identity, optional expected child ownership, and optional previously issued source cut.
     * @param signal - cancels observation acquisition; an abort detected before return releases the acquired observation.
     * @returns authorized source and cut with a current-source assertion; the caller must dispose the returned lease.
     * @throws SemanticHistoryError when the query owner is absent, the source is stale, or child ownership is invalid.
     */
    observe(request: SessionRemoteHistoryIdentity & {
        readonly sourceRevision?: string;
    }, signal: AbortSignal): Promise<{
        observed: SessionObservation;
        identity: string;
        through: number;
        revision: string;
        assertCurrent: () => void;
        [Symbol.dispose]: () => void;
    }>;
    private authorize;
    /**
     * Existing preset owner receives only the latest selection at the bound cut.
     * @param observed - retained immutable source whose header and events belong to this read.
     * @param identity - source identity returned with the observation, used to reuse its numeric index.
     * @param through - inclusive fixed event cut; later preset selections are excluded.
     * @param signal - checked while indexing to stop cancelled reads.
     * @returns original header and at most one preset-selection event for the existing preset resolver.
     */
    presentationSource(observed: SessionObservation, identity: string, through: number, signal: AbortSignal): PresetBearingSession;
    /**
     * Read semantic descriptors or fragments of exact JSON content at an authorized source cut.
     * @param request - page cursor or content-reader request, including ownership and source revision where required.
     * @param signal - caller cancellation checked during source observation, indexing, and content production.
     * @returns a semantic page or content fragment; unfinished content is retained until completion, close, expiry, or clear.
     * @throws SemanticHistoryError for invalid requests, stale sources, ownership failures, or exhausted reader budgets.
     */
    read(request: SessionRemoteSemanticHistoryRequest | SessionRemoteHistoryContentRequest, signal: AbortSignal): Promise<SessionRemoteSemanticHistoryValue | SessionRemoteHistoryContentValue>;
    private continueContent;
    private assertCurrent;
    private currentChildDescriptor;
    private identity;
    private cut;
    private index;
    private blocks;
    private preview;
    private recordText;
    private turnContexts;
    private dependencyBundle;
    private expiry;
    private closeContent;
}
export {};
//# sourceMappingURL=semantic-history.d.ts.map