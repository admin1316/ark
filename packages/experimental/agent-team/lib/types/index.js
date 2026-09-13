/** Remote adapter over the single supported Agent Teams domain service. */
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
import { TeamError } from '@deepseek-ai/dsh-agent-team';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
export * from '@deepseek-ai/dsh-agent-team';
/** Keeps the experimental Remote wire namespace without owning Team state or lifetime. */
let TeamRemoteAdapter = (() => {
    let _classSuper = TypertRemoteService;
    let _instanceExtraInitializers = [];
    let _remoteView_decorators;
    let _remoteCreateTask_decorators;
    let _remoteUpdateTask_decorators;
    return class TeamRemoteAdapter extends _classSuper {
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
            _remoteView_decorators = [Remote('view')];
            _remoteCreateTask_decorators = [Remote('createTask')];
            _remoteUpdateTask_decorators = [Remote('updateTask')];
            __esDecorate(this, null, _remoteView_decorators, { kind: "method", name: "remoteView", static: false, private: false, access: { has: obj => "remoteView" in obj, get: obj => obj.remoteView }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _remoteCreateTask_decorators, { kind: "method", name: "remoteCreateTask", static: false, private: false, access: { has: obj => "remoteCreateTask" in obj, get: obj => obj.remoteCreateTask }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _remoteUpdateTask_decorators, { kind: "method", name: "remoteUpdateTask", static: false, private: false, access: { has: obj => "remoteUpdateTask" in obj, get: obj => obj.remoteUpdateTask }, metadata: _metadata }, null, _instanceExtraInitializers);
            if (_metadata) Object.defineProperty(this, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        }
        static inject = ['agentTeams'];
        constructor(ctx) {
            super(ctx, 'agentTeamRemote', { namespace: 'agentTeams' });
            __runInitializers(this, _instanceExtraInitializers);
        }
        /**
         * Read the current roster and non-deleted task board through the generated Remote API.
         * @param agent - exact live Team member used as the authority credential.
         * @returns detached current roster and task views.
         */
        remoteView(agent) {
            return {
                members: this.ctx.agentTeams.listMembers(agent),
                tasks: this.ctx.agentTeams.listTasks(agent),
            };
        }
        /**
         * Create one shared task through the generated Remote API.
         * @param agent - exact live Team member creating the task.
         * @param request - task text, blockers, and advisory write scopes.
         * @returns the revision-one task or a typed Team rejection.
         */
        remoteCreateTask(agent, request) {
            return this.taskMutationResult(this.ctx.agentTeams.createTask(agent, request));
        }
        /**
         * Apply one task mutation and preserve Team rejections as business results.
         * @param agent - exact live Team member authorizing the mutation.
         * @param request - task identity, expected revision, action, and action fields.
         * @returns the committed task or a typed Team rejection.
         */
        remoteUpdateTask(agent, request) {
            return this.taskMutationResult(this.ctx.agentTeams.updateTask(agent, request));
        }
        /** Preserve Team task rejections while allowing unexpected failures to reject the Remote call. */
        async taskMutationResult(operation) {
            try {
                return { ok: true, value: await operation };
            }
            catch (error) {
                if (!(error instanceof TeamError))
                    throw error;
                return {
                    ok: false,
                    error: {
                        code: error.code === 'TEAM_TASK_STALE_REVISION' ? 'team-task-conflict' : 'team-rejected',
                        message: error.message,
                    },
                };
            }
        }
    };
})();
export { TeamRemoteAdapter };
export default TeamRemoteAdapter;
//# sourceMappingURL=index.js.map