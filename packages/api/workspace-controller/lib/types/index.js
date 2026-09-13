/** Workspace follow Remote owner and directory-picker composition. */
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
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { DirectoryPickerController } from "./directory-picker.js";
import { WorkspaceFeed } from "./feed.js";
export { DirectoryPickerController } from "./directory-picker.js";
/** Host service backing the generated `ctx.remote.workspace` namespace. */
let WorkspaceController = (() => {
    let _classSuper = TypertRemoteService;
    let _instanceExtraInitializers = [];
    let _follow_decorators;
    return class WorkspaceController extends _classSuper {
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
            _follow_decorators = [Remote({ mode: 'stream' })];
            __esDecorate(this, null, _follow_decorators, { kind: "method", name: "follow", static: false, private: false, access: { has: obj => "follow" in obj, get: obj => obj.follow }, metadata: _metadata }, null, _instanceExtraInitializers);
            if (_metadata) Object.defineProperty(this, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        }
        static inject = ['typert', 'workspaceRegistry'];
        feed = __runInitializers(this, _instanceExtraInitializers);
        /** @param ctx - Host context containing the Workspace registry. */
        constructor(ctx) {
            super(ctx, 'workspaceController', { namespace: 'workspace' });
            this.feed = new WorkspaceFeed(ctx);
            // This package is the Loader entry for both Remote owners it hosts: the
            // directory-picking seam is abstract and never an entry itself. The child
            // stays pending until a picking backend is composed, so a host without one
            // registers no picking namespace instead of answering an unservable verb.
            ctx.plugin(DirectoryPickerController);
        }
        /**
         * Stream a complete Workspace baseline followed by ordered increments.
         * @param signal - generation cancellation.
         * @returns baseline followed by ordered Workspace increments.
         */
        follow(signal) {
            return this.feed.follow(signal);
        }
    };
})();
export { WorkspaceController };
export default WorkspaceController;
//# sourceMappingURL=index.js.map