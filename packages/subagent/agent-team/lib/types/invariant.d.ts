/** Relational checks over Team records and their committed Lead-log prefix. */
import type { Context } from '@deepseek-ai/cordis';
export declare const name = "team-invariant";
export declare const inject: string[];
/**
 * Register Team event invariants.
 * @param ctx - invariant registry owner.
 * @returns registration disposer after installation.
 */
export declare const apply: (ctx: Context) => Promise<() => void>;
//# sourceMappingURL=invariant.d.ts.map