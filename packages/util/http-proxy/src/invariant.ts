/** Package-owned startup check of the active proxy policy's child environment. */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { proxyEnvironmentForChild } from '@deepseek-ai/dsh-http-proxy'
import { isSupportedProxyUrl, POLICY_ENV_NAMES } from './policy.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-http-proxy'

/** Cordis companion plugin name. */
export const name = 'http-proxy-invariant'
/** Registry required to reserve package ownership. */
export const inject = ['invariants']

/**
 * Check the actual active policy when this companion starts. Enabling Node's
 * environment proxy requires every supplied HTTP(S) proxy variable to be usable
 * by Node; inherited SOCKS values may remain only with that flag withheld.
 * Installation and disposal stay owned by the launcher, without polling here.
 */
const install: InvariantInstaller = (_ctx, fail) => {
  const environment = proxyEnvironmentForChild()
  if (environment.NODE_USE_ENV_PROXY !== '1') return
  for (const key of [...POLICY_ENV_NAMES.httpProxy, ...POLICY_ENV_NAMES.httpsProxy]) {
    const value = environment[key]
    if (value !== undefined && !isSupportedProxyUrl(value)) {
      fail(`child environment enables Node proxy parsing with an unsupported ${key}; proxy values are withheld`)
    }
  }
}

/**
 * Register the package's check of its current child-environment result.
 * @param ctx - context carrying the invariant registry.
 * @returns the installed registration's disposer after validation succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
