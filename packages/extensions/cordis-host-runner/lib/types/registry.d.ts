/** Process-local registry for model-authored Host plugins. */
import type { Fiber } from '@deepseek-ai/cordis';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type { CordisDynamicPackageId, CordisDynamicPluginId, CordisDynamicPluginRunId, DynamicCordisRunAttempt } from './types.ts';
/** One live Host activation. */
export interface DynamicCordisRun {
    pluginRunId: CordisDynamicPluginRunId;
    packageId: CordisDynamicPackageId;
    fiber?: Fiber;
    /** Runtime guard failures already reported to the owning Agent. */
    reportedRuntimeErrors: Set<string>;
}
/** One immutable Host package version. */
export interface DynamicCordisDefinition {
    packageId: CordisDynamicPackageId;
    name: string;
    purpose: string;
    hostCode: string;
}
/** Stable plugin instance containing immutable package versions. */
export interface DynamicCordisPlugin {
    pluginId: CordisDynamicPluginId;
    sessionId: SessionId;
    packages: Map<CordisDynamicPackageId, DynamicCordisDefinition>;
    currentPackageId?: CordisDynamicPackageId;
    nextPackageId?: CordisDynamicPackageId;
    run?: DynamicCordisRun;
    latestRun?: DynamicCordisRunAttempt;
}
/** Request accepted by `define`; it never crosses a transport. */
export interface DynamicCordisDefineRequest {
    sessionId: SessionId;
    plugin: {
        kind: 'new';
        idPrefix: string;
    } | {
        kind: 'existing';
        pluginId: CordisDynamicPluginId;
    };
    name: string;
    purpose: string;
    code: {
        host: string;
    };
}
/** Successful `define` result. */
export interface DynamicCordisDefineReceipt {
    pluginId: CordisDynamicPluginId;
    packageId: CordisDynamicPackageId;
    name: string;
    purpose: string;
}
/** Source-free context for an explicit plugin reference. */
export interface DynamicCordisReference {
    pluginId: CordisDynamicPluginId;
    packageId: CordisDynamicPackageId;
    name: string;
    purpose: string;
    currentPackageId?: CordisDynamicPackageId;
    nextPackageId?: CordisDynamicPackageId;
    activeRun?: {
        pluginRunId: CordisDynamicPluginRunId;
        packageId: CordisDynamicPackageId;
    };
    latestRun?: DynamicCordisRunAttempt;
}
/** Source-free plugin summary returned by inspection. */
export interface DynamicCordisPluginInspection extends DynamicCordisReference {
    packages: Array<{
        packageId: CordisDynamicPackageId;
        name: string;
        purpose: string;
    }>;
}
/** Exact immutable Host package and source returned by inspection. */
export interface DynamicCordisPackageInspection extends DynamicCordisReference {
    code: {
        host: string;
    };
}
/** Registry and opaque identity mints. */
export declare class DynamicCordisRegistry {
    private readonly plugins;
    private nextPlugin;
    private nextPackage;
    private nextRun;
    /**
     * Mint a semantic plugin ID without reusing a suffix.
     * @param prefix - The prefix input.
     * @returns The value produced by mint plugin id.
     */
    mintPluginId(prefix: string): string;
    /**
     * Mint an immutable package ID.
     * @returns The value produced by mint package id.
     */
    mintPackageId(): string;
    /**
     * Mint an activation ID.
     * @returns The value produced by mint plugin run id.
     */
    mintPluginRunId(): string;
    /**
     * Add one stable plugin.
     * @param plugin - The plugin input.
     */
    add(plugin: DynamicCordisPlugin): void;
    /**
     * Read one plugin.
     * @param id - The id input.
     * @returns The value produced by get.
     */
    get(id: CordisDynamicPluginId): DynamicCordisPlugin | undefined;
    /**
     * Delete one plugin and all versions.
     * @param id - The id input.
     * @returns The value produced by delete.
     */
    delete(id: CordisDynamicPluginId): boolean;
    /**
     * Read all plugins in creation order.
     * @returns The value produced by all.
     */
    all(): DynamicCordisPlugin[];
    /**
     * Read one session's plugins in creation order.
     * @param sessionId - The session id input.
     * @returns The value produced by of session.
     */
    ofSession(sessionId: SessionId): DynamicCordisPlugin[];
}
//# sourceMappingURL=registry.d.ts.map