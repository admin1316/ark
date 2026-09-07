/**
 * LLM service: adapter registry with a waterfall-interceptable streaming call
 * API. Exports the `LlmRuntime` default, the abstract `LlmAdapter` for
 * provider backends, and `BlockAssembler` for chunk assembly.
 *
 * @module @deepseek-ai/dsh-llm
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
var __addDisposableResource = (this && this.__addDisposableResource) || function (env, value, async) {
    if (value !== null && value !== void 0) {
        if (typeof value !== "object" && typeof value !== "function") throw new TypeError("Object expected.");
        var dispose, inner;
        if (async) {
            if (!Symbol.asyncDispose) throw new TypeError("Symbol.asyncDispose is not defined.");
            dispose = value[Symbol.asyncDispose];
        }
        if (dispose === void 0) {
            if (!Symbol.dispose) throw new TypeError("Symbol.dispose is not defined.");
            dispose = value[Symbol.dispose];
            if (async) inner = dispose;
        }
        if (typeof dispose !== "function") throw new TypeError("Object not disposable.");
        if (inner) dispose = function() { try { inner.call(this); } catch (e) { return Promise.reject(e); } };
        env.stack.push({ value: value, dispose: dispose, async: async });
    }
    else if (async) {
        env.stack.push({ async: true });
    }
    return value;
};
var __disposeResources = (this && this.__disposeResources) || (function (SuppressedError) {
    return function (env) {
        function fail(e) {
            env.error = env.hasError ? new SuppressedError(e, env.error, "An error was suppressed during disposal.") : e;
            env.hasError = true;
        }
        var r, s = 0;
        function next() {
            while (r = env.stack.pop()) {
                try {
                    if (!r.async && s === 1) return s = 0, env.stack.push(r), Promise.resolve().then(next);
                    if (r.dispose) {
                        var result = r.dispose.call(r.value);
                        if (r.async) return s |= 2, Promise.resolve(result).then(next, function(e) { fail(e); return next(); });
                    }
                    else s |= 1;
                }
                catch (e) {
                    fail(e);
                }
            }
            if (s === 1) return env.hasError ? Promise.reject(env.error) : Promise.resolve();
            if (env.hasError) throw env.error;
        }
        return next();
    };
})(typeof SuppressedError === "function" ? SuppressedError : function (error, suppressed, message) {
    var e = new Error(message);
    return e.name = "SuppressedError", e.error = error, e.suppressed = suppressed, e;
});
import { createHash } from 'node:crypto';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { settingsNamespace } from '@deepseek-ai/dsh-settings';
import { createUserMessage, freezeMessage } from "./message.js";
import { resolveRetryPolicy } from "./retry-policy.js";
import { callConfigEquals, deepFreeze } from "./call-config.js";
import { LlmError } from "./error.js";
import { normalizeLlmFailure } from "./adapter-failure.js";
import { deadline } from '@deepseek-ai/dsh-timeout';
import { contentHasImage, projectImagesForTextModel } from "./content.js";
import { discoverRemoteModels, listRemoteModels, listRemoteProviders, mutateRemoteProvider, providerTransactionStatus, resumeRemoteProvider, verifyRemoteProvider, } from "./remote.js";
export * from "./attribution.js";
export * from "./brand.js";
export * from "./never.js";
export * from "./error.js";
export * from "./adapter.js";
export * from "./api-key.js";
export * from "./types.js";
export * from "./content.js";
export * from "./message.js";
export * from "./retry-policy.js";
export { BlockAssembler } from "./assembler.js";
export { isCredentialHeaderName, projectRemoteModel } from "./remote.js";
export { callConfigEquals, deepFreeze, isAgentLoopRequest, markAgentLoopRequest } from "./call-config.js";
/**
 * Stable identity for the exact endpoint/protocol a one-shot discovery
 * credential may reach. The fingerprint contains no credential material.
 * @param baseURL - candidate endpoint typed by the caller.
 * @param api - candidate wire protocol, defaulted like the discovery owner.
 * @returns SHA-256 endpoint identity.
 */
export function modelDiscoveryEndpointFingerprint(baseURL, api) {
    const endpoint = baseURL.replace(/\/+$/, '');
    return createHash('sha256').update(JSON.stringify({
        endpoint,
        api: api ?? 'openai-completions',
    })).digest('hex');
}
/**
 * The abstract `llm` service: an adapter registry plus a streaming model-call
 * API, interceptable via the `llm/stream` waterfall.
 */
let LlmRuntime = (() => {
    let _classSuper = TypertRemoteService;
    let _instanceExtraInitializers = [];
    let _remoteProviders_decorators;
    let _remoteMutateProvider_decorators;
    let _remoteProviderTransaction_decorators;
    let _remoteResumeProvider_decorators;
    let _remoteModels_decorators;
    let _remoteDiscoverModels_decorators;
    let _remoteVerifyProvider_decorators;
    return class LlmRuntime extends _classSuper {
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
            _remoteProviders_decorators = [Remote('providers')];
            _remoteMutateProvider_decorators = [Remote('mutateProvider')];
            _remoteProviderTransaction_decorators = [Remote('providerTransaction')];
            _remoteResumeProvider_decorators = [Remote('resumeProvider')];
            _remoteModels_decorators = [Remote('models')];
            _remoteDiscoverModels_decorators = [Remote('discoverModels')];
            _remoteVerifyProvider_decorators = [Remote('verifyProvider')];
            __esDecorate(this, null, _remoteProviders_decorators, { kind: "method", name: "remoteProviders", static: false, private: false, access: { has: obj => "remoteProviders" in obj, get: obj => obj.remoteProviders }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _remoteMutateProvider_decorators, { kind: "method", name: "remoteMutateProvider", static: false, private: false, access: { has: obj => "remoteMutateProvider" in obj, get: obj => obj.remoteMutateProvider }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _remoteProviderTransaction_decorators, { kind: "method", name: "remoteProviderTransaction", static: false, private: false, access: { has: obj => "remoteProviderTransaction" in obj, get: obj => obj.remoteProviderTransaction }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _remoteResumeProvider_decorators, { kind: "method", name: "remoteResumeProvider", static: false, private: false, access: { has: obj => "remoteResumeProvider" in obj, get: obj => obj.remoteResumeProvider }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _remoteModels_decorators, { kind: "method", name: "remoteModels", static: false, private: false, access: { has: obj => "remoteModels" in obj, get: obj => obj.remoteModels }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _remoteDiscoverModels_decorators, { kind: "method", name: "remoteDiscoverModels", static: false, private: false, access: { has: obj => "remoteDiscoverModels" in obj, get: obj => obj.remoteDiscoverModels }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _remoteVerifyProvider_decorators, { kind: "method", name: "remoteVerifyProvider", static: false, private: false, access: { has: obj => "remoteVerifyProvider" in obj, get: obj => obj.remoteVerifyProvider }, metadata: _metadata }, null, _instanceExtraInitializers);
            if (_metadata) Object.defineProperty(this, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        }
        adapters = (__runInitializers(this, _instanceExtraInitializers), new Map());
        directory = new Map();
        discoveries = new Map();
        verifications = new Map();
        constructor(ctx) {
            super(ctx, 'llm');
            ctx.effect(() => () => {
                for (const state of this.verifications.values()) {
                    state.controller.abort(new LlmError('LLM runtime disposed during provider verification', 'ABORTED'));
                }
            }, 'llm.providerVerifications');
            ctx.inject(['settings'], (sctx) => {
                this.syncProtectedSettingsNamespaces(sctx.settings);
            });
        }
        /** Keep generic Settings Remote writes out of provider-owned namespaces. */
        syncProtectedSettingsNamespaces(settings = this.ctx.get('settings')) {
            if (settings === undefined)
                return;
            const namespaces = [...new Set([...this.directory.values()].map(entry => settingsNamespace(entry.settingsNs)))];
            settings.setRemoteProtectedNamespaces(namespaces);
        }
        /**
         * Read configurable providers through the domain-owned Native Remote.
         * @returns the redacted configurable-provider catalog.
         */
        remoteProviders() {
            return listRemoteProviders(this.remoteRuntime());
        }
        /**
         * Commit one idempotent provider settings/credential transaction.
         * @param request - provider mutation and expected revision.
         * @param signal - Caller cancellation before durable claim; claimed commits retain ownership until settled.
         * @returns the committed provider mutation result.
         */
        async remoteMutateProvider(request, signal) {
            return mutateRemoteProvider(this.remoteRuntime(), this.ctx, request, signal);
        }
        /**
         * Read the durable, secret-free state of one provider mutation.
         * @param request - Provider id and transaction UUID to inspect.
         * @returns Current durable phase and whether a staged credential is still required.
         */
        async remoteProviderTransaction(request) {
            return providerTransactionStatus(this.remoteRuntime(), this.ctx, request);
        }
        /**
         * Continue one journaled provider mutation after Host or app restart.
         * @param request - Provider id, transaction UUID, and optional write-only credential replay.
         * @param signal - Caller cancellation before resuming a durable commit.
         * @returns Committed provider view or the transaction's durable terminal failure.
         */
        async remoteResumeProvider(request, signal) {
            return resumeRemoteProvider(this.remoteRuntime(), this.ctx, request, signal);
        }
        /**
         * Read the failure-isolated host-scoped model catalog.
         * @returns the model catalog grouped by provider.
         */
        async remoteModels() {
            return listRemoteModels(this.remoteRuntime());
        }
        /**
         * Interrogate a draft endpoint with an optional write-only one-shot key.
         * @param request - draft endpoint and discovery options.
         * @param signal - caller-owned cancellation signal.
         * @returns discovered models and provider diagnostics.
         */
        async remoteDiscoverModels(request, signal) {
            return discoverRemoteModels(this.remoteRuntime(), request, signal);
        }
        /**
         * Execute one bounded exact provider/model/auth probe.
         * @param request - Exact provider and model route to verify.
         * @param signal - Caller cancellation combined with the Host verification deadline.
         * @returns Verification mode used by the adapter or fallback request.
         */
        async remoteVerifyProvider(request, signal) {
            return verifyRemoteProvider(this.remoteRuntime(), request, signal);
        }
        /** Present only public LLM operations to the Remote adapter. */
        remoteRuntime() {
            return {
                listProviders: () => this.listProviders(),
                listConfigurableProviders: () => this.listConfigurableProviders(),
                listModels: provider => this.listModels(provider),
                resolveModelInfo: (provider, model, signal) => this.resolveModelInfo(provider, model, signal),
                discoverModels: (settingsNs, request) => this.discoverModels(settingsNs, request),
                verifyModel: (provider, model, signal) => this.verifyModel(provider, model, signal),
            };
        }
        /** Notify topology observers without letting one broken listener veto the commit. */
        emitAdaptersUpdated() {
            // Cordis emit uses Array.map: one synchronous throw starves later
            // listeners. Registry notifications are non-vetoing, so contain each
            // callback independently; INVARIANT-coded failures still surface.
            let invariantFailure;
            for (const listener of this.ctx.events.dispatch('emit', ['llm/adapters-updated'])) {
                try {
                    const returned = listener();
                    if (returned != null && typeof returned.then === 'function') {
                        // An emit listener may still be an async function; its rejection
                        // cannot reach the synchronous INVARIANT rethrow below, so it is
                        // contained here instead of becoming an unhandled rejection.
                        void Promise.resolve(returned).then(undefined, (error) => {
                            this.warnAdaptersListenerFailure(error);
                        });
                    }
                }
                catch (error) {
                    if (error?.code === 'INVARIANT') {
                        invariantFailure ??= error;
                        continue;
                    }
                    this.warnAdaptersListenerFailure(error);
                }
            }
            if (invariantFailure !== undefined)
                throw invariantFailure;
        }
        /** Contained-listener diagnostic shared by the sync and async failure paths. */
        warnAdaptersListenerFailure(error) {
            this.ctx.logger.warn('llm: an llm/adapters-updated listener failed');
            this.ctx.logger.warn(error);
        }
        /** Release a fire-and-forget registration without leaking cleanup failures. */
        disposeRegistration(dispose, owner) {
            try {
                void Promise.resolve(dispose()).catch((error) => {
                    this.warnRegistrationDisposalFailure(owner, error);
                });
            }
            catch (error) {
                this.warnRegistrationDisposalFailure(owner, error);
            }
        }
        /** Record a registration cleanup failure through the service logger. */
        warnRegistrationDisposalFailure(owner, error) {
            this.ctx.logger.warn(`llm: ${owner}: disposal failed`);
            this.ctx.logger.warn(error);
        }
        /**
         * Register an adapter for the given provider routes. Throws `LlmError` with code
         * `DUPLICATE_ADAPTER` if any provider already has an adapter (all-or-nothing).
         * Disposed with the fiber.
         * @param providers - every provider route this adapter should serve.
         * @param adapter - the adapter that streams calls for those providers.
         * @returns the disposer, carrying {@link AdapterRegistrationHandle.replace}.
         */
        registerAdapter(providers, adapter) {
            // The routes this registration currently holds; `replace` rewrites it, and
            // the disposer releases whatever it holds at disposal time.
            const owned = new Set();
            // The disposer has run: `owned` being empty cannot say so on its own,
            // because `replace([])` legally leaves a live registration holding none.
            let released = false;
            const dispose = this.ctx.effect(function* () {
                if (providers.length === 0)
                    throw new LlmError('an adapter must register at least one provider', 'INVALID_ADAPTER');
                this.commitRoutes(owned, this.prepareRoutes(providers, adapter, owned));
                yield () => {
                    released = true;
                    for (const provider of owned)
                        this.adapters.delete(provider);
                    owned.clear();
                    this.emitAdaptersUpdated();
                };
            }.bind(this), 'llm.registerAdapter()');
            // The public handle is synchronous fire-and-forget: cleanup diagnostics
            // are logged, never leaked as a throw or unhandled rejection.
            const handle = (() => {
                this.disposeRegistration(dispose, 'registerAdapter()');
            });
            handle.replace = (next) => {
                // Registering here would leak: the effect's disposer already ran, so
                // nothing remains to release whatever this call would put in the map.
                if (released) {
                    throw new LlmError('a disposed adapter registration cannot replace its routes', 'REGISTRATION_DISPOSED');
                }
                this.commitRoutes(owned, this.prepareRoutes(next, adapter, owned));
            };
            return handle;
        }
        /**
         * Validate one candidate route set for `adapter`, treating routes this
         * registration already holds as available. Nothing is mutated: a rejected
         * candidate leaves the registry exactly as it was.
         */
        prepareRoutes(providers, adapter, owned) {
            const unique = new Set();
            const registrations = [];
            for (const provider of providers) {
                if (provider.length === 0)
                    throw new LlmError('adapter provider names must be non-empty', 'INVALID_ADAPTER');
                if (unique.has(provider) || (this.adapters.has(provider) && !owned.has(provider))) {
                    throw new LlmError(`an adapter for provider "${provider}" is already registered`, 'DUPLICATE_ADAPTER');
                }
                const info = adapter.providerInfo(provider);
                if (typeof info.id !== 'string' || info.id !== provider || typeof info.name !== 'string' || info.name.length === 0) {
                    throw new LlmError(`adapter metadata for provider "${provider}" must preserve its id and have a non-empty name`, 'INVALID_ADAPTER');
                }
                unique.add(provider);
                const retryPolicy = adapter.providerRetryPolicy(provider)
                    ?? resolveRetryPolicy(undefined, `llm: provider "${provider}" retryPolicy`);
                registrations.push({
                    adapter,
                    provider: { id: info.id, name: info.name },
                    retryPolicy,
                });
            }
            return registrations;
        }
        /**
         * Swap this registration's routes for the prepared ones in one synchronous
         * section, so no observer can see the registry between the release and the
         * re-registration. The route set's one mutation point is also where
         * `llm/adapters-updated` is published, so a `replace` announces itself
         * exactly like a first registration.
         */
        commitRoutes(owned, registrations) {
            for (const provider of owned)
                this.adapters.delete(provider);
            owned.clear();
            for (const registration of registrations) {
                this.adapters.set(registration.provider.id, registration);
                owned.add(registration.provider.id);
            }
            this.emitAdaptersUpdated();
        }
        /**
         * Describe provider routes with a registered adapter.
         * @returns detached provider metadata in registration order.
         */
        listProviders() {
            return [...this.adapters.values()].map(({ provider }) => ({ ...provider }));
        }
        /**
         * Declare provider routes an adapter plugin can activate through
         * configuration. Registration is all-or-nothing: an empty list, invalid
         * entry, or a provider already declared by any registration throws
         * `LlmError` without registering the rest. Disposed with the fiber.
         * @param entries - every configurable provider this plugin owns.
         * @returns a handle that withdraws all of them, and can atomically replace them.
         */
        registerConfigurableProviders(entries) {
            let held = [];
            let disposed = false;
            /**
             * Validate a candidate set in full against everything this registration
             * does not already hold, then publish it. Nothing is written until the
             * whole set passes, so a refused candidate leaves the current entries in
             * place — the property that makes `replace` a swap rather than a
             * delete-then-add that can strand the directory empty.
             */
            const commit = (candidates) => {
                const detached = [];
                const own = new Set(held.map(entry => entry.provider));
                for (const entry of candidates) {
                    if (entry.provider.length === 0 || entry.displayName.length === 0 || entry.settingsNs.length === 0) {
                        throw new LlmError('configurable providers need a non-empty provider, displayName, and settingsNs', 'INVALID_DIRECTORY');
                    }
                    settingsNamespace(entry.settingsNs);
                    if (entry.settingsPath.some(segment => segment.length === 0)) {
                        throw new LlmError(`configurable provider "${entry.provider}" has an empty settingsPath segment`, 'INVALID_DIRECTORY');
                    }
                    if (entry.migrationRequired !== undefined
                        && (entry.migrationRequired.fields.length === 0
                            || entry.migrationRequired.fields.some(field => field.length === 0))) {
                        throw new LlmError(`configurable provider "${entry.provider}" has invalid migration metadata`, 'INVALID_DIRECTORY');
                    }
                    if ((this.directory.has(entry.provider) && !own.has(entry.provider))
                        || detached.some(seen => seen.provider === entry.provider)) {
                        throw new LlmError(`configurable provider "${entry.provider}" is already declared`, 'DUPLICATE_DIRECTORY');
                    }
                    detached.push({
                        ...entry,
                        settingsPath: [...entry.settingsPath],
                        ...entry.migrationRequired === undefined ? {} : {
                            migrationRequired: {
                                code: entry.migrationRequired.code,
                                fields: [...entry.migrationRequired.fields],
                            },
                        },
                    });
                }
                for (const entry of held)
                    this.directory.delete(entry.provider);
                for (const entry of detached)
                    this.directory.set(entry.provider, entry);
                held = detached;
                this.syncProtectedSettingsNamespaces();
                this.emitAdaptersUpdated();
            };
            const dispose = this.ctx.effect(function* () {
                if (entries.length === 0) {
                    throw new LlmError('a configurable-provider registration must declare at least one provider', 'INVALID_DIRECTORY');
                }
                commit(entries);
                yield () => {
                    disposed = true;
                    for (const entry of held)
                        this.directory.delete(entry.provider);
                    held = [];
                    this.syncProtectedSettingsNamespaces();
                    this.emitAdaptersUpdated();
                };
            }.bind(this), 'llm.registerConfigurableProviders()');
            const handle = (() => {
                this.disposeRegistration(dispose, 'registerConfigurableProviders()');
            });
            handle.replace = (next) => {
                if (disposed) {
                    throw new LlmError('this configurable-provider registration was disposed', 'REGISTRATION_DISPOSED');
                }
                commit(next);
            };
            return handle;
        }
        /**
         * List every declared configurable provider, registered or dormant.
         * @returns detached directory entries in declaration order.
         */
        listConfigurableProviders() {
            return [...this.directory.values()].map(entry => ({
                ...entry,
                settingsPath: [...entry.settingsPath],
                ...entry.migrationRequired === undefined ? {} : {
                    migrationRequired: {
                        code: entry.migrationRequired.code,
                        fields: [...entry.migrationRequired.fields],
                    },
                },
            }));
        }
        /**
         * Offer to interrogate provider endpoints on behalf of the settings
         * namespace this plugin owns. The namespace is the key because that is what
         * a configuration surface already holds from the configurable-provider
         * directory, and because a provider being *added* has no route to name yet.
         * Disposed with the fiber.
         * @param settingsNs - the namespace whose profiles this discovery serves.
         * @param discover - interrogates one endpoint; must honor `request.signal`.
         * @returns the disposer that withdraws the offer.
         */
        registerModelDiscovery(settingsNs, discover) {
            const dispose = this.ctx.effect(function* () {
                if (settingsNs.length === 0) {
                    throw new LlmError('model discovery needs a non-empty settings namespace', 'INVALID_DISCOVERY');
                }
                if (this.discoveries.has(settingsNs)) {
                    throw new LlmError(`model discovery for "${settingsNs}" is already registered`, 'DUPLICATE_DISCOVERY');
                }
                this.discoveries.set(settingsNs, discover);
                yield () => {
                    this.discoveries.delete(settingsNs);
                };
            }.bind(this), 'llm.registerModelDiscovery()');
            return () => {
                this.disposeRegistration(dispose, 'registerModelDiscovery()');
            };
        }
        /**
         * Interrogate one provider endpoint for the models it advertises. The
         * request describes a draft, not a stored route, so nothing here reads or
         * writes settings or credentials — the caller owns both, and the reply is
         * candidate metadata a surface may offer for adoption.
         * @param settingsNs - namespace whose registered discovery serves this draft.
         * @param request - the endpoint, protocol, and one-shot credential to use.
         * @returns the advertised models, deduplicated in endpoint order.
         */
        async discoverModels(settingsNs, request) {
            const discover = this.discoveries.get(settingsNs);
            if (discover === undefined) {
                throw new LlmError(`no model discovery is registered for "${settingsNs}"`, 'NO_DISCOVERY');
            }
            // One of the two identifies what to describe: a route the adapter knows, or
            // an endpoint to ask. Neither leaves nothing to answer about.
            if ((request.provider ?? '').length === 0 && (request.baseURL ?? '').length === 0) {
                throw new LlmError('model discovery needs a provider route or a baseURL', 'INVALID_DISCOVERY');
            }
            const bound = request.apiKey === undefined
                ? request
                : {
                    ...request,
                    credentialEndpointFingerprint: modelDiscoveryEndpointFingerprint(request.baseURL ?? '', request.api),
                };
            if (request.apiKey !== undefined && (request.baseURL ?? '').length === 0) {
                throw new LlmError('a one-shot discovery credential requires its exact candidate baseURL', 'INVALID_DISCOVERY');
            }
            const discovered = await discover(bound);
            const seen = new Set();
            const models = [];
            for (const model of discovered) {
                if (typeof model.id !== 'string' || model.id.length === 0 || seen.has(model.id))
                    continue;
                seen.add(model.id);
                models.push({
                    id: model.id,
                    ...model.name === undefined ? {} : { name: model.name },
                    ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
                    ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
                });
            }
            return models;
        }
        /**
         * Resolve the retry policy captured when one provider route was registered.
         * @param provider - registered provider route to inspect.
         * @returns the provider-owned policy, with normal defaults already resolved.
         */
        providerRetryPolicy(provider) {
            return this.registration(provider).retryPolicy;
        }
        /**
         * Resolve route-owned request-image pricing without performing I/O. Unknown
         * routes intentionally degrade to heuristic pricing for historical logs.
         * @param provider - provider route whose registered adapter owns pricing.
         * @param model - exact model id whose image occurrences will be priced.
         * @returns route-owned pricing, or `undefined` when the route supplies none.
         */
        imageRequestPricing(provider, model) {
            return this.adapters.get(provider)?.adapter.imageRequestPricing(provider, model);
        }
        /** Detach typed adapter-owned modality metadata. */
        detachedModalities(modalities) {
            return modalities === undefined ? undefined : [...modalities];
        }
        /**
         * Discover models advertised by one registered provider. Catalog membership
         * is advisory and never changes routing or request validation.
         * @param provider - registered provider route to inspect.
         * @returns detached model metadata in adapter-preferred order.
         */
        async listModels(provider) {
            const adapter = this.registration(provider).adapter;
            const models = await adapter.listModels(provider);
            const seen = new Set();
            return models.map((model) => {
                if (typeof model.provider !== 'string'
                    || model.provider !== provider
                    || typeof model.id !== 'string'
                    || model.id.length === 0
                    || typeof model.name !== 'string'
                    || model.name.length === 0
                    || (model.description !== undefined && typeof model.description !== 'string')
                    || seen.has(model.id)) {
                    throw new LlmError(`adapter returned invalid or duplicate model metadata for provider "${provider}"`, 'INVALID_CATALOG');
                }
                seen.add(model.id);
                const inputModalities = this.detachedModalities(model.inputModalities);
                return {
                    provider: model.provider,
                    id: model.id,
                    name: model.name,
                    ...model.description === undefined ? {} : { description: model.description },
                    ...inputModalities === undefined ? {} : { inputModalities },
                };
            });
        }
        /**
         * Resolve and validate all metadata from the adapter that owns one exact
         * route. The result is detached from adapter-owned objects; catalog
         * membership remains advisory and does not control request routing.
         * @param provider - registered provider route to inspect.
         * @param model - exact model id passed to the adapter.
         * @param signal - optional cancellation for adapter-owned asynchronous lookup.
         * @returns exact model identity plus available context and reasoning metadata.
         */
        async resolveModelInfo(provider, model, signal) {
            return this.resolveModelInfoFor(this.registration(provider), model, signal);
        }
        /**
         * Prove an exact provider/model route can authenticate and complete a bounded
        * request. The caller supplies the deadline signal; no output is retained or
        * returned to configuration surfaces.
         * @param provider - Registered provider route to authenticate.
         * @param model - Exact model id to probe.
         * @param signal - Caller-owned deadline and cancellation signal.
         * @returns Adapter-native or bounded fallback verification mode.
         */
        async verifyModel(provider, model, signal) {
            signal.throwIfAborted();
            const key = `${provider}\0${model}`;
            if (this.verifications.has(key)) {
                throw new LlmError(`provider verification for "${provider}/${model}" is still running`, 'VERIFICATION_STILL_RUNNING');
            }
            const registration = this.registration(provider);
            const controller = new AbortController();
            const operation = this.performProviderVerification(registration, provider, model, controller.signal);
            const state = { controller, operation };
            this.verifications.set(key, state);
            void operation.then(() => { if (this.verifications.get(key) === state)
                this.verifications.delete(key); }, () => { if (this.verifications.get(key) === state)
                this.verifications.delete(key); });
            const aborted = Promise.withResolvers();
            const forwardAbort = () => { aborted.resolve('aborted'); };
            signal.addEventListener('abort', forwardAbort, { once: true });
            if (signal.aborted)
                forwardAbort();
            try {
                const outcome = await Promise.race([
                    operation.then(mode => ({ kind: 'completed', mode }), (error) => ({ kind: 'failed', error })),
                    aborted.promise.then(() => ({ kind: 'aborted' })),
                ]);
                if (outcome.kind === 'completed') {
                    signal.throwIfAborted();
                    return outcome.mode;
                }
                if (outcome.kind === 'failed')
                    throw outcome.error;
                controller.abort(signal.reason);
                if (!await settlesWithin(operation, 2_000)) {
                    throw new LlmError(`provider verification for "${provider}/${model}" ignored cancellation and is still running`, 'VERIFICATION_STILL_RUNNING');
                }
                signal.throwIfAborted();
                throw new LlmError('provider verification aborted', 'ABORTED');
            }
            finally {
                signal.removeEventListener('abort', forwardAbort);
            }
        }
        /** Adapter-native metadata probe, falling back to one discarded-token handshake. */
        async performProviderVerification(registration, provider, model, signal) {
            const native = await registration.adapter.verifyProvider(provider, model, signal);
            if (native !== undefined)
                return native;
            const adapterCall = await registration.adapter.prepareCall(provider, model, signal);
            const modelInfo = this.normalizeModelInfo(registration, model, adapterCall.model);
            const config = this.resolveCallWithInfo({ provider, model, maxTokens: 1 }, modelInfo).config;
            let finish;
            for await (const chunk of adapterCall.stream({
                ...config,
                messages: [createUserMessage({
                        // Smallest portable fallback: one punctuation token in, at most one
                        // token out, and every output chunk is discarded by this owner.
                        content: [{ type: 'text', text: '.' }],
                        source: { kind: 'plugin', plugin: 'llm-verification' },
                    })],
                signal,
            })) {
                if (chunk.type === 'finish')
                    finish = chunk.reason;
            }
            signal.throwIfAborted();
            if (finish === undefined)
                throw new LlmError('provider verification stream closed without a terminal frame', 'STREAM_CLOSED');
            if (finish.kind === 'error' || finish.kind === 'aborted') {
                throw new LlmError(finish.failure.message, finish.failure.code);
            }
            return 'minimal-generation';
        }
        async resolveModelInfoFor(registration, model, signal) {
            const resolved = await registration.adapter.resolveModel(registration.provider.id, model, signal);
            return this.normalizeModelInfo(registration, model, resolved);
        }
        /** Validate and detach one adapter-returned exact model result. */
        normalizeModelInfo(registration, model, resolved) {
            const provider = registration.provider.id;
            if (typeof resolved.provider !== 'string'
                || resolved.provider !== provider
                || typeof resolved.id !== 'string'
                || resolved.id !== model
                || typeof resolved.name !== 'string'
                || resolved.name.length === 0
                || (resolved.description !== undefined && typeof resolved.description !== 'string')) {
                throw new LlmError(`adapter returned invalid exact model metadata for provider "${provider}" model "${model}"`, 'INVALID_MODEL_INFO');
            }
            const context = resolved.context;
            if (context !== undefined && (!Number.isInteger(context.contextWindow) || context.contextWindow <= 0)) {
                throw new LlmError(`adapter returned invalid context metadata for provider "${provider}" model "${model}"`, 'INVALID_MODEL_CONTEXT');
            }
            // Capability metadata rides through: an explicit modality omission is
            // negative capability downstream preflights act on (image admission).
            const inputModalities = this.detachedModalities(resolved.inputModalities);
            const defaultMaxTokens = resolved.defaultMaxTokens;
            if (defaultMaxTokens !== undefined
                && (!Number.isSafeInteger(defaultMaxTokens) || defaultMaxTokens <= 0)) {
                throw new LlmError(`adapter returned invalid default maxTokens for provider "${provider}" model "${model}"`, 'INVALID_MODEL_MAX_TOKENS');
            }
            const info = {
                provider,
                id: model,
                name: resolved.name,
                ...resolved.description === undefined ? {} : { description: resolved.description },
                ...inputModalities === undefined ? {} : { inputModalities },
                ...context === undefined ? {} : { context: { contextWindow: context.contextWindow } },
                ...defaultMaxTokens === undefined ? {} : { defaultMaxTokens },
            };
            const reasoning = resolved.reasoning;
            if (reasoning === undefined)
                return info;
            if (reasoning.efforts.length === 0) {
                throw new LlmError(`adapter returned invalid reasoning metadata for provider "${provider}" model "${model}"`, 'INVALID_MODEL_REASONING');
            }
            const seen = new Set();
            const efforts = reasoning.efforts.map((effort) => {
                if (typeof effort.id !== 'string'
                    || effort.id.length === 0
                    || typeof effort.name !== 'string'
                    || effort.name.length === 0
                    || (effort.description !== undefined && typeof effort.description !== 'string')
                    || seen.has(effort.id)) {
                    throw new LlmError(`adapter returned invalid or duplicate reasoning effort metadata for provider "${provider}" model "${model}"`, 'INVALID_MODEL_REASONING');
                }
                seen.add(effort.id);
                return {
                    id: effort.id,
                    name: effort.name,
                    ...effort.description === undefined ? {} : { description: effort.description },
                };
            });
            if (reasoning.defaultEffort !== undefined && !seen.has(reasoning.defaultEffort)) {
                throw new LlmError(`adapter returned an unknown default reasoning effort for provider "${provider}" model "${model}"`, 'INVALID_MODEL_REASONING');
            }
            return {
                ...info,
                reasoning: {
                    efforts,
                    ...reasoning.defaultEffort === undefined ? {} : { defaultEffort: reasoning.defaultEffort },
                },
            };
        }
        /**
         * Validate a conversation call config against its exact model capability and
         * materialize adapter-configured defaults. Unsupported explicit efforts
         * reject before provider I/O; no clamping or aliasing is performed. This
         * standalone query does not bind a later dispatch; use {@link prepareCall}
         * when logging and streaming must share one adapter registration.
         * @param config - provider/model route and optional request controls.
         * @param signal - optional cancellation for adapter-owned capability lookup.
         * @returns a detached config only when a default must be materialized.
         */
        async resolveCallConfig(config, signal) {
            return (await this.resolveCallFor(this.registration(config.provider), config, signal)).config;
        }
        async resolveCallFor(registration, config, signal) {
            const info = await this.resolveModelInfoFor(registration, config.model, signal);
            return this.resolveCallWithInfo(config, info);
        }
        /** Validate request controls against one already-bound exact model result. */
        resolveCallWithInfo(config, info) {
            const defaulted = config.maxTokens === undefined && info.defaultMaxTokens !== undefined
                ? { ...config, maxTokens: info.defaultMaxTokens }
                : config;
            const reasoning = info.reasoning;
            const requested = defaulted.reasoningEffort;
            let resolvedConfig = defaulted;
            if (reasoning === undefined) {
                if (requested !== undefined) {
                    throw new LlmError(`provider "${config.provider}" model "${config.model}" does not support reasoning effort "${requested}"`, 'UNSUPPORTED_REASONING_EFFORT');
                }
            }
            else {
                const effective = requested ?? reasoning.defaultEffort;
                if (effective !== undefined) {
                    if (!reasoning.efforts.some(effort => effort.id === effective)) {
                        throw new LlmError(`provider "${config.provider}" model "${config.model}" does not support reasoning effort "${effective}"`, 'UNSUPPORTED_REASONING_EFFORT');
                    }
                    if (requested !== effective)
                        resolvedConfig = { ...defaulted, reasoningEffort: effective };
                }
            }
            return {
                config: resolvedConfig,
                ...info.context === undefined ? {} : { context: info.context },
                modelInfo: info,
            };
        }
        /**
         * Resolve one call under its current adapter registration. The returned
         * one-shot handle keeps that registration across header logging and dispatch,
         * so HMR cannot combine one adapter's capability result with another adapter.
         * @param config - provider/model route and optional request controls.
         * @param signal - optional cancellation for adapter-owned capability lookup.
         * @returns a prepared config and its registration-bound stream entry point.
         */
        async prepareCall(config, signal) {
            const registration = this.registration(config.provider);
            const adapterCall = await registration.adapter.prepareCall(config.provider, config.model, signal);
            const modelInfo = this.normalizeModelInfo(registration, config.model, adapterCall.model);
            const resolved = this.resolveCallWithInfo(config, modelInfo);
            const resolvedConfig = deepFreeze(structuredClone(resolved.config));
            const context = resolved.context === undefined
                ? undefined
                : deepFreeze(structuredClone(resolved.context));
            const adapterDefaults = deepFreeze({
                ...config.reasoningEffort === undefined && resolvedConfig.reasoningEffort !== undefined
                    ? { reasoningEffort: true }
                    : {},
                ...config.maxTokens === undefined && resolvedConfig.maxTokens !== undefined
                    ? { maxTokens: true }
                    : {},
            });
            let dispatched = false;
            return Object.freeze({
                config: resolvedConfig,
                retryPolicy: registration.retryPolicy,
                adapterDefaults,
                ...context === undefined ? {} : { context },
                ...modelInfo.inputModalities === undefined
                    ? {}
                    : { inputModalities: Object.freeze([...modelInfo.inputModalities]) },
                stream: (options) => {
                    if (dispatched) {
                        throw new LlmError('a prepared LLM call can only be dispatched once', 'INVALID_PREPARED_CALL');
                    }
                    if (!callConfigEquals(options, resolvedConfig)) {
                        throw new LlmError('prepared LLM call config changed before adapter dispatch', 'INVALID_PREPARED_CALL');
                    }
                    dispatched = true;
                    return this.streamWithRegistration(options, {
                        registration,
                        config: resolvedConfig,
                        modelInfo,
                        dispatch: options => adapterCall.stream(options),
                    });
                },
            });
        }
        registration(provider) {
            const registration = this.adapters.get(provider);
            if (!registration)
                throw new LlmError(`no adapter registered for provider "${provider}"`, 'NO_ADAPTER');
            return registration;
        }
        /** Remove replay state whose historical route is owned by another adapter. */
        forAdapter(options, adapter) {
            const messages = options.messages.map((message) => {
                const source = message.source;
                if (message.role !== 'assistant' || source.kind !== 'model' || source.replayState === undefined)
                    return message;
                if (this.adapters.get(source.provider)?.adapter === adapter)
                    return message;
                return freezeMessage({
                    ...message,
                    source: { kind: 'model', provider: source.provider, model: source.model },
                });
            });
            if (messages.every((message, index) => message === options.messages[index]))
                return options;
            const filtered = { ...options, messages };
            return Object.isFrozen(options) ? deepFreeze(filtered) : filtered;
        }
        /**
         * Final adapter boundary. Adapter selection, dispatch, iterator construction,
         * and iteration failures become one terminal failure chunk. Middleware and
         * downstream consumer failures remain thrown plugin or consumer errors.
         */
        async *adapterStream(options, prepared) {
            let iterator;
            try {
                const registration = prepared?.registration ?? this.registration(options.provider);
                const adapter = registration.adapter;
                let modelInfo;
                let resolvedConfig;
                let dispatch;
                if (prepared === undefined) {
                    const adapterCall = await adapter.prepareCall(options.provider, options.model, options.signal);
                    modelInfo = this.normalizeModelInfo(registration, options.model, adapterCall.model);
                    resolvedConfig = this.resolveCallWithInfo(options, modelInfo).config;
                    dispatch = options => adapterCall.stream(options);
                }
                else {
                    modelInfo = prepared.modelInfo;
                    resolvedConfig = prepared.config;
                    dispatch = prepared.dispatch;
                }
                if (prepared !== undefined && !callConfigEquals(options, resolvedConfig)) {
                    throw new LlmError('prepared LLM call config changed before adapter dispatch', 'INVALID_PREPARED_CALL');
                }
                const resolvedOptions = callConfigEquals(options, resolvedConfig)
                    ? options
                    : Object.isFrozen(options)
                        ? deepFreeze({ ...options, ...resolvedConfig })
                        : { ...options, ...resolvedConfig };
                const projectedOptions = modelInfo.inputModalities !== undefined
                    && !modelInfo.inputModalities.includes('image')
                    && resolvedOptions.messages.some(message => contentHasImage(message.content))
                    ? Object.isFrozen(resolvedOptions)
                        ? deepFreeze({ ...resolvedOptions, messages: projectImagesForTextModel(resolvedOptions.messages) })
                        : { ...resolvedOptions, messages: projectImagesForTextModel(resolvedOptions.messages) }
                    : resolvedOptions;
                const stream = dispatch(this.forAdapter(projectedOptions, adapter));
                iterator = stream[Symbol.asyncIterator]();
            }
            catch (error) {
                yield adapterFailureChunk(error, options.signal);
                return;
            }
            let completed = false;
            try {
                while (true) {
                    let item;
                    try {
                        const next = await iterator.next();
                        item = next.done
                            ? { done: true }
                            : { done: false, value: next.value };
                    }
                    catch (error) {
                        completed = true;
                        yield adapterFailureChunk(error, options.signal);
                        return;
                    }
                    if (item.done) {
                        completed = true;
                        return;
                    }
                    // End the adapter-owned try before yielding: consumer/middleware
                    // failures resumed into this generator must remain thrown.
                    yield item.value;
                }
            }
            finally {
                if (!completed) {
                    try {
                        const close = iterator.return?.bind(iterator);
                        if (close)
                            await close();
                    }
                    catch (error) {
                        this.ctx.logger.warn('llm: adapter stream cleanup failed');
                        this.ctx.logger.warn(error);
                    }
                }
            }
        }
        /**
         * Stream one model call as raw chunks (token-level deltas). Replay state is
         * retained only when the same adapter instance owns its historical provider
         * and the target provider. Final adapter selection remains fixed through
         * asynchronous exact-model resolution and dispatch. Adapter selection,
         * dispatch, and iteration failures become terminal `error` or `aborted`
         * finish chunks; middleware, nested-call, and consumer failures remain
         * thrown. A downstream-close cleanup failure is logged so it cannot mask
         * the consumer's own completion or failure.
         * @param options - the full request; `options.provider` selects the adapter.
         * @returns the chunk stream, possibly wrapped by `llm/stream` listeners.
         */
        stream(options) {
            return this.streamWithRegistration(options);
        }
        streamWithRegistration(options, prepared) {
            return this.ctx.waterfall(this, 'llm/stream', options, () => this.adapterStream(options, prepared));
        }
    };
})();
export { LlmRuntime };
/** Convert one adapter throw into the stream protocol's terminal outcome. */
function adapterFailureChunk(error, signal) {
    const failure = normalizeLlmFailure(error);
    return {
        type: 'finish',
        reason: signal?.aborted || failure.code === 'ABORTED'
            ? { kind: 'aborted', failure }
            : { kind: 'error', failure },
    };
}
export default LlmRuntime;
/** Wait briefly for an aborted adapter operation to prove ownership quiescence. */
async function settlesWithin(operation, timeoutMs) {
    const env_1 = { stack: [], error: void 0, hasError: false };
    try {
        const timeout = __addDisposableResource(env_1, deadline(undefined, timeoutMs, 'LLM_ABORT_QUIESCENCE_TIMEOUT'), false);
        return await Promise.race([
            operation.then(() => true, () => true),
            new Promise((resolve) => {
                timeout.signal.addEventListener('abort', () => { resolve(false); }, { once: true });
            }),
        ]);
    }
    catch (e_1) {
        env_1.error = e_1;
        env_1.hasError = true;
    }
    finally {
        __disposeResources(env_1);
    }
}
//# sourceMappingURL=index.js.map