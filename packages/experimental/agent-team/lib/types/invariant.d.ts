/** Invariant registration for the stateless Remote adapter. */
import type { Context } from '@deepseek-ai/cordis';
/** Cordis companion plugin name. */
export declare const name = "team-remote-invariant";
/** Invariant registry dependency. */
export declare const inject: string[];
/**
 * Register only this adapter's ownership; do not register a second domain validator.
 * @param ctx - invariant registry owner.
 * @returns registration disposer.
 */
export declare const apply: (ctx: Context) => Promise<() => void>;
//# sourceMappingURL=invariant.d.ts.map