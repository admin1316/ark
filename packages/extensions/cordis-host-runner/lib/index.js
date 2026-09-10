import { Context, Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { scopeOf } from "@deepseek-ai/dsh-scope";
import { assertSupportedJsonSchema, defineTool, validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";
import { snapshotJsonValue } from "@deepseek-ai/dsh-session";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { Script, createContext, runInContext } from "node:vm";
//#region lib/types/guard.js
/**
* The registration boundary between a sandboxed host half and the real runtime: ParameterSchemaSpec
* normalization + validation with teaching errors, the marker-guarded `harness.defineTool` /
* `harness.registerTool` pair, the SANDBOX CONTEXT
* FAÇADE a running plugin's `apply` receives in place of the real `ctx`, and the plugin-shape
* helpers the run lifecycle narrows sandbox return values with. The façade is a whitelist of
* lifecycle-safe verbs and declared services; framework internals and context-valued service
* returns are denied.
*
* VM-realm schemas and canonical values are rebuilt as host objects, while rendered content and
* presentation metadata are shape-checked before entering the registry. Common JSON-Schema spellings are normalized when they
* have one meaning; invalid vocabulary fails during registration with a teaching error.
* @module @deepseek-ai/dsh-cordis-host-runner/guard
*/
const DYNAMIC_TOOL = Symbol("cordis-host-runner.dynamic-tool");
const SCHEMA_TYPES = new Set([
	"string",
	"number",
	"integer",
	"boolean",
	"null",
	"object",
	"array",
	"json"
]);
const VALID_TYPES = "'string' | 'number' | 'integer' | 'boolean' | 'null' | 'object' | 'array' | 'json'";
const ANNOTATION_KEYS = [
	"description",
	"title",
	"default",
	"examples"
];
function isPlainRecord(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === null || typeof prototype === "object" && Object.getPrototypeOf(prototype) === null && hasIntrinsicConstructor(prototype, "Object");
}
/** Whether a realm-owned intrinsic prototype is backed by its native constructor. */
function hasIntrinsicConstructor(prototype, name) {
	const constructor = Object.getOwnPropertyDescriptor(prototype, "constructor")?.value;
	if (typeof constructor !== "function") return false;
	try {
		return constructor.name === name && constructor.prototype === prototype && Function.prototype.toString.call(constructor) === `function ${name}() { [native code] }`;
	} catch {
		return false;
	}
}
/** Whether an array uses one realm's intrinsic Array prototype rather than a subclass. */
function hasPlainArrayPrototype(value) {
	const prototype = Object.getPrototypeOf(value);
	if (!Array.isArray(prototype) || !hasIntrinsicConstructor(prototype, "Array")) return false;
	const objectPrototype = Object.getPrototypeOf(prototype);
	return typeof objectPrototype === "object" && objectPrototype !== null && Object.getPrototypeOf(objectPrototype) === null && hasIntrinsicConstructor(objectPrototype, "Object");
}
/** Whether a schema list is a dense intrinsic array with no JSON-invisible decorations. */
function isDensePlainArray(value) {
	if (!Array.isArray(value) || !hasPlainArrayPrototype(value) || Reflect.ownKeys(value).length !== value.length + 1) return false;
	for (let index = 0; index < value.length; index++) if (!Object.hasOwn(value, index)) return false;
	return true;
}
/** Reject schema records whose declarations would disappear from object enumeration. */
function assertSchemaContainerKeys(value, path) {
	if (Reflect.ownKeys(value).some((key) => typeof key !== "string" || !Object.prototype.propertyIsEnumerable.call(value, key))) throw new Error(`harness.defineTool ${path} must contain only own enumerable string keys`);
}
/** Materialize realm-foreign lossless JSON without allowing JSON.stringify coercions; `path` carries the caller's own error prefix. */
function cloneJson(value, path) {
	const ancestors = /* @__PURE__ */ new Set();
	let root;
	const assign = (destination, item) => {
		if (destination.kind === "root") {
			root = item;
			return;
		}
		if (destination.kind === "array") {
			destination.target[destination.index] = item;
			return;
		}
		Object.defineProperty(destination.target, destination.key, {
			value: item,
			enumerable: true,
			configurable: true,
			writable: true
		});
	};
	const reject = (at) => {
		throw new Error(`${at} must be lossless JSON data (objects, arrays, strings, numbers, booleans, null) — not a class instance, function, Map/Set, Date, or undefined. Return a plain object built from the values you need, or \`return null\` when the caller needs no value back.`);
	};
	const tasks = [{
		kind: "visit",
		value,
		path,
		destination: { kind: "root" }
	}];
	for (let task = tasks.pop(); task !== void 0; task = tasks.pop()) {
		if (task.kind === "leave") {
			ancestors.delete(task.source);
			continue;
		}
		if (task.kind === "array-item") {
			if (!Object.hasOwn(task.source, task.index)) reject(task.path);
			tasks.push({
				kind: "visit",
				value: task.source[task.index],
				path: `${task.path}[${task.index}]`,
				destination: {
					kind: "array",
					target: task.target,
					index: task.index
				}
			});
			continue;
		}
		const current = task.value;
		if (current === null || typeof current === "string" || typeof current === "boolean") {
			assign(task.destination, current);
			continue;
		}
		if (typeof current === "number") {
			if (!Number.isFinite(current) || Object.is(current, -0)) reject(task.path);
			assign(task.destination, current);
			continue;
		}
		if (typeof current !== "object" || ancestors.has(current)) reject(task.path);
		if (Array.isArray(current)) {
			if (!hasPlainArrayPrototype(current) || Reflect.ownKeys(current).length !== current.length + 1) reject(task.path);
			const output = [];
			assign(task.destination, output);
			ancestors.add(current);
			tasks.push({
				kind: "leave",
				source: current
			});
			for (let index = current.length - 1; index >= 0; index--) tasks.push({
				kind: "array-item",
				source: current,
				index,
				path: task.path,
				target: output
			});
			continue;
		}
		if (!isPlainRecord(current)) reject(task.path);
		const record = current;
		if (Reflect.ownKeys(record).some((key) => typeof key !== "string" || !Object.prototype.propertyIsEnumerable.call(record, key))) reject(task.path);
		const output = {};
		assign(task.destination, output);
		ancestors.add(record);
		tasks.push({
			kind: "leave",
			source: record
		});
		const entries = Object.entries(record);
		for (let index = entries.length - 1; index >= 0; index--) {
			const entry = entries[index];
			/* v8 ignore next -- the loop is bounded by the captured entry count. */
			if (entry === void 0) continue;
			tasks.push({
				kind: "visit",
				value: entry[1],
				path: `${task.path}.${entry[0]}`,
				destination: {
					kind: "object",
					target: output,
					key: entry[0]
				}
			});
		}
	}
	return root;
}
/** Copy and realm-materialize the shared annotation vocabulary. */
function copyAnnotations(value, output, path) {
	if (Object.hasOwn(value, "description")) output.description = value.description;
	if (Object.hasOwn(value, "title")) output.title = value.title;
	if (Object.hasOwn(value, "default")) output.default = cloneJson(value.default, `harness.defineTool ${path}.default`);
	if (Object.hasOwn(value, "examples")) output.examples = cloneJson(value.examples, `harness.defineTool ${path}.examples`);
}
/** Reject sandbox schema keys that the unified DSL would otherwise ignore. */
function assertSchemaKeys(value, path, allowed) {
	assertSchemaContainerKeys(value, path);
	for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`harness.defineTool ${path}.${key} is not supported by the unified schema DSL`);
}
/**
* Normalize a sandbox-provided `parameters` value into a fresh host-realm
* ParameterSchemaSpec. A raw JSON-Schema object wrapper retains its open root
* default, while the direct DSL is already an implicit open property map.
*/
function normalizeParameterSchemaSpec(value, path = "parameters") {
	if (!isPlainRecord(value)) throw new Error(`harness.defineTool ${path} must be a ParameterSchemaSpec object`);
	if (value.type === "object") {
		assertSchemaKeys(value, path, [
			"type",
			"properties",
			"required",
			"additionalProperties",
			...ANNOTATION_KEYS
		]);
		if (!isPlainRecord(value.properties)) throw new Error(`harness.defineTool ${path}.properties must be an object of schemas`);
		if (Object.hasOwn(value, "additionalProperties") && value.additionalProperties !== true) throw new Error(`harness.defineTool ${path}.additionalProperties must be true or omitted because the implicit parameter root is open`);
		if (Object.hasOwn(value, "required") && value.required === void 0) throw new Error(`harness.defineTool ${path}.required must be an array of declared property names`);
		const required = normalizeRequiredNames(value.required, value.properties, `${path}.required`);
		const rootAnnotations = {};
		copyAnnotations(value, rootAnnotations, path);
		return {
			spec: normalizePropertyMap(value.properties, path, required, true),
			...Object.keys(rootAnnotations).length === 0 ? {} : { rootAnnotations }
		};
	}
	return { spec: normalizePropertyMap(value, path, /* @__PURE__ */ new Set(), false) };
}
/** Validate raw required names and return their lookup set. */
function normalizeRequiredNames(value, properties, path) {
	if (value === void 0) return /* @__PURE__ */ new Set();
	if (!isDensePlainArray(value)) throw new Error(`harness.defineTool ${path} must be an array of declared property names`);
	const names = /* @__PURE__ */ new Set();
	for (let index = 0; index < value.length; index++) {
		const name = value[index];
		if (typeof name !== "string") throw new Error(`harness.defineTool ${path} must be an array of declared property names`);
		names.add(name);
		if (!Object.hasOwn(properties, name)) throw new Error(`harness.defineTool ${path} names undeclared property ${JSON.stringify(name)}`);
	}
	return names;
}
/** Install one normalized node without `__proto__` assignment semantics. */
function assignNormalizedValue(destination, value) {
	if (destination.kind === "property") Object.defineProperty(destination.target, destination.key, {
		value,
		enumerable: true,
		configurable: true,
		writable: true
	});
	else if (destination.kind === "item") destination.target.items = value;
	else destination.target[destination.index] = value;
}
/** Install one normalized property map at its root or containing object. */
function assignNormalizedMap(destination, value) {
	if (destination.kind === "root") destination.holder.value = value;
	else destination.target.properties = value;
}
/** Normalize one implicit property map and all descendants with explicit work frames. */
function normalizePropertyMap(entries, path, requiredNames, raw) {
	const holder = {};
	const ancestors = /* @__PURE__ */ new Set();
	const tasks = [{
		kind: "map",
		entries,
		path,
		requiredNames,
		raw,
		destination: {
			kind: "root",
			holder
		}
	}];
	for (let task = tasks.pop(); task !== void 0; task = tasks.pop()) {
		if (task.kind === "leave") {
			ancestors.delete(task.value);
			continue;
		}
		if (task.kind === "map") {
			if (ancestors.has(task.entries)) throw new Error(`harness.defineTool ${task.path} is circular`);
			assertSchemaContainerKeys(task.entries, task.path);
			ancestors.add(task.entries);
			const spec = {};
			assignNormalizedMap(task.destination, spec);
			tasks.push({
				kind: "leave",
				value: task.entries
			});
			const mapEntries = Object.entries(task.entries);
			for (let index = mapEntries.length - 1; index >= 0; index--) {
				const entry = mapEntries[index];
				/* v8 ignore next -- the loop is bounded by the captured entry count. */
				if (entry === void 0) continue;
				tasks.push({
					kind: "value",
					value: entry[1],
					path: `${task.path}.${entry[0]}`,
					forceRequired: task.requiredNames.has(entry[0]),
					raw: task.raw,
					parameterProperty: true,
					destination: {
						kind: "property",
						target: spec,
						key: entry[0]
					}
				});
			}
			continue;
		}
		const { value, path } = task;
		if (!isPlainRecord(value)) throw new Error(`harness.defineTool ${path} must be a ParameterSchemaSpec property object`);
		assertSchemaContainerKeys(value, path);
		if (ancestors.has(value)) throw new Error(`harness.defineTool ${path} is circular`);
		ancestors.add(value);
		const requiredKey = task.parameterProperty && !task.raw ? ["required"] : [];
		if (task.parameterProperty && task.raw && Object.hasOwn(value, "required") && value.type !== "object") throw new Error(`harness.defineTool ${path}.required belongs to the containing raw object schema`);
		if (task.parameterProperty && !task.raw && Object.hasOwn(value, "required") && value.required !== true) throw new Error(`harness.defineTool ${path}.required must be true when present`);
		const prop = {};
		assignNormalizedValue(task.destination, prop);
		tasks.push({
			kind: "leave",
			value
		});
		if (task.forceRequired || value.required === true) prop.required = true;
		copyAnnotations(value, prop, path);
		if (Object.hasOwn(value, "oneOf")) {
			assertSchemaKeys(value, path, [
				"oneOf",
				...requiredKey,
				...ANNOTATION_KEYS
			]);
			if (!isDensePlainArray(value.oneOf) || value.oneOf.length < 2) throw new Error(`harness.defineTool ${path}.oneOf must contain at least two schemas`);
			const oneOf = [];
			prop.oneOf = oneOf;
			for (let index = value.oneOf.length - 1; index >= 0; index--) tasks.push({
				kind: "value",
				value: value.oneOf[index],
				path: `${path}.oneOf[${index}]`,
				forceRequired: false,
				raw: task.raw,
				parameterProperty: false,
				destination: {
					kind: "one-of",
					target: oneOf,
					index
				}
			});
			continue;
		}
		if (task.raw && !Object.hasOwn(value, "type")) {
			assertSchemaKeys(value, path, ANNOTATION_KEYS);
			prop.type = "json";
			continue;
		}
		if (!SCHEMA_TYPES.has(value.type) || task.raw && value.type === "json") throw new Error(`harness.defineTool ${path} must declare a valid type: ${VALID_TYPES} (got ${JSON.stringify(value.type)})`);
		const type = value.type;
		prop.type = type;
		switch (type) {
			case "object":
				assertSchemaKeys(value, path, [
					"type",
					"properties",
					"additionalProperties",
					...requiredKey,
					...task.raw ? ["required"] : [],
					...ANNOTATION_KEYS
				]);
				if (!task.raw && (!Object.hasOwn(value, "additionalProperties") || typeof value.additionalProperties !== "boolean")) throw new Error(`harness.defineTool ${path}.additionalProperties must be explicitly true or false`);
				if (task.raw && Object.hasOwn(value, "additionalProperties") && typeof value.additionalProperties !== "boolean") throw new Error(`harness.defineTool ${path}.additionalProperties must be a boolean`);
				if (task.raw && Object.hasOwn(value, "required") && value.required === void 0) throw new Error(`harness.defineTool ${path}.required must be an array of declared property names`);
				prop.additionalProperties = task.raw ? value.additionalProperties ?? true : value.additionalProperties;
				if (Object.hasOwn(value, "properties")) {
					const properties = value.properties;
					if (!isPlainRecord(properties)) throw new Error(`harness.defineTool ${path}.properties must be an object of schemas`);
					const nestedRequired = task.raw ? normalizeRequiredNames(value.required, properties, `${path}.required`) : /* @__PURE__ */ new Set();
					tasks.push({
						kind: "map",
						entries: properties,
						path: `${path}.properties`,
						requiredNames: nestedRequired,
						raw: task.raw,
						destination: {
							kind: "properties",
							target: prop
						}
					});
				} else if (task.raw && value.required !== void 0) normalizeRequiredNames(value.required, {}, `${path}.required`);
				break;
			case "array":
				assertSchemaKeys(value, path, [
					"type",
					"items",
					...requiredKey,
					...ANNOTATION_KEYS
				]);
				if (Object.hasOwn(value, "items")) tasks.push({
					kind: "value",
					value: value.items,
					path: `${path}.items`,
					forceRequired: false,
					raw: task.raw,
					parameterProperty: false,
					destination: {
						kind: "item",
						target: prop
					}
				});
				break;
			case "string":
			case "number":
			case "integer":
			case "boolean":
			case "null":
				assertSchemaKeys(value, path, [
					"type",
					"enum",
					"const",
					...requiredKey,
					...ANNOTATION_KEYS
				]);
				if (Object.hasOwn(value, "enum")) {
					if (!isDensePlainArray(value.enum) || value.enum.length === 0) throw new Error(`harness.defineTool ${path}.enum must be a non-empty array`);
					prop.enum = cloneJson(value.enum, `harness.defineTool ${path}.enum`);
				}
				if (Object.hasOwn(value, "const")) prop.const = cloneJson(value.const, `harness.defineTool ${path}.const`);
				break;
			case "json":
				assertSchemaKeys(value, path, [
					"type",
					...requiredKey,
					...ANNOTATION_KEYS
				]);
				break;
			/* v8 ignore next 2 -- SCHEMA_TYPES narrows this closed switch before dispatch. */
			default: throw new Error(`harness.defineTool ${path} must declare a valid type: ${VALID_TYPES}`);
		}
	}
	/* v8 ignore next -- the root map task assigns before scheduling descendants. */
	return holder.value ?? {};
}
function markDynamicTool(tool) {
	Object.defineProperty(tool, DYNAMIC_TOOL, { value: true });
	return tool;
}
function assertDynamicTool(tool) {
	if (!isPlainRecord(tool) || tool[DYNAMIC_TOOL] !== true) throw new Error("dynamic tool registration must use a tool returned by harness.defineTool(...)");
}
/**
* Structurally a content block, checked AFTER the JSON round-trip: a plain
* object carrying a string `type` tag. Deliberately nothing deeper — the
* ContentBlock union is merge-extensible (an unknown tag must pass), and every
* downstream consumer dispatches on `type` and falls through unknowns.
*/
function isContentBlockShape(value) {
	return isPlainRecord(value) && typeof value.type === "string";
}
/**
* How much of an invalid execute return the teaching error echoes back — a
* huge blob would burn the model turn the error is trying to save.
*/
const RETURN_PREVIEW_LIMIT = 120;
/**
* Compact JSON preview of an invalid execute return for the teaching error
* (`String(…)` for the un-stringifiable undefined case), truncated to
* {@link RETURN_PREVIEW_LIMIT}.
*/
function describeReturn(value) {
	const json = JSON.stringify(value);
	return json.length > RETURN_PREVIEW_LIMIT ? `${json.slice(0, RETURN_PREVIEW_LIMIT)}…` : json;
}
/**
* Validate and host-materialize a sandbox renderer's content blocks.
*/
function assertRenderedContent(value) {
	if (Array.isArray(value) && value.every(isContentBlockShape)) return value;
	throw new Error(`output.render returned ${describeReturn(value)} — it must return an ARRAY of content blocks:\n  ✓ return [{ type: 'text', text: String(value) }]`);
}
/**
* The `harness.defineTool` handed into the sandbox: the real DSL, with `parameters` normalized
* into a fresh host-realm ParameterSchemaSpec (raw object wrappers unwrapped,
* required arrays mapped, and explicit DSL object openness enforced) and the tool's `execute` return normalized into the host realm
* via a JSON round-trip. Non-JSON or wrong-shape output fails that call instead of poisoning
* the session log.
* @param options - the standard `defineTool` options; `parameters` may be the ParameterSchemaSpec DSL or a JSON-Schema-style wrapper.
* @returns the marker-tagged definition `harness.registerTool` (and the guarded `ctx.tools.register`) accepts.
*/
function sandboxDefineTool(options) {
	if (!isPlainRecord(options)) throw new Error("harness.defineTool options must be an object");
	const normalized = normalizeParameterSchemaSpec(options.parameters);
	if (!isPlainRecord(options.output)) throw new Error("harness.defineTool output must declare { schema, render, presentationMeta? }");
	const output = options.output;
	if (typeof output.render !== "function") throw new Error("harness.defineTool output.render must be a function");
	if (output.presentationMeta !== void 0 && typeof output.presentationMeta !== "function") throw new Error("harness.defineTool output.presentationMeta must be a function when present");
	if (typeof options.execute !== "function") throw new Error("harness.defineTool execute must be a function");
	const schema = cloneJson(output.schema, "harness.defineTool output.schema");
	const rawExecute = options.execute;
	const rawRender = output.render;
	const rawPresentationMeta = output.presentationMeta;
	const tool = defineTool({
		...options,
		parameters: normalized.spec,
		output: {
			schema,
			render(args, value) {
				return assertRenderedContent(cloneJson(rawRender(args, value), "harness.defineTool output.render result"));
			},
			...rawPresentationMeta !== void 0 ? { presentationMeta(args, value) {
				return cloneJson(rawPresentationMeta(args, value), "harness.defineTool output.presentationMeta result");
			} } : {}
		},
		async execute(args, exec) {
			return cloneJson(await rawExecute(args, exec), "harness.defineTool execute result");
		}
	});
	const parameters = {
		...tool.parameters,
		...normalized.rootAnnotations
	};
	assertSupportedJsonSchema(parameters);
	return markDynamicTool({
		...tool,
		parameters
	});
}
/**
* The `harness.registerTool` handed into the sandbox: registers a
* marker-verified dynamic tool on the given context's registry.
* @param ctx - the (guarded) context whose `tools` service receives the tool.
* @param tool - a definition produced by {@link sandboxDefineTool}; anything else is rejected.
* @returns the registry disposer for the registration.
*/
function sandboxRegisterTool(ctx, tool) {
	assertDynamicTool(tool);
	return ctx.tools.register(tool);
}
/**
* The verbs a running host half may reach through the sandbox `ctx` façade, beyond its injected
* services. `on`/`once` observe events, `provide` exposes a service to other packages, and the
* timer helpers schedule work — each a fiber effect that unwinds when the package stops.
*/
const CTX_VERBS = new Set([
	"effect",
	"on",
	"once",
	"provide",
	"timeout",
	"interval",
	"setTimeout",
	"setInterval",
	"throttle",
	"debounce"
]);
const TIMER_VERBS = new Set([
	"timeout",
	"interval",
	"setTimeout",
	"setInterval",
	"throttle",
	"debounce"
]);
/**
* The tool-registry façade: `register` (marker-guarded) plus READ-ONLY
* metadata (`schemas`, and `get` returning a schema view, never the live
* `ToolDefinition`). Exposing the raw definition would hand package code the
* tool's `execute` function, letting it call another tool directly and bypass
* `ToolRuntime.execute` — identity protection, pre-policy, monotonic guards,
* around dispatch, post-policy, final observation, and result normalization. So `get` returns the same
* name/description/parameters view as `schemas()`, and nothing invocable.
*/
function sandboxTools(ctx) {
	return {
		register: (tool) => sandboxRegisterTool(ctx, tool),
		schemas: () => ctx.tools.schemas(scopeOf(ctx)),
		get: (name) => ctx.tools.schemas(scopeOf(ctx)).find((schema) => schema.name === name)
	};
}
/**
* Reject any injected-service return that is a cordis `Context`. Harness
* services return data, never a context; a value that is one would be a
* fresh, unguarded handle back into the runtime — the exact escape the façade
* exists to close — so it fails loud instead of reaching sandbox code.
*/
function denyContext(value, service, reportFailure) {
	if (value instanceof Context) return rejectGuard(reportFailure, `service "${service}" returned a cordis Context, which the sandbox does not expose. Operate through your own plugin ctx (ctx.on / ctx.provide / ctx.tools.register) and the services you inject — never another context.`);
	return value;
}
/**
* Wrap an injected service so its methods forward to the real instance but
* their return values pass through {@link denyContext}. Non-function members
* (plain data) pass through as-is; a returned Promise is guarded on resolve.
*/
function guardedService(service, name, reportFailure) {
	return new Proxy(service, { get(target, prop) {
		const value = Reflect.get(target, prop, target);
		if (typeof value !== "function") return denyContext(value, name, reportFailure);
		return (...args) => {
			const result = Reflect.apply(value, target, args);
			if (result instanceof Promise) return result.then((v) => denyContext(v, name, reportFailure));
			return denyContext(result, name, reportFailure);
		};
	} });
}
/**
* The service names a plugin declared in `inject`, as a lookup set. Whatever
* declaration style the plugin used — an `inject: ['bash', 'tools']` array or
* the `{ required, optional }` object form — cordis resolves it into a single
* name-keyed map on the fiber before `apply` runs (`{ bash: null, tools: null }`),
* so the gate just reads that map's keys. A host half may reach only the services
* it declared — that is what lets cordis park it when a declared provider
* goes away.
*/
function declaredInjects(ctx) {
	return new Set(Object.keys(ctx.fiber.inject));
}
/**
* Whitelist context for running host halves: lifecycle-safe verbs, guarded
* tools, optional `ctx.get()` lookup, and declared-service property access.
* Framework plumbing is denied, and service methods cannot return a Context.
*/
function sandboxContext(ctx, reportFailure) {
	const tools = sandboxTools(ctx);
	const declared = declaredInjects(ctx);
	const denyRead = (prop) => {
		if (ctx.get(prop) !== void 0) return rejectGuard(reportFailure, `service "${prop}" is not injected. Declare it: inject: ['${prop}', …] on your plugin, so cordis parks this dynamic package if the provider later goes away.`);
		return rejectGuard(reportFailure, `sandbox ctx does not expose "${prop}". Available: ctx.tools.register / ctx.on / ctx.provide / the timer helpers after injecting timer, and any service you declared in inject. Framework internals (root, fiber, registry, extend, plugin, …) are withheld by design.`);
	};
	const readService = (name, requireDeclaration) => {
		if (name === "tools") return tools;
		if (requireDeclaration && !declared.has(name)) return denyRead(name);
		const service = denyContext(ctx.get(name), name, reportFailure);
		if (service === null || typeof service !== "object" && typeof service !== "function") return service;
		return guardedService(service, name, reportFailure);
	};
	const get = (name) => readService(name, false);
	return new Proxy({}, {
		get(_target, prop) {
			if (prop === "tools") return tools;
			if (prop === "get") return get;
			if (typeof prop !== "string") return void 0;
			if (CTX_VERBS.has(prop)) return (...args) => {
				if (TIMER_VERBS.has(prop) && !declared.has("timer")) return denyRead("timer");
				const method = ctx[prop];
				return Reflect.apply(method, ctx, args);
			};
			return readService(prop, true);
		},
		set(_target, prop) {
			return rejectGuard(reportFailure, `sandbox ctx is read-only; cannot assign "${String(prop)}"`);
		},
		has: (_target, prop) => prop === "tools" || prop === "get" || typeof prop === "string" && (CTX_VERBS.has(prop) && (!TIMER_VERBS.has(prop) || declared.has("timer")) || declared.has(prop))
	});
}
/**
* Narrow an arbitrary sandbox return value to a runnable cordis plugin: a
* function, or an object with an `apply` function. (A bare function passes the
* first arm, so the object arm never sees `Function.prototype.apply`.)
* @param value - whatever the host half returned.
* @returns whether the value can be started via `ctx.plugin`.
*/
function isPlugin(value) {
	if (typeof value === "function") return true;
	return typeof value === "object" && value !== null && typeof value.apply === "function";
}
/**
* Wrap a plugin so `apply` receives the sandbox context while preserving injection metadata.
* @param plugin - the plugin the host half returned.
* @param reportFailure - reports a guard rejection to the owning Agent.
* @returns an equivalent plugin whose `apply` sees the sandbox context façade.
*/
function guardedPlugin(plugin, reportFailure) {
	if (typeof plugin === "function") {
		const functionPlugin = plugin;
		return {
			name: pluginName(plugin),
			apply(ctx, config) {
				return functionPlugin(sandboxContext(ctx, reportFailure), config);
			}
		};
	}
	const objectPlugin = plugin;
	return {
		...plugin,
		apply(ctx, config) {
			return objectPlugin.apply(sandboxContext(ctx, reportFailure), config);
		}
	};
}
function rejectGuard(reportFailure, message) {
	const error = new Error(message);
	reportFailure(error);
	throw error;
}
/**
* Display name for a running plugin: its `name` property, else anonymous.
* @param plugin - the plugin the host half returned.
* @returns the human-readable name used in run results and inspect output.
*/
function pluginName(plugin) {
	const named = plugin.name;
	if (typeof named === "string" && named.length > 0) return named;
	return "<anonymous>";
}
//#endregion
//#region lib/types/inspect-registry.js
/** Host registry for model-visible, read-only Cordis capability queries. */
/** Registry behind the model-facing inspect tools. */
var CordisInspectRegistryService = class extends Service {
	providers = /* @__PURE__ */ new Map();
	/** Register the process-global Host registry. */
	constructor(ctx) {
		super(ctx, "cordisInspect");
	}
	/**
	* Register one Host provider.
	* @param registration - Provider manifest and query implementation.
	* @returns A disposer that removes the provider when it is no longer owned.
	*/
	register(registration) {
		const manifest = validateManifest(registration.manifest);
		if (this.providers.has(manifest.id)) throw new Error(`Host Cordis inspect provider "${manifest.id}" is already registered`);
		const stored = {
			...registration,
			manifest
		};
		this.providers.set(manifest.id, stored);
		return () => {
			if (this.providers.get(manifest.id) === stored) this.providers.delete(manifest.id);
		};
	}
	/**
	* Return the complete Host provider directory.
	* @returns Serializable provider views in registration order.
	*/
	list() {
		return [...this.providers.values()].map((provider) => ({
			platform: "host",
			...provider.manifest,
			methods: [...provider.manifest.methods]
		}));
	}
	/**
	* Execute one Host provider query.
	* @param platform - Requested inspect platform; only `host` is supported.
	* @param providerId - Registered provider identity.
	* @param methodName - Provider method to invoke.
	* @param input - JSON input validated against the method schema.
	* @param agent - Session agent making the query.
	* @param signal - Cancellation signal for the query lifecycle.
	* @returns Schema-validated JSON provider output.
	*/
	async query(platform, providerId, methodName, input, agent, signal) {
		assertHostPlatform(platform);
		const registration = this.providers.get(providerId);
		if (registration === void 0) throw new Error(`Host Cordis inspect provider "${providerId}" is not registered`);
		const method = findMethod(registration.manifest, methodName);
		validateInput(providerId, method, input);
		signal.throwIfAborted();
		const data = await registration.query(methodName, input, {
			agent,
			signal
		});
		signal.throwIfAborted();
		return validateOutput(providerId, method, data);
	}
};
/** Retain a runtime boundary guard even though the current typed surface exposes only Host. */
function assertHostPlatform(platform) {
	if (platform !== "host") throw new Error(`Cordis inspect platform ${JSON.stringify(platform)} is not available`);
}
function validateManifest(manifest) {
	if (manifest.id.trim() === "") throw new Error("Cordis inspect provider id must not be empty");
	if (manifest.description.trim() === "") throw new Error(`Cordis inspect provider "${manifest.id}" needs a description`);
	const names = /* @__PURE__ */ new Set();
	const methods = manifest.methods.map((method) => {
		if (method.name.trim() === "") throw new Error(`Cordis inspect provider "${manifest.id}" has an empty method name`);
		if (names.has(method.name)) throw new Error(`Cordis inspect provider "${manifest.id}" repeats method "${method.name}"`);
		if (method.description.trim() === "") throw new Error(`Cordis inspect method ${manifest.id}.${method.name} needs a description`);
		assertSupportedJsonSchema(method.inputSchema);
		assertSupportedJsonSchema(method.outputSchema);
		names.add(method.name);
		return Object.freeze({ ...method });
	});
	return Object.freeze({
		...manifest,
		methods: Object.freeze(methods)
	});
}
function findMethod(manifest, name) {
	const method = manifest.methods.find((candidate) => candidate.name === name);
	if (method === void 0) throw new Error(`Cordis inspect provider "${manifest.id}" has no method "${name}"`);
	return method;
}
function validateInput(provider, method, input) {
	const violations = validateJsonSchemaValue(method.inputSchema, input ?? {}, "input");
	if (violations.length > 0) throw new Error(`Host Cordis inspect ${provider}.${method.name} rejected input: ${violations.join("; ")}`);
}
function validateOutput(provider, method, data) {
	const snapshot = snapshotJsonValue(data);
	if (snapshot === void 0) throw new Error(`Host Cordis inspect ${provider}.${method.name} returned a non-JSON value`);
	const violations = validateJsonSchemaValue(method.outputSchema, snapshot, "output");
	if (violations.length > 0) throw new Error(`Host Cordis inspect ${provider}.${method.name} returned invalid output: ${violations.join("; ")}`);
	return snapshot;
}
//#endregion
//#region lib/types/lifecycle.js
/**
* Host-half fiber lifecycle over the `cordis-dynamic` group: settle a
* sandbox-produced plugin as a child fiber (never leaving a failed fiber
* mounted), and report the services a settled-but-pending fiber still waits
* for. Stopping needs no helper — a host half unwinds through an ordinary
* awaited `fiber.dispose()`, because everything the plugin registered is an
* effect on its fiber.
* @module @deepseek-ai/dsh-cordis-host-runner/lifecycle
*/
/**
* Await the group, start and settle one guarded child, and dispose it before rethrowing any
* startup failure so a failed run never lingers. A valid unresolved inject may remain pending.
* @param group - the `cordis-dynamic` group fiber every host half hangs under.
* @param plugin - the plugin the sandbox returned; wrapped with the registration guard before starting.
* @param reportGuardFailure - reports post-activation Host guard rejections to the owning Agent.
* @returns the settled child fiber (possibly pending on unsatisfied `inject`).
*/
async function startHostHalf(group, plugin, reportGuardFailure) {
	await group.await();
	const fiber = group.ctx.plugin(guardedPlugin(plugin, reportGuardFailure));
	try {
		await fiber.await();
	} catch (error) {
		await fiber.dispose();
		const message = error instanceof Error ? error.message : String(error);
		if (message.includes("already registered")) throw new Error(`${message} — to REPLACE something an earlier dynamic package registered, first cordis_stop that package's id (find it with cordis_runtime_inspect what:"temporary"), then run the new version.`);
		throw error instanceof Error ? error : new Error(message);
	}
	return fiber;
}
/**
* The services a fiber declared in `inject` that do not exist yet — a settled
* fiber that is not active is waiting on exactly these (legal cordis
* semantics: it activates when the service appears).
* @param ctx - the context to resolve service existence against.
* @param fiber - the host-half fiber whose `inject` declarations are checked.
* @returns the missing service names, in declaration order.
*/
function missingServices(ctx, fiber) {
	return Object.keys(fiber.inject).filter((service) => ctx.get(service) === void 0);
}
//#endregion
//#region lib/types/registry.js
/** Process-local registry for model-authored Host plugins. */
/** Registry and opaque identity mints. */
var DynamicCordisRegistry = class {
	plugins = /* @__PURE__ */ new Map();
	nextPlugin = 1;
	nextPackage = 1;
	nextRun = 1;
	/**
	* Mint a semantic plugin ID without reusing a suffix.
	* @param prefix - The prefix input.
	* @returns The value produced by mint plugin id.
	*/
	mintPluginId(prefix) {
		let id;
		do
			id = `${prefix}-${this.nextPlugin++}`;
		while (this.plugins.has(id));
		return id;
	}
	/**
	* Mint an immutable package ID.
	* @returns The value produced by mint package id.
	*/
	mintPackageId() {
		return `pkg-${this.nextPackage++}`;
	}
	/**
	* Mint an activation ID.
	* @returns The value produced by mint plugin run id.
	*/
	mintPluginRunId() {
		return `run-${this.nextRun++}`;
	}
	/**
	* Add one stable plugin.
	* @param plugin - The plugin input.
	*/
	add(plugin) {
		this.plugins.set(plugin.pluginId, plugin);
	}
	/**
	* Read one plugin.
	* @param id - The id input.
	* @returns The value produced by get.
	*/
	get(id) {
		return this.plugins.get(id);
	}
	/**
	* Delete one plugin and all versions.
	* @param id - The id input.
	* @returns The value produced by delete.
	*/
	delete(id) {
		return this.plugins.delete(id);
	}
	/**
	* Read all plugins in creation order.
	* @returns The value produced by all.
	*/
	all() {
		return [...this.plugins.values()];
	}
	/**
	* Read one session's plugins in creation order.
	* @param sessionId - The session id input.
	* @returns The value produced by of session.
	*/
	ofSession(sessionId) {
		return this.all().filter((plugin) => plugin.sessionId === sessionId);
	}
};
//#endregion
//#region lib/types/steering.js
/** Model steering for post-activation Host guard failures. */
/**
* Render one failure's message and optional stack.
* @param failure - The failure input.
* @returns The value produced by format error details.
*/
function formatErrorDetails(failure) {
	return `message: ${failure.message}` + (failure.stack === void 0 ? "" : `\nstack:\n${failure.stack}`);
}
/**
* Steer the owner after a Host guard rejects runtime code.
* @param agents - The agents input.
* @param plugin - The plugin input.
* @param run - The run input.
* @param failure - The failure input.
*/
function steerGuardFailure(agents, plugin, run, failure) {
	const agent = agents?.get(plugin.sessionId);
	if (agent === void 0) return;
	agent.steer(createUserMessage({
		content: [{
			type: "text",
			text: `Cordis Host guard rejected runtime code in ${plugin.pluginId}/${run.packageId} (${run.pluginRunId}) after activation.\n${formatErrorDetails(failure)}\nThe Plugin remains running. Inspect it, define a corrected Package on the same Plugin, and activate the new Package with cordis_run mode:"update".`
		}],
		source: {
			kind: "plugin",
			plugin: "cordis-host-runner"
		}
	}));
}
//#endregion
//#region lib/types/queries.js
/** Source-free projections of the Host dynamic Cordis registry. */
/**
* Return the plugin only when the Agent owns it.
* @param registry - The registry input.
* @param agent - The agent input.
* @param pluginId - The plugin id input.
* @returns The value produced by owned plugin.
*/
function ownedPlugin(registry, agent, pluginId) {
	const plugin = registry.get(pluginId);
	return plugin?.sessionId === agent.id ? plugin : void 0;
}
/**
* Shared missing-plugin diagnostic.
* @param id - The id input.
* @returns The value produced by missing plugin message.
*/
function missingPluginMessage(id) {
	return `no dynamic plugin "${id}" in this process — it may have been removed or lost on DSH restart`;
}
/**
* Detached copy of one attempt.
* @param attempt - The attempt input.
* @returns The value produced by clone attempt.
*/
function cloneAttempt(attempt) {
	return {
		...attempt,
		host: {
			...attempt.host,
			waitingFor: [...attempt.host.waitingFor]
		},
		...attempt.error === void 0 ? {} : { error: { ...attempt.error } }
	};
}
function packageRows(plugin) {
	return [...plugin.packages.values()].map(({ packageId, name, purpose }) => ({
		packageId,
		name,
		purpose
	}));
}
function versionFields(plugin) {
	return {
		...plugin.currentPackageId === void 0 ? {} : { currentPackageId: plugin.currentPackageId },
		...plugin.nextPackageId === void 0 ? {} : { nextPackageId: plugin.nextPackageId }
	};
}
function activeRunOf(plugin) {
	return plugin.run === void 0 ? {} : { activeRun: {
		pluginRunId: plugin.run.pluginRunId,
		packageId: plugin.run.packageId
	} };
}
/**
* Process-wide source-free inventory.
* @param registry - The registry input.
* @returns The value produced by inventory rows.
*/
function inventoryRows(registry) {
	return registry.all().map((plugin) => ({
		pluginId: plugin.pluginId,
		agentId: plugin.sessionId,
		packages: packageRows(plugin),
		...versionFields(plugin),
		...activeRunOf(plugin),
		...plugin.latestRun === void 0 ? {} : { latestRun: cloneAttempt(plugin.latestRun) }
	}));
}
/**
* One Session's Host-rich snapshot.
* @param registry - The registry input.
* @param agent - The agent input.
* @returns The value produced by snapshot rows.
*/
function snapshotRows(registry, agent) {
	return registry.ofSession(agent.id).map((plugin) => ({
		pluginId: plugin.pluginId,
		...versionFields(plugin),
		packages: packageRows(plugin),
		...plugin.run === void 0 ? {} : { activeRun: {
			pluginRunId: plugin.run.pluginRunId,
			packageId: plugin.run.packageId,
			...plugin.run.fiber === void 0 ? {} : { fiber: plugin.run.fiber }
		} },
		...plugin.latestRun === void 0 ? {} : { latestRun: cloneAttempt(plugin.latestRun) }
	}));
}
/**
* Source-free context for one explicit plugin reference.
* @param registry - The registry input.
* @param agent - The agent input.
* @param pluginId - The plugin id input.
* @returns The value produced by reference for.
*/
function referenceFor(registry, agent, pluginId) {
	const plugin = ownedPlugin(registry, agent, pluginId);
	if (plugin === void 0) return void 0;
	const packageId = plugin.nextPackageId ?? plugin.currentPackageId ?? [...plugin.packages.keys()].at(-1);
	if (packageId === void 0) return void 0;
	const definition = plugin.packages.get(packageId);
	if (definition === void 0) return void 0;
	return {
		pluginId,
		packageId,
		name: definition.name,
		purpose: definition.purpose,
		...versionFields(plugin),
		...activeRunOf(plugin),
		...plugin.latestRun === void 0 ? {} : { latestRun: cloneAttempt(plugin.latestRun) }
	};
}
/**
* One summary per owned plugin.
* @param registry - The registry input.
* @param agent - The agent input.
* @returns The value produced by list plugins for.
*/
function listPluginsFor(registry, agent) {
	return registry.ofSession(agent.id).map((plugin) => inspectPluginFor(registry, agent, plugin.pluginId));
}
/**
* Inspect one owned plugin.
* @param registry - The registry input.
* @param agent - The agent input.
* @param pluginId - The plugin id input.
* @returns The value produced by inspect plugin for.
*/
function inspectPluginFor(registry, agent, pluginId) {
	const plugin = ownedPlugin(registry, agent, pluginId);
	if (plugin === void 0) throw new Error(missingPluginMessage(pluginId));
	const reference = referenceFor(registry, agent, pluginId);
	if (reference === void 0) throw new Error(`dynamic plugin "${pluginId}" has no package`);
	return {
		...reference,
		packages: packageRows(plugin)
	};
}
/**
* Inspect one immutable Host package and its source.
* @param registry - The registry input.
* @param agent - The agent input.
* @param pluginId - The plugin id input.
* @param packageId - The package id input.
* @returns The value produced by inspect package for.
*/
function inspectPackageFor(registry, agent, pluginId, packageId) {
	const plugin = ownedPlugin(registry, agent, pluginId);
	if (plugin === void 0) throw new Error(missingPluginMessage(pluginId));
	const definition = plugin.packages.get(packageId);
	if (definition === void 0) throw new Error(`dynamic package "${packageId}" does not exist on plugin "${pluginId}"`);
	return {
		pluginId,
		packageId,
		name: definition.name,
		purpose: definition.purpose,
		code: { host: definition.hostCode },
		...versionFields(plugin),
		...activeRunOf(plugin),
		...plugin.latestRun === void 0 ? {} : { latestRun: cloneAttempt(plugin.latestRun) }
	};
}
//#endregion
//#region lib/types/sandbox.js
/**
* The `node:vm` sandbox a dynamic package's HOST half evaluates in: a fresh realm whose globals
* are a tagged write-through console, the `harness` registration helpers, the encoding primitives
* a bare vm context lacks, and callable traps over the Node APIs the sandbox deliberately
* withholds. Traps steer filesystem, network, process, and timer work to `ctx.fs`, `ctx.web`,
* `ctx.bash`, and Cordis timers. This keeps cooperative packages inspectable and disposable but
* is not containment: host-realm helper functions remain an escape route.
*
* @module @deepseek-ai/dsh-cordis-host-runner/sandbox
*/
/** Exact Host closure symbols exposed by the sandbox and guarded Context. */
const HOST_BUILTIN_INSPECTION = [
	{
		name: "ctx",
		description: "Restricted Cordis Context. Prefer ctx.get(name) with an undefined check; use inject for hard dependencies.",
		signatures: [
			"ctx.get(name: string): unknown | undefined",
			"ctx.on(name: string, listener: Function): () => void",
			"ctx.provide(name: string, value: unknown): () => void",
			"ctx.effect(callback: Function, label?: string): () => void"
		]
	},
	{
		name: "harness",
		description: "Host helpers for model-visible dynamic Tools.",
		signatures: ["harness.defineTool(definition: ToolDefinition): ToolDefinition", "harness.registerTool(ctx: Context, tool: ToolDefinition): () => void"]
	},
	{
		name: "console",
		description: "Package-tagged Host logging.",
		signatures: ["console.log(...values): void", "console.error(...values): void"]
	},
	{
		name: "btoa",
		description: "Encode UTF-8 text as base64.",
		signatures: ["btoa(value: string): string"]
	},
	{
		name: "atob",
		description: "Decode base64 as UTF-8 text.",
		signatures: ["atob(value: string): string"]
	},
	{
		name: "TextEncoder",
		description: "Standard UTF-8 encoder constructor.",
		signatures: ["new TextEncoder()"]
	},
	{
		name: "TextDecoder",
		description: "Standard text decoder constructor.",
		signatures: ["new TextDecoder(label?: string)"]
	}
];
/**
* A write-through console for one package, tagging every line with the package
* id. Write-through (host stdout/stderr), NOT buffered into the tool result:
* a registered listener fires long after the run call returned, and its output
* must land somewhere the user can see — for a terminal entry point, the host terminal.
*/
function taggedConsole(id) {
	const tag = `[cordis:${id}]`;
	const log = (...args) => {
		console.log(tag, ...args);
	};
	const error = (...args) => {
		console.error(tag, ...args);
	};
	return {
		log,
		info: log,
		warn: log,
		debug: log,
		error
	};
}
/**
* Patch only VM constructors so `instanceof` accepts both VM values and host values passed as
* arguments, events, or service results; host intrinsics remain untouched.
*/
const DUAL_REALM_INSTANCEOF_PRELUDE = `
(hostIntrinsics) => {
  'use strict'
  const ordinary = Function.prototype[Symbol.hasInstance]
  for (const name of Object.keys(hostIntrinsics)) {
    const VmCtor = globalThis[name]
    const HostCtor = hostIntrinsics[name]
    if (typeof VmCtor !== 'function' || typeof HostCtor !== 'function') continue
    Object.defineProperty(VmCtor, Symbol.hasInstance, {
      value: (instance) => ordinary.call(VmCtor, instance) || ordinary.call(HostCtor, instance),
      configurable: true,
    })
  }
}
`;
/** Run {@link DUAL_REALM_INSTANCEOF_PRELUDE} in a freshly created sandbox, handing it the host intrinsics to pair up. */
function patchDualRealmInstanceof(sandbox) {
	runInContext(DUAL_REALM_INSTANCEOF_PRELUDE, sandbox)({
		Object,
		Array,
		Function,
		Error,
		TypeError,
		RangeError,
		SyntaxError,
		Promise,
		RegExp,
		Date,
		Map,
		Set
	});
}
const TIMER_REDIRECT = "Node timers are unavailable. Use the cordis timer service instead: declare inject: ['timer'] on your plugin and call ctx.timeout / ctx.interval after querying Host Service.listService for the exact overloads. Those calls are fiber effects, cleaned up automatically when stopped.";
/**
* The callable Node APIs the sandbox deliberately disables, each mapped to the
* cordis alternative its trap error names. Only function-valued globals are
* trapped; a data-valued global such as `process` stays `undefined`, because a
* throwing accessor would detonate the common `typeof process` feature probe
* at resolution time.
*/
const NODE_API_REDIRECTS = {
	require: "Node modules are unavailable. Use the cordis services on ctx instead — e.g. inject: ['fs'] for files, ['web'] for HTTP, ['bash'] for processes; query Service.listService with cordis_inspect_query first.",
	setTimeout: TIMER_REDIRECT,
	setInterval: TIMER_REDIRECT,
	setImmediate: TIMER_REDIRECT,
	clearTimeout: TIMER_REDIRECT,
	clearInterval: TIMER_REDIRECT,
	fetch: "Network access goes through the cordis web service: declare inject: ['web'] and call ctx.web (query Host Service.listService with cordis_inspect_query for its methods)."
};
/** Build the trap functions for {@link NODE_API_REDIRECTS}: calling one throws the redirect. */
function nodeApiTraps() {
	const traps = {};
	for (const [name, redirect] of Object.entries(NODE_API_REDIRECTS)) traps[name] = () => {
		throw new Error(`${name} is not available in the dynamic package sandbox — ${redirect}`);
	};
	return traps;
}
/**
* Build the vm context one host half evaluates in: the tagged console, the
* `harness` registration helpers, the encoding primitives, the Node-API traps,
* and the dual-realm `instanceof` patch, already `createContext`-ed.
* @param id - the package id (`dyn-<n>`), used as the console tag and filename stem.
* @returns the contextified sandbox object to pass to {@link evaluateHostCode}.
*/
function createSandbox(id) {
	const sandbox = {
		...nodeApiTraps(),
		console: taggedConsole(id),
		harness: {
			defineTool: sandboxDefineTool,
			registerTool: sandboxRegisterTool
		},
		btoa: (s) => Buffer.from(s, "utf-8").toString("base64"),
		atob: (s) => Buffer.from(s, "base64").toString("utf-8"),
		TextEncoder,
		TextDecoder
	};
	createContext(sandbox);
	patchDualRealmInstanceof(sandbox);
	return sandbox;
}
/**
* Cross-realm SyntaxError detection: a compile failure inside `runInContext`
* constructs its error in the SANDBOX realm, so a host `instanceof
* SyntaxError` is silently false — the `name` property is the realm-safe tag.
*/
function isSyntaxError(error) {
	return typeof error === "object" && error !== null && Reflect.get(error, "name") === "SyntaxError";
}
/**
* The parse-failure context a vm `SyntaxError` carries: the vm prints the
* offending source line and a caret before the message, which is exactly what
* a model needs to self-correct — surface it instead of the bare message.
* Falls back to `String(error)` when the stack carries no such prelude.
* @param error - the `SyntaxError` (host- or sandbox-realm) thrown while compiling package code.
* @returns the stack prefix up to and including the `SyntaxError: …` line.
*/
function syntaxErrorContext(error) {
	return syntaxErrorContextOr(error, error);
}
/** Preserve vm parse context when present, otherwise retain the gate's original refusal. */
function syntaxErrorContextOr(error, fallback) {
	if (!isSyntaxError(error)) return String(fallback);
	const stack = Reflect.get(error, "stack");
	const lines = (typeof stack === "string" ? stack : "").split("\n");
	const messageIndex = lines.findIndex((line) => line.startsWith("SyntaxError"));
	if (messageIndex === -1) return String(fallback);
	return lines.slice(0, messageIndex + 1).join("\n");
}
/**
* The teaching text one parse failure produces, shared by the define-time
* precheck and the run-time evaluation so a model reads the same diagnosis
* whichever verb caught it.
* @param half - which half failed to parse, named as the define argument that carried it.
* @param context - the {@link syntaxErrorContext} of the failure.
* @returns the model-facing error message.
*/
function parseErrorMessage(half, context) {
	const offendingLine = context.split("\n")[1] ?? "";
	if (/\bas\b/.test(offendingLine)) return `dynamic package \`${half}\` failed to parse:\n${context}\nThe sandbox runs plain JavaScript, not TypeScript. Remove type annotations:
  ✗ { type: 'text' as const, text: x }
  ✓ { type: 'text', text: x }`;
	return `dynamic package \`${half}\` failed to parse:\n${context}\nNote: it runs as the BODY of an async function (line numbers are offset by the 1-line wrapper). Check bracket balance — ending the returned plugin object with \`});\` closes a call that was never opened; a plain \`return { … }\` ends with \`}\` (an optional \`;\`), never \`)\`.`;
}
/**
* Parse one half's source without running it: the define-time precheck that
* keeps unparseable code out of the registry, so a model fixes it and defines
* again instead of discovering the failure at run time. `new Function` is the
* gate — hosts without a real `node:vm` (the browser worker) still refuse
* unparseable code — and `vm.Script` is only the best-effort prettifier: on a
* Node host its failure carries the source-line-and-caret prelude the
* teaching text builds on, and where the vm is a stub the message stays bare.
* The two parsers' syntax faces differ at the margin (`new.target` parses in
* a function body but not at the vm wrapper's top level), an accepted cost of
* a vm-free gate; and under a page CSP without `'unsafe-eval'`, `new Function`
* throws `EvalError`, which propagates unwrapped.
* @param code - the model-written function body.
* @param half - which define argument carried it, for the error text.
* @throws when the body does not parse, with the offending line and a teaching hint.
*/
function precheckCode(code, half) {
	const wrapped = `(async () => {\n${code}\n})()`;
	try {
		new Function(wrapped);
	} catch (error) {
		if (!isSyntaxError(error)) throw error;
		throw new Error(parseErrorMessage(half, prettyParseContext(wrapped, half, error)));
	}
}
/**
* Best-effort vm recompile of a body `new Function` already refused, for the
* source-line-and-caret prelude only.
* @param wrapped - the wrapped source that failed to parse.
* @param half - which define argument carried it, for the vm filename.
* @param refusal - the gate's own `SyntaxError`, the fallback context source.
* @returns the vm prelude when a real vm produced one, else the bare refusal.
*/
function prettyParseContext(wrapped, half, refusal) {
	let vmError;
	try {
		new Script(wrapped, { filename: `cordis-dyn-${half}.js` });
	} catch (error) {
		vmError = error;
	}
	return syntaxErrorContextOr(vmError, refusal);
}
/**
* Evaluate a host half as the body of an async function inside the sandbox. `vmTimeoutMs` only
* bounds the SYNCHRONOUS portion; an async body escapes it — acceptable under the module's
* trust stance. Parse errors include the offending line and a TypeScript-removal or bracket-
* balance hint.
* @param sandbox - the contextified object from {@link createSandbox}.
* @param code - the model-written function body; must `return` a plugin.
* @param id - the package id, used as the vm filename (`cordis-dyn-<id>.js`).
* @param vmTimeoutMs - the synchronous evaluation bound in milliseconds.
* @returns whatever the code returned, still un-narrowed (the run lifecycle checks plugin shape).
*/
async function evaluateHostCode(sandbox, code, id, vmTimeoutMs) {
	try {
		return await runInContext(`(async () => {\n${code}\n})()`, sandbox, {
			filename: `cordis-dyn-${id}.js`,
			timeout: vmTimeoutMs
		});
	} catch (error) {
		if (!isSyntaxError(error)) throw error;
		throw new Error(parseErrorMessage("code.host", syntaxErrorContext(error)));
	}
}
//#endregion
//#region lib/types/index.js
/** Dynamic Cordis service for model-authored Host plugins. */
/**
* Brand a Host-minted Plugin ID.
* @param id - The id input.
* @returns The value produced by cordis dynamic plugin id.
*/
function CordisDynamicPluginId(id) {
	return id;
}
/**
* Brand a Host-minted Package ID.
* @param id - The id input.
* @returns The value produced by cordis dynamic package id.
*/
function CordisDynamicPackageId(id) {
	return id;
}
/**
* Brand a Host-minted activation ID.
* @param id - The id input.
* @returns The value produced by cordis dynamic plugin run id.
*/
function CordisDynamicPluginRunId(id) {
	return id;
}
/** Dynamic Host Plugin registry and lifecycle. */
var DynamicCordisRunnerService = class extends Service {
	static inject = ["tools"];
	static Config = z.object({ vmTimeoutMs: z.number().min(1).default(5e3) });
	rootCtx;
	registry = new DynamicCordisRegistry();
	starting = /* @__PURE__ */ new Map();
	resolved;
	group;
	/** Create the service under the Host composition. */
	constructor(ctx, config) {
		super(ctx, "dynamicCordisRunner");
		this.rootCtx = ctx;
		this.resolved = config;
		new CordisInspectRegistryService(ctx);
	}
	/**
	* Define a new Plugin Package or append a version to an existing Plugin.
	* @param request - Session-owned plugin and immutable Host source definition.
	* @returns The minted plugin and package identities.
	*/
	define(request) {
		const name = request.name.trim();
		const purpose = request.purpose.trim();
		const hostCode = request.code.host;
		if (name.length === 0) throw new Error("cordis_define needs a non-empty `name`");
		if (purpose.length === 0) throw new Error("cordis_define needs a non-empty `purpose`");
		if (hostCode.trim().length === 0) throw new Error("cordis_define needs non-empty `code.host`");
		precheckCode(hostCode, "code.host");
		let plugin;
		if (request.plugin.kind === "new") {
			const prefix = request.plugin.idPrefix.trim();
			if (!/^[a-z]{3,6}$/.test(prefix)) throw new Error("cordis_define `plugin.idPrefix` must contain 3–6 lowercase English letters");
			plugin = {
				pluginId: CordisDynamicPluginId(this.registry.mintPluginId(prefix)),
				sessionId: request.sessionId,
				packages: /* @__PURE__ */ new Map()
			};
			this.registry.add(plugin);
		} else {
			const found = this.registry.get(request.plugin.pluginId);
			if (found === void 0 || found.sessionId !== request.sessionId) throw new Error(missingPluginMessage(request.plugin.pluginId));
			plugin = found;
		}
		const packageId = CordisDynamicPackageId(this.registry.mintPackageId());
		plugin.packages.set(packageId, {
			packageId,
			name,
			purpose,
			hostCode
		});
		return {
			pluginId: plugin.pluginId,
			packageId,
			name,
			purpose
		};
	}
	/**
	* Remove one owned Plugin and all immutable Packages.
	* @param agent - Session agent that owns the plugin.
	* @param pluginId - Plugin identity to remove.
	* @returns Removal status and whether a running Host half was stopped.
	*/
	async undefine(agent, pluginId) {
		const plugin = this.owned(agent, pluginId);
		if (plugin === void 0) return {
			ok: false,
			reason: "plugin-missing",
			message: missingPluginMessage(pluginId)
		};
		const wasRunning = plugin.run !== void 0;
		if (plugin.run !== void 0) await this.retract(plugin);
		this.registry.delete(pluginId);
		return {
			ok: true,
			wasRunning
		};
	}
	/**
	* Start or update one owned Host Package.
	* @param agent - Session agent that owns the plugin.
	* @param pluginId - Plugin identity to activate.
	* @param packageId - Immutable package version to run.
	* @param mode - Whether this is a first run or an in-place update.
	* @param signal - Optional cancellation signal for activation.
	* @returns Host activation status and diagnostics.
	*/
	async run(agent, pluginId, packageId, mode, signal) {
		const plan = this.resolvePlan(agent, pluginId, packageId, mode);
		if (!plan.ok) return plan.response;
		if (signal?.aborted === true) return {
			ok: false,
			reason: "host-half-failed",
			message: `activation of dynamic plugin "${pluginId}" was cancelled`
		};
		const active = plan.plugin.run;
		if (active?.packageId === packageId) return this.runResponse(plan.plugin, active, mode);
		if (this.starting.get(pluginId) !== void 0) return {
			ok: false,
			reason: "transition-in-flight",
			message: `dynamic plugin "${pluginId}" is already starting`
		};
		const attempt = this.createAttempt(plan);
		plan.plugin.nextPackageId = packageId;
		plan.plugin.latestRun = attempt;
		const starting = this.activate(plan, attempt);
		this.starting.set(pluginId, starting);
		try {
			return await starting;
		} finally {
			this.starting.delete(pluginId);
		}
	}
	/**
	* Stop one owned Plugin while retaining its Packages.
	* @param agent - Session agent that owns the plugin.
	* @param pluginId - Plugin identity to stop.
	* @returns Stop status and diagnostics.
	*/
	async stop(agent, pluginId) {
		const plugin = this.owned(agent, pluginId);
		if (plugin === void 0) return {
			ok: false,
			reason: "plugin-missing",
			message: missingPluginMessage(pluginId)
		};
		if (plugin.run === void 0) return {
			ok: false,
			reason: "not-running",
			message: `dynamic plugin "${pluginId}" is not running`
		};
		await this.retract(plugin);
		delete plugin.nextPackageId;
		if (plugin.latestRun !== void 0) {
			plugin.latestRun.status = "stopped";
			plugin.latestRun.host = {
				status: "stopped",
				waitingFor: []
			};
		}
		return { ok: true };
	}
	/**
	* Process-wide source-free inventory.
	* @returns All registered plugin/package lifecycle rows.
	*/
	inventory() {
		return inventoryRows(this.registry);
	}
	/**
	* One Session's Host-rich snapshot.
	* @param agent - Session agent whose owned plugins are inspected.
	* @returns Session-scoped plugin/package snapshot rows.
	*/
	snapshot(agent) {
		return snapshotRows(this.registry, agent);
	}
	/**
	* Source-free reference to one owned Plugin.
	* @param agent - Session agent that owns the plugin.
	* @param pluginId - Plugin identity to resolve.
	* @returns A stable plugin reference, or undefined when absent.
	*/
	reference(agent, pluginId) {
		return referenceFor(this.registry, agent, pluginId);
	}
	/**
	* List owned Plugin summaries.
	* @param agent - Session agent whose plugins are listed.
	* @returns Session-owned plugin inspection rows.
	*/
	listPlugins(agent) {
		return listPluginsFor(this.registry, agent);
	}
	/**
	* Inspect one owned Plugin.
	* @param agent - Session agent that owns the plugin.
	* @param pluginId - Plugin identity to inspect.
	* @returns Detailed plugin inspection data.
	*/
	inspectPlugin(agent, pluginId) {
		return inspectPluginFor(this.registry, agent, pluginId);
	}
	/**
	* Inspect one immutable owned Package and its Host source.
	* @param agent - Session agent that owns the plugin.
	* @param pluginId - Plugin identity containing the package.
	* @param packageId - Immutable package identity to inspect.
	* @returns Detailed package inspection data.
	*/
	inspectPackage(agent, pluginId, packageId) {
		return inspectPackageFor(this.registry, agent, pluginId, packageId);
	}
	resolvePlan(agent, pluginId, packageId, mode) {
		const plugin = this.owned(agent, pluginId);
		if (plugin === void 0) return {
			ok: false,
			response: {
				ok: false,
				reason: "plugin-missing",
				message: missingPluginMessage(pluginId)
			}
		};
		const definition = plugin.packages.get(packageId);
		if (definition === void 0) return {
			ok: false,
			response: {
				ok: false,
				reason: "package-missing",
				message: `plugin "${pluginId}" has no package "${packageId}"`
			}
		};
		const current = plugin.currentPackageId;
		if (mode === "update" && (current === void 0 || current === packageId)) return {
			ok: false,
			response: {
				ok: false,
				reason: "invalid-mode",
				message: current === void 0 ? `plugin "${pluginId}" has no successful version yet; start "${packageId}" with mode "run"` : `package "${packageId}" is already current; use mode "run"`
			}
		};
		if (mode === "run" && current !== void 0 && current !== packageId) return {
			ok: false,
			response: {
				ok: false,
				reason: "invalid-mode",
				message: `package "${packageId}" differs from current "${current}"; use mode "update"`
			}
		};
		return {
			ok: true,
			plugin,
			definition,
			mode
		};
	}
	async activate(plan, attempt) {
		const { plugin, definition } = plan;
		if (plugin.run !== void 0) await this.retract(plugin);
		const run = {
			pluginRunId: attempt.pluginRunId,
			packageId: definition.packageId,
			reportedRuntimeErrors: /* @__PURE__ */ new Set()
		};
		const failure = await this.startHost(plugin, definition.hostCode, run);
		if (failure !== void 0) {
			this.failAttempt(plugin, attempt, failure);
			return {
				ok: false,
				reason: "host-half-failed",
				...failure
			};
		}
		plugin.run = run;
		plugin.currentPackageId = run.packageId;
		delete plugin.nextPackageId;
		const waitingFor = missingFor(this.ctx, run);
		attempt.host = {
			status: waitingFor.length === 0 ? "running" : "waiting",
			waitingFor
		};
		attempt.status = waitingFor.length === 0 ? "running" : "waiting";
		delete attempt.error;
		return this.runResponse(plugin, run, plan.mode);
	}
	async startHost(plugin, hostCode, run) {
		try {
			const evaluated = await evaluateHostCode(createSandbox(plugin.pluginId), hostCode, plugin.pluginId, this.resolved.vmTimeoutMs);
			if (!isPlugin(evaluated)) throw new Error(evaluated === void 0 ? "the Host package returned `undefined` — did you forget `return`?" : "the Host package must return a Plugin function or an object with apply(ctx)");
			run.fiber = await startHostHalf(this.requireGroup(), evaluated, (error) => {
				const failure = errorDetails(error);
				const key = `Host\u0000guard\u0000${failure.message}`;
				if (!this.claimRuntimeFailure(plugin, run, key)) return;
				const attempt = plugin.latestRun;
				if (attempt?.pluginRunId === run.pluginRunId) attempt.error = this.diagnostic(plugin, attempt, "host-guard", failure);
				steerGuardFailure(this.rootCtx.get("agents"), plugin, run, failure);
			});
			return;
		} catch (error) {
			return errorDetails(error);
		}
	}
	runResponse(plugin, run, mode) {
		const waitingFor = missingFor(this.ctx, run);
		return {
			ok: true,
			status: waitingFor.length === 0 ? "running" : "waiting",
			pluginId: plugin.pluginId,
			packageId: run.packageId,
			pluginRunId: run.pluginRunId,
			waitingFor,
			currentPackageId: run.packageId,
			mode
		};
	}
	createAttempt(plan) {
		return {
			pluginRunId: CordisDynamicPluginRunId(this.registry.mintPluginRunId()),
			packageId: plan.definition.packageId,
			mode: plan.mode,
			status: "starting-host",
			host: {
				status: "pending",
				waitingFor: []
			}
		};
	}
	failAttempt(plugin, attempt, failure) {
		attempt.status = "failed";
		attempt.host = {
			status: "failed",
			waitingFor: [],
			error: failure.message
		};
		attempt.error = this.diagnostic(plugin, attempt, "host-load", failure);
	}
	diagnostic(plugin, attempt, phase, failure) {
		return {
			phase,
			...failure,
			pluginId: plugin.pluginId,
			packageId: attempt.packageId,
			pluginRunId: attempt.pluginRunId
		};
	}
	claimRuntimeFailure(plugin, run, key) {
		const attempt = plugin.latestRun;
		if (plugin.run !== run || attempt?.pluginRunId !== run.pluginRunId || attempt.status !== "running" && attempt.status !== "waiting") return false;
		if (run.reportedRuntimeErrors.has(key)) return false;
		run.reportedRuntimeErrors.add(key);
		return true;
	}
	async retract(plugin) {
		const run = plugin.run;
		if (run === void 0) return;
		delete plugin.run;
		if (run.fiber !== void 0) await run.fiber.dispose();
	}
	owned(agent, pluginId) {
		const plugin = this.registry.get(pluginId);
		return plugin?.sessionId === agent.id ? plugin : void 0;
	}
	requireGroup() {
		this.group ??= this.rootCtx.plugin({
			name: "cordis-dynamic",
			apply: () => {}
		});
		return this.group;
	}
};
function missingFor(ctx, run) {
	return run.fiber === void 0 ? [] : missingServices(ctx, run.fiber);
}
function errorDetails(error) {
	if (typeof error !== "object" || error === null) return { message: String(error) };
	const message = "message" in error && typeof error.message === "string" ? error.message : Object.prototype.toString.call(error);
	const stack = "stack" in error && typeof error.stack === "string" ? error.stack : void 0;
	return {
		message,
		...stack === void 0 ? {} : { stack }
	};
}
//#endregion
export { CordisDynamicPackageId, CordisDynamicPluginId, CordisDynamicPluginRunId, CordisInspectRegistryService, DynamicCordisRunnerService, DynamicCordisRunnerService as default, HOST_BUILTIN_INSPECTION };
