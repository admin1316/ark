/**
 * HTML → Markdown-ish plain text conversion for the URL ingest path.
 * Deliberately crude: strip scripts/styles/nav clutter, keep headings,
 * links, and paragraph text. The two-stage LLM pipeline tolerates imperfect
 * input; this only needs to preserve the readable body.
 */
/** Extract the page title if present. */
function extractTitle(html, fallbackUrl) {
    const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (match?.[1])
        return match[1].trim().slice(0, 200);
    try {
        return new URL(fallbackUrl).hostname;
    }
    catch {
        return fallbackUrl;
    }
}
/** Strip one HTML tag from the body. */
function stripTag(html, tag) {
    return html.replace(new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), ' ');
}
/**
 * Convert HTML body text into rough Markdown.
 * @param html - The html input.
 * @param sourceUrl - The source url input.
 * @returns The value produced by html to markdown.
 */
export function htmlToMarkdown(html, sourceUrl) {
    const title = extractTitle(html, sourceUrl);
    let body = html;
    for (const tag of ['script', 'style', 'noscript', 'svg', 'nav', 'footer', 'header', 'aside']) {
        body = stripTag(body, tag);
    }
    body = body
        // Headings
        .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (_m, text) => `\n# ${text.trim()}\n`)
        .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_m, text) => `\n## ${text.trim()}\n`)
        .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (_m, text) => `\n### ${text.trim()}\n`)
        // Paragraphs and line breaks
        .replace(/<p[^>]*>/gi, '\n')
        .replace(/<\/p>/gi, '\n')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(div|section|article|li|tr|blockquote)>/gi, '\n')
        // Links keep their text
        .replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, text) => {
        const label = text.trim();
        if (label === '')
            return '';
        return href.startsWith('http') ? `[${label}](${href})` : label;
    })
        // Everything else: drop tags, keep text
        .replace(/<[^>]+>/g, ' ')
        // Entities
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'");
    // Collapse runs of blank lines
    const cleaned = body
        .split('\n')
        .map(line => line.replace(/[ \t]+/g, ' ').trim())
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    return [
        '---',
        'type: source',
        `title: ${title}`,
        'tags: [web-clip]',
        'related: []',
        'created: ' + new Date().toISOString().slice(0, 10),
        'updated: ' + new Date().toISOString().slice(0, 10),
        `sources: ["${sourceUrl}"]`,
        '---',
        '',
        `# ${title}`,
        '',
        `> 来源：${sourceUrl}`,
        '',
        cleaned,
        '',
    ].join('\n');
}
//# sourceMappingURL=html-clip.js.map