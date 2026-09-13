/** Cached lifecycle summary only; canonical Host owns list/search and projection registration. */
import type { Context } from '@deepseek-ai/cordis';
import type { Session } from '@deepseek-ai/dsh-session';
import type { SessionSummary } from './types.ts';
/**
 * Build a created-session lifecycle hint without reading or replaying its log.
 * @param ctx - Host context providing the live Agent registry and optional cached projections.
 * @param session - exact Session whose header, cursor, and cached metadata describe the hint.
 * @returns lifecycle summary; unavailable cached projections are logged and omitted.
 */
export declare function sessionSummaryFor(ctx: Context, session: Session): SessionSummary;
//# sourceMappingURL=list.d.ts.map