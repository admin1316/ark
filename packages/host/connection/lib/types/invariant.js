/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-host-connection`.
 * @module @deepseek-ai/dsh-host-connection/invariant
 */
const PACKAGE_NAME = '@deepseek-ai/dsh-host-connection';
/** Cordis companion plugin name. */
export const name = 'host-connection-invariant';
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants'];
/** No runtime invariant: route and socket ownership is asserted by real composition tests. */
const install = () => { };
/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
/* jscpd:ignore-end */
//# sourceMappingURL=invariant.js.map