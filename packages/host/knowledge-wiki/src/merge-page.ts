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

import {
  canonicalizeSourcesField,
  parseFrontmatterArray,
  parseFrontmatterBlock,
  parseFrontmatterField,
  renderCanonicalFrontmatterField,
  renderPreservedFrontmatterField,
} from './frontmatter-utils.ts'

/**
 * Whether a page's `sources` field references only the given source
 * identity (so the page can be safely replaced on re-ingest).
 * @param existingContent - the existing page content.
 * @param identity - the ingesting source identity.
 * @returns true when every source reference equals the identity.
 */
export function isOwnedOnlyBySource(existingContent: string, identity: string): boolean {
  const sources = parseSourcesField(existingContent)
  if (sources.length === 0) return false
  return sources.every(ref => normalizeForComparison(ref) === normalizeForComparison(identity))
}

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
export function mergePageContent(
  existingContent: string,
  newContent: string,
  identity: string,
  today: string,
): string {
  if (isOwnedOnlyBySource(existingContent, identity)) return newContent
  const block = parseFrontmatterBlock(existingContent)
  if (block === null) return existingContent
  const existingSources = parseSourcesField(existingContent)
  if (existingSources.length === 0) return existingContent
  const union = [...existingSources]
  const existingIdentity = union.find(ref => normalizeForComparison(ref) === normalizeForComparison(identity))
  let serialized: string
  if (existingIdentity === undefined) {
    union.push(identity)
    serialized = canonicalizeSourcesField(JSON.stringify(union), identity)
  } else {
    serialized = canonicalizeSourcesField(JSON.stringify(union), existingIdentity)
  }
  const payloadLines = block.body.split(/\r?\n/u)
  const stamped = payloadLines
    .map((line) => {
      const field = parseFrontmatterField(line)
      if (field?.key === 'sources') return renderCanonicalFrontmatterField(field, serialized)
      if (field?.key === 'updated') return renderPreservedFrontmatterField(field, today)
      return line
    })
    .join(block.lineBreak)
  return block.prefix + stamped + block.suffix + block.rest
}

/** The parsed `sources` items of a page's frontmatter (empty when absent). */
function parseSourcesField(content: string): string[] {
  const block = parseFrontmatterBlock(content)
  if (block === null) return []
  for (const line of block.body.split(/\r?\n/u)) {
    const field = parseFrontmatterField(line)
    if (field?.key !== 'sources') continue
    const value = field.value.trim()
    if (value === '') continue
    return parseFrontmatterArray(value.startsWith('[') || value.startsWith('-') ? value : `[${value}]`)
  }
  return []
}

/** Comparison form of a source reference: identity-normalized, case-folded. */
function normalizeForComparison(reference: string): string {
  let ref = reference.trim()
  if (ref.toLowerCase().startsWith('raw/sources/')) {
    ref = ref.slice('raw/sources/'.length)
  }
  return ref.toLowerCase()
}
