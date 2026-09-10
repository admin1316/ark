/** Package-owned invariant companion for the Agent Teams Web profile. */
const PACKAGE_NAME = '@deepseek-ai/dsh-experimental-agent-team-web-profile';
/** Cordis companion plugin name. */
export const name = 'agent-team-web-profile-invariant';
/** Service required before the companion can register. */
export const inject = ['invariants'];
// No runtime invariant: the package carries only a static profile patch. The
// Remote assembly and Team UI own their activation requirements.
const install = () => { };
/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
//# sourceMappingURL=invariant.js.map