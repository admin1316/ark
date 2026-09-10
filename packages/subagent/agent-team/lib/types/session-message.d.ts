/** Durable message acceptance checks for provisioning and mailbox recovery. */
import type { UserMessage } from '@deepseek-ai/dsh-llm';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
/**
 * Check visible history and the remaining durable inbox for a message identity.
 * @param events - non-inherited Session event suffix.
 * @param predicate - message identity check.
 * @returns whether a visible or still-pending message matches.
 */
export declare function messageAccepted(events: readonly SessionEvent[], predicate: (message: UserMessage) => boolean): boolean;
//# sourceMappingURL=session-message.d.ts.map