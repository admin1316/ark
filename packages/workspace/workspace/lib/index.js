import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename } from "node:path";
import { Service } from "@deepseek-ai/cordis";
import { SessionPersistenceDeleteBlockedError } from "@deepseek-ai/dsh-session-persistence";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { z } from "zod";
import { SessionId } from "@deepseek-ai/dsh-session";
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
//#region lib/types/paths.js
/**
* Path canonicalization for workspace identity.
* @module @deepseek-ai/dsh-workspace/src/paths
*/
/**
* Canonicalize a directory path via `fs.realpath`: trailing slashes, `..`
* segments, and symlinks are all resolved. This is the ONE uniqueness canon of
* the package — workspace paths are stored canonicalized, uniqueness is
* string equality of canonicalized paths (a symlink to an existing
* workspace's directory collides), and attach-time session `cwd` checks go
* through the same canon. A path that does not exist rejects with the
* original `ENOENT` — this is `create`'s reject path (a workspace must point
* at an existing directory).
* @param path - The path to canonicalize.
* @returns the canonical absolute path.
*/
async function realpathNormalize(path) {
	return await realpath(path);
}
//#endregion
//#region lib/types/entity.js
/**
* Package-private workspace entity: the single {@link Workspace}
* implementation. Holds a record snapshot that is swapped in place after each
* durable mutation; every write funnels through the private `mutate` so
* `updatedAt` stamping and invalid-account pruning happen exactly once.
* Not re-exported from the package entrypoint — consumers see only the
* `Workspace` interface.
* @module @deepseek-ai/dsh-workspace/src/entity
*/
/** An insertSessionBefore request named a session or anchor not on the account (storage failures stay plain errors). */
var WorkspaceMoveInvalidError = class extends Error {
	/**
	* @param message - Which id was unaccounted and where.
	*/
	constructor(message) {
		super(message);
		this.name = "WorkspaceMoveInvalidError";
	}
};
/** Chain-slot abort sentinel thrown by the update fn when the record needs no change; only `mutate` observes it. */
const unchangedSentinel = /* @__PURE__ */ new Error("workspace record unchanged (internal sentinel)");
/** The single {@link Workspace} implementation; constructed only by the registry. */
var WorkspaceEntity = class {
	host;
	id;
	record;
	/**
	* @param host - Registry-owned table, session-path index, and header reads.
	* @param id - The record's stable id.
	* @param record - The validated record snapshot loaded or just written.
	*/
	constructor(host, id, record) {
		this.host = host;
		this.id = id;
		this.record = record;
	}
	get path() {
		return this.record.path;
	}
	get title() {
		return this.record.title;
	}
	get createdAt() {
		return this.record.createdAt;
	}
	get updatedAt() {
		return this.record.updatedAt;
	}
	get sessionIds() {
		return this.record.sessionIds.filter((id) => this.host.sessionPath(id) === this.record.path);
	}
	async setTitle(title) {
		await this.mutate((record) => ({
			...record,
			title
		}));
	}
	async attachSession(sessionId) {
		if (!this.record.sessionIds.includes(sessionId)) {
			const header = await this.host.readSessionHeader(sessionId);
			if (header.cwd === void 0) throw new Error(`cannot attach session '${sessionId}' to workspace '${this.record.path}': its stored header carries no cwd to validate against`);
			let cwd;
			try {
				cwd = await realpathNormalize(header.cwd);
			} catch (error) {
				throw new Error(`cannot attach session '${sessionId}' to workspace '${this.record.path}': its cwd '${header.cwd}' does not resolve, so it cannot be validated`, { cause: error });
			}
			if (!(await stat(cwd)).isDirectory()) throw new Error(`cannot attach session '${sessionId}' to workspace '${this.record.path}': its cwd '${header.cwd}' is not a directory`);
			if (cwd !== this.record.path) throw new Error(`cannot attach session '${sessionId}' to workspace '${this.record.path}': its cwd resolves to '${cwd}'`);
			this.host.rememberSessionPath(sessionId, cwd);
		}
		await this.mutate((record) => record.sessionIds.includes(sessionId) ? record : {
			...record,
			sessionIds: [sessionId, ...record.sessionIds]
		});
	}
	async insertSessionBefore(sessionId, beforeSessionId) {
		await this.mutate((record) => {
			if (!record.sessionIds.includes(sessionId)) throw new WorkspaceMoveInvalidError(`cannot move session '${sessionId}' in workspace '${record.path}': the session is not accounted`);
			if (beforeSessionId !== void 0 && !record.sessionIds.includes(beforeSessionId)) throw new WorkspaceMoveInvalidError(`cannot move session '${sessionId}' before '${beforeSessionId}' in workspace '${record.path}': the anchor session is not accounted`);
			if (beforeSessionId === sessionId) return record;
			const without = record.sessionIds.filter((id) => id !== sessionId);
			const at = beforeSessionId === void 0 ? without.length : without.indexOf(beforeSessionId);
			const sessionIds = [
				...without.slice(0, at),
				sessionId,
				...without.slice(at)
			];
			return sessionIds.every((id, index) => id === record.sessionIds[index]) ? record : {
				...record,
				sessionIds
			};
		});
	}
	async detachSession(sessionId) {
		await this.mutate((record) => record.sessionIds.includes(sessionId) ? {
			...record,
			sessionIds: record.sessionIds.filter((id) => id !== sessionId)
		} : record);
	}
	async status() {
		try {
			return (await stat(this.record.path)).isDirectory() ? "ok" : "missing-dir";
		} catch {
			return "missing-dir";
		}
	}
	/**
	* The single write path: run `fn` on the domain write chain via
	* `table.update`, stamping `updatedAt` and pruning candidates that no
	* longer pass the id-plus-canonical-cwd membership check, then swap the
	* snapshot.
	*
	* `fn` sees the value current at its chain slot, so membership decisions
	* (attach/detach idempotence) are race-free against queued writes; a fn
	* signalling no change by returning `current` verbatim aborts the slot
	* through the sentinel when pruning also finds nothing, so a no-op neither
	* rewrites the medium nor emits a change event.
	*/
	async mutate(fn) {
		let next;
		try {
			next = await this.host.table().update(this.id, (current) => {
				const changed = fn(current);
				const sessionIds = changed.sessionIds.filter((id) => this.host.sessionPath(id) === changed.path);
				if (changed === current && sessionIds.length === current.sessionIds.length) throw unchangedSentinel;
				return {
					...changed,
					sessionIds,
					updatedAt: (/* @__PURE__ */ new Date()).toISOString()
				};
			});
		} catch (error) {
			if (error === unchangedSentinel) return;
			throw error;
		}
		this.record = next;
	}
};
//#endregion
//#region lib/types/spec.js
/**
* The workspace domain declaration: record schema and the `defineDomain` spec
* the registry opens. The zod schema is the durable-boundary validator today
* and the direct source of the RPC wire projection in a later phase.
* @module @deepseek-ai/dsh-workspace/src/spec
*/
/** Workspace id schema at the durable boundary; branding has no runtime representation. */
const workspaceId = z.string().transform((value) => value);
/**
* Durable shape of one workspace record. `path` is the `fs.realpath` canon
* stamped at create; `sessionIds` is the ordered ownership account (array
* order is display order); timestamps are ISO-8601 strings.
*/
const workspaceRecord = z.object({
	path: z.string(),
	title: z.string(),
	sessionIds: z.array(z.string().transform(SessionId)),
	createdAt: z.string(),
	updatedAt: z.string()
});
/**
* Recoverable two-write mutation marker. The marker is persisted before the
* record/order pair can diverge, so startup can distinguish an interrupted
* registry operation from unexplained medium corruption.
*/
const workspacePendingMutation = z.discriminatedUnion("operation", [z.object({
	operation: z.literal("create"),
	workspaceId
}), z.object({
	operation: z.literal("delete"),
	workspaceId
})]);
/**
* Durable registry state. `initialized` distinguishes a valid empty registry
* from one that still needs the header-only history bootstrap;
* `workspaceIds` is the authoritative display order. `archivedSessionIds` is
* the registry-global archive set layered over workspace accounting: an
* archived session keeps its `sessionIds` slot (unarchiving must restore the
* position), so the set never participates in the one-owner accounting
* invariant. Defaulted so records written before the field parse unchanged.
*/
const workspaceDomainState = z.object({
	initialized: z.boolean(),
	workspaceIds: z.array(workspaceId),
	archivedSessionIds: z.array(z.string().transform(SessionId)).default([]),
	pendingMutation: workspacePendingMutation.optional()
});
/**
* The workspace domain spec: one `workspaces` table keyed by
* {@link WorkspaceId} plus the bootstrap/order singleton. The registry opens
* this through `ctx.storage.domain`; the spec object is the single source of
* the domain's identity, version, and schemas.
*/
const workspaceDomainSpec = defineDomain({
	name: "workspace",
	version: 2,
	global: {
		schema: workspaceDomainState,
		initial: {
			initialized: false,
			workspaceIds: [],
			archivedSessionIds: []
		}
	},
	tables: { workspaces: domainTable(workspaceRecord) }
});
//#endregion
//#region lib/types/remote.js
/** Generated Remote wire types owned by the workspace domain. */
/**
* Direct-call cancellation result; the Remote carrier independently preserves cancellation too.
* @returns The value produced by workspace remote cancelled.
*/
function workspaceRemoteCancelled() {
	return {
		ok: false,
		error: {
			code: "cancelled",
			message: "workspace Remote invocation was cancelled",
			details: {}
		}
	};
}
//#endregion
//#region lib/types/index.js
/**
* Workspace entity registry (`ctx.workspaceRegistry`): durable workspace records,
* stable registry order, and header-validated session membership over the
* domain data form.
* @module @deepseek-ai/dsh-workspace
*/
var __runInitializers = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
var __esDecorate = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) if (kind === "field") initializers.unshift(_);
		else descriptor[key] = _;
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
/**
* Brand a string as a {@link WorkspaceId}.
* @param id - Raw workspace id string.
* @returns the same string, branded at compile time.
*/
function WorkspaceId(id) {
	return id;
}
/** Read cancellation after an awaited operation without carrying stale flow narrowing across the yield. */
function workspaceCancelledAfterAwait(signal) {
	return signal.aborted ? workspaceRemoteCancelled() : void 0;
}
/**
* An archiveSession request named a session neither live nor in session
* persistence — a definite miss only; storage faults propagate as themselves.
*/
var WorkspaceUnknownSessionError = class extends Error {
	sessionId;
	/**
	* @param sessionId - The unknown session id.
	*/
	constructor(sessionId) {
		super(`cannot archive session '${sessionId}': live sessions and session persistence hold no such session`);
		this.sessionId = sessionId;
		this.name = "WorkspaceUnknownSessionError";
	}
};
/** Permanent deletion requires an archived root and a cold, unreserved subtree. */
var WorkspaceSessionDeletionBlockedError = class extends Error {
	sessionId;
	reason;
	constructor(sessionId, reason) {
		const message = reason === "not-archived" ? `cannot permanently delete session '${sessionId}': it is not archived` : reason === "resident" ? `cannot permanently delete session '${sessionId}' while it is live or resident` : `cannot permanently delete session '${sessionId}' while resume holds a reservation`;
		super(message);
		this.sessionId = sessionId;
		this.reason = reason;
		this.name = "WorkspaceSessionDeletionBlockedError";
	}
};
/** A workspace reorder named a source or anchor absent from the durable registry order. */
var WorkspaceOrderInvalidError = class extends Error {
	workspaceId;
	/**
	* @param workspaceId - Missing source or anchor id.
	*/
	constructor(workspaceId) {
		super(`cannot reorder unknown workspace '${workspaceId}'`);
		this.workspaceId = workspaceId;
		this.name = "WorkspaceOrderInvalidError";
	}
};
/** A rename request would collide with another Workspace's display title. */
var WorkspaceNameConflictError = class extends Error {
	workspaceName;
	constructor(workspaceName) {
		super(`workspace display name ${JSON.stringify(workspaceName)} already exists`);
		this.workspaceName = workspaceName;
		this.name = "WorkspaceNameConflictError";
	}
};
/** A Remote rename supplied an empty title after normalization. */
var WorkspaceTitleInvalidError = class extends Error {
	constructor() {
		super("workspace title must be non-empty");
		this.name = "WorkspaceTitleInvalidError";
	}
};
const sameIds = (left, right) => left.length === right.length && left.every((id, index) => id === right[index]);
const compareHeaders = (left, right) => right.createdAt - left.createdAt || String(left.id).localeCompare(String(right.id));
/** Project one durable Workspace entity without leaking its mutable implementation object. */
function workspaceRemoteView(workspace) {
	return {
		workspaceId: workspace.id,
		path: workspace.path,
		title: workspace.title,
		sessionIds: [...workspace.sessionIds],
		createdAt: workspace.createdAt,
		updatedAt: workspace.updatedAt
	};
}
/** Build one stable Remote business failure. */
function workspaceRemoteError(code, error, details) {
	return {
		ok: false,
		error: {
			code,
			message: error instanceof Error ? error.message : String(error),
			details
		}
	};
}
/** Map only domain rejections; storage and other infrastructure faults remain loud. */
function workspaceRemoteFailure(error) {
	if (error instanceof WorkspaceOrderInvalidError) return workspaceRemoteError("workspace-not-found", error, { workspaceId: String(error.workspaceId) });
	if (error instanceof WorkspaceNameConflictError) return workspaceRemoteError("workspace-name-conflict", error, { name: error.workspaceName });
	if (error instanceof WorkspaceTitleInvalidError) return workspaceRemoteError("arguments-invalid", error, {});
	if (error instanceof WorkspaceMoveInvalidError) return workspaceRemoteError("workspace-move-invalid", error, {});
	if (error instanceof WorkspaceUnknownSessionError) return workspaceRemoteError("session-not-found", error, { sessionId: String(error.sessionId) });
	if (error instanceof WorkspaceSessionDeletionBlockedError) return workspaceRemoteError("session-delete-blocked", error, {
		sessionId: String(error.sessionId),
		reason: error.reason
	});
}
/** Return one retained lineage in deterministic descendant-first order. */
function sessionDeletionPostOrder(rootSessionId, headers) {
	const byId = /* @__PURE__ */ new Map();
	for (const header of headers) {
		const prior = byId.get(header.id);
		if (prior !== void 0 && prior.parentSession !== header.parentSession) throw new Error(`cannot permanently delete session '${rootSessionId}': session '${header.id}' has conflicting parent metadata`);
		byId.set(header.id, header);
	}
	const children = /* @__PURE__ */ new Map();
	for (const header of byId.values()) {
		if (header.parentSession === void 0) continue;
		const siblings = children.get(header.parentSession);
		if (siblings === void 0) children.set(header.parentSession, [header.id]);
		else siblings.push(header.id);
	}
	for (const siblings of children.values()) siblings.sort((a, b) => String(a).localeCompare(String(b)));
	const visiting = /* @__PURE__ */ new Set();
	const path = [];
	const postOrder = [];
	const visit = (sessionId) => {
		if (visiting.has(sessionId)) {
			const start = path.indexOf(sessionId);
			throw new Error(`cannot permanently delete session '${rootSessionId}': retained lineage cycle ${[...path.slice(start), sessionId].join(" -> ")}`);
		}
		visiting.add(sessionId);
		path.push(sessionId);
		for (const child of children.get(sessionId) ?? []) visit(child);
		path.pop();
		visiting.delete(sessionId);
		postOrder.push(sessionId);
	};
	visit(rootSessionId);
	return postOrder;
}
/**
* Durable workspace registry. Startup waits for `sessionPersistence`, builds
* one canonical-cwd header index, and completes the one-time history
* bootstrap before the service becomes active. The persistence dependency is
* mandatory so an unavailable peer can never be mistaken for an empty
* history and commit the initialized marker.
*/
let WorkspaceRegistry = (() => {
	let _classSuper = TypertRemoteService;
	let _instanceExtraInitializers = [];
	let _remoteExportList_decorators;
	let _remoteExportCreate_decorators;
	let _remoteExportRename_decorators;
	let _remoteExportDelete_decorators;
	let _remoteExportInsertBefore_decorators;
	let _remoteExportInsertSessionBefore_decorators;
	let _remoteExportArchiveSession_decorators;
	let _remoteExportUnarchiveSession_decorators;
	let _remoteExportDeleteArchivedSession_decorators;
	return class WorkspaceRegistry extends _classSuper {
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_remoteExportList_decorators = [Remote("list")];
			_remoteExportCreate_decorators = [Remote("create")];
			_remoteExportRename_decorators = [Remote("rename")];
			_remoteExportDelete_decorators = [Remote("delete")];
			_remoteExportInsertBefore_decorators = [Remote("insertBefore")];
			_remoteExportInsertSessionBefore_decorators = [Remote("insertSessionBefore")];
			_remoteExportArchiveSession_decorators = [Remote("archiveSession")];
			_remoteExportUnarchiveSession_decorators = [Remote("unarchiveSession")];
			_remoteExportDeleteArchivedSession_decorators = [Remote("deleteArchivedSession")];
			__esDecorate(this, null, _remoteExportList_decorators, {
				kind: "method",
				name: "remoteExportList",
				static: false,
				private: false,
				access: {
					has: (obj) => "remoteExportList" in obj,
					get: (obj) => obj.remoteExportList
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _remoteExportCreate_decorators, {
				kind: "method",
				name: "remoteExportCreate",
				static: false,
				private: false,
				access: {
					has: (obj) => "remoteExportCreate" in obj,
					get: (obj) => obj.remoteExportCreate
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _remoteExportRename_decorators, {
				kind: "method",
				name: "remoteExportRename",
				static: false,
				private: false,
				access: {
					has: (obj) => "remoteExportRename" in obj,
					get: (obj) => obj.remoteExportRename
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _remoteExportDelete_decorators, {
				kind: "method",
				name: "remoteExportDelete",
				static: false,
				private: false,
				access: {
					has: (obj) => "remoteExportDelete" in obj,
					get: (obj) => obj.remoteExportDelete
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _remoteExportInsertBefore_decorators, {
				kind: "method",
				name: "remoteExportInsertBefore",
				static: false,
				private: false,
				access: {
					has: (obj) => "remoteExportInsertBefore" in obj,
					get: (obj) => obj.remoteExportInsertBefore
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _remoteExportInsertSessionBefore_decorators, {
				kind: "method",
				name: "remoteExportInsertSessionBefore",
				static: false,
				private: false,
				access: {
					has: (obj) => "remoteExportInsertSessionBefore" in obj,
					get: (obj) => obj.remoteExportInsertSessionBefore
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _remoteExportArchiveSession_decorators, {
				kind: "method",
				name: "remoteExportArchiveSession",
				static: false,
				private: false,
				access: {
					has: (obj) => "remoteExportArchiveSession" in obj,
					get: (obj) => obj.remoteExportArchiveSession
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _remoteExportUnarchiveSession_decorators, {
				kind: "method",
				name: "remoteExportUnarchiveSession",
				static: false,
				private: false,
				access: {
					has: (obj) => "remoteExportUnarchiveSession" in obj,
					get: (obj) => obj.remoteExportUnarchiveSession
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _remoteExportDeleteArchivedSession_decorators, {
				kind: "method",
				name: "remoteExportDeleteArchivedSession",
				static: false,
				private: false,
				access: {
					has: (obj) => "remoteExportDeleteArchivedSession" in obj,
					get: (obj) => obj.remoteExportDeleteArchivedSession
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			if (_metadata) Object.defineProperty(this, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		static inject = ["storageDomain", "sessionPersistence"];
		table = __runInitializers(this, _instanceExtraInitializers);
		global;
		state;
		entities = /* @__PURE__ */ new Map();
		headers = /* @__PURE__ */ new Map();
		sessionPaths = /* @__PURE__ */ new Map();
		invalidSessionPaths = /* @__PURE__ */ new Map();
		sessionDeletionEpoch = /* @__PURE__ */ new Map();
		deletingSessions = /* @__PURE__ */ new Set();
		operationTail = Promise.resolve();
		host = {
			table: () => this.requireTable(),
			sessionPath: (id) => this.sessionPaths.get(id),
			readSessionHeader: (id) => this.readSessionHeader(id),
			rememberSessionPath: (id, path) => {
				this.sessionPaths.set(id, path);
				this.invalidSessionPaths.delete(id);
			}
		};
		constructor(ctx) {
			super(ctx, "workspaceRegistry", { namespace: "workspace" });
		}
		/** Open the domain, finish bootstrap when required, and rebuild the ordered cache. */
		async [Service.init]() {
			const domain = await this.ctx.storageDomain.open(workspaceDomainSpec);
			this.ctx.effect(() => () => domain.close(), "workspace.domainClose");
			this.table = domain.table("workspaces");
			this.global = domain.global;
			this.state = domain.global.get();
			await this.recoverPendingMutation();
			this.validateStoredState(this.state);
			if (!this.state.initialized) {
				const headers = await this.ctx.sessionPersistence.list();
				await this.replaceHeaderIndex(headers);
				await this.bootstrap(headers);
			} else if (this.table.size > 0) await this.replaceHeaderIndex(await this.ctx.sessionPersistence.list());
			await this.indexLiveSessions();
			this.validateStoredState(this.requireState());
			this.rebuildEntities();
			await this.reconcileStaleArchivedSessions();
			this.reportFilteredCandidates();
		}
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
		async create(path, title) {
			return (await this.createOrResolve(path, title)).workspace;
		}
		/**
		* Create one Workspace or resolve the existing canonical path in the same
		* registry serialization slot.  The `created` bit is therefore not guessed
		* from a stale preflight lookup.
		* @param path - Existing directory to own, in any path spelling.
		* @param title - Display title used only when a new record is created.
		* @returns the workspace and whether a new record was created.
		*/
		async createOrResolve(path, title) {
			const canonical = await realpathNormalize(path);
			if (!(await stat(canonical)).isDirectory()) throw new Error(`cannot create a workspace at '${canonical}': path is not a directory`);
			return await this.enqueueOperation(async () => {
				for (const entity of this.entities.values()) if (entity.path === canonical) return {
					workspace: entity,
					created: false
				};
				return {
					workspace: await this.createCanonical(canonical, title),
					created: true
				};
			});
		}
		/**
		* Look up a workspace by id.
		* @param id - Workspace id.
		* @returns the workspace, or `undefined` when unknown.
		*/
		get(id) {
			return this.entities.get(id);
		}
		/**
		* Synchronous workspace projection in durable registry order. Every
		* entity's `sessionIds` getter is already filtered by the startup/live
		* canonical-cwd header index; this method performs no persistence reads.
		* @returns a fresh ordered array of workspace entities.
		*/
		list() {
			return this.requireState().workspaceIds.map((id) => {
				const entity = this.entities.get(id);
				if (entity === void 0) throw new Error(`workspace registry order references missing workspace '${id}'`);
				return entity;
			});
		}
		/**
		* List durable Workspaces and the archive overlay through the generated Remote boundary.
		* @param signal - caller-owned cancellation signal.
		* @returns the workspace list and archived-session overlay.
		*/
		remoteExportList(signal) {
			if (signal.aborted) return workspaceRemoteCancelled();
			return {
				ok: true,
				value: {
					items: this.list().map(workspaceRemoteView),
					archivedSessionIds: [...this.archivedSessionIds]
				}
			};
		}
		/**
		* Create or resolve one canonical existing directory through the generated Remote boundary.
		* @param request - directory path to create or resolve.
		* @param signal - caller-owned cancellation signal.
		* @returns the workspace result and creation flag.
		*/
		async remoteExportCreate(request, signal) {
			if (signal.aborted) return workspaceRemoteCancelled();
			try {
				const created = await this.createOrResolve(request.path);
				const cancellation = workspaceCancelledAfterAwait(signal);
				if (cancellation !== void 0) return cancellation;
				return {
					ok: true,
					value: {
						workspace: workspaceRemoteView(created.workspace),
						created: created.created
					}
				};
			} catch (error) {
				const cancellation = workspaceCancelledAfterAwait(signal);
				if (cancellation !== void 0) return cancellation;
				return workspaceRemoteError("workspace-invalid-path", error, { path: request.path });
			}
		}
		/**
		* Rename one Workspace without exposing the registry's write chain to transport code.
		* @param request - workspace id and replacement title.
		* @param signal - caller-owned cancellation signal.
		* @returns the renamed workspace result.
		*/
		async remoteExportRename(request, signal) {
			return this.remoteOperation(signal, async () => ({ workspace: workspaceRemoteView(await this.rename(request.workspaceId, request.title)) }));
		}
		/**
		* Remove only a Workspace registration; neither files nor session logs are touched.
		* @param request - workspace id to remove.
		* @param signal - caller-owned cancellation signal.
		* @returns confirmation of the registration removal.
		*/
		async remoteExportDelete(request, signal) {
			return this.remoteOperation(signal, async () => {
				if (!await this.delete(request.workspaceId)) throw new WorkspaceOrderInvalidError(request.workspaceId);
				return { deleted: true };
			});
		}
		/**
		* Reorder Workspace rows using DOM-insertBefore semantics.
		* @param request - workspace and optional anchor ids.
		* @param signal - caller-owned cancellation signal.
		* @returns the resulting workspace order.
		*/
		async remoteExportInsertBefore(request, signal) {
			return this.remoteOperation(signal, async () => ({ workspaceIds: [...await this.insertBefore(request.workspaceId, request.beforeWorkspaceId)] }));
		}
		/**
		* Reorder an accounted Session inside one Workspace.
		* @param request - workspace, session, and optional anchor ids.
		* @param signal - caller-owned cancellation signal.
		* @returns the updated workspace result.
		*/
		async remoteExportInsertSessionBefore(request, signal) {
			return this.remoteOperation(signal, async () => {
				const workspace = this.get(request.workspaceId);
				if (workspace === void 0) throw new WorkspaceOrderInvalidError(request.workspaceId);
				await workspace.insertSessionBefore(request.sessionId, request.beforeSessionId);
				return { workspace: workspaceRemoteView(workspace) };
			});
		}
		/**
		* Archive one Session without changing its Workspace account or log.
		* @param request - session id to archive.
		* @param signal - caller-owned cancellation signal.
		* @returns the archived-session ids after the operation.
		*/
		async remoteExportArchiveSession(request, signal) {
			return this.remoteOperation(signal, async () => {
				await this.archiveSession(request.sessionId);
				return { archivedSessionIds: [...this.archivedSessionIds] };
			});
		}
		/**
		* Restore one archived Session without changing its retained Workspace position.
		* @param request - archived session id to restore.
		* @param signal - caller-owned cancellation signal.
		* @returns the archived-session ids after the operation.
		*/
		async remoteExportUnarchiveSession(request, signal) {
			return this.remoteOperation(signal, async () => {
				await this.unarchiveSession(request.sessionId);
				return { archivedSessionIds: [...this.archivedSessionIds] };
			});
		}
		/**
		* Permanently delete an archived Session only through the exact lifecycle-retirement capability.
		* @param request - archived session id to delete.
		* @param signal - caller-owned cancellation signal.
		* @returns deletion confirmation and remaining archived-session ids.
		*/
		async remoteExportDeleteArchivedSession(request, signal) {
			return this.remoteOperation(signal, async () => {
				const retirer = this.ctx.get("workspaceSessionRetirer");
				await this.deleteArchivedSession(request.sessionId, retirer === void 0 ? void 0 : (id) => retirer.retireArchivedSession(id, signal));
				return {
					deleted: true,
					archivedSessionIds: [...this.archivedSessionIds]
				};
			});
		}
		/**
		* Delete one workspace registration while retaining its directory and every
		* session log. The durable order is updated before the table deletion; a
		* failed table write restores the prior order and keeps the entity
		* published. Unknown ids are an idempotent no-op for domain callers.
		* @param id - Workspace registration to remove.
		* @returns `true` when a record was deleted, `false` when it was unknown.
		*/
		delete(id) {
			return this.enqueueOperation(() => this.deleteKnown(id));
		}
		/**
		* Rename one Workspace through the same serialization chain as all registry writes.
		* @param id - Workspace registration to rename.
		* @param title - replacement display title.
		* @returns the renamed workspace.
		*/
		rename(id, title) {
			const normalized = title.trim();
			if (normalized.length === 0) throw new WorkspaceTitleInvalidError();
			return this.enqueueOperation(async () => {
				const workspace = this.entities.get(id);
				if (workspace === void 0) throw new WorkspaceOrderInvalidError(id);
				if (workspace.title === normalized) return workspace;
				if (this.list().some((other) => other.id !== id && other.title === normalized)) throw new WorkspaceNameConflictError(normalized);
				await workspace.setTitle(normalized);
				return workspace;
			});
		}
		/**
		* Move one workspace within the durable display order, DOM-insertBefore-like.
		* With an anchor it lands before that workspace; without one it appends.
		* @param id - Workspace to move.
		* @param beforeId - Workspace anchor; omitted appends.
		* @returns the complete committed workspace order.
		*/
		insertBefore(id, beforeId) {
			return this.enqueueOperation(async () => {
				const state = this.requireState();
				if (!state.workspaceIds.includes(id)) throw new WorkspaceOrderInvalidError(id);
				if (beforeId !== void 0 && !state.workspaceIds.includes(beforeId)) throw new WorkspaceOrderInvalidError(beforeId);
				if (beforeId === id) return state.workspaceIds;
				const without = state.workspaceIds.filter((workspaceId) => workspaceId !== id);
				const at = beforeId === void 0 ? without.length : without.indexOf(beforeId);
				const workspaceIds = [
					...without.slice(0, at),
					id,
					...without.slice(at)
				];
				if (sameIds(workspaceIds, state.workspaceIds)) return state.workspaceIds;
				await this.setState({
					...state,
					workspaceIds
				});
				return workspaceIds;
			});
		}
		/**
		* The registry-global archive set: sessions hidden from every grouping
		* surface. Archiving never touches workspace accounting — an archived
		* session keeps its `sessionIds` slot so unarchiving restores its position.
		* @returns the archived session ids in archive order.
		*/
		get archivedSessionIds() {
			return this.requireState().archivedSessionIds;
		}
		/**
		* Capture the in-process permanent-deletion generation for publication fencing.
		* @param sessionId - Session identity whose deletion generation is read.
		* @returns Current admission generation for the session.
		*/
		sessionAdmissionRevision(sessionId) {
			return this.sessionDeletionEpoch.get(sessionId) ?? 0;
		}
		/**
		* Revalidate a publication against archive membership and deletion races.
		* @param sessionId - Session identity being published.
		* @param revision - Admission generation captured before the asynchronous work.
		*/
		assertSessionAdmission(sessionId, revision) {
			if (this.requireState().archivedSessionIds.includes(sessionId)) throw new Error(`cannot publish session '${sessionId}' while it is archived`);
			if (this.deletingSessions.has(sessionId) || (this.sessionDeletionEpoch.get(sessionId) ?? 0) !== revision) throw new Error(`cannot publish session '${sessionId}': permanent deletion raced this lifecycle`);
		}
		/**
		* Archive one session durably. The session must exist (live or in session
		* persistence); its workspace accounting — or lack of one — is irrelevant.
		* An already archived id resolves without writing.
		* @param sessionId - The session to archive.
		* @returns resolution after durability.
		*/
		archiveSession(sessionId) {
			return this.enqueueOperation(async () => {
				if (this.requireState().archivedSessionIds.includes(sessionId)) return;
				if (!await this.sessionKnown(sessionId)) throw new WorkspaceUnknownSessionError(sessionId);
				const state = this.requireState();
				const archivedSessionIds = [...state.archivedSessionIds, sessionId];
				await this.setState({
					...state,
					archivedSessionIds
				});
				this.ctx.emit("workspace/archived-sessions-changed", archivedSessionIds);
			});
		}
		/**
		* Remove an existing session from the archive set without touching its log/account slot.
		* @param sessionId - Archived session identity to restore.
		* @returns Resolution after the archive mutation is durable.
		*/
		unarchiveSession(sessionId) {
			return this.enqueueOperation(async () => {
				const state = this.requireState();
				if (!state.archivedSessionIds.includes(sessionId)) return;
				const live = this.ctx.get("sessions")?.get(sessionId);
				const persisted = (await this.ctx.sessionPersistence.list()).some((header) => header.id === sessionId);
				if (live === void 0 && !persisted) throw new WorkspaceUnknownSessionError(sessionId);
				const archivedSessionIds = state.archivedSessionIds.filter((id) => id !== sessionId);
				await this.setState({
					...state,
					archivedSessionIds
				});
				this.ctx.emit("workspace/archived-sessions-changed", archivedSessionIds);
			});
		}
		/**
		* Permanently delete one archived session and every retained descendant.
		* Logs commit descendant-first before workspace accounts and archive state;
		* a later failure leaves the root archive marker available for retry.
		* @param sessionId - Archived root session identity to delete.
		* @param retireResident - Callback that retires a live/resident session before log deletion.
		* @returns Resolution after all retained records and archive state are durable.
		*/
		deleteArchivedSession(sessionId, retireResident) {
			return this.enqueueOperation(async () => {
				if (!this.requireState().archivedSessionIds.includes(sessionId)) throw new WorkspaceSessionDeletionBlockedError(sessionId, "not-archived");
				const fenced = /* @__PURE__ */ new Set();
				const observedHeaders = [];
				const fence = (candidateId) => {
					this.sessionDeletionEpoch.set(candidateId, (this.sessionDeletionEpoch.get(candidateId) ?? 0) + 1);
					this.deletingSessions.add(candidateId);
					fenced.add(candidateId);
				};
				fence(sessionId);
				try {
					let deletionOrder;
					for (;;) {
						const persisted = await this.ctx.sessionPersistence.list();
						const live = this.ctx.get("sessions")?.list().map((session) => session.header) ?? [];
						observedHeaders.push(...persisted, ...live);
						deletionOrder = sessionDeletionPostOrder(sessionId, observedHeaders);
						const newlyFenced = deletionOrder.filter((id) => !fenced.has(id));
						for (const id of newlyFenced) fence(id);
						if (newlyFenced.length === 0) break;
					}
					for (const id of deletionOrder) {
						if (this.ctx.get("sessions")?.get(id) === void 0) continue;
						if (retireResident === void 0) throw new WorkspaceSessionDeletionBlockedError(id, "resident");
						await retireResident(id);
						if (this.ctx.get("sessions")?.get(id) !== void 0) throw new WorkspaceSessionDeletionBlockedError(id, "resident");
					}
					for (const id of deletionOrder) try {
						await this.ctx.sessionPersistence.delete(id);
					} catch (error) {
						if (!(error instanceof SessionPersistenceDeleteBlockedError)) throw error;
						throw new WorkspaceSessionDeletionBlockedError(id, error.reason === "live" ? "resident" : "reserved");
					}
					for (const workspace of this.entities.values()) for (const id of deletionOrder) await workspace.detachSession(id);
					const deleted = new Set(deletionOrder);
					const committed = this.requireState();
					const archivedSessionIds = committed.archivedSessionIds.filter((id) => !deleted.has(id));
					await this.setState({
						...committed,
						archivedSessionIds
					});
					for (const id of deletionOrder) {
						this.headers.delete(id);
						this.sessionPaths.delete(id);
						this.invalidSessionPaths.delete(id);
					}
					for (const id of deletionOrder) this.ctx.emit("workspace/session-deleted", id, archivedSessionIds);
				} finally {
					for (const id of fenced) this.deletingSessions.delete(id);
				}
			});
		}
		/** Finish a crash-left delete whose authoritative log disappeared first. */
		async reconcileStaleArchivedSessions() {
			if (this.requireState().archivedSessionIds.length === 0) return;
			const retained = new Set((await this.ctx.sessionPersistence.list()).map((header) => header.id));
			for (const session of this.ctx.get("sessions")?.list() ?? []) retained.add(session.id);
			for (const id of [...this.requireState().archivedSessionIds]) if (!retained.has(id)) await this.deleteArchivedSession(id);
		}
		/**
		* Whether a session is live, header-indexed, or present in a fresh
		* persistence listing. Only a definite miss returns false — a failing
		* `sessionPersistence.list()` propagates so storage faults never
		* masquerade as an unknown session.
		*/
		async sessionKnown(id) {
			if (this.ctx.get("sessions")?.get(id) !== void 0) return true;
			if (this.headers.has(id)) return true;
			await this.indexHeaders(await this.ctx.sessionPersistence.list());
			return this.headers.has(id);
		}
		/**
		* Resolve by canonical directory path without creating or mutating a
		* workspace. A missing path rejects during `realpath`; an existing unowned
		* directory returns `undefined`.
		* @param path - Existing directory path in any spelling.
		* @returns the workspace owning the canonical path, when one exists.
		*/
		async resolveByPath(path) {
			const canonical = await realpathNormalize(path);
			for (const entity of this.entities.values()) if (entity.path === canonical) return entity;
		}
		/** Run one Remote mutation with cancellation and known business failures kept explicit. */
		async remoteOperation(signal, operation) {
			if (signal.aborted) return workspaceRemoteCancelled();
			try {
				const value = await operation();
				const cancellation = workspaceCancelledAfterAwait(signal);
				if (cancellation !== void 0) return cancellation;
				return {
					ok: true,
					value
				};
			} catch (error) {
				const cancellation = workspaceCancelledAfterAwait(signal);
				if (cancellation !== void 0) return cancellation;
				const failure = workspaceRemoteFailure(error);
				if (failure !== void 0) return failure;
				throw error;
			}
		}
		async createCanonical(canonical, title) {
			for (const entity of this.entities.values()) if (entity.path === canonical) return entity;
			const workspaceName = title ?? basename(canonical);
			const table = this.requireTable();
			const state = this.requireState();
			const id = WorkspaceId(randomUUID());
			const now = (/* @__PURE__ */ new Date()).toISOString();
			const record = {
				path: canonical,
				title: workspaceName,
				sessionIds: [],
				createdAt: now,
				updatedAt: now
			};
			const entity = new WorkspaceEntity(this.host, id, record);
			this.entities.set(id, entity);
			const pendingState = {
				...state,
				pendingMutation: {
					operation: "create",
					workspaceId: id
				}
			};
			try {
				await this.setState(pendingState);
			} catch (error) {
				this.entities.delete(id);
				throw error;
			}
			try {
				await table.put(id, record);
			} catch (error) {
				this.entities.delete(id);
				try {
					await this.setState(state);
				} catch (rollbackError) {
					throw new AggregateError([error, rollbackError], `workspace '${id}' record write and pending-marker rollback both failed`);
				}
				throw error;
			}
			try {
				await this.setState({
					initialized: true,
					workspaceIds: [id, ...state.workspaceIds],
					archivedSessionIds: state.archivedSessionIds
				});
			} catch (error) {
				this.entities.delete(id);
				try {
					await table.delete(id);
				} catch (rollbackError) {
					throw new AggregateError([error, rollbackError], `workspace '${id}' order write and record rollback both failed; the pending marker remains recoverable`);
				}
				try {
					await this.setState(state);
				} catch (rollbackError) {
					throw new AggregateError([error, rollbackError], `workspace '${id}' order write and pending-marker rollback both failed`);
				}
				throw error;
			}
			return entity;
		}
		async deleteKnown(id) {
			const entity = this.entities.get(id);
			if (entity === void 0) return false;
			const state = this.requireState();
			const nextState = {
				initialized: true,
				workspaceIds: state.workspaceIds.filter((workspaceId) => workspaceId !== id),
				archivedSessionIds: state.archivedSessionIds
			};
			await this.setState({
				...nextState,
				pendingMutation: {
					operation: "delete",
					workspaceId: id
				}
			});
			this.entities.delete(id);
			try {
				await this.requireTable().delete(id);
			} catch (error) {
				this.entities.set(id, entity);
				try {
					await this.setState(state);
				} catch (rollbackError) {
					this.entities.delete(id);
					throw new AggregateError([error, rollbackError], `workspace '${id}' record deletion and registry-order rollback both failed`);
				}
				throw error;
			}
			try {
				await this.setState(nextState);
			} catch (error) {
				this.ctx.logger.warn(`workspace '${id}' was deleted but its pending marker could not be cleared: ${String(error)}`);
			}
			return true;
		}
		/**
		* Complete the one mutation explicitly named by durable state. Unexplained
		* order/table divergence still reaches {@link validateStoredState} and
		* fails loud; this path never guesses which operation created a row from its shape alone.
		*/
		async recoverPendingMutation() {
			const state = this.requireState();
			const pending = state.pendingMutation;
			if (pending === void 0) return;
			if (state.workspaceIds.includes(pending.workspaceId)) throw new Error(`workspace domain is inconsistent: pending ${pending.operation} workspace '${pending.workspaceId}' is still present in registry order`);
			await this.requireTable().delete(pending.workspaceId);
			await this.setState({
				initialized: state.initialized,
				workspaceIds: state.workspaceIds,
				archivedSessionIds: state.archivedSessionIds
			});
		}
		async bootstrap(headers) {
			const table = this.requireTable();
			const state = this.requireState();
			const groupsByPath = /* @__PURE__ */ new Map();
			for (const header of headers) {
				const path = this.sessionPaths.get(header.id);
				if (path === void 0) continue;
				const group = groupsByPath.get(path);
				if (group === void 0) groupsByPath.set(path, [header]);
				else group.push(header);
			}
			const groups = [...groupsByPath].map(([path, groupHeaders]) => {
				groupHeaders.sort(compareHeaders);
				return {
					path,
					headers: groupHeaders,
					newestAt: groupHeaders[0].createdAt
				};
			}).sort((left, right) => right.newestAt - left.newestAt || left.path.localeCompare(right.path));
			const byPath = /* @__PURE__ */ new Map();
			const accounted = /* @__PURE__ */ new Map();
			for (const [id, record] of table.entries()) {
				byPath.set(record.path, id);
				for (const sessionId of record.sessionIds) accounted.set(sessionId, id);
			}
			for (const group of groups) {
				let id = byPath.get(group.path);
				if (id === void 0) {
					const sessionIds = group.headers.map((header) => header.id).filter((sessionId) => !accounted.has(sessionId));
					if (sessionIds.length === 0) continue;
					id = WorkspaceId(randomUUID());
					const createdAt = new Date(group.newestAt).toISOString();
					const record = {
						path: group.path,
						title: basename(group.path),
						sessionIds,
						createdAt,
						updatedAt: createdAt
					};
					await table.put(id, record);
					byPath.set(group.path, id);
					for (const sessionId of sessionIds) accounted.set(sessionId, id);
					continue;
				}
				const current = table.get(id);
				const historical = group.headers.map((header) => header.id).filter((sessionId) => accounted.get(sessionId) === void 0 || accounted.get(sessionId) === id);
				const historicalSet = new Set(historical);
				const sessionIds = [...historical, ...current.sessionIds.filter((sessionId) => !historicalSet.has(sessionId))];
				if (sameSessionIds(current.sessionIds, sessionIds)) continue;
				await table.update(id, (record) => ({
					...record,
					sessionIds,
					updatedAt: (/* @__PURE__ */ new Date()).toISOString()
				}));
				for (const sessionId of historical) accounted.set(sessionId, id);
			}
			const groupRank = new Map(groups.map((group) => [group.path, group.newestAt]));
			const priorRank = new Map(state.workspaceIds.map((id, index) => [id, index]));
			const workspaceIds = [...table.entries()].sort(([leftId, left], [rightId, right]) => {
				const leftTime = groupRank.get(left.path) ?? Date.parse(left.createdAt);
				return (groupRank.get(right.path) ?? Date.parse(right.createdAt)) - leftTime || (priorRank.get(leftId) ?? Number.MAX_SAFE_INTEGER) - (priorRank.get(rightId) ?? Number.MAX_SAFE_INTEGER) || String(leftId).localeCompare(String(rightId));
			}).map(([id]) => id);
			if (!sameIds(state.workspaceIds, workspaceIds)) await this.setState({
				initialized: false,
				workspaceIds,
				archivedSessionIds: state.archivedSessionIds
			});
			await this.setState({
				initialized: true,
				workspaceIds,
				archivedSessionIds: state.archivedSessionIds
			});
		}
		validateStoredState(state) {
			const table = this.requireTable();
			const order = /* @__PURE__ */ new Set();
			for (const id of state.workspaceIds) {
				if (order.has(id)) throw new Error(`workspace domain is inconsistent: registry order repeats workspace '${id}'`);
				if (table.get(id) === void 0) throw new Error(`workspace domain is inconsistent: registry order references missing workspace '${id}'`);
				order.add(id);
			}
			if (state.initialized && order.size !== table.size) {
				const orphan = [...table.keys()].find((id) => !order.has(id));
				throw new Error(`workspace domain is inconsistent: workspace '${orphan}' is absent from registry order`);
			}
			const paths = /* @__PURE__ */ new Map();
			const accounted = /* @__PURE__ */ new Map();
			for (const [id, record] of table.entries()) {
				const pathHolder = paths.get(record.path);
				if (pathHolder !== void 0) throw new Error(`workspace domain is inconsistent: path '${record.path}' is claimed by both workspace '${pathHolder}' and workspace '${id}'`);
				paths.set(record.path, id);
				for (const sessionId of record.sessionIds) {
					const holder = accounted.get(sessionId);
					if (holder !== void 0) throw new Error(`workspace domain is inconsistent: session '${sessionId}' is accounted by both workspace '${holder}' and workspace '${id}'`);
					accounted.set(sessionId, id);
				}
			}
		}
		rebuildEntities() {
			this.entities.clear();
			for (const id of this.requireState().workspaceIds) {
				const record = this.requireTable().get(id);
				this.entities.set(id, new WorkspaceEntity(this.host, id, record));
			}
		}
		async replaceHeaderIndex(headers) {
			this.headers.clear();
			this.sessionPaths.clear();
			this.invalidSessionPaths.clear();
			await this.indexHeaders(headers);
		}
		async indexHeaders(headers) {
			for (const header of headers) await this.indexHeader(header);
		}
		async indexHeader(header) {
			this.headers.set(header.id, header);
			this.sessionPaths.delete(header.id);
			if (header.cwd === void 0) {
				this.invalidSessionPaths.set(header.id, "header has no cwd");
				return;
			}
			try {
				const path = await realpathNormalize(header.cwd);
				if (!(await stat(path)).isDirectory()) {
					this.invalidSessionPaths.set(header.id, `cwd '${header.cwd}' is not a directory`);
					return;
				}
				this.sessionPaths.set(header.id, path);
				this.invalidSessionPaths.delete(header.id);
			} catch {
				this.invalidSessionPaths.set(header.id, `cwd '${header.cwd}' does not resolve`);
			}
		}
		async indexLiveSessions() {
			const sessions = this.ctx.get("sessions");
			if (sessions === void 0) return;
			await this.indexHeaders(sessions.list().map((session) => session.header));
		}
		reportFilteredCandidates() {
			for (const entity of this.entities.values()) {
				const record = this.requireTable().get(entity.id);
				for (const sessionId of record.sessionIds) {
					const path = this.sessionPaths.get(sessionId);
					if (path === record.path) continue;
					const reason = this.invalidSessionPaths.get(sessionId) ?? (this.headers.has(sessionId) ? `canonical cwd '${path}' differs from workspace path '${record.path}'` : "session header is missing");
					this.ctx.logger.warn(`workspace '${entity.id}' filtered session '${sessionId}' from membership: ${reason}`);
				}
			}
		}
		async readSessionHeader(id) {
			const live = this.ctx.get("sessions")?.get(id);
			if (live !== void 0) {
				this.headers.set(id, live.header);
				return live.header;
			}
			const cached = this.headers.get(id);
			if (cached !== void 0) return cached;
			const headers = await this.ctx.sessionPersistence.list();
			await this.indexHeaders(headers);
			const header = this.headers.get(id);
			if (header === void 0) throw new Error(`cannot validate session '${id}': session persistence holds no such session`);
			return header;
		}
		requireTable() {
			if (this.table === void 0) throw new Error("workspace registry is not started yet");
			return this.table;
		}
		requireState() {
			if (this.state === void 0) throw new Error("workspace registry is not started yet");
			return this.state;
		}
		async setState(state) {
			await this.global.set(state);
			this.state = state;
		}
		enqueueOperation(operation) {
			const result = this.operationTail.then(async () => {
				await this.recoverPendingMutation();
				return await operation();
			});
			this.operationTail = result.then(() => {}, () => {});
			return result;
		}
	};
})();
const sameSessionIds = (left, right) => left.length === right.length && left.every((id, index) => id === right[index]);
//#endregion
export { WorkspaceId, WorkspaceMoveInvalidError, WorkspaceNameConflictError, WorkspaceOrderInvalidError, WorkspaceRegistry, WorkspaceRegistry as default, WorkspaceSessionDeletionBlockedError, WorkspaceTitleInvalidError, WorkspaceUnknownSessionError, realpathNormalize, workspaceDomainSpec, workspaceDomainState, workspaceRecord };
