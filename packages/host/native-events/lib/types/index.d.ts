/**
 * Authoritative Native event projections and interactive response correlation.
 *
 * Durable Sessions, Agents, Workspaces, jobs, and projections remain owned by
 * their domain services. This package owns only their live Native projection,
 * the two reconnectable event sources, and the pending human-interaction table
 * paired with the exact response carrier.
 *
 * @module @deepseek-ai/dsh-host-native-events
 */
import { Context, Service } from '@deepseek-ai/cordis';
import type { ConnectionEventChannel } from '@deepseek-ai/dsh-host-connection';
import type { JobSnapshot } from '@deepseek-ai/dsh-jobs';
import { type CallId, type UserMessage } from '@deepseek-ai/dsh-llm';
import { type JsonValue, type SessionEvent, type SessionId } from '@deepseek-ai/dsh-session';
import type { ApprovalOutcome, ApprovalRequestId } from '@deepseek-ai/dsh-user-approval';
import { type AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions';
import { type WorkspaceId, type WorkspaceRemoteView } from '@deepseek-ai/dsh-workspace';
declare module '@deepseek-ai/cordis' {
    interface Context {
        /** Native event and interactive-response owner. */
        nativeEvents: NativeEventsService;
    }
}
/** One pending inbox occurrence in the authoritative queue snapshot. */
export interface NativeQueuedInboxItem {
    readonly id: UserMessage['id'];
    readonly placement: 'queued' | 'steering' | 'context';
    readonly message: UserMessage;
}
/** Tool-owned render intent accompanying one live durable event. */
export type NativeToolEventView = {
    readonly for: 'call';
    readonly view: JsonValue;
} | {
    readonly for: 'result';
    readonly view: JsonValue;
};
/** Public projection of a background job. */
export interface NativeJobView {
    readonly id: JobSnapshot['id'];
    readonly kind: JobSnapshot['kind'];
    readonly label: string;
    readonly status: JobSnapshot['status'];
    readonly detail?: string;
    readonly startedAt: number;
    readonly finishedAt?: number;
}
/** Native mux-stream payloads. */
export type NativeMuxFrame = NativeStreamBaselineFrame<'mux'> | {
    readonly type: 'session/event';
    readonly sessionId: SessionId;
    readonly event: SessionEvent;
    readonly view?: NativeToolEventView;
} | {
    readonly type: 'session/subscribed';
    readonly sessionId: SessionId;
    readonly lastSeq: number;
} | {
    readonly type: 'approval/requested';
    readonly sessionId: SessionId;
    readonly approvalId: ApprovalRequestId;
    readonly toolName: string;
    readonly callId?: CallId;
    readonly reason?: string;
} | {
    readonly type: 'approval/resolved';
    readonly sessionId: SessionId;
    readonly approvalId: ApprovalRequestId;
    readonly outcome: ApprovalOutcome;
} | {
    readonly type: 'question/requested';
    readonly sessionId: SessionId;
    readonly questions: AskUserQuestionItem[];
} | {
    readonly type: 'question/resolved';
    readonly sessionId: SessionId;
    readonly questionRpcId: string;
    readonly outcome: 'answered' | 'cancelled';
} | {
    readonly type: 'session/queue';
    readonly sessionId: SessionId;
    readonly items: NativeQueuedInboxItem[];
} | {
    readonly type: 'session/jobs';
    readonly sessionId: SessionId;
    readonly jobs: NativeJobView[];
} | {
    readonly type: 'session/projection';
    readonly sessionId: SessionId;
    readonly key: string;
    readonly value: unknown;
    readonly seq: number;
};
/** Native Host-stream payloads. */
export type NativeHostFrame = NativeStreamBaselineFrame<'host'> | {
    readonly type: 'host/session-added';
    readonly sessionId: SessionId;
    readonly blank: boolean;
    readonly parentSessionId?: SessionId;
    readonly origin?: 'subagent';
    readonly cwd?: string;
    readonly agentPreset?: string;
} | {
    readonly type: 'host/session-removed';
    readonly sessionId: SessionId;
} | {
    readonly type: 'host/session-deleted';
    readonly sessionId: SessionId;
    readonly archivedSessionIds: readonly SessionId[];
} | {
    readonly type: 'host/session-status';
    readonly sessionId: SessionId;
    readonly running: boolean;
} | {
    readonly type: 'host/agent-error';
    readonly sessionId: SessionId;
    readonly message: string;
} | {
    readonly type: 'host/workspace-changed';
    readonly workspace: WorkspaceRemoteView;
} | {
    readonly type: 'host/workspace-removed';
    readonly workspaceId: WorkspaceId;
} | {
    readonly type: 'host/workspace-order-changed';
    readonly workspaceIds: readonly WorkspaceId[];
} | {
    readonly type: 'host/archived-sessions-changed';
    readonly archivedSessionIds: readonly SessionId[];
} | {
    readonly type: 'host/remote-event';
    readonly event: string;
    readonly args: JsonValue[];
};
/** One explicit snapshot boundary for a reconnectable event generation. */
export interface NativeStreamBaselineFrame<Channel extends ConnectionEventChannel> {
    readonly [key: string]: unknown;
    readonly type: 'stream/baseline';
    readonly channel: Channel;
    readonly generation: string;
    readonly phase: 'begin' | 'complete';
    readonly sessionIds?: readonly SessionId[];
}
/** Maximum queued frames retained by one socket generation. */
export declare const NATIVE_EVENT_QUEUE_MAX_FRAMES = 4096;
/** Maximum encoded frame bytes retained by one socket generation. */
export declare const NATIVE_EVENT_QUEUE_MAX_BYTES: number;
/** Sole Host owner for Native event projection and answer correlation. */
export declare class NativeEventsService extends Service {
    static inject: string[];
    private readonly pendingQuestions;
    private readonly pendingApprovals;
    private readonly muxQueues;
    constructor(ctx: Context);
    /**
     * Test whether one Session still owns an answerable human interaction.
     * @param sessionId - Session identity whose pending questions and approvals are inspected.
     * @returns whether at least one answerable interaction remains pending.
     */
    hasPendingSession(sessionId: SessionId): boolean;
    private broadcast;
    private askQuestion;
    private claimQuestion;
    private registerApprovalAnswerer;
    private respond;
    private openMux;
    private openHost;
}
export default NativeEventsService;
//# sourceMappingURL=index.d.ts.map