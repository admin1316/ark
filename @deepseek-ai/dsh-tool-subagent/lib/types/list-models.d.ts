/** Model-facing discovery of LLM routes available to child Agents. */
import type { Context } from '@deepseek-ai/cordis';
import type { ModelSelectionPolicy } from './model-selection.ts';
/**
 * Register discovery for one session-captured route policy.
 * @param ctx - The ctx input.
 * @param policy - The policy input.
 */
export declare function registerListSubagentModels(ctx: Context, policy: ModelSelectionPolicy): void;
//# sourceMappingURL=list-models.d.ts.map