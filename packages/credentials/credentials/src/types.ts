/**
 * Client-safe type surface of the credential seam: the two key brands, the
 * stored-record union, and the seam's Cordis event declarations. Types only —
 * no runtime code, and nothing here reaches a Host-only symbol, so a Client
 * compilation face reads exactly the signature the Host emits.
 *
 * @module @deepseek-ai/dsh-credentials/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Value-free source and writability facts for configuration UIs. */
export interface CredentialInfo {
  /** Whether the provider would currently resolve a value. */
  configured: boolean
  /** Source supplying the value; absent while unconfigured. */
  source?: string
  /** Whether the provider permits writing this reference. */
  writable: boolean
}

/** Nominal reference to one credential: a POSIX-style environment-variable name. */
export type CredentialRef = Branded<'CredentialRef'>

/**
 * Nominal address of one stored credential record: `<scope>/<id>`, where
 * `scope` is the registered name of the plugin that owns the record and `id`
 * is that plugin's own addressing unit (an LLM adapter uses its provider route
 * key).
 *
 * The scope is the owner rather than the domain because a record's payload is
 * written in its owner's format: two plugins serving the same provider name
 * would otherwise read each other's payload, and a record left behind by an
 * uninstalled plugin could not be told apart from a live one. The `/` also
 * keeps this grammar disjoint from {@link CredentialRef}, so the two key
 * spaces can never collide.
 */
export type CredentialKey = Branded<'CredentialKey'>

/**
 * A credential the harness itself understands: an api key, provider
 * environment values, or both. Either field may be absent — a record carrying
 * neither states that the owner confirmed this route authenticates from its
 * own ambient discovery, which is a different fact from having no record.
 */
export interface ApiKeyRecord {
  /** Discriminant. */
  readonly kind: 'api-key'
  /** The non-empty secret value, when this credential is a key at all. */
  readonly key?: string
  /** Provider environment values such as `AWS_PROFILE`; names are POSIX identifiers. */
  readonly env?: Readonly<Record<string, string>>
}

/**
 * The product of one authorization grant, kept verbatim for its owner. The
 * seam never reads, validates, or reshapes {@link payload}: it is written in
 * the owning plugin's format and only that plugin can interpret it. The single
 * constraint is that it survives a JSON round trip.
 */
export interface GrantRecord {
  /** Discriminant. */
  readonly kind: 'grant'
  /** Owner-defined JSON value; opaque to the seam and to every other plugin. */
  readonly payload: unknown
}

/** One durable credential record, tagged by what the seam may do with it. */
export type CredentialRecord = ApiKeyRecord | GrantRecord

/** Value-free view of one credential reference exported to a Native Remote caller. */
export interface RemoteCredentialView {
  /** Whether any source currently configures the reference. */
  readonly configured: boolean
  /** Winning source when configured; secret bytes are never exported. */
  readonly source?: string
  /** Whether the current provider permits set/unset for this reference. */
  readonly writable: boolean
}

/** Value-free batch result of the `credentials/describe` Remote method. */
export interface RemoteCredentialsDescription {
  /** One status record for each requested reference, keyed by its input name. */
  readonly credentials: Readonly<Record<string, RemoteCredentialView>>
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Committed change to a provider-managed credential source: a `set`, an
     * `unset`, or an external edit observed in storage. Ambient
     * process-environment changes are not observable and never emit. Listener
     * failures are contained and logged — a sync throw and an async rejection
     * alike — without changing the committed operation's outcome, except
     * `INVARIANT`-coded failures, which rethrow after every listener ran;
     * that rethrow reaches the emitter only from synchronous listeners, so
     * invariant checks on this event must not be async functions.
     * @param ref - the reference whose stored value changed.
     * @mode emit
     */
    'credentials/reference-updated'(ref: CredentialRef): void

    /**
     * Committed change to a stored credential record: a `modifyRecord` that
     * wrote, a `deleteRecord` that removed, or an external edit observed in
     * storage. Separate from `credentials/reference-updated` because the two key
     * grammars are disjoint — a listener that received both on one event could
     * not tell which space a subject belongs to. Listener failures are
     * contained on the same terms as `credentials/reference-updated`.
     * @param key - the record whose stored value changed.
     * @mode emit
     */
    'credentials/record-updated'(key: CredentialKey): void
  }
}
