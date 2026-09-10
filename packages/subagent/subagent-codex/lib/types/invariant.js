/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-subagent-codex`.
 * @module @deepseek-ai/dsh-subagent-codex/invariant
 */
const PACKAGE_NAME = '@deepseek-ai/dsh-subagent-codex';
/** Cordis companion plugin name. */
export const name = 'subagent-codex-invariant';
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants'];
/**
 * No runtime invariant: lifecycle pairing belongs to the shared subagent
 * service and process-tree ownership belongs to the subprocess service.
 */
const install = () => { };
/**
 * Register this package's invariant companion.
 * @param ctx - plugin context carrying the invariant registry.
 * @returns the installed registration's disposer.
 */
export const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
/* jscpd:ignore-end */
//# sourceMappingURL=invariant.js.map