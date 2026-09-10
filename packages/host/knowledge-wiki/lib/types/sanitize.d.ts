/**
 * Write-time cleanup of LLM-generated wiki page content.
 *
 * Recurring model output shapes — an outer code fence wrapping the whole
 * document, a stray `frontmatter:` key prefix, a missing opening frontmatter
 * fence, and wikilink lists (`[[a]], [[b]]`) inside frontmatter array
 * fields — are rewritten to the standard `---\n…\n---\n` form. Every
 * pattern is anchored at the document start or inside the frontmatter
 * block so legitimate body content is never touched. Dates in generated
 * frontmatter and log entries are stamped to the ingest day.
 * @module @deepseek-ai/dsh-knowledge-wiki/sanitize
 */
/**
 * Normalize one generated file body into the standard frontmatter form.
 * @param content - the model-generated page content.
 * @returns the cleaned content.
 */
export declare function sanitizeIngestedFileContent(content: string): string;
/**
 * Force `created`/`updated` in the frontmatter block to the given day.
 * Leaves a page without frontmatter untouched.
 * @param content - page content.
 * @param today - ISO date string (YYYY-MM-DD).
 * @returns the stamped content.
 */
export declare function stampGeneratedFrontmatterDates(content: string, today: string): string;
/**
 * Force the date inside a generated `## [YYYY-MM-DD] ingest | …` log entry
 * to the given day; a log entry without a date gets one prepended.
 * @param entry - the log entry text.
 * @param today - ISO date string (YYYY-MM-DD).
 * @returns the stamped entry.
 */
export declare function stampGeneratedLogDate(entry: string, today: string): string;
//# sourceMappingURL=sanitize.d.ts.map