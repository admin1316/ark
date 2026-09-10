/**
 * Tool execution pipeline: pre/guard/around/post policy, cancellation fusion,
 * result projection, and final notification. ToolRuntime owns this executor
 * and keeps the public `execute` and scheduler surface; the executor holds the
 * cancellation-sensitive staged state (deferred contexts, body-invoked flags,
 * fused signals) and receives the registry lookups it needs at construction.
 *
 * Caller context is never captured: every pipeline entry takes the caller's
 * {@link ToolRuntime} and its CALLING context, so waterfalls, events, and
 * effect binding resolve on the calling fiber, exactly as the original
 * `this.ctx` reads did. The staged scheduler entries invoked through
 * `[TOOL_RUNTIME_SCHEDULER]` receive the raw service instance and its root
 * context, matching the pre-split scheduler's captured-`this` binding.
 * @module @deepseek-ai/dsh-tools/src/executor
 */
import { Context } from '@deepseek-ai/cordis';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import type { ScheduledToolDispatch, ScheduledToolPreparation, ToolExecutionInput, ToolExecutionResult, ToolRunContext, ToolRuntime } from './index.ts';
import type { ToolRegistry } from './registry.ts';
/** Canonical error code for cancellation after a tool body was invoked. */
export declare const TOOL_ABORTED = "ABORTED";
/** Canonical error code for cancellation before a tool body was invoked. */
export declare const TOOL_ABORTED_BEFORE_DISPATCH = "ABORTED_BEFORE_DISPATCH";
/**
 * Thrown (internally) when the model requests a tool that isn't registered.
 * Extends {@link HarnessError} (`code: 'UNKNOWN_TOOL'`) so an unknown-tool
 * failure is as routable as a tool-thrown one — retry/sandbox/replay code can
 * distinguish it from a tool body's own error.
 */
export declare class ToolNotFoundError extends HarnessError {
    /**
     * @param toolName - the name the caller asked for.
     * @param reachableFrom - how the model reaches this tool instead, when the
     *   name IS visible and only the presentation denies calling it directly.
     *   Omitted for a name that is registered nowhere.
     */
    constructor(toolName: string, reachableFrom?: string);
}
/** Thrown when a tool body or post-policy value violates its declared output. */
export declare class ToolOutputError extends HarnessError {
    /** Schema/value violations in validation order. */
    readonly violations: string[];
    constructor(toolName: string, violations: string[]);
}
/**
 * Best-effort human-readable message from an arbitrary thrown value: Error
 * instances use `.message`; non-Error objects with a string `message`
 * property (e.g. `throw { message: 'denied' }`) use it too; everything else
 * is stringified.
 * @param error - the thrown value.
 * @returns the best-effort message.
 */
export declare function errorMessage(error: unknown): string;
/**
 * Tool execution pipeline. Pre-policy, guards, around-dispatch, post-policy,
 * definition-owned content finalization, and final notification run here;
 * registration and presentation live in the {@link ToolRegistry} the executor
 * was constructed with. Public pipeline views stay on the service; this class
 * is the internal implementation.
 */
export declare class ToolExecutor {
    private readonly registry;
    /** Context deferred by a running tool body, keyed by its scheduler-owned execution. */
    private deferredContexts;
    /** Executions whose tool body declared the current turn complete. */
    private concludingExecutions;
    /** Original caller cancellation, kept outside the wrapper-mutable execution object. */
    private cancellationStates;
    /** Definition-owned final content transform snapshotted before policy begins. */
    private contentFinalizers;
    /** Registry-normalized results and the exact dispatch that validated each value. */
    private readonly canonicalResults;
    constructor(registry: ToolRegistry);
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
     * @param runtime - the caller-visible service instance (its `ctx` is the calling context).
     * @param ctx - the calling context.
     * @param exec - the typed same-process call input. The registry assigns its
     *   correlation token before policy begins.
     * @returns the materialized final result.
     */
    execute(runtime: ToolRuntime, ctx: Context, exec: ToolExecutionInput): Promise<ToolExecutionResult>;
    private completeScheduledExecution;
    private createExecution;
    /**
     * Run the ordered pre-execute and monotonic guard stages for the scheduler.
     * @param runtime - the caller-visible service instance (its `ctx` is the calling context).
     * @param ctx - the calling context.
     * @param input - the caller-supplied execution input.
     * @returns the prepared execution plus the next scheduler stage.
     * @internal
     */
    prepareScheduledExecution(runtime: ToolRuntime, ctx: Context, input: ToolExecutionInput): Promise<ScheduledToolPreparation>;
    private prepareExecution;
    /** Whether the original caller signal is currently aborted. */
    private callerCancelled;
    /** Canonical cancellation outcome selected by whether the tool body started. */
    private cancellationResult;
    /**
     * Dispatch the registered body with the original caller signal fused back
     * into any around-wrapper replacement. Cancellation never abandons the body:
     * a started promise reaches quiescence before its outcome becomes `ABORTED`.
     */
    private dispatchToolBody;
    /**
     * Run around-dispatch and the tool body. Tool and unknown-tool failures still
     * receive post-execute; pipeline failures are already final.
     * @param runtime - the caller-visible service instance (its `ctx` is the calling context).
     * @param ctx - the calling context.
     * @param exec - the prepared execution.
     * @returns whether the result still needs post-execute.
     * @internal
     */
    dispatchScheduledExecution(runtime: ToolRuntime, ctx: Context, exec: ToolRunContext): Promise<ScheduledToolDispatch>;
    /**
     * Run ordered post-execute, then apply definition-owned content finalization,
     * materialize, and notify the final outcome.
     * @param runtime - the caller-visible service instance (its `ctx` is the calling context).
     * @param ctx - the calling context.
     * @param exec - the prepared execution.
     * @param result - dispatch/pre result that still needs post-execute.
     * @returns the materialized final result.
     * @internal
     */
    finalizeScheduledExecution(runtime: ToolRuntime, ctx: Context, exec: ToolRunContext, result: ToolExecutionResult): Promise<ToolExecutionResult>;
    /**
     * Materialize the candidate, apply definition-owned content finalization,
     * then materialize and notify the authoritative result.
     * @param runtime - the caller-visible service instance (its `ctx` is the calling context).
     * @param ctx - the calling context.
     * @param exec - the prepared execution.
     * @param result - final result.
     * @returns the materialized final result.
     * @internal
     */
    finishScheduledExecution(runtime: ToolRuntime, ctx: Context, exec: ToolRunContext, result: ToolExecutionResult): ToolExecutionResult;
    /** Apply the snapshotted tool-owned content transform without exposing other result fields. */
    private applyFinalContent;
    /** Notify observers without exposing a mutation or error channel into the outcome. */
    private notifyResult;
    /**
     * Resolve an `ask` decision to allow/deny through the approval seam. The
     * seam is consumed opportunistically with `ctx.get('approval')` — a
     * deployment that composes no ApprovalService keeps the historical degrade
     * to deny, and an unmount mid-session degrades the same way on the next ask.
     * An agent-less execution also degrades: without an agent there is no
     * session to audit to and no UI to route to. Otherwise the outcome maps
     * one-to-one — `allowed-once` proceeds; the three non-grants deny with
     * distinct reasons so the model can tell a human "no" from an absent
     * approval channel.
     */
    private serviceAsk;
    /**
     * Run the `tools/post-execute` waterfall over a dispatched `result` and apply
     * its {@link PostToolDecision}: `accept` keeps the call successful (replacing
     * `content` when given), `block` turns it into an `isError` whose content is
     * the corrective `feedback`. Either decision may attach `additionalContexts`,
     * which are ferried on the returned result for the loop's active-batch FIFO.
     * Context deferred by the tool body survives an accepted result but is
     * discarded when the outer call is blocked; a block exposes only context the
     * blocking decision explicitly supplied.
     * Runs inside `execute`'s outer try/catch (a throwing listener → isError).
     */
    private postExecute;
    /** Mark one registry-normalized result as canonical only for its owning dispatch. */
    private markCanonical;
    /** Snapshot, validate, render, and optionally project one successful body value. */
    private createSuccessResult;
    /** Normalize an around-dispatch wrapper's authored result through the owning output contract. */
    private normalizeDispatchResult;
    /** Materialize the authoritative commit outcome once, immediately before `tools/result`. */
    private materializeFinalResult;
}
//# sourceMappingURL=executor.d.ts.map