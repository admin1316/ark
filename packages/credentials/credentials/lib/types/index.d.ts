/**
 * Service Definition for the credential-reference capability seam (`ctx.credentials`). Settings and composition files carry
 * *references* to secrets — environment-variable names — while providers own
 * the actual values and their storage. Consumers resolve a reference once per
 * operation, so a changed credential reaches the next operation without any
 * plugin restart, and configuration surfaces describe a reference without
 * ever seeing its value.
 * @module @deepseek-ai/dsh-credentials
 */
import { Context } from '@deepseek-ai/cordis';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { CredentialInfo, CredentialKey, CredentialRecord, CredentialRef, RemoteCredentialsDescription } from './types.ts';
export type { CredentialInfo, ApiKeyRecord, CredentialKey, CredentialRecord, CredentialRef, GrantRecord, RemoteCredentialView, RemoteCredentialsDescription, } from './types.ts';
/**
 * Brand a raw string as a {@link CredentialRef}.
 * @param value - candidate reference; a POSIX shell identifier such as `DEEPSEEK_API_KEY`.
 * @returns the branded reference.
 */
export declare function credentialRef(value: string): CredentialRef;
/**
 * Whether a raw string could name a reference at all. Consumers that receive
 * environment-variable names from somewhere else — a provider library's own
 * ambient discovery, a hook payload — ask this before resolving, because a name
 * outside the grammar has no reference to miss and should read as "not set"
 * rather than as a thrown error.
 * @param value - candidate reference.
 * @returns true when {@link credentialRef} would accept it.
 */
export declare function isCredentialRefName(value: string): boolean;
/**
 * Whether a raw string could be a {@link credentialKey} segment at all.
 * Consumers whose addressing units come from somewhere else — a settings dict
 * key, a library's own provider id — ask this before building a key, because a
 * unit outside the grammar can never have stored a record and should read as
 * "nothing stored" rather than as a thrown error.
 * @param value - candidate segment.
 * @returns true when {@link credentialKey} would accept it as either segment.
 */
export declare function isCredentialKeySegment(value: string): boolean;
/**
 * Brand a scope and an id as a {@link CredentialKey}.
 * @param scope - the owning plugin's registered name, such as `llm-pi-ai`.
 * @param id - that plugin's own addressing unit, such as a provider route key.
 * @returns the branded key.
 * @throws TypeError when either segment is not a lowercase hyphenated identifier.
 */
export declare function credentialKey(scope: string, id: string): CredentialKey;
/**
 * Brand a stored `<scope>/<id>` string as a {@link CredentialKey}. This is the
 * read half of {@link credentialKey}, for a provider admitting keys off disk.
 * @param value - candidate key in its joined form.
 * @returns the branded key.
 * @throws TypeError when the value is not exactly two valid segments.
 */
export declare function parseCredentialKey(value: string): CredentialKey;
/**
 * The owning plugin's name for one key. A record whose scope names no
 * currently registered owner is an orphan, which a configuration surface must
 * report as such rather than as a working credential.
 * @param key - the key to read.
 * @returns the scope segment.
 */
export declare function credentialKeyScope(key: CredentialKey): string;
/**
 * The owning plugin's own addressing unit for one key — the half that plugin
 * chose, such as a provider route.
 * @param key - the key to read.
 * @returns the id segment.
 */
export declare function credentialKeyId(key: CredentialKey): string;
/** One resolved credential value and the source layer that supplied it. */
export interface ResolvedCredential {
    /** The non-empty secret value. */
    value: string;
    /** Provider-defined source layer id (the local provider uses `env`, `file`, `project-env`, and `user-env`). */
    source: string;
}
/** A secret-free compare-and-set condition; a null digest requires absence. */
export interface CredentialCondition {
    /** SHA-256 of the resolved secret, or null when the reference must be absent. */
    valueDigest: string | null;
    /** When supplied, require the same resolution layer as well as the value. */
    source?: string;
}
/** The reference changed before its conditional write; no requested write occurred. */
export declare class CredentialConflictError extends Error {
    readonly ref: CredentialRef;
    /** @param ref - the reference whose condition no longer holds. */
    constructor(ref: CredentialRef);
}
/**
 * Capture a reference's value and source without retaining its secret.
 * @param current - the resolved reference, or absence.
 * @returns the condition for a later provider-owned conditional write.
 */
export declare function credentialCondition(current: ResolvedCredential | undefined): CredentialCondition;
/**
 * Check a conditional write while the provider holds its write exclusion.
 * @param ref - the reference being checked.
 * @param current - its current resolved value.
 * @param expected - the required value digest and optional source.
 * @returns nothing when the condition matches.
 * @throws CredentialConflictError without including secret values or digests.
 */
export declare function assertCredentialCondition(ref: CredentialRef, current: ResolvedCredential | undefined, expected: CredentialCondition): void;
/** Presence and writability facts for one record, safe for configuration UIs — never the value. */
export interface CredentialRecordInfo {
    /**
     * Whether a record is stored. Unlike a reference, presence alone answers
     * this: an {@link ApiKeyRecord} carrying neither a key nor environment
     * values states that its owner confirmed ambient authentication, which is
     * configured, not blank.
     */
    configured: boolean;
    /** Discriminant of the stored record; absent while none is stored. */
    kind?: CredentialRecord['kind'];
    /** Whether {@link CredentialProvider.modifyRecord} would currently succeed. */
    writable: boolean;
}
/** One stored record's address and tag, for enumeration — never its value. */
export interface CredentialRecordEntry {
    /** The record's address. */
    key: CredentialKey;
    /** Discriminant of the stored record. */
    kind: CredentialRecord['kind'];
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        credentials: CredentialProvider;
    }
}
/**
 * Abstract credential service over two key spaces that answer two questions.
 *
 * A {@link CredentialRef} answers "what is behind this environment-variable
 * name", layered over the process environment, the provider-managed store, and
 * `.env` files. One seam-wide rule binds that half: an empty stored value is
 * absent everywhere — `resolve` skips it, `describe` reports it unconfigured —
 * so a blank never masquerades as a configured secret.
 *
 * A {@link CredentialKey} answers "what credential does this plugin hold for
 * this id". Nothing can layer here — an authorization grant has no
 * environment to be read from — so presence of the record is the whole fact,
 * and {@link modifyRecord} is the only write path because a correct write
 * depends on the current value (a token refresh is read-decide-replace under
 * one lock).
 */
export declare abstract class CredentialProvider extends TypertRemoteService {
    constructor(ctx: Context);
    /**
     * Resolve one reference to its current value. Resolution is per call:
     * consumers re-resolve at each operation and must not cache across
     * operations — that per-operation read is what makes a changed credential
     * reach the next operation without a restart.
     * @param ref - the reference to resolve.
     * @returns the value and its source, or `undefined` while unconfigured.
     */
    abstract resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined>;
    /**
     * Describe one reference for configuration surfaces without exposing the
     * value.
     * @param ref - the reference to describe.
     * @returns configured state, supplying source, and writability.
     */
    abstract describe(ref: CredentialRef): Promise<CredentialInfo>;
    /**
     * Durably store one value in the provider-managed writable source. Rejects
     * while a read-only source shadows the reference — the write would appear
     * to succeed while resolution keeps returning the shadowing value — and
     * rejects an empty value (use {@link unset}).
     * @param ref - the reference to store.
     * @param value - the non-empty secret value.
     * @param expected - optional condition checked under the same exclusion as all reference writes; a mismatch rejects without writing.
     */
    abstract set(ref: CredentialRef, value: string, expected?: CredentialCondition): Promise<void>;
    /**
     * Remove one reference from the provider-managed writable source; removing
     * an absent reference is a no-op. Rejects while a read-only source shadows
     * the reference, like {@link set}.
     * @param ref - the reference to remove.
     * @param expected - optional condition checked under the same exclusion as all reference writes; a mismatch rejects without deleting.
     */
    abstract unset(ref: CredentialRef, expected?: CredentialCondition): Promise<void>;
    /**
     * Read one stored record. The value is returned as its owner wrote it; a
     * {@link GrantRecord} payload is not interpreted on the way out.
     * @param key - the record to read.
     * @returns the record, or `undefined` while none is stored.
     */
    abstract readRecord(key: CredentialKey): Promise<CredentialRecord | undefined>;
    /**
     * Describe one record for configuration surfaces without exposing its value.
     * @param key - the record to describe.
     * @returns presence, discriminant, and writability.
     */
    abstract describeRecord(key: CredentialKey): Promise<CredentialRecordInfo>;
    /**
     * Enumerate every stored record's address and tag. Unlike the reference
     * half, which has no enumeration because configuration surfaces learn which
     * references exist from settings schemas, records have no such discovery
     * path: a surface that cannot list them cannot show what a user is
     * authorized for, nor find an orphan left by an uninstalled plugin.
     * @returns every stored record, values excluded.
     */
    abstract listRecords(): Promise<readonly CredentialRecordEntry[]>;
    /**
     * Serialized read-modify-write over one record — the only write path.
     * `mutate` sees the record as it stands at the moment the write is
     * exclusive, and returning `undefined` leaves the entry untouched. Exclusion
     * holds across processes where the backing store supports it, which is what
     * makes a token refresh safe: two processes rotating one refresh token
     * concurrently would otherwise lose whichever wrote first.
     * @param key - the record to modify.
     * @param mutate - receives the current record and returns its replacement, or `undefined` to leave it.
     * @param references - optional conditions checked before `mutate`, with exclusion held through commit.
     * Callbacks must not enqueue writes on this provider.
     * @returns the record after the write, or the current one when `mutate` declined.
     */
    abstract modifyRecord(key: CredentialKey, mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>, references?: readonly {
        ref: CredentialRef;
        expected: CredentialCondition;
    }[]): Promise<CredentialRecord | undefined>;
    /**
     * Remove one record; removing an absent record is a no-op.
     * @param key - the record to remove.
     */
    abstract deleteRecord(key: CredentialKey): Promise<void>;
    /**
     * Describe named references without returning any credential value.
     * There is intentionally no Remote enumeration endpoint: settings schemas
     * remain the authority that tells a configuration surface which refs exist.
     * @param refs - credential reference names to describe.
     * @returns redacted metadata for each requested reference.
     */
    remoteDescribe(refs: readonly string[]): Promise<RemoteCredentialsDescription>;
    /**
     * Store one write-only credential value through the Native Remote plane.
     * @param refName - credential reference name to update.
     * @param value - write-only credential value.
     * @returns an empty object after the value is stored.
     */
    remoteSet(refName: string, value: string): Promise<Record<never, never>>;
    /**
     * Remove one provider-managed credential through the Native Remote plane.
     * @param refName - credential reference name to remove.
     * @returns an empty object after the reference is removed.
     */
    remoteUnset(refName: string): Promise<Record<never, never>>;
    /**
     * Fan `credentials/reference-updated` out with contained listener failures: every
     * listener runs, and a sync throw or async rejection is logged without
     * changing the committed operation's outcome — except `INVARIANT`-coded
     * failures, which rethrow after every listener ran (the rethrow reaches the
     * caller only from synchronous listeners, so invariant checks on this event
     * must not be async functions). Providers call this only after the write or
     * reload actually committed, so a broken observer can never make a durable
     * change look failed.
     * @param ref - the reference whose stored value changed.
     */
    protected notifyUpdated(ref: CredentialRef): void;
    /**
     * Fan `credentials/record-updated` out on exactly the terms
     * {@link notifyUpdated} documents, for the record half of the seam.
     * @param key - the record whose stored value changed.
     */
    protected notifyRecordUpdated(key: CredentialKey): void;
    /** The contained dispatch both notifications run through; see {@link notifyUpdated}. */
    private fanOut;
    /** Contained-listener diagnostic shared by the sync and async failure paths. */
    private warnListenerFailure;
}
export default CredentialProvider;
//# sourceMappingURL=index.d.ts.map