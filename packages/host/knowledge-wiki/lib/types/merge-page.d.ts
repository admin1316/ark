/**
 * Re-ingest merge semantics for existing wiki pages.
 *
 * When a source is ingested again, its pages may already exist. A page
 * whose `sources` field is owned only by the same source is replaced in
 * full; a page shared with other sources keeps its body and only the
 * `sources` field is unioned (conservative v1 — model-level body merging
 * is a known limitation). A page without frontmatter is left untouched.
 * @module @deepseek-ai/dsh-knowledge-wiki/merge-page
 */
/**
 * Whether a page's `sources` field references only the given source
 * identity (so the page can be safely replaced on re-ingest).
 * @param existingContent - the existing page content.
 * @param identity - the ingesting source identity.
 * @returns true when every source reference equals the identity.
 */
export declare function isOwnedOnlyBySource(existingContent: string, identity: string): boolean;
/**
 * Merge re-ingested content into an existing page. Owned-only pages are
 * replaced; shared pages keep their body with the sources union and a
 * refreshed `updated` date; frontmatter-less pages are returned unchanged.
 * @param existingContent - the existing page content.
 * @param newContent - the freshly generated content.
 * @param identity - the ingesting source identity.
 * @param today - ISO date string (YYYY-MM-DD) for the updated stamp.
 * @returns the merged content (or the existing content untouched).
 */
export declare function mergePageContent(existingContent: string, newContent: string, identity: string, today: string): string;
//# sourceMappingURL=merge-page.d.ts.map