import { Remote, TypertRemoteFailure, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { z } from "zod";
import { DirectoryPickerError } from "@deepseek-ai/dsh-host-directory-picker";
import { WorkspaceId, workspaceDomainState, workspaceRecord } from "@deepseek-ai/dsh-workspace";
//#region lib/types/directory-picker.js
/**
* Host directory-picking Remote owner: capability gating, cancellation, and the
* stable wire failure vocabulary over the `ctx.directoryPicker` seam.
*/
var __runInitializers$1 = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
var __esDecorate$1 = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
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
const createDirectoryRequestSchema = z.object({
	path: z.string(),
	name: z.string()
}).refine((request) => request.name.trim() !== "" && request.name !== "." && request.name !== ".." && !/[/\\]/.test(request.name), { message: "host.createDirectory requires a single non-blank path segment name" });
/**
* Host service backing the generated `ctx.remote.directoryPicker` namespace. The
* seam it exports is abstract and therefore never a Loader entry of its own, so
* this controller carries the wire verbs: one composed backend serves either the
* native chooser or the browse primitives, and a verb the composition cannot
* serve is refused rather than approximated.
*/
let DirectoryPickerController = (() => {
	let _classSuper = TypertRemoteService;
	let _instanceExtraInitializers = [];
	let _pick_decorators;
	let _list_decorators;
	let _createDirectory_decorators;
	return class DirectoryPickerController extends _classSuper {
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_pick_decorators = [Remote("pick")];
			_list_decorators = [Remote("list")];
			_createDirectory_decorators = [Remote("createDirectory")];
			__esDecorate$1(this, null, _pick_decorators, {
				kind: "method",
				name: "pick",
				static: false,
				private: false,
				access: {
					has: (obj) => "pick" in obj,
					get: (obj) => obj.pick
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate$1(this, null, _list_decorators, {
				kind: "method",
				name: "list",
				static: false,
				private: false,
				access: {
					has: (obj) => "list" in obj,
					get: (obj) => obj.list
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate$1(this, null, _createDirectory_decorators, {
				kind: "method",
				name: "createDirectory",
				static: false,
				private: false,
				access: {
					has: (obj) => "createDirectory" in obj,
					get: (obj) => obj.createDirectory
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
		static inject = ["directoryPicker"];
		/** @param ctx - Host context carrying the composed directory-picking backend. */
		constructor(ctx) {
			super(ctx, "directoryPickerController", { namespace: "directoryPicker" });
			__runInitializers$1(this, _instanceExtraInitializers);
		}
		/**
		* Open the host's OS chooser for a Remote caller.
		* @param signal - caller lifetime; abort terminates the chooser.
		* @returns the chosen absolute path, or null when the operator cancels.
		*/
		async pick(signal) {
			const capability = this.requireCapability("native", "pick");
			try {
				return await capability.pick(signal);
			} catch (error) {
				throw cancellableFailure(error, signal, "directory picker was aborted", "directory picker failed");
			}
		}
		/**
		* List one directory level for a Remote caller's in-app browser.
		* @param path - absolute directory to list; absent lists the home directory.
		* @param signal - caller lifetime; abort stops the backend's scan instead of
		*   letting it outlive a disconnected caller.
		* @returns the level's listing with its ancestry.
		*/
		async list(path, signal) {
			const capability = this.requireCapability("browse", "list");
			try {
				return await capability.list(path, signal);
			} catch (error) {
				throw cancellableFailure(error, signal, "directory listing was aborted");
			}
		}
		/**
		* Create one child directory for a Remote caller's in-app browser.
		* @param path - absolute existing parent directory.
		* @param name - single non-blank path segment.
		* @returns the created directory's absolute path.
		*/
		async createDirectory(path, name) {
			const request = createDirectoryRequestSchema.safeParse({
				path,
				name
			});
			if (!request.success) throw pickerFailureOf("bad-request", "invalid payload for host.createDirectory", { issues: request.error.issues });
			const capability = this.requireCapability("browse", "createDirectory");
			try {
				return await capability.createDirectory(request.data.path, request.data.name);
			} catch (error) {
				throw browseFailure(error);
			}
		}
		/** Resolve the capability one wire verb needs, or refuse with the kind this backend serves. */
		requireCapability(kind, method) {
			const capability = this.ctx.directoryPicker.capability();
			if (capability.kind !== kind) throw pickerFailureOf("directory-picker-unavailable", `directoryPicker.${method} needs the ${kind} capability; the composed picker serves "${capability.kind}"`, { capability: capability.kind });
			return capability;
		}
	};
})();
/**
* Raise one entry of the picking wire failure vocabulary.
* @param code - the failure code a caller discriminates on.
* @param message - operator-facing description.
* @param details - the payload this code carries.
* @returns the failure to throw across the Remote boundary.
*/
function pickerFailureOf(code, message, details) {
	return new TypertRemoteFailure({
		code,
		message,
		details
	});
}
/**
* Classify a browse-primitive rejection: the seam's own closed codes carry the
* path they are about, and anything else stays an infrastructure failure.
* @param error - the primitive's rejection.
* @returns the failure to throw across the Remote boundary.
*/
function browseFailure(error) {
	if (error instanceof DirectoryPickerError) return pickerFailureOf(error.code, error.message, { path: error.path });
	return pickerFailureOf("internal", errorMessage(error), {});
}
/**
* Classify a cancellable primitive's rejection. An abort is the caller's own
* timeout or disconnect, not a backend failure, so it answers `cancelled`
* before the business classification runs.
* @param error - the primitive's rejection.
* @param signal - the caller lifetime the primitive ran under.
* @param cancelled - operator-facing text for the abort outcome.
* @param failed - prefix for a non-seam failure, when the verb has no closed codes.
* @returns the failure to throw across the Remote boundary.
*/
function cancellableFailure(error, signal, cancelled, failed) {
	if (signal.aborted) return pickerFailureOf("cancelled", cancelled, {});
	if (failed === void 0) return browseFailure(error);
	return pickerFailureOf("internal", `${failed}: ${errorMessage(error)}`, {});
}
function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}
//#endregion
//#region lib/types/feed.js
/** Reconnect-safe Workspace baseline and increment producer. */
/**
* Project one authoritative Workspace entity into its Remote value.
* @param workspace - authoritative registry entity.
* @returns detached Workspace projection for Remote consumers.
*/
function workspaceView(workspace) {
	return {
		workspaceId: workspace.id,
		path: workspace.path,
		title: workspace.title,
		sessionIds: [...workspace.sessionIds],
		createdAt: workspace.createdAt,
		updatedAt: workspace.updatedAt
	};
}
function changedWorkspaceView(workspaceId, value) {
	const record = workspaceRecord.parse(value);
	return {
		workspaceId: WorkspaceId(workspaceId),
		path: record.path,
		title: record.title,
		sessionIds: [...record.sessionIds],
		createdAt: record.createdAt,
		updatedAt: record.updatedAt
	};
}
/** Owns Workspace domain observation and all active follow generations. */
var WorkspaceFeed = class {
	ctx;
	followers = /* @__PURE__ */ new Set();
	knownIds;
	order;
	archived;
	/** @param ctx - Host context containing the authoritative Workspace registry. */
	constructor(ctx) {
		this.ctx = ctx;
		const baseline = ctx.workspaceRegistry.list();
		this.knownIds = new Set(baseline.map((workspace) => String(workspace.id)));
		this.order = baseline.map((workspace) => String(workspace.id));
		this.archived = ctx.workspaceRegistry.archivedSessionIds.map(String);
		ctx.on("domain/changed", (change) => {
			this.changed(change);
		});
		ctx.effect(() => () => {
			for (const follower of this.followers) follower.close();
			this.followers.clear();
		}, "workspace-controller.feed");
	}
	/**
	* Read the complete current projection synchronously.
	* @returns all active Workspaces and archived Session identities.
	*/
	baseline() {
		return {
			items: this.ctx.workspaceRegistry.list().map(workspaceView),
			archivedSessionIds: [...this.ctx.workspaceRegistry.archivedSessionIds]
		};
	}
	/**
	* Open one generation beginning with a complete baseline.
	* @param signal - generation cancellation.
	* @returns baseline followed by ordered Workspace increments.
	*/
	async *follow(signal) {
		signal.throwIfAborted();
		const follower = new WorkspaceFollower();
		this.followers.add(follower);
		try {
			yield {
				type: "baseline",
				value: this.baseline()
			};
			yield* follower.read(signal);
		} finally {
			this.followers.delete(follower);
			follower.close();
		}
	}
	changed(change) {
		if (change.domain !== "workspace") return;
		if (change.table === "") {
			if (change.operation !== "put") return;
			const state = workspaceDomainState.parse(change.value);
			const nextOrder = state.workspaceIds.map(String);
			const orderChanged = !sameStrings(this.order, nextOrder);
			for (const id of state.workspaceIds) {
				if (this.knownIds.has(id)) continue;
				const workspace = this.ctx.workspaceRegistry.get(id);
				if (workspace === void 0) throw new Error(`committed Workspace registry references missing Workspace "${id}"`);
				this.knownIds.add(id);
				this.publish({
					type: "upsert",
					workspace: workspaceView(workspace)
				});
			}
			this.order = nextOrder;
			if (orderChanged) this.publish({
				type: "order",
				workspaceIds: [...state.workspaceIds]
			});
			const nextArchived = state.archivedSessionIds.map(String);
			if (!sameStrings(this.archived, nextArchived)) {
				this.archived = nextArchived;
				this.publish({
					type: "archived",
					archivedSessionIds: [...state.archivedSessionIds]
				});
			}
			return;
		}
		if (change.table !== "workspaces") return;
		if (change.operation === "deleted") {
			if (!this.knownIds.delete(change.key)) return;
			this.publish({
				type: "remove",
				workspaceId: WorkspaceId(change.key)
			});
			return;
		}
		if (!this.knownIds.has(change.key)) return;
		this.publish({
			type: "upsert",
			workspace: changedWorkspaceView(change.key, change.value)
		});
	}
	publish(frame) {
		for (const follower of this.followers) follower.push(frame);
	}
};
function sameStrings(left, right) {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}
var WorkspaceFollower = class {
	frames = [];
	waiting;
	closed = false;
	push(frame) {
		/* v8 ignore next -- closed followers are removed before later publication can reach them. */
		if (this.closed) return;
		this.frames.push(frame);
		this.waiting?.();
	}
	close() {
		if (this.closed) return;
		this.closed = true;
		this.waiting?.();
	}
	async *read(signal) {
		while (!this.closed && !signal.aborted) {
			const frame = this.frames.shift();
			if (frame !== void 0) {
				yield frame;
				continue;
			}
			await this.wait(signal);
		}
	}
	wait(signal) {
		return new Promise((resolve) => {
			const finish = () => {
				signal.removeEventListener("abort", finish);
				/* v8 ignore next -- one read owns the sole installed wait callback. */
				if (this.waiting === finish) this.waiting = void 0;
				resolve();
			};
			this.waiting = finish;
			signal.addEventListener("abort", finish, { once: true });
			/* v8 ignore next -- native signals and the private queue cannot change during this synchronous setup. */
			if (signal.aborted || this.closed || this.frames.length > 0) finish();
		});
	}
};
//#endregion
//#region lib/types/index.js
/** Workspace follow Remote owner and directory-picker composition. */
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
/** Host service backing the generated `ctx.remote.workspace` namespace. */
let WorkspaceController = (() => {
	let _classSuper = TypertRemoteService;
	let _instanceExtraInitializers = [];
	let _follow_decorators;
	return class WorkspaceController extends _classSuper {
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_follow_decorators = [Remote({ mode: "stream" })];
			__esDecorate(this, null, _follow_decorators, {
				kind: "method",
				name: "follow",
				static: false,
				private: false,
				access: {
					has: (obj) => "follow" in obj,
					get: (obj) => obj.follow
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
		static inject = ["typert", "workspaceRegistry"];
		feed = __runInitializers(this, _instanceExtraInitializers);
		/** @param ctx - Host context containing the Workspace registry. */
		constructor(ctx) {
			super(ctx, "workspaceController", { namespace: "workspace" });
			this.feed = new WorkspaceFeed(ctx);
			ctx.plugin(DirectoryPickerController);
		}
		/**
		* Stream a complete Workspace baseline followed by ordered increments.
		* @param signal - generation cancellation.
		* @returns baseline followed by ordered Workspace increments.
		*/
		follow(signal) {
			return this.feed.follow(signal);
		}
	};
})();
//#endregion
export { DirectoryPickerController, WorkspaceController, WorkspaceController as default };
