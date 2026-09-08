/** Native Typert Remote projections owned by the LLM configuration domain. */
import type { Context } from '@deepseek-ai/cordis';
import type { LlmConfigurableProvider, LlmDiscoveredModel, LlmModelInfo, LlmProviderInfo, LlmProviderVerificationMode, LlmResolvedModelInfo, RemoteLlmDiscoverModelsRequest, RemoteLlmDiscoveredModelsResult, RemoteLlmModelView, RemoteLlmModelsResult, RemoteLlmProviderMutationRequest, RemoteLlmProviderMutationResult, RemoteLlmProviderResumeRequest, RemoteLlmProviderTransactionRequest, RemoteLlmProviderTransactionResult, RemoteLlmProviderVerificationRequest, RemoteLlmProviderVerificationResult, RemoteLlmProvidersResult } from './types.ts';
/** Minimal LLM surface required by the Remote adapter. */
export interface LlmRemoteRuntime {
    listProviders(): LlmProviderInfo[];
    listConfigurableProviders(): LlmConfigurableProvider[];
    listModels(provider: string): Promise<LlmModelInfo[]>;
    resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
    discoverModels(settingsNs: string, request: {
        provider?: string;
        baseURL?: string;
        api?: string;
        apiKey?: string;
        signal?: AbortSignal;
    }): Promise<LlmDiscoveredModel[]>;
    verifyModel(provider: string, model: string, signal: AbortSignal): Promise<LlmProviderVerificationMode>;
}
/**
 * Whether an HTTP header value must live behind a credential reference.
 * @param name - Header name to classify case-insensitively.
 * @returns True for credential-, token-, cookie-, or password-bearing names.
 */
export declare function isCredentialHeaderName(name: string): boolean;
/**
 * Project the configured and live provider directories without giving writes a second owner.
 * @param runtime - The runtime input.
 * @returns The value produced by list remote providers.
 */
export declare function listRemoteProviders(runtime: LlmRemoteRuntime): RemoteLlmProvidersResult;
/**
 * Build a failure-isolated host-scoped model catalog.
 * @param runtime - The runtime input.
 * @returns The value produced by list remote models.
 */
export declare function listRemoteModels(runtime: LlmRemoteRuntime): Promise<RemoteLlmModelsResult>;
/**
 * Discover a draft provider's models without storing or returning its one-shot secret.
 * @param runtime - The runtime input.
 * @param request - The request input.
 * @param signal - The signal input.
 * @returns The value produced by discover remote models.
 */
export declare function discoverRemoteModels(runtime: LlmRemoteRuntime, request: RemoteLlmDiscoverModelsRequest, signal: AbortSignal): Promise<RemoteLlmDiscoveredModelsResult>;
/**
 * Read one provider transaction without returning its operations or secrets.
 * @param runtime - Live provider registry used only for terminal live-state projection.
 * @param ctx - Host context containing the secure credential journal provider.
 * @param request - Provider id and transaction UUID to inspect.
 * @returns Durable phase, credential requirement, and optional live state.
 */
export declare function providerTransactionStatus(runtime: LlmRemoteRuntime, ctx: Context, request: RemoteLlmProviderTransactionRequest): Promise<RemoteLlmProviderTransactionResult>;
/**
 * Resume a durable provider transaction without asking the caller to rebuild its settings operations.
 * @param runtime - Provider and model registry receiving the resumed commit.
 * @param ctx - Host context containing settings and secure credential services.
 * @param request - Provider id, transaction UUID, and optional credential replay.
 * @param signal - Cancellation before a durable claim; claimed work keeps ownership until settled.
 * @returns Committed provider mutation view or the journal's terminal failure.
 */
export declare function resumeRemoteProvider(runtime: LlmRemoteRuntime, ctx: Context, request: RemoteLlmProviderResumeRequest, signal?: AbortSignal): Promise<RemoteLlmProviderMutationResult>;
/**
 * Run one bounded exact-route request without exposing provider output.
 * @param runtime - Provider registry that performs the exact model verification.
 * @param request - Provider/model route to probe.
 * @param signal - Caller cancellation combined with the fixed verification deadline.
 * @returns Verification mode and accepted state; model output is discarded.
 */
export declare function verifyRemoteProvider(runtime: LlmRemoteRuntime, request: RemoteLlmProviderVerificationRequest, signal: AbortSignal): Promise<RemoteLlmProviderVerificationResult>;
/**
 * Commit a provider configuration change with a secret-free durable retry receipt.
 * @param runtime - Provider registry used for ownership and activation checks.
 * @param ctx - Host settings and credential service owners.
 * @param request - Provider mutation with its expected settings revision and transaction id.
 * @param signal - Cancellation before durable claim; late cancellation does not interrupt commit.
 * @returns The committed redacted view, or a typed conflict, cancellation or recovery failure.
 */
export declare function mutateRemoteProvider(runtime: LlmRemoteRuntime, ctx: Context, request: RemoteLlmProviderMutationRequest, signal?: AbortSignal): Promise<RemoteLlmProviderMutationResult>;
/**
 * Canonical provider/model projection shared by every catalog caller.
 * @param model - Declared model identity and display metadata.
 * @param resolved - Adapter-resolved limits and reasoning capabilities.
 * @returns Client-safe model view with normalized string reasoning ids.
 */
export declare function projectRemoteModel(model: LlmModelInfo, resolved: LlmResolvedModelInfo): RemoteLlmModelView;
//# sourceMappingURL=remote.d.ts.map