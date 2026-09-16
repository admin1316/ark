/** Package-owned companion for JSON and immutable-value utilities. */
import type { Context } from '@deepseek-ai/cordis';
/** Cordis companion plugin name. */
export declare const name = "util-values-invariant";
/** Registry required to reserve package ownership. */
export declare const inject: string[];
/**
 * Register this package's companion without inspecting caller values.
 * @param ctx - context carrying the invariant registry.
 * @returns the installed registration's disposer.
 */
export declare const apply: (ctx: Context) => Promise<() => void>;
//# sourceMappingURL=invariant.d.ts.map