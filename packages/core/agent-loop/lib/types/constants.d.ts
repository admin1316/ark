/** Shared agent-loop scheduler and safety defaults.
 * @module dsh-agent-loop/constants
 */
/** Limits snapshotted once when a turn opens; live changes never move an in-flight boundary. */
export interface AgentTurnBudgetLimits {
    /** Maximum wall-clock duration of one turn, including retry waits and extension points. */
    maxElapsedMs: number;
    /** Maximum entered model/tool steps in one turn. */
    maxSteps: number;
    /** Maximum model dispatch attempts, including retries of the same step. */
    maxModelAttempts: number;
    /** Maximum model-requested tool calls across the turn. */
    maxToolCalls: number;
    /** Time allowed after cancellation for in-process code to cooperate before quiescence reports a residual. */
    cancellationGraceMs: number;
}
/** Default maximum in-flight parallel-safe calls per agent step. */
export declare const DEFAULT_MAX_PARALLEL_TOOL_CALLS = 10;
/**
 * High but finite defaults: ordinary turns never approach these limits, while
 * legitimate multi-agent research may run for hours and use thousands of
 * model/tool boundaries without being shortened.
 */
export declare const DEFAULT_AGENT_TURN_BUDGET: Readonly<AgentTurnBudgetLimits>;
//# sourceMappingURL=constants.d.ts.map