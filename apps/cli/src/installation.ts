import { fileURLToPath } from 'node:url'

/** This generic CLI package's installation manifest for profile bundle resolution. */
export const INSTALL_ANCHOR = fileURLToPath(new URL('../package.json', import.meta.url))

/** Generic CLI-only system presets that are not admitted to managed Native products. */
export const CLI_AGENT_PRESET_ROOT = fileURLToPath(new URL('../config/agent-presets/', import.meta.url))
