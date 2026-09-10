/** Model steering for post-activation Host guard failures. */
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { CordisErrorDetails } from './types.ts';
import type { DynamicCordisPlugin, DynamicCordisRun } from './registry.ts';
/** Agent lookup surface supplied by the root runtime. */
export type AgentsService = {
    get(id: string): Agent | undefined;
} | undefined;
/**
 * Render one failure's message and optional stack.
 * @param failure - The failure input.
 * @returns The value produced by format error details.
 */
export declare function formatErrorDetails(failure: CordisErrorDetails): string;
/**
 * Steer the owner after a Host guard rejects runtime code.
 * @param agents - The agents input.
 * @param plugin - The plugin input.
 * @param run - The run input.
 * @param failure - The failure input.
 */
export declare function steerGuardFailure(agents: AgentsService, plugin: DynamicCordisPlugin, run: DynamicCordisRun, failure: CordisErrorDetails): void;
//# sourceMappingURL=steering.d.ts.map