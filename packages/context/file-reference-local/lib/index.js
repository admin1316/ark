import z from "@deepseek-ai/schemastery";
import FileReferenceService, { FILE_REFERENCE_PROMPT, FILE_REFERENCE_PROMPT as FILE_REFERENCE_PROMPT$1 } from "@deepseek-ai/dsh-file-reference";
import { FIRST_PARTY_SECTION_ORDER } from "@deepseek-ai/dsh-system-prompt";
import { lstat, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { activeAtToken, formatFileMention } from "@deepseek-ai/dsh-file-reference/grammar";
//#region lib/types/search.js
/**
* Host-workspace discovery for `@file` completion. The index contains paths
* only: selected values remain ordinary prompt text and file contents stay
* behind the model-facing `read` tool.
*
* @module @deepseek-ai/dsh-file-reference-local/search
*/
/** Default maximum file and directory candidates rendered for one query. */
const DEFAULT_FILE_SEARCH_MAX_RESULTS = 20;
/** Default maximum entries retained in one workspace search index. */
const DEFAULT_FILE_SEARCH_MAX_ENTRIES = 1e4;
/** Directory basenames omitted from traversal unless the deployment overrides them. */
const DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES = [".git", "node_modules"];
/**
* Cancellable, reusable fuzzy index rooted at one agent working directory.
* Directory-scoped queries list live state; bare fuzzy queries share one
* bounded traversal until the `@` interaction ends or a tool result invalidates it.
*/
var WorkspaceFileSearch = class {
	root;
	config;
	excludedDirectories;
	generation;
	disposed = false;
	constructor(root, config) {
		this.root = root;
		this.config = config;
		if (!Number.isSafeInteger(config.maxResults) || config.maxResults <= 0) throw new Error("file search maxResults must be a positive safe integer");
		if (!Number.isSafeInteger(config.maxEntries) || config.maxEntries <= 0) throw new Error("file search maxEntries must be a positive safe integer");
		if (config.excludedDirectories.some((name) => name.length === 0 || name.includes("/") || name.includes("\\"))) throw new Error("file search excludedDirectories entries must be non-empty directory basenames");
		this.excludedDirectories = new Set(config.excludedDirectories);
	}
	/**
	* Return ranked path candidates for the current token.
	* @param rawQuery - path text following `@` or `@"`.
	* @param signal - cancels this caller's wait without killing an index shared by a newer query.
	* @returns at most `maxResults` deterministic candidates.
	*/
	async list(rawQuery, signal) {
		signal.throwIfAborted();
		if (this.disposed) return [];
		const query = rawQuery.replaceAll("\\", "/");
		const slash = query.lastIndexOf("/");
		if (query === "" || slash >= 0) {
			const directory = slash < 0 ? "" : query.slice(0, slash + 1);
			const fragment = slash < 0 ? "" : query.slice(slash + 1);
			return this.listDirectory(directory, fragment, signal);
		}
		return rankCandidates((await waitForPromise(this.ensureIndex(), signal)).filter((candidate) => visibleForGlobalQuery(candidate.path, query)), query, this.config.maxResults);
	}
	/** Discard the current index so the next bare query observes a fresh tree. */
	invalidate() {
		this.generation?.controller.abort(/* @__PURE__ */ new Error("file search index invalidated"));
		this.generation = void 0;
	}
	/** Abort traversal and make later queries return no candidates. */
	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		this.invalidate();
	}
	ensureIndex() {
		if (this.generation !== void 0) return this.generation.promise;
		const controller = new AbortController();
		const generation = {
			controller,
			promise: Promise.resolve([])
		};
		generation.promise = this.scanWorkspace(controller.signal).catch((error) => {
			/* v8 ignore next -- every owned abort clears `generation` synchronously; this only protects an unexpected scan failure */
			if (this.generation === generation) this.generation = void 0;
			throw error;
		});
		this.generation = generation;
		return generation.promise;
	}
	async scanWorkspace(signal) {
		const indexed = [];
		const directories = [{
			absolute: this.root,
			relative: ""
		}];
		for (let cursor = 0; cursor < directories.length && indexed.length < this.config.maxEntries; cursor += 1) {
			signal.throwIfAborted();
			const directory = directories[cursor];
			/* v8 ignore next 3 -- cursor is bounded by this exact queue's length. */
			if (directory === void 0) throw new Error("file search selected a missing directory");
			const entries = await readDirectory(directory.absolute, signal);
			for (const entry of entries) {
				signal.throwIfAborted();
				const path = directory.relative === "" ? entry.name : `${directory.relative}/${entry.name}`;
				if (entry.isDirectory()) {
					if (this.excludedDirectories.has(entry.name)) continue;
					indexed.push({
						path,
						kind: "directory"
					});
					directories.push({
						absolute: join(directory.absolute, entry.name),
						relative: path
					});
				} else if (entry.isFile()) indexed.push({
					path,
					kind: "file"
				});
				if (indexed.length >= this.config.maxEntries) break;
			}
		}
		return indexed;
	}
	async listDirectory(displayDirectory, fragment, signal) {
		if (displayDirectory.split("/").some((segment) => this.excludedDirectories.has(segment))) return [];
		const absolute = await resolveDisplayDirectory(this.root, displayDirectory, signal);
		if (absolute === void 0) return [];
		const entries = await readDirectory(absolute, signal);
		const candidates = [];
		for (const entry of entries) {
			if (entry.name.startsWith(".") && !fragment.startsWith(".")) continue;
			if (entry.isDirectory()) {
				if (this.excludedDirectories.has(entry.name)) continue;
				candidates.push({
					path: `${displayDirectory}${entry.name}`,
					kind: "directory"
				});
			} else if (entry.isFile()) candidates.push({
				path: `${displayDirectory}${entry.name}`,
				kind: "file"
			});
		}
		return rankCandidates(candidates, fragment, this.config.maxResults);
	}
};
async function resolveDisplayDirectory(root, displayDirectory, signal) {
	const resolvedRoot = resolve(root);
	const absolute = resolve(resolvedRoot, displayDirectory === "" ? "." : displayDirectory);
	const fromRoot = relative(resolvedRoot, absolute);
	if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) return void 0;
	/* v8 ignore next -- only Windows can produce a cross-volume absolute relative path */
	if (isAbsolute(fromRoot)) return void 0;
	let current = resolvedRoot;
	for (const segment of fromRoot.split(sep).filter(Boolean)) {
		signal.throwIfAborted();
		current = join(current, segment);
		try {
			const status = await lstat(current);
			signal.throwIfAborted();
			if (status.isSymbolicLink() || !status.isDirectory()) return void 0;
		} catch (_error) {
			signal.throwIfAborted();
			return;
		}
	}
	return absolute;
}
async function readDirectory(absolute, signal) {
	signal.throwIfAborted();
	try {
		const entries = await readdir(absolute, { withFileTypes: true });
		signal.throwIfAborted();
		return entries.sort((left, right) => compareText(left.name, right.name));
	} catch (_error) {
		signal.throwIfAborted();
		return [];
	}
}
function visibleForGlobalQuery(path, query) {
	if (query.startsWith(".") || query.includes("/.")) return true;
	return !path.split("/").some((segment) => segment.startsWith("."));
}
function rankCandidates(candidates, query, limit) {
	const ranked = [];
	for (const candidate of candidates) {
		const score = scoreCandidate(candidate, query);
		if (score !== void 0) ranked.push({
			candidate,
			score
		});
	}
	ranked.sort((left, right) => right.score - left.score || kindRank(left.candidate.kind) - kindRank(right.candidate.kind) || (query === "" ? 0 : left.candidate.path.length - right.candidate.path.length) || compareText(left.candidate.path, right.candidate.path));
	return ranked.slice(0, limit).map((entry) => entry.candidate);
}
function scoreCandidate(candidate, query) {
	if (query === "") return 0;
	const path = candidate.path.toLowerCase();
	const name = path.slice(path.lastIndexOf("/") + 1);
	const needle = query.toLowerCase();
	const directoryBonus = candidate.kind === "directory" ? 25 : 0;
	if (name === needle) return 1e3 + directoryBonus;
	if (name.startsWith(needle)) return 900 + directoryBonus;
	if (name.includes(needle)) return 700 + directoryBonus;
	if (path.includes(needle)) return 500 + directoryBonus;
	const subsequence = subsequenceScore(path, needle);
	return subsequence === void 0 ? void 0 : 300 + subsequence + directoryBonus;
}
function subsequenceScore(target, query) {
	let targetIndex = 0;
	let gap = 0;
	for (const character of query) {
		const found = target.indexOf(character, targetIndex);
		if (found < 0) return void 0;
		gap += found - targetIndex;
		targetIndex = found + 1;
	}
	return Math.max(0, 100 - gap);
}
function kindRank(kind) {
	return kind === "directory" ? 0 : 1;
}
function compareText(left, right) {
	/* v8 ignore next -- entries and candidates are unique; host enumeration
	* order determines which comparison direction sort requests. */
	return left < right ? -1 : left > right ? 1 : 0;
}
function waitForPromise(promise, signal) {
	/* v8 ignore next -- `list()` checks this signal immediately before its synchronous call into this helper */
	if (signal.aborted) return Promise.reject(errorReason(signal.reason, "file search aborted"));
	return new Promise((resolvePromise, rejectPromise) => {
		const onAbort = () => {
			rejectPromise(errorReason(signal.reason, "file search aborted"));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then((value) => {
			signal.removeEventListener("abort", onAbort);
			resolvePromise(value);
		}, (error) => {
			signal.removeEventListener("abort", onAbort);
			rejectPromise(errorReason(error, "file search index failed"));
		});
	});
}
function errorReason(reason, fallback) {
	return reason instanceof Error ? reason : new Error(fallback, { cause: reason });
}
//#endregion
//#region lib/types/index.js
/**
* Local-filesystem implementation of `ctx.fileReferences`.
*
* @module @deepseek-ai/dsh-file-reference-local
*/
/** Local-filesystem owner of the file-reference discovery service. */
var LocalFileReferenceService = class extends FileReferenceService {
	static inject = ["agents"];
	static Config = z.object({
		maxResults: z.number().step(1).min(1).default(20),
		maxEntries: z.number().step(1).min(1).default(DEFAULT_FILE_SEARCH_MAX_ENTRIES),
		excludedDirectories: z.array(z.string()).default([...DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES])
	});
	config;
	searches = /* @__PURE__ */ new Map();
	promptFibers = /* @__PURE__ */ new Map();
	promptDisposals = /* @__PURE__ */ new Set();
	constructor(ctx, config = {}) {
		super(ctx);
		this.config = {
			maxResults: config.maxResults ?? 20,
			maxEntries: config.maxEntries ?? 1e4,
			excludedDirectories: config.excludedDirectories ?? DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES
		};
		validateConfig(this.config);
		const installPrompt = (agent) => {
			if (this.promptFibers.has(agent)) return;
			const fiber = agent.ctx.inject(["systemPrompt", "tools"], (scope) => {
				scope.systemPrompt.section({
					name: "context:file-reference",
					order: FIRST_PARTY_SECTION_ORDER.FILE_REFERENCE,
					text: () => agent.ctx.tools.get("read", agent) === void 0 ? "" : FILE_REFERENCE_PROMPT$1
				});
			});
			this.promptFibers.set(agent, fiber);
		};
		const disposePrompt = (agent) => {
			const fiber = this.promptFibers.get(agent);
			if (fiber === void 0) return;
			this.promptFibers.delete(agent);
			const task = fiber.dispose().catch((error) => {
				ctx.logger.warn(`file-reference-local: prompt cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
			});
			this.promptDisposals.add(task);
			task.finally(() => {
				this.promptDisposals.delete(task);
			});
		};
		for (const agent of ctx.agents.list()) installPrompt(agent);
		ctx.on("agent/created", ({ agent }) => {
			installPrompt(agent);
		});
		ctx.on("agent/disposed", ({ agent }) => {
			this.searches.get(agent)?.dispose();
			this.searches.delete(agent);
			disposePrompt(agent);
		});
		ctx.on("session/event", (session, event) => {
			if (event.type !== "tool/result") return;
			const agent = ctx.agents.get(session.id);
			if (agent !== void 0) this.searches.get(agent)?.invalidate();
		});
		ctx.effect(() => async () => {
			for (const search of this.searches.values()) search.dispose();
			this.searches.clear();
			const promptFibers = [...this.promptFibers.values()];
			this.promptFibers.clear();
			await Promise.all([...promptFibers.map((fiber) => fiber.dispose()), ...this.promptDisposals]);
		}, "file-reference-local: search cache");
	}
	list(agent, query, signal) {
		let search = this.searches.get(agent);
		if (search === void 0) {
			search = new WorkspaceFileSearch(agent.session.header.cwd ?? process.cwd(), this.config);
			this.searches.set(agent, search);
		}
		return search.list(query, signal);
	}
};
function validateConfig(config) {
	if (!Number.isSafeInteger(config.maxResults) || config.maxResults <= 0) throw new Error("file-reference-local: maxResults must be a positive safe integer");
	if (!Number.isSafeInteger(config.maxEntries) || config.maxEntries <= 0) throw new Error("file-reference-local: maxEntries must be a positive safe integer");
	if (config.excludedDirectories.some((name) => name.length === 0 || name.includes("/") || name.includes("\\"))) throw new Error("file-reference-local: excludedDirectories entries must be non-empty directory basenames");
}
//#endregion
export { DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES, DEFAULT_FILE_SEARCH_MAX_ENTRIES, DEFAULT_FILE_SEARCH_MAX_RESULTS, FILE_REFERENCE_PROMPT, LocalFileReferenceService, LocalFileReferenceService as default, WorkspaceFileSearch, activeAtToken, formatFileMention };
