/** Package-owned companion for the caller-owned Session migration machinery. */
import type { Context } from '@deepseek-ai/cordis';
/** Cordis companion plugin name. */
export declare const name = "session-format-invariant";
/** Registry required to reserve package ownership. */
export declare const inject: string[];
/**
 * Register this package's companion without activating a migration.
 * @param ctx - context carrying the invariant registry.
 * @returns the installed registration's disposer.
 */
export declare const apply: (ctx: Context) => Promise<() => void>;
//# sourceMappingURL=invariant.d.ts.map