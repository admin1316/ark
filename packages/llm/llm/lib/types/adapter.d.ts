/**
 * The adapter contract surface: what a provider adapter implements, what a
 * registration returns, and the prepared-call snapshot. Provider packages
 * (pi-ai, deepseek) depend on this module; the runtime imports it too.
 *
 * @module @deepseek-ai/dsh-llm/adapter
 */
import type { GenerateOptions, LlmConfigurableProvider, LlmModelContext, LlmModelInfo, ModelModality, LlmProviderInfo, LlmProviderVerificationMode, LlmResolvedModelInfo, LlmImageRequestPricing, StreamChunk } from './types.ts';
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment';
import type { LlmCallConfig, LlmCallConfigAdapterDefaults } from './call-config.ts';
import type { ResolvedRetryPolicy } from './retry-policy.ts';
import { type ImageAttachmentAccessResolver } from './content.ts';
/** One model call whose config and adapter registration were resolved together. */
export interface PreparedLlmCall {
    /** Detached, deep-frozen config with any adapter-owned default materialized. */
    readonly config: LlmCallConfig;
    /** Immutable retry policy captured with the adapter registration. */
    readonly retryPolicy: ResolvedRetryPolicy;
    /** Detached context metadata resolved with the registration-bound call. */
    readonly context?: LlmModelContext;
    /** Exact model modalities captured with the adapter dispatch generation. */
    readonly inputModalities?: readonly ModelModality[];
    /** Config fields materialized by the captured adapter rather than proposed by the caller. */
    readonly adapterDefaults: LlmCallConfigAdapterDefaults;
    /**
     * Dispatch this call once through the registration captured during
     * preparation. The request's call-config fields must match {@link config};
     * reuse or mismatch fails with `INVALID_PREPARED_CALL`.
     * @param options - fully assembled request carrying the prepared config.
     * @returns the chunk stream, including the `llm/stream` waterfall.
     */
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
}
/** One adapter-owned model-resolution generation bound to its eventual stream call. */
export interface PreparedAdapterCall {
    /** Exact model metadata from the same adapter generation as {@link stream}. */
    readonly model: LlmResolvedModelInfo;
    /** Dispatch through that generation without re-reading dynamic connection facts. */
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
}
/**
 * Build one live image-access resolver from the provider composition's service lookups.
 * Keeping this in the adapter contract layer gives every provider the same attachment/path
 * behavior without making the provider-neutral LLM package own a filesystem service.
 * @param resolveAttachments - resolves the currently mounted attachment store.
 * @param mapHostPath - maps a host path through the currently mounted filesystem service.
 * @returns a resolver that observes both services at call time.
 */
export declare function createImageAttachmentAccessResolver(resolveAttachments: () => AttachmentStore | undefined, mapHostPath: (hostPath: string) => string | undefined): ImageAttachmentAccessResolver;
/**
 * Provider-wire adapter for the harness message and stream vocabulary. Register implementations
 * with `ctx.llm.registerAdapter(providers, adapter)`. Every provider HTTP request must include
 * `attributionHeaders()`; prove the headers are added in the wire request or library header hook. The direct-fetch
 * DeepSeek and library-backed pi-ai adapters meet this contract through different internals.
 */
export declare abstract class LlmAdapter {
    /**
     * Describe one provider route owned by this adapter.
     * @param provider - a route passed to `registerAdapter()` for this instance.
     * @returns detached display metadata whose id must equal `provider`.
     */
    providerInfo(provider: string): LlmProviderInfo;
    /**
     * Return the provider-owned retry policy captured with this route.
     * @param _provider - a route passed to `registerAdapter()` for this instance.
     * @returns a resolved policy, or `undefined` to use the normal defaults.
     */
    providerRetryPolicy(_provider: string): ResolvedRetryPolicy | undefined;
    /**
     * Resolve synchronous provider-side request-image pricing for one exact
     * route. Adapters without visual-token billing return undefined.
     * @param _provider - one provider route owned by this adapter.
     * @param _model - exact model id whose image input will be priced.
     * @returns synchronous image-pricing metadata, or `undefined` when unsupported.
     */
    imageRequestPricing(_provider: string, _model: string): LlmImageRequestPricing | undefined;
    /**
     * List models this adapter can currently advertise for one owned provider.
     * The result is advisory: an adapter may accept unlisted model ids, and
     * consumers must not turn absence into request rejection.
     * @param _provider - one provider route owned by this adapter.
     * @returns discoverable models in adapter-preferred order.
     */
    listModels(_provider: string): Promise<readonly LlmModelInfo[]>;
    /**
     * Resolve all metadata available for one exact model. This query is
     * independent of the advisory catalog and does not validate request routing.
     * @param provider - one provider route owned by this adapter.
     * @param model - exact model id passed to {@link GenerateOptions.model}.
     * @param _signal - cancellation for this exact-model lookup; asynchronous
     *   implementations must settle promptly after it aborts.
     * @returns provider/model identity plus any context, call-default, and reasoning metadata.
     */
    resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
    /**
     * Perform a protocol-native, non-generative authentication/metadata probe
     * when the adapter supports one. Returning `undefined` asks LlmRuntime to use
     * its explicitly classified minimal-generation fallback.
     * @param _provider - exact registered provider route.
     * @param _model - exact configured model id.
     * @param _signal - owner cancellation signal.
     * @returns the non-generative mode, or undefined for the bounded fallback.
     */
    verifyProvider(_provider: string, _model: string, _signal: AbortSignal): Promise<LlmProviderVerificationMode | undefined>;
    /**
     * Bind exact model metadata and the eventual request dispatch to one adapter generation.
     * Dynamic adapters override this so settings changes between preparation and
     * dispatch cannot combine one generation's capabilities with another's endpoint.
     * @param provider - registered provider route.
     * @param model - exact model id.
     * @param signal - cancellation for model resolution.
     * @returns model metadata and a one-generation stream entry point.
     */
    prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall>;
    /**
     * Stream one model call as raw chunks. The only required method.
     * @param options - the fully-assembled request; implementations must honor `options.signal`.
     * @returns the chunk stream, obeying the adapter contract documented on `StreamChunk`.
     */
    abstract stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
}
/**
 * What {@link LlmRuntime.registerAdapter} returns: the disposer, plus an
 * atomic route replacement for the same adapter instance.
 */
export interface AdapterRegistrationHandle {
    /** Release every route this registration currently holds. */
    (): void;
    /**
     * Replace this registration's routes with `providers`, keeping the same
     * adapter instance. The candidate set is validated in full first — a
     * conflict with another adapter, an invalid name, or bad provider metadata
     * throws and leaves the current routes untouched — and the swap itself is
     * one synchronous section, so no request can observe a gap. An empty array
     * is legal here (a settings section that emptied holds zero routes while
     * staying registered), unlike an empty initial registration.
     *
     * Throws `LlmError` with code `REGISTRATION_DISPOSED` once the registration
     * has been released: its routes are gone and its disposer has already run,
     * so anything registered afterwards would have no owner left to release it.
     * @param providers - the complete next route set for this registration.
     */
    replace(providers: string[]): void;
}
/**
 * A live configurable-provider registration, disposable and atomically
 * replaceable — the directory counterpart of {@link AdapterRegistrationHandle}.
 */
export interface DirectoryRegistrationHandle {
    /** Withdraw every entry this registration currently holds. */
    (): void;
    /**
     * Replace this registration's entries with `entries`. The candidate set is
     * validated in full first — an entry another registration already declares,
     * a duplicate within the set, or invalid metadata throws and leaves the
     * current entries untouched — and the swap is one synchronous section, so no
     * reader observes a gap. An empty array is legal here, unlike an empty
     * initial registration.
     *
     * Throws `LlmError` with code `REGISTRATION_DISPOSED` once the registration
     * has been disposed.
     */
    replace(entries: readonly LlmConfigurableProvider[]): void;
}
/**
 * The abstract `llm` service: an adapter registry plus a streaming model-call
 * API, interceptable via the `llm/stream` waterfall.
 */
//# sourceMappingURL=adapter.d.ts.map