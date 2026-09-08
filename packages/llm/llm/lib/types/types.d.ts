/**
 * Canonical provider-neutral message and streaming vocabulary for the loop,
 * session log, and plugins. Adapters alone translate provider wire messages;
 * mapped interfaces make the content, source, and finish unions extensible.
 */
import type { Branded } from '@deepseek-ai/dsh-brand';
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';
import type { CallId, ProviderRequestId, ReasoningEffortId } from './brand.ts';
import type { RemoteCredentialView } from '@deepseek-ai/dsh-credentials/types';
import type { RemoteSettingsNamespaceView, RemoteSettingsPathOp } from '@deepseek-ai/dsh-settings/types';
import type { Message } from './message.ts';
declare module '@deepseek-ai/cordis' {
    interface Events {
        /**
         * The provider topology changed: an adapter registered or unregistered
         * routes, or the configurable-provider directory gained or lost entries.
         * This payload-free registry notification fires at each commit point
         * (including registration disposal); consumers re-read `listProviders()`,
         * `listModels()`, or `listConfigurableProviders()` for the new state.
         * Observer failures are contained and cannot veto the registry mutation.
         * @mode emit
         */
        'llm/adapters-updated'(): void;
    }
}
export type { AssistantMessage, AssistantProvenance, Message, MessageSource, MessageSourceMap, ModelMessageSource, ToolMessageSource, ToolResultMessage, UserMessage, } from './message.ts';
/** Serializable provider or transport failure facts; policy decides whether they are retryable. */
export interface LlmFailure {
    /** Human-readable provider or transport failure. */
    readonly message: string;
    /** Stable provider-neutral machine-routing code. */
    readonly code: string;
    /** HTTP status returned by the provider, when available. */
    readonly status?: number;
    /** Provider-requested delay in milliseconds, when valid and available. */
    readonly providerRetryAfterMs?: number;
    /** Opaque provider-issued request identifier for diagnostics. */
    readonly requestId?: ProviderRequestId;
}
/** Plain text visible to the end user. */
export interface TextBlock {
    type: 'text';
    text: string;
}
/** Reasoning / thinking content, distinct from visible text. */
export interface ReasoningBlock {
    type: 'reasoning';
    text: string;
}
/**
 * A durable raster image reference, valid in user or assistant content. The
 * block is deliberately role-neutral; assistant-side rendering is forward
 * compatibility — the current production adapters declare text-only output,
 * so only user content carries images today.
 */
export interface ImageBlock {
    type: 'image';
    /** Immutable bytes and intrinsic display metadata owned by the attachment service. */
    attachment: ImageAttachmentRef;
}
/** A tool invocation requested by the model. */
export interface ToolCallBlock {
    type: 'tool-call';
    /** Provider-issued call id; correlates with the matching tool result. */
    id: CallId;
    name: string;
    /** Raw JSON string as produced by the model. */
    arguments: string;
}
/** The result of a tool invocation, sent back to the model. */
export interface ToolResultBlock {
    type: 'tool-result';
    toolCallId: CallId;
    content: ContentBlock[];
    isError?: boolean;
}
/**
 * Merge-extensible content blocks keyed by `type`. New core blocks must land
 * with adapter, UI, and compaction support.
 */
export interface ContentBlockMap {
    'text': TextBlock;
    'reasoning': ReasoningBlock;
    'image': ImageBlock;
    'tool-call': ToolCallBlock;
    'tool-result': ToolResultBlock;
}
/** The block `type` tag vocabulary; widens as plugins add entries to {@link ContentBlockMap}. */
export type ContentBlockType = keyof ContentBlockMap;
/** Any known content block, derived from {@link ContentBlockMap}; switch on `type` and fall through unknowns (merge-extensible). */
export type ContentBlock = ContentBlockMap[ContentBlockType];
/**
 * Why a model response stopped.
 * Merge-extensible so adapters can surface provider-specific reasons.
 */
export interface FinishReasonMap {
    'stop': {
        kind: 'stop';
    };
    'tool-calls': {
        kind: 'tool-calls';
    };
    'max-tokens': {
        kind: 'max-tokens';
    };
    'aborted': {
        kind: 'aborted';
        failure: LlmFailure;
    };
    'error': {
        kind: 'error';
        failure: LlmFailure;
    };
}
/** Any known finish reason, derived from {@link FinishReasonMap}; switch on `kind` and fall through unknowns (merge-extensible). */
export type FinishReason = FinishReasonMap[keyof FinishReasonMap];
/**
 * Token accounting for one model call (cache fields are optional).
 *
 * Counts are DISJOINT: `inputTokens` is uncached input only; cached input is
 * reported separately as `cacheReadTokens`/`cacheWriteTokens` (billed input =
 * sum of the three). Adapters whose providers fold cache hits into a total
 * prompt count (DeepSeek's `prompt_tokens`) subtract them out.
 */
export interface TokenUsage {
    inputTokens: number;
    outputTokens: number;
    /** Exact provider-reported aggregate prompt plus output total, when available. */
    totalTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
}
/** Provider-side price for one ordered image occurrence in a model request. */
export interface LlmImageRequestPrice {
    /** Provider visual tokens; zero when the occurrence is text-only represented. */
    visualTokens: number;
    /** Model-visible text sent with or instead of the image. */
    text: string;
}
/** Synchronous route-owned request-image pricing used by the token meter. */
export interface LlmImageRequestPricing {
    /** Return one price per image occurrence, preserving request order. */
    priceImages(images: readonly ImageAttachmentRef[]): readonly LlmImageRequestPrice[];
}
/** Display metadata for one registered provider route. */
export interface LlmProviderInfo {
    /** Provider route key used by {@link GenerateOptions.provider}. */
    id: string;
    /** Human-readable provider name for selectors and diagnostics. */
    name: string;
}
/** Merge-extensible provider model modality vocabulary. */
export interface ModelModalityMap {
    text: 'text';
    image: 'image';
}
/** Any declared provider model modality. */
export type ModelModality = ModelModalityMap[keyof ModelModalityMap];
/**
 * One provider route an adapter plugin can activate through configuration,
 * whether or not the route is currently registered. Configuration surfaces
 * merge this directory with `listProviders()` to offer every configurable
 * provider alongside its live/dormant state.
 */
export interface LlmConfigurableProvider {
    /** Provider route key this entry activates when configured. */
    provider: string;
    /** Human-readable provider name for configuration surfaces. */
    displayName: string;
    /** User-settings namespace whose section configures this provider. */
    settingsNs: string;
    /**
     * Path from that namespace's section root to this provider's profile
     * object; empty when the whole section is the profile.
     */
    settingsPath: readonly string[];
    /**
     * Whether the owning adapter knows this route only because configuration
     * declared it — a gateway or self-hosted server it ships nothing about.
     * Absent means the adapter draws no such distinction; false means it does
     * and this route is one of its own. Only the adapter can answer: a stored
     * profile is how a user-added route AND a corrected shipped one both look
     * from outside.
     */
    declared?: boolean;
    /** Safe, value-free reason this route is withheld until an explicit migration. */
    migrationRequired?: {
        readonly code: 'credential-headers';
        readonly fields: readonly string[];
    };
}
/** Provider row exposed by the native `llm/providers` Remote method. */
export interface RemoteLlmProviderView {
    /** Canonical provider route id. */
    readonly provider: string;
    /** Display name owned by the adapter. */
    readonly displayName: string;
    /** Settings namespace that configures the provider, if one exists. */
    readonly settingsNs: string;
    /** Profile path within the provider settings namespace. */
    readonly settingsPath: readonly string[];
    /** Whether a live adapter currently serves this route. */
    readonly active: boolean;
    /** Whether the owner calls this a declared, user-configured route. */
    readonly declared?: boolean;
    /** Value-free migration state; affected credential values remain redacted. */
    readonly migrationRequired?: {
        readonly code: 'credential-headers';
        readonly fields: readonly string[];
    };
}
/** Result of the native `llm/providers` Remote method. */
export interface RemoteLlmProvidersResult {
    readonly providers: readonly RemoteLlmProviderView[];
}
/** One selectable reasoning effort in a native model catalog row. */
export interface RemoteLlmReasoningEffort {
    readonly id: string;
    readonly name: string;
    readonly description?: string;
}
/** Reasoning controls exported for one exact provider/model route. */
export interface RemoteLlmReasoning {
    readonly efforts: readonly RemoteLlmReasoningEffort[];
    readonly defaultEffort?: string;
}
/** One model row in the native host-scoped catalog. */
export interface RemoteLlmModelView {
    readonly id: string;
    readonly name: string;
    readonly description?: string;
    /** Adapter-configured output cap when one is declared for this exact model. */
    readonly defaultMaxTokens?: number;
    readonly reasoning?: RemoteLlmReasoning;
}
/** One provider group in the native host-scoped model catalog. */
export interface RemoteLlmModelGroup {
    readonly id: string;
    readonly name: string;
    readonly models: readonly RemoteLlmModelView[];
}
/** A provider whose model catalog could not be resolved without failing others. */
export interface RemoteLlmCatalogFailure {
    readonly id: string;
    readonly name: string;
    readonly message: string;
}
/** Result of the native `llm/models` Remote method. */
export interface RemoteLlmModelsResult {
    readonly groups: readonly RemoteLlmModelGroup[];
    readonly failures: readonly RemoteLlmCatalogFailure[];
}
/** One write-only credential change bundled with a provider settings mutation. */
export type RemoteLlmCredentialMutation = {
    readonly op: 'set';
    readonly ref: string;
    readonly value: string;
} | {
    readonly op: 'unset';
    readonly ref: string;
};
/** Idempotent configuration transaction accepted by `llm/mutateProvider`. */
export interface RemoteLlmProviderMutationRequest {
    /** Stable retry id. Retrying with different input is refused. */
    readonly transactionId: string;
    /** Provider route whose declared settings entry owns this transaction. */
    readonly provider: string;
    /** Settings namespace addressed by every `ops` path. */
    readonly settingsNs: string;
    /** Non-overlapping settings edits. Their values never enter the durable journal. */
    readonly ops: readonly RemoteSettingsPathOp[];
    /** Revision observed by the configuration surface. */
    readonly expectedRevision: number;
    /** Optional write-only reference change. */
    readonly credential?: RemoteLlmCredentialMutation;
}
/** Redacted receipt of one committed provider configuration transaction. */
export interface RemoteLlmProviderMutationResult {
    readonly settings: RemoteSettingsNamespaceView;
    readonly credential?: RemoteCredentialView;
    /** The persisted profile is also the generation currently serving this route. */
    /** Added after legacy clients shipped; absence means the older response version. */
    readonly live?: {
        readonly accepted: true;
    };
}
/** Secret-free lookup for one durable provider transaction. */
export interface RemoteLlmProviderTransactionRequest {
    readonly provider: string;
    readonly transactionId: string;
}
/** Durable transaction state; credential material is never part of this view. */
export interface RemoteLlmProviderTransactionResult {
    readonly state: 'absent' | 'prepared' | 'credential-staged' | 'settings-applied' | 'credential-applied' | 'committed' | 'rolled-back' | 'committed-not-live';
    readonly needsCredential: boolean;
    readonly settingsNs?: string;
    readonly live?: boolean;
}
/** Restart-safe continuation of a journaled provider transaction. */
export interface RemoteLlmProviderResumeRequest {
    readonly provider: string;
    readonly transactionId: string;
    /** Write-only replacement for a secret the process never persisted. */
    readonly credentialValue?: string;
}
/** Exact provider/model/auth probe accepted by `llm/verifyProvider`. */
export interface RemoteLlmProviderVerificationRequest {
    readonly provider: string;
    readonly model: string;
}
/** How an adapter proved the exact route could authenticate. */
export type LlmProviderVerificationMode = 'metadata-auth' | 'endpoint-catalog' | 'minimal-generation';
/** A successful bounded probe. Failures use the normal typed Remote error path. */
export type RemoteLlmProviderVerificationResult = {
    readonly provider: string;
    readonly model: string;
    readonly verified: true;
    /** Auth-protected metadata probes are non-generative; fallback output is discarded. */
    readonly mode: Exclude<LlmProviderVerificationMode, 'endpoint-catalog'>;
} | {
    readonly provider: string;
    readonly model: string;
    /** A public metadata endpoint proves reachability/catalog only, never auth. */
    readonly verified: false;
    readonly mode: 'endpoint-catalog';
    readonly classification: 'reachability-only';
};
/** One model discovered from a draft configuration without storing its secret. */
export interface RemoteLlmDiscoveredModel {
    readonly id: string;
    readonly name?: string;
    readonly contextWindow?: number;
    readonly maxTokens?: number;
}
/** Draft endpoint input accepted by `llm/discoverModels`. */
export interface RemoteLlmDiscoverModelsRequest {
    readonly settingsNs: string;
    readonly provider?: string;
    readonly baseURL?: string;
    readonly api?: string;
    /** Write-only one-shot credential; no return type carries it. */
    readonly apiKey?: string;
}
/** Result of `llm/discoverModels`. */
export interface RemoteLlmDiscoveredModelsResult {
    readonly models: readonly RemoteLlmDiscoveredModel[];
}
/**
 * One interrogation of a provider endpoint that configuration has not stored
 * yet. Configuration surfaces send the draft a user is still editing, so the
 * request carries the endpoint and credential directly instead of naming a
 * route: a provider being added has no route to name.
 */
export interface LlmModelDiscoveryRequest {
    /**
     * Route the draft is editing, when it edits an existing one. A route whose
     * adapter already knows its models answers from that knowledge only when no
     * endpoint override is supplied; an explicit baseURL is always interrogated.
     */
    provider?: string;
    /**
     * Endpoint to interrogate. Optional because a route the adapter already
     * describes needs none; when present it overrides that local catalog answer.
     */
    baseURL?: string;
    /** Wire protocol the endpoint speaks, when the draft names one. */
    api?: string;
    /** Credential for this interrogation alone; the harness never stores it. */
    apiKey?: string;
    /**
     * Host-owned binding between the one-shot credential and this exact endpoint
     * plus protocol. Callers never supply it directly; `LlmRuntime` stamps it
     * immediately before invoking the registered discovery owner.
     */
    credentialEndpointFingerprint?: string;
    /** Caller cancellation; implementations must settle promptly after it aborts. */
    signal?: AbortSignal;
}
/**
 * One model an endpoint reports about itself. Every field but the id is
 * optional because most provider listings disclose an id and nothing else;
 * a surface adopting one of these still owes the capacities its adapter needs.
 */
export interface LlmDiscoveredModel {
    /** Model id the endpoint accepts. */
    id: string;
    /** Human-readable name when the endpoint supplies one. */
    name?: string;
    /** Maximum combined request and response context, when disclosed. */
    contextWindow?: number;
    /** Maximum output tokens, when disclosed. */
    maxTokens?: number;
}
/** One adapter-discovered model; catalog membership is advisory, not request validation. */
export interface LlmModelInfo {
    /** Provider route that owns this model entry. */
    provider: string;
    /** Model id passed to {@link GenerateOptions.model}. */
    id: string;
    /** Human-readable model name for selectors. */
    name: string;
    /** Optional user-facing distinction from otherwise similar models. */
    description?: string;
    /** Accepted request modalities; absent means unknown, while an explicit omission is negative capability. */
    inputModalities?: readonly ModelModality[];
}
/** Provider-owned context capacity for one exact provider/model route. */
export interface LlmModelContext {
    /** Maximum combined request and response context in tokens. */
    contextWindow: number;
}
/** Display metadata for one adapter-owned reasoning effort. */
export interface LlmReasoningEffortInfo {
    /** Opaque stable value accepted by {@link GenerateOptions.reasoningEffort}. */
    id: ReasoningEffortId;
    /** Human-readable effort name for selectors and diagnostics. */
    name: string;
    /** Optional user-facing distinction from otherwise similar efforts. */
    description?: string;
}
/** Selectable reasoning efforts for one exact provider/model route. */
export interface LlmModelReasoningInfo {
    /** Supported efforts in adapter-preferred display order. */
    efforts: readonly LlmReasoningEffortInfo[];
    /**
     * Adapter-configured default materialized into requests when callers omit
     * an effort. Absence preserves the provider's own default.
     */
    defaultEffort?: ReasoningEffortId;
}
/** Exact-route model metadata resolved by its owning adapter. */
export interface LlmResolvedModelInfo extends LlmModelInfo {
    /** Provider-owned context capacity when known. */
    context?: LlmModelContext;
    /** Adapter-configured per-request output cap materialized when callers omit one. */
    defaultMaxTokens?: number;
    /** Adapter-owned selectable reasoning levels when exposed. */
    reasoning?: LlmModelReasoningInfo;
}
/**
 * Adapter-private lossless-JSON state for replaying a successful response,
 * carried by a terminal `finish` chunk and stored on the assembled assistant
 * message's model source. Both halves stay opaque to the harness; only the
 * split is shared vocabulary, so assembly can keep stored metadata aligned
 * with stored content without reading either half.
 */
export interface ReplayEnvelope {
    /** Response-level adapter-private metadata (ids, native stop reason). */
    response: unknown;
    /**
     * Per-block adapter-private metadata, one entry per emitted block in
     * first-seen stream order. When assembly drops a block it drops the entry at
     * the same position; entries whose length does not match the emitted block
     * count discard the whole envelope. An adapter whose metadata is independent
     * of block structure omits this field and the envelope passes through
     * assembly unchanged.
     */
    blocks?: readonly unknown[];
}
/**
 * Raw streaming protocol emitted by adapters.
 * Block indexes correlate interleaved deltas, and `block-end` carries the
 * assembled block. Adapters emit usage before the terminal finish and nothing
 * afterward; tool arguments remain raw JSON strings. An adapter implementation
 * may throw, but `LlmRuntime.stream()` normalizes that failure to a terminal
 * `error` or `aborted` finish before exposing it to consumers.
 */
export type StreamChunk = {
    type: 'block-start';
    index: number;
    blockType: ContentBlockType;
} | {
    type: 'text-delta';
    index: number;
    text: string;
} | {
    type: 'reasoning-delta';
    index: number;
    text: string;
} | {
    type: 'tool-call-delta';
    index: number;
    id: CallId;
    name?: string;
    argumentsDelta: string;
} | {
    type: 'block-end';
    index: number;
    block: ContentBlock;
} | {
    type: 'usage';
    usage: TokenUsage;
} | {
    type: 'finish';
    reason: FinishReason;
    /** Replay metadata for a successful response; see {@link ReplayEnvelope}. */
    replayState?: ReplayEnvelope;
};
/**
 * JSON-schema description of a tool, as sent to the model.
 *
 * Declared here (not in dsh-tools) because it is part of {@link GenerateOptions};
 * dsh-tools' ToolDefinition and dsh-system-prompt's PromptAssembly both import
 * it from this package.
 */
export interface ToolSchema {
    name: string;
    description: string;
    /** JSON Schema object for the arguments. */
    parameters: Record<string, unknown>;
}
/** A single model request, fully assembled. */
export interface GenerateOptions {
    /** Registered provider route selecting the adapter instance. */
    provider: string;
    model: string;
    /** Adapter-owned reasoning effort selected for this exact model. */
    reasoningEffort?: ReasoningEffortId;
    /**
     * Ordered conversation messages, exactly as the provider sees them (after
     * the `system` slot). A loop-built request assembles them as
     * the derived history (dsh-agent-loop); a hand-built one-shot passes any list.
     */
    messages: Message[];
    /** System prompt text (adapters map to the provider's system slot). */
    system?: string;
    /** Tool schemas (adapters map to the provider's `tools` field). */
    tools?: ToolSchema[];
    temperature?: number;
    maxTokens?: number;
    /**
     * Stop sequences: generation halts as soon as the model produces any one of
     * these strings (adapters map to the provider's stop field, e.g. OpenAI
     * `stop`). The stop string itself is not included in the output.
     */
    stop?: string[];
    signal?: AbortSignal;
    /**
     * Session identity stamped by the loop for request routing. Replay uses it
     * to separate cursors; adapters may map it to model-hidden transport metadata.
     */
    sessionId?: Branded<'SessionId'>;
    /**
     * Provider-neutral classification for an auxiliary model call. Adapters may
     * map the purpose to model-hidden transport metadata or purpose-specific
     * generation policy. Ordinary conversation requests leave it unset.
     */
    purpose?: 'compaction' | 'session-title';
}
//# sourceMappingURL=types.d.ts.map