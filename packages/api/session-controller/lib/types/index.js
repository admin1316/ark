/** Session legacy desktop actions, journal streams, and live control state. */
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
import z from '@deepseek-ai/schemastery';
import { errorChain } from '@deepseek-ai/dsh-llm';
import { canOpenNativePath, openNativePath } from '@deepseek-ai/dsh-native-command';
import { Remote, TypertRemoteFailure, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { ApiSessionAgentController, inspectApiSession, } from "./agent.js";
import { SessionControlController } from "./control.js";
import { SessionHistoryController } from "./history.js";
import { sessionSummaryFor } from "./list.js";
import { buildModelCatalog } from "./catalog.js";
import { SessionSkillCatalog } from "./skill-catalog.js";
export { ApiSessionNotFound } from "./agent.js";
export { SessionSkillCatalog } from "./skill-catalog.js";
/** Desktop and streaming additions to the canonical Session Remote namespace. */
let SessionController = (() => {
    let _classSuper = TypertRemoteService;
    let _instanceExtraInitializers = [];
    let _modelCatalog_decorators;
    let _canOpenWorkspacePath_decorators;
    let _openWorkspacePath_decorators;
    let _page_decorators;
    let _follow_decorators;
    let _control_decorators;
    return class SessionController extends _classSuper {
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
            _modelCatalog_decorators = [Remote('modelCatalog')];
            _canOpenWorkspacePath_decorators = [Remote];
            _openWorkspacePath_decorators = [Remote('openWorkspacePath')];
            _page_decorators = [Remote('page')];
            _follow_decorators = [Remote({ mode: 'stream' })];
            _control_decorators = [Remote({ mode: 'stream' })];
            __esDecorate(this, null, _modelCatalog_decorators, { kind: "method", name: "modelCatalog", static: false, private: false, access: { has: obj => "modelCatalog" in obj, get: obj => obj.modelCatalog }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _canOpenWorkspacePath_decorators, { kind: "method", name: "canOpenWorkspacePath", static: false, private: false, access: { has: obj => "canOpenWorkspacePath" in obj, get: obj => obj.canOpenWorkspacePath }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _openWorkspacePath_decorators, { kind: "method", name: "openWorkspacePath", static: false, private: false, access: { has: obj => "openWorkspacePath" in obj, get: obj => obj.openWorkspacePath }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _page_decorators, { kind: "method", name: "page", static: false, private: false, access: { has: obj => "page" in obj, get: obj => obj.page }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _follow_decorators, { kind: "method", name: "follow", static: false, private: false, access: { has: obj => "follow" in obj, get: obj => obj.follow }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _control_decorators, { kind: "method", name: "control", static: false, private: false, access: { has: obj => "control" in obj, get: obj => obj.control }, metadata: _metadata }, null, _instanceExtraInitializers);
            if (_metadata) Object.defineProperty(this, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        }
        static inject = [
            'agentDefaultModel',
            'agents',
            'attachments',
            'llm',
            'sessions',
            'sessionProjections',
            'sessionQuery',
            'typert',
            'workspaceRegistry',
        ];
        static Config = z.object({
            nativeOpen: z.boolean(),
        });
        agents = __runInitializers(this, _instanceExtraInitializers);
        controlState;
        history;
        openPath;
        canOpenPath;
        promotions = new Set();
        /**
         * @param ctx - Host context containing the Session capability assembly.
         * @param config - native desktop handoff policy.
         */
        constructor(ctx, config, internals = {}) {
            super(ctx, 'sessionController', { namespace: 'session' });
            this.agents = new ApiSessionAgentController(ctx);
            this.controlState = new SessionControlController(ctx);
            // Registered before history so reverse-order teardown closes every
            // follower before waiting for already-admitted promotions.
            ctx.effect(() => async () => {
                await Promise.allSettled([...this.promotions]);
            }, 'session-controller.promotions');
            this.history = new SessionHistoryController(ctx, (observation) => { this.promote(observation); });
            this.openPath = internals.openPath ?? openNativePath;
            this.canOpenPath = internals.canOpenPath
                ?? (() => config.nativeOpen ?? (internals.openPath !== undefined || canOpenNativePath()));
            ctx.plugin(SessionSkillCatalog);
            ctx.on('session/created', (session) => {
                ctx.emit('api-session/added', sessionSummaryFor(ctx, session));
            });
            ctx.on('session/disposed', (session) => {
                ctx.emit('api-session/removed', session.id);
            });
            ctx.on('agent/status', ({ agent, status }) => {
                ctx.emit('api-session/status', agent.id, status === 'running');
            });
            ctx.on('agent/error', ({ agent, error }) => {
                ctx.emit('api-session/error', agent.id, errorChain(error));
            });
            ctx.on('session/event', (session, event) => {
                if (event.type !== 'user/message' || event.data.source.kind !== 'user')
                    return;
                ctx.emit('api-session/activity', session.id, event.time);
            });
        }
        promote(observation) {
            const sessionId = observation.header.id;
            const task = (async () => {
                const env_1 = { stack: [], error: void 0, hasError: false };
                try {
                    const ownedObservation = __addDisposableResource(env_1, observation, false);
                    const result = await this.agents.resolveObservedAgent(ownedObservation);
                    if ('error' in result)
                        this.ctx.emit('api-session/error', sessionId, result.error.message);
                }
                catch (e_1) {
                    env_1.error = e_1;
                    env_1.hasError = true;
                }
                finally {
                    __disposeResources(env_1);
                }
            })().catch((error) => {
                this.ctx.logger.error(`session-controller: background activation for "${sessionId}" failed: ${errorChain(error)}`);
            });
            this.promotions.add(task);
            void task.finally(() => { this.promotions.delete(task); });
        }
        /**
         * Resolve or resume one ordinary Session for another Host API domain.
         * @param sessionId - Session identity whose Agent owns the operation.
         * @returns the live Agent or the stable Session-domain failure.
         */
        resolveAgent(sessionId) {
            return this.agents.resolveAgent(sessionId);
        }
        /**
         * Inspect one attached or persisted Session without activating its Agent.
         * @param sessionId - durable Session identity.
         * @param signal - optional caller cancellation for persistence reads.
         * @returns the current attached state or persisted header and event prefix.
         */
        inspect(sessionId, signal) {
            const attached = this.ctx.sessions.get(sessionId);
            if (attached !== undefined) {
                return Promise.resolve({ meta: attached.header, events: [...attached.events] });
            }
            return inspectApiSession(this.ctx, sessionId, signal);
        }
        /**
         * Describe every currently routable model for Host-generation selectors.
         * @returns provider-grouped models, the deployment default, and isolated provider failures.
         */
        modelCatalog() {
            return buildModelCatalog(this.ctx);
        }
        /**
         * Report whether this deployment can hand a Session workspace path to a native desktop.
         * @returns true when the matching open operation is available.
         */
        canOpenWorkspacePath() {
            return this.canOpenPath();
        }
        /**
         * Open one path prepared by a Session-aware caller on the Host desktop.
         * @param request - path after best-effort Session workspace resolution.
         * @param signal - caller lifetime; abort terminates the native command.
         * @returns confirmation after the native opener accepts the path.
         * @throws TypertRemoteFailure when the request is invalid, cancelled, or the opener fails.
         */
        async openWorkspacePath(request, signal) {
            if (request.path.length === 0) {
                throw new TypertRemoteFailure({
                    code: 'bad-request',
                    message: 'session.openWorkspacePath requires a non-empty path',
                    details: {},
                });
            }
            signal.throwIfAborted();
            try {
                await this.openPath(request.path, signal);
                return { opened: true };
            }
            catch (error) {
                if (signal.aborted) {
                    throw new TypertRemoteFailure({
                        code: 'cancelled', message: 'path open was aborted', details: {},
                    });
                }
                throw new TypertRemoteFailure({
                    code: 'internal',
                    message: `path open failed: ${error instanceof Error ? error.message : String(error)}`,
                    details: {},
                });
            }
        }
        /**
         * Read one cold-safe, message-aligned Session history page.
         * @param request - durable address, backward cursor, and page budget.
         * @param signal - cancellation for persistence reads.
         * @returns one chronological page.
         */
        page(request, signal) {
            return this.history.page(request, signal);
        }
        /**
         * Follow one Session log from its opening or resume cursor.
         * @param request - durable address and last committed sequence already held by the caller.
         * @param signal - cancellation owned by the Remote stream carrier.
         * @returns a complete opening snapshot followed by gap-free event frames.
         */
        follow(request, signal) {
            return this.history.follow(request, signal);
        }
        /**
         * Stream a complete live-control baseline followed by replacement frames.
         * @param signal - cancellation owned by the Remote stream carrier.
         * @returns one complete baseline followed by live replacement frames.
         */
        control(signal) {
            return this.controlState.control(signal);
        }
    };
})();
export { SessionController };
export { buildModelCatalog };
export default SessionController;
//# sourceMappingURL=index.js.map