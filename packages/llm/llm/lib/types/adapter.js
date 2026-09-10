/**
 * The adapter contract surface: what a provider adapter implements, what a
 * registration returns, and the prepared-call snapshot. Provider packages
 * (pi-ai, deepseek) depend on this module; the runtime imports it too.
 *
 * @module @deepseek-ai/dsh-llm/adapter
 */
import { resolveImageAttachmentAccess, } from "./content.js";
/**
 * Build one live image-access resolver from the provider composition's service lookups.
 * Keeping this in the adapter contract layer gives every provider the same attachment/path
 * behavior without making the provider-neutral LLM package own a filesystem service.
 * @param resolveAttachments - resolves the currently mounted attachment store.
 * @param mapHostPath - maps a host path through the currently mounted filesystem service.
 * @returns a resolver that observes both services at call time.
 */
export function createImageAttachmentAccessResolver(resolveAttachments, mapHostPath) {
    return (ref) => {
        const attachments = resolveAttachments();
        return attachments === undefined
            ? undefined
            : resolveImageAttachmentAccess(attachments, mapHostPath, ref);
    };
}
/**
 * Provider-wire adapter for the harness message and stream vocabulary. Register implementations
 * with `ctx.llm.registerAdapter(providers, adapter)`. Every provider HTTP request must include
 * `attributionHeaders()`; prove the headers are added in the wire request or library header hook. The direct-fetch
 * DeepSeek and library-backed pi-ai adapters meet this contract through different internals.
 */
export class LlmAdapter {
    /**
     * Describe one provider route owned by this adapter.
     * @param provider - a route passed to `registerAdapter()` for this instance.
     * @returns detached display metadata whose id must equal `provider`.
     */
    providerInfo(provider) {
        return { id: provider, name: provider };
    }
    /**
     * Return the provider-owned retry policy captured with this route.
     * @param _provider - a route passed to `registerAdapter()` for this instance.
     * @returns a resolved policy, or `undefined` to use the normal defaults.
     */
    providerRetryPolicy(_provider) {
        return undefined;
    }
    /**
     * Resolve synchronous provider-side request-image pricing for one exact
     * route. Adapters without visual-token billing return undefined.
     * @param _provider - one provider route owned by this adapter.
     * @param _model - exact model id whose image input will be priced.
     * @returns synchronous image-pricing metadata, or `undefined` when unsupported.
     */
    imageRequestPricing(_provider, _model) {
        return undefined;
    }
    /**
     * List models this adapter can currently advertise for one owned provider.
     * The result is advisory: an adapter may accept unlisted model ids, and
     * consumers must not turn absence into request rejection.
     * @param _provider - one provider route owned by this adapter.
     * @returns discoverable models in adapter-preferred order.
     */
    listModels(_provider) {
        return Promise.resolve([]);
    }
    /**
     * Resolve all metadata available for one exact model. This query is
     * independent of the advisory catalog and does not validate request routing.
     * @param provider - one provider route owned by this adapter.
     * @param model - exact model id passed to {@link GenerateOptions.model}.
     * @param _signal - cancellation for this exact-model lookup; asynchronous
     *   implementations must settle promptly after it aborts.
     * @returns provider/model identity plus any context, call-default, and reasoning metadata.
     */
    resolveModel(provider, model, _signal) {
        return Promise.resolve({ provider, id: model, name: model });
    }
    /**
     * Perform a protocol-native, non-generative authentication/metadata probe
     * when the adapter supports one. Returning `undefined` asks LlmRuntime to use
     * its explicitly classified minimal-generation fallback.
     * @param _provider - exact registered provider route.
     * @param _model - exact configured model id.
     * @param _signal - owner cancellation signal.
     * @returns the non-generative mode, or undefined for the bounded fallback.
     */
    verifyProvider(_provider, _model, _signal) {
        return Promise.resolve(undefined);
    }
    /**
     * Bind exact model metadata and the eventual request dispatch to one adapter generation.
     * Dynamic adapters override this so settings changes between preparation and
     * dispatch cannot combine one generation's capabilities with another's endpoint.
     * @param provider - registered provider route.
     * @param model - exact model id.
     * @param signal - cancellation for model resolution.
     * @returns model metadata and a one-generation stream entry point.
     */
    async prepareCall(provider, model, signal) {
        return {
            model: await this.resolveModel(provider, model, signal),
            stream: options => this.stream(options),
        };
    }
}
/**
 * The abstract `llm` service: an adapter registry plus a streaming model-call
 * API, interceptable via the `llm/stream` waterfall.
 */
//# sourceMappingURL=adapter.js.map