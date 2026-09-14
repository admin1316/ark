/** Invariant registration for the stateless Remote adapter. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

/** Cordis companion plugin name. */
export const name = 'team-remote-invariant'
/** Invariant registry dependency. */
export const inject = ['invariants']

// No runtime invariant: this stateless adapter delegates to the domain and owns no mutable Team state.
const install: InvariantInstaller = () => {}

/**
 * Register only this adapter's ownership; do not register a second domain validator.
 * @param ctx - invariant registry owner.
 * @returns registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-experimental-agent-team', install))
