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

const RAW_SOURCES_PREFIX = 'raw/sources/'

/** One validated leading frontmatter block with exact source slices. */
export interface FrontmatterBlock {
  readonly prefix: string
  readonly body: string
  readonly suffix: string
  readonly rest: string
  readonly lineBreak: '\n' | '\r\n'
}

/** One validated `key: value` frontmatter line. */
export interface FrontmatterField {
  readonly indentation: string
  readonly key: string
  readonly beforeColon: string
  readonly afterColon: string
  readonly value: string
}

/**
 * Parse one leading frontmatter block without optional regex captures.
 * @param content - complete page content.
 * @returns exact block slices, or null when no complete leading block exists.
 */
export function parseFrontmatterBlock(content: string): FrontmatterBlock | null {
  const openerEnd = content.indexOf('\n')
  if (openerEnd < 0) return null
  const openerLine = content.slice(0, openerEnd).replace(/\r$/u, '')
  if (!/^---[ \t]*$/u.test(openerLine)) return null
  const lineBreak = content.charAt(openerEnd - 1) === '\r' ? '\r\n' : '\n'
  const bodyStart = openerEnd + 1
  let lineStart = bodyStart
  while (lineStart < content.length) {
    const lineFeed = content.indexOf('\n', lineStart)
    const lineEnd = lineFeed < 0 ? content.length : lineFeed
    const rawLine = content.slice(lineStart, lineEnd)
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (/^---[ \t]*$/u.test(line)) {
      const bodyEnd = Math.max(bodyStart, lineStart - lineBreak.length)
      const closingEnd = lineFeed < 0 ? lineEnd : lineFeed + 1
      return {
        prefix: content.slice(0, bodyStart),
        body: content.slice(bodyStart, bodyEnd),
        suffix: content.slice(bodyEnd, closingEnd),
        rest: content.slice(closingEnd),
        lineBreak,
      }
    }
    if (lineFeed < 0) break
    lineStart = lineFeed + 1
  }
  return null
}

/**
 * Parse one frontmatter field line without optional regex captures.
 * @param line - one frontmatter line.
 * @returns validated key/value and spacing slices, or null for non-fields.
 */
export function parseFrontmatterField(line: string): FrontmatterField | null {
  const colon = line.indexOf(':')
  if (colon <= 0) return null
  const before = line.slice(0, colon)
  const key = before.trim()
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/u.test(key)) return null
  const keyStart = before.indexOf(key)
  const rawValue = line.slice(colon + 1)
  const valueStart = rawValue.length - rawValue.trimStart().length
  return {
    indentation: before.slice(0, keyStart),
    key,
    beforeColon: before.slice(keyStart + key.length),
    afterColon: rawValue.slice(0, valueStart),
    value: rawValue.slice(valueStart),
  }
}

/**
 * Render a parsed field with one canonical space after its colon.
 * @param field - parsed key and preserved indentation/colon prefix.
 * @param value - replacement field value.
 * @returns the canonicalized frontmatter line.
 */
export function renderCanonicalFrontmatterField(field: FrontmatterField, value: string): string {
  return `${field.indentation}${field.key}${field.beforeColon}: ${value}`
}

/**
 * Render a parsed field while preserving its original colon spacing.
 * @param field - parsed key and original indentation/colon spacing.
 * @param value - replacement field value.
 * @returns the spacing-preserving frontmatter line.
 */
export function renderPreservedFrontmatterField(field: FrontmatterField, value: string): string {
  return `${field.indentation}${field.key}${field.beforeColon}:${field.afterColon}${value}`
}

/**
 * Parse the value of a frontmatter array field into its string items.
 * Handles quoted strings containing commas and bare unquoted items;
 * tolerates a YAML block-list shape (`- item` lines) as well.
 * @param value - the raw field value text (between `[` and `]`, or block items).
 * @returns the extracted items, unquoted and trimmed.
 */
export function parseFrontmatterArray(value: string): string[] {
  const trimmed = value.trim()
  if (trimmed === '' || trimmed === '[]') return []
  if (trimmed.startsWith('[')) {
    const closeIndex = trimmed.lastIndexOf(']')
    const body = closeIndex === -1 ? trimmed.slice(1) : trimmed.slice(1, closeIndex)
    return splitQuoted(body)
  }
  // Block list shape: `- item` lines (also used by llm_wiki-era pages).
  return trimmed
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.startsWith('-'))
    .map(line => line.slice(1).trim().replace(/^["']|["']$/gu, ''))
    .filter(Boolean)
}

/**
 * Split a comma-separated array body on commas that are not inside
 * double-quoted strings, then unquote and trim each item.
 * @param body - the text between the outer brackets.
 * @returns the items.
 */
function splitQuoted(body: string): string[] {
  const items: string[] = []
  let current = ''
  let inQuote = false
  for (const ch of body) {
    if (ch === '"') {
      inQuote = !inQuote
      current += ch
      continue
    }
    if (ch === ',' && !inQuote) {
      items.push(current.trim())
      current = ''
      continue
    }
    current += ch
  }
  if (current.trim() !== '') items.push(current.trim())
  return items.map(unquote).filter(item => item !== '')
}

/** Strip one layer of double or single quotes around an item. */
function unquote(item: string): string {
  const s = item.trim()
  if (s.length >= 2) {
    const first = s[0]
    const last = s[s.length - 1]
    if (first === '"' && last === '"') return s.slice(1, -1)
    if (first === "'" && last === "'") return s.slice(1, -1)
  }
  return s
}

/**
 * Format items as a quoted inline JSON array (`["a", "b"]`).
 * @param items - the items to write.
 * @returns the formatted array text.
 */
export function formatFrontmatterArray(items: string[]): string {
  return `[${items.map(item => JSON.stringify(item)).join(', ')}]`
}

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
export function canonicalizeSourcesField(rawValue: string, currentIdentity: string): string {
  const items = [...new Set(
    parseFrontmatterArray(rawValue)
      .map(normalizeSourceReference)
      .filter(isValidSourceReference),
  )]
  const identity = normalizeSourceReference(currentIdentity)
  if (isValidSourceReference(identity) && !items.includes(identity)) items.push(identity)
  return formatFrontmatterArray(items)
}

/**
 * Rewrite the `sources` field of a page's frontmatter block to its
 * canonical form (see {@link canonicalizeSourcesField}). A page without a
 * frontmatter block, or without a `sources` line, is returned unchanged.
 * @param content - page content.
 * @param currentIdentity - the ingesting source identity.
 * @returns the content with a canonicalized sources field.
 */
export function stampSourcesField(content: string, currentIdentity: string): string {
  const block = parseFrontmatterBlock(content)
  if (block === null) return content
  const lines = block.body.split(/\r?\n/u)
  const stamped = lines
    .map((line) => {
      const field = parseFrontmatterField(line)
      if (field?.key !== 'sources') return line
      return renderCanonicalFrontmatterField(
        field,
        canonicalizeSourcesField(field.value, currentIdentity),
      )
    })
    .join(block.lineBreak)
  if (stamped === block.body) return content
  return block.prefix + stamped + block.suffix + block.rest
}

/** Strip a `raw/sources/` prefix (case-insensitive) and stray quoting. */
function normalizeSourceReference(reference: string): string {
  let ref = reference.trim()
  if (ref.toLowerCase().startsWith(RAW_SOURCES_PREFIX.toLowerCase())) {
    ref = ref.slice(RAW_SOURCES_PREFIX.length)
  }
  return ref
}

/** A source reference is usable when it names a real path: non-empty, no
 * wikilink shape, no traversal, no spaces-then-nothing oddity. */
function isValidSourceReference(reference: string): boolean {
  if (reference === '') return false
  if (reference.includes('[[') || reference.includes(']]')) return false
  if (reference.includes('..')) return false
  return !/^\s*$/.test(reference)
}
