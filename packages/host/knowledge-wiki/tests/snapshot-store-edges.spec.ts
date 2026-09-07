import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  close: vi.fn(),
  on: vi.fn(),
  watch: vi.fn(),
}))

vi.mock('node:fs', () => ({ watch: mocks.watch }))

import { WikiSnapshotStore } from '../src/snapshot-store.ts'

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

function installWatcher(): { changed(): void; failed(): void } {
  let changed = (): void => { throw new Error('missing watch callback') }
  let failed = (): void => { throw new Error('missing error callback') }
  mocks.watch.mockImplementation((_root, _options, callback: () => void) => {
    changed = callback
    return {
      close: mocks.close,
      on: vi.fn((event: string, callback: () => void) => {
        if (event === 'error') failed = callback
      }),
    }
  })
  return {
    changed: () => { changed() },
    failed: () => { failed() },
  }
}

describe('snapshot store edge behavior', () => {
  it('debounces watcher changes, invalidates once, and closes a pending timer', async () => {
    vi.useFakeTimers()
    const watcher = installWatcher()
    const store = new WikiSnapshotStore(10)
    await store.get('/project', 'graph', async () => 'value')
    watcher.changed()
    watcher.changed()
    vi.advanceTimersByTime(10)
    expect(store.currentGeneration('/project')).toBe(1)

    watcher.changed()
    store.dispose()
    expect(mocks.close).toHaveBeenCalledOnce()
    expect(store.currentGeneration('/project')).toBe(0)
  })

  it('drops a failed watcher and can install a replacement', async () => {
    vi.useFakeTimers()
    const watcher = installWatcher()
    const store = new WikiSnapshotStore(10)
    await store.get('/project', 'graph', async () => 'value')
    watcher.changed()
    watcher.failed()
    expect(mocks.close).toHaveBeenCalledOnce()

    await store.get('/project', 'graph-2', async () => 'next')
    expect(mocks.watch).toHaveBeenCalledTimes(2)
    watcher.failed()
    store.dispose()
  })

  it('continues without a watcher and evicts old and stale failures safely', async () => {
    mocks.watch.mockImplementation(() => { throw new Error('unsupported') })
    const store = new WikiSnapshotStore(1, 1)
    let reject = (_reason?: unknown): void => {}
    const failed = store.get('/project', 'failed', () => new Promise((_resolve, rejectPromise) => {
      reject = rejectPromise
    }))
    await Promise.resolve()
    await store.get('/project', 'replacement', async () => 'newer')
    reject(new Error('late failure'))
    await expect(failed).rejects.toThrow('late failure')
    await Promise.resolve()

    await store.get('/project', 'one', async () => 1)
    await store.get('/project', 'two', async () => 2)

    const negative = new WikiSnapshotStore(1, -1)
    await negative.get('/project', 'trim', async () => 'trimmed')
    negative.dispose()
    store.dispose()
  })
})
