/** Child LLM route selection for the subagent tool. */
import type { LlmRuntime } from '@deepseek-ai/dsh-llm';
import type { AgentOptions } from '@deepseek-ai/dsh-agent';
import z from '@deepseek-ai/schemastery';
/** One exact child LLM route authorized by a user setting. */
export interface AllowedModelRoute {
    readonly provider: string;
    readonly model: string;
}
/** Schema shared by the Host setting and its deployment base. */
export declare const AllowedModelRouteSchema: z<AllowedModelRoute>;
/** Route-selection authority captured by one delegation definition. */
export interface ModelSelectionPolicy {
    readonly routes: readonly AllowedModelRoute[];
}
/**
 * Stable identity for one provider/model pair.
 * @param route - The route input.
 * @returns The value produced by model route key.
 */
export declare function modelRouteKey(route: AllowedModelRoute): string;
/**
 * Reject malformed or duplicate route policy entries at a boundary.
 * @param routes - The routes input.
 * @returns The value produced by assert allowed model routes.
 */
export declare function assertAllowedModelRoutes(routes: unknown): asserts routes is readonly AllowedModelRoute[];
/** Model-facing child LLM route fields. */
export interface DelegationModelRequest {
    readonly provider?: string;
    readonly model?: string;
    readonly reasoning_effort?: string;
    readonly max_tokens?: number;
}
/**
 * Whether a call explicitly selects any child LLM value.
 * @param request - The request input.
 * @returns The value produced by has delegation model request.
 */
export declare function hasDelegationModelRequest(request: DelegationModelRequest): boolean;
/**
 * Merge model-supplied route fields over configured child defaults.
 * @param parentOptions - The parent options input.
 * @param configured - The configured input.
 * @param request - The request input.
 * @param enabled - The enabled input.
 * @returns The value produced by requested agent options.
 */
export declare function requestedAgentOptions(parentOptions: AgentOptions, configured: AgentOptions | undefined, request: DelegationModelRequest, enabled: boolean): AgentOptions | undefined;
/**
 * Enforce the session-captured route allowlist for explicit choices.
 * @param policy - The policy input.
 * @param parentOptions - The parent options input.
 * @param requested - The requested input.
 * @param request - The request input.
 */
export declare function assertAllowedModelSelection(policy: ModelSelectionPolicy | undefined, parentOptions: AgentOptions, requested: AgentOptions | undefined, request: DelegationModelRequest): void;
/**
 * Whether configured route fields need exact LLM validation before start.
 * @param options - The options input.
 * @returns The value produced by has configured llm selection.
 */
export declare function hasConfiguredLlmSelection(options: AgentOptions | undefined): boolean;
/**
 * Resolve and validate one exact child route through the live LLM adapter.
 * @param llm - The llm input.
 * @param parentOptions - The parent options input.
 * @param requested - The requested input.
 * @param signal - The signal input.
 * @param inheritParentReasoningEffort - The inherit parent reasoning effort input.
 */
export declare function preflightChildLlmRoute(llm: LlmRuntime, parentOptions: AgentOptions, requested: AgentOptions | undefined, signal: AbortSignal, inheritParentReasoningEffort?: boolean): Promise<void>;
//# sourceMappingURL=model-selection.d.ts.map