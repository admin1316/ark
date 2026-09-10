import { leakedServices, livePresetMounts } from "@deepseek-ai/dsh-agent-presets";
//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `@deepseek-ai/dsh-agent-presets`.
* @module @deepseek-ai/dsh-agent-presets/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-agent-presets";
/** Cordis companion plugin name. */
const name = "agent-presets-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
* Assert that no installed preset composition reaches the root service realm,
* and that a deployment configuring a roster composes every agent from it.
*
* `mountPreset` proves the first once, when the subtree settles. A row that
* publishes later — from a timer, or an asynchronous continuation after its
* plugin returned — would escape that one-shot audit, so re-check every live
* mount whenever a service registration changes.
*/
const install = (ctx, fail) => {
	ctx.on("internal/service", function(name) {
		for (const mount of livePresetMounts()) {
			const leaked = leakedServices(ctx, mount.fiber);
			if (leaked.length === 0) continue;
			fail(`preset "${mount.presetId}" published process-global service(s) [${leaked.join(", ")}] after its mount was audited (observed while notifying "${name}") — a preset service must sit behind an \`isolate\` realm or move to the host composition`);
		}
	}, { global: true });
	ctx.on("system-prompt/assemble", (_assembly, context, next) => {
		const presets = ctx.get("agentPresets");
		const agent = context.agent;
		if (presets !== void 0 && presets.roots.length > 0 && agent !== void 0 && presets.composedPreset(agent.ctx) === void 0) fail(`agent "${agent.id}" addressed a model without joining any agent preset while a roster is composed; its tools, prompt sections, and skill catalog resolve against the empty global layer`);
		return next();
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
