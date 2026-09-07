/**
 * Tool registry, model presentation modes, and pre/guard/around/post/result
 * execution pipeline. The public service class delegates registration and
 * presentation to {@link ToolRegistry} and execution to {@link ToolExecutor};
 * the split keeps the package entry's public API stable while separating the
 * two concerns.
 * @module @deepseek-ai/dsh-tools
 */
import { Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { ToolExecutor } from "./executor.js";
import { ToolRegistry } from "./registry.js";
export { defineTool, valueSchemaSpecToJsonSchema, parameterSchemaSpecToJsonSchema, validateArgs, ToolArgsError, } from "./schema.js";
export { assertSupportedJsonSchema, assertObjectJsonSchema, validateJsonSchemaValue, JsonSchemaError, } from "./json-schema.js";
export { CodeRunFailedError, RUN_CODE_NAME } from "./code-mode.js";
export { jsonSchemaToTs, renderToolsSdk } from "./ts-types.js";
export { jsonSchemaToPy, renderToolsSdkPy } from "./py-types.js";
export { defineContentToolFixture } from "./testing.js";
export { TOOL_ABORTED, TOOL_ABORTED_BEFORE_DISPATCH, ToolNotFoundError, ToolOutputError } from "./executor.js";
/**
 * Scheduler entry point omitted from the generated named service API.
 * @internal
 */
export const TOOL_RUNTIME_SCHEDULER = Symbol('@deepseek-ai/dsh-tools.scheduler');
/**
 * Whether a presentation value uses the PTC/run_code collapse (including the pre-alpha alias).
 * @param mode - The mode input.
 * @returns The value produced by is ptc presentation mode.
 */
export function isPtcPresentationMode(mode) {
    return mode === 'ptc' || mode === 'code';
}
/**
 * Tool registry and execution pipeline. Scoped registrations shadow globals;
 * one visibility resolver feeds presentation, lookup, and dispatch. The class
 * delegates to a {@link ToolRegistry} (registration, restrictions, guards,
 * presentation modes, schema projection) and a {@link ToolExecutor} (the
 * pre/guard/around/post policy and cancellation-fused body dispatch); the
 * public service API is unchanged by the split.
 */
export class ToolRuntime extends Service {
    static inject = ['systemPrompt'];
    static Config = z.object({
        mode: z.union(['native', 'ptc', 'code', 'both']).default('native'),
        maxParallelSubCalls: z.natural().min(1).default(10),
    });
    /** Internal staged view consumed by `dsh-agent-loop`'s parallel scheduler. */
    [TOOL_RUNTIME_SCHEDULER] = {
        prepare: exec => this.executor.prepareScheduledExecution(this, this.ctx, exec),
        dispatch: exec => this.executor.dispatchScheduledExecution(this, this.ctx, exec),
        finalize: (exec, result) => this.executor.finalizeScheduledExecution(this, this.ctx, exec, result),
        finish: (exec, result) => this.executor.finishScheduledExecution(this, this.ctx, exec, result),
    };
    registry;
    executor;
    constructor(ctx, config = {}) {
        super(ctx, 'tools');
        this.registry = new ToolRegistry(this, this.ctx, config);
        this.executor = new ToolExecutor(this.registry);
    }
    /**
     * Present the calling scope's tools in `mode` instead of the deployment
     * default. Nearest scope on the chain wins, so a preset's standing
     * declaration covers every agent joined under it.
     *
     * Scoped only, and one declaration per scope: this is how an agent preset
     * composes Code Mode agents beside native ones in the same process, and a
     * process-global override would be the `mode` config field instead.
     * @param mode - the presentation the covered agents' models see.
     * @returns the exact disposer that restores the deployment default.
     */
    presentAs(mode) {
        return this.registry.presentAs(this.ctx, mode);
    }
    /**
     * Register globally or in the calling agent scope. Scoped tools shadow
     * globals; duplicates within one layer and the reserved `run_code` name fail.
     * @param definition - tool schema, execution, and optional finalization/presentation callbacks.
     * @returns the exact disposer that unregisters the tool.
     */
    register(definition) {
        return this.registry.register(this.ctx, definition);
    }
    /**
     * Restrict global tools for the calling agent scope. Empty filters, unknown
     * names, scope-local names, and reserved transport names fail. Restrictions
     * intersect; scoped registrations remain visible.
     * @param filter - global-tool mask: `allow` (keep only) and/or `deny` (remove).
     * @returns the exact disposer that lifts this restriction.
     */
    restrict(filter) {
        return this.registry.restrict(this.ctx, filter);
    }
    /**
     * Register a monotonic guard after the extensible `tools/pre-execute`
     * waterfall. A plain-context guard applies globally; one registered through
     * `agent.ctx` applies only to that agent. Any matching guard may deny by
     * returning a reason, while no guard can force-allow a call another guard
     * denied. The exact effect disposer is returned for ordered ownership and
     * HMR cleanup.
     * @param guard - synchronous check; a returned string denies the execution.
     * @returns the exact disposer that unregisters the guard.
     */
    guard(guard) {
        return this.registry.guard(this.ctx, guard);
    }
    /**
     * Look up a tool as one scope sees it (scoped
     * shadows global; a restricted-away global reads as absent). Presenters pass
     * the calling agent so the rendered card matches the definition that
     * actually executed.
     * @param name - the tool name as registered.
     * @param scope - the viewing scope (the agent); omitted = the global view.
     * @returns the definition the scope resolves, or undefined when none is visible.
     */
    get(name, scope) {
        return this.registry.get(name, scope);
    }
    /**
     * Project visible definitions onto the allowlisted model-facing schema fields,
     * excluding execution and presentation callbacks.
     * @param scope - the viewing scope (the agent); omitted = the global view.
     * @returns one deep-cloned schema per visible tool.
     */
    schemas(scope) {
        return this.registry.schemas(scope);
    }
    /**
     * Classify a pending call through the caller's visible tool definition. Only
     * an exact `true` is parallel; unknown, hidden, undeclared, invalid, or
     * throwing classifiers are exclusive.
     * @param exec - call name, parsed arguments, and optional agent scope.
     * @returns the fail-closed scheduling mode.
     */
    executionMode(exec) {
        return this.registry.executionMode(exec);
    }
    /**
     * Execute through pre-policy, guards, around-dispatch, post-policy,
     * definition-owned content finalization, and final notification. Tool and
     * listener failures resolve as materialized error results; an invisible tool
     * reports `UNKNOWN_TOOL`. The returned outcome is the same lossless, frozen
     * snapshot final observers receive. Cancellation
     * arriving after entry and before final result materialization skips a
     * not-yet-started body with `ABORTED_BEFORE_DISPATCH` or replaces a
     * successful started outcome with `ABORTED`; already-started work is still
     * drained and may retain a tool-owned structured error.
     * @param exec - the typed same-process call input. The registry assigns its
     *   correlation token before policy begins.
     * @returns the materialized final result.
     */
    async execute(exec) {
        return this.executor.execute(this, this.ctx, exec);
    }
}
export default ToolRuntime;
//# sourceMappingURL=index.js.map