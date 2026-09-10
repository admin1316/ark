/** Package-owned invariant companion for the experimental Inspector. */
const PACKAGE_NAME = '@deepseek-ai/dsh-experimental-inspector';
/** Cordis companion plugin name. */
export const name = 'experimental-inspector-invariant';
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants'];
/**
 * No runtime invariant: wire parsing, generations, Worker lifecycle, and CDP
 * sessions reject invalid relationships in their owning operations.
 */
const install = () => { };
/** Register this package's invariant companion. */
export const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
//# sourceMappingURL=invariant.js.map