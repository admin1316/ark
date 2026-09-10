import { fileURLToPath } from "node:url";
import { loadLayeredEnv } from "@deepseek-ai/dsh-app-boot";
import { runProfile } from "@deepseek-ai/dsh-profile-runner";
//#region lib/types/index.js
/**
* Ark's dedicated native API runner. It has one fixed managed profile, no
* plugin/config-dump dispatch, no live profile watcher, and no browser alias.
* @module @deepseek-ai/dsh-native-api-runner
*/
/** The only profile this executable can boot. */
const ARK_NATIVE_API_PROFILE = "jiuzhang";
/** This runner package's installation manifest, used to resolve its owned closure. */
const ARK_NATIVE_API_INSTALL_ANCHOR = fileURLToPath(new URL("../package.json", import.meta.url));
/**
* Boot Ark's managed API-only profile with immutable on-disk composition.
* @param args - Native API application arguments forwarded by the Ark launcher.
* @returns After the Loader tree settles; process lifetime remains owned by the mounted application.
*/
async function runNativeApi(args) {
	await runProfile({
		installAnchor: ARK_NATIVE_API_INSTALL_ANCHOR,
		environment: loadLayeredEnv("dsh"),
		profile: ARK_NATIVE_API_PROFILE,
		patchFiles: [],
		args,
		watchLiveConfig: false,
		profilePatchMode: "managed",
		homePatchMode: "none"
	});
}
//#endregion
export { ARK_NATIVE_API_INSTALL_ANCHOR, ARK_NATIVE_API_PROFILE, runNativeApi };
