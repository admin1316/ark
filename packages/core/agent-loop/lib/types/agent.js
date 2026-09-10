/**
 * Default Agent driver over queued turns and step-boundary input. Every request
 * is derived from the session log.
 * @module dsh-agent-loop/agent
 */
import { Inbox, agentEvents, assembleContextFor } from '@deepseek-ai/dsh-agent';
import { BlockAssembler, LlmError, createAssistantMessage, deepFreeze, errorChain, markAgentLoopRequest, } from '@deepseek-ai/dsh-llm';
import { createScope } from '@deepseek-ai/dsh-scope';
import { canonicalHeader, headerEquals } from '@deepseek-ai/dsh-session';
import { joinContextSections, renderContextSections, renderPrompt } from '@deepseek-ai/dsh-system-prompt';
import { RuntimeContextProjection } from "./runtime-context.js";
import { executeToolCalls } from "./tool-calls.js";
import { DEFAULT_AGENT_TURN_BUDGET } from "./constants.js";
/** Internal first-cause marker carried by the turn AbortSignal. */
class TurnBudgetExhaustedError extends Error {
    reason;
    constructor(reason) {
        super(`agent turn budget exhausted: ${reason.dimension} observed ${reason.observed}, limit ${reason.limit}`);
        this.reason = reason;
        this.name = 'TurnBudgetExhaustedError';
    }
}
/**
 * Bounded wait outcome for same-process code that ignored cancellation. The
 * operation is deliberately NOT detached: the Agent stays registered and
 * running until the underlying promise really settles.
 */
export class AgentQuiescenceTimeoutError extends Error {
    residual;
    /** Identifies cancellation that exceeded its grace with operations still active. */
    code = 'AGENT_OPERATION_UNRESPONSIVE';
    constructor(residual) {
        const operations = residual.operations.map(item => `${item.stage}×${item.count}`).join(', ');
        super(`agent cancellation did not quiesce within ${residual.graceMs}ms; still active: ${operations}`);
        this.residual = residual;
        this.name = 'AgentQuiescenceTimeoutError';
    }
}
/** Per-turn counter, deadline, and non-detaching cancellation monitor. */
class TurnBudget {
    limits;
    abort;
    reportResidual;
    startedAt = Date.now();
    operations = new Map();
    elapsedTimer;
    graceTimer;
    abortStartedAt;
    reportedResidual = false;
    closed = false;
    steps = 0;
    modelAttempts = 0;
    toolCalls = 0;
    _exhaustion;
    constructor(limits, abort, reportResidual) {
        this.limits = limits;
        this.abort = abort;
        this.reportResidual = reportResidual;
        this.abort.signal.addEventListener('abort', this.onAbort, { once: true });
        this.elapsedTimer = setTimeout(() => {
            if (!this.abort.signal.aborted) {
                this.markExhausted('elapsed-ms', this.limits.maxElapsedMs, this.usage.elapsedMs);
            }
        }, this.limits.maxElapsedMs);
    }
    get exhaustion() {
        return this._exhaustion;
    }
    get usage() {
        return {
            elapsedMs: Math.max(0, Date.now() - this.startedAt),
            steps: this.steps,
            modelAttempts: this.modelAttempts,
            toolCalls: this.toolCalls,
        };
    }
    consumeStep() {
        this.consume('steps', 1);
    }
    consumeModelAttempt() {
        this.consume('model-attempts', 1);
    }
    consumeToolCalls(count) {
        this.consume('tool-calls', count);
    }
    /** Await one same-process boundary without abandoning it after cancellation. */
    async monitor(stage, operation) {
        // Cancellation-aware cleanup (tool result materialization, iterator
        // return) is allowed to enter after abort. Its caller owns whether the
        // operation is still semantically admissible; this monitor only tracks
        // quiescence and must not suppress canonical aborted results.
        if (!this.abort.signal.aborted)
            this.checkElapsed();
        const token = Symbol(stage);
        this.operations.set(token, stage);
        if (this.abort.signal.aborted)
            this.armResidualDeadline();
        try {
            return await operation();
        }
        finally {
            this.operations.delete(token);
        }
    }
    close() {
        this.closed = true;
        clearTimeout(this.elapsedTimer);
        if (this.graceTimer !== undefined)
            clearTimeout(this.graceTimer);
        this.abort.signal.removeEventListener('abort', this.onAbort);
    }
    consume(dimension, amount) {
        this.abort.signal.throwIfAborted();
        this.checkElapsed();
        const current = dimension === 'steps'
            ? this.steps
            : dimension === 'model-attempts'
                ? this.modelAttempts
                : this.toolCalls;
        const limit = dimension === 'steps'
            ? this.limits.maxSteps
            : dimension === 'model-attempts'
                ? this.limits.maxModelAttempts
                : this.limits.maxToolCalls;
        const observed = current + amount;
        if (observed > limit) {
            throw this.markExhausted(dimension, limit, observed);
        }
        if (dimension === 'steps')
            this.steps = observed;
        else if (dimension === 'model-attempts')
            this.modelAttempts = observed;
        else
            this.toolCalls = observed;
    }
    checkElapsed() {
        const elapsed = Math.max(0, Date.now() - this.startedAt);
        if (elapsed >= this.limits.maxElapsedMs) {
            throw this.markExhausted('elapsed-ms', this.limits.maxElapsedMs, elapsed);
        }
    }
    markExhausted(dimension, limit, observed) {
        if (this._exhaustion !== undefined)
            return new TurnBudgetExhaustedError(this._exhaustion);
        const reason = {
            kind: 'budget-exhausted',
            dimension,
            limit,
            observed,
            usage: this.usage,
        };
        this._exhaustion = reason;
        const error = new TurnBudgetExhaustedError(reason);
        this.abort.abort(error);
        return error;
    }
    onAbort = () => {
        this.abortStartedAt = Date.now();
        this.armResidualDeadline();
    };
    armResidualDeadline() {
        if (this.closed || this.reportedResidual || this.graceTimer !== undefined)
            return;
        const elapsed = this.abortStartedAt === undefined ? 0 : Math.max(0, Date.now() - this.abortStartedAt);
        const delay = Math.max(0, this.limits.cancellationGraceMs - elapsed);
        this.graceTimer = setTimeout(() => {
            this.graceTimer = undefined;
            if (this.closed || this.reportedResidual || this.operations.size === 0)
                return;
            this.reportedResidual = true;
            const counts = new Map();
            for (const stage of this.operations.values())
                counts.set(stage, (counts.get(stage) ?? 0) + 1);
            const abortReason = this.abort.signal.reason;
            const abortKind = abortReason instanceof TurnBudgetExhaustedError
                ? 'budget-exhausted'
                : typeof abortReason === 'object' && abortReason !== null && 'kind' in abortReason
                    && (abortReason.kind === 'user' || abortReason.kind === 'parent'
                        || abortReason.kind === 'hook' || abortReason.kind === 'disposed')
                    ? abortReason.kind
                    : 'unknown';
            this.reportResidual({
                code: 'AGENT_OPERATION_UNRESPONSIVE',
                abortKind,
                graceMs: this.limits.cancellationGraceMs,
                operations: [...counts].map(([stage, count]) => ({ stage, count })),
                budget: this.usage,
            });
        }, delay);
    }
}
/** Remove adapter-derived values before plugins propose the next request config. */
function requestProposal(header) {
    if (header.adapterDefaults === undefined)
        return header.config;
    const proposal = { ...header.config };
    if (header.adapterDefaults.reasoningEffort === true)
        delete proposal.reasoningEffort;
    if (header.adapterDefaults.maxTokens === true)
        delete proposal.maxTokens;
    return proposal;
}
/** Drives one session through turn and step boundaries. */
export class ReactLoopAgent {
    loopCtx;
    id;
    options;
    session;
    turnBudgetLimits;
    inbox;
    phase;
    activity = {
        done: Promise.resolve(),
        residual: new Promise(() => undefined),
    };
    closing = false;
    /** The agent-scoped registration boundary; the lifecycle owner unwinds it after the driver exits. */
    scope;
    ctx;
    /** Fused dispatcher, built once in the constructor so hot-path dispatches never allocate. */
    dispatch;
    /** Whether this loop instance has appended its initial/resume request anchor. */
    requestHeaderLogged = false;
    runtimeContext;
    constructor(loopCtx, id, options, session, turnBudgetLimits = DEFAULT_AGENT_TURN_BUDGET) {
        this.loopCtx = loopCtx;
        this.id = id;
        this.options = options;
        this.session = session;
        this.turnBudgetLimits = turnBudgetLimits;
        this.dispatch = agentEvents(loopCtx, this);
        this.inbox = new Inbox(session, {
            inserted: (message) => { this.dispatch.emit('agent/inbox/inserted', { message }); },
            discarded: (message) => { this.dispatch.emit('agent/inbox/discarded', { message }); },
            claimed: (message, turn) => { this.dispatch.emit('agent/inbox/claimed', { message, turn }); },
        });
        const lastTurn = session.events.findLast(event => event.type === 'turn/start')?.data.turn ?? 0;
        this.phase = { kind: 'idle', lastTurn };
        this.scope = createScope(loopCtx, this);
        this.ctx = this.scope.ctx.extend({ agent: this });
        this.runtimeContext = new RuntimeContextProjection(this.ctx, session);
    }
    get status() {
        return this.phase.kind === 'idle' || this.phase.kind === 'maintenance' ? 'idle' : 'running';
    }
    /** Commit a phase and publish its externally visible status transition. */
    setPhase(next) {
        const previousStatus = this.status;
        this.phase = next;
        const status = this.status;
        if (status !== previousStatus) {
            this.dispatch.emit('agent/status', { status });
        }
    }
    send(message, target, wakeup) {
        // Waking input cannot join an aborted activity, so it starts the next turn.
        // Captured before the insertion so a reentrant cancel from a splice observer cannot reclassify it.
        const wakingAfterAbort = wakeup && this.phase.kind !== 'idle' && this.phase.abort.signal.aborted;
        const resolvedTarget = wakingAfterAbort ? 'next-turn' : target;
        this.inbox.splice(resolvedTarget, Infinity, 0, [message]);
        if (wakeup)
            this.wakeDriver(wakingAfterAbort);
    }
    followup(input) {
        this.send(input, 'next-turn', true);
    }
    steer(input) {
        this.send(input, 'next-step', true);
    }
    inject(input) {
        this.send(input, 'next-step', false);
    }
    cancel(cause, options = {}) {
        if (cause.kind === 'disposed')
            this.closing = true;
        if (!options.keepInbox) {
            this.inbox.clear();
            if (this.phase.kind !== 'idle')
                this.phase.wakeRequested = false;
        }
        if (this.phase.kind !== 'idle')
            this.phase.abort.abort(cause);
    }
    runMaintenance(job) {
        if (this.closing)
            throw new Error(`agent "${this.id}" lifecycle is disposing`);
        if (this.phase.kind !== 'idle')
            throw new Error(`agent "${this.id}" already has active work`);
        const done = Promise.withResolvers();
        const maintenance = {
            kind: 'maintenance',
            abort: new AbortController(),
            lastTurn: this.phase.lastTurn,
            wakeRequested: false,
        };
        this.setPhase(maintenance);
        this.activity = {
            done: done.promise,
            residual: new Promise(() => undefined),
        };
        return (async () => {
            try {
                return await job(maintenance.abort.signal);
            }
            finally {
                this.setPhase({ kind: 'idle', lastTurn: maintenance.lastTurn });
                if (maintenance.wakeRequested && this.inbox.hasPending)
                    this.wakeDriver();
                done.resolve();
            }
        })();
    }
    /**
     * Start one driver, or latch its wake behind maintenance or an aborted
     * activity. A wake sent while idle always opens its turn boundary, even
     * when its message was cleared; only a latched replay is suppressed when
     * the queue no longer holds the wake. The sole exception: while the
     * initiator scope is closing (teardown/HMR) no driver can start — the wake
     * is dropped and the phase converges back to idle.
     * @param wakeAfterAbort - the {@link send} classification, captured before
     *   the inbox insertion so a reentrant cancel cannot reclassify it.
     */
    wakeDriver(wakeAfterAbort = false) {
        if (this.closing)
            return;
        if (this.phase.kind !== 'idle') {
            // Maintenance and aborted drivers cannot deliver the wake: latch it for
            // replay at convergence. Live drivers claim queued work themselves;
            // disposal never latches, so teardown waits on no model turn.
            const reason = this.phase.abort.signal.reason;
            if (reason?.kind !== 'disposed' && (this.phase.kind === 'maintenance' || wakeAfterAbort)) {
                this.phase.wakeRequested = true;
            }
            return;
        }
        // Narrowed idle phase captured before the running assignment so the
        // catch path below can converge back to it regardless of flow analysis.
        const { lastTurn } = this.phase;
        const driver = Promise.withResolvers();
        const residual = Promise.withResolvers();
        this.activity = { done: driver.promise, residual: residual.promise };
        this.setPhase({
            kind: 'running',
            abort: new AbortController(),
            turn: lastTurn,
            step: 0,
            wakeRequested: false,
            residual,
        });
        try {
            this.loopCtx.agents.withInitiator(this, () => this.kick()).then(driver.resolve, driver.reject);
        }
        catch {
            // The initiator scope is closing (teardown/HMR): no driver can start.
            // Converge the phase back to idle and settle the activity promise —
            // leaving it pending would wedge whenIdle() and every later wake on
            // this agent, deadlocking disposal.
            this.setPhase({ kind: 'idle', lastTurn });
            driver.resolve();
        }
    }
    async whenIdle() {
        let activity;
        do {
            activity = this.activity;
            const outcome = await Promise.race([
                activity.done.then(() => ({ kind: 'done' })),
                activity.residual.then(residual => ({ kind: 'residual', residual })),
            ]);
            if (outcome.kind === 'residual')
                throw new AgentQuiescenceTimeoutError(outcome.residual);
        } while (activity !== this.activity);
    }
    /** Report one failure at its live boundary, then preserve it for driver containment. */
    throwError(error) {
        const turn = this.phase.kind === 'running' ? this.phase.turn : this.phase.lastTurn;
        const step = this.phase.kind === 'running' ? this.phase.step : 0;
        this.dispatch.emit('agent/error', { turn, step, error });
        throw error;
    }
    async kick() {
        try {
            while (await this.turn()) { }
        }
        catch (_error) {
            // Reported failures and cancellation are contained at the driver boundary.
        }
        finally {
            /* v8 ignore next -- kick owns a running phase until this driver boundary */
            if (this.phase.kind === 'running') {
                const { turn, wakeRequested, budget } = this.phase;
                budget?.close();
                this.setPhase({ kind: 'idle', lastTurn: turn });
                if (wakeRequested && this.inbox.hasPending)
                    this.wakeDriver();
            }
        }
    }
    async preStep(target, position, budget) {
        /* v8 ignore next -- private callers establish the running phase before proposing a step */
        if (this.phase.kind !== 'running')
            throw new Error(`agent "${this.id}": pre-step outside running phase`);
        const signal = this.phase.abort.signal;
        const claimed = this.inbox.claim(target, position.turn);
        const assembly = await budget.monitor('system-prompt', () => this.loopCtx.systemPrompt.assemble(assembleContextFor(this, signal)));
        signal.throwIfAborted();
        const sections = renderContextSections(assembly);
        const context = this.runtimeContext.project(joinContextSections(sections), sections);
        const decision = await budget.monitor('pre-step', () => this.dispatch.waterfall('agent/pre-step', { messages: claimed, ...position, signal }, () => Promise.resolve({
            kind: 'enter',
            messages: context === undefined ? claimed : [...claimed, context],
        })));
        signal.throwIfAborted();
        return decision.kind === 'reject' ? decision : { ...decision, assembly };
    }
    /** Open one turn before claiming its first proposed step. */
    async turn() {
        if (this.phase.kind !== 'running') {
            this.throwError(new Error(`agent "${this.id}": turn without driver reservation`));
        }
        const phase = this.phase;
        const { signal } = phase.abort;
        signal.throwIfAborted();
        const turn = phase.turn + 1;
        try {
            this.session.append('turn/start', { turn });
        }
        catch (error) {
            this.throwError(error);
        }
        phase.turn = turn;
        const budget = phase.budget = new TurnBudget(this.turnBudgetLimits, phase.abort, (residual) => {
            phase.residual.resolve(residual);
            this.dispatch.emit('agent/quiescence-timeout', {
                turn: phase.turn,
                step: phase.step,
                residual,
            });
        });
        let turnEnds = null;
        let target = 'next-turn';
        try {
            while (true) {
                signal.throwIfAborted();
                const step = phase.step + 1;
                const decision = await this.preStep(target, { turn, step }, budget);
                if (decision.kind === 'reject') {
                    turnEnds = { kind: 'blocked' };
                    return false;
                }
                if (turnEnds && decision.messages.length === 0)
                    break;
                // A removed waking message or an enter decision rewritten to empty
                // still owns the initial turn boundary, but it spends no model call.
                if (phase.step === 0 && decision.messages.length === 0) {
                    turnEnds = { kind: 'completed' };
                    return false;
                }
                signal.throwIfAborted();
                budget.consumeStep();
                this.session.append('step/start', { turn, step });
                phase.step = step;
                try {
                    for (const message of decision.messages) {
                        this.session.append('user/message', message, { surfaceOp: 'append' });
                    }
                    // max-tokens is sticky: once any step hits the ceiling, later steps
                    // that complete normally must not downgrade the turn outcome.
                    const stepEnd = await this.step(decision.assembly, budget);
                    // max-tokens stays sticky: a later completed step must not
                    // downgrade the turn outcome.
                    if (turnEnds === null || turnEnds.kind !== 'max-tokens')
                        turnEnds = stepEnd;
                }
                finally {
                    this.session.append('step/end', { turn, step });
                }
                signal.throwIfAborted();
                if (turnEnds && this.inbox.nextStep.length === 0) {
                    await budget.monitor('turn-stopping', () => this.dispatch.serial('agent/turn-stopping', { turn, signal }));
                    signal.throwIfAborted();
                }
                if (turnEnds && this.inbox.nextStep.length === 0)
                    break;
                target = 'next-step';
            }
        }
        catch (error) {
            if (budget.exhaustion !== undefined) {
                turnEnds = budget.exhaustion;
                if (this.inbox.nextStep.length > 0) {
                    this.inbox.splice('next-step', 0, this.inbox.nextStep.length, []);
                }
                // Follow-ups are separate user intent, not work owned by the exhausted
                // turn. Replay them under a fresh turn budget after this driver closes.
                phase.wakeRequested ||= this.inbox.nextTurn.length > 0;
                return false;
            }
            if (signal.aborted) {
                turnEnds = { kind: 'aborted', reason: signal.reason };
                throw error;
            }
            // Every failure is structured: an `LlmError` keeps its facts, anything
            // else flattens to `errorChain` text under the `UNKNOWN` code.
            turnEnds = {
                kind: 'error',
                error: error instanceof LlmError
                    ? error.failure
                    : { message: errorChain(error), code: 'UNKNOWN' },
            };
            this.throwError(error);
        }
        finally {
            try {
                // oxlint-disable-next-line typescript/no-non-null-assertion -- every exit assigns a turn ending
                this.session.append('turn/end', { turn, reason: turnEnds });
            }
            catch (error) {
                this.throwError(error);
            }
            finally {
                budget.close();
                delete phase.budget;
            }
        }
        if (!this.inbox.hasPending)
            return false;
        phase.abort = new AbortController();
        // A fresh controller makes a latch set on the old one stale: the live driver claims the queue itself.
        phase.wakeRequested = false;
        phase.step = 0;
        return true;
    }
    async step(assembly, budget) {
        /* v8 ignore next -- private callers establish the running phase before executing a step */
        if (this.phase.kind !== 'running')
            throw new Error(`agent "${this.id}": step outside running phase`);
        const { turn, step, abort: { signal } } = this.phase;
        signal.throwIfAborted();
        const system = renderPrompt(assembly);
        while (true) {
            budget.consumeModelAttempt();
            const { request, preparedCall } = await this.buildRequest(turn, step, assembly.tools, system, this.session.deriveMessages(), signal, budget);
            const assembler = new BlockAssembler();
            const chunkSeqs = [];
            let sawFinish = false;
            try {
                const stream = preparedCall?.stream(request) ?? this.loopCtx.llm.stream(request);
                const iterator = stream[Symbol.asyncIterator]();
                signal.throwIfAborted();
                let completed = false;
                try {
                    while (true) {
                        const item = await budget.monitor('provider-iterator', () => iterator.next());
                        if (item.done) {
                            completed = true;
                            break;
                        }
                        const chunk = item.value;
                        signal.throwIfAborted();
                        sawFinish ||= chunk.type === 'finish';
                        chunkSeqs.push(this.session.append('assistant/chunk', { turn, step, chunk }).seq);
                        assembler.push(chunk);
                    }
                }
                finally {
                    if (!completed && iterator.return !== undefined) {
                        await budget.monitor('provider-close', async () => {
                            await iterator.return?.();
                        });
                    }
                }
                signal.throwIfAborted();
            }
            catch (error) {
                if (signal.aborted) {
                    const content = assembler.interruptedBlocks();
                    if (content.length > 0) {
                        this.session.append('assistant/message', {
                            turn,
                            step,
                            message: createAssistantMessage({
                                content,
                                source: { provider: request.provider, model: request.model },
                            }),
                            interrupted: true,
                            ...assembler.usage === undefined ? {} : { usage: assembler.usage },
                        }, { surfaceOp: 'append', sourceEventSeqs: chunkSeqs });
                    }
                }
                throw error;
            }
            const finish = sawFinish
                ? assembler.finish
                : {
                    kind: 'error',
                    failure: {
                        message: 'model stream closed without a terminal finish chunk',
                        code: 'STREAM_CLOSED',
                    },
                };
            if (finish.kind === 'error' || finish.kind === 'aborted') {
                const action = await budget.monitor('request-recovery', () => this.dispatch.waterfall('agent/request-error', {
                    turn,
                    step,
                    provider: request.provider,
                    failure: finish.failure,
                    retryPolicy: preparedCall?.retryPolicy,
                    signal,
                }, () => Promise.resolve(undefined)));
                signal.throwIfAborted();
                if (action?.kind !== 'retry') {
                    throw new LlmError(finish.failure.message, finish.failure.code, finish.failure);
                }
                continue;
            }
            const message = createAssistantMessage({
                content: assembler.blocks(),
                source: {
                    provider: request.provider,
                    model: request.model,
                    ...assembler.replayState !== undefined ? { replayState: assembler.replayState } : {},
                },
            });
            this.session.append('assistant/message', {
                turn,
                step,
                message,
                ...assembler.usage === undefined ? {} : { usage: assembler.usage },
            }, { surfaceOp: 'append', sourceEventSeqs: chunkSeqs });
            if (finish.kind === 'max-tokens')
                return { kind: 'max-tokens' };
            const toolCalls = message.content.filter(block => block.type === 'tool-call');
            if (toolCalls.length === 0)
                return { kind: 'completed' };
            // A cancellation fired by an assistant-message observer still owes one
            // synthetic call/result pair per requested tool. Do not replace that
            // replay contract with a budget check after cancellation has won.
            if (!signal.aborted)
                budget.consumeToolCalls(toolCalls.length);
            const { concluded } = await executeToolCalls(this.loopCtx, turn, step, toolCalls, signal, context => this.inbox.splice('next-step', this.inbox.nextStep.length, 0, [context]), (stage, operation) => budget.monitor(stage, operation));
            return concluded ? { kind: 'completed' } : null;
        }
    }
    /**
     * Compose one frozen request and bind it to the adapter registration that
     * resolved its exact-model defaults.
     */
    async buildRequest(turn, step, tools, system, boundaryMessages, signal, budget) {
        const { session } = this;
        // A loop instance starts from its declared route, restoring only an explicit
        // effort owned by that exact model. Later steps re-resolve marked defaults.
        const persistedHeader = session.requestHeader();
        const persistedConfig = persistedHeader?.config;
        const route = { provider: this.options.provider ?? '', model: this.options.model ?? '' };
        const reasoningEffort = persistedConfig?.provider === route.provider
            && persistedConfig.model === route.model
            && persistedHeader?.adapterDefaults?.reasoningEffort !== true
            ? persistedConfig.reasoningEffort
            : undefined;
        const maxTokens = this.options.maxTokens;
        const seedConfig = deepFreeze(structuredClone(this.requestHeaderLogged
            // oxlint-disable-next-line typescript/no-non-null-assertion -- the instance logged the header it now folds
            ? requestProposal(persistedHeader)
            : {
                ...route,
                ...reasoningEffort === undefined ? {} : { reasoningEffort },
                ...maxTokens === undefined ? {} : { maxTokens },
            }));
        const proposedConfig = await budget.monitor('request-config', () => this.dispatch.waterfall('agent/request', { turn, step, signal }, () => Promise.resolve(seedConfig)));
        signal.throwIfAborted();
        if (!proposedConfig.provider || !proposedConfig.model) {
            throw new Error(`agent "${this.id}" has no provider/model: set AgentOptions.provider and AgentOptions.model or supply both via the agent/request waterfall`);
        }
        let config;
        let preparedCall;
        try {
            preparedCall = await budget.monitor('prepare-call', () => this.loopCtx.llm.prepareCall(proposedConfig, signal));
            config = preparedCall.config;
        }
        catch (error) {
            // Middleware may serve an unregistered route; terminal dispatch still requires an adapter.
            if (!(error instanceof LlmError) || error.code !== 'NO_ADAPTER')
                throw error;
            config = proposedConfig;
        }
        signal.throwIfAborted();
        const header = canonicalHeader({
            config,
            ...preparedCall === undefined ? {} : { adapterDefaults: preparedCall.adapterDefaults },
            ...system ? { system } : {},
            ...tools.length > 0 ? { tools } : {},
        });
        const baseline = this.session.requestHeader();
        if (!this.requestHeaderLogged) {
            this.session.append('request/header', { header, reason: baseline === undefined ? 'initial' : 'resume' });
            this.requestHeaderLogged = true;
        }
        else if (baseline === undefined || !headerEquals(baseline, header)) {
            this.session.append('request/header', { header, reason: 'change' });
        }
        const contextWindow = preparedCall?.context?.contextWindow;
        const requestContext = {
            provider: config.provider,
            model: config.model,
            ...contextWindow === undefined ? {} : { contextWindow },
        };
        const previousContext = session.requestContext();
        if (previousContext?.provider !== requestContext.provider
            || previousContext.model !== requestContext.model
            || previousContext.contextWindow !== requestContext.contextWindow) {
            session.append('request/context', requestContext);
        }
        signal.throwIfAborted();
        const request = markAgentLoopRequest(deepFreeze({
            ...header.config,
            messages: boundaryMessages,
            ...header.system !== undefined ? { system: header.system } : {},
            ...header.tools !== undefined ? { tools: header.tools } : {},
            sessionId: this.session.id,
            signal,
        }));
        return { request, ...preparedCall === undefined ? {} : { preparedCall } };
    }
}
//# sourceMappingURL=agent.js.map