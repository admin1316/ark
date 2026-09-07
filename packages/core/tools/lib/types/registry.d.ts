/**
 * Tool registry surface: scoped registration, restrictions, guards, and model
 * presentation modes (native/code/both) including the generated Code Mode SDK
 * prompt. ToolRuntime owns this registry and keeps the public register/
 * restrict/guard/presentAs/schemas/get/executionMode surface; the execution
 * pipeline lives in {@link ToolExecutor} and receives the registry lookups it
 * needs through this class.
 * @module @deepseek-ai/dsh-tools/src/registry
 */
import { Context } from '@deepseek-ai/cordis';
import type { ToolSchema } from '@deepseek-ai/dsh-llm';
import type { ScopeKey } from '@deepseek-ai/dsh-scope';
import type { Config, ToolDefinition, ToolExecution, ToolExecutionInput, ToolExecutionMode, ToolGuard, ToolPresentationMode, ToolRestriction, ToolRuntime } from './index.ts';
/**
 * Tool registration, restriction, and presentation. Scoped registrations
 * shadow globals; one visibility resolver feeds presentation, lookup, and the
 * execution pipeline's dispatch resolution. The owning {@link ToolRuntime}
 * service is the scoped subject for the `tools/code-dispatch-log` waterfall
 * and the receiver handed to the reserved `run_code` transport.
 *
 * Caller context is never captured: registration methods take the caller's
 * {@link ToolRuntime} and its CALLING context, so a scoped registration's
 * effect attaches to the caller's fiber to unwind with it, exactly as the
 * original `this.ctx` reads did. The constructed `runtime` and its root
 * context serve the internal assembly and `run_code` bridge paths, matching
 * the pre-split instance.
 */
export declare class ToolRegistry {
    /** The owning service instance, handed to the reserved `run_code` transport. */
    private readonly runtime;
    /** The construction (root) context: internal assembly and bridge reads. */
    private readonly ctx;
    private readonly layers;
    /** Presentation for scopes that declare none; {@link presentAs} shadows it per scope. */
    private readonly defaultMode;
    private readonly maxParallelSubCalls;
    /**
     * Reserved presentation transport, kept outside the filterable registration
     * layers. Built on first need rather than at construction: which agents run
     * a code mode is no longer known when the service is constructed, and the
     * transport is stateless beyond its closures over the owning runtime.
     */
    private codeTransport;
    constructor(runtime: ToolRuntime, ctx: Context, config?: Config);
    /**
     * The prompt statement of the `code` executor collapse, registered wherever
     * {@link sdkSection} is and rendering empty outside an effective `code`.
     *
     * Every tool contributes its own guidance section naming its tool, none of
     * them qualify how that tool is reached, and they all render before the SDK
     * (orders 100-199 against {@link SDK_SECTION_ORDER}). Without this the model
     * reads a catalog of tools it is told to use and no statement that only
     * `run_code` may be called, so it emits a native call, receives
     * `UNKNOWN_TOOL` for a tool the prompt just declared, and concludes the
     * deployment is inconsistent. {@link COLLAPSE_SECTION_ORDER} places the rule
     * before that guidance rather than after it.
     *
     * `both` renders empty: native calls do execute there, so the rule is false.
     * @returns the section registration.
     */
    private collapseSection;
    /**
     * The generated-SDK prompt section, registered globally by a code-mode
     * deployment and per scope by {@link presentAs}.
     *
     * The body regenerates from the CALLING scope, and renders empty for an
     * agent presenting natively — an agent that opted out under a code-mode
     * deployment still sees the global registration, and an empty section is
     * dropped from the rendered prompt.
     * @returns the section registration.
     */
    private sdkSection;
    /**
     * The presentation one scope's agent sees: its own declaration, else the
     * deployment default.
     * @param scope - the calling agent, or undefined for the global view.
     * @returns the resolved presentation mode.
     */
    private modeFor;
    /**
     * The reserved `run_code` transport, built on first need.
     *
     * It never enters the global layer: per-agent restrictions must not remove
     * it, and a scoped registration must not shadow it. The visibility resolver
     * appends it after resolving the filterable global/scoped capability layers,
     * and only for scopes whose mode actually presents it.
     * @returns the shared transport definition.
     */
    private requireCodeTransport;
    /**
     * Present the calling scope's tools in `mode` instead of the deployment
     * default. Nearest scope on the chain wins, so a preset's standing
     * declaration covers every agent joined under it.
     *
     * Scoped only, and one declaration per scope: this is how an agent preset
     * composes Code Mode agents beside native ones in the same process, and a
     * process-global override would be the `mode` config field instead.
     * @param ctx - the caller-visible context.
     * @param mode - the presentation the covered agents' models see.
     * @returns the exact disposer that restores the deployment default.
     */
    presentAs(ctx: Context, mode: ToolPresentationMode): () => void;
    /**
     * Build one scope's wire schemas and names for prompt-order validation.
     * Restrictions do not make known tools invalid, but a mode collapse does.
     */
    private wireSchemas;
    /**
     * Resolve the code runtime or throw the actionable misconfiguration error.
     * Read at use time (assembly / run_code execution), NOT via static
     * `inject`: an inject entry would hold `ctx.tools` — and every tool plugin
     * behind it — hostage to a code runtime existing even under `mode:
     * 'native'` (the loop's optional-backend idiom, same as
     * `sessionPersistence`).
     *
     * Assembly and `run_code` execution read separately, so the language is not
     * bound to a request. Harmless while one published backend exists — both
     * reads return the same flavor — but a reload that swapped in a second
     * language between them would hand a program written against one SDK to the
     * other. Binding it is deferred until a second backend ships (the first
     * point it is testable); rationale in the
     * [language-dispatch note](../../../../.agents/notes/implemented/feature/2026-07-31-code-mode-language-dispatch.md).
     */
    private requireCodeRuntime;
    /**
     * Register globally or in the calling agent scope. Scoped tools shadow
     * globals; duplicates within one layer and the reserved `run_code` name fail.
     * @param ctx - the caller-visible context.
     * @param definition - tool schema, execution, and optional finalization/presentation callbacks.
     * @returns the exact disposer that unregisters the tool.
     */
    register(ctx: Context, definition: ToolDefinition): () => void;
    /**
     * Restrict global tools for the calling agent scope. Empty filters, unknown
     * names, scope-local names, and reserved transport names fail. Restrictions
     * intersect; scoped registrations remain visible.
     * @param ctx - the caller-visible context.
     * @param filter - global-tool mask: `allow` (keep only) and/or `deny` (remove).
     * @returns the exact disposer that lifts this restriction.
     */
    restrict(ctx: Context, filter: ToolRestriction): () => void;
    /**
     * Register a monotonic guard after the extensible `tools/pre-execute`
     * waterfall. A plain-context guard applies globally; one registered through
     * `agent.ctx` applies only to that agent. Any matching guard may deny by
     * returning a reason, while no guard can force-allow a call another guard
     * denied. The exact effect disposer is returned for ordered ownership and
     * HMR cleanup.
     * @param ctx - the caller-visible context.
     * @param guard - synchronous check; a returned string denies the execution.
     * @returns the exact disposer that unregisters the guard.
     */
    guard(ctx: Context, guard: ToolGuard): () => void;
    /**
     * First monotonic denial from the global then the scope chain's guard layers, farthest first.
     * @param exec - the execution the guards inspect.
     * @returns the first denial reason, or undefined when no guard denies the call.
     */
    guardReason(exec: ToolExecution): string | undefined;
    /**
     * Resolve every registry fact one scope needs in one layer traversal. The
     * visible map applies restrictions to the INHERITED surface, then the
     * scope's own registrations and the reserved presentation transport; the
     * other sets retain the pre-restriction facts needed by restriction and
     * prompt-order validation.
     *
     * A restriction filters what a scope inherits — the global layer and every
     * ancestor layer on its chain — and never what its OWN layer registers.
     * That exemption is what a per-child capability filter has to keep intact:
     * the delegation runtime registers a child's reporting and structured-output
     * tools into the child's own layer, and a filter naming the capabilities the
     * child may use must not strip the machinery it answers through.
     *
     * Reading the exempt set as "the global layer" instead of "not mine" held
     * only while every model-facing tool sat in the host composition. Once
     * presets moved them onto the agent plane they became an ANCESTOR
     * contribution, so a child's filter silently stopped constraining anything
     * it was given.
     * @param scope - the viewing scope (the agent), or undefined for the global view.
     * @returns the complete derived view for that scope.
     */
    private view;
    /**
     * Look up a tool as one scope sees it (scoped
     * shadows global; a restricted-away global reads as absent). Presenters pass
     * the calling agent so the rendered card matches the definition that
     * actually executed.
     * @param name - the tool name as registered.
     * @param scope - the viewing scope (the agent); omitted = the global view.
     * @returns the definition the scope resolves, or undefined when none is visible.
     */
    get(name: string, scope?: ScopeKey): ToolDefinition | undefined;
    /**
     * Resolve the definition that MAY EXECUTE for a call, applying the mode
     * collapse at the operation boundary that owns it. The registry view
     * (`get`) is presentation-agnostic; here a MODEL-DIRECT call under `code`
     * may only name the reserved `run_code` transport, while a nested
     * sub-dispatch (a `parent` token set — the `run_code` SDK calling a tool
     * it bound) may call any visible tool. Denial surfaces as `UNKNOWN_TOOL`
     * through the executor, matching an absent definition.
     * @param name - the tool name as registered.
     * @param scope - the viewing scope (the agent); omitted = the global view.
     * @param nested - whether the call is a transport sub-dispatch, not a model-direct call.
     * @returns the definition that may run, or undefined when the call must be rejected.
     */
    resolveExecution(name: string, scope: ScopeKey | undefined, nested: boolean): ToolDefinition | undefined;
    /**
     * Project visible definitions onto the allowlisted model-facing schema fields,
     * excluding execution and presentation callbacks.
     * @param scope - the viewing scope (the agent); omitted = the global view.
     * @returns one deep-cloned schema per visible tool.
     */
    schemas(scope?: ScopeKey): ToolSchema[];
    /** Project visible callable tools onto the generated Code Mode SDK contract. */
    private sdkSchemas;
    /** Project one definition onto the model-facing schema fields. */
    private schemaOf;
    /**
     * Classify a pending call through the caller's visible tool definition. Only
     * an exact `true` is parallel; unknown, hidden, undeclared, invalid, or
     * throwing classifiers are exclusive.
     * @param exec - call name, parsed arguments, and optional agent scope.
     * @returns the fail-closed scheduling mode.
     */
    executionMode(exec: ToolExecutionInput): ToolExecutionMode;
    /**
     * Run the `tools/code-dispatch-log` waterfall over one settled sub-dispatch
     * and return the content the bridge should log on `tool/code-dispatch`.
     * Contained: when a listener throws, the method logs the original settled
     * content; that failure must not fail the dispatch or omit the settle event. Private:
     * the ONE consumer is the `run_code` bridge this registry constructs, which
     * receives it as a capability parameter (the `requireRuntime` idiom) — the
     * waterfall, not this invoker, is the public extension point.
     */
    private shapeDispatchLog;
    /**
     * Whether the `code` mode collapse denies a model-direct call: only the
     * reserved `run_code` transport may be named. Nested sub-dispatches (a
     * `parent` token set) bypass the collapse. One home for the
     * security-relevant predicate, shared by {@link resolveExecution} and the
     * executor's `createExecution` so the two can never drift apart.
     *
     * Resolved through {@link modeFor}, NOT `defaultMode`: an agent given `code`
     * by an agent preset under a native deployment is the composition
     * `dsh-agent-tool-presentation` exists for, and reading the deployment default would
     * leave exactly that agent uncollapsed — announcing one surface while
     * executing another, which is the bypass this collapse closes.
     * @param name - the tool name as registered.
     * @param scope - the viewing scope whose effective presentation mode applies.
     * @param nested - whether the call is a transport sub-dispatch, not a model-direct call.
     * @returns true when the call collapses to the reserved code-dispatch transport.
     */
    collapses(name: string, scope: ScopeKey | undefined, nested: boolean): boolean;
}
//# sourceMappingURL=registry.d.ts.map