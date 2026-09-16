/**
 * Host desktop actions supplementing the canonical settings and credentials
 * Remote owners on their storage Services.
 * @module @deepseek-ai/dsh-api-settings-controller
 */
import { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { AgentPresetDirectoryOpenValue, SettingsDocumentOpenValue } from './types.ts';
export type * from './types.ts';
/** Native document-opening policy. */
export interface Config {
    /** Override platform desktop-opener detection. */
    readonly nativeOpen?: boolean;
}
/** Host integrations replaceable by direct unit tests. */
export interface SettingsControllerInternals {
    readonly openPath?: (path: string, signal: AbortSignal) => Promise<void>;
    readonly canOpenPath?: () => boolean;
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        /** Host desktop actions in the `settings` Remote namespace. */
        settingsController: SettingsController;
    }
}
/** Host desktop actions; settings reads and writes belong to SettingsProvider. */
export declare class SettingsController extends TypertRemoteService {
    static Config: Schema<Config>;
    private readonly openPath;
    private readonly canOpenPath;
    /** Mount desktop actions alongside the provider-owned Remote namespace. */
    constructor(ctx: Context, config?: Config, internals?: SettingsControllerInternals);
    /**
     * Report whether this deployment can open an authored Agent preset directory natively.
     * @returns true when the matching open operation is available.
     */
    canOpenAgentPresetDirectory(): boolean;
    /**
     * Materialize the provider-owned settings document and open it in a native text editor.
     * @param signal - caller lifetime; abort terminates preparation or the native command.
     * @returns confirmation after the native opener accepts the document.
     * @throws TypertRemoteFailure when no document exists, preparation fails, or opening fails.
     */
    openSettingsDocument(signal: AbortSignal): Promise<SettingsDocumentOpenValue>;
    /**
     * Open one user-authored Agent preset directory or return its path when no native opener exists.
     * @param agentPreset - preset id resolved against Host-owned roots.
     * @param signal - caller lifetime; abort terminates the native command.
     * @returns an opened confirmation or the resolved directory for text display.
     * @throws TypertRemoteFailure when the preset is missing, read-only, invalid, or cannot be opened.
     */
    openAgentPresetDirectory(agentPreset: string, signal: AbortSignal): Promise<AgentPresetDirectoryOpenValue>;
    /** Resolve the optional provider or report how to supply it. */
    private provider;
}
export default SettingsController;
//# sourceMappingURL=index.d.ts.map