import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { type Session, type SessionEvent } from '@deepseek-ai/dsh-session';
import type { TeamJournal } from './journal.ts';
import type { TeamRuntimeLifecycle } from './lifecycle.ts';
import { type TeamRoster } from './roster.ts';
import type { SendTeamMessageRequest, SendTeamMessageResult } from './types.ts';
/** Owns process-local admission and delivery state for the durable mailbox. */
export declare class TeamMailbox {
    private readonly ctx;
    private readonly journal;
    private readonly roster;
    private readonly lifecycle;
    private readonly maxPendingMessagesPerMember;
    private readonly maxMessageBytes;
    private readonly dispatchTails;
    private readonly activeDispatches;
    private readonly inFlightMessages;
    private readonly inFlightDispatches;
    constructor(ctx: Context, journal: TeamJournal, roster: TeamRoster, lifecycle: TeamRuntimeLifecycle, maxPendingMessagesPerMember: number, maxMessageBytes: number);
    /**
     * Queue a durable peer message, then attempt delivery.
     * @param caller - exact live sending member.
     * @param request - target, content, delivery mode and pre-queue cancellation.
     * @returns durable identity and immediate acceptance observation.
     */
    send(caller: Agent, request: SendTeamMessageRequest): Promise<SendTeamMessageResult>;
    /**
     * Checkpoint a target's receipt before acknowledging it in the Lead log.
     * @param session - exact target Session.
     * @param event - newly appended Session event.
     */
    observeSessionEvent(session: Session, event: SessionEvent): void;
    /**
     * Retry pending messages relevant to a newly started member.
     * @param agent - exact live member.
     * @param signal - runtime cancellation.
     */
    recoverFor(agent: Agent, signal: AbortSignal): Promise<void>;
    /**
     * Capture admitted mailbox work before shutdown waits for it.
     * @returns admitted dispatch and acknowledgement operations.
     */
    pendingDispatches(): readonly Promise<unknown>[];
    private sendAdmitted;
    private tryDispatch;
    private trackDispatch;
    private tryDispatchAdmitted;
    private serializeDispatch;
    private dispatchOnce;
    private messagePrecedes;
    private checkpointDelivered;
    private markDelivered;
    private targetRecorded;
    private deliveryContent;
    private persistedTargetRecorded;
}
//# sourceMappingURL=mailbox.d.ts.map