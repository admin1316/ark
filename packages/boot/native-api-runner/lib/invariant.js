//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `@deepseek-ai/dsh-native-api-runner`.
* @module @deepseek-ai/dsh-native-api-runner/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-native-api-runner";
/** Cordis companion plugin name. */
const name = "native-api-runner-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/** No runtime invariant: the executable owns process composition before session events exist. */
const install = () => {};
/**
* Register this package's invariant companion.
* @param ctx - Cordis context carrying the invariant service.
* @returns the installed registration's disposer after setup succeeds.
*/
const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
//#endregion
export { apply, inject, name };
