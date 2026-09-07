import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import "@deepseek-ai/dsh-llm";
//#region lib/types/model-selection.js
/** Schema shared by the Host setting and its deployment base. */
const AllowedModelRouteSchema = z.object({
	provider: z.string().min(1).required(),
	model: z.string().min(1).required()
});
/**
* Stable identity for one provider/model pair.
* @param route - The route input.
* @returns The value produced by model route key.
*/
function modelRouteKey(route) {
	return `${route.provider}\0${route.model}`;
}
/**
* Reject malformed or duplicate route policy entries at a boundary.
* @param routes - The routes input.
* @returns The value produced by assert allowed model routes.
*/
function assertAllowedModelRoutes(routes) {
	if (!Array.isArray(routes)) throw new Error("subagent model selection requires an array of routes");
	const seen = /* @__PURE__ */ new Set();
	for (const candidate of routes) {
		if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate) || !("provider" in candidate) || typeof candidate.provider !== "string" || !("model" in candidate) || typeof candidate.model !== "string" || candidate.provider.length === 0 || candidate.model.length === 0) throw new Error("subagent model selection requires non-empty provider and model ids");
		const route = {
			provider: candidate.provider,
			model: candidate.model
		};
		const key = modelRouteKey(route);
		if (seen.has(key)) throw new Error(`subagent model selection repeats route "${route.provider}/${route.model}"`);
		seen.add(key);
	}
}
//#endregion
//#region lib/types/model-selection-settings.js
/** Host-owned opt-in setting for model-selectable subagent delegation. */
/** User-settings namespace for the model-selection authority. */
const SUBAGENT_MODEL_SELECTION_SETTINGS_NAMESPACE = settingsNamespace("subagent-model-selection");
/**
* Defines the subagent model selection settings schema constant used by this package.
*/
const SUBAGENT_MODEL_SELECTION_SETTINGS_SCHEMA = z.object({
	enabled: z.boolean().default(false),
	allowedModels: z.array(AllowedModelRouteSchema).default([])
});
/** Singleton settings owner sampled when a new eligible Agent is published. */
var SubagentModelSelectionConfig = class extends Service {
	static Config = z.object({
		enabled: z.boolean().default(false),
		allowedModels: z.array(AllowedModelRouteSchema).default([])
	});
	source;
	constructor(ctx, config = {}) {
		super(ctx, "subagentModelSelection");
		const entry = {
			enabled: config.enabled ?? false,
			allowedModels: config.allowedModels ?? []
		};
		this.validate(entry);
		this.source = () => entry;
		installSettingsSection(ctx, SUBAGENT_MODEL_SELECTION_SETTINGS_NAMESPACE, SUBAGENT_MODEL_SELECTION_SETTINGS_SCHEMA, entry, {
			setSource: (source) => {
				this.source = source;
			},
			validate: (value) => {
				this.validate(value);
			},
			onChange: () => {}
		});
	}
	/**
	* Read the current model-selection authority as a detached snapshot.
	* @returns the enabled flag and detached allowed-model routes.
	*/
	current() {
		const current = this.source();
		return {
			enabled: current.enabled,
			allowedModels: current.allowedModels.map((route) => ({ ...route }))
		};
	}
	validate(value) {
		assertAllowedModelRoutes(value.allowedModels);
		if (value.enabled && value.allowedModels.length === 0) throw new Error("enabled subagent model selection requires at least one allowed model");
	}
};
const name = "subagent-model-selection-settings";
//#endregion
export { SUBAGENT_MODEL_SELECTION_SETTINGS_NAMESPACE, SUBAGENT_MODEL_SELECTION_SETTINGS_SCHEMA, SubagentModelSelectionConfig, SubagentModelSelectionConfig as default, name };
