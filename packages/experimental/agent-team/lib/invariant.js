//#region lib/types/invariant.js
/** Invariant registration for the stateless Remote adapter. */
/** Cordis companion plugin name. */
const name = "team-remote-invariant";
/** Invariant registry dependency. */
const inject = ["invariants"];
const install = () => {};
/**
* Register only this adapter's ownership; do not register a second domain validator.
* @param ctx - invariant registry owner.
* @returns registration disposer.
*/
const apply = (ctx) => Promise.resolve(ctx.invariants.register("@deepseek-ai/dsh-experimental-agent-team", install));
//#endregion
export { apply, inject, name };
