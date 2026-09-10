/**
 * Client-safe type surface of the user-settings seam: the namespace brand, the
 * commit-origin union, the redacted views a configuration surface reads over
 * the Remote wire, and the seam's Cordis event declarations. Types only — no
 * runtime code, and nothing here reaches a Host-only symbol, so a Client
 * compilation face reads exactly the signatures the Host emits.
 *
 * @module @deepseek-ai/dsh-settings/types
 */
import type { Branded } from '@deepseek-ai/dsh-brand';
/** Nominal id of one registered settings namespace. */
export type SettingsNamespace = Branded<'SettingsNamespace'>;
/** Origin of one committed settings change. */
export type SettingsUpdateSource = 'update' | 'provider';
/** One schema-declared secret slot inside a redacted namespace value. */
export interface SettingsSecretView {
    /** Path from the section root to the removed field. */
    path: string[];
    /** Whether the slot currently holds a value; the value itself never rides. */
    set: boolean;
}
/**
 * Wire view of one registered namespace, always read under `redactSecrets`. The
 * JSON-valued fields are `RemoteSettingsJsonValue` rather than the descriptor's `unknown`
 * because the Remote boundary admits no unconstrained data.
 */
export interface SettingsNamespaceView {
    /** Namespace key (`llm-deepseek`, `llm-pi-ai`, …). */
    ns: string;
    /** Serialized schemastery schema envelope (`schema.toJSON()`); rehydrate with `new Schema(json)`. */
    schema: RemoteSettingsJsonValue;
    /** Redacted resolved value (schema defaults → composition base → user layer). */
    value: RemoteSettingsJsonValue;
    /** Redacted composition base layer, when the registrant declared one. */
    base?: RemoteSettingsJsonValue;
    /** Redacted raw user section, when one exists; a field's presence here marks it user-overridden. */
    user?: RemoteSettingsJsonValue;
    /** When the owner applies changes. */
    applies: 'live' | 'restart';
    /** Every schema-declared secret slot with its configured state. */
    secrets: SettingsSecretView[];
    /**
     * Monotonic revision of the raw user section this view was read at. Send it
     * back as `expectedRevision` on a write so a stale editor is refused rather
     * than silently overwriting a concurrent change.
     */
    revision: number;
}
/**
 * One path-addressed edit carried by a remote settings write. `set` writes the
 * value at the path, creating intermediate objects; `unset` removes it. The
 * empty path addresses the section root.
 */
export type SettingsPathOpView = {
    op: 'set';
    path: string[];
    value: RemoteSettingsJsonValue;
} | {
    op: 'unset';
    path: string[];
};
/** Every registered namespace with the deployment facts a configuration page renders around them. */
export interface SettingsDescribeValue {
    /** Whether the provider accepts writes; `false` disables every write control. */
    writable: boolean;
    /** Whether a file-backed provider owns a local document, without exposing its Host path. */
    hasDocument: boolean;
    /** One view per registered namespace. */
    namespaces: SettingsNamespaceView[];
}
/** Lossless data admitted by the native Settings Remote methods. */
export type RemoteSettingsJsonValue = null | boolean | number | string | RemoteSettingsJsonValue[] | {
    [key: string]: RemoteSettingsJsonValue;
};
/** A namespace section or merge patch carried by the native Remote. */
export interface RemoteSettingsJsonObject {
    [key: string]: RemoteSettingsJsonValue;
}
/** A write-only field's position and configured state, never its value. */
export interface RemoteSettingsSecretView {
    readonly path: readonly string[];
    readonly set: boolean;
}
/** Detached, redacted namespace returned by native reads and writes. */
export interface RemoteSettingsNamespaceView {
    readonly ns: string;
    readonly schema: RemoteSettingsJsonValue;
    readonly value: RemoteSettingsJsonValue;
    readonly base?: RemoteSettingsJsonValue;
    readonly user?: RemoteSettingsJsonValue;
    readonly applies: 'live' | 'restart';
    readonly secrets: readonly RemoteSettingsSecretView[];
    readonly revision: number;
}
/** Native settings catalog, without provider filesystem paths. */
export interface RemoteSettingsDescription {
    readonly writable: boolean;
    readonly hasDocument: boolean;
    readonly namespaces: readonly RemoteSettingsNamespaceView[];
}
/** Confirmation of a provider-owned native editor handoff. */
export interface RemoteSettingsDocumentOpenResult {
    readonly opened: true;
}
/** Ordered edits that do not require restating hidden fields. */
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
         * after fan-out; reentrant publication stops delivery of superseded values.
         * That rethrow reaches the emitter only from
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
         * stale. Exact-revision settlement is bound before notification; persistence
         * does not imply activation. Reentrant publication stops superseded revision
         * delivery. Listener containment matches `settings/updated`.
         * @param ns - the namespace whose stored section changed.
         * @param revision - the namespace's new revision.
         * @mode emit
         */
        'settings/document-updated'(ns: SettingsNamespace, revision: number): void;
    }
}
//# sourceMappingURL=types.d.ts.map