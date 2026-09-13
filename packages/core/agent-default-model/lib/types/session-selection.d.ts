/** Durable model-selection intent and request-use projection. */
import type { Context } from '@deepseek-ai/cordis';
import { type Agent, type ModelSelection as AgentModelSelection, type ModelSelectionRef } from '@deepseek-ai/dsh-agent';
/** Complete model selection for one Session. */
export interface ModelSelection {
    readonly provider: string;
    readonly model: string;
    readonly reasoningEffort?: string;
}
/** Host fold state for durable model selection. */
export interface ModelSelectionProjectionState {
    /** Selection consumed by the latest recorded model request. */
    readonly lastUsed: ModelSelection | null;
    /** Later user selection not yet consumed by a matching model request. */
    readonly pending: ModelSelection | null;
}
/** Client view of the durable model-selection fold. */
export interface ModelSelectionProjection {
    /** Selection consumed by the latest recorded model request. */
    readonly lastUsed: ModelSelection | null;
    /** Selection the next request should use, falling back to {@link lastUsed}. */
    readonly next: ModelSelection | null;
}
declare module '@deepseek-ai/dsh-session/types' {
    interface SessionEventMap {
        /** Complete validated model intent for subsequent request assembly. */
        'model/selection': ModelSelection;
    }
}
declare module '@deepseek-ai/dsh-session-projection/types' {
    interface SessionProjectionStateMap {
        modelSelection: ModelSelectionProjectionState;
    }
    interface SessionProjectionMap {
        modelSelection: ModelSelectionProjection;
    }
}
/**
 * Register the durable model-selection projection when the registry is present.
 * @param ctx - neutral model owner with a mounted projection registry.
 */
export declare function installModelSelectionProjection(ctx: Context): void;
/** One Agent-scoped assembly adapter shared by every entry point. */
export type SessionModelSelection = ModelSelectionRef & {
    readonly current: AgentModelSelection;
};
/**
 * Reuse durable pending state; no transport maintains a second pending selection cache.
 * @param ctx - model owner with the registered model-selection projection and default-model service.
 * @param agent - exact Agent receiving the shared request-assembly selection adapter.
 * @returns cached Agent-scoped adapter; current selection reads pending state, then the logged request, then defaults.
 * @throws Error when the durable model-selection projection is unavailable.
 */
export declare function sessionModelSelection(ctx: Context, agent: Agent): SessionModelSelection;
//# sourceMappingURL=session-selection.d.ts.map