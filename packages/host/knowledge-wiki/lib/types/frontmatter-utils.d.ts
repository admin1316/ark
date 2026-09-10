/**
 * Frontmatter array parsing/writing and `sources`-field canonicalization.
 *
 * Wiki pages carry frontmatter arrays in two shapes: JSON-style quoted
 * inline lists (`sources: ["a", "b"]`) and unquoted bare lists
 * (`related: [a, b]`). The `sources` field is written back in the quoted
 * inline form, matching the existing pages, after normalization and
 * mandatory inclusion of the ingesting source's identity.
 * @module @deepseek-ai/dsh-knowledge-wiki/frontmatter-utils
 */
/** One validated leading frontmatter block with exact source slices. */
export interface FrontmatterBlock {
    readonly prefix: string;
    readonly body: string;
    readonly suffix: string;
    readonly rest: string;
    readonly lineBreak: '\n' | '\r\n';
}
/** One validated `key: value` frontmatter line. */
export interface FrontmatterField {
    readonly indentation: string;
    readonly key: string;
    readonly beforeColon: string;
    readonly afterColon: string;
    readonly value: string;
}
/**
 * Parse one leading frontmatter block without optional regex captures.
 * @param content - complete page content.
 * @returns exact block slices, or null when no complete leading block exists.
 */
export declare function parseFrontmatterBlock(content: string): FrontmatterBlock | null;
/**
 * Parse one frontmatter field line without optional regex captures.
 * @param line - one frontmatter line.
 * @returns validated key/value and spacing slices, or null for non-fields.
 */
export declare function parseFrontmatterField(line: string): FrontmatterField | null;
/**
 * Render a parsed field with one canonical space after its colon.
 * @param field - parsed key and preserved indentation/colon prefix.
 * @param value - replacement field value.
 * @returns the canonicalized frontmatter line.
 */
export declare function renderCanonicalFrontmatterField(field: FrontmatterField, value: string): string;
/**
 * Render a parsed field while preserving its original colon spacing.
 * @param field - parsed key and original indentation/colon spacing.
 * @param value - replacement field value.
 * @returns the spacing-preserving frontmatter line.
 */
export declare function renderPreservedFrontmatterField(field: FrontmatterField, value: string): string;
/**
 * Parse the value of a frontmatter array field into its string items.
 * Handles quoted strings containing commas and bare unquoted items;
 * tolerates a YAML block-list shape (`- item` lines) as well.
 * @param value - the raw field value text (between `[` and `]`, or block items).
 * @returns the extracted items, unquoted and trimmed.
 */
export declare function parseFrontmatterArray(value: string): string[];
/**
 * Format items as a quoted inline JSON array (`["a", "b"]`).
 * @param items - the items to write.
 * @returns the formatted array text.
 */
export declare function formatFrontmatterArray(items: string[]): string;
/**
 * Canonicalize a `sources` field value: parse, drop invalid references
 * (empty, wikilink-shaped, or path-traversing), normalize each item to
 * the identity form (stripping a `raw/sources/` prefix), force-include
 * the current source identity, dedupe while preserving order, and
 * re-serialize in the quoted inline form.
 * @param rawValue - the raw field value from generated content.
 * @param currentIdentity - the ingesting source's identity to force in.
 * @returns the canonical serialized array text.
 */
export declare function canonicalizeSourcesField(rawValue: string, currentIdentity: string): string;
/**
 * Rewrite the `sources` field of a page's frontmatter block to its
 * canonical form (see {@link canonicalizeSourcesField}). A page without a
 * frontmatter block, or without a `sources` line, is returned unchanged.
 * @param content - page content.
 * @param currentIdentity - the ingesting source identity.
 * @returns the content with a canonicalized sources field.
 */
export declare function stampSourcesField(content: string, currentIdentity: string): string;
//# sourceMappingURL=frontmatter-utils.d.ts.map