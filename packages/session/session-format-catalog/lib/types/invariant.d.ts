/** Package-owned companion for the static offline Session codec catalog. */
import type { Context } from '@deepseek-ai/cordis';
/** Cordis companion plugin name. */
export declare const name = "session-format-catalog-invariant";
/** Registry required to reserve package ownership. */
export declare const inject: string[];
/**
 * Register this package's companion without restoring an artifact.
 * @param ctx - context carrying the invariant registry.
 * @returns the installed registration's disposer.
 */
export declare const apply: (ctx: Context) => Promise<() => void>;
//# sourceMappingURL=invariant.d.ts.map