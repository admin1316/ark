import { fileURLToPath } from "node:url";
//#region lib/types/installation.js
/** This generic CLI package's installation manifest for profile bundle resolution. */
const INSTALL_ANCHOR = fileURLToPath(new URL("../package.json", import.meta.url));
/** Generic CLI-only system presets that are not admitted to managed Native products. */
const CLI_AGENT_PRESET_ROOT = fileURLToPath(new URL("../config/agent-presets/", import.meta.url));
//#endregion
export { INSTALL_ANCHOR as n, CLI_AGENT_PRESET_ROOT as t };
