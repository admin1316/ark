/**
 * Check exact metadata and an unauthenticated challenge without generating model output.
 * @param request - captured endpoint, route, headers and cancellation signal.
 * @returns authentication proof, reachability only, or undefined when the owner must verify generation instead.
 */
export declare function verifyExactModel(request: {
    baseURL: string;
    provider: string;
    model: string;
    headers: Record<string, string>;
    publicHeaders: Record<string, string>;
    signal: AbortSignal;
}): Promise<'metadata-auth' | 'endpoint-catalog' | undefined>;
//# sourceMappingURL=verification.d.ts.map