/**
 * Native API app command-line provider: parses the optional loopback listener
 * port and provides it before the API-only WebServer row resolves its config.
 * @module @deepseek-ai/dsh-native-api-app/startup
 */
import { Command } from 'commander';
import { parseCmdline } from '@deepseek-ai/dsh-cmdline';
/** Stable Cordis plugin name. */
export const name = 'native-api-startup';
/** Launcher command-line service required before parsing. */
export const inject = ['cmdlineArgs'];
/** Service provided to listener rows after a successful parse. */
export const NATIVE_API_STARTUP_SERVICE = 'nativeApiStartup';
/**
 * Parse one optional listener port, including zero for OS assignment.
 * @param value - The value input.
 * @returns The value produced by parse native api port.
 */
export function parseNativeApiPort(value) {
    if (value === undefined)
        return undefined;
    if (!/^\d+$/.test(value)) {
        throw new TypeError(`--port must be a number, got ${JSON.stringify(value)}`);
    }
    const port = Number(value);
    if (!Number.isSafeInteger(port) || port > 65_535) {
        throw new RangeError(`--port must be between 0 and 65535, got ${JSON.stringify(value)}`);
    }
    return port;
}
/**
 * Parse the native API invocation and publish its immutable startup values.
 * @param ctx - plugin context carrying the launcher argument snapshot.
 */
export function apply(ctx) {
    const program = new Command()
        .name('dsh --profile native-api')
        .description('Serve an authenticated loopback API for a native desktop client.')
        .helpOption('-h, --help', 'show this help')
        .option('--port <port>', 'listen port; pass 0 to let the OS pick a free one');
    program.action(() => {
        let port;
        try {
            port = parseNativeApiPort(program.opts().port);
        }
        catch (error) {
            program.error(`error: ${error instanceof Error ? error.message : String(error)}`);
        }
        ctx.provide(NATIVE_API_STARTUP_SERVICE, Object.freeze({
            ...(port === undefined ? {} : { port }),
        }));
    });
    parseCmdline(ctx, program);
}
//# sourceMappingURL=startup.js.map