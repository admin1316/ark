# Agent Teams

[English](agent-team.md) | 中文

隐式 Root Team 领域、模型工具与宿主适配器共享的类型。[Agent Teams Agent Note](../../.agents/notes/implemented/feature/2026-08-05-agent-teams.zh.md)负责身份、mailbox、task 与共享 checkout 决策；[晋级决策](../../.agents/notes/implemented/architecture/2026-08-30-agent-teams-product-promotion.zh.md)负责其 Subagent 包归属。本页记录 [`packages/subagent/agent-team/src/types.ts`](../../packages/subagent/agent-team/src/types.ts) 中的字面持久形式。

## 身份与 roster

`TeamId` 是具有独立[品牌](core.zh.md#branded-ids)的 Root `SessionId`。`TeamTaskId` 在 Team 内按 `task-<n>` 单调分配；`TeamMessageId` 是全局随机值。teammate 的 Session id 始终是持久身份，而 `name` 是不可变的模型／UI 标签。

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

每个 member 都从 `provisioning` 开始，并且只到达一个终态 roster phase：`active` 或 `failed`。运行时 `running`／`idle`／`inactive` 状态单独派生，绝不会重写该记录。

## 持久 mailbox

Lead Session 首先存储完整 queued message。只有 target 的 pending inbox 条目或已记录用户消息完成持久化，才会写入独立 acknowledgement event，queued-minus-delivered 因而构成恢复 mailbox。

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

target Session 会在 pending inbox 条目和最终用户消息上保留消息身份与发送者归因。跨 inbox 与历史折叠该 source 构成 target 侧去重键；模型可见的 framing 会重复 id 和发送者。

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

## 共享任务 DAG

每条 task event 都存储完整快照。`revision` 是 compare-and-set 值，每次变更递增 1。`blockedBy` edge 必须指向未删除任务，并维持无环图。`writeScopes` 是规范化的提示性路径前缀，不是锁。

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

`pending` 表示尚未开始或已经释放，`in_progress` 携带 owner，`completed` 满足 blocker，`deleted` 是保留的 tombstone。view 会添加 owner name、readiness 和 write-scope 重叠警告，但不会改变持久快照。

## 回放

`foldTeam()` 把一个 Root Session 回放成每个 Team 操作所读取的 roster、任务板与 queued-minus-delivered mailbox。它按 `TeamId` 选取记录，因此普通 fork 继承的 event 保留 ancestor id，绝不会进入新 Root 的状态。Session event 的 `seq` 与 `time` 继续负责顺序和时间记录，Team snapshot 不再重复保存它们。roster 与 task 读取以 view 形式到达调用方，附带 owner name、readiness 与 write-scope 警告，而 pending 邮件仅供投递与恢复内部使用。包 [README](../../packages/subagent/agent-team/README.zh.md)负责 operation、authorization、recovery 和限制行为。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

Types: [Agent](core.zh.md)

Source: [`packages/subagent/agent-team/src/index.ts`](../../packages/subagent/agent-team/src/index.ts)
<!-- END GENERATED cordis-surface -->
