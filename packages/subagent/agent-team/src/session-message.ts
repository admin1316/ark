/** Durable message acceptance checks for provisioning and mailbox recovery. */
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

function pendingInboxMessages(events: readonly SessionEvent[]): UserMessage[] {
  const inbox: Record<'next-turn' | 'next-step', UserMessage[]> = { 'next-turn': [], 'next-step': [] }
  for (const event of events) {
    if (event.type !== 'agent/inbox/spliced') continue
    inbox[event.data.target].splice(event.data.start, event.data.removedCount ?? 0, ...event.data.inserted)
  }
  return [...inbox['next-turn'], ...inbox['next-step']]
}

/**
 * Check visible history and the remaining durable inbox for a message identity.
 * @param events - non-inherited Session event suffix.
 * @param predicate - message identity check.
 * @returns whether a visible or still-pending message matches.
 */
export function messageAccepted(events: readonly SessionEvent[], predicate: (message: UserMessage) => boolean): boolean {
  return events.some(event => event.type === 'user/message' && predicate(event.data))
    || pendingInboxMessages(events).some(predicate)
}
