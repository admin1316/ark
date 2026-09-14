/** Package-owned companion for the static offline Session codec catalog. */
const PACKAGE_NAME = '@deepseek-ai/dsh-session-format-catalog';
/** Cordis companion plugin name. */
export const name = 'session-format-catalog-invariant';
/** Registry required to reserve package ownership. */
export const inject = ['invariants'];
/**
 * No runtime invariant: this static offline codec assembly owns neither live
 * Sessions nor a mutable plugin registry. Codec-chain validation and the distinct
 * installed-format admission check execute at their existing construction/read boundaries.
 */
const install = () => { };
/**
 * Register this package's companion without restoring an artifact.
 * @param ctx - context carrying the invariant registry.
 * @returns the installed registration's disposer.
 */
export const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
/* jscpd:ignore-end */
//# sourceMappingURL=invariant.js.map