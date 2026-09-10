/**
 * Deterministic source-summary fallback page.
 *
 * When the model omits the mandatory `wiki/sources/<slug>.md` page for a
 * source, the engine still writes a minimal `type: source` page with the
 * contract fields, so every ingested source has a summary page regardless
 * of model behavior.
 * @module @deepseek-ai/dsh-knowledge-wiki/fallback-summary
 */

import { basename } from 'node:path'
import { sourceSummaryFileNameFromIdentity, sourceSummarySlugFromIdentity } from './source-slug.ts'

/**
 * The wiki-relative path of the fallback summary page for an identity.
 * @param identity - source identity (path relative to raw/sources/).
 * @returns the wiki-relative page path.
 */
export function fallbackSummaryRelPath(identity: string): string {
  return `wiki/sources/${sourceSummaryFileNameFromIdentity(identity)}`
}

/**
 * Build the fallback source-summary page content for a source identity.
 * @param identity - source identity (path relative to raw/sources/).
 * @param today - ISO date string (YYYY-MM-DD) for created/updated.
 * @returns the full Markdown page content.
 */
export function buildFallbackSourceSummaryPage(identity: string, today: string): string {
  const title = titleFromIdentity(identity)
  const frontmatter = [
    '---',
    'type: source',
    `title: ${title}`,
    'tags: []',
    'related: []',
    `created: ${today}`,
    `updated: ${today}`,
    `sources: ["${identity}"]`,
    '---',
    '',
  ].join('\n')
  return [
    frontmatter,
    `# ${title}`,
    '',
    '> 本页由摄取引擎自动生成（模型未输出 source 汇总页）。',
    '',
    `源文件：\`${identity}\``,
    '',
  ].join('\n')
}

/** Display title: the slug's readable part or the identity's base name. */
function titleFromIdentity(identity: string): string {
  const base = basename(identity)
  return base.replace(/\.[^.]+$/u, '') || sourceSummarySlugFromIdentity(identity)
}
