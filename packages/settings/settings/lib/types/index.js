/**
 * Service Definition for the user-settings capability seam (`ctx.settings`). Providers store one raw document of
 * per-namespace sections; plugins register a namespace schema and read the
 * resolved value, which layers schema defaults, the registrant's composition
 * `base`, and the user document section, in that order.
 * @module @deepseek-ai/dsh-settings
 */
var __runInitializers = (this && this.__runInitializers) || function (thisArg, initializers, value) {
    var useValue = arguments.length > 2;
    for (var i = 0; i < initializers.length; i++) {
        value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
    }
    return useValue ? value : void 0;
};
var __esDecorate = (this && this.__esDecorate) || function (ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
    function accept(f) { if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected"); return f; }
    var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
    var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
    var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
    var _, done = false;
    for (var i = decorators.length - 1; i >= 0; i--) {
        var context = {};
        for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
        for (var p in contextIn.access) context.access[p] = contextIn.access[p];
        context.addInitializer = function (f) { if (done) throw new TypeError("Cannot add initializers after decoration has completed"); extraInitializers.push(accept(f || null)); };
        var result = (0, decorators[i])(kind === "accessor" ? { get: descriptor.get, set: descriptor.set } : descriptor[key], context);
        if (kind === "accessor") {
            if (result === void 0) continue;
            if (result === null || typeof result !== "object") throw new TypeError("Object expected");
            if (_ = accept(result.get)) descriptor.get = _;
            if (_ = accept(result.set)) descriptor.set = _;
            if (_ = accept(result.init)) initializers.unshift(_);
        }
        else if (_ = accept(result)) {
            if (kind === "field") initializers.unshift(_);
            else descriptor[key] = _;
        }
    }
    if (target) Object.defineProperty(target, contextIn.name, descriptor);
    done = true;
};
import { AsyncLocalStorage } from 'node:async_hooks';
import { isAbsolute } from 'node:path';
import { Service } from '@deepseek-ai/cordis';
import { openNativeTextFile } from '@deepseek-ai/dsh-native-command';
import { Remote, TypertLookupFailure, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { redactSecrets, redactSettingsSchema } from "./redact.js";
export { redactSecrets } from "./redact.js";
const NAMESPACE_PATTERN = /^[a-z][a-z0-9-]*$/;
/**
 * Brand a raw string as a {@link SettingsNamespace}.
 * @param value - candidate namespace; lowercase kebab-case, as in plugin short names.
 * @returns the branded namespace.
 */
export function settingsNamespace(value) {
    if (!NAMESPACE_PATTERN.test(value)) {
        throw new TypeError(`settings namespace "${value}" must match ${String(NAMESPACE_PATTERN)}`);
    }
    return value;
}
/**
 * Deep equality over JSON-compatible data (objects, arrays, primitives) — the
 * Service Definition's single change-detection predicate, exported so the invariant
 * companion checks exactly the implementation's relation.
 * @param a - one JSON-compatible value.
 * @param b - the other JSON-compatible value.
 * @returns whether the two values are structurally equal.
 */
export function deepEqualJson(a, b) {
    if (a === b)
        return true;
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null)
        return false;
    if (Array.isArray(a) || Array.isArray(b)) {
        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length)
            return false;
        return a.every((entry, index) => deepEqualJson(entry, b[index]));
    }
    const left = a;
    const right = b;
    const keys = Object.keys(left);
    if (keys.length !== Object.keys(right).length)
        return false;
    return keys.every(key => Object.hasOwn(right, key) && deepEqualJson(left[key], right[key]));
}
/**
 * A write refused because the namespace moved since the caller read it. The
 * Service Definition's serialized write queue orders writes; it cannot tell a fresh writer
 * from one holding a stale snapshot, which is what this reports.
 */
export class SettingsConflictError extends Error {
    /** Stable machine code for wire layers mapping this to their own taxonomy. */
    code = 'SETTINGS_CONFLICT';
    /** The revision the write expected. */
    expected;
    /** The revision the namespace actually stands at. */
    actual;
    /**
     * @param ns - the namespace whose write was refused.
     * @param expected - the revision the caller sent.
     * @param actual - the revision now stored.
     */
    constructor(ns, expected, actual) {
        super(`settings namespace "${ns}" changed since it was read (expected revision ${String(expected)}, now ${String(actual)})`);
        this.name = 'SettingsConflictError';
        this.expected = expected;
        this.actual = actual;
    }
}
/** A namespace cannot be replaced until its previous owner's work stops. */
export class SettingsRegistrationQuiescenceError extends Error {
    ns;
    timeoutMs;
    /** Replacement remains blocked while the previous registration is stopping. */
    code = 'SETTINGS_REGISTRATION_QUIESCENCE_TIMEOUT';
    /**
     * @param ns - namespace whose owner is still stopping.
     * @param timeoutMs - elapsed replacement deadline.
     */
    constructor(ns, timeoutMs) {
        super(`settings namespace "${ns}" did not quiesce within ${String(timeoutMs)}ms; replacement remains blocked`);
        this.ns = ns;
        this.timeoutMs = timeoutMs;
        this.name = 'SettingsRegistrationQuiescenceError';
    }
}
/** Whether a value is a plain data object (not an array, null, or class instance). */
function isPlainObject(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}
/** Apply one path op to a detached section, returning the next section. */
function applyPathOp(section, op) {
    const [head, ...rest] = op.path;
    // The empty path addresses the section itself.
    if (head === undefined) {
        if (op.op === 'unset')
            return {};
        if (!isPlainObject(op.value)) {
            throw new TypeError('settings mutate: setting the section root requires a plain object');
        }
        return { ...op.value };
    }
    if (rest.length === 0) {
        if (op.op === 'set')
            return { ...section, [head]: op.value };
        const { [head]: _removed, ...kept } = section;
        return kept;
    }
    const child = Object.hasOwn(section, head) ? section[head] : undefined;
    if (!isPlainObject(child)) {
        // Unsetting through an absent path is already satisfied; setting through
        // one creates the intermediate objects it needs.
        if (op.op === 'unset')
            return section;
        return { ...section, [head]: applyPathOp({}, { ...op, path: rest }) };
    }
    return { ...section, [head]: applyPathOp(child, { ...op, path: rest }) };
}
function validateSettingsPathOps(ns, ops) {
    if (!Array.isArray(ops))
        throw new TypeError(`settings mutate for "${ns}" must be an array of path ops`);
    for (const op of ops) {
        if (!isPlainObject(op) || (op['op'] !== 'set' && op['op'] !== 'unset')) {
            throw new TypeError(`settings mutate for "${ns}" ops must be {op:'set'|'unset', path}`);
        }
        if (!Array.isArray(op['path']) || op['path'].some(part => typeof part !== 'string')) {
            throw new TypeError(`settings mutate for "${ns}" op paths must be arrays of strings`);
        }
        if (op['op'] === 'set' && !Object.hasOwn(op, 'value')) {
            throw new TypeError(`settings mutate for "${ns}" set ops must include a JSON value`);
        }
    }
}
/** Human label for a value that lossless JSON cannot represent (numbers reject inline). */
function describeRejected(value) {
    if (value === undefined)
        return 'undefined';
    if (typeof value === 'object' && value !== null) {
        const proto = Object.getPrototypeOf(value);
        const name = proto?.constructor?.name;
        return name === undefined || name === 'Object' ? 'a non-plain object' : `a ${name}`;
    }
    return `a ${typeof value}`;
}
/**
 * Detach and validate one write input in a single walk before persistence:
 * only JSON data (plain objects, arrays, strings, finite numbers,
 * booleans, `null`) may reach a provider document. `structuredClone` alone
 * would admit Dates, Maps, BigInts, and cycles that YAML/JSON storage then
 * silently distorts on the reload round-trip. `undefined` entries in objects
 * are skipped — the same sparse-patch semantics as {@link mergeLayers} — while
 * an `undefined` array entry is rejected rather than coerced.
 * @param root - plain-object write input (caller-checked).
 * @param reject - builds the validation error from a value label and its `$`-rooted path.
 * @returns the detached JSON-compatible clone.
 */
function cloneJsonShaped(root, reject) {
    const visiting = new WeakSet();
    const clone = (value, path) => {
        if (value === null || typeof value === 'string' || typeof value === 'boolean')
            return value;
        if (typeof value === 'number') {
            if (!Number.isFinite(value))
                throw reject('a non-finite number', path);
            if (Object.is(value, -0))
                throw reject('negative zero', path);
            return value;
        }
        if (Array.isArray(value)) {
            if (visiting.has(value))
                throw reject('a circular reference', path);
            visiting.add(value);
            const entries = [];
            for (let index = 0; index < value.length; index++)
                entries.push(clone(value[index], `${path}[${index}]`));
            // Un-mark on exit so one object referenced twice without a cycle passes.
            visiting.delete(value);
            return entries;
        }
        if (isPlainObject(value))
            return cloneObject(value, path);
        throw reject(describeRejected(value), path);
    };
    const cloneObject = (value, path) => {
        if (visiting.has(value))
            throw reject('a circular reference', path);
        visiting.add(value);
        const out = {};
        for (const [key, entry] of Object.entries(value)) {
            if (entry === undefined)
                continue;
            Object.defineProperty(out, key, {
                value: clone(entry, `${path}.${key}`), enumerable: true, writable: true, configurable: true,
            });
        }
        visiting.delete(value);
        return out;
    };
    return cloneObject(root, '$');
}
/**
 * Layer `over` onto `under`: plain objects merge recursively, every other
 * value (arrays included) replaces the lower layer wholesale. `over` never
 * carries `undefined` entries — sections come from parsed documents and write
 * snapshots pass {@link cloneJsonShaped}, which strips them so a sparse patch
 * cannot erase lower keys.
 */
function mergeLayers(under, over) {
    if (over === undefined)
        return under;
    if (!isPlainObject(under) || !isPlainObject(over))
        return over;
    const merged = { ...under };
    for (const [key, value] of Object.entries(over)) {
        Object.defineProperty(merged, key, {
            value: Object.hasOwn(merged, key) ? mergeLayers(merged[key], value) : value,
            enumerable: true, writable: true, configurable: true,
        });
    }
    return merged;
}
/** Recursively freeze one resolved value so handed-out snapshots stay immutable. */
function deepFreeze(value) {
    if (typeof value !== 'object' || value === null || Object.isFrozen(value))
        return value;
    for (const entry of Object.values(value))
        deepFreeze(entry);
    return Object.freeze(value);
}
const watcherExecution = new AsyncLocalStorage();
function isRegistrationActive(registration) {
    return registration.active;
}
async function settlesBefore(operation, timeoutMs) {
    const timeout = Promise.withResolvers();
    const timer = setTimeout(timeout.resolve, timeoutMs, false);
    timer.unref();
    try {
        return await Promise.race([operation.then(() => true), timeout.promise]);
    }
    finally {
        clearTimeout(timer);
    }
}
/**
 * Abstract settings service. Providers implement raw-document storage
 * (`load`/`persist`) and push external changes through {@link Settings.publish};
 * the base class owns namespace registration, resolution, validation, change
 * detection, and the `settings/updated` commit event.
 */
let SettingsProvider = (() => {
    let _classSuper = TypertRemoteService;
    let _instanceExtraInitializers = [];
    let _remoteDescribe_decorators;
    let _remoteOpenDocument_decorators;
    let _remoteUpdate_decorators;
    let _remoteReplace_decorators;
    let _remoteMutate_decorators;
    return class SettingsProvider extends _classSuper {
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
            _remoteDescribe_decorators = [Remote('describe')];
            _remoteOpenDocument_decorators = [Remote('openDocument')];
            _remoteUpdate_decorators = [Remote('update')];
            _remoteReplace_decorators = [Remote('replace')];
            _remoteMutate_decorators = [Remote('mutate')];
            __esDecorate(this, null, _remoteDescribe_decorators, { kind: "method", name: "remoteDescribe", static: false, private: false, access: { has: obj => "remoteDescribe" in obj, get: obj => obj.remoteDescribe }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _remoteOpenDocument_decorators, { kind: "method", name: "remoteOpenDocument", static: false, private: false, access: { has: obj => "remoteOpenDocument" in obj, get: obj => obj.remoteOpenDocument }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _remoteUpdate_decorators, { kind: "method", name: "remoteUpdate", static: false, private: false, access: { has: obj => "remoteUpdate" in obj, get: obj => obj.remoteUpdate }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _remoteReplace_decorators, { kind: "method", name: "remoteReplace", static: false, private: false, access: { has: obj => "remoteReplace" in obj, get: obj => obj.remoteReplace }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _remoteMutate_decorators, { kind: "method", name: "remoteMutate", static: false, private: false, access: { has: obj => "remoteMutate" in obj, get: obj => obj.remoteMutate }, metadata: _metadata }, null, _instanceExtraInitializers);
            if (_metadata) Object.defineProperty(this, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        }
        registrations = (__runInitializers(this, _instanceExtraInitializers), new Map());
        /** Latest published raw document; empty until the provider's first publish. */
        document = {};
        /** Per-namespace write chains; settled tails, so a failure never poisons the queue. */
        writeQueues = new Map();
        /** In-flight watcher invocation segments, drained by the dispose teardown. */
        pendingTails = new Set();
        remoteProtectedNamespaces = new Map();
        /** Set at service dispose: refuse new writes while queued ones drain. */
        stopped = false;
        /** Deadline for an old namespace owner to release writes and callbacks. */
        get registrationQuiescenceTimeoutMs() {
            return 5000;
        }
        /** Opaque read of {@link stopped}: control flow cannot narrow it across awaits. */
        isStopped() {
            return this.stopped;
        }
        constructor(ctx) {
            super(ctx, 'settings');
        }
        /**
         * Load the provider's document once and publish it before the service
         * becomes injectable, and register the write-drain teardown. Providers with
         * their own init (watchers, connections) delegate here first via
         * `yield* super[Service.init]()`; their disposers then run before the drain.
         */
        async *[Service.init]() {
            yield async () => {
                // Teardown: refuse new writes and new watcher starts, then wait until
                // every queued write chain and every started watcher invocation settles
                // so disposal completes only once storage and observers are quiescent.
                // Invocations queued but not yet started skip via the stopped check.
                this.stopped = true;
                await Promise.allSettled([...this.writeQueues.values(), ...this.pendingTails]);
            };
            this.publish(await this.load());
        }
        /**
         * Absolute path of the provider's user-editable document, when its storage
         * is one local file. Configuration surfaces use this only as availability
         * metadata; the guarded open operation resolves the path again Host-side.
         * Non-file providers leave it undefined and expose no open-document affordance.
         * @returns the absolute local document path, or undefined for non-file storage.
         */
        get documentPath() {
            return undefined;
        }
        /**
         * Prepare the provider's user-editable document for a native editor. File
         * providers may materialize an absent document before returning its path;
         * non-file providers return undefined.
         * @returns the absolute local document path, or undefined for non-file storage.
         */
        prepareDocument() {
            return Promise.resolve(this.documentPath);
        }
        /**
         * Register a namespace schema and receive its owner scope. The registration
         * is an effect on the calling plugin's fiber: disposing that fiber removes
         * the namespace and its observers. An invalid stored section fails the
         * registration itself — the earliest point where the schema can judge it.
         * @param ns - unique namespace; duplicate registration fails loud.
         * @param schema - schemastery schema resolving this namespace's value.
         * @param options - composition `base` layer and effect timing.
         * @returns the owner scope for reads, observation, and updates.
         */
        register(ns, schema, options) {
            if (this.isStopped())
                throw new Error(`settings service is disposed: "${ns}" cannot be registered`);
            const existing = this.registrations.get(ns);
            if (existing !== undefined) {
                if (existing.quiescenceTimedOut) {
                    throw new SettingsRegistrationQuiescenceError(ns, this.registrationQuiescenceTimeoutMs);
                }
                throw new Error(`settings namespace "${ns}" is already registered`);
            }
            const registration = {
                ns,
                schema: schema,
                base: options?.base,
                applies: options?.applies ?? 'live',
                ...options?.validate === undefined
                    ? {}
                    : { validate: options.validate },
                ...options?.validateWrite === undefined
                    ? {}
                    : { validateWrite: options.validateWrite },
                ...options?.redact === undefined ? {} : { redact: options.redact },
                resolved: deepFreeze(this.resolve(schema, options?.base, this.section(ns), options?.validate)),
                revision: 0,
                watchers: new Set(),
                active: true,
                settlement: Promise.resolve(true),
                quiescenceTimedOut: false,
            };
            this.ctx.effect(() => {
                this.registrations.set(ns, registration);
                return async () => {
                    registration.active = false;
                    for (const watcher of registration.watchers)
                        watcher.active = false;
                    const write = this.writeQueues.get(ns);
                    const current = watcherExecution.getStore();
                    // A watcher may unload its own plugin; waiting on itself would deadlock.
                    const tails = [...registration.watchers]
                        .filter(watcher => current?.registration !== registration || current.watcher !== watcher)
                        .map(watcher => watcher.tail);
                    const quiescence = Promise.allSettled([...write === undefined ? [] : [write], ...tails])
                        .then(() => undefined);
                    if (!await settlesBefore(quiescence, this.registrationQuiescenceTimeoutMs)) {
                        registration.quiescenceTimedOut = true;
                        void quiescence.then(() => this.registrations.delete(ns));
                        throw new SettingsRegistrationQuiescenceError(ns, this.registrationQuiescenceTimeoutMs);
                    }
                    this.registrations.delete(ns);
                };
            }, `settings.register(${JSON.stringify(String(ns))})`);
            const requireOwner = () => {
                if (!registration.active || this.registrations.get(ns) !== registration || this.isStopped()) {
                    throw new Error(`settings namespace "${ns}" registration is disposed`);
                }
            };
            return {
                get: () => registration.resolved,
                watch: (callback) => {
                    requireOwner();
                    const watcher = { callback: callback, tail: Promise.resolve(), active: true };
                    registration.watchers.add(watcher);
                    return () => {
                        watcher.active = false;
                        // Unsubscription stops new calls, but the namespace still owns a started call.
                        void watcher.tail.then(() => registration.watchers.delete(watcher));
                    };
                },
                update: async (patch) => { requireOwner(); await this.update(ns, patch); },
                replace: async (section) => { requireOwner(); await this.replace(ns, section); },
            };
        }
        /**
         * Describe every registered namespace for configuration surfaces, including
         * the composition `base` and raw user layers so a form can mark which fields
         * the user overrode (presence in `user`) and what a reset returns to.
         * @param options - redaction switch; wire surfaces must redact.
         * @returns one descriptor per registered namespace, in registration order.
         */
        describe(options) {
            return [...this.registrations.values()].map((registration) => {
                let user;
                try {
                    user = this.section(registration.ns);
                }
                catch {
                    // A malformed stored section already warned at publish and kept the
                    // last good resolved value; only that malformed shape can throw here,
                    // and describing it as "no user layer" keeps this read total.
                    user = undefined;
                }
                const base = registration.base === undefined ? undefined : structuredClone(registration.base);
                const detachedUser = user === undefined ? undefined : structuredClone(user);
                const descriptor = {
                    ns: registration.ns,
                    schema: registration.schema.toJSON(),
                    value: registration.resolved,
                    revision: registration.revision,
                    ...base === undefined ? {} : { base },
                    ...detachedUser === undefined ? {} : { user: detachedUser },
                    applies: registration.applies,
                };
                if (options?.redactSecrets !== true)
                    return descriptor;
                const schema = registration.schema;
                const redact = registration.redact ?? ((value) => redactSecrets(schema, value));
                const redacted = redact(registration.resolved);
                return {
                    ...descriptor,
                    schema: redactSettingsSchema(schema),
                    value: redacted.value,
                    ...base === undefined ? {} : { base: redact(base).value },
                    ...detachedUser === undefined ? {} : { user: redact(detachedUser).value },
                    secrets: redacted.secrets,
                };
            });
        }
        /**
         * Read redacted settings and deployment facts without revealing a local path.
         * @returns every registered namespace in registration order.
         */
        remoteDescribe() {
            return {
                writable: this.writable,
                hasDocument: this.ownedDocumentPath() !== undefined,
                namespaces: this.describe({ redactSecrets: true }).map(remoteNamespaceView),
            };
        }
        /**
         * Prepare and open only the document owned by this provider.
         * @param signal - transport cancellation, including the native command.
         * @returns confirmation of the editor handoff; cancellation rejects.
         */
        async remoteOpenDocument(signal) {
            const checkCancellation = () => {
                if (signal.aborted)
                    throw new TypertLookupFailure({
                        code: 'cancelled', message: 'settings document open was aborted', details: {},
                    });
            };
            const fail = (message) => new TypertLookupFailure({ code: 'internal', message, details: {} });
            checkCancellation();
            const documentPath = this.ownedDocumentPath();
            if (documentPath === undefined)
                throw fail('settings provider has no local document to open');
            let preparedPath;
            try {
                preparedPath = await this.prepareDocument();
            }
            catch {
                // Storage errors can contain Host paths or document contents; expose neither.
                checkCancellation();
                throw fail('settings document preparation failed');
            }
            checkCancellation();
            if (preparedPath !== documentPath || this.ownedDocumentPath() !== documentPath) {
                throw fail('settings provider did not prepare its owned local document');
            }
            try {
                await this.openDocumentInNativeEditor(documentPath, signal);
            }
            catch {
                // Native process diagnostics are not safe Remote error payloads.
                checkCancellation();
                throw fail('settings document open failed');
            }
            checkCancellation();
            return { opened: true };
        }
        /**
         * Merge fields without reconstructing a redacted section.
         * @param ns - namespace to update.
         * @param patch - JSON fields to merge.
         * @param expectedRevision - revision read by the caller.
         * @returns the updated redacted namespace.
         */
        remoteUpdate(ns, patch, expectedRevision) {
            return this.remoteWrite(ns, namespace => this.update(namespace, patch, expectedRevision));
        }
        /**
         * Replace the whole user layer, removing omitted overrides.
         * @param ns - namespace to replace.
         * @param section - complete new user layer, not a redacted readback.
         * @param expectedRevision - revision read by the caller.
         * @returns the updated redacted namespace.
         */
        remoteReplace(ns, section, expectedRevision) {
            return this.remoteWrite(ns, namespace => this.replace(namespace, section, expectedRevision));
        }
        /**
         * Apply ordered edits while preserving untouched hidden fields.
         * @param ns - namespace to mutate.
         * @param ops - path-addressed JSON edits.
         * @param expectedRevision - revision read by the caller.
         * @returns the updated redacted namespace.
         */
        remoteMutate(ns, ops, expectedRevision) {
            return this.remoteWrite(ns, namespace => this.mutate(namespace, ops, expectedRevision));
        }
        async remoteWrite(ns, write) {
            let namespace;
            try {
                namespace = settingsNamespace(ns);
                if ([...this.remoteProtectedNamespaces.values()].some(namespaces => namespaces.has(namespace))) {
                    throw new Error('namespace writes belong to its domain transaction');
                }
                await write(namespace);
            }
            catch (error) {
                if (error instanceof SettingsConflictError)
                    throw new TypertLookupFailure({
                        code: 'settings-conflict', message: error.message,
                        details: { ns, expected: error.expected, actual: error.actual },
                    });
                throw new TypertLookupFailure({
                    code: 'settings-rejected', message: `settings write for "${ns}" was rejected`, details: { ns },
                });
            }
            const descriptor = this.describe({ redactSecrets: true }).find(candidate => candidate.ns === namespace);
            if (descriptor === undefined)
                throw new TypertLookupFailure({
                    code: 'internal', message: 'settings write did not complete', details: {},
                });
            return remoteNamespaceView(descriptor);
        }
        ownedDocumentPath() {
            const path = this.documentPath;
            return path !== undefined && isAbsolute(path) ? path : undefined;
        }
        /**
         * Hand the provider-owned file to a native text editor, without a shell.
         * @param path - absolute provider document path.
         * @param signal - caller lifetime.
         * @returns completion of the native handoff command.
         */
        openDocumentInNativeEditor(path, signal) {
            return openNativeTextFile(path, signal);
        }
        /**
         * Reserve generic Remote writes for namespaces with a domain transaction owner.
         * @param namespaces - this calling fiber's complete protected set; other owners retain their reservations.
         */
        setRemoteProtectedNamespaces(namespaces) {
            const owner = this.ctx.fiber;
            if (!this.remoteProtectedNamespaces.has(owner)) {
                this.ctx.effect(() => () => { this.remoteProtectedNamespaces.delete(owner); }, 'settings.remote-domain-protection');
            }
            this.remoteProtectedNamespaces.set(owner, new Set(namespaces));
        }
        /**
         * Wait for the owner's callbacks for an exact persisted revision.
         * @param ns - registered namespace.
         * @param revision - exact revision to observe; superseded revisions reject.
         * @returns whether every owner callback accepted the revision, not merely whether it persisted.
         */
        async settle(ns, revision) {
            const registration = this.registrations.get(ns);
            if (registration === undefined || !registration.active)
                throw new Error(`settings namespace "${ns}" is not registered`);
            if (registration.revision !== revision)
                throw new SettingsConflictError(ns, revision, registration.revision);
            const accepted = await registration.settlement;
            if (this.registrations.get(ns) !== registration || !isRegistrationActive(registration)) {
                throw new Error(`settings namespace "${ns}" was disposed while revision ${String(revision)} settled`);
            }
            if (registration.revision !== revision)
                throw new SettingsConflictError(ns, revision, registration.revision);
            return accepted;
        }
        /**
         * Read one registered namespace's resolved value.
         * @param ns - the namespace to read.
         * @returns the resolved value, or `undefined` while unregistered.
         */
        get(ns) {
            return this.registrations.get(ns)?.resolved;
        }
        /**
         * Merge a patch into one registered namespace's user layer, validate the
         * resolved candidate, persist through the provider, then commit and emit.
         * A validation failure rejects before anything is persisted. Writes to one
         * namespace are serialized: concurrent updates apply in call order, each
         * merging over the previous write's committed section.
         * @param ns - the registered namespace to update.
         * @param patch - plain-object patch over the user section.
         * @param expectedRevision - the descriptor `revision` the caller read; a
         *   namespace that moved past it rejects with {@link SettingsConflictError}.
         */
        async update(ns, patch, expectedRevision) {
            return this.write(ns, patch, 'merge', expectedRevision);
        }
        /**
         * Replace one registered namespace's user section wholesale, validate,
         * persist, then commit and emit. Keys absent from `section` fall back to the
         * composition `base` and schema defaults — this is the removal/reset path a
         * merge-only patch cannot express (`replace({})` re-inherits everything).
         * @param ns - the registered namespace to replace.
         * @param section - the complete next user section.
         * @param expectedRevision - the descriptor `revision` the caller read; a
         *   namespace that moved past it rejects with {@link SettingsConflictError}.
         */
        async replace(ns, section, expectedRevision) {
            return this.write(ns, section, 'replace', expectedRevision);
        }
        /**
         * Apply path-addressed edits to one registered namespace's user section,
         * validate, persist, then commit and emit. The ops are applied to the
         * section as it stands when the write reaches the front of the queue, so a
         * caller never has to restate fields it did not touch — and, crucially,
         * cannot delete fields it never saw. This is the write path for any caller
         * holding a redacted view; `replace` remains the wholesale reset.
         * @param ns - the registered namespace to edit.
         * @param ops - ordered path edits; later ops observe earlier ones.
         * @param expectedRevision - the descriptor `revision` the caller read; a
         *   namespace that moved past it rejects with {@link SettingsConflictError}.
         */
        async mutate(ns, ops, expectedRevision) {
            return this.write(ns, ops, 'mutate', expectedRevision);
        }
        /**
         * Validate a mutation and locate its secrets before a domain owner journals it.
         * @param ns - registered namespace.
         * @param ops - proposed ordered edits; nothing is persisted.
         * @returns secret positions in the resolved candidate.
         */
        previewMutation(ns, ops) {
            const registration = this.registrations.get(ns);
            if (registration === undefined || !registration.active)
                throw new Error(`settings namespace "${ns}" is not registered`);
            const snapshot = cloneJsonShaped({ ops }, (label, path) => new TypeError(`settings mutate for "${ns}" must contain only JSON-compatible data (found ${label} at ${path})`));
            const edits = snapshot['ops'];
            validateSettingsPathOps(ns, edits);
            const section = edits.reduce(applyPathOp, this.section(ns) ?? {});
            const next = this.resolve(registration.schema, registration.base, section, registration.validate);
            registration.validateWrite?.(next);
            const redact = registration.redact ?? ((value) => redactSecrets(registration.schema, value));
            return { secrets: redact(next).secrets };
        }
        /** Validate a write, then queue it on the namespace's serialized write chain. */
        write(ns, input, mode, expectedRevision) {
            const verb = mode === 'merge' ? 'update' : mode === 'replace' ? 'replace' : 'mutate';
            const registration = this.registrations.get(ns);
            if (registration === undefined || !registration.active) {
                throw new Error(`settings namespace "${ns}" is not registered`);
            }
            if (this.isStopped()) {
                throw new Error(`settings service is disposed: "${ns}" cannot be written`);
            }
            if (!this.writable) {
                throw new Error(`settings provider is read-only: "${ns}" cannot be updated in-process`);
            }
            if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) {
                throw new TypeError('settings expectedRevision must be a non-negative safe integer');
            }
            // A mutate's ops array is wrapped so one JSON-shape walk covers both
            // shapes; merge/replace carry the section itself.
            let payload;
            if (mode === 'mutate') {
                payload = { ops: input };
            }
            else {
                if (!isPlainObject(input))
                    throw new TypeError(`settings ${verb} for "${ns}" must be a plain object`);
                payload = input;
            }
            // Snapshot at call time: the queue must never read a caller-owned object
            // the caller may keep mutating while the write waits its turn. The same
            // walk rejects values that JSON cannot preserve (see cloneJsonShaped).
            const snapshot = cloneJsonShaped(payload, (label, path) => new TypeError(`settings ${verb} for "${ns}" must contain only JSON-compatible data (found ${label} at ${path})`));
            let edits = [];
            if (mode === 'mutate') {
                const ops = snapshot['ops'];
                validateSettingsPathOps(ns, ops);
                edits = ops;
            }
            const previous = this.writeQueues.get(ns) ?? Promise.resolve();
            // Chain past a failed predecessor: one rejected write must not poison the
            // namespace queue for every later caller.
            const run = previous.catch(() => undefined).then(async () => {
                if (this.isStopped()) {
                    throw new Error(`settings service was disposed before the queued "${ns}" ${verb} ran`);
                }
                if (!registration.active || this.registrations.get(ns) !== registration) {
                    throw new Error(`settings namespace "${ns}" registration was disposed before the queued ${verb} ran`);
                }
                // Every mode derives from the section as it stands NOW, at the front of
                // the queue — never from whatever the caller last saw.
                const current = this.section(ns) ?? {};
                // The revision check belongs HERE, not at call time: the queue orders
                // writes but cannot tell a fresh writer from one holding a snapshot
                // that a predecessor already superseded.
                if (expectedRevision !== undefined && expectedRevision !== registration.revision) {
                    throw new SettingsConflictError(ns, expectedRevision, registration.revision);
                }
                const section = mode === 'merge'
                    ? mergeLayers(current, snapshot)
                    : mode === 'replace'
                        ? snapshot
                        : edits.reduce(applyPathOp, current);
                const next = deepFreeze(this.resolve(registration.schema, registration.base, section, registration.validate));
                registration.validateWrite?.(next);
                if (registration.revision === Number.MAX_SAFE_INTEGER && !deepEqualJson(current, section)) {
                    throw new RangeError(`settings namespace "${ns}" revision space is exhausted`);
                }
                await this.persist(ns, section);
                // The write reached storage either way; the cache must say so. Commit
                // only when this registration is still the namespace owner — a fiber
                // disposed (or replaced) mid-persist must not receive the notification.
                this.document[ns] = section;
                if (isRegistrationActive(registration) && this.registrations.get(ns) === registration && !this.isStopped()) {
                    const documentChanged = this.bumpRevision(registration, current, section);
                    this.commit(registration, next, 'update', documentChanged);
                }
            });
            this.writeQueues.set(ns, run);
            return run;
        }
        /**
         * Provider hook: commit a complete raw document observed in storage. Each
         * registered namespace re-resolves; an invalid section keeps that
         * namespace's last good value and warns, other namespaces still commit.
         * @param doc - the detached raw document (unregistered sections preserved).
         * @param source - change origin; defaults to `provider`.
         */
        publish(doc, source = 'provider') {
            // Read every raw section BEFORE swapping the document, so the revision
            // bump below compares what was stored with what now is — an external edit
            // moves the revision exactly like an in-process write.
            const before = new Map();
            for (const registration of this.registrations.values()) {
                try {
                    before.set(registration.ns, this.section(registration.ns));
                }
                catch {
                    // A malformed stored section is not a readable "before"; treating it
                    // as absent still bumps against any well-formed replacement.
                    before.set(registration.ns, undefined);
                }
            }
            this.document = doc;
            for (const registration of this.registrations.values()) {
                if (!registration.active || this.isStopped())
                    continue;
                let next;
                try {
                    next = deepFreeze(this.resolve(registration.schema, registration.base, this.section(registration.ns), registration.validate));
                }
                catch (error) {
                    this.ctx.logger.warn('settings: keeping last good "%s" after invalid stored section', registration.ns);
                    this.ctx.logger.warn(error);
                    continue;
                }
                const documentChanged = this.bumpRevision(registration, before.get(registration.ns), this.section(registration.ns));
                this.commit(registration, next, source, documentChanged);
            }
        }
        /** Read one namespace's raw user section, rejecting non-object sections. */
        section(ns) {
            const section = this.document[ns];
            if (section === undefined)
                return undefined;
            if (!isPlainObject(section)) {
                throw new TypeError(`settings section "${ns}" must be an object of keys`);
            }
            return section;
        }
        /** Resolve one namespace value: schema defaults, then `base`, then the user layer. */
        resolve(schema, base, section, validate) {
            // The merged candidate is untyped by construction; the schema call is the
            // runtime validation that admits it into T.
            const value = schema(mergeLayers(base, section));
            // The owner's own check runs on the admitted value, so it sees defaults
            // and the composition base exactly as the owner will.
            validate?.(value);
            return value;
        }
        /**
         * Bind settlement before any commit notification can re-enter settle().
         * Raw changes advance the revision even when the resolved value is unchanged.
         */
        bumpRevision(registration, before, after) {
            if (deepEqualJson(before, after))
                return false;
            if (registration.revision === Number.MAX_SAFE_INTEGER) {
                throw new RangeError(`settings namespace "${registration.ns}" revision space is exhausted`);
            }
            registration.revision += 1;
            const settlement = Promise.withResolvers();
            registration.settlement = settlement.promise;
            registration.settlementResolver = settlement.resolve;
            return true;
        }
        /** Contained fan-out of `settings/document-updated`, mirroring {@link commit}'s. */
        emitDocumentUpdated(ns, revision) {
            const registration = this.registrations.get(ns);
            let invariantFailure;
            const args = ['settings/document-updated', ns, revision];
            for (const listener of this.ctx.events.dispatch('emit', args)) {
                if (this.registrations.get(ns) !== registration || registration?.revision !== revision || !registration.active)
                    break;
                try {
                    const returned = listener(ns, revision);
                    if (returned != null && typeof returned.then === 'function') {
                        void Promise.resolve(returned).then(undefined, (error) => {
                            this.warnListenerFailure(ns, error);
                        });
                    }
                }
                catch (error) {
                    if (error?.code === 'INVARIANT') {
                        invariantFailure ??= error;
                        continue;
                    }
                    this.warnListenerFailure(ns, error);
                }
            }
            if (invariantFailure !== undefined)
                throw invariantFailure;
        }
        /** Commit a resolved value when changed: swap, notify watchers, emit the event. */
        commit(registration, next, source, documentChanged) {
            const revision = registration.revision;
            const resolveSettlement = registration.settlementResolver;
            delete registration.settlementResolver;
            const prev = registration.resolved;
            if (deepEqualJson(next, prev)) {
                resolveSettlement?.(true);
                if (documentChanged)
                    this.emitDocumentUpdated(registration.ns, revision);
                return;
            }
            registration.resolved = next;
            const outcomes = [];
            for (const watcher of [...registration.watchers]) {
                if (!watcher.active)
                    continue;
                // Serialize per watcher: invocations of one callback run one at a time
                // in commit order, so a slow stale invocation can never apply after a
                // newer one. Sync throws and async rejections land in the same handler.
                // The activity check runs when the queued invocation would start, so a
                // disposer (or service stop) that ran while it waited prevents the
                // start entirely; started invocations drain at service dispose.
                const outcome = watcher.tail
                    .then(() => {
                    if (!watcher.active || !registration.active || this.isStopped())
                        return;
                    return watcherExecution.run({ registration, watcher }, () => watcher.callback(next, prev));
                })
                    .then(() => true, (error) => {
                    this.warnWatcherFailure(registration.ns, error);
                    return false;
                });
                outcomes.push(outcome);
                const segment = outcome.then(() => undefined);
                watcher.tail = segment;
                this.pendingTails.add(segment);
                void segment.then(() => this.pendingTails.delete(segment));
            }
            void Promise.all(outcomes).then(results => resolveSettlement?.(results.every(Boolean)));
            if (documentChanged)
                this.emitDocumentUpdated(registration.ns, revision);
            // Fan the event out one listener at a time (the plain emit stops at the
            // first throwing listener, starving the rest). Invariant violations are
            // harness-fatal by design and rethrow after every listener ran; any other
            // failure is contained so one broken observer cannot wedge the commit
            // path (and, through it, a provider's reload loop).
            let invariantFailure;
            const args = ['settings/updated', registration.ns, next, prev, source];
            for (const listener of this.ctx.events.dispatch('emit', args)) {
                if (this.registrations.get(registration.ns) !== registration || !registration.active
                    || registration.resolved !== next || registration.revision !== revision)
                    break;
                try {
                    const returned = listener(registration.ns, next, prev, source);
                    if (returned != null && typeof returned.then === 'function') {
                        // An emit listener may still be an async function; its rejection
                        // cannot reach the synchronous INVARIANT rethrow below, so it is
                        // contained here instead of becoming an unhandled rejection.
                        void Promise.resolve(returned).then(undefined, (error) => {
                            this.warnListenerFailure(registration.ns, error);
                        });
                    }
                }
                catch (error) {
                    if (error?.code === 'INVARIANT') {
                        invariantFailure ??= error;
                        continue;
                    }
                    this.warnListenerFailure(registration.ns, error);
                }
            }
            if (invariantFailure !== undefined)
                throw invariantFailure;
        }
        /** Contained-watcher diagnostic shared by the sync and async failure paths. */
        warnWatcherFailure(ns, error) {
            this.ctx.logger.warn('settings: watcher for "%s" failed', ns);
            this.ctx.logger.warn(error);
        }
        /** Contained-listener diagnostic shared by the sync and async failure paths. */
        warnListenerFailure(ns, error) {
            this.ctx.logger.warn('settings: a settings/updated listener for "%s" failed', ns);
            this.ctx.logger.warn(error);
        }
    };
})();
export { SettingsProvider };
/**
 * Project an already-redacted descriptor as detached, lossless Remote data.
 * @param descriptor - descriptor obtained with secret redaction enabled.
 * @returns a namespace view that carries no provider-owned object references.
 */
export function remoteNamespaceView(descriptor) {
    return {
        ns: String(descriptor.ns),
        schema: snapshotSettingsJson(descriptor.schema),
        value: snapshotSettingsJson(descriptor.value),
        ...descriptor.base === undefined ? {} : { base: snapshotSettingsJson(descriptor.base) },
        ...descriptor.user === undefined ? {} : { user: snapshotSettingsJson(descriptor.user) },
        applies: descriptor.applies,
        secrets: (descriptor.secrets ?? []).map(secret => ({ path: [...secret.path], set: secret.set })),
        revision: descriptor.revision,
    };
}
/**
 * Detach lossless JSON through the same validator used by settings writes.
 * This does not redact secrets; callers own whether the input may cross a wire or journal.
 * @param value - JSON-compatible input to snapshot before asynchronous work.
 * @returns a detached value; unsupported numbers, sparse arrays and cycles reject.
 */
export function snapshotSettingsJson(value) {
    const detached = cloneJsonShaped({ value }, () => new TypeError('settings descriptor contains non-JSON data'))['value'];
    if (detached === undefined)
        throw new TypeError('settings descriptor contains non-JSON data');
    return detached;
}
/**
 * Value mirror of the `FiberState` members {@link isUnloading} compares
 * against: a const enum has no runtime object to import, and the value is
 * needed at runtime (same rationale as the CLI boot driver's mirror).
 */
const FIBER_DISPOSED = 4;
const FIBER_UNLOADING = 5;
/** Whether the consumer's own fiber is tearing down (not just losing the settings service). */
function isUnloading(ctx) {
    const state = ctx.fiber.state;
    return state === FIBER_UNLOADING || state === FIBER_DISPOSED;
}
/**
 * Install the canonical optional-settings consumer wiring: while a settings
 * service exists, register `ns` with the consumer's composition entry as the
 * `base` layer and point the source thunk at the resolved scope; when the
 * service goes away (disposal, provider reload), fall back to the entry so
 * the consumer keeps working exactly as composed. The registration rides the
 * scoped fiber, so no settings service ever mounted means none of this runs.
 * @param ctx - consumer plugin context owning the wiring.
 * @param ns - the consumer-owned settings namespace.
 * @param schema - schema resolving the namespace (typically the plugin Config).
 * @param entry - the consumer's composition entry config, used as `base`.
 * @param hooks - source sink and change notification.
 */
export function installSettingsSection(ctx, ns, schema, entry, hooks) {
    ctx.inject(['settings'], (sctx) => {
        const scope = sctx.settings.register(ns, schema, {
            base: entry,
            ...hooks.validate === undefined ? {} : { validate: hooks.validate },
            ...hooks.validateWrite === undefined ? {} : { validateWrite: hooks.validateWrite },
            ...hooks.redact === undefined ? {} : { redact: hooks.redact },
        });
        hooks.setSource(() => scope.get());
        sctx.effect(() => () => {
            // This disposer runs for two different reasons. A settings provider
            // detaching leaves the consumer running, so it must fall back to its
            // composition entry and re-judge what it derived. The consumer's own
            // unload runs it too — and there `onChange` would re-register routes
            // and touch resources the teardown is releasing, so the fallback is
            // pointless and the notification actively harmful.
            if (isUnloading(ctx))
                return;
            hooks.setSource(() => entry);
            hooks.onChange();
        });
        hooks.onChange();
        scope.watch(() => {
            // A stored change landing while the consumer unloads reaches the watcher
            // before the registration is released, and `onChange` is exactly as
            // harmful here as in the disposer above: it re-registers routes against
            // a fiber whose resources are being let go.
            if (isUnloading(ctx))
                return;
            hooks.onChange();
        });
    });
}
export default SettingsProvider;
//# sourceMappingURL=index.js.map