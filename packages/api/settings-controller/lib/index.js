import { dirname } from "node:path";
import Schema from "@deepseek-ai/schemastery";
import { InvalidPresetIdError, PresetExistsError, PresetNotWritableError, UnknownPresetError } from "@deepseek-ai/dsh-agent-presets";
import { canOpenNativePath, openNativePath } from "@deepseek-ai/dsh-native-command";
import { Remote, TypertRemoteFailure, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
//#region lib/types/index.js
/**
* Host desktop actions supplementing the canonical settings and credentials
* Remote owners on their storage Services.
* @module @deepseek-ai/dsh-api-settings-controller
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
/** Host desktop actions; settings reads and writes belong to SettingsProvider. */
let SettingsController = (() => {
	let _classSuper = TypertRemoteService;
	let _instanceExtraInitializers = [];
	let _canOpenAgentPresetDirectory_decorators;
	let _openSettingsDocument_decorators;
	let _openAgentPresetDirectory_decorators;
	return class SettingsController extends _classSuper {
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_canOpenAgentPresetDirectory_decorators = [Remote];
			_openSettingsDocument_decorators = [Remote];
			_openAgentPresetDirectory_decorators = [Remote];
			__esDecorate(this, null, _canOpenAgentPresetDirectory_decorators, {
				kind: "method",
				name: "canOpenAgentPresetDirectory",
				static: false,
				private: false,
				access: {
					has: (obj) => "canOpenAgentPresetDirectory" in obj,
					get: (obj) => obj.canOpenAgentPresetDirectory
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _openSettingsDocument_decorators, {
				kind: "method",
				name: "openSettingsDocument",
				static: false,
				private: false,
				access: {
					has: (obj) => "openSettingsDocument" in obj,
					get: (obj) => obj.openSettingsDocument
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _openAgentPresetDirectory_decorators, {
				kind: "method",
				name: "openAgentPresetDirectory",
				static: false,
				private: false,
				access: {
					has: (obj) => "openAgentPresetDirectory" in obj,
					get: (obj) => obj.openAgentPresetDirectory
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
		static Config = Schema.object({ nativeOpen: Schema.boolean() });
		openPath = __runInitializers(this, _instanceExtraInitializers);
		canOpenPath;
		/** Mount desktop actions alongside the provider-owned Remote namespace. */
		constructor(ctx, config = {}, internals = {}) {
			super(ctx, "settingsController", { namespace: "settings" });
			this.openPath = internals.openPath ?? openNativePath;
			this.canOpenPath = internals.canOpenPath ?? (() => config.nativeOpen ?? (internals.openPath !== void 0 || canOpenNativePath()));
		}
		/**
		* Report whether this deployment can open an authored Agent preset directory natively.
		* @returns true when the matching open operation is available.
		*/
		canOpenAgentPresetDirectory() {
			return this.canOpenPath();
		}
		/**
		* Materialize the provider-owned settings document and open it in a native text editor.
		* @param signal - caller lifetime; abort terminates preparation or the native command.
		* @returns confirmation after the native opener accepts the document.
		* @throws TypertRemoteFailure when no document exists, preparation fails, or opening fails.
		*/
		async openSettingsDocument(signal) {
			return this.provider().remoteOpenDocument(signal);
		}
		/**
		* Open one user-authored Agent preset directory or return its path when no native opener exists.
		* @param agentPreset - preset id resolved against Host-owned roots.
		* @param signal - caller lifetime; abort terminates the native command.
		* @returns an opened confirmation or the resolved directory for text display.
		* @throws TypertRemoteFailure when the preset is missing, read-only, invalid, or cannot be opened.
		*/
		async openAgentPresetDirectory(agentPreset, signal) {
			if (agentPreset.length === 0) throw new TypertRemoteFailure({
				code: "bad-request",
				message: "agent preset id must not be empty",
				details: {}
			});
			const presets = this.ctx.get("agentPresets");
			if (presets === void 0) throw new TypertRemoteFailure({
				code: "agent-preset-not-found",
				message: "this deployment composes no agent presets",
				details: {
					agentPreset,
					available: []
				}
			});
			let directory;
			try {
				const preset = await presets.resolve(agentPreset);
				if (preset.trust !== "user") throw new PresetNotWritableError(preset.id, "it ships with the deployment");
				directory = dirname(preset.path);
			} catch (error) {
				throw presetFailure(agentPreset, error);
			}
			if (!this.canOpenPath()) return {
				opened: false,
				path: directory
			};
			try {
				await this.openPath(directory, signal);
				return { opened: true };
			} catch (error) {
				if (signal.aborted) throw cancelled("path open was aborted");
				throw internal(`path open failed: ${messageOf(error)}`);
			}
		}
		/** Resolve the optional provider or report how to supply it. */
		provider() {
			const settings = this.ctx.get("settings");
			if (settings === void 0) throw new TypertRemoteFailure({
				code: "internal",
				message: "settings service is absent: this deployment does not mount a settings provider (e.g. @deepseek-ai/dsh-settings-file) in its composition",
				details: {}
			});
			return settings;
		}
	};
})();
function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}
function internal(message) {
	return new TypertRemoteFailure({
		code: "internal",
		message,
		details: {}
	});
}
function cancelled(message) {
	return new TypertRemoteFailure({
		code: "cancelled",
		message,
		details: {}
	});
}
function presetFailure(agentPreset, error) {
	if (error instanceof UnknownPresetError) return new TypertRemoteFailure({
		code: "agent-preset-not-found",
		message: error.message,
		details: {
			agentPreset: error.presetId,
			available: [...error.available]
		}
	});
	if (error instanceof PresetNotWritableError) return new TypertRemoteFailure({
		code: "agent-preset-read-only",
		message: error.message,
		details: {
			agentPreset,
			reason: error.message
		}
	});
	if (error instanceof InvalidPresetIdError || error instanceof PresetExistsError) return new TypertRemoteFailure({
		code: "agent-preset-invalid",
		message: error.message,
		details: {
			agentPreset,
			reason: error.message
		}
	});
	if (error instanceof TypertRemoteFailure) return error;
	return internal(`agent preset "${agentPreset}": ${String(error)}`);
}
//#endregion
export { SettingsController, SettingsController as default };
