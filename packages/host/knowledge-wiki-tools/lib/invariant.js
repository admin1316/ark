//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `@deepseek-ai/dsh-tool-knowledge-wiki`.
* @module @deepseek-ai/dsh-tool-knowledge-wiki/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-tool-knowledge-wiki";
/** Cordis companion plugin name. */
const name = "tool-knowledge-wiki-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: every tool call is stateless over the lazily
* resolved knowledgeWiki service, and the tool registrations are released
* by the same effect disposers that created them, so no second authority
* exists to check at runtime.
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
