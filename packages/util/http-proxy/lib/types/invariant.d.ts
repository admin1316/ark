/** Package-owned startup check of the active proxy policy's child environment. */
import type { Context } from '@deepseek-ai/cordis';
/** Cordis companion plugin name. */
export declare const name = "http-proxy-invariant";
/** Registry required to reserve package ownership. */
export declare const inject: string[];
/**
 * Register the package's check of its current child-environment result.
 * @param ctx - context carrying the invariant registry.
 * @returns the installed registration's disposer after validation succeeds.
 */
export declare const apply: (ctx: Context) => Promise<() => void>;
//# sourceMappingURL=invariant.d.ts.map