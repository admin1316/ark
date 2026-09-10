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

import {
  parseFrontmatterBlock,
  parseFrontmatterField,
  renderCanonicalFrontmatterField,
  renderPreservedFrontmatterField,
} from './frontmatter-utils.ts'

const FRONTMATTER_FIELD_RE = /^(type|title|created|updated|tags|related|sources)\s*:/i

/**
 * Normalize one generated file body into the standard frontmatter form.
 * @param content - the model-generated page content.
 * @returns the cleaned content.
 */
export function sanitizeIngestedFileContent(content: string): string {
  let cleaned = content
  cleaned = stripOuterCodeFence(cleaned)
  cleaned = stripFrontmatterKeyPrefix(cleaned)
  cleaned = addMissingOpeningFrontmatterFence(cleaned)
  cleaned = repairWikilinkListsInFrontmatter(cleaned)
  return cleaned
}

/**
 * Remove a code fence wrapping the whole document, or wrapping exactly a
 * complete frontmatter block when the body continues unfenced after it.
 * Acts only when the first non-empty line is an opening fence.
 */
function stripOuterCodeFence(content: string): string {
  const open = content.match(/^(?:﻿)?(?:[ \t]*\r?\n)*[ \t]*```(?:yaml|md|markdown)?[ \t]*\r?\n/i)
  if (open === null) return content
  const afterOpen = content.slice(open[0].length)
  // The closing fence is matched from its own position (not from the newline
  // before it) so the body's final newline survives the strip.
  const close = afterOpen.match(/[ \t]*```[ \t]*\r?\n?\s*$/)
  if (close !== null) return afterOpen.slice(0, close.index)
  const frontmatterOnly = afterOpen.match(/^(---[ \t]*\r?\n[\s\S]*?^---[ \t]*\r?\n)[ \t]*```[ \t]*(?:\r?\n|$)/m)
  if (frontmatterOnly === null) return content
  const matched = frontmatterOnly[0]
  const fenceStart = matched.lastIndexOf('```')
  const frontmatter = matched.slice(0, fenceStart).replace(/[ \t]*$/u, '')
  return frontmatter + afterOpen.slice(matched.length)
}

/**
 * Remove a leading `frontmatter:` line that prefixes the real `---` block.
 * Only acts when the next non-empty line is the opening fence.
 */
function stripFrontmatterKeyPrefix(content: string): string {
  const match = content.match(/^[ \t]*frontmatter\s*:\s*\r?\n(?=[ \t]*---\s*\r?\n)/)
  if (match === null) return content
  return content.slice(match[0].length)
}

/**
 * Prepend the opening frontmatter fence when the model started inside the
 * YAML block: the first non-empty line is a known frontmatter field and a
 * closing `---` follows within a short span.
 */
function addMissingOpeningFrontmatterFence(content: string): string {
  if (/^[ \t]*---\s*(\r?\n|$)/.test(content)) return content
  const lines = content.split(/\r?\n/)
  const firstContent = lines.find(line => line.trim().length > 0)
  if (firstContent === undefined) return content
  const firstContentIdx = lines.indexOf(firstContent)
  const first = firstContent.trim()
  if (!FRONTMATTER_FIELD_RE.test(first)) return content
  const searchEnd = Math.min(lines.length, firstContentIdx + 30)
  for (const line of lines.slice(firstContentIdx + 1, searchEnd)) {
    const trimmed = line.trim()
    if (trimmed === '---') return `---\n${lines.slice(firstContentIdx).join('\n')}`
    if (/^#{1,6}\s+/.test(trimmed)) break
  }
  return content
}

/**
 * Rewrite `key: [[a]], [[b]]` lines inside the frontmatter block into a
 * valid quoted array (`key: ["[[a]]", "[[b]]"]`); body wikilinks are
 * left untouched.
 */
function repairWikilinkListsInFrontmatter(content: string): string {
  const block = parseFrontmatterBlock(content)
  if (block === null) return content
  const repaired = block.body
    .split(/\r?\n/)
    .map((line) => {
      const field = parseFrontmatterField(line)
      if (field === null || !/^\[\[[^\]]+\]\](?:\s*,\s*\[\[[^\]]+\]\])+$/u.test(field.value)) return line
      const items = field.value
        .split(',')
        .map(item => item.trim())
        .filter(Boolean)
        .map(item => `"${item}"`)
        .join(', ')
      return renderCanonicalFrontmatterField(field, `[${items}]`)
    })
    .join(block.lineBreak)
  return block.prefix + repaired + block.suffix + block.rest
}

/**
 * Force `created`/`updated` in the frontmatter block to the given day.
 * Leaves a page without frontmatter untouched.
 * @param content - page content.
 * @param today - ISO date string (YYYY-MM-DD).
 * @returns the stamped content.
 */
export function stampGeneratedFrontmatterDates(content: string, today: string): string {
  const block = parseFrontmatterBlock(content)
  if (block === null) return content
  const stamped = block.body
    .split(/\r?\n/)
    .map((line) => {
      const field = parseFrontmatterField(line)
      if (field === null || (field.key !== 'created' && field.key !== 'updated')) return line
      return renderPreservedFrontmatterField(field, today)
    })
    .join(block.lineBreak)
  return block.prefix + stamped + block.suffix + block.rest
}

/**
 * Force the date inside a generated `## [YYYY-MM-DD] ingest | …` log entry
 * to the given day; a log entry without a date gets one prepended.
 * @param entry - the log entry text.
 * @param today - ISO date string (YYYY-MM-DD).
 * @returns the stamped entry.
 */
export function stampGeneratedLogDate(entry: string, today: string): string {
  const datedPrefix = entry.match(/^##\s+\[[0-9-]+\]/u)
  if (datedPrefix !== null) {
    return `## [${today}]${entry.slice(datedPrefix[0].length)}`
  }
  const heading = entry.match(/^##\s+(.*)/u)
  if (heading !== null) {
    return `## [${today}] ${heading[1]}`
  }
  return `## [${today}] ingest\n\n${entry}`
}
