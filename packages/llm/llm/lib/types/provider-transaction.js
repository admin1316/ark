/** Journaled Native provider writes; the Credential provider remains the only durable owner. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { isObject, symbols } from '@deepseek-ai/cordis';
import { CredentialConflictError, credentialCondition, credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials';
import { deepEqualJson, remoteNamespaceView, SettingsConflictError, settingsNamespace, snapshotSettingsJson } from '@deepseek-ai/dsh-settings';
import { TypertRemoteFailure } from '@deepseek-ai/dsh-typert-protocol';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PROVIDER = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const resourceTails = new WeakMap();
const execution = new AsyncLocalStorage();
/** Reserve each resource tier atomically: provider journal, namespace, then credential references. */
async function withResources(owner, keys, operation) {
    const original = Reflect.get(owner, symbols.original);
    const identity = isObject(original) ? original : owner;
    let tails = resourceTails.get(identity);
    if (tails === undefined) {
        tails = new Map();
        resourceTails.set(identity, tails);
    }
    const distinct = [...new Set(keys)];
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
        for (const key of distinct)
            if (tails.get(key) === lease.promise)
                tails.delete(key);
        if (tails.size === 0)
            resourceTails.delete(identity);
    }
}
function fail(code, message, details = {}) {
    throw new TypertRemoteFailure({ code, message, details });
}
function record(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function onlyFields(value, fields) {
    return Object.keys(value).every(key => fields.includes(key));
}
/** JSON object insertion order is not part of a Native request's identity; array order is. */
function hashJson(value) {
    return hash(JSON.stringify(value, (_key, item) => record(item)
        ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item));
}
function strings(value) {
    return Array.isArray(value) && value.every(part => typeof part === 'string');
}
function pathOp(value) {
    return record(value) && strings(value.path)
        && (value.op === 'unset' || (value.op === 'set' && Object.hasOwn(value, 'value')));
}
function pathOps(value) {
    return Array.isArray(value) && value.every(pathOp);
}
function canonicalOps(ops) {
    return ops.map(op => op.op === 'unset' ? { op: 'unset', path: [...op.path] }
        : { op: 'set', path: [...op.path], value: op.value });
}
function prefix(path, base) {
    return base.length <= path.length && base.every((part, index) => path[index] === part);
}
function ref(value) {
    try {
        return credentialRef(value);
    }
    catch {
        return fail('input-invalid', 'credential reference must be a valid environment name', { field: 'credential.ref' });
    }
}
function snapshot(value) {
    try {
        return snapshotSettingsJson(value);
    }
    catch {
        return fail('input-invalid', 'provider mutation must contain only lossless JSON data');
    }
}
function requestSnapshot(input) {
    const value = snapshot(input);
    if (!record(value) || typeof value.transactionId !== 'string' || !UUID.test(value.transactionId)
        || typeof value.provider !== 'string' || !PROVIDER.test(value.provider) || typeof value.settingsNs !== 'string'
        || typeof value.expectedRevision !== 'number' || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0
        || !pathOps(value.ops) || value.ops.length > 64) {
        return fail('input-invalid', 'provider mutation has invalid identity, revision, or operations');
    }
    try {
        settingsNamespace(value.settingsNs);
    }
    catch {
        return fail('input-invalid', 'provider mutation namespace is invalid', { field: 'settingsNs' });
    }
    const ops = canonicalOps(value.ops);
    if (ops.some((left, index) => ops.some((right, other) => index !== other && prefix(left.path, right.path)))) {
        return fail('settings-rejected', 'provider mutation paths must not overlap', { ns: value.settingsNs });
    }
    let credential;
    if (value.credential !== undefined) {
        const item = value.credential;
        if (!record(item) || typeof item.ref !== 'string')
            return fail('input-invalid', 'provider credential is invalid');
        ref(item.ref);
        if (item.op === 'unset')
            credential = { op: 'unset', ref: item.ref };
        else if (item.op === 'set' && typeof item.value === 'string' && item.value.trim().length > 0) {
            credential = { op: 'set', ref: item.ref, value: item.value };
        }
        else
            return fail('input-invalid', 'provider credential value or operation is invalid');
    }
    if (value.ops.length === 0 && credential === undefined)
        return fail('settings-rejected', 'provider mutation must change settings, a credential, or both');
    return { transactionId: value.transactionId, provider: value.provider, settingsNs: value.settingsNs,
        expectedRevision: value.expectedRevision, ops, ...credential === undefined ? {} : { credential } };
}
function transactionIdentity(input) {
    const value = snapshot(input);
    if (!record(value) || typeof value.provider !== 'string' || !PROVIDER.test(value.provider)
        || typeof value.transactionId !== 'string' || !UUID.test(value.transactionId)) {
        return fail('input-invalid', 'provider transaction needs a valid provider and UUID');
    }
    return { provider: value.provider, transactionId: value.transactionId };
}
function pathValue(value, path) {
    let current = value;
    for (const key of path) {
        if (!record(current) || !Object.hasOwn(current, key))
            return { present: false };
        current = current[key];
    }
    return current === undefined ? { present: false } : { present: true, value: current };
}
function edit(value, op, path = op.path) {
    const [head, ...rest] = path;
    if (head === undefined)
        return op.op === 'unset' ? {} : structuredClone(op.value);
    const source = record(value) ? value : {};
    if (rest.length === 0 && op.op === 'unset') {
        const { [head]: removed, ...kept } = source;
        void removed;
        return kept;
    }
    const child = Object.hasOwn(source, head) ? source[head] : undefined;
    if (rest.length > 0 && op.op === 'unset' && !record(child))
        return source;
    return { ...source, [head]: edit(child, op, rest) };
}
function apply(value, ops) {
    return ops.reduce((current, op) => edit(current, op), structuredClone(value ?? {}));
}
function satisfied(value, ops) {
    return ops.every((op) => {
        if (op.op === 'unset' && op.path.length === 0)
            return value === undefined || deepEqualJson(value, {});
        const current = pathValue(value, op.path);
        return op.op === 'unset' ? !current.present : current.present && deepEqualJson(current.value, op.value);
    });
}
function references(value, path) {
    const profile = pathValue(value, path).value;
    const refs = new Map();
    if (!record(profile))
        return refs;
    const add = (value, tail) => {
        if (typeof value !== 'string' || value === '')
            return;
        refs.set(value, [...refs.get(value) ?? [], [...path, ...tail]]);
    };
    add(profile.apiKeyEnv, ['apiKeyEnv']);
    if (record(profile.credentialHeaders))
        for (const [name, value] of Object.entries(profile.credentialHeaders))
            add(value, ['credentialHeaders', name]);
    return refs;
}
function fingerprint(provider, value) {
    const selected = pathValue(value, provider.settingsPath).value;
    const profile = record(selected) ? selected : {};
    return hash(JSON.stringify({ provider: provider.provider, settingsNs: provider.settingsNs, settingsPath: provider.settingsPath,
        baseURL: typeof profile.baseURL === 'string' ? profile.baseURL.replace(/\/+$/u, '') : null,
        api: typeof profile.api === 'string' ? profile.api : null }));
}
function makePlan(provider, value, request, configured) {
    const ops = request.ops.map(op => structuredClone(op));
    let credential = request.credential;
    const after = apply(value, ops);
    if (credential?.op === 'set' && (configured || references(value, provider.settingsPath).has(credential.ref))) {
        const name = provider.provider.toUpperCase().replace(/[^A-Z0-9]+/gu, '_');
        const suffix = hash(JSON.stringify({ transactionId: request.transactionId,
            endpointFingerprint: fingerprint(provider, after), sourceRef: credential.ref })).slice(0, 24).toUpperCase();
        const versionRef = `ARK_${name}_V_${suffix}`;
        for (const path of references(after, provider.settingsPath).get(credential.ref) ?? []) {
            const owner = ops.find((op) => op.op === 'set' && prefix(path, op.path));
            const replacement = { op: 'set', path, value: versionRef };
            if (owner === undefined)
                ops.push(replacement);
            else
                ops[ops.indexOf(owner)] = { ...owner, value: snapshot(edit(owner.value, replacement, path.slice(owner.path.length))) };
        }
        credential = { ...credential, ref: versionRef };
    }
    return { settingsPath: [...provider.settingsPath], ops, expectedRevision: request.expectedRevision,
        ...credential === undefined ? {} : { credential: credential.op === 'unset'
                ? { op: 'unset', ref: credential.ref } : { op: 'set', ref: credential.ref, valueDigest: hash(credential.value) } } };
}
function inputDigest(request) {
    return hashJson({ provider: request.provider, settingsNs: request.settingsNs, ops: request.ops,
        credential: request.credential?.op === 'set'
            ? { op: 'set', ref: request.credential.ref, valueDigest: hash(request.credential.value) } : request.credential });
}
function plannedInputDigest(provider, settingsNs, plan) {
    return hashJson({ provider, settingsNs, ops: plan.ops, credential: plan.credential });
}
function legacyPlanDigest(provider, settingsNs, plan) {
    return hash(JSON.stringify({ provider, settingsNs, settingsPath: plan.settingsPath,
        ops: plan.ops, credential: plan.credential, requestDigest: plan.requestDigest }));
}
function planDigest(provider, namespace, plan) {
    return hashJson({ provider, settingsNs: namespace, plan });
}
function isOutcome(value) {
    return value === 'committed' || value === 'rolled-back' || value === 'committed-not-live';
}
function isPhase(value) {
    return value === 'prepared' || value === 'credential-staged' || value === 'settings-applied'
        || value === 'credential-applied' || value === 'done';
}
function storedFailure(value) {
    if (value === undefined)
        return undefined;
    if (!record(value) || !record(value.details))
        return fail('provider-transaction-in-doubt', 'provider receipt failure is invalid');
    const details = value.details;
    if (value.code === 'credential-rejected' && typeof details.provider === 'string' && PROVIDER.test(details.provider)) {
        return { code: value.code, message: 'provider credential changed before commit', details: { provider: details.provider } };
    }
    if (value.code === 'settings-conflict' && typeof details.ns === 'string'
        && typeof details.expected === 'number' && Number.isSafeInteger(details.expected) && details.expected >= 0
        && typeof details.actual === 'number' && Number.isSafeInteger(details.actual) && details.actual >= 0) {
        return { code: value.code, message: 'provider settings revision changed', details: { ns: details.ns, expected: details.expected, actual: details.actual } };
    }
    if (value.code === 'settings-rejected' && typeof details.ns === 'string') {
        return { code: value.code, message: 'provider settings write was rejected', details: { ns: details.ns } };
    }
    if (value.code === 'provider-registration-rejected' && typeof details.provider === 'string' && PROVIDER.test(details.provider)) {
        return { code: value.code, message: 'provider settings were stored but did not activate', details: { provider: details.provider } };
    }
    return fail('provider-transaction-in-doubt', 'provider receipt failure is invalid');
}
function parseReceipt(value) {
    if (!record(value) || !onlyFields(value, ['requestDigest', 'legacyInput', 'outcome', 'error'])
        || typeof value.requestDigest !== 'string' || !SHA256.test(value.requestDigest) || !isOutcome(value.outcome)) {
        return fail('provider-transaction-in-doubt', 'provider receipt history is invalid');
    }
    const error = storedFailure(value.error);
    const legacyInput = parseLegacyInput(value.legacyInput);
    const identity = { requestDigest: value.requestDigest, ...legacyInput === undefined ? {} : { legacyInput } };
    if (value.outcome === 'committed') {
        if (error !== undefined)
            return fail('provider-transaction-in-doubt', 'provider receipt outcome is inconsistent');
        return { ...identity, outcome: value.outcome };
    }
    if (error === undefined)
        return fail('provider-transaction-in-doubt', 'provider receipt outcome is inconsistent');
    return { ...identity, outcome: value.outcome, error };
}
function parseLegacyInput(value) {
    if (value === undefined)
        return undefined;
    if (!record(value) || !onlyFields(value, ['settingsPath', 'digest'])
        || !strings(value.settingsPath) || typeof value.digest !== 'string' || !SHA256.test(value.digest)) {
        return fail('provider-transaction-in-doubt', 'provider legacy input binding is invalid');
    }
    return { settingsPath: value.settingsPath, digest: value.digest };
}
function parseJournal(input) {
    if (input === undefined)
        return undefined;
    if (input.kind !== 'grant')
        return fail('provider-transaction-in-doubt', 'provider journal has an unsupported record kind');
    let value;
    try {
        value = snapshotSettingsJson(input.payload);
    }
    catch {
        return fail('provider-transaction-in-doubt', 'provider journal is not valid JSON data');
    }
    if (!record(value) || value.version !== 1 || (value.receiptVersion !== undefined && value.receiptVersion !== 1)) {
        return fail('provider-transaction-in-doubt', 'provider journal format is unsupported');
    }
    const legacy = value.receiptVersion === undefined;
    if (!onlyFields(value, ['version', 'receiptVersion', 'transactionId', 'provider', 'settingsNs', 'requestDigest',
        'digest', 'plan', 'phase', 'completed', 'outcome', 'error', 'legacyInput'])) {
        return fail('provider-transaction-in-doubt', 'provider journal contains unsupported fields');
    }
    const plan = value.plan;
    if (typeof value.transactionId !== 'string' || !UUID.test(value.transactionId) || typeof value.provider !== 'string'
        || !PROVIDER.test(value.provider) || typeof value.settingsNs !== 'string'
        || typeof value.digest !== 'string' || !SHA256.test(value.digest)
        || !record(plan) || !onlyFields(plan, ['settingsPath', 'ops', 'expectedRevision', 'expectedUserDigest', 'requestDigest', 'credential'])
        || !strings(plan.settingsPath) || !pathOps(plan.ops)
        || typeof plan.expectedRevision !== 'number' || !Number.isSafeInteger(plan.expectedRevision) || plan.expectedRevision < 0) {
        return fail('provider-transaction-in-doubt', 'provider journal identity or plan is invalid');
    }
    if (legacy && plan.expectedUserDigest !== undefined)
        return fail('provider-transaction-in-doubt', 'legacy provider plan cannot assert a current before-image');
    try {
        settingsNamespace(value.settingsNs);
    }
    catch {
        return fail('provider-transaction-in-doubt', 'provider journal namespace is invalid');
    }
    for (const field of ['expectedUserDigest', 'requestDigest']) {
        if (plan[field] !== undefined && (typeof plan[field] !== 'string' || !SHA256.test(plan[field]))) {
            return fail('provider-transaction-in-doubt', 'provider plan binding is invalid');
        }
    }
    let credential;
    if (plan.credential !== undefined) {
        const data = plan.credential;
        if (!record(data) || !onlyFields(data, data.op === 'set' ? ['op', 'ref', 'valueDigest', 'before'] : ['op', 'ref', 'before'])
            || typeof data.ref !== 'string')
            return fail('provider-transaction-in-doubt', 'provider credential plan is invalid');
        try {
            credentialRef(data.ref);
        }
        catch {
            return fail('provider-transaction-in-doubt', 'provider credential reference is invalid');
        }
        if (data.op === 'unset')
            credential = { op: 'unset', ref: data.ref };
        else if (data.op === 'set' && typeof data.valueDigest === 'string' && SHA256.test(data.valueDigest)) {
            credential = { op: 'set', ref: data.ref, valueDigest: data.valueDigest };
        }
        else
            return fail('provider-transaction-in-doubt', 'provider credential plan is invalid');
        if (data.before !== undefined) {
            const before = data.before;
            if (legacy || !record(before) || !onlyFields(before, ['valueDigest', 'source'])
                || (before.valueDigest !== null && (typeof before.valueDigest !== 'string' || !SHA256.test(before.valueDigest)))
                || (before.source !== undefined && (typeof before.source !== 'string' || before.source.length === 0))
                || (before.valueDigest === null && before.source !== undefined)) {
                return fail('provider-transaction-in-doubt', 'provider credential before-image is invalid');
            }
            credential.before = { valueDigest: before.valueDigest, ...before.source === undefined ? {} : { source: before.source } };
        }
    }
    if (!isPhase(value.phase))
        return fail('provider-transaction-in-doubt', 'provider journal phase is invalid');
    const parsedPlan = { settingsPath: plan.settingsPath, ops: plan.ops, expectedRevision: plan.expectedRevision,
        ...typeof plan.expectedUserDigest === 'string' ? { expectedUserDigest: plan.expectedUserDigest } : {},
        ...typeof plan.requestDigest === 'string' ? { requestDigest: plan.requestDigest } : {},
        ...credential === undefined ? {} : { credential } };
    if (!deepEqualJson(plan.ops, canonicalOps(plan.ops)))
        return fail('provider-transaction-in-doubt', 'provider plan contains unsupported operation fields');
    const ops = parsedPlan.ops;
    if (ops.length === 0 && credential === undefined)
        return fail('provider-transaction-in-doubt', 'provider plan contains no operation');
    if (ops.length > 64 || ops.some((op, index) => ops.some((other, otherIndex) => index !== otherIndex && prefix(op.path, other.path))))
        return fail('provider-transaction-in-doubt', 'provider plan operations overlap or exceed the limit');
    const expectedDigest = legacy ? legacyPlanDigest(value.provider, value.settingsNs, parsedPlan)
        : planDigest(value.provider, value.settingsNs, parsedPlan);
    if (expectedDigest !== value.digest)
        return fail('provider-transaction-in-doubt', 'provider journal digest does not match its plan');
    const legacyInput = legacy ? { settingsPath: [...parsedPlan.settingsPath],
        digest: parsedPlan.requestDigest ?? legacyPlanDigest(value.provider, value.settingsNs, parsedPlan) }
        : parseLegacyInput(value.legacyInput);
    const requestDigest = legacy ? plannedInputDigest(value.provider, value.settingsNs, parsedPlan) : value.requestDigest;
    if (typeof requestDigest !== 'string' || !SHA256.test(requestDigest))
        return fail('provider-transaction-in-doubt', 'provider request binding is invalid');
    const completed = {};
    if (!legacy) {
        if (!record(value.completed))
            return fail('provider-transaction-in-doubt', 'provider receipt history is invalid');
        for (const [id, item] of Object.entries(value.completed)) {
            if (!UUID.test(id))
                return fail('provider-transaction-in-doubt', 'provider receipt history is invalid');
            completed[id] = parseReceipt(item);
        }
    }
    else if (value.completed !== undefined || value.requestDigest !== undefined || value.legacyInput !== undefined) {
        return fail('provider-transaction-in-doubt', 'provider journal mixes incompatible formats');
    }
    const error = value.error === undefined && legacy && value.phase === 'done' && value.outcome !== 'committed'
        ? value.outcome === 'committed-not-live'
            ? { code: 'provider-registration-rejected', message: 'provider settings were stored but did not activate', details: { provider: value.provider } }
            : { code: 'settings-rejected', message: 'provider settings write was rejected', details: { ns: value.settingsNs } }
        : storedFailure(value.error);
    const identity = { version: 1, receiptVersion: 1, transactionId: value.transactionId, provider: value.provider,
        settingsNs: value.settingsNs, requestDigest, digest: planDigest(value.provider, value.settingsNs, parsedPlan), plan: parsedPlan,
        ...legacyInput === undefined ? {} : { legacyInput }, completed };
    if (value.phase === 'done') {
        const receipt = parseReceipt({ requestDigest, outcome: value.outcome, error, legacyInput });
        if (legacy)
            completed[value.transactionId] = receipt;
        if (!deepEqualJson(completed[value.transactionId], receipt))
            return fail('provider-transaction-in-doubt', 'provider terminal receipt disagrees with its history');
        return { ...identity, ...receipt, phase: value.phase };
    }
    if (value.outcome !== undefined || error !== undefined || Object.hasOwn(completed, value.transactionId)) {
        return fail('provider-transaction-in-doubt', 'unfinished provider transaction has a terminal receipt');
    }
    return { ...identity, phase: value.phase };
}
/** Each runtime drains its accepted work; shared service identities own resource serialization. */
export class ProviderTransactions {
    ctx;
    runtime;
    pending = new Set();
    stopped = false;
    constructor(ctx, runtime) {
        this.ctx = ctx;
        this.runtime = runtime;
        ctx.effect(() => async () => { this.stopped = true; await Promise.allSettled(this.pending); }, 'llm.provider-transactions');
    }
    /**
     * Serialize shared configuration resources; unrelated namespaces and ordinary streaming remain independent.
     * @param input - Native request, snapshotted before waiting for the previous write.
     * @param signal - cancellation before durable claim; committed work retains ownership.
     * @returns the redacted committed state, or a typed recovery failure.
     */
    async mutate(input, signal) {
        const request = requestSnapshot(input);
        return this.run(request.provider, signal, (settings, credentials) => withResources(settings, [request.settingsNs], () => this.execute(settings, credentials, request, signal)));
    }
    /**
     * Read the stored phase without claiming, upgrading, or executing the transaction.
     * @param input - provider and caller-held transaction id.
     * @returns durable state and write-only credential requirement, never the plan or value.
     */
    async status(input) {
        const request = transactionIdentity(input);
        return this.track(() => this.query(request));
    }
    async query(request) {
        const credentials = this.ctx.get('credentials');
        if (credentials === undefined)
            return fail('service-unavailable', 'provider transaction journal is unavailable');
        const { journal } = await this.read(credentials, request.provider);
        if (journal === undefined)
            return { state: 'absent', needsCredential: false };
        const current = journal.transactionId === request.transactionId;
        const receipt = journal.completed[request.transactionId];
        let state;
        if (current)
            state = journal.phase === 'done' ? journal.outcome : journal.phase;
        else {
            if (receipt === undefined)
                return { state: 'absent', needsCredential: false };
            state = receipt.outcome;
        }
        let needsCredential = false;
        if (current && journal.phase !== 'done' && journal.plan.credential?.op === 'set') {
            const resolved = await this.resolveCredential(credentials, journal.plan.credential.ref);
            needsCredential = resolved === undefined || hash(resolved.value) !== journal.plan.credential.valueDigest;
        }
        return { state, needsCredential, settingsNs: journal.settingsNs,
            ...isOutcome(state) ? { live: current && state === 'committed'
                    && this.runtime.listProviders().some(provider => provider.id === request.provider) } : {} };
    }
    /**
     * Continue the captured durable plan under the same journal, namespace and reference leases as new writes.
     * @param input - stored transaction identity and an optional write-only missing credential.
     * @param signal - cancellation before claim only; claimed work remains owned until settlement.
     * @returns the committed redacted state, or the durable terminal/recovery failure.
     */
    async resume(input, signal) {
        const request = transactionIdentity(input);
        const value = snapshot(input);
        if (!record(value) || (value.credentialValue !== undefined
            && (typeof value.credentialValue !== 'string' || value.credentialValue.trim() === ''))) {
            return fail('input-invalid', 'provider recovery credential must be a non-empty string');
        }
        const supplied = value.credentialValue;
        return this.run(request.provider, signal, async (settings, credentials) => {
            const captured = await this.read(credentials, request.provider);
            const journal = captured.journal;
            if (journal === undefined
                || (journal.transactionId !== request.transactionId && journal.completed[request.transactionId] === undefined)) {
                return fail('provider-transaction-in-doubt', 'the requested provider transaction is not retained');
            }
            return withResources(settings, [journal.settingsNs], async () => {
                let credential;
                const user = settings.describe().find(entry => entry.ns === journal.settingsNs)?.user;
                const unverifiableWrite = (journal.phase === 'prepared' || journal.phase === 'credential-staged')
                    && !satisfied(user, journal.plan.ops) && journal.plan.expectedUserDigest === undefined;
                if (journal.phase !== 'done' && journal.transactionId === request.transactionId && !unverifiableWrite) {
                    const planned = journal.plan.credential;
                    if (planned?.op === 'unset')
                        credential = { op: 'unset', ref: planned.ref };
                    else if (planned?.op === 'set') {
                        const stored = await this.resolveCredential(credentials, planned.ref);
                        const secret = supplied ?? stored?.value;
                        if (secret === undefined || hash(secret) !== planned.valueDigest) {
                            return fail('provider-transaction-needs-credential', 'transaction needs its write-only credential again', {
                                provider: request.provider, transactionId: request.transactionId, ref: planned.ref,
                            });
                        }
                        credential = { op: 'set', ref: planned.ref, value: secret };
                    }
                }
                return this.execute(settings, credentials, { ...request, settingsNs: journal.settingsNs,
                    ops: journal.plan.ops, expectedRevision: journal.plan.expectedRevision,
                    ...credential === undefined ? {} : { credential } }, signal, { ...captured, journal });
            });
        });
    }
    async run(provider, signal, action) {
        if (this.stopped)
            return fail('service-unavailable', 'provider transaction owner is stopped');
        if (execution.getStore()?.active)
            return fail('provider-transaction-reentrant', 'provider mutation cannot be nested in a running transaction');
        if (signal.aborted)
            return fail('cancelled', 'provider transaction was cancelled before durable claim');
        const settings = this.ctx.get('settings');
        const credentials = this.ctx.get('credentials');
        if (settings === undefined || credentials === undefined)
            return fail('service-unavailable', 'provider mutation requires settings and credentials owners');
        return this.track(() => withResources(credentials, [`journal:${provider}`], async () => {
            if (this.stopped)
                return fail('service-unavailable', 'provider transaction owner is stopped');
            if (signal.aborted)
                return fail('cancelled', 'provider transaction was cancelled before durable claim');
            const scope = { active: true };
            try {
                return await execution.run(scope, () => action(settings, credentials));
            }
            finally {
                scope.active = false;
            }
        }));
    }
    async track(operation) {
        if (this.stopped)
            return fail('service-unavailable', 'provider transaction owner is stopped');
        const pending = operation();
        this.pending.add(pending);
        try {
            return await pending;
        }
        finally {
            this.pending.delete(pending);
        }
    }
    async execute(settings, credentials, request, signal, restoring) {
        const namespace = settingsNamespace(request.settingsNs);
        const captured = restoring ?? await this.read(credentials, request.provider);
        const previous = captured.journal;
        const before = settings.describe().find(entry => entry.ns === namespace);
        let declaration = this.runtime.listConfigurableProviders()
            .find(entry => entry.provider === request.provider && entry.settingsNs === request.settingsNs);
        // A deleted custom route leaves the directory. Only its exact retained
        // removal may finish or replay; the journal never admits a new mutation.
        if (declaration === undefined && before !== undefined && previous !== undefined
            && previous.transactionId === request.transactionId && previous.settingsNs === request.settingsNs
            && previous.plan.settingsPath.length > 0 && previous.plan.credential?.op !== 'set'
            && previous.plan.ops.some(op => op.op === 'unset' && deepEqualJson(op.path, previous.plan.settingsPath))
            && satisfied(before.user, previous.plan.ops) && !pathValue(before.value, previous.plan.settingsPath).present
            && !this.runtime.listConfigurableProviders().some(entry => entry.settingsNs === request.settingsNs
                && (prefix(entry.settingsPath, previous.plan.settingsPath) || prefix(previous.plan.settingsPath, entry.settingsPath)))) {
            declaration = { provider: previous.provider, settingsNs: previous.settingsNs, settingsPath: previous.plan.settingsPath };
        }
        if (declaration === undefined)
            return fail('settings-rejected', 'provider does not own the requested settings namespace');
        const digest = restoring === undefined ? inputDigest(request) : restoring.journal.requestDigest;
        if (previous !== undefined && previous.transactionId !== request.transactionId && previous.phase !== 'done') {
            return fail('provider-transaction-in-doubt', 'provider has an unfinished configuration transaction');
        }
        if (previous !== undefined) {
            const receipt = previous.completed[request.transactionId];
            if (receipt !== undefined) {
                if (restoring === undefined && !this.matches(receipt, request))
                    return fail('provider-transaction-in-doubt', 'transaction id was reused with different input');
                await this.claim(credentials, captured, previous, signal);
                this.checkReceipt(receipt);
                return this.result(settings, credentials, request, declaration.settingsPath, undefined);
            }
        }
        if (previous?.transactionId === request.transactionId && restoring === undefined && !this.matches(previous, request)) {
            return fail('provider-transaction-in-doubt', 'transaction id was reused with different input');
        }
        if (before === undefined)
            return fail('settings-rejected', 'provider settings namespace is not registered');
        const replay = previous?.transactionId === request.transactionId ? previous : undefined;
        const configured = request.credential?.op === 'set' && (await credentials.describe(ref(request.credential.ref))).configured;
        const plan = replay?.plan ?? { ...makePlan(declaration, before.value, request, configured),
            expectedUserDigest: hashJson({ user: before.user }) };
        if (!deepEqualJson(plan.settingsPath, declaration.settingsPath))
            return fail('provider-transaction-in-doubt', 'provider profile ownership changed during recovery');
        const refs = [...references(before.value, plan.settingsPath).keys(),
            ...references(apply(before.value, plan.ops), plan.settingsPath).keys(),
            ...request.credential === undefined ? [] : [request.credential.ref],
            ...plan.credential === undefined ? [] : [plan.credential.ref]];
        const referenceKeys = refs.map(ref => `reference:${ref}`);
        return withResources(credentials, referenceKeys, async () => {
            if (replay === undefined) {
                if (before.revision !== request.expectedRevision) {
                    return this.conflict(request.settingsNs, request.expectedRevision, before.revision);
                }
                if (plan.credential !== undefined) {
                    plan.credential.before = credentialCondition(await this.resolveCredential(credentials, plan.credential.ref));
                }
            }
            this.preflight(settings, declaration, before.value, plan, request, replay !== undefined && satisfied(before.user, plan.ops));
            if (plan.credential !== undefined && !(await credentials.describe(ref(plan.credential.ref))).writable)
                return fail('credential-rejected', 'provider credential is read-only');
            if (signal.aborted)
                return fail('cancelled', 'provider transaction was cancelled before durable claim');
            let journal = replay ?? { version: 1, receiptVersion: 1, transactionId: request.transactionId,
                provider: request.provider, settingsNs: request.settingsNs, requestDigest: digest,
                digest: planDigest(request.provider, request.settingsNs, plan), plan, phase: 'prepared',
                completed: { ...previous?.completed } };
            await this.claim(credentials, captured, journal, signal);
            const advance = async (phase) => {
                const next = { ...journal, phase };
                await this.write(credentials, journal, next);
                journal = next;
            };
            const finish = async (...result) => {
                const [outcome, error] = result;
                const identity = { requestDigest: journal.requestDigest,
                    ...journal.legacyInput === undefined ? {} : { legacyInput: journal.legacyInput } };
                const receipt = outcome === 'committed' ? { ...identity, outcome } : { ...identity, outcome, error };
                const next = { ...journal, ...receipt, phase: 'done',
                    completed: { ...journal.completed, [request.transactionId]: receipt } };
                const condition = outcome === 'committed' && plan.credential !== undefined
                    ? { ref: ref(plan.credential.ref), expected: { valueDigest: plan.credential.op === 'set' ? plan.credential.valueDigest : null } }
                    : undefined;
                await this.write(credentials, journal, next, condition);
                journal = next;
            };
            const rollback = async (failure) => {
                if (plan.credential?.op === 'set' && plan.credential.before?.valueDigest === null) {
                    try {
                        await credentials.unset(ref(plan.credential.ref), { valueDigest: plan.credential.valueDigest });
                    }
                    catch (error) {
                        // Absence or a replacement means this transaction's staged value is already gone.
                        if (!(error instanceof CredentialConflictError))
                            return fail('provider-transaction-in-doubt', 'staged credential rollback did not complete');
                    }
                }
                await finish('rolled-back', failure);
                throw new TypertRemoteFailure(failure);
            };
            const credentialConflict = async () => {
                const failure = { code: 'credential-rejected', message: 'provider credential changed before commit', details: { provider: request.provider } };
                await finish('committed-not-live', failure);
                throw new TypertRemoteFailure(failure);
            };
            if (replay !== undefined && (journal.phase === 'prepared' || journal.phase === 'credential-staged')
                && !satisfied(before.user, plan.ops)
                && (plan.expectedUserDigest === undefined || plan.expectedUserDigest !== hashJson({ user: before.user }))) {
                const failure = this.settingsFailure(request.settingsNs, new Error('provider settings changed after claim'));
                return rollback(failure);
            }
            if (journal.phase === 'prepared') {
                if (plan.credential?.op === 'set')
                    await this.applyCredential(credentials, plan.credential, request.credential);
                await advance('credential-staged');
            }
            if (journal.phase === 'credential-staged') {
                const current = settings.describe().find(entry => entry.ns === namespace);
                if (current === undefined)
                    return fail('provider-transaction-in-doubt', 'provider settings owner disappeared');
                if (!satisfied(current.user, plan.ops)) {
                    const revision = plan.expectedUserDigest !== undefined && plan.expectedUserDigest === hashJson({ user: current.user })
                        ? current.revision : plan.expectedRevision;
                    try {
                        await settings.mutate(namespace, plan.ops, revision);
                    }
                    catch (error) {
                        const after = settings.describe().find(entry => entry.ns === namespace);
                        if (after === undefined || !satisfied(after.user, plan.ops)) {
                            const failure = this.settingsFailure(request.settingsNs, error);
                            return rollback(failure);
                        }
                    }
                }
                await advance('settings-applied');
            }
            const committed = settings.describe().find(entry => entry.ns === namespace);
            if (committed === undefined)
                return fail('provider-transaction-in-doubt', 'provider settings disappeared after persistence');
            if (!satisfied(committed.user, plan.ops))
                return fail('provider-transaction-in-doubt', 'provider settings no longer match the committed plan');
            let accepted;
            try {
                accepted = await settings.settle(namespace, committed.revision);
            }
            catch (error) {
                const failure = this.settingsFailure(request.settingsNs, error);
                await finish('committed-not-live', failure);
                throw new TypertRemoteFailure(failure);
            }
            const expectedLive = plan.settingsPath.length === 0 || pathValue(committed.value, plan.settingsPath).present;
            if (!accepted || this.runtime.listProviders().some(provider => provider.id === request.provider) !== expectedLive) {
                const failure = { code: 'provider-registration-rejected', message: 'provider settings were stored but did not activate', details: { provider: request.provider } };
                await finish('committed-not-live', failure);
                throw new TypertRemoteFailure(failure);
            }
            // An old live generation may still need this reference until owner callbacks settle.
            if (journal.phase === 'settings-applied') {
                if (plan.credential?.op === 'unset') {
                    try {
                        await this.applyCredential(credentials, plan.credential, request.credential);
                    }
                    catch (error) {
                        if (error instanceof CredentialConflictError)
                            return credentialConflict();
                        throw error;
                    }
                }
                await advance('credential-applied');
            }
            try {
                await finish('committed');
            }
            catch (error) {
                if (error instanceof CredentialConflictError)
                    return credentialConflict();
                throw error;
            }
            return this.result(settings, credentials, request, plan.settingsPath, plan.credential?.ref);
        });
    }
    checkReceipt(receipt) {
        if (receipt.outcome !== 'committed')
            throw new TypertRemoteFailure(receipt.error);
    }
    matches(receipt, request) {
        if (receipt.requestDigest === inputDigest(request))
            return true;
        if (receipt.legacyInput === undefined)
            return false;
        const credential = request.credential === undefined ? undefined : request.credential.op === 'unset'
            ? { op: 'unset', ref: request.credential.ref }
            : { op: 'set', ref: request.credential.ref, valueDigest: hash(request.credential.value) };
        return legacyPlanDigest(request.provider, request.settingsNs, { settingsPath: receipt.legacyInput.settingsPath,
            ops: [...request.ops], expectedRevision: request.expectedRevision,
            ...credential === undefined ? {} : { credential } }) === receipt.legacyInput.digest;
    }
    async read(credentials, provider) {
        try {
            const stored = structuredClone(await credentials.readRecord(credentialKey('llm-remote', provider)));
            const journal = parseJournal(stored);
            if (journal !== undefined && journal.provider !== provider)
                return fail('provider-transaction-in-doubt', 'provider journal ownership is invalid');
            return { stored, journal };
        }
        catch (error) {
            if (error instanceof TypertRemoteFailure)
                throw error;
            return fail('service-unavailable', 'provider transaction journal is unavailable');
        }
    }
    async claim(credentials, captured, next, signal) {
        try {
            await credentials.modifyRecord(credentialKey('llm-remote', next.provider), (current) => {
                if (signal.aborted)
                    return fail('cancelled', 'provider transaction was cancelled before durable claim');
                if (!deepEqualJson(current, captured.stored))
                    return fail('provider-transaction-in-doubt', 'provider transaction ownership changed before claim');
                const proposed = { kind: 'grant', payload: next };
                return Promise.resolve(deepEqualJson(current, proposed) ? undefined : proposed);
            });
        }
        catch (error) {
            if (error instanceof TypertRemoteFailure)
                throw error;
            return fail('provider-transaction-in-doubt', 'provider journal claim failed');
        }
    }
    async resolveCredential(credentials, reference) {
        try {
            return await credentials.resolve(ref(reference));
        }
        catch {
            return fail('service-unavailable', 'provider credential is unavailable');
        }
    }
    preflight(settings, declaration, before, plan, request, settingsAlreadyApplied) {
        for (const op of plan.ops)
            if (!prefix(op.path, declaration.settingsPath))
                return fail('settings-rejected', 'provider cannot mutate a sibling profile');
        const next = apply(before, plan.ops);
        const beforeRefs = references(before, declaration.settingsPath);
        const afterRefs = references(next, declaration.settingsPath);
        if (plan.credential?.op === 'set' && !afterRefs.has(plan.credential.ref))
            return fail('credential-rejected', 'credential is not bound to the resulting profile');
        if (plan.credential?.op === 'unset' && ((!settingsAlreadyApplied && !beforeRefs.has(plan.credential.ref)) || afterRefs.has(plan.credential.ref)))
            return fail('credential-rejected', 'cannot remove an unrelated or still-referenced credential');
        const values = new Map(settings.describe().map(entry => [String(entry.ns), entry.value]));
        const uses = this.runtime.listConfigurableProviders().flatMap(entry => [...references(values.get(entry.settingsNs), entry.settingsPath).keys()]
            .map(ref => ({ ref, provider: entry.provider, fingerprint: fingerprint(entry, values.get(entry.settingsNs)) })));
        if (request.credential !== undefined && uses.some(use => use.ref === request.credential?.ref && use.provider !== request.provider)) {
            return fail('credential-ownership-rejected', 'requested credential belongs to another provider');
        }
        for (const ref of afterRefs.keys()) {
            const conflicts = uses.filter(use => use.ref === ref
                && (use.provider !== declaration.provider || use.fingerprint !== fingerprint(declaration, next)));
            if (conflicts.some(use => use.provider !== declaration.provider) || (conflicts.length > 0 && plan.credential?.ref !== ref))
                return fail('credential-ownership-rejected', 'credential belongs to another provider or endpoint');
            const unchanged = uses.some(use => use.ref === ref && use.provider === declaration.provider
                && use.fingerprint === fingerprint(declaration, next));
            if (!unchanged && !(plan.credential?.op === 'set' && plan.credential.ref === ref))
                return fail('credential-ownership-required', 'a new endpoint reference requires an explicit credential value');
        }
        if (plan.credential?.op === 'unset' && uses.some(use => use.ref === plan.credential?.ref && use.provider !== declaration.provider))
            return fail('credential-ownership-rejected', 'credential is still owned by another provider');
        try {
            const secrets = settings.previewMutation(settingsNamespace(request.settingsNs), plan.ops).secrets;
            if (plan.ops.some(op => op.op === 'set' && secrets.some(secret => prefix(op.path, secret.path)
                || (prefix(secret.path, op.path) && pathValue(op.value, secret.path.slice(op.path.length)).present)))) {
                return fail('settings-rejected', 'provider settings transactions cannot carry literal secret fields');
            }
        }
        catch (error) {
            if (error instanceof TypertRemoteFailure)
                throw error;
            throw new TypertRemoteFailure(this.settingsFailure(request.settingsNs, error));
        }
    }
    async write(credentials, expected, next, condition) {
        try {
            await credentials.modifyRecord(credentialKey('llm-remote', next.provider), (current) => {
                const previous = parseJournal(current);
                if (!deepEqualJson(previous, expected))
                    return fail('provider-transaction-in-doubt', 'provider journal ownership changed during commit');
                return Promise.resolve({ kind: 'grant', payload: next });
            }, condition === undefined ? [] : [condition]);
        }
        catch (error) {
            if (error instanceof TypertRemoteFailure || error instanceof CredentialConflictError)
                throw error;
            return fail('provider-transaction-in-doubt', 'provider transaction progress could not be persisted');
        }
    }
    async applyCredential(credentials, plan, supplied) {
        const reference = ref(plan.ref);
        const current = await credentials.resolve(reference);
        if (plan.op === 'unset') {
            if (current === undefined)
                return;
            if (plan.before === undefined)
                return fail('provider-transaction-in-doubt', 'credential removal has no durable before-image');
            try {
                await credentials.unset(reference, plan.before);
            }
            catch (error) {
                if (error instanceof CredentialConflictError)
                    throw error;
                if (await credentials.resolve(reference) !== undefined)
                    return fail('provider-transaction-in-doubt', 'credential removal did not complete');
            }
            return;
        }
        if (current !== undefined && hash(current.value) === plan.valueDigest)
            return;
        if (current !== undefined)
            return fail('provider-transaction-in-doubt', 'the staged credential reference now holds a different value');
        if (supplied?.op !== 'set' || hash(supplied.value) !== plan.valueDigest)
            return fail('provider-transaction-needs-credential', 'transaction needs its write-only credential again');
        try {
            await credentials.set(reference, supplied.value, { valueDigest: null });
        }
        catch {
            const after = await credentials.resolve(reference);
            if (after === undefined || hash(after.value) !== plan.valueDigest)
                return fail('provider-transaction-in-doubt', 'credential staging did not complete');
        }
    }
    conflict(ns, expected, actual) {
        return fail('settings-conflict', 'provider settings revision changed', { ns, expected, actual });
    }
    settingsFailure(ns, error) {
        return error instanceof SettingsConflictError
            ? { code: 'settings-conflict', message: 'provider settings revision changed', details: { ns, expected: error.expected, actual: error.actual } }
            : { code: 'settings-rejected', message: 'provider settings write was rejected', details: { ns } };
    }
    async result(settings, credentials, request, settingsPath, credentialRef) {
        const descriptor = settings.describe({ redactSecrets: true }).find(entry => entry.ns === request.settingsNs);
        if (descriptor === undefined)
            return fail('provider-registration-rejected', 'committed provider settings are unavailable');
        const expectedLive = settingsPath.length === 0 || pathValue(descriptor.value, settingsPath).present;
        if (this.runtime.listProviders().some(entry => entry.id === request.provider) !== expectedLive)
            return fail('provider-registration-rejected', 'committed provider route does not match its settings');
        const info = credentialRef === undefined ? undefined : await credentials.describe(ref(credentialRef));
        return { settings: remoteNamespaceView(descriptor), ...info === undefined ? {} : { credential: {
                    configured: info.configured, writable: info.writable, ...info.source === undefined ? {} : { source: info.source },
                } }, live: { accepted: true } };
    }
}
//# sourceMappingURL=provider-transaction.js.map