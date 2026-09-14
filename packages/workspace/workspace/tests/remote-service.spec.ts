/**
 * Behavioral coverage for the Workspace Remote service surface. Every case
 * drives a real {@link WorkspaceRegistry} (real storage domain, real temp
 * directories, real SessionStore wherever residency matters) and asserts the
 * observable Remote payload or durable state. Only two boundaries are
 * test-owned because the states under test cannot be produced on demand from a
 * real peer: the session-persistence port (a reservation/live deletion block, a
 * stored header re-parented out of band) and the storage medium's write
 * primitives (a request aborted exactly inside a durable step).
 * @module
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import type { StorageBackend } from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { DomainChanged } from '@deepseek-ai/dsh-storage-domain'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionPersistenceDeleteBlockedError } from '@deepseek-ai/dsh-session-persistence'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import WorkspaceRegistry from '../src/index.ts'
import type { WorkspaceRecord, WorkspaceRemoteFailure, WorkspaceRemoteResult } from '../src/index.ts'

const header = (id: string, cwd?: string, createdAt = 0): SessionHeader => ({
  version: 0,
  id: SessionId(id),
  createdAt,
  ...(cwd === undefined ? {} : { cwd }),
})

/** The same identity, as a persisted descendant of `parentSession`. */
const childOf = (base: SessionHeader, parentSession: SessionId): SessionHeader => ({ ...base, parentSession })

interface HarnessOptions {
  pool?: MemoryMediaPool
  sessions?: SessionHeader[]
  backend?: StorageBackend
  sessionStore?: boolean
}

/** Boot the real storage/domain/registry composition over controllable header-only persistence. */
async function harness(options: HarnessOptions = {}) {
  const pool = options.pool ?? new MemoryMediaPool()
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', options.backend ?? new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)

  let listed = options.sessions ?? []
  const list = vi.fn(async () => listed)
  const load = vi.fn(() => { throw new Error('event bodies must not be loaded') })
  const inspect = vi.fn(() => { throw new Error('event bodies must not be inspected') })
  const deleteSession = vi.fn(async (id: SessionId) => {
    const found = listed.some(item => item.id === id)
    listed = listed.filter(item => item.id !== id)
    return found
  })
  ctx.provide('sessionPersistence', { list, load, inspect, delete: deleteSession } as never)

  if (options.sessionStore === true) await ctx.plugin(SessionStore)

  const changes: DomainChanged[] = []
  ctx.on('domain/changed', (change) => { changes.push(change) })
  const fiber = await ctx.plugin(WorkspaceRegistry)
  changes.length = 0
  return {
    ctx,
    fiber,
    pool,
    registry: ctx.workspaceRegistry,
    changes,
    list,
    load,
    inspect,
    deleteSession,
    setSessions: (headers: SessionHeader[]) => { listed = headers },
  }
}

/** Storage write primitive a scripted backend hook may target. */
type WriteKind = 'put' | 'delete' | 'global'

/**
 * Backend wrapper running `onWrite` immediately before a chosen primitive
 * reaches the medium, so a test can abort a request inside a real durable step
 * without replacing the registry or the domain.
 */
function scriptedBackend(pool: MemoryMediaPool, onWrite: (kind: WriteKind) => void): StorageBackend {
  const inner = new MemoryStorageBackend(pool)
  return {
    kv: {
      open: async (descriptor) => {
        const unit = await inner.kv.open(descriptor)
        return {
          loadAll: () => unit.loadAll(),
          putRecord: async (table, key, value) => { onWrite('put'); await unit.putRecord(table, key, value) },
          deleteRecord: async (table, key) => { onWrite('delete'); await unit.deleteRecord(table, key) },
          setGlobal: async (value) => { onWrite('global'); await unit.setGlobal(value) },
          close: () => unit.close(),
        }
      },
    },
    close: () => inner.close(),
  }
}

function storedRecord(pool: MemoryMediaPool, id: string): WorkspaceRecord {
  return pool.media.get('workspace')!.tables.get('workspaces')!.get(id) as WorkspaceRecord
}

/** Narrow a Remote result to its failure payload so code/message/details are assertable. */
function failureOf<Value>(result: WorkspaceRemoteResult<Value>): WorkspaceRemoteFailure['error'] {
  if (result.ok) throw new Error('expected a workspace Remote failure')
  return result.error
}

let base: string
const tempDirs: string[] = []

async function makeDir(name: string): Promise<string> {
  base ??= await realpath(await mkdtemp(join(tmpdir(), 'dsh-workspace-remote-')))
  if (tempDirs.length === 0) tempDirs.push(base)
  const dir = join(base, name)
  await mkdir(dir, { recursive: true })
  return dir
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
  base = undefined as never
})

describe('workspace Remote directory', () => {
  it('projects the durable order and archive overlay through remoteExportList', async () => {
    const listedDir = await makeDir('remote-list-listed')
    const emptyDir = await makeDir('remote-list-empty')
    const run = await harness({ sessions: [header('listed', listedDir, 1)] })
    // The persisted header bootstraps the owning workspace; the rename makes its title distinct.
    const first = run.registry.list()[0]!
    await run.registry.rename(first.id, 'Listed')
    const second = await run.registry.create(emptyDir)
    await run.registry.archiveSession(SessionId('listed'))

    expect(run.registry.remoteExportList(new AbortController().signal)).toEqual({
      ok: true,
      value: {
        items: [
          {
            workspaceId: second.id, path: emptyDir, title: 'remote-list-empty', sessionIds: [],
            createdAt: second.createdAt, updatedAt: second.updatedAt,
          },
          {
            workspaceId: first.id, path: listedDir, title: 'Listed', sessionIds: ['listed'],
            createdAt: first.createdAt, updatedAt: first.updatedAt,
          },
        ],
        archivedSessionIds: ['listed'],
      },
    })
  })
})

describe('workspace Remote create', () => {
  it('reports late cancellation for a create whose durable commit already landed', async () => {
    const dir = await makeDir('late-cancel-create')
    const pool = new MemoryMediaPool()
    const controller = new AbortController()
    let abortAt: WriteKind | undefined
    const run = await harness({
      pool,
      backend: scriptedBackend(pool, (kind) => {
        if (kind !== abortAt) return
        abortAt = undefined
        controller.abort()
      }),
    })

    abortAt = 'global'
    expect(failureOf(await run.registry.remoteExportCreate({ path: dir }, controller.signal)).code).toBe('cancelled')

    // The cancellation is a report, not a rollback: the record is durable and reusable.
    const created = run.registry.list()[0]!
    expect(created.path).toBe(dir)
    expect(storedRecord(pool, created.id)).toMatchObject({ path: dir, sessionIds: [] })
    await expect(run.registry.remoteExportCreate({ path: dir }, new AbortController().signal))
      .resolves.toMatchObject({ ok: true, value: { created: false, workspace: { workspaceId: created.id } } })
  })

  it('prefers the aborted request over a storage failure raised in the same step', async () => {
    const dir = await makeDir('aborted-create-failure')
    const pool = new MemoryMediaPool()
    const controller = new AbortController()
    let abortAt: WriteKind | undefined
    const run = await harness({
      pool,
      backend: scriptedBackend(pool, (kind) => {
        if (kind !== abortAt) return
        abortAt = undefined
        controller.abort()
      }),
    })

    abortAt = 'global'
    pool.failNextWrites = 1
    const result = await run.registry.remoteExportCreate({ path: dir }, controller.signal)
    expect(failureOf(result).code).toBe('cancelled')
    expect(run.registry.list()).toEqual([])
    expect(pool.media.get('workspace')!.tables.get('workspaces')?.size ?? 0).toBe(0)
  })
})

describe('workspace Remote archive restoration', () => {
  it('restores an archived session through the native API and reports unknown identities', async () => {
    const dir = await makeDir('remote-unarchive')
    const run = await harness({ sessions: [header('restored', dir, 1)] })
    const request = (id: string) => run.registry.remoteExportUnarchiveSession(
      { sessionId: SessionId(id) }, new AbortController().signal,
    )
    await run.registry.archiveSession(SessionId('restored'))

    await expect(request('restored')).resolves.toEqual({ ok: true, value: { archivedSessionIds: [] } })
    expect(run.registry.archivedSessionIds).toEqual([])

    // An identity outside the archive resolves without a persistence read or a write.
    const writes = run.changes.length
    const reads = run.list.mock.calls.length
    await expect(request('never-archived')).resolves.toEqual({ ok: true, value: { archivedSessionIds: [] } })
    expect(run.list).toHaveBeenCalledTimes(reads)
    expect(run.changes).toHaveLength(writes)

    // Archived, then gone from both live handlers and session persistence.
    await run.registry.archiveSession(SessionId('restored'))
    run.setSessions([])
    const missing = failureOf(await request('restored'))
    expect(missing.code).toBe('session-not-found')
    expect(missing.details).toEqual({ sessionId: 'restored' })
    expect(missing.message).toContain('hold no such session')
    expect(run.registry.archivedSessionIds).toEqual(['restored'])
  })
})

describe('workspace Remote permanent deletion', () => {
  it('retires an archived resident through the injected lifecycle owner', async () => {
    const dir = await makeDir('remote-retire')
    const run = await harness({ sessionStore: true })
    const resident = run.ctx.sessions.prepare(SessionId('resident'), { meta: { cwd: dir } })
    const detach = run.ctx.sessions.enter(resident)
    run.ctx.sessions.announce(resident)
    const request = new AbortController().signal
    const retired: SessionId[] = []
    run.ctx.provide('workspaceSessionRetirer', {
      retireArchivedSession: async (id: SessionId, signal: AbortSignal) => {
        expect(signal).toBe(request)
        retired.push(id)
        detach()
      },
    })
    await run.registry.archiveSession(resident.id)

    await expect(run.registry.remoteExportDeleteArchivedSession({ sessionId: resident.id }, request))
      .resolves.toEqual({ ok: true, value: { deleted: true, archivedSessionIds: [] } })
    expect(retired).toEqual([resident.id])
    expect(run.ctx.sessions.get(resident.id)).toBeUndefined()
    expect(run.deleteSession.mock.calls.map(([id]) => id)).toEqual([resident.id])
    expect(run.registry.archivedSessionIds).toEqual([])
  })

  it('blocks deletion when the retirement owner returns without releasing the resident', async () => {
    const dir = await makeDir('remote-retire-stuck')
    const run = await harness({ sessionStore: true })
    const resident = run.ctx.sessions.create(SessionId('stuck'), { meta: { cwd: dir } })
    run.ctx.provide('workspaceSessionRetirer', { retireArchivedSession: async () => {} })
    await run.registry.archiveSession(resident.id)

    const failure = failureOf(await run.registry.remoteExportDeleteArchivedSession(
      { sessionId: resident.id }, new AbortController().signal,
    ))
    expect(failure.code).toBe('session-delete-blocked')
    expect(failure.message).toBe("cannot permanently delete session 'stuck' while it is live or resident")
    expect(failure.details).toEqual({ sessionId: 'stuck', reason: 'resident' })
    expect(run.ctx.sessions.get(resident.id)).toBe(resident)
    expect(run.deleteSession).not.toHaveBeenCalled()
    expect(run.registry.archivedSessionIds).toEqual([resident.id])
  })

  it('maps a persistence live or reservation block onto the workspace deletion reasons', async () => {
    const cases = [
      ['live', 'resident', "cannot permanently delete session 'blocked' while it is live or resident"],
      ['reserved', 'reserved', "cannot permanently delete session 'blocked' while resume holds a reservation"],
    ] as const
    for (const [persistenceReason, expectedReason, expectedMessage] of cases) {
      const dir = await makeDir(`remote-delete-blocked-${persistenceReason}`)
      const run = await harness({ sessions: [header('blocked', dir, 1)] })
      const workspace = run.registry.list()[0]!
      await run.registry.archiveSession(SessionId('blocked'))
      const account = [...workspace.sessionIds]
      run.deleteSession.mockImplementationOnce(async () => {
        throw new SessionPersistenceDeleteBlockedError(SessionId('blocked'), persistenceReason)
      })

      const failure = failureOf(await run.registry.remoteExportDeleteArchivedSession(
        { sessionId: SessionId('blocked') }, new AbortController().signal,
      ))
      expect(failure.code).toBe('session-delete-blocked')
      expect(failure.message).toBe(expectedMessage)
      expect(failure.details).toEqual({ sessionId: 'blocked', reason: expectedReason })
      expect(run.registry.archivedSessionIds).toEqual(['blocked'])
      expect(workspace.sessionIds).toEqual(account)
      expect(storedRecord(run.pool, workspace.id).sessionIds).toEqual(account)
    }
  })
})

describe('workspace Remote rename', () => {
  it('returns the published workspace unchanged for a repeated visible title', async () => {
    const dir = await makeDir('remote-rename-noop')
    const run = await harness()
    const workspace = await run.registry.create(dir, 'Same')
    const writes = run.changes.length

    await expect(run.registry.rename(workspace.id, '  Same  ')).resolves.toBe(workspace)
    expect(run.changes).toHaveLength(writes)
    await expect(run.registry.remoteExportRename({ workspaceId: workspace.id, title: 'Same' }, new AbortController().signal))
      .resolves.toEqual({
        ok: true,
        value: {
          workspace: {
            workspaceId: workspace.id, path: dir, title: 'Same', sessionIds: [],
            createdAt: workspace.createdAt, updatedAt: workspace.updatedAt,
          },
        },
      })
    expect(run.changes).toHaveLength(writes)
    expect(storedRecord(run.pool, workspace.id).updatedAt).toBe(workspace.updatedAt)
  })
})

describe('workspace publication admission', () => {
  it('admits the captured revision and refuses archived or raced identities', async () => {
    const dir = await makeDir('admission')
    const run = await harness({ sessions: [header('admitted', dir, 1)] })
    const revision = run.registry.sessionAdmissionRevision(SessionId('admitted'))
    expect(() => { run.registry.assertSessionAdmission(SessionId('admitted'), revision) }).not.toThrow()
    expect(() => { run.registry.assertSessionAdmission(SessionId('admitted'), revision + 1) })
      .toThrow("cannot publish session 'admitted': permanent deletion raced this lifecycle")

    await run.registry.archiveSession(SessionId('admitted'))
    expect(() => { run.registry.assertSessionAdmission(SessionId('admitted'), revision) })
      .toThrow("cannot publish session 'admitted' while it is archived")
  })
})

describe('workspace Remote deletion lineage', () => {
  it('refuses a permanent delete whose fresh listing re-parents a cached session', async () => {
    const dir = await makeDir('conflicting-parent')
    const root = header('root', dir, 1)
    const child = childOf(header('child', dir, 2), root.id)
    const run = await harness({ sessions: [root, child] })
    const workspace = run.registry.list()[0]!
    const account = [...workspace.sessionIds]
    await run.registry.archiveSession(root.id)

    // The durable medium now claims a different parent for the same identity.
    run.setSessions([root, childOf(header('child', dir, 2), SessionId('other'))])
    await expect(run.registry.remoteExportDeleteArchivedSession({ sessionId: root.id }, new AbortController().signal))
      .rejects.toThrow("cannot permanently delete session 'root': session 'child' has conflicting parent metadata")
    expect(run.deleteSession).not.toHaveBeenCalled()
    expect(run.registry.archivedSessionIds).toEqual([root.id])
    expect(workspace.sessionIds).toEqual(account)
  })

  it('deletes sibling descendants in deterministic identity order', async () => {
    const dir = await makeDir('sibling-lineage')
    const other = header('unrelated', dir, 5)
    const root = header('root', dir, 1)
    const run = await harness({
      sessions: [
        root,
        childOf(header('child-b', dir, 2), root.id),
        childOf(header('child-a', dir, 3), root.id),
        childOf(header('grandchild', dir, 4), SessionId('child-b')),
        other,
      ],
    })
    const workspace = run.registry.list()[0]!
    await run.registry.archiveSession(root.id)
    const notifications: SessionId[] = []
    run.ctx.on('workspace/session-deleted', (id) => { notifications.push(id) })

    await run.registry.deleteArchivedSession(root.id)
    expect(run.deleteSession.mock.calls.map(([id]) => id))
      .toEqual([SessionId('child-a'), SessionId('grandchild'), SessionId('child-b'), root.id])
    expect(notifications).toEqual([SessionId('child-a'), SessionId('grandchild'), SessionId('child-b'), root.id])
    expect(workspace.sessionIds).toEqual([other.id])
    expect(run.registry.archivedSessionIds).toEqual([])
  })
})

describe('workspace Remote cancellation', () => {
  it('reports cancellation when the signal aborts before a failing operation settles', async () => {
    const run = await harness({ sessions: [] })
    const controller = new AbortController()
    run.list.mockImplementationOnce(async () => {
      controller.abort()
      throw new Error('persistence backend down')
    })
    const failure = failureOf(await run.registry.remoteExportArchiveSession(
      { sessionId: SessionId('ghost') }, controller.signal,
    ))
    expect(failure.code).toBe('cancelled')
    expect(run.registry.archivedSessionIds).toEqual([])
  })
})
