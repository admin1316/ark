import { Remote, TypertLookupFailure, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { formatFetchOutputState } from "@deepseek-ai/dsh-tool-web";
import { z } from "zod";
//#region lib/types/index.js
/** Domain-owned Typert Remote service for the Native Ark Workbench. */
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
const WORKBENCH_WEB_READER_MAX_CHARS = 1e5;
const workbenchWebReadRequestSchema = z.object({ url: z.string().min(1) });
/** Validate a strict slash-Remote request before any filesystem access. */
function parseRequest(schema, input, method) {
	const parsed = schema.safeParse(input);
	if (!parsed.success) throw new TypertLookupFailure({
		code: "bad-request",
		message: `invalid payload for ${method}`,
		details: { issues: parsed.error.issues }
	});
	return parsed.data;
}
/** Construct the stable cancellation result for one Workbench operation. */
function cancelled(message) {
	return new TypertLookupFailure({
		code: "cancelled",
		message,
		details: {}
	});
}
/** Read a mutable AbortSignal without retaining an earlier control-flow narrowing. */
function isAborted(signal) {
	return signal.aborted;
}
/** Native Workbench Remote owner for the browser-free Host Web reader. */
let WorkbenchRemoteService = (() => {
	let _classSuper = TypertRemoteService;
	let _instanceExtraInitializers = [];
	let _webRead_decorators;
	return class WorkbenchRemoteService extends _classSuper {
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_webRead_decorators = [Remote("webRead")];
			__esDecorate(this, null, _webRead_decorators, {
				kind: "method",
				name: "webRead",
				static: false,
				private: false,
				access: {
					has: (obj) => "webRead" in obj,
					get: (obj) => obj.webRead
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
		static inject = ["web"];
		constructor(ctx) {
			super(ctx, "workbench");
			__runInitializers(this, _instanceExtraInitializers);
		}
		/**
		* Fetch one public HTTP(S) page through the existing SSRF-safe Host provider
		* and convert it to bounded Markdown for the Native Workbench reader.
		* @param request - strict request containing the public HTTP(S) URL.
		* @param signal - caller cancellation propagated through WebFetch.
		* @returns the bounded body-only Markdown document and structured fetch facts.
		*/
		async webRead(request, signal) {
			const payload = parseRequest(workbenchWebReadRequestSchema, request, "workbench/webRead");
			if (isAborted(signal)) throw cancelled("workbench web read was aborted");
			try {
				const result = await this.ctx.web.fetch({ url: payload.url }, signal);
				const formatted = formatFetchOutputState(result, WORKBENCH_WEB_READER_MAX_CHARS);
				return {
					url: result.url,
					title: new URL(result.url).hostname,
					statusCode: result.statusCode,
					markdown: formatted.markdown,
					truncated: formatted.markdownTruncated
				};
			} catch (error) {
				if (isAborted(signal)) throw cancelled("workbench web read was aborted");
				const webError = error;
				throw new TypertLookupFailure({
					code: "web-reader-error",
					message: error instanceof Error ? error.message : String(error),
					details: {
						url: payload.url,
						reason: typeof webError.code === "string" ? webError.code : "unexpected"
					}
				});
			}
		}
	};
})();
//#endregion
export { WorkbenchRemoteService, WorkbenchRemoteService as default };
