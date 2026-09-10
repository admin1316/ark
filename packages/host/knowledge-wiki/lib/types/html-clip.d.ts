/**
 * HTML → Markdown-ish plain text conversion for the URL ingest path.
 * Deliberately crude: strip scripts/styles/nav clutter, keep headings,
 * links, and paragraph text. The two-stage LLM pipeline tolerates imperfect
 * input; this only needs to preserve the readable body.
 */
/**
 * Convert HTML body text into rough Markdown.
 * @param html - The html input.
 * @param sourceUrl - The source url input.
 * @returns The value produced by html to markdown.
 */
export declare function htmlToMarkdown(html: string, sourceUrl: string): string;
//# sourceMappingURL=html-clip.d.ts.map