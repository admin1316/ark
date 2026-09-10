/** Invariant ownership for the model-facing Team tool adapter. */
import type { Context } from '@deepseek-ai/cordis';
export declare const name = "tool-team-invariant";
export declare const inject: string[];
/**
 * Register this package's invariant ownership.
 * @param ctx - invariant registry owner.
 * @returns registration disposer after installation.
 */
export declare const apply: (ctx: Context) => Promise<() => void>;
//# sourceMappingURL=invariant.d.ts.map