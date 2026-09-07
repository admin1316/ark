import { describe, expect, it, vi } from 'vitest'
import { htmlToMarkdown } from '../src/html-clip.ts'

describe('HTML clipping', () => {
  it('keeps readable structure and removes non-content tags', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-31T12:00:00Z'))
    const html = `
      <title>  Example &amp; Guide  </title>
      <script>secret()</script><style>.hidden{}</style><noscript>off</noscript>
      <svg><text>vector</text></svg><nav>menu</nav><footer>foot</footer>
      <header>head</header><aside>side</aside>
      <h1>Main</h1><h2>Section</h2><h3>Detail</h3>
      <p>Hello&nbsp; &amp; &lt;world&gt; &quot;quote&quot; &#39;x&#39;<br>next</p>
      <div><a href="https://example.com/a"> External </a></div>
      <section><a href="/local">Local</a></section>
      <article><a href="https://example.com/empty">   </a></article>
      <li>item</li><tr>row</tr><blockquote>quote</blockquote>
    `

    const page = htmlToMarkdown(html, 'https://example.com/source')

    expect(page).toContain('title: Example &amp; Guide')
    expect(page).toContain('created: 2026-08-31')
    expect(page).toContain('# Main')
    expect(page).toContain('## Section')
    expect(page).toContain('### Detail')
    expect(page).toContain('Hello & <world> "quote" \'x\'')
    expect(page).toContain('[External](https://example.com/a)')
    expect(page).toContain('Local')
    expect(page).not.toContain('secret')
    expect(page).not.toContain('vector')
    vi.useRealTimers()
  })

  it('uses the source hostname when the title is missing or empty', () => {
    expect(htmlToMarkdown('<p>body</p>', 'https://docs.example.test/path'))
      .toContain('title: docs.example.test')
    expect(htmlToMarkdown('<title></title><p>body</p>', 'not a url'))
      .toContain('title: not a url')
  })
})
