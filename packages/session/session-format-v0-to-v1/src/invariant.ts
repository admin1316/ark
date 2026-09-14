/** Package-owned companion for the frozen released-v0 codec and v1 migration. */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-session-format-v0-to-v1'

/** Cordis companion plugin name. */
export const name = 'session-format-v0-to-v1-invariant'
/** Registry required to reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: released-v0 decoding and the v1 identity migration operate
 * on caller-owned artifacts. Their frozen payload and relationship validators run
 * during restoration; this codec has no live event subscription or persistence owner.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's companion without decoding historical data.
 * @param ctx - context carrying the invariant registry.
 * @returns the installed registration's disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
