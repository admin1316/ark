/**
 * The session-log record of which preset a session actually runs.
 *
 * The creation header names the preset a session STARTED with, and it is
 * deep-frozen because that is a creation fact. A session may still change
 * preset while it is blank, and the effect of that change outlives the blank
 * window: the first turn — and every turn after it — runs under the newly
 * mounted composition. Recording the change is what keeps the log honest, and
 * it is required outright by the repo's model-visible ⟺ logged rule, since the
 * preset decides the tool schemas and prompt sections the model sees.
 *
 * Reconstruction reads the `agentPreset` Session projection, never the header
 * alone.
 * @module @deepseek-ai/dsh-agent-presets/session
 */
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session';
import { z } from 'zod';
declare module '@deepseek-ai/dsh-session/types' {
    interface SessionEventMap {
        /**
         * The session's agent preset was chosen after creation, while the session
         * was still blank. Log-only: it records the composition later turns ran
         * under, so a resumed or forked session rebuilds the same one instead of
         * the header's creation-time value.
         */
        'agent-preset/selected': {
            agentPreset: string;
        };
    }
}
/** The persisted header and ordered log needed to reconstruct a session's preset. */
export interface PresetBearingSession {
    readonly header: SessionHeader;
    readonly events: readonly SessionEvent[];
}
/** Current Session preset, initialized from its header and advanced by selection events. */
export declare const agentPresetProjectionDefinition: {
    key: "agentPreset";
    stateSchema: z.ZodUnion<readonly [z.ZodString, z.ZodNull]>;
    init: (header: SessionHeader) => string | null;
    apply: (state: string | null, event: SessionEvent) => string | null;
    wire: {
        viewSchema: z.ZodUnion<readonly [z.ZodString, z.ZodNull]>;
        view: (state: string | null) => string | null;
    };
    stateVersion: number;
};
/**
 * The preset a session actually runs, newest selection winning.
 *
 * The header supplies the creation-time value; every later selection is a
 * logged event, so the last one is the answer. Reading the header alone
 * rebuilds a switched session under the composition it was created with, not
 * the one its history was produced under. The projection above carries the
 * same answer for runtime state; this scan reads raw history for callers
 * holding only the log.
 * @param session - the session's header and event log.
 * @returns the preset id, or `undefined` when the deployment composes none.
 */
export declare function resolveSessionPreset(session: PresetBearingSession): string | undefined;
//# sourceMappingURL=session.d.ts.map