/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-lsp`.
 * @module @deepseek-ai/dsh-lsp/invariant
 */
const PACKAGE_NAME = '@deepseek-ai/dsh-lsp';
/** Cordis companion plugin name. */
export const name = 'lsp-invariant';
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants'];
/**
 * No runtime invariant: provider ids and extension routes are private, atomically updated state;
 * the seam exposes neither an enumerable snapshot nor lifecycle events to compare independently.
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