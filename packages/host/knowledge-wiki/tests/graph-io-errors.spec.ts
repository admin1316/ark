import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const faults = vi.hoisted(() => ({ deniedDirectory: '' }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    readdirSync: (...args: Parameters<typeof actual.readdirSync>): ReturnType<typeof actual.readdirSync> => {
      if (String(args[0]) === faults.deniedDirectory) throw new Error('directory denied')
      return actual.readdirSync(...args)
    },
  }
})

import { buildGraph, visitWikiTree } from '../src/graph.ts'

const roots: string[] = []

afterEach(() => {
  faults.deniedDirectory = ''
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('Wiki graph fail-loud I/O', () => {
  it('does not misreport an unreadable directory as an empty graph', () => {
    const root = mkdtempSync(join(tmpdir(), 'wiki-graph-denied-'))
    roots.push(root)
    faults.deniedDirectory = root
    expect(() => { visitWikiTree(root, {}) }).toThrow('directory denied')
    expect(() => buildGraph(root)).toThrow('directory denied')
  })

  it('does not silently omit a nested directory read failure', () => {
    const root = mkdtempSync(join(tmpdir(), 'wiki-graph-nested-'))
    roots.push(root)
    const nested = join(root, 'concepts')
    mkdirSync(nested)
    writeFileSync(join(root, 'root.md'), '# Root')
    writeFileSync(join(nested, 'nested.md'), '# Nested')
    faults.deniedDirectory = nested
    expect(() => buildGraph(root)).toThrow('directory denied')
  })
})
