import { type Context } from '@deepseek-ai/cordis';
import type { LlmRuntime } from './index.ts';
import type { RemoteLlmProviderMutationRequest, RemoteLlmProviderMutationResult, RemoteLlmProviderResumeRequest, RemoteLlmProviderTransactionRequest, RemoteLlmProviderTransactionResult } from './types.ts';
/** Each runtime drains its accepted work; shared service identities own resource serialization. */
export declare class ProviderTransactions {
    private readonly ctx;
    private readonly runtime;
    private readonly pending;
    private stopped;
    constructor(ctx: Context, runtime: LlmRuntime);
    /**
     * Serialize shared configuration resources; unrelated namespaces and ordinary streaming remain independent.
     * @param input - Native request, snapshotted before waiting for the previous write.
     * @param signal - cancellation before durable claim; committed work retains ownership.
     * @returns the redacted committed state, or a typed recovery failure.
     */
    mutate(input: RemoteLlmProviderMutationRequest, signal: AbortSignal): Promise<RemoteLlmProviderMutationResult>;
    /**
     * Read the stored phase without claiming, upgrading, or executing the transaction.
     * @param input - provider and caller-held transaction id.
     * @returns durable state and write-only credential requirement, never the plan or value.
     */
    status(input: RemoteLlmProviderTransactionRequest): Promise<RemoteLlmProviderTransactionResult>;
    private query;
    /**
     * Continue the captured durable plan under the same journal, namespace and reference leases as new writes.
     * @param input - stored transaction identity and an optional write-only missing credential.
     * @param signal - cancellation before claim only; claimed work remains owned until settlement.
     * @returns the committed redacted state, or the durable terminal/recovery failure.
     */
    resume(input: RemoteLlmProviderResumeRequest, signal: AbortSignal): Promise<RemoteLlmProviderMutationResult>;
    private run;
    private track;
    private execute;
    private checkReceipt;
    private matches;
    private read;
    private claim;
    private resolveCredential;
    private preflight;
    private write;
    private applyCredential;
    private conflict;
    private settingsFailure;
    private result;
}
//# sourceMappingURL=provider-transaction.d.ts.map