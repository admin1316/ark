//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `@deepseek-ai/dsh-experimental-webworker-runtime`.
* @module @deepseek-ai/dsh-experimental-webworker-runtime/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-experimental-webworker-runtime";
/** Cordis companion plugin name. */
const name = "webworker-runtime-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: this package is pre-Cordis platform glue —
* the tree it boots runs the product packages' own invariants, and the
* assembly's contracts (image contract gate, tunnel refusals) fail loud at
* boot rather than drifting at run time.
*/
const install = () => {};
/**
* Register this package's invariant companion.
* @param ctx - Cordis context carrying the invariant service.
* @returns the installed registration's disposer after setup succeeds.
*/
const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
//#endregion
export { apply, inject, name };
