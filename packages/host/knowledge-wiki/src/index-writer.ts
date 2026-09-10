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

import { basename, join } from 'node:path'
import { parseFrontmatterField } from './frontmatter-utils.ts'
import { atomicWriteFile, isMissingPathError, readRegularFileBounded } from './filesystem.ts'

const RECENT_SECTION_RE = /^##\s+Recently\s+Updated[ \t]*$/m

const MAX_RECENT_ENTRIES = 200

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
export function updateWikiIndexDeterministically(indexPath: string, wikiRelativePaths: string[]): boolean {
  const lines = readIndexLines(indexPath)
  const sectionIndex = lines.findIndex(line => RECENT_SECTION_RE.test(line))
  if (sectionIndex === -1) {
    return appendNewSection(indexPath, lines, wikiRelativePaths)
  }
  const sectionEnd = findSectionEnd(lines, sectionIndex + 1)
  const existingTargets = new Set<string>()
  for (const line of lines.slice(sectionIndex + 1, sectionEnd)) {
    const target = indexEntryTarget(line)
    if (target !== null) existingTargets.add(target)
  }
  const newLines: string[] = []
  for (const path of wikiRelativePaths) {
    const target = path.replace(/\.md$/u, '')
    if (existingTargets.has(target)) continue
    existingTargets.add(target)
    newLines.push(`- [[${target}]] — ${pageTitle(indexPath, path)}`)
  }
  if (newLines.length === 0) return false
  // New entries land at the top of the existing entry list, after any blank
  // line that separates the heading from the list.
  let insertAt = sectionIndex + 1
  for (const line of lines.slice(insertAt, sectionEnd)) {
    if (line.trim() !== '') break
    insertAt += 1
  }
  const updated = [...lines.slice(0, insertAt), ...newLines, ...lines.slice(insertAt)]
  atomicWriteFile(indexPath, trimToRecentCap(updated, sectionIndex).join('\n') + '\n')
  return true
}

/** Read the index lines, seeding a skeleton when the file is missing. */
function readIndexLines(indexPath: string): string[] {
  try {
    const text = readRegularFileBounded(indexPath, 5 * 1024 * 1024).toString('utf8')
    return text.length === 0 ? ['# Wiki Index', ''] : text.split('\n')
  } catch (error) {
    if (!isMissingPathError(error)) throw error
    return ['# Wiki Index', '']
  }
}

/** The first heading after a line (or the end of file) bounds the section. */
function findSectionEnd(lines: string[], start: number): number {
  const offset = lines.slice(start).findIndex(line => /^#{1,6}\s+/.test(line))
  return offset < 0 ? lines.length : start + offset
}

/** Append a fresh `## Recently Updated` section with the new entries. */
function appendNewSection(indexPath: string, lines: string[], wikiRelativePaths: string[]): boolean {
  const entries = wikiRelativePaths.map((path) => {
    const target = path.replace(/\.md$/u, '')
    return `- [[${target}]] — ${pageTitle(indexPath, path)}`
  })
  const body = [...lines, '', '## Recently Updated', ...entries, ''].join('\n')
  atomicWriteFile(indexPath, body)
  return true
}

/** Keep at most 200 entry lines in the section, preserving newest-first order.
 * The heading line itself is never an index entry, so counting
 * from the heading index includes the very first entry. */
function trimToRecentCap(lines: string[], headingIndex: number): string[] {
  let entries = 0
  const kept: string[] = []
  for (const [index, line] of lines.entries()) {
    if (index > headingIndex && indexEntryTarget(line) !== null) {
      entries += 1
      if (entries > MAX_RECENT_ENTRIES) continue
    }
    kept.push(line)
  }
  return kept
}

/** The display title of a wiki-relative page: frontmatter `title` or file name. */
function pageTitle(indexPath: string, wikiRelativePath: string): string {
  const full = join(indexPath, '..', wikiRelativePath)
  try {
    const text = readRegularFileBounded(full, 5 * 1024 * 1024).toString('utf8')
    for (const line of text.split('\n')) {
      const field = parseFrontmatterField(line)
      if (field?.key === 'title' && field.value.trim() !== '') return field.value.trim()
    }
  } catch (error) {
    if (!isMissingPathError(error)) throw error
  }
  return basename(wikiRelativePath).replace(/\.md$/u, '')
}

/** Parse one `- [[target]]` entry without optional regex captures. */
function indexEntryTarget(line: string): string | null {
  if (!line.startsWith('- [[')) return null
  const end = line.indexOf(']]', 4)
  if (end < 0) return null
  return line.slice(4, end)
}
