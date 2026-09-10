/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-knowledge-wiki`.
 * @module @deepseek-ai/dsh-knowledge-wiki/invariant
 */
const PACKAGE_NAME = '@deepseek-ai/dsh-knowledge-wiki';
/** Cordis companion plugin name. */
export const name = 'knowledge-wiki-invariant';
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants'];
/**
 * No runtime invariant: the package owns no session event stream. Its
 * durable state (ingest queue, ingest cache, review items) is written at
 * single owned sites whose shapes are asserted by the package's unit tests,
 * and the namespace registration is released by the effect disposer that
 * created it.
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