/**
 * Native API app command-line provider: parses the optional loopback listener
 * port and provides it before the API-only WebServer row resolves its config.
 * @module @deepseek-ai/dsh-native-api-app/startup
 */
import type { Context } from '@deepseek-ai/cordis';
/** Stable Cordis plugin name. */
export declare const name = "native-api-startup";
/** Launcher command-line service required before parsing. */
export declare const inject: string[];
/** Service provided to listener rows after a successful parse. */
export declare const NATIVE_API_STARTUP_SERVICE = "nativeApiStartup";
/** Values resolved from one native API invocation. */
export interface NativeApiStartupValues {
    /** Requested loopback port; absent means the composed default. Zero requests an OS-assigned port. */
    port?: number;
}
/**
 * Parse one optional listener port, including zero for OS assignment.
 * @param value - The value input.
 * @returns The value produced by parse native api port.
 */
export declare function parseNativeApiPort(value: string | undefined): number | undefined;
/**
 * Parse the native API invocation and publish its immutable startup values.
 * @param ctx - plugin context carrying the launcher argument snapshot.
 */
export declare function apply(ctx: Context): void;
//# sourceMappingURL=startup.d.ts.map