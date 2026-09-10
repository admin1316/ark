import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildGraph,
  listPages,
  readPage,
  visitWikiTree,
} from '../src/graph.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'wiki-graph-edges-'))
  roots.push(root)
  return root
}

describe('Wiki tree and graph edge contracts', () => {
  it('rejects a non-directory root and propagates a non-missing root lookup failure', () => {
    const root = fixture()
    const file = join(root, 'ordinary-file')
    writeFileSync(file, 'keep')
    expect(() => { visitWikiTree(file, {}) }).toThrow('Wiki root is not an ordinary directory')
    expect(() => { visitWikiTree(join(file, 'child'), {}) }).toThrow('ENOTDIR')
    expect(readFileSync(file, 'utf8')).toBe('keep')
  })

  it('revalidates a directory changed to a file between discovery and descent', () => {
    const root = fixture()
    const nested = join(root, 'nested')
    mkdirSync(nested)
    expect(() => { visitWikiTree(root, {
      onDirectory() {
        renameSync(nested, join(root, 'preserved-directory'))
        writeFileSync(nested, 'replacement file')
      },
    }) }).toThrow('unsafe Wiki directory:')
    expect(readFileSync(nested, 'utf8')).toBe('replacement file')
  })

  it('rejects a directory inode moved into a later entry after its first visit', () => {
    const root = fixture()
    mkdirSync(join(root, 'a'))
    mkdirSync(join(root, 'b'))
    let first: string | undefined
    const visited: string[] = []
    expect(() => { visitWikiTree(root, {
      onDirectory(entry) {
        visited.push(entry.path)
        if (first === undefined) first = entry.path
        else renameSync(join(root, first), join(root, entry.path))
      },
    }) }).toThrow('revisited Wiki directory inode:')
    expect(visited).toHaveLength(2)
    expect(new Set(visited).size).toBe(2)
  })

  it('rejects a single-link page inode renamed to another queued file name', () => {
    const root = fixture()
    writeFileSync(join(root, 'a.md'), '# A')
    writeFileSync(join(root, 'b.md'), '# B')
    const visited: string[] = []
    expect(() => { visitWikiTree(root, {
      onMarkdown(entry) {
        visited.push(entry.path)
        const other = entry.path === 'a.md' ? 'b.md' : 'a.md'
        renameSync(entry.fullPath, join(root, other))
      },
    }) }).toThrow('revisited Wiki file inode:')
    expect(visited).toHaveLength(1)
    expect(readdirSync(root)).toHaveLength(1)
  })

  it('rejects an oversized page before delivering its contents to a visitor', () => {
    const root = fixture()
    writeFileSync(join(root, 'large.md'), Buffer.alloc(5 * 1024 * 1024 + 1, 120))
    const visited: string[] = []
    expect(() => { visitWikiTree(root, { onMarkdown: (entry) => { visited.push(entry.path) } }) })
      .toThrow('Wiki page exceeds 5 MiB: large.md')
    expect(visited).toEqual([])
  })

  it('returns an empty graph and tree for a missing root', () => {
    const missing = join(fixture(), 'missing')
    expect(buildGraph(missing)).toEqual({ nodes: [], edges: [], communities: [] })
    expect(listPages(missing)).toEqual([])
  })

  it('skips hidden/heavy trees, drops empty directories, and exposes readable pages', () => {
    const root = fixture()
    mkdirSync(join(root, '.hidden'), { recursive: true })
    mkdirSync(join(root, 'node_modules'), { recursive: true })
    mkdirSync(join(root, 'empty'), { recursive: true })
    mkdirSync(join(root, 'visible', 'nested'), { recursive: true })
    writeFileSync(join(root, '.hidden', 'secret.md'), '# Secret', 'utf8')
    writeFileSync(join(root, 'node_modules', 'dependency.md'), '# Dependency', 'utf8')
    writeFileSync(join(root, 'visible', 'ignore.txt'), 'not markdown', 'utf8')
    writeFileSync(join(root, 'visible', 'nested', 'page.md'), '# Page', 'utf8')

    const pages = listPages(root)
    expect(pages).toEqual([
      { name: 'visible', path: 'visible', isDir: true, size: null },
      { name: 'nested', path: 'visible/nested', isDir: true, size: null },
      expect.objectContaining({ name: 'page.md', path: 'visible/nested/page.md', isDir: false }),
    ])
    expect(readPage(root, '/visible/nested/page.md')).toBe('# Page')

    expect(() => { visitWikiTree(root, {}) }).not.toThrow()
  })

  it('parses frontmatter, aliases, related links, and first-match lookup semantics', () => {
    const root = fixture()
    mkdirSync(join(root, 'concepts', 'nested'), { recursive: true })
    writeFileSync(join(root, 'concepts', 'alpha.md'), `---
ignored line
type: concept
title: "Alpha"
related: ["Beta", "nested/Gamma.md", "", "Missing"]
---

[[Beta|label]] [[   ]] [[Alpha]] [[nested\\Gamma]]
`, 'utf8')
    writeFileSync(join(root, 'concepts', 'beta.md'), `---
type:
title:
related: []
---

# Beta body

[[concepts/alpha]]
`, 'utf8')
    writeFileSync(join(root, 'concepts', 'nested', 'Gamma.md'), `---
type: entity
title: Gamma
---

[[alpha.md]]
`, 'utf8')
    writeFileSync(join(root, 'concepts', 'nested', 'duplicate.md'), `---
type: entity
title: Alpha
---

No links.
`, 'utf8')
    writeFileSync(join(root, 'concepts', 'nested', 'alpha.md'), `---
type: concept
title: Nested Alpha
---

No links.
`, 'utf8')

    const graph = buildGraph(root)
    expect(graph.nodes).toHaveLength(5)
    expect(graph.nodes.find(node => node.id === 'concepts/alpha.md')).toMatchObject({
      label: 'Alpha', type: 'concept', path: 'concepts/alpha.md',
    })
    expect(graph.nodes.find(node => node.id === 'concepts/beta.md')).toMatchObject({
      label: 'beta', type: 'other',
    })
    expect(graph.edges.every(edge => edge.source !== edge.target)).toBe(true)
    expect(graph.edges.some(edge => edge.weight > 1)).toBe(true)
    expect(graph.communities.reduce((sum, community) => sum + community.nodeCount, 0)).toBe(5)
  })

  it('keeps isolated nodes in stable singleton communities', () => {
    const root = fixture()
    writeFileSync(join(root, 'a.md'), '# A', 'utf8')
    writeFileSync(join(root, 'b.md'), '# B', 'utf8')
    const graph = buildGraph(root)
    expect(graph.edges).toEqual([])
    expect(graph.nodes.map(node => node.community)).toEqual([0, 1])
  })

  it('drops a self-link at the graph edge owner before community detection', () => {
    const root = fixture()
    writeFileSync(join(root, 'self.md'), '---\ntitle: Self\n---\n\n[[Self]] [[unterminated', 'utf8')
    const graph = buildGraph(root)
    expect(graph.nodes).toHaveLength(1)
    expect(graph.edges).toEqual([])
    expect(graph.communities).toEqual([
      { id: 0, nodeCount: 1, cohesion: 0, topNodes: ['Self'] },
    ])
  })

  it('preserves the frozen R4 Louvain topology, community ids, and raw edge weights', () => {
    const root = fixture()
    mkdirSync(join(root, 'concepts'), { recursive: true })
    const pages = {
      'a.md': '# A\n\n[[b]] [[c]]',
      'b.md': '# B\n\n[[a]] [[c]]',
      'c.md': '# C\n\n[[a]] [[b]]',
      'd.md': '# D\n\n[[e]]',
      'e.md': '# E\n\n[[d]]',
      'f.md': '# F\n',
    }
    for (const [name, content] of Object.entries(pages)) writeFileSync(join(root, 'concepts', name), content, 'utf8')

    const graph = buildGraph(root)
    expect(graph.nodes.map(node => [node.id, node.linkCount, node.community])).toEqual([
      ['concepts/a.md', 2, 0],
      ['concepts/b.md', 2, 1],
      ['concepts/c.md', 2, 0],
      ['concepts/d.md', 1, 2],
      ['concepts/e.md', 1, 2],
      ['concepts/f.md', 0, 3],
    ])
    expect(graph.edges).toEqual([
      { source: 'concepts/a.md', target: 'concepts/b.md', weight: 2 },
      { source: 'concepts/a.md', target: 'concepts/c.md', weight: 2 },
      { source: 'concepts/b.md', target: 'concepts/c.md', weight: 2 },
      { source: 'concepts/d.md', target: 'concepts/e.md', weight: 2 },
    ])
    expect(graph.communities).toEqual([
      { id: 0, nodeCount: 2, cohesion: 0, topNodes: ['a', 'c'] },
      { id: 2, nodeCount: 2, cohesion: 0, topNodes: ['d', 'e'] },
      { id: 1, nodeCount: 1, cohesion: 0, topNodes: ['b'] },
      { id: 3, nodeCount: 1, cohesion: 0, topNodes: ['f'] },
    ])
    expect(buildGraph(root)).toEqual(graph)
  })

  it('keeps the sparse synthetic graph on the direct-reference owner shape', () => {
    const root = fixture()
    const nodeCount = 96
    mkdirSync(join(root, 'concepts'), { recursive: true })
    for (let index = 0; index < nodeCount; index += 1) {
      const next = (index + 1) % nodeCount
      writeFileSync(join(root, 'concepts', `node-${index}.md`), `# node-${index}\n\n[[node-${next}]]`, 'utf8')
    }

    const graph = buildGraph(root)
    expect(graph.nodes).toHaveLength(nodeCount)
    expect(graph.edges).toHaveLength(nodeCount)
    expect(graph.edges.every(edge => edge.weight === 1)).toBe(true)
    const source = readFileSync(new URL('../src/graph.ts', import.meta.url), 'utf8')
    expect(source).toContain('readonly source: GraphPageState')
    expect(source).toContain('readonly target: GraphPageState')
    expect(source).not.toContain('state.filter(')
    expect(source).not.toContain('states.find(')
    expect(source).not.toContain('pageRecords')
  })
})
