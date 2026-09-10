/** Source-free projections of the Host dynamic Cordis registry. */
/**
 * Return the plugin only when the Agent owns it.
 * @param registry - The registry input.
 * @param agent - The agent input.
 * @param pluginId - The plugin id input.
 * @returns The value produced by owned plugin.
 */
export function ownedPlugin(registry, agent, pluginId) {
    const plugin = registry.get(pluginId);
    return plugin?.sessionId === agent.id ? plugin : undefined;
}
/**
 * Shared missing-plugin diagnostic.
 * @param id - The id input.
 * @returns The value produced by missing plugin message.
 */
export function missingPluginMessage(id) {
    return `no dynamic plugin "${id}" in this process — it may have been removed or lost on DSH restart`;
}
/**
 * Detached copy of one attempt.
 * @param attempt - The attempt input.
 * @returns The value produced by clone attempt.
 */
export function cloneAttempt(attempt) {
    return {
        ...attempt,
        host: { ...attempt.host, waitingFor: [...attempt.host.waitingFor] },
        ...attempt.error === undefined ? {} : { error: { ...attempt.error } },
    };
}
function packageRows(plugin) {
    return [...plugin.packages.values()].map(({ packageId, name, purpose }) => ({ packageId, name, purpose }));
}
function versionFields(plugin) {
    return {
        ...plugin.currentPackageId === undefined ? {} : { currentPackageId: plugin.currentPackageId },
        ...plugin.nextPackageId === undefined ? {} : { nextPackageId: plugin.nextPackageId },
    };
}
function activeRunOf(plugin) {
    return plugin.run === undefined ? {} : {
        activeRun: { pluginRunId: plugin.run.pluginRunId, packageId: plugin.run.packageId },
    };
}
/**
 * Process-wide source-free inventory.
 * @param registry - The registry input.
 * @returns The value produced by inventory rows.
 */
export function inventoryRows(registry) {
    return registry.all().map(plugin => ({
        pluginId: plugin.pluginId,
        agentId: plugin.sessionId,
        packages: packageRows(plugin),
        ...versionFields(plugin),
        ...activeRunOf(plugin),
        ...plugin.latestRun === undefined ? {} : { latestRun: cloneAttempt(plugin.latestRun) },
    }));
}
/**
 * One Session's Host-rich snapshot.
 * @param registry - The registry input.
 * @param agent - The agent input.
 * @returns The value produced by snapshot rows.
 */
export function snapshotRows(registry, agent) {
    return registry.ofSession(agent.id).map(plugin => ({
        pluginId: plugin.pluginId,
        ...versionFields(plugin),
        packages: packageRows(plugin),
        ...plugin.run === undefined ? {} : {
            activeRun: {
                pluginRunId: plugin.run.pluginRunId,
                packageId: plugin.run.packageId,
                ...plugin.run.fiber === undefined ? {} : { fiber: plugin.run.fiber },
            },
        },
        ...plugin.latestRun === undefined ? {} : { latestRun: cloneAttempt(plugin.latestRun) },
    }));
}
/**
 * Source-free context for one explicit plugin reference.
 * @param registry - The registry input.
 * @param agent - The agent input.
 * @param pluginId - The plugin id input.
 * @returns The value produced by reference for.
 */
export function referenceFor(registry, agent, pluginId) {
    const plugin = ownedPlugin(registry, agent, pluginId);
    if (plugin === undefined)
        return undefined;
    const packageId = plugin.nextPackageId ?? plugin.currentPackageId ?? [...plugin.packages.keys()].at(-1);
    if (packageId === undefined)
        return undefined;
    const definition = plugin.packages.get(packageId);
    if (definition === undefined)
        return undefined;
    return {
        pluginId,
        packageId,
        name: definition.name,
        purpose: definition.purpose,
        ...versionFields(plugin),
        ...activeRunOf(plugin),
        ...plugin.latestRun === undefined ? {} : { latestRun: cloneAttempt(plugin.latestRun) },
    };
}
/**
 * One summary per owned plugin.
 * @param registry - The registry input.
 * @param agent - The agent input.
 * @returns The value produced by list plugins for.
 */
export function listPluginsFor(registry, agent) {
    return registry.ofSession(agent.id).map(plugin => inspectPluginFor(registry, agent, plugin.pluginId));
}
/**
 * Inspect one owned plugin.
 * @param registry - The registry input.
 * @param agent - The agent input.
 * @param pluginId - The plugin id input.
 * @returns The value produced by inspect plugin for.
 */
export function inspectPluginFor(registry, agent, pluginId) {
    const plugin = ownedPlugin(registry, agent, pluginId);
    if (plugin === undefined)
        throw new Error(missingPluginMessage(pluginId));
    const reference = referenceFor(registry, agent, pluginId);
    if (reference === undefined)
        throw new Error(`dynamic plugin "${pluginId}" has no package`);
    return { ...reference, packages: packageRows(plugin) };
}
/**
 * Inspect one immutable Host package and its source.
 * @param registry - The registry input.
 * @param agent - The agent input.
 * @param pluginId - The plugin id input.
 * @param packageId - The package id input.
 * @returns The value produced by inspect package for.
 */
export function inspectPackageFor(registry, agent, pluginId, packageId) {
    const plugin = ownedPlugin(registry, agent, pluginId);
    if (plugin === undefined)
        throw new Error(missingPluginMessage(pluginId));
    const definition = plugin.packages.get(packageId);
    if (definition === undefined)
        throw new Error(`dynamic package "${packageId}" does not exist on plugin "${pluginId}"`);
    return {
        pluginId,
        packageId,
        name: definition.name,
        purpose: definition.purpose,
        code: { host: definition.hostCode },
        ...versionFields(plugin),
        ...activeRunOf(plugin),
        ...plugin.latestRun === undefined ? {} : { latestRun: cloneAttempt(plugin.latestRun) },
    };
}
//# sourceMappingURL=queries.js.map