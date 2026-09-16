/** Package-owned companion for released-v2 canonical-envelope and PTC migration. */
import type { Context } from '@deepseek-ai/cordis';
/** Cordis companion plugin name. */
export declare const name = "session-format-v2-to-v3-invariant";
/** Registry required to reserve package ownership. */
export declare const inject: string[];
/**
 * Register this package's companion without replaying migration input.
 * @param ctx - context carrying the invariant registry.
 * @returns the installed registration's disposer.
 */
export declare const apply: (ctx: Context) => Promise<() => void>;
//# sourceMappingURL=invariant.d.ts.map