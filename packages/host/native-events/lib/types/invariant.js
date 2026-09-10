/** Package-owned invariant companion. @module @deepseek-ai/dsh-host-native-events/invariant */
const PACKAGE_NAME = '@deepseek-ai/dsh-host-native-events';
/** Cordis companion plugin name. */
export const name = 'host-native-events-invariant';
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants'];
/** No runtime invariant: registration and response correlation already fail at their commit boundaries. */
const install = () => { };
/** Register this package's invariant companion. */
export const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
/* jscpd:ignore-end */
//# sourceMappingURL=invariant.js.map