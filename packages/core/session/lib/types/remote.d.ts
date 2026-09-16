/**
 * Typed Remote port for session user flows.
 *
 * The SessionStore owns the generated `session/*` descriptors.  Host
 * composition owns the agent, persistence, attachment, and model integrations
 * needed to fulfill those descriptors; it supplies one implementation of this
 * port.  Keeping the wire contract here prevents a second Session API from
 * growing inside a transport package while retaining the existing lifecycle
 * and authorization owner.
 *
 * @module @deepseek-ai/dsh-session/remote
 */
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
import type { SessionId, SessionPromptInvocationId } from './types.ts';
/** A stable failure emitted by the Session Remote port. */
export interface SessionRemoteFailure {
    readonly ok: false;
    readonly error: {
        readonly code: string;
        readonly message: string;
        readonly details: JsonValue;
    };
}
/** A successful Session Remote response. */
export interface SessionRemoteSuccess<Value> {
    readonly ok: true;
    readonly value: Value;
}
/** One Session Remote response preserving the business failure code. */
export type SessionRemoteResult<Value> = SessionRemoteSuccess<Value> | SessionRemoteFailure;
/** A displayed Session row, including only durable or explicitly derived fields. */
export interface SessionRemoteSummary {
    readonly sessionId: SessionId;
    readonly updatedAt: number;
    readonly running: boolean;
    readonly blank: boolean;
    readonly parentSessionId?: SessionId;
    readonly origin?: 'subagent';
    readonly cwd?: string;
    readonly agentPreset?: string;
    readonly projections?: SessionRemoteProjections;
}
/** One exact baseline from the projection registry or persisted projection cache. */
export interface SessionRemoteProjections {
    readonly asOfSeq: number;
    readonly values: Record<string, JsonValue>;
}
/** One bounded session-search hit. */
export interface SessionRemoteSearchItem {
    readonly sessionId: SessionId;
    readonly snippet: string;
}
/**
 * Wire-safe durable event envelope. The Session store validates every event
 * payload as lossless JSON before persistence; this boundary intentionally
 * does not carry the merge-extensible Host-only event map's `unknown` escape
 * hatch into generated Remote codecs.
 */
export interface SessionRemoteEvent {
    readonly type: string;
    readonly seq: number;
    readonly time: number;
    readonly data: JsonValue;
    readonly sourceEventSeqs?: readonly number[];
    readonly surfaceOp?: JsonValue;
    readonly ignorable?: true;
}
/** One optional presentation projection for a durable history event. */
export interface SessionRemoteHistoryEntry {
    readonly event: SessionRemoteEvent;
    readonly view?: JsonValue;
}
/** The complete model target used by the next agent step. */
export interface SessionRemoteModelSelection {
    readonly provider: string;
    readonly model: string;
    readonly reasoningEffort?: string;
}
/** One selectable reasoning effort for an exact provider/model route. */
export interface SessionRemoteReasoningEffort {
    readonly id: string;
    readonly name: string;
    readonly description?: string;
}
/** Adapter-owned reasoning metadata for one model. */
export interface SessionRemoteModelReasoning {
    readonly efforts: readonly SessionRemoteReasoningEffort[];
    readonly defaultEffort?: string;
}
/** One advertised model. Catalog membership is advisory, never authorization. */
export interface SessionRemoteCatalogModel {
    readonly id: string;
    readonly name: string;
    readonly description?: string;
    readonly reasoning?: SessionRemoteModelReasoning;
}
/** One provider's successful catalog response. */
export interface SessionRemoteProviderGroup {
    readonly id: string;
    readonly name: string;
    readonly models: readonly SessionRemoteCatalogModel[];
}
/** A non-fatal provider-local catalog failure. */
export interface SessionRemoteCatalogFailure {
    readonly id: string;
    readonly name: string;
    readonly message: string;
}
/** Model directory returned for one ordinary Session. */
export interface SessionRemoteModels {
    readonly current: SessionRemoteModelSelection;
    readonly routable: boolean;
    readonly groups: readonly SessionRemoteProviderGroup[];
    readonly failures: readonly SessionRemoteCatalogFailure[];
}
/** Raster formats accepted by the Session upload boundary. */
export type SessionRemoteImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
/** One browser/native prompt content part. */
export type SessionRemotePromptContentPart = {
    readonly type: 'text';
    readonly text: string;
} | {
    readonly type: 'image';
    readonly mediaType: SessionRemoteImageMediaType;
    readonly data: string;
    readonly name?: string;
};
/** A durable image reference proven to be reachable from the addressed Session. */
export interface SessionRemoteImageAttachment {
    readonly attachmentId: string;
    readonly mediaType: SessionRemoteImageMediaType;
    readonly bytes: number;
    readonly width: number;
    readonly height: number;
    readonly name?: string;
    readonly originalDimensions?: {
        readonly width: number;
        readonly height: number;
    };
}
/** A pending-queue mutation. */
export type SessionRemoteQueueAction = {
    readonly kind: 'edit';
    readonly content: readonly JsonValue[];
} | {
    readonly kind: 'remove';
} | {
    readonly kind: 'steer';
};
/** Inputs and outputs for `session/list`. */
export interface SessionRemoteListRequest {
    readonly cursor?: string;
}
/**
 * Describes the session remote list value value used by this package.
 */
export interface SessionRemoteListValue {
    readonly items: readonly SessionRemoteSummary[];
}
/** Inputs and outputs for `session/search`. */
export interface SessionRemoteSearchRequest {
    readonly query: string;
}
/**
 * Describes the session remote search value value used by this package.
 */
export interface SessionRemoteSearchValue {
    readonly items: readonly SessionRemoteSearchItem[];
    readonly hasMore: boolean;
}
/** Inputs and outputs for `session/create`. */
export interface SessionRemoteCreateRequest {
    readonly workspaceId?: string;
    readonly cwd?: string;
    readonly sessionId?: SessionId;
    readonly agentPreset?: string;
}
/**
 * Describes the session remote create value value used by this package.
 */
export interface SessionRemoteCreateValue {
    readonly sessionId: SessionId;
    readonly agentPreset?: string;
}
/** Identity checked independently for every history page and content fragment. */
export interface SessionRemoteHistoryIdentity {
    readonly sessionId: SessionId;
    readonly expectedParentSessionId?: SessionId;
    /** Required with the direct parent for descriptor-backed child history. */
    readonly expectedSubagentMode?: 'one-shot' | 'continuable';
}
/** Existing raw event page; sequence cursors keep their original meaning. */
export interface SessionRemoteRawHistoryRequest extends SessionRemoteHistoryIdentity {
    readonly view?: 'raw';
    /** Reuse a semantic or explicit raw cut; view: raw establishes one when omitted. */
    readonly sourceRevision?: string;
    readonly beforeSeq?: number;
    readonly maxMessages?: number;
    /** Hard raw-event budget from 1 through 2,048; defaults to 2,048 independently of the message boundary. */
    readonly maxEvents?: number;
}
/** Complete semantic records at one fixed source cut. */
export interface SessionRemoteSemanticHistoryRequest extends SessionRemoteHistoryIdentity {
    readonly view: 'semantic';
    readonly sourceRevision?: string;
    readonly beforeRecordId?: string;
    readonly maxRecords?: number;
}
/** Exact JSON content of one record, transferred without a giant page payload. */
export interface SessionRemoteHistoryContentRequest extends SessionRemoteHistoryIdentity {
    readonly view: 'content';
    readonly sourceRevision: string;
    readonly recordId: string;
    /** Continuation handle returned by the initial offset-zero content read. */
    readonly contentReadId?: string;
    /** Release an unfinished materialization without fetching another fragment. */
    readonly close?: boolean;
    /** UTF-16 offset; returned boundaries never split a surrogate pair. */
    readonly offset?: number;
    readonly maxCodeUnits?: number;
}
/** History query selecting raw events, a fixed-cut semantic page, or one retained content fragment. */
export type SessionRemoteHistoryRequest = SessionRemoteRawHistoryRequest | SessionRemoteSemanticHistoryRequest | SessionRemoteHistoryContentRequest;
/** Existing raw event history response. */
export interface SessionRemoteRawHistoryValue {
    readonly view?: 'raw';
    /** Always present for explicit raw or revision-bound requests; absent on legacy pages. */
    readonly sourceRevision?: string;
    readonly asOfThroughSeq?: number;
    readonly events: readonly SessionRemoteHistoryEntry[];
    readonly hasMore: boolean;
    readonly projections?: SessionRemoteProjections;
}
/** A bounded descriptor; complete typed content is available through `view: content`. */
export interface SessionRemoteSemanticRecord {
    readonly id: string;
    readonly kind: 'user' | 'assistant' | 'tool';
    readonly orderSeq: number;
    readonly time: number;
    readonly turn?: number;
    readonly step?: number;
    readonly state: 'complete' | 'interrupted' | 'active' | 'failed-prefix' | 'orphaned-prefix' | 'unpaired';
    readonly preview: string;
    readonly contentState: 'complete-at-cut';
    readonly canonicalEventSeq?: number;
    readonly callEventSeq?: number;
    readonly resultEventSeq?: number;
    /** Only a completed turn ending is eligible for the existing fork admission. */
    readonly completedTurnEndSeq?: number;
}
/** Exact provider accounting, admitted by token-meter's existing strict turn fold. */
export interface SessionRemoteHistoryTurnUsage {
    readonly uncachedInputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
    readonly cacheReadTokens?: number;
    readonly cacheWriteTokens?: number;
    readonly reasoningTokens?: number;
    readonly routes?: readonly {
        readonly provider: string;
        readonly model: string;
    }[];
}
/** Compact facts at the same cut; null usage explicitly means unproven. */
export interface SessionRemoteHistoryTurnContext {
    readonly turn: number;
    readonly startSeq?: number;
    readonly endSeq?: number;
    readonly usage: SessionRemoteHistoryTurnUsage | null;
}
/** Independently seeded domain evidence, never a contiguous live event stream. */
export interface SessionRemoteHistoryDependencyBundle {
    readonly kind: 'dependency';
    readonly domain: 'tool' | 'status' | 'turn';
    readonly sourceRevision: string;
    readonly asOfThroughSeq: number;
    readonly completeness: 'complete' | 'unknown';
    readonly chunkCoverage: 'none' | 'timing-boundaries';
    readonly missing: readonly ('parent-call' | 'dispatch-start' | 'workflow-start' | 'workflow-member' | 'command-start' | 'compaction-start' | 'turn-start')[];
    readonly entries: readonly SessionRemoteHistoryEntry[];
    readonly turns: readonly SessionRemoteHistoryTurnContext[];
}
/** Independent semantic page; never a contiguous raw event log. */
export interface SessionRemoteSemanticHistoryValue {
    readonly view: 'semantic';
    readonly sourceRevision: string;
    readonly asOfThroughSeq: number;
    readonly records: readonly SessionRemoteSemanticRecord[];
    readonly turns: readonly SessionRemoteHistoryTurnContext[];
    readonly dependencyRecords: {
        readonly tool: string;
        readonly status: string;
        readonly turn: string;
    };
    readonly hasMore: boolean;
    readonly nextBeforeRecordId?: string;
    /** These domains still use their existing owners until typed dependency closure lands. */
    readonly pendingDomains: readonly ('status' | 'usage-context' | 'workflow')[];
}
/** Concatenate fragments before JSON decoding; offsets refer to the exact same source cut. */
export interface SessionRemoteHistoryContentValue {
    readonly view: 'content';
    readonly sourceRevision: string;
    readonly asOfThroughSeq: number;
    readonly recordId: string;
    readonly encoding: 'json';
    readonly contentReadId: string;
    readonly offset: number;
    readonly text: string;
    readonly nextOffset: number;
    readonly done: boolean;
}
/** History response for the requested view; revision-bound pages and fragments identify their exact source cut. */
export type SessionRemoteHistoryValue = SessionRemoteRawHistoryValue | SessionRemoteSemanticHistoryValue | SessionRemoteHistoryContentValue;
/** Inputs and outputs for model discovery and selection. */
export interface SessionRemoteModelsRequest {
    readonly sessionId: SessionId;
}
/**
 * Describes the session remote select model request value used by this package.
 */
export interface SessionRemoteSelectModelRequest extends SessionRemoteModelsRequest {
    readonly provider: string;
    readonly model: string;
    readonly reasoningEffort?: string;
}
/**
 * Describes the session remote select model value value used by this package.
 */
export interface SessionRemoteSelectModelValue {
    readonly selected: SessionRemoteModelSelection;
}
/** Inputs and outputs for durable title and fork changes. */
export interface SessionRemoteRenameRequest {
    readonly sessionId: SessionId;
    readonly title: string;
}
/**
 * Describes the session remote rename value value used by this package.
 */
export interface SessionRemoteRenameValue {
    readonly title: string;
    readonly seq: number;
}
/**
 * Describes the session remote fork request value used by this package.
 */
export interface SessionRemoteForkRequest extends SessionRemoteHistoryIdentity {
    readonly atSeq?: number;
    /** Bind the fork seed to a previously read raw/semantic source and inclusive cut. */
    readonly sourceRevision?: string;
}
/**
 * Describes the session remote fork value value used by this package.
 */
export interface SessionRemoteForkValue {
    readonly sessionId: SessionId;
}
/** Inputs and output for prompt admission. */
export interface SessionRemotePromptRequest {
    readonly sessionId: SessionId;
    readonly invocationId: SessionPromptInvocationId;
    readonly mode: 'queue' | 'steer';
    readonly content: readonly SessionRemotePromptContentPart[];
    readonly clientTimeZone?: string;
}
/**
 * Describes the session remote prompt value value used by this package.
 */
export interface SessionRemotePromptValue {
    readonly accepted: true;
    readonly command?: {
        readonly kind: 'success';
        readonly text?: string;
    };
}
/** Inputs and output for attachment retrieval. */
export interface SessionRemoteAttachmentRequest {
    readonly sessionId: SessionId;
    readonly attachmentId: string;
}
/**
 * Describes the session remote attachment value value used by this package.
 */
export interface SessionRemoteAttachmentValue {
    readonly attachment: SessionRemoteImageAttachment;
    readonly data: string;
}
/** Inputs and outputs for queue changes and turn cancellation. */
export interface SessionRemoteUpdateQueueRequest {
    readonly sessionId: SessionId;
    readonly itemId: string;
    readonly action: SessionRemoteQueueAction;
}
/**
 * Describes the session remote accepted value value used by this package.
 */
export interface SessionRemoteAcceptedValue {
    readonly accepted: true;
}
/**
 * Describes the session remote cancel request value used by this package.
 */
export interface SessionRemoteCancelRequest {
    readonly sessionId: SessionId;
}
/**
 * Host-composed implementation for the generated `session/*` descriptors.
 *
 * This port deliberately owns no lifecycle handles: callers must preserve the
 * existing agent/persistence/attachment authorization and cancellation logic.
 */
export interface SessionRemoteOperations {
    list(request: SessionRemoteListRequest, signal: AbortSignal): Promise<SessionRemoteResult<SessionRemoteListValue>>;
    search(request: SessionRemoteSearchRequest, signal: AbortSignal): Promise<SessionRemoteResult<SessionRemoteSearchValue>>;
    create(request: SessionRemoteCreateRequest, signal: AbortSignal): Promise<SessionRemoteResult<SessionRemoteCreateValue>>;
    history(request: SessionRemoteHistoryRequest, signal: AbortSignal): Promise<SessionRemoteResult<SessionRemoteHistoryValue>>;
    models(request: SessionRemoteModelsRequest, signal: AbortSignal): Promise<SessionRemoteResult<SessionRemoteModels>>;
    selectModel(request: SessionRemoteSelectModelRequest, signal: AbortSignal): Promise<SessionRemoteResult<SessionRemoteSelectModelValue>>;
    rename(request: SessionRemoteRenameRequest, signal: AbortSignal): Promise<SessionRemoteResult<SessionRemoteRenameValue>>;
    fork(request: SessionRemoteForkRequest, signal: AbortSignal): Promise<SessionRemoteResult<SessionRemoteForkValue>>;
    prompt(request: SessionRemotePromptRequest, signal: AbortSignal): Promise<SessionRemoteResult<SessionRemotePromptValue>>;
    attachment(request: SessionRemoteAttachmentRequest, signal: AbortSignal): Promise<SessionRemoteResult<SessionRemoteAttachmentValue>>;
    updateQueue(request: SessionRemoteUpdateQueueRequest, signal: AbortSignal): Promise<SessionRemoteResult<SessionRemoteAcceptedValue>>;
    cancel(request: SessionRemoteCancelRequest, signal: AbortSignal): Promise<SessionRemoteResult<SessionRemoteAcceptedValue>>;
}
/**
 * Build the standard unavailable failure without exposing transport internals.
 * @returns The value produced by session remote unavailable.
 */
export declare function sessionRemoteUnavailable(): SessionRemoteFailure;
/**
 * Build the standard caller-cancelled result for direct owner tests.
 * @returns The value produced by session remote cancelled.
 */
export declare function sessionRemoteCancelled(): SessionRemoteFailure;
//# sourceMappingURL=remote.d.ts.map