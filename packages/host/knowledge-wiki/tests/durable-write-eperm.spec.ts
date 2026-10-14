import { createHash } from 'node:crypto'
import { existsSync, linkSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const faultFsync = vi.hoisted(() => ({ active: false, code: 'EPERM', failFile: false, fileCode: 'EIO', fileCalls: 0, directoryCalls: 0 }))
const directoryFds = vi.hoisted(() => new Set<number>())
const fileFds = vi.hoisted(() => new Set<number>())
const nameReplacement = vi.hoisted(() => ({ targetPath: '', replacementPath: '' }))
const injectedFsChange = vi.hoisted(() => ({
  lstatPath: '', lstatCalls: 0, lstatThrowAt: 0, lstatErrorCode: 'EACCES',
  lstatReplaceTarget: '', lstatReplaceWith: '', lstatReplaceAt: 0,
  openTarget: '', openReplacement: '', openRequiresCreate: false,
  growOnOpenTarget: '', growOnOpenBytes: '',
  writeHardlinkTarget: '', writeHardlinkPath: '',
  writeParentTarget: '', writeParentMoved: '', writeParentMode: '' as '' | 'symlink' | 'directory',
  openParentTarget: '', openParentBackup: '',
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  // Only directory-handle fsyncs fail with EPERM — the exact windows contract.
  return {
    ...actual,
    lstatSync: (...args: Parameters<typeof actual.lstatSync>) => {
      if (String(args[0]) === injectedFsChange.lstatPath) {
        injectedFsChange.lstatCalls += 1
        if (injectedFsChange.lstatCalls === injectedFsChange.lstatReplaceAt &&
          injectedFsChange.lstatReplaceTarget !== '' && injectedFsChange.lstatReplaceWith !== '') {
          actual.renameSync(injectedFsChange.lstatReplaceWith, injectedFsChange.lstatReplaceTarget)
          injectedFsChange.lstatReplaceTarget = ''
          injectedFsChange.lstatReplaceWith = ''
        }
        if (injectedFsChange.lstatCalls === injectedFsChange.lstatThrowAt) {
          throw Object.assign(new Error(`${injectedFsChange.lstatErrorCode}: injected lstat failure`), { code: injectedFsChange.lstatErrorCode })
        }
      }
      return actual.lstatSync(...args)
    },
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      const openedPath = String(args[0])
      const flags = Number(args[1])
      const isCreateOpen = (flags & actual.constants.O_CREAT) !== 0
      if (openedPath === injectedFsChange.openTarget && injectedFsChange.openReplacement !== '' &&
        (!injectedFsChange.openRequiresCreate || isCreateOpen)) {
        actual.renameSync(injectedFsChange.openReplacement, injectedFsChange.openTarget)
        injectedFsChange.openTarget = ''
        injectedFsChange.openReplacement = ''
      }
      if (openedPath === injectedFsChange.growOnOpenTarget && injectedFsChange.growOnOpenBytes !== '') {
        actual.writeFileSync(openedPath, injectedFsChange.growOnOpenBytes, { flag: 'a' })
        injectedFsChange.growOnOpenTarget = ''
        injectedFsChange.growOnOpenBytes = ''
      }
      const fd = actual.openSync(...args)
      if (openedPath === injectedFsChange.openParentTarget && injectedFsChange.openParentBackup !== '') {
        actual.renameSync(injectedFsChange.openParentTarget, injectedFsChange.openParentBackup)
        actual.mkdirSync(injectedFsChange.openParentTarget)
        injectedFsChange.openParentTarget = ''
        injectedFsChange.openParentBackup = ''
      }
      try {
        if (actual.statSync(String(args[0])).isDirectory()) directoryFds.add(fd)
        else fileFds.add(fd)
      } catch { /* not a stat-able path */ }
      return fd
    },
    closeSync: (fd: number) => {
      directoryFds.delete(fd)
      fileFds.delete(fd)
      actual.closeSync(fd)
    },
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      actual.writeFileSync(...args)
      if (injectedFsChange.writeHardlinkTarget !== '' && injectedFsChange.writeHardlinkPath !== '') {
        actual.linkSync(injectedFsChange.writeHardlinkTarget, injectedFsChange.writeHardlinkPath)
        injectedFsChange.writeHardlinkTarget = ''
        injectedFsChange.writeHardlinkPath = ''
      }
      if (injectedFsChange.writeParentTarget !== '' && injectedFsChange.writeParentMoved !== '') {
        actual.renameSync(injectedFsChange.writeParentTarget, injectedFsChange.writeParentMoved)
        if (injectedFsChange.writeParentMode === 'symlink') actual.symlinkSync(injectedFsChange.writeParentMoved, injectedFsChange.writeParentTarget)
        else actual.mkdirSync(injectedFsChange.writeParentTarget)
        injectedFsChange.writeParentTarget = ''
        injectedFsChange.writeParentMoved = ''
        injectedFsChange.writeParentMode = ''
      }
      if (nameReplacement.targetPath !== '' && nameReplacement.replacementPath !== '') {
        actual.renameSync(nameReplacement.replacementPath, nameReplacement.targetPath)
        nameReplacement.targetPath = ''
        nameReplacement.replacementPath = ''
      }
    },
    fsyncSync: (descriptor: number) => {
      if (directoryFds.has(descriptor)) faultFsync.directoryCalls += 1
      if (fileFds.has(descriptor)) faultFsync.fileCalls += 1
      if (faultFsync.active && directoryFds.has(descriptor)) {
        throw Object.assign(new Error(`${faultFsync.code}: operation not permitted, fsync`), { code: faultFsync.code })
      }
      if (faultFsync.failFile && fileFds.has(descriptor)) {
        throw Object.assign(new Error(`${faultFsync.fileCode}: file fsync failure`), { code: faultFsync.fileCode })
      }
      actual.fsyncSync(descriptor)
    },
  }
})

import {
  atomicWriteFile,
  createPrivateFileIfMissing,
  durableUnlinkFile,
} from '../src/filesystem.ts'
import {
  appendKnowledgeEvent,
  createKnowledgeEvent,
  readKnowledgeEventLog,
  syncKnowledgeEventLog,
} from '../src/knowledge-governance.ts'

const roots: string[] = []
const EVENT_LOG_LIMIT_BYTES = 64 * 1024 * 1024

function eventLineBytes(event: ReturnType<typeof createKnowledgeEvent>): number {
  return Buffer.byteLength(`${JSON.stringify(event)}\n`, 'utf8')
}

function retrievedEventWithLineBytes(
  root: string,
  lineBytes: number,
  timestamp: string,
  id: string,
) {
  const create = (query: string) => createKnowledgeEvent('knowledge/retrieved', 'record-1', {
    projectId: root,
    visibility: 'project',
  }, { query }, { seq: 0, timestamp, previousEventHash: null, id })
  const padding = lineBytes - eventLineBytes(create(''))
  if (!Number.isSafeInteger(padding) || padding < 0) throw new Error('invalid event line fixture size')
  const event = create('x'.repeat(padding))
  if (eventLineBytes(event) !== lineBytes) throw new Error('event line fixture byte count drifted')
  return event
}

function nextRetrievedEvent(path: string, root: string, query: string) {
  const prior = readKnowledgeEventLog(path)
  return createKnowledgeEvent('knowledge/retrieved', 'record-1', { projectId: root, visibility: 'project' }, { query }, {
    seq: prior.length,
    previousEventHash: prior.at(-1)?.eventHash ?? null,
  })
}

afterEach(() => {
  faultFsync.active = false
  faultFsync.code = 'EPERM'
  faultFsync.failFile = false
  faultFsync.fileCode = 'EIO'
  faultFsync.fileCalls = 0
  faultFsync.directoryCalls = 0
  directoryFds.clear()
  fileFds.clear()
  nameReplacement.targetPath = ''
  nameReplacement.replacementPath = ''
  injectedFsChange.lstatPath = ''
  injectedFsChange.lstatCalls = 0
  injectedFsChange.lstatThrowAt = 0
  injectedFsChange.lstatErrorCode = 'EACCES'
  injectedFsChange.lstatReplaceTarget = ''
  injectedFsChange.lstatReplaceWith = ''
  injectedFsChange.lstatReplaceAt = 0
  injectedFsChange.openTarget = ''
  injectedFsChange.openReplacement = ''
  injectedFsChange.openRequiresCreate = false
  injectedFsChange.growOnOpenTarget = ''
  injectedFsChange.growOnOpenBytes = ''
  injectedFsChange.writeHardlinkTarget = ''
  injectedFsChange.writeHardlinkPath = ''
  injectedFsChange.writeParentTarget = ''
  injectedFsChange.writeParentMoved = ''
  injectedFsChange.writeParentMode = ''
  injectedFsChange.openParentTarget = ''
  injectedFsChange.openParentBackup = ''
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

// Windows cannot fsync directory handles (EPERM); the durable-write helpers
// must tolerate that specific failure and still publish the bytes, because
// NTFS journals its own metadata. Every helper runs under the injected fault.
describe('durable writes tolerate EPERM directory fsync', () => {
  it('atomicWriteFile publishes the replacement without the directory fsync', () => {
    const root = mkdtempSync(join(tmpdir(), 'wiki-eperm-'))
    roots.push(root)
    const page = join(root, 'concepts', 'a.md')
    faultFsync.active = true
    atomicWriteFile(page, 'first body')
    faultFsync.active = false
    expect(readFileSync(page, 'utf8')).toBe('first body')
    atomicWriteFile(page, 'second body')
    expect(readFileSync(page, 'utf8')).toBe('second body')
    expect(existsSync(join(root, 'concepts'))).toBe(true)
  })

  it('rethrows non-EPERM fsync failures instead of swallowing them', () => {
    const root = mkdtempSync(join(tmpdir(), 'wiki-eperm-'))
    roots.push(root)
    const page = join(root, 'concepts', 'eio.md')
    faultFsync.active = true
    faultFsync.code = 'EIO'
    expect(() => {
      atomicWriteFile(page, 'body')
    }).toThrow('EIO: operation not permitted, fsync')
    // The other two durable helpers surface the same non-EPERM failure.
    const ledger = join(root, '_governance', 'log.md')
    expect(() => createPrivateFileIfMissing(ledger, Buffer.from('entry')))
      .toThrow('EIO: operation not permitted, fsync')
    expect(() => {
      durableUnlinkFile(ledger)
    }).toThrow('EIO: operation not permitted, fsync')
    faultFsync.code = 'EPERM'
    faultFsync.code = 'EPERM'
    atomicWriteFile(page, 'body')
    faultFsync.active = false
    expect(readFileSync(page, 'utf8')).toBe('body')
  })

  it('createPrivateFileIfMissing and durableUnlinkFile tolerate the EPERM fsync', () => {
    const root = mkdtempSync(join(tmpdir(), 'wiki-eperm-'))
    roots.push(root)
    const ledger = join(root, '_governance', 'log.md')
    faultFsync.active = true
    expect(createPrivateFileIfMissing(ledger, Buffer.from('entry'))).toBe(true)
    expect(existsSync(ledger)).toBe(true)
    durableUnlinkFile(ledger)
    expect(existsSync(ledger)).toBe(false)
    faultFsync.active = false
  })

  it('syncs a newly created event log and its parent directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'wiki-event-durable-'))
    roots.push(root)
    const path = join(root, 'events.jsonl')
    const event = createKnowledgeEvent('knowledge/retrieved', 'record-1', { projectId: root, visibility: 'project' }, { query: 'first' })

    appendKnowledgeEvent(path, event)

    expect(faultFsync.fileCalls).toBe(1)
    expect(faultFsync.directoryCalls).toBe(1)
    expect(readKnowledgeEventLog(path)).toEqual([event])
  })

  it('surfaces file fsync failure and lets an explicit retry sync the appended log', () => {
    const root = mkdtempSync(join(tmpdir(), 'wiki-event-retry-'))
    roots.push(root)
    const path = join(root, 'events.jsonl')
    const event = createKnowledgeEvent('knowledge/retrieved', 'record-1', { projectId: root, visibility: 'project' }, { query: 'retry' })
    faultFsync.failFile = true

    expect(() => { appendKnowledgeEvent(path, event) }).toThrow('EIO: file fsync failure')
    expect(readKnowledgeEventLog(path)).toEqual([event])
    expect(faultFsync.directoryCalls).toBe(0)

    faultFsync.failFile = false
    syncKnowledgeEventLog(path)

    expect(faultFsync.fileCalls).toBe(2)
    expect(faultFsync.directoryCalls).toBe(1)
    expect(readKnowledgeEventLog(path)).toEqual([event])
  })

  it('rejects symlinked and multiply linked event logs when syncing', () => {
    const root = mkdtempSync(join(tmpdir(), 'wiki-event-unsafe-'))
    roots.push(root)
    const path = join(root, 'events.jsonl')
    const event = createKnowledgeEvent('knowledge/retrieved', 'record-1', { projectId: root, visibility: 'project' }, { query: 'unsafe' })
    appendKnowledgeEvent(path, event)
    expect(readKnowledgeEventLog(path)).toEqual([event])

    const hardlink = join(root, 'events-hardlink.jsonl')
    linkSync(path, hardlink)
    expect(() => { syncKnowledgeEventLog(hardlink) }).toThrow('unsafe knowledge event log')
    if (process.platform !== 'win32') {
      const symlink = join(root, 'events-symlink.jsonl')
      symlinkSync(path, symlink)
      expect(() => { syncKnowledgeEventLog(symlink) }).toThrow('unsafe knowledge event log')
    }
  })

  it('tolerates only directory EPERM while syncing an event log', () => {
    const root = mkdtempSync(join(tmpdir(), 'wiki-event-eperm-'))
    roots.push(root)
    const path = join(root, 'events.jsonl')
    const event = createKnowledgeEvent('knowledge/retrieved', 'record-1', { projectId: root, visibility: 'project' }, { query: 'eperm' })
    faultFsync.active = true

    expect(() => { appendKnowledgeEvent(path, event) }).not.toThrow()
    expect(faultFsync.fileCalls).toBe(1)
    expect(faultFsync.directoryCalls).toBe(1)
    expect(readKnowledgeEventLog(path)).toEqual([event])
  })

  it('refuses a path replacement between append write and sync without fsyncing the replacement inode', () => {
    const root = mkdtempSync(join(tmpdir(), 'wiki-event-replaced-'))
    roots.push(root)
    const path = join(root, 'events.jsonl')
    const scope = { projectId: root, visibility: 'project' as const }
    const first = createKnowledgeEvent('knowledge/retrieved', 'record-1', scope, { query: 'first' })
    appendKnowledgeEvent(path, first)
    const prior = readKnowledgeEventLog(path)
    const second = createKnowledgeEvent('knowledge/retrieved', 'record-1', scope, { query: 'second' }, {
      seq: prior.length,
      previousEventHash: prior.at(-1)?.eventHash ?? null,
    })
    const replacement = join(root, 'replacement.jsonl')
    writeFileSync(replacement, 'replacement inode\n')
    nameReplacement.targetPath = path
    nameReplacement.replacementPath = replacement

    expect(() => { appendKnowledgeEvent(path, second) }).toThrow('unsafe knowledge event log')
    expect(readFileSync(path, 'utf8')).toBe('replacement inode\n')
    expect(faultFsync.fileCalls).toBe(1)
    expect(faultFsync.directoryCalls).toBe(1)
  })

  it('rejects a hard-linked writer inode added after append and closes the writer', () => {
    const root = mkdtempSync(join(tmpdir(), 'wiki-event-link-race-'))
    roots.push(root)
    const path = join(root, 'events.jsonl')
    appendKnowledgeEvent(path, createKnowledgeEvent('knowledge/retrieved', 'record-1', { projectId: root, visibility: 'project' }, { query: 'first' }))
    injectedFsChange.writeHardlinkTarget = path
    injectedFsChange.writeHardlinkPath = join(root, 'raced-hardlink.jsonl')

    expect(() => { appendKnowledgeEvent(path, nextRetrievedEvent(path, root, 'second')) }).toThrow('unsafe knowledge event log')
    expect(faultFsync.fileCalls).toBe(1)
    expect(fileFds.size).toBe(0)
    expect(directoryFds.size).toBe(0)
  })

  it('rejects a symlinked parent directory after the event write and closes both handles', () => {
    const root = mkdtempSync(join(tmpdir(), 'wiki-event-parent-link-'))
    roots.push(root)
    const parent = join(root, 'journal')
    const path = join(parent, 'events.jsonl')
    appendKnowledgeEvent(path, createKnowledgeEvent('knowledge/retrieved', 'record-1', { projectId: root, visibility: 'project' }, { query: 'first' }))
    injectedFsChange.writeParentTarget = parent
    injectedFsChange.writeParentMoved = join(root, 'journal-moved')
    injectedFsChange.writeParentMode = 'symlink'

    expect(() => { appendKnowledgeEvent(path, nextRetrievedEvent(path, root, 'second')) }).toThrow('unsafe knowledge event log parent')
    expect(faultFsync.fileCalls).toBe(2)
    expect(faultFsync.directoryCalls).toBe(1)
    expect(fileFds.size).toBe(0)
    expect(directoryFds.size).toBe(0)
  })

  it('rejects a parent directory inode replaced after open and closes its descriptor', () => {
    const root = mkdtempSync(join(tmpdir(), 'wiki-event-parent-swap-'))
    roots.push(root)
    const parent = join(root, 'journal')
    const path = join(parent, 'events.jsonl')
    appendKnowledgeEvent(path, createKnowledgeEvent('knowledge/retrieved', 'record-1', { projectId: root, visibility: 'project' }, { query: 'first' }))
    injectedFsChange.openParentTarget = parent
    injectedFsChange.openParentBackup = join(root, 'journal-old')

    expect(() => { appendKnowledgeEvent(path, nextRetrievedEvent(path, root, 'second')) }).toThrow('unsafe knowledge event log parent')
    expect(faultFsync.fileCalls).toBe(2)
    expect(faultFsync.directoryCalls).toBe(1)
    expect(fileFds.size).toBe(0)
    expect(directoryFds.size).toBe(0)
  })

  it('propagates non-EPERM event-log parent fsync failures and closes descriptors', () => {
    const root = mkdtempSync(join(tmpdir(), 'wiki-event-parent-eio-'))
    roots.push(root)
    const path = join(root, 'events.jsonl')
    appendKnowledgeEvent(path, createKnowledgeEvent('knowledge/retrieved', 'record-1', { projectId: root, visibility: 'project' }, { query: 'first' }))
    faultFsync.active = true
    faultFsync.code = 'EIO'

    expect(() => { appendKnowledgeEvent(path, nextRetrievedEvent(path, root, 'second')) }).toThrow('EIO: operation not permitted, fsync')
    expect(faultFsync.fileCalls).toBe(2)
    expect(faultFsync.directoryCalls).toBe(2)
    expect(fileFds.size).toBe(0)
    expect(directoryFds.size).toBe(0)
  })

  it('rejects a pathname changed between sync helper stat and open without syncing its replacement', () => {
    const root = mkdtempSync(join(tmpdir(), 'wiki-event-sync-open-swap-'))
    roots.push(root)
    const path = join(root, 'events.jsonl')
    appendKnowledgeEvent(path, createKnowledgeEvent('knowledge/retrieved', 'record-1', { projectId: root, visibility: 'project' }, { query: 'first' }))
    const replacement = join(root, 'replacement.jsonl')
    writeFileSync(replacement, 'replacement inode\n')
    injectedFsChange.openTarget = path
    injectedFsChange.openReplacement = replacement

    expect(() => { syncKnowledgeEventLog(path) }).toThrow('unsafe knowledge event log')
    expect(readFileSync(path, 'utf8')).toBe('replacement inode\n')
    expect(faultFsync.fileCalls).toBe(1)
    expect(fileFds.size).toBe(0)
    expect(directoryFds.size).toBe(0)
  })

  it('uses the supported no-follow fallback branch for a Windows-platform sync', () => {
    const root = mkdtempSync(join(tmpdir(), 'wiki-event-windows-flags-'))
    roots.push(root)
    const path = join(root, 'events.jsonl')
    appendKnowledgeEvent(path, createKnowledgeEvent('knowledge/retrieved', 'record-1', { projectId: root, visibility: 'project' }, { query: 'first' }))
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    if (platformDescriptor === undefined || !platformDescriptor.configurable) throw new Error('test platform property cannot be restored')
    try {
      Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' })
      syncKnowledgeEventLog(path)
    } finally {
      Object.defineProperty(process, 'platform', platformDescriptor)
    }
    expect(faultFsync.fileCalls).toBe(2)
    expect(faultFsync.directoryCalls).toBe(2)
  })

  it('propagates non-ENOENT errors from append pre-open lstat without writing', () => {
    const root = mkdtempSync(join(tmpdir(), 'wiki-event-lstat-eacces-'))
    roots.push(root)
    const path = join(root, 'events.jsonl')
    appendKnowledgeEvent(path, createKnowledgeEvent('knowledge/retrieved', 'record-1', { projectId: root, visibility: 'project' }, { query: 'first' }))
    injectedFsChange.lstatPath = path
    injectedFsChange.lstatCalls = 0
    injectedFsChange.lstatThrowAt = 3

    expect(() => { appendKnowledgeEvent(path, nextRetrievedEvent(path, root, 'second')) }).toThrow('EACCES: injected lstat failure')
    expect(faultFsync.fileCalls).toBe(1)
    expect(fileFds.size).toBe(0)
  })

  it('rejects a writer descriptor opened on a replacement inode before writing', () => {
    const root = mkdtempSync(join(tmpdir(), 'wiki-event-writer-open-swap-'))
    roots.push(root)
    const path = join(root, 'events.jsonl')
    appendKnowledgeEvent(path, createKnowledgeEvent('knowledge/retrieved', 'record-1', { projectId: root, visibility: 'project' }, { query: 'first' }))
    const replacement = join(root, 'replacement.jsonl')
    writeFileSync(replacement, 'replacement inode\n')
    injectedFsChange.openTarget = path
    injectedFsChange.openReplacement = replacement
    injectedFsChange.openRequiresCreate = true

    expect(() => { appendKnowledgeEvent(path, nextRetrievedEvent(path, root, 'second')) }).toThrow('unsafe knowledge event log')
    expect(readFileSync(path, 'utf8')).toBe('replacement inode\n')
    expect(faultFsync.fileCalls).toBe(1)
    expect(fileFds.size).toBe(0)
    expect(directoryFds.size).toBe(0)
  })

  it('rechecks opened writer size when the existing log grows after preflight', () => {
    const root = mkdtempSync(join(tmpdir(), 'wiki-event-writer-size-race-'))
    roots.push(root)
    const path = join(root, 'events.jsonl')
    const timestamp = '2026-10-13T00:00:00.000Z'
    const nextTemplate = createKnowledgeEvent('knowledge/retrieved', 'record-1', { projectId: root, visibility: 'project' },
      { query: 'next' }, { seq: 1, timestamp, previousEventHash: 'a'.repeat(64), id: 'event-next' })
    const nextBytes = eventLineBytes(nextTemplate)
    const first = retrievedEventWithLineBytes(root, EVENT_LOG_LIMIT_BYTES - nextBytes, timestamp, 'event-first')
    appendKnowledgeEvent(path, first)
    const before = readFileSync(path)
    expect(before.byteLength + nextBytes).toBe(EVENT_LOG_LIMIT_BYTES)
    expect(readKnowledgeEventLog(path)).toHaveLength(1)

    const next = createKnowledgeEvent('knowledge/retrieved', 'record-1', { projectId: root, visibility: 'project' },
      { query: 'next' }, { seq: 1, timestamp, previousEventHash: first.eventHash, id: 'event-next' })
    expect(eventLineBytes(next)).toBe(nextBytes)
    faultFsync.fileCalls = 0
    faultFsync.directoryCalls = 0
    injectedFsChange.growOnOpenTarget = path
    injectedFsChange.growOnOpenBytes = '\n'

    expect(() => { appendKnowledgeEvent(path, next) }).toThrow(/knowledge event log exceeds/u)

    const after = readFileSync(path)
    expect(after.byteLength).toBe(before.byteLength + 1)
    expect(createHash('sha256').update(after).digest('hex'))
      .toBe(createHash('sha256').update(Buffer.concat([before, Buffer.from('\n')])).digest('hex'))
    expect(readKnowledgeEventLog(path)).toHaveLength(1)
    expect(faultFsync.fileCalls).toBe(0)
    expect(faultFsync.directoryCalls).toBe(0)
    expect(fileFds.size).toBe(0)
    expect(directoryFds.size).toBe(0)
  }, 30_000)

  it('rejects a path replaced with a symlink after the reader closes and before the first append precheck', () => {
    const root = mkdtempSync(join(tmpdir(), 'wiki-event-first-precheck-swap-'))
    roots.push(root)
    const path = join(root, 'events.jsonl')
    appendKnowledgeEvent(path, createKnowledgeEvent('knowledge/retrieved', 'record-1', { projectId: root, visibility: 'project' }, { query: 'first' }))
    const replacement = join(root, 'replacement.jsonl')
    const replacementBytes = 'untouched replacement target\n'
    writeFileSync(replacement, replacementBytes)
    const next = nextRetrievedEvent(path, root, 'second')
    faultFsync.fileCalls = 0
    faultFsync.directoryCalls = 0
    injectedFsChange.lstatPath = path
    injectedFsChange.lstatCalls = 0
    // readRegularFileBounded checks this path twice; call 3 is append's first
    // lstat, after the reader has closed its descriptor and before any write.
    injectedFsChange.lstatReplaceAt = 3
    injectedFsChange.lstatReplaceTarget = path
    injectedFsChange.lstatReplaceWith = join(root, 'replacement-link.jsonl')
    symlinkSync(replacement, injectedFsChange.lstatReplaceWith)

    expect(() => { appendKnowledgeEvent(path, next) }).toThrow('unsafe knowledge event log')

    expect(injectedFsChange.lstatCalls).toBe(3)
    expect(injectedFsChange.lstatReplaceTarget).toBe('')
    expect(readFileSync(path, 'utf8')).toBe(replacementBytes)
    expect(readFileSync(replacement, 'utf8')).toBe(replacementBytes)
    expect(faultFsync.fileCalls).toBe(0)
    expect(faultFsync.directoryCalls).toBe(0)
    expect(fileFds.size).toBe(0)
    expect(directoryFds.size).toBe(0)
  })
})
