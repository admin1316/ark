/** Durable per-session state for the user-controlled model-selection opt-in. */
import type { Session } from '@deepseek-ai/dsh-session';
import { type AllowedModelRoute } from './model-selection.ts';
declare module '@deepseek-ai/dsh-session/types' {
    interface SessionEventMap {
        /** Captures the exact child routes authorized for this session. */
        'subagent/model-selection-policy': {
            allowedModels: AllowedModelRoute[];
        };
    }
}
/**
 * Read the session-captured route list, or undefined for fixed-route sessions.
 * @param session - The session input.
 * @returns The value produced by subagent model selection policy.
 */
export declare function subagentModelSelectionPolicy(session: Session): AllowedModelRoute[] | undefined;
/**
 * Append the allowlist once, before the session can make a model-facing choice.
 * @param session - The session input.
 * @param allowedModels - The allowed models input.
 */
export declare function recordSubagentModelSelection(session: Session, allowedModels: readonly AllowedModelRoute[]): void;
//# sourceMappingURL=model-selection-state.d.ts.map