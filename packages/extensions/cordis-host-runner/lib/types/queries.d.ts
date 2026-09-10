/** Source-free projections of the Host dynamic Cordis registry. */
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { CordisDynamicPackageId, CordisDynamicPluginId, DynamicCordisInventoryRow, DynamicCordisRunAttempt, DynamicCordisSnapshotRow } from './types.ts';
import type { DynamicCordisPackageInspection, DynamicCordisPlugin, DynamicCordisPluginInspection, DynamicCordisReference } from './registry.ts';
/** Registry surface consumed by pure query helpers. */
export interface QueryRegistry {
    all(): DynamicCordisPlugin[];
    ofSession(sessionId: string): DynamicCordisPlugin[];
    get(id: CordisDynamicPluginId): DynamicCordisPlugin | undefined;
}
/**
 * Return the plugin only when the Agent owns it.
 * @param registry - The registry input.
 * @param agent - The agent input.
 * @param pluginId - The plugin id input.
 * @returns The value produced by owned plugin.
 */
export declare function ownedPlugin(registry: QueryRegistry, agent: Agent, pluginId: CordisDynamicPluginId): DynamicCordisPlugin | undefined;
/**
 * Shared missing-plugin diagnostic.
 * @param id - The id input.
 * @returns The value produced by missing plugin message.
 */
export declare function missingPluginMessage(id: CordisDynamicPluginId): string;
/**
 * Detached copy of one attempt.
 * @param attempt - The attempt input.
 * @returns The value produced by clone attempt.
 */
export declare function cloneAttempt(attempt: DynamicCordisRunAttempt): DynamicCordisRunAttempt;
/**
 * Process-wide source-free inventory.
 * @param registry - The registry input.
 * @returns The value produced by inventory rows.
 */
export declare function inventoryRows(registry: QueryRegistry): DynamicCordisInventoryRow[];
/**
 * One Session's Host-rich snapshot.
 * @param registry - The registry input.
 * @param agent - The agent input.
 * @returns The value produced by snapshot rows.
 */
export declare function snapshotRows(registry: QueryRegistry, agent: Agent): DynamicCordisSnapshotRow[];
/**
 * Source-free context for one explicit plugin reference.
 * @param registry - The registry input.
 * @param agent - The agent input.
 * @param pluginId - The plugin id input.
 * @returns The value produced by reference for.
 */
export declare function referenceFor(registry: QueryRegistry, agent: Agent, pluginId: CordisDynamicPluginId): DynamicCordisReference | undefined;
/**
 * One summary per owned plugin.
 * @param registry - The registry input.
 * @param agent - The agent input.
 * @returns The value produced by list plugins for.
 */
export declare function listPluginsFor(registry: QueryRegistry, agent: Agent): DynamicCordisPluginInspection[];
/**
 * Inspect one owned plugin.
 * @param registry - The registry input.
 * @param agent - The agent input.
 * @param pluginId - The plugin id input.
 * @returns The value produced by inspect plugin for.
 */
export declare function inspectPluginFor(registry: QueryRegistry, agent: Agent, pluginId: CordisDynamicPluginId): DynamicCordisPluginInspection;
/**
 * Inspect one immutable Host package and its source.
 * @param registry - The registry input.
 * @param agent - The agent input.
 * @param pluginId - The plugin id input.
 * @param packageId - The package id input.
 * @returns The value produced by inspect package for.
 */
export declare function inspectPackageFor(registry: QueryRegistry, agent: Agent, pluginId: CordisDynamicPluginId, packageId: CordisDynamicPackageId): DynamicCordisPackageInspection;
//# sourceMappingURL=queries.d.ts.map