import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hybridSearch } from '../src/search.ts'

const roots: string[] = []

function seedWiki(): string {
  const root = mkdtempSync(join(tmpdir(), 'wiki-search-fallback-'))
  roots.push(root)
  mkdirSync(join(root, 'concepts'), { recursive: true })
  writeFileSync(
    join(root, 'concepts', 'orbital-mechanics.md'),
    '---\ntype: concept\nstatus: canonical\ntitle: Orbital mechanics\n---\n\nOrbital mechanics describes bounded trajectories around a primary body.\n',
  )
  return root
}

afterEach(() => {
  vi.unstubAllGlobals()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('semantic search degradation', () => {
  it.each([
    ['a rejected credential', () => new Response('unauthorized', { status: 401 }), 'knowledge embedding request failed (401)'],
    ['an upstream fault', () => new Response('boom', { status: 500 }), 'knowledge embedding request failed (500)'],
  ] as const)('falls back to keyword results for %s', async (_label, respond, expected) => {
    vi.stubGlobal('fetch', vi.fn(async () => respond()))
    const diagnostics: string[] = []
    const hits = await hybridSearch(seedWiki(), 'orbital mechanics', 'rejected-key', 8, d => diagnostics.push(d.reason))
    expect(hits.map(hit => hit.path)).toContain('concepts/orbital-mechanics.md')
    expect(diagnostics).toEqual([expected])
  })

  it('falls back when the endpoint cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('connect ECONNREFUSED') }))
    const diagnostics: string[] = []
    const hits = await hybridSearch(seedWiki(), 'orbital mechanics', 'rejected-key', 8, d => diagnostics.push(d.reason))
    expect(hits.length).toBeGreaterThan(0)
    expect(diagnostics[0]).toContain('ECONNREFUSED')
  })

  it('reports a non-Error embedding rejection verbatim', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw 'embedding socket reset' }))
    const diagnostics: string[] = []
    const hits = await hybridSearch(seedWiki(), 'orbital mechanics', 'rejected-key', 8, d => diagnostics.push(d.reason))
    expect(diagnostics).toEqual(['embedding socket reset'])
    expect(hits.map(hit => hit.path)).toContain('concepts/orbital-mechanics.md')
  })

  it('falls back when the embedding response is malformed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ nope: true }), { status: 200, headers: { 'content-type': 'application/json' } })))
    const diagnostics: string[] = []
    const hits = await hybridSearch(seedWiki(), 'orbital mechanics', 'key', 8, d => diagnostics.push(d.reason))
    expect(hits.length).toBeGreaterThan(0)
    expect(diagnostics).toEqual(['knowledge embedding response is malformed'])
  })

  it('reports no diagnostic when the endpoint answers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [{ embedding: [1, 0] }, { embedding: [1, 0] }] }), { status: 200, headers: { 'content-type': 'application/json' } })))
    const diagnostics: string[] = []
    const hits = await hybridSearch(seedWiki(), 'orbital mechanics', 'key', 8, d => diagnostics.push(d.reason))
    expect(hits.length).toBeGreaterThan(0)
    expect(diagnostics).toEqual([])
  })
})
