//#region lib/types/invariant.js
/** Package-owned invariant companion. @module @deepseek-ai/dsh-host-workbench/invariant */
const PACKAGE_NAME = "@deepseek-ai/dsh-host-workbench";
/** Cordis companion plugin name. */
const name = "host-workbench-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/** No runtime invariant: read-only calls delegate to the existing owner and keep no package state. */
const install = () => {};
/** Register this package's invariant companion. */
const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
//#endregion
export { apply, inject, name };
