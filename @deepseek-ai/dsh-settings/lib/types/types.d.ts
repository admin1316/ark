/**
 * Client-safe type surface of the user-settings seam: the namespace brand, the
 * commit-origin union, and the seam's Cordis event declarations. Types only —
 * no runtime code, and nothing here reaches a Host-only symbol, so a Client
 * compilation face reads exactly the signatures the Host emits.
 *
 * @module @deepseek-ai/dsh-settings/types
 */
import type { Branded } from '@deepseek-ai/dsh-brand';
/** Nominal id of one registered settings namespace. */
export type SettingsNamespace = Branded<'SettingsNamespace'>;
/** Origin of one committed settings change. */
export type SettingsUpdateSource = 'update' | 'provider';
/** Lossless JSON data permitted through the Native settings Remote boundary. */
export type RemoteSettingsJsonValue = null | boolean | number | string | RemoteSettingsJsonValue[] | {
    [key: string]: RemoteSettingsJsonValue;
};
/** JSON object accepted for a settings section or merge patch. */
export type RemoteSettingsJsonObject = {
    [key: string]: RemoteSettingsJsonValue;
};
/** One schema-declared secret position in a redacted Remote settings view. */
export interface RemoteSettingsSecretView {
    /** Path from the namespace root to the write-only field. */
    readonly path: readonly string[];
    /** Whether the write-only field currently has a stored value. */
    readonly set: boolean;
}
/** A redacted namespace projection exposed by the `settings/*` Remote owner. */
export interface RemoteSettingsNamespaceView {
    /** Registered namespace identifier. */
    readonly ns: string;
    /** Serialized schemastery schema for the native configuration form. */
    readonly schema: RemoteSettingsJsonValue;
    /** Resolved value with every secret-role field removed. */
    readonly value: RemoteSettingsJsonValue;
    /** Redacted composition base when the namespace declared one. */
    readonly base?: RemoteSettingsJsonValue;
    /** Redacted raw user layer when one exists. */
    readonly user?: RemoteSettingsJsonValue;
    /** Whether the owner applies a successful write live or on restart. */
    readonly applies: 'live' | 'restart';
    /** Write-only slots and their configured state. */
    readonly secrets: readonly RemoteSettingsSecretView[];
    /** Monotonic raw-user-section revision used for compare-and-swap writes. */
    readonly revision: number;
}
/** Complete result of the redacted `settings/describe` Remote method. */
export interface RemoteSettingsDescription {
    /** Whether this deployment accepts settings writes. */
    readonly writable: boolean;
    /** Whether a local editable document exists for a native host handoff. */
    readonly hasDocument: boolean;
    /** Every currently registered namespace in registration order. */
    readonly namespaces: readonly RemoteSettingsNamespaceView[];
}
/** Success value of the privileged `settings/openDocument` native handoff. */
export interface RemoteSettingsDocumentOpenResult {
    /** The Host prepared and handed its owned settings document to a text editor. */
    readonly opened: true;
}
/** One path-addressed Remote settings mutation. */
export type RemoteSettingsPathOp = {
    readonly op: 'set';
    readonly path: readonly string[];
    readonly value: RemoteSettingsJsonValue;
} | {
    readonly op: 'unset';
    readonly path: readonly string[];
};
declare module '@deepseek-ai/cordis' {
    interface Events {
        /**
         * Committed change to one registered namespace's resolved value. Emitted
         * after the provider persisted (for `update`) or published (`provider`)
         * the change; never emitted when the resolved value is deep-equal.
         * Listener failures are contained and logged — a sync throw and an async
         * rejection alike — except `INVARIANT`-coded failures, which rethrow
         * after fan-out; a reentrant commit stops delivery of the superseded value
         * to later listeners. That rethrow reaches the emitter only from
         * synchronous listeners, so invariant checks on this event must not be
         * async functions.
         * @param ns - the namespace whose resolved value changed.
         * @param next - the new resolved value.
         * @param prev - the previous resolved value.
         * @param source - whether the change entered through `update()` or the provider.
         * @mode emit
         */
        'settings/updated'(ns: SettingsNamespace, next: unknown, prev: unknown, source: SettingsUpdateSource): void;
        /**
         * One registered namespace's RAW user section changed, whether or not the
         * resolved value did. `settings/updated` is the consumer-facing event and
         * stays deep-equal-gated; this one exists for configuration surfaces,
         * which must learn that a field went from inherited to overridden (same
         * resolved value, different meaning) and that their held revision is
         * stale. Exact-revision settlement is bound before notification, which
         * does not itself imply activation. Reentrant publication stops delivery
         * of the superseded revision. Listener containment matches `settings/updated`.
         * @param ns - the namespace whose stored section changed.
         * @param revision - the namespace's new revision.
         * @mode emit
         */
        'settings/document-updated'(ns: SettingsNamespace, revision: number): void;
    }
}
//# sourceMappingURL=types.d.ts.map