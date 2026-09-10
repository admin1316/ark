/**
 * Default Agent driver over queued turns and step-boundary input. Every request
 * is derived from the session log.
 * @module dsh-agent-loop/agent
 */
import type { Agent, AgentCancelCause, AgentOptions, AgentStatus, CancelOptions, InboxTarget } from '@deepseek-ai/dsh-agent';
import { Inbox } from '@deepseek-ai/dsh-agent';
import type { Scope, Scoped } from '@deepseek-ai/dsh-scope';
import type { Session, SessionId, UserMessage } from '@deepseek-ai/dsh-session';
import type { Context } from '@deepseek-ai/cordis';
import type { AgentTurnBudgetLimits } from './constants.ts';
/** One finite dimension of the authoritative per-turn execution budget. */
export type AgentTurnBudgetDimension = 'elapsed-ms' | 'steps' | 'model-attempts' | 'tool-calls';
/** Lossless accounting captured at a budget or quiescence boundary. */
export interface AgentTurnBudgetUsage {
    elapsedMs: number;
    steps: number;
    modelAttempts: number;
    toolCalls: number;
}
/** Durable terminal reason emitted when a finite turn budget is exhausted. */
export interface AgentTurnBudgetExhaustedReason {
    kind: 'budget-exhausted';
    dimension: AgentTurnBudgetDimension;
    limit: number;
    observed: number;
    usage: AgentTurnBudgetUsage;
}
/** Await boundary that remained live after its cancellation grace elapsed. */
export type AgentOperationStage = 'system-prompt' | 'pre-step' | 'request-config' | 'prepare-call' | 'provider-iterator' | 'provider-close' | 'request-recovery' | 'tool-policy' | 'tool-body' | 'tool-finalize' | 'turn-stopping';
/** Exact process-local residual reported without pretending the agent is quiescent. */
export interface AgentQuiescenceResidual {
    code: 'AGENT_OPERATION_UNRESPONSIVE';
    abortKind: AgentCancelCause['kind'] | 'budget-exhausted' | 'unknown';
    graceMs: number;
    operations: {
        stage: AgentOperationStage;
        count: number;
    }[];
    budget: AgentTurnBudgetUsage;
}
declare module '@deepseek-ai/dsh-session/types' {
    interface TurnEndReasonMap {
        /** The loop stopped before admitting work beyond one finite turn budget. */
        'budget-exhausted': AgentTurnBudgetExhaustedReason;
    }
}
declare module '@deepseek-ai/cordis' {
    interface Events {
        /**
         * Cancellation reached its finite grace boundary while same-process code
         * was still executing. The Agent remains registered and non-quiescent.
         * Scope-filtered dispatch keys the carrier by `payload.agent`, preserving
         * its base filter and admitting unscoped listeners or listeners in that
         * agent's scope or an enclosing scope. This is a process-local notification.
         * @param payload - Live agent, current turn and step, and residual-operation accounting.
         * @mode emit
         */
        'agent/quiescence-timeout'(this: Scoped<Agent>, payload: {
            agent: Agent;
            turn: number;
            step: number;
            residual: AgentQuiescenceResidual;
        }): void;
    }
}
/**
 * Bounded wait outcome for same-process code that ignored cancellation. The
 * operation is deliberately NOT detached: the Agent stays registered and
 * running until the underlying promise really settles.
 */
export declare class AgentQuiescenceTimeoutError extends Error {
    readonly residual: AgentQuiescenceResidual;
    /** Identifies cancellation that exceeded its grace with operations still active. */
    readonly code = "AGENT_OPERATION_UNRESPONSIVE";
    constructor(residual: AgentQuiescenceResidual);
}
/** Drives one session through turn and step boundaries. */
export declare class ReactLoopAgent implements Agent {
    private loopCtx;
    readonly id: SessionId;
    readonly options: AgentOptions;
    readonly session: Session;
    private readonly turnBudgetLimits;
    readonly inbox: Inbox;
    private phase;
    private activity;
    private closing;
    /** The agent-scoped registration boundary; the lifecycle owner unwinds it after the driver exits. */
    readonly scope: Scope;
    readonly ctx: Context;
    /** Fused dispatcher, built once in the constructor so hot-path dispatches never allocate. */
    private readonly dispatch;
    /** Whether this loop instance has appended its initial/resume request anchor. */
    private requestHeaderLogged;
    private readonly runtimeContext;
    constructor(loopCtx: Context, id: SessionId, options: AgentOptions, session: Session, turnBudgetLimits?: AgentTurnBudgetLimits);
    get status(): AgentStatus;
    /** Commit a phase and publish its externally visible status transition. */
    private setPhase;
    send(message: UserMessage, target: InboxTarget, wakeup: boolean): void;
    followup(input: UserMessage): void;
    steer(input: UserMessage): void;
    inject(input: UserMessage): void;
    cancel(cause: AgentCancelCause, options?: CancelOptions): void;
    runMaintenance<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T>;
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
    private wakeDriver;
    whenIdle(): Promise<void>;
    /** Report one failure at its live boundary, then preserve it for driver containment. */
    private throwError;
    private kick;
    private preStep;
    /** Open one turn before claiming its first proposed step. */
    private turn;
    private step;
    /**
     * Compose one frozen request and bind it to the adapter registration that
     * resolved its exact-model defaults.
     */
    private buildRequest;
}
//# sourceMappingURL=agent.d.ts.map