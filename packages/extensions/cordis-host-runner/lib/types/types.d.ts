/** Host-only vocabulary of the dynamic Cordis plugin runner. */
import type { Branded } from '@deepseek-ai/dsh-brand';
import type { JsonValue, SessionId } from '@deepseek-ai/dsh-session/types';
/** Stable identity of one dynamic plugin instance. */
export type CordisDynamicPluginId = Branded<'CordisDynamicPluginId'>;
/** Identity of one immutable package version. */
export type CordisDynamicPackageId = Branded<'CordisDynamicPackageId'>;
/** Identity of one activation attempt. */
export type CordisDynamicPluginRunId = Branded<'CordisDynamicPluginRunId'>;
/** Runtime plane exposed by the inspect registry. */
export type CordisInspectPlatform = 'host';
/** One read-only method exposed by an inspect provider. */
export interface CordisInspectMethodManifest {
    /** Method name, unique within its provider. */
    name: string;
    /** What the method returns and when to use it. */
    description: string;
    /** JSON Schema accepted by the method. */
    inputSchema: JsonValue;
    /** JSON Schema produced by the method. */
    outputSchema: JsonValue;
}
/** Serializable directory entry for one inspect provider. */
export interface CordisInspectProviderManifest {
    /** Provider identity. */
    id: string;
    /** Capability described by this provider. */
    description: string;
    /** Explicit read-only methods. */
    methods: readonly CordisInspectMethodManifest[];
}
/** Provider directory row returned to the model. */
export interface CordisInspectProviderView extends CordisInspectProviderManifest {
    /** Inspect providers execute in the Host process. */
    platform: 'host';
}
/** Whether a package starts the current version or replaces it. */
export type CordisDynamicRunMode = 'run' | 'update';
/** Error fields preserved in tool results. */
export interface CordisErrorDetails {
    /** Original error message. */
    message: string;
    /** Original stack when supplied. */
    stack?: string;
}
/** Persisted activation state. */
export type CordisRunStatus = 'starting-host' | 'running' | 'waiting' | 'failed' | 'stopped';
/** Host lifecycle state within one activation attempt. */
export interface CordisHostState {
    /** Current Host lifecycle state. */
    status: 'pending' | 'stopped' | 'running' | 'waiting' | 'failed';
    /** Services a settled Fiber still needs. */
    waitingFor: readonly string[];
    /** Startup failure text. */
    error?: string;
}
/** Structured failure associated with one activation attempt. */
export interface CordisRunDiagnostic {
    /** Host stage that failed. */
    phase: 'host-load' | 'host-guard';
    /** Original failure text. */
    message: string;
    /** Original failure stack when available. */
    stack?: string;
    pluginId: CordisDynamicPluginId;
    packageId: CordisDynamicPackageId;
    pluginRunId: CordisDynamicPluginRunId;
}
/** Latest activation attempt retained independently from the physical run. */
export interface DynamicCordisRunAttempt {
    pluginRunId: CordisDynamicPluginRunId;
    packageId: CordisDynamicPackageId;
    mode: CordisDynamicRunMode;
    status: CordisRunStatus;
    host: CordisHostState;
    error?: CordisRunDiagnostic;
}
/** Package metadata exposed without source code. */
export interface DynamicCordisInventoryPackage {
    packageId: CordisDynamicPackageId;
    name: string;
    purpose: string;
}
/** One stable plugin row in the process-wide inventory. */
export interface DynamicCordisInventoryRow {
    pluginId: CordisDynamicPluginId;
    agentId: SessionId;
    packages: readonly DynamicCordisInventoryPackage[];
    currentPackageId?: CordisDynamicPackageId;
    nextPackageId?: CordisDynamicPackageId;
    activeRun?: {
        pluginRunId: CordisDynamicPluginRunId;
        packageId: CordisDynamicPackageId;
    };
    latestRun?: DynamicCordisRunAttempt;
}
/** Host-rich snapshot used by inspection and tool result rendering. */
export interface DynamicCordisSnapshotRow {
    pluginId: CordisDynamicPluginId;
    currentPackageId?: CordisDynamicPackageId;
    nextPackageId?: CordisDynamicPackageId;
    packages: DynamicCordisInventoryPackage[];
    activeRun?: {
        pluginRunId: CordisDynamicPluginRunId;
        packageId: CordisDynamicPackageId;
        /** Live Fiber, available only inside the Host process. */
        fiber?: import('@deepseek-ai/cordis').Fiber;
    };
    latestRun?: DynamicCordisRunAttempt;
}
/** Answer to removing a plugin and all package versions. */
export type DynamicCordisUndefineReceipt = {
    ok: true;
    wasRunning: boolean;
} | {
    ok: false;
    reason: 'plugin-missing';
    message: string;
};
/** Result of starting or updating one Host package. */
export type DynamicCordisRunResponse = {
    ok: true;
    status: 'running' | 'waiting';
    pluginId: CordisDynamicPluginId;
    packageId: CordisDynamicPackageId;
    pluginRunId: CordisDynamicPluginRunId;
    waitingFor: readonly string[];
    currentPackageId: CordisDynamicPackageId;
    mode: CordisDynamicRunMode;
} | {
    ok: false;
    reason: 'plugin-missing' | 'package-missing' | 'invalid-mode' | 'transition-in-flight' | 'host-half-failed' | 'not-running';
    message: string;
    stack?: string;
};
/** Result of stopping a plugin without deleting its packages. */
export type DynamicCordisStopResponse = {
    ok: true;
} | {
    ok: false;
    reason: 'plugin-missing' | 'not-running';
    message: string;
};
//# sourceMappingURL=types.d.ts.map