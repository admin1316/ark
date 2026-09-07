import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StaleWikiSnapshotError, WikiSnapshotStore } from '../src/snapshot-store.ts'

const stores: WikiSnapshotStore[] = []
const roots: string[] = []

afterEach(() => {
  for (const store of stores.splice(0)) store.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'wiki-snapshot-'))
  mkdirSync(join(root, 'concepts'))
  roots.push(root)
  return root
}

describe('WikiSnapshotStore', () => {
  it('shares concurrent projection builds for one project', async () => {
    const root = fixture()
    const store = new WikiSnapshotStore()
    stores.push(store)
    const load = vi.fn(async () => ({ pages: 4 }))

    const first = store.get(root, 'graph', load)
    const second = store.get(root, 'graph', load)

    await expect(Promise.all([first, second])).resolves.toEqual([{ pages: 4 }, { pages: 4 }])
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('rebuilds projections after explicit write invalidation', async () => {
    const root = fixture()
    const store = new WikiSnapshotStore()
    stores.push(store)
    const load = vi.fn(async () => ({ generation: load.mock.calls.length }))

    await store.get(root, 'list', load)
    store.invalidate(root)
    await store.get(root, 'list', load)

    expect(load).toHaveBeenCalledTimes(2)
  })

  it('does not retain failed snapshot builds', async () => {
    const root = fixture()
    const store = new WikiSnapshotStore()
    stores.push(store)
    const load = vi.fn()
      .mockRejectedValueOnce(new Error('scan failed'))
      .mockResolvedValueOnce('recovered')

    await expect(store.get(root, 'graph', load)).rejects.toThrow('scan failed')
    await expect(store.get(root, 'graph', load)).resolves.toBe('recovered')
  })

  it('rejects an in-flight result after its root is invalidated', async () => {
    const root = fixture()
    const store = new WikiSnapshotStore()
    stores.push(store)
    let release: (value: string) => void = () => {}
    const stale = store.get(root, 'graph', () => new Promise<string>((resolve) => { release = resolve }))
    await Promise.resolve()

    store.invalidate(root)
    release('old graph')

    await expect(stale).rejects.toBeInstanceOf(StaleWikiSnapshotError)
    await expect(store.get(root, 'graph', async () => 'fresh graph')).resolves.toBe('fresh graph')
  })
})
