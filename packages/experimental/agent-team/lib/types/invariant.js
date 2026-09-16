/** Invariant registration for the stateless Remote adapter. */
/** Cordis companion plugin name. */
export const name = 'team-remote-invariant';
/** Invariant registry dependency. */
export const inject = ['invariants'];
// No runtime invariant: this stateless adapter delegates to the domain and owns no mutable Team state.
const install = () => { };
/**
 * Register only this adapter's ownership; do not register a second domain validator.
 * @param ctx - invariant registry owner.
 * @returns registration disposer.
 */
export const apply = (ctx) => Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-experimental-agent-team', install));
//# sourceMappingURL=invariant.js.map