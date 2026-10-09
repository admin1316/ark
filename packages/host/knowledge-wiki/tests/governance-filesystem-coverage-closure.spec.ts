import { constants, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const io = vi.hoisted(() => ({
  beforeOpen: undefined as ((path: unknown, flags: unknown) => void) | undefined,
  beforeStat: undefined as ((path: unknown) => void) | undefined,
  afterRename: undefined as ((from: unknown, to: unknown) => void) | undefined,
  descriptors: new Set<number>(),
}))

// Use real inodes and interleave changes at the public I/O boundary.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    lstatSync: (...args: Parameters<typeof actual.lstatSync>) => {
      io.beforeStat?.(args[0])
      return actual.lstatSync(...args)
    },
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      io.beforeOpen?.(args[0], args[1])
      const fd = actual.openSync(...args)
      io.descriptors.add(fd)
      return fd
    },
    closeSync: (fd: number) => {
      actual.closeSync(fd)
      io.descriptors.delete(fd)
    },
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      actual.renameSync(...args)
      io.afterRename?.(args[0], args[1])
    },
  }
})

import { durableUnlinkFile, syncDirectory, syncRegularFile } from '../src/filesystem.ts'
import {
  appendKnowledgeEvent, applyKnowledgeEvent, createKnowledgeEvent, createKnowledgeRecord,
  readKnowledgeEventLog, replayKnowledgeEvents, validateKnowledgeEvent,
} from '../src/knowledge-governance.ts'

const roots: string[] = []
const nativePlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'wiki-governance-fs-closure-'))
  roots.push(root)
  return root
}

afterEach(() => {
  io.beforeOpen = undefined
  io.beforeStat = undefined
  io.afterRename = undefined
  Object.defineProperty(process, 'platform', nativePlatform)
  expect(io.descriptors.size).toBe(0)
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('filesystem flush identity and non-overwriting deletion', () => {
  it('treats an absent file and absent parent as an idempotent deletion without creating either', () => {
    const root = fixture()
    const path = join(root, 'absent-parent', 'absent-file')
    durableUnlinkFile(path)
    expect(readdirSync(root)).toEqual([])
  })

  it.each(['file', 'symlink'] as const)('rejects non-directory flush %s', (kind) => {
    const root = fixture()
    const path = join(root, 'unsafe')
    if (kind === 'file') writeFileSync(path, 'keep')
    else symlinkSync(root, path)
    expect(() => { syncDirectory(path) }).toThrow('unsafe directory path')
  })

  it('closes the directory descriptor after a real directory inode replacement', () => {
    const root = fixture()
    const path = join(root, 'directory')
    mkdirSync(path)
    io.beforeOpen = (target) => {
      if (target !== path) return
      io.beforeOpen = undefined
      renameSync(path, join(root, 'preserved-directory'))
      mkdirSync(path)
    }
    expect(() => { syncDirectory(path) }).toThrow('directory identity changed')
    expect(existsSync(join(root, 'preserved-directory'))).toBe(true)
  })

  it.each(['directory', 'symlink', 'hardlink'] as const)('rejects non-unique regular file flush %s', (kind) => {
    const root = fixture()
    const path = join(root, 'unsafe')
    if (kind === 'directory') mkdirSync(path)
    else {
      writeFileSync(join(root, 'original'), 'keep')
      if (kind === 'symlink') symlinkSync(join(root, 'original'), path)
      else linkSync(join(root, 'original'), path)
    }
    expect(() => { syncRegularFile(path) }).toThrow('not a unique ordinary file')
    if (kind !== 'directory') expect(readFileSync(join(root, 'original'), 'utf8')).toBe('keep')
  })

  it('closes the file descriptor after a real file inode replacement', () => {
    const root = fixture()
    const path = join(root, 'page')
    writeFileSync(path, 'first')
    io.beforeOpen = (target) => {
      if (target !== path) return
      io.beforeOpen = undefined
      renameSync(path, join(root, 'preserved'))
      writeFileSync(path, 'other')
    }
    expect(() => { syncRegularFile(path) }).toThrow('file identity changed while opening')
    expect(readFileSync(path, 'utf8')).toBe('other')
    expect(readFileSync(join(root, 'preserved'), 'utf8')).toBe('first')
  })

  it('selects read-write access for the legacy win32 file flush branch', () => {
    const path = join(fixture(), 'page')
    writeFileSync(path, 'unchanged')
    Object.defineProperty(process, 'platform', { ...nativePlatform, value: 'win32' })
    let flags: unknown
    io.beforeOpen = (target, value) => { if (target === path) flags = value }
    syncRegularFile(path)
    expect(flags).toBe(constants.O_RDWR | constants.O_NOFOLLOW)
    expect(readFileSync(path, 'utf8')).toBe('unchanged')
  })

  it('does not restore a changed tombstone over a concurrently recreated original', () => {
    const root = fixture()
    const path = join(root, 'page')
    writeFileSync(path, 'original')
    let tombstone = ''
    io.afterRename = (from, to) => {
      if (from !== path) return
      io.afterRename = undefined
      tombstone = String(to)
      renameSync(tombstone, join(root, 'preserved'))
      writeFileSync(tombstone, 'replacement tombstone')
      writeFileSync(path, 'concurrent original')
    }
    expect(() => { durableUnlinkFile(path) }).toThrow('file changed before unlink')
    expect(readFileSync(path, 'utf8')).toBe('concurrent original')
    expect(readFileSync(tombstone, 'utf8')).toBe('replacement tombstone')
    expect(readFileSync(join(root, 'preserved'), 'utf8')).toBe('original')
    expect(readdirSync(root)).toHaveLength(3)
  })
})

function governed() {
  return createKnowledgeRecord({ id: 'fixture-record', content: 'A bounded synthetic claim.', source: 'fixture.md',
    evidenceRefs: ['synthetic-structural-evidence'], scope: { projectId: 'fixture-project', visibility: 'project' },
    createdAt: '2026-10-09T00:00:00.000Z', expiresAt: '2026-10-10T00:00:00.000Z', lifecycle: 'candidate' })
}

describe('governance structural transitions and durable rejection boundaries', () => {
  it('propagates an unsafe event-log read instead of treating it as an absent log', () => {
    const root = fixture()
    const log = join(root, 'events.jsonl')
    const alias = join(root, 'alias.jsonl')
    writeFileSync(log, 'preserved bytes')
    linkSync(log, alias)
    expect(() => readKnowledgeEventLog(log)).toThrow('not a unique ordinary file')
    expect(readFileSync(log, 'utf8')).toBe('preserved bytes')
    expect(readFileSync(alias, 'utf8')).toBe('preserved bytes')
  })

  it.each(['sequence', 'hash'] as const)('rejects a correctly hashed event linked to the wrong predecessor %s', (kind) => {
    const record = governed()
    const previous = createKnowledgeEvent('knowledge/observed', record.id, record.scope, { record }, { seq: 0 })
    const next = createKnowledgeEvent('knowledge/retrieved', record.id, record.scope, {}, {
      seq: kind === 'sequence' ? 2 : 1,
      previousEventHash: kind === 'hash' ? 'f'.repeat(64) : previous.eventHash,
    })
    expect(validateKnowledgeEvent(next)).toBe(true)
    expect(validateKnowledgeEvent(next, previous)).toBe(false)
  })

  // These exercise structural folding only; synthetic seals confer no runtime authority.
  it('defaults structurally verified trust to medium and preserves the prior state on invalid trust', () => {
    const record = governed()
    const observed = createKnowledgeEvent('knowledge/observed', record.id, record.scope, { record }, { seq: 0 })
    const state = replayKnowledgeEvents([observed])
    const payload = { record, authority: 'synthetic-authority', authoritySeal: {
      authorityId: 'synthetic-authority', proof: 'synthetic-structural-only',
    }, evidenceRefs: ['synthetic-structural-evidence'] }
    const event = createKnowledgeEvent('knowledge/verified', record.id, record.scope, payload,
      { seq: 1, previousEventHash: observed.eventHash })
    expect(applyKnowledgeEvent(state, event).records.get(record.id)?.trust).toBe('medium')
    const invalid = createKnowledgeEvent('knowledge/verified', record.id, record.scope, { ...payload, trust: 'invalid' },
      { seq: 1, previousEventHash: observed.eventHash })
    expect(() => applyKnowledgeEvent(state, invalid)).toThrow('knowledge transition produced an invalid record')
    expect(state.records.get(record.id)?.verificationStatus).toBe('observed')
    expect(state.lastSeq).toBe(0)
  })

  it('refuses promotion of an observed record even with a structural seal', () => {
    const record = governed()
    const observed = createKnowledgeEvent('knowledge/observed', record.id, record.scope, { record }, { seq: 0 })
    const state = replayKnowledgeEvents([observed])
    const promote = createKnowledgeEvent('knowledge/promoted', record.id, record.scope, {
      authorityId: 'synthetic-authority', authoritySeal: { authorityId: 'synthetic-authority', proof: 'synthetic-only' },
      contentHash: 'f'.repeat(64),
    }, { seq: 1, previousEventHash: observed.eventHash })
    expect(() => applyKnowledgeEvent(state, promote)).toThrow('knowledge promotion requires conflict-free verification evidence')
    expect(state.records.get(record.id)?.lifecycle).toBe('candidate')
  })

  it('reads legacy structural verification without authenticating it and rejects a promotion lacking its content hash', () => {
    const record = governed()
    const verified = createKnowledgeEvent('knowledge/verified', record.id, record.scope, {
      record, authority: 'synthetic-authority', authoritySeal: { authorityId: 'synthetic-authority', proof: 'synthetic-only' },
      evidenceRefs: ['synthetic-structural-evidence'],
    }, { seq: 0 })
    const log = join(fixture(), 'events.jsonl')
    writeFileSync(log, `${JSON.stringify(verified)}\n`)
    expect(readKnowledgeEventLog(log)).toEqual([verified])
    const state = replayKnowledgeEvents([verified])
    const promote = createKnowledgeEvent('knowledge/promoted', record.id, record.scope, {
      authorityId: 'synthetic-authority', authoritySeal: { authorityId: 'synthetic-authority', proof: 'synthetic-only' },
    }, { seq: 1, previousEventHash: verified.eventHash })
    expect(() => applyKnowledgeEvent(state, promote)).toThrow('knowledge promotion lacks authenticated content hash')
    expect(state.records.get(record.id)?.lifecycle).toBe('candidate')
  })

  it('selects the legacy win32 append flags and still writes the complete chained event', () => {
    const log = join(fixture(), 'events.jsonl')
    const record = governed()
    const event = createKnowledgeEvent('knowledge/retrieved', record.id, record.scope, {}, { seq: 0 })
    Object.defineProperty(process, 'platform', { ...nativePlatform, value: 'win32' })
    let appendFlags: unknown
    io.beforeOpen = (target, flags) => { if (target === log) appendFlags = flags }
    appendKnowledgeEvent(log, event)
    expect(appendFlags).toBe(constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY)
    expect(readKnowledgeEventLog(log)).toEqual([event])
  })

  it.each([{ seq: 1, previousEventHash: null }, { seq: 0, previousEventHash: 'f'.repeat(64) }])('rejects a structurally valid first event with invalid chain origin %j', (options) => {
    const record = governed()
    const event = createKnowledgeEvent('knowledge/retrieved', record.id, record.scope, {}, options)
    const log = join(fixture(), 'events.jsonl')
    writeFileSync(log, `${JSON.stringify(event)}\n`)
    expect(validateKnowledgeEvent(event)).toBe(true)
    expect(() => readKnowledgeEventLog(log)).toThrow('invalid knowledge event log')
  })

  it.each(['hardlink', 'denied'] as const)('rejects an event-log leaf changed after the prior read: %s', (kind) => {
    const root = fixture()
    const log = join(root, 'events.jsonl')
    writeFileSync(log, '')
    const record = governed()
    const event = createKnowledgeEvent('knowledge/retrieved', record.id, record.scope, {}, { seq: 0 })
    let reads = 0
    io.beforeStat = (target) => {
      // The bounded prior read stats before and after reading. Interleave only
      // at the append owner's subsequent leaf check.
      if (target !== log || ++reads !== 3) return
      io.beforeStat = undefined
      if (kind === 'hardlink') linkSync(log, join(root, 'alias'))
      else throw Object.assign(new Error('journal leaf stat denied'), { code: 'EACCES' })
    }
    expect(() => { appendKnowledgeEvent(log, event) }).toThrow(kind === 'hardlink' ? 'unsafe knowledge event log' : 'journal leaf stat denied')
    expect(readFileSync(log, 'utf8')).toBe('')
    if (kind === 'hardlink') expect(readFileSync(join(root, 'alias'), 'utf8')).toBe('')
  })
})
