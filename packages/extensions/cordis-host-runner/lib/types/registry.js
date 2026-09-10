/** Process-local registry for model-authored Host plugins. */
/** Registry and opaque identity mints. */
export class DynamicCordisRegistry {
    plugins = new Map();
    nextPlugin = 1;
    nextPackage = 1;
    nextRun = 1;
    /**
     * Mint a semantic plugin ID without reusing a suffix.
     * @param prefix - The prefix input.
     * @returns The value produced by mint plugin id.
     */
    mintPluginId(prefix) {
        let id;
        do
            id = `${prefix}-${this.nextPlugin++}`;
        while (this.plugins.has(id));
        return id;
    }
    /**
     * Mint an immutable package ID.
     * @returns The value produced by mint package id.
     */
    mintPackageId() {
        return `pkg-${this.nextPackage++}`;
    }
    /**
     * Mint an activation ID.
     * @returns The value produced by mint plugin run id.
     */
    mintPluginRunId() {
        return `run-${this.nextRun++}`;
    }
    /**
     * Add one stable plugin.
     * @param plugin - The plugin input.
     */
    add(plugin) {
        this.plugins.set(plugin.pluginId, plugin);
    }
    /**
     * Read one plugin.
     * @param id - The id input.
     * @returns The value produced by get.
     */
    get(id) {
        return this.plugins.get(id);
    }
    /**
     * Delete one plugin and all versions.
     * @param id - The id input.
     * @returns The value produced by delete.
     */
    delete(id) {
        return this.plugins.delete(id);
    }
    /**
     * Read all plugins in creation order.
     * @returns The value produced by all.
     */
    all() {
        return [...this.plugins.values()];
    }
    /**
     * Read one session's plugins in creation order.
     * @param sessionId - The session id input.
     * @returns The value produced by of session.
     */
    ofSession(sessionId) {
        return this.all().filter(plugin => plugin.sessionId === sessionId);
    }
}
//# sourceMappingURL=registry.js.map