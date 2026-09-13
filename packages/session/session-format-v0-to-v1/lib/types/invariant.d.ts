/** Package-owned companion for the frozen released-v0 codec and v1 migration. */
import type { Context } from '@deepseek-ai/cordis';
/** Cordis companion plugin name. */
export declare const name = "session-format-v0-to-v1-invariant";
/** Registry required to reserve package ownership. */
export declare const inject: string[];
/**
 * Register this package's companion without decoding historical data.
 * @param ctx - context carrying the invariant registry.
 * @returns the installed registration's disposer.
 */
export declare const apply: (ctx: Context) => Promise<() => void>;
//# sourceMappingURL=invariant.d.ts.map