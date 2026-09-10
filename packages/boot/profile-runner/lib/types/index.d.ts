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
import { type Context } from '@deepseek-ai/cordis';
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include';
import { type Profile } from '@deepseek-ai/dsh-app-boot';
/** Canonical shipped agent-preset root, shared by every profile-running application. */
export declare const SHIPPED_PRESET_ROOT: string;
import { type LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment';
import { type ProcessShutdown } from './process-shutdown.ts';
/**
 * The home-level user patch layer (`$DSH_HOME/cordis.patch.yml`), applied
 * over every profile's own layer. Resolved per call, not at module load:
 * `$DSH_HOME` may be set by the test or launcher after import.
 * @returns the absolute patch-file path.
 */
export declare function homePatchPath(): string;
/** Root config filename inside a profile directory. */
export declare const PROFILE_ROOT_FILENAME = "cordis.yml";
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
export declare function resolveTelemetryPatch(disabledEnv: string | undefined, hasRow: boolean): PatchOptions | undefined;
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
export declare function prepareProfile(name: string, installAnchor: string, userLayer?: boolean): Profile;
/** Options for {@link runProfile}. */
export interface RunProfileOptions {
    /** Absolute package.json path of the application whose installed dependency closure resolves profile bundles. */
    installAnchor: string;
    /** This run's frozen environment snapshot, provided before any entry mounts. */
    environment: LaunchEnvironmentSnapshot;
    /** The profile name to boot. */
    profile: string;
    /** `--patch` overlay paths, in argv order. */
    patchFiles: readonly string[];
    /** The invocation's inner arguments, handed to the tree through `ctx.cmdlineArgs`. */
    args: readonly string[];
    /** Whether profile/home patch files stay live through HMR. Defaults to true for generic CLI surfaces. */
    watchLiveConfig?: boolean;
    /** How to treat the profile's cordis.patch.yml. Managed mode loads it once but never treats it as a user layer. */
    profilePatchMode?: 'user' | 'managed' | 'none';
    /** Whether to include the home-wide `$DSH_HOME/cordis.patch.yml` user layer. */
    homePatchMode?: 'user' | 'none';
    /** Additional application-owned system preset roots; the shared standard/code/minimal root always comes first. */
    additionalSystemPresetRoots?: readonly string[];
}
/**
 * Boot one profile invocation end to end and leave process lifetime to the
 * mounted plugins (or to a one-shot runner the composition mounts).
 * @param options - environment snapshot, profile name, overlays, and the booted app's own arguments.
 * @returns the settled root context and the shutdown controller.
 */
export declare function runProfile(options: RunProfileOptions): Promise<{
    ctx: Context;
    shutdown: ProcessShutdown;
}>;
//# sourceMappingURL=index.d.ts.map