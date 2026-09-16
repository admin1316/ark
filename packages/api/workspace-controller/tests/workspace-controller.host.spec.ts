import { existsSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { TypertRemoteFailure } from '@deepseek-ai/dsh-typert-protocol'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import type { WorkspaceId, WorkspaceRemoteResult } from '@deepseek-ai/dsh-workspace/types'
import WorkspaceController from '../src/index.ts'
import { WorkspaceFeed } from '../src/feed.ts'
import type { WorkspaceFollowFrame } from '../src/types.ts'
import { MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'

const roots: Context[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
})

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

async function harness() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-workspace-controller-')))
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend())
  const storageDomain = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', storageDomain)
  ctx.provide('storageDomain', storageDomain)
  ctx.provide('sessionPersistence', { list: () => Promise.resolve([]) } as never)
  await ctx.plugin(WorkspaceRegistry)
  const dispose = (): void => {}
  ctx.provide('typert', {
    lookups: { configure: () => dispose },
    contexts: { configureHost: () => dispose },
  } as never)
  const controller = new WorkspaceController(ctx)
  const signal = new AbortController().signal
  const unwrap = async <T>(result: Promise<WorkspaceRemoteResult<T>>): Promise<T> => {
    const value = await result
    if (!value.ok) throw new TypertRemoteFailure(value.error)
    return value.value
  }
  const commands = {
    create: (request: Parameters<WorkspaceRegistry['remoteExportCreate']>[0]) => unwrap(ctx.workspaceRegistry.remoteExportCreate(request, signal)),
    rename: (request: Parameters<WorkspaceRegistry['remoteExportRename']>[0]) => unwrap(ctx.workspaceRegistry.remoteExportRename(request, signal)),
    delete: (request: Parameters<WorkspaceRegistry['remoteExportDelete']>[0]) => unwrap(ctx.workspaceRegistry.remoteExportDelete(request, signal)),
    insertBefore: (request: Parameters<WorkspaceRegistry['remoteExportInsertBefore']>[0]) => unwrap(ctx.workspaceRegistry.remoteExportInsertBefore(request, signal)),
    insertSessionBefore: (request: Parameters<WorkspaceRegistry['remoteExportInsertSessionBefore']>[0]) => unwrap(ctx.workspaceRegistry.remoteExportInsertSessionBefore(request, signal)),
    archiveSession: (request: Parameters<WorkspaceRegistry['remoteExportArchiveSession']>[0]) => unwrap(ctx.workspaceRegistry.remoteExportArchiveSession(request, signal)),
  }
  return { controller, commands, ctx, root, storageDomain }
}

function stageDir(root: string, name: string): string {
  const path = join(root, name)
  mkdirSync(path, { recursive: true })
  return path
}

async function nextFrame(
  iterator: AsyncIterator<WorkspaceFollowFrame>,
): Promise<WorkspaceFollowFrame> {
  const next = await iterator.next()
  if (next.done === true) throw new Error('Workspace stream ended before the expected frame')
  return next.value
}

describe('canonical Workspace commands with retained follow controller', () => {
  it('serializes concurrent path adoption and preserves an existing title', async () => {
    const { commands, root } = await harness()
    const path = stageDir(root, 'alpha')
    const results = await Promise.all([
      commands.create({ path }),
      commands.create({ path }),
    ])
    const created = results.find(result => result.created)
    const resolved = results.find(result => !result.created)
    expect(created).toMatchObject({ workspace: { path, title: 'alpha' } })
    expect(resolved?.workspace.workspaceId).toBe(created?.workspace.workspaceId)

    const workspaceId = created?.workspace.workspaceId
    if (workspaceId === undefined) throw new Error('fixture did not create a Workspace')
    await commands.rename({ workspaceId, title: 'renamed' })
    await expect(commands.create({ path })).resolves.toMatchObject({
      created: false,
      workspace: { workspaceId, title: 'renamed' },
    })
  })

  it('maps invalid paths, blank names, conflicts, and unknown ids to stable failures', async () => {
    const { commands, root } = await harness()
    const first = await commands.create({ path: stageDir(root, 'first') })
    const second = await commands.create({ path: stageDir(root, 'second') })

    await expect(commands.create({ path: join(root, 'missing') })).rejects.toMatchObject({
      failure: { code: 'workspace-invalid-path', details: { path: join(root, 'missing') } },
    })
    expect(existsSync(join(root, 'missing'))).toBe(false)
    await expect(commands.rename({ workspaceId: first.workspace.workspaceId, title: '  ' }))
      .rejects.toMatchObject({ failure: { code: 'arguments-invalid' } })
    await commands.rename({ workspaceId: first.workspace.workspaceId, title: 'occupied' })
    await expect(commands.rename({ workspaceId: second.workspace.workspaceId, title: ' occupied ' }))
      .rejects.toMatchObject({ failure: { code: 'workspace-name-conflict' } })
    await expect(commands.delete({ workspaceId: 'missing' as WorkspaceId }))
      .rejects.toMatchObject({ failure: { code: 'workspace-not-found' } })
  })

  it('preserves Remote failures and propagates unexpected registry failures', async () => {
    const { commands, ctx, root } = await harness()
    const remoteFailure = new TypertRemoteFailure({
      code: 'fixture-failure',
      message: 'already mapped',
      details: {},
    })
    const createOrResolve = vi.spyOn(ctx.workspaceRegistry, 'createOrResolve')
      .mockRejectedValueOnce(remoteFailure)
      .mockRejectedValueOnce('plain failure')
    await expect(commands.create({ path: stageDir(root, 'remote-failure') }))
      .rejects.toBe(remoteFailure)
    const plainFailure = commands.create({ path: stageDir(root, 'plain-failure') })
    await expect(plainFailure).rejects.toMatchObject({
      failure: { code: 'workspace-invalid-path' },
    })
    await expect(plainFailure).rejects.toThrow('plain failure')
    createOrResolve.mockRestore()

    const created = await commands.create({ path: stageDir(root, 'created') })
    const workspace = ctx.workspaceRegistry.get(created.workspace.workspaceId)
    if (workspace === undefined) throw new Error('fixture Workspace disappeared')

    const orderFailure = new Error('order storage failed')
    vi.spyOn(ctx.workspaceRegistry, 'insertBefore').mockRejectedValueOnce(orderFailure)
    await expect(commands.insertBefore({ workspaceId: created.workspace.workspaceId }))
      .rejects.toBe(orderFailure)

    const moveFailure = new Error('membership storage failed')
    vi.spyOn(workspace, 'insertSessionBefore').mockRejectedValueOnce(moveFailure)
    await expect(commands.insertSessionBefore({
      workspaceId: created.workspace.workspaceId,
      sessionId: SessionId('session'),
    })).rejects.toBe(moveFailure)

    const archiveFailure = new Error('archive storage failed')
    vi.spyOn(ctx.workspaceRegistry, 'archiveSession').mockRejectedValueOnce(archiveFailure)
    await expect(commands.archiveSession({ sessionId: SessionId('session') }))
      .rejects.toBe(archiveFailure)
  })

  it('resolves queued Workspace identities when their operation starts', async () => {
    const { commands, ctx, root } = await harness()
    const target = await commands.create({ path: stageDir(root, 'target') })
    const workspace = ctx.workspaceRegistry.get(target.workspace.workspaceId)
    if (workspace === undefined) throw new Error('fixture Workspace disappeared')
    const gate = deferred<undefined>()
    const entered = deferred<undefined>()
    const setTitle = workspace.setTitle.bind(workspace)
    vi.spyOn(workspace, 'setTitle').mockImplementationOnce(async (title) => {
      entered.resolve(undefined)
      await gate.promise
      await setTitle(title)
    })
    const blocker = commands.rename({ workspaceId: workspace.id, title: 'blocking' })
    await entered.promise
    const deletion = commands.delete({ workspaceId: workspace.id })
    const staleRename = commands.rename({ workspaceId: workspace.id, title: 'must-not-land' })
    gate.resolve(undefined)
    await blocker
    await expect(deletion).resolves.toEqual({ deleted: true })
    await expect(staleRename).rejects.toMatchObject({ failure: { code: 'workspace-not-found' } })
  })

  it('reorders Workspaces and Sessions and archives only known Sessions', async () => {
    const { commands, ctx, root } = await harness()
    const first = await commands.create({ path: stageDir(root, 'first') })
    const second = await commands.create({ path: stageDir(root, 'second') })
    await expect(commands.insertBefore({
      workspaceId: first.workspace.workspaceId,
      beforeWorkspaceId: second.workspace.workspaceId,
    })).resolves.toEqual({
      workspaceIds: [first.workspace.workspaceId, second.workspace.workspaceId],
    })
    await expect(commands.insertBefore({ workspaceId: 'missing' as WorkspaceId }))
      .rejects.toMatchObject({ failure: { code: 'workspace-not-found' } })

    const session = ctx.sessions.create(SessionId('session-one'), {
      meta: { cwd: first.workspace.path },
    })
    const workspace = ctx.workspaceRegistry.get(first.workspace.workspaceId)
    if (workspace === undefined) throw new Error('fixture Workspace disappeared')
    await workspace.attachSession(session.id)
    await expect(commands.insertSessionBefore({
      workspaceId: first.workspace.workspaceId,
      sessionId: session.id,
    })).resolves.toMatchObject({ workspace: { sessionIds: [session.id] } })
    await expect(commands.insertSessionBefore({
      workspaceId: first.workspace.workspaceId,
      sessionId: SessionId('missing-session'),
    })).rejects.toMatchObject({ failure: { code: 'workspace-move-invalid' } })
    await expect(commands.insertSessionBefore({
      workspaceId: first.workspace.workspaceId,
      sessionId: session.id,
      beforeSessionId: SessionId('missing-anchor'),
    })).rejects.toMatchObject({
      failure: {
        code: 'workspace-move-invalid',
        details: { beforeSessionId: 'missing-anchor' },
      },
    })
    await expect(commands.insertSessionBefore({
      workspaceId: 'missing' as WorkspaceId,
      sessionId: session.id,
    })).rejects.toMatchObject({ failure: { code: 'workspace-not-found' } })

    await expect(commands.archiveSession({ sessionId: session.id }))
      .resolves.toEqual({ archivedSessionIds: [session.id] })
    await expect(commands.archiveSession({ sessionId: SessionId('unknown') }))
      .rejects.toMatchObject({ failure: { code: 'session-not-found' } })
  })
})

describe('WorkspaceController follow', () => {
  it('seeds a new feed from existing rows and rejects an inconsistent registry commit', async () => {
    const { ctx, root } = await harness()
    const existing = await ctx.workspaceRegistry.create(stageDir(root, 'existing'))
    const feed = new WorkspaceFeed(ctx)
    expect(feed.baseline()).toMatchObject({
      items: [{ workspaceId: existing.id }],
    })

    expect(() => {
      ctx.emit('domain/changed', {
        domain: 'workspace',
        table: '',
        key: '',
        operation: 'put',
        value: {
          initialized: true,
          workspaceIds: ['missing'],
          archivedSessionIds: [],
        },
      })
    }).toThrow('references missing Workspace "missing"')
  })

  it('starts with a complete baseline and emits committed increments in domain order', async () => {
    const { controller, commands, ctx, root } = await harness()
    const abort = new AbortController()
    const iterator = controller.follow(abort.signal)[Symbol.asyncIterator]()
    await expect(nextFrame(iterator)).resolves.toEqual({
      type: 'baseline',
      value: { items: [], archivedSessionIds: [] },
    })

    const first = await commands.create({ path: stageDir(root, 'first') })
    await expect(nextFrame(iterator)).resolves.toMatchObject({
      type: 'upsert', workspace: { workspaceId: first.workspace.workspaceId },
    })
    await expect(nextFrame(iterator)).resolves.toEqual({
      type: 'order', workspaceIds: [first.workspace.workspaceId],
    })
    await commands.rename({ workspaceId: first.workspace.workspaceId, title: 'renamed' })
    await expect(nextFrame(iterator)).resolves.toMatchObject({
      type: 'upsert', workspace: { title: 'renamed' },
    })

    const second = await commands.create({ path: stageDir(root, 'second') })
    await expect(nextFrame(iterator)).resolves.toMatchObject({
      type: 'upsert', workspace: { workspaceId: second.workspace.workspaceId },
    })
    await expect(nextFrame(iterator)).resolves.toEqual({
      type: 'order', workspaceIds: [second.workspace.workspaceId, first.workspace.workspaceId],
    })
    await commands.insertBefore({
      workspaceId: first.workspace.workspaceId,
      beforeWorkspaceId: second.workspace.workspaceId,
    })
    await expect(nextFrame(iterator)).resolves.toEqual({
      type: 'order',
      workspaceIds: [first.workspace.workspaceId, second.workspace.workspaceId],
    })

    const session = ctx.sessions.create(SessionId('archived'), {
      meta: { cwd: first.workspace.path },
    })
    await commands.archiveSession({ sessionId: session.id })
    await expect(nextFrame(iterator)).resolves.toEqual({
      type: 'archived', archivedSessionIds: [session.id],
    })
    await commands.delete({ workspaceId: second.workspace.workspaceId })
    await expect(nextFrame(iterator)).resolves.toEqual({
      type: 'order', workspaceIds: [first.workspace.workspaceId],
    })
    await expect(nextFrame(iterator)).resolves.toEqual({
      type: 'remove', workspaceId: second.workspace.workspaceId,
    })

    abort.abort()
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
  })

  it('ignores unrelated domain writes and closes active followers on disposal', async () => {
    const { controller, commands, ctx, root } = await harness()
    const abort = new AbortController()
    const iterator = controller.follow(abort.signal)[Symbol.asyncIterator]()
    await nextFrame(iterator)
    ctx.emit('domain/changed', {
      domain: 'other', table: 'records', key: 'x', operation: 'put', value: {},
    })
    ctx.emit('domain/changed', {
      domain: 'workspace', table: '', key: '', operation: 'deleted',
    })
    ctx.emit('domain/changed', {
      domain: 'workspace', table: 'other', key: 'x', operation: 'put', value: {},
    })
    ctx.emit('domain/changed', {
      domain: 'workspace', table: 'workspaces', key: 'unknown', operation: 'deleted',
    })
    const pending = iterator.next()
    const created = await commands.create({ path: stageDir(root, 'visible') })
    await expect(pending).resolves.toMatchObject({ value: { type: 'upsert' } })
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: 'order', workspaceIds: [created.workspace.workspaceId] },
    })

    const closing = iterator.next()
    await ctx.fiber.dispose()
    roots.splice(roots.indexOf(ctx), 1)
    await expect(closing).resolves.toEqual({ done: true, value: undefined })
  })
})
