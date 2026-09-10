//#region lib/types/invariant.js
const PACKAGE_NAME = "@deepseek-ai/dsh-tool-agent-team";
const name = "tool-team-invariant";
const inject = ["invariants"];
/** No runtime invariant: the Team service owns durable and authorization relations. */
const install = () => {};
/**
* Register this package's invariant ownership.
* @param ctx - invariant registry owner.
* @returns registration disposer after installation.
*/
const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
//#endregion
export { apply, inject, name };
