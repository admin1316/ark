import { AsyncLocalStorage } from "node:async_hooks";
import { isAbsolute } from "node:path";
import { Service } from "@deepseek-ai/cordis";
import { openNativeTextFile } from "@deepseek-ai/dsh-native-command";
import { Remote, TypertLookupFailure, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
//#region lib/types/redact.js
/**
* Structural secret redaction for settings values. `role('secret')` fields are
* removed from a value before it crosses a wire boundary; a sidecar records
* each schema-declared secret position and whether it currently holds a value,
* so a configuration surface can render a write-only input without ever
* receiving the secret itself.
* @module @deepseek-ai/dsh-settings/redact
*/
/** Whether a value is a plain data object the walker may recurse into. */
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function children(node) {
	return [
		...Object.values(node.dict ?? {}),
		...[node.inner, node.sKey].filter((child) => child !== void 0),
		...node.list ?? []
	];
}
function assertPublicKeys(node) {
	if (node.sKey !== void 0 && containsSecret(node.sKey)) throw new TypeError("settings cannot expose secret dictionary keys");
}
function containsSecret(node, seen = /* @__PURE__ */ new Set()) {
	if (seen.has(node)) return false;
	seen.add(node);
	return node.meta?.role === "secret" || children(node).some((child) => containsSecret(child, seen));
}
function setProperty(record, key, value) {
	Object.defineProperty(record, key, {
		value,
		enumerable: true,
		configurable: true,
		writable: true
	});
}
function walk(node, value, path, secrets) {
	if (node === void 0) return value;
	if (node.meta?.role === "secret") {
		secrets.push({
			path,
			set: value !== void 0
		});
		return;
	}
	const shapeMatches = node.type === "object" || node.type === "dict" ? isRecord(value) : node.type === "array" || node.type === "tuple" ? Array.isArray(value) : true;
	if (value !== void 0 && !shapeMatches && containsSecret(node)) throw new TypeError("settings cannot safely redact a malformed secret-bearing container");
	switch (node.type) {
		case "object": {
			const properties = node.dict ?? {};
			const source = isRecord(value) ? value : void 0;
			const rebuilt = {};
			if (source !== void 0) for (const [key, entry] of Object.entries(source)) {
				if (Object.hasOwn(properties, key)) continue;
				setProperty(rebuilt, key, entry);
			}
			for (const [key, child] of Object.entries(properties)) {
				const stripped = walk(child, source !== void 0 && Object.hasOwn(source, key) ? source[key] : void 0, [...path, key], secrets);
				if (stripped !== void 0) setProperty(rebuilt, key, stripped);
			}
			return source === void 0 && Object.keys(rebuilt).length === 0 ? value : rebuilt;
		}
		case "dict": {
			assertPublicKeys(node);
			if (!isRecord(value)) return value;
			const rebuilt = {};
			for (const [key, entry] of Object.entries(value)) {
				const stripped = walk(node.inner, entry, [...path, key], secrets);
				if (stripped !== void 0) setProperty(rebuilt, key, stripped);
			}
			return rebuilt;
		}
		case "array":
			if (!Array.isArray(value)) return value;
			return value.map((entry, index) => walk(node.inner, entry, [...path, String(index)], secrets) ?? null);
		case "union":
		case "intersect": return (node.list ?? []).reduce((current, branch) => walk(branch, current, path, secrets), value);
		case "tuple":
			if (!Array.isArray(value)) return value;
			return value.map((entry, index) => walk(node.list?.[index], entry, [...path, String(index)], secrets) ?? null);
		default:
			if (containsSecret(node)) throw new TypeError(`settings cannot safely redact schema type "${node.type ?? "unknown"}"`);
			return value;
	}
}
/**
* Remove every `role('secret')` field a schema declares from a value. The
* walker follows object, dict, array, tuple, union, and intersection relations.
* Unsupported or malformed secret-bearing containers reject instead of returning
* their values, including schema defaults and overridden layers. Secret array
* positions become null so indexes remain stable.
* @param schema - live schemastery schema describing the value.
* @param value - the value to strip; `undefined` yields an empty record with
*   object-property secret slots still enumerated.
* @returns the stripped detached value and the ordered secret positions.
*/
function redactSecrets(schema, value) {
	const secrets = [];
	const stripped = walk(schema, value, [], secrets);
	const unique = /* @__PURE__ */ new Map();
	for (const secret of secrets) {
		const key = JSON.stringify(secret.path);
		const previous = unique.get(key);
		unique.set(key, {
			path: secret.path,
			set: secret.set || previous?.set === true
		});
	}
	return {
		value: stripped,
		secrets: [...unique.values()]
	};
}
/**
* Serialize form metadata with secret values removed from every default layer.
* @param schema - live namespace schema, including shared schema nodes.
* @returns its detached schemastery envelope, safe from schema-declared default secrets.
*/
function redactSettingsSchema(schema) {
	const nodes = /* @__PURE__ */ new Map();
	const visited = /* @__PURE__ */ new Set();
	const visit = (node) => {
		if (visited.has(node)) return;
		visited.add(node);
		assertPublicKeys(node);
		nodes.set(node.uid, node);
		for (const child of children(node)) visit(child);
	};
	visit(schema);
	const envelope = schema.toJSON();
	if (!isRecord(envelope) || !isRecord(envelope["refs"])) throw new TypeError("settings schema has no serialized references");
	for (const [id, serialized] of Object.entries(envelope["refs"])) {
		const node = nodes.get(Number(id));
		if (node === void 0 || !isRecord(serialized)) throw new TypeError("settings schema has an unrecognized reference");
		if (!containsSecret(node)) continue;
		if (node.meta?.role === "secret" && node.type === "const") throw new TypeError("settings cannot expose a secret literal schema");
		const meta = serialized["meta"];
		if (isRecord(meta) && Object.hasOwn(meta, "default")) {
			const stripped = walk(node, meta["default"], [], []);
			if (stripped === void 0) delete meta["default"];
			else setProperty(meta, "default", stripped);
		}
	}
	return envelope;
}
//#endregion
//#region lib/types/index.js
/**
* Service Definition for the user-settings capability seam (`ctx.settings`). Providers store one raw document of
* per-namespace sections; plugins register a namespace schema and read the
* resolved value, which layers schema defaults, the registrant's composition
* `base`, and the user document section, in that order.
* @module @deepseek-ai/dsh-settings
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
const NAMESPACE_PATTERN = /^[a-z][a-z0-9-]*$/;
/**
* Brand a raw string as a {@link SettingsNamespace}.
* @param value - candidate namespace; lowercase kebab-case, as in plugin short names.
* @returns the branded namespace.
*/
function settingsNamespace(value) {
	if (!NAMESPACE_PATTERN.test(value)) throw new TypeError(`settings namespace "${value}" must match ${String(NAMESPACE_PATTERN)}`);
	return value;
}
/**
* Deep equality over JSON-compatible data (objects, arrays, primitives) — the
* Service Definition's single change-detection predicate, exported so the invariant
* companion checks exactly the implementation's relation.
* @param a - one JSON-compatible value.
* @param b - the other JSON-compatible value.
* @returns whether the two values are structurally equal.
*/
function deepEqualJson(a, b) {
	if (a === b) return true;
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
		return a.every((entry, index) => deepEqualJson(entry, b[index]));
	}
	const left = a;
	const right = b;
	const keys = Object.keys(left);
	if (keys.length !== Object.keys(right).length) return false;
	return keys.every((key) => Object.hasOwn(right, key) && deepEqualJson(left[key], right[key]));
}
/**
* A write refused because the namespace moved since the caller read it. The
* Service Definition's serialized write queue orders writes; it cannot tell a fresh writer
* from one holding a stale snapshot, which is what this reports.
*/
var SettingsConflictError = class extends Error {
	/** Stable machine code for wire layers mapping this to their own taxonomy. */
	code = "SETTINGS_CONFLICT";
	/** The revision the write expected. */
	expected;
	/** The revision the namespace actually stands at. */
	actual;
	/**
	* @param ns - the namespace whose write was refused.
	* @param expected - the revision the caller sent.
	* @param actual - the revision now stored.
	*/
	constructor(ns, expected, actual) {
		super(`settings namespace "${ns}" changed since it was read (expected revision ${String(expected)}, now ${String(actual)})`);
		this.name = "SettingsConflictError";
		this.expected = expected;
		this.actual = actual;
	}
};
/** A namespace cannot be replaced until its previous owner's work stops. */
var SettingsRegistrationQuiescenceError = class extends Error {
	ns;
	timeoutMs;
	/** Replacement remains blocked while the previous registration is stopping. */
	code = "SETTINGS_REGISTRATION_QUIESCENCE_TIMEOUT";
	/**
	* @param ns - namespace whose owner is still stopping.
	* @param timeoutMs - elapsed replacement deadline.
	*/
	constructor(ns, timeoutMs) {
		super(`settings namespace "${ns}" did not quiesce within ${String(timeoutMs)}ms; replacement remains blocked`);
		this.ns = ns;
		this.timeoutMs = timeoutMs;
		this.name = "SettingsRegistrationQuiescenceError";
	}
};
/** Whether a value is a plain data object (not an array, null, or class instance). */
function isPlainObject(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}
/** Apply one path op to a detached section, returning the next section. */
function applyPathOp(section, op) {
	const [head, ...rest] = op.path;
	if (head === void 0) {
		if (op.op === "unset") return {};
		if (!isPlainObject(op.value)) throw new TypeError("settings mutate: setting the section root requires a plain object");
		return { ...op.value };
	}
	if (rest.length === 0) {
		if (op.op === "set") return {
			...section,
			[head]: op.value
		};
		const { [head]: _removed, ...kept } = section;
		return kept;
	}
	const child = Object.hasOwn(section, head) ? section[head] : void 0;
	if (!isPlainObject(child)) {
		if (op.op === "unset") return section;
		return {
			...section,
			[head]: applyPathOp({}, {
				...op,
				path: rest
			})
		};
	}
	return {
		...section,
		[head]: applyPathOp(child, {
			...op,
			path: rest
		})
	};
}
function validateSettingsPathOps(ns, ops) {
	if (!Array.isArray(ops)) throw new TypeError(`settings mutate for "${ns}" must be an array of path ops`);
	for (const op of ops) {
		if (!isPlainObject(op) || op["op"] !== "set" && op["op"] !== "unset") throw new TypeError(`settings mutate for "${ns}" ops must be {op:'set'|'unset', path}`);
		if (!Array.isArray(op["path"]) || op["path"].some((part) => typeof part !== "string")) throw new TypeError(`settings mutate for "${ns}" op paths must be arrays of strings`);
		if (op["op"] === "set" && !Object.hasOwn(op, "value")) throw new TypeError(`settings mutate for "${ns}" set ops must include a JSON value`);
	}
}
/** Human label for a value that lossless JSON cannot represent (numbers reject inline). */
function describeRejected(value) {
	if (value === void 0) return "undefined";
	if (typeof value === "object" && value !== null) {
		const name = Object.getPrototypeOf(value)?.constructor?.name;
		return name === void 0 || name === "Object" ? "a non-plain object" : `a ${name}`;
	}
	return `a ${typeof value}`;
}
/**
* Detach and validate one write input in a single walk before persistence:
* only JSON data (plain objects, arrays, strings, finite numbers,
* booleans, `null`) may reach a provider document. `structuredClone` alone
* would admit Dates, Maps, BigInts, and cycles that YAML/JSON storage then
* silently distorts on the reload round-trip. `undefined` entries in objects
* are skipped — the same sparse-patch semantics as {@link mergeLayers} — while
* an `undefined` array entry is rejected rather than coerced.
* @param root - plain-object write input (caller-checked).
* @param reject - builds the validation error from a value label and its `$`-rooted path.
* @returns the detached JSON-compatible clone.
*/
function cloneJsonShaped(root, reject) {
	const visiting = /* @__PURE__ */ new WeakSet();
	const clone = (value, path) => {
		if (value === null || typeof value === "string" || typeof value === "boolean") return value;
		if (typeof value === "number") {
			if (!Number.isFinite(value)) throw reject("a non-finite number", path);
			if (Object.is(value, -0)) throw reject("negative zero", path);
			return value;
		}
		if (Array.isArray(value)) {
			if (visiting.has(value)) throw reject("a circular reference", path);
			visiting.add(value);
			const entries = [];
			for (let index = 0; index < value.length; index++) entries.push(clone(value[index], `${path}[${index}]`));
			visiting.delete(value);
			return entries;
		}
		if (isPlainObject(value)) return cloneObject(value, path);
		throw reject(describeRejected(value), path);
	};
	const cloneObject = (value, path) => {
		if (visiting.has(value)) throw reject("a circular reference", path);
		visiting.add(value);
		const out = {};
		for (const [key, entry] of Object.entries(value)) {
			if (entry === void 0) continue;
			Object.defineProperty(out, key, {
				value: clone(entry, `${path}.${key}`),
				enumerable: true,
				writable: true,
				configurable: true
			});
		}
		visiting.delete(value);
		return out;
	};
	return cloneObject(root, "$");
}
/**
* Layer `over` onto `under`: plain objects merge recursively, every other
* value (arrays included) replaces the lower layer wholesale. `over` never
* carries `undefined` entries — sections come from parsed documents and write
* snapshots pass {@link cloneJsonShaped}, which strips them so a sparse patch
* cannot erase lower keys.
*/
function mergeLayers(under, over) {
	if (over === void 0) return under;
	if (!isPlainObject(under) || !isPlainObject(over)) return over;
	const merged = { ...under };
	for (const [key, value] of Object.entries(over)) Object.defineProperty(merged, key, {
		value: Object.hasOwn(merged, key) ? mergeLayers(merged[key], value) : value,
		enumerable: true,
		writable: true,
		configurable: true
	});
	return merged;
}
/** Recursively freeze one resolved value so handed-out snapshots stay immutable. */
function deepFreeze(value) {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
	for (const entry of Object.values(value)) deepFreeze(entry);
	return Object.freeze(value);
}
const watcherExecution = new AsyncLocalStorage();
function isRegistrationActive(registration) {
	return registration.active;
}
async function settlesBefore(operation, timeoutMs) {
	const timeout = Promise.withResolvers();
	const timer = setTimeout(timeout.resolve, timeoutMs, false);
	timer.unref();
	try {
		return await Promise.race([operation.then(() => true), timeout.promise]);
	} finally {
		clearTimeout(timer);
	}
}
(() => {
	let _classSuper = TypertRemoteService;
	let _instanceExtraInitializers = [];
	let _remoteDescribe_decorators;
	let _remoteOpenDocument_decorators;
	let _remoteUpdate_decorators;
	let _remoteReplace_decorators;
	let _remoteMutate_decorators;
	return class SettingsProvider extends _classSuper {
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_remoteDescribe_decorators = [Remote("describe")];
			_remoteOpenDocument_decorators = [Remote("openDocument")];
			_remoteUpdate_decorators = [Remote("update")];
			_remoteReplace_decorators = [Remote("replace")];
			_remoteMutate_decorators = [Remote("mutate")];
			__esDecorate(this, null, _remoteDescribe_decorators, {
				kind: "method",
				name: "remoteDescribe",
				static: false,
				private: false,
				access: {
					has: (obj) => "remoteDescribe" in obj,
					get: (obj) => obj.remoteDescribe
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _remoteOpenDocument_decorators, {
				kind: "method",
				name: "remoteOpenDocument",
				static: false,
				private: false,
				access: {
					has: (obj) => "remoteOpenDocument" in obj,
					get: (obj) => obj.remoteOpenDocument
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _remoteUpdate_decorators, {
				kind: "method",
				name: "remoteUpdate",
				static: false,
				private: false,
				access: {
					has: (obj) => "remoteUpdate" in obj,
					get: (obj) => obj.remoteUpdate
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _remoteReplace_decorators, {
				kind: "method",
				name: "remoteReplace",
				static: false,
				private: false,
				access: {
					has: (obj) => "remoteReplace" in obj,
					get: (obj) => obj.remoteReplace
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _remoteMutate_decorators, {
				kind: "method",
				name: "remoteMutate",
				static: false,
				private: false,
				access: {
					has: (obj) => "remoteMutate" in obj,
					get: (obj) => obj.remoteMutate
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
		registrations = (__runInitializers(this, _instanceExtraInitializers), /* @__PURE__ */ new Map());
		/** Latest published raw document; empty until the provider's first publish. */
		document = {};
		/** Per-namespace write chains; settled tails, so a failure never poisons the queue. */
		writeQueues = /* @__PURE__ */ new Map();
		/** In-flight watcher invocation segments, drained by the dispose teardown. */
		pendingTails = /* @__PURE__ */ new Set();
		remoteProtectedNamespaces = /* @__PURE__ */ new Map();
		/** Set at service dispose: refuse new writes while queued ones drain. */
		stopped = false;
		/** Deadline for an old namespace owner to release writes and callbacks. */
		get registrationQuiescenceTimeoutMs() {
			return 5e3;
		}
		/** Opaque read of {@link stopped}: control flow cannot narrow it across awaits. */
		isStopped() {
			return this.stopped;
		}
		constructor(ctx) {
			super(ctx, "settings");
		}
		/**
		* Load the provider's document once and publish it before the service
		* becomes injectable, and register the write-drain teardown. Providers with
		* their own init (watchers, connections) delegate here first via
		* `yield* super[Service.init]()`; their disposers then run before the drain.
		*/
		async *[Service.init]() {
			yield async () => {
				this.stopped = true;
				await Promise.allSettled([...this.writeQueues.values(), ...this.pendingTails]);
			};
			this.publish(await this.load());
		}
		/**
		* Absolute path of the provider's user-editable document, when its storage
		* is one local file. Configuration surfaces use this only as availability
		* metadata; the guarded open operation resolves the path again Host-side.
		* Non-file providers leave it undefined and expose no open-document affordance.
		* @returns the absolute local document path, or undefined for non-file storage.
		*/
		get documentPath() {}
		/**
		* Prepare the provider's user-editable document for a native editor. File
		* providers may materialize an absent document before returning its path;
		* non-file providers return undefined.
		* @returns the absolute local document path, or undefined for non-file storage.
		*/
		prepareDocument() {
			return Promise.resolve(this.documentPath);
		}
		/**
		* Register a namespace schema and receive its owner scope. The registration
		* is an effect on the calling plugin's fiber: disposing that fiber removes
		* the namespace and its observers. An invalid stored section fails the
		* registration itself — the earliest point where the schema can judge it.
		* @param ns - unique namespace; duplicate registration fails loud.
		* @param schema - schemastery schema resolving this namespace's value.
		* @param options - composition `base` layer and effect timing.
		* @returns the owner scope for reads, observation, and updates.
		*/
		register(ns, schema, options) {
			if (this.isStopped()) throw new Error(`settings service is disposed: "${ns}" cannot be registered`);
			const existing = this.registrations.get(ns);
			if (existing !== void 0) {
				if (existing.quiescenceTimedOut) throw new SettingsRegistrationQuiescenceError(ns, this.registrationQuiescenceTimeoutMs);
				throw new Error(`settings namespace "${ns}" is already registered`);
			}
			const registration = {
				ns,
				schema,
				base: options?.base,
				applies: options?.applies ?? "live",
				...options?.validate === void 0 ? {} : { validate: options.validate },
				...options?.validateWrite === void 0 ? {} : { validateWrite: options.validateWrite },
				...options?.redact === void 0 ? {} : { redact: options.redact },
				resolved: deepFreeze(this.resolve(schema, options?.base, this.section(ns), options?.validate)),
				revision: 0,
				watchers: /* @__PURE__ */ new Set(),
				active: true,
				settlement: Promise.resolve(true),
				quiescenceTimedOut: false
			};
			this.ctx.effect(() => {
				this.registrations.set(ns, registration);
				return async () => {
					registration.active = false;
					for (const watcher of registration.watchers) watcher.active = false;
					const write = this.writeQueues.get(ns);
					const current = watcherExecution.getStore();
					const tails = [...registration.watchers].filter((watcher) => current?.registration !== registration || current.watcher !== watcher).map((watcher) => watcher.tail);
					const quiescence = Promise.allSettled([...write === void 0 ? [] : [write], ...tails]).then(() => void 0);
					if (!await settlesBefore(quiescence, this.registrationQuiescenceTimeoutMs)) {
						registration.quiescenceTimedOut = true;
						quiescence.then(() => this.registrations.delete(ns));
						throw new SettingsRegistrationQuiescenceError(ns, this.registrationQuiescenceTimeoutMs);
					}
					this.registrations.delete(ns);
				};
			}, `settings.register(${JSON.stringify(String(ns))})`);
			const requireOwner = () => {
				if (!registration.active || this.registrations.get(ns) !== registration || this.isStopped()) throw new Error(`settings namespace "${ns}" registration is disposed`);
			};
			return {
				get: () => registration.resolved,
				watch: (callback) => {
					requireOwner();
					const watcher = {
						callback,
						tail: Promise.resolve(),
						active: true
					};
					registration.watchers.add(watcher);
					return () => {
						watcher.active = false;
						watcher.tail.then(() => registration.watchers.delete(watcher));
					};
				},
				update: async (patch) => {
					requireOwner();
					await this.update(ns, patch);
				},
				replace: async (section) => {
					requireOwner();
					await this.replace(ns, section);
				}
			};
		}
		/**
		* Describe every registered namespace for configuration surfaces, including
		* the composition `base` and raw user layers so a form can mark which fields
		* the user overrode (presence in `user`) and what a reset returns to.
		* @param options - redaction switch; wire surfaces must redact.
		* @returns one descriptor per registered namespace, in registration order.
		*/
		describe(options) {
			return [...this.registrations.values()].map((registration) => {
				let user;
				try {
					user = this.section(registration.ns);
				} catch {
					user = void 0;
				}
				const base = registration.base === void 0 ? void 0 : structuredClone(registration.base);
				const detachedUser = user === void 0 ? void 0 : structuredClone(user);
				const descriptor = {
					ns: registration.ns,
					schema: registration.schema.toJSON(),
					value: registration.resolved,
					revision: registration.revision,
					...base === void 0 ? {} : { base },
					...detachedUser === void 0 ? {} : { user: detachedUser },
					applies: registration.applies
				};
				if (options?.redactSecrets !== true) return descriptor;
				const schema = registration.schema;
				const redact = registration.redact ?? ((value) => redactSecrets(schema, value));
				const redacted = redact(registration.resolved);
				return {
					...descriptor,
					schema: redactSettingsSchema(schema),
					value: redacted.value,
					...base === void 0 ? {} : { base: redact(base).value },
					...detachedUser === void 0 ? {} : { user: redact(detachedUser).value },
					secrets: redacted.secrets
				};
			});
		}
		/**
		* Read redacted settings and deployment facts without revealing a local path.
		* @returns every registered namespace in registration order.
		*/
		remoteDescribe() {
			return {
				writable: this.writable,
				hasDocument: this.ownedDocumentPath() !== void 0,
				namespaces: this.describe({ redactSecrets: true }).map(remoteNamespaceView)
			};
		}
		/**
		* Prepare and open only the document owned by this provider.
		* @param signal - transport cancellation, including the native command.
		* @returns confirmation of the editor handoff; cancellation rejects.
		*/
		async remoteOpenDocument(signal) {
			const checkCancellation = () => {
				if (signal.aborted) throw new TypertLookupFailure({
					code: "cancelled",
					message: "settings document open was aborted",
					details: {}
				});
			};
			const fail = (message) => new TypertLookupFailure({
				code: "internal",
				message,
				details: {}
			});
			checkCancellation();
			const documentPath = this.ownedDocumentPath();
			if (documentPath === void 0) throw fail("settings provider has no local document to open");
			let preparedPath;
			try {
				preparedPath = await this.prepareDocument();
			} catch {
				checkCancellation();
				throw fail("settings document preparation failed");
			}
			checkCancellation();
			if (preparedPath !== documentPath || this.ownedDocumentPath() !== documentPath) throw fail("settings provider did not prepare its owned local document");
			try {
				await this.openDocumentInNativeEditor(documentPath, signal);
			} catch {
				checkCancellation();
				throw fail("settings document open failed");
			}
			checkCancellation();
			return { opened: true };
		}
		/**
		* Merge fields without reconstructing a redacted section.
		* @param ns - namespace to update.
		* @param patch - JSON fields to merge.
		* @param expectedRevision - revision read by the caller.
		* @returns the updated redacted namespace.
		*/
		remoteUpdate(ns, patch, expectedRevision) {
			return this.remoteWrite(ns, (namespace) => this.update(namespace, patch, expectedRevision));
		}
		/**
		* Replace the whole user layer, removing omitted overrides.
		* @param ns - namespace to replace.
		* @param section - complete new user layer, not a redacted readback.
		* @param expectedRevision - revision read by the caller.
		* @returns the updated redacted namespace.
		*/
		remoteReplace(ns, section, expectedRevision) {
			return this.remoteWrite(ns, (namespace) => this.replace(namespace, section, expectedRevision));
		}
		/**
		* Apply ordered edits while preserving untouched hidden fields.
		* @param ns - namespace to mutate.
		* @param ops - path-addressed JSON edits.
		* @param expectedRevision - revision read by the caller.
		* @returns the updated redacted namespace.
		*/
		remoteMutate(ns, ops, expectedRevision) {
			return this.remoteWrite(ns, (namespace) => this.mutate(namespace, ops, expectedRevision));
		}
		async remoteWrite(ns, write) {
			let namespace;
			try {
				namespace = settingsNamespace(ns);
				if ([...this.remoteProtectedNamespaces.values()].some((namespaces) => namespaces.has(namespace))) throw new Error("namespace writes belong to its domain transaction");
				await write(namespace);
			} catch (error) {
				if (error instanceof SettingsConflictError) throw new TypertLookupFailure({
					code: "settings-conflict",
					message: error.message,
					details: {
						ns,
						expected: error.expected,
						actual: error.actual
					}
				});
				throw new TypertLookupFailure({
					code: "settings-rejected",
					message: `settings write for "${ns}" was rejected`,
					details: { ns }
				});
			}
			const descriptor = this.describe({ redactSecrets: true }).find((candidate) => candidate.ns === namespace);
			if (descriptor === void 0) throw new TypertLookupFailure({
				code: "internal",
				message: "settings write did not complete",
				details: {}
			});
			return remoteNamespaceView(descriptor);
		}
		ownedDocumentPath() {
			const path = this.documentPath;
			return path !== void 0 && isAbsolute(path) ? path : void 0;
		}
		/**
		* Hand the provider-owned file to a native text editor, without a shell.
		* @param path - absolute provider document path.
		* @param signal - caller lifetime.
		* @returns completion of the native handoff command.
		*/
		openDocumentInNativeEditor(path, signal) {
			return openNativeTextFile(path, signal);
		}
		/**
		* Reserve generic Remote writes for namespaces with a domain transaction owner.
		* @param namespaces - this calling fiber's complete protected set; other owners retain their reservations.
		*/
		setRemoteProtectedNamespaces(namespaces) {
			const owner = this.ctx.fiber;
			if (!this.remoteProtectedNamespaces.has(owner)) this.ctx.effect(() => () => {
				this.remoteProtectedNamespaces.delete(owner);
			}, "settings.remote-domain-protection");
			this.remoteProtectedNamespaces.set(owner, new Set(namespaces));
		}
		/**
		* Wait for the owner's callbacks for an exact persisted revision.
		* @param ns - registered namespace.
		* @param revision - exact revision to observe; superseded revisions reject.
		* @returns whether every owner callback accepted the revision, not merely whether it persisted.
		*/
		async settle(ns, revision) {
			const registration = this.registrations.get(ns);
			if (registration === void 0 || !registration.active) throw new Error(`settings namespace "${ns}" is not registered`);
			if (registration.revision !== revision) throw new SettingsConflictError(ns, revision, registration.revision);
			const accepted = await registration.settlement;
			if (this.registrations.get(ns) !== registration || !isRegistrationActive(registration)) throw new Error(`settings namespace "${ns}" was disposed while revision ${String(revision)} settled`);
			if (registration.revision !== revision) throw new SettingsConflictError(ns, revision, registration.revision);
			return accepted;
		}
		/**
		* Read one registered namespace's resolved value.
		* @param ns - the namespace to read.
		* @returns the resolved value, or `undefined` while unregistered.
		*/
		get(ns) {
			return this.registrations.get(ns)?.resolved;
		}
		/**
		* Merge a patch into one registered namespace's user layer, validate the
		* resolved candidate, persist through the provider, then commit and emit.
		* A validation failure rejects before anything is persisted. Writes to one
		* namespace are serialized: concurrent updates apply in call order, each
		* merging over the previous write's committed section.
		* @param ns - the registered namespace to update.
		* @param patch - plain-object patch over the user section.
		* @param expectedRevision - the descriptor `revision` the caller read; a
		*   namespace that moved past it rejects with {@link SettingsConflictError}.
		*/
		async update(ns, patch, expectedRevision) {
			return this.write(ns, patch, "merge", expectedRevision);
		}
		/**
		* Replace one registered namespace's user section wholesale, validate,
		* persist, then commit and emit. Keys absent from `section` fall back to the
		* composition `base` and schema defaults — this is the removal/reset path a
		* merge-only patch cannot express (`replace({})` re-inherits everything).
		* @param ns - the registered namespace to replace.
		* @param section - the complete next user section.
		* @param expectedRevision - the descriptor `revision` the caller read; a
		*   namespace that moved past it rejects with {@link SettingsConflictError}.
		*/
		async replace(ns, section, expectedRevision) {
			return this.write(ns, section, "replace", expectedRevision);
		}
		/**
		* Apply path-addressed edits to one registered namespace's user section,
		* validate, persist, then commit and emit. The ops are applied to the
		* section as it stands when the write reaches the front of the queue, so a
		* caller never has to restate fields it did not touch — and, crucially,
		* cannot delete fields it never saw. This is the write path for any caller
		* holding a redacted view; `replace` remains the wholesale reset.
		* @param ns - the registered namespace to edit.
		* @param ops - ordered path edits; later ops observe earlier ones.
		* @param expectedRevision - the descriptor `revision` the caller read; a
		*   namespace that moved past it rejects with {@link SettingsConflictError}.
		*/
		async mutate(ns, ops, expectedRevision) {
			return this.write(ns, ops, "mutate", expectedRevision);
		}
		/**
		* Validate a mutation and locate its secrets before a domain owner journals it.
		* @param ns - registered namespace.
		* @param ops - proposed ordered edits; nothing is persisted.
		* @returns secret positions in the resolved candidate.
		*/
		previewMutation(ns, ops) {
			const registration = this.registrations.get(ns);
			if (registration === void 0 || !registration.active) throw new Error(`settings namespace "${ns}" is not registered`);
			const edits = cloneJsonShaped({ ops }, (label, path) => /* @__PURE__ */ new TypeError(`settings mutate for "${ns}" must contain only JSON-compatible data (found ${label} at ${path})`))["ops"];
			validateSettingsPathOps(ns, edits);
			const section = edits.reduce(applyPathOp, this.section(ns) ?? {});
			const next = this.resolve(registration.schema, registration.base, section, registration.validate);
			registration.validateWrite?.(next);
			return { secrets: (registration.redact ?? ((value) => redactSecrets(registration.schema, value)))(next).secrets };
		}
		/** Validate a write, then queue it on the namespace's serialized write chain. */
		write(ns, input, mode, expectedRevision) {
			const verb = mode === "merge" ? "update" : mode === "replace" ? "replace" : "mutate";
			const registration = this.registrations.get(ns);
			if (registration === void 0 || !registration.active) throw new Error(`settings namespace "${ns}" is not registered`);
			if (this.isStopped()) throw new Error(`settings service is disposed: "${ns}" cannot be written`);
			if (!this.writable) throw new Error(`settings provider is read-only: "${ns}" cannot be updated in-process`);
			if (expectedRevision !== void 0 && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) throw new TypeError("settings expectedRevision must be a non-negative safe integer");
			let payload;
			if (mode === "mutate") payload = { ops: input };
			else {
				if (!isPlainObject(input)) throw new TypeError(`settings ${verb} for "${ns}" must be a plain object`);
				payload = input;
			}
			const snapshot = cloneJsonShaped(payload, (label, path) => /* @__PURE__ */ new TypeError(`settings ${verb} for "${ns}" must contain only JSON-compatible data (found ${label} at ${path})`));
			let edits = [];
			if (mode === "mutate") {
				const ops = snapshot["ops"];
				validateSettingsPathOps(ns, ops);
				edits = ops;
			}
			const run = (this.writeQueues.get(ns) ?? Promise.resolve()).catch(() => void 0).then(async () => {
				if (this.isStopped()) throw new Error(`settings service was disposed before the queued "${ns}" ${verb} ran`);
				if (!registration.active || this.registrations.get(ns) !== registration) throw new Error(`settings namespace "${ns}" registration was disposed before the queued ${verb} ran`);
				const current = this.section(ns) ?? {};
				if (expectedRevision !== void 0 && expectedRevision !== registration.revision) throw new SettingsConflictError(ns, expectedRevision, registration.revision);
				const section = mode === "merge" ? mergeLayers(current, snapshot) : mode === "replace" ? snapshot : edits.reduce(applyPathOp, current);
				const next = deepFreeze(this.resolve(registration.schema, registration.base, section, registration.validate));
				registration.validateWrite?.(next);
				if (registration.revision === Number.MAX_SAFE_INTEGER && !deepEqualJson(current, section)) throw new RangeError(`settings namespace "${ns}" revision space is exhausted`);
				await this.persist(ns, section);
				this.document[ns] = section;
				if (isRegistrationActive(registration) && this.registrations.get(ns) === registration && !this.isStopped()) {
					const documentChanged = this.bumpRevision(registration, current, section);
					this.commit(registration, next, "update", documentChanged);
				}
			});
			this.writeQueues.set(ns, run);
			return run;
		}
		/**
		* Provider hook: commit a complete raw document observed in storage. Each
		* registered namespace re-resolves; an invalid section keeps that
		* namespace's last good value and warns, other namespaces still commit.
		* @param doc - the detached raw document (unregistered sections preserved).
		* @param source - change origin; defaults to `provider`.
		*/
		publish(doc, source = "provider") {
			const before = /* @__PURE__ */ new Map();
			for (const registration of this.registrations.values()) try {
				before.set(registration.ns, this.section(registration.ns));
			} catch {
				before.set(registration.ns, void 0);
			}
			this.document = doc;
			for (const registration of this.registrations.values()) {
				if (!registration.active || this.isStopped()) continue;
				let next;
				try {
					next = deepFreeze(this.resolve(registration.schema, registration.base, this.section(registration.ns), registration.validate));
				} catch (error) {
					this.ctx.logger.warn("settings: keeping last good \"%s\" after invalid stored section", registration.ns);
					this.ctx.logger.warn(error);
					continue;
				}
				const documentChanged = this.bumpRevision(registration, before.get(registration.ns), this.section(registration.ns));
				this.commit(registration, next, source, documentChanged);
			}
		}
		/** Read one namespace's raw user section, rejecting non-object sections. */
		section(ns) {
			const section = this.document[ns];
			if (section === void 0) return void 0;
			if (!isPlainObject(section)) throw new TypeError(`settings section "${ns}" must be an object of keys`);
			return section;
		}
		/** Resolve one namespace value: schema defaults, then `base`, then the user layer. */
		resolve(schema, base, section, validate) {
			const value = schema(mergeLayers(base, section));
			validate?.(value);
			return value;
		}
		/**
		* Bind settlement before any commit notification can re-enter settle().
		* Raw changes advance the revision even when the resolved value is unchanged.
		*/
		bumpRevision(registration, before, after) {
			if (deepEqualJson(before, after)) return false;
			if (registration.revision === Number.MAX_SAFE_INTEGER) throw new RangeError(`settings namespace "${registration.ns}" revision space is exhausted`);
			registration.revision += 1;
			const settlement = Promise.withResolvers();
			registration.settlement = settlement.promise;
			registration.settlementResolver = settlement.resolve;
			return true;
		}
		/** Contained fan-out of `settings/document-updated`, mirroring {@link commit}'s. */
		emitDocumentUpdated(ns, revision) {
			const registration = this.registrations.get(ns);
			let invariantFailure;
			const args = [
				"settings/document-updated",
				ns,
				revision
			];
			for (const listener of this.ctx.events.dispatch("emit", args)) {
				if (this.registrations.get(ns) !== registration || registration?.revision !== revision || !registration.active) break;
				try {
					const returned = listener(ns, revision);
					if (returned != null && typeof returned.then === "function") Promise.resolve(returned).then(void 0, (error) => {
						this.warnListenerFailure(ns, error);
					});
				} catch (error) {
					if (error?.code === "INVARIANT") {
						invariantFailure ??= error;
						continue;
					}
					this.warnListenerFailure(ns, error);
				}
			}
			if (invariantFailure !== void 0) throw invariantFailure;
		}
		/** Commit a resolved value when changed: swap, notify watchers, emit the event. */
		commit(registration, next, source, documentChanged) {
			const revision = registration.revision;
			const resolveSettlement = registration.settlementResolver;
			delete registration.settlementResolver;
			const prev = registration.resolved;
			if (deepEqualJson(next, prev)) {
				resolveSettlement?.(true);
				if (documentChanged) this.emitDocumentUpdated(registration.ns, revision);
				return;
			}
			registration.resolved = next;
			const outcomes = [];
			for (const watcher of [...registration.watchers]) {
				if (!watcher.active) continue;
				const outcome = watcher.tail.then(() => {
					if (!watcher.active || !registration.active || this.isStopped()) return;
					return watcherExecution.run({
						registration,
						watcher
					}, () => watcher.callback(next, prev));
				}).then(() => true, (error) => {
					this.warnWatcherFailure(registration.ns, error);
					return false;
				});
				outcomes.push(outcome);
				const segment = outcome.then(() => void 0);
				watcher.tail = segment;
				this.pendingTails.add(segment);
				segment.then(() => this.pendingTails.delete(segment));
			}
			Promise.all(outcomes).then((results) => resolveSettlement?.(results.every(Boolean)));
			if (documentChanged) this.emitDocumentUpdated(registration.ns, revision);
			let invariantFailure;
			const args = [
				"settings/updated",
				registration.ns,
				next,
				prev,
				source
			];
			for (const listener of this.ctx.events.dispatch("emit", args)) {
				if (this.registrations.get(registration.ns) !== registration || !registration.active || registration.resolved !== next || registration.revision !== revision) break;
				try {
					const returned = listener(registration.ns, next, prev, source);
					if (returned != null && typeof returned.then === "function") Promise.resolve(returned).then(void 0, (error) => {
						this.warnListenerFailure(registration.ns, error);
					});
				} catch (error) {
					if (error?.code === "INVARIANT") {
						invariantFailure ??= error;
						continue;
					}
					this.warnListenerFailure(registration.ns, error);
				}
			}
			if (invariantFailure !== void 0) throw invariantFailure;
		}
		/** Contained-watcher diagnostic shared by the sync and async failure paths. */
		warnWatcherFailure(ns, error) {
			this.ctx.logger.warn("settings: watcher for \"%s\" failed", ns);
			this.ctx.logger.warn(error);
		}
		/** Contained-listener diagnostic shared by the sync and async failure paths. */
		warnListenerFailure(ns, error) {
			this.ctx.logger.warn("settings: a settings/updated listener for \"%s\" failed", ns);
			this.ctx.logger.warn(error);
		}
	};
})();
/**
* Project an already-redacted descriptor as detached, lossless Remote data.
* @param descriptor - descriptor obtained with secret redaction enabled.
* @returns a namespace view that carries no provider-owned object references.
*/
function remoteNamespaceView(descriptor) {
	return {
		ns: String(descriptor.ns),
		schema: snapshotSettingsJson(descriptor.schema),
		value: snapshotSettingsJson(descriptor.value),
		...descriptor.base === void 0 ? {} : { base: snapshotSettingsJson(descriptor.base) },
		...descriptor.user === void 0 ? {} : { user: snapshotSettingsJson(descriptor.user) },
		applies: descriptor.applies,
		secrets: (descriptor.secrets ?? []).map((secret) => ({
			path: [...secret.path],
			set: secret.set
		})),
		revision: descriptor.revision
	};
}
/**
* Detach lossless JSON through the same validator used by settings writes.
* This does not redact secrets; callers own whether the input may cross a wire or journal.
* @param value - JSON-compatible input to snapshot before asynchronous work.
* @returns a detached value; unsupported numbers, sparse arrays and cycles reject.
*/
function snapshotSettingsJson(value) {
	const detached = cloneJsonShaped({ value }, () => /* @__PURE__ */ new TypeError("settings descriptor contains non-JSON data"))["value"];
	if (detached === void 0) throw new TypeError("settings descriptor contains non-JSON data");
	return detached;
}
//#endregion
//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `@deepseek-ai/dsh-settings`.
* @module @deepseek-ai/dsh-settings/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-settings";
/** Cordis companion plugin name. */
const name = "settings-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
* Install the commit-event contract: `settings/updated` fires only for a
* currently registered namespace, only when the resolved value changed, and
* only with the service's authoritative resolved value — all judged with the
* seam's own equality predicate.
*/
const install = (ctx, fail) => {
	ctx.on("settings/updated", (ns, next, prev) => {
		const settings = ctx.get("settings");
		if (settings === void 0) fail(`settings/updated for "${ns}" emitted without a live settings service`);
		const current = settings.get(ns);
		if (current === void 0) fail(`settings/updated for "${ns}" emitted while the namespace is unregistered`);
		if (!deepEqualJson(current, next)) fail(`settings/updated for "${ns}" does not match the authoritative resolved value`);
		if (deepEqualJson(next, prev)) fail(`settings/updated for "${ns}" emitted without a resolved-value change`);
	});
};
/**
* Register this package's invariant companion.
* @param ctx - Cordis context carrying the invariant service.
* @returns the installed registration's disposer after setup succeeds.
*/
const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
//#endregion
export { apply, inject, name };
