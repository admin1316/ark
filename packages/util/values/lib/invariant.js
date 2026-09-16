//#region lib/types/invariant.js
/** Package-owned companion for JSON and immutable-value utilities. */
const PACKAGE_NAME = "@deepseek-ai/dsh-util-values";
/** Cordis companion plugin name. */
const name = "util-values-invariant";
/** Registry required to reserve package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: JSON walks, comparisons, and freezes retain no shared
* state or event history. Their values and traversal state belong to each caller;
* calling them on invented constants would test examples rather than runtime ownership.
*/
const install = () => {};
/**
* Register this package's companion without inspecting caller values.
* @param ctx - context carrying the invariant registry.
* @returns the installed registration's disposer.
*/
const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
//#endregion
export { apply, inject, name };
