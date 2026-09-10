function pendingInboxMessages(events) {
    const inbox = { 'next-turn': [], 'next-step': [] };
    for (const event of events) {
        if (event.type !== 'agent/inbox/spliced')
            continue;
        inbox[event.data.target].splice(event.data.start, event.data.removedCount ?? 0, ...event.data.inserted);
    }
    return [...inbox['next-turn'], ...inbox['next-step']];
}
/**
 * Check visible history and the remaining durable inbox for a message identity.
 * @param events - non-inherited Session event suffix.
 * @param predicate - message identity check.
 * @returns whether a visible or still-pending message matches.
 */
export function messageAccepted(events, predicate) {
    return events.some(event => event.type === 'user/message' && predicate(event.data))
        || pendingInboxMessages(events).some(predicate);
}
//# sourceMappingURL=session-message.js.map