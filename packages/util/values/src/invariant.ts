/** Package-owned companion for JSON and immutable-value utilities. */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-util-values'

/** Cordis companion plugin name. */
export const name = 'util-values-invariant'
/** Registry required to reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: JSON walks, comparisons, and freezes retain no shared
 * state or event history. Their values and traversal state belong to each caller;
 * calling them on invented constants would test examples rather than runtime ownership.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's companion without inspecting caller values.
 * @param ctx - context carrying the invariant registry.
 * @returns the installed registration's disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
