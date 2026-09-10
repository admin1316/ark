/**
 * Shared process lifecycle for the generic and closed-runtime JSON-RPC bins.
 *
 * @module @deepseek-ai/dsh-sdk-jsonrpc-demo/runner
 */
/**
 * Boot the explicitly selected external configuration and own process exit.
 * @param bareModuleBaseUrl - optional installed-runtime base for bare plugins;
 * omit it when the configuration project owns its plugin packages.
 * @returns after process handlers are installed; process lifetime then belongs
 * to stdin and signal events.
 */
export declare function runJsonrpcAgent(bareModuleBaseUrl?: string): Promise<void>;
//# sourceMappingURL=runner.d.ts.map