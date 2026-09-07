# Extensions

English | [中文](extensions.zh.md)

The extensions subsystem lets an agent define versioned Cordis packages, run their host and browser halves, and query approved runtime metadata before writing code. Package lifecycle and sandbox behavior belong to the [`packages/extensions`](../../packages/extensions/README.md) package group.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxcordisinspect--cordisinspectregistryservice"></a>

### `ctx.cordisInspect` — `CordisInspectRegistryService`

Registry behind the model-facing inspect tools.

```ts cordis-catalog
/**
 * Register one Host provider.
 * @param registration - Provider manifest and query implementation.
 * @returns A disposer that removes the provider when it is no longer owned.
 */
register(registration: HostCordisInspectProviderRegistration): () => void

/**
 * Return the complete Host provider directory.
 * @returns Serializable provider views in registration order.
 */
list(): CordisInspectProviderView[]

/**
 * Execute one Host provider query.
 * @param platform - Requested inspect platform; only `host` is supported.
 * @param providerId - Registered provider identity.
 * @param methodName - Provider method to invoke.
 * @param input - JSON input validated against the method schema.
 * @param agent - Session agent making the query.
 * @param signal - Cancellation signal for the query lifecycle.
 * @returns Schema-validated JSON provider output.
 */
async query( platform: CordisInspectPlatform, providerId: string, methodName: string, input: JsonValue | undefined, agent: Agent, signal: AbortSignal, ): Promise<JsonValue>
```

Types: [Agent](core.md)

Source: [`packages/extensions/cordis-host-runner/src/inspect-registry.ts`](../../packages/extensions/cordis-host-runner/src/inspect-registry.ts)

<a id="ctxdynamiccordisrunner--dynamiccordisrunnerservice"></a>

### `ctx.dynamicCordisRunner` — `DynamicCordisRunnerService`

Dynamic Host Plugin registry and lifecycle.

```ts cordis-catalog
/**
 * Define a new Plugin Package or append a version to an existing Plugin.
 * @param request - Session-owned plugin and immutable Host source definition.
 * @returns The minted plugin and package identities.
 */
define(request: DynamicCordisDefineRequest): DynamicCordisDefineReceipt

/**
 * Remove one owned Plugin and all immutable Packages.
 * @param agent - Session agent that owns the plugin.
 * @param pluginId - Plugin identity to remove.
 * @returns Removal status and whether a running Host half was stopped.
 */
async undefine(agent: Agent, pluginId: CordisDynamicPluginId): Promise<DynamicCordisUndefineReceipt>

/**
 * Start or update one owned Host Package.
 * @param agent - Session agent that owns the plugin.
 * @param pluginId - Plugin identity to activate.
 * @param packageId - Immutable package version to run.
 * @param mode - Whether this is a first run or an in-place update.
 * @param signal - Optional cancellation signal for activation.
 * @returns Host activation status and diagnostics.
 */
async run( agent: Agent, pluginId: CordisDynamicPluginId, packageId: CordisDynamicPackageId, mode: CordisDynamicRunMode, signal?: AbortSignal, ): Promise<DynamicCordisRunResponse>

/**
 * Stop one owned Plugin while retaining its Packages.
 * @param agent - Session agent that owns the plugin.
 * @param pluginId - Plugin identity to stop.
 * @returns Stop status and diagnostics.
 */
async stop(agent: Agent, pluginId: CordisDynamicPluginId): Promise<DynamicCordisStopResponse>

/**
 * Process-wide source-free inventory.
 * @returns All registered plugin/package lifecycle rows.
 */
inventory(): DynamicCordisInventoryRow[]

/**
 * One Session's Host-rich snapshot.
 * @param agent - Session agent whose owned plugins are inspected.
 * @returns Session-scoped plugin/package snapshot rows.
 */
snapshot(agent: Agent): DynamicCordisSnapshotRow[]

/**
 * Source-free reference to one owned Plugin.
 * @param agent - Session agent that owns the plugin.
 * @param pluginId - Plugin identity to resolve.
 * @returns A stable plugin reference, or undefined when absent.
 */
reference(agent: Agent, pluginId: CordisDynamicPluginId): DynamicCordisReference | undefined

/**
 * List owned Plugin summaries.
 * @param agent - Session agent whose plugins are listed.
 * @returns Session-owned plugin inspection rows.
 */
listPlugins(agent: Agent): DynamicCordisPluginInspection[]

/**
 * Inspect one owned Plugin.
 * @param agent - Session agent that owns the plugin.
 * @param pluginId - Plugin identity to inspect.
 * @returns Detailed plugin inspection data.
 */
inspectPlugin(agent: Agent, pluginId: CordisDynamicPluginId): DynamicCordisPluginInspection

/**
 * Inspect one immutable owned Package and its Host source.
 * @param agent - Session agent that owns the plugin.
 * @param pluginId - Plugin identity containing the package.
 * @param packageId - Immutable package identity to inspect.
 * @returns Detailed package inspection data.
 */
inspectPackage( agent: Agent, pluginId: CordisDynamicPluginId, packageId: CordisDynamicPackageId, ): DynamicCordisPackageInspection
```

Types: [Agent](core.md)

Source: [`packages/extensions/cordis-host-runner/src/index.ts`](../../packages/extensions/cordis-host-runner/src/index.ts)
<!-- END GENERATED cordis-surface -->
