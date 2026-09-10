/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-sdk-jsonrpc-demo`.
 * @module @deepseek-ai/dsh-sdk-jsonrpc-demo/invariant
 */
const PACKAGE_NAME = '@deepseek-ai/dsh-sdk-jsonrpc-demo';
/** Cordis companion plugin name. */
export const name = 'sdk-jsonrpc-demo-invariant';
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants'];
/**
 * No runtime invariant: this composition package owns no independent event stream or mutable data;
 * Loader and built-entry tests cover its wiring.
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