/**
 * Internal continuable-subagent manager: stable child ids, descriptor
 * persistence, activation admission, the live ownership graph, cold resume,
 * child-first disposal, and settlement delivery to the parent, behind
 * `ctx.subagents`.
 *
 * A continuable child has one durable Session and at most one process-local
 * {@link Activation} — one residency epoch for a reconstructed child Agent. An
 * Activation is not a request, result, cancellation, or Task boundary: it may
 * execute many FIFO turns and stays resident while descendants it created are
 * still running. The Agent inbox is the only turn queue, so this manager owns
 * residency while the Agent loop owns all turn ordering and execution. No
 * continuable path creates a Task or an intermediate result-bearing wrapper.
 *
 * Because residency is this manager's alone to end, telling the parent that a
 * child settled is its job too. An external `subagent/end` listener cannot do
 * it correctly: that payload names no parent, the child handle is already
 * disposed by then, and the release that wakes the parent's own settlement
 * watcher has already run. See {@link SubagentContinuationManager.notifySettlement}.
 *
 * @module @deepseek-ai/dsh-subagent
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ContentBlock, MessageId, MessageSource } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { SubagentDescriptorData } from './descriptor.ts';
import type { SubagentStartRequest } from './types.ts';
import type SubagentActivationSetupRegistry from './activation-setup-registry.ts';
import type { ContinuationHost } from './continuation-state.ts';
/** Attribution for a model coordinator's follow-up to one of its children. */
export interface CoordinatorMessageSource {
    readonly kind: 'coordinator';
    /** A message another agent addressed to this one (`relay` context form). */
    readonly form: 'relay';
    /** Session id of the agent whose tool call produced the follow-up. */
    readonly senderSessionId: SessionId;
}
/** Durable attribution and idempotency key for one Native child prompt. */
export interface SubagentPromptMessageSource {
    readonly kind: 'subagent-prompt';
    readonly form: 'relay';
    /** Exact live direct parent that admitted the prompt. */
    readonly senderSessionId: SessionId;
    /** Caller-stable identity reused after an indeterminate transport outcome. */
    readonly invocationId: string;
}
/** Durable attribution for a continuable child's explicit parent report. */
export interface SubagentReportMessageSource {
    readonly kind: 'subagent-report';
    /** A message another agent addressed to this one (`relay` context form). */
    readonly form: 'relay';
    /** Session id of the reporting child. */
    readonly senderSessionId: SessionId;
}
/**
 * Durable attribution for the runtime's own account of a continuable child
 * settling. Deliberately a different kind from
 * {@link SubagentReportMessageSource}: a report is content the child chose,
 * while this message is the manager stating what became of the child, and a
 * transcript that merged them would credit the child with words it never wrote.
 */
export interface SubagentSettledMessageSource {
    readonly kind: 'subagent-settled';
    /** A runtime account shown without expanding the row (`notice` context form). */
    readonly form: 'notice';
    /** One-line account of how the child ended. */
    readonly summary: string;
    /** Session id of the child that settled. */
    readonly senderSessionId: SessionId;
    /** Stable child-epoch identity used to suppress duplicate delivery. */
    readonly settlementId: string;
}
declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        coordinator: CoordinatorMessageSource;
        'subagent-prompt': SubagentPromptMessageSource;
        'subagent-report': SubagentReportMessageSource;
        'subagent-settled': SubagentSettledMessageSource;
    }
}
/** Deployment scheduling policy for accepted child reports. */
export type SubagentReportDelivery = 'quiet' | 'next-step';
/** Options for one continuable child's report to its direct parent. */
export interface SubagentReportOptions {
    /** Already-resolved parent scheduling policy. */
    readonly delivery: SubagentReportDelivery;
    /** Caller cancellation, owning authorization and admission until acceptance. */
    readonly signal: AbortSignal;
}
/** What a caller asks for when starting a continuable background child. */
export interface ContinuableStartSpec {
    /** The `ctx.subagents` provider whose continuable-creation capability establishes the child. */
    readonly provider: string;
    /** The initial delegation's short `description`, persisted as the child's creation label. */
    readonly label: string;
    /**
     * Optional caller-reserved child identity. Omission preserves the manager's
     * UUID allocation; supplying one lets a durable parent record provisioning
     * before child materialization without a second identity handshake.
     */
    readonly childId?: SessionId;
    /**
     * The delegation request. The manager reserves the stable child id, resolves
     * the durable descriptor, and composes the child itself.
     */
    readonly request: Omit<SubagentStartRequest, 'label' | 'signal' | 'outputSchema'>;
    /** Caller cancellation, owning admission only until inbox acceptance. */
    readonly signal: AbortSignal;
}
/** Identities returned once a continuable child accepted its initial prompt. */
export interface ContinuableStart {
    /** The durable child session id, stable across activations. */
    readonly childId: SessionId;
    /** The accepted initial prompt's inbox message id. */
    readonly messageId: MessageId;
    /** The inbox insertion reached the configured Session persistence barrier. */
    readonly durable: true;
}
/**
 * Authority under which one interrupt request is admitted. `user` carries the
 * durable direct-parent address a human client presented; `ancestor` carries
 * the exact live Agent object whose recorded lineage must contain the caller.
 */
export type SubagentInterruptAuthority = {
    readonly kind: 'user';
    readonly parentSessionId: SessionId;
} | {
    readonly kind: 'ancestor';
    readonly agent: Agent;
};
/** Options for following up with one continuable child. */
export interface SubagentFollowupOptions {
    /** Durable attribution retained on the delivered message; it grants no authority. */
    readonly source: MessageSource;
    /** Optional caller-stable idempotency key carried by `subagent-prompt`. */
    readonly invocationId?: string;
    /** Caller cancellation, owning admission only until inbox acceptance. */
    readonly signal: AbortSignal;
}
/** Internal receipt shared by initial and resumed durable delivery. */
export interface DurableSubagentMessageReceipt {
    readonly messageId: MessageId;
    readonly durable: true;
    readonly duplicate: boolean;
}
/**
 * The continuable-subagent orchestration service behind `ctx.subagents`. Tool
 * schema and host adapters are consumers of this one contract; foreground
 * one-shot delegation keeps calling `ctx.subagents.start()` and never enters
 * this lifecycle.
 */
export declare class SubagentContinuationManager {
    private readonly ctx;
    private readonly host;
    /** Child session id → its live Activation. Process-local, never durable. */
    private activations;
    /** Materializations admitted before drain, tracked through publication or rollback. */
    private readonly materializations;
    private readonly locks;
    private readonly ownership;
    private readonly materializer;
    private readonly disposer;
    private readonly settlementWatcher;
    /** Structural Cordis owner of every Activation handle. */
    private readonly ownerCtx;
    constructor(ctx: Context, host: ContinuationHost, setupRegistry: SubagentActivationSetupRegistry);
    /**
     * Start one continuable background child: reserve its durable identity,
     * resolve the provider's detached creation spec, create the child Agent
     * through the private activation-owner scope, establish any continuable-parent
     * ownership, and submit the initial prompt. Resolves when the accepted inbox
     * insertion reaches Session persistence, without waiting for the turn to
     * finish.
     *
     * Every failure before that acceptance rejects without either id, disposing
     * any created handle and rolling back the Activation and parent ownership.
     * The caller signal owns lookup, materialization, and admission only until
     * acceptance; afterwards the manager owns the Activation independently.
     * @param spec - provider, delegation request, and caller cancellation.
     * @returns the durable child id and the accepted initial prompt's message id.
     */
    startContinuable(spec: ContinuableStartSpec): Promise<ContinuableStart>;
    /** Reject one child identity already owned by a live Agent or Session. */
    private assertChildIdAvailable;
    /**
     * Deliver one later message to a known continuable child as its next FIFO
     * turn. Routing depends only on Activation residency: a `running` Activation
     * enqueues, a `waiting` one wakes the same Agent, and an absent one
     * cold-resumes a new Activation from the persisted Session. The Agent inbox
     * is the only queue, so every accepted message has one observable order.
     *
     * The caller signal owns lookup, materialization, and admission only until
     * inbox acceptance; the subsequent durability wait is not caller-cancellable,
     * so an accepted turn cannot become an ambiguous cancellation.
     * @param parent - the exact live direct parent authorizing this delivery.
     * @param childId - the durable child session id.
     * @param content - the user-role content to deliver.
     * @param options - the message source fields and caller cancellation.
     * @returns the accepted message's inbox id.
     * @throws when parent authority, availability, or admission rejects the delivery.
     */
    followup(parent: Agent, childId: SessionId, content: ContentBlock[], options: SubagentFollowupOptions): Promise<MessageId>;
    /**
     * Deliver one message and return its durable/idempotent receipt. Native uses
     * this richer boundary; model-facing callers retain the MessageId-only API.
     * A new delivery enters the child's FIFO inbox, cold-resuming it if absent.
     * An exact invocation retry returns the original id without another turn;
     * reusing the key with different content or parent identity rejects.
     * After inbox acceptance, the durability wait is not caller-cancellable.
     * A persistence failure rejects without retracting the accepted message.
     * @param parent - Exact live direct parent authorizing this delivery.
     * @param childId - Durable child session id, stable across activations.
     * @param content - User-role content to enqueue, or match on an invocation retry.
     * @param options - Durable source, optional idempotency key, and pre-acceptance
     *   cancellation. A `subagent-prompt` source requires a matching canonical UUID
     *   `invocationId` and the direct parent's `senderSessionId`; other sources omit the key.
     * @returns The new or original message id with `durable: true` after persistence
     *   is established, and `duplicate` indicating a retry; it does not await turn completion.
     * @throws When authority, invocation identity, admission, materialization, or
     *   persistence fails, or caller cancellation prevents new inbox acceptance.
     */
    followupReceipt(parent: Agent, childId: SessionId, content: ContentBlock[], options: SubagentFollowupOptions): Promise<DurableSubagentMessageReceipt>;
    /**
     * Interrupt one live continuable child's current turn. Admission is
     * synchronous and the effect is asynchronous: this authorizes the caller,
     * requests `Agent.cancel(cause, { keepInbox: true })` on the target, and
     * returns without waiting for the target to observe the signal or reach
     * quiescence. The Activation, its handle, accepted unclaimed inbox work, and
     * already-published descendants are untouched; work already claimed into the
     * interrupted turn is not requeued. Once the interrupted driver is idle, a
     * waking send resumes the parked queue.
     *
     * An absent target is an accepted no-op, which uniformly covers natural
     * completion races, repeated requests, one-shot ids, and unknown ids without
     * consulting the durable catalog. A target whose disposal transaction is
     * already open is likewise an accepted no-op after authorization.
     * @param targetSessionId - the durable child session id to interrupt.
     * @param authority - the human parent address or exact live ancestor Agent.
     * @throws {SubagentError} `UNAUTHORIZED` when the presented authority does
     *   not own the live target: a stale or self-targeting ancestor caller, a
     *   parent address that is not the live target's durable direct parent, or
     *   an ancestor outside the target's recorded live lineage.
     */
    interrupt(targetSessionId: SessionId, authority: SubagentInterruptAuthority): void;
    /**
     * Deliver explicitly selected content from one resident continuable child to
     * its durable direct parent. Sender authorization, parent resolution, and
     * send acceptance share one no-await span. Reporting neither concludes the
     * child's turn nor changes its Activation lifetime.
     * @param child - exact live reporting child; this is the authority credential.
     * @param content - selected model-facing content.
     * @param options - scheduling policy and pre-acceptance cancellation.
     * @returns the stable identity of the message accepted by the parent.
     * @throws {SubagentError} when the sender is unauthorized, the parent is not
     *   live, or continuation admission is closing.
     */
    reportFrom(child: Agent, content: ContentBlock[], options: SubagentReportOptions): Promise<MessageId>;
    /** Authorize only the exact Agent of one resident Activation. */
    private authorizeReporter;
    /** Resolve the reporting child's live direct parent from durable lineage. */
    private resolveReportParent;
    /** Deliver one framed report through the selected parent scheduling preset. */
    private deliverReport;
    /**
     * Perform one waking send to a parent, accounted against that parent's own
     * Activation when it has one. Registering the id before the send is what
     * keeps a continuation-managed parent from being judged quiescent in the
     * window between a waking send and the microtask that admits it.
     * @param parent - the exact live parent receiving the waking message.
     * @param message - the message whose id is accounted.
     * @param send - the synchronous waking send to perform.
     */
    private sendWaking;
    /** Send one report while translating only the parent's own rejection. */
    private sendReport;
    /**
     * Close admission, await every already-admitted materialization through
     * publication or rollback, then dispose the stable live Activation forest
     * child-first. Sibling branches drain independently: one failure is recorded
     * but never prevents the remaining handles from being attempted, and the
     * aggregate rejects only after every branch settles.
     * @returns once materialization is quiescent and every live Activation released its handle.
     * @throws an aggregate error when any branch failed to release.
     */
    drain(): Promise<void>;
    /**
     * Stop only the continuable descendants of exact live host-owned parents.
     * Admission stays closed for those parent trees until each exact parent
     * leaves the Agent registry; unrelated trees and manager-wide admission stay
     * live.
     * @param parents - exact live roots whose continuable descendants must stop.
     * @returns once every retained descendant Activation released its handle.
     * @throws an aggregate error after all scoped branches settle when any failed.
     */
    drainDescendants(parents: readonly Agent[]): Promise<void>;
    /**
     * Release selected resident direct children of one exact live parent without
     * closing admission for the parent's other continuable children. Owned
     * descendants are released recursively through the same lifecycle.
     * @param parent - exact live direct parent authorizing the selected release.
     * @param childIds - durable direct-child ids to release when resident.
     * @returns once every selected Activation released its handle.
     * @throws {SubagentError} `UNAUTHORIZED` when a resident target is not the
     *   parent's direct continuable child or the parent identity is stale.
     */
    drainChildren(parent: Agent, childIds: readonly SessionId[]): Promise<void>;
    /**
     * Cold-resume a persisted child: inspect and authorize its Session, fold the
     * generic descriptor, create the Activation through `ctx.agents.resume()`,
     * and submit the waiting turn. This never dispatches through a subagent
     * provider — the persisted Session already holds the initial prefix and the
     * descriptor is the whole reconstruction input.
     */
    private coldResume;
    /**
     * Submit to a freshly materialized Activation or roll it back completely.
     * @param activation - the just-published Activation to admit or release.
     * @param content - the initial or resumed message content.
     * @param source - durable fields naming who supplied the accepted message.
     * @param parent - the live direct parent authorizing admission.
     * @param signal - caller cancellation owning admission until acceptance.
     * @returns the accepted inbox message id.
     */
    private submitMaterialized;
    /** Let a settlement watcher re-observe quiescence after ownership or inbox changes. */
    private wake;
    /**
     * Submit one message as the child's next FIFO turn. The caller-visible success
     * boundary is the durability flush performed by the enclosing helper.
     */
    private submit;
    /**
     * Account one waking send across a resident Activation's settlement window.
     * @param activation - Activation receiving waking inbox work.
     * @param messageId - stable identity of the message about to be sent.
     * @param send - synchronous send that publishes one enqueue occurrence.
     * @returns the accepted message id.
     */
    private admitWaking;
    /**
     * Cross the final admission cutoff and submit without yielding. Signal abort,
     * manager drain, or Activation disposal that wins before this synchronous
     * span rejects without inbox acceptance.
     */
    private submitAdmitted;
    /** Submit one admitted message and hold the child lock through durability. */
    private submitAndFlush;
    /** Flush the exact live child session after its inbox splice was accepted. */
    private flushAccepted;
    /** Keep a newly returned child resident through its caller's next microtask. */
    private holdReceiptHandoff;
    /** Validate that a caller-supplied idempotency key is carried by its source. */
    private assertInvocationContract;
    /**
     * Find a prior durable/live insertion for one invocation. Reusing the key
     * with different content or authority fails loud; an exact retry returns the
     * original message id and never enqueues a second turn.
     */
    private invocationReceipt;
    /**
     * Authorize one operation against the durable direct-parent lineage. Other
     * agents, ancestors, teams, workflows, and hosts remain rejected until an
     * explicit authority protocol has a production consumer.
     */
    private authorizeLineage;
    /** Resolve the persistence service continuable children require, or fail loud. */
    private requirePersistence;
}
export type { SubagentDescriptorData };
export default SubagentContinuationManager;
//# sourceMappingURL=continuation.d.ts.map