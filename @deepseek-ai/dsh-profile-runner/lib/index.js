import { createProcessShutdown } from "./process-shutdown.js";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PROFILE_PATCH_FILENAME, boot, composeEntries, healProfilesModuleFallback, installFailLoud, loadOptionalPatches, loadOverlayPatches, loadProfile, watchUserPatches } from "@deepseek-ai/dsh-app-boot";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { DSH_LAUNCH_ENVIRONMENT_KEY } from "@deepseek-ai/dsh-launch-environment";
import { provideCmdline } from "@deepseek-ai/dsh-cmdline";
//#region lib/types/index.js
/**
* Shared profile boot for every `dsh` surface: resolve the profile, stack its
* patch layers (bundle layers in `dsh.profile.bundles` order, the profile's
* own `cordis.patch.yml`, `--patch` overlays, the telemetry switch), mount the
* tree over the profile's empty root config, optionally keep user patch layers
* live, and wire fail-loud plus bounded shutdown.
*
* App flags are not the launcher's business: the invocation's inner arguments
* are provided to the tree through `ctx.cmdlineArgs`, where any injected app
* plugin may read the same immutable snapshot.
* @module @deepseek-ai/dsh-profile-runner
*/
/** Canonical shipped agent-preset root, shared by every profile-running application. */
const SHIPPED_PRESET_ROOT = fileURLToPath(new URL("../config/agent-presets/", import.meta.url));
const NAME = "dsh";
/**
* The home-level user patch layer (`$DSH_HOME/cordis.patch.yml`), applied
* over every profile's own layer. Resolved per call, not at module load:
* `$DSH_HOME` may be set by the test or launcher after import.
* @returns the absolute patch-file path.
*/
function homePatchPath() {
	return join(resolveDshHome(), PROFILE_PATCH_FILENAME);
}
/** The session-telemetry row id the DSH_TELEMETRY_DISABLED switch targets. */
const TELEMETRY_ROW_ID = "session-telemetry-otel";
/** The empty root entry list every profile tree patches over. */
const PROFILE_ROOT_CONFIG = `# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
`;
/** Root config filename inside a profile directory. */
const PROFILE_ROOT_FILENAME = "cordis.yml";
/**
* Resolve the telemetry opt-out switch into its boot patch. ANY non-empty
* value (including `'0'`/`'false'`) disables: a privacy switch prefers
* off-by-mistake over on-by-mistake. A composition without the telemetry row
* exports nothing, so the switch is then trivially satisfied and no patch is
* generated — custom profiles need not mount telemetry to run with the
* switch set.
* @param disabledEnv - the raw `DSH_TELEMETRY_DISABLED` value (`undefined` when unset).
* @param hasRow - whether the composition carries the telemetry row.
* @returns the disable patch, or `undefined` when no hard-disable patch is required.
*/
function resolveTelemetryPatch(disabledEnv, hasRow) {
	if ((disabledEnv ?? "") === "" || !hasRow) return void 0;
	return {
		id: TELEMETRY_ROW_ID,
		disabled: true
	};
}
/**
* Load a resolved profile for `name`: heal the shared module fallback, then
* (re)write the empty root config. The root is always rewritten: the whole
* composition is patch layers, and the vendored Loader's tree write-back (a
* plugin self-disposing persists the current tree) can bake composed rows
* into this file — which would duplicate every bundle insert on the next
* boot. The file exists on disk only because the Loader needs a real include
* root to anchor `baseUrl` at the profile directory (the config dump anchors
* on the same file, so both compose over the identical base).
* @param name - the profile name.
* @param installAnchor - Absolute package.json path of the application that owns the profile installation.
* @param userLayer - `false` skips parsing `cordis.patch.yml` (the default dump).
* @returns the loaded profile.
*/
function prepareProfile(name, installAnchor, userLayer = true) {
	healProfilesModuleFallback(installAnchor);
	const profile = loadProfile(NAME, name, installAnchor, void 0, { userLayer });
	writeFileSync(join(profile.dir, PROFILE_ROOT_FILENAME), PROFILE_ROOT_CONFIG);
	return profile;
}
/** The full patch stack of one composed profile, in application order. */
function allPatches(composed) {
	return [
		...composed.bundlePatches,
		...composed.profilePatches,
		...composed.homePatches,
		...composed.overlays
	];
}
/**
* Load `name` and compose its effective patch stack: bundle layers in
* `dsh.profile.bundles` order (the base bundle gates the shell stacks by
* platform on its own rows), the profile's user layer, the home-level user
* layer (`$DSH_HOME/cordis.patch.yml` — machine-local preferences that apply
* to every profile, so it outranks the per-profile layer), `--patch` overlays,
* then the telemetry switch.
* @param name - the profile name.
* @param installAnchor - Absolute package.json path of the owning application.
* @param patchFiles - `--patch` overlay paths, in argv order.
* @param additionalSystemPresetRoots - Application-specific preset roots layered beside the shared root.
* @returns the profile, its patch layers, and the composed row index.
*/
function composeProfile(name, installAnchor, patchFiles, additionalSystemPresetRoots, profilePatchMode, homePatchMode) {
	const profile = prepareProfile(name, installAnchor, profilePatchMode === "user");
	const profilePatches = profilePatchMode === "managed" ? loadOverlayPatches(NAME, profile.patchPath) : profile.patches;
	const homePatches = homePatchMode === "user" ? loadOptionalPatches(NAME, homePatchPath()) ?? [] : [];
	const overlays = patchFiles.flatMap((file) => loadOverlayPatches(NAME, resolve(file)));
	const bundlePatches = profile.layers.flatMap((layer) => layer.patches);
	const rows = /* @__PURE__ */ new Map();
	for (const row of composeEntries([
		bundlePatches,
		profilePatches,
		homePatches,
		overlays
	])) if (typeof row.id === "string") rows.set(row.id, row);
	const composedOverlays = [...overlays];
	if (rows.has("agent-presets")) {
		const systemPresetRoots = [...new Set([SHIPPED_PRESET_ROOT, ...additionalSystemPresetRoots])];
		composedOverlays.push({
			id: "agent-presets",
			config: {
				...rows.get("agent-presets")?.config ?? {},
				roots: systemPresetRoots.map((path) => ({
					path,
					trust: "system"
				}))
			}
		});
	}
	const telemetryPatch = resolveTelemetryPatch(process.env.DSH_TELEMETRY_DISABLED, rows.has(TELEMETRY_ROW_ID));
	if (telemetryPatch !== void 0) composedOverlays.push(telemetryPatch);
	return {
		profile,
		bundlePatches,
		profilePatches,
		homePatches,
		overlays: composedOverlays,
		rows
	};
}
/**
* Re-throw a watcher-setup failure unless a shutdown already owns the tree:
* a signal aborted this invocation, or an app requested exit (`ctx.appExit`
* from a fast one-shot) and the root's disposal rejected the in-flight setup
* await. Either way the failure describes a tree that is exiting as asked,
* not a broken watch.
* @param ctx - the booted root context.
* @param signal - this invocation's signal-shutdown fact.
* @param error - the setup failure.
*/
function suppressShutdownError(ctx, signal, error) {
	if (signal.aborted) return;
	if (ctx.fiber.state !== 2 || ctx.get("loader") === void 0) return;
	throw error;
}
/**
* Boot one profile invocation end to end and leave process lifetime to the
* mounted plugins (or to a one-shot runner the composition mounts).
* @param options - environment snapshot, profile name, overlays, and the booted app's own arguments.
* @returns the settled root context and the shutdown controller.
*/
async function runProfile(options) {
	const composed = composeProfile(options.profile, options.installAnchor, options.patchFiles, options.additionalSystemPresetRoots ?? [], options.profilePatchMode ?? "user", options.homePatchMode ?? "user");
	const app = {};
	const shutdown = createProcessShutdown(async () => {
		await app.current?.fiber.dispose();
	});
	const signalShutdown = new AbortController();
	const interrupt = (code) => {
		signalShutdown.abort();
		shutdown.interrupt(code);
	};
	process.on("SIGTERM", () => {
		interrupt(0);
	});
	process.on("SIGINT", () => {
		interrupt(130);
	});
	installFailLoud(NAME, process, async () => {
		await shutdown.shutdown(1);
	});
	const rootConfig = join(composed.profile.dir, PROFILE_ROOT_FILENAME);
	const composeLive = () => structuredClone([
		...composed.bundlePatches,
		...(options.profilePatchMode ?? "user") === "user" ? loadOptionalPatches(NAME, composed.profile.patchPath) ?? [] : composed.profilePatches,
		...(options.homePatchMode ?? "user") === "user" ? loadOptionalPatches(NAME, homePatchPath()) ?? [] : [],
		...composed.overlays
	]);
	const ctx = await boot(NAME, rootConfig, structuredClone(allPatches(composed)), (hostCtx) => {
		app.current = hostCtx;
		hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, options.environment);
		provideCmdline(hostCtx, {
			args: options.args,
			exit: (code) => void shutdown.shutdown(code)
		});
	});
	app.current = ctx;
	const watchedPatchPaths = [...(options.profilePatchMode ?? "user") === "user" ? [composed.profile.patchPath] : [], ...(options.homePatchMode ?? "user") === "user" ? [homePatchPath()] : []];
	if (options.watchLiveConfig !== false && watchedPatchPaths.length > 0 && !signalShutdown.signal.aborted && ctx.fiber.state === 2 && ctx.get("loader") !== void 0) try {
		if (ctx.get("hmr") === void 0) {
			if (ctx.get("timer") === void 0) await ctx.loader.create({ name: "@deepseek-ai/cordis-plugin-timer" });
			await ctx.loader.create({
				name: "@deepseek-ai/cordis-plugin-hmr",
				config: { root: [] }
			});
		}
		for (const filename of watchedPatchPaths) await watchUserPatches(ctx, {
			binName: NAME,
			filename,
			compose: composeLive
		});
	} catch (error) {
		suppressShutdownError(ctx, signalShutdown.signal, error);
	}
	return {
		ctx,
		shutdown
	};
}
//#endregion
export { PROFILE_ROOT_FILENAME, SHIPPED_PRESET_ROOT, homePatchPath, prepareProfile, resolveTelemetryPatch, runProfile };
