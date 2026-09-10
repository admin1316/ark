import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { SessionId } from '@deepseek-ai/dsh-session';
import { TeamId } from './brand.ts';
import type { TeamFoldState } from './fold.ts';
import type { TeamJournal } from './journal.ts';
import type { TeamRuntimeLifecycle } from './lifecycle.ts';
import type { SpawnTeammateRequest, SpawnTeammateResult, TeamMemberView } from './types.ts';
/** Caller authority inside one implicit Team. */
export interface TeamMembership {
    readonly root: Agent;
    readonly id: TeamId;
    readonly role: 'lead' | 'teammate';
    readonly name: string;
}
/**
 * Resolve an active teammate name or the Lead pseudo-row.
 * @param root - exact live Lead.
 * @param state - current Team fold.
 * @param rawName - member name to resolve.
 * @returns durable identity and normalized name.
 */
export declare function resolveActiveMember(root: Agent, state: TeamFoldState, rawName: string): {
    id: SessionId;
    name: string;
};
/** Owns roster identities and their continuable children. */
export declare class TeamRoster {
    private readonly ctx;
    private readonly journal;
    private readonly lifecycle;
    private readonly maxMembers;
    private readonly inFlightCreations;
    constructor(ctx: Context, journal: TeamJournal, lifecycle: TeamRuntimeLifecycle, maxMembers: number);
    /**
     * Require membership of an exact live Agent.
     * @param agent - calling Agent identity.
     * @returns its current Team and role.
     */
    membership(agent: Agent): TeamMembership;
    /**
     * Resolve membership without admitting stale identities or foreign subagents.
     * @param agent - candidate live Agent.
     * @returns current membership, or undefined when it cannot be established.
     */
    tryMembership(agent: Agent): TeamMembership | undefined;
    /**
     * List the roster with current runtime status.
     * @param membership - exact caller membership.
     * @returns Lead and teammate rows in creation order.
     */
    list(membership: TeamMembership): TeamMemberView[];
    /**
     * Admit one Lead-owned teammate creation before the shutdown cutoff.
     * @param caller - exact live Lead.
     * @param request - teammate identity, initial message, provider and cancellation.
     * @returns the active member after durable prompt acceptance.
     */
    spawn(caller: Agent, request: SpawnTeammateRequest): Promise<SpawnTeammateResult>;
    /**
     * Capture admitted creations before ordered disposal.
     * @returns creation operations that have not settled.
     */
    pendingCreations(): readonly Promise<unknown>[];
    /**
     * Reconcile provisioning when a Team Lead starts.
     * @param agent - newly started exact live Agent.
     * @param signal - runtime cancellation.
     */
    recoverFor(agent: Agent, signal: AbortSignal): Promise<void>;
    /**
     * Interrupt a teammate turn without discarding its pending inbox.
     * @param caller - exact live Lead.
     * @param targetName - durable teammate name.
     * @returns status immediately before cancellation.
     */
    interrupt(caller: Agent, targetName: string): {
        previousStatus: 'running' | 'idle' | 'inactive';
    };
    /**
     * Group currently live roster children for owner-checked teardown.
     * @returns child session identities grouped by their exact current Lead.
     */
    liveChildrenByRoot(): Map<Agent, SessionId[]>;
    /**
     * Release selected teammate activations through their continuation owner.
     * @param root - exact Lead authorizing release.
     * @param childIds - selected roster children.
     */
    stopTeammates(root: Agent, childIds: readonly SessionId[]): Promise<void>;
    private spawnAdmitted;
    private checkpointInitialPrompt;
    private reconcileProvisioning;
    private memberView;
    private memberName;
    private settleProvisioning;
    private subagentDescriptor;
}
//# sourceMappingURL=roster.d.ts.map