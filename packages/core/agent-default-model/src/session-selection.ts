/** Durable model-selection intent and request-use projection. */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import { installModelSelection, type Agent, type ModelSelection as AgentModelSelection, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {} from './index.ts'

/** Complete model selection for one Session. */
export interface ModelSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** Host fold state for durable model selection. */
export interface ModelSelectionProjectionState {
  /** Selection consumed by the latest recorded model request. */
  readonly lastUsed: ModelSelection | null
  /** Later user selection not yet consumed by a matching model request. */
  readonly pending: ModelSelection | null
}

/** Client view of the durable model-selection fold. */
export interface ModelSelectionProjection {
  /** Selection consumed by the latest recorded model request. */
  readonly lastUsed: ModelSelection | null
  /** Selection the next request should use, falling back to {@link lastUsed}. */
  readonly next: ModelSelection | null
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Complete validated model intent for subsequent request assembly. */
    'model/selection': ModelSelection
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap { modelSelection: ModelSelectionProjectionState }
  interface SessionProjectionMap { modelSelection: ModelSelectionProjection }
}

const modelSelectionSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  reasoningEffort: z.string().min(1).optional(),
}).transform(({ provider, model, reasoningEffort }): ModelSelection => ({
  provider, model,
  ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
})) satisfies z.ZodType<ModelSelection>

const modelSelectionProjectionStateSchema = z.object({
  lastUsed: modelSelectionSchema.nullable(),
  pending: modelSelectionSchema.nullable(),
}) satisfies z.ZodType<ModelSelectionProjectionState>

const modelSelectionProjectionSchema = z.object({
  lastUsed: modelSelectionSchema.nullable(),
  next: modelSelectionSchema.nullable(),
}) satisfies z.ZodType<ModelSelectionProjection>

/**
 * Advance durable model-selection state by one Session event.
 * @param state - selection state before the event.
 * @param event - next committed Session event.
 * @returns the original or advanced selection state.
 */
function applyModelSelectionProjection(
  state: ModelSelectionProjectionState,
  event: SessionEvent,
): ModelSelectionProjectionState {
  if (event.type === 'model/selection') {
    return sameSelection(state.pending, event.data)
      ? state
      : { lastUsed: state.lastUsed, pending: event.data }
  }
  if (event.type !== 'request/header') return state
  const lastUsed: ModelSelection = {
    provider: event.data.header.config.provider,
    model: event.data.header.config.model,
    ...(event.data.header.config.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: String(event.data.header.config.reasoningEffort) }),
  }
  const pending = sameSelection(state.pending, lastUsed) ? null : state.pending
  return sameSelection(state.lastUsed, lastUsed) && pending === state.pending
    ? state
    : { lastUsed, pending }
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
} satisfies ProjectionDefinition<'modelSelection', ModelSelectionProjectionState>

function sameSelection(left: ModelSelection | null, right: ModelSelection | null): boolean {
  return left === right || (left !== null && right !== null
    && left.provider === right.provider
    && left.model === right.model
    && left.reasoningEffort === right.reasoningEffort)
}

/**
 * Register the durable model-selection projection when the registry is present.
 * @param ctx - neutral model owner with a mounted projection registry.
 */
export function installModelSelectionProjection(ctx: Context): void {
  ctx.sessionProjections.register(modelSelectionProjection)
}

/** One Agent-scoped assembly adapter shared by every entry point. */
export type SessionModelSelection = ModelSelectionRef & { readonly current: AgentModelSelection }
const installedSelections = new WeakMap<Agent, SessionModelSelection>()

/**
 * Reuse durable pending state; no transport maintains a second pending selection cache.
 * @param ctx - model owner with the registered model-selection projection and default-model service.
 * @param agent - exact Agent receiving the shared request-assembly selection adapter.
 * @returns cached Agent-scoped adapter; current selection reads pending state, then the logged request, then defaults.
 * @throws Error when the durable model-selection projection is unavailable.
 */
export function sessionModelSelection(ctx: Context, agent: Agent): SessionModelSelection {
  const existing = installedSelections.get(agent)
  if (existing !== undefined) return existing
  const registry = ctx.get('sessionProjections')
  if (registry === undefined || registry.stateOf(agent.session, 'modelSelection') === undefined) {
    throw new Error('agent-default-model: required modelSelection projection is not registered')
  }
  const selection: SessionModelSelection = {
    get current(): AgentModelSelection {
      const pending = registry.stateOf(agent.session, 'modelSelection')?.pending
      if (pending != null) return {
        provider: pending.provider, model: pending.model,
        ...(pending.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(pending.reasoningEffort) }),
      }
      const loggedHeader = agent.session.requestHeader()
      if (loggedHeader === undefined) return ctx.agentDefaultModel.currentSelection()
      const logged = loggedHeader.config
      return {
        provider: logged.provider, model: logged.model,
        ...(logged.reasoningEffort === undefined || loggedHeader.adapterDefaults?.reasoningEffort === true
          ? {} : { reasoningEffort: logged.reasoningEffort }),
      }
    },
    assembled: undefined,
  }
  installModelSelection(agent.ctx, selection)
  installedSelections.set(agent, selection)
  return selection
}
