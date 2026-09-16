/** Durable model-selection intent and request-use projection. */
import { z } from 'zod';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm';
const modelSelectionSchema = z.object({
    provider: z.string().min(1),
    model: z.string().min(1),
    reasoningEffort: z.string().min(1).optional(),
}).transform(({ provider, model, reasoningEffort }) => ({
    provider, model,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
}));
const modelSelectionProjectionStateSchema = z.object({
    lastUsed: modelSelectionSchema.nullable(),
    pending: modelSelectionSchema.nullable(),
});
const modelSelectionProjectionSchema = z.object({
    lastUsed: modelSelectionSchema.nullable(),
    next: modelSelectionSchema.nullable(),
});
/**
 * Advance durable model-selection state by one Session event.
 * @param state - selection state before the event.
 * @param event - next committed Session event.
 * @returns the original or advanced selection state.
 */
function applyModelSelectionProjection(state, event) {
    if (event.type === 'model/selection') {
        return sameSelection(state.pending, event.data)
            ? state
            : { lastUsed: state.lastUsed, pending: event.data };
    }
    if (event.type !== 'request/header')
        return state;
    const lastUsed = {
        provider: event.data.header.config.provider,
        model: event.data.header.config.model,
        ...(event.data.header.config.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: String(event.data.header.config.reasoningEffort) }),
    };
    const pending = sameSelection(state.pending, lastUsed) ? null : state.pending;
    return sameSelection(state.lastUsed, lastUsed) && pending === state.pending
        ? state
        : { lastUsed, pending };
}
const modelSelectionProjection = {
    key: 'modelSelection',
    stateSchema: modelSelectionProjectionStateSchema,
    init: () => ({ lastUsed: null, pending: null }),
    apply: applyModelSelectionProjection,
    wire: {
        viewSchema: modelSelectionProjectionSchema,
        view: state => ({ lastUsed: state.lastUsed, next: state.pending ?? state.lastUsed }),
    },
    stateVersion: 2,
};
function sameSelection(left, right) {
    return left === right || (left !== null && right !== null
        && left.provider === right.provider
        && left.model === right.model
        && left.reasoningEffort === right.reasoningEffort);
}
/**
 * Register the durable model-selection projection when the registry is present.
 * @param ctx - neutral model owner with a mounted projection registry.
 */
export function installModelSelectionProjection(ctx) {
    ctx.sessionProjections.register(modelSelectionProjection);
}
const installedSelections = new WeakMap();
/**
 * Reuse durable pending state; no transport maintains a second pending selection cache.
 * @param ctx - model owner with the registered model-selection projection and default-model service.
 * @param agent - exact Agent receiving the shared request-assembly selection adapter.
 * @returns cached Agent-scoped adapter; current selection reads pending state, then the logged request, then defaults.
 * @throws Error when the durable model-selection projection is unavailable.
 */
export function sessionModelSelection(ctx, agent) {
    const existing = installedSelections.get(agent);
    if (existing !== undefined)
        return existing;
    const registry = ctx.get('sessionProjections');
    if (registry === undefined || registry.stateOf(agent.session, 'modelSelection') === undefined) {
        throw new Error('agent-default-model: required modelSelection projection is not registered');
    }
    const selection = {
        get current() {
            const pending = registry.stateOf(agent.session, 'modelSelection')?.pending;
            if (pending != null)
                return {
                    provider: pending.provider, model: pending.model,
                    ...(pending.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(pending.reasoningEffort) }),
                };
            const loggedHeader = agent.session.requestHeader();
            if (loggedHeader === undefined)
                return ctx.agentDefaultModel.currentSelection();
            const logged = loggedHeader.config;
            return {
                provider: logged.provider, model: logged.model,
                ...(logged.reasoningEffort === undefined || loggedHeader.adapterDefaults?.reasoningEffort === true
                    ? {} : { reasoningEffort: logged.reasoningEffort }),
            };
        },
        assembled: undefined,
    };
    installModelSelection(agent.ctx, selection);
    installedSelections.set(agent, selection);
    return selection;
}
//# sourceMappingURL=session-selection.js.map