/** Dynamic Cordis service for model-authored Host plugins. */
import { Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { isPlugin } from "./guard.js";
import { CordisInspectRegistryService } from "./inspect-registry.js";
import { missingServices, startHostHalf } from "./lifecycle.js";
import { DynamicCordisRegistry } from "./registry.js";
import { steerGuardFailure } from "./steering.js";
import { inspectPackageFor, inspectPluginFor, inventoryRows, listPluginsFor, missingPluginMessage, referenceFor, snapshotRows, } from "./queries.js";
import { createSandbox, evaluateHostCode, precheckCode } from "./sandbox.js";
export { CordisInspectRegistryService } from "./inspect-registry.js";
export { HOST_BUILTIN_INSPECTION } from "./sandbox.js";
/**
 * Brand a Host-minted Plugin ID.
 * @param id - The id input.
 * @returns The value produced by cordis dynamic plugin id.
 */
export function CordisDynamicPluginId(id) {
    return id;
}
/**
 * Brand a Host-minted Package ID.
 * @param id - The id input.
 * @returns The value produced by cordis dynamic package id.
 */
export function CordisDynamicPackageId(id) {
    return id;
}
/**
 * Brand a Host-minted activation ID.
 * @param id - The id input.
 * @returns The value produced by cordis dynamic plugin run id.
 */
export function CordisDynamicPluginRunId(id) {
    return id;
}
/** Dynamic Host Plugin registry and lifecycle. */
export class DynamicCordisRunnerService extends Service {
    static inject = ['tools'];
    static Config = z.object({
        vmTimeoutMs: z.number().min(1).default(5000),
    });
    rootCtx;
    registry = new DynamicCordisRegistry();
    starting = new Map();
    resolved;
    group;
    /** Create the service under the Host composition. */
    constructor(ctx, config) {
        super(ctx, 'dynamicCordisRunner');
        this.rootCtx = ctx;
        this.resolved = config;
        new CordisInspectRegistryService(ctx);
    }
    /**
     * Define a new Plugin Package or append a version to an existing Plugin.
     * @param request - Session-owned plugin and immutable Host source definition.
     * @returns The minted plugin and package identities.
     */
    define(request) {
        const name = request.name.trim();
        const purpose = request.purpose.trim();
        const hostCode = request.code.host;
        if (name.length === 0)
            throw new Error('cordis_define needs a non-empty `name`');
        if (purpose.length === 0)
            throw new Error('cordis_define needs a non-empty `purpose`');
        if (hostCode.trim().length === 0)
            throw new Error('cordis_define needs non-empty `code.host`');
        precheckCode(hostCode, 'code.host');
        let plugin;
        if (request.plugin.kind === 'new') {
            const prefix = request.plugin.idPrefix.trim();
            if (!/^[a-z]{3,6}$/.test(prefix)) {
                throw new Error('cordis_define `plugin.idPrefix` must contain 3–6 lowercase English letters');
            }
            const pluginId = CordisDynamicPluginId(this.registry.mintPluginId(prefix));
            plugin = { pluginId, sessionId: request.sessionId, packages: new Map() };
            this.registry.add(plugin);
        }
        else {
            const found = this.registry.get(request.plugin.pluginId);
            if (found === undefined || found.sessionId !== request.sessionId) {
                throw new Error(missingPluginMessage(request.plugin.pluginId));
            }
            plugin = found;
        }
        const packageId = CordisDynamicPackageId(this.registry.mintPackageId());
        plugin.packages.set(packageId, { packageId, name, purpose, hostCode });
        return { pluginId: plugin.pluginId, packageId, name, purpose };
    }
    /**
     * Remove one owned Plugin and all immutable Packages.
     * @param agent - Session agent that owns the plugin.
     * @param pluginId - Plugin identity to remove.
     * @returns Removal status and whether a running Host half was stopped.
     */
    async undefine(agent, pluginId) {
        const plugin = this.owned(agent, pluginId);
        if (plugin === undefined)
            return { ok: false, reason: 'plugin-missing', message: missingPluginMessage(pluginId) };
        const wasRunning = plugin.run !== undefined;
        if (plugin.run !== undefined)
            await this.retract(plugin);
        this.registry.delete(pluginId);
        return { ok: true, wasRunning };
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
    async run(agent, pluginId, packageId, mode, signal) {
        const plan = this.resolvePlan(agent, pluginId, packageId, mode);
        if (!plan.ok)
            return plan.response;
        if (signal?.aborted === true) {
            return { ok: false, reason: 'host-half-failed', message: `activation of dynamic plugin "${pluginId}" was cancelled` };
        }
        const active = plan.plugin.run;
        if (active?.packageId === packageId)
            return this.runResponse(plan.plugin, active, mode);
        const inFlight = this.starting.get(pluginId);
        if (inFlight !== undefined) {
            return { ok: false, reason: 'transition-in-flight', message: `dynamic plugin "${pluginId}" is already starting` };
        }
        const attempt = this.createAttempt(plan);
        plan.plugin.nextPackageId = packageId;
        plan.plugin.latestRun = attempt;
        const starting = this.activate(plan, attempt);
        this.starting.set(pluginId, starting);
        try {
            return await starting;
        }
        finally {
            this.starting.delete(pluginId);
        }
    }
    /**
     * Stop one owned Plugin while retaining its Packages.
     * @param agent - Session agent that owns the plugin.
     * @param pluginId - Plugin identity to stop.
     * @returns Stop status and diagnostics.
     */
    async stop(agent, pluginId) {
        const plugin = this.owned(agent, pluginId);
        if (plugin === undefined)
            return { ok: false, reason: 'plugin-missing', message: missingPluginMessage(pluginId) };
        if (plugin.run === undefined)
            return { ok: false, reason: 'not-running', message: `dynamic plugin "${pluginId}" is not running` };
        await this.retract(plugin);
        delete plugin.nextPackageId;
        if (plugin.latestRun !== undefined) {
            plugin.latestRun.status = 'stopped';
            plugin.latestRun.host = { status: 'stopped', waitingFor: [] };
        }
        return { ok: true };
    }
    /**
     * Process-wide source-free inventory.
     * @returns All registered plugin/package lifecycle rows.
     */
    inventory() {
        return inventoryRows(this.registry);
    }
    /**
     * One Session's Host-rich snapshot.
     * @param agent - Session agent whose owned plugins are inspected.
     * @returns Session-scoped plugin/package snapshot rows.
     */
    snapshot(agent) {
        return snapshotRows(this.registry, agent);
    }
    /**
     * Source-free reference to one owned Plugin.
     * @param agent - Session agent that owns the plugin.
     * @param pluginId - Plugin identity to resolve.
     * @returns A stable plugin reference, or undefined when absent.
     */
    reference(agent, pluginId) {
        return referenceFor(this.registry, agent, pluginId);
    }
    /**
     * List owned Plugin summaries.
     * @param agent - Session agent whose plugins are listed.
     * @returns Session-owned plugin inspection rows.
     */
    listPlugins(agent) {
        return listPluginsFor(this.registry, agent);
    }
    /**
     * Inspect one owned Plugin.
     * @param agent - Session agent that owns the plugin.
     * @param pluginId - Plugin identity to inspect.
     * @returns Detailed plugin inspection data.
     */
    inspectPlugin(agent, pluginId) {
        return inspectPluginFor(this.registry, agent, pluginId);
    }
    /**
     * Inspect one immutable owned Package and its Host source.
     * @param agent - Session agent that owns the plugin.
     * @param pluginId - Plugin identity containing the package.
     * @param packageId - Immutable package identity to inspect.
     * @returns Detailed package inspection data.
     */
    inspectPackage(agent, pluginId, packageId) {
        return inspectPackageFor(this.registry, agent, pluginId, packageId);
    }
    resolvePlan(agent, pluginId, packageId, mode) {
        const plugin = this.owned(agent, pluginId);
        if (plugin === undefined)
            return { ok: false, response: { ok: false, reason: 'plugin-missing', message: missingPluginMessage(pluginId) } };
        const definition = plugin.packages.get(packageId);
        if (definition === undefined) {
            return { ok: false, response: { ok: false, reason: 'package-missing', message: `plugin "${pluginId}" has no package "${packageId}"` } };
        }
        const current = plugin.currentPackageId;
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
            };
        }
        if (mode === 'run' && current !== undefined && current !== packageId) {
            return {
                ok: false,
                response: {
                    ok: false,
                    reason: 'invalid-mode',
                    message: `package "${packageId}" differs from current "${current}"; use mode "update"`,
                },
            };
        }
        return { ok: true, plugin, definition, mode };
    }
    async activate(plan, attempt) {
        const { plugin, definition } = plan;
        if (plugin.run !== undefined)
            await this.retract(plugin);
        const run = {
            pluginRunId: attempt.pluginRunId,
            packageId: definition.packageId,
            reportedRuntimeErrors: new Set(),
        };
        const failure = await this.startHost(plugin, definition.hostCode, run);
        if (failure !== undefined) {
            this.failAttempt(plugin, attempt, failure);
            return { ok: false, reason: 'host-half-failed', ...failure };
        }
        plugin.run = run;
        plugin.currentPackageId = run.packageId;
        delete plugin.nextPackageId;
        const waitingFor = missingFor(this.ctx, run);
        attempt.host = { status: waitingFor.length === 0 ? 'running' : 'waiting', waitingFor };
        attempt.status = waitingFor.length === 0 ? 'running' : 'waiting';
        delete attempt.error;
        return this.runResponse(plugin, run, plan.mode);
    }
    async startHost(plugin, hostCode, run) {
        try {
            const evaluated = await evaluateHostCode(createSandbox(plugin.pluginId), hostCode, plugin.pluginId, this.resolved.vmTimeoutMs);
            if (!isPlugin(evaluated)) {
                throw new Error(evaluated === undefined
                    ? 'the Host package returned `undefined` — did you forget `return`?'
                    : 'the Host package must return a Plugin function or an object with apply(ctx)');
            }
            run.fiber = await startHostHalf(this.requireGroup(), evaluated, (error) => {
                const failure = errorDetails(error);
                const key = `Host\u0000guard\u0000${failure.message}`;
                if (!this.claimRuntimeFailure(plugin, run, key))
                    return;
                const attempt = plugin.latestRun;
                if (attempt?.pluginRunId === run.pluginRunId) {
                    attempt.error = this.diagnostic(plugin, attempt, 'host-guard', failure);
                }
                steerGuardFailure(this.rootCtx.get('agents'), plugin, run, failure);
            });
            return undefined;
        }
        catch (error) {
            return errorDetails(error);
        }
    }
    runResponse(plugin, run, mode) {
        const waitingFor = missingFor(this.ctx, run);
        return {
            ok: true,
            status: waitingFor.length === 0 ? 'running' : 'waiting',
            pluginId: plugin.pluginId,
            packageId: run.packageId,
            pluginRunId: run.pluginRunId,
            waitingFor,
            currentPackageId: run.packageId,
            mode,
        };
    }
    createAttempt(plan) {
        return {
            pluginRunId: CordisDynamicPluginRunId(this.registry.mintPluginRunId()),
            packageId: plan.definition.packageId,
            mode: plan.mode,
            status: 'starting-host',
            host: { status: 'pending', waitingFor: [] },
        };
    }
    failAttempt(plugin, attempt, failure) {
        attempt.status = 'failed';
        attempt.host = { status: 'failed', waitingFor: [], error: failure.message };
        attempt.error = this.diagnostic(plugin, attempt, 'host-load', failure);
    }
    diagnostic(plugin, attempt, phase, failure) {
        return {
            phase,
            ...failure,
            pluginId: plugin.pluginId,
            packageId: attempt.packageId,
            pluginRunId: attempt.pluginRunId,
        };
    }
    claimRuntimeFailure(plugin, run, key) {
        const attempt = plugin.latestRun;
        if (plugin.run !== run || attempt?.pluginRunId !== run.pluginRunId
            || (attempt.status !== 'running' && attempt.status !== 'waiting'))
            return false;
        if (run.reportedRuntimeErrors.has(key))
            return false;
        run.reportedRuntimeErrors.add(key);
        return true;
    }
    async retract(plugin) {
        const run = plugin.run;
        if (run === undefined)
            return;
        delete plugin.run;
        if (run.fiber !== undefined)
            await run.fiber.dispose();
    }
    owned(agent, pluginId) {
        const plugin = this.registry.get(pluginId);
        return plugin?.sessionId === agent.id ? plugin : undefined;
    }
    requireGroup() {
        this.group ??= this.rootCtx.plugin({ name: 'cordis-dynamic', apply: () => { } });
        return this.group;
    }
}
function missingFor(ctx, run) {
    return run.fiber === undefined ? [] : missingServices(ctx, run.fiber);
}
function errorDetails(error) {
    if (typeof error !== 'object' || error === null)
        return { message: String(error) };
    const message = 'message' in error && typeof error.message === 'string'
        ? error.message
        : Object.prototype.toString.call(error);
    const stack = 'stack' in error && typeof error.stack === 'string' ? error.stack : undefined;
    return { message, ...stack === undefined ? {} : { stack } };
}
export default DynamicCordisRunnerService;
//# sourceMappingURL=index.js.map