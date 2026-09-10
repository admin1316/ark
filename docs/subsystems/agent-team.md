# Agent Teams

English | [中文](agent-team.zh.md)

Types shared by the implicit-root Team domain, model tools, and host adapters. The [Agent Teams Agent Note](../../.agents/notes/implemented/feature/2026-08-05-agent-teams.md) owns identity, mailbox, task, and shared-checkout decisions; the [promotion decision](../../.agents/notes/implemented/architecture/2026-08-30-agent-teams-product-promotion.md) owns its Subagent package placement. This page records the literal durable forms from [`packages/subagent/agent-team/src/types.ts`](../../packages/subagent/agent-team/src/types.ts).

## Identity and roster

`TeamId` is the root `SessionId` under a distinct [brand](core.md#branded-ids). `TeamTaskId` is Team-local and monotonically allocated as `task-<n>`; `TeamMessageId` is globally random. A teammate's Session id remains its persistent identity, while `name` is an immutable model/UI label.

```ts type-equiv
/** Whole durable value written on every teammate lifecycle change. */
interface TeamMemberSnapshot {
  readonly id: SessionId
  readonly name: string
  readonly description: string
  readonly provider: string
  readonly context: 'fresh' | 'fork'
  readonly phase: TeamMemberPhase
  readonly error?: string
}
```

Every member starts in `provisioning` and reaches exactly one terminal roster phase, `active` or `failed`. Runtime `running`/`idle`/`inactive` status is derived separately and never rewrites this record.

## Durable mailbox

The Lead Session first stores the complete queued message. A target receipt is acknowledged only after its pending inbox item or recorded user message is durable, leaving queued-minus-delivered as the recovery mailbox.

```ts type-equiv
/** One peer message retained until its target Session records it. */
interface TeamMessageSnapshot {
  readonly id: TeamMessageId
  readonly senderId: SessionId
  readonly senderName: string
  readonly targetId: SessionId
  readonly delivery: 'quiet' | 'wakeup'
  readonly content: ContentBlock[]
}
```

The target Session keeps message identity and sender attribution on both the pending inbox item and the eventual user message. Folding that source across inbox and history is the target-side de-duplication key; the model-visible framing repeats the id and sender.

```ts type-equiv
/** Source retained by the target Session for durable mailbox de-duplication. */
interface TeamMessageSource {
  readonly kind: 'team-message'
  readonly teamId: TeamId
  readonly messageId: TeamMessageId
  readonly senderId: SessionId
  readonly senderName: string
}
```

## Shared task DAG

Every task event stores a complete snapshot. `revision` is the compare-and-set value and increments by one per mutation. `blockedBy` edges must name non-deleted tasks and keep the graph acyclic. `writeScopes` are normalized advisory path prefixes rather than locks.

```ts type-equiv
/** Whole durable task snapshot; every mutation increments {@link revision}. */
interface TeamTaskSnapshot {
  readonly id: TeamTaskId
  readonly revision: number
  readonly subject: string
  readonly description: string
  readonly status: TeamTaskStatus
  readonly ownerId?: SessionId
  readonly blockedBy: TeamTaskId[]
  readonly writeScopes: string[]
}
```

`pending` is unstarted or released, `in_progress` carries an owner, `completed` satisfies blockers, and `deleted` is a retained tombstone. Views add owner name, readiness, and write-scope overlap warnings without changing the durable snapshot.

## Replay

`foldTeam()` replays one root Session into the roster, task board, and queued-minus-delivered mailbox that every Team operation reads. It selects records by `TeamId`, so events inherited by an ordinary fork retain the ancestor id and never enter the new root's state. Session event `seq` and `time` remain the ordering and timing record; Team snapshots do not duplicate them. Roster and task reads reach callers as views that add owner name, readiness, and write-scope warnings, while pending mail stays internal to delivery and recovery. The package [README](../../packages/subagent/agent-team/README.md) owns operation, authorization, recovery, and limit behavior.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxagentteams--teamservice"></a>

### `ctx.agentTeams` — `TeamService`

Agent Teams backed by the exact live Lead's durable Session log.

```ts cordis-catalog
/**
 * Require the caller's current live team membership.
 * @param agent - exact live caller.
 * @returns current Team role.
 */
membership(agent: Agent): TeamMembership

/**
 * Read the live member's team roster.
 * @param agent - exact live member.
 * @returns roster in creation order.
 */
listMembers(agent: Agent): TeamMemberView[]

/**
 * Create a teammate under the live Lead's roster and runtime lifetime.
 * @param caller - exact Lead.
 * @param request - creation request.
 * @returns durable active member.
 */
async spawnTeammate(caller: Agent, request: SpawnTeammateRequest): Promise<SpawnTeammateResult>

/**
 * Admit a peer message through the durable team mailbox.
 * @param caller - exact sender.
 * @param request - peer message.
 * @returns durable admission result.
 */
async sendMessage(caller: Agent, request: SendTeamMessageRequest): Promise<SendTeamMessageResult>

/**
 * Add a task to the caller's durable team board.
 * @param caller - exact member.
 * @param request - new task fields.
 * @returns committed task view.
 */
async createTask(caller: Agent, request: CreateTeamTaskRequest): Promise<TeamTaskView>

/**
 * Read one task from the caller's team board.
 * @param caller - exact member.
 * @param id - task identity.
 * @returns latest task, including tombstones.
 */
getTask(caller: Agent, id: TeamTaskId): TeamTaskView

/**
 * Read visible tasks from the caller's team board.
 * @param caller - exact member.
 * @returns non-deleted tasks.
 */
listTasks(caller: Agent): TeamTaskView[]

/**
 * Commit a revision-checked team task mutation.
 * @param caller - exact member.
 * @param request - revision-checked mutation.
 * @returns committed task view.
 */
async updateTask(caller: Agent, request: UpdateTeamTaskRequest): Promise<TeamTaskView>

/**
 * Wait for activity in the caller's team without retaining ownership after cancellation.
 * @param caller - exact member.
 * @param timeoutMs - bounded wait.
 * @param signal - wait cancellation.
 * @returns change or timeout.
 */
async waitForChange(caller: Agent, timeoutMs: number, signal: AbortSignal): Promise<TeamWaitResult>

/**
 * Interrupt a teammate owned by the live Lead.
 * @param caller - exact Lead.
 * @param targetName - teammate name.
 * @returns status before interruption.
 */
interrupt(caller: Agent, targetName: string): { previousStatus: 'running' | 'idle' | 'inactive' }

/**
 * Probe membership without admitting stale or foreign callers.
 * @param agent - candidate caller.
 * @returns membership or undefined for stale or foreign identities.
 */
tryMembership(agent: Agent): TeamMembership | undefined
```

Types: [Agent](core.md)

Source: [`packages/subagent/agent-team/src/index.ts`](../../packages/subagent/agent-team/src/index.ts)
<!-- END GENERATED cordis-surface -->
