import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildGraph } from '../src/graph.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function wiki() {
  const root = mkdtempSync(join(tmpdir(), 'wiki-graph-'))
  roots.push(root)
  mkdirSync(join(root, 'concepts', 'nested'), { recursive: true })
  writeFileSync(join(root, 'concepts', 'alpha.md'), '# Alpha\n\n[[Beta]] [[nested/gamma]]\n')
  writeFileSync(join(root, 'concepts', 'beta.md'), '# Beta\n\n[[alpha]]\n')
  writeFileSync(join(root, 'concepts', 'nested', 'gamma.md'), '# Gamma\n\n[[concepts/alpha.md]]\n')
  return root
}

describe('buildGraph target lookup', () => {
  it('preserves title, stem, suffix, and exact-path wikilink resolution', () => {
    const graph = buildGraph(wiki())
    expect(graph.nodes).toHaveLength(3)
    expect(graph.edges).toHaveLength(2)
    const endpoints = graph.edges.map(edge => [edge.source, edge.target].sort().join('|')).sort()
    expect(endpoints).toEqual([
      'concepts/alpha.md|concepts/beta.md',
      'concepts/alpha.md|concepts/nested/gamma.md',
    ].sort())
    const alphaGamma = graph.edges.find(edge => (
      edge.source === 'concepts/alpha.md' && edge.target === 'concepts/nested/gamma.md'
    ) || (
      edge.target === 'concepts/alpha.md' && edge.source === 'concepts/nested/gamma.md'
    ))
    expect(alphaGamma?.weight).toBe(2)
  })
})
