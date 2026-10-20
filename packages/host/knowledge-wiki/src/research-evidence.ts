/** Search-owned URL identities and Markdown citation validation for research candidates. */
import { fromMarkdown } from 'mdast-util-from-markdown'
import type { Nodes } from 'mdast'
import { formatFrontmatterArray, parseFrontmatterBlock, parseFrontmatterField } from './frontmatter-utils.ts'

/**
 * Normalize a credential-free HTTP(S) URL without changing its path or query semantics.
 * @param value - Search-result or citation URL.
 * @returns Canonical absolute URL without a fragment, or null for an unsafe/non-absolute URL.
 */
export function normalizeResearchURL(value: string): string | null {
  let url: URL
  try { url = new URL(value) } catch { return null }
  if (!['https:', 'http:'].includes(url.protocol) || url.username !== '' || url.password !== '') return null
  url.hash = ''
  return url.href
}

/** A validated page is stamped by the Host; a rejected page must not be written. */
type ResearchPage = { content: string; sourceURLs: string[] } | { errorCode: 'invalid-output' | 'invalid-citations'; message: string }

/**
 * Validate Markdown links against actual search results and replace model-owned provenance.
 * @param content - One complete generated page including leading frontmatter.
 * @param allowed - Normalized URLs returned by this operation's searches.
 * @param fallbackTitle - Safe title when the model supplied none.
 * @param today - Host-owned ISO date.
 * @returns Candidate content with its actually cited URLs, or a page rejection.
 */
export function validateResearchPage(content: string, allowed: ReadonlySet<string>, fallbackTitle: string, today: string): ResearchPage {
  const frontmatter = parseFrontmatterBlock(content)
  if (frontmatter === null || frontmatter.rest.trim() === '') return { errorCode: 'invalid-output', message: 'research page needs complete frontmatter and a non-empty body' }
  const document = fromMarkdown(frontmatter.rest)
  const definitions = new Map<string, string>()
  const identifier = (value: string): string => value.toLowerCase().replace(/\s+/gu, ' ').trim()
  const visit = (node: Nodes, operation: (value: Nodes) => void): void => {
    const pending: Nodes[] = [node]
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
      operation(next)
      if ('children' in next) for (let index = next.children.length - 1; index >= 0; index--) {
        const child = next.children[index]
        if (child !== undefined) pending.push(child)
      }
    }
  }
  const invalid = new Set<string>()
  const known = (value: string): string | null => {
    const normalized = normalizeResearchURL(value)
    if (normalized === null || !allowed.has(normalized)) invalid.add(value)
    return normalized
  }
  visit(document, (node) => {
    if (node.type === 'definition') {
      const url = known(node.url)
      if (url !== null && !definitions.has(identifier(node.identifier))) definitions.set(identifier(node.identifier), url)
    }
  })
  const cited = new Set<string>()
  visit(document, (node) => {
    if (node.type === 'link') {
      const url = known(node.url)
      if (url !== null) cited.add(url)
    } else if (node.type === 'linkReference') {
      const url = definitions.get(identifier(node.identifier))
      if (url === undefined) invalid.add(node.identifier)
      else cited.add(url)
    } else if (node.type === 'html' || node.type === 'image' || node.type === 'imageReference') {
      // Research candidates carry text citations, never active markup or remote images.
      invalid.add(node.type)
    }
  })
  if (invalid.size > 0 || cited.size === 0) return { errorCode: 'invalid-citations', message: 'research page must cite actual search sources only, with at least one Markdown citation' }
  const title = frontmatter.body.split(/\r?\n/u).map(parseFrontmatterField).find(field => field?.key === 'title')?.value
    .replace(/^["']|["']$/gu, '').trim() || fallbackTitle
  const sourceURLs = [...cited]
  return {
    sourceURLs,
    content: [
      '---', 'type: research', 'status: candidate', 'origin: research', `title: ${JSON.stringify(title)}`,
      'tags: [deep-research]', 'related: []', `created: ${today}`, `updated: ${today}`,
      `sources: ${formatFrontmatterArray(sourceURLs)}`, '---', '', frontmatter.rest.trim(), '',
    ].join('\n'),
  }
}
