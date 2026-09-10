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
import { basename, normalize } from 'node:path';
const RAW_SOURCES_PREFIX = 'raw/sources/';
const RAW_SOURCES_MARKER = '/raw/sources/';
const MAX_SOURCE_SUMMARY_SLUG_LENGTH = 120;
const FALLBACK_SOURCE_PART = 'source';
/**
 * Derive a source identity from a project-absolute or project-relative
 * source path: the path after the first `raw/sources/` segment, or the
 * bare file name when no such segment exists.
 * @param projectPath - absolute project root.
 * @param sourcePath - absolute or project-relative path of the source file.
 * @returns the identity (project-relative raw/sources path or file name).
 */
export function sourceIdentityForPath(projectPath, sourcePath) {
    const root = normalize(projectPath).replace(/\/+$/u, '');
    const path = normalize(sourcePath);
    const rooted = `${root}/${RAW_SOURCES_PREFIX}`;
    if (path.toLowerCase().startsWith(rooted.toLowerCase())) {
        return path.slice(rooted.length);
    }
    if (path.toLowerCase().startsWith(RAW_SOURCES_PREFIX.toLowerCase())) {
        return path.slice(RAW_SOURCES_PREFIX.length);
    }
    const markerIndex = path.toLowerCase().indexOf(RAW_SOURCES_MARKER.toLowerCase());
    if (markerIndex >= 0) {
        return path.slice(markerIndex + RAW_SOURCES_MARKER.length);
    }
    return basename(path);
}
/**
 * The wiki-relative summary-page slug for a source identity. Multi-segment
 * identities produce `{length}-{readable}--…--{hash}` segments joined by
 * `--` and capped at 120 characters; single-segment identities return the
 * bare readable part without a hash.
 * @param sourceIdentity - source identity (see {@link sourceIdentityForPath}).
 * @returns the summary page slug without the `.md` extension.
 */
export function sourceSummarySlugFromIdentity(sourceIdentity) {
    const withoutExt = sourceIdentity.replace(/\.[^/.]+$/u, '');
    const parts = withoutExt
        .split('/')
        .map(part => part.trim())
        .filter(Boolean);
    if (parts.length <= 1) {
        return parts[0] || FALLBACK_SOURCE_PART;
    }
    const hash = fnv32Base36(sourceIdentity);
    const segments = parts
        .map((part) => {
        const { readable, structuralLength } = readableSlugPart(part);
        return `${structuralLength}-${readable}`;
    })
        .join('--');
    const fullSlug = `${segments}--${hash}`;
    if (fullSlug.length <= MAX_SOURCE_SUMMARY_SLUG_LENGTH) {
        return fullSlug;
    }
    const readableLimit = MAX_SOURCE_SUMMARY_SLUG_LENGTH - hash.length - 2;
    const readablePrefix = segments.slice(0, readableLimit).replace(/-+$/u, '');
    return `${readablePrefix}--${hash}`;
}
/**
 * The summary-page file name (slug + `.md`) for a source identity.
 * @param sourceIdentity - source identity (see {@link sourceIdentityForPath}).
 * @returns the file name.
 */
export function sourceSummaryFileNameFromIdentity(sourceIdentity) {
    return `${sourceSummarySlugFromIdentity(sourceIdentity)}.md`;
}
/** One slug segment: the NFKC-clean readable form plus its structural length. */
function readableSlugPart(part) {
    const structural = part
        .normalize('NFKC')
        .trim()
        .replace(/\s+/gu, '-')
        .replace(/[^\p{L}\p{N}-]/gu, '')
        .replace(/^-|-$/gu, '')
        .toLowerCase();
    const readable = structural.replace(/-+/gu, '-') || FALLBACK_SOURCE_PART;
    return {
        readable,
        structuralLength: Math.max(1, Array.from(structural || FALLBACK_SOURCE_PART).length),
    };
}
/** FNV-1a 32-bit hash as a base-36 string (stable across runs and platforms). */
function fnv32Base36(value) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < value.length; i += 1) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(36);
}
//# sourceMappingURL=source-slug.js.map