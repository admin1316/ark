import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
//#region lib/types/grammar.js
/**
* Browser-safe `@file` token grammar shared by terminal and web clients.
*
* @module @deepseek-ai/dsh-file-reference/grammar
*/
/**
* Extract an `@path` or `@"path with spaces` token at the cursor. An `@`
* inside another token, such as an email address, is not a completion trigger.
* @param line - current editor line.
* @param cursorCol - cursor column within that line.
* @returns the active token, or `undefined` outside an `@` token.
*/
function activeAtToken(line, cursorCol) {
	const beforeCursor = line.slice(0, cursorCol);
	const quoted = /(?:^|\s)(@"([^"]*))$/u.exec(beforeCursor);
	if (quoted?.[1] !== void 0 && quoted[2] !== void 0) return {
		prefix: quoted[1],
		query: quoted[2],
		quoted: true
	};
	const plain = /(?:^|\s)(@([^\s]*))$/u.exec(beforeCursor);
	if (plain?.[1] === void 0 || plain[2] === void 0) return void 0;
	return {
		prefix: plain[1],
		query: plain[2],
		quoted: false
	};
}
/**
* Format a selected path as prompt text. Whitespace uses the quoted
* `@"path"` grammar; a quoted directory keeps that quote open after its
* trailing slash so completion can descend another level.
* @param candidate - selected file or directory.
* @param preserveQuote - retain an explicitly opened quote even when unnecessary.
* @returns the insertion value, or `undefined` for a path the editor grammar cannot represent safely.
*/
function formatFileMention(candidate, preserveQuote) {
	const path = candidate.kind === "directory" ? `${candidate.path}/` : candidate.path;
	if (/[\u0000-\u001f\u007f-\u009f"]/u.test(path)) return void 0;
	if (!(preserveQuote || /\s/u.test(path))) return `@${path}`;
	if (candidate.kind === "directory") return `@"${path}`;
	return `@"${path}"`;
}
//#endregion
//#region lib/types/index.js
/**
* File-reference discovery seam shared by host-backed user interfaces.
*
* @module @deepseek-ai/dsh-file-reference
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
/** Model guidance for path-only references selected by a user interface. */
const FILE_REFERENCE_PROMPT = "Paths prefixed with @ are files explicitly referenced by the user. Use the read tool when their contents are needed; do not claim to have inspected a file before reading it.";
/** Host capability for cancellable file-reference discovery. */
let FileReferenceService = (() => {
	let _classSuper = TypertRemoteService;
	let _instanceExtraInitializers = [];
	let _remoteExportList_decorators;
	return class FileReferenceService extends _classSuper {
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_remoteExportList_decorators = [Remote("list")];
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
			if (_metadata) Object.defineProperty(this, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		constructor(ctx) {
			super(ctx, "fileReferences");
			__runInitializers(this, _instanceExtraInitializers);
		}
		/**
		* Remote face of {@link list}; the decorator cannot mark the abstract
		* member, so this concrete adapter carries the identical contract.
		* @param agent - target agent whose session cwd bounds discovery.
		* @param query - path text following `@` or `@"`.
		* @param signal - caller cancellation.
		* @returns deterministic path-only candidates.
		*/
		remoteExportList(agent, query, signal) {
			return this.list(agent, query, signal);
		}
	};
})();
//#endregion
export { FILE_REFERENCE_PROMPT, FileReferenceService, FileReferenceService as default, activeAtToken, formatFileMention };
