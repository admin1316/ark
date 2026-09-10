import { Service, symbols } from "@deepseek-ai/cordis";
import { TypertLookupFailure, isTypertRemoteFailure, isTypertRemoteSegment } from "@deepseek-ai/dsh-typert-protocol";
//#region lib/types/native-remote-routes.js
/**
* Native Swift consumer coverage for generated Typert Remote descriptors.
*
* Gateway ownership is dynamic: every live strict descriptor can be claimed.
* This list records the routes currently consumed by Ark so build checks can
* reject a missing descriptor without constraining future Host plugins.
*/
const NATIVE_TYPERT_REMOTE_ENDPOINTS = [
	"agentPreset/copy",
	"agentPreset/list",
	"agentPreset/openDocument",
	"agentPreset/read",
	"agentPreset/remove",
	"agentPreset/select",
	"commands/execute",
	"commands/list",
	"credentials/describe",
	"credentials/set",
	"credentials/unset",
	"fileReferences/list",
	"goal/clear",
	"goal/edit",
	"goal/pause",
	"goal/resume",
	"knowledgeWiki/createPage",
	"knowledgeWiki/createProject",
	"knowledgeWiki/deepResearch",
	"knowledgeWiki/graph",
	"knowledgeWiki/ingestQueueAdd",
	"knowledgeWiki/ingestQueueCancel",
	"knowledgeWiki/ingestQueueStatus",
	"knowledgeWiki/list",
	"knowledgeWiki/listProjects",
	"knowledgeWiki/pageContent",
	"knowledgeWiki/removeProject",
	"knowledgeWiki/resolveReview",
	"knowledgeWiki/resolveReviews",
	"knowledgeWiki/reviews",
	"knowledgeWiki/search",
	"knowledgeWiki/setProject",
	"knowledgeWiki/writePage",
	"llm/discoverModels",
	"llm/models",
	"llm/mutateProvider",
	"llm/providerTransaction",
	"llm/providers",
	"llm/resumeProvider",
	"messageFeedback/delete",
	"messageFeedback/list",
	"messageFeedback/put",
	"pluginInventory/list",
	"session/attachment",
	"session/cancel",
	"session/create",
	"session/fork",
	"session/history",
	"session/list",
	"session/models",
	"session/prompt",
	"session/rename",
	"session/search",
	"session/selectModel",
	"session/updateQueue",
	"sessionReferenceResolver/candidates",
	"settings/describe",
	"settings/openDocument",
	"settings/mutate",
	"skill/list",
	"subagent/history",
	"subagent/interrupt",
	"subagent/list",
	"subagent/prompt",
	"workbench/webRead",
	"workspace/archiveSession",
	"workspace/create",
	"workspace/delete",
	"workspace/deleteArchivedSession",
	"workspace/insertBefore",
	"workspace/insertSessionBefore",
	"workspace/list",
	"workspace/rename",
	"workspace/unarchiveSession"
];
/**
* Deliberate API-only legacy calls still consumed by Native Ark. Kept as an
* explicit empty fail-closed list so a future dot route cannot silently bypass
* strict Remote.
*/
const NATIVE_LEGACY_API_ENDPOINTS = [];
/** Exact Typert service owner expected for each current Native endpoint. */
const NATIVE_TYPERT_REMOTE_OWNERS = {
	"agentPreset/copy": "agentPresets",
	"agentPreset/list": "agentPresets",
	"agentPreset/openDocument": "agentPresets",
	"agentPreset/read": "agentPresets",
	"agentPreset/remove": "agentPresets",
	"agentPreset/select": "agentPresets",
	"commands/execute": "commands",
	"commands/list": "commands",
	"credentials/describe": "credentials",
	"credentials/set": "credentials",
	"credentials/unset": "credentials",
	"fileReferences/list": "fileReferences",
	"goal/clear": "goals",
	"goal/edit": "goals",
	"goal/pause": "goals",
	"goal/resume": "goals",
	"knowledgeWiki/createPage": "knowledgeWiki",
	"knowledgeWiki/createProject": "knowledgeWiki",
	"knowledgeWiki/deepResearch": "knowledgeWiki",
	"knowledgeWiki/graph": "knowledgeWiki",
	"knowledgeWiki/ingestQueueAdd": "knowledgeWiki",
	"knowledgeWiki/ingestQueueCancel": "knowledgeWiki",
	"knowledgeWiki/ingestQueueStatus": "knowledgeWiki",
	"knowledgeWiki/list": "knowledgeWiki",
	"knowledgeWiki/listProjects": "knowledgeWiki",
	"knowledgeWiki/pageContent": "knowledgeWiki",
	"knowledgeWiki/removeProject": "knowledgeWiki",
	"knowledgeWiki/resolveReview": "knowledgeWiki",
	"knowledgeWiki/resolveReviews": "knowledgeWiki",
	"knowledgeWiki/reviews": "knowledgeWiki",
	"knowledgeWiki/search": "knowledgeWiki",
	"knowledgeWiki/setProject": "knowledgeWiki",
	"knowledgeWiki/writePage": "knowledgeWiki",
	"llm/discoverModels": "llm",
	"llm/models": "llm",
	"llm/mutateProvider": "llm",
	"llm/providerTransaction": "llm",
	"llm/providers": "llm",
	"llm/resumeProvider": "llm",
	"messageFeedback/delete": "messageFeedback",
	"messageFeedback/list": "messageFeedback",
	"messageFeedback/put": "messageFeedback",
	"pluginInventory/list": "pluginInventory",
	"session/attachment": "sessions",
	"session/cancel": "sessions",
	"session/create": "sessions",
	"session/fork": "sessions",
	"session/history": "sessions",
	"session/list": "sessions",
	"session/models": "sessions",
	"session/prompt": "sessions",
	"session/rename": "sessions",
	"session/search": "sessions",
	"session/selectModel": "sessions",
	"session/updateQueue": "sessions",
	"sessionReferenceResolver/candidates": "sessionReferenceResolver",
	"settings/describe": "settings",
	"settings/openDocument": "settings",
	"settings/mutate": "settings",
	"skill/list": "skills",
	"subagent/history": "subagents",
	"subagent/interrupt": "subagents",
	"subagent/list": "subagents",
	"subagent/prompt": "subagents",
	"workbench/webRead": "workbench",
	"workspace/archiveSession": "workspaceRegistry",
	"workspace/create": "workspaceRegistry",
	"workspace/delete": "workspaceRegistry",
	"workspace/deleteArchivedSession": "workspaceRegistry",
	"workspace/insertBefore": "workspaceRegistry",
	"workspace/insertSessionBefore": "workspaceRegistry",
	"workspace/list": "workspaceRegistry",
	"workspace/rename": "workspaceRegistry",
	"workspace/unarchiveSession": "workspaceRegistry"
};
//#endregion
//#region lib/types/index.js
/**
* Host-only strict Typert Remote dispatch for Native clients.
* @module @deepseek-ai/dsh-api-gateway
*/
/** Strict dispatch failure converted to a Native Remote result. */
var TypertGatewayError = class extends Error {
	/** Machine-readable failure category. */
	code;
	/** Canonical `<namespace>/<method>` endpoint. */
	endpoint;
	/** Structured public failure context. */
	details;
	/** Affected wire field when the failure is field-specific. */
	field;
	/**
	* Construct one failure without embedding rejected boundary values.
	* @param code - stable failure category.
	* @param endpoint - canonical Remote endpoint.
	* @param message - correction-oriented diagnostic.
	* @param options - optional public details, field, and contained cause.
	*/
	constructor(code, endpoint, message, options = {}) {
		super(`typert gateway: ${endpoint}: ${message}`, options.cause === void 0 ? void 0 : { cause: options.cause });
		this.name = "TypertGatewayError";
		this.code = code;
		this.endpoint = endpoint;
		this.details = options.details ?? {};
		this.field = options.field;
	}
};
/**
* Build a strict dispatcher bound to one Cordis caller scope.
* @param ctx - scope used to resolve Typert, receiver Services, and Context providers.
* @returns dispatcher that re-reads live registry state for every call.
*/
function createTypertGatewayDispatcher(ctx) {
	return {
		claims(endpoint) {
			if (!validEndpoint(endpoint)) return false;
			const typert = ctx.get("typert");
			if (typert === void 0) return false;
			return typert.local.get(endpoint) !== void 0 || typert.local.hasSeen(endpoint);
		},
		invoke: (endpoint, payload, signal) => invokeRemote(ctx, endpoint, payload, signal)
	};
}
/**
* Sole slash Remote owner on Connection's shared `/api` channel.
* @typert service typertGateway
*/
var TypertGatewayService = class extends Service {
	static inject = ["typert"];
	dispatcher;
	/**
	* Register dynamic strict dispatch when Host Connection becomes available.
	* @param ctx - owning Host Context.
	*/
	constructor(ctx) {
		super(ctx, "typertGateway");
		this.dispatcher = createTypertGatewayDispatcher(ctx);
		ctx.inject(["connection"], (connectionCtx) => {
			connectionCtx.get("connection").rpc.intercept("/api", (endpoint) => this.claims(endpoint), (endpoint, payload, signal) => this.dispatch(endpoint, payload, signal), { authority: "loopback" });
		});
	}
	/**
	* Report whether this gateway owns an endpoint.
	* @param endpoint - slash-delimited Remote endpoint to inspect.
	* @returns `true` when the gateway owns the endpoint.
	*/
	claims(endpoint) {
		return this.dispatcher.claims(endpoint);
	}
	/**
	* Invoke one claimed endpoint through the gateway dispatcher.
	* @param endpoint - slash-delimited Remote endpoint to invoke.
	* @param payload - caller payload forwarded to the endpoint.
	* @param signal - caller-owned cancellation signal.
	* @returns the dispatched Remote result.
	*/
	invoke(endpoint, payload, signal) {
		return this.dispatcher.invoke(endpoint, payload, signal);
	}
	async dispatch(endpoint, payload, signal) {
		return {
			ok: true,
			value: await this.invoke(endpoint, payload, signal)
		};
	}
};
async function invokeRemote(ctx, endpoint, payload, signal) {
	try {
		const [namespace, method] = endpointParts(endpoint);
		const typert = ctx.get("typert");
		if (typert === void 0) throw new TypertGatewayError("service-unavailable", endpoint, "the Typert registry is unavailable");
		const descriptor = typert.local.get(endpoint);
		if (descriptor === void 0) {
			const code = typert.local.hasSeen(endpoint) ? "definition-unavailable" : "invocation-unavailable";
			throw new TypertGatewayError(code, endpoint, code === "definition-unavailable" ? "its strict definition was withdrawn" : "no active strict definition owns this endpoint");
		}
		assertStrictDescriptor(descriptor, namespace, method, endpoint);
		const argsByWire = remoteArgs(payload, endpoint);
		assertExactArguments(argsByWire, descriptor, endpoint);
		const receiver = (await resolveReceiverContext(ctx, typert, descriptor, argsByWire, endpoint)).get(descriptor.service);
		if (!isObject(receiver)) throw new TypertGatewayError("service-unavailable", endpoint, `active Service ${JSON.stringify(descriptor.service)} is unavailable`);
		validateBinding(receiver, descriptor, endpoint);
		const args = await Promise.all(descriptor.parameters.map((parameter) => resolveParameter(typert, parameter, argsByWire, endpoint)));
		if (descriptor.cancellation !== void 0) args.push(signal);
		if (isAborted(signal)) throw cancelled(endpoint, signal.reason);
		const implementation = descriptor.implementation ?? descriptor.method;
		const methodValue = Reflect.get(receiver, implementation);
		if (typeof methodValue !== "function") throw new TypertGatewayError("method-unavailable", endpoint, `active Service ${JSON.stringify(descriptor.service)} has no callable method ${JSON.stringify(implementation)}`);
		let result;
		try {
			result = await Reflect.apply(methodValue, receiver, args);
		} catch (error) {
			if (isAborted(signal)) throw cancelled(endpoint, error);
			throw error;
		}
		if (isAborted(signal)) throw cancelled(endpoint, signal.reason);
		const resultCodec = descriptor.result;
		requireStrictCodec(resultCodec, endpoint, "result");
		return {
			ok: true,
			value: encodeResult(resultCodec, result, endpoint)
		};
	} catch (error) {
		return {
			ok: false,
			error: remoteFailure(error)
		};
	}
}
/** Read a mutable AbortSignal without retaining an earlier control-flow narrowing. */
function isAborted(signal) {
	return signal.aborted;
}
function endpointParts(endpoint) {
	if (!validEndpoint(endpoint)) throw new TypertGatewayError("arguments-invalid", endpoint, "endpoint must contain one non-empty namespace and method");
	return endpoint.split("/");
}
function validEndpoint(endpoint) {
	const parts = endpoint.split("/");
	return parts.length === 2 && parts.every(isTypertRemoteSegment);
}
function remoteArgs(payload, endpoint) {
	if (!isPlainObject(payload) || Reflect.ownKeys(payload).length !== 1 || !Object.hasOwn(payload, "args") || !isPlainObject(payload.args)) throw new TypertGatewayError("arguments-invalid", endpoint, "payload must contain exactly one plain-object args field");
	return payload.args;
}
function assertStrictDescriptor(descriptor, namespace, method, endpoint) {
	if (descriptor.namespace !== namespace || descriptor.method !== method) throw new TypertGatewayError("definition-invalid", endpoint, "its strict descriptor does not match the registered endpoint");
	for (const parameter of descriptor.parameters) requireStrictCodec(parameter.codec, endpoint, parameter.wire);
	if (descriptor.invocation.kind === "context") requireStrictCodec(descriptor.invocation.codec, endpoint, descriptor.invocation.wire);
	requireStrictCodec(descriptor.result, endpoint, "result");
}
function requireStrictCodec(codec, endpoint, field) {
	if (codec.mode !== "strict") throw new TypertGatewayError("definition-invalid", endpoint, `wire field ${JSON.stringify(field)} has no strict codec`, { field });
}
function assertExactArguments(args, descriptor, endpoint) {
	const expected = new Set(descriptor.parameters.map((parameter) => parameter.wire));
	if (descriptor.invocation.kind === "context") expected.add(descriptor.invocation.wire);
	const extra = Reflect.ownKeys(args).filter((key) => typeof key !== "string" || !expected.has(key));
	const acceptsMissing = new Set(descriptor.parameters.filter((parameter) => parameter.source === "json" && parameter.acceptsUndefined === true).map((parameter) => parameter.wire));
	const missing = [...expected].filter((key) => !Object.hasOwn(args, key) && !acceptsMissing.has(key));
	if (extra.length === 0 && missing.length === 0) return;
	const clauses = [];
	if (missing.length > 0) clauses.push(`missing ${missing.map((key) => JSON.stringify(key)).join(", ")}`);
	if (extra.length > 0) clauses.push(`unexpected ${extra.map((key) => JSON.stringify(String(key))).join(", ")}`);
	throw new TypertGatewayError("arguments-invalid", endpoint, `args fields do not match the descriptor: ${clauses.join("; ")}`);
}
async function resolveReceiverContext(ctx, typert, descriptor, args, endpoint) {
	if (descriptor.invocation.kind === "direct") return ctx;
	const invocation = descriptor.invocation;
	const invocationCodec = invocation.codec;
	requireStrictCodec(invocationCodec, endpoint, invocation.wire);
	const provider = typert.contexts.getHost(invocation.context);
	if (provider === void 0) throw new TypertGatewayError("context-unavailable", endpoint, `Context provider ${JSON.stringify(invocation.context)} is unavailable`);
	if (provider.wire !== invocation.wire || provider.wireTypeSymbol !== invocationCodec.typeSymbol) throw new TypertGatewayError("provider-mismatch", endpoint, `Context provider ${JSON.stringify(invocation.context)} does not match its strict descriptor`, { field: invocation.wire });
	const identity = decode(invocationCodec, args[invocation.wire], endpoint, invocation.wire);
	let resolved;
	try {
		resolved = await provider.resolve(identity);
	} catch (cause) {
		if (cause instanceof TypertLookupFailure) throw cause;
		throw new TypertGatewayError("context-failed", endpoint, `Context provider ${JSON.stringify(invocation.context)} failed`, {
			cause,
			field: invocation.wire
		});
	}
	if (resolved === void 0) throw new TypertGatewayError("context-not-found", endpoint, `Context provider ${JSON.stringify(invocation.context)} did not resolve the requested identity`, { field: invocation.wire });
	return resolved;
}
async function resolveParameter(typert, parameter, args, endpoint) {
	if (!Object.hasOwn(args, parameter.wire)) return void 0;
	const parameterCodec = parameter.codec;
	requireStrictCodec(parameterCodec, endpoint, parameter.wire);
	const value = decode(parameterCodec, args[parameter.wire], endpoint, parameter.wire);
	if (parameter.source === "json") return value;
	const lookup = parameter.lookup;
	if (lookup === void 0) throw new TypertGatewayError("lookup-unavailable", endpoint, `lookup parameter ${JSON.stringify(parameter.name)} has no provider key`);
	const provider = typert.lookups.get(lookup);
	if (provider === void 0) throw new TypertGatewayError("lookup-unavailable", endpoint, `lookup provider ${JSON.stringify(lookup)} is unavailable`, { details: { lookup } });
	if (provider.wire !== parameter.wire || provider.wireTypeSymbol !== parameterCodec.typeSymbol) throw new TypertGatewayError("provider-mismatch", endpoint, `lookup provider ${JSON.stringify(lookup)} does not match its strict descriptor`, {
		details: { lookup },
		field: parameter.wire
	});
	let resolved;
	try {
		resolved = await provider.resolve(value);
	} catch (cause) {
		if (cause instanceof TypertLookupFailure) throw cause;
		throw new TypertGatewayError("lookup-failed", endpoint, `lookup provider ${JSON.stringify(lookup)} failed`, {
			cause,
			details: { lookup },
			field: parameter.wire
		});
	}
	if (resolved === void 0) throw new TypertGatewayError("lookup-not-found", endpoint, `lookup provider ${JSON.stringify(lookup)} did not resolve the requested identity`, {
		details: { lookup },
		field: parameter.wire
	});
	return resolved;
}
function validateBinding(receiver, descriptor, endpoint) {
	const original = originalOf(receiver);
	const binding = Reflect.get(original, "typertRemote");
	if (!isObject(binding) || Reflect.get(binding, "service") !== original || Reflect.get(binding, "serviceKey") !== descriptor.service || Reflect.get(binding, "namespace") !== descriptor.namespace) throw new TypertGatewayError("binding-invalid", endpoint, `Service ${JSON.stringify(descriptor.service)} has an inconsistent typertRemote binding`);
}
function originalOf(receiver) {
	const original = Reflect.get(receiver, symbols.original);
	return isObject(original) ? original : receiver;
}
function decode(codec, value, endpoint, field) {
	try {
		const decoded = codec.schema.parse(value);
		if (decoded !== void 0) assertJsonValue(decoded, /* @__PURE__ */ new Set());
		return decoded;
	} catch (cause) {
		throw new TypertGatewayError("input-invalid", endpoint, `wire field ${JSON.stringify(field)} failed strict validation`, {
			cause,
			field
		});
	}
}
function encodeResult(codec, value, endpoint) {
	try {
		const encoded = codec.schema.parse(value);
		if (encoded !== void 0) assertJsonValue(encoded, /* @__PURE__ */ new Set());
		return encoded;
	} catch (cause) {
		throw new TypertGatewayError("result-invalid", endpoint, "result failed strict validation", {
			cause,
			field: "result"
		});
	}
}
function cancelled(endpoint, reason) {
	return new TypertGatewayError("cancelled", endpoint, "invocation was cancelled", { cause: reason });
}
function remoteFailure(error) {
	if (isTypertRemoteFailure(error)) return error.failure;
	if (error instanceof TypertGatewayError) return {
		code: error.code,
		message: error.message,
		details: error.details
	};
	if (isRemoteFailure(error)) return error;
	return {
		code: "internal",
		message: error instanceof Error ? error.message : String(error),
		details: {}
	};
}
function isRemoteFailure(value) {
	return isPlainObject(value) && typeof value.code === "string" && typeof value.message === "string" && isPlainObject(value.details);
}
function assertJsonValue(value, ancestors) {
	if (value === null || typeof value === "string" || typeof value === "boolean") return;
	if (typeof value === "number") {
		if (Number.isFinite(value)) return;
		throw new TypeError("non-finite number is not JSON-safe");
	}
	if (!isObject(value)) throw new TypeError(`${typeof value} is not JSON-safe`);
	if (ancestors.has(value)) throw new TypeError("cyclic value is not JSON-safe");
	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			if (Object.getOwnPropertySymbols(value).length !== 0 || Object.keys(value).length !== value.length) throw new TypeError("sparse or decorated array is not JSON-safe");
			for (let index = 0; index < value.length; index += 1) {
				if (!Object.hasOwn(value, index)) throw new TypeError("sparse array is not JSON-safe");
				assertJsonValue(value[index], ancestors);
			}
			return;
		}
		if (!isPlainObject(value) || Object.getOwnPropertySymbols(value).length !== 0) throw new TypeError("non-plain or symbol-decorated object is not JSON-safe");
		for (const key of Reflect.ownKeys(value)) {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (descriptor === void 0 || !descriptor.enumerable || !("value" in descriptor)) throw new TypeError("non-data property is not JSON-safe");
			assertJsonValue(descriptor.value, ancestors);
		}
	} finally {
		ancestors.delete(value);
	}
}
function isPlainObject(value) {
	if (!isObject(value) || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === null || prototype === Object.prototype;
}
function isObject(value) {
	return typeof value === "object" && value !== null || typeof value === "function";
}
//#endregion
export { NATIVE_LEGACY_API_ENDPOINTS, NATIVE_TYPERT_REMOTE_ENDPOINTS, NATIVE_TYPERT_REMOTE_OWNERS, TypertGatewayError, TypertGatewayService, TypertGatewayService as default, createTypertGatewayDispatcher };
