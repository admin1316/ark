/**
 * API-only native desktop readiness owner. It publishes one loopback URL only
 * after the complete Loader tree settles and never mounts browser behavior.
 * @module @deepseek-ai/dsh-native-api-app
 */
import type { Context } from '@deepseek-ai/cordis';
/** Stable Cordis plugin name. */
export declare const name = "native-api-app";
/** The bound WebServer is the sole runtime dependency. */
export declare const inject: string[];
/**
 * Publish the API readiness line after every sibling row has activated.
 * A failed or disposed Loader tree remains silent, so a supervisor never
 * accepts a listener whose application failed to finish booting.
 * @param ctx - plugin context carrying the bound API-only WebServer.
 */
export declare function apply(ctx: Context): void;
//# sourceMappingURL=index.d.ts.map