import { createHash } from "node:crypto";
import { Remote, TypertLookupFailure, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
//#region lib/types/index.js
/**
* Service Definition for the credential-reference capability seam (`ctx.credentials`). Settings and composition files carry
* *references* to secrets — environment-variable names — while providers own
* the actual values and their storage. Consumers resolve a reference once per
* operation, so a changed credential reaches the next operation without any
* plugin restart, and configuration surfaces describe a reference without
* ever seeing its value.
* @module @deepseek-ai/dsh-credentials
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
const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Both halves of a {@link CredentialKey}; the `/` between them is what keeps it out of {@link REF_PATTERN}. */
const KEY_SEGMENT_PATTERN = /^[a-z][a-z0-9-]*$/;
/**
* Brand a raw string as a {@link CredentialRef}.
* @param value - candidate reference; a POSIX shell identifier such as `DEEPSEEK_API_KEY`.
* @returns the branded reference.
*/
function credentialRef(value) {
	if (!isCredentialRefName(value)) throw new TypeError(`credential ref "${value}" must match ${String(REF_PATTERN)}`);
	return value;
}
/**
* Whether a raw string could name a reference at all. Consumers that receive
* environment-variable names from somewhere else — a provider library's own
* ambient discovery, a hook payload — ask this before resolving, because a name
* outside the grammar has no reference to miss and should read as "not set"
* rather than as a thrown error.
* @param value - candidate reference.
* @returns true when {@link credentialRef} would accept it.
*/
function isCredentialRefName(value) {
	return REF_PATTERN.test(value);
}
/**
* Whether a raw string could be a {@link credentialKey} segment at all.
* Consumers whose addressing units come from somewhere else — a settings dict
* key, a library's own provider id — ask this before building a key, because a
* unit outside the grammar can never have stored a record and should read as
* "nothing stored" rather than as a thrown error.
* @param value - candidate segment.
* @returns true when {@link credentialKey} would accept it as either segment.
*/
function isCredentialKeySegment(value) {
	return KEY_SEGMENT_PATTERN.test(value);
}
/**
* Brand a scope and an id as a {@link CredentialKey}.
* @param scope - the owning plugin's registered name, such as `llm-pi-ai`.
* @param id - that plugin's own addressing unit, such as a provider route key.
* @returns the branded key.
* @throws TypeError when either segment is not a lowercase hyphenated identifier.
*/
function credentialKey(scope, id) {
	for (const segment of [scope, id]) if (!KEY_SEGMENT_PATTERN.test(segment)) throw new TypeError(`credential key segment "${segment}" must match ${String(KEY_SEGMENT_PATTERN)}`);
	return `${scope}/${id}`;
}
/**
* Brand a stored `<scope>/<id>` string as a {@link CredentialKey}. This is the
* read half of {@link credentialKey}, for a provider admitting keys off disk.
* @param value - candidate key in its joined form.
* @returns the branded key.
* @throws TypeError when the value is not exactly two valid segments.
*/
function parseCredentialKey(value) {
	const segments = value.split("/");
	const [scope, id] = segments;
	if (segments.length !== 2 || scope === void 0 || id === void 0) throw new TypeError(`credential key "${value}" must be "<scope>/<id>"`);
	return credentialKey(scope, id);
}
/**
* The owning plugin's name for one key. A record whose scope names no
* currently registered owner is an orphan, which a configuration surface must
* report as such rather than as a working credential.
* @param key - the key to read.
* @returns the scope segment.
*/
function credentialKeyScope(key) {
	return key.slice(0, key.indexOf("/"));
}
/**
* The owning plugin's own addressing unit for one key — the half that plugin
* chose, such as a provider route.
* @param key - the key to read.
* @returns the id segment.
*/
function credentialKeyId(key) {
	return key.slice(key.indexOf("/") + 1);
}
/** The reference changed before its conditional write; no requested write occurred. */
var CredentialConflictError = class extends Error {
	ref;
	/** @param ref - the reference whose condition no longer holds. */
	constructor(ref) {
		super(`credential reference "${ref}" changed before its conditional write`);
		this.ref = ref;
		this.name = "CredentialConflictError";
	}
};
/**
* Capture a reference's value and source without retaining its secret.
* @param current - the resolved reference, or absence.
* @returns the condition for a later provider-owned conditional write.
*/
function credentialCondition(current) {
	return current === void 0 ? { valueDigest: null } : {
		valueDigest: createHash("sha256").update(current.value).digest("hex"),
		source: current.source
	};
}
/**
* Check a conditional write while the provider holds its write exclusion.
* @param ref - the reference being checked.
* @param current - its current resolved value.
* @param expected - the required value digest and optional source.
* @returns nothing when the condition matches.
* @throws CredentialConflictError without including secret values or digests.
*/
function assertCredentialCondition(ref, current, expected) {
	const actual = credentialCondition(current);
	if (actual.valueDigest !== expected.valueDigest || expected.source !== void 0 && actual.source !== expected.source) throw new CredentialConflictError(ref);
}
/**
* Abstract credential service over two key spaces that answer two questions.
*
* A {@link CredentialRef} answers "what is behind this environment-variable
* name", layered over the process environment, the provider-managed store, and
* `.env` files. One seam-wide rule binds that half: an empty stored value is
* absent everywhere — `resolve` skips it, `describe` reports it unconfigured —
* so a blank never masquerades as a configured secret.
*
* A {@link CredentialKey} answers "what credential does this plugin hold for
* this id". Nothing can layer here — an authorization grant has no
* environment to be read from — so presence of the record is the whole fact,
* and {@link modifyRecord} is the only write path because a correct write
* depends on the current value (a token refresh is read-decide-replace under
* one lock).
*/
let CredentialProvider = (() => {
	let _classSuper = TypertRemoteService;
	let _instanceExtraInitializers = [];
	let _remoteDescribe_decorators;
	let _remoteSet_decorators;
	let _remoteUnset_decorators;
	return class CredentialProvider extends _classSuper {
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_remoteDescribe_decorators = [Remote("describe")];
			_remoteSet_decorators = [Remote("set")];
			_remoteUnset_decorators = [Remote("unset")];
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
			__esDecorate(this, null, _remoteSet_decorators, {
				kind: "method",
				name: "remoteSet",
				static: false,
				private: false,
				access: {
					has: (obj) => "remoteSet" in obj,
					get: (obj) => obj.remoteSet
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _remoteUnset_decorators, {
				kind: "method",
				name: "remoteUnset",
				static: false,
				private: false,
				access: {
					has: (obj) => "remoteUnset" in obj,
					get: (obj) => obj.remoteUnset
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
			super(ctx, "credentials");
			__runInitializers(this, _instanceExtraInitializers);
		}
		/**
		* Describe named references without returning any credential value.
		* There is intentionally no Remote enumeration endpoint: settings schemas
		* remain the authority that tells a configuration surface which refs exist.
		* @param refs - credential reference names to describe.
		* @returns redacted metadata for each requested reference.
		*/
		async remoteDescribe(refs) {
			const entries = await Promise.all(refs.map(async (name) => {
				let ref;
				try {
					ref = credentialRef(name);
				} catch (error) {
					remoteCredentialInputFailure(error, { ref: name });
				}
				try {
					const info = await this.describe(ref);
					return [name, {
						configured: info.configured,
						...info.source === void 0 ? {} : { source: info.source },
						writable: info.writable
					}];
				} catch {
					remoteCredentialRejected({ ref: name });
				}
			}));
			return { credentials: Object.fromEntries(entries) };
		}
		/**
		* Store one write-only credential value through the Native Remote plane.
		* @param refName - credential reference name to update.
		* @param value - write-only credential value.
		* @returns an empty object after the value is stored.
		*/
		async remoteSet(refName, value) {
			let ref;
			try {
				ref = credentialRef(refName);
			} catch (error) {
				remoteCredentialInputFailure(error, { ref: refName });
			}
			try {
				await this.set(ref, value);
			} catch {
				remoteCredentialRejected({ ref: refName });
			}
			return {};
		}
		/**
		* Remove one provider-managed credential through the Native Remote plane.
		* @param refName - credential reference name to remove.
		* @returns an empty object after the reference is removed.
		*/
		async remoteUnset(refName) {
			let ref;
			try {
				ref = credentialRef(refName);
			} catch (error) {
				remoteCredentialInputFailure(error, { ref: refName });
			}
			try {
				await this.unset(ref);
			} catch {
				remoteCredentialRejected({ ref: refName });
			}
			return {};
		}
		/**
		* Fan `credentials/reference-updated` out with contained listener failures: every
		* listener runs, and a sync throw or async rejection is logged without
		* changing the committed operation's outcome — except `INVARIANT`-coded
		* failures, which rethrow after every listener ran (the rethrow reaches the
		* caller only from synchronous listeners, so invariant checks on this event
		* must not be async functions). Providers call this only after the write or
		* reload actually committed, so a broken observer can never make a durable
		* change look failed.
		* @param ref - the reference whose stored value changed.
		*/
		notifyUpdated(ref) {
			this.fanOut("credentials/reference-updated", ref);
		}
		/**
		* Fan `credentials/record-updated` out on exactly the terms
		* {@link notifyUpdated} documents, for the record half of the seam.
		* @param key - the record whose stored value changed.
		*/
		notifyRecordUpdated(key) {
			this.fanOut("credentials/record-updated", key);
		}
		/** The contained dispatch both notifications run through; see {@link notifyUpdated}. */
		fanOut(event, subject) {
			let invariantFailure;
			const args = [event, subject];
			for (const listener of this.ctx.events.dispatch("emit", args)) try {
				const returned = listener(subject);
				if (returned != null && typeof returned.then === "function") Promise.resolve(returned).then(void 0, (error) => {
					this.warnListenerFailure(event, subject, error);
				});
			} catch (error) {
				if (error?.code === "INVARIANT") {
					invariantFailure ??= error;
					continue;
				}
				this.warnListenerFailure(event, subject, error);
			}
			if (invariantFailure !== void 0) throw invariantFailure;
		}
		/** Contained-listener diagnostic shared by the sync and async failure paths. */
		warnListenerFailure(event, subject, error) {
			this.ctx.logger.warn("credentials: a %s listener for \"%s\" failed", event, subject);
			this.ctx.logger.warn(error);
		}
	};
})();
/** Throw a transport-safe invalid-input failure from credentialRef's guaranteed TypeError. */
function remoteCredentialInputFailure(error, details) {
	throw new TypertLookupFailure({
		code: "input-invalid",
		message: error.message,
		details
	});
}
/** Throw a transport-safe provider failure without reflecting a secret-bearing cause. */
function remoteCredentialRejected(details) {
	throw new TypertLookupFailure({
		code: "credential-rejected",
		message: `credential "${details.ref}" was rejected`,
		details
	});
}
//#endregion
export { CredentialConflictError, CredentialProvider, CredentialProvider as default, assertCredentialCondition, credentialCondition, credentialKey, credentialKeyId, credentialKeyScope, credentialRef, isCredentialKeySegment, isCredentialRefName, parseCredentialKey };
