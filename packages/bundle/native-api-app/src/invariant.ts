/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-native-api-app`.
 * @module @deepseek-ai/dsh-native-api-app/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-native-api-app'

/** Cordis companion plugin name. */
export const name = 'native-api-app-invariant'
/** Service required before the companion can register. */
export const inject = ['invariants']

// No runtime invariant: the bundle's rows retain ownership in their packages,
// while this package only publishes a post-settlement readiness line.
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
