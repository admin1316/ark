/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-llm-replay`.
 * @module @deepseek-ai/dsh-llm-replay/invariant
 */
const PACKAGE_NAME = '@deepseek-ai/dsh-llm-replay';
/** Cordis companion plugin name. */
export const name = 'llm-replay-invariant';
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants'];
/**
 * No runtime invariant: this test-only adapter consumes a fixed replay script; its stream grammar
 * is checked by the LLM companion and fixture derivation tests.
 */
const install = () => { };
/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
/* jscpd:ignore-end */
//# sourceMappingURL=invariant.js.map