/** Shared agent-loop scheduler and safety defaults.
 * @module dsh-agent-loop/constants
 */
/** Default maximum in-flight parallel-safe calls per agent step. */
export const DEFAULT_MAX_PARALLEL_TOOL_CALLS = 10;
/**
 * High but finite defaults: ordinary turns never approach these limits, while
 * legitimate multi-agent research may run for hours and use thousands of
 * model/tool boundaries without being shortened.
 */
export const DEFAULT_AGENT_TURN_BUDGET = Object.freeze({
    maxElapsedMs: 12 * 60 * 60 * 1000,
    maxSteps: 4_096,
    maxModelAttempts: 8_192,
    maxToolCalls: 65_536,
    cancellationGraceMs: 10_000,
});
//# sourceMappingURL=constants.js.map