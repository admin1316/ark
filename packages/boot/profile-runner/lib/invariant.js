//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `@deepseek-ai/dsh-profile-runner`.
* @module @deepseek-ai/dsh-profile-runner/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-profile-runner";
/** Cordis companion plugin name. */
const name = "profile-runner-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/** No runtime invariant: launch composition and shutdown settle before session events exist. */
const install = () => {};
/**
* Register this package's invariant companion.
* @param ctx - Cordis context carrying the invariant service.
* @returns the installed registration's disposer after setup succeeds.
*/
const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
//#endregion
export { apply, inject, name };
