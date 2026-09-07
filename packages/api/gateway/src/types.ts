/**
 * Host-only Typert Gateway request, dispatcher, and failure contracts.
 * @module @deepseek-ai/dsh-api-gateway/types
 */

import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'

/** Stable failures produced before or after a strict business invocation. */
export type TypertGatewayErrorCode =
  | 'arguments-invalid'
  | 'binding-invalid'
  | 'cancelled'
  | 'context-failed'
  | 'context-not-found'
  | 'context-unavailable'
  | 'definition-invalid'
  | 'definition-unavailable'
  | 'input-invalid'
  | 'invocation-unavailable'
  | 'lookup-failed'
  | 'lookup-not-found'
  | 'lookup-unavailable'
  | 'method-unavailable'
  | 'provider-mismatch'
  | 'result-invalid'
  | 'service-unavailable'

/** Host dispatcher installed on Connection's shared `/api` channel. */
export interface TypertGateway {
  /**
   * Report whether the live strict registry owns one slash Remote endpoint.
   * @param endpoint - channel-relative endpoint.
   * @returns `true` for a live or withdrawn strict definition.
   */
  claims(endpoint: string): boolean

  /**
   * Invoke one strict Remote endpoint and settle in the nested Remote result used by Native clients.
   * @param endpoint - canonical `<namespace>/<method>` endpoint.
   * @param payload - exact `{ args }` Remote payload.
   * @param signal - carrier cancellation lifetime.
   * @returns validated business value or a stable Remote failure.
   */
  invoke(endpoint: string, payload: unknown, signal: AbortSignal): Promise<RemoteResult<unknown>>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host-only dispatcher for strict Typert Remote calls. */
    typertGateway: TypertGateway
  }
}
