/** Package-owned companion for released-v2 canonical-envelope and PTC migration. */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-session-format-v2-to-v3'

/** Cordis companion plugin name. */
export const name = 'session-format-v2-to-v3-invariant'
/** Registry required to reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: system-prompt, canonical-envelope, and PTC relationships
 * are validated inside caller-owned historical migration stages. This package
 * neither executes tools nor publishes migrated events into a live Session.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's companion without replaying migration input.
 * @param ctx - context carrying the invariant registry.
 * @returns the installed registration's disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
