/**
 * Deterministic source-summary fallback page.
 *
 * When the model omits the mandatory `wiki/sources/<slug>.md` page for a
 * source, the engine still writes a minimal `type: source` page with the
 * contract fields, so every ingested source has a summary page regardless
 * of model behavior.
 * @module @deepseek-ai/dsh-knowledge-wiki/fallback-summary
 */
/**
 * The wiki-relative path of the fallback summary page for an identity.
 * @param identity - source identity (path relative to raw/sources/).
 * @returns the wiki-relative page path.
 */
export declare function fallbackSummaryRelPath(identity: string): string;
/**
 * Build the fallback source-summary page content for a source identity.
 * @param identity - source identity (path relative to raw/sources/).
 * @param today - ISO date string (YYYY-MM-DD) for created/updated.
 * @returns the full Markdown page content.
 */
export declare function buildFallbackSourceSummaryPage(identity: string, today: string): string;
//# sourceMappingURL=fallback-summary.d.ts.map