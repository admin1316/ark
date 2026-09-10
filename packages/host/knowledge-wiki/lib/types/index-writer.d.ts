/**
 * Deterministic wiki index (`wiki/index.md`) updates.
 *
 * The index carries a `## Recently Updated` section whose entries are
 * `- [[<wiki-relative-path without .md>]] — <title>` lines. Newly written
 * pages are inserted at the top of that section, existing targets are never
 * duplicated, and the section is capped at 200 entries. The section is
 * matched by title line and re-anchored when missing, so repeated ingests
 * converge to the same content.
 * @module @deepseek-ai/dsh-knowledge-wiki/index-writer
 */
/**
 * Insert index entries for the given wiki-relative page paths (e.g.
 * `sources/12-…--1js7z6u.md`) at the top of the `## Recently Updated`
 * section. Existing targets (by path without extension) are kept in place;
 * new entries take their display title from the page's frontmatter `title`
 * field, falling back to the file name. When the section is missing it is
 * appended at the end of the file.
 * @param indexPath - absolute path of the index file.
 * @param wikiRelativePaths - wiki-root-relative page paths to index.
 * @returns whether the file was modified.
 */
export declare function updateWikiIndexDeterministically(indexPath: string, wikiRelativePaths: string[]): boolean;
//# sourceMappingURL=index-writer.d.ts.map