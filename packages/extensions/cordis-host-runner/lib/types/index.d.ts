/** Dynamic Cordis service for model-authored Host plugins. */
import { Context, Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { DynamicCordisDefineReceipt, DynamicCordisDefineRequest, DynamicCordisPackageInspection, DynamicCordisPluginInspection, DynamicCordisReference } from './registry.ts';
import type { CordisDynamicPackageId, CordisDynamicPluginId, CordisDynamicPluginRunId, CordisDynamicRunMode, DynamicCordisInventoryRow, DynamicCordisRunResponse, DynamicCordisSnapshotRow, DynamicCordisStopResponse, DynamicCordisUndefineReceipt } from './types.ts';
export type * from './types.ts';
export type { DynamicCordisDefineReceipt, DynamicCordisDefineRequest, DynamicCordisDefinition, DynamicCordisPackageInspection, DynamicCordisPlugin, DynamicCordisPluginInspection, DynamicCordisReference, DynamicCordisRun, } from './registry.ts';
export { CordisInspectRegistryService } from './inspect-registry.ts';
export type { HostCordisInspectProviderRegistration } from './inspect-registry.ts';
export { HOST_BUILTIN_INSPECTION } from './sandbox.ts';
/**
 * Brand a Host-minted Plugin ID.
 * @param id - The id input.
 * @returns The value produced by cordis dynamic plugin id.
 */
export declare function CordisDynamicPluginId(id: string): CordisDynamicPluginId;
/**
 * Brand a Host-minted Package ID.
 * @param id - The id input.
 * @returns The value produced by cordis dynamic package id.
 */
export declare function CordisDynamicPackageId(id: string): CordisDynamicPackageId;
/**
 * Brand a Host-minted activation ID.
 * @param id - The id input.
 * @returns The value produced by cordis dynamic plugin run id.
 */
export declare function CordisDynamicPluginRunId(id: string): CordisDynamicPluginRunId;
declare module '@deepseek-ai/cordis' {
    interface Context {
        /** Process-local dynamic Host Plugin registry and lifecycle service. */
        dynamicCordisRunner: DynamicCordisRunnerService;
    }
}
/** Runner configuration. */
export interface Config {
    /** Maximum synchronous VM evaluation time in milliseconds. */
    vmTimeoutMs?: number;
}
/** Dynamic Host Plugin registry and lifecycle. */
export declare class DynamicCordisRunnerService extends Service {
    static inject: string[];
    static Config: z<Config>;
    private readonly rootCtx;
    private readonly registry;
    private readonly starting;
    private readonly resolved;
    private group;
    /** Create the service under the Host composition. */
    constructor(ctx: Context, config: Config);
    /**
     * Define a new Plugin Package or append a version to an existing Plugin.
     * @param request - Session-owned plugin and immutable Host source definition.
     * @returns The minted plugin and package identities.
     */
    define(request: DynamicCordisDefineRequest): DynamicCordisDefineReceipt;
    /**
     * Remove one owned Plugin and all immutable Packages.
     * @param agent - Session agent that owns the plugin.
     * @param pluginId - Plugin identity to remove.
     * @returns Removal status and whether a running Host half was stopped.
     */
    undefine(agent: Agent, pluginId: CordisDynamicPluginId): Promise<DynamicCordisUndefineReceipt>;
    /**
     * Start or update one owned Host Package.
     * @param agent - Session agent that owns the plugin.
     * @param pluginId - Plugin identity to activate.
     * @param packageId - Immutable package version to run.
     * @param mode - Whether this is a first run or an in-place update.
     * @param signal - Optional cancellation signal for activation.
     * @returns Host activation status and diagnostics.
     */
    run(agent: Agent, pluginId: CordisDynamicPluginId, packageId: CordisDynamicPackageId, mode: CordisDynamicRunMode, signal?: AbortSignal): Promise<DynamicCordisRunResponse>;
    /**
     * Stop one owned Plugin while retaining its Packages.
     * @param agent - Session agent that owns the plugin.
     * @param pluginId - Plugin identity to stop.
     * @returns Stop status and diagnostics.
     */
    stop(agent: Agent, pluginId: CordisDynamicPluginId): Promise<DynamicCordisStopResponse>;
    /**
     * Process-wide source-free inventory.
     * @returns All registered plugin/package lifecycle rows.
     */
    inventory(): DynamicCordisInventoryRow[];
    /**
     * One Session's Host-rich snapshot.
     * @param agent - Session agent whose owned plugins are inspected.
     * @returns Session-scoped plugin/package snapshot rows.
     */
    snapshot(agent: Agent): DynamicCordisSnapshotRow[];
    /**
     * Source-free reference to one owned Plugin.
     * @param agent - Session agent that owns the plugin.
     * @param pluginId - Plugin identity to resolve.
     * @returns A stable plugin reference, or undefined when absent.
     */
    reference(agent: Agent, pluginId: CordisDynamicPluginId): DynamicCordisReference | undefined;
    /**
     * List owned Plugin summaries.
     * @param agent - Session agent whose plugins are listed.
     * @returns Session-owned plugin inspection rows.
     */
    listPlugins(agent: Agent): DynamicCordisPluginInspection[];
    /**
     * Inspect one owned Plugin.
     * @param agent - Session agent that owns the plugin.
     * @param pluginId - Plugin identity to inspect.
     * @returns Detailed plugin inspection data.
     */
    inspectPlugin(agent: Agent, pluginId: CordisDynamicPluginId): DynamicCordisPluginInspection;
    /**
     * Inspect one immutable owned Package and its Host source.
     * @param agent - Session agent that owns the plugin.
     * @param pluginId - Plugin identity containing the package.
     * @param packageId - Immutable package identity to inspect.
     * @returns Detailed package inspection data.
     */
    inspectPackage(agent: Agent, pluginId: CordisDynamicPluginId, packageId: CordisDynamicPackageId): DynamicCordisPackageInspection;
    private resolvePlan;
    private activate;
    private startHost;
    private runResponse;
    private createAttempt;
    private failAttempt;
    private diagnostic;
    private claimRuntimeFailure;
    private retract;
    private owned;
    private requireGroup;
}
export default DynamicCordisRunnerService;
//# sourceMappingURL=index.d.ts.map