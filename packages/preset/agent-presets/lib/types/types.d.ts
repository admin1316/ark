/** Client-safe event declarations owned by the agent-preset domain. */
import type { SessionId } from '@deepseek-ai/dsh-session/types';
/** One preset row for the Native `agentPresets/list` Remote catalog. */
export interface RemoteAgentPresetEntry {
    readonly id: string;
    readonly trust: 'system' | 'user';
    readonly isDefault: boolean;
    readonly name?: string;
    readonly description?: string;
    readonly broken?: string;
}
/** Current Native agent-preset catalog and its authoring affordances. */
export interface RemoteAgentPresetCatalog {
    readonly presets: readonly RemoteAgentPresetEntry[];
    readonly authorable: boolean;
    /** Whether a user-owned preset can resolve to a host-side directory. */
    readonly hasDocument: boolean;
}
/** Privileged read-only view of one resolved preset composition. */
export interface RemoteAgentPresetDocument {
    readonly agentPreset: string;
    readonly trust: 'system' | 'user';
    readonly content: string;
    readonly name?: string;
    readonly description?: string;
}
/** Opaque handoff receipt for one user-authored preset. */
export interface RemoteAgentPresetOpenTarget {
    /** The preset id the native Host must resolve again before opening. */
    readonly agentPreset: string;
    /** The Remote endpoint authorizes the handoff but never leaks a Host path. */
    readonly requiresNativeHandoff: true;
}
declare module '@deepseek-ai/cordis' {
    interface Events {
        /**
         * One session committed a different agent preset to its durable log.
         * Consumers invalidate only state derived from that session's composition.
         * @mode emit
         * @param sessionId - the session whose composition changed.
         * @param agentPreset - the preset recorded by the committed selection.
         */
        'agent-preset/selected'(sessionId: SessionId, agentPreset: string): void;
    }
}
export {};
//# sourceMappingURL=types.d.ts.map