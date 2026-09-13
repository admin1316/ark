import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import { z as z$1 } from "zod";
import "@deepseek-ai/dsh-agent";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
//#region lib/types/session-selection.js
/** Durable model-selection intent and request-use projection. */
const modelSelectionSchema = z$1.object({
	provider: z$1.string().min(1),
	model: z$1.string().min(1),
	reasoningEffort: z$1.string().min(1).optional()
}).transform(({ provider, model, reasoningEffort }) => ({
	provider,
	model,
	...reasoningEffort === void 0 ? {} : { reasoningEffort }
}));
const modelSelectionProjectionStateSchema = z$1.object({
	lastUsed: modelSelectionSchema.nullable(),
	pending: modelSelectionSchema.nullable()
});
const modelSelectionProjectionSchema = z$1.object({
	lastUsed: modelSelectionSchema.nullable(),
	next: modelSelectionSchema.nullable()
});
/**
* Advance durable model-selection state by one Session event.
* @param state - selection state before the event.
* @param event - next committed Session event.
* @returns the original or advanced selection state.
*/
function applyModelSelectionProjection(state, event) {
	if (event.type === "model/selection") return sameSelection(state.pending, event.data) ? state : {
		lastUsed: state.lastUsed,
		pending: event.data
	};
	if (event.type !== "request/header") return state;
	const lastUsed = {
		provider: event.data.header.config.provider,
		model: event.data.header.config.model,
		...event.data.header.config.reasoningEffort === void 0 ? {} : { reasoningEffort: String(event.data.header.config.reasoningEffort) }
	};
	const pending = sameSelection(state.pending, lastUsed) ? null : state.pending;
	return sameSelection(state.lastUsed, lastUsed) && pending === state.pending ? state : {
		lastUsed,
		pending
	};
}
const modelSelectionProjection = {
	key: "modelSelection",
	stateSchema: modelSelectionProjectionStateSchema,
	init: () => ({
		lastUsed: null,
		pending: null
	}),
	apply: applyModelSelectionProjection,
	wire: {
		viewSchema: modelSelectionProjectionSchema,
		view: (state) => ({
			lastUsed: state.lastUsed,
			next: state.pending ?? state.lastUsed
		})
	},
	stateVersion: 2
};
function sameSelection(left, right) {
	return left === right || left !== null && right !== null && left.provider === right.provider && left.model === right.model && left.reasoningEffort === right.reasoningEffort;
}
/**
* Register the durable model-selection projection when the registry is present.
* @param ctx - neutral model owner with a mounted projection registry.
*/
function installModelSelectionProjection(ctx) {
	ctx.sessionProjections.register(modelSelectionProjection);
}
//#endregion
//#region lib/types/index.js
/**
* Default model selection for an Agent without a session-specific selection.
*
* @module @deepseek-ai/dsh-agent-default-model
*/
/** Settings namespace carrying the default model selection for future Agents. */
const AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE = settingsNamespace("agent-default-model");
/** Schema of the default Agent model settings section. */
const AGENT_DEFAULT_MODEL_SETTINGS_SCHEMA = z.object({
	provider: z.string().required(),
	model: z.string().required(),
	reasoningEffort: z.string()
});
/** Project stored settings onto the Agent-facing selection type. */
function selection(settings) {
	return {
		provider: settings.provider,
		model: settings.model,
		...settings.reasoningEffort === void 0 ? {} : { reasoningEffort: ReasoningEffortId(settings.reasoningEffort) }
	};
}
/**
* Owns the default model selection independently of any Host or transport.
* The composition entry remains usable without a settings provider; when one
* is mounted, its user layer is read live.
*/
var AgentDefaultModelConfig = class extends Service {
	static Config = z.object({
		provider: z.string().required(),
		model: z.string().required()
	});
	source;
	constructor(ctx, config) {
		super(ctx, "agentDefaultModel");
		ctx.inject(["sessionProjections"], installModelSelectionProjection);
		const entry = {
			provider: config.provider,
			model: config.model
		};
		this.source = () => entry;
		installSettingsSection(ctx, AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE, AGENT_DEFAULT_MODEL_SETTINGS_SCHEMA, entry, {
			setSource: (current) => {
				this.source = current;
			},
			onChange: () => {}
		});
	}
	/**
	* Read the current default model selection.
	* @returns a detached provider, model, and optional reasoning selection.
	*/
	currentSelection() {
		return selection(this.source());
	}
	/**
	* Save the complete default model selection. A deployment without a settings
	* provider keeps its composition entry.
	* @param next - resolved selection accepted by an entry point.
	* @returns fulfillment after the optional settings write settles.
	*/
	async saveSelection(next) {
		await this.ctx.get("settings")?.replace(AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE, {
			provider: next.provider,
			model: next.model,
			...next.reasoningEffort === void 0 ? {} : { reasoningEffort: String(next.reasoningEffort) }
		});
	}
};
//#endregion
export { AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE, AGENT_DEFAULT_MODEL_SETTINGS_SCHEMA, AgentDefaultModelConfig, AgentDefaultModelConfig as default };
