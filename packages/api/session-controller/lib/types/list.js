/** Cached lifecycle summary only; canonical Host owns list/search and projection registration. */
/**
 * Build a created-session lifecycle hint without reading or replaying its log.
 * @param ctx - Host context providing the live Agent registry and optional cached projections.
 * @param session - exact Session whose header, cursor, and cached metadata describe the hint.
 * @returns lifecycle summary; unavailable cached projections are logged and omitted.
 */
export function sessionSummaryFor(ctx, session) {
    let projections;
    try {
        const block = ctx.get('sessionProjections')?.cachedSnapshot(session);
        if (block !== undefined && Object.keys(block.values).length > 0) {
            projections = { asOfSeq: block.asOfSeq, values: block.values };
        }
    }
    catch (error) {
        ctx.logger.warn(`api-session: cached summary unavailable for "${session.id}": ${String(error)}`);
    }
    const metadata = projections?.values.sessionListMetadata;
    return {
        sessionId: session.id,
        updatedAt: Math.max(session.header.createdAt, metadata?.lastPromptAt ?? 0),
        running: ctx.agents.get(session.id)?.status === 'running',
        blank: metadata?.blank ?? session.seq === 0,
        ...(session.header.parentSession === undefined ? {} : { parentSessionId: session.header.parentSession }),
        ...(session.header.origin === undefined ? {} : { origin: session.header.origin }),
        ...(session.header.cwd === undefined ? {} : { cwd: session.header.cwd }),
        ...(projections === undefined ? {} : { projections }),
    };
}
//# sourceMappingURL=list.js.map