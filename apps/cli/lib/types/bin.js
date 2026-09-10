#!/usr/bin/env node
/**
 * dsh — command-line entry. Dynamic imports per mode keep unrelated modes out
 * of each dispatch path; the adapter prints and exits for
 * `--help`/`--version`/a parse error, so only a valid mode reaches the switch.
 * @module @deepseek-ai/dsh/bin
 */
/* v8 ignore file -- built-bin acceptance exercises this self-executing dispatch. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot';
import { parseDshArgs } from "./args.js";
import { CLI_AGENT_PRESET_ROOT, INSTALL_ANCHOR } from "./installation.js";
// Both the source tree (apps/cli/src) and the bundled bin (apps/cli/lib) sit
// one directory under apps/cli, so the checked-in manifest resolves with the
// same relative hop from either artifact.
/** This app's version, read from its checked-in package.json. */
function readVersion() {
    const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
    return typeof manifest.version === 'string' ? manifest.version : '0.0.0';
}
const invocation = parseDshArgs(process.argv.slice(2), readVersion());
switch (invocation.mode) {
    case 'profile': {
        // Ark's managed Native profile is owned by the dedicated runner. Keeping
        // the generic CLI from resolving it prevents a source checkout's workspace
        // links from silently widening the shipped CLI's profile surface.
        if (invocation.profile === 'jiuzhang') {
            throw new Error('cannot resolve profile bundle "@deepseek-ai/dsh-native-api-app"');
        }
        const { runProfile } = await import('@deepseek-ai/dsh-profile-runner');
        await runProfile({
            installAnchor: INSTALL_ANCHOR,
            environment: loadLayeredEnv('dsh'),
            profile: invocation.profile,
            patchFiles: invocation.patches,
            args: invocation.args,
            additionalSystemPresetRoots: [CLI_AGENT_PRESET_ROOT],
        });
        break;
    }
    case 'plugin': {
        const { runPlugin } = await import("./plugin.js");
        process.exit(runPlugin(invocation.profile, invocation.args));
        break;
    }
    case 'dump-config': {
        if (invocation.profile === 'jiuzhang') {
            throw new Error('cannot resolve profile bundle "@deepseek-ai/dsh-native-api-app"');
        }
        const { runDumpConfig } = await import("./dump-config.js");
        runDumpConfig(invocation.profile, invocation.defaultOnly, invocation.patches);
        break;
    }
    default:
        invocation;
        throw new Error(`dsh: unhandled invocation mode ${JSON.stringify(invocation)}`);
}
//# sourceMappingURL=bin.js.map