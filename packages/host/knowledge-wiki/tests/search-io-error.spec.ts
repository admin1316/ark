import { describe, expect, it, vi } from 'vitest'

vi.mock('../src/filesystem.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/filesystem.ts')>()
  return {
    ...actual,
    readRegularFileBounded: () => { throw new Error('page disappeared') },
  }
})
vi.mock('../src/graph.ts', () => ({
  visitWikiTree: (_root: string, visitor: { onMarkdown?: (entry: object) => void }) => {
    visitor.onMarkdown?.({ name: 'bad.md', path: 'bad.md', fullPath: '/wiki/bad.md', size: 1 })
  },
}))

import { hybridSearch } from '../src/search.ts'

describe('search page read boundary', () => {
  it('reports a disappearing page instead of presenting no matches', async () => {
    await expect(hybridSearch('/wiki', 'alpha', '', 5)).rejects.toThrow('page disappeared')
  })
})
