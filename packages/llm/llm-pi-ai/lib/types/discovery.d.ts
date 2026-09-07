/**
 * Answering "which models can this provider serve?" for the configuration
 * surface's "fetch available models" action.
 *
 * A route the installed pi-ai catalog ships is answered from that catalog only
 * while the draft keeps its installed endpoint. Supplying a `baseURL` means the
 * user is editing an actual gateway endpoint, so that endpoint is always
 * interrogated instead of returning unrelated built-in models.
 *
 * Neither path is a catalog refresh. Nothing here is stored: the request
 * carries a draft the user is still editing, and the reply is candidate
 * metadata the surface offers for adoption. `settings.yaml` remains the only
 * thing that decides what a route serves.
 *
 * Only OpenAI-compatible protocols are interrogated. Their listing is the one
 * shape a gateway, a self-hosted server, and the official endpoints all agree
 * on, which is the case this action exists for; every other protocol reports
 * that it cannot be interrogated so the surface falls back to hand-entry
 * rather than guessing a response shape.
 *
 * @module dsh-llm-pi-ai/discovery
 */
import type { LlmDiscoveredModel, LlmModelDiscoveryRequest } from '@deepseek-ai/dsh-llm';
type ScopedDiscoveryRequest = LlmModelDiscoveryRequest & {
    credentialEndpointFingerprint?: string;
};
/**
 * Interrogate one draft provider endpoint for the models it advertises.
 * @param request - the endpoint, protocol, and one-shot credential to use.
 * @returns the advertised models in endpoint order.
 * @throws LlmError when the protocol has no readable listing, the endpoint
 *   refuses or fails the request, or the reply is not a model listing.
 */
export declare function discoverModels(request: ScopedDiscoveryRequest): Promise<readonly LlmDiscoveredModel[]>;
export {};
//# sourceMappingURL=discovery.d.ts.map