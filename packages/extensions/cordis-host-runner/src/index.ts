/** Dynamic Cordis service for model-authored Host plugins. */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { isPlugin } from './guard.ts'
import { CordisInspectRegistryService } from './inspect-registry.ts'
import { missingServices, startHostHalf } from './lifecycle.ts'
import { DynamicCordisRegistry } from './registry.ts'
import { steerGuardFailure } from './steering.ts'
import {
  inspectPackageFor,
  inspectPluginFor,
  inventoryRows,
  listPluginsFor,
  missingPluginMessage,
  referenceFor,
  snapshotRows,
} from './queries.ts'
import type {
  DynamicCordisDefineReceipt,
  DynamicCordisDefineRequest,
  DynamicCordisDefinition,
  DynamicCordisPackageInspection,
  DynamicCordisPlugin,
  DynamicCordisPluginInspection,
  DynamicCordisReference,
  DynamicCordisRun,
} from './registry.ts'
import { createSandbox, evaluateHostCode, precheckCode } from './sandbox.ts'
import type {
  CordisDynamicPackageId,
  CordisDynamicPluginId,
  CordisDynamicPluginRunId,
  CordisDynamicRunMode,
  CordisErrorDetails,
  DynamicCordisInventoryRow,
  DynamicCordisRunAttempt,
  DynamicCordisRunResponse,
  DynamicCordisSnapshotRow,
  DynamicCordisStopResponse,
  DynamicCordisUndefineReceipt,
} from './types.ts'

export type * from './types.ts'
export type {
  DynamicCordisDefineReceipt,
  DynamicCordisDefineRequest,
  DynamicCordisDefinition,
  DynamicCordisPackageInspection,
  DynamicCordisPlugin,
  DynamicCordisPluginInspection,
  DynamicCordisReference,
  DynamicCordisRun,
} from './registry.ts'
export { CordisInspectRegistryService } from './inspect-registry.ts'
export type { HostCordisInspectProviderRegistration } from './inspect-registry.ts'
export { HOST_BUILTIN_INSPECTION } from './sandbox.ts'

/**
 * Brand a Host-minted Plugin ID.
 * @param id - The id input.
 * @returns The value produced by cordis dynamic plugin id.
 */
export function CordisDynamicPluginId(id: string): CordisDynamicPluginId {
  return id as CordisDynamicPluginId
}

/**
 * Brand a Host-minted Package ID.
 * @param id - The id input.
 * @returns The value produced by cordis dynamic package id.
 */
export function CordisDynamicPackageId(id: string): CordisDynamicPackageId {
  return id as CordisDynamicPackageId
}

/**
 * Brand a Host-minted activation ID.
 * @param id - The id input.
 * @returns The value produced by cordis dynamic plugin run id.
 */
export function CordisDynamicPluginRunId(id: string): CordisDynamicPluginRunId {
  return id as CordisDynamicPluginRunId
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Process-local dynamic Host Plugin registry and lifecycle service. */
    dynamicCordisRunner: DynamicCordisRunnerService
  }
}

/** Runner configuration. */
export interface Config {
  /** Maximum synchronous VM evaluation time in milliseconds. */
  vmTimeoutMs?: number
}

type ResolvedConfig = Required<Config>

interface ActivationPlan {
  plugin: DynamicCordisPlugin
  definition: DynamicCordisDefinition
  mode: CordisDynamicRunMode
}

/** Dynamic Host Plugin registry and lifecycle. */
export class DynamicCordisRunnerService extends Service {
  static inject = ['tools']

  static Config: z<Config> = z.object({
    vmTimeoutMs: z.number().min(1).default(5000),
  })

  private readonly rootCtx: Context
  private readonly registry = new DynamicCordisRegistry()
  private readonly starting = new Map<CordisDynamicPluginId, Promise<DynamicCordisRunResponse>>()
  private readonly resolved: ResolvedConfig
  private group: Fiber | undefined

  /** Create the service under the Host composition. */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'dynamicCordisRunner')
    this.rootCtx = ctx
    this.resolved = config as ResolvedConfig
    new CordisInspectRegistryService(ctx)
  }

  /**
   * Define a new Plugin Package or append a version to an existing Plugin.
   * @param request - Session-owned plugin and immutable Host source definition.
   * @returns The minted plugin and package identities.
   */
  define(request: DynamicCordisDefineRequest): DynamicCordisDefineReceipt {
    const name = request.name.trim()
    const purpose = request.purpose.trim()
    const hostCode = request.code.host
    if (name.length === 0) throw new Error('cordis_define needs a non-empty `name`')
    if (purpose.length === 0) throw new Error('cordis_define needs a non-empty `purpose`')
    if (hostCode.trim().length === 0) throw new Error('cordis_define needs non-empty `code.host`')
    precheckCode(hostCode, 'code.host')

    let plugin: DynamicCordisPlugin
    if (request.plugin.kind === 'new') {
      const prefix = request.plugin.idPrefix.trim()
      if (!/^[a-z]{3,6}$/.test(prefix)) {
        throw new Error('cordis_define `plugin.idPrefix` must contain 3–6 lowercase English letters')
      }
      const pluginId = CordisDynamicPluginId(this.registry.mintPluginId(prefix))
      plugin = { pluginId, sessionId: request.sessionId, packages: new Map() }
      this.registry.add(plugin)
    } else {
      const found = this.registry.get(request.plugin.pluginId)
      if (found === undefined || found.sessionId !== request.sessionId) {
        throw new Error(missingPluginMessage(request.plugin.pluginId))
      }
      plugin = found
    }

    const packageId = CordisDynamicPackageId(this.registry.mintPackageId())
    plugin.packages.set(packageId, { packageId, name, purpose, hostCode })
    return { pluginId: plugin.pluginId, packageId, name, purpose }
  }

  /**
   * Remove one owned Plugin and all immutable Packages.
   * @param agent - Session agent that owns the plugin.
   * @param pluginId - Plugin identity to remove.
   * @returns Removal status and whether a running Host half was stopped.
   */
  async undefine(agent: Agent, pluginId: CordisDynamicPluginId): Promise<DynamicCordisUndefineReceipt> {
    const plugin = this.owned(agent, pluginId)
    if (plugin === undefined) return { ok: false, reason: 'plugin-missing', message: missingPluginMessage(pluginId) }
    const wasRunning = plugin.run !== undefined
    if (plugin.run !== undefined) await this.retract(plugin)
    this.registry.delete(pluginId)
    return { ok: true, wasRunning }
  }

  /**
   * Start or update one owned Host Package.
   * @param agent - Session agent that owns the plugin.
   * @param pluginId - Plugin identity to activate.
   * @param packageId - Immutable package version to run.
   * @param mode - Whether this is a first run or an in-place update.
   * @param signal - Optional cancellation signal for activation.
   * @returns Host activation status and diagnostics.
   */
  async run(
    agent: Agent,
    pluginId: CordisDynamicPluginId,
    packageId: CordisDynamicPackageId,
    mode: CordisDynamicRunMode,
    signal?: AbortSignal,
  ): Promise<DynamicCordisRunResponse> {
    const plan = this.resolvePlan(agent, pluginId, packageId, mode)
    if (!plan.ok) return plan.response
    if (signal?.aborted === true) {
      return { ok: false, reason: 'host-half-failed', message: `activation of dynamic plugin "${pluginId}" was cancelled` }
    }
    const active = plan.plugin.run
    if (active?.packageId === packageId) return this.runResponse(plan.plugin, active, mode)
    const inFlight = this.starting.get(pluginId)
    if (inFlight !== undefined) {
      return { ok: false, reason: 'transition-in-flight', message: `dynamic plugin "${pluginId}" is already starting` }
    }
    const attempt = this.createAttempt(plan)
    plan.plugin.nextPackageId = packageId
    plan.plugin.latestRun = attempt
    const starting = this.activate(plan, attempt)
    this.starting.set(pluginId, starting)
    try {
      return await starting
    } finally {
      this.starting.delete(pluginId)
    }
  }

  /**
   * Stop one owned Plugin while retaining its Packages.
   * @param agent - Session agent that owns the plugin.
   * @param pluginId - Plugin identity to stop.
   * @returns Stop status and diagnostics.
   */
  async stop(agent: Agent, pluginId: CordisDynamicPluginId): Promise<DynamicCordisStopResponse> {
    const plugin = this.owned(agent, pluginId)
    if (plugin === undefined) return { ok: false, reason: 'plugin-missing', message: missingPluginMessage(pluginId) }
    if (plugin.run === undefined) return { ok: false, reason: 'not-running', message: `dynamic plugin "${pluginId}" is not running` }
    await this.retract(plugin)
    delete plugin.nextPackageId
    if (plugin.latestRun !== undefined) {
      plugin.latestRun.status = 'stopped'
      plugin.latestRun.host = { status: 'stopped', waitingFor: [] }
    }
    return { ok: true }
  }

  /**
   * Process-wide source-free inventory.
   * @returns All registered plugin/package lifecycle rows.
   */
  inventory(): DynamicCordisInventoryRow[] {
    return inventoryRows(this.registry)
  }

  /**
   * One Session's Host-rich snapshot.
   * @param agent - Session agent whose owned plugins are inspected.
   * @returns Session-scoped plugin/package snapshot rows.
   */
  snapshot(agent: Agent): DynamicCordisSnapshotRow[] {
    return snapshotRows(this.registry, agent)
  }

  /**
   * Source-free reference to one owned Plugin.
   * @param agent - Session agent that owns the plugin.
   * @param pluginId - Plugin identity to resolve.
   * @returns A stable plugin reference, or undefined when absent.
   */
  reference(agent: Agent, pluginId: CordisDynamicPluginId): DynamicCordisReference | undefined {
    return referenceFor(this.registry, agent, pluginId)
  }

  /**
   * List owned Plugin summaries.
   * @param agent - Session agent whose plugins are listed.
   * @returns Session-owned plugin inspection rows.
   */
  listPlugins(agent: Agent): DynamicCordisPluginInspection[] {
    return listPluginsFor(this.registry, agent)
  }

  /**
   * Inspect one owned Plugin.
   * @param agent - Session agent that owns the plugin.
   * @param pluginId - Plugin identity to inspect.
   * @returns Detailed plugin inspection data.
   */
  inspectPlugin(agent: Agent, pluginId: CordisDynamicPluginId): DynamicCordisPluginInspection {
    return inspectPluginFor(this.registry, agent, pluginId)
  }

  /**
   * Inspect one immutable owned Package and its Host source.
   * @param agent - Session agent that owns the plugin.
   * @param pluginId - Plugin identity containing the package.
   * @param packageId - Immutable package identity to inspect.
   * @returns Detailed package inspection data.
   */
  inspectPackage(
    agent: Agent,
    pluginId: CordisDynamicPluginId,
    packageId: CordisDynamicPackageId,
  ): DynamicCordisPackageInspection {
    return inspectPackageFor(this.registry, agent, pluginId, packageId)
  }

  private resolvePlan(
    agent: Agent,
    pluginId: CordisDynamicPluginId,
    packageId: CordisDynamicPackageId,
    mode: CordisDynamicRunMode,
  ): { ok: true } & ActivationPlan | { ok: false; response: Extract<DynamicCordisRunResponse, { ok: false }> } {
    const plugin = this.owned(agent, pluginId)
    if (plugin === undefined) return { ok: false, response: { ok: false, reason: 'plugin-missing', message: missingPluginMessage(pluginId) } }
    const definition = plugin.packages.get(packageId)
    if (definition === undefined) {
      return { ok: false, response: { ok: false, reason: 'package-missing', message: `plugin "${pluginId}" has no package "${packageId}"` } }
    }
    const current = plugin.currentPackageId
    if (mode === 'update' && (current === undefined || current === packageId)) {
      return {
        ok: false,
        response: {
          ok: false,
          reason: 'invalid-mode',
          message: current === undefined
            ? `plugin "${pluginId}" has no successful version yet; start "${packageId}" with mode "run"`
            : `package "${packageId}" is already current; use mode "run"`,
        },
      }
    }
    if (mode === 'run' && current !== undefined && current !== packageId) {
      return {
        ok: false,
        response: {
          ok: false,
          reason: 'invalid-mode',
          message: `package "${packageId}" differs from current "${current}"; use mode "update"`,
        },
      }
    }
    return { ok: true, plugin, definition, mode }
  }

  private async activate(plan: ActivationPlan, attempt: DynamicCordisRunAttempt): Promise<DynamicCordisRunResponse> {
    const { plugin, definition } = plan
    if (plugin.run !== undefined) await this.retract(plugin)
    const run: DynamicCordisRun = {
      pluginRunId: attempt.pluginRunId,
      packageId: definition.packageId,
      reportedRuntimeErrors: new Set(),
    }
    const failure = await this.startHost(plugin, definition.hostCode, run)
    if (failure !== undefined) {
      this.failAttempt(plugin, attempt, failure)
      return { ok: false, reason: 'host-half-failed', ...failure }
    }
    plugin.run = run
    plugin.currentPackageId = run.packageId
    delete plugin.nextPackageId
    const waitingFor = missingFor(this.ctx, run)
    attempt.host = { status: waitingFor.length === 0 ? 'running' : 'waiting', waitingFor }
    attempt.status = waitingFor.length === 0 ? 'running' : 'waiting'
    delete attempt.error
    return this.runResponse(plugin, run, plan.mode)
  }

  private async startHost(
    plugin: DynamicCordisPlugin,
    hostCode: string,
    run: DynamicCordisRun,
  ): Promise<CordisErrorDetails | undefined> {
    try {
      const evaluated = await evaluateHostCode(createSandbox(plugin.pluginId), hostCode, plugin.pluginId, this.resolved.vmTimeoutMs)
      if (!isPlugin(evaluated)) {
        throw new Error(evaluated === undefined
          ? 'the Host package returned `undefined` — did you forget `return`?'
          : 'the Host package must return a Plugin function or an object with apply(ctx)')
      }
      run.fiber = await startHostHalf(this.requireGroup(), evaluated, (error) => {
        const failure = errorDetails(error)
        const key = `Host\u0000guard\u0000${failure.message}`
        if (!this.claimRuntimeFailure(plugin, run, key)) return
        const attempt = plugin.latestRun
        if (attempt?.pluginRunId === run.pluginRunId) {
          attempt.error = this.diagnostic(plugin, attempt, 'host-guard', failure)
        }
        steerGuardFailure(this.rootCtx.get('agents'), plugin, run, failure)
      })
      return undefined
    } catch (error) {
      return errorDetails(error)
    }
  }

  private runResponse(
    plugin: DynamicCordisPlugin,
    run: DynamicCordisRun,
    mode: CordisDynamicRunMode,
  ): Extract<DynamicCordisRunResponse, { ok: true }> {
    const waitingFor = missingFor(this.ctx, run)
    return {
      ok: true,
      status: waitingFor.length === 0 ? 'running' : 'waiting',
      pluginId: plugin.pluginId,
      packageId: run.packageId,
      pluginRunId: run.pluginRunId,
      waitingFor,
      currentPackageId: run.packageId,
      mode,
    }
  }

  private createAttempt(plan: ActivationPlan): DynamicCordisRunAttempt {
    return {
      pluginRunId: CordisDynamicPluginRunId(this.registry.mintPluginRunId()),
      packageId: plan.definition.packageId,
      mode: plan.mode,
      status: 'starting-host',
      host: { status: 'pending', waitingFor: [] },
    }
  }

  private failAttempt(
    plugin: DynamicCordisPlugin,
    attempt: DynamicCordisRunAttempt,
    failure: CordisErrorDetails,
  ): void {
    attempt.status = 'failed'
    attempt.host = { status: 'failed', waitingFor: [], error: failure.message }
    attempt.error = this.diagnostic(plugin, attempt, 'host-load', failure)
  }

  private diagnostic(
    plugin: DynamicCordisPlugin,
    attempt: DynamicCordisRunAttempt,
    phase: 'host-load' | 'host-guard',
    failure: CordisErrorDetails,
  ): NonNullable<DynamicCordisRunAttempt['error']> {
    return {
      phase,
      ...failure,
      pluginId: plugin.pluginId,
      packageId: attempt.packageId,
      pluginRunId: attempt.pluginRunId,
    }
  }

  private claimRuntimeFailure(plugin: DynamicCordisPlugin, run: DynamicCordisRun, key: string): boolean {
    const attempt = plugin.latestRun
    if (plugin.run !== run || attempt?.pluginRunId !== run.pluginRunId
      || (attempt.status !== 'running' && attempt.status !== 'waiting')) return false
    if (run.reportedRuntimeErrors.has(key)) return false
    run.reportedRuntimeErrors.add(key)
    return true
  }

  private async retract(plugin: DynamicCordisPlugin): Promise<void> {
    const run = plugin.run
    if (run === undefined) return
    delete plugin.run
    if (run.fiber !== undefined) await run.fiber.dispose()
  }

  private owned(agent: Agent, pluginId: CordisDynamicPluginId): DynamicCordisPlugin | undefined {
    const plugin = this.registry.get(pluginId)
    return plugin?.sessionId === agent.id ? plugin : undefined
  }

  private requireGroup(): Fiber {
    this.group ??= this.rootCtx.plugin({ name: 'cordis-dynamic', apply: () => {} })
    return this.group
  }
}

function missingFor(ctx: Context, run: DynamicCordisRun): string[] {
  return run.fiber === undefined ? [] : missingServices(ctx, run.fiber)
}

function errorDetails(error: unknown): CordisErrorDetails {
  if (typeof error !== 'object' || error === null) return { message: String(error) }
  const message = 'message' in error && typeof error.message === 'string'
    ? error.message
    : Object.prototype.toString.call(error)
  const stack = 'stack' in error && typeof error.stack === 'string' ? error.stack : undefined
  return { message, ...stack === undefined ? {} : { stack } }
}

export default DynamicCordisRunnerService
