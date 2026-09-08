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
import { assertNever, deepFreeze, HarnessError } from '@deepseek-ai/dsh-llm';
import { snapshotJsonValue } from '@deepseek-ai/dsh-session';
import { scopeTarget } from '@deepseek-ai/dsh-scope';
import { RUN_CODE_NAME } from "./code-mode.js";
import { validateJsonSchemaValue } from "./json-schema.js";
/** Canonical error code for cancellation after a tool body was invoked. */
export const TOOL_ABORTED = 'ABORTED';
/** Canonical error code for cancellation before a tool body was invoked. */
export const TOOL_ABORTED_BEFORE_DISPATCH = 'ABORTED_BEFORE_DISPATCH';
/**
 * Thrown (internally) when the model requests a tool that isn't registered.
 * Extends {@link HarnessError} (`code: 'UNKNOWN_TOOL'`) so an unknown-tool
 * failure is as routable as a tool-thrown one — retry/sandbox/replay code can
 * distinguish it from a tool body's own error.
 */
export class ToolNotFoundError extends HarnessError {
    /**
     * @param toolName - the name the caller asked for.
     * @param reachableFrom - how the model reaches this tool instead, when the
     *   name IS visible and only the presentation denies calling it directly.
     *   Omitted for a name that is registered nowhere.
     */
    constructor(toolName, reachableFrom) {
        super(reachableFrom === undefined
            ? `unknown tool "${toolName}"`
            : `unknown tool "${toolName}": ${reachableFrom}`, 'UNKNOWN_TOOL');
        this.name = 'ToolNotFoundError';
    }
}
/** Thrown when a tool body or post-policy value violates its declared output. */
export class ToolOutputError extends HarnessError {
    /** Schema/value violations in validation order. */
    violations;
    constructor(toolName, violations) {
        super(`tool "${toolName}" returned invalid output: ${violations.join('; ')}`, 'INVALID_TOOL_OUTPUT');
        this.name = 'ToolOutputError';
        this.violations = violations;
    }
}
/** Convert one projector exception into the canonical invalid-output failure. */
function projectionError(toolName, projector, error) {
    return new ToolOutputError(toolName, [`output.${projector} failed: ${errorMessage(error)}`]);
}
/** Snapshot one projector result before later durable-result materialization. */
function snapshotProjection(toolName, projector, candidate) {
    try {
        const detached = snapshotJsonValue(candidate);
        if (detached === undefined) {
            throw new ToolOutputError(toolName, [`output.${projector} returned non-lossless JSON`]);
        }
        return detached;
    }
    catch (error) {
        if (error instanceof ToolOutputError)
            throw error;
        throw projectionError(toolName, projector, error);
    }
}
/** Snapshot one body or policy value into the canonical invalid-output failure class. */
function snapshotToolValue(toolName, candidate) {
    try {
        const detached = snapshotJsonValue(candidate);
        if (detached === undefined)
            throw new ToolOutputError(toolName, ['value is not lossless JSON']);
        return detached;
    }
    catch (error) {
        if (error instanceof ToolOutputError)
            throw error;
        throw new ToolOutputError(toolName, [`value snapshot failed: ${errorMessage(error)}`]);
    }
}
/**
 * Best-effort human-readable message from an arbitrary thrown value: Error
 * instances use `.message`; non-Error objects with a string `message`
 * property (e.g. `throw { message: 'denied' }`) use it too; everything else
 * is stringified.
 * @param error - the thrown value.
 * @returns the best-effort message.
 */
export function errorMessage(error) {
    try {
        if (error instanceof Error)
            return error.message;
        if (typeof error === 'object' && error !== null
            && 'message' in error && typeof error.message === 'string') {
            return error.message;
        }
        return String(error);
    }
    catch {
        // A hostile thrown value can trap `instanceof`, property access, or string
        // coercion. Error normalization is the outermost safety boundary, so its
        // fallback must itself be total.
        return '<unprintable thrown value>';
    }
}
/** Derive one failure message from policy feedback without changing its rendered blocks. */
function failureMessageFromContent(content) {
    const text = content
        .map(block => block.type === 'text' ? block.text : `[${block.type} content]`)
        .join('\n');
    return text.length > 0 ? text : 'tool result blocked by post-execute policy';
}
/** Snapshot and freeze one durable tool-result projection or reject lossy data. */
function materializePresentation(candidate) {
    const detached = snapshotJsonValue(candidate);
    if (detached === undefined) {
        throw new TypeError('tool result must be losslessly JSON-serializable');
    }
    return deepFreeze(detached);
}
/** Structured `{ name, code }` for a thrown HarnessError, else undefined. */
function errorInfo(error) {
    try {
        return error instanceof HarnessError ? { name: error.name, code: error.code } : undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * Tool execution pipeline. Pre-policy, guards, around-dispatch, post-policy,
 * definition-owned content finalization, and final notification run here;
 * registration and presentation live in the {@link ToolRegistry} the executor
 * was constructed with. Public pipeline views stay on the service; this class
 * is the internal implementation.
 */
export class ToolExecutor {
    registry;
    /** Context deferred by a running tool body, keyed by its scheduler-owned execution. */
    deferredContexts = new WeakMap();
    /** Executions whose tool body declared the current turn complete. */
    concludingExecutions = new WeakSet();
    /** Original caller cancellation, kept outside the wrapper-mutable execution object. */
    cancellationStates = new WeakMap();
    /** Definition-owned final content transform snapshotted before policy begins. */
    contentFinalizers = new WeakMap();
    /** Registry-normalized results and the exact dispatch that validated each value. */
    canonicalResults = new WeakMap();
    constructor(registry) {
        this.registry = registry;
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
     * @param runtime - the caller-visible service instance (its `ctx` is the calling context).
     * @param ctx - the calling context.
     * @param exec - the typed same-process call input. The registry assigns its
     *   correlation token before policy begins.
     * @returns the materialized final result.
     */
    async execute(runtime, ctx, exec) {
        return this.prepareExecution(runtime, ctx, exec, prepared => this.completeScheduledExecution(runtime, ctx, prepared));
    }
    async completeScheduledExecution(runtime, ctx, prepared) {
        switch (prepared.kind) {
            case 'dispatch': {
                const dispatched = await this.dispatchScheduledExecution(runtime, ctx, prepared.exec);
                return dispatched.kind === 'post-result'
                    ? await this.finalizeScheduledExecution(runtime, ctx, prepared.exec, dispatched.result)
                    : this.finishScheduledExecution(runtime, ctx, prepared.exec, dispatched.result);
            }
            case 'post-result':
                return await this.finalizeScheduledExecution(runtime, ctx, prepared.exec, prepared.result);
            case 'final-result':
                return this.finishScheduledExecution(runtime, ctx, prepared.exec, prepared.result);
            /* v8 ignore next -- closed-union exhaustiveness guard */
            default:
                return assertNever(prepared, 'scheduled tool preparation');
        }
    }
    createExecution(exec) {
        const deferredContexts = [];
        const token = createExecutionToken();
        const callId = exec.callId;
        const rootCallId = exec.rootCallId ?? callId;
        const name = exec.name;
        const agent = exec.agent;
        const parent = exec.parent;
        const signal = exec.signal;
        // Distinguish a mode-collapsed call (visible in the scope, denied only by
        // the `code` collapse) from a genuinely unknown tool. A collapsed call is
        // deterministically denied, so it terminates BEFORE the extensible policy
        // pipeline: pre-execute listeners, approval `ask`, and guards must never
        // observe — or worse, approve — a call that can only fail. An unknown tool
        // keeps the historical dispatch-stage `UNKNOWN_TOOL` path so policy
        // listeners still see every name that reaches the registry.
        const visible = this.registry.get(name, agent);
        const collapsed = visible !== undefined && this.registry.collapses(name, agent, parent !== undefined);
        const concludingExecutions = this.concludingExecutions;
        const base = {
            token,
            callId,
            rootCallId,
            name,
            signal,
            ...agent !== undefined ? { agent } : {},
            ...parent !== undefined ? { parent } : {},
            deferContext(context) {
                deferredContexts.push(context);
            },
            concludeTurn() {
                concludingExecutions.add(this);
            },
        };
        // Capture the finalizer BEFORE argument materialization: the
        // `finalizeContent` contract snapshots the callback when the call starts,
        // and an arguments getter can replace or clear the registered callback
        // during `snapshotJsonValue`. The collapse only decides whether the
        // CAPTURED callback is retained: the pre-dispatch abort path keeps it
        // (the cancellation contract routes aborted results through it — a getter
        // that aborts mid-materialization before an invalid-args failure lands in
        // the same retained path), while the `UNKNOWN_TOOL` denial and the
        // invalid-args failure of a NON-ABORTED collapsed call drop it (the call
        // could never execute).
        const capturedFinalizer = visible?.finalizeContent?.bind(visible);
        const finalizerFor = () => collapsed && !signal.aborted ? undefined : capturedFinalizer;
        try {
            const detached = snapshotJsonValue(exec.arguments);
            if (detached === undefined) {
                throw new TypeError('tool execution arguments must be losslessly JSON-serializable');
            }
            const execution = { ...base, arguments: deepFreeze(detached) };
            this.deferredContexts.set(execution, deferredContexts);
            this.contentFinalizers.set(execution, finalizerFor());
            this.cancellationStates.set(execution, {
                callerSignal: signal,
                bodyInvoked: false,
            });
            if (collapsed) {
                // The collapse denies the call before the policy pipeline, but a
                // pre-dispatch abort still keeps the established cancellation
                // contract: `prepare`'s caller-cancellation check is skipped for
                // final-results, so honor the abort here instead of surfacing
                // `UNKNOWN_TOOL` on an already-cancelled call.
                if (signal.aborted) {
                    return { kind: 'final-result', exec: execution, result: toolAbortedBeforeDispatchResult() };
                }
                // The name IS visible here, so the denial carries the route the model
                // must take instead. Without it the model reads a bare `unknown tool`
                // for a tool the prompt just declared and concludes the deployment is
                // broken rather than correcting itself.
                return {
                    kind: 'final-result',
                    exec: execution,
                    result: toolErrorResult(new ToolNotFoundError(name, `only \`${RUN_CODE_NAME}\` is callable directly — call \`${name}\` from inside a \`${RUN_CODE_NAME}\` program instead`)),
                };
            }
            return { kind: 'ready', exec: execution };
        }
        catch (error) {
            const execution = { ...base, arguments: undefined };
            this.contentFinalizers.set(execution, finalizerFor());
            return { kind: 'final-result', exec: execution, result: toolErrorResult(error) };
        }
    }
    /**
     * Run the ordered pre-execute and monotonic guard stages for the scheduler.
     * @param runtime - the caller-visible service instance (its `ctx` is the calling context).
     * @param ctx - the calling context.
     * @param input - the caller-supplied execution input.
     * @returns the prepared execution plus the next scheduler stage.
     * @internal
     */
    prepareScheduledExecution(runtime, ctx, input) {
        return this.prepareExecution(runtime, ctx, input, prepared => prepared);
    }
    async prepareExecution(runtime, ctx, input, next) {
        const created = this.createExecution(input);
        if (created.kind !== 'ready')
            return next(created);
        const exec = created.exec;
        if (this.callerCancelled(exec)) {
            return next({ kind: 'final-result', exec, result: toolAbortedBeforeDispatchResult() });
        }
        try {
            const carrier = scopeTarget(runtime, exec.agent);
            const gate = await ctx.waterfall(carrier, 'tools/pre-execute', exec, () => Promise.resolve({ kind: 'allow' }));
            const askResolution = gate.kind === 'ask'
                ? await this.serviceAsk(ctx, exec, gate)
                : { decision: gate, approvalCancelled: false };
            const { decision } = askResolution;
            if (this.callerCancelled(exec) && askResolution.approvalCancelled) {
                return await next({ kind: 'post-result', exec, result: toolAbortedBeforeDispatchResult() });
            }
            const denialReason = decision.kind === 'allow'
                ? this.registry.guardReason(exec)
                : decision.reason;
            if (denialReason !== undefined) {
                return await next({
                    kind: 'post-result',
                    exec,
                    result: this.materializeFinalResult({
                        content: [{ type: 'text', text: `Error: ${denialReason}` }],
                        isError: true,
                        error: { message: denialReason },
                    }),
                });
            }
            if (this.callerCancelled(exec)) {
                return await next({ kind: 'post-result', exec, result: toolAbortedBeforeDispatchResult() });
            }
            return await next({ kind: 'dispatch', exec });
        }
        catch (error) {
            return next({ kind: 'final-result', exec, result: toolErrorResult(error) });
        }
    }
    /** Whether the original caller signal is currently aborted. */
    callerCancelled(exec) {
        const state = this.cancellationStates.get(exec);
        /* v8 ignore next -- only registry-minted executions reach the staged scheduler methods */
        if (state === undefined)
            throw new Error('tool registry scheduler invariant violated: missing cancellation state');
        return state.callerSignal.aborted;
    }
    /** Canonical cancellation outcome selected by whether the tool body started. */
    cancellationResult(exec, prior) {
        const state = this.cancellationStates.get(exec);
        /* v8 ignore next -- only registry-minted executions reach the staged scheduler methods */
        if (state === undefined)
            throw new Error('tool registry scheduler invariant violated: missing cancellation state');
        return state.bodyInvoked
            ? toolAbortedResult(prior)
            : toolAbortedBeforeDispatchResult(prior);
    }
    /**
     * Dispatch the registered body with the original caller signal fused back
     * into any around-wrapper replacement. Cancellation never abandons the body:
     * a started promise reaches quiescence before its outcome becomes `ABORTED`.
     */
    async dispatchToolBody(exec) {
        const state = this.cancellationStates.get(exec);
        /* v8 ignore next -- only registry-minted executions reach the staged scheduler methods */
        if (state === undefined)
            throw new Error('tool registry scheduler invariant violated: missing cancellation state');
        const wrapperSignal = exec.signal;
        const fused = fuseToolSignals(state.callerSignal, wrapperSignal);
        const signal = fused.signal;
        if (isAborted(signal)) {
            fused.dispose();
            return toolAbortedBeforeDispatchResult();
        }
        exec.signal = signal;
        try {
            const tool = this.registry.resolveExecution(exec.name, exec.agent, exec.parent !== undefined);
            if (!tool)
                throw new ToolNotFoundError(exec.name);
            state.bodyInvoked = true;
            const returned = await tool.execute(exec.arguments, exec);
            const result = this.createSuccessResult(exec, tool, returned);
            return isAborted(signal)
                ? toolAbortedResult(result)
                : result;
        }
        catch (error) {
            return toolErrorResult(error);
        }
        finally {
            fused.dispose();
            exec.signal = wrapperSignal;
        }
    }
    /**
     * Run around-dispatch and the tool body. Tool and unknown-tool failures still
     * receive post-execute; pipeline failures are already final.
     * @param runtime - the caller-visible service instance (its `ctx` is the calling context).
     * @param ctx - the calling context.
     * @param exec - the prepared execution.
     * @returns whether the result still needs post-execute.
     * @internal
     */
    async dispatchScheduledExecution(runtime, ctx, exec) {
        try {
            const mutableExec = exec;
            const carrier = scopeTarget(runtime, exec.agent);
            const result = await ctx.waterfall(carrier, 'tools/execute', mutableExec, () => this.dispatchToolBody(mutableExec));
            const normalized = this.normalizeDispatchResult(exec, result);
            const deferredContexts = this.deferredContexts.get(exec);
            /* v8 ignore next -- dispatch only receives executions minted by this registry's prepare stage */
            if (deferredContexts === undefined)
                throw new Error('tool registry scheduler invariant violated: unprepared execution');
            const resultWithDeferredContexts = deferredContexts.length === 0
                ? normalized
                : this.markCanonical(exec, {
                    ...normalized,
                    additionalContexts: [
                        ...deferredContexts,
                        ...normalized.additionalContexts ?? [],
                    ],
                });
            return {
                kind: 'post-result',
                result: this.callerCancelled(exec) && !resultWithDeferredContexts.isError
                    ? this.cancellationResult(exec, resultWithDeferredContexts)
                    : resultWithDeferredContexts,
            };
        }
        catch (error) {
            return { kind: 'final-result', result: toolErrorResult(error) };
        }
    }
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
    async finalizeScheduledExecution(runtime, ctx, exec, result) {
        try {
            const postResult = await this.postExecute(runtime, ctx, exec, result);
            return this.finishScheduledExecution(runtime, ctx, exec, this.callerCancelled(exec) && !postResult.isError
                ? this.cancellationResult(exec, postResult)
                : postResult);
        }
        catch (error) {
            return this.finishScheduledExecution(runtime, ctx, exec, toolErrorResult(error));
        }
    }
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
    finishScheduledExecution(runtime, ctx, exec, result) {
        let materializedResult;
        try {
            materializedResult = this.materializeFinalResult(result);
        }
        catch (error) {
            materializedResult = this.materializeFinalResult(toolErrorResult(error));
        }
        let finalResult;
        try {
            finalResult = this.materializeFinalResult(this.applyFinalContent(exec, materializedResult));
        }
        catch (error) {
            finalResult = this.materializeFinalResult(toolErrorResult(error));
        }
        this.notifyResult(runtime, ctx, exec, finalResult);
        return finalResult;
    }
    /** Apply the snapshotted tool-owned content transform without exposing other result fields. */
    applyFinalContent(exec, result) {
        const finalizeContent = this.contentFinalizers.get(exec);
        if (finalizeContent === undefined)
            return result;
        const content = finalizeContent(exec, result);
        return content === undefined ? result : { ...result, content };
    }
    /** Notify observers without exposing a mutation or error channel into the outcome. */
    notifyResult(runtime, ctx, exec, result) {
        // Freeze the registry's live object before observers receive its readonly
        // WeakMap-keyable view.
        Object.freeze(exec);
        const { name: toolName, callId } = exec;
        const reportFailure = (error) => {
            ctx.logger.warn(`tool "${toolName}" (${callId}): tools/result observer failed: ${errorMessage(error)}`);
        };
        const callbacks = ctx.events.dispatch('emit', [
            scopeTarget(runtime, exec.agent), 'tools/result', exec, result,
        ]);
        for (const callback of callbacks) {
            try {
                const returned = callback(exec, result);
                void Promise.resolve(returned).catch(reportFailure);
            }
            catch (error) {
                reportFailure(error);
            }
        }
    }
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
    async serviceAsk(ctx, exec, ask) {
        const approval = ctx.get('approval');
        if (approval === undefined) {
            return {
                decision: { kind: 'deny', reason: ask.reason ?? `tool "${exec.name}" requires approval (not yet supported)` },
                approvalCancelled: false,
            };
        }
        if (exec.agent === undefined) {
            return {
                decision: { kind: 'deny', reason: `tool "${exec.name}" requires approval, but the call has no agent to route it through` },
                approvalCancelled: false,
            };
        }
        const outcome = await approval.request({
            agent: exec.agent,
            toolName: exec.name,
            callId: exec.callId,
            ...ask.reason !== undefined ? { reason: ask.reason } : {},
            signal: exec.signal,
        });
        switch (outcome) {
            case 'allowed-once': return { decision: { kind: 'allow' }, approvalCancelled: false };
            case 'rejected': return {
                decision: { kind: 'deny', reason: `the user rejected tool "${exec.name}"` },
                approvalCancelled: false,
            };
            case 'cancelled': return {
                decision: { kind: 'deny', reason: `approval for tool "${exec.name}" was cancelled` },
                approvalCancelled: true,
            };
            case 'unavailable': return {
                decision: { kind: 'deny', reason: `tool "${exec.name}" requires approval, but no approval channel is available` },
                approvalCancelled: false,
            };
            default: return assertNever(outcome, 'ApprovalOutcome');
        }
    }
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
    async postExecute(runtime, ctx, exec, result) {
        const decision = await ctx.waterfall(scopeTarget(runtime, exec.agent), 'tools/post-execute', exec, result, () => Promise.resolve({ kind: 'accept' }));
        const decisionContexts = decision.additionalContexts ?? [];
        if (decision.kind === 'block') {
            const message = failureMessageFromContent(decision.feedback);
            return this.markCanonical(exec, {
                content: decision.feedback,
                isError: true,
                error: { message },
                ...decisionContexts.length > 0 ? { additionalContexts: decisionContexts } : {},
            });
        }
        if (Object.hasOwn(decision, 'content') && Object.hasOwn(decision, 'value')) {
            throw new TypeError('tools/post-execute accept decision cannot replace both value and content');
        }
        const additionalContexts = [
            ...result.additionalContexts ?? [],
            ...decisionContexts,
        ];
        if (Object.hasOwn(decision, 'value')) {
            if (result.isError) {
                throw new TypeError('tools/post-execute cannot replace the value of a failed result');
            }
            const tool = this.registry.resolveExecution(exec.name, exec.agent, exec.parent !== undefined);
            if (tool === undefined)
                throw new ToolNotFoundError(exec.name);
            const replaced = this.createSuccessResult(exec, tool, decision.value);
            return this.markCanonical(exec, {
                ...replaced,
                ...additionalContexts.length > 0 ? { additionalContexts } : {},
            });
        }
        return this.markCanonical(exec, {
            ...result,
            ...decision.content !== undefined ? { content: decision.content } : {},
            ...additionalContexts.length > 0 ? { additionalContexts } : {},
        });
    }
    /** Mark one registry-normalized result as canonical only for its owning dispatch. */
    markCanonical(exec, result) {
        this.canonicalResults.set(result, exec.token);
        return result;
    }
    /** Snapshot, validate, render, and optionally project one successful body value. */
    createSuccessResult(exec, tool, candidate) {
        const detached = snapshotToolValue(tool.name, candidate);
        const violations = validateJsonSchemaValue(tool.output.schema, detached, 'value');
        if (violations.length > 0)
            throw new ToolOutputError(tool.name, violations);
        const value = deepFreeze(detached);
        let rendered;
        try {
            rendered = tool.output.render(exec.arguments, value);
        }
        catch (error) {
            throw projectionError(tool.name, 'render', error);
        }
        const content = snapshotProjection(tool.name, 'render', rendered);
        let meta;
        if (exec.parent === undefined && tool.output.presentationMeta !== undefined) {
            let projected;
            try {
                projected = tool.output.presentationMeta(exec.arguments, value);
            }
            catch (error) {
                throw projectionError(tool.name, 'presentationMeta', error);
            }
            meta = snapshotProjection(tool.name, 'presentationMeta', projected);
        }
        const concludesTurn = this.concludingExecutions.has(exec);
        return this.markCanonical(exec, this.materializeFinalResult({
            isError: false,
            value,
            content,
            ...meta !== undefined ? { meta } : {},
            ...concludesTurn ? { concludesTurn: true } : {},
        }));
    }
    /** Normalize an around-dispatch wrapper's authored result through the owning output contract. */
    normalizeDispatchResult(exec, result) {
        if (this.canonicalResults.get(result) === exec.token)
            return result;
        if (result.isError) {
            return this.markCanonical(exec, {
                isError: true,
                error: result.error,
                content: result.content,
                ...result.meta !== undefined ? { meta: result.meta } : {},
                ...result.additionalContexts !== undefined ? { additionalContexts: result.additionalContexts } : {},
            });
        }
        const tool = this.registry.resolveExecution(exec.name, exec.agent, exec.parent !== undefined);
        if (tool === undefined)
            throw new ToolNotFoundError(exec.name);
        const normalized = this.createSuccessResult(exec, tool, result.value);
        return this.markCanonical(exec, {
            ...normalized,
            ...result.additionalContexts !== undefined ? { additionalContexts: result.additionalContexts } : {},
        });
    }
    /** Materialize the authoritative commit outcome once, immediately before `tools/result`. */
    materializeFinalResult(result) {
        const presentation = {
            content: result.content,
            ...result.meta !== undefined ? { meta: result.meta } : {},
            ...result.additionalContexts !== undefined ? { additionalContexts: result.additionalContexts } : {},
        };
        if (result.isError) {
            return materializePresentation({ isError: true, error: result.error, ...presentation });
        }
        const detached = materializePresentation({
            isError: false,
            ...presentation,
            ...result.concludesTurn === true ? { concludesTurn: true } : {},
        });
        return deepFreeze({ ...detached, value: result.value });
    }
}
/** Mint a same-process correlation token whose identity is its value. */
function createExecutionToken() {
    return Symbol('dsh.tool.execution');
}
function toolErrorResult(error) {
    const info = errorInfo(error);
    const message = errorMessage(error);
    return {
        content: [{ type: 'text', text: `Error: ${message}` }],
        isError: true,
        error: { message, ...info ? { info } : {} },
    };
}
/** Read live abort state across an await without treating it as synchronously immutable. */
function isAborted(signal) {
    return signal.aborted;
}
/**
 * Fuse caller and wrapper cancellation without nesting `AbortSignal.any`.
 * Keeping the relay dispatch-scoped also removes listeners when work settles.
 */
function fuseToolSignals(caller, wrapper) {
    if (caller === wrapper)
        return { signal: caller, dispose() { } };
    const controller = new AbortController();
    let listening = false;
    const dispose = () => {
        if (!listening)
            return;
        listening = false;
        caller.removeEventListener('abort', abortFromCaller);
        wrapper.removeEventListener('abort', abortFromWrapper);
    };
    const abortFrom = (source) => {
        const reason = source.reason;
        controller.abort(reason);
        dispose();
    };
    const abortFromCaller = () => { abortFrom(caller); };
    const abortFromWrapper = () => { abortFrom(wrapper); };
    if (wrapper.aborted)
        abortFromWrapper();
    else if (caller.aborted)
        abortFromCaller();
    else {
        listening = true;
        caller.addEventListener('abort', abortFromCaller, { once: true });
        wrapper.addEventListener('abort', abortFromWrapper, { once: true });
    }
    return { signal: controller.signal, dispose };
}
/** Canonical result when cancellation supersedes success after body invocation. */
function toolAbortedResult(prior) {
    const additionalContexts = prior?.additionalContexts ?? [];
    return {
        content: [{ type: 'text', text: 'Error: tool call aborted' }],
        isError: true,
        error: {
            message: 'tool call aborted',
            info: { name: 'AbortError', code: TOOL_ABORTED },
        },
        ...additionalContexts.length > 0 ? { additionalContexts } : {},
    };
}
/** Canonical result when cancellation prevents tool body invocation. */
function toolAbortedBeforeDispatchResult(prior) {
    const additionalContexts = prior?.additionalContexts ?? [];
    return {
        content: [{ type: 'text', text: 'Error: tool call aborted before dispatch' }],
        isError: true,
        error: {
            message: 'tool call aborted before dispatch',
            info: { name: 'AbortError', code: TOOL_ABORTED_BEFORE_DISPATCH },
        },
        ...additionalContexts.length > 0 ? { additionalContexts } : {},
    };
}
//# sourceMappingURL=executor.js.map