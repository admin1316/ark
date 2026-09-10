//#region lib/types/invariant.js
/** Package-owned invariant companion for the Agent Teams Web profile. */
const PACKAGE_NAME = "@deepseek-ai/dsh-experimental-agent-team-web-profile";
/** Cordis companion plugin name. */
const name = "agent-team-web-profile-invariant";
/** Service required before the companion can register. */
const inject = ["invariants"];
const install = () => {};
/**
* Register this package's invariant companion.
* @param ctx - Cordis context carrying the invariant service.
* @returns the installed registration's disposer after setup succeeds.
*/
const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
//#endregion
export { apply, inject, name };
