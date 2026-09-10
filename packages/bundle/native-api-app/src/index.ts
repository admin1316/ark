/**
 * API-only native desktop readiness owner. It publishes one loopback URL only
 * after the complete Loader tree settles and never mounts browser behavior.
 * @module @deepseek-ai/dsh-native-api-app
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-host-webserver'

/** Stable Cordis plugin name. */
export const name = 'native-api-app'

/** The bound WebServer is the sole runtime dependency. */
export const inject = ['webServer']

const LOOPBACK_HOST = '127.0.0.1'

/**
 * Publish the API readiness line after every sibling row has activated.
 * A failed or disposed Loader tree remains silent, so a supervisor never
 * accepts a listener whose application failed to finish booting.
 * @param ctx - plugin context carrying the bound API-only WebServer.
 */
export function apply(ctx: Context): void {
  const announce = (): void => {
    const server = ctx.get('webServer')
    if (server === undefined) return
    console.log(`dsh native-api: http://${LOOPBACK_HOST}:${String(server.port)}`)
  }
  const settled = ctx.get('loader')?.await()
  if (settled === undefined) announce()
  else void settled.then(announce, () => {})
}
