/**
 * Ark's dedicated native API runner. It has one fixed managed profile, no
 * plugin/config-dump dispatch, no live profile watcher, and no browser alias.
 * @module @deepseek-ai/dsh-native-api-runner
 */
/** The only profile this executable can boot. */
export declare const ARK_NATIVE_API_PROFILE = "jiuzhang";
/** This runner package's installation manifest, used to resolve its owned closure. */
export declare const ARK_NATIVE_API_INSTALL_ANCHOR: string;
/**
 * Boot Ark's managed API-only profile with immutable on-disk composition.
 * @param args - Native API application arguments forwarded by the Ark launcher.
 * @returns After the Loader tree settles; process lifetime remains owned by the mounted application.
 */
export declare function runNativeApi(args: readonly string[]): Promise<void>;
//# sourceMappingURL=index.d.ts.map