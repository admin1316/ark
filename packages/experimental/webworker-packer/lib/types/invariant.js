/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-experimental-webworker-packer`.
 * @module @deepseek-ai/dsh-experimental-webworker-packer/invariant
 */
const PACKAGE_NAME = '@deepseek-ai/dsh-experimental-webworker-packer';
/** Cordis companion plugin name. */
export const name = 'webworker-packer-invariant';
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants'];
/**
 * No runtime invariant: this package is a build-time pass with no
 * production event stream or mutable data; the pack's own gates (unresolvable
 * own requests, the all-or-nothing wrapper contract) fail the pack instead.
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