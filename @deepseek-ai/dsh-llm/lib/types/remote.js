/** Native Typert Remote projections owned by the LLM configuration domain. */
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { symbols } from '@deepseek-ai/cordis';
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials';
import { deepEqualJson, remoteNamespaceView, SettingsConflictError, settingsNamespace, } from '@deepseek-ai/dsh-settings';
import { isTypertRemoteFailure, TypertLookupFailure } from '@deepseek-ai/dsh-typert-protocol';
const PROVIDER_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROVIDER_VERIFY_TIMEOUT_MS = 15_000;
const SECRET_HEADER_NAME = /authorization|api[-_]?key|auth[-_]?token|access[-_]?token|token|secret|credential|password|cookie/i;
// Execution leases only: settings revisions and durable journals remain authoritative.
const transactionTails = new WeakMap();
const transactionExecution = new AsyncLocalStorage();
/** Reserve every key together; acquire journal, namespace, then reference tiers. */
async function withTransactionKeys(owner, keys, operation) {
    if (keys.length === 0)
        return operation();
    const identity = Reflect.get(owner, symbols.original) ?? owner;
    let tails = transactionTails.get(identity);
    if (tails === undefined) {
        tails = new Map();
        transactionTails.set(identity, tails);
    }
    const distinct = [...new Set(keys)].sort();
    const previous = distinct.flatMap(key => tails.get(key) ?? []);
    const lease = Promise.withResolvers();
    for (const key of distinct)
        tails.set(key, lease.promise);
    try {
        await Promise.all(previous);
        return await operation();
    }
    finally {
        lease.resolve();
        for (const key of distinct) {
            if (tails.get(key) === lease.promise)
                tails.delete(key);
        }
        if (tails.size === 0)
            transactionTails.delete(identity);
    }
}
/** Hold one provider executor through settlement; reject recursive callback mutations. */
async function withProviderExecution(credentials, provider, signal, operation) {
    if (transactionExecution.getStore()?.active) {
        remoteFailure('provider-transaction-reentrant', 'provider mutation cannot be nested inside a running provider transaction', { provider });
    }
    return withTransactionKeys(credentials, [`journal:${provider}`], async () => {
        assertProviderNotCancelled(signal);
        const execution = { active: true };
        try {
            return await transactionExecution.run(execution, operation);
        }
        finally {
            execution.active = false;
        }
    });
}
/** Before durable claim, cancellation leaves no credential or profile mutation. */
function assertProviderNotCancelled(signal) {
    if (signal?.aborted)
        remoteFailure('cancelled', 'provider transaction was cancelled before durable claim', {});
}
/** Lock both removed and adopted references, including a staged generation. */
function transactionCredentialRefs(value, ops, settingsPath, suppliedRef) {
    return new Set([
        ...providerCredentialRefs(value, settingsPath),
        ...providerCredentialRefs(applyRemoteOps(value, ops), settingsPath),
        ...suppliedRef === undefined ? [] : [suppliedRef],
    ]);
}
/**
 * Whether an HTTP header value must live behind a credential reference.
 * @param name - Header name to classify case-insensitively.
 * @returns True for credential-, token-, cookie-, or password-bearing names.
 */
export function isCredentialHeaderName(name) {
    return SECRET_HEADER_NAME.test(name.trim().toLowerCase());
}
/**
 * Project the configured and live provider directories without giving writes a second owner.
 * @param runtime - The runtime input.
 * @returns The value produced by list remote providers.
 */
export function listRemoteProviders(runtime) {
    const active = new Set(runtime.listProviders().map(provider => provider.id));
    const declared = new Set();
    const providers = runtime.listConfigurableProviders().map((entry) => {
        declared.add(entry.provider);
        return {
            provider: entry.provider,
            displayName: entry.displayName,
            settingsNs: entry.settingsNs,
            settingsPath: [...entry.settingsPath],
            active: active.has(entry.provider),
            ...entry.declared === undefined ? {} : { declared: entry.declared },
            ...entry.migrationRequired === undefined ? {} : {
                migrationRequired: {
                    code: entry.migrationRequired.code,
                    fields: [...entry.migrationRequired.fields],
                },
            },
        };
    });
    for (const provider of runtime.listProviders()) {
        if (declared.has(provider.id))
            continue;
        providers.push({
            provider: provider.id,
            displayName: provider.name,
            settingsNs: '',
            settingsPath: [],
            active: true,
        });
    }
    return { providers };
}
/**
 * Build a failure-isolated host-scoped model catalog.
 * @param runtime - The runtime input.
 * @returns The value produced by list remote models.
 */
export async function listRemoteModels(runtime) {
    const catalog = await Promise.all(runtime.listProviders().map(async (provider) => {
        try {
            const models = await runtime.listModels(provider.id);
            const rows = await Promise.all(models.map(async (model) => {
                const resolved = await runtime.resolveModelInfo(provider.id, model.id);
                return projectRemoteModel(model, resolved);
            }));
            const group = { id: provider.id, name: provider.name, models: rows };
            return { kind: 'group', group };
        }
        catch (error) {
            const failure = {
                id: provider.id,
                name: provider.name,
                message: error instanceof Error ? error.message : String(error),
            };
            return { kind: 'failure', failure };
        }
    }));
    return {
        groups: catalog.flatMap(entry => entry.kind === 'group' && entry.group.models.length > 0 ? [entry.group] : []),
        failures: catalog.flatMap(entry => entry.kind === 'failure' ? [entry.failure] : []),
    };
}
/**
 * Discover a draft provider's models without storing or returning its one-shot secret.
 * @param runtime - The runtime input.
 * @param request - The request input.
 * @param signal - The signal input.
 * @returns The value produced by discover remote models.
 */
export async function discoverRemoteModels(runtime, request, signal) {
    if (signal.aborted)
        remoteFailure('cancelled', 'model discovery was cancelled', {});
    try {
        const models = await runtime.discoverModels(request.settingsNs, {
            ...request.provider === undefined ? {} : { provider: request.provider },
            ...request.baseURL === undefined ? {} : { baseURL: request.baseURL },
            ...request.api === undefined ? {} : { api: request.api },
            ...request.apiKey === undefined ? {} : { apiKey: request.apiKey },
            signal,
        });
        if (isAborted(signal))
            remoteFailure('cancelled', 'model discovery was cancelled', {});
        return { models: models.map(remoteDiscoveredModel) };
    }
    catch (error) {
        if (isTypertRemoteFailure(error))
            throw error;
        if (isRemoteFailure(error))
            throwRemoteFailure(error);
        if (isAborted(signal))
            remoteFailure('cancelled', 'model discovery was cancelled', {});
        remoteFailure('model-discovery-failed', 'provider model discovery failed', {
            settingsNs: request.settingsNs,
            ...request.baseURL === undefined ? {} : { baseURL: request.baseURL },
        });
    }
}
/**
 * Read one provider transaction without returning its operations or secrets.
 * @param runtime - Live provider registry used only for terminal live-state projection.
 * @param ctx - Host context containing the secure credential journal provider.
 * @param request - Provider id and transaction UUID to inspect.
 * @returns Durable phase, credential requirement, and optional live state.
 */
export async function providerTransactionStatus(runtime, ctx, request) {
    if (!PROVIDER_PATTERN.test(request.provider) || !UUID_PATTERN.test(request.transactionId)) {
        remoteFailure('input-invalid', 'provider transaction status needs a valid provider and UUID', {});
    }
    const credentials = ctx.get('credentials');
    if (credentials === undefined)
        remoteFailure('service-unavailable', 'credentials service is absent', {});
    const record = await readProviderJournal(credentials, request.provider);
    const payload = record?.kind === 'grant' && isRecord(record.payload) ? record.payload : undefined;
    if (payload === undefined || payload.transactionId !== request.transactionId) {
        return { state: 'absent', needsCredential: false };
    }
    const phase = payload.phase;
    const outcome = payload.outcome;
    const state = phase === 'done'
        ? outcome === 'committed' || outcome === 'rolled-back' || outcome === 'committed-not-live'
            ? outcome
            : 'absent'
        : phase === 'prepared' || phase === 'credential-staged' || phase === 'settings-applied' || phase === 'credential-applied'
            ? phase
            : 'absent';
    if (state === 'absent') {
        remoteFailure('provider-transaction-in-doubt', 'provider transaction journal is unreadable', {
            provider: request.provider,
            transactionId: request.transactionId,
        });
    }
    const plan = isRecord(payload.plan) ? payload.plan : undefined;
    const credential = plan !== undefined && isCredentialPlan(plan.credential) ? plan.credential : undefined;
    let needsCredential = phase !== 'done' && credential?.op === 'set';
    if (needsCredential && credential !== undefined) {
        const current = await credentials.resolve(remoteCredentialRef(credential.ref));
        needsCredential = current === undefined || hash(current.value) !== credential.valueDigest;
    }
    return {
        state,
        needsCredential,
        ...typeof payload.settingsNs === 'string' ? { settingsNs: payload.settingsNs } : {},
        ...phase === 'done' ? { live: outcome === 'committed' && runtime.listProviders().some(row => row.id === request.provider) } : {},
    };
}
/**
 * Resume a durable provider transaction without asking the caller to rebuild its settings operations.
 * @param runtime - Provider and model registry receiving the resumed commit.
 * @param ctx - Host context containing settings and secure credential services.
 * @param request - Provider id, transaction UUID, and optional credential replay.
 * @param signal - Cancellation before a durable claim; claimed work keeps ownership until settled.
 * @returns Committed provider mutation view or the journal's terminal failure.
 */
export async function resumeRemoteProvider(runtime, ctx, request, signal) {
    if (!PROVIDER_PATTERN.test(request.provider) || !UUID_PATTERN.test(request.transactionId)) {
        remoteFailure('input-invalid', 'provider transaction resume needs a valid provider and UUID', {});
    }
    const credentials = ctx.get('credentials');
    if (credentials === undefined)
        remoteFailure('service-unavailable', 'credentials service is absent', {});
    return withProviderExecution(credentials, request.provider, signal, () => readAndResumeProvider(runtime, ctx, credentials, request, signal));
}
/** Read recovery metadata only after owning its provider journal. */
async function readAndResumeProvider(runtime, ctx, credentials, request, signal) {
    const record = await readProviderJournal(credentials, request.provider);
    const journal = parseJournal(record, request.provider, request.transactionId);
    if (journal.transactionId !== request.transactionId || journal.provider !== request.provider) {
        remoteFailure('provider-transaction-in-doubt', 'the requested provider transaction is not current', {
            provider: request.provider,
            transactionId: request.transactionId,
        });
    }
    const settings = ctx.get('settings');
    if (settings === undefined)
        remoteFailure('service-unavailable', 'settings service is absent', {});
    const ns = remoteSettingsNamespace(journal.settingsNs);
    return withTransactionKeys(settings, [`namespace:${journal.settingsNs}`], () => {
        assertProviderNotCancelled(signal);
        const current = settings.describe().find(candidate => candidate.ns === ns);
        const refs = transactionCredentialRefs(current?.value, journal.plan.ops, journal.plan.settingsPath, journal.plan.credential?.ref);
        return withTransactionKeys(credentials, [...refs].map(ref => `reference:${ref}`), () => resumeProviderJournal(runtime, settings, credentials, request, journal, refs, signal));
    });
}
/** Resolve a replay secret and complete recovery within all three resource tiers. */
async function resumeProviderJournal(runtime, settings, credentials, request, journal, refs, signal) {
    assertProviderNotCancelled(signal);
    if (journal.phase === 'done') {
        requireCommittedJournal(journal, request.provider, request.transactionId);
        const ns = remoteSettingsNamespace(journal.settingsNs);
        const ref = journal.plan.credential === undefined
            ? undefined
            : remoteCredentialRef(journal.plan.credential.ref);
        return remoteMutationResult(runtime, settings, credentials, ns, journal.provider, journal.settingsNs, ref);
    }
    const credentialPlan = journal.plan.credential;
    let credential;
    if (credentialPlan?.op === 'unset') {
        credential = { op: 'unset', ref: credentialPlan.ref };
    }
    else if (credentialPlan?.op === 'set') {
        const ref = remoteCredentialRef(credentialPlan.ref);
        const current = await credentials.resolve(ref);
        const value = request.credentialValue
            ?? (current !== undefined && hash(current.value) === credentialPlan.valueDigest ? current.value : undefined);
        if (value === undefined || hash(value) !== credentialPlan.valueDigest) {
            remoteFailure('provider-transaction-needs-credential', 'the durable provider transaction needs its write-only credential again', {
                provider: request.provider,
                transactionId: request.transactionId,
                ref: credentialPlan.ref,
            });
        }
        credential = { op: 'set', ref: credentialPlan.ref, value };
    }
    return mutateProviderRequest(runtime, settings, credentials, {
        transactionId: journal.transactionId,
        provider: journal.provider,
        settingsNs: journal.settingsNs,
        ops: journal.plan.ops,
        expectedRevision: journal.plan.expectedRevision,
        ...credential === undefined ? {} : { credential },
    }, journal, signal, refs);
}
/**
 * Run one bounded exact-route request without exposing provider output.
 * @param runtime - Provider registry that performs the exact model verification.
 * @param request - Provider/model route to probe.
 * @param signal - Caller cancellation combined with the fixed verification deadline.
 * @returns Verification mode and accepted state; model output is discarded.
 */
export async function verifyRemoteProvider(runtime, request, signal) {
    if (!PROVIDER_PATTERN.test(request.provider) || request.model.trim().length === 0) {
        remoteFailure('input-invalid', 'provider verification needs a valid provider and model', {});
    }
    const deadline = AbortSignal.timeout(PROVIDER_VERIFY_TIMEOUT_MS);
    const bounded = AbortSignal.any([signal, deadline]);
    let mode;
    try {
        mode = await runtime.verifyModel(request.provider, request.model, bounded);
    }
    catch (error) {
        const code = error?.code;
        if (code === 'VERIFICATION_STILL_RUNNING') {
            remoteFailure('provider-verification-still-running', 'provider verification ignored cancellation and remains owner-tracked', {
                provider: request.provider,
                model: request.model,
                state: 'still-running',
            });
        }
        if (signal.aborted)
            remoteFailure('cancelled', 'provider verification was cancelled', {});
        if (deadline.aborted)
            remoteFailure('provider-verification-timeout', 'provider verification timed out', {
                provider: request.provider,
                model: request.model,
            });
        if (isTypertRemoteFailure(error))
            throw error;
        remoteFailure('provider-verification-failed', 'provider/model authentication verification failed', {
            provider: request.provider,
            model: request.model,
        });
    }
    return mode === 'endpoint-catalog'
        ? {
            provider: request.provider,
            model: request.model,
            verified: false,
            mode,
            classification: 'reachability-only',
        }
        : { provider: request.provider, model: request.model, verified: true, mode };
}
/**
 * Commit a provider configuration change with a secret-free durable retry receipt.
 * @param runtime - Provider registry used for ownership and activation checks.
 * @param ctx - Host settings and credential service owners.
 * @param request - Provider mutation with its expected settings revision and transaction id.
 * @param signal - Cancellation before durable claim; late cancellation does not interrupt commit.
 * @returns The committed redacted view, or a typed conflict, cancellation or recovery failure.
 */
export async function mutateRemoteProvider(runtime, ctx, request, signal) {
    validateProviderRequest(request);
    const settings = ctx.get('settings');
    if (settings === undefined)
        remoteFailure('service-unavailable', 'settings service is absent', {});
    const credentials = ctx.get('credentials');
    if (credentials === undefined)
        remoteFailure('service-unavailable', 'credentials service is absent', {});
    return withProviderExecution(credentials, request.provider, signal, () => withTransactionKeys(settings, [`namespace:${request.settingsNs}`], () => mutateProviderRequest(runtime, settings, credentials, request, undefined, signal)));
}
/** Share mutation admission while preserving an explicit resume's original journal. */
async function mutateProviderRequest(runtime, settings, credentials, request, journalSnapshot, signal, heldRefs) {
    assertProviderNotCancelled(signal);
    validateProviderRequest(request);
    const ns = remoteSettingsNamespace(request.settingsNs);
    const declaration = runtime.listConfigurableProviders().find(entry => entry.provider === request.provider && entry.settingsNs === request.settingsNs);
    if (declaration === undefined) {
        remoteFailure('settings-rejected', `provider "${request.provider}" is not declared by settings namespace "${request.settingsNs}"`, {
            ns: request.settingsNs,
        });
    }
    const before = settings.describe().find(candidate => candidate.ns === ns);
    if (before === undefined) {
        remoteFailure('settings-rejected', `settings namespace "${request.settingsNs}" is not registered`, { ns: request.settingsNs });
    }
    const replay = await endpointMutationReplay(credentials, declaration, request, journalSnapshot);
    const stagedRequest = replay?.request ?? endpointBoundMutationRequest(declaration, before.value, request);
    validateProviderRequest(stagedRequest);
    const plan = replay?.plan ?? {
        ...mutationPlan(declaration.settingsPath, stagedRequest),
        ...stagedRequest === request ? {} : {
            requestDigest: mutationDigest(request.provider, request.settingsNs, mutationPlan(declaration.settingsPath, request)),
        },
    };
    const refs = transactionCredentialRefs(before.value, stagedRequest.ops, declaration.settingsPath, stagedRequest.credential?.ref);
    if (request.credential !== undefined)
        refs.add(request.credential.ref);
    const execute = () => {
        assertProviderNotCancelled(signal);
        if (replay?.phase !== 'done') {
            validateProviderOwnership(declaration.settingsPath, before.value, stagedRequest);
            validateCredentialScope(runtime, settings, declaration, before.value, stagedRequest);
            validateProviderSecrets(settings, ns, stagedRequest);
        }
        return mutateProviderTransaction(runtime, settings, credentials, ns, stagedRequest, plan, replay?.phase, signal);
    };
    if (heldRefs !== undefined) {
        if ([...refs].some(ref => !heldRefs.has(ref))) {
            remoteFailure('provider-transaction-in-doubt', 'provider resume reference ownership changed before commit', { provider: request.provider });
        }
        return execute();
    }
    return withTransactionKeys(credentials, [...refs].map(ref => `reference:${ref}`), execute);
}
async function mutateProviderTransaction(runtime, settings, credentials, ns, request, plan, replay, signal) {
    const credential = request.credential;
    const ref = credential === undefined ? undefined : remoteCredentialRef(credential.ref);
    if (replay !== 'done' && credential !== undefined && ref !== undefined) {
        await ensureWritableCredential(credentials, ref, credential.ref);
    }
    const digest = mutationDigest(request.provider, request.settingsNs, plan);
    // The journal belongs to the LLM Remote domain, not to the retired compatibility
    // service and not to an adapter's actual grant record.
    const journalKey = credentialKey('llm-remote', request.provider);
    const proposed = {
        version: 1,
        transactionId: request.transactionId,
        digest,
        provider: request.provider,
        settingsNs: request.settingsNs,
        plan,
        phase: 'prepared',
    };
    let journal;
    // Once a durable claim starts, finish its existing commit/recovery protocol.
    // A late caller abort must not release the lease while side effects still run.
    assertProviderNotCancelled(signal);
    try {
        journal = await claimJournal(credentials, journalKey, proposed, request, replay);
    }
    catch (error) {
        if (isTypertRemoteFailure(error))
            throw error;
        if (isRemoteFailure(error))
            throwRemoteFailure(error);
        remoteFailure('provider-transaction-in-doubt', 'provider transaction journal could not be acquired', {
            provider: request.provider,
            transactionId: request.transactionId,
        });
    }
    if (journal.phase === 'done') {
        requireCommittedJournal(journal, request.provider, request.transactionId);
        return remoteMutationResult(runtime, settings, credentials, ns, request.provider, request.settingsNs, ref);
    }
    let active = journal;
    if (replay === undefined) {
        const current = settings.describe().find(candidate => candidate.ns === ns);
        if (current === undefined) {
            remoteFailure('provider-transaction-in-doubt', `settings namespace "${request.settingsNs}" disappeared before provider mutation`, {
                provider: request.provider,
                transactionId: request.transactionId,
            });
        }
        if (current.revision !== active.plan.expectedRevision) {
            await rejectProviderRevision(credentials, journalKey, active, ns, current.revision);
        }
    }
    if (active.phase === 'prepared' && active.plan.credential?.op === 'set') {
        await applyCredentialPlan(credentials, active, request.credential);
        active = { ...active, phase: 'credential-staged' };
        try {
            await writeJournal(credentials, journalKey, active);
        }
        catch {
            remoteFailure('provider-transaction-in-doubt', 'provider credential staging could not be journaled', {
                provider: request.provider,
                transactionId: request.transactionId,
            });
        }
    }
    if (active.phase === 'prepared' || active.phase === 'credential-staged') {
        const current = settings.describe().find(candidate => candidate.ns === ns);
        if (current === undefined) {
            remoteFailure('provider-transaction-in-doubt', `settings namespace "${request.settingsNs}" disappeared before provider mutation`, {
                provider: request.provider,
                transactionId: request.transactionId,
            });
        }
        let settingsCommitted = remoteOpsSatisfied(current.user, active.plan.ops);
        if (!settingsCommitted) {
            if (current.revision !== active.plan.expectedRevision) {
                await rejectProviderRevision(credentials, journalKey, active, ns, current.revision);
            }
            try {
                await settings.mutate(ns, active.plan.ops, active.plan.expectedRevision);
                settingsCommitted = true;
            }
            catch (error) {
                const after = settings.describe().find(candidate => candidate.ns === ns);
                settingsCommitted = after !== undefined && remoteOpsSatisfied(after.user, active.plan.ops);
                if (!settingsCommitted) {
                    const failure = settingsFailureValue(request.settingsNs, error);
                    try {
                        await finishJournal(credentials, journalKey, active, 'rolled-back', failure);
                    }
                    catch {
                        remoteFailure('provider-transaction-in-doubt', 'provider rollback receipt could not be persisted', {
                            provider: request.provider,
                            transactionId: request.transactionId,
                        });
                    }
                    throwRemoteFailure(failure);
                }
            }
        }
        active = { ...active, phase: 'settings-applied' };
        try {
            await writeJournal(credentials, journalKey, active);
        }
        catch {
            remoteFailure('provider-transaction-in-doubt', 'provider settings commit could not be journaled', {
                provider: request.provider,
                transactionId: request.transactionId,
            });
        }
    }
    if (active.phase === 'settings-applied') {
        if (active.plan.credential !== undefined) {
            // Set credentials were staged before the settings switch; an unset is
            // intentionally delayed until the live profile no longer references it.
            await applyCredentialPlan(credentials, active, request.credential);
            active = { ...active, phase: 'credential-applied' };
            try {
                await writeJournal(credentials, journalKey, active);
            }
            catch {
                remoteFailure('provider-transaction-in-doubt', 'provider credential commit could not be journaled', {
                    provider: request.provider,
                    transactionId: request.transactionId,
                });
            }
        }
    }
    const committed = postWriteNamespace(settings, ns, request.settingsNs);
    let accepted = false;
    try {
        accepted = await settings.settle(ns, committed.revision);
    }
    catch (error) {
        const failure = settingsFailureValue(request.settingsNs, error);
        await finishOrInDoubt(credentials, journalKey, active, 'committed-not-live', failure);
        throwRemoteFailure(failure);
    }
    if (!accepted || !runtime.listProviders().some(provider => provider.id === request.provider)) {
        const failure = {
            code: 'provider-registration-rejected',
            message: `provider "${request.provider}" settings were stored but its live route rejected the configuration`,
            details: { provider: request.provider, transactionId: request.transactionId },
        };
        await finishOrInDoubt(credentials, journalKey, active, 'committed-not-live', failure);
        throwRemoteFailure(failure);
    }
    await finishOrInDoubt(credentials, journalKey, active, 'committed');
    return remoteMutationResult(runtime, settings, credentials, ns, request.provider, request.settingsNs, ref);
}
/** Reuse the durable conflict receipt both before staging and after external drift. */
async function rejectProviderRevision(credentials, key, active, ns, revision) {
    const failure = settingsFailureValue(active.settingsNs, new SettingsConflictError(ns, active.plan.expectedRevision, revision));
    try {
        await finishJournal(credentials, key, active, 'rolled-back', failure);
    }
    catch {
        remoteFailure('provider-transaction-in-doubt', 'provider stale-write receipt could not be persisted', {
            provider: active.provider,
            transactionId: active.transactionId,
        });
    }
    throwRemoteFailure(failure);
}
async function remoteMutationResult(runtime, settings, credentials, ns, provider, nsName, ref) {
    if (!runtime.listProviders().some(entry => entry.id === provider)) {
        remoteFailure('provider-registration-rejected', 'committed provider route is not live', { ns: nsName });
    }
    const info = ref === undefined ? undefined : await credentials.describe(ref);
    return {
        settings: postWriteNamespace(settings, ns, nsName),
        ...info === undefined ? {} : { credential: {
                configured: info.configured,
                ...info.source === undefined ? {} : { source: info.source },
                writable: info.writable,
            } },
        live: { accepted: true },
    };
}
function postWriteNamespace(settings, ns, nsName) {
    const descriptor = settings.describe({ redactSecrets: true }).find(candidate => candidate.ns === ns);
    if (descriptor === undefined)
        remoteFailure('internal', `settings namespace "${nsName}" was disposed after its write`, {});
    return remoteNamespaceView(descriptor);
}
/**
 * Canonical provider/model projection shared by every catalog caller.
 * @param model - Declared model identity and display metadata.
 * @param resolved - Adapter-resolved limits and reasoning capabilities.
 * @returns Client-safe model view with normalized string reasoning ids.
 */
export function projectRemoteModel(model, resolved) {
    const reasoning = resolved.reasoning === undefined
        ? undefined
        : {
            efforts: resolved.reasoning.efforts.map(effort => ({
                id: String(effort.id),
                name: effort.name,
                ...effort.description === undefined ? {} : { description: effort.description },
            })),
            ...resolved.reasoning.defaultEffort === undefined ? {} : { defaultEffort: String(resolved.reasoning.defaultEffort) },
        };
    return {
        id: model.id,
        name: model.name,
        ...model.description === undefined ? {} : { description: model.description },
        ...resolved.defaultMaxTokens === undefined ? {} : { defaultMaxTokens: resolved.defaultMaxTokens },
        ...reasoning === undefined ? {} : { reasoning },
    };
}
function remoteDiscoveredModel(model) {
    return {
        id: model.id,
        ...model.name === undefined ? {} : { name: model.name },
        ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
        ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
    };
}
function validateProviderRequest(request) {
    if (!UUID_PATTERN.test(request.transactionId)) {
        remoteFailure('input-invalid', 'provider mutation transactionId must be a UUID', { field: 'transactionId' });
    }
    if (!PROVIDER_PATTERN.test(request.provider)) {
        remoteFailure('input-invalid', 'provider mutation provider must be lower-kebab-case', { field: 'provider' });
    }
    if (request.settingsNs.length === 0) {
        remoteFailure('input-invalid', 'provider mutation settingsNs must be non-empty', { field: 'settingsNs' });
    }
    if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0) {
        remoteFailure('input-invalid', 'provider mutation expectedRevision must be a non-negative safe integer', { field: 'expectedRevision' });
    }
    if (!Array.isArray(request.ops) || request.ops.length > 64) {
        remoteFailure('input-invalid', 'provider mutation ops must contain at most 64 operations', { field: 'ops' });
    }
    if (request.ops.length === 0 && request.credential === undefined) {
        remoteFailure('settings-rejected', 'provider mutation must change settings, a credential, or both', { ns: request.settingsNs });
    }
    for (const op of request.ops) {
        if (!isSettingsPathOperation(op)) {
            remoteFailure('input-invalid', 'provider mutation operations must carry an op and string path', { field: 'ops' });
        }
    }
    if (remoteOpsOverlap(request.ops)) {
        remoteFailure('settings-rejected', 'provider mutation paths must not overlap', { ns: request.settingsNs });
    }
    if (request.credential?.op === 'set' && request.credential.value.trim().length === 0) {
        remoteFailure('input-invalid', 'provider credential value must be non-empty', { field: 'credential.value' });
    }
    if (request.credential !== undefined)
        remoteCredentialRef(request.credential.ref);
}
/** Reuse a claimed endpoint generation for exact retries and durable resumes. */
async function endpointMutationReplay(credentials, declaration, request, journalSnapshot) {
    const record = journalSnapshot === undefined
        ? await readProviderJournal(credentials, request.provider)
        : { kind: 'grant', payload: journalSnapshot };
    const payload = record?.kind === 'grant' && isRecord(record.payload) ? record.payload : undefined;
    // Validate request-bound legacy digests before endpoint normalization;
    // claimJournal remains responsible for persisting their durable-plan upgrade.
    if (payload?.transactionId !== request.transactionId)
        return undefined;
    const journal = parseJournal(record, request.provider, request.transactionId, request, declaration.settingsPath);
    const { requestDigest, ...durableInput } = journal.plan;
    const inputDigest = mutationDigest(request.provider, request.settingsNs, mutationPlan(declaration.settingsPath, request));
    if (journal.provider !== request.provider
        || journal.settingsNs !== request.settingsNs
        || !deepEqualJson(journal.plan.settingsPath, declaration.settingsPath)
        || (payload.plan !== undefined && mutationDigest(journal.provider, journal.settingsNs, journal.plan) !== journal.digest)
        || (inputDigest !== requestDigest && inputDigest !== mutationDigest(journal.provider, journal.settingsNs, durableInput))) {
        remoteFailure('provider-transaction-in-doubt', 'provider transaction retry does not match its durable endpoint plan', {
            provider: request.provider,
            transactionId: request.transactionId,
        });
    }
    const credential = journal.plan.credential;
    if (credential?.op !== request.credential?.op) {
        remoteFailure('provider-transaction-in-doubt', 'provider transaction retry changed its credential operation', {
            provider: request.provider,
            transactionId: request.transactionId,
        });
    }
    return {
        request: {
            ...request,
            ops: journal.plan.ops,
            expectedRevision: journal.plan.expectedRevision,
            ...request.credential === undefined || credential === undefined
                ? {}
                : { credential: { ...request.credential, ref: credential.ref } },
        },
        plan: journal.plan,
        phase: journal.phase,
    };
}
/**
 * Repointing an endpoint never overwrites the credential reference the old
 * live generation still reads. A deterministic transaction-scoped reference
 * is staged first, and the settings switch later points every matching profile
 * slot at that new version.
 */
function endpointBoundMutationRequest(declaration, currentValue, request) {
    if (request.credential?.op !== 'set')
        return request;
    const candidateValue = applyRemoteOps(currentValue, request.ops);
    const beforeFingerprint = providerEndpointFingerprint(declaration, currentValue);
    const afterFingerprint = providerEndpointFingerprint(declaration, candidateValue);
    if (beforeFingerprint === afterFingerprint)
        return request;
    if (!providerCredentialRefs(currentValue, declaration.settingsPath).has(request.credential.ref))
        return request;
    const versionRef = endpointBoundCredentialRef(declaration.provider, request.transactionId, afterFingerprint, request.credential.ref);
    const referencePaths = providerCredentialReferencePaths(candidateValue, declaration.settingsPath, request.credential.ref);
    const ops = request.ops.map(op => structuredClone(op));
    for (const referencePath of referencePaths) {
        const ownerIndex = ops.findIndex(op => pathStartsWith(referencePath, op.path));
        if (ownerIndex === -1) {
            ops.push({ op: 'set', path: referencePath, value: versionRef });
            continue;
        }
        const owner = ops[ownerIndex];
        if (owner === undefined)
            throw new Error('provider mutation owner index was lost');
        if (owner.op !== 'set') {
            remoteFailure('credential-version-required', 'endpoint change cannot inherit a credential through an unset profile ancestor', {
                provider: request.provider,
                ref: request.credential.ref,
            });
        }
        ops[ownerIndex] = {
            ...owner,
            value: setValueAtPath(owner.value, referencePath.slice(owner.path.length), versionRef),
        };
    }
    return {
        ...request,
        ops,
        credential: { op: 'set', ref: versionRef, value: request.credential.value },
    };
}
/** Deterministic, valid environment-style name for one endpoint generation. */
function endpointBoundCredentialRef(provider, transactionId, endpointFingerprint, sourceRef) {
    const providerName = provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
    const suffix = hash(JSON.stringify({ transactionId, endpointFingerprint, sourceRef })).slice(0, 24).toUpperCase();
    return `ARK_${providerName}_V_${suffix}`;
}
/** Absolute profile paths whose current value names one credential reference. */
function providerCredentialReferencePaths(root, settingsPath, ref) {
    const selected = pathValue(root, settingsPath);
    if (!selected.present || !isRecord(selected.value))
        return [];
    const paths = [];
    if (selected.value.apiKeyEnv === ref)
        paths.push([...settingsPath, 'apiKeyEnv']);
    if (isRecord(selected.value.credentialHeaders)) {
        for (const [header, value] of Object.entries(selected.value.credentialHeaders)) {
            if (value === ref)
                paths.push([...settingsPath, 'credentialHeaders', header]);
        }
    }
    return paths;
}
function setValueAtPath(root, path, value) {
    const [head, ...rest] = path;
    if (head === undefined)
        return value;
    const record = isRecord(root) ? root : {};
    return { ...record, [head]: setValueAtPath(record[head], rest, value) };
}
/** Read one secure provider journal without exposing a storage-specific failure. */
async function readProviderJournal(credentials, provider) {
    try {
        return await credentials.readRecord(credentialKey('llm-remote', provider));
    }
    catch {
        remoteFailure('service-unavailable', 'provider transaction journal is unavailable', {});
    }
}
/** Return only when a terminal journal committed; otherwise replay its durable failure. */
function requireCommittedJournal(journal, provider, transactionId) {
    if (journal.outcome === 'committed')
        return;
    throwRemoteFailure(journal.error ?? {
        code: journal.outcome === 'committed-not-live' ? 'provider-registration-rejected' : 'settings-rejected',
        message: 'provider transaction did not commit successfully',
        details: { provider, transactionId },
    });
}
/** Confine a provider transaction to its declared profile and credential. */
function validateProviderOwnership(settingsPath, currentValue, request) {
    for (const op of request.ops) {
        if (!pathStartsWith(op.path, settingsPath)) {
            remoteFailure('settings-rejected', `provider "${request.provider}" cannot mutate a sibling settings path`, {
                provider: request.provider,
                path: [...op.path],
            });
        }
    }
    const credential = request.credential;
    if (credential === undefined)
        return;
    const before = providerCredentialRefs(currentValue, settingsPath);
    const after = providerCredentialRefs(applyRemoteOps(currentValue, request.ops), settingsPath);
    if (credential.op === 'set') {
        if (!after.has(credential.ref)) {
            remoteFailure('credential-rejected', `provider "${request.provider}" credential is not bound to its resulting profile`, {
                provider: request.provider,
                ref: credential.ref,
            });
        }
        return;
    }
    if (!before.has(credential.ref) || after.has(credential.ref)) {
        remoteFailure('credential-rejected', `provider "${request.provider}" cannot unset an unrelated or still-referenced credential`, {
            provider: request.provider,
            ref: credential.ref,
        });
    }
}
/** Credential references named by one exact provider profile. */
function providerCredentialRefs(root, settingsPath) {
    const selected = pathValue(root, settingsPath);
    if (!selected.present || !isRecord(selected.value))
        return new Set();
    const refs = new Set();
    if (typeof selected.value.apiKeyEnv === 'string' && selected.value.apiKeyEnv.length > 0) {
        refs.add(selected.value.apiKeyEnv);
    }
    if (isRecord(selected.value.credentialHeaders)) {
        for (const ref of Object.values(selected.value.credentialHeaders)) {
            if (typeof ref === 'string' && ref.length > 0)
                refs.add(ref);
        }
    }
    return refs;
}
/**
 * Keep a credential reference bound to one provider and endpoint generation.
 * Repointing an endpoint or adopting another provider's reference requires the
 * write-only credential in the same transaction; a reference-only edit can
 * never disclose an existing secret to a new endpoint.
 */
function validateCredentialScope(runtime, settings, declaration, currentValue, request) {
    const descriptors = new Map(settings.describe().map(row => [String(row.ns), row.value]));
    const current = runtime.listConfigurableProviders().flatMap(entry => providerCredentialUses(entry, descriptors.get(entry.settingsNs)));
    const candidateValue = applyRemoteOps(currentValue, request.ops);
    const candidate = providerCredentialUses(declaration, candidateValue);
    const suppliedRef = request.credential?.op === 'set' ? request.credential.ref : undefined;
    for (const use of candidate) {
        const conflicts = current.filter(existing => existing.ref === use.ref
            && (existing.provider !== use.provider || existing.fingerprint !== use.fingerprint));
        const foreignProvider = conflicts.some(existing => existing.provider !== use.provider);
        if (foreignProvider || (conflicts.length > 0 && suppliedRef !== use.ref)) {
            remoteFailure('credential-ownership-rejected', `credential reference "${use.ref}" belongs to another provider or endpoint`, {
                provider: request.provider,
                ref: use.ref,
            });
        }
        const unchanged = current.some(existing => existing.ref === use.ref
            && existing.provider === use.provider
            && existing.fingerprint === use.fingerprint);
        if (!unchanged && suppliedRef !== use.ref) {
            remoteFailure('credential-ownership-required', `credential reference "${use.ref}" needs an explicit value for this provider endpoint`, {
                provider: request.provider,
                ref: use.ref,
            });
        }
    }
    if (request.credential?.op === 'unset') {
        const shared = current.some(use => use.ref === request.credential?.ref
            && (use.provider !== request.provider || candidate.some(next => next.ref === use.ref)));
        if (shared) {
            remoteFailure('credential-ownership-rejected', `credential reference "${request.credential.ref}" is still owned by a provider endpoint`, {
                provider: request.provider,
                ref: request.credential.ref,
            });
        }
    }
}
/** Extract only reference and endpoint ownership facts; never credential values. */
function providerCredentialUses(entry, root) {
    const selected = pathValue(root, entry.settingsPath);
    if (!selected.present || !isRecord(selected.value))
        return [];
    const profile = selected.value;
    const refs = new Set();
    if (typeof profile.apiKeyEnv === 'string' && profile.apiKeyEnv.length > 0)
        refs.add(profile.apiKeyEnv);
    if (isRecord(profile.credentialHeaders)) {
        for (const ref of Object.values(profile.credentialHeaders)) {
            if (typeof ref === 'string' && ref.length > 0)
                refs.add(ref);
        }
    }
    const fingerprint = providerEndpointFingerprint(entry, root);
    return [...refs].map(ref => ({ provider: entry.provider, ref, fingerprint }));
}
/** Identity of one provider's exact endpoint/protocol routing generation. */
function providerEndpointFingerprint(entry, root) {
    const selected = pathValue(root, entry.settingsPath);
    const profile = selected.present && isRecord(selected.value) ? selected.value : {};
    return hash(JSON.stringify({
        provider: entry.provider,
        settingsNs: entry.settingsNs,
        settingsPath: entry.settingsPath,
        baseURL: typeof profile.baseURL === 'string' ? profile.baseURL.replace(/\/+$/, '') : null,
        api: typeof profile.api === 'string' ? profile.api : null,
    }));
}
/** Refuse any operation that would copy a schema-declared secret into the journal. */
function validateProviderSecrets(settings, ns, request) {
    let secrets;
    try {
        secrets = settings.previewMutation(ns, request.ops).secrets;
    }
    catch (error) {
        remoteSettingsFailure(request.settingsNs, error);
    }
    const touchesSecret = request.ops.some(op => secrets.some(secret => pathStartsWith(op.path, secret.path) || pathStartsWith(secret.path, op.path)));
    if (touchesSecret) {
        remoteFailure('settings-rejected', 'provider settings transactions cannot carry literal secret fields; use credential references', {
            provider: request.provider,
            ns: request.settingsNs,
        });
    }
}
/** Whether `path` is the declared profile itself or one of its descendants. */
function pathStartsWith(path, prefix) {
    return prefix.length <= path.length && prefix.every((part, index) => path[index] === part);
}
/** Apply already-validated Remote path operations to a detached JSON value. */
function applyRemoteOps(root, ops) {
    return ops.reduce((current, op) => applyRemoteOp(current, op, op.path), structuredClone(root ?? {}));
}
/** Immutable path update used only for credential/profile ownership preflight. */
function applyRemoteOp(root, op, path) {
    const [head, ...rest] = path;
    if (head === undefined)
        return op.op === 'unset' ? {} : structuredClone(op.value);
    const record = isRecord(root) ? root : {};
    if (rest.length === 0) {
        if (op.op === 'set')
            return { ...record, [head]: structuredClone(op.value) };
        const { [head]: _removed, ...kept } = record;
        return kept;
    }
    const child = record[head];
    if (op.op === 'unset' && !isRecord(child))
        return record;
    return { ...record, [head]: applyRemoteOp(child, op, rest) };
}
/** Produce the secret-free durable transaction plan. */
function mutationPlan(settingsPath, request) {
    let ops;
    try {
        const encoded = JSON.stringify(request.ops);
        ops = JSON.parse(encoded);
        if (!deepEqualJson(ops, request.ops))
            throw new TypeError('not lossless JSON');
    }
    catch {
        remoteFailure('input-invalid', 'provider mutation operations must contain only lossless JSON values', { field: 'ops' });
    }
    const credential = request.credential === undefined
        ? undefined
        : request.credential.op === 'set'
            ? { op: 'set', ref: request.credential.ref, valueDigest: hash(request.credential.value) }
            : { op: 'unset', ref: request.credential.ref };
    return {
        settingsPath: [...settingsPath],
        ops,
        expectedRevision: request.expectedRevision,
        ...credential === undefined ? {} : { credential },
    };
}
async function ensureWritableCredential(credentials, ref, displayRef) {
    try {
        const info = await credentials.describe(ref);
        if (!info.writable) {
            remoteFailure('credential-rejected', `credential ${displayRef} is supplied by a read-only source`, { ref: displayRef });
        }
    }
    catch (error) {
        if (isTypertRemoteFailure(error))
            throw error;
        if (isRemoteFailure(error))
            throwRemoteFailure(error);
        remoteFailure('credential-rejected', `credential "${displayRef}" was rejected`, { ref: displayRef });
    }
}
/** Reach one journaled credential state without ever persisting its value. */
async function applyCredentialPlan(credentials, active, supplied) {
    const plan = active.plan.credential;
    if (plan === undefined)
        return;
    const ref = remoteCredentialRef(plan.ref);
    if (plan.op === 'unset') {
        if (!await credentialMatches(credentials, ref, undefined)) {
            try {
                await credentials.unset(ref);
            }
            catch {
                if (!await credentialMatches(credentials, ref, undefined)) {
                    remoteFailure('provider-transaction-in-doubt', `credential "${plan.ref}" did not reach its requested state`, {
                        provider: active.provider,
                        transactionId: active.transactionId,
                    });
                }
            }
        }
        return;
    }
    const current = await credentials.resolve(ref);
    if (current !== undefined && hash(current.value) === plan.valueDigest)
        return;
    if (supplied?.op !== 'set' || supplied.ref !== plan.ref || hash(supplied.value) !== plan.valueDigest) {
        remoteFailure('provider-transaction-needs-credential', 'the durable provider transaction needs its write-only credential again', {
            provider: active.provider,
            transactionId: active.transactionId,
            ref: plan.ref,
        });
    }
    try {
        await credentials.set(ref, supplied.value);
    }
    catch {
        const after = await credentials.resolve(ref);
        if (after === undefined || hash(after.value) !== plan.valueDigest) {
            remoteFailure('provider-transaction-in-doubt', `credential "${plan.ref}" did not reach its requested state`, {
                provider: active.provider,
                transactionId: active.transactionId,
            });
        }
    }
}
async function finishOrInDoubt(credentials, key, active, outcome, error) {
    try {
        await finishJournal(credentials, key, active, outcome, error);
    }
    catch {
        remoteFailure('provider-transaction-in-doubt', 'provider terminal receipt could not be persisted', {
            provider: active.provider,
            transactionId: active.transactionId,
        });
    }
}
function remoteSettingsNamespace(value) {
    try {
        return settingsNamespace(value);
    }
    catch (error) {
        remoteSettingsFailure(value, error);
    }
}
function remoteCredentialRef(value) {
    try {
        return credentialRef(value);
    }
    catch (error) {
        remoteFailure('input-invalid', errorMessage(error), { ref: value });
    }
}
function remoteSettingsFailure(ns, error) {
    throwRemoteFailure(settingsFailureValue(ns, error));
}
function settingsFailureValue(ns, error) {
    if (error instanceof SettingsConflictError) {
        return { code: 'settings-conflict', message: error.message, details: { ns, expected: error.expected, actual: error.actual } };
    }
    return { code: 'settings-rejected', message: `settings write for "${ns}" was rejected`, details: { ns } };
}
function remoteOpsOverlap(ops) {
    return ops.some((left, index) => ops.some((right, otherIndex) => {
        if (index === otherIndex)
            return false;
        const shortest = Math.min(left.path.length, right.path.length);
        return left.path.length <= right.path.length
            && left.path.slice(0, shortest).every((segment, part) => segment === right.path[part]);
    }));
}
function remoteOpsSatisfied(user, ops) {
    return ops.every((op) => {
        if (op.op === 'unset' && op.path.length === 0)
            return user === undefined || deepEqualJson(user, {});
        const current = pathValue(user, op.path);
        return op.op === 'unset'
            ? !current.present
            : current.present && deepEqualJson(current.value, op.value);
    });
}
function pathValue(root, path) {
    if (path.length === 0)
        return root === undefined ? { present: false } : { present: true, value: root };
    let current = root;
    for (const part of path) {
        if (!isRecord(current) || !Object.hasOwn(current, part))
            return { present: false };
        current = current[part];
    }
    return { present: true, value: current };
}
function mutationDigest(provider, settingsNs, plan) {
    return hash(JSON.stringify({
        provider,
        settingsNs,
        settingsPath: plan.settingsPath,
        ops: plan.ops,
        credential: plan.credential,
        requestDigest: plan.requestDigest,
    }));
}
function hash(value) {
    return createHash('sha256').update(value).digest('hex');
}
async function claimJournal(credentials, key, proposed, request, replay) {
    let selected;
    await credentials.modifyRecord(key, (current) => {
        const currentPayload = current?.kind === 'grant' && isRecord(current.payload) ? current.payload : undefined;
        if (replay !== undefined && currentPayload?.transactionId !== proposed.transactionId) {
            remoteFailure('provider-transaction-in-doubt', 'provider transaction ownership changed before replay claim', {
                provider: proposed.provider,
                transactionId: proposed.transactionId,
            });
        }
        if (current === undefined) {
            selected = proposed;
            return Promise.resolve({ kind: 'grant', payload: proposed });
        }
        const journal = parseJournal(current, proposed.provider, proposed.transactionId, request, proposed.plan.settingsPath);
        if (replay === 'done' && journal.phase !== 'done') {
            remoteFailure('provider-transaction-in-doubt', 'completed provider transaction became active before receipt replay', {
                provider: proposed.provider,
                transactionId: proposed.transactionId,
            });
        }
        if (journal.transactionId === proposed.transactionId) {
            if (mutationDigest(journal.provider, journal.settingsNs, journal.plan) !== proposed.digest) {
                remoteFailure('provider-transaction-in-doubt', 'provider transaction id was reused with different input', {
                    provider: proposed.provider,
                    transactionId: proposed.transactionId,
                });
            }
            if (journal.digest !== proposed.digest) {
                if (currentPayload?.plan !== undefined) {
                    remoteFailure('provider-transaction-in-doubt', 'provider transaction journal digest does not match its durable plan', {
                        provider: proposed.provider,
                        transactionId: proposed.transactionId,
                    });
                }
                const upgraded = { ...journal, digest: proposed.digest };
                selected = upgraded;
                return Promise.resolve({ kind: 'grant', payload: upgraded });
            }
            selected = journal;
            return Promise.resolve(undefined);
        }
        if (journal.phase !== 'done') {
            remoteFailure('provider-transaction-in-doubt', 'provider already has an unfinished configuration transaction', {
                provider: proposed.provider,
                transactionId: proposed.transactionId,
            });
        }
        selected = proposed;
        return Promise.resolve({ kind: 'grant', payload: proposed });
    });
    if (selected === undefined) {
        remoteFailure('provider-transaction-in-doubt', 'provider transaction journal was not acquired', {
            provider: proposed.provider,
            transactionId: proposed.transactionId,
        });
    }
    return selected;
}
async function writeJournal(credentials, key, next) {
    await credentials.modifyRecord(key, (current) => {
        const journal = parseJournal(current, next.provider, next.transactionId);
        if (journal.transactionId !== next.transactionId
            || journal.digest !== next.digest
            || mutationDigest(journal.provider, journal.settingsNs, journal.plan) !== journal.digest) {
            remoteFailure('provider-transaction-in-doubt', 'provider transaction ownership changed during commit', {
                provider: next.provider,
                transactionId: next.transactionId,
            });
        }
        return Promise.resolve({ kind: 'grant', payload: next });
    });
}
async function finishJournal(credentials, key, active, outcome, error) {
    const done = {
        version: 1,
        transactionId: active.transactionId,
        digest: active.digest,
        provider: active.provider,
        settingsNs: active.settingsNs,
        plan: active.plan,
        phase: 'done',
        outcome,
        ...error === undefined ? {} : { error: secretFreeFailure(error) },
    };
    await writeJournal(credentials, key, done);
}
async function credentialMatches(credentials, ref, expected) {
    return (await credentials.resolve(ref))?.value === expected;
}
function parseJournal(record, provider, transactionId, request, settingsPath = []) {
    const payload = record?.kind === 'grant' && isRecord(record.payload) ? record.payload : undefined;
    if (payload === undefined
        || payload.version !== 1
        || typeof payload.transactionId !== 'string'
        || typeof payload.digest !== 'string'
        || typeof payload.provider !== 'string'
        || typeof payload.settingsNs !== 'string'
        || (payload.phase !== 'prepared'
            && payload.phase !== 'credential-staged'
            && payload.phase !== 'settings-applied'
            && payload.phase !== 'credential-applied'
            && payload.phase !== 'done')) {
        remoteFailure('provider-transaction-in-doubt', `provider "${provider}" has an unreadable secure transaction journal`, {
            provider,
            transactionId,
        });
    }
    if (payload.phase === 'done') {
        if (payload.outcome !== 'committed'
            && payload.outcome !== 'rolled-back'
            && payload.outcome !== 'committed-not-live') {
            remoteFailure('provider-transaction-in-doubt', `provider "${provider}" has an unreadable terminal transaction journal`, {
                provider,
                transactionId,
            });
        }
        const plan = parsePlan(payload.plan, payload, request, settingsPath, provider, transactionId);
        return {
            version: 1,
            transactionId: payload.transactionId,
            digest: payload.digest,
            provider: payload.provider,
            settingsNs: payload.settingsNs,
            plan,
            phase: 'done',
            outcome: payload.outcome,
            ...isRemoteFailure(payload.error) ? { error: secretFreeFailure(payload.error) } : {},
        };
    }
    const plan = parsePlan(payload.plan, payload, request, settingsPath, provider, transactionId);
    return {
        version: 1,
        transactionId: payload.transactionId,
        digest: payload.digest,
        provider: payload.provider,
        settingsNs: payload.settingsNs,
        plan,
        phase: payload.phase,
    };
}
/** Parse a current plan, or safely upgrade an earlier request-bound journal. */
function parsePlan(value, legacy, request, settingsPath, provider, transactionId) {
    if (isRecord(value)
        && Array.isArray(value.settingsPath)
        && value.settingsPath.every(part => typeof part === 'string')
        && Array.isArray(value.ops)
        && value.ops.every(isSettingsPathOperation)
        && typeof value.expectedRevision === 'number'
        && Number.isSafeInteger(value.expectedRevision)
        && value.expectedRevision >= 0
        && (value.credential === undefined || isCredentialPlan(value.credential))
        && (value.requestDigest === undefined || (typeof value.requestDigest === 'string' && /^[a-f0-9]{64}$/.test(value.requestDigest)))) {
        return {
            settingsPath: [...value.settingsPath],
            ops: structuredClone(value.ops),
            expectedRevision: value.expectedRevision,
            ...value.credential === undefined ? {} : { credential: { ...value.credential } },
            ...value.requestDigest === undefined ? {} : { requestDigest: value.requestDigest },
        };
    }
    // Version-1 journals created before durable plans can be resumed only by an
    // exact retry carrying the original request. Never guess a secret or a path.
    if (request !== undefined && legacy.transactionId !== request.transactionId) {
        return { settingsPath: [], ops: [], expectedRevision: 0 };
    }
    if (request !== undefined) {
        const candidates = new Set();
        if (typeof legacy.expectedRevision === 'number' && Number.isSafeInteger(legacy.expectedRevision)) {
            candidates.add(legacy.expectedRevision);
        }
        candidates.add(request.expectedRevision);
        if (request.expectedRevision > 0)
            candidates.add(request.expectedRevision - 1);
        for (const expectedRevision of candidates) {
            if (expectedRevision < 0)
                continue;
            const plan = mutationPlan(settingsPath, { ...request, expectedRevision });
            const legacyDigest = hash(JSON.stringify({
                provider: request.provider,
                settingsNs: request.settingsNs,
                ops: request.ops,
                expectedRevision,
                credential: request.credential?.op === 'set'
                    ? { op: 'set', ref: request.credential.ref, valueDigest: hash(request.credential.value) }
                    : request.credential,
            }));
            if (legacy.digest === legacyDigest)
                return plan;
        }
    }
    remoteFailure('provider-transaction-in-doubt', `provider "${provider}" has a legacy transaction that needs an exact retry`, {
        provider,
        transactionId,
    });
}
function isCredentialPlan(value) {
    if (!isRecord(value) || typeof value.ref !== 'string')
        return false;
    return value.op === 'unset'
        ? value.valueDigest === undefined
        : value.op === 'set' && typeof value.valueDigest === 'string';
}
function secretFreeFailure(failure) {
    return {
        code: failure.code,
        message: failure.message,
        details: Object.fromEntries(Object.entries(failure.details).filter(([key]) => !/key|token|secret|password/i.test(key))),
    };
}
function isRemoteFailure(value) {
    return isRecord(value)
        && typeof value.code === 'string'
        && typeof value.message === 'string'
        && isRecord(value.details);
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** Read a mutable AbortSignal after an await without retaining stale flow narrowing. */
function isAborted(signal) {
    return signal.aborted;
}
/** Validate a path mutation at the Remote boundary before domain mutation sees it. */
function isSettingsPathOperation(value) {
    if (!isRecord(value))
        return false;
    return (value.op === 'set' || value.op === 'unset')
        && Array.isArray(value.path)
        && value.path.every(part => typeof part === 'string');
}
/** Preserve a typed Remote failure through the strict Gateway's Error-only control flow. */
function throwRemoteFailure(failure) {
    throw new TypertLookupFailure(failure);
}
function remoteFailure(code, message, details) {
    throwRemoteFailure({ code, message, details });
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=remote.js.map