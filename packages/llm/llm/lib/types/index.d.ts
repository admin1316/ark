/**
 * LLM service: adapter registry with a waterfall-interceptable streaming call
 * API. Exports the `LlmRuntime` default, the abstract `LlmAdapter` for
 * provider backends, and `BlockAssembler` for chunk assembly.
 *
 * @module @deepseek-ai/dsh-llm
 */
import { Context } from '@deepseek-ai/cordis';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { GenerateOptions, LlmConfigurableProvider, LlmDiscoveredModel, LlmImageRequestPricing, LlmModelDiscoveryRequest, LlmModelInfo, LlmResolvedModelInfo, LlmProviderInfo, LlmProviderVerificationMode, RemoteLlmDiscoverModelsRequest, RemoteLlmDiscoveredModelsResult, RemoteLlmModelsResult, RemoteLlmProviderMutationRequest, RemoteLlmProviderMutationResult, RemoteLlmProviderResumeRequest, RemoteLlmProviderTransactionRequest, RemoteLlmProviderTransactionResult, RemoteLlmProviderVerificationRequest, RemoteLlmProviderVerificationResult, RemoteLlmProvidersResult, StreamChunk } from './types.ts';
import type { ResolvedRetryPolicy } from './retry-policy.ts';
import type { LlmCallConfig } from './call-config.ts';
import { LlmAdapter, type AdapterRegistrationHandle, type DirectoryRegistrationHandle, type PreparedLlmCall } from './adapter.ts';
export * from './attribution.ts';
export * from './brand.ts';
export * from './never.ts';
export * from './error.ts';
export * from './adapter.ts';
export * from './api-key.ts';
export * from './types.ts';
export * from './content.ts';
export * from './message.ts';
export * from './retry-policy.ts';
export { BlockAssembler } from './assembler.ts';
export { isCredentialHeaderName, projectRemoteModel } from './remote.ts';
export { callConfigEquals, deepFreeze, isAgentLoopRequest, markAgentLoopRequest } from './call-config.ts';
export type { LlmCallConfig, LlmCallConfigAdapterDefaults } from './call-config.ts';
declare module '@deepseek-ai/cordis' {
    interface Context {
        llm: LlmRuntime;
    }
    interface Events {
        /**
         * Waterfall around every streaming model call (retry, replay, routing).
         * Bound to the {@link LlmRuntime}; call `next()` to reach the resolved
         * adapter's stream, or yield your own chunks to short-circuit.
         * @param options - the full request. A LOOP-built request carries the
         *   process-local {@link markAgentLoopRequest} identity and arrives deep-frozen
         *   (mutation throws): its content is a pure function of the session log (the
         *   reconstructability Agent Note), so listeners read it, never rewrite it.
         *   Hand-built calls do not carry that marker; their messages already obey
         *   the immutable creation contract.
         * @mode waterfall
         */
        'llm/stream'(this: LlmRuntime, options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk>;
    }
}
/**
 * Stable identity for the exact endpoint/protocol a one-shot discovery
 * credential may reach. The fingerprint contains no credential material.
 * @param baseURL - candidate endpoint typed by the caller.
 * @param api - candidate wire protocol, defaulted like the discovery owner.
 * @returns SHA-256 endpoint identity.
 */
export declare function modelDiscoveryEndpointFingerprint(baseURL: string, api?: string): string;
/**
 * The abstract `llm` service: an adapter registry plus a streaming model-call
 * API, interceptable via the `llm/stream` waterfall.
 */
export declare class LlmRuntime extends TypertRemoteService {
    private adapters;
    private directory;
    private discoveries;
    private readonly verifications;
    constructor(ctx: Context);
    /** Keep generic Settings Remote writes out of provider-owned namespaces. */
    private syncProtectedSettingsNamespaces;
    /**
     * Read configurable providers through the domain-owned Native Remote.
     * @returns the redacted configurable-provider catalog.
     */
    remoteProviders(): RemoteLlmProvidersResult;
    /**
     * Commit one idempotent provider settings/credential transaction.
     * @param request - provider mutation and expected revision.
     * @param signal - Caller cancellation before durable claim; claimed commits retain ownership until settled.
     * @returns the committed provider mutation result.
     */
    remoteMutateProvider(request: RemoteLlmProviderMutationRequest, signal?: AbortSignal): Promise<RemoteLlmProviderMutationResult>;
    /**
     * Read the durable, secret-free state of one provider mutation.
     * @param request - Provider id and transaction UUID to inspect.
     * @returns Current durable phase and whether a staged credential is still required.
     */
    remoteProviderTransaction(request: RemoteLlmProviderTransactionRequest): Promise<RemoteLlmProviderTransactionResult>;
    /**
     * Continue one journaled provider mutation after Host or app restart.
     * @param request - Provider id, transaction UUID, and optional write-only credential replay.
     * @param signal - Caller cancellation before resuming a durable commit.
     * @returns Committed provider view or the transaction's durable terminal failure.
     */
    remoteResumeProvider(request: RemoteLlmProviderResumeRequest, signal?: AbortSignal): Promise<RemoteLlmProviderMutationResult>;
    /**
     * Read the failure-isolated host-scoped model catalog.
     * @returns the model catalog grouped by provider.
     */
    remoteModels(): Promise<RemoteLlmModelsResult>;
    /**
     * Interrogate a draft endpoint with an optional write-only one-shot key.
     * @param request - draft endpoint and discovery options.
     * @param signal - caller-owned cancellation signal.
     * @returns discovered models and provider diagnostics.
     */
    remoteDiscoverModels(request: RemoteLlmDiscoverModelsRequest, signal: AbortSignal): Promise<RemoteLlmDiscoveredModelsResult>;
    /**
     * Execute one bounded exact provider/model/auth probe.
     * @param request - Exact provider and model route to verify.
     * @param signal - Caller cancellation combined with the Host verification deadline.
     * @returns Verification mode used by the adapter or fallback request.
     */
    remoteVerifyProvider(request: RemoteLlmProviderVerificationRequest, signal: AbortSignal): Promise<RemoteLlmProviderVerificationResult>;
    /** Present only public LLM operations to the Remote adapter. */
    private remoteRuntime;
    /** Notify topology observers without letting one broken listener veto the commit. */
    private emitAdaptersUpdated;
    /** Contained-listener diagnostic shared by the sync and async failure paths. */
    private warnAdaptersListenerFailure;
    /** Release a fire-and-forget registration without leaking cleanup failures. */
    private disposeRegistration;
    /** Record a registration cleanup failure through the service logger. */
    private warnRegistrationDisposalFailure;
    /**
     * Register an adapter for the given provider routes. Throws `LlmError` with code
     * `DUPLICATE_ADAPTER` if any provider already has an adapter (all-or-nothing).
     * Disposed with the fiber.
     * @param providers - every provider route this adapter should serve.
     * @param adapter - the adapter that streams calls for those providers.
     * @returns the disposer, carrying {@link AdapterRegistrationHandle.replace}.
     */
    registerAdapter(providers: string[], adapter: LlmAdapter): AdapterRegistrationHandle;
    /**
     * Validate one candidate route set for `adapter`, treating routes this
     * registration already holds as available. Nothing is mutated: a rejected
     * candidate leaves the registry exactly as it was.
     */
    private prepareRoutes;
    /**
     * Swap this registration's routes for the prepared ones in one synchronous
     * section, so no observer can see the registry between the release and the
     * re-registration. The route set's one mutation point is also where
     * `llm/adapters-updated` is published, so a `replace` announces itself
     * exactly like a first registration.
     */
    private commitRoutes;
    /**
     * Describe provider routes with a registered adapter.
     * @returns detached provider metadata in registration order.
     */
    listProviders(): LlmProviderInfo[];
    /**
     * Declare provider routes an adapter plugin can activate through
     * configuration. Registration is all-or-nothing: an empty list, invalid
     * entry, or a provider already declared by any registration throws
     * `LlmError` without registering the rest. Disposed with the fiber.
     * @param entries - every configurable provider this plugin owns.
     * @returns a handle that withdraws all of them, and can atomically replace them.
     */
    registerConfigurableProviders(entries: readonly LlmConfigurableProvider[]): DirectoryRegistrationHandle;
    /**
     * List every declared configurable provider, registered or dormant.
     * @returns detached directory entries in declaration order.
     */
    listConfigurableProviders(): LlmConfigurableProvider[];
    /**
     * Offer to interrogate provider endpoints on behalf of the settings
     * namespace this plugin owns. The namespace is the key because that is what
     * a configuration surface already holds from the configurable-provider
     * directory, and because a provider being *added* has no route to name yet.
     * Disposed with the fiber.
     * @param settingsNs - the namespace whose profiles this discovery serves.
     * @param discover - interrogates one endpoint; must honor `request.signal`.
     * @returns the disposer that withdraws the offer.
     */
    registerModelDiscovery(settingsNs: string, discover: (request: LlmModelDiscoveryRequest) => Promise<readonly LlmDiscoveredModel[]>): () => void;
    /**
     * Interrogate one provider endpoint for the models it advertises. The
     * request describes a draft, not a stored route, so nothing here reads or
     * writes settings or credentials — the caller owns both, and the reply is
     * candidate metadata a surface may offer for adoption.
     * @param settingsNs - namespace whose registered discovery serves this draft.
     * @param request - the endpoint, protocol, and one-shot credential to use.
     * @returns the advertised models, deduplicated in endpoint order.
     */
    discoverModels(settingsNs: string, request: LlmModelDiscoveryRequest): Promise<LlmDiscoveredModel[]>;
    /**
     * Resolve the retry policy captured when one provider route was registered.
     * @param provider - registered provider route to inspect.
     * @returns the provider-owned policy, with normal defaults already resolved.
     */
    providerRetryPolicy(provider: string): ResolvedRetryPolicy;
    /**
     * Resolve route-owned request-image pricing without performing I/O. Unknown
     * routes intentionally degrade to heuristic pricing for historical logs.
     * @param provider - provider route whose registered adapter owns pricing.
     * @param model - exact model id whose image occurrences will be priced.
     * @returns route-owned pricing, or `undefined` when the route supplies none.
     */
    imageRequestPricing(provider: string, model: string): LlmImageRequestPricing | undefined;
    /** Detach typed adapter-owned modality metadata. */
    private detachedModalities;
    /**
     * Discover models advertised by one registered provider. Catalog membership
     * is advisory and never changes routing or request validation.
     * @param provider - registered provider route to inspect.
     * @returns detached model metadata in adapter-preferred order.
     */
    listModels(provider: string): Promise<LlmModelInfo[]>;
    /**
     * Resolve and validate all metadata from the adapter that owns one exact
     * route. The result is detached from adapter-owned objects; catalog
     * membership remains advisory and does not control request routing.
     * @param provider - registered provider route to inspect.
     * @param model - exact model id passed to the adapter.
     * @param signal - optional cancellation for adapter-owned asynchronous lookup.
     * @returns exact model identity plus available context and reasoning metadata.
     */
    resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
    /**
     * Prove an exact provider/model route can authenticate and complete a bounded
    * request. The caller supplies the deadline signal; no output is retained or
    * returned to configuration surfaces.
     * @param provider - Registered provider route to authenticate.
     * @param model - Exact model id to probe.
     * @param signal - Caller-owned deadline and cancellation signal.
     * @returns Adapter-native or bounded fallback verification mode.
     */
    verifyModel(provider: string, model: string, signal: AbortSignal): Promise<LlmProviderVerificationMode>;
    /** Adapter-native metadata probe, falling back to one discarded-token handshake. */
    private performProviderVerification;
    private resolveModelInfoFor;
    /** Validate and detach one adapter-returned exact model result. */
    private normalizeModelInfo;
    /**
     * Validate a conversation call config against its exact model capability and
     * materialize adapter-configured defaults. Unsupported explicit efforts
     * reject before provider I/O; no clamping or aliasing is performed. This
     * standalone query does not bind a later dispatch; use {@link prepareCall}
     * when logging and streaming must share one adapter registration.
     * @param config - provider/model route and optional request controls.
     * @param signal - optional cancellation for adapter-owned capability lookup.
     * @returns a detached config only when a default must be materialized.
     */
    resolveCallConfig(config: LlmCallConfig, signal?: AbortSignal): Promise<LlmCallConfig>;
    private resolveCallFor;
    /** Validate request controls against one already-bound exact model result. */
    private resolveCallWithInfo;
    /**
     * Resolve one call under its current adapter registration. The returned
     * one-shot handle keeps that registration across header logging and dispatch,
     * so HMR cannot combine one adapter's capability result with another adapter.
     * @param config - provider/model route and optional request controls.
     * @param signal - optional cancellation for adapter-owned capability lookup.
     * @returns a prepared config and its registration-bound stream entry point.
     */
    prepareCall(config: LlmCallConfig, signal?: AbortSignal): Promise<PreparedLlmCall>;
    private registration;
    /** Remove replay state whose historical route is owned by another adapter. */
    private forAdapter;
    /**
     * Final adapter boundary. Adapter selection, dispatch, iterator construction,
     * and iteration failures become one terminal failure chunk. Middleware and
     * downstream consumer failures remain thrown plugin or consumer errors.
     */
    private adapterStream;
    /**
     * Stream one model call as raw chunks (token-level deltas). Replay state is
     * retained only when the same adapter instance owns its historical provider
     * and the target provider. Final adapter selection remains fixed through
     * asynchronous exact-model resolution and dispatch. Adapter selection,
     * dispatch, and iteration failures become terminal `error` or `aborted`
     * finish chunks; middleware, nested-call, and consumer failures remain
     * thrown. A downstream-close cleanup failure is logged so it cannot mask
     * the consumer's own completion or failure.
     * @param options - the full request; `options.provider` selects the adapter.
     * @returns the chunk stream, possibly wrapped by `llm/stream` listeners.
     */
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
    private streamWithRegistration;
}
export default LlmRuntime;
//# sourceMappingURL=index.d.ts.map