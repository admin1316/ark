/**
 * Host-only strict Typert Remote dispatch for Native clients.
 * @module @deepseek-ai/dsh-api-gateway
 */
import { Context, Service } from '@deepseek-ai/cordis';
import { type RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import type { TypertGateway, TypertGatewayErrorCode } from './types.ts';
export type { TypertGateway, TypertGatewayErrorCode } from './types.ts';
export { NATIVE_LEGACY_API_ENDPOINTS, NATIVE_TYPERT_REMOTE_ENDPOINTS, NATIVE_TYPERT_REMOTE_OWNERS, } from './native-remote-routes.ts';
export type { NativeTypertRemoteEndpoint } from './native-remote-routes.ts';
interface GatewayErrorOptions {
    readonly cause?: unknown;
    readonly details?: object;
    readonly field?: string;
}
/** Strict dispatch failure converted to a Native Remote result. */
export declare class TypertGatewayError extends Error {
    /** Machine-readable failure category. */
    readonly code: TypertGatewayErrorCode;
    /** Canonical `<namespace>/<method>` endpoint. */
    readonly endpoint: string;
    /** Structured public failure context. */
    readonly details: object;
    /** Affected wire field when the failure is field-specific. */
    readonly field: string | undefined;
    /**
     * Construct one failure without embedding rejected boundary values.
     * @param code - stable failure category.
     * @param endpoint - canonical Remote endpoint.
     * @param message - correction-oriented diagnostic.
     * @param options - optional public details, field, and contained cause.
     */
    constructor(code: TypertGatewayErrorCode, endpoint: string, message: string, options?: GatewayErrorOptions);
}
/**
 * Build a strict dispatcher bound to one Cordis caller scope.
 * @param ctx - scope used to resolve Typert, receiver Services, and Context providers.
 * @returns dispatcher that re-reads live registry state for every call.
 */
export declare function createTypertGatewayDispatcher(ctx: Context): TypertGateway;
/**
 * Sole slash Remote owner on Connection's shared `/api` channel.
 * @typert service typertGateway
 */
export declare class TypertGatewayService extends Service implements TypertGateway {
    static inject: string[];
    private readonly dispatcher;
    /**
     * Register dynamic strict dispatch when Host Connection becomes available.
     * @param ctx - owning Host Context.
     */
    constructor(ctx: Context);
    /**
     * Report whether this gateway owns an endpoint.
     * @param endpoint - slash-delimited Remote endpoint to inspect.
     * @returns `true` when the gateway owns the endpoint.
     */
    claims(endpoint: string): boolean;
    /**
     * Invoke one claimed endpoint through the gateway dispatcher.
     * @param endpoint - slash-delimited Remote endpoint to invoke.
     * @param payload - caller payload forwarded to the endpoint.
     * @param signal - caller-owned cancellation signal.
     * @returns the dispatched Remote result.
     */
    invoke(endpoint: string, payload: unknown, signal: AbortSignal): Promise<RemoteResult<unknown>>;
    private dispatch;
}
export default TypertGatewayService;
//# sourceMappingURL=index.d.ts.map