/**
 * Shared residency state, materialization contracts, and serialization
 * machinery for the continuable-subagent manager and its domain components —
 * the ownership graph, the activation materializer, the settlement watcher,
 * and the disposer. Kept in one module so the split classes never import
 * runtime bindings back from the manager file they were extracted from.
 *
 * @module @deepseek-ai/dsh-subagent
 */
import type { Agent, AgentHandle, AgentOptions, CreateAgentOptions } from '@deepseek-ai/dsh-agent';
import type { MessageId } from '@deepseek-ai/dsh-llm';
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session';
import type { ToolRestriction } from '@deepseek-ai/dsh-tools';
import type { DelegatedPolicyOverrides } from './child-agent.ts';
import type { ActivationObserver } from './lifecycle.ts';
import type { ContinuableCreateRequest, ContinuableCreateSpec, SubagentResult } from './types.ts';
/**
 * The residency state of one continuable child, derived from Agent quiescence
 * and the owned-child set rather than a second state machine:
 * `running` — the Agent has an active admission or turn, or waking inbox work;
 * `waiting` — the Agent is quiescent but still owns undisposed children;
 * `settled` — quiescent with every owned child disposed, so the manager
 * disposes the `AgentHandle` and removes the Activation.
 */
export type ActivationState = 'running' | 'waiting' | 'settled';
/**
 * Hooks the manager needs from the owning service. Declared here, by the
 * dependent, so the manager states exactly what it requires instead of
 * depending back on the whole {@link SubagentRuntime}. Package-private: no
 * consumer outside this package supplies a host.
 */
export interface ContinuationHost {
    /**
     * Resolve one provider's continuable-creation contribution, or reject when
     * the provider is unknown or lacks the capability.
     * @param name - the configured provider name.
     * @param request - the reserved identity, delegating parent, and cancellation.
     * @returns the provider's detached creation spec.
     */
    prepareContinuable(name: string, request: ContinuableCreateRequest): Promise<ContinuableCreateSpec>;
    /**
     * Build the lifecycle observer for one Activation's residency epoch.
     * @param provider - the provider name recorded in the durable descriptor.
     * @param childId - the durable child session id.
     * @param parent - the exact live direct parent for scoped dispatch.
     * @returns the observer whose edges this epoch publishes.
     */
    observeActivation(provider: string, childId: SessionId, parent: Agent): ActivationObserver;
}
/**
 * One residency epoch for a reconstructed continuable child Agent. It directly
 * owns the published `AgentHandle`; the manager's private activation-owner
 * scope is its structural Cordis owner.
 */
export interface Activation {
    /** The durable child this Activation is an epoch of. */
    readonly childId: SessionId;
    /**
     * The durable direct parent, stored because settlement delivery must resolve
     * that parent after the child handle is gone. {@link ancestry} cannot answer
     * it: a `WeakSet` is not enumerable, and the child's own header is only
     * reachable through a handle disposal has already released.
     */
    readonly parentSession: SessionId;
    /** The provider name recorded in the durable descriptor. */
    readonly provider: string;
    /** The retained live Agent handle, disposed exactly once at settlement. */
    readonly handle: AgentHandle;
    /**
     * Exact live Agent ancestry observed when this Activation materialized.
     * Weak membership preserves host-scope identity across an intermediate
     * ancestor leaving the registry without retaining that ancestor's runtime.
     */
    readonly ancestry: WeakSet<Agent>;
    /**
     * Session ids of the child Activations this one owns. Because one Session has
     * at most one live Activation, the id identifies the live child without
     * another runtime-incarnation reference. Non-empty blocks settlement.
     */
    readonly ownedChildren: Set<SessionId>;
    /** The lifecycle observer that emits this epoch's start and terminal edges. */
    readonly observer: ActivationObserver;
    /**
     * The memoized disposal transaction. Presence IS the admission cutoff: it is
     * assigned synchronously when disposal begins, so no delivery can join a
     * handle being torn down, and a racing delivery awaits it before cold-resuming
     * a new Activation. Every converging releaser shares this one teardown.
     */
    disposal: Promise<void> | undefined;
    /**
     * Accepted waking message ids this manager has not yet seen leave the inbox.
     * `Agent.status` is still `idle` in the window between `followup()` and the
     * microtask that admits it, so settlement must not treat that gap as quiet.
     */
    readonly accepted: Set<MessageId>;
    /** Short caller handoffs that keep a just-returned durable child resident. */
    handoffHolds: number;
    /**
     * Whether any delivery to this child was ever accepted. A materialization
     * rolled back before its first acceptance is a child the caller was told does
     * not exist, so its teardown owes the parent no settlement account.
     */
    announced: boolean;
    /** Renewed whenever a settlement watcher must re-observe quiescence. */
    poke: PromiseWithResolvers<void>;
}
/** Inputs shared by fresh and resumed Activation materialization. */
export interface MaterializeInputs {
    childId: SessionId;
    provider: string;
    parent: Agent;
    /**
     * Creation inputs; absent for a cold resume, which loads the persisted
     * session — including the delegation policy events a fresh creation seeded,
     * so a resume never re-captures the parent's policy.
     */
    create?: {
        seed: readonly SessionEvent[];
        meta: NonNullable<CreateAgentOptions['meta']>;
        /** Policy captured at the delegation boundary: the parent's sandbox override plus the approval pin. */
        delegatedPolicies: DelegatedPolicyOverrides;
    };
    agentOptions: AgentOptions;
    composition: {
        persona?: string | undefined;
        toolFilter?: ToolRestriction | undefined;
    };
    signal: AbortSignal;
}
/**
 * One admitted materialization and the exact live ancestry observed at its
 * synchronous admission boundary. Retaining identities lets a scoped teardown
 * keep waiting even if an intermediate Agent leaves the registry meanwhile.
 */
export interface Materialization {
    readonly lineage: readonly Agent[];
    readonly settled: Promise<void>;
}
/**
 * Read one Activation's current disposal transaction. This indirection exists
 * because TypeScript would otherwise narrow repeated reads of the mutable field
 * inside a long-lived closure to constants instead of re-reading runtime state.
 * @param activation - the Activation to inspect.
 * @returns the in-flight or settled disposal, or `undefined` while resident.
 */
export declare function disposalOf(activation: Activation): Promise<void> | undefined;
/**
 * One line telling a parent that a background child is finished and why, in
 * the parent's own task vocabulary.
 * @param childId - the durable child the parent knows by id.
 * @param stopReason - how the child's last ordinary turn ended.
 * @returns the model-facing opening line of the settlement notice.
 */
export declare function settlementSummary(childId: SessionId, stopReason: SubagentResult['stopReason']): string;
/** Whether one settlement attempt opened the disposal transaction. */
export type SettlementAttempt = {
    readonly settling: false;
} | {
    readonly settling: true;
    readonly done: Promise<void>;
};
/** Serialize each durable child's delivery, release, and disposal. */
export declare class ChildLock {
    private tails;
    /**
     * Run `operation` after every previously queued operation for `childId`.
     * @param childId - the durable child whose operations are linearized.
     * @param operation - the critical section to run in order.
     * @returns the operation's own settlement.
     */
    run<T>(childId: SessionId, operation: () => Promise<T>): Promise<T>;
}
//# sourceMappingURL=continuation-state.d.ts.map