/**
 * Source-identity and summary-page slug derivation.
 *
 * The identity of a source file is its path relative to `raw/sources/`
 * (e.g. `ark-sessions/2026-08-15-foo.md`). The summary-page slug is a
 * deterministic, hash-anchored slug of that identity; both are data-format
 * contracts shared with the wiki's existing 79 sources/ pages, so new pages
 * must derive names by the same rules. Implemented independently for this
 * package; only the output format is aligned.
 * @module @deepseek-ai/dsh-knowledge-wiki/source-slug
 */
/**
 * Derive a source identity from a project-absolute or project-relative
 * source path: the path after the first `raw/sources/` segment, or the
 * bare file name when no such segment exists.
 * @param projectPath - absolute project root.
 * @param sourcePath - absolute or project-relative path of the source file.
 * @returns the identity (project-relative raw/sources path or file name).
 */
export declare function sourceIdentityForPath(projectPath: string, sourcePath: string): string;
/**
 * The wiki-relative summary-page slug for a source identity. Multi-segment
 * identities produce `{length}-{readable}--…--{hash}` segments joined by
 * `--` and capped at 120 characters; single-segment identities return the
 * bare readable part without a hash.
 * @param sourceIdentity - source identity (see {@link sourceIdentityForPath}).
 * @returns the summary page slug without the `.md` extension.
 */
export declare function sourceSummarySlugFromIdentity(sourceIdentity: string): string;
/**
 * The summary-page file name (slug + `.md`) for a source identity.
 * @param sourceIdentity - source identity (see {@link sourceIdentityForPath}).
 * @returns the file name.
 */
export declare function sourceSummaryFileNameFromIdentity(sourceIdentity: string): string;
//# sourceMappingURL=source-slug.d.ts.map