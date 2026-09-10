# 工作区

[English](workspace.md) | 中文

工作区（workspace）是用户工作目录的持久记录：一个建立在规范路径之上的稳定 id、一个显示标题，以及归属于它的会话的有序账本。该子系统是单个包（package）（[dsh-workspace](../../packages/workspace/workspace)，`ctx.workspaceRegistry`）——一项宿主侧可选能力，不属于 agent loop（智能体循环）主干，并且对模型不可见（没有工具、没有提示词文本、没有会话事件）。它通过[存储领域数据形式](storage.zh.md)存储自己的记录，并对照 [`SessionHeader.cwd`](persistence.zh.md#sessionheader--metadata-beside-the-log) 校验会话成员资格，因此 `storageDomain` 与 `sessionPersistence` 是必需的启动依赖：持久化这一依赖不可用时，插件保持 pending，而不是把这种不可用误当作空历史。设计记录：[领域 KV 存储 Agent Note（agent 决策记录）](../../.agents/notes/proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.zh.md)；引导与 GUI 顺序：[Workspace UI 产品流程 Agent Note](../../.agents/notes/implemented/feature/2026-07-25-workspace-ui-product-flow.zh.md)。

源码：[`packages/workspace/workspace/src/types.ts`](../../packages/workspace/workspace/src/types.ts)

## 标识

```ts type-equiv
/**
 * Identifies one workspace record. A generated uuid, never the path: path
 * normalization rewrites paths, and a reference anchor must stay stable.
 */
type WorkspaceId = Branded<'WorkspaceId'>
```

`WorkspaceId` 是[品牌化 id](core.zh.md#branded-ids)。路径标识与之分离：`realpathNormalize`（`fs.realpath`；尾部斜杠、`..` 与符号链接全部解析）是唯一的一套唯一性规范——工作区路径以规范化形式存储，唯一性即规范路径的字符串相等（指向已被拥有目录的符号链接会与之冲突），attach 时的会话 cwd 检查也走同一套规范。

## 工作区实体

消费方只看到 `Workspace` 接口；实现保持包内私有。

```ts type-equiv
/**
 * One workspace: a stable id over an existing directory, a display title, and
 * an ordered candidate account of sessions. Membership requires both an id in
 * that account and a session header whose canonical cwd equals the workspace
 * path. Consumers only see this interface; the implementation stays private.
 */
interface Workspace {
  /** Stable record id (generated uuid). */
  readonly id: WorkspaceId

  /**
   * Canonical directory path: the `fs.realpath` of the path given at create
   * time (trailing slashes, `..`, and symlinks all resolved). Never rewritten
   * afterwards, even when the directory disappears (see {@link status}).
   */
  readonly path: string

  /** Display title. Defaults to `basename(path)` at create; duplicates are allowed. */
  readonly title: string

  /** ISO-8601 creation instant, stamped at create and never rewritten. */
  readonly createdAt: string

  /** ISO-8601 instant of the last durable mutation (create counts as one). */
  readonly updatedAt: string

  /**
   * Header-validated sessions in manually owned order: a new session is
   * prepended at attach, explicit reordering goes through
   * `insertSessionBefore`, and activity never reorders. The durable candidate
   * account is filtered synchronously: missing headers, invalid cwd values,
   * and canonical cwd mismatches are never returned. A subsequent workspace
   * mutation prunes those filtered candidates durably.
   */
  readonly sessionIds: readonly SessionId[]

  /**
   * Replace the display title durably.
   * @param title - New title; any string, duplicates across workspaces allowed.
   * @returns resolution after durability.
   */
  setTitle(title: string): Promise<void>

  /**
   * Prepend a session to this workspace's candidate account. An already
   * accounted id resolves without writing, aside from the durable
   * filtered-candidate prune every accepted mutation performs. A new id's
   * live or persisted
   * header cwd must resolve to an existing directory equal to {@link path};
   * unknown ids, missing or invalid cwd values, and mismatches reject without
   * writing.
   * @param sessionId - The session to record.
   * @returns resolution after durability.
   */
  attachSession(sessionId: SessionId): Promise<void>

  /**
   * Move an accounted session within the manual order, DOM-insertBefore-like:
   * with an anchor the session lands before it, without one it appends to the
   * end. Only the moved id changes position. A session or anchor absent from
   * the account rejects without writing; a move to the current position
   * resolves without writing, aside from the durable filtered-candidate
   * prune every accepted mutation performs; decided on the domain write
   * chain.
   * @param sessionId - The accounted session to move.
   * @param beforeSessionId - Accounted anchor to insert before; omitted appends.
   * @returns resolution after durability.
   */
  insertSessionBefore(sessionId: SessionId, beforeSessionId?: SessionId): Promise<void>

  /**
   * Remove a session from this workspace's account. Idempotent: an id not on
   * the account resolves without writing, aside from the durable
   * filtered-candidate prune every accepted mutation performs; decided on
   * the domain write chain like attach. Never touches the session's own stored log.
   * @param sessionId - The session to remove.
   * @returns resolution after durability.
   */
  detachSession(sessionId: SessionId): Promise<void>

  /**
   * Live directory check, uncached: whether {@link path} currently exists and
   * is a directory. A missing directory never mutates the record — the
   * directory may only be temporarily moved.
   * @returns `'ok'` when the directory exists, `'missing-dir'` otherwise.
   */
  status(): Promise<'ok' | 'missing-dir'>
}
```

所有权的真源是记录中有序的 `sessionIds`，绝不从会话 cwd 派生——但成员资格要求两者同时成立：账本上有其 id，且 header 的规范 cwd 等于工作区路径，因此一个会话在结构上至多属于一个工作区。失败的写入会拒绝（`insertSessionBefore` 的账本错误以 `WorkspaceMoveInvalidError` 拒绝，存储失败以普通错误拒绝）；每次被接受的变更都盖上 `updatedAt` 时间戳，并持久修剪不再通过成员资格检查的候选项。

## 注册表：`ctx.workspaceRegistry`

`WorkspaceRegistry`（[签名](#ctxworkspaceregistry--workspaceregistry)）拥有注册与解析。`create(path, title?)` 规范化路径，拒绝不存在的路径（原样传出原始 `ENOENT`）或非目录；当规范路径已被拥有时原样返回既有实体；否则创建一条标题为 `title ?? basename(path)` 的记录并前插到持久的注册表顺序中——新记录不得与既有显示标题重复（`WorkspaceNameConflictError`）。`get(id)` 与有序的 `list()` 是同步缓存读取；`resolveByPath(path)` 应用同一套 realpath 规范但不创建。`delete(id)` 只移除注册记录、顺序条目和会话账本——目录、用户文件、实时会话和已持久化日志一概不动，因此这些会话变为 Ungrouped（[决策](../../.agents/notes/implemented/feature/2026-07-27-workspace-registration-deletion.zh.md)）；未知 id 返回 `false`。create 与 delete 会在其两次写入（记录 + 顺序）可能分叉之前先持久写入一个待定变更标记；启动时恰好解决被标记的那次变更——通过删除被标记的表行：这会补完被中断的 delete，并回滚被中断的 create（注册可以重建，因此回滚是安全方向）——而没有标记的顺序/表不一致则作为损坏大声失败。

会话的 cwd 在创建时由创建者赋予，而不是由本注册表赋予——API 网关从所选工作区的 `path` 解析新会话的 cwd（回退到显式或默认 cwd），先创建会话使 cwd 落入其不可变的 [`SessionHeader`](persistence.zh.md#sessionheader--metadata-beside-the-log)，再调用 `attachSession`，后者会把已存储的 header cwd 与工作区路径重新校验一遍。首次成功启动时，注册表仅凭已持久化的 header（`id`、`cwd`、`createdAt`——绝不读事件正文）引导历史：把规范 cwd 有效的会话按目录分组为工作区，最新的排在最前；「已初始化」标记最后写入，因此被中断的引导可以安全续跑。引导只发生这一次：没有 cwd 的历史遗留会话保持 Ungrouped，此后创建的会话只能通过 `attachSession` 加入工作区。

## 消费方

`WorkspaceRegistry` 持有严格的 `workspace/*` Remote 方法，为原生端提供 CRUD 与已归档会话成员关系。[dsh-host-session-remote-operations](../../packages/host/session-remote-operations) 使用同一注册表完成创建/恢复准入，[dsh-host-native-events](../../packages/host/native-events) 则投影已经提交的 Workspace 变化。[dsh-agent-instructions](../../packages/context/agent-instructions) 尽管名字如此，却**不是**消费方：它在 agent 自己的 cwd 下发现 AGENTS.md 风格的指令文件，从不触碰 `ctx.workspaceRegistry`——两者共用的这个词指的是用户的工作目录，而非本注册表的实体。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxdirectorypicker--directorypicker-abstract-seam"></a>

### `ctx.directoryPicker` — `DirectoryPicker` (abstract seam)

Abstract directory-picking service. Subclass, implement `capability()`, and load the subclass as a plugin — it registers as `ctx.directoryPicker` (one implementation per context; loading a second throws, cordis' standard duplicate-service behavior). The capability object must be stable for the service lifetime: consumers may capture it across calls.

```ts cordis-catalog
/**
 * The backend's interaction capability.
 * @returns the discriminated capability consumers switch on.
 */
abstract capability(): DirectoryPickerCapability
```

Source: [`packages/host/directory-picker/src/index.ts`](../../packages/host/directory-picker/src/index.ts)

<a id="ctxdirectorypickercontroller--directorypickercontroller"></a>

### `ctx.directoryPickerController` — `DirectoryPickerController`

Host service backing the generated `ctx.remote.directoryPicker` namespace. The seam it exports is abstract and therefore never a Loader entry of its own, so this controller carries the wire verbs: one composed backend serves either the native chooser or the browse primitives, and a verb the composition cannot serve is refused rather than approximated.

```ts cordis-catalog
/**
 * Open the host's OS chooser for a Remote caller.
 * @param signal - caller lifetime; abort terminates the chooser.
 * @returns the chosen absolute path, or null when the operator cancels.
 */
@Remote('pick') async pick(signal: AbortSignal): Promise<string | null>

/**
 * List one directory level for a Remote caller's in-app browser.
 * @param path - absolute directory to list; absent lists the home directory.
 * @param signal - caller lifetime; abort stops the backend's scan instead of
 *   letting it outlive a disconnected caller.
 * @returns the level's listing with its ancestry.
 */
@Remote('list') async list(path: string | undefined, signal: AbortSignal): Promise<DirectoryListing>

/**
 * Create one child directory for a Remote caller's in-app browser.
 * @param path - absolute existing parent directory.
 * @param name - single non-blank path segment.
 * @returns the created directory's absolute path.
 */
@Remote('createDirectory') async createDirectory(path: string, name: string): Promise<string>
```

Source: [`packages/api/workspace-controller/src/directory-picker.ts`](../../packages/api/workspace-controller/src/directory-picker.ts)

<a id="ctxworkspacecontroller--workspacecontroller"></a>

### `ctx.workspaceController` — `WorkspaceController`

Host service backing the generated `ctx.remote.workspace` namespace.

```ts cordis-catalog
/**
 * Create or idempotently resolve one Workspace over an existing directory.
 * @param request - directory path to register.
 * @returns the Workspace and whether this call created it.
 */
@Remote('create') create(request: WorkspaceCreateRequest): Promise<WorkspaceCreateValue>

/**
 * Rename one Workspace to a unique non-blank title.
 * @param request - Workspace identity and proposed title.
 * @returns the updated Workspace projection.
 */
@Remote('rename') rename(request: WorkspaceRenameRequest): Promise<WorkspaceValue>

/**
 * Remove one Workspace registration while retaining files and Sessions.
 * @param request - Workspace identity to remove.
 * @returns deletion confirmation.
 */
@Remote('delete') delete(request: WorkspaceDeleteRequest): Promise<WorkspaceDeleteValue>

/**
 * Move one Workspace within the registry display order.
 * @param request - moved Workspace and optional anchor.
 * @returns the complete resulting Workspace order.
 */
@Remote('insertBefore') insertBefore(request: WorkspaceInsertBeforeRequest): Promise<WorkspaceOrderValue>

/**
 * Move one accounted Session within a Workspace.
 * @param request - Workspace, Session, and optional anchor identities.
 * @returns the updated Workspace projection.
 */
@Remote('insertSessionBefore') insertSessionBefore(request: WorkspaceInsertSessionBeforeRequest): Promise<WorkspaceValue>

/**
 * Hide one known Session from Workspace grouping surfaces.
 * @param request - Session identity to archive.
 * @returns the complete resulting archive set.
 */
@Remote('archiveSession') archiveSession(request: WorkspaceArchiveSessionRequest): Promise<WorkspaceArchiveValue>

/**
 * Stream a complete Workspace baseline followed by ordered increments.
 * @param signal - generation cancellation.
 * @returns baseline followed by ordered Workspace increments.
 */
@Remote({ mode: 'stream' }) follow(signal: AbortSignal): AsyncIterable<WorkspaceFollowFrame>
```

Source: [`packages/api/workspace-controller/src/index.ts`](../../packages/api/workspace-controller/src/index.ts)

<a id="ctxworkspaceregistry--workspaceregistry"></a>

### `ctx.workspaceRegistry` — `WorkspaceRegistry`

Durable workspace registry. Startup waits for `sessionPersistence`, builds one canonical-cwd header index, and completes the one-time history bootstrap before the service becomes active. The persistence dependency is mandatory so an unavailable peer can never be mistaken for an empty history and commit the initialized marker.

```ts cordis-catalog
/**
 * Create or reuse a workspace for an existing directory. The path is
 * canonicalized through `fs.realpath`; a nonexistent path rejects with the
 * original error and a non-directory rejects. Repeated calls for the same
 * canonical path return the existing entity without changing its title.
 * A newly created workspace is prepended to the durable registry order.
 * Different canonical paths may share a display title.
 * @param path - Existing directory to own, in any path spelling.
 * @param title - Display title used only when a new record is created.
 * @returns the existing or newly durable workspace.
 */
async create(path: string, title?: string): Promise<Workspace>

/**
 * Resolve canonical ownership and creation status in the same serialized operation.
 * @param path - existing directory.
 * @param title - initial title when a record is created.
 * @returns workspace and whether this operation created it.
 */
async createOrResolve(path: string, title?: string): Promise<{ workspace: Workspace; created: boolean }>

/**
 * Look up a workspace by id.
 * @param id - Workspace id.
 * @returns the workspace, or `undefined` when unknown.
 */
get(id: WorkspaceId): Workspace | undefined

/**
 * Synchronous workspace projection in durable registry order. Every
 * entity's `sessionIds` getter is already filtered by the startup/live
 * canonical-cwd header index; this method performs no persistence reads.
 * @returns a fresh ordered array of workspace entities.
 */
list(): Workspace[]

/**
 * Project the native workspace list without persistence reads.
 * @param signal - request cancellation.
 * @returns durable rows and archive overlay.
 */
@Remote('list') remoteExportList(signal: AbortSignal): WorkspaceRemoteResult<WorkspaceRemoteListValue>

/**
 * Create or resolve a workspace registration through the native API.
 * @param request - existing directory to own.
 * @param signal - cancellation.
 * @returns row and atomic creation flag.
 */
@Remote('create') async remoteExportCreate(request: WorkspaceRemoteCreateRequest, signal: AbortSignal): Promise<WorkspaceRemoteResult<WorkspaceRemoteCreateValue>>

/**
 * Rename a registered workspace through the native API.
 * @param request - workspace and replacement title.
 * @param signal - cancellation.
 * @returns renamed row.
 */
@Remote('rename') remoteExportRename(request: WorkspaceRemoteRenameRequest, signal: AbortSignal): Promise<WorkspaceRemoteResult<WorkspaceRemoteWorkspaceValue>>

/**
 * Remove a workspace registration without deleting files or session logs.
 * @param request - registration to remove.
 * @param signal - cancellation.
 * @returns confirmation; files and logs remain.
 */
@Remote('delete') remoteExportDelete(request: WorkspaceRemoteDeleteRequest, signal: AbortSignal): Promise<WorkspaceRemoteResult<WorkspaceRemoteDeletedValue>>

/**
 * Reorder a workspace through the native API.
 * @param request - workspace and optional anchor.
 * @param signal - cancellation.
 * @returns durable order.
 */
@Remote('insertBefore') remoteExportInsertBefore(request: WorkspaceRemoteInsertBeforeRequest, signal: AbortSignal): Promise<WorkspaceRemoteResult<WorkspaceRemoteOrderValue>>

/**
 * Reorder a session within its workspace account.
 * @param request - workspace, session and optional anchor.
 * @param signal - cancellation.
 * @returns updated account.
 */
@Remote('insertSessionBefore') remoteExportInsertSessionBefore(request: WorkspaceRemoteInsertSessionBeforeRequest, signal: AbortSignal): Promise<WorkspaceRemoteResult<WorkspaceRemoteWorkspaceValue>>

/**
 * Archive a session through the native API while retaining its log.
 * @param request - session to archive.
 * @param signal - cancellation.
 * @returns committed archive overlay.
 */
@Remote('archiveSession') remoteExportArchiveSession(request: WorkspaceRemoteArchiveRequest, signal: AbortSignal): Promise<WorkspaceRemoteResult<WorkspaceRemoteArchivedValue>>

/**
 * Restore an archived session to the visible workspace projection.
 * @param request - archived session to restore.
 * @param signal - cancellation.
 * @returns committed archive overlay.
 */
@Remote('unarchiveSession') remoteExportUnarchiveSession(request: WorkspaceRemoteArchiveRequest, signal: AbortSignal): Promise<WorkspaceRemoteResult<WorkspaceRemoteArchivedValue>>

/**
 * Permanently delete an archived root through its existing lifecycle owners.
 * @param request - archived root to delete.
 * @param signal - cancellation.
 * @returns deletion and archive state.
 */
@Remote('deleteArchivedSession') remoteExportDeleteArchivedSession(request: WorkspaceRemoteDeleteArchivedRequest, signal: AbortSignal): Promise<WorkspaceRemoteResult<WorkspaceRemoteDeleteArchivedValue>>

/**
 * Persist a non-empty, unique workspace title before publishing it.
 * @param id - registered workspace.
 * @param title - visible replacement title.
 * @returns renamed workspace after durability.
 */
rename(id: WorkspaceId, title: string): Promise<Workspace>

/**
 * Delete one workspace registration while retaining its directory and every
 * session log. The durable order is updated before the table deletion; a
 * failed table write restores the prior order and keeps the entity
 * published. Unknown ids are an idempotent no-op for domain callers.
 * @param id - Workspace registration to remove.
 * @returns `true` when a record was deleted, `false` when it was unknown.
 */
delete(id: WorkspaceId): Promise<boolean>

/**
 * Move one workspace within the durable display order, DOM-insertBefore-like.
 * With an anchor it lands before that workspace; without one it appends.
 * @param id - Workspace to move.
 * @param beforeId - Workspace anchor; omitted appends.
 * @returns the complete committed workspace order.
 */
insertBefore(id: WorkspaceId, beforeId?: WorkspaceId): Promise<readonly WorkspaceId[]>

/**
 * Capture the deletion generation before asynchronously loading a session.
 * @param sessionId - identity to observe.
 * @returns its in-process permanent-deletion generation.
 */
sessionAdmissionRevision(sessionId: SessionId): number

/**
 * Reject publication while a session is archived or its deletion raced the load.
 * @param sessionId - identity being published.
 * @param revision - generation captured before asynchronous work.
 */
assertSessionAdmission(sessionId: SessionId, revision: number): void

/**
 * Archive one session durably. The session must exist (live or in session
 * persistence); its workspace accounting — or lack of one — is irrelevant.
 * An already archived id resolves without writing.
 * @param sessionId - The session to archive.
 * @returns resolution after durability.
 */
archiveSession(sessionId: SessionId): Promise<void>

/**
 * Remove a known session from the durable archive overlay.
 * @param sessionId - archived identity to restore.
 * @returns settlement after durable archive removal.
 */
unarchiveSession(sessionId: SessionId): Promise<void>

/**
 * Delete an archived root and retained descendants before committing account and archive removal.
 * @param sessionId - archived root identity.
 * @param retireResident - exact lifecycle owner used to retire resident sessions.
 * @returns settlement after logs, derived cleanup, accounts and archive state commit.
 */
deleteArchivedSession(sessionId: SessionId, retireResident?: (residentSessionId: SessionId) => Promise<void>): Promise<void>

/**
 * Resolve by canonical directory path without creating or mutating a
 * workspace. A missing path rejects during `realpath`; an existing unowned
 * directory returns `undefined`.
 * @param path - Existing directory path in any spelling.
 * @returns the workspace owning the canonical path, when one exists.
 */
async resolveByPath(path: string): Promise<Workspace | undefined>
```

Types: [SessionId](core.zh.md)

Source: [`packages/workspace/workspace/src/index.ts`](../../packages/workspace/workspace/src/index.ts)

<a id="workspace-events"></a>

### `workspace/*` events

<a id="workspacearchived-sessions-changed--emit"></a>

#### `workspace/archived-sessions-changed` — emit

Committed archive overlay after a non-delete mutation.

```ts cordis-catalog
/**
 * Committed archive overlay after a non-delete mutation.
 * @param archivedSessionIds - current archive identities in durable order.
 * @mode emit
 */
'workspace/archived-sessions-changed'(archivedSessionIds: readonly SessionId[]): void
```

Types: [SessionId](core.zh.md)

Source: [`packages/workspace/workspace/src/index.ts`](../../packages/workspace/workspace/src/index.ts)

<a id="workspacesession-deleted--emit"></a>

#### `workspace/session-deleted` — emit

Permanently removed identity after log, account and archive commits.

```ts cordis-catalog
/**
 * Permanently removed identity after log, account and archive commits.
 * @param sessionId - deleted identity.
 * @param archivedSessionIds - remaining archive overlay.
 * @mode emit
 */
'workspace/session-deleted'(sessionId: SessionId, archivedSessionIds: readonly SessionId[]): void
```

Types: [SessionId](core.zh.md)

Source: [`packages/workspace/workspace/src/index.ts`](../../packages/workspace/workspace/src/index.ts)
<!-- END GENERATED cordis-surface -->
