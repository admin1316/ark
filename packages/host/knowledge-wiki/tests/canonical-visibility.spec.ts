import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildGraph, listPages } from '../src/graph.ts'
import { hybridSearch } from '../src/search.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('canonical classification visibility', () => {
  it('uses the same visible policy for promoted findings and research', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wiki-canonical-visibility-'))
    roots.push(root)
    for (const [directory, name, title] of [
      ['findings', 'bounded-queue.md', 'Bounded queue finding'],
      ['research', 'native-layout.md', 'Native layout research'],
    ] as const) {
      mkdirSync(join(root, directory), { recursive: true })
      writeFileSync(join(root, directory, name), `---\ntype: ${directory.slice(0, -1)}\nstatus: canonical\ntitle: ${title}\n---\n\n${title} evidence body.\n`)
    }

    expect(listPages(root).filter(entry => !entry.isDir).map(entry => entry.path).sort()).toEqual([
      'findings/bounded-queue.md',
      'research/native-layout.md',
    ])
    expect(buildGraph(root).nodes.map(node => node.path).sort()).toEqual([
      'findings/bounded-queue.md',
      'research/native-layout.md',
    ])
    await expect(hybridSearch(root, 'bounded queue', '', 8)).resolves.toEqual([
      expect.objectContaining({ path: 'findings/bounded-queue.md' }),
    ])
  })
})
