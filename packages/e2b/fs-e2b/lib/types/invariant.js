/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-fs-e2b`.
 * @module @deepseek-ai/dsh-fs-e2b/invariant
 */
const PACKAGE_NAME = '@deepseek-ai/dsh-fs-e2b';
/** Cordis companion plugin name. */
export const name = 'fs-e2b-invariant';
/** Service required before reserving package ownership. */
export const inject = ['invariants'];
/**
 * No runtime invariant: each operation returns the E2B controller's committed
 * result directly, with no independent event or cache to cross-check.
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