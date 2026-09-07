/** Process-local registry for model-authored Host plugins. */

import type { Fiber } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  CordisDynamicPackageId,
  CordisDynamicPluginId,
  CordisDynamicPluginRunId,
  DynamicCordisRunAttempt,
} from './types.ts'

/** One live Host activation. */
export interface DynamicCordisRun {
  pluginRunId: CordisDynamicPluginRunId
  packageId: CordisDynamicPackageId
  fiber?: Fiber
  /** Runtime guard failures already reported to the owning Agent. */
  reportedRuntimeErrors: Set<string>
}

/** One immutable Host package version. */
export interface DynamicCordisDefinition {
  packageId: CordisDynamicPackageId
  name: string
  purpose: string
  hostCode: string
}

/** Stable plugin instance containing immutable package versions. */
export interface DynamicCordisPlugin {
  pluginId: CordisDynamicPluginId
  sessionId: SessionId
  packages: Map<CordisDynamicPackageId, DynamicCordisDefinition>
  currentPackageId?: CordisDynamicPackageId
  nextPackageId?: CordisDynamicPackageId
  run?: DynamicCordisRun
  latestRun?: DynamicCordisRunAttempt
}

/** Request accepted by `define`; it never crosses a transport. */
export interface DynamicCordisDefineRequest {
  sessionId: SessionId
  plugin:
    | { kind: 'new'; idPrefix: string }
    | { kind: 'existing'; pluginId: CordisDynamicPluginId }
  name: string
  purpose: string
  code: { host: string }
}

/** Successful `define` result. */
export interface DynamicCordisDefineReceipt {
  pluginId: CordisDynamicPluginId
  packageId: CordisDynamicPackageId
  name: string
  purpose: string
}

/** Source-free context for an explicit plugin reference. */
export interface DynamicCordisReference {
  pluginId: CordisDynamicPluginId
  packageId: CordisDynamicPackageId
  name: string
  purpose: string
  currentPackageId?: CordisDynamicPackageId
  nextPackageId?: CordisDynamicPackageId
  activeRun?: { pluginRunId: CordisDynamicPluginRunId; packageId: CordisDynamicPackageId }
  latestRun?: DynamicCordisRunAttempt
}

/** Source-free plugin summary returned by inspection. */
export interface DynamicCordisPluginInspection extends DynamicCordisReference {
  packages: Array<{
    packageId: CordisDynamicPackageId
    name: string
    purpose: string
  }>
}

/** Exact immutable Host package and source returned by inspection. */
export interface DynamicCordisPackageInspection extends DynamicCordisReference {
  code: { host: string }
}

/** Registry and opaque identity mints. */
export class DynamicCordisRegistry {
  private readonly plugins = new Map<CordisDynamicPluginId, DynamicCordisPlugin>()
  private nextPlugin = 1
  private nextPackage = 1
  private nextRun = 1

  /**
   * Mint a semantic plugin ID without reusing a suffix.
   * @param prefix - The prefix input.
   * @returns The value produced by mint plugin id.
   */
  mintPluginId(prefix: string): string {
    let id: CordisDynamicPluginId
    do id = `${prefix}-${this.nextPlugin++}` as CordisDynamicPluginId
    while (this.plugins.has(id))
    return id
  }

  /**
   * Mint an immutable package ID.
   * @returns The value produced by mint package id.
   */
  mintPackageId(): string {
    return `pkg-${this.nextPackage++}`
  }

  /**
   * Mint an activation ID.
   * @returns The value produced by mint plugin run id.
   */
  mintPluginRunId(): string {
    return `run-${this.nextRun++}`
  }

  /**
   * Add one stable plugin.
   * @param plugin - The plugin input.
   */
  add(plugin: DynamicCordisPlugin): void {
    this.plugins.set(plugin.pluginId, plugin)
  }

  /**
   * Read one plugin.
   * @param id - The id input.
   * @returns The value produced by get.
   */
  get(id: CordisDynamicPluginId): DynamicCordisPlugin | undefined {
    return this.plugins.get(id)
  }

  /**
   * Delete one plugin and all versions.
   * @param id - The id input.
   * @returns The value produced by delete.
   */
  delete(id: CordisDynamicPluginId): boolean {
    return this.plugins.delete(id)
  }

  /**
   * Read all plugins in creation order.
   * @returns The value produced by all.
   */
  all(): DynamicCordisPlugin[] {
    return [...this.plugins.values()]
  }

  /**
   * Read one session's plugins in creation order.
   * @param sessionId - The session id input.
   * @returns The value produced by of session.
   */
  ofSession(sessionId: SessionId): DynamicCordisPlugin[] {
    return this.all().filter(plugin => plugin.sessionId === sessionId)
  }
}
