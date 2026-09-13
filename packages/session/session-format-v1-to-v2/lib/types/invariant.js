/** Package-owned companion for released-v1 assistant-stream migration. */
const PACKAGE_NAME = '@deepseek-ai/dsh-session-format-v1-to-v2';
/** Cordis companion plugin name. */
export const name = 'session-format-v1-to-v2-invariant';
/** Registry required to reserve package ownership. */
export const inject = ['invariants'];
/**
 * No runtime invariant: assistant assembly state belongs to one historical
 * migration stream and is checked while transforming or restoring that stream.
 * The codec owns no running Agent, provider dispatch, or committed Session log.
 */
const install = () => { };
/**
 * Register this package's companion without replaying assistant content.
 * @param ctx - context carrying the invariant registry.
 * @returns the installed registration's disposer.
 */
export const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
/* jscpd:ignore-end */
//# sourceMappingURL=invariant.js.map