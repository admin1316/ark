/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-tool-session-query`.
 * @module @deepseek-ai/dsh-tool-session-query/invariant
 */
const PACKAGE_NAME = '@deepseek-ai/dsh-tool-session-query';
/** Cordis companion plugin name. */
export const name = 'tool-session-query-invariant';
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants'];
/**
 * No runtime invariant: this read-only model adapter owns no event or mutable
 * data relationship beyond the registries that already validate registration.
 */
const install = () => { };
/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
/* jscpd:ignore-end */
//# sourceMappingURL=invariant.js.map