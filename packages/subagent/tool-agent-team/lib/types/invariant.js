const PACKAGE_NAME = '@deepseek-ai/dsh-tool-agent-team';
export const name = 'tool-team-invariant';
export const inject = ['invariants'];
/** No runtime invariant: the Team service owns durable and authorization relations. */
const install = () => { };
/**
 * Register this package's invariant ownership.
 * @param ctx - invariant registry owner.
 * @returns registration disposer after installation.
 */
export const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
//# sourceMappingURL=invariant.js.map