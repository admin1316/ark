/** Host registry for model-visible, read-only Cordis capability queries. */
import { Service } from '@deepseek-ai/cordis';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { JsonValue } from '@deepseek-ai/dsh-session/types';
import type { CordisInspectPlatform, CordisInspectProviderManifest, CordisInspectProviderView } from './types.ts';
/** Context supplied to one Host inspect query. */
export interface HostCordisInspectQueryContext {
    signal: AbortSignal;
    agent: Agent;
}
/** Local registration paired with its serializable manifest. */
export interface HostCordisInspectProviderRegistration {
    manifest: CordisInspectProviderManifest;
    query(method: string, input: JsonValue | undefined, context: HostCordisInspectQueryContext): Promise<JsonValue>;
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        /** Host registry for Cordis inspect providers. */
        cordisInspect: CordisInspectRegistryService;
    }
}
/** Registry behind the model-facing inspect tools. */
export declare class CordisInspectRegistryService extends Service {
    private readonly providers;
    /** Register the process-global Host registry. */
    constructor(ctx: Context);
    /**
     * Register one Host provider.
     * @param registration - Provider manifest and query implementation.
     * @returns A disposer that removes the provider when it is no longer owned.
     */
    register(registration: HostCordisInspectProviderRegistration): () => void;
    /**
     * Return the complete Host provider directory.
     * @returns Serializable provider views in registration order.
     */
    list(): CordisInspectProviderView[];
    /**
     * Execute one Host provider query.
     * @param platform - Requested inspect platform; only `host` is supported.
     * @param providerId - Registered provider identity.
     * @param methodName - Provider method to invoke.
     * @param input - JSON input validated against the method schema.
     * @param agent - Session agent making the query.
     * @param signal - Cancellation signal for the query lifecycle.
     * @returns Schema-validated JSON provider output.
     */
    query(platform: CordisInspectPlatform, providerId: string, methodName: string, input: JsonValue | undefined, agent: Agent, signal: AbortSignal): Promise<JsonValue>;
}
//# sourceMappingURL=inspect-registry.d.ts.map