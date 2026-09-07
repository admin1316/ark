/** Host-owned opt-in setting for model-selectable subagent delegation. */
import { Context, Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { type AllowedModelRoute } from './model-selection.ts';
declare module '@deepseek-ai/cordis' {
    interface Context {
        subagentModelSelection: SubagentModelSelectionConfig;
    }
}
/** User-settings namespace for the model-selection authority. */
export declare const SUBAGENT_MODEL_SELECTION_SETTINGS_NAMESPACE: import("@deepseek-ai/dsh-settings").SettingsNamespace;
/**
 * Describes the subagent model selection settings value used by this package.
 */
export interface SubagentModelSelectionSettings {
    enabled: boolean;
    allowedModels: AllowedModelRoute[];
}
/**
 * Defines the subagent model selection settings schema constant used by this package.
 */
export declare const SUBAGENT_MODEL_SELECTION_SETTINGS_SCHEMA: z<SubagentModelSelectionSettings>;
/**
 * Describes the config value used by this package.
 */
export interface Config {
    enabled?: boolean;
    allowedModels?: AllowedModelRoute[];
}
/** Singleton settings owner sampled when a new eligible Agent is published. */
export declare class SubagentModelSelectionConfig extends Service {
    static Config: z<Config>;
    private source;
    constructor(ctx: Context, config?: Config);
    /**
     * Read the current model-selection authority as a detached snapshot.
     * @returns the enabled flag and detached allowed-model routes.
     */
    current(): SubagentModelSelectionSettings;
    private validate;
}
export declare const name = "subagent-model-selection-settings";
export default SubagentModelSelectionConfig;
//# sourceMappingURL=model-selection-settings.d.ts.map